/// <reference types="@cloudflare/vitest-plugin/types" />
// Register the established native Activity/auth fixture before production imports.
import { fixture, start, type DispatcherFixture } from './fixtures/dispatcher-production';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, reset, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry, type ManagementAdmissionReceipt, type ManagementExecutionSelection } from '../../operators/registry';
import { normalCallback, normalDeployment } from './fixtures/normal-dispatcher';
import { createOwnerRawCaptureStorage, discoverRawCaptures, readRawCapture } from '../../operators/raw-capture-storage';
import type { Env } from '../../types';
import type { ApplicationValue } from '../../operators/application-workflow';

const normal = { applicationWorkflow: true, normalHosting: true, repositoryOnly: true };
const configuration = { documentSync: { collection: 'invoices', mode: 'append-only' } };
const firstInput = { kind: 'user', body: 'Synchronize opaque batch α' };
const secondInput = { kind: 'user', body: 'Confirm opaque batch α' };
const firstCheckpoint = { cursor: 'batch/α', opaque: [false, 7, { token: 'first' }] };
const secondCheckpoint = { cursor: 'batch/β', opaque: { token: 'second' } };
const finalOutput = { synchronized: ['invoice-1'], watermark: { opaque: 'β' }, count: 1 };

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset(); });

function callback(f: DispatcherFixture, body: unknown, headers: Record<string, string> = {}) {
  const delivery = plans(f).at(-1)?.delivery as { token?: string } | undefined;
  return f.inOwnContext(() => f.installationCapability.fetch(normalCallback(f.activityId, 'state', body, {
    'x-codeflare-operator-installation': f.proof.installationId,
    'x-codeflare-operator-release': f.proof.releaseId,
    ...(delivery?.token ? { 'x-codeflare-dispatcher-delivery': delivery.token } : {}), ...headers,
  })));
}
type Entry = { key: string; status: 'absent'; version: null }
  | { key: string; status: 'value'; version: string; value: unknown }
  | { key: string; status: 'conflict' };
async function read(f: DispatcherFixture, keys: string[]): Promise<Entry[]> {
  const response = await callback(f, { operation: 'read', keys });
  // The HTTP boundary is asserted first: today's missing route fails as 404,
  // not as a missing import, undefined method, or invented exception.
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json() as { entries: Entry[] };
  return body.entries;
}
const cas = (f: DispatcherFixture, expected: Array<{ key: string; version: string | null }>,
  writes: Array<{ key: string; value: unknown }>) => callback(f, { operation: 'compare-exchange', expected, writes });
async function create(f: DispatcherFixture, key: string, value: unknown) {
  expect((await cas(f, [{ key, version: null }], [{ key, value }])).status).toBe(200);
  const [entry] = await read(f, [key]);
  expect(entry).toEqual({ key, status: 'value', version: expect.any(String), value });
  if (entry.status !== 'value') throw Error('Successful public CAS did not return a value');
  return entry.version;
}
async function denied(response: Response) {
  expect([400, 403, 409]).toContain(response.status);
  expect(await response.text()).not.toContain('PRIVATE_FOREIGN_VALUE');
}

/** Actual Registry SQLite owns state; only the existing fixture's identity,
 * deployment and bundle services remain controlled. No replacement CAS exists.
 * New Registry methods are reached through the real instance, in its own DO.
 */
async function withRegistry(run: (context: {
  adapter: (services: object) => object;
  enter: <T>(action: (native: DurableObjectState) => Promise<T>) => Promise<T>;
  attach: (f: DispatcherFixture) => void;
  reconstruct: () => void;
}) => Promise<void>) {
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  const name = `application-state-${crypto.randomUUID()}`;
  await runInDurableObject(namespace.getByName(name), async (_instance, native) => {
    const environment = { ...env } as unknown as Env;
    let registry = new OperatorRegistry(native, environment);
    const enter = <T>(action: (state: DurableObjectState) => Promise<T>) =>
      runInDurableObject(namespace.getByName(name), () => action(native));
    const seedSelection = async (selection: ManagementExecutionSelection) => enter(async state => {
      await registry.getManagementControls();
      const operator = { ...selection.operator, id: selection.operator.id, sourceRevision: 1, realm: 'internal',
        repositoryUrl: 'https://github.com/example/generic-operator', managers: selection.operator.invokers,
        githubPatCiphertext: 'fixture-not-used-for-acquisition', approvedWorkflow: { id: 1, ref: 'refs/heads/main' } };
      const installation = { ...selection.installation, name: selection.installation.id, approvedSourceRevision: 1 };
      const release = { ...selection.release, approved: true, sourceRevision: 1, repositoryId: operator.repositoryId };
      state.storage.sql.exec('INSERT OR REPLACE INTO operator_catalog VALUES(?,?,?,?,?,?)', operator.id,
        operator.profile, operator.realm, 1, '', JSON.stringify(operator));
      state.storage.sql.exec('INSERT OR REPLACE INTO operator_installations VALUES(?,?,?,?,?)', installation.id,
        installation.operatorId, installation.name, 1, JSON.stringify(installation));
      state.storage.sql.exec('INSERT OR REPLACE INTO operator_releases VALUES(?,?,?,?)', release.id,
        operator.id, JSON.stringify(release), selection.manifestJson);
      state.storage.sql.exec('INSERT OR REPLACE INTO operator_management_controls VALUES(1,?)', JSON.stringify({
        revision: selection.controlsRevision, managers: operator.managers,
        ceiling: { capabilities: operator.policy.capabilities, resourceProfileIds: [], sourceResponseBytes: 1048576 },
      }));
    });
    const adapter = (services: object) => new Proxy(services, { get(target, property) {
      if (property === 'upsertOwnedActivity') return (...args: unknown[]) => enter(async () =>
        Reflect.apply(registry.upsertOwnedActivity, registry, args));
      if (property === 'resolveManagementExecution' || property === 'admitManagement') return async (...args: unknown[]) => {
        const result = await Reflect.apply(Reflect.get(target, property), target, args) as {
          ok: boolean; value: ManagementExecutionSelection | ManagementAdmissionReceipt;
        };
        if (result.ok) {
          const receipt = property === 'admitManagement' ? result.value as ManagementAdmissionReceipt : undefined;
          await seedSelection(receipt ? receipt.selection : result.value as ManagementExecutionSelection);
          if (receipt) await enter(async state => {
            state.storage.sql.exec('INSERT OR REPLACE INTO operator_admissions VALUES(?,?)', receipt.activityId, JSON.stringify(receipt));
          });
        }
        return result;
      };
      if (Reflect.has(target, property)) return Reflect.get(target, property);
      const member = Reflect.get(registry, property);
      return typeof member === 'function'
        ? (...args: unknown[]) => enter(async () => Reflect.apply(member, registry, args)) : member;
    } });
    await run({ adapter, enter,
      attach: f => { Object.assign(environment, f.environment); },
      reconstruct: () => { registry = new OperatorRegistry(native, environment); },
    });
  });
}

// REQ-OPERATOR-014/043-048/062/085/092/094/097-107: generic storage,
// identity, fencing and recovery contracts; record contents are app-owned JSON.
describe('application-owned opaque state through authenticated OPERATOR', () => {
  it.each([
    { name: 'non-Renovate document sync, logging OFF', loggingEnabled: false, value: { cursor: 'α', pending: ['invoice-1'], enabled: false } },
    { name: 'application claim, logging ON', loggingEnabled: true, value: { work: 'opaque-work', hold: { owner: 'original', attempt: 1 } } },
  ])('$name reads absent, CASes all values, and survives both Registry and Activity reconstruction', ({ value, loggingEnabled }) => withRegistry(async r => {
    await fixture(async f => {
      r.attach(f); await start(f);
      const original = await f.activity.getAdmission();
      const plan = await f.activity.getRuntimePlan();
      expect(await read(f, ['cursor', 'claim'])).toEqual([
        { key: 'cursor', status: 'absent', version: null }, { key: 'claim', status: 'absent', version: null },
      ]);
      expect((await cas(f, [{ key: 'cursor', version: null }, { key: 'claim', version: null }],
        [{ key: 'cursor', value }, { key: 'claim', value: ['opaque', null, 3] }])).status).toBe(200);
      const retained = await read(f, ['cursor', 'claim']);
      expect(retained).toEqual([
        { key: 'cursor', status: 'value', version: expect.any(String), value },
        { key: 'claim', status: 'value', version: expect.any(String), value: ['opaque', null, 3] },
      ]);
      r.reconstruct(); f.activity = f.restart(); await f.drainBackground();
      expect(await read(f, ['cursor', 'claim'])).toEqual(retained);
      expect(await f.activity.getAdmission()).toEqual(original);
      expect(await f.activity.getRuntimePlan()).toEqual(plan);
    }, { ...normal, registryAdapter: r.adapter, applicationConfiguration: configuration, loggingEnabled });
  }));

  it('checks every expected version before committing any member of a multi-key exchange', () => withRegistry(async r => {
    await fixture(async f => {
      r.attach(f); await start(f);
      const v1 = await create(f, 'first', { owner: 'original' });
      const v2 = await create(f, 'second', { position: 1 });
      const before = await read(f, ['first', 'second', 'third']);
      expect((await cas(f, [{ key: 'first', version: v1 }, { key: 'second', version: 'f'.repeat(64) },
        { key: 'third', version: null }], [{ key: 'first', value: { owner: 'replacement' } },
        { key: 'second', value: 2 }, { key: 'third', value: 'must-not-appear' }])).status).toBe(409);
      expect(await read(f, ['first', 'second', 'third'])).toEqual(before);
      expect((await cas(f, [{ key: 'first', version: v1 }, { key: 'second', version: v2 }],
        [{ key: 'first', value: { owner: 'original', progress: 2 } }, { key: 'second', value: 2 }])).status).toBe(200);
      const after = await read(f, ['first', 'second']);
      expect(after).toMatchObject([{ status: 'value', value: { owner: 'original', progress: 2 } }, { status: 'value', value: 2 }]);
      expect(after.map(entry => 'version' in entry && entry.version)).not.toEqual([v1, v2]);
      expect((await cas(f, [{ key: 'first', version: v1 }], [{ key: 'first', value: 'stale-writer' }])).status).toBe(409);
      expect(await read(f, ['first', 'second'])).toEqual(after);
    }, { ...normal, registryAdapter: r.adapter });
  }));

  it.each(['manual/manual', 'manual/automatic'] as const)('%s Activities share one app scope and elect one complete winner without changing either admission', mode => withRegistry(async r => {
    const config = { renovate: { repository: 'nikolanovoselec/komodo', automaticRuns: true, repetitionIntervalSeconds: 900 } };
    await fixture(async manual => {
      r.attach(manual); await start(manual);
      await fixture(async other => {
        r.attach(other); await start(other);
        const admissions = [await manual.inOwnContext(() => manual.activity.getAdmission()), await other.activity.getAdmission()];
        expect(await read(manual, ['shared'])).toEqual([{ key: 'shared', status: 'absent', version: null }]);
        const values = [{ originalActivity: manual.activityId, owner: 'first' }, { originalActivity: other.activityId, owner: 'second' }];
        const responses = await Promise.all([cas(manual, [{ key: 'shared', version: null }], [{ key: 'shared', value: values[0] }]),
          cas(other, [{ key: 'shared', version: null }], [{ key: 'shared', value: values[1] }])]);
        expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
        const retained = await read(manual, ['shared']);
        expect(retained).toEqual([{ key: 'shared', status: 'value', version: expect.any(String),
          value: values[responses.findIndex(response => response.status === 200)] }]);
        expect(await read(other, ['shared'])).toEqual(retained);
        const entry = retained[0];
        if (entry.status !== 'value') throw Error('Winning public exchange lost its value');
        const follower = responses.findIndex(response => response.status === 200) === 0 ? other : manual;
        const update = { progress: 'advanced-by-another-activity' };
        expect((await cas(follower, [{ key: 'shared', version: entry.version }], [{ key: 'shared', value: update }])).status).toBe(200);
        expect(await read(manual, ['shared'])).toEqual([{ key: 'shared', status: 'value', version: expect.any(String), value: update }]);
        expect([await manual.inOwnContext(() => manual.activity.getAdmission()), await other.activity.getAdmission()]).toEqual(admissions);
      }, { applicationWorkflow: true, normalHosting: true, intent4: true, delegated: mode === 'manual/automatic',
        applicationConfiguration: config, applicationInput: { repository: 'nikolanovoselec/komodo' },
        registryAdapter: r.adapter, preserveGlobalMocks: true });
    }, { applicationWorkflow: true, normalHosting: true, intent4: true, applicationConfiguration: config,
      applicationInput: { repository: 'nikolanovoselec/komodo' }, registryAdapter: r.adapter });
  }));

  it('opaque keys cannot address raw Registry metadata, including an otherwise valid JSON value', () => withRegistry(async r => {
    await fixture(async f => {
      r.attach(f); await start(f);
      const key = 'private-registry-record';
      const privateValue = { secret: 'PRIVATE_FOREIGN_VALUE', owner: 'another-app' };
      await r.enter(native => native.storage.put(key, privateValue));
      expect(await read(f, [key])).toEqual([{ key, status: 'absent', version: null }]);
      await create(f, key, { appValue: true });
      expect(await r.enter(native => native.storage.get(key))).toEqual(privateValue);
      expect(await read(f, [key])).toEqual([{ key, status: 'value', version: expect.any(String), value: { appValue: true } }]);
    }, { ...normal, registryAdapter: r.adapter });
  }));

  it.each(['principal', 'application'] as const)('foreign %s receives neither private values nor replacement ownership', scope => withRegistry(async r => {
    await fixture(async original => {
      r.attach(original); await start(original);
      const version = await create(original, 'held', { secret: 'PRIVATE_FOREIGN_VALUE' });
      const owned = await read(original, ['held']);
      await fixture(async foreign => {
        r.attach(foreign); await start(foreign);
        const response = await callback(foreign, { operation: 'read', keys: ['held'] });
        const text = await response.text();
        expect(text).not.toContain('PRIVATE_FOREIGN_VALUE');
        if (scope === 'application' && response.status === 200
          && JSON.parse(text).entries[0].status === 'absent') {
          // A disjoint app scope may create its own same-named key, never
          // replace or reveal the other application's value.
          await create(foreign, 'held', 'independent-app-value');
        } else {
          if (response.status === 200) expect(JSON.parse(text)).toEqual({ entries: [{ key: 'held', status: 'conflict' }] });
          else expect(response.status).toBe(403);
          await denied(await cas(foreign, [{ key: 'held', version }], [{ key: 'held', value: 'stolen' }]));
          await denied(await cas(foreign, [{ key: 'held', version: null }], [{ key: 'held', value: 'reset' }]));
        }
        expect(await read(original, ['held'])).toEqual(owned);
      }, { ...normal, registryAdapter: r.adapter, preserveGlobalMocks: true,
        ...(scope === 'principal' ? { principal: { subject: 'foreign', email: 'foreign@example.test' } }
          : { applicationId: 'different-application', applicationRepositoryId: 7 }) });
    }, { ...normal, registryAdapter: r.adapter });
  }));

  it.each(['foreign-owner', 'foreign-bucket', 'unknown-layout', 'held'] as const)(
    'legacy %s remains held across passive reads, failed reset and reconstruction', kind => withRegistry(async r => {
      await fixture(async f => {
        r.attach(f); await start(f);
        // Exact historical compatibility key from Registry's existing admission
        // fixtures, not caller-selected namespaces or a synthetic new store.
        const key = `renovate:head:${f.proof.repositoryId}:17:${f.proof.head}`;
        const storageKey = `renovate-admission:${f.proof.repositoryId}:17:${f.proof.head}`;
        const legacy = kind === 'unknown-layout' ? { state: 'unknown', private: 'PRIVATE_FOREIGN_VALUE' }
          : { ...f.proof, activityId: 'legacy-original',
            ...(kind === 'foreign-owner' ? { ownerKey: 'foreign-owner', private: 'PRIVATE_FOREIGN_VALUE' }
              : kind === 'foreign-bucket' ? { actor: { ...f.proof.actor, bucket: 'foreign-bucket' }, private: 'PRIVATE_FOREIGN_VALUE' } : {}) };
        await r.enter(native => native.storage.put({ [storageKey]: legacy, 'renovate-activity:legacy-original': legacy }));
        const observe = async () => {
          const response = await callback(f, { operation: 'read', keys: [key] });
          const text = await response.text();
          if ((kind === 'unknown-layout' || kind === 'foreign-bucket') && response.status === 503) {
            expect(text).not.toContain('PRIVATE_FOREIGN_VALUE');
            return { status: response.status };
          }
          expect(response.status).toBe(200);
          const entries = (JSON.parse(text) as { entries: Entry[] }).entries;
          if (kind === 'held') expect(entries).toEqual([{ key, status: 'value', version: expect.any(String), value: legacy }]);
          else expect(entries).toEqual([{ key, status: 'conflict' }]);
          return entries;
        };
        const entries = await observe();
        const reset = await cas(f, [{ key, version: null }], [{ key, value: { ownerKey: f.proof.ownerKey } }]);
        expect(kind === 'unknown-layout' || kind === 'foreign-bucket' ? [409, 503] : [409]).toContain(reset.status);
        expect(await reset.text()).not.toContain('PRIVATE_FOREIGN_VALUE');
        r.reconstruct(); f.activity = f.restart(); await f.drainBackground();
        expect(await observe()).toEqual(entries);
        expect(await r.enter(native => native.storage.get(storageKey))).toEqual(legacy);
        expect(await r.enter(native => native.storage.get('renovate-activity:legacy-original'))).toEqual(legacy);
      }, { applicationWorkflow: true, normalHosting: true, prospective: true, registryAdapter: r.adapter });
    }));

  it.each(['expired', 'cancelled', 'wrong-generation', 'release', 'configuration', 'disabled', 'credentials'] as const)(
    '%s caller cannot read or mutate a retained app value', fault => withRegistry(async r => {
      await fixture(async f => {
        r.attach(f); await start(f);
        const version = await create(f, 'retained', { owner: 'original' });
        const headers: Record<string, string> = {};
        if (fault === 'expired') f.expire();
        if (fault === 'cancelled') { await f.activity.cancelDrive(); await f.drainBackground(); }
        if (fault === 'wrong-generation') headers['x-codeflare-operator-generation'] = '2';
        if (fault === 'release') f.changeConnection({ releaseId: 'replacement-release' });
        if (fault === 'configuration') f.changeInferenceAuthority('installation');
        if (fault === 'disabled') f.revoke();
        if (fault === 'credentials') headers.authorization = 'Bearer unrelated-caller';
        const before = await r.enter(native => native.storage.list());
        await denied(await callback(f, { operation: 'read', keys: ['retained'] }, headers));
        await denied(await callback(f, { operation: 'compare-exchange', expected: [{ key: 'retained', version }],
          writes: [{ key: 'retained', value: 'must-not-replace-original' }] }, headers));
        expect(await r.enter(native => native.storage.list())).toEqual(before);
      }, { ...normal, registryAdapter: r.adapter });
    }));

  it.each([
    { operation: 'read', keys: ['x'], ownerKey: 'forged', installationId: 'foreign' },
    { operation: 'read', keys: ['x'], namespace: 'registry', safe: true },
    { operation: 'compare-exchange', expected: [], writes: [{ key: 'x', value: true }] },
    { operation: 'compare-exchange', expected: [{ key: 'x', version: null }, { key: 'x', version: null }], writes: [{ key: 'x', value: true }] },
    { operation: 'read', keys: ['x'.repeat(1024 * 1024)] },
    { operation: 'compare-exchange', expected: [{ key: 'new', version: null }], writes: [{ key: 'new', value: 'x'.repeat(1024 * 1024) }] },
    { operation: 'compare-exchange', expected: [{ key: 'x', version: null }], writes: [{ key: 'x', value: 1 }, { key: 'x', value: 2 }] },
  ])('rejects untrusted authority/unbounded or ambiguous atomic input %# without altering state', body => withRegistry(async r => {
    await fixture(async f => {
      r.attach(f); await start(f); await create(f, 'x', 'original');
      const before = await read(f, ['x']);
      await denied(await callback(f, body));
      expect(await read(f, ['x'])).toEqual(before);
    }, { ...normal, registryAdapter: r.adapter });
  }));
});

// REQ-OPERATOR-090/091: real authenticated callbacks retain full private values,
// independently of current logging settings and without changing application state.
describe('application callback private raw capture', () => {
  it.each([true, false])('original logging=%s controls recovered state and context payloads', loggingEnabled => withRegistry(async r => {
    const opaque = { password: 'PRIVATE_APPLICATION_PASSWORD', headers: { authorization: 'Bearer PRIVATE_APPLICATION_TOKEN' },
      body: '漢🦊é'.repeat(6000), nested: { values: [null, false, 0, { tail: 'PRIVATE_APPLICATION_TAIL' }] } };
    await fixture(async f => {
      r.attach(f);
      expect(await start(f)).toMatchObject({ ok: true });
      await f.drainBackground();
      const admission = await f.activity.getAdmission();
      const plan = await f.activity.getRuntimePlan();
      // Only the admitted policy controls payload retention, not later settings.
      f.setCurrentLogging(!loggingEnabled);
      const exchange = { operation: 'compare-exchange', expected: [{ key: 'opaque', version: null }],
        writes: [{ key: 'opaque', value: opaque }] };
      const committed = await callback(f, exchange);
      expect(committed.status).toBe(200);
      expect(await committed.json()).toEqual({ status: 'committed' });
      const retained = await read(f, ['opaque']);
      expect(retained).toEqual([{ key: 'opaque', status: 'value', version: expect.any(String), value: opaque }]);
      await f.drainBackground();
      const registryBefore = await r.enter(native => native.storage.list());
      let activityBefore = new Map<string, unknown>();
      await f.mutateEvidence(async storage => {
        activityBefore = new Map([...await storage.list()].filter(([key]) => !key.startsWith('operator-raw')));
      });
      const delivery = plans(f).at(-1)!.delivery as { token: string; ordinal: number };
      const response = await f.inOwnContext(() => f.installationCapability.fetch(normalCallback(f.activityId, 'context',
        { deliveryToken: delivery.token }, { 'x-codeflare-dispatcher-delivery': delivery.token })));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const context = await response.json() as { context: unknown; delivery: unknown; receipt: unknown };
      expect(context.context).toEqual(opaque);
      expect(context.delivery).toEqual(delivery);
      await f.drainBackground();

      // Discover from encrypted owner/run locators, not a receipt or console ID;
      // the existing reader authenticates, decrypts and reconstructs every frame.
      const records: Array<{ stage: string; value: unknown }> = [];
      await f.mutateEvidence(async native => {
        const scope = { ownerKey: f.proof.ownerKey,
          scope: { kind: 'activity' as const, activityId: f.activityId, generation: 1 } };
        const storage = await createOwnerRawCaptureStorage(f.environment, native, async () => {});
        let cursor: string | null = null;
        do {
          const page = await discoverRawCaptures({ scope, storage, cursor: cursor ?? undefined,
            authorize: async requested => { expect(requested).toEqual(scope); } });
          expect(page.status).toBe('complete');
          for (const binding of page.bindings) {
            const archive = await readRawCapture({ binding, storage });
            expect(archive.status).toBe('complete');
            records.push(...archive.records);
          }
          cursor = page.cursor;
        } while (cursor);
        const encrypted = await native.list({ prefix: 'operator-raw' });
        if (loggingEnabled) {
          expect(encrypted.size).toBeGreaterThan(0);
          for (const value of encrypted.values()) expect(value).toMatch(/^v1:[A-Za-z0-9+/]+={0,2}$/);
        } else {
          expect(encrypted.size).toBe(0);
        }
      });
      if (loggingEnabled) {
        expect(records).toContainEqual({ stage: 'dispatcher-application-request',
          value: { path: '/v1/dispatcher/state', body: exchange } });
        expect(records).toContainEqual({ stage: 'dispatcher-application-response', value: { entries: retained } });
        expect(records).toContainEqual({ stage: 'dispatcher-application-context', value: context });
      } else {
        expect(records).toEqual([]);
      }
      expect(await read(f, ['opaque'])).toEqual(retained);
      expect(await r.enter(native => native.storage.list())).toEqual(registryBefore);
      expect(await f.activity.getAdmission()).toEqual(admission);
      expect(await f.activity.getRuntimePlan()).toEqual(plan);
      await f.drainBackground();
      await f.mutateEvidence(async storage => {
        expect(new Map([...await storage.list()].filter(([key]) => !key.startsWith('operator-raw')))).toEqual(activityBefore);
      });
    }, { ...normal, registryAdapter: r.adapter, loggingEnabled, applicationConfiguration: configuration,
      applicationPlan: () => ({ kind: 'dispatch', checkpoint: firstCheckpoint, message: firstInput, context: opaque }) });
  }));
});

// REQ-OPERATOR-061 generic trigger contract. The controlled external App
// consults real Root state; Root must not bypass that decision on manual intake.
// SDK discovery/business-policy coverage remains in the Dispatcher repository.
describe('manual and automatic intake use the same application admission', () => {
  it.each([
    { trigger: 'manual', automaticRuns: true, held: true },
    { trigger: 'automatic', automaticRuns: true, held: true },
    { trigger: 'manual', automaticRuns: false, held: true },
    { trigger: 'manual', automaticRuns: false, held: false },
  ])('$trigger automaticRuns=$automaticRuns held=$held preserves the original target and decision', scenario => withRegistry(async r => {
    const repository = 'nikolanovoselec/komodo';
    const config = { renovate: { repository, automaticRuns: scenario.automaticRuns, repetitionIntervalSeconds: 900 } };
    let current!: DispatcherFixture;
    let key = '';
    const empty = { repository, results: [] };
    const admitted = { repository, results: [{ pullRequest: 17, headSha: 'b'.repeat(40),
      decision: 'DO_NOT_MERGE', comment: 'Controlled application result', outcome: 'NOT_MERGED' }] };
    const applicationPlan = async (body: Record<string, unknown>) => {
      const [state] = await read(current, [key]);
      if (state.status !== 'absent') return { kind: 'complete', checkpoint: { held: true }, result: empty };
      return body.checkpoint === null
        ? { kind: 'dispatch', checkpoint: { admitted: true }, message: firstInput, context: {} }
        : { kind: 'complete', checkpoint: { done: true }, result: admitted };
    };
    await fixture(async f => {
      current = f; r.attach(f);
      key = `renovate:head:${f.proof.repositoryId}:17:${f.proof.head}`;
      const storageKey = `renovate-admission:${f.proof.repositoryId}:17:${f.proof.head}`;
      const legacy = { ...f.proof, activityId: 'original-held-target' };
      if (scenario.held) await r.enter(native => native.storage.put({ [storageKey]: legacy,
        'renovate-activity:original-held-target': legacy }));
      await start(f);
      if (scenario.held) {
        // Today's manual intake bypasses the App hook and admits a normal SDK
        // job here. The failure is an observable duplicate-work admission.
        expect(accepted(f)).toEqual([]);
        expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result: empty } });
        expect(await r.enter(native => native.storage.get(storageKey))).toEqual(legacy);
        expect(await r.enter(native => native.storage.get('renovate-activity:original-held-target'))).toEqual(legacy);
      } else {
        expect(accepted(f)).toHaveLength(1);
        expect(JSON.parse(accepted(f)[0].wire)).toMatchObject({ message: firstInput,
          initialData: { input: { repository }, configuration: config } });
        f.normalTransport!.settle('completed');
        await f.activity.reconcileDispatcherLease();
        expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result: admitted } });
      }
      expect(plans(f)[0]).toMatchObject({ initialData: { input: { repository }, configuration: config } });
    }, { applicationWorkflow: true, normalHosting: true, intent4: true, delegated: scenario.trigger === 'automatic',
      applicationInput: { repository }, applicationConfiguration: config, applicationPlan, registryAdapter: r.adapter });
  }));
});

function plans(f: DispatcherFixture) {
  return f.normalTransport!.requests.filter(request => request.path === '/control/plan').map(request => request.body);
}
function accepted(f: DispatcherFixture) { return [...f.normalTransport!.admissions.values()]; }
function dispatchDecision(body: Record<string, unknown>) {
  if (body.checkpoint === null) return { kind: 'dispatch', checkpoint: firstCheckpoint, message: firstInput, context: {} };
  if (JSON.stringify(body.checkpoint) === JSON.stringify(firstCheckpoint)) {
    return { kind: 'dispatch', checkpoint: secondCheckpoint, message: secondInput, context: {} };
  }
  return { kind: 'complete', checkpoint: { done: true }, result: finalOutput };
}
async function planned(f: DispatcherFixture) {
  expect(await start(f)).toMatchObject({ ok: true });
  expect(plans(f)[0]).toMatchObject({ activityId: f.activityId, generation: 1,
    installationId: 'installation', releaseId: 'release', connectionRevision: 1,
    workerVersionId: normalDeployment.workerVersionId, checkpoint: null,
    initialData: { input: f.input, configuration } });
  expect(accepted(f)).toHaveLength(1);
  expect(JSON.parse(accepted(f)[0].wire)).toMatchObject({ message: firstInput });
}
const workflowOptions = { ...normal, applicationConfiguration: configuration, applicationPlan: dispatchDecision };

async function restartApplication(f: DispatcherFixture) {
  // restart() returns the new instance; the fixture's original activity field is
  // not a live getter. Enter that instance to exercise cold recovery.
  f.activity = f.restart();
  await f.drainBackground();
  await f.activity.getAdmission();
  await f.drainBackground();
}

/** The remote planner has received the input, but its response is unavailable
 * until explicitly restored. No SDK or Root method is replaced. */
function interruptedSettlementPlan(decide: (body: Record<string, unknown>) => unknown = dispatchDecision) {
  let unavailable = true;
  return {
    plan: (body: Record<string, unknown>) => {
      const decision = decide(body);
      if (body.settlement && unavailable) throw new Error('External planner response lost');
      return decision;
    },
    restore: () => { unavailable = false; },
  };
}

// The external application supplies only opaque decisions. SDK receipts, frozen
// input/identity, dispatch keys and terminal collection remain real Root behavior.
describe('generic application decisions on the existing normal control lifecycle', () => {
  it.each(['completed', 'failed', 'failed-empty'] as const)(
    'cold planner retry preserves exact %s settlement without another SDK observation or target effect', async outcome => {
      const remote = interruptedSettlementPlan();
      await fixture(async f => {
        await start(f);
        const originalPlan = await f.activity.getRuntimePlan();
        const first = accepted(f)[0];
        const delivery = plans(f)[0].delivery as { token: string; ordinal: number };
        const mutation = { operationId: 'original-target-effect', method: 'POST',
          url: 'https://api.github.com/repos/acme/updates/issues/17/comments', body: '{"body":"Original target effect"}' };
        const response = await f.installationCapability.fetch(normalCallback(f.activityId, 'source', mutation,
          { 'x-codeflare-dispatcher-delivery': delivery.token }));
        expect(response.status).toBe(200);
        const effects = f.sent.filter(request => request.method !== 'GET').map(request => request.url);
        expect(effects).toEqual([mutation.url]);
        const data: Record<string, ApplicationValue[]> = outcome === 'failed-empty' ? {}
          : { 'opaque-work': [{ text: '秘密🧪'.repeat(12000), complete: outcome === 'completed' }] };
        f.normalTransport!.settleSubmission(first.receipt.submissionId, outcome === 'completed' ? 'completed' : 'failed',
          Object.entries(data).flatMap(([name, values]) => values.map(value => ({ name, data: value }))));
        if (outcome === 'completed') f.normalTransport!.changeReply({ text: 'Original SDK text', metadata: { opaque: [null, false, 'β'] } });
        await f.activity.reconcileDispatcherLease();
        const interrupted = structuredClone(plans(f).at(-1)!);
        expect(interrupted).toMatchObject({ checkpoint: firstCheckpoint, initialData: plans(f)[0].initialData,
          settlement: outcome === 'completed'
            ? { receipt: first.receipt, reply: { text: 'Original SDK text', data, metadata: { opaque: [null, false, 'β'] },
              uid: first.receipt.uid, submissionId: first.receipt.submissionId } }
            : { receipt: first.receipt, status: 'failed', data } });
        let pendingProof: unknown;
        await f.mutateEvidence(async storage => {
          const lease = await storage.get<{ application: { pending: unknown } }>('dispatcher:lease');
          pendingProof = lease!.application.pending;
          expect(pendingProof).toMatchObject({ delivery: interrupted.delivery, confirmed: { delivery } });
        });
        expect(accepted(f)).toEqual([first]);
        expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
        const observed = f.normalTransport!.requests.filter(request => request.path === '/control/read');
        // A later SDK view is neither needed nor allowed to replace the saved input.
        f.normalTransport!.changeReceipt({ uid: 'foreign-later-view' });
        f.normalTransport!.changeReply({ text: 'Changed later SDK data', data: { changed: [true] } });
        await restartApplication(f);
        expect(plans(f).at(-1)).toEqual(interrupted);
        expect(accepted(f)).toEqual([first]);
        await f.mutateEvidence(async storage => {
          const lease = await storage.get<{ application: { pending: unknown } }>('dispatcher:lease');
          expect(lease!.application.pending).toEqual(pendingProof);
        });
        remote.restore();
        await restartApplication(f);
        expect(plans(f).at(-1)).toEqual(interrupted);
        expect(f.normalTransport!.requests.filter(request => request.path === '/control/read')).toEqual(observed);
        expect(accepted(f)).toHaveLength(2);
        const successor = accepted(f)[1];
        expect(JSON.parse(successor.wire)).toMatchObject({ uid: first.receipt.uid, message: secondInput });
        expect((await f.activity.getRuntimePlan())!.deadline).toBe(originalPlan!.deadline);
        expect((await f.activity.getRuntimePlan())!.invocationJson).toBe(originalPlan!.invocationJson);
        await f.mutateEvidence(async storage => {
          const lease = await storage.get<{ application: Record<string, unknown> }>('dispatcher:lease');
          expect(lease!.application).not.toHaveProperty('pending');
        });
        f.normalTransport!.changeReceipt({}); f.normalTransport!.changeReply({});
        f.normalTransport!.settleSubmission(successor.receipt.submissionId, 'completed');
        await f.activity.reconcileDispatcherLease();
        expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result: finalOutput } });
        expect(accepted(f)).toEqual([first, successor]);
        expect(f.sent.filter(request => request.method !== 'GET').map(request => request.url)).toEqual(effects);
        await f.mutateEvidence(async storage => {
          const lease = await storage.get<{ application: Record<string, unknown> }>('dispatcher:lease');
          expect(lease!.application).not.toHaveProperty('pending');
        });
      }, { ...workflowOptions, applicationPlan: remote.plan, capacityPolicy: { assessmentBytes: 128 * 1024 },
        applicationConfiguration: { ...configuration, repository: 'acme/updates' }, applicationWriteRepositoriesPath: '/repository' });
    });

  // REQ-OPERATOR-048 AC2: independently valid current inputs must remain
  // replayable when their combined size exceeds SQLite's 8 MB key/value bound.
  it('replays a large settlement beside an existing checkpoint exceeding 8 MB combined', async () => {
    const allowance = 5 * 1024 * 1024;
    const checkpoint = { retained: 'c'.repeat(4.5 * 1024 * 1024) };
    const data = { 'opaque-work': [{ text: 's'.repeat(4.5 * 1024 * 1024), tail: 'original' }] };
    const remote = interruptedSettlementPlan(body => body.checkpoint === null
      ? { kind: 'dispatch', checkpoint, context: {}, message: firstInput }
      : { kind: 'complete', checkpoint: { done: true }, result: finalOutput });
    await fixture(async f => {
      await start(f);
      const original = accepted(f);
      expect(original).toHaveLength(1);
      const delivery = plans(f)[0].delivery;
      f.normalTransport!.settleSubmission(original[0].receipt.submissionId, 'completed',
        [{ name: 'opaque-work', data: data['opaque-work'][0] }]);
      await f.activity.reconcileDispatcherLease();
      const interrupted = structuredClone(plans(f).at(-1)!);
      expect(interrupted).toMatchObject({ checkpoint, settlement: { receipt: original[0].receipt,
        reply: { data, uid: original[0].receipt.uid, submissionId: original[0].receipt.submissionId } } });
      const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
      expect(bytes(checkpoint)).toBeLessThan(allowance);
      expect(bytes(interrupted.settlement)).toBeLessThan(allowance);
      expect(bytes({ checkpoint, settlement: interrupted.settlement })).toBeGreaterThan(8 * 1024 * 1024);
      await f.mutateEvidence(async storage => {
        const lease = await storage.get<{ application: { pending: { confirmed: { delivery: unknown } } } }>('dispatcher:lease');
        expect(lease!.application.pending.confirmed.delivery).toEqual(delivery);
      });
      const observed = f.normalTransport!.requests.filter(request => request.path === '/control/read');
      f.normalTransport!.changeReply({ data: { changed: [true] } });
      await restartApplication(f);
      expect(plans(f).at(-1)).toEqual(interrupted);
      expect(accepted(f)).toEqual(original);
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      remote.restore();
      await restartApplication(f);
      expect(plans(f).at(-1)).toEqual(interrupted);
      expect(f.normalTransport!.requests.filter(request => request.path === '/control/read')).toEqual(observed);
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result: finalOutput } });
      expect(accepted(f)).toEqual(original);
      await f.mutateEvidence(async storage => {
        const lease = await storage.get<{ application: Record<string, unknown> }>('dispatcher:lease');
        expect(lease!.application).not.toHaveProperty('pending');
        expect((await storage.list({ prefix: 'dispatcher:application-settlement:' })).size).toBe(0);
      });
    }, { ...normal, loggingEnabled: false, capacityPolicy: { assessmentBytes: allowance }, applicationPlan: remote.plan });
  });

  it('a saved failed settlement cannot certify successful completion after a lost planner response', async () => {
    const remote = interruptedSettlementPlan(body => body.checkpoint === null
      ? dispatchDecision(body) : { kind: 'complete', checkpoint: { done: true }, result: { inventedSuccess: true } });
    await fixture(async f => {
      await planned(f);
      const original = accepted(f);
      f.normalTransport!.settleSubmission(original[0].receipt.submissionId, 'failed', [{ name: 'failure', data: { exact: true } }]);
      await f.activity.reconcileDispatcherLease();
      const interrupted = structuredClone(plans(f).at(-1)!);
      remote.restore(); await restartApplication(f);
      expect(plans(f).at(-1)).toEqual(interrupted);
      expect(accepted(f)).toEqual(original);
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null });
      await f.mutateEvidence(async storage => { expect(await storage.get('dispatcher:result:1')).toBeUndefined(); });
    }, { ...workflowOptions, applicationPlan: remote.plan });
  });

  it.each(['receipt', 'delivery', 'missing-settlement', 'missing-chunk', 'changed-chunk', 'malformed-settlement', 'oversized-settlement',
    'expired', 'revoked', 'cancelled', 'already-fenced'] as const)(
    'saved settlement cannot reopen work across the %s fence', async fault => {
      const remote = interruptedSettlementPlan();
      await fixture(async f => {
        await planned(f);
        const original = accepted(f);
        f.normalTransport!.settleSubmission(original[0].receipt.submissionId, 'completed');
        await f.activity.reconcileDispatcherLease();
        if (fault === 'expired') f.expire();
        else if (fault === 'revoked') f.revoke();
        else if (fault === 'cancelled') await f.activity.cancelDrive();
        else if (fault === 'already-fenced') await f.activity.interruptDrive(1);
        else await f.mutateEvidence(async storage => {
          const lease = (await storage.get<{ receipt: Record<string, unknown>; application: {
            delivery: { token: string }; pending: { confirmed?: { delivery: unknown; settlement?: unknown } } } }>('dispatcher:lease'))!;
          if (fault === 'receipt') lease.receipt.submissionId = 'foreign-submission';
          if (fault === 'delivery') lease.application.delivery = { ...lease.application.delivery, token: 'foreign-delivery' };
          if (fault === 'missing-settlement') delete lease.application.pending.confirmed;
          if (fault === 'missing-chunk') await storage.delete('dispatcher:application-settlement:1:0');
          if (fault === 'changed-chunk') {
            const chunk = (await storage.get<Uint8Array>('dispatcher:application-settlement:1:0'))!;
            chunk[chunk.length - 1] ^= 1;
            await storage.put('dispatcher:application-settlement:1:0', chunk);
          }
          if (fault === 'malformed-settlement' || fault === 'oversized-settlement') {
            // Exercise the legacy inline format as well as current references;
            // do not leave both formats present and fail only on unknown keys.
            lease.application.pending.confirmed = { delivery: lease.application.pending.confirmed!.delivery,
              settlement: fault === 'malformed-settlement' ? { status: 'completed' } : {
                receipt: lease.receipt, reply: { text: 'x'.repeat(128 * 1024 + 64 * 1024), data: {},
                  uid: lease.receipt.uid, submissionId: lease.receipt.submissionId } } };
          }
          await storage.put('dispatcher:lease', lease);
        });
        const submittedPlans = structuredClone(plans(f));
        const observed = f.normalTransport!.requests.filter(request => request.path === '/control/read');
        remote.restore(); await restartApplication(f);
        await f.activity.reconcileDispatcherLease();
        expect(plans(f)).toEqual(submittedPlans);
        expect(f.normalTransport!.requests.filter(request => request.path === '/control/read')).toEqual(observed);
        expect(accepted(f)).toEqual(original);
        expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
        expect((await f.activity.getBrowserDetail())!.result).toBeNull();
        expect(f.sent.filter(request => request.method !== 'GET')).toEqual([]);
      }, { ...workflowOptions, applicationPlan: remote.plan, capacityPolicy: { assessmentBytes: 128 * 1024 } });
    });

  it.each([false, true])('collects an admitted checkpoint above64KiB within its allowance, cold=%s', cold => fixture(async f => {
    const checkpoint = { retained: 'x'.repeat(96 * 1024) };
    const result = { complete: true };
    await start(f);
    const original = accepted(f);
    expect(original).toHaveLength(1);
    if (cold) { f.activity = f.restart(); await f.drainBackground(); }
    f.normalTransport!.settleSubmission(original[0].receipt.submissionId, 'completed');
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true,
      detail: { executionStatus: 'completed', checkpoint, result } });
    expect(accepted(f)).toEqual(original);
    expect(await f.activity.commitDrive(1, { schemaVersion: 1, status: 'completed',
      checkpoint: 'x'.repeat(128 * 1024 + 1), result })).toEqual({ ok: false, reason: 'invalid-update' });
    expect(await f.activity.getBrowserDetail()).toMatchObject({ checkpoint, result });
  }, { ...normal, capacityPolicy: { assessmentBytes: 128 * 1024 }, applicationPlan: body => body.checkpoint === null
    ? { kind: 'dispatch', checkpoint: { retained: 'x'.repeat(96 * 1024) }, context: {}, message: firstInput }
    : { kind: 'complete', checkpoint: body.checkpoint, result: { complete: true } } }));

  it.each([false, true])('failed SDK work cannot certify final completion even after reconstruction, cold=%s', cold => fixture(async f => {
    await start(f);
    const original = accepted(f);
    f.normalTransport!.settleSubmission(original[0].receipt.submissionId, 'failed',
      [{ name: 'actual-failure', data: { preserved: true } }]);
    if (cold) { f.activity = f.restart(); await f.drainBackground(); }
    await f.activity.reconcileDispatcherLease();
    expect(accepted(f)).toEqual(original);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect((await f.activity.getBrowserDetail())!.result).toBeNull();
    await f.mutateEvidence(async storage => { expect(await storage.get('dispatcher:result:1')).toBeUndefined(); });
  }, { ...normal, applicationPlan: body => body.checkpoint === null
    ? { kind: 'dispatch', checkpoint: { active: true }, context: {}, message: firstInput }
    : { kind: 'complete', checkpoint: { done: true }, result: { inventedSuccess: true } } }));

  it.each([true, false])('matching SDK settlements alone advance opaque work and preserve final output with logging=%s', loggingEnabled => fixture(async f => {
    await planned(f);
    const first = accepted(f)[0];
    const initial = structuredClone(plans(f)[0].initialData);
    const original = await f.activity.getRuntimePlan();
    await f.activity.reconcileDispatcherLease();
    expect(accepted(f)).toEqual([first]);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    f.normalTransport!.settleSubmission(first.receipt.submissionId, 'completed',
      [{ name: 'opaque-document-result', data: { synchronized: 'invoice-1' } }]);
    await f.activity.reconcileDispatcherLease();
    expect(accepted(f)).toHaveLength(2);
    const continuation = plans(f).at(-1)!;
    expect(continuation).toMatchObject({ checkpoint: firstCheckpoint, initialData: initial,
      settlement: { receipt: first.receipt, reply: { uid: first.receipt.uid, submissionId: first.receipt.submissionId } } });
    expect(JSON.parse(accepted(f)[1].wire)).toMatchObject({ message: secondInput });
    expect((await f.activity.getRuntimePlan())!.deadline).toBe(original!.deadline);
    expect((await f.activity.getRuntimePlan())!.invocationJson).toBe(original!.invocationJson);
    f.activity = f.restart(); await f.drainBackground();
    await f.activity.reconcileDispatcherLease();
    expect(accepted(f)).toHaveLength(2);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect(plans(f).at(-1)).toEqual(continuation);
    f.normalTransport!.settleSubmission(accepted(f)[1].receipt.submissionId, 'completed',
      [{ name: 'opaque-document-result', data: { confirmed: true } }]);
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true,
      detail: { executionStatus: 'completed', result: finalOutput } });
    const all = accepted(f);
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ result: finalOutput });
    expect(accepted(f)).toEqual(all);
    expect(plans(f).every(plan => JSON.stringify(plan.initialData) === JSON.stringify(initial))).toBe(true);
  }, { ...workflowOptions, loggingEnabled }));

  it('cancellation while the original SDK acknowledgement is outstanding cannot reopen work on late acceptance', () => fixture(async f => {
    const delayed = f.normalTransport!.delayAcknowledgement();
    const starting = start(f);
    await delayed.entered;
    try { await f.activity.cancelDrive(); }
    finally { delayed.release(); }
    await starting;
    expect(plans(f)[0]).toMatchObject({ checkpoint: null, initialData: { input: f.input, configuration } });
    const original = accepted(f);
    expect(original).toHaveLength(1);
    f.normalTransport!.settle('completed', [{ name: 'opaque-document-result', data: { tooLate: true } }]);
    f.activity = f.restart(); await f.drainBackground();
    await f.activity.reconcileDispatcherLease();
    expect(accepted(f)).toEqual(original);
    expect(plans(f).every(plan => plan.checkpoint === null)).toBe(true);
    expect((await f.activity.getBrowserDetail())!.result).toBeNull();
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, workflowOptions));

  it('uncertain admission replays exactly the saved key/input/configuration after cold reconstruction', () => fixture(async f => {
    f.normalTransport!.loseAcknowledgement();
    await start(f);
    expect(plans(f)[0]).toMatchObject({ checkpoint: null, initialData: { configuration } });
    const original = accepted(f);
    expect(original).toHaveLength(1);
    const originalPlan = await f.activity.getRuntimePlan();
    f.activity = f.restart(); await f.drainBackground();
    await f.activity.reconcileDispatcherLease();
    expect(accepted(f)).toEqual(original);
    const wire = JSON.parse(original[0].wire);
    expect(wire).toMatchObject({ idempotencyKey: expect.any(String), message: firstInput,
      initialData: { input: f.input, configuration } });
    const retries = f.normalTransport!.requests.filter(request => request.path === '/control/dispatch');
    expect(retries.every(request => JSON.stringify(request.body) === original[0].wire)).toBe(true);
    expect(await f.activity.getRuntimePlan()).toEqual(originalPlan);
    expect(plans(f).every(plan => plan.checkpoint === null)).toBe(true);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, workflowOptions));

  it('confirmed failure can continue to later work and a truthful final result without changing authority', () => fixture(async f => {
    await planned(f);
    const original = await f.activity.getRuntimePlan();
    const first = accepted(f)[0];
    const data = { 'partial-work': [{ completed: false, evidence: 'original' }] };
    f.normalTransport!.settleSubmission(first.receipt.submissionId, 'failed',
      [{ name: 'partial-work', data: data['partial-work'][0] }]);
    await f.activity.reconcileDispatcherLease();
    expect(plans(f)[1]).toMatchObject({ checkpoint: firstCheckpoint,
      settlement: { status: 'failed', receipt: first.receipt, data } });
    expect(accepted(f)).toHaveLength(2);
    expect(JSON.parse(accepted(f)[1].wire).message).toEqual(secondInput);
    expect((await f.activity.getRuntimePlan())!.deadline).toBe(original!.deadline);
    f.activity = f.restart(); await f.drainBackground();
    expect(accepted(f)).toHaveLength(2);
    f.normalTransport!.settleSubmission(accepted(f)[1].receipt.submissionId, 'completed');
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true,
      detail: { result: { failed: ['first-work'], completed: ['second-work'] } } });
  }, { ...workflowOptions, applicationPlan: body => {
    if (body.checkpoint === null || JSON.stringify(body.checkpoint) === JSON.stringify(firstCheckpoint)) return dispatchDecision(body);
    return { kind: 'complete', checkpoint: { done: true }, result: { failed: ['first-work'], completed: ['second-work'] } };
  } }));

  it('a confirmed failure cannot waive an unresolved effect in the runtime journal', () => fixture(async f => {
    await planned(f);
    const original = accepted(f);
    await f.mutateEvidence(async storage => {
      await storage.put('dispatcher:operation:1:uncertain-effect', { generation: 1, ordinal: 0, phase: 'unknown',
        requestDigest: 'a'.repeat(64), request: { method: 'POST', url: 'https://api.github.com/repos/owner/repo/issues/1/comments' } });
      await storage.put('dispatcher:journal', { generation: 1, count: 1, nextOrdinal: 1, unresolved: 1 });
    });
    f.normalTransport!.settleSubmission(original[0].receipt.submissionId, 'failed');
    await f.activity.reconcileDispatcherLease();
    expect(accepted(f)).toEqual(original);
    expect((await f.activity.getBrowserDetail())!.result).toBeNull();
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, workflowOptions));

  it.each(['pending', 'unavailable', 'failed-without-evidence', 'aborted', 'foreign-receipt-uid', 'foreign-receipt-submission',
    'foreign-reply-uid', 'foreign-reply-submission', 'cancelled', 'expired', 'release', 'configuration'] as const)(
    '%s cannot release the next application decision or collect a final result', fault => fixture(async f => {
      await planned(f);
      const original = accepted(f);
      if (fault === 'unavailable') f.normalTransport!.failNextRead(503);
      else if (fault === 'failed-without-evidence') {
        f.normalTransport!.settle('failed'); f.normalTransport!.changeReply({ data: undefined });
      } else if (fault === 'aborted') f.normalTransport!.settle(fault);
      else if (fault !== 'pending') f.normalTransport!.settle('completed', [{ name: 'opaque-document-result', data: { success: true } }]);
      if (fault === 'foreign-receipt-uid') f.normalTransport!.changeReceipt({ uid: 'foreign' });
      if (fault === 'foreign-receipt-submission') f.normalTransport!.changeReceipt({ submissionId: 'foreign' });
      if (fault === 'foreign-reply-uid') f.normalTransport!.changeReply({ uid: 'foreign' });
      if (fault === 'foreign-reply-submission') f.normalTransport!.changeReply({ submissionId: 'foreign' });
      if (fault === 'cancelled') await f.activity.cancelDrive();
      if (fault === 'expired') f.expire();
      if (fault === 'release') f.changeConnection({ releaseId: 'replacement' });
      if (fault === 'configuration') f.changeInferenceAuthority('installation');
      f.activity = f.restart(); await f.drainBackground();
      await f.activity.reconcileDispatcherLease();
      expect(accepted(f)).toEqual(original);
      expect(plans(f).every(plan => plan.checkpoint === null)).toBe(true);
      expect((await f.activity.getBrowserDetail())!.result).toBeNull();
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    }, workflowOptions));

  it('logging sink failure cannot change the application decision, immutable input or opaque result', () => fixture(async f => {
    const loggers = (['log', 'warn', 'error'] as const).map(method => vi.spyOn(console, method)
      .mockImplementation(() => { throw Error('Optional test logging sink unavailable'); }));
    try {
      await planned(f);
      f.normalTransport!.settleSubmission(accepted(f)[0].receipt.submissionId, 'completed');
      await f.activity.reconcileDispatcherLease();
      f.normalTransport!.settleSubmission(accepted(f)[1].receipt.submissionId, 'completed');
      await f.activity.reconcileDispatcherLease();
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result: finalOutput } });
      expect(accepted(f)).toHaveLength(2);
    } finally { loggers.forEach(logger => logger.mockRestore()); }
  }, workflowOptions));
});

// Real callback -> Registry -> original Activity, with independently decrypted
// private reads. No old SDK observation or runtime drive is needed for this read.
describe('historical execution callback capture policy', () => {
  it.each([
    [true, true], [true, false], [false, true], [false, false], ['unproven', true],
  ] as const)('original=%s current=%s does not copy historical responses into the current archive',
    (originalLogging, currentLogging) => withRegistry(async r => {
      const result = { token: 'SYNTHETIC_ORIGINAL_RESULT_秘密🧪', body: '尾'.repeat(6000) };
      await fixture(async original => {
        r.attach(original); await start(original);
        original.normalTransport!.settle('completed');
        await original.activity.reconcileDispatcherLease();
        expect(await original.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result } });
        await original.drainBackground();
        if (originalLogging === 'unproven') {
          await original.mutateEvidence(async storage => {
            const state = await storage.get<Record<string, any>>('admission');
            state!.receipt.selection.operator.policy.loggingEnabled = 'invalid';
            await storage.put('admission', state);
            await r.enter(async native => {
              native.storage.sql.exec('UPDATE operator_admissions SET data=? WHERE activity_id=?',
                JSON.stringify(state!.receipt), original.activityId);
            });
          });
        }
        const privateState = 'SYNTHETIC_ORIGINAL_PRIVATE_STATE';
        let before = new Map<string, unknown>();
        await original.mutateEvidence(async storage => {
          const state = await storage.get<Record<string, unknown>>('admission');
          await storage.put('admission', { ...state, privateEvidence: { token: privateState } });
          before = new Map([...await storage.list()].filter(([key]) => !key.startsWith('operator-raw')));
        });
        const oldRequests = [...original.normalTransport!.requests];
        await fixture(async current => {
          r.attach(current); await start(current);
          // Preserve real owner identity and native DO context across the RPC seam.
          current.environment.OPERATOR_ACTIVITY = {
            idFromName: () => { throw Error('Registry must not select a native identity'); },
            getByName: (id: string) => {
              if (id === current.activityId) return current.activity;
              if (id !== original.activityId) throw Error('Unexpected historical target');
              return { readApplicationExecutionFacts: (authority: Parameters<typeof original.activity.readApplicationExecutionFacts>[0]) =>
                original.inOwnContext(() => original.activity.readApplicationExecutionFacts(authority)) };
            },
          } as never;
          r.attach(current);
          const version = await create(current, 'original', { activityId: original.activityId });
          const delivery = plans(current).at(-1)!.delivery as { token: string };
          const response = await current.inOwnContext(() => current.installationCapability.fetch(normalCallback(current.activityId,
            'execution', { operation: 'read', key: 'original', activityId: original.activityId, version },
            { 'x-codeflare-dispatcher-delivery': delivery.token })));
          expect(response.status).toBe(200);
          expect(response.headers.get('cache-control')).toBe('no-store');
          const text = await response.text();
          expect(JSON.parse(text)).toMatchObject({ status: 'value', activityId: original.activityId, terminal: { result } });
          expect(text).not.toContain(privateState);
          await current.drainBackground();
          const readRecords = async (f: DispatcherFixture) => {
            const records: Array<{ stage: string; value: unknown }> = [];
            await f.inOwnContext(() => f.mutateEvidence(async native => {
              const storage = await createOwnerRawCaptureStorage(f.environment, native, async () => {});
              const scope = { ownerKey: f.proof.ownerKey,
                scope: { kind: 'activity' as const, activityId: f.activityId, generation: 1 } };
              let cursor: string | undefined;
              do {
                const page = await discoverRawCaptures({ scope, storage, cursor, authorize: async () => {} });
                expect(page.status).toBe('complete');
                for (const binding of page.bindings) {
                  const archive = await readRawCapture({ binding, storage });
                  expect(archive.status).toBe('complete'); records.push(...archive.records);
                }
                cursor = page.cursor ?? undefined;
              } while (cursor);
            }));
            return records;
          };
          const historical = (await readRecords(original)).filter(record => record.stage.startsWith('application-execution-'));
          if (originalLogging === true && currentLogging) {
            expect(JSON.stringify(historical)).toContain(result.token);
            expect(JSON.stringify(historical)).toContain(privateState);
          } else expect(historical).toEqual([]);
          expect(JSON.stringify(await readRecords(current))).not.toContain(result.token);
          await original.inOwnContext(() => original.mutateEvidence(async storage => {
            expect(new Map([...await storage.list()].filter(([key]) => !key.startsWith('operator-raw')))).toEqual(before);
          }));
          expect(original.normalTransport!.requests).toEqual(oldRequests);
        }, { ...normal, registryAdapter: r.adapter, preserveGlobalMocks: true, loggingEnabled: currentLogging });
      }, { ...normal, registryAdapter: r.adapter, loggingEnabled: originalLogging !== false,
        applicationPlan: body => body.checkpoint === null
          ? { kind: 'dispatch', checkpoint: { active: true }, context: {}, message: firstInput }
          : { kind: 'complete', checkpoint: { done: true }, result } });
    }));
});
