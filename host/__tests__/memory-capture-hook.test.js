// Real behavioral tests for the UserPromptSubmit memory-capture hook.
//
// Spawns the actual bash script with stdin JSON and asserts on exit code,
// stdout, and side-effect files. Each test uses a fresh temp $HOME AND a
// fresh MEMCAP_COUNTER_DIR override so counter / lock files don't bleed
// between tests. The MEMCAP_COUNTER_DIR override is the production-script's
// only test-injection point; production never sets it (defaults to /tmp).

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
  const counterDir = mkdtempSync(join(tmpdir(), 'memcap-counter-'));
  return { home, counterDir };
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

function runHook({ home, counterDir }, { transcriptPath, sessionId = 'sess-1' }) {
  return spawnSync('bash', [HOOK], {
    input: JSON.stringify({
      transcript_path: transcriptPath,
      session_id: sessionId,
    }),
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, MEMCAP_COUNTER_DIR: counterDir },
  });
}

// REQ-MEM-002 (input gating: safety guards for missing inputs/files)
describe('memory-capture.sh - input gating / REQ-MEM-002 (capture triggers every 15 user messages)', () => {
  it('exits 0 silently when transcript_path is missing', () => {
    const { home, counterDir } = makeFixture();
    const r = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ session_id: 'sess-1' }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, MEMCAP_COUNTER_DIR: counterDir },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('exits 0 silently when session_id is missing', () => {
    const fx = makeFixture();
    const t = writeTranscript(fx.home, [realUserLine('hi')]);
    const r = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ transcript_path: t }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: fx.home, MEMCAP_COUNTER_DIR: fx.counterDir },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('exits 0 silently when transcript file does not exist', () => {
    const fx = makeFixture();
    const r = runHook(fx, {
      transcriptPath: join(fx.home, 'nonexistent.jsonl'),
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

// REQ-MEM-002 AC2 + AC7 (no counter = fresh container; distinguish brand-new vs resumed)
describe('memory-capture.sh - first-run baseline + resume detection / REQ-MEM-010 (memory capture hook plumbing)', () => {
  // REQ-MEM-002 AC2 + REQ-MEM-010 AC3: brand-new session (1 prompt) baselines and emits directive
  it('first run on a brand-new session baselines and emits memory-scan directive', () => {
    const fx = makeFixture();
    const t = writeTranscript(fx.home, [realUserLine('first message')]);
    const r = runHook(fx, { transcriptPath: t, sessionId: 'sess-first' });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext, /query the unified graph/i);
    // Counter file written under MEMCAP_COUNTER_DIR (not $HOME/.memory)
    const counterFile = join(fx.counterDir, 'sess-first');
    assert.equal(existsSync(counterFile), true);
    const lines = readFileSync(counterFile, 'utf-8').trim().split('\n');
    assert.equal(lines[0], '1', 'brand-new session baselines current_count');
    // .vars must NOT be written (brand-new => no capture)
    assert.equal(
      existsSync(join(fx.counterDir, 'sess-first.vars')),
      false,
      'brand-new session must NOT trigger capture',
    );
  });

  // REQ-MEM-002 AC7: resumed session (no counter + transcript has >1 prompt)
  // force-fires capture from line 1 AND re-emits graph-query directive.
  // Models the canonical codeflare resume path: container recycled, /tmp wiped,
  // transcript restored on disk, CURRENT_COUNT reflects accumulated prior prompts.
  it('AC7 - missing counter + transcript with >1 prompt force-fires capture from line 1', () => {
    const fx = makeFixture();
    const lines = [];
    for (let i = 0; i < 8; i++) lines.push(realUserLine(`prior-session prompt ${i}`));
    const t = writeTranscript(fx.home, lines);
    const r = runHook(fx, { transcriptPath: t, sessionId: 'sess-resume' });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    // AC7 first contract: capture fires despite delta < 15
    const vars = join(fx.counterDir, 'sess-resume.vars');
    assert.equal(existsSync(vars), true, 'AC7: resumed session must force-fire capture');
    const v = JSON.parse(readFileSync(vars, 'utf-8'));
    assert.equal(v.last_line, '1', 'AC7: capture must start at transcript line 1 (no tail lost)');
    assert.equal(v.current_count, '8', 'AC7: capture covers all prior prompts');
    // AC7 second contract: graph-query directive re-emitted
    assert.match(
      out.hookSpecificOutput.additionalContext,
      /query the unified graph/i,
      'AC7: must re-emit graph-query directive on resume',
    );
    // Capture directive also present (compound directive)
    assert.match(
      out.hookSpecificOutput.additionalContext,
      /MANDATORY MEMORY CAPTURE/,
      'AC7: capture directive must accompany graph-query directive',
    );
    // Counter advanced past the captured range
    const counter = readFileSync(join(fx.counterDir, 'sess-resume'), 'utf-8').trim().split('\n');
    assert.equal(counter[0], '8', 'AC7: counter advances to CURRENT_COUNT after force-fire');
  });

  // REQ-MEM-002 AC7 boundary: counter absent but transcript has exactly 1 prompt
  // is the brand-new-session case, NOT a resume - must not force-fire.
  it('AC7 boundary - missing counter + transcript with exactly 1 prompt is brand-new (no capture)', () => {
    const fx = makeFixture();
    const t = writeTranscript(fx.home, [realUserLine('only prompt')]);
    const r = runHook(fx, { transcriptPath: t, sessionId: 'sess-edge' });
    assert.equal(r.status, 0);
    // Directive emitted (graph-query nudge)
    const out = JSON.parse(r.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /query the unified graph/i);
    // Capture must NOT have fired
    assert.equal(
      existsSync(join(fx.counterDir, 'sess-edge.vars')),
      false,
      'AC7 boundary: CURRENT_COUNT=1 is brand-new, not resume',
    );
    // No MANDATORY MEMORY CAPTURE wrapper text
    assert.equal(
      out.hookSpecificOutput.additionalContext.includes('MANDATORY MEMORY CAPTURE'),
      false,
    );
  });
});

// REQ-MEM-002 AC3/AC4/AC5 (delta logic: <15 silent, >=15 fires, counter advances)
describe('memory-capture.sh - user-message counting', () => {
  // REQ-MEM-001 AC2: two-layer grep filter excludes tool-result wrappers (array content)
  // and synthetic messages (content starts with `<`); only real user prompts are counted.
  it('counts only real user prompts, excluding tool_results and command wrappers', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.counterDir, 'sess-c'), '0\n0\n');

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
    const t = writeTranscript(fx.home, lines);
    const r = runHook(fx, { transcriptPath: t, sessionId: 'sess-c' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '',
      'delta < 15 with existing counter must produce no output');
  });

  // REQ-MEM-002 AC4: delta>=15 -> write .vars + emit additionalContext mentioning vars path
  it('triggers capture when 15+ NEW real prompts since last_count', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.counterDir, 'sess-t'), '0\n0\n');
    const lines = [];
    for (let i = 0; i < 15; i++) lines.push(realUserLine(`prompt ${i}`));
    for (let i = 0; i < 10; i++) lines.push(toolResultLine());
    for (let i = 0; i < 5; i++) lines.push(commandWrapperLine('command-name'));
    const t = writeTranscript(fx.home, lines);
    const r = runHook(fx, { transcriptPath: t, sessionId: 'sess-t' });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    const vars = join(fx.counterDir, 'sess-t.vars');
    assert.ok(
      out.hookSpecificOutput.additionalContext.includes(vars),
      `additionalContext should mention vars path; got: ${out.hookSpecificOutput.additionalContext}`,
    );
    assert.equal(existsSync(vars), true,
      'capture path must write the .vars file');
    const v = JSON.parse(readFileSync(vars, 'utf-8'));
    assert.equal(v.current_count, '15');
  });

  // REQ-MEM-002 AC3: boundary - 14 real prompts is < 15 threshold -> silent, no .vars
  it('does NOT trigger when 14 new real prompts (boundary, delta < 15)', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.counterDir, 'sess-b'), '0\n0\n');
    const lines = [];
    for (let i = 0; i < 14; i++) lines.push(realUserLine(`p ${i}`));
    const t = writeTranscript(fx.home, lines);
    const r = runHook(fx, { transcriptPath: t, sessionId: 'sess-b' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', '14 prompts must not trigger capture');
    assert.equal(
      existsSync(join(fx.counterDir, 'sess-b.vars')),
      false,
    );
  });

  // REQ-MEM-002 AC5: counter updated BEFORE emitting; subsequent invocations within window silent
  it('counter advances on capture so the next run starts a fresh window', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.counterDir, 'sess-x'), '0\n0\n');
    const lines = [];
    for (let i = 0; i < 16; i++) lines.push(realUserLine(`p ${i}`));
    const t = writeTranscript(fx.home, lines);
    runHook(fx, { transcriptPath: t, sessionId: 'sess-x' });
    const counter = readFileSync(
      join(fx.counterDir, 'sess-x'),
      'utf-8',
    ).trim().split('\n');
    assert.equal(counter[0], '16',
      'counter[0] must advance to CURRENT_COUNT after capture');
    const r2 = runHook(fx, { transcriptPath: t, sessionId: 'sess-x' });
    assert.equal(r2.stdout, '',
      'after capture, repeat invocations on same transcript must be silent');
  });
});

// REQ-MEM-002 (path handling: tilde expansion for cross-environment robustness)
describe('memory-capture.sh - tilde expansion', () => {
  it('expands ~ in transcript_path to $HOME', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.counterDir, 'sess-tilde'), '0\n0\n');
    const realPath = join(fx.home, 'transcript.jsonl');
    writeFileSync(realPath, realUserLine('hi') + '\n');
    const r = runHook(fx, {
      transcriptPath: '~/transcript.jsonl',
      sessionId: 'sess-tilde',
    });
    assert.equal(r.status, 0,
      'tilde-prefixed path must resolve to a real file (no error)');
  });
});

// REQ-MEM-001 AC1 (hook is registered as UserPromptSubmit; output must conform to that protocol)
describe('memory-capture.sh - output protocol', () => {
  it('output is valid UserPromptSubmit JSON, never Stop-hook decision/block', () => {
    const fx = makeFixture();
    const t = writeTranscript(fx.home, [realUserLine('first message')]);
    const r = runHook(fx, { transcriptPath: t, sessionId: 'sess-p' });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.equal(out.decision, undefined,
      'UserPromptSubmit hook must not emit decision field');
  });
});
