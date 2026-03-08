import { describe, it, expect } from 'vitest';
import { AGENTS_SEEDED_CONFIGS } from '../../lib/agent-seed.generated';

/**
 * Validates invariants of the generated agent seed configs.
 *
 * The generator script (generate-agent-seed.mjs) reads manifest.json and the
 * preseed file tree at build time, validates bidirectional consistency, and
 * embeds the result into AGENTS_SEEDED_CONFIGS. These tests verify the
 * generated output's runtime invariants without filesystem access (which
 * isn't available in the Workers vitest pool).
 */

describe('agent-seed manifest.json', () => {
  it('generated configs array is non-empty', () => {
    expect(AGENTS_SEEDED_CONFIGS.length).toBeGreaterThan(0);
  });

  it('every entry has a valid key, contentType, content, and modes', () => {
    for (const doc of AGENTS_SEEDED_CONFIGS) {
      expect(typeof doc.key).toBe('string');
      expect(doc.key.length).toBeGreaterThan(0);
      expect(typeof doc.contentType).toBe('string');
      expect(typeof doc.content).toBe('string');
      expect(Array.isArray(doc.modes)).toBe(true);
    }
  });

  it('every entry has non-empty modes array with only "default" and/or "advanced"', () => {
    for (const doc of AGENTS_SEEDED_CONFIGS) {
      expect(doc.modes.length, `${doc.key} should have at least one mode`).toBeGreaterThan(0);
      for (const mode of doc.modes) {
        expect(['default', 'advanced']).toContain(mode);
      }
    }
  });

  it('"advanced" is a superset of "default" (all default files also in advanced)', () => {
    const defaultKeys = AGENTS_SEEDED_CONFIGS
      .filter((doc) => doc.modes.includes('default'))
      .map((doc) => doc.key);
    const advancedKeys = AGENTS_SEEDED_CONFIGS
      .filter((doc) => doc.modes.includes('advanced'))
      .map((doc) => doc.key);

    for (const key of defaultKeys) {
      expect(advancedKeys).toContain(key);
    }
  });

  it('no path traversal, no leading / or ., no backslashes in keys', () => {
    for (const doc of AGENTS_SEEDED_CONFIGS) {
      // Keys have .claude/ prefix — check the relative portion after that
      const rel = doc.key.replace(/^\.claude\//, '');
      expect(rel).not.toContain('..');
      expect(rel.startsWith('/')).toBe(false);
      expect(rel.startsWith('.')).toBe(false);
      expect(rel).not.toContain('\\');
    }
  });

  it('all keys have .claude/ prefix', () => {
    for (const doc of AGENTS_SEEDED_CONFIGS) {
      expect(doc.key.startsWith('.claude/')).toBe(true);
    }
  });

  it('manifest.json itself is NOT included in generated seed output', () => {
    const keys = AGENTS_SEEDED_CONFIGS.map((doc) => doc.key);
    expect(keys).not.toContain('.claude/manifest.json');
    expect(keys).not.toContain('manifest.json');
  });

  it('no duplicate keys', () => {
    const keys = AGENTS_SEEDED_CONFIGS.map((doc) => doc.key);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });
});
