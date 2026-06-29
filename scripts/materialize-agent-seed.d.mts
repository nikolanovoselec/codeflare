/**
 * Type declarations for the build-time agent-seed materialize script (REQ-STOR-017 / AD90).
 * The runtime is plain ESM JS (materialize-agent-seed.mjs); these types let the byte-identity
 * drift-guard test (src/__tests__/lib/agent-seed-bake.test.ts) import its pure helpers under
 * strict TypeScript without an implicit-any.
 */
export interface SeedDocument {
  key: string;
  contentType: string;
  content: string;
  modes: ('default' | 'advanced')[];
}

/** Filter the generated seed to one session mode — mirrors getConfigsForMode(mode, false). */
export function filterDocsForMode<T extends { key: string; modes: ('default' | 'advanced')[] }>(
  docs: T[],
  mode: 'default' | 'advanced',
): T[];

/** Parse the AGENTS_SEEDED_CONFIGS array out of the generated TS module source. */
export function parseGeneratedSeed(source: string): SeedDocument[];
