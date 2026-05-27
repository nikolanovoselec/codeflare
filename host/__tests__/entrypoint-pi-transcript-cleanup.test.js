// REQ-STOR-012: Pi Session Transcript Cleanup
//
// Verifies cleanup_old_pi_transcripts() in entrypoint.sh keeps the 5 newest
// .jsonl session transcripts under ~/.pi/agent/sessions/ and deletes the
// older ones along with their companion tasks/ subdirectories.
//
// Strategy: same as the Claude cleanup test — extract the function body from
// entrypoint.sh and exec it in a bash subshell with a per-test scratch USER_HOME.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, utimesSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(__dirname, '..', '..', 'entrypoint.sh');

function extractPiCleanupFunction() {
  const body = readFileSync(ENTRYPOINT, 'utf8');
  const start = body.indexOf('cleanup_old_pi_transcripts() {');
  assert.ok(start !== -1, 'cleanup_old_pi_transcripts function must exist in entrypoint.sh');
  const rest = body.slice(start);
  const closeRel = rest.search(/\n\}\n/);
  assert.ok(closeRel !== -1, 'function must have a closing `^}` line');
  return rest.slice(0, closeRel + 3);
}

const FN = extractPiCleanupFunction();

function runCleanupIn(scratchHome) {
  const script = `set +e
USER_HOME='${scratchHome}'
${FN}
cleanup_old_pi_transcripts
`;
  execFileSync('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeScratch() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-transcript-cleanup-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('cleanup_old_pi_transcripts / REQ-STOR-012 (keeps 5 newest Pi .jsonl, deletes older + companion tasks/ dirs)', () => {
  test('deletes older transcripts beyond the 5-most-recent cap', () => {
    const scratch = makeScratch();
    try {
      const sessionsDir = join(scratch.dir, '.pi', 'agent', 'sessions', '--home-user-workspace--');
      mkdirSync(sessionsDir, { recursive: true });

      const now = Date.now() / 1000;
      for (let i = 0; i < 8; i++) {
        const p = join(sessionsDir, `session-${i}.jsonl`);
        writeFileSync(p, `{"i":${i}}\n`);
        const mtime = now - (8 - i) * 3600;
        utimesSync(p, mtime, mtime);
      }

      runCleanupIn(scratch.dir);

      const survivors = readdirSync(sessionsDir).filter((n) => n.endsWith('.jsonl')).sort();
      assert.equal(survivors.length, 5, `expected 5 survivors, got ${survivors.length}: ${JSON.stringify(survivors)}`);
      assert.deepEqual(survivors, [
        'session-3.jsonl', 'session-4.jsonl', 'session-5.jsonl', 'session-6.jsonl', 'session-7.jsonl',
      ]);
    } finally {
      scratch.cleanup();
    }
  });

  test('deletes companion tasks/ subdirectory alongside transcript', () => {
    const scratch = makeScratch();
    try {
      const sessionsDir = join(scratch.dir, '.pi', 'agent', 'sessions', '--home-user-workspace--');
      mkdirSync(sessionsDir, { recursive: true });

      const now = Date.now() / 1000;
      for (let i = 0; i < 7; i++) {
        const base = `session-${i}`;
        const p = join(sessionsDir, `${base}.jsonl`);
        writeFileSync(p, `{"i":${i}}\n`);
        const mtime = now - (7 - i) * 3600;
        utimesSync(p, mtime, mtime);

        const taskDir = join(sessionsDir, base, 'tasks');
        mkdirSync(taskDir, { recursive: true });
        writeFileSync(join(taskDir, `task-${i}.jsonl`), `{"task":${i}}\n`);
      }

      runCleanupIn(scratch.dir);

      const survivorJsonl = readdirSync(sessionsDir).filter((n) => n.endsWith('.jsonl'));
      assert.equal(survivorJsonl.length, 5);

      assert.ok(!existsSync(join(sessionsDir, 'session-0', 'tasks')), 'oldest task dir must be deleted');
      assert.ok(!existsSync(join(sessionsDir, 'session-1', 'tasks')), 'second-oldest task dir must be deleted');
      assert.ok(existsSync(join(sessionsDir, 'session-2', 'tasks')), 'kept transcript must retain task dir');
    } finally {
      scratch.cleanup();
    }
  });

  test('no-op when total transcripts <= KEEP_COUNT (5)', () => {
    const scratch = makeScratch();
    try {
      const sessionsDir = join(scratch.dir, '.pi', 'agent', 'sessions', '--home-user-workspace--');
      mkdirSync(sessionsDir, { recursive: true });

      for (let i = 0; i < 4; i++) {
        writeFileSync(join(sessionsDir, `keep-${i}.jsonl`), `{"i":${i}}\n`);
      }

      runCleanupIn(scratch.dir);

      const survivors = readdirSync(sessionsDir).filter((n) => n.endsWith('.jsonl'));
      assert.equal(survivors.length, 4, 'all 4 transcripts must survive when count <= KEEP_COUNT');
    } finally {
      scratch.cleanup();
    }
  });

  test('no-op when sessions directory does not exist', () => {
    const scratch = makeScratch();
    try {
      runCleanupIn(scratch.dir);
    } finally {
      scratch.cleanup();
    }
  });

  test('task logs inside sessions are excluded from the deletion candidate set', () => {
    const scratch = makeScratch();
    try {
      const sessionsDir = join(scratch.dir, '.pi', 'agent', 'sessions', '--home-user-workspace--');
      mkdirSync(sessionsDir, { recursive: true });

      const now = Date.now() / 1000;
      for (let i = 0; i < 6; i++) {
        const base = `session-${i}`;
        const p = join(sessionsDir, `${base}.jsonl`);
        writeFileSync(p, `{"i":${i}}\n`);
        utimesSync(p, now - (6 - i) * 60, now - (6 - i) * 60);

        const taskDir = join(sessionsDir, base, 'tasks');
        mkdirSync(taskDir, { recursive: true });
        for (let t = 0; t < 3; t++) {
          writeFileSync(join(taskDir, `task-${t}.jsonl`), `{"task":${t}}\n`);
        }
      }

      runCleanupIn(scratch.dir);

      const survivorJsonl = readdirSync(sessionsDir).filter((n) => n.endsWith('.jsonl'));
      assert.equal(survivorJsonl.length, 5, 'top-level transcripts must respect 5-newest cap');

      const keptTaskDir = join(sessionsDir, 'session-1', 'tasks');
      assert.ok(existsSync(keptTaskDir), 'kept transcript must retain its task dir');
      assert.equal(readdirSync(keptTaskDir).length, 3, 'task logs inside kept sessions must survive');
    } finally {
      scratch.cleanup();
    }
  });
});
