// Structural audit of .github/workflows/deploy.yml for REQ-OPS-012
// (Per-environment container concurrency limit).
//
// The deploy workflow patches wrangler.toml at deploy time with the resolved
// max_instances value. These tests verify that the patching logic, the
// MAX_INSTANCES override path, the positive-integer validation, and the
// RESSOURCE_TIER independence are all present in the workflow file.
//
// Gut-check: removing the MAX_INSTANCES_OVERRIDE block or the positive-integer
// regex from deploy.yml causes the relevant test to fail immediately.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/deploy.yml'), 'utf8');

// ---------------------------------------------------------------------------
// REQ-OPS-012: Per-environment container concurrency limit
// ---------------------------------------------------------------------------

describe('REQ-OPS-012: Per-environment container concurrency limit', () => {
  it('REQ-OPS-012 AC1: MAX_INSTANCES GitHub Actions variable overrides the default 10 max instances', () => {
    assert.ok(
      workflow.includes('MAX_INSTANCES_OVERRIDE: ${{ vars.MAX_INSTANCES }}'),
      'deploy.yml must expose vars.MAX_INSTANCES as MAX_INSTANCES_OVERRIDE env var'
    );
    assert.ok(
      workflow.includes('MAX_INSTANCES=10'),
      'deploy.yml must default MAX_INSTANCES to 10 when the override is not set'
    );
    // The override must be applied when the variable is non-empty
    assert.ok(
      workflow.includes('MAX_INSTANCES="$MAX_INSTANCES_OVERRIDE"'),
      'deploy.yml must apply MAX_INSTANCES_OVERRIDE when it is set'
    );
  });

  it('REQ-OPS-012 AC2: MAX_INSTANCES override is independent of RESSOURCE_TIER', () => {
    // The override block must come AFTER the TIER case statement, not inside any specific branch
    const tierCaseIdx = workflow.indexOf('case "$TIER"');
    const esacIdx = workflow.indexOf('esac', tierCaseIdx);
    const overrideIdx = workflow.indexOf('MAX_INSTANCES_OVERRIDE');

    assert.ok(tierCaseIdx !== -1, 'deploy.yml must contain a case "$TIER" block');
    assert.ok(esacIdx !== -1, 'deploy.yml case block must end with esac');
    assert.ok(overrideIdx !== -1, 'deploy.yml must contain MAX_INSTANCES_OVERRIDE');

    // The override application (MAX_INSTANCES="$MAX_INSTANCES_OVERRIDE") must be
    // outside the tier case block - i.e. after the esac keyword
    const applyIdx = workflow.indexOf('MAX_INSTANCES="$MAX_INSTANCES_OVERRIDE"');
    assert.ok(
      applyIdx > esacIdx,
      'deploy.yml MAX_INSTANCES override must be applied after the RESSOURCE_TIER case block (independent of tier)'
    );
  });

  it('REQ-OPS-012 AC3: MAX_INSTANCES must be a positive integer (enforced with regex validation)', () => {
    // The workflow must validate that the override value matches [1-9][0-9]*
    assert.ok(
      workflow.includes("grep -qE '^[1-9][0-9]*$'"),
      "deploy.yml must validate MAX_INSTANCES with regex '^[1-9][0-9]*$' (positive integer)"
    );
    assert.ok(
      workflow.includes('MAX_INSTANCES must be a positive integer'),
      'deploy.yml must emit an error message when MAX_INSTANCES is not a positive integer'
    );
  });

  it('REQ-OPS-012 AC4: MAX_INSTANCES is applied during deploy via wrangler.toml patching', () => {
    // The awk script that patches max_instances in wrangler.toml must reference
    // the resolved max_instances variable
    assert.ok(
      workflow.includes('max_instances = ') || workflow.includes('max_instances ='),
      'deploy.yml must patch the max_instances field in wrangler.toml'
    );
    assert.ok(
      workflow.includes('wrangler.toml'),
      'deploy.yml must reference wrangler.toml as the target for max_instances patching'
    );
    // The awk script must write max_instances with the resolved value
    assert.ok(
      workflow.includes('-v max_instances=') || workflow.includes('max_instances = " max_instances'),
      'deploy.yml awk script must substitute the resolved max_instances value into wrangler.toml'
    );
  });
});
