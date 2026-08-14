import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const TEMPLATES = join(
  ROOT,
  'preseed/agents/claude/skills/spec-driven-development/references/templates',
);

function template(name) {
  return readFileSync(join(TEMPLATES, name), 'utf8');
}

function tableHeaders(markdown) {
  return [...markdown.matchAll(/^\|([^\n]+)\|\n\|(?:[-:]+\|)+$/gm)].map((match) =>
    match[1].split('|').map((cell) => cell.trim()),
  );
}

// REQ-AGENT-139 AC1-AC3
// Test-only RED contract: implementation updates the bundled templates after CI proves the gap.
describe('optimized SDD documentation templates', () => {
  it('bundles every canonical and project-lane template used by /sdd init', () => {
    const expected = [
      'documentation-architecture.md',
      'documentation-api-reference.md',
      'documentation-configuration.md',
      'documentation-deployment.md',
      'documentation-security.md',
      'documentation-observability.md',
      'documentation-troubleshooting.md',
      'documentation-project-lane.md',
    ];
    assert.deepEqual(expected.filter((name) => !existsSync(join(TEMPLATES, name))), []);
  });

  it('keeps architecture operational without an exhaustive source-file inventory', () => {
    const content = template('documentation-architecture.md');
    assert.doesNotMatch(content, /^## Source Modules$/m);
    assert.doesNotMatch(content, /exhaustive listing of every source file/i);
    for (const heading of [
      'Purpose, Audience, and Ownership',
      'System Components',
      'State Ownership and Durability',
      'Data Flow',
      'Failure Domains and Recovery Ownership',
      'Decision and Requirement Map',
    ]) {
      assert.match(content, new RegExp(`^## ${heading}$`, 'm'));
    }
  });

  it('uses compact grouped registers for API and configuration lanes', () => {
    const apiHeaders = tableHeaders(template('documentation-api-reference.md'));
    assert.ok(apiHeaders.some((headers) =>
      ['Method', 'Path', 'Auth', 'Implements', 'Description'].every((field) => headers.includes(field)),
    ));

    const configurationHeaders = tableHeaders(template('documentation-configuration.md'));
    assert.ok(configurationHeaders.some((headers) =>
      ['Variable', 'Purpose', 'Default', 'Required', 'Consumed by', 'Implements']
        .every((field) => headers.includes(field)),
    ));
  });

  it('renders only the lane rows selected by /sdd init', () => {
    const content = template('documentation-readme.md');
    assert.match(content, /\{LANE_INDEX_ROWS\}/);
    assert.doesNotMatch(content, /^\| \[API Reference\]/m);
  });

  it('contains no deprecated numeric file-budget directives', () => {
    const names = [
      'documentation-architecture.md',
      'documentation-api-reference.md',
      'documentation-configuration.md',
      'documentation-deployment.md',
      'documentation-readme.md',
    ];
    for (const name of names) {
      assert.doesNotMatch(template(name), /(?:budget|limit):?\s*(?:≤|<=)\s*\d+\s*lines?/i, name);
    }
  });
});
