import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

// Extract the entrypoint blocks that handle the context-mode preseed gate.
// We pull the MCP-merge block AND the PLUGINS_CONFIG branch and run them
// in isolation against a fixture filesystem. This is "run the real thing"
// per tdd-discipline.md: a regression in the gate flips the JSON shape.
function extractContextModeMcpBlock() {
  const start = entrypoint.indexOf('# Configure context-mode MCP server.');
  if (start === -1) throw new Error('context-mode MCP block marker not found in entrypoint.sh');
  const blockEnd = entrypoint.indexOf('# Configure Claude Code settings.json', start);
  if (blockEnd === -1) throw new Error('context-mode MCP block end marker not found');
  return entrypoint.slice(start, blockEnd);
}

function extractPluginsConfigBranch() {
  const start = entrypoint.indexOf('# Enable plugins (silently skipped if plugin files absent in default mode)');
  if (start === -1) throw new Error('PLUGINS_CONFIG block marker not found');
  // Capture the `if [ -f $CONTEXT_MODE_MANIFEST ]; then ... else ... fi` selection
  const fiIdx = entrypoint.indexOf('\nfi\n', start);
  if (fiIdx === -1) throw new Error('PLUGINS_CONFIG block fi-terminator not found');
  return entrypoint.slice(start, fiIdx + 4);
}

function buildHarness(cwd, claudeJsonInitial, manifestPresent) {
  // Create a fake $USER_HOME with .claude/plugins/context-mode optionally populated,
  // then run the extracted bash blocks and capture the resulting .claude.json
  // and the value of PLUGINS_CONFIG.
  const userHome = join(cwd, 'user-home');
  mkdirSync(join(userHome, '.claude', 'plugins'), { recursive: true });
  const userClaudeJson = join(userHome, '.claude.json');
  writeFileSync(userClaudeJson, claudeJsonInitial);

  if (manifestPresent) {
    const manifestDir = join(userHome, '.claude', 'plugins', 'context-mode', '.claude-plugin');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      join(manifestDir, 'plugin.json'),
      JSON.stringify({ name: 'context-mode', version: '1.0.111' })
    );
  }

  const mcpBlock = extractContextModeMcpBlock();
  const pluginsBranch = extractPluginsConfigBranch();

  const script = `
set -e
USER_HOME="${userHome}"
USER_CLAUDE_JSON="${userClaudeJson}"
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
  return { claudeJson, pluginsConfig, manifestPath: join(userHome, '.claude', 'plugins', 'context-mode', '.claude-plugin', 'plugin.json') };
}

describe('entrypoint context-mode preseed gate', () => {
  let baseTmp;
  before(() => {
    baseTmp = mkdtempSync(join(tmpdir(), 'cm-gate-'));
  });

  it('manifest present: registers context-mode in mcpServers', () => {
    const cwd = mkdtempSync(join(baseTmp, 'present-mcp-'));
    const { claudeJson } = buildHarness(cwd, '{}', true);
    assert.ok(claudeJson.mcpServers, 'mcpServers key should exist');
    assert.ok(claudeJson.mcpServers['context-mode'], 'context-mode entry should exist');
    assert.equal(claudeJson.mcpServers['context-mode'].command, 'npx');
    assert.deepEqual(claudeJson.mcpServers['context-mode'].args, ['-y', 'context-mode@1.0.111']);
  });

  it('manifest absent: mcpServers["context-mode"] is STILL registered (universal MCP)', () => {
    const cwd = mkdtempSync(join(baseTmp, 'absent-mcp-'));
    const { claudeJson } = buildHarness(cwd, '{}', false);
    assert.ok(claudeJson.mcpServers, 'mcpServers should exist even without manifest');
    assert.ok(
      claudeJson.mcpServers['context-mode'],
      'context-mode MCP must be registered for ALL users so ctx_* tools are universally available'
    );
    assert.equal(claudeJson.mcpServers['context-mode'].command, 'npx');
    assert.deepEqual(
      claudeJson.mcpServers['context-mode'].args,
      ['-y', 'context-mode@1.0.111'],
      'falls back to entrypoint-pinned version when preseed manifest is absent'
    );
  });

  it('manifest present: PLUGINS_CONFIG enables context-mode plugin', () => {
    const cwd = mkdtempSync(join(baseTmp, 'present-plugins-'));
    const { pluginsConfig } = buildHarness(cwd, '{}', true);
    assert.equal(pluginsConfig.enabledPlugins['context-mode'], true);
    assert.equal(pluginsConfig.enabledPlugins['codeflare-memory'], true);
    assert.equal(pluginsConfig.enabledPlugins['codeflare-hooks'], true);
  });

  it('manifest absent: PLUGINS_CONFIG omits context-mode but keeps the others', () => {
    const cwd = mkdtempSync(join(baseTmp, 'absent-plugins-'));
    const { pluginsConfig } = buildHarness(cwd, '{}', false);
    assert.equal(pluginsConfig.enabledPlugins['codeflare-memory'], true);
    assert.equal(pluginsConfig.enabledPlugins['codeflare-hooks'], true);
    assert.ok(
      !('context-mode' in pluginsConfig.enabledPlugins),
      'context-mode key must not be present in enabledPlugins when manifest is absent'
    );
  });

  it('manifest present: preserves existing mcpServers entries (memory, consult-llm)', () => {
    const cwd = mkdtempSync(join(baseTmp, 'merge-existing-'));
    const initial = JSON.stringify({
      mcpServers: {
        memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
        'consult-llm': { command: 'npx', args: ['-y', 'consult-llm-mcp'] },
      },
    });
    const { claudeJson } = buildHarness(cwd, initial, true);
    assert.ok(claudeJson.mcpServers.memory, 'memory MCP must be preserved');
    assert.ok(claudeJson.mcpServers['consult-llm'], 'consult-llm MCP must be preserved');
    assert.ok(claudeJson.mcpServers['context-mode'], 'context-mode MCP must be added');
  });

  it('manifest version is read from preseed plugin.json (not hardcoded in entrypoint)', () => {
    const cwd = mkdtempSync(join(baseTmp, 'version-from-manifest-'));
    // Mutate the version to a non-default value before extracting:
    const userHome = join(cwd, 'user-home');
    mkdirSync(join(userHome, '.claude', 'plugins', 'context-mode', '.claude-plugin'), {
      recursive: true,
    });
    const manifestPath = join(
      userHome,
      '.claude',
      'plugins',
      'context-mode',
      '.claude-plugin',
      'plugin.json'
    );
    writeFileSync(manifestPath, JSON.stringify({ name: 'context-mode', version: '2.5.42' }));
    writeFileSync(join(userHome, '.claude.json'), '{}');

    const mcpBlock = extractContextModeMcpBlock();
    const script = `
set -e
USER_HOME="${userHome}"
USER_CLAUDE_JSON="${join(userHome, '.claude.json')}"
${mcpBlock}
`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
    assert.equal(result.status, 0, `harness failed: ${result.stderr}`);
    const claudeJson = JSON.parse(readFileSync(join(userHome, '.claude.json'), 'utf-8'));
    assert.deepEqual(claudeJson.mcpServers['context-mode'].args, ['-y', 'context-mode@2.5.42']);
  });
});
