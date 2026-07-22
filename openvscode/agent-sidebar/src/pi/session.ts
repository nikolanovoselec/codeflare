export interface PiSpawnSpec {
  readonly executable: '/usr/local/bin/pi';
  readonly args: readonly ['--mode', 'rpc', '--no-session', '--no-themes'];
  readonly cwd: '/home/user/workspace';
  readonly env: Readonly<{
    HOME: '/home/user';
    CODEFLARE_SIDEBAR: '1';
  }>;
  readonly shell: false;
}

export interface PiChildProcess {
  readonly exited: boolean;
  write(line: string): void;
  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void;
  waitForExit(): Promise<void>;
}

export interface PiProcessSpawner {
  spawn(spec: PiSpawnSpec): PiChildProcess;
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
  #child: PiChildProcess | undefined;
  #promptSequence = 0;
  #abortSequence = 0;

  constructor(spawner: PiProcessSpawner) {
    this.#spawner = spawner;
  }

  async resolveVisible(): Promise<PiChildProcess> {
    if (!this.#child || this.#child.exited) {
      this.#child = this.#spawner.spawn(FIXED_PI_SPAWN_SPEC);
    }
    return this.#child;
  }

  async sendPrompt(message: string): Promise<void> {
    if (typeof message !== 'string') throw new TypeError('Pi prompt must be a string');
    const child = await this.resolveVisible();
    const id = `prompt-${++this.#promptSequence}`;
    child.write(`${JSON.stringify({ id, type: 'prompt', message })}\n`);
  }

  async abort(): Promise<void> {
    const child = await this.resolveVisible();
    const id = `abort-${++this.#abortSequence}`;
    child.write(`${JSON.stringify({ id, type: 'abort' })}\n`);
  }

  async newConversation(): Promise<PiChildProcess> {
    await this.#reap();
    return this.resolveVisible();
  }

  async dispose(): Promise<void> {
    await this.#reap();
  }

  async #reap(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (!child || child.exited) return;
    child.signal('SIGTERM');
    await child.waitForExit();
  }
}
