import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-extension@1.12.1'], extensions: ['-builtin:mcp'] }));
  return { home, directory, legacy: join(directory, 'mcp-adapter.json'), target: join(directory, 'mcp.json'), backup: join(directory, 'mcp-adapter.json.migrated'),
    migrate: (regenerate = false) => migratePiMcpAdapterConfig(directory, regenerate),
    prepare: (regenerate = false) => migratePiMcpAdapterConfig(directory, regenerate, true),
    load: (pi = {}) => register(pi, { HOME: home }),
  };
}

test('REQ-AGENT-217: selected stock hands off even when the adapter is merely installed', async t => {
  const f = await fixture(t);
  mkdirSync(join(f.directory, 'npm', 'node_modules', 'pi-mcp-adapter'), { recursive: true });
  writeFileSync(f.legacy, legacyConfig);
  f.load();
  assert.equal(existsSync(f.legacy), false);
  assert.equal(JSON.parse(readFileSync(f.target, 'utf8')).settings.requestTimeoutMs, 360000);
});

const stock = 'npm:pi-mcp-extension@1.12.1';
const adapter = 'npm:pi-mcp-adapter@5.3.1';
const localStock = '/home/user/.pi/agent/local-mcp-runtime/npm/node_modules/pi-mcp-extension';
for (const [name, settings, selected] of [
  ['adapter only', { packages: [adapter] }, 'adapter'],
  ['dual npm owners', { packages: [stock, adapter] }, 'ambiguous'],
  ['dual local stock and npm adapter', { packages: [localStock, adapter], extensions: ['-builtin:mcp'] }, 'ambiguous'],
  ['disabled stock package', { packages: [{ source: stock, extensions: [] }, adapter] }, 'adapter'],
  ['disabled adapter package', { packages: [stock, { source: adapter, extensions: [] }] }, 'stock'],
  ['exact stock package exclusion', { packages: [{ source: stock, extensions: ['-src/index.ts'] }, adapter] }, 'adapter'],
  ['exact adapter package exclusion', { packages: [stock, { source: adapter, extensions: ['!./index.ts'] }] }, 'stock'],
  ['exact global stock exclusion', { packages: [localStock, adapter], extensions: [`-${localStock}/src/index.ts`] }, 'adapter'],
  ['exact global adapter exclusion', { packages: [localStock, '/synthetic/npm/node_modules/pi-mcp-adapter'], extensions: ['-/synthetic/npm/node_modules/pi-mcp-adapter/index.ts'] }, 'stock'],
  ['npm exclusion with uncertain install root', { packages: [stock, adapter], extensions: ['-/synthetic/npm/node_modules/pi-mcp-adapter/index.ts'] }, 'ambiguous'],
  ['exact include overrides bang exclusion', { packages: [stock, { source: adapter, extensions: ['!index.ts', '+index.ts'] }] }, 'ambiguous'],
  ['exact minus exclusion overrides include', { packages: [stock, { source: adapter, extensions: ['+index.ts', '-index.ts'] }] }, 'stock'],
  ['local stock package', { packages: [localStock] }, 'stock'],
  ['excluded retired MCP companion is not another owner', { packages: [stock], extensions: ['-/home/user/.pi/agent/extensions/mcp-portal-oauth.ts', '-builtin:mcp'] }, 'stock'],
  ['global stock extension', { extensions: [`${localStock}/src/index.ts`, '-builtin:mcp'] }, 'stock'],
  ['unknown stock filter', { packages: [{ source: stock, extensions: ['src/*.ts'] }] }, 'ambiguous'],
  ['unknown adapter filter beside stock', { packages: [stock, { source: adapter, extensions: ['unknown.ts'] }] }, 'ambiguous'],
  ['unknown local path', { packages: ['/synthetic/unknown-mcp'] }, 'ambiguous'],
  ['missing selection', {}, 'ambiguous'],
  ['malformed packages', { packages: stock }, 'ambiguous'],
  ['malformed extensions', { packages: [stock], extensions: null }, 'ambiguous'],
  ['malformed settings', '{synthetic-private-settings', 'ambiguous'],
]) {
  test(`REQ-AGENT-217: configured MCP selection protects native files (${name})`, async t => {
    const f = await fixture(t);
    writeFileSync(join(f.directory, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
    const native = '{"mcpServers":{"custom":{"command":"synthetic","env":{"TOKEN":"!!synthetic-private"},"lifecycle":"lazy-keep-alive"}},"settings":{"native":true}}\n';
    const target = '{"mcpServers":{},"settings":{"custom":true}}\n';
    writeFileSync(f.legacy, native);
    writeFileSync(f.target, target);
    const before = readdirSync(f.directory).sort();
    const notifications = [];
    const pi = { on: (event, handler) => {
      if (event === 'session_start') handler({}, { ui: { notify: (message, level) => notifications.push({ message, level }) } });
    } };
    f.load(pi);
    f.load(pi);
    if (selected === 'stock') {
      assert.equal(existsSync(f.legacy), false);
      assert.equal(JSON.parse(readFileSync(f.target, 'utf8')).settings.requestTimeoutMs, 360000);
      assertArchived(f, 'mcp-adapter.json.migrated', native);
    } else {
      assert.equal(readFileSync(f.legacy, 'utf8'), native);
      assert.equal(readFileSync(f.target, 'utf8'), target);
      assert.deepEqual(readdirSync(f.directory).sort(), before);
      if (selected === 'ambiguous') {
        assert.ok(notifications.some(({ message, level }) => level === 'warning' && /selection.*ambiguous|ambiguous.*selection/i.test(message)));
        for (const { message } of notifications) {
          assert.doesNotMatch(message, /synthetic|\/home\/|npm:|owns|owner is/);
        }
      } else assert.deepEqual(notifications, []);
    }
  });
}

for (const unsafe of ['missing', 'symlink', 'directory']) {
  test(`REQ-AGENT-217: unsafe or absent global settings preserve MCP files (${unsafe})`, async t => {
    const f = await fixture(t);
    const settings = join(f.directory, 'settings.json');
    rmSync(settings);
    if (unsafe === 'symlink') {
      const outside = join(f.home, 'external-settings.json');
      writeFileSync(outside, JSON.stringify({ packages: [stock] }));
      symlinkSync(outside, settings);
    } else if (unsafe === 'directory') mkdirSync(settings);
    writeFileSync(f.legacy, legacyConfig);
    f.load();
    assert.equal(readFileSync(f.legacy, 'utf8'), legacyConfig);
    assert.equal(existsSync(f.target), false);
  });
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
  const original = JSON.parse(legacyConfig);
  assert.deepEqual(JSON.parse(readFileSync(f.target, 'utf8')), {
    ...original, settings: { ...original.settings, requestTimeoutMs: 360000 },
  });
  assertArchived(f, 'mcp-adapter.json.migrated', legacyConfig);
  assert.equal(existsSync(f.legacy), false);
});

test('REQ-BROWSER-009 AC1: fresh Pi load configures six-minute RPC requests without fabricating servers', async t => {
  const f = await fixture(t);
  f.load();
  assert.equal(existsSync(f.target), true, 'actual Pi load prepares the configured RPC budget');
  assert.deepEqual(JSON.parse(readFileSync(f.target, 'utf8')), { settings: { requestTimeoutMs: 360000 } });
});

for (const regenerate of [false, true]) {
  test(`REQ-BROWSER-009 AC1/AC2/AC4/AC5/AC6: timeout preparation preserves custom auth and archives originals (regenerate=${regenerate})`, async t => {
    const f = await fixture(t);
    const browser = { command: 'custom-browser', args: [
      '--wsEndpoint=wss://api.cloudflare.com/client/v4/accounts/synthetic-account/browser-rendering/devtools/browser?keep_alive=180000&custom=keep&keep_alive=600000',
      '--wsHeaders={"Authorization":"Bearer synthetic-user-token"}',
    ], lifecycle: 'lazy-keep-alive', requestTimeoutMs: 600000 };
    const custom = { command: 'custom', requestTimeoutMs: 2000, env: { TOKEN: 'synthetic-secret' } };
    const original = JSON.stringify({ mcpServers: { 'chrome-devtools': browser, custom }, settings: { custom: true, requestTimeoutMs: 60000 } });
    writeFileSync(f.target, original, { mode: 0o600 });
    if (regenerate) assert.equal(f.prepare(true), true);
    else f.load(); // Exercise actual next-load registration, not only the migration API.
    const bytes = readFileSync(f.target, 'utf8');
    const prepared = JSON.parse(bytes);
    assert.deepEqual(prepared.settings, { custom: true, requestTimeoutMs: 360000 });
    assert.deepEqual(prepared.mcpServers.custom, custom);
    assert.equal(prepared.mcpServers['chrome-devtools'].requestTimeoutMs, 360000);
    assert.equal(prepared.mcpServers['chrome-devtools'].lifecycle, 'lazy');
    assert.deepEqual(prepared.mcpServers['chrome-devtools'].args.slice(1), browser.args.slice(1));
    const endpoint = new URL(prepared.mcpServers['chrome-devtools'].args[0].slice('--wsEndpoint='.length));
    assert.deepEqual(endpoint.searchParams.getAll('keep_alive'), ['360000']);
    assert.equal(endpoint.searchParams.get('custom'), 'keep');
    assertArchived(f, 'mcp.json.migrated', original);
    if (regenerate) assert.equal(f.prepare(true), true);
    else f.load();
    assert.equal(readFileSync(f.target, 'utf8'), bytes);
    assert.equal(lstatSync(f.target).mode & 0o777, 0o600);
  });
}

for (const endpoint of [
  'wss://example.test/?keep_alive=180000',
  'wss://api.cloudflare.com:8443/client/v4/accounts/a/browser-rendering/devtools/browser?keep_alive=180000',
  'wss://user:secret@api.cloudflare.com/client/v4/accounts/a/browser-rendering/devtools/browser?keep_alive=180000',
  'wss://api.cloudflare.com/client/v4/accounts/a/unrelated?keep_alive=180000',
]) {
  test(`REQ-BROWSER-009 AC6: timeout policy leaves unrelated endpoint routing unchanged (${endpoint})`, async t => {
    const f = await fixture(t);
    const browser = { command: 'custom-browser', args: [`--wsEndpoint=${endpoint}`] };
    writeFileSync(f.target, JSON.stringify({ mcpServers: { 'chrome-devtools': browser } }));
    assert.equal(f.prepare(), true);
    const prepared = JSON.parse(readFileSync(f.target, 'utf8'));
    assert.deepEqual(prepared.mcpServers['chrome-devtools'], browser);
    assert.equal(prepared.settings?.requestTimeoutMs, 360000);
  });
}

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
  assertArchived(f, 'mcp-adapter.json.migrated', legacyConfig);
  assert.equal(readFileSync(f.backup, 'utf8'), 'preserved backup');
  assert.equal(readFileSync(f.target, 'utf8'), '{}');
  writeFileSync(f.legacy, legacyConfig); // A new restore must also be recoverable.
  assert.equal(f.migrate(), true);
  assert.equal(existsSync(f.legacy), false);
  assertArchived(f, 'mcp-adapter.json.migrated', legacyConfig);
  assert.equal(readFileSync(f.backup, 'utf8'), 'preserved backup');
});

for (const [name, content] of [['malformed', '{invalid'], ['array', '[]'], ['invalid servers', '{"mcpServers":[]}'], ['empty', '']]) {
  test(`${name} legacy configuration is archived without discarding bytes and recovers a valid adapter`, async (t) => {
    const f = await fixture(t);
    writeFileSync(f.legacy, content);
    assert.equal(f.migrate(), true);
    assertArchived(f, 'mcp-adapter.json.migrated', content);
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
  assertArchived(f, 'mcp.json.invalid', '{invalid');
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
    assertArchived(f, 'mcp-adapter.json.migrated', legacyConfig);
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
  assertArchived(f, 'mcp-adapter.json.migrated', '{invalid');
  assert.equal(existsSync(f.legacy), false);
});

for (const legacy of [undefined, '{invalid legacy']) {
  test(`invalid adapter with ${legacy === undefined ? 'missing' : 'invalid'} legacy preserves originals before empty recovery`, async t => {
    const f = await fixture(t);
    writeFileSync(f.target, '{invalid adapter');
    if (legacy !== undefined) writeFileSync(f.legacy, legacy);
    assert.equal(f.migrate(), true);
    assertArchived(f, 'mcp.json.invalid', '{invalid adapter');
    if (legacy !== undefined) assertArchived(f, 'mcp-adapter.json.migrated', legacy);
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

function startConsult(home, restoredLegacy, overrides = {}) {
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
  python3 - "$RESTORED_LEGACY" "$USER_HOME" "\${RCLONE_FILTERS[@]}" <<'BASELINE'
import pathlib, re, shutil, sys
args=sys.argv[3:]
rules=[args[i+1] for i in range(len(args)-1) if args[i] == '--filter']
def included(key):
    for rule in rules:
        action, pattern = rule[:2], rule[2:]
        anchored = pattern.startswith('/')
        pattern = pattern.lstrip('/') if anchored else pattern
        expression = re.escape(pattern).replace(r'\\*\\*', '.*').replace(r'\\*', '[^/]*').replace(r'\\?', '[^/]')
        candidates = [key] if anchored else [key] + [key[i+1:] for i, char in enumerate(key) if char == '/']
        if any(re.fullmatch(expression, candidate) for candidate in candidates):
            return action != '- '
    return True
source, destination = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
for obj in source.rglob('*'):
    if obj.is_file() and included(obj.relative_to(source).as_posix()):
        target = destination / obj.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(obj, target)
BASELINE
fi`], {
    encoding: 'utf8',
    env: { ...process.env, USER_HOME: home, USER_CLAUDE_JSON: join(home, '.claude.json'),
      MIGRATION_MODULE: join(repo, 'preseed/agents/pi/extensions/00-mcp-adapter-config.ts'),
      RESTORED_LEGACY: restoredLegacy || '', CODEFLARE_OPENAI_API_KEY: 'synthetic-openai', CODEFLARE_GEMINI_API_KEY: '', ENTERPRISE_MODE: '', ...overrides,
    },
  });
}

test('REQ-AGENT-069: startup bootstraps consult-llm at the adapter filename, lazily, without creating legacy', async (t) => {
  const f = await fixture(t);
  const result = startConsult(f.home);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(readFileSync(f.target, 'utf8'));
  assert.equal(config.mcpServers['consult-llm'].lifecycle, 'lazy');
  assert.equal(config.settings.requestTimeoutMs, 360000,
    'fresh configuration must retain the fixed six-minute request budget');
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
  assert.deepEqual(updated.settings, { ...config.settings, requestTimeoutMs: 360000 });
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
  const original = JSON.parse(target);
  assert.deepEqual(JSON.parse(readFileSync(f.target, 'utf8')), {
    ...original, settings: { ...original.settings, requestTimeoutMs: 360000 },
  });
  assertArchived(f, 'mcp.json.migrated', target);
  assert.equal(readFileSync(f.backup, 'utf8'), legacyConfig);
  assert.equal(existsSync(f.legacy), false);
});

test('REQ-AGENT-069: startup recovers malformed legacy and bootstraps lazy consult without changing Claude behavior', async (t) => {
  const f = await fixture(t);
  writeFileSync(f.legacy, '{invalid');
  const result = startConsult(f.home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.legacy), false);
  assertArchived(f, 'mcp-adapter.json.migrated', '{invalid');
  assert.equal(JSON.parse(readFileSync(f.target, 'utf8')).mcpServers['consult-llm'].lifecycle, 'lazy');
  assert.equal(JSON.parse(readFileSync(join(f.home, '.claude.json'), 'utf8')).mcpServers['consult-llm'].command, 'consult-llm-mcp');
});


test('REQ-AGENT-217: active mcp.json and recovery objects remain baseline-sync eligible', async t => {
  const f = await fixture(t);
  const restored = join(f.home, 'remote');
  const remoteAgent = join(restored, '.pi', 'agent');
  mkdirSync(join(remoteAgent, 'nested'), { recursive: true });
  const remoteAdapter = { mcpServers: { 'consult-llm': { command: 'consult-llm-mcp', lifecycle: 'lazy' } }, settings: { restored: true } };
  writeFileSync(join(remoteAgent, 'mcp-adapter.json'), legacyConfig);
  writeFileSync(join(remoteAgent, 'mcp.json'), JSON.stringify(remoteAdapter));
  writeFileSync(join(remoteAgent, 'mcp-adapter.json.migrated.baseline'), 'remote recovery bytes');
  writeFileSync(join(remoteAgent, 'nested', 'mcp-adapter.json'), 'unrelated nested bytes');
  writeFileSync(f.legacy, legacyConfig);
  writeFileSync(f.target, '{}');
  writeFileSync(f.backup, 'old passive archive');
  const result = startConsult(f.home, restored);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.legacy, 'utf8'), legacyConfig, 'the handoff must not introduce a new sync exclusion');
  assert.deepEqual(JSON.parse(readFileSync(f.target, 'utf8')), remoteAdapter);
  assert.equal(readFileSync(join(f.directory, 'mcp-adapter.json.migrated.baseline'), 'utf8'), 'remote recovery bytes');
  assert.equal(readFileSync(join(f.directory, 'nested', 'mcp-adapter.json'), 'utf8'), 'unrelated nested bytes');
  assertArchived(f, 'mcp-adapter.json.migrated', legacyConfig);
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
  assert.deepEqual(updated.settings, { ...config.settings, requestTimeoutMs: 360000 });
});


for (const location of ['target', 'legacy']) {
  for (const customization of ['arguments', 'environment', 'server-fields', 'browser-headers', 'browser-endpoint']) {
    test(`startup preserves canonical-command ${customization} customization from ${location}`, async (t) => {
      const f = await fixture(t);
      const server = { command: 'consult-llm-mcp', args: [], env: { OPENAI_API_KEY: 'synthetic-custom-provider' }, lifecycle: 'lazy' };
      if (customization === 'arguments') server.args = ['--user-owned-option'];
      if (customization === 'environment') server.env.USER_OWNED_TOKEN = 'synthetic-user-secret';
      if (customization === 'server-fields') server.description = 'user-owned description';
      const original = { settings: { custom: true }, mcpServers: { 'consult-llm': server,
        'chrome-devtools': { command: '/opt/codeflare/bin/chrome-devtools-mcp',
          args: ['--wsEndpoint=wss://custom.example.test', '--wsHeaders={"X-Custom":"synthetic"}', '--user-owned-option'] } } };
      if (customization.startsWith('browser-')) {
        server.args = ['--user-owned-option'];
        original.mcpServers['chrome-devtools'].args = [
          '--wsEndpoint=wss://api.cloudflare.com/client/v4/accounts/custom/browser-rendering/devtools/browser',
          '--wsHeaders={"Authorization":"Bearer synthetic","X-Custom":"synthetic-user-value"}',
        ];
        if (customization === 'browser-endpoint') original.mcpServers['chrome-devtools'].args = [
          '--wsEndpoint=wss://custom.example.test', '--wsHeaders={"Authorization":"Bearer synthetic"}',
        ];
      }
      const bytes = JSON.stringify(original);
      writeFileSync(f[location], bytes);
      assert.equal(f.migrate(true), true);
      assert.deepEqual(JSON.parse(readFileSync(f.target, 'utf8')), original);
      assert.equal(existsSync(f.legacy), false);
      if (location === 'legacy') assert.equal(readFileSync(f.target, 'utf8'), bytes);
    });
  }
}

test('startup preserves selected custom legacy originals before regenerating owned entries', async (t) => {
  const f = await fixture(t);
  const original = { imports: ['user-owned-import'], settings: { custom: true },
    mcpServers: { 'consult-llm': { command: 'consult-llm-mcp', args: [], env: { OPENAI_API_KEY: 'synthetic-old-generated' }, lifecycle: 'lazy' } } };
  const bytes = JSON.stringify(original);
  writeFileSync(f.legacy, bytes);
  assert.equal(f.migrate(true), true);
  assertArchived(f, 'mcp-adapter.json.migrated', bytes);
  assert.deepEqual(JSON.parse(readFileSync(f.target, 'utf8')), { ...original, mcpServers: {} });
  assert.equal(existsSync(f.legacy), false);
});

// POSIX permissions are observable only for an unprivileged runner.
test('unreadable passive archive cannot block custom legacy recovery', { skip: process.getuid?.() === 0 }, async (t) => {
  const f = await fixture(t);
  writeFileSync(f.target, '{}');
  writeFileSync(f.legacy, legacyConfig);
  writeFileSync(f.backup, legacyConfig);
  chmodSync(f.backup, 0o000);
  assert.equal(f.migrate(), true);
  assert.equal(existsSync(f.legacy), false);
  assert.equal(readFileSync(f.target, 'utf8'), '{}');
  assert.equal(lstatSync(f.backup).mode & 0o777, 0o000);
  const recoverable = readdirSync(f.directory).filter(name => name.startsWith('mcp-adapter.json.migrated.') && lstatSync(join(f.directory, name)).isFile());
  assert.ok(recoverable.some(name => readFileSync(join(f.directory, name), 'utf8') === legacyConfig));
});

test('REQ-AGENT-217: failed preparation does not exclude restored legacy from baseline', async (t) => {
  const f = await fixture(t);
  const outside = join(f.home, 'unsafe-target');
  writeFileSync(outside, 'external original');
  symlinkSync(outside, f.target);
  const remote = join(f.home, 'remote-failed-preparation');
  mkdirSync(join(remote, '.pi', 'agent'), { recursive: true });
  writeFileSync(join(remote, '.pi', 'agent', 'mcp-adapter.json'), legacyConfig);
  const result = startConsult(f.home, remote);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.legacy, 'utf8'), legacyConfig);
  assert.equal(readFileSync(outside, 'utf8'), 'external original');
});

test('replacement write failure preserves the original custom adapter for recovery', async (t) => {
  const f = await fixture(t);
  const original = JSON.stringify({ settings: { custom: true }, mcpServers: {
    'consult-llm': { command: 'consult-llm-mcp', args: [], env: { OPENAI_API_KEY: 'synthetic-generated' }, lifecycle: 'lazy' },
    custom: { command: 'user-server', env: { TOKEN: 'synthetic-private' } },
  } });
  writeFileSync(f.target, original, { mode: 0o600 });
  const write = fs.writeFileSync;
  try {
    // Inject ENOSPC at the filesystem boundary, not inside the migration.
    fs.writeFileSync = (path, ...args) => {
      if (path === f.target) throw Object.assign(new Error('Synthetic full disk'), { code: 'ENOSPC' });
      return write(path, ...args);
    };
    syncBuiltinESMExports();
    assert.equal(f.migrate(true), false);
    assertArchived(f, 'mcp.json.migrated', original);
  } finally {
    fs.writeFileSync = write;
    syncBuiltinESMExports();
  }
});

for (const mode of ['no-provider', 'enterprise']) {
  test(`REQ-AGENT-069: ${mode} startup preserves customized Pi consult while retaining Claude cleanup`, async (t) => {
    const f = await fixture(t);
    const original = { settings: { custom: true }, mcpServers: {
      'consult-llm': { command: 'consult-llm-mcp', args: ['--user-option'], env: { USER_TOKEN: 'synthetic-private' } },
      unrelated: { command: 'user-server' },
    } };
    writeFileSync(f.target, JSON.stringify(original));
    const claude = join(f.home, '.claude.json');
    writeFileSync(claude, JSON.stringify({ mcpServers: { 'consult-llm': { command: 'consult-llm-mcp' }, unrelated: { command: 'keep' } } }));
    const result = startConsult(f.home, undefined, {
      CODEFLARE_OPENAI_API_KEY: '', ENTERPRISE_MODE: mode === 'enterprise' ? 'active' : '',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(f.target, 'utf8')), {
      ...original, settings: { ...original.settings, requestTimeoutMs: 360000 },
    });
    assertArchived(f, 'mcp.json.migrated', JSON.stringify(original));
    assert.deepEqual(JSON.parse(readFileSync(claude, 'utf8')).mcpServers, { unrelated: { command: 'keep' } });
  });
}

for (const lifecycle of ['lazy-keep-alive', 'lazy-keepalive']) {
  test(`REQ-AGENT-217: ${lifecycle} handoff preserves authentication and supports the replacement lifecycle`, async t => {
    const f = await fixture(t);
    const original = { mcpServers: {
      'chrome-devtools': { command: 'custom-browser', args: ['--wsEndpoint=wss://example.test/?keep_alive=360000', '--wsHeaders={"Authorization":"Bearer synthetic"}'],
        env: { NODE_EXTRA_CA_CERTS: '/synthetic/ca.pem' }, lifecycle, requestTimeoutMs: 360000 },
      custom: { command: 'custom', env: { TOKEN: 'synthetic' }, lifecycle: 'eager' },
    }, settings: { requestTimeoutMs: 360000 } };
    const bytes = JSON.stringify(original);
    writeFileSync(f.legacy, bytes, { mode: 0o600 });
    f.load();
    const prepared = JSON.parse(readFileSync(f.target, 'utf8'));
    assert.deepEqual(prepared, { ...original, mcpServers: { ...original.mcpServers,
      'chrome-devtools': { ...original.mcpServers['chrome-devtools'], lifecycle: 'lazy' } } });
    assertArchived(f, 'mcp-adapter.json.migrated', bytes);
    const once = readFileSync(f.target, 'utf8');
    f.load();
    assert.equal(readFileSync(f.target, 'utf8'), once);
    assert.equal(lstatSync(f.target).mode & 0o777, 0o600);
    assert.equal(existsSync(f.legacy), false);
  });
}


test('REQ-AGENT-069: generated Pi provider environment preserves a literal leading exclamation mark', async t => {
  const f = await fixture(t);
  const result = startConsult(f.home, undefined, { CODEFLARE_OPENAI_API_KEY: '!synthetic-openai' });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(readFileSync(f.target, 'utf8'));
  assert.equal(config.mcpServers['consult-llm'].env.OPENAI_API_KEY, '!synthetic-openai');
});


for (const regenerate of [false, true]) {
  test(`REQ-AGENT-217: selected adapter escaped env literals decode once before handoff (regenerate=${regenerate})`, async t => {
    const f = await fixture(t);
    const original = { settings: { requestTimeoutMs: 360000 }, mcpServers: {
      custom: { command: 'synthetic-custom-server', args: ['--synthetic-argument'], lifecycle: 'lazy',
        env: { ONE: '!!synthetic', TWO: '!!!synthetic', PLAIN: 'synthetic', NODE_EXTRA_CA_CERTS: '/synthetic/ca.pem' },
        headers: { 'X-Synthetic': '!!unchanged-header' } },
    } };
    const bytes = JSON.stringify(original);
    writeFileSync(f.legacy, bytes, { mode: 0o600 });
    if (regenerate) assert.equal(f.prepare(true), true); else f.load();
    const migrated = JSON.parse(readFileSync(f.target, 'utf8'));
    assert.deepEqual(migrated, { ...original, mcpServers: { custom: { ...original.mcpServers.custom,
      env: { ...original.mcpServers.custom.env, ONE: '!synthetic', TWO: '!!synthetic' } } } });
    assertArchived(f, 'mcp-adapter.json.migrated', bytes);
    const once = readFileSync(f.target, 'utf8');
    if (regenerate) assert.equal(f.prepare(true), true); else f.load();
    assert.equal(readFileSync(f.target, 'utf8'), once, 'destination literals must not decode again');
    assert.equal(existsSync(f.legacy), false);
  });
}

for (const expression of ['!synthetic-command', '${SYNTHETIC_VAR}', '$env:SYNTHETIC_VAR', '{env:SYNTHETIC_VAR}', '!!synthetic-${SYNTHETIC_VAR}']) {
  for (const regenerate of [false, true]) {
    for (const invalidDestination of [false, true]) {
      test(`REQ-AGENT-217: unsupported selected env expression fails before writes (${expression}, regenerate=${regenerate}, invalidDestination=${invalidDestination})`, async t => {
        const f = await fixture(t);
        const bytes = JSON.stringify({ mcpServers: {
          first: { command: 'synthetic-first', env: { DECODE: '!!synthetic-first' } },
          custom: { command: 'synthetic-custom-server', env: { SYNTHETIC: expression } },
        } });
        writeFileSync(f.legacy, bytes);
        if (invalidDestination) writeFileSync(f.target, '{synthetic-invalid');
        const before = readdirSync(f.directory).sort();
        assert.equal(f.prepare(regenerate), false);
        assert.equal(readFileSync(f.legacy, 'utf8'), bytes);
        assert.deepEqual(readdirSync(f.directory).sort(), before, 'failure must not write even a partial archive or active file');
        if (invalidDestination) assert.equal(readFileSync(f.target, 'utf8'), '{synthetic-invalid');
        else assert.equal(existsSync(f.target), false);
        if (!regenerate) {
          f.load();
          assert.equal(readFileSync(f.legacy, 'utf8'), bytes);
          assert.deepEqual(readdirSync(f.directory).sort(), before);
        }
      });
    }
  }
}

for (const regenerate of [false, true]) {
  test(`REQ-AGENT-217: valid destination env literals win over unsupported adapter expressions (regenerate=${regenerate})`, async t => {
    const f = await fixture(t);
    const target = JSON.stringify({ settings: { requestTimeoutMs: 360000 }, mcpServers: {
      custom: { command: 'synthetic-custom-server', env: { SYNTHETIC: '!!synthetic-destination', ALSO_LITERAL: '${SYNTHETIC_DESTINATION}' } },
    } });
    const legacy = JSON.stringify({ mcpServers: { custom: { command: 'synthetic-old', env: { SYNTHETIC: '!synthetic-command' } } } });
    writeFileSync(f.target, target);
    writeFileSync(f.legacy, legacy);
    if (regenerate) assert.equal(f.prepare(true), true); else f.load();
    assert.equal(readFileSync(f.target, 'utf8'), target);
    assertArchived(f, 'mcp-adapter.json.migrated', legacy);
    assert.equal(existsSync(f.legacy), false);
    if (regenerate) assert.equal(f.prepare(true), true); else f.load();
    assert.equal(readFileSync(f.target, 'utf8'), target);
  });
}


test('REQ-AGENT-217: rejected legacy env produces a content-free managed-load diagnostic', async t => {
  const f = await fixture(t);
  const bytes = JSON.stringify({ mcpServers: { custom: { command: 'synthetic', env: { SYNTHETIC: '!synthetic-private-command' } } } });
  writeFileSync(f.legacy, bytes);
  const handlers = new Map();
  f.load({ on: (event, handler) => handlers.set(event, handler) });
  const notifications = [];
  handlers.get('session_start')({}, { ui: { notify: message => notifications.push(message) } });
  assert.match(notifications.join(' '), /legacy environment expressions/);
  assert.equal(notifications.join(' ').includes('synthetic-private-command'), false, 'diagnostics must not expose an expression');
  assert.equal(readFileSync(f.legacy, 'utf8'), bytes);
  assert.equal(existsSync(f.target), false);
});


test('REQ-AGENT-217: entrypoint preparation decodes selected custom consult env before preserved-entry merge', async t => {
  const f = await fixture(t);
  const original = { settings: { requestTimeoutMs: 360000 }, mcpServers: {
    'consult-llm': { command: 'consult-llm-mcp', args: ['--synthetic-user-owned'], lifecycle: 'lazy',
      env: { OPENAI_API_KEY: '!!synthetic-custom-provider', NODE_EXTRA_CA_CERTS: '/synthetic/ca.pem' } },
  } };
  const bytes = JSON.stringify(original);
  writeFileSync(f.legacy, bytes);
  const result = startConsult(f.home);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.target, 'utf8')), { ...original, mcpServers: {
    'consult-llm': { ...original.mcpServers['consult-llm'], env: { ...original.mcpServers['consult-llm'].env, OPENAI_API_KEY: '!synthetic-custom-provider' } },
  } });
  assertArchived(f, 'mcp-adapter.json.migrated', bytes);
});

for (const expression of ['!synthetic-command', '${SYNTHETIC_VAR}', '$env:SYNTHETIC_VAR', '{env:SYNTHETIC_VAR}']) {
  test(`REQ-AGENT-217: rejected selected legacy env blocks entrypoint Pi merge (${expression})`, async t => {
    const f = await fixture(t);
    const bytes = JSON.stringify({ mcpServers: { 'consult-llm': { command: 'consult-llm-mcp', env: { OPENAI_API_KEY: expression } } } });
    writeFileSync(f.legacy, bytes);
    const result = startConsult(f.home);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(f.legacy, 'utf8'), bytes);
    assert.equal(existsSync(f.target), false, 'failed semantic preparation must block active Pi config creation');
  });
}
