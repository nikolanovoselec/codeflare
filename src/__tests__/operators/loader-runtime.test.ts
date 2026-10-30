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
import type { OwnerRpcCommand, OwnerRpcConfig, OwnerRpcSnapshot } from './fixtures/dispatcher-owner-rpc';
import { getBucketName } from '../../lib/access';

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
      operationId: `review-${'a'.repeat(64)}`, cleanup: 'stopped', originalReports: [
        { lane: 'code-reviewer', packetDigest: 'a'.repeat(64) },
        { lane: 'spec-reviewer', packetDigest: 'a'.repeat(64) },
        { lane: 'doc-updater', packetDigest: 'a'.repeat(64) },
      ],
    } });
  });

});

// Owner/send correction: real default-compatible DO RPC, without an application,
// Flue facet, SDK session or model turn. Keep existing authority workloads unchanged.
async function ownerRpc(id: string, command: OwnerRpcCommand): Promise<OwnerRpcSnapshot> {
  const response = await worker!.fetch(`/dispatcher-owner-rpc?fixture=${id}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
  });
  expect(response.status, 'owner RPC fixture command must reach its configured boundary').toBe(200);
  return await response.json() as OwnerRpcSnapshot;
}
async function ownerRpcUntil(id: string, ready: (value: OwnerRpcSnapshot) => boolean, label: string, timeoutMs = 10_000,
  action: 'snapshot' | 'advance-body' = 'snapshot') {
  const stop = Date.now() + timeoutMs;
  let value: OwnerRpcSnapshot;
  do {
    value = await ownerRpc(id, { action });
    if (ready(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < stop);
  throw new Error(`Owner RPC bounded wait: ${label}; outcome=${value.outcome.status}; bodyOffered=${value.recipient.bodyOffered}; `
    + `bodyAdvanced=${value.recipient.bodyAdvanced}; bodyReleased=${value.recipient.bodyReleased}; cancelled=${value.recipient.cancelled}`);
}
async function ownerRpcBarrier(id: string, barrier: 'headers' | 'body') {
  const value = await ownerRpcUntil(id, value => value.outcome.status !== 'pending'
    || (barrier === 'headers' ? value.recipient.entered : value.recipient.bodyOffered), `${barrier} recipient barrier`);
  // A clone/configuration/import failure is NOT cancellation/authority RED evidence.
  expect(value.outcome, 'real RPC must reach the held recipient before injecting the fault').toEqual({ status: 'pending' });
  expect(value.recipient.entered).toBe(true);
  if (barrier === 'headers') expect(value.recipient.bodyOffered).toBe(false);
  else expect(value.recipient.bodyOffered).toBe(true);
  expect(value.recipient.bodyAdvanced).toBe(false);
  expect(value.recipient.bodyReleased).toBe(false);
  return value;
}
async function withOwnerRpc(config: OwnerRpcConfig, test: (id: string) => Promise<void>) {
  const id = crypto.randomUUID();
  expect(await ownerRpc(id, { action: 'start', config })).toEqual({ started: true });
  try { await test(id); }
  finally {
    // Always unblock an abort-ignoring recipient, even for an intentional RED.
    await ownerRpc(id, { action: 'cleanup' });
    await ownerRpcUntil(id, value => value.outcome.status !== 'pending', 'fixture cleanup');
  }
}
const rpcLogicalProfile = { source: 'pi-native', provider: 'configured-provider', model: 'logical/é-model',
  api: 'configured-api', reasoningLevel: 'low', profileDigest: 'd'.repeat(64) };
const rpcContext = { systemPrompt: 'Fixture system', messages: [
  { role: 'user', content: [{ type: 'text', text: 'Résumé fixture request' }] },
] };
// Wire digest is JSON-order-sensitive: original non-reasoning options, then the admitted level.
const rpcAdmittedOptions = { temperature: 0.25, maxTokens: 23, reasoning: 'low' };
const rpcResult = { role: 'assistant', provider: 'configured-provider', model: 'logical/é-model', api: 'configured-api',
  content: [{ type: 'text', text: 'Réponse ✓' }], stopReason: 'stop' };
function expectOwnerRpcWire(value: OwnerRpcSnapshot, operation: 'discovery' | 'inference') {
  expect(value.recipient.wire).toMatchObject({
    url: `http://container/operator-inference${operation === 'discovery' ? '/profile' : ''}`,
    method: 'POST', contentType: 'application/json', activityHeader: value.activityId, generationHeader: '7',
    schemaVersion: 1, activityId: value.activityId, generation: 7, sessionGeneration: 3,
  });
}

describe('REQ-OPERATOR-007/047/048: configured owner profile and inference over native RPC', () => {
  it.each(['discovery', 'inference'] as const)('REQ-OPERATOR-058/007/047/048: explicit ordinary source preparation reaches configured %s over existing native RPC without a Pi process', operation =>
    withOwnerRpc({ operation, prepareSource: true }, async id => {
      const value = await ownerRpcUntil(id, value => value.outcome.status !== 'pending', 'explicit prepared source transport');
      expect(value.preparation).toEqual({ activityId: value.activityId, deadline: value.deadline,
        invocationJson: '{"repository":"example/fixture"}', ownerSource: {
          bucket: getBucketName('owner@example.test'), sessionId: expect.stringMatching(/^[a-f0-9]{24}$/), sessionGeneration: 3,
        } });
      expectOwnerRpcWire(value, operation);
      if (operation === 'discovery') expect(value.outcome).toEqual({ status: 'accepted', profile: rpcLogicalProfile });
      else {
        expect(value.outcome).toMatchObject({ status: 'accepted', response: {
          events: [{ type: 'done', reason: 'stop', message: rpcResult }], result: rpcResult,
        } });
        expect(value.recipient.wire).toMatchObject({ context: rpcContext, options: rpcAdmittedOptions,
          profileDigest: rpcLogicalProfile.profileDigest });
      }
    }));

  it.each([
    { operation: 'discovery', loggingEnabled: true }, { operation: 'discovery', loggingEnabled: false },
    { operation: 'inference', loggingEnabled: true }, { operation: 'inference', loggingEnabled: false },
  ] as const)('REQ-OPERATOR-003/007/047/091: $operation delivers original logging=$loggingEnabled as a distinct native RPC argument without changing result authority', ({ operation, loggingEnabled }) =>
    withOwnerRpc({ operation, loggingEnabled }, async id => {
      const value = await ownerRpcUntil(id, value => value.outcome.status !== 'pending', 'trusted logging context native RPC');
      if (operation === 'discovery') expect(value.outcome).toEqual({ status: 'accepted', profile: rpcLogicalProfile });
      else expect(value.outcome).toMatchObject({ status: 'accepted', response: {
        events: [{ type: 'done', reason: 'stop', message: rpcResult }], result: rpcResult,
      } });
      expectOwnerRpcWire(value, operation);
      expect(value.recipient.loggingContext).toEqual({ activityId: value.activityId, generation: 7, loggingEnabled });
    }));
  // REQ-007 AC4/5: a saved logical custom identity, not a physical/vendor substitute.
  it('delivers the configured custom logical profile across real owner RPC with original Activity/generation/session wire', () =>
    withOwnerRpc({ operation: 'discovery' }, async id => {
      const value = await ownerRpcUntil(id, value => value.outcome.status !== 'pending', 'configured profile');
      expect(value.outcome).toEqual({ status: 'accepted', profile: rpcLogicalProfile });
      expectOwnerRpcWire(value, 'discovery');
    }));

  // REQ-007 AC5; REQ-048 AC6: public forwarding, admitted reasoning, exact result.
  it('forwards configured context/options with admitted Low instead of caller High and delivers the real RPC result', () =>
    withOwnerRpc({ operation: 'inference' }, async id => {
      const value = await ownerRpcUntil(id, value => value.outcome.status !== 'pending', 'configured inference');
      expect(value.outcome).toMatchObject({ status: 'accepted', response: {
        events: [{ type: 'done', reason: 'stop', message: rpcResult }], result: rpcResult,
      } });
      expectOwnerRpcWire(value, 'inference');
      expect(value.recipient.wire).toMatchObject({ operationId: 'fixture-inference', context: rpcContext,
        options: rpcAdmittedOptions, profileDigest: rpcLogicalProfile.profileDigest,
        requestDigest: createHash('sha256').update(JSON.stringify({ context: rpcContext, options: rpcAdmittedOptions })).digest('hex') });
    }));

  it.each([
    { source: 'managed-default', reasoningLevel: null, options: { temperature: 0.25, maxTokens: 23 } },
    { source: 'managed-off', reasoningLevel: 'off', options: { temperature: 0.25, maxTokens: 23, reasoning: 'off' } },
  ] as const)('preserves $source profile and forwarded reasoning without substituting Off for provider-default', async ({ source, reasoningLevel, options }) => {
    await withOwnerRpc({ operation: 'discovery', source }, async id => {
      const value = await ownerRpcUntil(id, value => value.outcome.status !== 'pending', 'managed profile');
      expect(value.outcome).toEqual({ status: 'accepted', profile: { source: 'managed', routeId: 'approved',
        provider: 'codeflare-gateway', model: 'approved', api: 'openai-completions', reasoningLevel, profileDigest: 'e'.repeat(64) } });
      expectOwnerRpcWire(value, 'discovery');
    });
    await withOwnerRpc({ operation: 'inference', source }, async id => {
      const value = await ownerRpcUntil(id, value => value.outcome.status !== 'pending', 'managed inference');
      expect(value.outcome).toMatchObject({ status: 'accepted', response: { result: { provider: 'codeflare-gateway', model: 'approved' } } });
      expect(value.recipient.wire?.options).toEqual(options);
      expect(value.recipient.wire?.requestDigest).toBe(createHash('sha256')
        .update(JSON.stringify({ context: rpcContext, options })).digest('hex'));
    });
  });

  describe.each(['discovery', 'inference'] as const)('%s cancellation, authority and finite body contracts', operation => {
    // REQ-047 AC2/3 and cancellable profile read; REQ-048 AC5/6.
    // Abort/deadline is local: headers MUST refuse while the remote call is held.
    // Deleting Request.signal alone cannot satisfy these header-wait cases.
    it.each([
      { barrier: 'headers', trigger: 'caller abort' }, { barrier: 'body', trigger: 'caller abort' },
      { barrier: 'headers', trigger: 'original deadline' }, { barrier: 'body', trigger: 'original deadline' },
    ] as const)('refuses $trigger while $barrier are held, before releasing valid late bytes', ({ barrier, trigger }) =>
      withOwnerRpc({ operation, barrier, lifetimeMs: trigger === 'original deadline' ? 10_000 : 30_000 }, async id => {
        const held = await ownerRpcBarrier(id, barrier);
        if (trigger === 'caller abort') await ownerRpc(id, { action: 'abort' });
        const refused = await ownerRpcUntil(id, value => value.outcome.status !== 'pending', 'refusal before barrier release',
          trigger === 'original deadline' ? Math.max(0, held.deadline - Date.now()) + 5000 : 5000);
        expect(refused.outcome).toMatchObject({ status: 'refused', failure: 'owner-refused' });
        expect(refused.recipient.bodyAdvanced).toBe(false);
        expect(refused.recipient.bodyReleased).toBe(false);
        expect(refused.recipient.headersReleased).toBe(false);
        if (trigger === 'original deadline') expect(Date.now()).toBeGreaterThanOrEqual(held.deadline);
        if (barrier === 'headers') await ownerRpc(id, { action: 'release-headers' });
        // Idle producer notification is not guaranteed by default RPC. Progress only
        // after refusal, without closing, and still require genuine source cancellation.
        const retired = await ownerRpcUntil(id, value => value.recipient.cancelled, 'late/open response body cancellation', 10_000, 'advance-body');
        expect(retired.recipient.bodyReleased).toBe(false);
        const late = await ownerRpc(id, { action: 'release-body' });
        expect(late.recipient.bodyReleased).toBe(true);
        expect(late.outcome).toEqual(refused.outcome);
      }));

    it.each(['aborted', 'expired'] as const)('refuses already %s authority before dispatch', fault =>
      withOwnerRpc({ operation, fault }, async id => {
        const value = await ownerRpcUntil(id, value => value.outcome.status !== 'pending', 'pre-dispatch cancellation');
        expect(value.outcome).toMatchObject({ status: 'refused', failure: 'owner-refused' });
        expect(value.recipient.entered).toBe(false);
      }));

    it.each(['generation', 'installation', 'grant', 'session'] as const)('refuses stale %s before dispatch', fault =>
      withOwnerRpc({ operation, fault }, async id => {
        const value = await ownerRpcUntil(id, value => value.outcome.status !== 'pending', 'pre-dispatch authority');
        expect(value.outcome).toMatchObject({ status: 'refused', failure: 'owner-refused' });
        expect(value.recipient.entered).toBe(false);
      }));

    describe.each(['headers', 'body'] as const)('post-%s authority recheck', barrier => {
      it.each(['generation', 'installation', 'grant', 'session'] as const)('refuses changed %s after a valid remote response without accepting its profile/result', fault =>
        withOwnerRpc({ operation, barrier }, async id => {
          await ownerRpcBarrier(id, barrier);
          await ownerRpc(id, { action: 'change', fault });
          await ownerRpc(id, { action: 'release-headers' });
          await ownerRpc(id, { action: 'release-body' });
          const value = await ownerRpcUntil(id, value => value.outcome.status !== 'pending', 'post-response authority refusal');
          expect(value.recipient.entered).toBe(true);
          expect(value.recipient.bodyReleased).toBe(true);
          expect(value.outcome).toMatchObject({ status: 'refused', failure: 'owner-refused' });
        }));
    });

    // REQ-047 AC5: actual UTF-8 bytes, not string length; no source-limit widening.
    it('accepts a complete valid response at the exact 1024-byte UTF-8 limit', () =>
      withOwnerRpc({ operation, size: 'exact' }, async id => {
        const value = await ownerRpcUntil(id, value => value.outcome.status !== 'pending', 'exact byte boundary');
        expect(value.outcome).toMatchObject(operation === 'discovery'
          ? { status: 'accepted', profile: rpcLogicalProfile }
          : { status: 'accepted', response: { result: rpcResult }, responseBytes: 1024 });
        expect(value.recipient.responseBytes).toBe(1024);
        expectOwnerRpcWire(value, operation);
      }));

    it.each(['actual-over', 'declared-over'] as const)('refuses %s response overflow without accepting a profile/result', size =>
      withOwnerRpc({ operation, size, barrier: size === 'declared-over' ? 'body' : 'none' }, async id => {
        if (size === 'declared-over') {
          // Deliberately withhold all actual bytes: the declared bound alone must refuse.
          await ownerRpcUntil(id, value => value.recipient.bodyOffered || value.outcome.status !== 'pending', 'declared oversized headers');
        }
        const value = await ownerRpcUntil(id, value => value.outcome.status !== 'pending', 'response byte refusal');
        expect(value.recipient.entered, 'bounds require an actual serialized Request, not a clone error').toBe(true);
        expect(value.outcome).toMatchObject({ status: 'refused', failure: 'owner-refused' });
        if (size === 'actual-over') expect(value.recipient.responseBytes).toBe(1025);
        else {
          expect(value.recipient.bodyAdvanced).toBe(false);
          expect(value.recipient.bodyReleased).toBe(false);
          const retired = await ownerRpcUntil(id, value => value.recipient.cancelled, 'declared oversized body retirement', 10_000, 'advance-body');
          expect(retired.recipient.bodyReleased).toBe(false);
          const late = await ownerRpc(id, { action: 'release-body' });
          expect(late.outcome).toEqual(value.outcome);
        }
      }));
  });
});

// Same Wrangler instance and canonical Backend tests (node) lane.
registerNativeDispatcherCases({
  fetch: async (path, init): Promise<Response> =>
    (await worker!.fetch(path, init as unknown as Parameters<Unstable_DevWorker['fetch']>[1])) as unknown as Response,
  reset: async () => { await worker?.stop(); await startWorker(); },
  queuedActivity,
  activity,
}, 'authority');

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
  it('REQ-OPERATOR-018: runtime-only capacity cannot widen an admitted legacy response bound or replay rejected output', async () => {
    const { activityId } = await queuedActivity();
    expect(await activity(activityId, { action: 'drive-runtime', responsePadding: 131072,
      capacityPolicy: { driveResponseBytes: 200000 } })).toMatchObject({ ok: true, state: {
      status: 'unknown', result: null,
    } });
    expect(await activity(activityId, { action: 'drive-runtime' })).toEqual({ ok: false, reason: 'drive-settled' });
  });

  it('REQ-OPERATOR-018: configured drive byte denial fences valid oversized output without replay', async () => {
    const { activityId } = await queuedActivity();
    expect(await activity(activityId, { action: 'drive-runtime', responsePadding: 2000,
      capacityPolicy: { driveResponseBytes: 1000 } })).toMatchObject({ ok: true, state: { status: 'unknown' } });
    expect(await activity(activityId, { action: 'drive-runtime' })).toEqual({ ok: false, reason: 'drive-settled' });
  });

  it('REQ-OPERATOR-018: configured drive timeout fences late output without extending original authority', async () => {
    const { activityId } = await queuedActivity();
    expect(await activity(activityId, { action: 'drive-runtime', delayMs: 150,
      capacityPolicy: { driveTimeoutMs: 50 } })).toMatchObject({ ok: true, state: { status: 'unknown' } });
    expect(await activity(activityId, { action: 'drive-runtime' })).toEqual({ ok: false, reason: 'drive-settled' });
  });

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
