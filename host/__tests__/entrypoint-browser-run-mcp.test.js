// Verifies the Browser Run wiring in entrypoint.sh by executing the actual
// block with a stubbed env + temp HOME and asserting the resulting MCP configs:
//   REQ-BROWSER-001 AC1/AC2  - chrome-devtools registered for Claude (advanced +
//                              token gate, CDP endpoint, bearer wsHeaders, pin).
//   REQ-BROWSER-005 AC2      - the Claude browser-run MCP server registered.
//   REQ-BROWSER-006 AC1/AC4  - chrome-devtools registered for Pi in mcp.json
//                              (lazy), and nothing registered without the gate.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

function extractBrowserBlock() {
  const start = entrypoint.indexOf('# Configure Browser Run (Cloudflare Browser Rendering)');
  if (start === -1) throw new Error('Browser Run block start marker not found in entrypoint.sh');
  const end = entrypoint.indexOf('# Configure Claude Code settings.json with hooks', start);
  if (end === -1) throw new Error('Browser Run block end marker not found in entrypoint.sh');
  return entrypoint.slice(start, end);
}

function run({ mode = 'advanced', token = 'tok_abc', account = 'acct123', claudeInitial = '{}', piInitial }) {
  const cwd = mkdtempSync(join(tmpdir(), 'br-mcp-'));
  const userHome = join(cwd, 'home');
  mkdirSync(userHome, { recursive: true });
  const userClaudeJson = join(userHome, '.claude.json');
  writeFileSync(userClaudeJson, claudeInitial);
  const piMcpJson = join(userHome, '.pi', 'agent', 'mcp.json');
  if (piInitial !== undefined) {
    mkdirSync(dirname(piMcpJson), { recursive: true });
    writeFileSync(piMcpJson, piInitial);
  }

  // The browser-run / browser-e2e skills are seeded unconditionally by the
  // agent-config sync; the block must keep them when the token gate holds and strip
  // them otherwise. Seed all four so the keep/strip behaviour is observable.
  const skillPaths = {
    claudeBrowserRun: join(userHome, '.claude', 'skills', 'browser-run'),
    claudeBrowserE2e: join(userHome, '.claude', 'skills', 'browser-e2e'),
    piBrowserRun: join(userHome, '.pi', 'agent', 'skills', 'browser-run'),
    piBrowserE2e: join(userHome, '.pi', 'agent', 'skills', 'browser-e2e'),
  };
  for (const dir of Object.values(skillPaths)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# browser skill\n');
  }

  const env = [
    `SESSION_MODE='${mode}'`,
    token === null ? 'unset CLOUDFLARE_API_TOKEN || true' : `CLOUDFLARE_API_TOKEN='${token}'`,
    account === null ? 'unset CLOUDFLARE_ACCOUNT_ID || true' : `CLOUDFLARE_ACCOUNT_ID='${account}'`,
    `USER_HOME='${userHome}'`,
    `USER_CLAUDE_JSON='${userClaudeJson}'`,
  ].join('\n');

  const script = `set -e\n${env}\n${extractBrowserBlock()}\n`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`harness bash exited ${result.status}: ${result.stderr}`);
  return {
    claude: JSON.parse(readFileSync(userClaudeJson, 'utf-8')),
    pi: existsSync(piMcpJson) ? JSON.parse(readFileSync(piMcpJson, 'utf-8')) : null,
    skills: Object.fromEntries(Object.entries(skillPaths).map(([k, p]) => [k, existsSync(p)])),
  };
}

describe('entrypoint Browser Run MCP wiring', () => {
  it('advanced + token: registers chrome-devtools for Claude pointed at the CDP endpoint with a bearer header', () => {
    const { claude } = run({});
    const cd = claude.mcpServers['chrome-devtools'];
    assert.ok(cd, 'chrome-devtools must be registered for Claude');
    assert.equal(cd.command, 'npx');
    assert.ok(cd.args.includes('chrome-devtools-mcp@1.1.1'), 'pins the chrome-devtools-mcp version (not @latest)');
    const wsEndpoint = cd.args.find((a) => a.startsWith('--wsEndpoint='));
    assert.ok(wsEndpoint, '--wsEndpoint arg present');
    assert.ok(wsEndpoint.includes('acct123'), 'CDP endpoint carries the account id');
    assert.ok(wsEndpoint.includes('browser-rendering/devtools/browser'), 'points at the Browser Run CDP /devtools socket');
    const wsHeaders = cd.args.find((a) => a.startsWith('--wsHeaders='));
    assert.ok(wsHeaders && wsHeaders.includes('Bearer tok_abc'), 'API token passed as Authorization: Bearer via --wsHeaders');
  });

  it('advanced + token: registers the Claude browser-run MCP server (node /opt/codeflare/browser-run-mcp/index.mjs)', () => {
    const { claude } = run({});
    const br = claude.mcpServers['browser-run'];
    assert.ok(br, 'browser-run MCP server must be registered for Claude');
    assert.equal(br.command, 'node');
    assert.equal(br.args[0], '/opt/codeflare/browser-run-mcp/index.mjs');
    assert.equal(br.env.CLOUDFLARE_API_TOKEN, 'tok_abc', 'token passed in scoped env');
    assert.equal(br.env.CLOUDFLARE_ACCOUNT_ID, 'acct123', 'account passed in scoped env');
  });

  it('advanced + token: registers chrome-devtools for Pi in mcp.json with lifecycle lazy', () => {
    const { pi } = run({});
    assert.ok(pi, 'Pi mcp.json must be created');
    const cd = pi.mcpServers['chrome-devtools'];
    assert.ok(cd, 'chrome-devtools must be registered for Pi');
    assert.equal(cd.command, 'npx');
    assert.equal(cd.lifecycle, 'lazy', 'lazy so an idle session does not hold a remote browser open');
    assert.ok(cd.args.some((a) => a.startsWith('--wsEndpoint=')), 'Pi points at the same CDP endpoint');
    assert.ok(cd.args.some((a) => a.startsWith('--wsHeaders=')), 'Pi carries the bearer header');
  });

  it('default (non-advanced) mode: nothing registered for either agent', () => {
    const { claude, pi } = run({ mode: 'default' });
    assert.ok(!claude.mcpServers || !claude.mcpServers['chrome-devtools'], 'no chrome-devtools in default mode');
    assert.ok(!claude.mcpServers || !claude.mcpServers['browser-run'], 'no browser-run in default mode');
    assert.equal(pi, null, 'Pi mcp.json not created in default mode');
  });

  it('advanced but no token: nothing registered (byte-identical to today)', () => {
    const { claude, pi } = run({ token: null });
    assert.deepEqual(claude, {}, 'claude.json untouched without a token');
    assert.equal(pi, null, 'Pi mcp.json not created without a token');
  });

  it('preserves existing mcpServers entries when merging (consult-llm survives on both agents)', () => {
    const claudeInitial = JSON.stringify({ mcpServers: { 'consult-llm': { command: 'consult-llm-mcp', args: [] } } });
    const piInitial = JSON.stringify({ mcpServers: { 'consult-llm': { command: 'consult-llm-mcp', args: [], lifecycle: 'keep-alive' } } });
    const { claude, pi } = run({ claudeInitial, piInitial });
    assert.ok(claude.mcpServers['consult-llm'], 'consult-llm preserved on Claude');
    assert.ok(claude.mcpServers['chrome-devtools'], 'chrome-devtools added on Claude');
    assert.ok(claude.mcpServers['browser-run'], 'browser-run added on Claude');
    assert.ok(pi.mcpServers['consult-llm'], 'consult-llm preserved on Pi');
    assert.ok(pi.mcpServers['chrome-devtools'], 'chrome-devtools added on Pi');
  });

  it('advanced + token: keeps the browser-run/browser-e2e skills for both agents', () => {
    const { skills } = run({});
    assert.equal(skills.claudeBrowserRun, true, 'Claude browser-run skill kept');
    assert.equal(skills.claudeBrowserE2e, true, 'Claude browser-e2e skill kept');
    assert.equal(skills.piBrowserRun, true, 'Pi browser-run skill kept');
    assert.equal(skills.piBrowserE2e, true, 'Pi browser-e2e skill kept');
  });

  it('advanced but no token: strips the browser-run/browser-e2e skills from both agents', () => {
    const { skills } = run({ token: null });
    assert.equal(skills.claudeBrowserRun, false, 'Claude browser-run skill removed');
    assert.equal(skills.claudeBrowserE2e, false, 'Claude browser-e2e skill removed');
    assert.equal(skills.piBrowserRun, false, 'Pi browser-run skill removed');
    assert.equal(skills.piBrowserE2e, false, 'Pi browser-e2e skill removed');
  });

  it('default (non-advanced) mode: strips the browser-run/browser-e2e skills too', () => {
    const { skills } = run({ mode: 'default' });
    assert.equal(skills.claudeBrowserRun, false, 'Claude browser-run skill removed in default mode');
    assert.equal(skills.piBrowserRun, false, 'Pi browser-run skill removed in default mode');
  });
});
