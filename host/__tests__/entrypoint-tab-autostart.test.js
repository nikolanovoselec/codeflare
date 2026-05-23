// Real behavioral tests for REQ-AGENT-003 (Agent CLI Auto-Started in Tab 1).
//
// Strategy mirrors entrypoint-bisync-behavior.test.js and
// entrypoint-sse-c-config.test.js: extract the configure_tab_autostart
// function body from entrypoint.sh at test time, run it in a bash subshell
// with a temp USER_HOME, and read back the generated .bashrc to assert on
// real file contents — not source-text matching.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(__dirname, '../../entrypoint.sh');

function extractConfigureBody() {
  const src = readFileSync(ENTRYPOINT, 'utf8');
  const lines = src.split('\n');
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && /^configure_tab_autostart\(\) \{/.test(lines[i])) {
      start = i;
    } else if (start !== -1 && /^\}$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start === -1 || end === -1) {
    throw new Error('Could not locate configure_tab_autostart() in entrypoint.sh');
  }
  return lines.slice(start, end + 1).join('\n');
}

function runHarness({ tabConfig, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tab-autostart-harness-'));
  const body = extractConfigureBody();
  const envLines = [
    `export USER_HOME='${dir}'`,
    ...Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`),
  ];
  if (tabConfig !== undefined) {
    envLines.push(`export TAB_CONFIG=${JSON.stringify(tabConfig)}`);
  }
  const script = [
    '#!/usr/bin/env bash',
    'set -e',
    ...envLines,
    body,
    'configure_tab_autostart',
  ].join('\n');
  const scriptPath = join(dir, 'harness.sh');
  writeFileSync(scriptPath, script, { mode: 0o755 });
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 10_000 });
  return {
    dir,
    result,
    bashrc: existsSync(join(dir, '.bashrc')) ? readFileSync(join(dir, '.bashrc'), 'utf8') : '',
  };
}

describe('entrypoint.sh configure_tab_autostart / REQ-AGENT-003 (Agent CLI auto-started in tab 1)', () => {
  // REQ-AGENT-003 AC1: tab 1 launch command written into .bashrc.
  // REQ-AGENT-003 AC2: claude is launched with --dangerously-skip-permissions
  // (IS_SANDBOX=1 in Dockerfile lets root use this flag; we don't run claude
  // here, we just verify the launch line is generated).
  // REQ-AGENT-003 AC4: PATH is hardened so PTY sessions find global CLIs.
  it('AC1+AC2+AC4: default layout writes the claude --dangerously-skip-permissions launch line + hardened PATH into .bashrc', () => {
    const { result, bashrc } = runHarness();
    assert.equal(result.status, 0, `configure_tab_autostart exited non-zero: ${result.stderr}`);
    assert.match(bashrc, /^# terminal-autostart$/m, 'autostart marker must be present');
    assert.match(bashrc, /claude --dangerously-skip-permissions/,
      'tab 1 must launch claude with --dangerously-skip-permissions (AC1+AC2)');
    assert.match(bashrc, /export PATH="\/usr\/local\/bin:\/usr\/bin:\/bin:\$PATH"/,
      'PATH must be set so PTY sessions find global CLIs (AC4)');
  });

  // REQ-AGENT-003 AC3: MANUAL_TAB=1 short-circuits autostart for user-created tabs.
  it('AC3: generated .bashrc guards autostart with the MANUAL_TAB skip branch', () => {
    const { bashrc } = runHarness();
    assert.match(bashrc, /MANUAL_TAB/,
      'autostart block must check MANUAL_TAB so user-created tabs skip the case block');
  });

  it('AC1 dynamic: TAB_CONFIG with id=1 command=lazygit emits the lazygit launch for tab 1 (overrides the default claude)', () => {
    const tabConfig = JSON.stringify([
      { id: '1', command: 'lazygit', label: 'Git' },
      { id: '2', command: '', label: 'bash' },
    ]);
    const { result, bashrc } = runHarness({ tabConfig });
    assert.equal(result.status, 0, `configure_tab_autostart exited non-zero: ${result.stderr}`);
    assert.match(bashrc, /lazygit/, 'dynamic layout must emit the configured tab-1 command');
    // Marker still present so re-runs short-circuit
    assert.match(bashrc, /^# terminal-autostart$/m);
  });

  it('AC1 dynamic: TAB_CONFIG entries with non-1-6 ids are rejected by the validator (injection guard)', () => {
    // The validator regex is [1-6] — id '7' must be skipped, not emitted.
    const tabConfig = JSON.stringify([
      { id: '1', command: 'claude', label: 'claude' },
      { id: '7; rm -rf /', command: 'malicious', label: 'attack' },
    ]);
    const { bashrc } = runHarness({ tabConfig });
    assert.doesNotMatch(bashrc, /malicious/,
      'invalid tab id must NOT make it into the generated .bashrc case block');
    assert.doesNotMatch(bashrc, /rm -rf/);
  });

  it('idempotent: a second invocation does NOT re-append the marker block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tab-autostart-idempotent-'));
    const body = extractConfigureBody();
    const script = [
      '#!/usr/bin/env bash',
      'set -e',
      `export USER_HOME='${dir}'`,
      body,
      'configure_tab_autostart',
      'configure_tab_autostart',
    ].join('\n');
    const scriptPath = join(dir, 'harness.sh');
    writeFileSync(scriptPath, script, { mode: 0o755 });
    const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0);
    const bashrc = readFileSync(join(dir, '.bashrc'), 'utf8');
    // Marker should appear exactly once.
    const markerCount = (bashrc.match(/^# terminal-autostart$/gm) ?? []).length;
    assert.equal(markerCount, 1, 'autostart marker must appear exactly once after two invocations');
  });
});
