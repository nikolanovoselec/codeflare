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

function runFixture(files, { inventory = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'doc-shape-'));
  try {
    const paths = Object.entries(files).map(([name, content]) => {
      const path = join(cwd, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return path;
    });
    return spawnSync(process.execPath, [CHECKER, ...(inventory ? ['--inventory'] : []), ...paths], {
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

function inventoryFixture() {
  const architecture = [
    '# Architecture',
    '',
    '## System Components',
    '',
    ...[
      'Worker',
      'Container DO',
      'LlmInterceptor',
      'EgressController',
      'CloudflareBrowserInterceptor',
      'GitHub Integration',
      'Terminal Server',
      'Landing',
    ].flatMap((name) => [`### ${name}`, '', ...fields.architecture, '']),
  ].join('\n');

  const troubleshooting = [
    '# Troubleshooting',
    '',
    '## Common Issues',
    '',
    ...[
      '/api/* Returns HTML',
      '/setup Shows Access Denied',
      'Auth Error After Access Login',
      'HTTP 500 After Login',
      'Access Application Not Found',
      'Container Stuck Waiting for Services',
      'Secrets Lost After Worker Deletion',
      'Chrome in CI',
    ].flatMap((name) => [`### ${name}`, '', ...fields.troubleshooting, '']),
  ].join('\n');

  const api = [
    '# API Reference',
    '',
    '## Preferences',
    '',
    '| Method | Path | Auth | Implements | Description |',
    '|---|---|---|---|---|',
    '| GET | `/api/preferences` | Session cookie | REQ-MEM-011 | Read preferences |',
    '| PATCH | `/api/preferences` | Session cookie | REQ-MEM-011 | Update preferences |',
    '',
    '## LLM API Keys',
    '',
    '| Method | Path | Auth | Implements | Description |',
    '|---|---|---|---|---|',
    '| GET | `/api/llm-keys` | Session cookie | REQ-AGENT-009 | Read masked keys |',
    '| PUT | `/api/llm-keys` | Session cookie | REQ-AGENT-009 | Update keys |',
    '| DELETE | `/api/llm-keys` | Session cookie | REQ-AGENT-009 | Delete keys |',
  ].join('\n');

  return {
    'documentation/lanes/architecture.md': architecture,
    'documentation/lanes/troubleshooting.md': troubleshooting,
    'documentation/lanes/api-reference.md': api,
  };
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

  it('fails when any one of the exact 21 inventory items disappears', () => {
    const complete = inventoryFixture();
    const baseline = runFixture(complete, { inventory: true });
    assert.equal(baseline.status, 0, `${baseline.stdout}\n${baseline.stderr}`);

    const identities = [
      ['architecture.md', '### Worker'],
      ['architecture.md', '### Container DO'],
      ['architecture.md', '### LlmInterceptor'],
      ['architecture.md', '### EgressController'],
      ['architecture.md', '### CloudflareBrowserInterceptor'],
      ['architecture.md', '### GitHub Integration'],
      ['architecture.md', '### Terminal Server'],
      ['architecture.md', '### Landing'],
      ['troubleshooting.md', '### /api/* Returns HTML'],
      ['troubleshooting.md', '### /setup Shows Access Denied'],
      ['troubleshooting.md', '### Auth Error After Access Login'],
      ['troubleshooting.md', '### HTTP 500 After Login'],
      ['troubleshooting.md', '### Access Application Not Found'],
      ['troubleshooting.md', '### Container Stuck Waiting for Services'],
      ['troubleshooting.md', '### Secrets Lost After Worker Deletion'],
      ['troubleshooting.md', '### Chrome in CI'],
      ['api-reference.md', '| GET | `/api/preferences`'],
      ['api-reference.md', '| PATCH | `/api/preferences`'],
      ['api-reference.md', '| GET | `/api/llm-keys`'],
      ['api-reference.md', '| PUT | `/api/llm-keys`'],
      ['api-reference.md', '| DELETE | `/api/llm-keys`'],
    ];

    for (const [basename, identity] of identities) {
      const entry = Object.entries(complete).find(([path]) => path.endsWith(basename));
      assert.ok(entry, basename);
      const [path, content] = entry;
      const regressed = {
        ...complete,
        [path]: content.replace(identity, identity.replace(/Worker|Container DO|LlmInterceptor|EgressController|CloudflareBrowserInterceptor|GitHub Integration|Terminal Server|Landing|\/api\/\* Returns HTML|\/setup Shows Access Denied|Auth Error After Access Login|HTTP 500 After Login|Access Application Not Found|Container Stuck Waiting for Services|Secrets Lost After Worker Deletion|Chrome in CI|GET|PATCH|PUT|DELETE/, 'Removed')),
      };
      const result = runFixture(regressed, { inventory: true });
      assert.equal(result.status, 1, `expected inventory regression for ${identity}`);
      assert.match(result.stdout, /inventory-item-missing/);
    }
  });

  it('accepts the repository exact inventory', () => {
    const result = spawnSync(process.execPath, [
      CHECKER,
      '--inventory',
      join(ROOT, 'documentation/lanes/architecture.md'),
      join(ROOT, 'documentation/lanes/troubleshooting.md'),
      join(ROOT, 'documentation/lanes/api-reference.md'),
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});
