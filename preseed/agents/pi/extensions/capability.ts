import { Type } from "typebox";
import {
  activateRegisteredTools,
  activationGroup,
  searchCapabilities,
  type RegisteredTool,
  type ToolActivationPi,
} from "./capability-helpers";

type ExtensionAPI = ToolActivationPi & {
  registerTool(tool: unknown): void;
};

type CapabilityParams = {
  query?: string;
  name?: string;
};

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
