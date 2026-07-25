// The test suites CI runs, and the tree each one is responsible for.
//
// One entry per suite. Adding a suite here is what makes the completeness gate
// (check-suite-completeness.mjs) demand that its files actually ran; without an
// entry a whole suite could be dropped from test.yml and nothing would notice.
//
// `dir`        — repo-relative root of the suite's test files
// `extensions` — filename suffixes that count as a test file in that tree
// `exclude`    — files owned by a different runtime, listed elsewhere
// `artifacts`  — prefix of the uploaded report artifacts covering this tree
// `lane`       — key in the lane-result map passed to the gate, so a
//                path-filtered skip is distinguishable from a silent no-show
import { NODE_SUITE_FILES } from '../../vitest.node-suite.mjs';

export const SUITES = [
  {
    name: 'backend',
    lane: 'backend',
    dir: 'src',
    extensions: ['.test.ts'],
    exclude: [],
    // Both the Workers shards and the Node-runtime leg draw from this tree, so
    // they reconcile together — a file must appear in exactly one of them.
    artifacts: ['backend-shard-', 'backend-node'],
  },
  {
    name: 'frontend',
    lane: 'frontend',
    dir: 'web-ui/src/__tests__',
    extensions: ['.test.ts', '.test.tsx'],
    exclude: [],
    artifacts: ['frontend-shard-'],
  },
  {
    name: 'landing',
    lane: 'landing',
    dir: 'landing/src',
    extensions: ['.test.ts', '.test.tsx'],
    exclude: [],
    artifacts: ['landing'],
  },
  {
    name: 'browser-ide',
    lane: 'browser-ide',
    dir: 'openvscode',
    extensions: ['.test.ts', '.test.mjs'],
    exclude: [],
    artifacts: ['browser-ide'],
  },
];

// Re-exported so the backend entry's runtime split stays anchored to the one
// list both vitest configs read.
export { NODE_SUITE_FILES };
