// Real behavioral tests for the SDD PostToolUse hook.
//
// Tests spawn the actual bash script with stdin input and assert on
// exit code + stdout. Each test uses a fresh temp directory as cwd so
// hook side-effects (.git/sdd-pr-cache) don't bleed between tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
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

function fakeGh(cwd, { state = '', exitCode = 0 } = {}) {
  const binDir = join(cwd, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  // Exact-match fixture (not substring): both hooks now share the
  // gh CLI shape via lib/gh-pr-state.sh — `gh pr view <branch>
  // --json state,headRefOid`. Anything else gets exit 99 + stderr
  // noise so an unintended invocation in a future refactor surfaces
  // loudly instead of silently passing.
  const body = `#!/usr/bin/env bash
ARGS="$*"
if [[ "$ARGS" == "pr view "*" --json state,headRefOid" ]]; then
  ${state ? `echo '{"state":"${state}","headRefOid":"fakehead"}'` : ''}
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
  const env = { ...process.env };
  if (binDir) env.PATH = `${binDir}:${process.env.PATH}`;
  return spawnSync('bash', [HOOK], {
    cwd,
    input: JSON.stringify({ tool_input: { command } }),
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

describe('git-push-review-reminder.sh — PR-OPEN trigger', () => {
  it('emits silent directive on `gh pr create` in SDD project', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: '', exitCode: 0 });
    const r = runHook(cwd, 'gh pr create --base develop --head feature', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/);
    assert.match(r.stdout, /PR open/);
  });
});

describe('git-push-review-reminder.sh — PR-SYNC trigger', () => {
  it('emits silent directive on git push when current branch has open PR', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', exitCode: 0 });
    const r = runHook(cwd, 'git push origin feature', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/);
    assert.match(r.stdout, /PR-sync/);
  });

  it('exits 0 silently on git push when no open PR exists (deferred)', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: '', exitCode: 1 });
    const r = runHook(cwd, 'git push origin feature', binDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('detects chained pipelines like `git add && git push`', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', exitCode: 0 });
    const r = runHook(cwd, 'git add . && git commit -m x && git push origin feature', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/);
  });

  it('exits 0 silently on detached HEAD', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    spawnSync('git', ['checkout', '--detach', '-q'], { cwd });
    const binDir = fakeGh(cwd, { state: 'OPEN', exitCode: 0 });
    const r = runHook(cwd, 'git push origin HEAD', binDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('git-push-review-reminder.sh — cache behavior', () => {
  it('uses cached OPEN result without calling gh', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const gitCommonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    writeFileSync(join(cwd, gitCommonDir, 'sdd-pr-cache'), `${branch}\nOPEN\n`);
    const binDir = fakeGhFails(cwd);  // gh exits 99 — proves cache was used
    const r = runHook(cwd, 'git push origin feature', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /additionalContext/);
    assert.doesNotMatch(r.stderr, /GH_SHOULD_NOT_HAVE_BEEN_CALLED/,
      'fresh OPEN cache must short-circuit the gh call');
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
    writeFileSync(join(cwd, gitCommonDir, 'sdd-pr-cache'), `${branch}\n\n`);
    const binDir = fakeGhFails(cwd);
    const r = runHook(cwd, 'git push origin feature', binDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});
