import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const HERMES_MERGE_FILES = ['global/USER.md', 'global/MEMORY.md', 'global/failures.md', 'Projects/workspace/MEMORY.md'] as const;
const files = HERMES_MERGE_FILES;
type File = typeof files[number];
type Store<T> = Record<File, T>;
type SavedSnapshot = { owner: string; sessionId: string; generation: number; intent: string; snapshotId: string };
type Revision = { revision: string; source: SavedSnapshot; files: Store<string> };
type Current = { etag: string | null; commit: Omit<Revision, 'source'> & { source?: SavedSnapshot } };

type MergeResult = { status: 'pending' | 'skipped' | 'uncertain' }
  | { status: 'merged'; receipt: { source: SavedSnapshot; revision: string } };
export interface HermesMergeStorage {
  loadSnapshot(source: SavedSnapshot, signal: AbortSignal): Promise<{ baseline: Store<Uint8Array> | null; files: Store<Uint8Array> }>;
  readCommit(signal: AbortSignal): Promise<Current>;
  readRevisionFile(revision: string, file: File, signal: AbortSignal): Promise<Uint8Array | null>;
  stageRevisionFile(revision: string, file: File, body: Uint8Array, signal: AbortSignal): Promise<void>;
  commitRevision(commit: Revision, expectedEtag: string | null, signal: AbortSignal): Promise<boolean>;
}

const maxUnits = 150_000;
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const mapFiles = <T>(read: (file: File) => T) => Object.fromEntries(files.map(file => [file, read(file)])) as Store<T>;

function entries(text: string): string[] {
  const value = text.replace(/\r\n/g, '\n').trim();
  if (value.includes('\0')) throw new Error('Invalid Hermes Markdown');
  if (!value) return [];
  const parts = value.split('\n§\n').map(entry => entry.trim());
  if (parts.some(entry => !entry || /^\s*§\s*$/m.test(entry))) throw new Error('Invalid Hermes entry boundary');
  return parts;
}

function comparable(raw: string): string {
  // Stock Hermes stores timestamps in an optional last-line HTML comment;
  // keep project scope material even when the dates are the only text removed.
  const metadata = raw.match(/^(.*?)\s*<!--\s*created=([^,]+),\s*last=([^,>]+)(?:,\s*project64=([A-Za-z0-9_-]+))?\s*-->\s*$/s);
  return metadata ? metadata[1].trim() + (metadata[4] ? ` <!-- project64=${metadata[4]} -->` : '') : raw;
}

function candidate(value: Store<Uint8Array>): Store<Uint8Array> {
  if (!value || Object.keys(value).length !== files.length) throw new Error('Incomplete candidate revision');
  return mapFiles(file => {
    const bytes = value[file];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxUnits * 4) throw new Error('Invalid candidate size');
    const text = decode(bytes);
    if (text.length > maxUnits) throw new Error('Candidate exceeds maximum size');
    entries(text);
    return bytes;
  });
}

/** Race only at I/O boundaries; no continuation can publish after abort. */
async function bounded<T>(signal: AbortSignal, work: () => Promise<T> | T): Promise<T> {
  signal.throwIfAborted();
  let cancel = () => {};
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), stopped]); }
  finally { signal.removeEventListener('abort', cancel); }
}

/** Inference proposes bytes; only this worker validates and conditionally commits. */
export async function runHermesShutdownMerge(input: {
  source: SavedSnapshot;
  attemptId: string;
  deadline: number;
  signal: AbortSignal;
  storage: HermesMergeStorage;
  infer(request: { masters: Store<string>; changes: Store<string[]>; repair: boolean; signal: AbortSignal }): Promise<Store<Uint8Array>> | Store<Uint8Array>;
}): Promise<MergeResult> {
  const { storage, source, deadline, attemptId } = input;
  if (input.signal.aborted || !Number.isSafeInteger(deadline) || deadline <= Date.now()
    || !/^[a-z0-9_-]{1,128}$/i.test(attemptId)) return { status: 'pending' };
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), deadline - Date.now());
  const signal = AbortSignal.any([input.signal, timeout.signal]);
  const check = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('Merge deadline expired');
  };
  const request = <T>(work: () => Promise<T> | T) => { check(); return bounded(signal, work); };
  const verify = async (commit: Current['commit'], readSignal: AbortSignal) => {
    const verified = {} as Store<string>;
    for (const file of files) {
      const body = await bounded(readSignal, () => storage.readRevisionFile(commit.revision, file, readSignal));
      if (!body || digest(body) !== commit.files[file]) throw new Error('Unverified master revision');
      verified[file] = decode(body);
    }
    return verified;
  };
  const merged = (revision: string): MergeResult => ({ status: 'merged', receipt: { source, revision } });
  try {
    const saved = await request(() => storage.loadSnapshot(source, signal));
    if (!saved.baseline) return { status: 'pending' };
    const baseline = saved.baseline;
    const current = await request(() => storage.readCommit(signal));
    if (isDeepStrictEqual(current.commit.source, source)) {
      await verify(current.commit, signal);
      return merged(current.commit.revision);
    }
    const changes = mapFiles(file => {
      const inherited = new Set(entries(decode(baseline[file])).map(comparable));
      return [...new Set(entries(decode(saved.files[file])).map(comparable))].filter(entry => !inherited.has(entry));
    });
    if (Object.values(changes).every(list => !list.length)) return { status: 'skipped' };
    const masters = await verify(current.commit, signal);
    const infer = (repair: boolean) => request(() => input.infer({ masters, changes, repair, signal }));
    let proposed = await infer(false);
    let output: Store<Uint8Array>;
    try { output = candidate(proposed); }
    catch { proposed = await infer(true); output = candidate(proposed); }
    const revision = `${attemptId}-${randomUUID()}`;
    const commit: Revision = { revision, source, files: mapFiles(file => digest(output[file])) };
    for (const file of files) await request(() => storage.stageRevisionFile(revision, file, output[file], signal));
    await verify(commit, signal);
    check();
    try {
      if (!await bounded(signal, () => storage.commitRevision(commit, current.etag, signal))) return { status: 'pending' };
    } catch { /* The conditional write may still have landed. Do not replay it. */ }
    try {
      // Permit one bounded readback of an already-issued write even after cancellation.
      const readSignal = signal.aborted ? AbortSignal.timeout(5000) : signal;
      const observed = await bounded(readSignal, () => storage.readCommit(readSignal));
      if (isDeepStrictEqual(observed.commit, commit)) {
        await verify(observed.commit, readSignal);
        return merged(revision);
      }
    } catch { /* The queue must reconcile uncertainty before another publication. */ }
    return { status: 'uncertain' };
  } catch { return { status: 'pending' }; }
  finally { clearTimeout(timer); }
}

/** Stable identity of the actual bytes acknowledged by a final save. */
export function hermesSnapshotDigest(baseline: Store<Uint8Array>, active: Store<Uint8Array>): string {
  return digest(Buffer.from(JSON.stringify(files.map(file => [file, digest(baseline[file]), digest(active[file])]))));
}

const memoryRoot = 'Vault/Memory/';
const mastersRoot = `${memoryRoot}Masters/`;
const pointerKey = `${mastersRoot}current.json`;
const hexDigest = /^[0-9a-f]{64}$/;
const entityTag = /^"[^"\r\n]+"$/;
const validRevision = /^[a-z0-9_-]{1,180}$/i;
const maxRead = 4 * 1024 * 1024;

export function parseHermesBaseline(bytes: Uint8Array): Store<Uint8Array> {
  const original = JSON.parse(decode(bytes)) as Store<string> | null;
  // Reseed proof is for restart acknowledgement, not part of the memory delta.
  if (!original || Object.keys(original).some(key => key !== '_reseed' && !files.includes(key as File))
    || !files.every(file => typeof original[file] === 'string')) throw new Error('Invalid Hermes baseline');
  return mapFiles(file => Buffer.from(original[file]));
}

/** An adapter over the container's existing signed owner-scoped R2 transport. */
export function createHermesMergeStorage(input: {
  endpoint: string;
  bucket: string;
  sseHeaders: Record<string, string>;
  send(request: Request): Promise<Response>;
}): HermesMergeStorage {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== '/' || !/^[a-z0-9][a-z0-9.-]{0,62}$/.test(input.bucket) || input.bucket.endsWith('.')) {
    throw new Error('Invalid Hermes storage endpoint');
  }
  const send = (key: string, signal: AbortSignal, init?: RequestInit, withSse = true) => {
    signal.throwIfAborted();
    return input.send(new Request(`${endpoint.origin}/${input.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`, {
      ...init, signal, redirect: 'error', headers: { ...(withSse ? input.sseHeaders : {}), ...init?.headers },
    }));
  };
  const read = async (key: string, signal: AbortSignal, limit = maxRead) => {
    let response = await send(key, signal);
    if (key.endsWith('.md') && Object.keys(input.sseHeaders).length && [400, 403].includes(response.status)) {
      await response.body?.cancel();
      // R2 can preserve existing empty Markdown as default-encrypted data.
      // Accept no nonempty plaintext bytes, and still verify the content digest.
      response = await send(key, signal, { headers: { 'x-codeflare-hermes-empty-read': '1' } }, false);
      if (response.status !== 200 || response.headers.get('content-length') !== '0' || response.headers.has('content-range')) {
        await response.body?.cancel();
        throw new Error('Hermes empty object unavailable');
      }
      limit = 0;
    }
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error('Hermes object unavailable');
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await bounded(signal, () => reader.read());
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) throw new Error('Hermes object exceeds the read budget');
        chunks.push(part.value);
      }
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    return { bytes: Buffer.concat(chunks, size), etag: response.headers.get('etag') };
  };
  const put = async (key: string, body: Uint8Array, condition: Record<string, string>, signal: AbortSignal) => {
    const response = await send(key, signal, { method: 'PUT', body: Buffer.from(body), headers: condition });
    await response.body?.cancel();
    if (response.status === 412) return false;
    if (response.status !== 200) throw new Error('Hermes write outcome unavailable');
    return true;
  };
  const validateSource = (source: SavedSnapshot) => {
    if (!source || source.owner !== input.bucket || !/^[a-z0-9]{8,24}$/.test(source.sessionId)
      || !Number.isSafeInteger(source.generation) || source.generation < 1
      || !/^[a-z0-9_-]{1,128}$/i.test(source.intent) || !hexDigest.test(source.snapshotId)) {
      throw new Error('Invalid Hermes saved snapshot');
    }
  };
  let legacy: Store<Uint8Array> | undefined;
  return {
    async loadSnapshot(source, signal) {
      validateSource(source);
      const prefix = `${memoryRoot}Sessions/${source.sessionId}/`;
      const object = await read(`${prefix}baseline.json`, signal);
      if (!object) return { baseline: null, files: mapFiles(() => Buffer.alloc(0)) };
      const baseline = parseHermesBaseline(object.bytes);
      const active = {} as Store<Uint8Array>;
      for (const file of files) {
        const saved = await read(`${prefix}${file}`, signal);
        if (!saved) throw new Error('Incomplete Hermes snapshot');
        active[file] = saved.bytes;
      }
      if (hermesSnapshotDigest(baseline, active) !== source.snapshotId) throw new Error('Saved Hermes snapshot changed');
      return { baseline, files: active };
    },
    async readCommit(signal) {
      const current = await read(pointerKey, signal, 4096);
      if (!current) {
        legacy = {} as Store<Uint8Array>;
        for (const file of files) {
          const prior = await read(memoryRoot + file.replace(/^global\//, ''), signal);
          legacy[file] = prior?.bytes ?? Buffer.alloc(0);
        }
        const bootstrap = legacy;
        return { etag: null, commit: { revision: 'legacy', files: mapFiles(file => digest(bootstrap[file])) } };
      }
      const commit = JSON.parse(decode(current.bytes)) as Revision;
      if (!current.etag || !entityTag.test(current.etag) || !commit || !validRevision.test(commit.revision) || commit.revision === 'legacy'
        || !commit.files || Object.keys(commit.files).length !== files.length
        || !files.every(file => hexDigest.test(commit.files[file]))) throw new Error('Invalid current Hermes revision');
      validateSource(commit.source);
      return { etag: current.etag, commit };
    },
    async readRevisionFile(revision, file, signal) {
      if (!files.includes(file) || !validRevision.test(revision)) throw new Error('Invalid Hermes revision path');
      if (revision === 'legacy') return legacy?.[file] ?? null;
      return (await read(`${mastersRoot}${revision}/${file}`, signal, maxUnits * 4))?.bytes ?? null;
    },
    async stageRevisionFile(revision, file, body, signal) {
      if (!files.includes(file) || !validRevision.test(revision) || revision === 'legacy') throw new Error('Invalid Hermes revision path');
      if (!await put(`${mastersRoot}${revision}/${file}`, body, { 'If-None-Match': '*' }, signal)) {
        throw new Error('Hermes revision already exists');
      }
    },
    async commitRevision(commit, expectedEtag, signal) {
      validateSource(commit.source);
      if (expectedEtag !== null && !entityTag.test(expectedEtag)) throw new Error('Invalid Hermes commit precondition');
      return put(pointerKey, Buffer.from(JSON.stringify(commit)), expectedEtag === null
        ? { 'If-None-Match': '*' } : { 'If-Match': expectedEtag }, signal);
    },
  };
}
