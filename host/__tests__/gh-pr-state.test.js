// resolve_review_head decides the SHA a review RANGE ends at. Both the
// PostToolUse nudge and the Stop gate classify through it, so a divergence
// here makes the two consumers of lane-classifier.sh demand different lanes
// for the same push -- the disagreement the shared classifier exists to stop.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

function runHelper(cwd, script, args = [], env = {}) {
  return spawnSync('bash', ['-s', '--', LIB, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input: `. "$1"\n${script}`,
  });
}

function fakeMergeGh(cwd, { sourceState = 'MERGED', sourceBase = 'develop', mergeOid = 'a'.repeat(40), promotionHead = 'a'.repeat(40) } = {}) {
  const bin = join(cwd, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  const log = join(cwd, 'gh.log');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
case "$*" in
  "repo view --json nameWithOwner") echo '{"nameWithOwner":"owner/repo"}' ;;
  "pr view 768 --json number,state,baseRefName,headRefName,headRefOid,mergeCommit,url") echo '{"number":768,"state":"${sourceState}","baseRefName":"${sourceBase}","headRefName":"feature","headRefOid":"${'b'.repeat(40)}","mergeCommit":{"oid":"${mergeOid}"},"url":"https://github.com/owner/repo/pull/768"}' ;;
  "pr list --state open --head develop --json number,state,baseRefName,headRefName,headRefOid,headRepositoryOwner") echo '[{"number":761,"state":"OPEN","baseRefName":"main","headRefName":"develop","headRefOid":"${promotionHead}","headRepositoryOwner":{"login":"owner"}}]' ;;
  *) echo "unexpected gh args: $*" >&2; exit 99 ;;
esac
`);
  chmodSync(join(bin, 'gh'), 0o755);
  return { env: { PATH: `${bin}:${process.env.PATH}` }, log };
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

describe('REQ-AGENT-121/122: Claude downstream develop merge boundary', () => {
  it('parses synchronous selectors and rejects auto, cross-repository, and ambiguous forms', () => {
    const { cwd } = repo();
    for (const [command, expected] of [
      ['gh pr merge 768 --squash', '768'],
      ['gh pr merge --squash 768', '768'],
      ['gh pr merge -t "release title" 768', '768'],
      ['gh pr merge https://github.com/owner/repo/pull/768 --squash', 'https://github.com/owner/repo/pull/768'],
      ['cd /tmp && gh pr merge --squash', '__IMPLICIT__'],
    ]) {
      const result = runHelper(cwd, 'parse_gh_pr_merge_selector "$2"', [command]);
      assert.equal(result.status, 0, command);
      assert.equal(result.stdout.trim(), expected, command);
    }
    const outside = mkdtempSync(join(tmpdir(), 'ghprstate-outside-'));
    const resolved = runHelper(outside, 'resolve_merge_command_repo "$2" "$3"', [`cd "${cwd}" && gh pr merge 768 --squash`, outside]);
    assert.equal(resolved.status, 0);
    assert.equal(resolved.stdout.trim(), cwd);

    for (const command of [
      'gh pr merge 768 --auto',
      'gh pr merge 768 --disable-auto',
      'gh pr merge 768 --repo owner/other',
      'gh pr merge 768 -Rowner/other',
      'gh pr merge 768 other',
    ]) {
      const result = runHelper(cwd, 'parse_gh_pr_merge_selector "$2"', [command]);
      assert.notEqual(result.status, 0, command);
    }
  });

  it('persists and reuses the exact canonical downstream promotion boundary', () => {
    const { cwd } = repo();
    const { env, log } = fakeMergeGh(cwd);
    const common = join(cwd, '.git');
    const script = 'resolve_develop_merge_boundary "$2" "$3" "$4"';
    const first = runHelper(cwd, script, ['gh pr merge 768 --squash', common, 'toolu_merge'], env);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), {
      version: 1,
      status: 'ready',
      attempts: 0,
      sourcePr: 768,
      mergeOid: 'a'.repeat(40),
      downstreamPr: 761,
      downstreamBase: 'main',
      downstreamHead: 'a'.repeat(40),
      directiveEmitted: false,
    });
    const callsAfterFirst = readFileSync(log, 'utf8');
    const second = runHelper(cwd, script, ['gh pr merge 768 --squash', common, 'toolu_merge'], env);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, first.stdout);
    assert.equal(readFileSync(log, 'utf8'), callsAfterFirst, 'ready state avoids duplicate GitHub lookups');
  });

  it('rejects a foreign pull-request URL before querying that pull request', () => {
    const { cwd } = repo();
    const { env, log } = fakeMergeGh(cwd);
    const result = runHelper(cwd, 'resolve_develop_merge_boundary "$2" "$3" "$4"', [
      'gh pr merge https://github.com/other/repo/pull/768 --squash',
      join(cwd, '.git'),
      'toolu_foreign',
    ], env);
    assert.equal(result.status, 11);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['repo view --json nameWithOwner']);
  });

  it('bounds stale-head recovery across reloads and never performs a fourth lookup', () => {
    const { cwd } = repo();
    const { env, log } = fakeMergeGh(cwd, { promotionHead: 'c'.repeat(40) });
    const common = join(cwd, '.git');
    const script = 'resolve_develop_merge_boundary "$2" "$3" "$4"';
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = runHelper(cwd, script, ['gh pr merge 768 --squash', common, 'toolu_stale'], env);
      assert.equal(result.status, attempt < 3 ? 10 : 11, `attempt ${attempt}: ${result.stderr}`);
    }
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.filter((line) => line.startsWith('pr view ')).length, 3);
    assert.equal(calls.filter((line) => line.startsWith('pr list ')).length, 3);
  });

  it('fails closed before GitHub lookup when persisted accounting is malformed or unwritable', () => {
    const { cwd } = repo();
    const poison = join(cwd, 'poison-bin');
    mkdirSync(poison);
    const log = join(cwd, 'poison.log');
    writeFileSync(join(poison, 'gh'), `#!/usr/bin/env bash\nprintf called >> "${log}"\nexit 99\n`);
    chmodSync(join(poison, 'gh'), 0o755);
    const env = { PATH: `${poison}:${process.env.PATH}` };
    const common = join(cwd, '.git');
    const statePath = runHelper(cwd, 'merge_boundary_state_file "$2" "$3"', [common, 'toolu_bad']).stdout.trim();
    writeFileSync(statePath, '{broken');
    const malformed = runHelper(cwd, 'resolve_develop_merge_boundary "$2" "$3" "$4"', ['gh pr merge 768 --squash', common, 'toolu_bad'], env);
    assert.equal(malformed.status, 12);
    const accountingFile = join(cwd, 'not-a-directory');
    writeFileSync(accountingFile, 'x');
    const unwritable = runHelper(cwd, 'resolve_develop_merge_boundary "$2" "$3" "$4"', ['gh pr merge 768 --squash', accountingFile, 'toolu_write'], env);
    assert.equal(unwritable.status, 12);
    assert.equal(existsSync(log), false);
  });
});
