import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  return { home, directory, legacy: join(directory, 'mcp.json'), target: join(directory, 'mcp-adapter.json'), backup: join(directory, 'mcp.json.migrated'),
    migrate: () => migratePiMcpAdapterConfig(directory),
    load: () => register({}, { HOME: home }),
  };
}

const legacyConfig = '{\n "mcpServers": {"custom": {"command":"custom", "env":{"TOKEN":"synthetic-secret"}}, "chrome-devtools":{"args":["--wsEndpoint=wss://example.test/?keep_alive=600000"],"lifecycle":"lazy"}}, "settings":{"custom":true}, "imports":["synthetic"]\n}\n';

// Archive prefixes are the user-visible recovery contract; contents must survive exactly.
function assertArchived(f, prefix, bytes) {
  const copies = readdirSync(f.directory).filter(name => name.startsWith(prefix))
    .map(name => join(f.directory, name)).filter(path => {
      const info = lstatSync(path);
      return info.isFile() && !info.isSymbolicLink();
    });
  assert.ok(copies.some(path => readFileSync(path, 'utf8') === bytes), 'original bytes preserved in a regular archive');
}

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

test('existing adapter target wins and archives legacy bytes without leaving the deprecated filename', async (t) => {
  const f = await fixture(t);
  const target = '{"mcpServers":{"preferred":{"command":"preferred"}},"settings":{"custom":false}}';
  writeFileSync(f.legacy, legacyConfig);
  writeFileSync(f.target, target);
  assert.equal(f.migrate(), true);
  assert.equal(readFileSync(f.target, 'utf8'), target);
  assert.equal(readFileSync(f.backup, 'utf8'), legacyConfig);
  assert.equal(existsSync(f.legacy), false);
  assert.equal(f.migrate(), true);
});

test('existing migration backup is never overwritten or used to discard legacy credentials', async (t) => {
  const f = await fixture(t);
  writeFileSync(f.legacy, legacyConfig);
  writeFileSync(f.target, '{}');
  writeFileSync(f.backup, 'preserved backup');
  assert.equal(f.migrate(), true);
  assert.equal(existsSync(f.legacy), false);
  assertArchived(f, 'mcp.json.migrated', legacyConfig);
  assert.equal(readFileSync(f.backup, 'utf8'), 'preserved backup');
  assert.equal(readFileSync(f.target, 'utf8'), '{}');
  writeFileSync(f.legacy, legacyConfig); // A new restore must also be recoverable.
  assert.equal(f.migrate(), true);
  assert.equal(existsSync(f.legacy), false);
  assertArchived(f, 'mcp.json.migrated', legacyConfig);
  assert.equal(readFileSync(f.backup, 'utf8'), 'preserved backup');
});

for (const [name, content] of [['malformed', '{invalid'], ['array', '[]'], ['invalid servers', '{"mcpServers":[]}'], ['empty', '']]) {
  test(`${name} legacy configuration is archived without discarding bytes and recovers a valid adapter`, async (t) => {
    const f = await fixture(t);
    writeFileSync(f.legacy, content);
    assert.equal(f.migrate(), true);
    assertArchived(f, 'mcp.json.migrated', content);
    assert.equal(existsSync(f.legacy), false);
    assert.deepEqual(JSON.parse(readFileSync(f.target, 'utf8')), {});
    assert.equal(f.migrate(), true);
  });
}

test('malformed existing destination is archived and recovers exact valid legacy configuration', async (t) => {
  const f = await fixture(t);
  writeFileSync(f.legacy, legacyConfig);
  writeFileSync(f.target, '{invalid');
  assert.equal(f.migrate(), true);
  assertArchived(f, 'mcp-adapter.json.invalid', '{invalid');
  assert.equal(readFileSync(f.target, 'utf8'), legacyConfig);
  assert.equal(existsSync(f.legacy), false);
});

test('matching archive permits repeated restored legacy retirement without changing active settings', async t => {
  const f = await fixture(t);
  const target = '{"mcpServers":{"preferred":{"command":"preferred"}},"settings":{"custom":false}}';
  writeFileSync(f.target, target);
  writeFileSync(f.backup, legacyConfig);
  for (let restore = 0; restore < 3; restore++) {
    writeFileSync(f.legacy, legacyConfig);
    assert.equal(f.migrate(), true);
    assert.equal(existsSync(f.legacy), false);
    assert.equal(readFileSync(f.target, 'utf8'), target);
    assert.equal(readFileSync(f.backup, 'utf8'), legacyConfig);
  }
});

for (const kind of ['symlink', 'directory']) {
  test(`occupied ${kind} archive is preserved without following it or preventing recovery`, async t => {
    const f = await fixture(t);
    const external = join(f.home, 'external.json');
    writeFileSync(external, 'external bytes');
    writeFileSync(f.legacy, legacyConfig);
    writeFileSync(f.target, '{}');
    if (kind === 'symlink') symlinkSync(external, f.backup);
    else mkdirSync(f.backup);
    assert.equal(f.migrate(), true);
    assert.equal(existsSync(f.legacy), false);
    assertArchived(f, 'mcp.json.migrated', legacyConfig);
    assert.equal(readFileSync(external, 'utf8'), 'external bytes');
    assert.equal(readFileSync(f.target, 'utf8'), '{}');
    assert.equal(kind === 'symlink' ? lstatSync(f.backup).isSymbolicLink() : lstatSync(f.backup).isDirectory(), true);
  });
}

test('malformed legacy is archived while a valid adapter stays byte-for-byte unchanged', async t => {
  const f = await fixture(t);
  writeFileSync(f.target, legacyConfig);
  writeFileSync(f.legacy, '{invalid');
  assert.equal(f.migrate(), true);
  assert.equal(readFileSync(f.target, 'utf8'), legacyConfig);
  assertArchived(f, 'mcp.json.migrated', '{invalid');
  assert.equal(existsSync(f.legacy), false);
});

for (const legacy of [undefined, '{invalid legacy']) {
  test(`invalid adapter with ${legacy === undefined ? 'missing' : 'invalid'} legacy preserves originals before empty recovery`, async t => {
    const f = await fixture(t);
    writeFileSync(f.target, '{invalid adapter');
    if (legacy !== undefined) writeFileSync(f.legacy, legacy);
    assert.equal(f.migrate(), true);
    assertArchived(f, 'mcp-adapter.json.invalid', '{invalid adapter');
    if (legacy !== undefined) assertArchived(f, 'mcp.json.migrated', legacy);
    assert.deepEqual(JSON.parse(readFileSync(f.target, 'utf8')), {});
    assert.equal(existsSync(f.legacy), false);
    assert.equal(f.migrate(), true);
  });
}

test('archive alone never silently reactivates archived credentials', async t => {
  const f = await fixture(t);
  writeFileSync(f.backup, legacyConfig);
  assert.equal(f.migrate(), true);
  assert.equal(existsSync(f.target), false);
  assert.equal(readFileSync(f.backup, 'utf8'), legacyConfig);
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

function startConsult(home, restoredLegacy) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const lines = readFileSync(join(repo, 'entrypoint.sh'), 'utf8').split('\n');
  function functionSource(name) {
    const start = lines.findIndex((line) => line === `${name}() {`);
    const end = lines.findIndex((line, index) => index > start && line === '}');
    if (start < 0 || end < 0) throw new Error(`missing production helper ${name}`);
    return lines.slice(start, end + 1).join('\n');
  }
  const functions = ['configure_pi_mcp_adapter', '_merge_consult_llm_mcp', '_remove_consult_llm_mcp', '_remove_disabled_consult_llm', 'configure_consult_llm'].map(functionSource).join('\n');
  return spawnSync('bash', ['-c', `${functions}\nconfigure_pi_mcp_adapter "$MIGRATION_MODULE"\nconfigure_consult_llm
if [ -n "$RESTORED_LEGACY" ]; then
  # Execute the rclone exclusion wire contract against a synthetic restored object.
  python3 - "$RESTORED_LEGACY" "$USER_HOME/.pi/agent/mcp.json" "\${RCLONE_FILTERS[@]}" <<'BASELINE'
import fnmatch, pathlib, shutil, sys
args=sys.argv[3:]
excluded=any(args[i] == '--filter' and args[i+1].startswith('- ')
             and fnmatch.fnmatch('.pi/agent/mcp.json', args[i+1][2:])
             for i in range(len(args)-1))
if not excluded: shutil.copyfile(sys.argv[1], sys.argv[2])
BASELINE
fi`], {
    encoding: 'utf8',
    env: { ...process.env, USER_HOME: home, USER_CLAUDE_JSON: join(home, '.claude.json'),
      MIGRATION_MODULE: join(repo, 'preseed/agents/pi/extensions/00-mcp-adapter-config.ts'),
      RESTORED_LEGACY: restoredLegacy || '', CODEFLARE_OPENAI_API_KEY: 'synthetic-openai', CODEFLARE_GEMINI_API_KEY: '', ENTERPRISE_MODE: '',
    },
  });
}

test('REQ-AGENT-069: startup bootstraps consult-llm at the adapter filename, lazily, without creating legacy', async (t) => {
  const f = await fixture(t);
  const result = startConsult(f.home);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(readFileSync(f.target, 'utf8'));
  assert.equal(config.mcpServers['consult-llm'].lifecycle, 'lazy');
  assert.equal(config.settings.deferWithMissingMetadata, true,
    'fresh managed configuration must not eagerly launch a lazy server for metadata');
  assert.equal(config.mcpServers['consult-llm'].env.OPENAI_API_KEY, 'synthetic-openai');
  assert.equal(existsSync(f.legacy), false);
});

test('REQ-AGENT-069: adding consult preserves existing user startup settings and unrelated servers', async t => {
  const f = await fixture(t);
  const config = { mcpServers: { custom: { command: 'custom', args: ['keep'], lifecycle: 'lazy' } },
    settings: { deferWithMissingMetadata: false, custom: true } };
  writeFileSync(f.target, JSON.stringify(config));
  const result = startConsult(f.home);
  assert.equal(result.status, 0, result.stderr);
  const updated = JSON.parse(readFileSync(f.target, 'utf8'));
  assert.deepEqual(updated.settings, config.settings);
  assert.deepEqual(updated.mcpServers.custom, config.mcpServers.custom);
  assert.equal(updated.mcpServers['consult-llm'].lifecycle, 'lazy');
});

test('REQ-AGENT-069: startup retains existing consult credentials and both-file user settings exactly', async (t) => {
  const f = await fixture(t);
  const target = '{"mcpServers":{"consult-llm":{"command":"custom-consult","env":{"TOKEN":"synthetic-custom"}}},"settings":{"custom":true}}';
  writeFileSync(f.legacy, legacyConfig);
  writeFileSync(f.target, target);
  const result = startConsult(f.home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.target, 'utf8'), target);
  assert.equal(readFileSync(f.backup, 'utf8'), legacyConfig);
  assert.equal(existsSync(f.legacy), false);
});

test('REQ-AGENT-069: startup recovers malformed legacy and bootstraps lazy consult without changing Claude behavior', async (t) => {
  const f = await fixture(t);
  writeFileSync(f.legacy, '{invalid');
  const result = startConsult(f.home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.legacy), false);
  assertArchived(f, 'mcp.json.migrated', '{invalid');
  assert.equal(JSON.parse(readFileSync(f.target, 'utf8')).mcpServers['consult-llm'].lifecycle, 'lazy');
  assert.equal(JSON.parse(readFileSync(join(f.home, '.claude.json'), 'utf8')).mcpServers['consult-llm'].command, 'consult-llm-mcp');
});


test('REQ-AGENT-217: fresh startup prevents baseline from restoring the obsolete MCP filename', async t => {
  const f = await fixture(t);
  const restored = join(f.home, 'remote-legacy.json');
  writeFileSync(restored, legacyConfig);
  writeFileSync(f.legacy, legacyConfig);
  writeFileSync(f.target, '{}');
  writeFileSync(f.backup, 'old passive archive');
  const result = startConsult(f.home, restored);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.legacy), false);
  assert.equal(JSON.parse(readFileSync(f.target, 'utf8')).mcpServers['consult-llm'].lifecycle, 'lazy');
  assertArchived(f, 'mcp.json.migrated', legacyConfig);
  assert.equal(readFileSync(f.backup, 'utf8'), 'old passive archive');
});

test('REQ-AGENT-069: fresh startup regenerates managed consult credentials while retaining custom servers and settings', async t => {
  const f = await fixture(t);
  const config = { mcpServers: {
    'consult-llm': { command: 'consult-llm-mcp', env: { OPENAI_API_KEY: 'synthetic-stale-managed-key' } },
    custom: { command: 'custom-server', env: { TOKEN: 'synthetic-custom-token' } },
  }, settings: { deferWithMissingMetadata: false, custom: true } };
  writeFileSync(f.target, JSON.stringify(config));
  const result = startConsult(f.home);
  assert.equal(result.status, 0, result.stderr);
  const updated = JSON.parse(readFileSync(f.target, 'utf8'));
  assert.equal(updated.mcpServers['consult-llm'].env.OPENAI_API_KEY, 'synthetic-openai');
  assert.equal(updated.mcpServers['consult-llm'].lifecycle, 'lazy');
  assert.deepEqual(updated.mcpServers.custom, config.mcpServers.custom);
  assert.deepEqual(updated.settings, config.settings);
});
