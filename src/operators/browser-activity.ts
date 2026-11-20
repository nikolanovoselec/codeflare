/** Safe owner-bound projections shared by Activity, registry and authenticated browser routes. */
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import type { NativeOperatorInference } from './inference-selection';
import type { SafePiAuthFailure } from './pi-auth-failure';
import { z } from 'zod';

/** Optional display metadata; mirrors the existing frontend outcome-count contract. */
const operatorResultSummarySchema = z.strictObject({ assessed: z.number().int().nonnegative().max(1024),
  merged: z.number().int().nonnegative(), notMerged: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(), unknown: z.number().int().nonnegative() })
  .refine(value => value.assessed === value.merged + value.notMerged + value.deferred + value.unknown,
    'Contradictory outcome quantities');
export type OperatorResultSummary = z.infer<typeof operatorResultSummarySchema>;

export function parseOperatorResultSummary(value: unknown): OperatorResultSummary | undefined {
  const parsed = operatorResultSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export interface OperatorBrowserSummary {
  activityId: string;
  operatorId: string;
  operatorName?: string;
  version?: string;
  resultSummary?: OperatorResultSummary;
  inferenceSelection?: (Omit<NativeOperatorInference, 'reasoningLevel'> & {
    reasoningLevel: NativeOperatorInference['reasoningLevel'] | null; reasoningSource?: 'installation' | 'inherited' })
    | { source: 'managed'; routeId: string; reasoningLevel: NativeOperatorInference['reasoningLevel'] | null };
  authFailure?: SafePiAuthFailure;
  context?: string | null;
  progress?: string | null;
  executionStatus: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancel-requested' | 'unknown';
  cleanupStatus: 'pending' | 'stopping' | 'stopped' | 'released' | 'unknown';
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
