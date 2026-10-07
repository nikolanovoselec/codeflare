/** Operator-owned inference request/response bytes; retain the existing policy field and API. */
export const DEFAULT_INFERENCE_REQUEST_BYTES = 1_048_576;
export const MAX_INFERENCE_REQUEST_BYTES = Number.MAX_SAFE_INTEGER;

export function inferenceRequestBytes(policy?: { inferenceRequestBytes?: number }): number {
  return policy?.inferenceRequestBytes ?? DEFAULT_INFERENCE_REQUEST_BYTES;
}
