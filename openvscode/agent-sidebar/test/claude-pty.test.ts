import assert from 'node:assert/strict';
import { test } from 'vitest';

import { SIDEBAR_PROCESS_GENERATION_ENV } from '../src/process-generation.ts';
import {
  ClaudePtySession,
  type ClaudePtyProcess,
  type ClaudePtySpawnSpec,
  type ClaudePtySpawner,
} from '../src/claude/pty-session.ts';

class RecordingPty implements ClaudePtyProcess {
  readonly events: string[];
  readonly generation: number;
  exited = false;
  private dataListener: ((data: string) => void) | undefined;

  constructor(events: string[], generation: number) {
    this.events = events;
    this.generation = generation;
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListener = listener;
    return () => {
      this.dataListener = undefined;
    };
  }

  emitData(data: string): void {
    this.dataListener?.(data);
  }

  write(data: string): void {
    this.events.push(`write:${this.generation}:${data}`);
  }

  resize(columns: number, rows: number): void {
    this.events.push(`resize:${this.generation}:${columns}x${rows}`);
  }

  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.events.push(`kill:${this.generation}:${signal}`);
  }

  async waitForExit(): Promise<void> {
    this.events.push(`wait:${this.generation}`);
    this.exited = true;
  }
}

class RecordingPtySpawner implements ClaudePtySpawner {
  readonly events: string[] = [];
  readonly specs: ClaudePtySpawnSpec[] = [];
  readonly children: RecordingPty[] = [];

  spawn(spec: ClaudePtySpawnSpec): ClaudePtyProcess {
    this.specs.push(spec);
    const child = new RecordingPty(this.events, this.children.length + 1);
    this.children.push(child);
    this.events.push(`spawn:${child.generation}`);
    return child;
  }
}

test('REQ-IDE-005 AC4 + REQ-IDE-006 AC1+AC3: Claude starts only the fixed no-shell PTY contract', async () => {
  const spawner = new RecordingPtySpawner();
  const session = new ClaudePtySession(spawner, () => undefined, {
    generationFactory: () => 'claude-generation-1',
    reapGeneration: async () => undefined,
  });

  await session.resolveVisible({ columns: 80, rows: 24 });

  assert.deepEqual(spawner.specs, [
    {
      executable: '/usr/local/bin/claude',
      args: ['--settings', '/opt/codeflare/openvscode/claude/sidebar-settings.json'],
      cwd: '/home/user/workspace',
      env: {
        HOME: '/home/user',
        CLAUDE_CONFIG_DIR: '/tmp/codeflare-sidebar/claude/config',
        TERM: 'xterm-256color',
        [SIDEBAR_PROCESS_GENERATION_ENV]: 'claude-generation-1',
      },
      terminal: { name: 'xterm-256color', columns: 80, rows: 24 },
      shell: false,
    },
  ]);
  assert.equal(spawner.specs[0]?.args.includes('--dangerously-skip-permissions'), false);
});

test('Claude PTY forwards output without interpreting terminal data', async () => {
  const spawner = new RecordingPtySpawner();
  const output: string[] = [];
  const session = new ClaudePtySession(spawner, (data) => output.push(data));

  await session.resolveVisible({ columns: 80, rows: 24 });
  spawner.children[0]?.emitData('\u001b[31mλ\u001b[0m\r\n');

  assert.deepEqual(output, ['\u001b[31mλ\u001b[0m\r\n']);
});

test('Claude PTY forwards terminal input exactly', async () => {
  const spawner = new RecordingPtySpawner();
  const session = new ClaudePtySession(spawner, () => undefined);

  await session.resolveVisible({ columns: 80, rows: 24 });
  session.writeInput('paste λ\r');

  assert.deepEqual(spawner.events, ['spawn:1', 'write:1:paste λ\r']);
});

test('Claude PTY abort sends Ctrl+C through terminal input', async () => {
  const spawner = new RecordingPtySpawner();
  const session = new ClaudePtySession(spawner, () => undefined);

  await session.resolveVisible({ columns: 80, rows: 24 });
  session.abort();

  assert.deepEqual(spawner.events, ['spawn:1', 'write:1:\u0003']);
});

test('Claude PTY forwards validated terminal dimensions', async () => {
  const spawner = new RecordingPtySpawner();
  const session = new ClaudePtySession(spawner, () => undefined);

  await session.resolveVisible({ columns: 80, rows: 24 });
  session.resize({ columns: 132, rows: 40 });

  assert.deepEqual(spawner.events, ['spawn:1', 'resize:1:132x40']);
});

test('REQ-IDE-005 AC4: repeated Claude resolution reuses the existing PTY', async () => {
  const spawner = new RecordingPtySpawner();
  const session = new ClaudePtySession(spawner, () => undefined);

  const first = await session.resolveVisible({ columns: 80, rows: 24 });
  const second = await session.resolveVisible({ columns: 100, rows: 30 });

  assert.equal(first, second);
  assert.equal(spawner.children.length, 1);
  assert.deepEqual(spawner.events, ['spawn:1', 'resize:1:100x30']);
});

test('REQ-IDE-006 AC6: new Claude conversation reaps the old PTY before replacement', async () => {
  const spawner = new RecordingPtySpawner();
  const session = new ClaudePtySession(spawner, () => undefined);

  await session.resolveVisible({ columns: 80, rows: 24 });
  await session.newConversation({ columns: 90, rows: 28 });

  assert.deepEqual(spawner.events, [
    'spawn:1',
    'kill:1:SIGTERM',
    'wait:1',
    'spawn:2',
  ]);
  assert.equal(spawner.children[0]?.exited, true);
  assert.equal(spawner.children[1]?.exited, false);
});

test('REQ-IDE-006 AC6: Claude replacement reaps every process carrying the old conversation generation', async () => {
  const spawner = new RecordingPtySpawner();
  let generation = 0;
  const session = new ClaudePtySession(spawner, () => undefined, {
    generationFactory: () => `claude-generation-${++generation}`,
    reapGeneration: async (token) => { spawner.events.push(`reap:${token}`); },
  });

  await session.resolveVisible({ columns: 80, rows: 24 });
  await session.newConversation({ columns: 90, rows: 28 });

  assert.deepEqual(spawner.events, [
    'spawn:1',
    'kill:1:SIGTERM',
    'wait:1',
    'reap:claude-generation-1',
    'spawn:2',
  ]);
  assert.equal(spawner.specs[1]?.env[SIDEBAR_PROCESS_GENERATION_ENV], 'claude-generation-2');
});

test('REQ-IDE-006 AC6: Claude disposal reaps the managed PTY', async () => {
  const spawner = new RecordingPtySpawner();
  const session = new ClaudePtySession(spawner, () => undefined);

  await session.resolveVisible({ columns: 80, rows: 24 });
  await session.dispose();

  assert.deepEqual(spawner.events, ['spawn:1', 'kill:1:SIGTERM', 'wait:1']);
  assert.equal(spawner.children[0]?.exited, true);
});
