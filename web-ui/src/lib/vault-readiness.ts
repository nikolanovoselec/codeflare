/**
 * Vault-readiness probe state machine. Extracted from Layout.tsx so the
 * cadence behavior (REQ-VAULT-012 AC5: "retries until the first success")
 * is unit-testable without rendering the full SolidJS tree.
 *
 * The machine has exactly two states:
 *
 *   warmup -- probes every WARMUP_INTERVAL_MS forever until a probe
 *             returns true; on success, transitions to steady.
 *   steady -- probes every STEADY_INTERVAL_MS; on a failed probe, clears
 *             the latch and falls back to warmup so the button disables
 *             itself and a recovery probe loop runs.
 *
 * There is NO max-attempt cap. An earlier version capped warmup at
 * ~3 minutes (60 attempts at 3s each); a user who restarted a stopped
 * session whose SilverBullet took longer than the cap to bind landed
 * with a permanently disabled vault button and no recovery path. The
 * indefinite retry is what REQ-VAULT-012 AC5 actually requires.
 */

export interface VaultReadinessOptions {
  /** Returns true if SB is reachable, false otherwise (already swallows errors). */
  probe: () => Promise<boolean>;
  /** Called when the probe first succeeds and on each successful steady re-probe. */
  setLatch: () => void;
  /** Called when a steady re-probe fails (SB crashed mid-session). */
  clearLatch: () => void;
  /** Returns true if the prior session-scope already had a successful probe. */
  initiallyReady: () => boolean;
  warmupIntervalMs: number;
  steadyIntervalMs: number;
  /** Injection seam for tests; defaults to globalThis.setTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Inverse of `schedule`. Defaults to globalThis.clearTimeout. */
  unschedule?: (handle: unknown) => void;
}

/**
 * Starts the readiness probe chain. Returns a cancel function that
 * stops the loop and clears any pending timer. Safe to call cancel
 * multiple times.
 */
export function startVaultReadinessProbe(opts: VaultReadinessOptions): () => void {
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const unschedule = opts.unschedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let cancelled = false;
  let timer: unknown = null;

  const warmup = async (): Promise<void> => {
    if (cancelled) return;
    const ok = await opts.probe();
    if (cancelled) return;
    if (ok) {
      opts.setLatch();
      timer = schedule(steady, opts.steadyIntervalMs);
      return;
    }
    timer = schedule(warmup, opts.warmupIntervalMs);
  };

  const steady = async (): Promise<void> => {
    if (cancelled) return;
    const ok = await opts.probe();
    if (cancelled) return;
    if (!ok) {
      opts.clearLatch();
      timer = schedule(warmup, opts.warmupIntervalMs);
      return;
    }
    timer = schedule(steady, opts.steadyIntervalMs);
  };

  if (opts.initiallyReady()) {
    timer = schedule(steady, opts.steadyIntervalMs);
  } else {
    void warmup();
  }

  return () => {
    cancelled = true;
    if (timer !== null) unschedule(timer);
  };
}
