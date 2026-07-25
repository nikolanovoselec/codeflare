// Verifies REQ-AGENT-023 AC4: the graphify MCP wrapper (graphify-mcp-lazy.py)
// implements the load-bearing hot-reload + repo-aware resolution
// contract (AD53).
//
// The "LazyGraph runtime behavior" describe EXECUTES the wrapper in a real
// python3 with stubbed networkx/graphify modules: it proves the atomic dict
// swap (an iterator held open across a reload completes over the old
// snapshot; a clear()+add regression raises RuntimeError deterministically),
// the mtime-gated reload, and the rebind-empties contract. The static
// regex checks below it remain as a cheap secondary guard for invariants
// that need the full graphify runtime to exercise (sentinel env plumbing,
// daemon-thread flags, serve() wiring).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/graphify/scripts/graphify-mcp-lazy.py'
);
const source = readFileSync(WRAPPER, 'utf-8');

const NETWORKX_STUB = `
class DiGraph:
    def __init__(self):
        self._node = {}
        self._adj = {}
        self._pred = {}
        self._succ = {}
        self.graph = {}

    def __iter__(self):
        return iter(self._node)

    def __len__(self):
        return len(self._node)
`;

const GRAPHIFY_SERVE_STUB = `
import json
import networkx as nx


def _load_graph(path):
    g = nx.DiGraph()
    with open(path) as f:
        data = json.load(f)
    for node in data.get("nodes", []):
        g._node[node["id"]] = node
    return g


def serve(arg):
    raise RuntimeError("serve() must not run in tests")
`;

const HARNESS = `
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location("graphify_mcp_lazy", os.environ["WRAPPER_PATH"])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

g = mod.LazyGraph()
assert sorted(g) == ["a", "b", "c"], f"initial sentinel-resolved load: {sorted(g)}"
print("LOAD_OK")

# Hold an iterator open across a reload: the atomic pointer swap must let it
# complete over the OLD dict. A clear()+add_nodes_from regression mutates the
# dict the iterator is walking and raises RuntimeError right here.
it = iter(g)
first = next(it)
graph_path = Path(os.environ["GRAPH_JSON"])
graph_path.write_text(json.dumps({"nodes": [{"id": "x"}, {"id": "y"}]}))
future = time.time() + 5
os.utime(graph_path, (future, future))
g._tick()
rest = [first] + list(it)
assert sorted(rest) == ["a", "b", "c"], f"in-flight iterator must finish over the old snapshot: {sorted(rest)}"
assert sorted(g) == ["x", "y"], f"post-swap graph contents: {sorted(g)}"
print("SWAP_OK")

# Same mtime => no reload (the mtime gate, not a reload-every-tick loop).
g._node["marker"] = {}
g._tick()
assert "marker" in g._node, "an unchanged mtime must not trigger a reload"
print("MTIME_GATE_OK")

# Rebinding the sentinel to a graphless repo empties the graph atomically so
# stale nodes never leak across repos.
Path(os.environ["SENTINEL"]).write_text(os.environ["REPO2"])
g._tick()
assert len(g) == 0, f"rebind to a graphless repo must empty the graph: {sorted(g)}"
print("REBIND_OK")
`;

describe('LazyGraph runtime behavior (REQ-AGENT-023 AC4 / AD53, real python3 + stubbed graphify)', () => {
  it('loads via the sentinel, swaps atomically under an open iterator, gates on mtime, and empties on rebind', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'graphify-lazy-'));
    try {
      const stubs = join(fixture, 'stubs');
      mkdirSync(join(stubs, 'graphify'), { recursive: true });
      writeFileSync(join(stubs, 'networkx.py'), NETWORKX_STUB);
      writeFileSync(join(stubs, 'graphify', '__init__.py'), '');
      writeFileSync(join(stubs, 'graphify', 'serve.py'), GRAPHIFY_SERVE_STUB);

      const repo1 = join(fixture, 'workspace', 'repo1');
      const repo2 = join(fixture, 'workspace', 'repo2');
      mkdirSync(join(repo1, 'graphify-out'), { recursive: true });
      mkdirSync(join(repo1, '.git'), { recursive: true });
      mkdirSync(join(repo2, '.git'), { recursive: true });
      writeFileSync(join(repo1, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      writeFileSync(join(repo2, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      const graphJson = join(repo1, 'graphify-out', 'graph.json');
      writeFileSync(graphJson, JSON.stringify({ nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }));

      const sentinel = join(fixture, 'graphify-active-cwd');
      writeFileSync(sentinel, repo1);
      const harness = join(fixture, 'harness.py');
      writeFileSync(harness, HARNESS);

      const result = spawnSync('python3', [harness], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          PYTHONPATH: stubs,
          WRAPPER_PATH: WRAPPER,
          GRAPH_JSON: graphJson,
          SENTINEL: sentinel,
          REPO2: repo2,
          GRAPHIFY_SENTINEL: sentinel,
          CODEFLARE_WORKSPACE: join(fixture, 'workspace'),
          // Point the global graph at a nonexistent file so the sentinel path
          // is exercised; park the watcher so only explicit _tick()s run.
          GRAPHIFY_GLOBAL_GRAPH: join(fixture, 'no-such-global.json'),
          GRAPHIFY_POLL_SECONDS: '3600',
        },
      });

      assert.equal(result.status, 0, `harness failed:\n${result.stdout}\n${result.stderr}`);
      for (const marker of ['LOAD_OK', 'SWAP_OK', 'MTIME_GATE_OK', 'REBIND_OK']) {
        assert.ok(result.stdout.includes(marker), `missing ${marker} in:\n${result.stdout}\n${result.stderr}`);
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

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
