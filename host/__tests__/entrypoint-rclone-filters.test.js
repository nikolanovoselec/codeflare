// Real behavioral tests for the rclone sync-filter construction in
// entrypoint.sh.
//
// These replace the source-string-matching audits in
// host/__audits__/entrypoint-vault.audit.js and
// host/__audits__/entrypoint-initial-sync.audit.js (which asserted the
// script TEXT contained `--filter "+ Vault/**"` etc. — assertions that
// stay green even if the filter array is replaced with a no-op, reordered
// so the exclude wins, or gutted entirely). Per tdd-discipline /
// engineering-constitution mandate 2 we assert on the OBSERVABLE RESULT of
// RUNNING the real filter array: we slice the actual `VAULT_FILTER` +
// `RCLONE_FILTERS_COMMON` resolution out of entrypoint.sh, source it under
// a chosen SESSION_MODE / SYNC_MODE, and drive `rclone lsf -R` against a
// real on-disk fixture. The pass/fail signal is which paths rclone
// actually keeps after applying the first-match filter rules, not whether
// a substring is present.
//
// Mirrors the proven harness in host/__tests__/entrypoint-hooks-merge.test.js
// (`workspaceSyncEnabled scope` describe) which already drives `rclone lsf`
// against an extracted RCLONE_FILTERS_COMMON slice for the SYNC_MODE
// branch; this file extends the same technique to the SESSION_MODE
// VAULT_FILTER branch (the part that precedes the COMMON header).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(__dirname, '../../entrypoint.sh');

// rclone may or may not be on the runner. Skip cleanly when absent so the
// suite stays meaningful on dev boxes (same guard as entrypoint-hooks-merge).
const rcloneCheck = spawnSync('bash', ['-lc', 'command -v rclone'], {
  encoding: 'utf-8',
});
const rcloneAvailable =
  rcloneCheck.status === 0 && rcloneCheck.stdout.trim() !== '';

// Slice entrypoint.sh from the VAULT_FILTER SESSION_MODE guard through the
// closing `fi` of the SYNC_MODE branch. This faithfully exercises the same
// filter-resolution path the container runs at boot: the SESSION_MODE
// branch builds VAULT_FILTER, RCLONE_FILTERS_COMMON expands it in order,
// and the SYNC_MODE branch finalizes RCLONE_FILTERS. If the file shape
// changes the slice breaks loudly rather than silently passing.
function extractFilterResolution() {
  const src = readFileSync(ENTRYPOINT, 'utf8');
  const startIdx = src.indexOf(
    'if [ "${SESSION_MODE:-default}" = "advanced" ]; then',
  );
  assert.ok(startIdx !== -1, 'VAULT_FILTER SESSION_MODE guard missing');
  const commonIdx = src.indexOf('RCLONE_FILTERS_COMMON=(', startIdx);
  assert.ok(commonIdx !== -1, 'RCLONE_FILTERS_COMMON header missing');
  const fiIdx = src.indexOf('\nfi\n', commonIdx);
  assert.ok(fiIdx !== -1, 'SYNC_MODE branch fi terminator missing');
  return src.slice(startIdx, fiIdx + 3);
}

const filterSlice = extractFilterResolution();

// Build a fixture tree that contains one representative path per filter
// category we care about, run the real filter array against it via
// `rclone lsf -R`, and return a verdict map { relPath: 'INCLUDED'|'EXCLUDED' }.
//
// The trailing `--filter "- **"` makes the default action "exclude", so a
// path only appears in the listing if a positive rule in the real array
// matched it first (rclone first-match semantics) — exactly how the
// container's bisync decides what round-trips to R2.
function verdictUnder({ sessionMode, syncMode = 'full' }) {
  const fx = mkdtempSync(join(tmpdir(), 'rclone-filters-'));
  mkdirSync(join(fx, 'Vault/graphify-out'), { recursive: true });
  mkdirSync(join(fx, 'Uploads'), { recursive: true });
  mkdirSync(join(fx, 'Temporary'), { recursive: true });
  mkdirSync(join(fx, '.graphify'), { recursive: true });
  mkdirSync(join(fx, 'workspace/repo/graphify-out'), { recursive: true });
  mkdirSync(join(fx, '.cache/rclone'), { recursive: true });
  mkdirSync(join(fx, '.config/rclone'), { recursive: true });

  const fixtures = {
    'Vault/note.md': 'user vault note',
    'Vault/graphify-out/vault-graph.json': 'cumulative vault graph',
    'Vault/graphify-out/graph.json': 'per-run derived graph',
    'Vault/graphify-out/graph.html': 'rendered viz',
    'Uploads/a.txt': 'upload tray file',
    'Temporary/b.txt': 'temporary tray file',
    '.graphify/global-graph.json': 'ephemeral unified graph',
    'workspace/repo/graphify-out/g.json': 'repo graph artifact',
    '.cache/rclone/junk': 'ephemeral cache',
    '.config/rclone/rclone.conf': 'r2 secrets config',
  };
  for (const [rel, body] of Object.entries(fixtures)) {
    writeFileSync(join(fx, rel), body);
  }

  const script = [
    'set -u',
    `SESSION_MODE="${sessionMode}"`,
    `SYNC_MODE="${syncMode}"`,
    filterSlice,
    // List everything that survives the real filter array. Default-deny
    // tail so only positively-matched paths appear.
    'rclone lsf -R --files-only "${RCLONE_FILTERS[@]}" --filter "- **" "$1" 2>/dev/null',
  ].join('\n');

  const res = spawnSync('bash', ['-c', script, '_', fx], { encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(
      `rclone filter harness failed (exit ${res.status}):\nstderr=${res.stderr}\nstdout=${res.stdout}`,
    );
  }
  const kept = new Set(
    res.stdout
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const verdict = {};
  for (const rel of Object.keys(fixtures)) {
    verdict[rel] = kept.has(rel) ? 'INCLUDED' : 'EXCLUDED';
  }
  return verdict;
}

describe('entrypoint.sh rclone filter behavior (real) / REQ-MEM-004 (vault in R2 sync) / REQ-MEM-006 (advanced-only) / REQ-VAULT-001 (vault filter order) / REQ-STOR-004 (static excludes)', () => {
  // -------------------------------------------------------------------------
  // REQ-MEM-004 AC1 — vault tree (including its own graphify-out source of
  //                   truth) is INCLUDED in R2 sync in advanced mode.
  // REQ-VAULT-001 AC1 — vault include rule is ordered BEFORE the global
  //                   **/graphify-out/** exclude, so the vault's own
  //                   graphify-out source-of-truth rides along.
  // -------------------------------------------------------------------------
  it('advanced mode: includes the vault tree AND its vault-graph.json despite the global graphify-out exclude (REQ-MEM-004 AC1 / REQ-VAULT-001 AC1)', { skip: !rcloneAvailable && 'rclone not installed' }, () => {
    const v = verdictUnder({ sessionMode: 'advanced' });

    assert.equal(
      v['Vault/note.md'],
      'INCLUDED',
      'advanced mode must sync the vault tree to R2',
    );
    // The load-bearing ordering assertion: the global `- **/graphify-out/**`
    // exclude would swallow Vault/graphify-out/ entirely unless the vault
    // include rules are positioned BEFORE it (rclone first-match). If the
    // VAULT_FILTER block were moved after the exclude, this flips to EXCLUDED.
    assert.equal(
      v['Vault/graphify-out/vault-graph.json'],
      'INCLUDED',
      'vault graphify-out source-of-truth must ride along (include ordered before the global graphify-out exclude)',
    );
    assert.equal(
      v['Vault/graphify-out/graph.html'],
      'INCLUDED',
      'rendered vault viz (graph.html) must persist',
    );
  });

  // -------------------------------------------------------------------------
  // REQ-MEM-004 AC5 / REQ-VAULT-001 AC2 — the derived/ephemeral graph
  //   layers are EXCLUDED so they are rebuilt on boot rather than carried
  //   stale. Two distinct surfaces:
  //     * Vault/graphify-out/graph.json (the per-run derived file)
  //     * .graphify/** (the ephemeral unified-graph workspace)
  // -------------------------------------------------------------------------
  it('advanced mode: excludes the per-run derived vault graph.json but keeps the cumulative one (REQ-MEM-004 AC5: derived layer not synced)', { skip: !rcloneAvailable && 'rclone not installed' }, () => {
    const v = verdictUnder({ sessionMode: 'advanced' });
    assert.equal(
      v['Vault/graphify-out/graph.json'],
      'EXCLUDED',
      'the per-run derived graph.json must NOT round-trip (regenerated next extraction)',
    );
    assert.equal(
      v['Vault/graphify-out/vault-graph.json'],
      'INCLUDED',
      'control: the cumulative vault-graph.json IS kept — proving the exclude is scoped to derived files, not the whole dir',
    );
  });

  it('advanced mode: excludes the ephemeral unified-graph workspace (.graphify) so it is rebuilt on boot (REQ-MEM-004 AC5 / REQ-VAULT-001 AC2)', { skip: !rcloneAvailable && 'rclone not installed' }, () => {
    const v = verdictUnder({ sessionMode: 'advanced' });
    assert.equal(
      v['.graphify/global-graph.json'],
      'EXCLUDED',
      'the ephemeral unified global-graph workspace must NOT sync (regenerated from per-source graphs on boot)',
    );
  });

  // -------------------------------------------------------------------------
  // REQ-MEM-006 AC1 — in DEFAULT mode the entire Vault tree is positively
  //   EXCLUDED, so cross-session persistence is advanced-mode-only. The
  //   Uploads/Temporary trays still sync in both modes.
  // -------------------------------------------------------------------------
  it('default mode: positively excludes the entire vault tree (REQ-MEM-006 AC1)', { skip: !rcloneAvailable && 'rclone not installed' }, () => {
    const v = verdictUnder({ sessionMode: 'default' });
    assert.equal(
      v['Vault/note.md'],
      'EXCLUDED',
      'default mode must NOT sync vault content to R2 (advanced-only affordance)',
    );
    assert.equal(
      v['Vault/graphify-out/vault-graph.json'],
      'EXCLUDED',
      'default mode must NOT sync even the vault graph',
    );
  });

  it('default vs advanced differ ONLY on the vault tree; the user trays sync in both modes (REQ-MEM-006 AC1: mode gate is scoped to Vault)', { skip: !rcloneAvailable && 'rclone not installed' }, () => {
    const adv = verdictUnder({ sessionMode: 'advanced' });
    const def = verdictUnder({ sessionMode: 'default' });

    // Gut-check: the mode gate must flip the vault verdict...
    assert.notEqual(
      adv['Vault/note.md'],
      def['Vault/note.md'],
      'SESSION_MODE must change the vault sync verdict (the gate is real, not a no-op)',
    );
    // ...but must NOT change the user-facing trays, which sync regardless.
    for (const tray of ['Uploads/a.txt', 'Temporary/b.txt']) {
      assert.equal(adv[tray], 'INCLUDED', `${tray} must sync in advanced mode`);
      assert.equal(def[tray], 'INCLUDED', `${tray} must sync in default mode too`);
    }
  });

  // -------------------------------------------------------------------------
  // REQ-STOR-004 AC6 — known per-session ephemeral / regenerable categories
  //   are statically excluded from ALL sync operations (mode-independent).
  //   Representative paths: ~/.cache/** and ~/.config/rclone/** (R2 secrets),
  //   plus the per-repo graphify-out artifacts that live in git, not R2.
  // -------------------------------------------------------------------------
  it('statically excludes ephemeral caches and the R2-secret rclone config in both modes (REQ-STOR-004 AC6)', { skip: !rcloneAvailable && 'rclone not installed' }, () => {
    for (const sessionMode of ['advanced', 'default']) {
      const v = verdictUnder({ sessionMode });
      assert.equal(
        v['.cache/rclone/junk'],
        'EXCLUDED',
        `~/.cache/** must be excluded (regenerable) in ${sessionMode} mode`,
      );
      assert.equal(
        v['.config/rclone/rclone.conf'],
        'EXCLUDED',
        `~/.config/rclone/** (R2 secrets) must never round-trip in ${sessionMode} mode`,
      );
      assert.equal(
        v['workspace/repo/graphify-out/g.json'],
        'EXCLUDED',
        `per-repo graphify-out artifacts must stay out of R2 in ${sessionMode} mode (they live in git)`,
      );
    }
  });
});
