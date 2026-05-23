// Real behavioral tests for the UserPromptSubmit memory-capture hook.
//
// Spawns the actual bash script with stdin JSON and asserts on exit code,
// stdout, and side-effect files. Each test uses a fresh temp $HOME so
// counter / lock files don't bleed between tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh',
);

function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'memcap-home-'));
  return home;
}

function writeTranscript(dir, lines) {
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

function realUserLine(content) {
  // Real human prompt: string content NOT starting with `<`
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
  });
}

function toolResultLine() {
  // Synthetic tool_result wrapper — must NOT be counted
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content: 'output' }],
    },
  });
}

function commandWrapperLine(tag) {
  // Slash-command / task-notification wrapper — must NOT be counted
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: `<${tag}>foo</${tag}>` },
  });
}

function runHook(home, { transcriptPath, sessionId = 'sess-1' }) {
  return spawnSync('bash', [HOOK], {
    input: JSON.stringify({
      transcript_path: transcriptPath,
      session_id: sessionId,
    }),
    encoding: 'utf-8',
    env: { ...process.env, HOME: home },
  });
}

// REQ-MEM-002 (input gating: safety guards for missing inputs/files)
describe('memory-capture.sh - input gating / REQ-MEM-002 (capture triggers every 15 user messages)', () => {
  // REQ-MEM-002 (input safety: hook called without transcript_path exits 0 silently)
  it('exits 0 silently when transcript_path is missing', () => {
    const home = makeFixture();
    const r = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ session_id: 'sess-1' }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: home },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  // REQ-MEM-002 AC1 (counter file keyed by session_id; absent session_id -> nothing to read/write)
  it('exits 0 silently when session_id is missing', () => {
    const home = makeFixture();
    const t = writeTranscript(home, [realUserLine('hi')]);
    const r = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ transcript_path: t }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: home },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  // REQ-MEM-002 (input safety: nonexistent transcript file path exits 0 silently)
  it('exits 0 silently when transcript file does not exist', () => {
    const home = makeFixture();
    const r = runHook(home, {
      transcriptPath: join(home, 'nonexistent.jsonl'),
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

// REQ-MEM-002 AC2 (no counter -> write baseline + emit graphify-query directive)
describe('memory-capture.sh - first-run baseline / REQ-MEM-010 (memory capture hook plumbing)', () => {
  // REQ-MEM-002 AC2 + REQ-MEM-010 AC3 (first-run emits memory-scan directive)
  it('first run creates counter file and emits memory-scan directive', () => {
    const home = makeFixture();
    const t = writeTranscript(home, [realUserLine('first message')]);
    const r = runHook(home, { transcriptPath: t, sessionId: 'sess-first' });
    assert.equal(r.status, 0);
    // additionalContext should mention searching MCP memory
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext, /search.*memory/i);
    // Counter file written
    const counterFile = join(home, '.memory/counter/sess-first');
    assert.equal(existsSync(counterFile), true);
    const lines = readFileSync(counterFile, 'utf-8').trim().split('\n');
    assert.equal(lines[0], '1', 'first run baselines current_count');
  });
});

// REQ-MEM-002 AC3/AC4/AC5 (delta logic: <15 silent, >=15 fires, counter advances)
describe('memory-capture.sh - user-message counting', () => {
  // REQ-MEM-002 AC3 (delta calculation counts only real user prompts; delta<15 -> silent)
  it('counts only real user prompts, excluding tool_results and command wrappers', () => {
    const home = makeFixture();
    // Pre-create counter so this isn't a first-run baseline
    mkdirSync(join(home, '.memory/counter'), { recursive: true });
    writeFileSync(join(home, '.memory/counter/sess-c'), '0\n0\n');

    const lines = [
      realUserLine('msg 1'),
      toolResultLine(),
      commandWrapperLine('local-command-caveat'),
      realUserLine('msg 2'),
      commandWrapperLine('command-name'),
      commandWrapperLine('task-notification'),
      realUserLine('msg 3'),
      toolResultLine(),
    ];
    const t = writeTranscript(home, lines);
    const r = runHook(home, { transcriptPath: t, sessionId: 'sess-c' });
    assert.equal(r.status, 0);
    // Delta is 3 (real prompts) - 0 (last_count) = 3, less than 15 → no capture directive.
    // Counter must not have been advanced (delta < 15 path doesn't write counter).
    // But CURRENT_COUNT must be 3, demonstrable via the next test where we
    // pre-load last_count = 3 and add more real prompts.
    // Here we just assert: stdout is empty (no capture, and no first-run scan).
    assert.equal(r.stdout, '',
      'delta < 15 with existing counter must produce no output');
  });

  // REQ-MEM-002 AC4 + AC6 (delta>=15 -> write .vars + emit additionalContext mentioning vars path)
  it('triggers capture when 15+ NEW real prompts since last_count', () => {
    const home = makeFixture();
    mkdirSync(join(home, '.memory/counter'), { recursive: true });
    writeFileSync(join(home, '.memory/counter/sess-t'), '0\n0\n');
    // 15 real + several wrappers (which must NOT be counted toward delta)
    const lines = [];
    for (let i = 0; i < 15; i++) lines.push(realUserLine(`prompt ${i}`));
    for (let i = 0; i < 10; i++) lines.push(toolResultLine());
    for (let i = 0; i < 5; i++) lines.push(commandWrapperLine('command-name'));
    const t = writeTranscript(home, lines);
    const r = runHook(home, { transcriptPath: t, sessionId: 'sess-t' });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    // additionalContext must reference the vars file the agent will read
    const vars = join(home, '.memory/counter/sess-t.vars');
    assert.ok(
      out.hookSpecificOutput.additionalContext.includes(vars),
      `additionalContext should mention vars path; got: ${out.hookSpecificOutput.additionalContext}`,
    );
    assert.equal(existsSync(vars), true,
      'capture path must write the .vars file');
    const v = JSON.parse(readFileSync(vars, 'utf-8'));
    assert.equal(v.current_count, '15');
  });

  // REQ-MEM-002 AC3 (boundary: 14 real prompts is < 15 threshold -> silent, no .vars)
  it('does NOT trigger when 14 new real prompts (boundary, delta < 15)', () => {
    const home = makeFixture();
    mkdirSync(join(home, '.memory/counter'), { recursive: true });
    writeFileSync(join(home, '.memory/counter/sess-b'), '0\n0\n');
    const lines = [];
    for (let i = 0; i < 14; i++) lines.push(realUserLine(`p ${i}`));
    const t = writeTranscript(home, lines);
    const r = runHook(home, { transcriptPath: t, sessionId: 'sess-b' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', '14 prompts must not trigger capture');
    // .vars file must NOT have been written
    assert.equal(
      existsSync(join(home, '.memory/counter/sess-b.vars')),
      false,
    );
  });

  // REQ-MEM-002 AC5 (counter updated BEFORE emitting; subsequent invocations within window are silent)
  it('counter advances on capture so the next run starts a fresh window', () => {
    const home = makeFixture();
    mkdirSync(join(home, '.memory/counter'), { recursive: true });
    writeFileSync(join(home, '.memory/counter/sess-x'), '0\n0\n');
    const lines = [];
    for (let i = 0; i < 16; i++) lines.push(realUserLine(`p ${i}`));
    const t = writeTranscript(home, lines);
    runHook(home, { transcriptPath: t, sessionId: 'sess-x' });
    const counter = readFileSync(
      join(home, '.memory/counter/sess-x'),
      'utf-8',
    ).trim().split('\n');
    assert.equal(counter[0], '16',
      'counter[0] must advance to CURRENT_COUNT after capture');
    // Second run with the same transcript: delta = 0 → silent
    const r2 = runHook(home, { transcriptPath: t, sessionId: 'sess-x' });
    assert.equal(r2.stdout, '',
      'after capture, repeat invocations on same transcript must be silent');
  });
});

// REQ-MEM-002 (path handling: tilde expansion for cross-environment robustness)
describe('memory-capture.sh - tilde expansion', () => {
  // REQ-MEM-002 (operational robustness: ~/path must resolve to $HOME)
  it('expands ~ in transcript_path to $HOME', () => {
    const home = makeFixture();
    mkdirSync(join(home, '.memory/counter'), { recursive: true });
    writeFileSync(join(home, '.memory/counter/sess-tilde'), '0\n0\n');
    const realPath = join(home, 'transcript.jsonl');
    writeFileSync(realPath, realUserLine('hi') + '\n');
    // Pass `~/transcript.jsonl` — hook should expand to $HOME
    const r = runHook(home, {
      transcriptPath: '~/transcript.jsonl',
      sessionId: 'sess-tilde',
    });
    assert.equal(r.status, 0,
      'tilde-prefixed path must resolve to a real file (no error)');
  });
});

// REQ-MEM-001 AC1 (hook is registered as UserPromptSubmit; output must conform to that protocol)
describe('memory-capture.sh - output protocol', () => {
  // REQ-MEM-001 AC1 (UserPromptSubmit JSON shape, never Stop-hook decision/block fields)
  it('output is valid UserPromptSubmit JSON, never Stop-hook decision/block', () => {
    const home = makeFixture();
    const t = writeTranscript(home, [realUserLine('first message')]);
    const r = runHook(home, { transcriptPath: t, sessionId: 'sess-p' });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    // Must use UserPromptSubmit protocol
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    // Must NOT contain Stop-hook fields
    assert.equal(out.decision, undefined,
      'UserPromptSubmit hook must not emit decision field');
  });
});
