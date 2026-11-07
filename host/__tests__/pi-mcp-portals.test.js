import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurePiMcpPortals, mergePiMcpPortals } from '../../scripts/merge-pi-mcp-portals.mjs';

const portals = [
  { name: 'codeflare_enterprise', url: 'https://portal.example.com/mcp?codemode=search_and_execute' },
  { name: 'github', url: 'https://api.githubcopilot.com/mcp/' },
];
const key = (name) => `codeflare-portal-${name}`;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-mcp-portals-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configPath = join(directory, '.pi', 'agent', 'mcp-adapter.json');
  mkdirSync(join(directory, '.pi', 'agent'), { recursive: true });
  return {
    directory, configPath,
    run: (overrides = {}) => configurePiMcpPortals({ configPath, portalsJson: JSON.stringify(portals), sessionMode: 'advanced', configReady: '1', ...overrides }),
    read: () => JSON.parse(readFileSync(configPath, 'utf8')),
  };
}

test('REQ-AGENT-228 AC1: startup produces multiple idle-disconnecting non-secret placeholder portal connections', (t) => {
  const f = fixture(t);
  assert.equal(f.run(), true);
  const saved = f.read();
  for (const portal of portals) {
    assert.deepEqual(saved.mcpServers[key(portal.name)], { url: portal.url, headers: { Authorization: 'Bearer codeflare-mcp-portal' }, auth: false, lifecycle: 'lazy', idleTimeout: 10, requestTimeoutMs: 360000, directTools: 'search' });
  }
  const first = readFileSync(f.configPath, 'utf8');
  f.run();
  assert.equal(readFileSync(f.configPath, 'utf8'), first, 'idempotent startup');
});

test('REQ-AGENT-228 AC2: reconciliation preserves unrelated servers and grants', (t) => {
  const f = fixture(t);
  const unrelated = {
    settings: { toolPrefix: 'custom', requestTimeoutMs: 40000 },
    customSetting: { keep: true },
    mcpServers: {
      browser: { command: 'chrome-devtools-mcp', args: ['--browserUrl=http://localhost:9222'], lifecycle: 'lazy' },
      consult: { command: 'consult', env: { TOKEN: 'existing-synthetic-credential' } },
      'codeflare-portal-user_owned': { url: 'https://custom.example/mcp', headers: { Authorization: 'Bearer synthetic-existing' } },
    },
  };
  writeFileSync(f.configPath, JSON.stringify(unrelated));
  const authPath = join(f.directory, '.pi', 'agent', 'mcp-auth.json');
  const grants = '{"existing-owner-grant":"synthetic-grant-bytes"}\n';
  writeFileSync(authPath, grants);
  f.run();
  // A separate OAuth write between startups must not be replaced with an old config snapshot.
  const withAuth = f.read();
  withAuth.mcpServers.user_oauth = { url: 'https://auth.example/mcp', auth: { type: 'oauth', clientId: 'existing-client' }, lifecycle: 'lazy' };
  writeFileSync(f.configPath, JSON.stringify(withAuth));
  const updated = [{ ...portals[1], url: 'https://api.githubcopilot.com/mcp/?codemode=search_and_execute' }];
  f.run({ portalsJson: JSON.stringify(updated) });
  const changed = f.read();
  assert.equal(changed.mcpServers[key('codeflare_enterprise')], undefined);
  assert.equal(changed.mcpServers[key('github')].auth, false);
  assert.deepEqual(changed.mcpServers.user_oauth, withAuth.mcpServers.user_oauth);
  assert.deepEqual(changed.settings, unrelated.settings);
  assert.deepEqual(changed.customSetting, unrelated.customSetting);
  for (const [name, server] of Object.entries(unrelated.mcpServers)) assert.deepEqual(changed.mcpServers[name], server);
  f.run({ portalsJson: '[]' });
  const empty = f.read();
  assert.equal(empty.mcpServers[key('github')], undefined);
  for (const [name, server] of Object.entries(unrelated.mcpServers)) assert.deepEqual(empty.mcpServers[name], server);
  assert.deepEqual(empty.mcpServers.user_oauth, withAuth.mcpServers.user_oauth);
  assert.equal(readFileSync(authPath, 'utf8'), grants);
});

test('REQ-AGENT-228 AC2: unproven prefixed names and modified registrations are never claimed or retired', (t) => {
  const f = fixture(t);
  const collision = { mcpServers: { [key('github')]: { url: portals[1].url, auth: { type: 'oauth' }, lifecycle: 'lazy' } } };
  const bytes = JSON.stringify(collision);
  writeFileSync(f.configPath, bytes);
  assert.throws(() => f.run(), /collision/);
  assert.equal(readFileSync(f.configPath, 'utf8'), bytes);
  writeFileSync(f.configPath, JSON.stringify(mergePiMcpPortals({}, portals)));
  const edited = f.read();
  edited.mcpServers[key('github')].url = 'https://user-replacement.example/mcp';
  const changedBytes = JSON.stringify(edited);
  writeFileSync(f.configPath, changedBytes);
  assert.throws(() => f.run({ portalsJson: '[]' }), /changed/);
  assert.equal(readFileSync(f.configPath, 'utf8'), changedBytes);
});

test('REQ-AGENT-228 AC2: added managed request-header commands are preserved rather than claimed', t => {
  const f = fixture(t); f.run();
  const config = f.read();
  config.mcpServers[key('github')].requestHeadersCommand = { command: 'user-owned-header-provider' };
  const bytes = JSON.stringify(config); writeFileSync(f.configPath, bytes);
  assert.throws(() => f.run(), /changed/);
  assert.equal(readFileSync(f.configPath, 'utf8'), bytes);
});

test('REQ-AGENT-228 AC1: both supported Pi modes bootstrap while invalid modes and incomplete migration preserve files', (t) => {
  const f = fixture(t);
  for (const mode of [undefined, 'standard']) {
    assert.equal(f.run({ sessionMode: mode }), false);
    assert.equal(existsSync(f.configPath), false);
  }
  assert.equal(f.run({ configReady: '0' }), false);
  assert.equal(existsSync(f.configPath), false);
  for (const mode of ['default', 'advanced']) {
    assert.equal(f.run({ sessionMode: mode }), true);
    for (const portal of portals) assert.equal(f.read().mcpServers[key(portal.name)].headers.Authorization, 'Bearer codeflare-mcp-portal');
  }
});

test('REQ-AGENT-228 AC1: actual entrypoint wiring bootstraps managed portals in default and advanced Pi', t => {
  const f = fixture(t);
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const source = readFileSync(join(root, 'entrypoint.sh'), 'utf8');
  const start = source.indexOf('configure_pi_mcp_portals() {');
  const end = source.indexOf('\n}', start);
  if (start < 0 || end < 0) throw Error('Entrypoint fixture extraction failed');
  const configure = source.slice(start, end + 2).replace('/opt/codeflare/merge-pi-mcp-portals.mjs', join(root, 'scripts/merge-pi-mcp-portals.mjs'));
  for (const mode of ['default', 'advanced']) {
    writeFileSync(f.configPath, JSON.stringify({ mcpServers: { unrelated: { command: 'custom-stdio' } } }));
    const result = spawnSync('bash', ['-c', `coding_agent_is_selected() { return 0; }\n${configure}\nconfigure_pi_mcp_portals`], {
      encoding: 'utf8', env: { ...process.env, USER_HOME: f.directory, SESSION_MODE: mode,
        PI_MCP_CONFIG_READY: '1', CODEFLARE_MCP_PORTALS_JSON: JSON.stringify(portals) }, timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const saved = f.read();
    for (const portal of portals) assert.equal(saved.mcpServers[key(portal.name)].headers.Authorization, 'Bearer codeflare-mcp-portal');
    assert.deepEqual(saved.mcpServers.unrelated, { command: 'custom-stdio' });
  }
});

test('REQ-AGENT-228 AC1: public HTTPS on the standard port remains supported', t => {
  const f = fixture(t);
  const configured = [{ name: 'public', url: 'https://portal.example.com:443/mcp?codemode=search_and_execute' }];
  assert.equal(f.run({ portalsJson: JSON.stringify(configured) }), true);
  assert.deepEqual(f.read().mcpServers[key('public')], { url: configured[0].url,
    headers: { Authorization: 'Bearer codeflare-mcp-portal' }, auth: false, lifecycle: 'lazy', idleTimeout: 10, requestTimeoutMs: 360000, directTools: 'search' });
});

test('REQ-AGENT-228 AC2: malformed input leaves configuration byte-identical', (t) => {
  const f = fixture(t);
  f.run();
  const bytes = readFileSync(f.configPath, 'utf8');
  const invalid = [
    '{', '{}', '[null]', JSON.stringify([portals[0], portals[0]]),
    JSON.stringify([{ ...portals[0], apiKey: 'secret' }]),
    ...['http://example.com/mcp', 'https://owner:secret@example.com/mcp', 'https://example.com/mcp#fragment', 'https://example.com/mcp?token=secret', 'https://example.com/mcp?codemode=search_and_execute&codemode=search_and_execute', 'not-a-url',
      'https://127.0.0.1/mcp', 'https://[::1]/mcp', 'https://portal/mcp', 'https://portal.local/mcp',
      'https://portal.internal/mcp', 'https://portal.localhost/mcp', 'https://portal.example.com:8443/mcp']
      .map((url) => JSON.stringify([{ name: 'github', url }])),
    JSON.stringify([{ name: '../github', url: portals[1].url }]),
  ];
  for (const portalsJson of invalid) {
    assert.throws(() => f.run({ portalsJson }));
    assert.equal(readFileSync(f.configPath, 'utf8'), bytes);
  }
  for (const badConfig of ['{broken', 'null', '{"mcpServers":[]}', '{"mcpServers":{"custom":null}}', '{"_codeflareMcpPortals":"not-a-list"}']) {
    writeFileSync(f.configPath, badConfig);
    assert.throws(() => f.run());
    assert.equal(readFileSync(f.configPath, 'utf8'), badConfig);
  }
});
