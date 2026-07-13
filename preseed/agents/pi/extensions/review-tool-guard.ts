import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REVIEWER_RUNTIME_MARKER = "<!-- codeflare-reviewer-runtime -->";

function mutableInput(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function registerReviewerToolGuard(pi: ExtensionAPI): void {
  let reviewerSession = false;
  let reviewerRepository: string | undefined;

  pi.on("session_start", () => {
    reviewerSession = false;
    reviewerRepository = undefined;
  });

  pi.on("before_agent_start", (event: { systemPrompt: string }) => {
    reviewerSession = event.systemPrompt.includes(REVIEWER_RUNTIME_MARKER);
    reviewerRepository = undefined;
  });

  pi.on("tool_call", (event: { toolName: string; input: unknown }) => {
    if (!reviewerSession) return;
    const input = mutableInput(event.input);
    if (!input) return;

    if (event.toolName === "ctx_execute") {
      if (Object.prototype.hasOwnProperty.call(input, "intent")) {
        delete input.intent;
      }
      if (typeof input.cwd === "string" && input.cwd.startsWith("/")) {
        reviewerRepository = input.cwd;
      }
      return;
    }

    if (event.toolName === "bash" && typeof input.command === "string" && reviewerRepository) {
      const prefix = `cd ${shellQuote(reviewerRepository)} && `;
      if (!input.command.startsWith(prefix) && !input.command.startsWith(`cd ${reviewerRepository} && `)) {
        input.command = `${prefix}${input.command}`;
      }
    }
  });
}

export default registerReviewerToolGuard;
