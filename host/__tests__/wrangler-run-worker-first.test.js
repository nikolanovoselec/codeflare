// Guards the Cloudflare Assets `run_worker_first` boundary (wrangler.toml).
//
// The Worker owns authentication, control-plane routing, cache policy and SPA
// fallback behavior. It must therefore run before every asset request. Route
// tests call worker.fetch directly, so they cannot catch this edge-config gap.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const toml = readFileSync(resolve(__dirname, '../../wrangler.toml'), 'utf8');

describe('wrangler run_worker_first edge boundary (REQ-AUTH-020 AC1, REQ-AUTH-022 AC7, REQ-OPERATOR-029 AC1)', () => {
  it('runs the Worker before all asset requests', () => {
    assert.match(
      toml,
      /^run_worker_first\s*=\s*true\s*$/m,
      'run_worker_first must be true so no Worker-owned route can fall through to the SPA asset layer',
    );
  });
});
