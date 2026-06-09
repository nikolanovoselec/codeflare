// Real behavioral tests for the SDD PostToolUse hook.
//
// Tests spawn the actual bash script with stdin input and assert on
// exit code + stdout. Each test uses a fresh temp directory as cwd so
// hook side-effects (.git/sdd-pr-cache) don't bleed between tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh',
);

function makeFixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'pushrev-'));
  spawnSync('git', ['init', '-q'], { cwd });
  spawnSync('git', ['config', 'user.email', 'test@test'], { cwd });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd });
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd });
  return cwd;
}

function withSdd(cwd) {
  mkdirSync(join(cwd, 'sdd'), { recursive: true });
  writeFileSync(join(cwd, 'sdd/README.md'), '# fixture\n');
}

function fakeGh(cwd, { state = '', base = 'main', exitCode = 0 } = {}) {
  const binDir = join(cwd, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  // Exact-match fixture (not substring): both hooks now share the
  // gh CLI shape via lib/gh-pr-state.sh — `gh pr view <branch>
  // --json state,headRefOid,baseRefName`. Anything else gets exit
  // 99 + stderr noise so an unintended invocation in a future
  // refactor surfaces loudly instead of silently passing.
  const body = `#!/usr/bin/env bash
ARGS="$*"
if [[ "$ARGS" == "pr view "*" --json state,headRefOid,baseRefName" ]]; then
  ${state ? `echo '{"state":"${state}","headRefOid":"fakehead","baseRefName":"${base}"}'` : ''}
  exit ${exitCode}
fi
echo "FAKE_GH_UNEXPECTED_ARGS: $ARGS" >&2
exit 99
`;
  writeFileSync(join(binDir, 'gh'), body);
  chmodSync(join(binDir, 'gh'), 0o755);
  return binDir;
}

function fakeGhFails(cwd) {
  const binDir = join(cwd, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, 'gh'),
    `#!/usr/bin/env bash\necho "GH_SHOULD_NOT_HAVE_BEEN_CALLED" >&2\nexit 99\n`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  return binDir;
}

function runHook(cwd, command, binDir) {
  return runHookWithInput(cwd, { tool_input: { command } }, binDir);
}

// Helper for issue #317 — feed any tool_input shape (Bash, ctx_execute,
// ctx_batch_execute) through the hook and capture exit + stdout.
function runHookWithInput(cwd, payload, binDir) {
  const env = { ...process.env };
  if (binDir) env.PATH = `${binDir}:${process.env.PATH}`;
  return spawnSync('bash', [HOOK], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env,
  });
}

describe('git-push-review-reminder.sh — pre-filter', () => {
  it('exits 0 silently on non-push commands', () => {
    const cwd = makeFixture();
    const r = runHook(cwd, 'echo hello');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('git-push-review-reminder.sh — substring false-positive guard', () => {
  // Regression for the bug class shared with enforce-review-spawn.sh
  // PUSH_LINE: substring match `*"git push"*` triggers on commit
  // messages or echo strings that mention `git push` as text. The
  // fix anchors `git push` to start-of-command or after a shell
  // separator. Without this guard, `git commit -m "...git push..."`
  // emits a spurious PR-SYNC directive.
  it('does NOT classify a git commit whose message body mentions "git push"', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', exitCode: 0 });
    const r = runHook(
      cwd,
      'git commit -m "fix: integration findings — git push hardening"',
      binDir,
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '',
      'commit message containing "git push" must not classify as a push trigger');
  });

  it('does NOT classify an echo whose argument mentions "git push"', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', exitCode: 0 });
    const r = runHook(cwd, 'echo "I will git push later"', binDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('does NOT classify "git pushy" or "git push-something" as git push', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', exitCode: 0 });
    const r = runHook(cwd, 'echo git pushy', binDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('git-push-review-reminder.sh — vibe-coding gate', () => {
  it('exits 0 silently on git push when sdd/ is missing', () => {
    const cwd = makeFixture();
    const r = runHook(cwd, 'git push origin main');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('git-push-review-reminder.sh — PR-OPEN trigger (base-gated)', () => {
  it('emits silent directive when gh pr create lands a PR targeting main', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'main', exitCode: 0 });
    const r = runHook(cwd, 'gh pr create --base main --head feature', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/);
    assert.match(r.stdout, /PR open/);
  });

  it('emits silent directive when gh pr create lands a PR targeting master', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'master', exitCode: 0 });
    const r = runHook(cwd, 'gh pr create --base master --head feature', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/);
  });

  it('exits silently when gh pr create lands a PR targeting develop', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'develop', exitCode: 0 });
    const r = runHook(cwd, 'gh pr create --base develop --head feature', binDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '',
      'PR targeting develop must defer until the develop → main PR opens');
  });

  it('falls open and emits directive when gh transient-fails on PR-OPEN', () => {
    // Fail-open direction: a transient gh failure right after PR creation
    // should not skip review. The Stop hook re-checks at turn end and
    // would silently exit 0 if base is actually develop, so this is
    // safe over-emission.
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: '', exitCode: 0 });
    const r = runHook(cwd, 'gh pr create --base main --head feature', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/);
  });
});

describe('git-push-review-reminder.sh — PR-RETARGET trigger (protected-base gh pr edit)', () => {
  it('emits silent directive when gh pr edit retargets to main/master across flag forms', () => {
    for (const command of [
      'gh pr edit 286 --base main',
      'gh pr edit --base=master',
      'gh pr edit 286 -B main',
    ]) {
      const cwd = makeFixture();
      withSdd(cwd);
      const binDir = fakeGhFails(cwd);
      const r = runHook(cwd, command, binDir);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /additionalContext/, command);
      assert.match(r.stdout, /PR retarget to main\/master/, command);
      assert.doesNotMatch(r.stderr, /GH_SHOULD_NOT_HAVE_BEEN_CALLED/,
        'retarget command base is authoritative; hook must not depend on stale gh view');
    }
  });

  it('exits silently for non-protected retargets and metadata-only edits', () => {
    for (const command of [
      'gh pr edit 286 --base develop',
      'gh pr edit 286 --title "metadata only"',
    ]) {
      const cwd = makeFixture();
      withSdd(cwd);
      const binDir = fakeGhFails(cwd);
      const r = runHook(cwd, command, binDir);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '', command);
      assert.doesNotMatch(r.stderr, /GH_SHOULD_NOT_HAVE_BEEN_CALLED/);
    }
  });
});

describe('git-push-review-reminder.sh — PR-SYNC trigger (base-gated)', () => {
  it('emits silent directive on git push when current branch has open PR to main', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'main', exitCode: 0 });
    const r = runHook(cwd, 'git push origin feature', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/);
    assert.match(r.stdout, /PR-sync/);
  });

  it('detects git push on its own line in a NEWLINE-separated command', () => {
    // Regression: the trigger regex's separator class was [;&|], excluding \n,
    // so a multi-line Bash command with `git push` on a later line silently
    // emitted no review directive. COMMAND is now newline-normalized to ';'.
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'main', exitCode: 0 });
    const r = runHook(cwd, 'git checkout feature\ngit push origin feature', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/);
    assert.match(r.stdout, /PR-sync/);
  });

  it('emits silent directive when current branch has open PR to master', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'master', exitCode: 0 });
    const r = runHook(cwd, 'git push origin feature', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/);
  });

  it('exits silently on git push when open PR targets develop (not main)', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'develop', exitCode: 0 });
    const r = runHook(cwd, 'git push origin feature', binDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '',
      'feature → develop must defer until the develop → main PR opens');
  });

  it('exits 0 silently on git push when no open PR exists (deferred)', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: '', exitCode: 1 });
    const r = runHook(cwd, 'git push origin feature', binDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('detects chained pipelines like `git add && git push` and gates on base', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'main', exitCode: 0 });
    const r = runHook(cwd, 'git add . && git commit -m x && git push origin feature', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/);
  });

  it('fires on git push when gh returns OPEN with empty baseRefName (fail-open)', () => {
    // Regression test for parity with enforce-review-spawn.sh 7580b15
    // fix: when the live gh call returns state=OPEN but baseRefName is
    // empty (jq parse edge case), the case statement must match `""`
    // and fall through to enforcement rather than silently exit.
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = join(cwd, 'fake-bin');
    mkdirSync(binDir, { recursive: true });
    // Hand-rolled fixture: state present, baseRefName field absent.
    writeFileSync(join(binDir, 'gh'), `#!/usr/bin/env bash
ARGS="$*"
if [[ "$ARGS" == "pr view "*" --json state,headRefOid,baseRefName" ]]; then
  echo '{"state":"OPEN","headRefOid":"fakehead"}'
  exit 0
fi
echo "FAKE_GH_UNEXPECTED_ARGS: $ARGS" >&2
exit 99
`);
    chmodSync(join(binDir, 'gh'), 0o755);
    const r = runHook(cwd, 'git push origin feature', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/,
      'empty baseRefName must fail open and fire review (parity with Stop hook)');
  });

  it('exits 0 silently on detached HEAD', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    spawnSync('git', ['checkout', '--detach', '-q'], { cwd });
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'main', exitCode: 0 });
    const r = runHook(cwd, 'git push origin HEAD', binDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('git-push-review-reminder.sh — cache behavior (3-line schema)', () => {
  it('uses cached OPEN+main result without calling gh', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const gitCommonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    writeFileSync(join(cwd, gitCommonDir, 'sdd-pr-cache'), `${branch}\nOPEN\nmain\n`);
    const binDir = fakeGhFails(cwd);  // gh exits 99 — proves cache was used
    const r = runHook(cwd, 'git push origin feature', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/);
    assert.doesNotMatch(r.stderr, /GH_SHOULD_NOT_HAVE_BEEN_CALLED/,
      'fresh OPEN+main cache must short-circuit the gh call');
  });

  it('uses cached OPEN+develop result to skip silently without calling gh', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const gitCommonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    writeFileSync(join(cwd, gitCommonDir, 'sdd-pr-cache'), `${branch}\nOPEN\ndevelop\n`);
    const binDir = fakeGhFails(cwd);
    const r = runHook(cwd, 'git push origin feature', binDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '',
      'cached develop-base PR must defer without firing review');
    assert.doesNotMatch(r.stderr, /GH_SHOULD_NOT_HAVE_BEEN_CALLED/);
  });

  it('uses cached empty-PR result to skip silently without calling gh', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const gitCommonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    writeFileSync(join(cwd, gitCommonDir, 'sdd-pr-cache'), `${branch}\n\n\n`);
    const binDir = fakeGhFails(cwd);
    const r = runHook(cwd, 'git push origin feature', binDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('uses cached OPEN+empty-base result and fires (fail-open parity with Stop hook)', () => {
    // 3-line cache where line 3 is empty (gh returned state OPEN but
    // jq couldn't extract baseRefName on the previous push). Should
    // be treated as a valid cache hit (no gh re-query) and PR_BASE=""
    // should fall through the main|master|"" case and fire review.
    const cwd = makeFixture();
    withSdd(cwd);
    const gitCommonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    writeFileSync(join(cwd, gitCommonDir, 'sdd-pr-cache'), `${branch}\nOPEN\n\n`);
    const binDir = fakeGhFails(cwd);  // gh exits 99 — proves cache was used
    const r = runHook(cwd, 'git push origin feature', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/,
      'OPEN+empty-base cache must fail open and fire review');
    assert.doesNotMatch(r.stderr, /GH_SHOULD_NOT_HAVE_BEEN_CALLED/,
      '3-line cache (even with empty base) must short-circuit gh');
  });

  it('legacy 2-line OPEN cache (no base) re-queries gh and rewrites in 3-line schema', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const gitCommonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    const cachePath = join(cwd, gitCommonDir, 'sdd-pr-cache');
    writeFileSync(cachePath, `${branch}\nOPEN\n`);  // legacy 2-line
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'main', exitCode: 0 });
    const r = runHook(cwd, 'git push origin feature', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/,
      'legacy 2-line OPEN cache must fall through to gh and re-evaluate');
    const rewritten = readFileSync(cachePath, 'utf-8');
    assert.match(rewritten, /^[^\n]+\nOPEN\nmain\n$/,
      'cache must be rewritten in 3-line schema');
  });
});

describe('git-push-review-reminder.sh — MCP shell tool input shapes (issue #317)', () => {
  // Issue #317: enforce-ctx-mode.sh denies gh/curl/git-log in the Bash tool
  // and forces those invocations through MCP shell tools (ctx_execute /
  // ctx_batch_execute). The hook used to extract command from
  // .tool_input.command only — so when an agent retried `gh pr create`
  // through ctx_execute, COMMAND was empty, the trigger never fired, and
  // the SDD review pipeline silently skipped that PR. These tests pin the
  // fix: the hook must classify identically regardless of which tool
  // surfaced the command.

  it('classifies git push from ctx_execute shell code (PR-SYNC)', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'main', exitCode: 0 });
    const r = runHookWithInput(
      cwd,
      { tool_input: { language: 'shell', code: 'git push origin develop' } },
      binDir,
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/,
      'ctx_execute shell shape must fire the review directive');
    assert.match(r.stdout, /SDD push to PR-tracked branch/,
      'must classify as PR-sync');
  });

  it('classifies gh pr create from ctx_execute shell code (PR-OPEN)', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'main', exitCode: 0 });
    const r = runHookWithInput(
      cwd,
      {
        tool_input: {
          language: 'shell',
          code: 'gh pr create --base main --title x --body y',
        },
      },
      binDir,
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/);
    assert.match(r.stdout, /SDD PR open/,
      'must classify as PR-open trigger');
  });

  it('ignores ctx_execute with non-shell language even if code mentions git push', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGhFails(cwd); // gh must not be called
    const r = runHookWithInput(
      cwd,
      {
        tool_input: {
          language: 'javascript',
          code: 'const msg = "next step: git push";',
        },
      },
      binDir,
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '',
      'non-shell ctx_execute language must never trigger the hook');
  });

  it('classifies git push from ctx_batch_execute commands[].command', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'main', exitCode: 0 });
    const r = runHookWithInput(
      cwd,
      {
        tool_input: {
          commands: [
            { label: 'status', command: 'git status' },
            { label: 'push', command: 'git push origin develop' },
          ],
        },
      },
      binDir,
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/,
      'ctx_batch_execute shape must fire the review directive when any command is git push');
  });

  it('classifies gh pr create from ctx_batch_execute commands[].command', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'main', exitCode: 0 });
    const r = runHookWithInput(
      cwd,
      {
        tool_input: {
          commands: [
            { label: 'open', command: 'gh pr create --base main -t x -b y' },
          ],
        },
      },
      binDir,
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /SDD PR open/);
  });

  it('does not classify ctx_batch_execute when no command contains git push or gh pr create', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGhFails(cwd);
    const r = runHookWithInput(
      cwd,
      {
        tool_input: {
          commands: [
            { label: 'list', command: 'git status' },
            { label: 'log', command: 'git log --oneline -3' },
          ],
        },
      },
      binDir,
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('does not classify a commit message in ctx_execute code that mentions git push', () => {
    // Substring-vs-anchored-regex parity check: the false-positive guard
    // that exists for Bash must hold for ctx_execute too.
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'main', exitCode: 0 });
    const r = runHookWithInput(
      cwd,
      {
        tool_input: {
          language: 'shell',
          code: 'git commit -m "fix: integration findings - git push hardening"',
        },
      },
      binDir,
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '',
      'commit message containing "git push" must not trigger via ctx_execute either');
  });
});

describe('git-push-review-reminder.sh - SDD transition gate (REQ-AGENT-022)', () => {
  function withTransitionConfig(cwd, { transition = true } = {}) {
    writeFileSync(
      join(cwd, 'sdd/config.yml'),
      `mode: interactive\nenforce_tdd: false\n${transition ? 'transition: true' : '# transition: false'}\n`,
    );
  }

  function withTriage(cwd, body) {
    writeFileSync(join(cwd, 'sdd/.init-triage.md'), body);
  }

  it('exits 0 silently when transition: true AND triage has Status: open', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    withTransitionConfig(cwd);
    withTriage(cwd, '## TRIAGE-001\n**Status:** open\n');
    const binDir = fakeGhFails(cwd); // gh must NOT be called
    const r = runHook(cwd, 'git push origin develop', binDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '',
      'transition with open triage suppresses the review directive');
  });

  it('exits 0 silently with mixed-case Status: Open (case-insensitive)', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    withTransitionConfig(cwd);
    withTriage(cwd, '## TRIAGE-001\n**Status:** Open\n');
    const binDir = fakeGhFails(cwd);
    const r = runHook(cwd, 'git push origin develop', binDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('fires normally when transition: true but every triage item is resolved/lost', () => {
    // Corrupted state OR end-of-transition: triage file has no open items.
    // Hook should NOT suppress -- the run proceeds so spec-reviewer can
    // flag the missing closure (transition: true should have cleared).
    const cwd = makeFixture();
    withSdd(cwd);
    withTransitionConfig(cwd);
    withTriage(cwd, '## TRIAGE-001\n**Status:** resolved\n\n## TRIAGE-002\n**Status:** lost\n');
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'main', exitCode: 0 });
    const r = runHook(cwd, 'git push origin develop', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/,
      'no open items means run proceeds to the normal PR-SYNC path');
  });

  it('fires normally when .init-triage.md is missing entirely', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    // No transition config, no triage file -- normal project state
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'main', exitCode: 0 });
    const r = runHook(cwd, 'git push origin develop', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/,
      'no transition state at all means review fires normally');
  });

  it('fires normally when transition: false even if .init-triage.md has open items', () => {
    // Conjunction: both transition: true AND open items required. If
    // config flag is cleared but triage file lingers (e.g. archive),
    // review must still fire.
    const cwd = makeFixture();
    withSdd(cwd);
    withTransitionConfig(cwd, { transition: false });
    withTriage(cwd, '## TRIAGE-001\n**Status:** open\n');
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'main', exitCode: 0 });
    const r = runHook(cwd, 'git push origin develop', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/,
      'transition: false means review fires regardless of stale triage file');
  });
});

// Helpers for the lane-aware emission tests below. The default fakeGh
// emits a synthetic "fakehead" SHA which the classifier cannot diff
// against a real commit. These helpers wire a real git history so the
// hook's compute_required_lanes call sees an actual diff.
function commitAt(cwd, relpath, body, msg) {
  const abs = join(cwd, relpath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  spawnSync('git', ['add', relpath], { cwd });
  spawnSync('git', ['commit', '-q', '-m', msg], { cwd });
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
    .stdout.trim();
}

function writeAck(cwd, sha) {
  // SHA-shape validation in the hook requires a 40-char lowercase hex
  // string. `git rev-parse HEAD` already returns that shape on Linux.
  mkdirSync(join(cwd, '.git'), { recursive: true });
  writeFileSync(join(cwd, '.git/sdd-last-ack-pr-head'), sha);
}

function fakeGhWithHead(cwd, { state = 'OPEN', base = 'main', headSha }) {
  // Same exact-match shape as fakeGh() but parameterises headRefOid so
  // the classifier sees a real reachable SHA. exitCode is implicitly 0.
  const binDir = join(cwd, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  const body = `#!/usr/bin/env bash
ARGS="$*"
if [[ "$ARGS" == "pr view "*" --json state,headRefOid,baseRefName" ]]; then
  echo '{"state":"${state}","headRefOid":"${headSha}","baseRefName":"${base}"}'
  exit 0
fi
echo "FAKE_GH_UNEXPECTED_ARGS: $ARGS" >&2
exit 99
`;
  writeFileSync(join(binDir, 'gh'), body);
  chmodSync(join(binDir, 'gh'), 0o755);
  return binDir;
}

describe('git-push-review-reminder.sh - lane-aware emission (compute_required_lanes integration)', () => {
  // The PostToolUse nudge now classifies the LAST_ACK..CURRENT_PR_HEAD
  // diff and emits a directive listing ONLY the lanes the Stop hook
  // would actually require. The pre-existing tests above all run with
  // an empty ACK file -> classifier short-circuits to "all 3" -> the
  // lane-aware branches are never exercised. These cases pin the new
  // emission shapes so a regression that flips them back to "all 3"
  // would be caught by CI instead of slipping silently into prod.

  it('emits doc-updater-only directive when ACK->HEAD diff is documentation-only', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const ackSha = commitAt(cwd, 'src/seed.ts', 'export {};\n', 'feat: seed');
    writeAck(cwd, ackSha);
    const headSha = commitAt(cwd, 'documentation/notes.md', '# notes\n', 'docs: notes');
    const binDir = fakeGhWithHead(cwd, { headSha });
    const r = runHook(cwd, 'git push origin develop', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/);
    assert.match(r.stdout, /Spawn: doc-updater \(docs\/ lane\) only/,
      'doc-only diff must produce the doc-only directive shape');
    assert.doesNotMatch(r.stdout, /code-reviewer/,
      'doc-only directive must NOT mention code-reviewer');
    assert.doesNotMatch(r.stdout, /spec-reviewer/,
      'doc-only directive must NOT mention spec-reviewer');
  });

  it('emits spec+doc parallel directive when ACK->HEAD diff is sdd/-only', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const ackSha = commitAt(cwd, 'src/seed.ts', 'export {};\n', 'feat: seed');
    writeAck(cwd, ackSha);
    const headSha = commitAt(cwd, 'sdd/memory.md', '# REQ-MEM-001\n', 'spec: REQ');
    const binDir = fakeGhWithHead(cwd, { headSha });
    const r = runHook(cwd, 'git push origin develop', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Parallel: spec-reviewer.*doc-updater/,
      'sdd-only diff must produce the parallel spec+doc directive');
    assert.doesNotMatch(r.stdout, /code-reviewer/,
      'sdd-only directive must NOT mention code-reviewer (no source touch)');
    assert.match(r.stdout, /Code lane silently excluded by Stop hook/,
      'sdd-only directive must explain the code lane exclusion');
  });

  it('emits legacy all-3 directive when ACK->HEAD diff contains source files', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const ackSha = commitAt(cwd, 'documentation/seed.md', '# seed\n', 'docs: seed');
    writeAck(cwd, ackSha);
    const headSha = commitAt(cwd, 'src/foo.ts', 'export {};\n', 'feat: foo');
    const binDir = fakeGhWithHead(cwd, { headSha });
    const r = runHook(cwd, 'git push origin develop', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Parallel: code-reviewer/);
    assert.match(r.stdout, /Parallel: code-reviewer.*spec-reviewer.*doc-updater/);
  });

  it('emits no directive when LAST_ACK equals CURRENT_PR_HEAD (already acked)', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const sha = commitAt(cwd, 'src/foo.ts', 'export {};\n', 'feat: foo');
    writeAck(cwd, sha);
    const binDir = fakeGhWithHead(cwd, { headSha: sha });
    const r = runHook(cwd, 'git push origin develop', binDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '',
      'classifier returns empty when last_ack == current; hook must skip emission');
  });

  it('falls back to legacy all-3 directive when LAST_ACK is empty (initial baseline)', () => {
    // Regression guard for the empty-ACK case the prior 33 tests
    // exercised. Confirms the lane-aware refactor preserves the
    // initial-baseline behaviour: no ACK -> classifier returns all 3
    // -> directive emits all 3.
    const cwd = makeFixture();
    withSdd(cwd);
    const headSha = commitAt(cwd, 'src/foo.ts', 'export {};\n', 'feat: foo');
    const binDir = fakeGhWithHead(cwd, { headSha });
    const r = runHook(cwd, 'git push origin develop', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Parallel: code-reviewer/);
    assert.match(r.stdout, /Parallel: code-reviewer.*spec-reviewer.*doc-updater/);
  });
});
