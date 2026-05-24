// Real behavioral tests for the no-local-builds PreToolUse hook.
//
// Spawns the actual bash script with stdin payloads representing the
// tool invocations Claude Code would send. Asserts on exit code +
// stdout: a blocked invocation emits `{decision: "block", reason: ...}`
// on stdout; a passing invocation exits 0 silently.
//
// Each test uses an isolated bypass sentinel path so a real
// /tmp/local-build-bypass cannot bleed between tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-hooks/scripts/block-local-builds.sh',
);

function tempBypass() {
  // Per-test sentinel path; pass to the hook via LOCAL_BUILD_BYPASS_FILE
  // so tests cannot accidentally consume a real /tmp/local-build-bypass.
  return join(mkdtempSync(join(tmpdir(), 'block-local-')), 'bypass');
}

function runHook(payload, { bypassFile } = {}) {
  const env = { ...process.env };
  if (bypassFile) env.LOCAL_BUILD_BYPASS_FILE = bypassFile;
  return spawnSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env,
  });
}

function bashInvocation(command) {
  return { tool_name: 'Bash', tool_input: { command } };
}

function ctxExecuteShell(code) {
  return {
    tool_name: 'mcp__context-mode__ctx_execute',
    tool_input: { language: 'shell', code },
  };
}

function ctxExecuteJs(code) {
  return {
    tool_name: 'mcp__context-mode__ctx_execute',
    tool_input: { language: 'javascript', code },
  };
}

function ctxBatchShell(commands) {
  return {
    tool_name: 'mcp__context-mode__ctx_batch_execute',
    tool_input: { commands: commands.map((c) => ({ command: c })) },
  };
}

describe('block-local-builds.sh — Bash matcher', () => {
  it('blocks `npm test`', () => {
    const r = runHook(bashInvocation('npm test'), { bypassFile: tempBypass() });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
    assert.match(r.stdout, /GO FUCK YOURSELF/);
  });

  it('blocks `npm run test`', () => {
    const r = runHook(bashInvocation('npm run test'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks `npm run build`', () => {
    const r = runHook(bashInvocation('npm run build'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks `npm run dev`', () => {
    const r = runHook(bashInvocation('npm run dev'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks `npm run typecheck`', () => {
    const r = runHook(bashInvocation('npm run typecheck'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks `npm run lint`', () => {
    const r = runHook(bashInvocation('npm run lint'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks `npx vitest`', () => {
    const r = runHook(bashInvocation('npx vitest run'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks `npx tsc --noEmit`', () => {
    const r = runHook(bashInvocation('npx tsc --noEmit'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  // Regression: a previous version of the npx pattern used `[^\n]*` to
  // match intermediate flags. Inside a POSIX bracket expression `\n` is
  // literal backslash + `n`, not the newline escape, so any flag
  // containing the letter `n` (`--no-install`, `--include-node`, etc.)
  // bypassed the block. These tests pin the fix so a future refactor
  // cannot reintroduce the same regex bug.
  it('blocks `npx --no-install vitest` (flag contains the letter n)', () => {
    const r = runHook(bashInvocation('npx --no-install vitest run'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/,
      'regression: [^\\n]* used to silently fail on n-containing flags');
  });

  it('blocks `npx --include-node tsc` (flag contains the letter n)', () => {
    const r = runHook(bashInvocation('npx --include-node tsc'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks `npx --node-options=--inspect jest`', () => {
    const r = runHook(bashInvocation('npx --node-options=--inspect jest'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks `npx -y oxlint@1.66.0` (versioned tool with version suffix)', () => {
    const r = runHook(bashInvocation('npx -y oxlint@1.66.0 src/'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks `npx -p some-pkg vitest` (-p flag with package arg)', () => {
    const r = runHook(bashInvocation('npx -p some-pkg vitest'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks `npx --prefer-online wrangler dev`', () => {
    const r = runHook(bashInvocation('npx --prefer-online wrangler dev'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks bare `tsc`', () => {
    const r = runHook(bashInvocation('tsc'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks `vitest run`', () => {
    const r = runHook(bashInvocation('vitest run'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks `node --test path/to/file.test.js`', () => {
    const r = runHook(
      bashInvocation('node --test host/__tests__/something.test.js'),
      { bypassFile: tempBypass() }
    );
    assert.match(r.stdout, /"decision"\s*:\s*"block"/,
      'node --test is exactly the violation that motivated this hook');
  });

  it('blocks `oxlint src/`', () => {
    const r = runHook(bashInvocation('oxlint src/ --deny-warnings'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks `wrangler dev`', () => {
    const r = runHook(bashInvocation('wrangler dev'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks `wrangler deploy`', () => {
    const r = runHook(bashInvocation('wrangler deploy'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks `npm test` on its own line within a multi-line script', () => {
    // The line-start anchor catches multi-line scripts where the build
    // command lives on its own line — the common shape for local-run
    // attempts via ctx_execute (heredoc-style payloads).
    const r = runHook(
      bashInvocation('cd /home/user/workspace/codeflare\nnpm test'),
      { bypassFile: tempBypass() }
    );
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });
});

describe('block-local-builds.sh — accepted misses (documented)', () => {
  // The line-start anchor accepts two known false-negatives in exchange
  // for eliminating false positives. These tests pin those misses so a
  // future refactor that tightens the anchor (e.g. real shell parsing)
  // can flip them to `block` deliberately and consciously.
  it('does NOT catch same-line chained `git add && npm test` (anchor accepts the miss)', () => {
    const r = runHook(bashInvocation('git add . && npm test'), { bypassFile: tempBypass() });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '',
      'documented miss: regex cannot tell a real chain from `echo "&& npm test"`');
  });

  it('does NOT catch `bash -c "npm test"` wrapper (anchor accepts the miss)', () => {
    const r = runHook(bashInvocation('bash -c "npm test"'), { bypassFile: tempBypass() });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '',
      'documented miss: the inner build is inside a string after -c, not at line start');
  });
});

describe('block-local-builds.sh — false-positive guards', () => {
  it('does NOT block `git push`', () => {
    const r = runHook(bashInvocation('git push origin develop'), { bypassFile: tempBypass() });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('does NOT block `gh pr create`', () => {
    const r = runHook(
      bashInvocation('gh pr create --title "fix: x" --body "y"'),
      { bypassFile: tempBypass() }
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('does NOT block `ls src/`', () => {
    const r = runHook(bashInvocation('ls src/'), { bypassFile: tempBypass() });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('does NOT block a variable name containing "tsc"', () => {
    // The pattern uses word boundaries; a variable like `tsc_output`
    // or `latest_tsc_version` must not falsely trigger.
    const r = runHook(
      bashInvocation('echo $tsc_output && grep latest_tsc_version file.txt'),
      { bypassFile: tempBypass() }
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('does NOT block a path containing "vitest" (e.g. node_modules/vitest)', () => {
    // Touching a file path is fine; running the binary is not.
    const r = runHook(
      bashInvocation('cat node_modules/vitest/package.json'),
      { bypassFile: tempBypass() }
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('does NOT block a comment-only line mentioning "tsc"', () => {
    const r = runHook(
      bashInvocation('# typecheck via tsc has been my CI failure'),
      { bypassFile: tempBypass() }
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('does NOT block a line with a trailing comment mentioning "tsc"', () => {
    const r = runHook(
      bashInvocation('ls foo # via tsc'),
      { bypassFile: tempBypass() }
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('does NOT block `echo "the command was tsc"`', () => {
    // The build-tool name appears inside an echo argument, NOT at the
    // start of a command. The line-start anchor lets this through.
    const r = runHook(
      bashInvocation('echo "the command was tsc"'),
      { bypassFile: tempBypass() }
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('does NOT block JavaScript ctx_execute mentioning "npm test" in a string', () => {
    // The language guard skips non-shell ctx_execute payloads. A JS
    // analysis script that mentions "npm test" in a string literal
    // must not falsely trigger.
    const r = runHook(
      ctxExecuteJs('console.log("the test command is npm test");'),
      { bypassFile: tempBypass() }
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('block-local-builds.sh — MCP shell-tool matchers', () => {
  it('blocks ctx_execute(language=shell) running `npm test`', () => {
    const r = runHook(ctxExecuteShell('npm test'), { bypassFile: tempBypass() });
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks ctx_execute(language=shell) chained pipeline with vitest', () => {
    const r = runHook(
      ctxExecuteShell('cd /home/user/workspace/codeflare && npx vitest run'),
      { bypassFile: tempBypass() }
    );
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks ctx_batch_execute when ANY command in the batch is a build/test', () => {
    const r = runHook(
      ctxBatchShell(['echo hi', 'git status', 'npm run build']),
      { bypassFile: tempBypass() }
    );
    assert.match(r.stdout, /"decision"\s*:\s*"block"/,
      'a batch must not smuggle a build past the hook by hiding it among innocent commands');
  });

  it('passes ctx_batch_execute with only safe commands', () => {
    const r = runHook(
      ctxBatchShell(['echo hi', 'git status', 'ls -la']),
      { bypassFile: tempBypass() }
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('block-local-builds.sh — bypass sentinel', () => {
  it('one-shot bypass: sentinel file allows ONE invocation then is deleted', () => {
    const bypass = tempBypass();
    writeFileSync(bypass, 'bypass\n');
    // First call: sentinel consumed, hook lets through.
    const r1 = runHook(bashInvocation('npm test'), { bypassFile: bypass });
    assert.equal(r1.status, 0);
    assert.equal(r1.stdout, '', 'sentinel must allow the first invocation through');
    // Second call (same payload): sentinel is gone, hook blocks again.
    const r2 = runHook(bashInvocation('npm test'), { bypassFile: bypass });
    assert.match(r2.stdout, /"decision"\s*:\s*"block"/,
      'sentinel must be consumed (one-shot) — second invocation must block');
  });
});

describe('block-local-builds.sh — schema-shape resilience', () => {
  it('exits 0 silently when tool_name is unknown', () => {
    const r = runHook({ tool_name: 'SomeOtherTool', tool_input: {} }, { bypassFile: tempBypass() });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('exits 0 silently when stdin is empty', () => {
    const r = spawnSync('bash', [HOOK], {
      input: '',
      encoding: 'utf-8',
      env: { ...process.env, LOCAL_BUILD_BYPASS_FILE: tempBypass() },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});
