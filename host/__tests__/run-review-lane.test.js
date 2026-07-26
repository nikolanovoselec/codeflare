// Behavioral tests for the headless review-lane runner.
//
// The model is never really invoked: a fake `claude` on PATH records that it
// was called and returns a minimal CLI envelope. That recording IS the contract
// under test -- the short-circuit's whole purpose is that no model runs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(
  HERE,
  '../../preseed/agents/claude/plugins/codeflare-hooks/scripts/run-review-lane.sh',
);
const CLASSIFIER_SRC = join(
  HERE,
  '../../preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh',
);

function git(cwd, ...args) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8' });
}

// A repo with two commits; the second touches only the path the caller names,
// so lane ownership of the range is exactly what that path implies.
function makeRepo(changedPath) {
  const cwd = mkdtempSync(join(tmpdir(), 'run-lane-'));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@test');
  git(cwd, 'config', 'user.name', 'Test');
  mkdirSync(join(cwd, 'sdd'), { recursive: true });
  writeFileSync(join(cwd, 'sdd/README.md'), '# fixture\n');
  writeFileSync(join(cwd, 'seed.txt'), 'seed\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'init');
  const base = git(cwd, 'rev-parse', 'HEAD').stdout.trim();

  mkdirSync(join(cwd, dirname(changedPath)), { recursive: true });
  writeFileSync(join(cwd, changedPath), 'changed\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'change');
  const head = git(cwd, 'rev-parse', 'HEAD').stdout.trim();
  return { cwd, base, head };
}

// Seeded layout the runner resolves against: agents/<lane>.md, the two guard
// scripts it re-injects, and the classifier it consults.
function makeClaudeHome(cwd) {
  const home = join(cwd, 'claude-home');
  mkdirSync(join(home, 'agents'), { recursive: true });
  const hookScripts = join(home, 'plugins/codeflare-hooks/scripts');
  mkdirSync(join(hookScripts, 'lib'), { recursive: true });
  for (const lane of ['code-reviewer', 'spec-reviewer', 'doc-updater']) {
    writeFileSync(
      join(home, 'agents', `${lane}.md`),
      `---\nname: ${lane}\nmodel: sonnet\n---\n\nYou are the ${lane} lane.\n`,
    );
  }
  for (const guard of ['block-local-builds.sh', 'block-attributed-commits.sh']) {
    writeFileSync(join(hookScripts, guard), '#!/usr/bin/env bash\nexit 0\n');
  }
  writeFileSync(
    join(hookScripts, 'lib/lane-classifier.sh'),
    readFileSync(CLASSIFIER_SRC, 'utf-8'),
  );
  return { home, hookScripts };
}

// Fake `claude` that records that it ran AND the argv it was handed, so tests
// can assert what actually reached the CLI rather than only that it was called.
//
// It also snapshots the --settings file. That file is a mktemp the runner
// removes in its EXIT trap, so it is already gone by the time spawnSync
// returns; the only place its content is observable is from inside the process
// the runner launched. Reading it from the test would assert on cleanup timing
// rather than on what the lane was actually configured with.
function fakeClaude(cwd, witness) {
  const binDir = join(cwd, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  const p = join(binDir, 'claude');
  writeFileSync(
    p,
    `#!/usr/bin/env bash\necho invoked >> ${witness}\nprintf '%s\\n' "$@" >> ${witness}.argv\n` +
      `prev=""\nfor a in "$@"; do\n` +
      `  [ "$prev" = "--settings" ] && cat "$a" > ${witness}.settings\n` +
      `  prev="$a"\ndone\n` +
      `echo '{"is_error":false,"num_turns":1,"total_cost_usd":0,` +
      `"usage":{"input_tokens":1},"result":"## report"}'\n`,
  );
  chmodSync(p, 0o755);
  return binDir;
}

function runLane({ repo, home, hookScripts, binDir, lane, range }) {
  // Invoke through the seeded copy so `dirname $0` resolves the classifier.
  const seededRunner = join(hookScripts, 'run-review-lane.sh');
  // readFileSync, not `cat`: a missing source would make cat return empty stdout
  // without throwing, writing a zero-byte "runner" and reporting a confusing
  // symptom instead of the real cause.
  writeFileSync(seededRunner, readFileSync(RUNNER, 'utf-8'));
  return spawnSync('bash', [seededRunner, '--lane', lane, '--range', range], {
    cwd: repo,
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: home },
  });
}

// REQ-AGENT-102 AC3
describe('run-review-lane.sh — no-op short-circuit', () => {
  it('returns a no-op report without invoking a model when the lane owns nothing', () => {
    const { cwd, base, head } = makeRepo('sdd/spec/thing.md');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);

    // sdd/-only range: the code lane owns nothing in it.
    const r = runLane({
      repo: cwd, home, hookScripts, binDir,
      lane: 'code-reviewer', range: `${base}..${head}`,
    });

    assert.equal(r.status, 0);
    assert.equal(existsSync(witness), false, 'no model may be invoked for a lane that owns nothing');
    assert.match(r.stdout, /NO-OP/);
    assert.match(r.stderr, /prompt_tokens=0/);
    assert.match(r.stderr, /turns=0/);
  });

  it('invokes the model when the lane does own a changed file', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);

    const r = runLane({
      repo: cwd, home, hookScripts, binDir,
      lane: 'code-reviewer', range: `${base}..${head}`,
    });

    assert.equal(r.status, 0);
    assert.equal(existsSync(witness), true, 'a lane with owned work must still run a real review');
    assert.match(r.stdout, /## report/);
  });

  it('reviews rather than skips when the range cannot be resolved', () => {
    const { cwd } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);

    const r = runLane({
      repo: cwd, home, hookScripts, binDir,
      lane: 'code-reviewer', range: 'nonexistentref..alsomissing',
    });

    assert.equal(existsSync(witness), true,
      'an unresolvable range must fall through to a full review, never silently skip one');
  });
});

// REQ-AGENT-102 constraint: the container guards are re-injected explicitly,
// and they must be invoked through a shell because the seeded hook scripts ship
// non-executable and a bare command path silently no-ops.
describe('run-review-lane.sh — guard re-injection', () => {
  it('refuses to run at all when a required guard is missing', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    rmSync(join(hookScripts, 'block-local-builds.sh'));
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);

    const r = runLane({
      repo: cwd, home, hookScripts, binDir,
      lane: 'code-reviewer', range: `${base}..${head}`,
    });

    assert.notEqual(r.status, 0, 'a missing guard must fail closed, not run unguarded');
    assert.equal(existsSync(witness), false,
      'no lane may run with bypassPermissions and an empty hook list');
  });

  it('passes each guard as a shell invocation, not a bare path', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);

    runLane({
      repo: cwd, home, hookScripts, binDir,
      lane: 'code-reviewer', range: `${base}..${head}`,
    });

    const settings = JSON.parse(readFileSync(`${witness}.settings`, 'utf-8'));
    const commands = settings.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    assert.equal(commands.length, 2);
    for (const command of commands) {
      assert.match(command, /^bash \//,
        'a bare path silently no-ops against a non-executable hook script');
    }
  });
});

// REQ-AGENT-102: the transport must not silently re-tier a lane.
describe('run-review-lane.sh — model and effort passthrough', () => {
  it('forwards the model the lane document declares', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);

    runLane({
      repo: cwd, home, hookScripts, binDir,
      lane: 'code-reviewer', range: `${base}..${head}`,
    });

    const argv = readFileSync(`${witness}.argv`, 'utf-8').split('\n');
    assert.equal(argv[argv.indexOf('--model') + 1], 'sonnet',
      'the lane document declares model: sonnet; the transport must forward it');
    for (const flag of ['--setting-sources', '--tools', '--system-prompt']) {
      assert.ok(argv.includes(flag), `${flag} is load-bearing for the lane floor`);
    }
    assert.equal(argv[argv.indexOf('--tools') + 1], 'Bash');
  });
});

// REQ-AGENT-102 constraint: a flag given without a value must not hang.
describe('run-review-lane.sh — argument contract', () => {
  for (const flag of ['--lane', '--range', '--base']) {
    it(`rejects a trailing ${flag} instead of looping forever`, () => {
      const r = spawnSync('bash', [RUNNER, '--lane', 'code-reviewer', flag], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      assert.equal(r.status, 2);
      assert.equal(r.signal, null, 'must exit on its own, not be killed by the timeout');
    });
  }

  it('rejects an unknown lane', () => {
    const r = spawnSync('bash', [RUNNER, '--lane', 'not-a-lane'], {
      encoding: 'utf-8',
      timeout: 10000,
    });
    assert.equal(r.status, 2);
  });
});
