import { isAbsolute, relative } from "node:path";

export const MEMORY_EVERY_N_PROMPTS = 15;
export const MEMORY_CAPTURE_MAX_TOTAL_CHARS = 200000;
export const MEMORY_CAPTURE_MAX_TURN_CHARS = 10000;
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
  thinking: "medium";
  max_turns: 4;
  model?: string;
}

export interface ExtractionTranscriptFacts {
  launchCount: number;
  giveup: boolean;
  attemptCount: number;
  pendingLaunch: boolean;
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

const GRAPHIFY_FILE_TYPES = new Set(["code", "document", "concept"]);
const GRAPHIFY_RELATIONS = new Set(["contains", "references", "conceptually_related_to", "cites"]);
const GRAPHIFY_CONFIDENCE = new Set(["EXTRACTED", "INFERRED"]);

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function finiteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validate the canonical chunk written by the bounded Pi extraction contract. */
export function isGraphifyExtractionChunk(value: unknown): boolean {
  const chunk = record(value);
  if (!chunk || !Array.isArray(chunk.nodes) || !Array.isArray(chunk.edges) || !Array.isArray(chunk.hyperedges)) return false;
  if (!finiteNumber(chunk.input_tokens) || Number(chunk.input_tokens) < 0) return false;
  if (!finiteNumber(chunk.output_tokens) || Number(chunk.output_tokens) < 0) return false;
  if (chunk.nodes.some((value) => {
    const node = record(value);
    return !node
      || !nonEmptyString(node.id)
      || !nonEmptyString(node.label)
      || typeof node.file_type !== "string"
      || !GRAPHIFY_FILE_TYPES.has(node.file_type)
      || !nullableString(node.source_file)
      || !nullableString(node.source_location)
      || !nullableString(node.source_url)
      || !nullableString(node.captured_at)
      || !nullableString(node.author)
      || !nullableString(node.contributor);
  })) return false;
  if (chunk.edges.some((value) => {
    const edge = record(value);
    return !edge
      || !nonEmptyString(edge.source)
      || !nonEmptyString(edge.target)
      || typeof edge.relation !== "string"
      || !GRAPHIFY_RELATIONS.has(edge.relation)
      || typeof edge.confidence !== "string"
      || !GRAPHIFY_CONFIDENCE.has(edge.confidence)
      || !finiteNumber(edge.confidence_score)
      || Number(edge.confidence_score) < 0
      || Number(edge.confidence_score) > 1
      || !nonEmptyString(edge.source_file)
      || !nullableString(edge.source_location)
      || !finiteNumber(edge.weight)
      || Number(edge.weight) <= 0;
  })) return false;
  return true;
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
      ...(input.job === "memory-capture"
        ? ["VARS_FILE contains the transcript inline; there is no INPUT_FILE or separate transcript file."]
        : []),
      "Run the deployed Pi extraction contract end to end.",
    ].join("\n"),
    run_in_background: true,
    inherit_context: false,
    thinking: "medium",
    max_turns: 4,
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
    && request.thinking === "medium"
    && request.max_turns === 4
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

function isCompletedNotification(status: string | undefined): boolean {
  return status === "Done" || status === "Completed" || status === "Wrapped up (turn limit)";
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
  const pendingLaunch = launchCount > calls.length;
  const notifications = new Map<string, string>();
  for (const entry of input.entries) {
    const notification = notificationFacts(entry);
    if (notification) notifications.set(notification.toolUseId, notification.status);
  }

  let succeeded = false;
  let running = false;
  for (const call of calls) {
    const status = notifications.get(call.id);
    if (isCompletedNotification(status) && input.successQualifies()) succeeded = true;
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
  return { launchCount, giveup, attemptCount: calls.length, pendingLaunch, state };
}

export function extractionDue(facts: ExtractionTranscriptFacts): ExtractionDue {
  if (facts.giveup || facts.pendingLaunch || facts.state === "running" || facts.state === "succeeded") return { kind: "none" };
  if (facts.attemptCount < 6) return { kind: "launch", reminder: facts.attemptCount as 0 | 1 | 2 | 3 | 4 | 5 };
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
    || text.startsWith("<task-notification>")
    || text.startsWith("Agent(")
    || text.startsWith("PROMPT_FILE=")
    || text.startsWith("[silent]")
    || text.startsWith("[codeflare-extraction]")
    || (text.startsWith("## Extraction jobs ready") && text.includes("\n<extraction-items-json>\n"));
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

// Truncation drops whatever sat past the cap, and what sits there is often the
// turn conclusion: the REQ a change closed, the ADR it cited, the SHA it landed
// as. Those must be verbatim (AD58) and are what a later graph query searches
// on, so the cap is allowed to cost prose but never a citation. Sorted and
// deduped to match the Claude prefilter's jq `unique`, so both runtimes emit
// the same rescue line for the same turn.
const CITATION = /REQ-[A-Z]+-\d+|AD\d+|#\d{2,}|\b[0-9a-f]{7,40}\b/g;

function citations(text: string): string[] {
  return [...new Set(text.match(CITATION) ?? [])].sort();
}

// The rescue list is bounded because it is appended AFTER the per-turn cap, so
// an unbounded one would make that cap meaningless: a turn carrying a pasted
// `git log --format=%H` has thousands of distinct hashes, and the resulting
// line can exceed the whole payload budget on its own. selectTurns costs a turn
// at its post-rescue length and stops at the first turn that does not fit, so
// one such turn arriving newest would skip the entire user pass and drop every
// prompt in the window.
export const MEMORY_CAPTURE_MAX_RESCUED_REFS = 50;

export function capTurn(text: string, max = MEMORY_CAPTURE_MAX_TURN_CHARS): string {
  if (text.length <= max) return text;
  const kept = text.slice(0, max);
  const inKept = new Set(citations(kept));
  const lost = citations(text).filter((citation) => !inKept.has(citation))
    .slice(0, MEMORY_CAPTURE_MAX_RESCUED_REFS);
  return lost.length > 0 ? `${kept}\n[refs dropped in truncation: ${lost.join(", ")}]` : kept;
}

// The capture trigger counts real user prompts (15); the payload ceiling used to
// count messages (40). The two units convert at a rate that swings with how
// agentic the window was -- measured, ~2.5 messages per prompt on a light
// session and ~25 on a heavy one -- so a message count either sat idle or cut a
// 15-prompt window down to the last 9 of its prompts, permanently: the prompt
// counter advances whether or not the slice kept everything.
//
// Budget characters instead, which is what the payload actually costs, and spend
// them on user prompts before assistant turns. The prompts are what the window
// is defined by; the assistant turns elaborate on them. Both passes run
// newest-first and stop at the first turn that does not fit, so the result is a
// suffix per role and the budget is a hard ceiling even when the prompts alone
// would exceed it.
export function selectTurns<T extends { role: string; text: string }>(
  turns: T[],
  budget = MEMORY_CAPTURE_MAX_TOTAL_CHARS,
): T[] {
  const keep = new Set<number>();
  let spent = 0;
  for (const role of ["user", "assistant"]) {
    for (let index = turns.length - 1; index >= 0; index--) {
      if (turns[index].role !== role) continue;
      const cost = turns[index].text.length;
      if (spent + cost > budget) break;
      spent += cost;
      keep.add(index);
    }
  }
  return turns.filter((_, index) => keep.has(index));
}

export function compactMessages(messages: any[], afterRealUserCount = 0): string {
  const turns: { role: string; text: string }[] = [];
  let realUserCount = 0;
  let includeFollowingTurns = afterRealUserCount === 0;
  for (const message of messages) {
    const role = messageRole(message);
    let includeCurrent = includeFollowingTurns;
    if (role === "user" && isRealUserPrompt(message)) {
      realUserCount += 1;
      includeCurrent = realUserCount > afterRealUserCount;
      includeFollowingTurns = realUserCount >= afterRealUserCount;
    }
    if (!includeCurrent || (role !== "user" && role !== "assistant")) continue;
    const text = messageText(message);
    if (!text || (role === "user" && isSyntheticPrompt(text))) continue;
    turns.push({ role, text: capTurn(text) });
  }
  return selectTurns(turns).map((turn) => `## ${turn.role}\n${turn.text}`).join("\n\n");
}

export function parseSessionMessages(content: string): any[] {
  return parseSessionEntries(content)
    .filter((entry) => entry?.type === "message" && entry.message)
    .map((entry) => entry.message);
}

function formatCaptureTimestamp(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const offsetName = value("timeZoneName");
  const offset = offsetName === "GMT"
    ? "+0000"
    : offsetName.replace(/^GMT([+-]\d{2}):(\d{2})$/, "$1$2");
  if (!/^[+-]\d{4}$/.test(offset)) throw new Error(`Unsupported timezone offset: ${offsetName}`);
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}-${value("minute")}-${value("second")}${offset}`;
}

export function captureTimestamp(tz?: string): string {
  const now = new Date();
  try {
    return formatCaptureTimestamp(now, tz ?? "UTC");
  } catch {
    return formatCaptureTimestamp(now, "UTC");
  }
}

export function captureFilenameAt(timestamp: string, sid: string): string {
  return `${timestamp}-${sid.slice(-8)}.md`;
}

export function captureFilename(sid: string, tz?: string): string {
  return captureFilenameAt(captureTimestamp(tz), sid);
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
