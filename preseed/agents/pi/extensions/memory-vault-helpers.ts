import { createHash } from "node:crypto";
import { basename } from "node:path";

export const MEMORY_EVERY_N_PROMPTS = 15;

export function sessionId(ctx: any): string {
  return String(ctx?.sessionManager?.getSessionId?.() ?? process.ppid).replace(/[^A-Za-z0-9_.-]+/g, "_");
}

export function stableId(input: string): string {
  return `vault:${createHash("sha256").update(input).digest("hex").slice(0, 24)}`;
}

export function titleFor(path: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || basename(path);
}

export function messageRole(message: any): string {
  return message?.role ?? message?.message?.role ?? "unknown";
}

export function messageText(message: any): string {
  const raw = message?.content ?? message?.message?.content ?? "";
  if (typeof raw === "string") return raw.trim();
  if (!Array.isArray(raw)) return "";
  return raw
    .filter((block: any) => (block?.type ?? "text") === "text" && typeof block?.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
}

export function isRealUserPrompt(message: any): boolean {
  if (messageRole(message) !== "user") return false;
  const text = messageText(message);
  if (!text) return false;
  // Mirrors Claude's memory-capture.sh `"role":"user","content":"[^<]` filter:
  // task notifications, slash-command wrappers, and local-command metadata
  // all arrive as user-shaped records whose text starts with a tag.
  return !text.startsWith("<");
}

export function realUserPromptCount(messages: any[]): number {
  return messages.filter(isRealUserPrompt).length;
}

export function withCurrentPrompt(messages: any[], prompt: string): any[] {
  const text = prompt.trim();
  if (!text || text.startsWith("<")) return messages;
  const lastRealUser = [...messages].reverse().find(isRealUserPrompt);
  if (lastRealUser && messageText(lastRealUser) === text) return messages;
  return [...messages, { role: "user", content: text }];
}

export function compactMessages(messages: any[]): string {
  // Prefilter the transcript before handing it to the capture agent: keep user + assistant
  // TEXT only, dropping tool_use / tool_result / thinking blocks. This mirrors the AD58
  // prefilter rationale (kill tool/recency noise, preserve the conversational arc) instead of
  // the old raw last-40-message JSON slice that degraded capture quality on long sessions.
  const turns: string[] = [];
  for (const message of messages) {
    const role = messageRole(message);
    if (role !== "user" && role !== "assistant") continue;
    const text = messageText(message);
    if (!text) continue;
    // Claude's hook excludes synthetic user wrappers by requiring content not to start with "<".
    // Keep Pi aligned so task notifications do not count as memory-worthy prompts.
    if (role === "user" && text.startsWith("<")) continue;
    turns.push(`## ${role}\n${text.slice(0, 8000)}`);
  }
  return turns.slice(-200).join("\n\n");
}

// Parse Pi session JSONL content into the message objects compactMessages expects.
// Pi persists each turn on disk (for /resume) as { type: "message", message: { role, content } };
// non-message entries (session header, compaction, custom, model_change, thinking_level_change)
// and malformed lines are skipped. Returns [] when nothing parses. This is the durable source
// that replaces the volatile in-memory message list, so a capture after a reload still sees the
// full conversation instead of an empty buffer.
export function parseSessionMessages(content: string): any[] {
  const messages: any[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === "message" && entry.message) messages.push(entry.message);
    } catch { /* skip a malformed line, keep the rest */ }
  }
  return messages;
}

export function captureTimestamp(tz?: string): string {
  const now = new Date();
  if (tz) {
    try {
      return now.toLocaleString("sv-SE", { timeZone: tz, hour12: false }).replace(" ", "T").replace(/[:.]/g, "-").slice(0, 19);
    } catch { /* fall through to UTC */ }
  }
  return now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function captureFilename(sid: string, tz?: string): string {
  return `${captureTimestamp(tz)}-${sid}.md`;
}

export function isResumedSession(counterFileExists: boolean, messageCount: number): boolean {
  return !counterFileExists && messageCount > 1;
}

export function shouldCapture(delta: number): boolean {
  return delta >= MEMORY_EVERY_N_PROMPTS;
}

export function isFirstMessage(counterFileExists: boolean, messageCount: number): boolean {
  return !counterFileExists && messageCount === 1;
}

export function buildSpawnOptions(description: string, model?: string): Record<string, unknown> {
  const options: Record<string, unknown> = { description, inheritContext: false };
  // Optional fidelity pin (no hardcoded model name): the model comes from
  // CODEFLARE_MEMORY_MODEL at the call site and is applied only when set, so the
  // runtime default model is used when the env var is absent.
  if (model) options.model = model;
  return options;
}

export default function () {
  // Helper module only; loaded by Pi extension scanner as a no-op extension.
}
