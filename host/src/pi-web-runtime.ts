import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, watch, writeFileSync } from 'node:fs';
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
  stopRequested?: string;
  releaseReady?: string;
  released?: boolean;
  quit?: boolean;
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
const CHAT_ATTACH_TIMEOUT_MS = 25_000;
const STARTUP_QUESTION_ALLOWANCE_MS = 5 * 60_000; // Stock extension-dialog timeout.

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
function processMatches(receipt: Pick<NativeReceipt, 'pid' | 'startTime'>): boolean {
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
  runtimeDir: string; cwd: string; home: string; profileRestored: () => boolean; cloneRestored: () => boolean;
}) {
  const { sessionId, generation, runtimeDir, cwd, home, initialSurface } = options;
  const services = createPiWebServices(options);
  const sessionDir = join(home, '.pi/agent/sessions', `--${cwd.slice(1).replace(/[/:]/g, '-')}--`);
  const bindingDir = join(home, '.codeflare', options.terminalMode, 'sessions', `cf-${sessionId}`);
  const bindingFile = join(bindingDir, 'agent-session-id');
  let binding: PiTranscript | undefined;
  let terminalTicket = initialSurface === 'terminal' ? 'initial' : undefined;
  let chatUrl: string | undefined;
  let chatStartup: AbortController | undefined;
  let chatAttachDeadline: number | undefined;
  let chatReady = false;
  let chatCatalog: string | undefined;
  let boot: Promise<void> | undefined;
  let bootPhase: 'opening' | 'failed' | undefined = 'opening';
  let legacyHerdr = false;
  let releaseReceipt: NativeReceipt | undefined;
  let stopDeadline = 0;
  let webRequestUnconfirmed = false;
  let closing: Promise<void> | undefined;
  let wrapperWatch: ReturnType<typeof watch> | undefined;
  let rearmAttemptedFor: string | undefined;
  let rearming: Promise<PiSwitchStatus> | undefined;
  let retiring = false;
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

  async function abortChat(ref: PiTranscript): Promise<void> {
    try {
      const result = await services.request<{ aborted: boolean }>(`/api/sessions/${encodeURIComponent(ref.id)}/abort`, { cwd });
      if (result?.aborted !== true) throw new Error('Chat cancellation was not acknowledged');
    } catch (error) {
      webRequestUnconfirmed = true;
      throw error;
    }
  }

  async function webSettled(ref: PiTranscript, cancelNewActivity = false): Promise<boolean> {
    if (webRequestUnconfirmed) throw new Error('A previous Chat operation has no transfer-safe settlement receipt');
    if (!chatCatalog || binding?.id !== ref.id || binding.path !== ref.path || !services.running()) {
      throw new Error('Chat writer identity is unavailable');
    }
    const row = await services.request<{ id: string; cwd: string; archived: boolean; runtime: string }>(chatCatalog);
    if (row?.id !== ref.id || row.cwd !== cwd || row.archived !== false || !['busy', 'idle'].includes(row.runtime)) {
      throw new Error('Stock catalog did not confirm the exact hosted Chat writer');
    }
    const status = await services.request<WebStatus>(statusPath(ref.id));
    if (status.sessionId !== ref.id || status.persisted !== true) throw new Error('Stock Chat status changed identity');
    // Abort may acknowledge before an admitted input hook reaches streaming.
    // Apply native Abort again if that work becomes cancellable, but never
    // use the abort acknowledgment or ordinary idle status as release proof.
    if (cancelNewActivity && (status.isStreaming || status.isCompacting || status.isBashRunning || status.pendingMessageCount > 0)) {
      await abortChat(ref);
      return false;
    }
    return row.runtime === 'idle' && idle(status);
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

  function waitingOnStartupQuestion(ref: PiTranscript, requestId: string | undefined): boolean {
    if (!requestId) return false;
    try {
      const evidence = loadJson<PiTranscript & Pick<NativeReceipt, 'generation' | 'pid' | 'startTime'> & {
        requestId: string; waiting: boolean;
      }>(join(runtimeDir, 'chat-startup-question.json'));
      return evidence?.waiting === true && evidence.generation === generation && evidence.requestId === requestId
        && evidence.id === ref.id && evidence.path === ref.path && evidence.cwd === ref.cwd
        && Number.isSafeInteger(evidence.pid) && evidence.pid > 1 && processMatches(evidence);
    } catch { return false; }
  }

  async function openChat(ref: PiTranscript): Promise<boolean> {
    chatStartup = new AbortController();
    chatAttachDeadline = undefined;
    const requestId = handoff.status().requestId;
    let questionPauseStarted: number | undefined;
    let questionAllowance = STARTUP_QUESTION_ALLOWANCE_MS;
    try {
      await services.start();
      let project = (await services.request<Array<{ path: string; id: string }>>('/api/projects')).find(row => row.path === cwd);
      project ??= await services.request('/api/projects', { path: cwd });
      if (!project || project.path !== cwd) throw new Error('Stock Chat project is unavailable');
      const { workspaces } = await services.request<{ workspaces: Array<{ path: string; id: string; isMain: boolean }> }>(
        `/api/projects/${encodeURIComponent(project.id)}/workspaces`);
      const workspace = workspaces.find(row => row.isMain && row.path === cwd);
      if (!workspace) throw new Error('Stock Chat workspace is unavailable');
      save(ref);
      chatCatalog = `/api/plugin-catalog/projects/${encodeURIComponent(project.id)}/workspaces/${encodeURIComponent(workspace.id)}/sessions/${encodeURIComponent(ref.id)}`;
      chatUrl = `/api/pi-web/${sessionId}/g/${generation}/?${new URLSearchParams({ project: project.id, workspace: workspace.id, session: ref.id, view: 'chat' })}`;
      // The Ready screen may wait indefinitely for Open. Start the writer
      // confirmation budget only when the scoped browser frame attaches.
      await until(() => {
        if (!services.running()) throw new Error('Stock Chat exited during startup');
        const observed = receipt('chat');
        const writerConfirmed = observed?.id === ref.id && observed.path === ref.path && !observed.released && processMatches(observed);
        if (chatAttachDeadline !== undefined) {
          const now = Date.now();
          // Pi's UI notifications are best-effort. A real writer receipt
          // ends the pause even if the question-end notification was missed.
          const waiting = !writerConfirmed && questionAllowance > 0 && waitingOnStartupQuestion(ref, requestId);
          if (waiting && questionPauseStarted === undefined && now < chatAttachDeadline) questionPauseStarted = now;
          if (questionPauseStarted !== undefined) {
            const elapsed = now - questionPauseStarted;
            if (waiting && elapsed < questionAllowance) return undefined;
            const pause = Math.min(elapsed, questionAllowance);
            chatAttachDeadline += pause;
            questionAllowance -= pause;
            questionPauseStarted = undefined;
          }
          if (now >= chatAttachDeadline) throw new Error('Native Chat writer could not be confirmed');
        }
        return writerConfirmed ? true : undefined;
      }, chatStartup.signal);
      chatReady = true;
      return true;
    } catch {
      chatStartup.abort();
      // Close browser admission before joining both owned processes. No active
      // writer or pending startup dialog can survive a confirmed daemon exit.
      chatUrl = undefined;
      chatReady = false;
      chatCatalog = undefined;
      await services.reset(); // Throws into the coordinator's uncertain state if not confirmed.
      webRequestUnconfirmed = false;
      return false;
    }
  }

  function quitTerminal(observed: NativeReceipt): boolean {
    return observed.quit === true && observed.idle === true && !observed.released && !processMatches(observed);
  }

  function waitingWrapper(previous: NativeReceipt) {
    if (!previous.ticket || !quitTerminal(previous)) return;
    const wrapper = loadJson<Pick<NativeReceipt, 'generation' | 'pid' | 'startTime'> & { rearmTicket?: string }>(
      join(runtimeDir, 'wrapper.json'));
    if (wrapper && wrapper.generation === generation && wrapper.rearmTicket === previous.ticket
      && Number.isSafeInteger(wrapper.pid) && wrapper.pid > 1 && typeof wrapper.startTime === 'string' && processMatches(wrapper)) return wrapper;
  }

  async function rearmSelectedTerminal(): Promise<void> {
    if (retiring || closed || rearming || bootPhase !== undefined) return;
    const state = handoff.status();
    if (state.surface !== 'terminal' || !['active', 'complete', 'cancelled', 'failed'].includes(state.phase)) return;
    const previous = receipt('terminal');
    const wrapper = previous && waitingWrapper(previous);
    if (!wrapper) return;
    const registration = `${wrapper.rearmTicket}:${wrapper.pid}:${wrapper.startTime}`;
    if (rearmAttemptedFor === registration) return;
    rearmAttemptedFor = registration;
    rearming = handoff.switchTo({ generation, requestId: randomUUID(), target: 'terminal' }, true);
    try { await rearming; }
    finally { rearming = undefined; }
  }

  const handoff = createPiWebHandoff({ generation, initialSurface,
    // The HTTP fence closes now, but do not tell the Chat extension to anchor
    // its branch until all admitted answers and reads have actually drained.
    onChange: state => publish(state.phase === 'releasing' && state.surface === 'chat' ? { ...state, phase: 'stopping' } : state),
    async stopWork(surface) {
      stopDeadline = Date.now() + (retiring ? 8_000 : 45_000);
      if (surface === 'chat') {
        if (!binding || !chatReady) throw new Error('Chat writer is not ready');
        await abortChat(binding);
      } else {
        // A first native conversation (or an ordinary /resume) may have
        // assigned a new ID before the Host has read a binding from disk.
        const source = await until(() => {
          const observed = receipt('terminal');
          return observed && (quitTerminal(observed) || !observed.quit && !observed.released && processMatches(observed)) ? observed : undefined;
        }, undefined, retiring ? 3000 : 20_000);
        save(source);
        // The native extension issues Abort on this exact stopping ticket.
        publish(handoff.status());
      }
    },
    async waitForIdle(surface, signal) {
      const requestId = handoff.status().requestId;
      releaseReceipt = await until(async () => {
        const observed = receipt(surface);
        if (!observed) return;
        if (surface === 'terminal' && quitTerminal(observed)) return observed;
        if (observed.quit || observed.released || !processMatches(observed)) return;
        if (surface === 'terminal' && observed.stopRequested !== requestId) return;
        if (surface === 'chat' && !await webSettled(observed, true)) {
          await sleep(750, undefined, { signal });
          return;
        }
        return observed.idle ? observed : undefined;
      }, signal, Math.max(0, stopDeadline - Date.now()));
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
        if (!await webSettled(source)) return undefined;
        publish(handoff.status());
        await until(() => releasedBy(receipt('chat')) ? true : undefined, undefined, 15_000);
        if (!await webSettled(source) || !receipt('chat')?.idle) return undefined;
        const result = await services.request<{ stopped: boolean }>(`/api/sessions/${encodeURIComponent(source.id)}/stop`, { cwd });
        const after = receipt('chat');
        if (!result.stopped || !releasedBy(after) || !after?.released
          || (await services.request<{activeSessions: number}>('/api/sessiond/health')).activeSessions !== 0) {
          throw new Error('Chat writer did not release its transcript');
        }
        chatReady = false;
        chatUrl = undefined;
        chatCatalog = undefined;
      } else if (!quitTerminal(source)) {
        await until(() => {
          const after = receipt('terminal');
          return releasedBy(after) && after?.released && !processMatches(source) ? true : undefined;
        }, undefined, retiring ? 4000 : 15_000);
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
      if (closed || retiring) return false;
      if (surface === 'chat') return openChat(ref);
      const previous = receipt('terminal');
      const wrapper = previous?.quit === true ? waitingWrapper(previous) : undefined;
      if (previous?.quit === true && !wrapper) return false;
      const previousTicket = terminalTicket;
      const ticket = terminalTicket = randomUUID();
      const claim = join(runtimeDir, 'terminal-tickets', String(generation), ticket);
      function revokeUnclaimed(): boolean {
        if (!wrapper) return false;
        // The wrapper also uses exclusive creation for this path before
        // spawning Pi. Creating it here fences even a cached grant; an
        // existing claim is ambiguous and must never be removed or retried.
        try { writeFileSync(claim, 'revoked\n', { mode: 0o600, flag: 'wx' }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
          throw error;
        }
        terminalTicket = previousTicket;
        return true;
      }
      publish(handoff.status());
      try {
        return await until(() => {
          const next = receipt('terminal');
          if (next?.id === ref.id && next.path === ref.path && !next.released && processMatches(next)) return true;
          if (wrapper && (retiring || !processMatches(wrapper)) && revokeUnclaimed()) return false;
        }, undefined, 20_000);
      } catch (error) {
        if (revokeUnclaimed()) return false;
        throw error;
      }
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

  async function close(): Promise<void> {
    try {
      // close() has already fenced new registrations. If a re-entry was
      // accepted, join it before deciding which writer Stop must retire.
      await rearming;
      if (options.terminalMode === 'herdr' && !legacyHerdr && bootPhase === undefined) {
        const state = handoff.status();
        if (state.surface === 'terminal') {
          // Normal Stop uses the same native Abort and exact release evidence
          // as a switch, but never opens a replacement writer.
          const verdict = await handoff.switchTo({ generation, requestId: randomUUID(), target: 'chat' });
          if (verdict.surface !== null || verdict.phase !== 'failed') throw new Error('Managed Herdr Pi did not retire');
        } else if (state.surface !== 'chat') {
          throw new Error('Managed Herdr writer was not confirmed at shutdown');
        }
        // After ordinary quit the pane returns to the shell. The old Pi
        // reporter's role can disappear on Herdr's final exit observation.
        const lastTerminal = receipt('terminal');
        const parkedShell = lastTerminal && quitTerminal(lastTerminal) ? lastTerminal : undefined;
        const quitTime = parkedShell ? statSync(join(runtimeDir, 'terminal.json')).mtimeMs : undefined;
        // Herdr can acknowledge a report without storing its resume argv.
        // Require the unique saved role. Allow the wrapper's bounded reporter
        // transition and Herdr 0.9.5's five-second snapshot debounce.
        const snapshot = join(bindingDir, 'session.json');
        await until(() => {
          const wrapper = loadJson<{ generation: number; pane: string }>(join(runtimeDir, 'wrapper.json'));
          const original = wrapper?.generation === generation && typeof wrapper.pane === 'string'
            ? /^(.+):p([123456789ABCDEFGHJKMNPQRSTVWXYZ0]+)$/.exec(wrapper.pane) : null;
          if (!original) return;
          const [, workspaceId, encodedPane] = original;
          // Herdr 0.9.5 stores raw pane keys and a separate bijective base-32 public number map.
          const alphabet = '123456789ABCDEFGHJKMNPQRSTVWXYZ0';
          const paneNumber = [...encodedPane].reduce((number, char) => number * alphabet.length + alphabet.indexOf(char) + 1, 0);
          if (!Number.isSafeInteger(paneNumber)) return;
          if (parkedShell && quitTime !== undefined) {
            const parked = loadJson<NativeReceipt & { pane: string }>(join(runtimeDir, 'herdr-parked.json'));
            if (!parked || parked.pane !== wrapper?.pane
              || parked.generation !== generation || parked.ticket !== parkedShell.ticket || parked.pid !== parkedShell.pid
              || parked.startTime !== parkedShell.startTime || parked.instance !== parkedShell.instance || parked.path !== parkedShell.path
              || (statSync(snapshot, { throwIfNoEntry: false })?.mtimeMs ?? -1) < quitTime) return;
          }
          const saved = loadJson<{ version: number; workspaces: Array<{ id: string; public_pane_numbers: Record<string, number>;
            tabs: Array<{ panes: Record<string, { agent_resume?: { source?: string; agent?: string; argv?: string[] };
              agent_session?: { source?: string; agent?: string; kind?: string; value?: string } }> }> }> }>(snapshot);
          if (saved?.version !== 3) return;
          const roles = saved.workspaces.flatMap(workspace => workspace.tabs.flatMap(tab => Object.entries(tab.panes)
            .map(([raw, pane]) => ({ ...pane, original: workspace.id === workspaceId && workspace.public_pane_numbers?.[raw] === paneNumber }))))
            .filter(({ agent_resume: role, agent_session: session }) => {
              if (JSON.stringify(role?.argv) !== '["codeflare-terminal-writer","--tui-mode","fullscreen"]') return false;
              return role?.source === 'codeflare:terminal-writer' && role.agent === 'codeflare-terminal-writer'
                || !!binding && role?.source === 'herdr:pi' && role.agent === 'pi' && session?.source === 'herdr:pi'
                && session.agent === 'pi' && session.kind === 'path' && session.value === binding.path;
            });
          const [role] = roles;
          return roles.length === 1 && role.original && (!parkedShell
            || role.agent_resume?.source === 'codeflare:terminal-writer' && role.agent_session == null) ? true : undefined;
        }, undefined, 20_000).catch(() => { throw new Error('Herdr did not save the managed role in the original terminal pane'); });
      }
    } finally {
      closed = true;
      releaseReceipt = undefined;
      await services.close();
    }
  }

  return {
    handoff,
    get binding() { return binding; },
    get ready() { return chatReady && !closed; },
    get opening() { return chatUrl !== undefined && !chatReady && !closed; },
    get chatStartupSignal() { return chatStartup?.signal; },
    get generation() { return generation; },
    get legacyHerdr() { return legacyHerdr; },
    get cwd() { return cwd; },
    beginChatAttachment() { chatAttachDeadline ??= Date.now() + CHAT_ATTACH_TIMEOUT_MS; },
    markWebRequestUnconfirmed() { webRequestUnconfirmed = true; },
    status() {
      const state = handoff.status();
      if (legacyHerdr) return { ...state, phase: 'failed' as const, surface: 'terminal' as const };
      // Keep the outgoing frame visible while answering a question or draining.
      return { ...state, ...(bootPhase && { phase: bootPhase }),
        ...(binding && state.phase === 'opening' && state.target === 'chat'
          && waitingOnStartupQuestion(binding, state.requestId) && { startupQuestion: true }),
        ...(chatUrl !== undefined && (state.surface === 'chat' || state.target === 'chat' && state.phase === 'opening') && { chatUrl }) };
    },
    initialize() {
      boot ??= (async () => {
        bootPhase = 'opening';
        // Classic needs the restored Pi profile and transcripts, not the
        // background clone pass. Keep the legacy Herdr startup order.
        await until(() => options.profileRestored()
          && (options.terminalMode === 'classic' || options.cloneRestored()) ? true : undefined);
        if (options.terminalMode === 'herdr') {
          const marker = join(runtimeDir, 'legacy-herdr');
          legacyHerdr = existsSync(marker) && readFileSync(marker, 'utf8').trim() === String(generation);
          if (legacyHerdr) return;
        }
        binding = restoredTranscript();
        if (initialSurface === 'chat') {
          save(binding ?? await seedChat());
          bootPhase = undefined;
          await handoff.openInitialChat(randomUUID(), binding!);
        } else {
          publish(handoff.status());
          bootPhase = undefined;
        }
        if (retiring || closed) return;
        // Watch the private atomic registration, not browser status reads.
        wrapperWatch = watch(runtimeDir, { persistent: false }, (_, file) => {
          if (file === 'wrapper.json' || file === 'owner.json') void rearmSelectedTerminal().catch(() => {});
        });
        wrapperWatch.on('error', () => wrapperWatch?.close());
        await rearmSelectedTerminal();
      })().catch(error => { bootPhase = 'failed'; throw error; });
      return boot;
    },
    close() {
      retiring = true;
      if (!chatReady) chatStartup?.abort();
      wrapperWatch?.close();
      closing ??= close();
      return closing;
    },
  };
}

export type PiWebRuntime = ReturnType<typeof createPiWebRuntime>;
