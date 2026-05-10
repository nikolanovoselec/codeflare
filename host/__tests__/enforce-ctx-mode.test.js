// Real behavioral tests for the context-mode enforcement PreToolUse hook.
//
// Spawns the actual bash script with stdin input and asserts on exit
// code + stdout. Each test uses an isolated /tmp/ctx-bypass file path
// so bypass-sentinel tests don't bleed between cases.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/context-mode/scripts/enforce-ctx-mode.sh',
);
const BYPASS = '/tmp/ctx-bypass';

function runHook(input) {
  return spawnSync('bash', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
  });
}

function deniedReason(result) {
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  return parsed.hookSpecificOutput.permissionDecisionReason;
}

function assertAllowed(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
}

beforeEach(() => {
  if (existsSync(BYPASS)) unlinkSync(BYPASS);
});

afterEach(() => {
  if (existsSync(BYPASS)) unlinkSync(BYPASS);
});

describe('enforce-ctx-mode hook', () => {
  describe('Bash whitelist', () => {
    for (const cmd of ['git status', 'git push origin HEAD', 'mkdir -p /tmp/foo', 'rm -rf /tmp/foo', 'mv a b', 'cd /tmp', 'ls -la']) {
      it(`allows: ${cmd}`, () => {
        const r = runHook({ tool_name: 'Bash', tool_input: { command: cmd } });
        assertAllowed(r);
      });
    }

    it('allows npm install', () => {
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: 'npm install foo' } }));
    });

    it('allows npm i', () => {
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: 'npm i' } }));
    });

    it('allows npm ci', () => {
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: 'npm ci' } }));
    });

    it('allows pip install', () => {
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: 'pip install pytest' } }));
    });

    it('allows pip3 install', () => {
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: 'pip3 install pytest' } }));
    });

    it('allows multi-line git add with backslash continuations', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git add foo \\\n  bar \\\n  baz' },
      }));
    });

    it('allows multi-line git commit -F via heredoc', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: "git commit -m \"$(cat <<'EOF'\nline1\nline2\nEOF\n)\"" },
      }));
    });
  });

  describe('Bash denials', () => {
    it('denies tail', () => {
      const reason = deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'tail -30 /tmp/foo' } }));
      assert.match(reason, /'tail' violates/);
      assert.match(reason, /ctx_execute|ctx_batch_execute/);
    });

    it('denies cat', () => {
      assert.match(deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'cat /etc/passwd' } })), /'cat' violates/);
    });

    it('denies echo', () => {
      assert.match(deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'echo hi' } })), /'echo' violates/);
    });

    it('denies grep (the shell command, separate from Grep tool)', () => {
      assert.match(deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'grep foo bar.txt' } })), /'grep' violates/);
    });

    it('denies find', () => {
      assert.match(deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'find . -name "*.ts"' } })), /'find' violates/);
    });

    it('denies sed', () => {
      assert.match(deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'sed -i s/a/b/ foo' } })), /'sed' violates/);
    });

    it('denies gh (not in upstream whitelist)', () => {
      assert.match(deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'gh pr view 123' } })), /'gh' violates/);
    });

    it('denies npm run', () => {
      const reason = deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'npm run test' } }));
      assert.match(reason, /npm 'run' violates/);
    });

    it('denies pip uninstall', () => {
      assert.match(deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'pip uninstall pytest' } })), /pip 'uninstall' violates/);
    });
  });

  describe('chain bypass closed via per-segment scan', () => {
    it('denies cd && tail x (tail is not whitelisted)', () => {
      assert.match(deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'cd /tmp && tail x' } })), /'tail' violates/);
    });

    it('denies cd; tail x (semicolon chain)', () => {
      assert.match(deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'cd /tmp; tail x' } })), /'tail' violates/);
    });

    it('denies git log | head (pipe to non-whitelisted)', () => {
      assert.match(deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'git log | head' } })), /'head' violates/);
    });

    it('denies git log | tail', () => {
      assert.match(deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'git log | tail' } })), /'tail' violates/);
    });

    it('denies git log && curl x (curl chained)', () => {
      assert.match(deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'git log && curl https://example.com' } })), /'curl' violates/);
    });

    it('allows chained whitelist-only: cd; ls; cd; ls', () => {
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: 'cd /tmp; ls; cd /; ls' } }));
    });
  });

  describe('network commands (bare and chained)', () => {
    it('denies bare curl with ctx_fetch_and_index hint', () => {
      const reason = deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'curl https://example.com' } }));
      assert.match(reason, /'curl' violates/);
      assert.match(reason, /ctx_fetch_and_index/);
    });

    it('denies bare wget with ctx_fetch_and_index hint', () => {
      const reason = deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'wget https://example.com' } }));
      assert.match(reason, /'wget' violates/);
      assert.match(reason, /ctx_fetch_and_index/);
    });

    it('denies chained curl: git log && curl x, with ctx_fetch_and_index hint', () => {
      const reason = deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'git log && curl https://x' } }));
      assert.match(reason, /'curl' violates/);
      assert.match(reason, /ctx_fetch_and_index/);
    });

    it('does NOT confuse curlfile (substring) with curl', () => {
      const reason = deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'curlfile abc' } }));
      assert.match(reason, /'curlfile' violates/);
    });
  });

  describe('interpreter inline calls', () => {
    it('denies node -e fetch (node not whitelisted)', () => {
      assert.match(
        deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'node -e "fetch(\'https://example.com\')"' } })),
        /'node' violates/,
      );
    });

    it('denies python3 -c (python3 not whitelisted)', () => {
      assert.match(
        deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'python3 -c "import requests; requests.get(\'x\')"' } })),
        /'python3' violates/,
      );
    });
  });

  describe('false-positive fixes', () => {
    it('allows commit message containing the word curl', () => {
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: 'git commit -m "see curl docs"' } }));
    });

    it('allows env-var prefix: FOO=bar git log', () => {
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: 'FOO=bar git log' } }));
    });

    it('allows multiple env-var prefixes: A=1 B=2 git log', () => {
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: 'A=1 B=2 git log' } }));
    });

    it('allows subshell parens: (git log)', () => {
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: '(git log)' } }));
    });

    it('allows whitespace-only command silently', () => {
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: '   ' } }));
    });
  });

  describe('heredoc fallback', () => {
    it('allows git commit with heredoc body containing && (no false-split)', () => {
      const cmd = 'git commit -m "$(cat <<EOF\nuse && for chaining\nand || for fallback\nEOF\n)"';
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: cmd } }));
    });

    it('allows git commit with quoted-delimiter heredoc', () => {
      const cmd = "git commit -m \"$(cat <<'EOF'\nuse && for chaining\nEOF\n)\"";
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: cmd } }));
    });
  });

  describe('tool-level blocks', () => {
    it('blocks WebFetch', () => {
      const reason = deniedReason(runHook({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }));
      assert.match(reason, /WebFetch violates/);
      assert.match(reason, /ctx_fetch_and_index/);
    });

    it('blocks Grep', () => {
      const reason = deniedReason(runHook({ tool_name: 'Grep', tool_input: { pattern: 'foo' } }));
      assert.match(reason, /Grep violates/);
      assert.match(reason, /ctx_execute|ctx_search/);
    });
  });

  describe('allowed tools (no enforcement)', () => {
    for (const tool of ['Read', 'Edit', 'Write', 'Glob', 'Agent', 'TodoWrite', 'Task']) {
      it(`allows ${tool} tool`, () => {
        assertAllowed(runHook({ tool_name: tool, tool_input: {} }));
      });
    }
  });

  describe('bypass sentinel', () => {
    it('allows blocked tool when /tmp/ctx-bypass exists', () => {
      writeFileSync(BYPASS, '');
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: 'tail -30 /tmp/foo' } }));
    });

    it('allows WebFetch when bypass exists', () => {
      writeFileSync(BYPASS, '');
      assertAllowed(runHook({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }));
    });
  });

  describe('fail-safe', () => {
    it('exits 0 on malformed JSON', () => {
      const r = spawnSync('bash', [HOOK], { input: 'not json', encoding: 'utf-8' });
      assert.equal(r.status, 0);
    });

    it('exits 0 on missing tool_name', () => {
      assertAllowed(runHook({ tool_input: {} }));
    });

    it('exits 0 on Bash with no command field', () => {
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: {} }));
    });
  });
});
