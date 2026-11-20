import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8'));
const allocation = workflow.jobs.deploy.steps.find(step => step.name === 'Apply container resource tier');
const original = 'name = "fixture"\n[[containers]]\nclass_name = "container"\nmax_instances = 3\ninstance_type = "basic"\n';

function applyAllocation(tier, override) {
  const directory = mkdtempSync(join(tmpdir(), 'codeflare-allocation-'));
  const config = join(directory, 'wrangler.toml');
  try {
    writeFileSync(config, original);
    const result = spawnSync('bash', ['-e', '-c', allocation.run], {
      cwd: directory, encoding: 'utf8',
      env: { PATH: process.env.PATH, TIER: tier, MAX_INSTANCES_OVERRIDE: override },
    });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr, config: readFileSync(config, 'utf8') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('REQ-OPS-012: Per-environment container concurrency limit', () => {
  it('keeps the default cap and applies a valid override across resource profiles', () => {
    for (const [tier, profile] of [['low', 'instance_type = "basic"'], ['default', 'memory_mib = 3072'],
      ['saas', 'memory_mib = 3072'], ['high', 'memory_mib = 6144']]) {
      for (const [input, expected] of [['', 10], ['24', 24]]) {
        const result = applyAllocation(tier, input);
        assert.equal(result.status, 0, result.output);
        assert.match(result.config, new RegExp(`^max_instances = ${expected}$`, 'm'));
        assert.ok(result.config.includes(profile));
      }
    }
  });

  it('REQ-OPS-012 AC3: rejects invalid whole values without changing the config', () => {
    for (const value of ['0', '-1', '1.5', ' 4', '4 ', '04', '+4', '4\n5', '4\n', 'bad\n4']) {
      const result = applyAllocation('default', value);
      assert.equal(result.status, 1, JSON.stringify(value));
      assert.match(result.output, /MAX_INSTANCES must be a positive integer/);
      assert.equal(result.config, original);
    }
  });
});
