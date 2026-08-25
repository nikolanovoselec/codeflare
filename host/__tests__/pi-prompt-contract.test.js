import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseGeneratedSeed } from '../../scripts/materialize-agent-seed.mjs';
import { validateInitialToolExposure } from '../../scripts/measure-pi-runtime-context.mjs';
import {
  PI_PROMPT_BASELINE_CHARS,
  PI_PROMPT_MAX_CHARS,
  measurePiPromptBudget,
  validatePiPromptBaseline,
  validatePiPromptRuleLedger,
} from '../../scripts/pi-prompt-contract.mjs';
import {
  serializePiToolSchemas,
  serializeSelectedPiToolSchemas,
} from '../../scripts/verify-pi-prompt.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/pi-prompt-baseline.json', import.meta.url));
const ledgerPath = fileURLToPath(new URL('../../scripts/pi-prompt-rule-ledger.json', import.meta.url));
const generatedPath = fileURLToPath(new URL('../../src/lib/agent-seed.generated.ts', import.meta.url));
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
    assert.equal(Object.hasOwn(ledger.ownership, 'sharedFlow'), false);
    assert.ok(ledger.ownership['codeflare-curation'].includes('complete managed policy inventory'));
    assert.ok(ledger.ownership['codeflare-curation'].includes('shared manifest-owned fallback synchronization'));

    const missingCurationOwnership = structuredClone(ledger);
    missingCurationOwnership.ownership['codeflare-curation'] = [];
    assert.throws(
      () => validatePiPromptRuleLedger(missingCurationOwnership),
      /complete managed policy inventory/,
    );

    const missingSharedSynchronization = structuredClone(ledger);
    missingSharedSynchronization.ownership['codeflare-curation'] =
      missingSharedSynchronization.ownership['codeflare-curation']
        .filter((item) => item !== 'shared manifest-owned fallback synchronization');
    assert.throws(
      () => validatePiPromptRuleLedger(missingSharedSynchronization),
      /shared manifest-owned fallback synchronization/,
    );

    const legacySharedFlow = structuredClone(ledger);
    legacySharedFlow.ownership.sharedFlow = 'codeflare-deployment-to-curation';
    assert.throws(
      () => validatePiPromptRuleLedger(legacySharedFlow),
      /must not declare shared-preseed policy flow/,
    );
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
      builtInTools: [
        { name: 'capability', description: 'Built-in placeholder', parameters: { type: 'object' } },
        { name: 'read', description: 'Read', parameters: { type: 'object' } },
      ],
      extensionTools: [
        { name: 'capability', description: 'Load tools', parameters: { type: 'object' } },
        { name: 'capability', description: 'Ignored duplicate', parameters: { type: 'null' } },
        { name: 'subagent', description: 'Delegate', parameters: { type: 'object' } },
      ],
    });
    const schemas = JSON.parse(serialized);
    assert.deepEqual(schemas.map(({ name }) => name), ['capability', 'read', 'subagent']);
    assert.deepEqual(schemas.find(({ name }) => name === 'capability'), {
      name: 'capability',
      description: 'Load tools',
      parameters: { type: 'object' },
    });
    assert.deepEqual(JSON.parse(serializeSelectedPiToolSchemas({
      builtInTools: [
        { name: 'read', description: 'Read', parameters: { type: 'object' } },
      ],
      extensionTools: [
        { name: 'capability', description: 'Load tools', parameters: { type: 'object' } },
        { name: 'subagent', description: 'Delegate', parameters: { type: 'object' } },
      ],
    }, ['read', 'capability'])).map(({ name }) => name), ['capability', 'read']);
  });

  it('REQ-AGENT-158 AC6: rejects invalid real initial tool exposure without a token threshold', () => {
    const valid = {
      activeToolNames: ['read', 'bash', 'edit', 'write', 'capability'],
      registeredToolNames: ['read', 'bash', 'edit', 'write', 'capability', 'subagent'],
    };
    assert.doesNotThrow(() => validateInitialToolExposure(valid));
    assert.throws(
      () => validateInitialToolExposure({ ...valid, activeToolNames: [...valid.activeToolNames, 'subagent'] }),
      /initial active tools must be read, bash, edit, write, capability/,
    );
    assert.throws(
      () => validateInitialToolExposure({ ...valid, registeredToolNames: valid.activeToolNames }),
      /registered optional tools must remain inactive/,
    );
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
