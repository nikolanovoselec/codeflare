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

describe('compute_required_lanes - generated graphify-out artifacts (REQ-AGENT-040 AC2)', () => {
  it('graphify-out-only diff returns empty (generated artifact, caller auto-acks)', () => {
    const { cwd, run } = makeRepo();
    const base = commitFile(cwd, run, 'src/foo.ts', '1\n', 'feat: base');
    const next = commitFile(cwd, run, 'graphify-out/graph.json', '{}\n', 'chore: refresh graph');
    assert.equal(classify(cwd, base, next), '');
  });

  it('graphify-out mixed with a source file still returns all three lanes (generated never suppresses a real review)', () => {
    const { cwd, run } = makeRepo();
    const base = commitFile(cwd, run, 'documentation/notes.md', '1\n', 'docs: base');
    commitFile(cwd, run, 'graphify-out/graph.json', '{}\n', 'chore: refresh graph');
    const next = commitFile(cwd, run, 'src/foo.ts', 'export {};\n', 'feat: foo');
    assert.equal(classify(cwd, base, next), 'code-reviewer spec-reviewer doc-updater');
  });

  it('graphify-out mixed with sdd only returns spec-reviewer + doc-updater', () => {
    const { cwd, run } = makeRepo();
    const base = commitFile(cwd, run, 'src/foo.ts', '1\n', 'feat: base');
    commitFile(cwd, run, 'graphify-out/graph.json', '{}\n', 'chore: refresh graph');
    const next = commitFile(cwd, run, 'sdd/memory.md', '# REQ\n', 'spec: REQ');
    assert.equal(classify(cwd, base, next), 'spec-reviewer doc-updater');
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

describe('compute_required_lanes - inert source deltas', () => {
  // A source delta that is provably comments and whitespace changes no
  // behaviour, so the spec and documentation surfaces cannot have drifted.
  // The code lane is never dropped: whether the new comment is TRUE is a
  // code-review question, and keeping that lane is what bounds the damage if
  // the prover is ever wrong (a directive comment such as @ts-expect-error is
  // exactly the case where a comment DOES change behaviour).
  //
  // Every fixture MODIFIES a file committed in an earlier commit. That is
  // load-bearing: an added or deleted file is never inert, however trivial its
  // body, because it changes the set of modules.
  const ALL = 'code-reviewer spec-reviewer doc-updater';

  function seeded(body = 'export const a = 1;\n') {
    const { cwd, run } = makeRepo();
    const base = commitFile(cwd, run, 'src/a.ts', body, 'feat: seed');
    return { cwd, run, base };
  }

  it('a comment-only modification returns the code lane alone', () => {
    const { cwd, run, base } = seeded('export const a = 1; // old\n');
    const head = commitFile(cwd, run, 'src/a.ts', 'export const a = 1; // new\n', 'docs: reword');
    assert.equal(classify(cwd, base, head), 'code-reviewer');
  });

  it('a whitespace-only modification returns the code lane alone', () => {
    const { cwd, run, base } = seeded('export const a = 1;\nexport const b = 2;\n');
    const head = commitFile(cwd, run, 'src/a.ts', 'export const a = 1;\n\n\nexport const b   = 2;\n', 'style: respace');
    assert.equal(classify(cwd, base, head), 'code-reviewer');
  });

  it('a comment change that also touches a code token requires all three lanes', () => {
    const { cwd, run, base } = seeded('export const a = 1; // x\n');
    const head = commitFile(cwd, run, 'src/a.ts', 'export const a = 2; // y\n', 'fix: bump');
    assert.equal(classify(cwd, base, head), ALL);
  });

  it('a comment marker inside a template literal is content, not a comment', () => {
    const { cwd, run, base } = seeded('export const s = `\n// keep\n`;\n');
    const head = commitFile(cwd, run, 'src/a.ts', 'export const s = `\n// changed\n`;\n', 'fix: text');
    assert.equal(classify(cwd, base, head), ALL);
  });

  it('an added comment-only file is never inert', () => {
    const { cwd, run, base } = seeded();
    const head = commitFile(cwd, run, 'src/new.ts', '// just a comment\n', 'chore: add');
    assert.equal(classify(cwd, base, head), ALL);
  });

  it('a renamed file is never inert', () => {
    const { cwd, run, base } = seeded();
    run('mv', 'src/a.ts', 'src/b.ts');
    run('commit', '-q', '-m', 'refactor: rename');
    const head = run('rev-parse', 'HEAD').stdout.trim();
    assert.equal(classify(cwd, base, head), ALL);
  });

  it('a .tsx file is never inert', () => {
    const { cwd, run } = makeRepo();
    const base = commitFile(cwd, run, 'src/a.tsx', 'export const a = 1; // old\n', 'feat: seed');
    const head = commitFile(cwd, run, 'src/a.tsx', 'export const a = 1; // new\n', 'docs: reword');
    assert.equal(classify(cwd, base, head), ALL);
  });

  it('a file containing a NUL byte is never inert', () => {
    const { cwd, run } = makeRepo();
    const base = commitFile(cwd, run, 'src/a.ts', 'export const a = 1; // old\n\0', 'feat: seed');
    const head = commitFile(cwd, run, 'src/a.ts', 'export const a = 1; // new\n\0', 'docs: reword');
    assert.equal(classify(cwd, base, head), ALL);
  });

  it('an inert source delta alongside an sdd/ file still requires all three lanes', () => {
    const { cwd, run, base } = seeded('export const a = 1; // old\n');
    writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 1; // new\n');
    mkdirSync(join(cwd, 'sdd'), { recursive: true });
    writeFileSync(join(cwd, 'sdd/spec.md'), '# spec\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'docs: reword + spec');
    const head = run('rev-parse', 'HEAD').stdout.trim();
    assert.equal(classify(cwd, base, head), ALL);
  });

  it('an inert source delta alongside a documentation/ file requires the code and doc lanes', () => {
    const { cwd, run, base } = seeded('export const a = 1; // old\n');
    writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 1; // new\n');
    mkdirSync(join(cwd, 'documentation'), { recursive: true });
    writeFileSync(join(cwd, 'documentation/x.md'), '# doc\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'docs: reword + doc');
    const head = run('rev-parse', 'HEAD').stdout.trim();
    assert.equal(classify(cwd, base, head), 'code-reviewer doc-updater');
  });
});
