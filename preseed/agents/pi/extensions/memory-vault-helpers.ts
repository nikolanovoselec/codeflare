import { isAbsolute, relative } from "node:path";

export const MEMORY_EVERY_N_PROMPTS = 15;
export const EXTRACTION_RUNNING_TTL_MS = 30 * 60 * 1000;

export type ExtractionJob = "memory-capture" | "vault-extract";
export type ExtractionState = "missing" | "running" | "succeeded" | "failed";

export interface ActiveExtractionRequest {
  version: 1;
  requestId: string;
}

export interface MemoryCaptureRequest {
  version: 1;
  requestId: string;
  sessionId: string;
  promptCount: number;
  captureTimestamp: string;
  captureFilename: string;
  transcript: string;
}

export interface VaultExtractRequest {
  version: 1;
  requestId: string;
  changedFiles: string[];
  stagedManifestHash: string;
}

export interface PublicExtractionRequest {
  subagent_type: ExtractionJob;
  description: string;
  prompt: string;
  run_in_background: true;
  inherit_context: false;
  model?: string;
}

export interface ExtractionTranscriptFacts {
  launchCount: number;
  giveup: boolean;
  attemptCount: number;
  state: ExtractionState;
}

export type ExtractionDue =
  | { kind: "launch"; reminder: 0 | 1 | 2 | 3 | 4 | 5 }
  | { kind: "giveup" }
  | { kind: "none" };

// SINGLE source of truth for vault paths that are generated/agent-owned and must NOT
// trigger vault-extract. Mirrors prompts/vault-extract-prompt.md output paths plus the
// entrypoint.sh boot-preseeded artifacts. Directory-prefix semantics: each entry matches
// the directory itself and anything beneath it.
export const VAULT_GENERATED_PREFIXES = [
  "Raw/Sessions",
  "Raw/Graphs",
  "graphify-out",
  ".silverbullet",
  "Library/Codeflare",
] as const;

export const VAULT_PRESEED_ROOT_FILES = new Set(["Index.md", "README.md", "CONFIG.md", "STYLES.md"]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MANIFEST_HASH_PATTERN = /^[0-9a-f]{64}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function parseActiveExtractionRequest(value: unknown): ActiveExtractionRequest | undefined {
  const candidate = record(value);
  if (candidate?.version !== 1 || !validRequestId(candidate.requestId)) return undefined;
  return { version: 1, requestId: candidate.requestId };
}

export function parseMemoryCaptureRequest(value: unknown): MemoryCaptureRequest | undefined {
  const candidate = record(value);
  if (candidate?.version !== 1 || !validRequestId(candidate.requestId)) return undefined;
  const session = nonEmptyString(candidate.sessionId);
  const captureTimestamp = nonEmptyString(candidate.captureTimestamp);
  const captureFilename = nonEmptyString(candidate.captureFilename);
  const transcript = nonEmptyString(candidate.transcript);
  if (!session || !SESSION_ID_PATTERN.test(session)) return undefined;
  if (typeof candidate.promptCount !== "number" || !Number.isInteger(candidate.promptCount) || candidate.promptCount < 0) return undefined;
  if (!captureTimestamp || !captureFilename || !transcript) return undefined;
  if (!captureFilename.endsWith(".md") || captureFilename.includes("/") || captureFilename.includes("\\")) return undefined;
  return {
    version: 1,
    requestId: candidate.requestId,
    sessionId: session,
    promptCount: Number(candidate.promptCount),
    captureTimestamp,
    captureFilename,
    transcript,
  };
}

export function parseVaultExtractRequest(value: unknown): VaultExtractRequest | undefined {
  const candidate = record(value);
  if (candidate?.version !== 1 || !validRequestId(candidate.requestId)) return undefined;
  if (!Array.isArray(candidate.changedFiles) || candidate.changedFiles.some((path) => typeof path !== "string" || !isAbsolute(path))) return undefined;
  const stagedManifestHash = nonEmptyString(candidate.stagedManifestHash);
  if (!stagedManifestHash || !MANIFEST_HASH_PATTERN.test(stagedManifestHash)) return undefined;
  return {
    version: 1,
    requestId: candidate.requestId,
    changedFiles: [...candidate.changedFiles].sort(),
    stagedManifestHash,
  };
}

export function parseSessionEntries(content: string): any[] {
  const entries: any[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* keep valid entries around malformed lines */ }
  }
  return entries;
}

export function buildPublicExtractionRequest(input: {
  job: ExtractionJob;
  requestId: string;
  promptFile: string;
  varsFile: string;
  model?: string;
}): PublicExtractionRequest {
  const model = input.model?.trim();
  return {
    subagent_type: input.job,
    description: input.job === "memory-capture" ? "Capture session memory" : "Extract Vault graph changes",
    prompt: [
      `CODEFLARE_EXTRACTION_REQUEST=${input.requestId}`,
      `PROMPT_FILE=${input.promptFile}`,
      `VARS_FILE=${input.varsFile}`,
      "Run the deployed Pi extraction contract end to end.",
    ].join("\n"),
    run_in_background: true,
    inherit_context: false,
    ...(model ? { model } : {}),
  };
}

function markerLine(requestId: string): string {
  return `CODEFLARE_EXTRACTION_REQUEST=${requestId}`;
}

function hasExactMarker(prompt: unknown, requestId: string): boolean {
  return typeof prompt === "string" && prompt.split(/\r?\n/).includes(markerLine(requestId));
}

function publicRequestMatches(value: unknown, requestId: string, job: ExtractionJob): boolean {
  const request = record(value);
  return request?.subagent_type === job
    && request.run_in_background === true
    && request.inherit_context === false
    && hasExactMarker(request.prompt, requestId);
}

function launchItems(entry: any): any[] {
  return entry?.type === "custom_message"
    && entry?.customType === "background-extraction-launch"
    && Array.isArray(entry?.details?.items)
    ? entry.details.items
    : [];
}

function giveupItems(entry: any): any[] {
  return entry?.type === "custom_message"
    && entry?.customType === "background-extraction-giveup"
    && Array.isArray(entry?.details?.items)
    ? entry.details.items
    : [];
}

function toolCallParts(entry: any): any[] {
  const content = entry?.message?.role === "assistant" ? entry.message.content : undefined;
  return Array.isArray(content) ? content.filter((part) => part?.type === "toolCall") : [];
}

function notificationFacts(entry: any): { toolUseId: string; status: string } | undefined {
  if (entry?.type !== "custom_message" || entry?.customType !== "subagent-notification" || typeof entry?.content !== "string") return undefined;
  const toolUseId = entry.content.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]?.trim();
  const status = entry.content.match(/<status>([^<]+)<\/status>/)?.[1]?.trim();
  return toolUseId && status ? { toolUseId, status } : undefined;
}

export function extractionTranscriptFacts(input: {
  entries: any[];
  requestId: string;
  job: ExtractionJob;
  now: number;
  successQualifies: () => boolean;
}): ExtractionTranscriptFacts {
  const launchCount = input.entries.reduce((count, entry) => count + launchItems(entry).filter((item) => (
    item?.requestId === input.requestId
      && item?.jobType === input.job
      && Number.isInteger(item?.reminder)
      && item.reminder >= 0
      && item.reminder <= 5
      && publicRequestMatches(item?.request, input.requestId, input.job)
  )).length, 0);
  const giveup = input.entries.some((entry) => giveupItems(entry).some((item) => (
    item?.requestId === input.requestId && item?.jobType === input.job
  )));

  const calls = input.entries.flatMap((entry) => toolCallParts(entry).map((part) => ({
    id: typeof part?.id === "string" ? part.id : "",
    timestamp: entry?.timestamp,
    name: part?.name,
    arguments: part?.arguments,
  }))).filter((call) => call.id
    && call.name === "subagent"
    && publicRequestMatches(call.arguments, input.requestId, input.job));
  const notifications = new Map<string, string>();
  for (const entry of input.entries) {
    const notification = notificationFacts(entry);
    if (notification) notifications.set(notification.toolUseId, notification.status);
  }

  let succeeded = false;
  let running = false;
  for (const call of calls) {
    const status = notifications.get(call.id);
    if ((status === "Done" || status === "Completed") && input.successQualifies()) succeeded = true;
    if (status === undefined) {
      const timestamp = Date.parse(String(call.timestamp ?? ""));
      if (!Number.isFinite(timestamp) || input.now - timestamp < EXTRACTION_RUNNING_TTL_MS) running = true;
    }
  }

  const state: ExtractionState = succeeded
    ? "succeeded"
    : running
      ? "running"
      : calls.length > 0
        ? "failed"
        : "missing";
  return { launchCount, giveup, attemptCount: calls.length, state };
}

export function extractionDue(facts: ExtractionTranscriptFacts): ExtractionDue {
  if (facts.giveup || facts.state === "running" || facts.state === "succeeded") return { kind: "none" };
  if (facts.launchCount < 6) return { kind: "launch", reminder: facts.launchCount as 0 | 1 | 2 | 3 | 4 | 5 };
  return { kind: "giveup" };
}

export function isChildSessionHeader(header: unknown): boolean {
  const candidate = record(header);
  return typeof candidate?.parentSession === "string" && candidate.parentSession.length > 0;
}

export function isChildSessionFirstLine(firstLine: string | undefined): boolean {
  if (!firstLine) return false;
  try {
    const parsed = JSON.parse(firstLine);
    return parsed?.type === "session" && isChildSessionHeader(parsed);
  } catch {
    return false;
  }
}

export function isVaultExcludedPath(vaultRoot: string, path: string): boolean {
  const rel = relative(vaultRoot, path).replaceAll("\\", "/");
  if (!rel || rel.startsWith("..")) return true;
  if (VAULT_PRESEED_ROOT_FILES.has(rel)) return true;
  return VAULT_GENERATED_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}

export const VAULT_MANIFEST_VERSION = 1;
export const VAULT_MANIFEST_RELPATH = "graphify-out/vault-extract-manifest.json";

export interface VaultManifest {
  version: number;
  files: Record<string, string>;
}

export function parseVaultManifest(text: string | null | undefined): VaultManifest {
  if (!text) return { version: VAULT_MANIFEST_VERSION, files: {} };
  try {
    const blob = JSON.parse(text) as { version?: unknown; files?: unknown };
    const files: Record<string, string> = {};
    if (blob && typeof blob.files === "object" && blob.files) {
      for (const [key, value] of Object.entries(blob.files as Record<string, unknown>)) {
        if (typeof value === "string") files[key] = value;
      }
    }
    return { version: typeof blob.version === "number" ? blob.version : VAULT_MANIFEST_VERSION, files };
  } catch {
    return { version: VAULT_MANIFEST_VERSION, files: {} };
  }
}

export function vaultManifestChanges(current: Record<string, string>, manifest: VaultManifest): string[] {
  return Object.entries(current)
    .filter(([path, hash]) => manifest.files[path] !== hash)
    .map(([path]) => path)
    .sort();
}

export function buildVaultManifest(current: Record<string, string>): VaultManifest {
  return {
    version: VAULT_MANIFEST_VERSION,
    files: Object.fromEntries(Object.keys(current).sort().map((path) => [path, current[path]])),
  };
}

export function sessionId(ctx: any): string {
  return String(ctx?.sessionManager?.getSessionId?.() ?? process.ppid).replace(/[^A-Za-z0-9_-]+/g, "_");
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

export function isSyntheticPrompt(prompt: string): boolean {
  const text = prompt.trim();
  return !text
    || text.startsWith("<")
    || text.startsWith("Agent(")
    || text.startsWith("PROMPT_FILE=")
    || text.startsWith("[silent]")
    || text.startsWith("[codeflare-extraction]")
    || text.includes('"directive"')
    || text.includes("subagent_type");
}

export function isRealUserPrompt(message: any): boolean {
  return messageRole(message) === "user" && !isSyntheticPrompt(messageText(message));
}

export function realUserPromptCount(messages: any[]): number {
  return messages.filter(isRealUserPrompt).length;
}

export function withCurrentPrompt(messages: any[], prompt: string): any[] {
  const text = prompt.trim();
  if (isSyntheticPrompt(text)) return messages;
  const lastRealUser = [...messages].reverse().find(isRealUserPrompt);
  if (lastRealUser && messageText(lastRealUser) === text) return messages;
  return [...messages, { role: "user", content: text }];
}

export function compactMessages(messages: any[]): string {
  const turns: string[] = [];
  for (const message of messages) {
    const role = messageRole(message);
    if (role !== "user" && role !== "assistant") continue;
    const text = messageText(message);
    if (!text || (role === "user" && isSyntheticPrompt(text))) continue;
    turns.push(`## ${role}\n${text.slice(0, 8000)}`);
  }
  return turns.slice(-200).join("\n\n");
}

export function parseSessionMessages(content: string): any[] {
  return parseSessionEntries(content)
    .filter((entry) => entry?.type === "message" && entry.message)
    .map((entry) => entry.message);
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

export default function () {
  // Helper module only; loaded by Pi extension scanner as a no-op extension.
}
