/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../../types';
import { setLogLevel } from '../../lib/logger';
import { OperatorRegistry, type DispatcherConnectionMetadata } from '../../operators/registry';
import { parseDispatcherBundle } from '../../operators/distribution';
import { verifyDispatcherDeployment } from '../../operators/dispatcher-deployment';
import { openOperatorSecret } from '../../operators/protected-secrets';
import { createMockKV } from '../helpers/mock-kv';
import { createOperatorGitHubFixture } from '../helpers/operator-github-fixture';
import { createDispatcherCloudflareFixture, type DispatcherPlatformFault, type UploadedDispatcher } from '../helpers/dispatcher-cloudflare-fixture';

let callerEmail = 'manager@example.test';
let callerRole = 'admin';
let identityCurrent = true;
let identityExpiry = 2_000_000_000;
vi.mock('../../middleware/auth', async original => ({ ...await original<typeof import('../../middleware/auth')>(),
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { email: callerEmail, role: callerRole, authenticated: true }); return next();
  },
}));
vi.mock('../../lib/access', async original => ({ ...await original<typeof import('../../lib/access')>(),
  authenticateRequest: async () => ({ user: { email: callerEmail, role: callerRole, authenticated: true }, bucketName: 'manager' }),
  requireOperatorHumanContext: async () => {
    if (!identityCurrent) throw new Error('Live identity unavailable');
    return { human: { subject: callerEmail, email: callerEmail, issuer: 'https://access.example.test',
      audiences: ['audience'], issuedAt: 1, expiresAt: identityExpiry }, accessJwt: 'fixture-access-jwt' };
  },
}));
import worker from '../../index';

afterEach(() => {
  callerEmail = 'manager@example.test'; callerRole = 'admin'; identityCurrent = true; identityExpiry = 2_000_000_000;
  setLogLevel('silent'); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const encryption = { ENCRYPTION_KEY: btoa('k'.repeat(32)) };
const grant = { users: ['manager@example.test'], groups: [] };
const invokers = { users: ['invoker@example.test'], groups: [] };
const policy = { capabilities: [], resourceProfileId: null, sourceResponseBytes: 4096 };
const configuration = { model: { provider: 'saved-provider', id: 'saved-model', reasoning: 'high' },
  installation: { labels: ['integration', 'éxact'], readOnly: true } };
type Installation = { id: string; operatorId: string; revision: number; enabled: boolean; releaseId: string | null;
  policy: typeof policy; configuration: unknown; dispatcherConnection?: DispatcherConnectionMetadata };
type Release = { id: string; approved: boolean; bundleDigest: string; manifestDigest: string; sourceCommit: string;
  provenance: { compilerCommit: string }; [key: string]: unknown };
type Detail = { operator: { id: string; revision: number; policy: Record<string, unknown>; managers: unknown; invokers: unknown;
  [key: string]: unknown }; installations: Installation[]; releases: Release[]; grants: unknown };
type Api = (path: string, method?: string, body?: unknown, csrf?: boolean) => Promise<Response>;

async function withActivation(test: (f: {
  request: Api; detail: () => Promise<Detail>; installation: Installation; release: Release; operatorId: string;
  platform: ReturnType<typeof createDispatcherCloudflareFixture>; github: Awaited<ReturnType<typeof createOperatorGitHubFixture>>;
  registry: OperatorRegistry; ctx: DurableObjectState; kv: ReturnType<typeof createMockKV>;
  bindings: Record<string, unknown>; beforeAccountRead: (hook: () => Promise<void>) => void;
}) => Promise<void>, options: { profile?: 'conductor' | 'dispatcher'; historical?: boolean; promote?: boolean } = {}) {
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const registry = new OperatorRegistry(ctx, encryption);
    const platform = createDispatcherCloudflareFixture();
    const github = await createOperatorGitHubFixture({ profile: options.profile ?? 'dispatcher',
      normalDispatcher: options.profile !== 'conductor' && !options.historical });
    const kv = createMockKV();
    kv._store.set('setup:account_id', platform.accountId);
    let accountHook: (() => Promise<void>) | undefined;
    const originalGet = kv.get.getMockImplementation()!;
    kv.get.mockImplementation(async (key: string, type?: string) => {
      const value = await originalGet(key, type);
      if (key === 'setup:account_id' && accountHook) { const hook = accountHook; accountHook = undefined; await hook(); }
      return value;
    });
    const bindings: Record<string, unknown> = { ...encryption, KV: kv, ENTERPRISE_MODE: 'active',
      CLOUDFLARE_API_TOKEN: platform.token, CLOUDFLARE_WORKER_NAME: platform.parentName,
      OPERATOR_REGISTRY: { getByName: () => registry } };
    const request: Api = (path, method = 'GET', body, csrf = true) => worker.fetch(new Request(
      `https://enterprise.example.test/api/operator-management${path}`, { method, headers: {
        'content-type': 'application/json', 'cf-access-authenticated-user-email': callerEmail,
        ...(csrf ? { 'x-requested-with': 'XMLHttpRequest' } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), bindings as unknown as Env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const outgoing = new Request(input, init);
      return new URL(outgoing.url).hostname === 'api.cloudflare.com' ? platform.fetcher(outgoing) : github.fetcher(outgoing);
    });
    expect((await request('/access', 'POST', { revision: 0, managers: grant,
      ceiling: { capabilities: [], resourceProfileIds: [], sourceResponseBytes: 8192 } })).status).toBe(200);
    const registered = await request('/operators', 'POST', { repositoryUrl: 'https://github.com/acme/review-operator',
      githubPat: 'acquisition-only-pat', profile: options.profile ?? 'dispatcher', realm: 'internal', managers: grant, invokers, policy });
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { operatorId: string; revision: number };
    if (options.profile !== 'conductor') {
      expect((await request(`/operators/${operator.operatorId}/capabilities`, 'POST', { revision: operator.revision,
        capabilities: [], submissionAttemptLimit: 17, inferenceAttemptLimit: 3, operationLimit: 99, loggingEnabled: false })).status).toBe(200);
    }
    const detail = async () => {
      const response = await request(`/operators/${operator.operatorId}`);
      expect(response.status).toBe(200); return response.json() as Promise<Detail>;
    };
    const initial = await detail();
    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: initial.operator.revision });
    expect(refreshed.status).toBe(200);
    const release = (await refreshed.json() as { items: Release[] }).items[0]!;
    const acquired = await detail();
    const created = await request(`/operators/${operator.operatorId}/installations`, 'POST', {
      name: 'normal Integration', revision: acquired.operator.revision, policy, configuration });
    expect(created.status).toBe(201);
    let installation = await created.json() as Installation;
    if (options.promote !== false) {
      const promoted = await request(`/installations/${installation.id}/promote`, 'POST', { revision: installation.revision, releaseId: release.id });
      expect(promoted.status).toBe(200); installation = await promoted.json() as Installation;
    }
    callerRole = 'user'; // Exercise both eligibility and Operator ACL, not only an admin bypass.
    await test({ request, detail, installation, release, operatorId: operator.operatorId, platform, github, registry, ctx, kv,
      bindings, beforeAccountRead: hook => { accountHook = hook; } });
  });
}
function enable(f: { request: Api; installation: Installation }, installation = f.installation) {
  return f.request(`/installations/${installation.id}/enable`, 'POST', { revision: installation.revision, enabled: true });
}
async function expectNoActivity(ctx: DurableObjectState) {
  // Durable admission/index outcomes, not a mock runtime call count.
  expect(ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM operator_admissions').one().n).toBe(0);
  expect(await ctx.storage.list({ prefix: 'owner-activities:' })).toEqual(new Map());
}
function uploadedSecret(script: UploadedDispatcher): string {
  const secret = script.metadata.bindings.find(binding => binding.name === 'OPERATOR_CONNECTION_SECRET');
  expect(secret).toMatchObject({ type: 'secret_text', text: expect.any(String) });
  expect(secret!.text!.length).toBeGreaterThanOrEqual(32);
  return secret!.text!;
}
function captureLogs() {
  const lines: unknown[][] = [];
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args); });
  setLogLevel('info');
  return () => JSON.stringify(lines);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// REQ-OPERATOR-046 AC4 is the normal UI's existing Enable API contract; these tests do not add a deploy endpoint.
describe('approved normal Dispatcher activation through existing management Enable', () => {
  it('REQ-OPERATOR-046: AC1/4 promotion stays disabled; Enable provisions exact approved bytes without a preconfigured connection', () => withActivation(async f => {
    const logs = captureLogs();
    const before = await f.detail();
    expect(before.installations).toEqual([f.installation]);
    expect(f.installation).toMatchObject({ enabled: false, releaseId: f.release.id });
    expect(f.installation.dispatcherConnection).toBeUndefined();
    expect(f.platform.scripts.size).toBe(0);
    const response = await enable(f);
    expect(response.status).toBe(200); // Current production returns409: the missing handoff.
    const enabled = await response.json() as Installation;
    expect(enabled).toMatchObject({ id: f.installation.id, enabled: true, releaseId: f.release.id,
      policy: f.installation.policy, configuration: f.installation.configuration,
      dispatcherConnection: { installationId: f.installation.id, releaseId: f.release.id,
        sourceCommit: f.release.sourceCommit, compilerCommit: f.release.provenance.compilerCommit,
        manifestDigest: f.release.manifestDigest, bundleDigest: f.release.bundleDigest } });
    expect(enabled.revision).toBeGreaterThan(f.installation.revision);
    const connection = enabled.dispatcherConnection!;
    const script = f.platform.scripts.get(connection.workerName)!;
    expect(script).toMatchObject({ versionId: connection.workerVersionId, subdomainEnabled: true,
      subdomainRequest: { enabled: true, previews_enabled: false } });
    const bytes = await f.registry.getManagementBundle(f.release.bundleDigest);
    const bundle = await parseDispatcherBundle(bytes!, f.release.bundleDigest);
    // Both documented ESM MIME aliases are accepted by the deployed-version verifier.
    for (const module of script.modules) if ('js' in bundle.modules[module.name])
      expect(['application/javascript+module', 'text/javascript+module']).toContain(module.type);
    expect(script.modules.map(module => ({ ...module, type: module.type === 'text/javascript+module' ? 'application/javascript+module' : module.type }))
      .sort((a, b) => a.name.localeCompare(b.name))).toEqual(Object.entries(bundle.modules)
      .map(([name, value]) => ({ name, type: 'js' in value ? 'application/javascript+module' : 'text/plain',
        bytes: [...new TextEncoder().encode('js' in value ? value.js : value.text)] })).sort((a, b) => a.name.localeCompare(b.name)));
    expect(script.metadata).toMatchObject({ main_module: bundle.mainModule, compatibility_date: bundle.compatibilityDate,
      compatibility_flags: bundle.compatibilityFlags, migrations: { new_tag: bundle.hosting!.migrationTag,
        new_sqlite_classes: [bundle.hosting!.className] } });
    expect(script.metadata.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'FLUE_DISPATCHER_AGENT', type: 'durable_object_namespace', class_name: bundle.hosting!.className }),
      expect.objectContaining({ name: 'OPERATOR', type: 'service', service: f.platform.parentName, entrypoint: 'OperatorInstalledDispatcherCapability' }),
      { name: 'CF_VERSION_METADATA', type: 'version_metadata' },
      { name: 'OPERATOR_INSTALLATION_ID', type: 'plain_text', text: f.installation.id },
      { name: 'OPERATOR_RELEASE_ID', type: 'plain_text', text: f.release.id },
      { name: 'OPERATOR_CONNECTION_REVISION', type: 'plain_text', text: String(connection.connectionRevision) },
      { name: 'OPERATOR_SUBMISSION_ATTEMPT_LIMIT', type: 'plain_text', text: '17' },
    ]));
    expect(script.metadata.bindings.map(binding => binding.name).sort()).toEqual([
      'CF_VERSION_METADATA', 'FLUE_DISPATCHER_AGENT', 'OPERATOR', 'OPERATOR_CONNECTION_REVISION',
      'OPERATOR_CONNECTION_SECRET', 'OPERATOR_INSTALLATION_ID', 'OPERATOR_RELEASE_ID', 'OPERATOR_SUBMISSION_ATTEMPT_LIMIT',
    ].sort()); // Installation-only wire allowlist: never acquisition/provider/platform credentials.
    const secret = uploadedSecret(script);
    expect(secret).not.toBe(f.platform.token);
    expect(secret).not.toBe('acquisition-only-pat');
    const retained = await f.registry.getManagementDispatcherConnection(enabled.id);
    expect(retained).toMatchObject({ workerName: script.name, workerVersionId: script.versionId,
      controlOrigin: `https://${script.name}.platform-account.workers.dev` });
    await expect(openOperatorSecret(retained!.connectionSecretCiphertext, encryption,
      { purpose: 'connection', recordId: enabled.id })).resolves.toBe(secret);
    await expect(openOperatorSecret(retained!.connectionSecretCiphertext, encryption,
      { purpose: 'connection', recordId: 'foreign-installation' })).rejects.toThrow();
    const raw = f.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_installations WHERE id=?', enabled.id).one().data;
    expect(raw).not.toContain(secret);
    const after = await f.detail();
    expect(after.grants).toEqual(before.grants);
    expect(after.operator.policy).toEqual(before.operator.policy);
    expect(after.releases).toEqual(before.releases);
    const publicBytes = JSON.stringify({ enabled, after });
    for (const sensitive of [secret, retained!.connectionSecretCiphertext, f.platform.token, 'acquisition-only-pat', 'fixture-access-jwt'])
      { expect(publicBytes).not.toContain(sensitive); expect(logs()).not.toContain(sensitive); }
    expect(f.platform.unexpected).toEqual([]);
    await expectNoActivity(f.ctx);
  }));

  it('REQ-OPERATOR-046/048: AC5 matching connection verifies and reuses its existing Worker, secret and namespace', () => withActivation(async f => {
    const first = await enable(f); expect(first.status).toBe(200);
    const active = await first.json() as Installation;
    const selected = active.dispatcherConnection!;
    const original = structuredClone(f.platform.scripts.get(selected.workerName));
    const disabled = await f.request(`/installations/${active.id}/enable`, 'POST', { revision: active.revision, enabled: false });
    expect(disabled.status).toBe(200);
    const stopped = await disabled.json() as Installation;
    const writes = structuredClone(f.platform.writes);
    const reused = await enable(f, stopped); expect(reused.status).toBe(200);
    expect(await reused.json()).toMatchObject({ enabled: true, dispatcherConnection: selected });
    expect(f.platform.writes).toEqual(writes); // No protected deployment mutation on reuse.
    expect(f.platform.scripts.get(selected.workerName)).toEqual(original);
    await expectNoActivity(f.ctx);
  }));

  it('REQ-OPERATOR-046/048: AC3/7 upgrade creates a distinct Worker and SQLite namespace while preserving original runtime and history', () => withActivation(async f => {
    const first = await enable(f); expect(first.status).toBe(200);
    const originalInstallation = await first.json() as Installation;
    const original = structuredClone(f.platform.scripts.get(originalInstallation.dispatcherConnection!.workerName)!);
    const historical = await f.registry.getManagementConfigurationHistory(originalInstallation.id, originalInstallation.revision);
    f.github.setReleaseCount(2);
    const operator = (await f.detail()).operator;
    const refreshed = await f.request(`/operators/${f.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(refreshed.status).toBe(200);
    const releases = (await refreshed.json() as { items: Release[] }).items;
    const next = releases.find(release => release.id !== f.release.id)!;
    const promoted = await f.request(`/installations/${originalInstallation.id}/promote`, 'POST', {
      revision: originalInstallation.revision, releaseId: next.id });
    expect(promoted.status).toBe(200);
    const pending = await promoted.json() as Installation;
    expect(pending).toMatchObject({ enabled: false, releaseId: next.id, configuration, policy });
    expect(f.platform.scripts.get(original.name)).toEqual(original);
    const response = await enable(f, pending); expect(response.status).toBe(200);
    const upgraded = await response.json() as Installation;
    expect(upgraded).toMatchObject({ enabled: true, releaseId: next.id, configuration, policy,
      dispatcherConnection: { releaseId: next.id, bundleDigest: next.bundleDigest } });
    const selected = f.platform.scripts.get(upgraded.dispatcherConnection!.workerName)!;
    expect(selected.name).not.toBe(original.name);
    expect(selected.namespaceId).not.toBe(original.namespaceId);
    expect(f.platform.scripts.get(original.name)).toEqual(original);
    expect(await f.registry.getManagementConfigurationHistory(originalInstallation.id, originalInstallation.revision)).toEqual(historical);
    expect(await f.registry.getManagementDispatcherAbortConnection(originalInstallation.id,
      originalInstallation.dispatcherConnection!.connectionRevision)).toMatchObject({ workerName: original.name, workerVersionId: original.versionId });
    await expectNoActivity(f.ctx);
  }));

  it.each(['upload-uncertain', 'changed-module'] as const)(
    'REQ-OPERATOR-046/048: AC6/7 failed upgrade with %s retains the original connection, Worker, namespace and history', fault => withActivation(async f => {
      const first = await enable(f); expect(first.status).toBe(200);
      const originalInstallation = await first.json() as Installation;
      const connection = originalInstallation.dispatcherConnection!;
      const original = structuredClone(f.platform.scripts.get(connection.workerName)!);
      const historical = await f.registry.getManagementConfigurationHistory(originalInstallation.id, originalInstallation.revision);
      expect(historical).toMatchObject({ id: originalInstallation.id, revision: originalInstallation.revision,
        releaseId: f.release.id, enabled: true, dispatcherConnection: connection });
      const abortConnection = await f.registry.getManagementDispatcherAbortConnection(originalInstallation.id, connection.connectionRevision);
      expect(abortConnection).toMatchObject({ workerName: original.name, workerVersionId: original.versionId,
        releaseId: f.release.id, connectionRevision: connection.connectionRevision });
      f.github.setReleaseCount(2);
      const operator = (await f.detail()).operator;
      const refreshed = await f.request(`/operators/${f.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
      expect(refreshed.status).toBe(200);
      const releases = (await refreshed.json() as { items: Release[] }).items;
      const next = releases.find(release => release.id !== f.release.id)!;
      const promoted = await f.request(`/installations/${originalInstallation.id}/promote`, 'POST', {
        revision: originalInstallation.revision, releaseId: next.id });
      expect(promoted.status).toBe(200);
      const pending = await promoted.json() as Installation;
      expect(pending).toMatchObject({ enabled: false, releaseId: next.id, configuration, policy, dispatcherConnection: connection });

      f.platform.setFault(fault);
      const response = await enable(f, pending);
      expect(response.status).toBeGreaterThanOrEqual(400);
      const candidates = [...f.platform.scripts.values()].filter(script => script.name !== original.name);
      expect(candidates).toEqual([expect.objectContaining({ name: expect.any(String) })]);
      const candidate = candidates[0]!;
      expect(candidate.namespaceId).not.toBe(original.namespaceId);
      expect(candidate.metadata.bindings).toContainEqual({ name: 'OPERATOR_RELEASE_ID', type: 'plain_text', text: next.id });
      const current = (await f.detail()).installations.find(installation => installation.id === originalInstallation.id)!;
      expect(current).toMatchObject({ enabled: false, releaseId: next.id, configuration, policy, dispatcherConnection: connection });
      expect(current.dispatcherConnection!.workerName).not.toBe(candidate.name);
      expect(current.dispatcherConnection!.workerVersionId).not.toBe(candidate.versionId);
      expect(f.platform.scripts.get(original.name)).toEqual(original);
      expect(await f.registry.getManagementDispatcherAbortConnection(originalInstallation.id, connection.connectionRevision)).toEqual(abortConnection);
      expect(await f.registry.getManagementConfigurationHistory(originalInstallation.id, originalInstallation.revision)).toEqual(historical);
      expect((await f.registry.resolveManagementExecution(originalInstallation.id)).ok).toBe(false);
      await expectNoActivity(f.ctx);
    }));

  it('REQ-OPERATOR-046/048: AC4 separate installations never share deployment storage or connection credentials', () => withActivation(async f => {
    const first = await enable(f); expect(first.status).toBe(200);
    const originalInstallation = await first.json() as Installation;
    const original = structuredClone(f.platform.scripts.get(originalInstallation.dispatcherConnection!.workerName)!);
    const before = await f.detail();
    const created = await f.request(`/operators/${f.operatorId}/installations`, 'POST', {
      name: 'independent staging', revision: before.operator.revision, policy, configuration: { independent: true } });
    expect(created.status).toBe(201);
    const sibling = await created.json() as Installation;
    const promoted = await f.request(`/installations/${sibling.id}/promote`, 'POST', { revision: sibling.revision, releaseId: f.release.id });
    expect(promoted.status).toBe(200);
    const selected = await promoted.json() as Installation;
    const response = await enable(f, selected); expect(response.status).toBe(200);
    const activeSibling = await response.json() as Installation;
    const runtime = f.platform.scripts.get(activeSibling.dispatcherConnection!.workerName)!;
    expect(runtime.name).not.toBe(original.name);
    expect(runtime.namespaceId).not.toBe(original.namespaceId);
    expect(uploadedSecret(runtime)).not.toBe(uploadedSecret(original));
    expect(runtime.metadata.bindings).toContainEqual({ name: 'OPERATOR_INSTALLATION_ID', type: 'plain_text', text: sibling.id });
    expect((await f.detail()).installations).toEqual(expect.arrayContaining([originalInstallation,
      expect.objectContaining({ id: sibling.id, enabled: true, configuration: { independent: true } })]));
    expect(f.platform.scripts.get(original.name)).toEqual(original);
    await expectNoActivity(f.ctx);
  }));

  it('REQ-OPERATOR-046/048: AC6 retry after uncertain upload creates a fresh candidate without mutating the retained orphan', () => withActivation(async f => {
    f.platform.setFault('upload-uncertain');
    expect((await enable(f)).status).toBeGreaterThanOrEqual(400);
    expect([...f.platform.scripts.values()]).toEqual([expect.objectContaining({ name: expect.any(String) })]);
    const orphan = structuredClone([...f.platform.scripts.values()][0]!);
    const pending = (await f.detail()).installations[0]!;
    expect(pending).toMatchObject({ enabled: false, revision: f.installation.revision });
    expect(pending.dispatcherConnection).toBeUndefined();
    f.platform.setFault('none');
    const response = await enable(f, pending); expect(response.status).toBe(200);
    const active = await response.json() as Installation;
    const selected = f.platform.scripts.get(active.dispatcherConnection!.workerName)!;
    expect(selected.name).not.toBe(orphan.name);
    expect(selected.namespaceId).not.toBe(orphan.namespaceId);
    expect(f.platform.scripts.get(orphan.name)).toEqual(orphan);
    expect(active).toMatchObject({ enabled: true, configuration, policy });
    await expectNoActivity(f.ctx);
  }));

  it.each<DispatcherPlatformFault>(['upload-denied', 'upload-uncertain', 'active-version-missing', 'subdomain-denied',
    'changed-module', 'foreign-parent', 'non-sqlite', 'active-version-drift', 'version-unavailable', 'wrong-installation', 'wrong-limit'])(
    'REQ-OPERATOR-030/044/046/048: AC6 %s cannot enable or expose platform/connection credentials', fault => withActivation(async f => {
      const logs = captureLogs();
      f.platform.setFault(fault);
      const response = await enable(f);
      expect(response.status).toBeGreaterThanOrEqual(400);
      const publicError = await response.text();
      expect(f.platform.writes).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'PUT',
        path: expect.stringMatching(new RegExp(`^/client/v4/accounts/${f.platform.accountId}/workers/scripts/[a-z0-9-]+$`)) })]));
      if (fault !== 'upload-denied') expect([...f.platform.scripts.values()]).toEqual([expect.objectContaining({ name: expect.any(String) })]);
      for (const sensitive of [f.platform.token, 'acquisition-only-pat', 'fixture-access-jwt']) {
        expect(publicError).not.toContain(sensitive); expect(logs()).not.toContain(sensitive);
      }
      const current = await f.detail();
      expect(current.installations[0]).toMatchObject({ enabled: false, releaseId: f.release.id, policy, configuration });
      expect(current.installations[0]!.dispatcherConnection).toBeUndefined(); // Candidate verification must precede Registry configuration.
      const publicState = JSON.stringify(current);
      for (const script of f.platform.scripts.values()) {
        expect(publicError).not.toContain(uploadedSecret(script));
        expect(publicState).not.toContain(uploadedSecret(script));
        expect(logs()).not.toContain(uploadedSecret(script));
      }
      expect((await f.registry.resolveManagementExecution(f.installation.id)).ok).toBe(false);
      await expectNoActivity(f.ctx);
    }));

  it.each<DispatcherPlatformFault>(['changed-module', 'foreign-parent', 'non-sqlite', 'active-version-drift', 'version-unavailable'])(
    'REQ-OPERATOR-046/048: AC5/6 matching connection with %s drift fails verification without overwriting the deployment', fault => withActivation(async f => {
      const initial = await enable(f); expect(initial.status).toBe(200);
      const enabled = await initial.json() as Installation;
      const disabled = await f.request(`/installations/${enabled.id}/enable`, 'POST', { revision: enabled.revision, enabled: false });
      expect(disabled.status).toBe(200);
      const stopped = await disabled.json() as Installation;
      const writes = structuredClone(f.platform.writes);
      const uploaded = structuredClone(f.platform.uploads);
      f.platform.setFault(fault);
      expect((await enable(f, stopped)).status).toBe(409);
      expect((await f.detail()).installations[0]).toMatchObject({ enabled: false, dispatcherConnection: stopped.dispatcherConnection });
      expect(f.platform.writes).toEqual(writes);
      expect(f.platform.uploads).toEqual(uploaded);
      await expectNoActivity(f.ctx);
    }));

  it.each(['stale', 'foreign', 'invoker', 'csrf', 'caller-account', 'caller-script', 'caller-url', 'caller-service'] as const)(
    'REQ-OPERATOR-045/046: AC2/6 %s Enable is refused before any protected Cloudflare upload', variant => withActivation(async f => {
      const before = await f.detail();
      const body: Record<string, unknown> = { revision: f.installation.revision, enabled: true };
      let csrf = true;
      if (variant === 'stale') body.revision = f.installation.revision - 1;
      if (variant === 'foreign') callerEmail = 'outsider@example.test';
      if (variant === 'invoker') callerEmail = 'invoker@example.test';
      if (variant === 'csrf') csrf = false;
      if (variant === 'caller-account') body.accountId = 'b'.repeat(32);
      if (variant === 'caller-script') body.workerName = 'caller-selected-worker';
      if (variant === 'caller-url') body.controlOrigin = 'https://attacker.example.test';
      if (variant === 'caller-service') body.parentService = 'foreign-parent';
      const response = await f.request(`/installations/${f.installation.id}/enable`, 'POST', body, csrf);
      expect(response.status).toBe(variant === 'stale' ? 409 : variant === 'csrf' ? 403 : variant === 'foreign' || variant === 'invoker' ? 404 : 400);
      callerEmail = 'manager@example.test';
      expect(await f.detail()).toEqual(before);
      expect(f.platform.writes).toEqual([]);
      expect([...f.platform.scripts.values()]).toEqual([]);
      await expectNoActivity(f.ctx);
    }));

  it.each(['missing-account', 'invalid-account', 'missing-parent', 'missing-token', 'missing-encryption', 'invalid-encryption'] as const)(
    'REQ-OPERATOR-030/045/046: AC6 %s configuration fails closed without protected upload', variant => withActivation(async f => {
      if (variant === 'missing-account') f.kv._store.delete('setup:account_id');
      if (variant === 'invalid-account') f.kv._store.set('setup:account_id', '../foreign-account');
      if (variant === 'missing-parent') delete f.bindings.CLOUDFLARE_WORKER_NAME;
      if (variant === 'missing-token') delete f.bindings.CLOUDFLARE_API_TOKEN;
      if (variant === 'missing-encryption') delete f.bindings.ENCRYPTION_KEY;
      if (variant === 'invalid-encryption') {
        f.bindings.ENCRYPTION_KEY = 'not-valid-key-material';
        try {
          // Worker.fetch imports the configured key before entering the management HTTP error boundary.
          await expect(enable(f)).rejects.toThrow();
        } finally { f.bindings.ENCRYPTION_KEY = encryption.ENCRYPTION_KEY; }
      } else {
        const response = await enable(f);
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
      expect((await f.detail()).installations[0]).toMatchObject({ enabled: false, policy, configuration });
      expect(f.platform.writes).toEqual([]);
      await expectNoActivity(f.ctx);
    }));

  it.each(['missing-bytes', 'digest-mismatch', 'invalid-schema', 'unapproved-release', 'source-mismatch', 'missing-compiler'] as const)(
    'REQ-OPERATOR-030/044/046: AC6 %s artifact cannot cause any protected upload', variant => withActivation(async f => {
      if (variant === 'missing-bytes') f.ctx.storage.sql.exec('DELETE FROM operator_bytes WHERE digest=?', f.release.bundleDigest);
      else if (variant === 'digest-mismatch') f.ctx.storage.sql.exec('UPDATE operator_bytes SET bytes=? WHERE digest=?',
        new TextEncoder().encode('not-json-must-not-deploy').buffer, f.release.bundleDigest);
      else if (variant === 'invalid-schema') {
        // Corrupt retained storage with a self-consistent byte digest: the activation boundary must still parse the schema.
        const original = await f.registry.getManagementBundle(f.release.bundleDigest);
        const invalid = { ...JSON.parse(new TextDecoder().decode(original!)), bindings: { SECRET: 'must-not-deploy' } };
        const bytes = new TextEncoder().encode(JSON.stringify(invalid));
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map(byte => byte.toString(16).padStart(2, '0')).join('');
        const row = f.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_releases WHERE id=?', f.release.id).one();
        const release = { ...JSON.parse(row.data) as Release, bundleDigest: digest };
        f.ctx.storage.sql.exec('INSERT INTO operator_bytes(digest,part,bytes) VALUES(?,?,?)', digest, 0, bytes);
        f.ctx.storage.sql.exec('UPDATE operator_releases SET data=? WHERE id=?', JSON.stringify(release), release.id);
      } else {
        const row = f.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_releases WHERE id=?', f.release.id).one();
        const release = JSON.parse(row.data) as Release;
        if (variant === 'unapproved-release') release.approved = false;
        if (variant === 'source-mismatch') release.sourceCommit = 'b'.repeat(40);
        if (variant === 'missing-compiler') delete (release.provenance as { compilerCommit?: string }).compilerCommit;
        f.ctx.storage.sql.exec('UPDATE operator_releases SET data=? WHERE id=?', JSON.stringify(release), release.id);
      }
      const response = await enable(f);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toContain('must-not-deploy');
      expect((await f.detail()).installations[0]).toMatchObject({ enabled: false, policy, configuration });
      expect(f.platform.writes).toEqual([]);
      await expectNoActivity(f.ctx);
    }));

  it('REQ-OPERATOR-046: AC1/6 unpromoted acquired release never provisions or becomes enabled', () => withActivation(async f => {
    const before = await f.detail();
    expect(before.releases[0]).toMatchObject({ approved: false });
    expect((await enable(f)).status).toBe(409);
    expect(await f.detail()).toEqual(before);
    expect(f.platform.writes).toEqual([]);
    await expectNoActivity(f.ctx);
  }, { promote: false }));

  it.each(['identity-revoked', 'identity-expired', 'controls-changed', 'operator-grants-changed', 'installation-changed'] as const)(
    'REQ-OPERATOR-045/046: AC3/6 %s during account lookup is rechecked before protected upload', variant => withActivation(async f => {
      let accountLookupSettled = false;
      f.beforeAccountRead(async () => {
        accountLookupSettled = true;
        if (variant === 'identity-revoked') identityCurrent = false;
        if (variant === 'identity-expired') identityExpiry = Math.floor(Date.now() / 1000) - 1;
        if (variant === 'controls-changed') {
          callerRole = 'admin';
          expect((await f.request('/access', 'POST', { revision: 1, managers: { users: [], groups: [] },
            ceiling: { capabilities: [], resourceProfileIds: [], sourceResponseBytes: 8192 } })).status).toBe(200);
          callerRole = 'user';
        }
        if (variant === 'operator-grants-changed') {
          const operator = (await f.detail()).operator;
          expect((await f.request(`/operators/${f.operatorId}/grants`, 'POST', { revision: operator.revision,
            managers: { users: [], groups: [] }, invokers })).status).toBe(200);
        }
        if (variant === 'installation-changed') expect((await f.request(`/installations/${f.installation.id}/configure`, 'POST', {
          revision: f.installation.revision, policy, configuration: { concurrent: 'must survive' } })).status).toBe(200);
      });
      const response = await enable(f);
      expect(response.status).toBeGreaterThanOrEqual(400);
      identityCurrent = true; identityExpiry = 2_000_000_000; callerRole = 'admin';
      expect(accountLookupSettled).toBe(true); // Guard: the test actually crossed the awaited KV boundary.
      expect((await f.detail()).installations[0]).toMatchObject({ enabled: false,
        configuration: variant === 'installation-changed' ? { concurrent: 'must survive' } : configuration });
      expect(f.platform.writes).toEqual([]);
      await expectNoActivity(f.ctx);
    }));

  it.each(['identity-revoked', 'identity-expired', 'controls-changed', 'operator-changed', 'installation-changed'] as const)(
    'REQ-OPERATOR-045/046: AC3/6 %s after upload cannot select a connection or enable late work', variant => withActivation(async f => {
      f.platform.afterUpload(async () => {
        if (variant === 'identity-revoked') identityCurrent = false;
        if (variant === 'identity-expired') identityExpiry = Math.floor(Date.now() / 1000) - 1;
        if (variant === 'controls-changed') {
          callerRole = 'admin';
          expect((await f.request('/access', 'POST', { revision: 1, managers: { users: [], groups: [] },
            ceiling: { capabilities: [], resourceProfileIds: [], sourceResponseBytes: 8192 } })).status).toBe(200);
          callerRole = 'user';
        }
        if (variant === 'operator-changed') {
          const operator = (await f.detail()).operator;
          expect((await f.request(`/operators/${f.operatorId}/capabilities`, 'POST', { revision: operator.revision,
            capabilities: [], submissionAttemptLimit: 19 })).status).toBe(200);
        }
        if (variant === 'installation-changed') expect((await f.request(`/installations/${f.installation.id}/configure`, 'POST', {
          revision: f.installation.revision, policy, configuration: { concurrent: 'must survive' } })).status).toBe(200);
      });
      const response = await enable(f);
      expect(response.status).toBeGreaterThanOrEqual(400);
      identityCurrent = true; identityExpiry = 2_000_000_000; callerRole = 'admin';
      expect([...f.platform.scripts.values()]).toEqual([expect.objectContaining({ name: expect.any(String) })]);
      const current = (await f.detail()).installations[0]!;
      expect(current).toMatchObject({ enabled: false,
        configuration: variant === 'installation-changed' ? { concurrent: 'must survive' } : configuration });
      expect(current.dispatcherConnection).toBeUndefined();
      expect((await f.registry.resolveManagementExecution(f.installation.id)).ok).toBe(false);
      await expectNoActivity(f.ctx);
    }));

  it('REQ-OPERATOR-045/046: AC3/6 revocation during actual version verification cannot enable an uploaded Worker', () => withActivation(async f => {
    let versionReadSettled = false;
    f.platform.beforeVersionRead(async () => { versionReadSettled = true; identityCurrent = false; });
    const response = await enable(f);
    expect(response.status).toBeGreaterThanOrEqual(400);
    identityCurrent = true;
    expect(versionReadSettled).toBe(true); // Guard paired with disabled/execution-denied outcomes below.
    expect((await f.detail()).installations[0]).toMatchObject({ enabled: false, releaseId: f.release.id });
    expect((await f.detail()).installations[0]!.dispatcherConnection).toBeUndefined();
    expect((await f.registry.resolveManagementExecution(f.installation.id)).ok).toBe(false);
    await expectNoActivity(f.ctx);
  }));

  it('REQ-OPERATOR-046/048: AC2/6 concurrent Enable attempts select one runtime without overwriting selected code or namespace', () => withActivation(async f => {
    const uploaded = deferred(); const release = deferred();
    let firstUpload = true;
    f.platform.afterUpload(async () => {
      if (!firstUpload) return;
      firstUpload = false; uploaded.resolve(); await release.promise;
    });
    const first = enable(f);
    let second: Promise<Response> | undefined;
    try {
      // Racing a terminal HTTP response avoids hanging RED when the missing handoff never uploads.
      const reachedUpload = await Promise.race([uploaded.promise.then(() => true), first.then(() => false)]);
      expect(reachedUpload).toBe(true);
      second = enable(f);
      const secondResponse = await second;
      expect([200, 409]).toContain(secondResponse.status);
      const winnerBeforeRelease = secondResponse.status === 200 ? await secondResponse.json() as Installation : undefined;
      const retained = winnerBeforeRelease ? structuredClone(f.platform.scripts.get(winnerBeforeRelease.dispatcherConnection!.workerName)) : undefined;
      release.resolve();
      const firstResponse = await first;
      expect([firstResponse.status, secondResponse.status].sort()).toEqual([200, 409]);
      const winner = winnerBeforeRelease ?? await firstResponse.json() as Installation;
      const selected = (await f.detail()).installations[0]!;
      expect(selected).toMatchObject({ enabled: true, dispatcherConnection: winner.dispatcherConnection, configuration, policy });
      const runtime = f.platform.scripts.get(selected.dispatcherConnection!.workerName)!;
      expect(runtime).toMatchObject({ versionId: selected.dispatcherConnection!.workerVersionId, subdomainEnabled: true });
      if (retained) expect(runtime).toEqual(retained);
      expect(new Set(f.platform.uploads.map(script => script.name)).size).toBe(f.platform.uploads.length);
      expect(new Set(f.platform.uploads.map(script => script.namespaceId)).size).toBe(f.platform.uploads.length);
      await expectNoActivity(f.ctx);
    } finally { release.resolve(); await first; if (second) await second; }
  }));

  it.each([{ profile: 'conductor' as const }, { historical: true }])(
    'REQ-OPERATOR-044/046/048: AC4 non-normal release %j preserves its original Enable semantics without Cloudflare provisioning', options => withActivation(async f => {
      const response = await enable(f); expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ enabled: true, releaseId: f.release.id, policy, configuration });
      expect((await f.detail()).installations[0]!.dispatcherConnection).toBeUndefined();
      expect(f.platform.writes).toEqual([]);
      expect(f.platform.scripts.size).toBe(0);
      await expectNoActivity(f.ctx);
    }, options));
});

// Public Cloudflare upload/settings wire, not a source-text assertion and not
// evidence of real deployed delivery. Readiness is additive to deployment identity:
// an optional logging gap must NEVER invalidate existing execution authority.
describe('persisted installed Worker execution log configuration', () => {
  const desired = { enabled: true, head_sampling_rate: 1,
    logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true, persist: true } };

  it('REQ-OPERATOR-030/044/045/046/090: provision requests complete persisted invocation logs at sampling one on the actual public upload wire', () => withActivation(async f => {
    const response = await enable(f); expect(response.status).toBe(200);
    const active = await response.json() as Installation;
    const script = f.platform.scripts.get(active.dispatcherConnection!.workerName)!;
    expect(script.metadata.observability).toEqual(desired);
    expect(script.versionId).toBe(active.dispatcherConnection!.workerVersionId);
    expect(script.metadata.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'OPERATOR', service: f.platform.parentName, entrypoint: 'OperatorInstalledDispatcherCapability' }),
    ]));
    expect(script.namespaceId).toMatch(/^[a-f0-9]{32}$/);
    await expectNoActivity(f.ctx);
  }));

  it('REQ-OPERATOR-046/090: actual settings readback qualifies logging readiness separately from exact immutable deployment identity', () => withActivation(async f => {
    expect((await enable(f)).status).toBe(200);
    const selected = (await f.detail()).installations[0]!.dispatcherConnection!;
    f.platform.setObservability(desired);
    const original = structuredClone(f.platform.scripts.get(selected.workerName));
    const writes = structuredClone(f.platform.writes);
    const bytes = (await f.registry.getManagementBundle(f.release.bundleDigest))!;
    // Intentional additive public verification result; baseline has no readiness field.
    const verification = await verifyDispatcherDeployment(f.bindings as unknown as Env, selected, bytes, 17) as
      Awaited<ReturnType<typeof verifyDispatcherDeployment>> & { observabilityReady?: boolean };
    expect(verification).toMatchObject({ connectionRevision: selected.connectionRevision, workerVersionId: selected.workerVersionId,
      bundleDigest: selected.bundleDigest, controlOrigin: `https://${selected.workerName}.platform-account.workers.dev`, observabilityReady: true });
    expect(f.platform.writes).toEqual(writes);
    expect(f.platform.scripts.get(selected.workerName)).toEqual(original);
    await expectNoActivity(f.ctx);
  }));

  it.each([
    { name: 'null actual settings', value: null },
    { name: 'missing actual settings', value: undefined },
    { name: 'global disabled', value: { ...desired, enabled: false } },
    { name: 'logs disabled', value: { ...desired, logs: { ...desired.logs, enabled: false } } },
    { name: 'nonpersisted logs', value: { ...desired, logs: { ...desired.logs, persist: false } } },
    { name: 'invocation logs disabled', value: { ...desired, logs: { ...desired.logs, invocation_logs: false } } },
    { name: 'sampled logs', value: { ...desired, logs: { ...desired.logs, head_sampling_rate: 0.1 } } },
    { name: 'sampled global', value: { ...desired, head_sampling_rate: 0.1 } },
  ])('REQ-OPERATOR-046/048/090: $name is not observability-ready but cannot invalidate an exact deployment or existing runtime', ({ value }) => withActivation(async f => {
    const first = await enable(f); expect(first.status).toBe(200);
    const enabled = await first.json() as Installation;
    const selected = enabled.dispatcherConnection!;
    f.platform.setObservability(value);
    const bytes = (await f.registry.getManagementBundle(f.release.bundleDigest))!;
    const original = structuredClone(f.platform.scripts.get(selected.workerName)), writes = structuredClone(f.platform.writes);
    const verification = await verifyDispatcherDeployment(f.bindings as unknown as Env, selected, bytes, 17) as
      Awaited<ReturnType<typeof verifyDispatcherDeployment>> & { observabilityReady?: boolean };
    expect(verification).toMatchObject({ connectionRevision: selected.connectionRevision, workerVersionId: selected.workerVersionId,
      bundleDigest: selected.bundleDigest, observabilityReady: false });
    expect(f.platform.writes).toEqual(writes); expect(f.platform.scripts.get(selected.workerName)).toEqual(original);
    const detail = await f.detail();
    expect(detail.installations[0]).toMatchObject({ enabled: true, dispatcherConnection: selected });
    // Explicit disable/re-enable can still reuse the exact pre-existing runtime;
    // readiness must not become a new logging-dependent authentication fence.
    const disabled = await f.request(`/installations/${enabled.id}/enable`, 'POST', { revision: enabled.revision, enabled: false });
    expect(disabled.status).toBe(200);
    const reused = await enable(f, await disabled.json() as Installation);
    expect(reused.status).toBe(200); expect(await reused.json()).toMatchObject({ enabled: true, dispatcherConnection: selected });
    expect(f.platform.scripts.get(selected.workerName)).toEqual(original); expect(f.platform.writes).toEqual(writes);
    await expectNoActivity(f.ctx);
  }));
});
