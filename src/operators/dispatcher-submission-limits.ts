/** Operator-owned SDK submission recovery, independent of inference attempts and operation charges. */
export const DEFAULT_SUBMISSION_ATTEMPT_LIMIT = 1024;

/** Includes the initial submission; one disables SDK retries. Original authority and deadline still apply. */
export function submissionAttemptLimit(policy?: { submissionAttemptLimit?: number }): number {
  return policy?.submissionAttemptLimit ?? DEFAULT_SUBMISSION_ATTEMPT_LIMIT;
}
