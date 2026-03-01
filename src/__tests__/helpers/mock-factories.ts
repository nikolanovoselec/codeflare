/**
 * Shared mock factories for backend tests.
 *
 * Provides factory functions that return fully valid default objects with
 * optional partial overrides. Using spread merging keeps tests concise
 * while remaining explicit about what each test cares about.
 */

// ── Mock R2 Config ────────────────────────────────────────────────────────────

/**
 * Create the default mock return value for getR2Config().
 */
export function createMockR2Config(overrides?: {
  accountId?: string;
  endpoint?: string;
}) {
  return {
    accountId: overrides?.accountId ?? 'test-account',
    endpoint:
      overrides?.endpoint ?? 'https://test.r2.cloudflarestorage.com',
  };
}
