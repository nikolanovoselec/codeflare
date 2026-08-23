import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(__dirname, '../../entrypoint.sh');

function extractFunction(name) {
  const lines = readFileSync(ENTRYPOINT, 'utf8').split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${name}\\(\\) \\{`).test(line));
  if (start === -1) throw new Error(`Could not locate ${name}() in entrypoint.sh`);
  const end = lines.findIndex((line, index) => {
    if (index <= start || line !== '}') return false;
    if (name !== 'warm_pi_npm_dependencies') return true;
    return lines[index + 2] === 'update_pi_when_fast_start_disabled() {';
  });
  if (end === -1) throw new Error(`Could not locate the end of ${name}()`);
  return lines.slice(start, end + 1).join('\n');
}

function runFunction(name, setup, invocation, env = {}) {
  return spawnSync('bash', ['-c', `${extractFunction(name)}\n${setup}\n${invocation}`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runStartupInvocation(name, env = {}) {
  const lines = readFileSync(ENTRYPOINT, 'utf8').split('\n');
  const invocation = lines.find((line) => line === name || line.startsWith(`${name} || `));
  if (!invocation) throw new Error(`Could not locate production startup invocation for ${name}()`);
  return spawnSync('bash', ['-c', `${extractFunction(name)}\n${invocation}`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const EXPECTED_PLAN_MODE_SETTINGS = {
  thinkingLevel: 'inherit',
  implementationPlanRetention: 'keep',
  defaultPlanTools: [
    'bash',
    'find',
    'grep',
    'ls',
    'read',
    'browser_content',
    'browser_markdown',
    'browser_scrape',
    'fetch_content',
    'get_search_content',
    'source_check',
    'web_search',
    'ctx_execute_file',
    'ctx_fetch_and_index',
    'ctx_index',
    'ctx_search',
    'graphify_explain',
    'graphify_path',
    'graphify_query',
  ],
};

describe('entrypoint production helpers', () => {
  it('REQ-AGENT-111 AC4 / REQ-AGENT-129 AC1: creates every Codeflare-owned Goal startup default when config is absent', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'pi-goal-settings-'));
    const configPath = join(fixture, '.pi/agent/pi-goal.json');
    const conflictingPath = join(fixture, 'legacy/pi-goal.json');
    const env = { USER_HOME: fixture, PI_GOAL_CONFIG_FILE: conflictingPath };

    const result = runStartupInvocation('configure_pi_goal_defaults', env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      toolVisibility: 'after-first-goal',
      continuationLimits: { automaticTurns: 10, minIntervalMs: 60_000 },
    });
    assert.equal(existsSync(conflictingPath), false);
  });

  it('REQ-AGENT-129 AC2/AC3: adds missing values while preserving explicit and unknown preferences', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'pi-goal-settings-merge-'));
    const configPath = join(fixture, '.pi/agent/pi-goal.json');
    const env = { USER_HOME: fixture };
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      toolVisibility: 'always',
      continuationLimits: {
        automaticTurns: null,
        noProgressTurns: 8,
        customLimit: 'keep',
      },
      rpc: { enabled: true, customTransport: 'keep' },
      unknownRoot: { enabled: null },
    }));

    const explicit = runStartupInvocation('configure_pi_goal_defaults', env);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      toolVisibility: 'always',
      continuationLimits: {
        automaticTurns: null,
        noProgressTurns: 8,
        customLimit: 'keep',
        minIntervalMs: 60_000,
      },
      rpc: { enabled: true, customTransport: 'keep' },
      unknownRoot: { enabled: null },
    });

    writeFileSync(configPath, JSON.stringify({
      continuationLimits: { minIntervalMs: 1_250 },
      rpc: { enabled: false },
      unknownRoot: 'keep',
    }));
    const missing = runStartupInvocation('configure_pi_goal_defaults', env);
    assert.equal(missing.status, 0, missing.stderr);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      toolVisibility: 'after-first-goal',
      continuationLimits: { minIntervalMs: 1_250, automaticTurns: 10 },
      rpc: { enabled: false },
      unknownRoot: 'keep',
    });
  });

  it('REQ-AGENT-129 AC4: preserves malformed Goal config byte-for-byte', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'pi-goal-settings-malformed-'));
    const configPath = join(fixture, '.pi/agent/pi-goal.json');
    const env = { USER_HOME: fixture };
    mkdirSync(dirname(configPath), { recursive: true });

    for (const malformed of [
      '{"toolVisibility":"always",\n',
      '{"toolVisibility":"always","continuationLimits":null}\n',
    ]) {
      writeFileSync(configPath, malformed);
      const result = runStartupInvocation('configure_pi_goal_defaults', env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(configPath, 'utf8'), malformed);
    }
  });

  it('REQ-AGENT-152 AC5/AC6: overwrites Plan Mode settings with the Codeflare policy on every start', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'pi-plan-mode-settings-'));
    const configPath = join(fixture, '.pi/agent/pi-plan-mode.json');
    const conflictingPath = join(fixture, 'legacy/pi-plan-mode.json');
    const env = { USER_HOME: fixture, PI_PLAN_MODE_CONFIG_FILE: conflictingPath };

    const first = runStartupInvocation('configure_pi_plan_mode', env);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), EXPECTED_PLAN_MODE_SETTINGS);
    assert.equal(existsSync(conflictingPath), false);

    writeFileSync(configPath, '{"thinkingLevel":"max","toggleShortcut":"ctrl+alt+p","unknown":"drop"}\n');
    const second = runStartupInvocation('configure_pi_plan_mode', env);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), EXPECTED_PLAN_MODE_SETTINGS);
  });

  it('REQ-AGENT-155 AC2: overwrites Caveman with full mode and no footer on every start', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'pi-caveman-settings-'));
    const configPath = join(fixture, '.pi/agent/caveman.json');
    const conflictingPath = join(fixture, 'legacy/caveman.json');
    const env = { USER_HOME: fixture, PI_CAVEMAN_CONFIG_FILE: conflictingPath };

    const first = runStartupInvocation('configure_pi_caveman', env);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      defaultLevel: 'full',
      showStatus: false,
    });
    assert.equal(existsSync(conflictingPath), false);

    writeFileSync(configPath, '{"defaultLevel":"off","showStatus":true,"unknown":"drop"}\n');
    const fakeBin = join(fixture, 'bin');
    const nodeWrapper = join(fakeBin, 'node');
    mkdirSync(fakeBin);
    writeFileSync(nodeWrapper, `#!/bin/sh
printf 'incomplete\\n' > "\${PI_CAVEMAN_STARTUP_CONFIG}.$$.tmp"
exec "$REAL_NODE" "$@"
`);
    chmodSync(nodeWrapper, 0o755);
    const second = runStartupInvocation('configure_pi_caveman', {
      ...env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      REAL_NODE: process.execPath,
    });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      defaultLevel: 'full',
      showStatus: false,
    });
  });

  it('REQ-AGENT-155 AC3: fails startup when the authoritative Caveman policy cannot be written', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'pi-caveman-settings-failure-'));
    mkdirSync(join(fixture, '.pi'), { recursive: true });
    writeFileSync(join(fixture, '.pi/agent'), 'not a directory\n');

    const result = runStartupInvocation('configure_pi_caveman', { USER_HOME: fixture });

    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(fixture, '.pi/agent/caveman.json')), false);
  });

  it('REQ-AGENT-023: restores a missing Graphify CLI path without replacing an existing destination', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'graphify-path-'));
    const source = join(fixture, 'tools/graphify');
    const destination = join(fixture, 'bin/graphify');
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(source, '#!/bin/sh\n', { mode: 0o755 });

    const first = runFunction(
      'ensure_graphify_cli_path',
      '',
      'ensure_graphify_cli_path',
      { GRAPHIFY_BIN_SRC: source, GRAPHIFY_BIN_DST: destination },
    );
    assert.equal(first.status, 0, first.stderr);
    assert.equal(lstatSync(destination).isSymbolicLink(), true);
    assert.equal(resolve(dirname(destination), readlinkSync(destination)), source);

    rmSync(destination);
    writeFileSync(destination, 'operator-owned\n');
    const second = runFunction(
      'ensure_graphify_cli_path',
      '',
      'ensure_graphify_cli_path',
      { GRAPHIFY_BIN_SRC: source, GRAPHIFY_BIN_DST: destination },
    );
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(destination, 'utf8'), 'operator-owned\n');
  });

  it('REQ-AGENT-012: Fast Start controls Pi update suppression and the disabled update path', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'pi-fast-start-'));
    const calls = join(fixture, 'calls.log');
    const script = `${extractFunction('configure_fast_start_environment')}\n${extractFunction('update_pi_when_fast_start_disabled')}\n` +
      `CALLS=${JSON.stringify(calls)}\n` +
      `pi() { printf 'pi:%s offline=%s skip=%s\\n' "$*" "\${PI_OFFLINE:-}" "\${PI_SKIP_VERSION_CHECK:-}" >> "$CALLS"; }\n` +
      'FAST_CLI_START=true\nconfigure_fast_start_environment\nupdate_pi_when_fast_start_disabled\n' +
      'printf "on:%s:%s:%s:%s:%s\\n" "$DISABLE_AUTOUPDATER" "$OPENCODE_DISABLE_AUTOUPDATE" "$COPILOT_AUTO_UPDATE" "$PI_OFFLINE" "$PI_SKIP_VERSION_CHECK"\n' +
      'FAST_CLI_START=false PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 DISABLE_AUTOUPDATER=1 OPENCODE_DISABLE_AUTOUPDATE=1 DISABLE_INSTALLATION_CHECKS=1 COPILOT_AUTO_UPDATE=false\n' +
      'configure_fast_start_environment\nupdate_pi_when_fast_start_disabled\n' +
      'printf "off:%s:%s:%s:%s:%s:%s\\n" "${PI_OFFLINE-unset}" "${PI_SKIP_VERSION_CHECK-unset}" "${DISABLE_AUTOUPDATER-unset}" "${OPENCODE_DISABLE_AUTOUPDATE-unset}" "${DISABLE_INSTALLATION_CHECKS-unset}" "${COPILOT_AUTO_UPDATE-unset}"\n' +
      'cat "$CALLS"\n';
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      'on:1:1:false:1:1',
      '[entrypoint] Fast Start disabled; updating Pi and Pi packages',
      'off:unset:unset:unset:unset:unset:unset',
      'pi:update offline= skip=',
    ]);
  });

  it('REQ-AGENT-012: disabled Fast Start removes only Codeflare-managed settings suppressors', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'fast-start-settings-'));
    const managed = join(fixture, '.codex/version.json');
    mkdirSync(dirname(managed), { recursive: true });
    writeFileSync(managed, '{"dismissed_version":"999.0.0"}\n');

    const result = runFunction(
      'configure_fast_start_tool_settings',
      '',
      'configure_fast_start_tool_settings',
      { FAST_CLI_START: 'false', USER_HOME: fixture },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(managed), false);

    writeFileSync(managed, '{"dismissed_version":"operator-owned"}\n');
    const custom = runFunction(
      'configure_fast_start_tool_settings',
      '',
      'configure_fast_start_tool_settings',
      { FAST_CLI_START: 'false', USER_HOME: fixture },
    );
    assert.equal(custom.status, 0, custom.stderr);
    assert.equal(readFileSync(managed, 'utf8'), '{"dismissed_version":"operator-owned"}\n');
  });

  it('REQ-AGENT-001: Pi npm warm cache seeds dependencies without overwriting user package metadata', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'pi-npm-warm-'));
    const preseed = join(fixture, 'preseed');
    const target = join(fixture, 'home/.pi/agent/npm');
    mkdirSync(join(preseed, 'node_modules/example-package'), { recursive: true });
    writeFileSync(join(preseed, 'package.json'), '{"name":"image-seed"}\n');
    writeFileSync(join(preseed, 'node_modules/example-package/package.json'), '{"name":"example-package"}\n');
    const env = { USER_HOME: join(fixture, 'home'), PI_NPM_PRESEED: preseed, PI_NPM_DIR: target };

    const first = runFunction('warm_pi_npm_dependencies', '', 'warm_pi_npm_dependencies', env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(readFileSync(join(target, 'package.json'), 'utf8'), '{"name":"image-seed"}\n');
    assert.equal(existsSync(join(target, 'node_modules/example-package/package.json')), true);

    writeFileSync(join(target, 'package.json'), '{"name":"user-owned"}\n');
    writeFileSync(join(preseed, 'package.json'), '{"name":"new-image-seed"}\n');
    const second = runFunction('warm_pi_npm_dependencies', '', 'warm_pi_npm_dependencies', env);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(join(target, 'package.json'), 'utf8'), '{"name":"user-owned"}\n');
  });
});
