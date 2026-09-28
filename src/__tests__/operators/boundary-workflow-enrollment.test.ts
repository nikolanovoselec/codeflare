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
    writeDenied: false, sdd: true, protected: true, permission: 'admin', changedDuringWrite: false };
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== 'https://api.github.com' || req.headers.get('authorization') !== 'Bearer enrollment-fixture-token')
      return new Response('Unauthorized host or token', { status: 403 });
    const root = '/repos/acme/app';
    const path = url.pathname;
    if (path === '/user') return Response.json({ login: 'admin', id: 3 });
    if (path === `${root}/collaborators/admin/permission`) return Response.json({ permission: state.permission });
    if (path === root) return Response.json({ id: repoId, full_name: 'acme/app', default_branch: 'main', permissions: { push: state.permission === 'admin' } });
    if (path === `${root}/branches/main`) return Response.json({ name: 'main', protected: state.protected, commit: { sha: state.head } });
    if (path === `${root}/contents/sdd`) return state.sdd ? Response.json([{ name: 'README.md', type: 'file' }]) : new Response('', { status: 404 });
    if (path === `${root}/contents/${workflowPath}` && req.method === 'GET') {
      if (!state.workflow) return new Response('', { status: 404 });
      return Response.json({ type: 'file', path: workflowPath, encoding: 'base64', content: btoa(state.workflow), sha: 'c'.repeat(40) });
    }
    if (path === `${root}/actions/workflows/boundary-reviews.yml`) return state.workflow
      ? Response.json({ id: 531, path: workflowPath, state: 'active' }) : new Response('', { status: 404 });
    if (req.method !== 'GET' && state.writeDenied) return new Response('Workflow write denied', { status: 403 });
    if (path === `${root}/git/refs` && req.method === 'POST') {
      if (state.changedDuringWrite) state.head = advanced;
      return Response.json({ ref: 'refs/heads/codeflare-review-install', object: { sha: head } }, { status: 201 });
    }
    if (path === `${root}/contents/${workflowPath}` && req.method === 'PUT') {
      const body = await req.json() as { content?: string; branch?: string };
      if (body.branch === 'main' || typeof body.content !== 'string') return new Response('Protected write denied', { status: 403 });
      state.proposal = atob(body.content);
      return Response.json({ content: { path: workflowPath } }, { status: 201 });
    }
    if (path === `${root}/pulls` && req.method === 'POST') return Response.json({ number: 42, state: 'open', base: { ref: 'main' } }, { status: 201 });
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
    expect(proposed.status).toBe(202);
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
  }));

  it('denies non-admin, missing CSRF, expired authority and missing installed origin configuration', () => withEnrollment(async ({ request, registry, github }) => {
    actor.role = 'user';
    expect((await request('/boundary-actions/propose', 'POST', target)).status).toBe(404);
    actor.role = 'admin';
    expect((await request('/boundary-actions/propose', 'POST', target, false)).status).toBe(403);
    actor.expired = true;
    expect((await request('/boundary-actions/propose', 'POST', target)).status).not.toBe(202);
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
      expect((await request('/boundary-actions/propose', 'POST', target)).status).not.toBe(202);
      github.state.sdd = true; github.state.protected = true; github.state.permission = 'admin'; github.state.writeDenied = false;
    }
    expect((await request('/boundary-actions/propose', 'POST', { ...target, protectedRef: 'refs/heads/feature' })).status).not.toBe(202);
    expect(github.state.proposal).toBeNull();
    expect(await registry.getBoundaryAction(repoId, 'refs/heads/main')).toBeNull();
  }));

  it('refuses a moved protected head, unexpected workflow bytes and a revoked admin before binding', () => withEnrollment(async ({ request, registry, github }) => {
    github.state.changedDuringWrite = true;
    expect((await request('/boundary-actions/propose', 'POST', target)).status).not.toBe(202);
    github.state.changedDuringWrite = false;
    github.state.head = head;
    expect((await request('/boundary-actions/propose', 'POST', target)).status).toBe(202);
    github.state.workflow = 'on: pull_request_target\njobs: {stolen: {runs-on: ubuntu-latest}}\n';
    expect((await request('/boundary-actions/verify', 'POST', target)).status).not.toBe(200);
    github.state.workflow = github.state.proposal;
    github.state.permission = 'read';
    expect((await request('/boundary-actions/verify', 'POST', target)).status).not.toBe(200);
    expect(await registry.getBoundaryAction(repoId, 'refs/heads/main')).toBeNull();
  }));

  it('does not propose a workflow when installer-fixed origins or executable are unavailable', () => withEnrollment(async ({ request, registry }) => {
    expect((await request('/boundary-actions/propose', 'POST', target)).status).not.toBe(202);
    expect(await registry.getBoundaryAction(repoId, 'refs/heads/main')).toBeNull();
  }, false));
});
