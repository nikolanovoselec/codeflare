// Structural audit of .github/workflows/e2e.yml for
// REQ-OPS-004 (E2E workflow setup and job graph) and
// REQ-OPS-015 (E2E per-suite execution and artifact handling).
//
// These are workflow-file presence audits. The YAML file is parsed to verify
// that the job graph, environment variables, and artifact configuration match
// the AC contract. No container is booted; the CI job itself is the runtime
// proof. Breaking any assertion here means the workflow no longer implements
// the AC it was built for.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const raw = readFileSync(resolve(repoRoot, '.github/workflows/e2e.yml'), 'utf8');

// ---------------------------------------------------------------------------
// REQ-OPS-004: E2E test workflow setup and job graph
// ---------------------------------------------------------------------------

describe('REQ-OPS-004: E2E test workflow setup and job graph', () => {
  it('REQ-OPS-004 AC1: workflow triggers on workflow_dispatch with environment selection (integration or production)', () => {
    assert.ok(
      raw.includes('workflow_dispatch:'),
      'e2e.yml must declare a workflow_dispatch trigger'
    );
    // The environment input must offer both options
    assert.ok(
      raw.includes('- integration'),
      'e2e.yml workflow_dispatch input must include "integration" as an option'
    );
    assert.ok(
      raw.includes('- production'),
      'e2e.yml workflow_dispatch input must include "production" as an option'
    );
  });

  it('REQ-OPS-004 AC2: four sequential jobs with dependency chain setup -> e2e-api -> e2e-ui-desktop -> e2e-ui-mobile', () => {
    // Job declarations must exist
    assert.ok(raw.includes('e2e-api:'), 'e2e.yml must declare job e2e-api');
    assert.ok(raw.includes('e2e-ui-desktop:'), 'e2e.yml must declare job e2e-ui-desktop');
    assert.ok(raw.includes('e2e-ui-mobile:'), 'e2e.yml must declare job e2e-ui-mobile');

    // e2e-api needs setup
    const apiNeedsSetup = /e2e-api:[\s\S]{0,200}needs:\s*(setup|\[setup)/.test(raw);
    assert.ok(apiNeedsSetup, 'e2e-api job must declare needs: setup');

    // e2e-ui-desktop needs both setup and e2e-api
    const desktopNeedsBoth = /e2e-ui-desktop:[\s\S]{0,300}needs:[\s\S]{0,100}e2e-api/.test(raw);
    assert.ok(desktopNeedsBoth, 'e2e-ui-desktop job must declare needs including e2e-api');

    // e2e-ui-mobile needs e2e-ui-desktop (and transitively e2e-api)
    const mobileNeedsDesktop = /e2e-ui-mobile:[\s\S]{0,300}needs:[\s\S]{0,100}e2e-ui-desktop/.test(raw);
    assert.ok(mobileNeedsDesktop, 'e2e-ui-mobile job must declare needs including e2e-ui-desktop');
  });

  it('REQ-OPS-004 AC3: setup job sets SERVICE_AUTH_SECRET, seeds E2E service user in KV, smoke-tests auth with retry loop', () => {
    // SERVICE_AUTH_SECRET set on target worker
    assert.ok(
      raw.includes('SERVICE_AUTH_SECRET'),
      'e2e.yml setup job must reference SERVICE_AUTH_SECRET'
    );
    assert.ok(
      raw.includes('wrangler secret put SERVICE_AUTH_SECRET'),
      'e2e.yml setup job must call `wrangler secret put SERVICE_AUTH_SECRET`'
    );

    // KV seeding for E2E service user
    assert.ok(
      raw.includes('e2e-service@codeflare.local'),
      'e2e.yml setup job must seed the E2E service user e2e-service@codeflare.local in KV'
    );
    assert.ok(
      raw.includes('wrangler kv key put'),
      'e2e.yml setup job must call `wrangler kv key put` to seed the KV user'
    );

    // Retry loop for KV eventual consistency (~60s)
    assert.ok(
      /for i in \d[\d ]*;/.test(raw),
      'e2e.yml setup job must contain a retry loop for KV eventual consistency'
    );
    assert.ok(
      raw.includes('sleep 15'),
      'e2e.yml setup job retry loop must sleep between auth attempts'
    );
  });

  it('REQ-OPS-004 AC4: E2E_BASE_URL variable is set per environment to target the correct deployed worker', () => {
    assert.ok(
      raw.includes('E2E_BASE_URL'),
      'e2e.yml must reference E2E_BASE_URL to target the deployed worker'
    );
    // It should be passed through job env from the setup outputs or vars
    assert.ok(
      raw.includes('vars.E2E_BASE_URL') || raw.includes('needs.setup.outputs.base_url'),
      'e2e.yml must set E2E_BASE_URL from either vars.E2E_BASE_URL or needs.setup.outputs.base_url'
    );
  });
});

// ---------------------------------------------------------------------------
// REQ-OPS-015: E2E per-suite execution and artifact handling
// ---------------------------------------------------------------------------

describe('REQ-OPS-015: E2E per-suite execution and artifact handling', () => {
  it('REQ-OPS-015 AC1: e2e-api job runs the API test suite', () => {
    assert.ok(
      raw.includes('npm run test:e2e:api'),
      'e2e.yml e2e-api job must run npm run test:e2e:api'
    );
  });

  it('REQ-OPS-015 AC2: e2e-ui-desktop job runs UI desktop tests with Puppeteer/Chrome', () => {
    assert.ok(
      raw.includes('npm run test:e2e:ui-desktop'),
      'e2e.yml e2e-ui-desktop job must run npm run test:e2e:ui-desktop'
    );
    // Chrome/Puppeteer system deps must be installed in that job
    assert.ok(
      raw.includes('chromium') || raw.includes('google-chrome') || raw.includes('libatk'),
      'e2e.yml e2e-ui-desktop job must install Chromium/Puppeteer system dependencies'
    );
  });

  it('REQ-OPS-015 AC3: e2e-ui-mobile job runs UI mobile tests with E2E_MOBILE=1', () => {
    assert.ok(
      raw.includes('npm run test:e2e:ui-mobile'),
      'e2e.yml e2e-ui-mobile job must run npm run test:e2e:ui-mobile'
    );
    assert.ok(
      raw.includes("E2E_MOBILE: '1'") || raw.includes('E2E_MOBILE: "1"') || raw.includes('E2E_MOBILE=1'),
      'e2e.yml e2e-ui-mobile job must set E2E_MOBILE=1'
    );
  });

  it('REQ-OPS-015 AC4: failed UI test runs upload screenshots and HTML as artifacts with 5-day retention', () => {
    // Both ui-desktop and ui-mobile must upload artifacts on failure
    assert.ok(
      raw.includes('if: failure()'),
      'e2e.yml must use `if: failure()` to gate artifact upload on test failure'
    );
    assert.ok(
      raw.includes('upload-artifact'),
      'e2e.yml must use actions/upload-artifact for failed UI test runs'
    );
    assert.ok(
      raw.includes('e2e-artifacts/'),
      'e2e.yml must upload from the e2e-artifacts/ path'
    );
    assert.ok(
      raw.includes('retention-days: 5'),
      'e2e.yml artifacts must declare retention-days: 5'
    );
  });
});
