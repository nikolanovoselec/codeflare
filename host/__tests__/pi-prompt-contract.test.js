import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseGeneratedSeed } from '../../scripts/materialize-agent-seed.mjs';
import {
  PI_PROMPT_BASELINE_CHARS,
  PI_PROMPT_MAX_CHARS,
  measurePiPromptBudget,
  validatePiPromptBaseline,
  validatePiPromptRuleLedger,
} from '../../scripts/pi-prompt-contract.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/pi-prompt-baseline.json', import.meta.url));
const ledgerPath = fileURLToPath(new URL('../../documentation/decisions/pi-prompt-rule-ledger.json', import.meta.url));
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
