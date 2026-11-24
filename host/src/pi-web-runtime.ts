import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createPiWebHandoff, type PiSurface, type PiSwitchStatus, type PiTranscript } from './pi-web-handoff.js';
import { createPiWebServices, managedPiPackage } from './pi-web-services.js';

interface NativeReceipt extends PiTranscript {
  generation: number;
  pid: number;
  startTime: string;
  instance: string;
  ticket?: string;
  idle: boolean;
  releaseReady?: string;
  released?: boolean;
  persisted?: boolean;
  header: { type: 'session'; id: string; cwd: string; timestamp: string; version: number };
}
interface WebStatus {
  sessionId: string;
  isStreaming: boolean;
  isCompacting: boolean;
  isBashRunning: boolean;
  pendingMessageCount: number;
  pendingDialogs?: unknown[];
  persisted: boolean;
}
const nativeId = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]{0,126}[a-zA-Z0-9])?$/;

function loadJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
function atomicWrite(path: string, data: string): void {
  const temp = `${path}.${randomUUID()}`;
  writeFileSync(temp, data, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}
function processMatches(receipt: NativeReceipt): boolean {
  try {
    const stat = readFileSync(`/proc/${receipt.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] !== 'Z' && fields[19] === receipt.startTime;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function createPiWebRuntime(options: {
  sessionId: string; generation: number; initialSurface: PiSurface; terminalMode: 'classic' | 'herdr';
  runtimeDir: string; cwd: string; home: string; cloneRestored: () => boolean;
}) {
  const { sessionId, generation, runtimeDir, cwd, home, initialSurface } = options;
  const services = createPiWebServices(options);
  const sessionDir = join(home, '.pi/agent/sessions', `--${cwd.slice(1).replace(/[/:]/g, '-')}--`);
  const bindingDir = join(home, '.codeflare', options.terminalMode, 'sessions', `cf-${sessionId}`);
  const bindingFile = join(bindingDir, 'agent-session-id');
  let binding: PiTranscript | undefined;
  let terminalTicket = initialSurface === 'terminal' ? 'initial' : undefined;
  let chatUrl: string | undefined;
  let chatReady = false;
  let boot: Promise<void> | undefined;
  let bootPhase: 'opening' | 'failed' | undefined = 'opening';
  let legacyHerdr = false;
  let releaseReceipt: NativeReceipt | undefined;
  let webRequestUnconfirmed = false;
  let closed = false;

  function validate(ref: PiTranscript): void {
    if (!nativeId.test(ref.id) || ref.cwd !== cwd || typeof ref.path !== 'string'
      || ref.path !== join(sessionDir, basename(ref.path)) || !basename(ref.path).endsWith(`_${ref.id}.jsonl`)) {
      throw new Error('Native Pi transcript identity is outside the workspace');
    }
    if (existsSync(ref.path) && (realpathSync(ref.path) !== ref.path || relative(realpathSync(sessionDir), ref.path).startsWith('..'))) {
      throw new Error('Native Pi transcript path changed');
    }
  }
  function receipt(surface: PiSurface): NativeReceipt | undefined {
    const value = loadJson<NativeReceipt>(join(runtimeDir, `${surface}.json`));
    if (!value || value.generation !== generation || !Number.isSafeInteger(value.pid) || value.pid <= 1
      || typeof value.startTime !== 'string' || typeof value.instance !== 'string'
      || surface === 'terminal' && value.ticket !== terminalTicket) return;
    validate(value);
    return value;
  }
  function publish(status: PiSwitchStatus): void {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    atomicWrite(join(runtimeDir, 'owner.json'), JSON.stringify({ ...status, generation, binding, terminalTicket }));
  }
  function save(ref: PiTranscript): void {
    validate(ref);
    binding = { id: ref.id, cwd: ref.cwd, path: ref.path };
    if (existsSync(ref.path)) {
      mkdirSync(bindingDir, { recursive: true, mode: 0o700 });
      atomicWrite(bindingFile, `${ref.id}\n`);
    }
  }
  async function until<T>(probe: () => T | undefined | Promise<T | undefined>, signal?: AbortSignal, timeout?: number): Promise<T> {
    const expires = timeout === undefined ? Infinity : Date.now() + timeout;
    while (!closed && Date.now() < expires) {
      signal?.throwIfAborted();
      const value = await probe();
      signal?.throwIfAborted();
      if (value !== undefined) return value;
      await sleep(150, undefined, { signal });
    }
    throw new Error('Native Pi writer could not be confirmed');
  }
  const cwdQuery = new URLSearchParams({ cwd });
  const statusPath = (id: string) => `/api/sessions/${encodeURIComponent(id)}/status?${cwdQuery}`;
  const idle = (status: WebStatus) => !status.isStreaming && !status.isCompacting && !status.isBashRunning
    && status.pendingMessageCount === 0 && !status.pendingDialogs?.length;

  async function webSettled(ref: PiTranscript): Promise<boolean> {
    // Stock 1.202611.5 does not expose an exact completion receipt for an
    // admitted prompt stalled in an async input hook. Neither status nor an
    // omitted ID in cleanup preview proves that operation has settled.
    if (webRequestUnconfirmed) throw new Error('A previous Chat operation has no transfer-safe settlement receipt');
    const status = await services.request<WebStatus>(statusPath(ref.id));
    return status.sessionId === ref.id && status.persisted && idle(status);
  }

  async function seedChat(): Promise<PiTranscript> {
    const sdk = await import(pathToFileURL(join(managedPiPackage(), 'dist/index.js')).href) as {
      SessionManager: { create(cwd: string, sessionDir: string): {
        getHeader(): NativeReceipt['header'] | null; getSessionFile(): string | undefined; getSessionId(): string;
      } };
    };
    const manager = sdk.SessionManager.create(cwd, sessionDir);
    const header = manager.getHeader();
    const path = manager.getSessionFile();
    const id = manager.getSessionId();
    if (!header || !path || header.id !== id || header.cwd !== cwd || header.type !== 'session') {
      throw new Error('Managed SDK did not create an exact native session header');
    }
    const ref = { id, cwd, path };
    validate(ref);
    // Make the known row discoverable before session_start runs. Only stock
    // pi-web will open a runtime for this file; this is not a second writer.
    writeFileSync(path, `${JSON.stringify(header)}\n`, { mode: 0o600, flag: 'wx' });
    return ref;
  }

  async function openChat(ref?: PiTranscript): Promise<void> {
    await services.start();
    let project = (await services.request<Array<{ path: string; id: string }>>('/api/projects')).find(row => row.path === cwd);
    project ??= await services.request('/api/projects', { path: cwd });
    if (!project || project.path !== cwd) throw new Error('Stock Chat project is unavailable');
    const { workspaces } = await services.request<{ workspaces: Array<{ path: string; id: string; isMain: boolean }> }>(
      `/api/projects/${encodeURIComponent(project.id)}/workspaces`);
    const workspace = workspaces.find(row => row.isMain && row.path === cwd);
    if (!workspace) throw new Error('Stock Chat workspace is unavailable');
    const target = ref ?? await seedChat();
    save(target);
    const state = handoff.status();
    publish({ ...state, phase: 'opening', target: 'chat' });
    chatUrl = `/api/pi-web/${sessionId}/?${new URLSearchParams({ project: project.id, workspace: workspace.id, session: target.id, view: 'chat' })}`;
    try {
      // The stock client opens the known row via its normal snapshot route.
      // Mount first: native session_start may park pending a browser answer.
      await until(() => {
        if (!services.running()) throw new Error('Stock Chat exited during startup');
        const observed = receipt('chat');
        return observed?.id === target.id && observed.path === target.path && !observed.released && processMatches(observed)
          ? true : undefined;
      });
      chatReady = true;
    } catch (error) {
      chatUrl = undefined;
      throw error;
    }
  }

  const handoff = createPiWebHandoff({ generation, initialSurface, onChange: publish,
    async waitForIdle(surface, signal) {
      releaseReceipt = await until(async () => {
        const observed = receipt(surface);
        if (!observed || observed.released || !observed.idle || !processMatches(observed)) return;
        if (surface === 'chat' && !await webSettled(observed)) {
          await sleep(750, undefined, { signal });
          return;
        }
        return observed;
      }, signal);
      // The extension must see the exact identity when it anchors the active
      // leaf and signals release readiness for this attempt.
      save(releaseReceipt);
    },
    async release(surface) {
      const source = releaseReceipt;
      const requestId = handoff.status().requestId;
      if (!source || !requestId) throw new Error('Missing outgoing Pi writer');
      const persisted = source.persisted === true || existsSync(source.path);
      const releasedBy = (observed: NativeReceipt | undefined) => observed?.pid === source.pid
        && observed.startTime === source.startTime && observed.instance === source.instance
        && observed.id === source.id && observed.path === source.path && observed.releaseReady === requestId;
      if (surface === 'chat') {
        await until(() => releasedBy(receipt('chat')) ? true : undefined, undefined, 15_000);
        if (!await webSettled(source) || !receipt('chat')?.idle) {
          throw new Error('Chat writer is not settled');
        }
        const result = await services.request<{ stopped: boolean }>(`/api/sessions/${encodeURIComponent(source.id)}/stop`, { cwd });
        const after = receipt('chat');
        if (!result.stopped || !releasedBy(after) || !after?.released
          || (await services.request<{activeSessions: number}>('/api/sessiond/health')).activeSessions !== 0) {
          throw new Error('Chat writer did not release its transcript');
        }
        chatReady = false;
        chatUrl = undefined;
      } else {
        await until(() => {
          const after = receipt('terminal');
          return releasedBy(after) && after?.released && !processMatches(source) ? true : undefined;
        }, undefined, 15_000);
      }
      validate(source);
      if (!existsSync(source.path)) {
        if (persisted || source.header?.type !== 'session' || source.header.id !== source.id || source.header.cwd !== cwd) {
          throw new Error('Expected Pi transcript is unavailable');
        }
        mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
        writeFileSync(source.path, `${JSON.stringify(source.header)}\n`, { mode: 0o600, flag: 'wx' });
      }
      save(source);
      return binding!;
    },
    confirmOpen(surface, ref) {
      if (closed || surface !== 'terminal') return false;
      const next = receipt('terminal');
      return !!next && next.id === ref.id && next.path === ref.path && !next.released && processMatches(next);
    },
    async open(surface, ref) {
      if (closed) return false;
      if (surface === 'chat') await openChat(ref);
      else {
        terminalTicket = randomUUID();
        publish(handoff.status());
        await until(() => {
          const next = receipt('terminal');
          return next?.id === ref.id && next.path === ref.path && !next.released && processMatches(next) ? true : undefined;
        }, undefined, 20_000);
      }
      return true;
    },
  });

  function restoredTranscript(): PiTranscript | undefined {
    if (!existsSync(bindingFile)) return;
    const id = readFileSync(bindingFile, 'utf8').trim();
    if (!nativeId.test(id) || !existsSync(sessionDir)) throw new Error('Saved Pi transcript is unavailable');
    const matches = readdirSync(sessionDir).filter(file => file.endsWith(`_${id}.jsonl`));
    if (matches.length !== 1) throw new Error('Saved Pi transcript is unavailable');
    const ref = { id, cwd, path: join(sessionDir, matches[0]) };
    validate(ref);
    return ref;
  }

  return {
    handoff,
    get binding() { return binding; },
    get ready() { return chatReady && !closed; },
    get opening() { return chatUrl !== undefined && !chatReady && !closed; },
    get generation() { return generation; },
    get legacyHerdr() { return legacyHerdr; },
    get cwd() { return cwd; },
    markWebRequestUnconfirmed() { webRequestUnconfirmed = true; },
    status() {
      const state = handoff.status();
      if (legacyHerdr) return { ...state, phase: 'failed' as const, surface: 'terminal' as const };
      // Keep the outgoing frame visible while answering a question or draining.
      return { ...state, ...(bootPhase && { phase: bootPhase }),
        ...(chatUrl !== undefined && (state.surface === 'chat' || state.target === 'chat' && state.phase === 'opening') && { chatUrl }) };
    },
    initialize() {
      boot ??= (async () => {
        bootPhase = 'opening';
        await until(() => options.cloneRestored() ? true : undefined, undefined, 120_000);
        if (options.terminalMode === 'herdr') {
          const marker = join(runtimeDir, 'legacy-herdr');
          legacyHerdr = existsSync(marker) && readFileSync(marker, 'utf8').trim() === String(generation);
          if (legacyHerdr) return;
        }
        binding = restoredTranscript();
        publish(handoff.status());
        if (initialSurface === 'chat') await openChat(binding);
        publish(handoff.status());
        bootPhase = undefined;
      })().catch(error => { bootPhase = 'failed'; throw error; });
      return boot;
    },
    async close() {
      closed = true;
      releaseReceipt = undefined;
      await services.close();
    },
  };
}

export type PiWebRuntime = ReturnType<typeof createPiWebRuntime>;
