import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const CHECKER = join(
  ROOT,
  'preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs',
);

function runFixture(files) {
  const cwd = mkdtempSync(join(tmpdir(), 'doc-shape-'));
  try {
    const paths = Object.entries(files).map(([name, content]) => {
      const path = join(cwd, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return path;
    });
    return spawnSync(process.execPath, [CHECKER, ...paths], {
      cwd,
      encoding: 'utf8',
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const fields = {
  architecture: [
    '**Responsibility:** Own the request boundary.',
    '**Inputs:** Authenticated requests.',
    '**Outputs:** Routed responses.',
    '**Source:** `src/index.ts`.',
  ],
  troubleshooting: [
    '**Symptom:** A request fails.',
    '**Cause:** The route is absent.',
    '**Fix:** Restore the route.',
  ],
};

function perItemFixture(kind, body = fields[kind]) {
  const area = kind === 'architecture' ? 'System Components' : 'Common Issues';
  return `# Guide\n\nPreamble without template fields.\n\n## Contents\n\n- [${area}](#${area.toLowerCase().replaceAll(' ', '-')})\n\n## ${area}\n\nArea introduction without template fields.\n\n### Example Item\n\n${body.join('\n\n')}\n\n## Unrelated Area\n\n### Background Detail\n\nThis unrelated heading is not an item collection.\n`;
}

// CF-017 / DOCS-002
describe('doc-enforce shape item traversal', () => {
  it('recognizes complete per-item component and recipe collections', () => {
    for (const kind of ['architecture', 'troubleshooting']) {
      const result = runFixture({ [`${kind}.md`]: perItemFixture(kind) });
      assert.equal(result.status, 0, `${kind}: ${result.stdout}\n${result.stderr}`);
    }
  });

  it('recognizes complete grouped component, recipe, and endpoint collections', () => {
    const fixtures = {
      'architecture.md': '# Architecture\n\n## Components\n\n| Component | Responsibility | Inputs | Outputs | Source |\n|---|---|---|---|---|\n| Worker | Route traffic | Requests | Responses | `src/index.ts` |\n',
      'troubleshooting.md': '# Troubleshooting\n\n## Recipes\n\n| Recipe | Symptom | Cause | Fix |\n|---|---|---|---|\n| Missing route | HTML response | Route omitted | Restore route |\n',
      'api-reference.md': '# API\n\n## Sessions\n\n| Method | Path | Auth | Implements | Description |\n|---|---|---|---|---|\n| GET | `/api/sessions` | Session cookie | REQ-SESSION-001 | List sessions |\n',
    };
    const result = runFixture(fixtures);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it('keeps an inline-code comment opener literal and reports a later malformed item', () => {
    const content = [
      '# Architecture',
      '',
      '## Examples',
      '',
      'The literal token `<!--` starts an HTML comment.',
      '',
      '## System Components',
      '',
      '### Worker',
      '',
      '**Responsibility:** Still governed after the inline code.',
    ].join('\n');
    const result = runFixture({ 'architecture.md': content });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const [finding] = JSON.parse(result.stdout).findings;
    assert.equal(finding.item, 'Worker');
    assert.deepEqual(finding.missing, ['Inputs', 'Outputs', 'Source']);
  });

  it('keeps a fenced-code comment opener literal and reports a later malformed item', () => {
    const content = [
      '# Troubleshooting',
      '',
      '## Examples',
      '',
      '```markdown',
      '<!--',
      '```',
      '',
      '## Common Issues',
      '',
      '### Chrome in CI',
      '',
      '**Symptom:** Still governed after the fenced code.',
    ].join('\n');
    const result = runFixture({ 'troubleshooting.md': content });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const [finding] = JSON.parse(result.stdout).findings;
    assert.equal(finding.item, 'Chrome in CI');
    assert.deepEqual(finding.missing, ['Cause', 'Fix']);
  });

  it('ignores headings and shape fields inside tilde fences', () => {
    const content = [
      '# Architecture',
      '',
      '## System Components',
      '',
      '~~~markdown',
      '### Worker',
      '',
      '**Responsibility:** Fenced example only.',
      '~~~',
      '',
      '### Example Item',
      '',
      '**Responsibility:** Real malformed item.',
    ].join('\n');
    const result = runFixture({ 'architecture.md': content });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const findings = JSON.parse(result.stdout).findings;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].item, 'Example Item');
    assert.deepEqual(findings[0].missing, ['Inputs', 'Outputs', 'Source']);
  });

  it('does not close a four-backtick fence with triple backticks', () => {
    const content = [
      '# Troubleshooting',
      '',
      '## Common Issues',
      '',
      '````markdown',
      '### Chrome in CI',
      '',
      '**Symptom:** Fenced example only.',
      '```',
      '### Access Application Not Found',
      '',
      '**Symptom:** Still fenced after the shorter delimiter.',
      '````',
      '',
      '### Example Item',
      '',
      '**Symptom:** Real malformed item.',
    ].join('\n');
    const result = runFixture({ 'troubleshooting.md': content });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const findings = JSON.parse(result.stdout).findings;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].item, 'Example Item');
    assert.deepEqual(findings[0].missing, ['Cause', 'Fix']);
  });

  it('keeps a multiline inline-code comment opener literal and reports later malformed content', () => {
    const content = [
      '# Architecture',
      '',
      '## Examples',
      '',
      'The multiline code span `starts here',
      '<!--',
      'and ends here` without opening a comment.',
      '',
      '## System Components',
      '',
      '### Worker',
      '',
      '**Responsibility:** Still governed after the multiline code.',
    ].join('\n');
    const result = runFixture({ 'architecture.md': content });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const findings = JSON.parse(result.stdout).findings;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].item, 'Worker');
    assert.deepEqual(findings[0].missing, ['Inputs', 'Outputs', 'Source']);
  });

  it('ignores multiline HTML comments around recognized items', () => {
    const content = [
      '# Architecture',
      '',
      '## System Components',
      '',
      '<!--',
      '### Worker',
      '',
      '**Responsibility:** Hidden incomplete item.',
      '-->',
      '### Example Item',
      '',
      ...fields.architecture,
      '<!--',
      '### Container DO',
      '',
      '**Responsibility:** Another hidden incomplete item.',
      '-->',
    ].join('\n');
    const result = runFixture({ 'architecture.md': content });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it('discards an unterminated HTML comment containing hidden malformed content', () => {
    const content = [
      '# Troubleshooting',
      '',
      '## Common Issues',
      '',
      '<!--',
      '### Chrome in CI',
      '',
      '**Symptom:** Hidden failure.',
    ].join('\n');
    const result = runFixture({ 'troubleshooting.md': content });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it('rescans comment-removal boundaries that form a new unterminated opener', () => {
    const content = [
      '# Architecture',
      '',
      '## System Components',
      '',
      '### Example Item',
      '',
      ...fields.architecture,
      '',
      '<!<!-- removed -->--',
      '### Worker',
      '',
      '**Responsibility:** Hidden failure.',
    ].join('\n');
    const result = runFixture({ 'architecture.md': content });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it('reports a malformed item that has only part of its required shape', () => {
    const result = runFixture({
      'troubleshooting.md': perItemFixture('troubleshooting', [fields.troubleshooting[0]]),
    });
    assert.equal(result.status, 1);
    const findings = JSON.parse(result.stdout).findings;
    assert.deepEqual(findings[0].missing, ['Cause', 'Fix']);
    assert.equal(findings[0].item, 'Example Item');
  });

  it('reports a malformed grouped collection instead of dropping it', () => {
    const result = runFixture({
      'architecture.md': '# Architecture\n\n## Components\n\n| Component | Responsibility | Source |\n|---|---|---|\n| Worker | Route traffic | `src/index.ts` |\n',
    });
    assert.equal(result.status, 1);
    const findings = JSON.parse(result.stdout).findings;
    assert.deepEqual(findings[0].missing, ['Inputs', 'Outputs']);
    assert.equal(findings[0].item, 'Components table');
  });

  it('exempts preamble, area headings, and unrelated headings', () => {
    const result = runFixture({
      'architecture.md': perItemFixture('architecture'),
      'troubleshooting.md': perItemFixture('troubleshooting'),
      'api-reference.md': '# API\n\nIntro.\n\n## Conventions\n\n### Error Envelope\n\nNo endpoint fields here.\n',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

});

// REQ-AGENT-139 AC2-AC4
describe('optimized documentation lane shapes', () => {
  const tableProfiles = [
    {
      file: 'configuration.md',
      heading: 'Worker Environment',
      discriminator: 'Variable',
      required: ['Purpose', 'Default', 'Required', 'Consumed by', 'Implements'],
    },
    {
      file: 'security.md',
      heading: 'Threat Model',
      discriminator: 'Asset / boundary',
      required: ['Threat or failure', 'Control and failure posture', 'Residual risk / owner'],
    },
    {
      file: 'observability.md',
      heading: 'Signals',
      discriminator: 'Signal',
      required: ['Meaning / non-evidence', 'Observed at', 'Escalate when', 'Runbook'],
    },
  ];

  function tableFixture({ heading, discriminator, required }, omitted = null) {
    const headers = [discriminator, ...required].filter((field) => field !== omitted);
    return [
      '# Guide',
      '',
      `## ${heading}`,
      '',
      `| ${headers.join(' | ')} |`,
      `| ${headers.map(() => '---').join(' | ')} |`,
      `| ${headers.map((field) => `Example ${field}`).join(' | ')} |`,
    ].join('\n');
  }

  for (const profile of tableProfiles) {
    it(`accepts a complete ${profile.file} governed collection`, () => {
      const result = runFixture({ [profile.file]: tableFixture(profile) });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });

    for (const field of profile.required) {
      it(`reports ${field} missing from ${profile.file}`, () => {
        const result = runFixture({ [profile.file]: tableFixture(profile, field) });
        assert.equal(result.status, 1, result.stdout);
        assert.deepEqual(JSON.parse(result.stdout).findings[0].missing, [field]);
      });
    }
  }

  const deploymentFields = {
    When: 'A reviewed release is ready.',
    Action: 'Run the release workflow.',
    Verify: 'The health check passes.',
    Rollback: 'Restore the prior release.',
  };

  function deploymentFixture(omitted = null) {
    return [
      '# Deployment',
      '',
      '## Standard Deployment',
      '',
      ...Object.entries(deploymentFields)
        .filter(([field]) => field !== omitted)
        .flatMap(([field, value]) => [`**${field}:** ${value}`, '']),
    ].join('\n');
  }

  it('accepts a complete canonical deployment runbook', () => {
    const result = runFixture({ 'deployment.md': deploymentFixture() });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  for (const field of Object.keys(deploymentFields)) {
    it(`reports ${field} missing from a deployment runbook`, () => {
      const result = runFixture({ 'deployment.md': deploymentFixture(field) });
      assert.equal(result.status, 1, result.stdout);
      assert.deepEqual(JSON.parse(result.stdout).findings[0].missing, [field]);
    });
  }

  it('accepts legacy deployment field aliases without making them canonical', () => {
    const legacy = deploymentFixture()
      .replace('**Action:**', '**Command:**')
      .replace('**Verify:**', '**Verifies:**');
    const result = runFixture({ 'deployment.md': legacy });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it('does not confuse unrelated tables with governed collections', () => {
    const result = runFixture({
      'configuration.md': '# Configuration\n\n## Permissions\n\n| Permission | Why |\n|---|---|\n| read | Inspection |\n',
      'security.md': '# Security\n\n## Contacts\n\n| Team | Email |\n|---|---|\n| Security | security@example.com |\n',
      'observability.md': '# Observability\n\n## Vendors\n\n| Vendor | Product |\n|---|---|\n| Example | Logs |\n',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});
