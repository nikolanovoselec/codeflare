// REQ-AGENT-031: the entrypoint consult-llm block isolates provider keys to the
// MCP server, prefers the Codex subscription over the API key for OpenAI, gives
// Pi the tool via directTools, and is fully disabled in enterprise mode.
//
// "Run the real thing" per tdd-discipline.md: we extract the two bash functions
// from entrypoint.sh and execute them against fixture filesystems. A regression
// in backend selection, key isolation, or the enterprise gate flips the emitted
// JSON or the on-disk skill dirs, which these assertions catch.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

// Pull both function definitions (_merge_consult_llm_mcp + configure_consult_llm)
// but NOT the trailing `configure_consult_llm || echo ...` auto-call, so the
// harness controls the env and invokes the function itself.
function extractConsultLlmBlock() {
  const start = entrypoint.indexOf('_merge_consult_llm_mcp() {');
  if (start === -1) throw new Error('consult-llm block start marker not found in entrypoint.sh');
  const end = entrypoint.indexOf('configure_consult_llm || echo', start);
  if (end === -1) throw new Error('consult-llm block end marker not found in entrypoint.sh');
  return entrypoint.slice(start, end);
}

function buildHarness(baseTmp, opts = {}) {
  const {
    enterprise = false,
    codexAuth = false,
    openaiKey = null,
    geminiKey = null,
    claudeJsonInitial = null, // string => pre-existing file; null => absent
    seedSkills = false,       // pre-create skill dirs to test enterprise removal
  } = opts;

  const cwd = mkdtempSync(join(baseTmp, 'consult-'));
  const userHome = join(cwd, 'user-home');
  mkdirSync(userHome, { recursive: true });
  const userClaudeJson = join(userHome, '.claude.json');
  if (claudeJsonInitial !== null) writeFileSync(userClaudeJson, claudeJsonInitial);

  if (codexAuth) {
    mkdirSync(join(userHome, '.codex'), { recursive: true });
    writeFileSync(join(userHome, '.codex', 'auth.json'), '{"OPENAI_API_KEY":"sub"}');
  }
  if (seedSkills) {
    const claudeSkill = join(userHome, '.claude', 'skills', 'consult-llm');
    const piSkill = join(userHome, '.pi', 'agent', 'skills', 'consult-llm');
    mkdirSync(claudeSkill, { recursive: true });
    writeFileSync(join(claudeSkill, 'SKILL.md'), 'x');
    mkdirSync(piSkill, { recursive: true });
    writeFileSync(join(piSkill, 'SKILL.md'), 'x');
  }

  const envLines = [
    `USER_HOME="${userHome}"`,
    `USER_CLAUDE_JSON="${userClaudeJson}"`,
    enterprise ? 'ENTERPRISE_MODE="active"' : '',
    openaiKey ? `CODEFLARE_OPENAI_API_KEY="${openaiKey}"` : '',
    geminiKey ? `CODEFLARE_GEMINI_API_KEY="${geminiKey}"` : '',
  ].filter(Boolean).join('\n');

  const script = `
set -euo pipefail
${envLines}
${extractConsultLlmBlock()}
configure_consult_llm
`;

  const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`harness bash exited ${result.status}: ${result.stderr}\n${result.stdout}`);
  }

  const piMcpPath = join(userHome, '.pi', 'agent', 'mcp.json');
  return {
    stdout: result.stdout,
    claudeJson: existsSync(userClaudeJson) ? JSON.parse(readFileSync(userClaudeJson, 'utf-8')) : null,
    piMcp: existsSync(piMcpPath) ? JSON.parse(readFileSync(piMcpPath, 'utf-8')) : null,
    claudeSkillExists: existsSync(join(userHome, '.claude', 'skills', 'consult-llm')),
    piSkillExists: existsSync(join(userHome, '.pi', 'agent', 'skills', 'consult-llm')),
  };
}

describe('entrypoint consult-llm configuration / REQ-AGENT-031 (key isolation, subscription backend, Pi parity, enterprise gate)', () => {
  let baseTmp;
  before(() => {
    baseTmp = mkdtempSync(join(tmpdir(), 'consult-llm-'));
  });

  // AC3: OpenAI prefers the Codex subscription when ~/.codex/auth.json exists.
  it('codex auth present, no keys: OpenAI routes through codex-cli (no API key in env)', () => {
    const h = buildHarness(baseTmp, { codexAuth: true });
    const claude = h.claudeJson.mcpServers['consult-llm'];
    // consult-llm-mcp is pre-warmed as a pinned global install (Dockerfile), so the
    // MCP command is the global bin, not a per-session `npx -y` registry fetch.
    assert.equal(claude.command, 'consult-llm-mcp');
    assert.deepEqual(claude.args, []);
    assert.equal(claude.env.CONSULT_LLM_OPENAI_BACKEND, 'codex-cli');
    assert.equal(claude.env.CONSULT_LLM_CODEX_REASONING_EFFORT, 'high');
    assert.ok(!('OPENAI_API_KEY' in claude.env), 'subscription path injects no API key');
    assert.ok(!('directTools' in claude), 'Claude server is not promoted via directTools');
    // lifecycle is a pi-mcp-adapter concept; Claude Code does not use it.
    assert.ok(!('lifecycle' in claude), 'Claude server carries no Pi-only lifecycle field');
  });

  // AC4: Pi gets the same server with directTools promoting consult_llm to first-class.
  it('Pi mcp.json mirrors the server and promotes consult_llm via directTools', () => {
    const h = buildHarness(baseTmp, { codexAuth: true });
    const pi = h.piMcp.mcpServers['consult-llm'];
    assert.equal(pi.command, 'consult-llm-mcp');
    assert.deepEqual(pi.args, []);
    assert.deepEqual(pi.directTools, ['consult_llm']);
    assert.equal(pi.env.CONSULT_LLM_OPENAI_BACKEND, 'codex-cli');
    // keep-alive so pi-mcp-adapter reconnects instead of dropping to "0/1 ... cached" on idle.
    assert.equal(pi.lifecycle, 'keep-alive', 'Pi consult-llm server is keep-alive');
  });

  // AC3: no Codex login => fall back to the API key (api backend, no codex env var).
  it('no codex, OpenAI key set: OpenAI routes through the API key', () => {
    const h = buildHarness(baseTmp, { openaiKey: 'sk-openai' });
    const env = h.claudeJson.mcpServers['consult-llm'].env;
    assert.equal(env.OPENAI_API_KEY, 'sk-openai');
    assert.ok(!('CONSULT_LLM_OPENAI_BACKEND' in env), 'API path sets no codex backend var');
  });

  // AC3: when both are present the subscription wins, but the key rides along as a fallback.
  it('codex auth + OpenAI key: codex-cli backend with the API key as fallback', () => {
    const h = buildHarness(baseTmp, { codexAuth: true, openaiKey: 'sk-openai' });
    const env = h.claudeJson.mcpServers['consult-llm'].env;
    assert.equal(env.CONSULT_LLM_OPENAI_BACKEND, 'codex-cli');
    assert.equal(env.OPENAI_API_KEY, 'sk-openai');
  });

  // AC3: Gemini is always the API key (no consult-llm-compatible Gemini subscription CLI).
  it('Gemini key only: Gemini routes through the API key', () => {
    const h = buildHarness(baseTmp, { geminiKey: 'gm-gemini' });
    const env = h.claudeJson.mcpServers['consult-llm'].env;
    assert.equal(env.GEMINI_API_KEY, 'gm-gemini');
    assert.ok(!('OPENAI_API_KEY' in env));
    assert.ok(!('CONSULT_LLM_OPENAI_BACKEND' in env));
  });

  // No usable provider => no server is written anywhere (and no crash under set -e).
  it('no codex and no keys: writes no MCP config at all', () => {
    const h = buildHarness(baseTmp, {});
    assert.equal(h.claudeJson, null, 'no ~/.claude.json written');
    assert.equal(h.piMcp, null, 'no ~/.pi/agent/mcp.json written');
    assert.match(h.stdout, /no usable provider/);
  });

  // No usable provider also strips the seeded consult-llm skill dirs, so the agent
  // is not left with a skill for a server that was never registered (parity with the
  // enterprise gate and the browser-run skill gate).
  it('no codex and no keys: removes the seeded consult-llm skill dirs', () => {
    const h = buildHarness(baseTmp, { seedSkills: true });
    assert.equal(h.claudeJson, null, 'no consult-llm config written');
    assert.equal(h.claudeSkillExists, false, 'Claude consult-llm skill dir removed');
    assert.equal(h.piSkillExists, false, 'Pi consult-llm skill dir removed');
    assert.match(h.stdout, /no usable provider/);
  });

  // AC1: merge preserves any pre-existing mcpServers (jq `. * $mcp` deep-merge).
  it('preserves existing mcpServers entries when merging consult-llm', () => {
    const initial = JSON.stringify({
      mcpServers: { 'context-mode': { command: 'context-mode', args: [] } },
    });
    const h = buildHarness(baseTmp, { codexAuth: true, claudeJsonInitial: initial });
    assert.ok(h.claudeJson.mcpServers['context-mode'], 'existing server preserved');
    assert.ok(h.claudeJson.mcpServers['consult-llm'], 'consult-llm added alongside');
  });

  // AC6: enterprise mode disables consult-llm entirely and removes the seeded skill
  // dirs, even when provider keys somehow remain in the environment.
  it('enterprise mode: writes no config and removes the seeded skill dirs', () => {
    const h = buildHarness(baseTmp, {
      enterprise: true,
      openaiKey: 'sk-openai',
      geminiKey: 'gm-gemini',
      seedSkills: true,
    });
    assert.equal(h.claudeJson, null, 'no consult-llm config for Claude in enterprise');
    assert.equal(h.piMcp, null, 'no consult-llm config for Pi in enterprise');
    assert.equal(h.claudeSkillExists, false, 'Claude consult-llm skill dir removed');
    assert.equal(h.piSkillExists, false, 'Pi consult-llm skill dir removed');
    assert.match(h.stdout, /Enterprise Mode: consult-llm disabled/);
  });
});
