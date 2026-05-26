/**
 * Codeflare Pi context-mode enforcement.
 *
 * Pi-native equivalent of the Claude Code context-mode PreToolUse hook.
 * It keeps large/raw outputs out of the model context by blocking broad Bash
 * and large Read calls and directing the agent to ctx_* tools.
 */

import { existsSync, statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BYPASS_FILE = "/tmp/ctx-bypass";
const MAX_READ_BYTES = 20 * 1024;
const MAX_READ_LINES = 260;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
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
  return stripQuotedContent(stripHeredocs(command))
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

function bashDenialReason(command: string): string | undefined {
  for (const segment of commandSegments(command)) {
    const [first, second] = words(segment);
    if (!first) continue;
    if (ALLOWED_FIRST_WORDS.has(first)) continue;

    if (first === "npm") {
      if (second === "install" || second === "i" || second === "ci") continue;
      return `npm '${second ?? ""}' violates context-mode routing. Only npm install/i/ci is allowed in Bash; use ctx_execute for the rest.`;
    }

    if (first === "pip" || first === "pip3") {
      if (second === "install") continue;
      return `${first} '${second ?? ""}' violates context-mode routing. Only ${first} install is allowed in Bash; use ctx_execute for the rest.`;
    }

    if (first === "curl" || first === "wget") {
      return `Bash '${first}' violates context-mode routing. Use ctx_fetch_and_index for URLs or ctx_execute for sandboxed processing.`;
    }

    return `Bash '${first}' violates context-mode routing. Use ctx_execute(language: "shell", code: "...") or ctx_batch_execute instead.`;
  }

  return undefined;
}

function extensionFor(path: string): string {
  const lastDot = path.lastIndexOf(".");
  return lastDot === -1 ? "" : path.slice(lastDot).toLowerCase();
}

function readDenialReason(input: Record<string, unknown>): string | undefined {
  const path = typeof input.path === "string" ? input.path : undefined;
  if (!path || IMAGE_EXTENSIONS.has(extensionFor(path))) return undefined;

  const offset = typeof input.offset === "number" ? input.offset : undefined;
  const limit = typeof input.limit === "number" ? input.limit : undefined;
  if (offset !== undefined && limit !== undefined && limit <= MAX_READ_LINES) return undefined;

  try {
    const stat = statSync(path);
    if (stat.isFile() && stat.size <= MAX_READ_BYTES) return undefined;
  } catch {
    return undefined;
  }

  return `Large or unbounded Read of '${path}' violates context-mode routing. Use ctx_execute_file for analysis, or Read with offset+limit <= ${MAX_READ_LINES} when exact text is needed for editing.`;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (existsSync(BYPASS_FILE)) return;

    const toolName = String(event?.toolName ?? "").toLowerCase();
    if (toolName === "read") {
      const reason = readDenialReason((event?.input ?? {}) as Record<string, unknown>);
      if (!reason) return;
      return { block: true, reason: `${reason} Bypass is user-only: touch ${BYPASS_FILE}.` };
    }

    if (toolName !== "bash") return;
    const command = String(event?.input?.command ?? "");
    if (!command.trim()) return;

    const reason = bashDenialReason(command);
    if (!reason) return;
    return { block: true, reason: `${reason} Bypass is user-only: touch ${BYPASS_FILE}.` };
  });
}
