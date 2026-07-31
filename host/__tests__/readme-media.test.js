import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const MEDIA = [
  'execution',
  'browser-vscode',
  'browser-e2e',
  'review-governance',
  'deployment',
  'inference-mesh',
];
const RETIRED_PICTURES = [
  'mobile-foldable.jpg',
  'mobile-phone.jpg',
  'hero-ide-fullscreen.png',
  'guided-setup.png',
];

function gifDimensions(buffer) {
  assert.match(buffer.subarray(0, 6).toString('ascii'), /^GIF8[79]a$/);
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function pngDimensions(buffer) {
  assert.deepEqual(
    buffer.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function gifFrameCount(buffer) {
  const packed = buffer[10];
  let offset = 13 + ((packed & 0x80) ? 3 * 2 ** ((packed & 0x07) + 1) : 0);
  let frames = 0;
  const skipSubBlocks = () => {
    while (offset < buffer.length) {
      const size = buffer[offset];
      offset += 1;
      if (size === 0) return;
      offset += size;
    }
  };

  while (offset < buffer.length) {
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      offset += 1;
      skipSubBlocks();
      continue;
    }
    assert.equal(marker, 0x2c, `unexpected GIF block 0x${marker.toString(16)}`);
    frames += 1;
    const imagePacked = buffer[offset + 8];
    offset += 9;
    if (imagePacked & 0x80) offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
    offset += 1;
    skipSubBlocks();
  }
  return frames;
}

describe('README canonical landing media (REQ-LANDING-013)', () => {
  it('renders every agreed GIF with a reduced-motion PNG fallback and descriptive alt text', () => {
    for (const name of MEDIA) {
      const block = new RegExp(
        `<picture>\\s*<source media="\\(prefers-reduced-motion: reduce\\)" srcset="assets/documentation/${name}\\.png">\\s*<img src="assets/documentation/${name}\\.gif" alt="([^"]{20,})" width="1200">\\s*</picture>`,
      );
      assert.match(README, block, `${name} media must provide its GIF and PNG fallback`);
    }
    for (const retired of RETIRED_PICTURES) {
      assert.doesNotMatch(README, new RegExp(retired.replace('.', '\\.')));
    }
  });

  it('keeps readable animated assets and exact-size fallbacks within repository budgets', () => {
    let aggregateBytes = 0;
    for (const name of MEDIA) {
      const gifPath = join(ROOT, 'assets', 'documentation', `${name}.gif`);
      const pngPath = join(ROOT, 'assets', 'documentation', `${name}.png`);
      const gif = readFileSync(gifPath);
      const png = readFileSync(pngPath);
      const gifSize = statSync(gifPath).size;
      const pngSize = statSync(pngPath).size;
      aggregateBytes += gifSize + pngSize;

      const gifBox = gifDimensions(gif);
      assert.deepEqual(pngDimensions(png), gifBox, `${name} fallback dimensions must match`);
      assert.ok(gifBox.width >= 800, `${name} must remain readable at GitHub content width`);
      assert.ok(gifBox.width > gifBox.height, `${name} must use a wide README composition`);
      assert.ok(gifFrameCount(gif) >= 3, `${name} must contain real animation`);
      const loops = gif.includes(Buffer.from('NETSCAPE2.0', 'ascii'));
      assert.equal(loops, !['execution', 'browser-e2e', 'deployment'].includes(name), `${name} loop policy drifted`);
      assert.ok(gifSize <= 10 * 1024 * 1024, `${name}.gif exceeds the 10 MiB budget`);
    }
    assert.ok(aggregateBytes <= 30 * 1024 * 1024, 'README media exceeds the 30 MiB aggregate budget');
  });
});
