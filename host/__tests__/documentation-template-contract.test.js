import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
        const result = await renderDocumentationTemplates({
          mode,
          templatesDir: TEMPLATES,
          outputDir: join(root, 'documentation'),
          projectName: 'Example Project',
          lanes: ['architecture', 'security', 'api-reference-admin'],
          projectLanes: [{ slug: 'payments', title: 'Payments' }],
        });
        assert.deepEqual(result.lanes, [
          'lanes/architecture.md',
          'lanes/security.md',
          'lanes/api-reference-admin.md',
          'lanes/payments.md',
        ]);
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
        assert.equal(existsSync(join(root, 'documentation', 'decisions', 'README.md')), true);

        const architecture = readFileSync(join(root, 'documentation', 'lanes', 'architecture.md'), 'utf8');
        const payments = readFileSync(join(root, 'documentation', 'lanes', 'payments.md'), 'utf8');
        assert.match(architecture, /^# Example Project Architecture$/m);
        assert.doesNotMatch(architecture, /\{PROJECT_NAME\}/);
        assert.match(payments, /^# Payments$/m);
        assert.doesNotMatch(payments, /\{PROJECT_LANE_TITLE\}/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('rejects unsafe project-lane identities before writing files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdd-doc-invalid-'));
    try {
      for (const projectLane of [
        { slug: '../outside', title: 'Outside' },
        { slug: 'payments', title: 'Payments | Internal' },
        { slug: 'payments', title: '[Payments](https://example.com)' },
      ]) {
        await assert.rejects(renderDocumentationTemplates({
          mode: 'import',
          templatesDir: TEMPLATES,
          outputDir: join(root, 'documentation'),
          projectName: 'Example Project',
          lanes: ['architecture'],
          projectLanes: [projectLane],
        }));
      }
      assert.equal(existsSync(join(root, 'outside.md')), false);
      assert.equal(existsSync(join(root, 'documentation')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires fresh non-symlink staging and removes partial render output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdd-doc-staging-'));
    const options = {
      mode: 'import',
      templatesDir: TEMPLATES,
      outputDir: join(root, 'documentation'),
      projectName: 'Example Project',
      lanes: ['architecture'],
    };
    try {
      mkdirSync(options.outputDir);
      writeFileSync(join(options.outputDir, 'stale.md'), 'stale');
      await assert.rejects(renderDocumentationTemplates(options), /must not already exist/);
      assert.equal(readFileSync(join(options.outputDir, 'stale.md'), 'utf8'), 'stale');

      rmSync(options.outputDir, { recursive: true });
      const outside = join(root, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, options.outputDir, 'dir');
      await assert.rejects(renderDocumentationTemplates(options), /must not already exist/);
      assert.deepEqual(readdirSync(outside), []);

      rmSync(options.outputDir);
      await assert.rejects(renderDocumentationTemplates({
        ...options,
        templatesDir: join(root, 'missing-templates'),
      }));
      assert.equal(existsSync(options.outputDir), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses one uppercase underscore placeholder grammar', () => {
    const names = readdirSync(TEMPLATES).filter((name) => name.startsWith('documentation-'));
    for (const name of names) {
      const tokens = [...template(name).matchAll(/\{([^}\n]+)\}/g)].map((match) => match[1]);
      for (const token of tokens) assert.match(token, /^[A-Z][A-Z0-9_]*$/, `${name}: ${token}`);
    }
  });

  it('contains no deprecated numeric file-budget directives', () => {
    const names = readdirSync(TEMPLATES).filter((name) => name.startsWith('documentation-'));
    for (const name of names) {
      assert.doesNotMatch(template(name), /(?:budget|limit):?\s*(?:≤|<=)\s*\d+\s*lines?/i, name);
    }
  });
});
