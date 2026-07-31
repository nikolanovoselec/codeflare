// Real behavioral tests for the Browser IDE supervisor in entrypoint.sh
// (REQ-IDE-001, REQ-IDE-002, REQ-IDE-003, REQ-IDE-005, REQ-IDE-008).
//
// Per tdd-discipline / engineering-constitution mandate 2 we do NOT match
// source text: we EXTRACT the real shell functions, RUN them with a stubbed
// code-server binary + temp flag/trigger files, and assert on observable
// side effects (exit codes, captured launch args, whether/how many times the
// stub was invoked, whether a pidfile-tracked process is killed). Mirrors the
// extract-and-run harness in entrypoint-vault-boot.test.js.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(__dirname, '../../entrypoint.sh');

// Extract a top-level `name() {` body (header to the matching column-0 `}`).
function extractFn(name) {
  const lines = readFileSync(ENTRYPOINT, 'utf8').split('\n');
  let start = -1;
  const header = new RegExp(`^${name}\\(\\) \\{`);
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && header.test(lines[i])) start = i;
    else if (start !== -1 && /^\}$/.test(lines[i])) return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`Could not locate ${name}() in entrypoint.sh`);
}

function extractOptionalFn(name) {
  try {
    return extractFn(name);
  } catch {
    return '';
  }
}

// Extract the production cleanup helpers shared by shutdown and each launch
// generation. Tests execute these functions rather than matching shell source.
function extractKillHelpers() {
  return [
    'walk_kill',
    '_process_start_time',
    '_process_generation',
    '_process_group',
    '_openvscode_generation_members',
    '_wait_then_kill_pid',
    '_wait_then_kill_generation',
    'kill_pidfile_subtree',
  ].map(extractFn).join('\n');
}

function mkTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Write an executable stub that records each invocation's args, then exits.
function writeStub(dir, argsFile) {
  const stub = join(dir, 'code-server');
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${argsFile}"\nprintf -- '---\\n' >> "${argsFile}"\nexit 0\n`);
  chmodSync(stub, 0o755);
  return stub;
}

function writeSelectionStub(dir, argsFile) {
  const stub = join(dir, 'code-server');
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf 'agent=%s\\n' "\${CODEFLARE_SIDEBAR_AGENT-<unset>}" > "${argsFile}"\nprintf '%s\\n' "$@" >> "${argsFile}"\nexit 0\n`);
  chmodSync(stub, 0o755);
  return stub;
}

function runBash(script, env = {}) {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function openvscodeLaunchScript({ stubAgentPreparation = true, stubUiState = true } = {}) {
  const production = [
    extractOptionalFn('_openvscode_agent_kind'),
    extractOptionalFn('_openvscode_extensions_dir'),
    extractOptionalFn('_openvscode_prepare_agent'),
    extractOptionalFn('_openvscode_restore_ui_state'),
    extractFn('_openvscode_launch_once'),
  ].filter(Boolean).join('\n');
  return [
    production,
    stubAgentPreparation ? '_openvscode_prepare_agent() { :; }' : '',
    stubUiState ? '_openvscode_restore_ui_state() { :; }' : '',
  ].filter(Boolean).join('\n');
}

function openvscodeSupervisorScript() {
  // export -f so a setsid/timeout child receives the same production helpers as
  // start_openvscode_supervisor's fresh non-interactive shell.
  return [
    extractKillHelpers(),
    extractFn('_openvscode_should_launch'),
    openvscodeLaunchScript(),
    extractOptionalFn('_openvscode_capture_ui_state'),
    '_openvscode_capture_ui_state() { :; }',
    extractFn('_openvscode_supervise_loop'),
    'export -f walk_kill _process_start_time _process_generation _process_group _openvscode_generation_members _wait_then_kill_pid _wait_then_kill_generation kill_pidfile_subtree',
    'export -f _openvscode_should_launch _openvscode_agent_kind _openvscode_extensions_dir _openvscode_prepare_agent _openvscode_restore_ui_state _openvscode_capture_ui_state _openvscode_launch_once _openvscode_supervise_loop',
  ].join('\n');
}

function acceleratedSupervisorScript() {
  return `${openvscodeSupervisorScript()}
sleep() { command sleep "\${OPENVSCODE_TEST_SLEEP:-0.05}"; }
export -f sleep`;
}

function writeExecutable(dir, name, body) {
  const executable = join(dir, name);
  writeFileSync(executable, body);
  chmodSync(executable, 0o755);
  return executable;
}

function writeTermIgnoringChild(dir) {
  return writeExecutable(dir, 'managed-child', `#!/usr/bin/env bash
trap 'printf "TERM\\n" >> "$TERM_LOG"' TERM
while true; do sleep 1; done
`);
}

function writeSignalRecordingChild(dir) {
  return writeExecutable(dir, 'signal-recording-child', `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
process.on('SIGTERM', () => appendFileSync(process.env.SIGNAL_LOG, "TERM\\n"));
writeFileSync(process.env.ACTUAL_PID_FILE, String(process.pid) + "\\n");
setInterval(() => {}, 1_000);
`);
}

describe('_openvscode_should_launch / REQ-IDE-003 AC1 (lazy-start gate)', () => {
  let dir, flag, trigger;
  beforeEach(() => {
    dir = mkTmp('ovsc-gate-');
    flag = join(dir, 'init-complete');
    trigger = join(dir, 'requested');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fn = () => extractFn('_openvscode_should_launch');

  function gate(env) {
    const r = runBash(`${fn()}\n_openvscode_should_launch; echo "RC=$?"`, env);
    return r.stdout.trim();
  }

  it('does NOT launch when the trigger file is absent (even with a session id + init flag)', () => {
    writeFileSync(flag, '');
    assert.equal(gate({ SESSION_ID: 'abcd1234', CODEFLARE_INIT_FLAG_FILE: flag, OPENVSCODE_REQUEST_TRIGGER: trigger }), 'RC=1');
  });

  it('does NOT launch when init is incomplete (no init flag)', () => {
    writeFileSync(trigger, '');
    assert.equal(gate({ SESSION_ID: 'abcd1234', CODEFLARE_INIT_FLAG_FILE: flag, OPENVSCODE_REQUEST_TRIGGER: trigger }), 'RC=1');
  });

  it('does NOT launch when there is no session id (fail-safe against a base-path mismatch)', () => {
    writeFileSync(flag, '');
    writeFileSync(trigger, '');
    assert.equal(gate({ SESSION_ID: '', CODEFLARE_INIT_FLAG_FILE: flag, OPENVSCODE_REQUEST_TRIGGER: trigger }), 'RC=1');
  });

  it('launches only when session id + init flag + trigger are ALL present', () => {
    writeFileSync(flag, '');
    writeFileSync(trigger, '');
    assert.equal(gate({ SESSION_ID: 'abcd1234', CODEFLARE_INIT_FLAG_FILE: flag, OPENVSCODE_REQUEST_TRIGGER: trigger }), 'RC=0');
  });
});

describe('_openvscode_launch_once / REQ-IDE-001, REQ-IDE-002 (session-isolated code-server launch command)', () => {
  let dir, argsFile, workspace;
  beforeEach(() => {
    dir = mkTmp('ovsc-launch-');
    argsFile = join(dir, 'args.log');
    workspace = join(dir, 'workspace');
    mkdirSync(workspace);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('REQ-IDE-001 + REQ-IDE-002: launches code-server with the exact production flags and ephemeral settings layout', () => {
    const stub = writeStub(dir, argsFile);
    // OPENVSCODE_DATA_DIR is intentionally unset so the retained private
    // namespace's production default is exercised.
    const r = runBash(`${openvscodeLaunchScript()}\n_openvscode_launch_once`, {
      OPENVSCODE_BIN: stub,
      OPENVSCODE_HOST: '0.0.0.0',
      SESSION_ID: 'abcd1234',
      OPENVSCODE_WORKSPACE: workspace,
    });

    assert.equal(r.status, 0);
    assert.deepEqual(readFileSync(argsFile, 'utf8').trim().split('\n'), [
      '--bind-addr',
      '127.0.0.1:13337',
      '--auth',
      'none',
      '--disable-telemetry',
      '--disable-update-check',
      '--disable-proxy',
      '--disable-getting-started-override',
      '--disable-workspace-trust',
      '--user-data-dir',
      '/tmp/openvscode-data/data',
      '--extensions-dir',
      '/opt/codeflare/openvscode/extensions/claude',
      workspace,
      '---',
    ]);
  });

  it('REQ-IDE-002 AC2: separate session launches use independent workspace and editor-state roots', () => {
    const observed = [];
    for (const sessionId of ['session-a', 'session-b']) {
      const sessionDir = join(dir, sessionId);
      const sessionWorkspace = join(sessionDir, 'workspace');
      const sessionData = join(sessionDir, 'editor-data');
      const sessionArgs = join(sessionDir, 'args.log');
      mkdirSync(sessionWorkspace, { recursive: true });
      const stub = writeStub(sessionDir, sessionArgs);

      const r = runBash(`${openvscodeLaunchScript()}\n_openvscode_launch_once`, {
        OPENVSCODE_BIN: stub,
        OPENVSCODE_WORKSPACE: sessionWorkspace,
        OPENVSCODE_DATA_DIR: sessionData,
        SESSION_ID: sessionId,
      });

      assert.equal(r.status, 0);
      observed.push(readFileSync(sessionArgs, 'utf8').trim().split('\n'));
    }

    const userDataRoots = observed.map((args) => args[args.indexOf('--user-data-dir') + 1]);
    assert.deepEqual(userDataRoots, [
      join(dir, 'session-a', 'editor-data', 'data'),
      join(dir, 'session-b', 'editor-data', 'data'),
    ]);
    assert.ok(observed[0].includes(join(dir, 'session-a', 'workspace')));
    assert.ok(observed[1].includes(join(dir, 'session-b', 'workspace')));
  });

  it('REQ-IDE-005 AC1 + REQ-IDE-009: every agent kind prepares IDE settings before code-server launches', () => {
    const cases = [
      { label: 'claude (legacy default)', config: undefined, kind: 'claude' },
      { label: 'pi', config: JSON.stringify([{ id: '1', command: 'pi', label: 'Terminal 1' }]), kind: 'pi' },
      { label: 'none (unsupported)', config: JSON.stringify([{ id: '1', command: 'codex', label: 'Terminal 1' }]), kind: 'none' },
    ];
    for (const { label, config, kind } of cases) {
      const launchArgsFile = join(dir, `args-${kind}.log`);
      const stub = writeStub(dir, launchArgsFile);
      const prepared = join(dir, `prepared-${kind}.log`);
      const dataDir = join(dir, `openvscode-data-${kind}`);
      const script = `${openvscodeLaunchScript({ stubAgentPreparation: false })}
_openvscode_prepare_agent() { printf '%s|%s\n' "$1" "$2" > "$PREPARED_FILE"; }
_openvscode_launch_once`;
      const env = {
        OPENVSCODE_BIN: stub,
        OPENVSCODE_WORKSPACE: workspace,
        OPENVSCODE_DATA_DIR: dataDir,
        PREPARED_FILE: prepared,
        SESSION_ID: 'abcd1234',
      };
      if (config !== undefined) env.TAB_CONFIG = config;

      const r = runBash(script, env);

      assert.equal(r.status, 0, `${label} should launch`);
      // The seed runs for the selected kind (kind|dataDir), proving pi and none
      // are seeded too, not just claude.
      assert.equal(readFileSync(prepared, 'utf8'), `${kind}|${dataDir}\n`, `${label} seeds settings at the Browser IDE data root`);
      const args = readFileSync(launchArgsFile, 'utf8').trim().split('\n');
      const userDataFlag = args.indexOf('--user-data-dir');
      assert.notEqual(userDataFlag, -1, `${label} passes code-server's --user-data-dir`);
      assert.equal(args[userDataFlag + 1], join(dataDir, 'data'), `${label} launches against the settings directory prepared under <root>/data/User`);
    }
  });

  it('REQ-IDE-016 AC2: restores safe UI state before managed settings and code-server launch', () => {
    const stub = writeStub(dir, argsFile);
    const events = join(dir, 'events.log');
    const dataDir = join(dir, 'openvscode-data');
    const script = `${openvscodeLaunchScript({ stubAgentPreparation: false, stubUiState: false })}
_openvscode_restore_ui_state() { printf 'restore:%s\n' "$1" >> "$EVENTS"; }
_openvscode_prepare_agent() { printf 'prepare:%s:%s\n' "$1" "$2" >> "$EVENTS"; }
_openvscode_launch_once`;

    const r = runBash(script, {
      OPENVSCODE_BIN: stub,
      OPENVSCODE_WORKSPACE: workspace,
      OPENVSCODE_DATA_DIR: dataDir,
      EVENTS: events,
      SESSION_ID: 'abcd1234',
    });

    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readFileSync(events, 'utf8').trim().split('\n'), [
      `restore:${dataDir}`,
      `prepare:claude:${dataDir}`,
    ]);
    assert.equal(existsSync(argsFile), true);
  });

  it('REQ-IDE-009: IDE settings preparation failure prevents code-server launch', () => {
    const stub = writeStub(dir, argsFile);
    const script = `${openvscodeLaunchScript({ stubAgentPreparation: false })}
_openvscode_prepare_agent() { return 37; }
_openvscode_launch_once`;

    const r = runBash(script, {
      OPENVSCODE_BIN: stub,
      OPENVSCODE_WORKSPACE: workspace,
      OPENVSCODE_DATA_DIR: join(dir, 'openvscode-data'),
      SESSION_ID: 'abcd1234',
    });

    assert.notEqual(r.status, 0);
    assert.equal(existsSync(argsFile), false);
  });

  it('REQ-IDE-005 AC1+AC2: tab one selects only a fixed IDE agent inventory', () => {
    const cases = [
      { label: 'absent config keeps the legacy Claude default', config: undefined, expected: 'claude' },
      { label: 'exact Pi', config: JSON.stringify([{ id: '1', command: 'pi', label: 'Terminal 1' }]), expected: 'pi' },
      { label: 'exact Claude', config: JSON.stringify([{ id: '1', command: 'claude', label: 'Terminal 1' }]), expected: 'claude' },
      { label: 'exact legacy Claude command', config: JSON.stringify([{ id: '1', command: 'claude --dangerously-skip-permissions', label: 'Terminal 1' }]), expected: 'claude' },
      { label: 'unsupported agent', config: JSON.stringify([{ id: '1', command: 'codex', label: 'Terminal 1' }]), expected: 'none' },
      { label: 'missing tab one', config: JSON.stringify([{ id: '2', command: 'pi', label: 'Terminal 2' }]), expected: 'none' },
      { label: 'duplicate tab one', config: JSON.stringify([{ id: '1', command: 'pi', label: 'One' }, { id: '1', command: 'pi', label: 'Duplicate' }]), expected: 'none' },
      { label: 'ambiguous duplicate commands', config: JSON.stringify([{ id: '1', command: 'pi', label: 'One' }, { id: '1', command: 'claude', label: 'Duplicate' }]), expected: 'none' },
      { label: 'empty configured value is not absent', config: '', expected: 'none' },
      { label: 'malformed JSON', config: '[{"id":', expected: 'none' },
      { label: 'non-array JSON', config: '{"id":"1","command":"pi"}', expected: 'none' },
      { label: 'injected Pi suffix', config: JSON.stringify([{ id: '1', command: 'pi; touch /tmp/sidebar-owned', label: 'Terminal 1' }]), expected: 'none' },
    ];

    const helpers = openvscodeLaunchScript();

    const actual = cases.map(({ label, config }) => {
      const caseDir = mkTmp('ovsc-selection-');
      const caseArgs = join(caseDir, 'args.log');
      const stub = writeSelectionStub(caseDir, caseArgs);
      const configSetup = config === undefined ? 'unset TAB_CONFIG' : ':';
      const env = {
        OPENVSCODE_BIN: stub,
        OPENVSCODE_WORKSPACE: workspace,
        SESSION_ID: 'abcd1234',
        ...(config === undefined ? {} : { TAB_CONFIG: config }),
      };
      const r = runBash(`${helpers}\n${configSetup}\n_openvscode_launch_once`, env);
      assert.equal(r.status, 0, `${label}: launch exits successfully`);
      const lines = readFileSync(caseArgs, 'utf8').split('\n');
      const extensionsFlag = lines.indexOf('--extensions-dir');
      const proposedApiFlag = lines.indexOf('--enable-proposed-api');
      const observed = {
        label,
        agent: lines.find((line) => line.startsWith('agent='))?.slice('agent='.length) ?? null,
        directory: extensionsFlag === -1 ? null : lines[extensionsFlag + 1],
        proposedApi: proposedApiFlag === -1 ? null : lines[proposedApiFlag + 1],
        leakedInput: config === undefined || config === '' ? false : lines.some((line) => line.includes(config)),
      };
      rmSync(caseDir, { recursive: true, force: true });
      return observed;
    });

    assert.deepEqual(actual, cases.map(({ label, expected }) => ({
      label,
      agent: expected,
      directory: `/opt/codeflare/openvscode/extensions/${expected}`,
      proposedApi: expected === 'pi' ? 'codeflare.codeflare-agent-sidebar' : null,
      leakedInput: false,
    })));
  });
});

describe('_openvscode_supervise_loop / REQ-IDE-003 AC1+AC4 (lazy no-launch, restart on exit)', () => {
  let dir, argsFile, flag, trigger;
  beforeEach(() => {
    dir = mkTmp('ovsc-loop-');
    argsFile = join(dir, 'args.log');
    flag = join(dir, 'init-complete');
    trigger = join(dir, 'requested');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('never launches while the trigger is absent (lazy start)', () => {
    const stub = writeStub(dir, argsFile);
    // 3s window; the gate polls every 2s and never passes -> stub untouched.
    runBash(`${openvscodeSupervisorScript()}\ntimeout 3 bash -c '_openvscode_supervise_loop' || true`, {
      OPENVSCODE_BIN: stub, SESSION_ID: 'abcd1234',
      CODEFLARE_INIT_FLAG_FILE: flag, OPENVSCODE_REQUEST_TRIGGER: trigger,
      OPENVSCODE_DATA_DIR: join(tmpdir(), 'ovsc-d'), OPENVSCODE_WORKSPACE: dir,
    });
    assert.equal(existsSync(argsFile), false, 'stub was never invoked');
  });

  it('relaunches the server after it exits (restart loop)', () => {
    const stub = writeStub(dir, argsFile);
    writeFileSync(flag, '');
    writeFileSync(trigger, '');
    // 8s window; the stub exits immediately and the loop restarts after 5s,
    // so we expect launches at ~0s and ~5s -> at least 2 invocations.
    runBash(`${openvscodeSupervisorScript()}\ntimeout 8 bash -c '_openvscode_supervise_loop' || true`, {
      OPENVSCODE_BIN: stub, SESSION_ID: 'abcd1234',
      CODEFLARE_INIT_FLAG_FILE: flag, OPENVSCODE_REQUEST_TRIGGER: trigger,
      OPENVSCODE_DATA_DIR: join(tmpdir(), 'ovsc-d'), OPENVSCODE_WORKSPACE: dir,
    });
    const launches = (readFileSync(argsFile, 'utf8').match(/---/g) || []).length;
    assert.ok(launches >= 2, `expected >=2 relaunches, got ${launches}`);
  });
});

describe('OpenVSCode launch generations / REQ-IDE-008 AC4', () => {
  let dir, flag, trigger;
  beforeEach(() => {
    dir = mkTmp('ovsc-generation-');
    flag = join(dir, 'init-complete');
    trigger = join(dir, 'requested');
    writeFileSync(flag, '');
    writeFileSync(trigger, '');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('REQ-IDE-016 AC1: captures UI state only after the code-server generation exits', () => {
    const events = join(dir, 'state-events.log');
    const stub = writeExecutable(dir, 'openvscode-server', `#!/usr/bin/env bash
printf 'server-start:%s\\n' "$$" >> "$EVENTS"
trap 'printf "server-exit:%s\\n" "$$" >> "$EVENTS"' EXIT
exit 17
`);
    const script = `${openvscodeSupervisorScript()}
_openvscode_capture_ui_state() { printf 'capture:%s\n' "$1" >> "$EVENTS"; }
export -f _openvscode_capture_ui_state
timeout 1 bash -c '_openvscode_supervise_loop' || true`;

    const result = runBash(script, {
      OPENVSCODE_BIN: stub,
      OPENVSCODE_WORKSPACE: dir,
      OPENVSCODE_DATA_DIR: join(dir, 'data'),
      OPENVSCODE_REQUEST_TRIGGER: trigger,
      CODEFLARE_INIT_FLAG_FILE: flag,
      SESSION_ID: 'abcd1234',
      EVENTS: events,
    });

    assert.equal(result.status, 0, result.stderr);
    const firstGeneration = readFileSync(events, 'utf8').trim().split('\n').slice(0, 3).map((line) => line.split(':')[0]);
    assert.deepEqual(firstGeneration, ['server-start', 'server-exit', 'capture']);
  });

  it('REQ-IDE-003 AC4 + REQ-IDE-008 AC4: each restart creates one separately identifiable launch generation', () => {
    const launchesFile = join(dir, 'launches.log');
    const stub = writeExecutable(dir, 'openvscode-server', `#!/usr/bin/env bash
pgid="$(ps -o pgid= -p "$$" | tr -d ' ')"
start_time="$(awk '{print $22}' "/proc/$$/stat")"
printf '%s|%s|%s|%s\\n' "$$" "$pgid" "$start_time" "\${CODEFLARE_OPENVSCODE_GENERATION-<unset>}" >> "$LAUNCHES_FILE"
exit 17
`);

    const result = runBash(`${acceleratedSupervisorScript()}\ntimeout 1 bash -c '_openvscode_supervise_loop' || true`, {
      OPENVSCODE_BIN: stub,
      OPENVSCODE_WORKSPACE: dir,
      OPENVSCODE_DATA_DIR: join(dir, 'data'),
      OPENVSCODE_REQUEST_TRIGGER: trigger,
      CODEFLARE_INIT_FLAG_FILE: flag,
      SESSION_ID: 'abcd1234',
      LAUNCHES_FILE: launchesFile,
    });
    assert.equal(result.status, 0, result.stderr);

    const launches = readFileSync(launchesFile, 'utf8').trim().split('\n').map((line) => {
      const [pid, pgid, startTime, generation] = line.split('|');
      return { pid, pgid, startTime, generation };
    });
    assert.ok(launches.length >= 2, `expected at least two generations, got ${launches.length}`);
    assert.ok(launches.every(({ pid, pgid, startTime }) => /^\d+$/.test(pid) && /^\d+$/.test(pgid) && /^\d+$/.test(startTime)));
    assert.ok(launches.every(({ generation }) => generation && generation !== '<unset>'), 'every launch carries a generation identity');
    assert.equal(new Set(launches.map(({ generation }) => generation)).size, launches.length, 'generation identities are unique');
    assert.equal(new Set(launches.map(({ pgid }) => pgid)).size, launches.length, 'each generation has its own process group');
  });

  it('REQ-IDE-003 AC4 + REQ-IDE-008 AC4: restart sends TERM then bounded KILL to a TERM-ignoring managed descendant', () => {
    const launchCount = join(dir, 'launch-count');
    const childPid = join(dir, 'managed.pid');
    const restartProbe = join(dir, 'restart-probe.log');
    const termLog = join(dir, 'term.log');
    const managedChild = writeTermIgnoringChild(dir);
    const stub = writeExecutable(dir, 'openvscode-server', `#!/usr/bin/env bash
count=0
[ ! -f "$LAUNCH_COUNT" ] || read -r count < "$LAUNCH_COUNT"
count=$((count + 1))
printf '%s\\n' "$count" > "$LAUNCH_COUNT"
if [ "$count" -eq 1 ]; then
  "$MANAGED_CHILD" >/dev/null 2>&1 &
  printf '%s\\n' "$!" > "$CHILD_PID_FILE"
  exit 23
fi
read -r prior < "$CHILD_PID_FILE"
if kill -0 "$prior" 2>/dev/null; then
  printf 'prior=alive\\n' >> "$RESTART_PROBE"
else
  printf 'prior=dead\\n' >> "$RESTART_PROBE"
fi
exit 0
`);

    const result = runBash(`${acceleratedSupervisorScript()}
timeout 2 bash -c '_openvscode_supervise_loop' || true
if [ -f "$CHILD_PID_FILE" ]; then
  read -r child < "$CHILD_PID_FILE"
  pkill -KILL -P "$child" 2>/dev/null || true
  kill -KILL "$child" 2>/dev/null || true
fi`, {
      OPENVSCODE_BIN: stub,
      OPENVSCODE_WORKSPACE: dir,
      OPENVSCODE_DATA_DIR: join(dir, 'data'),
      OPENVSCODE_REQUEST_TRIGGER: trigger,
      CODEFLARE_INIT_FLAG_FILE: flag,
      SESSION_ID: 'abcd1234',
      OPENVSCODE_TERM_GRACE_SECONDS: '0.2',
      LAUNCH_COUNT: launchCount,
      CHILD_PID_FILE: childPid,
      RESTART_PROBE: restartProbe,
      TERM_LOG: termLog,
      MANAGED_CHILD: managedChild,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(termLog), true, 'managed descendant observes TERM before escalation');
    assert.equal(readFileSync(restartProbe, 'utf8').trim().split('\n')[0], 'prior=dead', 'TERM-ignoring descendant is KILLed before replacement');
  });

  it('REQ-IDE-003 AC4 + REQ-IDE-008 AC4: OpenVSCode restart never leaves duplicate Pi or Claude children', () => {
    const cases = [
      { agent: 'pi', config: JSON.stringify([{ id: '1', command: 'pi', label: 'Terminal 1' }]) },
      { agent: 'claude', config: JSON.stringify([{ id: '1', command: 'claude', label: 'Terminal 1' }]) },
    ];

    const observed = cases.map(({ agent, config }) => {
      const caseDir = mkTmp(`ovsc-${agent}-dedupe-`);
      const childPid = join(caseDir, 'managed.pid');
      const launchCount = join(caseDir, 'launch-count');
      const probe = join(caseDir, 'probe.log');
      const stub = writeExecutable(caseDir, 'openvscode-server', `#!/usr/bin/env bash
count=0
[ ! -f "$LAUNCH_COUNT" ] || read -r count < "$LAUNCH_COUNT"
count=$((count + 1))
printf '%s\\n' "$count" > "$LAUNCH_COUNT"
if [ "$count" -eq 1 ]; then
  /bin/sleep 30 >/dev/null 2>&1 &
  printf '%s\\n' "$!" > "$CHILD_PID_FILE"
  exit 19
fi
read -r prior < "$CHILD_PID_FILE"
duplicate=0
kill -0 "$prior" 2>/dev/null && duplicate=1
printf 'agent=%s duplicate=%s\\n' "\${CODEFLARE_SIDEBAR_AGENT-<unset>}" "$duplicate" >> "$PROBE"
exit 0
`);
      const result = runBash(`${acceleratedSupervisorScript()}
timeout 1 bash -c '_openvscode_supervise_loop' || true
read -r child < "$CHILD_PID_FILE"
kill -KILL "$child" 2>/dev/null || true`, {
        OPENVSCODE_BIN: stub,
        OPENVSCODE_WORKSPACE: caseDir,
        OPENVSCODE_DATA_DIR: join(caseDir, 'data'),
        OPENVSCODE_REQUEST_TRIGGER: trigger,
        CODEFLARE_INIT_FLAG_FILE: flag,
        SESSION_ID: 'abcd1234',
        TAB_CONFIG: config,
        LAUNCH_COUNT: launchCount,
        CHILD_PID_FILE: childPid,
        PROBE: probe,
      });
      assert.equal(result.status, 0, `${agent}: ${result.stderr}`);
      const firstProbe = readFileSync(probe, 'utf8').trim().split('\n')[0];
      rmSync(caseDir, { recursive: true, force: true });
      return firstProbe;
    });

    assert.deepEqual(observed, ['agent=pi duplicate=0', 'agent=claude duplicate=0']);
  });

  it('REQ-IDE-008 AC4: cleans one launch generation before restart without signaling an identity-mismatched PID', () => {
    const launchCount = join(dir, 'launch-count');
    const managedPid = join(dir, 'managed.pid');
    const restartProbe = join(dir, 'restart-probe.log');
    const managedTermLog = join(dir, 'managed-term.log');
    const unrelatedPidfile = join(dir, 'unrelated.pid');
    const unrelatedTermLog = join(dir, 'unrelated-term.log');
    const managedChild = writeTermIgnoringChild(dir);
    const signalChild = writeSignalRecordingChild(dir);
    const stub = writeExecutable(dir, 'openvscode-server', `#!/usr/bin/env bash
count=0
[ ! -f "$LAUNCH_COUNT" ] || read -r count < "$LAUNCH_COUNT"
count=$((count + 1))
printf '%s\\n' "$count" > "$LAUNCH_COUNT"
if [ "$count" -eq 1 ]; then
  "$MANAGED_CHILD" >/dev/null 2>&1 &
  printf '%s\\n' "$!" > "$MANAGED_PID_FILE"
  exit 29
fi
read -r prior < "$MANAGED_PID_FILE"
if kill -0 "$prior" 2>/dev/null; then prior_state=alive; else prior_state=dead; fi
printf 'launch=%s prior=%s\\n' "$count" "$prior_state" >> "$RESTART_PROBE"
exit 0
`);

    const result = runBash(`${acceleratedSupervisorScript()}
${extractKillHelpers()}
unrelated_actual_pidfile="$UNRELATED_PIDFILE.actual"
SIGNAL_LOG="$UNRELATED_TERM_LOG" ACTUAL_PID_FILE="$unrelated_actual_pidfile" setsid --fork --wait "$SIGNAL_CHILD" >/dev/null 2>&1 &
unrelated_launcher=$!
cleanup_unrelated_fixture() {
  local actual=""
  if [ -s "$unrelated_actual_pidfile" ]; then
    read -r actual < "$unrelated_actual_pidfile"
    pkill -KILL -P "$actual" 2>/dev/null || true
    kill -KILL "$actual" 2>/dev/null || true
  fi
  pkill -KILL -P "$unrelated_launcher" 2>/dev/null || true
  kill -KILL "$unrelated_launcher" 2>/dev/null || true
  wait "$unrelated_launcher" 2>/dev/null || true
}
trap cleanup_unrelated_fixture EXIT
for _ in $(seq 1 100); do
  [ -s "$unrelated_actual_pidfile" ] && break
  sleep 0.01
done
[ -s "$unrelated_actual_pidfile" ] || { echo "unrelated fixture did not start" >&2; exit 1; }
read -r unrelated < "$unrelated_actual_pidfile"
printf '%s\\n' "$unrelated" > "$UNRELATED_PIDFILE"
actual_start="$(awk '{print $22}' "/proc/$unrelated/stat")"
kill_pidfile_subtree "$UNRELATED_PIDFILE" "$unrelated" "$((actual_start + 1))" wrong-generation

timeout 2 bash -c '_openvscode_supervise_loop' || true
if kill -0 "$unrelated" 2>/dev/null; then unrelated_state=alive; else unrelated_state=dead; fi
if [ -s "$UNRELATED_TERM_LOG" ]; then unrelated_signal=TERM; else unrelated_signal=none; fi
printf 'unrelated=%s signal=%s\\n' "$unrelated_state" "$unrelated_signal"

if [ -f "$MANAGED_PID_FILE" ]; then
  read -r managed < "$MANAGED_PID_FILE"
  pkill -KILL -P "$managed" 2>/dev/null || true
  kill -KILL "$managed" 2>/dev/null || true
fi`, {
      OPENVSCODE_BIN: stub,
      OPENVSCODE_WORKSPACE: dir,
      OPENVSCODE_DATA_DIR: join(dir, 'data'),
      OPENVSCODE_REQUEST_TRIGGER: trigger,
      CODEFLARE_INIT_FLAG_FILE: flag,
      SESSION_ID: 'abcd1234',
      OPENVSCODE_TERM_GRACE_SECONDS: '0.2',
      LAUNCH_COUNT: launchCount,
      MANAGED_PID_FILE: managedPid,
      RESTART_PROBE: restartProbe,
      TERM_LOG: managedTermLog,
      MANAGED_CHILD: managedChild,
      SIGNAL_CHILD: signalChild,
      UNRELATED_PIDFILE: unrelatedPidfile,
      UNRELATED_TERM_LOG: unrelatedTermLog,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(managedTermLog), true, 'old generation descendants receive TERM');
    assert.equal(readFileSync(restartProbe, 'utf8').trim().split('\n')[0], 'launch=2 prior=dead', 'TERM-ignoring descendant is KILLed before exactly one replacement starts');
    assert.equal(result.stdout.trim(), 'unrelated=alive signal=none', 'identity mismatch does not signal or kill an unrelated PID');
  });
});

describe('identity-safe OpenVSCode cleanup / REQ-IDE-008 AC4', () => {
  let dir;
  beforeEach(() => { dir = mkTmp('ovsc-identity-'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('REQ-IDE-008 AC4: token cleanup survives stale leader metadata without signaling an unrelated generation', () => {
    const signalChild = writeSignalRecordingChild(dir);
    const result = runBash(`${extractKillHelpers()}
probe_identity() {
  local label="$1" expected_pid_mode="$2" expected_start_mode="$3" expected_generation="$4"
  local pidfile="$FIXTURE/$label.pid" signal_log="$FIXTURE/$label.signal"
  local actual_pid_file="$FIXTURE/$label.actual-pid"
  SIGNAL_LOG="$signal_log" ACTUAL_PID_FILE="$actual_pid_file" CODEFLARE_OPENVSCODE_GENERATION=actual-generation setsid --fork --wait "$SIGNAL_CHILD" >/dev/null 2>&1 &
  local launcher=$!
  cleanup_probe_fixture() {
    local actual=""
    if [ -s "$actual_pid_file" ]; then
      read -r actual < "$actual_pid_file"
      pkill -KILL -P "$actual" 2>/dev/null || true
      kill -KILL "$actual" 2>/dev/null || true
    fi
    pkill -KILL -P "$launcher" 2>/dev/null || true
    kill -KILL "$launcher" 2>/dev/null || true
    wait "$launcher" 2>/dev/null || true
  }
  for _ in $(seq 1 100); do
    [ -s "$actual_pid_file" ] && break
    sleep 0.01
  done
  if [ ! -s "$actual_pid_file" ]; then
    cleanup_probe_fixture
    echo "$label fixture did not start" >&2
    return 1
  fi
  local target actual_start expected_pid expected_start
  read -r target < "$actual_pid_file"
  actual_start="$(awk '{print $22}' "/proc/$target/stat")"
  expected_pid="$target"
  expected_start="$actual_start"
  [ "$expected_pid_mode" = match ] || expected_pid=$((target + 1000000))
  [ "$expected_start_mode" = match ] || expected_start=$((actual_start + 1))
  printf '%s\\n' "$target" > "$pidfile"

  kill_pidfile_subtree "$pidfile" "$expected_pid" "$expected_start" "$expected_generation"
  sleep 0.15
  if [ -s "$signal_log" ]; then printf '%s=SIGNALED\\n' "$label"; else printf '%s=UNSIGNALED\\n' "$label"; fi
  cleanup_probe_fixture
}
probe_identity matching match match actual-generation
probe_identity pid mismatch match actual-generation
probe_identity start match mismatch actual-generation
probe_identity generation match match other-generation`, {
      FIXTURE: dir,
      SIGNAL_CHILD: signalChild,
      OPENVSCODE_TERM_GRACE_SECONDS: '0.2',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      'matching=SIGNALED',
      'pid=UNSIGNALED',
      'start=SIGNALED',
      'generation=UNSIGNALED',
    ]);
  });

  it('REQ-IDE-008 AC4: generation cleanup rescans children forked between signal snapshots', () => {
    const forker = writeExecutable(dir, 'fork-on-term', `#!/usr/bin/env bash
trap '
  (
    for _ in $(seq 1 40); do
      setsid sleep 30 >/dev/null 2>&1 &
      sleep 0.01
    done
  ) &
' TERM
while true; do sleep 0.1; done
`);
    const result = runBash(`${extractKillHelpers()}
CODEFLARE_OPENVSCODE_GENERATION=fork-race "$FORKER" >/dev/null 2>&1 &
leader=$!
sleep 0.1
_wait_then_kill_generation fork-race
remaining="$(_openvscode_generation_members fork-race)"
printf 'remaining=%s\n' "\${remaining:-none}"
for pid in $remaining; do kill -KILL "$pid" 2>/dev/null || true; done
kill -KILL "$leader" 2>/dev/null || true`, {
      FORKER: forker,
      OPENVSCODE_TERM_GRACE_SECONDS: '0.2',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'remaining=none');
  });
});

describe('kill_pidfile_subtree / REQ-IDE-003 AC5 (shutdown releases the IDE port)', () => {
  let dir, pidfile;
  beforeEach(() => {
    dir = mkTmp('ovsc-kill-');
    pidfile = join(dir, 'openvscode.pid');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('kills the pidfile-tracked process subtree (the mechanism shutdown_handler uses for /tmp/openvscode.pid)', () => {
    // Start a real long sleeper, record its PID as the "supervisor" pidfile,
    // then run the extracted teardown helpers and assert the process is gone.
    const script = `
${extractKillHelpers()}
sleep 30 &
child=$!
echo "$child" > "${pidfile}"
kill_pidfile_subtree "${pidfile}"
sleep 0.3
if kill -0 "$child" 2>/dev/null; then echo "ALIVE"; else echo "DEAD"; fi
`;
    const r = runBash(script);
    assert.equal(r.stdout.trim(), 'DEAD');
  });

  it('REQ-IDE-003 AC5 + REQ-IDE-008 AC4: session shutdown removes the current launch group and supervisor', () => {
    const flag = join(dir, 'init-complete');
    const trigger = join(dir, 'requested');
    const managedPid = join(dir, 'managed.pid');
    const termLog = join(dir, 'term.log');
    const generationPidfile = join(dir, 'generation.pid');
    const managedChild = writeTermIgnoringChild(dir);
    const stub = writeExecutable(dir, 'openvscode-server', `#!/usr/bin/env bash
"$MANAGED_CHILD" >/dev/null 2>&1 &
printf '%s\\n' "$!" > "$MANAGED_PID_FILE"
wait
`);
    writeFileSync(flag, '');
    writeFileSync(trigger, '');

    const result = runBash(`${openvscodeSupervisorScript()}
${extractKillHelpers()}
setsid bash -c '_openvscode_supervise_loop' >/dev/null 2>&1 &
supervisor=$!
printf '%s\\n' "$supervisor" > "$OPENVSCODE_PIDFILE"
# The managed child can publish first; shutdown owns the atomically published
# generation identity, so wait for both readiness signals before exercising it.
for _ in $(seq 1 100); do
  [ -s "$MANAGED_PID_FILE" ] && [ -s "$OPENVSCODE_GENERATION_PIDFILE" ] && break
  sleep 0.02
done
if [ ! -s "$MANAGED_PID_FILE" ] || [ ! -s "$OPENVSCODE_GENERATION_PIDFILE" ]; then
  echo "openvscode generation readiness timed out" >&2
  exit 1
fi
read -r managed < "$MANAGED_PID_FILE"
kill_pidfile_subtree "$OPENVSCODE_GENERATION_PIDFILE"
kill_pidfile_subtree "$OPENVSCODE_PIDFILE"
# kill -0 also succeeds for a terminated process that briefly remains a zombie
# while CI's init process catches up. Assert that neither process is runnable.
is_running() {
  [ -r "/proc/$1/stat" ] || return 1
  [ "$(awk '{print $3}' "/proc/$1/stat")" != Z ]
}
for _ in $(seq 1 50); do
  if ! is_running "$supervisor" && ! is_running "$managed"; then break; fi
  sleep 0.02
done
if is_running "$supervisor"; then supervisor_state=alive; else supervisor_state=dead; fi
if is_running "$managed"; then managed_state=alive; else managed_state=dead; fi
printf 'supervisor=%s managed=%s\\n' "$supervisor_state" "$managed_state"
pkill -KILL -P "$managed" 2>/dev/null || true
kill -KILL "$managed" "$supervisor" 2>/dev/null || true`, {
      OPENVSCODE_BIN: stub,
      OPENVSCODE_WORKSPACE: dir,
      OPENVSCODE_DATA_DIR: join(dir, 'data'),
      OPENVSCODE_REQUEST_TRIGGER: trigger,
      CODEFLARE_INIT_FLAG_FILE: flag,
      SESSION_ID: 'abcd1234',
      OPENVSCODE_PIDFILE: pidfile,
      OPENVSCODE_GENERATION_PIDFILE: generationPidfile,
      MANAGED_CHILD: managedChild,
      MANAGED_PID_FILE: managedPid,
      TERM_LOG: termLog,
      OPENVSCODE_TERM_GRACE_SECONDS: '0.2',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'supervisor=dead managed=dead');
    assert.equal(existsSync(termLog), true, 'launch group receives TERM before bounded KILL');
  });
});

// @types/node is published on DefinitelyTyped's own cadence, so only its major
// is required to match the pinned builder Node. The extension API floor is
// checked against the installed Code runtime by the complete-image smoke.
const sidebarPkg = () =>
  JSON.parse(readFileSync(resolve(__dirname, '../../openvscode/agent-sidebar/package.json'), 'utf8'));
const versionMajor = (version) => version.replace(/^[^\d]*/, '').split('.')[0];

describe('agent-sidebar type pins track the runtime they describe', () => {
  it('pins @types/node to the Node the image builds the extension with', () => {
    const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf8');
    const pkg = sidebarPkg();
    // Anchored to the builder stage, not to engines.node: comparing the manifest
    // against itself would stay green while engines.node drifted away from the
    // Node the extension is actually compiled and run with.
    const builder = dockerfile.match(
      /FROM \S+node:([\d.]+)-\S+ AS openvscode-agent-sidebar-builder/
    );
    assert.ok(builder, 'Dockerfile must pin an explicit Node for the sidebar builder stage');
    assert.equal(
      pkg.engines.node,
      builder[1],
      'engines.node must match the Node the sidebar builder stage runs'
    );
    assert.equal(
      versionMajor(pkg.devDependencies['@types/node']),
      versionMajor(builder[1]),
      '@types/node major must match the Node the sidebar builder stage runs'
    );
  });
});
