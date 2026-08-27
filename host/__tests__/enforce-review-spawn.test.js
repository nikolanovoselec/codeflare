import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../..');
const STOP = join(ROOT, 'preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh');
const REMINDER = join(ROOT, 'preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh');
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
  const home = temp('claude-stop-home-');
  const repo = temp('claude-stop-repo-');
  const bin = temp('claude-stop-bin-');
  git(repo, 'init', '-q');
  git(repo, 'branch', '-M', 'feature');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'test@example.test');
  mkdirSync(join(repo, 'sdd/spec'), { recursive: true });
  writeFileSync(join(repo, 'sdd/README.md'), '# SDD\n');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
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
  "pr view") printf '%s\\n' '{"state":"OPEN","isDraft":false,"baseRefName":"main","headRefName":"feature","headRefOid":"'"\${PR_HEAD}"'","number":42,"url":"https://github.com/owner/repo/pull/42"}' ;;
  *) exit 1 ;;
esac
`);
  chmodSync(gh, 0o755);
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

function invoke(script, fx, input) {
  return spawnSync('bash', [script], {
    cwd: fx.repo,
    env: fx.env,
    input: JSON.stringify({
      cwd: fx.repo,
      transcript_path: fx.transcript,
      session_id: 'session-1',
      ...input,
    }),
    encoding: 'utf8',
  });
}

function start(fx) {
  return invoke(REMINDER, fx, { hook_event_name: 'SessionStart' });
}

function stop(fx, extra = {}) {
  return invoke(STOP, fx, { hook_event_name: 'Stop', ...extra });
}

function append(fx, ...entries) {
  appendFileSync(fx.transcript, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}

function call(id, name, input) {
  return { type: 'message', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } };
}

function notification(id, status, result = '') {
  return {
    type: 'message',
    message: {
      role: 'user',
      content: `<task-notification><tool-use-id>${id}</tool-use-id><status>${status}</status>${result}</task-notification>`,
    },
  };
}

function triage(extra = '') {
  return {
    type: 'message',
    message: {
      role: 'assistant',
      content: [{
        type: 'text',
        text: `| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |\n|---|---|---|---|---|${extra}`,
      }],
    },
  };
}

function round(fx, options = {}) {
  const lanes = ['code-reviewer', 'spec-reviewer', 'doc-updater'];
  const entries = [];
  for (const lane of lanes) {
    const id = `lane-${lane}`;
    entries.push(
      call(id, 'Bash', { command: `CODEFLARE_REVIEW_CI=push bash run-review-lane.sh --lane ${lane} --boundary-pr 42 --base main` }),
      notification(id, options.failedLane === lane ? 'Failed' : 'Completed'),
    );
  }
  const ci = 'ci-1';
  const ciResult = options.ciResult ?? 'success';
  entries.push(
    call(ci, 'Agent', {
      subagent_type: 'ci-monitor',
      run_in_background: true,
      prompt: JSON.stringify({ repo: 'owner/repo', pr: 42, head: fx.head, cwd: fx.repo }),
    }),
    notification(ci, 'Completed', `<result>CI_RESULT ${ciResult}\npr=42 head=${fx.head} repo=owner/repo</result>`),
  );
  if (options.withTriage !== false) {
    entries.push(triage(ciResult === 'failure' || ciResult === 'timeout'
      ? `\n| Exact-head CI | valid | CI_RESULT ${ciResult} | proportional | fix |`
      : ''));
  }
  append(fx, ...entries);
}

function markerStatus(fx) {
  const output = execFileSync('node', [STATE, 'status', '--cwd', fx.repo], { cwd: fx.repo, env: fx.env, encoding: 'utf8' });
  return JSON.parse(output).completion.status;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('Claude current-round completion enforcement', () => {
  it('writes marker immediately before separate FIX reminder after terminal triage', () => {
    const fx = setup();
    start(fx);
    round(fx);
    const result = stop(fx);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Review complete for repo:feature\. FIX:/);
    assert.equal(markerStatus(fx), 'complete');
  });

  it('stays silent and unacknowledged without triage', () => {
    const fx = setup();
    start(fx);
    round(fx, { withTriage: false });
    const result = stop(fx);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.notEqual(markerStatus(fx), 'complete');
  });

  it('requires exact CI failure and timeout rows', () => {
    for (const ciResult of ['failure', 'timeout']) {
      const fx = setup();
      start(fx);
      round(fx, { ciResult, withTriage: false });
      append(fx, triage());
      assert.equal(stop(fx).status, 0);
      append(fx, triage(`\n| Exact-head CI | valid | CI_RESULT ${ciResult} | proportional | fix |`));
      assert.equal(stop(fx).status, 2);
    }
  });

  it('clears stopped or failed work without missing-work output', () => {
    const fx = setup();
    start(fx);
    round(fx, { failedLane: 'spec-reviewer' });
    const before = Number(readFileSync(join(fx.env.CODEFLARE_REVIEW_SESSION_DIR, `${checksum('session-1')}.offset`), 'utf8'));
    const result = stop(fx);
    const after = Number(readFileSync(join(fx.env.CODEFLARE_REVIEW_SESSION_DIR, `${checksum('session-1')}.offset`), 'utf8'));
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.ok(after > before);
    assert.notEqual(markerStatus(fx), 'complete');
  });

  it('ignores PreToolUse, child sessions, old transcript rounds, and unlaunched rounds', () => {
    const fx = setup();
    round(fx);
    start(fx);
    assert.equal(stop(fx).status, 0);
    assert.equal(invoke(STOP, fx, { hook_event_name: 'PreToolUse' }).status, 0);
    assert.equal(stop(fx, { agent_type: 'Explore' }).status, 0);
    const fresh = setup();
    start(fresh);
    assert.equal(stop(fresh).status, 0);
  });

  it('does not emit FIX when exact head drifts before marker write', () => {
    const fx = setup();
    start(fx);
    round(fx);
    fx.env = { ...fx.env, PR_HEAD: 'f'.repeat(40) };
    const result = stop(fx);
    assert.equal(result.status, 0);
    assert.notEqual(markerStatus({ ...fx, env: { ...fx.env, PR_HEAD: fx.head } }), 'complete');
  });
});

function checksum(value) {
  return execFileSync('cksum', { input: value, encoding: 'utf8' }).trim().split(' ')[0];
}
