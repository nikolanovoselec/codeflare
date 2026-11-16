/// <reference types="@cloudflare/vitest-plugin/types" />
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorActivity } from '../../operators/activity';
import { OperatorRegistry, type DispatcherConnectionMetadata, type ManagementAdmissionReceipt } from '../../operators/registry';
import { fixture, start, digest, type DispatcherFixture, writableApplication } from './fixtures/dispatcher-production';
import { normalCallback } from './fixtures/normal-dispatcher';
import { within } from '../helpers/pending-recipient';
import { bindDurableObjectContext } from '../helpers/durable-object-context';

// The Task131 parent-only contracts. Casts let RED reach the missing behavior
// rather than failing TypeScript because the new RPCs do not exist yet.
interface DeploymentRetirement {
  retireDispatcherDeployment(activityId: string, connection: DispatcherConnectionMetadata): Promise<boolean>;
}
interface DeploymentAdmissions {
  listManagementDispatcherAdmissions(installationId: string, workerName: string, after?: string): Promise<{
    items: Array<{ activityId: string; connection: DispatcherConnectionMetadata }>; next: string | null;
  }>;
}
const retire = (activity: OperatorActivity, id: string, connection: DispatcherConnectionMetadata) =>
  (activity as unknown as DeploymentRetirement).retireDispatcherDeployment(id, connection);
const admissions = (registry: OperatorRegistry) => registry as unknown as DeploymentAdmissions;
type StoredAdmission = {
  intent: Parameters<OperatorActivity['prepareAuthorized']>[0];
  executionContext: Parameters<OperatorActivity['prepareAuthorized']>[1];
  invocationJson: string; phase: string; receipt: ManagementAdmissionReceipt | null;
  drive?: { generation: number; status: string; checkpoint: unknown; result: unknown };
  [key: string]: unknown;
};
const snapshot = async (f: DispatcherFixture) => {
  let saved!: StoredAdmission;
  await f.mutateEvidence(async storage => { saved = structuredClone((await storage.get<StoredAdmission>('admission'))!); });
  return saved;
};
async function resetToPrepared(f: DispatcherFixture, saved: StoredAdmission) {
  const { drive: _drive, ...withoutDrive } = saved;
  const startVerifier = await digest('s'.repeat(43));
  await f.mutateEvidence(storage => storage.put('admission', { ...withoutDrive, phase: 'prepared', receipt: null,
    intent: { ...saved.intent, startVerifier } }));
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Reuse the normal public HTTP transport fixture; it never loads/executes SDK
// bundles. The immutable ledger and its reads below are the actual Registry.
async function withRetirement(test: (f: DispatcherFixture & {
  registry: OperatorRegistry; inRegistry: <T>(action: (storage: DurableObjectStorage) => T | Promise<T>) => Promise<T>;
  receipt: ManagementAdmissionReceipt;
  connection: DispatcherConnectionMetadata; afterRecorded: (hook: () => Promise<void>) => void;
}) => Promise<void>, options: Parameters<typeof fixture>[1] = {}) {
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  const stub = namespace.get(namespace.newUniqueId());
  await runInDurableObject(stub, async (_instance, ctx) => {
    const instance = new OperatorRegistry(ctx, { ENCRYPTION_KEY: btoa('a'.repeat(32)) });
    await instance.getManagementAdmission('initialize-schema');
    const registry = bindDurableObjectContext(stub, () => instance);
    const inRegistry = <T>(action: (storage: DurableObjectStorage) => T | Promise<T>) =>
      runInDurableObject(stub, async () => action(ctx.storage));
    let receipt!: ManagementAdmissionReceipt;
    let connection!: DispatcherConnectionMetadata;
    let afterRecorded: (() => Promise<void>) | undefined;
    await fixture(async f => {
      await test({ ...f, registry, inRegistry, receipt, connection,
        afterRecorded: hook => { afterRecorded = hook; } });
    }, { ...writableApplication, ...options, registryAdapter: base => {
      const authority = base as {
        admitManagement: (input: unknown) => Promise<{ ok: true; value: ManagementAdmissionReceipt }>;
        getManagementDispatcherConnection: (id: string) => Promise<DispatcherConnectionMetadata & {
          connectionSecretCiphertext: string; controlOrigin: string }>;
      };
      return { ...base, getManagementAdmission: registry.getManagementAdmission.bind(registry),
        admitManagement: async (input: unknown) => {
          const result = await authority.admitManagement(input);
          const record = await authority.getManagementDispatcherConnection(result.value.installationId);
          const { connectionSecretCiphertext: _secret, controlOrigin: _origin, ...metadata } = record;
          connection = metadata;
          const stored = await registry.getManagementAdmission(result.value.activityId);
          receipt = stored ?? structuredClone({ ...result.value, selection: { ...result.value.selection,
            installation: { ...result.value.selection.installation, dispatcherConnection: metadata } } });
          if (!stored) await inRegistry(storage => {
            storage.sql.exec('INSERT INTO operator_admissions VALUES(?,?)', receipt.activityId, JSON.stringify(receipt));
          });
          const hook = afterRecorded; afterRecorded = undefined;
          await hook?.();
          return { ok: true, value: structuredClone(receipt) };
        },
      };
    } });
  });
}

const callback = (f: DispatcherFixture, path: string, body: unknown) => {
  const plan = f.normalTransport!.requests.filter(request => request.path === '/control/plan').at(-1)!;
  const token = (plan.body.delivery as { token: string }).token;
  return f.installationCapability.fetch(normalCallback(f.activityId, path, body, { 'x-codeflare-dispatcher-delivery': token }));
};

describe('REQ-OPERATOR-107: immutable original admission inventory', () => {
  it('REQ-OPERATOR-107: bounded pages include every original connection revision by Worker NAME and exclude other installations/Workers', () => withRetirement(async f => {
    const expected = new Map<string, DispatcherConnectionMetadata>();
    // Exceeds a normal bounded management page without assuming its exact size.
    await f.inRegistry(storage => {
      for (let index = 0; index < 241; index++) {
        const activityId = `original-${String(index).padStart(4, '0')}`;
        const connection = { ...f.connection, connectionRevision: index % 3 + 1,
          workerVersionId: index % 2 === 0 ? f.connection.workerVersionId : '22222222-2222-4222-8222-222222222222' };
        const receipt = { ...structuredClone(f.receipt), activityId,
          selection: { ...structuredClone(f.receipt.selection), installation: {
            ...structuredClone(f.receipt.selection.installation), dispatcherConnection: connection } } };
        storage.sql.exec('INSERT INTO operator_admissions VALUES(?,?)', activityId, JSON.stringify(receipt));
        expected.set(activityId, connection);
      }
      expected.set(f.activityId, f.connection);
      for (const [activityId, installationId, workerName] of [
        ['foreign-installation', 'other-installation', f.connection.workerName],
        ['foreign-worker', f.connection.installationId, 'another-worker'],
      ]) {
        const receipt = structuredClone(f.receipt);
        receipt.activityId = activityId;
        receipt.installationId = installationId;
        receipt.selection.installation.id = installationId;
        receipt.selection.installation.dispatcherConnection = { ...f.connection, installationId, workerName };
        storage.sql.exec('INSERT INTO operator_admissions VALUES(?,?)', activityId, JSON.stringify(receipt));
      }
    });
    const before = await f.inRegistry(storage => storage.sql.exec<{ data: string }>('SELECT data FROM operator_admissions ORDER BY activity_id').toArray());
    const found = new Map<string, DispatcherConnectionMetadata>();
    const cursors = new Set<string>();
    let after: string | undefined;
    do {
      const page = await admissions(f.registry).listManagementDispatcherAdmissions(f.connection.installationId, f.connection.workerName, after);
      expect(page.items.length).toBeGreaterThan(0);
      // The established Registry management page ceiling is100. This is an
      // output-size contract, not a query/helper invocation assertion.
      expect(page.items.length).toBeLessThanOrEqual(100);
      for (const item of page.items) {
        expect(found.has(item.activityId)).toBe(false);
        found.set(item.activityId, item.connection);
      }
      if (page.next !== null) {
        expect(cursors.has(page.next)).toBe(false); cursors.add(page.next);
      }
      after = page.next ?? undefined;
    } while (after !== undefined);
    expect(found).toEqual(expected);
    expect(await admissions(f.registry).listManagementDispatcherAdmissions('unrelated-installation', f.connection.workerName))
      .toEqual({ items: [], next: null });
    expect(await f.inRegistry(storage => storage.sql.exec<{ data: string }>('SELECT data FROM operator_admissions ORDER BY activity_id').toArray())).toEqual(before);
    expect(f.normalTransport!.admissions.size).toBe(0); // A ledger read must not dispatch SDK work.
  }));
});

describe('REQ-OPERATOR-107/017: private durable original-deployment fence', () => {
  it.each(['activity', 'installation', 'revision', 'worker', 'version', 'release', 'digest', 'manifest', 'source', 'compiler', 'missing-ledger', 'local-identity'] as const)(
    'REQ-OPERATOR-107: retirement rejects %s mismatch without taking away the original queued generation', variant => withRetirement(async f => {
      const connection = { ...f.connection };
      let activityId = f.activityId;
      if (variant === 'activity') activityId = 'foreign-activity';
      if (variant === 'installation') connection.installationId = 'foreign-installation';
      if (variant === 'revision') connection.connectionRevision++;
      if (variant === 'worker') connection.workerName = 'foreign-worker';
      if (variant === 'version') connection.workerVersionId = '22222222-2222-4222-8222-222222222222';
      if (variant === 'release') connection.releaseId = 'foreign-release';
      if (variant === 'digest') connection.bundleDigest = 'f'.repeat(64);
      if (variant === 'manifest') connection.manifestDigest = 'f'.repeat(64);
      if (variant === 'source') connection.sourceCommit = 'f'.repeat(40);
      if (variant === 'compiler') connection.compilerCommit = 'f'.repeat(40);
      if (variant === 'missing-ledger') await f.inRegistry(storage => {
        storage.sql.exec('DELETE FROM operator_admissions WHERE activity_id=?', f.activityId);
      });
      if (variant === 'local-identity') {
        // Registry proof for A cannot authorize mutation of a local Activity for B.
        await f.mutateEvidence(async storage => {
          const state = (await storage.get<StoredAdmission>('admission'))!;
          await storage.put('admission', { ...state, intent: { ...state.intent, activityId: 'another-local-activity' } });
        });
      }
      expect(await retire(f.activity, activityId, connection)).toBe(false);
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'queued', result: null });
      if (variant !== 'local-identity') {
        expect(await f.activity.beginDrive()).toMatchObject({ ok: true, state: { generation: 1, status: 'running' } });
        expect(await f.activity.operatorGenerationCurrent(1)).toBe(true);
      }
    }));

  it('REQ-OPERATOR-107/017: queued original is durably cancelled, keeps its receipt and cannot begin a generation after reconstruction', () => withRetirement(async f => {
    expect(await retire(f.activity, f.activityId, f.connection)).toBe(true);
    const cold = f.restart(); await f.drainBackground();
    expect(await retire(cold, f.activityId, f.connection)).toBe(true);
    expect(await cold.getBrowserDetail()).toMatchObject({ executionStatus: 'cancel-requested', result: null });
    expect((await cold.beginDrive()).ok).toBe(false);
    expect(await cold.operatorGenerationCurrent(1)).toBe(false);
    expect(await cold.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect(await f.registry.getManagementAdmission(f.activityId)).toEqual(f.receipt);
    expect(f.normalTransport!.admissions.size).toBe(0);
  }));

  it('REQ-OPERATOR-107/017: running original loses callback/commit authority before public abort202; abort intent is not settlement', () => withRetirement(async f => {
    await start(f);
    const original = structuredClone([...f.normalTransport!.admissions.values()]);
    const fetcher = globalThis.fetch;
    let abortReceipt: unknown;
    // The external abort recipient observes Root authority already revoked.
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/control/abort') {
        expect(await f.activity.operatorGenerationCurrent(1)).toBe(false);
        expect((await f.activity.commitDrive(1, { schemaVersion: 1, status: 'completed', checkpoint: null, result: { late: true } })).ok).toBe(false);
        abortReceipt = (await request.clone().json() as { receipt: unknown }).receipt;
      }
      return fetcher(request);
    };
    try { expect(await retire(f.activity, f.activityId, f.connection)).toBe(true); }
    finally { globalThis.fetch = fetcher; }
    expect(abortReceipt).toEqual(original[0]!.receipt);
    const denied = await callback(f, 'source', { operationId: 'late-old-deployment', url: 'https://api.github.com/repos/another/service' });
    expect(denied.status).toBe(403); expect(await denied.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
    const cold = f.restart(); await f.drainBackground();
    expect((await cold.beginDrive()).ok).toBe(false);
    expect(await cold.getBrowserDetail()).toMatchObject({ executionStatus: 'cancel-requested', result: null });
    expect(await cold.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect([...f.normalTransport!.admissions.values()]).toEqual(original);
    expect(await f.registry.getManagementAdmission(f.activityId)).toEqual(f.receipt);
    expect(f.sent).toEqual([]);
  }));

  it('REQ-OPERATOR-107: original ledger with absent local preparation can be retired and delayed preparation stays denied after reconstruction', () => withRetirement(async f => {
    const saved = await snapshot(f);
    await f.mutateEvidence(storage => storage.delete('admission').then(() => {}));
    expect(await retire(f.activity, f.activityId, f.connection)).toBe(true);
    const cold = f.restart(); await f.drainBackground();
    expect((await cold.prepareAuthorized(saved.intent, saved.executionContext, saved.invocationJson)).ok).toBe(false);
    expect((await cold.start('s'.repeat(43))).ok).toBe(false);
    expect((await cold.beginDrive()).ok).toBe(false);
    expect(await cold.getAdmission()).toBeNull();
    expect(await f.registry.getManagementAdmission(f.activityId)).toEqual(f.receipt);
    expect(f.normalTransport!.admissions.size).toBe(0);
  }));

  it('REQ-OPERATOR-107: retirement while prepared rejects the first start transaction and preserves the immutable original receipt', () => withRetirement(async f => {
    await resetToPrepared(f, await snapshot(f));
    expect(await retire(f.activity, f.activityId, f.connection)).toBe(true);
    const cold = f.restart(); await f.drainBackground();
    expect((await cold.start('s'.repeat(43))).ok).toBe(false);
    expect((await cold.beginDrive()).ok).toBe(false);
    expect((await cold.getAdmission())?.phase).not.toBe('queued');
    expect(await f.registry.getManagementAdmission(f.activityId)).toEqual(f.receipt);
    expect(f.normalTransport!.admissions.size).toBe(0);
  }));

  it('REQ-OPERATOR-107: immutable admission recorded before retirement cannot queue when its delayed Registry reply returns', () => withRetirement(async f => {
    await resetToPrepared(f, await snapshot(f));
    const recorded = gate(); const release = gate();
    f.afterRecorded(async () => { recorded.resolve(); await release.promise; });
    const starting = f.activity.start('s'.repeat(43));
    try {
      await within(Promise.race([recorded.promise, starting.then(() => { throw new Error('Start settled before recorded-admission boundary'); })]), 'recorded original admission');
      expect(await f.registry.getManagementAdmission(f.activityId)).toEqual(f.receipt);
      expect(await retire(f.activity, f.activityId, f.connection)).toBe(true);
      release.resolve();
      expect((await starting).ok).toBe(false);
      const cold = f.restart(); await f.drainBackground();
      expect((await cold.getAdmission())?.phase).not.toBe('queued');
      expect((await cold.beginDrive()).ok).toBe(false);
      expect(await cold.operatorGenerationCurrent(1)).toBe(false);
      expect(await f.registry.getManagementAdmission(f.activityId)).toEqual(f.receipt);
      expect(f.normalTransport!.admissions.size).toBe(0);
    } finally { release.resolve(); await starting; }
  }));

  it.each(['completed', 'failed'] as const)('REQ-OPERATOR-107: retiring terminal %s original preserves exact result/checkpoint/history instead of rewriting cancellation', status => withRetirement(async f => {
    expect((await f.activity.beginDrive()).ok).toBe(true);
    const checkpoint = { original: status };
    const result = status === 'completed' ? { preserved: 'original-result' } : undefined;
    expect((await f.activity.commitDrive(1, { schemaVersion: 1, status, checkpoint, ...(result ? { result } : {}) })).ok).toBe(true);
    const terminal = await f.activity.getBrowserDetail();
    expect(terminal).toMatchObject({ executionStatus: status, checkpoint, result: result ?? null });
    expect(await retire(f.activity, f.activityId, f.connection)).toBe(true);
    const cold = f.restart(); await f.drainBackground();
    expect(await cold.getBrowserDetail()).toMatchObject({ executionStatus: status, checkpoint, result: result ?? null });
    expect((await cold.beginDrive()).ok).toBe(false);
    expect(await f.registry.getManagementAdmission(f.activityId)).toEqual(f.receipt);
    expect(f.normalTransport!.admissions.size).toBe(0);
  }));

  it('REQ-OPERATOR-107: unknown external write/journal and original SDK receipt survive retirement; deletion permission never becomes retry/settlement proof', () => withRetirement(async f => {
    await start(f);
    const operation = { operationId: 'original-unknown-write', method: 'POST',
      url: 'https://api.github.com/repos/another/service/issues/17/comments', body: '{"body":"Original intended comment"}' };
    f.loseResponse();
    const unknown = await callback(f, 'source', operation);
    expect(unknown.status).toBe(409); expect(await unknown.json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
    f.restoreTransport();
    const original = structuredClone([...f.normalTransport!.admissions.values()]);
    const receiptBefore = await (await callback(f, 'receipt', { operationId: operation.operationId })).json();
    expect(receiptBefore).toMatchObject({ phase: 'unknown', operationCount: 1 });
    let evidence!: Map<string, unknown>; let journal: unknown;
    await f.mutateEvidence(async storage => {
      evidence = structuredClone(await storage.list({ prefix: 'dispatcher:operation:' }));
      journal = structuredClone(await storage.get('dispatcher:journal'));
    });
    expect(evidence.size).toBeGreaterThan(0);
    expect(journal).toMatchObject({ generation: 1, unresolved: 1 });
    expect(await retire(f.activity, f.activityId, f.connection)).toBe(true);
    const cold = f.restart(); await f.drainBackground();
    expect((await cold.beginDrive()).ok).toBe(false);
    expect(await cold.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect((await cold.getBrowserDetail())!.result).toBeNull();
    await f.mutateEvidence(async storage => {
      expect(await storage.list({ prefix: 'dispatcher:operation:' })).toEqual(evidence);
      expect(await storage.get('dispatcher:journal')).toEqual(journal);
    });
    expect([...f.normalTransport!.admissions.values()]).toEqual(original);
    expect(await f.registry.getManagementAdmission(f.activityId)).toEqual(f.receipt);
    expect((await callback(f, 'source', operation)).status).toBe(403);
    expect(await f.readRemoteComments()).toEqual([{ id: 91, body: 'Original intended comment', user: { id: 42 } }]);
  }));
});
