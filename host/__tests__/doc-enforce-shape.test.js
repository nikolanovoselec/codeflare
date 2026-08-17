import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

// REQ-AGENT-140 AC2-AC6
describe('optimized documentation lane shapes', () => {
  const tableProfiles = [
    {
      name: 'configuration variables',
      file: 'configuration.md',
      heading: 'Worker Environment',
      discriminator: 'Variable',
      required: ['Purpose', 'Default', 'Required', 'Consumed by', 'Implements'],
    },
    {
      name: 'configuration bindings',
      file: 'configuration.md',
      heading: 'Platform Bindings',
      discriminator: 'Binding',
      required: ['Purpose', 'Required', 'Consumed by', 'Implements'],
    },
    {
      name: 'security threats',
      file: 'security.md',
      heading: 'Threat Model',
      discriminator: 'Asset / boundary',
      required: ['Threat or failure', 'Control and failure posture', 'Residual risk / owner'],
    },
    {
      name: 'security residual risks',
      file: 'security.md',
      heading: 'Accepted Exceptions and Residual Risks',
      discriminator: 'Exception / residual risk',
      required: ['Current decision', 'Owner / review signal'],
    },
    {
      name: 'security verification',
      file: 'security.md',
      heading: 'Verification and Source Map',
      discriminator: 'Control family',
      required: ['Requirements / decisions', 'Implementation', 'Evidence'],
    },
    {
      name: 'observability signals',
      file: 'observability.md',
      heading: 'Signals',
      discriminator: 'Signal',
      required: ['Meaning / non-evidence', 'Observed at', 'Escalate when', 'Runbook'],
    },
    {
      name: 'troubleshooting summary recipes',
      file: 'troubleshooting.md',
      heading: 'Failure Index',
      discriminator: 'Symptom',
      required: ['Cause', 'Fix'],
    },
  ];

  function tableFixtureWithHeaders({ heading }, headers) {
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

  function tableFixture({ discriminator, required, ...profile }, omitted = null) {
    const headers = [discriminator, ...required].filter((field) => field !== omitted);
    return tableFixtureWithHeaders(profile, headers);
  }

  for (const profile of tableProfiles) {
    it(`accepts complete ${profile.name}`, () => {
      const result = runFixture({ [profile.file]: tableFixture(profile) });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });

    for (const field of profile.required) {
      it(`reports ${field} missing from ${profile.name}`, () => {
        const result = runFixture({ [profile.file]: tableFixture(profile, field) });
        assert.equal(result.status, 1, result.stdout);
        assert.deepEqual(JSON.parse(result.stdout).findings[0].missing, [field]);
      });
    }
  }

  it('reports every absent field from sparse tables in governed collection areas', () => {
    for (const profile of tableProfiles) {
      const loneField = profile.required[0];
      const sparse = runFixture({
        [profile.file]: tableFixtureWithHeaders(profile, [loneField]),
      });
      assert.equal(sparse.status, 1, `${profile.name}: ${sparse.stdout}`);
      assert.deepEqual(
        JSON.parse(sparse.stdout).findings[0].missing,
        [profile.discriminator, ...profile.required.filter((field) => field !== loneField)],
      );

      const fieldless = runFixture({
        [profile.file]: tableFixtureWithHeaders(profile, ['Unrelated heading']),
      });
      assert.equal(fieldless.status, 1, `${profile.name}: ${fieldless.stdout}`);
      assert.deepEqual(
        JSON.parse(fieldless.stdout).findings[0].missing,
        [profile.discriminator, ...profile.required],
      );
    }
  });

  it('reports fieldless records in explicit component, recipe, and endpoint collections', () => {
    for (const [file, content, missing] of [
      [
        'architecture.md',
        '# Architecture\n\n## Components\n\n### Worker\n',
        ['Responsibility', 'Inputs', 'Outputs', 'Source'],
      ],
      [
        'troubleshooting.md',
        '# Troubleshooting\n\n## Troubleshooting Recipes\n\n### Request fails\n',
        ['Symptom', 'Cause', 'Fix'],
      ],
      [
        'api-reference.md',
        '# API\n\n## Items\n\n### GET `/items`\n',
        ['Authentication', 'Response', 'Implements'],
      ],
    ]) {
      const result = runFixture({ [file]: content });
      assert.equal(result.status, 1, `${file}: ${result.stdout}`);
      assert.deepEqual(JSON.parse(result.stdout).findings[0].missing, missing);
    }
  });

  it('accepts Description as a legacy configuration Purpose alias', () => {
    const profile = tableProfiles.find(({ name }) => name === 'configuration variables');
    const legacy = tableFixture(profile).replace('| Variable | Purpose |', '| Variable | Description |');
    const result = runFixture({ 'configuration.md': legacy });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it('requires every API register discriminator and contract field', () => {
    const fields = ['Method', 'Path', 'Auth', 'Implements', 'Description'];
    const fixture = (omitted = null) => {
      const headers = fields.filter((field) => field !== omitted);
      return [
        '# API',
        '',
        '## Sessions',
        '',
        `| ${headers.join(' | ')} |`,
        `| ${headers.map(() => '---').join(' | ')} |`,
        `| ${headers.map((field) => `Example ${field}`).join(' | ')} |`,
      ].join('\n');
    };
    assert.equal(runFixture({ 'api-reference.md': fixture() }).status, 0);
    for (const field of ['Method', 'Path', 'Auth', 'Implements']) {
      const result = runFixture({ 'api-reference.md': fixture(field) });
      assert.equal(result.status, 1, `${field}: ${result.stdout}`);
      assert.deepEqual(JSON.parse(result.stdout).findings[0].missing, [field]);
    }
  });

  it('accepts minimal and legacy API sections and validates detailed standard-method sections', () => {
    const minimalFields = {
      Authentication: 'Session cookie',
      Response: '`200` item list',
      Implements: 'REQ-API-001',
    };
    const minimalFixture = (omitted = null) => [
      '# API', '', '## Items', '', '### GET `/items`', '',
      ...Object.entries(minimalFields)
        .filter(([field]) => field !== omitted)
        .flatMap(([field, value]) => [`**${field}:** ${value}`, '']),
    ].join('\n');
    assert.equal(runFixture({ 'api-reference.md': minimalFixture() }).status, 0);
    for (const field of Object.keys(minimalFields)) {
      const result = runFixture({ 'api-reference.md': minimalFixture(field) });
      assert.equal(result.status, 1, `${field}: ${result.stdout}`);
      assert.deepEqual(JSON.parse(result.stdout).findings[0].missing, [field]);
    }

    const legacy = [
      '# API', '', '## Items', '', '### GET `/items`', '',
      '**Implements:** REQ-API-001', '',
      '**Authentication:** Session cookie', '',
      '**Request:** No request body.', '',
      '**Response 200:** Item list.', '',
      '**Error responses:** `401` when unauthenticated.', '',
      '**Implementation:** `src/items.ts`',
    ].join('\n');
    assert.equal(runFixture({ 'api-reference.md': legacy }).status, 0);
    const malformedLegacy = runFixture({
      'api-reference.md': legacy.replace('**Response 200:** Item list.\n\n', ''),
    });
    assert.equal(malformedLegacy.status, 1, malformedLegacy.stdout);
    assert.deepEqual(JSON.parse(malformedLegacy.stdout).findings[0].missing, ['Response']);
    for (const [label, value, semantic] of [
      ['Request', 'No request body.', 'Request'],
      ['Error responses', '`401` when unauthenticated.', 'Errors'],
      ['Implementation', '`src/items.ts`', 'Source'],
    ]) {
      const line = `**${label}:** ${value}`;
      const result = runFixture({
        'api-reference.md': legacy.replace(label === 'Implementation' ? line : `${line}\n\n`, ''),
      });
      assert.equal(result.status, 1, `${label}: ${result.stdout}`);
      assert.deepEqual(JSON.parse(result.stdout).findings[0].missing, [semantic]);
    }

    const detailed = [
      '# API', '', '## Items', '', '### HEAD `/items`', '',
      '**Request:** No request body.', '',
      '**Response:** `200` headers.', '',
      '**Errors:** `401` when unauthenticated.', '',
      '**Source:** `src/items.ts`', '',
      '**Implements:** REQ-API-001',
    ].join('\n');
    assert.equal(runFixture({ 'api-reference.md': detailed }).status, 0);
    const malformed = runFixture({
      'api-reference.md': detailed.replace('**Errors:** `401` when unauthenticated.\n\n', ''),
    });
    assert.equal(malformed.status, 1, malformed.stdout);
    assert.deepEqual(JSON.parse(malformed.stdout).findings[0].missing, ['Errors']);

    const sparse = [
      '# API', '', '## Items', '', '### OPTIONS `/items`', '',
      '**Response:** `204`.', '',
      '**Source:** `src/items.ts`', '',
      '**Implements:** REQ-API-001',
    ].join('\n');
    const sparseResult = runFixture({ 'api-reference.md': sparse });
    assert.equal(sparseResult.status, 1, sparseResult.stdout);
    assert.deepEqual(JSON.parse(sparseResult.stdout).findings[0].missing, ['Request', 'Errors']);
  });

  it('ignores fenced collection tables and still reports a later live table', () => {
    for (const [open, close] of [['```markdown', '```'], ['~~~markdown', '~~~']]) {
      const fenced = [
        '# Configuration', '', '## Examples', '', open,
        '| Variable | Purpose |', '|---|---|', '| EXAMPLE | Demonstration |', close,
        '', '## Worker Environment', '',
        '| Variable | Purpose |', '|---|---|', '| LIVE | Runtime |',
      ].join('\n');
      const result = runFixture({ 'configuration.md': fenced });
      assert.equal(result.status, 1, `${open}: ${result.stdout}`);
      assert.equal(JSON.parse(result.stdout).findings.length, 1);
    }
  });

  it('checks the shared envelope of first-level project lanes', () => {
    const complete = [
      '# Payments', '',
      '**Audience:** Engineers', '',
      '**Owns:** Payment contracts.', '',
      '## Contents', '', '- [Requirement and Source Map](#requirement-and-source-map)', '',
      '## Requirement and Source Map', '', '| Concern | Source |', '|---|---|', '| Charges | `src/pay.ts` |', '',
      '## Related Documentation', '', '- [Architecture](architecture.md)',
    ].join('\n');
    assert.equal(runFixture({ 'documentation/lanes/payments.md': complete }).status, 0);
    const result = runFixture({
      'documentation/lanes/payments.md': complete.replace('**Owns:** Payment contracts.\n\n', ''),
    });
    assert.equal(result.status, 1, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).findings[0].missing, ['Owns']);
  });

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

  it('reports malformed governed table separators', () => {
    const content = [
      '# Configuration', '', '## Worker Environment', '',
      '| Variable | Purpose | Default | Required | Consumed by | Implements |',
      '|---|---|---|',
      '| `API_TOKEN` | API access | none | yes | client | REQ-CONFIG-001 |',
    ].join('\n');
    const result = runFixture({ 'configuration.md': content });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).findings[0].rule, 'table-column-count-mismatch');
  });

  it('accepts the current indexed Codeflare lane corpus without product inventory names', () => {
    const lanesDir = join(ROOT, 'documentation', 'lanes');
    const files = [
      ...readdirSync(lanesDir)
        .filter((name) => name.endsWith('.md'))
        .map((name) => join(lanesDir, name)),
      join(ROOT, 'documentation', 'decisions', 'README.md'),
    ];
    const result = spawnSync(process.execPath, [CHECKER, ...files], {
      cwd: ROOT,
      encoding: 'utf8',
    });
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

  it('REQ-AGENT-146 AC1+AC2: enforces bounded ADR index labels and summaries', () => {
    const fixture = [
      '# Architecture Decisions', '', '## Decision Index', '',
      '| ID | Decision | Summary | Category | State |', '|---|---|---|---|---|',
      '| [AD1](#ad1-isolate-sessions) | Isolate terminal sessions | Each terminal tab gets a dedicated container to prevent cross-tab contention and make teardown a clean-slate operation. | Architecture | Active |', '',
      '## Decisions', '', '### AD1: Isolate Sessions', '', '**Status:** Accepted (2026-08-17)', '',
      '**Decision:** Give each terminal tab a dedicated container.', '',
      '**Context:** Shared containers create cross-tab CPU contention.', '',
      '**Consequences:** Teardown removes the complete tab runtime.',
    ].join('\n');
    const accepted = runFixture({ 'documentation/decisions/README.md': fixture });
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);

    const cases = [
      {
        fixture: fixture
          .replace('| ID | Decision | Summary | Category | State |', '| ID | Decision | Category | State |')
          .replace('|---|---|---|---|---|', '|---|---|---|---|')
          .replace(' | Each terminal tab gets a dedicated container to prevent cross-tab contention and make teardown a clean-slate operation.', ''),
        rules: ['adr-index-columns-invalid'],
      },
      {
        fixture: fixture.replace('Isolate terminal sessions', 'X'.repeat(91)),
        rules: ['adr-index-decision-label-too-long'],
      },
      {
        fixture: fixture.replace('Each terminal tab gets a dedicated container to prevent cross-tab contention and make teardown a clean-slate operation.', 'Too short.'),
        rules: ['adr-index-summary-too-short'],
      },
      {
        fixture: fixture.replace('Each terminal tab gets a dedicated container to prevent cross-tab contention and make teardown a clean-slate operation.', 'X'.repeat(181)),
        rules: ['adr-index-summary-too-long'],
      },
      {
        fixture: fixture.replace('Each terminal tab gets a dedicated container to prevent cross-tab contention and make teardown a clean-slate operation.', 'Each terminal tab gets a dedicated container. Teardown removes its runtime.'),
        rules: ['adr-index-summary-multiple-sentences'],
      },
      {
        fixture: fixture.replace('Each terminal tab gets a dedicated container to prevent cross-tab contention and make teardown a clean-slate operation.', 'Isolate terminal sessions so every tab keeps an independent runtime boundary.'),
        rules: ['adr-index-summary-repeats-title'],
      },
      {
        fixture: fixture.replace('Each terminal tab gets a dedicated container to prevent cross-tab contention and make teardown a clean-slate operation.', 'It gives every terminal tab a dedicated container to prevent cross-tab contention.'),
        rules: ['adr-index-summary-pronoun-first'],
      },
    ];
    for (const candidate of cases) {
      const result = runFixture({ 'documentation/decisions/README.md': candidate.fixture });
      assert.equal(result.status, 1, result.stdout);
      const rules = JSON.parse(result.stdout).findings.map(({ rule }) => rule);
      for (const rule of candidate.rules) assert.ok(rules.includes(rule), `${rule} missing from ${rules.join(', ')}`);
    }
  });

  it('REQ-AGENT-146 AC3+AC5: rejects ungrounded summaries and state-incomplete ADR history', () => {
    const active = [
      '# Decisions', '', '## Decision Index', '',
      '| ID | Decision | Summary | Category | State |', '|---|---|---|---|---|',
      '| [AD1](#ad1-isolate-sessions) | Isolate terminal sessions | Cloud storage encrypts unrelated account data to reduce credential exposure. | Architecture | Active |', '',
      '## Decisions', '', '### AD1: Isolate Sessions', '', '**Status:** Accepted', '',
      '**Decision:** Give each terminal tab a dedicated container.', '',
      '**Context:** Shared containers create cross-tab CPU contention.', '',
      '**Consequences:** Teardown removes the complete tab runtime.',
    ].join('\n');
    const activeResult = runFixture({ 'documentation/decisions/README.md': active });
    assert.equal(activeResult.status, 1, activeResult.stdout);
    assert.ok(
      JSON.parse(activeResult.stdout).findings.some(({ rule }) => rule === 'adr-index-summary-choice-unrelated'),
      activeResult.stdout,
    );

    const inventedDriver = active.replace(
      'Cloud storage encrypts unrelated account data to reduce credential exposure.',
      'Each terminal tab receives a dedicated container to reduce monthly licensing fees for operators.',
    );
    const inventedDriverResult = runFixture({ 'documentation/decisions/README.md': inventedDriver });
    assert.equal(inventedDriverResult.status, 1, inventedDriverResult.stdout);
    assert.ok(
      JSON.parse(inventedDriverResult.stdout).findings
        .some(({ rule }) => rule === 'adr-index-summary-body-support-missing'),
      inventedDriverResult.stdout,
    );

    const supported = active.replace(
      'Cloud storage encrypts unrelated account data to reduce credential exposure.',
      'Each terminal tab receives a dedicated container to prevent cross-tab CPU contention during shared work.',
    );
    const supportedResult = runFixture({ 'documentation/decisions/README.md': supported });
    assert.equal(supportedResult.status, 0, `${supportedResult.stdout}\n${supportedResult.stderr}`);

    const historical = [
      '# Decisions', '', '## Decision Index', '',
      '| ID | Decision | Summary | Category | State |', '|---|---|---|---|---|',
      '| ~~[AD1](#ad1-old-choice)~~ | ~~Old choice~~ | Historical behavior changed after a later decision replaced its runtime boundary. | Architecture | Superseded |',
      '| [AD2](#ad2-active-remainder) | Active remainder | The active mechanism continues while one clause changed in a later decision. | Architecture | Partially superseded |',
      '| [AD3](#ad3-redirect) | Redirect old rationale | The rationale moved into its canonical documentation home. | Architecture | Redirect anchor |', '',
      '## Decisions', '',
      '### AD1: Old Choice', '', '**Status:** Superseded by [AD4](#ad4-successor)', '', '**Context:** Historical context.', '', '**Decision:** Historical behavior.', '', '**Consequences:** Historical effect.', '',
      '### AD2: Active Remainder', '', '**Status:** Partially superseded by [AD4](#ad4-successor): retry timing only.', '', '**Decision:** Keep the active mechanism.', '', '**Context:** One clause changed.', '', '**Consequences:** The remainder stays active.', '',
      '### AD3: Redirect', '', '**Status:** Reclassified into [Security](../lanes/security.md).',
    ].join('\n');
    const historicalResult = runFixture({ 'documentation/decisions/README.md': historical });
    assert.equal(historicalResult.status, 1, historicalResult.stdout);
    const rules = JSON.parse(historicalResult.stdout).findings.map(({ rule }) => rule);
    for (const rule of ['adr-index-summary-successor-missing', 'adr-index-summary-retained-scope-missing', 'adr-index-summary-destination-missing']) {
      assert.ok(rules.includes(rule), `${rule} missing from ${rules.join(', ')}`);
    }

    const mismatchedStates = [
      active.replace(' | Architecture | Active |', ' | Architecture | Superseded |'),
      historical.replace(' | Architecture | Superseded |', ' | Architecture | Active |'),
      historical.replace(' | Architecture | Partially superseded |', ' | Architecture | Active |'),
      historical.replace(' | Architecture | Redirect anchor |', ' | Architecture | Active |'),
    ];
    for (const fixture of mismatchedStates) {
      const result = runFixture({ 'documentation/decisions/README.md': fixture });
      assert.equal(result.status, 1, result.stdout);
      assert.ok(
        JSON.parse(result.stdout).findings.some(({ rule }) => rule === 'adr-index-state-mismatch'),
        result.stdout,
      );
    }
  });

  it('requires superseded ADR index entries to be visibly struck through', () => {
    const fixture = [
      '# Architecture Decisions', '', '## Decision Index', '',
      '| ID | Decision | Summary | Category | State |', '|---|---|---|---|---|',
      '| [AD1](#ad1-old-choice) | Old choice | [AD2](#ad2-new-choice) replaces the historical choice so current behavior has one authoritative architecture boundary. | Architecture | Superseded |',
      '| [AD2](#ad2-new-choice) | New choice; one clause amended by [AD3](#ad3-amendment) | The active mechanism remains in force while [AD3](#ad3-amendment) replaces only the named clause. | Architecture | Partially superseded |', '',
      '## Decisions', '', '### AD1: Old choice', '',
      '**Status:** Superseded by [AD2](#ad2-new-choice)', '',
      '**Context:** Original constraint.', '', '**Decision:** Original choice.', '', '**Consequences:** Historical effect.', '',
      '### AD2: New choice', '', '**Status:** Partially superseded by [AD3](#ad3-amendment): retry timing only.',
    ].join('\n');
    const result = runFixture({ 'documentation/decisions/README.md': fixture });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).findings[0].rule, 'adr-superseded-not-struck');

    const corrected = fixture.replace(
      '| [AD1](#ad1-old-choice) | Old choice | [AD2](#ad2-new-choice) replaces the historical choice so current behavior has one authoritative architecture boundary. | Architecture | Superseded |',
      '| ~~[AD1](#ad1-old-choice)~~ | ~~Old choice — superseded by [AD2](#ad2-new-choice)~~ | [AD2](#ad2-new-choice) replaces the historical choice so current behavior has one authoritative architecture boundary. | Architecture | Superseded |',
    );
    const accepted = runFixture({ 'documentation/decisions/README.md': corrected });
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
  });

  it('rejects ambiguous redirect category labels in ADR indexes', () => {
    const fixture = [
      '# Architecture Decisions', '', '## Decision Index', '',
      '| ID | Decision | Summary | Category | State |', '|---|---|---|---|---|',
      '| [AD9](#ad9-redirect) | Reclassified into Configuration | [Configuration](../lanes/configuration.md) now owns this rationale so the stable ADR identifier remains available for inbound history. | (redirect) | Redirect anchor |', '',
      '## Decisions', '', '### AD9: Redirect', '',
      '**Status:** Reclassified into [Configuration](../lanes/configuration.md)',
    ].join('\n');
    const result = runFixture({ 'documentation/decisions/README.md': fixture });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).findings[0].rule, 'adr-redirect-label-ambiguous');

    const corrected = fixture.replace('(redirect)', 'Architecture');
    const accepted = runFixture({ 'documentation/decisions/README.md': corrected });
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
  });

  it('requires ADR index/section pairing and retained superseded history', () => {
    const missingSection = [
      '# Decisions', '', '## Decision Index', '',
      '| ID | Decision | Summary | Category | State |', '|---|---|---|---|---|',
      '| [AD1](#ad1-missing) | Missing section | The fixture keeps this architecture choice explicit to preserve the behavior exercised by its paired ADR section. | Architecture | Active |', '', '## Decisions',
    ].join('\n');
    const unpaired = runFixture({ 'documentation/decisions/README.md': missingSection });
    assert.equal(unpaired.status, 1, unpaired.stdout);
    assert.equal(JSON.parse(unpaired.stdout).findings[0].rule, 'adr-index-section-missing');

    const missingHistory = [
      '# Decisions', '', '## Decision Index', '',
      '| ID | Decision | Summary | Category | State |', '|---|---|---|---|---|',
      '| ~~[AD1](#ad1-old)~~ | ~~Old — superseded by [AD2](#ad2-new)~~ | [AD2](#ad2-new) replaces the historical choice so current behavior has one authoritative architecture boundary. | Architecture | Superseded |', '',
      '## Decisions', '', '### AD1: Old', '', '**Status:** Superseded by [AD2](#ad2-new)',
    ].join('\n');
    const history = runFixture({ 'documentation/decisions/README.md': missingHistory });
    assert.equal(history.status, 1, history.stdout);
    assert.equal(JSON.parse(history.stdout).findings[0].rule, 'adr-superseded-history-missing');
  });

  it('requires linked ADR IDs to target their matching section anchors', () => {
    const fixture = [
      '# Decisions', '', '## Decision Index', '',
      '| ID | Decision | Summary | Category | State |', '|---|---|---|---|---|',
      '| [AD1](#wrong-target) | Choice | The fixture keeps this architecture choice explicit to preserve the behavior exercised by its paired ADR section. | Architecture | Active |', '',
      '## Decisions', '', '### AD1: Choice', '', '**Status:** Active',
    ].join('\n');
    const result = runFixture({ 'documentation/decisions/README.md': fixture });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).findings[0].rule, 'adr-index-anchor-mismatch');
  });

  it('normalizes nested HTML-like heading tags without leaving tag fragments', () => {
    const fixture = [
      '# Decisions', '', '## Decision Index', '',
      '| ID | Decision | Summary | Category | State |', '|---|---|---|---|---|',
      '| [AD1](#ad1-choice) | Choice | The fixture keeps this architecture choice explicit to preserve the behavior exercised by its paired ADR section. | Architecture | Active |', '',
      '## Decisions', '', '### AD1: <scr<script>ipt>Choice', '', '**Status:** Active',
    ].join('\n');
    const result = runFixture({ 'documentation/decisions/README.md': fixture });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it('preserves literal comparisons and unmatched angle brackets in heading anchors', () => {
    const fixture = [
      '# Decisions', '', '## Decision Index', '',
      '| ID | Decision | Summary | Category | State |', '|---|---|---|---|---|',
      '| [AD1](#ad1-a--b--c) | Comparison | The fixture keeps this architecture choice explicit to preserve the behavior exercised by its paired ADR section. | Architecture | Active |',
      '| [AD2](#ad2-value--limit) | Unmatched comparison | The fixture keeps this architecture choice explicit to preserve the behavior exercised by its paired ADR section. | Architecture | Active |', '',
      '## Decisions', '', '### AD1: A < B > C', '', '**Status:** Active', '',
      '### AD2: Value < limit', '', '**Status:** Active',
    ].join('\n');
    const result = runFixture({ 'documentation/decisions/README.md': fixture });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it('reports independently malformed ADR links, indexes, and statuses', () => {
    const unlinkedId = [
      '# Decisions', '', '## Decision Index', '',
      '| ID | Decision | Summary | Category | State |', '|---|---|---|---|---|', '| AD1 | Choice | The fixture keeps this architecture choice explicit to preserve the behavior exercised by its paired ADR section. | Architecture | Active |', '',
      '## Decisions', '', '### AD1: Choice', '', '**Status:** Active',
    ].join('\n');
    assert.equal(JSON.parse(runFixture({ 'documentation/decisions/README.md': unlinkedId }).stdout).findings[0].rule, 'adr-index-id-not-linked');

    const missingIndex = [
      '# Decisions', '', '## Decision Index', '',
      '| ID | Decision | Summary | Category | State |', '|---|---|---|---|---|', '',
      '## Decisions', '', '### AD1: Choice', '', '**Status:** Active',
    ].join('\n');
    assert.equal(JSON.parse(runFixture({ 'documentation/decisions/README.md': missingIndex }).stdout).findings[0].rule, 'adr-section-index-missing');

    const missingStatus = [
      '# Decisions', '', '## Decision Index', '',
      '| ID | Decision | Summary | Category | State |', '|---|---|---|---|---|', '| [AD1](#ad1-choice) | Choice | The fixture keeps this architecture choice explicit to preserve the behavior exercised by its paired ADR section. | Architecture | Active |', '',
      '## Decisions', '', '### AD1: Choice', '', '**Context:** Decision context.',
    ].join('\n');
    assert.equal(JSON.parse(runFixture({ 'documentation/decisions/README.md': missingStatus }).stdout).findings[0].rule, 'adr-status-missing');
  });

  it('does not use later unrelated sections as superseded ADR history', () => {
    const fixture = [
      '# Decisions', '', '## Decision Index', '',
      '| ID | Decision | Summary | Category | State |', '|---|---|---|---|---|',
      '| ~~[AD1](#ad1-old)~~ | ~~Old — superseded by [AD2](#ad2-new)~~ | [AD2](#ad2-new) replaces the historical choice so current behavior has one authoritative architecture boundary. | Architecture | Superseded |', '',
      '## Decisions', '', '### AD1: Old', '', '**Status:** Superseded by [AD2](#ad2-new)', '',
      '## Appendix', '', '**Context:** Unrelated context.',
    ].join('\n');
    const result = runFixture({ 'documentation/decisions/README.md': fixture });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(JSON.parse(result.stdout).findings[0].rule, 'adr-superseded-history-missing');
  });

  it('keeps partial ADRs unstruck and requires a linked successor with clause detail', () => {
    const fixture = [
      '# Decisions', '', '## Decision Index', '',
      '| ID | Decision | Summary | Category | State |', '|---|---|---|---|---|',
      '| ~~[AD1](#ad1-active-remainder)~~ | ~~Active remainder~~ | The active mechanism remains in force while [AD2](#ad2-successor) replaces only the named clause. | Architecture | Partially superseded |', '',
      '## Decisions', '', '### AD1: Active remainder', '',
      '**Status:** Partially superseded by [AD2](#ad2-successor)',
    ].join('\n');
    const result = runFixture({ 'documentation/decisions/README.md': fixture });
    assert.equal(result.status, 1, result.stdout);
    assert.deepEqual(
      JSON.parse(result.stdout).findings.map(({ rule }) => rule).sort(),
      ['adr-partial-is-struck', 'adr-partial-successor-detail-missing'],
    );
  });

  it('independently requires partial clause detail and redirect destinations', () => {
    const partial = [
      '# Decisions', '', '## Decision Index', '',
      '| ID | Decision | Summary | Category | State |', '|---|---|---|---|---|',
      '| [AD1](#ad1-active-remainder) | Active remainder | The active mechanism remains in force while [AD2](#ad2-successor) replaces only the named clause. | Architecture | Partially superseded |', '',
      '## Decisions', '', '### AD1: Active remainder', '',
      '**Status:** Partially superseded by [AD2](#ad2-successor)',
    ].join('\n');
    const partialResult = runFixture({ 'documentation/decisions/README.md': partial });
    assert.equal(partialResult.status, 1, partialResult.stdout);
    assert.equal(JSON.parse(partialResult.stdout).findings[0].rule, 'adr-partial-successor-detail-missing');

    const redirect = [
      '# Decisions', '', '## Decision Index', '',
      '| ID | Decision | Summary | Category | State |', '|---|---|---|---|---|',
      '| [AD1](#ad1-redirect) | Reclassified decision | [Configuration](../lanes/configuration.md) now owns this rationale so the stable ADR identifier remains available for inbound history. | Architecture | Redirect anchor |', '',
      '## Decisions', '', '### AD1: Redirect', '', '**Status:** Reclassified into the configuration lane.',
    ].join('\n');
    const redirectResult = runFixture({ 'documentation/decisions/README.md': redirect });
    assert.equal(redirectResult.status, 1, redirectResult.stdout);
    assert.ok(
      JSON.parse(redirectResult.stdout).findings.some(({ rule }) => rule === 'adr-redirect-destination-not-linked'),
      redirectResult.stdout,
    );
  });

  it('requires linked AD references and rejects vague SDD labels in security source maps', () => {
    const fixture = [
      '# Security', '', '## Verification and Source Map', '',
      '| Control family | Requirements / decisions | Implementation | Evidence |',
      '|---|---|---|---|',
      '| Encryption | REQ-SEC-005, CON-SEC-001, AD32 | crypto | tests |',
      '| Supply chain | Operations SDD | workflows | CI |',
    ].join('\n');
    const result = runFixture({ 'security.md': fixture });
    assert.equal(result.status, 1, result.stdout);
    assert.deepEqual(
      JSON.parse(result.stdout).findings.map(({ rule }) => rule).sort(),
      ['security-source-map-ad-not-linked', 'security-source-map-requirement-not-linked', 'security-source-map-requirement-not-linked', 'security-source-map-vague-reference'],
    );

    const corrected = fixture
      .replace('REQ-SEC-005', '[REQ-SEC-005](../../sdd/spec/security.md#req-sec-005-encryption)')
      .replace('CON-SEC-001', '[CON-SEC-001](../../sdd/spec/security.md#con-sec-001-boundary)')
      .replace('AD32', '[AD32](../decisions/README.md#ad32-encryption-key-is-optional)')
      .replace('Operations SDD', '[Operations requirements](../../sdd/spec/operations.md)');
    const accepted = runFixture({
      'documentation/lanes/security.md': corrected,
      'documentation/decisions/README.md': '# Decisions\n\n## Decision Index\n\n| ID | Decision | Summary | Category | State |\n|---|---|---|---|---|\n| [AD32](#ad32-encryption-key-is-optional) | Allow an optional encryption key | Deployments may omit the encryption key to simplify self-hosted setup while accepting plaintext credential storage. | Security | Active |\n\n## Decisions\n\n### AD32: Encryption Key Is Optional\n\n**Status:** Active\n',
      'sdd/spec/security.md': '# Security\n\n### REQ-SEC-005: Encryption\n\n### CON-SEC-001: Boundary\n',
      'sdd/spec/operations.md': '# Operations Requirements\n',
    });
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
  });

  it('rejects Security source-map links with wrong files or anchors', () => {
    const fixture = [
      '# Security', '', '## Verification and Source Map', '',
      '| Control family | Requirements / decisions | Implementation | Evidence |',
      '|---|---|---|---|',
      '| Encryption | [REQ-SEC-005](../../sdd/spec/other.md#req-sec-005-encryption), [AD32](../decisions/README.md#wrong-anchor), [Operations requirements](../../sdd/spec/other.md) | crypto | tests |',
    ].join('\n');
    const result = runFixture({
      'documentation/lanes/security.md': fixture,
      'documentation/decisions/README.md': '# Decisions\n\n## Decision Index\n\n| ID | Decision | Summary | Category | State |\n|---|---|---|---|---|\n| [AD32](#ad32-encryption-key-is-optional) | Allow an optional encryption key | Deployments may omit the encryption key to simplify self-hosted setup while accepting plaintext credential storage. | Security | Active |\n\n## Decisions\n\n### AD32: Encryption Key Is Optional\n\n**Status:** Active\n',
      'sdd/spec/other.md': '# Other\n\n### REQ-OTHER-001: Other\n',
    });
    assert.equal(result.status, 1, result.stdout);
    assert.deepEqual(
      JSON.parse(result.stdout).findings.map(({ rule }) => rule),
      ['security-source-map-reference-target-invalid', 'security-source-map-reference-target-invalid', 'security-source-map-reference-target-invalid'],
    );
  });
});
