/**
 * Durable non-secret operator origin/profile for one owned container.
 * Raw Access authority is memory-only and must be rebound by the parent after
 * Durable Object wake; restored policy therefore fails closed until then.
 */
import type { JwtStampingAuthority, JwtStampingPolicy } from '../operators/jwt-stamping';
import type { OperatorPolicy } from '../operators/policy';

export interface OperatorPiProfile {
  provider: string;
  model: string;
  thinkingLevel: string;
  systemPrompt: string;
  tools: string[];
}
export interface OperatorContainerProfile {
  schemaVersion: 1;
  activityId: string;
  sessionId: string;
  ownerBucket: string;
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
  _jwtPolicy?: JwtStampingPolicy;
  _jwtAuthority?: JwtStampingAuthority;
  envVars: Record<string, string>;
  ctx: { storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> } };
}

export async function configureOperatorContext(_host: OperatorContextHost, _profile: unknown,
  _authority: JwtStampingAuthority): Promise<void> { throw new Error('Not implemented'); }
export async function restoreOperatorContext(_host: OperatorContextHost): Promise<void> { throw new Error('Not implemented'); }
export function bindOperatorAuthority(_host: OperatorContextHost, _authority: JwtStampingAuthority): void {
  throw new Error('Not implemented');
}
