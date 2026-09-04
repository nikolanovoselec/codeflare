import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RegisteredTool = { name: string; description?: string };

export type ToolActivationPi = {
  getActiveTools(): string[];
  getAllTools(): RegisteredTool[];
  setActiveTools(names: string[]): void;
};

type SessionEntry = { type?: string; customType?: string; data?: unknown };
type SessionContext = {
  sessionManager?: {
    getBranch?(): SessionEntry[];
    getEntries?(): SessionEntry[];
  };
};
type InitialToolFilterPi = ToolActivationPi & {
  on(event: string, handler: (event: unknown, ctx: SessionContext) => void): void;
};

export type CapabilityMatch = {
  kind: "tool";
  name: string;
  description: string;
};

// Pi loads every TypeScript file in the extensions directory. This support
// module therefore exports a side-effect-free extension as well as its helpers.
export default function capabilityHelpersExtension(): void {}

const CORE_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "capability",
] as const;

const TOOL_ACTIVATION_GROUPS: Readonly<Record<string, readonly string[]>> = {
  subagent: ["subagent", "get_subagent_result", "steer_subagent"],
};
const GOAL_STATE_ENTRY_TYPE = "goal-state";
const PLAN_STATE_ENTRY_TYPE = "plan-mode-state";
const INLINE_EDIT_RESULT_TOOL = "codeflare_submit_inline_result";
const DISABLED_TOOL_NAMES = new Set(["goal_wait"]);
const GOAL_TERMINAL_TOOLS = ["goal_complete", "goal_blocked"] as const;
const PLAN_HELPER_TOOLS = ["plan_mode_question", "plan_mode_complete"] as const;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function initialActiveTools(pi: ToolActivationPi): string[] {
  const registered = new Set(pi.getAllTools().map((tool) => tool.name));
  return CORE_TOOL_NAMES.filter((name) => registered.has(name) && !DISABLED_TOOL_NAMES.has(name));
}

export function isExclusiveActiveTool(activeTools: ReadonlySet<string>, toolName: string): boolean {
  return activeTools.size === 1 && activeTools.has(toolName);
}

type GoalToolVisibility = "always" | "after-first-goal";

export function resolveAgentDir(
  override = process.env.PI_CODING_AGENT_DIR,
  home = homedir(),
): string {
  if (!override) return join(home, ".pi", "agent");
  if (override === "~") return home;
  if (override.startsWith("~/") || (process.platform === "win32" && override.startsWith("~\\"))) {
    return join(home, override.slice(2));
  }
  return override;
}

function configuredGoalToolVisibility(): GoalToolVisibility | undefined {
  try {
    const agentDir = resolveAgentDir();
    const parsed = JSON.parse(readFileSync(join(agentDir, "pi-goal.json"), "utf8"));
    return parsed?.toolVisibility === "always" || parsed?.toolVisibility === "after-first-goal"
      ? parsed.toolVisibility
      : undefined;
  } catch {
    return undefined;
  }
}

function sessionEntries(ctx: SessionContext): SessionEntry[] {
  try {
    return ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  } catch {
    return [];
  }
}

function latestCustomEntry(ctx: SessionContext, customType: string): SessionEntry | undefined {
  return sessionEntries(ctx).filter((entry) => (
    entry.type === "custom" && entry.customType === customType
  )).at(-1);
}

function latestGoalStatus(ctx: SessionContext): string | undefined {
  const latest = latestCustomEntry(ctx, GOAL_STATE_ENTRY_TYPE);
  if (!latest?.data || typeof latest.data !== "object") return undefined;
  const goal = Reflect.get(latest.data, "goal");
  if (!goal || typeof goal !== "object") return undefined;
  const id = Reflect.get(goal, "id");
  const status = Reflect.get(goal, "status");
  return typeof id === "string" && id.length > 0 && typeof status === "string"
    ? status
    : undefined;
}

function registeredTools(pi: ToolActivationPi, names: readonly string[]): string[] {
  const registered = new Set(pi.getAllTools().map((tool) => tool.name));
  return unique([...names]).filter((name) => registered.has(name) && !DISABLED_TOOL_NAMES.has(name));
}

function activePlanTools(pi: ToolActivationPi, ctx: SessionContext): string[] | undefined {
  const latest = latestCustomEntry(ctx, PLAN_STATE_ENTRY_TYPE);
  if (!latest?.data || typeof latest.data !== "object" || Reflect.get(latest.data, "enabled") !== true) {
    return undefined;
  }
  const policy = Reflect.get(latest.data, "workflowToolPolicy");
  if (!policy || typeof policy !== "object") return undefined;
  const allowedNames = Reflect.get(policy, "allowedNames");
  if (!Array.isArray(allowedNames) || allowedNames.some((name) => typeof name !== "string")) return undefined;
  return registeredTools(pi, [...allowedNames, ...PLAN_HELPER_TOOLS]);
}

export function registerInitialToolFilter(
  pi: InitialToolFilterPi,
  goalToolVisibility: () => GoalToolVisibility | undefined = configuredGoalToolVisibility,
): void {
  const alwaysVisible = goalToolVisibility() === "always";
  const goalTools = () => registeredTools(pi, [...initialActiveTools(pi), ...GOAL_TERMINAL_TOOLS]);
  const applyOwnedTools = (ctx: SessionContext): boolean => {
    const goalStatus = latestGoalStatus(ctx);
    if (goalStatus === "active") {
      pi.setActiveTools(goalTools());
      return true;
    }
    const planTools = activePlanTools(pi, ctx);
    if (planTools) {
      pi.setActiveTools(registeredTools(pi, [
        ...planTools,
        ...(alwaysVisible ? GOAL_TERMINAL_TOOLS : []),
      ]));
      return true;
    }
    if (alwaysVisible || goalStatus !== undefined) {
      pi.setActiveTools(goalTools());
      return true;
    }
    return false;
  };

  pi.on("before_agent_start", (_event, ctx) => {
    const activeBeforeFilter = new Set(pi.getActiveTools());
    // Inline Chat deliberately narrows the provider to one host-owned result tool.
    // The final exposure filter runs later and must not replace that exclusive mode.
    if (isExclusiveActiveTool(activeBeforeFilter, INLINE_EDIT_RESULT_TOOL)) return;
    if (!applyOwnedTools(ctx)) pi.setActiveTools(initialActiveTools(pi));
  });
}

export function activationGroup(name: string): string[] {
  return [...(TOOL_ACTIVATION_GROUPS[name] ?? [name])];
}

export function activateRegisteredTools(pi: ToolActivationPi, requested: string[]): string[] {
  const registered = new Set(pi.getAllTools().map((tool) => tool.name));
  const active = pi.getActiveTools();
  const activeSet = new Set(active);
  const added = unique(requested).filter((name) => (
    registered.has(name) && !DISABLED_TOOL_NAMES.has(name) && !activeSet.has(name)
  ));
  if (added.length > 0) pi.setActiveTools([...active, ...added]);
  return added;
}

function matchScore(query: string, tool: RegisteredTool): number {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const normalizedName = tool.name.toLowerCase();
  const haystack = `${normalizedName} ${(tool.description ?? "").toLowerCase()}`;
  const termScore = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
  return termScore + (normalizedName === query.trim().toLowerCase() ? 3 : 0);
}

export function searchCapabilities(input: {
  query: string;
  tools: RegisteredTool[];
  limit?: number;
}): CapabilityMatch[] {
  return input.tools
    .filter((tool) => !DISABLED_TOOL_NAMES.has(tool.name))
    .map((tool) => ({ tool, score: matchScore(input.query, tool) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .slice(0, input.limit ?? 5)
    .map(({ tool }) => ({ kind: "tool", name: tool.name, description: tool.description ?? "" }));
}
