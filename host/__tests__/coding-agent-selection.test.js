import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import {
  verifySelectedAgentLaunchers,
  verifySelectedAgentPackages,
} from '../../scripts/ci/smoke-openvscode-sidebar-image.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const selectorPath = join(ROOT, 'scripts/ci/coding-agent-selection.mjs');
const deploy = parseYaml(readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8'));
const containerWorkflow = parseYaml(readFileSync(join(ROOT, '.github/workflows/container-image.yml'), 'utf8'));

const ALL_AGENTS = 'claude-code,codex,copilot,antigravity,opencode,pi';

async function selector() {
  return import(`file://${selectorPath}?test=${Date.now()}-${Math.random()}`);
}

describe('REQ-OPS-038: deployment coding-agent selection', () => {
  it('defaults to every coding agent and canonicalizes a configured subset', async () => {
    const { CODING_AGENTS, CODING_AGENT_COMMANDS, resolveCodingAgents } = await selector();
    assert.deepEqual(Object.keys(CODING_AGENT_COMMANDS), CODING_AGENTS);
    assert.equal(resolveCodingAgents(undefined), ALL_AGENTS);
    assert.equal(resolveCodingAgents(' pi,claude-code,codex '), 'claude-code,codex,pi');
    assert.equal(resolveCodingAgents('codex,codex'), 'codex');
  });

  it('rejects empty explicit sets and unknown agent names', async () => {
    const { resolveCodingAgents } = await selector();
    assert.throws(() => resolveCodingAgents(' , '), /at least one coding agent/i);
    assert.throws(() => resolveCodingAgents('claude-code,gemini'), /unknown coding agent.*gemini/i);
  });

  it('derives an npm manifest containing only selected coding agents plus shared tools', async () => {
    const { selectedNpmManifest } = await selector();
    const manifest = JSON.parse(readFileSync(join(ROOT, 'preseed/npm-tools/package.json'), 'utf8'));
    const originalCopilotVersion = manifest.dependencies['@github/copilot'];
    const selected = selectedNpmManifest(manifest, 'claude-code,codex,pi');

    assert.equal(selected.dependencies['@anthropic-ai/claude-code'], manifest.dependencies['@anthropic-ai/claude-code']);
    assert.equal(selected.dependencies['@openai/codex'], manifest.dependencies['@openai/codex']);
    assert.equal(selected.dependencies['@earendil-works/pi-coding-agent'], manifest.dependencies['@earendil-works/pi-coding-agent']);
    assert.equal(selected.dependencies.bun, manifest.dependencies.bun);
    assert.equal(selected.dependencies['context-mode'], manifest.dependencies['context-mode']);
    assert.equal(selected.dependencies['chrome-devtools-mcp'], manifest.dependencies['chrome-devtools-mcp']);
    assert.equal(selected.dependencies['@github/copilot'], undefined);
    assert.equal(selected.dependencies['opencode-ai'], undefined);
    assert.equal(manifest.dependencies['@github/copilot'], originalCopilotVersion, 'the source manifest must not be mutated');
  });

  it('the packaged-image smoke starts selected launchers and requires omitted launchers to be absent', async () => {
    const commands = {
      'claude-code': { path: '/agents/claude', args: ['--version'] },
      codex: { path: '/agents/codex', args: ['--version'] },
      copilot: { path: '/agents/copilot', args: ['--version'] },
      pi: { path: '/agents/pi', args: ['--version'] },
    };
    const present = new Set(['/agents/claude', '/agents/codex', '/agents/pi']);
    const inspected = [];
    const started = [];
    const versions = await verifySelectedAgentLaunchers('claude-code,codex,pi', {
      commands,
      hasCodingAgent: (selection, agent) => selection.split(',').includes(agent),
      inspectPath: async (path) => {
        inspected.push(path);
        if (!present.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      run: (path) => {
        started.push(path);
        return `${path} 1.0.0\n`;
      },
    });

    assert.deepEqual(inspected, Object.values(commands).map(({ path }) => path));
    assert.deepEqual(started, ['/agents/claude', '/agents/codex', '/agents/pi']);
    assert.equal(versions.copilot, null);
  });

  it('the complete-image smoke rejects alternate platform packages after pruning', async () => {
    const inventories = new Map([
      ['/npm/@anthropic-ai', ['claude-code', 'claude-code-linux-x64']],
      ['/npm/@github', []],
      ['/npm/@openai', ['codex', 'codex-linux-x64']],
      ['/npm', ['opencode-ai', 'opencode-linux-x64']],
    ]);
    const options = {
      hasCodingAgent: (selection, agent) => selection.split(',').includes(agent),
      nodeModulesPath: '/npm',
      readDirectory: async (path) => inventories.get(path) ?? [],
    };

    assert.deepEqual(
      await verifySelectedAgentPackages('claude-code,codex,opencode', options),
      {
        'claude-code': ['claude-code', 'claude-code-linux-x64'],
        codex: ['codex', 'codex-linux-x64'],
        copilot: [],
        opencode: ['opencode-ai', 'opencode-linux-x64'],
      },
    );

    inventories.set('/npm/@anthropic-ai', [
      'claude-code',
      'claude-code-linux-x64',
      'claude-code-linux-x64-musl',
    ]);
    await assert.rejects(
      verifySelectedAgentPackages('claude-code,codex,opencode', options),
      /claude-code package inventory/i,
    );
  });

  it('fails closed at the selector CLI boundary', () => {
    const result = spawnSync(process.execPath, [selectorPath, 'resolve', 'pi,unknown'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown coding agent.*unknown/i);
  });

  it('passes the environment-scoped selection through deployment and image identity', () => {
    assert.equal(deploy.jobs.prepare.outputs.coding_agents, "${{ vars.CODING_AGENTS || 'claude-code,codex,copilot,antigravity,opencode,pi' }}");
    assert.equal(deploy.jobs.container.with['coding-agents'], '${{ needs.prepare.outputs.coding_agents }}');

    assert.equal(containerWorkflow.on.workflow_call.inputs['coding-agents'].default, ALL_AGENTS);
  });
});
