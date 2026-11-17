/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, reset, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry, type ProspectiveAdmission } from '../../operators/registry';
import { applicationRecoveryPrefix, recoveryDigest, type RecoveryFacts } from '../../operators/application-recovery';
import { operatorOwnerKey } from '../../operators/browser-activity';
import { sealOperatorSecret } from '../../operators/protected-secrets';
import type { Env } from '../../types';
import { getBucketName } from '../../lib/access';
import type { RuntimeApplicationStateBinding } from '../../operators/application-workflow';

// Additive internal proof contract under test; old manually recoverable facts
// may omit closure time. Production types are updated only in GREEN.
type TestRecoveryFacts = Exclude<RecoveryFacts, { resettable: true }>
  | (Omit<Extract<RecoveryFacts, { resettable: true }>, 'origin'> & {
    origin: { generation: number; deadline: number; terminalAt?: number };
  });

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
async function fixture(run: (f: Awaited<ReturnType<typeof seed>>) => Promise<void>) {
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_, state) => run(await seed(state)));
}
async function seed(state: DurableObjectState) {
  const human = { subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test', audiences: ['aud'],
    issuedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  const ownerKey = await operatorOwnerKey(human);
  const grant = { users: [human.email], groups: [] };
  const policy = { capabilities: ['fetch'], resourceProfileId: null };
  const connection = { installationId: 'install', releaseId: 'release', connectionRevision: 1, workerName: 'worker',
    workerVersionId: 'version', sourceCommit: 'a'.repeat(40), compilerCommit: 'b'.repeat(40),
    manifestDigest: 'c'.repeat(64), bundleDigest: 'd'.repeat(64) };
  const operator = { id: 'operator', operatorId: 'operator', revision: 1, repositoryId: 23, sourceRevision: 1,
    profile: 'dispatcher', realm: 'internal', policy, managers: grant, invokers: grant, githubPatCiphertext: 'not-used',
    repositoryUrl: 'https://github.com/example/operator', approvedWorkflow: { id: 1, ref: 'refs/heads/main' } };
  const installation = { id: 'install', operatorId: 'operator', revision: 1, name: 'installation', enabled: false,
    releaseId: 'release', approvedSourceRevision: 1, policy, configurationJson: JSON.stringify({ repository: 'acme/project', automaticRuns: false }),
    dispatcherConnection: connection, dispatcherConnectionVerification: { ...connection, controlOrigin: 'https://worker.example.test' },
    dispatcherConnectionSecretCiphertext: '' };
  const release = { id: 'release', operatorId: 'operator', approved: true, ...connection,
    provenance: { compilerCommit: connection.compilerCommit } };
  const controls = { revision: 1, managers: grant, ceiling: { capabilities: ['fetch'], resourceProfileIds: [] } };
  const unsafe: string[] = [];
  // Models the actual original diagnosticFence.timestamp, not an admission
  // time, deadline or time of this read.
  const terminalAt = Date.now() - 30_000;
  const facts: { value: TestRecoveryFacts } = { value: { resettable: true, reason: 'fenced-no-write', proofDigest: 'e'.repeat(64),
    origin: { generation: 1, deadline: 1, terminalAt } } };
  const deliveryFacts = { value: { status: 'delivery', activityId: 'old', generation: 1,
    releaseDigest: 'd'.repeat(64), inputDigest: 'f'.repeat(64), terminalAt: Date.now() - 1,
    sdkSubmissionId: 'PRIVATE_SUBMISSION', settled: true, fenced: true,
    noExternalWrites: true, outcome: 'failed' } };
  const environment = { ENCRYPTION_KEY: btoa('k'.repeat(32)), KV: { get: async () => JSON.stringify({ role: 'admin' }) },
    CONTAINER: { idFromName: (name: string) => name, get: () => ({ claimBucketOwner: async () => 'owned' }) },
    OPERATOR_ACTIVITY: { getByName: () => ({ readRecoveryFacts: async (request: { original: { delivery?: unknown; generation?: number } }) => {
      if (request.original.delivery) {
        if (!request.original.generation || deliveryFacts.value.status !== 'delivery') return { resettable: false, reason: 'delivery-unproven' };
        return deliveryFacts.value.noExternalWrites ? { resettable: true, reason: 'fenced-no-write', proofDigest: 'a'.repeat(64),
          origin: { generation: request.original.generation, deadline: 1, terminalAt: deliveryFacts.value.terminalAt } }
          : { resettable: false, reason: 'source-write' };
      }
      return facts.value;
    },
      readApplicationExecutionFacts: async () => deliveryFacts.value,
      readApplicationCoordinationFacts: async () => deliveryFacts.value.status === 'delivery'
        ? deliveryFacts.value.noExternalWrites
          ? { status: 'safe', outcome: deliveryFacts.value.outcome, terminalAt: deliveryFacts.value.terminalAt,
            fenced: true, noExternalWrites: true }
          : { status: 'held', reason: 'source-write' }
        : { status: 'unavailable' },
      beginDrive: () => { unsafe.push('execution'); throw Error('No execution'); } }) },
  } as unknown as Env;
  const registry = new OperatorRegistry(state, environment);
  await registry.getManagementControls();
  installation.dispatcherConnectionSecretCiphertext = await sealOperatorSecret('fixture-secret', environment, { purpose: 'connection', recordId: 'install' });
  const saveOperator = () => state.storage.sql.exec('INSERT OR REPLACE INTO operator_catalog VALUES(?,?,?,?,?,?)', 'operator', 'dispatcher', 'internal', 1, '', JSON.stringify(operator));
  saveOperator();
  state.storage.sql.exec('INSERT INTO operator_installations VALUES(?,?,?,?,?)', 'install', 'operator', 'installation', 0, JSON.stringify(installation));
  state.storage.sql.exec('INSERT INTO operator_management_controls VALUES(1,?)', JSON.stringify(controls));
  const manifest = { schemaVersion: 1, interfaceVersion: 1, id: 'operator', name: 'Operator', description: '', coreVersion: '1', intentVersion: '1',
    inputSchema: {}, requiredCapabilities: ['fetch'], artifact: { path: '/bundle', sha256: connection.bundleDigest },
    application: { controlVersion: 1, recovery: { label: 'Recover', description: 'Recover old work', prefix: 'opaque:' } } };
  state.storage.sql.exec('INSERT INTO operator_releases VALUES(?,?,?,?)', 'release', 'operator', JSON.stringify(release), JSON.stringify(manifest));
  const prefix = await applicationRecoveryPrefix('23');
  const key = 'opaque:scope:one';
  const storageKey = `${prefix}${await recoveryDigest(key)}`;
  const original = { schemaVersion: 1, sourceId: '23', ownerKey, installationId: 'install', activityId: 'old', generation: 1, deadline: 1,
    key, legacy: null, value: { original: 'PRIVATE_HISTORY' } };
  const ledger = structuredClone({ installationId: 'install', activityId: 'old', expectedOperatorRevision: 1, expectedInstallationRevision: 1,
    expectedControlsRevision: 1, selection: { operator, installation, release } });
  await state.storage.put(storageKey, original);
  state.storage.sql.exec('INSERT INTO operator_admissions VALUES(?,?)', 'old', JSON.stringify(ledger));
  const callback: { alter?: () => Promise<void>; malformed?: boolean; declineKey?: string;
    scopeAnchor?: string | null; scopePrefix?: string; resetValue?: unknown; records: unknown[] } = { records: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) !== 'https://worker.example.test/control/recovery') { unsafe.push('SDK-runtime'); throw Error('Forbidden endpoint'); }
    const body = JSON.parse(String(init?.body));
    callback.records.push(...body.records);
    expect(body.records.length).toBeLessThanOrEqual(64);
    if (callback.alter) { const action = callback.alter; callback.alter = undefined; await action(); }
    if (callback.malformed) return Response.json({ items: [{ key: 'foreign', label: 'foreign', disposition: 'reset', reason: 'invalid' }] });
    const scopeAnchor = callback.scopeAnchor === undefined ? body.records[0]
      : body.records.find((record: { key: string }) => record.key === callback.scopeAnchor);
    return Response.json(body.operation === 'scope' ? { ...(scopeAnchor
      ? { scope: { prefix: callback.scopePrefix ?? 'opaque:scope:', anchorKey: scopeAnchor.key } } : {}), items: [] }
      : { items: body.records.map((record: { key: string }) => record.key === callback.declineKey
        ? { key: record.key, label: 'Preserved record', disposition: 'skip', reason: 'Already processed' }
        : { key: record.key, label: 'Owned record', disposition: 'reset', reason: 'owner-reset', value: callback.resetValue === undefined ? { reset: true } : callback.resetValue }) });
  });
  const base = { installationId: 'install', revision: 1, human, platformAdmin: false,
    authority: { operatorRevision: 1, controlsRevision: 1, expiresAt: human.expiresAt * 1000 } };
  const preview = (after?: string) => registry.recoverApplication({ ...base, operation: 'preview', after }) as Promise<{
    items: Array<{ key: string; version: string; status: string }>; nextCursor: string | null; scopeCursor?: string }>;
  const resetRequest = async () => {
    let page = await preview();
    while (!page.items.length && page.nextCursor) page = await preview(page.nextCursor);
    return { ...base, operation: 'reset' as const, requestId: crypto.randomUUID(), scopeCursor: page.scopeCursor,
      entries: page.items.map(({ key, version }) => ({ key, version })) };
  };
  return { registry, state, base, preview, resetRequest, callback, original, ledger, installation, operator, facts, saveOperator, storageKey, unsafe, prefix,
    manifest, environment, deliveryFacts, terminalAt, controls };
}

type StateEntry = { key: string; status: 'absent'; version: null }
  | { key: string; status: 'vacant'; version: string }
  | { key: string; status: 'value'; version: string; value: unknown }
  | { key: string; status: 'coordination'; version: string; coordination: unknown }
  | { key: string; status: 'conflict' };

// Use the actual Registry recovery transaction and state adapter. Only the
// established functional-facts service is stubbed: it proves fenced no-write,
// not owner permission. In particular, the old owner's alias remains present.
async function headFixture(run: (f: Awaited<ReturnType<typeof seedHead>>) => Promise<void>) {
  return fixture(async base => run(await seedHead(base)));
}
async function seedHead(f: Awaited<ReturnType<typeof seed>>) {
  const other = { ...f.base.human, subject: 'other-owner', email: 'other@example.test' };
  const third = { ...f.base.human, subject: 'third-owner', email: 'third@example.test' };
  f.operator.invokers = { users: [f.base.human.email, other.email, third.email], groups: [] };
  f.operator.managers = { users: [...f.operator.invokers.users], groups: [] };
  // Management requires both deployment eligibility and the operator grant.
  f.controls.managers = { users: [...f.operator.managers.users], groups: [] };
  f.state.storage.sql.exec('UPDATE operator_management_controls SET data=? WHERE id=1', JSON.stringify(f.controls));
  f.saveOperator();
  f.installation.enabled = true;
  f.state.storage.sql.exec('UPDATE operator_installations SET data=? WHERE id=?', JSON.stringify(f.installation), 'install');
  f.manifest.application.recovery.prefix = 'renovate:head:';
  // The existing package selector, not a request field, declares the shared
  // work repository. Generic fixtures without this opt-in remain private.
  Object.assign(f.manifest.application, { githubWriteRepositoriesPath: '/repository' });
  f.state.storage.sql.exec('UPDATE operator_releases SET manifest=? WHERE id=?', JSON.stringify(f.manifest), 'release');
  f.callback.scopePrefix = 'renovate:head:44:';
  f.callback.resetValue = { state: 'reset', activityId: 'old', private: 'PRIVATE_RESET' };
  await f.state.storage.delete(f.storageKey);
  const head = 'b'.repeat(40), key = `renovate:head:44:17:${head}`;
  const aliasKey = `renovate-admission:44:17:${head}`;
  const legacy = { activityId: 'old', installationId: 'install', ownerKey: f.original.ownerKey,
    repositoryId: 44, repository: 'acme/project', baseBranch: 'main', pullRequest: 17, head,
    createdAt: '2026-11-01T00:00:00Z', activatedAt: '2026-11-01T00:00:00Z',
    operatorRevision: 1, installationRevision: 1, controlsRevision: 1,
    releaseId: 'release', bundleDigest: 'd'.repeat(64), private: 'PRIVATE_HISTORY',
    actor: { registrationId: 'old-registration', bucket: getBucketName(f.base.human.email),
      sessionId: 'old-session', sessionGeneration: 1, subject: f.base.human.subject,
      issuer: f.base.human.issuer, email: f.base.human.email, audiences: f.base.human.audiences } } satisfies ProspectiveAdmission & { private: string };
  const legacyCoordination = { kind: 'legacy-admission', repositoryId: 44, pullRequest: 17, head,
    createdAt: legacy.createdAt, activatedAt: legacy.activatedAt, repository: legacy.repository, baseBranch: legacy.baseBranch };
  const original = { ...f.original, key, value: legacy,
    legacy: { storageKey: aliasKey, version: await recoveryDigest(JSON.stringify(legacy)) } };
  const storageKey = `${f.prefix}${await recoveryDigest(key)}`;
  await f.state.storage.put({ [storageKey]: original, [aliasKey]: legacy, 'renovate-activity:old': legacy });
  const live = async (human: RuntimeApplicationStateBinding['human'], activityId: string): Promise<RuntimeApplicationStateBinding> => {
    const deadline = Math.floor(Date.now() / 1000) * 1000 + 60_000;
    const intentDigest = await recoveryDigest(activityId);
    expect(await f.registry.admitManagement({ installationId: 'install', activityId, intentDigest, deadline,
      expectedInstallationRevision: f.installation.revision, expectedOperatorRevision: 1, expectedControlsRevision: 1 })).toMatchObject({ ok: true });
    const ownerKey = await operatorOwnerKey(human);
    await f.state.storage.put(`owner-activity:${ownerKey}:${activityId}`, { operatorId: 'operator', executionStatus: 'running' });
    return { principal: 'operator', sourceId: '23', sourceRepositoryId: 23, installationId: 'install',
      ownerKey, human, activityId, generation: 2, deadline, operatorId: 'operator', releaseId: 'release',
      bundleDigest: 'd'.repeat(64), installationRevision: f.installation.revision, operatorRevision: 1, controlsRevision: 1,
      intentDigest, deliveryToken: `delivery-${activityId}` };
  };
  const a = await live(f.base.human, 'new-a'), b = await live(other, 'new-b'), c = await live(third, 'new-c');
  const read = async (binding: RuntimeApplicationStateBinding): Promise<StateEntry> => {
    const response = await f.registry.applyApplicationState(binding, { operation: 'read', keys: [key] }) as { entries?: StateEntry[] };
    expect(response).toHaveProperty('entries');
    expect(response.entries).toHaveLength(1);
    return response.entries![0];
  };
  const cas = (binding: RuntimeApplicationStateBinding, version: string | null, value: unknown, coordination?: unknown) =>
    f.registry.applyApplicationState(binding, { operation: 'compare-exchange', expected: [{ key, version }],
      writes: [{ key, value, ...(coordination === undefined ? {} : { coordination }) }] });
  const execution = (binding: RuntimeApplicationStateBinding, operation: 'read-coordination' | 'release-coordination', version: string) =>
    f.registry.applyApplicationExecution(binding, { operation, key, version } as unknown as Parameters<OperatorRegistry['applyApplicationExecution']>[1]);
  const publish = async (coordination: unknown = { state: 'active' }, originDelivery?: RuntimeApplicationStateBinding['originDelivery']) => {
    const binding = originDelivery ? { ...a, originDelivery } : a;
    const entry = await read(binding);
    if (entry.status !== 'value') throw Error('Expected owner state before publishing');
    expect(await cas(binding, entry.version, entry.value, coordination)).toEqual({ status: 'committed' });
    Object.assign(f.deliveryFacts.value, { activityId: binding.activityId, generation: binding.generation,
      inputDigest: binding.intentDigest });
    if (f.facts.value.resettable) f.facts.value.origin = { ...f.facts.value.origin, generation: binding.generation, deadline: binding.deadline };
    return await stateRecord();
  };
  const stateRecord = () => f.state.storage.get<Record<string, unknown>>(storageKey);
  const history = async () => ({
    alias: await f.state.storage.get(aliasKey), activity: await f.state.storage.get('renovate-activity:old'),
    ledger: await f.registry.getManagementAdmission('old'), facts: structuredClone(f.facts.value),
    originals: await f.state.storage.list({ prefix: `${f.prefix}original:` }),
    audits: await f.state.storage.list({ prefix: `${f.prefix}audit:` }),
  });
  return { ...f, original, storageKey, key, aliasKey, legacy, legacyCoordination, a, b, c, live, read, cas, execution, publish, history };
}

async function refusedState(response: unknown, key: string) {
  // Corrupt evidence may be opaque conflict or unavailable, never a vacant/value
  // record, nor an error containing the old owner's private bytes or identity.
  expect([
    JSON.stringify({ entries: [{ key, status: 'conflict' }] }),
    JSON.stringify({ error: { status: 503, code: 'application-state-unavailable' } }),
    JSON.stringify({ error: { status: 403, code: 'application-state-denied' } }),
  ]).toContain(JSON.stringify(response));
}

describe('real Registry recovery transaction', () => {
  it('resets a disabled approved installation, preserves origin/settings/ledger and replays without rewriting', () => fixture(async f => {
    const request = await f.resetRequest();
    expect(await f.registry.recoverApplication(request)).toEqual({ requestId: request.requestId, reset: 1, skipped: [] });
    expect(await f.state.storage.get(f.storageKey)).toMatchObject({ ...f.original, value: { reset: true } });
    const audits = await f.state.storage.list<{ originalKey: string; originalVersion: string }>({ prefix: `${f.prefix}audit:` });
    const audit = [...audits.values()][0];
    expect(audit.originalVersion).toBe(request.entries[0].version);
    expect(await f.state.storage.get(audit.originalKey)).toEqual(f.original);
    expect(await f.registry.getManagementAdmission('old')).toEqual(f.ledger);
    expect(await f.registry.getManagementInstallation('install')).toMatchObject({ ok: true, value: {
      enabled: false, configurationJson: f.installation.configurationJson, revision: 1 } });
    const after = await f.state.storage.list();
    expect(await f.registry.recoverApplication(request)).toEqual({ requestId: request.requestId, reset: 1, skipped: [] });
    expect(await f.state.storage.list()).toEqual(after);
    await expect(f.registry.recoverApplication({ ...request, entries: [{ key: f.original.key, version: 'f'.repeat(64) }] })).rejects.toThrow('conflict');
    expect(f.unsafe).toEqual([]);
  }));
  it('older same-owner audit without originalOwnerHash still verifies its retained vacancy', () => headFixture(async f => {
    await f.registry.recoverApplication(await f.resetRequest());
    const audits = await f.state.storage.list<Record<string, unknown>>({ prefix: `${f.prefix}audit:` });
    for (const [key, audit] of audits) {
      const { originalOwnerHash: _newField, ...oldAudit } = audit;
      await f.state.storage.put(key, oldAudit);
    }
    const vacancy = await f.read(f.b);
    expect(vacancy).toEqual({ key: f.key, status: 'vacant', version: expect.stringMatching(/^[a-f0-9]{64}$/) });
    if (vacancy.status !== 'vacant') throw Error('Expected old audit compatibility');
    const before = await f.history();
    expect(await f.cas(f.b, vacancy.version, { state: 'active' })).toEqual({ status: 'committed' });
    expect(await f.history()).toEqual(before);
  }));

  it('reconciles an applied reset after revision changes without resetting a newer claim', () => fixture(async f => {
    const request = await f.resetRequest();
    const result = await f.registry.recoverApplication(request);
    const newer = { ...f.original, activityId: 'newer-run', value: { active: true } };
    await f.state.storage.put(f.storageKey, newer);
    f.installation.revision = 2;
    f.state.storage.sql.exec('UPDATE operator_installations SET data=? WHERE id=?', JSON.stringify(f.installation), 'install');
    expect(await f.registry.recoverApplication(request)).toEqual(result);
    expect(await f.state.storage.get(f.storageKey)).toEqual(newer);
    await expect(f.registry.recoverApplication({ ...request, requestId: crypto.randomUUID() })).rejects.toThrow('conflict');
    expect(await f.state.storage.get(f.storageKey)).toEqual(newer);
  }));
  it('reports partial application decisions and preserves every skipped original', () => fixture(async f => {
    const key = 'opaque:scope:two', storageKey = `${f.prefix}${await recoveryDigest(key)}`;
    const original = { ...f.original, key, value: { keep: true } };
    await f.state.storage.put(storageKey, original);
    f.callback.declineKey = key;
    const request = await f.resetRequest();
    const result = await f.registry.recoverApplication(request);
    expect(result).toEqual({ requestId: request.requestId, reset: 1, skipped: [{ key, reason: 'Already processed' }] });
    expect(await f.state.storage.get(storageKey)).toEqual(original);
    expect(await f.state.storage.get(f.storageKey)).toMatchObject({ value: { reset: true } });
    expect(await f.registry.recoverApplication(request)).toEqual(result);
    expect(await f.state.storage.get(storageKey)).toEqual(original);
  }));
  it.each(['version-race', 'revoked-manager', 'malformed-callback', 'unknown-write', 'foreign-owner'] as const)('%s cannot reset', name => fixture(async f => {
    const request = await f.resetRequest();
    const before = await f.state.storage.get(f.storageKey);
    if (name === 'version-race') f.callback.alter = async () => { await f.state.storage.put(f.storageKey, { ...f.original, value: { raced: true } }); };
    if (name === 'revoked-manager') { f.operator.managers.users = []; f.saveOperator(); }
    if (name === 'malformed-callback') f.callback.malformed = true;
    if (name === 'unknown-write') f.facts.value = { resettable: false, reason: 'source-write' };
    if (name === 'foreign-owner') { request.human = { ...request.human, subject: 'other' }; request.platformAdmin = true; }
    if (name === 'unknown-write') expect(await f.registry.recoverApplication(request)).toMatchObject({ reset: 0, skipped: [{ reason: 'source-write' }] });
    else await expect(f.registry.recoverApplication(request)).rejects.toThrow();
    if (name !== 'version-race') expect(await f.state.storage.get(f.storageKey)).toEqual(before);
    expect(await f.registry.getManagementAdmission('old')).toEqual(f.ledger);
    expect(f.unsafe).toEqual([]);
  }));
  it('uses package labels for opaque conflicts without disclosing foreign payloads', () => fixture(async f => {
    const key = 'opaque:scope:foreign';
    const original = { ...f.original, key, ownerKey: 'f'.repeat(64), value: 'PRIVATE_FOREIGN' };
    const storageKey = `${f.prefix}${await recoveryDigest(key)}`;
    await f.state.storage.put(storageKey, original);
    const page = await f.preview();
    expect(page.items).toContainEqual(expect.objectContaining({ key, label: 'Owned record', status: 'blocked', reason: 'record-owner-mismatch' }));
    expect(JSON.stringify(f.callback.records)).not.toContain('PRIVATE_FOREIGN');
    expect(await f.state.storage.get(storageKey)).toEqual(original);
  }));
  it('continues late-anchor discovery and later record pages without rescanning completed pages', () => fixture(async f => {
    const records = [{ key: f.original.key, storageKey: f.storageKey }];
    for (let index = 0; index < 140; index++) {
      const key = `opaque:scope:late-${index}`, storageKey = `${f.prefix}${await recoveryDigest(key)}`;
      await f.state.storage.put(storageKey, { ...f.original, key });
      records.push({ key, storageKey });
    }
    records.sort((a, b) => a.storageKey.localeCompare(b.storageKey));
    f.callback.scopeAnchor = records.at(-1)!.key;
    let page = await f.preview();
    expect(page.items).toEqual([]);
    expect(page.nextCursor).not.toBeNull();
    const cursors = new Set<string>();
    while (!page.items.length && page.nextCursor) {
      expect(cursors.has(page.nextCursor)).toBe(false); cursors.add(page.nextCursor);
      page = await f.preview(page.nextCursor);
    }
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.scopeCursor).toBeDefined();
    const shown = page.items.map(item => item.key);
    const prior = records.find(record => record.key === shown[0])!;
    await f.state.storage.put(prior.storageKey, { ...f.original, key: prior.key, value: 'x'.repeat(65 * 1024) });
    while (page.nextCursor) {
      page = await f.preview(page.nextCursor);
      shown.push(...page.items.map(item => item.key));
    }
    expect(shown).toHaveLength(records.length);
    expect(new Set(shown).size).toBe(records.length);
  }));
  it('returns resumable discovery pages when no configured scope exists', () => fixture(async f => {
    for (let index = 0; index < 70; index++) {
      const key = `opaque:scope:unmatched-${index}`;
      await f.state.storage.put(`${f.prefix}${await recoveryDigest(key)}`, { ...f.original, key });
    }
    f.callback.scopeAnchor = null;
    let page = await f.preview();
    expect(page).toMatchObject({ items: [] });
    expect(page.nextCursor).not.toBeNull();
    const seen = new Set<string>();
    while (page.nextCursor) {
      expect(seen.has(page.nextCursor)).toBe(false); seen.add(page.nextCursor);
      page = await f.preview(page.nextCursor);
      expect(page.items).toEqual([]);
    }
  }));
  it('uses an owner-validated preview witness without resetting that anchor', () => fixture(async f => {
    const key = 'opaque:scope:unrecognized', storageKey = `${f.prefix}${await recoveryDigest(key)}`;
    const record = { ...f.original, key, value: null };
    await f.state.storage.put(storageKey, record);
    f.callback.scopeAnchor = f.original.key;
    const page = await f.preview();
    const selected = page.items.find(item => item.key === key)!;
    expect(await f.registry.recoverApplication({ ...f.base, operation: 'reset', requestId: crypto.randomUUID(),
      scopeCursor: page.scopeCursor, entries: [{ key, version: selected.version }] })).toMatchObject({ reset: 1, skipped: [] });
    expect(await f.state.storage.get(f.storageKey)).toEqual(f.original);
    expect(await f.state.storage.get(storageKey)).toMatchObject({ value: { reset: true } });
    await f.state.storage.put(f.storageKey, { ...f.original, ownerKey: 'f'.repeat(64) });
    await expect(f.preview(page.nextCursor ?? page.scopeCursor)).rejects.toThrow();
  }));
  it('round-trips escaped opaque anchors through preview continuation and reset', () => fixture(async f => {
    const key = `opaque:scope:${'\u0001'.repeat(1000)}`;
    await f.state.storage.put(`${f.prefix}${await recoveryDigest(key)}`, { ...f.original, key });
    for (let index = 0; index < 70; index++) {
      const other = `opaque:scope:escaped-${index}`;
      await f.state.storage.put(`${f.prefix}${await recoveryDigest(other)}`, { ...f.original, key: other });
    }
    f.callback.scopeAnchor = key;
    let page = await f.preview();
    let selected: { key: string; version: string } | undefined;
    let after: string | null;
    do {
      const found = page.items.find(item => item.key === key);
      if (found) selected = { key: found.key, version: found.version };
      after = page.nextCursor;
      if (after) page = await f.preview(after);
    } while (after !== null);
    expect(selected).toBeDefined();
    expect(page.scopeCursor!.length).toBeGreaterThan(4096);
    expect(await f.registry.recoverApplication({ ...f.base, operation: 'reset', requestId: crypto.randomUUID(),
      scopeCursor: page.scopeCursor, entries: [selected!] })).toMatchObject({ reset: 1, skipped: [] });
  }));
  it('previews more than 64 records through bounded callback pages', () => fixture(async f => {
    for (let index = 0; index < 70; index++) {
      const key = `opaque:scope:${index}`;
      await f.state.storage.put(`${f.prefix}${await recoveryDigest(key)}`, { ...f.original, key });
    }
    const items: string[] = []; let after: string | undefined;
    do { const page = await f.preview(after); items.push(...page.items.map(item => item.key)); after = page.nextCursor ?? undefined; } while (after);
    expect(new Set(items).size).toBe(71);
    expect(items).toHaveLength(71);
  }));
});

// REQ-OPERATOR-210 AC3–5; REQ-DISPATCHER-003 AC1/2/7: a
// Root-verified release is not a transfer of the original private history.
describe('Root-authenticated exact-head vacancy', () => {
  it('an authorized different manager releases shared coordination without A login and records both provenances', () => headFixture(async f => {
    const published = await f.publish();
    const before = await f.history();
    const request = await f.resetRequest();
    const result = await f.registry.recoverApplication({ ...request, human: f.b.human });
    expect(result).toEqual({ requestId: request.requestId, reset: 1, skipped: [] });
    const vacancy = await f.read(f.b);
    expect(vacancy).toEqual({ key: f.key, status: 'vacant', version: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const after = await f.history();
    expect(after).toMatchObject({ alias: before.alias, activity: before.activity, ledger: before.ledger, facts: before.facts });
    expect([...after.originals.values()]).toContainEqual(published);
    expect([...after.audits.values()]).toEqual([expect.objectContaining({ actorHash: f.b.ownerKey,
      originalOwnerHash: f.a.ownerKey, originalVersion: request.entries[0].version })]);
    if (vacancy.status !== 'vacant') throw Error('Expected Root-verified vacancy');
    expect(await f.cas(f.b, vacancy.version, { state: 'active', private: 'B_PRIVATE' }, { state: 'active' }))
      .toEqual({ status: 'committed' });
    expect(await f.registry.recoverApplication({ ...request, human: f.b.human })).toEqual(result);
    expect(f.unsafe).toEqual([]);
  }));

  it('exposes only a non-null versioned vacancy to B, then supports B claim assertion and result CAS over A’s retained alias', () => headFixture(async f => {
    const before = await f.history();
    const request = await f.resetRequest();
    const result = await f.registry.recoverApplication(request);
    expect(result).toEqual({ requestId: request.requestId, reset: 1, skipped: [] });
    const releasedHistory = await f.history();
    expect(releasedHistory).toMatchObject({ alias: before.alias, activity: before.activity, ledger: before.ledger, facts: before.facts });
    expect([...releasedHistory.originals.values()]).toContainEqual(f.original);
    expect(releasedHistory.audits.size).toBe(1);
    const vacancy = await f.read(f.b);
    // This exact public wire contract also excludes old payload, activity,
    // identity, legacy mapping and Root's private release provenance.
    expect(vacancy).toEqual({ key: f.key, status: 'vacant', version: expect.stringMatching(/^[a-f0-9]{64}$/) });
    if (vacancy.status !== 'vacant') throw Error('Released head must be versioned vacant');
    const own = await f.read(f.a);
    if (own.status === 'value') expect(own.value).toEqual(f.callback.resetValue);
    else expect(own).toEqual(vacancy);
    const claim = { state: 'active', activityId: f.b.activityId, target: { repositoryId: 44, pullRequest: 17, head: 'b'.repeat(40) } };
    expect(await f.cas(f.b, null, claim)).toEqual({ status: 'conflict' });
    expect(await f.read(f.b)).toEqual(vacancy);
    expect(await f.cas(f.b, vacancy.version, claim)).toEqual({ status: 'committed' });
    expect(await f.state.storage.get(f.storageKey)).toMatchObject({ ownerKey: f.b.ownerKey,
      installationId: f.b.installationId, activityId: f.b.activityId, generation: f.b.generation, deadline: f.b.deadline, value: claim });
    const active = await f.read(f.b);
    expect(active).toEqual({ key: f.key, status: 'value', version: expect.stringMatching(/^[a-f0-9]{64}$/), value: claim });
    if (active.status !== 'value') throw Error('Winning owner must be able to assert its current claim');
    expect(await f.read(f.a)).toEqual({ key: f.key, status: 'conflict' });
    const completed = { ...claim, state: 'result', result: { outcome: 'NOT_MERGED' } };
    expect(await f.cas(f.b, active.version, completed)).toEqual({ status: 'committed' });
    const finished = await f.read(f.b);
    expect(finished).toEqual({ key: f.key, status: 'value', version: expect.stringMatching(/^[a-f0-9]{64}$/), value: completed });
    expect(await f.cas(f.b, vacancy.version, claim)).toEqual({ status: 'conflict' });
    expect(await f.registry.recoverApplication(request)).toEqual(result);
    await expect(f.registry.recoverApplication({ ...request, requestId: crypto.randomUUID() })).rejects.toThrow();
    expect(await f.read(f.b)).toEqual(finished);
    expect(await f.history()).toEqual(releasedHistory);
    expect(f.unsafe).toEqual([]);
  }));

  it.each(['A-first', 'B-first'] as const)('%s concurrent original-owner/new-owner claims elect one owner without exposing the loser’s history', order => headFixture(async f => {
    const request = await f.resetRequest();
    const result = await f.registry.recoverApplication(request);
    const history = await f.history();
    const vacancy = await f.read(f.b);
    expect(vacancy).toEqual({ key: f.key, status: 'vacant', version: expect.stringMatching(/^[a-f0-9]{64}$/) });
    if (vacancy.status !== 'vacant') throw Error('Expected authenticated vacancy');
    const contenders = order === 'A-first' ? [f.a, f.b] : [f.b, f.a];
    const claims = contenders.map(binding => ({ state: 'active', activityId: binding.activityId }));
    const results = await Promise.all(contenders.map((binding, index) => f.cas(binding, vacancy.version, claims[index])));
    expect(results).toContainEqual({ status: 'committed' });
    expect(results).toContainEqual({ status: 'conflict' });
    const winner = results.findIndex(value => (value as { status: string }).status === 'committed');
    const winning = await f.read(contenders[winner]);
    expect(winning).toEqual({ key: f.key, status: 'value', version: expect.stringMatching(/^[a-f0-9]{64}$/), value: claims[winner] });
    if (winning.status !== 'value') throw Error('Winner lost its active claim');
    expect(await f.read(contenders[1 - winner])).toEqual({ key: f.key, status: 'conflict' });
    expect(await f.state.storage.get(f.storageKey)).toMatchObject({ ownerKey: contenders[winner].ownerKey,
      activityId: contenders[winner].activityId, generation: contenders[winner].generation });
    expect(await f.cas(contenders[1 - winner], vacancy.version, claims[1 - winner])).toEqual({ status: 'conflict' });
    expect(await f.registry.recoverApplication(request)).toEqual(result);
    expect(await f.read(contenders[winner])).toEqual(winning);
    expect(await f.history()).toEqual(history);
  }));

  it('does not treat an ordinary package-written reset marker as a Root-authorized vacancy', () => headFixture(async f => {
    const initial = await f.read(f.a);
    if (initial.status !== 'value') throw Error('Owner must be able to read its original claim');
    expect(await f.cas(f.a, initial.version, { state: 'reset', activityId: 'old' })).toEqual({ status: 'committed' });
    const reset = await f.read(f.a);
    expect(reset).toMatchObject({ status: 'value', value: { state: 'reset', activityId: 'old' } });
    if (reset.status !== 'value') throw Error('Package marker lost');
    const before = await f.state.storage.list();
    expect(await f.read(f.b)).toEqual({ key: f.key, status: 'conflict' });
    expect(await f.cas(f.b, reset.version, { state: 'active', activityId: f.b.activityId })).toEqual({ status: 'conflict' });
    expect(await f.cas(f.b, null, { state: 'active', activityId: f.b.activityId })).toEqual({ status: 'conflict' });
    expect(await f.state.storage.list()).toEqual(before);
  }));

  it('consuming a verified vacancy with another package reset value does not leave it available to B', () => headFixture(async f => {
    await f.registry.recoverApplication(await f.resetRequest());
    const vacancy = await f.read(f.b);
    expect(vacancy).toMatchObject({ status: 'vacant' });
    if (vacancy.status !== 'vacant') throw Error('Expected authenticated vacancy');
    const history = await f.history();
    const marker = { state: 'reset', activityId: f.a.activityId };
    expect(await f.cas(f.a, vacancy.version, marker)).toEqual({ status: 'committed' });
    expect(await f.read(f.a)).toEqual({ key: f.key, status: 'value', version: expect.stringMatching(/^[a-f0-9]{64}$/), value: marker });
    expect(await f.read(f.b)).toEqual({ key: f.key, status: 'conflict' });
    expect(await f.cas(f.b, vacancy.version, { state: 'active', activityId: f.b.activityId })).toEqual({ status: 'conflict' });
    expect(await f.history()).toEqual(history);
  }));

  it.each(['vacant', 'claimed'] as const)('legacy alias drift after release while %s stays refused and never rewrites history', phase => headFixture(async f => {
    await f.registry.recoverApplication(await f.resetRequest());
    const vacancy = await f.read(f.b);
    expect(vacancy).toMatchObject({ status: 'vacant' });
    if (vacancy.status !== 'vacant') throw Error('Expected authenticated vacancy');
    let version = vacancy.version;
    if (phase === 'claimed') {
      expect(await f.cas(f.b, version, { state: 'active', activityId: f.b.activityId })).toEqual({ status: 'committed' });
      const active = await f.read(f.b);
      if (active.status !== 'value') throw Error('Expected own active state');
      version = active.version;
    }
    await f.state.storage.put(f.aliasKey, { ...f.legacy, private: 'CHANGED_PRIVATE_HISTORY' });
    const before = await f.state.storage.list();
    await refusedState(await f.registry.applyApplicationState(f.b, { operation: 'read', keys: [f.key] }), f.key);
    const exchange = await f.cas(f.b, version, { state: 'active', activityId: f.b.activityId });
    expect(exchange).not.toEqual({ status: 'committed' });
    expect([JSON.stringify({ status: 'conflict' }), JSON.stringify({ error: { status: 503, code: 'application-state-unavailable' } })]).toContain(JSON.stringify(exchange));
    expect(await f.state.storage.list()).toEqual(before);
  }));

  it('revoked invoker authority cannot read or consume a previously observed vacancy', () => headFixture(async f => {
    await f.registry.recoverApplication(await f.resetRequest());
    const vacancy = await f.read(f.b);
    expect(vacancy).toMatchObject({ status: 'vacant' });
    if (vacancy.status !== 'vacant') throw Error('Expected authenticated vacancy');
    f.operator.invokers.users = [f.a.human.email]; f.saveOperator();
    const before = await f.state.storage.list();
    const denied = { error: { status: 403, code: 'application-state-denied' } };
    expect(await f.registry.applyApplicationState(f.b, { operation: 'read', keys: [f.key] })).toEqual(denied);
    expect(await f.cas(f.b, vacancy.version, { state: 'active', activityId: f.b.activityId })).toEqual(denied);
    expect(await f.state.storage.list()).toEqual(before);
  }));
});

// REQ-OPERATOR-061 AC4/6, 210 AC2–5, 211: real state/CAS/vacancy
// transactions; external original facts remain controlled by the established
// recovery fixture. Exact equality below is the public privacy wire contract.
describe('owner-neutral explicitly nonprivate coordination', () => {
  it.each(['modern', 'legacy'] as const)('%s shared null reset exposes vacancy to a fresh same-human Activity', kind => headFixture(async f => {
    if (kind === 'modern') await f.publish();
    else await f.state.storage.delete(f.storageKey);
    f.callback.resetValue = null;
    // The package intentionally returns JSON null, not a private reset object.
    const request = await f.resetRequest();
    expect(await f.registry.recoverApplication(request)).toEqual({ requestId: request.requestId, reset: 1, skipped: [] });
    const fresh = await f.live(f.a.human, 'fresh-same-human-after-reset');
    expect(fresh.activityId).not.toBe(f.a.activityId);
    const vacancy = await f.read(fresh);
    expect(vacancy).toEqual({ key: f.key, status: 'vacant', version: expect.stringMatching(/^[a-f0-9]{64}$/) });
    if (vacancy.status !== 'vacant') throw Error('Shared reset must permit the original human to retry');
    const claim = { state: 'active', private: 'FRESH_A_PRIVATE' };
    expect(await f.cas(fresh, vacancy.version, claim, { state: 'active' })).toEqual({ status: 'committed' });
    const own = await f.read(fresh);
    if (own.status !== 'value') throw Error('Fresh claimant lost its value');
    expect(own.value).toEqual(claim);
    expect(await f.read(f.b)).toEqual({ key: f.key, status: 'coordination', version: own.version, coordination: { state: 'active' } });
    expect(await f.state.storage.get(f.aliasKey)).toEqual(f.legacy);
  }));

  it.each([true, false])('B management uses exact per-delivery proof while the parent remains active, noWrites=%s', noExternalWrites => headFixture(async f => {
    await f.publish(undefined, { submissionId: 'PRIVATE_SUBMISSION', uid: 'PRIVATE_UID', deliveryDigest: 'f'.repeat(64) });
    f.facts.value = { resettable: false, reason: 'drive-generation-current' };
    f.deliveryFacts.value.noExternalWrites = noExternalWrites;
    const request = await f.resetRequest();
    expect(await f.registry.recoverApplication({ ...request, human: f.b.human })).toMatchObject(noExternalWrites
      ? { reset: 1, skipped: [] } : { reset: 0, skipped: [{ key: f.key, reason: 'source-write' }] });
    expect(JSON.stringify(f.callback.records)).not.toMatch(/PRIVATE_|new-a|owner@example/);
    expect(await f.state.storage.get(f.aliasKey)).toEqual(f.legacy);
    expect(f.unsafe).toEqual([]);
  }));

  it.each([false, true])('a Root-stamped modern projection over unprojectable legacy bytes is shared without adopting private identity, drift=%s', drift => headFixture(async f => {
    // An older owner-readable alias has no repository/pins. Publish the modern
    // projection through real CAS; the unchanged alias remains private history.
    const { repository: _repository, baseBranch: _baseBranch, operatorRevision: _operatorRevision,
      installationRevision: _installationRevision, controlsRevision: _controlsRevision,
      releaseId: _releaseId, bundleDigest: _bundleDigest, ...legacy } = f.legacy;
    await f.state.storage.put({ [f.aliasKey]: legacy, 'renovate-activity:old': legacy,
      [f.storageKey]: { ...f.original, legacy: { storageKey: f.aliasKey, version: await recoveryDigest(JSON.stringify(legacy)) } } });
    await f.publish(undefined, { submissionId: 'PRIVATE_SUBMISSION', uid: 'PRIVATE_UID', deliveryDigest: 'f'.repeat(64) });
    const own = await f.read(f.a);
    if (own.status !== 'value') throw Error('Expected modern owner value');
    if (drift) await f.state.storage.put(f.aliasKey, { ...legacy, private: 'CHANGED_PRIVATE_HISTORY' });
    const before = await f.state.storage.list();
    if (drift) {
      await refusedState(await f.registry.applyApplicationState(f.b, { operation: 'read', keys: [f.key] }), f.key);
      expect(await f.execution(f.b, 'release-coordination', own.version)).not.toMatchObject({ status: 'vacant' });
      expect(await f.state.storage.list()).toEqual(before);
    } else {
      expect(await f.read(f.b)).toEqual({ key: f.key, status: 'coordination', version: own.version, coordination: { state: 'active' } });
      const request = await f.resetRequest();
      expect(await f.registry.recoverApplication({ ...request, human: f.b.human })).toMatchObject({ reset: 1, skipped: [] });
      expect(await f.read(f.b)).toMatchObject({ key: f.key, status: 'vacant' });
      expect(await f.state.storage.get(f.aliasKey)).toEqual(legacy);
    }
  }));

  it.each([null, false, 0, 'opaque', ['opaque', 7], { phase: 'opaque' }].map(coordination => ({ coordination })))(
    'explicit coordination $coordination remains opaque JSON and shares no sibling private fields', ({ coordination }) => headFixture(async f => {
      await f.publish(coordination);
      const owner = await f.read(f.a);
      if (owner.status !== 'value') throw Error('Expected private owner state');
      expect(await f.read(f.b)).toEqual({ key: f.key, status: 'coordination', version: owner.version, coordination });
    }));

  it.each(['MERGED', 'NOT_MERGED'] as const)('A publishes %s and B reads only the processed projection, including after reconstruction', outcome => headFixture(async f => {
    const [entry] = (await f.registry.applyApplicationState(f.a, { operation: 'read', keys: [f.key] }) as { entries: StateEntry[] }).entries;
    if (entry.status !== 'value') throw Error('Expected original owned state');
    const coordination = { state: 'processed', target: { repositoryId: 44, pullRequest: 17, head: f.legacy.head }, outcome };
    const value = { state: 'result', result: { outcome, assessment: 'PRIVATE_ASSESSMENT' },
      owner: f.a.ownerKey, activityId: 'PRIVATE_ACTIVITY', token: 'PRIVATE_TOKEN' };
    expect(await f.cas(f.a, entry.version, value, coordination)).toEqual({ status: 'committed' });
    const own = await f.read(f.a);
    expect(own).toEqual({ key: f.key, status: 'value', version: expect.stringMatching(/^[a-f0-9]{64}$/), value });
    if (own.status !== 'value') throw Error('Expected private result');
    const shared = { key: f.key, status: 'coordination', version: own.version, coordination };
    expect(await f.read(f.b)).toEqual(shared);
    const cold = new OperatorRegistry(f.state, f.environment);
    expect(await cold.applyApplicationState(f.b, { operation: 'read', keys: [f.key] })).toEqual({ entries: [shared] });
    expect(await f.state.storage.get(f.aliasKey)).toEqual(f.legacy);
    expect(await f.registry.getManagementAdmission('old')).toEqual(f.ledger);
    expect(f.unsafe).toEqual([]);
  }));

  it.each(['completed', 'failed'] as const)('read-coordination returns only safe %s facts, not the original delivery identifiers', outcome => headFixture(async f => {
    await f.publish(undefined, { submissionId: 'PRIVATE_SUBMISSION', uid: 'PRIVATE_UID', deliveryDigest: 'f'.repeat(64) });
    f.deliveryFacts.value.outcome = outcome;
    const shared = await f.read(f.b);
    if (shared.status !== 'coordination') throw Error('Expected shared state');
    const before = await f.state.storage.list();
    expect(await f.execution(f.b, 'read-coordination', shared.version)).toEqual({ status: 'safe', outcome,
      terminalAt: f.deliveryFacts.value.terminalAt, fenced: true, noExternalWrites: true });
    expect(await f.state.storage.list()).toEqual(before);
    expect(f.unsafe).toEqual([]);
  }));

  it('a shared active projection is not a cross-owner write permit, even at the exact current version', () => headFixture(async f => {
    const coordination = { state: 'active' };
    await f.publish(coordination);
    const shared = await f.read(f.b);
    expect(shared).toEqual({ key: f.key, status: 'coordination', version: expect.stringMatching(/^[a-f0-9]{64}$/), coordination });
    if (shared.status !== 'coordination') throw Error('Expected shared state');
    const before = await f.state.storage.list();
    expect(await f.cas(f.b, shared.version, { stolen: true }, { state: 'processed' })).toEqual({ status: 'conflict' });
    expect(await f.cas(f.b, null, { stolen: true }, { state: 'active' })).toEqual({ status: 'conflict' });
    expect(await f.state.storage.list()).toEqual(before);
  }));

  it('B inspects safe failed original facts, releases and claims without disclosing or rewriting A history', () => headFixture(async f => {
    const coordination = { state: 'active' };
    const original = await f.publish(coordination, { submissionId: 'PRIVATE_SUBMISSION', uid: 'PRIVATE_UID', deliveryDigest: 'f'.repeat(64) });
    const shared = await f.read(f.b);
    if (shared.status !== 'coordination') throw Error('Expected shared state');
    const history = await f.history();
    expect(await f.execution(f.b, 'read-coordination', shared.version)).toEqual({ status: 'safe', outcome: 'failed',
      terminalAt: f.deliveryFacts.value.terminalAt, fenced: true, noExternalWrites: true });
    expect(await f.history()).toEqual(history);
    const vacant = await f.execution(f.b, 'release-coordination', shared.version) as StateEntry;
    expect(vacant).toEqual({ key: f.key, status: 'vacant', version: expect.stringMatching(/^[a-f0-9]{64}$/) });
    if (vacant.status !== 'vacant') throw Error('Expected verified release');
    expect(await f.read(f.b)).toEqual(vacant);
    const released = await f.history();
    expect(released).toMatchObject({ alias: history.alias, activity: history.activity, ledger: history.ledger, facts: history.facts });
    expect([...released.originals.values()]).toContainEqual(original);
    expect([...released.audits.values()]).toEqual([expect.objectContaining({ actorHash: f.b.ownerKey,
      originalOwnerHash: f.a.ownerKey, originalVersion: shared.version })]);
    const claim = { state: 'active', private: 'B_PRIVATE_HISTORY' };
    expect(await f.cas(f.b, vacant.version, claim, { state: 'active' })).toEqual({ status: 'committed' });
    const own = await f.read(f.b);
    if (own.status !== 'value') throw Error('Expected B claim');
    expect(own.value).toEqual(claim);
    expect(await f.read(f.a)).toEqual({ key: f.key, status: 'coordination', version: own.version, coordination: { state: 'active' } });
    expect(await f.execution(f.c, 'release-coordination', shared.version)).toEqual({ status: 'conflict' });
    expect(await f.read(f.b)).toEqual(own);
    expect(await f.history()).toEqual(released);
    expect(f.unsafe).toEqual([]);
  }));

  it.each(['active', 'unknown-write', 'missing-proof'] as const)('%s proof holds a shared claim for evidence rather than identity', reason => headFixture(async f => {
    await f.publish();
    f.facts.value = { resettable: false, reason: reason === 'active' ? 'drive-generation-current'
      : reason === 'unknown-write' ? 'source-write' : 'journal-missing' };
    Object.assign(f.deliveryFacts.value, { status: 'unavailable' });
    const shared = await f.read(f.b);
    if (shared.status !== 'coordination') throw Error('Expected shared claim');
    const before = await f.state.storage.list();
    for (const operation of ['read-coordination', 'release-coordination'] as const) {
      const result = await f.execution(f.b, operation, shared.version);
      expect(result).toEqual({ status: 'held', reason: expect.any(String) });
      expect(JSON.stringify(result)).not.toMatch(/owner|identity|PRIVATE_|old|submission/i);
    }
    expect(await f.cas(f.b, shared.version, { state: 'active' }, { state: 'active' })).toEqual({ status: 'conflict' });
    expect(await f.state.storage.list()).toEqual(before);
    expect(f.unsafe).toEqual([]);
  }));

  it.each(['B-first', 'C-first'] as const)('%s contenders have one CAS winner after owner-neutral release', order => headFixture(async f => {
    await f.publish(undefined, { submissionId: 'PRIVATE_SUBMISSION', uid: 'PRIVATE_UID', deliveryDigest: 'f'.repeat(64) });
    const shared = await f.read(f.b);
    if (shared.status !== 'coordination') throw Error('Expected shared claim');
    const vacancy = await f.execution(f.b, 'release-coordination', shared.version) as StateEntry;
    if (vacancy.status !== 'vacant') throw Error('Expected verified vacancy');
    const history = await f.history();
    const contenders = order === 'B-first' ? [f.b, f.c] : [f.c, f.b];
    const values = contenders.map(binding => ({ state: 'active', private: binding.activityId }));
    const results = await Promise.all(contenders.map((binding, index) =>
      f.cas(binding, vacancy.version, values[index], { state: 'active' })));
    expect(results).toContainEqual({ status: 'committed' });
    expect(results).toContainEqual({ status: 'conflict' });
    const winner = results.findIndex(result => (result as { status: string }).status === 'committed');
    const own = await f.read(contenders[winner]);
    if (own.status !== 'value') throw Error('Winner lost claim');
    expect(own.value).toEqual(values[winner]);
    expect(await f.read(contenders[1 - winner])).toEqual({ key: f.key, status: 'coordination',
      version: own.version, coordination: { state: 'active' } });
    expect(await f.execution(f.c, 'release-coordination', shared.version)).toEqual({ status: 'conflict' });
    expect(await f.cas(contenders[1 - winner], vacancy.version, { stolen: true }, { state: 'active' })).toEqual({ status: 'conflict' });
    expect(await f.read(contenders[winner])).toEqual(own);
    expect(await f.history()).toEqual(history);
  }));

  it('release rechecks changed original facts rather than consuming a previously safe inspection', () => headFixture(async f => {
    await f.publish(undefined, { submissionId: 'PRIVATE_SUBMISSION', uid: 'PRIVATE_UID', deliveryDigest: 'f'.repeat(64) });
    const shared = await f.read(f.b);
    if (shared.status !== 'coordination') throw Error('Expected shared claim');
    expect(await f.execution(f.b, 'read-coordination', shared.version)).toMatchObject({ status: 'safe' });
    f.deliveryFacts.value.noExternalWrites = false;
    f.facts.value = { resettable: false, reason: 'source-write' };
    const before = await f.state.storage.list();
    expect(await f.execution(f.b, 'release-coordination', shared.version))
      .toEqual({ status: 'held', reason: expect.any(String) });
    expect(await f.state.storage.list()).toEqual(before);
  }));

  it('a private value update invalidates an old coordination version even when the public projection is unchanged', () => headFixture(async f => {
    await f.publish();
    const shared = await f.read(f.b);
    const own = await f.read(f.a);
    if (shared.status !== 'coordination' || own.status !== 'value') throw Error('Expected shared/private views');
    expect(await f.cas(f.a, own.version, { private: 'CHANGED_PRIVATE_VALUE' }, { state: 'active' }))
      .toEqual({ status: 'committed' });
    const current = await f.read(f.b);
    expect(current).toMatchObject({ key: f.key, status: 'coordination', coordination: { state: 'active' } });
    if (current.status !== 'coordination') throw Error('Expected updated coordination');
    expect(current.version).not.toBe(shared.version);
    const before = await f.state.storage.list();
    expect(await f.execution(f.b, 'release-coordination', shared.version)).toEqual({ status: 'conflict' });
    expect(await f.state.storage.list()).toEqual(before);
  }));

  it('legacy alias drift invalidates an observed shared version without replacing either original', () => headFixture(async f => {
    await f.publish();
    const shared = await f.read(f.b);
    if (shared.status !== 'coordination') throw Error('Expected shared claim');
    await f.state.storage.put(f.aliasKey, { ...f.legacy, private: 'CHANGED_PRIVATE_HISTORY' });
    const before = await f.state.storage.list();
    await refusedState(await f.registry.applyApplicationState(f.b, { operation: 'read', keys: [f.key] }), f.key);
    expect(await f.execution(f.b, 'release-coordination', shared.version)).not.toMatchObject({ status: 'vacant' });
    expect(await f.state.storage.list()).toEqual(before);
  }));

  it('a work-repository change denies the old projection and release even to a freshly admitted same-operator actor', () => headFixture(async f => {
    await f.publish();
    const shared = await f.read(f.b);
    if (shared.status !== 'coordination') throw Error('Expected shared claim');
    f.installation.configurationJson = JSON.stringify({ repository: 'acme/elsewhere', automaticRuns: false });
    f.installation.revision++;
    f.state.storage.sql.exec('UPDATE operator_installations SET data=? WHERE id=?', JSON.stringify(f.installation), 'install');
    const otherScope = await f.live(f.b.human, 'different-work-repository');
    const before = await f.state.storage.list();
    await refusedState(await f.registry.applyApplicationState(otherScope, { operation: 'read', keys: [f.key] }), f.key);
    expect(await f.execution(otherScope, 'release-coordination', shared.version)).not.toMatchObject({ status: 'vacant' });
    expect(await f.cas(otherScope, shared.version, { stolen: true }, { state: 'active' })).not.toEqual({ status: 'committed' });
    expect(await f.state.storage.list()).toEqual(before);
  }));

  it.each(['revoked', 'source', 'operator'] as const)('%s authority cannot read, inspect or release shared private origins', kind => headFixture(async f => {
    await f.publish();
    const shared = await f.read(f.b);
    if (shared.status !== 'coordination') throw Error('Expected shared claim');
    const binding = { ...f.b };
    if (kind === 'revoked') { f.operator.invokers.users = [f.a.human.email]; f.saveOperator(); }
    if (kind === 'source') { binding.sourceId = '99'; binding.sourceRepositoryId = 99; }
    if (kind === 'operator') binding.operatorId = 'different-operator';
    const before = await f.state.storage.list();
    await refusedState(await f.registry.applyApplicationState(binding, { operation: 'read', keys: [f.key] }), f.key);
    for (const operation of ['read-coordination', 'release-coordination'] as const) {
      const result = await f.execution(binding, operation, shared.version);
      expect(result).not.toMatchObject({ status: 'safe' });
      expect(result).not.toMatchObject({ status: 'vacant' });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|owner@example|old-registration/);
    }
    expect(await f.state.storage.list()).toEqual(before);
  }));

  it.each(['read', 'read-delivery', 'retire'] as const)('shared projection does not authorize private historical %s', operation => headFixture(async f => {
    await f.publish();
    const shared = await f.read(f.b);
    if (shared.status !== 'coordination') throw Error('Expected shared claim');
    const before = await f.state.storage.list();
    const result = await f.registry.applyApplicationExecution(f.b, { operation, key: f.key,
      version: shared.version, activityId: 'old' });
    expect(result).not.toMatchObject({ status: 'value' });
    expect(result).not.toMatchObject({ status: 'delivery' });
    expect(result).not.toMatchObject({ status: 'retired' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|owner@example|old-registration/);
    expect(await f.state.storage.list()).toEqual(before);
  }));
});

type HeadFixture = Awaited<ReturnType<typeof seedHead>>;
async function legacyOnlyFixture(run: (f: HeadFixture) => Promise<void>) {
  return headFixture(async f => {
    await f.state.storage.delete(f.storageKey);
    // A separate owned scope anchor keeps blocked legacy rows discoverable;
    // its ownership is never used as authority over the selected claim.
    const key = `renovate:head:44:99:${'b'.repeat(40)}`;
    await f.state.storage.put(`${f.prefix}${await recoveryDigest(key)}`, { ...f.original, key,
      legacy: { storageKey: `renovate-admission:44:99:${'b'.repeat(40)}`, version: null }, value: { scope: true } });
    f.callback.scopeAnchor = key;
    await run(f);
  });
}
// ProspectiveAdmission is admission-only: no processed/completed flag exists.
// This tests exactly that retained layout rather than inventing legacy outcomes.
describe('recognized legacy different-login coordination', () => {
  it.each([true, false])('unpinned legacy scope requires an actual immutable configured repository, proven=%s', proven => legacyOnlyFixture(async f => {
    const { repository: _repository, baseBranch: _baseBranch, operatorRevision: _operatorRevision,
      installationRevision: _installationRevision, controlsRevision: _controlsRevision,
      releaseId: _releaseId, bundleDigest: _bundleDigest, ...legacy } = f.legacy;
    const key = `renovate:head:973175879:17:${legacy.head}`;
    const aliasKey = `renovate-admission:973175879:17:${legacy.head}`;
    const retained = { ...legacy, repositoryId: 973175879, actor: { ...legacy.actor, sessionId: 'oldsession01' } };
    await f.state.storage.put({ [aliasKey]: retained, 'renovate-activity:old': retained });
    if (proven) f.state.storage.sql.exec('UPDATE operator_admissions SET data=? WHERE activity_id=?',
      JSON.stringify({ ...f.ledger, selection: { ...f.ledger.selection, manifestJson: JSON.stringify(f.manifest) } }), 'old');
    else f.state.storage.sql.exec('DELETE FROM operator_admissions WHERE activity_id=?', 'old');
    const before = await f.state.storage.list();
    const response = await f.registry.applyApplicationState(f.b, { operation: 'read', keys: [key] });
    if (proven) expect(response).toEqual({ entries: [{ key, status: 'coordination', version: expect.stringMatching(/^[a-f0-9]{64}$/),
      coordination: { kind: 'legacy-admission', repositoryId: 973175879, pullRequest: 17, head: retained.head,
        createdAt: retained.createdAt, activatedAt: retained.activatedAt } }] });
    else {
      await refusedState(response, key);
      const version = await recoveryDigest(JSON.stringify(['legacy', '23', key,
        { storageKey: aliasKey, version: await recoveryDigest(JSON.stringify(retained)) }]));
      expect(await f.registry.applyApplicationExecution(f.b, { operation: 'read-coordination', key, version }))
        .toEqual({ status: 'held', reason: 'scope-unavailable' });
    }
    expect(await f.state.storage.list()).toEqual(before);
  }));

  it('B management discovers and releases a legacy head without a previous-owner scope anchor or private callback payload', () => legacyOnlyFixture(async f => {
    const anchor = `renovate:head:44:99:${'b'.repeat(40)}`;
    await f.state.storage.delete(`${f.prefix}${await recoveryDigest(anchor)}`);
    f.callback.scopeAnchor = f.key;
    const before = await f.history();
    const base = { ...f.base, human: f.b.human };
    type Page = { items: Array<{ key: string; version: string; status: string }>; nextCursor: string | null; scopeCursor?: string };
    let page = await f.registry.recoverApplication({ ...base, operation: 'preview' }) as Page;
    const pages = [page];
    while (!page.items.some(item => item.key === f.key) && page.nextCursor) {
      page = await f.registry.recoverApplication({ ...base, operation: 'preview', after: page.nextCursor }) as Page;
      pages.push(page);
    }
    const item = page.items.find(item => item.key === f.key);
    expect(item).toMatchObject({ key: f.key, status: 'resettable' });
    if (!item) throw Error('Legacy scope not discovered');
    opaqueLegacy(f, pages, [f.a.ownerKey, f.legacy.actor.email, f.legacy.actor.registrationId]);
    const requestId = crypto.randomUUID();
    expect(await f.registry.recoverApplication({ ...base, operation: 'reset', requestId,
      scopeCursor: page.scopeCursor, entries: [{ key: item.key, version: item.version }] }))
      .toEqual({ requestId, reset: 1, skipped: [] });
    const after = await f.history();
    expect(after).toMatchObject({ alias: before.alias, activity: before.activity, ledger: before.ledger, facts: before.facts });
    expect([...after.audits.values()]).toEqual([expect.objectContaining({ actorHash: f.b.ownerKey, originalOwnerHash: f.a.ownerKey })]);
    expect(f.unsafe).toEqual([]);
  }));

  it.each([
    ['legacy', 'fenced-no-write'], ['modern', 'fenced-no-write'], ['legacy', 'never-started'],
  ] as const)('%s %s proof separates automatic recovery from B explicit release and fresh claim', (kind, reason) => legacyOnlyFixture(async f => {
    f.facts.value = { resettable: true, reason, proofDigest: 'e'.repeat(64), origin: { generation: 1, deadline: 1, terminalAt: f.terminalAt } };
    const original = kind === 'modern' ? await f.publish() : f.legacy;
    Object.assign(f.deliveryFacts.value, { status: 'unavailable' });
    const before = await f.history();
    const shared = await f.read(f.b);
    expect(shared).toEqual({ key: f.key, status: 'coordination', version: expect.stringMatching(/^[a-f0-9]{64}$/),
      coordination: kind === 'modern' ? { state: 'active' } : f.legacyCoordination });
    if (shared.status !== 'coordination') throw Error('Expected shared projection');
    expect(JSON.stringify(shared)).not.toMatch(/PRIVATE_|owner@example|old-registration|old-session/);
    let vacancy: StateEntry;
    if (reason === 'fenced-no-write') {
      const unchanged = await f.state.storage.list();
      for (const operation of ['read-coordination', 'release-coordination'] as const) {
        expect(await f.execution(f.b, operation, shared.version))
          .toEqual({ status: 'held', reason: 'explicit-recovery-required' });
      }
      expect(await f.cas(f.b, shared.version, { state: 'active' }, { state: 'active' })).toEqual({ status: 'conflict' });
      expect(await f.state.storage.list()).toEqual(unchanged);
      f.callback.scopeAnchor = f.key;
      const requestId = crypto.randomUUID();
      expect(await f.registry.recoverApplication({ ...f.base, human: f.b.human, operation: 'reset', requestId,
        entries: [{ key: f.key, version: shared.version }] })).toEqual({ requestId, reset: 1, skipped: [] });
      vacancy = await f.read(f.b);
    } else {
      expect(await f.execution(f.b, 'read-coordination', shared.version)).toEqual({ status: 'safe', outcome: 'never-started',
        terminalAt: f.terminalAt, fenced: true, noExternalWrites: true });
      vacancy = await f.execution(f.b, 'release-coordination', shared.version) as StateEntry;
    }
    expect(vacancy).toEqual({ key: f.key, status: 'vacant', version: expect.stringMatching(/^[a-f0-9]{64}$/) });
    if (vacancy.status !== 'vacant') throw Error('Expected verified release');
    expect(await f.cas(f.b, vacancy.version, { state: 'active', private: 'B_PRIVATE' }, { state: 'active' }))
      .toEqual({ status: 'committed' });
    const own = await f.read(f.b);
    expect(own).toMatchObject({ status: 'value', value: { state: 'active', private: 'B_PRIVATE' } });
    const after = await f.history();
    expect(after).toMatchObject({ alias: before.alias, activity: before.activity, ledger: before.ledger, facts: before.facts });
    expect([...after.originals.values()]).toContainEqual(original);
    expect([...after.audits.values()]).toEqual([expect.objectContaining({ actorHash: f.b.ownerKey,
      originalOwnerHash: f.a.ownerKey, originalKind: kind === 'modern' ? 'record' : 'legacy', originalVersion: shared.version })]);
    expect(f.unsafe).toEqual([]);
  }));

  it('legacy projection copies only present allowlisted fields, never private identity or processing policy', () => legacyOnlyFixture(async f => {
    const legacy = { ...f.legacy, admittedAt: 1_700_000_000_000, attempt: 2,
      previousActivityId: 'PRIVATE_PREVIOUS_ACTIVITY' };
    await f.state.storage.put({ [f.aliasKey]: legacy, 'renovate-activity:old': legacy });
    const before = await f.state.storage.list();
    expect(await f.read(f.b)).toEqual({ key: f.key, status: 'coordination', version: expect.stringMatching(/^[a-f0-9]{64}$/),
      coordination: { ...f.legacyCoordination, admittedAt: legacy.admittedAt, attempt: legacy.attempt } });
    expect(await f.state.storage.list()).toEqual(before);
  }));

  it.each(['fenced-no-write', 'never-started'] as const)(
    'legacy %s automatic recovery requires a real closure time even when manual proof qualifies', reason => legacyOnlyFixture(async f => {
      f.facts.value = { resettable: true, reason, proofDigest: 'e'.repeat(64), origin: { generation: 1, deadline: 1 } };
      Object.assign(f.deliveryFacts.value, { status: 'unavailable' });
      const shared = await f.read(f.b);
      if (shared.status !== 'coordination') throw Error('Expected legacy coordination');
      const before = await f.state.storage.list();
      for (const operation of ['read-coordination', 'release-coordination'] as const) {
        expect(await f.execution(f.b, operation, shared.version)).toEqual({ status: 'held', reason: expect.any(String) });
      }
      expect(await f.state.storage.list()).toEqual(before);
      // B's verified shared key/version is a direct scope witness; A's
      // private preview anchor cannot authorize B's explicit recovery.
      f.callback.scopeAnchor = f.key;
      const request = { ...f.base, operation: 'reset' as const, requestId: crypto.randomUUID(),
        human: f.b.human, entries: [{ key: f.key, version: shared.version }] };
      expect(await f.registry.recoverApplication(request))
        .toEqual({ requestId: request.requestId, reset: 1, skipped: [] });
      expect(await f.state.storage.get(f.aliasKey)).toEqual(f.legacy);
      expect(await f.registry.getManagementAdmission('old')).toEqual(f.ledger);
      expect(f.unsafe).toEqual([]);
    }));

  it.each([0, -1, '1700000000000', null, 1.5, Number.MAX_SAFE_INTEGER].map(terminalAt => ({ terminalAt })))(
    'invalid legacy closure time $terminalAt cannot authorize automatic release', ({ terminalAt }) => legacyOnlyFixture(async f => {
      const raw = { resettable: true, reason: 'never-started', proofDigest: 'e'.repeat(64),
        origin: { generation: 1, deadline: 1, terminalAt } };
      f.facts.value = raw as unknown as TestRecoveryFacts;
      Object.assign(f.deliveryFacts.value, { status: 'unavailable' });
      const shared = await f.read(f.b);
      if (shared.status !== 'coordination') throw Error('Expected legacy coordination');
      const before = await f.state.storage.list();
      for (const operation of ['read-coordination', 'release-coordination'] as const) {
        expect(await f.execution(f.b, operation, shared.version)).toEqual({ status: 'held', reason: 'closure-time-unavailable' });
      }
      expect(await f.state.storage.list()).toEqual(before);
      expect(f.unsafe).toEqual([]);
    }));

  it.each(['repository', 'pull-request', 'head'] as const)(
    'legacy %s mismatch cannot supply another exact target’s coordination or release', kind => legacyOnlyFixture(async f => {
      const legacy = { ...f.legacy,
        ...(kind === 'repository' ? { repositoryId: 45, repository: 'acme/elsewhere' }
          : kind === 'pull-request' ? { pullRequest: 18 } : { head: 'c'.repeat(40) }) };
      await f.state.storage.put(f.aliasKey, legacy);
      const before = await f.state.storage.list();
      await refusedState(await f.registry.applyApplicationState(f.b, { operation: 'read', keys: [f.key] }), f.key);
      const version = await recoveryDigest(JSON.stringify(['legacy', '23', f.key,
        { storageKey: f.aliasKey, version: await recoveryDigest(JSON.stringify(legacy)) }]));
      expect(await f.execution(f.b, 'release-coordination', version)).not.toMatchObject({ status: 'vacant' });
      expect(await f.state.storage.list()).toEqual(before);
    }));

  it.each(['active-or-unfenced', 'journal-missing', 'source-write', 'journal-unaccounted'] as const)(
    'legacy %s holds for original evidence, not the current login', reason => legacyOnlyFixture(async f => {
      f.facts.value = { resettable: false, reason };
      Object.assign(f.deliveryFacts.value, { status: 'unavailable' });
      const shared = await f.read(f.b);
      if (shared.status !== 'coordination') throw Error('Expected legacy coordination');
      const before = await f.state.storage.list();
      for (const operation of ['read-coordination', 'release-coordination'] as const) {
        const result = await f.execution(f.b, operation, shared.version);
        expect(result).toEqual({ status: 'held', reason: expect.any(String) });
        expect(JSON.stringify(result)).not.toMatch(/owner|identity|PRIVATE_|old-registration/);
      }
      expect(await f.state.storage.list()).toEqual(before);
      expect(f.unsafe).toEqual([]);
    }));
});

async function legacyPreview(f: HeadFixture) {
  let page = await f.preview();
  const pages = [page];
  while (!page.items.some(item => item.key === f.key) && page.nextCursor) {
    page = await f.preview(page.nextCursor); pages.push(page);
  }
  const item = page.items.find(item => item.key === f.key);
  expect(item).toBeDefined();
  if (!item) throw Error('Configured legacy head was omitted from recovery preview');
  return { item, pages, scopeCursor: page.scopeCursor };
}
function opaqueLegacy(f: HeadFixture, pages: unknown, forbidden: string[] = []) {
  const records = f.callback.records.filter(record => (record as { key?: string }).key === f.key);
  expect(records).toContainEqual(expect.objectContaining({ key: f.key }));
  for (const record of records) {
    expect(record).not.toHaveProperty('value');
    expect(record).not.toHaveProperty('activityId');
    expect(record).not.toHaveProperty('invocation');
  }
  for (const value of ['PRIVATE_HISTORY', ...forbidden]) {
    expect(JSON.stringify(pages)).not.toContain(value);
    expect(JSON.stringify(records)).not.toContain(value);
  }
}
// REQ-OPERATOR-210 AC2–5: corrupt original identity stays protected;
// differences from the current requester are exercised separately below.
describe('privacy-safe recovery ownership classifications', () => {
  it('B preview classifies unprovable legacy scope as evidence unavailable without authorizing its release', () => legacyOnlyFixture(async f => {
    // A recognized older record has a repository but incomplete historical pins;
    // that is not proof that it belongs to today's configured work scope.
    const { baseBranch: _baseBranch, ...legacy } = f.legacy;
    await f.state.storage.put({ [f.aliasKey]: legacy, 'renovate-activity:old': legacy });
    const anchor = f.callback.scopeAnchor!;
    await f.state.storage.put(`${f.prefix}${await recoveryDigest(anchor)}`, { ...f.original, key: anchor,
      ownerKey: f.b.ownerKey, legacy: { storageKey: `renovate-admission:${anchor.slice('renovate:head:'.length)}`, version: null },
      value: { scope: true } });
    const base = { ...f.base, human: f.b.human };
    const preview = (after?: string) => f.registry.recoverApplication({ ...base, operation: 'preview', after }) as Promise<{
      items: Array<{ key: string; version: string; status: string; reason: string }>;
      nextCursor: string | null; scopeCursor?: string;
    }>;
    const before = await f.state.storage.list();
    let page = await preview();
    const pages = [page];
    while (!page.items.some(item => item.key === f.key) && page.nextCursor) {
      page = await preview(page.nextCursor); pages.push(page);
    }
    const item = page.items.find(item => item.key === f.key);
    expect(item).toMatchObject({ key: f.key, status: 'blocked', reason: 'scope-unavailable' });
    if (!item) throw Error('Unproven legacy record omitted');
    opaqueLegacy(f, pages, [f.a.ownerKey, legacy.actor.email, legacy.actor.registrationId]);
    await refusedState(await f.registry.applyApplicationState(f.b, { operation: 'read', keys: [f.key] }), f.key);
    for (const operation of ['read-coordination', 'release-coordination'] as const) {
      expect(await f.execution(f.b, operation, item.version)).toEqual({ status: 'held', reason: 'scope-unavailable' });
    }
    expect(await f.cas(f.b, item.version, { state: 'active' }, { state: 'active' })).not.toEqual({ status: 'committed' });
    expect(await f.state.storage.list()).toEqual(before);
    expect(await f.registry.recoverApplication({ ...base, operation: 'reset', requestId: crypto.randomUUID(),
      scopeCursor: page.scopeCursor, entries: [{ key: item.key, version: item.version }] })).toMatchObject({ reset: 0,
      skipped: [{ key: f.key, reason: 'version-or-owner-changed' }] });
    expect(await f.state.storage.get(f.aliasKey)).toEqual(legacy);
    expect(await f.state.storage.get(f.storageKey)).toBeUndefined();
    expect((await f.state.storage.list({ prefix: `${f.prefix}audit:` })).size).toBe(0);
    expect(await f.registry.getManagementAdmission('old')).toEqual(f.ledger);
    expect(f.unsafe).toEqual([]);
  }));

  it.each([
    ['overlay-owner', 'record-owner-mismatch'],
    ['legacy-key', 'legacy-owner-key-inconsistent'],
    ['subject', 'legacy-owner-key-inconsistent'],
    ['issuer', 'legacy-owner-key-inconsistent'],
    ['email', 'legacy-owner-key-inconsistent'],
    ['audiences', 'legacy-owner-key-inconsistent'],
    ['bucket', 'legacy-owner-bucket-mismatch'],
    ['source', 'source-mismatch'],
    ['alias-drift', 'legacy-version-drift'],
    ['malformed', 'malformed'],
  ] as const)('%s returns only the required %s category, never private evidence', (kind, reason) => legacyOnlyFixture(async f => {
    await f.state.storage.delete('renovate-activity:old');
    const record = structuredClone(f.legacy);
    const privateIdentity = `PRIVATE_CLASSIFIED_${kind}`;
    if (kind === 'legacy-key') record.ownerKey = 'f'.repeat(64);
    if (kind === 'subject' || kind === 'issuer' || kind === 'email' || kind === 'bucket') record.actor[kind] = privateIdentity;
    if (kind === 'audiences') record.actor.audiences = [privateIdentity];
    // Deliberately leave the stored owner hash unchanged: this is corrupt
    // original evidence, not a legitimate other login.
    if (kind === 'source') record.installationId = privateIdentity;
    await f.state.storage.put(f.aliasKey, kind === 'malformed' ? { ...record, actor: null } : record);
    if (kind === 'overlay-owner' || kind === 'alias-drift') {
      await f.state.storage.put(f.storageKey, { ...f.original,
        ownerKey: kind === 'overlay-owner' ? 'f'.repeat(64) : f.a.ownerKey,
        legacy: { storageKey: f.aliasKey, version: kind === 'alias-drift' ? 'e'.repeat(64) : await recoveryDigest(JSON.stringify(record)) } });
    }
    const before = await f.state.storage.list();
    const preview = await legacyPreview(f);
    expect(preview.item).toMatchObject({ key: f.key, status: 'blocked', reason });
    opaqueLegacy(f, preview.pages, [privateIdentity, ...(kind === 'overlay-owner' ? ['f'.repeat(64)] : []),
      ...(record.ownerKey === f.a.ownerKey ? [] : [record.ownerKey])]);
    expect(await f.state.storage.list()).toEqual(before);
  }));
});
