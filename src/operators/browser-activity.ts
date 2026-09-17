/** Safe owner-bound projections shared by Activity, registry and authenticated browser routes. */
import type { VerifiedHumanAccessClaims } from '../lib/jwt';

export interface OperatorBrowserSummary {
  activityId: string;
  operatorId: string;
  executionStatus: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancel-requested' | 'unknown';
  cleanupStatus: 'pending' | 'stopping' | 'stopped' | 'unknown';
  collectionStatus: 'unavailable' | 'ready' | 'consumed' | 'unknown';
  attention: boolean;
  sessionId: string | null;
  source: string | null;
  updatedAt: number;
}
export async function operatorOwnerKey(human: Pick<VerifiedHumanAccessClaims,
  'subject' | 'email' | 'issuer' | 'audiences'>): Promise<string> {
  const canonical = JSON.stringify([human.subject, human.email.trim().toLowerCase(), human.issuer,
    [...human.audiences].sort()]);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
