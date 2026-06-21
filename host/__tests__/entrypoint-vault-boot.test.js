// Real behavioral tests for the vault boot path in entrypoint.sh.
//
// These replace the source-string-matching theater in
// host/__audits__/entrypoint-vault.audit.js (which used
// entrypoint.indexOf(...) / .includes(...) / regex on the source text —
// assertions that pass even if the shell logic is replaced with a
// no-op). Per tdd-discipline / engineering-constitution mandate 2, we
// assert on OBSERVABLE SIDE EFFECTS of RUNNING the shell:
//
//   * REQ-MEM-004 AC2: extract the real boot block that orders the calls,
//     stub establish_bisync_baseline + init_user_vault (and the daemon
//     starters) so they append a marker to a log, run the block in a
//     bash subshell, and assert the baseline marker is logged BEFORE the
//     vault-init marker.
//   * REQ-MEM-004 AC3: extract the real init_user_vault body, point it at
//     a temp HOME + temp preseed dir, pre-populate the vault with user
//     content, run init_user_vault TWICE, and assert nothing the user
//     owns was clobbered and no duplicate creation happened.
//   * REQ-VAULT-007 AC5: extract the real init_user_vault body, run it
//     against a preseed plug, assert the plug is copied into
//     Library/Codeflare; run again with identical content and assert the
//     copy is a no-op (mtime unchanged) but a changed preseed plug DOES
//     overwrite (idempotent overwrite-on-diff).
//
// Mirrors the harness pattern in entrypoint-bisync-behavior.test.js:
// extract a function/block body at test time, stub its dependencies with
// bash functions that log, spawn in a bash subshell via spawnSync, assert
// on side effects (log contents, files on disk, mtimes), not source text.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(__dirname, '../../entrypoint.sh');

// ---------------------------------------------------------------------------
// Extraction helpers — read the source ONLY to slice out runnable shell.
// We never assert on the sliced text; we execute it and assert on effects.
// ---------------------------------------------------------------------------

// Extract a top-level `name() { ... }` body (header to matching `^}`),
// same shape as extractDaemonBody() in entrypoint-bisync-behavior.test.js.
function extractFunctionBody(name) {
  const lines = readFileSync(ENTRYPOINT, 'utf8').split('\n');
  let start = -1;
  let end = -1;
  const header = new RegExp(`^${name}\\(\\) \\{`);
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && header.test(lines[i])) start = i;
    else if (start !== -1 && /^\}$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start === -1 || end === -1) {
    throw new Error(`Could not locate ${name}() in entrypoint.sh`);
  }
  return lines.slice(start, end + 1).join('\n');
}

// Extract the boot block that establishes the bisync baseline and then
// initializes the vault (the `if [ $RCLONE_CONFIG_RESULT ... ] ... fi`
// guard near the end of MAIN EXECUTION). Anchored on the unique step
// comment so the slice tracks the real ordering logic, not a copy.
function extractBootOrderingBlock() {
  const lines = readFileSync(ENTRYPOINT, 'utf8').split('\n');
  const anchor = lines.findIndex((l) =>
    /^# Step 2: Establish bisync baseline IN BACKGROUND/.test(l),
  );
  if (anchor === -1) {
    throw new Error('Could not locate the "Step 2" baseline boot anchor in entrypoint.sh');
  }
  // The `if [ $RCLONE_CONFIG_RESULT ... ]; then` opens a few lines after
  // the anchor; find it, then walk to its matching `^fi`.
  let ifIdx = -1;
  for (let i = anchor; i < lines.length; i++) {
    if (/^if \[ \$RCLONE_CONFIG_RESULT/.test(lines[i])) {
      ifIdx = i;
      break;
    }
  }
  if (ifIdx === -1) throw new Error('Could not locate the RCLONE_CONFIG_RESULT boot guard');
  let fiIdx = -1;
  for (let i = ifIdx + 1; i < lines.length; i++) {
    if (/^fi$/.test(lines[i])) {
      fiIdx = i;
      break;
    }
  }
  if (fiIdx === -1) throw new Error('Could not locate the closing fi of the boot guard');
  return lines.slice(ifIdx, fiIdx + 1).join('\n');
}

function mkTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Run a bash script, return { status, stdout, stderr }.
function runBash(script) {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
}

describe('entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)', () => {
  // -------------------------------------------------------------------------
  // REQ-MEM-004 AC2 — establish_bisync_baseline runs BEFORE init_user_vault.
  // -------------------------------------------------------------------------
  it('runs establish_bisync_baseline BEFORE init_user_vault at boot (REQ-MEM-004 AC2)', () => {
    const dir = mkTmp('vault-boot-order-');
    const logFile = join(dir, 'order.log');
    const bootBlock = extractBootOrderingBlock();

    // Stub every dependency the boot block calls. The two we care about
    // (baseline, vault init) append a timestamped marker so we can assert
    // ordering from the log. The daemon starters are stubbed to no-ops so
    // the block runs to completion without launching real background work.
    // We strip the trailing `&` so the `( ... )` subshell runs
    // synchronously (its body still preserves the in-shell call order),
    // and `wait` afterward catches any backgrounded child.
    const script = `
      set +e
      establish_bisync_baseline() {
        echo "BASELINE $(date +%s%N)" >> "${logFile}"
        return 0
      }
      init_user_vault() {
        echo "VAULT_INIT $(date +%s%N)" >> "${logFile}"
        return 0
      }
      start_sync_daemon() { echo "SYNC_DAEMON" >> "${logFile}"; }
      start_vault_monitor_daemon() { echo "VAULT_MONITOR" >> "${logFile}"; }
      start_silverbullet_supervisor() { echo "SB_SUPERVISOR" >> "${logFile}"; }
      # Make the boot guard pass.
      RCLONE_CONFIG_RESULT=0
      STEP1_RESULT=0
      SESSION_MODE=default

      ${bootBlock.replace(/\) &$/m, ')')}

      wait 2>/dev/null
    `;

    const res = runBash(script);
    assert.equal(res.status, 0, `boot block must run cleanly; stderr: ${res.stderr}`);
    assert.ok(existsSync(logFile), 'boot block must have produced a log');
    const log = readFileSync(logFile, 'utf8');

    const baselineIdx = log.indexOf('BASELINE');
    const vaultIdx = log.indexOf('VAULT_INIT');
    assert.notEqual(baselineIdx, -1, 'establish_bisync_baseline must be invoked at boot');
    assert.notEqual(vaultIdx, -1, 'init_user_vault must be invoked at boot');
    assert.ok(
      baselineIdx < vaultIdx,
      `establish_bisync_baseline must run BEFORE init_user_vault so the R2 pull ` +
        `precedes the skeleton write. Got log:\n${log}`,
    );
  });

  // -------------------------------------------------------------------------
  // REQ-MEM-004 AC3 — init_user_vault is existence-guarded idempotent.
  // REQ-VAULT-007 AC5 — per-boot Library/Codeflare plug copy is idempotent
  //                     overwrite-on-diff.
  // Both exercise the SAME real init_user_vault body, so they share a file
  // with separate it() blocks per the task brief.
  // -------------------------------------------------------------------------

  // Build a runnable harness around the real init_user_vault body:
  //  - point USER_HOME at a temp dir
  //  - override PRESEED_DIR (it is `local` inside the function, so we
  //    patch the literal assignment to our temp preseed root)
  //  - stub `graphify` lookups (command -v graphify -> not found) so the
  //    global-add block is a no-op and needs no real graphify binary
  // Returns the rendered script that runs init_user_vault N times.
  function buildInitVaultHarness({ userHome, preseedDir, runs = 1 }) {
    let body = extractFunctionBody('init_user_vault');
    // Repoint the function's local PRESEED_DIR at our temp preseed root.
    body = body.replace(
      /local PRESEED_DIR=\/opt\/silverbullet-preseed/,
      `local PRESEED_DIR=${preseedDir}`,
    );
    const calls = Array.from({ length: runs }, () => 'init_user_vault >/dev/null 2>&1').join('\n');
    return `
      set +e
      # Force the graphify global-add branch to be skipped: shadow the
      # builtin lookup so 'command -v graphify' reports "not found".
      command() {
        if [ "$1" = "-v" ] && [ "$2" = "graphify" ]; then return 1; fi
        builtin command "$@"
      }
      USER_HOME=${userHome}
      export USER_HOME

      ${body}

      ${calls}
    `;
  }

  it('init_user_vault does not clobber existing user vault content on re-run (REQ-MEM-004 AC3)', () => {
    const root = mkTmp('vault-idem-');
    const userHome = join(root, 'home');
    const preseedDir = join(root, 'preseed');
    const vault = join(userHome, 'Vault');

    // A preseed page (preseed-authoritative — overwrite-on-diff) and a
    // user note (user-owned — must never be touched).
    mkdirSync(preseedDir, { recursive: true });
    writeFileSync(join(preseedDir, 'Index.md'), 'PRESEED INDEX V1\n');

    // Pre-populate the vault as a "returning session" would look after the
    // R2 pull: a user note + a populated graph + the preseed page already
    // matching preseed (so the overwrite-on-diff branch is a no-op).
    mkdirSync(join(vault, 'Notes'), { recursive: true });
    mkdirSync(join(vault, 'graphify-out'), { recursive: true });
    const userNote = join(vault, 'Notes', 'my-secret-note.md');
    writeFileSync(userNote, 'USER WROTE THIS — do not touch\n');
    writeFileSync(join(vault, 'Index.md'), 'PRESEED INDEX V1\n'); // identical to preseed
    const populatedGraph = '{"directed":true,"nodes":[{"id":"real"}],"links":[]}';
    writeFileSync(join(vault, 'graphify-out', 'graph.json'), populatedGraph);

    // Run init_user_vault TWICE.
    const res = runBash(buildInitVaultHarness({ userHome, preseedDir, runs: 2 }));
    assert.equal(res.status, 0, `init_user_vault must run cleanly; stderr: ${res.stderr}`);

    // User note untouched (content + only one copy, no duplication).
    assert.ok(existsSync(userNote), 'user note must survive init_user_vault');
    assert.equal(
      readFileSync(userNote, 'utf8'),
      'USER WROTE THIS — do not touch\n',
      'init_user_vault must NOT overwrite user-owned Notes content',
    );
    const notes = readdirSync(join(vault, 'Notes'));
    assert.deepEqual(notes, ['my-secret-note.md'], 'init_user_vault must not create stray Notes files');

    // Populated graph must be preserved (recreate-if-missing only).
    assert.equal(
      readFileSync(join(vault, 'graphify-out', 'graph.json'), 'utf8'),
      populatedGraph,
      'init_user_vault must NOT overwrite a populated graphify-out/graph.json with the empty stub',
    );

    // Skeleton dirs the function guarantees exist (mkdir -p, idempotent).
    for (const d of ['Raw/Sessions', 'Notes', 'References', 'graphify-out', '.silverbullet/_plug']) {
      assert.ok(existsSync(join(vault, d)), `init_user_vault must ensure ~/Vault/${d} exists`);
    }
  });

  it('init_user_vault re-creates a deleted skeleton dir but leaves a populated graph alone (REQ-MEM-004 AC3: existence-guarded)', () => {
    // Gut-check companion: if the guard logic were replaced with an
    // unconditional `printf > graph.json`, the populated graph below would
    // be clobbered and this assertion would fail. If init were a no-op,
    // the missing skeleton dir would not be re-created and this fails too.
    const root = mkTmp('vault-guard-');
    const userHome = join(root, 'home');
    const preseedDir = join(root, 'preseed');
    const vault = join(userHome, 'Vault');
    mkdirSync(preseedDir, { recursive: true });

    // Vault exists but a critical dir (Raw/Sessions) was deleted by the user.
    mkdirSync(join(vault, 'graphify-out'), { recursive: true });
    const populatedGraph = '{"nodes":[{"id":"keep-me"}],"links":[]}';
    writeFileSync(join(vault, 'graphify-out', 'graph.json'), populatedGraph);

    const res = runBash(buildInitVaultHarness({ userHome, preseedDir, runs: 1 }));
    assert.equal(res.status, 0, `init_user_vault must run cleanly; stderr: ${res.stderr}`);

    assert.ok(
      existsSync(join(vault, 'Raw', 'Sessions')),
      'init_user_vault must re-create a user-deleted critical dir (Raw/Sessions)',
    );
    assert.equal(
      readFileSync(join(vault, 'graphify-out', 'graph.json'), 'utf8'),
      populatedGraph,
      'init_user_vault must leave a pre-existing populated graph.json untouched',
    );
  });

  it('init_user_vault copies preseeded plugs into Library/Codeflare and is idempotent overwrite-on-diff (REQ-VAULT-007 AC5)', () => {
    const root = mkTmp('vault-plug-');
    const userHome = join(root, 'home');
    const preseedDir = join(root, 'preseed');
    const vault = join(userHome, 'Vault');

    // Preseed plug lives under plugs/<group>/<name>.plug.js (the glob the
    // function iterates: "$PRESEED_DIR/plugs"/*/*.plug.js).
    const plugSrcDir = join(preseedDir, 'plugs', 'activity');
    mkdirSync(plugSrcDir, { recursive: true });
    const plugSrc = join(plugSrcDir, 'activity.plug.js');
    writeFileSync(plugSrc, 'PLUG BUNDLE V1\n');

    const plugDst = join(vault, 'Library', 'Codeflare', 'activity.plug.js');

    // --- Run 1: plug must be copied in. ---
    let res = runBash(buildInitVaultHarness({ userHome, preseedDir, runs: 1 }));
    assert.equal(res.status, 0, `init_user_vault run 1 must run cleanly; stderr: ${res.stderr}`);
    assert.ok(existsSync(plugDst), 'preseeded plug must be copied into Library/Codeflare on first boot');
    assert.equal(readFileSync(plugDst, 'utf8'), 'PLUG BUNDLE V1\n', 'copied plug content must match preseed');

    // --- Run 2: identical content => no needless rewrite (mtime stable). ---
    const mtime1 = statSync(plugDst).mtimeMs;
    // Sleep so a rewrite would produce a measurably newer mtime.
    res = runBash(`sleep 1.1\n${buildInitVaultHarness({ userHome, preseedDir, runs: 1 })}`);
    assert.equal(res.status, 0, `init_user_vault run 2 must run cleanly; stderr: ${res.stderr}`);
    const mtime2 = statSync(plugDst).mtimeMs;
    assert.equal(
      mtime2,
      mtime1,
      'identical preseed plug must NOT be rewritten (cmp -s guard); mtime should be unchanged',
    );
    assert.equal(readFileSync(plugDst, 'utf8'), 'PLUG BUNDLE V1\n', 'plug content stays correct on no-op run');

    // --- Run 3: changed preseed content => overwrite-on-diff propagates. ---
    writeFileSync(plugSrc, 'PLUG BUNDLE V2 (pin bumped)\n');
    res = runBash(buildInitVaultHarness({ userHome, preseedDir, runs: 1 }));
    assert.equal(res.status, 0, `init_user_vault run 3 must run cleanly; stderr: ${res.stderr}`);
    assert.equal(
      readFileSync(plugDst, 'utf8'),
      'PLUG BUNDLE V2 (pin bumped)\n',
      'a changed preseed plug must overwrite the vault copy (idempotent overwrite-on-diff)',
    );
  });

  it('init_user_vault leaves a user plug in a non-Codeflare Library subdir untouched (REQ-VAULT-007 AC5: only Codeflare namespace managed)', () => {
    const root = mkTmp('vault-userplug-');
    const userHome = join(root, 'home');
    const preseedDir = join(root, 'preseed');
    const vault = join(userHome, 'Vault');

    const plugSrcDir = join(preseedDir, 'plugs', 'activity');
    mkdirSync(plugSrcDir, { recursive: true });
    writeFileSync(join(plugSrcDir, 'activity.plug.js'), 'PLUG BUNDLE V1\n');

    // A user-installed plug under a DIFFERENT Library subdir must be untouched.
    const userPlug = join(vault, 'Library', 'MyStuff', 'custom.plug.js');
    mkdirSync(dirname(userPlug), { recursive: true });
    writeFileSync(userPlug, 'USER PLUG — keep me\n');

    const res = runBash(buildInitVaultHarness({ userHome, preseedDir, runs: 1 }));
    assert.equal(res.status, 0, `init_user_vault must run cleanly; stderr: ${res.stderr}`);

    assert.ok(existsSync(userPlug), 'user plug under Library/MyStuff must survive');
    assert.equal(
      readFileSync(userPlug, 'utf8'),
      'USER PLUG — keep me\n',
      'init_user_vault must only manage Library/Codeflare, never other Library subdirs',
    );
  });
});
