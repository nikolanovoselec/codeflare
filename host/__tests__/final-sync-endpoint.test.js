// Behavioral + structural coverage of the awaited final-sync path for
// REQ-SESSION-011 (final R2 sync is drained while the container is still alive,
// before stop).
//
// The completion-detection state machine is extracted into the pure
// host/src/final-sync.ts module and exercised here against the COMPILED
// ../dist/final-sync.js with real status sequences - this is the behavioral
// verification of AC2/AC3 (the syncing->success/failed discrimination, and
// the safety property that an in-flight bisync is never latched onto).
//
// The shell-side signal (entrypoint's `ts` stamp + the daemon's `syncing`
// emission) and the endpoint's I/O wiring (SIGUSR1, 503/504) cannot be unit
// imported in CI without spawning bash / the full http server, so they are
// verified structurally against the source at the bottom of this file. The
// DO-side ordering (drain before stop, 135s cap, best-effort) is covered in
// src/__tests__/container/index.test.ts and src/__tests__/container-metrics.test.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateFinalSync } from '../dist/final-sync.js';

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

// ---------------------------------------------------------------------------
// Structural verification of the parts that cannot be unit-imported in CI: the
// endpoint's I/O wiring (in the monolithic http handler) and the shell-side
// completion signal (entrypoint.sh). Source-text assertions, not behavioral.
// ---------------------------------------------------------------------------
const server = readFileSync(resolve(repoRoot, 'host/src/server.ts'), 'utf8');
const entrypoint = readFileSync(resolve(repoRoot, 'entrypoint.sh'), 'utf8');
// Read the DO drain budget from its source of truth so the host>DO ordering
// guard below compares the two REAL constants — never a hardcoded comparator
// that goes stale (and silently re-inverts) if the budget is later raised.
const containerMetrics = readFileSync(resolve(repoRoot, 'src/container/container-metrics.ts'), 'utf8');

describe('REQ-SESSION-011 AC2: final-sync endpoint wiring (structural)', () => {
  const idx = server.indexOf("'/internal/final-sync'");
  const block = server.slice(idx, idx + 2000);

  it('exposes POST /internal/final-sync', () => {
    assert.ok(/pathname === '\/internal\/final-sync' && method === 'POST'/.test(server));
  });

  it('triggers a fresh bisync via SIGUSR1 to the daemon PID file', () => {
    assert.ok(block.includes('/tmp/sync-daemon.pid'));
    assert.ok(block.includes('SIGUSR1'));
  });

  it('503s when no daemon is running, delegates completion to evaluateFinalSync, and 504s on timeout', () => {
    assert.ok(block.includes('503') && block.includes('daemon-not-running'));
    assert.ok(block.includes('evaluateFinalSync'), 'the handler must use the pure completion detector');
    assert.ok(block.includes('504') && block.includes('timeout'));
    const m = block.match(/INTERNAL_TIMEOUT_MS\s*=\s*([\d_]+)/);
    assert.ok(m, 'handler must define INTERNAL_TIMEOUT_MS');
    const bm = containerMetrics.match(/FINAL_SYNC_BUDGET_MS\s*=\s*([\d_]+)/);
    assert.ok(bm, 'container-metrics must define FINAL_SYNC_BUDGET_MS');
    const hostCap = Number(m[1].replace(/_/g, ''));
    const doBudget = Number(bm[1].replace(/_/g, ''));
    // Regression guard for the bisync-on-delete data loss. The host loop MUST
    // give up AFTER the DO's drain budget, never before: a host ceiling below the
    // budget (the old 115_000) 504s while rclone is still flushing, the DO records
    // 'incomplete', and the session deletes with the last edits lost. The DO's
    // AbortSignal(budget) is the authoritative ceiling; keep host > DO. Comparing
    // the two REAL constants (not a literal 120_000) means raising the DO budget
    // without raising the host cap in lockstep fails this test instead of silently
    // re-inverting — the exact failure mode behind ~10 prior "raise the budget" fixes.
    assert.ok(hostCap > doBudget, `host INTERNAL_TIMEOUT_MS (${hostCap}) must EXCEED the DO FINAL_SYNC_BUDGET_MS (${doBudget}) so the DO AbortSignal, not the host loop, is the ceiling; otherwise final bisync 504s prematurely on delete`);
  });
});

describe('REQ-SESSION-011 AC3: entrypoint completion signal (structural)', () => {
  it('update_sync_status stamps a monotonic epoch-ms ts', () => {
    const i = entrypoint.indexOf('update_sync_status()');
    assert.ok(i !== -1);
    assert.ok(/ts:\s*\(now \* 1000 \| floor\)/.test(entrypoint.slice(i, i + 1200)));
  });

  it('the daemon emits syncing immediately before each bisync run', () => {
    const i = entrypoint.indexOf('Starting background bisync daemon');
    assert.ok(i !== -1);
    assert.ok(/update_sync_status "syncing"/.test(entrypoint.slice(i, i + 4000)));
  });
});
