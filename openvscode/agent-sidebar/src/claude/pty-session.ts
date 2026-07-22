import { notImplemented } from '../not-implemented.ts';

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

  constructor(spawner: ClaudePtySpawner, output: ClaudeOutputSink) {
    this.#spawner = spawner;
    this.#output = output;
  }

  async resolveVisible(size: TerminalSize): Promise<ClaudePtyProcess> {
    void size;
    void this.#spawner;
    void this.#output;
    return notImplemented('fixed Claude node-pty startup');
  }

  writeInput(data: string): void {
    void data;
    return notImplemented('Claude PTY input forwarding');
  }

  resize(size: TerminalSize): void {
    void size;
    return notImplemented('Claude PTY resize forwarding');
  }

  abort(): void {
    return notImplemented('Claude PTY Ctrl+C forwarding');
  }

  async newConversation(size: TerminalSize): Promise<ClaudePtyProcess> {
    void size;
    return notImplemented('Claude PTY replacement lifecycle');
  }

  async dispose(): Promise<void> {
    return notImplemented('Claude PTY cleanup');
  }
}
