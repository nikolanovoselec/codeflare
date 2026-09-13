import { z } from 'zod';
import { getBuiltInProfile, normalizeCustomProfile } from '../../../src/lib/reasoning-profiles';
import { parseCapabilitySummary, MAX_CAPABILITY_SUBMISSIONS } from '../../../src/lib/ai-capability-discovery/contract';
import type { TargetCapabilityResult } from '../../../src/lib/ai-capability-discovery/contract';
import type { ReasoningRouteVerification } from '../types';
import { ReasoningRouteVerificationSchema } from './schemas';

export interface TargetDiscoveryResult extends TargetCapabilityResult {
  checkId?: string;
  targetId?: string;
  routeVerification?: ReasoningRouteVerification;
  nativeVerification?: { method: 'automated'; checkedAt: string; current: true; discovery?: TargetCapabilityResult['capabilities'] };
}
const capabilities = z.unknown().transform((value, context) => {
  try { return parseCapabilitySummary(value); }
  catch { context.addIssue({ code: 'custom', message: 'Invalid capability evidence' }); return z.NEVER; }
});
const profile = z.unknown().transform((value, context) => {
  try {
    const candidate = value as { id?: string; revision?: number; hash?: string };
    const builtin = candidate?.id && getBuiltInProfile(candidate.id);
    if (builtin) {
      if (candidate.revision !== builtin.revision || candidate.hash !== builtin.hash) throw new Error('Stale contract');
      return builtin;
    }
    return normalizeCustomProfile(value);
  } catch { context.addIssue({ code: 'custom', message: 'Invalid canonical contract' }); return z.NEVER; }
});
export const TargetDiscoveryResultSchema = z.object({
  schemaVersion: z.literal(1), assignable: z.boolean(), classification: z.enum(['Verified', 'Inconclusive', 'Unsupported']),
  explanation: z.string().max(2048), capabilities: capabilities.optional(), profile: profile.optional(), report: z.record(z.string(), z.unknown()).optional(),
  attempts: z.array(z.object({ contract: z.string().max(64), classification: z.string().max(64), capabilities: capabilities.optional(),
    diagnostics: z.array(z.unknown()).max(64), httpAttempts: z.number().nonnegative() })).max(16),
  accounting: z.object({ httpAttempts: z.number().int().min(0).max(MAX_CAPABILITY_SUBMISSIONS) }),
  checkId: z.string().uuid().optional(), targetId: z.string().uuid().optional(), routeVerification: ReasoningRouteVerificationSchema.optional(),
  nativeVerification: z.object({ method: z.literal('automated'), checkedAt: z.string(), current: z.literal(true), discovery: capabilities.optional() }).optional(),
}).refine((value) => !value.assignable || Boolean(value.profile && value.capabilities && value.checkId && (value.routeVerification || value.targetId && value.nativeVerification)),
  'Successful discovery requires a target-bound receipt') as z.ZodType<TargetDiscoveryResult>;
