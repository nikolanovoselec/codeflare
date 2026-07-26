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

// Stand in for lane-triage.mjs. The runner's contract with it is exactly one
// thing -- a JSON document on stdout -- so a stub that emits a chosen document
// exercises the runner's reading of it without reimplementing triage.
function stubTriage(hookScripts, doc) {
  writeFileSync(
    join(hookScripts, 'lib/lane-triage.mjs'),
    `process.stdout.write(${JSON.stringify(JSON.stringify(doc, null, 2))});\n`,
  );
}

// REQ-AGENT-103 AC3
describe('run-review-lane.sh — triage no-op short-circuit', () => {
  it('returns without invoking a model when triage decides the lane is a no-op', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    stubTriage(hookScripts, { decision: 'exit-no-op', reason: 'an SDD transition is active' });

    const r = runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });

    assert.equal(existsSync(witness), false,
      'the lane owns the changed file, so only triage can have stopped it -- and it must stop it before the model');
    assert.match(r.stdout, /NO-OP/);
    assert.match(r.stdout, /an SDD transition is active/);
  });

  // The decision is a field, not a substring of the document. A reason that
  // quotes the serialised no-op fragment is the case that separates reading the
  // field from grepping the blob: here the lane must still be reviewed.
  it('reviews when only a reason string contains the serialised no-op decision', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    stubTriage(hookScripts, {
      decision: 'proceed',
      reason: 'a prior round emitted "decision": "exit-no-op" and that must not carry over',
    });

    runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });

    assert.equal(existsSync(witness), true,
      'only decision === exit-no-op may skip the model; matching the document body drops a required review');
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

    const r = runLane({
      repo: cwd, home, hookScripts, binDir,
      lane: 'code-reviewer', range: `${base}..${head}`,
    });

    // Assert the launch first: without this, a runner that never started
    // surfaces as an ENOENT on the snapshot below rather than as the
    // regression it actually is.
    assert.equal(r.status, 0, r.stderr);
    const settings = JSON.parse(readFileSync(`${witness}.settings`, 'utf-8'));
    const commands = settings.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    assert.equal(commands.length, 2);
    for (const command of commands) {
      assert.match(command, /^bash \//,
        'a bare path silently no-ops against a non-executable hook script');
    }
  });
});

// REQ-AGENT-102 constraint: the guard settings must survive a config path that
// contains a space. An unquoted expansion produces valid JSON pointing at
// non-existent paths, so the lane runs unguarded and every check reads as
// "not blocked" -- a silent failure, not a loud one.
describe('run-review-lane.sh — guard settings under a hostile config path', () => {
  it('injects both guards intact when CLAUDE_CONFIG_DIR contains a space', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const spaced = join(cwd, 'my claude home');
    mkdirSync(spaced, { recursive: true });
    const home = join(spaced, 'claude-home');
    mkdirSync(join(home, 'agents'), { recursive: true });
    const hookScripts = join(home, 'plugins/codeflare-hooks/scripts');
    mkdirSync(join(hookScripts, 'lib'), { recursive: true });
    writeFileSync(
      join(home, 'agents/code-reviewer.md'),
      '---\nname: code-reviewer\nmodel: sonnet\n---\n\nYou are the code-reviewer lane.\n',
    );
    for (const guard of ['block-local-builds.sh', 'block-attributed-commits.sh']) {
      writeFileSync(join(hookScripts, guard), '#!/usr/bin/env bash\nexit 0\n');
    }
    writeFileSync(join(hookScripts, 'lib/lane-classifier.sh'), readFileSync(CLASSIFIER_SRC, 'utf-8'));
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);

    const result = runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });

    // A runner that never started surfaces as an ENOENT on the settings snapshot
    // below rather than as the regression it actually is.
    assert.equal(result.status, 0, result.stderr);
    const settings = JSON.parse(readFileSync(`${witness}.settings`, 'utf-8'));
    const commands = settings.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    assert.equal(commands.length, 2, 'a split path would yield a different number of hooks');
    for (const command of commands) {
      const path = command.replace(/^bash /, '');
      assert.equal(existsSync(path), true,
        `guard path must resolve to a real file, got ${path}`);
    }
  });
});

// REQ-AGENT-102 constraint: the lane subprocess is time-bounded. `timeout 0`
// disables the bound entirely, so a zero or malformed value must fall back to
// the default rather than silently removing it.
describe('run-review-lane.sh — timeout bound', () => {
  // Shim `timeout` so the bound it was actually handed is observable; the real
  // one would just run the fake CLI and tell us nothing about its arguments.
  function fakeTimeout(binDir, witness) {
    const p = join(binDir, 'timeout');
    writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${witness}.timeout\nshift 3\nexec "$@"\n`);
    chmodSync(p, 0o755);
  }

  for (const [label, value, expected] of [
    ['zero', '0', '1800'],
    ['non-numeric', 'abc', '1800'],
    ['empty', '', '1800'],
    ['a real override', '600', '600'],
  ]) {
    it(`resolves ${label} REVIEW_LANE_TIMEOUT to ${expected}s`, () => {
      const { cwd, base, head } = makeRepo('src/thing.ts');
      const { home, hookScripts } = makeClaudeHome(cwd);
      const witness = join(cwd, 'claude-was-called');
      const binDir = fakeClaude(cwd, witness);
      fakeTimeout(binDir, witness);

      const seededRunner = join(hookScripts, 'run-review-lane.sh');
      writeFileSync(seededRunner, readFileSync(RUNNER, 'utf-8'));
      spawnSync('bash', [seededRunner, '--lane', 'code-reviewer', '--range', `${base}..${head}`], {
        cwd, encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          CLAUDE_CONFIG_DIR: home,
          REVIEW_LANE_TIMEOUT: value,
        },
      });

      const argv = readFileSync(`${witness}.timeout`, 'utf-8').split('\n');
      assert.equal(argv[0], '-k', 'plain SIGTERM leaves a wedged lane running');
      assert.equal(argv[2], expected);
    });
  }
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
    // Assert the VALUES, not merely that the flags appear. Presence alone is
    // satisfied by `--setting-sources user`, which restores exactly the
    // inherited hook configuration the guard re-injection exists to replace --
    // the lane would run with someone else's settings and the test would pass.
    assert.equal(argv[argv.indexOf('--setting-sources') + 1], '',
      'the empty string is the security property: any other value re-inherits settings');
    assert.equal(argv[argv.indexOf('--tools') + 1], 'Bash');
    assert.match(argv[argv.indexOf('--system-prompt') + 1], /You are the code-reviewer lane\./,
      'the system prompt must be the lane document body, not a default');
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
