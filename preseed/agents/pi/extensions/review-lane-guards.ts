/**
 * Minimal guard extension for detached PR-boundary review lanes.
 *
 * Lanes run with `--no-extensions` so they cannot load the full Codeflare runtime
 * (especially review-enforcement), but they still expose `bash` for git/gh
 * inspection. Keep local-build/test/lint/dev-server and AI-attribution blockers
 * without loading recursive review machinery. The review lane intentionally ignores
 * the main-session local-build bypass sentinel: headless reviewers are never allowed
 * to consume a user override intended for an interactive session.
 */
import { attributionBlockReason, localBuildBlockReason } from "./guard-helpers";
import { commandTextFromEvent } from "./review-helpers";

type ExtensionAPI = { on(event: string, handler: (event: unknown) => unknown): void };

function toolEventId(event: unknown): string | undefined {
  const record = event as { toolCallId?: unknown; toolUseId?: unknown; id?: unknown } | undefined;
  const id = record?.toolCallId ?? record?.toolUseId ?? record?.id;
  return typeof id === "string" ? id : undefined;
}

export function reviewLaneBlockReason(command: string): string | undefined {
  const attributionReason = attributionBlockReason(command);
  if (attributionReason) return attributionReason;
  return localBuildBlockReason(command, {
    existsSync: () => false,
    unlinkSync: () => undefined,
  });
}

function guardTool(event: unknown): { block: true; reason: string } | undefined {
  const command = commandTextFromEvent(event);
  if (!command) return undefined;
  const reason = reviewLaneBlockReason(command);
  return reason ? { block: true, reason } : undefined;
}

export default function (pi: ExtensionAPI) {
  const gatedToolIds = new Set<string>();
  const runOnce = (event: unknown): { block: true; reason: string } | undefined => {
    const id = toolEventId(event);
    if (id && gatedToolIds.has(id)) return undefined;
    if (id) gatedToolIds.add(id);
    return guardTool(event);
  };
  pi.on("tool_call", runOnce);
  pi.on("tool_execution_start", runOnce);
}
