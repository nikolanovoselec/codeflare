// REQ-MEM-009: the vault-extract pipeline must accumulate the user_vault
// subgraph across extractions instead of replacing it on every run. The
// haiku's prompt is the canonical contract -- it spells out the exact
// commands and order. The tests below pattern-match the prompt's body
// against the AC contract.
//
// The prompt is a markdown file with embedded bash code blocks; we read
// it raw and assert the load/merge/persist/flock structure is present.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROMPT_PATH = path.join(
  __dirname,
  '..',
  '..',
  'preseed',
  'agents',
  'claude',
  'plugins',
  'codeflare-vault',
  'scripts',
  'vault-extract-prompt.md',
);

function read() {
  return fs.readFileSync(PROMPT_PATH, 'utf8');
}

test('REQ-MEM-009 AC1: prompt loads a persistent vault-graph.json before merging', () => {
  const body = read();
  assert.match(
    body,
    /vault-graph\.json/,
    'prompt must reference /home/user/Vault/graphify-out/vault-graph.json',
  );
  // Must load before writing -- pattern: load path then later write same path.
  const firstRead = body.indexOf('vault-graph.json');
  const lastRead = body.lastIndexOf('vault-graph.json');
  assert.notStrictEqual(firstRead, lastRead, 'prompt must both read and write vault-graph.json');
});

test('REQ-MEM-009 AC2: prompt does a hash-keyed union of new chunk into persistent graph', () => {
  const body = read();
  // nx.compose (networkx) or an equivalent set-union step over nodes+edges.
  assert.match(
    body,
    /compose|nodes\.update|union|merge.*graph|graph.*merge/i,
    'prompt must spell out a node-union/merge step (e.g. nx.compose) so existing IDs dedupe',
  );
});

test('REQ-MEM-009 AC3: prompt feeds the persistent vault graph to `graphify global add --as user_vault`', () => {
  const body = read();
  assert.match(
    body,
    /graphify\s+global\s+add[\s\S]{0,200}--as\s+user_vault/,
    'prompt must run `graphify global add ... --as user_vault` to publish the cumulative vault graph',
  );
  // The argument to global add MUST be the persistent vault graph,
  // not the per-extraction chunk graph.
  assert.match(
    body,
    /graphify\s+global\s+add\s+[^\n]*vault-graph\.json[\s\S]{0,200}--as\s+user_vault/,
    'global add must consume vault-graph.json (not the per-chunk graph)',
  );
});

test('REQ-MEM-009 AC4: prompt handles missing/unreadable vault-graph.json by starting fresh', () => {
  const body = read();
  // Must spell out an "if not exists" / "try/except" guard around the load
  // so a fresh vault starts cleanly rather than crashing the haiku.
  assert.match(
    body,
    /try:[\s\S]{0,200}vault-graph\.json|exists\([^)]*vault-graph\.json|FileNotFoundError|JSONDecodeError|except\s+\(.+\)\s*:/i,
    'prompt must include a missing-file / parse-error guard around vault-graph.json load',
  );
});

test('REQ-MEM-009 AC5: merge + persist step runs under flock /tmp/graphify-global.lock', () => {
  const body = read();
  assert.match(
    body,
    /flock\s+\/tmp\/graphify-global\.lock/,
    'prompt must wrap the merge + global-add sequence with flock /tmp/graphify-global.lock to serialise with the capture pipeline',
  );
});
