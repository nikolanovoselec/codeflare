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
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateFinalSync } from '../dist/final-sync.js';
import { createRequestHandler, FINAL_SYNC_INTERNAL_TIMEOUT_MS } from '../dist/request-router.js';

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

const PID_FILE = '/tmp/sync-daemon.pid';
const STATUS_FILE = '/tmp/sync-status.json';

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

function postFinalSync(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/internal/final-sync',
      method: 'POST',
      headers: { authorization: 'Bearer final-sync-test-token' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function startStatusDaemon(terminalStatus) {
  const terminalWrite = terminalStatus
    ? `sleep 0.03\n  now=$(date +%s%3N)\n  printf '{"status":"${terminalStatus}","ts":%s}\\n' "$now" > ${STATUS_FILE}`
    : ':';
  const script = [
    'on_usr1() {',
    '  sleep 0.03',
    '  now=$(date +%s%3N)',
    `  printf '{"status":"syncing","ts":%s}\\n' "$now" > ${STATUS_FILE}`,
    `  ${terminalWrite}`,
    '}',
    'trap on_usr1 USR1',
    'printf "READY\\n"',
    'while :; do sleep 1; done',
  ].join('\n');
  const child = spawn('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(child.stdout, 'data');
  writeFileSync(PID_FILE, String(child.pid));
  return child;
}

function extractShellFunction(name) {
  const entrypoint = readFileSync(resolve(repoRoot, 'entrypoint.sh'), 'utf8');
  const lines = entrypoint.split('\n');
  const start = lines.findIndex((line) => line === `${name}() {`);
  const end = lines.findIndex((line, index) => index > start && line === '}');
  assert.ok(start >= 0 && end > start, `${name}() is missing from entrypoint.sh`);
  return lines.slice(start, end + 1).join('\n');
}

function cleanupSyncFixtures(child) {
  if (child && !child.killed) child.kill('SIGKILL');
  rmSync(PID_FILE, { force: true });
  rmSync(STATUS_FILE, { force: true });
}

describe('REQ-SESSION-011 AC2: final-sync HTTP boundary (behavioral)', () => {
  it('REQ-SESSION-011 AC2: returns 503 when no daemon is running', async () => {
    cleanupSyncFixtures();
    const savedToken = process.env.CONTAINER_AUTH_TOKEN;
    process.env.CONTAINER_AUTH_TOKEN = 'final-sync-test-token';
    try {
      const response = await withRouter({}, postFinalSync);
      assert.equal(response.status, 503);
      assert.deepEqual(response.body, { synced: false, reason: 'daemon-not-running' });
    } finally {
      if (savedToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
      else process.env.CONTAINER_AUTH_TOKEN = savedToken;
      cleanupSyncFixtures();
    }
  });

  it('REQ-SESSION-011 AC2: signals the daemon and waits for syncing-to-success before returning 200', async () => {
    cleanupSyncFixtures();
    const savedToken = process.env.CONTAINER_AUTH_TOKEN;
    process.env.CONTAINER_AUTH_TOKEN = 'final-sync-test-token';
    const daemon = await startStatusDaemon('success');
    try {
      const response = await withRouter({}, postFinalSync);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { synced: true });
      assert.equal(JSON.parse(readFileSync(STATUS_FILE, 'utf8')).status, 'success');
    } finally {
      if (savedToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
      else process.env.CONTAINER_AUTH_TOKEN = savedToken;
      cleanupSyncFixtures(daemon);
    }
  });

  it('REQ-SESSION-011 AC2: maps failed to 500 and a nonterminal run to bounded 504', async () => {
    cleanupSyncFixtures();
    const savedToken = process.env.CONTAINER_AUTH_TOKEN;
    process.env.CONTAINER_AUTH_TOKEN = 'final-sync-test-token';
    let daemon = await startStatusDaemon('failed');
    try {
      const failed = await withRouter({}, postFinalSync);
      assert.equal(failed.status, 500);
      assert.deepEqual(failed.body, { synced: false, reason: 'bisync-failed' });
      cleanupSyncFixtures(daemon);

      daemon = await startStatusDaemon(null);
      const realNow = Date.now;
      let syntheticNow = realNow();
      Date.now = () => {
        syntheticNow += FINAL_SYNC_INTERNAL_TIMEOUT_MS + 1;
        return syntheticNow;
      };
      try {
        const timedOut = await withRouter({}, postFinalSync);
        assert.equal(timedOut.status, 504);
        assert.deepEqual(timedOut.body, { synced: false, reason: 'timeout' });
      } finally {
        Date.now = realNow;
      }
    } finally {
      if (savedToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN;
      else process.env.CONTAINER_AUTH_TOKEN = savedToken;
      cleanupSyncFixtures(daemon);
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
