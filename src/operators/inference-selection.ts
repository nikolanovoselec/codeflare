/**
 * Shared REQ-OPERATOR-007 inference narrowing.
 *
 * `eligible` is the current verified human/group catalog. Operator registration
 * can only intersect that set. `trusted` is supplied by parent-owned invocation
 * or Pi profile metadata, never by the child request body. The result is used by
 * both direct capabilities and the container interceptor.
 */
import type { OperatorPolicy } from './policy';

export interface EligibleInference {
  routeIds: string[];
  defaultRouteId: string;
  defaultReasoningLevel: string;
}
export interface TrustedInferenceSelection { routeId?: string; reasoningLevel?: string | null }
export interface EffectiveOperatorInference { routeId: string; reasoningLevel: string | null }

class OperatorInferenceSelectionError extends Error {
  constructor(public readonly code: 'ROUTE_NOT_ELIGIBLE' | 'ROUTE_SELECTION_REQUIRED' | 'REASONING_NOT_ELIGIBLE', message: string) {
    super(message);
    this.name = 'OperatorInferenceSelectionError';
  }
}

export function resolveOperatorInference(input: { eligible: EligibleInference; policy: OperatorPolicy;
  trusted?: TrustedInferenceSelection }): EffectiveOperatorInference {
  const eligible = new Set(input.eligible.routeIds);
  const allowed = new Set(input.policy.inference.routeIds.filter(route => eligible.has(route)));
  const trustedRoute = input.trusted?.routeId;
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
