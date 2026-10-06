/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Agent } from 'agents';
import { OperatorActivity, OperatorDispatcherCapability, createOperatorIntentDigest } from '../../operators/activity';
import { driveDispatcherRuntime } from '../../operators/runtime';
import { runOperatorActivity } from '../../operators/orchestrator';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import { parseDispatcherOperation } from '../../operators/operator-runtime-capability';
import { setLogLevel } from '../../lib/logger';
import type { DispatcherBundle } from '../../operators/distribution';
import type { Env } from '../../types';
import { operatorOwnerKey } from '../../operators/browser-activity';
import type { ProspectiveAdmission, CurrentProspectiveRegistration } from '../../operators/registry';

let callerSessionCurrent = true;
vi.mock('../../lib/access', async original => ({ ...await original<typeof import('../../lib/access')>(),
  resolveOperatorGroupIdentity: async (human: unknown) => human,
  resolveBucketName: async () => 'owner-bucket',
  resolveSessionAccessGroup: async () => [],
  operatorAccessSessionCurrent: async () => callerSessionCurrent,
  loadEnterpriseRouteConfig: async () => ({ routeCatalog: ['approved'], defaultRoute: 'approved', defaultReasoning: 'off' }),
}));
vi.mock('../../lib/aig-config', () => ({ getAigConfig: async () => ({ gatewayUrl: 'https://gateway.example.test', token: 'parent-only' }) }));

const bundle: DispatcherBundle = { schemaVersion: 1, sourceCommit: 'a'.repeat(40),
  versions: { runtime: '2.1.0', vitePlugin: '2.1.0', agents: '0.20.1' }, className: 'FlueDispatcherAgent',
  compatibilityDate: '2026-09-10', compatibilityFlags: ['nodejs_compat'], mainModule: 'index.js',
  modules: { 'index.js': { js: 'export class FlueDispatcherAgent {}' } } };
const bytes = new TextEncoder().encode(JSON.stringify(bundle));
const invocation = { repository: 'owner/repo', pullRequest: 17 };
const genericWire = (path: string, body: unknown) => new Request(`https://operator.internal/v1/dispatcher/${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('REQ-OPERATOR-063: reservation denial private wire', () => {
  const sourceUrl = 'https://api.github.com/repos/another/service';
  const inference = (operationId: string) => genericWire('inference', { operationId,
    input: { messages: [{ role: 'user', content: 'PRIVATE_RESERVATION_CONTENT {"activityId":"forged","generation":999}' }] } });
  const receipt = async (f: DispatcherFixture, operationId: string) => {
    const response = await f.capability.fetch(genericWire('receipt', { operationId }));
    expect(response.status).toBe(200);
    return await response.json() as { operationCount: number; operationLimit: number;
      requestDigest: string; responseDigest: string; phase: string };
  };
  const fillReads = async (f: DispatcherFixture, count: number) => {
    for (let index = 0; index < count; index++) {
      const response = await f.capability.fetch(genericWire('source', { operationId: `capacity-read-${index}`, url: sourceUrl }));
      expect(response.status).toBe(200);
      const value = await response.json() as { status: number; body: string };
      expect(value.status).toBe(200);
      expect(JSON.parse(value.body)).toMatchObject({ number: 17 });
    }
  };
  const fillMixedJournal = async (f: DispatcherFixture) => {
    await fillReads(f, 127);
    const response = await f.capability.fetch(inference('capacity-inference'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: [DONE]\n\n');
    expect(await receipt(f, 'capacity-read-0')).toMatchObject({ operationCount: 128, operationLimit: 128 });
  };
  const reservationEvents = (events: string[]) => events.map(value => JSON.parse(value) as {
    module: string; data: Record<string, unknown>;
  }).filter(value => value.module === 'dispatcher-settlement' && value.data?.stage === 'reservation').map(value => value.data);

  it.each(['source', 'inference'] as const)(
    'REQ-OPERATOR-063: reservation diagnostic wire reports operation-limit for %s without child content', resource => fixture(async f => {
      await start(f);
      await fillMixedJournal(f);
      const before = await f.activity.getBrowserDetail();
      const outbound = [...f.sent];
      const events: string[] = [];
      setLogLevel('warn');
      const spy = vi.spyOn(console, 'warn').mockImplementation(value => { events.push(String(value)); });
      try {
        const operationId = 'PRIVATE_RESERVATION_OPERATION';
        const response = await f.capability.fetch(resource === 'inference' ? inference(operationId)
          : genericWire('source', { operationId, url: sourceUrl, method: 'POST',
            body: '{"activityId":"forged","generation":999,"content":"PRIVATE_RESERVATION_CONTENT"}' }));
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED' });
        // Intentional private diagnostic wire: reason is the actual transaction branch, not an inferred SDK failure.
        expect(reservationEvents(events)).toEqual([{ stage: 'reservation', reason: 'operation-limit',
          activityId: f.activityId, generation: 1, resource, deadline: 'current', status: 403,
          operationCount: 128, operationLimit: 128 }]);
        expect(events.join('')).not.toContain('PRIVATE_RESERVATION');
        expect(await receipt(f, 'capacity-read-0')).toMatchObject({ operationCount: 128, operationLimit: 128 });
        expect((await f.capability.fetch(genericWire('receipt', { operationId }))).status).toBe(403);
        expect(f.sent).toEqual(outbound);
        expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: before!.result,
          cleanupStatus: before!.cleanupStatus, collectionStatus: before!.collectionStatus });
      } finally { spy.mockRestore(); setLogLevel('silent'); }
    }, { repositoryOnly: true, operationLimit: 128 }));

  it('REQ-OPERATOR-047: default 1024 journal counts distinct reads and inference while cached operations reuse slots', () => fixture(async f => {
    await start(f);
    await fillReads(f, 1023);
    expect((await f.capability.fetch(inference('default-inference'))).status).toBe(200);
    expect(await receipt(f, 'capacity-read-0')).toMatchObject({ operationCount: 1024, operationLimit: 1024 });
    expect((await f.capability.fetch(genericWire('source', { operationId: 'capacity-read-0', url: sourceUrl }))).status).toBe(200);
    expect((await f.capability.fetch(inference('default-inference'))).status).toBe(200);
    expect(await receipt(f, 'capacity-read-0')).toMatchObject({ operationCount: 1024, operationLimit: 1024 });
    expect((await f.capability.fetch(inference('new-over-default'))).status).toBe(403);
    expect((await f.capability.fetch(genericWire('source', { operationId: 'new-over-default-read', url: sourceUrl }))).status).toBe(403);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
  }, { repositoryOnly: true }), 120000);

  it.each([3, 129])('REQ-OPERATOR-047: admitted %i-operation budget denies fresh work at its exact boundary', operationLimit => fixture(async f => {
    await start(f);
    await fillReads(f, operationLimit);
    expect(await receipt(f, 'capacity-read-0')).toMatchObject({ operationCount: operationLimit, operationLimit });
    expect((await f.capability.fetch(inference('over-configured-budget'))).status).toBe(403);
    expect((await f.capability.fetch(genericWire('source', { operationId: 'capacity-read-0', url: sourceUrl }))).status).toBe(200);
    expect(await receipt(f, 'capacity-read-0')).toMatchObject({ operationCount: operationLimit, operationLimit });
    f.expire();
    expect((await f.capability.fetch(genericWire('receipt', { operationId: 'capacity-read-0' }))).status).toBe(403);
  }, { repositoryOnly: true, operationLimit }));

  it('REQ-OPERATOR-063: configured budget exhaustion reports actual count and limit without lifecycle changes', () => fixture(async f => {
    await start(f); await fillReads(f, 3);
    const before = await f.activity.getBrowserDetail();
    const events: string[] = [];
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { events.push(String(value)); });
    try {
      expect((await f.capability.fetch(inference('configured-budget-denied'))).status).toBe(403);
      expect(reservationEvents(events)).toEqual([{ stage: 'reservation', reason: 'operation-limit',
        activityId: f.activityId, generation: 1, resource: 'inference', deadline: 'current', status: 403,
        operationCount: 3, operationLimit: 3 }]);
      expect(await f.activity.getBrowserDetail()).toEqual(before);
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }, { repositoryOnly: true, operationLimit: 3 }));

  it('REQ-OPERATOR-047: full Dispatcher journal preserves receipts cached retries conflicts and unknown-mutation resolution', () => fixture(async f => {
    await start(f);
    await fillReads(f, 125);
    const comments = `${sourceUrl}/issues/17/comments`;
    const completed = { operationId: 'capacity-comment', method: 'POST', url: comments, body: '{"body":"completed judgment"}' };
    const unknown = { ...completed, operationId: 'capacity-unknown', body: '{"body":"uncertain judgment"}' };
    const posted = await f.capability.fetch(genericWire('source', completed));
    expect(posted.status).toBe(200);
    const postedBody = await posted.json();
    f.loseResponse();
    expect(await (await f.capability.fetch(genericWire('source', unknown))).json()).toEqual({ code: 'OPERATOR_OPERATION_UNKNOWN' });
    f.restoreTransport();
    const observed = await f.capability.fetch(genericWire('source', { operationId: 'capacity-readback', url: comments }));
    expect(observed.status).toBe(200);
    expect(JSON.parse((await observed.json() as { body: string }).body)).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: 'completed judgment' }), expect.objectContaining({ body: 'uncertain judgment' }),
    ]));
    const original = await receipt(f, unknown.operationId);
    const readback = await receipt(f, 'capacity-readback');
    expect(original).toMatchObject({ operationCount: 128, operationLimit: 128, phase: 'unknown' });
    const outbound = [...f.sent];
    expect(await (await f.capability.fetch(genericWire('source', completed))).json()).toEqual(postedBody);
    expect((await f.capability.fetch(genericWire('source', { operationId: 'capacity-read-0', url: sourceUrl }))).status).toBe(200);
    const conflict = await f.capability.fetch(genericWire('source', { ...completed, body: '{"body":"changed judgment"}' }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ code: 'OPERATOR_OPERATION_CONFLICT' });
    const uncertain = await f.capability.fetch(genericWire('source', unknown));
    expect(uncertain.status).toBe(409);
    expect(await uncertain.json()).toEqual({ code: 'OPERATOR_OPERATION_UNKNOWN' });
    const resolution = { operationId: unknown.operationId, requestDigest: original.requestDigest,
      readbacks: [{ operationId: 'capacity-readback', requestDigest: readback.requestDigest, responseDigest: readback.responseDigest }] };
    for (let repeat = 0; repeat < 2; repeat++) {
      const resolved = await f.capability.fetch(genericWire('resolve', resolution));
      expect(resolved.status).toBe(200);
      expect(await resolved.json()).toEqual({ resolved: true, operationId: unknown.operationId, requestDigest: original.requestDigest });
    }
    expect(await receipt(f, unknown.operationId)).toMatchObject({ operationCount: 128, operationLimit: 128, phase: 'completed' });
    expect(f.sent).toEqual(outbound);
    const denied = await f.capability.fetch(inference('new-at-capacity'));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED' });
  }, { repositoryOnly: true, operationLimit: 128 }));

  it('REQ-OPERATOR-063: reservation diagnostic wire reports lease-mismatch after concurrent cancellation without protected I/O', () => fixture(async f => {
    await start(f);
    let cancelled: Awaited<ReturnType<OperatorActivity['getBrowserDetail']>> = null;
    let alarm: number | null | undefined;
    f.afterRegistryResolve(async () => { await f.activity.cancelDrive(); cancelled = await f.activity.getBrowserDetail(); alarm = await f.nextAlarm(); });
    const events: string[] = [];
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { events.push(String(value)); });
    try {
      const response = await f.capability.fetch(inference('PRIVATE_LEASE_OPERATION'));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED' });
      expect(reservationEvents(events)).toEqual([{ stage: 'reservation', reason: 'lease-mismatch',
        activityId: f.activityId, generation: 1, resource: 'inference', deadline: 'current', status: 403 }]);
      expect(events.join('')).not.toContain('PRIVATE_');
      expect(f.sent).toEqual([]);
      expect(cancelled).toBeDefined();
      expect(await f.activity.getBrowserDetail()).toEqual(cancelled);
      expect(await f.nextAlarm()).toBe(alarm);
      expect((await f.capability.fetch(inference('old-capability'))).status).toBe(403);
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }, { repositoryOnly: true, operationLimit: 128 }));

  it.each(['operation-limit', 'lease-mismatch'] as const)(
    'REQ-OPERATOR-063: owner reservation logging outage preserves %s denial lifecycle and original authority', reason => fixture(async f => {
      await start(f);
      let baseline = await f.activity.getBrowserDetail();
      let alarm = await f.nextAlarm();
      if (reason === 'operation-limit') { await fillMixedJournal(f); baseline = await f.activity.getBrowserDetail(); }
      else f.afterRegistryResolve(async () => { await f.activity.cancelDrive(); baseline = await f.activity.getBrowserDetail(); alarm = await f.nextAlarm(); });
      const outbound = [...f.sent];
      setLogLevel('warn');
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('PRIVATE_LOGGING_OUTAGE'); });
      try {
        // Owner public transport, not the capability's outer catch: the original denial must resolve even when logging throws.
        const response = await f.activity.dispatcherOperation(1, inference('outage-denied'));
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED' });
        expect(f.sent).toEqual(outbound);
        expect(await f.activity.getBrowserDetail()).toEqual(baseline);
        expect(await f.nextAlarm()).toBe(alarm);
        spy.mockImplementation(() => {});
        if (reason === 'operation-limit') {
          expect(await receipt(f, 'capacity-read-0')).toMatchObject({ operationCount: 128, operationLimit: 128 });
          expect((await f.capability.fetch(genericWire('source', { operationId: 'capacity-read-0', url: sourceUrl }))).status).toBe(200);
        }
        expect((await f.capability.fetch(inference('still-denied'))).status).toBe(403);
        f.expire();
        expect((await f.capability.fetch(inference('expired-original-authority'))).status).toBe(403);
        expect(f.sent).toEqual(outbound);
      } finally { spy.mockRestore(); setLogLevel('silent'); }
    }, { repositoryOnly: true, operationLimit: 128 }));
});

describe('REQ-OPERATOR-047: generic Activity mutation receipts and resolution', () => {
  it('exposes the configured API origin only to repository-only Loader code', async () => {
    for (const repositoryOnly of [false, true]) await fixture(async f => {
      await start(f);
      expect((await f.loaderEnv()).GITHUB_API_ORIGIN).toBe(repositoryOnly ? 'https://github.enterprise.test' : undefined);
      expect((await f.loaderEnv()).OPERATOR_ADMITTED_TARGET).toBeUndefined();
      if (repositoryOnly) {
        for (const body of [
          { operationId: 'wrong-host', method: 'POST', url: 'https://api.github.com/repos/another/service/issues/17/comments', body: '{}' },
          { operationId: 'wrong-body', method: 'GET', url: 'https://github.enterprise.test/repos/another/service', body: '{}' },
          { operationId: 'credential-selector', url: 'https://github.enterprise.test/user', headers: { authorization: 'forged' } },
        ]) expect((await f.capability.fetch(genericWire('source', body))).status).toBe(403);
        const controller = new AbortController(); controller.abort();
        expect((await f.capability.fetch(new Request(genericWire('source', { operationId: 'cancelled-mutation', method: 'POST',
          url: 'https://github.enterprise.test/repos/another/service/issues/17/comments', body: '{}' }), { signal: controller.signal }))).status).toBe(403);
        expect(f.sent).toEqual([]);
        const request = () => genericWire('source', { operationId: 'merge-cas', method: 'PUT',
          url: 'https://github.enterprise.test/repos/another/service/pulls/17/merge', body: '{"sha":"expected-head"}' });
        expect((await f.capability.fetch(request())).status).toBe(200);
        expect((await f.capability.fetch(request())).status).toBe(200);
        expect(f.sent.filter(value => value.method === 'PUT')).toHaveLength(1);
        expect(await f.sent.filter(value => value.method === 'PUT')[0].json()).toEqual({ sha: 'expected-head' });
      }
    }, { repositoryOnly, githubApiHost: 'github.enterprise.test' });
  });
  it('projects actual journal consumption on receipts without charging cached receipt observations', async () => fixture(async f => {
    await start(f);
    const source = { operationId: 'budget-read', url: 'https://api.github.com/repos/another/service' };
    expect((await f.capability.fetch(genericWire('source', source))).status).toBe(200);
    const first = await (await f.capability.fetch(genericWire('receipt', { operationId: source.operationId }))).json() as { operationCount: number; operationLimit: number };
    expect(first.operationLimit).toBe(1024);
    expect(first.operationCount).toBeGreaterThanOrEqual(1);
    expect((await f.capability.fetch(genericWire('source', { ...source, operationId: 'budget-read-next' }))).status).toBe(200);
    const next = await (await f.capability.fetch(genericWire('receipt', { operationId: source.operationId }))).json() as { operationCount: number };
    expect(next.operationCount).toBe(first.operationCount + 1);
    expect(await (await f.capability.fetch(genericWire('receipt', { operationId: source.operationId }))).json()).toEqual(next);
  }, { repositoryOnly: true }));
  it('keeps missing or ambiguous package readback unknown and fences revoked installation', async () => {
    for (const evidence of [[], [{ id: 1 }, { id: 2 }]]) await fixture(async f => {
      await start(f);
      const mutation = { operationId: 'ambiguous-comment', method: 'POST',
        url: 'https://api.github.com/repos/another/service/issues/17/comments', body: '{"body":"judgment"}' };
      f.loseResponse();
      expect((await f.capability.fetch(genericWire('source', mutation))).status).toBe(409);
      f.restoreTransport(); f.genericReadback(evidence);
      const readback = await (await f.capability.fetch(genericWire('source', { operationId: 'ambiguous-read', url: mutation.url }))).json() as { body: string };
      expect(JSON.parse(readback.body)).toEqual(evidence);
      // No unique package-validated domain receipt exists: do not call resolve.
      expect((await f.capability.fetch(genericWire('receipt', { operationId: mutation.operationId }))).status).toBe(200);
      expect(await (await f.capability.fetch(genericWire('source', mutation))).json()).toEqual({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      f.revoke();
      expect((await f.capability.fetch(genericWire('source', mutation))).status).toBe(403);
      expect(f.sent.filter(value => value.method === 'POST')).toHaveLength(1);
    }, { repositoryOnly: true });
  });
  it('never repeats an uncertain mutation; permits readback and immutable resolution', async () => {
    await fixture(async f => {
      await start(f);
      const mutation = { operationId: 'comment-once', method: 'POST', url: 'https://api.github.com/repos/another/service/issues/17/comments', body: '{"body":"judgment"}' };
      f.loseResponse();
      expect(await (await f.capability.fetch(genericWire('source', mutation))).json()).toEqual({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      expect(await (await f.capability.fetch(genericWire('source', mutation))).json()).toEqual({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      expect(f.sent.filter(request => request.method === 'POST')).toHaveLength(1);
      expect(await (await f.capability.fetch(genericWire('source', { ...mutation, body: '{"body":"changed"}' }))).json()).toEqual({ code: 'OPERATOR_OPERATION_CONFLICT' });
      const original = await (await f.capability.fetch(genericWire('receipt', { operationId: mutation.operationId }))).json() as { requestDigest: string };
      const unresolved = { operationId: mutation.operationId, requestDigest: original.requestDigest, readbacks: [] };
      expect((await f.capability.fetch(genericWire('resolve', unresolved))).status).toBe(403);
      const absent = { operationId: 'missing', requestDigest: 'a'.repeat(64), responseDigest: 'b'.repeat(64) };
      expect(await (await f.capability.fetch(genericWire('resolve', { ...unresolved, readbacks: [absent] }))).json()).toEqual({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      f.restoreTransport();
      const readback = { operationId: 'read-comment', url: mutation.url };
      const evidence = await (await f.capability.fetch(genericWire('source', readback))).json() as { body: string };
      // Package code validates the remote actor/target/text before asking the generic parent to seal references.
      expect(JSON.parse(evidence.body)).toEqual([{ id: 91, body: 'judgment', user: { id: 42 } }]);
      const reference = await (await f.capability.fetch(genericWire('receipt', { operationId: readback.operationId }))).json() as { operationId: string; requestDigest: string; responseDigest: string };
      const resolution = { ...unresolved, readbacks: [{ operationId: reference.operationId,
        requestDigest: reference.requestDigest, responseDigest: reference.responseDigest }] };
      expect(await (await f.capability.fetch(genericWire('resolve', { ...resolution, readbacks: [resolution.readbacks[0], resolution.readbacks[0]] }))).json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED' });
      expect(await (await f.capability.fetch(genericWire('resolve', resolution))).json()).toEqual({ resolved: true, operationId: mutation.operationId, requestDigest: original.requestDigest });
      expect(await (await f.capability.fetch(genericWire('resolve', resolution))).json()).toEqual({ resolved: true, operationId: mutation.operationId, requestDigest: original.requestDigest });
      expect(f.sent.filter(request => request.method === 'POST')).toHaveLength(1);
      f.revokeSession();
      expect((await f.capability.fetch(genericWire('resolve', resolution))).status).toBe(403);
    }, { repositoryOnly: true });
  });
});
const guideExcerpt = 'To create a Dozzle agent, you need to run Dozzle with the `agent` subcommand.\n      - DOZZLE_REMOTE_AGENT=agent:7007';
const guideBlobSha = '9fd821c091950776b4aef53bdc5f55fc72df25af';
async function digest(value: string | Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string'
    ? new TextEncoder().encode(value) : value)), b => b.toString(16).padStart(2, '0')).join('');
}

/** Instrumented SDK owner, not native Flue proof: native cases remain in loader-runtime.test.ts. */
async function fixture(test: (f: {
  activity: OperatorActivity; capability: OperatorDispatcherCapability; staleCapability: OperatorDispatcherCapability; environment: Env;
  artifactDigest: string; activityId: string; deliverTail: (events: unknown) => Promise<void>;
  deliveredTail: Array<{ activityId: string; generation: number; stage: string }>;
  settle: (id?: string, outcome?: string, error?: unknown) => void; expire: () => void;
  advanceClock: (milliseconds: number) => void;
  seedLegacyJournal: (entries: Array<{ body: { operationId: string; url: string; method?: 'GET' | 'POST' | 'PUT'; body?: string };
    phase: 'reserved' | 'completed' | 'unknown'; ordinal: number; response?: unknown }>) => Promise<void>;
  revoke: () => void; sent: Request[]; childSubmissions: Request[]; abortStatus: () => string | undefined;
  restart: () => OperatorActivity; loseResponse: () => void; restoreTransport: () => void; throwTransport: () => void;
  emptyResponse: () => void; upstreamConflict: (enabled: boolean) => void; nextAlarm: () => Promise<number | null>;
  oversizedChecks: (count?: number, outputBytes?: number, overlap?: boolean) => void;
  messages: (value: unknown[]) => void; input: unknown; revokeSession: () => void;
  loaderEnv: () => Promise<Record<string, unknown>>; loaderOutbound: () => Promise<Fetcher | null>; genericReadback: (value: unknown) => void;
  sourceBody: (value: string) => void; files: (value: unknown[]) => void;
  compose: (value: Record<string, unknown>) => void;
  release: (value: unknown, status?: number) => void;
  guide: (value: unknown) => void; tag: (value: unknown) => void;
  annotatedTag: (value: unknown) => void;
  moveHeadAfterFiles: () => void;
  moveHeadAfterRelease: () => void; expireAfterRead: () => void;
  moveBaseAfterContents: () => void; moveBaseAfterGuide: () => void;
  exceedReleaseDeadline: () => void; exceedGuideDeadline: () => void;
  proof: ProspectiveAdmission; admittedTarget: Record<string, unknown>;
  changeProof: (patch: Record<string, unknown> | null) => void;
  changeRegistration: (patch: Partial<CurrentProspectiveRegistration> | null) => void;
  changeTarget: (patch: Record<string, unknown>) => void;
  afterTargetRead: (action: () => void | Promise<void>) => void; revokeGrant: () => void;
  afterRegistryResolve: (action: () => Promise<void>) => void;
}) => Promise<void>, options: { humanLifetimeSeconds?: number; repositoryOnly?: boolean; prospective?: boolean;
  legacyProspective?: boolean; inputExtra?: Record<string, unknown>; capabilities?: string[]; pagedStatus?: boolean; githubApiHost?: string;
  sourceResponseBytes?: number; sourceBody?: string; inferenceBody?: string; inferenceRequestBytes?: number; operationLimit?: number } = {}) {
  callerSessionCurrent = true;
  const fixtureInvocation = options.prospective ? { repository: 'nikolanovoselec/komodo',
    ...(options.legacyProspective ? { pullRequest: 17 } : {}), ...options.inputExtra }
    : options.repositoryOnly ? { repository: 'another/service' } : invocation;
  const namespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  await runInDurableObject(namespace.getByName(`dispatcher-${crypto.randomUUID()}`), async (_instance, native) => {
    const activityId = `activity-${crypto.randomUUID()}`;
    const artifactDigest = await digest(bytes);
    const now = Date.now();
    const expiresAt = Math.floor(now / 1000) + (options.humanLifetimeSeconds ?? 300);
    const human = { subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test',
      audiences: ['audience'], issuedAt: Math.floor(now / 1000) - 1, expiresAt };
    const policy = { capabilities: options.capabilities ?? ['fetch', 'inference'], resourceProfileId: null,
      ...(options.sourceResponseBytes === undefined ? {} : { sourceResponseBytes: options.sourceResponseBytes }) };
    const fixtureOperatorId = options.prospective ? 'renovate-dispatcher' : 'operator';
    const selection = { controlsRevision: 1, installation: { id: 'installation', operatorId: fixtureOperatorId, revision: 1,
      enabled: true, policy, configurationJson: '{}', releaseId: 'release' },
    operator: { operatorId: fixtureOperatorId, profile: 'dispatcher', revision: 1, invokers: { users: [human.email], groups: [] },
      policy: { ...policy, ...(options.operationLimit === undefined ? {} : { operationLimit: options.operationLimit }), ...(options.inferenceRequestBytes === undefined ? {} : { inferenceRequestBytes: options.inferenceRequestBytes }) } },
    release: { id: 'release', operatorId: fixtureOperatorId, bundleDigest: artifactDigest, sourceCommit: bundle.sourceCommit,
      ...(options.prospective ? { intentVersion: options.legacyProspective ? '2' : '3', coreVersion: '1' } : {}) },
    manifestJson: options.prospective ? JSON.stringify({ schemaVersion: 1, interfaceVersion: 1,
      id: 'renovate-dispatcher', name: 'Renovate Dispatcher', description: 'Prospective singleton fixture',
      coreVersion: '1', intentVersion: options.legacyProspective ? '2' : '3', profile: 'dispatcher',
      inputSchema: { type: 'object', additionalProperties: false,
        required: options.legacyProspective ? ['repository', 'pullRequest'] : ['repository'],
        properties: { repository: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
          ...(options.legacyProspective ? { pullRequest: { type: 'integer', minimum: 1 } } : {}) } },
      requiredCapabilities: ['inference', 'fetch'], artifact: { path: '/operator-bundle.json', sha256: artifactDigest } }) : '{}' };
    const proof: ProspectiveAdmission = { activityId, installationId: 'installation', repositoryId: 973175879,
      pullRequest: 17, head: 'b'.repeat(40), createdAt: new Date(now - 86_400_000).toISOString(),
      activatedAt: new Date(now - 2 * 86_400_000).toISOString(), ownerKey: await operatorOwnerKey(human),
      actor: { registrationId: 'scan-original', bucket: 'owner-bucket', sessionId: 'original-session',
        sessionGeneration: 3, subject: human.subject, issuer: human.issuer, email: human.email, audiences: human.audiences } };
    const admittedTarget = { repository: 'nikolanovoselec/komodo', repositoryId: proof.repositoryId,
      pullRequest: proof.pullRequest, headSha: proof.head, createdAt: proof.createdAt,
      createdAfter: proof.activatedAt, baseBranch: 'main' };
    let currentProof: Record<string, unknown> | null = structuredClone(proof) as unknown as Record<string, unknown>;
    let currentRegistration: CurrentProspectiveRegistration | null = { registrationId: proof.actor.registrationId,
      installationId: proof.installationId, activatedAt: proof.activatedAt, bucket: proof.actor.bucket,
      sessionId: proof.actor.sessionId, sessionGeneration: proof.actor.sessionGeneration, human, accessJwt: 'private.jwt' };
    let targetPatch: Record<string, unknown> = {};
    let afterTargetRead: (() => void | Promise<void>) | undefined;
    let afterRegistryResolve: (() => Promise<void>) | undefined;
    let revoked = false;
    let settlements: unknown[] = [];
    let messages: unknown[] = [];
    let streamBatch = 0;
    const streamOffset = () => `0000000000000000_${String(streamBatch).padStart(16, '0')}`;
    let messagesSet = false;
    let aborted: string | undefined;
    let uncertain = false;
    const genericComments: Array<{ id: number; body: string; user: { id: number } }> = [];
    let genericReadback: unknown;
    let loadedEnvironment: Promise<Record<string, unknown>> | undefined;
    let loadedOutbound: Promise<Fetcher | null> | undefined;
    let sourceBody = options.sourceBody ?? 'Official migration guidance';
    let transportThrows = false;
    let emptyResponse = false;
    let upstreamConflict = false;
    let oversizedChecks: { count: number; outputBytes: number; overlap: boolean } | null = null;
    let changedFiles: unknown[] = [];
    let composeBodies: Record<string, unknown> = {};
    let releaseBody: unknown = { tag_name: 'v11.1.2', body: 'No configuration changes', html_url: 'https://github.com/amir20/dozzle/releases/tag/v11.1.2' };
    let releaseStatus = 200;
    let guideBody: unknown = composeBlob('docs/guide/agent.md', guideBlobSha, guideExcerpt);
    let tagRef: unknown = { ref: 'refs/tags/v11.1.2', object: { type: 'tag', sha: '3'.repeat(40) } };
    let annotatedTag: unknown = { tag: 'v11.1.2', object: { type: 'commit', sha: '1'.repeat(40) } };
    let headSha = 'b'.repeat(40);
    let baseSha = 'a'.repeat(40);
    let moveAfterContents = false;
    let moveBaseAfterGuide = false;
    let moveAfterFiles = false;
    let moveAfterRelease = false;
    let expireAfterRead = false;
    let exceedDeadline = false;
    const sent: Request[] = [];
    const childSubmissions: Request[] = [];
    const deliveredTail: Array<{ activityId: string; generation: number; stage: string }> = [];
    let configuredTail: Promise<{ tail(events: unknown): Promise<void> }> | undefined;
    const pending: Promise<unknown>[] = [];
    let activity: OperatorActivity;
    const child = {
      _cf_initAsFacet: async () => {},
      _cf_checkRunFibersForFacet: async () => 0,
      _cf_dispatchScheduledCallback: async () => true,
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname.endsWith('/abort')) {
          aborted = (await activity.getBrowserDetail())?.executionStatus;
          return Response.json({ ok: true });
        }
        if (request.method === 'POST') {
          childSubmissions.push(request.clone());
          return Response.json({ submissionId: 'submission-1', offset: streamOffset(),
            uid: 'fixture-incarnation', streamUrl: request.url }, { status: 202, headers: { 'stream-next-offset': streamOffset() } });
        }
        const snapshot = { v: 1, conversationId: 'fixture-conversation', offset: streamOffset(), settlements,
          messages: messages.map((value, index) => ({ id: `fixture-message-${index}`, role: 'assistant',
            purpose: 'assistant', display: 'visible', ...value as object })) };
        const url = new URL(request.url);
        if (url.searchParams.get('view') === 'updates') {
          if (options.pagedStatus && settlements.length) {
            const pageOffset = '0000000000000000_0000000000000100';
            if (url.searchParams.get('offset') !== pageOffset) return Response.json([{ type: 'conversation-reset',
              conversationId: snapshot.conversationId, position: { batch: streamBatch, index: 0 },
              snapshot: { ...snapshot, settlements: [] } }], { headers: { 'stream-next-offset': pageOffset } });
            return Response.json(settlements.map((settlement, index) => ({ type: 'submission-settled',
              conversationId: snapshot.conversationId, position: { batch: streamBatch + 1, index }, ...settlement as object })),
            { headers: { 'stream-next-offset': '0000000000000000_0000000000000101', 'stream-up-to-date': 'true' } });
          }
          const chunks = url.searchParams.get('offset') === streamOffset() ? [] : [{ type: 'conversation-reset',
            conversationId: snapshot.conversationId, position: { batch: streamBatch, index: 0 }, snapshot }];
          return Response.json(chunks, { headers: { 'stream-next-offset': streamOffset(), 'stream-up-to-date': 'true' } });
        }
        return Response.json(snapshot, { headers: { 'stream-next-offset': streamOffset(), 'stream-up-to-date': 'true' } });
      },
    };
    // Agent validates the native DurableObjectState brand and SQLite capability.
    // Keep that real owner while replacing only the fixture's child/interceptor seams.
    Object.defineProperties(native, {
      facets: { configurable: true, value: { get: () => child } },
      exports: { configurable: true, value: {
        OperatorDispatcherCapability: ({ props }: { props: { activityId: string; generation: number } }) =>
          new OperatorDispatcherCapability({ props } as unknown as ExecutionContext,
            environment as unknown as ConstructorParameters<typeof OperatorDispatcherCapability>[1]),
        OperatorDispatcherTail: ({ props }: { props: { activityId: string; generation: number } }) => ({
          tail: async (events: unknown) => {
            const stage = (events as Array<{ logs: Array<{ message: Array<{ stage?: string }> }> }>)[0]?.logs?.[0]?.message?.[1]?.stage;
            if (stage) deliveredTail.push({ ...props, stage });
          },
        }),
        EgressController: () => ({ fetch: async () => new Response(sourceBody, {
          headers: { 'content-type': 'text/plain', etag: 'guide-v3', 'set-cookie': 'private-session' },
        }) }),
        GitHubInterceptor: ({ props }: { props: { bucket: string } }) => ({ fetch: async (request: Request) => {
          if (request.url.includes('/repos/community/compiler')) return Response.json({
            tag_name: 'v3.2.1', guidance: props.bucket === 'owner-bucket' ? 'Owned authenticated research' : 'Foreign private data',
          });
          sent.push(options.prospective ? request.clone() : request);
          if (options.prospective && request.method === 'GET') {
            if (transportThrows) throw new Error('Target authority unavailable');
            if (emptyResponse) return new Response(null, { status: 200 });
            const repositoryUrl = `https://${options.githubApiHost ?? 'api.github.com'}/repos/nikolanovoselec/komodo`;
            if (request.url === repositoryUrl) return Response.json({ id: proof.repositoryId,
              full_name: 'nikolanovoselec/komodo', ...(targetPatch.repository as object | undefined) });
            if (request.url === `${repositoryUrl}/pulls/17`) {
              const observed = { number: 17, state: 'open', draft: false, created_at: proof.createdAt,
                user: { login: 'renovate[bot]', id: 29139614, type: 'Bot' },
                base: { ref: 'main', sha: baseSha, repo: { id: proof.repositoryId, full_name: 'nikolanovoselec/komodo' } },
                head: { sha: headSha }, ...targetPatch };
              const action = afterTargetRead; afterTargetRead = undefined;
              await action?.();
              return Response.json(observed);
            }
          }
          if (request.url.endsWith('/issues/17/comments') && request.method === 'POST') {
            const data = await request.json() as { body: string };
            genericComments.push({ id: 91, body: data.body, user: { id: 42 } });
            if (uncertain) throw new Error('Lost mutation response');
            return Response.json(genericComments[0], { status: 201 });
          }
          if (request.url.endsWith('/issues/17/comments') && request.method === 'GET') return Response.json(genericReadback ?? genericComments);
          if (transportThrows) throw new Error('private transport failure');
          if (emptyResponse) return new Response(null, { status: 200 });
          if (uncertain) return Response.json({ error: 'lost response' }, { status: 502 });
          if (upstreamConflict) return Response.json({ error: 'upstream-conflict' }, { status: 409 });
          if (request.url.includes('/releases/tags/')) {
            if (moveAfterRelease) headSha = 'c'.repeat(40);
            if (exceedDeadline) vi.spyOn(Date, 'now').mockReturnValue(now + 9000);
            return Response.json(releaseBody, { status: releaseStatus });
          }
          if (request.url.includes('/git/ref/tags/')) return Response.json(tagRef);
          if (request.url.includes('/git/tags/')) return Response.json(annotatedTag);
          if (request.url.includes('/contents/docs/guide/agent.md')) {
            if (moveAfterRelease) headSha = 'c'.repeat(40);
            if (moveBaseAfterGuide) baseSha = 'c'.repeat(40);
            if (exceedDeadline) vi.spyOn(Date, 'now').mockReturnValue(now + 19_000);
            return guideBody instanceof Response ? guideBody : Response.json(guideBody);
          }
          if (request.url.includes('/contents/')) {
            const url = new URL(request.url);
            const key = `${url.searchParams.get('ref')}:${decodeURIComponent(url.pathname.split('/contents/')[1])}`;
            const body = composeBodies[key];
            if (moveAfterContents) baseSha = 'c'.repeat(40);
            return body instanceof Response ? body : body ? Response.json(body)
              : Response.json({ message: 'Missing' }, { status: 404 });
          }
          if (request.url.includes('/pulls/17/files')) {
            if (moveAfterFiles) headSha = 'c'.repeat(40);
            return Response.json(changedFiles);
          }
          const checks = oversizedChecks;
          if (checks && request.url.includes('/check-runs?')) {
            const url = new URL(request.url);
            const perPage = Number(url.searchParams.get('per_page'));
            const page = Number(url.searchParams.get('page'));
            const first = (page - 1) * perPage;
            const count = Math.max(0, Math.min(perPage, checks.count - first));
            return Response.json({ total_count: checks.count,
              check_runs: Array.from({ length: count }, (_, index) => ({ id: checks.overlap && first > 0 && index === 0
                ? first - 1 : first + index, name: `check-${first + index}`,
                conclusion: 'success', output: 'x'.repeat(checks.outputBytes) })) }, {
              headers: first + count < checks.count ? { link: '<https://api.github.com/next>; rel="next"' } : {},
            });
          }
          if (expireAfterRead) vi.spyOn(Date, 'now').mockReturnValue(expiresAt * 1000 + 1);
          return Response.json({ number: 17, body: 'inline-secret',
            user: { login: 'fork-specific-bot[bot]', id: 42, type: 'Bot' },
            base: { sha: baseSha }, head: { sha: headSha } });
        } }),
        LlmInterceptor: () => ({ fetch: async (request: Request) => {
          sent.push(request); if (uncertain) return Response.json({ error: 'lost response' }, { status: 502 });
          return new Response(options.inferenceBody ?? 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
        } }),
      } },
      waitUntil: { configurable: true, value: (promise: Promise<unknown>) => { pending.push(promise); } },
    });
    const context = native;
    const encryption = { ENCRYPTION_KEY: btoa('a'.repeat(32)) };
    const registry = { getManagementBundle: async () => bytes,
      resolveManagementExecution: async () => {
        const action = afterRegistryResolve; afterRegistryResolve = undefined;
        await action?.();
        return revoked ? { ok: false, reason: 'disabled' } : { ok: true, value: selection };
      },
      admitManagement: async (input: unknown) => ({ ok: true, value: { ...input as object, admittedAt: now, selection } }),
      upsertOwnedActivity: async () => {},
      readProspectiveRenovateAdmission: async () => structuredClone(currentProof),
      currentProspectiveRenovateRegistration: async () => structuredClone(currentRegistration),
    };
    const environment = { ...encryption, ENTERPRISE_MODE: 'active', GITHUB_API_HOST: options.githubApiHost,
      OPERATOR_REGISTRY: { getByName: () => registry }, OPERATOR_ACTIVITY: { getByName: () => activity, idFromName: () => native.id },
      LOADER: { get: (_key: string, factory: () => Promise<{ env: Record<string, unknown>; globalOutbound: Fetcher | null; tails?: Array<{ tail(events: unknown): Promise<void> }> }>) => ({
        getDurableObjectClass: () => {
          const code = factory();
          loadedEnvironment = code.then(value => value.env);
          loadedOutbound = code.then(value => value.globalOutbound);
          configuredTail = code.then(value => value.tails?.[0] as { tail(events: unknown): Promise<void> });
          return {};
        },
      }) },
    } as unknown as Env;
    const activityEnvironment = environment as unknown as ConstructorParameters<typeof OperatorActivity>[1];
    activity = new OperatorActivity(context, activityEnvironment);
    if (options.prospective) expect(await activity.bindProspectiveRenovateAdmission(activityId)).toBe(true);
    const invocationJson = JSON.stringify(fixtureInvocation);
    const execution = await createOperatorExecutionContext({ activityId, operatorId: fixtureOperatorId, artifactDigest,
      policyDigest: await digest(JSON.stringify(policy)), human, accessJwt: 'private.jwt' }, encryption);
    await activity.prepareAuthorized({ activityId, operatorId: fixtureOperatorId, installationId: 'installation',
      intentDigest: await createOperatorIntentDigest(fixtureOperatorId, activityId, invocationJson),
      expectedRevision: 1, expectedInstallationRevision: 1, expectedControlsRevision: 1,
      deadline: expiresAt * 1000, startExpiresAt: expiresAt * 1000, startVerifier: await digest('s'.repeat(43)) }, execution, invocationJson);
    expect(await activity.start('s'.repeat(43))).toEqual({ ok: true, phase: 'queued' });
    const capability = new OperatorDispatcherCapability({ props: { activityId, generation: 1 } } as unknown as ExecutionContext,
      environment as unknown as ConstructorParameters<typeof OperatorDispatcherCapability>[1]);
    const staleCapability = new OperatorDispatcherCapability({ props: { activityId, generation: 2 } } as unknown as ExecutionContext,
      environment as unknown as ConstructorParameters<typeof OperatorDispatcherCapability>[1]);
    try {
      await test({ activity, capability, staleCapability, environment, artifactDigest, activityId, deliveredTail,
        deliverTail: async events => { if (!configuredTail) throw new Error('No configured Dispatcher tail');
          await (await configuredTail).tail(events); }, sent, childSubmissions,
        settle: (id = 'submission-1', outcome = 'completed', error?: unknown) => {
          streamBatch++;
          settlements = [{ submissionId: id, outcome, error }];
          if (id === 'submission-1' && outcome === 'completed' && !messagesSet) {
            messages = [{ submissionId: id, parts: [{ type: 'data-assessment', data: {
              repository: 'owner/repo', pullRequest: 17, observedHead: 'b'.repeat(40), readOnly: true,
              assessment: { classification: 'unknown', reasons: ['No verified compatibility declaration'] },
            } }] }];
          }
        },
        input: fixtureInvocation, revokeSession: () => { callerSessionCurrent = false; },
        proof, admittedTarget,
        changeProof: patch => { currentProof = patch === null ? null : { ...currentProof, ...patch }; },
        changeRegistration: patch => { currentRegistration = patch === null ? null : { ...currentRegistration!, ...patch }; },
        changeTarget: patch => { targetPatch = { ...targetPatch, ...patch }; },
        afterTargetRead: action => { afterTargetRead = action; },
        afterRegistryResolve: action => { afterRegistryResolve = action; },
        revokeGrant: () => { selection.operator.invokers.users = []; },
        messages: value => { streamBatch++; messages = value; messagesSet = true; },
        sourceBody: value => { sourceBody = value; },
        files: value => { changedFiles = value; }, compose: value => { composeBodies = value; },
        release: (value, status = 200) => { releaseBody = value; releaseStatus = status; },
        guide: value => { guideBody = value; }, tag: value => { tagRef = value; },
        annotatedTag: value => { annotatedTag = value; },
        moveHeadAfterFiles: () => { moveAfterFiles = true; },
        moveHeadAfterRelease: () => { moveAfterRelease = true; },
        expireAfterRead: () => { expireAfterRead = true; },
        moveBaseAfterContents: () => { moveAfterContents = true; },
        moveBaseAfterGuide: () => { moveBaseAfterGuide = true; },
        exceedReleaseDeadline: () => { exceedDeadline = true; },
        exceedGuideDeadline: () => { exceedDeadline = true; },
        expire: () => { vi.spyOn(Date, 'now').mockReturnValue(expiresAt * 1000 + 1); },
        advanceClock: milliseconds => { vi.spyOn(Date, 'now').mockReturnValue(now + milliseconds); },
        revoke: () => { revoked = true; },
        abortStatus: () => aborted, restart: () => (activity = new OperatorActivity(context, activityEnvironment)),
        loseResponse: () => { uncertain = true; },
        restoreTransport: () => { uncertain = false; transportThrows = false; },
        genericReadback: value => { genericReadback = value; },
        loaderEnv: async () => { if (!loadedEnvironment) throw new Error('Loader not started'); return loadedEnvironment; },
        loaderOutbound: async () => { if (!loadedOutbound) throw new Error('Loader not started'); return loadedOutbound; },
        throwTransport: () => { transportThrows = true; },
        emptyResponse: () => { emptyResponse = true; },
        upstreamConflict: enabled => { upstreamConflict = enabled; },
        oversizedChecks: (count = 76, outputBytes = 3000, overlap = false) => {
          oversizedChecks = { count, outputBytes, overlap };
        },
        // Persist the pre-migration aggregate and response blobs in real SQLite storage.
        // This is fixture setup only; recovery assertions use the public capability wire.
        seedLegacyJournal: async entries => {
          const operations: Record<string, unknown> = {};
          for (const entry of entries) {
            const operation = await parseDispatcherOperation(genericWire('source', entry.body));
            const response = entry.response === undefined ? undefined : {
              status: 200, contentType: 'application/json', body: JSON.stringify(entry.response),
            };
            operations[entry.body.operationId] = { generation: 1, ordinal: entry.ordinal, phase: entry.phase,
              requestDigest: await digest(JSON.stringify({ path: operation.path, body: operation.body })),
              request: { method: entry.body.method ?? 'GET', url: entry.body.url },
              ...(response ? { responseDigest: await digest(response.body) } : {}) };
            if (response) await native.storage.put(`dispatcher:response:${entry.body.operationId}`, response);
          }
          await native.storage.put('dispatcher:operations', operations);
        },
        nextAlarm: () => native.storage.getAlarm(),
      });
    } finally {
      await activity.cancelDrive();
      vi.restoreAllMocks();
      await Promise.allSettled(pending);
    }
  });
}
function diagnosticReport(body: unknown = { stage: 'fetch-rejected' }, path = '/v1/dispatcher/diagnostic', method = 'POST') {
  const url = `https://operator.internal${path}`;
  if (method === 'GET') return new Request(url, { method: 'GET' });
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
function composeRead(operationId = 'compose-1', extra = {}) {
  return new Request('https://operator.internal/v1/dispatcher/github/read', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, resource: 'changed-compose', ...extra }) });
}
function releaseRead(operationId = 'release-1', extra = {}) {
  return new Request('https://operator.internal/v1/dispatcher/github/read', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, resource: 'release-notes', ...extra }) });
}
function guideRead(operationId = 'guide-1', extra = {}) {
  return new Request('https://operator.internal/v1/dispatcher/github/read', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, resource: 'upstream-guide', ...extra }) });
}
function changedCompose(path: string, sha = 'd'.repeat(40)) {
  return { filename: path, status: 'modified', sha, additions: 1, deletions: 1,
    patch: '-    image: amir20/dozzle:v11.1.1\n+    image: amir20/dozzle:v11.1.2' };
}
function composeBlob(path: string, sha: string, content: string) {
  return { path, sha, type: 'file', size: new TextEncoder().encode(content).byteLength,
    encoding: 'base64', content: btoa(content) };
}
function dozzleFiles(before = 'v11.1.1', after = 'v11.1.2') {
  return [{ filename: 'compose.yaml', status: 'modified', additions: 1, deletions: 1,
    patch: `-    image: amir20/dozzle:${before}\n+    image: amir20/dozzle:${after}` }];
}
function read(operationId = 'read-1', extra = {}) {
  return new Request('https://operator.internal/v1/dispatcher/github/read', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, resource: 'pull-request', ...extra }) });
}
async function start(f: Parameters<Parameters<typeof fixture>[0]>[0]) {
  return driveDispatcherRuntime({ activity: f.activity, deadline: Date.now() + 25_000,
    bundle, artifactDigest: f.artifactDigest, invocation: f.input });
}

describe('REQ-OPERATOR-047/048: production Dispatcher lease and restricted effects', () => {
  it('binds only this Activity and generation into the child Tail Worker', () => fixture(async f => {
    await start(f);
    await f.deliverTail([{ logs: [{ message: ['Dispatcher inference boundary', { stage: 'fetch-rejected' }] }] }]);
    expect(f.deliveredTail).toEqual([{ activityId: f.activityId, generation: 1, stage: 'fetch-rejected' }]);
  }));
  it('REQ-OPERATOR-048: bounded diagnostic report uses trusted Activity/generation and leaves execution running', () => fixture(async f => {
    await start(f);
    const before = await f.activity.getBrowserDetail();
    setLogLevel('warn');
    const events: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { events.push(String(value)); });
    try {
      expect((await f.capability.fetch(diagnosticReport())).status).toBe(204);
      expect((await f.capability.fetch(diagnosticReport({ stage: 'http-rejected', status: 422 }))).status).toBe(204);
      const reports = events.map(value => JSON.parse(value) as { module: string; data: Record<string, unknown> })
        .filter(value => value.module === 'dispatcher-inference-report');
      expect(reports.map(value => value.data)).toEqual([
        { activityId: f.activityId, generation: 1, stage: 'fetch-rejected' },
        { activityId: f.activityId, generation: 1, stage: 'http-rejected', status: 422 },
      ]);
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: before!.executionStatus,
        cleanupStatus: before!.cleanupStatus, checkpoint: before!.checkpoint, result: before!.result });
      expect((await f.capability.fetch(read('after-valid-report'))).status).toBe(200);
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));

  it.each([
    { stage: 'fetch-rejected', activityId: 'forged' }, { stage: 'fetch-rejected', reason: 'PRIVATE_PROVIDER_BODY_SENTINEL' },
    { stage: 'http-rejected', status: '422' }, { stage: 'http-rejected', status: 200 },
    { stage: 'http-rejected', status: 600 }, { stage: 'http-rejected', status: 422.5 },
    { stage: 'unknown' }, { stage: 'fetch-rejected', status: 422 }, 'PRIVATE_PROVIDER_BODY_SENTINEL',
  ])('REQ-OPERATOR-048: bounded diagnostic report rejects malformed child payload %#', body => fixture(async f => {
    await start(f);
    setLogLevel('warn');
    const events: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { events.push(String(value)); });
    try {
      expect((await f.capability.fetch(diagnosticReport(body))).status).toBe(403);
      expect(events.join('')).not.toContain('PRIVATE_PROVIDER_BODY_SENTINEL');
      expect(events.some(value => value.includes('dispatcher-inference-report'))).toBe(false);
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));

  it('REQ-OPERATOR-048: bounded diagnostic report denies wrong route, method, content-type, syntax, byte size and stale generation', () => fixture(async f => {
    await start(f);
    const url = 'https://operator.internal/v1/dispatcher/diagnostic';
    for (const request of [diagnosticReport(undefined, '/v1/dispatcher/unrelated'),
      diagnosticReport(undefined, '/v1/dispatcher/diagnostic', 'GET'),
      new Request(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"stage":"fetch-rejected"}' }),
      new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"stage":' }),
      new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: `${' '.repeat(300)}{"stage":"fetch-rejected"}` }),
      diagnosticReport({ stage: 'http-rejected' })]) {
      expect((await f.capability.fetch(request)).status).toBe(403);
    }
    expect((await f.staleCapability.fetch(diagnosticReport())).status).toBe(403);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    expect((await f.capability.fetch(read('after-rejected-report'))).status).toBe(200);
  }));

  it('REQ-OPERATOR-048: bounded diagnostic report refuses an unfinished body without holding the Activity', () => fixture(async f => {
    await start(f);
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"stage":"fetch-rejected"'));
    }, cancel() { canceled = true; } });
    const request = new Request('https://operator.internal/v1/dispatcher/diagnostic', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    const startedAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([f.capability.fetch(request),
        new Promise<'pending'>(resolve => { timer = setTimeout(() => resolve('pending'), 700); })]);
      expect(response).not.toBe('pending');
      expect((response as Response).status).toBe(403);
      expect(performance.now() - startedAt).toBeLessThan(400);
    } finally { clearTimeout(timer); }
    expect(canceled).toBe(true);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
  }));

  it('REQ-OPERATOR-048: bounded diagnostic report denies revoked authority without relying on cancellation', () => fixture(async f => {
    await start(f);
    f.revoke();
    expect((await f.capability.fetch(diagnosticReport())).status).toBe(403);
    expect((await f.activity.getBrowserDetail())?.result).toBeNull();
  }));

  it('REQ-OPERATOR-048: bounded diagnostic report denies cancellation without relying on expiry', () => fixture(async f => {
    await start(f);
    await f.activity.cancelDrive();
    expect((await f.capability.fetch(diagnosticReport())).status).toBe(403);
    expect((await f.activity.getBrowserDetail())?.result).toBeNull();
  }));

  it('REQ-OPERATOR-048: bounded diagnostic report never extends its original human deadline', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(diagnosticReport())).status).toBe(204);
    f.expire();
    expect((await f.capability.fetch(diagnosticReport())).status).toBe(403);
    expect((await f.capability.fetch(read('after-report-expiry'))).status).toBe(403);
    expect((await f.activity.getBrowserDetail())?.result).toBeNull();
  }));

  it('REQ-OPERATOR-048: bounded diagnostic report caps concurrent valid reports at eight per live Activity generation', () => fixture(async f => {
    await start(f);
    const responses = await Promise.all(Array.from({ length: 12 }, () => f.capability.fetch(diagnosticReport())));
    expect(responses.map(response => response.status).sort()).toEqual([
      ...Array.from({ length: 8 }, () => 204), ...Array.from({ length: 4 }, () => 429),
    ]);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
  }));

  it('REQ-OPERATOR-048: bounded diagnostic report tolerates unavailable owner logging without publishing a result', () => fixture(async f => {
    await start(f);
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('PRIVATE_REPORT_FAILURE'); });
    try {
      expect((await f.capability.fetch(diagnosticReport())).status).toBe(403);
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
      expect((await f.activity.getBrowserDetail())?.result).toBeNull();
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));

  it('exposes only PR identity, never a secret-bearing description', () => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(read('project-pr'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ number: 17, head: { sha: 'b'.repeat(40) }, base: { sha: 'a'.repeat(40) },
      user: { login: 'fork-specific-bot[bot]', id: 42, type: 'Bot' } });
    expect(JSON.stringify(body)).not.toContain('inline-secret');
  }));
  it('passes only complete image deltas from PR files, never secret-bearing patch context or other changes', () => fixture(async f => {
    await start(f);
    f.files([{ ...changedCompose('middleware/dozzle/compose.yaml'),
      patch: '@@ -1,3 +1,3 @@\n- image: amir20/dozzle:v11.1.1\n+ image: amir20/dozzle:v11.1.2\n  password: inline-secret' },
    { ...changedCompose('tools/dozzle_agent/compose.yaml'), additions: 2, deletions: 2,
      patch: '- image: amir20/dozzle:v11.1.1\n+ image: amir20/dozzle:v11.1.2\n- DOZZLE_AUTH_TOKEN=inline-secret\n+ DOZZLE_AUTH_TOKEN=other-secret' },
    { filename: 'private/inline-secret.txt', status: 'modified', additions: 1, deletions: 1,
      patch: '-password=inline-secret\n+password=other-secret' }]);
    const response = await f.capability.fetch(read('safe-files', { resource: 'files' }));
    expect(response.status).toBe(200);
    const result = await response.json() as { data: Array<{ patch: string | null; filename: string }> };
    expect(result.data).toMatchObject([
      { filename: 'middleware/dozzle/compose.yaml', patch: '- image: amir20/dozzle:v11.1.1\n+ image: amir20/dozzle:v11.1.2' },
      { filename: 'tools/dozzle_agent/compose.yaml', patch: null },
      { filename: '[other-changed-file]', patch: null },
    ]);
    expect(JSON.stringify(result)).not.toContain('inline-secret');
    expect(JSON.stringify(result)).not.toContain('other-secret');
  }));
  it('projects version-relevant default server and agent configuration without disclosing stable private values', () => fixture(async f => {
    await start(f);
    const paths = ['middleware/dozzle/compose.yaml', 'ai_llm/dozzle_agent/compose.yaml'];
    f.files(paths.map(path => changedCompose(path)));
    const bodies: Record<string, unknown> = {};
    for (const [index, path] of paths.entries()) {
      for (const [ref, tag, sha] of [['a'.repeat(40), 'v11.1.1', 'e'.repeat(40)],
        ['b'.repeat(40), 'v11.1.2', 'd'.repeat(40)]]) {
        bodies[`${ref}:${path}`] = composeBlob(path, sha, index === 0
          ? `services:\n  dozzle:\n    image: amir20/dozzle:${tag}\n    environment:\n      DOZZLE_REMOTE_AGENT: agent.internal:7007\n    volumes:\n      - /private/docker.sock:/var/run/docker.sock:ro\n    ports:\n      - '8080:8080'\n`
          : `services:\n  dozzle-agent:\n    image: amir20/dozzle:${tag}\n    command: agent\n    volumes:\n      - /private/docker.sock:/var/run/docker.sock:ro\n    ports:\n      - '7007:7007'\n`);
      }
    }
    f.compose(bodies);
    const response = await f.capability.fetch(composeRead());
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ files: [
      { path: paths[0], unchangedConfiguration: true,
        before: { services: [{ mode: 'server', redacted: true, environmentKeys: ['DOZZLE_REMOTE_AGENT'] }] },
        after: { services: [{ mode: 'server', redacted: true, environmentKeys: ['DOZZLE_REMOTE_AGENT'] }] } },
      { path: paths[1], unchangedConfiguration: true,
        before: { services: [{ mode: 'agent', redacted: false }] },
        after: { services: [{ mode: 'agent', redacted: false }] } },
    ] });
    expect(JSON.stringify(result)).not.toContain('agent.internal');
    expect(JSON.stringify(result)).not.toContain('/private/docker.sock');
  }));
  it('does not hide harmless unchanged ports and Docker socket mounts on a default server', () => fixture(async f => {
    await start(f); const path = 'middleware/dozzle/compose.yaml'; f.files([changedCompose(path)]);
    const bodies: Record<string, unknown> = {};
    for (const [ref, tag, sha] of [['a'.repeat(40), 'v11.1.1', 'e'.repeat(40)],
      ['b'.repeat(40), 'v11.1.2', 'd'.repeat(40)]]) {
      bodies[`${ref}:${path}`] = composeBlob(path, sha,
        `services:\n  dozzle:\n    image: amir20/dozzle:${tag}\n    container_name: private-dozzle\n    restart: unless-stopped\n    network_mode: bridge\n    volumes:\n      - /private/docker.sock:/var/run/docker.sock:ro\n    ports:\n      - '8080:8080'\n`);
    }
    f.compose(bodies);
    const response = await f.capability.fetch(composeRead());
    expect(response.status).toBe(200);
    const output = await response.json();
    expect(output).toMatchObject({ files: [{ unchangedConfiguration: true,
      before: { services: [{ mode: 'server', redacted: false }] },
      after: { services: [{ mode: 'server', redacted: false }] } }] });
    expect(JSON.stringify(output)).not.toContain('/private/docker.sock');
    expect(JSON.stringify(output)).not.toContain('private-dozzle');
  }));
  it.each([
    { name: 'persistent /data', property: "    volumes:\n      - /private/dozzle:/data\n" },
    { name: 'external env file', property: "    env_file: /private/agent.env\n" },
    { name: 'interpolated settings', property: "    environment:\n      DOZZLE_REMOTE_AGENT: ${DOZZLE_AGENTS}\n" },
    { name: 'external override', property: "    extends:\n      file: /private/shared.yml\n      service: dozzle\n" },
  ])('keeps $name unresolved despite unchanged image-excluded configuration', ({ property }) => fixture(async f => {
    await start(f); const path = 'middleware/dozzle/compose.yaml'; f.files([changedCompose(path)]);
    const bodies: Record<string, unknown> = {};
    for (const [ref, tag, sha] of [['a'.repeat(40), 'v11.1.1', 'e'.repeat(40)],
      ['b'.repeat(40), 'v11.1.2', 'd'.repeat(40)]]) {
      bodies[`${ref}:${path}`] = composeBlob(path, sha,
        `services:\n  dozzle:\n    image: amir20/dozzle:${tag}\n${property}`);
    }
    f.compose(bodies);
    const response = await f.capability.fetch(composeRead());
    expect(response.status).toBe(200);
    const output = await response.json();
    expect(output).toMatchObject({ files: [{ unchangedConfiguration: true,
      after: { services: [{ redacted: true }] } }] });
    expect(JSON.stringify(output)).not.toContain('/private/');
    expect(JSON.stringify(output)).not.toContain('${DOZZLE_AGENTS}');
  }));
  it('projects every admitted server and agent Compose blob at pinned base/head without leaking inline secrets', () => fixture(async f => {
    await start(f);
    const paths = ['middleware/dozzle/compose.yaml', 'tools/dozzle_agent/compose.yaml'];
    f.files(paths.map(path => changedCompose(path)));
    const bodies: Record<string, unknown> = {};
    for (const [index, path] of paths.entries()) {
      const service = index === 0 ? 'dozzle' : 'dozzle-agent';
      for (const [ref, tag, sha] of [['a'.repeat(40), 'v11.1.1', 'e'.repeat(40)],
        ['b'.repeat(40), 'v11.1.2', 'd'.repeat(40)]]) {
        bodies[`${ref}:${path}`] = composeBlob(path, sha,
          `services:\n  ${service}:\n    image: amir20/dozzle:${tag}\n    command: ${index === 0 ? 'server' : 'agent'}\n    environment:\n      DOZZLE_AUTH_TOKEN: inline-secret\n`);
      }
    }
    f.compose(bodies);
    const response = await f.capability.fetch(composeRead());
    expect(response.status).toBe(200);
    const result = await response.json() as { files: unknown[] };
    expect(result).toMatchObject({ repository: 'owner/repo', pullRequest: 17,
      baseSha: 'a'.repeat(40), observedHead: 'b'.repeat(40), files: paths.map(path => ({ path,
        before: { sha: 'e'.repeat(40), services: [{ image: 'amir20/dozzle:v11.1.1', mode: path.includes('agent') ? 'agent' : 'server', redacted: true }] },
        after: { sha: 'd'.repeat(40), services: [{ image: 'amir20/dozzle:v11.1.2', mode: path.includes('agent') ? 'agent' : 'server', redacted: true }] } })) });
    expect(JSON.stringify(result)).not.toContain('inline-secret');
    expect(JSON.stringify(result)).toContain('DOZZLE_AUTH_TOKEN');
  }));
  it('reads pinned Compose blobs despite an omitted diff patch without inferring safety', () => fixture(async f => {
    await start(f);
    const path = 'middleware/dozzle/compose.yaml';
    f.files([{ ...changedCompose(path), patch: undefined }]);
    f.compose({ [`${'a'.repeat(40)}:${path}`]: composeBlob(path, 'e'.repeat(40),
      'services:\n  dozzle:\n    image: amir20/dozzle:v11.1.1\n'),
    [`${'b'.repeat(40)}:${path}`]: composeBlob(path, 'd'.repeat(40),
      'services:\n  dozzle:\n    image: amir20/dozzle:v11.1.2\n') });
    const response = await f.capability.fetch(composeRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ files: [{ path, unchangedConfiguration: true,
      before: { sha: 'e'.repeat(40), services: [{ mode: 'server', redacted: false }] },
      after: { sha: 'd'.repeat(40), services: [{ mode: 'server', redacted: false }] } }] });
  }));
  it.each(['missing', 'wrong-sha', 'oversized', 'redirect', 'moved-base', 'moved-head', 'pagination', 'foreign-path'])('rejects $name changed Compose provenance', name => fixture(async f => {
    await start(f);
    const path = 'middleware/dozzle/compose.yaml';
    f.files(name === 'pagination' ? Array.from({ length: 101 }, (_, index) => changedCompose(`group-${index}/compose.yaml`))
      : [changedCompose(name === 'foreign-path' ? '../secrets/compose.yaml' : path)]);
    const before = composeBlob(path, 'e'.repeat(40), 'services:\n  dozzle:\n    image: amir20/dozzle:v11.1.1\n');
    const after = composeBlob(path, name === 'wrong-sha' ? 'f'.repeat(40) : 'd'.repeat(40),
      name === 'oversized' ? `services:\n  dozzle:\n    image: amir20/dozzle:v11.1.2\n    labels: ${'x'.repeat(70_000)}`
        : 'services:\n  dozzle:\n    image: amir20/dozzle:v11.1.2\n');
    f.compose({ [`${'a'.repeat(40)}:${path}`]: before,
      ...name === 'missing' ? {} : { [`${'b'.repeat(40)}:${path}`]: name === 'redirect'
        ? new Response(null, { status: 302, headers: { location: 'https://evil.invalid/' } }) : after } });
    if (name === 'moved-base') f.moveBaseAfterContents();
    if (name === 'moved-head') f.moveHeadAfterFiles();
    expect((await f.capability.fetch(composeRead())).status).toBe(409);
  }));
  it('rejects child-selected paths, refs and URLs before protected Compose I/O', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(composeRead('chosen', { path: 'other/compose.yaml' }))).status).toBe(403);
    expect((await f.capability.fetch(composeRead('chosen-ref', { ref: 'a'.repeat(40) }))).status).toBe(403);
    expect((await f.capability.fetch(composeRead('chosen-url', { url: 'https://evil.invalid/' }))).status).toBe(403);
  }));
  it('reads only the release identified by the admitted PR diff and returns a pinned receipt', () => fixture(async f => {
    await start(f); f.files(dozzleFiles());
    const response = await f.capability.fetch(releaseRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ observedHead: 'b'.repeat(40),
      source: 'https://github.com/amir20/dozzle/releases/tag/v11.1.2',
      repository: 'amir20/dozzle', tag: 'v11.1.2', body: 'No configuration changes' });
    expect(f.sent.map(r => r.url)).toEqual([
      'https://api.github.com/repos/owner/repo/pulls/17',
      'https://api.github.com/repos/owner/repo/pulls/17/files?per_page=100&page=1',
      'https://api.github.com/repos/owner/repo/pulls/17',
      'https://api.github.com/repos/amir20/dozzle/releases/tags/v11.1.2',
      'https://api.github.com/repos/owner/repo/pulls/17',
    ]);
    expect(f.sent.every(r => !r.headers.has('authorization') && r.redirect === 'manual')).toBe(true);
  }));
  it('reads one cited upstream release for thirteen compose image changes of Komodo #1299', () => fixture(async f => {
    await start(f);
    f.files(['ai_llm', 'dns_ntp', 'komodo_core', 'media_servers', 'minecraft', 'nextcloud',
      'openziti-i', 'openziti-ii', 'openziti-iii', 'servarr', 'storage', 'tools']
      .map(group => ({ ...dozzleFiles()[0], filename: `${group}/dozzle_agent/compose.yaml` }))
      .concat([{ ...dozzleFiles()[0], filename: 'middleware/dozzle/compose.yaml' }]));
    const response = await f.capability.fetch(releaseRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tag: 'v11.1.2', repository: 'amir20/dozzle',
      observedHead: 'b'.repeat(40) });
  }));
  it('derives a later eligible upstream release from the admitted PR rather than hardcoding #1299', () => fixture(async f => {
    await start(f); f.files(dozzleFiles('v11.1.2', 'v11.1.3'));
    f.release({ tag_name: 'v11.1.3', body: 'New migration notes',
      html_url: 'https://github.com/amir20/dozzle/releases/tag/v11.1.3' });
    const response = await f.capability.fetch(releaseRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tag: 'v11.1.3', body: 'New migration notes',
      source: 'https://github.com/amir20/dozzle/releases/tag/v11.1.3', observedHead: 'b'.repeat(40) });
  }));
  it('reads an immutable version-tagged official agent guide through a fixed parent source', () => fixture(async f => {
    await start(f); f.files(dozzleFiles());
    const response = await f.capability.fetch(guideRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ repository: 'amir20/dozzle', tag: 'v11.1.2',
      observedHead: 'b'.repeat(40), commitSha: '1'.repeat(40),
      source: `https://github.com/amir20/dozzle/blob/${'1'.repeat(40)}/docs/guide/agent.md`,
      body: expect.stringContaining('run Dozzle with the `agent` subcommand') });
    expect(f.sent.map(r => r.url)).toContain(
      `https://api.github.com/repos/amir20/dozzle/contents/docs/guide/agent.md?ref=${'1'.repeat(40)}`);
    expect(f.sent.every(r => !r.headers.has('authorization') && r.redirect === 'manual')).toBe(true);
  }));
  it('also binds a lightweight tag directly to a pinned guide commit', () => fixture(async f => {
    await start(f); f.files(dozzleFiles());
    f.tag({ ref: 'refs/tags/v11.1.2', object: { type: 'commit', sha: '1'.repeat(40) } });
    const response = await f.capability.fetch(guideRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tag: 'v11.1.2', commitSha: '1'.repeat(40) });
    expect(f.sent.some(r => r.url.includes('/git/tags/'))).toBe(false);
  }));
  it.each([
    { name: 'wrong version tag', replace: (f: { tag: (value: unknown) => void }) =>
      f.tag({ ref: 'refs/tags/v11.1.1', object: { type: 'tag', sha: '3'.repeat(40) } }) },
    { name: 'unresolved tag object', replace: (f: { annotatedTag: (value: unknown) => void }) =>
      f.annotatedTag({ tag: 'v11.1.2', object: { type: 'tag', sha: '1'.repeat(40) } }) },
    { name: 'mismatched annotated tag', replace: (f: { annotatedTag: (value: unknown) => void }) =>
      f.annotatedTag({ tag: 'v11.1.1', object: { type: 'commit', sha: '1'.repeat(40) } }) },
    { name: 'wrong guide path', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide(composeBlob('docs/other.md', '2'.repeat(40), 'not an agent guide')) },
    { name: 'redirected guide', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide(Response.json({ message: 'Moved' }, { status: 302 })) },
    { name: 'missing guide', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide(Response.json({ message: 'Missing' }, { status: 404 })) },
    { name: 'invalid guide encoding', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide({ ...composeBlob('docs/guide/agent.md', '2'.repeat(40), 'agent'), content: '$not-base64' }) },
    { name: 'mismatched guide blob SHA', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide(composeBlob('docs/guide/agent.md', '2'.repeat(40), guideExcerpt)) },
    { name: 'oversized guide', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide(composeBlob('docs/guide/agent.md', '2'.repeat(40), 'x'.repeat(70_000))) },
  ])('rejects a $name without exposing a guide to the child', ({ replace }) => fixture(async f => {
    await start(f); f.files(dozzleFiles()); replace(f);
    expect((await f.capability.fetch(guideRead())).status).toBe(409);
  }));
  it('rejects a moved PR while reading the version-tagged guide', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.moveHeadAfterRelease();
    expect((await f.capability.fetch(guideRead())).status).toBe(409);
  }));
  it('rejects a moved base while reading the version-tagged guide', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.moveBaseAfterGuide();
    expect((await f.capability.fetch(guideRead())).status).toBe(409);
  }));
  it('rejects a late guide even when the upstream transport ignores abort', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.exceedGuideDeadline();
    expect((await f.capability.fetch(guideRead())).status).toBe(409);
  }));
  it('denies child-selected guide URL, repository and ref before upstream I/O', () => fixture(async f => {
    await start(f); f.files(dozzleFiles());
    for (const extra of [{ url: 'https://evil.invalid/' }, { repository: 'other/repo' }, { ref: 'main' }]) {
      expect((await f.capability.fetch(guideRead('chosen', extra))).status).toBe(403);
    }
    expect(f.sent.every(r => !r.url.includes('/git/ref/tags/'))).toBe(true);
  }));
  it('rejects release evidence when the PR head changes after the files read', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.moveHeadAfterFiles();
    expect((await f.capability.fetch(releaseRead())).status).toBe(409);
  }));
  it('rejects release evidence when the PR head changes during the upstream read', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.moveHeadAfterRelease();
    expect((await f.capability.fetch(releaseRead())).status).toBe(409);
  }));
  it('does not return late upstream notes even when a transport ignores abort', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.exceedReleaseDeadline();
    expect((await f.capability.fetch(releaseRead())).status).toBe(409);
  }));
  it.each([
    { files: [], name: 'no matching diff' },
    { files: [...dozzleFiles(), { filename: 'agent/compose.yaml', status: 'modified', additions: 1,
      deletions: 1 }], name: 'unavailable Compose patch' },
    { files: [{ ...dozzleFiles()[0], additions: 2,
      patch: `${dozzleFiles()[0].patch}\n+ image: amir20/dozzle:v11.1.3` }], name: 'mixed edits in one Compose patch' },
    { files: [{ ...dozzleFiles()[0], additions: 2 }], name: 'truncated Compose patch' },
    { files: [{ filename: 'compose.yaml', status: 'modified', additions: 1, deletions: 1,
      patch: '- image: amir20/dozzle:v11.1.1\n+ image: attacker/dozzle:v11.1.2' }], name: 'foreign image' },
    { files: [...dozzleFiles(), { filename: 'other/compose.yaml', status: 'modified', additions: 1, deletions: 1,
      patch: '- image: amir20/dozzle:v11.1.1\n+ image: amir20/dozzle:v11.1.3' }], name: 'conflicting image tag' },
  ])('does not fetch upstream for $name', ({ files }) => fixture(async f => {
    await start(f); f.files(files);
    expect((await f.capability.fetch(releaseRead())).status).toBe(409);
    expect(f.sent.every(r => !r.url.includes('/releases/'))).toBe(true);
  }));
  it.each([
    { value: { tag_name: 'v11.1.2', body: 'notes', html_url: 'https://evil.test/note' }, status: 200 },
    { value: { tag_name: 'v11.1.1', body: 'notes', html_url: 'https://github.com/amir20/dozzle/releases/tag/v11.1.1' }, status: 200 },
    { value: { message: 'Moved' }, status: 302 },
    { value: { tag_name: 'v11.1.2', body: 'x'.repeat(70_000), html_url: 'https://github.com/amir20/dozzle/releases/tag/v11.1.2' }, status: 200 },
  ])('rejects unverified, redirecting or oversized upstream notes', ({ value, status }) => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.release(value, status);
    expect((await f.capability.fetch(releaseRead())).status).toBe(409);
  }));
  it('denies child URL, repository and credential selection on release read', () => fixture(async f => {
    await start(f); f.files(dozzleFiles());
    expect((await f.capability.fetch(releaseRead('release-foreign', { url: 'https://evil.test/' }))).status).toBe(403);
    expect((await f.capability.fetch(releaseRead('release-other', { repository: 'other/repo' }))).status).toBe(403);
    expect(f.sent.every(r => !r.url.includes('/releases/tags/'))).toBe(true);
  }));
  it('reserves once; admission and unrelated settlement remain running; exact settlement alone permits continuation', () => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true, state: { status: 'running', generation: 1 } });
    expect(await start(f)).toEqual({ ok: false, reason: 'drive-active' });
    expect(await f.activity.commitDrive(1, { schemaVersion: 1, status: 'waiting', checkpoint: null }))
      .toEqual({ ok: false, reason: 'invalid-update' });
    f.settle('foreign'); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('waiting');
    expect(await f.activity.beginDrive()).toMatchObject({ ok: true, state: { generation: 2 } });
    expect((await f.capability.fetch(read())).status).toBe(403);
  }));
  it('rechecks a later settlement before the bounded lease expires without caller continuation', () => fixture(async f => {
    const startedAt = Date.now();
    await start(f);
    await f.activity.reconcileDispatcherLease();
    const alarm = await f.nextAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThan(startedAt + 15_000);
    f.settle();
    vi.spyOn(Date, 'now').mockReturnValue(alarm! + 1_000);
    await f.activity.alarm();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('waiting');
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
      executionStatus: 'completed', result: { assessment: { classification: 'unknown' } },
    } });
  }));
  it('REQ-OPERATOR-048: repeated SDK alarms retain one pending recheck and the original deadline', () => fixture(async f => {
    await start(f);
    const deadline = (await f.activity.listSchedules()).find(row =>
      row.callback === 'reconcileDispatcherLease' && row.type === 'scheduled');
    expect(deadline).toBeDefined();
    await f.activity.reconcileDispatcherLease();
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    for (let i = 0; i < 12; i++) {
      const next = await f.nextAlarm();
      expect(next).not.toBeNull();
      expect(next!).toBeLessThan(now + 10_000);
      now = Math.max(now + 1_000, next! + 1_000);
      clock.mockReturnValue(now);
      await f.activity.alarm();
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
      const scheduled = await f.activity.listSchedules();
      expect(scheduled.filter(row => row.callback === 'reconcileDispatcherLease' && row.type === 'scheduled')
        .map(row => row.time)).toEqual([deadline?.time]);
      expect(scheduled.filter(row => row.callback === 'reconcileDispatcherLease' && row.type === 'delayed').length)
        .toBe(1);
    }
    f.settle();
    const next = await f.nextAlarm();
    expect(next).not.toBeNull();
    now = Math.max(now + 1_000, next! + 1_000);
    clock.mockReturnValue(now);
    await f.activity.alarm();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('waiting');
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
      executionStatus: 'completed', result: { assessment: { classification: 'unknown' } },
    } });
  }));
  it('REQ-OPERATOR-048: the original deadline still fences a pending SDK recheck', () => fixture(async f => {
    await start(f);
    const deadline = (await f.activity.listSchedules()).find(row =>
      row.callback === 'reconcileDispatcherLease' && row.type === 'scheduled');
    expect(deadline?.type).toBe('scheduled');
    await f.activity.reconcileDispatcherLease();
    vi.spyOn(Date, 'now').mockReturnValue(deadline!.time * 1_000 + 1_000);
    await f.activity.alarm();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }));
  it('collects two inference turns and the exact assessment past the former 90-second budget while authority remains current', () => fixture(async f => {
    await start(f);
    const inference = (operationId: string) => new Request('https://operator.internal/v1/dispatcher/inference', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId, input: { messages: [{ role: 'user', content: 'assess cited evidence' }] } }),
    });
    expect((await f.capability.fetch(inference('first-inference'))).status).toBe(200);
    f.advanceClock(112_000);
    expect((await f.capability.fetch(inference('second-inference'))).status).toBe(200);
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('waiting');
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
      executionStatus: 'completed', result: { assessment: { classification: 'unknown' } },
    } });
  }));
  it('fences a late assessment after the original human authorization expires', () => fixture(async f => {
    await start(f);
    f.advanceClock(301_000);
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect((await f.capability.fetch(read('late-assessment'))).status).toBe(403);
  }));
  it('never outlives a shorter original human-authorization deadline', () => fixture(async f => {
    await start(f);
    f.advanceClock(43_000);
    expect((await f.capability.fetch(read('before-human-expiry'))).status).toBe(200);
    f.advanceClock(46_000);
    expect((await f.capability.fetch(new Request('https://operator.internal/v1/dispatcher/inference', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'after-human-expiry', input: { messages: [{ role: 'user', content: 'assess' }] } }),
    }))).status).toBe(403);
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, { humanLifetimeSeconds: 45 }));
  it('denies a revoked invoker past the former 90-second cutoff while human authority is otherwise current', () => fixture(async f => {
    await start(f);
    f.advanceClock(112_000);
    expect((await f.capability.fetch(read('before-revocation'))).status).toBe(200);
    f.revoke();
    expect((await f.capability.fetch(read('after-revocation'))).status).toBe(403);
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
  }));
  it.each(['not-observed', 'succeeded', 'failed'] as const)(
    'REQ-OPERATOR-063: terminal diagnostic wire distinguishes %s completion from a missing assessment without accepting it', state => fixture(async f => {
      await start(f);
      const parts: unknown[] = [{ type: 'text', text: 'PRIVATE_MODEL_TEXT' }];
      if (state !== 'not-observed') parts.push({ type: 'dynamic-tool', toolName: 'finish_dispatcher',
        toolCallId: 'PRIVATE_TOOL_IDENTIFIER', state: state === 'succeeded' ? 'output-available' : 'output-error',
        output: 'PRIVATE_TOOL_OUTPUT', errorText: 'PRIVATE_TOOL_ERROR' });
      f.messages([{ submissionId: 'submission-1', parts }]);
      const emitted: string[] = [];
      setLogLevel('warn');
      const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
      try {
        f.settle(); await f.activity.reconcileDispatcherLease();
        const events = emitted.map(value => JSON.parse(value) as { module: string; message: string; data?: Record<string, unknown> })
          .filter(value => value.module === 'dispatcher-settlement' && value.message === 'Dispatcher settlement observed');
        expect(events).toHaveLength(1);
        expect(events[0].data).toEqual({ activityId: f.activityId, generation: 1, outcome: 'completed',
          projectedWrites: 0, assessmentPresent: false, messageCount: 1,
          completionCalls: state === 'not-observed' ? 0 : 1, completionSucceeded: state === 'succeeded' ? 1 : 0,
          completionFailed: state === 'failed' ? 1 : 0, completionPending: 0,
          completionTruncated: false, unmatchedAssessment: false });
        expect(emitted.join('')).not.toContain('PRIVATE_');
        expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
        expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
        expect(await start(f)).toEqual({ ok: false, reason: 'drive-settled' });
      } finally { spy.mockRestore(); setLogLevel('silent'); }
    }),
  );
  it('REQ-OPERATOR-063: terminal diagnostic wire confirms an observed assessment without exposing it', () => fixture(async f => {
    await start(f);
    const assessment = { readOnly: true, observedHead: 'b'.repeat(40), private: 'PRIVATE_ASSESSMENT_CONTENT' };
    f.messages([{ submissionId: 'submission-1', parts: [
      { type: 'dynamic-tool', toolName: 'finish_dispatcher', toolCallId: 'PRIVATE_TOOL_IDENTIFIER', state: 'output-available', output: assessment },
      { type: 'data-assessment', data: assessment },
    ] }]);
    const emitted: string[] = [];
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
    try {
      f.settle(); await f.activity.reconcileDispatcherLease();
      const event = emitted.map(value => JSON.parse(value) as { message: string; data?: Record<string, unknown> })
        .find(value => value.message === 'Dispatcher settlement observed');
      expect(event?.data).toMatchObject({ activityId: f.activityId, generation: 1, outcome: 'completed',
        projectedWrites: 1, assessmentPresent: true, completionCalls: 1, completionSucceeded: 1 });
      expect(emitted.join('')).not.toContain('PRIVATE_');
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: true, result: assessment } });
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));
  it.each(['capacity', 'receipt', 'ready'] as const)(
    'REQ-OPERATOR-076: seal-preflight.v1 trusted terminal %s metadata cannot authorize missing assessment', category => fixture(async f => {
      await start(f);
      const seal = { category, targetCount: 24, decisionCount: 24, sealed: category === 'ready',
        operationCount: category === 'receipt' ? null : 32, operationLimit: category === 'receipt' ? null : 128,
        requiredOperationCount: category === 'receipt' ? null : 97 };
      f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-dispatcher-seal-preflight', data: seal }] }]);
      const emitted: string[] = []; setLogLevel('warn');
      const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
      try {
        f.settle(); await f.activity.reconcileDispatcherLease();
        const observed = emitted.map(value => JSON.parse(value) as { message: string; data?: Record<string, unknown> })
          .find(value => value.message === 'Dispatcher settlement observed');
        expect(observed?.data).toMatchObject({ activityId: f.activityId, generation: 1, outcome: 'completed',
          projectedWrites: 0, assessmentPresent: false, producerSealObserved: true, producerSealTruncated: false,
          producerSealCategory: category, producerSealTargetCount: 24, producerSealDecisionCount: 24,
          producerSealSealed: category === 'ready', producerSealOperationCount: seal.operationCount,
          producerSealOperationLimit: seal.operationLimit, producerSealRequiredOperationCount: seal.requiredOperationCount });
        expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
        expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      } finally { spy.mockRestore(); setLogLevel('silent'); }
    }),
  );
  it('REQ-OPERATOR-076: invalid seal-preflight.v1 cannot expose private content or block validated collection', () => fixture(async f => {
    await start(f);
    const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
    f.messages([{ submissionId: 'submission-1', parts: [
      { type: 'data-dispatcher-seal-preflight', data: { category: 'PRIVATE_PRODUCER_CONTENT', receipt: 'PRIVATE_RECEIPT_CONTENT' } },
      { type: 'data-assessment', data: assessment },
    ] }]);
    const emitted: string[] = []; setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
    try {
      f.settle(); await f.activity.reconcileDispatcherLease();
      const observed = emitted.map(value => JSON.parse(value) as { message: string; data?: Record<string, unknown> })
        .find(value => value.message === 'Dispatcher settlement observed');
      expect(observed?.data).toMatchObject({ activityId: f.activityId, generation: 1,
        projectedWrites: 1, assessmentPresent: true, producerSealObserved: false, producerSealTruncated: true });
      expect(emitted.join('')).not.toContain('PRIVATE_');
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: true, result: assessment } });
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));
  it('REQ-OPERATOR-076: seal-preflight.v1 logger outage preserves actual collection and SDK release', () => fixture(async f => {
    await start(f);
    const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
    f.messages([{ submissionId: 'submission-1', parts: [
      { type: 'data-dispatcher-seal-preflight', data: { category: 'ready', targetCount: 1, decisionCount: 1,
        operationCount: 10, operationLimit: 128, requiredOperationCount: 5, sealed: true } },
      { type: 'data-assessment', data: assessment },
    ] }]);
    setLogLevel('warn'); const spy = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('PRIVATE_LOGGER_ERROR'); });
    try {
      f.settle(); await f.activity.reconcileDispatcherLease();
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: true, result: assessment } });
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));
  it.each(['ready', 'incomplete-results', 'unknown-operation'] as const)(
    'REQ-OPERATOR-063: readiness.v1 terminal wire exposes trusted closed %s metadata without accepting a missing assessment', category => fixture(async f => {
      await start(f);
      f.messages([{ submissionId: 'submission-1', parts: [
        { type: 'data-dispatcher-readiness', data: { discovered: true, sealed: true,
          targetCount: 2, decisionCount: 2, resultCount: category === 'ready' ? 2 : 1,
          unknownOperationCount: category === 'unknown-operation' ? 1 : 0, category } },
        { type: 'dynamic-tool', toolName: 'finish_dispatcher', toolCallId: 'PRIVATE_TOOL_IDENTIFIER',
          state: 'output-error', errorText: 'PRIVATE_TOOL_ERROR' },
      ] }]);
      const emitted: string[] = []; setLogLevel('warn');
      const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
      try {
        f.settle(); await f.activity.reconcileDispatcherLease();
        const observed = emitted.map(value => JSON.parse(value) as { message: string; data?: Record<string, unknown> })
          .find(value => value.message === 'Dispatcher settlement observed');
        expect(observed?.data).toMatchObject({ activityId: f.activityId, generation: 1, outcome: 'completed',
          projectedWrites: 0, assessmentPresent: false, producerReadinessObserved: true, producerReadinessTruncated: false,
          producerCategory: category, producerDiscovered: true, producerSealed: true,
          producerTargetCount: 2, producerDecisionCount: 2, producerResultCount: category === 'ready' ? 2 : 1,
          producerUnknownOperationCount: category === 'unknown-operation' ? 1 : 0 });
        expect(emitted.join('')).not.toContain('PRIVATE_');
        expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
        expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      } finally { spy.mockRestore(); setLogLevel('silent'); }
    }),
  );
  it('REQ-OPERATOR-063: invalid readiness.v1 terminal wire cannot expose content or block validated collection', () => fixture(async f => {
    await start(f);
    const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
    f.messages([{ submissionId: 'submission-1', parts: [
      { type: 'data-dispatcher-readiness', data: { category: 'PRIVATE_PRODUCER_CONTENT' } },
      { type: 'data-assessment', data: assessment },
    ] }]);
    const emitted: string[] = []; setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
    try {
      f.settle(); await f.activity.reconcileDispatcherLease();
      const observed = emitted.map(value => JSON.parse(value) as { message: string; data?: Record<string, unknown> })
        .find(value => value.message === 'Dispatcher settlement observed');
      expect(observed?.data).toMatchObject({ activityId: f.activityId, generation: 1,
        projectedWrites: 1, assessmentPresent: true, producerReadinessObserved: false, producerReadinessTruncated: true });
      expect(emitted.join('')).not.toContain('PRIVATE_');
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: true, result: assessment } });
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));
  it('REQ-OPERATOR-063: readiness.v1 logging outage preserves actual result and SDK release', () => fixture(async f => {
    await start(f);
    const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
    f.messages([{ submissionId: 'submission-1', parts: [
      { type: 'data-dispatcher-readiness', data: { discovered: true, sealed: false,
        targetCount: 0, decisionCount: 0, resultCount: 0, unknownOperationCount: 0, category: 'ready' } },
      { type: 'data-assessment', data: assessment },
    ] }]);
    setLogLevel('warn'); const spy = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('PRIVATE_LOGGER_ERROR'); });
    try {
      f.settle(); await f.activity.reconcileDispatcherLease();
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: true, result: assessment } });
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));
  it('REQ-OPERATOR-063: unavailable terminal diagnostic logging cannot prevent valid collection or SDK release', () => fixture(async f => {
    await start(f);
    const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('PRIVATE_LOGGING_FAILURE'); });
    try {
      f.settle(); await f.activity.reconcileDispatcherLease();
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: true, result: assessment } });
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));
  it('fences a completed model turn with no submitted assessment instead of advertising waiting', () => fixture(async f => {
    await start(f);
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'text', text: 'Assessment incomplete' }] }]);
    f.settle();
    await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }));
  it('fences failed settlement rather than granting a continuation', () => fixture(async f => {
    await start(f); f.settle('submission-1', 'failed'); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect(await start(f)).toEqual({ ok: false, reason: 'drive-settled' });
  }));
  for (const { name, error, errorType, operation, classification } of [
    { name: 'known model completion failure', error: { type: 'operation_failed', meta: {
      operation: 'prompt', reason: 'Stream ended without finish_reason (retryable_interruption)' } }, errorType: 'operation_failed', operation: 'prompt', classification: 'model-completion' },
    { name: 'durable direct model completion failure', error: { type: 'operation_failed', meta: {
      operation: 'direct(submission-1)', reason: 'Stream ended without finish_reason (retryable_interruption)' } },
      errorType: 'operation_failed', operation: 'direct', classification: 'model-completion' },
    { name: 'durable direct persistence failure', error: { type: 'operation_failed', meta: {
      operation: 'direct(submission-1)', reason: 'the input could not be persisted' } },
      errorType: 'operation_failed', operation: 'direct', classification: 'persistence' },
    { name: 'untrusted direct label suffix', error: { type: 'operation_failed', meta: {
      operation: 'direct(submission-1) private.jwt', reason: 'the input could not be persisted' } },
      errorType: 'operation_failed', operation: 'unknown', classification: 'unknown' },
    { name: 'other submission direct label', error: { type: 'operation_failed', meta: {
      operation: 'direct(other-submission)', reason: 'the input could not be persisted' } },
      errorType: 'operation_failed', operation: 'unknown', classification: 'unknown' },
    { name: 'known input supersession', error: { type: 'operation_failed', meta: {
      operation: 'prompt', reason: 'the session advanced past this input before it completed' } }, errorType: 'operation_failed', operation: 'prompt', classification: 'superseded' },
    { name: 'known input persistence failure', error: { type: 'operation_failed', meta: {
      operation: 'prompt', reason: 'the input could not be persisted' } }, errorType: 'operation_failed', operation: 'prompt', classification: 'persistence' },
    { name: 'secret-suffixed completion lookalike', error: { type: 'operation_failed', meta: {
      operation: 'prompt', reason: 'Stream ended without finish_reason (retryable_interruption) private.jwt' } },
      errorType: 'operation_failed', operation: 'prompt', classification: 'unknown' },
    { name: 'unrecognized metadata', error: { type: 'operation_failed', meta: {
      operation: 'arbitrary-secret', reason: 'inline-secret' } }, errorType: 'operation_failed', operation: 'unknown', classification: 'unknown' },
    { name: 'malformed metadata', error: { type: 'operation_failed', meta: { operation: { secret: 'private.jwt' }, reason: { secret: 'inline-secret' } } },
      errorType: 'operation_failed', operation: 'unknown', classification: 'unknown' },
    { name: 'absent error', error: undefined, errorType: 'other', operation: 'unknown', classification: 'unknown' },
    { name: 'absent metadata', error: { type: 'operation_failed' }, errorType: 'operation_failed', operation: 'unknown', classification: 'unknown' },
    { name: 'null metadata', error: { type: 'operation_failed', meta: null }, errorType: 'operation_failed', operation: 'unknown', classification: 'unknown' },
    { name: 'unrecognized error type', error: { type: 'inline-secret', meta: { operation: 'prompt', reason: 'Stream ended without finish_reason (retryable_interruption)' } },
      errorType: 'other', operation: 'unknown', classification: 'unknown' },
  ]) {
    it(`REQ-OPERATOR-048: diagnoses ${name} without leaking settlement metadata or replaying`, () => fixture(async f => {
      await start(f);
      const emitted: string[] = [];
      setLogLevel('warn');
      try {
        vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
        f.settle('submission-1', 'failed', error);
        await f.activity.reconcileDispatcherLease();
        const events = emitted.map(value => JSON.parse(value) as { module: string; message: string;
          data?: Record<string, unknown> }).filter(event => event.module === 'dispatcher-settlement'
          && event.message === 'Dispatcher settlement rejected' && event.data?.stage === 'outcome');
        expect(events).toHaveLength(1);
        const detail = await f.activity.getBrowserDetail();
        expect(detail?.activityId).toMatch(/^activity-[0-9a-f-]{36}$/);
        expect(events[0].data).toMatchObject({ activityId: detail?.activityId,
          generation: 1, outcome: 'failed', errorType, operation, failureClass: classification });
        expect(Object.keys(events[0].data ?? {}).sort()).toEqual([
          'activityId', 'errorType', 'failureClass', 'generation', 'operation', 'outcome',
          'reasonAvailable', 'reasonClass', 'stage',
        ]);
        expect(JSON.stringify(events)).not.toMatch(/private\.jwt|inline-secret|arbitrary-secret/);
        expect(detail?.executionStatus).toBe('unknown');
        expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
        expect(await start(f)).toEqual({ ok: false, reason: 'drive-settled' });
        expect((await f.capability.fetch(read('after-failed'))).status).toBe(403);
      } finally { setLogLevel('silent'); }
    }));
  }
  it('collects the settled pinned assessment once as a terminal result without another submission', () => fixture(async f => {
    await start(f);
    const assessment = { repository: 'owner/repo', pullRequest: 17, observedHead: 'b'.repeat(40), readOnly: true,
      evidence: { complete: false, stale: false, truncated: false, bot: 'renovate[bot]' },
      bounds: { files: 3, checks: 76 }, assessment: { classification: 'unknown',
        observedHead: 'b'.repeat(40), baseSha: 'a'.repeat(40), checks: { state: 'unconfigured', observedHead: null },
        reasons: ['No complete upstream evidence'], compatibility: 'Compatibility cannot be established',
        citations: [], gaps: ['Migration guidance unavailable'] } };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'waiting',
      sdkCleanupReleased: true });
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
      executionStatus: 'completed', collectionStatus: 'consumed', sdkCleanupReleased: true, result: assessment } });
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
      executionStatus: 'completed', result: assessment } });
    expect((await f.activity.getBrowserDetail())?.result).toEqual(assessment);
  }));
  it('keeps SDK cleanup unproved on failure and retries only cleanup after terminal collection', () => fixture(async f => {
    const sdk = Agent.prototype as unknown as { _cf_cleanupFacetPrefix: (...args: unknown[]) => Promise<void> };
    const original = sdk._cf_cleanupFacetPrefix;
    let failCleanup = true;
    vi.spyOn(sdk, '_cf_cleanupFacetPrefix').mockImplementation(function (this: Agent, ...args: unknown[]) {
      if (failCleanup) throw new Error('Synthetic SDK cleanup failure');
      return original.apply(this, args);
    });
    try {
      await start(f);
      const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
      f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
      f.settle(); await f.activity.reconcileDispatcherLease();
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'waiting', sdkCleanupReleased: false });
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: false, result: assessment } });
      failCleanup = false;
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: true, result: assessment } });
    } finally { failCleanup = false; }
  }));
  it.each(['missing', 'foreign', 'duplicate', 'oversized'] as const)(
    'does not manufacture a terminal assessment from %s settled evidence', variant => fixture(async f => {
      await start(f);
      const output = { readOnly: true, observedHead: 'b'.repeat(40) };
      const part = { type: 'data-assessment', data: output };
      const messages = variant === 'missing' ? [] : variant === 'foreign'
        ? [{ submissionId: 'foreign', parts: [part] }]
        : [{ submissionId: 'submission-1', parts: variant === 'duplicate' ? [part, part]
          : [{ type: 'data-assessment', data: { payload: 'x'.repeat(70 * 1024) } }] }];
      f.messages(messages);
      f.settle(); await f.activity.reconcileDispatcherLease();
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect((await f.activity.getBrowserDetail())?.result).toBeNull();
    }));
  it('fences a single checks page exceeding the protected 64 KiB response bound', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(read('submission-pull-request'))).status).toBe(200);
    f.oversizedChecks(1, 70_000);
    expect((await f.capability.fetch(read('submission-checks', { resource: 'checks' }))).status).toBe(409);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
  }));
  it('returns all 76 authorized check conclusions from bounded pages without forwarding large metadata', () => fixture(async f => {
    await start(f); f.oversizedChecks();
    const response = await f.capability.fetch(read('submission-checks', { resource: 'checks' }));
    expect(response.status).toBe(200);
    const evidence = await response.json() as { data: { check_runs: unknown[] }; truncated: boolean };
    expect(evidence.truncated).toBe(false);
    expect(evidence.data.check_runs).toHaveLength(76);
    expect(evidence.data.check_runs[75]).toEqual({ name: 'check-75', conclusion: 'success' });
    expect(new TextEncoder().encode(JSON.stringify(evidence)).byteLength).toBeLessThan(64 * 1024);
    expect(f.sent.some(request => new URL(request.url).searchParams.get('page') === '8')).toBe(true);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
  }));
  it('marks a check list beyond the 100-run bound as truncated rather than complete', () => fixture(async f => {
    await start(f); f.oversizedChecks(101);
    const response = await f.capability.fetch(read('submission-checks', { resource: 'checks' }));
    expect(response.status).toBe(200);
    const evidence = await response.json() as { data: { check_runs: unknown[] }; truncated: boolean };
    expect(evidence.truncated).toBe(true);
    expect(evidence.data.check_runs.length).toBeLessThanOrEqual(100);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
  }));
  it('marks overlapping check pages incomplete even when the row count matches', () => fixture(async f => {
    await start(f); f.oversizedChecks(20, 3000, true);
    const response = await f.capability.fetch(read('submission-checks', { resource: 'checks' }));
    expect(response.status).toBe(200);
    const evidence = await response.json() as { truncated: boolean };
    expect(evidence.truncated).toBe(true);
  }));
  it('fences expired leases even when their exact settlement arrives late', () => fixture(async f => {
    await start(f); f.expire(); f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
  }));
  it('fences uncertain admission without retrying the generated child', async () => {
    let state = { generation: 1, status: 'running', checkpoint: null, result: null };
    const activity = { beginDrive: async () => ({ ok: true, state }),
      admitDispatcher: async () => { throw new Error('lost admission'); },
      interruptDrive: async () => ({ ok: true, state: state = { ...state, generation: 2, status: 'unknown' } }),
    } as unknown as OperatorActivity;
    expect(await driveDispatcherRuntime({ activity, deadline: Date.now() + 1000,
      bundle, artifactDigest: await digest(bytes), invocation })).toMatchObject({ ok: true, state: { status: 'unknown' } });
  });
  it('resumes the exact persisted lease after reconstruction without re-admission', () => fixture(async f => {
    await start(f); f.settle(); const restarted = f.restart();
    await restarted.reconcileDispatcherLease();
    expect((await restarted.getBrowserDetail())?.executionStatus).toBe('waiting');
  }));
  it('fences before signaling facet abort and rejects late settlement and warmed effects', () => fixture(async f => {
    await start(f); expect((await f.capability.fetch(read())).status).toBe(200);
    await f.activity.cancelDrive(); expect(f.abortStatus()).toBe('cancel-requested');
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('cancel-requested');
    expect((await f.capability.fetch(read('read-2'))).status).toBe(403);
  }));
  it.each(['expire', 'revoke'] as const)('denies %s without new protected effects', action => fixture(async f => {
    await start(f); expect((await f.capability.fetch(read())).status).toBe(200);
    f[action](); expect((await f.capability.fetch(read('read-2'))).status).toBe(403);
    expect(f.sent.map(r => r.url)).toEqual(['https://api.github.com/repos/owner/repo/pulls/17']);
  }));
  it('sends the parent-owned GitHub REST User-Agent for both bounded PR and files reads', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(read('files-read', { resource: 'files' }))).status).toBe(200);
    expect(f.sent.map(request => request.headers.get('user-agent'))).toEqual([
      'Codeflare-Operator-Dispatcher', 'Codeflare-Operator-Dispatcher',
    ]);
    expect(f.sent.every(request => !request.headers.has('authorization'))).toBe(true);
  }));
  it('reconciles completed operation output and conflicts on changed semantics', () => fixture(async f => {
    await start(f); const first = await f.capability.fetch(read());
    expect(await (await f.capability.fetch(read())).text()).toBe(await first.text());
    expect((await f.capability.fetch(read('read-1', { resource: 'files' }))).status).toBe(409);
    expect(f.sent.map(r => r.method)).toEqual(['GET']);
  }));
  it.each([
    { name: 'oversized inference', preparationStep: 'parse', failureClass: 'body-limit',
      request: () => genericWire('inference', { operationId: 'PRIVATE_OPERATION', input: {
        messages: [{ role: 'user', content: 'PRIVATE_PROMPT'.repeat(100000) }] } }) },
    { name: 'oversized source', preparationStep: 'parse', failureClass: 'body-limit',
      request: () => genericWire('source', { operationId: 'PRIVATE_OPERATION', method: 'POST',
        url: 'https://api.github.com/repos/another/service/issues/17/comments', body: 'PRIVATE_BODY'.repeat(6000) }) },
    { name: 'invalid JSON', preparationStep: 'parse', failureClass: 'invalid-json',
      request: () => new Request('https://operator.internal/v1/dispatcher/inference', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: '{"PRIVATE_PROMPT":' }) },
    { name: 'forged wire identity', preparationStep: 'parse', failureClass: 'invalid-wire', wireRules: ['envelope-field'],
      request: () => genericWire('inference', { operationId: 'PRIVATE_OPERATION', activityId: 'CHILD_ACTIVITY', generation: 909,
        input: { messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] } }) },
    { name: 'pinned SDK compaction wire', preparationStep: 'parse', failureClass: 'invalid-wire', wireRules: ['inference-max-completion-tokens'],
      request: () => genericWire('inference', { operationId: 'PRIVATE_OPERATION', input: {
        messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }], max_completion_tokens: 16000 } }) },
    { name: 'unsupported method', preparationStep: 'parse', failureClass: 'request-denied',
      request: () => new Request('https://operator.internal/v1/dispatcher/inference', { method: 'GET' }) },
    { name: 'unsupported route', preparationStep: 'parse', failureClass: 'request-denied',
      request: () => genericWire('PRIVATE_ROUTE', { operationId: 'PRIVATE_OPERATION' }) },
    { name: 'missing inference capability', preparationStep: 'capability', failureClass: 'authority-denied', capabilities: ['fetch'],
      request: () => genericWire('inference', { operationId: 'PRIVATE_OPERATION', input: {
        messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] } }) },
    { name: 'changed installation', preparationStep: 'capability', failureClass: 'authority-denied', revoked: true,
      request: () => genericWire('inference', { operationId: 'PRIVATE_OPERATION', input: {
        messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] } }) },
  ])('REQ-OPERATOR-063: preparation rejection $name preserves denial and private diagnostic wire',
  ({ preparationStep, failureClass, request, capabilities, revoked, wireRules }) => fixture(async f => {
    await start(f);
    if (revoked) f.revoke();
    const emitted: string[] = [];
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
    try {
      const response = await f.capability.fetch(request());
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED' });
      expect(f.sent).toEqual([]);
      // REQ-OPERATOR-063 intentional security/observability wire: fixed categories,
      // trusted correlation and no child identity, exception, request or credential data.
      const event = emitted.map(value => JSON.parse(value) as { module: string; message: string;
        data?: Record<string, unknown> }).find(value => value.module === 'dispatcher-settlement'
        && value.message === 'Dispatcher operation rejected' && value.data?.stage === 'preparation');
      expect(event?.data).toEqual({ stage: 'preparation', preparationStep, failureClass,
        activityId: f.activityId, generation: 1, resource: 'unparsed', deadline: 'current', status: 403,
        ...(wireRules ? { wireRules, wireRulesTruncated: false } : {}) });
      expect(emitted.join('\n')).not.toMatch(/PRIVATE_|CHILD_ACTIVITY|private\.jwt|inline-secret|owner@example/);
      const detail = await f.activity.getBrowserDetail();
      expect(detail?.executionStatus).toBe('running');
      expect(detail?.result).toBeNull();
      if (!revoked) expect((await f.capability.fetch(genericWire('source', { operationId: 'valid-after-denial',
        url: 'https://api.github.com/repos/another/service' }))).status).toBe(200);
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }, { repositoryOnly: true, capabilities }));
  it('REQ-OPERATOR-063: preparation logging outage preserves denial and later authorized work', () => fixture(async f => {
    await start(f);
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => { throw Error('PRIVATE_LOGGING_FAILURE'); });
    try {
      const response = await f.capability.fetch(genericWire('inference', { operationId: 'PRIVATE_OPERATION',
        input: { messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }], actor: 'CHILD_ACTIVITY' } }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED' });
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
      expect(f.sent).toEqual([]);
      expect((await f.capability.fetch(genericWire('source', { operationId: 'valid-after-logging-outage',
        url: 'https://api.github.com/repos/another/service' }))).status).toBe(200);
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }, { repositoryOnly: true }));
  it.each([
    { name: 'missing messages', input: {}, rule: 'inference-messages-shape' },
    { name: 'empty messages', input: { messages: [] }, rule: 'inference-messages-count' },
    { name: 'message count', input: { messages: Array.from({ length: 129 }, () => ({ role: 'user', content: 'PRIVATE_PROMPT' })) }, rule: 'inference-messages-count' },
    { name: 'message list shape', input: { messages: 'PRIVATE_PROMPT' }, rule: 'inference-messages-shape' },
    { name: 'tool count', input: { messages: [{}], tools: Array.from({ length: 33 }, () => ({})) }, rule: 'inference-tools-count' },
    { name: 'tool list shape', input: { messages: [{}], tools: 'PRIVATE_TOOL' }, rule: 'inference-tools-shape' },
    { name: 'completion token field', input: { messages: [{}], max_completion_tokens: 16000 }, rule: 'inference-max-completion-tokens' },
    { name: 'output token upper bound', input: { messages: [{}], max_tokens: 8193 }, rule: 'inference-token-bound' },
    { name: 'output token lower bound', input: { messages: [{}], max_tokens: 0 }, rule: 'inference-token-bound' },
    { name: 'output token shape', input: { messages: [{}], max_tokens: 1.5 }, rule: 'inference-token-shape' },
    { name: 'temperature bound', input: { messages: [{}], temperature: 3 }, rule: 'inference-temperature' },
    { name: 'stream shape', input: { messages: [{}], stream: 'PRIVATE_STREAM' }, rule: 'inference-stream' },
    { name: 'stream options', input: { messages: [{}], stream_options: { include_usage: false } }, rule: 'inference-stream-options' },
    { name: 'private nested option key', input: { messages: [{}], stream_options: { include_usage: true, PRIVATE_KEY: 'inline-secret' } }, rule: 'inference-stream-options' },
    { name: 'private input key', input: { messages: [{}], PRIVATE_KEY: 'private.jwt' }, rule: 'inference-unsupported-field' },
    { name: 'input shape', input: null, rule: 'inference-input' },
  ])('REQ-OPERATOR-063: identifies $name without exposing rejected data or changing authority', ({ input, rule }) => fixture(async f => {
    await start(f);
    const emitted: string[] = [];
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
    try {
      const response = await f.capability.fetch(genericWire('inference', { operationId: 'PRIVATE_OPERATION', input }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED' });
      expect(f.sent).toEqual([]);
      // Intentional diagnostic security contract: bounded fixed rule labels,
      // trusted identity, and the unchanged generic public denial.
      const event = emitted.map(value => JSON.parse(value) as { module: string; data?: Record<string, unknown> })
        .find(value => value.module === 'dispatcher-settlement' && value.data?.stage === 'preparation');
      expect(event?.data).toEqual({ stage: 'preparation', preparationStep: 'parse', failureClass: 'invalid-wire',
        activityId: f.activityId, generation: 1, resource: 'unparsed', deadline: 'current', status: 403,
        wireRules: [rule], wireRulesTruncated: false });
      expect(emitted.join('\n')).not.toMatch(/PRIVATE_|inline-secret|private\.jwt|owner@example/);
      // Trusted identity is checked exactly above; rejected numeric values must not
      // occur in the remaining diagnostic fields, not arbitrary generated UUID text.
      expect(JSON.stringify({ ...event!.data, activityId: undefined })).not.toMatch(/8193|16000/);
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
      expect((await f.activity.getBrowserDetail())?.result).toBeNull();
      expect((await f.capability.fetch(genericWire('source', { operationId: 'valid-after-rule-denial',
        url: 'https://api.github.com/repos/another/service' }))).status).toBe(200);
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }, { repositoryOnly: true }));
  it('REQ-OPERATOR-063: bounds multiple rejected rules without retaining arbitrary issue paths or values', () => fixture(async f => {
    await start(f);
    const emitted: string[] = [];
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
    try {
      const response = await f.capability.fetch(genericWire('inference', { operationId: 'PRIVATE_OPERATION'.repeat(20), input: {
        messages: Array.from({ length: 129 }, () => ({ content: 'PRIVATE_PROMPT' })),
        tools: Array.from({ length: 33 }, () => ({})), max_tokens: 8193, temperature: 3,
        stream: 'PRIVATE_STREAM', stream_options: { include_usage: false }, PRIVATE_KEY: 'inline-secret',
      } }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED' });
      expect(f.sent).toEqual([]);
      const event = emitted.map(value => JSON.parse(value) as { module: string; data?: Record<string, unknown> })
        .find(value => value.module === 'dispatcher-settlement' && value.data?.stage === 'preparation');
      expect(event?.data).toEqual({ stage: 'preparation', preparationStep: 'parse', failureClass: 'invalid-wire',
        activityId: f.activityId, generation: 1, resource: 'unparsed', deadline: 'current', status: 403,
        wireRules: ['operation-id', 'inference-messages-count', 'inference-tools-count', 'inference-token-bound'], wireRulesTruncated: true });
      expect(emitted.join('\n')).not.toMatch(/PRIVATE_|inline-secret|private\.jwt|8193|ZodError|too_big/);
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }, { repositoryOnly: true }));
  it.each([
    { name: 'conflict', stage: 'reservation', resource: 'files', deadline: 'current', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        await f.capability.fetch(read('diagnostic-conflict'));
        return f.capability.fetch(read('diagnostic-conflict', { resource: 'files' }));
      } },
    { name: 'rejected transport uncertain operation', stage: 'effect', resource: 'pull-request', deadline: 'current', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.throwTransport(); return f.capability.fetch(read('diagnostic-uncertain'));
      } },
    { name: 'unreadable completed response', stage: 'effect', resource: 'pull-request', deadline: 'current', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.emptyResponse(); return f.capability.fetch(read('diagnostic-empty'));
      } },
    { name: 'expired authority', stage: 'authority', resource: 'unparsed', deadline: 'expired', status: 403,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.expire(); return f.capability.fetch(read('diagnostic-expired'));
      } },
    { name: 'stale generation with current deadline', stage: 'authority', resource: 'unparsed', deadline: 'current', status: 403,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => f.staleCapability.fetch(read('diagnostic-stale')) },
    { name: 'upstream non-success response', stage: 'upstream', resource: 'pull-request', deadline: 'current', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.loseResponse(); return f.capability.fetch(read('diagnostic-upstream'));
      } },
    { name: 'inference upstream non-success response', stage: 'upstream', resource: 'inference', deadline: 'current', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.loseResponse(); return f.capability.fetch(new Request('https://operator.internal/v1/dispatcher/inference', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operationId: 'diagnostic-inference', input: { messages: [{ role: 'user', content: 'PRIVATE_PROMPT_NOT_LOGGED' }] } }),
        }));
      } },
    { name: 'forwarded upstream HTTP 409', stage: 'forwarded-upstream', resource: 'pull-request', deadline: 'current', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.upstreamConflict(true); return f.capability.fetch(read('diagnostic-forwarded'));
      } },
    { name: 'expired result commit', stage: 'commit', resource: 'pull-request', deadline: 'expired', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.expireAfterRead(); return f.capability.fetch(read('diagnostic-commit'));
      } },
  ])('REQ-OPERATOR-047/048: emits bounded $name diagnostic with its fenced response', ({ name, stage, resource, deadline, status, exercise }) => fixture(async f => {
    await start(f);
    const emitted: string[] = [];
    setLogLevel('warn');
    try {
      vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
      const response = await exercise(f);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(name === 'forwarded upstream HTTP 409'
        ? { error: 'upstream-conflict' } : { code: status === 403 ? 'OPERATOR_CAPABILITY_DENIED'
          : stage === 'reservation' ? 'OPERATOR_OPERATION_CONFLICT' : 'OPERATOR_OPERATION_UNKNOWN' });
      const events = emitted.map(value => JSON.parse(value) as { module: string; message: string;
        data?: Record<string, unknown> }).filter(event => event.module === 'dispatcher-settlement'
        && event.message === 'Dispatcher operation rejected');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ data: { stage, resource, deadline, status } });
      expect(Object.keys(events[0].data ?? {}).sort()).toEqual(stage === 'upstream'
        ? ['deadline', 'resource', 'stage', 'status', 'upstreamStatus'] : ['deadline', 'resource', 'stage', 'status']);
      if (stage === 'upstream') expect(events[0].data?.upstreamStatus).toBe(502);
      expect(JSON.stringify(events)).not.toMatch(/private transport failure|lost response|diagnostic-conflict|diagnostic-uncertain|diagnostic-empty|diagnostic-expired|diagnostic-stale|diagnostic-upstream|diagnostic-forwarded|diagnostic-commit|diagnostic-inference|PRIVATE_PROMPT_NOT_LOGGED|private\.jwt|inline-secret/);
      if (name === 'forwarded upstream HTTP 409') {
        expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
        f.upstreamConflict(false);
        const replay = await f.capability.fetch(read('diagnostic-forwarded'));
        expect(replay.status).toBe(409);
        expect(await replay.json()).toEqual({ error: 'upstream-conflict' });
        expect(emitted.filter(value => value.includes('Dispatcher operation rejected'))).toHaveLength(1);
        expect((await f.capability.fetch(read('diagnostic-fresh'))).status).toBe(200);
      } else if (stage === 'effect' || stage === 'upstream' || stage === 'commit') {
        expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
        expect((await f.capability.fetch(read('diagnostic-followup'))).status).toBe(403);
      } else if (stage === 'reservation' || deadline === 'current') {
        expect((await f.capability.fetch(read('diagnostic-fresh'))).status).toBe(200);
      } else {
        expect(f.sent.some(request => request.url.startsWith('https://api.github.com/'))).toBe(false);
      }
    } finally { setLogLevel('silent'); }
  }));
  it('does not replay uncertain effects and cannot commit waiting afterward', () => fixture(async f => {
    await start(f); f.loseResponse(); expect((await f.capability.fetch(read())).status).toBe(409);
    expect((await f.capability.fetch(read())).status).toBe(403);
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect(f.sent.map(r => r.method)).toEqual(['GET']);
  }));
  it.each([65537, 1048576])('REQ-OPERATOR-047: admitted operator inference bytes forward %i-byte content without child authority', contentBytes => fixture(async f => {
    await start(f);
    const content = 'x'.repeat(contentBytes);
    const response = await f.capability.fetch(genericWire('inference', {
      operationId: 'configured-inference', input: { messages: [{ role: 'user', content }] },
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: [DONE]\n\n');
    expect(f.sent[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(f.sent[0].headers.has('authorization')).toBe(false);
    expect(await f.sent[0].json()).toMatchObject({ messages: [{ role: 'user', content }] });
    f.revoke();
    expect((await f.capability.fetch(genericWire('inference', {
      operationId: 'revoked-large-inference', input: { messages: [{ role: 'user', content }] },
    }))).status).toBe(403);
  }, { inferenceRequestBytes: Number.MAX_SAFE_INTEGER }));

  it('REQ-OPERATOR-047: absent inference limit accepts an exact 1 MiB request and rejects one extra byte', () => fixture(async f => {
    await start(f);
    const operationId = 'default-inference-bytes';
    const empty = { operationId, input: { messages: [{ role: 'user', content: '' }] } };
    const overhead = new TextEncoder().encode(JSON.stringify(empty)).byteLength;
    const content = 'x'.repeat(1048576 - overhead);
    expect((await f.capability.fetch(genericWire('inference', { operationId,
      input: { messages: [{ role: 'user', content }] } }))).status).toBe(200);
    expect((await f.capability.fetch(genericWire('inference', { operationId,
      input: { messages: [{ role: 'user', content: content + 'x' }] } }))).status).toBe(403);
  }));

  it('REQ-OPERATOR-047: operator inference bytes enforce exact UTF-8 request boundaries', async () => {
    const body = { operationId: 'exact-inference', input: { messages: [{ role: 'user', content: '🙂'.repeat(30) }] } };
    const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    for (const limit of [bytes - 1, bytes]) await fixture(async f => {
      await start(f);
      expect((await f.capability.fetch(genericWire('inference', body))).status).toBe(limit === bytes ? 200 : 403);
    }, { inferenceRequestBytes: limit });
  });

  it('REQ-OPERATOR-047: source response configuration and child fields cannot raise inference request bytes', async () => {
    await fixture(async f => {
      await start(f);
      expect((await f.capability.fetch(genericWire('inference', { operationId: 'default-limit',
        input: { messages: [{ role: 'user', content: 'x'.repeat(65537) }] } }))).status).toBe(403);
      expect((await f.capability.fetch(genericWire('inference', { operationId: 'child-limit',
        inferenceRequestBytes: Number.MAX_SAFE_INTEGER, input: { messages: [{ role: 'user', content: 'assess' }] } }))).status).toBe(403);
      expect((await f.capability.fetch(genericWire('inference', { operationId: 'valid-default',
        input: { messages: [{ role: 'user', content: 'assess' }] } }))).status).toBe(200);
    }, { sourceResponseBytes: 131072, inferenceRequestBytes: 65536 });
    await fixture(async f => {
      await start(f);
      expect((await f.capability.fetch(read('source-unchanged', { padding: 'x'.repeat(65537) }))).status).toBe(403);
    }, { inferenceRequestBytes: Number.MAX_SAFE_INTEGER });
  });

  it.each([undefined, 5120, 8192])('REQ-OPERATOR-047: routes bounded ordinary or canonical summary budget %s without forwarding child authority', budget => fixture(async f => {
    await start(f);
    const messages = budget === undefined ? [{ role: 'user', content: 'assess' }]
      : [{ role: 'system', content: 'Summarize the supplied research.' }, { role: 'user', content: 'Synthetic research context.' }];
    const response = await f.capability.fetch(new Request('https://operator.internal/v1/dispatcher/inference', {
      method: 'POST', headers: { authorization: 'child-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'inference-1', input: { messages,
        ...(budget === undefined ? {} : { max_tokens: budget }) } }),
    }));
    expect(response.status).toBe(200); expect(await response.text()).toBe('data: [DONE]\n\n');
    expect(f.sent[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(f.sent[0].headers.has('authorization')).toBe(false);
    // Parent output-limit/default injection and canonical forwarding are wire contracts.
    const forwarded = await f.sent[0].json();
    expect(forwarded).toMatchObject({ messages, max_tokens: budget ?? 8192 });
    expect(forwarded).not.toHaveProperty('max_completion_tokens');
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    f.revoke();
    expect((await f.capability.fetch(genericWire('inference', { operationId: 'revoked-summary',
      input: { messages, max_tokens: 5120 } }))).status).toBe(403);
  }));
  it('denies foreign resources, unknown routes, oversized input and foreign/root scheduling while allowed reads work', () => fixture(async f => {
    await start(f); expect((await f.capability.fetch(read())).status).toBe(200);
    for (const request of [read('x', { repository: 'other/repo' }), read('x', { resource: 'merge' }),
      read('x', { padding: 'x'.repeat(65537) }), new Request('https://operator.internal/v1/session'),
      new Request('https://example.test/v1/dispatcher/github/read', { method: 'POST', body: '{}' })]) {
      expect((await f.capability.fetch(request)).status).toBe(403);
    }
    await expect(f.capability._cf_scheduleForFacet([{ className: 'OperatorActivity', name: 'foreign' }],
      1, 'cancelDrive')).rejects.toThrow();
    expect(f.sent.map(r => r.method)).toEqual(['GET']);
  }));
  it('delegates only the pinned child wake callback and scopes cancellation to that facet', () => fixture(async f => {
    await start(f);
    const plan = await f.activity.getRuntimePlan();
    const path = [{ className: 'OperatorActivity', name: plan!.activityId },
      { className: 'FlueDispatcherAgent', name: 'dispatcher' }];
    const created = await f.capability._cf_scheduleForFacet(path, 1, '__flueWakeAgentSubmissions');
    expect(await f.capability._cf_getScheduleForFacet(path, created.schedule.id)).toMatchObject({ type: 'delayed' });
    await expect(f.capability._cf_scheduleForFacet(path, 1, 'cancelDrive')).rejects.toThrow();
    await expect(f.capability._cf_getScheduleForFacet([path[0], { ...path[1], name: 'foreign' }], created.schedule.id))
      .rejects.toThrow();
    expect(await f.capability._cf_cancelScheduleForFacet(path, created.schedule.id)).toMatchObject({ ok: true });
    expect(await f.capability._cf_getScheduleForFacet(path, created.schedule.id)).toBeUndefined();
  }));
  it('admits only the activity-bound, connection-free child notifications without widening authority', () => fixture(async f => {
    await start(f);
    const plan = await f.activity.getRuntimePlan();
    const path = [{ className: 'OperatorActivity', name: plan!.activityId },
      { className: 'FlueDispatcherAgent', name: 'dispatcher' }];
    const bridge = f.capability as unknown as {
      _cf_subAgentConnectionMetas(ownerPath: typeof path): Promise<unknown>;
      _cf_broadcastToSubAgent(ownerPath: typeof path, message: unknown, without?: string[]): Promise<void>;
    };
    expect(await bridge._cf_subAgentConnectionMetas(path)).toEqual([]);
    await expect(bridge._cf_broadcastToSubAgent(path, { type: 'notice' })).resolves.toBeUndefined();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    const foreign = [{ ...path[0], name: 'other-activity' }, path[1]];
    await expect(bridge._cf_subAgentConnectionMetas(foreign)).rejects.toThrow();
    await expect(bridge._cf_broadcastToSubAgent(foreign, { type: 'notice' })).rejects.toThrow();
    await expect(bridge._cf_broadcastToSubAgent(path, 'x'.repeat(64 * 1024 + 1))).rejects.toThrow();
  }));
  it('orchestrates managed Dispatcher bundles without the default entrypoint path', () => fixture(async f => {
    const plan = await f.activity.getRuntimePlan();
    await runOperatorActivity(plan!.activityId, f.environment, () => { throw new Error('default capability must not be selected'); });
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
  }));
});

function sourceRead(operationId: string, url: string, extra = {}) {
  return new Request('https://operator.internal/v1/dispatcher/source', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, url, ...extra }) });
}
describe('REQ-OPERATOR-047: package-selected research under managed parent authority', () => {
  it('reads an independently selected GitHub repository with the original owner, without a Dozzle allowlist', () => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(sourceRead('source-gh', 'https://api.github.com/repos/community/compiler/releases/tags/v3.2.1'));
    expect(response.status).toBe(200);
    const receipt = await response.json() as { status: number; body: string };
    expect(receipt.status).toBe(200);
    expect(JSON.parse(receipt.body)).toEqual({ tag_name: 'v3.2.1', guidance: 'Owned authenticated research' });
  }, { repositoryOnly: true }));
  it('returns bounded Internet content and provenance without upstream session cookies', () => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(sourceRead('source-web', 'https://docs.example.test/migration'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://docs.example.test/migration', status: 200,
      headers: { 'content-type': 'text/plain', etag: 'guide-v3' }, body: 'Official migration guidance' });
  }, { repositoryOnly: true }));
  it('serves standard fetch through the same generation-bound capability without passing session cookies', () => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(new Request('https://docs.example.test/migration', {
      headers: { 'x-codeflare-operator-operation-id': 'standard-fetch' },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('guide-v3');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toBe('Official migration guidance');
  }, { repositoryOnly: true }));
  it('denies direct outbound without stable operation identity or with caller credentials', () => fixture(async f => {
    await start(f);
    const deniedHeaders: HeadersInit[] = [{}, { 'x-codeflare-operator-operation-id': 'forged', authorization: 'foreign' }];
    for (const headers of deniedHeaders) {
      const response = await f.capability.fetch(new Request('https://docs.example.test/migration', { headers }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED' });
    }
  }, { repositoryOnly: true }));
  it('denies identity, credential and write substitution while allowing the legitimate source read', () => fixture(async f => {
    await start(f);
    for (const extra of [{ user: 'foreign@example.test' }, { headers: { authorization: 'foreign' } }, { method: 'POST' }]) {
      expect((await f.capability.fetch(sourceRead('forged', 'https://docs.example.test/migration', extra))).status).toBe(403);
    }
    expect((await f.capability.fetch(sourceRead('valid', 'https://docs.example.test/migration'))).status).toBe(200);
  }, { repositoryOnly: true }));
  it('collects only after the documented updates pages reach the durable head', () => fixture(async f => {
    await start(f);
    const output = { repository: 'another/service', results: [] };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-result', data: output }] }]);
    f.settle();
    await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'completed', result: output });
  }, { repositoryOnly: true, pagedStatus: true }));
  it('collects compact output through the real Activity from a large SDK reset', () => fixture(async f => {
    await start(f);
    const output = { repository: 'another/service', results: [] };
    f.messages([{ id: 'irrelevant', submissionId: 'foreign', parts: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] },
      { submissionId: 'submission-1', parts: [{ type: 'text', text: 'y'.repeat(2 * 1024 * 1024) }, { type: 'data-result', data: output }] }]);
    f.settle();
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'completed', result: output });
  }, { repositoryOnly: true }));
  it('reconciles concurrent identical reads without losing the generation or changing the stored receipt', () => fixture(async f => {
    await start(f);
    const replies = await Promise.all([1, 2].map(() => f.capability.fetch(sourceRead('same-read', 'https://docs.example.test/migration'))));
    expect(replies.map(response => response.status)).toEqual([200, 200]);
    const receipts = await Promise.all(replies.map(response => response.json()));
    expect(receipts[0]).toEqual(receipts[1]);
    const cached = await f.capability.fetch(sourceRead('same-read', 'https://docs.example.test/migration'));
    expect(cached.status).toBe(200);
    expect(await cached.json()).toEqual(receipts[0]);
  }, { repositoryOnly: true }));
  it('denies a missing registered fetch capability', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(sourceRead('denied', 'https://docs.example.test/migration'))).status).toBe(403);
  }, { repositoryOnly: true, capabilities: ['inference'] }));
  it('denies research after the original caller session is revoked', () => fixture(async f => {
    await start(f);
    f.revokeSession();
    expect((await f.capability.fetch(sourceRead('revoked', 'https://docs.example.test/migration'))).status).toBe(403);
  }, { repositoryOnly: true }));
  it('keeps the legacy single-PR package confined to its original interface', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(sourceRead('legacy', 'https://docs.example.test/migration'))).status).toBe(403);
  }));
});


describe('REQ-OPERATOR-047/048: parent-composed source response allowance', () => {
  it.each([undefined, 131072])('REQ-OPERATOR-047: exposes source allowance %s only to repository Loader', async sourceResponseBytes => {
    for (const repositoryOnly of [false, true]) await fixture(async f => {
      await start(f);
      expect((await f.loaderEnv()).OPERATOR_SOURCE_RESPONSE_BYTES)
        .toBe(repositoryOnly ? String(sourceResponseBytes ?? 1048576) : undefined);
    }, { repositoryOnly, sourceResponseBytes });
  });

  it.each([undefined, 65536, 131072])('REQ-OPERATOR-047: enforces source allowance %s through Activity and immutable cache', sourceResponseBytes => fixture(async f => {
    await start(f);
    const request = () => sourceRead('large-source', 'https://docs.example.test/migration');
    const response = await f.capability.fetch(request());
    expect(response.status).toBe(sourceResponseBytes === 65536 ? 422 : 200);
    const body = await response.json();
    expect(body).toEqual(sourceResponseBytes === 65536 ? { code: 'OPERATOR_SOURCE_INCOMPLETE' } : {
      url: 'https://docs.example.test/migration', status: 200,
      headers: { 'content-type': 'text/plain', etag: 'guide-v3' }, body: 'x'.repeat(100 * 1024),
    });
    f.sourceBody('Changed upstream content must not replace a completed receipt');
    f.restart();
    const cached = await f.capability.fetch(request());
    expect(cached.status).toBe(response.status);
    expect(await cached.json()).toEqual(body);
  }, { repositoryOnly: true, sourceResponseBytes, sourceBody: 'x'.repeat(100 * 1024) }));

  it('REQ-OPERATOR-047: SQL-backed default capacity completes 1024 distinct maximum-length source URLs and reuses cached slots after reload', () => fixture(async f => {
    await start(f);
    const urlFor = (index: number) => {
      const prefix = `https://docs.example.test/migration?request=${String(index).padStart(4, '0')}&padding=`;
      return prefix + 'x'.repeat(4096 - prefix.length);
    };
    const receipt = async (index: number, count: number) => {
      const response = await f.capability.fetch(genericWire('receipt', { operationId: `max-url-${index}` }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ operationId: `max-url-${index}`, generation: 1,
        method: 'GET', url: urlFor(index), phase: 'completed', operationCount: count, operationLimit: 1024 });
    };
    // Real native SQLite KV enforces the platform's 2 MiB serialized value limit.
    // Only the upstream transport is controlled: no real network or synthetic journal limit.
    for (let index = 0; index < 1024; index++) {
      const response = await f.capability.fetch(sourceRead(`max-url-${index}`, urlFor(index)));
      expect(response.status, `source reservation/completion ${index + 1} of 1024`).toBe(200);
      expect(await response.json()).toEqual({ url: urlFor(index), status: 200,
        headers: { 'content-type': 'text/plain', etag: 'guide-v3' }, body: 'Official migration guidance' });
      if (index === 0 || index === 511 || index === 1023) await receipt(0, index + 1);
    }
    f.sourceBody('Changed upstream content must not replace completed long-URL receipts');
    f.restart();
    for (const index of [0, 511, 1023]) {
      const cached = await f.capability.fetch(sourceRead(`max-url-${index}`, urlFor(index)));
      expect(cached.status).toBe(200);
      expect(await cached.json()).toEqual({ url: urlFor(index), status: 200,
        headers: { 'content-type': 'text/plain', etag: 'guide-v3' }, body: 'Official migration guidance' });
      await receipt(index, 1024);
    }
    const denied = await f.capability.fetch(sourceRead('max-url-next', urlFor(1024)));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED' });
    expect((await f.capability.fetch(genericWire('receipt', { operationId: 'max-url-next' }))).status).toBe(403);
    await receipt(0, 1024);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
  }, { repositoryOnly: true }), 120000);

  it.each(['reserved', 'unknown'] as const)(
    'REQ-OPERATOR-047: legacy aggregate recovery preserves counts cached receipts conflicts and %s mutation ordering across reload', phase => fixture(async f => {
      await start(f);
      const url = 'https://api.github.com/repos/another/service/issues/17/comments';
      const oldRead = { operationId: 'legacy-before', url };
      const mutation = { operationId: 'legacy-mutation', url, method: 'POST' as const, body: '{"body":"legacy judgment"}' };
      const laterRead = { operationId: 'legacy-after', url };
      const cachedEnvelope = { url, status: 200, headers: { 'content-type': 'application/json' }, body: '[]' };
      // Enumeration order deliberately differs from historical reservation order.
      // Ordinals are seed data, never asserted as an internal schema contract.
      await f.seedLegacyJournal([
        { body: mutation, ordinal: 1, phase },
        { body: laterRead, ordinal: 2, phase: 'completed', response: cachedEnvelope },
        { body: oldRead, ordinal: 0, phase: 'completed', response: cachedEnvelope },
      ]);
      f.restart();
      const receipt = async (operationId: string, count: number) => {
        const response = await f.capability.fetch(genericWire('receipt', { operationId }));
        expect(response.status).toBe(200);
        const value = await response.json() as { operationId: string; requestDigest: string; responseDigest: string; phase: string };
        expect(value).toMatchObject({ operationId, operationCount: count, operationLimit: 4 });
        return value;
      };
      const reference = (value: { operationId: string; requestDigest: string; responseDigest: string }) => ({
        operationId: value.operationId, requestDigest: value.requestDigest, responseDigest: value.responseDigest,
      });
      const original = await receipt(mutation.operationId, 3);
      // Recovery may conservatively promote a stranded reservation to unknown.
      expect(['reserved', 'unknown']).toContain(original.phase);
      f.genericReadback([{ id: 9999, body: 'Changed upstream must not replace legacy cached responses', user: { id: 42 } }]);
      for (const body of [oldRead, laterRead]) {
        const cached = await f.capability.fetch(genericWire('source', body));
        expect(cached.status).toBe(200);
        expect(await cached.json()).toEqual(cachedEnvelope);
      }
      const conflict = await f.capability.fetch(genericWire('source', { ...mutation, body: '{"body":"changed judgment"}' }));
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ code: 'OPERATOR_OPERATION_CONFLICT' });
      for (let reload = 0; reload < 2; reload++) {
        f.restart();
        const unresolved = await f.capability.fetch(genericWire('source', mutation));
        expect(unresolved.status).toBe(409);
        expect(await unresolved.json()).toEqual({ code: 'OPERATOR_OPERATION_UNKNOWN' });
        expect(await receipt(mutation.operationId, 3)).toMatchObject({ phase: 'unknown', requestDigest: original.requestDigest });
      }
      const resolution = { operationId: mutation.operationId, requestDigest: original.requestDigest,
        readbacks: [reference(await receipt(oldRead.operationId, 3))] };
      const tooEarly = await f.capability.fetch(genericWire('resolve', resolution));
      expect(tooEarly.status).toBe(409);
      expect(await tooEarly.json()).toEqual({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      // A fresh read after recovery must have a later reservation order and consume
      // exactly one slot. Its empty remote result also proves the seeded write was not replayed.
      const freshRead = { operationId: 'legacy-fresh-read', url };
      f.genericReadback(undefined);
      const observed = await f.capability.fetch(genericWire('source', freshRead));
      expect(observed.status).toBe(200);
      expect(JSON.parse((await observed.json() as { body: string }).body)).toEqual([]);
      await receipt(oldRead.operationId, 4);
      f.restart();
      f.genericReadback([{ id: 9999, body: 'Changed upstream after reload must not replace legacy cache', user: { id: 42 } }]);
      for (const body of [oldRead, laterRead]) {
        const cached = await f.capability.fetch(genericWire('source', body));
        expect(cached.status).toBe(200);
        expect(await cached.json()).toEqual(cachedEnvelope);
      }
      // Both migrated historical evidence and post-recovery evidence remain later
      // than the unknown mutation; only the earlier receipt was rejected above.
      const readbacks = [reference(await receipt(laterRead.operationId, 4)), reference(await receipt(freshRead.operationId, 4))];
      for (let reload = 0; reload < 2; reload++) {
        f.restart();
        const resolved = await f.capability.fetch(genericWire('resolve', { ...resolution, readbacks }));
        expect(resolved.status).toBe(200);
        expect(await resolved.json()).toEqual({ resolved: true, operationId: mutation.operationId, requestDigest: original.requestDigest });
        expect(await receipt(mutation.operationId, 4)).toMatchObject({ phase: 'completed', requestDigest: original.requestDigest });
        const cached = await f.capability.fetch(genericWire('source', mutation));
        expect(cached.status).toBe(200);
        expect(await cached.json()).toEqual({ resolved: true, operationId: mutation.operationId, requestDigest: original.requestDigest });
      }
      const changed = await f.capability.fetch(genericWire('source', { ...mutation, body: '{"body":"changed judgment"}' }));
      expect(changed.status).toBe(409);
      expect(await changed.json()).toEqual({ code: 'OPERATOR_OPERATION_CONFLICT' });
      const denied = await f.capability.fetch(genericWire('source', { operationId: 'legacy-over-budget', url }));
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED' });
      await receipt(mutation.operationId, 4);
    }, { repositoryOnly: true, operationLimit: 4 }));

  it('REQ-OPERATOR-047: SQL-backed Activity journals and reloads an exact 1 MiB source envelope', async () => {
    const url = 'https://docs.example.test/migration';
    const headers = { 'content-type': 'text/plain', etag: 'guide-v3' };
    const overhead = new TextEncoder().encode(JSON.stringify({ url, status: 200, headers, body: '' })).byteLength;
    const sourceBody = 'x'.repeat(1024 * 1024 - overhead);
    await fixture(async f => {
      await start(f);
      const request = () => sourceRead('near-max-source', url);
      const response = await f.capability.fetch(request());
      expect(response.status).toBe(200);
      const serialized = await response.text();
      expect(new TextEncoder().encode(serialized).byteLength).toBe(1024 * 1024);
      expect(JSON.parse(serialized)).toEqual({ url, status: 200, headers, body: sourceBody });
      f.sourceBody('Changed upstream content must not replace the near-max journal receipt');
      f.restart();
      const cached = await f.capability.fetch(request());
      expect(cached.status).toBe(200);
      expect(await cached.text()).toBe(serialized);
    }, { repositoryOnly: true, sourceResponseBytes: 1024 * 1024, sourceBody });
  });

  it('REQ-OPERATOR-047: rejects escaped UTF-8 envelope overflow through Activity', () => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(sourceRead('escaped-source', 'https://docs.example.test/migration'));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ code: 'OPERATOR_SOURCE_INCOMPLETE' });
  }, { repositoryOnly: true, sourceResponseBytes: 131072, sourceBody: 'é\n'.repeat(33000) }));

  it('REQ-OPERATOR-047: actual Loader outbound unwraps the approved large source without cookies', () => fixture(async f => {
    await start(f);
    const outbound = await f.loaderOutbound();
    if (!outbound) throw new Error('Repository Loader outbound missing');
    const response = await outbound.fetch(new Request('https://docs.example.test/migration', {
      headers: { 'x-codeflare-operator-operation-id': 'large-outbound' },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('guide-v3');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toBe('x'.repeat(100 * 1024));
  }, { repositoryOnly: true, sourceResponseBytes: 131072, sourceBody: 'x'.repeat(100 * 1024) }));

  it.each(['source', 'inference'])('REQ-OPERATOR-047: raising source responses leaves %s explicitly configured request limit at 64 KiB', path => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(genericWire(path, path === 'source' ? {
      operationId: 'oversized-source-request', method: 'POST',
      url: 'https://api.github.com/repos/another/service/issues/17/comments', body: 'x'.repeat(65537),
    } : { operationId: 'oversized-inference-request', input: { messages: [{ role: 'user', content: 'x'.repeat(65537) }] } }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED' });
    expect(f.sent).toEqual([]);
  }, { repositoryOnly: true, sourceResponseBytes: 131072, inferenceRequestBytes: 65536 }));

  it('REQ-OPERATOR-047: raising source responses leaves inference response limit at 64 KiB', () => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(genericWire('inference', {
      operationId: 'oversized-inference-response', input: { messages: [{ role: 'user', content: 'assess' }] },
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'OPERATOR_OPERATION_UNKNOWN' });
  }, { repositoryOnly: true, sourceResponseBytes: 131072, inferenceBody: 'x'.repeat(65537) }));

  it.each([64512, 65537])('REQ-OPERATOR-048: source allowance preserves final-result admission for %s bytes', resultBytes => fixture(async f => {
    await start(f);
    const empty = { repository: 'another/service', results: [], padding: '' };
    const overhead = new TextEncoder().encode(JSON.stringify(empty)).byteLength;
    const result = { ...empty, padding: 'x'.repeat(resultBytes - overhead) };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-result', data: result }] }]);
    f.settle();
    await f.activity.reconcileDispatcherLease();
    if (resultBytes === 64512) {
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'completed', result });
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result } });
    } else {
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null });
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    }
  }, { repositoryOnly: true, sourceResponseBytes: 131072 }));
});

// Instrumented production Activity/Fetcher boundary only; compiled connected acceptance is separate.
type DispatcherFixture = Parameters<Parameters<typeof fixture>[0]>[0];
const prospectiveRepo = 'nikolanovoselec/komodo';
const prospectiveBase = `https://api.github.com/repos/${prospectiveRepo}`;
const prospectiveComment = (operationId = 'admitted-comment', base = prospectiveBase) => ({ operationId,
  method: 'POST', url: `${base}/issues/17/comments`, body: JSON.stringify({ body: 'Exact admitted judgment' }) });
const prospectiveMerge = (operationId = 'admitted-merge', base = prospectiveBase) => ({ operationId,
  method: 'PUT', url: `${base}/pulls/17/merge`, body: JSON.stringify({ sha: 'b'.repeat(40), merge_method: 'merge' }) });
const remoteMutations = (f: DispatcherFixture) => f.sent.filter(request => request.method !== 'GET');
async function startProspective(f: DispatcherFixture) {
  await start(f);
  expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
  expect((await f.capability.fetch(genericWire('source', { operationId: 'admitted-initial-read',
    url: `${prospectiveBase}/pulls/17` }))).status).toBe(200);
}

describe('REQ-OPERATOR-047/048/061/062/071: repository-only prospective parent authority', () => {
  it.each([false, true])('reauthorizes a stored settled assessment at public collection; prospective actor revoked=%s', revoked => fixture(async f => {
    await start(f);
    const assessment = { repository: prospectiveRepo, results: [{ pullRequest: 17, headSha: f.proof.head,
      decision: 'DO_NOT_MERGE', comment: 'Evidence does not justify merging', outcome: 'NOT_MERGED' }] };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
    f.settle();
    await f.activity.reconcileDispatcherLease();
    // Real settlement persists the assessment but the targeted legacy drive still awaits public collection.
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'waiting',
      collectionStatus: 'unavailable', result: null });
    const submitted = await Promise.all(f.childSubmissions.map(async request => ({ method: request.method,
      url: request.url, body: await request.clone().text() })));
    expect(submitted.length).toBeGreaterThan(0);
    f.sent.splice(0);
    if (revoked) f.changeRegistration(null);
    const restarted = f.restart();
    if (revoked) {
      expect(await restarted.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(await restarted.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(await restarted.getBrowserDetail()).toMatchObject({ executionStatus: 'waiting',
        collectionStatus: 'unavailable', result: null });
    } else {
      // Same settled fixture, current authority: collection really can expose this immutable result.
      expect(await restarted.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', collectionStatus: 'consumed', result: assessment } });
    }
    expect(await Promise.all(f.childSubmissions.map(async request => ({ method: request.method,
      url: request.url, body: await request.clone().text() })))).toEqual(submitted);
    expect(f.sent).toEqual([]);
  }, { prospective: true, legacyProspective: true }));

  it('authorizes repository-only work and projects one closed nonsecret target into the actual Loader, identically after reconstruction', () => fixture(async f => {
    await startProspective(f);
    expect(f.input).toEqual({ repository: prospectiveRepo });
    const loaded = await f.loaderEnv();
    expect(typeof loaded.OPERATOR_ADMITTED_TARGET).toBe('string');
    // Intent-3 Loader wire is an intentional closed metadata contract, not public input or a grant.
    expect(JSON.parse(loaded.OPERATOR_ADMITTED_TARGET as string)).toEqual(f.admittedTarget);
    const loadedKeys = Object.keys(loaded).sort();
    expect(loadedKeys).toEqual(['GITHUB_API_ORIGIN', 'OPERATOR', 'OPERATOR_ADMITTED_TARGET', 'OPERATOR_SOURCE_RESPONSE_BYTES']);
    expect(loaded.OPERATOR_ADMITTED_TARGET).not.toContain('private.jwt');
    const restarted = f.restart();
    expect((await f.capability.fetch(genericWire('source', { operationId: 'reconstructed-read',
      url: `${prospectiveBase}/pulls/17` }))).status).toBe(200);
    await restarted.reconcileDispatcherLease();
    expect((await f.loaderEnv()).OPERATOR_ADMITTED_TARGET).toBe(loaded.OPERATOR_ADMITTED_TARGET);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it('accepts canonical GitHub second-resolution creation time without weakening the immutable cutoff', () => fixture(async f => {
    const createdAt = f.proof.createdAt.replace(/\.\d{3}Z$/, 'Z');
    f.changeProof({ createdAt }); f.changeTarget({ created_at: createdAt });
    await startProspective(f);
    expect(JSON.parse((await f.loaderEnv()).OPERATOR_ADMITTED_TARGET as string))
      .toEqual({ ...f.admittedTarget, createdAt });
    expect((await f.capability.fetch(genericWire('source', prospectiveComment()))).status).toBe(200);
    expect(remoteMutations(f).map(request => request.url)).toEqual([`${prospectiveBase}/issues/17/comments`]);
  }, { prospective: true }));

  it.each([
    ['missing proof', null], ['foreign Activity', { activityId: 'foreign-activity' }],
    ['foreign installation', { installationId: 'foreign-installation' }], ['foreign owner', { ownerKey: 'f'.repeat(64) }],
    ['foreign repository ID', { repositoryId: 1 }], ['missing PR', { pullRequest: undefined }],
    ['nonpositive PR', { pullRequest: 0 }], ['unsafe PR', { pullRequest: Number.MAX_SAFE_INTEGER + 1 }],
    ['malformed head', { head: 'expected-head' }], ['uppercase head', { head: 'B'.repeat(40) }],
    ['invalid creation date', { createdAt: 'not-a-date' }], ['invalid cutoff', { activatedAt: 'not-a-date' }],
    ['future creation date', { createdAt: '2099-01-01T00:00:00Z' }],
    ['cutoff differs from original registration', { activatedAt: '2000-01-01T00:00:00Z' }],
  ] as Array<[string, Record<string, unknown> | null]>)('denies %s rather than treating proof as optional', (_name, patch) => fixture(async f => {
    await startProspective(f);
    f.changeProof(patch);
    expect((await f.capability.fetch(genericWire('source', prospectiveComment()))).status).toBe(403);
    expect((await f.capability.fetch(genericWire('inference', { operationId: 'invalid-proof-inference',
      input: { messages: [{ role: 'user', content: 'assess' }] } }))).status).toBe(403);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it.each(['pre-cutoff', 'equal-cutoff', 'foreign subject', 'foreign issuer', 'foreign email', 'foreign audience'])('denies %s proof coordinates', name => fixture(async f => {
    await startProspective(f);
    if (name === 'pre-cutoff' || name === 'equal-cutoff') f.changeProof({ createdAt: name === 'equal-cutoff'
      ? f.proof.activatedAt : new Date(Date.parse(f.proof.activatedAt) - 1).toISOString() });
    else f.changeProof({ actor: { ...f.proof.actor, ...(name === 'foreign subject' ? { subject: 'other-human' }
      : name === 'foreign issuer' ? { issuer: 'https://other.example.test' }
        : name === 'foreign email' ? { email: 'other@example.test' } : { audiences: ['other-audience'] }) } });
    expect((await f.capability.fetch(genericWire('source', prospectiveComment()))).status).toBe(403);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it.each([
    { pullRequest: 18 }, { createdAfter: '2000-01-01T00:00:00.000Z' }, { actor: 'other-human' },
    { OPERATOR_ADMITTED_TARGET: { repository: prospectiveRepo, pullRequest: 18, headSha: 'c'.repeat(40) } },
  ])('does not accept public target/cutoff/principal metadata as prospective authority %j', inputExtra => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(genericWire('source', prospectiveComment()))).status).toBe(403);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true, inputExtra }));

  it('admits only canonical comment and merge wires at the configured API, preserving expected-head CAS and parent identity', () => fixture(async f => {
    await start(f);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    const base = `https://github.enterprise.test/repos/${prospectiveRepo}`;
    for (const mutation of [prospectiveComment('comment', base), prospectiveMerge('merge', base)]) {
      const response = await f.capability.fetch(genericWire('source', mutation));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ url: mutation.url, status: mutation.method === 'POST' ? 201 : 200 });
    }
    const writes = remoteMutations(f);
    expect(writes.map(request => ({ method: request.method, url: request.url }))).toEqual([
      { method: 'POST', url: `${base}/issues/17/comments` }, { method: 'PUT', url: `${base}/pulls/17/merge` },
    ]);
    expect(await writes[0].clone().json()).toEqual({ body: 'Exact admitted judgment' });
    expect(await writes[1].clone().json()).toEqual({ sha: f.proof.head, merge_method: 'merge' });
    expect(writes.every(request => !request.headers.has('authorization') && !request.headers.has('cookie')
      && request.redirect === 'manual')).toBe(true);
    expect(f.sent.some(request => request.method === 'GET' && request.url === `${base}/pulls/17`)).toBe(true);
    expect(f.sent.some(request => request.method === 'GET' && request.url === base)).toBe(true);
  }, { prospective: true, githubApiHost: 'github.enterprise.test' }));

  it.each([
    ['foreign PR', 'POST', `${prospectiveBase}/issues/18/comments`],
    ['foreign repository', 'POST', 'https://api.github.com/repos/other/project/issues/17/comments'],
    ['foreign endpoint', 'POST', `${prospectiveBase}/pulls/17/reviews`],
    ['issue edit', 'PUT', `${prospectiveBase}/issues/17`],
    ['workflow dispatch', 'POST', `${prospectiveBase}/actions/workflows/1/dispatches`],
    ['wrong method', 'PUT', `${prospectiveBase}/issues/17/comments`],
    ['wrong merge method', 'POST', `${prospectiveBase}/pulls/17/merge`],
    ['public host alias', 'POST', `https://github.com/repos/${prospectiveRepo}/issues/17/comments`],
    ['lookalike host', 'POST', `https://api.github.com.evil.test/repos/${prospectiveRepo}/issues/17/comments`],
    ['query', 'POST', `${prospectiveBase}/issues/17/comments?target=18`],
    ['empty query delimiter', 'POST', `${prospectiveBase}/issues/17/comments?`],
    ['encoded PR', 'POST', `${prospectiveBase}/issues/%31%37/comments`],
    ['encoded slash', 'POST', `${prospectiveBase}/issues%2f17/comments`],
    ['encoded repo', 'POST', 'https://api.github.com/repos/nikolanovoselec/%6bomodo/issues/17/comments'],
    ['traversal alias', 'POST', `${prospectiveBase}/pulls/../issues/17/comments`],
    ['duplicate slash', 'POST', `${prospectiveBase}//issues/17/comments`],
    ['trailing slash', 'POST', `${prospectiveBase}/issues/17/comments/`],
  ])('rejects raw source %s before remote mutation', (_name, method, url) => fixture(async f => {
    await startProspective(f);
    expect((await f.capability.fetch(genericWire('source', { ...prospectiveComment(), method, url }))).status).toBe(403);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it.each([
    ['comment invalid JSON', false, '{'], ['comment empty', false, '{"body":""}'],
    ['comment blank', false, '{"body":"  "}'], ['comment nonstring', false, '{"body":42}'],
    ['comment extra selector', false, '{"body":"judgment","pullRequest":18}'],
    ['comment list', false, '[{"body":"judgment"}]'],
    ['merge wrong SHA', true, JSON.stringify({ sha: 'c'.repeat(40), merge_method: 'merge' })],
    ['merge missing SHA', true, '{"merge_method":"merge"}'],
    ['merge missing method', true, JSON.stringify({ sha: 'b'.repeat(40) })],
    ['merge unsupported method', true, JSON.stringify({ sha: 'b'.repeat(40), merge_method: 'squash' })],
    ['merge extra selector', true, JSON.stringify({ sha: 'b'.repeat(40), merge_method: 'merge', pullRequest: 18 })],
  ] as Array<[string, boolean, string]>)('rejects %s at the prospective wire boundary', (_name, merge, body) => fixture(async f => {
    await startProspective(f);
    expect((await f.capability.fetch(genericWire('source', { ...(merge ? prospectiveMerge() : prospectiveComment()), body }))).status).toBe(403);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it('does not let standard Loader outbound or schema-valid legacy effects/discovery escape the source fence', () => fixture(async f => {
    // Typed effects have an independent current-admin gate before the prospective endpoint guard.
    // Supply that valid external role port, not a bypass of Activity or the operation under test.
    f.environment.KV = { get: async (key: string) => key === 'user:owner@example.test'
      ? '{"role":"admin"}' : null } as unknown as KVNamespace;
    await startProspective(f);
    // Admission's canonical source read above is the positive control. Observe only subsequent remote I/O.
    f.sent.splice(0);
    const outbound = await f.loaderOutbound();
    if (!outbound) throw new Error('Repository Loader outbound missing');
    const response = await outbound.fetch(new Request(`${prospectiveBase}/issues/18/comments`, { method: 'POST',
      headers: { 'x-codeflare-operator-operation-id': 'outbound-bypass', 'content-type': 'application/json' }, body: '{"body":"foreign"}' }));
    expect(response.status).toBe(403);
    const legacyWires = [
      { path: 'github/comment', body: { operationId: 'typed-comment', target: { pullRequest: 17, headSha: f.proof.head },
        decision: 'DO_NOT_MERGE', comment: 'Judgment' } },
      { path: 'github/merge', body: { operationId: 'typed-merge', target: { pullRequest: 17, headSha: f.proof.head },
        decision: 'MERGE', comment: 'Judgment' } },
      { path: 'github/read', body: { operationId: 'typed-discovery', resource: 'open-pull-requests' } },
    ];
    for (const { path, body } of legacyWires) {
      const request = genericWire(path, body);
      // Valid legacy transport is the contract: a parse rejection is not evidence of the prospective guard.
      expect((await parseDispatcherOperation(request.clone())).body).toEqual(body);
      const denied = await f.capability.fetch(request);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED' });
      expect(f.sent).toEqual([]);
    }
    // If legacy targeted reads remain available, they cannot adopt another PR/head.
    expect((await f.capability.fetch(read('typed-foreign', { target: { pullRequest: 18, headSha: f.proof.head } }))).status).toBe(403);
    expect(f.sent).toEqual([]);
    // The installation/claim remains usable through the admitted canonical source endpoint.
    expect((await f.capability.fetch(genericWire('source', prospectiveComment('after-legacy-denial')))).status).toBe(200);
    const writes = remoteMutations(f);
    expect(writes.map(request => ({ method: request.method, url: request.url }))).toEqual([
      { method: 'POST', url: `${prospectiveBase}/issues/17/comments` },
    ]);
    expect(await writes[0].clone().json()).toEqual({ body: 'Exact admitted judgment' });
  }, { prospective: true }));

  it.each(([
    ['changed head', { head: { sha: 'c'.repeat(40) } }], ['wrong PR', { number: 18 }],
    ['changed date', { created_at: '2099-01-01T00:00:00.000Z' }],
    ['changed base', { base: { ref: 'develop', sha: 'a'.repeat(40), repo: { id: 973175879, full_name: prospectiveRepo } } }],
    ['foreign base repo', { base: { ref: 'main', sha: 'a'.repeat(40), repo: { id: 1, full_name: 'other/repo' } } }],
    ['foreign authenticated repo ID', { repository: { id: 1, full_name: prospectiveRepo } }],
    ['closed target', { state: 'closed' }], ['draft target', { draft: true }],
  ] as Array<[string, Record<string, unknown>]>).flatMap(([name, patch]) =>
    ['comment', 'merge'].map(phase => ({ name, patch, phase }))))('fresh authenticated preflight denies $phase for $name', ({ patch, phase }) => fixture(async f => {
    await startProspective(f);
    f.changeTarget(patch);
    const response = await f.capability.fetch(genericWire('source', phase === 'merge' ? prospectiveMerge() : prospectiveComment()));
    expect(response.ok).toBe(false);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it.each(['unavailable', 'incomplete'])('denies a new write when target authority reads are %s', name => fixture(async f => {
    await startProspective(f);
    if (name === 'unavailable') f.throwTransport(); else f.emptyResponse();
    expect((await f.capability.fetch(genericWire('source', prospectiveComment()))).ok).toBe(false);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it.each(['grant', 'session', 'registration', 'cancel'])('rechecks %s loss after awaited preflight before forwarding', name => fixture(async f => {
    await startProspective(f);
    f.afterTargetRead(async () => {
      if (name === 'grant') f.revokeGrant();
      else if (name === 'session') f.revokeSession();
      else if (name === 'registration') f.changeRegistration(null);
      else await f.activity.cancelDrive();
    });
    expect((await f.capability.fetch(genericWire('source', prospectiveComment()))).ok).toBe(false);
    expect(f.sent.some(request => request.method === 'GET' && request.url === `${prospectiveBase}/pulls/17`)).toBe(true);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it.each(['session', 'grant', 'installation', 'expiry', 'actor', 'bucket', 'session-id', 'session-generation', 'registration-installation', 'registration-loss', 'stale-capability'])('fences warmed and reconstructed protected work on %s loss', name => fixture(async f => {
    await startProspective(f);
    if (name === 'session') f.revokeSession();
    else if (name === 'grant') f.revokeGrant();
    else if (name === 'installation') f.revoke();
    else if (name === 'expiry') f.expire();
    else if (name === 'actor') f.changeRegistration({ human: { subject: 'another-current-admin', email: 'owner@example.test',
      issuer: f.proof.actor.issuer, audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000) - 1,
      expiresAt: Math.floor(Date.now() / 1000) + 300 } });
    else if (name === 'bucket') f.changeRegistration({ bucket: 'other-bucket' });
    else if (name === 'session-id') f.changeRegistration({ sessionId: 'replacement-session' });
    else if (name === 'session-generation') f.changeRegistration({ sessionGeneration: 4 });
    else if (name === 'registration-installation') f.changeRegistration({ installationId: 'other-installation' });
    else if (name === 'registration-loss') f.changeRegistration(null);
    const capability = name === 'stale-capability' ? f.staleCapability : f.capability;
    for (const reconstruct of [false, true]) {
      if (reconstruct) f.restart();
      expect((await capability.fetch(genericWire('source', prospectiveComment(`fenced-write-${reconstruct}`)))).status).toBe(403);
      expect((await capability.fetch(genericWire('source', { operationId: `fenced-read-${reconstruct}`, url: `${prospectiveBase}/pulls/17` }))).status).toBe(403);
      expect((await capability.fetch(genericWire('inference', { operationId: `fenced-inference-${reconstruct}`,
        input: { messages: [{ role: 'user', content: 'assess' }] } }))).status).toBe(403);
    }
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it('returns identical completed bytes after target moves/closes and reconstruction; changed semantics still conflict', () => fixture(async f => {
    await startProspective(f);
    const mutation = prospectiveComment();
    const first = await f.capability.fetch(genericWire('source', mutation));
    expect(first.status).toBe(200);
    const original = await first.text();
    f.changeTarget({ state: 'closed', head: { sha: 'c'.repeat(40) } });
    f.restart();
    // No new-write preflight may displace a previously completed operation's original receipt.
    f.throwTransport();
    const retry = await f.capability.fetch(genericWire('source', mutation));
    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe(original);
    expect((await f.capability.fetch(genericWire('source', { ...mutation, body: '{"body":"changed"}' }))).status).toBe(409);
    expect(remoteMutations(f).map(request => request.url)).toEqual([mutation.url]);
  }, { prospective: true }));

  it('preserves unknown writes without replay, allows closed/moved target readback, and seals only same-generation receipt references', () => fixture(async f => {
    await startProspective(f);
    const mutation = prospectiveComment('unknown-admitted-comment');
    f.loseResponse();
    expect(await (await f.capability.fetch(genericWire('source', mutation))).json()).toEqual({ code: 'OPERATOR_OPERATION_UNKNOWN' });
    f.restoreTransport();
    f.changeTarget({ state: 'closed', head: { sha: 'c'.repeat(40) } });
    f.restart();
    f.throwTransport();
    expect(await (await f.capability.fetch(genericWire('source', mutation))).json()).toEqual({ code: 'OPERATOR_OPERATION_UNKNOWN' });
    expect((await f.capability.fetch(genericWire('source', { ...mutation, body: '{"body":"changed"}' }))).status).toBe(409);
    f.restoreTransport();
    const readback = { operationId: 'admitted-positive-readback', url: mutation.url };
    const observed = await f.capability.fetch(genericWire('source', readback));
    expect(observed.status).toBe(200);
    expect(JSON.parse((await observed.json() as { body: string }).body)).toEqual([
      { id: 91, body: 'Exact admitted judgment', user: { id: 42 } },
    ]);
    const original = await (await f.capability.fetch(genericWire('receipt', { operationId: mutation.operationId }))).json() as { requestDigest: string };
    const reference = await (await f.capability.fetch(genericWire('receipt', { operationId: readback.operationId }))).json() as {
      operationId: string; requestDigest: string; responseDigest: string };
    const resolution = { operationId: mutation.operationId, requestDigest: original.requestDigest,
      readbacks: [{ operationId: reference.operationId, requestDigest: reference.requestDigest, responseDigest: reference.responseDigest }] };
    expect((await f.staleCapability.fetch(genericWire('resolve', resolution))).status).toBe(403);
    expect(await (await f.capability.fetch(genericWire('resolve', { ...resolution,
      readbacks: [{ ...resolution.readbacks[0], responseDigest: 'f'.repeat(64) }] }))).json()).toEqual({ code: 'OPERATOR_OPERATION_UNKNOWN' });
    expect(await (await f.capability.fetch(genericWire('resolve', resolution))).json()).toEqual({ resolved: true,
      operationId: mutation.operationId, requestDigest: original.requestDigest });
    expect(await (await f.capability.fetch(genericWire('source', mutation))).json()).toEqual({ resolved: true,
      operationId: mutation.operationId, requestDigest: original.requestDigest });
    expect(remoteMutations(f).map(request => request.url)).toEqual([mutation.url]);
  }, { prospective: true }));
});
