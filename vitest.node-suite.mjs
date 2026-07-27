// The backend test files that run under plain Node instead of the Workers pool.
//
// Single source of truth for three consumers that must never drift: the Workers
// config excludes this list, the Node config includes it, and the CI
// completeness gate uses it to partition the expected file set. When the three
// were separate literals, a file could be dropped from both configs and simply
// stop running while CI stayed green.
export const NODE_SUITE_FILES = [
  // CI gate scripts: spawned as subprocesses against temp trees.
  'src/__tests__/ci/suite-gates.test.ts',
  'src/__tests__/lib/agent-seed-multi-agent.test.ts',
  'src/__tests__/lib/local-statusline-repo.test.ts',
  // Drive real temp trees through node:fs, and the memory-inject case stands in
  // a working directory to prove no repo graph is substituted - neither is
  // available under the Workers pool.
  'src/__tests__/lib/pi-memory-inject.test.ts',
  'src/__tests__/lib/pi-memory-vault-delivery.test.ts',
  'src/__tests__/lib/pi-post-compaction-recall.test.ts',
  'src/__tests__/lib/pi-sidebar-approval.test.ts',
  'src/__tests__/lib/review-enforcement.test.ts',
  'src/__tests__/lib/pi-review-scope.test.ts',
  'src/__tests__/lib/review-helpers.test.ts',
  'src/__tests__/lib/vault-manifest-detection.test.ts',
];
