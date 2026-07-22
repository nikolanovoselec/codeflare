import { randomUUID } from 'node:crypto';

import {
  SIDEBAR_PROCESS_GENERATION_ENV,
  reapSidebarGeneration,
} from '../process-generation.ts';

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export interface ClaudePtySpawnSpec {
  readonly executable: '/usr/local/bin/claude';
  readonly args: readonly ['--settings', '/opt/codeflare/openvscode/claude/sidebar-settings.json'];
  readonly cwd: '/home/user/workspace';
  readonly env: Readonly<Record<string, string> & {
    HOME: '/home/user';
    CLAUDE_CONFIG_DIR: '/tmp/codeflare-sidebar/claude/config';
    TERM: 'xterm-256color';
  }>;
  readonly terminal: Readonly<{
    name: 'xterm-256color';
    columns: number;
    rows: number;
  }>;
  readonly shell: false;
}

export interface ClaudePtyProcess {
  readonly exited: boolean;
  onData(listener: (data: string) => void): () => void;
  onExit?(listener: () => void): () => void;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
  waitForExit(): Promise<void>;
}

export interface ClaudePtySpawner {
  spawn(spec: ClaudePtySpawnSpec): ClaudePtyProcess;
}

export type ClaudeOutputSink = (data: string) => void;

export interface ClaudePtySessionOptions {
  readonly generationFactory?: () => string;
  readonly reapGeneration?: (token: string) => Promise<void>;
}

export class ClaudePtySession {
  readonly #spawner: ClaudePtySpawner;
  readonly #output: ClaudeOutputSink;
  readonly #generationFactory: () => string;
  readonly #reapGeneration: (token: string) => Promise<void>;
  #process: ClaudePtyProcess | undefined;
  #generation: string | undefined;
  #reaping = Promise.resolve();
  #detachOutput: (() => void) | undefined;
  #size: TerminalSize | undefined;

  constructor(
    spawner: ClaudePtySpawner,
    output: ClaudeOutputSink,
    options: ClaudePtySessionOptions = {},
  ) {
    this.#spawner = spawner;
    this.#output = output;
    this.#generationFactory = options.generationFactory ?? randomUUID;
    this.#reapGeneration = options.reapGeneration ?? reapSidebarGeneration;
  }

  async resolveVisible(size: TerminalSize): Promise<ClaudePtyProcess> {
    assertTerminalSize(size);
    await this.#reaping;
    if (this.#process?.exited) await this.#reap();
    if (this.#process) {
      if (!this.#size || this.#size.columns !== size.columns || this.#size.rows !== size.rows) {
        this.#process.resize(size.columns, size.rows);
        this.#size = { ...size };
      }
      return this.#process;
    }

    const generation = this.#generationFactory();
    const spec = spawnSpec(size, generation);
    const process = this.#spawner.spawn(spec);
    this.#process = process;
    this.#generation = generation;
    this.#size = { ...size };
    this.#detachOutput = process.onData((data) => {
      if (this.#process === process && this.#generation === generation) this.#output(data);
    });
    return process;
  }

  writeInput(data: string): void {
    if (typeof data !== 'string') throw new TypeError('Claude PTY input must be a string');
    this.#requireProcess().write(data);
  }

  resize(size: TerminalSize): void {
    assertTerminalSize(size);
    this.#requireProcess().resize(size.columns, size.rows);
    this.#size = { ...size };
  }

  abort(): void {
    this.#requireProcess().write('\u0003');
  }

  async newConversation(size: TerminalSize): Promise<ClaudePtyProcess> {
    await this.#reap();
    return this.resolveVisible(size);
  }

  async dispose(): Promise<void> {
    await this.#reap();
  }

  async reapExitedProcess(process: ClaudePtyProcess): Promise<void> {
    if (this.#process !== process) return;
    await this.#reap();
  }

  #requireProcess(): ClaudePtyProcess {
    if (!this.#process || this.#process.exited) throw new Error('Claude PTY is not running');
    return this.#process;
  }

  #reap(): Promise<void> {
    const process = this.#process;
    const generation = this.#generation;
    this.#process = undefined;
    this.#generation = undefined;
    this.#size = undefined;
    this.#detachOutput?.();
    this.#detachOutput = undefined;
    if (!process && !generation) return this.#reaping;

    const previous = this.#reaping;
    const reaping = (async () => {
      await previous;
      if (process && !process.exited) {
        process.kill('SIGTERM');
        await process.waitForExit();
      }
      if (generation) await this.#reapGeneration(generation);
    })();
    this.#reaping = reaping;
    return reaping;
  }
}

function spawnSpec(size: TerminalSize, generation: string): ClaudePtySpawnSpec {
  return {
    executable: '/usr/local/bin/claude',
    args: ['--settings', '/opt/codeflare/openvscode/claude/sidebar-settings.json'],
    cwd: '/home/user/workspace',
    env: {
      HOME: '/home/user',
      CLAUDE_CONFIG_DIR: '/tmp/codeflare-sidebar/claude/config',
      TERM: 'xterm-256color',
      [SIDEBAR_PROCESS_GENERATION_ENV]: generation,
    },
    terminal: { name: 'xterm-256color', columns: size.columns, rows: size.rows },
    shell: false,
  };
}

function assertTerminalSize(size: TerminalSize): void {
  if (!validDimension(size.columns) || !validDimension(size.rows)) {
    throw new RangeError('Invalid Claude PTY size');
  }
}

function validDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 1_000;
}
