import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const INLINE_EDIT_COMMAND = "codeflare-inline-edit";
export const INLINE_EDIT_TOOL = "codeflare_submit_inline_edits";
const MAX_COMMAND_BYTES = 2 * 1024 * 1024;

export type InlineEditCommandPayload = {
  requestId: string;
  prompt: string;
};

type InlineEditProposal = {
  requestId: string;
  edits: Array<{
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    newText: string;
  }>;
};

type ActiveInlineEdit = {
  readonly requestId: string;
  readonly previousTools: readonly string[];
  proposalSubmitted: boolean;
};

export function encodeInlineEditCommandPayload(payload: InlineEditCommandPayload): string {
  validateCommandPayload(payload);
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeInlineEditCommandPayload(value: string): InlineEditCommandPayload {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_COMMAND_BYTES) {
    throw new TypeError("Invalid native Inline Chat command payload");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("Invalid native Inline Chat command payload");
  }
  validateCommandPayload(parsed);
  return parsed;
}

function validateCommandPayload(value: unknown): asserts value is InlineEditCommandPayload {
  if (!isRecord(value) || !validRequestId(value.requestId) || typeof value.prompt !== "string" || value.prompt.length === 0) {
    throw new TypeError("Invalid native Inline Chat command payload");
  }
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && /^inline-[A-Za-z0-9-]{8,80}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export default function registerInlineEditMode(pi: ExtensionAPI): void {
  let active: ActiveInlineEdit | undefined;

  const restoreTools = (): void => {
    const current = active;
    active = undefined;
    if (current) pi.setActiveTools([...current.previousTools]);
  };

  pi.registerTool({
    name: INLINE_EDIT_TOOL,
    label: "Submit native Inline Chat edits",
    description: "Submit one bounded set of host-owned text edits for the active Codeflare Inline Chat document.",
    promptSnippet: "Submit the final native Inline Chat text edits",
    promptGuidelines: [
      "Use codeflare_submit_inline_edits exactly once for a native Inline Chat request and do not emit prose afterward.",
    ],
    parameters: Type.Object({
      requestId: Type.String({ minLength: 15, maxLength: 87 }),
      edits: Type.Array(Type.Object({
        startLine: Type.Integer({ minimum: 0 }),
        startCharacter: Type.Integer({ minimum: 0 }),
        endLine: Type.Integer({ minimum: 0 }),
        endCharacter: Type.Integer({ minimum: 0 }),
        newText: Type.String({ maxLength: 262_144 }),
      }), { minItems: 1, maxItems: 64 }),
    }),
    async execute(_toolCallId: string, proposal: InlineEditProposal) {
      if (!active || proposal.requestId !== active.requestId) {
        throw new Error("Native Inline Chat proposal request correlation failed");
      }
      if (active.proposalSubmitted) {
        throw new Error("Native Inline Chat proposal was already submitted");
      }
      active.proposalSubmitted = true;
      return {
        content: [{ type: "text", text: "Native Inline Chat edit proposal accepted by the host adapter." }],
        details: { requestId: proposal.requestId, editCount: proposal.edits.length },
        terminate: true,
      };
    },
  });

  pi.registerCommand(INLINE_EDIT_COMMAND, {
    description: "Run one host-owned native Inline Chat edit turn",
    handler: async (args, ctx) => {
      if (active) throw new Error("Native Inline Chat mode is already active");
      const payload = decodeInlineEditCommandPayload(args.trim());
      const previousTools = pi.getActiveTools().filter((name) => name !== INLINE_EDIT_TOOL);
      active = { requestId: payload.requestId, previousTools, proposalSubmitted: false };
      pi.setActiveTools([INLINE_EDIT_TOOL]);
      try {
        await ctx.waitForIdle();
        pi.sendUserMessage(payload.prompt);
      } catch (error) {
        restoreTools();
        throw error;
      }
    },
  });

  pi.on("session_start", () => {
    const initial = pi.getActiveTools().filter((name) => name !== INLINE_EDIT_TOOL);
    pi.setActiveTools(initial);
  });

  pi.on("before_agent_start", (event: any) => {
    if (!active) return;
    const contract = [
      "You are handling a Codeflare native Inline Chat edit request.",
      `The required requestId is ${active.requestId}.`,
      `Call ${INLINE_EDIT_TOOL} exactly once with edits for the active editor document.`,
      "Coordinates are zero-based UTF-16 line and character positions.",
      "Return only host-owned edits. Do not describe, apply, or simulate filesystem changes.",
    ].join(" ");
    return { systemPrompt: `${String(event?.systemPrompt ?? "")}\n\n${contract}`.trim() };
  });

  pi.on("tool_call", (event: any) => {
    if (!active || event?.toolName === INLINE_EDIT_TOOL) return;
    return { block: true, reason: "Native Inline Chat permits only host-owned edit proposals" };
  });

  pi.on("agent_settled", restoreTools);
  pi.on("session_shutdown", () => { active = undefined; });
}
