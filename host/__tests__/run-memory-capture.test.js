// REQ-MEM-020: memory capture runs as a bounded headless subprocess that is
// handed a prepared payload, and commits nothing the publisher cannot verify.
//
// `claude` is stubbed on PATH. That is the point of the seam, not a shortcut:
// these rows are about what the launcher hands the model and what it refuses to
// do without one, and a real capture would answer neither question while
// writing to the vault.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, utimesSync } from 'node:fs';
import { tempDir } from './helpers/temp-dirs.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RUNNER = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-memory/scripts/run-memory-capture.sh',
);

const SESSION = 'abcdef1234567890';
const PAYLOAD_DIR = `/tmp/memory-capture-${SESSION.slice(0, 8)}`;

const ENVELOPE = '{"type":"result","subtype":"error_max_turns","result":"response body from the model"}';

function fixture({ transcriptLines = 3, lastLine = '0', captureWritten = false, claudeExits = 0, stdoutLine = ENVELOPE } = {}) {
  const dir = tempDir('memcap-');
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const capture = join(dir, 'capture.md');
  // The stub records what it was handed and optionally plays a capture that
  // wrote its file, which is the only difference the publisher reacts to.
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/usr/bin/env bash',
      `cat > "${join(dir, 'stdin.txt')}"`,
      `printf '%s\\n' "$@" > "${join(dir, 'argv.txt')}"`,
      `echo '${stdoutLine}'`,
      'echo "capture failed: simulated" >&2',
      captureWritten ? `printf 'captured\\n' > "${capture}"` : ':',
      `exit ${claudeExits}`,
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);

  const transcript = join(dir, 'transcript.jsonl');
  const lines = [];
  for (let i = 0; i < transcriptLines; i++) {
    lines.push(
      i % 2 === 0
        ? JSON.stringify({ type: 'user', message: { role: 'user', content: `prompt number ${i}` } })
        : JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: `reply number ${i}` }] },
          }),
    );
  }
  writeFileSync(transcript, lines.join('\n') + '\n');

  const vars = join(dir, 'session.vars');
  writeFileSync(
    vars,
    JSON.stringify({
      transcript,
      last_line: lastLine,
      total_lines: String(transcriptLines),
      counter_file: join(dir, 'counter', SESSION),
      capture_file: capture,
      capture_timestamp: '2026-08-12T00-00-00+0200',
      current_count: '15',
      attempts: 1,
    }),
  );
  return { dir, bin, vars, capture, transcript };
}

const run = (fx, args, env = {}) =>
  spawnSync('bash', [RUNNER, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${fx.bin}:${process.env.PATH}`, ...env },
  });

describe('run-memory-capture.sh — headless capture transport', () => {
  it('hands the model a prepared payload instead of the raw transcript', () => {
    rmSync(PAYLOAD_DIR, { recursive: true, force: true });
    const fx = fixture();
    run(fx, ['--vars', fx.vars]);

    assert.ok(existsSync(join(PAYLOAD_DIR, 'clean.ndjson')), 'prefilter ran before the model started');
    const task = readFileSync(join(fx.dir, 'stdin.txt'), 'utf-8');
    const request = join(PAYLOAD_DIR, 'request.json');
    // The conversation travels IN the prompt. Handing over a path instead put
    // the payload on the tool-result channel, which truncates and persists it:
    // a traced run spent every turn paging its own request back in and hit the
    // ceiling before writing the note. A path here is the whole defect.
    assert.ok(task.includes('prompt number 0'),
      'the conversation must arrive inline, not as a path the model has to retrieve');
    assert.match(task, /capture_file: /, 'the capture target travels with it');
    assert.doesNotMatch(task, new RegExp(request),
      'naming the request file invites the retrieval this delivery exists to avoid');
    assert.doesNotMatch(task, new RegExp(fx.transcript), 'the raw transcript path is not handed over');

    // Self-contained by contract: the conversation travels inside the request,
    // so the capture has no path to derive, no directory to walk and nothing
    // to reread. Each reread cost a model round-trip out of a small budget.
    const payload = JSON.parse(readFileSync(request, 'utf-8'));
    assert.equal(payload.capture_file, fx.capture, 'the capture target is carried, not recomputed');
    assert.equal(typeof payload.current_count, 'number', 'a count crosses as a number, not a string');
    assert.ok(payload.transcript.includes('prompt number 0'),
      'the prefiltered conversation is embedded, not referenced');
  });

  it('bounds the run and isolates it from session configuration', () => {
    const fx = fixture();
    run(fx, ['--vars', fx.vars]);
    const argv = readFileSync(join(fx.dir, 'argv.txt'), 'utf-8').split('\n');

    assert.equal(argv[argv.indexOf('--max-turns') + 1], '6', 'six turns, matching the capture contract');
    assert.ok(argv.includes('--strict-mcp-config'), 'no session MCP servers');
    // An empty --setting-sources is the flag that stops the capture inheriting
    // this session's settings, and it arrives as an empty argv slot.
    assert.equal(argv[argv.indexOf('--setting-sources') + 1], '', 'no session settings inherited');
  });

  it('lands a non-numeric turn override on the same budget as the default', () => {
    const fx = fixture();
    run(fx, ['--vars', fx.vars], { CODEFLARE_MEMORY_MAX_TURNS: 'abc' });
    const argv = readFileSync(join(fx.dir, 'argv.txt'), 'utf-8').split('\n');
    // The default and the sanitiser's fallback are two independent literals, so
    // the row above holds while the fallback drifts back to the old budget. A
    // garbage override is the only input that reaches the second one.
    assert.equal(argv[argv.indexOf('--max-turns') + 1], '6',
      'a rejected override must fall back to the current budget, not the historical one');
  });

  it('refuses to publish when the capture wrote no file', () => {
    const fx = fixture({ captureWritten: false });
    const r = run(fx, ['--vars', fx.vars]);
    assert.equal(r.status, 3, 'the publisher rejects an unverified capture');
    assert.match(r.stderr, /capture file absent/);
  });

  it('does not start a second capture for a carrier already running', () => {
    const fx = fixture();
    const lock = `${fx.vars}.lock`;
    // Hold the lock in a detached process, then wait for it to actually be held
    // rather than guessing: a fixed sleep decides this test's outcome under
    // load, and the assertion inverts when the holder loses the race.
    const holder = spawn('bash', ['-c', `exec 9>"${lock}"; flock 9; sleep 30`], {
      detached: true, stdio: 'ignore',
    });
    holder.unref();
    try {
      let held = false;
      for (let i = 0; i < 100 && !held; i++) {
        held = spawnSync('bash', ['-c', `exec 9>"${lock}"; flock -n 9`]).status !== 0;
        if (!held) spawnSync('bash', ['-c', 'sleep 0.05']);
      }
      assert.ok(held, 'the holder took the lock');
      const r = run(fx, ['--vars', fx.vars]);
      assert.equal(r.status, 0, 'a second launch evaporates rather than racing the first');
      assert.match(r.stderr, /already running/);
      assert.ok(!existsSync(join(fx.dir, 'argv.txt')), 'the model was never invoked twice');
    } finally {
      // detached:true already makes the child a session leader, so its pid IS
      // the group. Wrapping it in setsid(1) made this kill throw ESRCH.
      try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('exits without launching when the slice holds nothing new', () => {
    const fx = fixture({ transcriptLines: 3, lastLine: '3' });
    const r = run(fx, ['--vars', fx.vars]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /nothing new to capture/);
    assert.ok(!existsSync(join(fx.dir, 'argv.txt')), 'the model was never invoked');
  });

  // Detached launches discard the runner's own stderr, so a window that burned
  // its attempts used to leave nothing sayable about why. The journal beside
  // the carrier is the only durable record; if these lines stop landing, the
  // next silent failure is undiagnosable again.
  it('journals each attempt with the capture exit and the publisher verdict', () => {
    const fx = fixture({ claudeExits: 1, captureWritten: false });
    const r = run(fx, ['--vars', fx.vars]);
    assert.equal(r.status, 3, 'the publisher verdict still decides the runner status');
    const journal = readFileSync(fx.vars.replace(/\.vars$/, '.attempts.log'), 'utf-8');
    assert.match(journal, /attempt=1 exit=1$/m, 'the failed capture run is recorded');
    assert.match(journal, /attempt=1 publish=3$/m, 'the refusal that burned the window is recorded');
    assert.match(journal, /capture failed: simulated/, 'the stderr tail survives for diagnosis');
    assert.match(journal, /stdout: error_max_turns/, 'the envelope subtype diagnoses stdout-borne failures');
    assert.doesNotMatch(journal, /response body/, 'the model response never lands in the journal');
  });

  // A capture reaped mid-write leaves partial, unparseable stdout — the one
  // crash the subtype line cannot describe. The fallback must say that stdout
  // existed without quoting a byte of it.
  it('journals a byte count when stdout is not a parseable envelope', () => {
    const fx = fixture({ claudeExits: 1, stdoutLine: 'partial garbage, not an envelope' });
    run(fx, ['--vars', fx.vars]);
    const journal = readFileSync(fx.vars.replace(/\.vars$/, '.attempts.log'), 'utf-8');
    assert.match(journal, /stdout: unparseable \(\d+ bytes\)/,
      'a truncated envelope is distinguishable from no output at all');
    assert.doesNotMatch(journal, /partial garbage/, 'unparseable output is still never quoted');
  });

  // jq streams: a valid envelope followed by trailing bytes prints the subtype
  // line and then exits non-zero, which used to append a second, contradictory
  // stdout line. Any partial parse falls back as a whole.
  it('journals exactly one stdout line when a valid envelope has trailing bytes', () => {
    const fx = fixture({ claudeExits: 1, stdoutLine: '{"type":"result","subtype":"error_max_turns"} trailing bytes' });
    run(fx, ['--vars', fx.vars]);
    const journal = readFileSync(fx.vars.replace(/\.vars$/, '.attempts.log'), 'utf-8');
    assert.equal((journal.match(/stdout: /g) ?? []).length, 1, 'partial parses must not journal contradictory lines');
    assert.match(journal, /stdout: unparseable/, 'a stream jq cannot fully parse falls back as a whole');
  });

  it('refuses a carrier it cannot read', () => {
    const fx = fixture();
    const r = run(fx, ['--vars', join(fx.dir, 'no-such.vars')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /carrier unreadable/);
  });

  // Each session gets its own payload directory and only ever reclaims its own,
  // so a container running many sessions accumulated them -- now each holding a
  // full embedded transcript. Age is the discriminator: a directory a live
  // capture is still writing into must survive the sweep that clears last
  // week's.
  it('reclaims stale sibling payload directories without touching recent ones', () => {
    const stale = '/tmp/memory-capture-staletest';
    const recent = '/tmp/memory-capture-freshtest';
    rmSync(stale, { recursive: true, force: true });
    rmSync(recent, { recursive: true, force: true });
    mkdirSync(stale, { recursive: true });
    mkdirSync(recent, { recursive: true });
    try {
      // A fixed past date rather than a relative one: it only grows staler, so
      // this stays deterministic however long from now the suite runs.
      const longAgo = new Date('2026-08-09T00:00:00Z');
      utimesSync(stale, longAgo, longAgo);

      const fx = fixture();
      run(fx, ['--vars', fx.vars]);

      assert.equal(existsSync(stale), false, 'a payload directory nobody will reopen is reclaimed');
      assert.ok(existsSync(recent), 'one that may still be in use is left alone');
    } finally {
      // A failing assertion must not strand either fixed-path directory for
      // the next run's setup rmSync to silently mask.
      rmSync(stale, { recursive: true, force: true });
      rmSync(recent, { recursive: true, force: true });
    }
  });
});
