#!/usr/bin/env node
// Embed a generation prompt into an image so the intent travels with the file,
// across harnesses and machines. Read it back with --read.
//
//   node embed-prompt.mjs <image> --prompt "the prompt text"
//   node embed-prompt.mjs <image> --prompt-file prompt.txt
//   node embed-prompt.mjs <image> --read
//
// Formats: PNG (tEXt chunk, keyword "impeccable:prompt"), JPEG (COM segment).
// WebP and anything else fall back to a `<image>.json` sidecar; --read checks
// the sidecar for every format, so the fallback stays recoverable. Embedding
// rewrites a few MB at most: latency is milliseconds, generation is minutes.
// Caveat worth knowing: image optimizers in build pipelines often strip
// metadata from their OUTPUT files; the intent lives on the source asset,
// which is the one a builder reads.

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import zlib from 'node:zlib';

const KEYWORD = 'impeccable:prompt';
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const readMode = args.includes('--read');
const argOf = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };

if (!file || !fs.existsSync(file)) { console.error('embed-prompt: image file required'); process.exit(1); }

const buf = fs.readFileSync(file);
const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (data) => { let c = 0xffffffff; for (const b of data) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

function parsePngChunks(b) {
  const chunks = [];
  let off = 8;
  while (off < b.length) {
    if (off + 12 > b.length) throw new Error('truncated PNG chunk header');
    const len = b.readUInt32BE(off);
    const end = off + 12 + len;
    if (end > b.length) throw new Error('PNG chunk exceeds file bounds');
    const type = b.toString('ascii', off + 4, off + 8);
    chunks.push({ off, end, len, type, data: b.subarray(off + 8, off + 8 + len) });
    off = end;
    if (type === 'IEND') {
      if (len !== 0 || off !== b.length) throw new Error('invalid terminal PNG IEND chunk');
      return chunks;
    }
  }
  throw new Error('PNG has no terminal IEND chunk');
}

function writeAtomic(target, data) {
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temp, data, { mode: fs.statSync(target).mode });
    fs.renameSync(temp, target);
  } catch (err) {
    try { fs.rmSync(temp, { force: true }); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

function readPngText(b) {
  let off = 8;
  while (off + 12 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    if (type === 'tEXt' || type === 'zTXt') {
      const data = b.subarray(off + 8, off + 8 + len);
      const nul = data.indexOf(0);
      if (nul !== -1 && data.toString('latin1', 0, nul) === KEYWORD) {
        if (type === 'tEXt') return data.toString('utf8', nul + 1);
        return zlib.inflateSync(data.subarray(nul + 2)).toString('utf8');
      }
    }
    off += 12 + len;
  }
  return null;
}

function readJpegCom(b) {
  let off = 2;
  while (off + 4 <= b.length && b[off] === 0xff) {
    const marker = b[off + 1];
    if (marker === 0xda) break; // start of scan: no more segments
    const len = b.readUInt16BE(off + 2);
    if (marker === 0xfe) {
      const text = b.toString('utf8', off + 4, off + 2 + len);
      if (text.startsWith(KEYWORD + '\0')) return text.slice(KEYWORD.length + 1);
    }
    off += 2 + len;
  }
  return null;
}

const sidecar = `${file}.json`;
if (readMode) {
  let prompt = null;
  if (isPng) prompt = readPngText(buf);
  else if (isJpeg) prompt = readJpegCom(buf);
  if (prompt == null && fs.existsSync(sidecar)) {
    try { prompt = JSON.parse(fs.readFileSync(sidecar, 'utf8')).prompt ?? null; } catch { /* fall through */ }
  }
  if (prompt == null) { console.error('embed-prompt: no embedded prompt found'); process.exit(2); }
  console.log(prompt);
  process.exit(0);
}

const prompt = argOf('--prompt') ?? (argOf('--prompt-file') ? fs.readFileSync(argOf('--prompt-file'), 'utf8') : null);
if (!prompt) { console.error('embed-prompt: --prompt or --prompt-file required'); process.exit(1); }

if (isPng) {
  let chunks;
  try {
    chunks = parsePngChunks(buf);
  } catch (err) {
    console.error(`embed-prompt: malformed PNG: ${err.message}`);
    process.exit(1);
  }
  const body = chunks
    .filter(({ type, data }) => {
      if (type === 'IEND') return false;
      const nul = data.indexOf(0);
      return !((type === 'tEXt' || type === 'zTXt')
        && nul !== -1
        && data.toString('latin1', 0, nul) === KEYWORD);
    })
    .map(({ off, end }) => buf.subarray(off, end));
  const iend = chunks.at(-1);
  const promptChunk = pngChunk('tEXt', Buffer.concat([
    Buffer.from(KEYWORD, 'latin1'),
    Buffer.from([0]),
    Buffer.from(prompt, 'utf8'),
  ]));
  writeAtomic(file, Buffer.concat([
    buf.subarray(0, 8),
    ...body,
    promptChunk,
    buf.subarray(iend.off, iend.end),
  ]));
  console.log(`EMBEDDED: ${file} (png tEXt, ${prompt.length} chars)`);
} else if (isJpeg) {
  const seg = Buffer.from(`${KEYWORD}\0${prompt}`, 'utf8');
  if (seg.length + 2 > 0xffff) { console.error('embed-prompt: prompt too long for a JPEG segment'); process.exit(1); }
  const com = Buffer.alloc(4 + seg.length);
  com[0] = 0xff; com[1] = 0xfe; com.writeUInt16BE(seg.length + 2, 2); seg.copy(com, 4);
  fs.writeFileSync(file, Buffer.concat([buf.subarray(0, 2), com, buf.subarray(2)]));
  console.log(`EMBEDDED: ${file} (jpeg COM, ${prompt.length} chars)`);
} else {
  fs.writeFileSync(sidecar, JSON.stringify({ prompt, createdAt: new Date().toISOString() }, null, 2));
  console.log(`EMBEDDED: ${sidecar} (sidecar fallback for this format)`);
}
