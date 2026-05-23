// Workflow-file validation. CI runs ARE the test for these REQs; this
// suite enforces the workflow files exist and carry the load-bearing
// configuration the spec promises.
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

describe('GitHub Actions workflow files / REQ-OPS-004 (E2E test workflow setup and job graph) / REQ-OPS-015 (E2E per-suite execution and artifact handling)', () => {
  test('e2e.yml workflow file exists', () => {
    const path = join(repoRoot, '.github/workflows/e2e.yml');
    assert.ok(existsSync(path), 'e2e.yml workflow file must exist');
  });

  test('e2e.yml declares the test suite job graph (per-suite execution surface)', () => {
    const path = join(repoRoot, '.github/workflows/e2e.yml');
    const body = readFileSync(path, 'utf-8');
    assert.match(body, /jobs:/, 'e2e.yml must define jobs');
    assert.match(body, /playwright|e2e/i, 'e2e.yml must reference Playwright/E2E tooling');
  });

  test('e2e.yml configures artifact handling for failed suites', () => {
    const path = join(repoRoot, '.github/workflows/e2e.yml');
    const body = readFileSync(path, 'utf-8');
    assert.match(body, /upload-artifact|actions\/upload-artifact/, 'e2e.yml must upload artifacts on failure (per REQ-OPS-015 AC: failed-suite artifact handling)');
  });
});

describe('Per-environment container concurrency / REQ-OPS-012 (per-environment container concurrency limit)', () => {
  test('wrangler.toml declares container concurrency configuration per environment', () => {
    const path = join(repoRoot, 'wrangler.toml');
    assert.ok(existsSync(path), 'wrangler.toml must exist');
    const body = readFileSync(path, 'utf-8');
    // Codeflare uses [[env.*.containers]] blocks with max_instances and other concurrency knobs
    assert.match(body, /\[\[env\.[a-z]+\.containers\]\]|max_instances/, 'wrangler.toml must declare per-env container concurrency settings');
  });
});

function readWorkflow(name) {
  const path = join(repoRoot, '.github/workflows', name);
  assert.ok(existsSync(path), `${name} must exist`);
  return readFileSync(path, 'utf-8');
}

describe('deploy workflow / REQ-OPS-001 (deploy trigger gated on PR Checks success) / REQ-OPS-013 (deploy job + post-deploy secret-set steps) / REQ-OPS-007 (deploy patches wrangler.toml for worker name + resource tier)', () => {
  test('deploy.yml is gated on workflow_run conclusion==success from PR Checks on main', () => {
    const body = readWorkflow('deploy.yml');
    assert.match(body, /workflow_run:/, 'deploy must trigger on workflow_run');
    assert.match(body, /workflows:\s*\[\s*['"]PR Checks['"]\s*\]/, 'deploy must depend on PR Checks workflow');
    assert.match(body, /branches:\s*\[\s*main\s*\]/, 'deploy must restrict workflow_run to main');
    assert.match(body, /workflow_run\.conclusion == 'success'/, 'deploy job must require PR Checks success');
  });

  test('deploy.yml runs backend + frontend tests + type checks before deploy (pre-deploy gate)', () => {
    const body = readWorkflow('deploy.yml');
    assert.match(body, /Run backend tests/, 'deploy must run backend tests');
    assert.match(body, /Run frontend tests/, 'deploy must run frontend tests');
    assert.match(body, /Type check backend/, 'deploy must type-check backend');
    assert.match(body, /Type check frontend/, 'deploy must type-check frontend');
  });

  test('deploy.yml has Deploy to Cloudflare step + post-deploy secret-set steps', () => {
    const body = readWorkflow('deploy.yml');
    assert.match(body, /Deploy to Cloudflare/, 'deploy must have the Cloudflare deploy step');
    assert.match(body, /Set API token as worker secret/, 'post-deploy must set worker secret');
    assert.match(body, /Set encryption key as worker secret/, 'post-deploy must set encryption-key secret (optional)');
  });

  test('deploy.yml patches wrangler.toml for worker name and resource tier (REQ-OPS-007 verification)', () => {
    const body = readWorkflow('deploy.yml');
    assert.match(body, /Apply worker name to wrangler config/, 'deploy must patch wrangler worker name');
    assert.match(body, /Apply container resource tier/, 'deploy must patch container resource tier');
  });
});

describe('container image pipeline / REQ-OPS-002 (image built, scanned, pushed, DO-bound) / REQ-OPS-014 (image-patch + resource-tier in deploy) / REQ-SEC-011 (Trivy scan blocks deploy on HIGH+ CVEs)', () => {
  test('deploy.yml builds the container image, scans with Trivy, pushes to Cloudflare registry, and pins wrangler.toml to the pushed image', () => {
    const body = readWorkflow('deploy.yml');
    assert.match(body, /Build container image/, 'must build container image');
    assert.match(body, /Scan container image for vulnerabilities/, 'must run Trivy/vuln scan');
    assert.match(body, /trivy/i, 'scan step must reference Trivy');
    assert.match(body, /Push image to Cloudflare registry/, 'must push image to Cloudflare registry');
    assert.match(body, /Point wrangler\.toml to pre-pushed image/, 'must pin wrangler.toml to the pushed image (DO binding)');
  });

  test('.trivyignore exists (controlled allowlist surface for vuln scan)', () => {
    const path = join(repoRoot, '.trivyignore');
    assert.ok(existsSync(path), '.trivyignore must exist as the controlled allowlist');
  });
});

describe('PR Checks workflow / REQ-OPS-003 (test workflow runs on every PR + push to main/develop) / REQ-OPS-009 (dependency-review job in test.yml + scorecard.yml present)', () => {
  test('test.yml triggers on pull_request and push and declares a test job', () => {
    const body = readWorkflow('test.yml');
    assert.match(body, /pull_request:/, 'test must trigger on pull_request');
    assert.match(body, /push:/, 'test must trigger on push');
    assert.match(body, /^\s+test:/m, 'test.yml must declare a `test:` job');
  });

  test('test.yml declares a dependency-review job (REQ-OPS-009 supply-chain gate)', () => {
    const body = readWorkflow('test.yml');
    assert.match(body, /^\s+dependency-review:/m, 'test.yml must declare a `dependency-review:` job');
  });

  test('scorecard.yml exists and runs on schedule + push (REQ-OPS-009 supply-chain posture)', () => {
    const body = readWorkflow('scorecard.yml');
    assert.match(body, /schedule:/, 'scorecard must have a schedule trigger');
    assert.match(body, /push:/, 'scorecard must have a push trigger');
    assert.match(body, /^\s+scorecard:/m, 'scorecard.yml must declare a `scorecard:` job');
  });
});

describe('pentest workflow / REQ-OPS-005 (scheduled pentest runs against deployed worker) / REQ-SEC-001 (auth-gate pentest job) / REQ-SEC-002 (info-disclosure pentest job) / REQ-SEC-008 (security-headers pentest job verifies all headers) / REQ-SEC-009 (injection pentest job) / REQ-SEC-010 (storage-key injection pentest job) / REQ-SEC-013 (Content-Disposition pentest under injection job) / REQ-SEC-014 (SaaS auth-gate pentest job) / REQ-SEC-021 (security-headers pentest exercises redirect paths)', () => {
  test('pentest.yml has schedule + workflow_dispatch triggers', () => {
    const body = readWorkflow('pentest.yml');
    assert.match(body, /schedule:/, 'pentest must have a schedule trigger');
    assert.match(body, /workflow_dispatch:/, 'pentest must allow manual dispatch');
  });

  test('pentest.yml declares the six load-bearing jobs (security-headers, tls, auth-gate, info-disclosure, injection, http-methods)', () => {
    const body = readWorkflow('pentest.yml');
    for (const job of ['security-headers', 'tls', 'auth-gate', 'info-disclosure', 'injection', 'http-methods']) {
      const re = new RegExp(`^\\s+${job}:`, 'm');
      assert.match(body, re, `pentest.yml must declare the \`${job}:\` job`);
    }
  });
});

describe('fuzz workflow / REQ-OPS-018 (fuzz workflow scheduled + PR-triggered) / REQ-SEC-009 (fuzz property-based input-validation tests as part of injection-defense surface)', () => {
  test('fuzz.yml has schedule + pull_request triggers and a fuzz job', () => {
    const body = readWorkflow('fuzz.yml');
    assert.match(body, /schedule:/, 'fuzz must run on schedule');
    assert.match(body, /pull_request:/, 'fuzz must run on pull_request');
    assert.match(body, /^\s+fuzz:/m, 'fuzz.yml must declare a `fuzz:` job');
  });
});
