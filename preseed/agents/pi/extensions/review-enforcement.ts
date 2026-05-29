/**
 * Codeflare Pi PR-boundary review enforcement.
 *
 * Native Pi counterpart to Claude Code's PR-boundary review hooks.
 * It watches pushes/PR creation/PR merges for SDD projects with an open PR to
 * main/master, computes the minimal required review lanes, spawns Pi subagents
 * for only those lanes, persists progress under .git/, and acknowledges the PR
 * head only after the required lanes complete.
 */

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { ALL_REVIEW_LANES, classifyReviewFiles, classifyReviewHead, createReadyOnceTracker, extractBackgroundAgentId, isFailedToolExecution, isPrBoundaryCommand, reusablePendingReview, selectReviewBase, type ReviewHeadStatus, type ReviewSpawnRequest } from "./review-helpers";
import { compactDurableReviewStatus, countReviewSeverities, durableReviewAckReady, durableReviewEligibleLanes, durableReviewInitialLanes, durableReviewMessageKey, durableReviewRecommendation, formatMergedReviewSummary, requestReviewAutofixForRows, type DurableReviewSummaryRecord, type DurableReviewSummaryRow, type ReviewSeverityCounts } from "./review-job-helpers";
import { completedDurableReviewLanes, failedDurableReviewLanes, readDurableReviewJob, REVIEW_JOBS_EVENT_LANE_COMPLETED, REVIEW_JOBS_EVENT_LANE_FAILED, reviewJobDir, reviewResultPath, reviewResultsDir, runningDurableReviewLanes, startDurableReviewLanes } from "./review-jobs";

const REVIEW_BYPASS = "/tmp/review-bypass";

// Circuit-breaker bounds. A pending review for a given HEAD that cannot make
// progress (e.g. the subagent service ctx went stale after a compaction) must
// stop re-spawning and re-reminding instead of spiralling unbounded. Latch once
// we exceed either bound; the counter is reset on real progress.
const MAX_REVIEW_ATTEMPTS = 5;
const MAX_REVIEW_AGE_MS = 20 * 60 * 1000;
const REVIEW_REQUEST_RETRY_MS = 60 * 1000;

type PrState = {
  state?: string;
  baseRefName?: string;
  headRefOid?: string;
  number?: number;
  isDraft?: boolean;
};

type PendingReview = {
  repo: string;
  prNumber?: number;
  baseRefName: string;
  head: string;
  reviewBase?: string;
  lanes: string[];
  completed: Set<string>;
  docPromptSent: boolean;
  spawned: boolean;
  spawnedIds: Record<string, string>;
  fallbackLanes: Set<string>;
  requestedAt: Record<string, number>;
  reviewStartedAt: number;
  spawnedAt?: number;
};

function shell(command: string, cwd: string): string {
  return execFileSync("bash", ["-lc", command], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
}

function findGitRoot(startDir: string): string | undefined {
  let current = startDir;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function cwdFromCommand(command: string): string | undefined {
  const cdMatch = command.match(/(?:^|[;&|]\s*)cd\s+([^;&|]+)\s*&&/);
  if (cdMatch) return cdMatch[1].trim().replace(/^(["'])(.*)\1$/, "$2");
  const gitCMatch = command.match(/(?:^|[;&|]\s*)git\s+-C\s+("[^"]+"|'[^']+'|\S+)/);
  if (gitCMatch) return gitCMatch[1].trim().replace(/^(["'])(.*)\1$/, "$2");
  return undefined;
}

function activeRepoFallback(): string | undefined {
  try {
    const p = "/home/user/.cache/codeflare-hooks/graphify-active-cwd";
    if (existsSync(p)) return readFileSync(p, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
  return undefined;
}

function commandText(event: any): string {
  const input = event?.input || event?.params || event?.args || {};
  if (typeof input.command === "string") return input.command;
  if (typeof input.code === "string") return input.code;
  if (Array.isArray(input.commands)) return input.commands.map((cmd: any) => String(cmd?.command || "")).join("\n");
  return "";
}


function isGhPrMerge(command: string): boolean {
  return /(^|[;&|]\s*)gh\s+pr\s+merge\b/.test(command);
}

function isSddProject(repo: string): boolean {
  return existsSync(join(repo, "sdd", "README.md"));
}

function prState(repo: string): PrState | undefined {
  try {
    const out = shell("gh pr view --json number,state,baseRefName,headRefOid,isDraft 2>/dev/null", repo);
    return out ? JSON.parse(out) as PrState : undefined;
  } catch {
    return undefined;
  }
}

function localHead(repo: string): string | undefined {
  try {
    return shell("git rev-parse HEAD", repo);
  } catch {
    return undefined;
  }
}

function isEnforcedPr(pr: PrState | undefined): pr is Required<Pick<PrState, "headRefOid" | "baseRefName" | "state">> & PrState {
  return Boolean(pr?.headRefOid && pr.state === "OPEN" && (pr.baseRefName === "main" || pr.baseRefName === "master"));
}

function ackPath(repo: string): string {
  return join(repo, ".git", "sdd-last-ack-pr-head");
}

function pendingPath(repo: string): string {
  return join(repo, ".git", "sdd-review-pending.json");
}

function blockCountPath(repo: string): string {
  return join(repo, ".git", "sdd-review-block-count");
}

function lastAckHead(repo: string): string {
  try { return readFileSync(ackPath(repo), "utf8").trim(); } catch { return ""; }
}

function acked(repo: string, head: string): boolean {
  return lastAckHead(repo) === head;
}

function writeAck(repo: string, head: string): void {
  writeFileSync(ackPath(repo), `${head}\n`, "utf8");
}

function clearPending(repo: string): void {
  try { unlinkSync(pendingPath(repo)); } catch { /* best effort */ }
}

function resetBlockCount(repo: string): void {
  try { unlinkSync(blockCountPath(repo)); } catch { /* best effort */ }
}

function incrementBlockCount(repo: string): number {
  const path = blockCountPath(repo);
  let count = 0;
  try { count = Number.parseInt(readFileSync(path, "utf8").trim(), 10) || 0; } catch { count = 0; }
  count += 1;
  writeFileSync(path, String(count), "utf8");
  return count;
}

function breakerPath(repo: string): string {
  return join(repo, ".git", "sdd-review-breaker");
}

// The breaker latch is keyed by HEAD: once open for a head, all enforcement for
// that exact head becomes a no-op until a new head is pushed or the user acks/bypasses.
function isBreakerOpen(repo: string, head: string): boolean {
  try { return readFileSync(breakerPath(repo), "utf8").trim() === head; } catch { return false; }
}

function openBreaker(repo: string, head: string): void {
  writeFileSync(breakerPath(repo), `${head}\n`, "utf8");
}

function clearBreaker(repo: string): void {
  try { unlinkSync(breakerPath(repo)); } catch { /* best effort */ }
}

function consumeBypass(): boolean {
  if (!existsSync(REVIEW_BYPASS)) return false;
  try {
    unlinkSync(REVIEW_BYPASS);
    return true;
  } catch {
    return false; // cannot consume the sentinel; do not grant a bypass that would persist and leave the merge gate permanently open
  }
}

function stringifyReviewResult(result: unknown): string {
  if (typeof result === "string") return result.trim();
  if (result == null) return "";
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

function toolResultPayload(event: any): unknown {
  return event?.result ?? event?.output ?? event?.content ?? event?.message ?? event?.data;
}

function persistReviewResult(state: PendingReview, lane: string, result: unknown): string {
  const dir = reviewResultsDir(state.repo, state.head);
  mkdirSync(dir, { recursive: true });
  const text = stringifyReviewResult(result) || "No findings reported.";
  const path = reviewResultPath(state.repo, state.head, lane);
  writeFileSync(path, [`# PR-boundary ${lane}`, "", `Repo: ${basename(state.repo)}`, `Head: ${state.head}`, `PR: ${state.prNumber || "?"}`, "", text, ""].join("\n"), "utf8");
  return path;
}

// Keep only the current head's results under .git/sdd-review-results/ so old PR HEADs do
// not accumulate across a long-lived branch. Best-effort; never throws.
function pruneReviewResults(repo: string, keepHead: string): void {
  try {
    const base = join(repo, ".git", "sdd-review-results");
    for (const entry of readdirSync(base)) {
      if (entry !== keepHead) rmSync(join(base, entry), { recursive: true, force: true });
    }
  } catch { /* best effort: dir may not exist yet */ }
}

function loadPending(repo: string): PendingReview | undefined {
  try {
    const state = JSON.parse(readFileSync(pendingPath(repo), "utf8")) as { prNumber?: number; baseRefName?: string; head?: string; reviewBase?: string; lanes?: string[]; completed?: string[]; docPromptSent?: boolean; spawned?: boolean; spawnedIds?: Record<string, string>; fallbackLanes?: string[]; requestedAt?: Record<string, number>; reviewStartedAt?: number; spawnedAt?: number };
    if (!state.head || !state.baseRefName || !Array.isArray(state.lanes)) return undefined;
    const completed = new Set([
      ...(state.completed || []),
      ...completedDurableReviewLanes(repo, state.head, state.lanes),
    ]);
    return { repo, prNumber: state.prNumber, baseRefName: state.baseRefName, head: state.head, reviewBase: state.reviewBase, lanes: state.lanes, completed, docPromptSent: Boolean(state.docPromptSent), spawned: Boolean(state.spawned), spawnedIds: state.spawnedIds || {}, fallbackLanes: new Set(state.fallbackLanes || []), requestedAt: state.requestedAt || {}, reviewStartedAt: state.reviewStartedAt || state.spawnedAt || Date.now(), spawnedAt: state.spawnedAt };
  } catch {
    return undefined;
  }
}

function savePending(pending: PendingReview): void {
  writeFileSync(pendingPath(pending.repo), JSON.stringify({ prNumber: pending.prNumber, baseRefName: pending.baseRefName, head: pending.head, reviewBase: pending.reviewBase, lanes: pending.lanes, completed: [...pending.completed], docPromptSent: pending.docPromptSent, spawned: pending.spawned, spawnedIds: pending.spawnedIds, fallbackLanes: [...pending.fallbackLanes], requestedAt: pending.requestedAt, reviewStartedAt: pending.reviewStartedAt, spawnedAt: pending.spawnedAt }) + "\n", "utf8");
}

function isAncestor(repo: string, ancestor: string, current: string): boolean {
  if (!ancestor || !/^[0-9a-f]{7,40}$/.test(ancestor)) return false;
  try {
    return execFileSync("git", ["merge-base", ancestor, current], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() === ancestor;
  } catch {
    return false;
  }
}

function changedFiles(repo: string, from: string, to: string): string[] | undefined {
  if (!from || from === to) return from === to ? [] : undefined;
  if (!isAncestor(repo, from, to)) return undefined;
  try {
    const out = execFileSync("git", ["diff", "-z", "--name-only", "--no-renames", from, to], { cwd: repo, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });
    return out.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return undefined;
  }
}

function currentBranch(repo: string): string | undefined {
  try {
    return execFileSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function previousRemoteHead(repo: string, currentHead: string): string | undefined {
  const branch = currentBranch(repo);
  if (!branch) return undefined;
  try {
    const out = execFileSync("git", ["reflog", "show", "--format=%H", `refs/remotes/origin/${branch}`, "-n", "4"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return out.split("\n").map((line) => line.trim()).find((head) => head && head !== currentHead && isAncestor(repo, head, currentHead));
  } catch {
    return undefined;
  }
}

function isLocalGitPushCommand(command: string): boolean {
  return /(^|[;&|]\s*)git(?:\s+-C\s+\S+)?\s+push\b/.test(command);
}

function isGitPushCommand(command: string): boolean {
  return isLocalGitPushCommand(command) || /(^|[;&|]\s*)gh\s+repo\s+sync\b/.test(command);
}

function reviewCandidateHead(repo: string, pr: PrState, command?: string): string {
  if (command && isLocalGitPushCommand(command)) return localHead(repo) || pr.headRefOid || "";
  return pr.headRefOid || "";
}

function mergeLaneState(repo: string, currentHead: string, previous?: PendingReview): { lanes: string[]; completed: Set<string> } {
  const base = previous?.head || lastAckHead(repo);
  const changed = classifyReviewFiles(changedFiles(repo, base, currentHead));
  const changedLanes = changed || ALL_REVIEW_LANES;
  if (!previous) return { lanes: changedLanes, completed: new Set() };

  const incompletePrevious = previous.lanes.filter((lane) => !previous.completed.has(lane));
  const lanes = [...new Set([...incompletePrevious, ...changedLanes])];
  const completed = new Set(
    previous.lanes.filter((lane) => previous.completed.has(lane) && lanes.includes(lane) && !changedLanes.includes(lane)),
  );
  return { lanes, completed };
}

function isRealSessionCtx(ctx: unknown): boolean {
  return Boolean(ctx && typeof ctx === "object" && (ctx as { modelRegistry?: unknown }).modelRegistry);
}

function reviewPrompt(repo: string, pr: PrState, head: string, reviewBase?: string): string {
  if (reviewBase) {
    return `Work in ${repo}. Review PR #${pr.number || "?"} for ${basename(repo)}. Scope is ONLY the incremental diff from ${reviewBase} to ${head}. First run: git diff --name-only ${reviewBase} ${head}. Review only those changed files, then run: git diff ${reviewBase} ${head} -- <path> for each changed file. Do NOT review the full PR diff against ${pr.baseRefName}. Do NOT scan unrelated repo files except minimal direct context for a finding. Report findings only; do not modify files.`;
  }
  return `Work in ${repo}. Review PR #${pr.number || "?"} for ${basename(repo)} at head ${head}. Scope is the full PR diff because no prior review base is known. First run: git diff --name-only origin/${pr.baseRefName}...${head}. Review only those changed files, then run: git diff origin/${pr.baseRefName}...${head} -- <path> for each changed file. Do NOT scan unrelated repo files except minimal direct context for a finding. Report findings only; do not modify files.`;
}

function docUpdaterPrompt(pending: PendingReview): string {
  if (pending.reviewBase) {
    return `Work in ${pending.repo}. Review PR #${pending.prNumber || "?"} for ${basename(pending.repo)}. Scope is ONLY the incremental diff from ${pending.reviewBase} to ${pending.head}. Run: git diff ${pending.reviewBase} ${pending.head} -- documentation/ sdd/. Do NOT review the full PR diff against ${pending.baseRefName}. Report findings only; do not modify files.`;
  }
  return `Work in ${pending.repo}. Review PR #${pending.prNumber || "?"} for ${basename(pending.repo)} at head ${pending.head}. Scope is the full PR diff (no prior review base). Run: git diff origin/${pending.baseRefName}...${pending.head}. Report findings only; do not modify files.`;
}

function shouldRequestLane(pending: PendingReview, lane: string, now = Date.now()): boolean {
  if (pending.completed.has(lane)) return false;
  if (completedDurableReviewLanes(pending.repo, pending.head, [lane]).includes(lane)) return false;
  if (runningDurableReviewLanes(pending.repo, pending.head, [lane]).includes(lane)) return false;
  const lastRequested = pending.requestedAt[lane] || 0;
  return lastRequested === 0 || now - lastRequested >= REVIEW_REQUEST_RETRY_MS;
}

function promptForLane(pending: PendingReview, pr: PrState, lane: string): string {
  return lane === "doc-updater" ? docUpdaterPrompt(pending) : reviewPrompt(pending.repo, pr, pending.head, pending.reviewBase);
}

function descriptionForLane(lane: string): string {
  return lane === "doc-updater" ? "Review documentation changes" : lane === "spec-reviewer" ? "Review spec changes" : "Review code changes";
}

function updateReviewStatus(state: PendingReview, ctx: any): void {
  try {
    const completed = state.lanes.filter((lane) => state.completed.has(lane) || existsSync(reviewResultPath(state.repo, state.head, lane)));
    const running = runningDurableReviewLanes(state.repo, state.head, state.lanes).concat(Object.keys(state.spawnedIds));
    ctx.ui.setStatus("codeflare-review", compactDurableReviewStatus({
      head: state.head,
      lanes: state.lanes,
      completed,
      running,
      style: {
        done: (label: string) => ctx.ui.theme.fg("success", label),
        running: (label: string) => ctx.ui.theme.fg("warning", label),
      },
    }));
  } catch {
    // Status display is best-effort; persisted review state is authoritative.
  }
}

function clearReviewStatus(ctx: any): void {
  try { ctx.ui.setStatus("codeflare-review", undefined); } catch { /* best effort */ }
}

async function spawnReviewLanes(pending: PendingReview, pr: PrState, lanes: string[], ctx: any, reason: string): Promise<void> {
  if (lanes.length === 0) return;

  const now = Date.now();
  const requests: ReviewSpawnRequest[] = lanes
    .filter((lane) => shouldRequestLane(pending, lane, now))
    .map((lane) => ({ lane, prompt: promptForLane(pending, pr, lane), description: descriptionForLane(lane) }));
  if (requests.length === 0) return;

  const result = startDurableReviewLanes(
    ctx.pi ?? (globalThis as { __codeflarePi?: ExtensionAPI }).__codeflarePi,
    ctx,
    {
      repo: pending.repo,
      prNumber: pending.prNumber,
      baseRefName: pending.baseRefName,
      head: pending.head,
      reviewBase: pending.reviewBase,
      lanes: pending.lanes,
    },
    requests,
  );
  for (const request of requests) pending.requestedAt[request.lane] = now;
  for (const lane of result.launched) delete pending.requestedAt[lane];
  pending.spawned = true;
  pending.spawnedIds = { ...pending.spawnedIds, ...Object.fromEntries(result.launched.map((lane) => [lane, `durable:${lane}`])) };
  pending.spawnedAt = pending.spawnedAt || now;
  savePending(pending);
  updateReviewStatus(pending, ctx);
}

function reviewHeadStatus(pending: PendingReview): ReviewHeadStatus {
  const current = prState(pending.repo);
  return classifyReviewHead({
    pendingHead: pending.head,
    localHead: localHead(pending.repo),
    prOpenAtBase: isEnforcedPr(current),
    prHead: current?.headRefOid,
    prQueryFailed: current === undefined,
  });
}

function installReviewMessageDedupe(pi: ExtensionAPI): void {
  const patchVersion = 3;
  const globalState = globalThis as {
    __codeflareReviewMessageKeys?: Set<string>;
    __codeflareReviewSendMessagePatchVersions?: WeakMap<object, number>;
    __codeflareReviewOriginalSendMessages?: WeakMap<object, (message: any, options?: any) => void>;
  };
  const piObject = pi as unknown as object;
  globalState.__codeflareReviewMessageKeys = globalState.__codeflareReviewMessageKeys || new Set<string>();
  globalState.__codeflareReviewSendMessagePatchVersions = globalState.__codeflareReviewSendMessagePatchVersions || new WeakMap<object, number>();
  globalState.__codeflareReviewOriginalSendMessages = globalState.__codeflareReviewOriginalSendMessages || new WeakMap<object, (message: any, options?: any) => void>();
  if (globalState.__codeflareReviewSendMessagePatchVersions.get(piObject) === patchVersion) return;
  const currentSendMessage = (pi as unknown as { sendMessage?: (message: any, options?: any) => void }).sendMessage?.bind(pi);
  if (!currentSendMessage) return;
  const originalSendMessage = globalState.__codeflareReviewOriginalSendMessages.get(piObject) || currentSendMessage;
  globalState.__codeflareReviewOriginalSendMessages.set(piObject, originalSendMessage);
  (pi as unknown as { sendMessage: (message: any, options?: any) => void }).sendMessage = (message: any, options?: any): void => {
    const customType = String(message?.customType || "");
    if (customType === "pr-boundary-review-result" || customType === "pr-boundary-review-summary" || customType === "codeflare-review-summary-v2") return;
    if (customType === "codeflare-review-summary-v3") {
      const details = message?.details || {};
      const key = durableReviewMessageKey({ customType, repo: details.repo, head: details.head, lane: details.lane, path: details.path });
      if (globalState.__codeflareReviewMessageKeys?.has(key)) return;
      originalSendMessage(message, options);
      globalState.__codeflareReviewMessageKeys?.add(key);
      return;
    }
    originalSendMessage(message, options);
  };
  globalState.__codeflareReviewSendMessagePatchVersions.set(piObject, patchVersion);
}

export default function (pi: ExtensionAPI) {
  installReviewMessageDedupe(pi);
  const runToken = Symbol("codeflare-review-enforcement");
  (globalThis as { __codeflarePi?: ExtensionAPI; __codeflareReviewEnforcementRun?: symbol }).__codeflarePi = pi;
  (globalThis as { __codeflareReviewEnforcementRun?: symbol }).__codeflareReviewEnforcementRun = runToken;
  const isActiveRun = (): boolean => (globalThis as { __codeflareReviewEnforcementRun?: symbol }).__codeflareReviewEnforcementRun === runToken;
  let pending: PendingReview | undefined;
  const toolStartArgs = new Map<string, any>();
  const shouldProcessPrBoundaryToolEnd = createReadyOnceTracker();

  pi.registerMessageRenderer("pr-boundary-review-result", () => new Text("", 0, 0));
  pi.registerMessageRenderer("pr-boundary-review-summary", () => new Text("", 0, 0));
  pi.registerMessageRenderer("codeflare-review-summary-v2", () => new Text("", 0, 0));
  pi.registerMessageRenderer("codeflare-review-summary-v3", (message: any) => new Markdown(String(message.content || ""), 0, 0, getMarkdownTheme()));

  // Background events (subagents:completed/failed) arrive without a usable session ctx.
  // Remember the most recent real ctx from live handlers so doc-updater can still be
  // spawned (and the service ctx re-seeded) when a reviewer completes off-turn.
  let lastCtx: any;
  const installReviewNotifyFilter = (ctx: any): void => {
    const ui = ctx?.ui;
    if (!ui?.notify) return;
    const globalState = globalThis as { __codeflareReviewPatchedUis?: WeakSet<object> };
    globalState.__codeflareReviewPatchedUis = globalState.__codeflareReviewPatchedUis || new WeakSet<object>();
    if (globalState.__codeflareReviewPatchedUis.has(ui)) return;
    globalState.__codeflareReviewPatchedUis.add(ui);
    const originalNotify = ui.notify.bind(ui);
    ui.notify = (message: string, type?: string): void => {
      const text = String(message || "");
      const isDuplicateLaneToast = /^PR-boundary .* completed for /.test(text);
      const isSummaryFallback = text.includes("Findings saved under") || text.includes("Merged summary saved:");
      const isDuplicateAckToast = /^PR-boundary review acknowledged for /.test(text) && !isSummaryFallback;
      if (isDuplicateLaneToast || isDuplicateAckToast) return;
      originalNotify(message, type);
    };
  };
  const remember = (ctx: any): void => {
    installReviewNotifyFilter(ctx);
    if (isRealSessionCtx(ctx)) lastCtx = ctx;
  };
  const completionCtx = (): any =>
    isRealSessionCtx(lastCtx) ? lastCtx : { sessionManager: { getCwd: () => process.cwd() }, ui: { notify: () => undefined } };

  // Pending state may only be discarded when the PR has DEFINITIVELY moved on
  // (reviewHeadStatus === "stale"), and always with a visible warning. An
  // indeterminate "unknown" (gh query failed) must preserve state and retry, so
  // a transient failure can never silently drop the review gate without an ack.
  const discardStale = (state: PendingReview, ctx: any): void => {
    clearPending(state.repo);
    pending = undefined;
    clearReviewStatus(ctx);
    ctx.ui.notify(`PR-boundary review state for ${basename(state.repo)} at ${state.head.slice(0, 12)} discarded: the open PR no longer points at this head.`, "warning");
  };

  function toolEventId(event: any): string | undefined {
    const id = event?.toolCallId || event?.toolUseId || event?.id;
    return typeof id === "string" ? id : undefined;
  }

  function withStartArgs(event: any): any {
    const id = toolEventId(event);
    const cached = id ? toolStartArgs.get(id) : undefined;
    if (commandText(event) || !cached) {
      if (id && commandText(event)) toolStartArgs.delete(id);
      return event;
    }
    const current = event?.args || event?.input || event?.params || {};
    const merged = { ...cached, ...current };
    const enriched = {
      ...event,
      args: merged,
      input: { ...(event?.input || {}), ...merged },
      params: { ...(event?.params || {}), ...merged },
    };
    if (id && commandText(enriched)) toolStartArgs.delete(id);
    return enriched;
  }


  function hydratePending(ctx: any): PendingReview | undefined {
    if (pending) return pending;
    const repo = activeRepoFallback() || findGitRoot(ctx.sessionManager.getCwd());
    pending = repo ? loadPending(repo) : undefined;
    return pending;
  }

  function claimReviewAnnouncement(state: PendingReview, lane: string): boolean {
    const path = join(reviewJobDir(state.repo, state.head), "announced", `${lane}.sent`);
    mkdirSync(dirname(path), { recursive: true });
    try {
      closeSync(openSync(path, "wx"));
      return true;
    } catch {
      return false;
    }
  }

  function publishReviewResult(state: PendingReview, lane: string, result: unknown, ctx: any): void {
    const path = persistReviewResult(state, lane, result);
    if (!claimReviewAnnouncement(state, lane)) return;
    ctx.ui.notify(`PR-boundary ${lane} completed for ${basename(state.repo)} at ${state.head.slice(0, 12)}. Findings saved: ${path}`, "info");
  }

  function severityCell(counts: ReviewSeverityCounts): string {
    return `C${counts.critical} H${counts.high} M${counts.medium} L${counts.low}`;
  }

  function reviewSummaryRecords(state: PendingReview): DurableReviewSummaryRecord[] {
    return state.lanes.map((lane) => {
      const path = reviewResultPath(state.repo, state.head, lane);
      const text = existsSync(path) ? readFileSync(path, "utf8") : "";
      const counts = countReviewSeverities(text);
      const recommendation = durableReviewRecommendation(counts);
      return { lane, path, text, counts, recommendation };
    });
  }

  function reviewSummaryRows(state: PendingReview): DurableReviewSummaryRow[] {
    return reviewSummaryRecords(state).map(({ text: _text, ...row }) => row);
  }

  function reviewSummaryMarkdown(state: PendingReview): string {
    return formatMergedReviewSummary({
      repoName: basename(state.repo),
      head: state.head,
      records: reviewSummaryRecords(state),
    });
  }

  function publishReviewSummary(state: PendingReview, ctx: any): void {
    if (!claimReviewAnnouncement(state, "summary-v3")) return;
    const content = reviewSummaryMarkdown(state);
    const summaryPath = join(reviewResultsDir(state.repo, state.head), "summary.md");
    try {
      mkdirSync(dirname(summaryPath), { recursive: true });
      writeFileSync(summaryPath, `${content}\n`, "utf8");
    } catch {
      // Chat summary is authoritative; the persisted merged summary is best-effort.
    }
    try {
      pi.sendMessage({
        customType: "codeflare-review-summary-v3",
        content,
        display: true,
        details: { repo: state.repo, head: state.head, summary: content },
      });
    } catch {
      ctx.ui.notify(`PR-boundary review acknowledged for ${basename(state.repo)} at ${state.head.slice(0, 12)}. Merged summary saved: ${summaryPath}`, "info");
    }
  }

  function completedStateFromDurableJob(repo: string, head: string): PendingReview | undefined {
    const job = readDurableReviewJob(repo, head);
    if (!job?.lanes?.length) return undefined;
    if (!job.lanes.every((lane) => existsSync(reviewResultPath(repo, head, lane)))) return undefined;
    return {
      repo,
      prNumber: job.prNumber,
      baseRefName: job.baseRefName,
      head,
      reviewBase: job.reviewBase,
      lanes: job.lanes,
      completed: new Set(job.lanes),
      docPromptSent: true,
      spawned: true,
      spawnedIds: {},
      fallbackLanes: new Set(),
      requestedAt: {},
      reviewStartedAt: job.startedAt,
      spawnedAt: job.startedAt,
    };
  }

  function publishFinalSummaryIfReady(repo: string, head: string, ctx: any): void {
    const state = completedStateFromDurableJob(repo, head);
    if (!state) return;
    publishReviewSummary(state, ctx);
    requestReviewAutofix(state);
  }

  function publishSummaryForCurrentPr(ctx: any): boolean {
    const repo = activeRepoFallback() || findGitRoot(ctx.sessionManager.getCwd());
    if (!repo || !isSddProject(repo)) return false;
    const pr = prState(repo);
    if (!isEnforcedPr(pr)) return false;
    const head = reviewCandidateHead(repo, pr);
    if (!head || !acked(repo, head)) return false;
    publishFinalSummaryIfReady(repo, head, ctx);
    return true;
  }

  function requestReviewAutofix(state: PendingReview): void {
    const marker = join(reviewJobDir(state.repo, state.head), "autofix.requested");
    try {
      requestReviewAutofixForRows({
        sender: pi,
        repo: state.repo,
        head: state.head,
        rows: reviewSummaryRows(state),
        claim: () => {
          mkdirSync(dirname(marker), { recursive: true });
          try {
            closeSync(openSync(marker, "wx"));
            return true;
          } catch {
            return false;
          }
        },
      });
    } catch {
      // Best effort: the visible merged summary still tells the user what to fix.
    }
  }

  function publishReviewResultFile(state: PendingReview, lane: string, ctx: any): void {
    const path = reviewResultPath(state.repo, state.head, lane);
    if (!claimReviewAnnouncement(state, lane)) return;
    ctx.ui.notify(`PR-boundary ${lane} completed for ${basename(state.repo)} at ${state.head.slice(0, 12)}. Findings saved: ${path}`, "info");
  }

  async function markCompleted(type: string, ctx: any, _completionId?: string, _prompt?: string, result?: unknown): Promise<void> {
    const state = hydratePending(ctx);
    if (!state || !state.lanes.includes(type)) return;
    if (state.completed.has(type)) return;
    // Only a definitively-moved PR ("stale") discards the window; "unknown" (gh
    // failed) falls through so the completion is still recorded and acked rather
    // than the whole review window being lost on a transient query failure.
    if (reviewHeadStatus(state) === "stale") {
      discardStale(state, ctx);
      return;
    }
    if (result !== undefined) publishReviewResult(state, type, result, ctx);
    else if (existsSync(reviewResultPath(state.repo, state.head, type))) publishReviewResultFile(state, type, ctx);
    else return;
    state.completed.add(type);
    updateReviewStatus(state, ctx);
    resetBlockCount(state.repo); // a lane completing is progress: reset the breaker patience counter
    if (type === "spec-reviewer" && state.lanes.includes("doc-updater") && !state.docPromptSent) {
      state.docPromptSent = true;
      savePending(state);
      const currentPr = prState(state.repo) || { baseRefName: state.baseRefName, number: state.prNumber, headRefOid: state.head } as PrState;
      await spawnReviewLanes(state, currentPr, ["doc-updater"], ctx, "spec-reviewer completion");
      return;
    }
    savePending(state);
    if (durableReviewAckReady({ lanes: state.lanes, resultLanes: completedDurableReviewLanes(state.repo, state.head, state.lanes) })) {
      writeAck(state.repo, state.head);
      resetBlockCount(state.repo);
      clearBreaker(state.repo);
      clearPending(state.repo);
      publishReviewSummary(state, ctx);
      requestReviewAutofix(state);
      clearReviewStatus(ctx);
      pending = undefined;
    }
  }

  const onAgentStart = (event: any, ctx: any) => {
    if (!isActiveRun()) return;
    remember(ctx);
    const toolName = String(event?.toolName || "").toLowerCase();
    const input = event?.input || event?.params || event?.args || {};
    const command = commandText(event);
    // commandText() pulls the command from bash (input.command) or, when context-mode is on,
    // the ctx_* tools (code/commands). Gate on the command itself, never the tool name.
    if (isGhPrMerge(command)) {
      const repo = findGitRoot(cwdFromCommand(command) || ctx.sessionManager.getCwd()) || activeRepoFallback();
      if (!repo || !isSddProject(repo) || consumeBypass()) return;
      const pr = prState(repo);
      if (!isEnforcedPr(pr)) return;
      const head = pr.headRefOid;
      if (!acked(repo, head)) {
        return { block: true, reason: `PR-boundary review required before merge for ${basename(repo)} at ${head.slice(0, 12)}. Complete required reviewers or use the user-only ${REVIEW_BYPASS} bypass.` };
      }
      return;
    }

    if (toolName !== "agent") return;
    const type = String(input.subagent_type || input.subagentType || "");
    if (type !== "doc-updater") return;
    const state = hydratePending(ctx);
    if (!state) return;
    if (reviewHeadStatus(state) === "stale") {
      discardStale(state, ctx);
      return;
    }
    if (state.lanes.includes("spec-reviewer") && !state.completed.has("spec-reviewer")) {
      return { block: true, reason: "PR-boundary review order violation: doc-updater must run only after spec-reviewer completes for this PR HEAD." };
    }
  };

  pi.on("session_start", (_event: any, ctx: any) => {
    remember(ctx);
    const state = hydratePending(ctx);
    if (state) {
      if (reviewHeadStatus(state) === "stale") discardStale(state, ctx);
      else updateReviewStatus(state, ctx);
    }
    publishSummaryForCurrentPr(ctx);
  });

  pi.on("tool_call", onAgentStart);
  pi.on("tool_execution_start", (event: any, ctx: any) => {
    const id = toolEventId(event);
    if (id) toolStartArgs.set(id, event?.args || event?.input || event?.params || {});
    return onAgentStart(event, ctx);
  });

  const onToolEnd = async (event: any, ctx: any) => {
    if (!isActiveRun()) return;
    remember(ctx);
    const toolName = String(event?.toolName || "").toLowerCase();
    if (isFailedToolExecution(event)) return;

    if (toolName === "agent") {
      const input = event?.input || event?.params || event?.args || {};
      const type = String(input.subagent_type || input.subagentType || "");
      const prompt = String(input.prompt || "");
      const state = hydratePending(ctx);
      if (!type || !state?.lanes.includes(type) || !prompt.includes(state.head)) return;
      if (reviewHeadStatus(state) === "stale") {
        discardStale(state, ctx);
        return;
      }

      const background = input.run_in_background === true || input.runInBackground === true;
      if (background) {
        if (state.spawnedIds[type]) return;
        const agentId = extractBackgroundAgentId(event) || extractBackgroundAgentId(toolResultPayload(event));
        if (agentId) {
          state.spawnedIds[type] = agentId;
          delete state.requestedAt[type];
          state.fallbackLanes.delete(type);
          state.spawned = true;
          state.spawnedAt = state.spawnedAt || Date.now();
          savePending(state);
          ctx.ui.notify(`PR-boundary ${type} registered for ${basename(state.repo)} at ${state.head.slice(0, 12)}. Agent: ${agentId}`, "info");
        } else {
          state.fallbackLanes.add(type);
          delete state.requestedAt[type];
          savePending(state);
          ctx.ui.notify(`PR-boundary ${type} launch result did not include an Agent ID; review remains pending and will retry.`, "warning");
        }
        return;
      }

      await markCompleted(type, ctx, undefined, prompt, toolResultPayload(event));
      return;
    }

    const command = commandText(event);
    if (!isPrBoundaryCommand(command)) return;

    const repo = findGitRoot(cwdFromCommand(command) || ctx.sessionManager.getCwd()) || activeRepoFallback();
    if (!repo || !isSddProject(repo) || consumeBypass()) return;

    const pr = prState(repo);
    if (!isEnforcedPr(pr)) return;
    const head = reviewCandidateHead(repo, pr, command);
    if (!head) return;
    const effectivePr = { ...pr, headRefOid: head };
    if (acked(repo, head)) return;
    if (isBreakerOpen(repo, head)) return; // breaker already gave up on this exact head; push a new commit to retry

    const rawPrevious = loadPending(repo);
    if (rawPrevious && rawPrevious.head === head) return;
    if (!shouldProcessPrBoundaryToolEnd(toolEventId(event), true)) return;
    const reusablePrevious = reusablePendingReview(rawPrevious, head, (ancestor, current) => isAncestor(repo, ancestor, current));
    if (rawPrevious && !reusablePrevious) clearPending(repo);

    const review = mergeLaneState(repo, head, reusablePrevious);
    if (review.lanes.length === 0) {
      writeAck(repo, head);
      clearPending(repo);
      return;
    }

    const reviewBase = selectReviewBase({
      previous: reusablePrevious ? { ...reusablePrevious, completed: [...reusablePrevious.completed] } : undefined,
      lastAck: lastAckHead(repo) || undefined,
      previousRemoteHead: isLocalGitPushCommand(command) ? previousRemoteHead(repo, head) : undefined,
    });
    const validBase = reviewBase && isAncestor(repo, reviewBase, head) ? reviewBase : undefined;
    resetBlockCount(repo);
    clearBreaker(repo); // new head under review: drop any stale breaker latch from a prior head
    pending = { repo, prNumber: pr.number, baseRefName: pr.baseRefName, head, reviewBase: validBase, lanes: review.lanes, completed: review.completed, docPromptSent: false, spawned: false, spawnedIds: {}, fallbackLanes: new Set(), requestedAt: {}, reviewStartedAt: Date.now() };
    const initialLanes = durableReviewInitialLanes(pending.lanes);
    savePending(pending);
    updateReviewStatus(pending, ctx);
    pruneReviewResults(repo, head); // a new head is under review; drop stale prior-head result dirs
    ctx.ui.notify(`PR-boundary review required for ${basename(repo)} at ${head.slice(0, 12)}. Lanes: ${review.lanes.join(", ")}.`, "warning");
    await spawnReviewLanes(pending, effectivePr, initialLanes, ctx, "initial PR-boundary trigger");
  };

  // Pi emits both `tool_result` and `tool_execution_end` for the same tool call.
  // PR-boundary command handling has side effects (pending-state creation,
  // warnings, and automatic reviewer spawns), so that command path is deduped by
  // tool-call ID. Agent-result handling remains idempotent for foreground/manual
  // fallback lanes, but normal PR-boundary dispatch no longer depends on prompts
  // asking the assistant to call the Agent tool.
  pi.on("tool_result", (event: any, ctx: any) => onToolEnd(withStartArgs(event), ctx));
  pi.on("tool_execution_end", (event: any, ctx: any) => onToolEnd(withStartArgs(event), ctx));

  const onDurableLaneCompleted = async (event: any, ctx: any) => {
    if (!isActiveRun()) return;
    const lane = String(event?.lane || "");
    const head = String(event?.head || "");
    const state = hydratePending(ctx);
    if (!lane || !state || state.head !== head) return;
    await markCompleted(lane, ctx);
  };

  const onDurableLaneFailed = async (event: any, ctx: any) => {
    if (!isActiveRun()) return;
    const lane = String(event?.lane || "");
    const head = String(event?.head || "");
    const state = hydratePending(ctx);
    if (!lane || !state || state.head !== head) return;
    updateReviewStatus(state, ctx);
  };

  (pi as any).events?.on?.(REVIEW_JOBS_EVENT_LANE_COMPLETED, (event: any) => onDurableLaneCompleted(event, completionCtx()));
  (pi as any).events?.on?.(REVIEW_JOBS_EVENT_LANE_FAILED, (event: any) => onDurableLaneFailed(event, completionCtx()));

  pi.on("agent_end", async (_event, ctx) => {
    if (!isActiveRun()) return;
    remember(ctx);
    const state = hydratePending(ctx);
    if (!state) {
      if (publishSummaryForCurrentPr(ctx)) return;
      const repo = activeRepoFallback() || findGitRoot(ctx.sessionManager.getCwd());
      if (!repo || !isSddProject(repo) || consumeBypass()) return;
      const pr = prState(repo);
      if (!isEnforcedPr(pr)) return;
      const head = reviewCandidateHead(repo, pr);
      if (!head) return;
      const effectivePr = { ...pr, headRefOid: head };
      if (acked(repo, head)) {
        publishFinalSummaryIfReady(repo, head, ctx);
        return;
      }
      if (isBreakerOpen(repo, head)) return;

      const review = mergeLaneState(repo, head, undefined);
      if (review.lanes.length === 0) {
        writeAck(repo, head);
        clearPending(repo);
        return;
      }
      const reviewBase = selectReviewBase({ lastAck: lastAckHead(repo) || undefined });
      const validBase = reviewBase && isAncestor(repo, reviewBase, head) ? reviewBase : undefined;
      resetBlockCount(repo);
      clearBreaker(repo);
      pending = { repo, prNumber: pr.number, baseRefName: pr.baseRefName, head, reviewBase: validBase, lanes: review.lanes, completed: review.completed, docPromptSent: false, spawned: false, spawnedIds: {}, fallbackLanes: new Set(), requestedAt: {}, reviewStartedAt: Date.now() };
      const initialLanes = durableReviewInitialLanes(pending.lanes);
      savePending(pending);
      updateReviewStatus(pending, ctx);
      pruneReviewResults(repo, head);
      ctx.ui.notify(`PR-boundary review catch-up required for ${basename(repo)} at ${head.slice(0, 12)}. Lanes: ${review.lanes.join(", ")}.`, "warning");
      await spawnReviewLanes(pending, effectivePr, initialLanes, ctx, "agent_end catch-up");
      return;
    }
    if (isBreakerOpen(state.repo, state.head)) { pending = undefined; return; } // latched: do no further work for this head
    if (acked(state.repo, state.head)) {
      publishFinalSummaryIfReady(state.repo, state.head, ctx);
      clearPending(state.repo);
      pending = undefined;
      return;
    }
    if (consumeBypass()) {
      clearPending(state.repo);
      pending = undefined;
      return;
    }
    const headStatus = reviewHeadStatus(state);
    if (headStatus === "stale") {
      discardStale(state, ctx);
      return;
    }
    if (headStatus === "unknown") {
      // gh could not confirm the PR head this cycle. Keep the persisted window
      // (merge gate stays fail-closed) and retry on the next agent_end instead of
      // discarding review state on a transient failure.
      pending = undefined;
      return;
    }

    const currentState = loadPending(state.repo) || state;
    for (const lane of completedDurableReviewLanes(currentState.repo, currentState.head, currentState.lanes)) {
      if (!currentState.completed.has(lane)) {
        await markCompleted(lane, ctx);
        return;
      }
    }

    const running = runningDurableReviewLanes(currentState.repo, currentState.head, currentState.lanes)
      .filter((lane) => !currentState.completed.has(lane));
    if (running.length > 0) return;

    const failed = failedDurableReviewLanes(currentState.repo, currentState.head, currentState.lanes)
      .filter((lane) => !currentState.completed.has(lane));
    if (failed.length > 0) {
      ctx.ui.notify(`PR-boundary durable review lane(s) failed for ${basename(currentState.repo)} at ${currentState.head.slice(0, 12)}: ${failed.join(", ")}. Retrying eligible lanes; state: ${reviewJobDir(currentState.repo, currentState.head)}`, "warning");
    }

    const pendingAge = Date.now() - currentState.reviewStartedAt;

    // Reviewers are not running (or have stalled past the timeout). Count this fruitless
    // decision cycle and latch the breaker once we exceed the attempt or age bound, so a
    // review that can never complete (e.g. stale subagent ctx after compaction) stops
    // re-spawning and re-reminding on every agent_end instead of spiralling unbounded.
    // The counter is reset on real progress (markCompleted) and when a new head is pushed.
    const attempts = incrementBlockCount(currentState.repo);
    if (attempts >= MAX_REVIEW_ATTEMPTS || pendingAge >= MAX_REVIEW_AGE_MS) {
      openBreaker(currentState.repo, currentState.head);
      clearPending(currentState.repo);
      resetBlockCount(currentState.repo);
      pending = undefined;
      ctx.ui.notify(`Review enforcement gave up for ${basename(currentState.repo)} at ${currentState.head.slice(0, 12)} after ${attempts} attempts; merge stays blocked. Push a new commit to retry, or use the user-only ${REVIEW_BYPASS} bypass.`, "warning");
      return;
    }

    const eligibleUnstarted = durableReviewEligibleLanes({
      lanes: currentState.lanes,
      completed: [...currentState.completed, ...completedDurableReviewLanes(currentState.repo, currentState.head, currentState.lanes)],
      running: runningDurableReviewLanes(currentState.repo, currentState.head, currentState.lanes),
      requestedAt: currentState.requestedAt,
      now: Date.now(),
      retryMs: REVIEW_REQUEST_RETRY_MS,
    }).filter((lane) => shouldRequestLane(currentState, lane));
    if (eligibleUnstarted.length > 0) {
      const currentPr = prState(currentState.repo) || { baseRefName: currentState.baseRefName, number: currentState.prNumber, headRefOid: currentState.head } as PrState;
      await spawnReviewLanes(currentState, currentPr, eligibleUnstarted, ctx, "pending reviewer retry");
      return;
    }

    const remaining = currentState.lanes.filter((lane) => !currentState.completed.has(lane)).join(", ") || "none";
    ctx.ui.notify(`PR-boundary review still pending for ${basename(currentState.repo)} at ${currentState.head.slice(0, 12)}. Remaining lanes: ${remaining}. Attempt ${attempts}/${MAX_REVIEW_ATTEMPTS}. Automatic reviewer spawn will retry if no Agent ID is registered; user-only bypass: ${REVIEW_BYPASS}.`, "warning");
  });
}
