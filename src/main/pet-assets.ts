'use strict';

import { nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const CUSTOM_PET_PREFIX = 'custom:';
const PET_ASSET_SCHEME = 'agent-ui-pet';
const PET_MANIFEST_FILE = 'pet.json';
const LEGACY_AVATAR_MANIFEST_FILE = 'avatar.json';
const PET_DEFAULT_SPRITESHEET = 'spritesheet.webp';
const PET_SPRITESHEET_WIDTH = 1536;
const PET_SPRITESHEET_HEIGHT = 1872;

function readJsonFile(file: LooseBoundaryValue) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return data && typeof data === 'object' ? data : {};
}

function safeManifestString(value: LooseBoundaryValue) {
  return typeof value === 'string' ? value.trim() : '';
}

function pathInsideDirectory(file: LooseBoundaryValue, dir: LooseBoundaryValue) {
  const relative = path.relative(dir, file);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolvePetSpritesheetPath(packageDir: LooseBoundaryValue, manifest: LooseBoundaryValue) {
  const rel = safeManifestString(manifest.spritesheetPath) || PET_DEFAULT_SPRITESHEET;
  const resolved = path.resolve(packageDir, rel);
  return pathInsideDirectory(resolved, packageDir) ? resolved : null;
}

function spritesheetMimeType(file: LooseBoundaryValue) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return '';
}

function readSpritesheetDimensions(file: LooseBoundaryValue) {
  if (!spritesheetMimeType(file)) return null;
  const image = nativeImage.createFromPath(String(file || ''));
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
}

function petSpriteUrl(id: LooseBoundaryValue) {
  return `${PET_ASSET_SCHEME}://sprite/${encodeURIComponent(String(id || ''))}`;
}

function petMetadata(pet: LooseBoundaryValue, { includeSprite = false } = {}) {
  if (!pet) return null;
  const out: LooseBoundaryValue = {
    assetRef: pet.assetRef,
    description: pet.description,
    displayName: pet.displayName,
    id: pet.id,
    label: pet.label,
  };
  if (includeSprite) out.spriteUrl = petSpriteUrl(pet.id);
  return out;
}

function loadPetPackage(packageDir: LooseBoundaryValue, manifestFile: LooseBoundaryValue) {
  const manifestPath = path.join(packageDir, manifestFile);
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = readJsonFile(manifestPath);
  const spritesheetPath = resolvePetSpritesheetPath(packageDir, manifest);
  if (!spritesheetPath || !fs.existsSync(spritesheetPath)) return null;
  const dimensions = readSpritesheetDimensions(spritesheetPath);
  if (!dimensions || dimensions.width !== PET_SPRITESHEET_WIDTH || dimensions.height !== PET_SPRITESHEET_HEIGHT)
    return null;
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

function scanPetPackageRoot(rootDir: LooseBoundaryValue, manifestFile: LooseBoundaryValue, { create = false } = {}) {
  try {
    if (create) fs.mkdirSync(rootDir, { recursive: true });
    if (!fs.existsSync(rootDir)) return [];
    return fs
      .readdirSync(rootDir, { withFileTypes: true })
      .filter((entry: LooseBoundaryValue) => entry.isDirectory())
      .map((entry: LooseBoundaryValue) => {
        try {
          return loadPetPackage(path.join(rootDir, entry.name), manifestFile);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    console.warn('[agent-ui] pet package scan failed', rootDir, e instanceof Error && e.message ? e.message : e);
    return [];
  }
}

function loadPetCharacterOptions({ codexHome, packageRoot }: LooseBoundaryValue) {
  const byId = new Map();
  const roots = [
    { dir: path.join(packageRoot, 'assets', 'pets'), manifestFile: PET_MANIFEST_FILE, create: false },
    { dir: path.join(codexHome, 'avatars'), manifestFile: LEGACY_AVATAR_MANIFEST_FILE, create: false },
    { dir: path.join(codexHome, 'pets'), manifestFile: PET_MANIFEST_FILE, create: true },
  ];
  for (const root of roots) {
    for (const pet of scanPetPackageRoot(root.dir, root.manifestFile, { create: root.create })) {
      if (!pet) continue;
      byId.set(pet.id, pet);
    }
  }
  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function petCharactersPayload({ options, selectedId }: LooseBoundaryValue) {
  const selected = options.find((pet: LooseBoundaryValue) => pet.id === selectedId) || options[0] || null;
  const id = selected ? selected.id : selectedId;
  return {
    id,
    options: options.map((pet: LooseBoundaryValue) => petMetadata(pet)),
    selected: petMetadata(selected, { includeSprite: true }),
    selectedSpriteUrl: selected ? petSpriteUrl(selected.id) : '',
  };
}

export {
  CUSTOM_PET_PREFIX,
  PET_ASSET_SCHEME,
  PET_MANIFEST_FILE,
  LEGACY_AVATAR_MANIFEST_FILE,
  loadPetCharacterOptions,
  petCharactersPayload,
  petSpriteUrl,
};
