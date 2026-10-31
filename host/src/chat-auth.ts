/** Scoped Chat adapter for Pi 1.3's public, persisted ModelRuntime auth API.
 * The host supplies the actual primary store paths; Dashboard HOME is unrelated.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export interface ChatAuthScope {
  cfid: string;
  ownerId: string;
  generation: number;
  primary: { sessionId: string; generation: number };
}
type AuthType = 'api_key' | 'oauth';
type Choice = { id: string; label: string; description?: string };
type AuthPrompt = { signal?: AbortSignal; message: string } & (
  { type: 'text' | 'secret' | 'manual_code'; placeholder?: string }
  | { type: 'select'; options: readonly Choice[] });
type AuthEvent = { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: 'info' | 'progress'; message: string };
interface AuthInteraction {
  signal: AbortSignal;
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}
interface AuthProvider {
  id: string;
  name: string;
  auth?: { apiKey?: { login?: unknown }; oauth?: { login?: unknown } };
}
/** Structural public API seam: host does not install or embed another SDK. */
interface AuthRuntime {
  getProviders(): readonly AuthProvider[];
  getProvider(providerId: string): AuthProvider | undefined;
  getProviderAuthStatus(providerId: string): { configured: boolean; source?: string };
  listCredentials(options?: { signal?: AbortSignal }): Promise<readonly { providerId: string; type: AuthType }[]>;
  refresh(options?: { signal?: AbortSignal }): Promise<unknown>;
  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<unknown>;
  logout(providerId: string, options?: { signal?: AbortSignal }): Promise<void>;
}
interface AuthSdk {
  ModelRuntime: { create(options: { authPath: string; modelsPath: string; allowModelNetwork: false }): Promise<AuthRuntime> };
}

// Dashboard's public OAuthFlowStatus vocabulary, plus only the answer fence and
// secret-field seam needed by the owned frontend. Never serialize a flow record.
export type OAuthFlowPendingDTO =
  | { kind: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { kind: 'manual_code' | 'text'; message: string; placeholder?: string }
  | { kind: 'select'; message: string; options: Choice[] };
export interface OAuthFlowStatusDTO {
  flowId: string;
  provider: string;
  status: 'pending' | 'complete' | 'error' | 'expired';
  authUrl?: string;
  message?: string;
  pending?: OAuthFlowPendingDTO;
  error?: string;
  stepId?: string;
  inputSecret?: boolean;
}
interface Flow {
  dto: OAuthFlowStatusDTO;
  controller: AbortController;
  answer?: { resolve(value: string): void; reject(): void };
}
interface ChatAuthOptions {
  scope: ChatAuthScope;
  currentScope(): ChatAuthScope | null;
  authPath: string;
  modelsPath: string;
  policy: { mode: 'personal' | 'managed'; allowPersonalAuth: boolean };
  loadSdk?: () => Promise<AuthSdk>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> =>
  object(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const failure = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const aborted = (): Error => failure('auth_cancelled');
const sources = new Set(['stored', 'runtime', 'environment', 'fallback', 'models_json_key', 'models_json_command']);
function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* Invalid provider URLs are not public output. */ }
  return undefined;
}
async function loadPublicSdk(): Promise<AuthSdk> {
  // Pi 1.3 package.json exports["."].import is ./dist/index.js (ESM-only).
  // Load that public entry from the trusted image root, not host resolution/HOME.
  return import(pathToFileURL('/opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent/dist/index.js').href);
}

export function createChatAuthService(options: ChatAuthOptions) {
  const bound: ChatAuthScope = { ...options.scope, primary: { ...options.scope.primary } };
  const personalAllowed = options.policy.mode === 'personal' || options.policy.allowPersonalAuth === true;
  const flows = new Map<string, Flow>();
  const lifetime = new AbortController();
  let closed = false;
  let stale = false;
  let runtimePromise: Promise<AuthRuntime> | undefined;
  const matches = (value: ChatAuthScope | null | undefined): boolean => !!value
    && value.cfid === bound.cfid && value.ownerId === bound.ownerId
    && value.generation === bound.generation && value.primary?.sessionId === bound.primary.sessionId
    && value.primary?.generation === bound.primary.generation;
  function clearStep(flow: Flow): void {
    delete flow.dto.pending;
    delete flow.dto.stepId;
    delete flow.dto.inputSecret;
  }
  function finish(flow: Flow, status: OAuthFlowStatusDTO['status'], error?: string): void {
    const answer = flow.answer;
    delete flow.answer;
    clearStep(flow);
    delete flow.dto.authUrl;
    delete flow.dto.message;
    flow.dto.status = status;
    if (error) flow.dto.error = error;
    else delete flow.dto.error;
    answer?.reject();
  }
  function cancelFlow(flow: Flow): void {
    if (flow.dto.status !== 'pending') return;
    finish(flow, 'expired', 'auth_cancelled');
    flow.controller.abort();
  }
  function invalidate(): void {
    stale = true;
    lifetime.abort();
    for (const flow of flows.values()) cancelFlow(flow);
  }
  function check(scope: ChatAuthScope): void {
    if (closed) throw failure('auth_closed');
    // A foreign request alone must not revoke a legitimate owner's service.
    if (!stale) {
      let current: ChatAuthScope | null;
      try { current = options.currentScope(); } catch { current = null; }
      if (!matches(current)) invalidate();
    }
    if (stale || !matches(scope)) throw failure('stale_auth_scope');
  }
  function active(flow: Flow): boolean {
    try { check(bound); } catch { return false; }
    return flow.dto.status === 'pending' && !flow.controller.signal.aborted;
  }
  function permit(): void {
    if (!personalAllowed) throw failure('personal_auth_forbidden');
  }
  async function runtime(scope: ChatAuthScope): Promise<AuthRuntime> {
    check(scope);
    try {
      runtimePromise ??= (async () => {
        const sdk = await (options.loadSdk ?? loadPublicSdk)();
        check(scope);
        return sdk.ModelRuntime.create({ authPath: options.authPath, modelsPath: options.modelsPath, allowModelNetwork: false });
      })();
      const result = await runtimePromise;
      check(scope);
      return result;
    } catch {
      check(scope);
      throw failure('auth_unavailable');
    }
  }
  async function guarded<T>(scope: ChatAuthScope, operation: () => Promise<T>): Promise<T> {
    check(scope);
    try {
      const result = await operation();
      check(scope);
      return result;
    } catch {
      check(scope);
      throw failure('auth_unavailable');
    }
  }
  function provider(runtime: AuthRuntime, providerId: string): AuthProvider {
    let result: AuthProvider | undefined;
    try { result = runtime.getProvider(providerId); }
    catch { throw failure('auth_unavailable'); }
    if (!result) throw failure('auth_provider_unavailable');
    return result;
  }
  function methods(provider: AuthProvider): AuthType[] {
    const result: AuthType[] = [];
    if (typeof provider.auth?.apiKey?.login === 'function') result.push('api_key');
    if (typeof provider.auth?.oauth?.login === 'function') result.push('oauth');
    return result;
  }
  function getFlow(scope: ChatAuthScope, flowId: string): Flow {
    check(scope);
    const flow = flows.get(flowId);
    if (!flow) throw failure('auth_flow_not_found');
    return flow;
  }
  function snapshot(flow: Flow): OAuthFlowStatusDTO {
    return structuredClone(flow.dto);
  }
  function interaction(flow: Flow): AuthInteraction {
    return {
      signal: flow.controller.signal,
      prompt(prompt) {
        if (!active(flow) || prompt.signal?.aborted) return Promise.reject(aborted());
        if (flow.answer) return Promise.reject(failure('auth_failed'));
        clearStep(flow);
        const stepId = randomUUID();
        flow.dto.stepId = stepId;
        if (prompt.type === 'select') {
          flow.dto.pending = { kind: 'select', message: prompt.message,
            options: prompt.options.map(choice => ({ id: choice.id, label: choice.label,
              ...(choice.description === undefined ? {} : { description: choice.description }) })) };
        } else {
          flow.dto.pending = { kind: prompt.type === 'manual_code' ? 'manual_code' : 'text', message: prompt.message,
            ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }) };
          if (prompt.type === 'secret') flow.dto.inputSecret = true;
        }
        return new Promise<string>((resolve, reject) => {
          const cleanup = () => {
            prompt.signal?.removeEventListener('abort', onAbort);
            flow.controller.signal.removeEventListener('abort', onAbort);
          };
          const onAbort = () => {
            if (flow.dto.stepId === stepId) {
              delete flow.answer;
              clearStep(flow);
            }
            cleanup();
            reject(aborted());
          };
          flow.answer = {
            resolve(value) { cleanup(); resolve(value); },
            reject() { cleanup(); reject(aborted()); },
          };
          prompt.signal?.addEventListener('abort', onAbort, { once: true });
          flow.controller.signal.addEventListener('abort', onAbort, { once: true });
        });
      },
      notify(event) {
        if (!active(flow)) return;
        if (event.type === 'auth_url') {
          const url = safeUrl(event.url);
          if (url) flow.dto.authUrl = url;
        } else if (event.type === 'device_code') {
          const verificationUri = safeUrl(event.verificationUri);
          if (!verificationUri || flow.answer) return;
          clearStep(flow);
          flow.dto.pending = { kind: 'device_code', userCode: event.userCode, verificationUri,
            ...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
            ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }) };
        }
        // Free-form provider info/progress/instructions may contain credentials.
      },
    };
  }
  return {
    async providers(scope: ChatAuthScope) {
      const rt = await runtime(scope);
      return guarded(scope, async () => ({ credentialScope: 'primary-agent-store' as const, personalAuthAllowed: personalAllowed,
        providers: rt.getProviders().map(p => ({ id: p.id, name: p.name, authTypes: personalAllowed ? methods(p) : [] })) }));
    },
    async status(scope: ChatAuthScope) {
      const rt = await runtime(scope);
      return guarded(scope, async () => {
        await rt.refresh({ signal: lifetime.signal });
        check(scope);
        const credentials = await rt.listCredentials({ signal: lifetime.signal });
        check(scope);
        return { credentialScope: 'primary-agent-store' as const,
          providers: rt.getProviders().map(p => {
            const status = rt.getProviderAuthStatus(p.id);
            return { providerId: p.id, configured: status.configured === true,
              ...(status.source && sources.has(status.source) ? { source: status.source } : {}) };
          }), credentials: credentials.map(c => ({ providerId: c.providerId, type: c.type })) };
      });
    },
    async start(scope: ChatAuthScope, body: unknown): Promise<OAuthFlowStatusDTO> {
      check(scope);
      if (!exact(body, ['providerId', 'type']) || !id(body.providerId)
        || (body.type !== 'api_key' && body.type !== 'oauth')) throw failure('invalid_auth_request');
      permit();
      const rt = await runtime(scope);
      const p = provider(rt, body.providerId);
      if (!methods(p).includes(body.type)) throw failure('auth_method_unavailable');
      if ([...flows.values()].some(f => f.dto.provider === p.id && f.dto.status === 'pending')) throw failure('auth_flow_conflict');
      const flow: Flow = { controller: new AbortController(),
        dto: { flowId: randomUUID(), provider: p.id, status: 'pending' } };
      flows.set(flow.dto.flowId, flow);
      const type = body.type;
      // Own the rejection immediately; returned SDK credentials are discarded.
      void (async () => {
        try {
          if (!active(flow)) return;
          await rt.login(p.id, type, interaction(flow));
          if (active(flow)) finish(flow, 'complete');
        } catch {
          if (active(flow)) finish(flow, 'error', 'auth_failed');
        }
      })();
      return snapshot(flow);
    },
    async flow(scope: ChatAuthScope, flowId: string): Promise<OAuthFlowStatusDTO> {
      return snapshot(getFlow(scope, flowId));
    },
    async input(scope: ChatAuthScope, flowId: string, body: unknown): Promise<OAuthFlowStatusDTO> {
      const flow = getFlow(scope, flowId);
      if (!exact(body, ['stepId', 'value']) || !id(body.stepId) || typeof body.value !== 'string'
        || body.value.length === 0 || body.value.length > 16384) throw failure('invalid_auth_input');
      if (flow.dto.status !== 'pending' || !flow.answer) throw failure('auth_not_waiting');
      if (body.stepId !== flow.dto.stepId) throw failure('stale_auth_step');
      if (flow.dto.pending?.kind === 'select' && !flow.dto.pending.options.some(c => c.id === body.value)) {
        throw failure('invalid_auth_input');
      }
      const answer = flow.answer;
      delete flow.answer;
      clearStep(flow);
      answer.resolve(body.value);
      return snapshot(flow);
    },
    async cancel(scope: ChatAuthScope, flowId: string): Promise<OAuthFlowStatusDTO> {
      const flow = getFlow(scope, flowId);
      cancelFlow(flow);
      return snapshot(flow);
    },
    async logout(scope: ChatAuthScope, body: unknown): Promise<void> {
      check(scope);
      if (!exact(body, ['providerId']) || !id(body.providerId)) throw failure('invalid_auth_request');
      permit();
      const rt = await runtime(scope);
      const p = provider(rt, body.providerId);
      for (const flow of flows.values()) if (flow.dto.provider === p.id) cancelFlow(flow);
      await guarded(scope, () => rt.logout(p.id, { signal: lifetime.signal }));
    },
    close(): void {
      if (closed) return;
      closed = true;
      lifetime.abort();
      for (const flow of flows.values()) cancelFlow(flow);
    },
  };
}

export type ChatAuthService = ReturnType<typeof createChatAuthService>;
