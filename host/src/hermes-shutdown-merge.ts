import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const HERMES_MERGE_FILES = ['global/USER.md', 'global/MEMORY.md', 'global/failures.md', 'Projects/workspace/MEMORY.md'] as const;
const files = HERMES_MERGE_FILES;
type File = typeof files[number];
type Store<T> = Record<File, T>;
type SavedSnapshot = { owner: string; sessionId: string; generation: number; intent: string; snapshotId: string };
type MergeResult = { status: 'pending' | 'skipped' } | { status: 'merged'; receipt: { source: SavedSnapshot } };
export interface HermesMergeStorage {
  loadSnapshot(source: SavedSnapshot, signal: AbortSignal): Promise<{ baseline: Store<Uint8Array> | null; files: Store<Uint8Array> }>;
  readMaster(file: File, signal: AbortSignal): Promise<Uint8Array | null>;
  writeMaster(file: File, body: Uint8Array, signal: AbortSignal): Promise<void>;
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
  if (!value || Object.keys(value).length !== files.length) throw new Error('Incomplete merge candidate');
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

/** Inference proposes bytes; only this worker validates and syncs the masters. */
export async function runHermesShutdownMerge(input: {
  source: SavedSnapshot;
  deadline: number;
  signal: AbortSignal;
  storage: HermesMergeStorage;
  infer(request: { masters: Store<string>; changes: Store<string[]>; repair: boolean; signal: AbortSignal }): Promise<Store<Uint8Array>> | Store<Uint8Array>;
}): Promise<MergeResult> {
  const { storage, source, deadline } = input;
  if (input.signal.aborted || !Number.isSafeInteger(deadline) || deadline <= Date.now()) return { status: 'pending' };
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), deadline - Date.now());
  const signal = AbortSignal.any([input.signal, timeout.signal]);
  const check = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('Merge deadline expired');
  };
  const request = <T>(work: () => Promise<T> | T) => { check(); return bounded(signal, work); };
  try {
    const saved = await request(() => storage.loadSnapshot(source, signal));
    if (!saved.baseline) return { status: 'pending' };
    const baseline = saved.baseline;
    const changes = mapFiles(file => {
      const inherited = new Set(entries(decode(baseline[file])).map(comparable));
      return [...new Set(entries(decode(saved.files[file])).map(comparable))].filter(entry => !inherited.has(entry));
    });
    if (Object.values(changes).every(list => !list.length)) return { status: 'skipped' };
    const masters = {} as Store<string>;
    for (const file of files) masters[file] = decode(await request(() => storage.readMaster(file, signal)) ?? Buffer.alloc(0));
    const infer = (repair: boolean) => request(() => input.infer({ masters, changes, repair, signal }));
    let proposed = await infer(false);
    let output: Store<Uint8Array>;
    try { output = candidate(proposed); }
    catch { proposed = await infer(true); output = candidate(proposed); }
    // Wait for the active rclone process to exit before settling the writer.
    for (const file of files) {
      check();
      await storage.writeMaster(file, output[file], signal);
    }
    for (const file of files) {
      const actual = await request(() => storage.readMaster(file, signal));
      if (!actual || digest(actual) !== digest(output[file])) throw new Error('Unverified Hermes master');
    }
    check();
    return { status: 'merged', receipt: { source } };
  } catch { return { status: 'pending' }; }
  finally { clearTimeout(timer); }
}

/** Stable identity of the actual bytes acknowledged by a final save. */
export function hermesSnapshotDigest(baseline: Store<Uint8Array>, active: Store<Uint8Array>): string {
  return digest(Buffer.from(JSON.stringify(files.map(file => [file, digest(baseline[file]), digest(active[file])]))));
}

const memoryRoot = 'Vault/Memory/';
const hexDigest = /^[0-9a-f]{64}$/;
const maxRead = 4 * 1024 * 1024;

export function parseHermesBaseline(bytes: Uint8Array): Store<Uint8Array> {
  const original = JSON.parse(decode(bytes)) as Store<string> | null;
  // Reseed proof is for restart acknowledgement, not part of the memory delta.
  if (!original || Object.keys(original).some(key => key !== '_reseed' && !files.includes(key as File))
    || !files.every(file => typeof original[file] === 'string')) throw new Error('Invalid Hermes baseline');
  return mapFiles(file => Buffer.from(original[file]));
}

/** Exact-object transfers through the same owner-scoped config as final save. */
export function createHermesMergeStorage({ bucket, configFile, home, env = process.env }: {
  bucket: string; configFile: string; home: string; env?: NodeJS.ProcessEnv;
}) {
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(bucket) || bucket.endsWith('.') || !isAbsolute(configFile) || !isAbsolute(home)) {
    throw new Error('Invalid Hermes rclone configuration');
  }
  const remote = `r2:${bucket}/`;
  const run = (args: string[], signal: AbortSignal, limit: number, input?: Uint8Array, emptyRead = false) => {
    signal.throwIfAborted();
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn('rclone', [...args, '--config', configFile, '--contimeout', '5s', '--timeout', '15s',
        '--retries', '1', '--low-level-retries', '1'], {
        env: { ...env, CODEFLARE_RCLONE_HERMES_EMPTY_READ: emptyRead ? '1' : '0' },
        signal, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'ignore'],
      });
      const chunks: Buffer[] = [];
      let size = 0, failed = false;
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) { failed = true; child.kill('SIGKILL'); }
        else chunks.push(chunk);
      });
      child.on('error', () => { failed = true; });
      child.stdin.on('error', () => { failed = true; });
      child.once('close', code => {
        if (signal.aborted) reject(signal.reason);
        else if (code !== 0 || failed) reject(new Error('Hermes rclone transfer failed'));
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.end(input);
    });
  };
  const read = async (key: string, signal: AbortSignal, limit = maxRead) => {
    const listed = (await run(['lsf', remote, '--recursive', '--files-only', '--include', `/${key}`], signal, 1024)).toString();
    if (!listed) return null;
    if (listed !== `${key}\n`) throw new Error('Unexpected Hermes object listing');
    // Use the exact object, not a broad filter or a recursive master transfer.
    return run(['cat', remote + key], signal, limit, undefined, key.endsWith('.md'));
  };
  const masterKey = (file: File) => memoryRoot + file.replace(/^global\//, '');
  const saveLocalMaster = async (key: string, bytes: Uint8Array, signal: AbortSignal) => {
    const parts = key.split('/');
    const name = parts.pop()!;
    let parent = home;
    for (const part of parts) {
      parent = join(parent, part);
      await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      if (!(await lstat(parent)).isDirectory()) throw new Error('Invalid Hermes master directory');
    }
    const path = join(parent, name);
    const prior = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (prior && !prior.isFile()) throw new Error('Invalid Hermes master file');
    // Match the existing bisync exclusion for local Hermes atomic writes.
    const staging = await mkdtemp(join(parent, '.tmp-'));
    const temporary = join(staging, 'write.tmp');
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx', signal });
      signal.throwIfAborted();
      await rename(temporary, path);
    } finally { await rm(staging, { recursive: true, force: true }); }
  };
  return {
    async loadSnapshot(source: SavedSnapshot, signal: AbortSignal) {
      if (source.owner !== bucket || !/^[a-z0-9]{8,24}$/.test(source.sessionId) || !hexDigest.test(source.snapshotId)) {
        throw new Error('Invalid Hermes saved snapshot');
      }
      const prefix = `${memoryRoot}Sessions/${source.sessionId}/`;
      const object = await read(`${prefix}baseline.json`, signal);
      if (!object) return { baseline: null, files: mapFiles(() => Buffer.alloc(0)) };
      const baseline = parseHermesBaseline(object);
      const active = {} as Store<Uint8Array>;
      for (const file of files) {
        const saved = await read(prefix + file, signal);
        if (!saved) throw new Error('Incomplete Hermes snapshot');
        active[file] = saved;
      }
      if (hermesSnapshotDigest(baseline, active) !== source.snapshotId) throw new Error('Saved Hermes snapshot changed');
      return { baseline, files: active };
    },
    async readMaster(file: File, signal: AbortSignal) {
      const key = masterKey(file);
      const bytes = await read(key, signal);
      await saveLocalMaster(key, bytes ?? Buffer.alloc(0), signal);
      return bytes;
    },
    async writeMaster(file: File, body: Uint8Array, signal: AbortSignal) {
      const key = masterKey(file);
      await saveLocalMaster(key, body, signal);
      await run(['rcat', remote + key, '--size', String(body.byteLength), '--s3-no-head'], signal, 0, body);
    },
    readProfile(file: 'settings.json' | 'auth.json', signal: AbortSignal) {
      return read(`.pi/agent/${file}`, signal, 1024 * 1024);
    },
  };
}
