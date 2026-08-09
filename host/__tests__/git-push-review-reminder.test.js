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

// Marks the fixture as SDD-bootstrapped. NOTE: the file is left UNTRACKED --
// only its presence on disk gates the hook. Any test that later stages with
// `git add -A` will sweep it into that commit and silently make the reviewed
// range touch sdd/, which changes the required lane set. Stage by path.
function withSdd(cwd) {
  mkdirSync(join(cwd, 'sdd'), { recursive: true });
  writeFileSync(join(cwd, 'sdd/README.md'), '# fixture\n');
}

function fakeGh(cwd, { state = '', base = 'main', exitCode = 0 } = {}) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
  const binDir = join(cwd, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  // Exact-match fixture (not substring): both hooks now share the
  // gh CLI shape via lib/gh-pr-state.sh — `gh pr view <branch>
  // --json number,state,headRefOid,baseRefName`. Anything else gets exit
  // 99 + stderr noise so an unintended invocation in a future
  // refactor surfaces loudly instead of silently passing.
  const body = `#!/usr/bin/env bash
ARGS="$*"
if [[ "$ARGS" == "pr view "*" --json number,state,headRefOid,baseRefName" ]]; then
  ${state ? `echo '{"number":42,"state":"${state}","headRefOid":"${head}","baseRefName":"${base}"}'` : ''}
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

// REQ-AGENT-036: PR-Boundary Review Trigger Conditions
// REQ-AGENT-044: Review-Agent Discipline Enforcement
// REQ-AGENT-092: Import transition review suppression
// REQ-AGENT-047: Resume Mode closure and review-pipeline gate

describe('git-push-review-reminder.sh — pre-filter', () => {
  it('exits 0 silently on non-push commands', () => {
    const cwd = makeFixture();
    const r = runHook(cwd, 'echo hello');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('git-push-review-reminder.sh — substring false-positive guard', () => {
  // Candidate detection follows the executable command, not words in its
  // arguments. A git commit is a candidate regardless of its message, while
  // echo and similarly quoted examples remain inert.
  it('classifies git commit from executable position regardless of message text', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', exitCode: 0 });
    const r = runHook(
      cwd,
      'git commit -m "fix: integration findings — git push hardening"',
      binDir,
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /authoritative state change on checked-out PR branch/);
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

describe('git-push-review-reminder.sh — structural shell boundaries', () => {
  for (const command of [
    'git -C . status --short',
    'if git status --short; then :; fi',
    'printf "%s\\n" "$(gh pr view)"',
    'echo ready && "git" status --short',
  ]) {
    it(`classifies executable activity in: ${command}`, () => {
      const cwd = makeFixture();
      withSdd(cwd);
      const r = runHook(cwd, command, fakeGh(cwd, { state: 'OPEN', base: 'main' }));
      assert.equal(r.status, 0);
      assert.match(r.stdout, /authoritative state change on checked-out PR branch/);
    });
  }

  for (const command of [
    'printf "%s\\n" "x; git status"',
    "printf '%s\\n' '$(gh pr view)'",
    "cat <<'EOF'\ngit status\nEOF",
  ]) {
    it(`keeps non-executable lookalikes inert in: ${command}`, () => {
      const cwd = makeFixture();
      withSdd(cwd);
      const r = runHook(cwd, command, fakeGhFails(cwd));
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.doesNotMatch(r.stderr, /GH_SHOULD_NOT_HAVE_BEEN_CALLED/);
    });
  }
});

describe('git-push-review-reminder.sh — vibe-coding gate', () => {
  it('exits 0 silently on git push when sdd/ is missing', () => {
    const cwd = makeFixture();
    const r = runHook(cwd, 'git push origin main');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('git-push-review-reminder.sh — authoritative checked-out branch state', () => {
  for (const command of ['git push origin HEAD', 'git status --short', 'git pull --ff-only', 'gh pr view', 'gh pr merge 42 --squash']) {
    it(`emits for unacknowledged current PR state after ${command}`, () => {
      const cwd = makeFixture();
      withSdd(cwd);
      const r = runHook(cwd, command, fakeGh(cwd, { state: 'OPEN', base: 'main' }));
      assert.equal(r.status, 0);
      assert.match(r.stdout, /hookSpecificOutput/);
      assert.match(r.stdout, /authoritative state change on checked-out PR branch/);
    });
  }

  it('does not repeat the launch reminder for the same unacknowledged head', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'main' });

    const first = runHook(cwd, 'git push origin HEAD', binDir);
    const repeated = runHook(cwd, 'gh run view 123 --log-failed', binDir);

    assert.match(first.stdout, /hookSpecificOutput/);
    assert.match(first.stdout, /separate FIX directive next turn/);
    assert.doesNotMatch(first.stdout, /THEN fix every finding/);
    assert.equal(repeated.stdout, '');
  });

  it('requires the structural triage table for a fully clean review round', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const r = runHook(cwd, 'git push origin HEAD', fakeGh(cwd, { state: 'OPEN', base: 'main' }));
    const directive = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

    assert.match(directive, /fully clean round gets one row per required lane/i);
    assert.match(directive, /\| FINDING \| VALIDITY \| PROPOSED FIX \| PROPORTIONALITY \| MINIMAL DECISION \|/);
    assert.doesNotMatch(directive, /do not publish an empty table/i,
      'telling a clean round to omit the table contradicts the Stop hook acknowledgement gate');
  });

  it('stays inert when the authoritative PR head is already acknowledged', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(cwd, '.git', 'sdd-review-ack-pr-42'), `${head}\n`);
    const r = runHook(cwd, 'git status --short', fakeGh(cwd, { state: 'OPEN', base: 'main' }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('stays inert for detached HEAD and non-protected PR bases', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    spawnSync('git', ['checkout', '--detach', '-q'], { cwd });
    const detached = runHook(cwd, 'git status --short', fakeGh(cwd, { state: 'OPEN', base: 'main' }));
    assert.equal(detached.stdout, '');

    const branch = makeFixture();
    withSdd(branch);
    const unprotected = runHook(branch, 'gh pr view', fakeGh(branch, { state: 'OPEN', base: 'staging' }));
    assert.equal(unprotected.stdout, '');
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

  it('evaluates authoritative state for git push from ctx_execute shell code', () => {
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
    assert.match(r.stdout, /authoritative state change on checked-out PR branch/);
  });

  it('evaluates authoritative state for gh pr create from ctx_execute shell code', () => {
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
    assert.match(r.stdout, /authoritative state change on checked-out PR branch/);
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

  it('evaluates authoritative state for gh pr create from ctx_batch_execute', () => {
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
    assert.match(r.stdout, /authoritative state change on checked-out PR branch/);
  });

  it('classifies read-only git commands from ctx_batch_execute', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, { state: 'OPEN', base: 'main', exitCode: 0 });
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
    assert.match(r.stdout, /authoritative state change on checked-out PR branch/);
  });

  it('classifies git commit from ctx_execute regardless of message text', () => {
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
    assert.match(r.stdout, /authoritative state change on checked-out PR branch/);
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
  writeFileSync(join(cwd, '.git/sdd-review-ack-pr-42'), sha);
}

function fakeGhWithHead(cwd, { state = 'OPEN', base = 'main', headSha }) {
  // Same exact-match shape as fakeGh() but parameterises headRefOid so
  // the classifier sees a real reachable SHA. exitCode is implicitly 0.
  const binDir = join(cwd, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  const body = `#!/usr/bin/env bash
ARGS="$*"
if [[ "$ARGS" == "pr view "*" --json number,state,headRefOid,baseRefName" ]]; then
  echo '{"number":42,"state":"${state}","headRefOid":"${headSha}","baseRefName":"${base}"}'
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
    assert.match(r.stdout, /Lanes: doc-updater \(docs\/ lane\) only/,
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
    assert.match(r.stdout, /Lanes: spec-reviewer.*doc-updater/,
      'sdd-only diff must produce the parallel spec+doc directive');
    assert.doesNotMatch(r.stdout, /code-reviewer/,
      'sdd-only directive must NOT mention code-reviewer (no source touch)');
    assert.match(r.stdout, /Code lane silently excluded by Stop hook/,
      'sdd-only directive must explain the code lane exclusion');
  });

  it('emits a code-only directive when the ACK->HEAD diff is source-only', () => {
    // A source-only diff leaves both other surfaces untouched, and no @impl
    // anchor cites the changed file, so the spec and doc lanes would open,
    // find nothing they own, and exit -- each still paying a full startup.
    const cwd = makeFixture();
    withSdd(cwd);
    const ackSha = commitAt(cwd, 'documentation/seed.md', '# seed\n', 'docs: seed');
    writeAck(cwd, ackSha);
    const headSha = commitAt(cwd, 'src/foo.ts', 'export {};\n', 'feat: foo');
    const binDir = fakeGhWithHead(cwd, { headSha });
    const r = runHook(cwd, 'git push origin develop', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Lanes: code-reviewer \(source lane\) only/);
    assert.doesNotMatch(r.stdout, /spec-reviewer/,
      'no sdd/ file changed and no @impl anchor cites the diff');
    assert.match(r.stdout, /Reviewers do not write project or triage files\. The root evaluates findings/,
      'the boundary directive must preserve root-only write ownership');
  });

  it('emits the all-3 directive when the diff touches source and sdd/ together', () => {
    // The all-three branch is now reached by a diff that genuinely gives every
    // lane something to own, rather than by any source touch whatsoever.
    const cwd = makeFixture();
    withSdd(cwd);
    const ackSha = commitAt(cwd, 'documentation/seed.md', '# seed\n', 'docs: seed');
    writeAck(cwd, ackSha);
    commitAt(cwd, 'src/foo.ts', 'export {};\n', 'feat: foo');
    const headSha = commitAt(cwd, 'sdd/spec/thing.md', '# REQ-THING-001\n', 'spec: thing');
    const binDir = fakeGhWithHead(cwd, { headSha });
    const r = runHook(cwd, 'git push origin develop', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Lanes: code-reviewer.*spec-reviewer.*doc-updater/);
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
    assert.match(r.stdout, /Lanes: code-reviewer/);
    assert.match(r.stdout, /Lanes: code-reviewer.*spec-reviewer.*doc-updater/);
  });
});

describe('git-push-review-reminder.sh - inert source delta emission', () => {
  it('emits a code-reviewer-only directive when the source delta is comments only', () => {
    // The saving is only realised if the nudge agrees with the classifier: a
    // code-only lane set must not fall through to the all-three directive,
    // or the agent spawns three lanes the Stop hook then silently excludes.
    const cwd = makeFixture();
    withSdd(cwd);
    const ackSha = commitAt(cwd, 'src/a.ts', 'export const a = 1; // old\n', 'feat: seed');
    writeAck(cwd, ackSha);
    const headSha = commitAt(cwd, 'src/a.ts', 'export const a = 1; // new\n', 'docs: reword');
    const binDir = fakeGhWithHead(cwd, { headSha });
    const r = runHook(cwd, 'git push origin develop', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Lanes: code-reviewer \(source lane\) only/);
    assert.doesNotMatch(r.stdout, /spec-reviewer/,
      'a comment-only delta cannot have moved the spec surface');
    assert.doesNotMatch(r.stdout, /doc-updater/,
      'a comment-only delta cannot have moved the documentation surface');
  });

  it('emits code-reviewer and doc-updater when an inert source delta ships with a doc change', () => {
    // This lane pair became reachable when content-based reduction landed.
    // With no branch of its own it fell through to the all-three directive,
    // which asks for a spec lane the Stop hook then excludes -- the exact
    // nudge/gate disagreement the shared classifier exists to prevent.
    const cwd = makeFixture();
    withSdd(cwd);
    const ackSha = commitAt(cwd, 'src/a.ts', 'export const a = 1; // old\n', 'feat: seed');
    writeAck(cwd, ackSha);
    writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 1; // new\n');
    mkdirSync(join(cwd, 'documentation'), { recursive: true });
    writeFileSync(join(cwd, 'documentation/architecture.md'), '# arch\n');
    // Stage by path, never `git add -A`: withSdd() leaves sdd/README.md
    // UNTRACKED, so -A would sweep it into this commit and the reviewed range
    // really would touch sdd/ -- the spec lane would then be correctly
    // required and this test would be asserting against its own fixture.
    spawnSync('git', ['add', 'src/a.ts', 'documentation/architecture.md'], { cwd });
    spawnSync('git', ['commit', '-q', '-m', 'docs: reword and document'], { cwd });
    const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
    const binDir = fakeGhWithHead(cwd, { headSha });
    const r = runHook(cwd, 'git push origin develop', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code-reviewer/);
    assert.match(r.stdout, /doc-updater/);
    assert.doesNotMatch(r.stdout, /spec-reviewer/,
      'nothing under sdd/ changed, so the spec lane must not be requested');
  });

  // These two are the prover's whole remaining value. Once a lane is spawned
  // only where its surface has work, a source-only diff that no @impl anchor
  // cites requires the code lane whether or not the delta is inert -- so the
  // ONLY place inertness still changes the answer is a cited file. Gut the
  // prover and the second expectation flips; drop the anchor from both and
  // neither test can tell the prover from its absence.
  it('adds the spec lane when a code-token change is cited by an sdd/ @impl anchor', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    commitAt(cwd, 'sdd/spec/x.md', '### AC1\n<!-- @impl: src/a.ts::a -->\n', 'spec: anchor');
    const ackSha = commitAt(cwd, 'src/a.ts', 'export const a = 1; // x\n', 'feat: seed');
    writeAck(cwd, ackSha);
    const headSha = commitAt(cwd, 'src/a.ts', 'export const a = 2; // y\n', 'fix: bump');
    const binDir = fakeGhWithHead(cwd, { headSha });
    const r = runHook(cwd, 'git push origin develop', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Lanes: code-reviewer \(source lane\) and spec-reviewer \(sdd\/ lane\) - both/);
    assert.doesNotMatch(r.stdout, /doc-updater/,
      'nothing under documentation/ changed and no doc anchor cites the diff');
  });

  it('keeps the spec lane out when the cited file changes only comments', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    commitAt(cwd, 'sdd/spec/x.md', '### AC1\n<!-- @impl: src/a.ts::a -->\n', 'spec: anchor');
    const ackSha = commitAt(cwd, 'src/a.ts', 'export const a = 1; // x\n', 'feat: seed');
    writeAck(cwd, ackSha);
    const headSha = commitAt(cwd, 'src/a.ts', 'export const a = 1; // y\n', 'docs: reword');
    const binDir = fakeGhWithHead(cwd, { headSha });
    const r = runHook(cwd, 'git push origin develop', binDir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Lanes: code-reviewer \(source lane\) only/);
    assert.doesNotMatch(r.stdout, /spec-reviewer/,
      'the cited symbol cannot have drifted when only a comment moved');
  });
});
