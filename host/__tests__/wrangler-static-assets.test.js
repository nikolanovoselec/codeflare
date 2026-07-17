// REQ-AUTH-022 AC7: fingerprinted Vite assets must reach the Worker's
// immutable-cache policy instead of using Workers Assets' revalidating default.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unstable_readConfig } from 'wrangler';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, '../../wrangler.toml');

describe('REQ-AUTH-022 AC7: authenticated app asset routing', () => {
  it('routes fingerprinted Vite assets through the Worker cache policy', () => {
    const config = unstable_readConfig({ config: configPath }, { hideWarnings: true });

    assert.ok(config.assets);
    assert.ok(Array.isArray(config.assets.run_worker_first));
    assert.ok(config.assets.run_worker_first.includes('/assets/*'));
  });
});
