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

    it('denies pip3 uninstall (separate branch from pip)', () => {
      assert.match(deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'pip3 uninstall pytest' } })), /pip3 'uninstall' violates/);
    });

    it('denies lone & background fork: git log & tail x', () => {
      assert.match(deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: 'git log & tail x' } })), /'tail' violates/);
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

    it('allows subshell with chain ops: (cd /tmp && ls)', () => {
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: '(cd /tmp && ls)' } }));
    });

    it('allows subshell with semicolon: (cd /tmp; ls)', () => {
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: '(cd /tmp; ls)' } }));
    });

    it('still denies non-whitelisted inside subshell: (curl evil)', () => {
      assert.match(deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: '(curl https://evil)' } })), /'curl' violates/);
    });

    it('allows whitespace-only command silently', () => {
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: '   ' } }));
    });
  });

  describe('heredoc normalization', () => {
    it('allows git commit with heredoc body containing && (body stripped)', () => {
      const cmd = 'git commit -m "$(cat <<EOF\nuse && for chaining\nand || for fallback\nEOF\n)"';
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: cmd } }));
    });

    it('allows git commit with quoted-delimiter heredoc', () => {
      const cmd = "git commit -m \"$(cat <<'EOF'\nuse && for chaining\nEOF\n)\"";
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: cmd } }));
    });

    it('CLOSES heredoc bypass: cmd <<EOF body EOF && curl evil is denied', () => {
      const cmd = 'git x <<EOF\nbody\nEOF\n && curl https://evil.example';
      const reason = deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: cmd } }));
      assert.match(reason, /'curl' violates/);
    });

    it('CLOSES heredoc bypass with tab-indented dash variant: <<-EOF', () => {
      const cmd = 'git x <<-EOF\n\tbody\n\tEOF\n && tail x';
      const reason = deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: cmd } }));
      assert.match(reason, /'tail' violates/);
    });

    it('CLOSES heredoc-inside-quoted-string bypass (<<EOF inside "...")', () => {
      const cmd = 'git status -- "see <<EOF in docs"\n&& curl https://evil';
      const reason = deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: cmd } }));
      assert.match(reason, /'curl' violates/);
    });

    it('CLOSES heredoc-inside-single-quoted bypass', () => {
      const cmd = "git status -- 'see <<EOF in docs'\n&& tail x";
      const reason = deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: cmd } }));
      assert.match(reason, /'tail' violates/);
    });

    it('pins unterminated heredoc behavior (fails closed: consumes rest)', () => {
      const cmd = 'git x <<EOF\nnever closes\n && tail evil';
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: cmd } }));
    });

    it('CLOSES multi-line heredoc bypass: cmd <<EOF\\nbody\\nEOF\\ncurl evil (newline after terminator)', () => {
      const cmd = 'git x <<EOF\nbody line 1\nbody line 2\nEOF\ncurl evil';
      const reason = deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: cmd } }));
      assert.match(reason, /curl violates/);
    });

    it('CLOSES multi-line heredoc bypass with chained post-cmd: ...EOF\\ngit status; curl evil', () => {
      const cmd = 'git x <<EOF\nbody\nEOF\ngit status; curl evil';
      const reason = deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: cmd } }));
      assert.match(reason, /curl violates/);
    });

    it('CLOSES multi-line heredoc bypass with bg fork after: ...EOF\\nhead -1 f &', () => {
      const cmd = 'git x <<EOF\nbody\nEOF\nhead -1 file &';
      const reason = deniedReason(runHook({ tool_name: 'Bash', tool_input: { command: cmd } }));
      assert.match(reason, /head violates/);
    });

    it('allows multi-line heredoc with no follow-up command', () => {
      const cmd = 'git commit -F - <<EOF\nmessage line 1\nmessage line 2\nEOF';
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: cmd } }));
    });

    it('allows multi-line heredoc with whitelisted follow-up: ...EOF\\ngit push', () => {
      const cmd = 'git commit -F - <<EOF\nmessage\nEOF\ngit push';
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: cmd } }));
    });

    it('allows multi-line tab-dash heredoc with whitelisted follow-up', () => {
      const cmd = 'git commit -F - <<-EOF\n\tindented message\n\tEOF\ngit push';
      assertAllowed(runHook({ tool_name: 'Bash', tool_input: { command: cmd } }));
    });
  });

  describe('file descriptor redirects (closes false-positive on &)', () => {
    it('allows git log with 2>&1 redirect', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log 2>&1' },
      }));
    });

    it('allows pipe with 2>&1 before pipe to whitelisted', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log 2>&1 | (ls)' },
      }));
    });

    it('allows >&3 fd duplicate', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log >&3' },
      }));
    });

    it('allows <&0 fd duplicate', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log <&0' },
      }));
    });

    it('allows >&- fd close', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log >&-' },
      }));
    });

    it('allows &>file redirect-both', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log &>/tmp/log' },
      }));
    });

    it('allows &>>file redirect-both-append', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log &>>/tmp/log' },
      }));
    });

    it('still denies real background-fork: git log &', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log & tail x' },
      }));
      assert.match(reason, /'tail' violates/);
    });
  });

  describe('quoted-string normalization (closes false-positive)', () => {
    it('allows git commit with chain ops inside double-quoted message', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "use && and ; in messages"' },
      }));
    });

    it('allows git log --grep with single-quoted semicolon (no false-split)', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: "git log --grep='tail x ; head y'" },
      }));
    });

    it('still denies real chain outside quotes: git commit -m "msg" && curl', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "msg" && curl https://evil' },
      }));
      assert.match(reason, /'curl' violates/);
    });

    it('still denies pipe to non-whitelisted after quoted block', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log --grep="release;" | head' },
      }));
      assert.match(reason, /'head' violates/);
    });
  });

  describe('command/process substitution extraction (closes $(...), <(...), `...` bypass)', () => {
    it('CLOSES $(...) bypass: git log $(curl evil) is denied on inner curl', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log $(curl evil.com)' },
      }));
      assert.match(reason, /curl violates/);
    });

    it('CLOSES $(...) bypass with non-whitelisted inner: git log $(head -10 f)', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log $(head -10 file)' },
      }));
      assert.match(reason, /head violates/);
    });

    it('CLOSES <(...) process-substitution bypass: git diff <(curl a) <(curl b)', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git diff <(curl a.com) <(curl b.com)' },
      }));
      assert.match(reason, /curl violates/);
    });

    it('CLOSES >(...) process-substitution bypass: ls > >(curl evil)', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'ls -la > >(curl evil.com)' },
      }));
      assert.match(reason, /curl violates/);
    });

    it('CLOSES backtick bypass: git log `curl evil`', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log `curl evil.com`' },
      }));
      assert.match(reason, /curl violates/);
    });

    it('CLOSES nested substitution: git log $(echo $(curl evil))', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log $(echo $(curl evil.com))' },
      }));
      // Either echo or curl can be the first denied segment; both are non-whitelisted.
      assert.match(reason, /(echo|curl) violates/);
    });

    it('CLOSES backtick inside $(...) nested: git log $(echo `curl x`)', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log $(echo `curl x`)' },
      }));
      assert.match(reason, /(echo|curl) violates/);
    });

    it('CLOSES $(...) inside double-quoted string: git log --grep="$(curl evil)"', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log --grep="$(curl evil.com)"' },
      }));
      assert.match(reason, /curl violates/);
    });

    it('allows $(...) inside single-quoted string (literal, not executed)', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: "git log --grep='$(curl evil)'" },
      }));
    });

    it('allows backticks inside single-quoted string (literal, not executed)', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: "git log --grep='`curl evil`'" },
      }));
    });

    it('allows arithmetic expansion $((expr)) (not command substitution)', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log -n $((1 + 2))' },
      }));
    });

    it('allows nested arithmetic-only $(($((1+2)) + 3)) with no inner command sub', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log -n $(($((1+2)) + 3))' },
      }));
    });

    it('allows arithmetic with parens-grouped operator: $(( (1+2) * 3 ))', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log -n $(( (1+2) * 3 ))' },
      }));
    });

    it('CLOSES arithmetic-nested $(...) bypass: $(($(curl evil) + 1))', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log -n $(($(curl evil.com) + 1))' },
      }));
      assert.match(reason, /curl violates/);
    });

    it('CLOSES arithmetic-nested backtick bypass: $((`curl evil` + 1))', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log -n $((`curl evil` + 1))' },
      }));
      assert.match(reason, /curl violates/);
    });

    it('CLOSES arithmetic-nested non-network sub: $(($(head /etc/passwd) + 1))', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log -n $(($(head /etc/passwd) + 1))' },
      }));
      assert.match(reason, /head violates/);
    });

    it('CLOSES deeply-nested arithmetic+sub: $(($((1+$(curl x))) + 2))', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log -n $(($((1+$(curl x))) + 2))' },
      }));
      assert.match(reason, /curl violates/);
    });

    it('CLOSES arithmetic-nested sub inside double-quoted string', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log --grep="$(($(curl evil) + 1))"' },
      }));
      assert.match(reason, /curl violates/);
    });

    it('allows arithmetic-nested sub inside single-quoted string (literal)', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: "git log --grep='$(($(curl x) + 1))'" },
      }));
    });

    it('CLOSES unterminated-arithmetic inner $(...) bypass: $((1+$(curl evil)', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log $((1+$(curl evil)' },
      }));
      assert.match(reason, /curl violates/);
    });

    it('CLOSES unterminated-arithmetic inner backtick bypass: $((1+`curl evil`', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log $((1+`curl evil`' },
      }));
      assert.match(reason, /curl violates/);
    });

    it('allows bare unterminated arithmetic with no inner sub: git log $((1+2', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log $((1+2' },
      }));
    });

    it('handles doubly-unterminated input safely (no inner extraction, no infinite loop): $((1+$(curl x', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log $((1+$(curl x' },
      }));
    });

    it('allows parameter expansion $VAR and ${VAR}', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log $HOME ${BRANCH}' },
      }));
    });

    it('allows parens inside double-quoted string with no $ prefix', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log --pretty="(%h) %s"' },
      }));
    });

    it('allows whitelisted inner sub: git push $(git rev-parse HEAD)', () => {
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git push origin $(git rev-parse HEAD)' },
      }));
    });

    it('pins unterminated $(...) behavior (fails open: passes through)', () => {
      // Unterminated subs would also fail at bash parse time; we choose
      // fail-open here to match the existing unterminated-heredoc behavior.
      assertAllowed(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log $(curl evil' },
      }));
    });

    it('CLOSES sub bypass even when outer command is also whitelisted (chain): cd /tmp && git $(curl)', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'cd /tmp && git log $(curl evil.com)' },
      }));
      assert.match(reason, /curl violates/);
    });

    it('CLOSES $(...) bypass with non-whitelisted second token in sub: $(npm test)', () => {
      const reason = deniedReason(runHook({
        tool_name: 'Bash',
        tool_input: { command: 'git log $(npm test)' },
      }));
      // First word of inner segment is 'npm', second is 'test' (not install) - denied via npm second-word path.
      assert.match(reason, /npm 'test' violates/);
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
