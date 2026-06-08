/**
 * Durable Codeflare PR-boundary review jobs.
 *
 * This module intentionally does NOT depend on third-party subagent extensions
 * (Agent/get_subagent_result/pi-subagents services). PR-boundary review is a
 * merge gate, so every meaningful state transition is written under .git/ and
 * can be recovered after reloads or context-mode changes.
 */

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { computeReviewStateFrom, formatDurableReviewResult, laneExtensionSources, reapLaneDecision, recoverDurableReviewLaneState, summarizeLaneTranscript, type ReviewState } from "./review-job-helpers";
import type { ReviewSpawnRequest } from "./review-helpers";

export type DurableReviewLaneStatus = "pending" | "running" | "completed" | "failed";

export type DurableReviewLane = {
  lane: string;
  status: DurableReviewLaneStatus;
  startedAt?: number;
  completedAt?: number;
  resultPath?: string;
  transcriptPath?: string;
  error?: string;
  // Detached child `pi` process-group id (== child.pid, since lanes are spawned
  // detached). Used by the reaper for liveness (process.kill(pid, 0)) and to kill
  // the group on timeout. Absent until the lane is spawned.
  pid?: number;
  // The child's /proc/<pid>/stat start-time, captured at spawn. Liveness re-checks it
  // so a reused pid (Linux recycles pids) reads as dead rather than a live impostor —
  // prevents both a wedged "running" lane and SIGKILL to an unrelated process group.
  pidStart?: string;
};

export type DurableReviewJob = {
  repo: string;
  prNumber?: number;
  baseRefName: string;
  head: string;
  reviewBase?: string;
  lanes: string[];
  status: "running" | "completed" | "failed";
  startedAt: number;
  updatedAt: number;
  laneState: Record<string, DurableReviewLane>;
};

export type DurableReviewJobInput = {
  repo: string;
  prNumber?: number;
  baseRefName: string;
  head: string;
  reviewBase?: string;
  lanes: string[];
};

// Kept for call-site signature stability; lanes use pi's default model, not this.
type ReviewRunnerContext = {
  modelRegistry?: unknown;
};

// Each lane is a detached, headless `pi` child running with no extensions (so it
// cannot recursively load review-enforcement, starts fast, and exits cleanly) and
// a bounded inspection tool set. The reaper enforces this wall-clock budget from disk,
// so it survives the spawning process exiting — unlike an in-process setTimeout.
const DURABLE_LANE_TIMEOUT_MS = 15 * 60 * 1000;
// Bounded review inspection tool set. Built-ins plus bash for git/gh diff inspection,
// graphify (always loaded into the lane), and context-mode's read-only ctx_search
// (available when the context-mode package is enabled in settings); listing a tool
// whose extension did not load is harmless.
const LANE_TOOLS = "read,grep,find,bash,graphify_query,graphify_explain,graphify_path,ctx_search";

function now(): number {
  return Date.now();
}

// Pi agent settings.json `packages` drives which extension packages a lane may load
// (context-mode when enabled). Read best-effort against the same agentDir pi uses.
function readPiAgentPackages(): Array<string | { source?: string; extensions?: unknown }> {
  try {
    const settings = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as {
      packages?: Array<string | { source?: string; extensions?: unknown }>;
    };
    return settings.packages ?? [];
  } catch {
    return [];
  }
}

function safeWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function reviewJobDir(repo: string, head: string): string {
  return join(repo, ".git", "codeflare-review-jobs", head);
}

export function reviewJobPath(repo: string, head: string): string {
  return join(reviewJobDir(repo, head), "job.json");
}

export function reviewLanePath(repo: string, head: string, lane: string): string {
  return join(reviewJobDir(repo, head), "lanes", `${lane}.json`);
}

export function reviewLaneTranscriptPath(repo: string, head: string, lane: string): string {
  return join(reviewJobDir(repo, head), "transcripts", `${lane}.jsonl`);
}

export function reviewLaneErrPath(repo: string, head: string, lane: string): string {
  return join(reviewJobDir(repo, head), "transcripts", `${lane}.err`);
}

function reviewLanePromptPath(repo: string, head: string, lane: string): string {
  return join(reviewJobDir(repo, head), `${lane}.prompt.md`);
}

export function reviewResultsDir(repo: string, head: string): string {
  return join(repo, ".git", "sdd-review-results", head);
}

export function reviewResultPath(repo: string, head: string, lane: string): string {
  return join(reviewResultsDir(repo, head), `${lane}.md`);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function readDurableReviewJob(repo: string, head: string): DurableReviewJob | undefined {
  return readJson<DurableReviewJob>(reviewJobPath(repo, head));
}

function writeDurableReviewJob(job: DurableReviewJob): void {
  safeWriteJson(reviewJobPath(job.repo, job.head), job);
}

function writeLane(repo: string, head: string, lane: DurableReviewLane): void {
  safeWriteJson(reviewLanePath(repo, head, lane.lane), lane);
}

function readLane(repo: string, head: string, lane: string): DurableReviewLane | undefined {
  return readJson<DurableReviewLane>(reviewLanePath(repo, head, lane));
}

function normalizeLaneState(repo: string, head: string, lane: string, current?: DurableReviewLane): DurableReviewLane {
  const resultPath = reviewResultPath(repo, head, lane);
  return recoverDurableReviewLaneState({
    lane,
    current,
    resultExists: existsSync(resultPath),
    resultPath,
  });
}

function deriveStatus(laneState: Record<string, DurableReviewLane>, lanes: string[]): DurableReviewJob["status"] {
  if (lanes.some((lane) => laneState[lane]?.status === "failed")) return "failed";
  if (lanes.every((lane) => laneState[lane]?.status === "completed")) return "completed";
  return "running";
}

export function ensureDurableReviewJob(input: DurableReviewJobInput): DurableReviewJob {
  const existing = readDurableReviewJob(input.repo, input.head);
  const startedAt = existing?.startedAt ?? now();
  const laneState = Object.fromEntries(input.lanes.map((lane) => {
    const current = existing?.laneState?.[lane] ?? readLane(input.repo, input.head, lane);
    return [lane, normalizeLaneState(input.repo, input.head, lane, current)];
  }));
  const job: DurableReviewJob = {
    repo: input.repo,
    prNumber: input.prNumber,
    baseRefName: input.baseRefName,
    head: input.head,
    reviewBase: input.reviewBase,
    lanes: input.lanes,
    status: deriveStatus(laneState, input.lanes),
    startedAt,
    updatedAt: now(),
    laneState,
  };
  writeDurableReviewJob(job);
  return job;
}

export function completedDurableReviewLanes(repo: string, head: string, lanes: string[]): string[] {
  return lanes.filter((lane) => existsSync(reviewResultPath(repo, head, lane)));
}

export function failedDurableReviewLanes(repo: string, head: string, lanes: string[]): string[] {
  const job = readDurableReviewJob(repo, head);
  return lanes.filter((lane) => job?.laneState?.[lane]?.status === "failed");
}

// A lane is "running" iff its on-disk record says so. The reaper transitions
// running → completed/failed before any consumer reads this (the poller reaps
// first), so disk status is the cross-process source of truth — no per-process
// in-memory Set, which only ever knew about lanes THIS process spawned.
export function runningDurableReviewLanes(repo: string, head: string, lanes: string[]): string[] {
  const job = readDurableReviewJob(repo, head);
  return lanes.filter((lane) => job?.laneState?.[lane]?.status === "running");
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function readAgentPrompt(lane: string): string {
  const candidates = [
    join(getAgentDir(), "agents", `${lane}.md`),
    join("/home/user/.pi/agent/agents", `${lane}.md`),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return stripFrontmatter(readFileSync(path, "utf8"));
  }
  return `You are ${lane}. Review the assigned PR-boundary diff. Report findings only; do not modify files.`;
}

// Resolve how to invoke a child `pi`, mirroring the canonical subagent example:
// from inside pi, process.argv[1] is pi's cli.js, so re-run it under the same
// runtime; fall back to a bare `pi` on PATH when the entry script is virtual/bun.
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = typeof currentScript === "string" && currentScript.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = (process.execPath.split("/").pop() ?? "").toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

// The child's start-time from /proc/<pid>/stat field 22 (clock ticks since boot) — a
// stable per-process token that distinguishes a recycled pid. comm (field 2) is
// parenthesized and may contain spaces/parens, so parse from the last ')': the tail
// starts at field 3 (state), making starttime index 19. Linux-only; undefined elsewhere.
function readProcessStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const tail = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return tail[19];
  } catch {
    return undefined;
  }
}

// Lanes are spawned detached, so child.pid is the process-GROUP id. Liveness is
// identity-checked: a pid that is signalable but whose /proc start-time no longer
// matches the recorded one is a RECYCLED pid (a different process) and reads as dead,
// so the reaper never trusts it for "still running" nor kills its (unrelated) group.
function isProcessAlive(pid: number, expectedStart?: string): boolean {
  if (!pid || pid <= 1) return false;
  let signalable = false;
  try {
    process.kill(pid, 0);
    signalable = true;
  } catch (error) {
    // EPERM: the process exists but is not ours to signal — treat as alive.
    signalable = (error as { code?: string })?.code === "EPERM";
  }
  if (!signalable) return false;
  if (expectedStart) {
    const current = readProcessStartTime(pid);
    if (current && current !== expectedStart) return false; // pid recycled → impostor
  }
  return true;
}

function killLaneProcessGroup(pid: number): void {
  if (!pid || pid <= 1) return;
  // Negative pid targets the whole group (detached child is the group leader),
  // so any tool subprocess the reviewer spawned dies with it. Best-effort.
  try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
}

function readTranscriptLines(path?: string): string[] {
  if (!path) return [];
  try { return readFileSync(path, "utf8").split("\n"); } catch { return []; }
}

export function recordDurableReviewLane(jobInput: DurableReviewJobInput, lane: DurableReviewLane): DurableReviewJob {
  writeLane(jobInput.repo, jobInput.head, lane);
  const current = ensureDurableReviewJob(jobInput);
  const laneState = { ...current.laneState, [lane.lane]: lane };
  const next: DurableReviewJob = {
    ...current,
    laneState,
    status: deriveStatus(laneState, current.lanes),
    updatedAt: now(),
  };
  writeDurableReviewJob(next);
  return next;
}

// Spawn one review lane as a DETACHED, headless child `pi` process. The child
// outlives the spawning session (so a review survives the user quitting pi), writes
// its `--mode json` event stream to the lane transcript file, and is reaped from disk
// by reapDurableReviewLanes. This is Pi's canonical subagent pattern (examples/
// extensions/subagent: "each subagent runs in a separate pi process"). Two hard-won
// env requirements proven against pi 0.78.1: stdin MUST be /dev/null (an inherited
// stdin hangs print mode at startup), and --no-extensions is required so the child
// (a) cannot recursively load review-enforcement, (b) starts fast, (c) exits cleanly.
function spawnDurableLane(jobInput: DurableReviewJobInput, request: ReviewSpawnRequest): void {
  const { repo, head } = jobInput;
  const lane = request.lane;
  const transcriptPath = reviewLaneTranscriptPath(repo, head, lane);
  const errPath = reviewLaneErrPath(repo, head, lane);
  const promptPath = reviewLanePromptPath(repo, head, lane);

  const systemPrompt = [
    readAgentPrompt(lane),
    "",
    "# Codeflare PR-boundary durable review job",
    "You are running inside Codeflare's durable PR-boundary review gate as an isolated, headless review process.",
    "Report findings only. Do not modify files. Do not run builds, tests, linters, or dev servers.",
    "If graphify tools are available, use only graphify_query, graphify_path, and graphify_explain for read-only lookups; do not build, update, or watch graphs. If ctx_search is available, use it for read-only context lookups.",
    "Use severity prefixes [CRITICAL], [HIGH], [MEDIUM], or [LOW] for findings. Use [CRITICAL] for merge-blocking findings.",
    "Your final assistant message is persisted verbatim as this lane's review result; Codeflare adds the Review Summary table after it, so do not add your own summary table.",
  ].join("\n");

  // Fresh transcript/err on every (re)spawn so a stale partial from a prior, dead
  // attempt is never mis-read by the reaper. openSync("w") truncates.
  mkdirSync(dirname(transcriptPath), { recursive: true });
  writeFileSync(promptPath, systemPrompt, "utf8");

  // --no-extensions disables discovery (so review-enforcement never loads recursively),
  // but explicit `-e` paths still load: the first-party graphify-native extension, a
  // minimal lane guard extension, and settings-enabled lane packages (context-mode's
  // ctx_* when enabled). This gives reviewers graphify + ctx + build/test blockers
  // without the full extension stack.
  const graphifyNativePath = join(getAgentDir(), "extensions", "graphify-native.ts");
  const laneGuardsPath = join(getAgentDir(), "extensions", "review-lane-guards.ts");
  const extensionArgs: string[] = [];
  if (existsSync(graphifyNativePath)) extensionArgs.push("-e", graphifyNativePath);
  if (existsSync(laneGuardsPath)) extensionArgs.push("-e", laneGuardsPath);
  for (const source of laneExtensionSources(readPiAgentPackages())) extensionArgs.push("-e", source);

  const args = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-context-files",
    ...extensionArgs,
    "--tools", LANE_TOOLS,
    "--append-system-prompt", promptPath,
    `Task: ${request.prompt}`,
  ];
  const invocation = getPiInvocation(args);

  const out = openSync(transcriptPath, "w");
  const err = openSync(errPath, "w");
  let pid: number | undefined;
  try {
    const child = spawn(invocation.command, invocation.args, {
      cwd: repo,
      detached: true,
      stdio: ["ignore", out, err],
      env: { ...process.env, BROWSER: "" },
    });
    // An async spawn failure (e.g. ENOENT) would otherwise be an unhandled error
    // event; record it so the reaper/state machine sees a failed lane, not a hang.
    child.on("error", (error) => {
      recordDurableReviewLane(jobInput, { lane, status: "failed", completedAt: now(), transcriptPath, error: `spawn failed: ${error instanceof Error ? error.message : String(error)}` });
      appendReviewEvent(repo, { event: "lane_failed", head, lane, error: `spawn failed: ${error instanceof Error ? error.message : String(error)}` });
    });
    child.unref();
    pid = child.pid;
  } finally {
    closeSync(out);
    closeSync(err);
  }

  // No pid means spawn failed synchronously — fail loudly now (the caller's catch records
  // it) instead of recording a "running" lane with no process for the reaper to find.
  if (!pid) throw new Error("spawn produced no pid");
  const pidStart = readProcessStartTime(pid);
  recordDurableReviewLane(jobInput, { lane, status: "running", startedAt: now(), transcriptPath, pid, pidStart });
}

// The single, process-independent authority for the running → completed/failed
// transition. Called by the poller on every lifecycle tick (any session can reap a
// lane another session spawned). reapLaneDecision holds the pure logic; this wrapper
// injects the disk + process facts and applies the side effects (result file, lane
// record, audit event, killing the finished/over-budget child's group).
export function reapDurableReviewLanes(repo: string, head: string): void {
  const job = readDurableReviewJob(repo, head);
  if (!job) return;
  for (const lane of job.lanes) {
    const rec = job.laneState[lane];
    if (!rec || rec.status !== "running") continue;
    const hasPid = typeof rec.pid === "number";
    const decision = reapLaneDecision({
      status: rec.status,
      resultExists: existsSync(reviewResultPath(repo, head, lane)),
      transcript: summarizeLaneTranscript(readTranscriptLines(rec.transcriptPath)),
      hasPid,
      pidAlive: hasPid ? isProcessAlive(rec.pid as number, rec.pidStart) : false,
      startedAt: rec.startedAt,
      now: now(),
      timeoutMs: DURABLE_LANE_TIMEOUT_MS,
    });
    if (decision.action === "complete") {
      const resultPath = reviewResultPath(repo, head, lane);
      mkdirSync(dirname(resultPath), { recursive: true });
      writeFileSync(resultPath, formatDurableReviewResult(job, lane, decision.finalText), "utf8");
      recordDurableReviewLane(job, { lane, status: "completed", startedAt: rec.startedAt, completedAt: now(), transcriptPath: rec.transcriptPath, resultPath });
      appendReviewEvent(repo, { event: "lane_completed", head, lane, resultPath });
      // Defensive: a completed lane's child is normally already gone; only signal if it
      // is still alive AND identity-matches, so we never SIGKILL a recycled pid's group.
      if (hasPid && isProcessAlive(rec.pid as number, rec.pidStart)) killLaneProcessGroup(rec.pid as number);
    } else if (decision.action === "fail") {
      recordDurableReviewLane(job, { lane, status: "failed", startedAt: rec.startedAt, completedAt: now(), transcriptPath: rec.transcriptPath, error: decision.reason });
      appendReviewEvent(repo, { event: "lane_failed", head, lane, error: decision.reason });
      if (decision.kill && hasPid && isProcessAlive(rec.pid as number, rec.pidStart)) killLaneProcessGroup(rec.pid as number);
    }
  }
}

export function startDurableReviewLanes(_runner: ReviewRunnerContext, jobInput: DurableReviewJobInput, requests: ReviewSpawnRequest[]): { job: DurableReviewJob; launched: string[] } {
  const job = ensureDurableReviewJob(jobInput);
  const launched: string[] = [];
  for (const request of requests) {
    const current = job.laneState[request.lane] ?? readLane(job.repo, job.head, request.lane);
    if (current?.status === "completed") continue;
    // A lane with a still-alive child is already running — don't double-spawn. A
    // "running" record whose child is dead (no result) is a stale orphan; respawn it.
    if (current?.status === "running" && typeof current.pid === "number" && isProcessAlive(current.pid, current.pidStart)) continue;
    launched.push(request.lane);
    appendReviewEvent(jobInput.repo, { event: "lane_spawned", head: jobInput.head, lane: request.lane });
    try {
      spawnDurableLane(jobInput, request);
    } catch (error) {
      const message = `spawn failed: ${error instanceof Error ? error.message : String(error)}`;
      recordDurableReviewLane(jobInput, { lane: request.lane, status: "failed", completedAt: now(), error: message });
      appendReviewEvent(jobInput.repo, { event: "lane_failed", head: jobInput.head, lane: request.lane, error: message });
    }
  }
  return { job: readDurableReviewJob(jobInput.repo, jobInput.head) ?? job, launched };
}

function readTrimmedFile(path: string): string {
  try { return readFileSync(path, "utf8").trim(); } catch { return ""; }
}

function readIntFile(path: string): number {
  const value = Number.parseInt(readTrimmedFile(path), 10);
  return Number.isFinite(value) ? value : 0;
}

// Append-only trigger/decision audit. Every meaningful enforcement decision lands here so
// a stuck or surprising review is one `cat .git/codeflare-review-events.jsonl` away
// (review.md §17.4). Best-effort: the audit log must never break the merge gate.
export function appendReviewEvent(repo: string, row: Record<string, unknown>): void {
  try {
    const path = join(repo, ".git", "codeflare-review-events.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ ts: now(), ...row })}\n`, "utf8");
  } catch { /* best effort */ }
}

// Canonical, fs-backed review state for a head — the one read every status surface uses
// (review.md §17.2). Pure decision logic lives in computeReviewStateFrom; this wrapper
// only injects the disk facts. "running" now comes purely from the on-disk lane record
// (the reaper keeps it accurate cross-process), so runningInMemory is always false.
export function computeReviewState(repo: string, head: string): ReviewState {
  const job = readDurableReviewJob(repo, head);
  const lanes = job?.lanes ?? [];
  const gitDir = join(repo, ".git");
  return computeReviewStateFrom({
    repo,
    head,
    prNumber: job?.prNumber,
    baseRefName: job?.baseRefName,
    reviewBase: job?.reviewBase,
    lanes,
    laneJobStatus: (lane) => job?.laneState?.[lane]?.status,
    resultLaneExists: (lane) => existsSync(reviewResultPath(repo, head, lane)),
    runningInMemory: () => false,
    ackHead: readTrimmedFile(join(gitDir, "sdd-last-ack-pr-head")),
    breakerHead: readTrimmedFile(join(gitDir, "sdd-review-breaker")),
    attempts: readIntFile(join(gitDir, "sdd-review-block-count")),
    autofixRequested: existsSync(join(reviewJobDir(repo, head), "autofix.requested")),
    startedAt: job?.startedAt,
  });
}

export default function () {
  // Helper module imported by review-enforcement.ts; no standalone registration.
}
