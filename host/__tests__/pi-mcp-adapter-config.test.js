import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

async function fixture(t) {
  const { default: register, migratePiMcpAdapterConfig } = await import('../../preseed/agents/pi/extensions/00-mcp-adapter-config.ts');
  const home = mkdtempSync(join(tmpdir(), 'pi-adapter-config-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, '.pi', 'agent');
  mkdirSync(directory, { recursive: true });
  return { home, directory, legacy: join(directory, 'mcp.json'), target: join(directory, 'mcp-adapter.json'),
    migrate: () => migratePiMcpAdapterConfig(directory),
    load: () => register({}, { HOME: home }),
  };
}

const legacyConfig = '{\n "mcpServers": {"custom": {"command":"custom", "env":{"TOKEN":"synthetic-secret"}}, "chrome-devtools":{"args":["--wsEndpoint=wss://example.test/?keep_alive=600000"],"lifecycle":"lazy"}}, "settings":{"custom":true}, "imports":["synthetic"]\n}\n';

test('fresh adapter configuration is ready without fabricating servers or credentials', async (t) => {
  const f = await fixture(t);
  assert.equal(f.migrate(), true);
  assert.equal(existsSync(f.target), false);
  assert.equal(existsSync(f.legacy), false);
});

test('legacy adapter migration preserves exact bytes, credentials, custom servers and 600000 browser retention', async (t) => {
  const f = await fixture(t);
  writeFileSync(f.legacy, legacyConfig, { mode: 0o600 });
  assert.equal(f.migrate(), true);
  assert.equal(readFileSync(f.target, 'utf8'), legacyConfig);
  assert.equal(existsSync(f.legacy), false);
  assert.equal(f.migrate(), true);
  assert.equal(readFileSync(f.target, 'utf8'), legacyConfig);
});

test('managed extension loading migrates existing users without image startup or browser credentials', async (t) => {
  const f = await fixture(t);
  writeFileSync(f.legacy, legacyConfig);
  f.load();
  assert.equal(readFileSync(f.target, 'utf8'), legacyConfig);
  assert.equal(existsSync(f.legacy), false);
});

test('existing adapter target wins and retains legacy bytes when both files exist', async (t) => {
  const f = await fixture(t);
  const target = '{"mcpServers":{"preferred":{"command":"preferred"}},"settings":{"custom":false}}';
  writeFileSync(f.legacy, legacyConfig);
  writeFileSync(f.target, target);
  assert.equal(f.migrate(), true);
  assert.equal(readFileSync(f.target, 'utf8'), target);
  assert.equal(readFileSync(f.legacy, 'utf8'), legacyConfig);
});

for (const [name, content] of [['malformed', '{invalid'], ['array', '[]'], ['invalid servers', '{"mcpServers":[]}']]) {
  test(`${name} legacy configuration fails closed without replacing or removing user data`, async (t) => {
    const f = await fixture(t);
    writeFileSync(f.legacy, content);
    assert.equal(f.migrate(), false);
    assert.equal(readFileSync(f.legacy, 'utf8'), content);
    assert.equal(existsSync(f.target), false);
  });
}

test('malformed existing destination blocks bootstrap and leaves both files untouched', async (t) => {
  const f = await fixture(t);
  writeFileSync(f.legacy, legacyConfig);
  writeFileSync(f.target, '{invalid');
  assert.equal(f.migrate(), false);
  assert.equal(readFileSync(f.target, 'utf8'), '{invalid');
  assert.equal(readFileSync(f.legacy, 'utf8'), legacyConfig);
});

for (const name of ['legacy', 'target']) {
  test(`${name} symlink is rejected without following or changing its external file`, async (t) => {
    const f = await fixture(t);
    const external = join(f.home, 'external.json');
    writeFileSync(external, legacyConfig);
    symlinkSync(external, f[name]);
    assert.equal(f.migrate(), false);
    assert.equal(readFileSync(external, 'utf8'), legacyConfig);
    if (name === 'legacy') assert.equal(existsSync(f.target), false);
  });
}

test('nonregular destination blocks migration and retains legacy', async (t) => {
  const f = await fixture(t);
  writeFileSync(f.legacy, legacyConfig);
  mkdirSync(f.target);
  assert.equal(f.migrate(), false);
  assert.equal(readFileSync(f.legacy, 'utf8'), legacyConfig);
});

function startConsult(home) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const lines = readFileSync(join(repo, 'entrypoint.sh'), 'utf8').split('\n');
  function functionSource(name) {
    const start = lines.findIndex((line) => line === `${name}() {`);
    const end = lines.findIndex((line, index) => index > start && line === '}');
    if (start < 0 || end < 0) throw new Error(`missing production helper ${name}`);
    return lines.slice(start, end + 1).join('\n');
  }
  const functions = ['configure_pi_mcp_adapter', '_merge_consult_llm_mcp', '_remove_consult_llm_mcp', '_remove_disabled_consult_llm', 'configure_consult_llm'].map(functionSource).join('\n');
  return spawnSync('bash', ['-c', `${functions}\nconfigure_pi_mcp_adapter "$MIGRATION_MODULE"\nconfigure_consult_llm`], {
    encoding: 'utf8',
    env: { ...process.env, USER_HOME: home, USER_CLAUDE_JSON: join(home, '.claude.json'),
      MIGRATION_MODULE: join(repo, 'preseed/agents/pi/extensions/00-mcp-adapter-config.ts'),
      CODEFLARE_OPENAI_API_KEY: 'synthetic-openai', CODEFLARE_GEMINI_API_KEY: '', ENTERPRISE_MODE: '',
    },
  });
}

test('REQ-AGENT-069: startup bootstraps consult-llm at the adapter filename, lazily, without creating legacy', async (t) => {
  const f = await fixture(t);
  const result = startConsult(f.home);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(readFileSync(f.target, 'utf8'));
  assert.equal(config.mcpServers['consult-llm'].lifecycle, 'lazy');
  assert.equal(config.mcpServers['consult-llm'].env.OPENAI_API_KEY, 'synthetic-openai');
  assert.equal(existsSync(f.legacy), false);
});

test('REQ-AGENT-069: startup retains existing consult credentials and both-file user settings exactly', async (t) => {
  const f = await fixture(t);
  const target = '{"mcpServers":{"consult-llm":{"command":"custom-consult","env":{"TOKEN":"synthetic-custom"}}},"settings":{"custom":true}}';
  writeFileSync(f.legacy, legacyConfig);
  writeFileSync(f.target, target);
  const result = startConsult(f.home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.target, 'utf8'), target);
  assert.equal(readFileSync(f.legacy, 'utf8'), legacyConfig);
});

test('REQ-AGENT-069: startup blocks Pi bootstrap on malformed legacy without aborting Claude configuration', async (t) => {
  const f = await fixture(t);
  writeFileSync(f.legacy, '{invalid');
  const result = startConsult(f.home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.legacy, 'utf8'), '{invalid');
  assert.equal(existsSync(f.target), false);
  assert.equal(JSON.parse(readFileSync(join(f.home, '.claude.json'), 'utf8')).mcpServers['consult-llm'].command, 'consult-llm-mcp');
});
