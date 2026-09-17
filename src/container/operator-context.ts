/**
 * Durable non-secret operator origin/profile for one owned container.
 * Raw Access authority is memory-only and must be rebound by the parent after
 * Durable Object wake; restored policy therefore fails closed until then.
 */
import { parseJwtStampingPolicy, type JwtStampingAuthority, type JwtStampingPolicy } from '../operators/jwt-stamping';
import { parseOperatorPolicy, type OperatorPolicy } from '../operators/policy';

interface OperatorPiProfile {
  provider: string;
  model: string;
  thinkingLevel: string;
  systemPrompt: string;
  tools: string[];
  /** Force only the first model turn to call this already-approved tool. */
  initialToolChoice?: string;
}
export interface OperatorContainerProfile {
  schemaVersion: 1;
  activityId: string;
  operatorId: string;
  sessionId: string;
  ownerBucket: string;
  policyDigest: string;
  /** Absolute milliseconds, never extended by the child or host. */
  deadline: number;
  /** Parent-resolved owner-scoped namespace; individual operations append their stable ID. */
  outputPrefix: string;
  human: { subject: string; email: string; issuer: string; audiences: string[] };
  policy: OperatorPolicy;
  jwtPolicy: JwtStampingPolicy;
  piProfile: OperatorPiProfile;
}
export interface OperatorContextHost {
  _bucketName: string | null;
  _sessionId: string | null;
  _operatorContainerProfile?: OperatorContainerProfile;
  _operatorPolicy?: OperatorPolicy;
  _jwtStamping?: JwtStampingPolicy;
  _jwtAuthority?: JwtStampingAuthority;
  _strictEgress: boolean;
  _workspaceSyncEnabled: boolean;
  envVars: Record<string, string>;
  refreshEnv(): void;
  ctx: { storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> } };
}

const STORAGE_KEY = 'operatorContainerProfile';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const OWNER = /^[A-Za-z0-9._-]{1,128}$/;
const TOOL = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function canonicalPrefix(value: unknown): value is string {
  return typeof value === 'string' && value.length > 1 && value.length <= 2048 && value.endsWith('/')
    && !/[\\%\x00-\x1f\x7f]/.test(value)
    && value.slice(0, -1).split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0
    && new TextEncoder().encode(value).byteLength <= max;
}

function parsePiProfile(value: unknown): OperatorPiProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid operator Pi profile');
  const profile = value as Record<string, unknown>;
  if ((Object.keys(profile).length !== 5 && Object.keys(profile).length !== 6)
    || Object.keys(profile).some(key => !['provider', 'model', 'thinkingLevel', 'systemPrompt', 'tools', 'initialToolChoice'].includes(key))
    || !bounded(profile.provider, 128) || !bounded(profile.model, 256)
    || !bounded(profile.thinkingLevel, 32) || !bounded(profile.systemPrompt, 64 * 1024)
    || !Array.isArray(profile.tools) || profile.tools.length > 64
    || profile.tools.some(tool => typeof tool !== 'string' || !TOOL.test(tool))
    || new Set(profile.tools).size !== profile.tools.length
    || (profile.initialToolChoice !== undefined
      && (typeof profile.initialToolChoice !== 'string' || !profile.tools.includes(profile.initialToolChoice)))) {
    throw new Error('Invalid operator Pi profile');
  }
  return { provider: profile.provider, model: profile.model, thinkingLevel: profile.thinkingLevel,
    systemPrompt: profile.systemPrompt, tools: [...profile.tools] as string[],
    ...(typeof profile.initialToolChoice === 'string' ? { initialToolChoice: profile.initialToolChoice } : {}) };
}

function parseHuman(value: unknown): OperatorContainerProfile['human'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid operator human identity');
  const human = value as Record<string, unknown>;
  if (Object.keys(human).length !== 4 || !bounded(human.subject, 512) || !bounded(human.email, 320)
    || !bounded(human.issuer, 2048) || !Array.isArray(human.audiences) || human.audiences.length < 1
    || human.audiences.length > 16 || human.audiences.some(audience => !bounded(audience, 512))
    || new Set(human.audiences).size !== human.audiences.length) throw new Error('Invalid operator human identity');
  let issuer: URL;
  try { issuer = new URL(human.issuer); } catch { throw new Error('Invalid operator human identity'); }
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password) throw new Error('Invalid operator human identity');
  return { subject: human.subject, email: human.email.toLowerCase(), issuer: issuer.href,
    audiences: [...human.audiences] as string[] };
}

export function parseOperatorContainerProfile(value: unknown): OperatorContainerProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid operator container profile');
  const profile = value as Record<string, unknown>;
  if (Object.keys(profile).length !== 12 || profile.schemaVersion !== 1
    || typeof profile.activityId !== 'string' || !ID.test(profile.activityId)
    || typeof profile.operatorId !== 'string' || !ID.test(profile.operatorId)
    || typeof profile.sessionId !== 'string' || !ID.test(profile.sessionId)
    || typeof profile.ownerBucket !== 'string' || !OWNER.test(profile.ownerBucket)
    || typeof profile.policyDigest !== 'string' || !DIGEST.test(profile.policyDigest)
    || typeof profile.deadline !== 'number' || !Number.isFinite(profile.deadline) || profile.deadline <= 0
    || !canonicalPrefix(profile.outputPrefix)) {
    throw new Error('Invalid operator container profile');
  }
  return { schemaVersion: 1, activityId: profile.activityId, operatorId: profile.operatorId,
    sessionId: profile.sessionId, ownerBucket: profile.ownerBucket, policyDigest: profile.policyDigest, deadline: profile.deadline,
    outputPrefix: profile.outputPrefix, human: parseHuman(profile.human),
    policy: parseOperatorPolicy(profile.policy), jwtPolicy: parseJwtStampingPolicy(profile.jwtPolicy),
    piProfile: parsePiProfile(profile.piProfile) };
}

function requireOwnership(host: OperatorContextHost, profile: OperatorContainerProfile): void {
  if (host._bucketName !== profile.ownerBucket || host._sessionId !== profile.sessionId) {
    throw new Error('Operator container ownership mismatch');
  }
}

function sameAudience(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.length === rightSorted.length && leftSorted.every((value, index) => value === rightSorted[index]);
}

function requireAuthority(profile: OperatorContainerProfile, authority: JwtStampingAuthority): void {
  let issuer = '';
  try { issuer = new URL(authority.human.issuer).href; } catch { /* mismatch below */ }
  if (!authority.accessJwt || new TextEncoder().encode(authority.accessJwt).byteLength > 64 * 1024
    || authority.human.subject !== profile.human.subject
    || authority.human.email.toLowerCase() !== profile.human.email
    || issuer !== profile.human.issuer
    || !sameAudience(authority.human.audiences, profile.human.audiences)) {
    throw new Error('Operator authority mismatch');
  }
  if (!Number.isFinite(authority.human.expiresAt) || authority.human.expiresAt * 1000 <= Date.now()
    || profile.deadline <= Date.now() || profile.deadline > authority.human.expiresAt * 1000) {
    throw new Error('Operator authority expired');
  }
}

function apply(host: OperatorContextHost, profile: OperatorContainerProfile, authority?: JwtStampingAuthority): void {
  host._operatorContainerProfile = structuredClone(profile);
  host._operatorPolicy = structuredClone(profile.policy);
  host._jwtStamping = structuredClone(profile.jwtPolicy);
  if (authority) host._jwtAuthority = authority;
  else delete host._jwtAuthority;
  // Restricted sessions always install Worker mediation and never run the
  // ordinary whole-home bisync, independently of the user's strict preference.
  host._strictEgress = true;
  host._workspaceSyncEnabled = false;
  host.refreshEnv();
}

/** Validate and durably commit profile before enabling any operator environment. */
export async function configureOperatorContext(host: OperatorContextHost, input: unknown,
  authority: JwtStampingAuthority): Promise<void> {
  const profile = parseOperatorContainerProfile(input);
  requireOwnership(host, profile);
  requireAuthority(profile, authority);
  await host.ctx.storage.put(STORAGE_KEY, profile);
  apply(host, profile, authority);
}

/** Restore restrictions on wake; raw authority is deliberately not durable here. */
export async function restoreOperatorContext(host: OperatorContextHost): Promise<void> {
  const stored = await host.ctx.storage.get<unknown>(STORAGE_KEY);
  if (stored == null) return;
  const profile = parseOperatorContainerProfile(stored);
  requireOwnership(host, profile);
  apply(host, profile);
}

/** Rebind current authority only for the exact persisted human provenance. */
export function bindOperatorAuthority(host: OperatorContextHost, authority: JwtStampingAuthority): void {
  const profile = host._operatorContainerProfile;
  if (!profile) throw new Error('Operator profile unavailable');
  requireOwnership(host, profile);
  requireAuthority(profile, authority);
  host._jwtAuthority = authority;
}
