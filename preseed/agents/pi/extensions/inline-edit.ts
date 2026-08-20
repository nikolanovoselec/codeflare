import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const INLINE_EDIT_COMMAND = "codeflare-inline-edit";
export const INLINE_EDIT_TOOL = "codeflare_submit_inline_result";
const MAX_COMMAND_BYTES = 2 * 1024 * 1024;
const SIDEBAR_PROCESS_GENERATION_ENV = "CODEFLARE_SIDEBAR_PROCESS_GENERATION";

export type InlineEditCommandPayload = {
  requestId: string;
  prompt: string;
};

type InlineEditResult = {
  outcome: string;
  summary: string;
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
  resultSubmitted: boolean;
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

function isOpenAiChatFunctionTool(value: unknown, name: string): boolean {
  return isRecord(value)
    && value.type === "function"
    && isRecord(value.function)
    && value.function.name === name;
}

function isOpenAiResponsesFunctionTool(value: unknown, name: string): boolean {
  return isRecord(value)
    && value.type === "function"
    && value.name === name;
}

export function requestSidebarReasoningSummary(payload: unknown): unknown {
  if (
    !isRecord(payload)
    || !Array.isArray(payload.input)
    || !isRecord(payload.reasoning)
    || payload.reasoning.summary !== "auto"
  ) return payload;
  return {
    ...payload,
    reasoning: { ...payload.reasoning, summary: "detailed" },
  };
}

export function constrainInlineOpenAiPayload(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) return payload;
  if (Array.isArray(payload.messages)) {
    const resultTool = payload.tools.find((tool) => isOpenAiChatFunctionTool(tool, INLINE_EDIT_TOOL));
    if (!resultTool) return payload;
    return {
      ...payload,
      tools: [resultTool],
      tool_choice: { type: "function", function: { name: INLINE_EDIT_TOOL } },
      parallel_tool_calls: false,
    };
  }
  if (Array.isArray(payload.input)) {
    const resultTool = payload.tools.find((tool) => isOpenAiResponsesFunctionTool(tool, INLINE_EDIT_TOOL));
    if (!resultTool) return payload;
    return {
      ...payload,
      tools: [resultTool],
      tool_choice: { type: "function", name: INLINE_EDIT_TOOL },
      parallel_tool_calls: false,
    };
  }
  return payload;
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
    label: "Submit native Inline Chat result",
    description: "Submit one host-owned edit or no-change result for the invoking Codeflare Inline Chat document.",
    promptSnippet: "Submit the final native Inline Chat result",
    promptGuidelines: [
      `Submit exactly one ${INLINE_EDIT_TOOL} call and do not emit prose afterward.`,
      "Inline Chat is an edit surface: treat the invoking prompt as a request to change the selected document.",
      "Use outcome edit with one or more edits whenever the requested change can be made.",
      "Use outcome noChange only when the requested state already exists or no valid safe edit can be formed; a brief prompt or the word here is not a no-change reason.",
      "If invalid arguments are rejected, correct them within the same turn; never submit a second accepted result.",
    ],
    parameters: Type.Object({
      outcome: Type.String({ enum: ["edit", "noChange"] }),
      summary: Type.String({ minLength: 1, maxLength: 500 }),
      edits: Type.Array(Type.Object({
        startLine: Type.Integer({ minimum: 0 }),
        startCharacter: Type.Integer({ minimum: 0 }),
        endLine: Type.Integer({ minimum: 0 }),
        endCharacter: Type.Integer({ minimum: 0 }),
        newText: Type.String({ maxLength: 262_144 }),
      }), { minItems: 0, maxItems: 64 }),
    }),
    async execute(_toolCallId: string, result: InlineEditResult) {
      if (!active) throw new Error("Native Inline Chat has no active editor turn");
      if (active.resultSubmitted) throw new Error("Native Inline Chat result was already submitted");
      if (result.outcome !== "edit" && result.outcome !== "noChange") {
        throw new Error("Native Inline Chat result outcome is invalid");
      }
      if (
        (result.outcome === "edit" && result.edits.length === 0)
        || (result.outcome === "noChange" && result.edits.length !== 0)
      ) {
        throw new Error("Native Inline Chat result outcome does not match its edits");
      }
      active.resultSubmitted = true;
      return {
        content: [{ type: "text", text: "Native Inline Chat result accepted by the host adapter." }],
        details: {
          requestId: active.requestId,
          outcome: result.outcome,
          editCount: result.edits.length,
          summary: result.summary,
        },
        terminate: true,
      };
    },
  });

  pi.registerCommand(INLINE_EDIT_COMMAND, {
    description: "Run one host-owned native Inline Chat turn",
    handler: async (args, ctx) => {
      if (active) throw new Error("Native Inline Chat mode is already active");
      const payload = decodeInlineEditCommandPayload(args.trim());
      const previousTools = pi.getActiveTools().filter((name) => name !== INLINE_EDIT_TOOL);
      active = { requestId: payload.requestId, previousTools, resultSubmitted: false };
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

  pi.on("before_agent_start", () => {
    if (!active) return;
    return {
      systemPrompt: [
        "You are handling one Codeflare native Inline Chat edit request.",
        `Call ${INLINE_EDIT_TOOL} exactly once and emit no prose outside that call.`,
        "Treat the invoking prompt as a request to change the selected document and return edits whenever that change can be made.",
        "Use noChange only when the requested state already exists or no valid safe edit can be formed; never infer no change merely because the prompt is brief or says here.",
        "Edit coordinates are zero-based UTF-16 line and character positions.",
        "Do not use filesystem tools or expose chain-of-thought.",
      ].join(" "),
    };
  });

  pi.on("context", (event: any) => {
    if (!active || !Array.isArray(event?.messages)) return;
    let currentUserIndex = -1;
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const message = event.messages[index];
      if (isRecord(message) && message.role === "user") {
        currentUserIndex = index;
        break;
      }
    }
    return { messages: currentUserIndex < 0 ? [] : event.messages.slice(currentUserIndex) };
  });

  pi.on("before_provider_request", (event: any) => {
    const sidebarGeneration = process.env[SIDEBAR_PROCESS_GENERATION_ENV];
    const isSidebarProcess = typeof sidebarGeneration === "string" && sidebarGeneration.length > 0;
    if (active) return constrainInlineOpenAiPayload(event?.payload);
    if (!isSidebarProcess) return;
    return requestSidebarReasoningSummary(event?.payload);
  });

  pi.on("tool_call", (event: any) => {
    if (!active || event?.toolName === INLINE_EDIT_TOOL) return;
    return { block: true, reason: "Native Inline Chat permits only the host-owned result tool" };
  });

  pi.on("agent_settled", restoreTools);
  pi.on("session_shutdown", () => { active = undefined; });
}
