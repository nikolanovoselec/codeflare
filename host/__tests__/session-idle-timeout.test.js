import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { Session } = await import('../dist/session.js');
const MAX_IDLE_MS = 12 * 60 * 60 * 1000;

describe('REQ-SESSION-004 AC4: PTY safety net respects the maximum idle preset', () => {
  for (const configured of [undefined, 60_000, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`keeps a disconnected PTY alive for twelve hours with configured safety ${configured}`, t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const session = new Session('idle-test-1', 'Terminal', { ptyKeepaliveMs: configured });
      let alive = true;
      session.ptyProcess = { pid: 123, process: 'bash', resize() {}, write() {}, kill() { alive = false; } };
      const ws = { readyState: 1, send() {}, close() {} };
      session.clients.add(ws);
      session.detach(ws);
      t.mock.timers.tick(MAX_IDLE_MS - 1);
      assert.equal(alive, true);
      assert.equal(session.isPtyAlive(), true);
      t.mock.timers.tick(1);
      assert.equal(alive, false);
      assert.equal(session.isPtyAlive(), false);
      t.mock.timers.reset();
    });
  }
});
