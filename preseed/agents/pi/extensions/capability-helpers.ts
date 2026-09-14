import { readFileSync, openSync, closeSync, readSync, fstatSync, realpathSync, constants } from "node:fs";
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
  kind: "tool" | "skill";
  name: string;
  description: string;
  filePath?: string;
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

const STOP_WORDS = new Set("a an the and or to of for in on with by from please can could would should i we you my our me us it this that these those help need want".split(" "));

function tokens(value: string): string[] {
  return [...new Set((value.normalize("NFKC").replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((term) => !STOP_WORDS.has(term)))];
}

function purpose(description: string): string {
  const first = description.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  return (first.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? first).replace(/\s+/g, " ").trim();
}

export function cleanCapabilityText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

export function clipCapabilityText(value: string, limit: number): string {
  const points = [...value];
  return points.length <= limit ? value : `${points.slice(0, limit - 1).join("")}…`;
}

export function parseCapabilityQuery(value: string): { query: string; kind?: "tool" | "skill" } {
  const query = value.trim();
  const prefix = query.match(/^(tool|skill):/i);
  return prefix
    ? { query: query.slice(prefix[0].length).trim(), kind: prefix[1].toLowerCase() as "tool" | "skill" }
    : { query };
}

export type SkillCandidate = { name: string; description: string; filePath: string };
export type LoadedSkill = SkillCandidate & {
  disableModelInvocation: boolean;
  sourceInfo: { scope: string; origin: string };
};

export function searchCapabilities(input: {
  query: string;
  tools: RegisteredTool[];
  skills?: SkillCandidate[];
  limit?: number;
}): CapabilityMatch[] {
  const { query, kind } = parseCapabilityQuery(input.query);
  const candidates: CapabilityMatch[] = [
    ...input.tools.map((tool) => ({ kind: "tool" as const, name: tool.name, description: tool.description ?? "" })),
    ...(input.skills ?? []).map((skill) => ({ kind: "skill" as const, ...skill })),
  ].filter((candidate) => (!kind || kind === candidate.kind) && !DISABLED_TOOL_NAMES.has(candidate.name));
  const order = (a: CapabilityMatch, b: CapabilityMatch) => {
    const left = `${a.kind}:${a.name}`, right = `${b.kind}:${b.name}`;
    return left < right ? -1 : left > right ? 1 : 0;
  };
  const exact = candidates.filter((candidate) => candidate.name.normalize("NFKC").toLowerCase() === query.normalize("NFKC").toLowerCase());
  const terms = tokens(query);
  const scored = candidates.map((candidate) => {
    const name = tokens(candidate.name), summary = tokens(purpose(candidate.description)), full = tokens(candidate.description);
    let score = 0, matched = 0, nameHits = 0, strong = 0;
    for (const term of terms) {
      if (name.includes(term)) { score += 12; matched++; nameHits++; strong++; }
      else if (summary.includes(term)) { score += 6; matched++; strong++; }
      else if (full.includes(term)) { score++; matched++; }
    }
    if (name.some((_, i) => terms.every((term, j) => name[i + j] === term))) score += 8;
    return { candidate, score, matched, nameHits, strong };
  }).filter((item) => terms.length > 0 && item.matched * 3 >= terms.length * 2 && item.strong > 0 && item.score >= 6);
  const best = { tool: 0, skill: 0 };
  for (const item of scored) best[item.candidate.kind] = Math.max(best[item.candidate.kind], item.score);
  const ranked = exact.length ? exact.sort(order) : scored
    .filter((item) => item.score >= Math.ceil(best[item.candidate.kind] * 0.75))
    .sort((a, b) => b.score - a.score || b.nameHits - a.nameHits || order(a.candidate, b.candidate))
    .map((item) => item.candidate);
  return ranked.slice(0, Math.max(0, Math.min(input.limit ?? 3, 3))).map((candidate) => ({
    ...candidate, description: clipCapabilityText(cleanCapabilityText(purpose(candidate.description)), 100),
  }));
}

export function formatCapabilityMatches(matches: CapabilityMatch[]): string {
  let limit = 100;
  const render = () => matches.map((match) => `${match.kind}:${cleanCapabilityText(match.name)}${limit ? ` — ${clipCapabilityText(match.description, limit)}` : ""}${match.kind === "skill" ? `; read ${JSON.stringify(match.filePath)}` : ""}`).join("\n");
  let text = render();
  while ([...text].length > 600 && limit > 0) { limit--; text = render(); }
  return text;
}

function readSkillPolicy(agentDir: string): Map<string, boolean> {
  const policy = new Map<string, boolean>();
  let fd: number | undefined;
  try {
    const file = join(realpathSync(agentDir), "capability-skill-policy.json");
    if (realpathSync(file) !== file) return policy;
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const maximum = 1024 * 1024;
    if (!stat.isFile() || stat.size > maximum) return policy;
    const buffer = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > maximum) return policy;
    const value = JSON.parse(buffer.subarray(0, used).toString("utf8"));
    if (value?.version !== 1 || !Array.isArray(value.skills)) return policy;
    for (const entry of value.skills) {
      if (!entry || typeof entry.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)
        || entry.path !== `skills/${entry.name}/SKILL.md` || typeof entry.modelInvocable !== "boolean"
        || policy.has(entry.name)) return new Map();
      policy.set(entry.name, entry.modelInvocable);
    }
    return policy;
  } catch {
    return new Map();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function eligibleSkillSnapshot(skills: readonly LoadedSkill[], trusted: boolean, agentDir = resolveAgentDir()): SkillCandidate[] {
  const policy = readSkillPolicy(agentDir);
  return skills.filter((skill) => {
    if (skill.sourceInfo.scope === "project" && !trusted) return false;
    if (!skill.disableModelInvocation) return true;
    if (skill.sourceInfo.scope !== "user" || skill.sourceInfo.origin !== "top-level" || policy.get(skill.name) !== true) return false;
    try {
      return realpathSync(skill.filePath) === join(realpathSync(agentDir), "skills", skill.name, "SKILL.md");
    } catch { return false; }
  }).map(({ name, description, filePath }) => ({ name, description, filePath }));
}
