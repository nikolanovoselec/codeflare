import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  HERDR_COMPLETION_DELAY_MS,
  HerdrCompletionDelay,
  HerdrAgentStatusMonitor,
  createHerdrAgentStatusCallbacks,
} from '../dist/herdr-agent-status.js';

class ManualScheduler {
  now = 0;
  nextId = 1;
  timers = new Map();

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  };

  clearTimeout = (id) => {
    this.timers.delete(id);
  };

  advanceBy(ms) {
    this.now += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at > this.now) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }
}

async function withSocket(handler, test) {
  const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-status-'));
  const socketPath = join(dir, 'herdr.sock');
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    await test(socketPath);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

async function expectResnapshot(trigger, options = {}) {
  let connection = 0;
  let resolveResnapshot;
  const resnapshot = new Promise((resolve) => { resolveResnapshot = resolve; });

  await withSocket((socket) => {
    connection += 1;
    const currentConnection = connection;
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      while (buffered.includes('\n')) {
        const newline = buffered.indexOf('\n');
        const request = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (request.method === 'session.snapshot') {
          if (currentConnection === 1 && trigger === 'timeout') {
            const noise = setInterval(() => {
              socket.write(`${JSON.stringify({ id: 'unrelated', result: { type: 'events_subscribed' } })}\n`);
            }, 5);
            socket.once('close', () => clearInterval(noise));
            continue;
          }
          socket.write(`${JSON.stringify({
            id: request.id,
            result: {
              type: 'session_snapshot',
              snapshot: { agents: [{
                pane_id: `w1:p${currentConnection}`,
                name: null,
                agent: 'pi',
                agent_status: 'working',
                focused: true,
              }] },
            },
          })}\n`);
        } else if (request.method === 'events.subscribe') {
          if (currentConnection > 1) {
            resolveResnapshot();
          } else if (trigger === 'malformed-status') {
            socket.write(`${JSON.stringify({
              event: 'pane.agent_status_changed',
              data: { pane_id: 'w1:p1', agent_status: 'bogus' },
            })}\n`);
          } else if (trigger === 'disconnect') {
            socket.destroy();
          } else {
            socket.write(`${JSON.stringify({ event: trigger, data: { pane_id: 'w1:p1' } })}\n`);
          }
        }
      }
    });
  }, async (socketPath) => {
    const monitor = new HerdrAgentStatusMonitor({
      socketPath,
      onComplete: () => {},
      reconnectDelayMs: 0,
      ...options,
    });
    monitor.start();
    let timeout;
    try {
      await Promise.race([
        resnapshot,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('resnapshot timed out')), 1_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      monitor.stop();
    }
  });
}

describe('Herdr completion notification authority', () => {
  it('routes Herdr completion to primary session notification delivery', () => {
    const events = [];
    const cancellations = [];
    const callbacks = createHerdrAgentStatusCallbacks(() => [
      { terminalId: '2', enqueueAgentEvent: () => events.push('secondary'), cancelAgentEvents: () => {} },
      {
        terminalId: '1',
        enqueueAgentEvent: (kind) => events.push(kind),
        cancelAgentEvents: (kind) => cancellations.push(kind),
      },
    ]);

    callbacks.onComplete();
    callbacks.onWorking();

    assert.deepEqual(events, ['task-completed']);
    assert.deepEqual(cancellations, ['task-completed']);
  });

  it('starts ten minutes at working→idle/done and preserves idle↔done', () => {
    const scheduler = new ManualScheduler();
    let completions = 0;
    const delay = new HerdrCompletionDelay({
      onComplete: () => { completions += 1; },
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });

    assert.equal(HERDR_COMPLETION_DELAY_MS, 600_000);
    delay.initialize('working');
    delay.update('idle');
    scheduler.advanceBy(300_000);
    delay.update('done');
    scheduler.advanceBy(299_999);
    assert.equal(completions, 0);
    scheduler.advanceBy(1);
    assert.equal(completions, 1);
  });

  it('cancels on working snapshots and requires a fresh ten idle minutes', () => {
    const scheduler = new ManualScheduler();
    let completions = 0;
    let workingTransitions = 0;
    const delay = new HerdrCompletionDelay({
      onComplete: () => { completions += 1; },
      onWorking: () => { workingTransitions += 1; },
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });

    delay.initialize('working');
    assert.equal(workingTransitions, 1);
    delay.update('idle');
    scheduler.advanceBy(599_999);
    delay.update('working');
    scheduler.advanceBy(600_000);
    assert.equal(completions, 0);
    assert.equal(workingTransitions, 2);

    delay.update('done');
    scheduler.advanceBy(599_999);
    assert.equal(completions, 0);
    scheduler.advanceBy(1);
    assert.equal(completions, 1);
  });

  it('does not notify from an initial idle snapshot or while blocked/unknown', () => {
    const scheduler = new ManualScheduler();
    let completions = 0;
    const delay = new HerdrCompletionDelay({
      onComplete: () => { completions += 1; },
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });

    delay.initialize('idle');
    scheduler.advanceBy(600_000);
    delay.update('blocked');
    delay.update('idle');
    scheduler.advanceBy(600_000);
    delay.update('unknown');
    scheduler.advanceBy(600_000);
    assert.equal(completions, 0);
  });

  it('preserves observed work through blocked and unknown until ready', () => {
    for (const interruption of ['blocked', 'unknown']) {
      const scheduler = new ManualScheduler();
      let completions = 0;
      const delay = new HerdrCompletionDelay({
        onComplete: () => { completions += 1; },
        setTimeout: scheduler.setTimeout,
        clearTimeout: scheduler.clearTimeout,
      });

      delay.initialize('working');
      delay.update(interruption);
      scheduler.advanceBy(600_000);
      assert.equal(completions, 0);
      delay.update('idle');
      scheduler.advanceBy(599_999);
      assert.equal(completions, 0);
      scheduler.advanceBy(1);
      assert.equal(completions, 1);
    }
  });

  it('reconnects after a bounded unanswered snapshot', async () => {
    await expectResnapshot('timeout', { snapshotTimeoutMs: 10 });
  });

  it('resnapshots after tracked-pane lifecycle events', async () => {
    let workingSnapshots = 0;
    await expectResnapshot('pane.closed', {
      onWorking: () => { workingSnapshots += 1; },
    });
    assert.equal(workingSnapshots, 2);
    await expectResnapshot('pane.agent_detected');
  });

  it('reconnects after a malformed subscribed status event or disconnect', async () => {
    await expectResnapshot('malformed-status');
    await expectResnapshot('disconnect');
  });

  it('does not notify when the snapshot has no recognized agents', async () => {
    let resolveSubscribed;
    const subscribed = new Promise((resolve) => { resolveSubscribed = resolve; });
    await withSocket((socket) => {
      let buffered = '';
      socket.on('data', (chunk) => {
        buffered += chunk.toString('utf8');
        while (buffered.includes('\n')) {
          const newline = buffered.indexOf('\n');
          const request = JSON.parse(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          if (request.method === 'session.snapshot') {
            socket.write(`${JSON.stringify({
              id: request.id,
              result: { type: 'session_snapshot', snapshot: { agents: [] } },
            })}\n`);
          } else if (request.method === 'events.subscribe') {
            assert.deepEqual(request.params.subscriptions, [
              { type: 'pane.closed' },
              { type: 'pane.agent_detected' },
            ]);
            resolveSubscribed();
          }
        }
      });
    }, async (socketPath) => {
      let completions = 0;
      const monitor = new HerdrAgentStatusMonitor({
        socketPath,
        delayMs: 0,
        onComplete: () => { completions += 1; },
      });
      monitor.start();
      let timeout;
      try {
        await Promise.race([
          subscribed,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('empty snapshot timed out')), 1_000);
          }),
        ]);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(completions, 0);
      } finally {
        clearTimeout(timeout);
        monitor.stop();
      }
    });
  });

  it('subscribes to every Herdr agent and waits until all panes are ready', async () => {
    let allReady = false;
    await withSocket((socket) => {
      let buffered = '';
      socket.on('data', (chunk) => {
        buffered += chunk.toString('utf8');
        while (buffered.includes('\n')) {
          const newline = buffered.indexOf('\n');
          const request = JSON.parse(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          if (request.method === 'session.snapshot') {
            socket.write(`${JSON.stringify({
              id: request.id,
              result: {
                type: 'session_snapshot',
                snapshot: {
                  agents: [
                    {
                      pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1',
                      name: null, agent: 'pi', agent_status: 'idle', focused: false,
                    },
                    {
                      pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t2',
                      name: null, agent: 'pi', agent_status: 'working', focused: true,
                    },
                  ],
                },
              },
            })}\n`);
          } else if (request.method === 'events.subscribe') {
            assert.deepEqual(request.params.subscriptions, [
              { type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'idle' },
              { type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'working' },
              { type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'blocked' },
              { type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'done' },
              { type: 'pane.agent_status_changed', pane_id: 'w1:p1', agent_status: 'unknown' },
              { type: 'pane.agent_status_changed', pane_id: 'w1:p2', agent_status: 'idle' },
              { type: 'pane.agent_status_changed', pane_id: 'w1:p2', agent_status: 'working' },
              { type: 'pane.agent_status_changed', pane_id: 'w1:p2', agent_status: 'blocked' },
              { type: 'pane.agent_status_changed', pane_id: 'w1:p2', agent_status: 'done' },
              { type: 'pane.agent_status_changed', pane_id: 'w1:p2', agent_status: 'unknown' },
              { type: 'pane.closed' },
              { type: 'pane.agent_detected' },
            ]);
            socket.write(`${JSON.stringify({ id: request.id, result: { type: 'events_subscribed' } })}\n`);
            socket.write(`${JSON.stringify({
              event: 'pane.agent_status_changed',
              data: { pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working', agent: 'pi' },
            })}\n`);
            socket.write(`${JSON.stringify({
              event: 'pane.agent_status_changed',
              data: { pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'idle', agent: 'pi' },
            })}\n`);
            setTimeout(() => {
              allReady = true;
              socket.write(`${JSON.stringify({
                event: 'pane.agent_status_changed',
                data: { pane_id: 'w1:p2', workspace_id: 'w1', agent_status: 'idle', agent: 'pi' },
              })}\n`);
            }, 20);
          }
        }
      });
    }, async (socketPath) => {
      await new Promise((resolve, reject) => {
        let monitor;
        const timeout = setTimeout(() => {
          monitor?.stop();
          reject(new Error('status completion timed out'));
        }, 1_000);
        monitor = new HerdrAgentStatusMonitor({
          socketPath,
          delayMs: 0,
          onComplete: () => {
            clearTimeout(timeout);
            monitor.stop();
            if (!allReady) {
              reject(new Error('completion fired while another pane was working'));
              return;
            }
            resolve();
          },
        });
        monitor.start();
      });
    });
  });
});
