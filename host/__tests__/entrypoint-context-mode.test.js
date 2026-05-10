// Real behavioral tests for entrypoint.sh's context-mode integration.
//
// These tests extract the JSON literals that entrypoint.sh constructs
// (CONTEXT_MODE_MCP_CONFIG and SETTINGS_CONFIG) and structurally walk
// the parsed result. Per tdd-discipline.md, this is fixture-driven
// rather than text-matching theater: the test fails if the JSON
// shape regresses, not if prose around it changes.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(
  resolve(__dirname, '../../entrypoint.sh'),
  'utf8',
);

// Helper: extract a single-quoted bash JSON literal assigned to VAR.
// Handles entrypoint.sh's pattern of breaking out of single quotes
// to expand "$PLUGIN_DIR" via '"$VAR"' splicing — we substitute the
// placeholder back in so JSON.parse succeeds.
function extractAssignment(varName) {
  const re = new RegExp(`${varName}='([^']*(?:'"\\$[A-Z_]+"'[^']*)*)`);
  const m = entrypoint.match(re);
  if (!m) return null;
  // Replace each '"$VAR"' splice with a synthetic placeholder string
  // so the resulting bash-spliced string is valid JSON.
  return m[1].replace(/'"\$([A-Z_]+)"'/g, (_, v) => `__${v}__`);
}

describe('context-mode MCP server registration', () => {
  it('CONTEXT_MODE_MCP_CONFIG is valid JSON registering context-mode under mcpServers', () => {
    const raw = extractAssignment('CONTEXT_MODE_MCP_CONFIG');
    assert.ok(raw, 'CONTEXT_MODE_MCP_CONFIG must be defined in entrypoint.sh');
    const parsed = JSON.parse(raw);
    assert.ok(
      parsed.mcpServers && parsed.mcpServers['context-mode'],
      'mcpServers.context-mode must be present',
    );
    const cm = parsed.mcpServers['context-mode'];
    assert.strictEqual(cm.command, 'npx', 'context-mode command must be npx');
    assert.ok(
      Array.isArray(cm.args) && cm.args.includes('context-mode'),
      'context-mode args must include "context-mode"',
    );
    assert.ok(
      cm.args.includes('-y'),
      'context-mode args must include "-y" so npx auto-accepts the install',
    );
  });

  it('context-mode MCP registration runs unconditionally (parallel to memory MCP), not gated by SESSION_MODE', () => {
    // Find the surrounding bash block. The context-mode MCP setup must
    // appear OUTSIDE the `if [ "${SESSION_MODE:-default}" = "advanced" ]`
    // block — it should be available to Standard mode too.
    const idx = entrypoint.indexOf('CONTEXT_MODE_MCP_CONFIG=');
    assert.ok(idx > -1);
    // Look at the 200 chars before the assignment for a SESSION_MODE
    // gate that would block Standard mode users from getting the MCP.
    const preceding = entrypoint.slice(Math.max(0, idx - 400), idx);
    assert.ok(
      !preceding.includes('SESSION_MODE'),
      'context-mode MCP config must not be wrapped in a SESSION_MODE=advanced gate',
    );
  });
});

describe('context-mode hook wiring in advanced-mode SETTINGS_CONFIG', () => {
  let settings;

  it('SETTINGS_CONFIG parses as valid JSON', () => {
    const raw = extractAssignment('SETTINGS_CONFIG');
    assert.ok(raw, 'SETTINGS_CONFIG must be defined');
    settings = JSON.parse(raw);
    assert.ok(settings.hooks, 'SETTINGS_CONFIG.hooks must exist');
  });

  it('PreToolUse has TWO entries: codeflare block-attributed-commits AND context-mode pretooluse', () => {
    const raw = extractAssignment('SETTINGS_CONFIG');
    settings = JSON.parse(raw);
    const pre = settings.hooks.PreToolUse;
    assert.ok(Array.isArray(pre) && pre.length === 2,
      'PreToolUse must have exactly 2 matcher entries');
    const ctxEntry = pre.find((e) =>
      e.hooks.some((h) => h.command && h.command.includes('context-mode hook claude-code pretooluse')),
    );
    assert.ok(ctxEntry, 'context-mode pretooluse hook must be wired');
    assert.ok(
      ctxEntry.matcher.includes('Bash') && ctxEntry.matcher.includes('Agent'),
      'context-mode PreToolUse matcher must cover Bash and Agent (for subagent routing)',
    );
    const codeflareEntry = pre.find((e) =>
      e.hooks.some((h) => h.command && h.command.includes('block-attributed-commits.sh')),
    );
    assert.ok(codeflareEntry, 'block-attributed-commits hook must remain in PreToolUse');
  });

  it('PostToolUse points at context-mode posttooluse, not the retired git-push-review-reminder', () => {
    const raw = extractAssignment('SETTINGS_CONFIG');
    settings = JSON.parse(raw);
    const post = settings.hooks.PostToolUse;
    assert.ok(Array.isArray(post) && post.length >= 1,
      'PostToolUse must be wired');
    const ctx = post.find((e) =>
      e.hooks.some((h) => h.command && h.command.includes('context-mode hook claude-code posttooluse')),
    );
    assert.ok(ctx, 'context-mode posttooluse must be the PostToolUse handler');
    // No PostToolUse entry references the retired script.
    const stale = post.find((e) =>
      e.hooks.some((h) => h.command && h.command.includes('git-push-review-reminder.sh')),
    );
    assert.strictEqual(stale, undefined,
      'git-push-review-reminder.sh PostToolUse entry must be retired');
  });

  it('PreCompact and SessionStart hooks are wired for context-mode', () => {
    const raw = extractAssignment('SETTINGS_CONFIG');
    settings = JSON.parse(raw);
    for (const event of ['PreCompact', 'SessionStart']) {
      const arr = settings.hooks[event];
      assert.ok(Array.isArray(arr) && arr.length >= 1,
        `${event} must be wired`);
      const ctx = arr.find((e) =>
        e.hooks.some((h) => h.command && h.command.includes(`context-mode hook claude-code ${event.toLowerCase()}`)),
      );
      assert.ok(ctx, `context-mode ${event.toLowerCase()} hook must be present`);
    }
  });

  it('Stop hook still wires enforce-review-spawn (the actual SDD review gate)', () => {
    const raw = extractAssignment('SETTINGS_CONFIG');
    settings = JSON.parse(raw);
    const stop = settings.hooks.Stop;
    assert.ok(Array.isArray(stop) && stop.length >= 1);
    const enforce = stop.find((e) =>
      e.hooks.some((h) => h.command && h.command.includes('enforce-review-spawn.sh')),
    );
    assert.ok(enforce,
      'enforce-review-spawn.sh Stop hook must remain — it is the SDD review-pipeline gate');
  });

  it('UserPromptSubmit still wires memory-capture', () => {
    const raw = extractAssignment('SETTINGS_CONFIG');
    settings = JSON.parse(raw);
    const ups = settings.hooks.UserPromptSubmit;
    assert.ok(Array.isArray(ups) && ups.length >= 1);
    const mc = ups.find((e) =>
      e.hooks.some((h) => h.command && h.command.includes('memory-capture.sh')),
    );
    assert.ok(mc, 'memory-capture.sh UserPromptSubmit hook must remain');
  });

  it('no settings.hooks.* entry references the retired git-push-review-reminder script', () => {
    const raw = extractAssignment('SETTINGS_CONFIG');
    settings = JSON.parse(raw);
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

  it('hooks merge regex classifies context-mode hook commands as managed (refreshable on entrypoint rerun)', () => {
    // The jq filter that distinguishes user-added hooks from managed
    // hooks must include the context-mode pattern; otherwise a stale
    // context-mode hook line would survive across entrypoint reruns.
    const idx = entrypoint.indexOf('test("codeflare-(hooks|memory)/scripts/');
    assert.ok(idx > -1, 'managed-hook regex must exist in entrypoint.sh');
    const line = entrypoint.slice(idx, idx + 200);
    assert.ok(
      line.includes('context-mode hook claude-code'),
      'managed-hook regex must include the context-mode hook pattern',
    );
  });
});
