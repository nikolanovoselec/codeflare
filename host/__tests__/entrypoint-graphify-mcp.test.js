// Verifies REQ-AGENT-023 AC2: graphify MCP server registration in
// ~/.claude.json (unconditional - both default and advanced modes) and
// AC1 tier-independent presence via the GRAPHIFY_MANIFEST gate.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

function extractGraphifyMcpBlock() {
  const start = entrypoint.indexOf('# Configure graphify MCP server.');
  if (start === -1) throw new Error('graphify MCP block marker not found in entrypoint.sh');
  const blockEnd = entrypoint.indexOf('# Configure Claude Code settings.json', start);
  if (blockEnd === -1) throw new Error('graphify MCP block end marker not found');
  return entrypoint.slice(start, blockEnd);
}

function extractPluginsConfigBranch() {
  const start = entrypoint.indexOf('# Enable plugins (silently skipped if plugin files absent in default mode)');
  if (start === -1) throw new Error('PLUGINS_CONFIG block marker not found');
  const fiIdx = entrypoint.indexOf('\nfi\n', entrypoint.indexOf('GRAPHIFY_MANIFEST', start));
  if (fiIdx === -1) throw new Error('PLUGINS_CONFIG block fi-terminator not found');
  return entrypoint.slice(start, fiIdx + 4);
}

function buildHarness(cwd, claudeJsonInitial, manifestPresent) {
  const userHome = join(cwd, 'user-home');
  mkdirSync(join(userHome, '.claude', 'plugins'), { recursive: true });
  const userClaudeJson = join(userHome, '.claude.json');
  writeFileSync(userClaudeJson, claudeJsonInitial);

  if (manifestPresent) {
    const manifestDir = join(userHome, '.claude', 'plugins', 'graphify', '.claude-plugin');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      join(manifestDir, 'plugin.json'),
      JSON.stringify({ name: 'graphify', version: '0.7.19' })
    );
  }

  const mcpBlock = extractGraphifyMcpBlock();
  const pluginsBranch = extractPluginsConfigBranch();

  const script = `
set -e
USER_HOME="${userHome}"
USER_CLAUDE_JSON="${userClaudeJson}"
# CONTEXT_MODE_MANIFEST is referenced in the plugins-branch but we keep it
# absent so the test isolates the graphify gate; the context-mode branch
# is exercised in entrypoint-context-mode.test.js.
CONTEXT_MODE_MANIFEST="${userHome}/.claude/plugins/context-mode/.claude-plugin/plugin.json"
${mcpBlock}
${pluginsBranch}
echo "PLUGINS_CONFIG=$PLUGINS_CONFIG"
`;

  const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`harness bash exited ${result.status}: ${result.stderr}`);
  }

  const claudeJson = JSON.parse(readFileSync(userClaudeJson, 'utf-8'));
  const pluginsConfigMatch = result.stdout.match(/PLUGINS_CONFIG=(.+)$/m);
  if (!pluginsConfigMatch) {
    throw new Error(`PLUGINS_CONFIG not found in stdout:\n${result.stdout}`);
  }
  const pluginsConfig = JSON.parse(pluginsConfigMatch[1]);
  return { claudeJson, pluginsConfig };
}

describe('entrypoint graphify preseed gate', () => {
  let baseTmp;
  before(() => {
    baseTmp = mkdtempSync(join(tmpdir(), 'gf-gate-'));
  });

  it('manifest present: registers graphify in mcpServers with python3 -m graphify.serve', () => {
    const cwd = mkdtempSync(join(baseTmp, 'present-mcp-'));
    const { claudeJson } = buildHarness(cwd, '{}', true);
    assert.ok(claudeJson.mcpServers, 'mcpServers key should exist');
    assert.ok(claudeJson.mcpServers.graphify, 'graphify entry should exist');
    assert.equal(
      claudeJson.mcpServers.graphify.command,
      'python3',
      'MCP command must invoke python3 to launch the graphify.serve module'
    );
    assert.deepEqual(
      claudeJson.mcpServers.graphify.args,
      ['-m', 'graphify.serve'],
      'args must invoke the graphifyy package serve entrypoint'
    );
  });

  it('manifest absent: graphify NOT registered (capability gated on plugin presence)', () => {
    const cwd = mkdtempSync(join(baseTmp, 'absent-mcp-'));
    const { claudeJson } = buildHarness(cwd, '{}', false);
    assert.ok(
      !claudeJson.mcpServers || !claudeJson.mcpServers.graphify,
      'graphify MCP entry must not be registered when plugin manifest is absent'
    );
  });

  it('manifest present: PLUGINS_CONFIG enables graphify plugin', () => {
    const cwd = mkdtempSync(join(baseTmp, 'present-plugins-'));
    const { pluginsConfig } = buildHarness(cwd, '{}', true);
    assert.equal(pluginsConfig.enabledPlugins.graphify, true);
    assert.equal(pluginsConfig.enabledPlugins['codeflare-memory'], true);
    assert.equal(pluginsConfig.enabledPlugins['codeflare-hooks'], true);
  });

  it('manifest absent: PLUGINS_CONFIG omits graphify but keeps the baseline plugins', () => {
    const cwd = mkdtempSync(join(baseTmp, 'absent-plugins-'));
    const { pluginsConfig } = buildHarness(cwd, '{}', false);
    assert.equal(pluginsConfig.enabledPlugins['codeflare-memory'], true);
    assert.equal(pluginsConfig.enabledPlugins['codeflare-hooks'], true);
    assert.ok(
      !('graphify' in pluginsConfig.enabledPlugins),
      'graphify key must not be present in enabledPlugins when manifest is absent'
    );
  });

  it('manifest present: preserves existing mcpServers entries (consult-llm)', () => {
    const cwd = mkdtempSync(join(baseTmp, 'merge-existing-'));
    const initial = JSON.stringify({
      mcpServers: {
        'consult-llm': { command: 'npx', args: ['-y', 'consult-llm-mcp'] },
      },
    });
    const { claudeJson } = buildHarness(cwd, initial, true);
    assert.ok(claudeJson.mcpServers['consult-llm'], 'consult-llm MCP must be preserved');
    assert.ok(claudeJson.mcpServers.graphify, 'graphify MCP must be added');
  });

  it('MCP entry contains no version pin (build-time uv tool install is authoritative)', () => {
    // Version flows: plugin.json .version -> Dockerfile build-time uv tool
    // install -> the graphify.serve module on PYTHONPATH. The MCP entry
    // itself stays version-agnostic so a Dependabot bump of plugin.json
    // does not require an entrypoint change.
    const cwd = mkdtempSync(join(baseTmp, 'no-version-pin-'));
    const { claudeJson } = buildHarness(cwd, '{}', true);
    const gf = claudeJson.mcpServers.graphify;
    assert.ok(
      !JSON.stringify(gf).includes('=='),
      'no ==<version> anywhere in the MCP entry'
    );
    assert.ok(
      !JSON.stringify(gf).includes('0.7.19'),
      'no inline version string in the MCP entry'
    );
  });

  it('REQ-AGENT-023 runtime self-heal: graphify CLI symlink present in entrypoint.sh', () => {
    // Defensive idempotent symlink. The Dockerfile creates it at build
    // time (dockerfile-graphify.test.js asserts that side), but any
    // container whose /usr/local/bin was overwritten by a bisync round-
    // trip needs the self-heal to recover. Production-verified: without
    // this, hook-spawned subshells silently noop graphify global add
    // because /root/.local/bin is not on system PATH.
    assert.ok(
      entrypoint.includes('GRAPHIFY_BIN_SRC="/root/.local/share/uv/tools/graphifyy/bin/graphify"'),
      'entrypoint.sh must define GRAPHIFY_BIN_SRC pointing at the uv-installed shim'
    );
    assert.ok(
      entrypoint.includes('GRAPHIFY_BIN_DST="/usr/local/bin/graphify"'),
      'entrypoint.sh must define GRAPHIFY_BIN_DST pointing at the system PATH location'
    );
    // The conditional must be idempotent: only symlink if src exists AND
    // dst is absent, so a baked-in Dockerfile symlink is not clobbered.
    // Three separate substring checks — robust to formatting changes
    // (added comments, line breaks, indentation shifts) while still
    // pinning the safety contract.
    assert.ok(
      entrypoint.includes('[ -x "$GRAPHIFY_BIN_SRC" ]'),
      'self-heal must check that the source binary exists and is executable'
    );
    assert.ok(
      entrypoint.includes('[ ! -e "$GRAPHIFY_BIN_DST" ]'),
      'self-heal must check that the destination is absent (do not clobber existing symlink)'
    );
    assert.ok(
      entrypoint.includes('ln -sf "$GRAPHIFY_BIN_SRC" "$GRAPHIFY_BIN_DST"'),
      'self-heal must use ln -sf with the canonical SRC/DST variables'
    );
  });
});
