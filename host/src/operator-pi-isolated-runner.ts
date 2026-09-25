import path from 'node:path';
import { constants } from 'node:fs';
import { mkdir, readFile, realpath, lstat, open, link, rm, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { boundedOperatorOutput, createIsolatedPiTools, type IsolatedPiInitialization,
  type IsolatedToolSdk } from './operator-pi-isolated.js';

interface PiAgentSession {
  readonly sessionId: string;
  readonly sessionFile?: string;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
}
interface PiSdk extends IsolatedToolSdk {
  SessionManager: { create(cwd: string, sessionDir: string): unknown };
  createAgentSession(options: object): Promise<{ session: PiAgentSession }>;
}
async function publishApprovedOutputs(cwd: string, outputRoot: string,
  initialization: IsolatedPiInitialization, signal: AbortSignal): Promise<void> {
  if (!path.isAbsolute(outputRoot) || path.resolve(outputRoot) !== outputRoot) {
    throw new Error('Approved reviewer output unavailable');
  }
  const info = await lstat(outputRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(outputRoot) !== outputRoot) {
    throw new Error('Approved reviewer output unavailable');
  }
  const directory = path.join(outputRoot, 'reports');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const reports = await lstat(directory);
  if (!reports.isDirectory() || reports.isSymbolicLink() || await realpath(directory) !== directory) {
    throw new Error('Approved reviewer output unavailable');
  }
  for (const task of initialization.tasks) {
    signal.throwIfAborted();
    const source = path.join(cwd, task.output);
    const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let encoded: Buffer;
    try {
      const file = await handle.stat();
      if (!file.isFile() || file.size < 1 || file.size > 64 * 1024) throw new Error('Approved reviewer report unavailable');
      encoded = await handle.readFile();
      boundedOperatorOutput(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(encoded));
    } finally { await handle.close(); }
    const destination = path.join(outputRoot, task.output);
    const temporary = path.join(directory, `.${path.basename(task.output)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, encoded, { flag: 'wx', mode: 0o600 });
      signal.throwIfAborted();
      try { await link(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await lstat(destination);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== encoded.length
          || await realpath(destination) !== destination || !(await readFile(destination)).equals(encoded)) {
          throw new Error('Approved reviewer report conflict');
        }
      }
    } finally { await rm(temporary, { force: true }); }
  }
  signal.throwIfAborted();
}

async function approvedReviewText(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > 1024 * 1024 || await realpath(file) !== file) {
      throw new Error('Approved reviewer resource unavailable');
    }
    const bytes = await handle.readFile();
    if (bytes.length !== info.size) throw new Error('Approved reviewer resource unavailable');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } finally { await handle.close(); }
}

async function createBoundChild(sdk: PiSdk, options: object, signal: AbortSignal): Promise<PiAgentSession> {
  signal.throwIfAborted();
  const pending = sdk.createAgentSession(options);
  let selected = false;
  void pending.then(async created => {
    if (signal.aborted && !selected && created.session) {
      try { await created.session.abort(); } catch { /* Destruction remains uncertain. */ }
      created.session.dispose();
    }
  }).catch(() => {});
  let onAbort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('Approved reviewer creation interrupted'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const created = await Promise.race([pending, interrupted]);
    selected = true;
    if (signal.aborted) {
      try { await created.session.abort(); } finally { created.session.dispose(); }
      signal.throwIfAborted();
    }
    return created.session;
  } finally { signal.removeEventListener('abort', onAbort); }
}

/** Installed package selects finite inert task descriptors; the Host supplies restricted SDK sessions. */
export async function runApprovedTasks(input: { sdk: PiSdk; base: Record<string, unknown>;
  cwd: string; sessionDir: string; outputRoot: string; taskId: string; deadline: number;
  initialization: IsolatedPiInitialization; signal: AbortSignal }): Promise<void> {
  if (!Number.isSafeInteger(input.deadline) || input.deadline <= Date.now()) {
    throw new Error('Approved reviewer authority expired');
  }
  const failed = new AbortController();
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.deadline - Date.now()), failed.signal]);
  const children: Array<{ task: IsolatedPiInitialization['tasks'][number]; session: PiAgentSession }> = [];
  const cancel = () => { for (const { session } of children) void session.abort().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const current = () => signal.throwIfAborted();
  try {
    current();
    // Persist intent before the first child is created. Even an orphaned child
    // cannot cause a replacement review on a recovered Host process.
    await mkdir(input.sessionDir, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(input.sessionDir);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
      || await realpath(input.sessionDir) !== input.sessionDir) throw Error('Approved child directory unavailable');
    const journal = path.join(input.sessionDir, 'approved-children.json');
    const intent = { schemaVersion: 1, taskId: input.taskId, initialization: input.initialization,
      children: [] as Array<{ taskId: string; sessionId: string; sessionFile: string }> };
    const initial = await open(journal, 'wx', 0o600);
    try { await initial.writeFile(JSON.stringify(intent)); await initial.sync(); }
    finally { await initial.close(); }
    for (const task of input.initialization.tasks) {
      current();
      const resource = await approvedReviewText(path.join(input.cwd, task.instruction));
      const directory = path.join(input.sessionDir, `approved-${task.id}`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const loader = input.base.resourceLoader as Record<string, unknown>;
      const session = await createBoundChild(input.sdk, { ...input.base,
        sessionManager: input.sdk.SessionManager.create(input.cwd, directory),
        resourceLoader: { ...loader, getSystemPrompt: () => `You are approved task ${task.id}. `
          + `Read only ${task.reads.join(', ')}. Write only ${task.output}. `
          + `Never call shell, network, publisher or candidate configuration.\n\n${resource}` },
        tools: ['read', 'write'],
        customTools: createIsolatedPiTools(input.sdk, input.cwd, input.initialization, task),
      }, signal);
      if (!session?.sessionId || !session.sessionFile || !/^[A-Za-z0-9_-]{1,128}$/.test(session.sessionId)
        || path.dirname(session.sessionFile) !== directory || path.extname(session.sessionFile) !== '.jsonl') {
        session?.dispose();
        throw new Error('Approved reviewer identity unavailable');
      }
      children.push({ task, session });
      intent.children.push({ taskId: task.id, sessionId: session.sessionId, sessionFile: session.sessionFile });
      const temporary = `${journal}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(intent)); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, journal);
      } finally { await rm(temporary, { force: true }); }
    }
    current();
    const outcomes = await Promise.allSettled(children.map(async ({ task, session }) => {
      current();
      let onAbort!: () => void;
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('Approved reviewer interrupted'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      try {
        current();
        // Pi's prompt promise resolves only after its run finishes, including retries.
        await Promise.race([session.prompt(`Execute the approved ${task.id} instructions at ${task.instruction}. `
          + `Read only the declared input paths and write your bounded result to ${task.output}.`), interrupted]);
        current();
        const outputFile = await open(path.join(input.cwd, task.output),
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const info = await outputFile.stat();
          if (!info.isFile() || info.size < 1 || info.size > 64 * 1024) {
            throw new Error('Approved reviewer report unavailable');
          }
          const output = await outputFile.readFile();
          if (output.length !== info.size) throw new Error('Approved reviewer report unavailable');
          boundedOperatorOutput(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(output));
        } finally { await outputFile.close(); }
      } catch (error) { failed.abort(); throw error; }
      finally { signal.removeEventListener('abort', onAbort); }
    }));
    current();
    if (outcomes.some(outcome => outcome.status === 'rejected')) throw new Error('Approved reviewer incomplete');
    await publishApprovedOutputs(input.cwd, input.outputRoot, input.initialization, signal);
    current();
  } finally {
    signal.removeEventListener('abort', cancel);
    if (signal.aborted) await Promise.allSettled(children.map(async ({ session }) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([session.abort(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Approved child abort uncertain')), 2_500);
      })]); }
      finally { if (timer) clearTimeout(timer); }
    }));
    for (const { session } of children) session.dispose();
  }
}
