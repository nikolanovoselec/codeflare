import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const PI_SKILL = new URL('../../preseed/agents/pi/skills/ci-monitoring/SKILL.md', import.meta.url);
const CLAUDE_SKILL = new URL('../../preseed/agents/claude/skills/ci-monitoring/SKILL.md', import.meta.url);
const HEAD = 'ef819ed35e9cc57d66209d1330bc8a87519736df';

function monitorScript(skill = PI_SKILL) {
  const text = readFileSync(skill, 'utf8');
  const match = text.match(/cat > "\$SCRIPT" <<'BASH'\n([\s\S]*?)\nBASH/);
  assert.ok(match, 'ci-monitoring skill must contain a bash monitor body');
  return speedUp(match[1]);
}

function launcherScript(repo, skill = PI_SKILL) {
  const text = readFileSync(skill, 'utf8');
  const match = text.match(/```bash\n([\s\S]*?)\n```/);
  assert.ok(match, 'ci-monitoring skill must contain a launcher snippet');
  return speedUp(match[1])
    .replace('cd <repo>', `cd '${repo}'`)
    .replace('BRANCH=<branch>', 'BRANCH=multiview');
}

function speedUp(script) {
  return script
    .replace('no_rows_deadline=$((SECONDS + 300))', 'no_rows_deadline=$((SECONDS + 1))')
    .replace('deadline=$((SECONDS + 1800))', 'deadline=$((SECONDS + 2))')
    .replaceAll('sleep 15', 'sleep 0.02');
}

function row(id, patch = {}) {
  return {
    databaseId: id,
    workflowName: `workflow-${id}`,
    event: 'pull_request',
    headSha: HEAD,
    status: 'completed',
    conclusion: 'success',
    url: `https://example.test/runs/${id}`,
    ...patch,
  };
}

function fakeFailingGh(binDir) {
  const path = join(binDir, 'gh');
  writeFileSync(path, `#!/usr/bin/env bash
set -eu
printf 'gh auth failed\n' >&2
exit 4
`);
  chmodSync(path, 0o755);
}

function fakeGh(binDir) {
  const path = join(binDir, 'gh');
  writeFileSync(path, `#!/usr/bin/env bash
set -eu
count=0
[ -f "$GH_CALLS" ] && count=$(cat "$GH_CALLS")
count=$((count + 1))
printf '%s' "$count" > "$GH_CALLS"
file="$GH_FIXTURES/$count.json"
[ -f "$file" ] || file="$GH_FIXTURES/default.json"
cat "$file"
`);
  chmodSync(path, 0o755);
}

function fakeGit(binDir) {
  const path = join(binDir, 'git');
  writeFileSync(path, `#!/usr/bin/env bash
set -eu
if [ "$1 \${2:-}" = "rev-parse HEAD" ]; then
  printf '%s\n' "$GIT_HEAD"
  exit 0
fi
if [ "$1" = "rev-parse" ] && [[ "\${2:-}" == refs/heads/* ]]; then
  count=0
  if [ -n "\${GIT_REF_CALLS:-}" ] && [ -f "$GIT_REF_CALLS" ]; then count=$(cat "$GIT_REF_CALLS"); fi
  count=$((count + 1))
  if [ -n "\${GIT_REF_CALLS:-}" ]; then printf '%s' "$count" > "$GIT_REF_CALLS"; fi
  file="\${GIT_REF_FIXTURES:-}/$count.txt"
  if [ -n "\${GIT_REF_FIXTURES:-}" ] && [ -f "$file" ]; then
    cat "$file"
  else
    printf '%s\n' "\${GIT_BRANCH_HEAD:-$GIT_HEAD}"
  fi
  exit 0
fi
exit 2
`);
  chmodSync(path, 0o755);
}

function runMonitorFor(skill, sequence, fallback = sequence.at(-1) ?? [], branchHeads = []) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-monitor-'));
  const bin = join(dir, 'bin');
  const fixtures = join(dir, 'fixtures');
  const refs = join(dir, 'refs');
  const repo = join(dir, 'repo');
  const calls = join(dir, 'calls');
  const refCalls = join(dir, 'ref-calls');
  const script = join(dir, 'monitor.sh');
  const log = join(dir, 'monitor.log');

  mkdirSync(bin);
  mkdirSync(fixtures);
  mkdirSync(refs);
  mkdirSync(repo);
  fakeGh(bin);
  fakeGit(bin);
  sequence.forEach((rows, index) => writeFileSync(join(fixtures, `${index + 1}.json`), JSON.stringify(rows)));
  branchHeads.forEach((head, index) => writeFileSync(join(refs, `${index + 1}.txt`), `${head}\n`));
  writeFileSync(join(fixtures, 'default.json'), JSON.stringify(fallback));
  writeFileSync(script, monitorScript(skill));
  chmodSync(script, 0o755);

  try {
    const result = spawnSync('bash', [script, repo, 'multiview', HEAD, log], {
      encoding: 'utf8',
      timeout: 6000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GH_CALLS: calls,
        GH_FIXTURES: fixtures,
        GIT_HEAD: HEAD,
        GIT_BRANCH_HEAD: HEAD,
        GIT_REF_CALLS: refCalls,
        GIT_REF_FIXTURES: refs,
      },
    });
    return {
      status: result.status,
      stderr: result.stderr,
      log: existsSync(log) ? readFileSync(log, 'utf8') : '',
      calls: existsSync(calls) ? Number(readFileSync(calls, 'utf8')) : 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runMonitor(sequence, fallback = sequence.at(-1) ?? [], branchHeads = []) {
  return runMonitorFor(PI_SKILL, sequence, fallback, branchHeads);
}

test('REQ-AGENT-068 AC1/AC5: ci monitor launcher starts detached work and returns immediately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-monitor-launch-'));
  const bin = join(dir, 'bin');
  const fixtures = join(dir, 'fixtures');
  const repo = join(dir, 'repo');
  const calls = join(dir, 'calls');

  mkdirSync(bin);
  mkdirSync(fixtures);
  mkdirSync(repo);
  fakeGh(bin);
  fakeGit(bin);
  writeFileSync(join(fixtures, 'default.json'), JSON.stringify([row(1, { status: 'in_progress', conclusion: null })]));

  const started = Date.now();
  const result = spawnSync('bash', ['-c', launcherScript(repo)], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 2000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, GH_CALLS: calls, GH_FIXTURES: fixtures, GIT_HEAD: HEAD },
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Date.now() - started < 500, 'launcher should not wait for CI completion');
    assert.match(result.stdout, /CI_MONITOR_STARTED head=ef819ed35e9cc57d66209d1330bc8a87519736df pid=\d+ log=\/tmp\/ci-monitor-/);
  } finally {
    const pid = Number(result.stdout.match(/pid=(\d+)/)?.[1]);
    if (Number.isFinite(pid)) {
      try { process.kill(-pid, 'SIGTERM'); } catch {}
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    rmSync(`/tmp/ci-monitor-${HEAD}.log`, { force: true });
    rmSync(`/tmp/ci-monitor-${HEAD}.log.json`, { force: true });
    rmSync(`/tmp/ci-monitor-${HEAD}.log.state`, { force: true });
    rmSync(`/tmp/ci-monitor-${HEAD}.sh`, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REQ-AGENT-068 AC2: ci monitor waits for a stable workflow/run set before success', () => {
  const result = runMonitor([
    [row(1)],
    [row(1), row(2)],
    [row(2), row(1)],
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls, 3);
  assert.match(result.log, /CI_RESULT success/);
});

test('REQ-AGENT-068 AC3: ci monitor stops as superseded when the branch advances before polling', () => {
  const nextHead = '0123456789abcdef0123456789abcdef01234567';
  const result = runMonitor([[row(1)], [row(1)]], [row(1)], [nextHead]);

  assert.equal(result.status, 124, result.stderr);
  assert.equal(result.calls, 0);
  assert.match(result.log, new RegExp(`CI_RESULT timeout superseded head=${HEAD} current_head=${nextHead} branch=multiview`));
  assert.doesNotMatch(result.log, /CI_RESULT success/);
});

test('REQ-AGENT-068 AC3: ci monitor re-checks superseded status before terminal success', () => {
  const nextHead = '0123456789abcdef0123456789abcdef01234567';
  const result = runMonitor([[row(1)], [row(1)]], [row(1)], [HEAD, HEAD, nextHead]);

  assert.equal(result.status, 124, result.stderr);
  assert.equal(result.calls, 2);
  assert.match(result.log, new RegExp(`CI_RESULT timeout superseded head=${HEAD} current_head=${nextHead} branch=multiview`));
  assert.doesNotMatch(result.log, /CI_RESULT success/);
});

test('REQ-AGENT-068 AC3: ci monitor re-checks superseded status before terminal failure', () => {
  const nextHead = '0123456789abcdef0123456789abcdef01234567';
  const result = runMonitor([[row(1, { conclusion: 'failure' })]], undefined, [HEAD, nextHead]);

  assert.equal(result.status, 124, result.stderr);
  assert.equal(result.calls, 1);
  assert.match(result.log, new RegExp(`CI_RESULT timeout superseded head=${HEAD} current_head=${nextHead} branch=multiview`));
  assert.doesNotMatch(result.log, /CI_RESULT failure/);
});

test('REQ-AGENT-068 AC4: ci monitor reports failed workflow rows', () => {
  const result = runMonitor([[row(1, { conclusion: 'failure' })]]);

  assert.equal(result.status, 10, result.stderr);
  assert.equal(result.calls, 1);
  assert.match(result.log, /CI_RESULT failure/);
});

test('REQ-AGENT-068 AC2: ci monitor times out when workflows never finish', () => {
  const running = [row(1, { status: 'in_progress', conclusion: null })];
  const result = runMonitor([running], running);

  assert.equal(result.status, 124, result.stderr);
  assert.ok(result.calls > 0);
  assert.match(result.log, /CI_RESULT timeout/);
});

test('REQ-AGENT-068 AC7: ci monitor reports gh access failures instead of waiting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-monitor-gh-fail-'));
  const bin = join(dir, 'bin');
  const repo = join(dir, 'repo');
  const script = join(dir, 'monitor.sh');
  const log = join(dir, 'monitor.log');

  mkdirSync(bin);
  mkdirSync(repo);
  fakeFailingGh(bin);
  writeFileSync(script, monitorScript());
  chmodSync(script, 0o755);

  try {
    const result = spawnSync('bash', [script, repo, 'multiview', HEAD, log], {
      encoding: 'utf8',
      timeout: 2000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });

    assert.equal(result.status, 124, result.stderr);
    assert.match(readFileSync(log, 'utf8'), /CI_RESULT timeout gh_unavailable_or_auth_failed head=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REQ-AGENT-070 AC3: Claude ci monitor launcher starts detached work and returns a durable log path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-ci-monitor-launch-'));
  const bin = join(dir, 'bin');
  const fixtures = join(dir, 'fixtures');
  const repo = join(dir, 'repo');
  const calls = join(dir, 'calls');

  mkdirSync(bin);
  mkdirSync(fixtures);
  mkdirSync(repo);
  fakeGh(bin);
  fakeGit(bin);
  writeFileSync(join(fixtures, 'default.json'), JSON.stringify([row(1, { status: 'in_progress', conclusion: null })]));

  const started = Date.now();
  const result = spawnSync('bash', ['-c', launcherScript(repo, CLAUDE_SKILL)], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 2000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, GH_CALLS: calls, GH_FIXTURES: fixtures, GIT_HEAD: HEAD },
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Date.now() - started < 500, 'launcher should not wait for CI completion');
    assert.match(result.stdout, /CI_MONITOR_STARTED head=ef819ed35e9cc57d66209d1330bc8a87519736df pid=\d+ log=\/tmp\/ci-monitor-/);
  } finally {
    const pid = Number(result.stdout.match(/pid=(\d+)/)?.[1]);
    if (Number.isFinite(pid)) {
      try { process.kill(-pid, 'SIGTERM'); } catch {}
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    rmSync(`/tmp/ci-monitor-${HEAD}.log`, { force: true });
    rmSync(`/tmp/ci-monitor-${HEAD}.log.json`, { force: true });
    rmSync(`/tmp/ci-monitor-${HEAD}.log.state`, { force: true });
    rmSync(`/tmp/ci-monitor-${HEAD}.sh`, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REQ-AGENT-070 AC4: Claude ci monitor waits for a stable workflow/run set before success', () => {
  const result = runMonitorFor(CLAUDE_SKILL, [[row(1)], [row(1)]]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls, 2);
  assert.match(result.log, /CI_RESULT success/);
});

test('REQ-AGENT-070 AC5: Claude ci monitor reports failed workflow rows', () => {
  const result = runMonitorFor(CLAUDE_SKILL, [[row(1, { conclusion: 'failure' })]]);

  assert.equal(result.status, 10, result.stderr);
  assert.equal(result.calls, 1);
  assert.match(result.log, /CI_RESULT failure/);
});

test('REQ-AGENT-070 AC5: Claude ci monitor reports gh access failures in the durable log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-ci-monitor-gh-fail-'));
  const bin = join(dir, 'bin');
  const repo = join(dir, 'repo');
  const script = join(dir, 'monitor.sh');
  const log = join(dir, 'monitor.log');

  mkdirSync(bin);
  mkdirSync(repo);
  fakeFailingGh(bin);
  writeFileSync(script, monitorScript(CLAUDE_SKILL));
  chmodSync(script, 0o755);

  try {
    const result = spawnSync('bash', [script, repo, 'multiview', HEAD, log], {
      encoding: 'utf8',
      timeout: 2000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });

    assert.equal(result.status, 124, result.stderr);
    assert.match(readFileSync(log, 'utf8'), /CI_RESULT timeout gh_unavailable_or_auth_failed head=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
