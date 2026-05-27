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

export function compactMessages(messages: any[]): string {
  return messages.slice(-40).map((message) => {
    const role = message?.role ?? message?.message?.role ?? "unknown";
    const content = message?.content ?? message?.message?.content ?? "";
    return `## ${role}\n${typeof content === "string" ? content : JSON.stringify(content).slice(0, 6000)}`;
  }).join("\n\n");
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

export function shouldCapture(count: number): boolean {
  return count > 0 && count % MEMORY_EVERY_N_PROMPTS === 0;
}

export function isFirstMessage(counterFileExists: boolean, messageCount: number): boolean {
  return !counterFileExists && messageCount === 1;
}

export default function () {
  // Helper module only; loaded by Pi extension scanner as a no-op extension.
}
