import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh');
const STATE = join(ROOT, 'preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/review-completion-state.mjs');
const roots = [];

function temp(prefix) {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function setup() {
  const home = temp('claude-review-home-');
  const repo = temp('claude-review-repo-');
  const bin = temp('claude-review-bin-');
  git(repo, 'init', '-q');
  git(repo, 'branch', '-M', 'feature');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'test@example.test');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  mkdirSync(join(repo, 'sdd/spec'), { recursive: true });
  writeFileSync(join(repo, 'sdd/README.md'), '# SDD\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  writeFileSync(join(repo, 'src.ts'), 'export const changed = true;\n');
  writeFileSync(join(repo, 'sdd/spec/review.md'), '# review\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'change');
  const head = git(repo, 'rev-parse', 'HEAD');
  const transcript = join(repo, 'transcript.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ type: 'session', cwd: repo })}\n`);
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/usr/bin/env bash
case "$1 $2" in
  "repo view") printf '%s\\n' '{"nameWithOwner":"owner/repo","url":"https://github.com/owner/repo"}' ;;
  "pr view")
    [ "\${GH_FAIL:-0}" = 0 ] || exit 1
    HEAD_VALUE="\${PR_HEAD}"
    if [ -n "\${PR_HEAD_SEQUENCE_FILE:-}" ] && [ -s "$PR_HEAD_SEQUENCE_FILE" ]; then
      HEAD_VALUE=$(sed -n '1p' "$PR_HEAD_SEQUENCE_FILE")
      sed '1d' "$PR_HEAD_SEQUENCE_FILE" > "$PR_HEAD_SEQUENCE_FILE.next"
      mv "$PR_HEAD_SEQUENCE_FILE.next" "$PR_HEAD_SEQUENCE_FILE"
    fi
    printf '%s\\n' '{"state":"'"\${PR_STATE:-OPEN}"'","isDraft":false,"baseRefName":"main","headRefName":"feature","headRefOid":"'"\${HEAD_VALUE}"'","number":42,"url":"https://github.com/owner/repo/pull/42"}'
    ;;
  *) exit 1 ;;
esac
`);
  chmodSync(gh, 0o755);
  const sleep = join(bin, 'sleep');
  writeFileSync(sleep, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$1" >> "${SLEEP_LOG:-/dev/null}"\n');
  chmodSync(sleep, 0o755);
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    PR_HEAD: head,
    CODEFLARE_REVIEW_SESSION_DIR: join(home, 'review-session'),
    CODEFLARE_SYNC_DAEMON_PIDFILE: join(home, 'missing.pid'),
  };
  return { home, repo, head, transcript, env };
}

function invoke(fx, input) {
  return spawnSync('bash', [SCRIPT], {
    cwd: fx.repo,
    env: fx.env,
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      cwd: fx.repo,
      transcript_path: fx.transcript,
      session_id: 'session-1',
      ...input,
    }),
    encoding: 'utf8',
  });
}

function sessionStart(fx) {
  return invoke(fx, { hook_event_name: 'SessionStart' });
}

function postTool(fx, command) {
  return invoke(fx, { tool_input: { command } });
}

function context(result) {
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

function sequenceHeads(fx, heads) {
  const sequence = join(fx.home, 'pr-heads');
  const sleepLog = join(fx.home, 'sleep.log');
  writeFileSync(sequence, `${heads.join('\n')}\n`);
  writeFileSync(sleepLog, '');
  fx.env = { ...fx.env, PR_HEAD_SEQUENCE_FILE: sequence, SLEEP_LOG: sleepLog };
  return sleepLog;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('Claude marker-or-dialog ingress', () => {
  it('asks on SessionStart with simple reason and exact neutral choices', () => {
    const fx = setup();
    const result = sessionStart(fx);
    assert.equal(result.status, 0);
    const text = context(result);
    assert.match(text, /Review completion is missing for repo:feature\./);
    assert.match(text, /Reason: no saved completion\./);
    assert.match(text, /Mark review complete\n- Launch review/);
    assert.doesNotMatch(text.split('\n').slice(0, 8).join('\n'), new RegExp(fx.head));
  });

  it('suppresses review ingress only during an open SDD transition', () => {
    const fx = setup();
    writeFileSync(join(fx.repo, 'sdd/spec/config.yml'), 'transition: true\n');
    writeFileSync(join(fx.repo, 'sdd/spec/.init-triage.md'), '**Status:** open\n');
    assert.equal(postTool(fx, 'git push origin feature').stdout, '');

    writeFileSync(join(fx.repo, 'sdd/spec/.init-triage.md'), '**Status:** resolved\n');
    assert.match(context(postTool(fx, 'git push origin feature')), /Execute this fresh contextual round now/);
  });

  it('emits handling after planned exposures and ignores inert commands', () => {
    const fx = setup();
    sessionStart(fx);
    for (const command of [
      'git switch feature',
      'git checkout feature',
      'gh pr checkout 42',
      'git pull',
      'git push origin feature',
      'gh pr create --base main',
    ]) assert.notEqual(postTool(fx, command).stdout, '', command);
    for (const command of ['git status', 'git fetch origin', 'gh pr view 42', 'gh pr merge 42']) {
      assert.equal(postTool(fx, command).stdout, '', command);
    }
  });

  it('automatically emits review and CI launch instructions after push, PR creation, and PR reopen', () => {
    for (const command of ['git push origin feature', 'gh pr create --base main', 'gh pr reopen 42']) {
      const fx = setup();
      sessionStart(fx);
      const delivery = context(postTool(fx, command));
      assert.doesNotMatch(delivery, /Use AskUserQuestion once/);
      assert.match(delivery, /Execute this fresh contextual round now/);
      assert.match(delivery, /launch public ci-monitor/);
      assert.match(delivery, /output_file|codeflare-pr-42/);
      assert.match(delivery, /verify that it is evidence-backed and in scope/);
      assert.match(delivery, /judge the finding separately from its proposed fix/);
      assert.match(delivery, /reject unsupported or overengineered proposals/);
      assert.match(delivery, /prefer the smallest correction that reuses existing machinery/);
    }
  });

  it('retries delivery until the authoritative PR head catches up', () => {
    const fx = setup();
    const previous = git(fx.repo, 'rev-parse', 'HEAD~1');
    const sleepLog = sequenceHeads(fx, [previous, previous, fx.head]);
    const result = postTool(fx, 'git push origin feature');

    assert.match(context(result), /Execute this fresh contextual round now/);
    assert.equal(readFileSync(sleepLog, 'utf8'), '1\n3\n');
  });

  it('gives up silently after bounded authoritative-head retries', () => {
    const fx = setup();
    const previous = git(fx.repo, 'rev-parse', 'HEAD~1');
    const sleepLog = sequenceHeads(fx, Array.from({ length: 6 }, () => previous));

    assert.equal(postTool(fx, 'git push origin feature').stdout, '');
    assert.equal(readFileSync(sleepLog, 'utf8'), '1\n3\n5\n10\n15\n');
  });

  it('never retries authoritative state for non-delivery exposure', () => {
    const fx = setup();
    const previous = git(fx.repo, 'rev-parse', 'HEAD~1');
    const sleepLog = sequenceHeads(fx, [previous, fx.head]);

    assert.equal(postTool(fx, 'git pull').stdout, '');
    assert.equal(readFileSync(sleepLog, 'utf8'), '');
  });

  it('does not retry an unrelated push while the current PR head is stale', () => {
    const fx = setup();
    const previous = git(fx.repo, 'rev-parse', 'HEAD~1');
    const sleepLog = sequenceHeads(fx, Array.from({ length: 6 }, () => previous));

    assert.equal(postTool(fx, 'git push origin unrelated').stdout, '');
    assert.equal(readFileSync(sleepLog, 'utf8'), '');
  });

  it('rejects delivery commands targeting another branch, PR, or repository', () => {
    for (const command of [
      'git push origin unrelated',
      'git push origin HEAD:other',
      'gh pr create --head unrelated --base main',
      'gh pr reopen 99',
      'gh --repo other/repo pr reopen 42',
    ]) {
      const fx = setup();
      sessionStart(fx);
      assert.equal(postTool(fx, command).stdout, '', command);
    }
  });

  it('resolves a successful clone destination before repository lookup', () => {
    const fx = setup();
    const parent = temp('claude-clone-parent-');
    const result = invoke(fx, {
      hook_event_name: 'PostToolUse',
      cwd: parent,
      tool_input: { command: `git clone https://github.com/owner/repo.git ${fx.repo}` },
    });
    assert.equal(result.status, 0);
    assert.match(context(result), /Review completion is missing for repo:feature/);
  });

  it('auto-acknowledges generated-only delivery and emits CI without reviewers or triage', () => {
    const fx = setup();
    execFileSync('node', [STATE, 'mark', '--cwd', fx.repo], { cwd: fx.repo, env: fx.env, stdio: 'pipe' });
    sessionStart(fx);
    mkdirSync(join(fx.repo, 'graphify-out'), { recursive: true });
    writeFileSync(join(fx.repo, 'graphify-out/graph.json'), '{}\n');
    git(fx.repo, 'add', 'graphify-out/graph.json');
    git(fx.repo, 'commit', '-m', 'refresh graph');
    fx.head = git(fx.repo, 'rev-parse', 'HEAD');
    fx.env = { ...fx.env, PR_HEAD: fx.head };

    const delivery = context(postTool(fx, 'git push origin feature'));
    assert.match(delivery, /No reviewer launch or triage is required/);
    assert.match(delivery, /launch public ci-monitor/);
    assert.doesNotMatch(delivery, /run-review-lane/);
    const status = JSON.parse(execFileSync('node', [STATE, 'status', '--cwd', fx.repo], {
      cwd: fx.repo, env: fx.env, encoding: 'utf8',
    }));
    assert.equal(status.completion.status, 'complete');
  });

  it('keeps consent and omits CI for a non-delivery exposure', () => {
    const fx = setup();
    sessionStart(fx);
    const pull = context(postTool(fx, 'git pull'));
    assert.match(pull, /Use AskUserQuestion once/);
    assert.doesNotMatch(pull, /launch public ci-monitor/);
  });

  it('stays silent after exact completion is marked', () => {
    const fx = setup();
    execFileSync('node', [STATE, 'mark', '--cwd', fx.repo], { cwd: fx.repo, env: fx.env, stdio: 'pipe' });
    assert.equal(sessionStart(fx).stdout, '');
    assert.equal(postTool(fx, 'git pull').stdout, '');
  });

  it('suppresses duplicate dialogs while a current-session round is visible', () => {
    const fx = setup();
    sessionStart(fx);
    appendFileSync(fx.transcript, `${JSON.stringify({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'lane-1', name: 'Bash', input: { command: `CODEFLARE_REVIEW_HEAD=${fx.head} bash run-review-lane.sh --lane code-reviewer --boundary-pr 42 --base main` } }] },
    })}\n`);
    assert.equal(postTool(fx, 'git pull').stdout, '');
  });

  it('does not let an older head, PR prefix, or quoted text suppress current-head delivery', () => {
    const fx = setup();
    sessionStart(fx);
    appendFileSync(fx.transcript, `${JSON.stringify({
      type: 'message',
      message: { role: 'assistant', content: [{
        type: 'tool_use', id: 'old-same-pr', name: 'Bash',
        input: { command: `CODEFLARE_REVIEW_HEAD=${fx.head} bash run-review-lane.sh --lane code-reviewer --boundary-pr 42 --base main` },
      }, {
        type: 'tool_use', id: 'prefix-lane', name: 'Bash',
        input: { command: `CODEFLARE_REVIEW_HEAD=${fx.head} bash run-review-lane.sh --lane code-reviewer --boundary-pr 420 --base main` },
      }, {
        type: 'text', text: `CODEFLARE_REVIEW_HEAD=${'f'.repeat(40)} bash run-review-lane.sh --boundary-pr 42`,
      }] },
    })}\n`);
    writeFileSync(join(fx.repo, 'next.ts'), 'export const next = true;\n');
    git(fx.repo, 'add', 'next.ts');
    git(fx.repo, 'commit', '-m', 'next head');
    fx.head = git(fx.repo, 'rev-parse', 'HEAD');
    fx.env = { ...fx.env, PR_HEAD: fx.head };

    assert.match(context(postTool(fx, 'git push origin feature')), /Execute this fresh contextual round now/);
  });

  it('fails closed for child sessions, GitHub outages, closed PRs, and detached HEAD', () => {
    const fx = setup();
    assert.equal(invoke(fx, { hook_event_name: 'SessionStart', agent_type: 'Explore' }).stdout, '');
    assert.equal(invoke({ ...fx, env: { ...fx.env, GH_FAIL: '1' } }, { hook_event_name: 'SessionStart' }).stdout, '');
    assert.equal(invoke({ ...fx, env: { ...fx.env, PR_STATE: 'CLOSED' } }, { hook_event_name: 'SessionStart' }).stdout, '');
    git(fx.repo, 'checkout', '--detach', fx.head);
    assert.equal(sessionStart(fx).stdout, '');
  });

  it('uses only transcript bytes after SessionStart offset', () => {
    const fx = setup();
    appendFileSync(fx.transcript, `${JSON.stringify({ message: { content: [{ input: { command: 'run-review-lane.sh --boundary-pr 42' } }] } })}\n`);
    sessionStart(fx);
    assert.notEqual(postTool(fx, 'git pull').stdout, '');
  });
});
