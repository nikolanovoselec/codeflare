// Execute the actual startup functions; generated configuration is the contract.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(here, '../../entrypoint.sh'), 'utf8');
function generatedBrowserConfigs({ native, stock, claude: initialClaude,
  browserAccountId = 'test-account', browserToken = 'test-token', oauthAccountId,
  sessionMode = 'advanced', repeat = 1 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'browser-run-entrypoint-'));
  try {
    const directory = join(home, '.pi/agent'); mkdirSync(directory, { recursive: true });
    const claudePath = join(home, '.claude.json'), nativePath = join(directory, 'mcp-adapter.json'), stockPath = join(directory, 'mcp.json');
    writeFileSync(claudePath, JSON.stringify(initialClaude ?? {}));
    if (native !== undefined) writeFileSync(nativePath, JSON.stringify(native));
    if (stock !== undefined) writeFileSync(stockPath, JSON.stringify(stock));
    const migrationStart = entrypoint.indexOf('configure_pi_mcp_adapter() {');
    const migrationEnd = entrypoint.indexOf('\n}', migrationStart) + 2;
    const start = entrypoint.indexOf('# Configure Browser Run (Cloudflare Browser Rendering) as a real-browser');
    const end = entrypoint.indexOf('# Configure Claude Code settings.json', start);
    assert.ok(migrationStart >= 0 && start >= 0 && end > start, 'startup fixture extraction');
    const childEnvPath = join(home, 'child-account-context.json');
    const script = `set -e\nUSER_HOME="${home}"\nUSER_CLAUDE_JSON="${claudePath}"\nSESSION_MODE="${sessionMode}"\n${entrypoint.slice(migrationStart, migrationEnd)}\nconfigure_pi_mcp_adapter "${resolve(here, '../../preseed/agents/pi/extensions/00-mcp-adapter-config.ts')}"\n${entrypoint.slice(start, end)}
node -e 'process.stdout.write(JSON.stringify({browserAccountId:process.env.CLOUDFLARE_ACCOUNT_ID,oauthAccountId:process.env.CLOUDFLARE_OAUTH_ACCOUNT_ID}))' > "${childEnvPath}"`;
    const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: browserAccountId, CLOUDFLARE_API_TOKEN: browserToken };
    delete env.CLOUDFLARE_OAUTH_ACCOUNT_ID;
    if (oauthAccountId !== undefined) env.CLOUDFLARE_OAUTH_ACCOUNT_ID = oauthAccountId;
    const startups = [];
    for (let startup = 0; startup < repeat; startup++) {
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
      assert.equal(result.status, 0, result.stderr);
      const claudeBytes = readFileSync(claudePath, 'utf8');
      const piBytes = existsSync(nativePath) ? readFileSync(nativePath, 'utf8') : undefined;
      startups.push({ claude: JSON.parse(claudeBytes), claudeBytes, piBytes,
        childAccountContext: JSON.parse(readFileSync(childEnvPath, 'utf8')),
        pi: piBytes === undefined ? undefined : JSON.parse(piBytes),
        stockBytes: existsSync(stockPath) ? readFileSync(stockPath, 'utf8') : undefined,
        archive: existsSync(stockPath + '.migrated') ? readFileSync(stockPath + '.migrated', 'utf8') : undefined,
        recovery: Object.fromEntries(readdirSync(directory).filter(name => name.includes('.migrated'))
          .sort().map(name => [name, readFileSync(join(directory, name), 'utf8')])) });
    }
    return { ...startups.at(-1), startups };
  } finally { rmSync(home, { recursive: true, force: true }); }
}
const wsEndpoint = config => {
  const arg = config.mcpServers['chrome-devtools'].args.find(value => value.startsWith('--wsEndpoint='));
  assert.ok(arg); return arg.slice('--wsEndpoint='.length);
};
const browser = (command = 'custom-browser', lifecycle = 'lazy') => ({ command, args: [
  '--wsEndpoint=wss://api.cloudflare.com/client/v4/accounts/test-account/browser-rendering/devtools/browser?keep_alive=600000&custom=keep',
  '--wsHeaders={"Authorization":"Bearer synthetic-user-token"}',
], lifecycle });

// Restored credentials deliberately differ from the current startup environment.
const staleBrowser = () => ({ command: '/opt/codeflare/bin/chrome-devtools-mcp', args: [
  '--wsEndpoint=wss://api.cloudflare.com/client/v4/accounts/retired-account/browser-rendering/devtools/browser?keep_alive=1200000',
  '--wsHeaders={"Authorization":"Bearer synthetic-retired-token"}',
] });
const staleClaude = () => ({
  'chrome-devtools': { ...staleBrowser(), timeout: 360000 },
  'browser-run': { command: 'node', args: ['/opt/codeflare/browser-run-mcp/index.mjs'], timeout: 360000,
    env: { CLOUDFLARE_API_TOKEN: 'synthetic-retired-token', CLOUDFLARE_ACCOUNT_ID: 'retired-account' } },
});
const disabledStartups = [
  ['Standard', { sessionMode: 'default' }],
  ['advanced without token', { browserToken: '' }],
  ['advanced without account', { browserAccountId: '' }],
];
const unrelatedServer = { command: 'user-server', args: ['--keep'], env: { TOKEN: 'synthetic-unrelated' } };
const nativeSettings = { requestTimeoutMs: 360000, deferWithMissingMetadata: false, custom: true };

describe('entrypoint Browser Run MCP registration', () => {
  it('REQ-AGENT-029/REQ-BROWSER-007: OAuth B survives child startup while Claude and Pi Browser Run still target A', () => {
    const browserAccountId = 'a'.repeat(32);
    const oauthAccountId = 'b'.repeat(32);
    const { claude, pi, childAccountContext } = generatedBrowserConfigs({
      browserAccountId, oauthAccountId, browserToken: 'codeflare-enterprise',
    });
    for (const config of [claude, pi]) {
      assert.equal(new URL(wsEndpoint(config)).pathname,
        `/client/v4/accounts/${browserAccountId}/browser-rendering/devtools/browser`);
      const headers = config.mcpServers['chrome-devtools'].args.find(arg => arg.startsWith('--wsHeaders='));
      assert.equal(JSON.parse(headers.slice('--wsHeaders='.length)).Authorization, 'Bearer codeflare-enterprise');
    }
    assert.equal(claude.mcpServers['browser-run'].env.CLOUDFLARE_ACCOUNT_ID, browserAccountId);
    assert.equal(claude.mcpServers['browser-run'].env.CLOUDFLARE_API_TOKEN, 'codeflare-enterprise');
    assert.deepEqual(childAccountContext, { browserAccountId, oauthAccountId });
  });

  it('REQ-AGENT-029/REQ-BROWSER-007: an OAuth hint alone does not register Browser Run and remains inherited', () => {
    const oauthAccountId = 'b'.repeat(32);
    const { claude, pi, childAccountContext } = generatedBrowserConfigs({
      browserAccountId: '', browserToken: '', oauthAccountId,
    });
    for (const config of [claude, pi]) {
      assert.equal(config?.mcpServers?.['chrome-devtools'], undefined);
      assert.equal(config?.mcpServers?.['browser-run'], undefined);
    }
    assert.deepEqual(childAccountContext, { browserAccountId: '', oauthAccountId });
  });
  it('REQ-BROWSER-009 AC7: Claude browser MCP calls receive six minutes without changing unrelated servers', () => {
    const custom = { command: 'custom-server', timeout: 2000, env: { TOKEN: 'synthetic-custom-token' } };
    const { claude } = generatedBrowserConfigs({ claude: { mcpServers: { custom }, unrelated: true } });
    assert.equal(claude.mcpServers['chrome-devtools'].timeout, 360000);
    assert.equal(claude.mcpServers['browser-run'].timeout, 360000);
    assert.deepEqual(claude.mcpServers.custom, custom); assert.equal(claude.unrelated, true);
  });
  it('REQ-BROWSER-001 AC5: Claude gives browser continuity a bounded twenty-minute inactivity window', () => {
    assert.equal(new URL(wsEndpoint(generatedBrowserConfigs().claude)).searchParams.get('keep_alive'), '1200000');
  });
  it('REQ-BROWSER-006 AC5: Pi separates twenty-minute browser inactivity from six-minute RPC requests', () => {
    const { pi } = generatedBrowserConfigs();
    assert.equal(new URL(wsEndpoint(pi)).searchParams.get('keep_alive'), '1200000');
    assert.equal(pi.mcpServers['chrome-devtools'].lifecycle, 'lazy');
    assert.equal(pi.mcpServers['chrome-devtools'].idleTimeout, 10);
    assert.equal(pi.settings.requestTimeoutMs, 360000);
    assert.equal(pi.settings.deferWithMissingMetadata, true);
    assert.equal(pi.mcpServers['chrome-devtools'].requestTimeoutMs, 360000);
  });
  it('REQ-BROWSER-006 AC5: native browser continuity preserves credentials, custom settings and unrelated servers', () => {
    const original = browser();
    const custom = { command: 'custom', env: { TOKEN: 'synthetic-secret' } };
    const { pi } = generatedBrowserConfigs({ native: { mcpServers: { 'chrome-devtools': original, custom }, settings: { custom: true } } });
    const endpoint = new URL(wsEndpoint(pi));
    assert.deepEqual(endpoint.searchParams.getAll('keep_alive'), ['1200000']);
    assert.equal(endpoint.searchParams.get('custom'), 'keep');
    assert.deepEqual(pi.mcpServers['chrome-devtools'].args.slice(1), original.args.slice(1));
    assert.deepEqual(pi.mcpServers.custom, custom); assert.equal(pi.settings.custom, true);
  });
  it('REQ-BROWSER-006 AC5: duplicate retention parameters normalize to one bounded continuity window', () => {
    const original = browser(); original.args[0] += '&keep_alive=180000';
    const { pi } = generatedBrowserConfigs({ native: { mcpServers: { 'chrome-devtools': original } } });
    assert.deepEqual(new URL(wsEndpoint(pi)).searchParams.getAll('keep_alive'), ['1200000']);
  });
  it('REQ-BROWSER-009 AC1/AC2/AC4: startup aligns Chrome RPC timeout while preserving native lifecycle and auth', () => {
    const original = { ...browser('custom-browser', 'lazy-keep-alive'), requestTimeoutMs: 600000 };
    const custom = { command: 'custom', requestTimeoutMs: 2000 };
    const { pi } = generatedBrowserConfigs({ native: { mcpServers: { 'chrome-devtools': original, custom } } });
    assert.equal(pi.settings.requestTimeoutMs, 360000);
    assert.equal(pi.mcpServers['chrome-devtools'].requestTimeoutMs, 360000);
    assert.equal(pi.mcpServers['chrome-devtools'].lifecycle, 'lazy-keep-alive');
    assert.deepEqual(pi.mcpServers['chrome-devtools'].args.slice(1), original.args.slice(1));
    assert.deepEqual(pi.mcpServers.custom, custom);
  });
  it('REQ-BROWSER-006: startup regenerates the image-owned browser endpoint and headers while preserving custom settings', () => {
    const original = browser('/opt/codeflare/bin/chrome-devtools-mcp');
    original.args[0] = original.args[0].replace('/test-account/', '/old-account/');
    const custom = { command: 'custom', env: { TOKEN: 'synthetic-custom-token' } };
    const { pi } = generatedBrowserConfigs({ native: { mcpServers: { 'chrome-devtools': original, custom }, settings: { custom: true } } });
    assert.equal(new URL(wsEndpoint(pi)).pathname, '/client/v4/accounts/test-account/browser-rendering/devtools/browser');
    const headers = pi.mcpServers['chrome-devtools'].args.find(arg => arg.startsWith('--wsHeaders='));
    assert.equal(JSON.parse(headers.slice('--wsHeaders='.length)).Authorization, 'Bearer test-token');
    assert.deepEqual(pi.mcpServers.custom, custom); assert.equal(pi.settings.custom, true);
  });
  it('REQ-BROWSER-006: native custom endpoints and unrelated credentials survive startup unchanged', () => {
    const original = { command: 'custom-browser', args: ['--wsEndpoint=wss://example.test/?keep_alive=600000'], lifecycle: 'lazy' };
    const custom = { command: 'custom', env: { TOKEN: 'synthetic-secret' } };
    const { pi } = generatedBrowserConfigs({ native: { mcpServers: { 'chrome-devtools': original, custom } } });
    assert.deepEqual(pi.mcpServers['chrome-devtools'].args, original.args);
    assert.deepEqual(pi.mcpServers.custom, custom);
  });
  it('REQ-AGENT-217: compatible stock browser handoff preserves archived originals and adds unrelated servers', () => {
    const original = { ...browser(), transport: 'stdio' };
    const stock = { mcpServers: { 'chrome-devtools': original, extra: { command: 'extra' } } };
    const { pi, stockBytes, archive } = generatedBrowserConfigs({ stock });
    assert.equal(stockBytes, undefined);
    assert.equal(archive, JSON.stringify(stock));
    assert.deepEqual(pi.mcpServers.extra, { command: 'extra' });
    assert.deepEqual(pi.mcpServers['chrome-devtools'].args.slice(1), original.args.slice(1));
  });
  it('REQ-AGENT-217: conflicting native and stock browser entries remain untouched', () => {
    const native = { mcpServers: { 'chrome-devtools': { command: 'native-browser' } } };
    const stock = { mcpServers: { 'chrome-devtools': { command: 'different-stock-browser' } } };
    const result = generatedBrowserConfigs({ native, stock });
    assert.deepEqual(result.pi, native);
    assert.equal(result.stockBytes, JSON.stringify(stock));
    assert.equal(result.archive, undefined);
  });

  for (const [mode, options] of disabledStartups) {
    for (const shape of ['legacy', 'native-modern']) {
      it(`REQ-BROWSER-001 AC1/REQ-BROWSER-006 AC4/REQ-AGENT-217 AC6: ${mode} removes stale generated constructors (${shape})`, () => {
        const managed = { ...staleBrowser(), lifecycle: 'lazy',
          ...(shape === 'native-modern' ? { idleTimeout: 10, requestTimeoutMs: 360000, directTools: 'search' } : {}) };
        const claude = { mcpServers: { ...staleClaude(), unrelated: unrelatedServer }, userSetting: { keep: true } };
        const native = { mcpServers: { 'chrome-devtools': managed, unrelated: unrelatedServer }, settings: nativeSettings };
        const { startups } = generatedBrowserConfigs({ ...options, claude, native, repeat: 2 });
        for (const result of startups) {
          assert.deepEqual(result.claude, { ...claude, mcpServers: { unrelated: unrelatedServer } });
          assert.deepEqual(result.pi, { ...native, mcpServers: { unrelated: unrelatedServer } });
          assert.equal(result.stockBytes, undefined);
          assert.equal(result.archive, undefined);
          assert.deepEqual(result.recovery, { 'mcp-adapter.json.migrated': JSON.stringify(native) });
        }
        assert.deepEqual(startups[1], startups[0], 'repeated disabled startup must not rewrite configs or add recovery copies');
      });
    }

    for (const customization of ['command', 'endpoint', 'arguments', 'headers', 'auth', 'timeout', 'CA', 'unknown-field']) {
      it(`REQ-BROWSER-001 AC1: ${mode} preserves customized same-name Claude registrations (${customization})`, () => {
        const servers = staleClaude();
        const chrome = servers['chrome-devtools'], rest = servers['browser-run'];
        if (customization === 'command') { chrome.command = 'user-chrome'; rest.command = 'user-browser'; }
        if (customization === 'endpoint') {
          chrome.args[0] = '--wsEndpoint=wss://user-browser.example.test/devtools/browser';
          rest.args = ['/user/browser-run/index.mjs'];
        }
        if (customization === 'arguments') { chrome.args.push('--user-option'); rest.args.push('--user-option'); }
        if (customization === 'headers') {
          chrome.args[1] = '--wsHeaders={"Authorization":"Bearer synthetic-custom","X-User-Policy":"keep"}';
          rest.env.USER_AUTH_HEADER = 'synthetic-custom';
        }
        if (customization === 'auth') { chrome.auth = false; rest.auth = false; }
        if (customization === 'timeout') { chrome.timeout = 2345; rest.timeout = 2345; }
        if (customization === 'CA') {
          chrome.env = { NODE_EXTRA_CA_CERTS: '/user/ca.pem' };
          rest.env.NODE_EXTRA_CA_CERTS = '/user/ca.pem';
        }
        if (customization === 'unknown-field') { chrome.userPolicy = { keep: true }; rest.userPolicy = { keep: true }; }
        const claude = { mcpServers: { ...servers, unrelated: unrelatedServer }, userSetting: { keep: true } };
        const { startups } = generatedBrowserConfigs({ ...options, claude, repeat: 2 });
        for (const result of startups) {
          assert.deepEqual(result.claude, claude);
          assert.equal(result.stockBytes, undefined);
          assert.deepEqual(result.recovery, {}, 'custom registrations must not rely on a recovery archive');
        }
        assert.deepEqual(startups[1], startups[0], 'repeated disabled startup preserves the same configuration bytes');
      });
    }

    for (const preservedName of ['chrome-devtools', 'browser-run']) {
      it(`REQ-BROWSER-001 AC1: ${mode} removes only the managed Claude sibling of custom ${preservedName}`, () => {
        const servers = staleClaude();
        const preserved = { ...servers[preservedName], auth: false };
        const claude = { mcpServers: { ...servers, [preservedName]: preserved, unrelated: unrelatedServer }, userSetting: true };
        const { startups } = generatedBrowserConfigs({ ...options, claude, repeat: 2 });
        for (const result of startups) {
          assert.deepEqual(result.claude, { ...claude, mcpServers: { [preservedName]: preserved, unrelated: unrelatedServer } });
          assert.deepEqual(result.recovery, {});
        }
        assert.deepEqual(startups[1], startups[0]);
      });
    }

    for (const customization of ['command', 'endpoint', 'arguments', 'headers', 'CA', 'auth', 'unknown-field', 'lifecycle', 'idle', 'directTools']) {
      it(`REQ-BROWSER-006 AC4/REQ-AGENT-217 AC6: ${mode} preserves normalized native Pi without stock or archives (${customization})`, () => {
        const chrome = { ...staleBrowser(), lifecycle: 'lazy', idleTimeout: 10, requestTimeoutMs: 360000, directTools: 'search' };
        if (customization === 'command') chrome.command = 'user-chrome';
        if (customization === 'endpoint') chrome.args[0] = '--wsEndpoint=wss://user-browser.example.test/devtools/browser';
        if (customization === 'arguments') chrome.args.push('--user-option');
        if (customization === 'headers') chrome.args[1] = '--wsHeaders={"Authorization":"Bearer synthetic-custom","X-User-Policy":"keep"}';
        if (customization === 'CA') chrome.env = { NODE_EXTRA_CA_CERTS: '/user/ca.pem' };
        if (customization === 'auth') chrome.auth = false;
        if (customization === 'unknown-field') chrome.userPolicy = { keep: true };
        if (customization === 'lifecycle') chrome.lifecycle = 'eager';
        if (customization === 'idle') chrome.idleTimeout = 29;
        if (customization === 'directTools') chrome.directTools = false;
        const native = { mcpServers: { 'chrome-devtools': chrome, unrelated: unrelatedServer },
          settings: nativeSettings, userSetting: { keep: true } };
        const { startups } = generatedBrowserConfigs({ ...options, native, repeat: 2 });
        for (const result of startups) {
          assert.deepEqual(result.pi, native);
          assert.equal(result.piBytes, JSON.stringify(native), 'already-normalized native input remains byte-exact');
          assert.equal(result.stockBytes, undefined);
          assert.equal(result.archive, undefined);
          assert.deepEqual(result.recovery, {}, 'preservation must work without a stock file or new recovery archive');
        }
        assert.deepEqual(startups[1], startups[0], 'repeated disabled startup keeps normalized native bytes');
      });
    }

    for (const failure of ['invalid-native-settings', 'conflicting-stock']) {
      it(`REQ-AGENT-217 AC4: ${mode} preserves Pi originals when preparation fails (${failure})`, () => {
        const native = { mcpServers: { 'chrome-devtools': { ...staleBrowser(), lifecycle: 'lazy' }, unrelated: unrelatedServer },
          settings: failure === 'invalid-native-settings' ? [] : nativeSettings };
        const stock = failure === 'conflicting-stock'
          ? { mcpServers: { 'chrome-devtools': { command: 'different-user-browser' } } } : undefined;
        const claude = { mcpServers: { ...staleClaude(), unrelated: unrelatedServer } };
        const { startups } = generatedBrowserConfigs({ ...options, native, stock, claude, repeat: 2 });
        for (const result of startups) {
          assert.equal(result.piBytes, JSON.stringify(native));
          assert.deepEqual(result.pi, native);
          assert.equal(result.stockBytes, stock === undefined ? undefined : JSON.stringify(stock));
          assert.deepEqual(result.recovery, {}, 'failed preparation cannot partially archive or overwrite Pi inputs');
          assert.deepEqual(result.claude, { mcpServers: { unrelated: unrelatedServer } }, 'Pi failure must not prevent owned Claude cleanup');
        }
        assert.deepEqual(startups[1], startups[0], 'repeated rejected preparation remains non-destructive');
      });
    }
  }
});
