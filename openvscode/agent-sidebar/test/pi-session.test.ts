import assert from 'node:assert/strict';
import { test } from 'vitest';

import { SIDEBAR_PROCESS_GENERATION_ENV } from '../src/process-generation.ts';
import {
  PiSession,
  type PiChildProcess,
  type PiProcessSpawner,
  type PiSpawnSpec,
} from '../src/pi/session.ts';

class RecordingPiChild implements PiChildProcess {
  readonly events: string[];
  readonly generation: number;
  exited = false;

  constructor(events: string[], generation: number) {
    this.events = events;
    this.generation = generation;
  }

  write(line: string): void {
    this.events.push(`write:${this.generation}:${line}`);
  }

  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void {
    this.events.push(`signal:${this.generation}:${signal}`);
  }

  async waitForExit(): Promise<void> {
    this.events.push(`wait:${this.generation}`);
    this.exited = true;
  }
}

class RecordingPiSpawner implements PiProcessSpawner {
  readonly events: string[] = [];
  readonly specs: PiSpawnSpec[] = [];
  readonly children: RecordingPiChild[] = [];

  spawn(spec: PiSpawnSpec): PiChildProcess {
    this.specs.push(spec);
    const child = new RecordingPiChild(this.events, this.children.length + 1);
    this.children.push(child);
    this.events.push(`spawn:${child.generation}`);
    return child;
  }
}

test('REQ-IDE-005 AC5 + REQ-IDE-006 AC1+AC3: visible Pi resolution uses only the fixed no-session spawn contract', async () => {
  const spawner = new RecordingPiSpawner();
  const session = new PiSession(spawner, {
    generationFactory: () => 'pi-generation-1',
    reapGeneration: async () => undefined,
  });

  await session.resolveVisible();

  assert.deepEqual(spawner.specs, [
    {
      executable: '/usr/local/bin/pi',
      args: ['--mode', 'rpc', '--no-session', '--no-themes'],
      cwd: '/home/user/workspace',
      env: {
        HOME: '/home/user',
        CODEFLARE_SIDEBAR: '1',
        [SIDEBAR_PROCESS_GENERATION_ENV]: 'pi-generation-1',
      },
      shell: false,
    },
  ]);
});

test('REQ-IDE-005 AC5: repeated visible Pi resolution reuses one process', async () => {
  const spawner = new RecordingPiSpawner();
  const session = new PiSession(spawner);

  await session.resolveVisible();
  await session.resolveVisible();
  await session.sendPrompt('hello');

  assert.equal(spawner.children.length, 1);
  assert.deepEqual(spawner.events, [
    'spawn:1',
    'write:1:{"id":"prompt-1","type":"prompt","message":"hello"}\n',
  ]);
});

test('Pi model and thinking controls remain closed correlated RPC commands', async () => {
  const spawner = new RecordingPiSpawner();
  const session = new PiSession(spawner);

  await session.cycleModel();
  await session.cycleThinkingLevel();

  assert.deepEqual(spawner.events, [
    'spawn:1',
    'write:1:{"id":"model-1","type":"cycle_model"}\n',
    'write:1:{"id":"thinking-1","type":"cycle_thinking_level"}\n',
  ]);
});

test('REQ-IDE-008 AC1: Pi abort is sent while the current process remains available', async () => {
  const spawner = new RecordingPiSpawner();
  const session = new PiSession(spawner);

  await session.resolveVisible();
  await session.abort();

  assert.deepEqual(spawner.events, [
    'spawn:1',
    'write:1:{"id":"abort-1","type":"abort"}\n',
  ]);
  assert.equal(spawner.children[0]?.exited, false);
});

test('REQ-IDE-008 AC2: new Pi conversation reaps the old no-session process before replacement', async () => {
  const spawner = new RecordingPiSpawner();
  const session = new PiSession(spawner);

  await session.resolveVisible();
  await session.newConversation();

  assert.deepEqual(spawner.events, [
    'spawn:1',
    'signal:1:SIGTERM',
    'wait:1',
    'spawn:2',
  ]);
  assert.equal(spawner.children[0]?.exited, true);
  assert.equal(spawner.children[1]?.exited, false);
});

test('REQ-IDE-008 AC2: Pi replacement reaps every process carrying the old conversation generation', async () => {
  const spawner = new RecordingPiSpawner();
  let generation = 0;
  const session = new PiSession(spawner, {
    generationFactory: () => `pi-generation-${++generation}`,
    reapGeneration: async (token) => { spawner.events.push(`reap:${token}`); },
  });

  await session.resolveVisible();
  await session.newConversation();

  assert.deepEqual(spawner.events, [
    'spawn:1',
    'signal:1:SIGTERM',
    'wait:1',
    'reap:pi-generation-1',
    'spawn:2',
  ]);
  assert.equal(spawner.specs[1]?.env[SIDEBAR_PROCESS_GENERATION_ENV], 'pi-generation-2');
});

test('REQ-IDE-008 AC3: Pi disposal settles and reaps the managed process', async () => {
  const spawner = new RecordingPiSpawner();
  const session = new PiSession(spawner);

  await session.resolveVisible();
  await session.dispose();

  assert.deepEqual(spawner.events, ['spawn:1', 'signal:1:SIGTERM', 'wait:1']);
  assert.equal(spawner.children[0]?.exited, true);
});
