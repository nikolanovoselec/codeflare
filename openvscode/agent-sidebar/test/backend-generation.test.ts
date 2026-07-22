import assert from 'node:assert/strict';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { test } from 'vitest';

import { ClaudePtyBackend } from '../src/claude/node-pty-backend.ts';
import type { ClaudePtyProcess, ClaudePtySpawnSpec, ClaudePtySpawner } from '../src/claude/pty-session.ts';
import { ApprovalBridge, type ApprovalHost, type ApprovalManifest } from '../src/pi/approval-bridge.ts';
import { PiRpcBackend } from '../src/pi/node-rpc-backend.ts';
import type { PiChildProcess, PiProcessSpawner, PiSpawnSpec } from '../src/pi/session.ts';

class DeferredApprovalHost implements ApprovalHost {
  readonly entered: Promise<void>;
  readonly #markEntered: () => void;
  readonly #decision: Promise<boolean>;
  readonly #resolveDecision: (approved: boolean) => void;

  constructor() {
    let markEntered = (): void => undefined;
    let resolveDecision = (_approved: boolean): void => undefined;
    this.entered = new Promise((resolve) => { markEntered = resolve; });
    this.#decision = new Promise((resolve) => { resolveDecision = resolve; });
    this.#markEntered = markEntered;
    this.#resolveDecision = resolveDecision;
  }

  resolve(approved: boolean): void {
    this.#resolveDecision(approved);
  }

  async loadManifest(opaqueId: string): Promise<ApprovalManifest> {
    return {
      id: opaqueId,
      operation: 'edit',
      canonicalTarget: '/home/user/workspace/file.ts',
      baseHash: 'base',
      resultHash: 'result',
      previewId: 'preview',
      expiresAt: Date.now() + 60_000,
      nonce: 'a'.repeat(64),
    };
  }

  async openDiff(): Promise<void> {}

  async confirm(): Promise<boolean> {
    this.#markEntered();
    return this.#decision;
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

class FakePty implements ClaudePtyProcess {
  exited = false;
  readonly writes: string[] = [];
  exitListener: (() => void) | undefined;

  onData(): () => void { return () => undefined; }
  onExit(listener: () => void): () => void {
    this.exitListener = listener;
    return () => undefined;
  }
  write(data: string): void { this.writes.push(data); }
  resize(): void {}
  kill(): void {}
  async waitForExit(): Promise<void> { this.exited = true; }
}

class FakePtySpawner implements ClaudePtySpawner {
  readonly children: FakePty[] = [];
  spawn(_spec: ClaudePtySpawnSpec): ClaudePtyProcess {
    const child = new FakePty();
    this.children.push(child);
    return child;
  }
}

test('REQ-IDE-005 AC3+AC7: an asynchronous Pi spawn failure cannot leave a running backend', async () => {
  const backend = new PiRpcBackend(new SpawnFailingPiSpawner(), new ApprovalBridge(new DeferredApprovalHost()), {
    output: () => undefined,
    reset: () => undefined,
    failed: () => undefined,
  });

  await assert.rejects(backend.start(), /unavailable/);
  assert.equal(backend.running, false);
});

test('REQ-IDE-005 AC3+AC7: an asynchronous Pi stdin failure stops the backend without escaping', async () => {
  const backend = new PiRpcBackend(new StdinFailingPiSpawner(), new ApprovalBridge(new DeferredApprovalHost()), {
    output: () => undefined,
    reset: () => undefined,
    failed: () => undefined,
  });

  await backend.start();
  await assert.rejects(backend.prompt('hello'), /EPIPE/);
  assert.equal(backend.running, false);
});

test('REQ-IDE-005 AC3: cycle-thinking renders the correlated Pi response level', async () => {
  const output: string[] = [];
  const spawner = new FakePiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new DeferredApprovalHost()), {
    output: (text) => output.push(text),
    reset: () => undefined,
    failed: () => undefined,
  });

  await backend.cycleThinkingLevel();
  spawner.children[0]?.emit({
    id: 'thinking-1',
    type: 'response',
    command: 'cycle_thinking_level',
    success: true,
    data: { level: 'high' },
  });
  await waitForImmediate();

  assert.deepEqual(output, ['\nThinking: high\n']);
});

test('REQ-IDE-005 AC5+AC7: a late Pi approval response cannot enter a replacement conversation', async () => {
  const host = new DeferredApprovalHost();
  const spawner = new FakePiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(host), {
    output: () => undefined,
    reset: () => undefined,
    failed: () => undefined,
  });
  const approvalId = '00112233445566778899aabbccddeeff';

  await backend.start();
  spawner.children[0]?.emit({
    type: 'extension_ui_request',
    id: 'approval-request-1',
    method: 'confirm',
    message: approvalId,
  });
  await host.entered;
  await backend.newConversation();
  host.resolve(true);
  await waitForImmediate();

  assert.equal(spawner.children.length, 2);
  assert.equal(spawner.children[1]?.writes.some((line) => line.includes('extension_ui_response')), false);
});

test('REQ-IDE-005 AC5+AC7: a stale Claude exit callback cannot stop a replacement conversation', async () => {
  const spawner = new FakePtySpawner();
  const backend = new ClaudePtyBackend(spawner, {
    output: () => undefined,
    reset: () => undefined,
    failed: () => undefined,
  });

  await backend.start();
  const staleExit = spawner.children[0]?.exitListener;
  await backend.newConversation();
  staleExit?.();
  backend.write('still-current');

  assert.equal(backend.running, true);
  assert.deepEqual(spawner.children[1]?.writes, ['still-current']);
});
