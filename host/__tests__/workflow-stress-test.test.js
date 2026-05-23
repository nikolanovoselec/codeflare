// Structural audit of .github/workflows/stress-test.yml for REQ-OPS-008
// AC1-AC3 (workflow shape: trigger, suite jobs, concurrency var).
//
// AC4 (rate-limit bypass when STRESS_TEST_MODE=active),
// AC5 (one-time warning per isolate) and
// AC6 (SAAS_MODE + STRESS_TEST_MODE conflict guard returns 503)
// are exercised by REAL behavioural tests, not by reading source files:
//   - AC4 + AC5 -> src/__tests__/middleware/rate-limit.test.ts
//   - AC6      -> src/__tests__/index.test.ts (worker.fetch with both env vars)
// This file owns ONLY the workflow-YAML structural checks; source-grep
// theater for the rate-limit/index source was removed because it can be
// gutted without failing (tdd-enforce antipattern #1).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const workflow = readFileSync(resolve(repoRoot, '.github/workflows/stress-test.yml'), 'utf8');

// ---------------------------------------------------------------------------
// REQ-OPS-008: Stress testing validates rate limits and concurrency
// ---------------------------------------------------------------------------

describe('REQ-OPS-008: Stress testing validates rate limits and concurrency', () => {
  it('REQ-OPS-008 AC1: stress-test workflow triggers on workflow_dispatch targeting the integration environment', () => {
    assert.ok(
      workflow.includes('workflow_dispatch:'),
      'stress-test.yml must declare a workflow_dispatch trigger'
    );
    assert.ok(
      workflow.includes("environment: integration"),
      'stress-test.yml must target the integration environment'
    );
  });

  it('REQ-OPS-008 AC2: k6 stress tests cover API throughput, session lifecycle, storage operations, and rate-limit validation', () => {
    // Workflow jobs must exist for each suite
    assert.ok(
      workflow.includes('api-throughput:') || workflow.includes('api-throughput'),
      'stress-test.yml must include an api-throughput test job'
    );
    assert.ok(
      workflow.includes('session-lifecycle'),
      'stress-test.yml must include a session-lifecycle test job'
    );
    assert.ok(
      workflow.includes('storage-operations'),
      'stress-test.yml must include a storage-operations test job'
    );
    assert.ok(
      workflow.includes('rate-limit-validation'),
      'stress-test.yml must include a rate-limit-validation test job'
    );

    // k6 script files must be referenced for each suite
    assert.ok(
      workflow.includes('e2e/stress/api-throughput.js'),
      'stress-test.yml must run e2e/stress/api-throughput.js'
    );
    assert.ok(
      workflow.includes('e2e/stress/session-lifecycle.js'),
      'stress-test.yml must run e2e/stress/session-lifecycle.js'
    );
    assert.ok(
      workflow.includes('e2e/stress/storage-operations.js'),
      'stress-test.yml must run e2e/stress/storage-operations.js'
    );
  });

  it('REQ-OPS-008 AC3: STRESS_TEST_CONCURRENCY variable (default 0) is passed to k6 jobs', () => {
    assert.ok(
      workflow.includes('STRESS_TEST_CONCURRENCY'),
      'stress-test.yml must pass the STRESS_TEST_CONCURRENCY variable to k6 jobs'
    );
    // Default of 0 (disabled) must be encoded as the fallback
    assert.ok(
      workflow.includes("STRESS_TEST_CONCURRENCY: ${{ vars.STRESS_TEST_CONCURRENCY || '0' }}"),
      "stress-test.yml must default STRESS_TEST_CONCURRENCY to '0' when vars.STRESS_TEST_CONCURRENCY is unset"
    );
  });

  // AC4, AC5, AC6 are NOT asserted here — they are behavioural and live in:
  //   src/__tests__/middleware/rate-limit.test.ts (stress test mode bypass +
  //     REQ-OPS-008 AC5 one-time-warning describe)
  //   src/__tests__/index.test.ts (REQ-OPS-008 AC6 SAAS_MODE+STRESS_TEST_MODE
  //     conflict guard describe)
  // Asserting them via source-grep here would be text-matching theater:
  // deleting the production branch could still leave the searched substrings
  // (e.g. in a comment) and the test would stay green.
});
