import { randomUUID } from 'node:crypto';

import {
  SIDEBAR_PROCESS_GENERATION_ENV,
  reapSidebarGeneration,
} from '../process-generation.ts';

export interface PiSpawnSpec {
  readonly executable: '/usr/local/bin/pi';
  readonly args: readonly ['--mode', 'rpc', '--no-session', '--no-themes'];
  readonly cwd: '/home/user/workspace';
  readonly env: Readonly<Record<string, string> & {
    HOME: '/home/user';
    CODEFLARE_SIDEBAR: '1';
  }>;
  readonly shell: false;
}

export interface PiChildProcess {
  readonly exited: boolean;
  write(line: string): void | Promise<void>;
  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void;
  waitForExit(): Promise<void>;
  waitForSpawn?(signal?: AbortSignal): Promise<void>;
  onStdout?(listener: (data: Uint8Array) => void): () => void;
  onStderr?(listener: (data: string) => void): () => void;
  onExit?(listener: () => void): () => void;
}

export interface PiProcessSpawner {
  spawn(spec: PiSpawnSpec): PiChildProcess;
}

export interface PiSessionOptions {
  readonly generationFactory?: () => string;
  readonly reapGeneration?: (token: string) => Promise<void>;
}

export const FIXED_PI_SPAWN_SPEC: PiSpawnSpec = Object.freeze({
  executable: '/usr/local/bin/pi',
  args: Object.freeze(['--mode', 'rpc', '--no-session', '--no-themes'] as const),
  cwd: '/home/user/workspace',
  env: Object.freeze({
    HOME: '/home/user',
    CODEFLARE_SIDEBAR: '1',
  }),
  shell: false,
});

export class PiSession {
  readonly #spawner: PiProcessSpawner;
  readonly #generationFactory: () => string;
  readonly #reapGeneration: (token: string) => Promise<void>;
  #child: PiChildProcess | undefined;
  #generation: string | undefined;
  #reaping = Promise.resolve();
  #disposed = false;
  #promptSequence = 0;
  #abortSequence = 0;

  constructor(spawner: PiProcessSpawner, options: PiSessionOptions = {}) {
    this.#spawner = spawner;
    this.#generationFactory = options.generationFactory ?? randomUUID;
    this.#reapGeneration = options.reapGeneration ?? reapSidebarGeneration;
  }

  async resolveVisible(): Promise<PiChildProcess> {
    this.#assertActive();
    await this.#reaping;
    this.#assertActive();
    if (this.#child?.exited) await this.#reap();
    this.#assertActive();
    if (!this.#child) {
      const generation = this.#generationFactory();
      this.#generation = generation;
      this.#child = this.#spawner.spawn({
        ...FIXED_PI_SPAWN_SPEC,
        env: { ...FIXED_PI_SPAWN_SPEC.env, [SIDEBAR_PROCESS_GENERATION_ENV]: generation },
      });
    }
    return this.#child;
  }

  async sendPrompt(message: string, beforeWrite?: (id: string) => void): Promise<string> {
    if (typeof message !== 'string') throw new TypeError('Pi prompt must be a string');
    const child = await this.resolveVisible();
    this.#assertActive();
    const id = `prompt-${++this.#promptSequence}`;
    beforeWrite?.(id);
    await child.write(`${JSON.stringify({ id, type: 'prompt', message })}\n`);
    return id;
  }

  async abort(beforeWrite?: (id: string) => void): Promise<string> {
    const child = await this.resolveVisible();
    this.#assertActive();
    const id = `abort-${++this.#abortSequence}`;
    beforeWrite?.(id);
    await child.write(`${JSON.stringify({ id, type: 'abort' })}\n`);
    return id;
  }

  async writeEnvelope(envelope: Readonly<Record<string, unknown>>): Promise<void> {
    const child = await this.resolveVisible();
    this.#assertActive();
    await child.write(`${JSON.stringify(envelope)}\n`);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#reap();
  }

  async reapExitedProcess(child: PiChildProcess): Promise<void> {
    if (this.#child !== child) return;
    await this.#reap();
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('Pi request session is disposed');
  }

  #reap(): Promise<void> {
    const child = this.#child;
    const generation = this.#generation;
    this.#child = undefined;
    this.#generation = undefined;
    if (!child && !generation) return this.#reaping;

    const previous = this.#reaping;
    const reaping = (async () => {
      await previous;
      if (child && !child.exited) child.signal('SIGTERM');
      if (generation) await this.#reapGeneration(generation);
      else if (child && !child.exited) await child.waitForExit();
    })();
    this.#reaping = reaping;
    return reaping;
  }
}
