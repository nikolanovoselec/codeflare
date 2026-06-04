// Contract audit (intentionally structural) for memory-agent-prompt.md.
//
// SCOPE: The artifact under test is an LLM instruction prompt — its
// "behavior" is what the sonnet subagent will execute. The graphify Python
// block + flock-protected `graphify global add --as user_vault` step are the
// contract text that the subagent reads and runs verbatim; if those exact
// strings drift, the merge step silently breaks even though the prompt
// itself looks fine. A real end-to-end test would require spawning the
// memory-capture subagent against a fixture transcript (live LLM call,
// out of scope for the unit/CI tier). This file therefore asserts the
// contract strings exist; the Python it embeds is well-defined and
// graphify-internal, separately covered by the graphify package's own
// tests.
//
// AC6 (REQ-MEM-001): the prompt folds the chunk into the cumulative
// vault-graph.json via the shared merge-vault-graph.py (REQ-MEM-009),
// flock-guarded, rather than building a throwaway per-chunk graph. This is
// what keeps captures from clobbering prior vault knowledge in the global graph.
//
// AC7 (REQ-MEM-001): the merge step into the unified global graph must
// run under flock -w 5 /tmp/graphify-global.lock so concurrent writers
// (vault-extract pipeline, other capture subagents) serialise their
// merges; and the merge command must be `graphify global add ... --as
// user_vault` so the unified graph dedupes against existing vault
// content rather than treating it as a fresh source.
//
// Located under host/__audits__/ so it does NOT run as part of
// `npm test` and does not count toward unit coverage. Run on demand:
//   node --test host/__audits__/*.audit.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const PROMPT_PATH = resolve(
  repoRoot,
  'preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md',
);
const prompt = readFileSync(PROMPT_PATH, 'utf8');

describe('memory-agent-prompt.md contract (REQ-MEM-001)', () => {
  // REQ-MEM-001 AC6: cumulative-merge step via the shared merge-vault-graph.py
  it('AC6: prompt folds the chunk into the cumulative vault-graph.json via merge-vault-graph.py under flock', () => {
    // The capture must accumulate into the persistent vault-graph.json
    // (REQ-MEM-009), not build a throwaway per-chunk graph. Removing this step
    // silently makes every capture clobber prior vault knowledge once global-add
    // runs. Gut-check: delete the merge-vault-graph.py line and this fails.
    assert.ok(
      /flock\s+-w\s+5\s+\/tmp\/graphify-global\.lock[\s\S]{0,200}merge-vault-graph\.py/.test(prompt),
      'prompt must invoke merge-vault-graph.py under flock -w 5 /tmp/graphify-global.lock (AC6 - cumulative chunk merge)',
    );
    // It must NOT reintroduce the throwaway inline build that global-adds a
    // per-chunk graph (the old clobbering design).
    assert.ok(
      !/from\s+graphify\.build\s+import\s+build_from_json/.test(prompt),
      'prompt must not rebuild a throwaway per-chunk graph inline (that clobbers prior vault knowledge)',
    );
  });

  // REQ-MEM-001 AC7: flock-protected merge into unified global graph
  it('AC7: prompt declares the merge step under flock -w 5 /tmp/graphify-global.lock', () => {
    // The flock lock serialises concurrent writers to the unified global
    // graph at ~/.graphify/global-graph.json. Without it, two captures
    // landing in the same 5s window can corrupt the JSON merge.
    // -w 5 means "wait up to 5 seconds for the lock"; longer timeouts
    // would block the subagent indefinitely; shorter timeouts would
    // cause false failures under bursty capture load.
    assert.ok(
      /flock\s+-w\s+5\s+\/tmp\/graphify-global\.lock/.test(prompt),
      'prompt must guard the merge step with flock -w 5 /tmp/graphify-global.lock (AC7 - concurrent-writer serialisation)',
    );
  });

  // REQ-MEM-001 AC7: the merge command itself
  it('AC7: prompt declares graphify global add ... --as user_vault as the merge command', () => {
    // --as user_vault is the layer label that lets the unified global
    // graph dedupe vault concepts across captures. Using a different
    // label (or omitting --as) would treat each capture as a fresh
    // source and explode the concept-node count.
    assert.ok(
      /graphify\s+global\s+add\s+[\s\S]{0,200}vault-graph\.json[\s\S]{0,200}--as\s+user_vault/.test(prompt),
      'prompt must run `graphify global add <vault-graph.json> --as user_vault` (AC7 - cumulative layer-keyed merge, not the per-chunk graph)',
    );
  });
});
