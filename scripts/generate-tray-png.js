#!/usr/bin/env node
/**
 * Generates assets/tray.png (22x22) and assets/tray@2x.png (44x44) as macOS
 * template images — pure black with alpha — so the menu bar tints them
 * correctly for light/dark mode and they survive the notch layout.
 *
 * Run manually: `node scripts/generate-tray-png.js`
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// 22×22 cat-head silhouette. 1 = opaque black, 0 = transparent.
// Designed to stay legible at 16–18 pt menu bar height.
const BITMAP_22 = [
  '0000000000000000000000',
  '0000000000000000000000',
  '0011000000000000001100',
  '0011100000000000011100',
  '0011110000000000111100',
  '0011111000000001111100',
  '0011111100000011111100',
  '0011111111111111111100',
  '0011111111111111111100',
  '0011111111111111111100',
  '0011100111111111001110',
  '0011100111111111001110',
  '0011111111111111111100',
  '0011111111111111111100',
  '0011111110110111111100',
  '0001111111111111111000',
  '0000111111111111110000',
  '0000011111111111100000',
  '0000001111111111000000',
  '0000000011111100000000',
  '0000000000000000000000',
  '0000000000000000000000',
];

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, pixels) {
  // pixels: RGBA bytes, length = width*height*4
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: None
    pixels.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function bitmapToPixels(bitmap, scale) {
  const srcH = bitmap.length;
  const srcW = bitmap[0].length;
  const width = srcW * scale;
  const height = srcH * scale;
  const px = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const on = bitmap[(y / scale) | 0][(x / scale) | 0] === '1';
      const i = (y * width + x) * 4;
      px[i] = 0;
      px[i + 1] = 0;
      px[i + 2] = 0;
      px[i + 3] = on ? 0xff : 0x00;
    }
  }
  return { width, height, px };
}

function write(outPath, scale) {
  const { width, height, px } = bitmapToPixels(BITMAP_22, scale);
  const png = encodePng(width, height, px);
  fs.writeFileSync(outPath, png);
  // eslint-disable-next-line no-console
  console.log(`wrote ${outPath} (${width}x${height}, ${png.length} bytes)`);
}

const assets = path.join(__dirname, '..', 'assets');
write(path.join(assets, 'tray.png'), 1);
write(path.join(assets, 'tray@2x.png'), 2);
