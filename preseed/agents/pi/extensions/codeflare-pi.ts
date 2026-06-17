/**
 * Codeflare Pi native runtime adapter.
 *
 * Provides Pi-native equivalents for Codeflare's Claude Code commands and
 * hooks while keeping the canonical workflow prose in shared preseed skills.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { cloneTargetPath, effectiveCwdForCommand, ENV_PREFIX, graphifyClonePromptDecision, isFailedToolExecution, renderGraphifyCloneDirective } from "./graphify-helpers";
import { rememberActiveRepo } from "./review-job-helpers";
import { sddCommandDecision, type SddRepoState, SDD_HELP_TEXT } from "./sdd-helpers";
import { attributionBlockReason, localBuildBlockReason } from "./guard-helpers";

// Pi extension SDK surface, declared inline instead of imported from
// "@earendil-works/pi-coding-agent" so this file typechecks in Codeflare's
// build, which does not install the Pi SDK. Mirrors local-statusline.ts.
// Only the members this extension actually uses are modelled; the real SDK
// types are richer. The inline signatures contextually type the command and
// event handlers below, which is what removes the implicit-any errors.
type NotifyLevel = "info" | "warning" | "error";

type ExtensionContext = {
  sessionManager: { getCwd(): string };
  ui: { notify(message: string, level?: NotifyLevel): void };
};

type ExtensionCommandContext = ExtensionContext & {
  waitForIdle(): Promise<void>;
  reload(): Promise<void>;
};

type ExtensionAPI = {
  registerCommand(
    name: string,
    config: {
      description: string;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }>;
      handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
    },
  ): void;
  on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void;
  sendUserMessage(message: string, options?: { deliverAs?: string }): void;
};

const CACHE_DIR = "/home/user/.cache/codeflare-hooks";
const ACTIVE_REPO_FILE = join(CACHE_DIR, "graphify-active-cwd");
const REVIEW_ACTIVE_REPO_FILE = join(CACHE_DIR, "review-active-cwd");
const VAULT_ROOT = "/home/user/Vault";
const GLOBAL_GRAPH_LOCK = "/tmp/graphify-global.lock";
const PI_SETTINGS_FILE = "/home/user/.pi/agent/settings.json";
const CONTEXT_MODE_PACKAGE = "npm:context-mode@1.0.162";
const CONTEXT_MODE_PACKAGE_ID = "npm:context-mode";
const CONTEXT_MODE_DISABLED_PACKAGE = { source: CONTEXT_MODE_PACKAGE, extensions: [], skills: [] };

// Always-on engineering constitution injected into every Pi agent system prompt.
// Mirrors the Claude rule preseed/agents/claude/rules/engineering-constitution.md —
// keep the four mandates in sync across both agents.
const ENGINEERING_CONSTITUTION = [
  "<codeflare_constitution>",
  "Non-negotiable for ALL planning and coding (restate as success criteria in every plan; trivial one-liners excepted):",
  "1. No overengineering — minimum code that solves the actual request; nothing speculative.",
  "2. Behavioral tests only — assert behavior/contract values (state, DOM, status codes, parsed values), never UI copy/prose; a test must fail if the implementation is gutted.",
  "3. Reusable, composable components — extract any structure used more than twice; tokens/one source of truth; validate at boundaries; immutability.",
  "4. SDD + TDD enforced — failing behavioral test first; every change traces to a REQ; specs/anchors/docs move with the code; never leave a REQ Partial.",
  "Plan gate: present no plan without a Success-criteria/verification section covering these four. Fix legitimate findings in-session.",
  "</codeflare_constitution>",
].join("\n");

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

function persistActiveRepo(repo: string): void {
  ensureCacheDir();
  writeFileSync(ACTIVE_REPO_FILE, repo + "\n", "utf8");
  writeFileSync(REVIEW_ACTIVE_REPO_FILE, repo + "\n", "utf8");
}

function updateActiveRepoFromPath(path: string): string | undefined {
  const repo = findGitRoot(path);
  if (!repo) return undefined;
  persistActiveRepo(repo);
  // Also remember in-session (shared module state) so the local-statusline
  // footer can render repo:branch without trusting the shared on-disk sentinel.
  rememberActiveRepo(repo);
  return repo;
}

export function restoreActiveRepoFromPersistedFiles(
  paths: string[],
  read: (path: string) => string,
  exists: (path: string) => boolean,
  remember: (repo: string) => void,
): string | undefined {
  for (const path of paths) {
    try {
      const value = read(path).trim();
      if (!value || !exists(value)) continue;
      remember(value);
      return value;
    } catch {
      // Try the next persisted source.
    }
  }
  return undefined;
}

function activeRepo(ctx: ExtensionContext): string | undefined {
  const liveRepo = updateActiveRepoFromPath(ctx.sessionManager.getCwd());
  if (liveRepo) return liveRepo;
  const restored = restoreActiveRepoFromPersistedFiles(
    [REVIEW_ACTIVE_REPO_FILE, ACTIVE_REPO_FILE],
    (path) => readFileSync(path, "utf8"),
    existsSync,
    rememberActiveRepo,
  );
  if (restored) {
    // Display/Graphify fallback only. PR-boundary review routing revalidates this memory against the
    // session roots and SDD marker before it can influence review reconciliation or merge gating.
    persistActiveRepo(restored);
    return restored;
  }
  return undefined;
}

function hasGraph(repo: string): boolean {
  return existsSync(join(repo, "graphify-out", "graph.json"));
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

// Shell-only command text for CLONE detection (git-push-review-reminder.sh:74-84): Bash
// `.command`; ctx_execute `.code` only when language === "shell"; ctx_batch_execute
// `.commands[].command`. Prevents a JS/TS/python ctx_execute body whose source contains a
// clone-looking string literal from false-firing the clone prompt (Issue 2B). Deliberately
// NARROWER than commandText() above — the attribution / build-block / active-repo callers
// still need any command text, so only the clone branch uses this.
function shellCommandText(event: any): string {
  const input = event?.input ?? event?.params ?? event?.args ?? {};
  if (typeof input.command === "string") return input.command;
  if (input.language === "shell" && typeof input.code === "string") return input.code;
  if (Array.isArray(input.commands)) return input.commands.map((cmd: any) => (cmd && typeof cmd.command === "string" ? cmd.command : "")).join("\n");
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
  // Active repo graph wins; otherwise fall back to the merged global graph
  // (vault + every globally-added repo) so vault/global queries work when
  // there is no cloned repo and the native tool resolved the nonexistent
  // /home/user/workspace/graphify-out path.
  const GLOBAL_GRAPH = "/home/user/.graphify/global-graph.json";
  const useRepo = !!repo && hasGraph(repo);
  const graphPath = useRepo
    ? join(repo as string, "graphify-out", "graph.json")
    : (existsSync(GLOBAL_GRAPH) ? GLOBAL_GRAPH : undefined);
  if (!graphPath) return undefined;

  const fallback = graphifyFallbackArgs(toolName, graphifyToolInput(event), graphPath);
  if (!fallback) return undefined;

  try {
    const output = execFileSync("graphify", fallback.args, {
      cwd: useRepo ? (repo as string) : "/home/user",
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    }).trim();
    const identity = useRepo ? repoIdentity(repo as string) : "merged global graph";
    const note = useRepo
      ? `[Codeflare Pi fallback: queried ${graphPath} for active repo ${identity} because the native tool resolved /home/user/workspace/graphify-out.]`
      : `[Codeflare Pi: resolved the merged global graph ${graphPath} (vault + all repos).]`;
    return {
      content: [{ type: "text", text: `${output}\n\n${note}` }],
      details: { ...fallback.details, result: output, graph: graphPath, activeRepo: identity },
      isError: false,
    };
  } catch {
    return undefined;
  }
}

function isGitClone(command: string): boolean {
  return new RegExp(String.raw`(^|[;&|\n]\s*)` + ENV_PREFIX + String.raw`git\s+clone\b`).test(command)
    || new RegExp(String.raw`(^|[;&|\n]\s*)` + ENV_PREFIX + String.raw`gh\s+repo\s+clone\b`).test(command);
}

export function shouldHandleClonePrompt(command: string, targetWasAlreadyCloned: boolean, reviewLaneDepth: number): boolean {
  return isGitClone(command) && !targetWasAlreadyCloned && reviewLaneDepth <= 0;
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
    ? "context-mode is enabled (the default for Pi). Use `/ctx off` to disable it for this running Pi session; the next Codeflare container start re-enables it."
    : "context-mode is disabled for this running Pi session. Use `/ctx on` to re-enable it now (Pi reloads resources); the next Codeflare container start re-enables it by default.";
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
        await sendWorkflowMessage(pi, ctx, "/graphify refresh", `Refresh the graphify graph for ${repo}. Use upstream Graphify via /home/user/.pi/agent/scripts/safe-graphify-update.sh for AST refresh, and only run semantic refresh through Pi Agent subagents from this session if the user chooses Full mode in the graphify skill. Merge ${repo}/graphify-out/graph.json into the global graph if present.`);
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
    const repo = activeRepo(ctx);
    if (repo) maybeMergeGlobalGraph(repo);
    const summary = repo ? graphSummary(repo) : undefined;
    if (summary) ctx.ui.notify(summary, "info");
  });

  pi.on("before_agent_start", (event, ctx) => {
    const repo = activeRepo(ctx);
    const parts = [String(event?.systemPrompt ?? ""), ENGINEERING_CONSTITUTION];
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
      const cloneCmd = shellCommandText(event);
      if (id && isGitClone(cloneCmd) && !cloneTargetHadGit.has(id)) {
        const target = cloneTargetPath(cloneCmd, ctx.sessionManager.getCwd());
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
    const cloneCmd = shellCommandText(event);
    const cwd = ctx.sessionManager.getCwd();
    const id = toolEventId(event);
    const targetWasAlreadyCloned = id ? cloneTargetHadGit.get(id) === true : false;
    // Lane depth is 0 here: detached PR-boundary review lanes (AD76) run as separate `pi --mode json`
    // processes that load review-lane-guards.ts, not this extension in-process, so there is no in-process
    // lane to suppress. The depth param is retained on shouldHandleClonePrompt for its own unit tests.
    const shouldHandleClone = shouldHandleClonePrompt(cloneCmd, targetWasAlreadyCloned, 0);
    const decision = shouldHandleClone
      ? graphifyClonePromptDecision({
        command: cloneCmd,
        cwd,
        sessionId: String(ctx.sessionManager?.getSessionId?.() ?? process.ppid),
        failed: isFailedToolExecution(event),
        output: resultText(event),
        findGitRoot,
        hasGraph,
        exists: existsSync,
        freshness: (repo: string) => graphFreshness(repo).status,
      })
      : undefined;
    const repo = updateActiveRepoFromPath(decision?.repo ?? (command ? effectivePathForCommand(command, cwd) : cwd));

    if (repo && hasGraph(repo)) maybeMergeGlobalGraph(repo);

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
