import { describe, it, expect } from 'vitest';
import { pickGraphSource } from '../../../preseed/agents/pi/extensions/graphify-helpers';

/**
 * pickGraphSource is the pure precedence behind graphify-native's graph resolution
 * (REQ-AGENT-023). The load-bearing property is that the CWD repo graph wins over the
 * active-repo sentinel and the global graph: graphify-native is ambient in every session
 * mode and in review lanes (both run IN the repo), where the advanced-only sentinel is
 * absent or points at a stale/other repo. These fail if that precedence regresses, which
 * would let a query run against the wrong repo's (or the global) graph.
 */
describe('pickGraphSource (REQ-AGENT-023)', () => {
  const cwdGraph = { graphPath: '/repo/graphify-out/graph.json', cwd: '/repo', scope: 'repo repo' };
  const sentinelGraph = { graphPath: '/other/graphify-out/graph.json', cwd: '/other', scope: 'repo other' };
  const globalGraph = { graphPath: '/home/user/.graphify/global-graph.json', cwd: '/home/user', scope: 'merged global graph (vault + all repos)' };

  it('prefers the cwd repo graph over both the sentinel and the global graph', () => {
    expect(pickGraphSource({ cwdGraph, sentinelGraph, globalGraph })).toBe(cwdGraph);
  });

  it('falls back to the sentinel graph when the cwd has no repo graph', () => {
    expect(pickGraphSource({ cwdGraph: undefined, sentinelGraph, globalGraph })).toBe(sentinelGraph);
  });

  it('falls back to the global graph when neither cwd nor sentinel has a repo graph', () => {
    expect(pickGraphSource({ cwdGraph: undefined, sentinelGraph: undefined, globalGraph })).toBe(globalGraph);
  });

  it('returns undefined when no graph exists anywhere', () => {
    expect(pickGraphSource({})).toBeUndefined();
  });
});
