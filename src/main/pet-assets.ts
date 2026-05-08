'use strict';

const fs = require('fs');
const path = require('path');

const CUSTOM_PET_PREFIX = 'custom:';
const PET_ASSET_SCHEME = 'agent-ui-pet';
const PET_MANIFEST_FILE = 'pet.json';
const LEGACY_AVATAR_MANIFEST_FILE = 'avatar.json';
const PET_DEFAULT_SPRITESHEET = 'spritesheet.webp';
const PET_SPRITESHEET_WIDTH = 1536;
const PET_SPRITESHEET_HEIGHT = 1872;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return data && typeof data === 'object' ? data : {};
}

function safeManifestString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pathInsideDirectory(file, dir) {
  const relative = path.relative(dir, file);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolvePetSpritesheetPath(packageDir, manifest) {
  const rel = safeManifestString(manifest.spritesheetPath) || PET_DEFAULT_SPRITESHEET;
  const resolved = path.resolve(packageDir, rel);
  return pathInsideDirectory(resolved, packageDir) ? resolved : null;
}

function readPngDimensions(buffer) {
  if (
    buffer.length < 24 ||
    buffer[0] !== 0x89 ||
    buffer.toString('ascii', 1, 4) !== 'PNG' ||
    buffer.toString('ascii', 12, 16) !== 'IHDR'
  ) return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readUint24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function readWebpDimensions(buffer) {
  if (
    buffer.length < 16 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WEBP'
  ) return null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (data + size > buffer.length) return null;
    if (type === 'VP8X' && size >= 10) {
      return {
        width: readUint24LE(buffer, data + 4) + 1,
        height: readUint24LE(buffer, data + 7) + 1,
      };
    }
    if (type === 'VP8L' && size >= 5 && buffer[data] === 0x2f) {
      const b1 = buffer[data + 1];
      const b2 = buffer[data + 2];
      const b3 = buffer[data + 3];
      const b4 = buffer[data + 4];
      return {
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + ((b2 & 0xc0) >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
      };
    }
    if (
      type === 'VP8 ' &&
      size >= 10 &&
      buffer[data + 3] === 0x9d &&
      buffer[data + 4] === 0x01 &&
      buffer[data + 5] === 0x2a
    ) {
      return {
        width: buffer.readUInt16LE(data + 6) & 0x3fff,
        height: buffer.readUInt16LE(data + 8) & 0x3fff,
      };
    }
    offset = data + size + (size % 2);
  }
  return null;
}

function spritesheetMimeType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return '';
}

function readSpritesheetDimensions(file, buffer) {
  const mimeType = spritesheetMimeType(file);
  if (mimeType === 'image/png') return readPngDimensions(buffer);
  if (mimeType === 'image/webp') return readWebpDimensions(buffer);
  return null;
}

function petSpriteUrl(id) {
  return `${PET_ASSET_SCHEME}://sprite/${encodeURIComponent(String(id || ''))}`;
}

function petMetadata(pet, { includeSprite = false } = {}) {
  if (!pet) return null;
  const out: any = {
    assetRef: pet.assetRef,
    description: pet.description,
    displayName: pet.displayName,
    id: pet.id,
    label: pet.label,
  };
  if (includeSprite) out.spriteUrl = petSpriteUrl(pet.id);
  return out;
}

function loadPetPackage(packageDir, manifestFile) {
  const manifestPath = path.join(packageDir, manifestFile);
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = readJsonFile(manifestPath);
  const spritesheetPath = resolvePetSpritesheetPath(packageDir, manifest);
  if (!spritesheetPath || !fs.existsSync(spritesheetPath)) return null;
  const buffer = fs.readFileSync(spritesheetPath);
  const dimensions = readSpritesheetDimensions(spritesheetPath, buffer);
  if (
    !dimensions ||
    dimensions.width !== PET_SPRITESHEET_WIDTH ||
    dimensions.height !== PET_SPRITESHEET_HEIGHT
  ) return null;
  const directoryId = path.basename(packageDir);
  const id = `${CUSTOM_PET_PREFIX}${directoryId}`;
  const displayName = safeManifestString(manifest.displayName) || safeManifestString(manifest.id) || directoryId;
  const description = manifest.description == null ? '' : safeManifestString(manifest.description);
  return {
    assetRef: 'codex',
    description,
    displayName,
    id,
    label: displayName,
    sourceDirectory: packageDir,
    spritesheetMimeType: spritesheetMimeType(spritesheetPath),
    spritesheetPath,
  };
}

function scanPetPackageRoot(rootDir, manifestFile, { create = false } = {}) {
  try {
    if (create) ensureDir(rootDir);
    if (!fs.existsSync(rootDir)) return [];
    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          return loadPetPackage(path.join(rootDir, entry.name), manifestFile);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    console.warn('[agent-ui] pet package scan failed', rootDir, e && e.message ? e.message : e);
    return [];
  }
}

function loadPetCharacterOptions({ codexHome, packageRoot }) {
  const byId = new Map();
  const roots = [
    { dir: path.join(packageRoot, 'assets', 'pets'), manifestFile: PET_MANIFEST_FILE, create: false },
    { dir: path.join(codexHome, 'avatars'), manifestFile: LEGACY_AVATAR_MANIFEST_FILE, create: false },
    { dir: path.join(codexHome, 'pets'), manifestFile: PET_MANIFEST_FILE, create: true },
  ];
  for (const root of roots) {
    for (const pet of scanPetPackageRoot(root.dir, root.manifestFile, { create: root.create })) {
      byId.set(pet.id, pet);
    }
  }
  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function petCharactersPayload({ options, selectedId }) {
  const selected = options.find((pet) => pet.id === selectedId) || options[0] || null;
  const id = selected ? selected.id : selectedId;
  return {
    id,
    options: options.map((pet) => petMetadata(pet)),
    selected: petMetadata(selected, { includeSprite: true }),
    selectedSpriteUrl: selected ? petSpriteUrl(selected.id) : '',
  };
}

module.exports = {
  CUSTOM_PET_PREFIX,
  PET_ASSET_SCHEME,
  PET_MANIFEST_FILE,
  LEGACY_AVATAR_MANIFEST_FILE,
  loadPetCharacterOptions,
  petCharactersPayload,
  petSpriteUrl,
};
