import { Type } from "typebox";
import {
  activateRegisteredTools,
  initialActiveTools,
  searchCapabilities,
  type RegisteredTool,
  type ToolActivationPi,
} from "./capability-helpers";

type ExtensionAPI = ToolActivationPi & {
  registerTool(tool: unknown): void;
  on(event: string, handler: () => void): void;
};

type CapabilityParams = {
  query?: string;
  name?: string;
};

export function capabilityExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "capability",
    label: "Tool Search",
    description: "Search or activate registered Pi tools when the active tools do not cover the task.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Tool capability to search for." })),
      name: Type.Optional(Type.String({ description: "Exact registered tool name to activate." })),
    }),
    async execute(_id: string, params: CapabilityParams) {
      const name = params.name?.trim();
      if (name) {
        const tool = pi.getAllTools().find((candidate: RegisteredTool) => candidate.name === name);
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        const added = activateRegisteredTools(pi, [tool.name]);
        return {
          content: [{
            type: "text",
            text: added.length > 0 ? `Loaded tool: ${tool.name}` : `Tool already active: ${tool.name}`,
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

  pi.on("session_start", () => {
    pi.setActiveTools(initialActiveTools(pi));
  });
}

export default capabilityExtension;
