// REQ-AUTH-020 AC1 / REQ-AUTH-022 AC7 / REQ-OPERATOR-029 AC1:
// Wrangler must interpret the asset boundary as Worker-first for every route.
// Deployed edge behavior remains a Gate 1 observation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unstable_readConfig } from 'wrangler';

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, '../../wrangler.toml');

describe('REQ-AUTH-020 AC1, REQ-AUTH-022 AC7, REQ-OPERATOR-029 AC1: Worker-first asset routing', () => {
  it('runs the Worker before every asset route', () => {
    const config = unstable_readConfig({ config: configPath }, { hideWarnings: true });

    assert.ok(config.assets);
    assert.equal(config.assets.run_worker_first, true);
  });
});
