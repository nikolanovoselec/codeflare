import { getSupportedThinkingLevels, type AuthResult, type ModelAuth, type Credential,
  type Provider, type Model, type Api, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { Env } from '../types';
import { createR2Client, getR2Url } from '../lib/r2-client';
import { SETUP_KEYS } from '../lib/kv-keys';
import { getSseHeaders } from '../lib/r2-sse';
import { isBucketMigrating, isR2SseDisabledForBucket } from '../lib/r2-regime-state';
import { readBoundedResponse } from '../lib/bounded-stream';
import { isPersonalPiDestination } from '../lib/personal-pi-destinations';
import { parseNativeOperatorInference, type NativeOperatorInference } from './inference-selection';
import { PiAuthRequiredError } from './pi-auth-failure';

const KEYS = { settings: '.pi/agent/settings.json', auth: '.pi/agent/auth.json', models: '.pi/agent/models.json' } as const;
const LIMIT = 1024 * 1024;
class InvalidSavedPiProfileError extends Error {}
async function beforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('Pi profile read expired'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { if (abort) signal.removeEventListener('abort', abort); }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function digest(value: unknown): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Only derived request auth escapes this reader. Never persist or log this result. */
export interface NativePiBinding {
  selection: NativeOperatorInference;
  auth: ModelAuth;
  env?: Record<string, string>;
  expiresAt: number | null;
}
export interface NativePiProfileReader {
  resolveSelection(reasoningOverride?: string): Promise<NativeOperatorInference>;
  bind(selection: NativeOperatorInference): Promise<NativePiBinding>;
}

function selectedModel(selection: Pick<NativeOperatorInference, 'provider' | 'model' | 'api'>): {
  provider: Provider; model: Model<Api>;
} {
  const provider = builtinProviders().find(provider => provider.id === selection.provider);
  const model = provider?.getModels().find(model => model.id === selection.model);
  if (!provider || !model || model.provider !== selection.provider || model.api !== selection.api) {
    throw new Error('Saved Pi built-in model is not eligible');
  }
  return { provider, model };
}
/** Auth-derived endpoints may narrow registered built-in families, never add arbitrary origins. */
function allowedEndpoint(value: string, provider: Provider): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (!isPersonalPiDestination(url) || url.search || url.hash) return false;
  const registered = [provider.baseUrl, ...provider.getModels().map(model => model.baseUrl)];
  if (registered.some(base => {
    try { return base !== undefined && new URL(base).origin === url.origin; } catch { return false; }
  })) return true;
  if (provider.id === 'github-copilot') return /^api\.(?:individual|business|enterprise)\.githubcopilot\.com$/.test(url.hostname);
  if (provider.id === 'azure') return /\.(?:openai|ai)\.azure\.com$|\.cognitiveservices\.azure\.com$/.test(url.hostname);
  if (provider.id === 'google-vertex') return /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(url.hostname);
  if (provider.id === 'amazon-bedrock') return /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(url.hostname);
  return false;
}
const PROVIDER_ENV: Readonly<Record<string, readonly string[]>> = {
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'],
  'azure': ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME',
    'AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_DEPLOYMENT_NAME_MAP'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'],
  'amazon-bedrock': ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_BEARER_TOKEN_BEDROCK'],
};
function permittedEnv(value: unknown, provider: string): value is Record<string, string> {
  return record(value) && Object.keys(value).length <= 64 && Object.entries(value).every(([key, item]) =>
    (PROVIDER_ENV[provider] ?? []).includes(key) && typeof item === 'string' && item.length <= 16 * 1024
      && !/[\r\n\0]/.test(item));
}
function requestAuth(result: AuthResult, provider: Provider, model: Model<Api>): Pick<NativePiBinding, 'auth' | 'env'> {
  const auth = result.auth;
  if (!record(auth) || Object.keys(auth).some(key => !['apiKey', 'headers', 'baseUrl'].includes(key))
    || (auth.apiKey !== undefined && (typeof auth.apiKey !== 'string' || !auth.apiKey.length
      || auth.apiKey.length > 32 * 1024 || /[\r\n\0]/.test(auth.apiKey)))
    || (auth.baseUrl !== undefined && (typeof auth.baseUrl !== 'string' || !allowedEndpoint(auth.baseUrl, provider)))
    || (auth.headers !== undefined && !record(auth.headers))) {
    throw new PiAuthRequiredError(provider.id, 'rejected');
  }
  const headers = { ...provider.headers, ...auth.headers, ...model.headers };
  if (Object.keys(headers).length > 64 || Object.entries(headers).some(([key, value]) =>
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(key)
    || /^(?:host|connection|content-length|transfer-encoding|cf-access-jwt-assertion|x-codeflare-.*)$/i.test(key)
    || value !== null && (typeof value !== 'string' || value.length > 16 * 1024 || /[\r\n\0]/.test(value)))) {
    throw new PiAuthRequiredError(provider.id, 'rejected');
  }
  if (result.env !== undefined && (!permittedEnv(result.env, provider.id)
    || Object.entries(result.env).some(([key, value]) => key.endsWith('_BASE_URL') && !allowedEndpoint(value, provider)))) {
    throw new PiAuthRequiredError(provider.id, 'rejected');
  }
  const permitted = { auth: { ...auth, ...(Object.keys(headers).length ? { headers } : {}) },
    ...(result.env ? { env: { ...result.env } } : {}) };
  if (new TextEncoder().encode(JSON.stringify(permitted)).byteLength > 48 * 1024) {
    throw new PiAuthRequiredError(provider.id, 'rejected');
  }
  return permitted;
}

/** Trusted owner scope and transport are supplied by the parent, not an agent request.
 * The returned capability has no path, bucket, credential, login or write operation.
 * `authorize` must recheck the exact owner/bucket and current admitted execution.
 */
export function createNativePiProfileReader(input: {
  ownerBucket: string; endpoint: string; sseKey?: string; deadline: number; signal?: AbortSignal;
  authorize(): Promise<void>; isBucketMigrating(): Promise<boolean>; isSseDisabledForBucket(): Promise<boolean>;
  fetcher(request: Request): Promise<Response>;
}): NativePiProfileReader {
  const endpoint = new URL(input.endpoint);
  if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(input.ownerBucket) || endpoint.protocol !== 'https:'
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/'
    || !Number.isSafeInteger(input.deadline)) throw new Error('Pi profile scope denied');
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []),
    AbortSignal.timeout(Math.max(1, Math.min(15_000, input.deadline - Date.now())))]);
  const current = async () => {
    if (signal.aborted || Date.now() >= input.deadline) throw new Error('Pi profile read expired');
    await input.authorize();
    if (await input.isBucketMigrating()) throw new Error('Pi profile bucket migrating');
    if (signal.aborted || Date.now() >= input.deadline) throw new Error('Pi profile read expired');
  };
  const boundedAuth = <T>(operation: Promise<T>): Promise<T> => beforeAbort(operation, signal);
  const read = async (key: keyof typeof KEYS): Promise<Record<string, unknown>> => {
    await current();
    const regime = await input.isSseDisabledForBucket();
    if (!regime && !input.sseKey) throw new Error('Pi profile encryption unavailable');
    const headers = getSseHeaders({ ENCRYPTION_KEY: input.sseKey }, regime);
    await current();
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('Pi profile read expired'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    let response: Response;
    try {
      const pending = input.fetcher(new Request(getR2Url(input.endpoint, input.ownerBucket, KEYS[key]),
        { method: 'GET', headers, redirect: 'manual', signal }));
      void pending.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => {});
      response = await Promise.race([pending, cancelled]);
    } catch { await current(); throw new Error('Pi profile read unavailable'); }
    finally { if (abort) signal.removeEventListener('abort', abort); }
    try { await current(); }
    catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
    if (response.redirected || ![200, 404].includes(response.status)) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('Pi profile read unavailable');
    }
    const bytes = response.status === 200 ? await readBoundedResponse(response, LIMIT, 'Pi profile', signal) : null;
    if (response.status === 404) void response.body?.cancel().catch(() => undefined);
    await current();
    if (regime !== await input.isSseDisabledForBucket()) throw new Error('Pi profile regime changed');
    await current();
    if (!bytes) return {};
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
    catch { throw new InvalidSavedPiProfileError('Invalid saved Pi profile'); }
    if (!record(parsed)) throw new InvalidSavedPiProfileError('Invalid saved Pi profile');
    return parsed;
  };
  const models = async (provider: string) => {
    const saved = await read('models');
    if (saved.providers !== undefined && !record(saved.providers)) throw new Error('Invalid saved Pi models');
    const configured = record(saved.providers) ? saved.providers[provider] : undefined;
    // Saved custom providers/endpoints are not built-in profile inheritance.
    if (configured !== undefined && (!record(configured) || Object.keys(configured).length)) {
      throw new Error('Custom Pi provider overrides are not eligible');
    }
  };
  return {
    resolveSelection: async reasoningOverride => {
      const settings = await read('settings');
      const provider = typeof settings.defaultProvider === 'string' ? settings.defaultProvider : '';
      const model = typeof settings.defaultModel === 'string' ? settings.defaultModel : '';
      const native = builtinProviders().find(value => value.id === provider);
      const selected = native?.getModels().find(value => value.id === model);
      if (!native || !selected) throw new Error('Saved Pi built-in model is not eligible');
      await models(provider);
      if (settings.modelThinkingLevels !== undefined && !record(settings.modelThinkingLevels)) throw new Error('Invalid Pi reasoning preference');
      const reasoningLevel = reasoningOverride ?? (record(settings.modelThinkingLevels)
        ? settings.modelThinkingLevels[`${provider}/${model}`] : undefined) ?? settings.defaultThinkingLevel ?? 'medium';
      if (typeof reasoningLevel !== 'string' || !getSupportedThinkingLevels(selected).includes(reasoningLevel as ModelThinkingLevel)) {
        throw new Error('Saved Pi reasoning is not supported');
      }
      const identity = { source: 'pi-native' as const, provider, model, api: selected.api, reasoningLevel };
      await current();
      return parseNativeOperatorInference({ ...identity, profileDigest: await digest(identity) });
    },
    bind: async admitted => {
      const selection = parseNativeOperatorInference(admitted);
      const { provider, model } = selectedModel(selection);
      if (!getSupportedThinkingLevels(model).includes(selection.reasoningLevel)) throw new Error('Saved Pi reasoning is not supported');
      await models(selection.provider);
      let entries: Record<string, unknown>;
      try { entries = await read('auth'); }
      catch (error) {
        if (error instanceof InvalidSavedPiProfileError) throw new PiAuthRequiredError(selection.provider, 'rejected');
        throw error;
      }
      const raw = Object.hasOwn(entries, selection.provider) ? entries[selection.provider] : undefined;
      if (!record(raw)) throw new PiAuthRequiredError(selection.provider, 'missing');
      let result: AuthResult | undefined;
      let expiresAt: number | null = null;
      if (raw.type === 'oauth') {
        if (!Number.isSafeInteger(raw.expires)) throw new PiAuthRequiredError(selection.provider, 'rejected');
        expiresAt = raw.expires as number;
        if (expiresAt <= Date.now()) throw new PiAuthRequiredError(selection.provider, 'expired');
        if (!provider.auth.oauth || typeof raw.access !== 'string' || !raw.access.length
          || typeof raw.refresh !== 'string') throw new PiAuthRequiredError(selection.provider, 'rejected');
        try { result = { auth: await boundedAuth(provider.auth.oauth.toAuth(raw as unknown as Extract<Credential, { type: 'oauth' }>)) }; }
        catch { await current(); throw new PiAuthRequiredError(selection.provider, 'rejected'); }
      } else if (raw.type === 'api_key') {
        if (!provider.auth.apiKey || typeof raw.key !== 'string' || !raw.key.trim() || raw.key.trimStart().startsWith('!')
          || raw.key.length > 32 * 1024 || /[\r\n\0]/.test(raw.key)
          || raw.env !== undefined && (!permittedEnv(raw.env, provider.id)
            || Object.entries(raw.env).some(([key, value]) => key.endsWith('_BASE_URL') && !allowedEndpoint(value, provider)))) {
          throw new PiAuthRequiredError(selection.provider, 'missing');
        }
        try {
          result = await boundedAuth(provider.auth.apiKey.resolve({ credential: { type: 'api_key', key: raw.key,
            ...(raw.env ? { env: raw.env as Record<string, string> } : {}) }, signal,
            ctx: { env: async () => undefined, fileExists: async () => false } }));
        } catch { await current(); throw new PiAuthRequiredError(selection.provider, 'rejected'); }
      } else throw new PiAuthRequiredError(selection.provider, 'missing');
      await current();
      if (expiresAt !== null && expiresAt <= Date.now()) throw new PiAuthRequiredError(selection.provider, 'expired');
      if (!result) throw new PiAuthRequiredError(selection.provider, 'missing');
      return { selection, ...requestAuth(result, provider, model), expiresAt };
    },
  };
}

/** Production composition uses platform R2 credentials privately, never session bootstrap. */
export async function createOwnerNativePiProfileReader(input: {
  env: Env; ownerBucket: string; deadline: number; signal?: AbortSignal; authorize(): Promise<void>;
}): Promise<NativePiProfileReader> {
  if (!Number.isSafeInteger(input.deadline) || input.deadline <= Date.now() || input.signal?.aborted) {
    throw new Error('Pi profile read expired');
  }
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []),
    AbortSignal.timeout(Math.max(1, Math.min(15_000, input.deadline - Date.now())))]);
  const current = async () => {
    if (signal.aborted || Date.now() >= input.deadline) throw new Error('Pi profile read expired');
    await beforeAbort(input.authorize(), signal);
    if (signal.aborted || Date.now() >= input.deadline) throw new Error('Pi profile read expired');
  };
  await current();
  // Native preparation is read-only: never discover accounts or self-heal setup KV.
  const accountId = input.env.R2_ACCOUNT_ID
    || await beforeAbort(input.env.KV.get(SETUP_KEYS.ACCOUNT_ID), signal);
  await current();
  if (!accountId) throw new Error('Pi profile storage configuration unavailable');
  const endpoint = input.env.R2_ACCOUNT_ID && input.env.R2_ENDPOINT
    ? input.env.R2_ENDPOINT : `https://${accountId}.r2.cloudflarestorage.com`;
  const client = createR2Client(input.env);
  return createNativePiProfileReader({ ...input, signal, endpoint, sseKey: input.env.ENCRYPTION_KEY,
    fetcher: request => client.fetch(request),
    isBucketMigrating: () => isBucketMigrating(input.env, input.ownerBucket),
    isSseDisabledForBucket: () => isR2SseDisabledForBucket(input.env, input.ownerBucket) });
}

/** Narrow read-only native request inspection; serialization remains entirely in Pi. */
export async function validateNativePiEgress(request: Request, selection: {
  provider: string; model: string; reasoningLevel: string;
}, limit: number, signal: AbortSignal = request.signal): Promise<boolean> {
  const provider = builtinProviders().find(value => value.id === selection.provider);
  const model = provider?.getModels().find(value => value.id === selection.model);
  if (!provider || !model || request.method !== 'POST' || request.headers.has('upgrade')
    || request.headers.has('content-encoding') || !getSupportedThinkingLevels(model).includes(selection.reasoningLevel as ModelThinkingLevel)) return false;
  const url = new URL(request.url);
  const destination = new URL(url);
  destination.search = '';
  if (!allowedEndpoint(destination.href, provider)) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await readBoundedResponse(
      new Response(request.clone().body), limit, 'Native Pi request', signal)));
  } catch { return false; }
  if (!record(payload)) return false;
  const path = url.pathname;
  const operationPath = (operation: string) => [model.baseUrl, provider.baseUrl].some(base => {
    try {
      if (base === undefined) return false;
      return path === `${new URL(base).pathname.replace(/\/+$/, '')}/${operation}`;
    } catch { return false; }
  });
  switch (model.api) {
    case 'openai-responses':
    case 'openai-codex-responses':
    case 'azure-openai-responses':
      // Pi's Codex API adds /codex to the registered backend-api base.
      return (operationPath(model.api === 'openai-codex-responses' ? 'codex/responses' : 'responses')
        || provider.id === 'azure' && path === '/openai/v1/responses')
        && payload.model === model.id && (selection.reasoningLevel === 'off'
          ? payload.reasoning === undefined || record(payload.reasoning) && payload.reasoning.effort === 'none'
          : record(payload.reasoning) && payload.reasoning.effort === selection.reasoningLevel);
    case 'openai-completions':
      return operationPath('chat/completions') && payload.model === model.id
        && (payload.reasoning_effort === undefined || payload.reasoning_effort === selection.reasoningLevel);
    case 'anthropic-messages':
      return operationPath('messages') && payload.model === model.id;
    case 'google-generative-ai':
    case 'google-vertex':
      return path.endsWith(`/models/${model.id}:streamGenerateContent`);
    case 'bedrock-converse-stream':
      try { return decodeURIComponent(path).endsWith(`/model/${model.id}/converse-stream`); } catch { return false; }
    case 'mistral-conversations':
      return operationPath('conversations') && payload.model === model.id;
    case 'pi-messages':
      return operationPath('messages') && payload.model === model.id;
    default: return false;
  }
}
