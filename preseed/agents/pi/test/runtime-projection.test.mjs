import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { validateInitialToolExposure } from '../../../../scripts/measure-pi-runtime-context.mjs';

const reportRoot = process.env.CODEFLARE_PI_REPORT_ROOT;

function report(name) {
  assert.ok(reportRoot, 'CODEFLARE_PI_REPORT_ROOT is required');
  return JSON.parse(readFileSync(join(reportRoot, name), 'utf8'));
}

describe('real Pi runtime projection', () => {
  it('REQ-AGENT-156 AC2: keeps default and advanced projections inside the prompt boundary', () => {
    const projection = report('pi-prompt-report.json');
    assert.deepEqual(projection.reports.map(({ mode }) => mode), ['default', 'advanced']);
    for (const mode of projection.reports) {
      assert.equal(mode.withinPromptBudget, true, `${mode.mode} prompt exceeds its boundary`);
      assert.ok(mode.promptChars <= 14_000, `${mode.mode} prompt uses ${mode.promptChars} characters`);
      assert.ok(mode.toolSchemaChars > mode.activeToolSchemaChars, `${mode.mode} must keep optional schemas inactive`);
    }
  });

  it('REQ-AGENT-158 AC6: validates real default and advanced initial tool exposure', () => {
    for (const mode of ['default', 'advanced']) {
      const diagnostics = report(`pi-runtime-context-${mode}.json`);
      assert.doesNotThrow(() => validateInitialToolExposure(diagnostics));
      assert.ok(Number.isFinite(diagnostics.inputTokens) && diagnostics.inputTokens > 0);
      assert.ok(diagnostics.registeredToolSchemaChars > diagnostics.activeToolSchemaChars);
    }
  });
});
