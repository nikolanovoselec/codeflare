// Real behavioral tests for the vault-monitor UserPromptSubmit hook
// (REQ-VAULT-003 AC3).
//
// The hook is a runnable bash script
// (preseed/agents/claude/plugins/codeflare-vault/scripts/vault-monitor-hook.sh).
// Rather than string-match its source (theater that survives gutting the
// logic), these tests RUN the real script against a temp HOME with the
// marker/sentinel filesystem state set up, and assert on its OBSERVABLE
// side effects: the exit code, whether it emits an additionalContext
// directive on stdout, and whether it creates / deletes the in-flight
// sentinel.
//
// AC3 covers two fast-exit conditions and the emit-and-arm path:
//   * trigger marker (vault-extract.vars) absent  -> exit 0, no output, no sentinel
//   * in-flight sentinel present and younger than 5 min -> exit 0, no output
//   * neither exit condition -> create the in-flight sentinel + emit the
//     dispatch directive
//   * in-flight sentinel older than the 5-min TTL -> stale sentinel is
//     replaced and the hook proceeds to emit
//
// Mirrors the run-the-real-script-and-assert-side-effects harness in
// host/__tests__/entrypoint-vault-boot.test.js (bash subshell via
// spawnSync; assert log/file effects, never source text).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-vault/scripts/vault-monitor-hook.sh',
);

const HOOK_CACHE_REL = '.cache/codeflare-hooks';
const VARS_REL = `${HOOK_CACHE_REL}/vault-extract.vars`;
const LAST_REL = `${HOOK_CACHE_REL}/vault-extract.last`;
const IN_FLIGHT_REL = `${HOOK_CACHE_REL}/vault-extract.in-flight`;

function mkHome() {
  const home = mkdtempSync(join(tmpdir(), 'vault-hook-home-'));
  mkdirSync(join(home, HOOK_CACHE_REL), { recursive: true });
  return home;
}

// Run the real hook with HOME pointed at a temp dir, feeding it the JSON
// payload a UserPromptSubmit hook receives on stdin. Returns the spawn result.
function runHook(home, stdin = '{"prompt":"hello"}') {
  return spawnSync('bash', [HOOK], {
    encoding: 'utf8',
    input: stdin,
    env: { ...process.env, HOME: home },
  });
}

// Set a file's mtime N seconds into the past.
function ageFile(path, secondsAgo) {
  const when = Date.now() / 1000 - secondsAgo;
  utimesSync(path, when, when);
}

describe('vault-monitor-hook.sh behavior (real) / REQ-VAULT-003 AC3 (hook fast-exit + 5-min in-flight sentinel TTL)', () => {
  it('fast-exits with no directive and arms no sentinel when the trigger marker is absent', () => {
    // Idle prompt: >99% of prompts. No vault-extract.vars exists.
    const home = mkHome();
    const res = runHook(home);

    assert.equal(res.status, 0, `hook must exit 0 on idle prompt; stderr: ${res.stderr}`);
    assert.equal(
      res.stdout.trim(),
      '',
      'idle prompt must inject NOTHING into the agent context (no additionalContext)',
    );
    assert.ok(
      !existsSync(join(home, IN_FLIGHT_REL)),
      'idle prompt must NOT create an in-flight sentinel',
    );
  });

  it('emits the dispatch directive and arms the in-flight sentinel when a fresh trigger marker exists', () => {
    const home = mkHome();
    // Trigger marker present and strictly newer than the high-water marker.
    writeFileSync(join(home, LAST_REL), '');
    ageFile(join(home, LAST_REL), 10); // last is 10s old
    writeFileSync(join(home, VARS_REL), 'CHANGED=Notes/foo.md\n'); // vars is "now" -> newer

    assert.ok(
      !existsSync(join(home, IN_FLIGHT_REL)),
      'precondition: no in-flight sentinel before the hook runs',
    );

    const res = runHook(home);
    assert.equal(res.status, 0, `hook must exit 0; stderr: ${res.stderr}`);

    // The emitted directive is valid JSON carrying a UserPromptSubmit
    // additionalContext that dispatches the vault-extract subagent.
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const ctx = payload.hookSpecificOutput.additionalContext;
    assert.match(ctx, /vault-extract/, 'directive must name the vault-extract subagent');
    assert.match(
      ctx,
      new RegExp(`VARS_FILE=${join(home, VARS_REL).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      'directive must pass the resolved VARS_FILE path',
    );

    // The hook armed the in-flight sentinel so the next prompt short-circuits.
    assert.ok(
      existsSync(join(home, IN_FLIGHT_REL)),
      'hook must create the in-flight sentinel on emission',
    );
  });

  it('fast-exits with no directive when a fresh in-flight sentinel (< 5 min) is present', () => {
    const home = mkHome();
    writeFileSync(join(home, LAST_REL), '');
    ageFile(join(home, LAST_REL), 10);
    writeFileSync(join(home, VARS_REL), 'CHANGED=Notes/foo.md\n'); // would otherwise emit
    // Extraction already in flight, sentinel only 30s old (< 300s TTL).
    writeFileSync(join(home, IN_FLIGHT_REL), '');
    ageFile(join(home, IN_FLIGHT_REL), 30);

    const res = runHook(home);
    assert.equal(res.status, 0, `hook must exit 0; stderr: ${res.stderr}`);
    assert.equal(
      res.stdout.trim(),
      '',
      'a fresh in-flight sentinel must suppress a second dispatch directive',
    );
    // The fresh sentinel must NOT be deleted (extraction is still running).
    assert.ok(
      existsSync(join(home, IN_FLIGHT_REL)),
      'a fresh in-flight sentinel must be preserved, not consumed',
    );
  });

  it('treats an in-flight sentinel older than the 5-min TTL as stale: replaces it and emits', () => {
    const home = mkHome();
    writeFileSync(join(home, LAST_REL), '');
    ageFile(join(home, LAST_REL), 10);
    writeFileSync(join(home, VARS_REL), 'CHANGED=Notes/foo.md\n');
    // Stale sentinel: 6 minutes old (> 300s TTL) -> crashed/abandoned run.
    writeFileSync(join(home, IN_FLIGHT_REL), '');
    ageFile(join(home, IN_FLIGHT_REL), 360);
    const staleMtime = statSync(join(home, IN_FLIGHT_REL)).mtimeMs;

    const res = runHook(home);
    assert.equal(res.status, 0, `hook must exit 0; stderr: ${res.stderr}`);

    // A stale sentinel must not block: the hook emits the directive again.
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(payload.hookSpecificOutput.additionalContext, /vault-extract/);

    // The stale sentinel was replaced with a fresh one (newer mtime).
    assert.ok(
      existsSync(join(home, IN_FLIGHT_REL)),
      'hook must re-arm a fresh in-flight sentinel after clearing the stale one',
    );
    const newMtime = statSync(join(home, IN_FLIGHT_REL)).mtimeMs;
    assert.ok(
      newMtime > staleMtime,
      'the stale sentinel must be replaced by a fresher one (re-armed), not left untouched',
    );
  });

  it('fast-exits without emitting when the trigger marker is older than the high-water marker (stale-marker guard)', () => {
    // Belt-and-braces stale-marker guard: VARS_FILE present but NOT newer
    // than LAST_MARKER means the work is already done. The hook must delete
    // the stale vars and exit silently rather than spawn a no-op extraction.
    const home = mkHome();
    writeFileSync(join(home, VARS_REL), 'CHANGED=Notes/foo.md\n');
    ageFile(join(home, VARS_REL), 10); // vars 10s old
    writeFileSync(join(home, LAST_REL), ''); // last is "now" -> newer than vars

    const res = runHook(home);
    assert.equal(res.status, 0, `hook must exit 0; stderr: ${res.stderr}`);
    assert.equal(res.stdout.trim(), '', 'a stale trigger marker must not emit a directive');
    assert.ok(
      !existsSync(join(home, VARS_REL)),
      'the stale trigger marker must be deleted so it cannot retrigger',
    );
    assert.ok(
      !existsSync(join(home, IN_FLIGHT_REL)),
      'a stale trigger marker must not arm an in-flight sentinel',
    );
  });
});
