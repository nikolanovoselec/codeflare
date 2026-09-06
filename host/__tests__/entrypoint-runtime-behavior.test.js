import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(__dirname, '../../entrypoint.sh');

function runtimeEnv(env = {}) {
  const runtimeRoot = env.CODEFLARE_RUNTIME_ROOT ?? mkdtempSync(join(tmpdir(), 'entrypoint-runtime-'));
  mkdirSync(join(runtimeRoot, 'sync'), { recursive: true });
  return { ...process.env, CODEFLARE_RUNTIME_ROOT: runtimeRoot, ...env };
}

function extractFunction(name) {
  const lines = readFileSync(ENTRYPOINT, 'utf8').split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${name}\\(\\) \\{`).test(line));
  if (start === -1) throw new Error(`Could not locate ${name}() in entrypoint.sh`);
  const end = lines.findIndex((line, index) => {
    if (index <= start || line !== '}') return false;
    if (name !== 'warm_pi_npm_dependencies') return true;
    return lines[index + 2] === 'update_pi_and_codex_when_fast_start_disabled() {';
  });
  if (end === -1) throw new Error(`Could not locate the end of ${name}()`);
  return lines.slice(start, end + 1).join('\n');
}

function runFunction(name, setup, invocation, env = {}) {
  return spawnSync('bash', ['-c', `${extractFunction(name)}\n${setup}\n${invocation}`], {
    encoding: 'utf8',
    env: runtimeEnv(env),
  });
}

function runStartupInvocation(name, env = {}) {
  const lines = readFileSync(ENTRYPOINT, 'utf8').split('\n');
  const invocation = lines.find((line) => line === name || line.startsWith(`${name} || `));
  if (!invocation) throw new Error(`Could not locate production startup invocation for ${name}()`);
  return spawnSync('bash', ['-c', `${extractFunction(name)}\n${invocation}`], {
    encoding: 'utf8',
    env: runtimeEnv(env),
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
      continuationLimits: { automaticTurns: 10, minIntervalMs: 180_000 },
    });
    assert.equal(existsSync(conflictingPath), false);
  });

  it('REQ-AGENT-129 AC2/AC3: enforces three-minute pacing while preserving unrelated preferences', () => {
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
        minIntervalMs: 180_000,
      },
      rpc: { enabled: true, customTransport: 'keep' },
      unknownRoot: { enabled: null },
    });

    writeFileSync(configPath, JSON.stringify({
      continuationLimits: { minIntervalMs: 0 },
      rpc: { enabled: false },
      unknownRoot: 'keep',
    }));
    const missing = runStartupInvocation('configure_pi_goal_defaults', env);
    assert.equal(missing.status, 0, missing.stderr);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
      toolVisibility: 'after-first-goal',
      continuationLimits: { minIntervalMs: 180_000, automaticTurns: 10 },
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

  it('REQ-AGENT-012/REQ-AGENT-206: Fast Start controls suppression and updates Pi and Codex', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'agent-fast-start-'));
    const calls = join(fixture, 'calls.log');
    const script = `${extractFunction('configure_fast_start_environment')}\n${extractFunction('update_pi_and_codex_when_fast_start_disabled')}\n` +
      `CALLS=${JSON.stringify(calls)}\n` +
      `pi() { if [ "$1" = "--version" ]; then echo 'pi 0.84.4'; else printf 'pi:%s offline=%s skip=%s\\n' "$*" "\${PI_OFFLINE:-}" "\${PI_SKIP_VERSION_CHECK:-}" >> "$CALLS"; fi; }\n` +
      `codex() { echo 'codex-cli 0.151.0'; }\n` +
      `npm() { printf 'npm:%s\\n' "$*" >> "$CALLS"; }\n` +
      'node() { return 0; }\n' +
      'FAST_CLI_START=true\nconfigure_fast_start_environment\nupdate_pi_and_codex_when_fast_start_disabled\n' +
      'printf "on:%s:%s:%s:%s:%s\\n" "$DISABLE_AUTOUPDATER" "$OPENCODE_DISABLE_AUTOUPDATE" "$COPILOT_AUTO_UPDATE" "$PI_OFFLINE" "$PI_SKIP_VERSION_CHECK"\n' +
      'FAST_CLI_START=false PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 DISABLE_AUTOUPDATER=1 OPENCODE_DISABLE_AUTOUPDATE=1 DISABLE_INSTALLATION_CHECKS=1 COPILOT_AUTO_UPDATE=false\n' +
      'configure_fast_start_environment\nupdate_pi_and_codex_when_fast_start_disabled\n' +
      'printf "off:%s:%s:%s:%s:%s:%s\\n" "${PI_OFFLINE-unset}" "${PI_SKIP_VERSION_CHECK-unset}" "${DISABLE_AUTOUPDATER-unset}" "${OPENCODE_DISABLE_AUTOUPDATE-unset}" "${DISABLE_INSTALLATION_CHECKS-unset}" "${COPILOT_AUTO_UPDATE-unset}"\n' +
      'cat "$CALLS"\n';
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      'on:1:1:false:1:1',
      '[entrypoint] Fast Start disabled; Pi version before update: pi 0.84.4',
      '[entrypoint] Fast Start disabled; Codex version before update: codex-cli 0.151.0',
      '[entrypoint] Fast Start disabled; Pi version after update: pi 0.84.4',
      '[entrypoint] Fast Start disabled; Codex version after update: codex-cli 0.151.0',
      'off:unset:unset:unset:unset:unset:unset',
      'pi:update --extensions offline= skip=',
      'npm:install --prefix /opt/codeflare/npm-tools --omit=dev --save-exact --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@latest @openai/codex@latest',
    ]);
  });

  it('REQ-AGENT-206: repairs incomplete dependencies from the lock and isolates the updated cache', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'pi-update-repair-'));
    const calls = join(fixture, 'calls');
    const healthy = join(fixture, 'healthy');
    const script = `${extractFunction('update_pi_and_codex_when_fast_start_disabled')}\n` +
      `pi() { [ "$1" != "--version" ] || echo 'pi 0.85.1'; }\n` +
      'codex() { echo codex; }\n' +
      `npm() { echo "$1" >> '${calls}'; [ "$1" != ci ] || touch '${healthy}'; }\n` +
      `node() { if [ "$2" = --verify-runtime ]; then [ -f '${healthy}' ]; elif [ "$2" = --reset-runtime-jiti ]; then echo cache-reset >> '${calls}'; fi; }\n` +
      'FAST_CLI_START=false\nupdate_pi_and_codex_when_fast_start_disabled\n';
    try {
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: runtimeEnv() });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), ['install', 'install', 'ci', 'cache-reset']);
      assert.equal(existsSync(healthy), true);
      assert.match(result.stdout, /repairing Pi dependencies from the lockfile/);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it('starts a reachable recovery daemon when baseline fails for disk space', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bisync-startup-disk-'));
    try {
      const source = readFileSync(ENTRYPOINT, 'utf8');
      const start = source.indexOf('            if establish_bisync_baseline; then');
      const end = source.indexOf('            start_sync_daemon', start);
      assert.ok(start >= 0 && end > start);
      const startup = source.slice(start, end) + 'start_sync_daemon';
      const code = `${extractFunction('update_sync_status')}\n${extractFunction('record_sync_disk_failure')}\n${extractFunction('establish_bisync_baseline')}\n` +
        'timeout() { shift; "$@"; }\nrclone() { echo "preallocate: file too big for remaining disk space"; return 7; }\n' +
        'init_user_vault() { :; }\nstart_sync_daemon() { echo recovery-daemon-reachable; }\n' + startup;
      const result = spawnSync('bash', ['-c', code], { encoding: 'utf8', env: runtimeEnv({ CODEFLARE_RUNTIME_ROOT: directory }) });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /recovery-daemon-reachable/);
      const status = JSON.parse(readFileSync(join(directory, 'sync/sync-status.json'), 'utf8'));
      assert.equal(status.status, 'failed');
      assert.match(status.error, /Local disk full.*cloud Sync now/);
      assert.equal(existsSync(join(directory, 'sync/disk-space-blocked')), true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps disk-full sync blocked when subsequent errors report missing listings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bisync-disk-block-'));
    try {
      mkdirSync(join(directory, 'sync'));
      const log = join(directory, 'failure.log');
      writeFileSync(log, 'preallocate: file too big for remaining disk space');
      const code = `${extractFunction('update_sync_status')}\n${extractFunction('record_sync_disk_failure')}\n${extractFunction('establish_bisync_baseline')}\n` +
        `record_sync_disk_failure '${log}'\nprintf 'cannot find prior Path1 or Path2 listings' > '${log}'\nrecord_sync_disk_failure '${log}'\n` +
        'rclone() { echo unexpected-transfer; return 0; }\nestablish_bisync_baseline\n';
      const result = spawnSync('bash', ['-c', code], { encoding: 'utf8', env: runtimeEnv({ CODEFLARE_RUNTIME_ROOT: directory }) });
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(join(directory, 'sync/disk-space-blocked')), true);
      assert.doesNotMatch(result.stdout, /unexpected-transfer/);
      assert.match(result.stdout, /disk space/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('REQ-AGENT-206: restores a real locked installation and reports unrecoverable repair', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'pi-locked-repair-'));
    const tools = join(fixture, 'tools');
    const source = join(fixture, 'package');
    const scripts = resolve(__dirname, '../../scripts');
    const env = runtimeEnv({ CODEFLARE_RUNTIME_ROOT: fixture, CODEFLARE_NPM_TOOLS_DIR: tools, CODEFLARE_CODING_AGENTS: 'pi', npm_config_cache: join(fixture, 'cache') });
    const npm = (args, cwd) => {
      const result = spawnSync('npm', args, { cwd, env, encoding: 'utf8', timeout: 60_000 });
      assert.equal(result.status, 0, result.stderr);
      return result;
    };
    try {
      mkdirSync(join(source, 'dist/utils'), { recursive: true }); mkdirSync(tools);
      writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0', type: 'module' }));
      writeFileSync(join(source, 'dist/utils/photon.js'), 'export async function loadPhoton() { return { PhotonImage: class { get_bytes() { return new Uint8Array([1]); } free() {} } }; }');
      writeFileSync(join(source, 'dist/utils/image-process.js'), 'export async function processImage() { return { ok: true }; }');
      const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--offline'], source).stdout)[0].filename;
      const tarball = join(source, packed);
      writeFileSync(join(tools, 'package.json'), JSON.stringify({ private: true, dependencies: { '@earendil-works/pi-coding-agent': `file:${tarball}` } }));
      npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--offline'], tools);
      const installed = join(tools, 'node_modules/@earendil-works/pi-coding-agent');
      const processor = join(installed, 'dist/utils/image-process.js');
      const verify = () => spawnSync(process.execPath, [join(scripts, 'verify-pi-lockstep.mjs'), '--verify-runtime', join(installed, 'package.json')], { encoding: 'utf8' });
      const body = extractFunction('update_pi_and_codex_when_fast_start_disabled')
        .replaceAll('/opt/codeflare/scripts/coding-agent-selection.mjs', join(scripts, 'ci/coding-agent-selection.mjs'))
        .replaceAll('/opt/codeflare/scripts', scripts);
      // Suppress latest-version network updates; execute the production repair commands with real npm.
      const run = () => spawnSync('bash', ['-c', `${body}\npi() { echo fixture-pi; }\ncodex() { echo fixture-codex; }\nnpm() { if [[ " $* " == *" --save-exact "* ]]; then return 0; fi; command npm "$@" --offline; }\nFAST_CLI_START=false\nupdate_pi_and_codex_when_fast_start_disabled`], { env, encoding: 'utf8', timeout: 120_000 });
      rmSync(processor);
      assert.notEqual(verify().status, 0);
      const repaired = run(); assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
      assert.equal(readFileSync(processor, 'utf8'), readFileSync(join(source, 'dist/utils/image-process.js'), 'utf8'));
      const healthy = verify(); assert.equal(healthy.status, 0, healthy.stderr);
      assert.match(repaired.stdout, /repairing Pi dependencies from the lockfile/);
      rmSync(processor); rmSync(tarball);
      const failed = run(); assert.notEqual(failed.status, 0);
      assert.match(failed.stdout, /Pi dependency repair failed; the runtime is incomplete/);
      assert.doesNotMatch(failed.stdout, /Pi version after update/);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it('REQ-AGENT-206: Fast Start OFF surfaces Pi package and agent runtime update failures', () => {
    const script = `${extractFunction('update_pi_and_codex_when_fast_start_disabled')}\n` +
      `pi() { [ "$1" = "--version" ] && { echo 'pi 0.84.4'; return 0; }; return 7; }\n` +
      `codex() { echo 'codex-cli 0.150.1'; }\n` +
      `npm() { return 9; }\n` +
      'node() { return 0; }\n' +
      'FAST_CLI_START=false\n' +
      'update_pi_and_codex_when_fast_start_disabled || echo update-failed\n';
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ERROR: Pi package update failed/);
    assert.match(result.stdout, /ERROR: Pi runtime update failed/);
    assert.match(result.stdout, /ERROR: Codex runtime update failed/);
    assert.match(result.stdout, /update-failed/);
  });

  it('REQ-AGENT-206: version-read failures do not suppress either runtime update', () => {
    const script = `${extractFunction('update_pi_and_codex_when_fast_start_disabled')}\n` +
      `pi() { [ "$1" = "update" ] && return 0; return 7; }\n` +
      `codex() { return 8; }\n` +
      `npm() { printf 'runtime-update %s\\n' "$*"; }\n` +
      'node() { return 0; }\n' +
      'FAST_CLI_START=false\n' +
      'update_pi_and_codex_when_fast_start_disabled || echo update-failed\n';
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Could not read Pi version before update/);
    assert.match(result.stdout, /Could not read Codex version before update/);
    assert.match(result.stdout, /runtime-update .*@earendil-works\/pi-coding-agent@latest/);
    assert.match(result.stdout, /runtime-update .*@openai\/codex@latest/);
    assert.match(result.stdout, /Could not read Pi version after update/);
    assert.match(result.stdout, /Could not read Codex version after update/);
    assert.match(result.stdout, /update-failed/);
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

  it('REQ-AGENT-160 AC1: keeps late Pi extension output writable outside disposable /tmp', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'pi-jiti-runtime-'));
    const runtimeTmp = join(fixture, 'run/codeflare/pi-tmp');
    const imageCache = join(fixture, 'opt/codeflare/jiti-cache');
    const disposableTmp = join(fixture, 'tmp');
    mkdirSync(imageCache, { recursive: true });
    mkdirSync(join(disposableTmp, 'jiti'), { recursive: true });

    const result = runFunction(
      'configure_pi_jiti_runtime_cache',
      '',
      'configure_pi_jiti_runtime_cache "$TEST_ISOLATION_ROOT"; rm -rf "$TEST_ISOLATION_ROOT/tmp"; printf compiled > "$TMPDIR/jiti/chunks-interactive-ui.test.mjs"; printf "%s" "$TMPDIR"',
      { CODEFLARE_RUNTIME_ROOT: join(fixture, 'run/codeflare'), TEST_ISOLATION_ROOT: fixture },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.endsWith(runtimeTmp), true);
    assert.equal(existsSync(disposableTmp), false);
    assert.equal(readlinkSync(join(runtimeTmp, 'jiti')), imageCache);
    assert.equal(readFileSync(join(imageCache, 'chunks-interactive-ui.test.mjs'), 'utf8'), 'compiled');
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
