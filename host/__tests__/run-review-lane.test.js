// Behavioral tests for the headless review-lane runner.
//
// The model is never really invoked: a fake `claude` on PATH records that it
// was called and returns a minimal CLI envelope. That recording IS the contract
// under test -- the short-circuit's whole purpose is that no model runs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
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
      `cat > ${witness}.prompt\n` +
      `prev=""\nfor a in "$@"; do\n` +
      `  [ "$prev" = "--settings" ] && cat "$a" > ${witness}.settings\n` +
      // The argv witness is newline-delimited, so a multi-line value cannot be
      // indexed out of it -- the line after `--system-prompt` is the body's
      // leading blank, not the body. Snapshot it whole, like `--settings`.
      `  [ "$prev" = "--system-prompt" ] && printf '%s' "$a" > ${witness}.sysprompt\n` +
      `  prev="$a"\ndone\n` +
      `echo '{"is_error":false,"num_turns":1,"total_cost_usd":0,` +
      `"usage":{"input_tokens":1},"result":"## report"}'\n`,
  );
  chmodSync(p, 0o755);
  return binDir;
}

function runLane({ repo, home, hookScripts, binDir, lane, range, scopeArgs, env = {} }) {
  // Invoke through the seeded copy so `dirname $0` resolves the classifier.
  const seededRunner = join(hookScripts, 'run-review-lane.sh');
  // readFileSync, not `cat`: a missing source would make cat return empty stdout
  // without throwing, writing a zero-byte "runner" and reporting a confusing
  // symptom instead of the real cause.
  writeFileSync(seededRunner, readFileSync(RUNNER, 'utf-8'));
  return spawnSync('bash', [
    seededRunner,
    '--lane', lane,
    ...(scopeArgs ?? ['--range', range]),
  ], {
    cwd: repo,
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: home, ...env },
  });
}

// REQ-AGENT-102 AC2
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

  it('keeps caller-supplied PR-boundary range authoritative', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);

    const r = runLane({
      repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer',
      scopeArgs: ['--boundary-pr', '24', '--range', `${base}..${head}`],
    });

    assert.equal(r.status, 0);
    assert.match(readFileSync(`${witness}.prompt`, 'utf-8'), new RegExp(`incremental diff .*${base}\\.\\.${head}`));
  });

  it('never reads clone-local legacy acknowledgement state', () => {
    const { cwd, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    const commonDir = git(cwd, 'rev-parse', '--git-common-dir').stdout.trim();
    writeFileSync(join(cwd, commonDir, 'sdd-review-ack-pr-24'), `${head}\n`);

    const r = runLane({
      repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer',
      scopeArgs: ['--boundary-pr', '24', '--base', 'develop'],
    });

    assert.equal(r.status, 0);
    assert.equal(existsSync(witness), true,
      'legacy clone-local state must not suppress caller-authorized review');
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
  const triage = {
    lane: 'code-reviewer',
    range: null,
    sdd: { bootstrapped: true, layout: 'nested' },
    bulkOpAudit: { checked: 0, findings: [] },
    ...doc,
  };
  writeFileSync(
    join(hookScripts, 'lib/lane-triage.mjs'),
    `process.stdout.write(${JSON.stringify(JSON.stringify(triage, null, 2))});\n`,
  );
}

// The resolver is a review-scope asset, not a hook lib: the runner reads it
// from $CLAUDE_HOME. Stubbing the old path left `[ -f ]` false in every test,
// which is the shape where an assertion keeps passing while testing nothing.
function stubEvidence(home, doc) {
  const dir = join(home, 'skills/review-scope/scripts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'lane-evidence.mjs'),
    `process.stdout.write(${JSON.stringify(JSON.stringify(doc, null, 2))});\n`,
  );
}

// REQ-AGENT-105. The lookups the lane checklists order are what the turn count
// is made of -- a doc lane owning one table cell still spent 13 turns resolving
// an index, a layout, every reference and every anchor. Handing the answers over
// is only worth anything if they actually reach the prompt.
describe('run-review-lane.sh — resolved lookups reach the lane', () => {
  it('inlines the evidence block', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    stubEvidence(home, { lane: 'code-reviewer', adrs: [{ id: 'AD117', status: 'Accepted' }], marker: 'EVIDENCE_MARKER' });

    runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });

    const argv = readFileSync(`${witness}.prompt`, 'utf-8');
    assert.match(argv, /EVIDENCE_MARKER/,
      'a resolved lookup that never reaches the prompt is a lookup the lane still pays a turn for');
    assert.match(argv, /<evidence>/, 'the block must be delimited so the lane can tell it from the diff');
  });

  // A lane that is not told where it is opens with `git rev-parse
  // --show-toplevel`, and that orientation call costs a whole turn before it has
  // looked at anything.
  it('states the repository root so the lane does not spend a turn finding it', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);

    runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });

    const delivered = readFileSync(`${witness}.prompt`, 'utf-8');
    const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf-8' }).stdout.trim();
    assert.ok(delivered.includes(root), 'the lane must be handed its repository root, not made to discover it');
  });

  // Same degrade-by-field rule as its two siblings: the verbatim indexes are the
  // bulk, the resolutions are what remove turns, so the resolutions survive --
  // and whatever does go is named, so the lane can tell a shed from an absence.
  it('sheds the verbatim indexes rather than the whole evidence block', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    stubEvidence(home, {
      lane: 'code-reviewer',
      docIndex: 'z'.repeat(80000),
      // Compact resolutions must survive when the verbatim index is what
      // exceeded the cap; otherwise the lane pays to derive them again.
      pending: 'a pending manifest',
      config: 'mode: interactive\nenforce_tdd: true\n',
      references: { checked: 12, unresolved: [{ ref: 'src/gone.ts', resolved: false }] },
    });

    // The owning lane: a doc lane over a source-only range short-circuits before
    // the model, so no prompt is ever built and the shed cannot be observed.
    const r = runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });

    const argv = readFileSync(`${witness}.prompt`, 'utf-8');
    assert.doesNotMatch(argv, /zzzzzzzzzz/, 'the field that blew the cap must not reach the prompt');
    assert.match(argv, /src\/gone\.ts/,
      'the resolutions are the part that removes turns and must survive the shed');
    for (const field of ['pending', 'config']) {
      assert.match(argv, new RegExp(`"${field}"`), `${field} is a compact resolution and must survive`);
      assert.doesNotMatch(argv, new RegExp(`"omitted":\\[[^\\]]*"${field}"`));
    }
    assert.doesNotMatch(argv, /"omitted":\[[^\]]*"specIndex"/,
      'a field the block never carried must not be reported as shed');
    assert.match(r.stderr, /shed fields named in \.omitted/);
  });

  // Linux caps ONE argument at MAX_ARG_STRLEN (128 KB) however large ARG_MAX is.
  // The inlined blocks are meant to be big -- the packet cap alone is 128 KB --
  // so passing the prompt as an argument killed the lane with "Argument list too
  // long" before it reached the model. This drives a prompt past that ceiling.
  it('delivers a prompt larger than a single argument can hold', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    stubTriage(hookScripts, { decision: 'proceed', marker: 'BIG_PROMPT_MARKER' });
    stubEvidence(home, { lane: 'code-reviewer', filler: 'q'.repeat(200000) });

    // The default cap would shed this block long before it reached the ceiling
    // under test. The contract here is the stdin transport, not the cap, so the
    // documented override lifts the cap out of the way.
    const r = runLane({
      repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}`,
      env: { REVIEW_LANE_EVIDENCE_MAX_BYTES: '400000' },
    });

    assert.equal(existsSync(witness), true,
      'the lane must reach the model however large its evidence is');
    assert.doesNotMatch(r.stderr, /Argument list too long/);
    const delivered = readFileSync(`${witness}.prompt`, 'utf-8');
    assert.ok(delivered.length > 200000,
      `the prompt must actually cross the 128 KB single-argument ceiling, got ${delivered.length}`);
    assert.match(delivered, /BIG_PROMPT_MARKER/,
      'and arrive intact, not truncated to fit');
  });

  // The resolver is time-bounded, so it can be reaped mid-write, and the capture
  // keeps whatever bytes arrived. Only the over-cap branch reached jq, so a
  // truncated sub-cap document was inlined as an authoritative block the lane is
  // explicitly told not to re-derive.
  it('refuses to inline evidence that is not valid JSON', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    mkdirSync(join(home, 'skills/review-scope/scripts'), { recursive: true });
    writeFileSync(join(home, 'skills/review-scope/scripts/lane-evidence.mjs'),
      'process.stdout.write("{\\"lane\\":\\"truncated-half-w");\n');

    const r = runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });
    const delivered = readFileSync(`${witness}.prompt`, 'utf-8');

    assert.doesNotMatch(delivered, /truncated-half-w/,
      'a partial document must not be presented as resolved lookups');
    assert.equal(delivered.split('\n').includes('<evidence>'), false,
      'and no block may be opened at all, or the lane treats absence as an answer');
    assert.match(r.stderr, /not valid JSON/);
  });

  it('reviews normally when evidence cannot be resolved', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    mkdirSync(join(home, 'skills/review-scope/scripts'), { recursive: true });
    writeFileSync(join(home, 'skills/review-scope/scripts/lane-evidence.mjs'), 'process.exit(1);\n');

    runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });

    assert.equal(existsSync(witness), true,
      'an evidence failure degrades to the lane gathering it itself, never to a skipped review');
    assert.doesNotMatch(readFileSync(`${witness}.prompt`, 'utf-8'), /<evidence>\s*\{/,
      'an empty block must not be inlined as though it were resolved; the wave text names the tag itself, so only a tag followed by JSON proves inlining');
  });
});

// REQ-AGENT-103 AC3
describe('run-review-lane.sh — triage no-op short-circuit', () => {
  it('returns without invoking a model when triage decides the lane is a no-op', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    stubTriage(hookScripts, {
      decision: 'exit-no-op',
      reason: 'an SDD transition is active',
      transition: { active: true, corrupt: false },
    });

    const r = runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });

    assert.equal(existsSync(witness), false,
      'the lane owns the changed file, so only triage can have stopped it -- and it must stop it before the model');
    assert.match(r.stdout, /NO-OP/);
    assert.match(r.stdout, /an SDD transition is active/);
  });

  it('reviews when exit-no-op has only a placeholder reason and no supported evidence', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    stubTriage(hookScripts, { decision: 'exit-no-op', reason: 'placeholder' });

    const r = runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });

    assert.equal(existsSync(witness), true,
      'an asserted no-op without positive bootstrap, transition, or round-limit evidence must fail open to review');
    assert.match(r.stderr, /required shape/);
  });

  it('discards malformed triage instead of presenting it as authoritative', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    writeFileSync(join(hookScripts, 'lib/lane-triage.mjs'),
      'process.stdout.write("{\\\"decision\\\":\\\"exit-no-op\\\"");\n');

    const r = runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });

    assert.equal(existsSync(witness), true, 'invalid triage must never suppress the review');
    assert.doesNotMatch(readFileSync(`${witness}.prompt`, 'utf-8'), /<triage>\s*\{/,
      'invalid triage must be absent so the lane derives it itself');
    assert.match(r.stderr, /triage was not valid JSON with the required shape/);
  });

  it('discards valid JSON with a non-triage shape', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    writeFileSync(join(hookScripts, 'lib/lane-triage.mjs'),
      'process.stdout.write(JSON.stringify({decision:"exit-no-op",reason:"placeholder"}));\n');

    const r = runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });

    assert.equal(existsSync(witness), true, 'wrong-shaped triage must never suppress the review');
    assert.equal(readFileSync(`${witness}.prompt`, 'utf-8').split('\n').includes('<triage>'), false);
    assert.match(r.stderr, /required shape/);
  });

  for (const [label, invalid] of [
    ['wrong lane', { lane: 'doc-updater' }],
    ['unknown decision', { decision: 'trust-me' }],
    ['wrong layout', { sdd: { bootstrapped: true, layout: 'unknown' } }],
  ]) {
    it(`discards triage with ${label} and performs normal review`, () => {
      const { cwd, base, head } = makeRepo('src/thing.ts');
      const { home, hookScripts } = makeClaudeHome(cwd);
      const witness = join(cwd, 'claude-was-called');
      const binDir = fakeClaude(cwd, witness);
      stubTriage(hookScripts, {
        decision: 'exit-no-op', reason: 'an SDD transition is active',
        transition: { active: true, corrupt: false }, ...invalid,
      });
      const r = runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(existsSync(witness), true, 'invalid triage must not suppress review');
      assert.equal(readFileSync(`${witness}.prompt`, 'utf-8').split('\n').includes('<triage>'), false);
      assert.match(r.stderr, /required shape/);
    });
  }

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

// Triage is a prompt input, so a clean one reached the launching session as
// nothing at all -- and "everything passed" and "nobody looked" are the same
// silence. The state that changes what a round does has to be legible without
// the lane choosing to restate it.
describe('run-review-lane.sh — triage state reaches the launching session', () => {
  it('calls a nominal triage clean and carries the state behind that verdict', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    stubTriage(hookScripts, {
      decision: 'proceed',
      roundLimit: { counted: 0, inspected: 6, action: 'continue' },
      bulkOpAudit: { checked: 3, findings: [] },
      transition: { active: false, corrupt: false },
    });

    const r = runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });

    assert.match(r.stderr, /triage=clean/,
      'a reader must not have to reconstruct the verdict out of four scalars');
    assert.match(r.stderr, /round=continue\(0\/6\)/);
    assert.match(r.stderr, /audit=0/);
  });

  // The shape real triage emits on the common path: lane-triage.mjs sets
  // roundLimit only when a round counter exists, so the code lane has none.
  // Requiring action === "continue" made every one of those runs report
  // attention -- the clean/absent conflation this telemetry exists to remove,
  // inverted. Both other tests stub the key, so neither covered it.
  it('calls triage clean when no round counter exists at all', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    stubTriage(hookScripts, {
      decision: 'proceed',
      bulkOpAudit: { checked: 0, findings: [] },
      transition: { active: false, corrupt: false },
    });

    const r = runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });

    assert.match(r.stderr, /triage=clean/,
      'an absent round counter is nothing to report, not a reason to withhold the verdict');
    assert.match(r.stderr, /round=n\/a/, 'absent must read as absent, never as an unknown value');
  });

  it('withholds the clean verdict when triage carries state a round should notice', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    stubTriage(hookScripts, {
      decision: 'proceed',
      roundLimit: { counted: 5, inspected: 6, action: 'stop' },
      bulkOpAudit: { checked: 4, findings: [{ id: 'bulk-prefix-missing' }] },
      transition: { active: false, corrupt: true },
    });

    const r = runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });

    assert.doesNotMatch(r.stderr, /triage=clean/,
      'a stopped counter, a corrupt transition and an audit finding must never read as clean');
    assert.match(r.stderr, /triage=attention/);
    assert.match(r.stderr, /audit=1/, 'the finding count is what says the lane owes a restatement');
    assert.match(r.stderr, /transition=corrupt/);
    assert.equal(existsSync(witness), true, 'reporting state must not stop the review');
  });
});

// Both blocks are inlined into every turn's prompt prefix, so both are bounded.
// The cap is the only thing standing between a large config and a cost paid on
// every turn of the run.
describe('run-review-lane.sh — inlined evidence is bounded', () => {
  it('drops an oversized triage block rather than carrying it every turn', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    stubTriage(hookScripts, {
      lane: 'code-reviewer', range: `${base}..${head}`,
      sdd: { bootstrapped: true, layout: 'nested' },
      decision: 'proceed', bulkOpAudit: { checked: 0, findings: [] },
      filler: 'x'.repeat(40000),
    });

    const r = runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });

    assert.equal(existsSync(witness), true, 'an oversized block degrades to a normal review, never to a skipped one');
    assert.match(r.stderr, /triage block over/);
    const argv = readFileSync(`${witness}.prompt`, 'utf-8');
    assert.doesNotMatch(argv, /xxxxxxxxxx/, 'the oversized block must not reach the prompt');
  });

  // Dropping the whole block sends the lane back to deriving Phase 0 in six
  // separate calls -- the cost AD116 exists to remove -- and the field that
  // blows the cap is almost always config.raw, which carries the config file
  // verbatim. Shedding one field keeps every decision the block was built for.
  it('sheds config.raw rather than the whole triage block', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    stubTriage(hookScripts, {
      lane: 'code-reviewer', range: `${base}..${head}`,
      decision: 'proceed',
      sdd: { bootstrapped: true, layout: 'nested', triageFile: 'sdd/spec/.review-queue.md' },
      config: { mode: 'auto', enforce_tdd: true, raw: 'y'.repeat(40000) },
      bulkOpAudit: { checked: 0, findings: [] },
    });

    const r = runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });

    assert.equal(existsSync(witness), true);
    const argv = readFileSync(`${witness}.prompt`, 'utf-8');
    assert.doesNotMatch(argv, /yyyyyyyyyy/, 'the field that blew the cap must not reach the prompt');
    assert.match(argv, /"mode": *"auto"|"mode":"auto"/,
      'the resolved decisions must survive, or the lane re-derives Phase 0 it was handed');
    assert.match(argv, /rawOmitted/,
      'the lane must be able to tell a shed field from an absent one');
    assert.match(r.stderr, /config\.raw omitted/);
  });

  it('keeps a triage block within the cap', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    stubTriage(hookScripts, {
      lane: 'code-reviewer', range: `${base}..${head}`,
      sdd: { bootstrapped: true, layout: 'nested' },
      decision: 'proceed', bulkOpAudit: { checked: 0, findings: [] }, marker: 'TRIAGE_MARKER',
    });

    runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });

    assert.match(readFileSync(`${witness}.prompt`, 'utf-8'), /TRIAGE_MARKER/,
      'a block under the cap is inlined, or the lane pays a turn to rebuild it');
  });

  // The packet CLI rejects an abbreviated range, so the full-SHA resolution is
  // what makes inlining possible at all. Nested inside the classifier branch it
  // vanished whenever lane-classifier.sh was absent.
  it('inlines the packet even when the lane classifier is missing', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    rmSync(join(hookScripts, 'lib/lane-classifier.sh'));
    const skillDir = join(home, 'skills/review-scope/scripts');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'build-review-packet.mjs'),
      'const i=process.argv.indexOf("--range");process.stdout.write(JSON.stringify({range:process.argv[i+1]}));\n');
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);

    runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base.slice(0, 8)}..${head.slice(0, 8)}` });

    const argv = readFileSync(`${witness}.prompt`, 'utf-8');
    assert.match(argv, new RegExp(`${base}\\.\\.${head}`),
      'the packet must carry full SHAs; abbreviated ones make the CLI throw and the lane falls back to raw scans');
  });
});

// REQ-AGENT-105 AC1/AC4. Turn count is the dominant cost term, so an
// over-budget lane must be visible -- but never stopped, because a truncated
// review is a worse failure than an expensive one.
describe('run-review-lane.sh — wave budget telemetry', () => {
  const withTurns = (cwd, witness, turns) => {
    const binDir = join(cwd, 'fake-bin');
    mkdirSync(binDir, { recursive: true });
    const p = join(binDir, 'claude');
    writeFileSync(p,
      `#!/usr/bin/env bash\necho invoked >> ${witness}\n` +
      `echo '{"is_error":false,"num_turns":${turns},"total_cost_usd":0,` +
      `"usage":{"input_tokens":1},"result":"## report"}'\n`);
    chmodSync(p, 0o755);
    return binDir;
  };

  it('notes a lane that ran over its wave budget', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const r = runLane({ repo: cwd, home, hookScripts, binDir: withTurns(cwd, witness, 12), lane: 'code-reviewer', range: `${base}..${head}` });

    assert.equal(r.status, 0, 'an over-budget lane still succeeds; the budget is advisory');
    assert.match(r.stdout, /## report/, 'its report must survive intact -- nothing is truncated');
    assert.match(r.stderr, /12 turns against a 4-wave budget/);
  });

  it('says nothing when a lane stays within budget', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const r = runLane({ repo: cwd, home, hookScripts, binDir: withTurns(cwd, witness, 3), lane: 'code-reviewer', range: `${base}..${head}` });

    assert.doesNotMatch(r.stderr, /wave budget/,
      'a within-budget lane must not emit noise, or the signal is worthless');
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

  it('refuses to launch independently when jq is unavailable', (t) => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    // Supply the real prerequisites, but no jq and no inherited PATH fallback.
    for (const tool of ['timeout', 'awk', 'mktemp', 'rm']) {
      const located = spawnSync('/bin/bash', ['-c', 'command -v "$1"', '_', tool], { encoding: 'utf8' });
      assert.equal(located.status, 0, `${tool}: ${located.stderr}`);
      symlinkSync(located.stdout.trim(), join(binDir, tool));
    }
    const seededRunner = join(hookScripts, 'run-review-lane.sh');
    writeFileSync(seededRunner, readFileSync(RUNNER, 'utf8'));
    const r = spawnSync('/bin/bash', [seededRunner, '--lane', 'code-reviewer', '--range', `${base}..${head}`], {
      cwd, encoding: 'utf8',
      env: { ...process.env, PATH: binDir, CLAUDE_CONFIG_DIR: home },
    });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /jq is required.*refusing to run unguarded/);
    assert.equal(existsSync(witness), false, 'missing jq must not start the reviewer');
  });

  it('refuses to launch when guard-settings generation produces an empty file', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    writeFileSync(join(binDir, 'jq'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    const r = runLane({ repo: cwd, home, hookScripts, binDir, lane: 'code-reviewer', range: `${base}..${head}` });
    assert.equal(r.status, 3);
    assert.equal(existsSync(witness), false, 'empty settings must not launch an unguarded reviewer');
    assert.match(r.stderr, /guard settings file is empty/);
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
      const executed = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
      assert.equal(executed.status, 0, executed.stderr);
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
      const executed = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
      assert.equal(executed.status, 0, executed.stderr);
    }
  });
});

// REQ-AGENT-102 constraint: the lane subprocess is time-bounded. `timeout 0`
// disables the bound entirely, so a zero or malformed value must fall back to
// the default rather than silently removing it.
describe('run-review-lane.sh — timeout bound', () => {
  // Shim `timeout` so the bound it was actually handed is observable; the real
  // one would just run the fake CLI and tell us nothing about its arguments.
  // Keyed by the command being wrapped (`$4`, after `-k <kill> <bound>`). The
  // runner bounds two different subprocesses -- the evidence resolver (`node`)
  // and the lane itself (`claude`) -- and a single truncating witness would
  // record only whichever ran last, making one of the two bounds unobservable.
  function fakeTimeout(binDir, witness) {
    const p = join(binDir, 'timeout');
    writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${witness}.timeout.$(basename "$4")"\nshift 3\nexec "$@"\n`);
    chmodSync(p, 0o755);
  }

  for (const [label, value, expected] of [
    ['zero', '0', '1800'],
    ['non-numeric', 'abc', '1800'],
    ['empty', '', '1800'],
    ['a real override', '600', '600'],
    ['a value that wraps 64-bit arithmetic', '99999999999999999999', '1800'],
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

      const argv = readFileSync(`${witness}.timeout.claude`, 'utf-8').split('\n');
      assert.equal(argv[0], '-k', 'plain SIGTERM leaves a wedged lane running');
      assert.equal(argv[2], expected);
    });
  }

  // The resolver runs BEFORE the lane and holds the gate open for its own bound,
  // so its default governs worst-case gate time just as the lane's does. It moved
  // 60s -> 300s to cover a full-branch range on a resumed session; untested, a
  // later edit or a mis-wired fallback would be invisible.
  for (const [label, value, expected] of [
    ['zero', '0', '300'],
    ['all-zero', '00', '300'],
    ['non-numeric', 'abc', '300'],
    ['empty', '', '300'],
    ['a leading-zero override', '0600', '600'],
    ['a real override', '600', '600'],
    ['a value that wraps 64-bit arithmetic', '99999999999999999999', '300'],
  ]) {
    it(`resolves ${label} REVIEW_LANE_EVIDENCE_TIMEOUT to ${expected}s`, () => {
      const { cwd, base, head } = makeRepo('src/thing.ts');
      const { home, hookScripts } = makeClaudeHome(cwd);
      const witness = join(cwd, 'claude-was-called');
      const binDir = fakeClaude(cwd, witness);
      fakeTimeout(binDir, witness);
      // Without a resolver on disk the runner skips the block entirely and never
      // bounds anything, so the assertion would pass on a file that never existed.
      stubEvidence(home, { lane: 'code-reviewer', references: { checked: 1, unresolved: [] } });

      const seededRunner = join(hookScripts, 'run-review-lane.sh');
      writeFileSync(seededRunner, readFileSync(RUNNER, 'utf-8'));
      spawnSync('bash', [seededRunner, '--lane', 'code-reviewer', '--range', `${base}..${head}`], {
        cwd, encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          CLAUDE_CONFIG_DIR: home,
          REVIEW_LANE_EVIDENCE_TIMEOUT: value,
        },
      });

      const argv = readFileSync(`${witness}.timeout.node`, 'utf-8').split('\n');
      assert.equal(argv[0], '-k', 'a reaped resolver must escalate past SIGTERM');
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
    assert.match(readFileSync(`${witness}.sysprompt`, 'utf-8'), /You are the code-reviewer lane\./,
      'the system prompt must be the lane document body, not a default');
  });
});

// REQ-AGENT-102 AC3: absence of the supervisor must refuse the lane rather
// than silently launching an unbounded model process.
describe('run-review-lane.sh — supervisor availability', () => {
  it('refuses to launch when timeout(1) is unavailable', () => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-was-called');
    const binDir = fakeClaude(cwd, witness);
    const seededRunner = join(hookScripts, 'run-review-lane.sh');
    writeFileSync(seededRunner, readFileSync(RUNNER, 'utf-8'));

    const r = spawnSync('/bin/bash', [seededRunner, '--lane', 'code-reviewer', '--range', `${base}..${head}`], {
      cwd, encoding: 'utf-8',
      env: { ...process.env, PATH: binDir, CLAUDE_CONFIG_DIR: home },
    });

    assert.equal(r.status, 3);
    assert.equal(existsSync(witness), false);
    assert.match(r.stderr, /timeout\(1\).*required/);
  });
});

// REQ-AGENT-105 AC4: a demanded lane without either scope form fails instead
// of widening itself to an unpacketized full-PR review.
describe('run-review-lane.sh — scope contract', () => {
  it('rejects a lane launch with neither range nor protected base', () => {
    const r = spawnSync('bash', [RUNNER, '--lane', 'code-reviewer'], {
      encoding: 'utf-8', timeout: 10000,
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--range or --base is required/);
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

// RQ0010/RQ0011 / REQ-AGENT-102 AC4: execute delivered guards, not path strings.
describe('hostile guard launch paths enforce refusal', () => {
  for (const suffix of ['my home', "quote'home", 'dollar$(false)`false`home', 'back\\slash']) {
    it(`enforces local-build and attribution guards under ${suffix}`, (t) => {
      const { cwd, base, head } = makeRepo('src/thing.ts');
      t.after(() => rmSync(cwd, { recursive: true, force: true }));
      const home = join(cwd, suffix);
      const hookScripts = join(home, 'plugins/codeflare-hooks/scripts');
      mkdirSync(hookScripts, { recursive: true });
      mkdirSync(join(home, 'agents'), { recursive: true });
      writeFileSync(join(home, 'agents/code-reviewer.md'), '---\nname: code-reviewer\n---\nGuard fixture.\n');
      for (const guard of ['block-local-builds.sh', 'block-attributed-commits.sh']) {
        writeFileSync(join(hookScripts, guard), readFileSync(join(dirname(RUNNER), guard)));
      }
      const witness = join(cwd, 'claude-called');
      const result = runLane({ repo: cwd, home, hookScripts, binDir: fakeClaude(cwd, witness), lane: 'code-reviewer', range: `${base}..${head}` });
      assert.equal(result.status, 0, result.stderr);
      const settings = JSON.parse(readFileSync(`${witness}.settings`, 'utf8'));
      const hooks = settings.hooks.PreToolUse.flatMap((entry) => entry.hooks);
      for (const command of ['npm test', 'git commit -m "Co-Authored-By: AI"']) {
        const decisions = hooks.map((hook) => {
          const result = spawnSync('bash', ['-c', hook.command], {
            cwd, encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
            env: { ...process.env, LOCAL_BUILD_BYPASS_FILE: join(cwd, 'absent-bypass') },
          });
          assert.equal(result.status, 0, result.stderr);
          if (!result.stdout.trim()) return false;
          const output = JSON.parse(result.stdout);
          return output.decision === 'block' || output.hookSpecificOutput?.permissionDecision === 'deny';
        });
        assert.ok(decisions.includes(true), `${command} must be refused by the launched guards`);
      }
    });
  }
});

// RQ0016 / REQ-AGENT-105 AC4: --base drives actual packet/ownership preparation.
describe('base-only review preparation', () => {
  it('delivers a merge-base packet even without the optional lane classifier', (t) => {
    const { cwd, base, head } = makeRepo('src/thing.ts');
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    git(cwd, 'update-ref', 'refs/remotes/origin/develop', base);
    const { home, hookScripts } = makeClaudeHome(cwd);
    rmSync(join(hookScripts, 'lib/lane-classifier.sh'));
    const packetDir = join(home, 'skills/review-scope/scripts');
    mkdirSync(packetDir, { recursive: true });
    // Seed the actual packet CLI; no model or external service is invoked.
    for (const file of ['build-review-packet.mjs']) {
      writeFileSync(join(packetDir, file), readFileSync(join(dirname(RUNNER), '../../../skills/review-scope/scripts', file)));
    }
    const witness = join(cwd, 'claude-called');
    const result = runLane({ repo: cwd, home, hookScripts, binDir: fakeClaude(cwd, witness), lane: 'code-reviewer', scopeArgs: ['--base', 'develop'] });
    assert.equal(result.status, 0, result.stderr);
    const delivered = readFileSync(`${witness}.prompt`, 'utf8');
    assert.match(delivered, new RegExp(`${base}\\.\\.${head}`));
    assert.match(delivered, /src\/thing\.ts/);
    assert.match(delivered, /<packet>/);
  });

  it('short-circuits ownership from a protected base without invoking a model', (t) => {
    const { cwd, base } = makeRepo('sdd/spec/thing.md');
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    git(cwd, 'update-ref', 'refs/remotes/origin/develop', base);
    const { home, hookScripts } = makeClaudeHome(cwd);
    const witness = join(cwd, 'claude-called');
    const result = runLane({ repo: cwd, home, hookScripts, binDir: fakeClaude(cwd, witness), lane: 'code-reviewer', scopeArgs: ['--base', 'develop'] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /NO-OP/);
    assert.equal(existsSync(witness), false);
  });
});

// RQ0009 / REQ-AGENT-107 AC1/3/4: pre-triage consumes the canonical gate.
describe('canonical and pre-triage round-limit parity', () => {
  const triageSource = join(dirname(RUNNER), 'lib/lane-triage.mjs');
  const gateSource = join(dirname(RUNNER), '../../../skills/spec-enforce/scripts/round-limit.mjs');
  function seedTriage(home, hookScripts) {
    writeFileSync(join(hookScripts, 'lib/lane-triage.mjs'), readFileSync(triageSource));
    const scripts = join(home, 'skills/spec-enforce/scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'round-limit.mjs'), readFileSync(gateSource));
  }
  for (const lane of ['spec-reviewer', 'doc-updater']) {
    for (const tag of ['[autonomous]', '[unleashed]', '[spec-reviewer]', '[doc-updater]', '[code-reviewer]', 'chore: [autonomous]']) {
      it(`${lane} agrees with the gate for ${tag} before suppression`, (t) => {
        const { cwd } = makeRepo('src/initial.ts');
        t.after(() => rmSync(cwd, { recursive: true, force: true }));
        for (let i = 0; i < 5; i += 1) {
          const file = lane === 'spec-reviewer' ? 'sdd/round.md' : 'documentation/round.md';
          mkdirSync(dirname(join(cwd, file)), { recursive: true });
          writeFileSync(join(cwd, file), `round ${i}\n`);
          git(cwd, 'add', file);
          git(cwd, 'commit', '-qm', `${tag} round ${i}`);
        }
        const { home, hookScripts } = makeClaudeHome(cwd);
        seedTriage(home, hookScripts);
        const tree = lane === 'spec-reviewer' ? 'sdd' : 'documentation';
        const canonical = spawnSync(process.execPath, [gateSource, '--repo', cwd, '--lane', tree], { encoding: 'utf8' });
        assert.equal(canonical.status, 0, canonical.stderr);
        const [, count, action] = canonical.stdout.match(/counted=(\d+) gate=(stop|continue)/);
        const triage = JSON.parse(spawnSync(process.execPath, [join(hookScripts, 'lib/lane-triage.mjs'), '--repo', cwd, '--lane', lane], { encoding: 'utf8' }).stdout);
        assert.equal(triage.roundLimit.counted, Number(count));
        assert.equal(triage.roundLimit.action, action);
        assert.equal(triage.decision, action === 'stop' ? 'exit-no-op' : 'proceed');
      });
    }
  }

  it('passes an explicit root override to the canonical gate, never a config marker', (t) => {
    const { cwd, base } = makeRepo('src/initial.ts');
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(cwd, 'sdd/round.md'), `${i}\n`);
      git(cwd, 'add', 'sdd/round.md');
      git(cwd, 'commit', '-qm', `[autonomous] round ${i}`);
    }
    writeFileSync(join(cwd, 'sdd/config.yml'), 'autonomy_override: fully-autonomous\n');
    const { home, hookScripts } = makeClaudeHome(cwd);
    seedTriage(home, hookScripts);
    const witness = join(cwd, 'claude-called');
    const binDir = fakeClaude(cwd, witness);
    const head = git(cwd, 'rev-parse', 'HEAD').stdout.trim();
    const stopped = runLane({ repo: cwd, home, hookScripts, binDir, lane: 'spec-reviewer', range: `${base}..${head}` });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(existsSync(witness), false, 'repository content cannot authorize autonomy');
    const continued = runLane({ repo: cwd, home, hookScripts, binDir, lane: 'spec-reviewer', scopeArgs: ['--range', `${base}..${head}`, '--autonomy-override', 'fully-autonomous'] });
    assert.equal(continued.status, 0, continued.stderr);
    assert.equal(existsSync(witness), true, 'root must be able to forward the direct current-user override');
    assert.match(readFileSync(`${witness}.prompt`, 'utf8'), /"counted":\s*5/);
    assert.match(readFileSync(`${witness}.prompt`, 'utf8'), /"action":\s*"continue"/);
    assert.match(readFileSync(`${witness}.prompt`, 'utf8'), /autonomy_override=fully-autonomous/,
      'the reviewer must retain the exact direct-user marker, not stop again in canonical policy');
  });

  it('does not suppress review when the canonical gate is unavailable', (t) => {
    const { cwd } = makeRepo('sdd/round.md');
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(cwd, 'sdd/round.md'), `${i}\n`);
      git(cwd, 'add', 'sdd/round.md'); git(cwd, 'commit', '-qm', `[autonomous] round ${i}`);
    }
    const { home, hookScripts } = makeClaudeHome(cwd);
    seedTriage(home, hookScripts);
    rmSync(join(home, 'skills/spec-enforce/scripts/round-limit.mjs'));
    const triage = JSON.parse(spawnSync(process.execPath, [join(hookScripts, 'lib/lane-triage.mjs'), '--repo', cwd, '--lane', 'spec-reviewer'], { encoding: 'utf8' }).stdout);
    assert.equal(triage.decision, 'proceed');
    assert.match(triage.reason, /triage failed/);
  });
});

// RQ0009: reset, excluded tags, merge history and unreadable history stay canonical.
describe('pre-triage canonical history boundaries', () => {
  const triage = join(dirname(RUNNER), 'lib/lane-triage.mjs');
  const gate = join(dirname(RUNNER), '../../../skills/spec-enforce/scripts/round-limit.mjs');
  for (const boundary of ['reset', 'bulk', 'merge']) {
    it(`agrees with the canonical gate across ${boundary}`, (t) => {
      const { cwd } = makeRepo('sdd/round.md');
      t.after(() => rmSync(cwd, { recursive: true, force: true }));
      for (let i = 0; i < 5; i += 1) {
        writeFileSync(join(cwd, 'sdd/round.md'), `${i}\n`);
        git(cwd, 'add', 'sdd/round.md'); git(cwd, 'commit', '-qm', `[autonomous] round ${i}`);
      }
      if (boundary === 'merge') {
        git(cwd, 'checkout', '-qb', 'side');
        writeFileSync(join(cwd, 'sdd/side.md'), 'side\n');
        git(cwd, 'add', 'sdd/side.md'); git(cwd, 'commit', '-qm', 'user-directed side');
        git(cwd, 'checkout', '-');
        git(cwd, 'merge', '--no-ff', '-m', '[code-reviewer] merge round', 'side');
      } else {
        writeFileSync(join(cwd, 'sdd/round.md'), 'boundary\n');
        git(cwd, 'add', 'sdd/round.md');
        git(cwd, 'commit', '-qm', boundary === 'reset' ? 'user-directed work' : '[sdd-clean] bulk');
      }
      const canonical = spawnSync(process.execPath, [gate, '--repo', cwd, '--lane', 'sdd'], { encoding: 'utf8' });
      assert.equal(canonical.status, 0, canonical.stderr);
      const [, count, action] = canonical.stdout.match(/counted=(\d+) gate=(stop|continue)/);
      const result = spawnSync(process.execPath, [triage, '--repo', cwd, '--lane', 'spec-reviewer'], { encoding: 'utf8' });
      const out = JSON.parse(result.stdout);
      assert.equal(out.roundLimit.counted, Number(count));
      assert.equal(out.roundLimit.action, action);
    });
  }

  it('never fabricates a permissive round verdict for unreadable history', (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'triage-no-history-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    mkdirSync(join(cwd, 'sdd'));
    writeFileSync(join(cwd, 'sdd/README.md'), '# fixture\n');
    const result = spawnSync(process.execPath, [triage, '--repo', cwd, '--lane', 'spec-reviewer'], { encoding: 'utf8' });
    const out = JSON.parse(result.stdout);
    assert.equal(out.decision, 'proceed');
    assert.equal(out.roundLimit, undefined);
    assert.match(out.reason, /triage failed/);
  });
});
