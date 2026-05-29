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
import { sddCommandDecision, type SddRepoState, SDD_HELP_TEXT } from "./sdd-helpers";

const CACHE_DIR = "/home/user/.cache/codeflare-hooks";
const ACTIVE_REPO_FILE = join(CACHE_DIR, "graphify-active-cwd");
const VAULT_ROOT = "/home/user/Vault";
const GLOBAL_GRAPH_LOCK = "/tmp/graphify-global.lock";
const GRAPHIFY_BYPASS = "/tmp/graphify-bypass";
const LOCAL_BUILD_BYPASS = "/tmp/local-build-bypass";
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
    let freshness = "";
    if (built) {
      try {
        const head = shell("git rev-parse HEAD", repo);
        freshness = built === head
          ? ` Fresh at ${head.slice(0, 12)}.`
          : ` Stale: built at ${built.slice(0, 12)}, repo HEAD is ${head.slice(0, 12)}.`;
      } catch {
        freshness = ` Built at ${built.slice(0, 12)}.`;
      }
    }
    return `Graphify repo graph available for ${basename(repo)}: ${nodes} nodes, ${links} links at ${graphPath}.${freshness} ${layout} Prefer graphify query tools for architecture/dependency/call-flow questions before broad text search.`;
  } catch {
    return `Graphify repo graph available for ${basename(repo)} at ${graphPath}. ${layout} Prefer graphify query tools for architecture/dependency/call-flow questions before broad text search.`;
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
  if (!/(^|[;&|]\s*)(git\s+(commit|merge|tag|notes)|gh\s+(pr|issue|release)\s+\w+)\b/.test(command)) return undefined;
  // Match the canonical block-attributed-commits.sh detection set. Deliberately NOT bare
  // "Claude": that false-positives on git/gh commands naming preseed/agents/claude/ paths.
  if (/co-authored-by|noreply@anthropic|claude\s+(sonnet|opus|haiku|code)|generated with[^\n]*claude|🤖|🧠|ChatGPT/i.test(command)) {
    return "Codeflare blocks AI attribution in commits, PRs, issues, releases, and tags. Remove Co-Authored-By, generated-by text, model-name attribution, and emoji attribution.";
  }
  return undefined;
}

function ensureNoLocalBuild(command: string): string | undefined {
  const isBuild = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|typecheck|dev)\b/.test(command)
    || /\b(pytest|vitest|go\s+test|swift\s+test|cargo\s+test|tsc|eslint|oxlint|prettier|wrangler\s+dev)\b/.test(command);
  if (!isBuild) return undefined;
  // User-only escape hatch (consume-on-use), mirrors Claude's /tmp/local-build-bypass.
  if (existsSync(LOCAL_BUILD_BYPASS)) {
    try {
      unlinkSync(LOCAL_BUILD_BYPASS);
      return undefined;
    } catch { /* could not consume the sentinel; keep blocking so a stuck file cannot permanently disable the gate */ }
  }
  return "Local builds/tests/linters/dev servers are blocked in the 1-CPU container. Push and verify with CI instead. User override: create /tmp/local-build-bypass.";
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
  let searchCountThisTurn = 0;
  let graphifyCountThisTurn = 0;
  const toolStartArgs = new Map<string, any>();
  const gatedToolIds = new Set<string>();

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
      await sendWorkflowMessage(ctx, decision.normalizedCommand, `${skillPrompt(decision.skill, "Use the Codeflare SDD workflow.")}\n\nUser command: ${decision.normalizedCommand}`);
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

    // A shell command ran if the tool carried one (bash input.command, or the ctx_* tools'
    // code/commands when context-mode is on). Detect by command content, not tool name, so
    // this works whether or not context-mode is active.
    if (command) {
      const attributionReason = ensureNoAttributedCommit(command);
      if (attributionReason) return { block: true, reason: attributionReason };
      const buildReason = ensureNoLocalBuild(command);
      if (buildReason) return { block: true, reason: buildReason };
    }

    if (command && isStructuralSearch(command)) {
      searchCountThisTurn++;
      try {
        if (existsSync(GRAPHIFY_BYPASS)) {
          try {
            unlinkSync(GRAPHIFY_BYPASS);
            return;
          } catch { /* could not consume the sentinel; fall through to the normal graph-first gate */ }
        }
        const repo = activeRepo(ctx);
        if (repo && hasGraph(repo) && searchCountThisTurn >= 3 && graphifyCountThisTurn === 0) {
          return { block: true, reason: `Graphify graph exists for ${basename(repo)}. Query graphify_query, graphify_path, or graphify_explain before more structural searches, or ask the user to create ${GRAPHIFY_BYPASS}.` };
        }
      } catch { /* fail open: never block a tool call on an internal gate error */ }
    }
  };

  // onToolStart is the pre-execution gate. Pi can surface one tool invocation as both
  // `tool_call` and `tool_execution_start`; running the gate (with its consume-on-use bypass and
  // per-turn counters) on both passes would double-count searches and consume a bypass on the
  // first pass only to block on the second. Gate exactly once per invocation, keyed by tool id,
  // while still gating tools that surface only one of the two events. Monotonic: this only
  // suppresses a redundant second pass, it never skips gating an invocation.
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
    gatedToolIds.clear();
  });
}
