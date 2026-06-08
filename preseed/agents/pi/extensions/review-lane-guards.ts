/**
 * Minimal guard extension for detached PR-boundary review lanes.
 *
 * Lanes run with `--no-extensions` so they cannot load the full Codeflare runtime
 * (especially review-enforcement), but they still expose `bash` for read-only git/gh
 * inspection. Keep the same local-build/test/lint/dev-server and AI-attribution
 * blockers that the main session has, without loading recursive review machinery.
 */
import { existsSync, unlinkSync } from "node:fs";
import { attributionBlockReason, localBuildBlockReason } from "./guard-helpers";
import { commandTextFromEvent } from "./review-helpers";

type ExtensionAPI = { on(event: string, handler: (event: unknown) => unknown): void };

function toolEventId(event: unknown): string | undefined {
  const record = event as { toolCallId?: unknown; toolUseId?: unknown; id?: unknown } | undefined;
  const id = record?.toolCallId ?? record?.toolUseId ?? record?.id;
  return typeof id === "string" ? id : undefined;
}

function guardTool(event: unknown): { block: true; reason: string } | undefined {
  const command = commandTextFromEvent(event);
  if (!command) return undefined;
  const attributionReason = attributionBlockReason(command);
  if (attributionReason) return { block: true, reason: attributionReason };
  const buildReason = localBuildBlockReason(command, { existsSync, unlinkSync });
  if (buildReason) return { block: true, reason: buildReason };
  return undefined;
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
