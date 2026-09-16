import { fileURLToPath, URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';
import type { RegistryFixtureCommand } from './fixtures/loader-worker';
import type { OperatorAdmissionRequest, OperatorRegistryResult } from '../../operators/registry';

// Real pinned Wrangler/workerd, executed only in the Node CI suite. No deploy,
// provider requests, secrets, production config or production fixture exports.
let worker: Unstable_DevWorker | undefined;
beforeAll(async () => {
  worker = await unstable_dev(fileURLToPath(new URL('./fixtures/loader-worker.ts', import.meta.url)), {
    config: fileURLToPath(new URL('./fixtures/wrangler.toml', import.meta.url)),
    local: true, ip: '127.0.0.1', port: 0, inspectorPort: 0, persist: false, logLevel: 'none',
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
  });
}, 60_000);
afterAll(async () => { await worker?.stop(); });

describe('REQ-OPERATOR-003: Worker Loader runtime boundary', () => {
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

describe('REQ-OPERATOR-002: SQLite registration and admission ordering', () => {
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
