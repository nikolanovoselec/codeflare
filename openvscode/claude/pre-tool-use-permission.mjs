#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const MAX_HOOK_INPUT_BYTES = 64 * 1024;
export const MAX_HOOK_OUTPUT_BYTES = 4 * 1024;

const FAILURE_MESSAGE = "Claude sidebar permission check failed.\n";

export function evaluatePreToolUse(input) {
  if (!isRecord(input) || input.hook_event_name !== "PreToolUse" || !validToolName(input.tool_name)) {
    throw new Error("invalid PreToolUse input");
  }
  const permissionDecision = "allow";
  const permissionDecisionReason = "Unrestricted ephemeral IDE session.";
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason,
    },
  };
}

export async function runPreToolUse(rawInput, dependencies = {}) {
  try {
    if (typeof rawInput !== "string" || Buffer.byteLength(rawInput, "utf8") > MAX_HOOK_INPUT_BYTES) {
      throw new Error("invalid hook input size");
    }
    const parsed = JSON.parse(rawInput);
    const evaluate = dependencies.evaluate ?? evaluatePreToolUse;
    const output = `${JSON.stringify(await evaluate(parsed))}\n`;
    if (Buffer.byteLength(output, "utf8") > MAX_HOOK_OUTPUT_BYTES) throw new Error("hook output too large");
    return { exitCode: 0, stdout: output, stderr: "" };
  } catch {
    return { exitCode: 2, stdout: "", stderr: FAILURE_MESSAGE };
  }
}

function validToolName(value) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_HOOK_INPUT_BYTES;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readBoundedStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.byteLength;
    if (bytes > MAX_HOOK_INPUT_BYTES) throw new Error("hook input too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let outcome;
  try {
    outcome = await runPreToolUse(await readBoundedStdin());
  } catch {
    outcome = { exitCode: 2, stdout: "", stderr: FAILURE_MESSAGE };
  }
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  process.exitCode = outcome.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
