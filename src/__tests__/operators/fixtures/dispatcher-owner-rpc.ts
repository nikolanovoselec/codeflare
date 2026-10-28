/** CI-only owner/send boundary, not a Flue/application/session/model workload.
 * Production authorization, encryption, profile parsing and send/body reading stay real.
 * Only upstream Access, persisted selection/KV and the existing-container recipient
 * are controlled. Both owner session reads and Request/Response use native DO RPC.
 */
import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { discoverDispatcherOwnerProfile, forwardDispatcherOwnerInference,
  type ConfiguredDispatcherInference } from '../../../operators/dispatcher-owner-inference';
import { createOperatorExecutionContext } from '../../../operators/execution-context';
import type { OperatorRuntimePlan } from '../../../operators/activity';
import type { ManagementExecutionSelection } from '../../../operators/registry';
import { getBucketName } from '../../../lib/access';
import { getContainerId } from '../../../lib/container-helpers';
import { verifyHumanAccessJWT } from '../../../lib/jwt';
import { SETUP_KEYS } from '../../../lib/kv-keys';
import { getBuiltInProfileRef } from '../../../lib/reasoning-profiles';
import { verifiedRoutingConfiguration, routingGatewayUrl } from '../../helpers/verified-routing';
import { browserAccess } from './dispatcher-owner-diagnostics';

const configSchema = z.strictObject({
  operation: z.enum(['discovery', 'inference']), source: z.enum(['native', 'managed-default', 'managed-off']).default('native'),
  barrier: z.enum(['none', 'headers', 'body']).default('none'),
  size: z.enum(['ordinary', 'exact', 'actual-over', 'declared-over']).default('ordinary'),
  lifetimeMs: z.number().int().min(1000).max(30_000).default(30_000),
  fault: z.enum(['generation', 'installation', 'grant', 'session', 'aborted', 'expired']).optional(),
});
export type OwnerRpcConfig = z.input<typeof configSchema>;
type Config = z.output<typeof configSchema>;
const faultSchema = z.enum(['generation', 'installation', 'grant', 'session']);
type OwnerRpcFault = z.infer<typeof faultSchema>;
const commandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start'), config: configSchema }),
  z.strictObject({ action: z.literal('change'), fault: faultSchema }),
  ...['snapshot', 'abort', 'release-headers', 'release-body', 'cleanup'].map(action => z.strictObject({ action: z.literal(action) })),
]);
export type OwnerRpcCommand = { action: 'start'; config: OwnerRpcConfig } | { action: 'change'; fault: OwnerRpcFault }
  | { action: 'snapshot' | 'abort' | 'release-headers' | 'release-body' | 'cleanup' };

const OWNER_RPC_LIMIT = 1024;
const ownerRpcContext = { systemPrompt: 'Fixture system', messages: [
  { role: 'user', content: [{ type: 'text', text: 'Résumé fixture request' }] },
] };
const ownerRpcOptions = { reasoning: 'high', temperature: 0.25, maxTokens: 23 };
const ownerRpcResult = { role: 'assistant', provider: 'configured-provider', model: 'logical/é-model', api: 'configured-api',
  content: [{ type: 'text', text: 'Réponse ✓' }], stopReason: 'stop' };
const ownerRpcProfile = { provider: 'configured-provider', model: 'logical/é-model', api: 'configured-api',
  reasoningLevel: 'low' as const, profileDigest: 'd'.repeat(64) };
function selected(config: Config): ConfiguredDispatcherInference {
  return config.source === 'native' ? { source: 'pi-native', ...ownerRpcProfile }
    : { source: 'managed', routeId: 'approved', provider: 'codeflare-gateway', model: 'approved', api: 'openai-completions',
      reasoningLevel: config.source === 'managed-default' ? null : 'off', profileDigest: 'e'.repeat(64) };
}

type Wire = { url: string; method: string; contentType: string | null; activityHeader: string | null;
  generationHeader: string | null; schemaVersion: number; activityId: string; generation: number; sessionGeneration: number;
  operationId?: string; context?: typeof ownerRpcContext; options?: { reasoning?: string; temperature: number; maxTokens: number };
  requestDigest?: string; profileDigest?: string };
type Outcome = { status: 'pending' } | { status: 'refused'; failure: 'rpc-data-clone' | 'owner-refused' }
  | { status: 'accepted'; profile?: ConfiguredDispatcherInference; response?: { events: unknown[]; result: typeof ownerRpcResult }; responseBytes?: number };
export type OwnerRpcSnapshot = { outcome: Outcome; deadline: number; activityId: string; sessionGeneration: number;
  recipient: { entered: boolean; bodyOffered: boolean; headersReleased: boolean; bodyReleased: boolean;
    cancelled: boolean; responseBytes: number; wire: Wire | null } };
interface FixtureEnv { OWNER_RPC: DurableObjectNamespace<FixtureOwnerRpc> }

/** A runner and a distinct recipient address share this fixture-only class/namespace.
 * No production Activity/Flue DO is constructed or invoked by this fixture.
 */
export class FixtureOwnerRpc extends DurableObject<FixtureEnv> {
  private recipient?: DurableObjectStub<FixtureOwnerRpc>;
  private config?: Config;
  private outcome: Outcome = { status: 'pending' };
  private controller = new AbortController();
  private current = true;
  private selection?: ManagementExecutionSelection;
  private deadline = 0;
  private activityId = '';
  private sessionGeneration = 3;
  private wire: Wire | null = null;
  private bodyOffered = false;
  private headersReleased = false;
  private bodyReleased = false;
  private cancelled = false;
  private responseBytes = 0;
  private releaseHeaders?: () => void;
  private bodyController?: ReadableByteStreamController;
  private responseBody: Uint8Array = new Uint8Array();

  // Synthetic bucket-ownership collaborator; the production resolver still derives
  // the bucket and the real namespace resolves the resulting container address.
  claimBucketOwner(email: string): 'owned' { if (email !== 'owner@example.test') throw new Error('Fixture owner denied'); return 'owned'; }
  getPersonalPiSession(ref: { bucket: string; sessionId: string; email: string }) {
    if (ref.bucket !== getBucketName('owner@example.test') || ref.email !== 'owner@example.test'
      || !/^[a-f0-9]{24}$/.test(ref.sessionId)) throw new Error('Fixture source denied');
    return { generation: this.sessionGeneration };
  }
  configure(config: Config): void { this.config = config; }
  changeSession(): void { this.sessionGeneration++; }

  async forwardExisting(request: Request): Promise<Response> {
    const config = this.config;
    if (!config) throw new Error('Recipient not configured');
    const body = await request.json<Wire>();
    // Closed nonsecret projection: no headers, credentials or arbitrary caller keys.
    this.wire = { url: request.url, method: request.method, contentType: request.headers.get('content-type'),
      activityHeader: request.headers.get('x-codeflare-operator-activity'), generationHeader: request.headers.get('x-codeflare-operator-generation'),
      schemaVersion: body.schemaVersion, activityId: body.activityId, generation: body.generation, sessionGeneration: body.sessionGeneration,
      ...(config.operation === 'inference' ? { operationId: body.operationId, requestDigest: body.requestDigest,
        profileDigest: body.profileDigest, context: body.context && { systemPrompt: body.context.systemPrompt,
          messages: body.context.messages.map(message => ({ role: message.role,
            content: message.content.map(part => ({ type: part.type, text: part.text })) })) },
        options: body.options && { temperature: body.options.temperature, maxTokens: body.options.maxTokens,
          ...(body.options.reasoning === undefined ? {} : { reasoning: body.options.reasoning }) } } : {}) };
    if (config.barrier === 'headers' && !this.headersReleased) await new Promise<void>(resolve => { this.releaseHeaders = resolve; });
    const { source: _source, ...profile } = selected(config);
    // routeId belongs to the parent selection, not the strict SDK profile wire.
    const { routeId: _routeId, ...profileWire } = profile as typeof profile & { routeId?: string };
    const result = { ...ownerRpcResult, provider: profileWire.provider, model: profileWire.model, api: profileWire.api };
    let text = JSON.stringify(config.operation === 'discovery' ? profileWire
      : { events: [{ type: 'done', reason: 'stop', message: result }], result });
    if (config.size === 'exact' || config.size === 'actual-over') {
      text += ' '.repeat(OWNER_RPC_LIMIT - new TextEncoder().encode(text).byteLength + (config.size === 'actual-over' ? 1 : 0));
    }
    this.responseBody = new TextEncoder().encode(text);
    this.responseBytes = this.responseBody.byteLength;
    // workerd RPC serializes byte streams only; a generic stream would hide
    // the Request/AbortSignal defect behind a separate Response clone failure.
    const stream = new ReadableStream({
      type: 'bytes',
      start: controller => { this.bodyController = controller; },
      cancel: () => { this.cancelled = true; this.bodyController = undefined; },
    });
    this.bodyOffered = true;
    if (config.barrier === 'none' || this.bodyReleased) this.releaseBody();
    return new Response(stream, { headers: { 'content-type': 'application/json',
      ...(config.size === 'declared-over' ? { 'content-length': String(OWNER_RPC_LIMIT + 1) } : {}) } });
  }
  releaseHeaderBarrier(): void { this.headersReleased = true; this.releaseHeaders?.(); this.releaseHeaders = undefined; }
  releaseBody(): void {
    this.bodyReleased = true;
    if (this.bodyController) {
      this.bodyController.enqueue(this.responseBody);
      this.bodyController.close();
      this.bodyController = undefined;
    }
  }
  recipientSnapshot(): OwnerRpcSnapshot['recipient'] {
    return { entered: this.wire !== null, bodyOffered: this.bodyOffered, headersReleased: this.headersReleased,
      bodyReleased: this.bodyReleased, cancelled: this.cancelled, responseBytes: this.responseBytes, wire: this.wire };
  }

  private async change(fault: OwnerRpcFault) {
    if (fault === 'generation') this.current = false;
    else if (fault === 'installation') this.selection!.installation.revision++;
    else if (fault === 'grant') this.selection!.operator.invokers.users = [];
    else await this.recipient!.changeSession();
  }
  private async start(config: Config) {
    if (this.config) throw new Error('Fixture runner already started');
    this.config = config;
    const credential = await browserAccess();
    const human = await verifyHumanAccessJWT(credential.jwt, 'dispatcher-fixture.cloudflareaccess.com', 'fixture');
    if (!human) throw new Error('Fixture signed Access setup failed');
    this.activityId = crypto.randomUUID();
    const sessionId = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
    const bucket = getBucketName(human.email);
    this.recipient = this.env.OWNER_RPC.getByName(getContainerId(bucket, sessionId));
    await this.recipient.configure(config);
    const policy = { capabilities: ['inference'], resourceProfileId: null,
      ...(config.source === 'native' ? { inference: { allowedSources: ['pi-native' as const], routeIds: [], defaultRouteId: null,
        reasoningLevels: ['low'], defaultReasoningLevel: null, inheritUserDefaults: false } } : {}) };
    const grants = { users: [human.email], groups: [] };
    const pinned: ManagementExecutionSelection = {
      controlsRevision: 1, manifestJson: '{}',
      installation: { id: 'rpc-installation', operatorId: 'rpc-dispatcher', revision: 1, enabled: true, name: 'fixture',
        releaseId: 'rpc-release', approvedSourceRevision: 1, policy, configurationJson: '{}' },
      operator: { id: 'rpc-dispatcher', operatorId: 'rpc-dispatcher', revision: 1, repositoryUrl: 'https://github.com/example/fixture',
        repositoryId: 1, profile: 'dispatcher', realm: 'internal', enabled: true, managers: grants, invokers: grants,
        policy: { ...policy, inferenceRequestBytes: OWNER_RPC_LIMIT }, source: { kind: 'github-release', repositoryUrl: 'https://github.com/example/fixture',
          repositoryId: 1, credentialConfigured: true, approvedWorkflow: null } },
      release: { id: 'rpc-release', operatorId: 'rpc-dispatcher', githubReleaseId: 1, sourceCommit: 'a'.repeat(40),
        manifestDigest: 'b'.repeat(64), bundleDigest: 'c'.repeat(64), interfaceVersion: 1, approved: true,
        repositoryId: 1, sourceRevision: 1, coreVersion: '1', intentVersion: '4', requestedCapabilities: ['inference'], assets: [],
        provenance: { workflowId: 1, workflowRef: 'refs/heads/develop', runId: 1, runAttempt: 1, artifactId: 1, artifactDigest: 'f'.repeat(64) } },
    };
    this.selection = structuredClone(pinned);
    const encryption = { ENCRYPTION_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))) };
    const ref = getBuiltInProfileRef(config.source === 'managed-default'
      ? 'dynamic-bedrock-anthropic-provider-default' : 'openai-gpt-chat-tools-off');
    const gateway = { gatewayUrl: routingGatewayUrl, token: 'ephemeral-fixture-only' };
    const routing = verifiedRoutingConfiguration({ schemaVersion: 1, customProfileRevisions: [],
      routeAssignments: { approved: { activeProfile: ref } }, fallbackRouting: { enabled: true, routes: ['approved'], defaultRoute: 'approved',
        reasoning: 'off', piDefaultSource: config.source === 'native' ? 'pi-native' : 'managed', allowPersonalPiProviders: config.source === 'native' } }, gateway);
    const values: Record<string, string> = { [SETUP_KEYS.REASONING_CONFIGURATION]: JSON.stringify(routing), [SETUP_KEYS.DYNAMIC_ROUTES]: '["approved"]' };
    const environment = { ...encryption, ENTERPRISE_MODE: 'active', AIG_GATEWAY_URL: gateway.gatewayUrl, AIG_TOKEN: gateway.token,
      KV: { get: async (key: string) => values[key] ?? null }, CONTAINER: this.env.OWNER_RPC,
      OPERATOR_REGISTRY: { getByName: () => ({ resolveManagementExecution: async () => ({ ok: true, value: structuredClone(this.selection!) }) }) },
    } as unknown as Parameters<typeof discoverDispatcherOwnerProfile>[0]['env'];
    this.deadline = config.fault === 'expired' ? Date.now() - 1 : Date.now() + config.lifetimeMs;
    const executionContext = await createOperatorExecutionContext({ activityId: this.activityId, operatorId: 'rpc-dispatcher',
      artifactDigest: pinned.release.bundleDigest, policyDigest: 'f'.repeat(64), human, accessJwt: credential.jwt }, encryption);
    const plan: OperatorRuntimePlan = { activityId: this.activityId, ownerSource: { bucket, sessionId, sessionGeneration: 3 },
      deadline: this.deadline, invocationJson: '{"repository":"example/fixture"}', executionContext,
      receipt: { installationId: pinned.installation.id, activityId: this.activityId, intentDigest: 'a'.repeat(64), expectedInstallationRevision: 1,
        expectedOperatorRevision: 1, expectedControlsRevision: 1, deadline: this.deadline, admittedAt: Date.now(), selection: pinned } };
    if (config.fault === 'aborted') this.controller.abort();
    else if (config.fault && config.fault !== 'expired') await this.change(config.fault);
    const input = { generation: 7, plan, env: environment, current: async () => this.current, signal: this.controller.signal,
      waitUntil: (promise: Promise<unknown>) => this.ctx.waitUntil(promise) };
    // Public functions are the SUT. No wrapper changes their Request or cancellation.
    this.ctx.waitUntil((async () => {
      try {
        if (config.operation === 'discovery') this.outcome = { status: 'accepted', profile: await discoverDispatcherOwnerProfile(input) };
        else {
          const response = await forwardDispatcherOwnerInference({ ...input, selection: selected(config), operation: {
            operationId: 'fixture-inference', context: ownerRpcContext, options: ownerRpcOptions, requestDigest: '0'.repeat(64) } });
          const bytes = await response.arrayBuffer();
          this.outcome = { status: 'accepted', response: JSON.parse(new TextDecoder().decode(bytes)), responseBytes: bytes.byteLength };
        }
      } catch (error) {
        this.outcome = { status: 'refused', failure: error instanceof DOMException && error.name === 'DataCloneError' ? 'rpc-data-clone' : 'owner-refused' };
      }
    })());
  }
  async command(command: OwnerRpcCommand): Promise<OwnerRpcSnapshot | { started: true }> {
    if (command.action === 'start') { await this.start(configSchema.parse(command.config)); return { started: true }; }
    if (!this.recipient) throw new Error('Fixture runner not started');
    if (command.action === 'abort' || command.action === 'cleanup') this.controller.abort();
    if (command.action === 'change') await this.change(command.fault);
    if (command.action === 'release-headers' || command.action === 'cleanup') await this.recipient.releaseHeaderBarrier();
    if (command.action === 'release-body' || command.action === 'cleanup') await this.recipient.releaseBody();
    return { outcome: this.outcome, deadline: this.deadline, activityId: this.activityId, sessionGeneration: 3,
      recipient: await this.recipient.recipientSnapshot() };
  }
}

export async function ownerRpcFixture(request: Request, env: FixtureEnv): Promise<Response> {
  const id = new URL(request.url).searchParams.get('fixture');
  if (request.method !== 'POST' || !id || !/^[a-f0-9-]{36}$/.test(id)) return new Response(null, { status: 400 });
  const command = commandSchema.safeParse(await request.json());
  if (!command.success) return new Response(null, { status: 400 });
  return Response.json(await env.OWNER_RPC.getByName(`runner:${id}`).command(command.data as OwnerRpcCommand));
}
