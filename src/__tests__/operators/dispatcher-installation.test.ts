/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../../types';
import { OperatorRegistry } from '../../operators/registry';
import { verifyDispatcherDeployment } from '../../operators/dispatcher-deployment';
import { openOperatorSecret } from '../../operators/protected-secrets';
import { createMockKV } from '../helpers/mock-kv';
import { createOperatorGitHubFixture } from '../helpers/operator-github-fixture';
import { connectionSecret, normalDeployment, normalDispatcherBundle } from './fixtures/normal-dispatcher';

let callerEmail = 'manager@example.test';
vi.mock('../../middleware/auth', async original => ({ ...await original<typeof import('../../middleware/auth')>(),
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { email: callerEmail, role: callerEmail === 'manager@example.test' ? 'admin' : 'user', authenticated: true }); return next();
  },
}));
vi.mock('../../lib/access', async original => ({ ...await original<typeof import('../../lib/access')>(),
  authenticateRequest: async () => ({ user: { email: callerEmail, role: callerEmail === 'manager@example.test' ? 'admin' : 'user', authenticated: true }, bucketName: 'manager' }),
  requireOperatorHumanContext: async () => ({ human: { subject: callerEmail, email: callerEmail,
    issuer: 'https://access.example.test', audiences: ['audience'], issuedAt: 1, expiresAt: 2_000_000_000 }, accessJwt: 'fixture-access-jwt' }),
}));
import worker from '../../index';

afterEach(() => { callerEmail = 'manager@example.test'; vi.unstubAllGlobals(); });
const encryption = { ENCRYPTION_KEY: btoa('k'.repeat(32)) };
const policy = { capabilities: [], resourceProfileId: null };
const grant = { users: ['manager@example.test'], groups: [] };
type Installation = { id: string; revision: number; enabled: boolean; releaseId: string | null;
  dispatcherConnection?: { connectionRevision: number; workerVersionId: string } };
type Release = { id: string; manifestDigest: string; bundleDigest: string; sourceCommit: string;
  provenance: { compilerCommit: string } };

// Public contracts: workers Version(include=modules), durable_objects namespace inventory,
// workers scripts/subdomain, and Wrangler's service default-environment metadata.
// cloudflare-typescript sources: workers/beta/workers/versions.ts and durable-objects/namespaces/namespaces.ts.
const deploymentFaults = ['version', 'traffic', 'modules', 'parent', 'parent-environment',
  'parent-environment-unavailable', 'parent-unconfigured', 'module-kind', 'text-kind', 'main-module', 'extra-module',
  'duplicate-module', 'missing-modules', 'version-modules-unavailable', 'malformed-module-base64',
  'namespace-class', 'namespace-script', 'namespace-id', 'namespace-non-sqlite', 'namespace-sqlite-unavailable',
  'namespace-unavailable', 'namespace-preview', 'namespace-dispatch', 'binding-class', 'binding-script', 'binding-dispatch-namespace', 'binding-environment',
  'secret-missing', 'secret-plaintext', 'migration', 'migration-unavailable', 'workers-dev-disabled', 'workers-dev-preview-only',
  'workers-dev-unavailable', 'active-changed', 'binding-duplicate', 'compatibility', 'metadata-pin', 'version-id', 'submission-limit', 'submission-limit-kind'] as const;
type Platform = {
  fault: 'none' | typeof deploymentFaults[number];
  latestUpload: 'approved' | 'different'; esmMime: 'application/javascript+module' | 'text/javascript+module';
  submissionLimitBinding?: { type: string; text?: string };
  parentEnvironment?: string; namespaceEnvironment?: string; omitNamespaceId: boolean; omitClassName: boolean; namespacePage: 1 | 2;
};

async function withInstallation(test: (f: {
  request: (path: string, method?: string, body?: unknown, csrf?: boolean) => Promise<Response>;
  operatorId: string; installation: Installation; release: Release; connection: Record<string, unknown>;
  registry: OperatorRegistry; ctx: DurableObjectState; platform: Platform;
}) => Promise<void>) {
  callerEmail = 'manager@example.test';
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const registry = new OperatorRegistry(ctx, encryption);
    const kv = createMockKV(); kv._store.set('setup:account_id', 'a'.repeat(32));
    const platform: Platform = { fault: 'none', latestUpload: 'different', esmMime: 'application/javascript+module', omitNamespaceId: false, omitClassName: false, namespacePage: 1 };
    let activeDeploymentId = 'deployed';
    let deployedRelease = '';
    const request = (path: string, method = 'GET', body?: unknown, csrf = true) => worker.fetch(new Request(
      `https://enterprise.example.test/api/operator-management${path}`, { method, headers: {
        'content-type': 'application/json', 'cf-access-authenticated-user-email': callerEmail,
        ...(csrf ? { 'x-requested-with': 'XMLHttpRequest' } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { ...encryption, KV: kv, ENTERPRISE_MODE: 'active', CLOUDFLARE_API_TOKEN: 'synthetic-platform-token',
      ...(platform.fault === 'parent-unconfigured' ? {} : { CLOUDFLARE_WORKER_NAME: 'codeflare-integration' }),
      OPERATOR_REGISTRY: { getByName: () => registry } } as unknown as Env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext);
    const github = await createOperatorGitHubFixture({ profile: 'dispatcher', normalDispatcher: true });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname !== 'api.cloudflare.com') return github.fetcher(request);
      if (request.headers.get('authorization') !== 'Bearer synthetic-platform-token') return Response.json({}, { status: 403 });
      const workersPath = `/client/v4/accounts/${'a'.repeat(32)}/workers`;
      const scriptPath = `${workersPath}/scripts/${normalDeployment.workerName}`;
      const namespaceId = 'd'.repeat(32);
      const ok = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });
      if (request.method !== 'GET') return Response.json({}, { status: 405 });
      if (url.pathname === `${scriptPath}/deployments`) {
        return ok({ deployments: [{ id: activeDeploymentId,
          versions: [{ version_id: platform.fault === 'version' ? '99999999-2222-4333-8444-555555555555' : normalDeployment.workerVersionId,
            percentage: platform.fault === 'traffic' ? 50 : 100 }] }] });
      }
      const moduleList = (changed: boolean) => Object.entries(normalDispatcherBundle().modules).map(([name, value]) => ({
        name, content_type: 'js' in value ? platform.esmMime : 'text/plain',
        content_base64: btoa(Array.from(new TextEncoder().encode(('js' in value ? value.js : value.text)
          + (changed ? '\nchanged uploaded bytes' : '')), byte => String.fromCharCode(byte)).join('')),
      }));
      // Latest upload is intentionally independent of the actively deployed version.
      // This endpoint has no public version selector or documented cross-API ETag receipt.
      if (url.pathname === `${scriptPath}/content/v2`) {
        const form = new FormData();
        for (const module of moduleList(platform.latestUpload === 'different')) {
          form.set(module.name, new Blob([Uint8Array.from(atob(module.content_base64), c => c.charCodeAt(0))],
            { type: module.content_type }), module.name);
        }
        const response = new Response(form);
        response.headers.set('etag', 'opaque-current-upload'); response.headers.set('cf-entrypoint', 'index.js'); return response;
      }
      if (url.pathname === `${workersPath}/workers/${normalDeployment.workerName}/versions/${normalDeployment.workerVersionId}`) {
        if (platform.fault === 'version-modules-unavailable') return Response.json({}, { status: 403 });
        if (platform.fault === 'active-changed') activeDeploymentId = 'replacement-deployment';
        const modules = moduleList(platform.fault === 'modules');
        if (platform.fault === 'module-kind') modules[0]!.content_type = 'application/javascript'; // CommonJS, not ESM
        if (platform.fault === 'text-kind') modules[1]!.content_type = 'application/octet-stream';
        if (platform.fault === 'malformed-module-base64') modules[0]!.content_base64 = '!not-base64!';
        if (platform.fault === 'extra-module') modules.push({ ...modules[0]!, name: 'extra.js' });
        if (platform.fault === 'duplicate-module') modules[1] = { ...modules[0]! };
        if (platform.fault === 'missing-modules') modules.pop();
        const bindings = [
          { name: 'FLUE_DISPATCHER_AGENT', type: 'durable_object_namespace',
            ...(platform.omitClassName ? {} : { class_name: platform.fault === 'binding-class' ? 'ForeignAgent' : 'FlueDispatcherAgent' }),
            ...(platform.omitNamespaceId ? {} : { namespace_id: platform.fault === 'namespace-id' ? 'e'.repeat(32) : namespaceId }),
            ...(platform.fault === 'binding-script' ? { script_name: 'foreign-dispatcher' } : {}),
            ...(platform.fault === 'binding-dispatch-namespace' ? { dispatch_namespace: 'foreign-dispatch' } : {}),
            ...(platform.fault === 'binding-environment' ? { environment: 'staging' }
              : platform.namespaceEnvironment === undefined ? {} : { environment: platform.namespaceEnvironment }) },
          { name: 'OPERATOR', type: 'service', service: platform.fault === 'parent' ? 'foreign-parent' : 'codeflare-integration',
            entrypoint: 'OperatorInstalledDispatcherCapability',
            ...(platform.fault === 'parent-environment' ? { environment: 'staging' }
              : platform.parentEnvironment === undefined ? {} : { environment: platform.parentEnvironment }) },
          { name: 'CF_VERSION_METADATA', type: 'version_metadata' },
          ...(platform.fault === 'secret-missing' ? [] : [{ name: 'OPERATOR_CONNECTION_SECRET',
            type: platform.fault === 'secret-plaintext' ? 'plain_text' : 'secret_text' }]),
          ...(platform.submissionLimitBinding ? [{ name: 'OPERATOR_SUBMISSION_ATTEMPT_LIMIT', ...platform.submissionLimitBinding }]
            : platform.fault === 'submission-limit' ? [{ name: 'OPERATOR_SUBMISSION_ATTEMPT_LIMIT', type: 'plain_text', text: '32' }]
            : platform.fault === 'submission-limit-kind' ? [{ name: 'OPERATOR_SUBMISSION_ATTEMPT_LIMIT', type: 'secret_text' }] : []),
          ...Object.entries({ OPERATOR_INSTALLATION_ID: installationId,
            OPERATOR_RELEASE_ID: platform.fault === 'metadata-pin' ? 'foreign-release' : deployedRelease,
            OPERATOR_CONNECTION_REVISION: '1' }).map(([name, text]) => ({ name, type: 'plain_text', text })),
        ];
        if (platform.fault === 'binding-duplicate') bindings.push({ ...bindings[1]! });
        return ok({ id: platform.fault === 'version-id' ? '99999999-2222-4333-8444-555555555555' : normalDeployment.workerVersionId,
          number: 1, created_on: '2026-09-10T00:00:00.000Z', urls: [], bindings,
          main_module: platform.fault === 'main-module' ? 'other.js' : 'index.js',
          compatibility_date: platform.fault === 'compatibility' ? '2026-09-09' : '2026-09-10', compatibility_flags: ['nodejs_compat'],
          ...(platform.fault === 'migration-unavailable' ? {} : { migration_tag: platform.fault === 'migration' ? 'foreign-v1' : 'v1' }),
          ...(url.searchParams.get('include') === 'modules' ? { modules } : {}) });
      }
      if (url.pathname === `${workersPath}/services/codeflare-integration` || url.pathname === `${workersPath}/services/${normalDeployment.workerName}`) {
        return ok({ id: url.pathname.split('/').at(-1), default_environment: {
          ...(platform.fault === 'parent-environment-unavailable' && url.pathname.endsWith('/codeflare-integration') ? {} : { environment: 'production' }),
          script: { id: url.pathname.split('/').at(-1) },
        } });
      }
      if (url.pathname === `${workersPath}/durable_objects/namespaces`) {
        if (platform.fault === 'namespace-unavailable') return Response.json({}, { status: 403 });
        const page = Number(url.searchParams.get('page') ?? '1');
        const result = page < platform.namespacePage ? Array.from({ length: 100 }, (_, i) => ({
          id: i.toString(16).padStart(32, '0'), class: i < 2 ? 'FlueDispatcherAgent' : `OtherAgent${i}`,
          script: i < 2 ? normalDeployment.workerName : 'unrelated', use_sqlite: true,
          ...(i === 0 ? { preview: { id: 'preview', slug: 'preview', name: 'preview' } } : i === 1 ? { dispatch_namespace: 'foreign-dispatch' } : {}) }))
          : page > platform.namespacePage ? [] : [{ id: namespaceId, name: 'installed-dispatcher_FlueDispatcherAgent',
            class: platform.fault === 'namespace-class' ? 'ForeignAgent' : 'FlueDispatcherAgent',
            script: platform.fault === 'namespace-script' ? 'foreign-dispatcher' : normalDeployment.workerName,
            ...(platform.fault === 'namespace-preview' ? { preview: { id: 'preview', slug: 'preview', name: 'preview' } } : {}),
            ...(platform.fault === 'namespace-dispatch' ? { dispatch_namespace: 'foreign-dispatch' } : {}),
            ...(platform.fault === 'namespace-sqlite-unavailable' ? {} : { use_sqlite: platform.fault !== 'namespace-non-sqlite' }) }];
        return Response.json({ success: true, errors: [], messages: [], result,
          result_info: { page, per_page: 100, count: result.length, total_count: platform.namespacePage === 2 ? 101 : 1, total_pages: platform.namespacePage } });
      }
      if (url.pathname === `${scriptPath}/subdomain`) {
        if (platform.fault === 'workers-dev-unavailable') return Response.json({}, { status: 403 });
        return ok({ enabled: !['workers-dev-disabled', 'workers-dev-preview-only'].includes(platform.fault),
          previews_enabled: platform.fault === 'workers-dev-preview-only' });
      }
      if (url.pathname === `${workersPath}/subdomain`) return ok({ subdomain: 'platform-account' });
      return Response.json({}, { status: 404 });
    });
    let installationId = '';
    expect((await request('/access', 'POST', { revision: 0, managers: grant,
      ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
    const registered = await request('/operators', 'POST', { repositoryUrl: 'https://github.com/acme/review-operator',
      githubPat: 'acquisition-only-pat', profile: 'dispatcher', realm: 'internal', managers: grant, invokers: grant, policy });
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { operatorId: string; revision: number };
    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(refreshed.status).toBe(200);
    const release = (await refreshed.json() as { items: Release[] }).items[0]!;
    const detail = await (await request(`/operators/${operator.operatorId}`)).json() as { operator: { revision: number } };
    const created = await request(`/operators/${operator.operatorId}/installations`, 'POST', {
      name: 'normal Integration', policy, revision: detail.operator.revision });
    expect(created.status).toBe(201);
    const initial = await created.json() as Installation; installationId = initial.id; deployedRelease = release.id;
    const promoted = await request(`/installations/${initial.id}/promote`, 'POST', { revision: initial.revision, releaseId: release.id });
    expect(promoted.status).toBe(200);
    const installation = await promoted.json() as Installation;
    const { controlOrigin: _platformOrigin, ...declaredDeployment } = normalDeployment;
    await test({ request, operatorId: operator.operatorId, installation, registry, ctx, release, platform,
      connection: { revision: installation.revision, connectionSecret, ...declaredDeployment, releaseId: release.id,
        manifestDigest: release.manifestDigest, bundleDigest: release.bundleDigest } });
  });
}

describe('normal Dispatcher installation connection', () => {
  it('REQ-OPERATOR-046: AC1/2 connection configuration and rotation disable starts and reject stale revisions', () => withInstallation(async f => {
    const path = `/installations/${f.installation.id}/dispatcher-connection`;
    const configured = await f.request(path, 'POST', f.connection);
    expect(configured.status).toBe(200);
    const saved = await configured.json() as Installation;
    expect(saved).toMatchObject({ id: f.installation.id, releaseId: f.release.id,
      revision: f.installation.revision + 1, enabled: false,
      dispatcherConnection: { connectionRevision: 1, workerVersionId: normalDeployment.workerVersionId } });
    const enabled = await f.request(`/installations/${saved.id}/enable`, 'POST', { revision: saved.revision, enabled: true });
    expect(enabled.status).toBe(200);
    const active = await enabled.json() as Installation;
    const rotated = await f.request(path, 'POST', { ...f.connection, revision: active.revision, connectionSecret: 'rotated-installation-secret' });
    expect(rotated.status).toBe(200);
    const current = await rotated.json() as Installation;
    expect(current).toMatchObject({ revision: active.revision + 1, enabled: false,
      dispatcherConnection: { connectionRevision: 2, workerVersionId: normalDeployment.workerVersionId } });
    expect((await f.request(path, 'POST', f.connection)).status).toBe(409);
    const readback = await (await f.request(`/operators/${f.operatorId}`)).json();
    expect(readback).toMatchObject({ installations: [expect.objectContaining(current)] });
  }));

  it.each(deploymentFaults)(
    'REQ-OPERATOR-045/046: declared matching pins cannot enable a deployment with foreign %s', fault => withInstallation(async f => {
      const configured = await f.request(`/installations/${f.installation.id}/dispatcher-connection`, 'POST', f.connection);
      expect(configured.status).toBe(200);
      const saved = await configured.json() as Installation;
      f.platform.fault = fault;
      expect((await f.request(`/installations/${saved.id}/enable`, 'POST', { revision: saved.revision, enabled: true })).status).toBe(409);
      const detail = await (await f.request(`/operators/${f.operatorId}`)).json();
      expect(detail).toMatchObject({ installations: [expect.objectContaining({ ...saved, enabled: false })] });
    }));

  it.each([
    { parentEnvironment: undefined, namespaceEnvironment: undefined, omitNamespaceId: false, namespacePage: 1 as const },
    { parentEnvironment: 'production', namespaceEnvironment: 'production', omitNamespaceId: false, namespacePage: 2 as const },
    { parentEnvironment: undefined, namespaceEnvironment: undefined, omitNamespaceId: true, namespacePage: 2 as const },
    { parentEnvironment: undefined, namespaceEnvironment: undefined, omitNamespaceId: false, omitClassName: true, namespacePage: 1 as const },
    { parentEnvironment: 'production', namespaceEnvironment: undefined, omitNamespaceId: false, namespacePage: 1 as const, esmMime: 'text/javascript+module' as const },
  ])('REQ-OPERATOR-030/044/046: approved active version enables independently of a different latest upload (%j)', options => withInstallation(async f => {
    Object.assign(f.platform, options);
    const configured = await f.request(`/installations/${f.installation.id}/dispatcher-connection`, 'POST', f.connection);
    expect(configured.status).toBe(200);
    const saved = await configured.json() as Installation;
    const enabled = await f.request(`/installations/${saved.id}/enable`, 'POST', { revision: saved.revision, enabled: true });
    expect(enabled.status).toBe(200);
    const active = await enabled.json() as Installation;
    expect(active).toMatchObject({ enabled: true, revision: saved.revision + 1,
      dispatcherConnection: { workerVersionId: normalDeployment.workerVersionId } });
    expect(await (await f.request(`/operators/${f.operatorId}`)).json()).toMatchObject({
      installations: [expect.objectContaining(active)],
    });
  }));

  it('REQ-OPERATOR-030/044/046: approved latest-upload bytes cannot qualify different active-version bytes', () => withInstallation(async f => {
    f.platform.latestUpload = 'approved'; f.platform.fault = 'modules';
    const configured = await f.request(`/installations/${f.installation.id}/dispatcher-connection`, 'POST', f.connection);
    expect(configured.status).toBe(200);
    const saved = await configured.json() as Installation;
    const before = await (await f.request(`/operators/${f.operatorId}`)).json();
    const denied = await f.request(`/installations/${saved.id}/enable`, 'POST', { revision: saved.revision, enabled: true });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ error: 'Dispatcher deployment verification failed' });
    expect(await (await f.request(`/operators/${f.operatorId}`)).json()).toEqual(before);
  }));

  it.each([
    { admitted: 1024, installed: undefined, allowed: true },
    { admitted: 1024, installed: { type: 'plain_text', text: '1024' }, allowed: true },
    { admitted: 32, installed: { type: 'plain_text', text: '32' }, allowed: true },
    { admitted: 32, installed: undefined, allowed: false },
    { admitted: 32, installed: { type: 'plain_text', text: '1024' }, allowed: false },
    { admitted: 1024, installed: { type: 'secret_text', text: '1024' }, allowed: false },
    { admitted: 1024, installed: { type: 'plain_text', text: ' 1024' }, allowed: false },
  ])('REQ-OPERATOR-044/045: installation-wide submission limit must match admission (%j)', scenario => withInstallation(async f => {
    f.platform.submissionLimitBinding = scenario.installed;
    const bytes = new TextEncoder().encode(JSON.stringify(normalDispatcherBundle()));
    const bundleDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const kv = createMockKV(); kv._store.set('setup:account_id', 'a'.repeat(32));
    const result = verifyDispatcherDeployment({ KV: kv, CLOUDFLARE_API_TOKEN: 'synthetic-platform-token',
      CLOUDFLARE_WORKER_NAME: 'codeflare-integration' } as unknown as Env,
    { installationId: f.installation.id, releaseId: f.release.id, connectionRevision: 1,
      workerName: normalDeployment.workerName, workerVersionId: normalDeployment.workerVersionId,
      sourceCommit: normalDeployment.sourceCommit, compilerCommit: normalDeployment.compilerCommit,
      manifestDigest: f.release.manifestDigest, bundleDigest }, bytes, scenario.admitted);
    if (scenario.allowed) await expect(result).resolves.toMatchObject({ connectionRevision: 1,
      workerVersionId: normalDeployment.workerVersionId, bundleDigest,
      controlOrigin: `https://${normalDeployment.workerName}.platform-account.workers.dev` });
    else await expect(result).rejects.toThrow('Dispatcher deployment could not be verified');
  }));

  it('REQ-OPERATOR-049: AC2 connection secret is encrypted for its installation and never returned in management readback', () => withInstallation(async f => {
    const configured = await f.request(`/installations/${f.installation.id}/dispatcher-connection`, 'POST', f.connection);
    expect(configured.status).toBe(200);
    const projection = await configured.text();
    expect(projection).not.toContain(connectionSecret);
    expect(projection).not.toContain('connectionSecretCiphertext');
    const raw = f.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_installations WHERE id=?', f.installation.id).one().data;
    expect(raw).not.toContain(connectionSecret);
    // Verify retained authenticated encryption without prescribing a new Registry API or nesting layout.
    const envelopes = (value: unknown): string[] => typeof value === 'string' ? value.startsWith('v1:') ? [value] : []
      : value && typeof value === 'object' ? Object.values(value).flatMap(envelopes) : [];
    const ciphertexts = envelopes(JSON.parse(raw));
    const opened = await Promise.all(ciphertexts.map(ciphertext => openOperatorSecret(ciphertext, encryption,
      { purpose: 'connection', recordId: f.installation.id }).catch(() => null)));
    expect(opened).toContain(connectionSecret);
    for (const ciphertext of ciphertexts) await expect(openOperatorSecret(ciphertext, encryption,
      { purpose: 'connection', recordId: 'another-installation' })).rejects.toThrow('Operator secret protection failed');
    const detail = await f.request(`/operators/${f.operatorId}`);
    expect(detail.status).toBe(200);
    const readback = await detail.text();
    expect(readback).not.toContain(connectionSecret);
    for (const ciphertext of ciphertexts) expect(readback).not.toContain(ciphertext);
  }));

  it('REQ-OPERATOR-045: AC2 unauthorized CSRF-less and substituted deployment mutations leave the installed pin unchanged', () => withInstallation(async f => {
    const path = `/installations/${f.installation.id}/dispatcher-connection`;
    const before = await (await f.request(`/operators/${f.operatorId}`)).json();
    callerEmail = 'outsider@example.test';
    expect((await f.request(path, 'POST', f.connection)).status).toBe(404);
    callerEmail = 'manager@example.test';
    expect((await f.request(path, 'POST', f.connection, false)).status).toBe(403);
    for (const field of ['releaseId', 'manifestDigest', 'bundleDigest', 'sourceCommit', 'compilerCommit']) {
      const changed = field.endsWith('Commit') ? 'b'.repeat(40) : field.endsWith('Digest') ? 'b'.repeat(64) : 'other-release';
      expect((await f.request(path, 'POST', { ...f.connection, [field]: changed })).status).toBe(409);
    }
    expect(await (await f.request(`/operators/${f.operatorId}`)).json()).toEqual(before);
  }));
});
