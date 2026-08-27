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
  // Bundles the Pi extension with an esbuild fixture, which requires Node.
  'src/__tests__/lib/startup-header.test.ts',
  // All three drive real temp trees through node:fs, and pi-memory-inject also
  // stands in a working directory to prove no repo graph is substituted -
  // neither capability exists under the Workers pool.
  // Imports codeflare-pi.ts, whose execFileSync reconcile has no workerd
  // equivalent; under the Workers pool the file crashed collection outright.
  'src/__tests__/lib/pi-global-graph-reconcile.test.ts',
  'src/__tests__/lib/pi-memory-inject.test.ts',
  'src/__tests__/lib/pi-memory-vault-delivery.test.ts',
  'src/__tests__/lib/pi-native-notifications.test.ts',
  'src/__tests__/lib/pi-post-compaction-recall.test.ts',
  'src/__tests__/lib/pi-sidebar-approval.test.ts',
  'src/__tests__/lib/review-enforcement.test.ts',
  'src/__tests__/lib/review-completion-state.test.ts',
  'src/__tests__/lib/pi-review-scope.test.ts',
  'src/__tests__/lib/review-helpers.test.ts',
  // Executes browser-script bytes after an esbuild keepNames bundle; workerd
  // cannot evaluate the isolated page realm used by these injected scripts.
  'src/__tests__/lib/vault-browser-bundle.test.ts',
  'src/__tests__/lib/vault-manifest-detection.test.ts',
];
