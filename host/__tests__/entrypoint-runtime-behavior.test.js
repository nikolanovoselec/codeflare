import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
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

describe('entrypoint production helpers', () => {
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
