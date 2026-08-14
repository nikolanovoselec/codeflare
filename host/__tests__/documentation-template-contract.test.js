import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
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
import { checkDocuments } from '../../preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs';
import { renderDocumentationTemplates } from '../../preseed/agents/claude/skills/sdd-init/references/render-documentation-templates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const TEMPLATES = join(
  ROOT,
  'preseed/agents/claude/skills/spec-driven-development/references/templates',
);

const ALL_STANDARD_LANES = [
  'api-reference',
  'configuration',
  'deployment',
  'security',
  'observability',
  'troubleshooting',
  'api-reference-admin',
];

// REQ-AGENT-139 AC1-AC4
describe('optimized SDD documentation templates', () => {
  it('renders every canonical lane and a project lane consistently in both init modes', async () => {
    for (const mode of ['greenfield', 'import']) {
      const root = mkdtempSync(join(tmpdir(), `sdd-doc-${mode}-`));
      const outputDir = join(root, 'documentation');
      try {
        const result = await renderDocumentationTemplates({
          mode,
          templatesDir: TEMPLATES,
          outputDir,
          projectName: 'Example Project',
          lanes: ALL_STANDARD_LANES,
          projectLanes: [{ slug: 'payments', title: 'Payments' }],
        });
        assert.deepEqual(result.lanes, [
          'lanes/architecture.md',
          'lanes/api-reference.md',
          'lanes/configuration.md',
          'lanes/deployment.md',
          'lanes/security.md',
          'lanes/observability.md',
          'lanes/troubleshooting.md',
          'lanes/api-reference-admin.md',
          'lanes/payments.md',
        ]);
        assert.deepEqual(readdirSync(join(outputDir, 'lanes')).sort(), [
          'api-reference-admin.md',
          'api-reference.md',
          'architecture.md',
          'configuration.md',
          'deployment.md',
          'observability.md',
          'payments.md',
          'security.md',
          'troubleshooting.md',
        ]);

        const lanePaths = result.lanes.map((relativePath) => join(outputDir, relativePath));
        assert.deepEqual(await checkDocuments(lanePaths), { ok: true, findings: [] });

        const index = readFileSync(join(outputDir, 'README.md'), 'utf8');
        for (const relativePath of result.lanes) assert.match(index, new RegExp(relativePath.replace('.', '\\.')));
        assert.doesNotMatch(index, /\{LANE_INDEX_ROWS\}/);
        assert.equal(existsSync(join(outputDir, 'decisions', 'README.md')), true);

        const architecture = readFileSync(join(outputDir, 'lanes', 'architecture.md'), 'utf8');
        const payments = readFileSync(join(outputDir, 'lanes', 'payments.md'), 'utf8');
        assert.match(architecture, /^# Example Project Architecture$/m);
        assert.doesNotMatch(architecture, /^## Source Modules$/m);
        assert.match(payments, /^# Payments$/m);
        assert.doesNotMatch(architecture, /\{PROJECT_NAME\}/);
        assert.doesNotMatch(payments, /\{PROJECT_LANE_TITLE\}/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('emits only selected lane rows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdd-doc-selected-'));
    const outputDir = join(root, 'documentation');
    try {
      await renderDocumentationTemplates({
        mode: 'greenfield',
        templatesDir: TEMPLATES,
        outputDir,
        projectName: 'Example Project',
        lanes: ['security'],
      });
      assert.deepEqual(readdirSync(join(outputDir, 'lanes')).sort(), ['architecture.md', 'security.md']);
      const index = readFileSync(join(outputDir, 'README.md'), 'utf8');
      assert.match(index, /lanes\/architecture\.md/);
      assert.match(index, /lanes\/security\.md/);
      assert.doesNotMatch(index, /lanes\/api-reference\.md/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('escapes a user-derived project name before Markdown rendering', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdd-doc-name-'));
    const outputDir = join(root, 'documentation');
    try {
      await renderDocumentationTemplates({
        mode: 'greenfield',
        templatesDir: TEMPLATES,
        outputDir,
        projectName: 'Example <!-- hidden --> [internal] | docs',
        lanes: ['architecture'],
      });
      const architecture = readFileSync(join(outputDir, 'lanes', 'architecture.md'), 'utf8');
      assert.doesNotMatch(architecture, /<!-- hidden -->/);
      assert.match(architecture, /&lt;!-- hidden --&gt; &#91;internal&#93; &#124; docs/);
    } finally {
      rmSync(root, { recursive: true, force: true });
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

  it('rejects malformed placeholders and hard-coded exemplar IDs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdd-doc-template-validation-'));
    const templatesDir = join(root, 'templates');
    cpSync(TEMPLATES, templatesDir, { recursive: true });
    const architectureTemplate = join(templatesDir, 'documentation-architecture.md');
    const base = readFileSync(architectureTemplate, 'utf8');
    try {
      for (const [index, invalid] of ['{bad placeholder}', '{BAD', 'BAD}', '{}'].entries()) {
        const outputDir = join(root, `bad-placeholder-${index}`);
        writeFileSync(architectureTemplate, `${base}\n${invalid}\n`);
        await assert.rejects(renderDocumentationTemplates({
          mode: 'greenfield', templatesDir, outputDir,
          projectName: 'Example Project', lanes: ['architecture'],
        }), /Invalid placeholder|Unmatched placeholder brace/);
        assert.equal(existsSync(outputDir), false);
      }

      writeFileSync(architectureTemplate, `${base}\nREQ-FAKE-001\n`);
      await assert.rejects(renderDocumentationTemplates({
        mode: 'greenfield', templatesDir, outputDir: join(root, 'bad-id'),
        projectName: 'Example Project', lanes: ['architecture'],
      }), /Hard-coded exemplar ID/);
      assert.equal(existsSync(join(root, 'bad-id')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
