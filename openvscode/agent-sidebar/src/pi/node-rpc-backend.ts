import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { Backend } from '../backend.ts';
import type { ApprovalBridge, PiExtensionUiRequest } from './approval-bridge.ts';
import { PiProtocolError, StrictPiJsonlTransport, type PiRpcEnvelope } from './rpc-client.ts';
import { PiSession, type PiChildProcess, type PiProcessSpawner, type PiSpawnSpec } from './session.ts';

const TERM_GRACE_MS = 2_000;

export interface PiRpcSink {
  output(text: string): void;
  reset(): void;
  failed(reason: string): void;
}

export class NodePiProcessSpawner implements PiProcessSpawner {
  spawn(spec: PiSpawnSpec): PiChildProcess {
    return new NodePiChild(spec);
  }
}

class NodePiChild implements PiChildProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #exit: Promise<void>;
  exited = false;

  constructor(spec: PiSpawnSpec) {
    this.#child = spawn(spec.executable, [...spec.args], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#exit = new Promise((resolveExit, reject) => {
      this.#child.once('error', reject);
      this.#child.once('close', () => {
        this.exited = true;
        resolveExit();
      });
    });
  }

  write(line: string): void {
    if (this.exited || this.#child.stdin.destroyed) throw new Error('Pi RPC process is not writable');
    this.#child.stdin.write(line, 'utf8');
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

export class PiRpcBackend implements Backend {
  readonly kind = 'pi' as const;
  readonly #session: PiSession;
  readonly #approvalBridge: ApprovalBridge;
  readonly #sink: PiRpcSink;
  #transport = createTransport();
  #detach: Array<() => void> = [];
  #eventTail = Promise.resolve();
  running = false;

  constructor(spawner: PiProcessSpawner, approvalBridge: ApprovalBridge, sink: PiRpcSink) {
    this.#session = new PiSession(spawner);
    this.#approvalBridge = approvalBridge;
    this.#sink = sink;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.#transport = createTransport();
    const child = await this.#session.resolveVisible();
    if (!child.onStdout || !child.onStderr || !child.onExit) throw new Error('Pi RPC process does not expose strict stdio');
    this.#detach = [
      child.onStdout((data) => this.#accept(data)),
      child.onStderr((data) => this.#sink.output(data)),
      child.onExit(() => this.#handleExit()),
    ];
    this.running = true;
  }

  async prompt(message: string): Promise<void> {
    await this.start();
    await this.#session.sendPrompt(message, (id) => this.#transport.registerRequest(id));
  }

  async abort(): Promise<void> {
    if (!this.running) return;
    await this.#session.abort((id) => this.#transport.registerRequest(id));
  }

  async cycleModel(): Promise<void> {
    await this.start();
    await this.#session.cycleModel((id) => this.#transport.registerRequest(id));
  }

  async cycleThinkingLevel(): Promise<void> {
    await this.start();
    await this.#session.cycleThinkingLevel((id) => this.#transport.registerRequest(id));
  }

  async newConversation(): Promise<void> {
    await this.stop();
    this.#sink.reset();
    await this.start();
  }

  async stop(): Promise<void> {
    const wasRunning = this.running;
    this.running = false;
    for (const detach of this.#detach.splice(0)) detach();
    if (wasRunning) this.#transport.markExited();
    await this.#session.dispose();
  }

  #accept(data: Uint8Array): void {
    if (!this.running) return;
    let envelopes: readonly PiRpcEnvelope[];
    try {
      envelopes = this.#transport.feed(data);
    } catch (error) {
      this.#protocolFailure(error);
      return;
    }
    for (const envelope of envelopes) {
      this.#eventTail = this.#eventTail.then(() => this.#handleEnvelope(envelope)).catch((error: unknown) => {
        this.#protocolFailure(error);
      });
    }
  }

  async #handleEnvelope(envelope: PiRpcEnvelope): Promise<void> {
    if (envelope.type === 'extension_ui_request') {
      const response = await this.#approvalBridge.handlePiRequest(envelope as unknown as PiExtensionUiRequest);
      if (this.running) {
        await this.#session.writeEnvelope(response as unknown as Readonly<Record<string, unknown>>);
      }
      return;
    }
    const text = textFromEnvelope(envelope);
    if (text) this.#sink.output(text);
  }

  #handleExit(): void {
    if (!this.running) return;
    this.running = false;
    this.#transport.markExited();
    for (const detach of this.#detach.splice(0)) detach();
    this.#sink.failed('Pi RPC process exited.');
  }

  #protocolFailure(error: unknown): void {
    const reason = error instanceof PiProtocolError ? error.code : 'RPC processing failed';
    this.#sink.failed(reason);
    void this.stop().catch(() => undefined);
  }
}

function createTransport(): StrictPiJsonlTransport {
  return new StrictPiJsonlTransport({
    maxLineBytes: 4 * 1024 * 1024,
    maxBufferBytes: 4 * 1024 * 1024,
    maxPendingRequests: 32,
  });
}

function textFromEnvelope(envelope: PiRpcEnvelope): string | undefined {
  if (typeof envelope.message === 'string') return envelope.message;
  if (typeof envelope.text === 'string') return envelope.text;
  const assistantEvent = envelope.assistantMessageEvent;
  if (isRecord(assistantEvent)) {
    if (typeof assistantEvent.delta === 'string') return assistantEvent.delta;
    if (typeof assistantEvent.text === 'string') return assistantEvent.text;
  }
  if (envelope.type === 'response' && envelope.success === true && isRecord(envelope.data)) {
    const model = envelope.data.model;
    const thinking = envelope.data.thinkingLevel;
    if (isRecord(model) && typeof model.id === 'string') {
      return `\nModel: ${model.id}${typeof thinking === 'string' ? ` (${thinking})` : ''}\n`;
    }
    if (envelope.command === 'cycle_thinking_level' && typeof thinking === 'string') {
      return `\nThinking: ${thinking}\n`;
    }
  }
  if (envelope.type === 'tool_execution_start' && typeof envelope.toolName === 'string') {
    return `\nRunning ${envelope.toolName}…\n`;
  }
  if (envelope.type === 'tool_execution_end' && envelope.isError === true) {
    return '\nTool execution failed.\n';
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
