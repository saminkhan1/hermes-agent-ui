'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ATTACHMENT_SCHEME,
  attachmentDescriptor,
  resolveAttachmentRequest,
} = require('../src/main/hermes-attachments');

test('local attachment descriptor validates file refs behind app scheme tokens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-attachment-'));
  const file = path.join(dir, 'audio.mp3');
  fs.writeFileSync(file, 'audio-ish', 'utf8');

  const descriptor = attachmentDescriptor({
    attachmentType: 'voice',
    ref: file,
  });

  assert.equal(descriptor.status, 'ready');
  assert.equal(descriptor.source, 'local');
  assert.equal(descriptor.fileName, 'audio.mp3');
  assert.equal(descriptor.mimeType, 'audio/mpeg');
  assert.match(descriptor.url, new RegExp(`^${ATTACHMENT_SCHEME}://file/`));

  const resolved = resolveAttachmentRequest(descriptor.url);
  assert.equal(resolved.file, file);
  assert.equal(resolved.mimeType, 'audio/mpeg');
});

test('local attachment descriptor blocks missing and unsupported files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-attachment-'));
  const script = path.join(dir, 'payload.sh');
  fs.writeFileSync(script, 'echo no', 'utf8');

  const unsupported = attachmentDescriptor({
    attachmentType: 'image',
    ref: script,
  });
  assert.equal(unsupported.status, 'blocked');
  assert.equal(unsupported.reason, 'unsupported_type');
  assert.equal(unsupported.url, '');

  const missing = attachmentDescriptor({
    attachmentType: 'document',
    ref: path.join(dir, 'missing.pdf'),
  });
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.reason, 'missing');
});

test('remote attachment descriptors allow only http and https refs', () => {
  const remote = attachmentDescriptor({
    attachmentType: 'image',
    ref: 'https://example.com/output.png',
  });
  assert.equal(remote.status, 'ready');
  assert.equal(remote.source, 'remote');
  assert.equal(remote.url, 'https://example.com/output.png');

  const unsupportedProtocol = attachmentDescriptor({
    attachmentType: 'image',
    ref: 'ftp://example.com/output.png',
  });
  assert.equal(unsupportedProtocol.status, 'blocked');
  assert.equal(unsupportedProtocol.reason, 'unsupported_ref');
});
