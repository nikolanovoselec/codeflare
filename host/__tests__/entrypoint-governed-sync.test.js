// Tests for REQ-ENTERPRISE-018 (Governed Mode rclone.conf) + REQ-STOR-017 / AD90
// (image-baked agent-seed lay-down + delta initial sync) in entrypoint.sh.
//
// Strategy (mirrors entrypoint-enterprise-ca-copilot.test.js): extract each shell
// fragment by stable comment/sentinel markers, run it with `bash -c` in a tmpdir against
// the real file system, and assert the functional contract on the result. "Run the real
// thing" — if a branch is gutted or a flag renamed in entrypoint.sh, these fail.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, existsSync, statSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

/** Slice entrypoint.sh from a start marker up to (and including) an end marker. */
function extractBetween(startMarker, endMarker, label) {
  const start = entrypoint.indexOf(startMarker);
  if (start === -1) throw new Error(`${label}: start marker not found in entrypoint.sh`);
  const end = entrypoint.indexOf(endMarker, start);
  if (end === -1) throw new Error(`${label}: end marker not found in entrypoint.sh`);
  return entrypoint.slice(start, end + endMarker.length);
}

function extractBefore(startMarker, nextMarker, label) {
  const start = entrypoint.indexOf(startMarker);
  if (start === -1) throw new Error(`${label}: start marker not found in entrypoint.sh`);
  const end = entrypoint.indexOf(nextMarker, start);
  if (end === -1) throw new Error(`${label}: next marker not found in entrypoint.sh`);
  return entrypoint.slice(start, end);
}

const createRcloneConfig = () =>
  extractBetween(
    'create_rclone_config() {',
    '    echo "[entrypoint] rclone config created"\n    return 0\n}',
    'create_rclone_config',
  );

const layDownFn = () =>
  extractBetween(
    'lay_down_agent_seed_preseed() {',
    '    echo "[entrypoint] Baked agent seed laid down" | tee -a /tmp/sync.log\n}',
    'lay_down_agent_seed_preseed',
  );

const compareFlagFragment = () =>
  extractBetween(
    '    local COMPARE_FLAG="--size-only"',
    'COMPARE_FLAG="--checksum"\n    fi',
    'COMPARE_FLAG',
  );

const relayFn = () =>
  extractBetween(
    'relay_managed_pi_extensions() {',
    '    echo "[entrypoint] Relaid ${relaid} managed Pi extension(s) from image source over post-sync tree" | tee -a /tmp/sync.log\n}',
    'relay_managed_pi_extensions',
  );

// A valid-looking hex R2 key (create_rclone_config validates hex shape).
const HEX = 'deadbeefdeadbeefdeadbeefdeadbeef';
const ENC_KEY = Buffer.alloc(32, 7).toString('base64');

function runRcloneConfig({ r2SseDisabled, encryptionKey }) {
  const dir = mkdtempSync(join(tmpdir(), 'gov-rclone-'));
  const script = [
    'set -euo pipefail',
    `USER_HOME='${dir}'`,
    `R2_ACCESS_KEY_ID='${HEX}'`,
    `R2_SECRET_ACCESS_KEY='${HEX}'`,
    "R2_BUCKET_NAME='bkt'",
    "R2_ENDPOINT='https://acc.r2.cloudflarestorage.com'",
    encryptionKey ? `ENCRYPTION_KEY='${encryptionKey}'` : '',
    r2SseDisabled ? "R2_SSE_DISABLED='true'" : '',
    createRcloneConfig(),
    'create_rclone_config',
  ].join('\n');
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const confPath = join(dir, '.config/rclone/rclone.conf');
  const conf = existsSync(confPath) ? readFileSync(confPath, 'utf8') : '';
  return { code: res.status, stderr: res.stderr, conf };
}

describe('REQ-ENTERPRISE-018: rclone.conf under Governed Mode (entrypoint.sh create_rclone_config)', () => {
  it('SSE-C ON (default): writes the SSE-C key and keeps checksums disabled', () => {
    const { code, stderr, conf } = runRcloneConfig({ r2SseDisabled: false, encryptionKey: ENC_KEY });
    assert.equal(code, 0, `create_rclone_config exited non-zero: ${stderr}`);
    assert.match(conf, /sse_customer_key_base64 = /, 'SSE-C key missing when SSE-C is on');
    assert.match(conf, /sse_customer_algorithm = AES256/, 'SSE-C algorithm missing when SSE-C is on');
    assert.match(conf, /disable_checksum = true/, 'checksums should stay disabled under SSE-C');
  });

  it('Governed Mode (R2_SSE_DISABLED=true): omits SSE-C even with ENCRYPTION_KEY and enables checksums', () => {
    const { code, stderr, conf } = runRcloneConfig({ r2SseDisabled: true, encryptionKey: ENC_KEY });
    assert.equal(code, 0, `create_rclone_config exited non-zero: ${stderr}`);
    // Gut-check: the SSE-C skip branch is what makes the bucket plaintext/scannable.
    assert.ok(!/sse_customer_key_base64/.test(conf), 'SSE-C key written despite Governed Mode');
    assert.ok(!/sse_customer_algorithm/.test(conf), 'SSE-C algorithm written despite Governed Mode');
    // Gut-check: checksums must be re-enabled so the delta sync is content-correct.
    assert.match(conf, /disable_checksum = false/, 'checksums not re-enabled under Governed Mode');
    assert.ok(!/disable_checksum = true/.test(conf), 'stale disable_checksum=true left under Governed Mode');
  });
});

function runLayDown({ r2SseDisabled, sessionMode = 'default', seedModes = ['default'], preExisting = false }) {
  const home = mkdtempSync(join(tmpdir(), 'gov-home-'));
  const bakeRoot = mkdtempSync(join(tmpdir(), 'gov-bake-'));
  // Build a baked tree per requested mode: a hook (.mjs) + a skill file.
  for (const mode of seedModes) {
    mkdirSync(join(bakeRoot, mode, '.claude/hooks'), { recursive: true });
    mkdirSync(join(bakeRoot, mode, '.claude/skills/demo'), { recursive: true });
    writeFileSync(join(bakeRoot, mode, '.claude/hooks/cap.mjs'), `// ${mode} hook\n`);
    writeFileSync(join(bakeRoot, mode, '.claude/skills/demo/SKILL.md'), `# ${mode} skill\n`);
  }
  if (preExisting) {
    mkdirSync(join(home, '.claude/hooks'), { recursive: true });
    writeFileSync(join(home, '.claude/hooks/cap.mjs'), '// stale\n');
  }
  const script = [
    'set -euo pipefail',
    `USER_HOME='${home}'`,
    `AGENT_SEED_BAKE_DIR='${bakeRoot}'`,
    `SESSION_MODE='${sessionMode}'`,
    r2SseDisabled ? "R2_SSE_DISABLED='true'" : '',
    layDownFn(),
    'lay_down_agent_seed_preseed',
  ].join('\n');
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return { code: res.status, stderr: res.stderr, home };
}

describe('REQ-STOR-017 / AD90: image-baked agent-seed lay-down (entrypoint.sh lay_down_agent_seed_preseed)', () => {
  it('Governed Mode: copies the baked tree into $USER_HOME and makes hooks executable', () => {
    const { code, stderr, home } = runLayDown({ r2SseDisabled: true, sessionMode: 'default' });
    assert.equal(code, 0, `lay-down exited non-zero: ${stderr}`);
    const hook = join(home, '.claude/hooks/cap.mjs');
    const skill = join(home, '.claude/skills/demo/SKILL.md');
    assert.ok(existsSync(hook), 'hook not laid down');
    assert.ok(existsSync(skill), 'skill not laid down');
    assert.equal(readFileSync(skill, 'utf8'), '# default skill\n', 'skill content not laid down verbatim');
    // +x on the hook (mode bits & 0o111 set).
    assert.ok((statSync(hook).mode & 0o111) !== 0, 'hook not made executable');
  });

  it('does NOT lay down anything outside Governed Mode (R2_SSE_DISABLED unset)', () => {
    const { code, stderr, home } = runLayDown({ r2SseDisabled: false, sessionMode: 'default' });
    assert.equal(code, 0, `lay-down exited non-zero: ${stderr}`);
    assert.ok(!existsSync(join(home, '.claude/hooks/cap.mjs')), 'seed laid down despite SSE-C mode');
  });

  it('is mode-aware: lays down the advanced tree for SESSION_MODE=advanced', () => {
    const { code, stderr, home } = runLayDown({
      r2SseDisabled: true,
      sessionMode: 'advanced',
      seedModes: ['default', 'advanced'],
    });
    assert.equal(code, 0, `lay-down exited non-zero: ${stderr}`);
    assert.equal(readFileSync(join(home, '.claude/skills/demo/SKILL.md'), 'utf8'), '# advanced skill\n');
  });

  it('is idempotent — a second lay-down over existing files succeeds', () => {
    // First lay-down onto a home that already has a stale copy.
    const { code, stderr, home } = runLayDown({ r2SseDisabled: true, sessionMode: 'default', preExisting: true });
    assert.equal(code, 0, `idempotent lay-down exited non-zero: ${stderr}`);
    assert.ok(existsSync(join(home, '.claude/skills/demo/SKILL.md')), 'skill missing after re-lay-down');
  });
});

function runRelay({ warmFiles, destFiles, warmPresent = true, destPresent = true, warmFileMtimeMs } = {}) {
  const warm = warmFiles ?? { 'codeflare-pi.ts': '// IMAGE codeflare-pi\n' };
  const dest = destFiles ?? { 'codeflare-pi.ts': '// STALE from R2\n', 'my-custom.ts': '// USER addition\n' };
  const home = mkdtempSync(join(tmpdir(), 'relay-home-'));
  const warmRoot = mkdtempSync(join(tmpdir(), 'relay-warm-'));
  // Image warm source — the EXACT unfiltered dir the jiti cache is baked from.
  const warmSrc = join(warmRoot, 'extensions');
  if (warmPresent) {
    mkdirSync(warmSrc, { recursive: true });
    for (const [name, content] of Object.entries(warm)) {
      const f = join(warmSrc, name);
      writeFileSync(f, content);
      if (warmFileMtimeMs !== undefined) {
        const t = new Date(warmFileMtimeMs);
        utimesSync(f, t, t); // age the image file (like a real image-build mtime)
      }
    }
  }
  // Post-sync $USER_HOME runtime extensions: whatever the R2 sync restored (possibly stale).
  const destExt = join(home, '.pi/agent/extensions');
  if (destPresent) {
    mkdirSync(destExt, { recursive: true });
    for (const [name, content] of Object.entries(dest)) writeFileSync(join(destExt, name), content);
  }
  const script = [
    'set -euo pipefail',
    `USER_HOME='${home}'`,
    `PI_WARM_EXTENSIONS_DIR='${warmSrc}'`,
    relayFn(),
    'relay_managed_pi_extensions',
  ].join('\n');
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return { code: res.status, stderr: res.stderr, home, destExt };
}

describe('REQ-STOR-017 / AD90: post-sync managed Pi extension relay (entrypoint.sh relay_managed_pi_extensions)', () => {
  it('overwrites a stale (R2-restored) managed extension present in the runtime with the image source', () => {
    const { code, stderr, destExt } = runRelay();
    assert.equal(code, 0, `relay exited non-zero: ${stderr}`);
    assert.equal(
      readFileSync(join(destExt, 'codeflare-pi.ts'), 'utf8'),
      '// IMAGE codeflare-pi\n',
      'managed extension not overwritten with image content (a stale copy defeats the content-addressed jiti cache)',
    );
  });

  it('preserves user-ADDED extensions (filenames not in the image source)', () => {
    const { code, stderr, destExt } = runRelay();
    assert.equal(code, 0, `relay exited non-zero: ${stderr}`);
    assert.ok(existsSync(join(destExt, 'my-custom.ts')), 'user-added extension was destroyed by the relay');
    assert.equal(readFileSync(join(destExt, 'my-custom.ts'), 'utf8'), '// USER addition\n');
  });

  it('REQ-STOR-017 AC7: removes retired durable-review extensions without deleting user additions', () => {
    const retired = ['review-job-helpers.ts', 'review-jobs.ts', 'review-lane-guards.ts'];
    const warmFiles = Object.fromEntries([
      ['codeflare-pi.ts', '// IMAGE codeflare-pi\n'],
      ...retired.map((name) => [name, '// RETIRED IMAGE COPY\n']),
    ]);
    const destFiles = Object.fromEntries([
      ['codeflare-pi.ts', '// STALE\n'],
      ['my-custom.ts', '// USER addition\n'],
      ...retired.map((name) => [name, '// STALE R2 COPY\n']),
    ]);

    const { code, stderr, destExt } = runRelay({ warmFiles, destFiles });

    assert.equal(code, 0, `relay exited non-zero: ${stderr}`);
    assert.ok(existsSync(join(destExt, 'my-custom.ts')), 'user-added extension was deleted');
    for (const name of retired) {
      assert.ok(!existsSync(join(destExt, name)), `${name} survived managed-extension retirement`);
    }
  });

  it('sources from the unfiltered image dir so an advanced-only extension present in the runtime is fixed', () => {
    // codeflare-pi/browser-run are advanced-only — the bug was a mode-filtered source omitting them.
    const { code, stderr, destExt } = runRelay({
      warmFiles: { 'codeflare-pi.ts': '// IMAGE codeflare-pi\n', 'browser-run.ts': '// IMAGE browser-run\n' },
      destFiles: { 'codeflare-pi.ts': '// STALE\n', 'browser-run.ts': '// STALE\n' },
    });
    assert.equal(code, 0, `relay exited non-zero: ${stderr}`);
    assert.equal(readFileSync(join(destExt, 'codeflare-pi.ts'), 'utf8'), '// IMAGE codeflare-pi\n');
    assert.equal(readFileSync(join(destExt, 'browser-run.ts'), 'utf8'), '// IMAGE browser-run\n');
  });

  it('does NOT add a managed extension absent from the runtime (overwrite-if-present respects mode gating)', () => {
    const { code, stderr, destExt } = runRelay({
      warmFiles: { 'codeflare-pi.ts': '// IMAGE\n', 'advanced-only.ts': '// IMAGE adv\n' },
      destFiles: { 'codeflare-pi.ts': '// STALE\n' }, // advanced-only.ts NOT present in the runtime
    });
    assert.equal(code, 0, `relay exited non-zero: ${stderr}`);
    assert.equal(readFileSync(join(destExt, 'codeflare-pi.ts'), 'utf8'), '// IMAGE\n', 'present managed file not fixed');
    assert.ok(!existsSync(join(destExt, 'advanced-only.ts')), 'relay added an extension that was not loaded (mode gating broken)');
  });

  it('gives the relaid file a fresh mtime (cp, not cp -p) so the --resync baseline treats local as truth', () => {
    const aged = Date.now() - 7 * 24 * 60 * 60 * 1000; // a week old, like an image-build mtime
    const before = Date.now();
    const { code, stderr, destExt } = runRelay({ warmFileMtimeMs: aged });
    assert.equal(code, 0, `relay exited non-zero: ${stderr}`);
    const relaidMtime = statSync(join(destExt, 'codeflare-pi.ts')).mtimeMs;
    assert.ok(
      relaidMtime >= before - 1000,
      `relaid file kept the old image mtime (${relaidMtime}) — cp -p would let the --resync baseline pull the stale R2 copy back`,
    );
  });

  it('is a clean no-op (exit 0, stale copy intact) when the image extension source is absent', () => {
    const { code, stderr, destExt } = runRelay({ warmPresent: false });
    assert.equal(code, 0, `relay should no-op cleanly when the image source is absent: ${stderr}`);
    assert.equal(readFileSync(join(destExt, 'codeflare-pi.ts'), 'utf8'), '// STALE from R2\n', 'no-op must not alter the tree');
  });

  it('is a clean no-op (exit 0) when the runtime extensions dir does not exist yet', () => {
    const { code, stderr } = runRelay({ destPresent: false });
    assert.equal(code, 0, `relay should no-op cleanly when the runtime dir is absent: ${stderr}`);
  });
});

function runCompareFlag({ r2SseDisabled }) {
  const script = [
    'set -euo pipefail',
    r2SseDisabled ? "R2_SSE_DISABLED='true'" : '',
    `_pick() {\n${compareFlagFragment()}\n  echo "$COMPARE_FLAG"\n}`,
    '_pick',
  ].join('\n');
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return { code: res.status, stderr: res.stderr, out: (res.stdout || '').trim() };
}

describe('REQ-STOR-017 / AD90: initial-sync compare flag (entrypoint.sh initial_sync_from_r2)', () => {
  it('uses --checksum under Governed Mode', () => {
    const { code, stderr, out } = runCompareFlag({ r2SseDisabled: true });
    assert.equal(code, 0, `compare-flag fragment exited non-zero: ${stderr}`);
    assert.equal(out, '--checksum');
  });

  it('uses --size-only under SSE-C (default, byte-identical to today)', () => {
    const { code, stderr, out } = runCompareFlag({ r2SseDisabled: false });
    assert.equal(code, 0, `compare-flag fragment exited non-zero: ${stderr}`);
    assert.equal(out, '--size-only');
  });
});

function runRcloneFilterWiring() {
  const home = mkdtempSync(join(tmpdir(), 'rclone-filter-home-'));
  const callsFile = join(home, 'rclone-calls.txt');
  const recoveryFile = join(home, 'recovery-filters.txt');
  writeFileSync(recoveryFile, '');
  const filterSetup = extractBefore(
    'RCLONE_FILTERS_COMMON=(',
    '# ============================================================================\n# Recovery filter for vanishing files',
    'rclone filter setup',
  );
  const initialSync = extractBefore(
    'initial_sync_from_r2() {',
    '# REQ-STOR-017 / AD90: lay down the image-baked agent seed',
    'initial_sync_from_r2',
  );
  const baseline = extractBefore(
    'establish_bisync_baseline() {',
    '# Regular bisync (after baseline is established)',
    'establish_bisync_baseline',
  );
  const steadyState = extractBefore(
    'bisync_with_r2() {',
    '# Cleanup old Claude Code session transcripts',
    'bisync_with_r2',
  );
  const script = [
    'set -euo pipefail',
    `USER_HOME='${home}'`,
    `HOME='${home}'`,
    "R2_BUCKET_NAME='bucket'",
    `RCLONE_CONFIG='${join(home, 'rclone.conf')}'`,
    `RECOVERY_FILTER_FILE='${recoveryFile}'`,
    "SYNC_MODE='full'",
    'VAULT_FILTER=()',
    'timeout() { shift; "$@"; }',
    `rclone() { { printf '%s\\n' '__CALL__'; printf '%s\\n' "$@"; } >> '${callsFile}'; return 0; }`,
    'pgrep() { return 1; }',
    'find() { return 0; }',
    'recover_vanished_files() { return 1; }',
    filterSetup,
    initialSync,
    baseline,
    steadyState,
    'initial_sync_from_r2',
    'establish_bisync_baseline',
    'bisync_with_r2 ""',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const rawCalls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : '';
  const calls = rawCalls.split('__CALL__\n').slice(1).map((block) => block.trim().split('\n'));
  return { code: result.status, stderr: result.stderr, calls };
}

describe('REQ-STOR-017 AC6: retired Pi review extensions stay outside R2 sync', () => {
  const retired = ['review-job-helpers.ts', 'review-jobs.ts', 'review-lane-guards.ts'];

  it('passes every retired-extension exclusion to initial sync and both bisync calls', () => {
    const { code, stderr, calls } = runRcloneFilterWiring();
    assert.equal(code, 0, `rclone sync fixture exited non-zero: ${stderr}`);
    assert.deepEqual(calls.map((call) => call[0]), ['sync', 'bisync', 'bisync']);
    for (const call of calls) {
      for (const name of retired) {
        const pattern = `- .pi/agent/extensions/${name}`;
        assert.ok(
          call.some((arg, index) => arg === '--filter' && call[index + 1] === pattern),
          `${call[0]} omitted ${pattern}`,
        );
      }
    }
  });

});

describe('REQ-STOR-017 / AD88: bisync uses server-modtime + wider checkers (entrypoint.sh)', () => {
  it('passes server-modtime and 64 checkers to both bisync calls', () => {
    const { code, stderr, calls } = runRcloneFilterWiring();
    assert.equal(code, 0, `rclone sync fixture exited non-zero: ${stderr}`);
    const bisyncCalls = calls.filter((call) => call[0] === 'bisync');
    assert.equal(bisyncCalls.length, 2, 'expected baseline and steady-state bisync calls');
    for (const call of bisyncCalls) {
      assert.ok(call.includes('--use-server-modtime'), 'bisync omitted --use-server-modtime');
      assert.ok(call.some((arg, index) => arg === '--checkers' && call[index + 1] === '64'), 'bisync omitted --checkers 64');
      assert.ok(!call.some((arg, index) => arg === '--checkers' && call[index + 1] === '32'), 'bisync regressed to --checkers 32');
    }
  });
});

// ---------------------------------------------------------------------------
// REQ-STOR-017: the background-init subshell (bisync baseline + vault + daemons)
// runs concurrently with the PTY pre-warm on a single vCPU, so it must
// self-deprioritize (lowest niceness + idle I/O class) BEFORE doing any work, or
// it starves pi pre-warm and inflates startup latency. Scheduler config = contract.
// ---------------------------------------------------------------------------
const backgroundInitBlock = extractBetween(
  'if [ $RCLONE_CONFIG_RESULT -eq 0 ] && [ "${STEP1_RESULT:-1}" -eq 0 ]; then',
  'BISYNC_INIT_PID=$!',
  'background-init subshell',
);

describe('REQ-STOR-017: background init yields CPU/disk to pi pre-warm (entrypoint.sh)', () => {
  it('renices the background subshell to lowest priority (nice 19)', () => {
    assert.match(backgroundInitBlock, /renice -n 19 "\$BASHPID"/, 'background init not reniced — it can starve pi pre-warm on the single vCPU');
  });
  it('sets the background subshell to idle I/O class (ionice -c 3)', () => {
    assert.match(backgroundInitBlock, /ionice -c 3 -p "\$BASHPID"/, 'background init not ionice-idle — its disk I/O can stall pi pre-warm reads');
  });
  it('applies the deprioritization BEFORE establishing the bisync baseline (so the rclone child inherits it)', () => {
    const reniceIdx = backgroundInitBlock.indexOf('renice -n 19');
    const baselineIdx = backgroundInitBlock.indexOf('establish_bisync_baseline');
    assert.ok(
      reniceIdx !== -1 && baselineIdx !== -1 && reniceIdx < baselineIdx,
      'deprioritization must precede establish_bisync_baseline so the rclone child inherits nice/ionice',
    );
  });
});
