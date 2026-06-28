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
    '    echo "[entrypoint] Relaid image-baked managed Pi extensions (mode=${mode}) over post-sync tree" | tee -a /tmp/sync.log\n}',
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

function runRelay({ sessionMode = 'default', seedModes = ['default'], r2SseDisabled = false, bakeFileMtimeMs } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'relay-home-'));
  const bakeRoot = mkdtempSync(join(tmpdir(), 'relay-bake-'));
  // Image-baked managed extension per requested mode.
  for (const mode of seedModes) {
    const extDir = join(bakeRoot, mode, '.pi/agent/extensions');
    mkdirSync(extDir, { recursive: true });
    const f = join(extDir, 'codeflare-pi.ts');
    writeFileSync(f, `// ${mode} IMAGE\n`);
    if (bakeFileMtimeMs !== undefined) {
      const t = new Date(bakeFileMtimeMs);
      utimesSync(f, t, t); // age the baked file (like a real image-build mtime)
    }
  }
  // Post-sync $USER_HOME: a STALE managed copy the R2 sync restored + a user-ADDED extension.
  const homeExt = join(home, '.pi/agent/extensions');
  mkdirSync(homeExt, { recursive: true });
  writeFileSync(join(homeExt, 'codeflare-pi.ts'), '// STALE from R2\n');
  writeFileSync(join(homeExt, 'my-custom.ts'), '// USER addition\n');
  const script = [
    'set -euo pipefail',
    `USER_HOME='${home}'`,
    `AGENT_SEED_BAKE_DIR='${bakeRoot}'`,
    `SESSION_MODE='${sessionMode}'`,
    r2SseDisabled ? "R2_SSE_DISABLED='true'" : '',
    relayFn(),
    'relay_managed_pi_extensions',
  ].join('\n');
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return { code: res.status, stderr: res.stderr, home, homeExt };
}

describe('REQ-STOR-017 / AD90: post-sync managed Pi extension relay (entrypoint.sh relay_managed_pi_extensions)', () => {
  it('overwrites a stale (R2-restored) managed extension with the image-baked copy', () => {
    const { code, stderr, homeExt } = runRelay({ sessionMode: 'default' });
    assert.equal(code, 0, `relay exited non-zero: ${stderr}`);
    assert.equal(
      readFileSync(join(homeExt, 'codeflare-pi.ts'), 'utf8'),
      '// default IMAGE\n',
      'managed extension not overwritten with image content (a stale bucket copy defeats the content-addressed jiti cache)',
    );
  });

  it('preserves user-ADDED extensions (other filenames the sync restored)', () => {
    const { code, stderr, homeExt } = runRelay({ sessionMode: 'default' });
    assert.equal(code, 0, `relay exited non-zero: ${stderr}`);
    assert.ok(existsSync(join(homeExt, 'my-custom.ts')), 'user-added extension was destroyed by the relay');
    assert.equal(readFileSync(join(homeExt, 'my-custom.ts'), 'utf8'), '// USER addition\n');
  });

  it('relays in ALL modes — NOT gated on Governed Mode (R2_SSE_DISABLED unset)', () => {
    const { code, stderr, homeExt } = runRelay({ r2SseDisabled: false, sessionMode: 'default' });
    assert.equal(code, 0, `relay exited non-zero: ${stderr}`);
    assert.equal(
      readFileSync(join(homeExt, 'codeflare-pi.ts'), 'utf8'),
      '// default IMAGE\n',
      'relay did not run outside Governed Mode — the fix must apply to all deployment modes',
    );
  });

  it('is mode-aware: relays the advanced bake for SESSION_MODE=advanced', () => {
    const { code, stderr, homeExt } = runRelay({ sessionMode: 'advanced', seedModes: ['default', 'advanced'] });
    assert.equal(code, 0, `relay exited non-zero: ${stderr}`);
    assert.equal(readFileSync(join(homeExt, 'codeflare-pi.ts'), 'utf8'), '// advanced IMAGE\n');
  });

  it('gives the relaid file a fresh mtime (cp -r, not -p) so bisync treats local as truth', () => {
    const aged = Date.now() - 7 * 24 * 60 * 60 * 1000; // a week old, like an image-baked file
    const before = Date.now();
    const { code, stderr, homeExt } = runRelay({ sessionMode: 'default', bakeFileMtimeMs: aged });
    assert.equal(code, 0, `relay exited non-zero: ${stderr}`);
    const relaidMtime = statSync(join(homeExt, 'codeflare-pi.ts')).mtimeMs;
    assert.ok(
      relaidMtime >= before - 1000,
      `relaid file kept the old baked mtime (${relaidMtime}) — cp -p would let the --resync baseline pull the stale R2 copy back`,
    );
  });

  it('is a clean no-op (exit 0, stale copy left intact) when no baked extensions exist for the mode', () => {
    const { code, stderr, homeExt } = runRelay({ sessionMode: 'default', seedModes: [] });
    assert.equal(code, 0, `relay should no-op cleanly when the bake is absent: ${stderr}`);
    assert.equal(readFileSync(join(homeExt, 'codeflare-pi.ts'), 'utf8'), '// STALE from R2\n', 'no-op must not alter the tree');
    assert.ok(existsSync(join(homeExt, 'my-custom.ts')), 'no-op must not delete user files');
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

// ---------------------------------------------------------------------------
// REQ-STOR-017 (a) / AD88: bisync HEAD-storm fix — both bisync invocations must
// compare via R2 LastModified from --fast-list (--use-server-modtime) instead of
// per-object mtime HEADs, with --checkers 64. Contract-value assertions on each
// bisync function body (rclone flags are functional config, not copy).
// ---------------------------------------------------------------------------

// Slice each `rclone bisync ...` invocation (start → its `2>&1; then` terminator).
// There are exactly two: the --resync baseline and the steady-state cycle.
function bisyncInvocations() {
  const calls = [];
  let from = 0;
  for (;;) {
    const start = entrypoint.indexOf('rclone bisync "$USER_HOME/"', from);
    if (start === -1) break;
    const end = entrypoint.indexOf('2>&1; then', start);
    if (end === -1) throw new Error('bisync invocation terminator not found');
    calls.push(entrypoint.slice(start, end));
    from = end + 1;
  }
  return calls;
}

describe('REQ-STOR-017 / AD88: bisync uses server-modtime + wider checkers (entrypoint.sh)', () => {
  it('has exactly two bisync invocations (baseline + steady-state)', () => {
    assert.equal(bisyncInvocations().length, 2);
  });

  const labels = ['baseline', 'steady-state'];
  for (const [i, body] of bisyncInvocations().entries()) {
    const label = labels[i] ?? `bisync#${i}`;
    it(`${label} bisync passes --use-server-modtime`, () => {
      assert.match(body, /--use-server-modtime/, `${label} bisync missing --use-server-modtime (HEAD-storm reintroduced)`);
    });
    it(`${label} bisync uses --checkers 64 (not the old 32)`, () => {
      assert.match(body, /--checkers 64/, `${label} bisync not on --checkers 64`);
      assert.ok(!/--checkers 32/.test(body), `${label} bisync regressed to --checkers 32`);
    });
  }
});
