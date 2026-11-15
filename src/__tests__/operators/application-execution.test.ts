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
  await runInDurableObject(registryNamespace.getByName(`execution-ledger-${crypto.randomUUID()}`), async (_registry, registryNative) => {
    const activityId = `execution-${crypto.randomUUID()}`;
    await runInDurableObject(activityNamespace.getByName(activityId), async (_activity, native) => {
      await run(await seed(registryNative, native, activityNamespace, activityId));
    });
  });
}
async function seed(registryNative: DurableObjectState, native: DurableObjectState,
  namespace: DurableObjectNamespace, activityId: string) {
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
  const registry = new OperatorRegistry(registryNative, environment);
  const activity = new OperatorActivity(native, environment);
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
  } as ManagementExecutionSelection;
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
  registryNative.storage.sql.exec('INSERT INTO operator_admissions VALUES(?,?)', activityId, JSON.stringify(receipt));
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
  return { activity, native, registry, registryNative, activityId, authority, state, profile, receipt,
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
        f.registryNative.storage.sql.exec('UPDATE operator_admissions SET data=? WHERE activity_id=?', JSON.stringify(state.receipt), f.activityId);
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
      f.registryNative.storage.sql.exec('DELETE FROM operator_admissions WHERE activity_id=?', f.activityId);
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
        f.registryNative.storage.sql.exec('DELETE FROM operator_admissions WHERE activity_id=?', f.activityId);
        f.authority.ledger = { ok: true, receipt: await f.registry.getManagementAdmission(f.activityId) };
      }
      if (name === 'ledger-mismatch' || name === 'legacy-full-ledger-mismatch') {
        f.registryNative.storage.sql.exec('UPDATE operator_admissions SET data=? WHERE activity_id=?',
          JSON.stringify({ ...f.receipt, intentDigest: 'f'.repeat(64) }), f.activityId);
        f.authority.ledger = { ok: true, receipt: await f.registry.getManagementAdmission(f.activityId) };
      }
      if (name === 'orphan-effect') await f.native.storage.put('dispatcher:operation:orphan', { phase: 'unknown' });
      if (name === 'orphan-lease') await f.native.storage.put('dispatcher:lease', { generation: 1, status: 'unknown' });
      if (name === 'orphan-publication') await f.native.storage.put('renovate:publication', { effects: { comment: { phase: 'unknown' } } });
      if (name === 'owned-session') await f.native.storage.put('ownedSession', { sessionId: 'zsession01' });
      if (name === 'expired') f.authority.current.deadline = Date.now() - 1;
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
      if (name === 'expired') f.authority.current.deadline = Date.now() - 1;
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
async function storedHistoryFrames(f: Fixture, list: typeof f.native.storage.list = f.native.storage.list.bind(f.native.storage)) {
  const binding = historyCaptureBinding(f);
  const context = JSON.stringify(['codeflare-operator-raw-v1', binding.ownerKey, binding.installationId,
    binding.releaseId, binding.captureId, 'activity', f.activityId, 2]);
  const prefix = `operator-raw:v1:${createHash('sha256').update(context).digest('hex')}/`;
  const key = (await getOrImportKey(f.environment))!;
  const batches = new Map<number, Array<{ part: number; bytes: Buffer }>>();
  for (const [name, value] of await list<string>({ prefix })) {
    const frame = /\/segment-(\d+)-(\d+)-(\d+)$/.exec(name);
    if (!frame) continue;
    const [ordinal, batch, part] = frame.slice(1).map(Number);
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
  const retained = new Map(Array.from({ length: 260 }, (_, index) => [
    `dispatcher:diagnostics:retained:${String(index).padStart(3, '0')}`,
    { text: `SYNTHETIC_HISTORY_${index}_秘密` + 'x'.repeat(8192) },
  ] as const));
  for (const [key, value] of retained) await f.native.storage.put(key, value);
  const list = f.native.storage.list.bind(f.native.storage);
  const checkBackpressure = async (options: { prefix?: string; startAfter?: string } = {}) => {
    if (options.prefix !== 'dispatcher:' || !options.startAfter) return;
    const records = await storedHistoryFrames(f, list);
    expect(records).toContainEqual({ stage: 'application-execution-runtime',
      value: [[options.startAfter, retained.get(options.startAfter)]] });
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
