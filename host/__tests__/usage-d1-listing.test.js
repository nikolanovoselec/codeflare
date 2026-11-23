import assert from 'node:assert/strict';
import { it } from 'node:test';
import { prepareUsageD1 } from '../../scripts/ci/prepare-usage-d1.mjs';

const options = {
  workerName: 'codeflare-integration',
  apiToken: 'fixture-token',
  wranglerConfig: `[[d1_databases]]
binding = "USAGE_DB"
database_name = "placeholder"
database_id = "placeholder"
migrations_dir = "migrations/usage"`,
};

it('REQ-OPS-056 AC3: invalid D1 inventory cannot authorize database creation', async () => {
  for (const [stdout, diagnostic] of [
    ['', /D1 list returned invalid JSON/],
    [undefined, /D1 list returned invalid JSON/],
    [' \n', /D1 list returned invalid JSON/],
    ['[', /D1 list returned invalid JSON/],
    ['{}', /D1 list returned an unexpected shape/],
    ['[{}]', /D1 list returned an unexpected shape/],
  ]) {
    const calls = [];
    const configWrites = [];
    await assert.rejects(prepareUsageD1({
      ...options,
      run: async (args) => {
        calls.push(args);
        return { status: 0, stdout };
      },
      writeConfig: async (content) => { configWrites.push(content); },
    }), diagnostic, `stdout: ${JSON.stringify(stdout)}`);
    assert.deepEqual(calls, [['d1', 'list', '--json']]);
    assert.deepEqual(configWrites, []);
  }
});

it('REQ-OPS-056 AC3: a valid empty list authorizes creation but a blank readback blocks binding and migration', async () => {
  const calls = [];
  const configWrites = [];
  await assert.rejects(prepareUsageD1({
    ...options,
    run: async (args) => {
      calls.push(args);
      return { status: 0, stdout: calls.length === 1 ? '[]' : '' };
    },
    writeConfig: async (content) => { configWrites.push(content); },
  }), /D1 list after create returned invalid JSON/);
  assert.deepEqual(calls, [
    ['d1', 'list', '--json'],
    ['d1', 'create', 'codeflare-integration-usage'],
    ['d1', 'list', '--json'],
  ]);
  assert.deepEqual(configWrites, []);
});
