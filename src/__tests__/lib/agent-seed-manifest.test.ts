import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '../../..');
const claudeDir = path.join(rootDir, 'preseed/agents/claude');
const manifestPath = path.join(claudeDir, 'manifest.json');

const manifest: Record<string, { modes: string[] }> = JSON.parse(
  readFileSync(manifestPath, 'utf8')
);

function collectFiles(dir: string, prefix = ''): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile()) {
      result.push(rel);
    } else if (entry.isDirectory()) {
      result.push(...collectFiles(path.join(dir, entry.name), rel));
    }
  }
  return result;
}

const diskFiles = collectFiles(claudeDir).filter((f) => f !== 'manifest.json');

describe('agent-seed manifest.json', () => {
  it('is valid JSON with object-per-entry structure', () => {
    expect(typeof manifest).toBe('object');
    expect(manifest).not.toBeNull();
    expect(Array.isArray(manifest)).toBe(false);
    for (const [key, value] of Object.entries(manifest)) {
      expect(typeof key).toBe('string');
      expect(value).toHaveProperty('modes');
    }
  });

  it('every file in preseed/agents/claude/ (excluding manifest.json) has a manifest entry', () => {
    for (const file of diskFiles) {
      expect(manifest).toHaveProperty(file, expect.anything());
    }
  });

  it('every manifest entry points to an existing file', () => {
    for (const manifestKey of Object.keys(manifest)) {
      const fullPath = path.join(claudeDir, manifestKey);
      expect(() => statSync(fullPath)).not.toThrow();
    }
  });

  it('every entry has non-empty modes array with only "default" and/or "advanced"', () => {
    for (const [key, entry] of Object.entries(manifest)) {
      expect(Array.isArray(entry.modes), `${key} modes should be array`).toBe(true);
      expect(entry.modes.length, `${key} should have at least one mode`).toBeGreaterThan(0);
      for (const mode of entry.modes) {
        expect(['default', 'advanced']).toContain(mode);
      }
    }
  });

  it('"advanced" is a superset of "default" (all default files also in advanced)', () => {
    const defaultFiles = Object.entries(manifest)
      .filter(([, entry]) => entry.modes.includes('default'))
      .map(([key]) => key);
    const advancedFiles = Object.entries(manifest)
      .filter(([, entry]) => entry.modes.includes('advanced'))
      .map(([key]) => key);

    for (const file of defaultFiles) {
      expect(advancedFiles).toContain(file);
    }
  });

  it('no path traversal, no leading / or ., no backslashes in manifest paths', () => {
    for (const key of Object.keys(manifest)) {
      expect(key).not.toContain('..');
      expect(key.startsWith('/')).toBe(false);
      expect(key.startsWith('.')).toBe(false);
      expect(key).not.toContain('\\');
    }
  });

  it('manifest.json itself is NOT included in generated seed output', () => {
    // Import the generated seed and verify manifest.json is not present
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AGENTS_SEEDED_CONFIGS } = require('../../lib/agent-seed.generated');
    const keys = AGENTS_SEEDED_CONFIGS.map((doc: { key: string }) => doc.key);
    expect(keys).not.toContain('.claude/manifest.json');
    expect(keys).not.toContain('manifest.json');
  });
});
