import { z } from 'zod';

/** Closed failure evidence, never a grant or an instruction to retry an effect. */
export const dispatcherRefusalReasons = ['execution-inactive', 'authority-unverified', 'request-invalid',
  'policy-denied', 'receipt-unavailable', 'operation-conflict', 'operation-limit', 'effect-uncertain',
  'upstream-unavailable', 'operation-failed'] as const;
export const dispatcherRefusalDispositions = ['authority-denied', 'operation-local', 'effect-uncertain', 'retryable'] as const;
export type DispatcherRefusalReason = typeof dispatcherRefusalReasons[number];
const dispositions = {
  'execution-inactive': 'authority-denied', 'authority-unverified': 'authority-denied',
  'request-invalid': 'operation-local', 'policy-denied': 'operation-local', 'receipt-unavailable': 'operation-local',
  'operation-conflict': 'operation-local', 'operation-limit': 'authority-denied',
  'effect-uncertain': 'effect-uncertain', 'upstream-unavailable': 'retryable', 'operation-failed': 'operation-local',
} as const satisfies Record<DispatcherRefusalReason, typeof dispatcherRefusalDispositions[number]>;

export const transportDiagnosticShape = {
  transportStatus: z.number().int().min(300).max(599).optional(),
  transportReason: z.enum(dispatcherRefusalReasons).optional(),
  transportDisposition: z.enum(dispatcherRefusalDispositions).optional(),
};

/** Preserve the existing code/status; strict success and no-attempt envelopes do not use this helper. */
export function dispatcherRefusalBody(reason: DispatcherRefusalReason, code = 'OPERATOR_CAPABILITY_DENIED') {
  return { code, reason, disposition: dispositions[reason] };
}
export function dispatcherRefusal(reason: DispatcherRefusalReason, status = 403, code = 'OPERATOR_CAPABILITY_DENIED'): Response {
  return Response.json(dispatcherRefusalBody(reason, code), { status });
}

/** A known parent boundary labels its own refusal, not arbitrary exception text. */
export class DispatcherRefusal extends Error {
  constructor(readonly reason: DispatcherRefusalReason, message = 'Dispatcher operation refused') { super(message); }
}
