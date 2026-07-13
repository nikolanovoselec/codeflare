import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const generatedSource = readFileSync(join(repoRoot, 'src/lib/agent-seed.generated.ts'), 'utf8');
const assignment = 'export const AGENTS_SEEDED_CONFIGS: SeedDocument[] = ';
const jsonStart = generatedSource.indexOf(assignment) + assignment.length;
const jsonEnd = generatedSource.lastIndexOf('];') + 1;
assert.ok(jsonStart >= assignment.length && jsonEnd > jsonStart, 'generated seed document array not found');
const documents = JSON.parse(generatedSource.slice(jsonStart, jsonEnd));
const piManifest = JSON.parse(readFileSync(join(repoRoot, 'preseed/agents/pi/manifest.json'), 'utf8'));

function targetKey(relativePath) {
  if (relativePath === 'package.json' || relativePath === 'package-lock.json') {
    return `.pi/agent/npm/${relativePath}`;
  }
  if (relativePath === 'settings.json') return '.pi/agent/settings.json';
  return `.pi/agent/${relativePath}`;
}

describe('REQ-AGENT-006 AC1 and REQ-AGENT-007 AC4: Pi manifest ownership', () => {
  it('emits every manifest-declared Pi asset exactly once per mode with canonical bytes', () => {
    for (const [relativePath, entry] of Object.entries(piManifest)) {
      const key = targetKey(relativePath);
      for (const mode of entry.modes) {
        const matches = documents.filter((document) => document.key === key && document.modes.includes(mode));
        assert.equal(matches.length, 1, `${key} must have one ${mode}-mode owner`);
        assert.equal(
          matches[0].content,
          readFileSync(join(repoRoot, 'preseed/agents/pi', relativePath), 'utf8'),
          `${key} ${mode} was transformed from another harness instead of seeded from canonical Pi source`,
        );
      }
    }
  });
});
