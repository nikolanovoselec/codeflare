/**
 * Test navigation: Real Wrangler/workerd integration: fresh Workers, explicit bindings, SQLite ordering, admission and native eviction recovery.
 * Fixtures are local/CI evidence, not production deployment or live Access acceptance.
 * Requirement IDs in describe blocks link each behavior to sdd/spec/operators.md.
 */
import { fileURLToPath, URL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';
import { createHash } from 'node:crypto';
import { registerNativeDispatcherCases } from './fixtures/flue-native-cases';
import type { RegistryFixtureCommand, ActivityFixtureCommand } from './fixtures/loader-worker';
import type { OperatorActivityPreparation } from '../../operators/activity';
import type { OperatorAdmissionRequest, OperatorRegistryResult } from '../../operators/registry';

// Real pinned Wrangler/workerd, executed only in the Node CI suite. No deploy,
// provider requests, secrets, production config or production fixture exports.
let worker: Unstable_DevWorker | undefined;
async function startWorker() {
  console.info('[native-loader] wrangler startup begin');
  worker = await unstable_dev(fileURLToPath(new URL('./fixtures/loader-worker.ts', import.meta.url)), {
    config: fileURLToPath(new URL('./fixtures/wrangler.toml', import.meta.url)),
    local: true, ip: '127.0.0.1', port: 0, inspectorPort: 0, persist: false, logLevel: 'none',
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
  });
  console.info('[native-loader] wrangler startup complete');
}
beforeAll(startWorker, 60_000);
afterAll(async () => {
  console.info('[native-loader] wrangler shutdown begin');
  await worker?.stop();
  console.info('[native-loader] wrangler shutdown complete');
});
beforeEach((context) => { console.info(`[native-loader] test begin: ${context.task.name}`); });
afterEach((context) => { console.info(`[native-loader] test end: ${context.task.name}`); });

describe('REQ-OPERATOR-015: Worker Loader runtime boundary', () => {
  it('loads fresh Workers rather than retaining isolate-local state', async () => {
    const response = await worker!.fetch('/fresh');
    expect(await response.json()).toEqual([{ counter: 1 }, { counter: 1 }]);
  });

  it('binds identity at the parent RPC capability and exposes no parent environment', async () => {
    const response = await worker!.fetch('/identity');
    expect(await response.json()).toEqual({ principal: 'fixture-owner', bindings: ['OPERATOR'] });
  });

  it('routes direct inference-shaped HTTP through the bound parent interceptor', async () => {
    const response = await worker!.fetch('/allowed');
    expect(await response.json()).toEqual({ principal: 'fixture-owner', intercepted: true });
  });

  it('returns the parent denial for unapproved direct egress', async () => {
    const response = await worker!.fetch('/denied');
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('denied');
  });

  it('executes the exact compiler-produced Review Conductor through the generic parent capability', async () => {
    const response = await worker!.fetch('/conductor-bundle');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ schemaVersion: 1, status: 'completed', result: {
      operationId: 'review-generation-1', cleanup: 'stopped', reports: [
        { lane: 'code-reviewer', packetDigest: 'a'.repeat(64) },
        { lane: 'spec-reviewer', packetDigest: 'a'.repeat(64) },
        { lane: 'doc-updater', packetDigest: 'a'.repeat(64) },
      ],
    } });
  });

  it('executes the exact Gate 1 artifact through the native Loader boundary', async () => {
    const direct = await worker!.fetch('/gate1-bundle?case=direct');
    expect(direct.status).toBe(200);
    expect(await direct.json()).toEqual({ schemaVersion: 1, status: 'completed', checkpoint: null,
      result: { fixture: 'codeflare-gate1', activityId: 'gate1-activity' } });

    const session = await worker!.fetch('/gate1-bundle?case=session');
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ schemaVersion: 1, status: 'completed', checkpoint: null,
      result: { fixture: 'codeflare-gate1', activityId: 'gate1-activity', via: 'parent-capability' } });

    const wrongRoute = await worker!.fetch('/gate1-bundle?case=wrong-route');
    expect(wrongRoute.status).toBe(404);
    expect(await wrongRoute.json()).toEqual({ error: 'Not found' });

    const malformed = await worker!.fetch('/gate1-bundle?case=malformed');
    expect(malformed.status).toBe(500);
    expect(await malformed.json()).toEqual({ error: expect.any(String) });
  });
});

// Same Wrangler instance and canonical Backend tests (node) lane as Gate 1.
registerNativeDispatcherCases({
  fetch: async (path, init): Promise<Response> =>
    (await worker!.fetch(path, init as unknown as Parameters<Unstable_DevWorker['fetch']>[1])) as unknown as Response,
  reset: async () => { await worker?.stop(); await startWorker(); },
  queuedActivity,
  activity,
});

const ARTIFACT = 'a'.repeat(64);
async function registry(fixture: string, command: RegistryFixtureCommand): Promise<OperatorRegistryResult<unknown>> {
  const response = await worker!.fetch(`/registry?fixture=${fixture}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
  });
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result as OperatorRegistryResult<unknown>;
}
async function enabledRegistry(): Promise<string> {
  const fixture = crypto.randomUUID();
  expect(await registry(fixture, { action: 'create', operatorId: 'fixture' })).toMatchObject({ ok: true });
  expect(await registry(fixture, { action: 'approve', operatorId: 'fixture', artifactDigest: ARTIFACT, expectedRevision: 1 }))
    .toMatchObject({ ok: true, value: { revision: 2, enabled: false } });
  expect(await registry(fixture, { action: 'enable', operatorId: 'fixture', enabled: true, expectedRevision: 2 }))
    .toMatchObject({ ok: true, value: { revision: 3, enabled: true } });
  return fixture;
}
function admission(): OperatorAdmissionRequest {
  return { operatorId: 'fixture', activityId: crypto.randomUUID(), intentDigest: 'b'.repeat(64),
    expectedRevision: 3, deadline: Date.now() + 60_000 };
}

describe('REQ-OPERATOR-011: SQLite registration and admission ordering', () => {
  it('starts disabled and requires approval before separate enablement', async () => {
    const fixture = crypto.randomUUID();
    expect(await registry(fixture, { action: 'create', operatorId: 'fixture' })).toEqual({ ok: true,
      value: { operatorId: 'fixture', revision: 1, enabled: false, approvedArtifactDigest: null } });
    expect(await registry(fixture, { action: 'enable', operatorId: 'fixture', enabled: true, expectedRevision: 1 }))
      .toEqual({ ok: false, reason: 'artifact-unapproved' });
    expect(await registry(fixture, { action: 'create', operatorId: 'fixture' }))
      .toEqual({ ok: false, reason: 'already-exists' });
  });

  it('rejects stale administrative and admission revisions', async () => {
    const fixture = await enabledRegistry();
    expect(await registry(fixture, { action: 'enable', operatorId: 'fixture', enabled: false, expectedRevision: 2 }))
      .toEqual({ ok: false, reason: 'revision-conflict' });
    expect(await registry(fixture, { action: 'approve', operatorId: 'fixture', artifactDigest: ARTIFACT, expectedRevision: 2 }))
      .toEqual({ ok: false, reason: 'revision-conflict' });
    expect(await registry(fixture, { action: 'admit', request: { ...admission(), expectedRevision: 2 } }))
      .toEqual({ ok: false, reason: 'revision-conflict' });
  });

  it('requires separate enablement after replacement approval', async () => {
    const fixture = await enabledRegistry();
    expect(await registry(fixture, { action: 'approve', operatorId: 'fixture', artifactDigest: 'c'.repeat(64), expectedRevision: 3 }))
      .toEqual({ ok: true, value: { operatorId: 'fixture', revision: 4, enabled: false, approvedArtifactDigest: 'c'.repeat(64) } });
    expect(await registry(fixture, { action: 'admit', request: { ...admission(), expectedRevision: 4 } }))
      .toEqual({ ok: false, reason: 'disabled' });
  });

  it('returns one immutable receipt to concurrent identical admissions', async () => {
    const fixture = await enabledRegistry();
    const request = admission();
    const results = await Promise.all(Array.from({ length: 12 }, () => registry(fixture, { action: 'admit', request })));
    expect(results[0]).toMatchObject({ ok: true, value: { ...request, artifactDigest: ARTIFACT, admittedAt: expect.any(Number) } });
    for (const result of results) expect(result).toEqual(results[0]);
    expect(await registry(fixture, { action: 'receipt', activityId: request.activityId })).toEqual(results[0]);
  });

  it('denies disable-first admission without creating a receipt', async () => {
    const fixture = await enabledRegistry();
    const request = { ...admission(), expectedRevision: 4 };
    expect(await registry(fixture, { action: 'enable', operatorId: 'fixture', enabled: false, expectedRevision: 3 })).toMatchObject({ ok: true });
    expect(await registry(fixture, { action: 'admit', request })).toEqual({ ok: false, reason: 'disabled' });
    expect(await registry(fixture, { action: 'receipt', activityId: request.activityId })).toEqual({ ok: true, value: null });
  });

  it('reconciles receipt-first admission after disable without granting fresh admission', async () => {
    const fixture = await enabledRegistry();
    const request = admission();
    const receipt = await registry(fixture, { action: 'admit', request });
    expect(receipt).toMatchObject({ ok: true });
    expect(await registry(fixture, { action: 'enable', operatorId: 'fixture', enabled: false, expectedRevision: 3 })).toMatchObject({ ok: true });
    expect(await registry(fixture, { action: 'admit', request })).toEqual(receipt);
    expect(await registry(fixture, { action: 'admit', request: { ...admission(), expectedRevision: 4 } }))
      .toEqual({ ok: false, reason: 'disabled' });
  });

  it.each([
    { intentDigest: 'c'.repeat(64) }, { operatorId: 'another' }, { expectedRevision: 4 }, { deadline: 1 },
  ])('rejects conflicting reuse of an activity ID: %j', async patch => {
    const fixture = await enabledRegistry();
    const request = admission();
    const receipt = await registry(fixture, { action: 'admit', request });
    expect(receipt).toMatchObject({ ok: true });
    expect(await registry(fixture, { action: 'admit', request: { ...request, ...patch } }))
      .toEqual({ ok: false, reason: 'activity-conflict' });
    expect(await registry(fixture, { action: 'receipt', activityId: request.activityId })).toEqual(receipt);
  });

  it('rejects expired new admission and creates no receipt', async () => {
    const fixture = await enabledRegistry();
    const request = { ...admission(), deadline: Date.now() - 1 };
    expect(await registry(fixture, { action: 'admit', request })).toEqual({ ok: false, reason: 'authority-expired' });
    expect(await registry(fixture, { action: 'receipt', activityId: request.activityId })).toEqual({ ok: true, value: null });
  });

  it('keeps an expired receipt readable but denies execution replay', async () => {
    const fixture = await enabledRegistry();
    const request = { ...admission(), deadline: Date.now() + 2000 };
    const receipt = await registry(fixture, { action: 'admit', request });
    expect(receipt).toMatchObject({ ok: true });
    await new Promise(resolve => setTimeout(resolve, Math.max(0, request.deadline - Date.now()) + 50));
    expect(await registry(fixture, { action: 'admit', request })).toEqual({ ok: false, reason: 'authority-expired' });
    expect(await registry(fixture, { action: 'receipt', activityId: request.activityId })).toEqual(receipt);
  });

  it('serializes concurrent disable/admit at the receipt creation point', async () => {
    const fixture = await enabledRegistry();
    const request = admission();
    const [admitted, disabled] = await Promise.all([
      registry(fixture, { action: 'admit', request }),
      registry(fixture, { action: 'enable', operatorId: 'fixture', enabled: false, expectedRevision: 3 }),
    ]);
    expect(disabled).toMatchObject({ ok: true, value: { enabled: false, revision: 4 } });
    const stored = await registry(fixture, { action: 'receipt', activityId: request.activityId });
    if (admitted.ok) expect(stored).toEqual(admitted);
    else {
      expect(['revision-conflict', 'disabled']).toContain(admitted.reason);
      expect(stored).toEqual({ ok: true, value: null });
    }
    expect(await registry(fixture, { action: 'admit', request: { ...admission(), expectedRevision: 4 } }))
      .toEqual({ ok: false, reason: 'disabled' });
  });
});

const START_TOKEN = 's'.repeat(43);
async function activity(id: string, command: ActivityFixtureCommand): Promise<unknown> {
  const response = await worker!.fetch(`/activity?activity=${id}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
  });
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result;
}
async function preparedActivity(patch: Partial<OperatorActivityPreparation> = {}, loseResponse = false) {
  const operatorId = `${loseResponse ? 'lost-response-' : 'operator-'}${crypto.randomUUID()}`;
  expect(await registry('registry', { action: 'create', operatorId })).toMatchObject({ ok: true });
  expect(await registry('registry', { action: 'approve', operatorId, artifactDigest: ARTIFACT, expectedRevision: 1 })).toMatchObject({ ok: true });
  expect(await registry('registry', { action: 'enable', operatorId, enabled: true, expectedRevision: 2 })).toMatchObject({ ok: true });
  const intent: OperatorActivityPreparation = {
    ...admission(), operatorId, startVerifier: createHash('sha256').update(START_TOKEN).digest('hex'),
    startExpiresAt: Date.now() + 60_000, ...patch,
  };
  expect(await activity(intent.activityId, { action: 'prepare', intent })).toEqual({ ok: true, phase: 'prepared' });
  return intent;
}

describe('REQ-OPERATOR-016: activity admission consume and queue', () => {
  it('prepares without admission and cannot overwrite an existing activity', async () => {
    const intent = await preparedActivity();
    expect(await registry('registry', { action: 'receipt', activityId: intent.activityId })).toEqual({ ok: true, value: null });
    expect(await activity(intent.activityId, { action: 'observe' })).toEqual({ activityId: intent.activityId, phase: 'prepared', receipt: null });
    expect(await activity(intent.activityId, { action: 'prepare', intent })).toEqual({ ok: false, reason: 'already-prepared' });
  });

  it('rejects an invalid capability before creating any registry receipt', async () => {
    const intent = await preparedActivity();
    expect(await activity(intent.activityId, { action: 'start', capability: 't'.repeat(43) })).toEqual({ ok: false, reason: 'invalid-capability' });
    expect(await registry('registry', { action: 'receipt', activityId: intent.activityId })).toEqual({ ok: true, value: null });
    expect(await activity(intent.activityId, { action: 'observe' })).toMatchObject({ phase: 'prepared' });
  });

  it.each([
    [{ startExpiresAt: 1 }, 'capability-expired'],
    [{ deadline: 1 }, 'authority-expired'],
  ] as const)('rejects expired admission before registry I/O: %j', async (patch, reason) => {
    const intent = await preparedActivity(patch);
    expect(await activity(intent.activityId, { action: 'start', capability: START_TOKEN })).toEqual({ ok: false, reason });
    expect(await registry('registry', { action: 'receipt', activityId: intent.activityId })).toEqual({ ok: true, value: null });
  });

  it('atomically consumes the start capability with one queued execution', async () => {
    const intent = await preparedActivity();
    const results = await Promise.all(Array.from({ length: 8 }, () => activity(intent.activityId, { action: 'start', capability: START_TOKEN })));
    expect(results.filter(result => (result as { ok: boolean }).ok)).toEqual([{ ok: true, phase: 'queued' }]);
    for (const result of results.filter(result => !(result as { ok: boolean }).ok)) {
      expect(result).toEqual({ ok: false, reason: 'already-started' });
    }
    expect(await activity(intent.activityId, { action: 'observe' })).toMatchObject({ phase: 'queued', receipt: {
      activityId: intent.activityId, operatorId: intent.operatorId, intentDigest: intent.intentDigest, artifactDigest: ARTIFACT,
    } });
    expect(await activity(intent.activityId, { action: 'start', capability: START_TOKEN })).toEqual({ ok: false, reason: 'already-started' });
  });

  it('does not queue when disablement wins admission', async () => {
    const intent = await preparedActivity();
    expect(await registry('registry', { action: 'enable', operatorId: intent.operatorId, enabled: false, expectedRevision: 3 })).toMatchObject({ ok: true });
    expect(await activity(intent.activityId, { action: 'start', capability: START_TOKEN })).toEqual({ ok: false, reason: 'admission-denied' });
    expect(await activity(intent.activityId, { action: 'observe' })).toMatchObject({ phase: 'admitting', receipt: null });
    expect(await registry('registry', { action: 'receipt', activityId: intent.activityId })).toEqual({ ok: true, value: null });
  });

  it('reconciles a lost admission response by the same activity before consume/queue', async () => {
    const intent = await preparedActivity({}, true);
    expect(await activity(intent.activityId, { action: 'start', capability: START_TOKEN })).toEqual({ ok: false, reason: 'admission-uncertain' });
    expect(await activity(intent.activityId, { action: 'observe' })).toMatchObject({ phase: 'admitting', receipt: null });
    const receipt = await registry('registry', { action: 'receipt', activityId: intent.activityId });
    expect(receipt).toMatchObject({ ok: true, value: { activityId: intent.activityId } });
    expect(await registry('registry', { action: 'enable', operatorId: intent.operatorId, enabled: false, expectedRevision: 3 })).toMatchObject({ ok: true });
    expect(await activity(intent.activityId, { action: 'start', capability: START_TOKEN })).toEqual({ ok: true, phase: 'queued' });
    expect(await registry('registry', { action: 'receipt', activityId: intent.activityId })).toEqual(receipt);
  });
});

async function queuedActivity(patch: Partial<OperatorActivityPreparation> = {}) {
  const intent = await preparedActivity(patch);
  expect(await activity(intent.activityId, { action: 'start', capability: START_TOKEN })).toEqual({ ok: true, phase: 'queued' });
  return intent;
}
const driveUpdate = (status: 'waiting' | 'completed' | 'failed' = 'waiting') => ({
  schemaVersion: 1, status, checkpoint: { step: 1 },
});

describe('REQ-OPERATOR-017: durable drive generation and checkpoint', () => {
  it('does not drive an unadmitted activity', async () => {
    const intent = await preparedActivity();
    expect(await activity(intent.activityId, { action: 'begin-drive' })).toEqual({ ok: false, reason: 'not-admitted' });
  });

  it('permits one running generation under concurrent requests', async () => {
    const { activityId } = await queuedActivity();
    const results = await Promise.all(Array.from({ length: 6 }, () => activity(activityId, { action: 'begin-drive' })));
    expect(results.filter(result => (result as { ok: boolean }).ok)).toEqual([
      { ok: true, state: { generation: 1, status: 'running', checkpoint: null, result: null } },
    ]);
    for (const result of results.filter(result => !(result as { ok: boolean }).ok)) {
      expect(result).toEqual({ ok: false, reason: 'drive-active' });
    }
  });

  it('persists waiting checkpoints and resumes with a fresh generation', async () => {
    const { activityId } = await queuedActivity();
    expect(await activity(activityId, { action: 'begin-drive' })).toMatchObject({ ok: true });
    expect(await activity(activityId, { action: 'commit-drive', generation: 1, update: driveUpdate() }))
      .toEqual({ ok: true, state: { generation: 1, status: 'waiting', checkpoint: { step: 1 }, result: null } });
    const instance = await activity(activityId, { action: 'instance' });
    await activity(activityId, { action: 'evict' });
    expect(await activity(activityId, { action: 'instance' })).not.toEqual(instance);
    expect(await activity(activityId, { action: 'begin-drive' }))
      .toEqual({ ok: true, state: { generation: 2, status: 'running', checkpoint: { step: 1 }, result: null } });
    expect(await activity(activityId, { action: 'commit-drive', generation: 1, update: driveUpdate('completed') }))
      .toEqual({ ok: false, reason: 'stale-drive' });
    expect(await activity(activityId, { action: 'commit-drive', generation: 2,
      update: { ...driveUpdate('completed'), result: { answer: 'fixture' } } }))
      .toMatchObject({ ok: true, state: { status: 'completed', result: { answer: 'fixture' } } });
    expect(await activity(activityId, { action: 'begin-drive' })).toEqual({ ok: false, reason: 'drive-settled' });
  });

  it('fences late results on cancellation without claiming cleanup completion', async () => {
    const { activityId } = await queuedActivity();
    expect(await activity(activityId, { action: 'begin-drive' })).toMatchObject({ ok: true });
    expect(await activity(activityId, { action: 'cancel-drive' })).toMatchObject({ ok: true, state: { generation: 2, status: 'cancel-requested' } });
    expect(await activity(activityId, { action: 'commit-drive', generation: 1, update: driveUpdate('completed') }))
      .toEqual({ ok: false, reason: 'stale-drive' });
    expect(await activity(activityId, { action: 'begin-drive' })).toEqual({ ok: false, reason: 'drive-settled' });
  });

  it('records interrupted work as unknown and never automatically replays it', async () => {
    const { activityId } = await queuedActivity();
    expect(await activity(activityId, { action: 'begin-drive' })).toMatchObject({ ok: true });
    expect(await activity(activityId, { action: 'interrupt-drive', generation: 9 })).toEqual({ ok: false, reason: 'stale-drive' });
    expect(await activity(activityId, { action: 'interrupt-drive', generation: 1 })).toMatchObject({ ok: true, state: { generation: 2, status: 'unknown' } });
    expect(await activity(activityId, { action: 'begin-drive' })).toEqual({ ok: false, reason: 'drive-settled' });
    expect(await activity(activityId, { action: 'commit-drive', generation: 1, update: driveUpdate() }))
      .toEqual({ ok: false, reason: 'stale-drive' });
  });

  it.each([
    { ...driveUpdate(), schemaVersion: 2 },
    { ...driveUpdate(), status: 'running' },
    { ...driveUpdate(), checkpoint: '🙂'.repeat(17000) },
    { ...driveUpdate(), principalId: 'attacker' },
  ])('rejects unsupported/oversized updates without advancing state: case %#', async update => {
    const { activityId } = await queuedActivity();
    expect(await activity(activityId, { action: 'begin-drive' })).toMatchObject({ ok: true });
    expect(await activity(activityId, { action: 'commit-drive', generation: 1, update }))
      .toEqual({ ok: false, reason: 'invalid-update' });
    expect(await activity(activityId, { action: 'commit-drive', generation: 1, update: driveUpdate() }))
      .toMatchObject({ ok: true, state: { generation: 1, status: 'waiting' } });
  });

  it('checks real human expiry again before drive start and checkpoint commit', async () => {
    const deadline = Date.now() + 3000;
    const { activityId } = await queuedActivity({ deadline });
    expect(await activity(activityId, { action: 'begin-drive' })).toMatchObject({ ok: true });
    await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now()) + 50));
    expect(await activity(activityId, { action: 'commit-drive', generation: 1, update: driveUpdate() }))
      .toEqual({ ok: false, reason: 'authority-expired' });
    expect(await activity(activityId, { action: 'begin-drive' })).toEqual({ ok: false, reason: 'authority-expired' });
  });
});

describe('REQ-OPERATOR-018: activity-driven Worker execution', () => {
  it('starts approved code and resumes a durable checkpoint in a fresh Worker after activity eviction', async () => {
    const { activityId } = await queuedActivity();
    expect(await activity(activityId, { action: 'drive-runtime' })).toMatchObject({ ok: true, state: {
      generation: 1, status: 'waiting', checkpoint: { step: 1 },
      result: { action: 'start', activityId, principal: 'fixture-owner', isolateCounter: 1 },
    } });
    const instance = await activity(activityId, { action: 'instance' });
    await activity(activityId, { action: 'evict' });
    expect(await activity(activityId, { action: 'instance' })).not.toEqual(instance);
    expect(await activity(activityId, { action: 'drive-runtime' })).toMatchObject({ ok: true, state: {
      generation: 2, status: 'completed', checkpoint: { step: 2 },
      result: { action: 'resume', activityId, principal: 'fixture-owner', isolateCounter: 1 },
    } });
    expect(await activity(activityId, { action: 'drive-runtime' })).toEqual({ ok: false, reason: 'drive-settled' });
  });

  it('REQ-OPERATOR-053: a delayed continuation cannot reserve or execute against a newer waiting checkpoint after eviction', async () => {
    const { activityId } = await preparedActivity();
    const start = await activity(activityId, { action: 'start-webhook', capability: START_TOKEN }) as {
      ok: boolean; readCapability: string;
    };
    expect(start.ok).toBe(true);
    expect(await activity(activityId, { action: 'drive-runtime' }))
      .toMatchObject({ ok: true, state: { generation: 1, status: 'waiting' } });
    expect(await activity(activityId, { action: 'begin-drive' }))
      .toMatchObject({ ok: true, state: { generation: 2 } });
    expect(await activity(activityId, { action: 'commit-drive', generation: 2,
      update: { schemaVersion: 1, status: 'waiting', checkpoint: { step: 2 } } }))
      .toMatchObject({ ok: true, state: { generation: 2, status: 'waiting' } });
    expect(await activity(activityId, { action: 'continue-webhook', capability: start.readCapability, generation: 2 }))
      .toEqual({ ok: true, phase: 'queued' });
    await activity(activityId, { action: 'evict' });
    expect(await activity(activityId, { action: 'drive-runtime', expectedGeneration: 1 }))
      .toEqual({ ok: false, reason: 'stale-drive' });
    expect(await activity(activityId, { action: 'drive-runtime', expectedGeneration: 2 }))
      .toMatchObject({ ok: true, state: { generation: 3, status: 'completed',
        result: { action: 'resume', activityId, principal: 'fixture-owner' } } });
  });

  it.each(['throw', 'oversized'] as const)('fences %s output as unknown without automatic replay', async failure => {
    const { activityId } = await queuedActivity();
    expect(await activity(activityId, { action: 'drive-runtime', failure })).toMatchObject({ ok: true, state: {
      generation: 2, status: 'unknown',
    } });
    expect(await activity(activityId, { action: 'drive-runtime' })).toEqual({ ok: false, reason: 'drive-settled' });
  });

  it('does not reserve a drive under an expired parent context', async () => {
    const { activityId } = await queuedActivity();
    expect(await activity(activityId, { action: 'drive-runtime', deadline: 1 })).toEqual({ ok: false, reason: 'authority-expired' });
    expect(await activity(activityId, { action: 'drive-runtime' })).toMatchObject({ ok: true, state: { generation: 1, status: 'waiting' } });
  });
});
