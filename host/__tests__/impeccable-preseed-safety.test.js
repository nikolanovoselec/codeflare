import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const impeccableRoot = resolve(__dirname, '../../preseed/agents/pi/skills/impeccable');
const rootsModule = join(impeccableRoot, 'scripts/live/roots.mjs');
const embedPrompt = join(impeccableRoot, 'scripts/embed-prompt.mjs');

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[value] = crc >>> 0;
  }
  return table;
})();

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return chunk;
}

function parsePng(buffer) {
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    assert.ok(offset + 12 <= buffer.length, 'chunk header and CRC remain in bounds');
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    assert.ok(end <= buffer.length, 'chunk payload remains in bounds');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    assert.equal(buffer.readUInt32BE(offset + 8 + length), crc32(Buffer.concat([
      Buffer.from(type, 'ascii'),
      data,
    ])));
    chunks.push({ type, data });
    offset = end;
  }
  assert.equal(offset, buffer.length);
  return chunks;
}

describe('vendored Impeccable safety patches', () => {
  it('ignores stale, external, and symlink-escaped persisted app roots', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'codeflare-impeccable-roots-'));
    const repo = join(fixture, 'repo');
    const external = join(fixture, 'external-app');
    const escapedLink = join(repo, 'escaped-app');

    try {
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, '.impeccable/live'), { recursive: true });
      writeFileSync(join(repo, 'package.json'), '{}');
      writeFileSync(join(repo, 'index.html'), '<main></main>');

      mkdirSync(join(external, '.impeccable/live'), { recursive: true });
      writeFileSync(
        join(external, '.impeccable/live/roots.json'),
        JSON.stringify({
          version: 1,
          appRoot: external,
          repoRoot: external,
          contextRoot: null,
          sessionRoot: join(external, '.impeccable/live'),
          productPath: null,
          designPath: null,
          resolvedFrom: 'fixture',
        }),
      );
      symlinkSync(external, escapedLink, 'dir');
      writeFileSync(
        join(repo, '.impeccable/live/app-root.json'),
        JSON.stringify({
          version: 2,
          appRoots: [
            { appRoot: join(fixture, 'missing-app') },
            { appRoot: external },
            { appRoot: escapedLink },
          ],
        }),
      );

      const { resolveLiveRoots } = await import(`${pathToFileURL(rootsModule).href}?fixture=${Date.now()}`);
      const resolved = resolveLiveRoots(repo);
      assert.equal(resolved.source, 'fresh');
      assert.equal(resolved.manifest.appRoot, repo);
      assert.equal(resolved.manifest.repoRoot, repo);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('embeds a prompt before the real IEND chunk when ancillary payload contains IEND bytes', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'codeflare-impeccable-png-'));
    const image = join(fixture, 'fixture.png');
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const ancillary = Buffer.from('payload-before-IEND-payload-after', 'utf8');

    try {
      writeFileSync(image, Buffer.concat([
        signature,
        pngChunk('IHDR', ihdr),
        pngChunk('iTXt', ancillary),
        pngChunk('IEND', Buffer.alloc(0)),
      ]));

      const result = spawnSync(process.execPath, [embedPrompt, image, '--prompt', 'approved prompt'], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);

      const chunks = parsePng(readFileSync(image));
      assert.deepEqual(chunks.map(({ type }) => type), ['IHDR', 'iTXt', 'tEXt', 'IEND']);
      assert.deepEqual(chunks[1].data, ancillary);
      assert.equal(chunks.at(-1).data.length, 0);
      assert.deepEqual(
        chunks[2].data,
        Buffer.concat([
          Buffer.from('impeccable:prompt', 'latin1'),
          Buffer.from([0]),
          Buffer.from('approved prompt', 'utf8'),
        ]),
      );
      assert.deepEqual(
        readFileSync(image).subarray(0, 8),
        signature,
      );
      assert.deepEqual(
        readFileSync(image).subarray(-12),
        pngChunk('IEND', Buffer.alloc(0)),
      );
      assert.equal(
        readFileSync(image).includes(Buffer.from('payload-before-IEND-payload-after')),
        true,
      );
      assert.deepEqual(readdirSync(fixture), ['fixture.png']);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
