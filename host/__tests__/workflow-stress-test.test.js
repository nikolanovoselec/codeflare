// Structural audit of .github/workflows/stress-test.yml and
// production source files for REQ-OPS-008 (stress testing validates
// rate limits and concurrency).
//
// ACs 1-3 are workflow-file presence audits: grep the YAML for canonical
// step names, job definitions, and env-var patterns.
// ACs 4-6 are source-file audits: grep src/middleware/rate-limit.ts and
// src/index.ts for the bypass logic, the one-time warning, and the
// SAAS_MODE conflict guard.
// Gut-check: deleting the STRESS_TEST_MODE branch in rate-limit.ts or
// the 503 guard in index.ts causes the relevant assertions to fail.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const workflow = readFileSync(resolve(repoRoot, '.github/workflows/stress-test.yml'), 'utf8');
const rateLimitSrc = readFileSync(resolve(repoRoot, 'src/middleware/rate-limit.ts'), 'utf8');
const indexSrc = readFileSync(resolve(repoRoot, 'src/index.ts'), 'utf8');

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

  it('REQ-OPS-008 AC4: when STRESS_TEST_MODE=active, HTTP rate limits are bypassed in rate-limit middleware', () => {
    assert.ok(
      rateLimitSrc.includes("c.env.STRESS_TEST_MODE === 'active'"),
      "src/middleware/rate-limit.ts must check c.env.STRESS_TEST_MODE === 'active' to bypass rate limits"
    );
    // The bypass must short-circuit by calling next() before any KV check
    const bypassIdx = rateLimitSrc.indexOf("c.env.STRESS_TEST_MODE === 'active'");
    const nextIdx = rateLimitSrc.indexOf('return next()', bypassIdx);
    const kvIdx = rateLimitSrc.indexOf('c.env.KV', bypassIdx);
    assert.ok(nextIdx !== -1, 'rate-limit middleware must call return next() inside the STRESS_TEST_MODE bypass branch');
    assert.ok(
      nextIdx < kvIdx,
      'STRESS_TEST_MODE bypass must short-circuit before any KV rate-limit check'
    );
  });

  it('REQ-OPS-008 AC5: a one-time warning is logged per isolate when the rate limit bypass activates', () => {
    // stressTestWarningLogged flag guards a single logger.warn call
    assert.ok(
      rateLimitSrc.includes('stressTestWarningLogged'),
      'src/middleware/rate-limit.ts must use a stressTestWarningLogged flag for the one-time warning'
    );
    assert.ok(
      rateLimitSrc.includes('STRESS_TEST_MODE is active') && rateLimitSrc.includes('rate limits bypassed'),
      'src/middleware/rate-limit.ts must log a warning mentioning STRESS_TEST_MODE and rate limits bypassed'
    );
    assert.ok(
      rateLimitSrc.includes('stressTestWarningLogged = true'),
      'src/middleware/rate-limit.ts must set stressTestWarningLogged = true after the first warning'
    );
  });

  it('REQ-OPS-008 AC6: STRESS_TEST_MODE must not be active alongside SAAS_MODE (global middleware returns 503)', () => {
    assert.ok(
      indexSrc.includes("SAAS_MODE === 'active' && c.env.STRESS_TEST_MODE === 'active'") ||
      indexSrc.includes("c.env.SAAS_MODE === 'active' && c.env.STRESS_TEST_MODE === 'active'"),
      'src/index.ts global middleware must check for SAAS_MODE + STRESS_TEST_MODE conflict'
    );
    // Must return 503 for this conflict
    const conflictIdx = indexSrc.indexOf("STRESS_TEST_MODE === 'active'");
    const block503 = indexSrc.slice(conflictIdx, conflictIdx + 300);
    assert.ok(
      block503.includes('503'),
      'src/index.ts must return HTTP 503 when SAAS_MODE and STRESS_TEST_MODE are both active'
    );
    assert.ok(
      block503.includes('Misconfiguration') || block503.includes('stress test mode'),
      'src/index.ts 503 response must identify the misconfiguration'
    );
  });
});
