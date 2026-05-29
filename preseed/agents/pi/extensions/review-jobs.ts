/**
 * Durable Codeflare PR-boundary review jobs.
 *
 * This module intentionally does NOT depend on third-party subagent extensions
 * (Agent/get_subagent_result/pi-subagents services). PR-boundary review is a
 * merge gate, so every meaningful state transition is written under .git/ and
 * can be recovered after reloads or context-mode changes.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { formatDurableReviewResult, laneExtensionSources, recoverDurableReviewLaneState } from "./review-job-helpers";
import type { ReviewSpawnRequest } from "./review-helpers";

export const REVIEW_JOBS_EVENT_LANE_COMPLETED = "codeflare-review-jobs:lane-completed";
export const REVIEW_JOBS_EVENT_LANE_FAILED = "codeflare-review-jobs:lane-failed";

export type DurableReviewLaneStatus = "pending" | "running" | "completed" | "failed";

export type DurableReviewLane = {
  lane: string;
  status: DurableReviewLaneStatus;
  startedAt?: number;
  completedAt?: number;
  resultPath?: string;
  transcriptPath?: string;
  error?: string;
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

type ReviewRunnerContext = {
  modelRegistry?: unknown;
};

const runningLanes = new Set<string>();
const DURABLE_LANE_TIMEOUT_MS = 10 * 60 * 1000;

function now(): number {
  return Date.now();
}

// Pi agent settings.json `packages` drives which extension packages a lane may load.
// Read best-effort; the lane resolves these against the same agentDir the loader uses.
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

export function reviewResultsDir(repo: string, head: string): string {
  return join(repo, ".git", "sdd-review-results", head);
}

export function reviewResultPath(repo: string, head: string, lane: string): string {
  return join(reviewResultsDir(repo, head), `${lane}.md`);
}

function laneKey(repo: string, head: string, lane: string): string {
  return `${repo}\u0000${head}\u0000${lane}`;
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
    activeInMemory: runningLanes.has(laneKey(repo, head, lane)),
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

export function runningDurableReviewLanes(repo: string, head: string, lanes: string[]): string[] {
  return lanes.filter((lane) => runningLanes.has(laneKey(repo, head, lane)));
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

function appendTranscript(path: string, event: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Transcript loss must not break the merge gate; result files are authoritative.
  }
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (item && typeof item === "object" && (item as { type?: unknown }).type === "text") {
      return String((item as { text?: unknown }).text ?? "");
    }
    return "";
  }).join("");
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

async function runDurableLane(pi: ExtensionAPI, ctx: ReviewRunnerContext, job: DurableReviewJobInput, request: ReviewSpawnRequest): Promise<void> {
  const key = laneKey(job.repo, job.head, request.lane);
  if (runningLanes.has(key)) return;
  runningLanes.add(key);
  // Mark that a durable review lane is loading in this process so codeflare-pi can skip
  // its per-session global-graph merge. Counter (not boolean) so concurrent lanes are safe.
  const laneDepth = globalThis as { __codeflareReviewLaneDepth?: number };
  laneDepth.__codeflareReviewLaneDepth = (laneDepth.__codeflareReviewLaneDepth ?? 0) + 1;

  const transcriptPath = reviewLaneTranscriptPath(job.repo, job.head, request.lane);
  const resultPath = reviewResultPath(job.repo, job.head, request.lane);
  recordDurableReviewLane(job, { lane: request.lane, status: "running", startedAt: now(), transcriptPath });

  let finalText = "";
  try {
    const systemPrompt = [
      readAgentPrompt(request.lane),
      "",
      "# Codeflare PR-boundary durable review job",
      "You are running inside Codeflare's durable PR-boundary review gate.",
      "Report findings only. Do not modify files. Do not spawn subagents. Do not run builds, tests, linters, or dev servers.",
      "If graphify tools are available, use only graphify_query, graphify_path, and graphify_explain for read-only lookups; do not build, update, or watch graphs.",
      "Use severity prefixes [CRITICAL], [HIGH], [MEDIUM], or [LOW] for findings. Use [CRITICAL] for merge-blocking findings.",
      "Your final answer is persisted as the review result for this lane. Codeflare adds the standard Review Summary table after your findings, so do not add your own summary table.",
    ].join("\n");

    // Keep noExtensions (so review-enforcement/subagents never load in-process), but additively
    // load codeflare-pi (build-blocker + guards) and the graphify/context-mode packages so the
    // reviewer has graphify_query and, when /ctx on, ctx_* tools.
    const codeflarePiPath = join(getAgentDir(), "extensions", "codeflare-pi.ts");
    const additionalExtensionPaths = [
      ...(existsSync(codeflarePiPath) ? [codeflarePiPath] : []),
      ...laneExtensionSources(readPiAgentPackages()),
    ];

    const resourceLoader = new DefaultResourceLoader({
      cwd: job.repo,
      agentDir: getAgentDir(),
      systemPrompt,
      noExtensions: true,
      additionalExtensionPaths,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      noSkills: false,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: job.repo,
      agentDir: getAgentDir(),
      modelRegistry: ctx.modelRegistry as never,
      sessionManager: SessionManager.inMemory(),
      resourceLoader,
    } as never);

    const unsubscribe = session.subscribe((event: any) => {
      appendTranscript(transcriptPath, event);
      if (event?.type === "message_end") {
        const message = event.message as { role?: string; content?: unknown } | undefined;
        if (message?.role === "assistant") {
          const text = extractTextContent(message.content);
          if (text.trim()) finalText = text;
        }
      }
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      session.agent.abort();
    }, DURABLE_LANE_TIMEOUT_MS);
    try {
      await session.prompt(request.prompt);
      if (timedOut) throw new Error(`durable review lane timed out after ${DURABLE_LANE_TIMEOUT_MS}ms`);
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      session.dispose();
    }

    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, formatDurableReviewResult(job, request.lane, finalText), "utf8");
    recordDurableReviewLane(job, { lane: request.lane, status: "completed", startedAt: readLane(job.repo, job.head, request.lane)?.startedAt, completedAt: now(), transcriptPath, resultPath });
    pi.events.emit(REVIEW_JOBS_EVENT_LANE_COMPLETED, { repo: job.repo, head: job.head, lane: request.lane, resultPath, result: finalText });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordDurableReviewLane(job, { lane: request.lane, status: "failed", startedAt: readLane(job.repo, job.head, request.lane)?.startedAt, completedAt: now(), transcriptPath, error: message });
    pi.events.emit(REVIEW_JOBS_EVENT_LANE_FAILED, { repo: job.repo, head: job.head, lane: request.lane, error: message });
  } finally {
    runningLanes.delete(key);
    laneDepth.__codeflareReviewLaneDepth = (laneDepth.__codeflareReviewLaneDepth ?? 1) - 1;
  }
}

export function startDurableReviewLanes(pi: ExtensionAPI, ctx: ReviewRunnerContext, jobInput: DurableReviewJobInput, requests: ReviewSpawnRequest[]): { job: DurableReviewJob; launched: string[] } {
  const job = ensureDurableReviewJob(jobInput);
  const launched: string[] = [];
  for (const request of requests) {
    const current = job.laneState[request.lane] ?? readLane(job.repo, job.head, request.lane);
    if (current?.status === "completed" || runningLanes.has(laneKey(job.repo, job.head, request.lane))) continue;
    launched.push(request.lane);
    void runDurableLane(pi, ctx, jobInput, request);
  }
  return { job: readDurableReviewJob(jobInput.repo, jobInput.head) ?? job, launched };
}

export default function () {
  // Helper module imported by review-enforcement.ts; no standalone registration.
}
