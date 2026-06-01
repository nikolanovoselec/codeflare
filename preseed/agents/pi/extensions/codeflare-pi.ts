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
import { cloneTargetPath, effectiveCwdForCommand, graphifyClonePromptDecision, isFailedToolExecution, renderGraphifyCloneDirective } from "./graphify-helpers";
import { sddCommandDecision, type SddRepoState, SDD_HELP_TEXT } from "./sdd-helpers";
import { attributionBlockReason, localBuildBlockReason } from "./guard-helpers";

const CACHE_DIR = "/home/user/.cache/codeflare-hooks";
const ACTIVE_REPO_FILE = join(CACHE_DIR, "graphify-active-cwd");
const VAULT_ROOT = "/home/user/Vault";
const GLOBAL_GRAPH_LOCK = "/tmp/graphify-global.lock";
const PI_SETTINGS_FILE = "/home/user/.pi/agent/settings.json";
const CONTEXT_MODE_PACKAGE = "npm:context-mode@1.0.151";
const CONTEXT_MODE_PACKAGE_ID = "npm:context-mode";
const CONTEXT_MODE_DISABLED_PACKAGE = { source: CONTEXT_MODE_PACKAGE, extensions: [], skills: [] };

type PiSettings = {
  packages?: Array<string | { source?: string; extensions?: string[]; skills?: string[]; [key: string]: unknown }>;
  extensions?: string[];
  [key: string]: unknown;
};

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
  return execFileSync("bash", ["-lc", command], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
}

function currentBranch(repo: string): string | undefined {
  try {
    return shell("git branch --show-current", repo) || undefined;
  } catch {
    return undefined;
  }
}

function currentHead(repo: string): string | undefined {
  try {
    return shell("git rev-parse HEAD", repo) || undefined;
  } catch {
    return undefined;
  }
}

function unquoteShellToken(value: string): string {
  return value.trim().replace(/^("|')(.*)\1$/, "$2");
}

function effectivePathForCommand(command: string, cwd: string): string {
  const gitC = command.match(/(?:^|[;&|\n]\s*)git\s+-C\s+("[^"]+"|'[^']+'|[^\s;&|\n]+)/);
  if (gitC?.[1]) return resolve(cwd, unquoteShellToken(gitC[1]));
  return resolve(effectiveCwdForCommand(command, cwd));
}

function repoIdentity(repo: string): string {
  const branch = currentBranch(repo) ?? "detached";
  const head = currentHead(repo);
  return head ? `${basename(repo)}:${branch}@${head.slice(0, 12)}` : `${basename(repo)}:${branch}`;
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

function reviewLaneActive(): boolean {
  return ((globalThis as { __codeflareReviewLaneDepth?: number }).__codeflareReviewLaneDepth ?? 0) > 0;
}

type GraphFreshness = {
  graphPath: string;
  status: "fresh" | "stale" | "unknown";
  built?: string;
  head?: string;
  reason?: string;
};

function graphFreshness(repo: string): GraphFreshness {
  const graphPath = join(repo, "graphify-out", "graph.json");
  const head = currentHead(repo);
  try {
    if (statSync(graphPath).size > 31457280) {
      return { graphPath, status: "unknown", head, reason: "graph is too large to inspect synchronously" };
    }
    const graph = JSON.parse(readFileSync(graphPath, "utf8")) as { built_at_commit?: unknown };
    const built = typeof graph.built_at_commit === "string" ? graph.built_at_commit : undefined;
    if (!built || !head) {
      return { graphPath, status: "unknown", built, head, reason: built ? "repo HEAD unavailable" : "graph has no built_at_commit metadata" };
    }
    return { graphPath, status: built === head ? "fresh" : "stale", built, head };
  } catch {
    return { graphPath, status: "unknown", head, reason: "graph metadata could not be read" };
  }
}

function existingGraphCloneNotice(repo: string): { message: string; level: "info" | "warning"; shouldPrompt: boolean } {
  const freshness = graphFreshness(repo);
  const identity = repoIdentity(repo);
  if (freshness.status === "stale" && freshness.built && freshness.head) {
    return {
      level: "warning",
      shouldPrompt: true,
      message: `Graphify graph already exists for ${identity}, but it is stale: graph built at ${freshness.built.slice(0, 12)}, repo HEAD is ${freshness.head.slice(0, 12)}.`,
    };
  }
  if (freshness.status === "fresh" && freshness.head) {
    return {
      level: "info",
      shouldPrompt: false,
      message: `Graphify graph already exists for ${identity} and is fresh at ${freshness.head.slice(0, 12)}. No graph update needed; use graphify_query/path/explain for structural questions.`,
    };
  }
  return {
    level: "warning",
    shouldPrompt: true,
    message: `Graphify graph already exists for ${identity}, but freshness could not be verified (${freshness.reason ?? "unknown reason"}).`,
  };
}

function graphSummary(repo: string): string | undefined {
  const graphPath = join(repo, "graphify-out", "graph.json");
  if (!existsSync(graphPath)) return undefined;
  const layout = "Repo graphs live under <repo>/graphify-out/graph.json, never /home/user/workspace/graphify-out. Vault graph: /home/user/Vault/graphify-out/graph.json. Global graph: /home/user/.graphify/global-graph.json.";
  try {
    // Skip the synchronous parse on very large graphs; reading a multi-MB graph at
    // session start would block the agent. 30MB mirrors the Claude session-start guard.
    if (statSync(graphPath).size > 31457280) {
      return `Graphify repo graph available for ${basename(repo)} at ${graphPath} (large graph; node counts skipped). ${layout} Prefer graphify query tools for architecture/dependency/call-flow questions before broad text search.`;
    }
    const graph = JSON.parse(readFileSync(graphPath, "utf8")) as { nodes?: unknown[]; links?: unknown[]; edges?: unknown[]; built_at_commit?: string };
    const nodes = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
    const links = Array.isArray(graph.links) ? graph.links.length : Array.isArray(graph.edges) ? graph.edges.length : 0;
    const built = typeof graph.built_at_commit === "string" ? graph.built_at_commit : undefined;
    const branch = currentBranch(repo);
    const branchText = branch ? ` Branch: ${branch}.` : "";
    let freshness = "";
    if (built) {
      const head = currentHead(repo);
      freshness = head
        ? built === head
          ? ` Fresh at ${head.slice(0, 12)}.`
          : ` Stale: built at ${built.slice(0, 12)}, repo HEAD is ${head.slice(0, 12)}.`
        : ` Built at ${built.slice(0, 12)}.`;
    }
    return `Graphify repo graph available for ${repoIdentity(repo)}: ${nodes} nodes, ${links} links at ${graphPath}.${branchText}${freshness} ${layout} Pi automatically retries graphify_query/path/explain against this active repo graph if the native tool resolves /home/user/workspace/graphify-out. Prefer graphify query tools for architecture/dependency/call-flow questions before broad text search.`;
  } catch {
    return `Graphify repo graph available for ${basename(repo)} at ${graphPath}. ${layout} Prefer graphify query tools for architecture/dependency/call-flow questions before broad text search.`;
  }
}

function isGraphifyQuery(command: string): boolean {
  return /(^|[;&|\n]\s*)graphify\s+(query|path|explain)\b/.test(command);
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

function resultText(event: any): string {
  const content = event?.content;
  if (Array.isArray(content)) {
    return content.map((item) => item?.type === "text" ? String(item.text ?? "") : "").join("\n");
  }
  return typeof content === "string" ? content : "";
}

function graphifyToolInput(event: any): Record<string, unknown> {
  const input = event?.input ?? event?.params ?? event?.args ?? {};
  return input && typeof input === "object" ? input : {};
}

function missingWorkspaceGraphError(event: any): boolean {
  if (event?.isError !== true) return false;
  return /graph file not found:\s*\/home\/user\/workspace\/graphify-out\/graph\.json/.test(resultText(event));
}

function graphifyFallbackArgs(toolName: string, input: Record<string, unknown>, graphPath: string): { args: string[]; details: Record<string, unknown> } | undefined {
  if (toolName === "graphify_query") {
    if (typeof input.question !== "string" || !input.question.trim()) return undefined;
    const mode = input.mode === "dfs" ? "dfs" : "bfs";
    const budget = typeof input.budget === "number" && Number.isFinite(input.budget) ? Math.floor(input.budget) : 2000;
    return {
      args: ["query", input.question, ...(mode === "dfs" ? ["--dfs"] : []), "--budget", String(budget), "--graph", graphPath],
      details: { question: input.question, mode },
    };
  }
  if (toolName === "graphify_path") {
    if (typeof input.from !== "string" || typeof input.to !== "string") return undefined;
    return {
      args: ["path", input.from, input.to, "--graph", graphPath],
      details: { from: input.from, to: input.to },
    };
  }
  if (toolName === "graphify_explain") {
    if (typeof input.concept !== "string" || !input.concept.trim()) return undefined;
    return {
      args: ["explain", input.concept, "--graph", graphPath],
      details: { concept: input.concept },
    };
  }
  return undefined;
}

function fallbackGraphifyToolResult(event: any, ctx: ExtensionContext): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError: false } | undefined {
  const toolName = String(event?.toolName ?? "").toLowerCase();
  if (!isGraphifyTool(toolName) || !missingWorkspaceGraphError(event)) return undefined;
  const repo = activeRepo(ctx);
  if (!repo || !hasGraph(repo)) return undefined;

  const graphPath = join(repo, "graphify-out", "graph.json");
  const fallback = graphifyFallbackArgs(toolName, graphifyToolInput(event), graphPath);
  if (!fallback) return undefined;

  try {
    const output = execFileSync("graphify", fallback.args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    }).trim();
    const identity = repoIdentity(repo);
    return {
      content: [{ type: "text", text: `${output}\n\n[Codeflare Pi fallback: queried ${graphPath} for active repo ${identity} because the native tool resolved /home/user/workspace/graphify-out.]` }],
      details: { ...fallback.details, result: output, repo, graph: graphPath, activeRepo: identity },
      isError: false,
    };
  } catch {
    return undefined;
  }
}

function isGitClone(command: string): boolean {
  return /(^|[;&|\n]\s*)git\s+clone\b/.test(command) || /(^|[;&|\n]\s*)gh\s+repo\s+clone\b/.test(command);
}

function isGitPush(command: string): boolean {
  return /(^|[;&|\n]\s*)git\s+push\b/.test(command);
}

function sddRepoState(repo: string): SddRepoState {
  return {
    dirty: isDirtyWorkingTree(repo),
    hasSdd: existsSync(join(repo, "sdd")),
    hasOpenInitTriage: hasOpenInitTriage(repo),
  };
}

function isDirtyWorkingTree(repo: string): boolean {
  try {
    return shell("git status --porcelain", repo).length > 0;
  } catch {
    return false;
  }
}

function hasOpenInitTriage(repo: string): boolean {
  const candidates = [join(repo, "sdd", "spec", ".init-triage.md"), join(repo, "sdd", ".init-triage.md")];
  for (const path of candidates) {
    try {
      if (existsSync(path) && /\*\*Status:\*\*\s*open\b/i.test(readFileSync(path, "utf8"))) return true;
    } catch {
      // Ignore unreadable transition files; the skill will surface a clearer finding.
    }
  }
  return false;
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

async function sendWorkflowMessage(pi: ExtensionAPI, ctx: ExtensionCommandContext, title: string, body: string): Promise<void> {
  await ctx.waitForIdle();
  const message = `${title}\n\n${body}`;
  const contextSender = (ctx as ExtensionCommandContext & { sendUserMessage?: (content: string) => void | Promise<void> }).sendUserMessage;
  if (typeof contextSender === "function") {
    await contextSender.call(ctx, message);
    return;
  }
  pi.sendUserMessage(message);
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

function packageSource(entry: string | { source?: string } | undefined): string | undefined {
  if (typeof entry === "string") return entry;
  return typeof entry?.source === "string" ? entry.source : undefined;
}

function packageIdentity(source: string): string {
  return source.replace(/@[^/@]+$/, "");
}

function readPiSettings(): PiSettings {
  try {
    return JSON.parse(readFileSync(PI_SETTINGS_FILE, "utf8")) as PiSettings;
  } catch {
    return {};
  }
}

function writePiSettings(settings: PiSettings): void {
  writeFileSync(PI_SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function isContextModePackage(entry: string | { source?: string } | undefined): boolean {
  const source = packageSource(entry);
  return Boolean(source && packageIdentity(source) === CONTEXT_MODE_PACKAGE_ID);
}

function contextModeEnabled(settings = readPiSettings()): boolean {
  return (settings.packages ?? []).some((entry) => {
    if (!isContextModePackage(entry)) return false;
    return typeof entry === "string" || entry.extensions === undefined || entry.skills === undefined;
  });
}

function setContextModeEnabled(enabled: boolean): "enabled" | "disabled" {
  const settings = readPiSettings();
  const packages = (settings.packages ?? []).filter((entry) => !isContextModePackage(entry));
  packages.push(enabled ? CONTEXT_MODE_PACKAGE : CONTEXT_MODE_DISABLED_PACKAGE);
  writePiSettings({ ...settings, packages });
  return enabled ? "enabled" : "disabled";
}

function contextModeStatusText(): string {
  const enabled = contextModeEnabled();
  return enabled
    ? "context-mode is enabled for this running Pi session. It will be disabled again on the next Codeflare container start. Use `/ctx off` to disable now."
    : "context-mode is disabled. Use `/ctx on` to enable it for this running Pi session, then Pi will reload resources.";
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
  const toolStartArgs = new Map<string, any>();
  const gatedToolIds = new Set<string>();
  const cloneTargetHadGit = new Map<string, boolean>();

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
    getArgumentCompletions: (prefix) => {
      const commands = ["init", "edit", "add", "clean", "mode"];
      return commands.filter((command) => command.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const repo = activeRepo(ctx) ?? ctx.sessionManager.getCwd();
      const decision = sddCommandDecision(args, sddRepoState(repo));
      if (decision.kind === "help") {
        ctx.ui.notify(decision.message || SDD_HELP_TEXT, "info");
        return;
      }
      if (decision.kind === "error") {
        ctx.ui.notify(decision.message, "warning");
        return;
      }
      await sendWorkflowMessage(pi, ctx, decision.normalizedCommand, `${skillPrompt(decision.skill, "Use the Codeflare SDD workflow.")}\n\nUser command: ${decision.normalizedCommand}`);
    },
  });

  pi.registerCommand("codeflare-graphify", {
    description: "Run Codeflare graphify workflow without shadowing the Pi graphify package command",
    handler: async (args, ctx) => {
      const repo = activeRepo(ctx) ?? ctx.sessionManager.getCwd();
      if (args.trim() === "refresh") {
        await sendWorkflowMessage(pi, ctx, "/graphify refresh", `Refresh the graphify graph for ${repo}. Use the safe AST-only update first, then merge ${repo}/graphify-out/graph.json into the global graph if present.`);
        return;
      }
      await sendWorkflowMessage(pi, ctx, `/graphify ${args}`.trim(), `${skillPrompt("graphify", "Use graphify to build/query the project graph.")}\n\nTarget repo: ${repo}\nUser command: /graphify ${args}`);
    },
  });

  pi.registerCommand("vault", {
    description: "Run Codeflare vault operations",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      await sendWorkflowMessage(pi, ctx, `/vault ${action}`, `${skillPrompt("vault-operations", "Use Codeflare vault operations.")}\n\nIf action is index, update the Vault graph at ~/Vault/graphify-out and merge it into the global graph.`);
    },
  });

  pi.registerCommand("note", {
    description: "Capture a note into the persistent Vault",
    handler: async (args, ctx) => {
      await sendWorkflowMessage(pi, ctx, `/note ${args}`.trim(), `${skillPrompt("vault-note-capture", "Capture the user's note into ~/Vault/Notes.")}\n\nNote text: ${args}`);
    },
  });

  pi.registerCommand("ctx", {
    description: "Show, enable, or disable context-mode for this running Pi session. Usage: /ctx status|on|off",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase().split(/\s+/, 1)[0] || "status";
      if (["on", "enable", "enabled"].includes(action)) {
        setContextModeEnabled(true);
        ctx.ui.notify("context-mode enabled for this session; reloading Pi resources...", "info");
        await ctx.reload();
        return;
      }
      if (["off", "disable", "disabled"].includes(action)) {
        setContextModeEnabled(false);
        ctx.ui.notify("context-mode disabled; reloading Pi resources...", "info");
        await ctx.reload();
        return;
      }
      ctx.ui.notify(contextModeStatusText(), "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    // Durable PR-boundary review lanes load this extension in-process for the build-blocker and
    // other guards, but must not re-run the per-repo global-graph merge (redundant; the main
    // session already merged it). The lane runner sets this depth counter around the session.
    if (reviewLaneActive()) return;
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
      return;
    }

    // A shell command ran if the tool carried one (bash input.command, or the ctx_* tools'
    // code/commands when context-mode is on). Detect by command content, not tool name, so
    // this works whether or not context-mode is active. Also resolve command-local `cd ... &&`
    // and `git -C ...` forms into the active-repo sentinel before graph-first gating fires.
    if (command) {
      const id = toolEventId(event);
      if (id && isGitClone(command) && !cloneTargetHadGit.has(id)) {
        const target = cloneTargetPath(command, ctx.sessionManager.getCwd());
        if (target) cloneTargetHadGit.set(id, existsSync(join(target, ".git")));
      }
      try {
        updateActiveRepoFromPath(effectivePathForCommand(command, ctx.sessionManager.getCwd()));
      } catch { /* active-repo tracking must never block the tool */ }
      const attributionReason = attributionBlockReason(command);
      if (attributionReason) return { block: true, reason: attributionReason };
      const buildReason = localBuildBlockReason(command, { existsSync, unlinkSync });
      if (buildReason) return { block: true, reason: buildReason };
    }
  };

  // onToolStart is the pre-execution gate. Pi can surface one tool invocation as both
  // `tool_call` and `tool_execution_start`; running the build-block and attribution-block
  // checks on both passes would evaluate them twice for a single invocation. Gate exactly
  // once per invocation, keyed by tool id, while still gating tools that surface only one of
  // the two events. Monotonic: this only suppresses a redundant second pass, it never skips
  // gating an invocation.
  pi.on("tool_call", (event: any, ctx: any) => {
    const id = toolEventId(event);
    if (id) gatedToolIds.add(id);
    return onToolStart(event, ctx);
  });
  pi.on("tool_execution_start", (event: any, ctx: any) => {
    const id = toolEventId(event);
    if (id) toolStartArgs.set(id, event?.args ?? event?.input ?? event?.params ?? {});
    if (id && gatedToolIds.has(id)) return;
    if (id) gatedToolIds.add(id);
    return onToolStart(event, ctx);
  });

  const onToolEnd = (event: any, ctx: any) => {
    const command = commandText(event);
    const cwd = ctx.sessionManager.getCwd();
    const id = toolEventId(event);
    const targetWasAlreadyCloned = id ? cloneTargetHadGit.get(id) === true : false;
    const shouldHandleClone = isGitClone(command) && !targetWasAlreadyCloned && !reviewLaneActive();
    const decision = shouldHandleClone
      ? graphifyClonePromptDecision({
        command,
        cwd,
        sessionId: String(ctx.sessionManager?.getSessionId?.() ?? process.ppid),
        failed: isFailedToolExecution(event),
        output: resultText(event),
        findGitRoot,
        hasGraph,
      })
      : undefined;
    const repo = updateActiveRepoFromPath(decision?.repo ?? (command ? effectivePathForCommand(command, cwd) : cwd));

    if (repo && hasGraph(repo) && !reviewLaneActive()) maybeMergeGlobalGraph(repo);

    if (decision && !existsSync(decision.marker)) {
      writeFileSync(decision.marker, "1", "utf8");
      if (decision.action.hasGraph) {
        const notice = existingGraphCloneNotice(decision.repo);
        if (notice.shouldPrompt) {
          pi.sendUserMessage(`${notice.message}\n\n${renderGraphifyCloneDirective(decision.action)}`, { deliverAs: "followUp" });
        } else {
          ctx.ui.notify(notice.message, notice.level);
        }
      } else {
        pi.sendUserMessage(renderGraphifyCloneDirective(decision.action), { deliverAs: "followUp" });
      }
    }

  };

  pi.on("tool_result", (event: any, ctx: any) => {
    const completed = withStartArgs(event);
    const fallback = fallbackGraphifyToolResult(completed, ctx);
    onToolEnd(completed, ctx);
    return fallback;
  });
  pi.on("tool_execution_end", (event: any, ctx: any) => onToolEnd(withStartArgs(event), ctx));

  pi.on("agent_end", (_event, _ctx) => {
    gatedToolIds.clear();
    cloneTargetHadGit.clear();
  });
}
