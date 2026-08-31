import { Type } from "typebox";
import {
  activateRegisteredTools,
  activationGroup,
  initialActiveTools,
  searchCapabilities,
  type RegisteredTool,
  type ToolActivationPi,
} from "./capability-helpers";

type SessionEntry = { type?: string; customType?: string; data?: unknown };
type SessionContext = {
  sessionManager?: {
    getBranch?(): SessionEntry[];
    getEntries?(): SessionEntry[];
  };
};

type ExtensionAPI = ToolActivationPi & {
  registerTool(tool: unknown): void;
  on(event: string, handler: (event: unknown, ctx: SessionContext) => void): void;
};

type CapabilityParams = {
  query?: string;
  name?: string;
};

const GOAL_STATE_ENTRY_TYPE = "goal-state";
const INLINE_EDIT_RESULT_TOOL = "codeflare_submit_inline_result";
const GOAL_TERMINAL_TOOLS = ["goal_complete", "goal_blocked"] as const;
const UNFINISHED_GOAL_STATUSES = new Set([
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "queued",
]);

function hasUnfinishedGoal(ctx: SessionContext): boolean {
  let entries: SessionEntry[];
  try {
    entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  } catch {
    return false;
  }
  const latest = entries.filter((entry) => (
    entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY_TYPE
  )).at(-1);
  if (!latest || !latest.data || typeof latest.data !== "object") return false;
  const goal = Reflect.get(latest.data, "goal");
  if (!goal || typeof goal !== "object") return false;
  const id = Reflect.get(goal, "id");
  const status = Reflect.get(goal, "status");
  return typeof id === "string"
    && id.length > 0
    && typeof status === "string"
    && UNFINISHED_GOAL_STATUSES.has(status);
}

export function registerInitialToolFilter(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (_event, ctx) => {
    const activeBeforeFilter = new Set(pi.getActiveTools());
    // Inline Chat deliberately narrows the provider to one host-owned result tool.
    // The final exposure filter runs later and must not replace that exclusive mode
    // with the normal read/bash/edit/write/capability set.
    if (activeBeforeFilter.size === 1 && activeBeforeFilter.has(INLINE_EDIT_RESULT_TOOL)) return;
    const keepGoalTools = hasUnfinishedGoal(ctx)
      || GOAL_TERMINAL_TOOLS.every((name) => activeBeforeFilter.has(name));
    const initial = initialActiveTools(pi);
    if (!keepGoalTools) {
      pi.setActiveTools(initial);
      return;
    }
    const registered = new Set(pi.getAllTools().map((tool) => tool.name));
    pi.setActiveTools([
      ...initial,
      ...GOAL_TERMINAL_TOOLS.filter((name) => registered.has(name)),
    ]);
  });
}

export function capabilityExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "capability",
    label: "Tool Search",
    description: "Search registered Pi tools or activate one by exact name.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Capability to search for." })),
      name: Type.Optional(Type.String({ description: "Exact tool name to activate." })),
    }),
    async execute(_id: string, params: CapabilityParams) {
      const name = params.name?.trim();
      if (name) {
        const tool = pi.getAllTools().find((candidate: RegisteredTool) => candidate.name === name);
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        const added = activateRegisteredTools(pi, activationGroup(tool.name));
        const text = tool.name === "subagent"
          ? `${added.length > 0 ? `Loaded tools: ${added.join(", ")}` : "Subagent tools already active"}. Use get_subagent_result or steer_subagent while an agent is queued or running; resume only a settled retained session.`
          : added.length > 0 ? `Loaded tool: ${tool.name}` : `Tool already active: ${tool.name}`;
        return {
          content: [{
            type: "text",
            text,
          }],
          details: { name: tool.name, added },
        };
      }

      const query = params.query?.trim();
      if (!query) throw new Error("Provide query or name.");
      const matches = searchCapabilities({ query, tools: pi.getAllTools() });
      return {
        content: [{
          type: "text",
          text: matches.length > 0
            ? matches.map((match) => `${match.name} — ${match.description}`).join("\n")
            : `No tools found for: ${query}`,
        }],
        details: { matches },
      };
    },
  });
}

export default capabilityExtension;
