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

function runLane({ repo, home, hookScripts, binDir, lane, range, env = {} }) {
  // Invoke through the seeded copy so `dirname $0` resolves the classifier.
  const seededRunner = join(hookScripts, 'run-review-lane.sh');
  // readFileSync, not `cat`: a missing source would make cat return empty stdout
  // without throwing, writing a zero-byte "runner" and reporting a confusing
  // symptom instead of the real cause.
  writeFileSync(seededRunner, readFileSync(RUNNER, 'utf-8'));
  return spawnSync('bash', [seededRunner, '--lane', lane, '--range', range], {
    cwd: repo,
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: home, ...env },
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
      // Two resolutions the shed also drops. Absent and shed are the same shape
      // to the lane, so an unnamed loss is re-derived at the cost of a turn.
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
      assert.match(argv, new RegExp(`"omitted":\\[[^\\]]*"${field}"`),
        `a dropped resolution must name itself; unnamed, ${field} is indistinguishable from one never carried`);
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
    stubTriage(hookScripts, { decision: 'proceed', filler: 'x'.repeat(40000) });

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
      decision: 'proceed',
      sdd: { layout: 'nested', triageFile: 'sdd/spec/.review-queue.md' },
      config: { mode: 'auto', enforce_tdd: true, raw: 'y'.repeat(40000) },
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
    stubTriage(hookScripts, { decision: 'proceed', marker: 'TRIAGE_MARKER' });

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
