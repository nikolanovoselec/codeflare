// REQ-AGENT-023 AC2/AC4: exercise the owned wrapper through real upstream
// Graphify's public MCP stdio boundary. No graph extraction or external API calls.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wrapper = resolve(here, '../../preseed/agents/claude/plugins/graphify/scripts/graphify-mcp-lazy.py');

function graph(prefix, { parallel = false, community = 0 } = {}) {
  const ids = ['Caller', 'Middle', 'Leaf'].map(label => `${prefix}${label}`);
  const link = (source, target, relation) => ({ source, target, relation,
    confidence: 'EXTRACTED', _src: source, _tgt: target });
  return {
    directed: true,
    // Upstream repairs parallel links even when older writers serialized false.
    multigraph: false,
    graph: {},
    nodes: ids.map(id => ({ id, label: id, source_file: `${prefix}.py`,
      file_type: 'code', community, community_name: `${prefix} community` })),
    links: [link(ids[0], ids[1], 'calls'), link(ids[1], ids[2], 'calls'),
      ...(parallel ? [link(ids[0], ids[1], 'references')] : [])],
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'graphify-mcp-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const sentinel = join(root, 'active-cwd');
  const globalGraph = join(root, 'global', 'graph.json');
  const nominal = join(root, 'nominal', 'graph.json');
  let generation = 0;
  function publish(path, data, mtime = 2_000_000_000 + generation++) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.new`, JSON.stringify(data));
    utimesSync(`${path}.new`, mtime, mtime);
    renameSync(`${path}.new`, path);
    return path;
  }
  function repo(name) {
    const path = join(workspace, name);
    mkdirSync(join(path, '.git'), { recursive: true });
    mkdirSync(join(path, 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(path, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    return { path, graph: join(path, 'graphify-out', 'graph.json'), nested: join(path, 'nested', 'deeper') };
  }
  return { root, workspace, sentinel, globalGraph, nominal, publish, repo,
    select: path => writeFileSync(sentinel, path),
    dispose: () => rmSync(root, { recursive: true, force: true }) };
}

async function client(f) {
  const python = process.env.GRAPHIFY_TEST_PYTHON;
  assert.ok(python, 'The host CI prerequisite must provide the authentic Graphify candidate interpreter');
  const child = spawn(python, ['-u', wrapper, f.nominal], {
    cwd: f.root,
    env: { ...process.env, HOME: f.root, PYTHONPATH: '',
      CODEFLARE_WORKSPACE: f.workspace, GRAPHIFY_SENTINEL: f.sentinel,
      GRAPHIFY_GLOBAL_GRAPH: f.globalGraph, GRAPHIFY_POLL_SECONDS: '0.02' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let sequence = 0;
  let diagnostics = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { diagnostics = (diagnostics + text).slice(-8000); });
  const lines = createInterface({ input: child.stdout });
  function fail(error) {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  child.on('error', fail);
  child.on('exit', (code, signal) => fail(new Error(`Graphify exited (${code ?? signal}): ${diagnostics}`)));
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { fail(new Error(`Non-MCP stdout: ${line}`)); return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  function request(method, params) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${diagnostics}`)); }, 15_000);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  }
  async function close() {
    lines.close();
    fail(new Error('MCP fixture closed'));
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
  try {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'codeflare-compatibility-test', version: '1.0.0' } });
    send({ method: 'notifications/initialized' });
  } catch (error) { await close(); throw error; }
  return {
    close,
    async tool(name, args = {}) {
      const result = await request('tools/call', { name, arguments: args });
      const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      assert.notEqual(result.isError, true, text);
      assert.doesNotMatch(text, /^Error executing /, text);
      return text;
    },
  };
}

for (const parallel of [false, true]) {
  it(`REQ-AGENT-023: AC2 preserves ${parallel ? 'parallel' : 'single'} relations and directed answers through Claude MCP`, async () => {
    const f = fixture();
    let mcp;
    try {
      const selected = f.repo('selected');
      f.publish(selected.graph, graph('Proof', { parallel }));
      f.select(selected.nested);
      // Existing nominal path isolates relation semantics from graphless startup.
      f.publish(f.nominal, graph('Nominal'));
      mcp = await client(f);
      const neighbors = await mcp.tool('get_neighbors', { node_id: 'ProofCaller', token_budget: 4000 });
      assert.match(neighbors, /ProofMiddle/);
      assert.match(neighbors, /calls/);
      if (parallel) assert.match(neighbors, /references/);
      const query = await mcp.tool('query_graph', { question: 'ProofLeaf', depth: 3, token_budget: 8000 });
      assert.match(query, /ProofCaller/);
      assert.match(query, /ProofLeaf/);
      // An incoming leaf must not make the directed route reversible.
      const path = await mcp.tool('shortest_path', { source: 'ProofCaller', target: 'ProofLeaf' });
      assert.match(path, /Shortest path \(2 hops\)/);
      assert.match(path, /--calls(?:\/references)? \[EXTRACTED\]--> ProofMiddle/);
      if (parallel) assert.match(path, /references/);
      const reverse = await mcp.tool('shortest_path', { source: 'ProofLeaf', target: 'ProofCaller' });
      assert.match(reverse, /No directed path/);
      const undirected = await mcp.tool('shortest_path', { source: 'ProofLeaf', target: 'ProofCaller', undirected: true });
      assert.match(undirected, /Shortest path \(2 hops\)/);
      assert.match(undirected, /<--calls/);
      const stats = await mcp.tool('graph_stats');
      assert.match(stats, /Nodes: 3\n/);
      assert.match(stats, new RegExp(`Edges: ${parallel ? 3 : 2}\\n`));
    } finally { if (mcp) await mcp.close(); f.dispose(); }
  });
}

it('REQ-AGENT-023: AC4 starts graphless and rebinds fresh query contexts without restarting MCP', async () => {
  const f = fixture();
  let mcp;
  try {
    const first = f.repo('first');
    const second = f.repo('second');
    const empty = f.repo('empty');
    mcp = await client(f);
    assert.match(await mcp.tool('graph_stats'), /Nodes: 0\nEdges: 0\n/);

    f.select(first.nested);
    f.publish(first.graph, graph('Before', { community: 1 }), 2_000_000_001);
    assert.match(await mcp.tool('get_node', { node_id: 'BeforeCaller' }), /Node: BeforeCaller/);
    assert.match(await mcp.tool('query_graph', { question: 'BeforeLeaf', token_budget: 8000 }), /BeforeCaller/);
    assert.match(await mcp.tool('shortest_path', { source: 'BeforeCaller', target: 'BeforeLeaf' }), /2 hops/);
    assert.match(await mcp.tool('get_community', { community_id: 1 }), /BeforeCaller/);

    f.publish(first.graph, graph('After', { community: 2 }), 2_000_000_002);
    assert.match(await mcp.tool('get_node', { node_id: 'AfterCaller' }), /Node: AfterCaller/);
    assert.doesNotMatch(await mcp.tool('query_graph', { question: 'AfterLeaf', token_budget: 8000 }), /Before/);
    assert.match(await mcp.tool('shortest_path', { source: 'AfterCaller', target: 'AfterLeaf' }), /2 hops/);
    assert.match(await mcp.tool('get_community', { community_id: 2 }), /AfterCaller/);
    assert.match(await mcp.tool('get_community', { community_id: 1 }), /not found/);

    // Equal mtimes on different paths must still rebind complete query contexts.
    f.publish(second.graph, graph('Other', { community: 3 }), 2_000_000_002);
    f.select(second.nested);
    assert.match(await mcp.tool('get_node', { node_id: 'OtherCaller' }), /Node: OtherCaller/);
    assert.match(await mcp.tool('get_community', { community_id: 3 }), /OtherLeaf/);
    f.select(empty.nested);
    assert.match(await mcp.tool('graph_stats'), /Nodes: 0\nEdges: 0\n/);

    // No sentinel falls back to freshest; valid sentinel beats that freshness.
    rmSync(f.sentinel);
    f.publish(second.graph, graph('Freshest'), 2_000_000_004);
    assert.match(await mcp.tool('get_node', { node_id: 'FreshestCaller' }), /Node: FreshestCaller/);
    f.select(first.nested);
    assert.match(await mcp.tool('get_node', { node_id: 'AfterCaller' }), /Node: AfterCaller/);
    f.publish(f.globalGraph, graph('Unified'), 2_000_000_000);
    assert.match(await mcp.tool('get_node', { node_id: 'UnifiedCaller' }), /Node: UnifiedCaller/);
    assert.doesNotMatch(await mcp.tool('query_graph', { question: 'UnifiedLeaf', token_budget: 8000 }), /After|Freshest/);
    rmSync(f.globalGraph);
    assert.match(await mcp.tool('get_node', { node_id: 'AfterCaller' }), /Node: AfterCaller/);
  } finally { if (mcp) await mcp.close(); f.dispose(); }
});
