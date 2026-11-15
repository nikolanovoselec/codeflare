/** Timer/Registry component proof, not a deployed SDK or real identity-provider acceptance test.
 * Real prepare/start/run orchestration and sealed contexts; storage and Activity RPC transport are fixtures.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { activateApplicationSchedule, applicationScheduleStatus, runApplicationSchedules,
  type ApplicationScheduleContext } from '../../operators/application-schedule';
import { operatorOwnerKey } from '../../operators/browser-activity';
import { openOperatorExecutionAccess, type OperatorExecutionAuthority,
  type OperatorExecutionContext } from '../../operators/execution-context';
import { bindOperatorRuntimeCapability, prepareOperatorActivity, runOperatorActivity } from '../../operators/orchestrator';
import type { ManagementExecutionSelection, OperatorRegistryResult } from '../../operators/registry';
import { normalDispatcherBundle } from './fixtures/normal-dispatcher';
import { createOwnerRawCaptureStorage, discoverRawCaptures, readRawCapture } from '../../operators/raw-capture-storage';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const epoch = Date.UTC(2026, 9, 1);
const authority = (email = 'owner@example.test', accessJwt = 'original-assertion'): OperatorExecutionAuthority => ({
  human: { subject: email, email, issuer: 'https://tenant.cloudflareaccess.com', audiences: ['operators'],
    groups: ['verified-invokers'], issuedAt: epoch / 1000 - 10, expiresAt: epoch / 1000 + 3600 },
  accessJwt, delegation: { version: 1, routingGroups: ['verified-route-label'] },
});
interface RecordView {
  scheduleId: string; installationId: string; ownerKey: string; activatedAt: string;
  nextDue?: number; intervalSeconds: number; revision: number; context: OperatorExecutionContext;
}

/** Serial, rollback-capable storage transport; no background timer fires in this unit fixture. */
class Storage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  beforeTransaction?: () => void;
  private queue: Promise<unknown> = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
  async delete(key: string) { return this.values.delete(key); }
  async list<T>(options: { prefix: string; limit?: number }) {
    return new Map<string, T>([...this.values].filter(([key]) => key.startsWith(options.prefix))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, options.limit)
      .map(([key, value]) => [key, structuredClone(value) as T] as const));
  }
  async getAlarm() { return this.alarm; }
  async setAlarm(at: number) { this.alarm = at; }
  async deleteAlarm() { this.alarm = null; }
  transaction<T>(work: (tx: Storage) => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const values = structuredClone(this.values), alarm = this.alarm;
      try { this.beforeTransaction?.(); return await work(this); }
      catch (error) { this.values = values; this.alarm = alarm; throw error; }
    });
    this.queue = task.catch(() => {});
    return task;
  }
  records() {
    return new Map<string, RecordView>([...this.values].filter(([key]) => key.startsWith('operator-schedule:')
      || key.startsWith('operator-schedule-history:')).map(([key, value]) => [key, structuredClone(value) as RecordView]));
  }
}
interface ActivityView {
  phase: 'empty' | 'prepared' | 'queued' | 'running' | 'unknown';
  context?: OperatorExecutionContext;
  selection?: ManagementExecutionSelection;
  invocation?: unknown;
  intent?: { activityId: string; deadline: number; startVerifier: string };
  startCapability?: string;
}

function fixture() {
  const storage = new Storage();
  const bundle = normalDispatcherBundle();
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  const selection = {
    controlsRevision: 3,
    installation: { id: 'installation', operatorId: 'application', name: 'Independent application',
      revision: 7, enabled: true, releaseId: 'release', approvedSourceRevision: 2,
      configurationJson: '{}', policy: { capabilities: [], resourceProfileId: null } },
    operator: { id: 'application', operatorId: 'application', profile: 'dispatcher', realm: 'external', revision: 4,
      repositoryId: 23, repositoryUrl: 'https://github.com/example/application', enabled: true,
      invokers: { users: [], groups: [{ issuer: 'https://tenant.cloudflareaccess.com', id: 'verified-invokers' }] },
      managers: { users: [], groups: [] }, policy: { capabilities: [], resourceProfileId: null, loggingEnabled: false },
      source: { kind: 'github-release', repositoryId: 23, repositoryUrl: 'https://github.com/example/application',
        credentialConfigured: true, approvedWorkflow: { id: 1, ref: 'main' } } },
    release: { id: 'release', operatorId: 'application', approved: true, bundleDigest: hash(bundle),
      manifestDigest: 'b'.repeat(64), sourceRevision: 2, repositoryId: 23, sourceCommit: bundle.sourceCommit },
    manifestJson: JSON.stringify({ schemaVersion: 1, interfaceVersion: 1, id: 'application',
      name: 'Independent application', description: '', coreVersion: '1', intentVersion: '1', profile: 'dispatcher',
      inputSchema: {}, requiredCapabilities: [],
      artifact: { path: '/bundle.json', sha256: hash(bundle), url: 'https://publisher.example.test/bundle.json' },
      application: { controlVersion: 1,
      configurationSchema: { type: 'object', properties: { jobs: { type: 'object', properties: {
        automatic: { type: 'boolean', default: true }, interval: { type: 'integer', default: 60 },
      } } } }, schedule: { enabledPath: '/jobs/automatic', intervalSecondsPath: '/jobs/interval' } } }),
  } as ManagementExecutionSelection;
  const roles = new Map([['owner@example.test', 'admin'], ['other@example.test', 'admin']]);
  let unavailable = false;
  let afterRoleRead: (() => void) | undefined;
  let afterPrepare: (() => void) | undefined;
  let afterStart: (() => void) | undefined;
  let loseStartAcknowledgement = false;
  const activities = new Map<string, ActivityView>();
  const deliveries = new Map<string, { invocation: unknown; authority: OperatorExecutionAuthority }>();
  const pending: Promise<unknown>[] = [];
  const resolve = async (): Promise<OperatorRegistryResult<ManagementExecutionSelection>> => ({ ok: true, value: structuredClone(selection) });
  const env: Env = { ENCRYPTION_KEY: btoa('s'.repeat(32)), LOADER: {},
    KV: { get: async (key: string) => {
      if (unavailable) throw new Error('KV transport unavailable');
      const role = roles.get(key.slice('user:'.length));
      afterRoleRead?.();
      return role ? JSON.stringify({ role }) : null;
    } },
    OPERATOR_REGISTRY: { getByName: () => ({ resolveManagementExecution: resolve, getManagementBundle: async () => bytes }) },
    OPERATOR_ACTIVITY: { getByName: (activityId: string) => {
      const view = () => {
        if (!activities.has(activityId)) activities.set(activityId, { phase: 'empty' });
        return activities.get(activityId)!;
      };
      return {
        prepareAuthorized: async (intent: NonNullable<ActivityView['intent']>, context: OperatorExecutionContext, invocation: string) => {
          const activity = view();
          if (activity.phase !== 'empty') return { ok: false, reason: 'activity-conflict' };
          Object.assign(activity, { phase: 'prepared', intent, context, selection: structuredClone(selection),
            invocation: JSON.parse(invocation) });
          afterPrepare?.();
          return { ok: true, phase: 'prepared' };
        },
        start: async (capability: string) => {
          const activity = view();
          const verifier = createHash('sha256').update(capability).digest('hex');
          if (activity.phase !== 'prepared' || verifier !== activity.intent?.startVerifier) return { ok: false };
          activity.phase = 'queued'; activity.startCapability = capability;
          afterStart?.();
          if (loseStartAcknowledgement) {
            loseStartAcknowledgement = false;
            throw new Error('Lost queued acknowledgement');
          }
          return { ok: true, phase: 'queued' };
        },
        getRuntimePlan: async () => {
          const activity = view();
          return activity.phase === 'queued' ? { activityId, deadline: activity.intent!.deadline,
            invocationJson: JSON.stringify(activity.invocation), executionContext: activity.context,
            receipt: { selection: activity.selection } } : null;
        },
        beginDrive: async () => {
          const activity = view();
          if (activity.phase !== 'queued') return { ok: false, reason: 'activity-conflict' };
          activity.phase = 'running';
          return { ok: true, state: { generation: 1 } };
        },
        admitDispatcher: async (_generation: number, _bundle: unknown, _digest: string, invocation: unknown) => {
          const activity = view();
          deliveries.set(activityId, { invocation, authority: await openOperatorExecutionAccess(activity.context!, env) });
          return { ok: true, state: { generation: 1, status: 'running' } };
        },
        interruptDrive: async () => { view().phase = 'unknown'; return { ok: true }; },
        fenceRuntimeFailure: async () => {
          const activity = view();
          if (activity.phase !== 'running') activity.phase = 'unknown';
          return { ok: true };
        },
      };
    } },
  } as unknown as Env;
  const runtimeContext = { exports: { OperatorRuntimeCapability: () => ({ fetch: async () => new Response() }) } };
  const context: ApplicationScheduleContext = { env, storage: storage as unknown as DurableObjectStorage,
    resolve, runtimeContext, waitUntil: work => { pending.push(work); } };
  return { context, storage, selection, roles, activities, deliveries,
    setUnavailable: (value: boolean) => { unavailable = value; },
    onRoleRead: (hook: () => void) => { afterRoleRead = hook; },
    onPrepare: (hook: () => void) => { afterPrepare = hook; },
    onStart: (hook: () => void) => { afterStart = hook; },
    loseStart: () => { loseStartAcknowledgement = true; },
    activate: (value = authority()) => activateApplicationSchedule(context,
      { installationId: 'installation', revision: selection.installation.revision, authority: value }),
    flush: async () => { while (pending.length) await Promise.all(pending.splice(0)); },
    status: async (value = authority()) => applicationScheduleStatus(context, 'installation', await operatorOwnerKey(value.human)),
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(epoch); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('application timer delivery: explicit original-lifetime consent and normal execution', () => {
  it('replacing the same owner consent does not exhaust the active limit or resurrect an old acknowledgement', async () => {
    const f = fixture();
    for (let index = 0; index < 35; index++) {
      expect(await f.activate(authority('owner@example.test', `assertion-${index}`))).toMatchObject({ ok: true });
    }
    expect(await f.activate(authority('owner@example.test', 'assertion-0'))).toMatchObject({ ok: true });
    expect(await f.status()).toBe('active');
    vi.advanceTimersByTime(1001);
    await runApplicationSchedules(f.context);
    await f.flush();
    expect([...f.deliveries.values()]).toMatchObject([{ invocation: {}, authority: { accessJwt: 'assertion-34' } }]);
  });

  it('configured defaults alone never arm a timer; OFF still permits the same manual prepare/start/run', async () => {
    const f = fixture();
    await runApplicationSchedules(f.context);
    expect(await f.status()).toBe('inactive');
    expect(await f.storage.records()).toEqual(new Map());
    expect(f.storage.alarm).toBeNull();
    f.selection.installation.configurationJson = JSON.stringify({ jobs: { automatic: false } });
    expect(await f.activate()).toMatchObject({ ok: false });
    const { delegation: _delegation, ...manualAuthority } = authority();
    const prepared = await prepareOperatorActivity({ installationId: 'installation', invocation: {} }, manualAuthority, f.context.env);
    await f.context.env.OPERATOR_ACTIVITY!.getByName(prepared.activityId).start(prepared.startCapability);
    await runOperatorActivity(prepared.activityId, f.context.env, bindOperatorRuntimeCapability(f.context.runtimeContext));
    expect([...f.deliveries.values()]).toEqual([{ invocation: {}, authority: manualAuthority }]);
    expect(f.storage.alarm).toBeNull();
  });

  it('delivers an empty generic invocation through real orchestration with sealed original authority and declared interval', async () => {
    const f = fixture();
    expect(await f.activate()).toEqual({ ok: true, activatedAt: new Date(epoch).toISOString() });
    const original = [...(await f.storage.records()).values()][0];
    expect(original.intervalSeconds).toBe(60);
    expect(await f.status()).toBe('active');
    expect(JSON.stringify(original)).not.toContain('original-assertion');
    expect(await openOperatorExecutionAccess(original.context, f.context.env)).toEqual(authority());
    vi.setSystemTime(original.nextDue!);
    let dueAtPreparation: number | undefined;
    f.onPrepare(() => { dueAtPreparation = [...f.storage.values.values()].map(value => value as RecordView)[0].nextDue; });
    await runApplicationSchedules(f.context);
    await f.flush();
    const activityId = `timer-${hash([original.scheduleId, original.nextDue])}`;
    expect([...f.deliveries]).toEqual([[activityId, { invocation: {}, authority: authority() }]]);
    expect(f.activities.get(activityId)?.context).toMatchObject({ activityId,
      operatorId: 'application', artifactDigest: f.selection.release.bundleDigest,
      expiresAt: authority().human.expiresAt });
    expect(dueAtPreparation).toBe(original.nextDue! + 60_000);
    expect(f.storage.alarm).toBe(original.nextDue! + 60_000);
    await runApplicationSchedules(f.context);
    expect([...f.deliveries.keys()]).toEqual([activityId]);
  });

  it('duplicate consent and reconstruction retain the original activation, next due, ciphertext and deadline', async () => {
    const f = fixture();
    const activated = await f.activate();
    const original = await f.storage.records();
    vi.setSystemTime(epoch + 500);
    expect(await activateApplicationSchedule({ ...f.context }, { installationId: 'installation', revision: 7,
      authority: authority() })).toEqual(activated);
    expect(await f.storage.records()).toEqual(original);
    vi.setSystemTime(epoch + 1000);
    await Promise.all([runApplicationSchedules(f.context), runApplicationSchedules({ ...f.context })]);
    await f.flush();
    expect(f.deliveries.size).toBe(1);
    const advanced = await f.storage.records();
    expect(await f.activate()).toEqual(activated);
    expect(await f.storage.records()).toEqual(advanced);
  });

  it('new consent retires only the same owner schedule, preserves history and never cancels admitted work', async () => {
    const f = fixture();
    await f.activate();
    const original = [...(await f.storage.records()).values()][0];
    vi.setSystemTime(original.nextDue!);
    await runApplicationSchedules(f.context); await f.flush();
    const activityId = [...f.deliveries.keys()][0];
    await f.activate(authority('other@example.test', 'other-assertion'));
    await f.activate(authority('owner@example.test', 'new-explicit-assertion'));
    const records = await f.storage.records();
    expect(records.size).toBe(3);
    expect([...records.values()].find(record => record.scheduleId === original.scheduleId)?.nextDue).toBeUndefined();
    expect([...records.values()].filter(record => record.nextDue !== undefined)).toHaveLength(2);
    expect(f.activities.get(activityId)?.phase).toBe('running');
    const before = await f.storage.records();
    await f.activate(); // Old lost acknowledgement cannot retire the newer consent or resurrect the old one.
    expect(await f.storage.records()).toEqual(before);
  });

  it.each(['missing delegation', 'missing verified groups', 'non-admin', 'no invocation grant', 'expired',
    'stale revision', 'disabled', 'unapproved', 'unsupported descriptor', 'disabled default', 'invalid interval'])
  ('refuses activation with %s and leaves no schedule or alarm', async failure => {
    const f = fixture(), value = authority();
    let revision = 7;
    if (failure === 'missing delegation') delete value.delegation;
    if (failure === 'missing verified groups') delete value.human.groups;
    if (failure === 'non-admin') f.roles.set(value.human.email, 'user');
    if (failure === 'no invocation grant') f.selection.operator.invokers.groups = [];
    if (failure === 'expired') value.human.expiresAt = epoch / 1000;
    if (failure === 'stale revision') revision--;
    if (failure === 'disabled') f.selection.installation.enabled = false;
    if (failure === 'unapproved') f.selection.release.approved = false;
    if (failure === 'unsupported descriptor') f.selection.manifestJson = '{"application":{"controlVersion":2}}';
    if (failure === 'disabled default') f.selection.installation.configurationJson = '{"jobs":{"automatic":false}}';
    if (failure === 'invalid interval') f.selection.installation.configurationJson = '{"jobs":{"interval":0}}';
    expect(await activateApplicationSchedule(f.context, { installationId: 'installation', revision, authority: value }))
      .toMatchObject({ ok: false });
    expect(await f.storage.records()).toEqual(new Map());
    expect(f.storage.alarm).toBeNull();
    expect(f.deliveries.size).toBe(0);
  });

  it('rechecks the current administrator and never treats routing labels as invoker groups', async () => {
    const f = fixture();
    f.onRoleRead(() => { f.roles.set('owner@example.test', 'user'); });
    expect(await f.activate()).toMatchObject({ ok: false });
    expect(await f.storage.records()).toEqual(new Map());
    const other = fixture(), value = authority();
    value.human.groups = [];
    value.delegation!.routingGroups = ['verified-invokers'];
    expect(await other.activate(value)).toMatchObject({ ok: false });
    expect(await other.storage.records()).toEqual(new Map());
  });

  it('rechecks local pins immediately before atomic activation', async () => {
    const f = fixture();
    f.storage.beforeTransaction = () => { f.selection.installation.revision++; };
    expect(await f.activate()).toEqual({ ok: false, reason: 'stale-selection' });
    expect(await f.storage.records()).toEqual(new Map());
    expect(f.storage.alarm).toBeNull();
  });

  it.each(['admin revoked', 'invoker revoked', 'controls changed', 'installation changed', 'operator changed',
    'release changed', 'source changed', 'configuration changed', 'disabled', 'owner changed', 'ciphertext changed'])
  ('retires %s without new work or discarding consent history', async change => {
    const f = fixture();
    await f.activate();
    const [storageKey, original] = [...await f.storage.records()][0];
    if (change === 'admin revoked') f.roles.set('owner@example.test', 'user');
    if (change === 'invoker revoked') f.selection.operator.invokers.groups = [];
    if (change === 'controls changed') f.selection.controlsRevision++;
    if (change === 'installation changed') f.selection.installation.revision++;
    if (change === 'operator changed') f.selection.operator.revision++;
    if (change === 'release changed') f.selection.release.bundleDigest = 'f'.repeat(64);
    if (change === 'source changed') f.selection.operator.source.repositoryId++;
    if (change === 'configuration changed') f.selection.installation.configurationJson = '{"jobs":{"interval":120}}';
    if (change === 'disabled') f.selection.installation.enabled = false;
    if (change === 'owner changed' || change === 'ciphertext changed') {
      const altered = structuredClone(original);
      if (change === 'owner changed') altered.ownerKey = 'foreign-owner';
      else altered.context.protectedAccessCiphertext = 'corrupt';
      await f.storage.put(storageKey, altered);
    }
    vi.setSystemTime(original.nextDue!);
    await runApplicationSchedules(f.context); await f.flush();
    expect(f.deliveries.size).toBe(0);
    const history = await f.storage.records();
    expect(history.size).toBe(1);
    expect([...history.values()][0].nextDue).toBeUndefined();
    expect(f.storage.alarm).toBeNull();
  });

  it.each(['prepare', 'start'])('rechecks authority after %s and never delivers revoked work', async boundary => {
    const f = fixture();
    await f.activate();
    const revoke = () => { f.roles.set('owner@example.test', 'user'); };
    if (boundary === 'prepare') f.onPrepare(revoke); else f.onStart(revoke);
    vi.setSystemTime(epoch + 1000);
    await runApplicationSchedules(f.context); await f.flush();
    expect(f.deliveries.size).toBe(0);
    expect([...f.activities.values()].map(activity => activity.phase)).toEqual(['unknown']);
    expect([...await f.storage.records()].map(([, record]) => record.nextDue)).toEqual([undefined]);
    expect(f.storage.alarm).toBeNull();
  });

  it('never refreshes original authority through live SSO and stops at the original deadline', async () => {
    const f = fixture(), value = authority();
    value.human.expiresAt = epoch / 1000 + 2;
    vi.stubGlobal('fetch', () => { throw new Error('No live SSO or application discovery is permitted'); });
    await f.activate(value);
    vi.setSystemTime(epoch + 1000);
    await runApplicationSchedules(f.context); await f.flush();
    expect([...f.deliveries.values()][0].authority).toEqual(value);
    expect(f.storage.alarm).toBe(epoch + 2000);
    vi.setSystemTime(epoch + 2000);
    await runApplicationSchedules(f.context); await f.flush();
    expect(f.deliveries.size).toBe(1);
    expect(await f.status(value)).toBe('expired');
    expect(f.storage.alarm).toBeNull();
  });

  it('expiry during handoff cannot start a run or leave a future timer', async () => {
    const f = fixture(), value = authority();
    value.human.expiresAt = epoch / 1000 + 2;
    await f.activate(value);
    vi.setSystemTime(epoch + 1000);
    f.onPrepare(() => { vi.setSystemTime(epoch + 2000); });
    await runApplicationSchedules(f.context); await f.flush();
    expect(f.deliveries.size).toBe(0);
    expect(f.storage.alarm).toBeNull();
    expect(await f.status(value)).toBe('expired');
  });

  it('dependency unavailability consumes only the due tick and reports unconfirmed without inventing a retry', async () => {
    const f = fixture();
    await f.activate();
    vi.setSystemTime(epoch + 1000); f.setUnavailable(true);
    await runApplicationSchedules(f.context);
    expect(await f.status()).toBe('unconfirmed');
    expect(f.deliveries.size).toBe(0);
    expect(f.storage.alarm).toBe(epoch + 61_000);
    f.setUnavailable(false);
    await runApplicationSchedules(f.context); await f.flush();
    expect(f.deliveries.size).toBe(0);
    vi.setSystemTime(epoch + 61_000);
    await runApplicationSchedules(f.context); await f.flush();
    expect(f.deliveries.size).toBe(1);
  });

  it('a lost start acknowledgement is never retried, while a later interval gets its own stable identity', async () => {
    const f = fixture();
    await f.activate(); f.loseStart();
    vi.setSystemTime(epoch + 1000);
    await runApplicationSchedules(f.context); await f.flush();
    const lost = [...f.activities.keys()];
    expect(lost).toHaveLength(1);
    expect(f.deliveries.size).toBe(0);
    await runApplicationSchedules({ ...f.context }); await f.flush();
    expect([...f.activities.keys()]).toEqual(lost);
    vi.setSystemTime(epoch + 61_000);
    await runApplicationSchedules(f.context); await f.flush();
    expect(f.activities.size).toBe(2);
    expect([...f.deliveries.keys()]).toEqual([...f.activities.keys()].filter(id => !lost.includes(id)));
  });

  it.each([false, true])('keeps the original handoff failure and secondary fence evidence paired, fence failure=%s', async fenceFailure => {
    const f = fixture();
    f.selection.operator.policy.loggingEnabled = true;
    await f.activate();
    const record = [...(await f.storage.records()).values()][0];
    f.onPrepare(() => { throw new Error('SYNTHETIC_ORIGINAL_HANDOFF_FAILURE'); });
    if (fenceFailure) {
      const namespace = f.context.env.OPERATOR_ACTIVITY!;
      const get = namespace.getByName.bind(namespace);
      vi.spyOn(namespace, 'getByName').mockImplementation(id => new Proxy(get(id), { get(target, property) {
        if (property === 'fenceRuntimeFailure') return async () => { throw new Error('SYNTHETIC_SECONDARY_FENCE_FAILURE'); };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } }));
    }
    vi.setSystemTime(epoch + 1000);
    await runApplicationSchedules(f.context); await f.flush();
    expect(f.deliveries.size).toBe(0);
    const activityId = [...f.activities.keys()][0];
    const storage = await createOwnerRawCaptureStorage(f.context.env, f.context.storage, async () => {});
    const page = await discoverRawCaptures({ storage, scope: { ownerKey: record.ownerKey,
      scope: { kind: 'observation', observationId: activityId } }, authorize: async () => {} });
    expect(page.status).toBe('complete');
    const observations: Array<{ stage: string; value: unknown }> = [];
    for (const binding of page.bindings) {
      expect(binding.installationId).toBe(record.installationId);
      const archive = await readRawCapture({ binding, storage });
      expect(archive.status).toBe('complete'); observations.push(...archive.records);
    }
    expect(observations).toContainEqual({ stage: 'application-schedule-prepare-error',
      value: expect.objectContaining({ message: 'SYNTHETIC_ORIGINAL_HANDOFF_FAILURE' }) });
    expect(observations).toContainEqual({ stage: 'application-schedule-fence-request',
      value: { activityId, boundary: 'admission', code: 'startup-failed', onlyBeforeDrive: true } });
    if (fenceFailure) expect(observations).toContainEqual({ stage: 'application-schedule-fence-error',
      value: expect.objectContaining({ message: 'SYNTHETIC_SECONDARY_FENCE_FAILURE' }) });
    else expect(observations).toContainEqual({ stage: 'application-schedule-fence-response', value: { ok: true } });
    const before = [...f.activities.keys()];
    await runApplicationSchedules(f.context); await f.flush();
    expect([...f.activities.keys()]).toEqual(before);
  });

  it('keeps the earliest surviving owner timer and distinguishes missing alarm from active consent', async () => {
    const f = fixture();
    await f.activate();
    const owner = [...(await f.storage.records()).values()][0];
    vi.setSystemTime(epoch + 500);
    await f.activate(authority('other@example.test'));
    expect(f.storage.alarm).toBe(owner.nextDue);
    await f.storage.deleteAlarm();
    expect(await f.status()).toBe('unconfirmed');
    expect(await f.status(authority('stranger@example.test'))).toBe('inactive');
    await f.activate();
    expect(f.storage.alarm).toBe(owner.nextDue);
    expect(await f.status()).toBe('active');
  });

  it('preserves the existing active-registration ceiling without deleting consent or rejecting its duplicate acknowledgement', async () => {
    const f = fixture();
    for (let i = 0; i < 32; i++) {
      const email = `owner-${i}@example.test`;
      f.roles.set(email, 'admin');
      expect(await f.activate(authority(email))).toMatchObject({ ok: true });
    }
    const history = await f.storage.records();
    expect(history.size).toBe(32);
    expect([...history.values()].filter(record => record.nextDue !== undefined)).toHaveLength(32);
    expect(await f.activate(authority('owner-0@example.test'))).toMatchObject({ ok: true });
    expect(await f.storage.records()).toEqual(history);
    f.roles.set('owner-32@example.test', 'admin');
    expect(await f.activate(authority('owner-32@example.test'))).toEqual({ ok: false, reason: 'registration-limit' });
    expect(await f.storage.records()).toEqual(history);
  });
});
