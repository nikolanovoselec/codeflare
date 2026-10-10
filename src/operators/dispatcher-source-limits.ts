/** Parent-owned source-response envelopes only; all other Dispatcher bounds remain separate. */
export const DEFAULT_SOURCE_RESPONSE_BYTES = 1024 * 1024;
// The configured Environment ceiling remains mandatory; numeric validation must not impose a second 1 MiB ceiling.
export const MAX_SOURCE_RESPONSE_BYTES = Number.MAX_SAFE_INTEGER;

export function sourceResponseBytes(policy: { sourceResponseBytes?: number }): number {
  return policy.sourceResponseBytes ?? DEFAULT_SOURCE_RESPONSE_BYTES;
}
