/**
 * Codeflare Pi memory/vault graph automation.
 *
 * Native Pi counterpart to Claude's memory-capture and vault-monitor hooks.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSpawnOptions, captureTimestamp, compactMessages as compactMessagesHelper, isFirstMessage, isResumedSession, parseSessionMessages as parseSessionMessagesHelper, realUserPromptCount, sessionId as sessionIdHelper, shouldCapture, withCurrentPrompt } from "./memory-vault-helpers";

const USER_HOME = "/home/user";
const VAULT_ROOT = join(USER_HOME, "Vault");
const CACHE_DIR = join(USER_HOME, ".cache", "codeflare-hooks");
const MEMORY_COUNTER_DIR = "/tmp/.memory-counter";
const PROMPTS_DIR = join(USER_HOME, ".pi", "agent", "prompts");
const MEMORY_PROMPT_FILE = join(PROMPTS_DIR, "memory-agent-prompt.md");
const VAULT_PROMPT_FILE = join(PROMPTS_DIR, "vault-extract-prompt.md");
// Share Claude's high-water marker name and mtime semantics: the marker's mtime,
// not file contents, is the source of truth for vault-change detection.
const VAULT_MARKER_FILE = join(CACHE_DIR, "vault-extract.last");
// Pi-namespaced sentinels. The Claude vault-monitor daemon (entrypoint.sh,
// runs whenever SESSION_MODE=advanced, NOT runtime-gated) writes the
// shared-namespace ~/.cache/codeflare-hooks/vault-extract.vars on any vault
// change. Under Claude its UserPromptSubmit hook consumes that file; under Pi
// nothing does, so if Pi read the same path the daemon's orphaned vars would
// wedge vaultVarsPending() forever. Pi therefore owns its own vars/in-flight
// files and only SHARES vault-extract.last (above) — advancing that marker
// each turn makes the daemon's own `find -newer` come up empty, so it stays
// quiet instead of fighting Pi for the sentinel.
const VAULT_VARS_FILE = join(CACHE_DIR, "vault-extract.pi.vars");
const VAULT_INFLIGHT = join(CACHE_DIR, "vault-extract.pi.in-flight");
const GLOBAL_GRAPH_LOCK = "/tmp/graphify-global.lock";
const VAULT_EXTRACT_INFLIGHT_TTL_MS = 5 * 60 * 1000;
const VAULT_PRESEED_ROOT_FILES = new Set(["Index.md", "README.md", "CONFIG.md", "STYLES.md"]);

function ensureDirs(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(MEMORY_COUNTER_DIR, { recursive: true });
  mkdirSync(join(VAULT_ROOT, "Raw", "Sessions"), { recursive: true });
}

function addGraphToGlobal(graph: string, tag: string, cwd: string): void {
  execFileSync("flock", ["-w", "5", GLOBAL_GRAPH_LOCK, "graphify", "global", "add", graph, "--as", tag], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function subagentsService(): any | undefined {
  return (globalThis as Record<symbol, unknown>)[Symbol.for("@gotgenes/pi-subagents:service")];
}

function spawn(type: string, prompt: string, description: string, model?: string): string | undefined {
  const service = subagentsService();
  if (!service?.spawn) return undefined;
  try {
    // buildSpawnOptions applies the optional model only when set (no hardcoded model name);
    // the model is sourced from CODEFLARE_MEMORY_MODEL at the call sites below per AD58.
    const id = service.spawn(type, prompt, buildSpawnOptions(description, model));
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

function sessionId(ctx: any): string { return sessionIdHelper(ctx); }
function counterPath(id: string): string { return join(MEMORY_COUNTER_DIR, `${id}.count`); }
function varsPath(id: string): string { return join(MEMORY_COUNTER_DIR, `${id}.vars`); }
function readCount(path: string): number {
  try { return Number.parseInt(readFileSync(path, "utf8").trim(), 10) || 0; } catch { return 0; }
}

function compactMessages(messages: any[]): string { return compactMessagesHelper(messages); }

// Read the durable on-disk session transcript that Pi already persists for /resume
// (the identical source Claude's capture reads from its transcript.jsonl). `lastMessages`
// is volatile module state that is empty right after a Pi reload, which made the first
// capture-boundary prompt after every resume produce an empty "no substantive content"
// note even though the full conversation was sitting on disk the whole time. The session
// file survives the reload, so reading it is the fix. Falls back to the in-memory messages
// if the file is missing or unreadable.
function readSessionMessages(ctx: any, fallback: any[]): any[] {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    if (file && existsSync(file)) {
      // Pi session JSONL entries are { type: "message", message: { role, content } };
      // compactMessages drops non user/assistant roles (e.g. toolResult) downstream.
      const messages = parseSessionMessagesHelper(readFileSync(file, "utf8"));
      if (messages.length > 0) return messages;
    }
  } catch { /* fall through to the in-memory fallback */ }
  return fallback;
}

function isVaultExcludedPath(path: string): boolean {
  const rel = relative(VAULT_ROOT, path).replaceAll("\\", "/");
  if (!rel || rel.startsWith("..")) return true;
  if (VAULT_PRESEED_ROOT_FILES.has(rel)) return true;
  return rel === "Raw/Sessions" || rel.startsWith("Raw/Sessions/")
    || rel === "graphify-out" || rel.startsWith("graphify-out/")
    || rel === ".silverbullet" || rel.startsWith(".silverbullet/");
}

function changedVaultFiles(since: number): string[] {
  if (!existsSync(VAULT_ROOT)) return [];
  const changed: string[] = [];
  const stack = [VAULT_ROOT];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (isVaultExcludedPath(path)) continue;
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && statSync(path).mtimeMs > since) changed.push(path);
    }
  }
  return changed.sort();
}

function readVaultMarker(): number {
  try { return statSync(VAULT_MARKER_FILE).mtimeMs; } catch { return 0; }
}

function touchVaultMarker(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(VAULT_MARKER_FILE, "", "utf8");
}

// The durable cumulative vault graph. It is written ONLY by merge-vault-graph.py
// (under flock) from the vault-extract / memory-capture subagent pipelines, so it
// stays byte-compatible with Claude. The extension never writes it; it only
// re-publishes it to the global graph on session boundaries (bestEffortMergeGraphs).
function vaultGraphPath(): string {
  return join(VAULT_ROOT, "graphify-out", "vault-graph.json");
}

function bestEffortMergeGraphs(): void {
  const vaultGraph = vaultGraphPath();
  if (existsSync(vaultGraph)) {
    try { addGraphToGlobal(vaultGraph, "user_vault", VAULT_ROOT); } catch { /* best effort */ }
  }
  try {
    const repo = readFileSync(join(CACHE_DIR, "graphify-active-cwd"), "utf8").trim();
    const repoGraph = join(repo, "graphify-out", "graph.json");
    if (repo && existsSync(repoGraph)) addGraphToGlobal(repoGraph, basename(repo), repo);
  } catch { /* best effort */ }
}

function currentConversationMessages(ctx: any, fallback: any[], prompt: string): any[] {
  return withCurrentPrompt(readSessionMessages(ctx, fallback), prompt);
}

function captureVars(session: string, count: number, resumed: boolean, prompt: string, messages: any[], tz?: string): string | undefined {
  const transcript = compactMessages(messages);
  if (!transcript.trim()) return undefined;
  const ts = captureTimestamp(tz);
  const filename = `${ts}-${session}.md`;
  const vars = varsPath(session);
  writeFileSync(vars, JSON.stringify({
    PROMPT_FILE: MEMORY_PROMPT_FILE,
    VARS_FILE: vars,
    sessionId: session,
    promptCount: count,
    captureTimestamp: ts,
    captureFilename: filename,
    resumedSession: resumed,
    latestPrompt: prompt,
    transcript,
  }, null, 2), "utf8");
  return vars;
}

function vaultVarsPending(): boolean {
  if (!existsSync(VAULT_VARS_FILE)) return false;
  try {
    if (existsSync(VAULT_MARKER_FILE) && statSync(VAULT_VARS_FILE).mtimeMs <= statSync(VAULT_MARKER_FILE).mtimeMs) {
      unlinkSync(VAULT_VARS_FILE);
      return false;
    }
    // Self-heal a crashed extraction: the subagent deletes vars in step 1, so a
    // vars file older than the in-flight TTL has no live consumer. Treat it as
    // orphaned and clear it rather than letting it wedge the gate indefinitely.
    if (Date.now() - statSync(VAULT_VARS_FILE).mtimeMs > VAULT_EXTRACT_INFLIGHT_TTL_MS) {
      unlinkSync(VAULT_VARS_FILE);
      return false;
    }
  } catch { /* keep the marker if we cannot prove it is stale */ }
  return true;
}

function vaultExtractionInFlight(): boolean {
  if (!existsSync(VAULT_INFLIGHT)) return false;
  try {
    const ageMs = Date.now() - statSync(VAULT_INFLIGHT).mtimeMs;
    if (ageMs < VAULT_EXTRACT_INFLIGHT_TTL_MS) return true;
    unlinkSync(VAULT_INFLIGHT);
  } catch { /* best effort */ }
  return false;
}

export default function (pi: ExtensionAPI) {
  let lastMessages: any[] = [];

  pi.on("session_start", () => {
    ensureDirs();
    bestEffortMergeGraphs();
    // Claude's entrypoint seeds vault-extract.last with a plain `touch` so
    // restored Vault content is the baseline, not a change. Pi must do the same.
    if (!existsSync(VAULT_MARKER_FILE)) touchVaultMarker();
  });

  pi.on("before_agent_start", (event: any, ctx: any) => {
    ensureDirs();
    const prompt = String(event?.prompt ?? "");
    if (prompt.startsWith("Agent(") || prompt.startsWith("PROMPT_FILE=") || prompt.includes('"directive"') || prompt.includes("subagent_type") || prompt.startsWith("[silent]") || prompt.trim().startsWith("<")) return;

    const id = sessionId(ctx);
    const path = counterPath(id);
    const counterExists = existsSync(path);
    const lastCount = counterExists ? readCount(path) : 0;
    const messages = currentConversationMessages(ctx, lastMessages, prompt);
    const currentCount = realUserPromptCount(messages);
    const tz = process.env.TZ || process.env.USER_TIMEZONE || undefined;

    if (isFirstMessage(counterExists, currentCount)) {
      // Brand-new session: baseline only, exactly like Claude's missing-counter + CURRENT_COUNT==1 path.
      writeFileSync(path, String(currentCount), "utf8");
      bestEffortMergeGraphs();
      return;
    }

    if (isResumedSession(counterExists, currentCount)) {
      const vars = captureVars(id, currentCount, true, prompt, messages, tz);
      if (!vars) return;
      // Advance counter before trigger emission, matching Claude's dedup contract.
      writeFileSync(path, String(currentCount), "utf8");
      const p = `PROMPT_FILE=${MEMORY_PROMPT_FILE}\nVARS_FILE=${vars}\nResumed session detected. Capture from transcript start. Use captureFilename from vars for the output file.`;
      const spawned = spawn("memory-capture", p, "Capture resumed session memory", process.env.CODEFLARE_MEMORY_MODEL);
      if (!spawned) pi.sendUserMessage(`Agent({ subagent_type: "memory-capture", prompt: ${JSON.stringify(p)}, description: "Capture resumed session memory", run_in_background: true })`, { deliverAs: "followUp" });
      return;
    }

    const delta = currentCount - lastCount;
    if (!shouldCapture(delta)) return;

    const vars = captureVars(id, currentCount, false, prompt, messages, tz);
    if (!vars) return;
    // Advance counter before trigger emission, matching Claude's dedup contract.
    writeFileSync(path, String(currentCount), "utf8");
    const p = `PROMPT_FILE=${MEMORY_PROMPT_FILE}\nVARS_FILE=${vars}\nRun the Pi memory-capture contract. Use captureFilename from vars for the output file. Write to /home/user/Vault/Raw/Sessions/.`;
    const spawned = spawn("memory-capture", p, "Capture session memory", process.env.CODEFLARE_MEMORY_MODEL);
    if (!spawned) pi.sendUserMessage(`Agent({ subagent_type: "memory-capture", prompt: ${JSON.stringify(p)}, description: "Capture session memory", run_in_background: true })`, { deliverAs: "followUp" });
  });

  pi.on("agent_end", (event: any, ctx: any) => {
    lastMessages = Array.isArray(event?.messages) ? event.messages : lastMessages;
    ensureDirs();

    if (!existsSync(VAULT_MARKER_FILE)) {
      // Same baseline as Claude's boot-time touch: first Pi turn must not
      // interpret restored Vault content as a user edit.
      touchVaultMarker();
      return;
    }

    if (vaultVarsPending() || vaultExtractionInFlight()) return;

    const previous = readVaultMarker();
    const changed = changedVaultFiles(previous);
    if (changed.length === 0) return;

    try {
      // The subagent (spawned below) owns graph construction via the canonical
      // chunk -> merge-vault-graph.py -> vault-graph.json pipeline, exactly like
      // Claude. Here we only re-publish the existing cumulative vault graph and
      // advance the marker; merge-vault-graph.py is the sole writer of vault-graph.json.
      bestEffortMergeGraphs();
      touchVaultMarker();
    } catch {
      return;
    }

    if (vaultVarsPending() || vaultExtractionInFlight()) return;

    try { writeFileSync(VAULT_INFLIGHT, String(Date.now()), "utf8"); } catch { /* best effort */ }
    writeFileSync(VAULT_VARS_FILE, JSON.stringify({
      PROMPT_FILE: VAULT_PROMPT_FILE,
      VARS_FILE: VAULT_VARS_FILE,
      changedFiles: changed,
      vaultRoot: VAULT_ROOT,
      graphPath: join(VAULT_ROOT, "graphify-out", "graph.json"),
      inflightFile: VAULT_INFLIGHT,
    }, null, 2), "utf8");

    const vaultPrompt = `PROMPT_FILE=${VAULT_PROMPT_FILE}\nVARS_FILE=${VAULT_VARS_FILE}\nChanged files:\n${changed.slice(0, 80).join("\n")}\nThe Pi extension already touched ${VAULT_MARKER_FILE}. Run the Pi vault-extract contract end to end: read the changed files, author a chunk, run merge-vault-graph.py to fold it into the cumulative vault-graph.json, publish that to the global graph, and re-render the viz. Do not update the marker (the extension owns it).`;
    const spawned = spawn("vault-extract", vaultPrompt, "Extract Vault graph changes", process.env.CODEFLARE_MEMORY_MODEL);
    if (!spawned) pi.sendUserMessage(`Agent({ subagent_type: "vault-extract", prompt: ${JSON.stringify(vaultPrompt)}, description: "Extract Vault graph changes", run_in_background: true })`, { deliverAs: "followUp" });
    bestEffortMergeGraphs();
  });
}
