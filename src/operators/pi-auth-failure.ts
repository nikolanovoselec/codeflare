/** Closed functional contract. Never classify authentication from arbitrary SDK text. */
export interface SafePiAuthFailure {
  code: 'PI_LOGIN_REQUIRED';
  reason: 'missing' | 'expired' | 'rejected';
  provider: string;
}
export const PI_LOGIN_RECOVERY = 'The saved Pi authentication is missing, expired or rejected. Open your Pi session, run /login or update the API key, wait for successful synchronization to R2, then explicitly retry.';
export function safePiAuthFailure(value: unknown): SafePiAuthFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 3 || item.code !== 'PI_LOGIN_REQUIRED'
    || !['missing', 'expired', 'rejected'].includes(String(item.reason))
    || typeof item.provider !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(item.provider)
    || item.provider.length > 64) return undefined;
  return { code: 'PI_LOGIN_REQUIRED', reason: item.reason as SafePiAuthFailure['reason'], provider: item.provider };
}
/** Closed native rejection evidence; status/text alone never selects login recovery. */
export function nativePiAuthFailure(status: number, value: unknown, provider: string, api?: string): SafePiAuthFailure | undefined {
  if (![401, 403].includes(status) || !value || typeof value !== 'object' || Array.isArray(value)
    || !('error' in value) || !value.error || typeof value.error !== 'object' || Array.isArray(value.error)) return undefined;
  const error = value.error as { code?: unknown; type?: unknown; status?: unknown };
  const rejected = ['invalid_api_key', 'invalid_token', 'token_expired', 'authentication_error']
    .some(code => error.code === code || error.type === code)
    || (api === 'google-generative-ai' || api === 'google-vertex') && error.status === 'UNAUTHENTICATED';
  return rejected ? safePiAuthFailure({ code: 'PI_LOGIN_REQUIRED', reason: 'rejected', provider }) : undefined;
}

export class PiAuthRequiredError extends Error {
  readonly authFailure: SafePiAuthFailure;
  constructor(provider: string, reason: SafePiAuthFailure['reason']) {
    super(PI_LOGIN_RECOVERY);
    const failure = safePiAuthFailure({ code: 'PI_LOGIN_REQUIRED', provider, reason });
    if (!failure) throw new Error('Invalid Pi authentication failure');
    this.authFailure = failure;
  }
}

/** Same nonsecret wire as the provisioned Host's OperatorPiAuthDescriptor. */
export interface OperatorPiAuthDescriptor {
  ownerKey: string; activityId: string; sessionId: string; generation: number;
  selectionDigest: string; profileDigest: string; deadline: number;
}
export function parseOperatorPiAuthDescriptor(value: unknown): OperatorPiAuthDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Pi binding descriptor');
  const item = value as Record<string, unknown>;
  const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (Object.keys(item).length !== 7 || !digest(item.ownerKey) || !digest(item.selectionDigest)
    || !digest(item.profileDigest) || !id(item.activityId) || !id(item.sessionId)
    || !Number.isSafeInteger(item.generation) || (item.generation as number) < 1
    || !Number.isSafeInteger(item.deadline) || (item.deadline as number) <= 0) {
    throw new Error('Invalid Pi binding descriptor');
  }
  return { ownerKey: item.ownerKey as string, activityId: item.activityId as string,
    sessionId: item.sessionId as string, generation: item.generation as number,
    selectionDigest: item.selectionDigest as string, profileDigest: item.profileDigest as string,
    deadline: item.deadline as number };
}
