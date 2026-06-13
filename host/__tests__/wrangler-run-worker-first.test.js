// Guards the Cloudflare Assets `run_worker_first` allowlist (wrangler.toml).
//
// REQ-AUTH-020 AC1: in onboarding mode the Worker rewrites /login to the
// landing-built login page. That rewrite only runs if /login is in
// run_worker_first; otherwise Cloudflare serves the SPA asset at the edge and
// the Worker is never invoked for /login (the production bug this guards). The
// worker-level unit test (onboarding-login.test.ts) calls worker.fetch directly,
// so it cannot catch this edge-config gap — only a config-level check can.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const toml = readFileSync(resolve(__dirname, '../../wrangler.toml'), 'utf8');

function runWorkerFirst() {
  const m = toml.match(/run_worker_first\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'wrangler.toml must declare run_worker_first');
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

describe('wrangler run_worker_first control-plane routes (REQ-AUTH-020 AC1)', () => {
  it('includes /login so the onboarding login rewrite runs at the edge', () => {
    const routes = runWorkerFirst();
    assert.ok(
      routes.includes('/login'),
      `/login must be in run_worker_first, else Cloudflare serves the SPA asset and the ` +
        `/login -> /landing/login/ rewrite never executes. Got: ${JSON.stringify(routes)}`,
    );
  });

  it('keeps the other control-plane routes that must hit the Worker before the SPA fallback', () => {
    const routes = runWorkerFirst();
    for (const r of ['/', '/auth/*', '/api/*', '/health', '/landing/*']) {
      assert.ok(routes.includes(r), `run_worker_first must include ${r}; got ${JSON.stringify(routes)}`);
    }
  });
});
