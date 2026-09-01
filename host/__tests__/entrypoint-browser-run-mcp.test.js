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

function generatedBrowserConfigs() {
  const userHome = mkdtempSync(join(tmpdir(), 'browser-run-entrypoint-'));
  const claudeJsonPath = join(userHome, '.claude.json');
  mkdirSync(join(userHome, '.pi', 'agent'), { recursive: true });
  writeFileSync(claudeJsonPath, '{}');

  const script = `
set -e
USER_HOME="${userHome}"
USER_CLAUDE_JSON="${claudeJsonPath}"
SESSION_MODE=advanced
CLOUDFLARE_API_TOKEN=test-token
CLOUDFLARE_ACCOUNT_ID=test-account
${extractBrowserRunBlock()}
`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Browser Run harness exited ${result.status}: ${result.stderr}`);
  }

  return {
    claude: JSON.parse(readFileSync(claudeJsonPath, 'utf8')),
    pi: JSON.parse(readFileSync(join(userHome, '.pi', 'agent', 'mcp.json'), 'utf8')),
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
  });
});
