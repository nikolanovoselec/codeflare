/**
 * Codeflare Pi context-mode enforcement.
 *
 * Pi-native equivalent of the Claude Code context-mode PreToolUse hook.
 * It keeps large/raw command outputs out of the model context by blocking broad Bash
 * and directing the agent to ctx_* tools. Read is intentionally not routed.
 */

import { existsSync } from "node:fs";

type ExtensionAPI = { on: (event: string, handler: (event: any) => unknown) => void };

const BYPASS_FILE = "/tmp/ctx-bypass";
const ALLOWED_FIRST_WORDS = new Set(["git", "mkdir", "rm", "mv", "cd", "ls", "graphify"]);

function stripHeredocs(command: string): string {
  const lines = command.split("\n");
  const output: string[] = [];
  let delimiter: string | undefined;
  let trimTabs = false;

  for (const line of lines) {
    if (delimiter) {
      const candidate = trimTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === delimiter) {
        delimiter = undefined;
        trimTabs = false;
      }
      continue;
    }

    const match = line.match(/<<(-)?\s*["']?([A-Za-z0-9_]+)["']?/);
    if (match) {
      delimiter = match[2];
      trimTabs = Boolean(match[1]);
      output.push(line.slice(0, match.index));
      continue;
    }

    output.push(line);
  }

  return output.join("\n");
}

function matchingParenIndex(input: string, start: number): number {
  let depth = 1;
  let inSingle = false;
  let inDouble = false;

  for (let index = start + 1; index < input.length; index++) {
    const char = input[index];
    if (inSingle) {
      if (char === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (char === "\\") {
        index++;
        continue;
      }
      if (char === '"') inDouble = false;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth === 0) return index;
  }

  return -1;
}

function extractSubstitutions(command: string): string[] {
  const extras: string[] = [];
  let inSingle = false;
  let inDouble = false;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (inSingle) {
      if (char === "'") inSingle = false;
      continue;
    }
    if (inDouble && char === "\\") {
      index++;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = !inDouble;
      continue;
    }

    if (char === "`") {
      const end = command.indexOf("`", index + 1);
      if (end === -1) continue;
      const inner = command.slice(index + 1, end);
      extras.push(inner, ...extractSubstitutions(inner));
      index = end;
      continue;
    }

    const isCommandSub = char === "$" && command[index + 1] === "(" && command[index + 2] !== "(";
    const isProcessSub = (char === "<" || char === ">") && command[index + 1] === "(";
    const openIndex = isCommandSub ? index + 1 : isProcessSub ? index + 1 : -1;
    if (openIndex !== -1) {
      const end = matchingParenIndex(command, openIndex);
      if (end === -1) continue;
      const inner = command.slice(openIndex + 1, end);
      extras.push(inner, ...extractSubstitutions(inner));
      index = end;
      continue;
    }

    if (char === "$" && command[index + 1] === "(" && command[index + 2] === "(") {
      const end = matchingParenIndex(command, index + 1);
      if (end === -1) continue;
      const inner = command.slice(index + 3, Math.max(index + 3, end - 1));
      extras.push(...extractSubstitutions(inner));
      index = end;
    }
  }

  return extras;
}

function stripQuotedContent(command: string): string {
  let result = "";
  let inSingle = false;
  let inDouble = false;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (inSingle) {
      if (char === "'") {
        inSingle = false;
        result += "QQ";
      }
      continue;
    }
    if (inDouble) {
      if (char === "\\") {
        index++;
        continue;
      }
      if (char === '"') {
        inDouble = false;
        result += "QQ";
      }
      continue;
    }
    if (char === "'") {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    result += char;
  }

  return result;
}

function commandSegments(command: string): string[] {
  const withoutHeredocs = stripHeredocs(command);
  const extracted = extractSubstitutions(withoutHeredocs);
  return stripQuotedContent([withoutHeredocs, ...extracted].join(" ; "))
    .replace(/[0-9]*[<>]&[0-9]+|[0-9]*[<>]&-|&>>?|&\|/g, " ")
    .split(/&&|\|\||;|\||&/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function words(segment: string): string[] {
  return segment
    .replace(/^\(+\s*/, "")
    .replace(/\s*\)+$/, "")
    .replace(/^([A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+/, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function commandFromEvent(event: any): string {
  const input = event?.input ?? event?.params ?? event?.args ?? {};
  return typeof input.command === "string" ? input.command : "";
}

export function bashDenialReason(command: string): string | undefined {
  for (const segment of commandSegments(command)) {
    const [first, second] = words(segment);
    if (!first) continue;
    if (ALLOWED_FIRST_WORDS.has(first)) continue;

    if (first === "npm") {
      if (second === "install" || second === "i" || second === "ci") continue;
      return `npm '${second ?? ""}' is not allowed in Bash. For build/test/lint commands, push to CI (see no-local-builds rule). For other npm commands, use ctx_execute.`;
    }

    if (first === "pip" || first === "pip3") {
      if (second === "install") continue;
      return `${first} '${second ?? ""}' violates context-mode routing. Only ${first} install is allowed in Bash; use ctx_execute for the rest.`;
    }

    if (first === "gh") {
      const third = words(segment)[2];
      const allowedPr = ["create", "view", "status", "list", "checkout"];
      const allowedRun = ["list", "view"];
      if (second === "pr" && third && allowedPr.includes(third) && !segment.includes(" diff") && !segment.includes("--patch")) continue;
      if (second === "run" && third && allowedRun.includes(third) && !segment.includes("--log")) continue;
      if (second === "auth" || second === "repo") continue;
      return `gh '${second ?? ""} ${third ?? ""}' violates context-mode routing. Native Bash is allowed only for small GitHub workflow commands; use ctx_execute for data-heavy gh calls.`;
    }

    if (first === "curl" || first === "wget") {
      return `Bash '${first}' violates context-mode routing. Use ctx_fetch_and_index for URLs or ctx_execute for sandboxed processing.`;
    }

    return `Bash '${first}' violates context-mode routing. Use ctx_execute(language: "shell", code: "...") or ctx_batch_execute instead.`;
  }

  return undefined;
}

export default function (pi: ExtensionAPI) {
  const onToolStart = (event: any) => {
    if (existsSync(BYPASS_FILE)) return;

    const toolName = String(event?.toolName ?? "").toLowerCase();
    if (toolName !== "bash") return;
    const command = commandFromEvent(event);
    if (!command.trim()) return;

    const reason = bashDenialReason(command);
    if (!reason) return;
    return { block: true, reason: `${reason} Bypass is user-only: touch ${BYPASS_FILE}.` };
  };

  pi.on("tool_call", onToolStart);
  pi.on("tool_execution_start", onToolStart);
}
