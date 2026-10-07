/** Operator-owned inference request bytes; independent of source-response allowances. */
export const DEFAULT_INFERENCE_REQUEST_BYTES = 1_048_576;
/** Streamed inference output has a separate storage-safe bound, not a source/input setting. */
export const MAX_INFERENCE_RESPONSE_BYTES = 1_048_576;
export const MAX_INFERENCE_REQUEST_BYTES = Number.MAX_SAFE_INTEGER;

export function inferenceRequestBytes(policy?: { inferenceRequestBytes?: number }): number {
  return policy?.inferenceRequestBytes ?? DEFAULT_INFERENCE_REQUEST_BYTES;
}
