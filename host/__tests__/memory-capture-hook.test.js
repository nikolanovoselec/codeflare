// Real behavioral tests for the UserPromptSubmit memory-capture hook.
//
// Spawns the actual bash script with stdin JSON and asserts on exit code,
// stdout, and side-effect files. Each test uses a fresh temp $HOME AND a
// fresh MEMCAP_COUNTER_DIR override so counter / lock files don't bleed
// between tests. The MEMCAP_COUNTER_DIR override is the production-script's
// only test-injection point; production never sets it (defaults to /tmp).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync, chmodSync, symlinkSync, unlinkSync,
} from 'node:fs';
import { tempDir } from './helpers/temp-dirs.js';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh',
);
const VAULT_MANIFEST = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-vault/scripts/vault-manifest.py',
);

function makeFixture() {
  const home = tempDir('memcap-home-');
  const counterDir = tempDir('memcap-counter-');
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

function installVaultManifest(fx) {
  const scripts = join(fx.home, '.claude', 'plugins', 'codeflare-vault', 'scripts');
  mkdirSync(scripts, { recursive: true });
  copyFileSync(VAULT_MANIFEST, join(scripts, 'vault-manifest.py'));
  mkdirSync(join(fx.home, 'Vault', 'Notes'), { recursive: true });
  mkdirSync(join(fx.home, 'Vault', 'graphify-out'), { recursive: true });
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
describe('memory-capture.sh - input gating / REQ-MEM-002 (capture triggers every 20 user messages)', () => {
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
    // AC7 first contract: capture fires despite delta < 20
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
    // Capture directive also present, evidenced by the armed request rather
    // than by matching the directive's wording back to itself.
    assert.equal(v.attempts, 1, 'AC7: the resume capture must be armed for delivery');
    assert.match(v.capture_file, /\/Vault\/Raw\/Sessions\/.+\.md$/);
    // The counter must NOT advance here. It used to, which meant a resume
    // capture that then failed silently discarded the entire prior session's
    // tail — the exact window AC7 exists to rescue.
    assert.equal(existsSync(join(fx.counterDir, 'sess-resume')), false,
      'AC7: arming must not commit the window; publish-memory-capture.sh does that');
  });

  it('resume hash-checks Vault and arms extraction only when content changed', () => {
    const fx = makeFixture();
    installVaultManifest(fx);
    writeFileSync(join(fx.home, 'Vault', 'Notes', 'resume.md'), 'changed while away\n');
    const t = writeTranscript(fx.home, [realUserLine('prior'), realUserLine('resumed')]);

    const r = runHook(fx, { transcriptPath: t, sessionId: 'sess-resume-vault' });

    assert.equal(r.status, 0);
    assert.equal(existsSync(join(fx.home, '.cache', 'codeflare-hooks', 'vault-extract.vars')), true);
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
  });
});

// REQ-MEM-002 AC3/AC4/AC5 (delta logic: <20 silent, >=20 fires, counter advances)
describe('memory-capture.sh - user-message counting', () => {
  it('hash-checks Vault at prompt 20 without starting memory capture early', () => {
    const fx = makeFixture();
    installVaultManifest(fx);
    writeFileSync(join(fx.home, 'Vault', 'Notes', 'prompt-20.md'), 'changed\n');
    writeFileSync(join(fx.counterDir, 'sess-vault-20'), '19\n1\n');
    writeFileSync(join(fx.counterDir, 'sess-vault-20.vault-count'), '0\n');
    const lines = Array.from({ length: 20 }, (_, index) => realUserLine(`prompt ${index + 1}`));
    const t = writeTranscript(fx.home, lines);

    const r = runHook(fx, { transcriptPath: t, sessionId: 'sess-vault-20' });

    assert.equal(r.status, 0);
    assert.equal(existsSync(join(fx.counterDir, 'sess-vault-20.vars')), false);
    assert.equal(existsSync(join(fx.home, '.cache', 'codeflare-hooks', 'vault-extract.vars')), true);
    assert.equal(readFileSync(join(fx.counterDir, 'sess-vault-20.vault-count'), 'utf-8'), '20\n');
  });

  it('advances the Vault check counter when a successful scan finds no changes', () => {
    const fx = makeFixture();
    installVaultManifest(fx);
    const manifestScript = join(fx.home, '.claude', 'plugins', 'codeflare-vault', 'scripts', 'vault-manifest.py');
    const manifest = join(fx.home, 'Vault', 'graphify-out', 'vault-extract-manifest.json');
    writeFileSync(join(fx.home, 'Vault', 'Notes', 'stable.md'), 'unchanged\n');
    const committed = spawnSync('python3', [manifestScript, 'commit', join(fx.home, 'Vault'), manifest]);
    assert.equal(committed.status, 0);
    writeFileSync(join(fx.counterDir, 'sess-vault-unchanged'), '19\n1\n');
    const vaultCounter = join(fx.counterDir, 'sess-vault-unchanged.vault-count');
    writeFileSync(vaultCounter, '0\n');
    const t = writeTranscript(
      fx.home,
      Array.from({ length: 20 }, (_, index) => realUserLine(`prompt ${index + 1}`)),
    );

    const result = runHook(fx, { transcriptPath: t, sessionId: 'sess-vault-unchanged' });

    assert.equal(result.status, 0);
    assert.equal(readFileSync(vaultCounter, 'utf-8'), '20\n');
    assert.equal(existsSync(join(fx.home, '.cache', 'codeflare-hooks', 'vault-extract.vars')), false);
  });

  it('retries the Vault hash check on the next prompt after a partial file-read failure', () => {
    const fx = makeFixture();
    installVaultManifest(fx);
    writeFileSync(join(fx.home, 'Vault', 'Notes', 'retry.md'), 'changed\n');
    const unreadable = join(fx.home, 'Vault', 'Notes', 'vanished.md');
    symlinkSync('missing-target.md', unreadable);
    writeFileSync(join(fx.counterDir, 'sess-vault-retry'), '19\n1\n');
    const vaultCounter = join(fx.counterDir, 'sess-vault-retry.vault-count');
    writeFileSync(vaultCounter, '0\n');
    const t = writeTranscript(
      fx.home,
      Array.from({ length: 20 }, (_, index) => realUserLine(`prompt ${index + 1}`)),
    );

    const failed = runHook(fx, { transcriptPath: t, sessionId: 'sess-vault-retry' });
    assert.equal(failed.status, 0, 'a failed background hash check must not block the prompt');
    assert.equal(readFileSync(vaultCounter, 'utf-8'), '0\n',
      'a partial scan must leave the previous successful epoch eligible');
    assert.equal(existsSync(join(fx.home, '.cache', 'codeflare-hooks', 'vault-extract.vars')), false);

    unlinkSync(unreadable);
    const retried = runHook(fx, { transcriptPath: t, sessionId: 'sess-vault-retry' });
    assert.equal(retried.status, 0);
    assert.equal(readFileSync(vaultCounter, 'utf-8'), '20\n');
    assert.equal(existsSync(join(fx.home, '.cache', 'codeflare-hooks', 'vault-extract.vars')), true);
  });

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
      'delta < 20 with existing counter must produce no output');
  });

  // REQ-MEM-002 AC4: delta>=20 -> write .vars + emit additionalContext mentioning vars path
  it('triggers capture when 20+ NEW real prompts since last_count', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.counterDir, 'sess-t'), '0\n0\n');
    const lines = [];
    for (let i = 0; i < 20; i++) lines.push(realUserLine(`prompt ${i}`));
    for (let i = 0; i < 10; i++) lines.push(toolResultLine());
    for (let i = 0; i < 5; i++) lines.push(commandWrapperLine('command-name'));
    const t = writeTranscript(fx.home, lines);
    const r = runHook(fx, { transcriptPath: t, sessionId: 'sess-t' });
    assert.equal(r.status, 0);
    const vars = join(fx.counterDir, 'sess-t.vars');
    // The carrier is the whole contract now. The hook used to name it in
    // additionalContext because the agent had to be told to spawn a capture;
    // the hook launches the subprocess itself, so it says nothing and the
    // written request is the only thing arming is observable through.
    assert.equal(existsSync(vars), true,
      'capture path must write the .vars file');
    const v = JSON.parse(readFileSync(vars, 'utf-8'));
    assert.equal(v.current_count, '20');
  });

  // REQ-MEM-002 AC3: boundary - 19 real prompts is < 20 threshold -> silent, no .vars
  it('does NOT trigger when 19 new real prompts (boundary, delta < 20)', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.counterDir, 'sess-b'), '0\n0\n');
    const lines = [];
    for (let i = 0; i < 19; i++) lines.push(realUserLine(`p ${i}`));
    const t = writeTranscript(fx.home, lines);
    const r = runHook(fx, { transcriptPath: t, sessionId: 'sess-b' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', '19 prompts must not trigger capture');
    assert.equal(
      existsSync(join(fx.counterDir, 'sess-b.vars')),
      false,
    );
  });

  // REQ-MEM-002 AC5: an outstanding request suppresses a second arm. The
  // window is not closed by arming — publish-memory-capture.sh closes it — so
  // what keeps the hook from stacking requests is the carrier, not the counter.
  it('an armed request suppresses a second arm without closing the window', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.counterDir, 'sess-x'), '0\n0\n');
    const lines = [];
    for (let i = 0; i < 21; i++) lines.push(realUserLine(`p ${i}`));
    const t = writeTranscript(fx.home, lines);
    runHook(fx, { transcriptPath: t, sessionId: 'sess-x' });
    const first = JSON.parse(readFileSync(join(fx.counterDir, 'sess-x.vars'), 'utf-8'));
    assert.equal(readFileSync(join(fx.counterDir, 'sess-x'), 'utf-8'), '0\n0\n',
      'arming must not commit the window before an artifact exists');

    runHook(fx, { transcriptPath: t, sessionId: 'sess-x' });
    const second = JSON.parse(readFileSync(join(fx.counterDir, 'sess-x.vars'), 'utf-8'));
    assert.equal(second.capture_file, first.capture_file,
      'the second fire must re-deliver the same request, not mint a new one');
    assert.equal(second.attempts, 2);
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

// Bounded re-delivery replaced the hard block (AD124). These tests pin the
// state machine: a request that is not picked up comes back, a request nobody
// ever picks up stops coming back, and no path marks a window captured before
// an artifact exists to prove it was.
describe('memory-capture.sh - bounded re-delivery and giveup / REQ-MEM-020', () => {
  function armed(fx, sessionId = 'sess-redeliver') {
    // A committed counter makes this a mid-session fixture. Without one the
    // hook reads a fresh container and prepends the graph-query directive to
    // every emission, which would mask what these tests are asserting.
    writeFileSync(join(fx.counterDir, sessionId), '0\n1\n');
    const lines = [];
    for (let i = 0; i < 21; i++) lines.push(realUserLine(`prompt ${i}`));
    const t = writeTranscript(fx.home, lines);
    const first = runHook(fx, { transcriptPath: t, sessionId });
    return { transcriptPath: t, sessionId, first };
  }

  function varsOf(fx, sessionId) {
    return JSON.parse(readFileSync(join(fx.counterDir, `${sessionId}.vars`), 'utf-8'));
  }

  it('arms a request carrying the capture path the publisher will verify', () => {
    const fx = makeFixture();
    const { sessionId, first } = armed(fx);
    assert.equal(first.status, 0);
    const vars = varsOf(fx, sessionId);
    // The filename must be decided here, not by the subagent: the publisher
    // checks this exact path, so a request without it cannot be verified.
    assert.match(vars.capture_file, /\/Vault\/Raw\/Sessions\/.+\.md$/);
    assert.ok(vars.capture_file.includes(vars.capture_timestamp),
      'capture_file must embed capture_timestamp so the two cannot drift');
    assert.ok(vars.capture_file.endsWith(`${sessionId.slice(0, 8)}.md`));
    assert.equal(vars.attempts, 1);
  });

  it('takes the capture timestamp from the helper rather than computing its own', () => {
    // The helper owns the USER_TIMEZONE -> TZ -> /etc/timezone -> UTC chain.
    // An inline `date` in the hook differs from it only when both env vars are
    // unset, so any env-driven test goes green on a UTC host no matter which
    // implementation is present. Shadowing the helper removes the host from the
    // question: the hook resolves it next to itself, so a stub with a sentinel
    // proves delegation on every machine and fails the moment anyone inlines.
    const fx = makeFixture();
    const shadowDir = tempDir('memcap-shadow-');
    copyFileSync(HOOK, join(shadowDir, 'memory-capture.sh'));
    writeFileSync(
      join(shadowDir, 'assert-iso-ts.sh'),
      "#!/usr/bin/env bash\necho 'ISO_TS=1999-12-31T23-59-59-1234'\necho 'RESOLVED_TZ=Sentinel/Zone'\n",
    );
    writeFileSync(join(fx.counterDir, 'sess-stub'), '0\n1\n');
    const lines = [];
    for (let i = 0; i < 21; i++) lines.push(realUserLine(`p ${i}`));
    const t = writeTranscript(fx.home, lines);
    const res = spawnSync('bash', [join(shadowDir, 'memory-capture.sh')], {
      input: JSON.stringify({ transcript_path: t, session_id: 'sess-stub' }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: fx.home, MEMCAP_COUNTER_DIR: fx.counterDir },
    });
    assert.equal(res.status, 0);
    const vars = JSON.parse(readFileSync(join(fx.counterDir, 'sess-stub.vars'), 'utf-8'));
    assert.equal(vars.capture_timestamp, '1999-12-31T23-59-59-1234',
      'the hook must use the helper\'s value verbatim, not derive a timestamp');
    assert.ok(vars.capture_file.endsWith('1999-12-31T23-59-59-1234-sess-stu.md'));
    // Delegation is only worth anything if the thing delegated to still ships:
    // the stub proves the hook calls its sibling, not that the sibling exists.
    assert.equal(existsSync(join(dirname(HOOK), 'assert-iso-ts.sh')), true,
      'the real helper must ship beside the hook, or production timestamping breaks while this stays green');
  });

  it('arms nothing and says why when the timestamp helper fails its assertions', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.counterDir, 'sess-bad'), '0\n1\n');
    const lines = [];
    for (let i = 0; i < 21; i++) lines.push(realUserLine(`p ${i}`));
    const t = writeTranscript(fx.home, lines);
    const res = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ transcript_path: t, session_id: 'sess-bad' }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fx.home,
        MEMCAP_COUNTER_DIR: fx.counterDir,
        ASSERT_ISO_TS_OVERRIDE: 'garbage',
      },
    });
    assert.equal(res.status, 0, 'the hook must not abort the prompt');
    assert.equal(existsSync(join(fx.counterDir, 'sess-bad.vars')), false,
      'a request must never be armed with an untrustworthy timestamp');
    assert.notEqual(res.stderr.trim(), '',
      'failing closed silently is indistinguishable from the hook not running');
  });

  it('latches when the delivery count cannot be recorded', () => {
    const fx = makeFixture();
    const { transcriptPath, sessionId } = armed(fx, 'sess-latch');
    // A carrier that is not valid JSON makes the jq rewrite fail, which is the
    // same branch an unwritable counter dir takes. Corrupting the file works
    // as root; chmod does not.
    writeFileSync(join(fx.counterDir, `${sessionId}.vars`), 'not json');
    runHook(fx, { transcriptPath, sessionId });
    assert.equal(existsSync(join(fx.counterDir, `${sessionId}.latched`)), true,
      'an uncountable delivery must latch, or it re-delivers forever');
  });

  it('drops the request when it can neither count the delivery nor latch', () => {
    const fx = makeFixture();
    const { transcriptPath, sessionId } = armed(fx, 'sess-drop');
    writeFileSync(join(fx.counterDir, `${sessionId}.vars`), 'not json');
    // A directory cannot be overwritten by a redirect, even by root, so this
    // defeats the latch write the way a full or unwritable dir would.
    mkdirSync(join(fx.counterDir, `${sessionId}.latched`), { recursive: true });
    runHook(fx, { transcriptPath, sessionId });
    assert.equal(existsSync(join(fx.counterDir, `${sessionId}.vars`)), false,
      'losing one window beats an unbounded reminder loop');
  });

  it('does not advance the counter when arming, so a failed capture is retried not lost', () => {
    const fx = makeFixture();
    const { sessionId } = armed(fx);
    // The old hook wrote the counter here. If that write comes back, the
    // window is marked captured before any capture file exists and those
    // messages are never revisited.
    assert.equal(readFileSync(join(fx.counterDir, sessionId), 'utf-8'), '0\n1\n',
      'arming must leave the counter uncommitted; publish-memory-capture.sh owns it');
  });

  it('never advances the counter across the whole give-up path', () => {
    const fx = makeFixture();
    const { transcriptPath, sessionId } = armed(fx);
    for (let i = 0; i < 8; i++) runHook(fx, { transcriptPath, sessionId });
    assert.equal(readFileSync(join(fx.counterDir, sessionId), 'utf-8'), '0\n1\n',
      'a window nobody captured must stay uncommitted so a later request re-covers it');
  });

  it('re-delivers an outstanding request on the next prompt instead of dropping it', () => {
    const fx = makeFixture();
    const { transcriptPath, sessionId } = armed(fx);
    const second = runHook(fx, { transcriptPath, sessionId });
    assert.equal(second.status, 0);
    // The relaunch is observable in the request's own attempt count. The
    // hook's stdout is not the evidence here: it still carries the graph-scan
    // context, which says nothing about whether a launch happened.
    assert.equal(varsOf(fx, sessionId).attempts, 2,
      'each launch must be counted, or the giveup latch can never be reached');
  });

  // The probe has three outcomes and only one of them may mean "running".
  // Opening and locking in one subshell made "could not open" indistinguishable
  // from "held", and the `!` turned the former into "running" -- which never
  // latches and never relaunches.
  for (const [state, setup, expected] of [
    ['no lock file', () => {}, 1],
    ['lock free', (lock) => writeFileSync(lock, ''), 1],
    ['lock unopenable', (lock) => { writeFileSync(lock, ''); chmodSync(lock, 0o000); }, 1],
  ]) {
    it(`capture_running reports not-running when the ${state}`, (t) => {
      if (state === 'lock unopenable' && process.getuid?.() === 0) {
        return t.skip('root ignores file modes; fixture would be vacuous');
      }
      const dir = tempDir('probe-');
      const vars = join(dir, 's.vars');
      setup(`${vars}.lock`);
      // Reformatting memory-capture.sh would make this range match nothing.
      // That does not pass silently -- an unsourced function exits 127, not the
      // 1 these rows expect -- but 127 says nothing about why, so the
      // extraction is checked here where the reason is still obvious.
      const extracted = spawnSync('sed', ['-n', '/^capture_running()/,/^}/p', HOOK], {
        encoding: 'utf-8',
      }).stdout;
      assert.match(extracted, /^capture_running\(\)/,
        'the probe must be extractable from the hook, or this row tests nothing');

      const r = spawnSync('bash', ['-c',
        `source <(sed -n '/^capture_running()/,/^}/p' "${HOOK}"); capture_running "${vars}"`,
      ], { encoding: 'utf-8' });
      assert.equal(r.status, expected, `${state} must not read as running`);
    });
  }

  it('spends no attempt on a prompt that arrives while a capture is running', () => {
    const fx = makeFixture();
    const { transcriptPath, sessionId } = armed(fx);
    const vars = join(fx.counterDir, `${sessionId}.vars`);
    const before = varsOf(fx, sessionId).attempts;
    // Hold the carrier lock the way a live capture does, and wait until it is
    // actually held rather than sleeping a guessed interval.
    const holder = spawn('bash', ['-c', `exec 9>"${vars}.lock"; flock 9; sleep 30`], {
      detached: true, stdio: 'ignore',
    });
    holder.unref();
    try {
      let held = false;
      for (let i = 0; i < 100 && !held; i++) {
        held = spawnSync('bash', ['-c', `exec 9>"${vars}.lock"; flock -n 9`]).status !== 0;
        if (!held) spawnSync('bash', ['-c', 'sleep 0.05']);
      }
      assert.ok(held, 'the holder took the lock');
      runHook(fx, { transcriptPath, sessionId });
      // Counting prompts rather than launches is what let six messages typed
      // during one long capture latch a request that was working, after which
      // the re-arm deleted the carrier out from under it.
      assert.equal(varsOf(fx, sessionId).attempts, before,
        'a running capture is not a failed launch');
    } finally {
      // detached:true already makes the child a session leader, so its pid IS
      // the group. Wrapping it in setsid(1) made this kill throw ESRCH.
      try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('latches after the sixth delivery and stops reminding', () => {
    const fx = makeFixture();
    const { transcriptPath, sessionId } = armed(fx);
    const latch = join(fx.counterDir, `${sessionId}.latched`);
    // Deliveries 2..6 keep incrementing and leave no latch.
    for (let i = 0; i < 5; i++) runHook(fx, { transcriptPath, sessionId });
    assert.equal(varsOf(fx, sessionId).attempts, 6);
    assert.equal(existsSync(latch), false, 'must not latch while deliveries remain');

    // The seventh fire is the giveup: it latches and stops counting, which is
    // what separates giving up from delivering once more.
    runHook(fx, { transcriptPath, sessionId });
    assert.equal(existsSync(latch), true);
    assert.equal(varsOf(fx, sessionId).attempts, 6,
      'giving up must not consume another delivery');

    // Latched means silent, not merely quieter.
    const after = runHook(fx, { transcriptPath, sessionId });
    assert.equal(after.stdout, '');
  });

});

// The counter moved out of the hook and into the publisher, behind an artifact
// check. These two tests are the reason that is safe: a capture that produced
// no file must not be able to mark its window covered.
describe('publish-memory-capture.sh - artifact-gated commit / REQ-MEM-020', () => {
  const PUBLISH = resolve(
    __dirname,
    '../../preseed/agents/claude/plugins/codeflare-memory/scripts/publish-memory-capture.sh',
  );

  function setup() {
    const dir = tempDir('memcap-pub-');
    const counterFile = join(dir, 'sess-pub');
    const varsFile = join(dir, 'sess-pub.vars');
    const captureFile = join(dir, 'capture.md');
    writeFileSync(counterFile, '3\n9\n');
    writeFileSync(varsFile, JSON.stringify({
      capture_file: captureFile,
      counter_file: counterFile,
      current_count: '16',
      total_lines: '400',
    }));
    return { dir, counterFile, varsFile, captureFile };
  }

  function publish(fx) {
    return spawnSync('bash', [PUBLISH, fx.varsFile], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        MEMCAP_GRAPH_LOCK: join(fx.dir, 'lock'),
        MEMCAP_PYTHON_BIN: '/bin/true',
        MEMCAP_MERGE_SCRIPT: 'ignored',
        MEMCAP_GRAPHIFY_BIN: '/bin/true',
        MEMCAP_VAULT_GRAPH: 'ignored',
      },
    });
  }

  it('refuses to publish and keeps the carrier when the capture file is absent', () => {
    const fx = setup();
    const r = publish(fx);
    assert.notEqual(r.status, 0, 'a capture with no artifact must not report success');
    assert.equal(readFileSync(fx.counterFile, 'utf-8'), '3\n9\n',
      'a refused publication must leave the window uncommitted');
    assert.equal(existsSync(fx.varsFile), true,
      'the carrier must survive so the hook re-delivers the request');
  });

  it('commits the counter and drains the carrier once the artifact exists', () => {
    const fx = setup();
    writeFileSync(fx.captureFile, '# capture\n');
    const r = publish(fx);
    assert.equal(r.status, 0);
    assert.equal(readFileSync(fx.counterFile, 'utf-8'), '16\n400\n');
    assert.equal(existsSync(fx.varsFile), false);
  });

  it('never drags the committed counter backwards', () => {
    const fx = setup();
    // A stale request publishing late: its window is older than what is
    // already committed, so committing it would re-capture old messages.
    writeFileSync(fx.counterFile, '40\n900\n');
    writeFileSync(fx.captureFile, '# capture\n');
    const r = publish(fx);
    assert.equal(r.status, 0);
    assert.equal(readFileSync(fx.counterFile, 'utf-8'), '40\n900\n');
  });
});

// A capture runs as a detached subprocess and asks nothing of the agent, so
// until now the only trace a user had that one had started -- or had been
// retrying all session -- was the file appearing in the vault much later.
// systemMessage is the one hook field the client renders straight to the
// terminal, and these rows pin that it carries the live attempt number: a
// static "capture started" would pass a substring match while hiding the run
// of retries that is the whole reason the attempt bound exists.
describe('memory-capture.sh - user-visible capture notice', () => {
  function armedAt(fx, sessionId) {
    // Committed counter => mid-session, so MEMORY_SCAN is empty and the notice
    // is the ONLY thing on stdout. That is deliberate: it proves the notice
    // does not ride along on the graph-scan context that used to gate it.
    writeFileSync(join(fx.counterDir, sessionId), '0\n1\n');
    const lines = [];
    for (let i = 0; i < 21; i++) lines.push(realUserLine(`prompt ${i}`));
    return writeTranscript(fx.home, lines);
  }

  it('names the first launch and the file the capture will write', () => {
    const fx = makeFixture();
    const t = armedAt(fx, 'sess-notice');
    const r = runHook(fx, { transcriptPath: t, sessionId: 'sess-notice' });
    const out = JSON.parse(r.stdout);
    assert.match(out.systemMessage, /Memory capture started \(attempt 1\/6\)/);
    assert.equal(out.hookSpecificOutput, undefined,
      'a mid-session arm has nothing to tell the model; the notice is for the user alone');
    const vars = JSON.parse(readFileSync(join(fx.counterDir, 'sess-notice.vars'), 'utf-8'));
    assert.ok(out.systemMessage.endsWith(vars.capture_file.split('/').pop()),
      'the notice must name the artifact the publisher will look for');
  });

  it('counts the retry it is announcing', () => {
    const fx = makeFixture();
    const t = armedAt(fx, 'sess-retry');
    runHook(fx, { transcriptPath: t, sessionId: 'sess-retry' });
    const second = runHook(fx, { transcriptPath: t, sessionId: 'sess-retry' });
    const out = JSON.parse(second.stdout);
    assert.match(out.systemMessage, /Memory capture retrying \(attempt 2\/6\)/,
      'the number must track the request, or six retries look like one launch');
  });

  it('says so when the request is abandoned', () => {
    const fx = makeFixture();
    const t = armedAt(fx, 'sess-giveup');
    // Arm, then exhaust the delivery budget: attempts 1..6, then the giveup.
    for (let i = 0; i < 6; i++) runHook(fx, { transcriptPath: t, sessionId: 'sess-giveup' });
    const giveup = runHook(fx, { transcriptPath: t, sessionId: 'sess-giveup' });
    assert.equal(existsSync(join(fx.counterDir, 'sess-giveup.latched')), true,
      'this row must be reading the giveup fire, not one more delivery');
    assert.match(JSON.parse(giveup.stdout).systemMessage, /gave up after 6 attempts/,
      'a request that stopped retrying must not go quiet without saying so');
  });
});
