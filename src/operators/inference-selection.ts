/**
 * Shared REQ-OPERATOR-007 inference narrowing.
 *
 * Managed selection intersects the current verified human/group route catalog.
 * Native selection requires explicit source approval and personal-provider
 * permission; its pinned identity is prepared by the owner-profile boundary.
 * `trusted` comes from parent-owned invocation or profile metadata, never the
 * child request body. Direct capabilities and container interception share it.
 */
import { z } from 'zod';
import type { OperatorPolicy } from './policy';

export interface EligibleInference {
  routeIds: string[];
  defaultRouteId: string;
  defaultReasoningLevel: string;
  allowPersonalPiProviders?: boolean;
}
export interface TrustedInferenceSelection { routeId?: string; reasoningLevel?: string | null }
export interface EffectiveOperatorInference { routeId: string; reasoningLevel: string | null }

const nativeSelection = z.strictObject({
  source: z.literal('pi-native'),
  provider: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(64),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
  api: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(96),
  reasoningLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type NativeOperatorInference = z.infer<typeof nativeSelection>;
export type AdmittedOperatorInference = EffectiveOperatorInference | NativeOperatorInference;

/** Parse only the nonsecret admitted identity, never credential or caller options. */
export function parseNativeOperatorInference(value: unknown): NativeOperatorInference {
  const parsed = nativeSelection.safeParse(value);
  if (!parsed.success) throw new OperatorInferenceSelectionError('SOURCE_NOT_ELIGIBLE', 'Operator native selection is not eligible');
  return parsed.data;
}

class OperatorInferenceSelectionError extends Error {
  constructor(public readonly code: 'SOURCE_NOT_ELIGIBLE' | 'ROUTE_NOT_ELIGIBLE' | 'ROUTE_SELECTION_REQUIRED' | 'REASONING_NOT_ELIGIBLE', message: string) {
    super(message);
    this.name = 'OperatorInferenceSelectionError';
  }
}

export function resolveOperatorInference(input: { eligible: EligibleInference; policy: Pick<OperatorPolicy, 'inference'>;
  trusted: NativeOperatorInference }): NativeOperatorInference;
export function resolveOperatorInference(input: { eligible: EligibleInference; policy: Pick<OperatorPolicy, 'inference'>;
  trusted?: TrustedInferenceSelection }): EffectiveOperatorInference;
export function resolveOperatorInference(input: { eligible: EligibleInference; policy: Pick<OperatorPolicy, 'inference'>;
  trusted?: TrustedInferenceSelection | NativeOperatorInference }): AdmittedOperatorInference;
export function resolveOperatorInference(input: { eligible: EligibleInference; policy: Pick<OperatorPolicy, 'inference'>;
  trusted?: TrustedInferenceSelection | NativeOperatorInference }): AdmittedOperatorInference {
  const sources = input.policy.inference.allowedSources ?? ['managed'];
  const source = input.trusted && 'source' in input.trusted ? input.trusted.source : 'managed';
  if (source === 'pi-native') {
    if (!sources.includes('pi-native') || input.eligible.allowPersonalPiProviders !== true) {
      throw new OperatorInferenceSelectionError('SOURCE_NOT_ELIGIBLE', 'Operator native source is not eligible');
    }
    const selected = parseNativeOperatorInference(input.trusted);
    if (!input.policy.inference.reasoningLevels.includes(selected.reasoningLevel)) {
      throw new OperatorInferenceSelectionError('REASONING_NOT_ELIGIBLE', 'Operator reasoning level is not eligible');
    }
    return selected;
  }
  if (source !== 'managed' || !sources.includes('managed')) {
    throw new OperatorInferenceSelectionError('SOURCE_NOT_ELIGIBLE', 'Operator inference source is not eligible');
  }
  const eligible = new Set(input.eligible.routeIds);
  const allowed = new Set(input.policy.inference.routeIds.filter(route => eligible.has(route)));
  const trustedRoute = input.trusted && 'routeId' in input.trusted && typeof input.trusted.routeId === 'string'
    ? input.trusted.routeId : undefined;
  const candidateRoute = trustedRoute ?? input.policy.inference.defaultRouteId
    ?? (input.policy.inference.inheritUserDefaults ? input.eligible.defaultRouteId : null);
  if (!candidateRoute) {
    throw new OperatorInferenceSelectionError('ROUTE_SELECTION_REQUIRED', 'Operator route selection required');
  }
  if (!allowed.has(candidateRoute)) {
    throw new OperatorInferenceSelectionError('ROUTE_NOT_ELIGIBLE', 'Operator route is not eligible');
  }

  const hasTrustedReasoning = input.trusted !== undefined
    && Object.prototype.hasOwnProperty.call(input.trusted, 'reasoningLevel');
  const candidateReasoning = hasTrustedReasoning ? (input.trusted?.reasoningLevel ?? null)
    : input.policy.inference.defaultReasoningLevel
      ?? (input.policy.inference.inheritUserDefaults ? input.eligible.defaultReasoningLevel : null);
  if (candidateReasoning !== null && !input.policy.inference.reasoningLevels.includes(candidateReasoning)) {
    throw new OperatorInferenceSelectionError('REASONING_NOT_ELIGIBLE', 'Operator reasoning level is not eligible');
  }
  return { routeId: candidateRoute, reasoningLevel: candidateReasoning };
}
