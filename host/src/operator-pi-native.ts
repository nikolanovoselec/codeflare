import { OperatorPiAuthBinding, piAuthError, record, safePiAuthFailure, type SafePiAuthFailure } from './operator-pi-auth.js';

// Structural public Pi AI interfaces keep the provisioned SDK dynamically loaded.
export interface NativePiModel { provider: string; id: string; api: string; baseUrl?: string }
export interface NativePiProvider {
  id: string;
  name?: string;
  baseUrl?: string;
  headers?: Record<string, string | null>;
  getModels?(): readonly NativePiModel[];
  getAllModels?(): readonly unknown[];
  models?: readonly NativePiModel[];
  stream(model: NativePiModel, context: unknown, options?: Record<string, unknown>): unknown;
  streamSimple(model: NativePiModel, context: unknown, options?: Record<string, unknown>): unknown;
}
export interface NativePiAi {
  createProvider(options: object): NativePiProvider;
  getSupportedThinkingLevels(model: NativePiModel): readonly string[];
}

function allowedEndpoint(url: URL, provider: NativePiProvider, model: NativePiModel): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const catalog = [provider.baseUrl, model.baseUrl, ...(provider.getModels?.() ?? provider.models ?? []).map(item => item.baseUrl)];
  if (catalog.some(base => {
    try { return base !== undefined && new URL(base).origin === url.origin; } catch { return false; }
  })) return true;
  // Public built-in credential-derived endpoint families, matching the parent
  // profile boundary; none grants an arbitrary custom origin.
  if (provider.id === 'github-copilot') return /^api\.(?:individual|business|enterprise)\.githubcopilot\.com$/.test(url.hostname);
  if (provider.id === 'azure') return /\.(?:openai|ai)\.azure\.com$|\.cognitiveservices\.azure\.com$/.test(url.hostname);
  if (provider.id === 'google-vertex') return /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(url.hostname);
  if (provider.id === 'amazon-bedrock') return /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(url.hostname);
  return false;
}

/** Read only bounded structured error evidence, never retain upstream text. */
async function responseAuthFailure(response: Response, provider: string): Promise<SafePiAuthFailure | undefined> {
  if (![400, 401, 403, 409].includes(response.status) || !response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16 * 1024) return undefined;
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!record(value)) return undefined;
    const closed = safePiAuthFailure(value.authFailure);
    if (closed?.provider === provider) return closed;
    if (!record(value.error)) return undefined;
    const code = value.error.code ?? value.error.type;
    if (typeof code === 'string' && ['invalid_api_key', 'invalid_token', 'token_expired', 'authentication_error'].includes(code)) {
      return { code: 'PI_LOGIN_REQUIRED', reason: 'rejected', provider };
    }
  } catch { /* Malformed/oversized errors are not authentication evidence. */ }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return undefined;
}

/** Application enforcement around the real provider's public streams, not a protocol adapter. */
export function bindNativePiProvider(input: { native: NativePiProvider; model: NativePiModel;
  thinkingLevel: string; piAi: NativePiAi; binding: OperatorPiAuthBinding }): NativePiProvider {
  const { native, model, thinkingLevel, piAi, binding } = input;
  if (!piAi.getSupportedThinkingLevels(model).includes(thinkingLevel)) {
    throw new Error('Unsupported approved Pi reasoning level');
  }
  const approvedModel = () => {
    const auth = binding.resolve().auth;
    if (!auth.baseUrl) return model;
    if (!allowedEndpoint(new URL(auth.baseUrl), native, model)) throw new Error('Invalid private Pi endpoint');
    // Endpoint selection is derived auth, while the entire real catalog model is retained.
    return { ...model, baseUrl: auth.baseUrl };
  };
  const send: typeof fetch = async (request, init) => {
    const bound = binding.resolve(); // Recheck at each physical send, not only resolver time.
    const url = new URL(request instanceof Request ? request.url : String(request));
    const effective = approvedModel();
    if (!allowedEndpoint(url, native, effective)) throw new Error('Native Pi destination denied');
    const signal = AbortSignal.any([...(init?.signal ? [init.signal] : []),
      ...(request instanceof Request ? [request.signal] : []),
      AbortSignal.timeout(Math.max(1, binding.descriptor.deadline - Date.now())),
      ...(bound.expiresAt === null ? [] : [AbortSignal.timeout(Math.max(1, bound.expiresAt - Date.now()))])]);
    let response: Response;
    try { response = await globalThis.fetch(request, { ...init, signal, redirect: 'manual' }); }
    catch {
      binding.resolve();
      throw new Error('Native Pi transport failed');
    }
    if (!response.ok) {
      // Never persist an upstream error body in SDK assistant messages. A bare
      // 403 is not authentication evidence; policy/429/5xx keep their status.
      const failure = await responseAuthFailure(response, binding.provider);
      await response.body?.cancel();
      if (failure) {
        binding.fail(failure.reason);
        throw piAuthError(failure.provider, failure.reason);
      }
      return new Response(response.status === 304 ? null : JSON.stringify({ error: { message: 'Native Pi request failed', type: 'request_error' } }),
        { status: response.status, headers: { 'content-type': 'application/json' } });
    }
    return response;
  };
  const optionsFor = (supplied: Record<string, unknown> = {}) => {
    const bound = binding.resolve();
    const safe: Record<string, unknown> = {};
    // Deliberately exclude auth, endpoint, payload, sampling overrides, fetch,
    // observer and header authority. Keep ordinary SDK call/cancellation settings.
    for (const key of ['signal', 'temperature', 'maxTokens', 'cacheRetention', 'sessionId', 'timeoutMs']) {
      if (supplied[key] !== undefined) safe[key] = supplied[key];
    }
    return { ...safe, ...bound.auth, ...(bound.env ? { env: bound.env } : {}), fetch: send,
      maxRetries: 0, transport: 'sse', reasoning: thinkingLevel };
  };
  const verify = (candidate: NativePiModel) => {
    if (!record(candidate) || candidate.provider !== model.provider || candidate.id !== model.id || candidate.api !== model.api) {
      throw new Error('Approved Pi model binding mismatch');
    }
    return approvedModel();
  };
  return piAi.createProvider({ id: native.id, name: native.name, baseUrl: native.baseUrl, headers: native.headers,
    models: native.getAllModels?.() ?? native.getModels?.() ?? native.models ?? [],
    auth: { apiKey: { name: 'Private operator Pi binding',
      resolve: async () => { const bound = binding.resolve(); return { auth: bound.auth, ...(bound.env ? { env: bound.env } : {}) }; } } },
    api: {
      // Both public entry forms use Pi's unified reasoning mapping; the
      // application pins authority/options, not provider-specific protocols.
      stream: (candidate: NativePiModel, context: unknown, options?: Record<string, unknown>) =>
        native.streamSimple(verify(candidate), context, optionsFor(options)),
      streamSimple: (candidate: NativePiModel, context: unknown, options?: Record<string, unknown>) =>
        native.streamSimple(verify(candidate), context, optionsFor(options)),
    } });
}
