/**
 * Codeflare Pi PR-boundary review enforcement.
 *
 * Native Pi counterpart to Claude Code's PR-boundary review hooks.
 * It watches pushes/PR creation/PR merges for SDD projects with an open PR to
 * main/master, computes the minimal required review lanes, spawns Pi subagents
 * for only those lanes, persists progress under .git/, and acknowledges the PR
 * head after the required lanes complete or after an explicit user bypass.
 */

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { ALL_REVIEW_LANES, bypassAckHeadForStatus, classifyReviewFiles, classifyReviewHead, commandTextFromEvent, createReadyOnceTracker, cwdFromBoundaryCommand, enforcedHeadDecision, extractBackgroundAgentId, isFailedToolExecution, isPrBoundaryTrigger, prCreateBoundaryBase, prUrlFromText, reusablePendingReview, selectReviewBase, type ReviewHeadStatus, type ReviewSpawnRequest } from "./review-helpers";
import { compactDurableReviewStatus, countReviewSeverities, durableReviewAckReady, durableReviewEligibleLanes, durableReviewInitialLanes, durableReviewMessageKey, durableReviewRecommendation, formatMergedReviewSummary, requestReviewAutofixForRows, reviewAutofixModeFromUserMessages, shouldCheckOpenPrReconciliation, shouldReconcileOpenPr, type DurableReviewSummaryRecord, type DurableReviewSummaryRow, type ReviewSeverityCounts } from "./review-job-helpers";
import { appendReviewEvent, completedDurableReviewLanes, failedDurableReviewLanes, readDurableReviewJob, reapDurableReviewLanes, reviewJobDir, reviewResultPath, reviewResultsDir, runningDurableReviewLanes, startDurableReviewLanes } from "./review-jobs";

const REVIEW_BYPASS = "/tmp/review-bypass";

// Circuit-breaker bounds. A pending review for a given HEAD that cannot make
// progress (e.g. the subagent service ctx went stale after a compaction) must
// stop re-spawning and re-reminding instead of spiralling unbounded. Latch once
// we exceed either bound; the counter is reset on real progress.
const MAX_REVIEW_ATTEMPTS = 5;
const MAX_REVIEW_AGE_MS = 20 * 60 * 1000;
const REVIEW_REQUEST_RETRY_MS = 60 * 1000;

// Open-PR reconciliation (REQ-AGENT-058) does a `gh pr view` to catch missed boundaries.
// That is a network call, so throttle the unforced path (turn_start/turn_end/resources_discover)
// to at most once per window; forced ticks (session_start, agent_end, PR-URL fallback) bypass it.
const RECONCILE_THROTTLE_MS = 20 * 1000;
let lastReconcileCheckAt = 0;

type PrState = {
  state?: string;
  baseRefName?: string;
  headRefOid?: string;
  headRefName?: string;
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
  return cwdFromBoundaryCommand(command);
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
  return commandTextFromEvent(event);
}


function isGhPrMerge(command: string): boolean {
  return /(^|[;&|\n]\s*)gh\s+pr\s+merge\b/.test(command);
}

function isSddProject(repo: string): boolean {
  return existsSync(join(repo, "sdd", "README.md"));
}

function prState(repo: string): PrState | undefined {
  try {
    const out = shell("gh pr view --json number,state,baseRefName,headRefOid,headRefName,isDraft 2>/dev/null", repo);
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
  return /(^|[;&|\n]\s*)git(?:\s+-C\s+\S+)?\s+push\b/.test(command);
}

function isGitPushCommand(command: string): boolean {
  return isLocalGitPushCommand(command) || /(^|[;&|\n]\s*)gh\s+repo\s+sync\b/.test(command);
}

function prForBoundaryCommand(repo: string, command: string, pr: PrState | undefined): PrState | undefined {
  if (isEnforcedPr(pr)) return pr;
  const base = prCreateBoundaryBase(command, pr?.baseRefName);
  if (!base) return pr;
  const head = localHead(repo) || pr?.headRefOid;
  if (!head) return pr;
  // GitHub may not make a just-created PR visible to `gh pr view` immediately.
  // Mirror Claude's PR-open fail-open behavior: for an SDD `gh pr create` whose
  // base is main/master (or temporarily unreadable), arm review for local HEAD.
  const basePr: PrState = pr || {};
  return { ...basePr, state: "OPEN", baseRefName: base, headRefOid: head };
}

function reviewCandidateHead(repo: string, pr: PrState, command?: string): string {
  if (command && isLocalGitPushCommand(command)) return localHead(repo) || pr.headRefOid || "";
  return pr.headRefOid || "";
}

// Lag-tolerant enforced head for open-PR reconciliation (REQ-AGENT-058 AC3). `gh pr view` can
// report a stale headRefOid for a few seconds after a push, so when local HEAD is on the PR
// branch, descends from the reported PR head, AND has actually been pushed, the local commit is
// the real boundary head. The push check is load-bearing: an unpushed local WIP commit also
// descends from the reported head, and without it reconciliation would arm a review for a commit
// the PR never had. "Pushed" = the remote-tracking ref origin/<branch> contains local HEAD; git
// push updates that ref locally, so this holds even before a fetch and while gh metadata lags.
// Returns "" when neither head is resolvable; any mismatch self-corrects (the merge gate acks the
// PR head and reconciliation re-runs each tick until they converge). Decision is the pure
// enforcedHeadDecision so it is unit-testable without a git fixture.
function resolveEnforcedHead(repo: string, pr: PrState): string {
  const prHead = pr.headRefOid || "";
  const local = localHead(repo) || "";
  const onPrBranch = Boolean(pr.headRefName) && currentBranch(repo) === pr.headRefName;
  const decision = enforcedHeadDecision({
    prHead,
    local,
    onPrBranch,
    localDescendsFromPrHead: Boolean(prHead) && Boolean(local) && prHead !== local && isAncestor(repo, prHead, local),
    localPushed: onPrBranch && isAncestor(repo, local, `origin/${pr.headRefName}`),
  });
  return decision === "local" ? local : prHead;
}

function mergeLaneState(repo: string, currentHead: string, previous?: PendingReview): { lanes: string[]; completed: Set<string> } {
  const lastAck = lastAckHead(repo);
  if (!previous) {
    const changed = classifyReviewFiles(changedFiles(repo, lastAck, currentHead));
    return { lanes: changed || ALL_REVIEW_LANES, completed: new Set() };
  }

  const incompletePrevious = previous.lanes.filter((lane) => !previous.completed.has(lane));
  if (incompletePrevious.length > 0) {
    // Claude's Stop hook keeps a running_ack pointer: if a new push lands before
    // the prior review completes, the next review must cover the whole unacked
    // window, not only previous.head..currentHead. Do not carry completed lanes
    // forward because their results were for a superseded head.
    const base = previous.reviewBase || lastAck;
    const changed = classifyReviewFiles(changedFiles(repo, base, currentHead));
    return { lanes: changed || ALL_REVIEW_LANES, completed: new Set() };
  }

  const changed = classifyReviewFiles(changedFiles(repo, previous.head || lastAck, currentHead));
  const changedLanes = changed || ALL_REVIEW_LANES;
  const completed = new Set(
    previous.lanes.filter((lane) => previous.completed.has(lane) && changedLanes.includes(lane) === false),
  );
  return { lanes: changedLanes, completed };
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
    const color = ctx.ui?.theme?.fg;
    const style = typeof color === "function"
      ? {
          done: (label: string) => color.call(ctx.ui.theme, "success", label),
          running: (label: string) => color.call(ctx.ui.theme, "warning", label),
        }
      : undefined;
    ctx.ui.setStatus("codeflare-review", compactDurableReviewStatus({
      head: state.head,
      lanes: state.lanes,
      completed,
      running,
      style,
    }));
  } catch {
    // Status display is best-effort; persisted review state is authoritative.
  }
}

function clearReviewStatus(ctx: any): void {
  try { ctx.ui.setStatus("codeflare-review", undefined); } catch { /* best effort */ }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textFromContent).filter(Boolean).join("\n");
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
  }
  return "";
}

function sessionUserMessages(ctx: any): string[] {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    if (!file || !existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line);
          const message = entry?.message || entry;
          if (message?.role !== "user") return [];
          const text = textFromContent(message.content);
          return text ? [text] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function spawnReviewLanes(pending: PendingReview, pr: PrState, lanes: string[], ctx: any, reason: string): Promise<void> {
  if (lanes.length === 0) return;

  const now = Date.now();
  const requests: ReviewSpawnRequest[] = lanes
    .filter((lane) => shouldRequestLane(pending, lane, now))
    .map((lane) => ({ lane, prompt: promptForLane(pending, pr, lane), description: descriptionForLane(lane) }));
  if (requests.length === 0) return;

  // Resolve a concrete modelRegistry value from the live on-turn ctx (never a lazy ctx
  // getter read later inside the async lane — that was the DL-1 undefined/throw). The lane
  // runner takes the resolved value, so it needs neither `pi` nor a captured ctx.
  const modelRegistry = (() => { try { return ctx.modelRegistry; } catch { return undefined; } })();
  const result = startDurableReviewLanes(
    { modelRegistry },
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
  const local = localHead(pending.repo);
  const prHead = current?.headRefOid;
  return classifyReviewHead({
    pendingHead: pending.head,
    localHead: local,
    prOpenAtBase: isEnforcedPr(current),
    prHead,
    prQueryFailed: current === undefined,
    localHeadDescendsFromPending: Boolean(local && local !== pending.head && isAncestor(pending.repo, pending.head, local)),
    prHeadDescendsFromPending: Boolean(prHead && prHead !== pending.head && isAncestor(pending.repo, pending.head, prHead)),
  });
}

function currentEnforcedPrHead(repo: string): string {
  const current = prState(repo);
  if (!isEnforcedPr(current)) return "";
  return reviewCandidateHead(repo, current);
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

function reviewSummaryRecordsFromDisk(state: PendingReview): DurableReviewSummaryRecord[] {
  return state.lanes.map((lane) => {
    const path = reviewResultPath(state.repo, state.head, lane);
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    const counts = countReviewSeverities(text);
    const recommendation = durableReviewRecommendation(counts);
    return { lane, path, text, counts, recommendation };
  });
}

function writeReviewSummaryFromDisk(state: PendingReview): void {
  const content = formatMergedReviewSummary({
    repoName: basename(state.repo),
    head: state.head,
    records: reviewSummaryRecordsFromDisk(state),
  });
  const summaryPath = join(reviewResultsDir(state.repo, state.head), "summary.md");
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, `${content}\n`, "utf8");
}

function finalizeCompletedReviewFromDisk(state: PendingReview): void {
  appendReviewEvent(state.repo, { event: "review_acked", head: state.head, lanes: state.lanes });
  writeAck(state.repo, state.head);
  resetBlockCount(state.repo);
  clearBreaker(state.repo);
  clearPending(state.repo);
  writeReviewSummaryFromDisk(state);
}

// Set by the extension's default export to a pi-bound finalize closure, so the module-level
// autonomous timer (which has no pi/ctx) can emit the merged summary into the session AND fire
// the autofix turn when an idle review completes. Falls back to disk-only ack until it is bound.
let activeReviewFinalize: ((state: PendingReview) => void) | undefined;

// Autonomous review reaper (REQ-AGENT-061 AC1-AC3). Detached lane children run to completion
// on their own, but the reaper that harvests them (writes the result file, advances the
// state machine) otherwise only runs on user-driven lifecycle ticks — so a push followed
// by an idle session leaves finished lanes unharvested (agent_end on disk, no result file).
// Pi exposes no periodic/idle hook, so this plain interval (registered once, below) drives
// the reaper without a ctx while a review window is pending: it reaps finished lanes,
// finalizes completed reviews (emit summary + autofix via the pi-bound closure), and spawns the next *fresh* eligible lane (e.g.
// doc-updater once spec-reviewer has a result). Failed-lane RETRIES are intentionally left
// to the on-turn driver so the breaker still bounds them. Best-effort and self-clearing:
// it must never throw.
function autonomousReviewReaperTick(): void {
  try {
    // The timer has no event ctx, so it cannot use ctx.sessionManager.getCwd() like the on-turn
    // handlers. process.cwd() is pi's PROCESS dir, not the session/repo dir, so resolve the repo
    // the way every other handler's fallback does: the active-repo sentinel first, process.cwd() last.
    const repo = activeRepoFallback() || findGitRoot(process.cwd());
    if (!repo) return;
    const pending = loadPending(repo);
    if (!pending || !pending.head || pending.lanes.length === 0) return;
    reapDurableReviewLanes(pending.repo, pending.head);
    const completed = completedDurableReviewLanes(pending.repo, pending.head, pending.lanes);
    if (completed.length === pending.lanes.length) {
      // Idle finalization with no ctx: the pi-bound closure (set by the default export) emits the
      // merged summary into the session AND fires the autofix (pi.sendMessage with triggerTurn), so
      // an idle completed review resumes and shows results with zero user input. The user can ESC to
      // decline the fix. publishReviewSummary/requestReviewAutofix are claim-guarded, so a later real
      // turn never double-emits. Disk-only ack is the fallback before the closure is bound.
      if (activeReviewFinalize) activeReviewFinalize(pending);
      else finalizeCompletedReviewFromDisk(pending);
      return;
    }
    const job = readDurableReviewJob(pending.repo, pending.head);
    const running = runningDurableReviewLanes(pending.repo, pending.head, pending.lanes);
    const eligible = durableReviewEligibleLanes({
      lanes: pending.lanes,
      completed,
      running,
      requestedAt: pending.requestedAt,
      now: Date.now(),
      retryMs: REVIEW_REQUEST_RETRY_MS,
    }).filter((lane) => {
      const status = job?.laneState?.[lane]?.status;
      return status === undefined || status === "pending"; // only never-attempted lanes; retries → on-turn driver + breaker
    });
    if (eligible.length === 0) return;
    const pr = { baseRefName: pending.baseRefName, number: pending.prNumber, headRefOid: pending.head } as PrState;
    const requests: ReviewSpawnRequest[] = eligible
      .filter((lane) => shouldRequestLane(pending, lane))
      .map((lane) => ({ lane, prompt: promptForLane(pending, pr, lane), description: descriptionForLane(lane) }));
    if (requests.length === 0) return;
    startDurableReviewLanes({ modelRegistry: undefined }, {
      repo: pending.repo,
      prNumber: pending.prNumber,
      baseRefName: pending.baseRefName,
      head: pending.head,
      reviewBase: pending.reviewBase,
      lanes: pending.lanes,
    }, requests);
  } catch {
    // Never throw from the autonomous timer — a transient fs/spawn error must not crash pi.
  }
}

export default function (pi: ExtensionAPI) {
  installReviewMessageDedupe(pi);
  // Drive the autonomous reaper on an interval so reviews finalize without a user turn.
  // Reload-safe singleton (clear any prior interval first so /reload does not stack timers);
  // unref so it never keeps the process alive on its own.
  {
    // Bind the pi-aware finalize so the module-level autonomous timer can emit + autofix on idle.
    activeReviewFinalize = (state: PendingReview) => finalizeCompletedReview(state);
    const reaperKey = "__codeflareReviewReaperTimer";
    const store = globalThis as Record<string, ReturnType<typeof setInterval> | undefined>;
    if (store[reaperKey]) clearInterval(store[reaperKey]);
    const timer = setInterval(autonomousReviewReaperTick, 20_000);
    if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
    store[reaperKey] = timer;
  }
  const runToken = Symbol("codeflare-review-enforcement");
  (globalThis as { __codeflareReviewEnforcementRun?: symbol }).__codeflareReviewEnforcementRun = runToken;
  const isActiveRun = (): boolean => (globalThis as { __codeflareReviewEnforcementRun?: symbol }).__codeflareReviewEnforcementRun === runToken;
  let pending: PendingReview | undefined;
  const toolStartArgs = new Map<string, any>();
  const shouldProcessPrBoundaryToolEnd = createReadyOnceTracker();

  pi.registerMessageRenderer("pr-boundary-review-result", () => new Text("", 0, 0));
  pi.registerMessageRenderer("pr-boundary-review-summary", () => new Text("", 0, 0));
  pi.registerMessageRenderer("codeflare-review-summary-v2", () => new Text("", 0, 0));
  pi.registerMessageRenderer("codeflare-review-summary-v3", (message: any) => new Markdown(String(message.content || ""), 0, 0, getMarkdownTheme()));

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
  // Lane completion is PULLED on-turn (turn_start/turn_end/agent_end/resources_discover
  // → refreshReviewStatusFromDurable / agent_end reconciler), never pushed from an
  // off-turn bus listener with a stale ctx. `remember` therefore only installs the
  // notify filter; there is no captured ctx to reuse off-turn, which is what eliminated
  // the assertActive() stale-ctx flood entirely (review.md §10, Failure #7).
  const remember = (ctx: any): void => {
    installReviewNotifyFilter(ctx);
  };

  // Pending state may only be discarded when the PR has DEFINITIVELY moved on
  // (reviewHeadStatus === "stale"), and always with a visible warning. An
  // indeterminate "unknown" (gh query failed) must preserve state and retry, so
  // a transient failure can never silently drop the review gate without an ack.
  const discardStale = (state: PendingReview, ctx: any): void => {
    appendReviewEvent(state.repo, { event: "review_superseded", head: state.head, reason: "open PR no longer points at this head", lanes: state.lanes });
    clearPending(state.repo);
    pending = undefined;
    clearReviewStatus(ctx);
    ctx.ui.notify(`PR-boundary review state for ${basename(state.repo)} at ${state.head.slice(0, 12)} discarded: the open PR no longer points at this head.`, "warning");
  };

  const acknowledgeBypass = (repo: string, head: string, ctx: any): void => {
    writeAck(repo, head);
    resetBlockCount(repo);
    clearBreaker(repo);
    clearPending(repo);
    pending = undefined;
    clearReviewStatus(ctx);
    ctx.ui.notify(`PR-boundary review bypass acknowledged for ${basename(repo)} at ${head.slice(0, 12)}.`, "warning");
  };

  const rollForwardAdvancedReview = async (state: PendingReview, ctx: any, reason: string): Promise<boolean> => {
    const currentPr = prState(state.repo);
    if (!isEnforcedPr(currentPr)) return false;
    const head = reviewCandidateHead(state.repo, currentPr);
    if (!head || head === state.head || !isAncestor(state.repo, state.head, head)) return false;
    appendReviewEvent(state.repo, { event: "review_superseded", head: state.head, reason: `${reason}; rolled forward to ${head.slice(0, 12)}`, lanes: state.lanes });

    const review = mergeLaneState(state.repo, head, state);
    if (review.lanes.length === 0) {
      resetBlockCount(state.repo);
      clearBreaker(state.repo);
      writeAck(state.repo, head);
      clearPending(state.repo);
      clearReviewStatus(ctx);
      pending = undefined;
      return true;
    }

    resetBlockCount(state.repo);
    clearBreaker(state.repo);
    const reviewBase = selectReviewBase({
      previous: { ...state, completed: [...state.completed] },
      lastAck: lastAckHead(state.repo) || undefined,
    });
    const validBase = reviewBase && isAncestor(state.repo, reviewBase, head) ? reviewBase : undefined;
    pending = {
      repo: state.repo,
      prNumber: currentPr.number,
      baseRefName: currentPr.baseRefName,
      head,
      reviewBase: validBase,
      lanes: review.lanes,
      completed: review.completed,
      docPromptSent: false,
      spawned: false,
      spawnedIds: {},
      fallbackLanes: new Set(),
      requestedAt: {},
      reviewStartedAt: Date.now(),
    };
    savePending(pending);
    updateReviewStatus(pending, ctx);
    ctx.ui.notify(`PR-boundary review rolled forward for ${basename(state.repo)} from ${state.head.slice(0, 12)} to ${head.slice(0, 12)} (${reason}). Lanes: ${review.lanes.join(", ")}.`, "warning");
    await spawnReviewLanes(pending, currentPr, durableReviewInitialLanes(pending.lanes), ctx, "advanced PR head roll-forward");
    return true;
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
    const current = event?.args || event?.input || event?.params || event?.arguments || {};
    const merged = { ...cached, ...current };
    const enriched = {
      ...event,
      args: merged,
      input: { ...(event?.input || {}), ...merged },
      params: { ...(event?.params || {}), ...merged },
      arguments: { ...(event?.arguments || {}), ...merged },
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
      if (ctx) ctx.ui.notify(`PR-boundary review acknowledged for ${basename(state.repo)} at ${state.head.slice(0, 12)}. Merged summary saved: ${summaryPath}`, "info");
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
    requestReviewAutofix(state, ctx);
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

  function requestReviewAutofix(state: PendingReview, ctx: any): void {
    const marker = join(reviewJobDir(state.repo, state.head), "autofix.requested");
    const resultLanes = completedDurableReviewLanes(state.repo, state.head, state.lanes);
    const reviewComplete = durableReviewAckReady({ lanes: state.lanes, resultLanes });
    try {
      requestReviewAutofixForRows({
        sender: pi,
        repo: state.repo,
        head: state.head,
        rows: reviewSummaryRows(state),
        reviewComplete,
        suppress: ctx ? reviewAutofixModeFromUserMessages(sessionUserMessages(ctx)) === "manual" : false,
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

  function finalizeCompletedReview(state: PendingReview, ctx?: any): void {
    appendReviewEvent(state.repo, { event: "review_acked", head: state.head, lanes: state.lanes });
    writeAck(state.repo, state.head);
    resetBlockCount(state.repo);
    clearBreaker(state.repo);
    clearPending(state.repo);
    publishReviewSummary(state, ctx);
    requestReviewAutofix(state, ctx);
    clearReviewStatus(ctx);
    pending = undefined;
  }

  function refreshReviewStatusFromDurable(ctx: any): void {
    const state = hydratePending(ctx);
    if (!state) {
      clearReviewStatus(ctx);
      publishSummaryForCurrentPr(ctx);
      return;
    }
    // Reap detached lane children from disk FIRST: any lane that finished (agent_end),
    // died, or blew its budget transitions running → completed/failed here, so the
    // completion/ack checks below see fresh state. This is what drives the state
    // machine forward across turns — and across sessions, since the reaper is purely
    // disk-driven and can finalize a lane another (now-exited) session spawned.
    reapDurableReviewLanes(state.repo, state.head);
    const headStatus = reviewHeadStatus(state);
    if (headStatus === "stale") {
      discardStale(state, ctx);
      return;
    }
    if (headStatus === "advanced" || headStatus === "unknown") {
      updateReviewStatus(state, ctx);
      return;
    }
    if (durableReviewAckReady({ lanes: state.lanes, resultLanes: completedDurableReviewLanes(state.repo, state.head, state.lanes) })) {
      finalizeCompletedReview(state, ctx);
      return;
    }
    updateReviewStatus(state, ctx);
  }

  async function markCompleted(type: string, ctx: any, _completionId?: string, _prompt?: string, result?: unknown): Promise<void> {
    const state = hydratePending(ctx);
    if (!state || !state.lanes.includes(type)) return;
    if (state.completed.has(type)) {
      refreshReviewStatusFromDurable(ctx);
      return;
    }
    // Only a definitively-moved PR ("stale") discards the window; "unknown" (gh
    // failed) falls through so the completion is still recorded and acked rather
    // than the whole review window being lost on a transient query failure. If
    // the PR head advanced along the same branch, roll the gate forward to a
    // cumulative review instead of dropping the earlier in-flight result.
    const headStatus = reviewHeadStatus(state);
    if (headStatus === "stale") {
      discardStale(state, ctx);
      return;
    }
    if (headStatus === "advanced") {
      if (result !== undefined) publishReviewResult(state, type, result, ctx);
      else if (existsSync(reviewResultPath(state.repo, state.head, type))) publishReviewResultFile(state, type, ctx);
      await rollForwardAdvancedReview(state, ctx, `${type} completed after PR head advanced`);
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
      finalizeCompletedReview(state, ctx);
    }
  }

  // Create the review window for an enforced head if none exists, spawn the initial lanes, and
  // persist. Shared by the onToolEnd boundary path and open-PR reconciliation so both produce a
  // byte-identical window (REQ-AGENT-058 AC2). Idempotent: a no-op when a window for this exact
  // head already exists (AC6). Returns true when it created a window or acked a no-lane diff
  // (e.g. a generated-only graphify-out/ change, which classifyReviewFiles skips to zero lanes).
  async function ensureReviewWindow(input: { repo: string; pr: PrState; head: string; ctx: any; trigger: string; command?: string }): Promise<boolean> {
    const { repo, pr, head, ctx, trigger, command } = input;
    const rawPrevious = loadPending(repo);
    if (rawPrevious?.head === head) return false;
    const reusablePrevious = reusablePendingReview(rawPrevious, head, (ancestor, current) => isAncestor(repo, ancestor, current));
    if (rawPrevious && !reusablePrevious) clearPending(repo);

    const review = mergeLaneState(repo, head, reusablePrevious);
    if (review.lanes.length === 0) {
      // No reviewable lanes — e.g. the diff touches only generated, machine-authored artifacts
      // (the checked-in graphify-out/ knowledge graph), which classifyReviewFiles skips
      // (REQ-AGENT-040 AC8). Acknowledge the head so the merge gate opens; no lanes to spawn.
      appendReviewEvent(repo, { event: "boundary_detected", head, decision: "ack_no_lanes", trigger });
      writeAck(repo, head);
      clearPending(repo);
      return true;
    }

    const reviewBase = selectReviewBase({
      previous: reusablePrevious ? { ...reusablePrevious, completed: [...reusablePrevious.completed] } : undefined,
      lastAck: lastAckHead(repo) || undefined,
      previousRemoteHead: command && isLocalGitPushCommand(command) ? previousRemoteHead(repo, head) : undefined,
    });
    const validBase = reviewBase && isAncestor(repo, reviewBase, head) ? reviewBase : undefined;
    resetBlockCount(repo);
    clearBreaker(repo); // new head under review: drop any stale breaker latch from a prior head
    pending = { repo, prNumber: pr.number, baseRefName: pr.baseRefName, head, reviewBase: validBase, lanes: review.lanes, completed: review.completed, docPromptSent: false, spawned: false, spawnedIds: {}, fallbackLanes: new Set(), requestedAt: {}, reviewStartedAt: Date.now() };
    const initialLanes = durableReviewInitialLanes(pending.lanes);
    savePending(pending);
    updateReviewStatus(pending, ctx);
    appendReviewEvent(repo, { event: "boundary_detected", head, decision: "start_review", lanes: review.lanes, trigger });
    ctx.ui.notify(`PR-boundary review required for ${basename(repo)} at ${head.slice(0, 12)}. Lanes: ${review.lanes.join(", ")}.`, "warning");
    await spawnReviewLanes(pending, { ...pr, headRefOid: head }, initialLanes, ctx, trigger);
    return true;
  }

  // Durable fallback for a missed PR-boundary event (REQ-AGENT-058 AC1). The onToolEnd boundary
  // path depends on capturing a single tool event; a compound `&&` command, a here-doc body, or
  // a reload between the command and its event can drop it. On lifecycle ticks this re-derives
  // state from GitHub: if an OPEN, non-draft, ENFORCED main/master PR has an unacknowledged head
  // with no review window and no open breaker, start the review. The decision is the pure
  // shouldReconcileOpenPr; genuine near-misses (breaker-latched, unresolvable head) are logged as
  // boundary_candidate_ignored so a stuck PR is never silent (AC4). `force` bypasses the network
  // throttle for once-per-turn ticks. Returns true when a window was created or acked.
  async function reconcileOpenPrReview(ctx: any, force: boolean): Promise<boolean> {
    const repo = findGitRoot(ctx.sessionManager.getCwd()) || activeRepoFallback();
    const nowTs = Date.now();
    const lifecycle = shouldCheckOpenPrReconciliation({
      activeRun: isActiveRun(),
      hasRepo: Boolean(repo),
      sddProject: repo ? isSddProject(repo) : false,
      pendingSameRepo: Boolean(repo && pending && pending.repo === repo),
      throttled: !force && nowTs - lastReconcileCheckAt < RECONCILE_THROTTLE_MS,
    });
    if (!lifecycle.check) return false;
    lastReconcileCheckAt = nowTs;

    const resolvedRepo = repo as string;
    const pr = prState(resolvedRepo);
    const enforced = isEnforcedPr(pr);
    const head = enforced ? resolveEnforcedHead(resolvedRepo, pr) : "";
    const durableJob = head ? readDurableReviewJob(resolvedRepo, head) : undefined;
    const decision = shouldReconcileOpenPr({
      prOpen: pr?.state === "OPEN",
      prDraft: pr?.isDraft === true,
      enforced,
      head,
      acked: head ? acked(resolvedRepo, head) : false,
      hasReviewJob: (loadPending(resolvedRepo)?.head === head) || Boolean(durableJob),
      reviewActive: durableJob?.status === "running",
      breakerOpen: head ? isBreakerOpen(resolvedRepo, head) : false,
    });
    if (!decision.reconcile) {
      // Log only genuine near-misses, not healthy outcomes (window exists / acked / not a PR).
      if (decision.reason === "review breaker open for head" || decision.reason === "no resolvable enforced head") {
        appendReviewEvent(resolvedRepo, { event: "boundary_candidate_ignored", head, reason: decision.reason });
      }
      return false;
    }
    appendReviewEvent(resolvedRepo, { event: "boundary_reconciled", head, reason: decision.reason });
    ctx.ui.notify(`PR-boundary review reconciled for ${basename(resolvedRepo)} at ${head.slice(0, 12)} (missed boundary event recovered).`, "warning");
    return ensureReviewWindow({ repo: resolvedRepo, pr: pr as PrState, head, ctx, trigger: "open-PR reconciliation" });
  }

  const onAgentStart = (event: any, ctx: any) => {
    if (!isActiveRun()) return;
    remember(ctx);
    const toolName = String(event?.toolName || "").toLowerCase();
    const input = event?.input || event?.params || event?.args || event?.arguments || {};
    const command = commandText(event);
    // commandText() pulls the command from bash (input.command) or, when context-mode is on,
    // the ctx_* tools (code/commands). Gate on the command itself, never the tool name.
    if (isGhPrMerge(command)) {
      const repo = findGitRoot(cwdFromCommand(command) || ctx.sessionManager.getCwd()) || activeRepoFallback();
      if (!repo || !isSddProject(repo)) return;
      const pr = prState(repo);
      if (!isEnforcedPr(pr)) return;
      const head = pr.headRefOid;
      if (consumeBypass()) {
        acknowledgeBypass(repo, head, ctx);
        return;
      }
      if (!acked(repo, head)) {
        appendReviewEvent(repo, { event: "merge_blocked", head, reason: "head_not_acked" });
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
    if (state && reviewHeadStatus(state) === "advanced") { void rollForwardAdvancedReview(state, ctx, "session_start detected advanced PR head"); return; }
    refreshReviewStatusFromDurable(ctx);
    // Catch a boundary missed before this session started (forced: once per session start).
    void reconcileOpenPrReview(ctx, true);
  });

  const onUiRefresh = (_event: any, ctx: any): void => {
    if (!isActiveRun()) return;
    remember(ctx);
    refreshReviewStatusFromDurable(ctx);
    // Throttled catch-up for a missed boundary on every UI/turn tick (REQ-AGENT-058).
    void reconcileOpenPrReview(ctx, false);
  };

  pi.on("resources_discover", onUiRefresh);
  pi.on("turn_start", onUiRefresh);
  pi.on("turn_end", onUiRefresh);

  pi.on("tool_call", onAgentStart);
  pi.on("tool_execution_start", (event: any, ctx: any) => {
    const id = toolEventId(event);
    if (id) toolStartArgs.set(id, event?.args || event?.input || event?.params || event?.arguments || {});
    return onAgentStart(event, ctx);
  });

  const onToolEnd = async (event: any, ctx: any) => {
    if (!isActiveRun()) return;
    remember(ctx);
    const toolName = String(event?.toolName || "").toLowerCase();
    if (isFailedToolExecution(event)) return;

    if (toolName === "agent") {
      const input = event?.input || event?.params || event?.args || event?.arguments || {};
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
    if (!isPrBoundaryTrigger(command)) {
      // PR-URL fallback (REQ-AGENT-058 AC5): a `gh pr create` can print the new PR URL even when
      // its command text was not recognized as a boundary trigger (compound `&&`, here-doc body,
      // or a wrapper script). When a pr-create-shaped command emits a PR URL we did not parse as
      // a boundary, record the near-miss and let the bounded open-PR reconciliation start the
      // review. Gated on /pr create/ so read-only gh commands (pr view/list) never trigger it.
      if (/pr\s+create/i.test(command) && prUrlFromText(stringifyReviewResult(toolResultPayload(event)))) {
        const repo = findGitRoot(cwdFromCommand(command) || ctx.sessionManager.getCwd()) || activeRepoFallback();
        if (repo && isSddProject(repo)) {
          appendReviewEvent(repo, { event: "boundary_candidate_ignored", reason: "pr_create_url_not_parsed" });
          await reconcileOpenPrReview(ctx, true);
        }
      }
      return;
    }

    const repo = findGitRoot(cwdFromCommand(command) || ctx.sessionManager.getCwd()) || activeRepoFallback();
    if (!repo || !isSddProject(repo)) return;

    const pr = prForBoundaryCommand(repo, command, prState(repo));
    if (!isEnforcedPr(pr)) return;
    const head = reviewCandidateHead(repo, pr, command);
    if (!head) return;
    if (consumeBypass()) {
      acknowledgeBypass(repo, head, ctx);
      return;
    }
    if (acked(repo, head)) return;
    if (isBreakerOpen(repo, head)) return; // breaker already gave up on this exact head; push a new commit to retry
    if (loadPending(repo)?.head === head) return; // a window for this head already exists
    if (!shouldProcessPrBoundaryToolEnd(toolEventId(event), true)) return;
    await ensureReviewWindow({ repo, pr, head, ctx, trigger: "initial PR-boundary trigger", command });
  };

  // Pi emits both `tool_result` and `tool_execution_end` for the same tool call.
  // PR-boundary command handling has side effects (pending-state creation,
  // warnings, and automatic reviewer spawns), so that command path is deduped by
  // tool-call ID. Agent-result handling remains idempotent for foreground/manual
  // fallback lanes, but normal PR-boundary dispatch no longer depends on prompts
  // asking the assistant to call the Agent tool.
  pi.on("tool_result", (event: any, ctx: any) => onToolEnd(withStartArgs(event), ctx));
  pi.on("tool_execution_end", (event: any, ctx: any) => onToolEnd(withStartArgs(event), ctx));

  // Durable lane completions are reconciled on-turn from disk (the agent_end reconciler
  // below + refreshReviewStatusFromDurable on turn_start/turn_end/resources_discover),
  // each with the fresh live ctx Pi hands the handler. The old pi.events.on(LANE_*)
  // bus bridge — which leaked one stale closure per /reload and fired markCompleted with
  // a fabricated/stale ctx (assertActive() throw → the console flood) — is deleted. There
  // is no off-turn handler left that needs a ctx.

  pi.on("agent_end", async (_event, ctx) => {
    if (!isActiveRun()) return;
    remember(ctx);
    const state = hydratePending(ctx);
    if (!state) {
      // No persisted review window: a real open, enforced PR with an unacked head and no
      // review job is a missed boundary. Let bounded reconciliation decide; otherwise just
      // publish any final summary and clear status.
      if (await reconcileOpenPrReview(ctx, true)) return;
      clearReviewStatus(ctx);
      publishSummaryForCurrentPr(ctx);
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

    const activeHead = bypassAckHeadForStatus({
      status: headStatus,
      pendingHead: state.head,
      currentHead: headStatus === "advanced" ? currentEnforcedPrHead(state.repo) : undefined,
    });
    if (!activeHead) { pending = undefined; return; }
    if (isBreakerOpen(state.repo, activeHead)) { pending = undefined; return; } // latched: do no further work for this head
    if (acked(state.repo, activeHead)) {
      publishFinalSummaryIfReady(state.repo, activeHead, ctx);
      clearPending(state.repo);
      pending = undefined;
      return;
    }
    if (consumeBypass()) {
      acknowledgeBypass(state.repo, activeHead, ctx);
      return;
    }
    if (headStatus === "advanced") {
      await rollForwardAdvancedReview(state, ctx, "agent_end detected advanced PR head");
      return;
    }

    const currentState = loadPending(state.repo) || state;
    // Reap detached lane children from disk before reading lane state: any lane that
    // emitted agent_end, died, or blew its budget transitions running → completed/failed
    // here, so the completion/failure/eligible checks below act on fresh facts. This is
    // what advances the state machine each turn (detached children write their result;
    // the reaper, in whatever session ticks next, finalizes it — no in-process callback).
    reapDurableReviewLanes(currentState.repo, currentState.head);
    for (const lane of completedDurableReviewLanes(currentState.repo, currentState.head, currentState.lanes)) {
      if (!currentState.completed.has(lane)) {
        await markCompleted(lane, ctx);
        return;
      }
    }

    const running = runningDurableReviewLanes(currentState.repo, currentState.head, currentState.lanes)
      .filter((lane) => !currentState.completed.has(lane));
    if (running.length > 0) {
      updateReviewStatus(currentState, ctx);
      return;
    }

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
      appendReviewEvent(currentState.repo, { event: "breaker_opened", head: currentState.head, attempts });
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
