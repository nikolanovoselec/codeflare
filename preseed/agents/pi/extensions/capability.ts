import { Type } from "typebox";
import {
  activateRegisteredTools,
  activationGroup,
  searchCapabilities,
  eligibleSkillSnapshot,
  parseCapabilityQuery,
  formatCapabilityMatches,
  cleanCapabilityText,
  clipCapabilityText,
  type LoadedSkill,
  type SkillCandidate,
  type RegisteredTool,
  type ToolActivationPi,
} from "./capability-helpers";

type ExtensionAPI = ToolActivationPi & {
  registerTool(tool: unknown): void;
  on(event: string, handler: (event: unknown, ctx: { isProjectTrusted?(): boolean }) => void): void;
};

type CapabilityParams = {
  query?: string;
  name?: string;
};

export function capabilityExtension(pi: ExtensionAPI): void {
  let skills: SkillCandidate[] | undefined;
  pi.on("session_start", () => { skills = undefined; });
  pi.on("before_agent_start", (event, ctx) => {
    const loaded = (event as { systemPromptOptions?: { skills?: readonly LoadedSkill[] } }).systemPromptOptions?.skills;
    skills = loaded ? eligibleSkillSnapshot(loaded, ctx.isProjectTrusted?.() === true) : undefined;
  });
  pi.registerTool({
    name: "capability",
    label: "Find tool or skill",
    description: "Search registered Pi tools and eligible installed skills. query searches by name and description; name activates an exact tool.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search; optional tool: or skill: prefix." })),
      name: Type.Optional(Type.String({ description: "Exact tool name to activate." })),
    }),
    async execute(_id: string, params: CapabilityParams) {
      const name = params.name?.trim();
      if (name) {
        const tool = pi.getAllTools().find((candidate: RegisteredTool) => candidate.name === name);
        if (!tool) {
          throw new Error(`Unknown tool: ${name}. capability activates registered Pi tools only; read ~/.pi/agent/skills/<name>/SKILL.md to load a skill.`);
        }
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
      if (!query || !parseCapabilityQuery(query).query) throw new Error("Provide query or name.");
      if (!skills && parseCapabilityQuery(query).kind === "skill") {
        return { content: [{ type: "text", text: "Skill metadata unavailable; submit a prompt before skill lookup." }], details: { matches: [] } };
      }
      const matches = searchCapabilities({ query, tools: pi.getAllTools(), skills });
      return {
        content: [{
          type: "text",
          text: matches.length > 0
            ? formatCapabilityMatches(matches)
            : `No capabilities found for: ${JSON.stringify(clipCapabilityText(cleanCapabilityText(query), 120))}`,
        }],
        details: { recommended: matches[0], matches },
      };
    },
  });
}

export default capabilityExtension;
