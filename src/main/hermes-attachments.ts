'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ATTACHMENT_SCHEME = 'agent-ui-attachment';
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const REMOTE_REF_MAX_CHARS = 4096;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
const AUDIO_EXTENSIONS = new Set(['.ogg', '.opus', '.mp3', '.wav', '.m4a', '.flac']);
const DOCUMENT_EXTENSIONS = new Set([
  '.epub',
  '.pdf',
  '.zip',
  '.rar',
  '.7z',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.txt',
  '.csv',
  '.apk',
  '.ipa',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.epub': 'application/epub+zip',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.apk': 'application/vnd.android.package-archive',
  '.ipa': 'application/octet-stream',
};

const localAttachmentRegistry = new Map();

function text(value: LooseBoundaryValue, max = REMOTE_REF_MAX_CHARS) {
  const out = value == null ? '' : String(value);
  return out.length > max ? out.slice(0, max) : out;
}

function normalizeAttachmentType(value: LooseBoundaryValue) {
  const type = String(value || '')
    .trim()
    .toLowerCase();
  if (type === 'image' || type === 'document' || type === 'voice' || type === 'video') return type;
  if (type === 'audio') return 'voice';
  if (type === 'file') return 'document';
  return 'document';
}

function allowedExtensionsForType(type: LooseBoundaryValue) {
  const normalized = normalizeAttachmentType(type);
  if (normalized === 'image') return IMAGE_EXTENSIONS;
  if (normalized === 'video') return VIDEO_EXTENSIONS;
  if (normalized === 'voice') return AUDIO_EXTENSIONS;
  return DOCUMENT_EXTENSIONS;
}

function maxBytesForType(type: LooseBoundaryValue) {
  return normalizeAttachmentType(type) === 'image' ? IMAGE_MAX_BYTES : DEFAULT_MAX_BYTES;
}

function mimeForExtension(ext: LooseBoundaryValue) {
  return MIME_BY_EXTENSION[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

function fileNameForRef(ref: LooseBoundaryValue) {
  const raw = String(ref || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'file:') return path.basename(fileURLToPath(parsed));
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return path.basename(decodeURIComponent(parsed.pathname || '')) || parsed.hostname;
    }
  } catch {
    // Treat non-URL refs as local paths below.
  }
  return path.basename(raw);
}

function pathFromLocalRef(ref: LooseBoundaryValue) {
  const raw = String(ref || '').trim();
  if (!raw) return '';
  if (raw.startsWith('~/')) return path.resolve(os.homedir(), raw.slice(2));
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'file:') return '';
    return fileURLToPath(parsed);
  } catch {
    // Not a URL.
  }
  return path.isAbsolute(raw) ? raw : '';
}

function remoteDescriptor(type: LooseBoundaryValue, ref: LooseBoundaryValue) {
  const raw = text(ref);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const ext = path.extname(parsed.pathname || '').toLowerCase();
  const allowed = allowedExtensionsForType(type);
  if (ext && !allowed.has(ext)) {
    return blockedDescriptor('unsupported_type', type, ref, {
      source: 'remote',
      extension: ext,
      mimeType: mimeForExtension(ext),
    });
  }
  const mimeType = ext ? mimeForExtension(ext) : '';
  return {
    status: 'ready',
    source: 'remote',
    url: parsed.toString(),
    fileName: fileNameForRef(parsed.toString()) || 'Attachment',
    mimeType,
    size: null,
    extension: ext,
    allowedByExtension: ext ? allowed.has(ext) : null,
  };
}

function tokenForLocalAttachment(file: LooseBoundaryValue, stat: LooseBoundaryValue) {
  return createHash('sha256')
    .update(`${file}\0${stat.size}\0${Number(stat.mtimeMs || 0)}`)
    .digest('hex')
    .slice(0, 48);
}

function blockedDescriptor(reason: LooseBoundaryValue, type: LooseBoundaryValue, ref: LooseBoundaryValue, extra = {}) {
  return {
    status: 'blocked',
    source: 'local',
    reason,
    url: '',
    fileName: fileNameForRef(ref) || `${normalizeAttachmentType(type)} attachment`,
    mimeType: '',
    size: null,
    extension: '',
    ...extra,
  };
}

function resolveLocalDescriptor(type: LooseBoundaryValue, ref: LooseBoundaryValue) {
  const file = pathFromLocalRef(ref);
  if (!file) return null;

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return blockedDescriptor('missing', type, ref);
  }
  if (!stat.isFile()) return blockedDescriptor('not_file', type, ref);

  const ext = path.extname(file).toLowerCase();
  const allowed = allowedExtensionsForType(type);
  if (!allowed.has(ext)) {
    return blockedDescriptor('unsupported_type', type, ref, {
      extension: ext,
      mimeType: mimeForExtension(ext),
      size: stat.size,
    });
  }

  const maxBytes = maxBytesForType(type);
  if (stat.size > maxBytes) {
    return blockedDescriptor('too_large', type, ref, {
      extension: ext,
      mimeType: mimeForExtension(ext),
      size: stat.size,
      maxBytes,
    });
  }

  const token = tokenForLocalAttachment(file, stat);
  const mimeType = mimeForExtension(ext);
  localAttachmentRegistry.set(token, {
    file,
    mimeType,
    size: stat.size,
    extension: ext,
    type: normalizeAttachmentType(type),
  });
  return {
    status: 'ready',
    source: 'local',
    url: `${ATTACHMENT_SCHEME}://file/${token}`,
    fileName: path.basename(file),
    mimeType,
    size: stat.size,
    extension: ext,
  };
}

function attachmentDescriptor(item: LooseBoundaryValue = {}) {
  const type = normalizeAttachmentType(item.attachmentType || item.attachment_type);
  const ref = text(item.ref);
  if (!ref) return blockedDescriptor('missing_ref', type, ref);

  const local = resolveLocalDescriptor(type, ref);
  if (local) return local;

  const remote = remoteDescriptor(type, ref);
  if (remote) return remote;

  return blockedDescriptor('unsupported_ref', type, ref);
}

function resolveAttachmentRequest(urlValue: LooseBoundaryValue) {
  let parsed;
  try {
    parsed = new URL(String(urlValue || ''));
  } catch {
    return null;
  }
  if (parsed.protocol !== `${ATTACHMENT_SCHEME}:` || parsed.hostname !== 'file') return null;
  const token = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!token || !/^[a-f0-9]{48}$/i.test(token)) return null;
  const registered = localAttachmentRegistry.get(token);
  if (!registered) return null;
  try {
    const stat = fs.statSync(registered.file);
    if (!stat.isFile() || stat.size !== registered.size) return null;
  } catch {
    return null;
  }
  return registered;
}

export { ATTACHMENT_SCHEME, attachmentDescriptor, normalizeAttachmentType, resolveAttachmentRequest };
