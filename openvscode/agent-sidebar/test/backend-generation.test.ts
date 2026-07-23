import assert from 'node:assert/strict';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { test } from 'vitest';

import { ApprovalBridge, type ApprovalHost, type ApprovalManifest } from '../src/pi/approval-bridge.ts';
import { PiRpcBackend } from '../src/pi/node-rpc-backend.ts';
import type { PiChildProcess, PiProcessSpawner, PiSpawnSpec } from '../src/pi/session.ts';

class UnexpectedApprovalHost implements ApprovalHost {
  async loadManifest(): Promise<string> {
    throw new Error('Approval was not expected');
  }

  async openDiff(_manifest: ApprovalManifest): Promise<void> {
    throw new Error('Approval was not expected');
  }

  async confirm(_manifest: ApprovalManifest): Promise<boolean> {
    throw new Error('Approval was not expected');
  }
}

class FakePiChild implements PiChildProcess {
  exited = false;
  readonly writes: string[] = [];
  #stdout: ((data: Uint8Array) => void) | undefined;

  write(line: string): void | Promise<void> { this.writes.push(line); }
  signal(): void {}
  async waitForExit(): Promise<void> { this.exited = true; }
  onStdout(listener: (data: Uint8Array) => void): () => void {
    this.#stdout = listener;
    return () => { this.#stdout = undefined; };
  }
  onStderr(): () => void { return () => undefined; }
  onExit(): () => void { return () => undefined; }
  emit(envelope: unknown): void { this.#stdout?.(Buffer.from(`${JSON.stringify(envelope)}\n`)); }
}

class FakePiSpawner implements PiProcessSpawner {
  readonly children: FakePiChild[] = [];
  spawn(_spec: PiSpawnSpec): PiChildProcess {
    const child = new FakePiChild();
    this.children.push(child);
    return child;
  }
}

class DelayedSpawnPiChild extends FakePiChild {
  readonly #spawned: Promise<void>;
  readonly #releaseSpawn: () => void;

  constructor() {
    super();
    let releaseSpawn = (): void => undefined;
    this.#spawned = new Promise((resolve) => { releaseSpawn = resolve; });
    this.#releaseSpawn = releaseSpawn;
  }

  releaseSpawn(): void {
    this.#releaseSpawn();
  }

  async waitForSpawn(): Promise<void> {
    await this.#spawned;
  }
}

class DelayedSpawnPiSpawner implements PiProcessSpawner {
  readonly child = new DelayedSpawnPiChild();

  spawn(_spec: PiSpawnSpec): PiChildProcess {
    return this.child;
  }
}

class SpawnFailingPiChild extends FakePiChild {
  async waitForSpawn(): Promise<void> {
    throw new Error('Pi executable is unavailable');
  }
}

class SpawnFailingPiSpawner implements PiProcessSpawner {
  spawn(_spec: PiSpawnSpec): PiChildProcess {
    return new SpawnFailingPiChild();
  }
}

class StdinFailingPiChild extends FakePiChild {
  override write(): Promise<void> {
    return Promise.reject(new Error('EPIPE'));
  }
}

class StdinFailingPiSpawner implements PiProcessSpawner {
  spawn(_spec: PiSpawnSpec): PiChildProcess {
    return new StdinFailingPiChild();
  }
}

test('REQ-IDE-008 AC1: cancellation during Pi startup cannot send a prompt after spawn completes', async () => {
  const spawner = new DelayedSpawnPiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new UnexpectedApprovalHost()));
  let failure: Error | undefined;
  const turn = backend.runPrompt('must-not-run', {
    markdown: () => undefined,
    progress: () => undefined,
  }).catch((error: Error) => { failure = error; });
  await waitForImmediate();

  await backend.abort();
  spawner.child.releaseSpawn();
  await waitForImmediate();
  await backend.stop();
  await turn;

  assert.deepEqual(spawner.child.writes, []);
  assert.equal(failure, undefined);
  assert.equal(backend.running, false);
});

test('REQ-IDE-008 AC2+AC3: disposal during Pi startup cannot resurrect the backend', async () => {
  const spawner = new DelayedSpawnPiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new UnexpectedApprovalHost()));
  let failure: Error | undefined;
  const turn = backend.runPrompt('must-not-run', {
    markdown: () => undefined,
    progress: () => undefined,
  }).catch((error: Error) => { failure = error; });
  await waitForImmediate();

  await backend.stop();
  spawner.child.releaseSpawn();
  await waitForImmediate();
  await backend.stop();
  await turn;

  assert.deepEqual(spawner.child.writes, []);
  assert.match(failure?.message ?? '', /stopped/i);
  assert.equal(backend.running, false);
});

test('REQ-IDE-008 AC3: an asynchronous Pi spawn failure cannot leave a running backend', async () => {
  const backend = new PiRpcBackend(new SpawnFailingPiSpawner(), new ApprovalBridge(new UnexpectedApprovalHost()));

  await assert.rejects(backend.runPrompt('hello', {
    markdown: () => undefined,
    progress: () => undefined,
  }), /unavailable/);
  assert.equal(backend.running, false);
});

test('REQ-IDE-008 AC3: an asynchronous Pi stdin failure stops the backend without escaping', async () => {
  const backend = new PiRpcBackend(new StdinFailingPiSpawner(), new ApprovalBridge(new UnexpectedApprovalHost()));

  await assert.rejects(backend.runPrompt('hello', {
    markdown: () => undefined,
    progress: () => undefined,
  }), /EPIPE/);
  assert.equal(backend.running, false);
});

test('REQ-IDE-005 AC4: a native Pi turn streams only assistant text, reports tool progress, and completes at agent_settled', async () => {
  const markdown: string[] = [];
  const progress: string[] = [];
  const spawner = new FakePiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new UnexpectedApprovalHost()));

  let settled = false;
  const turn = backend.runPrompt('inspect the active file', {
    markdown: (value) => markdown.push(value),
    progress: (value) => progress.push(value),
  }).then(() => { settled = true; });
  await waitForImmediate();

  assert.match(spawner.children[0]?.writes[0] ?? '', /"type":"prompt"/);
  spawner.children[0]?.emit({
    id: 'prompt-1',
    type: 'response',
    command: 'prompt',
    success: true,
  });
  spawner.children[0]?.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'Visible answer' },
  });
  spawner.children[0]?.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: 'hidden reasoning canary' },
  });
  spawner.children[0]?.emit({ type: 'tool_execution_start', toolName: 'read' });
  spawner.children[0]?.emit({ type: 'agent_end', willRetry: false });
  await waitForImmediate();

  assert.equal(settled, false);
  assert.deepEqual(markdown, ['Visible answer']);
  assert.deepEqual(progress, ['Running read…']);
  assert.doesNotMatch(markdown.join(''), /hidden reasoning canary/);

  spawner.children[0]?.emit({ type: 'agent_settled' });
  await turn;
  assert.equal(settled, true);
  await backend.stop();
});

