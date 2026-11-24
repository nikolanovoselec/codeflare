// Behavioral coverage of the awaited final-sync path for
// REQ-SESSION-011 (final R2 sync is drained while the container is still alive,
// before stop).
//
// The completion-detection state machine is extracted into the pure
// host/src/final-sync.ts module and exercised here against the COMPILED
// ../dist/final-sync.js with real status sequences - this is the behavioral
// verification of AC2/AC3 (the syncing->success/failed discrimination, and
// the safety property that an in-flight bisync is never latched onto).
//
// The shell-side status writer and HTTP endpoint are exercised through real
// bash processes and an ephemeral HTTP server below. The DO-side ordering
// (drain before stop, 135s cap, best-effort) is covered in
// src/__tests__/container/index.test.ts and src/__tests__/container-metrics.test.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const runtimeFixture = mkdtempSync('/tmp/codeflare-final-sync-');
process.env.CODEFLARE_RUNTIME_ROOT = runtimeFixture;
const { evaluateFinalSync } = await import('../dist/final-sync.js');
const { createRequestHandler, FINAL_SYNC_INTERNAL_TIMEOUT_MS } = await import('../dist/request-router.js');
const { SYNC_DAEMON_PID_FILE, SYNC_STATUS_FILE } = await import('../dist/runtime-paths.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const TRIGGER = 1_000_000;

describe('REQ-SESSION-011 AC2/AC3: evaluateFinalSync completion detection (behavioral)', () => {
  it('stays pending and unarmed while an in-flight bisync (syncing ts < trigger) is observed', () => {
    const ev = evaluateFinalSync({ status: 'syncing', ts: TRIGGER - 5000 }, TRIGGER, -1);
    assert.equal(ev.result, 'pending');
    assert.equal(ev.runStartedTs, -1, 'a syncing stamped before the trigger must NOT arm our run');
  });

  it('SAFETY: ignores a bare success (no qualifying syncing observed) even when its ts > trigger', () => {
    // This is the load-bearing property: an in-flight run that finishes AFTER
    // the trigger writes success with ts > trigger, but its filesystem scan
    // predated the trigger. Accepting it could miss the user's last edits, so
    // it must be ignored until we have seen OUR run's syncing.
    const ev = evaluateFinalSync({ status: 'success', ts: TRIGGER + 5000 }, TRIGGER, -1);
    assert.equal(ev.result, 'pending');
    assert.equal(ev.runStartedTs, -1);
  });

  it('SAFETY: a syncing stamped in the SAME ms as the trigger does NOT arm (strict >, not >=)', () => {
    // An in-flight run that stamped syncing in the same epoch-ms as the trigger
    // (or whose pre-trigger stamp lands at == trigger under a clock step-back)
    // must not be latched onto - its scan predates the trigger. Pins the strict
    // comparison: flipping > back to >= turns this green->red.
    const ev = evaluateFinalSync({ status: 'syncing', ts: TRIGGER }, TRIGGER, -1);
    assert.equal(ev.result, 'pending');
    assert.equal(ev.runStartedTs, -1, 'equal-ts syncing must not arm our run');
  });

  it('arms runStartedTs when our run starts (syncing ts strictly > trigger)', () => {
    const ev = evaluateFinalSync({ status: 'syncing', ts: TRIGGER + 1 }, TRIGGER, -1);
    assert.equal(ev.result, 'pending');
    assert.equal(ev.runStartedTs, TRIGGER + 1, 'our syncing must arm runStartedTs to its ts');
  });

  it('resolves success on our run reaching success with a newer ts', () => {
    const runStartedTs = TRIGGER + 10;
    const ev = evaluateFinalSync({ status: 'success', ts: runStartedTs + 200 }, TRIGGER, runStartedTs);
    assert.equal(ev.result, 'success');
  });

  it('resolves failed on our run reaching failed with a newer ts', () => {
    const runStartedTs = TRIGGER + 10;
    const ev = evaluateFinalSync({ status: 'failed', ts: runStartedTs + 200 }, TRIGGER, runStartedTs);
    assert.equal(ev.result, 'failed');
  });

  it('ignores a stale terminal status (ts <= runStartedTs) once armed', () => {
    const runStartedTs = TRIGGER + 10;
    const ev = evaluateFinalSync({ status: 'success', ts: runStartedTs }, TRIGGER, runStartedTs);
    assert.equal(ev.result, 'pending', 'a success not newer than our syncing is a stale read, not our completion');
  });

  it('full sequence: in-flight syncing + in-flight success are skipped, then our run is accepted', () => {
    // Replays the exact race the reviewer flagged: a cadence bisync is mid-flight
    // when the trigger fires, so its SIGUSR1 is coalesced into a deferred rerun.
    // The in-flight run must never satisfy the endpoint; only our rerun does.
    let runStartedTs = -1;
    const feed = (s) => {
      const ev = evaluateFinalSync(s, TRIGGER, runStartedTs);
      runStartedTs = ev.runStartedTs;
      return ev.result;
    };
    assert.equal(feed({ status: 'syncing', ts: TRIGGER - 3000 }), 'pending'); // in-flight run started
    assert.equal(feed({ status: 'success', ts: TRIGGER + 50 }), 'pending');   // in-flight finished after trigger - ignored
    assert.equal(runStartedTs, -1, 'must still be unarmed after the in-flight run completes');
    assert.equal(feed({ status: 'syncing', ts: TRIGGER + 100 }), 'pending');  // our deferred rerun starts
    assert.equal(runStartedTs, TRIGGER + 100);
    assert.equal(feed({ status: 'success', ts: TRIGGER + 900 }), 'success');  // our rerun completes
  });
});

const PID_FILE = SYNC_DAEMON_PID_FILE;
const STATUS_FILE = SYNC_STATUS_FILE;
const STATUS_TEMP_FILE = `${runtimeFixture}/sync-status.final-sync-test.tmp`;
mkdirSync(dirname(PID_FILE), { recursive: true });

function requestRouterDeps(overrides = {}) {
  return {
    sessionManager: { size: 0, list: () => [], getOrCreate: () => null, delete: () => false },
    wsEventLog: [],
    activityTracker: { recordHeartbeat: () => {}, recordInput: () => {}, getActivityInfo: () => ({}) },
    log: () => {},
    serverStartTime: Date.now(),
    readiness: () => ({ prewarmReady: true, initFlagObserved: true, terminalServiceReady: true }),
    silverbullet: { host: '127.0.0.1', port: 1 },
    openvscode: { host: '127.0.0.1', port: 1 },
    ...overrides,
  };
}

async function withRouter(overrides, run) {
  const server = http.createServer(createRequestHandler(requestRouterDeps(overrides)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await run(server.address().port);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function postFinalSync(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/internal/final-sync',
      method: 'POST',
      headers: { authorization: 'Bearer final-sync-test-token', ...headers },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

it('reports a disk-space blocker promptly without signaling or clearing it', async () => {
  const oldToken = process.env.CONTAINER_AUTH_TOKEN;
  process.env.CONTAINER_AUTH_TOKEN = 'final-sync-test-token';
  const marker = `${runtimeFixture}/sync/disk-space-blocked`;
  writeFileSync(marker, 'blocked');
  let signaled = false;
  try {
    await withRouter({ finalSync: {
      now: () => TRIGGER,
      readStatus: () => ({ status: 'failed' }),
      signalDaemon: () => { signaled = true; },
      poll: async () => { throw new Error('must not wait for a known blocker'); },
    } }, async (port) => {
      const response = await postFinalSync(port);
      assert.equal(response.status, 409);
      assert.deepEqual(response.body, { synced: false, reason: 'disk-space-blocked' });
    });
    assert.equal(signaled, false);
    assert.equal(readFileSync(marker, 'utf8'), 'blocked');
  } finally {
    rmSync(marker, { force: true });
    if (oldToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
    else process.env.CONTAINER_AUTH_TOKEN = oldToken;
  }
});

function finalSyncHarness(statuses, pollAdvanceMs = 1, signalError = false) {
  let now = TRIGGER;
  let readIndex = 0;
  let signalCount = 0;
  const pollDelays = [];
  return {
    runtime: {
      now: () => now,
      readStatus: () => statuses[readIndex++] ?? statuses.at(-1) ?? {},
      signalDaemon: () => {
        signalCount += 1;
        if (signalError) throw new Error('daemon unavailable');
      },
      poll: async (delayMs) => {
        pollDelays.push(delayMs);
        now += pollAdvanceMs;
      },
    },
    signalCount: () => signalCount,
    pollDelays,
  };
}

async function startProductionStatusDaemon() {
  const script = `
    write_status() {
      now=$(date +%s%3N)
      printf '{"status":"%s","ts":%s}\\n' "$1" "$now" > ${STATUS_TEMP_FILE}
      mv ${STATUS_TEMP_FILE} ${STATUS_FILE}
    }
    on_usr1() {
      printf 'SIGUSR1\\n'
      sleep 0.02
      write_status syncing
      (sleep 0.65; write_status success) &
    }
    trap on_usr1 USR1
    printf 'READY\\n'
    while :; do sleep 0.05; done
  `;
  const child = spawn('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    await new Promise((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error(`status daemon startup timed out: ${stderr}`)), 2_000);
      const onData = () => {
        if (!output.includes('READY\n')) return;
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        resolveReady();
      };
      child.stdout.on('data', onData);
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        rejectReady(new Error(`status daemon exited before ready (${code ?? signal}): ${stderr}`));
      });
    });
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }

  writeFileSync(PID_FILE, String(child.pid));
  return { child, output: () => output };
}

async function stopStatusDaemon(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveExit) => {
    const timeout = setTimeout(resolveExit, 1_000);
    timeout.unref();
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveExit();
    });
    child.kill('SIGKILL');
  });
}

function extractShellFunction(name) {
  const entrypoint = readFileSync(resolve(repoRoot, 'entrypoint.sh'), 'utf8');
  const lines = entrypoint.split('\n');
  const start = lines.findIndex((line) => line === `${name}() {`);
  const end = lines.findIndex((line, index) => index > start && line === '}');
  assert.ok(start >= 0 && end > start, `${name}() is missing from entrypoint.sh`);
  return lines.slice(start, end + 1).join('\n');
}

function cleanupSyncFixtures() {
  rmSync(PID_FILE, { force: true });
  rmSync(STATUS_FILE, { force: true });
  rmSync(STATUS_TEMP_FILE, { force: true });
}

describe('REQ-SESSION-043: authenticated final sync observes the launch outcome', () => {
  for (const { name, marker, ready, daemon = ready, runtime = true, diskBlocked, diskBlockedDuringDrain,
    diskBlockedAfterDispatch, pendingSync, status, reason } of [
    { name: 'disabled after request', marker: 'sessionaaa1:7\n', status: 409, reason: 'hermes-disabled-at-startup' },
    { name: 'disabled without merge runtime', marker: 'sessionaaa1:7\n', runtime: false, status: 409, reason: 'hermes-disabled-at-startup' },
    { name: 'disabled with blocked disk', marker: 'sessionaaa1:7\n', diskBlocked: true, status: 409, reason: 'hermes-disabled-at-startup' },
    { name: 'wrong generation', marker: 'sessionaaa1:6\n', status: 503, reason: 'hermes-save-not-started' },
    { name: 'no startup outcome', status: 503, reason: 'hermes-save-not-started' },
    { name: 'opened without a ready daemon', ready: true, daemon: false, status: 503, reason: 'hermes-save-not-started' },
    { name: 'pending startup with blocked disk', diskBlocked: true, status: 409, reason: 'disk-space-blocked' },
    { name: 'disk blocked during Pi drain', ready: true, diskBlockedDuringDrain: true, status: 409, reason: 'disk-space-blocked' },
    { name: 'disk blocked after sync dispatch', ready: true, diskBlockedAfterDispatch: true, status: 409, reason: 'disk-space-blocked' },
    { name: 'sync dispatched but outcome unknown', ready: true, pendingSync: true, status: 504, reason: 'timeout' },
    { name: 'opened without merge runtime', ready: true, runtime: false, status: 503, reason: 'hermes-merge-unavailable' },
    { name: 'opened with blocked disk', ready: true, diskBlocked: true, status: 409, reason: 'disk-space-blocked' },
    { name: 'opened before daemon readiness', ready: true, status: 200 },
  ]) it(name, async () => {
    const settings = { CONTAINER_AUTH_TOKEN: 'final-sync-test-token', SESSION_ID: 'sessionaaa1',
      CODEFLARE_HERMES_GENERATION: '7', CODEFLARE_HERMES_PERSISTENCE: 'new', ENTERPRISE_MODE: 'active', SESSION_MODE: 'advanced' };
    const old = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
    Object.assign(process.env, settings);
    const disabledPath = `${runtimeFixture}/sync/hermes-disabled-at-startup`;
    const readyPath = `${runtimeFixture}/sync/hermes-ready`;
    const diskPath = `${runtimeFixture}/sync/disk-space-blocked`;
    let now = TRIGGER;
    let signalAt;
    let drainedAt;
    try {
      if (diskBlocked) {
        writeFileSync(diskPath, 'blocked');
        if (marker) writeFileSync(disabledPath, marker);
        if (ready) writeFileSync(readyPath, 'direct:sessionaaa1\n');
      }
      await withRouter({ hermesShutdown: runtime ? { saved: async () => 'a'.repeat(64) } : undefined,
        prepareFinalSync: async deadline => {
          assert.equal(deadline, TRIGGER + FINAL_SYNC_INTERNAL_TIMEOUT_MS);
          drainedAt = now;
          if (diskBlockedDuringDrain) {
            writeFileSync(diskPath, 'blocked');
            return { status: 'unconfirmed' };
          }
          return { status: 'exited', count: 0 };
        },
        sessionManager: { quiesceForHermesMerge() {} },
        finalSync: {
          now: () => now,
          signalDaemon: () => {
            if (!existsSync(PID_FILE)) throw new Error('daemon not ready');
            signalAt = now;
          },
          readStatus: () => ({ status: pendingSync || now === signalAt ? 'syncing' : 'success', ts: now + 1 }),
          poll: async () => {
            if (now === TRIGGER) {
              if (marker) writeFileSync(disabledPath, marker);
              if (ready) writeFileSync(readyPath, 'direct:sessionaaa1\n');
            }
            if (daemon && now === TRIGGER + 1_000) writeFileSync(PID_FILE, String(process.pid));
            if (diskBlockedAfterDispatch && signalAt !== undefined) writeFileSync(diskPath, 'blocked');
            now += 1_000;
          },
        },
      }, async port => {
        const response = await postFinalSync(port, { 'x-codeflare-hermes-merge': '1' });
        assert.equal(response.status, status);
        if (reason === 'hermes-disabled-at-startup') assert.deepEqual(response.body, { synced: false, reason, generation: 7 });
        else if (reason) assert.deepEqual(response.body, { synced: false, reason,
          ...(reason === 'disk-space-blocked' && (diskBlocked || diskBlockedDuringDrain) ? { syncDispatched: false } : {}),
        });
        else assert.deepEqual(response.body, { synced: true, snapshotId: 'a'.repeat(64) });
        assert.equal(drainedAt, status === 200 || pendingSync || diskBlockedDuringDrain || diskBlockedAfterDispatch ? TRIGGER + 2_000 : undefined);
        assert.equal(signalAt, diskBlockedDuringDrain ? undefined : drainedAt);
        if (diskBlocked) assert.equal(now, TRIGGER, 'known disk blockers must not wait for startup');
        if (reason === 'hermes-save-not-started') assert.ok(now < TRIGGER + 120_000, 'refuse before the Worker aborts');
      });
    } finally {
      for (const file of [disabledPath, readyPath, diskPath, PID_FILE]) rmSync(file, { force: true });
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('REQ-SESSION-011 AC2: final-sync HTTP boundary (behavioral)', () => {
  it('REQ-SESSION-011 AC2: returns 503 when no daemon is running', async () => {
    const savedToken = process.env.CONTAINER_AUTH_TOKEN;
    process.env.CONTAINER_AUTH_TOKEN = 'final-sync-test-token';
    const harness = finalSyncHarness([], 1, true);
    try {
      const response = await withRouter({ finalSync: harness.runtime }, postFinalSync);
      assert.equal(response.status, 503);
      assert.deepEqual(response.body, { synced: false, reason: 'daemon-not-running' });
      assert.equal(harness.signalCount(), 1);
    } finally {
      if (savedToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
      else process.env.CONTAINER_AUTH_TOKEN = savedToken;
    }
  });

  it('REQ-SESSION-011 AC2: signals the daemon and waits for syncing-to-success before returning 200', async () => {
    const savedToken = process.env.CONTAINER_AUTH_TOKEN;
    process.env.CONTAINER_AUTH_TOKEN = 'final-sync-test-token';
    const harness = finalSyncHarness([
      { status: 'syncing', ts: TRIGGER + 1 },
      { status: 'success', ts: TRIGGER + 2 },
    ]);
    try {
      const response = await withRouter({ finalSync: harness.runtime }, postFinalSync);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { synced: true });
      assert.equal(harness.signalCount(), 1);
      assert.deepEqual(harness.pollDelays, [500]);
    } finally {
      if (savedToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
      else process.env.CONTAINER_AUTH_TOKEN = savedToken;
    }
  });

  it('REQ-SESSION-011 AC2: the production adapter reads the PID, delivers SIGUSR1, reads status, and returns 200', { timeout: 7_000 }, async () => {
    cleanupSyncFixtures();
    const savedToken = process.env.CONTAINER_AUTH_TOKEN;
    const realNow = Date.now;
    let daemon;
    process.env.CONTAINER_AUTH_TOKEN = 'final-sync-test-token';
    try {
      daemon = await startProductionStatusDaemon();
      const failFastAt = realNow() + 3_000;
      // Fail fast if the production path stops observing the daemon status instead
      // of waiting for its 125-second internal deadline.
      Date.now = () => realNow() + (realNow() >= failFastAt ? FINAL_SYNC_INTERNAL_TIMEOUT_MS + 1 : 0);
      const response = await withRouter({}, postFinalSync);

      assert.equal(readFileSync(PID_FILE, 'utf8'), String(daemon.child.pid));
      assert.match(daemon.output(), /(?:^|\n)SIGUSR1\n/);
      assert.equal(JSON.parse(readFileSync(STATUS_FILE, 'utf8')).status, 'success');
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { synced: true });
    } finally {
      Date.now = realNow;
      if (savedToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
      else process.env.CONTAINER_AUTH_TOKEN = savedToken;
      await stopStatusDaemon(daemon?.child);
      cleanupSyncFixtures();
    }
  });

  it('REQ-SESSION-011 AC2: maps failed to 500 and a nonterminal run to bounded 504', async () => {
    const savedToken = process.env.CONTAINER_AUTH_TOKEN;
    process.env.CONTAINER_AUTH_TOKEN = 'final-sync-test-token';
    const failedHarness = finalSyncHarness([
      { status: 'syncing', ts: TRIGGER + 1 },
      { status: 'failed', ts: TRIGGER + 2 },
    ]);
    const timeoutHarness = finalSyncHarness(
      [{ status: 'syncing', ts: TRIGGER + 1 }],
      FINAL_SYNC_INTERNAL_TIMEOUT_MS + 1,
    );
    try {
      const failed = await withRouter({ finalSync: failedHarness.runtime }, postFinalSync);
      assert.equal(failed.status, 500);
      assert.deepEqual(failed.body, { synced: false, reason: 'bisync-failed' });
      assert.equal(failedHarness.signalCount(), 1);

      const timedOut = await withRouter({ finalSync: timeoutHarness.runtime }, postFinalSync);
      assert.equal(timedOut.status, 504);
      assert.deepEqual(timedOut.body, { synced: false, reason: 'timeout' });
      assert.equal(timeoutHarness.signalCount(), 1);
      assert.deepEqual(timeoutHarness.pollDelays, [500]);
    } finally {
      if (savedToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
      else process.env.CONTAINER_AUTH_TOKEN = savedToken;
    }
  });

  it('REQ-SESSION-011 AC2: keeps the host timeout above the 120-second DO drain budget', () => {
    assert.ok(FINAL_SYNC_INTERNAL_TIMEOUT_MS > 120_000);
  });
});

describe('REQ-SESSION-011 AC3: entrypoint completion status (real shell behavior)', () => {
  it('REQ-SESSION-011 AC3: writes parseable status records with nondecreasing epoch-ms timestamps', () => {
    cleanupSyncFixtures();
    const body = extractShellFunction('update_sync_status');
    const result = spawnSync('bash', ['-c', [
      body,
      'USER_HOME=/home/user',
      'update_sync_status syncing null',
      `first=$(jq -r '.ts' ${STATUS_FILE})`,
      'sleep 0.01',
      'update_sync_status success null',
      `second=$(jq -r '.ts' ${STATUS_FILE})`,
      `jq -e '.status == "success" and .error == null and (.ts | type == "number")' ${STATUS_FILE} >/dev/null`,
      'test "$second" -ge "$first"',
      'printf "%s:%s\\n" "$first" "$second"',
    ].join('\n')], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^\d+:\d+\n$/);
    cleanupSyncFixtures();
  });
});

it('REQ-STOR-015: authenticated manual recovery uses SIGUSR2; ordinary triggers use SIGUSR1', async () => {
  const previousToken = process.env.CONTAINER_AUTH_TOKEN;
  process.env.CONTAINER_AUTH_TOKEN = 'final-sync-test-token';
  const child = spawn(process.execPath, ['-e', `
    process.on('SIGUSR1', () => console.log('AUTOMATIC'));
    process.on('SIGUSR2', () => console.log('RECOVERY'));
    console.log('READY');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const waitOutput = async (text) => {
    for (let i = 0; i < 100 && !output.includes(text); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(output.includes(text), `missing ${text}: ${output}`);
  };
  try {
    await waitOutput('READY');
    writeFileSync(PID_FILE, String(child.pid));
    await withRouter({}, async (port) => {
      const request = (headers) => new Promise((resolveResponse, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/internal/bisync-trigger', method: 'POST', headers }, (res) => {
          res.resume();
          res.on('end', () => resolveResponse(res.statusCode));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(await request({ authorization: 'Bearer wrong', 'x-codeflare-sync-recovery': 'retry' }), 401);
      assert.doesNotMatch(output, /RECOVERY/);
      assert.equal(await request({ authorization: 'Bearer final-sync-test-token' }), 202);
      await waitOutput('AUTOMATIC');
      assert.equal(await request({ authorization: 'Bearer final-sync-test-token', 'x-codeflare-sync-recovery': 'retry' }), 202);
      await waitOutput('RECOVERY');
    });
  } finally {
    await stopStatusDaemon(child);
    rmSync(PID_FILE, { force: true });
    if (previousToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
    else process.env.CONTAINER_AUTH_TOKEN = previousToken;
  }
});

// REQ-MEM-035 AC6: shutdown and final sync share the existing endpoint budget.
// Only the documented finalSync platform-I/O seam is simulated; requests go
// through a real HTTP server and the scan/upload artifacts are real files.

function memoryFinalSyncFixture(t) {
  const root = mkdtempSync(`${runtimeFixture}/memory-drain-`);
  const savedToken = process.env.CONTAINER_AUTH_TOKEN;
  process.env.CONTAINER_AUTH_TOKEN = 'final-sync-test-token';
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
    else process.env.CONTAINER_AUTH_TOKEN = savedToken;
  });
  const memory = `${root}/MEMORY.md`;
  const uploaded = `${root}/uploaded.md`;
  const prepared = `${root}/prepared`;
  const initial = '# Existing durable fact\n';
  writeFileSync(memory, initial);
  return { root, memory, uploaded, prepared, initial };
}

function memorySyncRequest(port, path = '/internal/final-sync', token = 'final-sync-test-token') {
  return new Promise((resolveResponse, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST',
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolveResponse({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('REQ-MEM-035 AC6: foreground shutdown before authoritative final sync', () => {
  it('REQ-MEM-035: AC7 awaits final Markdown and takes the sync trigger timestamp after preparation', async t => {
    const f = memoryFinalSyncFixture(t);
    const finalMarkdown = '# Last foreground capture\n\nUse metric units.\n';
    let now = TRIGGER;
    let scan = '';
    let index = 0;
    const statuses = [
      // This earlier run is newer than endpoint entry but older than preparation.
      { status: 'syncing', ts: TRIGGER + 1 },
      { status: 'success', ts: TRIGGER + 2 },
      { status: 'syncing', ts: TRIGGER + 1001 },
      { status: 'success', ts: TRIGGER + 1002 },
    ];
    const response = await withRouter({
      prepareFinalSync: async deadline => {
        assert.equal(deadline, TRIGGER + FINAL_SYNC_INTERNAL_TIMEOUT_MS);
        await new Promise(resolve => setImmediate(resolve));
        writeFileSync(f.memory, finalMarkdown);
        now += 1000;
        return { status: 'exited', count: 1 };
      },
      finalSync: {
        now: () => now,
        signalDaemon() { scan = readFileSync(f.memory, 'utf8'); },
        readStatus() {
          const status = statuses[index++] ?? statuses.at(-1);
          // An in-flight pre-shutdown success uploaded only the earlier snapshot.
          if (status.status === 'success') writeFileSync(f.uploaded,
            status.ts < TRIGGER + 1000 ? f.initial : scan);
          return status;
        },
        async poll() { now += 1; },
      },
    }, postFinalSync);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { synced: true });
    assert.equal(readFileSync(f.uploaded, 'utf8'), finalMarkdown,
      'success must describe the fresh scan after shutdown, not a pre-shutdown run');
  });

  for (const outcome of [
    { status: 'timeout', remaining: 1 },
    { status: 'unconfirmed' },
  ]) {
    it(`REQ-MEM-035: AC7 ${outcome.status} shutdown still uploads existing data but cannot report capture success`, async t => {
      const f = memoryFinalSyncFixture(t);
      let now = TRIGGER, index = 0;
      const response = await withRouter({
        prepareFinalSync: async () => {
          await new Promise(resolve => setImmediate(resolve));
          writeFileSync(f.prepared, outcome.status);
          now += 200;
          return outcome;
        },
        finalSync: {
          now: () => now,
          signalDaemon() {
            // Files emulate the external daemon scan, not private call counts.
            writeFileSync(f.uploaded, readFileSync(f.memory, 'utf8'));
            writeFileSync(`${f.root}/scan-state`, readFileSync(f.prepared, 'utf8'));
          },
          readStatus: () => ++index === 1
            ? { status: 'syncing', ts: TRIGGER + 201 }
            : { status: 'success', ts: TRIGGER + 202 },
          async poll() { now += 1; },
        },
      }, postFinalSync);
      assert.ok(response.status >= 400 && response.status < 600, 'shutdown uncertainty is not HTTP success');
      assert.equal(response.body.reason, `pi-shutdown-${outcome.status}`);
      assert.equal(readFileSync(f.uploaded, 'utf8'), f.initial, 'already-written data is still synced');
      assert.equal(readFileSync(`${f.root}/scan-state`, 'utf8'), outcome.status);
    });
  }

  it('REQ-MEM-035: AC7 preparation does not restart the existing overall final-sync deadline', async t => {
    const f = memoryFinalSyncFixture(t);
    let now = TRIGGER;
    const deadline = TRIGGER + FINAL_SYNC_INTERNAL_TIMEOUT_MS;
    const response = await withRouter({
      prepareFinalSync: async suppliedDeadline => {
        assert.equal(suppliedDeadline, deadline);
        now = deadline - 700;
        writeFileSync(f.prepared, 'drained');
        return { status: 'exited', count: 1 };
      },
      finalSync: {
        now: () => now,
        signalDaemon() { writeFileSync(f.uploaded, readFileSync(f.memory, 'utf8')); },
        readStatus: () => ({ status: 'syncing', ts: deadline - 699 }),
        async poll(milliseconds) { now += milliseconds; },
      },
    }, postFinalSync);
    assert.equal(response.status, 504);
    assert.deepEqual(response.body, { synced: false, reason: 'timeout' });
    assert.equal(readFileSync(f.prepared, 'utf8'), 'drained');
    assert.equal(readFileSync(f.uploaded, 'utf8'), f.initial);
    assert.ok(now <= deadline + 500, 'shutdown and polling share the original budget (one poll tolerance)');
  });

  it('REQ-MEM-035: AC7 rejects unauthorized and restricted-operator shutdown before preparation or sync', async t => {
    const f = memoryFinalSyncFixture(t);
    const effects = {
      prepareFinalSync: async () => {
        writeFileSync(f.prepared, 'UNAUTHORIZED SHUTDOWN');
        return { status: 'exited', count: 1 };
      },
      finalSync: {
        now: () => TRIGGER,
        signalDaemon() { writeFileSync(f.uploaded, 'UNAUTHORIZED SYNC'); },
        readStatus: () => ({ status: 'failed', ts: TRIGGER + 1 }),
        async poll() { throw new Error('a denied request must not enter sync polling'); },
      },
    };
    const unauthorized = await withRouter(effects, port => memorySyncRequest(port, '/internal/final-sync', 'wrong'));
    assert.equal(unauthorized.status, 401);
    assert.equal(readFileSync(f.memory, 'utf8'), f.initial);
    assert.equal(existsSync(f.prepared), false);
    assert.equal(existsSync(f.uploaded), false);
    const restricted = await withRouter({ ...effects, operatorSync: { async handle() { return null; } } }, postFinalSync);
    assert.equal(restricted.status, 403);
    assert.equal(restricted.body.code, 'OPERATOR_BISYNC_DENIED');
    assert.equal(existsSync(f.prepared), false);
    assert.equal(existsSync(f.uploaded), false);
  });

  it('REQ-MEM-035: AC7 authenticated manual sync still signals its daemon without preparing Pi shutdown', { timeout: 7000 }, async t => {
    const f = memoryFinalSyncFixture(t);
    cleanupSyncFixtures();
    const signalFile = `${f.root}/daemon-signal`;
    const daemon = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      process.on('SIGUSR1', () => {
        const temporary = process.argv[1] + '.tmp';
        fs.writeFileSync(temporary, 'SIGUSR1');
        fs.renameSync(temporary, process.argv[1]);
      });
      setInterval(() => {}, 1000);
      process.send('READY');
    `, signalFile], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let ready = false, startupError;
    daemon.on('message', () => { ready = true; });
    daemon.on('error', error => { startupError = error; });
    try {
      for (let n = 0; n < 100 && !ready && !startupError; n++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ifError(startupError);
      assert.equal(ready, true, 'fixture daemon must be ready to receive SIGUSR1');
      writeFileSync(PID_FILE, String(daemon.pid));
      const response = await withRouter({ prepareFinalSync: async () => {
        writeFileSync(f.prepared, 'UNEXPECTED MANUAL SHUTDOWN');
        return { status: 'exited', count: 1 };
      } }, port => memorySyncRequest(port, '/internal/bisync-trigger'));
      assert.equal(response.status, 202);
      assert.deepEqual(response.body, { status: 'triggered' });
      for (let n = 0; n < 100 && !existsSync(signalFile); n++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(readFileSync(signalFile, 'utf8'), 'SIGUSR1');
      assert.equal(existsSync(f.prepared), false,
        'manual sync must not terminate foreground Pi sessions');
      assert.equal(readFileSync(f.memory, 'utf8'), f.initial);
    } finally {
      await stopStatusDaemon(daemon);
      cleanupSyncFixtures();
    }
  });
});
