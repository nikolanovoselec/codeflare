// REQ-STOR-012: Main Session Transcript Cleanup
//
// Behavioral coverage for Claude Code and Pi main-transcript retention.
// Native subagent/task transcripts and Codex state are outside this cleanup.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

// Isolate unmanaged lifecycle behavior; real policy composition is covered by the rclone matrix.
const unmanagedPolicyFixture = "prepare_managed_resource_filter() { :; }\npersist_pi_hermes_memory() { :; }\ncompose_rclone_filters() { RCLONE_EFFECTIVE_FILTERS=(\"${RCLONE_FILTERS[@]}\"); }";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const ENTRYPOINT = join(REPO_ROOT, 'entrypoint.sh');
const RETENTION_SCRIPT = join(REPO_ROOT, 'transcript-retention.mjs');

function shellEnv(runtimeRoot) {
  const syncRuntimeDir = join(runtimeRoot, 'sync');
  mkdirSync(syncRuntimeDir, { recursive: true });
  return { ...process.env, CODEFLARE_RUNTIME_ROOT: runtimeRoot, SYNC_RUNTIME_DIR: syncRuntimeDir };
}

function extractShellFunction(name, endMarker) {
  const body = readFileSync(ENTRYPOINT, 'utf8');
  const start = body.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `${name} must exist in entrypoint.sh`);
  const rest = body.slice(start);
  const close = endMarker ? rest.indexOf(endMarker) : rest.search(/\n\}\n/);
  assert.notEqual(close, -1, `${name} must have a complete definition`);
  const fn = rest.slice(0, close + (endMarker ? 0 : 3));
  if (['initial_sync_from_r2', 'establish_bisync_baseline', 'bisync_with_r2'].includes(name)) {
    return `source ${JSON.stringify(join(REPO_ROOT, 'scripts/rclone-conflict-cleanup.sh'))}\ntimeout() { shift; "$@"; }\n${fn}`;
  }
  return fn;
}

function extractShellFragment(startMarker, endMarker) {
  const body = readFileSync(ENTRYPOINT, 'utf8');
  const start = body.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist in entrypoint.sh`);
  const end = body.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${endMarker} must exist after ${startMarker}`);
  return body.slice(start, end + endMarker.length);
}

function extractShellArray(name) {
  const body = readFileSync(ENTRYPOINT, 'utf8');
  const startMarker = `${name}=(`;
  const start = body.indexOf(startMarker);
  assert.notEqual(start, -1, `${name} must exist in entrypoint.sh`);
  const end = body.indexOf('\n)', start);
  assert.notEqual(end, -1, `${name} must have a closing parenthesis`);
  return body.slice(start, end + 2);
}

function makeScratch() {
  const dir = mkdtempSync(join(tmpdir(), 'transcript retention '));
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'transcript-cleanup-runtime-'));
  return {
    dir,
    runtimeRoot,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(runtimeRoot, { recursive: true, force: true });
    },
  };
}

function uuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function setMtime(path, seconds) {
  utimesSync(path, seconds, seconds);
}

function writeClaude(root, index, nativeSecond, mtimeSecond, options = {}) {
  const id = uuid(index);
  const transcriptId = options.sessionId ?? id;
  const filenameId = options.filenameId ?? id;
  const project = options.project ?? join(root, `project ${index % 2}`, 'nested');
  mkdirSync(project, { recursive: true });
  const path = join(project, `${filenameId}.jsonl`);
  const records = [
    JSON.stringify({ type: 'last-prompt', sessionId: id }),
    JSON.stringify({
      type: 'user',
      sessionId: transcriptId,
      version: options.version ?? '2.1.224',
      isSidechain: options.isSidechain ?? false,
      timestamp: options.omitTimestamps
        ? undefined
        : `2026-08-18T10:00:${String(nativeSecond).padStart(2, '0')}.000Z`,
    }),
  ];
  if (options.malformedInterior) records.push('{malformed');
  records.push(JSON.stringify({
    type: 'assistant',
    sessionId: transcriptId,
    version: options.version ?? '2.1.224',
    isSidechain: options.isSidechain ?? false,
    timestamp: options.omitTimestamps
      ? undefined
      : `2026-08-18T10:01:${String(nativeSecond).padStart(2, '0')}.000Z`,
  }));
  if (options.malformedTail) records.push('{partial');
  writeFileSync(path, `${records.join('\n')}\n`);
  setMtime(path, mtimeSecond);
  return path;
}

function writePi(root, index, nativeSecond, mtimeSecond, options = {}) {
  const id = uuid(index);
  const filenameId = options.filenameId ?? id;
  const sessionDir = options.sessionDir ?? join(root, `workspace ${index % 2}`, 'nested');
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, `2026-08-18T10-00-${String(index).padStart(2, '0')}Z_${filenameId}.jsonl`);
  const header = {
    type: options.type ?? 'session',
    version: options.version ?? 3,
    id: options.sessionId ?? id,
    cwd: options.cwd,
    timestamp: `2026-08-18T10:00:${String(nativeSecond).padStart(2, '0')}.000Z`,
  };
  if (options.parentSession) header.parentSession = options.parentSession;
  const records = [JSON.stringify(header)];
  if (options.malformedInterior) records.push('{malformed');
  records.push(JSON.stringify({
    type: 'message',
    timestamp: `2026-08-18T10:01:${String(nativeSecond).padStart(2, '0')}.000Z`,
  }));
  if (options.malformedTail) records.push('{partial');
  writeFileSync(path, `${records.join('\n')}\n`);
  setMtime(path, mtimeSecond);
  return path;
}

function runRetention(agent, root, { runtimeRoot }) {
  return execFileSync(process.execPath, [RETENTION_SCRIPT, agent, root, '10'], {
    encoding: 'utf8',
    env: shellEnv(runtimeRoot),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function classicFixture(scratch, options = {}) {
  const sessionId = 'retention123';
  const home = scratch.dir;
  const cwd = join(home, 'workspace');
  const root = join(home, '.pi/agent/sessions');
  const sessionDir = join(root, `--${cwd.slice(1).replace(/[/:]/g, '-')}--`);
  const bindingFile = join(home, '.codeflare/classic/sessions', `cf-${sessionId}`, 'agent-session-id');
  mkdirSync(dirname(bindingFile), { recursive: true });
  writeFileSync(bindingFile, `${uuid(0)}\n`);
  const old = writePi(root, 0, 0, 19_000, { sessionDir, cwd, ...options });
  const others = Array.from({ length: 33 }, (_, i) => writePi(root, i + 1, i + 1, 20_000 + (33 - i)));
  return { home, cwd, sessionId, sessionDir, bindingFile, old, others };
}

function runClassicCleanup(scratch, sessionId, { mode = 'classic', final = false } = {}) {
  const events = join(scratch.dir, 'outbound-transcripts');
  const initFlag = join(scratch.runtimeRoot, 'init');
  const env = shellEnv(scratch.runtimeRoot);
  if (final) writeFileSync(join(env.SYNC_RUNTIME_DIR, 'bisync-initialized'), '');
  const shell = `set -e
USER_HOME="$1"
SESSION_ID="$2"
CODEFLARE_TERMINAL_MODE="$3"
TRANSCRIPT_RETENTION_SCRIPT="$4"
EVENTS="$5"
CODEFLARE_INIT_FLAG_FILE="$6"
CODEFLARE_OPERATOR_SESSION=false
BISYNC_INIT_PID=
TERMINAL_PID=
R2_BUCKET_NAME=test
RCLONE_CONFIG=/dev/null
RECOVERY_FILTER_FILE=/dev/null
${unmanagedPolicyFixture}
RCLONE_FILTERS=()
repair_hook_exec_bits() { :; }
kill_pidfile_subtree() { :; }
pgrep() { return 1; }
sleep() { :; } # Only the watchdog uses sleep; its signals are also stubbed.
kill() { :; }
rclone() {
  if [ "$1" = bisync ]; then
    find "$USER_HOME/.pi/agent/sessions" -type f -name '*.jsonl' > "$EVENTS"
  fi
}
${extractShellFunction('cleanup_agent_transcripts')}
${extractShellFunction('cleanup_old_transcripts')}
${extractShellFunction('cleanup_old_pi_transcripts')}
${extractShellFunction('cleanup_main_transcripts')}
${final ? ['cleanup_remote_pi_transcript_conflicts', 'record_sync_disk_failure', 'bisync_with_r2', 'shutdown_handler']
    .map((name) => extractShellFunction(name)).join('\n') : extractShellFunction('release_agent_pty_after_cleanup')}
${final ? 'shutdown_handler' : 'release_agent_pty_after_cleanup'}
`;
  execFileSync('bash', ['-c', shell, 'classic-retention', scratch.dir, sessionId, mode, RETENTION_SCRIPT, events, initFlag], {
    stdio: ['ignore', 'pipe', 'pipe'], env,
  });
  if (final) return readFileSync(events, 'utf8').trimEnd().split('\n').sort();
  assert.ok(existsSync(initFlag), 'startup releases PTY prewarm');
}

async function importPiWebRuntime() {
  // Match the Host's emitted .js imports to their TS sources without a local build.
  const hostSrc = new URL('../src/', import.meta.url);
  const runtimeUrl = new URL('pi-web-runtime.ts', hostSrc);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === runtimeUrl.href) {
        if (specifier === './pi-web-handoff.js') return next('./pi-web-handoff.ts', context);
        // Terminal startup uses the real Host binding and ticket, not any stock Chat services.
        if (specifier === './pi-web-services.js') return { shortCircuit: true, url:
          'data:text/javascript,export const managedPiPackage = undefined; export const createPiWebServices = () => ({ close: async () => {} });' };
      }
      return next(specifier, context);
    },
  });
  try { return await import(runtimeUrl); }
  finally { hooks.deregister(); }
}

function transcriptNames(root) {
  const names = [];
  const visit = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.jsonl')) names.push(entry.name);
    }
  };
  visit(root);
  return names.sort();
}

describe('main transcript retention / REQ-STOR-012', () => {
  test('AC1: regular bisync observes the already-pruned transcript set', () => {
    const scratch = makeScratch();
    try {
      const claude = join(scratch.dir, '.claude', 'projects');
      for (let i = 0; i < 12; i++) writeClaude(claude, i, i, 8_000 + (11 - i));
      const events = join(scratch.dir, 'events');
      const shell = `set +e
USER_HOME="$1"
EVENTS="$2"
TRANSCRIPT_RETENTION_SCRIPT="$3"
R2_BUCKET_NAME=test
RCLONE_CONFIG=/dev/null
RECOVERY_FILTER_FILE=/dev/null
${unmanagedPolicyFixture}
RCLONE_FILTERS=()
repair_hook_exec_bits() { :; }
pgrep() { return 1; }
rclone() {
  if [ "$1" = "delete" ]; then return 0; fi
  find "$USER_HOME/.claude/projects" -type f -name '*.jsonl' | wc -l >> "$EVENTS"
  return 1
}
${extractShellFunction('cleanup_agent_transcripts')}
${extractShellFunction('cleanup_old_transcripts')}
${extractShellFunction('cleanup_old_pi_transcripts')}
${extractShellFunction('cleanup_main_transcripts')}
${extractShellFunction('cleanup_remote_pi_transcript_conflicts')}
${extractShellFunction('record_sync_disk_failure')}
${extractShellFunction('bisync_with_r2')}
bisync_with_r2 '' || true
`;

      execFileSync('bash', ['-c', shell, 'retention-test', scratch.dir, events, RETENTION_SCRIPT], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: shellEnv(scratch.runtimeRoot),
      });

      assert.equal(readFileSync(events, 'utf8').trim(), '10');
    } finally {
      scratch.cleanup();
    }
  });

  test('REQ-STOR-051 AC2: regular bisync removes remote Pi conflicts while preserving canonical transcripts', () => {
    const scratch = makeScratch();
    const remoteRoot = mkdtempSync(join(tmpdir(), 'remote-transcript-cleanup-'));
    try {
      const local = join(scratch.dir, '.pi', 'agent', 'sessions', 'workspace');
      const remote = join(remoteRoot, '.pi', 'agent', 'sessions', 'workspace');
      mkdirSync(local, { recursive: true });
      mkdirSync(remote, { recursive: true });
      const canonicalName = `2026-08-18T10-00-01Z_${uuid(1)}.jsonl`;
      writeFileSync(join(local, canonicalName), 'canonical');
      writeFileSync(join(remote, canonicalName), 'canonical');
      writeFileSync(join(remote, `${canonicalName}.conflict1.conflict2`), 'duplicate');

      const shell = `set +e
USER_HOME="$1"
REMOTE="$2"
R2_BUCKET_NAME=test
RCLONE_CONFIG=/dev/null
RECOVERY_FILTER_FILE=/dev/null
${unmanagedPolicyFixture}
RCLONE_FILTERS=(--filter "- .pi/agent/sessions/**.conflict*")
cleanup_main_transcripts() { find "$USER_HOME/.pi/agent/sessions" -type f -name '*.conflict*' -delete; }
repair_hook_exec_bits() { :; }
pgrep() { return 1; }
rclone() {
  if [ "$1" = "delete" ]; then
    if ! printf '%s\\n' "$*" | grep -F -- '--include **/*.conflict*' >/dev/null; then
      printf '%s\\n' "$*" | grep -F -- '--filter + *.conflict*' >/dev/null || return 9
    fi
    find "$REMOTE/.pi/agent/sessions" -type f -name '*.conflict*' -delete
    return 0
  fi
  return 0
}
${extractShellFunction('cleanup_remote_pi_transcript_conflicts')}
${extractShellFunction('record_sync_disk_failure')}
${extractShellFunction('bisync_with_r2')}
bisync_with_r2 ''
`;

      execFileSync('bash', ['-c', shell, 'remote-conflict-cleanup', scratch.dir, remoteRoot], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: shellEnv(scratch.runtimeRoot),
      });

      assert.equal(existsSync(join(remote, `${canonicalName}.conflict1.conflict2`)), false);
      assert.equal(readFileSync(join(remote, canonicalName), 'utf8'), 'canonical');
      assert.equal(readFileSync(join(local, canonicalName), 'utf8'), 'canonical');
    } finally {
      scratch.cleanup();
      rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  test('REQ-STOR-051 AC3: a failed remote cleanup cannot restore conflict copies through bisync', () => {
    const scratch = makeScratch();
    const remoteRoot = mkdtempSync(join(tmpdir(), 'failed-remote-transcript-cleanup-'));
    try {
      const local = join(scratch.dir, '.pi', 'agent', 'sessions', 'workspace');
      const remote = join(remoteRoot, '.pi', 'agent', 'sessions', 'workspace');
      mkdirSync(local, { recursive: true });
      mkdirSync(remote, { recursive: true });
      const conflictName = `2026-08-18T10-00-01Z_${uuid(1)}.jsonl.conflict1`;
      writeFileSync(join(remote, conflictName), 'remote duplicate');

      const shell = `set +e
USER_HOME="$1"
REMOTE="$2"
R2_BUCKET_NAME=test
RCLONE_CONFIG=/dev/null
RECOVERY_FILTER_FILE=/dev/null
${extractShellArray('RCLONE_FILTERS_COMMON')}
${unmanagedPolicyFixture}
RCLONE_FILTERS=("\${RCLONE_FILTERS_COMMON[@]}")
cleanup_main_transcripts() { find "$USER_HOME/.pi/agent/sessions" -type f -name '*.conflict*' -delete; }
repair_hook_exec_bits() { :; }
pgrep() { return 1; }
rclone() {
  if [ "$1" = "delete" ]; then return 9; fi
  printf '%s\\n' "$*" | grep -F -- '- .pi/agent/sessions/**.conflict*' >/dev/null || cp "$REMOTE/.pi/agent/sessions/workspace/${conflictName}" "$USER_HOME/.pi/agent/sessions/workspace/${conflictName}"
  return 0
}
${extractShellFunction('cleanup_remote_pi_transcript_conflicts')}
${extractShellFunction('record_sync_disk_failure')}
${extractShellFunction('bisync_with_r2')}
if bisync_with_r2 ''; then SYNC_EXIT=0; else SYNC_EXIT=$?; fi
printf '%s' "$SYNC_EXIT" > "$USER_HOME/bisync-exit"
`;

      execFileSync('bash', ['-c', shell, 'remote-conflict-filter', scratch.dir, remoteRoot], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: shellEnv(scratch.runtimeRoot),
      });

      assert.equal(readFileSync(join(scratch.dir, 'bisync-exit'), 'utf8'), '9');
      assert.equal(existsSync(join(local, conflictName)), false);
      assert.equal(existsSync(join(remote, conflictName)), true, 'failed cleanup leaves remote evidence for a later retry');
    } finally {
      scratch.cleanup();
      rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  test('AC6: transcript cleanup occurs before the agent PTY release flag', () => {
    const scratch = makeScratch();
    try {
      const events = join(scratch.dir, 'events');
      const releaseFlag = join(scratch.dir, 'init-complete');
      const startupRelease = extractShellFragment(
        '# The terminal server has been polling this flag before spawning tab 1.',
        'release_agent_pty_after_fast_start_updates',
      );
      const shell = `set -e
EVENTS="$1"
CODEFLARE_INIT_FLAG_FILE="$2"
USER_HOME="${scratch.dir}"
PI_NPM_DIR="$USER_HOME/.pi/agent/npm"
cleanup_main_transcripts() { printf '%s\\n' cleanup >> "$EVENTS"; }
touch() { printf '%s\\n' release >> "$EVENTS"; }
update_pi_and_codex_when_fast_start_disabled() { :; }
${extractShellFunction('release_agent_pty_after_cleanup')}
${extractShellFunction('release_agent_pty_after_fast_start_updates', '\n# Warm Pi extension npm dependencies')}
${startupRelease}
`;

      execFileSync('bash', ['-c', shell, 'retention-release-test', events, releaseFlag], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: shellEnv(scratch.runtimeRoot),
      });

      assert.equal(readFileSync(events, 'utf8'), 'cleanup\nrelease\n');
    } finally {
      scratch.cleanup();
    }
  });

  test('AC7: cleanup failure does not prevent the outbound bisync', () => {
    const scratch = makeScratch();
    try {
      const events = join(scratch.dir, 'events');
      const shell = `set -e
USER_HOME="$1"
EVENTS="$2"
R2_BUCKET_NAME=test
RCLONE_CONFIG=/dev/null
RECOVERY_FILTER_FILE=/dev/null
${unmanagedPolicyFixture}
RCLONE_FILTERS=()
cleanup_old_transcripts() { printf '%s\\n' cleanup-claude >> "$EVENTS"; return 7; }
cleanup_old_pi_transcripts() { printf '%s\\n' cleanup-pi >> "$EVENTS"; return 8; }
repair_hook_exec_bits() { :; }
pgrep() { return 1; }
find() { return 0; }
rclone() { if [ "$1" = "delete" ]; then return 0; fi; printf '%s\\n' rclone >> "$EVENTS"; return 0; }
${extractShellFunction('cleanup_main_transcripts')}
${extractShellFunction('cleanup_remote_pi_transcript_conflicts')}
${extractShellFunction('record_sync_disk_failure')}
${extractShellFunction('bisync_with_r2')}
bisync_with_r2 ''
`;

      execFileSync('bash', ['-c', shell, 'retention-failure-test', scratch.dir, events], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: shellEnv(scratch.runtimeRoot),
      });

      assert.equal(readFileSync(events, 'utf8'), 'cleanup-claude\ncleanup-pi\nrclone\n');
    } finally {
      scratch.cleanup();
    }
  });

  test('AC2: Claude and Pi independently keep ten main transcripts by native activity across nested folders', () => {
    const scratch = makeScratch();
    try {
      const claude = join(scratch.dir, '.claude', 'projects');
      const pi = join(scratch.dir, '.pi', 'agent', 'sessions');
      const claudePaths = [];
      const piPaths = [];
      for (let i = 0; i < 12; i++) {
        claudePaths.push(writeClaude(claude, i, i, 10_000 + (11 - i)));
        piPaths.push(writePi(pi, i, i, 20_000 + (11 - i)));
      }

      runRetention('claude', claude, scratch);
      runRetention('pi', pi, scratch);

      assert.deepEqual(claudePaths.filter(existsSync).map((p) => Number(basename(p).slice(24, 36))).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      assert.deepEqual(piPaths.filter(existsSync).map((p) => Number(basename(p).match(/(\d{12})\.jsonl$/)[1])).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    } finally {
      scratch.cleanup();
    }
  });

  test('REQ-STOR-012 AC3/AC4: production Pi cleanup keeps up to thirty main transcripts', () => {
    for (const [count, fallback] of [[20, false], [35, false], [35, true]]) {
      const scratch = makeScratch();
      try {
        const root = join(scratch.dir, '.pi', 'agent', 'sessions');
        const paths = Array.from({ length: count }, (_, i) =>
          writePi(root, i, i, 20_000 + count - i, fallback && i === 0 ? { version: 4 } : {}));
        const shell = `set -e
USER_HOME="$1"
TRANSCRIPT_RETENTION_SCRIPT="$2"
${extractShellFunction('cleanup_agent_transcripts')}
${extractShellFunction('cleanup_old_pi_transcripts')}
cleanup_old_pi_transcripts
`;
        execFileSync('bash', ['-c', shell, 'pi-retention-limit', scratch.dir, RETENTION_SCRIPT], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: shellEnv(scratch.runtimeRoot),
        });
        assert.deepEqual(paths.filter(existsSync), fallback ? paths.slice(0, 30) : paths.slice(Math.max(0, count - 30)));
      } finally {
        scratch.cleanup();
      }
    }
  });

  test('REQ-STOR-012: startup reserves one Pi slot for the committed Classic transcript, preserving native and mtime ranking', async (t) => {
    for (const version of [3, 2]) {
      await t.test(`Pi v${version}`, () => {
        const scratch = makeScratch();
        try {
          const { sessionId, old, others } = classicFixture(scratch, { version });
          const bytes = readFileSync(old);
          runClassicCleanup(scratch, sessionId);
          assert.ok(existsSync(old), 'the oldest committed transcript must survive');
          const ranked = version === 3 ? others.slice(-29) : others.slice(0, 29);
          assert.deepEqual(others.filter(existsSync), ranked);
          assert.deepEqual(readFileSync(old), bytes);
        } finally {
          scratch.cleanup();
        }
      });
    }
  });

  test('REQ-STOR-012 / REQ-AGENT-211 AC6: a Classic rebind at rank thirty cannot commit a transcript pruned by overlapping cleanup', async (t) => {
    const scratch = makeScratch();
    t.after(scratch.cleanup);
    const { home, cwd, sessionId, sessionDir, bindingFile, old, others } = classicFixture(scratch);
    const root = join(home, '.pi/agent/sessions');
    // Unprotected rank 30. Only 29 ranked slots remain while old is bound.
    rmSync(others[3]);
    const target = writePi(root, 4, 4, 19_999, { sessionDir, cwd });
    const paused = join(scratch.runtimeRoot, 'cleanup-ready');
    const proceed = join(scratch.runtimeRoot, 'allow-cleanup');
    const waiting = join(scratch.runtimeRoot, 'rebind-waiting');
    const pauseUnlink = join(scratch.runtimeRoot, 'pause-unlink.mjs');
    const observeFlock = join(scratch.runtimeRoot, 'observe-flock.mjs');
    writeFileSync(pauseUnlink, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const unlink = fs.unlinkSync;
      fs.unlinkSync = path => {
        if (path === ${JSON.stringify(target)}) {
          fs.writeFileSync(${JSON.stringify(paused)}, '');
          const deadline = Date.now() + 4000;
          while (!fs.existsSync(${JSON.stringify(proceed)})) {
            if (Date.now() >= deadline) throw new Error('test did not release cleanup');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          }
        }
        unlink(path);
      };
      syncBuiltinESMExports();
    `);
    writeFileSync(observeFlock, `
      import childProcess from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const spawnSync = childProcess.spawnSync;
      childProcess.spawnSync = (file, ...args) => {
        if (file.endsWith('flock')) writeFileSync(${JSON.stringify(waiting)}, '');
        return spawnSync(file, ...args);
      };
      syncBuiltinESMExports();
    `);
    const env = { ...shellEnv(scratch.runtimeRoot), TRANSCRIPT_RETENTION_SCRIPT: RETENTION_SCRIPT,
      HOME: home, CODEFLARE_TERMINAL_MODE: 'classic', TERMINAL_ID: '1', SESSION_ID: sessionId };
    const cleanup = spawn(process.execPath, ['--import', pauseUnlink, RETENTION_SCRIPT, 'pi', root, '30', home, sessionId],
      { stdio: 'ignore', env });
    const cleanupDone = once(cleanup, 'close');
    const until = async (predicate) => {
      const deadline = Date.now() + 3000;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('test did not reach filesystem boundary');
        await delay(5);
      }
    };
    await until(() => existsSync(paused));
    const lock = join(scratch.runtimeRoot, 'locks/pi-transcript-retention.lock');
    const held = existsSync(lock) && spawnSync('flock', ['-n', lock, 'true']).status === 1;
    const extension = join(home, '.pi/agent/extensions/classic-session-binding.ts');
    mkdirSync(dirname(extension), { recursive: true });
    writeFileSync(extension, 'throw new Error("legacy release hook must not be loaded");\n');
    execFileSync('bash', ['-ec', `${extractShellFunction('install_image_owned_classic_pi_binding')}\ninstall_image_owned_classic_pi_binding`], {
      env: { ...env, USER_HOME: home, PI_WARM_EXTENSIONS_DIR: join(REPO_ROOT, 'preseed/agents/pi/extensions') },
    });
    const writer = spawn(process.execPath, ['--input-type=module', '-e', `
      const { adoptClassicResumedSession } = await import(${JSON.stringify(extension)}).catch(() => process.exit(2));
      try {
        const adopted = adoptClassicResumedSession({ reason: 'resume' }, {
          sessionManager: { getSessionFile: () => ${JSON.stringify(target)}, getSessionId: () => ${JSON.stringify(uuid(4))} },
          ui: { notify() {} },
        });
        process.exitCode = adopted ? 0 : 1;
      } catch { process.exitCode = 1; }
    `], { stdio: 'ignore', env: { ...env, NODE_OPTIONS: `--import=${observeFlock}` } });
    const writerDone = once(writer, 'close');
    // A guarded writer reaches real flock; an unguarded one can finish while cleanup is paused.
    try { await until(() => existsSync(waiting) || writer.exitCode !== null); }
    finally { writeFileSync(proceed, ''); }
    assert.deepEqual(await cleanupDone, [0, null]);
    assert.equal(readFileSync(bindingFile, 'utf8'), `${uuid(0)}\n`, 'the previous selection is still committed');
    assert.equal(held, true, 'cleanup still owns the kernel guard at deletion');
    assert.deepEqual(await writerDone, [1, null], 'a disappeared target cannot be committed');
    assert.equal(existsSync(target), false);
    assert.deepEqual(others.filter(existsSync), others.slice(-29));
    assert.equal(existsSync(old), true);
  });

  test('REQ-STOR-012: an unusable Pi guard skips pruning, without disabling Claude retention', () => {
    const scratch = makeScratch();
    try {
      const { home, sessionId, old, others } = classicFixture(scratch);
      const claude = join(home, '.claude/projects');
      const claudeFiles = Array.from({ length: 11 }, (_, i) => writeClaude(claude, i, i, i));
      const locks = join(scratch.runtimeRoot, 'locks');
      mkdirSync(locks);
      symlinkSync(join(scratch.runtimeRoot, 'not-a-lock'), join(locks, 'pi-transcript-retention.lock'));
      runClassicCleanup(scratch, sessionId);
      assert.equal(existsSync(old), true);
      assert.deepEqual(others.filter(existsSync), others);
      assert.deepEqual(claudeFiles.filter(existsSync), claudeFiles.slice(1));
    } finally {
      scratch.cleanup();
    }
  });

  test('REQ-STOR-012: final bisync sees the capped set and fresh Classic Terminal Resume issues the exact committed path', async (t) => {
    const scratch = makeScratch();
    const env = { CODEFLARE_RUNTIME_ROOT: scratch.runtimeRoot, TRANSCRIPT_RETENTION_SCRIPT: RETENTION_SCRIPT };
    for (const [key, value] of Object.entries(env)) {
      const previous = process.env[key];
      t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
      process.env[key] = value;
    }
    try {
      const { home, cwd, sessionId, old, others } = classicFixture(scratch);
      const inode = statSync(old).ino;
      const bytes = readFileSync(old);
      const outbound = runClassicCleanup(scratch, sessionId, { final: true });
      const { createPiWebRuntime } = await importPiWebRuntime();
      const runtimeDir = join(scratch.runtimeRoot, 'pi-web');
      const generation = 8;
      const runtime = createPiWebRuntime({ sessionId, generation, initialSurface: 'terminal', terminalMode: 'classic',
        home, cwd, runtimeDir, profileRestored: () => true, cloneRestored: () => false });
      await runtime.initialize();
      const owner = JSON.parse(readFileSync(join(runtimeDir, 'owner.json'), 'utf8'));
      assert.ok(owner.terminalTicket);
      assert.deepEqual(owner.binding, { id: uuid(0), cwd, path: old });
      assert.deepEqual(outbound, [old, ...others.slice(-29)].sort());
      assert.equal(statSync(old).ino, inode);
      assert.deepEqual(readFileSync(old), bytes);
      // No live writer is launched in this test; report an already-quit fixture
      // so Host can close the watcher using its regular retirement path.
      writeFileSync(join(runtimeDir, 'terminal.json'), JSON.stringify({ ...owner.binding, generation,
        ticket: owner.terminalTicket, quit: true, idle: true, pid: process.pid, startTime: 'not-a-live-writer', instance: 'fixture' }));
      await runtime.close();
    } finally {
      scratch.cleanup();
    }
  });

  test('REQ-STOR-012: invalid or uncommitted Classic references never take a retention slot', async (t) => {
    for (const name of ['other session', 'Herdr', 'history only', 'malformed binding', 'binding symlink', 'binding ancestor symlink',
      'ambiguous transcript', 'header mismatch', 'wrong workspace', 'fork', 'transcript symlink']) {
      await t.test(name, () => {
        const scratch = makeScratch();
        try {
          const { sessionId, sessionDir, bindingFile, old, others } = classicFixture(scratch, {
            ...(name === 'wrong workspace' && { cwd: '/another/workspace' }),
            ...(name === 'header mismatch' && { sessionId: uuid(90) }),
            ...(name === 'fork' && { parentSession: uuid(91) }),
          });
          const bytes = readFileSync(old);
          const outside = join(scratch.dir, 'outside');
          if (name === 'history only') {
            rmSync(bindingFile);
            writeFileSync(join(dirname(bindingFile), 'pi-chat-history.json'), JSON.stringify([uuid(0)]));
          } else if (name === 'malformed binding') {
            writeFileSync(bindingFile, `${uuid(0)}\n${uuid(1)}\n`);
          } else if (name === 'binding symlink') {
            rmSync(bindingFile);
            writeFileSync(outside, `${uuid(0)}\n`);
            symlinkSync(outside, bindingFile);
          } else if (name === 'binding ancestor symlink') {
            rmSync(dirname(bindingFile), { recursive: true });
            mkdirSync(outside);
            writeFileSync(join(outside, 'agent-session-id'), `${uuid(0)}\n`);
            symlinkSync(outside, dirname(bindingFile));
          } else if (name === 'ambiguous transcript') {
            const duplicate = join(sessionDir, `duplicate_${uuid(0)}.jsonl`);
            writeFileSync(duplicate, bytes);
            setMtime(duplicate, 19_002);
          } else if (name === 'transcript symlink') {
            rmSync(old);
            writeFileSync(outside, bytes);
            symlinkSync(outside, old);
          }
          runClassicCleanup(scratch, name === 'other session' ? 'another123' : sessionId,
            { mode: name === 'Herdr' ? 'herdr' : 'classic' });
          const fallback = ['header mismatch', 'fork'].includes(name);
          assert.deepEqual(others.filter(existsSync), fallback ? others.slice(0, 30) : others.slice(-30));
          if (name === 'transcript symlink') assert.deepEqual(readFileSync(old), bytes);
          else assert.equal(existsSync(old), false);
        } finally {
          scratch.cleanup();
        }
      });
    }
  });

  test('AC3: malformed interior and trailing records do not hide a recoverable native timestamp', () => {
    const scratch = makeScratch();
    try {
      const claude = join(scratch.dir, '.claude', 'projects');
      const paths = [];
      for (let i = 0; i < 12; i++) {
        paths.push(writeClaude(claude, i, i, 30_000 + (11 - i), {
          malformedInterior: i === 11,
          malformedTail: i === 11,
        }));
      }

      const output = runRetention('claude', claude, scratch);

      assert.match(output, /mode=native/);
      assert.deepEqual(paths.filter(existsSync).map((p) => Number(basename(p).slice(24, 36))).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    } finally {
      scratch.cleanup();
    }
  });

  test('REQ-STOR-051 AC1: Pi deletes every conflict file and preserves canonical transcripts', () => {
    const scratch = makeScratch();
    try {
      const pi = join(scratch.dir, '.pi', 'agent', 'sessions');
      const canonical = writePi(pi, 1, 1, 50_000);
      const canonicalContent = readFileSync(canonical);
      const conflicts = [
        `${canonical}.conflict1`,
        join(dirname(canonical), 'tasks', `${basename(canonical)}.conflict2`),
        join(dirname(canonical), `2026-08-18T10-00-02Z_${uuid(2)}.jsonl.conflict-copy`),
      ];
      mkdirSync(dirname(conflicts[1]), { recursive: true });
      writeFileSync(conflicts[0], Buffer.from('divergent user content\n'));
      writeFileSync(conflicts[1], canonicalContent);
      symlinkSync(canonical, conflicts[2]);

      const output = runRetention('pi', pi, scratch);

      assert.match(output, /conflicts=3/);
      for (const path of conflicts) assert.equal(existsSync(path), false, `${path} must be deleted`);
      assert.equal(readFileSync(canonical, 'utf8'), canonicalContent.toString('utf8'));
    } finally {
      scratch.cleanup();
    }
  });

  test('AC4: every unsupported identity branch switches the entire agent to mtime retention', () => {
    const cases = [
      {
        label: 'Claude filename/session mismatch',
        agent: 'claude',
        write: (root, i) => writeClaude(root, i, 11 - i, 40_000 + i, i === 5 ? { sessionId: uuid(90) } : {}),
      },
      {
        label: 'Claude unsupported version',
        agent: 'claude',
        write: (root, i) => writeClaude(root, i, 11 - i, 40_000 + i, i === 5 ? { version: '2.2.0' } : {}),
      },
      {
        label: 'Claude sidechain marker',
        agent: 'claude',
        write: (root, i) => writeClaude(root, i, 11 - i, 40_000 + i, i === 5 ? { isSidechain: true } : {}),
      },
      {
        label: 'Claude missing native activity',
        agent: 'claude',
        write: (root, i) => writeClaude(root, i, 11 - i, 40_000 + i, i === 5 ? { omitTimestamps: true } : {}),
      },
      {
        label: 'Pi filename/header mismatch',
        agent: 'pi',
        write: (root, i) => writePi(root, i, 11 - i, 40_000 + i, i === 5 ? { sessionId: uuid(90) } : {}),
      },
      {
        label: 'Pi unsupported version',
        agent: 'pi',
        write: (root, i) => writePi(root, i, 11 - i, 40_000 + i, i === 5 ? { version: 4 } : {}),
      },
      {
        label: 'Pi non-session header',
        agent: 'pi',
        write: (root, i) => writePi(root, i, 11 - i, 40_000 + i, i === 5 ? { type: 'message' } : {}),
      },
      {
        label: 'Pi parent-session marker',
        agent: 'pi',
        write: (root, i) => writePi(root, i, 11 - i, 40_000 + i, i === 5 ? { parentSession: uuid(91) } : {}),
      },
    ];

    for (const testCase of cases) {
      const scratch = makeScratch();
      try {
        const root = testCase.agent === 'claude'
          ? join(scratch.dir, '.claude', 'projects')
          : join(scratch.dir, '.pi', 'agent', 'sessions');
        const paths = [];
        for (let i = 0; i < 12; i++) paths.push(testCase.write(root, i));

        const output = runRetention(testCase.agent, root, scratch);

        assert.match(output, /mode=mtime-fallback/, testCase.label);
        assert.deepEqual(paths.filter(existsSync).sort(), paths.slice(2).sort(), testCase.label);
      } finally {
        scratch.cleanup();
      }
    }
  });

  test('AC5: Claude subagents, Pi tasks, and Codex state are untouched', () => {
    const scratch = makeScratch();
    try {
      const claude = join(scratch.dir, '.claude', 'projects');
      const pi = join(scratch.dir, '.pi', 'agent', 'sessions');
      const subagents = join(claude, 'project', uuid(99), 'subagents');
      const tasks = join(pi, 'workspace', `${uuid(98)}`, 'tasks');
      const codex = join(scratch.dir, '.codex');
      mkdirSync(subagents, { recursive: true });
      mkdirSync(tasks, { recursive: true });
      mkdirSync(codex, { recursive: true });
      const subagent = join(subagents, 'agent-child.jsonl');
      const task = join(tasks, 'task-child.jsonl');
      const codexState = join(codex, 'thread_history_1.sqlite');
      const outside = join(scratch.dir, `${uuid(97)}.jsonl`);
      const linkedCandidate = join(claude, `${uuid(96)}.jsonl`);
      writeFileSync(subagent, '{not a main transcript}\n');
      writeFileSync(task, '{not a main transcript}\n');
      writeFileSync(codexState, 'codex-state');
      writeFileSync(outside, 'outside-root');
      symlinkSync(outside, linkedCandidate);
      for (let i = 0; i < 12; i++) {
        writeClaude(claude, i, i, 50_000 + i);
        writePi(pi, i, i, 60_000 + i);
      }

      runRetention('claude', claude, scratch);
      runRetention('pi', pi, scratch);

      assert.equal(readFileSync(subagent, 'utf8'), '{not a main transcript}\n');
      assert.equal(readFileSync(task, 'utf8'), '{not a main transcript}\n');
      assert.equal(readFileSync(codexState, 'utf8'), 'codex-state');
      assert.equal(readFileSync(outside, 'utf8'), 'outside-root');
      assert.ok(existsSync(linkedCandidate), 'candidate symlink must be ignored, not followed or deleted');
    } finally {
      scratch.cleanup();
    }
  });

  test('REQ-STOR-012 AC1/AC5: a symlinked transcript-root ancestor cannot prune another directory', () => {
    const scratch = makeScratch();
    try {
      for (const agent of ['claude', 'pi']) {
        const outside = join(scratch.dir, `${agent}-other-data`);
        const rootName = agent === 'claude' ? 'projects' : 'sessions';
        const target = join(outside, rootName);
        const home = join(scratch.dir, `${agent}-home`);
        mkdirSync(target, { recursive: true });
        mkdirSync(home, { recursive: true });
        const linkedParent = join(home, 'agent-config');
        symlinkSync(outside, linkedParent);
        const paths = Array.from({ length: 12 }, (_, index) => (agent === 'claude' ? writeClaude : writePi)(target, index, index, 50_000 + index));
        if (agent === 'pi') {
          const conflict = join(target, 'retained.conflict.jsonl');
          writeFileSync(conflict, 'unrelated conflict data');
          paths.push(conflict);
        }
        const contents = paths.map(path => readFileSync(path, 'utf8'));
        runRetention(agent, join(linkedParent, rootName), scratch);
        assert.deepEqual(paths.map(path => existsSync(path) ? readFileSync(path, 'utf8') : null), contents);
      }
    } finally {
      scratch.cleanup();
    }
  });

  test('AC6: ten or fewer transcripts are retained without parsing or deletion', () => {
    const scratch = makeScratch();
    try {
      const claude = join(scratch.dir, '.claude', 'projects');
      mkdirSync(claude, { recursive: true });
      for (let i = 0; i < 10; i++) writeFileSync(join(claude, `unknown ${i}.jsonl`), '{future schema}\n');

      const output = runRetention('claude', claude, scratch);

      assert.equal(transcriptNames(claude).length, 10);
      assert.equal(output, '');
    } finally {
      scratch.cleanup();
    }
  });

  test('AC7: equal native timestamps use the path as a stable tie-breaker', () => {
    const scratch = makeScratch();
    try {
      const claude = join(scratch.dir, '.claude', 'projects');
      const paths = [];
      for (let i = 0; i < 12; i++) paths.push(writeClaude(claude, i, 1, 70_000 + i));

      runRetention('claude', claude, scratch);

      const expected = [...paths].sort((a, b) => (a === b ? 0 : a > b ? -1 : 1)).slice(0, 10).sort();
      assert.deepEqual(paths.filter(existsSync).sort(), expected);
    } finally {
      scratch.cleanup();
    }
  });
});
