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
    budgetKiB: null, // set from the first measured run; null = report only
  },
};
