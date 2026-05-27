/**
 * Codeflare Pi native runtime adapter.
 *
 * Provides Pi-native equivalents for Codeflare's Claude Code commands and
 * hooks while keeping the canonical workflow prose in shared preseed skills.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { graphifyClonePromptDecision, isFailedToolExecution, renderGraphifyCloneDirective } from "./graphify-helpers";

const CACHE_DIR = "/home/user/.cache/codeflare-hooks";
const ACTIVE_REPO_FILE = join(CACHE_DIR, "graphify-active-cwd");
const VAULT_ROOT = "/home/user/Vault";
const GLOBAL_GRAPH_LOCK = "/tmp/graphify-global.lock";
const GRAPHIFY_BYPASS = "/tmp/graphify-bypass";

function ensureCacheDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
}

function findGitRoot(startDir: string): string | undefined {
  let current = startDir;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function shell(command: string, cwd: string): string {
  return execFileSync("bash", ["-lc", command], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function currentBranch(repo: string): string | undefined {
  try {
    return shell("git branch --show-current", repo) || undefined;
  } catch {
    return undefined;
  }
}

function updateActiveRepoFromPath(path: string): string | undefined {
  const repo = findGitRoot(path);
  if (!repo) return undefined;
  ensureCacheDir();
  writeFileSync(ACTIVE_REPO_FILE, repo + "\n", "utf8");
  return repo;
}

function activeRepo(ctx: ExtensionContext): string | undefined {
  try {
    if (existsSync(ACTIVE_REPO_FILE)) {
      const value = readFileSync(ACTIVE_REPO_FILE, "utf8").trim();
      if (value && existsSync(value)) return value;
    }
  } catch {
    // Fall through to cwd discovery.
  }
  return updateActiveRepoFromPath(ctx.sessionManager.getCwd());
}

function hasGraph(repo: string): boolean {
  return existsSync(join(repo, "graphify-out", "graph.json"));
}

function graphSummary(repo: string): string | undefined {
  const graphPath = join(repo, "graphify-out", "graph.json");
  if (!existsSync(graphPath)) return undefined;
  try {
    const graph = JSON.parse(readFileSync(graphPath, "utf8")) as { nodes?: unknown[]; links?: unknown[]; edges?: unknown[] };
    const nodes = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
    const links = Array.isArray(graph.links) ? graph.links.length : Array.isArray(graph.edges) ? graph.edges.length : 0;
    return `Graphify graph available for ${basename(repo)}: ${nodes} nodes, ${links} links at ${graphPath}. Prefer graphify query tools for architecture/dependency/call-flow questions before broad text search.`;
  } catch {
    return `Graphify graph available for ${basename(repo)} at ${graphPath}. Prefer graphify query tools for architecture/dependency/call-flow questions before broad text search.`;
  }
}

function isStructuralSearch(command: string): boolean {
  return /(^|[;&|]\s*)(rg|grep|ag|ack)\b/.test(command) || /(^|[;&|]\s*)git\s+grep\b/.test(command) || /(^|[;&|]\s*)find\b.*\s-(name|path|iname|ipath|regex)\b/.test(command) || /(^|[;&|]\s*)awk\b[^;&|]*\/.+\//.test(command);
}

function isGraphifyQuery(command: string): boolean {
  return /(^|[;&|]\s*)graphify\s+(query|path|explain)\b/.test(command);
}

function isGraphifyTool(toolName: string): boolean {
  return ["graphify_query", "graphify_path", "graphify_explain"].includes(toolName);
}

function commandText(event: any): string {
  const input = event?.input ?? event?.params ?? event?.args ?? {};
  if (typeof input.command === "string") return input.command;
  if (typeof input.code === "string") return input.code;
  if (Array.isArray(input.commands)) return input.commands.map((cmd: any) => String(cmd?.command ?? "")).join("\n");
  return "";
}

function isGitClone(command: string): boolean {
  return /(^|[;&|]\s*)git\s+clone\b/.test(command) || /(^|[;&|]\s*)gh\s+repo\s+clone\b/.test(command);
}

function isGitPush(command: string): boolean {
  return /(^|[;&|]\s*)git\s+push\b/.test(command);
}

function ensureNoAttributedCommit(command: string): string | undefined {
  if (!/(^|[;&|]\s*)(git\s+commit|gh\s+pr\s+create)\b/.test(command)) return undefined;
  if (/Co-Authored-By:|Generated with|🤖|🧠|Claude|ChatGPT/i.test(command)) {
    return "Codeflare blocks AI attribution in commits/PRs. Remove Co-Authored-By, generated-by text, and emoji attribution.";
  }
  return undefined;
}

function ensureNoLocalBuild(command: string): string | undefined {
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|typecheck|dev)\b/.test(command)) {
    return "Local builds/tests/linters/dev servers are blocked in the 1-CPU container. Push and verify with CI instead.";
  }
  if (/\b(pytest|vitest|go\s+test|swift\s+test|cargo\s+test|tsc|eslint|wrangler\s+dev)\b/.test(command)) {
    return "Local test/build/lint/dev commands are blocked in the 1-CPU container. Push and verify with CI instead.";
  }
  return undefined;
}

function skillPrompt(name: string, fallback: string): string {
  const candidates = [
    join(process.cwd(), ".pi", "agent", "skills", name, "SKILL.md"),
    join("/home/user/.pi/agent/skills", name, "SKILL.md"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return fallback;
}

async function sendWorkflowMessage(ctx: ExtensionCommandContext, title: string, body: string): Promise<void> {
  await ctx.waitForIdle();
  await ctx.sendUserMessage(`${title}\n\n${body}`);
}

function maybeMergeGlobalGraph(repo: string): void {
  const graph = join(repo, "graphify-out", "graph.json");
  if (!existsSync(graph)) return;
  try {
    execFileSync("flock", ["-w", "5", GLOBAL_GRAPH_LOCK, "graphify", "global", "add", graph, "--as", basename(repo)], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    // Best effort; graphify CLI or global graph may be unavailable.
  }
}

function newestVaultMtime(): number | undefined {
  if (!existsSync(VAULT_ROOT)) return undefined;
  let newest = 0;
  const stack = [VAULT_ROOT];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (path.includes("/graphify-out/") || path.includes("/.silverbullet/")) continue;
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && /\.(md|txt|json|yaml|yml)$/i.test(entry.name)) newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest || undefined;
}

export default function (pi: ExtensionAPI) {
  let searchCountThisTurn = 0;
  let graphifyCountThisTurn = 0;
  const toolStartArgs = new Map<string, any>();

  function toolEventId(event: any): string | undefined {
    const id = event?.toolCallId ?? event?.toolUseId ?? event?.id;
    return typeof id === "string" ? id : undefined;
  }

  function withStartArgs(event: any): any {
    const id = toolEventId(event);
    const cached = id ? toolStartArgs.get(id) : undefined;
    if (id) toolStartArgs.delete(id);
    if (commandText(event) || !cached) return event;
    const current = event?.args ?? event?.input ?? event?.params ?? {};
    return { ...event, args: { ...cached, ...current } };
  }

  pi.registerCommand("sdd", {
    description: "Run Codeflare specification-driven development workflow",
    handler: async (args, ctx) => {
      const subcommand = args.trim().split(/\s+/, 1)[0] || "help";
      const skill = subcommand === "init" ? "sdd-init" : subcommand === "clean" ? "sdd-clean" : "spec-driven-development";
      await sendWorkflowMessage(ctx, `/sdd ${args}`.trim(), `${skillPrompt(skill, "Use the Codeflare SDD workflow.")}\n\nUser command: /sdd ${args}`);
    },
  });

  pi.registerCommand("codeflare-graphify", {
    description: "Run Codeflare graphify workflow without shadowing the Pi graphify package command",
    handler: async (args, ctx) => {
      const repo = activeRepo(ctx) ?? ctx.sessionManager.getCwd();
      if (args.trim() === "refresh") {
        await sendWorkflowMessage(ctx, "/graphify refresh", `Refresh the graphify graph for ${repo}. Use the safe AST-only update first, then merge ${repo}/graphify-out/graph.json into the global graph if present.`);
        return;
      }
      await sendWorkflowMessage(ctx, `/graphify ${args}`.trim(), `${skillPrompt("graphify", "Use graphify to build/query the project graph.")}\n\nTarget repo: ${repo}\nUser command: /graphify ${args}`);
    },
  });

  pi.registerCommand("vault", {
    description: "Run Codeflare vault operations",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      await sendWorkflowMessage(ctx, `/vault ${action}`, `${skillPrompt("vault-operations", "Use Codeflare vault operations.")}\n\nIf action is index, update the Vault graph at ~/Vault/graphify-out and merge it into the global graph.`);
    },
  });

  pi.registerCommand("note", {
    description: "Capture a note into the persistent Vault",
    handler: async (args, ctx) => {
      await sendWorkflowMessage(ctx, `/note ${args}`.trim(), `${skillPrompt("vault-note-capture", "Capture the user's note into ~/Vault/Notes.")}\n\nNote text: ${args}`);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const repo = activeRepo(ctx);
    if (repo) maybeMergeGlobalGraph(repo);
    const summary = repo ? graphSummary(repo) : undefined;
    if (summary) ctx.ui.notify(summary, "info");
  });

  pi.on("before_agent_start", (event, ctx) => {
    const repo = activeRepo(ctx);
    const parts = [String(event?.systemPrompt ?? "")];
    if (repo) {
      const summary = graphSummary(repo);
      if (summary) parts.push(`<codeflare_graphify>\n${summary}\n</codeflare_graphify>`);
    }
    const vaultMtime = newestVaultMtime();
    if (vaultMtime) {
      parts.push(`<codeflare_vault>\nVault exists at ${VAULT_ROOT}. Use vault-note-capture for note requests. If vault files changed and graph context matters, run /vault index.\n</codeflare_vault>`);
    }
    return { systemPrompt: parts.filter(Boolean).join("\n\n") };
  });

  const onToolStart = (event: any, ctx: any) => {
    const toolName = String(event?.toolName ?? "").toLowerCase();
    const command = commandText(event);

    if (isGraphifyTool(toolName) || isGraphifyQuery(command)) {
      graphifyCountThisTurn++;
      return;
    }

    const isShellSurface = toolName === "bash" || toolName.includes("ctx_execute") || toolName.includes("ctx_batch_execute") || toolName.includes("ctx_execute_file");
    if (isShellSurface) {
      const attributionReason = ensureNoAttributedCommit(command);
      if (attributionReason) return { block: true, reason: attributionReason };
      const buildReason = ensureNoLocalBuild(command);
      if (buildReason) return { block: true, reason: buildReason };
    }

    if (isShellSurface && command && isStructuralSearch(command)) {
      searchCountThisTurn++;
      if (existsSync(GRAPHIFY_BYPASS)) {
        try { unlinkSync(GRAPHIFY_BYPASS); } catch { /* best effort */ }
        return;
      }
      const repo = activeRepo(ctx);
      if (repo && hasGraph(repo) && searchCountThisTurn >= 3 && graphifyCountThisTurn === 0) {
        return { block: true, reason: `Graphify graph exists for ${basename(repo)}. Query graphify_query, graphify_path, or graphify_explain before more structural searches, or ask the user to create ${GRAPHIFY_BYPASS}.` };
      }
    }
  };

  pi.on("tool_call", onToolStart);
  pi.on("tool_execution_start", (event: any, ctx: any) => {
    const id = toolEventId(event);
    if (id) toolStartArgs.set(id, event?.args ?? event?.input ?? event?.params ?? {});
    return onToolStart(event, ctx);
  });

  const onToolEnd = (event: any, ctx: any) => {
    const command = commandText(event);
    const cwd = ctx.sessionManager.getCwd();
    const decision = isGitClone(command)
      ? graphifyClonePromptDecision({
        command,
        cwd,
        sessionId: String(ctx.sessionManager?.getSessionId?.() ?? process.ppid),
        failed: isFailedToolExecution(event),
        findGitRoot,
        hasGraph,
      })
      : undefined;
    const repo = updateActiveRepoFromPath(decision?.repo ?? cwd);

    if (repo && hasGraph(repo)) maybeMergeGlobalGraph(repo);

    if (decision && !existsSync(decision.marker)) {
      writeFileSync(decision.marker, "1", "utf8");
      pi.sendUserMessage(renderGraphifyCloneDirective(decision.action), { deliverAs: "followUp" });
    }

  };

  pi.on("tool_result", onToolEnd);
  pi.on("tool_execution_end", (event: any, ctx: any) => onToolEnd(withStartArgs(event), ctx));

  pi.on("agent_end", (_event, _ctx) => {
    searchCountThisTurn = 0;
    graphifyCountThisTurn = 0;
  });
}
