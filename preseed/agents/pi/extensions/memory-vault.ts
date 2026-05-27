/**
 * Codeflare Pi memory/vault graph automation.
 *
 * Native Pi counterpart to Claude's memory-capture and vault-monitor hooks.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const USER_HOME = "/home/user";
const VAULT_ROOT = join(USER_HOME, "Vault");
const CACHE_DIR = join(USER_HOME, ".cache", "codeflare-hooks");
const MEMORY_COUNTER_DIR = "/tmp/.memory-counter";
const MEMORY_PROMPT_FILE = join(CACHE_DIR, "pi-memory-agent-prompt.md");
const VAULT_PROMPT_FILE = join(CACHE_DIR, "pi-vault-extract-prompt.md");
const VAULT_MARKER_FILE = join(CACHE_DIR, "pi-vault-extract.last");
const VAULT_VARS_FILE = join(CACHE_DIR, "vault-extract.vars");
const GLOBAL_GRAPH_LOCK = "/tmp/graphify-global.lock";
const MEMORY_EVERY_N_PROMPTS = 15;

function ensureDirs(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(MEMORY_COUNTER_DIR, { recursive: true });
  mkdirSync(join(VAULT_ROOT, "Raw", "Sessions"), { recursive: true });
}

function shell(command: string, cwd = USER_HOME): string {
  return execFileSync("bash", ["-lc", command], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function subagentsService(): any | undefined {
  return (globalThis as Record<symbol, unknown>)[Symbol.for("@gotgenes/pi-subagents:service")];
}

function spawn(type: string, prompt: string, description: string): string | undefined {
  const service = subagentsService();
  if (!service?.spawn) return undefined;
  try {
    const id = service.spawn(type, prompt, { description, inheritContext: false });
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

function sessionId(ctx: any): string {
  return String(ctx?.sessionManager?.getSessionId?.() ?? process.ppid).replace(/[^A-Za-z0-9_.-]+/g, "_");
}

function counterPath(id: string): string {
  return join(MEMORY_COUNTER_DIR, `${id}.count`);
}

function varsPath(id: string): string {
  return join(MEMORY_COUNTER_DIR, `${id}.vars`);
}

function readCount(path: string): number {
  try { return Number.parseInt(readFileSync(path, "utf8").trim(), 10) || 0; } catch { return 0; }
}

function writePromptFiles(): void {
  writeFileSync(MEMORY_PROMPT_FILE, [
    "# Pi memory capture contract",
    "",
    "1. Delete VARS_FILE first to drain the dedup gate.",
    "2. Read the transcript slice in VARS_FILE.",
    "3. Extract durable observations only: user preferences, decisions, errors and fixes, open blockers, plans, commit/PR/head facts, rejected approaches, and important file paths.",
    "4. Write a detailed markdown note under /home/user/Vault/Raw/Sessions/ with an ISO timestamp filename.",
    "5. If graphify is available, update the Vault graph and merge /home/user/Vault/graphify-out/graph.json into the global graph under the user_vault label. Use best effort and never block the main turn.",
  ].join("\n"), "utf8");

  writeFileSync(VAULT_PROMPT_FILE, [
    "# Pi vault extraction contract",
    "",
    "1. Delete VARS_FILE first to drain the dedup gate.",
    "2. Read the changed Vault file list in VARS_FILE.",
    "3. Build or update /home/user/Vault/graphify-out/graph.json from the changed notes using graphify where available.",
    "4. Preserve the existing user_vault subgraph; merge new nodes/edges monotonically.",
    "5. Merge the Vault graph into the global graph under the user_vault label and advance the high-water marker only after a successful extraction attempt.",
  ].join("\n"), "utf8");
}

function compactMessages(messages: any[]): string {
  return messages.slice(-40).map((message) => {
    const role = message?.role ?? message?.message?.role ?? "unknown";
    const content = message?.content ?? message?.message?.content ?? "";
    return `## ${role}\n${typeof content === "string" ? content : JSON.stringify(content).slice(0, 6000)}`;
  }).join("\n\n");
}

function newestVaultMtime(): number {
  if (!existsSync(VAULT_ROOT)) return 0;
  let newest = 0;
  const stack = [VAULT_ROOT];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (path.includes("/graphify-out/") || path.includes("/.silverbullet/") || path.includes("/Library/")) continue;
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && /\.(md|txt|json|yaml|yml|pdf)$/i.test(entry.name)) newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
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
      if (path.includes("/graphify-out/") || path.includes("/.silverbullet/") || path.includes("/Library/")) continue;
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && /\.(md|txt|json|yaml|yml|pdf)$/i.test(entry.name) && statSync(path).mtimeMs > since) changed.push(path);
    }
  }
  return changed.sort();
}

function readVaultMarker(): number {
  try { return Number.parseFloat(readFileSync(VAULT_MARKER_FILE, "utf8").trim()) || 0; } catch { return 0; }
}

function bestEffortMergeGraphs(): void {
  const vaultGraph = join(VAULT_ROOT, "graphify-out", "graph.json");
  if (existsSync(vaultGraph)) {
    try { shell(`flock -w 5 ${GLOBAL_GRAPH_LOCK} graphify global add ${JSON.stringify(vaultGraph)} --as user_vault`, VAULT_ROOT); } catch { /* best effort */ }
  }
  try {
    const repo = readFileSync(join(CACHE_DIR, "graphify-active-cwd"), "utf8").trim();
    const repoGraph = join(repo, "graphify-out", "graph.json");
    if (repo && existsSync(repoGraph)) shell(`flock -w 5 ${GLOBAL_GRAPH_LOCK} graphify global add ${JSON.stringify(repoGraph)} --as ${JSON.stringify(basename(repo))}`, repo);
  } catch { /* best effort */ }
}

export default function (pi: ExtensionAPI) {
  let lastMessages: any[] = [];

  pi.on("session_start", () => {
    ensureDirs();
    writePromptFiles();
    bestEffortMergeGraphs();
    const newest = newestVaultMtime();
    if (!existsSync(VAULT_MARKER_FILE)) writeFileSync(VAULT_MARKER_FILE, String(newest), "utf8");
  });

  pi.on("before_agent_start", (event: any, ctx: any) => {
    ensureDirs();
    writePromptFiles();
    const id = sessionId(ctx);
    const path = counterPath(id);
    const count = readCount(path) + 1;
    writeFileSync(path, String(count), "utf8");
    if (count % MEMORY_EVERY_N_PROMPTS !== 0) return;

    const vars = varsPath(id);
    writeFileSync(vars, JSON.stringify({
      PROMPT_FILE: MEMORY_PROMPT_FILE,
      VARS_FILE: vars,
      sessionId: id,
      promptCount: count,
      latestPrompt: String(event?.prompt ?? ""),
      transcript: compactMessages(lastMessages),
    }, null, 2), "utf8");

    const prompt = `PROMPT_FILE=${MEMORY_PROMPT_FILE}\nVARS_FILE=${vars}\nRun the Pi memory-capture contract. Delete VARS_FILE first, write the capture under /home/user/Vault/Raw/Sessions/, then best-effort update and merge the Vault/global graph.`;
    const spawned = spawn("memory-capture", prompt, "Capture session memory");
    if (!spawned) pi.sendUserMessage(`Agent({ subagent_type: "memory-capture", prompt: ${JSON.stringify(prompt)}, description: "Capture session memory", run_in_background: false })`, { deliverAs: "followUp" });
  });

  pi.on("agent_end", (event: any, ctx: any) => {
    lastMessages = Array.isArray(event?.messages) ? event.messages : lastMessages;
    ensureDirs();
    const previous = readVaultMarker();
    const changed = changedVaultFiles(previous);
    if (changed.length === 0) {
      const newest = newestVaultMtime();
      if (newest > previous) writeFileSync(VAULT_MARKER_FILE, String(newest), "utf8");
      return;
    }

    const newest = Math.max(...changed.map((path) => statSync(path).mtimeMs));
    writeFileSync(VAULT_VARS_FILE, JSON.stringify({
      PROMPT_FILE: VAULT_PROMPT_FILE,
      VARS_FILE: VAULT_VARS_FILE,
      changedFiles: changed,
      vaultRoot: VAULT_ROOT,
      graphPath: join(VAULT_ROOT, "graphify-out", "graph.json"),
    }, null, 2), "utf8");

    const prompt = `PROMPT_FILE=${VAULT_PROMPT_FILE}\nVARS_FILE=${VAULT_VARS_FILE}\nChanged files:\n${changed.slice(0, 80).join("\n")}\nRun the Pi vault-extract contract, then update ${VAULT_MARKER_FILE} to ${newest}.`;
    const spawned = spawn("vault-extract", prompt, "Extract Vault graph changes");
    if (!spawned) pi.sendUserMessage(`Agent({ subagent_type: "vault-extract", prompt: ${JSON.stringify(prompt)}, description: "Extract Vault graph changes", run_in_background: false })`, { deliverAs: "followUp" });
    bestEffortMergeGraphs();
  });
}
