/**
 * Codeflare Pi memory/Vault graph automation.
 *
 * The root session owns durable extraction requests and high-water state. Background
 * agents only produce notes/graphs and report native completion.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildPublicExtractionRequest,
  captureTimestamp,
  compactMessages,
  extractionDue,
  extractionTranscriptFacts,
  isChildSessionFirstLine,
  isChildSessionHeader,
  isFirstMessage,
  isResumedSession,
  isSyntheticPrompt,
  parseActiveExtractionRequest,
  parseMemoryCaptureRequest,
  parseSessionEntries,
  parseVaultExtractRequest,
  realUserPromptCount,
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
import {
  collectVaultFileHashes,
  commitVaultManifestTo,
  promoteVaultManifest,
  readVaultManifest,
  vaultManifestContentHash,
  writeVaultManifest,
} from "./vault-manifest-fs";

export interface MemoryVaultPaths {
  vaultRoot: string;
  cacheDir: string;
  memoryCounterDir: string;
  memoryPromptFile: string;
  vaultPromptFile: string;
  vaultManifestFile: string;
  vaultMarkerFile: string;
}

export interface MemoryVaultDependencies {
  paths: MemoryVaultPaths;
  now(): number;
  randomUUID(): string;
}

export interface MemoryVaultPi {
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
const GLOBAL_GRAPH_LOCK = "/tmp/graphify-global.lock";

const defaultDependencies: MemoryVaultDependencies = {
  paths: {
    vaultRoot: VAULT_ROOT,
    cacheDir: CACHE_DIR,
    memoryCounterDir: MEMORY_COUNTER_DIR,
    memoryPromptFile: join(PROMPTS_DIR, "memory-agent-prompt.md"),
    vaultPromptFile: join(PROMPTS_DIR, "vault-extract-prompt.md"),
    vaultManifestFile: join(VAULT_ROOT, "graphify-out", "vault-extract-manifest.json"),
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
  mkdirSync(join(paths.vaultRoot, "graphify-out"), { recursive: true });
}

function addGraphToGlobal(graph: string, tag: string, cwd: string): void {
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

function memoryActiveVarsPath(paths: MemoryVaultPaths, session: string): string {
  return join(paths.memoryCounterDir, `${session}.vars`);
}

function memoryExecutionVarsPath(paths: MemoryVaultPaths, session: string, requestId: string): string {
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
  const request = parseMemoryCaptureRequest(readJson(executionPath));
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
    captureFilename: `${timestamp}-${input.session}.md`,
    transcript,
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
): VaultExtractRequest {
  const stagedManifestHash = writeVaultManifest(stagedManifestPath(paths, requestId), hashes);
  const request: VaultExtractRequest = {
    version: 1,
    requestId,
    changedFiles: [...changedFiles].sort(),
    stagedManifestHash,
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

function memorySuccessQualifies(paths: MemoryVaultPaths, request: MemoryCaptureRequest): boolean {
  return existsSync(captureOutputPath(paths, request))
    && existsSync(requestChunkPath(paths, request.requestId));
}

function vaultSuccessQualifies(paths: MemoryVaultPaths, request: VaultExtractRequest): boolean {
  return request.changedFiles.length === 0 || existsSync(requestChunkPath(paths, request.requestId));
}

function finalizeMemorySuccess(
  paths: MemoryVaultPaths,
  dependencies: MemoryVaultDependencies,
  entries: any[],
  session: string,
): void {
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
  const countPath = counterPath(paths, active.request.sessionId);
  writeFileSync(countPath, String(Math.max(readCount(countPath), active.request.promptCount)), "utf8");
  const currentPointer = readActivePointer(memoryActiveVarsPath(paths, active.request.sessionId));
  if (currentPointer?.requestId !== active.pointer.requestId) return;
  safeUnlink(memoryActiveVarsPath(paths, active.request.sessionId));
  safeUnlink(active.executionPath);
  safeUnlink(requestChunkPath(paths, active.request.requestId));
  safeUnlink(requestWorkingChunkPath(paths, active.request.requestId));
}

function refreshPendingVaultRequest(
  paths: MemoryVaultPaths,
  dependencies: MemoryVaultDependencies,
  entries: any[],
): void {
  const active = readActiveVaultRequest(paths);
  if (!active) return;
  const facts = extractionTranscriptFacts({
    entries,
    requestId: active.request.requestId,
    job: "vault-extract",
    now: dependencies.now(),
    successQualifies: () => vaultSuccessQualifies(paths, active.request),
  });
  if (facts.giveup) {
    const current = collectVaultFileHashes(paths.vaultRoot);
    if (vaultManifestContentHash(current) === active.request.stagedManifestHash) return;
    const changedFiles = absoluteChangedFiles(paths, current);
    if (changedFiles.length === 0) {
      cleanupVaultRequest(paths, active, true);
      return;
    }
    const replacementId = dependencies.randomUUID();
    stageVaultRequest(paths, current, changedFiles, replacementId);
    cleanupVaultRequest(paths, active, false);
    return;
  }
  if (facts.attemptCount === 0) {
    const current = collectVaultFileHashes(paths.vaultRoot);
    stageVaultRequest(paths, current, absoluteChangedFiles(paths, current), active.request.requestId, false);
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
): void {
  const active = readActiveVaultRequest(paths);
  if (!active) return;
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
    const current = collectVaultFileHashes(paths.vaultRoot);
    const changedFiles = absoluteChangedFiles(paths, current);
    if (changedFiles.length > 0 && !readActiveVaultRequest(paths)) {
      stageVaultRequest(paths, current, changedFiles, dependencies.randomUUID());
    }
    return;
  }

  const current = collectVaultFileHashes(paths.vaultRoot);
  const changedFiles = absoluteChangedFiles(paths, current);
  if (changedFiles.length > 0) {
    stageVaultRequest(paths, current, changedFiles, dependencies.randomUUID());
    cleanupVaultRequest(paths, active, false);
  } else {
    cleanupVaultRequest(paths, active, true);
  }
}

function detectNewVaultRequestWhenNoneExists(paths: MemoryVaultPaths, dependencies: MemoryVaultDependencies): void {
  if (readActiveVaultRequest(paths)) return;
  const current = collectVaultFileHashes(paths.vaultRoot);
  const changedFiles = absoluteChangedFiles(paths, current);
  if (changedFiles.length > 0) stageVaultRequest(paths, current, changedFiles, dependencies.randomUUID());
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
    const due = extractionDue(facts);
    if (due.kind === "launch") launches.push(dueItem(paths, item.request, item.job, due.reminder));
    if (due.kind === "giveup") giveups.push({ requestId: item.request.requestId, jobType: item.job });
  }
  if (launches.length > 0) {
    pi.sendMessage({
      customType: "background-extraction-launch",
      content: "[codeflare-extraction] Launch every request in details.items together through public background subagent calls, unchanged exactly once.",
      display: true,
      details: { items: launches },
    }, { deliverAs: "followUp", triggerTurn: true });
  }
  if (giveups.length > 0) {
    pi.sendMessage({
      customType: "background-extraction-giveup",
      content: "[codeflare-extraction] Extraction delivery reached GIVEUP after the initial request and five reminders.",
      display: true,
      details: { items: giveups },
    }, { deliverAs: "followUp", triggerTurn: false });
  }
}

export function registerMemoryVault(pi: MemoryVaultPi, dependencies: MemoryVaultDependencies): void {
  const { paths } = dependencies;
  let lastMessages: any[] = [];

  pi.on("session_start", (_event, ctx) => {
    if (isChildSession(ctx)) return;
    ensureDirs(paths);
    bestEffortMergeGraphs(paths);
    if (!existsSync(paths.vaultManifestFile)) commitVaultManifest(paths);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (isChildSession(ctx)) return;
    ensureDirs(paths);
    const entries = readSessionEntries(ctx);
    refreshPendingVaultRequest(paths, dependencies, entries);

    const prompt = String(event?.prompt ?? "");
    if (isSyntheticPrompt(prompt)) return;

    const session = sessionId(ctx);
    const countFile = counterPath(paths, session);
    const counterExists = existsSync(countFile);
    const lastCount = counterExists ? readCount(countFile) : 0;
    const messages = withCurrentPrompt(sessionMessages(entries, lastMessages), prompt);
    const currentCount = realUserPromptCount(messages);
    const active = readActiveMemoryRequest(paths, session);
    if (active) {
      const facts = extractionTranscriptFacts({
        entries,
        requestId: active.request.requestId,
        job: "memory-capture",
        now: dependencies.now(),
        successQualifies: () => memorySuccessQualifies(paths, active.request),
      });
      if (facts.giveup && currentCount >= active.request.promptCount + 15) {
        const replacement = createMemoryRequest({
          paths,
          dependencies,
          session,
          promptCount: currentCount,
          afterPromptCount: lastCount,
          messages,
          timezone: process.env.TZ || process.env.USER_TIMEZONE || undefined,
        });
        if (replacement) {
          safeUnlink(active.executionPath);
          safeUnlink(requestChunkPath(paths, active.request.requestId));
          safeUnlink(requestWorkingChunkPath(paths, active.request.requestId));
        }
      }
      return;
    }

    if (isFirstMessage(counterExists, currentCount)) {
      writeFileSync(countFile, String(currentCount), "utf8");
      bestEffortMergeGraphs(paths);
      return;
    }
    if (!isResumedSession(counterExists, currentCount) && !shouldCapture(currentCount - lastCount)) return;
    createMemoryRequest({
      paths,
      dependencies,
      session,
      promptCount: currentCount,
      afterPromptCount: lastCount,
      messages,
      timezone: process.env.TZ || process.env.USER_TIMEZONE || undefined,
    });
  });

  pi.on("agent_end", (event, ctx) => {
    if (isChildSession(ctx)) return;
    lastMessages = Array.isArray(event?.messages) ? event.messages : lastMessages;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (isChildSession(ctx)) return;
    ensureDirs(paths);
    const entries = readSessionEntries(ctx);
    const session = sessionId(ctx);
    finalizeMemorySuccess(paths, dependencies, entries, session);
    finalizeVaultSuccess(paths, dependencies, entries);
    detectNewVaultRequestWhenNoneExists(paths, dependencies);
    const memory = readActiveMemoryRequest(paths, session)?.request;
    const vault = readActiveVaultRequest(paths)?.request;
    sendDueExtractionMessages(pi, paths, dependencies, entries, memory, vault);
  });
}

export default function memoryVault(pi: ExtensionAPI): void {
  registerMemoryVault(pi as unknown as MemoryVaultPi, defaultDependencies);
}
