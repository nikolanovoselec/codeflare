import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDocumentationTemplates } from '../../preseed/agents/claude/skills/sdd-init/references/render-documentation-templates.mjs';

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

  it('renders the same selected lane set for greenfield and import mode', async () => {
    for (const mode of ['greenfield', 'import']) {
      const root = mkdtempSync(join(tmpdir(), `sdd-doc-${mode}-`));
      try {
        await renderDocumentationTemplates({
          mode,
          templatesDir: TEMPLATES,
          outputDir: join(root, 'documentation'),
          projectName: 'Example Project',
          lanes: ['architecture', 'security', 'api-reference-admin'],
          projectLanes: [{ slug: 'payments', title: 'Payments' }],
        });
        assert.deepEqual(readdirSync(join(root, 'documentation', 'lanes')).sort(), [
          'api-reference-admin.md', 'architecture.md', 'payments.md', 'security.md',
        ]);
        const index = readFileSync(join(root, 'documentation', 'README.md'), 'utf8');
        assert.doesNotMatch(index, /\{LANE_INDEX_ROWS\}/);
        assert.match(index, /\[Architecture\]\(lanes\/architecture\.md\)/);
        assert.match(index, /\[Security\]\(lanes\/security\.md\)/);
        assert.match(index, /\[Admin API Reference\]\(lanes\/api-reference-admin\.md\)/);
        assert.match(index, /\[Payments\]\(lanes\/payments\.md\)/);
        assert.doesNotMatch(index, /lanes\/api-reference\.md\)/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('rejects unsafe project-lane identities before writing files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdd-doc-invalid-'));
    try {
      await assert.rejects(
        renderDocumentationTemplates({
          mode: 'import',
          templatesDir: TEMPLATES,
          outputDir: join(root, 'documentation'),
          projectName: 'Example Project',
          lanes: ['architecture'],
          projectLanes: [{ slug: '../outside', title: 'Outside' }],
        }),
        /Invalid project lane slug/,
      );
      assert.equal(existsSync(join(root, 'outside.md')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('contains no deprecated numeric file-budget directives', () => {
    const names = [
      'documentation-architecture.md',
      'documentation-api-reference.md',
      'documentation-configuration.md',
      'documentation-deployment.md',
      'documentation-security.md',
      'documentation-observability.md',
      'documentation-troubleshooting.md',
      'documentation-project-lane.md',
      'documentation-readme.md',
    ];
    for (const name of names) {
      assert.doesNotMatch(template(name), /(?:budget|limit):?\s*(?:≤|<=)\s*\d+\s*lines?/i, name);
    }
  });
});
