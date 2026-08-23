import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseGeneratedSeed } from '../../scripts/materialize-agent-seed.mjs';
import {
  PI_PROMPT_BASELINE_CHARS,
  PI_PROMPT_MAX_CHARS,
  measurePiPromptBudget,
  validatePiPromptBaseline,
  validatePiPromptRuleLedger,
} from '../../scripts/pi-prompt-contract.mjs';
import {
  serializePiToolSchemas,
  verifyPiProjection,
} from '../../scripts/verify-pi-prompt.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/pi-prompt-baseline.json', import.meta.url));
const ledgerPath = fileURLToPath(new URL('../../scripts/pi-prompt-rule-ledger.json', import.meta.url));
const generatedPath = fileURLToPath(new URL('../../src/lib/agent-seed.generated.ts', import.meta.url));
const piPackageRoot = fileURLToPath(new URL(
  '../../preseed/agents/pi/node_modules/@earendil-works/pi-coding-agent',
  import.meta.url,
));
const piNodeModules = fileURLToPath(new URL('../../preseed/agents/pi/node_modules', import.meta.url));
const piPackageJson = fileURLToPath(new URL('../../preseed/agents/pi/package.json', import.meta.url));
const temporaryRoots = [];

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('REQ-AGENT-156: bounded lossless Pi prompt', () => {
  it('pins the measured provider-boundary baseline and keeps tool schemas outside it', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    assert.deepEqual(validatePiPromptBaseline(fixture), {
      totalChars: PI_PROMPT_BASELINE_CHARS,
      componentTotal: PI_PROMPT_BASELINE_CHARS,
    });
    assert.equal(fixture.target.maxPromptChars, PI_PROMPT_MAX_CHARS);
    assert.ok(
      ((fixture.totalChars - fixture.target.maxPromptChars) / fixture.totalChars) * 100 >=
        fixture.target.minimumReductionPercent,
    );
  });

  it('enforces the 14,000-character boundary independently of serialized tool schemas', () => {
    const atLimit = measurePiPromptBudget({
      controlledPrompt: 'p'.repeat(PI_PROMPT_MAX_CHARS),
      additiveProjectContext: 'x'.repeat(75_000),
      serializedToolSchemas: 's'.repeat(50_000),
    });
    assert.equal(atLimit.withinPromptBudget, true);
    assert.equal(atLimit.promptChars, PI_PROMPT_MAX_CHARS);
    assert.equal(atLimit.projectContextChars, 75_000);
    assert.equal(atLimit.toolSchemaChars, 50_000);

    const overLimit = measurePiPromptBudget({
      controlledPrompt: 'p'.repeat(PI_PROMPT_MAX_CHARS + 1),
      additiveProjectContext: '',
      serializedToolSchemas: '',
    });
    assert.equal(overLimit.withinPromptBudget, false);
    assert.equal(overLimit.promptChars, PI_PROMPT_MAX_CHARS + 1);
  });

  it('maps every baseline controlled surface category to one retained owner and destination', () => {
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    const result = validatePiPromptRuleLedger(ledger);
    assert.equal(result.entryCount, ledger.entries.length);
    assert.equal(result.ids.size, ledger.entries.length);
    assert.deepEqual(new Set(ledger.sourceCoverage.globalAgentsHeadings), new Set([
      'Environment and code',
      'Four mandates',
      'Scope and autonomy',
      'Review and CI gates',
      'Work continuity',
      'Task tracking',
      'Git Workflow',
      'Mandatory boundary stop',
      'No pre-push reviewers',
      'Execute one boundary plan',
      'Hard obligations',
    ]));
    assert.equal(ledger.sourceCoverage.visibleSkillCatalog.baselineEntries, 61);
  });

  it('reports registered extension tool schemas separately from the controlled prompt', () => {
    const serialized = serializePiToolSchemas({
      builtInTools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }],
      extensionTools: [
        { name: 'capability', description: 'Load tools', parameters: { type: 'object' } },
        { name: 'subagent', description: 'Delegate', parameters: { type: 'object' } },
      ],
    });
    assert.deepEqual(
      JSON.parse(serialized).map(({ name }) => name),
      ['capability', 'read', 'subagent'],
    );
  });

  it('keeps real default and advanced resource-loader projections inside the prompt boundary', async () => {
    assert.equal(existsSync(piPackageRoot), true, 'CI must install the exact Pi prompt runtime');
    const runtimeAgentDir = await mkdtemp(join(tmpdir(), 'pi-runtime-'));
    temporaryRoots.push(runtimeAgentDir);
    await mkdir(join(runtimeAgentDir, 'npm'));
    await symlink(piNodeModules, join(runtimeAgentDir, 'npm', 'node_modules'), 'dir');
    const piDependencies = JSON.parse(readFileSync(piPackageJson, 'utf8')).dependencies;
    const packages = Object.entries(piDependencies).map(([name, version]) => (
      name === 'context-mode' ? { source: `npm:${name}@${version}`, extensions: [] } : `npm:${name}@${version}`
    ));
    await writeFile(join(runtimeAgentDir, 'settings.json'), JSON.stringify({ packages }));
    const documents = parseGeneratedSeed(readFileSync(generatedPath, 'utf8'));

    for (const mode of ['default', 'advanced']) {
      const report = await verifyPiProjection({ documents, mode, runtimeAgentDir, piPackageRoot });
      assert.equal(report.withinPromptBudget, true, `${mode} prompt uses ${report.promptChars} characters`);
      assert.ok(report.toolSchemaChars > 0, `${mode} registered tool schemas must be reported`);
    }
  });

  it('seeds one SYSTEM and AGENTS prompt input for both public Pi modes', () => {
    const documents = parseGeneratedSeed(readFileSync(generatedPath, 'utf8'));
    for (const mode of ['default', 'advanced']) {
      const system = documents.filter(
        (doc) => doc.key === '.pi/agent/SYSTEM.md' && doc.modes.includes(mode),
      );
      const agents = documents.filter(
        (doc) => doc.key === '.pi/agent/AGENTS.md' && doc.modes.includes(mode),
      );
      assert.equal(system.length, 1, `${mode} must have one Codeflare-owned SYSTEM.md`);
      assert.equal(agents.length, 1, `${mode} must have one Codeflare-owned AGENTS.md`);
    }
  });
});
