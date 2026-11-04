import { isDeepStrictEqual } from 'node:util';

export interface SafePiAuthFailure {
  code: 'PI_LOGIN_REQUIRED';
  reason: 'missing' | 'expired' | 'rejected';
  provider: string;
}
export const PI_LOGIN_RECOVERY = 'The saved Pi authentication is missing, expired or rejected. Open your Pi session, run /login or update the API key, wait for successful synchronization to R2, then explicitly retry.';
const PROVIDER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROVIDER_ENV: Readonly<Record<string, readonly string[]>> = {
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'],
  azure: ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME',
    'AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_DEPLOYMENT_NAME_MAP'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'],
  'amazon-bedrock': ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_BEARER_TOKEN_BEDROCK'],
};
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Only typed, closed evidence is authoritative; never interpret assistant/error text. */
export function safePiAuthFailure(value: unknown): SafePiAuthFailure | undefined {
  if (!record(value) || value.code !== 'PI_LOGIN_REQUIRED'
    || typeof value.reason !== 'string' || !['missing', 'expired', 'rejected'].includes(value.reason)
    || typeof value.provider !== 'string' || !PROVIDER.test(value.provider)) return undefined;
  return { code: 'PI_LOGIN_REQUIRED', reason: value.reason as SafePiAuthFailure['reason'], provider: value.provider };
}
export function piAuthError(provider: string, reason: SafePiAuthFailure['reason']): Error & SafePiAuthFailure {
  return Object.assign(new Error(PI_LOGIN_RECOVERY), { code: 'PI_LOGIN_REQUIRED' as const, reason, provider });
}
export interface OperatorPiAuthDescriptor {
  ownerKey: string;
  activityId: string;
  sessionId: string;
  generation: number;
  selectionDigest: string;
  profileDigest: string;
  deadline: number;
}
export function parsePiAuthDescriptor(value: unknown): OperatorPiAuthDescriptor {
  if (!record(value) || Object.keys(value).length !== 7
    || typeof value.ownerKey !== 'string' || !DIGEST.test(value.ownerKey)
    || typeof value.activityId !== 'string' || !ID.test(value.activityId)
    || typeof value.sessionId !== 'string' || !ID.test(value.sessionId)
    || !Number.isSafeInteger(value.generation) || (value.generation as number) <= 0
    || typeof value.selectionDigest !== 'string' || !DIGEST.test(value.selectionDigest)
    || typeof value.profileDigest !== 'string' || !DIGEST.test(value.profileDigest)
    || !Number.isSafeInteger(value.deadline) || (value.deadline as number) <= 0) {
    throw new Error('Invalid Pi authentication descriptor');
  }
  return { ownerKey: value.ownerKey, activityId: value.activityId, sessionId: value.sessionId,
    generation: value.generation as number, selectionDigest: value.selectionDigest,
    profileDigest: value.profileDigest, deadline: value.deadline as number };
}
export interface PrivatePiAuth {
  auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string };
  env?: Record<string, string>;
  expiresAt: number | null;
}
function strings(value: unknown, headers: boolean): boolean {
  return record(value) && Object.keys(value).length <= 64 && Object.entries(value).every(([key, item]) =>
    (headers ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/ : /^[A-Z][A-Z0-9_]{0,127}$/).test(key)
      && (!headers || !/^(?:host|content-length|transfer-encoding|connection|proxy-authorization|cf-access-jwt-assertion|x-codeflare-.*)$/i.test(key))
      && ((headers && item === null) || (typeof item === 'string' && item.length <= 16 * 1024
        && !/[\r\n\0]/.test(item))));
}
/** Service-local lifetime. No stored OAuth records or SDK credential mutations. */
export class OperatorPiAuthBinding {
  private bound?: PrivatePiAuth;
  private fenced = false;
  private failure?: SafePiAuthFailure;
  readonly descriptor: OperatorPiAuthDescriptor;
  constructor(descriptor: OperatorPiAuthDescriptor, readonly provider: string) {
    this.descriptor = parsePiAuthDescriptor(descriptor);
    if (!PROVIDER.test(provider)) throw new Error('Invalid Pi provider');
  }
  bind(value: unknown): void {
    if (!record(value) || Object.keys(value).some(key => !['descriptor', 'auth', 'expiresAt', 'env'].includes(key))
      || !isDeepStrictEqual(parsePiAuthDescriptor(value.descriptor), this.descriptor)) {
      throw new Error('Pi authentication binding conflict');
    }
    this.current();
    const auth = value.auth;
    if (!record(auth) || Object.keys(auth).some(key => !['apiKey', 'headers', 'baseUrl'].includes(key))
      || (auth.apiKey !== undefined && (typeof auth.apiKey !== 'string' || !auth.apiKey.length
        || auth.apiKey.length > 32 * 1024 || /[\r\n\0]/.test(auth.apiKey)))
      || (auth.headers !== undefined && !strings(auth.headers, true))
      || (auth.baseUrl !== undefined && (typeof auth.baseUrl !== 'string' || auth.baseUrl.length > 2048))
      || (value.env !== undefined && (!strings(value.env, false)
        || Object.keys(value.env as object).some(key => !(PROVIDER_ENV[this.provider] ?? []).includes(key))))
      || (value.expiresAt !== null && (!Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= 0))) {
      throw new Error('Invalid private Pi authentication');
    }
    if (value.expiresAt !== null && (value.expiresAt as number) <= Date.now()) throw piAuthError(this.provider, 'expired');
    if (auth.baseUrl !== undefined) {
      const url = new URL(auth.baseUrl as string);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('Invalid private Pi endpoint');
      }
    }
    const next = structuredClone({ auth, expiresAt: value.expiresAt,
      ...(value.env !== undefined ? { env: value.env } : {}) }) as PrivatePiAuth;
    if (this.bound && !isDeepStrictEqual(this.bound, next)) throw new Error('Pi authentication binding conflict');
    this.bound = next;
  }
  private current(): void {
    if (this.fenced || Date.now() >= this.descriptor.deadline) {
      this.clear();
      throw new Error('Pi authentication authority expired');
    }
    if (this.failure) throw piAuthError(this.provider, this.failure.reason);
  }
  resolve(): PrivatePiAuth {
    this.current();
    if (!this.bound) throw piAuthError(this.provider, 'missing');
    if (this.bound.expiresAt !== null && Date.now() >= this.bound.expiresAt) {
      this.fail('expired');
      throw piAuthError(this.provider, 'expired');
    }
    return structuredClone(this.bound);
  }
  fail(reason: SafePiAuthFailure['reason']): void {
    this.failure = { code: 'PI_LOGIN_REQUIRED', provider: this.provider, reason };
    this.bound = undefined;
  }
  get authFailure(): SafePiAuthFailure | undefined { return this.failure && { ...this.failure }; }
  clear(): void { this.bound = undefined; this.fenced = true; }
}

/** Empty read-only public CredentialStore. Reject without invoking mutation callbacks. */
export const EMPTY_PI_CREDENTIALS = Object.freeze({
  read: async () => undefined,
  list: async () => [],
  modify: async () => { throw new Error('Operator Pi credentials are read-only'); },
  delete: async () => { throw new Error('Operator Pi credentials are read-only'); },
});
