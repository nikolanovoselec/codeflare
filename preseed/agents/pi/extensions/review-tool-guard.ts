import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REVIEWER_RUNTIME_MARKER = "<!-- codeflare-reviewer-runtime -->";

function mutableInput(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

export function registerReviewerToolGuard(pi: ExtensionAPI): void {
  let reviewerSession = false;

  pi.on("session_start", () => {
    reviewerSession = false;
  });

  pi.on("before_agent_start", (event) => {
    reviewerSession = event.systemPrompt.includes(REVIEWER_RUNTIME_MARKER);
  });

  pi.on("tool_call", (event) => {
    if (!reviewerSession || event.toolName !== "ctx_execute") return;
    const input = mutableInput(event.input);
    if (!input || !Object.prototype.hasOwnProperty.call(input, "intent")) return;
    // Pi's tool_call contract applies in-place input mutations to execution.
    delete input.intent;
  });
}

export default registerReviewerToolGuard;
