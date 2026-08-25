import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi-subagents exports its public accessor from this exact reviewed entrypoint. Seed
// extensions resolve it through the adjacent Pi npm cache at session start.
const SUBAGENTS_SERVICE_ENTRYPOINT = "../npm/node_modules/@gotgenes/pi-subagents/src/service/service.ts";

export type SubagentRecordLookup = (id: string) => {
  id: string;
  status: string;
} | undefined;

export type SubagentsServiceLoader = () => Promise<{
  getRecord(id: string): ReturnType<SubagentRecordLookup>;
} | undefined>;

async function loadSubagentsService(): ReturnType<SubagentsServiceLoader> {
  const { getSubagentsService } = await import(SUBAGENTS_SERVICE_ENTRYPOINT) as {
    getSubagentsService(): Awaited<ReturnType<SubagentsServiceLoader>>;
  };
  return getSubagentsService();
}

type ToolCallEvent = {
  toolName: string;
  input: unknown;
};

type GuardPi = Pick<ExtensionAPI, "on">;

function resumeId(event: ToolCallEvent): string | undefined {
  if (event.toolName !== "subagent" || !event.input || typeof event.input !== "object") return undefined;
  const value = Reflect.get(event.input, "resume");
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return id.length > 0 ? id : undefined;
}

export function subagentResumeBlockReason(
  event: ToolCallEvent,
  lookup: SubagentRecordLookup | undefined,
): string | undefined {
  const id = resumeId(event);
  if (!id) return undefined;
  if (!lookup) {
    return "Subagent status is unavailable. Use get_subagent_result before resuming a retained session.";
  }
  const record = lookup(id);
  if (!record || (record.status !== "queued" && record.status !== "running")) return undefined;
  return `Agent "${id}" is ${record.status}. Use get_subagent_result for status or steer_subagent to redirect it; resume only a settled retained session.`;
}

export function registerSubagentResumeGuard(
  pi: GuardPi,
  lookup?: SubagentRecordLookup,
): void {
  pi.on("tool_call", (event: ToolCallEvent) => {
    const reason = subagentResumeBlockReason(event, lookup);
    if (reason) return { block: true, reason };
  });
}

export default function subagentResumeGuard(
  pi: GuardPi,
  loadService: SubagentsServiceLoader = loadSubagentsService,
): void {
  let lookup: SubagentRecordLookup | undefined;
  // All extensions have initialized before session_start, so this captures the
  // root service before any in-process child can replace the global accessor.
  pi.on("session_start", async () => {
    const service = await loadService();
    lookup = service ? (id) => service.getRecord(id) : undefined;
  });
  pi.on("tool_call", (event: ToolCallEvent) => {
    const reason = subagentResumeBlockReason(event, lookup);
    if (reason) return { block: true, reason };
  });
}
