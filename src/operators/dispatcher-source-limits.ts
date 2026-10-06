/** Parent-owned source-response envelopes only; all other Dispatcher bounds remain separate. */
export const DEFAULT_SOURCE_RESPONSE_BYTES = 1024 * 1024;
// Receipt-storage/native tests verify this supported cap; independent SDK bounds are not raised.
export const MAX_SOURCE_RESPONSE_BYTES = 1024 * 1024;

export function sourceResponseBytes(policy: { sourceResponseBytes?: number }): number {
  return policy.sourceResponseBytes ?? DEFAULT_SOURCE_RESPONSE_BYTES;
}
