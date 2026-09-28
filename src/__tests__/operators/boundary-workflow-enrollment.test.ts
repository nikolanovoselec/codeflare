/// <reference types="@cloudflare/vitest-pool-workers/types" />
/** REQ-OPERATOR-053/054: enrollment is an authenticated, dormant protected-base operation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import worker from '../../index';
import type { Env } from '../../types';
import { OperatorRegistry } from '../../operators/registry';
import { createMockKV } from '../helpers/mock-kv';
import { storeGithubConnection } from '../../lib/github-token';

const actor = vi.hoisted(() => ({ role: 'admin', email: 'admin@example.test', expired: false }));
vi.mock('../../middleware/auth', async original => ({
  ...await original<typeof import('../../middleware/auth')>(),
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { email: actor.email, role: actor.role, authenticated: true });
    c.set('bucketName', actor.email);
    return next();
  },
}));
vi.mock('../../lib/access', async original => ({
  ...await original<typeof import('../../lib/access')>(),
  authenticateRequest: async () => ({ user: { email: actor.email, role: actor.role, authenticated: true }, bucketName: actor.email }),
  requireOperatorHumanContext: async () => ({ human: {
    subject: actor.email, email: actor.email, issuer: 'https://issuer.example.test', audiences: ['operator-management'],
    issuedAt: Math.floor(Date.now() / 1000) - 10, expiresAt: Math.floor(Date.now() / 1000) + (actor.expired ? -1 : 300),
  }, accessJwt: 'verified-access-token' }),
}));

const repoId = 138;
const head = 'a'.repeat(40);
const advanced = 'b'.repeat(40);
const workflowPath = '.github/workflows/boundary-reviews.yml';
const target = { repositoryUrl: 'https://github.com/acme/app', protectedRef: 'refs/heads/main', installationId: 'review-install' };
const origins = { dev: 'https://dev.codeflare.example.test', integration: 'https://enterprise.codeflare.example.test',
  production: 'https://codeflare.example.test' };

/** Stateful GitHub boundary: proposals touch only a new branch; verification reads protected bytes. */
function githubFixture() {
  const state = { head, workflow: null as string | null, proposal: null as string | null,
    branch: false, branchSha: head, pr: false, writeDenied: false, revokeDuringWrite: false,
    runtimeEmpty: false, runtimeNoRun: false,
    loseBranchResponse: false, loseContentResponse: false, losePrResponse: false,
    sdd: true, protected: true, permission: 'admin', changedDuringWrite: false, unrelatedBranchFile: false };
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== 'https://api.github.com' || req.headers.get('authorization') !== 'Bearer enrollment-fixture-token')
      return new Response('Unauthorized host or token', { status: 403 });
    const root = '/repos/acme/app';
    const path = url.pathname;
    if (path === '/repos/nikolanovoselec/codeflare/contents/.github/workflows/boundary-runtime.yml'
      && url.searchParams.get('ref') === 'd'.repeat(40)) return Response.json({ type: 'file', encoding: 'base64',
      content: btoa(state.runtimeEmpty ? 'on: {workflow_call: {}}\njobs: {}\n' : `name: Review runtime\non:\n  workflow_call:\n    inputs:\n      runtime_sha: {required: true, type: string}\n      dev_origin: {required: true, type: string}\n      integration_origin: {required: true, type: string}\n      production_origin: {required: true, type: string}\njobs:\n  collect:\n    permissions: {id-token: write, contents: read}\n    steps:\n      - uses: actions/checkout@${'a'.repeat(40)}\n        with: {repository: nikolanovoselec/codeflare, ref: "\${{ inputs.runtime_sha }}", persist-credentials: false}\n      - run: ${state.runtimeNoRun ? 'echo noop' : 'node .review-runtime/scripts/operator-boundary-action.mjs collect'}\n      - uses: actions/upload-artifact@${'b'.repeat(40)}\n  publish:\n    permissions: {id-token: write, issues: write, checks: write}\n    steps:\n      - uses: actions/checkout@${'a'.repeat(40)}\n        with: {repository: nikolanovoselec/codeflare, ref: "\${{ inputs.runtime_sha }}", persist-credentials: false}\n      - run: npm ci --prefix .review-runtime\n      - uses: actions/download-artifact@${'c'.repeat(40)}\n      - run: node .review-runtime/scripts/operator-boundary-action.mjs publish\n`) });
    if (path === '/repos/nikolanovoselec/codeflare/contents/scripts/operator-boundary-action.mjs'
      && url.searchParams.get('ref') === 'd'.repeat(40)) return Response.json({ type: 'file', encoding: 'base64',
      content: btoa('export async function runProtectedJob() {}') });
    if (path === '/repos/nikolanovoselec/codeflare/contents/package.json'
      && url.searchParams.get('ref') === 'd'.repeat(40)) return Response.json({ type: 'file', encoding: 'base64',
      content: btoa(JSON.stringify({ dependencies: { '@actions/artifact': '6.2.1' } })) });
    if (path === '/user') return Response.json({ login: 'admin', id: 3 });
    if (path === `${root}/collaborators/admin/permission`) return Response.json({ permission: state.permission });
    if (path === root) return Response.json({ id: repoId, full_name: 'acme/app', default_branch: 'main', permissions: { push: state.permission === 'admin' } });
    if (path === `${root}/branches/main`) return Response.json({ name: 'main', protected: state.protected, commit: { sha: state.head } });
    if (path === `${root}/contents/sdd`) return state.sdd ? Response.json([{ name: 'README.md', type: 'file' }]) : new Response('', { status: 404 });
    if (path === `${root}/contents/${workflowPath}` && req.method === 'GET') {
      const text = url.searchParams.get('ref')?.startsWith('codeflare-review-install-') ? state.proposal : state.workflow;
      if (!text) return new Response('', { status: 404 });
      return Response.json({ type: 'file', path: workflowPath, encoding: 'base64', content: btoa(text), sha: 'c'.repeat(40) });
    }
    if (path === `${root}/actions/workflows/boundary-reviews.yml`) return state.workflow
      ? Response.json({ id: 531, path: workflowPath, state: 'active' }) : new Response('', { status: 404 });
    if (path === `${root}/git/refs` && req.method === 'POST') {
      if (state.branch) return new Response('Existing branch', { status: 422 });
      state.branch = true;
      if (state.changedDuringWrite) state.head = advanced;
      if (state.revokeDuringWrite) actor.expired = true;
      if (state.loseBranchResponse) throw Error('Branch accepted but response lost');
      return Response.json({ ref: 'refs/heads/codeflare-review-install', object: { sha: head } }, { status: 201 });
    }
    if (path.startsWith(`${root}/git/ref/heads/codeflare-review-install-`) && req.method === 'GET') {
      return state.branch ? Response.json({ ref: `refs/heads/${path.split('/').at(-1)}`,
        object: { sha: state.branchSha } }) : new Response('', { status: 404 });
    }
    if (path.startsWith(`${root}/compare/${head}...`) && req.method === 'GET') {
      return Response.json({ merge_base_commit: { sha: head },
        files: [{ filename: workflowPath, status: 'added' },
          ...(state.unrelatedBranchFile ? [{ filename: 'src/unrelated.ts', status: 'modified' }] : [])] });
    }
    if (req.method === 'PUT' && state.writeDenied) return new Response('Workflow write denied', { status: 403 });
    if (path === `${root}/contents/${workflowPath}` && req.method === 'PUT') {
      const body = await req.json() as { content?: string; branch?: string; sha?: string };
      if (body.branch === 'main' || typeof body.content !== 'string') return new Response('Protected write denied', { status: 403 });
      if (state.workflow && body.sha !== 'c'.repeat(40)) return new Response('Missing update SHA', { status: 409 });
      state.proposal = atob(body.content);
      state.branchSha = 'e'.repeat(40);
      if (state.loseContentResponse) throw Error('Workflow accepted but response lost');
      return Response.json({ content: { path: workflowPath } }, { status: state.workflow ? 200 : 201 });
    }
    if (path === `${root}/pulls` && req.method === 'POST') {
      if (state.pr) return new Response('Existing PR', { status: 422 });
      state.pr = true;
      if (state.losePrResponse) throw Error('PR accepted but response lost');
      return Response.json({ number: 42, state: 'open', base: { ref: 'main' } }, { status: 201 });
    }
    if (path === `${root}/pulls` && req.method === 'GET') return Response.json(state.pr
      ? [{ number: 42, state: 'open', base: { ref: 'main' } }] : []);
    if (path === `${root}/git/ref/heads/main`) return Response.json({ ref: 'refs/heads/main', object: { sha: state.head } });
    return new Response('Missing GitHub fixture endpoint', { status: 404 });
  };
  return { state, fetcher };
}

async function withEnrollment(run: (context: {
  request: (path: string, method?: string, body?: unknown, csrf?: boolean) => Promise<Response>;
  registry: OperatorRegistry;
  github: ReturnType<typeof githubFixture>;
}) => Promise<void>, enabledConfig = true) {
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const key = btoa('k'.repeat(32));
    const kv = createMockKV();
    const github = githubFixture();
    const registry = new OperatorRegistry(ctx, { ENCRYPTION_KEY: key });
    expect((await registry.setManagementControls({ revision: 0,
      managers: { users: [actor.email], groups: [] }, ceiling: { capabilities: [], resourceProfileIds: [] } },
    { email: actor.email, expiresAt: Date.now() + 60_000 })).ok).toBe(true);
    const policy = { capabilities: [], resourceProfileId: null };
    ctx.storage.sql.exec('INSERT INTO operator_catalog VALUES(?,?,?,?,?,?)', 'review-operator', 'conductor',
      'internal', 1, 'review-operator', JSON.stringify({ id: 'review-operator', revision: 1,
        sourceRevision: 1, profile: 'conductor', realm: 'internal', repositoryId: 138,
        repositoryUrl: 'https://github.com/acme/review-operator', managers: { users: [], groups: [] },
        invokers: { users: ['admin@example.test'], groups: [] }, policy,
        approvedWorkflow: { id: 531, ref: 'refs/heads/main' } }));
    ctx.storage.sql.exec('INSERT INTO operator_releases VALUES(?,?,?,?)', 'review-release', 'review-operator',
      JSON.stringify({ id: 'review-release', bundleDigest: 'e'.repeat(64), approved: true }), '{}');
    ctx.storage.sql.exec('INSERT INTO operator_installations VALUES(?,?,?,?,?)', 'review-install', 'review-operator',
      'review-install', 1, JSON.stringify({ id: 'review-install', operatorId: 'review-operator',
        name: 'review-install', releaseId: 'review-release', revision: 1, enabled: true, policy,
        configurationJson: '{}', approvedSourceRevision: 1 }));
    const bindings = { KV: kv, ENCRYPTION_KEY: key, ENTERPRISE_MODE: 'active',
      ...(enabledConfig ? { OPERATOR_REVIEW_ORIGINS: JSON.stringify(origins),
        OPERATOR_REVIEW_EXECUTABLE_SHA: 'd'.repeat(40) } : {}),
      OPERATOR_REGISTRY: { getByName: () => registry },
    } as unknown as Env;
    await storeGithubConnection(bindings, actor.email, { accessToken: 'enrollment-fixture-token', source: 'pat', login: 'admin' });
    const request = (path: string, method = 'GET', body?: unknown, csrf = true) => worker.fetch(new Request(
      `https://enterprise.example.test/api/operator-management${path}`, { method, headers: {
        'content-type': 'application/json', ...(csrf ? { 'x-requested-with': 'XMLHttpRequest' } : {}),
        'cf-access-authenticated-user-email': actor.email, 'cf-access-jwt-assertion': 'verified-access-token',
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), bindings,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext);
    vi.stubGlobal('fetch', github.fetcher);
    await run({ request, registry, github });
  });
}

beforeEach(() => { actor.role = 'admin'; actor.email = 'admin@example.test'; actor.expired = false; });
afterEach(() => vi.unstubAllGlobals());

describe('REQ-OPERATOR-053/054: protected Review enrollment and dormant trust', () => {
  it('creates a reviewable protected-workflow proposal without enabling Review or writing the protected base', () => withEnrollment(async ({ request, registry, github }) => {
    const proposed = await request('/boundary-actions/propose', 'POST', target);
    expect(proposed.status, await proposed.clone().text()).toBe(202);
    expect(await proposed.json()).toMatchObject({ status: 'pending', pullRequest: 42 });
    expect(github.state.proposal).toContain('nikolanovoselec/codeflare');
    expect(github.state.workflow).toBeNull();
    expect(await registry.getBoundaryAction(repoId, 'refs/heads/main')).toBeNull();
    const pending = await request('/boundary-actions/verify', 'POST', target);
    expect(pending.status).toBe(409);
    expect(await registry.getBoundaryAction(repoId, 'refs/heads/main')).toBeNull();
    github.state.workflow = github.state.proposal;
    const installed = await request('/boundary-actions/verify', 'POST', target);
    expect(installed.status).toBe(200);
    expect(await installed.json()).toMatchObject({ status: 'installed', enabled: false, workflowId: 531 });
    expect(await registry.getBoundaryAction(repoId, 'refs/heads/main')).toBeNull();
    const controls = await registry.getManagementControls();
    expect(controls.boundaryActions).toMatchObject([{ repositoryId: repoId, verified: true, enabled: false,
      runtimeSha: 'd'.repeat(40) }]);
    expect((await request('/access', 'POST', { ...controls, boundaryActions: [] })).status).toBe(409);
    expect((await request('/access', 'POST', { ...controls, boundaryActions: [{
      ...controls.boundaryActions![0], workflowDigest: 'f'.repeat(64),
    }] })).status).toBe(400);
    expect(await registry.getManagementControls()).toEqual(controls);
    const update = await request('/boundary-actions/propose', 'POST', target);
    expect(update.status, await update.clone().text()).toBe(202);
    expect(await update.json()).toMatchObject({ status: 'pending', pullRequest: 42 });
    expect(github.state.workflow).toBe(github.state.proposal);
    expect(await registry.getBoundaryAction(repoId, 'refs/heads/main')).toBeNull();
  }));

  it('denies non-admin, missing CSRF, expired authority and missing installed origin configuration', () => withEnrollment(async ({ request, registry, github }) => {
    actor.role = 'user';
    expect((await request('/boundary-actions/propose', 'POST', target)).status).toBe(404);
    actor.role = 'admin';
    expect((await request('/boundary-actions/propose', 'POST', target, false)).status).toBe(403);
    actor.expired = true;
    expect((await request('/boundary-actions/propose', 'POST', target)).status).toBe(404);
    actor.expired = false;
    expect(github.state.proposal).toBeNull();
    expect(await registry.getBoundaryAction(repoId, 'refs/heads/main')).toBeNull();
  }));

  it('fails closed on missing sdd, unprotected/wrong base, absent workflow-write permission and denied write', () => withEnrollment(async ({ request, registry, github }) => {
    for (const change of [
      () => { github.state.sdd = false; },
      () => { github.state.protected = false; },
      () => { github.state.permission = 'read'; },
      () => { github.state.writeDenied = true; },
    ]) {
      change();
      expect((await request('/boundary-actions/propose', 'POST', target)).status).toBe(409);
      if (github.state.writeDenied) {
        expect(github.state.branch).toBe(true);
        expect(github.state.proposal).toBeNull();
      }
      github.state.sdd = true; github.state.protected = true; github.state.permission = 'admin'; github.state.writeDenied = false;
    }
    expect((await request('/boundary-actions/propose', 'POST', { ...target, protectedRef: 'refs/heads/feature' })).status).toBe(400);
    expect((await request('/boundary-actions/propose', 'POST', { ...target, installationId: 'another-installation' })).status).toBe(409);
    expect(github.state.proposal).toBeNull();
    expect(await registry.getBoundaryAction(repoId, 'refs/heads/main')).toBeNull();
  }));

  it('refuses a moved protected head, unexpected workflow bytes and a revoked admin before binding', () => withEnrollment(async ({ request, registry, github }) => {
    github.state.changedDuringWrite = true;
    expect((await request('/boundary-actions/propose', 'POST', target)).status).toBe(409);
    github.state.changedDuringWrite = false;
    github.state.head = head;
    expect((await request('/boundary-actions/propose', 'POST', target)).status).toBe(202);
    github.state.workflow = 'on: pull_request_target\njobs: {stolen: {runs-on: ubuntu-latest}}\n';
    expect((await request('/boundary-actions/verify', 'POST', target)).status).toBe(409);
    github.state.workflow = github.state.proposal;
    github.state.permission = 'read';
    expect((await request('/boundary-actions/verify', 'POST', target)).status).toBe(409);
    expect(await registry.getBoundaryAction(repoId, 'refs/heads/main')).toBeNull();
  }));

  it('reconciles exact accepted branch, workflow and PR after lost responses without another target PR', () => withEnrollment(async ({ request, registry, github }) => {
    github.state.loseBranchResponse = github.state.loseContentResponse = github.state.losePrResponse = true;
    const proposed = await request('/boundary-actions/propose', 'POST', target);
    expect(proposed.status).toBe(202);
    expect(await proposed.json()).toMatchObject({ status: 'pending', pullRequest: 42 });
    expect(github.state.proposal).toContain('Boundary Reviews');
    expect(github.state.pr).toBe(true);
    expect(await registry.getBoundaryAction(repoId, 'refs/heads/main')).toBeNull();
  }));

  it('fences a revoked administrator after a remote branch write before modifying workflow bytes', () => withEnrollment(async ({ request, registry, github }) => {
    github.state.revokeDuringWrite = true;
    expect((await request('/boundary-actions/propose', 'POST', target)).status).toBe(404);
    expect(github.state.branch).toBe(true);
    expect(github.state.proposal).toBeNull();
    expect(github.state.pr).toBe(false);
    expect(await registry.getBoundaryAction(repoId, 'refs/heads/main')).toBeNull();
    actor.expired = false;
  }));

  it('rejects a pinned runtime that has named jobs but cannot execute collection or publication', () => withEnrollment(async ({ request, registry, github }) => {
    github.state.runtimeNoRun = true;
    expect((await request('/boundary-actions/propose', 'POST', target)).status).toBe(409);
    expect(github.state.branch).toBe(false);
    expect(await registry.getBoundaryAction(repoId, 'refs/heads/main')).toBeNull();
  }));

  it('refuses to propose an existing branch containing unrelated changes', () => withEnrollment(async ({ request, github }) => {
    expect((await request('/boundary-actions/propose', 'POST', target)).status).toBe(202);
    github.state.unrelatedBranchFile = true;
    expect((await request('/boundary-actions/propose', 'POST', target)).status).toBe(409);
    expect(github.state.pr).toBe(true);
  }));

  it('rejects a pinned but unusable empty reusable workflow before any target write', () => withEnrollment(async ({ request, registry, github }) => {
    github.state.runtimeEmpty = true;
    expect((await request('/boundary-actions/propose', 'POST', target)).status).toBe(409);
    expect(github.state.branch).toBe(false);
    expect(await registry.getBoundaryAction(repoId, 'refs/heads/main')).toBeNull();
  }));

  it('does not propose a workflow when installer-fixed origins or executable are unavailable', () => withEnrollment(async ({ request, registry }) => {
    expect((await request('/boundary-actions/propose', 'POST', target)).status).toBe(503);
    expect(await registry.getBoundaryAction(repoId, 'refs/heads/main')).toBeNull();
  }, false));
});
