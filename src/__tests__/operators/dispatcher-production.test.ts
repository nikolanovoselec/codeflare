/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Agent } from 'agents';
import { OperatorActivity, OperatorDispatcherCapability, createOperatorIntentDigest } from '../../operators/activity';
import { driveDispatcherRuntime } from '../../operators/runtime';
import { runOperatorActivity } from '../../operators/orchestrator';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import { setLogLevel } from '../../lib/logger';
import type { DispatcherBundle } from '../../operators/distribution';
import type { Env } from '../../types';

vi.mock('../../lib/access', async original => ({ ...await original<typeof import('../../lib/access')>(),
  resolveOperatorGroupIdentity: async (human: unknown) => human,
  resolveBucketName: async () => 'owner-bucket',
  resolveSessionAccessGroup: async () => [],
  loadEnterpriseRouteConfig: async () => ({ routeCatalog: ['approved'], defaultRoute: 'approved', defaultReasoning: 'off' }),
}));
vi.mock('../../lib/aig-config', () => ({ getAigConfig: async () => ({ gatewayUrl: 'https://gateway.example.test', token: 'parent-only' }) }));

const bundle: DispatcherBundle = { schemaVersion: 1, sourceCommit: 'a'.repeat(40),
  versions: { runtime: '2.1.0', vitePlugin: '2.1.0', agents: '0.20.1' }, className: 'FlueDispatcherAgent',
  compatibilityDate: '2026-09-10', compatibilityFlags: ['nodejs_compat'], mainModule: 'index.js',
  modules: { 'index.js': { js: 'export class FlueDispatcherAgent {}' } } };
const bytes = new TextEncoder().encode(JSON.stringify(bundle));
const invocation = { repository: 'owner/repo', pullRequest: 17 };
const guideExcerpt = 'To create a Dozzle agent, you need to run Dozzle with the `agent` subcommand.\n      - DOZZLE_REMOTE_AGENT=agent:7007';
const guideBlobSha = '9fd821c091950776b4aef53bdc5f55fc72df25af';
async function digest(value: string | Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string'
    ? new TextEncoder().encode(value) : value)), b => b.toString(16).padStart(2, '0')).join('');
}

/** Instrumented SDK owner, not native Flue proof: native cases remain in loader-runtime.test.ts. */
async function fixture(test: (f: {
  activity: OperatorActivity; capability: OperatorDispatcherCapability; staleCapability: OperatorDispatcherCapability; environment: Env;
  artifactDigest: string; settle: (id?: string, outcome?: string, error?: unknown) => void; expire: () => void;
  revoke: () => void; sent: Request[]; abortStatus: () => string | undefined;
  restart: () => OperatorActivity; loseResponse: () => void; throwTransport: () => void;
  emptyResponse: () => void; upstreamConflict: (enabled: boolean) => void; nextAlarm: () => Promise<number | null>;
  oversizedChecks: (count?: number, outputBytes?: number, overlap?: boolean) => void;
  messages: (value: unknown[]) => void;
  files: (value: unknown[]) => void;
  compose: (value: Record<string, unknown>) => void;
  release: (value: unknown, status?: number) => void;
  guide: (value: unknown) => void; tag: (value: unknown) => void;
  annotatedTag: (value: unknown) => void;
  moveHeadAfterFiles: () => void;
  moveHeadAfterRelease: () => void; expireAfterRead: () => void;
  moveBaseAfterContents: () => void; moveBaseAfterGuide: () => void;
  exceedReleaseDeadline: () => void; exceedGuideDeadline: () => void;
}) => Promise<void>) {
  const namespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  await runInDurableObject(namespace.getByName(`dispatcher-${crypto.randomUUID()}`), async (_instance, native) => {
    const activityId = `activity-${crypto.randomUUID()}`;
    const artifactDigest = await digest(bytes);
    const now = Date.now();
    const expiresAt = Math.floor(now / 1000) + 300;
    const human = { subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test',
      audiences: ['audience'], issuedAt: Math.floor(now / 1000) - 1, expiresAt };
    const policy = { capabilities: ['fetch', 'inference'], resourceProfileId: null };
    const selection = { controlsRevision: 1, installation: { id: 'installation', operatorId: 'operator', revision: 1,
      enabled: true, policy, configurationJson: '{}', releaseId: 'release' },
    operator: { operatorId: 'operator', profile: 'dispatcher', revision: 1, invokers: { users: [human.email], groups: [] } },
    release: { id: 'release', bundleDigest: artifactDigest, sourceCommit: bundle.sourceCommit }, manifestJson: '{}' };
    let revoked = false;
    let settlements: unknown[] = [];
    let messages: unknown[] = [];
    let messagesSet = false;
    let aborted: string | undefined;
    let uncertain = false;
    let transportThrows = false;
    let emptyResponse = false;
    let upstreamConflict = false;
    let oversizedChecks: { count: number; outputBytes: number; overlap: boolean } | null = null;
    let changedFiles: unknown[] = [];
    let composeBodies: Record<string, unknown> = {};
    let releaseBody: unknown = { tag_name: 'v11.1.2', body: 'No configuration changes', html_url: 'https://github.com/amir20/dozzle/releases/tag/v11.1.2' };
    let releaseStatus = 200;
    let guideBody: unknown = composeBlob('docs/guide/agent.md', guideBlobSha, guideExcerpt);
    let tagRef: unknown = { ref: 'refs/tags/v11.1.2', object: { type: 'tag', sha: '3'.repeat(40) } };
    let annotatedTag: unknown = { tag: 'v11.1.2', object: { type: 'commit', sha: '1'.repeat(40) } };
    let headSha = 'b'.repeat(40);
    let baseSha = 'a'.repeat(40);
    let moveAfterContents = false;
    let moveBaseAfterGuide = false;
    let moveAfterFiles = false;
    let moveAfterRelease = false;
    let expireAfterRead = false;
    let exceedDeadline = false;
    const sent: Request[] = [];
    const pending: Promise<unknown>[] = [];
    let activity: OperatorActivity;
    const child = {
      _cf_initAsFacet: async () => {},
      _cf_checkRunFibersForFacet: async () => 0,
      _cf_dispatchScheduledCallback: async () => true,
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname.endsWith('/abort')) {
          aborted = (await activity.getBrowserDetail())?.executionStatus;
          return Response.json({ ok: true });
        }
        if (request.method === 'POST') return Response.json({ submissionId: 'submission-1' }, { status: 202 });
        return Response.json({ settlements, messages });
      },
    };
    // Agent validates the native DurableObjectState brand and SQLite capability.
    // Keep that real owner while replacing only the fixture's child/interceptor seams.
    Object.defineProperties(native, {
      facets: { configurable: true, value: { get: () => child } },
      exports: { configurable: true, value: {
        OperatorDispatcherCapability: () => ({ fetch: async () => new Response() }),
        GitHubInterceptor: () => ({ fetch: async (request: Request) => {
          sent.push(request);
          if (transportThrows) throw new Error('private transport failure');
          if (emptyResponse) return new Response(null, { status: 200 });
          if (uncertain) return Response.json({ error: 'lost response' }, { status: 502 });
          if (upstreamConflict) return Response.json({ error: 'upstream-conflict' }, { status: 409 });
          if (request.url.includes('/releases/tags/')) {
            if (moveAfterRelease) headSha = 'c'.repeat(40);
            if (exceedDeadline) vi.spyOn(Date, 'now').mockReturnValue(now + 9000);
            return Response.json(releaseBody, { status: releaseStatus });
          }
          if (request.url.includes('/git/ref/tags/')) return Response.json(tagRef);
          if (request.url.includes('/git/tags/')) return Response.json(annotatedTag);
          if (request.url.includes('/contents/docs/guide/agent.md')) {
            if (moveAfterRelease) headSha = 'c'.repeat(40);
            if (moveBaseAfterGuide) baseSha = 'c'.repeat(40);
            if (exceedDeadline) vi.spyOn(Date, 'now').mockReturnValue(now + 19_000);
            return guideBody instanceof Response ? guideBody : Response.json(guideBody);
          }
          if (request.url.includes('/contents/')) {
            const url = new URL(request.url);
            const key = `${url.searchParams.get('ref')}:${decodeURIComponent(url.pathname.split('/contents/')[1])}`;
            const body = composeBodies[key];
            if (moveAfterContents) baseSha = 'c'.repeat(40);
            return body instanceof Response ? body : body ? Response.json(body)
              : Response.json({ message: 'Missing' }, { status: 404 });
          }
          if (request.url.includes('/pulls/17/files')) {
            if (moveAfterFiles) headSha = 'c'.repeat(40);
            return Response.json(changedFiles);
          }
          const checks = oversizedChecks;
          if (checks && request.url.includes('/check-runs?')) {
            const url = new URL(request.url);
            const perPage = Number(url.searchParams.get('per_page'));
            const page = Number(url.searchParams.get('page'));
            const first = (page - 1) * perPage;
            const count = Math.max(0, Math.min(perPage, checks.count - first));
            return Response.json({ total_count: checks.count,
              check_runs: Array.from({ length: count }, (_, index) => ({ id: checks.overlap && first > 0 && index === 0
                ? first - 1 : first + index, name: `check-${first + index}`,
                conclusion: 'success', output: 'x'.repeat(checks.outputBytes) })) }, {
              headers: first + count < checks.count ? { link: '<https://api.github.com/next>; rel="next"' } : {},
            });
          }
          if (expireAfterRead) vi.spyOn(Date, 'now').mockReturnValue(now + 26_000);
          return Response.json({ number: 17, body: 'inline-secret',
            user: { login: 'fork-specific-bot[bot]', id: 42, type: 'Bot' },
            base: { sha: baseSha }, head: { sha: headSha } });
        } }),
        LlmInterceptor: () => ({ fetch: async (request: Request) => {
          sent.push(request); if (uncertain) return Response.json({ error: 'lost response' }, { status: 502 });
          return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
        } }),
      } },
      waitUntil: { configurable: true, value: (promise: Promise<unknown>) => { pending.push(promise); } },
    });
    const context = native;
    const encryption = { ENCRYPTION_KEY: btoa('a'.repeat(32)) };
    const registry = { getManagementBundle: async () => bytes,
      resolveManagementExecution: async () => revoked ? { ok: false, reason: 'disabled' } : { ok: true, value: selection },
      admitManagement: async (input: unknown) => ({ ok: true, value: { ...input as object, admittedAt: now, selection } }),
      upsertOwnedActivity: async () => {},
    };
    const environment = { ...encryption, ENTERPRISE_MODE: 'active',
      OPERATOR_REGISTRY: { getByName: () => registry }, OPERATOR_ACTIVITY: { getByName: () => activity, idFromName: () => native.id },
      LOADER: { get: () => ({ getDurableObjectClass: () => ({}) }) },
    } as unknown as Env;
    const activityEnvironment = environment as unknown as ConstructorParameters<typeof OperatorActivity>[1];
    activity = new OperatorActivity(context, activityEnvironment);
    const invocationJson = JSON.stringify(invocation);
    const execution = await createOperatorExecutionContext({ activityId, operatorId: 'operator', artifactDigest,
      policyDigest: await digest(JSON.stringify(policy)), human, accessJwt: 'private.jwt' }, encryption);
    await activity.prepareAuthorized({ activityId, operatorId: 'operator', installationId: 'installation',
      intentDigest: await createOperatorIntentDigest('operator', activityId, invocationJson),
      expectedRevision: 1, expectedInstallationRevision: 1, expectedControlsRevision: 1,
      deadline: expiresAt * 1000, startExpiresAt: expiresAt * 1000, startVerifier: await digest('s'.repeat(43)) }, execution, invocationJson);
    expect(await activity.start('s'.repeat(43))).toEqual({ ok: true, phase: 'queued' });
    const capability = new OperatorDispatcherCapability({ props: { activityId, generation: 1 } } as unknown as ExecutionContext,
      environment as unknown as ConstructorParameters<typeof OperatorDispatcherCapability>[1]);
    const staleCapability = new OperatorDispatcherCapability({ props: { activityId, generation: 2 } } as unknown as ExecutionContext,
      environment as unknown as ConstructorParameters<typeof OperatorDispatcherCapability>[1]);
    try {
      await test({ activity, capability, staleCapability, environment, artifactDigest, sent,
        settle: (id = 'submission-1', outcome = 'completed', error?: unknown) => {
          settlements = [{ submissionId: id, outcome, error }];
          if (id === 'submission-1' && outcome === 'completed' && !messagesSet) {
            messages = [{ submissionId: id, parts: [{ type: 'data-assessment', data: {
              repository: 'owner/repo', pullRequest: 17, observedHead: 'b'.repeat(40), readOnly: true,
              assessment: { classification: 'unknown', reasons: ['No verified compatibility declaration'] },
            } }] }];
          }
        },
        messages: value => { messages = value; messagesSet = true; },
        files: value => { changedFiles = value; }, compose: value => { composeBodies = value; },
        release: (value, status = 200) => { releaseBody = value; releaseStatus = status; },
        guide: value => { guideBody = value; }, tag: value => { tagRef = value; },
        annotatedTag: value => { annotatedTag = value; },
        moveHeadAfterFiles: () => { moveAfterFiles = true; },
        moveHeadAfterRelease: () => { moveAfterRelease = true; },
        expireAfterRead: () => { expireAfterRead = true; },
        moveBaseAfterContents: () => { moveAfterContents = true; },
        moveBaseAfterGuide: () => { moveBaseAfterGuide = true; },
        exceedReleaseDeadline: () => { exceedDeadline = true; },
        exceedGuideDeadline: () => { exceedDeadline = true; },
        expire: () => { vi.spyOn(Date, 'now').mockReturnValue(expiresAt * 1000 + 1); },
        revoke: () => { revoked = true; },
        abortStatus: () => aborted, restart: () => (activity = new OperatorActivity(context, activityEnvironment)),
        loseResponse: () => { uncertain = true; },
        throwTransport: () => { transportThrows = true; },
        emptyResponse: () => { emptyResponse = true; },
        upstreamConflict: enabled => { upstreamConflict = enabled; },
        oversizedChecks: (count = 76, outputBytes = 3000, overlap = false) => {
          oversizedChecks = { count, outputBytes, overlap };
        },
        nextAlarm: () => native.storage.getAlarm(),
      });
    } finally {
      await activity.cancelDrive();
      vi.restoreAllMocks();
      await Promise.allSettled(pending);
    }
  });
}
function composeRead(operationId = 'compose-1', extra = {}) {
  return new Request('https://operator.internal/v1/dispatcher/github/read', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, resource: 'changed-compose', ...extra }) });
}
function releaseRead(operationId = 'release-1', extra = {}) {
  return new Request('https://operator.internal/v1/dispatcher/github/read', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, resource: 'release-notes', ...extra }) });
}
function guideRead(operationId = 'guide-1', extra = {}) {
  return new Request('https://operator.internal/v1/dispatcher/github/read', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, resource: 'upstream-guide', ...extra }) });
}
function changedCompose(path: string, sha = 'd'.repeat(40)) {
  return { filename: path, status: 'modified', sha, additions: 1, deletions: 1,
    patch: '-    image: amir20/dozzle:v11.1.1\n+    image: amir20/dozzle:v11.1.2' };
}
function composeBlob(path: string, sha: string, content: string) {
  return { path, sha, type: 'file', size: new TextEncoder().encode(content).byteLength,
    encoding: 'base64', content: btoa(content) };
}
function dozzleFiles(before = 'v11.1.1', after = 'v11.1.2') {
  return [{ filename: 'compose.yaml', status: 'modified', additions: 1, deletions: 1,
    patch: `-    image: amir20/dozzle:${before}\n+    image: amir20/dozzle:${after}` }];
}
function read(operationId = 'read-1', extra = {}) {
  return new Request('https://operator.internal/v1/dispatcher/github/read', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId, resource: 'pull-request', ...extra }) });
}
async function start(f: Parameters<Parameters<typeof fixture>[0]>[0]) {
  return driveDispatcherRuntime({ activity: f.activity, deadline: Date.now() + 25_000,
    bundle, artifactDigest: f.artifactDigest, invocation });
}

describe('REQ-OPERATOR-047/048: production Dispatcher lease and restricted effects', () => {
  it('exposes only PR identity, never a secret-bearing description', () => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(read('project-pr'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ number: 17, head: { sha: 'b'.repeat(40) }, base: { sha: 'a'.repeat(40) },
      user: { login: 'fork-specific-bot[bot]', id: 42, type: 'Bot' } });
    expect(JSON.stringify(body)).not.toContain('inline-secret');
  }));
  it('passes only complete image deltas from PR files, never secret-bearing patch context or other changes', () => fixture(async f => {
    await start(f);
    f.files([{ ...changedCompose('middleware/dozzle/compose.yaml'),
      patch: '@@ -1,3 +1,3 @@\n- image: amir20/dozzle:v11.1.1\n+ image: amir20/dozzle:v11.1.2\n  password: inline-secret' },
    { ...changedCompose('tools/dozzle_agent/compose.yaml'), additions: 2, deletions: 2,
      patch: '- image: amir20/dozzle:v11.1.1\n+ image: amir20/dozzle:v11.1.2\n- DOZZLE_AUTH_TOKEN=inline-secret\n+ DOZZLE_AUTH_TOKEN=other-secret' },
    { filename: 'private/inline-secret.txt', status: 'modified', additions: 1, deletions: 1,
      patch: '-password=inline-secret\n+password=other-secret' }]);
    const response = await f.capability.fetch(read('safe-files', { resource: 'files' }));
    expect(response.status).toBe(200);
    const result = await response.json() as { data: Array<{ patch: string | null; filename: string }> };
    expect(result.data).toMatchObject([
      { filename: 'middleware/dozzle/compose.yaml', patch: '- image: amir20/dozzle:v11.1.1\n+ image: amir20/dozzle:v11.1.2' },
      { filename: 'tools/dozzle_agent/compose.yaml', patch: null },
      { filename: '[other-changed-file]', patch: null },
    ]);
    expect(JSON.stringify(result)).not.toContain('inline-secret');
    expect(JSON.stringify(result)).not.toContain('other-secret');
  }));
  it('projects version-relevant default server and agent configuration without disclosing stable private values', () => fixture(async f => {
    await start(f);
    const paths = ['middleware/dozzle/compose.yaml', 'ai_llm/dozzle_agent/compose.yaml'];
    f.files(paths.map(path => changedCompose(path)));
    const bodies: Record<string, unknown> = {};
    for (const [index, path] of paths.entries()) {
      for (const [ref, tag, sha] of [['a'.repeat(40), 'v11.1.1', 'e'.repeat(40)],
        ['b'.repeat(40), 'v11.1.2', 'd'.repeat(40)]]) {
        bodies[`${ref}:${path}`] = composeBlob(path, sha, index === 0
          ? `services:\n  dozzle:\n    image: amir20/dozzle:${tag}\n    environment:\n      DOZZLE_REMOTE_AGENT: agent.internal:7007\n    volumes:\n      - /private/docker.sock:/var/run/docker.sock:ro\n    ports:\n      - '8080:8080'\n`
          : `services:\n  dozzle-agent:\n    image: amir20/dozzle:${tag}\n    command: agent\n    volumes:\n      - /private/docker.sock:/var/run/docker.sock:ro\n    ports:\n      - '7007:7007'\n`);
      }
    }
    f.compose(bodies);
    const response = await f.capability.fetch(composeRead());
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ files: [
      { path: paths[0], unchangedConfiguration: true,
        before: { services: [{ mode: 'server', redacted: true, environmentKeys: ['DOZZLE_REMOTE_AGENT'] }] },
        after: { services: [{ mode: 'server', redacted: true, environmentKeys: ['DOZZLE_REMOTE_AGENT'] }] } },
      { path: paths[1], unchangedConfiguration: true,
        before: { services: [{ mode: 'agent', redacted: false }] },
        after: { services: [{ mode: 'agent', redacted: false }] } },
    ] });
    expect(JSON.stringify(result)).not.toContain('agent.internal');
    expect(JSON.stringify(result)).not.toContain('/private/docker.sock');
  }));
  it('does not hide harmless unchanged ports and Docker socket mounts on a default server', () => fixture(async f => {
    await start(f); const path = 'middleware/dozzle/compose.yaml'; f.files([changedCompose(path)]);
    const bodies: Record<string, unknown> = {};
    for (const [ref, tag, sha] of [['a'.repeat(40), 'v11.1.1', 'e'.repeat(40)],
      ['b'.repeat(40), 'v11.1.2', 'd'.repeat(40)]]) {
      bodies[`${ref}:${path}`] = composeBlob(path, sha,
        `services:\n  dozzle:\n    image: amir20/dozzle:${tag}\n    container_name: private-dozzle\n    restart: unless-stopped\n    network_mode: bridge\n    volumes:\n      - /private/docker.sock:/var/run/docker.sock:ro\n    ports:\n      - '8080:8080'\n`);
    }
    f.compose(bodies);
    const response = await f.capability.fetch(composeRead());
    expect(response.status).toBe(200);
    const output = await response.json();
    expect(output).toMatchObject({ files: [{ unchangedConfiguration: true,
      before: { services: [{ mode: 'server', redacted: false }] },
      after: { services: [{ mode: 'server', redacted: false }] } }] });
    expect(JSON.stringify(output)).not.toContain('/private/docker.sock');
    expect(JSON.stringify(output)).not.toContain('private-dozzle');
  }));
  it.each([
    { name: 'persistent /data', property: "    volumes:\n      - /private/dozzle:/data\n" },
    { name: 'external env file', property: "    env_file: /private/agent.env\n" },
    { name: 'interpolated settings', property: "    environment:\n      DOZZLE_REMOTE_AGENT: ${DOZZLE_AGENTS}\n" },
    { name: 'external override', property: "    extends:\n      file: /private/shared.yml\n      service: dozzle\n" },
  ])('keeps $name unresolved despite unchanged image-excluded configuration', ({ property }) => fixture(async f => {
    await start(f); const path = 'middleware/dozzle/compose.yaml'; f.files([changedCompose(path)]);
    const bodies: Record<string, unknown> = {};
    for (const [ref, tag, sha] of [['a'.repeat(40), 'v11.1.1', 'e'.repeat(40)],
      ['b'.repeat(40), 'v11.1.2', 'd'.repeat(40)]]) {
      bodies[`${ref}:${path}`] = composeBlob(path, sha,
        `services:\n  dozzle:\n    image: amir20/dozzle:${tag}\n${property}`);
    }
    f.compose(bodies);
    const response = await f.capability.fetch(composeRead());
    expect(response.status).toBe(200);
    const output = await response.json();
    expect(output).toMatchObject({ files: [{ unchangedConfiguration: true,
      after: { services: [{ redacted: true }] } }] });
    expect(JSON.stringify(output)).not.toContain('/private/');
    expect(JSON.stringify(output)).not.toContain('${DOZZLE_AGENTS}');
  }));
  it('projects every admitted server and agent Compose blob at pinned base/head without leaking inline secrets', () => fixture(async f => {
    await start(f);
    const paths = ['middleware/dozzle/compose.yaml', 'tools/dozzle_agent/compose.yaml'];
    f.files(paths.map(path => changedCompose(path)));
    const bodies: Record<string, unknown> = {};
    for (const [index, path] of paths.entries()) {
      const service = index === 0 ? 'dozzle' : 'dozzle-agent';
      for (const [ref, tag, sha] of [['a'.repeat(40), 'v11.1.1', 'e'.repeat(40)],
        ['b'.repeat(40), 'v11.1.2', 'd'.repeat(40)]]) {
        bodies[`${ref}:${path}`] = composeBlob(path, sha,
          `services:\n  ${service}:\n    image: amir20/dozzle:${tag}\n    command: ${index === 0 ? 'server' : 'agent'}\n    environment:\n      DOZZLE_AUTH_TOKEN: inline-secret\n`);
      }
    }
    f.compose(bodies);
    const response = await f.capability.fetch(composeRead());
    expect(response.status).toBe(200);
    const result = await response.json() as { files: unknown[] };
    expect(result).toMatchObject({ repository: 'owner/repo', pullRequest: 17,
      baseSha: 'a'.repeat(40), observedHead: 'b'.repeat(40), files: paths.map(path => ({ path,
        before: { sha: 'e'.repeat(40), services: [{ image: 'amir20/dozzle:v11.1.1', mode: path.includes('agent') ? 'agent' : 'server', redacted: true }] },
        after: { sha: 'd'.repeat(40), services: [{ image: 'amir20/dozzle:v11.1.2', mode: path.includes('agent') ? 'agent' : 'server', redacted: true }] } })) });
    expect(JSON.stringify(result)).not.toContain('inline-secret');
    expect(JSON.stringify(result)).toContain('DOZZLE_AUTH_TOKEN');
  }));
  it('reads pinned Compose blobs despite an omitted diff patch without inferring safety', () => fixture(async f => {
    await start(f);
    const path = 'middleware/dozzle/compose.yaml';
    f.files([{ ...changedCompose(path), patch: undefined }]);
    f.compose({ [`${'a'.repeat(40)}:${path}`]: composeBlob(path, 'e'.repeat(40),
      'services:\n  dozzle:\n    image: amir20/dozzle:v11.1.1\n'),
    [`${'b'.repeat(40)}:${path}`]: composeBlob(path, 'd'.repeat(40),
      'services:\n  dozzle:\n    image: amir20/dozzle:v11.1.2\n') });
    const response = await f.capability.fetch(composeRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ files: [{ path, unchangedConfiguration: true,
      before: { sha: 'e'.repeat(40), services: [{ mode: 'server', redacted: false }] },
      after: { sha: 'd'.repeat(40), services: [{ mode: 'server', redacted: false }] } }] });
  }));
  it.each(['missing', 'wrong-sha', 'oversized', 'redirect', 'moved-base', 'moved-head', 'pagination', 'foreign-path'])('rejects $name changed Compose provenance', name => fixture(async f => {
    await start(f);
    const path = 'middleware/dozzle/compose.yaml';
    f.files(name === 'pagination' ? Array.from({ length: 101 }, (_, index) => changedCompose(`group-${index}/compose.yaml`))
      : [changedCompose(name === 'foreign-path' ? '../secrets/compose.yaml' : path)]);
    const before = composeBlob(path, 'e'.repeat(40), 'services:\n  dozzle:\n    image: amir20/dozzle:v11.1.1\n');
    const after = composeBlob(path, name === 'wrong-sha' ? 'f'.repeat(40) : 'd'.repeat(40),
      name === 'oversized' ? `services:\n  dozzle:\n    image: amir20/dozzle:v11.1.2\n    labels: ${'x'.repeat(70_000)}`
        : 'services:\n  dozzle:\n    image: amir20/dozzle:v11.1.2\n');
    f.compose({ [`${'a'.repeat(40)}:${path}`]: before,
      ...name === 'missing' ? {} : { [`${'b'.repeat(40)}:${path}`]: name === 'redirect'
        ? new Response(null, { status: 302, headers: { location: 'https://evil.invalid/' } }) : after } });
    if (name === 'moved-base') f.moveBaseAfterContents();
    if (name === 'moved-head') f.moveHeadAfterFiles();
    expect((await f.capability.fetch(composeRead())).status).toBe(409);
  }));
  it('rejects child-selected paths, refs and URLs before protected Compose I/O', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(composeRead('chosen', { path: 'other/compose.yaml' }))).status).toBe(403);
    expect((await f.capability.fetch(composeRead('chosen-ref', { ref: 'a'.repeat(40) }))).status).toBe(403);
    expect((await f.capability.fetch(composeRead('chosen-url', { url: 'https://evil.invalid/' }))).status).toBe(403);
  }));
  it('reads only the release identified by the admitted PR diff and returns a pinned receipt', () => fixture(async f => {
    await start(f); f.files(dozzleFiles());
    const response = await f.capability.fetch(releaseRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ observedHead: 'b'.repeat(40),
      source: 'https://github.com/amir20/dozzle/releases/tag/v11.1.2',
      repository: 'amir20/dozzle', tag: 'v11.1.2', body: 'No configuration changes' });
    expect(f.sent.map(r => r.url)).toEqual([
      'https://api.github.com/repos/owner/repo/pulls/17',
      'https://api.github.com/repos/owner/repo/pulls/17/files?per_page=100&page=1',
      'https://api.github.com/repos/owner/repo/pulls/17',
      'https://api.github.com/repos/amir20/dozzle/releases/tags/v11.1.2',
      'https://api.github.com/repos/owner/repo/pulls/17',
    ]);
    expect(f.sent.every(r => !r.headers.has('authorization') && r.redirect === 'manual')).toBe(true);
  }));
  it('reads one cited upstream release for thirteen compose image changes of Komodo #1299', () => fixture(async f => {
    await start(f);
    f.files(['ai_llm', 'dns_ntp', 'komodo_core', 'media_servers', 'minecraft', 'nextcloud',
      'openziti-i', 'openziti-ii', 'openziti-iii', 'servarr', 'storage', 'tools']
      .map(group => ({ ...dozzleFiles()[0], filename: `${group}/dozzle_agent/compose.yaml` }))
      .concat([{ ...dozzleFiles()[0], filename: 'middleware/dozzle/compose.yaml' }]));
    const response = await f.capability.fetch(releaseRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tag: 'v11.1.2', repository: 'amir20/dozzle',
      observedHead: 'b'.repeat(40) });
  }));
  it('derives a later eligible upstream release from the admitted PR rather than hardcoding #1299', () => fixture(async f => {
    await start(f); f.files(dozzleFiles('v11.1.2', 'v11.1.3'));
    f.release({ tag_name: 'v11.1.3', body: 'New migration notes',
      html_url: 'https://github.com/amir20/dozzle/releases/tag/v11.1.3' });
    const response = await f.capability.fetch(releaseRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tag: 'v11.1.3', body: 'New migration notes',
      source: 'https://github.com/amir20/dozzle/releases/tag/v11.1.3', observedHead: 'b'.repeat(40) });
  }));
  it('reads an immutable version-tagged official agent guide through a fixed parent source', () => fixture(async f => {
    await start(f); f.files(dozzleFiles());
    const response = await f.capability.fetch(guideRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ repository: 'amir20/dozzle', tag: 'v11.1.2',
      observedHead: 'b'.repeat(40), commitSha: '1'.repeat(40),
      source: `https://github.com/amir20/dozzle/blob/${'1'.repeat(40)}/docs/guide/agent.md`,
      body: expect.stringContaining('run Dozzle with the `agent` subcommand') });
    expect(f.sent.map(r => r.url)).toContain(
      `https://api.github.com/repos/amir20/dozzle/contents/docs/guide/agent.md?ref=${'1'.repeat(40)}`);
    expect(f.sent.every(r => !r.headers.has('authorization') && r.redirect === 'manual')).toBe(true);
  }));
  it('also binds a lightweight tag directly to a pinned guide commit', () => fixture(async f => {
    await start(f); f.files(dozzleFiles());
    f.tag({ ref: 'refs/tags/v11.1.2', object: { type: 'commit', sha: '1'.repeat(40) } });
    const response = await f.capability.fetch(guideRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tag: 'v11.1.2', commitSha: '1'.repeat(40) });
    expect(f.sent.some(r => r.url.includes('/git/tags/'))).toBe(false);
  }));
  it.each([
    { name: 'wrong version tag', replace: (f: { tag: (value: unknown) => void }) =>
      f.tag({ ref: 'refs/tags/v11.1.1', object: { type: 'tag', sha: '3'.repeat(40) } }) },
    { name: 'unresolved tag object', replace: (f: { annotatedTag: (value: unknown) => void }) =>
      f.annotatedTag({ tag: 'v11.1.2', object: { type: 'tag', sha: '1'.repeat(40) } }) },
    { name: 'mismatched annotated tag', replace: (f: { annotatedTag: (value: unknown) => void }) =>
      f.annotatedTag({ tag: 'v11.1.1', object: { type: 'commit', sha: '1'.repeat(40) } }) },
    { name: 'wrong guide path', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide(composeBlob('docs/other.md', '2'.repeat(40), 'not an agent guide')) },
    { name: 'redirected guide', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide(Response.json({ message: 'Moved' }, { status: 302 })) },
    { name: 'missing guide', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide(Response.json({ message: 'Missing' }, { status: 404 })) },
    { name: 'invalid guide encoding', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide({ ...composeBlob('docs/guide/agent.md', '2'.repeat(40), 'agent'), content: '$not-base64' }) },
    { name: 'mismatched guide blob SHA', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide(composeBlob('docs/guide/agent.md', '2'.repeat(40), guideExcerpt)) },
    { name: 'oversized guide', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide(composeBlob('docs/guide/agent.md', '2'.repeat(40), 'x'.repeat(70_000))) },
  ])('rejects a $name without exposing a guide to the child', ({ replace }) => fixture(async f => {
    await start(f); f.files(dozzleFiles()); replace(f);
    expect((await f.capability.fetch(guideRead())).status).toBe(409);
  }));
  it('rejects a moved PR while reading the version-tagged guide', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.moveHeadAfterRelease();
    expect((await f.capability.fetch(guideRead())).status).toBe(409);
  }));
  it('rejects a moved base while reading the version-tagged guide', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.moveBaseAfterGuide();
    expect((await f.capability.fetch(guideRead())).status).toBe(409);
  }));
  it('rejects a late guide even when the upstream transport ignores abort', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.exceedGuideDeadline();
    expect((await f.capability.fetch(guideRead())).status).toBe(409);
  }));
  it('denies child-selected guide URL, repository and ref before upstream I/O', () => fixture(async f => {
    await start(f); f.files(dozzleFiles());
    for (const extra of [{ url: 'https://evil.invalid/' }, { repository: 'other/repo' }, { ref: 'main' }]) {
      expect((await f.capability.fetch(guideRead('chosen', extra))).status).toBe(403);
    }
    expect(f.sent.every(r => !r.url.includes('/git/ref/tags/'))).toBe(true);
  }));
  it('rejects release evidence when the PR head changes after the files read', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.moveHeadAfterFiles();
    expect((await f.capability.fetch(releaseRead())).status).toBe(409);
  }));
  it('rejects release evidence when the PR head changes during the upstream read', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.moveHeadAfterRelease();
    expect((await f.capability.fetch(releaseRead())).status).toBe(409);
  }));
  it('does not return late upstream notes even when a transport ignores abort', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.exceedReleaseDeadline();
    expect((await f.capability.fetch(releaseRead())).status).toBe(409);
  }));
  it.each([
    { files: [], name: 'no matching diff' },
    { files: [...dozzleFiles(), { filename: 'agent/compose.yaml', status: 'modified', additions: 1,
      deletions: 1 }], name: 'unavailable Compose patch' },
    { files: [{ ...dozzleFiles()[0], additions: 2,
      patch: `${dozzleFiles()[0].patch}\n+ image: amir20/dozzle:v11.1.3` }], name: 'mixed edits in one Compose patch' },
    { files: [{ ...dozzleFiles()[0], additions: 2 }], name: 'truncated Compose patch' },
    { files: [{ filename: 'compose.yaml', status: 'modified', additions: 1, deletions: 1,
      patch: '- image: amir20/dozzle:v11.1.1\n+ image: attacker/dozzle:v11.1.2' }], name: 'foreign image' },
    { files: [...dozzleFiles(), { filename: 'other/compose.yaml', status: 'modified', additions: 1, deletions: 1,
      patch: '- image: amir20/dozzle:v11.1.1\n+ image: amir20/dozzle:v11.1.3' }], name: 'conflicting image tag' },
  ])('does not fetch upstream for $name', ({ files }) => fixture(async f => {
    await start(f); f.files(files);
    expect((await f.capability.fetch(releaseRead())).status).toBe(409);
    expect(f.sent.every(r => !r.url.includes('/releases/'))).toBe(true);
  }));
  it.each([
    { value: { tag_name: 'v11.1.2', body: 'notes', html_url: 'https://evil.test/note' }, status: 200 },
    { value: { tag_name: 'v11.1.1', body: 'notes', html_url: 'https://github.com/amir20/dozzle/releases/tag/v11.1.1' }, status: 200 },
    { value: { message: 'Moved' }, status: 302 },
    { value: { tag_name: 'v11.1.2', body: 'x'.repeat(70_000), html_url: 'https://github.com/amir20/dozzle/releases/tag/v11.1.2' }, status: 200 },
  ])('rejects unverified, redirecting or oversized upstream notes', ({ value, status }) => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.release(value, status);
    expect((await f.capability.fetch(releaseRead())).status).toBe(409);
  }));
  it('denies child URL, repository and credential selection on release read', () => fixture(async f => {
    await start(f); f.files(dozzleFiles());
    expect((await f.capability.fetch(releaseRead('release-foreign', { url: 'https://evil.test/' }))).status).toBe(403);
    expect((await f.capability.fetch(releaseRead('release-other', { repository: 'other/repo' }))).status).toBe(403);
    expect(f.sent.every(r => !r.url.includes('/releases/tags/'))).toBe(true);
  }));
  it('reserves once; admission and unrelated settlement remain running; exact settlement alone permits continuation', () => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true, state: { status: 'running', generation: 1 } });
    expect(await start(f)).toEqual({ ok: false, reason: 'drive-active' });
    expect(await f.activity.commitDrive(1, { schemaVersion: 1, status: 'waiting', checkpoint: null }))
      .toEqual({ ok: false, reason: 'invalid-update' });
    f.settle('foreign'); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('waiting');
    expect(await f.activity.beginDrive()).toMatchObject({ ok: true, state: { generation: 2 } });
    expect((await f.capability.fetch(read())).status).toBe(403);
  }));
  it('rechecks a later settlement before the bounded lease expires without caller continuation', () => fixture(async f => {
    const startedAt = Date.now();
    await start(f);
    await f.activity.reconcileDispatcherLease();
    const alarm = await f.nextAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThan(startedAt + 15_000);
    f.settle();
    vi.spyOn(Date, 'now').mockReturnValue(alarm! + 1_000);
    await f.activity.alarm();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('waiting');
  }));
  it('fences a completed model turn with no submitted assessment instead of advertising waiting', () => fixture(async f => {
    await start(f);
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'text', text: 'Assessment incomplete' }] }]);
    f.settle();
    await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }));
  it('fences failed settlement rather than granting a continuation', () => fixture(async f => {
    await start(f); f.settle('submission-1', 'failed'); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect(await start(f)).toEqual({ ok: false, reason: 'drive-settled' });
  }));
  it('collects the settled pinned assessment once as a terminal result without another submission', () => fixture(async f => {
    await start(f);
    const assessment = { repository: 'owner/repo', pullRequest: 17, observedHead: 'b'.repeat(40), readOnly: true,
      evidence: { complete: false, stale: false, truncated: false, bot: 'renovate[bot]' },
      bounds: { files: 3, checks: 76 }, assessment: { classification: 'unknown',
        observedHead: 'b'.repeat(40), baseSha: 'a'.repeat(40), checks: { state: 'unconfigured', observedHead: null },
        reasons: ['No complete upstream evidence'], compatibility: 'Compatibility cannot be established',
        citations: [], gaps: ['Migration guidance unavailable'] } };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'waiting',
      sdkCleanupReleased: true });
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
      executionStatus: 'completed', collectionStatus: 'consumed', sdkCleanupReleased: true, result: assessment } });
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
      executionStatus: 'completed', result: assessment } });
    expect((await f.activity.getBrowserDetail())?.result).toEqual(assessment);
  }));
  it('keeps SDK cleanup unproved on failure and retries only cleanup after terminal collection', () => fixture(async f => {
    const sdk = Agent.prototype as unknown as { _cf_cleanupFacetPrefix: (...args: unknown[]) => Promise<void> };
    const original = sdk._cf_cleanupFacetPrefix;
    let failCleanup = true;
    vi.spyOn(sdk, '_cf_cleanupFacetPrefix').mockImplementation(function (this: Agent, ...args: unknown[]) {
      if (failCleanup) throw new Error('Synthetic SDK cleanup failure');
      return original.apply(this, args);
    });
    try {
      await start(f);
      const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
      f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
      f.settle(); await f.activity.reconcileDispatcherLease();
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'waiting', sdkCleanupReleased: false });
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: false, result: assessment } });
      failCleanup = false;
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: true, result: assessment } });
    } finally { failCleanup = false; }
  }));
  it.each(['missing', 'foreign', 'duplicate', 'oversized'] as const)(
    'does not manufacture a terminal assessment from %s settled evidence', variant => fixture(async f => {
      await start(f);
      const output = { readOnly: true, observedHead: 'b'.repeat(40) };
      const part = { type: 'data-assessment', data: output };
      const messages = variant === 'missing' ? [] : variant === 'foreign'
        ? [{ submissionId: 'foreign', parts: [part] }]
        : [{ submissionId: 'submission-1', parts: variant === 'duplicate' ? [part, part]
          : [{ type: 'data-assessment', data: { payload: 'x'.repeat(70 * 1024) } }] }];
      f.messages(messages);
      f.settle(); await f.activity.reconcileDispatcherLease();
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect((await f.activity.getBrowserDetail())?.result).toBeNull();
    }));
  it('fences a single checks page exceeding the protected 64 KiB response bound', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(read('submission-pull-request'))).status).toBe(200);
    f.oversizedChecks(1, 70_000);
    expect((await f.capability.fetch(read('submission-checks', { resource: 'checks' }))).status).toBe(409);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
  }));
  it('returns all 76 authorized check conclusions from bounded pages without forwarding large metadata', () => fixture(async f => {
    await start(f); f.oversizedChecks();
    const response = await f.capability.fetch(read('submission-checks', { resource: 'checks' }));
    expect(response.status).toBe(200);
    const evidence = await response.json() as { data: { check_runs: unknown[] }; truncated: boolean };
    expect(evidence.truncated).toBe(false);
    expect(evidence.data.check_runs).toHaveLength(76);
    expect(evidence.data.check_runs[75]).toEqual({ name: 'check-75', conclusion: 'success' });
    expect(new TextEncoder().encode(JSON.stringify(evidence)).byteLength).toBeLessThan(64 * 1024);
    expect(f.sent.some(request => new URL(request.url).searchParams.get('page') === '8')).toBe(true);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
  }));
  it('marks a check list beyond the 100-run bound as truncated rather than complete', () => fixture(async f => {
    await start(f); f.oversizedChecks(101);
    const response = await f.capability.fetch(read('submission-checks', { resource: 'checks' }));
    expect(response.status).toBe(200);
    const evidence = await response.json() as { data: { check_runs: unknown[] }; truncated: boolean };
    expect(evidence.truncated).toBe(true);
    expect(evidence.data.check_runs.length).toBeLessThanOrEqual(100);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
  }));
  it('marks overlapping check pages incomplete even when the row count matches', () => fixture(async f => {
    await start(f); f.oversizedChecks(20, 3000, true);
    const response = await f.capability.fetch(read('submission-checks', { resource: 'checks' }));
    expect(response.status).toBe(200);
    const evidence = await response.json() as { truncated: boolean };
    expect(evidence.truncated).toBe(true);
  }));
  it('fences expired leases even when their exact settlement arrives late', () => fixture(async f => {
    await start(f); f.expire(); f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
  }));
  it('fences uncertain admission without retrying the generated child', async () => {
    let state = { generation: 1, status: 'running', checkpoint: null, result: null };
    const activity = { beginDrive: async () => ({ ok: true, state }),
      admitDispatcher: async () => { throw new Error('lost admission'); },
      interruptDrive: async () => ({ ok: true, state: state = { ...state, generation: 2, status: 'unknown' } }),
    } as unknown as OperatorActivity;
    expect(await driveDispatcherRuntime({ activity, deadline: Date.now() + 1000,
      bundle, artifactDigest: await digest(bytes), invocation })).toMatchObject({ ok: true, state: { status: 'unknown' } });
  });
  it('resumes the exact persisted lease after reconstruction without re-admission', () => fixture(async f => {
    await start(f); f.settle(); const restarted = f.restart();
    await restarted.reconcileDispatcherLease();
    expect((await restarted.getBrowserDetail())?.executionStatus).toBe('waiting');
  }));
  it('fences before signaling facet abort and rejects late settlement and warmed effects', () => fixture(async f => {
    await start(f); expect((await f.capability.fetch(read())).status).toBe(200);
    await f.activity.cancelDrive(); expect(f.abortStatus()).toBe('cancel-requested');
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('cancel-requested');
    expect((await f.capability.fetch(read('read-2'))).status).toBe(403);
  }));
  it.each(['expire', 'revoke'] as const)('denies %s without new protected effects', action => fixture(async f => {
    await start(f); expect((await f.capability.fetch(read())).status).toBe(200);
    f[action](); expect((await f.capability.fetch(read('read-2'))).status).toBe(403);
    expect(f.sent.map(r => r.url)).toEqual(['https://api.github.com/repos/owner/repo/pulls/17']);
  }));
  it('sends the parent-owned GitHub REST User-Agent for both bounded PR and files reads', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(read('files-read', { resource: 'files' }))).status).toBe(200);
    expect(f.sent.map(request => request.headers.get('user-agent'))).toEqual([
      'Codeflare-Operator-Dispatcher', 'Codeflare-Operator-Dispatcher',
    ]);
    expect(f.sent.every(request => !request.headers.has('authorization'))).toBe(true);
  }));
  it('reconciles completed operation output and conflicts on changed semantics', () => fixture(async f => {
    await start(f); const first = await f.capability.fetch(read());
    expect(await (await f.capability.fetch(read())).text()).toBe(await first.text());
    expect((await f.capability.fetch(read('read-1', { resource: 'files' }))).status).toBe(409);
    expect(f.sent.map(r => r.method)).toEqual(['GET']);
  }));
  it.each([
    { name: 'conflict', stage: 'reservation', resource: 'files', deadline: 'current', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        await f.capability.fetch(read('diagnostic-conflict'));
        return f.capability.fetch(read('diagnostic-conflict', { resource: 'files' }));
      } },
    { name: 'rejected transport uncertain operation', stage: 'effect', resource: 'pull-request', deadline: 'current', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.throwTransport(); return f.capability.fetch(read('diagnostic-uncertain'));
      } },
    { name: 'unreadable completed response', stage: 'effect', resource: 'pull-request', deadline: 'current', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.emptyResponse(); return f.capability.fetch(read('diagnostic-empty'));
      } },
    { name: 'expired authority', stage: 'authority', resource: 'unparsed', deadline: 'expired', status: 403,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.expire(); return f.capability.fetch(read('diagnostic-expired'));
      } },
    { name: 'stale generation with current deadline', stage: 'authority', resource: 'unparsed', deadline: 'current', status: 403,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => f.staleCapability.fetch(read('diagnostic-stale')) },
    { name: 'upstream non-success response', stage: 'upstream', resource: 'pull-request', deadline: 'current', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.loseResponse(); return f.capability.fetch(read('diagnostic-upstream'));
      } },
    { name: 'forwarded upstream HTTP 409', stage: 'forwarded-upstream', resource: 'pull-request', deadline: 'current', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.upstreamConflict(true); return f.capability.fetch(read('diagnostic-forwarded'));
      } },
    { name: 'expired result commit', stage: 'commit', resource: 'pull-request', deadline: 'expired', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.expireAfterRead(); return f.capability.fetch(read('diagnostic-commit'));
      } },
  ])('REQ-OPERATOR-047/048: emits bounded $name diagnostic with its fenced response', ({ name, stage, resource, deadline, status, exercise }) => fixture(async f => {
    await start(f);
    const emitted: string[] = [];
    setLogLevel('warn');
    try {
      vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
      const response = await exercise(f);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(name === 'forwarded upstream HTTP 409'
        ? { error: 'upstream-conflict' } : { code: status === 403 ? 'OPERATOR_CAPABILITY_DENIED'
          : stage === 'reservation' ? 'OPERATOR_OPERATION_CONFLICT' : 'OPERATOR_OPERATION_UNKNOWN' });
      const events = emitted.map(value => JSON.parse(value) as { module: string; message: string;
        data?: Record<string, unknown> }).filter(event => event.module === 'dispatcher-settlement'
        && event.message === 'Dispatcher operation rejected');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ data: { stage, resource, deadline, status } });
      expect(Object.keys(events[0].data ?? {}).sort()).toEqual(['deadline', 'resource', 'stage', 'status']);
      expect(JSON.stringify(events)).not.toMatch(/private transport failure|lost response|diagnostic-conflict|diagnostic-uncertain|diagnostic-empty|diagnostic-expired|diagnostic-stale|diagnostic-upstream|diagnostic-forwarded|diagnostic-commit|private\.jwt|inline-secret/);
      if (name === 'forwarded upstream HTTP 409') {
        expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
        f.upstreamConflict(false);
        const replay = await f.capability.fetch(read('diagnostic-forwarded'));
        expect(replay.status).toBe(409);
        expect(await replay.json()).toEqual({ error: 'upstream-conflict' });
        expect(emitted.filter(value => value.includes('Dispatcher operation rejected'))).toHaveLength(1);
        expect((await f.capability.fetch(read('diagnostic-fresh'))).status).toBe(200);
      } else if (stage === 'effect' || stage === 'upstream' || stage === 'commit') {
        expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
        expect((await f.capability.fetch(read('diagnostic-followup'))).status).toBe(403);
      } else if (stage === 'reservation' || deadline === 'current') {
        expect((await f.capability.fetch(read('diagnostic-fresh'))).status).toBe(200);
      } else {
        expect(f.sent.some(request => request.url.startsWith('https://api.github.com/'))).toBe(false);
      }
    } finally { setLogLevel('silent'); }
  }));
  it('does not replay uncertain effects and cannot commit waiting afterward', () => fixture(async f => {
    await start(f); f.loseResponse(); expect((await f.capability.fetch(read())).status).toBe(409);
    expect((await f.capability.fetch(read())).status).toBe(403);
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect(f.sent.map(r => r.method)).toEqual(['GET']);
  }));
  it('routes bounded inference through the parent interceptor without forwarding child authority', () => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(new Request('https://operator.internal/v1/dispatcher/inference', {
      method: 'POST', headers: { authorization: 'child-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'inference-1', input: { messages: [{ role: 'user', content: 'assess' }] } }),
    }));
    expect(response.status).toBe(200); expect(await response.text()).toBe('data: [DONE]\n\n');
    expect(f.sent[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(f.sent[0].headers.has('authorization')).toBe(false);
  }));
  it('denies foreign resources, unknown routes, oversized input and foreign/root scheduling while allowed reads work', () => fixture(async f => {
    await start(f); expect((await f.capability.fetch(read())).status).toBe(200);
    for (const request of [read('x', { repository: 'other/repo' }), read('x', { resource: 'merge' }),
      read('x', { padding: 'x'.repeat(65537) }), new Request('https://operator.internal/v1/session'),
      new Request('https://example.test/v1/dispatcher/github/read', { method: 'POST', body: '{}' })]) {
      expect((await f.capability.fetch(request)).status).toBe(403);
    }
    await expect(f.capability._cf_scheduleForFacet([{ className: 'OperatorActivity', name: 'foreign' }],
      1, 'cancelDrive')).rejects.toThrow();
    expect(f.sent.map(r => r.method)).toEqual(['GET']);
  }));
  it('delegates only the pinned child wake callback and scopes cancellation to that facet', () => fixture(async f => {
    await start(f);
    const plan = await f.activity.getRuntimePlan();
    const path = [{ className: 'OperatorActivity', name: plan!.activityId },
      { className: 'FlueDispatcherAgent', name: 'dispatcher' }];
    const created = await f.capability._cf_scheduleForFacet(path, 1, '__flueWakeAgentSubmissions');
    expect(await f.capability._cf_getScheduleForFacet(path, created.schedule.id)).toMatchObject({ type: 'delayed' });
    await expect(f.capability._cf_scheduleForFacet(path, 1, 'cancelDrive')).rejects.toThrow();
    await expect(f.capability._cf_getScheduleForFacet([path[0], { ...path[1], name: 'foreign' }], created.schedule.id))
      .rejects.toThrow();
    expect(await f.capability._cf_cancelScheduleForFacet(path, created.schedule.id)).toMatchObject({ ok: true });
    expect(await f.capability._cf_getScheduleForFacet(path, created.schedule.id)).toBeUndefined();
  }));
  it('admits only the activity-bound, connection-free child notifications without widening authority', () => fixture(async f => {
    await start(f);
    const plan = await f.activity.getRuntimePlan();
    const path = [{ className: 'OperatorActivity', name: plan!.activityId },
      { className: 'FlueDispatcherAgent', name: 'dispatcher' }];
    const bridge = f.capability as unknown as {
      _cf_subAgentConnectionMetas(ownerPath: typeof path): Promise<unknown>;
      _cf_broadcastToSubAgent(ownerPath: typeof path, message: unknown, without?: string[]): Promise<void>;
    };
    expect(await bridge._cf_subAgentConnectionMetas(path)).toEqual([]);
    await expect(bridge._cf_broadcastToSubAgent(path, { type: 'notice' })).resolves.toBeUndefined();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    const foreign = [{ ...path[0], name: 'other-activity' }, path[1]];
    await expect(bridge._cf_subAgentConnectionMetas(foreign)).rejects.toThrow();
    await expect(bridge._cf_broadcastToSubAgent(foreign, { type: 'notice' })).rejects.toThrow();
    await expect(bridge._cf_broadcastToSubAgent(path, 'x'.repeat(64 * 1024 + 1))).rejects.toThrow();
  }));
  it('orchestrates managed Dispatcher bundles without the default entrypoint path', () => fixture(async f => {
    const plan = await f.activity.getRuntimePlan();
    await runOperatorActivity(plan!.activityId, f.environment, () => { throw new Error('default capability must not be selected'); });
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
  }));
});
