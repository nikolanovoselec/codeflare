/**
 * Codeflare Pi memory/vault graph automation.
 *
 * Native Pi counterpart to Claude's memory-capture and vault-monitor hooks.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureFilename, captureTimestamp, compactMessages as compactMessagesHelper, isFirstMessage, isResumedSession, MEMORY_EVERY_N_PROMPTS, sessionId as sessionIdHelper, shouldCapture, stableId as stableIdHelper, titleFor as titleForHelper } from "./memory-vault-helpers";

const USER_HOME = "/home/user";
const VAULT_ROOT = join(USER_HOME, "Vault");
const CACHE_DIR = join(USER_HOME, ".cache", "codeflare-hooks");
const MEMORY_COUNTER_DIR = "/tmp/.memory-counter";
const MEMORY_PROMPT_FILE = join(CACHE_DIR, "pi-memory-agent-prompt.md");
const VAULT_PROMPT_FILE = join(CACHE_DIR, "pi-vault-extract-prompt.md");
const VAULT_MARKER_FILE = join(CACHE_DIR, "pi-vault-extract.last");
const VAULT_VARS_FILE = join(CACHE_DIR, "vault-extract.vars");
const VAULT_INFLIGHT = join(CACHE_DIR, "vault-extract.inflight");
const GLOBAL_GRAPH_LOCK = "/tmp/graphify-global.lock";

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

function sessionId(ctx: any): string { return sessionIdHelper(ctx); }
function counterPath(id: string): string { return join(MEMORY_COUNTER_DIR, `${id}.count`); }
function varsPath(id: string): string { return join(MEMORY_COUNTER_DIR, `${id}.vars`); }
function readCount(path: string): number {
  try { return Number.parseInt(readFileSync(path, "utf8").trim(), 10) || 0; } catch { return 0; }
}

function writePromptFiles(): void {
  writeFileSync(MEMORY_PROMPT_FILE, [
    "# Pi memory capture contract",
    "",
    "1. Read VARS_FILE into memory.",
    "2. Immediately delete VARS_FILE to drain the dedup gate.",
    "3. Extract durable observations only: user preferences, decisions, errors and fixes, open blockers, plans, commit/PR/head facts, rejected approaches, and important file paths.",
    "4. Write a detailed markdown note under /home/user/Vault/Raw/Sessions/ with an ISO timestamp filename.",
    "5. If graphify is available, update the Vault graph and merge /home/user/Vault/graphify-out/graph.json into the global graph under the user_vault label. Use best effort and never block the main turn.",
  ].join("\n"), "utf8");

  writeFileSync(VAULT_PROMPT_FILE, [
    "# Pi vault extraction contract",
    "",
    "1. Read VARS_FILE into memory.",
    "2. Immediately delete VARS_FILE to drain the dedup gate.",
    "3. Use the changed Vault file list from the in-memory vars payload.",
    "4. Enrich /home/user/Vault/graphify-out/graph.json from the changed notes when available tooling permits.",
    "5. Preserve the existing user_vault subgraph; merge new nodes/edges monotonically.",
    "6. Do not advance the high-water marker; the Pi extension advances it only after its deterministic graph write and global merge attempt.",
  ].join("\n"), "utf8");
}

function compactMessages(messages: any[]): string { return compactMessagesHelper(messages); }

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

function vaultGraphPath(): string {
  return join(VAULT_ROOT, "graphify-out", "graph.json");
}

function stableId(input: string): string { return stableIdHelper(input); }

function readGraph(): { nodes: any[]; links: any[] } {
  try {
    const graph = JSON.parse(readFileSync(vaultGraphPath(), "utf8"));
    return {
      nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
      links: Array.isArray(graph.links) ? graph.links : Array.isArray(graph.edges) ? graph.edges : [],
    };
  } catch {
    return { nodes: [], links: [] };
  }
}

function titleFor(path: string, content: string): string { return titleForHelper(path, content); }

function writeDeterministicVaultGraph(changed: string[]): void {
  const graph = readGraph();
  const nodes = new Map(graph.nodes.map((node) => [String(node.id), node]));
  const changedDocIds = new Set(changed.map((path) => stableId(relative(VAULT_ROOT, path))));
  const nextLinks = graph.links.filter((link) => {
    const source = String(link.source ?? link.from ?? "");
    return !changedDocIds.has(source);
  });

  for (const path of changed) {
    const rel = relative(VAULT_ROOT, path);
    const docId = stableId(rel);
    changedDocIds.add(docId);
    const isText = /\.(md|txt|json|yaml|yml)$/i.test(path);
    const content = isText ? readFileSync(path, "utf8") : "";
    nodes.set(docId, {
      id: docId,
      label: titleFor(path, content),
      type: /\.pdf$/i.test(path) ? "document" : "note",
      path,
      source: "user_vault",
    });
    if (isText) {
      for (const match of content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
        const targetLabel = match[1].trim();
        if (!targetLabel) continue;
        const targetId = stableId(`concept:${targetLabel}`);
        nodes.set(targetId, { id: targetId, label: targetLabel, type: "concept", source: "user_vault" });
        nextLinks.push({ source: docId, target: targetId, type: "mentions" });
      }
    }
  }

  mkdirSync(dirname(vaultGraphPath()), { recursive: true });
  writeFileSync(vaultGraphPath(), JSON.stringify({ nodes: [...nodes.values()], links: nextLinks }, null, 2) + "\n", "utf8");
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

export default function (pi: ExtensionAPI) {
  let lastMessages: any[] = [];

  pi.on("session_start", () => {
    ensureDirs();
    writePromptFiles();
    bestEffortMergeGraphs();
    if (!existsSync(VAULT_MARKER_FILE)) writeFileSync(VAULT_MARKER_FILE, "0", "utf8");
  });

  pi.on("before_agent_start", (event: any, ctx: any) => {
    ensureDirs();
    writePromptFiles();
    const prompt = String(event?.prompt ?? "");
    if (prompt.startsWith("Agent(") || prompt.startsWith("PROMPT_FILE=") || prompt.includes('"directive"') || prompt.includes("subagent_type") || prompt.startsWith("[silent]")) return;

    const id = sessionId(ctx);
    const path = counterPath(id);
    const counterExists = existsSync(path);
    const count = readCount(path) + 1;
    writeFileSync(path, String(count), "utf8");

    const tz = process.env.TZ || process.env.USER_TIMEZONE || undefined;

    if (isFirstMessage(counterExists, count)) {
      bestEffortMergeGraphs();
      return;
    }

    if (isResumedSession(counterExists, count)) {
      const ts = captureTimestamp(tz);
      const filename = captureFilename(id, tz);
      const vars = varsPath(id);
      writeFileSync(vars, JSON.stringify({
        PROMPT_FILE: MEMORY_PROMPT_FILE,
        VARS_FILE: vars,
        sessionId: id,
        promptCount: count,
        captureTimestamp: ts,
        captureFilename: filename,
        resumedSession: true,
        latestPrompt: prompt,
        transcript: compactMessages(lastMessages),
      }, null, 2), "utf8");

      const p = `PROMPT_FILE=${MEMORY_PROMPT_FILE}\nVARS_FILE=${vars}\nResumed session detected. Capture from transcript start. Use captureFilename from vars for the output file.`;
      const spawned = spawn("memory-capture", p, "Capture resumed session memory");
      if (!spawned) pi.sendUserMessage(`Agent({ subagent_type: "memory-capture", prompt: ${JSON.stringify(p)}, description: "Capture resumed session memory", run_in_background: false })`, { deliverAs: "followUp" });
      return;
    }

    if (!shouldCapture(count)) return;

    const ts = captureTimestamp(tz);
    const filename = captureFilename(id, tz);
    const vars = varsPath(id);
    writeFileSync(vars, JSON.stringify({
      PROMPT_FILE: MEMORY_PROMPT_FILE,
      VARS_FILE: vars,
      sessionId: id,
      promptCount: count,
      captureTimestamp: ts,
      captureFilename: filename,
      resumedSession: false,
      latestPrompt: prompt,
      transcript: compactMessages(lastMessages),
    }, null, 2), "utf8");

    const p = `PROMPT_FILE=${MEMORY_PROMPT_FILE}\nVARS_FILE=${vars}\nRun the Pi memory-capture contract. Use captureFilename from vars for the output file. Write to /home/user/Vault/Raw/Sessions/.`;
    const spawned = spawn("memory-capture", p, "Capture session memory");
    if (!spawned) pi.sendUserMessage(`Agent({ subagent_type: "memory-capture", prompt: ${JSON.stringify(p)}, description: "Capture session memory", run_in_background: false })`, { deliverAs: "followUp" });
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
    try {
      writeDeterministicVaultGraph(changed);
      bestEffortMergeGraphs();
      writeFileSync(VAULT_MARKER_FILE, String(newest), "utf8");
    } catch {
      return;
    }

    if (existsSync(VAULT_VARS_FILE) || existsSync(VAULT_INFLIGHT)) return;

    try { writeFileSync(VAULT_INFLIGHT, String(Date.now()), "utf8"); } catch { /* best effort */ }
    writeFileSync(VAULT_VARS_FILE, JSON.stringify({
      PROMPT_FILE: VAULT_PROMPT_FILE,
      VARS_FILE: VAULT_VARS_FILE,
      changedFiles: changed,
      vaultRoot: VAULT_ROOT,
      graphPath: join(VAULT_ROOT, "graphify-out", "graph.json"),
    }, null, 2), "utf8");

    const vaultPrompt = `PROMPT_FILE=${VAULT_PROMPT_FILE}\nVARS_FILE=${VAULT_VARS_FILE}\nChanged files:\n${changed.slice(0, 80).join("\n")}\nThe Pi extension already wrote the deterministic Vault graph and advanced ${VAULT_MARKER_FILE} to ${newest}. Run the Pi vault-extract contract only for optional semantic enrichment; do not run Python/processing shell commands and do not update the marker.`;
    const spawned = spawn("vault-extract", vaultPrompt, "Extract Vault graph changes");
    if (!spawned) pi.sendUserMessage(`Agent({ subagent_type: "vault-extract", prompt: ${JSON.stringify(vaultPrompt)}, description: "Extract Vault graph changes", run_in_background: false })`, { deliverAs: "followUp" });
    try { unlinkSync(VAULT_INFLIGHT); } catch { /* best effort */ }
    bestEffortMergeGraphs();
  });
}
