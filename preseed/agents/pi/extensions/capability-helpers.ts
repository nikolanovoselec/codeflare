export type RegisteredTool = { name: string; description?: string };

export type ToolActivationPi = {
  getActiveTools(): string[];
  getAllTools(): RegisteredTool[];
  setActiveTools(names: string[]): void;
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
  "ask_user_question",
  "capability",
  "graphify_query",
  "graphify_path",
  "graphify_explain",
] as const;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function initialActiveTools(pi: ToolActivationPi): string[] {
  const registered = new Set(pi.getAllTools().map((tool) => tool.name));
  const enabledContextTools = pi.getActiveTools().filter((name) => name.startsWith("ctx_") && registered.has(name));
  return unique([
    ...CORE_TOOL_NAMES.filter((name) => registered.has(name)),
    ...enabledContextTools,
  ]);
}

export function activateRegisteredTools(pi: ToolActivationPi, requested: string[]): string[] {
  const registered = new Set(pi.getAllTools().map((tool) => tool.name));
  const active = pi.getActiveTools();
  const activeSet = new Set(active);
  const added = unique(requested).filter((name) => registered.has(name) && !activeSet.has(name));
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
    .map((tool) => ({ tool, score: matchScore(input.query, tool) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .slice(0, input.limit ?? 5)
    .map(({ tool }) => ({ kind: "tool", name: tool.name, description: tool.description ?? "" }));
}
