#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
const contractsPath = path.join(repoRoot, 'src', 'shared', 'contracts.ts');
const agentsPath = path.join(repoRoot, 'src', 'main', 'agents.ts');
const gatewayClientPath = path.join(repoRoot, 'src', 'main', 'hermes-gateway-client.ts');
const hermesRuntimePath = path.join(repoRoot, 'src', 'main', 'hermes-runtime.ts');
const vendorAdapterPath = path.join(repoRoot, 'vendor', 'hermes-platforms', 'local_desktop', 'adapter.py');
const vendorPluginPath = path.join(repoRoot, 'vendor', 'hermes-platforms', 'local_desktop', 'plugin.yaml');

const EXPECTED_LOCAL_DESKTOP_ROUTES = ['GET /events', 'GET /health', 'POST /messages'];

const AGENT_UI_GATEWAY_ENV_KEYS = [
  'LOCAL_DESKTOP_GATEWAY_KEY',
  'LOCAL_DESKTOP_HOST',
  'LOCAL_DESKTOP_PORT',
  'LOCAL_DESKTOP_HOME_CHANNEL',
  'LOCAL_DESKTOP_HOME_CHANNEL_NAME',
];

function readFile(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing required source file: ${file}`);
  }
  return fs.readFileSync(file, 'utf8');
}

function exists(file) {
  return !!file && fs.existsSync(file);
}

function unique(values) {
  return [...new Set(values.filter((value) => value != null).map((value) => String(value)))].sort();
}

function relative(file) {
  const rel = path.relative(repoRoot, file);
  return rel && !rel.startsWith('..') ? rel : file;
}

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function assertSame(label, actual, expected) {
  const a = unique(actual);
  const e = unique(expected);
  const missing = e.filter((value) => !a.includes(value));
  const extra = a.filter((value) => !e.includes(value));
  if (missing.length || extra.length) {
    fail(`${label} does not match`, { missing, extra, actual: a, expected: e });
  }
}

function assertIncludesAll(label, actual, required) {
  const a = unique(actual);
  const r = unique(required);
  const missing = r.filter((value) => !a.includes(value));
  if (missing.length) {
    fail(`${label} is missing required entries`, { missing, actual: a, required: r });
  }
}

function parseTs(file) {
  const source = readFile(file);
  return {
    file,
    source,
    ast: ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  };
}

function findTypeAlias(parsed, typeName) {
  let found = null;
  function visit(node) {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) found = node;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(parsed.ast);
  if (!found) fail(`Missing exported type: ${typeName}`, { file: relative(parsed.file) });
  return found;
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function collectTypeLiteralKeys(node, out = []) {
  if (!node) return out;
  if (ts.isTypeLiteralNode(node)) {
    for (const member of node.members) {
      if (ts.isPropertySignature(member)) {
        const name = propertyNameText(member.name);
        if (name) out.push(name);
      }
    }
    return out;
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    for (const child of node.types) collectTypeLiteralKeys(child, out);
    return out;
  }
  if (ts.isParenthesizedTypeNode(node)) return collectTypeLiteralKeys(node.type, out);
  return out;
}

function tsObjectKeys(parsed, typeName) {
  return unique(collectTypeLiteralKeys(findTypeAlias(parsed, typeName).type));
}

function typeKind(node) {
  if (!node) return 'unknown';
  if (ts.isParenthesizedTypeNode(node)) return typeKind(node.type);
  if (node.kind === ts.SyntaxKind.StringKeyword) return 'string';
  if (node.kind === ts.SyntaxKind.NumberKeyword) return 'number';
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return 'boolean';
  if (node.kind === ts.SyntaxKind.NullKeyword) return 'null';
  if (ts.isLiteralTypeNode(node)) {
    if (ts.isStringLiteral(node.literal) || ts.isNoSubstitutionTemplateLiteral(node.literal)) return 'string';
    if (node.literal.kind === ts.SyntaxKind.TrueKeyword || node.literal.kind === ts.SyntaxKind.FalseKeyword)
      return 'boolean';
    if (node.literal.kind === ts.SyntaxKind.NullKeyword) return 'null';
    if (ts.isNumericLiteral(node.literal)) return 'number';
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText();
    if (name === 'JsonObject' || name === 'MutableJsonObject' || name === 'Record') return 'object';
    if (name === 'LocalDesktopGatewayEventType' || name === 'LocalDesktopProcessingOutcome') return 'string';
    return name;
  }
  if (ts.isArrayTypeNode(node) || ts.isTupleTypeNode(node)) return 'array';
  if (ts.isTypeLiteralNode(node)) return 'object';
  if (ts.isUnionTypeNode(node)) return unique(node.types.flatMap((child) => typeKind(child).split('|'))).join('|');
  if (ts.isIntersectionTypeNode(node)) {
    const childKinds = unique(node.types.flatMap((child) => typeKind(child).split('|')));
    if (childKinds.includes('object')) return 'object';
    return childKinds.join('|');
  }
  return 'unknown';
}

function collectTypeLiteralProperties(node, out = new Map()) {
  if (!node) return out;
  if (ts.isTypeLiteralNode(node)) {
    for (const member of node.members) {
      if (!ts.isPropertySignature(member)) continue;
      const name = propertyNameText(member.name);
      if (!name) continue;
      const existing = out.get(name);
      const kinds = unique([...(existing ? existing.kinds : []), ...typeKind(member.type).split('|')]);
      out.set(name, {
        optional: !!member.questionToken || !!(existing && existing.optional),
        kinds,
      });
    }
    return out;
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    for (const child of node.types) collectTypeLiteralProperties(child, out);
    return out;
  }
  if (ts.isParenthesizedTypeNode(node)) return collectTypeLiteralProperties(node.type, out);
  return out;
}

function tsPropertyShape(parsed, typeName) {
  const props = collectTypeLiteralProperties(findTypeAlias(parsed, typeName).type);
  const out = {};
  for (const [name, info] of props.entries()) {
    out[name] = {
      optional: !!info.optional,
      type: unique(info.kinds).join('|'),
    };
  }
  return out;
}

const BASE_EVENT_KEYS = ['seq', 'type', 'conversation_id', 'message_id', 'created_at'];

function tsEventPayloadKeys(parsed, typeName) {
  const base = new Set(BASE_EVENT_KEYS);
  return tsObjectKeys(parsed, typeName).filter((key) => !base.has(key));
}

function tsEventPayloadShape(parsed, typeName) {
  const base = new Set(BASE_EVENT_KEYS);
  const shape = tsPropertyShape(parsed, typeName);
  const out = {};
  for (const [key, info] of Object.entries(shape)) {
    if (!base.has(key)) out[key] = info;
  }
  return out;
}

function assertPropertyShape(label, actualShape, expectedShape) {
  assertSame(`${label} keys`, Object.keys(actualShape), Object.keys(expectedShape));
  for (const [key, expected] of Object.entries(expectedShape)) {
    const actual = actualShape[key];
    if (!actual || actual.optional !== expected.optional || actual.type !== expected.type) {
      fail(`${label}.${key} type does not match`, {
        actual,
        expected,
        actualShape,
        expectedShape,
      });
    }
  }
}

function collectStringLiterals(node, out = []) {
  if (!node) return out;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.push(node.text);
    return out;
  }
  if (ts.isLiteralTypeNode(node)) return collectStringLiterals(node.literal, out);
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    for (const child of node.types) collectStringLiterals(child, out);
    return out;
  }
  if (ts.isParenthesizedTypeNode(node)) return collectStringLiterals(node.type, out);
  if (ts.isTypeLiteralNode(node)) {
    for (const member of node.members) collectStringLiterals(member, out);
    return out;
  }
  if (ts.isPropertySignature(node) && node.type) return collectStringLiterals(node.type, out);
  ts.forEachChild(node, (child) => collectStringLiterals(child, out));
  return out;
}

function tsStringLiteralsInType(parsed, typeName) {
  return unique(collectStringLiterals(findTypeAlias(parsed, typeName).type));
}

function findFunctionOrMethod(parsed, functionName) {
  let found = null;
  function visit(node) {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === functionName
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed.ast);
  if (!found) fail(`Missing function or method: ${functionName}`, { file: relative(parsed.file) });
  return found;
}

function arrayIncludesStringsInFunction(parsed, functionName, argumentName) {
  const fn = findFunctionOrMethod(parsed, functionName);
  const values = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'includes' &&
      ts.isArrayLiteralExpression(node.expression.expression) &&
      node.arguments.length === 1 &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === argumentName
    ) {
      for (const element of node.expression.expression.elements) {
        if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) values.push(element.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(fn);
  return unique(values);
}

function objectLiteralKeys(node) {
  if (!node || !ts.isObjectLiteralExpression(node)) return [];
  const keys = [];
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
      const name = propertyNameText(property.name);
      if (name) keys.push(name);
    }
  }
  return unique(keys);
}

function objectLiteralKeysInFunction(parsed, functionName, variableName) {
  const fn = findFunctionOrMethod(parsed, functionName);
  let keys = null;
  function visit(node) {
    if (keys) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variableName) {
      keys = objectLiteralKeys(node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(fn);
  if (!keys) fail(`Missing object literal ${variableName} in ${functionName}`, { file: relative(parsed.file) });
  return keys;
}

function stringArrayVariable(parsed, variableName) {
  let values = null;
  function visit(node) {
    if (values) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      values = node.initializer.elements
        .filter((element) => ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element))
        .map((element) => element.text);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed.ast);
  if (!values) fail(`Missing string array: ${variableName}`, { file: relative(parsed.file) });
  return unique(values);
}

function gatewayClientPaths(source) {
  return unique([...source.matchAll(/\$\{this\.baseUrl\}(\/[A-Za-z0-9_/-]+)/g)].map((match) => match[1]));
}

function yamlEnvNames(source, sectionName) {
  const lines = String(source || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${sectionName}:`);
  if (start < 0) return [];
  const names = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line && /^\S/.test(line)) break;
    const match = line.match(/^\s*-\s+name:\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*$/);
    if (match) names.push(match[1]);
  }
  return unique(names);
}

function parsePluginEnv(file) {
  const source = readFile(file);
  return {
    required_env: yamlEnvNames(source, 'requires_env'),
    optional_env: yamlEnvNames(source, 'optional_env'),
  };
}

function candidateHermesRoots() {
  return [path.join(os.homedir(), '.hermes', 'hermes-agent')];
}

function possibleBasePaths(root) {
  return [
    path.join(root, 'gateway', 'platforms', 'base.py'),
    path.join(root, 'build', 'lib', 'gateway', 'platforms', 'base.py'),
  ];
}

function possibleAdapterPaths(root) {
  return [
    path.join(root, 'plugins', 'platforms', 'local_desktop', 'adapter.py'),
    path.join(root, 'build', 'lib', 'plugins', 'platforms', 'local_desktop', 'adapter.py'),
  ];
}

function firstExisting(paths) {
  return paths.find((file) => exists(file));
}

function resolveHermesBasePath() {
  const basePath = firstExisting(candidateHermesRoots().flatMap((root) => possibleBasePaths(root)));
  if (!basePath) {
    fail('Could not locate Hermes gateway/platforms/base.py', {
      searchedRoots: candidateHermesRoots(),
      hint: 'Install Hermes with the official installer.',
    });
  }
  return basePath;
}

function adapterCandidates() {
  const candidates = [{ label: 'vendored local_desktop adapter', path: vendorAdapterPath }];
  for (const root of candidateHermesRoots()) {
    const adapter = firstExisting(possibleAdapterPaths(root));
    if (adapter) candidates.push({ label: `Hermes local_desktop adapter at ${relative(adapter)}`, path: adapter });
  }
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = path.resolve(candidate.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const PY_CONTRACT_EXTRACTOR = String.raw`
import ast
import json
import sys


def string_value(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def number_value(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, int) else None


def bool_value(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, bool) else None


def list_strings(node):
    if not isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return None
    out = []
    for item in node.elts:
        value = string_value(item)
        if value is not None:
            out.append(value)
    return out


def dict_keys(node):
    if not isinstance(node, ast.Dict):
        return []
    out = []
    for key in node.keys:
        value = string_value(key)
        if value is not None:
            out.append(value)
    return out


def dict_string_values(node):
    if not isinstance(node, ast.Dict):
        return []
    out = []
    for value_node in node.values:
        value = string_value(value_node)
        if value is not None:
            out.append(value)
    return out


def call_attr(node):
    return node.func.attr if isinstance(node.func, ast.Attribute) else None


def call_name(node):
    return node.func.id if isinstance(node.func, ast.Name) else None


def keyword(node, name):
    for item in node.keywords:
        if item.arg == name:
            return item.value
    return None


def jsonable_value(node):
    value = string_value(node)
    if value is not None:
        return value
    value = number_value(node)
    if value is not None:
        return value
    value = bool_value(node)
    if value is not None:
        return value
    values = list_strings(node)
    if values is not None:
        return values
    return None


def enum_values(source, class_name):
    module = ast.parse(source)
    out = []
    for node in module.body:
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            for stmt in node.body:
                if isinstance(stmt, ast.Assign):
                    value = string_value(stmt.value)
                    if value is not None:
                        out.append(value)
    return sorted(set(out))


class ContractVisitor(ast.NodeVisitor):
    def __init__(self):
        self.func_stack = []
        self.routes = []
        self.append_events = []
        self.attachment_kinds = []
        self.inbound_hash_keys = []
        self.accepted_responses = []
        self.error_calls = []
        self.env_text_names = []
        self.register = {}
        self.supported_platform_kwargs = {}
        self.health_keys = []
        self.health_string_values = []
        self.json_error_keys = []
        self.row_to_event_keys = []
        self.append_event_keys = []

    @property
    def current_function(self):
        return self.func_stack[-1] if self.func_stack else ''

    def visit_FunctionDef(self, node):
        self.func_stack.append(node.name)
        self.generic_visit(node)
        self.func_stack.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Assign(self, node):
        targets_event = any(isinstance(target, ast.Name) and target.id == 'event' for target in node.targets)
        if targets_event and isinstance(node.value, ast.Dict):
            if self.current_function == '_row_to_event':
                self.row_to_event_keys.extend(dict_keys(node.value))
            if self.current_function == '_append_event':
                self.append_event_keys.extend(dict_keys(node.value))
        self.generic_visit(node)

    def visit_Call(self, node):
        attr = call_attr(node)
        name = call_name(node)

        if attr in ('add_get', 'add_post') and node.args:
            route = string_value(node.args[0])
            if route:
                self.routes.append({'method': 'GET' if attr == 'add_get' else 'POST', 'path': route})

        if attr == '_append_event' and node.args:
            event_type = string_value(node.args[0])
            payload = keyword(node, 'payload')
            if event_type:
                self.append_events.append({'type': event_type, 'payload_keys': dict_keys(payload)})

        if attr == '_append_attachment' and len(node.args) > 1:
            kind = string_value(node.args[1])
            if kind:
                self.attachment_kinds.append(kind)

        if attr == '_inbound_hash' and node.args and self.current_function == '_handle_messages':
            self.inbound_hash_keys.extend(dict_keys(node.args[0]))

        if attr == 'json_response' and node.args and isinstance(node.args[0], ast.Dict):
            keys = dict_keys(node.args[0])
            status_node = keyword(node, 'status')
            status = number_value(status_node) if status_node is not None else 200
            if self.current_function == '_handle_health':
                self.health_keys.extend(keys)
                self.health_string_values.extend(dict_string_values(node.args[0]))
            if self.current_function == '_json_error':
                self.json_error_keys.extend(keys)
            if 'accepted' in keys:
                self.accepted_responses.append({'keys': keys, 'status': status})

        if attr == '_json_error' and len(node.args) >= 2:
            status = number_value(node.args[0])
            code = string_value(node.args[1])
            if code is not None:
                self.error_calls.append({'status': status, 'code': code})

        if name == '_env_text' and node.args:
            value = string_value(node.args[0])
            if value:
                self.env_text_names.append(value)

        if attr == 'register_platform':
            for item in node.keywords:
                if item.arg is None:
                    continue
                value = jsonable_value(item.value)
                if value is not None:
                    self.register[item.arg] = value

        if name == '_supported_platform_kwargs':
            for item in node.keywords:
                if item.arg is None:
                    continue
                value = jsonable_value(item.value)
                if value is not None:
                    self.supported_platform_kwargs[item.arg] = value

        self.generic_visit(node)


adapter_path = sys.argv[1]
base_path = sys.argv[2]
adapter_source = open(adapter_path, encoding='utf-8').read()
base_source = open(base_path, encoding='utf-8').read()
adapter_tree = ast.parse(adapter_source)
visitor = ContractVisitor()
visitor.visit(adapter_tree)
print(json.dumps({
    'adapter_path': adapter_path,
    'base_path': base_path,
    'routes': visitor.routes,
    'append_events': visitor.append_events,
    'attachment_kinds': sorted(set(visitor.attachment_kinds)),
    'inbound_hash_keys': sorted(set(visitor.inbound_hash_keys)),
    'accepted_responses': visitor.accepted_responses,
    'error_calls': visitor.error_calls,
    'env_text_names': sorted(set(visitor.env_text_names)),
    'register': visitor.register,
    'supported_platform_kwargs': visitor.supported_platform_kwargs,
    'health_keys': sorted(set(visitor.health_keys)),
    'health_string_values': sorted(set(visitor.health_string_values)),
    'json_error_keys': sorted(set(visitor.json_error_keys)),
    'row_to_event_keys': sorted(set(visitor.row_to_event_keys)),
    'append_event_keys': sorted(set(visitor.append_event_keys)),
    'processing_outcomes': enum_values(base_source, 'ProcessingOutcome'),
}))
`;

function extractPythonContract(adapterPath, basePath) {
  const python = process.env.PYTHON || 'python3';
  const res = spawnSync(python, ['-c', PY_CONTRACT_EXTRACTOR, adapterPath, basePath], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (res.status !== 0) {
    fail(`Failed to parse Hermes contract sources with ${python}`, {
      adapterPath,
      basePath,
      stdout: res.stdout,
      stderr: res.stderr,
    });
  }
  try {
    return JSON.parse(res.stdout);
  } catch (error) {
    fail('Hermes contract extractor returned invalid JSON', {
      adapterPath,
      basePath,
      stdout: res.stdout,
      error: error && error.message ? error.message : String(error),
    });
  }
}

function payloadKeysFor(contract, eventTypes) {
  const wanted = new Set(eventTypes);
  return unique(
    contract.append_events.filter((event) => wanted.has(event.type)).flatMap((event) => event.payload_keys || []),
  );
}

function routeStrings(contract) {
  return unique(contract.routes.map((route) => `${route.method} ${route.path}`));
}

function acceptedResponseKeys(contract) {
  return unique(contract.accepted_responses.flatMap((response) => response.keys || []));
}

function acceptedResponseStatuses(contract) {
  return unique(contract.accepted_responses.map((response) => response.status));
}

function errorCodes(contract) {
  return unique(contract.error_calls.map((error) => error.code));
}

function errorStatusesByCode(contract, code) {
  return unique(contract.error_calls.filter((error) => error.code === code).map((error) => error.status));
}

function verifyAdapterContract(label, adapterPath, basePath, contracts) {
  const hermes = extractPythonContract(adapterPath, basePath);
  const context = `${label} (${relative(adapterPath)})`;

  assertSame(
    `${context}: LocalDesktopGatewayEventType`,
    tsStringLiteralsInType(contracts, 'LocalDesktopGatewayEventType'),
    hermes.append_events.map((event) => event.type),
  );
  assertSame(
    `${context}: LocalDesktopProcessingOutcome`,
    tsStringLiteralsInType(contracts, 'LocalDesktopProcessingOutcome'),
    hermes.processing_outcomes,
  );
  assertSame(
    `${context}: LocalDesktopAttachmentEvent.attachment_type`,
    tsStringLiteralsInType(contracts, 'LocalDesktopAttachmentEvent').filter((value) => value !== 'attachment.created'),
    hermes.attachment_kinds,
  );
  assertSame(
    `${context}: LocalDesktopGatewayEventBase keys from live append path`,
    tsObjectKeys(contracts, 'LocalDesktopGatewayEventBase'),
    hermes.append_event_keys,
  );
  assertSame(
    `${context}: LocalDesktopGatewayEventBase keys from replay row path`,
    tsObjectKeys(contracts, 'LocalDesktopGatewayEventBase'),
    hermes.row_to_event_keys,
  );
  assertPropertyShape(
    `${context}: LocalDesktopGatewayEventBase property types`,
    tsPropertyShape(contracts, 'LocalDesktopGatewayEventBase'),
    {
      seq: { optional: false, type: 'number' },
      type: { optional: false, type: 'string' },
      conversation_id: { optional: false, type: 'string' },
      message_id: { optional: false, type: 'null|string' },
      created_at: { optional: false, type: 'number' },
    },
  );
  assertSame(
    `${context}: LocalDesktopMessageCreatedEvent payload keys`,
    tsEventPayloadKeys(contracts, 'LocalDesktopMessageCreatedEvent'),
    payloadKeysFor(hermes, ['message.created']),
  );
  assertPropertyShape(
    `${context}: LocalDesktopMessageCreatedEvent payload property types`,
    tsEventPayloadShape(contracts, 'LocalDesktopMessageCreatedEvent'),
    {
      text: { optional: false, type: 'string' },
      reply_to: { optional: false, type: 'null|string' },
      metadata: { optional: false, type: 'object' },
    },
  );
  assertSame(
    `${context}: LocalDesktopMessageUpdatedEvent payload keys`,
    tsEventPayloadKeys(contracts, 'LocalDesktopMessageUpdatedEvent'),
    payloadKeysFor(hermes, ['message.updated']),
  );
  assertPropertyShape(
    `${context}: LocalDesktopMessageUpdatedEvent payload property types`,
    tsEventPayloadShape(contracts, 'LocalDesktopMessageUpdatedEvent'),
    {
      text: { optional: false, type: 'string' },
      finalize: { optional: false, type: 'boolean' },
    },
  );
  assertSame(
    `${context}: LocalDesktopMessageEvent payload keys`,
    [
      ...tsEventPayloadKeys(contracts, 'LocalDesktopMessageCreatedEvent'),
      ...tsEventPayloadKeys(contracts, 'LocalDesktopMessageUpdatedEvent'),
    ],
    payloadKeysFor(hermes, ['message.created', 'message.updated']),
  );
  assertSame(
    `${context}: LocalDesktopMessageDeletedEvent payload keys`,
    tsObjectKeys(contracts, 'LocalDesktopMessageDeletedEvent').filter((key) => key !== 'type'),
    payloadKeysFor(hermes, ['message.deleted']),
  );
  assertSame(
    `${context}: LocalDesktopAttachmentEvent payload keys`,
    tsObjectKeys(contracts, 'LocalDesktopAttachmentEvent').filter((key) => key !== 'type'),
    payloadKeysFor(hermes, ['attachment.created']),
  );
  assertPropertyShape(
    `${context}: LocalDesktopAttachmentEvent payload property types`,
    tsEventPayloadShape(contracts, 'LocalDesktopAttachmentEvent'),
    {
      attachment_type: { optional: false, type: 'string' },
      ref: { optional: false, type: 'string' },
      caption: { optional: false, type: 'null|string' },
      reply_to: { optional: false, type: 'null|string' },
      metadata: { optional: false, type: 'object' },
    },
  );
  assertSame(
    `${context}: LocalDesktopTypingStartedEvent payload keys`,
    tsEventPayloadKeys(contracts, 'LocalDesktopTypingStartedEvent'),
    payloadKeysFor(hermes, ['typing.started']),
  );
  assertPropertyShape(
    `${context}: LocalDesktopTypingStartedEvent payload property types`,
    tsEventPayloadShape(contracts, 'LocalDesktopTypingStartedEvent'),
    {
      inbound_message_id: { optional: false, type: 'null|string' },
      metadata: { optional: false, type: 'object' },
    },
  );
  assertSame(
    `${context}: LocalDesktopTypingStoppedEvent payload keys`,
    tsEventPayloadKeys(contracts, 'LocalDesktopTypingStoppedEvent'),
    payloadKeysFor(hermes, ['typing.stopped']),
  );
  assertPropertyShape(
    `${context}: LocalDesktopTypingStoppedEvent payload property types`,
    tsEventPayloadShape(contracts, 'LocalDesktopTypingStoppedEvent'),
    {
      inbound_message_id: { optional: false, type: 'null|string' },
      outcome: { optional: false, type: 'string' },
      transient: { optional: false, type: 'boolean' },
    },
  );
  assertSame(
    `${context}: LocalDesktopTypingEvent payload keys`,
    [
      ...tsEventPayloadKeys(contracts, 'LocalDesktopTypingStartedEvent'),
      ...tsEventPayloadKeys(contracts, 'LocalDesktopTypingStoppedEvent'),
    ],
    payloadKeysFor(hermes, ['typing.started', 'typing.stopped']),
  );
  assertSame(
    `${context}: LocalDesktopInboundMessage keys`,
    tsObjectKeys(contracts, 'LocalDesktopInboundMessage'),
    hermes.inbound_hash_keys,
  );
  assertPropertyShape(
    `${context}: LocalDesktopInboundMessage property types`,
    tsPropertyShape(contracts, 'LocalDesktopInboundMessage'),
    {
      conversation_id: { optional: false, type: 'string' },
      message_id: { optional: false, type: 'string' },
      text: { optional: false, type: 'string' },
      chat_name: { optional: true, type: 'null|string' },
      metadata: { optional: true, type: 'object' },
    },
  );
  assertSame(
    `${context}: LocalDesktopMessageAcceptedResponse keys`,
    tsObjectKeys(contracts, 'LocalDesktopMessageAcceptedResponse'),
    acceptedResponseKeys(hermes),
  );
  assertPropertyShape(
    `${context}: LocalDesktopMessageAcceptedResponse property types`,
    tsPropertyShape(contracts, 'LocalDesktopMessageAcceptedResponse'),
    {
      ok: { optional: false, type: 'boolean' },
      accepted: { optional: false, type: 'boolean' },
      duplicate: { optional: false, type: 'boolean' },
    },
  );
  assertSame(`${context}: accepted response HTTP status`, acceptedResponseStatuses(hermes), ['202']);
  assertSame(
    `${context}: LocalDesktopHealthResponse keys`,
    tsObjectKeys(contracts, 'LocalDesktopHealthResponse'),
    hermes.health_keys,
  );
  assertPropertyShape(
    `${context}: LocalDesktopHealthResponse property types`,
    tsPropertyShape(contracts, 'LocalDesktopHealthResponse'),
    {
      ok: { optional: false, type: 'boolean' },
      status: { optional: false, type: 'string' },
      platform: { optional: false, type: 'string' },
      latest_seq: { optional: false, type: 'number' },
    },
  );
  assertSame(
    `${context}: LocalDesktopHealthResponse string literals`,
    tsStringLiteralsInType(contracts, 'LocalDesktopHealthResponse'),
    hermes.health_string_values,
  );
  assertSame(
    `${context}: LocalDesktopErrorResponse keys`,
    tsObjectKeys(contracts, 'LocalDesktopErrorResponse'),
    hermes.json_error_keys,
  );
  assertPropertyShape(
    `${context}: LocalDesktopErrorResponse property types`,
    tsPropertyShape(contracts, 'LocalDesktopErrorResponse'),
    {
      ok: { optional: false, type: 'boolean' },
      error: { optional: false, type: 'string' },
      message: { optional: false, type: 'string' },
    },
  );
  assertSame(
    `${context}: LocalDesktopErrorResponse error codes`,
    tsStringLiteralsInType(contracts, 'LocalDesktopErrorResponse'),
    errorCodes(hermes),
  );
  assertSame(`${context}: replay_window_expired status`, errorStatusesByCode(hermes, 'replay_window_expired'), ['409']);
  assertSame(
    `${context}: duplicate_message_conflict status`,
    errorStatusesByCode(hermes, 'duplicate_message_conflict'),
    ['409'],
  );
  assertSame(`${context}: unauthorized status`, errorStatusesByCode(hermes, 'unauthorized'), ['401']);
  assertSame(`${context}: local_desktop HTTP routes`, routeStrings(hermes), EXPECTED_LOCAL_DESKTOP_ROUTES);

  return hermes;
}

function verifyAgentUiSurfaces(canonicalHermes, contracts, agents, gatewayClient, hermesRuntime) {
  const eventTypes = tsStringLiteralsInType(contracts, 'LocalDesktopGatewayEventType');
  assertSame(
    'Agent UI handleGatewayEvent allowlist',
    arrayIncludesStringsInFunction(agents, 'handleGatewayEvent', 'type'),
    eventTypes,
  );
  assertSame(
    'HermesGatewayClient postMessage payload keys',
    objectLiteralKeysInFunction(gatewayClient, 'postMessage', 'payload'),
    tsObjectKeys(contracts, 'LocalDesktopInboundMessage'),
  );
  assertIncludesAll(
    'HermesGatewayClient endpoint paths',
    gatewayClientPaths(gatewayClient.source),
    canonicalHermes.routes.map((route) => route.path),
  );

  const pluginEnv = parsePluginEnv(vendorPluginPath);
  const declaredPluginEnv = unique([...pluginEnv.required_env, ...pluginEnv.optional_env]);
  const adapterRegisterEnv = unique([
    ...canonicalHermes.env_text_names,
    ...(canonicalHermes.register.required_env || []),
    canonicalHermes.register.allowed_users_env,
    canonicalHermes.register.allow_all_env,
    canonicalHermes.supported_platform_kwargs.cron_deliver_env_var,
  ]);
  assertSame(
    'local_desktop plugin.yaml required_env',
    pluginEnv.required_env,
    canonicalHermes.register.required_env || [],
  );
  assertIncludesAll('local_desktop plugin.yaml env declarations', declaredPluginEnv, adapterRegisterEnv);
  assertIncludesAll(
    'Agent UI gateway env file keys',
    stringArrayVariable(hermesRuntime, 'LOCAL_DESKTOP_ENV_KEYS'),
    AGENT_UI_GATEWAY_ENV_KEYS,
  );
  assertIncludesAll(
    'Agent UI gateway env file keys for required Hermes plugin env',
    stringArrayVariable(hermesRuntime, 'LOCAL_DESKTOP_ENV_KEYS'),
    pluginEnv.required_env,
  );
}

function verify() {
  const contracts = parseTs(contractsPath);
  const agents = parseTs(agentsPath);
  const gatewayClient = parseTs(gatewayClientPath);
  const hermesRuntime = parseTs(hermesRuntimePath);
  const basePath = resolveHermesBasePath();
  const adapters = adapterCandidates();

  if (!adapters.length) fail('No local_desktop adapter candidates found.');
  const canonical =
    adapters.find((candidate) => path.resolve(candidate.path) === path.resolve(vendorAdapterPath)) || adapters[0];
  const canonicalHermes = verifyAdapterContract(canonical.label, canonical.path, basePath, contracts);

  for (const candidate of adapters) {
    if (path.resolve(candidate.path) === path.resolve(canonical.path)) continue;
    verifyAdapterContract(candidate.label, candidate.path, basePath, contracts);
  }

  verifyAgentUiSurfaces(canonicalHermes, contracts, agents, gatewayClient, hermesRuntime);

  console.log(
    [
      'Hermes local_desktop contracts verified:',
      `  TypeScript contracts: ${relative(contractsPath)}`,
      `  Canonical adapter: ${relative(canonical.path)}`,
      `  Hermes base contract: ${relative(basePath)}`,
      `  Adapter candidates checked: ${adapters.length}`,
    ].join('\n'),
  );
}

try {
  verify();
} catch (error) {
  console.error('Hermes contract verification failed.');
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
}
