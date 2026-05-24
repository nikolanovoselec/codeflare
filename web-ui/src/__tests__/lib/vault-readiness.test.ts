// REQ-VAULT-012 AC5: the vault-readiness probe "retries until the first
// success". An earlier implementation capped warmup at 60 attempts and
// then permanently gave up, leaving the vault button disabled forever
// when the user restarted a long-idle session whose SilverBullet took
// longer than the cap to bind. These tests pin the no-give-up behavior
// so a future refactor cannot reintroduce the regression.

import { describe, it, expect, vi } from 'vitest';
import { startVaultReadinessProbe } from '../../lib/vault-readiness';

/**
 * Deterministic synchronous scheduler. Captures every scheduled callback
 * so the test can drain them one tick at a time, count them, and assert
 * on cadence. Avoids fake-timers global state and the await-then-tick
 * race that vi.useFakeTimers introduces with async callbacks.
 */
function createTestScheduler() {
  type Entry = { fn: () => void; ms: number };
  const queue: Entry[] = [];
  const intervals: number[] = [];
  const schedule = (fn: () => void, ms: number) => {
    const entry = { fn, ms };
    queue.push(entry);
    intervals.push(ms);
    return entry;
  };
  const unschedule = (handle: unknown) => {
    const idx = queue.indexOf(handle as Entry);
    if (idx >= 0) queue.splice(idx, 1);
  };
  // Advances by running the next-scheduled callback synchronously.
  // The callback is async; the caller awaits the returned promise so
  // any subsequent schedule() calls inside it are observable.
  const tick = async () => {
    const entry = queue.shift();
    if (!entry) return;
    await entry.fn();
  };
  return { schedule, unschedule, tick, queue, intervals };
}

describe('startVaultReadinessProbe', () => {
  it('retries forever past the old 60-attempt cap when probes keep failing (REQ-VAULT-012 AC5)', async () => {
    const scheduler = createTestScheduler();
    const probe = vi.fn().mockResolvedValue(false);
    const setLatch = vi.fn();
    const clearLatch = vi.fn();

    startVaultReadinessProbe({
      probe,
      setLatch,
      clearLatch,
      initiallyReady: () => false,
      warmupIntervalMs: 5000,
      steadyIntervalMs: 60000,
      schedule: scheduler.schedule,
      unschedule: scheduler.unschedule,
    });

    // The first probe runs immediately (no schedule needed because
    // warmup() invokes it directly). Await one microtask to let the
    // initial probe complete and schedule the next attempt.
    await Promise.resolve();
    await Promise.resolve();

    // Drain 100 cycles -- well past the old WARMUP_MAX_ATTEMPTS=60 cap.
    // Each cycle: tick (runs the scheduled warmup callback, which calls
    // probe and schedules the next attempt because probe returns false).
    for (let i = 0; i < 100; i++) {
      await scheduler.tick();
    }

    // 1 immediate probe + 100 scheduled probes = exactly 101 calls. Tight
    // equality (not >=) so a double-schedule regression also fails this
    // test, not just a cap regression.
    expect(probe.mock.calls.length).toBe(101);
    expect(setLatch).not.toHaveBeenCalled();
    expect(clearLatch).not.toHaveBeenCalled();

    // Every retry uses the warmup cadence (no slow-cadence fallback,
    // no exponential backoff -- just the one fixed interval per spec).
    // 101 schedule entries: 1 from the inline initial warmup + 100 from
    // the 100 drained ticks. Tight equality pins both no-give-up AND
    // no-extra-cadence-bucket regressions.
    const warmupTicks = scheduler.intervals.filter((ms) => ms === 5000);
    expect(warmupTicks.length).toBe(101);
    expect(scheduler.intervals.length).toBe(101);
  });

  it('latches ready on first probe success and switches to steady cadence', async () => {
    const scheduler = createTestScheduler();
    const probe = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const setLatch = vi.fn();
    const clearLatch = vi.fn();

    startVaultReadinessProbe({
      probe,
      setLatch,
      clearLatch,
      initiallyReady: () => false,
      warmupIntervalMs: 5000,
      steadyIntervalMs: 60000,
      schedule: scheduler.schedule,
      unschedule: scheduler.unschedule,
    });

    // Immediate probe (fails) → schedules a warmup retry.
    await Promise.resolve(); await Promise.resolve();
    // Tick 1: second warmup probe (fails) → schedules another.
    await scheduler.tick();
    // Tick 2: third warmup probe (succeeds) → latches + schedules steady.
    await scheduler.tick();

    expect(setLatch).toHaveBeenCalledTimes(1);
    expect(clearLatch).not.toHaveBeenCalled();
    // The next scheduled call must be the steady-interval re-probe, not
    // another warmup. Pin the cadence so a future refactor cannot
    // silently swap them.
    expect(scheduler.intervals[scheduler.intervals.length - 1]).toBe(60000);
  });

  it('clears latch and falls back to warmup when a steady probe fails (SB crash recovery)', async () => {
    const scheduler = createTestScheduler();
    const probe = vi.fn()
      .mockResolvedValueOnce(false) // steady probe -- fails (SB crashed)
      .mockResolvedValueOnce(false); // recovery warmup -- still failing
    const setLatch = vi.fn();
    const clearLatch = vi.fn();

    startVaultReadinessProbe({
      probe,
      setLatch,
      clearLatch,
      initiallyReady: () => true, // simulates a session that previously latched
      warmupIntervalMs: 5000,
      steadyIntervalMs: 60000,
      schedule: scheduler.schedule,
      unschedule: scheduler.unschedule,
    });

    // initiallyReady=true skips warmup, schedules steady directly.
    await Promise.resolve();
    // Tick: steady runs, probe fails, latch cleared, warmup scheduled.
    await scheduler.tick();

    expect(clearLatch).toHaveBeenCalledTimes(1);
    expect(setLatch).not.toHaveBeenCalled();
    // The recovery probe is scheduled at the warmup cadence, not the
    // steady cadence -- a failed steady probe means the button just
    // went disabled and the user needs the fast cadence back.
    expect(scheduler.intervals[scheduler.intervals.length - 1]).toBe(5000);

    // Drain the recovery probe; it must keep retrying (no give-up).
    await scheduler.tick();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(scheduler.queue.length).toBe(1); // next retry scheduled
  });

  it('cancel() stops the chain and prevents further probe scheduling', async () => {
    const scheduler = createTestScheduler();
    const probe = vi.fn().mockResolvedValue(false);
    const setLatch = vi.fn();
    const clearLatch = vi.fn();

    const cancel = startVaultReadinessProbe({
      probe,
      setLatch,
      clearLatch,
      initiallyReady: () => false,
      warmupIntervalMs: 5000,
      steadyIntervalMs: 60000,
      schedule: scheduler.schedule,
      unschedule: scheduler.unschedule,
    });

    await Promise.resolve(); await Promise.resolve();
    cancel();

    const probeCountAtCancel = probe.mock.calls.length;

    // The pending scheduled probe should have been unscheduled. If it
    // still fires, the cancelled-flag short-circuit catches it before
    // calling probe.
    await scheduler.tick();
    await Promise.resolve();
    expect(probe.mock.calls.length).toBe(probeCountAtCancel);
    expect(scheduler.queue.length).toBe(0);
  });

  it('cancellation taken mid-probe prevents the resolved probe from latching', async () => {
    const scheduler = createTestScheduler();
    let resolveProbe!: (value: boolean) => void;
    const probe = vi.fn(() => new Promise<boolean>((r) => { resolveProbe = r; }));
    const setLatch = vi.fn();
    const clearLatch = vi.fn();

    const cancel = startVaultReadinessProbe({
      probe,
      setLatch,
      clearLatch,
      initiallyReady: () => false,
      warmupIntervalMs: 5000,
      steadyIntervalMs: 60000,
      schedule: scheduler.schedule,
      unschedule: scheduler.unschedule,
    });

    // Probe started, hasn't resolved yet.
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(1);

    // Caller cancels (e.g. session switched away, effect re-ran).
    cancel();

    // The in-flight probe resolves to true -- but the post-await
    // cancelled-guard must drop the result on the floor, NOT latch.
    resolveProbe(true);
    await Promise.resolve(); await Promise.resolve();

    expect(setLatch).not.toHaveBeenCalled();
    expect(scheduler.queue.length).toBe(0);
  });
});
