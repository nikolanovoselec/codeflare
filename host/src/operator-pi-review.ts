/**
 * Fixed filesystem authority for the parent-authored Review Pi mode.
 * The model receives only these two overridden SDK tools; it cannot widen the
 * restored input set or choose another output path.
 */
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface OperatorPiReviewConfig {
  packetDigest: string;
  head: string;
  generation: number;
}

interface ToolDefinition {
  name: string;
  execute(toolCallId: string, arguments_: Record<string, unknown>, signal?: AbortSignal,
    onUpdate?: (result: unknown) => void, context?: unknown): Promise<unknown>;
  [key: string]: unknown;
}

export interface ReviewToolSdk {
  createReadToolDefinition(cwd: string, options: { operations: {
    access(absolutePath: string): Promise<void>;
    readFile(absolutePath: string): Promise<Buffer>;
  } }): ToolDefinition;
  createWriteToolDefinition(cwd: string, options: { operations: {
    mkdir(directory: string): Promise<void>;
    writeFile(absolutePath: string, content: string): Promise<void>;
  } }): ToolDefinition;
}

const LANES = ['code-reviewer', 'spec-reviewer', 'doc-updater'] as const;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_BYTES = 64 * 1024;

function safeRelative(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 1024
    && !path.isAbsolute(candidate) && !candidate.includes('\\') && !/[\x00-\x1f\x7f]/.test(candidate)
    && candidate.split('/').every(part => part !== '' && part !== '.' && part !== '..')
    && path.posix.normalize(candidate) === candidate;
}

async function regularCanonicalFile(absolutePath: string, maximum: number, message: string): Promise<void> {
  try {
    const [resolved, info] = await Promise.all([realpath(absolutePath), lstat(absolutePath)]);
    if (resolved !== absolutePath || !info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error(message);
  } catch {
    throw new Error(message);
  }
}

function reportBytes(content: string, lane: typeof LANES[number], review: OperatorPiReviewConfig): Buffer {
  const encoded = Buffer.from(content, 'utf8');
  let decoded = '';
  try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(encoded); }
  catch { throw new Error('Review report invalid'); }
  if (encoded.byteLength === 0 || encoded.byteLength > MAX_REPORT_BYTES || decoded !== content) {
    throw new Error('Review report invalid');
  }
  let value: unknown;
  try { value = JSON.parse(decoded); } catch { throw new Error('Review report invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Review report invalid');
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.lane !== lane || record.packetDigest !== review.packetDigest
    || record.head !== review.head || record.generation !== review.generation) {
    throw new Error('Review report invalid');
  }
  return encoded;
}

function serializeMutations() {
  const tails = new Map<string, Promise<void>>();
  return async <T>(destination: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tails.get(destination) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    tails.set(destination, current);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (tails.get(destination) === current) tails.delete(destination);
    }
  };
}

/** Build the only tools installed for Review mode, using the pinned SDK's own definitions. */
export function createOperatorPiReviewTools(sdk: ReviewToolSdk, cwd: string,
  review: OperatorPiReviewConfig): ToolDefinition[] {
  const readable = [
    'review/input.json',
    ...LANES.map(lane => `review/packets/${lane}.json`),
    'review/resources/parent.md',
    ...LANES.map(lane => `review/resources/${lane}.md`),
  ];
  const readableAbsolute = new Set(readable.map(relative => path.join(cwd, relative)));
  const writable = new Map(LANES.map(lane => [path.join(cwd, `reports/${lane}.json`), lane] as const));
  const reportsDirectory = path.join(cwd, 'reports');
  const mutate = serializeMutations();

  const assertRead = (absolutePath: string): void => {
    if (!readableAbsolute.has(absolutePath)) throw new Error('Review read denied');
  };
  const readDefinition = sdk.createReadToolDefinition(cwd, { operations: {
    async access(absolutePath) {
      assertRead(absolutePath);
      await regularCanonicalFile(absolutePath, MAX_INPUT_BYTES, 'Review read denied');
    },
    async readFile(absolutePath) {
      assertRead(absolutePath);
      await regularCanonicalFile(absolutePath, MAX_INPUT_BYTES, 'Review read denied');
      let handle;
      try {
        handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw new Error('Review read denied');
        return await handle.readFile();
      } catch {
        throw new Error('Review read denied');
      } finally { await handle?.close(); }
    },
  } });
  const readExecute = readDefinition.execute.bind(readDefinition);
  readDefinition.execute = async (toolCallId, arguments_, signal, onUpdate, context) => {
    if (!safeRelative(arguments_.path) || !readable.includes(arguments_.path)) throw new Error('Review read denied');
    return readExecute(toolCallId, arguments_, signal, onUpdate, context);
  };

  const writeDefinition = sdk.createWriteToolDefinition(cwd, { operations: {
    async mkdir(directory) {
      if (directory !== reportsDirectory) throw new Error('Review write denied');
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Review write denied'); }
      try {
        const [resolved, info] = await Promise.all([realpath(directory), lstat(directory)]);
        if (resolved !== directory || !info.isDirectory() || info.isSymbolicLink()) throw new Error('Review write denied');
      } catch { throw new Error('Review write denied'); }
    },
    async writeFile(absolutePath, content) {
      const lane = writable.get(absolutePath);
      if (!lane) throw new Error('Review write denied');
      const encoded = reportBytes(content, lane, review);
      await mutate(absolutePath, async () => {
        try {
          const existing = await lstat(absolutePath);
          if (!existing.isFile() || existing.isSymbolicLink() || existing.size > MAX_REPORT_BYTES
            || await realpath(absolutePath) !== absolutePath) throw new Error('Review write denied');
          const current = await readFile(absolutePath);
          if (current.equals(encoded)) return;
          throw new Error('Review report conflict');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }

        const temporary = path.join(reportsDirectory, `.${path.basename(absolutePath)}.${randomUUID()}.tmp`);
        let handle;
        try {
          handle = await open(temporary, 'wx', 0o600);
          await handle.writeFile(encoded);
          await handle.sync();
          await handle.close();
          handle = undefined;
          try { await link(temporary, absolutePath); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const existing = await lstat(absolutePath);
            if (!existing.isFile() || existing.isSymbolicLink() || existing.size > MAX_REPORT_BYTES
              || await realpath(absolutePath) !== absolutePath) throw new Error('Review write denied');
            const current = await readFile(absolutePath);
            if (!current.equals(encoded)) throw new Error('Review report conflict');
          }
        } finally {
          await handle?.close();
          await rm(temporary, { force: true });
        }
      });
    },
  } });
  const writeExecute = writeDefinition.execute.bind(writeDefinition);
  writeDefinition.execute = async (toolCallId, arguments_, signal, onUpdate, context) => {
    if (!safeRelative(arguments_.path) || typeof arguments_.content !== 'string'
      || !LANES.some(lane => arguments_.path === `reports/${lane}.json`)) {
      throw new Error('Review write denied');
    }
    const lane = arguments_.path.slice('reports/'.length, -'.json'.length) as typeof LANES[number];
    reportBytes(arguments_.content, lane, review);
    return writeExecute(toolCallId, arguments_, signal, onUpdate, context);
  };

  return [readDefinition, writeDefinition];
}
