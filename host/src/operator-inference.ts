/** Configured owner Pi services with the public SDK's nonpersistent extension lifecycle.
 * REQ-OPERATOR-003/007/047/048: parent composition owns paths, selection and authority.
 */
import { createHash } from 'node:crypto';
import { findPackageJSON } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { emitRaw, captureRawValue, type RawLogContext } from './operator-raw-logging.js';

type JsonObject = Record<string, unknown>;
type Selection = { provider: string; model: string; api: string; reasoningLevel: string | null; profileDigest: string };
interface Model { provider: string; id: string; api: string; maxTokens: number }
interface InferenceSession { model?: Model; thinkingLevel: string; dispose(): void }
interface Services {
  modelRuntime: {
    getModel(provider: string, model: string): Model | undefined;
    getPhysicalModel(provider: string, model: string): Model | undefined;
    checkAuth(provider: string, options: { signal: AbortSignal }): Promise<unknown>;
    streamSimple(model: Model, context: unknown, options: JsonObject): AsyncIterable<JsonObject> & { result(): Promise<JsonObject> };
  };
  settingsManager: { getDefaultProvider(): string | undefined; getDefaultModel(): string | undefined;
    getDefaultThinkingLevel(): string | undefined; getModelThinkingLevel(provider: string, model: string): string | undefined };
  resourceLoader: { getExtensions(): { errors: unknown[] } };
  diagnostics: Array<{ type: string }>;
}
export interface OperatorInferenceOwner {
  cwd: string; agentDir: string; sdkRoot?: string; selection?: Selection;
  reasoningOverride?: string;
  managed?: { provider: string; model: string; reasoningLevel: string | null };
  ownerKey: string; sessionId: string; sessionGeneration: number; deadline: number;
  maxRequestBytes: number; maxResponseBytes: number;
  /** Original admitted decision; never read from caller options or current UI. */
  loggingEnabled?: boolean;
  current(binding: { ownerKey: string; sessionId: string; sessionGeneration: number; activityId: string; generation: number }): Promise<boolean>;
}
export type OperatorInferenceOwnerResolver = (bytes: Uint8Array, signal: AbortSignal, loggingContext?: RawLogContext) => Promise<OperatorInferenceOwner>;

class Refusal extends Error {
  constructor(readonly status: number, readonly authFailure?: { code: 'PI_LOGIN_REQUIRED'; reason: 'missing'; provider: string }) {
    super('Configured inference unavailable');
  }
}
export { Refusal as OperatorInferenceRefusal };

const record = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: JsonObject, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameSelection = (a: Selection, b: Selection) => ['provider', 'model', 'api', 'reasoningLevel', 'profileDigest']
  .every(key => a[key as keyof Selection] === b[key as keyof Selection]);

/** Existing authenticated HTTP transport invokes this only with a server-composed owner. */
export async function ownerInference(owner: OperatorInferenceOwner, profile: boolean, bytes: Uint8Array,
  callerSignal: AbortSignal, transportLogging?: RawLogContext): Promise<{ status: number; body: string }> {
  const reply = (status: number, value: unknown) => ({ status, body: JSON.stringify(value) });
  const controller = new AbortController();
  const signal = AbortSignal.any([callerSignal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let session: InferenceSession | undefined;
  let loggingContext: RawLogContext | undefined;
  const observations: unknown[] = [];
  const observe = (stage: string, value: unknown) => {
    if (loggingContext?.loggingEnabled === true) observations.push({ stage, value: captureRawValue(value) });
  };
  const flush = () => {
    if (!observations.length) return;
    // Assemble all observed values before redaction: deltas alone can expose
    // fragments of credentials that only become recognizable at completion.
    emitRaw(loggingContext, 'configured-owner-observations', () => observations.splice(0));
  };
  const disposeSession = () => {
    const completed = session;
    session = undefined;
    completed?.dispose();
  };
  const work = async () => {
    if (bytes.byteLength > owner.maxRequestBytes) throw new Refusal(413);
    let input: unknown;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Refusal(400); }
    const common = ['schemaVersion', 'activityId', 'generation', 'sessionGeneration'];
    if (!record(input) || !keys(input, profile ? common : [...common,
      'operationId', 'requestDigest', 'profileDigest', 'context', 'options'])
      || input.schemaVersion !== 1 || !id(input.activityId)
      || !Number.isSafeInteger(input.generation) || (input.generation as number) < 1
      || input.sessionGeneration !== owner.sessionGeneration) throw new Refusal(400);
    const binding = { ownerKey: owner.ownerKey, sessionId: owner.sessionId,
      sessionGeneration: owner.sessionGeneration, activityId: input.activityId, generation: input.generation as number };
    const current = async () => {
      if (signal.aborted || Date.now() >= owner.deadline || !await owner.current(binding)
        || signal.aborted || Date.now() >= owner.deadline) throw new Refusal(403);
    };
    await current();
    loggingContext = { activityId: binding.activityId, generation: binding.generation,
      loggingEnabled: owner.loggingEnabled === true && transportLogging?.loggingEnabled !== false,
      credentials: transportLogging?.credentials ?? [] };
    emitRaw(loggingContext, profile ? 'configured-profile-request' : 'configured-inference-request', () => input);
    const root = path.resolve(owner.sdkRoot ?? '/opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent');
    const sdk = await import(pathToFileURL(path.join(root, 'dist/index.js')).href) as {
      createAgentSessionServices(options: object): Promise<Services>;
      createAgentSessionFromServices(options: object): Promise<{ session: InferenceSession }>;
      SessionManager: { inMemory(cwd: string): unknown };
    };
    if (typeof sdk.createAgentSessionServices !== 'function'
      || typeof sdk.createAgentSessionFromServices !== 'function'
      || typeof sdk.SessionManager?.inMemory !== 'function') throw new Refusal(503);
    const services = await sdk.createAgentSessionServices({ cwd: owner.cwd, agentDir: owner.agentDir, modelRuntimeSignal: signal });
    await current();
    const extensionErrors = services.resourceLoader.getExtensions().errors;
    observe('sdk-services', { diagnostics: services.diagnostics, extensionErrors });
    if (services.diagnostics.some(item => item.type === 'error') || extensionErrors.length) {
      throw new Refusal(503);
    }
    const provider = owner.managed?.provider ?? services.settingsManager.getDefaultProvider();
    const modelId = owner.managed?.model ?? services.settingsManager.getDefaultModel();
    if (!provider || !modelId) throw new Refusal(409);
    const model = services.modelRuntime.getModel(provider, modelId);
    observe('configured-model', { provider, modelId, model });
    if (!model || model.provider !== provider || model.id !== modelId) throw new Refusal(409);
    const reasoningLevel = owner.managed ? owner.managed.reasoningLevel : owner.reasoningOverride
      ?? services.settingsManager.getModelThinkingLevel(provider, modelId) ?? services.settingsManager.getDefaultThinkingLevel() ?? 'medium';
    const identity = { provider, model: modelId, api: model.api, reasoningLevel };
    observe('configured-selection', identity);
    const selection = { ...identity, profileDigest: digest(identity) };
    const aiPackage = findPackageJSON('@earendil-works/pi-ai', pathToFileURL(path.join(root, 'package.json')));
    if (!aiPackage) throw new Refusal(503);
    const manifest = JSON.parse(await readFile(aiPackage, 'utf8'));
    const entry: unknown = manifest.exports?.['.']?.import;
    if (typeof entry !== 'string' || !entry.startsWith('./')) throw new Refusal(503);
    const ai = await import(new URL(entry, pathToFileURL(aiPackage)).href) as {
      getSupportedThinkingLevels(model: Model): readonly string[];
    };
    if (reasoningLevel !== null && !ai.getSupportedThinkingLevels(model).includes(reasoningLevel)) throw new Refusal(409);
    await current();
    if (profile) return reply(200, selection);
    if (!owner.selection || !sameSelection(owner.selection, selection) || input.profileDigest !== selection.profileDigest) {
      throw new Refusal(409);
    }
    if (!id(input.operationId) || typeof input.requestDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(input.requestDigest) || !record(input.context) || !Array.isArray(input.context.messages)
      || !record(input.options) || !keys(input.options, ['reasoning', 'maxTokens', 'temperature', 'toolChoice', 'thinkingBudgets', 'cacheRetention', 'sessionId'])
      || (selection.reasoningLevel === null ? input.options.reasoning !== undefined : input.options.reasoning !== selection.reasoningLevel)
      || (input.options.maxTokens !== undefined && (!Number.isSafeInteger(input.options.maxTokens)
        || (input.options.maxTokens as number) < 1 || (model.maxTokens > 0 && (input.options.maxTokens as number) > model.maxTokens)))
      || input.requestDigest !== digest({ context: input.context, options: input.options })) throw new Refusal(400);
    // A virtual selection may share a provider ID with physical models. Only a
    // physical model has a directly checkable credential; SDK routing owns all others.
    if (services.modelRuntime.getPhysicalModel(provider, modelId)
      && !await services.modelRuntime.checkAuth(provider, { signal })) {
      throw new Refusal(401, { code: 'PI_LOGIN_REQUIRED', reason: 'missing', provider });
    }
    await current();
    try {
      // SDK construction binds genuine extension context. Flue still owns the
      // transcript, tools and loop: never prompt this nonpersistent session.
      session = (await sdk.createAgentSessionFromServices({ services,
        sessionManager: sdk.SessionManager.inMemory(owner.cwd), model, noTools: true, tools: [],
        ...(reasoningLevel === null ? {} : { thinkingLevel: reasoningLevel }),
      })).session;
      await current();
      if (session.model?.provider !== provider || session.model.id !== modelId || session.model.api !== model.api
        || reasoningLevel !== null && session.thinkingLevel !== reasoningLevel) throw new Refusal(409);
      const stream = services.modelRuntime.streamSimple(model, input.context, { ...input.options, signal,
        ...(loggingContext?.loggingEnabled === true ? {
          onPayload: (payload: unknown) => { observe('provider-request', payload); },
          onResponse: (response: unknown) => { observe('provider-response', response); },
          onProviderStreamEvent: (event: unknown) => { observe('provider-stream-event', event); },
        } : {}),
      });
      const events: JsonObject[] = [];
      let size = 0;
      for await (const event of stream) {
        observe('sdk-event', event);
        await current();
        if (event.type === 'error') throw new Refusal(502);
        const encoded = JSON.stringify(event);
        size += Buffer.byteLength(encoded) + 1;
        if (size > owner.maxResponseBytes) throw new Refusal(413);
        events.push(JSON.parse(encoded) as JsonObject);
      }
      const result = await stream.result();
      observe('sdk-result', result);
      await current();
      if (result.stopReason === 'error' || result.stopReason === 'aborted'
        || events.at(-1)?.type !== 'done') throw new Refusal(502);
      const response = reply(200, { events, result });
      if (Buffer.byteLength(response.body) > owner.maxResponseBytes) throw new Refusal(413);
      return response;
    } finally { disposeSession(); flush(); }
  };
  try {
    if (!Number.isSafeInteger(owner.deadline) || owner.deadline <= Date.now()) throw new Refusal(403);
    timer = setTimeout(() => controller.abort(), Math.min(2_147_483_647, owner.deadline - Date.now()));
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Refusal(403));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    return await Promise.race([work(), cancelled]);
  } catch (error) {
    observe('configured-owner-failed', error);
    controller.abort();
    return error instanceof Refusal
      ? reply(error.status, { error: error.message, ...(error.authFailure ? { authFailure: error.authFailure } : {}) })
      : reply(503, { error: 'Configured inference unavailable' });
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
    disposeSession();
    flush();
  }
}
