import assert from 'node:assert/strict';
import { setTimeout as waitForTimeout } from 'node:timers/promises';
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

class TermIgnoringPiChild extends RecordingPiChild {
  #releaseExit = (): void => undefined;
  readonly #exit = new Promise<void>((resolve) => { this.#releaseExit = resolve; });

  releaseExit(): void {
    this.#releaseExit();
  }

  override async waitForExit(): Promise<void> {
    this.events.push(`wait:${this.generation}`);
    await this.#exit;
    this.exited = true;
  }
}

class TermIgnoringPiSpawner extends RecordingPiSpawner {
  readonly child = new TermIgnoringPiChild(this.events, 1);

  override spawn(spec: PiSpawnSpec): PiChildProcess {
    this.specs.push(spec);
    this.children.push(this.child);
    this.events.push('spawn:1');
    return this.child;
  }
}

test('REQ-IDE-005 AC4 + REQ-IDE-006 AC1+AC3: visible Pi resolution uses only the fixed no-session spawn contract', async () => {
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

test('REQ-IDE-005 AC4: one request-scoped Pi session reuses only its one child', async () => {
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

test('REQ-IDE-008 AC2+AC3: a disposed request session cannot spawn a replacement child', async () => {
  const spawner = new RecordingPiSpawner();
  const session = new PiSession(spawner, { reapGeneration: async () => undefined });

  await session.resolveVisible();
  await session.dispose();

  await assert.rejects(session.resolveVisible(), /disposed/i);
  assert.equal(spawner.children.length, 1);
});

test('REQ-IDE-008 AC2: Pi disposal uses bounded generation reaping when TERM is ignored', async () => {
  const spawner = new TermIgnoringPiSpawner();
  const session = new PiSession(spawner, {
    generationFactory: () => 'pi-generation-1',
    reapGeneration: async (token) => { spawner.events.push(`reap:${token}`); },
  });

  await session.resolveVisible();
  const disposal = session.dispose();
  const outcome = await Promise.race([
    disposal.then(() => 'disposed'),
    waitForTimeout(100, 'timed-out'),
  ]);
  spawner.child.releaseExit();
  await disposal;

  assert.equal(outcome, 'disposed');
  assert.ok(spawner.events.includes('reap:pi-generation-1'));
});

test('REQ-IDE-008 AC2: Pi disposal settles and reaps the request generation', async () => {
  const spawner = new RecordingPiSpawner();
  const session = new PiSession(spawner, {
    generationFactory: () => 'pi-generation-1',
    reapGeneration: async (token) => { spawner.events.push(`reap:${token}`); },
  });

  await session.resolveVisible();
  await session.dispose();

  assert.deepEqual(spawner.events, [
    'spawn:1',
    'signal:1:SIGTERM',
    'reap:pi-generation-1',
  ]);
});
