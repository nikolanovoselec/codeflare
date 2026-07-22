import { notImplemented } from '../not-implemented.ts';

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

  constructor(spawner: PiProcessSpawner) {
    this.#spawner = spawner;
  }

  async resolveVisible(): Promise<PiChildProcess> {
    void this.#spawner;
    return notImplemented('fixed Pi process startup');
  }

  async sendPrompt(message: string): Promise<void> {
    void message;
    return notImplemented('Pi prompt transport');
  }

  async abort(): Promise<void> {
    return notImplemented('Pi abort lifecycle');
  }

  async newConversation(): Promise<PiChildProcess> {
    return notImplemented('Pi no-session process replacement');
  }

  async dispose(): Promise<void> {
    return notImplemented('Pi process cleanup');
  }
}
