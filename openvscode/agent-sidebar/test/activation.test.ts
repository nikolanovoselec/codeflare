import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { Backend, BackendFactories, BackendKind } from '../src/backend.ts';
import { resolveVisibleSafely, SidebarLifecycle, selectBackendKind } from '../src/lifecycle.ts';

class RecordingBackend implements Backend {
  readonly kind: BackendKind;
  readonly events: string[];
  running = false;

  constructor(kind: BackendKind, events: string[]) {
    this.kind = kind;
    this.events = events;
  }

  async start(): Promise<void> {
    this.events.push(`${this.kind}:start`);
    this.running = true;
  }

  async stop(): Promise<void> {
    this.events.push(`${this.kind}:stop`);
    this.running = false;
  }
}

class FailingBackend extends RecordingBackend {
  override async start(): Promise<void> {
    throw new Error('Pi spawn failed');
  }
}

function recordingFactories(events: string[]): BackendFactories {
  return {
    pi: () => new RecordingBackend('pi', events),
    claude: () => new RecordingBackend('claude', events),
  };
}

test('REQ-IDE-005 AC3: activation is inert until visible resolution starts the selected backend', async () => {
  const events: string[] = [];
  const lifecycle = new SidebarLifecycle('pi', recordingFactories(events));

  assert.deepEqual(lifecycle.activate(), { selected: 'pi', running: false });
  assert.deepEqual(events, []);

  const backend = await lifecycle.resolveVisible();

  assert.equal(backend.kind, 'pi');
  assert.equal(backend.running, true);
  assert.deepEqual(events, ['pi:start']);
});

test('REQ-IDE-005 AC3: a visibility-triggered start failure is reported without escaping', async () => {
  const failures: string[] = [];
  const lifecycle = new SidebarLifecycle('pi', {
    pi: () => new FailingBackend('pi', []),
    claude: () => new RecordingBackend('claude', []),
  });

  await resolveVisibleSafely(lifecycle, (error) => failures.push(error instanceof Error ? error.message : 'unknown'));

  assert.deepEqual(failures, ['Pi spawn failed']);
});

test('REQ-IDE-005 AC3: Claude selection never constructs the Pi backend', async () => {
  const events: string[] = [];
  const lifecycle = new SidebarLifecycle('claude', recordingFactories(events));

  lifecycle.activate();
  const backend = await lifecycle.resolveVisible();

  assert.equal(backend.kind, 'claude');
  assert.deepEqual(events, ['claude:start']);
});

test('REQ-IDE-005 AC3: repeated visible resolution reuses one backend instance', async () => {
  const events: string[] = [];
  const lifecycle = new SidebarLifecycle('pi', recordingFactories(events));

  const first = await lifecycle.resolveVisible();
  const second = await lifecycle.resolveVisible();

  assert.equal(first, second);
  assert.deepEqual(events, ['pi:start']);
});

test('REQ-IDE-005 AC3+AC7: visible resolution restarts a cached backend after an unexpected exit', async () => {
  const events: string[] = [];
  const lifecycle = new SidebarLifecycle('claude', recordingFactories(events));

  const backend = await lifecycle.resolveVisible();
  await backend.stop();
  const restarted = await lifecycle.resolveVisible();

  assert.equal(restarted, backend);
  assert.equal(restarted.running, true);
  assert.deepEqual(events, ['claude:start', 'claude:stop', 'claude:start']);
});

test('REQ-IDE-005 AC7: extension deactivation stops the selected backend', async () => {
  const events: string[] = [];
  const lifecycle = new SidebarLifecycle('pi', recordingFactories(events));

  await lifecycle.resolveVisible();
  await lifecycle.deactivate();

  assert.deepEqual(events, ['pi:start', 'pi:stop']);
});

test('REQ-IDE-005 AC3: extension backend selection rejects values outside the fixed Pi and Claude enum', () => {
  assert.equal(selectBackendKind('pi'), 'pi');
  assert.equal(selectBackendKind('claude'), 'claude');
  assert.throws(() => selectBackendKind('bash'), /unsupported sidebar backend/i);
  assert.throws(() => selectBackendKind(undefined), /unsupported sidebar backend/i);
});
