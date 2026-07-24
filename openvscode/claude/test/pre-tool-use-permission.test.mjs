import assert from "node:assert/strict";
import { test } from "vitest";

import {
  MAX_HOOK_INPUT_BYTES,
  MAX_HOOK_OUTPUT_BYTES,
  runPreToolUse,
} from "../pre-tool-use-permission.mjs";

function hookInput(toolName, toolInput = {}) {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "sidebar-session",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "tool-use-1",
  });
}

function assertBounded(outcome) {
  assert.ok(Buffer.byteLength(outcome.stdout, "utf8") <= MAX_HOOK_OUTPUT_BYTES);
  assert.ok(Buffer.byteLength(outcome.stderr, "utf8") <= MAX_HOOK_OUTPUT_BYTES);
}

function assertDecision(outcome, toolName, expected) {
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.stderr, "");
  assertBounded(outcome);
  const message = JSON.parse(outcome.stdout);
  assert.equal(message.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(message.hookSpecificOutput.permissionDecision, expected, `${toolName} permission was incorrect`);
  assert.equal(typeof message.hookSpecificOutput.permissionDecisionReason, "string");
  assert.ok(message.hookSpecificOutput.permissionDecisionReason.length > 0);
}

test("REQ-IDE-007 AC2: pre-tool-use auto-allows the fixed local tool matrix", async () => {
  for (const toolName of ["Edit", "Write", "NotebookEdit", "Bash", "Task"]) {
    const outcome = await runPreToolUse(hookInput(toolName, { command: "fixture" }));

    assertDecision(outcome, toolName, "allow");
  }
});

test("REQ-IDE-005 AC2: official Claude may read native editor diagnostics without an approval round trip", async () => {
  const outcome = await runPreToolUse(hookInput("mcp__ide__getDiagnostics", { uri: "file:///home/user/workspace/example.ts" }));

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.stderr, "");
  assert.equal(JSON.parse(outcome.stdout).hookSpecificOutput.permissionDecision, "allow");
  assertBounded(outcome);
});

test("REQ-IDE-007 AC2: pre-tool-use allows arbitrary tools when invoked", async () => {
  for (const toolName of ["mcp__ide__executeCode", "mcp__github__create_pull_request", "FutureMutatingTool"]) {
    assertDecision(await runPreToolUse(hookInput(toolName)), toolName, "allow");
  }
});

test("REQ-IDE-007 AC2: an internal permission-hook failure blocks with exit 2 and bounded output", async () => {
  const rawInput = hookInput("Edit");
  const outcome = await runPreToolUse(rawInput, {
    evaluate: () => {
      throw new Error(`sensitive-internal-detail:${"x".repeat(MAX_HOOK_OUTPUT_BYTES * 2)}`);
    },
  });

  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.stdout, "");
  assert.equal(outcome.stderr, "Claude sidebar permission check failed.\n");
  assertBounded(outcome);
});

test("REQ-IDE-007 AC2: oversized hook input blocks at the boundary with exit 2 and bounded output", async () => {
  assert.equal(MAX_HOOK_INPUT_BYTES, 64 * 1024);
  assert.equal(MAX_HOOK_OUTPUT_BYTES, 4 * 1024);
  const oversized = "x".repeat(64 * 1024 + 1);

  const outcome = await runPreToolUse(oversized);

  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.stdout, "");
  assert.equal(outcome.stderr, "Claude sidebar permission check failed.\n");
  assertBounded(outcome);
});

test("REQ-IDE-007 AC2: unrestricted permission-hook output remains bounded for adversarial tool names", async () => {
  const toolName = `mcp__fixture__${"x".repeat(MAX_HOOK_OUTPUT_BYTES * 2)}`;

  const outcome = await runPreToolUse(hookInput(toolName));

  assertDecision(outcome, toolName, "allow");
  assertBounded(outcome);
});
