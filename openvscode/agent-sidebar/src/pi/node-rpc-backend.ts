import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ApprovalBridge, PiExtensionUiRequest } from './approval-bridge.ts';
import { PiProtocolError, StrictPiJsonlTransport, type PiRpcEnvelope } from './rpc-client.ts';
import { PiSession, type PiChildProcess, type PiProcessSpawner, type PiSpawnSpec } from './session.ts';

const TERM_GRACE_MS = 2_000;

export interface PiTurnObserver {
  markdown(value: string): void;
  progress(value: string): void;
}

interface ActiveTurn {
  promptId: string | undefined;
  accepted: boolean;
  settled: boolean;
  completed: boolean;
  readonly observer: PiTurnObserver;
  readonly cancellation: AbortController;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export class NodePiProcessSpawner implements PiProcessSpawner {
  spawn(spec: PiSpawnSpec): PiChildProcess {
    return new NodePiChild(spec);
  }
}

class NodePiChild implements PiChildProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #exit: Promise<void>;
  readonly #spawnReady: Promise<void>;
  #stdinError: Error | undefined;
  exited = false;

  constructor(spec: PiSpawnSpec) {
    this.#child = spawn(spec.executable, [...spec.args], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let resolveExit = (): void => undefined;
    this.#exit = new Promise<void>((resolve) => { resolveExit = resolve; });
    this.#spawnReady = new Promise<void>((resolveSpawn, rejectSpawn) => {
      this.#child.once('spawn', resolveSpawn);
      this.#child.once('error', (error) => {
        this.exited = true;
        rejectSpawn(error);
        resolveExit();
      });
    });
    this.#child.once('close', () => {
      this.exited = true;
      resolveExit();
    });
    this.#child.stdin.on('error', (error) => {
      this.#stdinError = error;
      this.#child.kill('SIGTERM');
    });
  }

  async write(line: string): Promise<void> {
    if (this.exited || this.#child.stdin.destroyed || this.#stdinError) {
      throw this.#stdinError ?? new Error('Pi RPC process is not writable');
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      this.#child.stdin.write(line, 'utf8', (error) => {
        if (error) rejectWrite(error);
        else resolveWrite();
      });
    });
    if (this.#stdinError) throw this.#stdinError;
  }

  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void {
    if (this.exited) return;
    const pid = this.#child.pid;
    if (pid) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Fall through to the direct child if the process group already changed.
      }
    }
    this.#child.kill(signal);
  }

  async waitForSpawn(signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await this.#spawnReady;
      return;
    }
    if (signal.aborted) throw new Error('Pi RPC startup cancelled');
    let onAbort = (): void => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('Pi RPC startup cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([this.#spawnReady, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async waitForExit(): Promise<void> {
    if (this.exited) return;
    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      this.#exit.then(() => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), TERM_GRACE_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!exited) {
      this.signal('SIGKILL');
      await this.#exit;
    }
  }

  onStdout(listener: (data: Uint8Array) => void): () => void {
    this.#child.stdout.on('data', listener);
    return () => this.#child.stdout.off('data', listener);
  }

  onStderr(listener: (data: string) => void): () => void {
    const wrapped = (data: Buffer): void => listener(data.toString('utf8'));
    this.#child.stderr.on('data', wrapped);
    return () => this.#child.stderr.off('data', wrapped);
  }

  onExit(listener: () => void): () => void {
    if (this.exited) {
      queueMicrotask(listener);
      return () => undefined;
    }
    this.#child.once('close', listener);
    return () => this.#child.off('close', listener);
  }
}

export class PiRpcBackend {
  readonly #session: PiSession;
  readonly #approvalBridge: ApprovalBridge;
  #transport = createTransport();
  #detach: Array<() => void> = [];
  #eventTail = Promise.resolve();
  #generation = 0;
  #turn: ActiveTurn | undefined;
  #promptWrite: Promise<void> | undefined;
  #abortRequested = false;
  #abortSent = false;
  #stopRequested = false;
  #starting = false;
  readonly #startupCancellation = new AbortController();
  running = false;

  constructor(spawner: PiProcessSpawner, approvalBridge: ApprovalBridge) {
    this.#session = new PiSession(spawner);
    this.#approvalBridge = approvalBridge;
  }

  async #start(): Promise<void> {
    if (this.running) return;
    if (this.#stopRequested) throw new Error('Pi RPC process stopped');
    if (this.#abortRequested) throw new Error('Pi RPC startup cancelled');
    const generation = ++this.#generation;
    this.#transport = createTransport();
    this.#starting = true;
    try {
      const child = await this.#session.resolveVisible();
      await child.waitForSpawn?.(this.#startupCancellation.signal);
      if (this.#stopRequested || generation !== this.#generation) {
        throw new Error('Pi RPC process stopped');
      }
      if (this.#abortRequested) throw new Error('Pi RPC startup cancelled');
      if (!child.onStdout || !child.onStderr || !child.onExit) {
        throw new Error('Pi RPC process does not expose strict stdio');
      }
      this.#eventTail = Promise.resolve();
      this.running = true;
      this.#detach = [
        child.onStdout((data) => this.#accept(data, generation)),
        child.onStderr(() => undefined),
        child.onExit(() => this.#handleExit(child, generation)),
      ];
    } catch (error) {
      await this.#session.dispose().catch(() => undefined);
      if (this.#stopRequested || generation !== this.#generation) {
        throw new Error('Pi RPC process stopped');
      }
      throw error;
    } finally {
      this.#starting = false;
    }
  }

  async runPrompt(message: string, observer: PiTurnObserver): Promise<void> {
    if (this.#turn) throw new Error('Pi RPC turn is already active');
    let resolveTurn = (): void => undefined;
    let rejectTurn = (_error: Error): void => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    void promise.catch(() => undefined);
    const turn: ActiveTurn = {
      promptId: undefined,
      accepted: false,
      settled: false,
      completed: false,
      observer,
      cancellation: new AbortController(),
      promise,
      resolve: resolveTurn,
      reject: rejectTurn,
    };
    this.#turn = turn;
    try {
      await this.#start();
      if (this.#abortRequested) {
        turn.completed = true;
        turn.resolve();
        return;
      }
      const promptWrite = this.#runWrite(() => this.#session.sendPrompt(message, (id) => {
        turn.promptId = id;
        this.#transport.registerRequest(id);
      }));
      this.#promptWrite = promptWrite;
      try {
        await promptWrite;
      } finally {
        if (this.#promptWrite === promptWrite) this.#promptWrite = undefined;
      }
      if (this.#abortRequested) await this.#sendAbort();
      await turn.promise;
      await this.#eventTail;
    } catch (error) {
      if (this.#abortRequested && !this.#stopRequested && !turn.completed && turn.promptId === undefined) {
        turn.completed = true;
        turn.resolve();
        return;
      }
      const failure = error instanceof Error ? error : new Error('Pi RPC request failed');
      this.#rejectTurn(failure);
      await turn.promise.catch(() => undefined);
      throw failure;
    } finally {
      if (this.#turn === turn) this.#turn = undefined;
    }
  }

  async abort(): Promise<void> {
    this.#abortRequested = true;
    this.#turn?.cancellation.abort();
    this.#startupCancellation.abort();
    if (this.#starting && !this.running) await this.#session.dispose();
    await this.#promptWrite?.catch(() => undefined);
    await this.#sendAbort();
    const turn = this.#turn;
    if (turn?.promptId && !turn.completed) {
      turn.completed = true;
      turn.resolve();
    }
  }

  async stop(): Promise<void> {
    this.#stopRequested = true;
    this.#turn?.cancellation.abort();
    this.#startupCancellation.abort();
    const wasRunning = this.running;
    this.running = false;
    this.#generation += 1;
    for (const detach of this.#detach.splice(0)) detach();
    if (wasRunning) this.#transport.markExited();
    this.#rejectTurn(new Error('Pi RPC process stopped'));
    await this.#session.dispose();
  }

  async #sendAbort(): Promise<void> {
    if (!this.running || this.#stopRequested || this.#abortSent) return;
    this.#abortSent = true;
    await this.#runWrite(() => this.#session.abort((id) => this.#transport.registerRequest(id)));
  }

  async #runWrite(operation: () => Promise<unknown>): Promise<void> {
    const generation = this.#generation;
    try {
      await operation();
    } catch (error) {
      this.#protocolFailure(error, generation);
      throw error;
    }
  }

  #accept(data: Uint8Array, generation: number): void {
    if (!this.running || generation !== this.#generation) return;
    let envelopes: readonly PiRpcEnvelope[];
    try {
      envelopes = this.#transport.feed(data);
    } catch (error) {
      this.#protocolFailure(error, generation);
      return;
    }
    for (const envelope of envelopes) {
      this.#eventTail = this.#eventTail.then(() => this.#handleEnvelope(envelope, generation)).catch((error: unknown) => {
        this.#protocolFailure(error, generation);
      });
    }
  }

  async #handleEnvelope(envelope: PiRpcEnvelope, generation: number): Promise<void> {
    if (!this.running || generation !== this.#generation) return;
    if (envelope.type === 'extension_ui_request') {
      const response = await this.#approvalBridge.handlePiRequest(
        envelope as unknown as PiExtensionUiRequest,
        this.#turn?.cancellation.signal,
      );
      if (response && this.running && generation === this.#generation) {
        await this.#session.writeEnvelope(response as unknown as Readonly<Record<string, unknown>>);
      }
      return;
    }
    const turn = this.#turn;
    if (turn) {
      if (
        envelope.type === 'response' &&
        envelope.id === turn.promptId &&
        envelope.command === 'prompt'
      ) {
        if (envelope.success !== true) {
          this.#rejectTurn(new Error('Pi RPC prompt was rejected'));
          return;
        }
        turn.accepted = true;
      } else if (envelope.type === 'agent_settled') {
        turn.settled = true;
      } else {
        const text = assistantTextDelta(envelope);
        if (text) turn.observer.markdown(text);
        if (envelope.type === 'tool_execution_start' && typeof envelope.toolName === 'string') {
          turn.observer.progress(`Running ${envelope.toolName}…`);
        }
      }
      this.#completeTurn();
      return;
    }
  }

  #handleExit(child: PiChildProcess, generation: number): void {
    if (!this.running || generation !== this.#generation) return;
    this.running = false;
    this.#transport.markExited();
    for (const detach of this.#detach.splice(0)) detach();
    this.#rejectTurn(new Error('Pi RPC process exited'));
    void this.#session.reapExitedProcess(child).catch(() => undefined);
  }

  #protocolFailure(error: unknown, generation: number): void {
    if (!this.running || generation !== this.#generation) return;
    const reason = error instanceof PiProtocolError ? error.code : 'RPC processing failed';
    this.#rejectTurn(error instanceof Error ? error : new Error(reason));
    void this.stop().catch(() => undefined);
  }

  #completeTurn(): void {
    const turn = this.#turn;
    if (!turn || turn.completed || !turn.accepted || !turn.settled) return;
    turn.completed = true;
    turn.resolve();
  }

  #rejectTurn(error: Error): void {
    const turn = this.#turn;
    if (!turn || turn.completed) return;
    turn.completed = true;
    turn.cancellation.abort();
    turn.reject(error);
  }
}

function createTransport(): StrictPiJsonlTransport {
  return new StrictPiJsonlTransport({
    maxLineBytes: 4 * 1024 * 1024,
    maxBufferBytes: 4 * 1024 * 1024,
    maxPendingRequests: 32,
  });
}

function assistantTextDelta(envelope: PiRpcEnvelope): string | undefined {
  if (envelope.type !== 'message_update' || !isRecord(envelope.assistantMessageEvent)) return undefined;
  const event = envelope.assistantMessageEvent;
  return event.type === 'text_delta' && typeof event.delta === 'string' ? event.delta : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
