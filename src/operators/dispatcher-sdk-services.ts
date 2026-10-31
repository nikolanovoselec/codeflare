/** Protected data/HTTP capabilities for the installed application's unchanged Pi SDK.
 * This module never resolves a model, refreshes OAuth, or parses vendor completions.
 */
import type { Env } from '../types';
import type { OperatorRuntimePlan } from './activity';
import { dispatcherSdkOwnerContext, type ConfiguredDispatcherInference } from './dispatcher-owner-inference';
import { readDispatcherSdkFiles, type SdkStorageScope } from './dispatcher-sdk-storage';
import { resolveBucketName } from '../lib/access';
import { getAigConfig } from '../lib/aig-config';
import { isDisallowedEgressHost } from '../lib/controller-egress';
import { isEnterpriseMode } from '../lib/subscription';
import { SETUP_KEYS } from '../lib/kv-keys';
import { authorizeDispatcherPlan, type createDispatcherOperation } from './operator-runtime-capability';
import { DispatcherRefusal } from './dispatcher-refusal';
import { emitRaw } from '../../host/src/operator-raw-logging';

export interface SdkInput {
  generation: number;
  plan: OperatorRuntimePlan;
  env: Env;
  current(): Promise<boolean>;
  signal?: AbortSignal;
  exports?: Parameters<typeof createDispatcherOperation>[0]['exports'] & {
    EgressController?: (input: { props: { strict: boolean } }) => Fetcher;
  };
}
type Owner = Awaited<ReturnType<typeof dispatcherSdkOwnerContext>>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function storageScope(input: SdkInput, owner: Pick<Owner, 'bucket' | 'email'>): SdkStorageScope {
  return { bucket: owner.bucket, email: owner.email, activityId: input.plan.activityId,
    generation: input.generation, deadline: input.plan.deadline };
}
function metadata(input: SdkInput, scope: SdkStorageScope) {
  const id = input.env.CONTAINER.idFromName(`bucket-owner:${scope.bucket}`);
  return input.env.CONTAINER.get(id) as unknown as {
    claimBucketOwner(email: string, allowInitialClaim: boolean): Promise<string>;
    dispatcherSdkCredentials(scope: SdkStorageScope, body: unknown): Promise<unknown | null>;
  };
}
async function sameOwner(input: SdkInput, original: Owner) {
  const current = await dispatcherSdkOwnerContext(input, input.plan.configuredSelection);
  if (current.bucket !== original.bucket || current.email !== original.email || current.source !== original.source) {
    throw new Error('SDK owner scope changed');
  }
  return current;
}
function failure(input: SdkInput, error: unknown): never {
  emitRaw({ activityId: input.plan.activityId, generation: input.generation,
    loggingEnabled: 'selection' in input.plan.receipt && input.plan.receipt.selection.operator.policy.loggingEnabled !== false },
  'sdk-service-failure', () => error);
  if (record(error) && error.status === 409) throw new DispatcherRefusal('operation-conflict');
  throw error;
}

export async function readDispatcherSdkConfiguration(input: SdkInput): Promise<Record<string, unknown>> {
  try {
    const owner = await dispatcherSdkOwnerContext(input, input.plan.configuredSelection);
    if (owner.source === 'managed') {
      if (!owner.managed) throw new Error('Managed SDK route unavailable');
      const { routeId, reasoningLevel } = owner.managed;
      // Match the platform-provisioned SDK namespace. No account credential enters this DTO.
      const configuration = { source: 'managed', routeId,
        settings: { defaultProvider: 'codeflare-gateway', defaultModel: routeId,
          ...(reasoningLevel === null ? {} : { defaultThinkingLevel: reasoningLevel }) },
        models: { providers: { 'codeflare-gateway': { baseUrl: 'https://api.openai.com/v1',
          api: 'openai-completions', apiKey: 'codeflare-enterprise',
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
          models: [{ id: routeId, name: routeId, reasoning: true }] } } },
        ...(input.plan.configuredSelection ? { selection: input.plan.configuredSelection } : {}) };
      await sameOwner(input, owner);
      return configuration;
    }
    const scope = storageScope(input, owner);
    if (await metadata(input, scope).claimBucketOwner(scope.email, false) !== 'owned') throw new Error('SDK storage owner denied');
    const files = await readDispatcherSdkFiles({ ...scope, env: input.env, signal: input.signal,
      current: async () => { await sameOwner(input, owner); return true; } });
    await sameOwner(input, owner);
    return { source: 'pi-native', ...files,
      ...(owner.reasoningOverride === undefined ? {} : { reasoningOverride: owner.reasoningOverride }),
      ...(input.plan.configuredSelection ? { selection: input.plan.configuredSelection } : {}) };
  } catch (error) { return failure(input, error); }
}

export async function dispatcherSdkCredentials(input: SdkInput, body: unknown): Promise<unknown | null> {
  try {
    if (!record(body)) throw new Error('SDK credential request invalid');
    const finishing = body.operation === 'commit' || body.operation === 'abort';
    // Only an already-begun metadata lease can finish after execution ends. The DO
    // checks original owner/run, provider CAS, and its own immutable 30-second expiry.
    const owner = finishing ? { email: input.plan.executionContext.owner.email.trim().toLowerCase(),
      bucket: await resolveBucketName(input.env, input.plan.executionContext.owner.email) }
      : await dispatcherSdkOwnerContext(input, input.plan.configuredSelection);
    if (!finishing && (!('source' in owner) || owner.source !== 'pi-native')) throw new Error('Native SDK credentials denied');
    const scope = storageScope(input, owner);
    const result = await metadata(input, scope).dispatcherSdkCredentials(scope, body);
    if (!finishing) await sameOwner(input, owner as Owner);
    return result;
  } catch (error) { return failure(input, error); }
}

export async function forwardDispatcherSdkHttp(input: SdkInput & {
  selection: ConfiguredDispatcherInference;
  request: { url: string; method: string; headers: Array<[string, string]>; bodyBase64?: string };
}): Promise<{ response: Response; transportCredentials: string[] }> {
  const owner = await dispatcherSdkOwnerContext(input, input.selection);
  const url = new URL(input.request.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || isDisallowedEgressHost(url.hostname) || url.hostname === 'operator.internal'
    || url.hostname.endsWith('.internal') || url.hostname.endsWith('.local')) throw new Error('SDK HTTP target denied');
  const headers = new Headers(input.request.headers);
  for (const name of headers.keys()) {
    if (/^(?:host|connection|content-length|transfer-encoding|upgrade|proxy-.*|cf-access-.*|x-codeflare-.*)$/i.test(name)) {
      throw new Error('SDK HTTP header denied');
    }
  }
  const body = input.request.bodyBase64 === undefined ? undefined
    : Uint8Array.from(atob(input.request.bodyBase64), character => character.charCodeAt(0));
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []),
    AbortSignal.timeout(Math.max(1, input.plan.deadline - Date.now()))]);
  const request = new Request(url, { method: input.request.method, headers, body, redirect: 'manual', signal });
  await sameOwner(input, owner);
  let response: Response;
  const transportCredentials: string[] = [];
  if (input.selection.source === 'managed') {
    if (url.href !== 'https://api.openai.com/v1/chat/completions' || request.method !== 'POST') throw new Error('Managed SDK HTTP target denied');
    const { authority, inferencePolicies } = await authorizeDispatcherPlan(input.plan, input.env);
    if (!inferencePolicies[0]) throw new Error('SDK policy unavailable');
    const policy = { ...inferencePolicies[0],
      inference: { routeIds: [input.selection.routeId], defaultRouteId: input.selection.routeId,
        reasoningLevels: input.selection.reasoningLevel === null ? [] : [input.selection.reasoningLevel],
        defaultReasoningLevel: input.selection.reasoningLevel, inheritUserDefaults: false } };
    const trusted = { routeId: input.selection.routeId, reasoningLevel: input.selection.reasoningLevel };
    const aig = await getAigConfig(input.env);
    // Match this transport's actual token, including its existing env fallback.
    // Retain it only in the Root-local result, never SDK configuration or receipts.
    const token = aig.token ?? input.env.AIG_TOKEN;
    if (token) transportCredentials.push(token);
    if (!input.exports?.LlmInterceptor) throw new Error('SDK Gateway transport unavailable');
    const transport = input.exports.LlmInterceptor({ props: { user: authority.human.email, groups: owner.groups,
      sessionId: input.plan.activityId, gatewayUrl: aig.gatewayUrl, gatewayId: aig.gatewayId, token,
      operatorInference: { activityId: input.plan.activityId, operatorId: input.plan.executionContext.operatorId, policy, trusted } } });
    response = await transport.fetch(request);
  } else {
    // Unlike container-start discovery, execution cannot interpret an unavailable
    // policy as permission for direct credential-bearing I/O. Failed reads throw.
    let strict = false;
    if (isEnterpriseMode(input.env)) {
      const setting = await input.env.KV.get(SETUP_KEYS.STRICT_EGRESS);
      if (setting !== null && setting !== 'active' && setting !== 'inactive') throw new Error('SDK transport policy unavailable');
      strict = setting === 'active';
    }
    if (strict) {
      if (!input.exports?.EgressController) throw new Error('SDK strict transport unavailable');
      const transport = input.exports.EgressController({ props: { strict: true } });
      response = await transport.fetch(request);
    } else response = await fetch(request);
  }
  try { await sameOwner(input, owner); signal.throwIfAborted(); }
  catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  return { response, transportCredentials };
}
