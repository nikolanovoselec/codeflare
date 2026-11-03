import { test } from 'node:test';
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
  const configPath = join(directory, '.pi', 'agent', 'mcp.json');
  mkdirSync(join(directory, '.pi', 'agent'), { recursive: true });
  return {
    directory, configPath,
    run: (overrides = {}) => configurePiMcpPortals({ configPath, portalsJson: JSON.stringify(portals), sessionMode: 'advanced', configReady: '1', ...overrides }),
    read: () => JSON.parse(readFileSync(configPath, 'utf8')),
  };
}

test('REQ-AGENT-227 AC3: startup produces multiple lazy OAuth portal connections', (t) => {
  const f = fixture(t);
  assert.equal(f.run(), true);
  const saved = f.read();
  for (const portal of portals) {
    assert.deepEqual(saved.mcpServers[key(portal.name)], { url: portal.url, auth: { type: 'oauth' }, lifecycle: 'lazy' });
  }
  const first = readFileSync(f.configPath, 'utf8');
  f.run();
  assert.equal(readFileSync(f.configPath, 'utf8'), first, 'idempotent startup');
});

test('REQ-AGENT-227 AC4: reconciliation preserves unrelated servers and grants', (t) => {
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
  withAuth.mcpServers[key('github')].auth.clientId = 'saved-client';
  writeFileSync(f.configPath, JSON.stringify(withAuth));
  const updated = [{ ...portals[1], url: 'https://api.githubcopilot.com/mcp/?codemode=search_and_execute' }];
  f.run({ portalsJson: JSON.stringify(updated) });
  const changed = f.read();
  assert.equal(changed.mcpServers[key('codeflare_enterprise')], undefined);
  assert.equal(changed.mcpServers[key('github')].auth.clientId, 'saved-client');
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

test('REQ-AGENT-227 AC4: unproven prefixed names and modified registrations are never claimed or retired', (t) => {
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

test('REQ-AGENT-227 AC3: default modes and incomplete migration leave configuration untouched', (t) => {
  const f = fixture(t);
  for (const mode of [undefined, 'default', 'standard']) {
    assert.equal(f.run({ sessionMode: mode }), false);
    assert.equal(existsSync(f.configPath), false);
  }
  assert.equal(f.run({ configReady: '0' }), false);
  assert.equal(existsSync(f.configPath), false);
  const bytes = '{"mcpServers":{"custom":{"command":"custom"}}}\n';
  writeFileSync(f.configPath, bytes);
  assert.equal(f.run({ sessionMode: 'default' }), false);
  assert.equal(readFileSync(f.configPath, 'utf8'), bytes);
});

test('REQ-AGENT-227 AC4: malformed input leaves configuration byte-identical', (t) => {
  const f = fixture(t);
  f.run();
  const bytes = readFileSync(f.configPath, 'utf8');
  const invalid = [
    '{', '{}', '[null]', JSON.stringify([portals[0], portals[0]]),
    JSON.stringify([{ ...portals[0], apiKey: 'secret' }]),
    ...['http://example.com/mcp', 'https://owner:secret@example.com/mcp', 'https://example.com/mcp#fragment', 'https://example.com/mcp?token=secret', 'https://example.com/mcp?codemode=search_and_execute&codemode=search_and_execute', 'not-a-url'].map((url) => JSON.stringify([{ name: 'github', url }])),
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
