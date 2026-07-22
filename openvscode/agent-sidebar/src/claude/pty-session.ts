export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export interface ClaudePtySpawnSpec {
  readonly executable: '/usr/local/bin/claude';
  readonly args: readonly ['--settings', '/opt/codeflare/openvscode/claude/sidebar-settings.json'];
  readonly cwd: '/home/user/workspace';
  readonly env: Readonly<{
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

export class ClaudePtySession {
  readonly #spawner: ClaudePtySpawner;
  readonly #output: ClaudeOutputSink;
  #process: ClaudePtyProcess | undefined;
  #detachOutput: (() => void) | undefined;
  #size: TerminalSize | undefined;

  constructor(spawner: ClaudePtySpawner, output: ClaudeOutputSink) {
    this.#spawner = spawner;
    this.#output = output;
  }

  async resolveVisible(size: TerminalSize): Promise<ClaudePtyProcess> {
    assertTerminalSize(size);
    if (this.#process && !this.#process.exited) {
      if (!this.#size || this.#size.columns !== size.columns || this.#size.rows !== size.rows) {
        this.#process.resize(size.columns, size.rows);
        this.#size = { ...size };
      }
      return this.#process;
    }

    const spec = spawnSpec(size);
    const process = this.#spawner.spawn(spec);
    this.#process = process;
    this.#size = { ...size };
    this.#detachOutput = process.onData(this.#output);
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

  #requireProcess(): ClaudePtyProcess {
    if (!this.#process || this.#process.exited) throw new Error('Claude PTY is not running');
    return this.#process;
  }

  async #reap(): Promise<void> {
    const process = this.#process;
    this.#process = undefined;
    this.#size = undefined;
    this.#detachOutput?.();
    this.#detachOutput = undefined;
    if (!process || process.exited) return;
    process.kill('SIGTERM');
    await process.waitForExit();
  }
}

function spawnSpec(size: TerminalSize): ClaudePtySpawnSpec {
  return {
    executable: '/usr/local/bin/claude',
    args: ['--settings', '/opt/codeflare/openvscode/claude/sidebar-settings.json'],
    cwd: '/home/user/workspace',
    env: {
      HOME: '/home/user',
      CLAUDE_CONFIG_DIR: '/tmp/codeflare-sidebar/claude/config',
      TERM: 'xterm-256color',
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
