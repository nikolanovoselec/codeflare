/**
 * REQ-STOR-017 / AD90: the image-baked agent seed (materialize-agent-seed.mjs) MUST be
 * byte-identical to what `getConfigsForMode` seeds to R2 — otherwise the Governed Mode
 * `--checksum` initial sync would re-download the "different" files and the speedup
 * evaporates. This is the load-bearing drift guard: it runs the materialize filter and
 * the production seed filter over the SAME real generated seed and asserts they produce
 * the identical (key, content) set per mode.
 *
 * No mocking — uses the real committed AGENTS_SEEDED_CONFIGS.
 */
import { describe, it, expect } from 'vitest';
import type { SessionMode } from '../../types';
import { getConfigsForMode } from '../../lib/r2-seed';
import { AGENTS_SEEDED_CONFIGS } from '../../lib/agent-seed.generated';
// The materialize script's pure filter + parser (importing must NOT run its main()).
import { filterDocsForMode, parseGeneratedSeed } from '../../../scripts/materialize-agent-seed.mjs';

type KeyContent = { key: string; content: string };
const keyContent = (docs: { key: string; content: string }[]): KeyContent[] =>
  docs.map((d) => ({ key: d.key, content: d.content })).sort((a, b) => a.key.localeCompare(b.key));

describe('agent-seed bake byte-identity (REQ-STOR-017 / AD90)', () => {
  for (const mode of ['default', 'advanced'] as SessionMode[]) {
    it(`materialized bake (${mode}) is byte-identical to getConfigsForMode(${mode}, false)`, () => {
      const baked = keyContent(filterDocsForMode(AGENTS_SEEDED_CONFIGS, mode));
      const seeded = keyContent(getConfigsForMode(mode, false));
      // Same set of keys AND same content bytes — the checksum-skip precondition.
      expect(baked).toEqual(seeded);
      expect(baked.length).toBeGreaterThan(0);
    });

    it(`bake (${mode}) excludes the tier-gated context-mode subtree`, () => {
      const baked = filterDocsForMode(AGENTS_SEEDED_CONFIGS, mode);
      expect(baked.some((d: { key: string }) => d.key.startsWith('.claude/plugins/context-mode/'))).toBe(false);
      expect(baked.some((d: { key: string }) => d.key === '.pi/agent/extensions/context-mode-enforcement.ts')).toBe(false);
    });
  }

  it('parseGeneratedSeed extracts the AGENTS_SEEDED_CONFIGS array from the generated module shape', () => {
    // Synthetic module mirroring scripts/generate-agent-seed.mjs output shape (the
    // PRESEED_CONTENT_HASH string above, the typed array literal below). fs-free so it
    // runs in the Workers pool; the real-file parse is exercised by the Docker build.
    const docs = [
      { key: '.claude/rules/x.md', contentType: 'text/markdown; charset=utf-8', content: '# x', modes: ['default', 'advanced'] },
      { key: '.pi/agent/skills/y/SKILL.md', contentType: 'text/markdown; charset=utf-8', content: '# y', modes: ['advanced'] },
    ];
    const source =
      `export const PRESEED_CONTENT_HASH = 'abc123';\n\n` +
      `export const AGENTS_SEEDED_CONFIGS: SeedDocument[] = ${JSON.stringify(docs, null, 2)};\n`;
    expect(parseGeneratedSeed(source)).toEqual(docs);
  });
});
