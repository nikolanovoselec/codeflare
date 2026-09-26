import path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';

export interface IsolatedPiInitialization {
  schemaVersion: 1;
  profileId: string;
  contextPath: string;
  context: string;
  inputs: Array<{ kind: 'attachment' | 'resource'; reference: string; target: string }>;
  tasks: Array<{ id: string; instruction: string; reads: string[]; output: string }>;
}
const ID = /^[A-Za-z0-9_-]{1,128}$/;
function canonical(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !path.isAbsolute(value) && !/[\\%\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..'
      && !['__proto__', 'constructor', 'prototype'].includes(part));
}
function keys(value: unknown, names: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === names.sort().join(',');
}

/** Recheck the parent-bound finite filesystem descriptor at the Host process boundary. */
export function parseIsolatedPiInitialization(value: unknown): IsolatedPiInitialization {
  if (!keys(value, ['schemaVersion', 'profileId', 'contextPath', 'context', 'inputs', 'tasks'])
    || value.schemaVersion !== 1 || typeof value.profileId !== 'string' || !ID.test(value.profileId)
    || !canonical(value.contextPath) || !value.contextPath.includes('/')
    || typeof value.context !== 'string' || !value.context.length
    || Buffer.byteLength(value.context, 'utf8') > 4096
    || !Array.isArray(value.inputs) || value.inputs.length < 1 || value.inputs.length > 20
    || !Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 8) {
    throw Error('Invalid isolated Pi initialization');
  }
  const prefix = value.contextPath.split('/')[0];
  if (prefix === 'reports') throw Error('Invalid isolated Pi initialization');
  const readable = new Set([value.contextPath]);
  const instructions = new Set<string>();
  const inputKeys = new Set<string>();
  const inputs: IsolatedPiInitialization['inputs'] = [];
  for (const input of value.inputs) {
    if (!keys(input, ['kind', 'reference', 'target'])
      || input.kind !== 'attachment' && input.kind !== 'resource'
      || !canonical(input.reference) || !canonical(input.target)
      || !input.target.startsWith(`${prefix}/`) || readable.has(input.target)
      || inputKeys.has(`${input.kind}:${input.reference}`)) throw Error('Invalid isolated Pi input');
    readable.add(input.target);
    inputKeys.add(`${input.kind}:${input.reference}`);
    if (input.kind === 'resource') instructions.add(input.target);
    inputs.push({ kind: input.kind, reference: input.reference, target: input.target });
  }
  const ids = new Set<string>();
  const outputs = new Set<string>();
  const tasks: IsolatedPiInitialization['tasks'] = [];
  for (const task of value.tasks) {
    if (!keys(task, ['id', 'instruction', 'reads', 'output'])
      || typeof task.id !== 'string' || !ID.test(task.id) || ids.has(task.id)
      || !canonical(task.instruction) || !instructions.has(task.instruction)
      || !Array.isArray(task.reads) || task.reads.length < 1 || task.reads.length > 20
      || task.reads.some((read: unknown) => !canonical(read) || !readable.has(read))
      || new Set(task.reads).size !== task.reads.length
      || !task.reads.includes(value.contextPath) || !task.reads.includes(task.instruction)
      || !canonical(task.output) || !task.output.startsWith('reports/')
      || task.output.split('/').length !== 2 || readable.has(task.output) || outputs.has(task.output)) {
      throw Error('Invalid isolated Pi task');
    }
    ids.add(task.id); outputs.add(task.output);
    tasks.push({ id: task.id, instruction: task.instruction, reads: [...task.reads], output: task.output });
  }
  return { schemaVersion: 1, profileId: value.profileId, contextPath: value.contextPath,
    context: value.context, inputs, tasks };
}

interface ToolDefinition {
  name: string;
  execute(id: string, args: Record<string, unknown>, signal?: AbortSignal,
    onUpdate?: (result: unknown) => void, context?: unknown): Promise<unknown>;
  [key: string]: unknown;
}
export interface IsolatedToolSdk {
  createReadToolDefinition(cwd: string, options: { operations: {
    access(file: string): Promise<void>; readFile(file: string): Promise<Buffer>;
  } }): ToolDefinition;
  createWriteToolDefinition(cwd: string, options: { operations: {
    mkdir(directory: string): Promise<void>; writeFile(file: string, content: string): Promise<void>;
  } }): ToolDefinition;
}
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

export function boundedOperatorOutput(content: string): Buffer {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length < 1 || bytes.length > MAX_OUTPUT_BYTES
    || new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) !== content) {
    throw Error('Isolated Pi output invalid');
  }
  return bytes;
}

async function regularCanonicalFile(file: string): Promise<void> {
  const [resolved, info] = await Promise.all([realpath(file), lstat(file)]);
  if (resolved !== file || !info.isFile() || info.isSymbolicLink() || info.size > MAX_INPUT_BYTES) {
    throw Error('Isolated Pi read denied');
  }
}

/** The SDK receives only tools whose paths are fixed by the parent-approved descriptor. */
export function createIsolatedPiTools(sdk: IsolatedToolSdk, cwd: string,
  init: IsolatedPiInitialization, task?: IsolatedPiInitialization['tasks'][number]): ToolDefinition[] {
  const readable = task ? task.reads : [init.contextPath, ...init.inputs.map(input => input.target)];
  const readableAbsolute = new Set(readable.map(relative => path.join(cwd, relative)));
  const writable = new Set((task ? [task] : init.tasks).map(item => path.join(cwd, item.output)));
  const reportsDirectory = path.join(cwd, 'reports');
  const tails = new Map<string, Promise<void>>();
  const readDefinition = sdk.createReadToolDefinition(cwd, { operations: {
    async access(file) {
      if (!readableAbsolute.has(file)) throw Error('Isolated Pi read denied');
      await regularCanonicalFile(file);
    },
    async readFile(file) {
      if (!readableAbsolute.has(file)) throw Error('Isolated Pi read denied');
      await regularCanonicalFile(file);
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw Error('Isolated Pi read denied');
        const bytes = await handle.readFile();
        if (bytes.length !== info.size) throw Error('Isolated Pi read denied');
        return bytes;
      } finally { await handle.close(); }
    },
  } });
  const readExecute = readDefinition.execute.bind(readDefinition);
  readDefinition.execute = async (id, args, signal, onUpdate, context) => {
    if (!canonical(args.path) || !readable.includes(args.path)) throw Error('Isolated Pi read denied');
    return readExecute(id, args, signal, onUpdate, context);
  };
  const writeDefinition = sdk.createWriteToolDefinition(cwd, { operations: {
    async mkdir(directory) {
      if (directory !== reportsDirectory) throw Error('Isolated Pi write denied');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) {
        throw Error('Isolated Pi write denied');
      }
    },
    async writeFile(file, content) {
      if (!writable.has(file)) throw Error('Isolated Pi write denied');
      const bytes = boundedOperatorOutput(content);
      const previous = tails.get(file) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>(resolve => { release = resolve; });
      tails.set(file, current);
      await previous;
      try {
        try {
          const info = await lstat(file);
          if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes.length
            || await realpath(file) !== file || !(await readFile(file)).equals(bytes)) {
            throw Error('Isolated Pi output conflict');
          }
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const temporary = path.join(reportsDirectory, `.${path.basename(file)}.${randomUUID()}.tmp`);
        try {
          const handle = await open(temporary, 'wx', 0o600);
          try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
          try { await link(temporary, file); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const info = await lstat(file);
            if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes.length
              || await realpath(file) !== file || !(await readFile(file)).equals(bytes)) {
              throw Error('Isolated Pi output conflict');
            }
          }
        } finally { await rm(temporary, { force: true }); }
      } finally {
        release();
        if (tails.get(file) === current) tails.delete(file);
      }
    },
  } });
  const writeExecute = writeDefinition.execute.bind(writeDefinition);
  writeDefinition.execute = async (id, args, signal, onUpdate, context) => {
    if (!canonical(args.path) || !writable.has(path.join(cwd, args.path))
      || typeof args.content !== 'string') throw Error('Isolated Pi write denied');
    boundedOperatorOutput(args.content);
    return writeExecute(id, args, signal, onUpdate, context);
  };
  return [readDefinition, writeDefinition];
}
