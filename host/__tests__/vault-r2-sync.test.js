// REQ-MEM-004 backfill: vault contents synced to R2 across sessions.
//
// All assertions are static structural checks against entrypoint.sh
// (rclone filter ordering, idempotent init, lifecycle hooks).
// Behavioral E2E of round-trip persistence lives in the integration
// suite; this file covers the filter-shape correctness that nothing
// else asserts on.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

describe('Vault R2 sync filter shape (REQ-MEM-004)', () => {
  it('AC1: Vault/ + Uploads/ + Temporary/ are included in the common rclone filter', () => {
    // These three folders are user-persistent and must round-trip to
    // R2 in every SYNC_MODE.
    assert.ok(
      /--filter\s+"\+ Vault\/\*\*"/.test(entrypoint),
      'entrypoint.sh RCLONE_FILTERS_COMMON must include `+ Vault/**`'
    );
    assert.ok(
      /--filter\s+"\+ Uploads\/\*\*"/.test(entrypoint),
      'entrypoint.sh RCLONE_FILTERS_COMMON must include `+ Uploads/**`'
    );
    assert.ok(
      /--filter\s+"\+ Temporary\/\*\*"/.test(entrypoint),
      'entrypoint.sh RCLONE_FILTERS_COMMON must include `+ Temporary/**`'
    );
  });

  it('AC1: `+ Vault/**` precedes `- **/graphify-out/**` in the filter list', () => {
    // rclone applies filters in first-match order. The Vault include
    // MUST come BEFORE the graphify-out exclude, otherwise the vault's
    // own graphify-out/ subtree (which holds the vault knowledge
    // graph) would be silently skipped and the vault-extract pipeline
    // would never persist its output across sessions.
    const vaultIdx = entrypoint.indexOf('--filter "+ Vault/**"');
    const graphifyOutIdx = entrypoint.indexOf('--filter "- **/graphify-out/**"');
    assert.ok(vaultIdx > 0, 'entrypoint.sh must declare `+ Vault/**`');
    assert.ok(graphifyOutIdx > 0, 'entrypoint.sh must declare `- **/graphify-out/**`');
    assert.ok(
      vaultIdx < graphifyOutIdx,
      `Vault include must appear BEFORE the graphify-out exclude (Vault at ${vaultIdx}, graphify-out at ${graphifyOutIdx}). If reversed, rclone first-match would silently drop the vault's own graphify-out/.`
    );
  });

  it('AC2: initial_sync_from_r2 runs early and is called before vault init', () => {
    // The R2 pull must complete (or time out) before init_user_vault
    // runs, otherwise the vault skeleton would overwrite any preseed
    // pages the user had customised in R2.
    assert.ok(
      /^initial_sync_from_r2\(\)/m.test(entrypoint),
      'entrypoint.sh must define initial_sync_from_r2()'
    );
    const initialSyncDef = entrypoint.indexOf('initial_sync_from_r2() {');
    const initUserVaultDef = entrypoint.indexOf('init_user_vault() {');
    assert.ok(initialSyncDef > 0, 'entrypoint.sh must define initial_sync_from_r2');
    assert.ok(initUserVaultDef > 0, 'entrypoint.sh must define init_user_vault');
    // Both must be invoked in main body. Find their call sites.
    const initialSyncCall = entrypoint.indexOf('initial_sync_from_r2 &');
    const initUserVaultCall = entrypoint.indexOf('(init_user_vault)');
    assert.ok(initialSyncCall > 0, 'entrypoint.sh must invoke initial_sync_from_r2');
    assert.ok(initUserVaultCall > 0, 'entrypoint.sh must invoke (init_user_vault)');
    assert.ok(
      initialSyncCall < initUserVaultCall,
      'initial_sync_from_r2 invocation must occur BEFORE init_user_vault invocation'
    );
  });

  it('AC3: init_user_vault uses mkdir -p (idempotent) for required subdirectories', () => {
    // Every boot must be safe to re-run. mkdir -p means a returning
    // session with the vault already populated does not lose anything;
    // a fresh container creates the skeleton from scratch.
    const block = entrypoint.match(/init_user_vault\(\) \{[\s\S]+?\n\}/);
    assert.ok(block, 'entrypoint.sh must contain init_user_vault block');
    const body = block[0];
    // Required idempotent mkdirs.
    assert.ok(/mkdir -p "\$VAULT\/Raw\/Sessions"/.test(body),
      'init_user_vault must mkdir -p $VAULT/Raw/Sessions');
    assert.ok(/mkdir -p "\$VAULT\/Raw\/Sessions" "\$VAULT\/Raw\/Pasted" "\$VAULT\/Notes"/.test(body),
      'init_user_vault must mkdir -p the canonical user folders (Raw/Sessions, Raw/Pasted, Notes)');
  });

  it('AC3: preseed pages only overwrite when they differ from disk (cmp -s gate)', () => {
    // The four preseed pages (Index, CONFIG, README, STYLES) are
    // codeflare-authoritative. They must overwrite on each boot when
    // the preseed source has changed BUT must not bloat sync logs by
    // rewriting identical files every boot. The cmp -s guard handles
    // both requirements.
    assert.ok(
      /cmp -s "\$PRESEED_DIR\/\$PAGE" "\$VAULT\/\$PAGE"/.test(entrypoint),
      'init_user_vault must use cmp -s to skip identical preseed pages'
    );
  });

  it('AC4: bisync daemon triggers include 15-min cadence + SIGUSR1 + shutdown', () => {
    // The vault rides on the same bisync daemon as the rest of the
    // synced tree (the filter is shared). Confirm all three triggers
    // exist; the per-trigger details live in REQ-STOR-003 (cadence +
    // SIGUSR1) and REQ-STOR-005 (shutdown).
    assert.ok(/sleep 900 &/.test(entrypoint), 'AC4 (15-min cadence): entrypoint.sh must `sleep 900 &` in the daemon body');
    assert.ok(/trap.*USR1/.test(entrypoint), 'AC4 (SIGUSR1 trigger): entrypoint.sh must install a USR1 trap');
    assert.ok(/trap shutdown_handler SIGTERM SIGINT EXIT/.test(entrypoint),
      'AC4 (shutdown trigger): entrypoint.sh must trap shutdown_handler on SIGTERM/SIGINT/EXIT');
  });

  it('AC5: ~/.graphify/ is excluded from bisync (rebuilt per boot)', () => {
    // The global graph layer is a deterministic merge of per-source
    // graphs. R2 sync of it would race against on-boot rebuild and
    // produce stale state; the cleanest fix is no round-trip at all.
    assert.ok(
      /--filter\s+"- \.graphify\/\*\*"/.test(entrypoint),
      'entrypoint.sh RCLONE_FILTERS_COMMON must exclude `~/.graphify/**` (the unified global graph layer)'
    );
  });

  it('AC6: shutdown_handler watchdog is 120s for the final bisync', () => {
    // Final bisync gets the same 108s SIGTERM + 12s SIGKILL grace
    // pattern as REQ-STOR-005 AC4 — the vault inherits the budget
    // because it shares the same daemon and bisync invocation.
    assert.ok(
      /\(\s*sleep 108\s+kill_subtree TERM "\$BISYNC_PID"\s+sleep 12\s+kill_subtree KILL "\$BISYNC_PID"/.test(entrypoint),
      'shutdown_handler must run a 108s SIGTERM + 12s SIGKILL watchdog (120s total) so vault writes have time to flush'
    );
  });

  it('constraint: rclone S3 multipart settings prevent BadDigest TOCTOU races', () => {
    // disable_checksum = true skips X-Amz-Meta-Md5chksum metadata on
    // multipart uploads. --s3-upload-cutoff 0 forces ALL uploads
    // through the multipart path. Together they avoid the TOCTOU race
    // where rclone computes an md5 then the file mutates before
    // upload and R2 rejects the request with BadDigest.
    assert.ok(
      /disable_checksum\s*=\s*true/.test(entrypoint),
      'entrypoint.sh rclone config must set disable_checksum = true'
    );
    const cutoffMatches = entrypoint.match(/--s3-upload-cutoff 0/g) || [];
    assert.ok(
      cutoffMatches.length >= 2,
      `entrypoint.sh must pass --s3-upload-cutoff 0 to both --resync baseline AND periodic bisync (found ${cutoffMatches.length})`
    );
  });

  it('constraint: counter files are excluded from bisync', () => {
    // Per-session counter files at ~/.memory/counter/{session_id}.vars
    // are ephemeral. Syncing them would (a) waste R2 ops and (b)
    // leak counters between sessions on R2 pull, corrupting the next
    // session's hook gating logic.
    assert.ok(
      /--filter\s+"- \.memory\/counter\/\*\*"/.test(entrypoint),
      'entrypoint.sh must exclude `.memory/counter/**` from rclone bisync (per-session ephemeral state)'
    );
  });
});
