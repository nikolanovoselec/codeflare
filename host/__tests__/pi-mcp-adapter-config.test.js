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
  const { default: register, migratePiMcpAdapterConfig, preparePiMcpAdapterConfig } = await import('../../preseed/agents/pi/extensions/00-mcp-adapter-config.ts');
  const home = mkdtempSync(join(tmpdir(), 'pi-adapter-config-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, '.pi', 'agent');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-extension@1.12.1'], extensions: ['-builtin:mcp'] }));
  return { home, directory, legacy: join(directory, 'mcp-adapter.json'), target: join(directory, 'mcp.json'), backup: join(directory, 'mcp-adapter.json.migrated'),
    migrate: (regenerate = false) => migratePiMcpAdapterConfig(directory, regenerate),
    prepare: (regenerate = false) => migratePiMcpAdapterConfig(directory, regenerate, true),
    native: (regenerate = false) => preparePiMcpAdapterConfig(directory, regenerate),
    selectAdapter: () => writeFileSync(join(directory, 'settings.json'), JSON.stringify({ packages: ['npm:pi-mcp-adapter@5.3.1'], extensions: ['-builtin:mcp'] })),
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
      } else assert.ok(notifications.some(({ level }) => level === 'warning'));
    }
  });
}

for (const exclusion of [
  '-local-mcp-runtime/npm/node_modules/pi-mcp-extension/src/index.ts',
  '-./local-mcp-runtime/npm/node_modules/pi-mcp-extension/src/index.ts',
  '-**/node_modules/pi-mcp-extension/src/index.ts',
  '-local-mcp-runtime/**',
  '-**/*.ts',
  '-local-mcp-runtime/npm/node_modules/pi-mcp-extension',
]) {
  test(`REQ-AGENT-217: default loader preserves files for relative or unsupported global exclusion (${exclusion})`, async t => {
    const f = await fixture(t);
    const entry = join(f.directory, 'local-mcp-runtime/npm/node_modules/pi-mcp-extension/src/index.ts');
    writeFileSync(join(f.directory, 'settings.json'), JSON.stringify({ extensions: [entry, exclusion] }));
    writeFileSync(f.legacy, legacyConfig);
    const target = '{"mcpServers":{},"settings":{"native":true}}\n';
    writeFileSync(f.target, target);
    const before = readdirSync(f.directory).sort();
    const notifications = [];
    f.load({ on(event, handler) {
      if (event === 'session_start') handler({}, { ui: { notify: (message, level) => notifications.push({ message, level }) } });
    } });
    assert.equal(readFileSync(f.legacy, 'utf8'), legacyConfig);
    assert.equal(readFileSync(f.target, 'utf8'), target);
    assert.deepEqual(readdirSync(f.directory).sort(), before, 'skipped handoff must not archive or write configuration');
    assert.ok(notifications.some(({ message, level }) => level === 'warning' && /selection.*ambiguous|ambiguous.*selection/i.test(message)));
    for (const { message } of notifications) assert.doesNotMatch(message, /synthetic|pi-mcp-extension|local-mcp-runtime|TOKEN/);
  });
}

test('REQ-AGENT-217: exact relative retired companion exclusion does not disable stock handoff', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.directory, 'settings.json'), JSON.stringify({ packages: [stock], extensions: ['-extensions/mcp-portal-oauth.ts'] }));
  writeFileSync(f.legacy, legacyConfig);
  f.load();
  assert.equal(existsSync(f.legacy), false);
  assert.equal(JSON.parse(readFileSync(f.target, 'utf8')).settings.requestTimeoutMs, 360000);
  assertArchived(f, 'mcp-adapter.json.migrated', legacyConfig);
});

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
    assert.deepEqual(endpoint.searchParams.getAll('keep_alive'), ['1200000']);
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


// Exact managed non-client exclusions must not change MCP client selection.
for (const form of ['absolute', 'relative', 'dot-relative', 'canonical']) {
  for (const owner of ['stock', 'adapter', 'ambiguous', 'unknown']) {
    test(`REQ-AGENT-217 AC1/AC2/AC7: Review exclusions preserve selected client behavior (${form}, ${owner})`, async t => {
      const f = await fixture(t);
      const prefix = form === 'absolute' ? `${f.directory}/extensions/`
        : form === 'canonical' ? '/home/user/.pi/agent/extensions/'
        : form === 'dot-relative' ? './extensions/' : 'extensions/';
      const stockSource = 'npm:pi-mcp-extension@1.12.1';
      const adapterSource = 'npm:pi-mcp-adapter@5.3.1';
      const packages = owner === 'stock' ? [stockSource] : owner === 'adapter' ? [adapterSource]
        : owner === 'ambiguous' ? [stockSource, adapterSource] : [];
      writeFileSync(join(f.directory, 'settings.json'), JSON.stringify({ packages,
        extensions: ['-builtin:mcp', ...['review-enforcement.ts', 'operator-review-remote.ts']
          .map(name => `-${prefix}${name}`)],
      }));
      const target = '{"mcpServers":{"preferred":{"command":"user-command"}},"settings":{"custom":true}}\n';
      writeFileSync(f.legacy, legacyConfig);
      writeFileSync(f.target, target);
      const before = readdirSync(f.directory).sort();
      const notifications = [];
      const pi = { on(event, handler) {
        if (event === 'session_start') handler({}, { ui: { notify(message, level) {
          notifications.push({ message, level });
        } } });
      } };
      f.load(pi);
      f.load(pi);
      if (owner === 'stock') {
        assert.equal(existsSync(f.legacy), false);
        assert.deepEqual(JSON.parse(readFileSync(f.target, 'utf8')), {
          mcpServers: { preferred: { command: 'user-command' } },
          settings: { custom: true, requestTimeoutMs: 360000 },
        });
        assertArchived(f, 'mcp-adapter.json.migrated', legacyConfig);
        assertArchived(f, 'mcp.json.migrated', target);
        assert.deepEqual(notifications, []);
      } else {
        assert.equal(readFileSync(f.legacy, 'utf8'), legacyConfig);
        assert.equal(readFileSync(f.target, 'utf8'), target);
        assert.deepEqual(readdirSync(f.directory).sort(), before);
        if (owner === 'adapter') assert.ok(notifications.some(({ level }) => level === 'warning'));
        else assert.ok(notifications.some(({ message, level }) =>
          level === 'warning' && /selection.*ambiguous|ambiguous.*selection/i.test(message)));
      }
    });
  }
}

for (const exclusion of ['-custom/review-enforcement.ts', '-extensions/operator-review-remote.ts.extra',
  '-extensions/*review*.ts']) {
  test(`REQ-AGENT-217 AC1: Review exception does not authorize other exclusions (${exclusion})`, async t => {
    const f = await fixture(t);
    writeFileSync(join(f.directory, 'settings.json'), JSON.stringify({
      packages: ['npm:pi-mcp-extension@1.12.1'], extensions: [exclusion],
    }));
    writeFileSync(f.legacy, legacyConfig);
    const before = readdirSync(f.directory).sort();
    const notifications = [];
    f.load({ on(event, handler) {
      if (event === 'session_start') handler({}, { ui: { notify(message, level) {
        notifications.push({ message, level });
      } } });
    } });
    assert.equal(readFileSync(f.legacy, 'utf8'), legacyConfig);
    assert.deepEqual(readdirSync(f.directory).sort(), before);
    assert.ok(notifications.some(({ message, level }) =>
      level === 'warning' && /selection.*ambiguous|ambiguous.*selection/i.test(message)));
  });
}


// Native restore contracts: adapter file, public settings, no auth-store import.
test('REQ-AGENT-217: selected adapter prepares its native filename on load and reload', async t => {
  const f = await fixture(t);
  f.selectAdapter();
  f.load();
  assert.deepEqual(JSON.parse(readFileSync(f.legacy, 'utf8')), { settings: { requestTimeoutMs: 360000, deferWithMissingMetadata: true } });
  assert.equal(existsSync(f.target), false);
  const before = readdirSync(f.directory).sort();
  const bytes = readFileSync(f.legacy, 'utf8');
  f.load();
  assert.equal(readFileSync(f.legacy, 'utf8'), bytes);
  assert.deepEqual(readdirSync(f.directory).sort(), before);
  assert.equal(lstatSync(f.legacy).mode & 0o777, 0o600);
});

test('REQ-AGENT-217: native restore retains commands, headers, CA, idle minutes, auto-auth and custom timeouts', async t => {
  const f = await fixture(t);
  f.selectAdapter();
  const custom = { command: 'custom', env: { TOKEN: '!trusted-native-command', NODE_EXTRA_CA_CERTS: '/synthetic/ca.pem' },
    args: ['${NATIVE_OPTION}'], lifecycle: 'lazy-keep-alive', idleTimeout: 27, requestTimeoutMs: 2400 };
  const remote = { url: 'https://example.test/mcp', headers: { Authorization: '!!native-literal' },
    requestHeadersCommand: { command: 'trusted-native-headers' }, caFile: '/synthetic/remote-ca.pem', auth: false };
  const original = JSON.stringify({ mcpServers: { custom, remote }, settings: { autoAuth: false, idleTimeout: 19, requestTimeoutMs: 5000 } });
  writeFileSync(f.legacy, original, { mode: 0o600 });
  const auth = join(f.directory, 'mcp-auth.json');
  const authBytes = '{"synthetic-private-oauth":{"access_token":"synthetic-private-token"}}';
  writeFileSync(auth, authBytes);
  f.load();
  assert.deepEqual(JSON.parse(readFileSync(f.legacy, 'utf8')), { mcpServers: { custom, remote },
    settings: { autoAuth: false, idleTimeout: 19, requestTimeoutMs: 360000, deferWithMissingMetadata: true } });
  assertArchived(f, 'mcp-adapter.json.migrated', original);
  assert.equal(readFileSync(auth, 'utf8'), authBytes);
  assert.doesNotMatch(readFileSync(f.legacy, 'utf8'), /synthetic-private/);
  assert.equal(existsSync(f.target), false);
});

test('REQ-BROWSER-009: native browser has explicit progress-resetting request timeout and lazy idle behavior', async t => {
  const f = await fixture(t);
  const browser = { command: 'custom-browser', args: [
    '--wsEndpoint=wss://api.cloudflare.com/client/v4/accounts/synthetic/browser-rendering/devtools/browser?keep_alive=600000',
    '--wsHeaders={"Authorization":"Bearer synthetic-custom","X-Custom":"keep"}',
  ], env: { NODE_EXTRA_CA_CERTS: '/synthetic/ca.pem' }, idleTimeout: 10, lifecycle: 'lazy-keep-alive' };
  writeFileSync(f.legacy, JSON.stringify({ mcpServers: { 'chrome-devtools': browser } }));
  assert.equal(f.native(), true);
  const prepared = JSON.parse(readFileSync(f.legacy, 'utf8'));
  assert.deepEqual(prepared.mcpServers['chrome-devtools'], { ...browser, requestTimeoutMs: 360000,
    args: [browser.args[0].replace('600000', '1200000'), browser.args[1]] });
  assert.equal(prepared.settings.requestTimeoutMs, 360000);
});

test('REQ-AGENT-217: compatible stock literals merge disjoint servers with exact stock recovery and untouched OAuth stores', async t => {
  const f = await fixture(t);
  f.selectAdapter();
  const nativeServer = { command: 'native', env: { TOKEN: '!!native' }, idleTimeout: 31, requestTimeoutMs: 9000 };
  writeFileSync(f.legacy, JSON.stringify({ mcpServers: { native: nativeServer }, settings: { autoAuth: true } }));
  const stockConfig = { mcpServers: {
    stock: { command: 'stock-command', args: ['--literal'], cwd: '/synthetic', transport: 'stdio', env: { ONE: '!literal', TWO: '!!literal', NODE_EXTRA_CA_CERTS: '/synthetic/ca.pem' }, requestTimeoutMs: 2000, lifecycle: 'lazy' },
    remote: { url: 'https://example.test/mcp', transport: 'streamable-http', headers: { Authorization: '!literal-header' } },
  }, settings: { requestTimeoutMs: 60000, deferWithMissingMetadata: true } };
  const bytes = JSON.stringify(stockConfig);
  writeFileSync(f.target, bytes);
  writeFileSync(join(f.directory, 'mcp-auth.json'), 'private raw OAuth, deliberately not valid JSON');
  f.load();
  const prepared = JSON.parse(readFileSync(f.legacy, 'utf8'));
  assert.equal(existsSync(f.target), false);
  assertArchived(f, 'mcp.json.migrated', bytes);
  assert.equal(readFileSync(join(f.directory, 'mcp-auth.json'), 'utf8'), 'private raw OAuth, deliberately not valid JSON');
  assert.deepEqual(prepared.settings, { requestTimeoutMs: 360000, deferWithMissingMetadata: true, autoAuth: true });
  assert.deepEqual(prepared.mcpServers.native, nativeServer);
  const { transport, ...stockServer } = stockConfig.mcpServers.stock;
  assert.deepEqual(prepared.mcpServers.stock, { ...stockServer, env: { ONE: '!!literal', TWO: '!!!literal', NODE_EXTRA_CA_CERTS: '/synthetic/ca.pem' } });
  assert.deepEqual(prepared.mcpServers.remote, { url: 'https://example.test/mcp', headers: { Authorization: '!!literal-header' }, httpTransport: 'streamable-http', auth: false });
  const once = readFileSync(f.legacy, 'utf8');
  const inventory = readdirSync(f.directory).sort();
  assert.equal(f.native(), true);
  assert.equal(readFileSync(f.legacy, 'utf8'), once);
  assert.deepEqual(readdirSync(f.directory).sort(), inventory);
});

for (const [name, stockConfig] of [
  ['env interpolation', { mcpServers: { custom: { command: 'custom', env: { TOKEN: '${SYNTHETIC_PRIVATE}' } } } }],
  ['argument interpolation', { mcpServers: { custom: { command: 'custom', args: ['$env:SYNTHETIC_PRIVATE'] } } }],
  ['header interpolation', { mcpServers: { custom: { url: 'https://example.test', headers: { Authorization: '{env:SYNTHETIC_PRIVATE}' } } } }],
  ['expression resembling malformed interpolation', { mcpServers: { custom: { command: 'custom', env: { TOKEN: '${SYNTHETIC:-private}' } } } }],
  ['home expansion', { mcpServers: { custom: { command: '~/synthetic-private' } } }],
  ['raw OAuth', { mcpServers: { custom: { url: 'https://example.test', auth: { type: 'oauth', clientSecret: 'synthetic-private' } } } }],
  ['provider auth', { mcpServers: { custom: { url: 'https://example.test', auth: { provider: 'synthetic-private' } } } }],
  ['unknown field', { mcpServers: { custom: { command: 'custom', disabled: true } } }],
  ['unknown settings', { settings: { autoAuth: true } }],
  ['imports', { imports: ['synthetic-private'] }],
  ['two transports', { mcpServers: { custom: { command: 'custom', url: 'https://example.test' } } }],
  ['conflicting aliases', { mcpServers: { custom: { command: 'custom', transport: 'stdio', type: 'http' } } }],
  ['partial server', { mcpServers: { custom: { lifecycle: 'lazy' } } }],
  ['malformed env', { mcpServers: { custom: { command: 'custom', env: { TOKEN: 123 } } } }],
  ['unknown lifecycle', { mcpServers: { custom: { command: 'custom', lifecycle: 'keep-alive' } } }],
  ['malformed document', '{synthetic-private'],
]) {
  test(`REQ-AGENT-217: native conversion rejects ${name} without partial writes or content disclosure`, async t => {
    const f = await fixture(t);
    f.selectAdapter();
    const native = '{"mcpServers":{"native":{"command":"native"}},"settings":{"autoAuth":false}}\n';
    const stock = typeof stockConfig === 'string' ? stockConfig : JSON.stringify(stockConfig);
    writeFileSync(f.legacy, native);
    writeFileSync(f.target, stock);
    const before = readdirSync(f.directory).sort();
    assert.equal(f.native(), false);
    const notifications = [];
    f.load({ on(event, handler) {
      if (event === 'session_start') handler({}, { ui: { notify(message, level) { notifications.push({ message, level }); } } });
    } });
    assert.equal(readFileSync(f.legacy, 'utf8'), native);
    assert.equal(readFileSync(f.target, 'utf8'), stock);
    assert.deepEqual(readdirSync(f.directory).sort(), before);
    assert.ok(notifications.some(({ level }) => level === 'warning'));
    for (const { message } of notifications) assert.doesNotMatch(message, /synthetic|TOKEN|example\.test|clientSecret|SYNTHETIC/);
  });
}

for (const collision of ['server', 'setting']) {
  test(`REQ-AGENT-217: native ${collision} collision chooses no winner`, async t => {
    const f = await fixture(t);
    const native = JSON.stringify(collision === 'server' ? { mcpServers: { custom: { command: 'native' } } }
      : { settings: { deferWithMissingMetadata: false } });
    const stock = JSON.stringify(collision === 'server' ? { mcpServers: { custom: { command: 'stock' } } }
      : { settings: { deferWithMissingMetadata: true } });
    writeFileSync(f.legacy, native);
    writeFileSync(f.target, stock);
    const before = readdirSync(f.directory).sort();
    assert.equal(f.native(), false);
    assert.equal(readFileSync(f.legacy, 'utf8'), native);
    assert.equal(readFileSync(f.target, 'utf8'), stock);
    assert.deepEqual(readdirSync(f.directory).sort(), before);
  });
}

for (const path of ['legacy', 'target']) for (const kind of ['symlink', 'directory', 'malformed']) {
  test(`REQ-AGENT-217: native handoff rejects ${path} ${kind} preserving all originals`, async t => {
    const f = await fixture(t);
    const outside = join(f.home, 'outside.json');
    writeFileSync(outside, 'synthetic-private-original');
    if (kind === 'symlink') symlinkSync(outside, f[path]);
    if (kind === 'directory') mkdirSync(f[path]);
    if (kind === 'malformed') writeFileSync(f[path], '{synthetic-private');
    const before = readdirSync(f.directory).sort();
    assert.equal(f.native(), false);
    assert.deepEqual(readdirSync(f.directory).sort(), before);
    assert.equal(readFileSync(outside, 'utf8'), 'synthetic-private-original');
    if (kind === 'symlink') assert.equal(lstatSync(f[path]).isSymbolicLink(), true);
    if (kind === 'malformed') assert.equal(readFileSync(f[path], 'utf8'), '{synthetic-private');
  });
}

for (const race of ['native', 'stock', 'create-native', 'disk-full']) {
  test(`REQ-AGENT-217: native preparation preserves concurrent files on ${race}`, async t => {
    const f = await fixture(t);
    const original = '{"mcpServers":{"native":{"command":"native"}}}';
    if (race !== 'create-native') writeFileSync(f.legacy, original);
    writeFileSync(f.target, '{}');
    const write = fs.writeFileSync;
    let injected = false;
    try {
      fs.writeFileSync = (path, ...args) => {
        if (!injected && typeof path === 'string' && path.endsWith('.tmp')) {
          injected = true;
          if (race === 'disk-full') throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' });
          write(race === 'stock' ? f.target : f.legacy, '{"settings":{"concurrent":true}}');
        }
        return write(path, ...args);
      };
      syncBuiltinESMExports();
      assert.equal(f.native(), false);
    } finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
    assert.equal(readFileSync(f.legacy, 'utf8'), ['native', 'create-native'].includes(race) ? '{"settings":{"concurrent":true}}' : original);
    assert.equal(readFileSync(f.target, 'utf8'), race === 'stock' ? '{"settings":{"concurrent":true}}' : '{}');
    assert.equal(readdirSync(f.directory).some(name => name.endsWith('.tmp') || name.includes('.migrated')), false);
  });
}

for (const invalid of [null, [], 'synthetic-private', { command: 'native', url: 'https://example.test' },
  { command: 'native', env: { TOKEN: 123 } }, { command: 'native', args: [123] }]) {
  test(`REQ-AGENT-217: ambiguous native server remains byte-for-byte recoverable (${JSON.stringify(invalid)})`, async t => {
    const f = await fixture(t);
    const original = JSON.stringify({ mcpServers: { native: invalid } });
    writeFileSync(f.legacy, original);
    const before = readdirSync(f.directory).sort();
    assert.equal(f.native(), false);
    assert.equal(readFileSync(f.legacy, 'utf8'), original);
    assert.deepEqual(readdirSync(f.directory).sort(), before);
  });
}

test('REQ-AGENT-217: symlink ancestor blocks native preparation', async t => {
  const f = await fixture(t);
  const linked = join(f.home, 'linked-agent');
  symlinkSync(f.directory, linked);
  const { preparePiMcpAdapterConfig } = await import('../../preseed/agents/pi/extensions/00-mcp-adapter-config.ts');
  assert.equal(preparePiMcpAdapterConfig(linked), false);
  assert.equal(existsSync(f.legacy), false);
});

test('REQ-AGENT-217: native replacement failure leaves the active original and recovery bytes intact', async t => {
  const f = await fixture(t);
  const original = '{"mcpServers":{"native":{"command":"native"}}}';
  writeFileSync(f.legacy, original);
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' }); };
    syncBuiltinESMExports();
    assert.equal(f.native(), false);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(readFileSync(f.legacy, 'utf8'), original);
  assertArchived(f, 'mcp-adapter.json.migrated', original);
  assert.equal(readdirSync(f.directory).some(name => name.endsWith('.tmp')), false);
});

test('REQ-AGENT-217: managed stock handoff survives native portal reconciliation and repeated startup', async t => {
  const f = await fixture(t);
  f.selectAdapter();
  const { mergePiMcpPortals } = await import('../../scripts/merge-pi-mcp-portals.mjs');
  const portals = [{ name: 'synthetic', url: 'https://portal.example.test/mcp?codemode=search_and_execute' }];
  const original = JSON.stringify({ mcpServers: {
    'chrome-devtools': { command: '/opt/codeflare/bin/chrome-devtools-mcp', args: ['--wsEndpoint=wss://example.test', '--wsHeaders={"Authorization":"Bearer synthetic"}'], lifecycle: 'lazy', requestTimeoutMs: 360000 },
    'codeflare-portal-synthetic': { url: portals[0].url, transport: 'streamable-http', headers: { Authorization: 'Bearer codeflare-mcp-portal' }, lifecycle: 'eager' },
    'consult-llm': { command: 'consult-llm-mcp', args: [], env: { OPENAI_API_KEY: 'synthetic-literal', NODE_EXTRA_CA_CERTS: '/synthetic/ca.pem' }, lifecycle: 'lazy' },
  }, settings: { requestTimeoutMs: 360000 }, _codeflareMcpPortals: portals });
  writeFileSync(f.target, original, { mode: 0o600 });
  const auth = join(f.directory, 'mcp-auth.json');
  writeFileSync(auth, 'synthetic-private-auth-store');
  assert.equal(f.native(), true);
  const migrated = JSON.parse(readFileSync(f.legacy, 'utf8'));
  assert.deepEqual(migrated._codeflareMcpPortals, portals);
  assert.equal(existsSync(f.target), false);
  assertArchived(f, 'mcp.json.migrated', original);
  const merged = mergePiMcpPortals(migrated, portals);
  assert.deepEqual(merged.mcpServers['codeflare-portal-synthetic'], { url: portals[0].url,
    headers: { Authorization: 'Bearer codeflare-mcp-portal' }, auth: false, lifecycle: 'lazy', idleTimeout: 10,
    requestTimeoutMs: 360000, directTools: 'search' });
  const nativeBytes = JSON.stringify(merged, null, 2) + '\n';
  writeFileSync(f.legacy, nativeBytes);
  const inventory = readdirSync(f.directory).sort();
  for (let startup = 0; startup < 2; startup++) {
    assert.equal(f.native(), true);
    f.load();
    assert.equal(readFileSync(f.legacy, 'utf8'), nativeBytes);
    assert.equal(existsSync(f.target), false);
    assert.deepEqual(readdirSync(f.directory).sort(), inventory);
    assert.equal(readFileSync(auth, 'utf8'), 'synthetic-private-auth-store');
    assertArchived(f, 'mcp.json.migrated', original);
  }
});

for (const marker of [null, {}, [{ name: 'synthetic', url: 'https://example.test/mcp', token: 'synthetic-private' }],
  [{ name: 'synthetic', url: 'https://user:synthetic-private@example.test/mcp' }],
  [{ name: 'synthetic', url: 'https://example.test/mcp?token=synthetic-private' }],
  [{ name: 'synthetic', url: 'http://example.test/mcp' }],
  [{ name: 'synthetic', url: 'https://example.test/mcp' }, { name: 'synthetic', url: 'https://other.test/mcp' }]]) {
  test(`REQ-AGENT-217: invalid portal ownership marker preserves stock and native originals (${JSON.stringify(marker)})`, async t => {
    const f = await fixture(t);
    const stock = JSON.stringify({ mcpServers: {}, _codeflareMcpPortals: marker });
    const native = '{"settings":{"requestTimeoutMs":360000}}';
    writeFileSync(f.target, stock);
    writeFileSync(f.legacy, native);
    const inventory = readdirSync(f.directory).sort();
    assert.equal(f.native(), false);
    assert.equal(readFileSync(f.target, 'utf8'), stock);
    assert.equal(readFileSync(f.legacy, 'utf8'), native);
    assert.deepEqual(readdirSync(f.directory).sort(), inventory);
  });
}

test('REQ-BROWSER-009: native keep-alive browser lifecycle and custom idle minutes survive timeout preparation', async t => {
  const f = await fixture(t);
  const browser = { command: 'custom-browser', lifecycle: 'keep-alive', idleTimeout: 23, requestTimeoutMs: 2000 };
  writeFileSync(f.legacy, JSON.stringify({ mcpServers: { 'chrome-devtools': browser } }));
  assert.equal(f.native(), true);
  assert.deepEqual(JSON.parse(readFileSync(f.legacy, 'utf8')).mcpServers['chrome-devtools'], { ...browser, requestTimeoutMs: 360000 });
  const prepared = readFileSync(f.legacy, 'utf8');
  assert.equal(f.native(), true);
  assert.equal(readFileSync(f.legacy, 'utf8'), prepared);
});

for (const kind of ['conflicting-file', 'symlink']) {
  test(`REQ-AGENT-217: stock recovery collision remains passive and preserves exact active source (${kind})`, async t => {
    const f = await fixture(t);
    const stock = '{"mcpServers":{"custom":{"command":"custom","env":{"TOKEN":"!literal"}}}}';
    writeFileSync(f.target, stock);
    const archive = join(f.directory, 'mcp.json.migrated');
    const outside = join(f.home, 'outside-recovery');
    writeFileSync(outside, 'passive-private-recovery');
    if (kind === 'symlink') symlinkSync(outside, archive);
    else writeFileSync(archive, 'passive-private-recovery');
    assert.equal(f.native(), true);
    assert.equal(existsSync(f.target), false);
    assertArchived(f, 'mcp.json.migrated', stock);
    assert.equal(readFileSync(archive, 'utf8'), 'passive-private-recovery');
    assert.equal(readFileSync(outside, 'utf8'), 'passive-private-recovery');
    assert.equal(JSON.parse(readFileSync(f.legacy, 'utf8')).mcpServers.custom.env.TOKEN, '!!literal');
    const bytes = readFileSync(f.legacy, 'utf8');
    assert.equal(f.native(), true);
    assert.equal(readFileSync(f.legacy, 'utf8'), bytes);
  });
}

test('REQ-AGENT-217: already prepared native config still archives and retires the matching active stock file', async t => {
  const f = await fixture(t);
  const native = '{"settings":{"requestTimeoutMs":360000,"deferWithMissingMetadata":true},"mcpServers":{}}';
  writeFileSync(f.legacy, native);
  writeFileSync(f.target, '{"settings":{"requestTimeoutMs":360000}}');
  assert.equal(f.native(), true);
  assert.equal(readFileSync(f.legacy, 'utf8'), native);
  assert.equal(existsSync(f.target), false);
  assertArchived(f, 'mcp.json.migrated', '{"settings":{"requestTimeoutMs":360000}}');
});

for (const failure of ['archive-write', 'native-commit', 'stock-change-after-commit', 'native-change-after-commit']) {
  test(`REQ-AGENT-217: one-time handoff retains active stock on ${failure}`, async t => {
    const f = await fixture(t);
    const stock = '{"mcpServers":{"custom":{"command":"custom"}}}';
    const native = '{"settings":{"requestTimeoutMs":5000}}';
    writeFileSync(f.target, stock);
    writeFileSync(f.legacy, native);
    const write = fs.writeFileSync;
    const rename = fs.renameSync;
    try {
      fs.writeFileSync = (path, ...args) => {
        if (failure === 'archive-write' && path === `${f.target}.migrated`) throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' });
        return write(path, ...args);
      };
      fs.renameSync = (source, target) => {
        if (failure === 'native-commit') throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' });
        const result = rename(source, target);
        if (failure === 'stock-change-after-commit') write(f.target, '{"settings":{"concurrent":true}}');
        if (failure === 'native-change-after-commit') write(f.legacy, '{"settings":{"concurrent":true}}');
        return result;
      };
      syncBuiltinESMExports();
      assert.equal(f.native(), false);
    } finally { fs.writeFileSync = write; fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(readFileSync(f.target, 'utf8'), failure === 'stock-change-after-commit' ? '{"settings":{"concurrent":true}}' : stock);
    if (['archive-write', 'native-commit'].includes(failure)) assert.equal(readFileSync(f.legacy, 'utf8'), native);
    if (failure !== 'archive-write') assertArchived(f, 'mcp.json.migrated', stock);
    assert.equal(readdirSync(f.directory).some(name => name.endsWith('.tmp')), false);
  });
}

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
  const entrypoint = lines.join('\n');
  const browserStart = entrypoint.indexOf('if [ "${SESSION_MODE:-default}" = "advanced" ] \\\n   && [ -n "${CLOUDFLARE_API_TOKEN:-}" ]');
  const browserEnd = entrypoint.indexOf('    # Claude (~/.claude.json) - the cheap one-shot', browserStart);
  if (browserStart < 0 || browserEnd < 0) throw new Error('Missing production browser registration');
  const browser = entrypoint.slice(browserStart, browserEnd) + '\nfi';
  return spawnSync('bash', ['-c', `${functions}\nRCLONE_FILTERS=(--filter "+ /.pi/**" --filter "+ **")\nconfigure_pi_mcp_adapter "$MIGRATION_MODULE"\nconfigure_consult_llm
if [ "\${QUALIFY_BROWSER:-0}" = "1" ]; then
${browser}
fi
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


test('REQ-AGENT-069: startup bootstraps consult-llm at the adapter filename, lazily, without creating stock', async t => {
  const f = await fixture(t);
  const result = startConsult(f.home);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(readFileSync(f.legacy, 'utf8'));
  assert.equal(config.mcpServers['consult-llm'].lifecycle, 'lazy');
  assert.equal(config.settings.requestTimeoutMs, 360000);
  assert.equal(config.mcpServers['consult-llm'].env.OPENAI_API_KEY, 'synthetic-openai');
  assert.equal(existsSync(f.target), false);
  assert.equal(JSON.parse(readFileSync(join(f.home, '.claude.json'), 'utf8')).mcpServers['consult-llm'].command, 'consult-llm-mcp');
});

test('REQ-AGENT-217: actual startup shell hands off stock once and preserves custom native consult on repeated startup', async t => {
  const f = await fixture(t);
  const custom = { command: 'custom-consult', args: ['--user-owned'], env: { TOKEN: '!literal', NODE_EXTRA_CA_CERTS: '/synthetic/ca.pem' }, lifecycle: 'lazy' };
  const original = JSON.stringify({ mcpServers: { 'consult-llm': custom, unrelated: { command: 'custom' } }, settings: { requestTimeoutMs: 5000 } });
  writeFileSync(f.target, original);
  let result = startConsult(f.home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.target), false);
  assertArchived(f, 'mcp.json.migrated', original);
  const prepared = readFileSync(f.legacy, 'utf8');
  assert.deepEqual(JSON.parse(prepared), { mcpServers: { 'consult-llm': { ...custom, env: { ...custom.env, TOKEN: '!!literal' } }, unrelated: { command: 'custom' } }, settings: { requestTimeoutMs: 360000, deferWithMissingMetadata: true } });
  result = startConsult(f.home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.legacy, 'utf8'), prepared);
  assert.equal(existsSync(f.target), false);
});

test('REQ-AGENT-217: active native configuration and recovery objects remain baseline-sync eligible', async t => {
  const f = await fixture(t);
  const restored = join(f.home, 'remote');
  const remoteAgent = join(restored, '.pi', 'agent');
  mkdirSync(join(remoteAgent, 'nested'), { recursive: true });
  const remoteNative = '{"mcpServers":{"remote":{"command":"remote"}},"settings":{"restored":true}}';
  writeFileSync(join(remoteAgent, 'mcp-adapter.json'), remoteNative);
  writeFileSync(join(remoteAgent, 'mcp.json'), '{"mcpServers":{"stock":{"command":"stock"}}}');
  writeFileSync(join(remoteAgent, 'mcp.json.migrated.baseline'), 'remote recovery bytes');
  writeFileSync(join(remoteAgent, 'nested', 'mcp-adapter.json'), 'nested unrelated bytes');
  writeFileSync(join(remoteAgent, 'nested', 'mcp.json'), 'nested stock config bytes');
  const stock = '{"mcpServers":{"before":{"command":"before"}}}';
  writeFileSync(f.target, stock);
  const result = startConsult(f.home, restored);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.legacy, 'utf8'), remoteNative);
  assert.equal(existsSync(f.target), false, 'successful migration prevents obsolete root stock config from returning');
  assert.equal(readFileSync(join(f.directory, 'mcp.json.migrated.baseline'), 'utf8'), 'remote recovery bytes');
  assert.equal(readFileSync(join(f.directory, 'nested', 'mcp-adapter.json'), 'utf8'), 'nested unrelated bytes');
  assert.equal(readFileSync(join(f.directory, 'nested', 'mcp.json'), 'utf8'), 'nested stock config bytes');
  assertArchived(f, 'mcp.json.migrated', stock);
});

test('REQ-AGENT-217: failed native preparation blocks Pi shell merge without excluding restored files from baseline', async t => {
  const f = await fixture(t);
  const outside = join(f.home, 'unsafe-native');
  writeFileSync(outside, 'external original');
  symlinkSync(outside, f.legacy);
  const remote = join(f.home, 'remote-failed-preparation');
  mkdirSync(join(remote, '.pi', 'agent'), { recursive: true });
  const stock = '{"mcpServers":{"custom":{"command":"custom"}}}';
  writeFileSync(join(remote, '.pi', 'agent', 'mcp.json'), stock);
  const result = startConsult(f.home, remote);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.target, 'utf8'), stock);
  assert.equal(readFileSync(outside, 'utf8'), 'external original');
  assert.equal(lstatSync(f.legacy).isSymbolicLink(), true);
});

for (const mode of ['no-provider', 'enterprise']) {
  test(`REQ-AGENT-069: ${mode} startup preserves customized native consult while retaining Claude cleanup`, async t => {
    const f = await fixture(t);
    const original = { settings: { custom: true }, mcpServers: {
      'consult-llm': { command: 'consult-llm-mcp', args: ['--user-option'], env: { USER_TOKEN: 'synthetic-private' } },
      unrelated: { command: 'user-server' },
    } };
    writeFileSync(f.legacy, JSON.stringify(original));
    const claude = join(f.home, '.claude.json');
    writeFileSync(claude, JSON.stringify({ mcpServers: { 'consult-llm': { command: 'consult-llm-mcp' }, unrelated: { command: 'keep' } } }));
    const result = startConsult(f.home, undefined, { CODEFLARE_OPENAI_API_KEY: '', ENTERPRISE_MODE: mode === 'enterprise' ? 'active' : '' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(f.legacy, 'utf8')), { ...original, settings: { ...original.settings, requestTimeoutMs: 360000, deferWithMissingMetadata: true } });
    assert.deepEqual(JSON.parse(readFileSync(claude, 'utf8')).mcpServers, { unrelated: { command: 'keep' } });
  });
}

test('REQ-AGENT-069: generated native provider environment escapes a literal leading exclamation mark', async t => {
  const f = await fixture(t);
  const result = startConsult(f.home, undefined, { CODEFLARE_OPENAI_API_KEY: '!synthetic-openai' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(f.legacy, 'utf8')).mcpServers['consult-llm'].env.OPENAI_API_KEY, '!!synthetic-openai');
});

for (const origin of ['native', 'stock']) for (const explicit of [undefined, false, true]) {
  test(`REQ-AGENT-069: cold lazy metadata defaults only after ${origin} merge and preserves explicit ${explicit}`, async t => {
    const f = await fixture(t);
    const original = { settings: explicit === undefined ? {} : { deferWithMissingMetadata: explicit },
      mcpServers: { 'consult-llm': { command: 'consult-llm-mcp', lifecycle: 'lazy' } } };
    writeFileSync(origin === 'native' ? f.legacy : f.target, JSON.stringify(original));
    assert.equal(f.native(), true);
    const prepared = JSON.parse(readFileSync(f.legacy, 'utf8'));
    assert.deepEqual(prepared.settings, { ...original.settings, requestTimeoutMs: 360000,
      deferWithMissingMetadata: explicit === undefined ? true : explicit });
    assert.deepEqual(prepared.mcpServers, original.mcpServers);
    const bytes = readFileSync(f.legacy, 'utf8');
    assert.equal(f.native(), true);
    assert.equal(readFileSync(f.legacy, 'utf8'), bytes);
  });
}

test('REQ-AGENT-069: adding consult preserves existing native user startup settings and unrelated servers', async t => {
  const f = await fixture(t);
  const custom = { command: 'custom', args: ['keep'], lifecycle: 'keep-alive', idleTimeout: 29 };
  const settings = { deferWithMissingMetadata: false, custom: true };
  writeFileSync(f.legacy, JSON.stringify({ mcpServers: { custom }, settings }));
  const result = startConsult(f.home);
  assert.equal(result.status, 0, result.stderr);
  const updated = JSON.parse(readFileSync(f.legacy, 'utf8'));
  assert.deepEqual(updated.settings, { ...settings, requestTimeoutMs: 360000 });
  assert.deepEqual(updated.mcpServers.custom, custom);
  assert.equal(updated.mcpServers['consult-llm'].lifecycle, 'lazy');
});

for (const expression of ['!synthetic-command-${PRIVATE}', '${SYNTHETIC_VAR}', '$env:SYNTHETIC_VAR', '{env:SYNTHETIC_VAR}']) {
  test(`REQ-AGENT-217: rejected selected stock env blocks entrypoint Pi merge (${expression})`, async t => {
    const f = await fixture(t);
    const stock = JSON.stringify({ mcpServers: { 'consult-llm': { command: 'consult-llm-mcp', env: { OPENAI_API_KEY: expression } } } });
    writeFileSync(f.target, stock);
    const result = startConsult(f.home);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(f.target, 'utf8'), stock);
    assert.equal(existsSync(f.legacy), false);
    assert.equal(readdirSync(f.directory).some(name => name.includes('.migrated')), false);
  });
}

function generatedServers(modern = false) {
  const policy = modern ? { idleTimeout: 10, requestTimeoutMs: 360000, directTools: 'search' } : {};
  return {
    'consult-llm': { command: 'consult-llm-mcp', args: [], env: { OPENAI_API_KEY: 'synthetic-stale-managed' }, lifecycle: 'lazy', ...policy },
    'chrome-devtools': { command: '/opt/codeflare/bin/chrome-devtools-mcp', args: [
      '--wsEndpoint=wss://api.cloudflare.com/client/v4/accounts/synthetic-stale/browser-rendering/devtools/browser?keep_alive=1200000',
      '--wsHeaders={"Authorization":"Bearer synthetic-stale-managed"}',
    ], lifecycle: 'lazy', ...policy },
  };
}

for (const origin of ['stock', 'native', 'native-modern']) {
  test(`REQ-AGENT-217 AC6: actual startup regenerates proven managed consult and browser from fresh inputs (${origin})`, async t => {
    const f = await fixture(t);
    const custom = { command: 'custom', env: { TOKEN: 'synthetic-private', NODE_EXTRA_CA_CERTS: '/synthetic/ca.pem' }, lifecycle: 'lazy' };
    const original = JSON.stringify({ mcpServers: { ...generatedServers(origin === 'native-modern'), custom },
      settings: { deferWithMissingMetadata: false, requestTimeoutMs: 360000 } });
    writeFileSync(origin === 'stock' ? f.target : f.legacy, original);
    const overrides = { QUALIFY_BROWSER: '1', SESSION_MODE: 'advanced', CLOUDFLARE_API_TOKEN: 'synthetic-fresh-browser',
      CLOUDFLARE_ACCOUNT_ID: 'synthetic-fresh-account', CODEFLARE_OPENAI_API_KEY: 'synthetic-fresh-consult' };
    for (let startup = 0; startup < 2; startup++) {
      const result = startConsult(f.home, undefined, overrides);
      assert.equal(result.status, 0, result.stderr);
      const prepared = JSON.parse(readFileSync(f.legacy, 'utf8'));
      assert.deepEqual(prepared.mcpServers.custom, custom);
      assert.deepEqual(prepared.settings, { deferWithMissingMetadata: false, requestTimeoutMs: 360000 });
      assert.equal(prepared.mcpServers['consult-llm'].env.OPENAI_API_KEY, 'synthetic-fresh-consult');
      const browser = prepared.mcpServers['chrome-devtools'];
      assert.equal(browser.args[0], '--wsEndpoint=wss://api.cloudflare.com/client/v4/accounts/synthetic-fresh-account/browser-rendering/devtools/browser?keep_alive=1200000');
      assert.deepEqual(JSON.parse(browser.args[1].slice('--wsHeaders='.length)), { Authorization: 'Bearer synthetic-fresh-browser' });
      for (const server of [browser, prepared.mcpServers['consult-llm']]) {
        assert.equal(server.lifecycle, 'lazy');
        assert.equal(server.requestTimeoutMs, 360000);
        assert.equal(server.idleTimeout, 10);
        assert.equal(server.directTools, 'search');
      }
      assert.equal(existsSync(f.target), false);
    }
    assertArchived(f, origin === 'stock' ? 'mcp.json.migrated' : 'mcp-adapter.json.migrated', original);
  });
}

test('REQ-AGENT-217 AC6: ordinary native load never regenerates managed entries', async t => {
  const f = await fixture(t);
  f.selectAdapter();
  const servers = generatedServers(true);
  const original = JSON.stringify({ mcpServers: servers, settings: { requestTimeoutMs: 360000, deferWithMissingMetadata: true } });
  writeFileSync(f.legacy, original);
  f.load();
  assert.equal(readFileSync(f.legacy, 'utf8'), original);
  assert.deepEqual(JSON.parse(readFileSync(f.legacy, 'utf8')).mcpServers, servers);
  assert.equal(f.native(true), true);
  assert.deepEqual(JSON.parse(readFileSync(f.legacy, 'utf8')).mcpServers, {});
  assertArchived(f, 'mcp-adapter.json.migrated', original);
});

for (const customization of ['CA', 'arguments', 'headers', 'auth', 'keep-alive', 'timeout', 'idle', 'directTools', 'description']) {
  test(`REQ-AGENT-217 AC6: native startup ownership guards preserve customized canonical commands (${customization})`, async t => {
    const f = await fixture(t);
    const servers = generatedServers(true);
    const consult = servers['consult-llm'];
    const browser = servers['chrome-devtools'];
    if (customization === 'CA') { consult.env.NODE_EXTRA_CA_CERTS = '/synthetic/ca.pem'; browser.env = { NODE_EXTRA_CA_CERTS: '/synthetic/ca.pem' }; }
    if (customization === 'arguments') { consult.args = ['--custom']; browser.args.push('--custom'); }
    if (customization === 'headers') { consult.headers = { 'X-Custom': 'private' }; browser.args[1] = '--wsHeaders={"Authorization":"Bearer synthetic-custom","X-Custom":"private"}'; }
    if (customization === 'auth') { consult.auth = false; browser.auth = false; }
    if (customization === 'keep-alive') { consult.lifecycle = 'keep-alive'; browser.lifecycle = 'keep-alive'; }
    if (customization === 'timeout') { consult.requestTimeoutMs = 2345; browser.requestTimeoutMs = 2345; }
    if (customization === 'idle') { consult.idleTimeout = 29; browser.idleTimeout = 29; }
    if (customization === 'directTools') { consult.directTools = false; browser.directTools = false; }
    if (customization === 'description') { consult.description = 'custom'; browser.description = 'custom'; }
    const original = JSON.stringify({ mcpServers: servers });
    writeFileSync(f.legacy, original);
    assert.equal(f.native(true), true);
    const prepared = JSON.parse(readFileSync(f.legacy, 'utf8'));
    assert.deepEqual(prepared.mcpServers, { ...servers, 'chrome-devtools': { ...browser, requestTimeoutMs: 360000 } });
    assertArchived(f, 'mcp-adapter.json.migrated', original);
  });
}
