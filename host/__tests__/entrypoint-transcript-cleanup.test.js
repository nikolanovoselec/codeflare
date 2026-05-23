// REQ-STOR-012: Session Transcript Cleanup
//
// Verifies cleanup_old_transcripts() in entrypoint.sh keeps the 5 newest
// .jsonl session transcripts and deletes the older ones across all
// project subdirectories. Subagent transcripts are excluded from the
// candidate set so they are never deleted by this pass.
//
// Strategy: extract the function body from entrypoint.sh, exec it in a
// bash subshell pointed at a per-test scratch USER_HOME. Each test gets
// its own scratch dir to keep state isolated.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, utimesSync, rmSync, readFileSync } from 'node:fs';
import { join, tmpdir, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(__dirname, '..', '..', 'entrypoint.sh');

function extractCleanupFunction() {
  const body = readFileSync(ENTRYPOINT, 'utf8');
  const start = body.indexOf('cleanup_old_transcripts() {');
  assert.ok(start !== -1, 'cleanup_old_transcripts function must exist in entrypoint.sh');
  const rest = body.slice(start);
  const closeRel = rest.search(/\n\}\n/);
  assert.ok(closeRel !== -1, 'function must have a closing `^}` line');
  return rest.slice(0, closeRel + 3);
}

const FN = extractCleanupFunction();

function runCleanupIn(scratchHome) {
  const script = `set +e
USER_HOME='${scratchHome}'
${FN}
cleanup_old_transcripts
`;
  execFileSync('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeScratch() {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-cleanup-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('cleanup_old_transcripts / REQ-STOR-012 (keeps 5 newest .jsonl, deletes older, leaves session dirs intact, excludes subagents)', () => {
  test('AC2: deletes older transcripts beyond the 5-most-recent cap', () => {
    const scratch = makeScratch();
    try {
      const projectsDir = join(scratch.dir, '.claude', 'projects');
      const projectA = join(projectsDir, 'project-a');
      mkdirSync(projectA, { recursive: true });

      const now = Date.now() / 1000;
      for (let i = 0; i < 8; i++) {
        const p = join(projectA, `session-${i}.jsonl`);
        writeFileSync(p, `{"i":${i}}\n`);
        const mtime = now - (8 - i) * 3600;
        utimesSync(p, mtime, mtime);
      }

      runCleanupIn(scratch.dir);

      const survivors = readdirSync(projectA).sort();
      assert.equal(survivors.length, 5, `expected 5 survivors, got ${survivors.length}: ${JSON.stringify(survivors)}`);
      assert.deepEqual(survivors, [
        'session-3.jsonl', 'session-4.jsonl', 'session-5.jsonl', 'session-6.jsonl', 'session-7.jsonl',
      ]);
    } finally {
      scratch.cleanup();
    }
  });

  test('AC3: project directory survives cleanup (only .jsonl files deleted)', () => {
    const scratch = makeScratch();
    try {
      const projectsDir = join(scratch.dir, '.claude', 'projects');
      const projectA = join(projectsDir, 'project-a');
      mkdirSync(projectA, { recursive: true });

      const now = Date.now() / 1000;
      for (let i = 0; i < 8; i++) {
        const p = join(projectA, `session-${i}.jsonl`);
        writeFileSync(p, `{"i":${i}}\n`);
        utimesSync(p, now - (8 - i) * 3600, now - (8 - i) * 3600);
      }

      runCleanupIn(scratch.dir);

      assert.ok(readdirSync(projectA).length > 0, 'project directory must survive cleanup');
    } finally {
      scratch.cleanup();
    }
  });

  test('no-op when total transcripts <= KEEP_COUNT (5)', () => {
    const scratch = makeScratch();
    try {
      const projectsDir = join(scratch.dir, '.claude', 'projects');
      const projectB = join(projectsDir, 'project-b');
      mkdirSync(projectB, { recursive: true });

      for (let i = 0; i < 4; i++) {
        writeFileSync(join(projectB, `keep-${i}.jsonl`), `{"i":${i}}\n`);
      }

      runCleanupIn(scratch.dir);

      const survivors = readdirSync(projectB).sort();
      assert.equal(survivors.length, 4, 'all 4 transcripts must survive when count <= KEEP_COUNT');
    } finally {
      scratch.cleanup();
    }
  });

  test('AC5: subagent transcripts are excluded from the deletion candidate set', () => {
    const scratch = makeScratch();
    try {
      const projectsDir = join(scratch.dir, '.claude', 'projects');
      const projectC = join(projectsDir, 'project-c');
      const subagents = join(projectC, 'subagents');
      mkdirSync(subagents, { recursive: true });

      const now = Date.now() / 1000;
      // Eight OLD subagent transcripts. If subagents were not excluded,
      // they would dominate the deletion ranking. They must all survive.
      for (let i = 0; i < 8; i++) {
        const p = join(subagents, `sub-${i}.jsonl`);
        writeFileSync(p, `{"i":${i}}\n`);
        utimesSync(p, now - (100 + i) * 3600, now - (100 + i) * 3600);
      }

      // Add 6 NEWER top-level transcripts; one must be deleted (5 newest cap).
      for (let i = 0; i < 6; i++) {
        const p = join(projectC, `session-${i}.jsonl`);
        writeFileSync(p, `{"i":${i}}\n`);
        utimesSync(p, now - (6 - i) * 60, now - (6 - i) * 60);
      }

      runCleanupIn(scratch.dir);

      const topLevel = readdirSync(projectC).filter((n) => n.endsWith('.jsonl'));
      const subSurvivors = readdirSync(subagents);
      assert.equal(subSurvivors.length, 8, 'subagent transcripts must be excluded from cleanup');
      assert.equal(topLevel.length, 5, 'top-level transcripts must respect the 5-newest cap');
    } finally {
      scratch.cleanup();
    }
  });
});
