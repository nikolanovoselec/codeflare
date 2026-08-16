import assert from 'node:assert/strict';
import { setImmediate as waitForImmediate, setTimeout as waitForTimeout } from 'node:timers/promises';
import { test } from 'vitest';

import { ApprovalBridge, type ApprovalHost, type ApprovalManifest } from '../src/pi/approval-bridge.ts';
import { PiRpcBackend } from '../src/pi/node-rpc-backend.ts';
import type { PiChildProcess, PiProcessSpawner, PiSpawnSpec } from '../src/pi/session.ts';

class UnexpectedApprovalHost implements ApprovalHost {
  selectCalls = 0;
  selectResult: string | undefined;
  waitForSelectCancellation = false;

  async loadManifest(): Promise<string> {
    throw new Error('Approval was not expected');
  }

  async confirm(_manifest: ApprovalManifest): Promise<boolean> {
    throw new Error('Approval was not expected');
  }

  async select(_title: string, options: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
    this.selectCalls += 1;
    if (this.selectResult !== undefined) return this.selectResult;
    if (this.waitForSelectCancellation) {
      return new Promise((resolve) => {
        if (signal?.aborted) resolve(undefined);
        else signal?.addEventListener('abort', () => resolve(undefined), { once: true });
      });
    }
    throw new Error(`Selection was not expected: ${options.join(',')}`);
  }

  async input(): Promise<string | undefined> {
    throw new Error('Input was not expected');
  }
}

class FakePiChild implements PiChildProcess {
  exited = false;
  readonly writes: string[] = [];
  #stdout: ((data: Uint8Array) => void) | undefined;
  #exit: (() => void) | undefined;

  write(line: string): void | Promise<void> { this.writes.push(line); }
  signal(): void {}
  async waitForExit(): Promise<void> { this.exited = true; }
  onStdout(listener: (data: Uint8Array) => void): () => void {
    this.#stdout = listener;
    return () => { this.#stdout = undefined; };
  }
  onStderr(): () => void { return () => undefined; }
  onExit(listener: () => void): () => void {
    this.#exit = listener;
    return () => { this.#exit = undefined; };
  }
  emit(envelope: unknown): void { this.#stdout?.(Buffer.from(`${JSON.stringify(envelope)}\n`)); }
  emitExit(): void {
    this.exited = true;
    this.#exit?.();
  }
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
  const outcome: { failure?: Error } = {};
  const turn = backend.runPrompt('must-not-run', {
    markdown: () => undefined,
    progress: () => undefined,
  }).catch((error: Error) => { outcome.failure = error; });
  await waitForImmediate();

  await backend.abort();
  spawner.child.releaseSpawn();
  await waitForImmediate();
  await backend.stop();
  await turn;

  assert.deepEqual(spawner.child.writes, []);
  assert.equal(outcome.failure, undefined);
  assert.equal(backend.running, false);
});

test('REQ-IDE-008 AC1: accepted Pi cancellation settles without agent_settled', async () => {
  const spawner = new FakePiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new UnexpectedApprovalHost()));
  const turn = backend.runPrompt('cancel this turn', {
    markdown: () => undefined,
    progress: () => undefined,
  });
  await waitForImmediate();

  const prompt = JSON.parse(spawner.children[0]?.writes[0] ?? '{}') as { id?: string };
  spawner.children[0]?.emit({ id: prompt.id, type: 'response', command: 'prompt', success: true });
  await waitForImmediate();
  await backend.abort();
  const outcome = await Promise.race([
    turn.then(() => 'settled', () => 'failed'),
    waitForTimeout(100, 'timed-out'),
  ]);
  await backend.stop();

  assert.equal(outcome, 'settled');
  assert.match(spawner.children[0]?.writes.at(-1) ?? '', /"type":"abort"/);
  assert.equal(backend.running, false);
});

test('REQ-IDE-008 AC2+AC3: disposal during Pi startup cannot resurrect the backend', async () => {
  const spawner = new DelayedSpawnPiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new UnexpectedApprovalHost()));
  const outcome: { failure?: Error } = {};
  const turn = backend.runPrompt('must-not-run', {
    markdown: () => undefined,
    progress: () => undefined,
  }).catch((error: Error) => { outcome.failure = error; });
  await waitForImmediate();

  const firstStop = backend.stop();
  const repeatedStop = backend.stop();
  assert.equal(repeatedStop, firstStop);
  await firstStop;
  spawner.child.releaseSpawn();
  await waitForImmediate();
  await repeatedStop;
  await turn;

  assert.deepEqual(spawner.child.writes, []);
  assert.match(outcome.failure?.message ?? '', /stopped/i);
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

test('REQ-IDE-022: a timed-out Pi RPC dialog writes cancellation and the active turn continues', async () => {
  const spawner = new FakePiSpawner();
  const host = new UnexpectedApprovalHost();
  host.waitForSelectCancellation = true;
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(host));
  const markdown: string[] = [];
  const turn = backend.runPrompt('ask before continuing', {
    markdown: (value) => markdown.push(value),
    progress: () => undefined,
  });
  await waitForImmediate();

  const prompt = JSON.parse(spawner.children[0]?.writes[0] ?? '{}') as { id?: string };
  spawner.children[0]?.emit({ id: prompt.id, type: 'response', command: 'prompt', success: true });
  spawner.children[0]?.emit({
    type: 'extension_ui_request',
    id: 'question-1',
    method: 'select',
    title: 'Choose one',
    options: ['First', 'Second'],
    timeout: 1,
  });
  await waitForTimeout(10);

  assert.deepEqual(JSON.parse(spawner.children[0]?.writes[1] ?? '{}'), {
    type: 'extension_ui_response',
    id: 'question-1',
    cancelled: true,
  });
  spawner.children[0]?.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'Continued' },
  });
  spawner.children[0]?.emit({ type: 'agent_settled' });
  await turn;
  assert.deepEqual(markdown, ['Continued']);
  await backend.stop();
});

test('REQ-IDE-022: an unknown blocking Pi UI request fails and stops the active generation', async () => {
  const spawner = new FakePiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new UnexpectedApprovalHost()));
  const turn = backend.runPrompt('reject an unknown dialog', {
    markdown: () => undefined,
    progress: () => undefined,
  });
  await waitForImmediate();

  const prompt = JSON.parse(spawner.children[0]?.writes[0] ?? '{}') as { id?: string };
  spawner.children[0]?.emit({ id: prompt.id, type: 'response', command: 'prompt', success: true });
  spawner.children[0]?.emit({
    type: 'extension_ui_request',
    id: 'unknown-dialog',
    method: 'futureBlockingDialog',
    title: 'Unknown dialog',
  });

  await assert.rejects(turn, /UNSUPPORTED_UI_REQUEST/);
  await waitForImmediate();
  assert.equal(backend.running, false);
});

test('REQ-IDE-008: idle blocking UI fails closed without displaying and prevents reuse', async () => {
  const spawner = new FakePiSpawner();
  const host = new UnexpectedApprovalHost();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(host));
  const turn = backend.runPrompt('complete before idle UI', {
    markdown: () => undefined,
    progress: () => undefined,
  });
  await waitForImmediate();

  const prompt = JSON.parse(spawner.children[0]?.writes[0] ?? '{}') as { id?: string };
  spawner.children[0]?.emit({ id: prompt.id, type: 'response', command: 'prompt', success: true });
  spawner.children[0]?.emit({ type: 'agent_settled' });
  await turn;
  spawner.children[0]?.emit({
    type: 'extension_ui_request',
    id: 'idle-ui',
    method: 'select',
    params: { title: 'Must not display', options: ['one'] },
  });
  await waitForImmediate();

  assert.equal(host.selectCalls, 0);
  assert.equal(spawner.children[0]?.writes.length, 1);
  assert.equal(backend.isReusable(), false);
  await backend.stop();
});

test('REQ-IDE-008: an unexpected idle Pi exit marks the backend unavailable for reuse', async () => {
  const spawner = new FakePiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new UnexpectedApprovalHost()));
  const turn = backend.runPrompt('complete before exit', {
    markdown: () => undefined,
    progress: () => undefined,
  });
  await waitForImmediate();

  const prompt = JSON.parse(spawner.children[0]?.writes[0] ?? '{}') as { id?: string };
  spawner.children[0]?.emit({ id: prompt.id, type: 'response', command: 'prompt', success: true });
  spawner.children[0]?.emit({ type: 'agent_settled' });
  await turn;
  assert.equal(backend.isReusable(), true);

  spawner.children[0]?.emitExit();
  await waitForImmediate();
  assert.equal(backend.isReusable(), false);
  await backend.stop();
});

test('REQ-IDE-027: a native Pi panel turn streams reasoning, bounds tool progress, and settles with its answer', async () => {
  const markdown: string[] = [];
  const progress: string[] = [];
  const thinking: string[] = [];
  const spawner = new FakePiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new UnexpectedApprovalHost()));

  let settled = false;
  const turn = backend.runPrompt('inspect the active file', {
    markdown: (value) => markdown.push(value),
    progress: (value) => progress.push(value),
    thinking: (value) => thinking.push(value),
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
  spawner.children[0]?.emit({ type: 'tool_execution_start', toolName: 'read' });
  spawner.children[0]?.emit({ type: 'tool_execution_start', toolName: 'bash' });
  spawner.children[0]?.emit({ type: 'tool_execution_start', toolName: 'bash' });
  spawner.children[0]?.emit({ type: 'agent_end', willRetry: false });
  await waitForImmediate();

  assert.equal(settled, false);
  assert.deepEqual(markdown, ['Visible answer']);
  assert.deepEqual(thinking, ['hidden reasoning canary']);
  assert.deepEqual(progress, ['Inspecting workspace…', 'Running command…']);
  assert.doesNotMatch(markdown.join(''), /hidden reasoning canary/);

  spawner.children[0]?.emit({ type: 'agent_settled' });
  await turn;
  assert.equal(settled, true);
  await backend.stop();
});

test('REQ-IDE-026: inline Pi returns one correlated host-owned edit proposal without markdown', async () => {
  const markdown: string[] = [];
  const spawner = new FakePiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new UnexpectedApprovalHost()));
  const turn = backend.runInlineEditPrompt('replace the selected function', {
    markdown: (value) => markdown.push(value),
    progress: () => undefined,
  });
  await waitForImmediate();

  const prompt = JSON.parse(spawner.children[0]?.writes[0] ?? '{}') as { id?: string; message?: string };
  assert.equal(prompt.id, 'prompt-1');
  assert.match(prompt.message ?? '', /^\/codeflare-inline-edit\s+/);
  const encoded = (prompt.message ?? '').split(/\s+/, 2)[1] ?? '';
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { requestId: string; prompt: string };
  assert.equal(payload.prompt, 'replace the selected function');

  spawner.children[0]?.emit({ id: prompt.id, type: 'response', command: 'prompt', success: true });
  spawner.children[0]?.emit({
    type: 'tool_execution_start',
    toolName: 'codeflare_submit_inline_edits',
    toolCallId: 'inline-tool-1',
    args: {
      requestId: payload.requestId,
      edits: [
        {
          startLine: 0,
          startCharacter: 5,
          endLine: 0,
          endCharacter: 5,
          newText: ';',
        },
        {
          startLine: 0,
          startCharacter: 0,
          endLine: 0,
          endCharacter: 5,
          newText: 'const replacement = true',
        },
      ],
    },
  });
  spawner.children[0]?.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'must stay hidden' },
  });
  spawner.children[0]?.emit({ type: 'agent_settled' });

  assert.deepEqual(await turn, [
    {
      startLine: 0,
      startCharacter: 0,
      endLine: 0,
      endCharacter: 5,
      newText: 'const replacement = true',
    },
    {
      startLine: 0,
      startCharacter: 5,
      endLine: 0,
      endCharacter: 5,
      newText: ';',
    },
  ]);
  assert.deepEqual(markdown, []);
  await backend.stop();
});

test('REQ-IDE-028: inline command extension errors reject immediately and retire the backend', async () => {
  const spawner = new FakePiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new UnexpectedApprovalHost()));
  const turn = backend.runInlineEditPrompt('generate code', {
    markdown: () => undefined,
    progress: () => undefined,
  });
  await waitForImmediate();

  const prompt = JSON.parse(spawner.children[0]?.writes[0] ?? '{}') as { id?: string };
  spawner.children[0]?.emit({
    type: 'extension_error',
    extensionPath: 'command:codeflare-inline-edit',
    event: 'command',
    error: 'ctx.sendUserMessage is not a function',
  });
  spawner.children[0]?.emit({ id: prompt.id, type: 'response', command: 'prompt', success: true });

  await assert.rejects(turn, /native Inline Chat command failed/i);
  await waitForImmediate();
  assert.equal(backend.isReusable(), false);
  await backend.stop();
});

test('REQ-IDE-028: asynchronous inline dispatch errors reject after command acceptance and retire the backend', async () => {
  const spawner = new FakePiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new UnexpectedApprovalHost()));
  const turn = backend.runInlineEditPrompt('generate code', {
    markdown: () => undefined,
    progress: () => undefined,
  });
  await waitForImmediate();

  const prompt = JSON.parse(spawner.children[0]?.writes[0] ?? '{}') as { id?: string };
  spawner.children[0]?.emit({ id: prompt.id, type: 'response', command: 'prompt', success: true });
  spawner.children[0]?.emit({
    type: 'extension_error',
    extensionPath: '<runtime>',
    event: 'send_user_message',
    error: 'Nested prompt dispatch failed',
  });

  await assert.rejects(turn, /native Inline Chat command failed/i);
  await waitForImmediate();
  assert.equal(backend.isReusable(), false);
  await backend.stop();
});

test('REQ-IDE-028: unrelated extension errors do not discard a valid inline proposal', async () => {
  const spawner = new FakePiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new UnexpectedApprovalHost()));
  const turn = backend.runInlineEditPrompt('generate code', {
    markdown: () => undefined,
    progress: () => undefined,
  });
  await waitForImmediate();

  const prompt = JSON.parse(spawner.children[0]?.writes[0] ?? '{}') as { id?: string; message?: string };
  const encoded = (prompt.message ?? '').split(/\s+/, 2)[1] ?? '';
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { requestId: string };
  spawner.children[0]?.emit({ id: prompt.id, type: 'response', command: 'prompt', success: true });
  spawner.children[0]?.emit({
    type: 'extension_error',
    extensionPath: '/home/user/.pi/agent/extensions/unrelated.ts',
    event: 'agent_start',
    error: 'unrelated failure',
  });
  spawner.children[0]?.emit({
    type: 'tool_execution_start',
    toolName: 'codeflare_submit_inline_edits',
    args: {
      requestId: payload.requestId,
      edits: [{
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: 0,
        newText: 'safe',
      }],
    },
  });
  spawner.children[0]?.emit({ type: 'agent_settled' });

  assert.deepEqual(await turn, [{
    startLine: 0,
    startCharacter: 0,
    endLine: 0,
    endCharacter: 0,
    newText: 'safe',
  }]);
  assert.equal(backend.isReusable(), true);
  await backend.stop();
});

test('REQ-IDE-026: inline Pi rejects a duplicate proposal and retires the backend', async () => {
  const spawner = new FakePiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new UnexpectedApprovalHost()));
  const turn = backend.runInlineEditPrompt('generate code', {
    markdown: () => undefined,
    progress: () => undefined,
  });
  await waitForImmediate();

  const prompt = JSON.parse(spawner.children[0]?.writes[0] ?? '{}') as { id?: string; message?: string };
  const encoded = (prompt.message ?? '').split(/\s+/, 2)[1] ?? '';
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { requestId: string };
  spawner.children[0]?.emit({ id: prompt.id, type: 'response', command: 'prompt', success: true });
  const proposal = {
    type: 'tool_execution_start',
    toolName: 'codeflare_submit_inline_edits',
    args: {
      requestId: payload.requestId,
      edits: [{
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: 0,
        newText: 'safe',
      }],
    },
  };
  spawner.children[0]?.emit(proposal);
  spawner.children[0]?.emit(proposal);

  await assert.rejects(turn, /invalid or duplicate tool/i);
  await waitForImmediate();
  assert.equal(backend.isReusable(), false);
  await backend.stop();
});

test('REQ-IDE-026: inline Pi rejects more than 64 proposed edits and retires the backend', async () => {
  const spawner = new FakePiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new UnexpectedApprovalHost()));
  const turn = backend.runInlineEditPrompt('generate code', {
    markdown: () => undefined,
    progress: () => undefined,
  });
  await waitForImmediate();

  const prompt = JSON.parse(spawner.children[0]?.writes[0] ?? '{}') as { id?: string; message?: string };
  const encoded = (prompt.message ?? '').split(/\s+/, 2)[1] ?? '';
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { requestId: string };
  spawner.children[0]?.emit({ id: prompt.id, type: 'response', command: 'prompt', success: true });
  spawner.children[0]?.emit({
    type: 'tool_execution_start',
    toolName: 'codeflare_submit_inline_edits',
    args: {
      requestId: payload.requestId,
      edits: Array.from({ length: 65 }, () => ({
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: 0,
        newText: 'x',
      })),
    },
  });

  await assert.rejects(turn, /invalid native Inline Chat edit proposal/i);
  await waitForImmediate();
  assert.equal(backend.isReusable(), false);
  await backend.stop();
});

test('REQ-IDE-026: inline Pi rejects an uncorrelated proposal and retires the backend', async () => {
  const spawner = new FakePiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new UnexpectedApprovalHost()));
  const turn = backend.runInlineEditPrompt('generate code', {
    markdown: () => undefined,
    progress: () => undefined,
  });
  await waitForImmediate();

  const prompt = JSON.parse(spawner.children[0]?.writes[0] ?? '{}') as { id?: string };
  spawner.children[0]?.emit({ id: prompt.id, type: 'response', command: 'prompt', success: true });
  spawner.children[0]?.emit({
    type: 'tool_execution_start',
    toolName: 'codeflare_submit_inline_edits',
    args: {
      requestId: 'inline-wrong000',
      edits: [{
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: 0,
        newText: 'unsafe',
      }],
    },
  });

  await assert.rejects(turn, /invalid native Inline Chat edit proposal/i);
  await waitForImmediate();
  assert.equal(backend.isReusable(), false);
  await backend.stop();
});

test('REQ-IDE-026: inline Pi fails closed when settlement has no valid proposal', async () => {
  const spawner = new FakePiSpawner();
  const backend = new PiRpcBackend(spawner, new ApprovalBridge(new UnexpectedApprovalHost()));
  const turn = backend.runInlineEditPrompt('generate code', {
    markdown: () => undefined,
    progress: () => undefined,
  });
  await waitForImmediate();

  const prompt = JSON.parse(spawner.children[0]?.writes[0] ?? '{}') as { id?: string };
  spawner.children[0]?.emit({ id: prompt.id, type: 'response', command: 'prompt', success: true });
  spawner.children[0]?.emit({ type: 'agent_settled' });

  await assert.rejects(turn, /did not submit.*edit proposal/i);
  await waitForImmediate();
  assert.equal(backend.isReusable(), false);
  await backend.stop();
});

