// Verifies REQ-AGENT-023 AC4: the graphify MCP wrapper (graphify-mcp-lazy.py)
// implements the load-bearing hot-reload + repo-aware resolution
// contract. Tests inspect the preseed source for the invariants the
// architecture decision record (AD53) calls out — atomic dict swap,
// sentinel resolution chain, freshest-mtime fallback. Integration
// against running graphify requires graphifyy installed and is exercised
// out-of-band; CI verifies the static contract here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/graphify/scripts/graphify-mcp-lazy.py'
);
const source = readFileSync(WRAPPER, 'utf-8');

describe('graphify-mcp-lazy.py static contract', () => {
  it('monkey-patches graphify.serve._load_graph to return a LazyGraph', () => {
    assert.match(
      source,
      /gs\._load_graph\s*=\s*_lazy_load_graph/,
      'wrapper must replace gs._load_graph or the missing-graph crash returns'
    );
  });

  it('LazyGraph subclasses nx.DiGraph (so isinstance checks pass)', () => {
    assert.match(
      source,
      /class\s+LazyGraph\(nx\.DiGraph\)/,
      'wrapper relies on isinstance(G, nx.Graph) in graphify; must subclass'
    );
  });

  it('uses a threading.Lock to serialise watcher writes vs reader iteration', () => {
    assert.match(source, /threading\.Lock\(\)/);
    assert.match(source, /with self\._lock/);
  });

  it('swap path replaces _node/_adj/_pred/_succ/graph atomically (not clear+add)', () => {
    // The earlier draft used clear() + add_nodes_from() which crashed
    // graphify mid-iteration. The fix is atomic dict-pointer swap.
    assert.match(source, /self\._node\s*=\s*new_g\._node/);
    assert.match(source, /self\._adj\s*=\s*new_g\._adj/);
    assert.match(source, /self\._pred\s*=\s*new_g\._pred/);
    assert.match(source, /self\._succ\s*=\s*new_g\._succ/);
    assert.doesNotMatch(
      source,
      /self\.clear\(\)\s*\n\s*self\.add_nodes_from/,
      'must not regress to clear() + add_nodes_from() (race vs readers)'
    );
  });

  it('polls a sentinel file before falling back to freshest mtime', () => {
    assert.match(source, /SENTINEL_PATH/);
    assert.match(source, /WORKSPACE_ROOT/);
    // The fallback glob is part of the resolution contract
    assert.match(
      source,
      /WORKSPACE_ROOT\.glob\(["']\*\/graphify-out\/graph\.json["']\)/
    );
  });

  it('walks up from sentinel cwd to find a parent with graphify-out/ or .git/', () => {
    assert.match(source, /graphify-out["']?\)\.is_dir\(\)/);
    assert.match(source, /\.git["']?\)\.is_dir\(\)/);
  });

  it('sentinel + workspace + poll seconds are env-configurable', () => {
    assert.match(source, /GRAPHIFY_SENTINEL/);
    assert.match(source, /CODEFLARE_WORKSPACE/);
    assert.match(source, /GRAPHIFY_POLL_SECONDS/);
  });

  it('reads .git/HEAD for branch identification on rebind', () => {
    assert.match(source, /\.git["']?\s*\/\s*["']HEAD["']/);
    assert.match(source, /ref:\s*refs\/heads\//);
  });

  it('watcher runs as a daemon thread (does not block server exit)', () => {
    assert.match(source, /threading\.Thread\([^)]*daemon=True/);
  });

  it('tick exceptions log traceback (not just the bare exception repr)', () => {
    assert.match(source, /traceback\.print_exc/);
  });

  it('exposes a main entrypoint that invokes gs.serve()', () => {
    assert.match(source, /if __name__\s*==\s*["']__main__["']/);
    assert.match(source, /gs\.serve\(/);
  });
});
