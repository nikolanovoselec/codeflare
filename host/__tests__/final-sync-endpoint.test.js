// Structural audit of the awaited final-sync path for REQ-SESSION-011
// (final R2 sync is drained while the container is still alive, before stop).
//
// SCOPE: Verifies the SHAPE of the host server's POST /internal/final-sync
// handler and the entrypoint signalling it depends on (the monotonic `ts`
// stamp and the daemon's `syncing` emission). The DO-side ordering (drain
// before stop, 135s hard-cap, best-effort) is exercised behaviorally in
// src/__tests__/container/index.test.ts and src/__tests__/container-metrics.test.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const server = readFileSync(resolve(repoRoot, 'host/src/server.ts'), 'utf8');
const entrypoint = readFileSync(resolve(repoRoot, 'entrypoint.sh'), 'utf8');

describe('REQ-SESSION-011: awaited final-sync endpoint + completion signal', () => {
  it('AC2: server exposes POST /internal/final-sync', () => {
    assert.ok(
      /pathname === '\/internal\/final-sync' && method === 'POST'/.test(server),
      'server.ts must handle POST /internal/final-sync'
    );
  });

  it('AC2: the handler triggers a fresh bisync via SIGUSR1 to the sync daemon PID file', () => {
    const idx = server.indexOf("'/internal/final-sync'");
    const block = server.slice(idx, idx + 2000);
    assert.ok(
      block.includes('/tmp/sync-daemon.pid'),
      'final-sync handler must read the daemon PID from /tmp/sync-daemon.pid'
    );
    assert.ok(
      block.includes("'SIGUSR1'") || block.includes('SIGUSR1'),
      'final-sync handler must send SIGUSR1 to trigger the bisync (same path as /internal/bisync-trigger)'
    );
  });

  it('AC2: returns 503 when no daemon is running (caller proceeds to stop)', () => {
    const idx = server.indexOf("'/internal/final-sync'");
    const block = server.slice(idx, idx + 2000);
    assert.ok(
      block.includes('503') && block.includes('daemon-not-running'),
      'final-sync handler must 503 with daemon-not-running when the daemon PID is unavailable'
    );
  });

  it('AC3: completion is detected via a two-phase syncing -> success/failed transition', () => {
    const idx = server.indexOf("'/internal/final-sync'");
    const block = server.slice(idx, idx + 2000);
    assert.ok(
      block.includes("=== 'syncing'"),
      'handler must wait for a syncing status (run started)'
    );
    assert.ok(
      block.includes("=== 'success'") && block.includes("=== 'failed'"),
      'handler must resolve on the triggered run reaching success or failed'
    );
    assert.ok(
      block.includes('runStartedTs') && block.includes('triggerTs'),
      'handler must compare the syncing ts against the trigger ts so an in-flight bisync is ignored'
    );
  });

  it('AC4/AC5: the internal poll budget is under the DO 120s sync budget, and times out to 504', () => {
    const idx = server.indexOf("'/internal/final-sync'");
    const block = server.slice(idx, idx + 2000);
    const m = block.match(/INTERNAL_TIMEOUT_MS\s*=\s*([\d_]+)/);
    assert.ok(m, 'handler must define INTERNAL_TIMEOUT_MS');
    const budget = Number(m[1].replace(/_/g, ''));
    assert.ok(budget < 120_000, `INTERNAL_TIMEOUT_MS (${budget}) must be under the DO 120s budget`);
    assert.ok(
      block.includes('504') && block.includes('timeout'),
      'handler must 504 with timeout when the bisync does not finish within the budget'
    );
  });

  it('AC3: update_sync_status stamps a monotonic epoch-ms ts so the endpoint can order transitions', () => {
    const idx = entrypoint.indexOf('update_sync_status()');
    assert.ok(idx !== -1, 'entrypoint.sh must define update_sync_status');
    const block = entrypoint.slice(idx, idx + 1200);
    assert.ok(
      /ts:\s*\(now \* 1000 \| floor\)/.test(block),
      'update_sync_status must write ts as floor(now*1000) (epoch ms) into sync-status.json'
    );
  });

  it('AC3: the bisync daemon emits a syncing status before each run so the endpoint sees a fresh transition', () => {
    const idx = entrypoint.indexOf('Starting background bisync daemon');
    assert.ok(idx !== -1, 'entrypoint.sh must start the bisync daemon');
    const block = entrypoint.slice(idx, idx + 4000);
    assert.ok(
      /update_sync_status "syncing"/.test(block),
      'the daemon loop must mark status syncing before running bisync_with_r2'
    );
  });
});
