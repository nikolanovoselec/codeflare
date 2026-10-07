/** CI-only composition: real Activity/SQL journal/Loader/Flue; catalog, identity and interceptor upstreams are fixtures. */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { getAgentByName } from 'agents';
import { OperatorActivity as ProductionActivity, OperatorDispatcherCapability as ProductionCapability,
  createOperatorIntentDigest } from '../../../operators/activity';
import { createOperatorExecutionContext } from '../../../operators/execution-context';
import { parseDispatcherBundle, type DispatcherBundle } from '../../../operators/distribution';
import { driveDispatcherRuntime } from '../../../operators/runtime';
import type { ManagementAdmissionRequest, ManagementExecutionSelection } from '../../../operators/registry';
import type { Env } from '../../../types';
import { SETUP_KEYS } from '../../../lib/kv-keys';
import { getBuiltInProfile, getBuiltInProfileRef } from '../../../lib/reasoning-profiles';
import { connectionFingerprint } from '../../../lib/reasoning-verification';
import { PI_WIRE_CANARY_VERSION } from '../../../lib/reasoning-discovery';

type RecoveryScenario = 'ordinary' | 'incomplete' | 'native-error' | 'precommit-reset' | 'committed-reset' | 'duplicate' | 'persistent';
interface FixtureEnv {
  KV: KVNamespace;
  LOADER: NonNullable<Env['LOADER']>;
  OPERATOR_ACTIVITY: DurableObjectNamespace<OperatorActivity>;
  RECOVERY_SERVICES: DurableObjectNamespace<RecoveryServices>;
}
const issuer = 'https://dispatcher-fixture.cloudflareaccess.com';
const email = 'owner@example.test';
const accessJwt = 'fixture-only-access';
const encryption = { ENCRYPTION_KEY: btoa('f'.repeat(32)) };
const gateway = { gatewayUrl: `https://gateway.ai.cloudflare.com/v1/${'a'.repeat(32)}/fixture/compat`, gatewayId: 'fixture', token: 'fixture-only-token' };
const repository = 'authorized/project';
const target = { pullRequest: 17, headSha: 'a'.repeat(40) };
const researchUrl = 'https://docs.example.test/migration';
const quote = 'Migration compatibility remains unverified.';
const comment = `${quote} Source: ${researchUrl}`;
const services = (env: FixtureEnv) => env.RECOVERY_SERVICES.getByName('services');
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const wire = (chunks: unknown[]) => new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
let identityService: { identity(): Promise<Response> } | undefined;
const externalFetch = globalThis.fetch;
// Synthetic Access upstream only. Production identity parsing, subject/email/grant checks remain real.
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  if (request.url === `${issuer}/cdn-cgi/access/get-identity`) {
    return identityService && request.redirect === 'manual' && request.headers.get('cookie') === `CF_Authorization=${accessJwt}`
      ? identityService.identity() : Promise.resolve(new Response(null, { status: 401 }));
  }
  return externalFetch(input, init);
}) as typeof fetch;

/** External service owns fault barriers; evicting the Activity does not erase paid-attempt observations. */
export class RecoveryServices extends DurableObject<FixtureEnv> {
  private releaseBarrier?: () => void;
  async configure(artifact: DispatcherBundle, digest: string, scenario: RecoveryScenario, attemptLimit: number) {
    const bytes = new TextEncoder().encode(JSON.stringify(artifact));
    await parseDispatcherBundle(bytes, digest);
    for (let offset = 0; offset < bytes.length; offset += 48 * 1024) await this.ctx.storage.put(`bundle:${offset}`, bytes.slice(offset, offset + 48 * 1024));
    await this.ctx.storage.put({ bundleSize: bytes.length, scenario, attemptLimit, revoked: false,
      inference: [], comments: [], sourceRequests: [], duplicates: [] });
    const policy = { capabilities: ['fetch', 'inference'], resourceProfileId: null };
    const grants = { users: [email], groups: [] };
    const selection: ManagementExecutionSelection = {
      controlsRevision: 1, manifestJson: '{}',
      installation: { id: 'composed-installation', operatorId: 'composed-dispatcher', revision: 1, enabled: true,
        name: 'fixture', releaseId: 'composed-release', approvedSourceRevision: 1, policy,
        configurationJson: JSON.stringify({ renovate: { repository, automaticRuns: false, repetitionIntervalSeconds: 3600 } }) },
      operator: { id: 'composed-dispatcher', operatorId: 'composed-dispatcher', revision: 1,
        repositoryUrl: 'https://github.com/example/dispatcher', repositoryId: 1, profile: 'dispatcher', realm: 'internal', enabled: true,
        managers: grants, invokers: grants, policy: { ...policy, inferenceAttemptLimit: attemptLimit },
        source: { kind: 'github-release', repositoryUrl: 'https://github.com/example/dispatcher', repositoryId: 1, credentialConfigured: true, approvedWorkflow: null } },
      release: { id: 'composed-release', operatorId: 'composed-dispatcher', githubReleaseId: 1, sourceCommit: artifact.sourceCommit,
        manifestDigest: 'b'.repeat(64), bundleDigest: digest, interfaceVersion: 1, approved: true,
        repositoryId: 1, sourceRevision: 1, coreVersion: '1', intentVersion: '3', requestedCapabilities: ['fetch', 'inference'], assets: [],
        provenance: { workflowId: 1, workflowRef: 'refs/heads/develop', runId: 1, runAttempt: 1, artifactId: 1, artifactDigest: 'c'.repeat(64) } },
    };
    await this.ctx.storage.put('selection', selection);
    const ref = getBuiltInProfileRef('openai-gpt-chat-tools-off');
    await this.env.KV.put(SETUP_KEYS.DYNAMIC_ROUTES, JSON.stringify(['approved']));
    await this.env.KV.put(SETUP_KEYS.REASONING_CONFIGURATION, JSON.stringify({ schemaVersion: 1, customProfileRevisions: [],
      routeAssignments: { approved: { activeProfile: ref, verification: { schemaVersion: 1, profileRef: ref,
        routeVersion: 'fixture-v1', inventoryDigest: 'd'.repeat(64), connectionFingerprint: connectionFingerprint(gateway),
        canaryVersion: PI_WIRE_CANARY_VERSION, supportedLevels: getBuiltInProfile(ref.id)!.supportedLevels,
        scope: 'single-model', checkedAt: new Date().toISOString() } } },
      fallbackRouting: { enabled: true, routes: ['approved'], defaultRoute: 'approved', reasoning: 'off' } }));
    return { ok: true };
  }
  async identity(): Promise<Response> {
    return await this.ctx.storage.get('revoked') ? new Response(null, { status: 401 })
      : Response.json({ user_uuid: 'fixture-owner', email });
  }
  async revoke() { await this.ctx.storage.put('revoked', true); }
  async resolveManagementExecution(_id: string) { return { ok: true, value: (await this.ctx.storage.get<ManagementExecutionSelection>('selection'))! }; }
  async admitManagement(request: ManagementAdmissionRequest) {
    return { ok: true, value: { ...request, admittedAt: Date.now(), selection: (await this.ctx.storage.get<ManagementExecutionSelection>('selection'))! } };
  }
  async upsertOwnedActivity(_owner: string, _summary: unknown) { /* Projection is read from the real owner in these cases. */ }
  async getManagementBundle(_digest: string) {
    const size = (await this.ctx.storage.get<number>('bundleSize'))!;
    const bytes = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += 48 * 1024) bytes.set((await this.ctx.storage.get<Uint8Array>(`bundle:${offset}`))!, offset);
    return bytes;
  }
  private async append(key: string, value: unknown) {
    await this.ctx.storage.transaction(async tx => { await tx.put(key, [...(await tx.get<unknown[]>(key) ?? []), value]); });
  }
  async claimFault(kind: string): Promise<boolean> {
    return this.ctx.storage.transaction(async tx => {
      if (await tx.get('scenario') !== kind || await tx.get(`fault:${kind}`)) return false;
      await tx.put(`fault:${kind}`, true); return true;
    });
  }
  async hold() {
    await this.ctx.storage.put('held', true);
    await new Promise<void>(resolve => { this.releaseBarrier = resolve; });
  }
  async release() { this.releaseBarrier?.(); this.releaseBarrier = undefined; await this.ctx.storage.put('released', true); }
  async duplicate(statuses: number[], digests: string[]) { await this.append('duplicates', { statuses, digests }); }
  async rememberSource(operationId: string) { if (!await this.ctx.storage.get('sourceId')) await this.ctx.storage.put('sourceId', operationId); }
  async sourceId() { return await this.ctx.storage.get<string>('sourceId'); }
  async budget(value: { operationCount: number; operationLimit: number }) { await this.ctx.storage.put('budget', value); }
  async observe() {
    return { inference: await this.ctx.storage.get('inference'), comments: await this.ctx.storage.get('comments'),
      sourceRequests: await this.ctx.storage.get('sourceRequests'), held: await this.ctx.storage.get('held') ?? false,
      duplicates: await this.ctx.storage.get('duplicates'), budget: await this.ctx.storage.get('budget') };
  }
  async inference(request: Request): Promise<Response> {
    const body = await request.text();
    const input = JSON.parse(body) as { messages: Array<{ tool_calls?: Array<{ function?: { name?: string } }> }> };
    const names = input.messages.flatMap(message => message.tool_calls?.map(tool => tool.function?.name) ?? []);
    const sequence = ['discover_renovate', 'research_renovate', 'decide_renovate', 'seal_dispatcher', 'comment_renovate', 'finish_dispatcher'];
    const turn = Math.max(-1, ...names.map(name => sequence.indexOf(name ?? ''))) + 1;
    await this.append('inference', { inputDigest: await hash(body), turn });
    if (await this.claimFault('precommit-reset')) await this.hold();
    if (await this.claimFault('incomplete') || await this.ctx.storage.get('scenario') === 'persistent') return wire([{ choices: [{ delta: {}, finish_reason: null }] }]);
    if (await this.claimFault('native-error')) return wire([{ error: { code: 'NATIVE_BEDROCK_STREAM_ERROR' } }]);
    const tool = sequence[turn];
    if (!tool) return new Response(null, { status: 400 });
    const artifact = `artifact-${(await hash(JSON.stringify({ target, url: researchUrl, kind: 'upstream' }))).slice(0, 24)}`;
    const args = tool === 'research_renovate' ? { target, url: researchUrl, kind: 'upstream' }
      : tool === 'decide_renovate' ? { target, decision: 'DO_NOT_MERGE', comment,
        claims: [{ artifactId: artifact, quote, relevance: 'migration uncertainty', authority: 'publisher guidance' }],
        analysis: { changedUsage: 'unverified', configuration: 'unverified', interoperability: 'unverified', migration: 'unverified', gaps: ['No verified compatibility declaration'] } }
      : tool === 'comment_renovate' ? { target } : {};
    return wire([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `composed-${turn}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]);
  }
  async source(request: Request): Promise<Response> {
    await this.append('sourceRequests', { url: request.url, method: request.method });
    const bot = { id: 29139614, login: 'renovate[bot]', type: 'Bot' };
    const actor = { id: 42, login: 'fixture-publisher', type: 'User' };
    const base = `https://api.github.com/repos/${repository}`;
    const pull = { number: 17, state: 'open', draft: false, created_at: new Date(Date.now() - 86400000).toISOString(),
      user: bot, head: { sha: target.headSha }, base: { sha: 'b'.repeat(40), ref: 'main', repo: { id: 123, full_name: repository } } };
    if (request.url === researchUrl) return new Response(quote, { headers: { 'content-type': 'text/plain' } });
    if (request.url === `${base}/issues/17/comments` && request.method === 'POST') {
      const value = await request.json<{ body: string }>();
      const entry = { id: 91, body: value.body, user: actor, issue_url: `${base}/issues/17` };
      await this.append('comments', entry); return Response.json(entry, { status: 201 });
    }
    if (request.method !== 'GET') return new Response(null, { status: 403 });
    const paths: Record<string, unknown> = {
      [base]: { id: 123, full_name: repository, default_branch: 'main' },
      'https://api.github.com/users/renovate%5Bbot%5D': bot,
      [`${base}/pulls?state=open&sort=created&direction=desc&per_page=1&page=1`]: [pull],
      [`${base}/pulls/17`]: pull,
      [`${base}/issues/17/comments?per_page=100`]: await this.ctx.storage.get('comments') ?? [],
      'https://api.github.com/user': actor,
    };
    return Object.hasOwn(paths, request.url) ? Response.json(paths[request.url]) : new Response(null, { status: 404 });
  }
}

/** This class name is deliberately the production SDK root path, not a separate synthetic Flue root. */
export class OperatorActivity extends ProductionActivity {
  private readonly instance = crypto.randomUUID();
  private readonly fixtureEnv: FixtureEnv;
  constructor(ctx: DurableObjectState, env: FixtureEnv) {
    identityService = services(env);
    super(ctx, { ...env, ...encryption, ENTERPRISE_MODE: 'active', AIG_GATEWAY_URL: gateway.gatewayUrl,
      AIG_GATEWAY_ID: gateway.gatewayId, AIG_TOKEN: gateway.token,
      OPERATOR_REGISTRY: { getByName: () => services(env) },
      CONTAINER: { idFromName: (name: string) => name, get: () => ({ claimBucketOwner: async () => 'owned' }) },
    } as unknown as Env);
    this.fixtureEnv = env;
  }
  async startComposed(id: string, artifact: DispatcherBundle, digest: string) {
    const now = Math.floor(Date.now() / 1000);
    const human = { subject: 'fixture-owner', email, issuer, audiences: ['fixture'], issuedAt: now - 1, expiresAt: now + 180 };
    const invocationJson = JSON.stringify({ repository });
    const context = await createOperatorExecutionContext({ activityId: id, operatorId: 'composed-dispatcher', artifactDigest: digest,
      policyDigest: await hash(JSON.stringify((await services(this.fixtureEnv).resolveManagementExecution('composed-installation')).value.installation.policy)), human, accessJwt }, encryption);
    const prepared = await this.prepareAuthorized({ activityId: id, operatorId: 'composed-dispatcher', installationId: 'composed-installation',
      intentDigest: await createOperatorIntentDigest('composed-dispatcher', id, invocationJson), expectedRevision: 1,
      expectedInstallationRevision: 1, expectedControlsRevision: 1, deadline: human.expiresAt * 1000,
      startExpiresAt: human.expiresAt * 1000, startVerifier: await hash('s'.repeat(43)) }, context, invocationJson);
    if (!prepared.ok) return prepared;
    const started = await this.start('s'.repeat(43));
    if (!started.ok) return started;
    return driveDispatcherRuntime({ activity: this, deadline: human.expiresAt * 1000, bundle: artifact,
      artifactDigest: digest, invocation: { repository } });
  }
  async observeComposed() {
    await this.reconcileDispatcherLease();
    return { instance: this.instance, detail: await this.getBrowserDetail(), external: await services(this.fixtureEnv).observe() };
  }
  evictComposed(): void { this.ctx.abort('CI composed Activity reset'); }
}

/** Production capability plus transparent fault delivery, never a substitute journal or SDK settlement. */
export class OperatorDispatcherCapability extends ProductionCapability {
  override async fetch(request: Request): Promise<Response> {
    const control = services(this.env as unknown as FixtureEnv);
    const path = new URL(request.url).pathname;
    if (path === '/v1/dispatcher/source') await control.rememberSource((await request.clone().json<{ operationId: string }>()).operationId);
    if (path !== '/v1/dispatcher/inference') return super.fetch(request);
    if (await control.claimFault('duplicate')) {
      const responses = await Promise.all([super.fetch(request.clone()), super.fetch(request)]);
      await control.duplicate(responses.map(response => response.status), await Promise.all(responses.map(async response => hash(await response.clone().text()))));
      return responses[0];
    }
    const response = await super.fetch(request);
    const operationId = await control.sourceId();
    if (response.ok && operationId) {
      const receipt = await super.fetch(new Request('https://operator.internal/v1/dispatcher/receipt', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId }) }));
      if (receipt.ok) {
        const { operationCount, operationLimit } = await receipt.json<{ operationCount: number; operationLimit: number }>();
        await control.budget({ operationCount, operationLimit });
      }
    }
    if (response.ok && await control.claimFault('committed-reset')) await control.hold();
    return response;
  }
}
export class LlmInterceptor extends WorkerEntrypoint<FixtureEnv> {
  fetch(request: Request) { return services(this.env).inference(request); }
}
export class GitHubInterceptor extends WorkerEntrypoint<FixtureEnv> {
  fetch(request: Request) { return services(this.env).source(request); }
}
export class EgressController extends WorkerEntrypoint<FixtureEnv> {
  fetch(request: Request) { return services(this.env).source(request); }
}
export async function composedFixture(request: Request, env: FixtureEnv): Promise<Response> {
  identityService = services(env);
  const command = await request.json<{ action: string; artifact?: DispatcherBundle; digest?: string; scenario?: RecoveryScenario; attemptLimit?: number }>();
  const id = new URL(request.url).searchParams.get('activity')!;
  const activity = await getAgentByName(env.OPERATOR_ACTIVITY, id);
  if (command.action === 'start') {
    await services(env).configure(command.artifact!, command.digest!, command.scenario ?? 'ordinary', command.attemptLimit ?? 4);
    return Response.json(await activity.startComposed(id, command.artifact!, command.digest!));
  }
  if (command.action === 'observe') return Response.json(await activity.observeComposed());
  if (command.action === 'collect') return Response.json(await activity.collectBrowserResult());
  if (command.action === 'evict') { await activity.evictComposed().catch(() => {}); return Response.json({ evicted: true }); }
  if (command.action === 'release') { await services(env).release(); return Response.json({ released: true }); }
  if (command.action === 'revoke') { await services(env).revoke(); return Response.json({ revoked: true }); }
  if (command.action === 'cancel') return Response.json(await activity.cancelDrive());
  return new Response(null, { status: 400 });
}
