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

const nativeReviewAssets = [
  'rules/engineering-constitution.md',
  'agents/code-reviewer.md',
  'agents/spec-reviewer.md',
  'agents/doc-updater.md',
  'skills/review-scope/SKILL.md',
  'skills/spec-enforce/SKILL.md',
  'skills/spec-enforce-ac/SKILL.md',
  'skills/spec-enforce-truth/SKILL.md',
  'skills/doc-enforce/SKILL.md',
  'skills/doc-enforce-lanes/SKILL.md',
  'skills/doc-enforce-shape/SKILL.md',
  'skills/doc-enforce-truth/SKILL.md',
];

describe('REQ-AGENT-006/REQ-AGENT-059: Pi-native review asset ownership', () => {
  for (const relativePath of nativeReviewAssets) {
    it(`seeds canonical Pi bytes exactly once for ${relativePath}`, () => {
      const key = `.pi/agent/${relativePath}`;
      const matches = documents.filter((document) => document.key === key && document.modes.includes('advanced'));
      assert.equal(matches.length, 1, `${key} must have one advanced-mode owner`);
      assert.equal(
        matches[0].content,
        readFileSync(join(repoRoot, 'preseed/agents/pi', relativePath), 'utf8'),
        `${key} was transformed from another harness instead of seeded from canonical Pi source`,
      );
    });
  }
});

describe('REQ-AGENT-059 AC3: shares explicit diff/all scope contract across Pi review entry points', () => {
  it('binds PR review, /review, reviewers, and enforcement skills to review-scope', () => {
    const scope = readFileSync(join(repoRoot, 'preseed/agents/pi/skills/review-scope/SKILL.md'), 'utf8');
    for (const input of [
      'PR reminder with `review_range=<base>..<head>`',
      'PR reminder for full protected-base PR',
      '`/review --diff`',
      '`/review --all`',
      '`/sdd clean --diff`',
      '`/sdd clean --all`',
    ]) {
      assert.ok(scope.includes(input), `scope resolver is missing ${input}`);
    }

    for (const relativePath of [
      'agents/code-reviewer.md',
      'agents/spec-reviewer.md',
      'agents/doc-updater.md',
      'skills/git-review-pipeline/SKILL.md',
      'skills/review/SKILL.md',
      'skills/spec-enforce/SKILL.md',
      'skills/doc-enforce/SKILL.md',
    ]) {
      const content = readFileSync(join(repoRoot, 'preseed/agents/pi', relativePath), 'utf8');
      assert.match(content, /review-scope/, `${relativePath} does not reuse the canonical scope contract`);
    }
  });
});
