import { readBoundedResponse } from '../lib/bounded-stream';

const SHA = /^[a-f0-9]{40}$/;
const NAME = /^[A-Za-z0-9_.-]+$/;
const MAX_ADVERTISEMENT_BYTES = 1024 * 1024;
const MAX_PACK_BYTES = 32 * 1024 * 1024;
const MAX_DEADLINE_MS = 5 * 60_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

type Input = {
  owner: string;
  repository: string;
  head: string;
  acknowledgedHead: string | null;
  deadline: number;
  maxPackBytes: number;
  send: (request: Request) => Promise<Response>;
  signal?: AbortSignal;
  host?: string;
};

function denied(): never { throw new Error('Approved Git transport unavailable'); }

function packets(bytes: Uint8Array): Array<Uint8Array | null> {
  const values: Array<Uint8Array | null> = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength) denied();
    const length = Number.parseInt(decoder.decode(bytes.subarray(offset, offset + 4)), 16);
    if (!Number.isInteger(length) || length < 0 || length > 65520
      || !/^[0-9a-fA-F]{4}$/.test(decoder.decode(bytes.subarray(offset, offset + 4)))) denied();
    offset += 4;
    if (length === 0) { values.push(null); continue; }
    if (length < 4 || offset + length - 4 > bytes.byteLength) denied();
    values.push(bytes.subarray(offset, offset + length - 4));
    offset += length - 4;
  }
  return values;
}

function packet(line: string): Uint8Array {
  const body = encoder.encode(line);
  return encoder.encode((body.byteLength + 4).toString(16).padStart(4, '0') + line);
}

function join(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

function advertised(bytes: Uint8Array): { refs: Set<string>; reachable: boolean } {
  const lines = packets(bytes);
  if (decoder.decode(lines[0] ?? new Uint8Array()) !== '# service=git-upload-pack\n'
    || lines[1] !== null) denied();
  const refs = new Set<string>();
  let reachable = false;
  let first = true;
  for (const line of lines.slice(2)) {
    if (line === null) continue;
    const text = decoder.decode(line);
    if (text === 'version 1\n') continue;
    const match = /^([a-f0-9]{40}) (HEAD|refs\/[A-Za-z0-9._/-]+)(?:\0([^\n]*))?\n$/.exec(text);
    if (!match) denied();
    if (first) {
      if (!match[3] || (match[3].includes('object-format=') && !match[3].includes('object-format=sha1'))) denied();
      reachable = match[3].split(' ').includes('allow-reachable-sha1-in-want');
      if (!match[3].split(' ').includes('side-band-64k')) denied();
      first = false;
    }
    refs.add(match[1]);
  }
  if (first) denied();
  return { refs, reachable };
}

function extractPack(bytes: Uint8Array, maxPackBytes: number): Uint8Array {
  const lines = packets(bytes);
  if (decoder.decode(lines[0] ?? new Uint8Array()) !== 'NAK\n'
    || lines.at(-1) !== null) denied();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (const line of lines.slice(1, -1)) {
    if (!line || line.byteLength < 1) denied();
    if (line[0] === 2) continue; // Server progress is not part of the pack.
    if (line[0] !== 1) denied(); // Fatal channel or unnegotiated framing.
    const chunk = line.subarray(1);
    size += chunk.byteLength;
    if (size > maxPackBytes) denied();
    chunks.push(chunk);
  }
  const pack = join(chunks);
  if (pack.byteLength < 12 || decoder.decode(pack.subarray(0, 4)) !== 'PACK') denied();
  // index-pack --strict in the isolated host is the object and checksum verifier.
  return pack;
}

/** Retrieve inert Git objects for the exact parent-authored PR revision.
 * Authentication belongs only to `send`; no token, remote URL or Git command
 * enters the host or operator session. The isolated host verifies objects and ancestry. */
export async function fetchApprovedGitPack(input: Input): Promise<Uint8Array> {
  const host = input.host ?? 'github.com';
  if (!NAME.test(input.owner) || input.owner === '.' || input.owner === '..'
    || !NAME.test(input.repository) || input.repository === '.' || input.repository === '..'
    || !/^[A-Za-z0-9.-]+$/.test(host)
    || !SHA.test(input.head) || input.acknowledgedHead !== null && !SHA.test(input.acknowledgedHead)
    || !Number.isSafeInteger(input.deadline) || input.deadline <= Date.now()
    || input.deadline > Date.now() + MAX_DEADLINE_MS
    || !Number.isSafeInteger(input.maxPackBytes) || input.maxPackBytes < 12
    || input.maxPackBytes > MAX_PACK_BYTES || input.signal?.aborted) denied();
  const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, input.deadline - Date.now())),
    ...(input.signal ? [input.signal] : [])]);
  const root = `https://${host}/${input.owner}/${input.repository}.git`;
  const discovery = await input.send(new Request(`${root}/info/refs?service=git-upload-pack`, {
    headers: { 'Git-Protocol': 'version=1', Accept: 'application/x-git-upload-pack-advertisement' },
    redirect: 'manual', signal,
  }));
  if (discovery.status !== 200 || discovery.redirected
    || discovery.headers.get('content-type')?.split(';')[0] !== 'application/x-git-upload-pack-advertisement') denied();
  const advertisement = advertised(await readBoundedResponse(discovery, MAX_ADVERTISEMENT_BYTES, 'Git advertisement', signal));
  const wants = [input.head, ...(input.acknowledgedHead && input.acknowledgedHead !== input.head
    ? [input.acknowledgedHead] : [])];
  if (wants.some(sha => !advertisement.refs.has(sha) && !advertisement.reachable)) denied();
  const request = join([packet(`want ${wants[0]} side-band-64k no-progress\n`),
    ...wants.slice(1).map(sha => packet(`want ${sha}\n`)), encoder.encode('0000'), packet('done\n')]);
  const response = await input.send(new Request(`${root}/git-upload-pack`, { method: 'POST',
    headers: { 'Git-Protocol': 'version=1', 'Content-Type': 'application/x-git-upload-pack-request',
      Accept: 'application/x-git-upload-pack-result' }, body: request, redirect: 'manual', signal }));
  if (response.status !== 200 || response.redirected
    || response.headers.get('content-type')?.split(';')[0] !== 'application/x-git-upload-pack-result') denied();
  const bytes = await readBoundedResponse(response, input.maxPackBytes + MAX_ADVERTISEMENT_BYTES, 'Git pack', signal);
  if (signal.aborted || Date.now() >= input.deadline) denied();
  return extractPack(bytes, input.maxPackBytes);
}
