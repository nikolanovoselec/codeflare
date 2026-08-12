// resolve_review_head decides the SHA a review RANGE ends at. Both the
// PostToolUse nudge and the Stop gate classify through it, so a divergence
// here makes the two consumers of lane-classifier.sh demand different lanes
// for the same push -- the disagreement the shared classifier exists to stop.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/gh-pr-state.sh',
);

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'ghprstate-'));
  const git = (...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();
  git('init', '-q');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'Test');
  const commit = (body, msg) => {
    writeFileSync(join(cwd, 'a.ts'), body);
    git('add', '-A'); git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  return { cwd, git, commit };
}

function resolve(cwd, ghHead) {
  // Script on stdin, values as positional args: no command string is built
  // from an environment value (CodeQL js/shell-command-injection-from-environment).
  return spawnSync('bash', ['-s', '--', LIB, ghHead], {
    cwd,
    encoding: 'utf8',
    input: '. "$1"; resolve_review_head "$2"',
  }).stdout.trim();
}

describe('resolve_review_head', () => {
  it('prefers local HEAD only when it provably contains the reported head', () => {
    const { cwd, commit } = repo();
    const gh = commit('a\n', 'one');
    const local = commit('b\n', 'two');
    // The lagging-metadata case this exists for: the range must reach the
    // commit that was just pushed, not stop one short of it.
    assert.equal(resolve(cwd, gh), local);
    assert.equal(resolve(cwd, local), local, 'equal SHAs resolve to the same head');
  });

  it('keeps the reported head whenever local HEAD is not a descendant', () => {
    const { cwd, git, commit } = repo();
    const gh = commit('a\n', 'one');
    const local = commit('b\n', 'two');
    git('checkout', '-q', '-b', 'other', gh);
    commit('c\n', 'divergent');
    // Divergent, unknown, and empty all mean the range may not narrow: a
    // rejected push or a concurrent push from elsewhere leaves local behind.
    assert.equal(resolve(cwd, local), local, 'divergent local HEAD must not narrow the range');
    const unknown = '0'.repeat(40);
    assert.equal(resolve(cwd, unknown), unknown, 'a SHA absent locally is kept verbatim');
  });
});

describe('gh_pr_state', () => {
  // The stderr capture file is removed on the normal path only — a sourced
  // library must not own process-global signal traps — so this is the guard
  // that a future early return between mktemp and rm does not start leaking
  // one file per hook invocation.
  it('leaves no stderr capture file behind on found or not-found paths', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ghprstate-'));
    const bin = join(cwd, 'bin');
    const scratch = join(cwd, 'scratch');
    mkdirSync(bin);
    mkdirSync(scratch);
    writeFileSync(join(bin, 'gh'), [
      '#!/usr/bin/env bash',
      'case "$GH_MODE" in',
      '  found) printf %s \'{"number":7}\' ;;',
      '  *) echo "no pull requests found for branch" >&2; exit 1 ;;',
      'esac',
    ].join('\n'));
    chmodSync(join(bin, 'gh'), 0o755);
    for (const mode of ['found', 'notfound']) {
      const r = spawnSync('bash', ['-s', '--', LIB], {
        cwd,
        encoding: 'utf8',
        // rc is echoed rather than propagated so one spawn asserts both the
        // numeric contract and the cleanup. A bare status assertion here was
        // tautological: the script's own `exit 0` made it unfalsifiable.
        input: '. "$1"; gh_pr_state some-branch; echo "rc=$?"; exit 0',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: scratch, GH_MODE: mode },
      });
      assert.match(r.stdout, new RegExp(`^rc=${mode === 'found' ? 0 : 1}$`, 'm'),
        `${mode} path keeps its exit contract (authoritative not-found is 1, never the transient 3)`);
      if (mode === 'found') {
        assert.match(r.stdout, /"number":7/, 'found path passes the JSON through');
      }
      assert.deepEqual(readdirSync(scratch), [], `no capture file left after the ${mode} path`);
    }
  });
});
