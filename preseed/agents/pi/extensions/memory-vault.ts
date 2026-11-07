/**
 * Codeflare Pi memory/Vault graph automation.
 *
 * The root session owns durable extraction requests and high-water state. Background
 * agents only produce notes/graphs and report native completion.
 */
import { randomUUID } from "node:crypto";
import { registerActiveSessionTranscriptTrimming, type TranscriptTrimIdentity } from "./active-session-transcript-trimming";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildPublicExtractionRequest,
  captureFilenameAt,
  EXTRACTION_RUNNING_TTL_MS,
  captureTimestamp,
  compactMessages,
  extractionDue,
  extractionTranscriptFacts,
  isChildSessionFirstLine,
  isChildSessionHeader,
  isFirstMessage,
  isRealUserPrompt,
  isGraphifyExtractionChunk,
  isResumedSession,
  isSyntheticPrompt,
  MEMORY_EVERY_N_PROMPTS,
  parseActiveExtractionRequest,
  parseMemoryCaptureRequest,
  parseSessionEntries,
  parseVaultExtractRequest,
  realUserPromptCount,
  realUserPromptFingerprint,
  sessionId,
  shouldCapture,
  vaultManifestChanges,
  withCurrentPrompt,
  type ActiveExtractionRequest,
  type ExtractionJob,
  type MemoryCaptureRequest,
  type PublicExtractionRequest,
  type VaultExtractRequest,
} from "./memory-vault-helpers";
import { activateRegisteredTools, type ToolActivationPi } from "./capability-helpers";
import {
  collectVaultFileHashes,
  commitVaultManifestTo,
  promoteVaultManifest,
  readVaultManifest,
  writeVaultManifest,
} from "./vault-manifest-fs";

export interface MemoryVaultPaths {
  vaultRoot: string;
  cacheDir: string;
  memoryCounterDir: string;
  memoryPromptFile: string;
  vaultPromptFile: string;
  vaultManifestFile: string;
  vaultInitializationFile: string;
  vaultMarkerFile: string;
}

export interface MemoryVaultDependencies {
  paths: MemoryVaultPaths;
  now(): number;
  randomUUID(): string;
}

export interface MemoryVaultPi extends ToolActivationPi {
  events?: { emit(event: string, data: any): void };
  on(event: string, handler: (event: any, ctx: any) => void | Promise<void>): void;
  sendMessage(
    message: {
      customType: string;
      content: string;
      display: true;
      details: { items: Array<Record<string, unknown>> };
    },
    options: { deliverAs: "followUp"; triggerTurn: boolean },
  ): void;
}

const USER_HOME = "/home/user";
const VAULT_ROOT = join(USER_HOME, "Vault");
const CACHE_DIR = join(USER_HOME, ".cache", "codeflare-hooks");
const MEMORY_COUNTER_DIR = "/tmp/.memory-counter";
const PROMPTS_DIR = join(USER_HOME, ".pi", "agent", "prompts");
const GLOBAL_GRAPH_LOCK = "/run/codeflare/locks/graphify-global.lock";

const defaultDependencies: MemoryVaultDependencies = {
  paths: {
    vaultRoot: VAULT_ROOT,
    cacheDir: CACHE_DIR,
    memoryCounterDir: MEMORY_COUNTER_DIR,
    memoryPromptFile: join(PROMPTS_DIR, "memory-agent-prompt.md"),
    vaultPromptFile: join(PROMPTS_DIR, "vault-extract-prompt.md"),
    vaultManifestFile: join(VAULT_ROOT, "graphify-out", "vault-extract-manifest.json"),
    vaultInitializationFile: join(VAULT_ROOT, "graphify-out", "vault-extract-initialized"),
    vaultMarkerFile: join(CACHE_DIR, "vault-extract.last"),
  },
  now: () => Date.now(),
  randomUUID,
};

interface ActiveMemoryRequest {
  pointer: ActiveExtractionRequest;
  request: MemoryCaptureRequest;
  executionPath: string;
}

interface ActiveVaultRequest {
  pointer: ActiveExtractionRequest;
  request: VaultExtractRequest;
  executionPath: string;
}

function ensureDirs(paths: MemoryVaultPaths): void {
  mkdirSync(paths.cacheDir, { recursive: true });
  mkdirSync(paths.memoryCounterDir, { recursive: true });
  mkdirSync(join(paths.vaultRoot, "Raw", "Sessions"), { recursive: true });
  mkdirSync(join(paths.vaultRoot, "Notes"), { recursive: true });
  mkdirSync(join(paths.vaultRoot, "graphify-out"), { recursive: true });
}

export function addGraphToGlobal(graph: string, tag: string, cwd: string): void {
  execFileSync("flock", ["-w", "5", GLOBAL_GRAPH_LOCK, "graphify", "global", "add", graph, "--as", tag], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function vaultGraphPath(paths: MemoryVaultPaths): string {
  return join(paths.vaultRoot, "graphify-out", "vault-graph.json");
}

function bestEffortMergeGraphs(paths: MemoryVaultPaths): void {
  const vaultGraph = vaultGraphPath(paths);
  if (existsSync(vaultGraph)) {
    try { addGraphToGlobal(vaultGraph, "user_vault", paths.vaultRoot); } catch { /* best effort on session start */ }
  }
  try {
    const repo = readFileSync(join(paths.cacheDir, "graphify-active-cwd"), "utf8").trim();
    const repoGraph = join(repo, "graphify-out", "graph.json");
    if (repo && existsSync(repoGraph)) addGraphToGlobal(repoGraph, basename(repo), repo);
  } catch { /* no active repo graph */ }
}

function isChildSession(ctx: any): boolean {
  try {
    const header = ctx?.sessionManager?.getHeader?.();
    if (header) return isChildSessionHeader(header);
  } catch { /* fall through to persisted header */ }
  try {
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    if (!sessionFile || !existsSync(sessionFile)) return false;
    return isChildSessionFirstLine(readFileSync(sessionFile, "utf8").split("\n", 1)[0]);
  } catch {
    return false;
  }
}

function counterPath(paths: MemoryVaultPaths, session: string): string {
  return join(paths.memoryCounterDir, `${session}.count`);
}

interface MemoryProgress {
  promptCount: number;
  transcriptFingerprint?: string;
  captureFilename?: string;
  captureTimestamp?: string;
}

function progressPath(paths: MemoryVaultPaths, session: string): string {
  return join(paths.memoryCounterDir, `${session}.progress.json`);
}

function readMemoryProgress(paths: MemoryVaultPaths, session: string, promptCount: number): MemoryProgress | undefined {
  const value = readJson(progressPath(paths, session)) as Partial<MemoryProgress> | undefined;
  if (value?.promptCount !== promptCount || typeof value.transcriptFingerprint !== "string"
    || !/^[0-9a-f]{64}$/.test(value.transcriptFingerprint)) return undefined;
  return { promptCount, transcriptFingerprint: value.transcriptFingerprint };
}

function captureInstant(value: string): number {
  const normalized = value.replace(/^"(.*)"$/, "$1")
    .replace(/T(\d{2})-(\d{2})-(\d{2})([+-]\d{2})(\d{2})$/, "T$1:$2:$3$4:$5");
  const instant = Date.parse(normalized);
  return Number.isFinite(instant) ? instant : 0;
}

// Restore the latest capture, not the largest count from a previous transcript epoch.
function latestCapturedPromptCount(paths: MemoryVaultPaths, session: string, matching?: MemoryProgress): MemoryProgress {
  const sessionsDir = join(paths.vaultRoot, "Raw", "Sessions");
  let latest: MemoryProgress = { promptCount: 0 };
  let latestInstant = -Infinity;
  let latestName = "";
  try {
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith(".md")) continue;
      let frontmatter: string;
      try {
        frontmatter = readFileSync(join(sessionsDir, name), "utf8").slice(0, 2048)
          .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
      } catch { continue; }
      const capturedSession = frontmatter.match(/^session_id:[ \t]*(\S+)[ \t]*$/m)?.[1];
      const capturedCount = Number(frontmatter.match(/^captured_prompt_count:[ \t]*(\d+)[ \t]*$/m)?.[1]);
      if (capturedSession !== session || !Number.isSafeInteger(capturedCount) || capturedCount < 0) continue;
      const timestamp = frontmatter.match(/^captured_at:[ \t]*(.+)$/m)?.[1]?.trim()
        ?? name.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}[+-]\d{4})/)?.[1] ?? "";
      const instant = captureInstant(timestamp);
      if (instant < latestInstant || (instant === latestInstant && name <= latestName)) continue;
      const transcriptFingerprint = frontmatter.match(/^captured_prompt_fingerprint:[ \t]*([0-9a-f]{64})[ \t]*$/m)?.[1];
      if (matching && (capturedCount !== matching.promptCount || transcriptFingerprint !== matching.transcriptFingerprint)) continue;
      latest = { promptCount: capturedCount, captureFilename: name, captureTimestamp: timestamp.replace(/^"(.*)"$/, "$1"),
        ...(transcriptFingerprint ? { transcriptFingerprint } : {}) };
      latestInstant = instant;
      latestName = name;
    }
  } catch { /* no durable captures yet */ }
  return latest;
}

function committedMemoryProgress(paths: MemoryVaultPaths, session: string): MemoryProgress {
  const countFile = counterPath(paths, session);
  const counterExists = existsSync(countFile);
  const savedCount = readCount(countFile);
  const saved = counterExists ? readMemoryProgress(paths, session, savedCount) : undefined;
  if (saved) return saved;
  const durable = latestCapturedPromptCount(paths, session);
  return !counterExists || durable.promptCount === savedCount ? durable : { promptCount: savedCount };
}

function memoryActiveVarsPath(paths: MemoryVaultPaths, session: string): string {
  return join(paths.memoryCounterDir, `${session}.vars`);
}

function memoryExecutionVarsPath(paths: MemoryVaultPaths, session: string, requestId: string): string {
  return join(paths.cacheDir, `memory-capture.${session}.${requestId}.vars`);
}

function legacyMemoryExecutionVarsPath(paths: MemoryVaultPaths, session: string, requestId: string): string {
  return join(paths.memoryCounterDir, `${session}.${requestId}.vars`);
}

function vaultActiveVarsPath(paths: MemoryVaultPaths): string {
  return join(paths.cacheDir, "vault-extract.pi.vars");
}

function vaultExecutionVarsPath(paths: MemoryVaultPaths, requestId: string): string {
  return join(paths.cacheDir, `vault-extract.pi.${requestId}.vars`);
}

function stagedManifestPath(paths: MemoryVaultPaths, requestId: string): string {
  return join(paths.vaultRoot, "graphify-out", `vault-extract-manifest.${requestId}.pending.json`);
}

function requestChunkPath(paths: MemoryVaultPaths, requestId: string): string {
  return join(paths.vaultRoot, "graphify-out", `.graphify_chunk_${requestId}.json`);
}

function requestWorkingChunkPath(paths: MemoryVaultPaths, requestId: string): string {
  return `${requestChunkPath(paths, requestId)}.work`;
}

function captureOutputPath(paths: MemoryVaultPaths, request: MemoryCaptureRequest): string {
  return join(paths.vaultRoot, "Raw", "Sessions", request.captureFilename);
}

function readCount(path: string): number {
  try { return Number.parseInt(readFileSync(path, "utf8").trim(), 10) || 0; } catch { return 0; }
}

function safeUnlink(path: string): void {
  try { unlinkSync(path); } catch { /* idempotent cleanup */ }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp.${process.pid}`;
  writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  renameSync(temporaryPath, path);
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function readActivePointer(path: string): ActiveExtractionRequest | undefined {
  return parseActiveExtractionRequest(readJson(path));
}

function readActiveMemoryRequest(paths: MemoryVaultPaths, session: string): ActiveMemoryRequest | undefined {
  const pointerPath = memoryActiveVarsPath(paths, session);
  const pointer = readActivePointer(pointerPath);
  if (!pointer) {
    if (existsSync(pointerPath)) safeUnlink(pointerPath);
    return undefined;
  }
  const executionPath = memoryExecutionVarsPath(paths, session, pointer.requestId);
  let request = parseMemoryCaptureRequest(readJson(executionPath));
  if (!request) {
    const legacyPath = legacyMemoryExecutionVarsPath(paths, session, pointer.requestId);
    const legacyRequest = parseMemoryCaptureRequest(readJson(legacyPath));
    if (legacyRequest?.requestId === pointer.requestId && legacyRequest.sessionId === session) {
      writeJsonAtomic(executionPath, legacyRequest);
      safeUnlink(legacyPath);
      request = legacyRequest;
    }
  }
  if (!request || request.requestId !== pointer.requestId || request.sessionId !== session) {
    safeUnlink(pointerPath);
    return undefined;
  }
  return { pointer, request, executionPath };
}

function readActiveVaultRequest(paths: MemoryVaultPaths): ActiveVaultRequest | undefined {
  const pointerPath = vaultActiveVarsPath(paths);
  const pointer = readActivePointer(pointerPath);
  if (!pointer) {
    if (existsSync(pointerPath)) safeUnlink(pointerPath);
    return undefined;
  }
  const executionPath = vaultExecutionVarsPath(paths, pointer.requestId);
  const request = parseVaultExtractRequest(readJson(executionPath));
  if (!request || request.requestId !== pointer.requestId) {
    safeUnlink(pointerPath);
    return undefined;
  }
  return { pointer, request, executionPath };
}

function readSessionEntries(ctx: any): any[] {
  try {
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    return sessionFile && existsSync(sessionFile) ? parseSessionEntries(readFileSync(sessionFile, "utf8")) : [];
  } catch {
    return [];
  }
}

function sessionMessages(entries: any[], fallback: any[]): any[] {
  const messages = entries.filter((entry) => entry?.type === "message" && entry.message).map((entry) => entry.message);
  return messages.length > 0 ? messages : fallback;
}

function createMemoryRequest(input: {
  paths: MemoryVaultPaths;
  dependencies: MemoryVaultDependencies;
  session: string;
  promptCount: number;
  afterPromptCount: number;
  messages: any[];
  timezone?: string;
}): MemoryCaptureRequest | undefined {
  const transcript = compactMessages(input.messages, input.afterPromptCount);
  if (!transcript.trim()) return undefined;
  const timestamp = captureTimestamp(input.timezone);
  const request: MemoryCaptureRequest = {
    version: 1,
    requestId: input.dependencies.randomUUID(),
    sessionId: input.session,
    promptCount: input.promptCount,
    captureTimestamp: timestamp,
    captureFilename: captureFilenameAt(timestamp, input.session),
    transcript,
    transcriptFingerprint: realUserPromptFingerprint(input.messages, input.promptCount),
  };
  writeJsonAtomic(memoryExecutionVarsPath(input.paths, input.session, request.requestId), request);
  writeJsonAtomic(memoryActiveVarsPath(input.paths, input.session), { version: 1, requestId: request.requestId });
  return request;
}

function stageVaultRequest(
  paths: MemoryVaultPaths,
  hashes: Record<string, string>,
  changedFiles: string[],
  requestId: string,
  replacePointer = true,
  ownerSessionId?: string,
  createdAt?: number,
): VaultExtractRequest {
  const stagedManifestHash = writeVaultManifest(stagedManifestPath(paths, requestId), hashes);
  const request: VaultExtractRequest = {
    version: 1,
    requestId,
    changedFiles: [...changedFiles].sort(),
    stagedManifestHash,
    ...(ownerSessionId ? { ownerSessionId } : {}),
    ...(typeof createdAt === "number" ? { createdAt } : {}),
  };
  writeJsonAtomic(vaultExecutionVarsPath(paths, requestId), request);
  if (replacePointer) writeJsonAtomic(vaultActiveVarsPath(paths), { version: 1, requestId });
  return request;
}

function absoluteChangedFiles(paths: MemoryVaultPaths, hashes: Record<string, string>): string[] {
  return vaultManifestChanges(hashes, readVaultManifest(paths.vaultManifestFile)).map((path) => join(paths.vaultRoot, path));
}

function cleanupVaultRequest(paths: MemoryVaultPaths, active: ActiveVaultRequest, removePointer: boolean): void {
  if (removePointer) {
    const current = readActivePointer(vaultActiveVarsPath(paths));
    if (current?.requestId === active.pointer.requestId) safeUnlink(vaultActiveVarsPath(paths));
  }
  safeUnlink(active.executionPath);
  safeUnlink(stagedManifestPath(paths, active.request.requestId));
  safeUnlink(requestChunkPath(paths, active.request.requestId));
  safeUnlink(requestWorkingChunkPath(paths, active.request.requestId));
}

function requestChunkQualifies(paths: MemoryVaultPaths, requestId: string): boolean {
  const chunk = readJson(requestChunkPath(paths, requestId));
  return isGraphifyExtractionChunk(chunk)
    && Array.isArray((chunk as Record<string, unknown>)?.nodes)
    && ((chunk as Record<string, unknown>).nodes as unknown[]).length > 0;
}

function memorySuccessQualifies(paths: MemoryVaultPaths, request: MemoryCaptureRequest): boolean {
  return existsSync(captureOutputPath(paths, request))
    && requestChunkQualifies(paths, request.requestId);
}

function vaultSuccessQualifies(paths: MemoryVaultPaths, request: VaultExtractRequest): boolean {
  return request.changedFiles.length === 0 || requestChunkQualifies(paths, request.requestId);
}

function persistCaptureProgress(paths: MemoryVaultPaths, request: Pick<MemoryCaptureRequest,
  "sessionId" | "captureFilename" | "captureTimestamp" | "promptCount" | "transcriptFingerprint">): void {
  const target = join(paths.vaultRoot, "Raw", "Sessions", request.captureFilename);
  const content = readFileSync(target, "utf8");
  const existing = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const otherMetadata = existing ? existing[1].split(/\r?\n/).filter((line) =>
    !/^(?:session_id|captured_at|captured_prompt_count|captured_prompt_fingerprint):/.test(line)) : [];
  const metadata = [
    `session_id: ${request.sessionId}`,
    `captured_at: ${JSON.stringify(request.captureTimestamp)}`,
    `captured_prompt_count: ${request.promptCount}`,
    ...(request.transcriptFingerprint ? [`captured_prompt_fingerprint: ${request.transcriptFingerprint}`] : []),
    ...otherMetadata,
  ];
  const body = existing ? content.slice(existing[0].length) : content;
  const temporaryPath = `${target}.tmp.${process.pid}`;
  writeFileSync(temporaryPath, `---\n${metadata.join("\n")}\n---\n${body}`, "utf8");
  renameSync(temporaryPath, target);
}

type TranslatedCapture = { requestId: string; progress: MemoryProgress };

function captureProgress(request: MemoryCaptureRequest, entries: any[], translated?: TranslatedCapture): MemoryProgress {
  return translated?.requestId === request.requestId
    && realUserPromptCount(entries) >= translated.progress.promptCount
    && realUserPromptFingerprint(entries, translated.progress.promptCount) === translated.progress.transcriptFingerprint
    ? translated.progress : request;
}

function cadenceWindowKey(session: string, progress: MemoryProgress, currentCount: number, lastCount = progress.promptCount): string {
  return `cadence:${session}:${progress.promptCount}:${progress.transcriptFingerprint ?? ""}:${Math.floor((currentCount - lastCount) / MEMORY_EVERY_N_PROMPTS)}`;
}

function finalizeMemorySuccess(
  paths: MemoryVaultPaths,
  dependencies: MemoryVaultDependencies,
  entries: any[],
  session: string,
  translated?: TranslatedCapture,
): MemoryProgress | undefined {
  const active = readActiveMemoryRequest(paths, session);
  if (!active) return;
  const facts = extractionTranscriptFacts({
    entries,
    requestId: active.request.requestId,
    job: "memory-capture",
    now: dependencies.now(),
    successQualifies: () => memorySuccessQualifies(paths, active.request),
  });
  if (facts.state !== "succeeded") return;
  const currentPointer = readActivePointer(memoryActiveVarsPath(paths, active.request.sessionId));
  if (currentPointer?.requestId !== active.pointer.requestId) return;
  // Commit the frozen prefix, even when its count is lower than an older epoch.
  // Durable metadata precedes ephemeral state so a restart can recover this success.
  // A verified own trim may translate the frozen boundary, never the uncaptured tail.
  const progress = captureProgress(active.request, entries, translated);
  persistCaptureProgress(paths, { ...active.request, ...progress });
  writeFileSync(counterPath(paths, active.request.sessionId), String(progress.promptCount), "utf8");
  writeJsonAtomic(progressPath(paths, active.request.sessionId), {
    promptCount: progress.promptCount,
    ...(progress.transcriptFingerprint ? { transcriptFingerprint: progress.transcriptFingerprint } : {}),
  });
  safeUnlink(memoryActiveVarsPath(paths, active.request.sessionId));
  safeUnlink(active.executionPath);
  safeUnlink(requestChunkPath(paths, active.request.requestId));
  safeUnlink(requestWorkingChunkPath(paths, active.request.requestId));
  return progress !== active.request ? progress : undefined;
}

function refreshPendingVaultRequest(
  paths: MemoryVaultPaths,
  dependencies: MemoryVaultDependencies,
  entries: any[],
  session: string,
): void {
  const active = readActiveVaultRequest(paths);
  if (!active || (active.request.ownerSessionId && active.request.ownerSessionId !== session)) return;
  const facts = extractionTranscriptFacts({
    entries,
    requestId: active.request.requestId,
    job: "vault-extract",
    now: dependencies.now(),
    successQualifies: () => vaultSuccessQualifies(paths, active.request),
  });
  if (facts.giveup) {
    cleanupVaultRequest(paths, active, true);
    return;
  }
  if (facts.attemptCount === 0) {
    const current = collectVaultFileHashes(paths.vaultRoot);
    stageVaultRequest(
      paths,
      current,
      absoluteChangedFiles(paths, current),
      active.request.requestId,
      false,
      active.request.ownerSessionId,
      active.request.createdAt,
    );
  }
}

function touchVaultMarker(paths: MemoryVaultPaths): void {
  mkdirSync(paths.cacheDir, { recursive: true });
  writeFileSync(paths.vaultMarkerFile, "", "utf8");
}

function commitVaultManifest(paths: MemoryVaultPaths): void {
  commitVaultManifestTo(paths.vaultRoot, paths.vaultManifestFile);
  touchVaultMarker(paths);
}

function finalizeVaultSuccess(
  paths: MemoryVaultPaths,
  dependencies: MemoryVaultDependencies,
  entries: any[],
  session: string,
): void {
  const active = readActiveVaultRequest(paths);
  if (!active || (active.request.ownerSessionId && active.request.ownerSessionId !== session)) return;
  const facts = extractionTranscriptFacts({
    entries,
    requestId: active.request.requestId,
    job: "vault-extract",
    now: dependencies.now(),
    successQualifies: () => vaultSuccessQualifies(paths, active.request),
  });
  if (facts.state !== "succeeded") return;

  const promotion = promoteVaultManifest(
    stagedManifestPath(paths, active.request.requestId),
    paths.vaultManifestFile,
    active.request.stagedManifestHash,
  );
  if (promotion === "promoted" || promotion === "already-promoted") {
    touchVaultMarker(paths);
    cleanupVaultRequest(paths, active, true);
    return;
  }

  const current = collectVaultFileHashes(paths.vaultRoot);
  const changedFiles = absoluteChangedFiles(paths, current);
  if (changedFiles.length > 0) {
    stageVaultRequest(paths, current, changedFiles, dependencies.randomUUID(), true, session, dependencies.now());
    cleanupVaultRequest(paths, active, false);
  } else {
    cleanupVaultRequest(paths, active, true);
  }
}

function detectNewVaultRequestWhenNoneExists(
  paths: MemoryVaultPaths,
  dependencies: MemoryVaultDependencies,
  session: string,
): void {
  const active = readActiveVaultRequest(paths);
  if (active) {
    const foreign = active.request.ownerSessionId && active.request.ownerSessionId !== session;
    const stale = typeof active.request.createdAt === "number"
      && dependencies.now() - active.request.createdAt >= EXTRACTION_RUNNING_TTL_MS;
    if (!foreign || !stale) return;
    cleanupVaultRequest(paths, active, true);
  }
  const current = collectVaultFileHashes(paths.vaultRoot);
  const changedFiles = absoluteChangedFiles(paths, current);
  if (changedFiles.length > 0) {
    stageVaultRequest(paths, current, changedFiles, dependencies.randomUUID(), true, session, dependencies.now());
  }
}

function dueItem(
  paths: MemoryVaultPaths,
  request: MemoryCaptureRequest | VaultExtractRequest,
  job: ExtractionJob,
  reminder: number,
): { requestId: string; jobType: ExtractionJob; reminder: number; request: PublicExtractionRequest } {
  const varsFile = job === "memory-capture"
    ? memoryExecutionVarsPath(paths, (request as MemoryCaptureRequest).sessionId, request.requestId)
    : vaultExecutionVarsPath(paths, request.requestId);
  return {
    requestId: request.requestId,
    jobType: job,
    reminder,
    request: buildPublicExtractionRequest({
      job,
      requestId: request.requestId,
      promptFile: job === "memory-capture" ? paths.memoryPromptFile : paths.vaultPromptFile,
      varsFile,
      model: process.env.CODEFLARE_MEMORY_MODEL,
    }),
  };
}

function sendDueExtractionMessages(
  pi: MemoryVaultPi,
  paths: MemoryVaultPaths,
  dependencies: MemoryVaultDependencies,
  entries: any[],
  memory: MemoryCaptureRequest | undefined,
  vault: VaultExtractRequest | undefined,
  queued: Set<string>,
  trim: Record<string, unknown> | undefined,
): void {
  const launches: Array<Record<string, unknown>> = [];
  const giveups: Array<Record<string, unknown>> = [];
  for (const item of [
    memory ? { request: memory, job: "memory-capture" as const } : undefined,
    vault ? { request: vault, job: "vault-extract" as const } : undefined,
  ]) {
    if (!item) continue;
    const facts = extractionTranscriptFacts({
      entries,
      requestId: item.request.requestId,
      job: item.job,
      now: dependencies.now(),
      successQualifies: () => item.job === "memory-capture"
        ? memorySuccessQualifies(paths, item.request as MemoryCaptureRequest)
        : vaultSuccessQualifies(paths, item.request as VaultExtractRequest),
    });
    for (let reminder = 0; reminder < facts.launchCount; reminder++) queued.delete(`${item.job}:${item.request.requestId}:${reminder}`);
    const due = extractionDue(facts);
    if (due.kind === "launch" && !queued.has(`${item.job}:${item.request.requestId}:${due.reminder}`)) {
      launches.push(dueItem(paths, item.request, item.job, due.reminder));
    }
    if (due.kind === "giveup") giveups.push({ requestId: item.request.requestId, jobType: item.job });
  }
  if (trim?.giveup === true) giveups.push({ requestId: trim.requestId, jobType: "transcript-trim" });
  else if (trim && !queued.has(`${String(trim.jobType)}:${String(trim.requestId)}:${String(trim.reminder)}`)) launches.push(trim);
  if (launches.length > 0) {
    activateRegisteredTools(pi, ["subagent"]);
    const jobs = launches.map((item) => (
      `- \`${String(item.jobType)}\` · delivery ${Number(item.reminder) + 1}/6`
    ));
    pi.sendMessage({
      customType: "background-extraction-launch",
      content: [
        "## Extraction jobs ready",
        "",
        "**Action:** Start every `item.request` as a public background subagent call, unchanged exactly once. Start all calls together.",
        "",
        "**Jobs**",
        "",
        ...jobs,
        "",
        "**Request payload**",
        "",
        "JSON `\\n` escapes become line breaks when submitted; terminal wrapping does not change the request.",
        "",
        "<extraction-items-json>",
        JSON.stringify(launches, null, 2),
        "</extraction-items-json>",
      ].join("\n"),
      display: true,
      details: { items: launches },
    }, { deliverAs: "followUp", triggerTurn: true });
    for (const item of launches) queued.add(`${String(item.jobType)}:${String(item.requestId)}:${String(item.reminder)}`);
  }
  if (giveups.length > 0) {
    const jobs = giveups.map((item) => (
      `- \`${String(item.jobType)}\` · request \`${String(item.requestId)}\` · 6/6 failed calls`
    ));
    const next = giveups.flatMap((item) => item.jobType === "memory-capture"
      ? [`- \`memory-capture\`: a new request may re-arm after ${MEMORY_EVERY_N_PROMPTS} later real user prompts`]
      : item.jobType === "transcript-trim"
        ? ["- `transcript-trim`: the next legitimate extraction cadence may re-arm maintenance"]
        : ["- `vault-extract`: a new Vault edit may re-arm delivery"]);
    pi.sendMessage({
      customType: "background-extraction-giveup",
      content: [
        "## Extraction delivery stopped",
        "",
        "**Jobs**",
        "",
        ...jobs,
        "",
        "**State**",
        "",
        "- Committed counters and manifests were not advanced.",
        "- Delivery is latched; this request receives no further reminders.",
        "",
        "**Next automatic opportunity**",
        "",
        ...next,
        "",
        "Inspect the exact public calls and their correlated native notifications before retrying manually.",
      ].join("\n"),
      display: true,
      details: { items: giveups },
    }, { deliverAs: "followUp", triggerTurn: false });
  }
}

export function registerMemoryVault(pi: MemoryVaultPi, dependencies: MemoryVaultDependencies): void {
  const { paths } = dependencies;
  let lastMessages: any[] = [];
  const queuedLaunches = new Set<string>();
  let translatedCapture: TranslatedCapture | undefined;
  const aliasServicedWindow = (session: string, before: MemoryProgress, beforeCount: number, after: MemoryProgress, afterCount: number) => {
    // Only carry a window that was actually serviced; a later crossing stays new.
    if (queuedLaunches.has(cadenceWindowKey(session, before, beforeCount))) {
      queuedLaunches.add(cadenceWindowKey(session, after, afterCount));
    }
  };
  let trimCheckpoint: { owner: TranscriptTrimIdentity; verify(): void } | undefined;
  const sameTrim = (a: TranscriptTrimIdentity, b: TranscriptTrimIdentity) => a.requestId === b.requestId
    && a.sessionId === b.sessionId && a.file === b.file;
  const trimming = registerActiveSessionTranscriptTrimming(pi as unknown as ExtensionAPI, undefined, (owner, phase, ctx) => {
    if (phase !== "before") {
      if (!trimCheckpoint || !sameTrim(trimCheckpoint.owner, owner)) return;
      const proof = trimCheckpoint;
      trimCheckpoint = undefined;
      if (phase === "verified" && ctx && sessionId(ctx) === owner.sessionId
        && ctx.sessionManager.getSessionFile() === owner.file) proof.verify();
      return;
    }
    if (!ctx || sessionId(ctx) !== owner.sessionId || ctx.sessionManager.getSessionFile() !== owner.file) return;
    const session = owner.sessionId;
    const source = readSessionEntries(ctx).filter(isRealUserPrompt);
    // Published notes are not acceptance authority when the committed cursor exists.
    const baseline = existsSync(counterPath(paths, session)) ? committedMemoryProgress(paths, session) : { promptCount: 0 };
    const active = readActiveMemoryRequest(paths, session)?.request;
    // Bind only checkpoints whose complete prefix still matches before our write.
    // An arbitrary earlier shortening/rewrite must retain REQ-MEM-025 recovery.
    const bind = (progress: MemoryProgress | undefined) => {
      if (!progress?.transcriptFingerprint || progress.promptCount < 1 || source.length < progress.promptCount
        || realUserPromptFingerprint(source, progress.promptCount) !== progress.transcriptFingerprint) return undefined;
      const captured = source.slice(0, progress.promptCount);
      const frontier = captured.at(-1);
      if (typeof frontier?.id !== "string") return undefined;
      return () => {
        const retained = readSessionEntries(ctx).filter(isRealUserPrompt);
        const index = retained.findIndex(entry => entry.id === frontier.id);
        if (index < 0 || retained.filter(entry => entry.id === frontier.id).length !== 1) return undefined;
        const prefix = retained.slice(0, index + 1);
        const suffix = captured.slice(captured.length - prefix.length);
        if (prefix.length > captured.length || prefix.some((entry, i) => entry.id !== suffix[i]?.id)
          || realUserPromptFingerprint(prefix, prefix.length) !== realUserPromptFingerprint(suffix, suffix.length)) return undefined;
        return { promptCount: prefix.length, transcriptFingerprint: realUserPromptFingerprint(prefix, prefix.length) };
      };
    };
    const baselineTranslation = bind(baseline);
    const activeFrontier = active ? captureProgress(active, source, translatedCapture) : undefined;
    const activeTranslation = bind(activeFrontier);
    trimCheckpoint = { owner: { requestId: owner.requestId, sessionId: session, file: owner.file }, verify: () => {
      if (sessionId(ctx) !== session || ctx.sessionManager.getSessionFile() !== owner.file) return;
      const late = activeTranslation?.();
      if (active && late) translatedCapture = { requestId: active.requestId, progress: late };
      // Success may have completed while the trim worker was running.
      const committed = committedMemoryProgress(paths, session);
      const completedActive = active && activeFrontier && (
        (committed.promptCount === activeFrontier.promptCount && committed.transcriptFingerprint === activeFrontier.transcriptFingerprint)
        || (committed.promptCount === active.promptCount && committed.transcriptFingerprint === active.transcriptFingerprint));
      const before = completedActive ? committed : baseline;
      const after = completedActive ? late : baselineTranslation?.();
      if (!after || committed.promptCount !== before.promptCount || committed.transcriptFingerprint !== before.transcriptFingerprint
        || !existsSync(counterPath(paths, session))) return;
      const successful = latestCapturedPromptCount(paths, session, committed);
      if (!successful.captureFilename || !successful.captureTimestamp) return;
      persistCaptureProgress(paths, { sessionId: session, captureFilename: successful.captureFilename,
        captureTimestamp: successful.captureTimestamp, ...after });
      writeJsonAtomic(progressPath(paths, session), after);
      writeFileSync(counterPath(paths, session), String(after.promptCount), "utf8");
      const retainedCount = realUserPromptCount(readSessionEntries(ctx));
      aliasServicedWindow(session, before, retainedCount + before.promptCount - after.promptCount, after, retainedCount);
    } };
  });
  const cancelTrimming = () => {
    trimCheckpoint = undefined;
    trimming.cancel();
  };
  const resetSessionTrimming = () => {
    translatedCapture = undefined;
    cancelTrimming();
  };
  for (const event of ["session_before_switch", "session_before_fork", "session_shutdown"]) pi.on(event, resetSessionTrimming);

  pi.on("session_start", (_event, ctx) => {
    resetSessionTrimming();
    if (isChildSession(ctx)) return;
    queuedLaunches.clear();
    const vaultExisted = existsSync(paths.vaultRoot);
    ensureDirs(paths);
    bestEffortMergeGraphs(paths);
    // Entrypoint owns production first initialization. The fallback below keeps
    // the extension independently usable in tests/development, while the durable
    // marker prevents a later missing or corrupt R2 restore from being rebaselined.
    if (!existsSync(paths.vaultInitializationFile)) {
      if (!vaultExisted && !existsSync(paths.vaultManifestFile)) commitVaultManifest(paths);
      writeFileSync(paths.vaultInitializationFile, "1\n", "utf8");
    }
  });

  const reconcileEligibility = (ctx: any, prompt?: string) => {
    if (isChildSession(ctx)) return;
    // A rename may precede asynchronous readback. Do not stage a recovery capture
    // in that short window; the existing next owner boundary reconciles it.
    if (trimCheckpoint?.owner.sessionId === sessionId(ctx)
      && trimCheckpoint.owner.file === ctx.sessionManager.getSessionFile()) return;
    ensureDirs(paths);
    const entries = readSessionEntries(ctx);
    const session = sessionId(ctx);
    refreshPendingVaultRequest(paths, dependencies, entries, session);

    if (prompt !== undefined && isSyntheticPrompt(prompt)) return;

    const countFile = counterPath(paths, session);
    const counterExists = existsSync(countFile);
    const progress = committedMemoryProgress(paths, session);
    const persistedMessages = sessionMessages(entries, lastMessages);
    const messages = prompt === undefined ? persistedMessages : withCurrentPrompt(persistedMessages, prompt);
    const currentCount = realUserPromptCount(messages);
    const rebased = currentCount < progress.promptCount || (progress.transcriptFingerprint !== undefined
      && realUserPromptFingerprint(messages, progress.promptCount) !== progress.transcriptFingerprint);
    const lastCount = rebased ? 0 : progress.promptCount;
    const resumed = isResumedSession(counterExists, currentCount);
    const cadenceDue = rebased || resumed || shouldCapture(currentCount - lastCount);
    const cadenceKey = cadenceWindowKey(session, progress, currentCount, lastCount);
    if (cadenceDue && !queuedLaunches.has(cadenceKey)) {
      queuedLaunches.add(cadenceKey);
      trimming.markDue(ctx);
      detectNewVaultRequestWhenNoneExists(paths, dependencies, session);
    }
    const active = readActiveMemoryRequest(paths, session);
    if (active) {
      const facts = extractionTranscriptFacts({
        entries,
        requestId: active.request.requestId,
        job: "memory-capture",
        now: dependencies.now(),
        successQualifies: () => memorySuccessQualifies(paths, active.request),
      });
      const frontier = captureProgress(active.request, messages, translatedCapture);
      if (frontier === active.request && translatedCapture?.requestId === active.request.requestId) translatedCapture = undefined;
      const activePrefixChanged = currentCount < frontier.promptCount
        || (frontier.transcriptFingerprint !== undefined
          && realUserPromptFingerprint(messages, frontier.promptCount) !== frontier.transcriptFingerprint);
      if (facts.giveup && (activePrefixChanged || shouldCapture(currentCount - frontier.promptCount))) {
        const replacement = createMemoryRequest({
          paths,
          dependencies,
          session,
          promptCount: currentCount,
          afterPromptCount: lastCount,
          messages,
          timezone: process.env.USER_TIMEZONE || process.env.TZ || undefined,
        });
        if (replacement) {
          if (activePrefixChanged) {
            trimming.markDue(ctx);
            detectNewVaultRequestWhenNoneExists(paths, dependencies, session);
          }
          safeUnlink(active.executionPath);
          safeUnlink(requestChunkPath(paths, active.request.requestId));
          safeUnlink(requestWorkingChunkPath(paths, active.request.requestId));
        }
      }
      return;
    }

    if (!rebased && isFirstMessage(counterExists, currentCount) && progress.promptCount === 0) {
      writeFileSync(countFile, String(currentCount), "utf8");
      bestEffortMergeGraphs(paths);
      return;
    }
    if (!rebased && !resumed && !shouldCapture(currentCount - lastCount)) return;
    createMemoryRequest({
      paths,
      dependencies,
      session,
      promptCount: currentCount,
      afterPromptCount: lastCount,
      messages,
      timezone: process.env.USER_TIMEZONE || process.env.TZ || undefined,
    });
  };
  pi.on("before_agent_start", (event, ctx) => reconcileEligibility(ctx, String(event?.prompt ?? "")));

  pi.on("agent_end", (event, ctx) => {
    if (isChildSession(ctx)) return;
    lastMessages = Array.isArray(event?.messages) ? event.messages : lastMessages;
  });

  const advanceExtraction = (ctx: any) => {
    if (isChildSession(ctx)) return;
    ensureDirs(paths);
    const entries = readSessionEntries(ctx);
    const session = sessionId(ctx);
    const beforeTranslation = translatedCapture ? committedMemoryProgress(paths, session) : undefined;
    const translatedSuccess = finalizeMemorySuccess(paths, dependencies, entries, session, translatedCapture);
    if (translatedSuccess && beforeTranslation) {
      const count = realUserPromptCount(entries);
      aliasServicedWindow(session, beforeTranslation, count, translatedSuccess, count);
    }
    if (translatedCapture && !readActiveMemoryRequest(paths, session)) translatedCapture = undefined;
    finalizeVaultSuccess(paths, dependencies, entries, session);
    // Queued real prompts may cross a boundary inside the current agent run.
    // Reconcile at the existing completed-turn/settlement owner, without a new wakeup.
    reconcileEligibility(ctx);
    const memory = readActiveMemoryRequest(paths, session)?.request;
    const activeVault = readActiveVaultRequest(paths)?.request;
    const vault = !activeVault?.ownerSessionId || activeVault.ownerSessionId === session
      ? activeVault
      : undefined;
    sendDueExtractionMessages(pi, paths, dependencies, entries, memory, vault, queuedLaunches, trimming.collect(ctx));
  };
  pi.on("turn_end", (event, ctx) => {
    const message = event.message;
    if (event.outcome === "aborted" || ctx.signal?.aborted) { cancelTrimming(); return; }
    if (message?.role !== "assistant" || message.stopReason !== "stop"
      || !Array.isArray(message.content) || message.content.some((block: any) => block.type === "toolCall")) return;
    advanceExtraction(ctx);
  });
  pi.on("agent_settled", (event, ctx) => { if (event?.aborted || ctx.signal?.aborted) cancelTrimming(); else advanceExtraction(ctx); });
}

export default function memoryVault(pi: ExtensionAPI): void {
  registerMemoryVault(pi as unknown as MemoryVaultPi, defaultDependencies);
}
