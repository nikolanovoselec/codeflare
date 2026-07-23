import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { test } from 'vitest';

import { ClaudePtyBackend } from '../src/claude/node-pty-backend.ts';
import type { ClaudePtyProcess, ClaudePtySpawnSpec, ClaudePtySpawner } from '../src/claude/pty-session.ts';
import { ApprovalBridge, type ApprovalHost, type ApprovalManifest } from '../src/pi/approval-bridge.ts';
import { PiRpcBackend } from '../src/pi/node-rpc-backend.ts';
import type { PiChildProcess, PiProcessSpawner, PiSpawnSpec } from '../src/pi/session.ts';

const DEFERRED_APPROVAL_ID = '00112233445566778899aabbccddeeff';
const DEFERRED_MANIFEST = JSON.stringify({
  id: DEFERRED_APPROVAL_ID,
  operation: 'edit',
  canonicalTarget: '/home/user/workspace/file.ts',
  baseHash: 'base',
  resultHash: 'result',
  previewId: 'preview',
  expiresAt: 4_102_444_800_000,
  nonce: 'a'.repeat(64),
} satisfies ApprovalManifest);
const DEFERRED_APPROVAL_REFERENCE = `${DEFERRED_APPROVAL_ID}:${createHash('sha256').update(DEFERRED_MANIFEST).digest('hex')}`;

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

  async loadManifest(): Promise<string> {
    return DEFERRED_MANIFEST;
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

test('REQ-IDE-005 AC6 + REQ-IDE-008 AC4: an asynchronous Pi spawn failure cannot leave a running backend', async () => {
  const backend = new PiRpcBackend(new SpawnFailingPiSpawner(), new ApprovalBridge(new DeferredApprovalHost()), {
    output: () => undefined,
    reset: () => undefined,
    failed: () => undefined,
  });

  await assert.rejects(backend.start(), /unavailable/);
  assert.equal(backend.running, false);
});

test('REQ-IDE-005 AC6 + REQ-IDE-008 AC4: an asynchronous Pi stdin failure stops the backend without escaping', async () => {
  const backend = new PiRpcBackend(new StdinFailingPiSpawner(), new ApprovalBridge(new DeferredApprovalHost()), {
    output: () => undefined,
    reset: () => undefined,
    failed: () => undefined,
  });

  await backend.start();
  await assert.rejects(backend.prompt('hello'), /EPIPE/);
  assert.equal(backend.running, false);
});

test('cycle-thinking renders the correlated Pi response level', async () => {
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

test('REQ-IDE-005 AC4: a native Pi turn streams only assistant text, reports tool progress, and completes at agent_settled', async () => {
  const markdown: string[] = [];
  const progress: string[] = [];
  const spawner = new FakePiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new DeferredApprovalHost()), {
    output: () => undefined,
    reset: () => undefined,
    failed: () => undefined,
  }) as PiRpcBackend & {
    runPrompt(message: string, observer: {
      markdown(value: string): void;
      progress(value: string): void;
    }): Promise<void>;
  };

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

test('REQ-IDE-007 AC2 + REQ-IDE-008 AC4: a late Pi approval response cannot enter a replacement conversation', async () => {
  const host = new DeferredApprovalHost();
  const spawner = new FakePiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(host), {
    output: () => undefined,
    reset: () => undefined,
    failed: () => undefined,
  });
  await backend.start();
  spawner.children[0]?.emit({
    type: 'extension_ui_request',
    id: 'approval-request-1',
    method: 'confirm',
    message: DEFERRED_APPROVAL_REFERENCE,
  });
  await host.entered;
  await backend.newConversation();
  host.resolve(true);
  await waitForImmediate();

  assert.equal(spawner.children.length, 2);
  assert.equal(spawner.children[1]?.writes.some((line) => line.includes('extension_ui_response')), false);
});

test('REQ-IDE-008 AC4: a stale Claude exit callback cannot stop a replacement conversation', async () => {
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
