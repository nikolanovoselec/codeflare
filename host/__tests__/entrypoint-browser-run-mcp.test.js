// Verifies REQ-BROWSER-001 AC5 and REQ-BROWSER-006 AC5 by executing the
// Browser Run entrypoint block and inspecting both generated MCP configs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

function extractBrowserRunBlock() {
  const start = entrypoint.indexOf(
    '# Configure Browser Run (Cloudflare Browser Rendering) as a real-browser'
  );
  if (start === -1) throw new Error('Browser Run block marker not found in entrypoint.sh');
  const end = entrypoint.indexOf('# Configure Claude Code settings.json', start);
  if (end === -1) throw new Error('Browser Run block end marker not found');
  return entrypoint.slice(start, end);
}

function generatedBrowserConfigs({ legacy, target } = {}) {
  const userHome = mkdtempSync(join(tmpdir(), 'browser-run-entrypoint-'));
  const claudeJsonPath = join(userHome, '.claude.json');
  mkdirSync(join(userHome, '.pi', 'agent'), { recursive: true });
  writeFileSync(claudeJsonPath, '{}');
  const legacyPath = join(userHome, '.pi', 'agent', 'mcp.json');
  const targetPath = join(userHome, '.pi', 'agent', 'mcp-adapter.json');
  if (legacy !== undefined) writeFileSync(legacyPath, JSON.stringify(legacy));
  if (target !== undefined) writeFileSync(targetPath, JSON.stringify(target));
  const migrationStart = entrypoint.indexOf('configure_pi_mcp_adapter() {');
  const migrationEnd = entrypoint.indexOf('\n}', migrationStart) + 2;
  const migrationFunction = entrypoint.slice(migrationStart, migrationEnd);

  const script = `
set -e
USER_HOME="${userHome}"
USER_CLAUDE_JSON="${claudeJsonPath}"
SESSION_MODE=advanced
CLOUDFLARE_API_TOKEN=test-token
CLOUDFLARE_ACCOUNT_ID=test-account
${migrationFunction}
configure_pi_mcp_adapter "${resolve(__dirname, '../../preseed/agents/pi/extensions/00-mcp-adapter-config.ts')}"
${extractBrowserRunBlock()}
`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Browser Run harness exited ${result.status}: ${result.stderr}`);
  }

  return {
    claude: JSON.parse(readFileSync(claudeJsonPath, 'utf8')),
    pi: JSON.parse(readFileSync(targetPath, 'utf8')),
    legacyBytes: target === undefined || legacy === undefined ? undefined : readFileSync(legacyPath, 'utf8'),
  };
}

function wsEndpoint(config) {
  const arg = config.mcpServers['chrome-devtools'].args.find((value) =>
    value.startsWith('--wsEndpoint=')
  );
  assert.ok(arg, 'chrome-devtools config must include a WebSocket endpoint');
  return arg.slice('--wsEndpoint='.length);
}

describe('entrypoint Browser Run MCP registration', () => {
  it('REQ-BROWSER-001 AC5: Claude keeps interactive Browser Run idle for three minutes', () => {
    const { claude } = generatedBrowserConfigs();
    assert.equal(new URL(wsEndpoint(claude)).searchParams.get('keep_alive'), '180000');
  });

  it('REQ-BROWSER-006 AC5: Pi keeps interactive Browser Run idle for three minutes', () => {
    const { pi } = generatedBrowserConfigs();
    assert.equal(new URL(wsEndpoint(pi)).searchParams.get('keep_alive'), '180000');
    assert.equal(pi.mcpServers['chrome-devtools'].lifecycle, 'lazy');
  });

  function checkManagedBrowser(location, keepAlive = '600000') {
    const initial = { mcpServers: {
      'chrome-devtools': { command: 'chrome-devtools-mcp', args: [
        `--wsEndpoint=wss://api.cloudflare.com/client/v4/accounts/test-account/browser-rendering/devtools/browser?keep_alive=${keepAlive}&custom=keep`,
        '--wsHeaders={"Authorization":"Bearer synthetic-user-token"}',
      ], lifecycle: 'lazy' }, custom: { command: 'custom', env: { TOKEN: 'synthetic-secret' } },
    }, settings: { custom: true } };
    const { pi } = generatedBrowserConfigs({ [location]: initial });
    const endpoint = new URL(wsEndpoint(pi));
    assert.deepEqual(endpoint.searchParams.getAll('keep_alive'), ['180000']);
    assert.equal(endpoint.searchParams.get('custom'), 'keep');
    assert.deepEqual(pi.mcpServers['chrome-devtools'].args.slice(1), initial.mcpServers['chrome-devtools'].args.slice(1));
    assert.deepEqual(pi.mcpServers.custom, initial.mcpServers.custom);
    assert.deepEqual(pi.settings, initial.settings);
  }

  it('REQ-BROWSER-006 AC5: legacy Cloudflare browser configuration is limited to three minutes without changing credentials', () => checkManagedBrowser('legacy'));
  it('REQ-BROWSER-006 AC5: target Cloudflare browser configuration is limited to three minutes without changing credentials', () => checkManagedBrowser('target'));

  it('REQ-BROWSER-006 AC5: duplicate retention parameters cannot retain a ten-minute browser', () => checkManagedBrowser('target', '180000&keep_alive=600000'));

  it('REQ-BROWSER-006: legacy migration preserves user browser retention and custom server credentials', () => {
    const legacy = { mcpServers: {
      'chrome-devtools': { command: 'custom-browser', args: ['--wsEndpoint=wss://example.test/?keep_alive=600000'], lifecycle: 'lazy' },
      custom: { command: 'custom', env: { TOKEN: 'synthetic-secret' } },
    }, settings: { custom: true } };
    const { pi } = generatedBrowserConfigs({ legacy });
    assert.deepEqual(pi, legacy);
  });

  it('REQ-BROWSER-006: adapter destination wins without merging or deleting legacy settings', () => {
    const legacy = { mcpServers: { old: { command: 'old' } } };
    const target = { mcpServers: { 'chrome-devtools': { command: 'preferred', args: ['--wsEndpoint=wss://example.test/?keep_alive=600000'] } } };
    const { pi, legacyBytes } = generatedBrowserConfigs({ legacy, target });
    assert.deepEqual(pi, target);
    assert.equal(legacyBytes, JSON.stringify(legacy));
  });
});
