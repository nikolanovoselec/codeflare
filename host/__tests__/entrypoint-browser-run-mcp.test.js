// Execute the actual startup functions; generated configuration is the contract.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(here, '../../entrypoint.sh'), 'utf8');
function generatedBrowserConfigs({ native, stock, claude: initialClaude } = {}) {
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
    const script = `set -e\nUSER_HOME="${home}"\nUSER_CLAUDE_JSON="${claudePath}"\nSESSION_MODE=advanced\nCLOUDFLARE_API_TOKEN=test-token\nCLOUDFLARE_ACCOUNT_ID=test-account\n${entrypoint.slice(migrationStart, migrationEnd)}\nconfigure_pi_mcp_adapter "${resolve(here, '../../preseed/agents/pi/extensions/00-mcp-adapter-config.ts')}"\n${entrypoint.slice(start, end)}`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return { claude: JSON.parse(readFileSync(claudePath, 'utf8')),
      pi: existsSync(nativePath) ? JSON.parse(readFileSync(nativePath, 'utf8')) : undefined,
      stockBytes: existsSync(stockPath) ? readFileSync(stockPath, 'utf8') : undefined,
      archive: existsSync(stockPath + '.migrated') ? readFileSync(stockPath + '.migrated', 'utf8') : undefined };
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

describe('entrypoint Browser Run MCP registration', () => {
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
});
