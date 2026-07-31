import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import {
  README_MEDIA,
  README_MEDIA_BUDGETS,
  RETIRED_README_PICTURES,
} from '../../scripts/ci/readme-media-contract.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const MEDIA = README_MEDIA.map(({ name }) => name);
const ONE_SHOT_MEDIA = new Set(
  README_MEDIA.filter(({ playback }) => playback === 'once').map(({ name }) => name),
);

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function activeMarkdownHtml(markdown) {
  const visible = [];
  let fence;
  let inComment = false;

  for (const rawLine of markdown.split('\n')) {
    if (fence) {
      const closingFence = rawLine.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closingFence && closingFence[1][0] === fence.character && closingFence[1].length >= fence.length) fence = undefined;
      continue;
    }
    const fenceMarker = rawLine.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMarker) {
      fence = { character: fenceMarker[1][0], length: fenceMarker[1].length };
      continue;
    }
    if (/^ {4}\S/.test(rawLine)) continue;

    let line = rawLine;
    let rendered = '';
    while (line.length > 0) {
      if (inComment) {
        const end = line.indexOf('-->');
        if (end === -1) {
          line = '';
          continue;
        }
        inComment = false;
        line = line.slice(end + 3);
        continue;
      }
      const start = line.indexOf('<!--');
      if (start === -1) {
        rendered += line;
        break;
      }
      rendered += line.slice(0, start);
      inComment = true;
      line = line.slice(start + 4);
    }
    visible.push(rendered);
  }

  assert.equal(fence, undefined, 'README contains an unterminated fenced code block');
  assert.equal(inComment, false, 'README contains an unterminated HTML comment');
  return visible.join('\n');
}

function htmlAttributes(tag) {
  const attributes = new Map();
  for (const match of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) {
    assert.equal(attributes.has(match[1]), false, `duplicate ${match[1]} attribute`);
    attributes.set(match[1], match[2]);
  }
  return attributes;
}

function activePictureBlocks(markdown) {
  const html = activeMarkdownHtml(markdown);
  const blocks = new Map();
  for (const match of html.matchAll(/^<picture>\s*\n([\s\S]*?)^<\/picture>$/gm)) {
    const body = match[1];
    const sourceTag = body.match(/<source\s+([^>]+)>/);
    const imageTag = body.match(/<img\s+([^>]+)>/);
    assert.ok(sourceTag, 'active picture block is missing its source element');
    assert.ok(imageTag, 'active picture block is missing its image element');
    const source = htmlAttributes(sourceTag[1]);
    const image = htmlAttributes(imageTag[1]);
    const imagePath = image.get('src') ?? '';
    const name = imagePath.match(/^assets\/documentation\/(.+)\.gif$/)?.[1];
    assert.ok(name, `unexpected README image path: ${imagePath}`);
    assert.equal(blocks.has(name), false, `duplicate active picture block for ${name}`);
    blocks.set(name, { source, image });
  }
  return { blocks, html };
}

function parsePng(buffer) {
  assert.deepEqual(
    buffer.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    'invalid PNG signature',
  );
  let offset = 8;
  let dimensions;
  const imageData = [];
  let sawEnd = false;

  while (offset < buffer.length) {
    assert.ok(offset + 12 <= buffer.length, 'truncated PNG chunk header');
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8);
    const end = offset + 12 + length;
    assert.ok(end <= buffer.length, `truncated PNG ${type.toString('ascii')} chunk`);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    assert.equal(
      buffer.readUInt32BE(offset + 8 + length),
      crc32(Buffer.concat([type, data])),
      `invalid PNG ${type.toString('ascii')} CRC`,
    );
    const chunkType = type.toString('ascii');

    if (!dimensions) {
      assert.equal(chunkType, 'IHDR', 'PNG must begin with IHDR');
      assert.equal(length, 13, 'invalid PNG IHDR length');
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      assert.ok(width > 0 && height > 0, 'PNG dimensions must be positive');
      assert.equal(data[8], 8, 'README fallbacks must use 8-bit channels');
      assert.equal(data[9], 6, 'README fallbacks must use RGBA color');
      assert.deepEqual([...data.subarray(10, 13)], [0, 0, 0], 'unsupported PNG encoding');
      dimensions = { width, height };
    } else if (chunkType === 'IDAT') {
      imageData.push(data);
    } else if (chunkType === 'IEND') {
      assert.equal(length, 0, 'invalid PNG IEND length');
      sawEnd = true;
      offset = end;
      break;
    }
    offset = end;
  }

  assert.ok(dimensions, 'PNG is missing IHDR');
  assert.ok(imageData.length > 0, 'PNG is missing IDAT');
  assert.ok(sawEnd, 'PNG is missing IEND');
  assert.equal(offset, buffer.length, 'PNG contains trailing data');
  const decoded = inflateSync(Buffer.concat(imageData));
  const rowBytes = dimensions.width * 4;
  assert.equal(decoded.length, dimensions.height * (rowBytes + 1), 'PNG pixel data length is invalid');
  for (let row = 0; row < dimensions.height; row += 1) {
    assert.ok(decoded[row * (rowBytes + 1)] <= 4, `PNG row ${row} has an invalid filter`);
  }
  return dimensions;
}

function readGifSubBlocks(buffer, start) {
  const blocks = [];
  let offset = start;
  while (offset < buffer.length) {
    const length = buffer[offset];
    offset += 1;
    if (length === 0) return { data: Buffer.concat(blocks), offset };
    assert.ok(offset + length <= buffer.length, 'truncated GIF data sub-block');
    blocks.push(buffer.subarray(offset, offset + length));
    offset += length;
  }
  assert.fail('GIF data sub-blocks are not terminated');
}

function decodeGifImage(data, minimumCodeSize, expectedPixels) {
  assert.ok(minimumCodeSize >= 2 && minimumCodeSize <= 8, 'invalid GIF LZW code size');
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  let dictionary;
  let codeSize;
  let bitOffset = 0;
  let previous;
  let outputLength = 0;
  let ended = false;

  const reset = () => {
    dictionary = Array.from({ length: clearCode }, (_, value) => Uint8Array.of(value));
    dictionary.length = endCode + 1;
    codeSize = minimumCodeSize + 1;
    previous = undefined;
  };
  const readCode = () => {
    assert.ok(bitOffset + codeSize <= data.length * 8, 'GIF LZW stream ended before its end code');
    let code = 0;
    for (let bit = 0; bit < codeSize; bit += 1) {
      const position = bitOffset + bit;
      code |= ((data[position >> 3] >> (position & 7)) & 1) << bit;
    }
    bitOffset += codeSize;
    return code;
  };

  reset();
  while (!ended) {
    const code = readCode();
    if (code === clearCode) {
      reset();
      continue;
    }
    if (code === endCode) {
      ended = true;
      break;
    }

    let entry = dictionary[code];
    if (!entry && code === dictionary.length && previous) {
      entry = Uint8Array.from([...previous, previous[0]]);
    }
    assert.ok(entry, `GIF LZW references undefined code ${code}`);
    outputLength += entry.length;
    assert.ok(outputLength <= expectedPixels, 'GIF LZW decoded too many pixels');

    if (previous && dictionary.length < 4096) {
      dictionary.push(Uint8Array.from([...previous, entry[0]]));
      if (dictionary.length === 2 ** codeSize && codeSize < 12) codeSize += 1;
    }
    previous = entry;
  }

  assert.ok(ended, 'GIF LZW stream is missing its end code');
  assert.equal(outputLength, expectedPixels, 'GIF frame pixel count is invalid');
}

function parseGif(buffer) {
  assert.ok(buffer.length >= 14, 'GIF is truncated');
  assert.match(buffer.subarray(0, 6).toString('ascii'), /^GIF8[79]a$/, 'invalid GIF signature');
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  assert.ok(width > 0 && height > 0, 'GIF dimensions must be positive');
  const packed = buffer[10];
  let offset = 13 + ((packed & 0x80) ? 3 * 2 ** ((packed & 0x07) + 1) : 0);
  assert.ok(offset <= buffer.length, 'truncated GIF global color table');
  let frames = 0;
  let loopCount;
  let sawTrailer = false;

  while (offset < buffer.length) {
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0x3b) {
      sawTrailer = true;
      break;
    }
    if (marker === 0x21) {
      assert.ok(offset < buffer.length, 'truncated GIF extension');
      const label = buffer[offset];
      offset += 1;
      if (label === 0xff) {
        assert.ok(offset < buffer.length, 'truncated GIF application extension');
        const headerLength = buffer[offset];
        offset += 1;
        assert.equal(headerLength, 11, 'invalid GIF application identifier length');
        assert.ok(offset + headerLength <= buffer.length, 'truncated GIF application identifier');
        const identifier = buffer.subarray(offset, offset + headerLength).toString('ascii');
        offset += headerLength;
        const payload = readGifSubBlocks(buffer, offset);
        offset = payload.offset;
        if (identifier === 'NETSCAPE2.0' || identifier === 'ANIMEXTS1.0') {
          assert.equal(loopCount, undefined, 'duplicate GIF loop extension');
          assert.equal(payload.data.length, 3, 'invalid GIF loop payload');
          assert.equal(payload.data[0], 1, 'invalid GIF loop payload marker');
          loopCount = payload.data.readUInt16LE(1);
        }
      } else {
        const extension = readGifSubBlocks(buffer, offset);
        offset = extension.offset;
      }
      continue;
    }

    assert.equal(marker, 0x2c, `unexpected GIF block 0x${marker.toString(16)}`);
    assert.ok(offset + 9 <= buffer.length, 'truncated GIF image descriptor');
    const left = buffer.readUInt16LE(offset);
    const top = buffer.readUInt16LE(offset + 2);
    const frameWidth = buffer.readUInt16LE(offset + 4);
    const frameHeight = buffer.readUInt16LE(offset + 6);
    const imagePacked = buffer[offset + 8];
    assert.ok(frameWidth > 0 && frameHeight > 0, 'GIF frame dimensions must be positive');
    assert.ok(left + frameWidth <= width && top + frameHeight <= height, 'GIF frame exceeds its canvas');
    offset += 9;
    if (imagePacked & 0x80) offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
    assert.ok(offset < buffer.length, 'truncated GIF local color table');
    const minimumCodeSize = buffer[offset];
    offset += 1;
    const image = readGifSubBlocks(buffer, offset);
    offset = image.offset;
    decodeGifImage(image.data, minimumCodeSize, frameWidth * frameHeight);
    frames += 1;
  }

  assert.ok(sawTrailer, 'GIF is missing its trailer');
  assert.equal(offset, buffer.length, 'GIF contains trailing data');
  return { width, height, frames, loopCount };
}

function withGifLoopExtension(buffer, identifier, payload) {
  assert.equal(Buffer.byteLength(identifier, 'ascii'), 11, 'GIF loop identifier must be 11 bytes');
  const packed = buffer[10];
  const insertion = 13 + ((packed & 0x80) ? 3 * 2 ** ((packed & 0x07) + 1) : 0);
  const extension = Buffer.concat([
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from(identifier, 'ascii'),
    Buffer.from([payload.length]),
    payload,
    Buffer.from([0]),
  ]);
  return Buffer.concat([buffer.subarray(0, insertion), extension, buffer.subarray(insertion)]);
}

describe('README canonical landing media (REQ-LANDING-013/016/017)', () => {
  it('keeps media inside open Markdown fences inactive until a valid matching close', () => {
    const cases = [
      ['```markdown', '```not-a-close', '<picture>suffix</picture>', '```'],
      ['```markdown', '~~~', '<picture>marker</picture>', '```'],
      ['````markdown', '```', '<picture>length</picture>', '````'],
    ];
    for (const lines of cases) {
      assert.doesNotMatch(activeMarkdownHtml(lines.join('\n')), /<picture>/);
    }
    assert.match(
      activeMarkdownHtml(['```markdown', 'content', '``` \t', '<picture>active</picture>'].join('\n')),
      /<picture>active<\/picture>/,
    );
  });

  it('recognizes both GIF loop applications and rejects malformed loop payloads', () => {
    const oneShot = readFileSync(join(ROOT, 'assets', 'documentation', 'browser-e2e.gif'));
    assert.equal(
      parseGif(withGifLoopExtension(oneShot, 'ANIMEXTS1.0', Buffer.from([1, 0, 0]))).loopCount,
      0,
    );
    assert.equal(
      parseGif(withGifLoopExtension(oneShot, 'NETSCAPE2.0', Buffer.from([1, 3, 0]))).loopCount,
      3,
    );
    assert.throws(
      () => parseGif(withGifLoopExtension(oneShot, 'ANIMEXTS1.0', Buffer.from([2, 0, 0]))),
      /invalid GIF loop payload marker/,
    );
    assert.throws(
      () => parseGif(withGifLoopExtension(oneShot, 'ANIMEXTS1.0', Buffer.from([1, 0]))),
      /invalid GIF loop payload/,
    );
  });

  it('exposes every agreed picture as active README HTML with its accessibility attributes', () => {
    const { blocks, html } = activePictureBlocks(README);
    assert.equal(blocks.size, MEDIA.length, 'README must render exactly the agreed media blocks');
    for (const name of MEDIA) {
      const block = blocks.get(name);
      assert.ok(block, `${name} must be active README HTML rather than commented or fenced text`);
      assert.equal(block.source.get('media'), '(prefers-reduced-motion: reduce)');
      assert.equal(block.source.get('srcset'), `assets/documentation/${name}.png`);
      assert.equal(block.image.get('src'), `assets/documentation/${name}.gif`);
      assert.ok((block.image.get('alt') ?? '').trim().length > 0, `${name} needs non-empty alt text`);
      assert.equal(block.image.get('width'), '1200');
    }
    for (const retired of RETIRED_README_PICTURES) {
      assert.equal(html.includes(retired), false, `${retired} remains in active README content`);
      assert.equal(existsSync(join(ROOT, 'assets', 'documentation', retired)), false, `${retired} still exists`);
    }
  });

  it('decodes every animation and exact-size fallback within repository budgets', () => {
    let aggregateBytes = 0;
    for (const name of MEDIA) {
      const gifPath = join(ROOT, 'assets', 'documentation', `${name}.gif`);
      const pngPath = join(ROOT, 'assets', 'documentation', `${name}.png`);
      const gifSize = statSync(gifPath).size;
      const pngSize = statSync(pngPath).size;
      aggregateBytes += gifSize + pngSize;

      const gif = parseGif(readFileSync(gifPath));
      assert.deepEqual(parsePng(readFileSync(pngPath)), { width: gif.width, height: gif.height });
      assert.ok(gif.width >= 800, `${name} must remain readable at GitHub content width`);
      assert.ok(gif.width > gif.height, `${name} must use a wide README composition`);
      assert.ok(gif.frames >= 3, `${name} must contain real animation`);
      assert.equal(gif.loopCount, ONE_SHOT_MEDIA.has(name) ? undefined : 0, `${name} loop policy drifted`);
      assert.ok(gifSize <= README_MEDIA_BUDGETS.gifBytes, `${name}.gif exceeds the 10 MiB budget`);
    }
    assert.ok(
      aggregateBytes <= README_MEDIA_BUDGETS.aggregateBytes,
      'README media exceeds the 30 MiB aggregate budget',
    );
  });
});
