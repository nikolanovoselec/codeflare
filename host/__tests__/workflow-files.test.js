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
