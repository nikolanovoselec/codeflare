// Size budgets enforced on every PR.
//
// Cloudflare rejects an oversized Worker at deploy time, which means the
// discovery point for "the bundle grew too much" is a failed production
// deploy. These budgets move that discovery to the PR that caused it.
//
// `limitKiB` is the platform's hard ceiling — the number Cloudflare itself
// enforces. `budgetKiB` is ours: set close to current usage so unexpected
// growth is visible while there is still headroom to react. A budget parked
// at the platform limit would never fire and would be theater.
export const BUDGETS = {
  worker: {
    label: 'Worker script (gzipped)',
    // Workers paid plan. The free plan is 3 MiB; codeflare runs containers,
    // which is paid-only, so 10 MiB is the ceiling that actually applies.
    limitKiB: 10 * 1024,
    // Measured 3705.85 KiB on 2026-07-20 (run 29724182607). ~13% headroom:
    // enough that ordinary feature work does not trip it, tight enough that a
    // step change — a dependency pulled into the Worker, a seed that stops
    // being trimmed — fails the PR that caused it instead of the next deploy.
    //
    // Worth knowing: 3705 KiB is already past the 3 MiB free-plan ceiling, so
    // this Worker cannot deploy on the free plan regardless of the budget.
    // Most of it is src/lib/agent-seed.generated.ts (12 MiB raw).
    budgetKiB: 4200,
  },
};
