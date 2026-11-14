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
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureSmartCompact } from '../../preseed/agents/pi/extensions/00-smart-compact-config.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(__dirname, '../../entrypoint.sh');

// This behavioral suite must execute in CI; .github/workflows/test.yml installs
// rclone before the host tests. Fail loudly rather than silently skipping the
// load-bearing sync-policy assertions.
const rcloneCheck = spawnSync('bash', ['-lc', 'command -v rclone'], {
  encoding: 'utf-8',
});
assert.equal(
  rcloneCheck.status === 0 && rcloneCheck.stdout.trim() !== '',
  true,
  'rclone is required for entrypoint sync-filter behavioral tests',
);

// Slice entrypoint.sh from the VAULT_FILTER SESSION_MODE guard through the
// policy-mode terminal rule after the SYNC_MODE branch. This faithfully exercises the same
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
  const fiIdx = src.indexOf('# ============================================================================\n# Recovery filter', commonIdx);
  assert.ok(fiIdx !== -1, 'SYNC_MODE branch fi terminator missing');
  return src.slice(startIdx, fiIdx);
}

const filterSlice = extractFilterResolution();
const policyFunctions = extractManagedResourceFilterFunction();
const composeFixture = `
CODEFLARE_RUNTIME_ROOT=$(mktemp -d)
mkdir -p "$CODEFLARE_RUNTIME_ROOT/sync"
trap 'rm -rf "$CODEFLARE_RUNTIME_ROOT"' EXIT
USER_HOME="$CODEFLARE_RUNTIME_ROOT"
MANAGED_RESOURCE_FILTER_FILE="$CODEFLARE_RUNTIME_ROOT/sync/managed.filter"
RECOVERY_FILTER_FILE="$CODEFLARE_RUNTIME_ROOT/sync/recovery.filter"
: > "$RECOVERY_FILTER_FILE"
${policyFunctions}
compose_rclone_filters
`;

// Build a fixture tree that contains one representative path per filter
// category we care about, run the real filter array against it via
// `rclone lsf -R`, and return a verdict map { relPath: 'INCLUDED'|'EXCLUDED' }.
//
// Exercise production default-deny and composition, without test-only rules.
const verdictCache = new Map();
function verdictUnder({ sessionMode, syncMode = 'full', syncPolicyMode = 'include', extraFixtures = {} }) {
  const cacheKey = JSON.stringify({ sessionMode, syncMode, syncPolicyMode, extraFixtures });
  if (verdictCache.has(cacheKey)) return verdictCache.get(cacheKey);
  const fx = mkdtempSync(join(tmpdir(), 'rclone-filters-'));
  mkdirSync(join(fx, 'Vault/graphify-out'), { recursive: true });
  mkdirSync(join(fx, 'Uploads'), { recursive: true });
  mkdirSync(join(fx, 'Temporary'), { recursive: true });
  mkdirSync(join(fx, '.graphify'), { recursive: true });
  mkdirSync(join(fx, '.codeflare/review-state/v1/repo/branch'), { recursive: true });
  mkdirSync(join(fx, '.codeflare/review-state/v2/repo/branch'), { recursive: true });
  mkdirSync(join(fx, '.codeflare/herdr/sessions/cf-abc12345'), { recursive: true });
  mkdirSync(join(fx, '.codeflare/herdr/sessions/cf-other123'), { recursive: true });
  mkdirSync(join(fx, '.codeflare/classic/sessions/cf-abc12345'), { recursive: true });
  mkdirSync(join(fx, '.codeflare/classic/sessions/cf-other123'), { recursive: true });
  mkdirSync(join(fx, 'workspace/repo/graphify-out'), { recursive: true });
  mkdirSync(join(fx, '.cache/rclone'), { recursive: true });
  mkdirSync(join(fx, '.config/rclone'), { recursive: true });
  mkdirSync(join(fx, '.config/opencode/extensions/personal'), { recursive: true });
  mkdirSync(join(fx, '.codex/plugins/cache/catalog'), { recursive: true });
  mkdirSync(join(fx, '.codex/cache'), { recursive: true });
  mkdirSync(join(fx, '.copilot'), { recursive: true });
  mkdirSync(join(fx, '.claude/projects/repo/workflows'), { recursive: true });
  mkdirSync(join(fx, '.local/share/code-server/coder-logs'), { recursive: true });
  mkdirSync(join(fx, '.local/share/Trash/files'), { recursive: true });

  const fixtures = {
    'Vault/note.md': 'user vault note',
    'Vault/graphify-out/vault-graph.json': 'cumulative vault graph',
    'Vault/graphify-out/graph.json': 'per-run derived graph',
    'Vault/graphify-out/graph.html': 'rendered viz',
    'Vault/graphify-out/vault-extract-manifest.json': 'content-hash high-water mark',
    'Uploads/a.txt': 'upload tray file',
    'Temporary/b.txt': 'temporary tray file',
    '.graphify/global-graph.json': 'ephemeral unified graph',
    '.codeflare/ide-ui-state.json': '{"version":1}',
    '.codeflare/ide-extensions.json': '{"version":1,"extensions":{},"settings":{}}',
    '.codeflare/managed-extensions.json': '{"schemaVersion":1,"extensions":[]}',
    '.codeflare/managed-paths.json': '{"schemaVersion":1}',
    '.codeflare/review-state/v1/repo/branch/pr-42-main-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json': '{"version":1}',
    '.codeflare/review-state/v2/repo/branch/private.json': 'must stay local',
    '.codeflare/herdr/sessions/cf-abc12345/session.json': '{"version":3,"workspaces":[]}',
    '.codeflare/herdr/sessions/cf-abc12345/session-history.json': 'terminal output must stay local',
    '.codeflare/herdr/sessions/cf-abc12345/herdr.sock': 'socket must stay local',
    '.codeflare/herdr/sessions/cf-other123/session.json': '{"version":3,"workspaces":[]}',
    '.codeflare/classic/sessions/cf-abc12345/agent-session-id': '01991fc9-f25d-7000-8000-000000000001',
    '.codeflare/classic/sessions/cf-abc12345/private.json': 'must stay local',
    '.codeflare/classic/sessions/cf-other123/agent-session-id': '01991fc9-f25d-7000-8000-000000000002',
    '.codeflare/private-runtime.json': 'must stay local',
    'workspace/repo/graphify-out/g.json': 'repo graph artifact',
    '.cache/rclone/junk': 'ephemeral cache',
    '.config/rclone/rclone.conf': 'r2 secrets config',
    '.config/opencode/extensions/personal/index.ts': 'opencode personal resource',
    '.codex/plugins/cache/catalog/plugin.json': 'regenerable plugin catalog',
    '.codex/cache/index.json': 'regenerable codex cache',
    '.codex/logs_2.sqlite': 'regenerable codex log database',
    '.codex/logs_2.sqlite-wal': 'regenerable codex log wal',
    '.codex/logs_2.sqlite-shm': 'regenerable codex log shm',
    '.codex/thread_history_1.sqlite-wal': 'ephemeral codex transcript wal',
    '.codex/goals_1.sqlite-shm': 'ephemeral codex goals shm',
    '.claude/daemon-auth-status.json': 'ephemeral daemon auth status',
    '.claude/gh-pr-status-cache.json': 'regenerated PR status cache',
    '.local/share/code-server/coder-logs/code-server-stdout.log': 'ephemeral server log',
    '.local/share/Trash/files/old-note.md': 'discarded desktop file',
    '.copilot/session-store.db-wal': 'ephemeral copilot wal',
    '.copilot/session-store.db-shm': 'ephemeral copilot shm',
    '.claude/projects/repo/workflows/run.json': 'ephemeral workflow state',
    ...extraFixtures,
  };
  for (const [rel, body] of Object.entries(fixtures)) {
    mkdirSync(dirname(join(fx, rel)), { recursive: true });
    writeFileSync(join(fx, rel), body);
  }


  const script = [
    'set -u',
    `SESSION_MODE="${sessionMode}"`,
    'SESSION_ID="abc12345"',
    `SYNC_MODE="${syncMode}"`,
    `SYNC_POLICY_MODE="${syncPolicyMode}"`,
    filterSlice,
    composeFixture,
    `rclone lsf -R --files-only "\${RCLONE_EFFECTIVE_FILTERS[@]}" "$1" 2>/dev/null`,
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
  verdictCache.set(cacheKey, verdict);
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
  it('advanced mode: includes the vault tree AND its vault-graph.json despite the global graphify-out exclude (REQ-MEM-004 AC1 / REQ-VAULT-001 AC1)', () => {
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
      'EXCLUDED',
      'derived graphify-out HTML must not duplicate the served Raw/Graphs visualization in R2',
    );
    // REQ-VAULT-026: the content-hash manifest is the durable change-detection
    // high-water mark. It MUST ride along too, or a restored vault has no manifest
    // and gets re-extracted whole (the 200k-token bug). Same ordering guarantee.
    assert.equal(
      v['Vault/graphify-out/vault-extract-manifest.json'],
      'INCLUDED',
      'vault-extract content-hash manifest must persist to R2 (REQ-VAULT-026 allow-rule ordered before the graphify-out exclude)',
    );
    // Specificity guard: only the cumulative graph and content-hash manifest
    // are allow-listed; per-run graph.json and rendered graph.html fall through
    // to the graphify-out exclude. The served visualization persists separately
    // under Vault/Raw/Graphs/.
    assert.equal(
      v['Vault/graphify-out/graph.json'],
      'EXCLUDED',
      'per-run graph.json has no R2 value and must stay excluded',
    );
  });

  // -------------------------------------------------------------------------
  // REQ-MEM-004 AC5 / REQ-VAULT-001 AC2 — the derived/ephemeral graph
  //   layers are EXCLUDED so they are rebuilt on boot rather than carried
  //   stale. Two distinct surfaces:
  //     * Vault/graphify-out/graph.json (the per-run derived file)
  //     * .graphify/** (the ephemeral unified-graph workspace)
  // -------------------------------------------------------------------------
  it('advanced mode: excludes the per-run derived vault graph.json but keeps the cumulative one (REQ-MEM-004 AC5: derived layer not synced)', () => {
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

  it('advanced mode: excludes the ephemeral unified-graph workspace (.graphify) so it is rebuilt on boot (REQ-MEM-004 AC5 / REQ-VAULT-001 AC2)', () => {
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
  it('persists only Herdr structural session snapshots under .codeflare', () => {
    const v = verdictUnder({ sessionMode: 'default' });
    assert.equal(v['.codeflare/herdr/sessions/cf-abc12345/session.json'], 'INCLUDED');
    assert.equal(v['.codeflare/herdr/sessions/cf-abc12345/session-history.json'], 'EXCLUDED');
    assert.equal(v['.codeflare/herdr/sessions/cf-abc12345/herdr.sock'], 'EXCLUDED');
    assert.equal(v['.codeflare/herdr/sessions/cf-other123/session.json'], 'EXCLUDED');
  });

  it('REQ-AGENT-211 AC3: persists only the current classic agent-session binding', () => {
    const v = verdictUnder({ sessionMode: 'default' });
    assert.equal(v['.codeflare/classic/sessions/cf-abc12345/agent-session-id'], 'INCLUDED');
    assert.equal(v['.codeflare/classic/sessions/cf-abc12345/private.json'], 'EXCLUDED');
    assert.equal(v['.codeflare/classic/sessions/cf-other123/agent-session-id'], 'EXCLUDED');
  });

  it('default mode: positively excludes the entire vault tree (REQ-MEM-006 AC1)', () => {
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

  it('default vs advanced differ ONLY on the vault tree; the user trays sync in both modes (REQ-MEM-006 AC1: mode gate is scoped to Vault)', () => {
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

  it('REQ-IDE-002 AC6 / REQ-STOR-031 AC1: syncs bounded Browser IDE manifests and managed policy', () => {
    for (const sessionMode of ['advanced', 'default']) {
      const v = verdictUnder({ sessionMode });
      assert.equal(v['.codeflare/ide-ui-state.json'], 'INCLUDED');
      assert.equal(v['.codeflare/ide-extensions.json'], 'INCLUDED');
      assert.equal(v['.codeflare/managed-extensions.json'], 'INCLUDED');
      assert.equal(v['.codeflare/managed-paths.json'], 'INCLUDED');
      assert.equal(v['.codeflare/private-runtime.json'], 'EXCLUDED');
      assert.equal(v['.config/opencode/extensions/personal/index.ts'], 'INCLUDED');
    }
  });

  it('REQ-STOR-011 AC4: disposable agent checkouts never sync while user trays remain persistent', () => {
    const disposable = [
      'Temporary/.agent-work/sdk-research/source.ts',
      'Temporary/codeflare-sdk-audit/src/lib/agent-seed.generated.ts',
      'Temporary/codeflare-sdk-audit-lock-prep/.github/workflows/prepare-sdk-audit-lock.yml',
      'Temporary/codeflare-questionnaire-timeout/graphify-out/graph.json',
      'Temporary/native-promise-proof-20261025/worker.mjs',
      'Temporary/operator-native-release-20261025/native-worker.mjs',
      'Temporary/dispatcher-v0.1.32-4034621/operator-package.tar.gz',
    ];
    const persistent = [
      'Temporary/codeflare-sdk-audit-notes.md',
      'Temporary/.agent-work-notes.md',
      'Temporary/personal-project/src/index.ts',
      'Temporary/Review/recovery-20261027/questionnaire-current.patch',
      'Uploads/a.txt',
    ];
    const extraFixtures = Object.fromEntries([...disposable, ...persistent].map(path => [path, 'fixture']));
    for (const sessionMode of ['advanced', 'default']) {
      for (const syncMode of ['none', 'metadata', 'full']) {
        const v = verdictUnder({ sessionMode, syncMode, extraFixtures });
        for (const path of disposable) assert.equal(v[path], 'EXCLUDED', `${path} must stay local in ${sessionMode}/${syncMode}`);
        for (const path of persistent) assert.equal(v[path], 'INCLUDED', `${path} must persist in ${sessionMode}/${syncMode}`);
      }
    }
  });

  it('REQ-STOR-011 AC4: excludes only root Pi work-evidence in every sync scope', () => {
    const evidence = '.pi/agent/work-evidence/investigation/report.json';
    const adjacent = '.pi/agent/work-evidence.json';
    const nested = 'Temporary/preserved/.pi/agent/work-evidence/report.json';
    for (const sessionMode of ['advanced', 'default']) {
      for (const syncMode of ['none', 'metadata', 'full']) {
        const v = verdictUnder({ sessionMode, syncMode, extraFixtures: {
          [evidence]: 'disposable investigation artifact', [adjacent]: 'unrelated user file',
          [nested]: 'explicit user tray content', '.pi/agent/settings.json': '{"fixture":true}',
        } });
        assert.equal(v[evidence], 'EXCLUDED', `${evidence} must not sync in ${sessionMode}/${syncMode}`);
        for (const keep of [adjacent, nested, '.pi/agent/settings.json']) assert.equal(v[keep], 'INCLUDED');
      }
    }
  });

  it('persists user-scoped review completion in every workspace sync mode', () => {
    const marker = '.codeflare/review-state/v1/repo/branch/pr-42-main-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json';
    for (const sessionMode of ['advanced', 'default']) {
      for (const syncMode of ['none', 'metadata', 'full']) {
        const v = verdictUnder({ sessionMode, syncMode });
        assert.equal(v[marker], 'INCLUDED', `${marker} must sync in ${sessionMode}/${syncMode}`);
        assert.equal(v['.codeflare/review-state/v2/repo/branch/private.json'], 'EXCLUDED');
        assert.equal(v['.codeflare/private-runtime.json'], 'EXCLUDED');
      }
    }
  });

  // -------------------------------------------------------------------------
  // REQ-STOR-004 AC6 — known per-session ephemeral / regenerable categories
  //   are statically excluded from ALL sync operations (mode-independent).
  //   Representative paths: ~/.cache/** and ~/.config/rclone/** (R2 secrets),
  //   plus the per-repo graphify-out artifacts that live in git, not R2.
  // -------------------------------------------------------------------------
  it('statically excludes ephemeral caches, repo graphify-out, and R2 secrets in both modes (REQ-STOR-004 AC6 / REQ-AGENT-026 AC1)', () => {
    for (const sessionMode of ['advanced', 'default']) {
      const v = verdictUnder({ sessionMode });
      const excluded = [
        '.cache/rclone/junk',
        '.config/rclone/rclone.conf',
        'workspace/repo/graphify-out/g.json',
        '.codex/plugins/cache/catalog/plugin.json',
        '.codex/cache/index.json',
        '.codex/logs_2.sqlite',
        '.codex/logs_2.sqlite-wal',
        '.codex/logs_2.sqlite-shm',
        '.codex/thread_history_1.sqlite-wal',
        '.codex/goals_1.sqlite-shm',
        '.claude/daemon-auth-status.json',
        '.claude/gh-pr-status-cache.json',
        '.local/share/code-server/coder-logs/code-server-stdout.log',
        '.local/share/Trash/files/old-note.md',
        '.copilot/session-store.db-wal',
        '.copilot/session-store.db-shm',
        '.claude/projects/repo/workflows/run.json',
      ];
      for (const rel of excluded) {
        assert.equal(
          v[rel],
          'EXCLUDED',
          `${rel} must stay out of R2 in ${sessionMode} mode`,
        );
      }
    }
  });
});

function extractManagedResourceFilterFunction() {
  const src = readFileSync(ENTRYPOINT, 'utf8');
  const start = src.indexOf('prepare_managed_resource_filter() {');
  const end = src.indexOf('\n# Step 1: One-way sync FROM R2 TO local', start);
  assert.ok(start >= 0 && end > start, 'managed-resource filter function missing');
  return src.slice(start, end);
}

describe('REQ-STOR-011 / REQ-AGENT-223: Smart Compact settings round-trip', () => {
  for (const sessionMode of ['default', 'advanced']) {
    for (const syncMode of ['none', 'metadata', 'full']) {
      for (const section of ['smartCompact', 'semanticCompact']) {
        it(`REQ-STOR-011 / REQ-AGENT-223: preserves user Smart Compact preferences through rclone upload, restore, and startup (${sessionMode}/${syncMode}/${section})`, (t) => {
          const fx = mkdtempSync(join(tmpdir(), 'smart-compact-roundtrip-'));
          t.after(() => rmSync(fx, { recursive: true, force: true }));
          const home = join(fx, 'home');
          const remote = join(fx, 'fake-remote');
          const restored = join(fx, 'restored-home');
          const settings = '.pi/agent/settings.json';
          mkdirSync(dirname(join(home, settings)), { recursive: true });
          // Deliberately sparse and noncanonical: neither omitted upstream options
          // nor whitespace may be changed when the restored extension starts.
          const bytes = `{\n\t"theme": "user-theme",\n\t"${section}" : { "mode": "fast", "autoTrigger": false, "futureOption": { "keep": [false, 0] } }\n}\n\n`;
          writeFileSync(join(home, settings), bytes);
          const script = [
            'set -eu',
            'SESSION_MODE="$1"',
            'SYNC_MODE="$2"',
            'SESSION_ID="abc12345"',
            'SYNC_POLICY_MODE=include',
            filterSlice,
            composeFixture,
            // Both endpoints are local directories. The empty config guarantees
            // no cloud credentials/configuration are used by the real rclone.
            'rclone sync --config /dev/null "${RCLONE_EFFECTIVE_FILTERS[@]}" "$3" "$4"',
            'rclone sync --config /dev/null "${RCLONE_EFFECTIVE_FILTERS[@]}" "$4" "$5"',
          ].join('\n');
          const result = spawnSync('bash', ['-c', script, '_', sessionMode, syncMode, home, remote, restored], { encoding: 'utf8' });
          assert.equal(result.status, 0, result.stderr);
          assert.equal(readFileSync(join(remote, settings), 'utf8'), bytes, 'upload must persist settings with the real entrypoint filters');
          assert.equal(readFileSync(join(restored, settings), 'utf8'), bytes, 'container restore must recover the exact user settings');

          configureSmartCompact(join(restored, '.pi/agent'));

          assert.equal(readFileSync(join(restored, settings), 'utf8'), bytes, 'startup after restore must not fill or reset user Smart Compact preferences');
        });
      }
    }
  }
});

describe('REQ-STOR-031 managed-resource rclone filter', () => {
  const functionSource = extractManagedResourceFilterFunction();

  it('validates canonical exclusive identity and excludes exact paths and roots while preserving adjacent paths', () => {
    const fx = mkdtempSync(join(tmpdir(), 'managed-filter-'));
    const runtime = join(fx, 'run');
    const policyPath = join(fx, '.codeflare/managed-paths.json');
    const filterPath = join(runtime, 'managed-resources.filter');
    mkdirSync(dirname(policyPath), { recursive: true });
    mkdirSync(runtime, { recursive: true });
    mkdirSync(join(fx, '.claude/extensions/personal'), { recursive: true });
    mkdirSync(join(fx, '.claude/skills-other'), { recursive: true });
    const releaseDigest = 'd'.repeat(64);
    const policy = {
      schemaVersion: 1,
      releaseDigest,
      resourcePolicy: 'exclusive',
      paths: ['.claude/extensions/company/index.ts', '.codeflare/managed-paths.json'],
      resourceRoots: ['.claude/extensions/'],
    };
    const bytes = Buffer.from(`${JSON.stringify(policy)}\n`);
    writeFileSync(policyPath, bytes);
    writeFileSync(join(fx, '.claude/extensions/personal/index.ts'), 'personal');
    writeFileSync(join(fx, '.claude/skills-other/personal.md'), 'adjacent');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const script = `${functionSource}\nprepare_managed_resource_filter`;
    const prepared = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        USER_HOME: fx,
        MANAGED_RESOURCE_FILTER_FILE: filterPath,
        MANAGED_RESOURCE_POLICY: 'exclusive',
        REMOTE_CURATION_RELEASE_DIGEST: releaseDigest,
        MANAGED_RESOURCE_PATHS_DIGEST: digest,
      },
    });
    assert.equal(prepared.status, 0, prepared.stderr);

    const listed = spawnSync('rclone', ['lsf', '-R', '--files-only', '--filter-from', filterPath, fx], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout.includes('.claude/extensions/personal/index.ts'), false);
    assert.equal(listed.stdout.includes('.codeflare/managed-paths.json'), false);
    assert.equal(listed.stdout.includes('.claude/skills-other/personal.md'), true);
  });

  it('rejects an oversized policy before Node reads it', () => {
    const fx = mkdtempSync(join(tmpdir(), 'managed-filter-oversized-'));
    const runtime = join(fx, 'run');
    const policyPath = join(fx, '.codeflare/managed-paths.json');
    const filterPath = join(runtime, 'managed-resources.filter');
    mkdirSync(dirname(policyPath), { recursive: true });
    mkdirSync(runtime, { recursive: true });
    writeFileSync(policyPath, Buffer.alloc(8 * 1024 * 1024 + 1));
    const prepared = spawnSync('bash', ['-c', `${functionSource}\nprepare_managed_resource_filter`], {
      encoding: 'utf8',
      env: {
        ...process.env, USER_HOME: fx, MANAGED_RESOURCE_FILTER_FILE: filterPath,
        MANAGED_RESOURCE_POLICY: 'immutable', REMOTE_CURATION_RELEASE_DIGEST: 'd'.repeat(64),
        MANAGED_RESOURCE_PATHS_DIGEST: 'e'.repeat(64),
      },
    });
    assert.notEqual(prepared.status, 0);
    assert.match(prepared.stderr, /exceeds 8 MiB/);
  });

  it('mutable reset removes stale policy and filter before baseline', () => {
    const fx = mkdtempSync(join(tmpdir(), 'managed-filter-mutable-'));
    const runtime = join(fx, 'run');
    const policyPath = join(fx, '.codeflare/managed-paths.json');
    const filterPath = join(runtime, 'managed-resources.filter');
    mkdirSync(dirname(policyPath), { recursive: true });
    mkdirSync(runtime, { recursive: true });
    writeFileSync(policyPath, '{}');
    writeFileSync(filterPath, '- /**\n');
    const prepared = spawnSync('bash', ['-c', `${functionSource}\nprepare_managed_resource_filter`], {
      encoding: 'utf8',
      env: { ...process.env, USER_HOME: fx, MANAGED_RESOURCE_FILTER_FILE: filterPath, MANAGED_RESOURCE_POLICY: 'mutable' },
    });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(readFileSync(filterPath, 'utf8'), '');
    assert.equal(spawnSync('test', ['!', '-e', policyPath]).status, 0);
  });
});

describe('REQ-STOR-053: regenerable Python artifacts stay outside home sync', () => {
  for (const sessionMode of ['default', 'advanced']) {
    for (const syncMode of ['full', 'metadata', 'none']) {
      it(`excludes Python environments and bytecode without hiding adjacent user files (${sessionMode}/${syncMode})`, () => {
        const roots = ['', 'Uploads/', 'Temporary/', 'Vault/', 'workspace/repo/', '.config/opencode/', '.pi/agent/', '.codeflare/review-state/v1/'];
        const excluded = ['.venv/pyvenv.cfg', '.venv/lib/python3.11/site-packages/module.py', '.venv-ytdlp/bin/yt-dlp', '.venv-tools/pyvenv.cfg', '__pycache__/module.cpython-311.pyc', '__pycache__/index.json', 'module.pyc', 'module.pyo'];
        const retained = ['module.py', 'requirements.txt', 'pyproject.toml', 'uv.lock', '.venv-notes.md', '.venv', '.venv-ytdlp', '.venvish/notes.md', 'venv/source.py', 'site-packages/source.py', '__pycache__notes.md', 'module.pyc.txt'];
        // A file named .venv is deliberately preserved; only directories with
        // that name are excluded. Exercise file and directory cases separately.
        const fixture = {};
        for (const root of roots) {
          for (const path of excluded) fixture[`${root}${path}`] = 'regenerable';
          for (const path of retained.filter((p) => p !== '.venv' && p !== '.venv-ytdlp')) fixture[`${root}${path}`] = 'user content';
          fixture[`${root}files/.venv`] = 'user file';
          fixture[`${root}files/.venv-ytdlp`] = 'user file';
        }
        const verdict = verdictUnder({ sessionMode, syncMode, extraFixtures: fixture });
        for (const root of roots) {
          for (const path of excluded) assert.equal(verdict[`${root}${path}`], 'EXCLUDED', `${root}${path}`);
          const included = root !== '' && !(root === 'Vault/' && sessionMode === 'default') && !(root === 'workspace/repo/' && syncMode !== 'full');
          for (const path of [...retained.filter((p) => p !== '.venv' && p !== '.venv-ytdlp'), 'files/.venv', 'files/.venv-ytdlp']) {
            assert.equal(verdict[`${root}${path}`], included ? 'INCLUDED' : 'EXCLUDED', `${root}${path}`);
          }
        }
      });
    }
  }
});

// Synthetic public inventory: no deployed keys, policy bytes or customer digests.
const durablePaths = [
  ...['.claude', '.codex', '.copilot', '.gemini', '.pi/agent', '.config/opencode'].map(root => `${root}/future-sdk/nested/new-state.opaque`),
  '.claude.json', '.claude.json.bak.preclean', '.claude_unleashed_consent',
  '.gitconfig', '.bash_history', '.profile', '.zshrc',
  '.pi/agent/npm/package.json', '.pi/agent/npm/package-lock.json',
  '.pi/agent/npm/custom-package/src/main.ts', '.claude/mcp.migrated.archive',
  '.pi/agent/mcp.json.migrated', '.pi/agent/cache-knowledge/notes.bin',
  '.pi/web-search.json', '.pi/recovery/config-archive/original.json',
  '.pi/future-sdk/nested/state.opaque', '.impeccable/config.json',
  '.vscode-oss-shared/sharedStorage/state.vscdb', '.local/share/applications/custom.desktop',
  '.local/share/pki/nssdb/cert9.db', '.local/share/nvim/user-state',
  '.local/share/chrome-devtools-mcp/user-config.json',
  '.local/share/code-server/User/globalStorage/state.vscdb', '.local/bin/personal-tool',
  'Getting Started.md', 'Documentation/new/topic.md', 'Examples/arbitrary.bin',
  'Uploads/photo.bin', 'Temporary/notes', 'Operators/personal/config.json',
];
const fallbackPaths = ['unknown-home/new-file', '.unknown-sdk/auth.json', 'nested/.claude/settings.json'];
const transientPaths = [
  'workspace/repo/node_modules/package/index.js',
  '.config/other/auth.json', '.cache/nested/durable-looking.json',
  '.cache/root-state', '.venv/pyvenv.cfg', '.venv-tools/bin/python',
  '.impeccable/update-check.json', '.impeccable/staleness-check.json',
  '.pi/agent/new/deep/node_modules/pkg/index.js', '.pi/agent/new/.cache/result',
  '.pi/agent/new/.venv/lib/module.py', '.claude/new/__pycache__/mod.pyc',
  '.local/state/session', '.local/share/Trash/files/trash',
  '.local/share/chrome-devtools-mcp/telemetry_state.json',
  '.claude.json.backup.123', '.claude/backups/settings.before.json',
  '.claude/commands.bak.123', '.claude/settings.json.bak123',
  '.claude/skills.bak.123/skill.md', '.claude/history.jsonl',
  ...['.npm', '.bun', '.wrangler', '.context-mode'].flatMap(cache => [`workspace/repo/${cache}/nested/state`, `.pi/agent/plugin/${cache}/nested/state`]),
  '.config/opencode/graphify-out/graph.json', 'Uploads/project/graphify-out/graph.json',
];
const vaultPaths = ['Vault/attachment.bin', 'Vault/graphify-out/vault-graph.json',
  'Vault/graphify-out/vault-extract-manifest.json', 'Vault/graphify-out/vault-extract-initialized'];
const workspacePaths = ['workspace/repo/.git/HEAD', 'workspace/repo/.gitignore',
  'workspace/repo/ignored.bin', 'workspace/repo/untracked', 'workspace/repo/CLAUDE.md',
  'workspace/repo/.claude/future/settings'];
const governedRoots = ['.claude', '.codex', '.copilot', '.gemini', '.pi/agent', '.config/opencode']
  .flatMap(root => ['skills', 'extensions', 'commands'].map(category => `${root}/${category}/`));
const governedPaths = [...governedRoots.map(root => `${root}managed/item`),
  '.codeflare/managed-extensions.json', '.codeflare/managed-paths.json',
  '.pi/agent/extensions/synthetic-retired.ts'].sort();

function persistenceFixture(t, { sessionMode = 'advanced', syncMode = 'full', syncPolicyMode = 'include', policy = 'immutable' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'persistence-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const remote = join(root, 'remote');
  const runtime = join(root, 'runtime');
  for (const directory of [home, remote, join(runtime, 'sync/rclone')]) mkdirSync(directory, { recursive: true });
  const put = (base, path, bytes) => {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), bytes);
  };
  put(home, '.pi/agent/sentinel', 'unchanged ordinary state');
  const releaseDigest = createHash('sha256').update('synthetic-release').digest('hex');
  const policyBytes = `${JSON.stringify({ schemaVersion: 1, releaseDigest, resourcePolicy: policy,
    paths: governedPaths, resourceRoots: policy === 'exclusive' ? governedRoots.sort() : [] })}\n`;
  const digest = createHash('sha256').update(policyBytes).digest('hex');
  const config = join(root, 'rclone.conf');
  writeFileSync(config, '[r2]\ntype = local\n');
  writeFileSync(join(runtime, 'sync/recovery.filter'), '');
  const source = readFileSync(ENTRYPOINT, 'utf8');
  const shellFunction = name => source.slice(source.indexOf(`${name}() {`), source.indexOf('\n}\n', source.indexOf(`${name}() {`)) + 3);
  const setup = `set -eu
USER_HOME=${JSON.stringify(home)}
CODEFLARE_RUNTIME_ROOT=${JSON.stringify(runtime)}
SYNC_RUNTIME_DIR="$CODEFLARE_RUNTIME_ROOT/sync"
MANAGED_RESOURCE_FILTER_FILE="$SYNC_RUNTIME_DIR/managed.filter"
RECOVERY_FILTER_FILE="$SYNC_RUNTIME_DIR/recovery.filter"
RCLONE_CONFIG=${JSON.stringify(config)}
R2_BUCKET_NAME=${JSON.stringify(remote)}
MANAGED_RESOURCE_POLICY=${policy}
REMOTE_CURATION_RELEASE_DIGEST=${releaseDigest}
MANAGED_RESOURCE_PATHS_DIGEST=${digest}
SESSION_ID=abc12345
SESSION_MODE=${sessionMode}
SYNC_MODE=${syncMode}
${syncPolicyMode === null ? 'unset SYNC_POLICY_MODE' : `SYNC_POLICY_MODE=${JSON.stringify(syncPolicyMode)}`}
${filterSlice}
${policyFunctions}
source ${JSON.stringify(resolve(__dirname, '../../scripts/rclone-conflict-cleanup.sh'))}
${shellFunction('initial_sync_from_r2')}
${shellFunction('record_sync_disk_failure')}
${shellFunction('establish_bisync_baseline')}
${shellFunction('bisync_with_r2')}
${shellFunction('shutdown_handler')}
cleanup_main_transcripts() { :; }
cleanup_remote_pi_transcript_conflicts() { :; }
repair_hook_exec_bits() { :; }
`;
  const run = (commands, success = true) => {
    const result = spawnSync('bash', ['-c', `${setup}\n${commands}`], { encoding: 'utf8', timeout: 30000 });
    if (success) assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    else {
      assert.notEqual(result.status, null, `fixture interrupted: ${result.error ?? result.signal}`);
      assert.notEqual(result.status, 0);
    }
    return result;
  };
  return { home, remote, runtime, put, run, policyBytes };
}

describe('REQ-STOR-002/004/011/031/032: production persistence policy matrix', () => {
  it('REQ-AGENT-217 AC5: native preparation excludes only retired root stock from a real local baseline', t => {
    const fx = persistenceFixture(t, { policy: 'mutable' });
    const stock = '{"mcpServers":{"personal":{"command":"personal-server"}}}';
    fx.put(fx.home, '.pi/agent/mcp.json', stock);
    fx.put(fx.remote, '.pi/agent/mcp.json', 'retired remote must not return');
    for (const path of ['.pi/agent/mcp.json.migrated.saved', '.pi/agent/nested/mcp.json', '.pi/agent/nested/mcp-adapter.json']) {
      fx.put(fx.home, path, `retained ${path}`);
    }
    const source = readFileSync(ENTRYPOINT, 'utf8');
    const start = source.indexOf('configure_pi_mcp_adapter() {');
    const end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start);
    fx.run(`${source.slice(start, end)}\nconfigure_pi_mcp_adapter ${JSON.stringify(resolve(__dirname, '../../preseed/agents/pi/extensions/00-mcp-adapter-config.ts'))}\nestablish_bisync_baseline`);
    assert.equal(existsSync(join(fx.home, '.pi/agent/mcp.json')), false);
    assert.equal(readFileSync(join(fx.remote, '.pi/agent/mcp.json'), 'utf8'), 'retired remote must not return');
    assert.deepEqual(JSON.parse(readFileSync(join(fx.remote, '.pi/agent/mcp-adapter.json'), 'utf8')).mcpServers.personal, { command: 'personal-server' });
    assert.equal(readFileSync(join(fx.remote, '.pi/agent/mcp.json.migrated'), 'utf8'), stock);
    for (const path of ['.pi/agent/mcp.json.migrated.saved', '.pi/agent/nested/mcp.json', '.pi/agent/nested/mcp-adapter.json']) {
      assert.equal(readFileSync(join(fx.remote, path), 'utf8'), `retained ${path}`);
    }
  });

  it('REQ-VAULT-026 AC2: durable extraction manifest bytes survive local baseline and ordinary bisync restore', t => {
    const fx = persistenceFixture(t, { policy: 'mutable' });
    const path = 'Vault/graphify-out/vault-extract-manifest.json';
    const manifest = '{"files":{"Notes/persisted.md":{"sha256":"synthetic-content-hash"}}}\n';
    fx.put(fx.remote, path, manifest);
    fx.put(fx.remote, 'Vault/Notes/unchanged.md', 'unchanged user note');
    fx.run('initial_sync_from_r2\nestablish_bisync_baseline');
    assert.equal(readFileSync(join(fx.home, path), 'utf8'), manifest);
    const updated = '{"files":{"Notes/updated.md":{"sha256":"updated-content-hash"}}}\n';
    fx.put(fx.remote, path, updated);
    fx.run('bisync_with_r2 ""');
    assert.equal(readFileSync(join(fx.home, path), 'utf8'), updated);
    assert.equal(readFileSync(join(fx.remote, path), 'utf8'), updated);
    assert.equal(readFileSync(join(fx.home, 'Vault/Notes/unchanged.md'), 'utf8'), 'unchanged user note');
    assert.equal(readFileSync(join(fx.remote, 'Vault/Notes/unchanged.md'), 'utf8'), 'unchanged user note');
  });
  for (const syncPolicyMode of ['include', 'exclude']) {
    for (const sessionMode of ['default', 'advanced']) for (const syncMode of ['none', 'metadata', 'full']) {
      for (const curation of [false, true]) for (const immutable of [false, true]) {
        const protectedMode = curation && immutable;
        it(`${syncPolicyMode}/${sessionMode}/${syncMode}/curation=${curation}/immutable=${immutable}: ${protectedMode ? 'protected' : 'mutable (protected mode requires active curation and immutability)'}`, t => {
          const fx = persistenceFixture(t, { sessionMode, syncMode, syncPolicyMode, policy: protectedMode ? 'immutable' : 'mutable' });
          const all = [...durablePaths, ...fallbackPaths, ...transientPaths, ...vaultPaths, ...workspacePaths,
            ...governedPaths.filter(path => path !== '.codeflare/managed-paths.json'), 'Vault/graphify-out/derived.bin'];
          for (const path of all) fx.put(fx.home, path, Buffer.from(`synthetic:${path}\0`));
          fx.put(fx.home, '.codeflare/managed-paths.json', fx.policyBytes);
          const expected = new Set([
            ...durablePaths,
            ...(syncPolicyMode === 'exclude' ? fallbackPaths : []),
            ...(sessionMode === 'advanced' ? vaultPaths : []),
            ...workspacePaths.filter(path => syncMode === 'full' || (syncMode === 'metadata' && (path.endsWith('CLAUDE.md') || path.includes('/.claude/')))),
            ...(!protectedMode ? governedPaths.filter(path => path !== '.codeflare/managed-paths.json') : []),
          ]);
          fx.run('compose_rclone_filters\nrclone copy --config "$RCLONE_CONFIG" "${RCLONE_EFFECTIVE_FILTERS[@]}" "$USER_HOME" "r2:$R2_BUCKET_NAME"');
          const restored = join(fx.runtime, 'restored');
          fx.run(`compose_rclone_filters\nrclone copy --config "$RCLONE_CONFIG" "\${RCLONE_EFFECTIVE_FILTERS[@]}" "r2:$R2_BUCKET_NAME" ${JSON.stringify(restored)}`);
          for (const base of [fx.remote, restored]) {
            for (const path of all) {
              assert.equal(existsSync(join(base, path)), expected.has(path), `${syncPolicyMode}: ${path}`);
              if (expected.has(path)) assert.deepEqual(readFileSync(join(base, path)), readFileSync(join(fx.home, path)), path);
            }
            assert.equal(existsSync(join(base, '.codeflare/managed-paths.json')), false, 'normal transfer never republishes the policy document');
          }
        });
      }
    }
  }

  it('REQ-STOR-011: missing policy-mode ENV defaults to Exclude and persists unknown in-scope files', t => {
    const fx = persistenceFixture(t, { policy: 'mutable', syncPolicyMode: null });
    for (const path of fallbackPaths) fx.put(fx.home, path, 'unknown namespace bytes');
    fx.put(fx.home, '.config/other/auth.json', 'excluded configuration');
    fx.run('compose_rclone_filters\nrclone copy --config "$RCLONE_CONFIG" "${RCLONE_EFFECTIVE_FILTERS[@]}" "$USER_HOME" "r2:$R2_BUCKET_NAME"');
    for (const path of fallbackPaths) assert.equal(readFileSync(join(fx.remote, path), 'utf8'), 'unknown namespace bytes');
    assert.equal(existsSync(join(fx.remote, '.config/other/auth.json')), false);
  });

  it('REQ-STOR-011: invalid policy-mode ENV fails closed before any copy', t => {
    const fx = persistenceFixture(t, { policy: 'mutable', syncPolicyMode: 'not-a-policy' });
    fx.put(fx.home, '.pi/agent/never-uploaded', 'local bytes');
    fx.run('initial_sync_from_r2\ncompose_rclone_filters\nrclone copy --config "$RCLONE_CONFIG" "${RCLONE_EFFECTIVE_FILTERS[@]}" "$USER_HOME" "r2:$R2_BUCKET_NAME"', false);
    assert.equal(existsSync(join(fx.remote, '.pi/agent/never-uploaded')), false);
    assert.equal(readFileSync(join(fx.home, '.pi/agent/never-uploaded'), 'utf8'), 'local bytes');
  });

  for (const syncPolicyMode of ['include', 'exclude']) {
    it(`REQ-STOR-031/032: bootstrap restores authority; protected baseline and repeated cycles preserve vetoed bytes and propagate ordinary deletions (${syncPolicyMode})`, t => {
      const fx = persistenceFixture(t, { policy: 'exclusive', syncPolicyMode });
      fx.put(fx.remote, '.codeflare/managed-paths.json', fx.policyBytes);
      for (const root of governedRoots) {
        fx.put(fx.remote, `${root}managed/item`, 'authoritative');
        fx.put(fx.remote, `${root}personal/item`, 'governed extra');
      }
      fx.put(fx.remote, '.codeflare/managed-extensions.json', 'authoritative metadata');
      fx.put(fx.remote, '.pi/agent/personal-state', 'remote ordinary');
      fx.run('initial_sync_from_r2');
      assert.equal(readFileSync(join(fx.home, governedPaths[0]), 'utf8'), 'authoritative');
      for (const root of governedRoots) fx.put(fx.home, `${root}managed/item`, 'local protected change');
      fx.put(fx.home, '.codeflare/managed-extensions.json', 'local metadata change');
      fx.put(fx.home, '.pi/agent/deletion', 'delete from local');
      fx.put(fx.remote, '.pi/agent/remote-deletion', 'delete from remote');
      fx.run('establish_bisync_baseline');
      rmSync(join(fx.home, '.pi/agent/deletion'));
      rmSync(join(fx.remote, '.pi/agent/remote-deletion'));
      fx.run('bisync_with_r2 ""\nbisync_with_r2 ""');
      assert.equal(existsSync(join(fx.remote, '.pi/agent/deletion')), false);
      assert.equal(existsSync(join(fx.home, '.pi/agent/remote-deletion')), false);
      for (const root of governedRoots) {
        assert.equal(readFileSync(join(fx.remote, `${root}managed/item`), 'utf8'), 'authoritative');
        assert.equal(readFileSync(join(fx.home, `${root}managed/item`), 'utf8'), 'local protected change');
      }
      assert.equal(readFileSync(join(fx.remote, '.codeflare/managed-extensions.json'), 'utf8'), 'authoritative metadata');
      assert.equal(readFileSync(join(fx.home, '.pi/agent/personal-state'), 'utf8'), 'remote ordinary');
      fx.put(fx.home, '.pi/agent/final-upload', 'final local');
      fx.put(fx.remote, '.pi/agent/final-download', 'final remote');
      fx.run(`TERMINAL_PID=""
  kill_pidfile_subtree() { :; }
  pgrep() { return 1; }
  sleep() { if [ "$1" -gt 10 ] 2>/dev/null; then command sleep 10; else command sleep "$@"; fi; }
  set +e
  shutdown_handler`);
      assert.equal(readFileSync(join(fx.remote, '.pi/agent/final-upload'), 'utf8'), 'final local');
      assert.equal(readFileSync(join(fx.home, '.pi/agent/final-download'), 'utf8'), 'final remote');
      assert.equal(readFileSync(join(fx.remote, '.codeflare/managed-extensions.json'), 'utf8'), 'authoritative metadata');
    });

    it(`REQ-STOR-003/004/031: recovery veto wins over namespace positives and invalid policy prevents baseline and ordinary sync I/O (${syncPolicyMode})`, t => {
      const fx = persistenceFixture(t, { syncPolicyMode });
      fx.put(fx.home, '.codeflare/managed-paths.json', fx.policyBytes);
      fx.put(fx.home, '.pi/agent/recovering', 'local recovery');
      fx.put(fx.remote, '.pi/agent/recovering', 'remote recovery');
      writeFileSync(join(fx.runtime, 'sync/recovery.filter'), '- /.pi/agent/recovering\n');
      fx.run('establish_bisync_baseline\nbisync_with_r2 ""');
      assert.equal(readFileSync(join(fx.home, '.pi/agent/recovering'), 'utf8'), 'local recovery');
      assert.equal(readFileSync(join(fx.remote, '.pi/agent/recovering'), 'utf8'), 'remote recovery');
      fx.put(fx.home, '.pi/agent/never-uploaded', 'private local bytes');
      for (const invalid of [null, '{}\n', fx.policyBytes.replace('schemaVersion":1', 'schemaVersion":2')]) {
        if (invalid === null) rmSync(join(fx.home, '.codeflare/managed-paths.json'), { force: true });
        else fx.put(fx.home, '.codeflare/managed-paths.json', invalid);
        fx.run('establish_bisync_baseline', false);
        fx.run('bisync_with_r2 ""', false);
        assert.equal(existsSync(join(fx.remote, '.pi/agent/never-uploaded')), false);
      }
    });
  }

  it('REQ-STOR-031: rejects unsafe canonical paths even with matching policy identity', t => {
    const fx = persistenceFixture(t, { policy: 'exclusive' });
    fx.put(fx.home, '.pi/agent/never-uploaded', 'private local bytes');
    const base = JSON.parse(fx.policyBytes);
    const invalidPaths = ['../escape', '.pi//agent/settings', '/absolute', '.pi/./agent/settings',
      '.pi/agent/new\n+ /**', '.pi/agent/new\rline', '.pi/agent/new\u0000line', '.pi\\agent\\settings',
      '.pi/agent/' + 'x'.repeat(512)];
    for (const path of invalidPaths) {
      for (const key of ['paths', 'resourceRoots']) {
        const value = { ...base, [key]: [key === 'resourceRoots' ? `${path}/` : path] };
        const bytes = `${JSON.stringify(value)}\n`;
        const digest = createHash('sha256').update(bytes).digest('hex');
        fx.put(fx.home, '.codeflare/managed-paths.json', bytes);
        const result = fx.run(`MANAGED_RESOURCE_PATHS_DIGEST=${digest}\nestablish_bisync_baseline`, false);
        assert.match(result.stderr, /managed policy path (?:is invalid|is not canonical|exceeds byte limit)/);
        assert.equal(existsSync(join(fx.remote, '.pi/agent/never-uploaded')), false);
      }
    }
  });
  for (const initialMode of ['include', 'exclude']) {
    const nextMode = initialMode === 'include' ? 'exclude' : 'include';
    it(`REQ-STOR-011/045: restart policy flip ${initialMode} to ${nextMode} preserves unselected data and propagates admitted deletion`, t => {
      const fx = persistenceFixture(t, { policy: 'mutable', syncPolicyMode: initialMode });
      const fallback = 'unknown-home/transition.bin';
      fx.put(fx.home, fallback, 'old local');
      fx.put(fx.remote, fallback, 'new remote');
      fx.put(fx.home, '.pi/agent/delete-after-transition', 'ordinary data');
      for (const [side, date] of [['home', '2025-01-01'], ['remote', '2026-01-01']]) {
        const time = new Date(date);
        utimesSync(join(fx[side], fallback), time, time);
      }
      fx.run('establish_bisync_baseline');
      if (initialMode === 'exclude') {
        assert.equal(readFileSync(join(fx.home, fallback), 'utf8'), 'new remote');
        fx.put(fx.home, fallback, 'independent local');
        fx.put(fx.remote, fallback, 'independent remote');
      }
      const scope = `SYNC_POLICY_MODE=${nextMode}\n${filterSlice}\n`;
      fx.run(scope + 'establish_bisync_baseline');
      assert.equal(readFileSync(join(fx.home, fallback), 'utf8'), nextMode === 'exclude' ? 'new remote' : 'independent local');
      assert.equal(readFileSync(join(fx.remote, fallback), 'utf8'), nextMode === 'exclude' ? 'new remote' : 'independent remote');
      rmSync(join(fx.home, '.pi/agent/delete-after-transition'));
      fx.run(scope + 'bisync_with_r2 ""');
      assert.equal(existsSync(join(fx.remote, '.pi/agent/delete-after-transition')), false);
    });
  }

  it('REQ-STOR-011/045: restart scope migration keeps excluded old data while admitted deletions still propagate', t => {
    const fx = persistenceFixture(t, { policy: 'mutable', syncMode: 'full' });
    fx.put(fx.home, 'workspace/user.bin', 'local user bytes');
    fx.put(fx.remote, 'unknown-home/old.bin', 'existing remote excluded');
    fx.put(fx.home, 'unknown-home/old.bin', 'existing local excluded');
    fx.put(fx.home, '.pi/agent/live', 'ordinary live');
    for (const winner of ['home', 'remote']) {
      const path = `.pi/agent/newer-${winner}`;
      for (const side of ['home', 'remote']) {
        fx.put(fx[side], path, side === winner ? 'newest ordinary bytes' : 'older ordinary bytes');
        const time = new Date(side === winner ? '2026-01-01' : '2025-01-01');
        utimesSync(join(fx[side], path), time, time);
      }
    }
    fx.run('establish_bisync_baseline');
    for (const winner of ['home', 'remote']) for (const side of ['home', 'remote']) {
      assert.equal(readFileSync(join(fx[side], `.pi/agent/newer-${winner}`), 'utf8'), 'newest ordinary bytes');
    }
    fx.run('SYNC_MODE=none\n' + filterSlice + '\nestablish_bisync_baseline\nbisync_with_r2 ""');
    assert.equal(readFileSync(join(fx.remote, 'workspace/user.bin'), 'utf8'), 'local user bytes');
    assert.equal(readFileSync(join(fx.remote, 'unknown-home/old.bin'), 'utf8'), 'existing remote excluded');
    assert.equal(readFileSync(join(fx.home, 'unknown-home/old.bin'), 'utf8'), 'existing local excluded');
    rmSync(join(fx.home, '.pi/agent/live'));
    fx.run('SYNC_MODE=none\n' + filterSlice + '\nbisync_with_r2 ""');
    assert.equal(existsSync(join(fx.remote, '.pi/agent/live')), false);
  });
});
