// Behavioral tests for entrypoint.sh's context-mode integration.
//
// Per tdd-discipline.md "Run the real thing": these tests do NOT regex
// over the entrypoint source. They actually execute the bash blocks
// that build CONTEXT_MODE_MCP_CONFIG and SETTINGS_CONFIG (with stub
// PLUGIN_DIR / CONTEXT_MODE_VERSION env vars), capture the JSON
// produced by jq -n, and assert on the parsed shape. If the bash
// construction is broken - quoting bug, missing variable, jq filter
// typo - the test fails because $SETTINGS_CONFIG comes back malformed
// or empty.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(__dirname, '../../entrypoint.sh');
const STUB_PLUGIN_DIR = '/test-stub/plugins';

// Run the SESSION_MODE=advanced (or default) settings block from
// entrypoint.sh in a subshell and capture the resulting SETTINGS_CONFIG.
// We extract the `if [ ... ]; then ... else ... fi` block by line range
// and eval it after setting PLUGIN_DIR + CONTEXT_MODE_VERSION + SESSION_MODE.
function runSettingsBlock(sessionMode) {
  const result = spawnSync('bash', ['-c', `
    set -e
    PLUGIN_DIR=${STUB_PLUGIN_DIR}
    CONTEXT_MODE_VERSION=$(grep '^CONTEXT_MODE_VERSION=' ${ENTRYPOINT} | head -1 | cut -d'"' -f2)
    SESSION_MODE=${sessionMode}
    START=$(grep -n '^if \\[ "\\\${SESSION_MODE:-default}" = "advanced"' ${ENTRYPOINT} | head -1 | cut -d: -f1)
    END=$(awk -v s="$START" 'NR>s && /^fi$/ {print NR; exit}' ${ENTRYPOINT})
    BLOCK=$(sed -n "$START,$END"p ${ENTRYPOINT})
    eval "$BLOCK" >/dev/null 2>&1
    printf '%s' "$SETTINGS_CONFIG"
  `], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`bash failed: ${result.stderr}`);
  }
  return result.stdout;
}

// Run the CONTEXT_MODE_MCP_CONFIG block similarly.
function runMcpBlock() {
  const result = spawnSync('bash', ['-c', `
    set -e
    CONTEXT_MODE_VERSION=$(grep '^CONTEXT_MODE_VERSION=' ${ENTRYPOINT} | head -1 | cut -d'"' -f2)
    LINE=$(grep -n '^CONTEXT_MODE_MCP_CONFIG=' ${ENTRYPOINT} | head -1 | cut -d: -f1)
    BLOCK=$(sed -n "$LINE"p ${ENTRYPOINT})
    eval "$BLOCK"
    printf '%s' "$CONTEXT_MODE_MCP_CONFIG"
  `], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`bash failed: ${result.stderr}`);
  }
  return result.stdout;
}

// Detect whether the CONTEXT_MODE_MCP_CONFIG assignment is wrapped in an
// `if [ "${SESSION_MODE...}" = "advanced" ]` gate. Reads the script via
// the shell's own block-detection: we grep for the surrounding control
// structure rather than text-matching with a hardcoded char window.
function mcpBlockIsModeGated() {
  const result = spawnSync('bash', ['-c', `
    awk '
      /^if \\[ "\\$\\{SESSION_MODE:-default\\}" = "advanced" \\]/ { in_advanced=1; next }
      /^fi$/ && in_advanced { in_advanced=0; next }
      /^CONTEXT_MODE_MCP_CONFIG=/ { print (in_advanced ? "GATED" : "UNGATED"); exit }
    ' ${ENTRYPOINT}
  `], { encoding: 'utf8' });
  return result.stdout.trim() === 'GATED';
}

describe('context-mode MCP server registration', () => {
  let mcp;
  before(() => {
    mcp = JSON.parse(runMcpBlock());
  });

  it('CONTEXT_MODE_MCP_CONFIG registers context-mode under mcpServers', () => {
    assert.ok(
      mcp.mcpServers && mcp.mcpServers['context-mode'],
      'mcpServers.context-mode must be present',
    );
    const cm = mcp.mcpServers['context-mode'];
    assert.strictEqual(cm.command, 'npx', 'context-mode command must be npx');
    assert.ok(Array.isArray(cm.args), 'context-mode args must be an array');
    assert.ok(
      cm.args.includes('-y'),
      'context-mode args must include "-y" so npx auto-accepts the install',
    );
  });

  it('context-mode is pinned to a specific version (not floating @latest)', () => {
    const cm = mcp.mcpServers['context-mode'];
    const pkgArg = cm.args.find((a) => typeof a === 'string' && a.startsWith('context-mode'));
    assert.ok(pkgArg, 'mcpServers.context-mode.args must include the package spec');
    assert.match(
      pkgArg,
      /^context-mode@\d+\.\d+\.\d+$/,
      `package spec must be context-mode@<semver>, got: ${pkgArg}`,
    );
  });

  it('MCP registration block is NOT wrapped in a SESSION_MODE=advanced gate (ctx_* tools available in Standard mode too)', () => {
    assert.strictEqual(
      mcpBlockIsModeGated(),
      false,
      'CONTEXT_MODE_MCP_CONFIG must be assigned outside the SESSION_MODE=advanced gate',
    );
  });
});

describe('SETTINGS_CONFIG produced in advanced (Pro) mode', () => {
  let settings;
  before(() => {
    settings = JSON.parse(runSettingsBlock('advanced'));
  });

  it('parses to valid JSON with hooks', () => {
    assert.ok(settings.skipDangerousModePermissionPrompt === true);
    assert.ok(settings.hooks, 'SETTINGS_CONFIG.hooks must exist');
  });

  it('PreToolUse has TWO entries: codeflare block-attributed-commits AND context-mode pretooluse', () => {
    const pre = settings.hooks.PreToolUse;
    assert.ok(Array.isArray(pre) && pre.length === 2,
      'PreToolUse must have exactly 2 matcher entries');

    const codeflareEntry = pre.find((e) =>
      e.hooks.some((h) => h.command && h.command.includes('block-attributed-commits.sh')),
    );
    assert.ok(codeflareEntry, 'block-attributed-commits hook must remain in PreToolUse');
    assert.strictEqual(codeflareEntry.matcher, 'Bash');
    assert.ok(codeflareEntry.hooks.some((h) => h.if === 'Bash(git *)'));
    assert.ok(codeflareEntry.hooks.some((h) => h.if === 'Bash(gh *)'));

    const ctxEntry = pre.find((e) =>
      e.hooks.some((h) => h.command && h.command.includes('hook claude-code pretooluse')),
    );
    assert.ok(ctxEntry, 'context-mode pretooluse hook must be wired');
    assert.ok(
      ctxEntry.matcher.includes('Bash') && ctxEntry.matcher.includes('Agent'),
      'context-mode PreToolUse matcher must cover Bash and Agent (for subagent routing)',
    );
  });

  it('PostToolUse points at context-mode posttooluse, not the retired git-push-review-reminder', () => {
    const post = settings.hooks.PostToolUse;
    assert.ok(Array.isArray(post) && post.length >= 1);
    const ctx = post.find((e) =>
      e.hooks.some((h) => h.command && h.command.includes('hook claude-code posttooluse')),
    );
    assert.ok(ctx, 'context-mode posttooluse must be the PostToolUse handler');
    const stale = post.find((e) =>
      e.hooks.some((h) => h.command && h.command.includes('git-push-review-reminder.sh')),
    );
    assert.strictEqual(stale, undefined,
      'git-push-review-reminder.sh PostToolUse entry must be retired');
  });

  it('PreCompact and SessionStart hooks are wired for context-mode', () => {
    for (const event of ['PreCompact', 'SessionStart']) {
      const arr = settings.hooks[event];
      assert.ok(Array.isArray(arr) && arr.length >= 1, `${event} must be wired`);
      const ctx = arr.find((e) =>
        e.hooks.some((h) => h.command && h.command.includes(`hook claude-code ${event.toLowerCase()}`)),
      );
      assert.ok(ctx, `context-mode ${event.toLowerCase()} hook must be present`);
    }
  });

  it('Stop hook still wires enforce-review-spawn (the actual SDD review gate)', () => {
    const stop = settings.hooks.Stop;
    assert.ok(Array.isArray(stop) && stop.length >= 1);
    const enforce = stop.find((e) =>
      e.hooks.some((h) => h.command && h.command.includes('enforce-review-spawn.sh')),
    );
    assert.ok(enforce, 'enforce-review-spawn.sh Stop hook must remain');
    const enforceCmd = enforce.hooks.find((h) => h.command.includes('enforce-review-spawn.sh')).command;
    assert.ok(
      enforceCmd.includes(STUB_PLUGIN_DIR),
      `Stop hook command must interpolate $PLUGIN_DIR, got: ${enforceCmd}`,
    );
  });

  it('UserPromptSubmit still wires memory-capture', () => {
    const ups = settings.hooks.UserPromptSubmit;
    assert.ok(Array.isArray(ups) && ups.length >= 1);
    const mc = ups.find((e) =>
      e.hooks.some((h) => h.command && h.command.includes('memory-capture.sh')),
    );
    assert.ok(mc, 'memory-capture.sh UserPromptSubmit hook must remain');
  });

  it('all four context-mode hooks pin to the same semver version (not @latest)', () => {
    const events = ['pretooluse', 'posttooluse', 'precompact', 'sessionstart'];
    const seenVersions = new Set();
    for (const ev of events) {
      const allCmds = Object.values(settings.hooks)
        .flat()
        .flatMap((entry) => entry.hooks || [])
        .map((h) => h.command || '');
      const cmd = allCmds.find((c) => c.includes(`hook claude-code ${ev}`));
      assert.ok(cmd, `context-mode ${ev} hook must be wired somewhere`);
      const m = cmd.match(/context-mode@(\d+\.\d+\.\d+)/);
      assert.ok(m, `${ev} command must pin context-mode to a semver version, got: ${cmd}`);
      seenVersions.add(m[1]);
    }
    assert.strictEqual(seenVersions.size, 1,
      `all four context-mode hook commands must pin the same version, got: ${[...seenVersions]}`);
  });

  it('no settings.hooks.* entry references the retired git-push-review-reminder script', () => {
    for (const [event, arr] of Object.entries(settings.hooks)) {
      for (const entry of arr) {
        for (const hook of entry.hooks || []) {
          assert.ok(
            !(hook.command && hook.command.includes('git-push-review-reminder.sh')),
            `Stale reference to retired hook in ${event} matcher=${entry.matcher}`,
          );
        }
      }
    }
  });
});

describe('SETTINGS_CONFIG produced in default (Standard) mode', () => {
  let settings;
  before(() => {
    settings = JSON.parse(runSettingsBlock('default'));
  });

  it('only sets skipDangerousModePermissionPrompt; no hooks', () => {
    assert.strictEqual(settings.skipDangerousModePermissionPrompt, true);
    assert.strictEqual(settings.hooks, undefined,
      'Standard mode must not register any hooks (ctx_* tools are reachable via the MCP server alone)');
  });
});

describe('managed-hook regex classification (anchored, not substring)', () => {
  // Extract the regex literal that entrypoint.sh passes to jq's test()
  // for "is this hook managed-by-codeflare?", then run it through jq
  // directly against a battery of candidate command strings to verify
  // it classifies only the exact shapes entrypoint emits as managed,
  // while leaving user wrapper scripts alone.
  function extractRegex() {
    const result = spawnSync('bash', ['-c', `
      set -e
      grep -oE 'test\\("[^"]+"\\)' ${ENTRYPOINT} | grep 'context-mode' | head -1 | sed 's/^test("//; s/")$//'
    `], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`grep failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  function classify(cmd, regex) {
    // Use jq's test() directly - same engine entrypoint uses.
    const result = spawnSync('jq', ['-rn', '--arg', 'cmd', cmd, '--arg', 're', regex,
      '$cmd | test($re) | tostring'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`jq failed: ${result.stderr}`);
    return result.stdout.trim() === 'true';
  }

  let regex;
  before(() => { regex = extractRegex(); });

  it('regex literal references both codeflare scripts and context-mode hooks', () => {
    assert.ok(regex, 'expected to find a test() regex containing context-mode');
    assert.ok(regex.includes('codeflare-(hooks|memory)/scripts/'));
    assert.ok(regex.includes('context-mode'));
  });

  it('classifies entrypoint-emitted codeflare hook commands as managed', () => {
    assert.strictEqual(
      classify(`bash ${STUB_PLUGIN_DIR}/codeflare-hooks/scripts/block-attributed-commits.sh`, regex),
      true,
    );
    assert.strictEqual(
      classify(`bash ${STUB_PLUGIN_DIR}/codeflare-hooks/scripts/enforce-review-spawn.sh`, regex),
      true,
    );
    assert.strictEqual(
      classify(`bash ${STUB_PLUGIN_DIR}/codeflare-memory/scripts/memory-capture.sh`, regex),
      true,
    );
  });

  it('classifies entrypoint-emitted context-mode hook commands as managed (all 4 events)', () => {
    for (const ev of ['pretooluse', 'posttooluse', 'precompact', 'sessionstart']) {
      assert.strictEqual(
        classify(`npx -y context-mode@1.0.111 hook claude-code ${ev}`, regex),
        true,
        `event ${ev} must be classified as managed`,
      );
      assert.strictEqual(
        classify(`npx -y context-mode@2.0.0 hook claude-code ${ev}`, regex),
        true,
        `future versions of ${ev} must still be classified as managed (regex matches any [0-9.]+ version)`,
      );
    }
  });

  it('does NOT classify user wrappers that merely CALL context-mode as managed (anchored, not substring)', () => {
    // The bug the M2 finding describes: a substring match would catch
    // these and silently strip them on rerun. The anchored regex must
    // leave them alone.
    assert.strictEqual(
      classify('bash /home/me/log-context-mode-calls.sh && npx -y context-mode@1.0.111 hook claude-code pretooluse', regex),
      false,
      'user wrapper script that calls context-mode must NOT be classified as managed',
    );
    assert.strictEqual(
      classify('bash /home/me/my-context-mode-proxy.sh', regex),
      false,
      'user script with "context-mode" in its name must NOT be classified as managed',
    );
    assert.strictEqual(
      classify('npx context-mode@1.0.111 hook claude-code pretooluse', regex),
      false,
      'missing -y flag must NOT match (the regex pins the exact entrypoint shape)',
    );
    assert.strictEqual(
      classify('npx -y context-mode hook claude-code pretooluse', regex),
      false,
      'unpinned context-mode (no @ver) must NOT match - entrypoint always pins version',
    );
  });

  it('does NOT classify unrelated user hook commands as managed', () => {
    assert.strictEqual(classify('bash /home/me/my-hook.sh', regex), false);
    assert.strictEqual(classify('node /opt/custom/lint.js', regex), false);
    assert.strictEqual(classify('echo "user hook"', regex), false);
  });
});
