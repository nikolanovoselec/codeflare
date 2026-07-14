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

function parseFrontmatter(content) {
  return Object.fromEntries(
    (content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '')
      .split('\n')
      .map((line) => line.split(/:\s*/, 2))
      .filter((parts) => parts.length === 2),
  );
}

function expectedPiContent(relativePath) {
  const source = readFileSync(join(repoRoot, 'preseed/agents/pi', relativePath), 'utf8');
  return source.replace(/^<!-- @include-skill ([a-z0-9-]+) -->$/gm, (_directive, skillName) => {
    const skill = documents.find(
      (document) => document.key === `.pi/agent/skills/${skillName}/SKILL.md`,
    );
    assert.ok(skill, `seeded skill ${skillName} not found`);
    return `<embedded-skill name="${skillName}">\n${skill.content}</embedded-skill>`;
  });
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
          expectedPiContent(relativePath),
          `${key} ${mode} was transformed from another harness instead of seeded from canonical Pi source`,
        );
      }
    }
  });

  it('REQ-AGENT-084: expands canonical policy into each generated reviewer system prompt', () => {
    const requiredSkills = {
      'code-reviewer': ['review-scope', 'tdd-enforce'],
      'spec-reviewer': ['review-scope', 'spec-enforce', 'spec-enforce-ac', 'spec-enforce-truth'],
      'doc-updater': ['review-scope', 'doc-enforce', 'doc-enforce-lanes', 'doc-enforce-shape', 'doc-enforce-truth'],
    };

    for (const [reviewer, skillNames] of Object.entries(requiredSkills)) {
      const key = `.pi/agent/agents/${reviewer}.md`;
      const reviewerDocument = documents.find((document) => document.key === key);
      assert.ok(reviewerDocument, `${key} not found`);
      const embeddedNames = [...reviewerDocument.content.matchAll(/<embedded-skill name="([^"]+)">/g)]
        .map((match) => match[1]);
      assert.deepEqual(embeddedNames, skillNames);
      assert.equal(parseFrontmatter(reviewerDocument.content).skills, undefined);
      assert.equal(reviewerDocument.content, expectedPiContent(`agents/${reviewer}.md`));
    }
  });
});
