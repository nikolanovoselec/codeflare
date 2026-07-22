import { execFileSync } from 'node:child_process';

import * as nodePty from 'node-pty';

import type { Backend } from '../backend.ts';
import {
  ClaudePtySession,
  type ClaudePtyProcess,
  type ClaudePtySpawner,
  type ClaudePtySpawnSpec,
  type TerminalSize,
} from './pty-session.ts';

const CONFIG_PREPARER = '/opt/codeflare/openvscode/claude/prepare-sidebar-config.sh';
const TERM_GRACE_MS = 2_000;
const DEFAULT_SIZE: TerminalSize = { columns: 80, rows: 24 };

export interface ClaudePtySink {
  output(data: string): void;
  reset(): void;
  failed(reason: string): void;
}

export class NodePtySpawner implements ClaudePtySpawner {
  spawn(spec: ClaudePtySpawnSpec): ClaudePtyProcess {
    prepareConfig();
    const process = nodePty.spawn(spec.executable, [...spec.args], {
      cwd: spec.cwd,
      env: mergeEnvironment(spec.env),
      name: spec.terminal.name,
      cols: spec.terminal.columns,
      rows: spec.terminal.rows,
    });
    return new ManagedNodePty(process);
  }
}

class ManagedNodePty implements ClaudePtyProcess {
  readonly #pty: nodePty.IPty;
  readonly #exit: Promise<void>;
  exited = false;

  constructor(pty: nodePty.IPty) {
    this.#pty = pty;
    this.#exit = new Promise((resolveExit) => {
      pty.onExit(() => {
        this.exited = true;
        resolveExit();
      });
    });
  }

  onData(listener: (data: string) => void): () => void {
    const disposable = this.#pty.onData(listener);
    return () => disposable.dispose();
  }

  onExit(listener: () => void): () => void {
    if (this.exited) {
      queueMicrotask(listener);
      return () => undefined;
    }
    const disposable = this.#pty.onExit(listener);
    return () => disposable.dispose();
  }

  write(data: string): void {
    if (this.exited) throw new Error('Claude PTY is not writable');
    this.#pty.write(data);
  }

  resize(columns: number, rows: number): void {
    if (this.exited) return;
    this.#pty.resize(columns, rows);
  }

  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (!this.exited) this.#pty.kill(signal);
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
      this.kill('SIGKILL');
      await this.#exit;
    }
  }
}

export class ClaudePtyBackend implements Backend {
  readonly kind = 'claude' as const;
  readonly #session: ClaudePtySession;
  readonly #sink: ClaudePtySink;
  #size = DEFAULT_SIZE;
  #detachExit: (() => void) | undefined;
  running = false;

  constructor(spawner: ClaudePtySpawner, sink: ClaudePtySink) {
    this.#sink = sink;
    this.#session = new ClaudePtySession(spawner, (data) => sink.output(data));
  }

  async start(): Promise<void> {
    if (this.running) return;
    try {
      const process = await this.#session.resolveVisible(this.#size);
      this.#detachExit = process.onExit?.(() => this.#handleExit());
      this.running = true;
    } catch (error) {
      this.#sink.failed(error instanceof Error ? error.message : 'Claude PTY failed to start');
      throw error;
    }
  }

  write(data: string): void {
    if (!this.running) return;
    this.#session.writeInput(data);
  }

  resize(size: TerminalSize): void {
    this.#size = { ...size };
    if (this.running) this.#session.resize(size);
  }

  abort(): void {
    if (this.running) this.#session.abort();
  }

  async newConversation(): Promise<void> {
    const wasRunning = this.running;
    this.running = false;
    this.#detachExit?.();
    this.#detachExit = undefined;
    if (wasRunning) await this.#session.dispose();
    this.#sink.reset();
    await this.start();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.#detachExit?.();
    this.#detachExit = undefined;
    await this.#session.dispose();
  }

  #handleExit(): void {
    if (!this.running) return;
    this.running = false;
    this.#detachExit?.();
    this.#detachExit = undefined;
    this.#sink.failed('Claude PTY exited.');
  }
}

function prepareConfig(): void {
  execFileSync('/bin/sh', [CONFIG_PREPARER], {
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    },
    shell: false,
    stdio: 'ignore',
    timeout: 5_000,
  });
}

function mergeEnvironment(overrides: Readonly<Record<string, string>>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...overrides };
}
