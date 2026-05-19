// Unit tests for compute_required_lanes (lib/lane-classifier.sh).
//
// The classifier is the single source of truth for which review lanes a
// diff between two SHAs requires. Both enforce-review-spawn.sh (Stop hook
// gate) and git-push-review-reminder.sh (PostToolUse nudge) source it.
// Before the function was extracted into a shared lib, integration tests
// at host/__tests__/enforce-review-spawn.test.js covered the behaviour
// transitively. After extraction the function is a public API of the lib
// file, so the branches below are tested directly without booting the
// full hook.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_PATH = join(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh',
);

function makeRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'laneclass-'));
  const run = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  run('init', '-q');
  run('config', 'user.email', 'test@test');
  run('config', 'user.name', 'Test');
  return { cwd, run };
}

function commitFile(cwd, run, relpath, body, msg) {
  const abs = join(cwd, relpath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  run('add', relpath);
  run('commit', '-q', '-m', msg);
  return run('rev-parse', 'HEAD').stdout.trim();
}

function classify(cwd, lastAck, current) {
  // Source the lib then invoke. Use `bash -s -- LIB SHA1 SHA2` with the
  // script piped via stdin so the shell command itself is the literal
  // string "bash" with no constructed command-string at all. The arguments
  // reach the script as positional $1 $2 $3 and are double-quoted at the
  // expansion site.
  //
  // CodeQL js/shell-command-injection-from-environment alerts #51 and #52:
  // the earlier `bash -c <script>` form (even with argv-passed values) was
  // flagged because CodeQL does not model "$1"-quoting as a safety boundary.
  // The stdin-fed form has no command-string built from environment values
  // and is the recommended pattern in the CodeQL guidance.
  const r = spawnSync(
    'bash',
    ['-s', '--', LIB_PATH, lastAck, current],
    {
      cwd,
      encoding: 'utf8',
      input: '. "$1"\ncompute_required_lanes "$2" "$3"\n',
    },
  );
  if (r.status !== 0) {
    throw new Error(`classify failed: status=${r.status} stderr=${r.stderr}`);
  }
  return r.stdout.trim();
}

describe('compute_required_lanes - initial state', () => {
  it('empty last_ack returns all three lanes', () => {
    const { cwd, run } = makeRepo();
    const sha = commitFile(cwd, run, 'src/foo.ts', 'export {};\n', 'feat: foo');
    assert.equal(classify(cwd, '', sha), 'code-reviewer spec-reviewer doc-updater');
  });
});

describe('compute_required_lanes - equal SHAs', () => {
  it('last_ack equals current returns empty (no-op advance)', () => {
    const { cwd, run } = makeRepo();
    const sha = commitFile(cwd, run, 'src/foo.ts', 'export {};\n', 'feat: foo');
    assert.equal(classify(cwd, sha, sha), '');
  });
});

describe('compute_required_lanes - divergent-branch / non-ancestor', () => {
  // Named "divergent branch" rather than "force-push" because the
  // fixture commits on a side branch without rewriting history. The
  // classifier guard fires on the same `merge-base != last_ack`
  // condition that would catch a real force-push, but a true force-
  // push test would `git reset --hard` and reflog-orphan the old SHA.
  it('last_ack on a divergent branch falls back to all three lanes', () => {
    // Both branches commit only documentation/ paths. If the merge-base
    // guard fires, classifier returns all-three conservatively. If the
    // guard is deleted, the diff loop walks docs-only paths and returns
    // just `doc-updater` - so this fixture isolates the guard from the
    // behavioral catch-all (deleting the guard would flip the test red).
    const { cwd, run } = makeRepo();
    const baseSha = commitFile(cwd, run, 'documentation/base.md', '1\n', 'docs: base');
    // Diverge: commit on a new branch so the two SHAs do not share an
    // ancestor relationship in the linear sense (merge-base equals base,
    // not last_ack).
    run('checkout', '-q', '-b', 'alt');
    const altSha = commitFile(cwd, run, 'documentation/alt.md', '2\n', 'docs: alt');
    run('checkout', '-q', 'main');
    const mainSha = commitFile(cwd, run, 'documentation/main.md', '3\n', 'docs: main');
    // last_ack = altSha (divergent), current = mainSha. merge-base != altSha
    // -> classifier returns all 3 conservatively.
    assert.equal(
      classify(cwd, altSha, mainSha),
      'code-reviewer spec-reviewer doc-updater',
    );
  });
});

describe('compute_required_lanes - file classification', () => {
  it('documentation/ only diff returns doc-updater only', () => {
    const { cwd, run } = makeRepo();
    const base = commitFile(cwd, run, 'src/foo.ts', '1\n', 'feat: base');
    const next = commitFile(cwd, run, 'documentation/notes.md', '# notes\n', 'docs: notes');
    assert.equal(classify(cwd, base, next), 'doc-updater');
  });

  it('README.md / CHANGELOG.md count as documentation surface', () => {
    const { cwd, run } = makeRepo();
    const base = commitFile(cwd, run, 'src/foo.ts', '1\n', 'feat: base');
    const next = commitFile(cwd, run, 'README.md', '# project\n', 'docs: readme');
    assert.equal(classify(cwd, base, next), 'doc-updater');
  });

  it('sdd/ only diff returns spec-reviewer + doc-updater', () => {
    const { cwd, run } = makeRepo();
    const base = commitFile(cwd, run, 'src/foo.ts', '1\n', 'feat: base');
    const next = commitFile(cwd, run, 'sdd/memory.md', '# REQ-MEM-001\n', 'spec: REQ-MEM-001');
    assert.equal(classify(cwd, base, next), 'spec-reviewer doc-updater');
  });

  it('sdd/ + documentation/ diff still returns spec-reviewer + doc-updater (no duplicate)', () => {
    const { cwd, run } = makeRepo();
    const base = commitFile(cwd, run, 'src/foo.ts', '1\n', 'feat: base');
    commitFile(cwd, run, 'sdd/memory.md', '# REQ\n', 'spec: REQ');
    const next = commitFile(cwd, run, 'documentation/notes.md', '# notes\n', 'docs: notes');
    assert.equal(classify(cwd, base, next), 'spec-reviewer doc-updater');
  });

  it('source file diff returns all three lanes (behavioral catch-all)', () => {
    const { cwd, run } = makeRepo();
    const base = commitFile(cwd, run, 'documentation/notes.md', '1\n', 'docs: base');
    const next = commitFile(cwd, run, 'src/foo.ts', 'export {};\n', 'feat: foo');
    assert.equal(classify(cwd, base, next), 'code-reviewer spec-reviewer doc-updater');
  });

  it('mixed src + sdd diff returns all three lanes (behavioral wins)', () => {
    const { cwd, run } = makeRepo();
    const base = commitFile(cwd, run, 'documentation/notes.md', '1\n', 'docs: base');
    commitFile(cwd, run, 'src/foo.ts', 'export {};\n', 'feat: foo');
    const next = commitFile(cwd, run, 'sdd/memory.md', '# REQ\n', 'spec: REQ');
    assert.equal(
      classify(cwd, base, next),
      'code-reviewer spec-reviewer doc-updater',
    );
  });

  it('host/ test changes count as behavioral (not in doc-surface allowlist)', () => {
    const { cwd, run } = makeRepo();
    const base = commitFile(cwd, run, 'documentation/notes.md', '1\n', 'docs: base');
    const next = commitFile(cwd, run, 'host/__tests__/foo.test.js', '// test\n', 'test: foo');
    assert.equal(
      classify(cwd, base, next),
      'code-reviewer spec-reviewer doc-updater',
    );
  });

  it('entrypoint.sh / config files count as behavioral', () => {
    const { cwd, run } = makeRepo();
    const base = commitFile(cwd, run, 'documentation/notes.md', '1\n', 'docs: base');
    const next = commitFile(cwd, run, 'entrypoint.sh', '#!/bin/bash\n', 'chore: entry');
    assert.equal(
      classify(cwd, base, next),
      'code-reviewer spec-reviewer doc-updater',
    );
  });
});

describe('compute_required_lanes - rename safety (--no-renames)', () => {
  it('src->doc rename still classifies as behavioral (rename attack guard)', () => {
    // Adversarial case: a rename from src/foo.ts to documentation/foo.md
    // would, under default rename detection, emit ONLY the new path and
    // make the change look documentation-only. --no-renames forces both
    // old and new paths into the diff; the source path triggers the
    // behavioral fall-through. Without this guard, a malicious rename
    // could bypass code-reviewer + spec-reviewer entirely.
    const { cwd, run } = makeRepo();
    const base = commitFile(cwd, run, 'src/foo.ts', 'export {};\n', 'feat: src foo');
    run('mv', 'src/foo.ts', 'documentation/foo.md');
    run('commit', '-q', '-m', 'rename: src to docs');
    const next = run('rev-parse', 'HEAD').stdout.trim();
    assert.equal(
      classify(cwd, base, next),
      'code-reviewer spec-reviewer doc-updater',
    );
  });
});
