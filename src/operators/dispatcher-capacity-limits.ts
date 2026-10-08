/** Operator-owned capacities. Defaults are shared by the parent, management wire and UI reset controls. */
export const dispatcherCapacityFields = {
  inferenceMessageLimit: { default: 256, label: 'Max inference messages', help: 'Maximum complete JSON messages per inference request. The independent inference byte limit and model context still apply.' },
  inferenceToolLimit: { default: 128, label: 'Max inference tools', help: 'Maximum declared tools per inference request. The selected provider may support fewer tools.' },
  inferenceTokenLimit: { default: 32768, label: 'Max completion tokens', help: 'Maximum requested output tokens per inference. Provider output limits still apply; this does not increase model context.' },
  inferenceDefaultTokens: { default: 8192, label: 'Default completion tokens', help: 'Requested output tokens only when the caller omits max_tokens. Must not exceed Max completion tokens.' },
  dispatcherRequestBytes: { default: 1048576, label: 'Non-inference transport limit (bytes)', help: 'Maximum complete request and non-source response envelopes for protected operations other than inference. Source responses and inference use their separate admitted byte limits.' },
  sourceRequestChars: { default: 262144, label: 'Source request text limit', help: 'Maximum source request body length, counted in UTF-16 units. The complete request must also fit the non-inference byte limit.' },
  sourceUrlChars: { default: 16384, label: 'Source URL length limit', help: 'Maximum source URL length, counted in UTF-16 units. Approved HTTPS destinations and source scope remain mandatory.' },
  commentChars: { default: 16384, label: 'Generic comment length limit', help: 'Maximum generic decision or merge comment length, counted in UTF-16 units. Repository service limits still apply.' },
  targetCommentChars: { default: 8192, label: 'Admitted-target comment length limit', help: 'Maximum comment length for the admitted-target source/publication path, counted in UTF-16 units. Target and evidence fences still apply.' },
  resolutionReadbackLimit: { default: 128, label: 'Max resolution readbacks', help: 'Maximum matching readback receipts submitted to resolve one uncertain operation. This never authorizes replay of the write.' },
  assessmentBytes: { default: 1048576, label: 'Final assessment limit (bytes)', help: 'Maximum complete serialized final assessment. Complete evidence and successful SDK settlement remain required before collection.' },
  updatePageBytes: { default: 33554432, label: 'SDK update-page limit (bytes)', help: 'Maximum streamed SDK update page the parent may inspect. SDK persistence and Worker memory limits are independent.' },
  projectedRecordBytes: { default: 4194304, label: 'Projected record limit (bytes)', help: 'Maximum SDK record retained in the parent projection. An oversized record is marked unavailable, not treated as complete evidence.' },
  completionObservationLimit: { default: 256, label: 'Max completion observations', help: 'Maximum completion observations retained in the parent SDK projection. Reaching this bound does not establish successful completion.' },
  toolObservationLimit: { default: 8192, label: 'Max tool observations', help: 'Maximum tool observations retained in the parent SDK projection. This is separate from the charged-operation budget.' },
  preflightBytes: { default: 4096, label: 'Seal preflight limit (bytes)', help: 'Maximum serialized seal-preflight observation accepted by the parent projection.' },
  preflightObservationLimit: { default: 256, label: 'Max seal preflight observations', help: 'Maximum seal-preflight observations retained in the parent projection. Readiness and authority checks remain mandatory.' },
  readinessBytes: { default: 4096, label: 'Readiness observation limit (bytes)', help: 'Maximum serialized completion-readiness observation accepted by the parent projection.' },
  readinessObservationLimit: { default: 256, label: 'Max readiness observations', help: 'Maximum completion-readiness observations retained in the parent projection. Observations alone do not permit collection.' },
  sourceTimeoutMs: { default: 30000, label: 'Source transport timeout (ms)', help: 'Maximum time for a generic source transport operation. The originally admitted authority deadline may end it sooner.' },
  releaseReadTimeoutMs: { default: 30000, label: 'Release-note read timeout (ms)', help: 'Maximum total time for release-note research, bounded by the original authority deadline.' },
  guideReadTimeoutMs: { default: 60000, label: 'Upstream guide read timeout (ms)', help: 'Maximum total time for upstream-guide research, bounded by the original authority deadline.' },
  composeReadTimeoutMs: { default: 60000, label: 'Changed-compose read timeout (ms)', help: 'Maximum total time for changed-compose research, bounded by the original authority deadline.' },
  checkRunPageLimit: { default: 100, label: 'Max check-run pages', help: 'Maximum GitHub check-run pages inspected per research operation. Incomplete pagination remains incomplete evidence.' },
  checkRunPageSize: { default: 10, label: 'Check runs per page', help: 'Requested GitHub check-run page size. GitHub permits at most 100; the page count and source byte limits are separate.' },
  guideBytes: { default: 262144, label: 'Upstream guide limit (bytes)', help: 'Maximum verified upstream agent-guide blob size. Exact blob identity and source-response limits still apply.' },
  driveTimeoutMs: { default: 120000, label: 'Non-SDK drive timeout (ms)', help: 'Maximum time for the separate non-SDK drive path. This is not the Dispatcher SDK inference deadline and cannot extend human authority.' },
  driveResponseBytes: { default: 1048576, label: 'Non-SDK drive response limit (bytes)', help: 'Maximum complete non-SDK drive response and serialized drive checkpoint/result update. The final assessment limit is independent.' },
  inferenceRetryBaseMs: { default: 2000, label: 'Inference retry base delay (ms)', help: 'Delay before the first inference successor. Later delays double up to the configured cap; waits never extend the original deadline.' },
  inferenceRetryMaxMs: { default: 8000, label: 'Inference retry delay cap (ms)', help: 'Maximum delay before an inference successor. Must be at least the base delay. Larger waits leave less time for useful work.' },
} as const;
export type DispatcherCapacityKey = keyof typeof dispatcherCapacityFields;
export type DispatcherCapacityPolicy = Partial<Record<DispatcherCapacityKey, number>>;
export type DispatcherCapacities = Record<DispatcherCapacityKey, number>;
export const dispatcherCapacityKeys = Object.keys(dispatcherCapacityFields) as DispatcherCapacityKey[];
export function dispatcherCapacities(policy?: DispatcherCapacityPolicy): DispatcherCapacities {
  return Object.fromEntries(dispatcherCapacityKeys.map(key => [key, policy?.[key] ?? dispatcherCapacityFields[key].default])) as DispatcherCapacities;
}
export function validDispatcherCapacities(policy?: DispatcherCapacityPolicy): boolean {
  if (policy !== undefined && (!policy || typeof policy !== 'object' || Array.isArray(policy))) return false;
  if (!Object.entries(policy ?? {}).every(([key, value]) => Object.hasOwn(dispatcherCapacityFields, key)
    && (value === undefined || (Number.isSafeInteger(value) && value > 0 && (key !== 'checkRunPageSize' || value <= 100))))) return false;
  const limits = dispatcherCapacities(policy);
  return limits.inferenceDefaultTokens <= limits.inferenceTokenLimit && limits.inferenceRetryBaseMs <= limits.inferenceRetryMaxMs;
}
export function pickDispatcherCapacities(policy: DispatcherCapacityPolicy): DispatcherCapacityPolicy {
  return Object.fromEntries(dispatcherCapacityKeys.filter(key => policy[key] !== undefined).map(key => [key, policy[key]]));
}
