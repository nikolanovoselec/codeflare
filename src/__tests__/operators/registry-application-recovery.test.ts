/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, reset, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry } from '../../operators/registry';
import { applicationRecoveryPrefix, recoveryDigest, type RecoveryFacts } from '../../operators/application-recovery';
import { operatorOwnerKey } from '../../operators/browser-activity';
import { sealOperatorSecret } from '../../operators/protected-secrets';
import type { Env } from '../../types';

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
async function fixture(run: (f: Awaited<ReturnType<typeof seed>>) => Promise<void>) {
  const namespace = (env as unknown as { TIMEKEEPER: DurableObjectNamespace }).TIMEKEEPER;
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
  const facts: { value: RecoveryFacts } = { value: { resettable: true, reason: 'fenced-no-write', proofDigest: 'e'.repeat(64),
    origin: { generation: 1, deadline: 1 } } };
  const environment = { ENCRYPTION_KEY: btoa('k'.repeat(32)), KV: { get: async () => JSON.stringify({ role: 'admin' }) },
    CONTAINER: { idFromName: (name: string) => name, get: () => ({ claimBucketOwner: async () => 'owned' }) },
    OPERATOR_ACTIVITY: { getByName: () => ({ readRecoveryFacts: async () => facts.value,
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
  const ledger = { installationId: 'install', activityId: 'old', expectedOperatorRevision: 1, expectedInstallationRevision: 1,
    expectedControlsRevision: 1, selection: { operator, installation, release } };
  await state.storage.put(storageKey, original);
  state.storage.sql.exec('INSERT INTO operator_admissions VALUES(?,?)', 'old', JSON.stringify(ledger));
  const callback: { alter?: () => Promise<void>; malformed?: boolean; declineKey?: string; records: unknown[] } = { records: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) !== 'https://worker.example.test/control/recovery') { unsafe.push('SDK-runtime'); throw Error('Forbidden endpoint'); }
    const body = JSON.parse(String(init?.body));
    callback.records.push(...body.records);
    expect(body.records.length).toBeLessThanOrEqual(64);
    if (callback.alter) { const action = callback.alter; callback.alter = undefined; await action(); }
    if (callback.malformed) return Response.json({ items: [{ key: 'foreign', label: 'foreign', disposition: 'reset', reason: 'invalid' }] });
    return Response.json(body.operation === 'scope' ? { scope: { prefix: 'opaque:scope:', anchorKey: body.records[0].key }, items: [] }
      : { items: body.records.map((record: { key: string }) => record.key === callback.declineKey
        ? { key: record.key, label: 'Preserved record', disposition: 'skip', reason: 'Already processed' }
        : { key: record.key, label: 'Owned record', disposition: 'reset', reason: 'owner-reset', value: { reset: true } }) });
  });
  const base = { installationId: 'install', revision: 1, human, platformAdmin: false,
    authority: { operatorRevision: 1, controlsRevision: 1, expiresAt: human.expiresAt * 1000 } };
  const preview = (after?: string) => registry.recoverApplication({ ...base, operation: 'preview', after }) as Promise<{ items: Array<{ key: string; version: string; status: string }>; nextCursor: string | null }>;
  const resetRequest = async () => ({ ...base, operation: 'reset' as const, requestId: crypto.randomUUID(),
    entries: (await preview()).items.map(({ key, version }) => ({ key, version })) });
  return { registry, state, base, preview, resetRequest, callback, original, ledger, installation, operator, facts, saveOperator, storageKey, unsafe, prefix };
}

describe('real Registry recovery transaction', () => {
  it('resets a disabled approved installation, preserves origin/settings/ledger and replays without rewriting', () => fixture(async f => {
    const request = await f.resetRequest();
    expect(await f.registry.recoverApplication(request)).toEqual({ requestId: request.requestId, reset: 1, skipped: [] });
    expect(await f.state.storage.get(f.storageKey)).toEqual({ ...f.original, value: { reset: true } });
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
    expect(page.items).toContainEqual(expect.objectContaining({ key, label: 'Owned record', status: 'blocked', reason: 'owner-mismatch' }));
    expect(JSON.stringify(f.callback.records)).not.toContain('PRIVATE_FOREIGN');
    expect(await f.state.storage.get(storageKey)).toEqual(original);
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
