// REQ-MEM-009 AC5: deterministic Pi session-memory graph chunks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(
  __dirname,
  '..',
  '..',
  'preseed',
  'agents',
  'pi',
  'scripts',
  'build-memory-graph.py',
);

const TARGET = '/home/user/Vault/Raw/Sessions/2026-07-14T16-22-00-session.md';

test('REQ-MEM-009 AC5: session graph uses its title, canonical concepts, and unique edges', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-graph-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const note = path.join(directory, 'capture.md');
  const output = path.join(directory, 'chunk.json');
  fs.writeFileSync(note, `# Session 2026-07-14 - Bounded Extraction Agent Tuning

## Decisions

- Run both [[Vault Extraction]] and [[Session Extraction]].
- Repeat [[Vault Extraction]] with [[Session Extraction]] without duplicating their relationship.
- Perform [[Pi Reload|reload]] and keep [[Pi Reload]] canonical.
`, 'utf8');

  const result = spawnSync('python3', [SCRIPT, note, TARGET, output], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);

  const graph = JSON.parse(fs.readFileSync(output, 'utf8'));
  const documentId = 'vault_raw_sessions_2026_07_14t16_22_00_session';
  assert.deepEqual(
    graph.nodes.map((node) => node.id).sort(),
    [
      'concept_pi_reload',
      'concept_session_extraction',
      'concept_vault_extraction',
      documentId,
    ],
  );
  assert.deepEqual(
    graph.nodes.find((node) => node.id === documentId),
    {
      id: documentId,
      label: 'Session 2026-07-14 - Bounded Extraction Agent Tuning',
      file_type: 'document',
      source_file: TARGET,
      source_location: null,
      source_url: null,
      captured_at: null,
      author: null,
      contributor: null,
    },
  );
  assert.ok(
    graph.nodes
      .filter((node) => node.file_type === 'concept')
      .every((node) => node.id.startsWith('concept_') && node.source_file === null),
  );

  const edgeKeys = graph.edges.map((edge) => [
    edge.source,
    edge.target,
    edge.relation,
    edge.source_file,
  ].join('\0'));
  assert.equal(new Set(edgeKeys).size, edgeKeys.length);
  assert.deepEqual(
    graph.edges
      .filter((edge) => edge.relation === 'references')
      .map((edge) => edge.target)
      .sort(),
    ['concept_pi_reload', 'concept_session_extraction', 'concept_vault_extraction'],
  );
  assert.deepEqual(
    graph.edges
      .filter((edge) => edge.relation === 'conceptually_related_to')
      .map((edge) => [edge.source, edge.target]),
    [['concept_session_extraction', 'concept_vault_extraction']],
  );
});
