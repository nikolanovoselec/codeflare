/// <reference types="@cloudflare/vitest-plugin/types" />
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { decryptFromKV, getOrImportKey } from '../../lib/kv-crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, reset, runInDurableObject } from 'cloudflare:test';
import { OperatorActivity, createOperatorIntentDigest } from '../../operators/activity';
import { OperatorRegistry, type ManagementAdmissionReceipt, type ManagementExecutionSelection } from '../../operators/registry';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import { operatorOwnerKey } from '../../operators/browser-activity';
import { createDispatcherPhaseState } from '../../operators/dispatcher-phases';
import type { ApplicationExecutionAuthority } from '../../operators/application-workflow';
import { connectionSecret, normalCallback, normalDeployment, normalDispatcherBundle } from './fixtures/normal-dispatcher';
import { sealOperatorSecret } from '../../operators/protected-secrets';
import type { Env } from '../../types';
import { captureRawValue } from '../../../host/src/operator-raw-logging';
import { createOwnerRawCaptureStorage, discoverRawCaptures, readRawCapture } from '../../operators/raw-capture-storage';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

/** Persisted-state component fixture, not an SDK workload. Reuses the original
 * normal deployment, sealed owner context and immutable Registry ledger setup.
 * No activation, discovery, coordinator retry RPC, SDK or container is run. */
async function fixture(run: (f: Awaited<ReturnType<typeof seed>>) => Promise<void>) {
  const registryNamespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  const activityNamespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  const registryName = `execution-ledger-${crypto.randomUUID()}`;
  const inRegistry = <T>(action: (state: DurableObjectState) => T | Promise<T>) =>
    runInDurableObject(registryNamespace.getByName(registryName), (_registry, state) => action(state));
  const activityId = `execution-${crypto.randomUUID()}`;
  await runInDurableObject(activityNamespace.getByName(activityId), async (_activity, native) => {
    await run(await seed(native, activityNamespace, activityId, inRegistry));
  });
}
async function seed(native: DurableObjectState, namespace: DurableObjectNamespace, activityId: string,
  inRegistry: <T>(action: (state: DurableObjectState) => T | Promise<T>) => Promise<T>) {
  const now = Date.now();
  const human = { subject: 'z@example.test', email: 'z@example.test', issuer: 'https://owner.cloudflareaccess.com',
    audiences: ['audience'], issuedAt: Math.floor(now / 1000) - 20, expiresAt: Math.floor(now / 1000) + 3600 };
  const unsafe: string[] = [];
  const refuse = (name: string): never => { unsafe.push(name); throw Error(`Unexpected external work: ${name}`); };
  const environment = { ENCRYPTION_KEY: btoa('k'.repeat(32)),
    OPERATOR_ACTIVITY: { idFromName: (name: string) => namespace.idFromName(name), getByName: () => refuse('Activity RPC') },
    OPERATOR_REGISTRY: { getByName: () => refuse('Registry RPC') },
    CONTAINER: { getByName: () => refuse('container') }, LOADER: { get: () => refuse('loader') },
  } as unknown as Env;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => refuse('network'));
  const registryInstance = await inRegistry(state => new OperatorRegistry(state, environment));
  const registry = new Proxy(registryInstance, { get(target, property) {
    const member = Reflect.get(target, property, target);
    return typeof member === 'function' ? (...args: unknown[]) => inRegistry(() => member.apply(target, args)) : member;
  } });
  const setLedger = (receipt?: ManagementAdmissionReceipt) => inRegistry(state => {
    if (receipt) state.storage.sql.exec('INSERT OR REPLACE INTO operator_admissions VALUES(?,?)', activityId, JSON.stringify(receipt));
    else state.storage.sql.exec('DELETE FROM operator_admissions WHERE activity_id=?', activityId);
  });
  const activity = new OperatorActivity(native, environment);
  // Agents 0.33 starts capability migrations lazily on the first async RPC.
  // Settle that real startup before seeding evidence or taking no-write baselines.
  await activity.lifecycle.start();
  const bundle = normalDispatcherBundle(), bundleDigest = hash(bundle);
  const policy = { capabilities: ['fetch'], resourceProfileId: null };
  const selection = { controlsRevision: 1,
    installation: { id: 'dispatcher-install', operatorId: 'dispatcher', enabled: true, revision: 1,
      releaseId: 'release', configurationJson: '{}', policy },
    operator: { id: 'dispatcher', operatorId: 'dispatcher', profile: 'dispatcher', revision: 1,
      repositoryId: 23, policy, invokers: { users: [human.email], groups: [] } },
    release: { id: 'release', operatorId: 'dispatcher', bundleDigest, sourceCommit: bundle.sourceCommit,
      manifestDigest: 'd'.repeat(64), intentVersion: '4', provenance: { compilerCommit: normalDeployment.compilerCommit } },
    manifestJson: JSON.stringify({ id: 'renovate-dispatcher', profile: 'dispatcher', intentVersion: '4' }),
  } as unknown as ManagementExecutionSelection;
  const context = await createOperatorExecutionContext({ activityId, operatorId: 'dispatcher', artifactDigest: bundleDigest,
    policyDigest: hash(policy), human, accessJwt: 'z-jwt' }, environment);
  const ownerKey = await operatorOwnerKey(human);
  const invocationJson = JSON.stringify({ repository: 'acme/updates' });
  const capability = 's'.repeat(43);
  const intent = { installationId: 'dispatcher-install', activityId, operatorId: 'dispatcher',
    intentDigest: await createOperatorIntentDigest('dispatcher', activityId, invocationJson), expectedRevision: 1,
    expectedInstallationRevision: 1, expectedControlsRevision: 1, deadline: human.expiresAt * 1000,
    startExpiresAt: human.expiresAt * 1000, startVerifier: createHash('sha256').update(capability).digest('hex') };
  const receipt: ManagementAdmissionReceipt = { installationId: intent.installationId, activityId,
    intentDigest: intent.intentDigest, expectedInstallationRevision: 1, expectedOperatorRevision: 1,
    expectedControlsRevision: 1, deadline: intent.deadline, admittedAt: now, selection };
  // Same real immutable SQL ledger as the old normalAlarmHandoff fixture.
  await registry.getManagementAdmission(activityId);
  await setLedger(receipt);
  const authority: ApplicationExecutionAuthority = { version: 1,
    current: { principal: 'operator', sourceId: '23', sourceRepositoryId: 23, installationId: 'dispatcher-install',
      ownerKey, activityId: 'current-activity', generation: 1, deadline: intent.deadline, human,
      operatorId: 'dispatcher', releaseId: 'current-release', bundleDigest: 'e'.repeat(64),
      installationRevision: 2, operatorRevision: 1, controlsRevision: 1,
      intentDigest: 'f'.repeat(64), deliveryToken: 'current-delivery' },
    original: { activityId, installationId: intent.installationId, operatorId: 'dispatcher', sourceRepositoryId: 23,
      ownerKey, owner: context.owner, invocationJson, binding: 'legacy', pins: { operatorRevision: 1,
        installationRevision: 1, controlsRevision: 1, releaseId: 'release', bundleDigest } },
    ledger: { ok: true, receipt: await registry.getManagementAdmission(activityId) } };
  const state = { intent, phase: 'queued', receipt, executionContext: context, invocationJson, ownerKey,
    privateEvidence: { token: 'SYNTHETIC_ORIGINAL_BYTES_秘密🧪', nested: [1, { untouched: true }] },
    drive: { generation: 2, status: 'unknown', checkpoint: null, result: null },
    diagnosticsVersion: 1, diagnosticBinding: { generation: 1, artifactDigest: bundleDigest, inputDigest: intent.intentDigest },
    diagnosticFence: { generation: 1, timestamp: now, boundary: 'fence', code: 'runtime-failure', uncertain: true }, updatedAt: now };
  const deployment = { ...normalDeployment, installationId: intent.installationId, releaseId: 'release',
    connectionRevision: 1, bundleDigest, manifestDigest: selection.release.manifestDigest };
  const profile = { generation: 1, hosting: 'normal', status: 'admitting', submissionId: null,
    artifactDigest: bundleDigest, inputDigest: intent.intentDigest, expiresAt: Math.floor(intent.deadline / 1000) * 1000,
    connectionSecretCiphertext: await sealOperatorSecret(connectionSecret, environment,
      { purpose: 'connection', recordId: 'dispatcher-install' }), deployment,
    serial: createDispatcherPhaseState('submission', hash(receipt), { deliveryToken: 'original-token', idempotencyKey: 'original-key' }) };
  await native.storage.put({ admission: state, 'prospective-admission': activityId });
  return { activity, native, registry, setLedger, activityId, authority, state, profile, receipt,
    capability, context, invocationJson, unsafe, environment, bundle };
}
type Fixture = Awaited<ReturnType<typeof seed>>;

// Exact 5a4c2eaf / 266843f1 regression matrix, now against the local generic API.
const preLeaseCases = ['pre-lease-fenced', 'pre-lease-missing-binding', 'pre-lease-binding-generation',
  'pre-lease-fence-generation', 'pre-lease-later-generation', 'pre-lease-artifact-mismatch', 'pre-lease-input-mismatch',
  'pre-lease-checkpoint', 'pre-lease-result', 'pre-lease-collected', 'pre-lease-runtime-lease', 'pre-lease-profile-lease',
  'pre-lease-runtime-effect', 'pre-lease-publication', 'pre-lease-ledger-unavailable', 'pre-lease-read-unavailable',
  'pre-lease-foreign-owner', 'pre-lease-delayed-admission', 'pre-lease-bootstrap-valid', 'pre-lease-bootstrap-legacy',
  'pre-lease-bootstrap-delayed', 'pre-lease-bootstrap-generation', 'pre-lease-bootstrap-deployment',
  'pre-lease-bootstrap-no-deployment', 'pre-lease-bootstrap-status', 'pre-lease-bootstrap-wire',
  'pre-lease-bootstrap-receipt', 'pre-lease-bootstrap-serial', 'pre-lease-bootstrap-extra', 'pre-lease-bootstrap-effect'] as const;
const replaceable = new Set<string>(['pre-lease-fenced', 'pre-lease-delayed-admission',
  'pre-lease-bootstrap-valid', 'pre-lease-bootstrap-legacy', 'pre-lease-bootstrap-delayed']);

async function assertLocal(f: Fixture, eligible: boolean, preserveAdmission = true) {
  const before = structuredClone(await f.native.storage.list());
  const ledger = await f.registry.getManagementAdmission(f.activityId);
  const alarm = await f.native.storage.getAlarm();
  const facts = await f.activity.readApplicationExecutionFacts(f.authority);
  expect(await f.native.storage.list()).toEqual(before);
  expect(await f.native.storage.getAlarm()).toBe(alarm);
  if (eligible) {
    expect(facts).toMatchObject({ status: 'never-started', activityId: f.activityId, retired: false });
    if (facts.status !== 'never-started') throw Error('Missing local proof');
    expect(facts.proofVersion).toMatch(/^[a-f0-9]{64}$/);
    const request = { ...f.authority, proofVersion: facts.proofVersion };
    expect(await f.activity.retireApplicationExecution(request)).toEqual({ status: 'retired', activityId: f.activityId,
      proofVersion: facts.proofVersion });
    const retired = structuredClone(await f.native.storage.list());
    expect(retired.get('prospective-retirement')).toBe(f.activityId);
    for (const [key, value] of before) if (key !== 'admission' || preserveAdmission) expect(retired.get(key)).toEqual(value);
    // An acknowledged retry cannot rewrite the first retirement or its history.
    expect(await f.activity.retireApplicationExecution(request)).toMatchObject({ status: 'retired', activityId: f.activityId });
    expect(await f.native.storage.list()).toEqual(retired);
    expect(await f.activity.beginDrive()).toEqual({ ok: false, reason: 'drive-settled' });
    expect(await f.activity.start(f.capability)).toEqual({ ok: false, reason: 'admission-denied' });
    expect(await f.activity.prepareAuthorized(f.state.intent, f.context, f.invocationJson))
      .toEqual({ ok: false, reason: 'admission-denied' });
    expect(await f.native.storage.list()).toEqual(retired);
  } else {
    expect(facts).toEqual({ status: 'unavailable' });
    expect(await f.activity.retireApplicationExecution({ ...f.authority, proofVersion: 'a'.repeat(64) }))
      .toEqual({ status: 'unavailable' });
    expect(await f.native.storage.list()).toEqual(before);
  }
  expect(await f.registry.getManagementAdmission(f.activityId)).toEqual(ledger);
  expect(await f.native.storage.getAlarm()).toBe(alarm);
  expect(f.unsafe).toEqual([]);
}

describe('generic local execution facts: original first-generation pre-lease proof', () => {
  it.each(preLeaseCases)('%s preserves the original state and admits only a proven local fence', name => fixture(async f => {
    const state = structuredClone(f.state) as Record<string, any>;
    if (name === 'pre-lease-missing-binding') delete state.diagnosticBinding;
    if (name === 'pre-lease-binding-generation') state.diagnosticBinding.generation = 2;
    if (name === 'pre-lease-fence-generation') state.diagnosticFence.generation = 0;
    if (name === 'pre-lease-later-generation') {
      state.diagnosticBinding.generation = state.diagnosticFence.generation = 2; state.drive.generation = 3;
    }
    if (name === 'pre-lease-artifact-mismatch') state.diagnosticBinding.artifactDigest = 'f'.repeat(64);
    if (name === 'pre-lease-input-mismatch') state.diagnosticBinding.inputDigest = 'f'.repeat(64);
    if (name === 'pre-lease-checkpoint') state.drive.checkpoint = { retained: true };
    if (name === 'pre-lease-result') state.drive.result = { retained: true };
    if (name === 'pre-lease-collected') state.browserCollectionConsumed = true;
    if (name === 'pre-lease-foreign-owner') f.authority.original.ownerKey = 'f'.repeat(64);
    if (name === 'pre-lease-ledger-unavailable') f.authority.ledger = { ok: false };
    if (name.startsWith('pre-lease-bootstrap-')) {
      const profile = structuredClone(f.profile) as Record<string, any>;
      if (name === 'pre-lease-bootstrap-legacy') {
        delete profile.serial;
        state.receipt.selection.release.intentVersion = '3';
        state.receipt.selection.manifestJson = JSON.stringify({ id: 'renovate-dispatcher', profile: 'dispatcher', intentVersion: '3' });
        await f.setLedger(state.receipt);
        f.authority.ledger = { ok: true, receipt: await f.registry.getManagementAdmission(f.activityId) };
      }
      if (name === 'pre-lease-bootstrap-generation') profile.generation = 2;
      if (name === 'pre-lease-bootstrap-deployment') profile.deployment.manifestDigest = 'f'.repeat(64);
      if (name === 'pre-lease-bootstrap-no-deployment') delete profile.deployment;
      if (name === 'pre-lease-bootstrap-status') profile.status = 'unknown';
      if (name === 'pre-lease-bootstrap-wire') profile.wire = { id: 'historical-wire' };
      if (name === 'pre-lease-bootstrap-receipt') profile.receipt = { submissionId: 'historical-submission' };
      if (name === 'pre-lease-bootstrap-serial') profile.serial.current.phase = { kind: 'final' };
      if (name === 'pre-lease-bootstrap-extra') profile.unclassifiedState = true;
      await f.native.storage.put('dispatcher:profile-lease', profile);
    }
    if (name === 'pre-lease-profile-lease') await f.native.storage.put('dispatcher:profile-lease', { generation: 1, status: 'unknown' });
    if (name === 'pre-lease-runtime-lease') await f.native.storage.put('dispatcher:lease', { generation: 1, status: 'unknown' });
    if (name === 'pre-lease-runtime-effect' || name === 'pre-lease-bootstrap-effect')
      await f.native.storage.put('dispatcher:operation:orphan', { generation: 1, phase: 'unknown' });
    if (name === 'pre-lease-publication') await f.native.storage.put('renovate:publication', { effects: { comment: { phase: 'unknown' } } });
    await f.native.storage.put('admission', state);
    if (name === 'pre-lease-read-unavailable') {
      const transaction = f.native.storage.transaction.bind(f.native.storage);
      const unavailable = vi.spyOn(f.native.storage, 'transaction').mockImplementation((async (work: (tx: DurableObjectTransaction) => Promise<unknown>) =>
        transaction(tx => work(new Proxy(tx, { get(object, property) {
          if (property === 'list') return () => { throw Error('Original runtime evidence unavailable'); };
          const member = Reflect.get(object, property, object);
          return typeof member === 'function' ? member.bind(object) : member;
        } })))) as typeof f.native.storage.transaction);
      try { await assertLocal(f, false); } finally { unavailable.mockRestore(); }
    } else await assertLocal(f, replaceable.has(name));
  }));
});

describe('generic execution binding and atomic retirement', () => {
  it.each(['absent', 'prepared', 'queued', 'generation-zero-cancelled', 'legacy-full-absent', 'legacy-full-prepared',
    'legacy-full-queued', 'session-pinned'] as const)('%s retires without opening an old execution', name => fixture(async f => {
    const state = structuredClone(f.state) as Record<string, any>;
    delete state.drive; delete state.diagnosticBinding; delete state.diagnosticFence; delete state.diagnosticsVersion;
    if (name.includes('absent') || name.includes('prepared')) {
      await f.setLedger();
      f.authority.ledger = { ok: true, receipt: await f.registry.getManagementAdmission(f.activityId) };
      state.phase = 'prepared'; state.receipt = null;
    }
    if (name.startsWith('legacy-full-')) f.authority.original.pins = null;
    if (name === 'session-pinned') state.ownerSource = { bucket: 'owner-bucket', sessionId: 'zsession01', sessionGeneration: 4 };
    if (name === 'generation-zero-cancelled') {
      state.drive = { generation: 1, status: 'cancel-requested', checkpoint: null, result: null };
      state.diagnosticFence = { generation: 0, boundary: 'fence', code: 'cancelled', uncertain: false };
    }
    if (name.includes('absent')) await f.native.storage.delete('admission');
    else await f.native.storage.put('admission', state);
    await assertLocal(f, true, name.includes('absent') || name === 'generation-zero-cancelled');
    if (name.includes('prepared')) expect(await f.native.storage.get('admission')).toMatchObject({
      phase: 'cancelled', receipt: null, intent: { startVerifier: '' }, privateEvidence: f.state.privateEvidence });
    if (name === 'queued' || name === 'legacy-full-queued' || name === 'session-pinned')
      expect(await f.native.storage.get('admission')).toMatchObject({ phase: 'queued',
        drive: { generation: 1, status: 'cancel-requested', checkpoint: null, result: null },
        diagnosticFence: { generation: 0, uncertain: false }, privateEvidence: f.state.privateEvidence });
  }));

  it('retains large, deep original evidence through both an uncertain-effect refusal and acknowledged retirement', () => fixture(async f => {
    let deep: unknown = { original: 'SYNTHETIC_PRIVATE_DEEP_秘密🧪' };
    for (let depth = 0; depth < 80; depth++) deep = { child: deep };
    await f.native.storage.put('admission', { ...f.state, privateEvidence: {
      token: 'SYNTHETIC_PRIVATE_秘密🧪'.repeat(6000), deep,
      nested: Array.from({ length: 40 }, (_, index) => ({ index, body: `Original secret ${index}` })),
    } });
    await f.native.storage.put('dispatcher:operation:orphan', { generation: 1, phase: 'unknown', requestDigest: 'd'.repeat(64) });
    await assertLocal(f, false);
    await f.native.storage.delete('dispatcher:operation:orphan');
    await assertLocal(f, true);
  }));

  it('ordinary application binding uses the same local fence without a legacy prospective link', () => fixture(async f => {
    f.authority.original.binding = 'activity';
    await f.native.storage.delete('prospective-admission');
    await assertLocal(f, true);
  }));

  it.each(['pre-lease-delayed-admission', 'pre-lease-bootstrap-delayed'] as const)(
    '%s cannot revive an original generation through a delayed admission or authenticated bootstrap callback', name => fixture(async f => {
      if (name === 'pre-lease-bootstrap-delayed') await f.native.storage.put('dispatcher:profile-lease', f.profile);
      const facts = await f.activity.readApplicationExecutionFacts(f.authority);
      if (facts.status !== 'never-started') throw Error('Missing local proof');
      expect(await f.activity.retireApplicationExecution({ ...f.authority, proofVersion: facts.proofVersion }))
        .toMatchObject({ status: 'retired' });
      // Permit original local read services, never SDK/Host/network execution.
      f.environment.OPERATOR_REGISTRY = { getByName: () => ({
        getManagementBundle: async () => new TextEncoder().encode(JSON.stringify(f.bundle)),
        resolveManagementExecution: async () => ({ ok: true, value: f.receipt.selection }),
        getManagementDispatcherConnection: async () => ({ ...f.profile.deployment,
          connectionSecretCiphertext: f.profile.connectionSecretCiphertext }),
      }) } as never;
      expect(await f.activity.beginDrive()).toEqual({ ok: false, reason: 'drive-settled' });
      expect(await f.activity.admitDispatcher(1, f.bundle, f.receipt.selection.release.bundleDigest,
        JSON.parse(f.invocationJson))).toMatchObject({ ok: false });
      for (const [path, body] of [
        ['pi/config', { operation: 'read' }],
        ['model-admission', { operationId: 'late-model', context: { messages: [{ role: 'user', content: 'Late request' }] }, options: {} }],
      ] as const) expect((await f.activity.dispatcherInstalledCallback(1, normalCallback(f.activityId, path, body,
        { 'x-codeflare-operator-installation': 'dispatcher-install' }))).status).toBe(403);
      expect(await f.native.storage.get('admission')).toEqual(f.state);
      expect(await f.native.storage.get('dispatcher:profile-lease')).toEqual(name === 'pre-lease-bootstrap-delayed' ? f.profile : undefined);
      expect(await f.native.storage.get('dispatcher:lease')).toBeUndefined();
      expect(f.unsafe).toEqual([]);
    }));

  it.each(['absent-global-receipt', 'legacy-full-missing-local', 'admitting', 'unknown', 'active-original', 'foreign-owner', 'foreign-subject', 'foreign-issuer',
    'foreign-audiences', 'foreign-installation', 'foreign-operator', 'foreign-source', 'foreign-activity',
    'foreign-binding', 'foreign-retirement', 'mismatched-pins', 'mismatched-intent', 'mismatched-input',
    'ledger-unavailable', 'ledger-missing-result', 'ledger-invalid-result', 'ledger-missing', 'legacy-full-ledger-missing', 'ledger-mismatch', 'legacy-full-ledger-mismatch',
    'orphan-effect', 'orphan-publication', 'orphan-lease', 'owned-session', 'expired', 'short-human-lifetime'] as const)(
    '%s cannot certify retirement or alter retained evidence', name => fixture(async f => {
      const state = structuredClone(f.state) as Record<string, any>;
      if (name.startsWith('legacy-full-')) f.authority.original.pins = null;
      if (name === 'absent-global-receipt' || name === 'legacy-full-missing-local') await f.native.storage.delete('admission');
      if (name === 'admitting') { state.phase = 'admitting'; state.receipt = null; delete state.drive; f.authority.ledger = { ok: true, receipt: null }; }
      if (name === 'unknown') delete state.diagnosticFence;
      if (name === 'active-original') state.drive = { generation: 1, status: 'running', checkpoint: null, result: null };
      if (name === 'foreign-owner') state.ownerKey = 'a'.repeat(64);
      if (name === 'foreign-subject') state.executionContext.owner.subject = 'foreign';
      if (name === 'foreign-issuer') state.executionContext.owner.issuer = 'https://foreign.test';
      if (name === 'foreign-audiences') state.executionContext.owner.audiences = ['foreign'];
      if (name === 'foreign-installation') state.intent.installationId = 'foreign';
      if (name === 'foreign-operator') state.executionContext.operatorId = 'foreign';
      if (name === 'foreign-source') f.authority.current.sourceRepositoryId++;
      if (name === 'foreign-activity') f.authority.original.activityId = 'foreign';
      if (name === 'foreign-binding') await f.native.storage.put('prospective-admission', 'foreign');
      if (name === 'foreign-retirement') await f.native.storage.put('prospective-retirement', 'foreign');
      if (name === 'mismatched-pins') f.authority.original.pins!.releaseId = 'foreign';
      if (name === 'mismatched-intent') state.intent.intentDigest = 'a'.repeat(64);
      if (name === 'mismatched-input') state.invocationJson = '{}';
      if (name === 'ledger-unavailable') f.authority.ledger = { ok: false };
      if (name === 'ledger-missing-result') f.authority.ledger = { ok: true, receipt: undefined as never };
      if (name === 'ledger-invalid-result') f.authority.ledger = { ok: true, receipt: {} as never };
      if (name === 'ledger-missing' || name === 'legacy-full-ledger-missing') {
        await f.setLedger();
        f.authority.ledger = { ok: true, receipt: await f.registry.getManagementAdmission(f.activityId) };
      }
      if (name === 'ledger-mismatch' || name === 'legacy-full-ledger-mismatch') {
        await f.setLedger({ ...f.receipt, intentDigest: 'f'.repeat(64) });
        f.authority.ledger = { ok: true, receipt: await f.registry.getManagementAdmission(f.activityId) };
      }
      if (name === 'orphan-effect') await f.native.storage.put('dispatcher:operation:orphan', { phase: 'unknown' });
      if (name === 'orphan-lease') await f.native.storage.put('dispatcher:lease', { generation: 1, status: 'unknown' });
      if (name === 'orphan-publication') await f.native.storage.put('renovate:publication', { effects: { comment: { phase: 'unknown' } } });
      if (name === 'owned-session') await f.native.storage.put('ownedSession', { sessionId: 'zsession01' });
      if (name === 'expired') f.authority.current = { ...f.authority.current, deadline: Date.now() - 1 };
      if (name === 'short-human-lifetime') f.authority.current.human = { ...f.authority.current.human, expiresAt: Math.floor(Date.now() / 1000) };
      if (name !== 'absent-global-receipt' && name !== 'legacy-full-missing-local') await f.native.storage.put('admission', state);
      await assertLocal(f, false);
    }));

  it.each(['changed-state', 'changed-ledger', 'concurrent-drive', 'expired'] as const)(
    '%s between read and retirement cannot consume a stale internal proof', name => fixture(async f => {
      // An unstarted queued record can race the first real drive.
      const state = structuredClone(f.state) as Record<string, any>;
      delete state.drive; delete state.diagnosticFence; delete state.diagnosticBinding;
      await f.native.storage.put('admission', state);
      const facts = await f.activity.readApplicationExecutionFacts(f.authority);
      if (facts.status !== 'never-started') throw Error('Missing local proof');
      if (name === 'changed-state') await f.native.storage.put('admission', { ...state, privateEvidence: { concurrent: true } });
      if (name === 'changed-ledger') f.authority.ledger = { ok: true, receipt: { ...f.receipt, admittedAt: f.receipt.admittedAt + 1 } };
      // Seed the observable committed competing drive; do not start a native workload.
      if (name === 'concurrent-drive') await f.native.storage.put('admission', { ...state,
        drive: { generation: 1, status: 'running', checkpoint: null, result: null } });
      if (name === 'expired') f.authority.current = { ...f.authority.current, deadline: Date.now() - 1 };
      const before = structuredClone(await f.native.storage.list());
      expect(await f.activity.retireApplicationExecution({ ...f.authority, proofVersion: facts.proofVersion }))
        .toEqual({ status: name === 'changed-state' ? 'conflict' : 'unavailable' });
      expect(await f.native.storage.list()).toEqual(before);
      expect(f.unsafe).toEqual([]);
    }));
});

async function terminal(f: Fixture) {
  const result = { application: 'independent', value: ['opaque', 42] };
  const checkpoint = { cursor: 'original' };
  const state = { ...f.state, browserCollectionConsumed: true,
    drive: { generation: 1, status: 'completed', result, checkpoint }, diagnosticFence: undefined };
  delete state.diagnosticFence;
  const lease = { ...f.profile, status: 'settled', submissionId: 'original-submission', settledSubmissionId: 'original-submission',
    terminalAt: Date.now() - 1, receipt: { submissionId: 'original-submission', uid: 'original-uid', acceptedAt: new Date().toISOString() },
    wire: { id: `${f.activityId}-g1`, activityId: f.activityId, generation: 1, installationId: 'dispatcher-install',
      releaseId: 'release', workerVersionId: normalDeployment.workerVersionId, connectionRevision: 1 } };
  await f.native.storage.put({ admission: state, 'dispatcher:lease': lease, 'dispatcher:result:1': result,
    'dispatcher:journal': { generation: 1, count: 0, nextOrdinal: 0, unresolved: 0 } });
  return { state, lease, result, checkpoint };
}

describe('generic completed facts are original SDK settlement, not application policy', () => {
  it('returns opaque original result/checkpoint only with exact collection and settlement, without retiring or driving', () => fixture(async f => {
    const saved = await terminal(f);
    const before = structuredClone(await f.native.storage.list());
    expect(await f.activity.readApplicationExecutionFacts(f.authority)).toEqual({ status: 'value', activityId: f.activityId,
      generation: 1, releaseDigest: f.receipt.selection.release.bundleDigest, inputDigest: f.receipt.intentDigest,
      terminalAt: saved.lease.terminalAt, collected: true, settled: true, sdkSubmissionId: 'original-submission',
      unknownEffects: false, result: saved.result, checkpoint: saved.checkpoint });
    expect(await f.activity.retireApplicationExecution({ ...f.authority, proofVersion: 'a'.repeat(64) }))
      .toEqual({ status: 'unavailable' });
    expect(await f.native.storage.list()).toEqual(before);
    expect(f.unsafe).toEqual([]);
  }));

  it.each(['uncollected', 'unsettled', 'wrong-submission', 'foreign-generation', 'foreign-release', 'foreign-input',
    'future-terminal', 'missing-result', 'changed-result', 'wrong-wire', 'unknown-write', 'unknown-kind',
    'foreign-operation-generation', 'unaccounted-journal', 'publication', 'profile'] as const)(
    '%s never becomes terminal proof or a never-started fallback', name => fixture(async f => {
      const saved = await terminal(f);
      const state = saved.state as Record<string, any>, lease = saved.lease as Record<string, any>;
      if (name === 'uncollected') state.browserCollectionConsumed = false;
      if (name === 'unsettled') lease.status = 'unknown';
      if (name === 'wrong-submission') lease.settledSubmissionId = 'other';
      if (name === 'foreign-generation') lease.generation = 2;
      if (name === 'foreign-release') lease.artifactDigest = 'a'.repeat(64);
      if (name === 'foreign-input') lease.inputDigest = 'a'.repeat(64);
      if (name === 'future-terminal') lease.terminalAt = Date.now() + 60_000;
      if (name === 'wrong-wire') lease.wire.activityId = 'foreign';
      if (name === 'missing-result') await f.native.storage.delete('dispatcher:result:1');
      if (name === 'changed-result') await f.native.storage.put('dispatcher:result:1', { forged: true });
      if (name === 'unknown-write' || name === 'unknown-kind' || name === 'foreign-operation-generation') {
        await f.native.storage.put(`dispatcher:operation:${name === 'foreign-operation-generation' ? 2 : 1}:original`, {
          generation: name === 'foreign-operation-generation' ? 2 : 1, requestDigest: 'a'.repeat(64), phase: 'unknown', ordinal: 0,
          ...(name === 'unknown-kind' ? {} : { request: { method: 'POST', url: 'https://api.github.com/original' } }),
        });
        await f.native.storage.put('dispatcher:journal', { generation: 1, count: 1, nextOrdinal: 1, unresolved: 1 });
      }
      if (name === 'unaccounted-journal') await f.native.storage.put('dispatcher:journal', { generation: 1, count: 1, nextOrdinal: 1, unresolved: 0 });
      if (name === 'publication') await f.native.storage.put('renovate:publication', { unknown: true });
      if (name === 'profile') await f.native.storage.put('dispatcher:profile-lease', f.profile);
      await f.native.storage.put({ admission: state, 'dispatcher:lease': lease });
      await assertLocal(f, false);
    }));
});

describe('explicit owner recovery facts preserve original history', () => {
  const request = (f: Fixture) => ({ human: f.authority.current.human, deadline: f.authority.current.deadline,
    original: f.authority.original, ledger: f.authority.ledger });
  it.each(['zero', 'get-model', 'unbound-sdk-http', 'earlier-delivery-model', 'response-cache', 'orphan-response-cache', 'retained-result',
    'settlement-cache', 'orphan-settlement-cache', 'missing-settlement-chunk',
    'missing-journal', 'invalid-aggregate', 'invalid-lease', 'lease-generation', 'lease-artifact', 'lease-input',
    'missing-fence', 'incomplete', 'write', 'unknown-kind', 'foreign-owner',
    'foreign-generation', 'ordinal-gap', 'count-mismatch', 'active', 'publication', 'session'] as const)(
    'classifies %s without SDK receipt, mutation or new execution', name => fixture(async f => {
      const settlement = new TextEncoder().encode(JSON.stringify({ status: 'failed', data: {},
        receipt: { submissionId: 'original-submission', uid: 'original-root', acceptedAt: new Date().toISOString() } }));
      const lease = { ...f.profile, status: 'unknown',
        submissionId: name === 'earlier-delivery-model' ? 'later-submission' : 'original-submission',
        ...(['settlement-cache', 'missing-settlement-chunk'].includes(name) ? { application: {
          version: 1, initialData: {}, checkpoint: null, context: null, planned: true,
          delivery: { token: 'original-delivery', ordinal: 1 }, idempotencyKey: 'original-key',
          pending: { delivery: { token: 'next-delivery', ordinal: 2 }, idempotencyKey: 'next-key',
            confirmed: { delivery: { token: 'original-delivery', ordinal: 1 }, settlementRef: {
              bytes: settlement.byteLength, sha256: createHash('sha256').update(settlement).digest('hex'),
            } } },
        } } : {}),
      };
      const state = structuredClone(f.state) as Record<string, any>;
      const authority = request(f);
      const operations = name === 'zero' ? [] : [
        { generation: 1, ordinal: 0, phase: 'completed', requestDigest: 'a'.repeat(64),
          request: { method: 'GET', url: 'https://api.github.com/repos/acme/updates' } },
        { generation: 1, ordinal: 1, phase: 'completed', requestDigest: 'b'.repeat(64),
          deliveryBinding: { resource: 'inference', submissionId: 'original-submission' },
          sdkHttp: { permitId: 'original-permit', attempts: 1 } },
      ] as Array<Record<string, any>>;
      if (name === 'unbound-sdk-http') {
        delete operations[1].deliveryBinding;
        operations[1].responseDigest = createHash('sha256').update('completed-model-response').digest('hex');
        operations[1].sdkHttp = { ...operations[1].sdkHttp, phase: 'completed', responseKey: 'dispatcher:response:1:op-1' };
      }
      if (name === 'incomplete') operations[0].phase = 'unknown';
      if (name === 'write') operations[0].request.method = 'POST';
      if (name === 'unknown-kind') delete operations[0].request;
      if (name === 'foreign-generation') operations[0].generation = 3;
      if (name === 'ordinal-gap') operations[0].ordinal = 5;
      if (name === 'foreign-owner') authority.human = { ...authority.human, subject: 'foreign' };
      if (name === 'active') state.drive = { ...state.drive, generation: 1, status: 'running' };
      if (name === 'lease-generation') lease.generation = 2;
      if (name === 'lease-artifact') lease.artifactDigest = 'f'.repeat(64);
      if (name === 'lease-input') lease.inputDigest = 'f'.repeat(64);
      if (name === 'missing-fence') delete state.diagnosticFence;
      await f.native.storage.put({ admission: state, 'dispatcher:lease': name === 'invalid-lease' ? null : lease,
        ...(name === 'invalid-aggregate' ? { 'dispatcher:operations': null } : {}),
        ...(name === 'missing-journal' ? {} : { 'dispatcher:journal': {
          generation: 1, count: operations.length + (name === 'count-mismatch' ? 1 : 0),
          nextOrdinal: operations.length, unresolved: 0 } }),
        ...Object.fromEntries(operations.map((value, index) => [`dispatcher:operation:1:op-${index}`, value])),
        ...(name === 'response-cache' ? { 'dispatcher:response:op-0': { body: 'retained source bytes' },
          'dispatcher:response:1:op-1': { body: 'retained model bytes' } } : {}),
        ...(name === 'orphan-response-cache' ? { 'dispatcher:response:unaccounted': { body: 'unbound bytes' } } : {}),
        ...(name === 'unbound-sdk-http' ? { 'dispatcher:response:1:op-1': { body: 'completed-model-response' } } : {}),
        ...(name === 'retained-result' ? { 'dispatcher:result:1': { original: 'retained result' } } : {}),
        ...(['settlement-cache', 'orphan-settlement-cache'].includes(name)
          ? { 'dispatcher:application-settlement:1:0': settlement } : {}),
        ...(name === 'publication' ? { 'renovate:publication': { effect: true } } : {}),
        ...(name === 'session' ? { ownedSession: { sessionId: 'old-session' } } : {}),
      });
      const before = structuredClone(await f.native.storage.list());
      const alarm = await f.native.storage.getAlarm();
      const result = await f.activity.readRecoveryFacts(authority);
      if (name === 'unbound-sdk-http') expect(result).toEqual({ resettable: false, reason: 'unknown-operation' });
      expect(result.resettable).toBe(['zero', 'get-model', 'earlier-delivery-model', 'response-cache', 'retained-result', 'settlement-cache'].includes(name));
      if (result.resettable) expect(result).toMatchObject({ reason: 'fenced-no-write', proofDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(await f.native.storage.list()).toEqual(before);
      expect(await f.native.storage.getAlarm()).toBe(alarm);
      expect(await f.registry.getManagementAdmission(f.activityId)).toEqual(f.receipt);
      expect(f.unsafe).toEqual([]);
    }));
  it.each([
    [true, 'bound'], [false, 'bound'], [true, 'absent'], [false, 'absent'],
    [true, 'unrelated'], [false, 'unrelated'],
  ] as const)('REQ-OPERATOR-210 AC3: logging=%s diagnostic binding=%s recovers the retained 42-operation failure without terminal SDK receipt or history mutation', (loggingEnabled, diagnostics) => fixture(async f => {
    const state = structuredClone(f.state) as Record<string, any>;
    state.receipt.selection.operator.policy = { ...state.receipt.selection.operator.policy, loggingEnabled };
    if (diagnostics === 'absent') delete state.diagnosticBinding;
    if (diagnostics === 'unrelated') state.diagnosticBinding = {
      generation: 99, artifactDigest: 'f'.repeat(64), inputDigest: 'e'.repeat(64),
    };
    await f.setLedger(state.receipt);
    const authority = { ...request(f), ledger: { ok: true as const, receipt: state.receipt } };
    const { serial: _serial, ...profile } = f.profile;
    const entries: Record<string, unknown> = {};
    for (let ordinal = 0; ordinal < 42; ordinal++) {
      const id = `operation-${ordinal}`;
      entries[`dispatcher:operation:1:${id}`] = { generation: 1, ordinal, phase: 'completed', requestDigest: hash(id),
        ...(ordinal < 40 ? { request: { method: 'GET', url: `https://api.github.com/repos/acme/updates/pulls/${ordinal + 1}` } }
          : { deliveryBinding: { resource: 'inference', submissionId: 'earlier-discovery' },
            sdkHttp: { permitId: `permit-${ordinal}`, attempts: 1 } }) };
      entries[`dispatcher:response:${ordinal < 40 ? '' : '1:'}${id}`] = { retained: `original-response-${ordinal}` };
    }
    await f.native.storage.put({ admission: state, ...entries,
      'dispatcher:lease': { ...profile, status: 'unknown', submissionId: 'final-submission' },
      'dispatcher:journal': { generation: 1, count: 42, nextOrdinal: 42, unresolved: 0 } });
    const before = await f.native.storage.list();
    expect(await f.activity.readRecoveryFacts(authority)).toMatchObject({ resettable: true, reason: 'fenced-no-write',
      origin: { generation: 1, deadline: state.intent.deadline } });
    expect(await f.native.storage.list()).toEqual(before);
    expect(await f.registry.getManagementAdmission(f.activityId)).toEqual(state.receipt);
    expect(f.unsafe).toEqual([]);
  }));
});

// REQ-OPERATOR-090/091: original immutable admission AND current observation
// authorize historical raw bytes, independently of the execution safety verdict.
describe('generic historical execution private capture', () => {
  it.each([
    [true, true], [true, false], [false, true], [false, false], ['unproven', true],
  ] as const)('original=%s current=%s captures only proven ON history', (original, current) => fixture(async f => {
    const state = structuredClone(f.state) as Record<string, any>;
    state.receipt.selection.operator.policy.loggingEnabled = original === 'unproven' ? 'invalid' : original;
    state.executionContext.policyDigest = hash(state.receipt.selection.installation.policy);
    f.authority.ledger = { ok: true, receipt: state.receipt };
    f.authority.observationLoggingEnabled = current;
    const raw = { generation: 1, phase: 'unknown', requestDigest: 'a'.repeat(64),
      request: { method: 'POST', url: 'https://api.github.com/synthetic' },
      response: { token: 'SYNTHETIC_HISTORICAL_RESPONSE_秘密🧪'.repeat(3000) } };
    await f.native.storage.put({ admission: state, 'dispatcher:operation:orphan': raw });
    const before = new Map([...await f.native.storage.list()].filter(([key]) => !key.startsWith('operator-raw')));
    const facts = await f.activity.readApplicationExecutionFacts(f.authority);
    expect(facts).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(facts)).not.toContain('SYNTHETIC_HISTORICAL');
    expect(await f.activity.retireApplicationExecution({ ...f.authority, proofVersion: 'a'.repeat(64) }))
      .toEqual({ status: 'unavailable' });
    const records: Array<{ stage: string; value: unknown }> = [];
    const storage = await createOwnerRawCaptureStorage(f.environment, f.native.storage, async () => {});
    const scope = { ownerKey: f.authority.original.ownerKey,
      scope: { kind: 'activity' as const, activityId: f.activityId, generation: 2 } };
    let cursor: string | undefined;
    do {
      const page = await discoverRawCaptures({ scope, storage, cursor, authorize: async () => {} });
      expect(page.status).toBe('complete');
      for (const binding of page.bindings) {
        const archive = await readRawCapture({ binding, storage });
        expect(archive.status).toBe('complete');
        records.push(...archive.records);
      }
      cursor = page.cursor ?? undefined;
    } while (cursor);
    if (original === true && current) {
      expect(records).toContainEqual({ stage: 'application-execution-ledger', value: captureRawValue(f.authority.ledger) });
      expect(records).toContainEqual({ stage: 'application-execution-runtime', value: [['dispatcher:operation:orphan', raw]] });
      expect(records).toContainEqual({ stage: 'application-execution-original', value: captureRawValue({
        state, bound: f.activityId, retirement: undefined,
      }) });
    } else expect(records).toEqual([]);
    expect(new Map([...await f.native.storage.list()].filter(([key]) => !key.startsWith('operator-raw')))).toEqual(before);
    expect(f.unsafe).toEqual([]);
  }));

  it('capture storage failure preserves a positive local proof and retirement', () => fixture(async f => {
    f.authority.observationLoggingEnabled = true;
    f.environment.ENCRYPTION_KEY = 'invalid';
    const facts = await f.activity.readApplicationExecutionFacts(f.authority);
    expect(facts.status).toBe('never-started');
    if (facts.status !== 'never-started') throw Error('Missing proof');
    expect(await f.activity.retireApplicationExecution({ ...f.authority, proofVersion: facts.proofVersion }))
      .toMatchObject({ status: 'retired' });
    expect(await f.native.storage.get('admission')).toEqual(f.state);
    expect(f.unsafe).toEqual([]);
  }));
});

it('historical ON runtime read failure retains its error but cannot certify snapshot correlation', () => fixture(async f => {
  f.authority.observationLoggingEnabled = true;
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(historyCaptureId);
  const original = new Error('SYNTHETIC_RUNTIME_READ_FAILURE', { cause: new Error('SYNTHETIC_STORAGE_CAUSE') });
  const before = await f.native.storage.get('admission');
  const transaction = f.native.storage.transaction.bind(f.native.storage);
  const fault = vi.spyOn(f.native.storage, 'transaction').mockImplementation((async (work: (tx: DurableObjectTransaction) => Promise<unknown>) =>
    transaction(tx => work(new Proxy(tx, { get(object, property) {
      if (property === 'list') return () => { throw original; };
      const member = Reflect.get(object, property, object);
      return typeof member === 'function' ? member.bind(object) : member;
    } })))) as typeof f.native.storage.transaction);
  try {
    expect(await f.activity.readApplicationExecutionFacts(f.authority)).toEqual({ status: 'unavailable' });
    expect(await f.activity.retireApplicationExecution({ ...f.authority, proofVersion: 'a'.repeat(64) }))
      .toEqual({ status: 'unavailable' });
  } finally { fault.mockRestore(); }
  const storage = await createOwnerRawCaptureStorage(f.environment, f.native.storage, async () => {});
  const page = await discoverRawCaptures({ storage, scope: { ownerKey: f.authority.original.ownerKey,
    scope: { kind: 'activity', activityId: f.activityId, generation: 2 } }, authorize: async () => {} });
  expect(page).toMatchObject({ status: 'complete', bindings: [] });
  const archive = await readRawCapture({ storage, binding: historyCaptureBinding(f) });
  expect(archive.status).toBe('incomplete');
  const records = await storedHistoryFrames(f);
  expect(records).toContainEqual({ stage: 'application-execution-error', value: captureRawValue(original) });
  expect(await f.native.storage.get('admission')).toEqual(before);
  expect(await f.native.storage.get('prospective-retirement')).toBeUndefined();
  expect(f.unsafe).toEqual([]);
}));

const historyCaptureId = '00000000-0000-4000-8000-000000000001';
const historyCaptureBinding = (f: Fixture) => ({ ownerKey: f.authority.original.ownerKey,
  installationId: f.authority.original.installationId, releaseId: 'release', captureId: historyCaptureId,
  scope: { kind: 'activity' as const, activityId: f.activityId, generation: 2 } });

/** Private v1 encrypted frame contract: inspect durable bytes while their producer
 * is paused, before any complete receipt/locator is allowed to exist. */
async function storedHistoryFrames(f: Fixture, list: typeof f.native.storage.list = f.native.storage.list.bind(f.native.storage), newestOnly = false) {
  const binding = historyCaptureBinding(f);
  const context = JSON.stringify(['codeflare-operator-raw-v1', binding.ownerKey, binding.installationId,
    binding.releaseId, binding.captureId, 'activity', f.activityId, 2]);
  const prefix = `operator-raw:v1:${createHash('sha256').update(context).digest('hex')}/`;
  const key = (await getOrImportKey(f.environment))!;
  const batches = new Map<number, Array<{ part: number; bytes: Buffer }>>();
  const frames = await list<string>({ prefix });
  const latest = newestOnly ? Math.max(-1, ...[...frames.keys()].flatMap(name => {
    const match = /\/segment-\d+-(\d+)-\d+$/.exec(name);
    return match ? [Number(match[1])] : [];
  })) : -1;
  for (const [name, value] of frames) {
    const frame = /\/segment-(\d+)-(\d+)-(\d+)$/.exec(name);
    if (!frame) continue;
    const [ordinal, batch, part] = frame.slice(1).map(Number);
    if (newestOnly && batch !== latest) continue;
    const text = await decryptFromKV(value.slice(3), key, JSON.stringify([context, ordinal, batch, part]));
    const parts = batches.get(batch) ?? [];
    parts.push({ part, bytes: Buffer.from(text, 'base64') }); batches.set(batch, parts);
  }
  const records: Array<{ stage: string; value: unknown }> = [];
  for (const parts of batches.values()) {
    try { records.push(...JSON.parse(Buffer.concat(parts.sort((a, b) => a.part - b.part).map(part => part.bytes)).toString('utf8'))); }
    catch { /* An unfinished frame is not evidence of a persisted record. */ }
  }
  return records;
}

it('persists each large history page before reading the next and reconstructs every original record', () => fixture(async f => {
  f.authority.observationLoggingEnabled = true;
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(historyCaptureId);
  const retained = new Map<string, { text: string }>(Array.from({ length: 260 }, (_, index) => [
    `dispatcher:diagnostics:retained:${String(index).padStart(3, '0')}`,
    { text: `SYNTHETIC_HISTORY_${index}_秘密` + 'x'.repeat(8192) },
  ] as const));
  for (const [key, value] of retained) await f.native.storage.put(key, value);
  const list = f.native.storage.list.bind(f.native.storage);
  const persisted = new Set<string>();
  const checkBackpressure = async (options: { prefix?: string; startAfter?: string } = {}) => {
    if (options.prefix !== 'dispatcher:' || !options.startAfter || persisted.has(options.startAfter)) return;
    const records = await storedHistoryFrames(f, list, true);
    expect(records).toContainEqual({ stage: 'application-execution-runtime',
      value: [[options.startAfter, retained.get(options.startAfter)]] });
    persisted.add(options.startAfter);
  };
  vi.spyOn(f.native.storage, 'list').mockImplementation((async (options?: { prefix?: string; startAfter?: string; limit?: number }) => {
    await checkBackpressure(options); return list(options);
  }) as typeof f.native.storage.list);
  const transaction = f.native.storage.transaction.bind(f.native.storage);
  vi.spyOn(f.native.storage, 'transaction').mockImplementation((async (work: (tx: DurableObjectTransaction) => Promise<unknown>) => transaction(tx => work(new Proxy(tx, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (property === 'list') return async (options: { prefix?: string; startAfter?: string }) => {
        await checkBackpressure(options); return value.call(object, options);
      };
      return typeof value === 'function' ? value.bind(object) : value;
    },
  })))) as typeof f.native.storage.transaction);
  expect(await f.activity.readApplicationExecutionFacts(f.authority)).toMatchObject({ status: 'never-started' });
  const storage = await createOwnerRawCaptureStorage(f.environment, f.native.storage, async () => {});
  const archive = await readRawCapture({ storage, binding: historyCaptureBinding(f) });
  expect(archive.status).toBe('complete');
  expect(new Map(archive.records.filter(record => record.stage === 'application-execution-runtime')
    .flatMap(record => record.value as Array<[string, unknown]>))).toEqual(retained);
  expect(await f.native.storage.get('admission')).toEqual(f.state);
  expect(f.unsafe).toEqual([]);
}), 30_000);

it.each(['lease', 'effect', 'diagnostic'] as const)('a concurrent %s invalidates capture correlation without changing independent proof rules', kind => fixture(async f => {
  f.authority.observationLoggingEnabled = true;
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(historyCaptureId);
  const list = f.native.storage.list.bind(f.native.storage);
  let inserted = false;
  const key = kind === 'lease' ? 'dispatcher:lease' : kind === 'effect'
    ? 'dispatcher:operation:concurrent' : 'dispatcher:diagnostics:concurrent';
  const evidence = kind === 'lease' ? { generation: 1, status: 'unknown' }
    : kind === 'effect' ? { generation: 1, phase: 'unknown', request: { method: 'POST', url: 'https://api.github.com/synthetic' } }
      : { stage: 'observed', value: 'SYNTHETIC_DIAGNOSTIC' };
  vi.spyOn(f.native.storage, 'list').mockImplementation((async (options?: { prefix?: string; startAfter?: string; limit?: number }) => {
    const page = await list(options);
    if (!inserted && options?.prefix === 'dispatcher:') {
      inserted = true; await f.native.storage.put(key, evidence);
    }
    return page;
  }) as typeof f.native.storage.list);
  const facts = await f.activity.readApplicationExecutionFacts(f.authority);
  if (kind === 'diagnostic') expect(facts).toMatchObject({ status: 'never-started' });
  else expect(facts).toEqual({ status: 'unavailable' });
  const storage = await createOwnerRawCaptureStorage(f.environment, f.native.storage, async () => {});
  expect((await readRawCapture({ storage, binding: historyCaptureBinding(f) })).status).toBe('incomplete');
  expect(await f.native.storage.get(key)).toEqual(evidence);
  expect(await f.native.storage.get('admission')).toEqual(f.state);
  expect(await f.native.storage.get('prospective-retirement')).toBeUndefined();
  expect(f.unsafe).toEqual([]);
}));

it('retains complete supported large responses without exceeding the source live-payload allowance', () => fixture(async f => {
  f.authority.observationLoggingEnabled = true;
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(historyCaptureId);
  const body = 'x'.repeat(1024 * 1024 - 128) + '終';
  const retained = new Map(Array.from({ length: 3 }, (_, index) => [
    `dispatcher:response:large-${index}`, { status: 200, body, contentType: 'text/plain' },
  ] as const));
  for (const [key, value] of retained) await f.native.storage.put(key, value);
  // Model a producer whose supported values fit individually but whose live
  // returned payload allowance does not permit buffering several at once.
  const cached = new Map<string, number>();
  const bounded = async (read: () => Promise<Map<string, unknown>>, options?: { prefix?: string; noCache?: boolean }) => {
    const page = await read();
    if (options?.prefix === 'dispatcher:') {
      let pageBytes = 0;
      for (const [key, value] of page) {
        const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
        pageBytes += size;
        if (!options.noCache) cached.set(key, size);
      }
      const liveBytes = Math.max(pageBytes, [...cached.values()].reduce((total, size) => total + size, 0));
      if (liveBytes > 1200 * 1024) throw new Error('Synthetic source live-payload allowance exceeded');
    }
    return page;
  };
  const list = f.native.storage.list.bind(f.native.storage);
  vi.spyOn(f.native.storage, 'list').mockImplementation((async (options?: { prefix?: string; startAfter?: string; limit?: number; noCache?: boolean }) =>
    bounded(() => list(options), options)) as typeof f.native.storage.list);
  const transaction = f.native.storage.transaction.bind(f.native.storage);
  vi.spyOn(f.native.storage, 'transaction').mockImplementation((async (work: (tx: DurableObjectTransaction) => Promise<unknown>) =>
    transaction(tx => work(new Proxy(tx, { get(object, property) {
      const value = Reflect.get(object, property, object);
      if (property === 'list') return (options?: { prefix?: string; noCache?: boolean }) => bounded(() => value.call(object, options), options);
      return typeof value === 'function' ? value.bind(object) : value;
    } })))) as typeof f.native.storage.transaction);
  // A cached response is not proof that execution never started. Its refusal
  // does not excuse dropping or truncating the available private evidence.
  expect(await f.activity.readApplicationExecutionFacts(f.authority)).toEqual({ status: 'unavailable' });
  const storage = await createOwnerRawCaptureStorage(f.environment, f.native.storage, async () => {});
  const archive = await readRawCapture({ storage, binding: historyCaptureBinding(f) });
  expect(archive.status).toBe('complete');
  expect(new Map(archive.records.filter(record => record.stage === 'application-execution-runtime')
    .flatMap(record => record.value as Array<[string, unknown]>))).toEqual(retained);
  expect(await f.native.storage.get('admission')).toEqual(f.state);
  expect(f.unsafe).toEqual([]);
}), 30_000);

/** REQ-OPERATOR-048: the retained Root delivery proof, not the application row,
 * establishes settlement and exclusion of its original SDK submission. */
async function settledDelivery(f: Fixture) {
  const submissionId = 'settled-target-submission';
  const deliveryDigest = createHash('sha256').update('settled-target-token').digest('hex');
  const origin = { submissionId, uid: 'original-sdk-uid', deliveryDigest };
  const proof = { version: 1, activityId: f.activityId, ownerKey: f.state.ownerKey,
    generation: 1, artifactDigest: f.context.artifactDigest, inputDigest: f.receipt.intentDigest,
    receipt: { submissionId, uid: origin.uid, acceptedAt: new Date(Date.now() - 2000).toISOString() },
    delivery: { digest: deliveryDigest, ordinal: 2 }, terminalAt: Date.now() - 1,
    outcome: 'failed', noExternalWrites: true };
  const key = `dispatcher:application-delivery:1:${createHash('sha256').update(submissionId).digest('hex')}`;
  const state = { ...structuredClone(f.state), browserCollectionConsumed: false,
    drive: { generation: 1, status: 'running', checkpoint: { later: 'unfinished' }, result: null } };
  const { serial: _serial, ...profile } = f.profile;
  const lease = { ...profile, status: 'running', submissionId: 'later-target-submission',
    receipt: { submissionId: 'later-target-submission', uid: origin.uid, acceptedAt: new Date().toISOString() },
    application: { version: 1, initialData: {}, checkpoint: {}, context: {}, planned: true,
      delivery: { token: 'later-target-token', ordinal: 3 }, idempotencyKey: 'later-key' } };
  await f.native.storage.put({ admission: state, 'dispatcher:lease': lease, [key]: proof });
  return { key, proof, state, lease,
    authority: { ...f.authority, original: { ...f.authority.original, delivery: origin } } };
}

describe('Root-owned individual delivery facts', () => {
  it.each(['running', 'failed', 'unknown', 'pending-plan'] as const)(
    'REQ-OPERATOR-048: a settled target remains provable while its unrelated run is %s and uncollected', later => fixture(async f => {
      const saved = await settledDelivery(f);
      const state = saved.state as Record<string, any>, lease = saved.lease as Record<string, any>;
      if (later === 'pending-plan') {
        lease.submissionId = saved.proof.receipt.submissionId; lease.receipt = saved.proof.receipt;
        lease.application.delivery = { token: 'settled-target-token', ordinal: 2 };
        lease.application.pending = { delivery: { token: 'later-target-token', ordinal: 3 }, idempotencyKey: 'next-key',
          confirmed: { delivery: lease.application.delivery, settlement: { receipt: lease.receipt, status: 'failed', data: {} } } };
      } else state.drive.status = later;
      await f.native.storage.put({ admission: state, 'dispatcher:lease': lease,
        'dispatcher:journal': { generation: 1, count: 1, nextOrdinal: 1, unresolved: 1 },
        'dispatcher:operation:1:later-write': { generation: 1, ordinal: 0, phase: 'unknown', requestDigest: 'a'.repeat(64),
          deliveryBinding: { resource: 'fetch', submissionId: 'later-target-submission', deliveryToken: 'later-target-token' },
          request: { method: 'POST', url: 'https://api.github.com/repos/acme/updates/issues/2/comments' } } });
      const before = await f.native.storage.list();
      expect(await f.activity.readApplicationExecutionFacts(saved.authority)).toMatchObject({ status: 'delivery',
        activityId: f.activityId, generation: 1, releaseDigest: f.context.artifactDigest,
        inputDigest: f.receipt.intentDigest, sdkSubmissionId: saved.proof.receipt.submissionId,
        terminalAt: saved.proof.terminalAt, settled: true, fenced: true, outcome: 'failed', noExternalWrites: true });
      expect(await f.native.storage.list()).toEqual(before);
      expect(await f.registry.getManagementAdmission(f.activityId)).toEqual(f.receipt);
      expect(f.unsafe).toEqual([]);
    }));

  it('REQ-OPERATOR-048: reports source writes rather than inventing safe retry from a settled delivery', () => fixture(async f => {
    const saved = await settledDelivery(f);
    await f.native.storage.put(saved.key, { ...saved.proof, noExternalWrites: false });
    expect(await f.activity.readApplicationExecutionFacts(saved.authority)).toMatchObject({ status: 'delivery',
      settled: true, fenced: true, noExternalWrites: false });
    expect(f.unsafe).toEqual([]);
  }));

  it.each(['missing', 'foreign-owner', 'foreign-generation', 'foreign-artifact', 'foreign-input',
    'foreign-submission', 'foreign-uid', 'foreign-token', 'future-terminal', 'unfenced', 'missing-ledger'] as const)(
    'REQ-OPERATOR-048: %s delivery evidence cannot authorize a retry or disclose another result', name => fixture(async f => {
      const saved = await settledDelivery(f), proof = saved.proof as Record<string, any>;
      if (name === 'foreign-owner') proof.ownerKey = 'e'.repeat(64);
      if (name === 'foreign-generation') proof.generation = 2;
      if (name === 'foreign-artifact') proof.artifactDigest = 'e'.repeat(64);
      if (name === 'foreign-input') proof.inputDigest = 'e'.repeat(64);
      if (name === 'foreign-submission') proof.receipt.submissionId = 'another-submission';
      if (name === 'foreign-uid') proof.receipt.uid = 'another-incarnation';
      if (name === 'foreign-token') proof.delivery.digest = 'e'.repeat(64);
      if (name === 'future-terminal') proof.terminalAt = Date.now() + 60_000;
      if (name === 'unfenced') await f.native.storage.put('dispatcher:lease', { ...saved.lease,
        application: { ...saved.lease.application, delivery: { token: 'settled-target-token', ordinal: 2 } } });
      if (name === 'missing-ledger') saved.authority.ledger = { ok: false };
      if (name === 'missing') await f.native.storage.delete(saved.key);
      else await f.native.storage.put(saved.key, proof);
      const before = await f.native.storage.list();
      expect(await f.activity.readApplicationExecutionFacts(saved.authority)).toEqual({ status: 'unavailable' });
      expect(await f.native.storage.list()).toEqual(before);
      expect(f.unsafe).toEqual([]);
    }));
});

describe('source-proven historical recovery formats', () => {
  it.each(['empty', 'read', 'write', 'unresolved', 'missing-ordinal', 'mixed-records'] as const)(
    'REQ-OPERATOR-210 AC3: %s legacy aggregate is decoded read-only without inventing a modern journal', name => fixture(async f => {
      const operations = name === 'empty' ? {} : { original: { generation: 1, ordinal: 0,
        phase: name === 'unresolved' ? 'unknown' : 'completed', requestDigest: 'a'.repeat(64),
        request: { method: name === 'write' ? 'POST' : 'GET', url: 'https://api.github.com/repos/acme/updates' } } };
      if (name === 'missing-ordinal') delete (operations as Record<string, any>).original.ordinal;
      await f.native.storage.put({ 'dispatcher:lease': { ...f.profile, status: 'unknown', submissionId: 'old-sdk-submission' },
        'dispatcher:operations': operations,
        ...(name === 'mixed-records' ? { 'dispatcher:operation:1:other': { generation: 1, ordinal: 1,
          phase: 'completed', requestDigest: 'b'.repeat(64), request: { method: 'GET', url: 'https://api.github.com/repos/acme/other' } } } : {}) });
      const before = await f.native.storage.list();
      const result = await f.activity.readRecoveryFacts({ human: f.authority.current.human,
        deadline: f.authority.current.deadline, original: f.authority.original, ledger: f.authority.ledger });
      expect(result.resettable).toBe(name === 'empty' || name === 'read');
      if (result.resettable) expect(result).toMatchObject({ reason: 'fenced-no-write', origin: { generation: 1 } });
      expect(await f.native.storage.list()).toEqual(before);
      expect(f.unsafe).toEqual([]);
    }));

  it.each(['complete', 'missing-attempt', 'duplicate-charge', 'foreign-generation', 'orphan-response'] as const)(
    'REQ-OPERATOR-210 AC3: %s charged model attempts require complete original ordinal and cache accounting', name => fixture(async f => {
      const firstBody = JSON.stringify({ error: { type: 'server_error' } });
      const finalBody = JSON.stringify({ choices: [{ finish_reason: 'stop' }] });
      const firstKey = 'dispatcher:inference-attempt:1:model:1';
      const secondKey = 'dispatcher:inference-attempt:1:model:2';
      const operation = { generation: 1, ordinal: 0, phase: 'completed', requestDigest: 'a'.repeat(64),
        responseDigest: createHash('sha256').update(finalBody).digest('hex'),
        deliveryBinding: { resource: 'inference', submissionId: 'old-sdk-submission', deliveryToken: 'old-token' },
        inference: { version: 1, attempt: 2 } };
      await f.native.storage.put({ 'dispatcher:lease': { ...f.profile, status: 'unknown', submissionId: 'old-sdk-submission' },
        'dispatcher:journal': { generation: 1, count: 2, nextOrdinal: 2, unresolved: 0 },
        'dispatcher:operation:1:model': operation,
        [firstKey]: { index: 1, ordinal: 0, phase: 'completed', notBefore: 0, successor: 2, classification: 'retryable',
          responseKey: `${firstKey}:response`, responseDigest: createHash('sha256').update(firstBody).digest('hex') },
        [secondKey]: { index: 2, ordinal: name === 'duplicate-charge' ? 0 : 1, phase: 'completed', notBefore: 0,
          classification: 'usable', responseKey: 'dispatcher:response:model', responseDigest: operation.responseDigest },
        [`${firstKey}:response`]: { status: 503, contentType: 'application/json', body: firstBody },
        'dispatcher:response:model': { status: 200, contentType: 'application/json', body: finalBody },
        ...(name === 'orphan-response' ? { 'dispatcher:inference-attempt:1:other:1:response': { body: 'unbound' } } : {}) });
      if (name === 'missing-attempt') await f.native.storage.delete(firstKey);
      if (name === 'foreign-generation') {
        await f.native.storage.put('dispatcher:inference-attempt:2:model:1', await f.native.storage.get(firstKey));
        await f.native.storage.delete(firstKey);
      }
      const before = await f.native.storage.list();
      const result = await f.activity.readRecoveryFacts({ human: f.authority.current.human,
        deadline: f.authority.current.deadline, original: f.authority.original, ledger: f.authority.ledger });
      expect(result.resettable).toBe(name === 'complete');
      expect(await f.native.storage.list()).toEqual(before);
      expect(f.unsafe).toEqual([]);
    }));

  it.each([true, false])('REQ-OPERATOR-210 AC3: legacy missing admission requires a committed non-start retirement, retired=%s', retired => fixture(async f => {
    await f.native.storage.delete('admission');
    await f.setLedger();
    f.authority.original.pins = null;
    f.authority.ledger = { ok: true, receipt: null };
    if (retired) {
      const original = await f.activity.readApplicationExecutionFacts(f.authority);
      if (original.status !== 'never-started') throw Error('Missing verified original non-admission proof');
      expect(await f.activity.retireApplicationExecution({ ...f.authority, proofVersion: original.proofVersion }))
        .toMatchObject({ status: 'retired', activityId: f.activityId });
    }
    const before = await f.native.storage.list();
    const result = await f.activity.readRecoveryFacts({ human: f.authority.current.human,
      deadline: f.authority.current.deadline, original: f.authority.original, ledger: f.authority.ledger });
    expect(result.resettable).toBe(retired);
    if (result.resettable) expect(result.reason).toBe('never-started');
    expect(await f.native.storage.list()).toEqual(before);
    expect(f.unsafe).toEqual([]);
  }));
});

it('REQ-OPERATOR-210: equivalent audience order keeps original owner binding without rewriting retained identity', () => fixture(async f => {
  const human = { ...f.authority.current.human, audiences: ['audience', 'second-audience'] };
  const context = await createOperatorExecutionContext({ activityId: f.activityId, operatorId: 'dispatcher',
    artifactDigest: f.context.artifactDigest, policyDigest: f.context.policyDigest, human, accessJwt: 'z-jwt' }, f.environment);
  const ownerKey = await operatorOwnerKey(human);
  const state = { ...f.state, ownerKey, executionContext: context };
  const authority = { ...f.authority,
    current: { ...f.authority.current, human: { ...human, audiences: [...human.audiences].reverse() }, ownerKey },
    original: { ...f.authority.original, ownerKey, owner: { ...context.owner, audiences: [...context.owner.audiences].reverse() } } };
  await f.native.storage.put('admission', state);
  const before = await f.native.storage.list();
  expect(await f.activity.readApplicationExecutionFacts(authority)).toMatchObject({ status: 'never-started', activityId: f.activityId });
  expect(await f.native.storage.list()).toEqual(before);
  expect(f.unsafe).toEqual([]);
}));
