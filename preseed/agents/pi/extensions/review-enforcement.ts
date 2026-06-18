/**
 * Codeflare Pi PR-boundary review enforcement.
 *
 * Native Pi counterpart to Claude Code's PR-boundary review hooks. It watches pushes / PR creation /
 * PR merges for SDD projects with an open PR to main/master, computes the minimal required review
 * lanes, spawns Pi subagents for only those lanes, persists progress under .git/, and acknowledges the
 * PR head after the required lanes complete or after an explicit user bypass.
 *
 * ── WHY THIS FILE IS THE WAY IT IS (read before changing anything) ───────────────────────────────
 *
 * GUIDING PRINCIPLE: `gh pr view` is the unmistakable, authoritative signal. The shell-command regexes
 * (review-helpers) are only a LOOSE accelerator to notice "a boundary probably just happened" — they
 * are allowed to miss. Correctness comes from reconciling against `gh pr view`, never from the regex.
 * Hence two layers: (1) the onToolEnd FAST PATH arms a window immediately when it recognises a push/
 * create; (2) the RECONCILE backstop (reconcileOpenPrReview) runs on every turn tick + session_start +
 * agent_end, queries `gh pr view`, and recovers any boundary the fast path missed. Never delete the
 * reconcile layer to "simplify" — it is the part that actually makes detection reliable.
 *
 * LIFECYCLE (one head's journey):
 *   onToolEnd sees a boundary command ──┐
 *   reconcile sees an open enforced PR ─┴─▶ ensureReviewWindow(repo, head)
 *     → classify diff into lanes (code/spec/doc) → startDurableReviewLanes spawns DETACHED
 *       `pi --mode json` child processes that write transcripts + result files under .git/
 *     → reaper (refreshReviewStatusFromDurable on-turn, autonomousReviewReaperTick off-turn) is
 *       PURELY DISK-DRIVEN: it distils each lane transcript, transitions running→completed/failed,
 *       and can finalize a lane a now-exited session spawned
 *     → when all required lanes have results → finalizeCompletedReview → writeAck(head)
 *   The merge gate (onAgentStart, `gh pr merge`) blocks until acked(head). Only writeAck opens it.
 *   A missed boundary that reconcile finds either AUTOSTARTS (we pushed this session) or OFFERS
 *   (inherited head — fresh clone/relaunch/checkout) and stays merge-blocking until /review-run|/skip.
 *
 * STATE TIERS — the single most important thing to get right here. Pi 0.79.1's loader
 * (createJiti, moduleCache:false) gives EACH extension its own module instance AND re-instantiates a
 * module on reload (e.g. /ctx on|off). So:
 *   • module-local (`const x = new Map()` at top level): LOST on reload, and NOT shared with other
 *     extensions. Only safe when loss is harmless because disk is the source of truth (e.g. the
 *     toolStartArgs enrichment cache, the bounded once-trackers — a window-exists disk check covers a
 *     reset). Never store a load-bearing cross-tick/cross-extension fact here.
 *   • globalThis[Symbol.for(...)]: survives reload within one OS process, resets on a NEW process.
 *     This is the ONLY cross-extension + cross-reload channel, and "one OS process" is exactly the
 *     lifetime of "this Pi session". Used for: reviewBaselineMemory (per repo+branch session baseline),
 *     boundaryActedMemory (did we push this branch this session — the autostart signal),
 *     offerSurfacedMemory (offer dedup per session), prCache (gh pr view cache), the sendMessage patch
 *     registry, the enforcement runToken, the reaper timer handle, and (in review-job-helpers) the
 *     reviewRepo / activeRepo memory.
 *   • disk under .git/: survives process restart — the durable source of truth. ack head, pending.json
 *     (the active window), breaker + block-count, durable job/lane records + transcripts, public result
 *     files, and the codeflare-review-events.jsonl audit log.
 *   Rule of thumb: if a fact must survive a reload but reset per session → globalThis. If it must
 *   survive a process restart → disk. If losing it is harmless → module-local. Putting a fact in the
 *   wrong tier is how this subsystem has historically broken (offer-not-shown, autostart-vs-offer
 *   flips, footer dropping the repo).
 */

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { ALL_REVIEW_LANES, bypassAckHeadForStatus, classifyReviewFiles, classifyReviewHead, commandTextFromEvent, createReadyOnceTracker, cwdFromBoundaryCommand, enforcedHeadDecision, extractBackgroundAgentId, isFailedToolExecution, isGhPrMergeCommand, isGitPushOnlyCommand, isPrBoundaryTrigger, mergeCommandTarget, postCommandReconcileDecision, prBoundaryCommandBase, prEnforcedForPush, prUrlFromText, reusablePendingReview, selectReviewBase, type ReviewHeadStatus, type ReviewSpawnRequest } from "./review-helpers";
import { actionableReviewCount, activeRepoCandidateForReview, announcementReconcileDecision, compactDurableReviewStatus, countReviewSeverities, durableReviewAckReady, durableReviewEligibleLanes, durableReviewInitialLanes, durableReviewRecommendation, formatMergedReviewSummary, mergeGateDecision, requestReviewAutofixForRows, reviewAnnouncementNonce, reviewAutofixModeFromUserMessages, shouldAttemptAnnouncement, shouldCheckOpenPrReconciliation, shouldReconcileOpenPr, reconcileBoundaryAction, reviewInSessionContinuation, resolveReviewRepo, rememberReviewRepo, recallReviewRepo, recallReviewRepos, recallActiveRepo, rememberActiveRepo, type DurableReviewSummaryRecord, type DurableReviewSummaryRow, type ReviewAnnouncement, type ReviewSeverityCounts } from "./review-job-helpers";
import { abandonDurableReviewLanes, appendReviewEvent, completedDurableReviewLanes, ensureReviewAnnouncementPending, failedDurableReviewLanes, readDurableReviewJob, readReviewAnnouncement, reapDurableReviewLanes, reviewAnnouncementKinds, reviewJobDir, reviewResultPath, reviewResultsDir, runningDurableReviewLanes, safeWriteText, startDurableReviewLanes, writeReviewAnnouncement } from "./review-jobs";

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
// Per-repo enforced head observed when THIS Pi session first reconciled (≈ session start).
// In-memory only (never persisted): a head present at launch is not an in-session push, so it
// must offer, not auto-start. Only a head that later advances beyond this baseline is treated
// as in-session continuation (a dropped on-tool-end push) and auto-starts. Process-scoped so a
// fresh `pi` launch always re-baselines and offers — restoring the offer-on-start behavior.
// ── Per-session "did THIS session advance the head?" memory (REQ-AGENT-058) ──────────────────────
// All three stores below live on globalThis under Symbol.for keys, NOT module-local `let`/`Map`/`Set`.
// This is load-bearing: Pi 0.79.1's loader (createJiti, moduleCache:false) re-instantiates this whole
// module on reload (e.g. /ctx on|off), which would silently RESET module-local state mid-session and
// lose the in-session-push signal — so the reconcile would OFFER a head it should AUTOSTART. globalThis
// is the only channel that survives a reload within the same OS process, and resets cleanly on a new
// process (a genuinely fresh `pi` launch), which is exactly the lifetime we want for "this session".
//
// reviewBaselineMemory: the per-session reconcile baseline = the head this session first observed on a
// branch. Keyed by repo+BRANCH (see baselineKey) — repo-only keying was the bug: advancing it on ack
// then checking out a descendant branch made a mere checkout look like an in-session advance and autostart.
const REVIEW_BASELINE_KEY = Symbol.for("codeflare.reviewSessionBaselineHead");
function reviewBaselineMemory(): Map<string, string> {
  const g = globalThis as unknown as Record<symbol, Map<string, string> | undefined>;
  if (!g[REVIEW_BASELINE_KEY]) g[REVIEW_BASELINE_KEY] = new Map<string, string>();
  return g[REVIEW_BASELINE_KEY]!;
}
// baselineKey scopes the per-session signals to repo+current-branch. A `git checkout` to another branch
// produces a different key, so its inherited head starts fresh (baseline === head → OFFER), which is the
// whole point of the branch keying. The fields are joined with a NUL (\u0000) byte — which can appear in
// neither a filesystem path nor a git refname — so no other (repo, branch) pair can ever collapse to the
// same key string. These keys are opaque equality keys, never parsed back apart. NOTE: many editors and
// file viewers render the NUL as blank or a space, so the separator LOOKS like a space in the source — it
// is a real \u0000. Every key builder in this module (baselineKey, the offer keys, the ignore-dedup key)
// uses the same NUL separator for the same reason; don't "fix" one to a literal space.
function baselineKey(repo: string): string {
  return `${repo} ${currentBranch(repo) ?? ""}`;
}
// boundaryActedMemory: the PRIMARY autostart signal — the set of repo+branch keys for which a real
// PR-boundary command (push / pr create / …) executed THIS session. Set in onToolEnd BEFORE any
// window-creation guard (so a dropped window still records the fact), read by the reconcile to decide
// AUTOSTART (we pushed) vs OFFER (inherited head, no boundary command ran this session).
const BOUNDARY_ACTED_KEY = Symbol.for("codeflare.reviewBoundaryActedThisSession");
function boundaryActedMemory(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  if (!g[BOUNDARY_ACTED_KEY]) g[BOUNDARY_ACTED_KEY] = new Set<string>();
  return g[BOUNDARY_ACTED_KEY]!;
}
// boundaryActedKey: repo+branch key for the "this session pushed" signal, built with the SAME NUL
// separator as baselineKey (via String.fromCharCode(0), so this source line carries no embedded NUL).
// The MARK (onToolEnd) is keyed by the PUSHED PR's branch and the READ (reconcile) by the CURRENT
// branch. In the normal flow they are the same branch; `git push A && git checkout B` makes them differ,
// and keying the mark by the pushed branch — NOT currentBranch-at-tool-end, which is already B — is what
// stops B's merely-inherited head from being wrongly auto-started (R6).
function boundaryActedKey(repo: string, branch: string | undefined): string {
  return `${repo}${String.fromCharCode(0)}${branch ?? ""}`;
}
function markBoundaryActed(repo: string, branch?: string): void {
  if (repo) boundaryActedMemory().add(boundaryActedKey(repo, branch ?? currentBranch(repo) ?? ""));
}
function boundaryActedThisSession(repo: string): boolean {
  return boundaryActedMemory().has(boundaryActedKey(repo, currentBranch(repo) ?? ""));
}
// clearBoundaryActed spends the explicit "this session pushed" signal after a head is acked. The
// branch baseline remains active for the whole session, so a later descendant head still autostarts if a
// fix-push tool event is lost; a fresh Pi process still offers inherited heads because it re-baselines to
// the current PR head on first observation.
function clearBoundaryActed(repo: string, branch?: string): void {
  boundaryActedMemory().delete(boundaryActedKey(repo, branch ?? currentBranch(repo) ?? ""));
}
// offerSurfacedMemory: per-SESSION dedup for the missed-boundary offer. The offer must re-surface
// ONCE PER SESSION — a new `pi` started on a still-unchosen offer (the user quit without choosing) must
// see it again — but must not spam every reconcile tick within a session. Process-scoped (resets per
// process, survives reload) is exactly that lifetime. This replaced the old on-disk per-head-EVER marker,
// which suppressed the offer forever and was the "nothing offered, no question, nothing" user symptom.
const OFFER_SURFACED_KEY = Symbol.for("codeflare.reviewOfferSurfacedThisSession");
function offerSurfacedMemory(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  if (!g[OFFER_SURFACED_KEY]) g[OFFER_SURFACED_KEY] = new Set<string>();
  return g[OFFER_SURFACED_KEY]!;
}
function offerSurfacedThisSession(repo: string, head: string): boolean {
  return offerSurfacedMemory().has(`${repo} ${head}`);
}
function markOfferSurfaced(repo: string, head: string): void {
  offerSurfacedMemory().add(`${repo} ${head}`);
}
// reviewIgnoreLoggedMemory: per-session dedup for the "boundary candidate ignored" near-miss audit
// line. The reconcile tick runs every 20s; while a head sits behind a latched breaker (or has no
// resolvable enforced head) that SAME reason would otherwise be appended to the event log on every
// tick, burying the real signal under hundreds of identical rows. Keyed by repo+head+reason so each
// distinct near-miss is recorded ONCE per session; globalThis-backed so a reload doesn't reset the
// dedup and re-spam, and reset per process so a genuinely fresh launch logs the current state again.
const IGNORE_LOGGED_KEY = Symbol.for("codeflare.reviewIgnoreLoggedThisSession");
function reviewIgnoreLoggedMemory(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  if (!g[IGNORE_LOGGED_KEY]) g[IGNORE_LOGGED_KEY] = new Set<string>();
  return g[IGNORE_LOGGED_KEY]!;
}
function ignoreAlreadyLogged(repo: string, head: string, reason: string): boolean {
  const mem = reviewIgnoreLoggedMemory();
  const k = `${repo} ${head} ${reason}`;
  if (mem.has(k)) return true;
  mem.add(k);
  return false;
}

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
  /** The PR HEAD branch (pr.headRefName). Persisted so writeAck can clear/mark the boundary signal
   *  for the RIGHT branch even when an off-turn reaper finalizes while another branch is checked out. */
  headBranch?: string;
  head: string;
  reviewBase?: string;
  lanes: string[];
  completed: Set<string>;
  /** Vestigial: retained for pending.json backward-compat. doc-updater now dispatches in
   *  the initial parallel wave, so spec-reviewer completion no longer gates it. */
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

// The repo THIS Pi session is reviewing is remembered in the shared review-job-helpers module
// (rememberReviewRepo/recallReviewRepo), so BOTH the no-ctx autonomous reaper AND the
// local-statusline footer (a separate extension sharing the same module instance) recall the SAME
// value. Commandless reconciliation also has a guarded persisted fallback below: without it, a Pi
// session whose cwd is the parent workspace (`/home/user/workspace`) loses the nested repo after a
// reload/compaction/pending cleanup and never reaches the authoritative `gh pr view` truth layer.
const REVIEW_ACTIVE_REPO_FILE = "/home/user/.cache/codeflare-hooks/review-active-cwd";
const GRAPHIFY_ACTIVE_REPO_FILE = "/home/user/.cache/codeflare-hooks/graphify-active-cwd";

function activeRepoForReviewRouting(ctx: any): string | undefined {
  const sessionCwd = ctx?.sessionManager?.getCwd?.();
  const roots = [sessionCwd, ctx?.cwd, process.cwd()];
  const persistedSentinelContents = [REVIEW_ACTIVE_REPO_FILE, GRAPHIFY_ACTIVE_REPO_FILE].map((file) => {
    try { return readFileSync(file, "utf8"); } catch { return undefined; }
  });
  const repo = activeRepoCandidateForReview({
    rememberedActiveRepo: recallActiveRepo(),
    persistedSentinelContents,
    sessionRoots: roots,
    hasGitDir: (path) => existsSync(join(path, ".git")),
    hasSddProject: isSddProject,
  });
  if (repo) rememberActiveRepo(repo);
  return repo;
}

// Resolve + remember the review repo for a ctx-bearing handler: an explicit command cwd (`cd`/`-C`
// in the boundary command) first, then the Pi session's own cwd, then the repo remembered earlier
// this session (so a NESTED review clone still resolves when the session cwd is its parent
// workspace), then a guarded persisted active-repo fallback, then pi's process dir as a last resort.
function reviewRepoForCtx(ctx: any, commandCwd?: string): string | undefined {
  const sessionCwd = ctx?.sessionManager?.getCwd?.();
  // A boundary command's cwd (`cd <dir>` / `git -C <dir>`) can be RELATIVE. Resolve it against the
  // SESSION cwd (the shell's cwd when the command ran), NOT pi's process.cwd() — otherwise findGitRoot
  // walks up from the wrong directory and binds the WRONG repo (the parent workspace for a nested
  // clone), then poisons reviewRepo memory + prCache with a relative path whose meaning shifts with
  // process.cwd(). codeflare-pi.ts resolves the active-repo sentinel the same way.
  const resolvedCommandCwd = commandCwd && !isAbsolute(commandCwd)
    ? resolve(sessionCwd || process.cwd(), commandCwd)
    : commandCwd;
  const activeRepo = activeRepoForReviewRouting(ctx);
  const repo = resolveReviewRepo(
    { commandCwd: resolvedCommandCwd, sessionCwd, sessionReviewRepo: recallReviewRepo(), activeRepo, processCwd: process.cwd() },
    findGitRoot,
  );
  // Only PIN this repo as "the repo under review" when it actually has an active review window.
  // reviewRepoForCtx runs on every turn tick just to RESOLVE a repo; remembering unconditionally let a
  // bare `cd` to an unrelated repo steal the slot, so the no-ctx reaper followed the user's cwd instead
  // of the repo whose lanes are still running (its on-disk pending never reaped). The footer is
  // unaffected: its repo:branch label resolves via recallActiveRepo first, and its review row only
  // needs recallReviewRepo while a review is active — exactly when this still sets it.
  if (repo && loadPending(repo)) rememberReviewRepo(repo);
  return repo;
}

function commandText(event: any): string {
  return commandTextFromEvent(event);
}


function isGhPrMerge(command: string): boolean {
  // Same env-prefix-tolerant anchored regex as detection (review-helpers RE_GH_PR_MERGE), so the
  // merge gate can never be skipped by a form detection recognises, e.g. `GH_TOKEN=x gh pr merge`.
  return isGhPrMergeCommand(command);
}

function isSddProject(repo: string): boolean {
  return existsSync(join(repo, "sdd", "README.md"));
}

// gh pr view shells out on every boundary/reconcile/footer tick (many per turn). Cache it
// per-repo with an asymmetric TTL (60s OPEN / 10s negative), keyed on repo+branch so a
// checkout invalidates — faithful to git-push-review-reminder.sh's .git/sdd-pr-cache.
// Transient gh failures are NEVER cached (delete + re-query next call). Backed by globalThis
// because the boundary handler, no-ctx reaper, and statusline are separate jiti instances
// (moduleCache:false) that must share one cache.
const PR_CACHE_KEY = Symbol.for("codeflare.prCache");
type PrCacheEntry = { branch: string; pr: PrState | undefined; at: number };
function prCache(): Map<string, PrCacheEntry> {
  const g = globalThis as unknown as { [PR_CACHE_KEY]?: Map<string, PrCacheEntry> };
  if (!g[PR_CACHE_KEY]) g[PR_CACHE_KEY] = new Map();
  return g[PR_CACHE_KEY]!;
}

// Only ever interpolate sanitized selectors/slugs into the gh shell string. PR numbers, branch names,
// and owner/repo slugs all match this class; anything else is dropped (the query falls back to the cwd
// branch) so a crafted merge argument can't inject shell.
const safeGhArg = (s?: string): string | undefined => (s && /^[\w./#-]+$/.test(s) ? s : undefined);

// Distinguish a genuine "no PR" (gh exits 1: no pull request for this branch/selector) from a transient
// gh FAILURE (auth/network/rate-limit/timeout, exit 2/4/signal). Both collapsed to `undefined` before,
// so neither the push path nor the merge gate could tell "allow, there is no PR" from "fail closed, gh
// is down" (P4). `failed:true` = transient (never cache, fail-closed-eligible); `failed:false` +
// `pr:undefined` = real absence (cacheable negative, allow). An optional selector/repoSlug targets a
// specific PR (the one a `gh pr merge` command named) instead of the cwd branch (P1).
type PrStateResult = { pr: PrState | undefined; failed: boolean };
function prStateResultFor(repo: string, selector?: string, repoSlug?: string): PrStateResult {
  const sel = safeGhArg(selector) ? ` ${safeGhArg(selector)}` : "";
  const rep = safeGhArg(repoSlug) ? ` --repo ${safeGhArg(repoSlug)}` : "";
  try {
    // Do NOT redirect stderr here: the catch below must read gh's error TEXT to tell a genuine
    // "no such PR" from a transient outage. On success execFileSync returns only stdout, so gh's
    // success-path stderr (deprecation warnings etc.) is dropped harmlessly.
    const out = shell(`gh pr view${sel}${rep} --json number,state,baseRefName,headRefOid,headRefName,isDraft`, repo);
    return { pr: out ? JSON.parse(out) as PrState : undefined, failed: false };
  } catch (e) {
    // gh exits 1 for ALMOST EVERYTHING (verified in-container): a genuine "no pull requests found",
    // a non-existent PR/repo (GraphQL "Could not resolve…"), AND every realistic transient — DNS
    // failure, 401/403, 404, rate-limit. So the exit code ALONE cannot tell absence from outage; the
    // old `status !== 1` test left the fail-closed machinery unreachable for the common flakes, i.e.
    // the merge gate failed OPEN during any GitHub blip. Classify by the error TEXT: a definitive
    // GitHub "not found" response is genuine absence (allow); anything else with a non-zero exit is a
    // transient we could not read → `failed:true` → callers fail CLOSED. Default is fail-closed.
    const err = `${(e as { stderr?: unknown })?.stderr ?? ""}\n${(e as { message?: unknown })?.message ?? ""}`;
    const genuineAbsence = /no (open )?pull requests? found/i.test(err)
      || /could not resolve to a (pull ?request|repository)/i.test(err);
    return { pr: undefined, failed: !genuineAbsence };
  }
}

function prState(repo: string): PrState | undefined {
  const branch = currentBranch(repo) ?? "";
  const cache = prCache();
  const hit = cache.get(repo);
  if (hit && hit.branch === branch) {
    const ttl = hit.pr?.state === "OPEN" ? 60000 : 10000; // 60s OPEN, 10s negative
    if (Date.now() - hit.at < ttl) return hit.pr;
  }
  const res = prStateResultFor(repo);
  if (res.failed) { cache.delete(repo); return undefined; } // transient: never cache, re-query next call
  cache.set(repo, { branch, pr: res.pr, at: Date.now() });
  return res.pr;
}

// Cache-bypassing PR-state read for the merge gate: the gate is the last line of defense, so it must
// never decide on a head that the 60s prCache TTL has let go stale (a push after the cache was warmed
// leaves `headRefOid` pointing at an already-acked older head while GitHub merges the newer one).
// Returns the full result so the gate distinguishes unreadable (fail closed) from no-PR (allow), and
// can target the specific PR the merge command named. Only the cwd-branch read touches the cache.
function prStateFreshResult(repo: string, selector?: string, repoSlug?: string): PrStateResult {
  if (!selector && !repoSlug) prCache().delete(repo);
  return prStateResultFor(repo, selector, repoSlug);
}
function prStateFresh(repo: string): PrState | undefined {
  return prStateFreshResult(repo).pr;
}

// Every locally-known unacked head that independently REQUIRES review even when the target PR itself is
// unreadable or malformed — so the merge gate can fail closed on a transient gh failure (R2). The
// pending head is the obvious one, but two merge-blocking states carry NO pending.json: a latched
// breaker (review gave up but the head is still unreviewed) and an outstanding session offer.
function gateCandidates(repo: string): Array<{ head: string; acked: boolean }> {
  const seen = new Set<string>();
  const out: Array<{ head: string; acked: boolean }> = [];
  const add = (head: string | undefined): void => {
    if (head && !seen.has(head)) { seen.add(head); out.push({ head, acked: acked(repo, head) }); }
  };
  add(loadPending(repo)?.head);
  try { add(readFileSync(breakerPath(repo), "utf8").trim()); } catch { /* no breaker latched */ }
  // offerSurfacedMemory keys are `${repo}<NUL>${head}` — the separator below is a real   byte
  // (it may render as a blank); see baselineKey's note. Match it exactly to recover the offer heads.
  const prefix = `${repo} `;
  for (const k of offerSurfacedMemory()) if (k.startsWith(prefix)) add(k.slice(prefix.length));
  return out;
}

// Peek at the user-only bypass sentinel WITHOUT consuming it (consumeBypass deletes it). The gate
// decides on the peek, then consumes only when it actually bypasses, so a peek for an allow-anyway
// merge never burns the one-shot sentinel.
function bypassPending(): boolean {
  return existsSync(REVIEW_BYPASS);
}

// A durable job whose every lane is failed/abandoned (a superseded head's leftover) is NOT a live review
// window. Counting it as one makes shouldReconcileOpenPr noop forever when the user later checks that
// branch out again — head unacked, no pending, breaker closed, but hasReviewJob true — so the stuck PR
// never re-enters the offer/autostart decision and there is NO offer, toast, or audited near-miss (R9,
// the silent-skip). A job with ANY running or completed lane still counts as a real, in-flight window.
function durableJobIsActiveWindow(job: ReturnType<typeof readDurableReviewJob>): boolean {
  if (!job) return false;
  return job.lanes.some((lane) => {
    const status = job.laneState[lane]?.status;
    return status === "running" || status === "completed";
  });
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

// Push-path fail-open variant (git-push-review-reminder.sh:253-254): a real `git push`
// whose OPEN PR returned an EMPTY baseRefName (transient gh/jq edge) fails OPEN to
// enforcement — over-review rather than silently let an unreviewed PR-to-main slip on a
// parsing hiccup. Used ONLY on the actual-command onToolEnd boundary path (a user push/
// create just happened); there an empty base DOES arm review (the deliberate over-review).
// The merge gate and the autonomous reconcile tick keep the strict isEnforcedPr, so an empty
// base can never auto-open the merge gate or auto-start a review via the reconcile tick. Logic
// lives in review-helpers.ts::prEnforcedForPush (pure, unit-tested); this wraps it as a guard.
function isEnforcedPrForPush(pr: PrState | undefined): pr is Required<Pick<PrState, "headRefOid" | "state">> & PrState {
  return prEnforcedForPush(pr);
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

// writeAck records that the enforced PR head has passed review (or was explicitly skipped). The ack
// file is the SOLE thing that opens the merge gate — being merely "offered" never opens it. NOTE: this
// no longer advances the reconcile baseline. The autostart-vs-offer decision is driven by the
// boundaryActedThisSession signal + the per-branch baseline SEED (set on first observation in the
// reconcile), so the old "advance baseline to the acked head" step is both redundant and was a source
// of subtle autostart bugs (a descendant-branch checkout reading a baseline advanced by a prior branch's ack).
function writeAck(repo: string, head: string): void {
  safeWriteText(ackPath(repo), `${head}\n`);
  // Once a head is acked it is the only one that still matters for this branch, so drop every OTHER
  // head's lane-result directory under .git/sdd-review-results/. Without this, each new PR HEAD on a
  // long-lived branch leaves its result dir behind forever. writeAck is the single choke point every
  // finalize/skip path funnels through, so pruning here keeps exactly the current head and nothing else.
  pruneReviewResults(repo, head);
  // Acking spends this branch's explicit "this session pushed" signal. The branch baseline is NOT spent:
  // if a follow-up fix push loses its tool event, the descendant baseline must still autostart durable
  // review lanes instead of degrading to a passive offer.
  const ackBranch = loadPending(repo)?.headBranch ?? currentBranch(repo);
  clearBoundaryActed(repo, ackBranch);
}

// The "offered" dedup that used to live here as an on-disk per-head-EVER marker now lives in the
// process-scoped offerSurfacedMemory (see the per-session memory block near the top). The disk marker
// was removed deliberately: it suppressed the merge-blocking offer forever, so a new session on a
// still-unchosen PR saw nothing — the "nothing offered, no question, nothing" symptom. Being offered
// still does NOT open the merge gate; only an explicit ack/skip (writeAck) does.

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
  safeWriteText(path, String(count));
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
  safeWriteText(breakerPath(repo), `${head}\n`);
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

// Prune the durable per-head artifacts for SUPERSEDED ancestors of keepHead — the lane RESULTS under
// .git/sdd-review-results/<head>/ AND the larger job dirs (full --mode json transcripts, prompts) under
// .git/codeflare-review-jobs/<head>/. Two guards make the recursive rmSync safe:
//   1. SHA-shape: every dir here is named by a commit head, so a future non-SHA artifact is never deleted.
//   2. ANCESTOR-of-keepHead: only heads on keepHead's OWN line of history are pruned. A dir for a head
//      that is NOT an ancestor of keepHead is a SIBLING PR branch's review (completed but not yet
//      finalized) — deleting it would force that branch to re-review (R4), so it is LEFT ALONE. keepHead
//      itself is always kept. The dominant growth case (many sequential heads on one long-lived branch,
//      each an ancestor of the next) IS pruned; a force-pushed/orphaned head git can't resolve is kept
//      (the safe direction — a small bounded leak rather than a wrong delete). Best-effort; never throws.
function pruneReviewResults(repo: string, keepHead: string): void {
  for (const sub of ["sdd-review-results", "codeflare-review-jobs"]) {
    try {
      const base = join(repo, ".git", sub);
      for (const entry of readdirSync(base)) {
        if (entry === keepHead || !/^[0-9a-f]{7,40}$/.test(entry)) continue;
        if (!isAncestor(repo, entry, keepHead)) continue; // sibling branch / unresolvable head: keep
        rmSync(join(base, entry), { recursive: true, force: true });
      }
    } catch { /* best effort: dir may not exist yet */ }
  }
}

function loadPending(repo: string): PendingReview | undefined {
  try {
    const state = JSON.parse(readFileSync(pendingPath(repo), "utf8")) as { prNumber?: number; baseRefName?: string; headBranch?: string; head?: string; reviewBase?: string; lanes?: string[]; completed?: string[]; docPromptSent?: boolean; spawned?: boolean; spawnedIds?: Record<string, string>; fallbackLanes?: string[]; requestedAt?: Record<string, number>; reviewStartedAt?: number; spawnedAt?: number };
    if (!state.head || !state.baseRefName || !Array.isArray(state.lanes)) return undefined;
    const completed = new Set([
      ...(state.completed || []),
      ...completedDurableReviewLanes(repo, state.head, state.lanes),
    ]);
    return { repo, prNumber: state.prNumber, baseRefName: state.baseRefName, headBranch: state.headBranch, head: state.head, reviewBase: state.reviewBase, lanes: state.lanes, completed, docPromptSent: Boolean(state.docPromptSent), spawned: Boolean(state.spawned), spawnedIds: state.spawnedIds || {}, fallbackLanes: new Set(state.fallbackLanes || []), requestedAt: state.requestedAt || {}, reviewStartedAt: state.reviewStartedAt || state.spawnedAt || Date.now(), spawnedAt: state.spawnedAt };
  } catch {
    return undefined;
  }
}

function savePending(pending: PendingReview): void {
  safeWriteText(pendingPath(pending.repo), JSON.stringify({ prNumber: pending.prNumber, baseRefName: pending.baseRefName, head: pending.head, headBranch: pending.headBranch, reviewBase: pending.reviewBase, lanes: pending.lanes, completed: [...pending.completed], docPromptSent: pending.docPromptSent, spawned: pending.spawned, spawnedIds: pending.spawnedIds, fallbackLanes: [...pending.fallbackLanes], requestedAt: pending.requestedAt, reviewStartedAt: pending.reviewStartedAt, spawnedAt: pending.spawnedAt }) + "\n");
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

// Normalize a repo reference (a remote URL, OWNER/REPO, or HOST/OWNER/REPO) to lowercase OWNER/REPO.
function normalizeRepoSlug(slug: string): string {
  const parts = slug.replace(/\.git$/i, "").split("/").filter(Boolean);
  return parts.slice(-2).join("/").toLowerCase();
}
// True when a `gh pr merge --repo <slug>` names a DIFFERENT repository than the cwd repo's origin.
// The per-repo ack/breaker state under .git/ belongs to the cwd repo; a foreign target's head can
// never be acked here, so both the merge gate and the retroactive audit must skip it (else a
// legitimate foreign merge false-BLOCKS and false-ALARMS). Unresolvable origin → false (gate
// normally; never skip enforcement when we cannot prove the target is foreign).
function isForeignRepoTarget(repo: string, targetSlug: string): boolean {
  let origin: string | undefined;
  try {
    const m = shell("git remote get-url origin", repo).match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
    origin = m ? normalizeRepoSlug(m[1]) : undefined;
  } catch { origin = undefined; }
  return origin ? normalizeRepoSlug(targetSlug) !== origin : false;
}

function isLocalGitPushCommand(command: string): boolean {
  // Same env-prefix/global-opts-tolerant anchored regex as detection (review-helpers RE_GIT_PUSH),
  // so head resolution takes the local-HEAD branch for forms like `GIT_SSH_COMMAND='…' git push`.
  return isGitPushOnlyCommand(command);
}

function isGitPushCommand(command: string): boolean {
  return isLocalGitPushCommand(command) || /(^|[;&|\n]\s*)gh\s+repo\s+sync\b/.test(command);
}

function prForBoundaryCommand(repo: string, command: string, pr: PrState | undefined): PrState | undefined {
  if (isEnforcedPr(pr)) return pr;
  const base = prBoundaryCommandBase(command, pr?.baseRefName);
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

// The path to this session's transcript file, captured whenever a ctx-bearing handler runs. The
// idle reaper has NO ctx but still needs to read the user's messages — specifically to honour an
// explicit "don't auto-fix, wait for my go" instruction before it fires an autofix turn off-turn.
// Stored on globalThis for the usual reason: survive a reload, reset per process (this session).
const SESSION_FILE_KEY = Symbol.for("codeflare.reviewSessionFilePath");
function rememberSessionFile(ctx: any): void {
  const file = ctx?.sessionManager?.getSessionFile?.();
  if (typeof file === "string" && file) (globalThis as Record<symbol, unknown>)[SESSION_FILE_KEY] = file;
}
function recallSessionFile(): string | undefined {
  const file = (globalThis as Record<symbol, unknown>)[SESSION_FILE_KEY];
  return typeof file === "string" ? file : undefined;
}

function sessionUserMessages(ctx: any): string[] {
  try {
    // Fall back to the remembered path so this works ctx-free for the idle reaper.
    const file = ctx?.sessionManager?.getSessionFile?.() ?? recallSessionFile();
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

// Proof-of-delivery for a review announcement: a custom message persists into the session transcript
// ONLY when the agent session emits its `message_end` event (never from an off-turn send or a stale
// sender), so a nonce embedded in the message appears in the JSONL iff it actually reached the live
// session. Scan the raw transcript (ctx-bearing path, or the remembered file for the idle reaper).
function sessionContainsNonce(ctx: any, nonce: string): boolean {
  if (!nonce) return false;
  try {
    const file = ctx?.sessionManager?.getSessionFile?.() ?? recallSessionFile();
    if (!file || !existsSync(file)) return false;
    // Match the full delivery sentinel, not the bare nonce: the autofix-request CONTENT is a prompt the
    // agent could quote the nonce back from, which would falsely mark the announcement delivered. The
    // sentinel form only lands in the JSONL when our custom message actually persisted.
    return readFileSync(file, "utf8").includes(`<!-- cf-review-delivery ${nonce} -->`);
  } catch {
    return false;
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
  // Suppress ONLY the deprecated summary customTypes (v1/v2). v3 delivery dedupe is now owned by the
  // durable announcement state machine (nonce + `visible` status); the old in-memory key Set lived on
  // globalThis and survived reloads, so it could suppress a re-send the state machine still needed.
  type PatchedSend = ((message: any, options?: any) => void) & { __codeflareReviewPatched?: boolean };
  const piAny = pi as unknown as { sendMessage?: PatchedSend };
  const current = piAny.sendMessage;
  if (!current) return;
  if (current.__codeflareReviewPatched) return; // our patch is already installed on THIS sender
  // Bind the CURRENT sender. The old code resurrected `originalSendMessage` from a reload-surviving
  // WeakMap, so after a Pi reload it could call a STALE bound function from a previous session's
  // internals — one that returns cleanly but writes nothing (the exact no-op that stranded review
  // results). Binding the live sender at install time, and re-wrapping any fresh post-reload sender,
  // means delivery always targets the active session.
  const original = current.bind(pi);
  const patched: PatchedSend = (message: any, options?: any): void => {
    const customType = String(message?.customType || "");
    if (customType === "pr-boundary-review-result" || customType === "pr-boundary-review-summary" || customType === "codeflare-review-summary-v2") return;
    original(message, options);
  };
  patched.__codeflareReviewPatched = true;
  piAny.sendMessage = patched;
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
  // Arm the same durable delivery announcements the pi-bound finalize would, so a review the
  // disk-only fallback acked is still delivered+verified on the next live tick (never stranded).
  const stamp = Date.now();
  ensureReviewAnnouncementPending(state.repo, state.head, "summary", reviewAnnouncementNonce("summary", state.head, stamp), stamp);
  appendReviewEvent(state.repo, { event: "summary_announcement_pending", head: state.head });
  if (reviewSummaryRecordsFromDisk(state).some((record) => actionableReviewCount(record.counts) > 0)) {
    ensureReviewAnnouncementPending(state.repo, state.head, "autofix", reviewAnnouncementNonce("autofix", state.head, stamp), stamp);
    appendReviewEvent(state.repo, { event: "autofix_announcement_pending", head: state.head });
  }
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
// finalizes completed reviews (emit summary + autofix via the pi-bound closure), and re-spawns any
// *fresh* eligible lane that is not yet running (all lanes are eligible from the start now — no
// ordering). Failed-lane RETRIES are intentionally left
// to the on-turn driver so the breaker still bounds them. Best-effort and self-clearing:
// it must never throw.
function autonomousReviewReaperTick(): void {
  // P6: reap EVERY repo this session armed/reconciled a review for, not just the last-pinned slot, so two
  // repos with concurrent pending reviews both finalize without the user returning to each. The timer has
  // no event ctx, so it relies on the in-session review-repo memory (set by reviewRepoForCtx); NOT the
  // graphify active-cwd sentinel (it flaps under concurrent agents). Fall back to the single resolved repo
  // when nothing is remembered yet (first tick, or a process restart in a non-repo parent cwd).
  const remembered = recallReviewRepos();
  const repos = remembered.length > 0
    ? remembered
    : (() => {
        const r = resolveReviewRepo({ sessionReviewRepo: recallReviewRepo(), activeRepo: recallActiveRepo(), processCwd: process.cwd() }, findGitRoot);
        return r ? [r] : [];
      })();
  for (const repo of repos) reapOneReviewRepo(repo);
}

function reapOneReviewRepo(repo: string): void {
  try {
    const pending = loadPending(repo);
    if (!pending || !pending.head || pending.lanes.length === 0) return;
    reapDurableReviewLanes(pending.repo, pending.head);
    const completed = completedDurableReviewLanes(pending.repo, pending.head, pending.lanes);
    if (completed.length === pending.lanes.length) {
      // Idle finalization with no ctx: the pi-bound closure (set by the default export) arms the durable
      // delivery announcements (summary + autofix) and attempts a send, but off-turn it cannot PROVE
      // delivery — the next ctx-bearing tick (refreshReviewStatusFromDurable / agent_end →
      // drainReviewAnnouncements) verifies the nonce landed in the transcript and retries if absent, so an
      // idle completed review reliably surfaces with zero user input (the user can ESC to decline the fix;
      // /review-results is the manual fallback). Disk-only ack is the fallback before the closure is bound.
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
    // Never throw — one repo's transient fs/spawn error must not skip the other repos or crash the timer.
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
  // Per-turn dedup for the merge gate, which is wired to both tool_call and tool_execution_start — see
  // the once-gate in onAgentStart. Cleared at agent_end (turn boundary) alongside toolStartArgs.
  const mergeGatedToolIds = new Set<string>();
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
    rememberSessionFile(ctx);
  };

  // Pending state may only be discarded when the PR has DEFINITIVELY moved on
  // (reviewHeadStatus === "stale"), and always with a visible warning. An
  // indeterminate "unknown" (gh query failed) must preserve state and retry, so
  // a transient failure can never silently drop the review gate without an ack.
  const discardStale = (state: PendingReview, ctx: any): void => {
    // Kill this head's still-running lane children BEFORE dropping the pending record. After
    // clearPending the head is unreachable to the reaper (reaping is keyed to the live pending
    // head), so any detached `pi --mode json` lane still running would orphan forever on the
    // resource-constrained box — the same pileup the supersede/roll-forward paths kill. A force-push or a
    // PR retarget/close is exactly when this fires. Only `running` lanes are touched.
    abandonDurableReviewLanes(state.repo, state.head);
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
    // Roll-forward builds the new window directly (not via ensureReviewWindow), so it must ALSO kill the
    // old head's still-running lane children here (R3) — otherwise an in-session descendant advance leaks
    // them. Only `running` lanes are touched; the completed ones' results are reused by mergeLaneState below.
    abandonDurableReviewLanes(state.repo, state.head);

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
      headBranch: currentPr.headRefName,
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

  // withStartArgs re-attaches the args captured at tool_execution_start (toolStartArgs, set per tool id)
  // to the END event, because some end-event shapes drop the command text we need for boundary detection.
  function withStartArgs(event: any): any {
    const id = toolEventId(event);
    const cached = id ? toolStartArgs.get(id) : undefined;
    // The start-args cache is CONSUME-ONCE — delete the entry as soon as we see ANY end event for
    // this tool id, shell or not. The old code deleted only when the command text was non-empty, which
    // leaked one entry per non-shell tool call (Read/Edit/Write/ctx) for the whole session — and a Write
    // start event carries the entire file content, so a long session grew unbounded.
    if (id) toolStartArgs.delete(id);
    if (commandText(event) || !cached) return event;
    const current = event?.args || event?.input || event?.params || event?.arguments || {};
    const merged = { ...cached, ...current };
    const enriched = {
      ...event,
      args: merged,
      input: { ...(event?.input || {}), ...merged },
      params: { ...(event?.params || {}), ...merged },
      arguments: { ...(event?.arguments || {}), ...merged },
    };
    return enriched;
  }


  function hydratePending(ctx: any): PendingReview | undefined {
    if (pending) return pending;
    const repo = reviewRepoForCtx(ctx);
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

  // --- Two-phase delivery of the merged summary (and the autofix request) back into the live
  // session. The review can finalize off-turn (the 20s reaper has no ctx and no live session loop),
  // where pi.sendMessage silently no-ops — so a send is NEVER treated as delivered. Each announcement
  // carries a nonce; delivery is PROVEN only when that nonce later appears in the session transcript.
  // Until then the announcement stays retryable and the footer shows "results ready (not shown)".
  // Pure decisions live in review-job-helpers.ts; durable records in review-jobs.ts. ---
  const ANNOUNCE_MAX_ATTEMPTS = 3;
  const ANNOUNCE_RETRY_MS = 30_000;
  // Age backstop for the idle-gated summary: it defers (no attempt burned) while the agent streams, so
  // a record that never observes an idle tick would otherwise retry forever without ever escalating.
  // Generous enough that no normal turn-to-idle gap trips it (idle ticks deliver in seconds), but it
  // bounds the pathological case so the /review-results fallback stays reachable (REQ-AGENT-062 AC3/AC6).
  const ANNOUNCE_MAX_AGE_MS = 1_800_000; // 30 min: safely exceeds long (15-20 min) review/work runs so a busy (non-idle) agent never false-escalates the summary

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

  function summaryDeliveryContent(state: PendingReview, nonce: string): string {
    // The nonce rides in a trailing HTML comment — invisible in the rendered summary, but it lands
    // verbatim in the persisted transcript line (custom messages persist regardless of `display`).
    return `${reviewSummaryMarkdown(state)}\n\n<!-- cf-review-delivery ${nonce} -->`;
  }

  // Dispatch one announcement kind, embedding its nonce. Returns whether a message was actually sent
  // (false only when the autofix is intentionally suppressed / not actionable, so it stays pending).
  function sendAnnouncement(record: ReviewAnnouncement, state: PendingReview, ctx: any): { sent: boolean; error?: string } {
    try {
      if (record.kind === "summary") {
        const summaryPath = join(reviewResultsDir(state.repo, state.head), "summary.md");
        try { mkdirSync(dirname(summaryPath), { recursive: true }); writeFileSync(summaryPath, `${reviewSummaryMarkdown(state)}\n`, "utf8"); } catch { /* persisted copy best-effort; chat copy is authoritative */ }
        // Deliver the (display-only) summary the SAME way /review-results does, but only on a ctx-bearing
        // live tick: a plain pi.sendMessage with NO options. That takes Pi's append path (appendCustomMessageEntry), which SYNCHRONOUSLY
        // writes the nonce-bearing content into the session transcript AND displays it in one step — so
        // the nonce reliably lands and the next reconcile proves delivery. The old `{ triggerTurn:true,
        // deliverAs:"followUp" }` instead routed the message through _runAgentPrompt / agent.followUp /
        // agent.steer, whose custom-message persistence is exactly what the nonce-verify loop had to
        // paper over: off-turn or post-reload that send no-op'd, the nonce never landed, and the summary
        // looped attempted→failed without ever surfacing. Gate on isIdle so the append path is only taken
        // when no turn is streaming — mid-stream it would STEER the summary into the running turn
        // (agent-readable mid-reasoning, the REQ-AGENT-058 AC7 hazard); when streaming we stay pending and
        // the next idle tick (agent_end / turn_end / session_start) delivers it.
        if (!ctx?.sessionManager) return { sent: false };
        let idle = true;
        // A THROW (runtime tearing down → assertActive) is reported as a failed attempt, NOT a silent
        // defer: it burns an attempt so a persistently-throwing isIdle still escalates to /review-results
        // rather than stranding the summary forever. A clean `false` (genuinely streaming) defers without
        // burning an attempt — the age backstop, not the attempt cap, escalates that case.
        try { idle = pi.isIdle ? pi.isIdle() : true; } catch { return { sent: false, error: "isIdle threw — runtime inactive" }; }
        if (!idle) return { sent: false };
        const content = summaryDeliveryContent(state, record.nonce);
        pi.sendMessage({ customType: "codeflare-review-summary-v3", content, display: true, details: { repo: state.repo, head: state.head, nonce: record.nonce, summary: content } });
        return { sent: true };
      }
      // Unlike the summary (which merely displays and tolerates a duplicate), the autofix message
      // TRIGGERS a real fix/commit/push turn. That only runs in a LIVE session, and off-turn the
      // trigger no-ops — so firing off-turn would burn nothing useful AND, with the one-shot marker
      // below, permanently block the next real fire. Skip off-turn; stay pending for the next live tick.
      if (!ctx?.sessionManager) return { sent: false };
      const resultLanes = completedDurableReviewLanes(state.repo, state.head, state.lanes);
      const fired = requestReviewAutofixForRows({
        sender: pi,
        repo: state.repo,
        head: state.head,
        rows: reviewSummaryRows(state),
        reviewComplete: durableReviewAckReady({ lanes: state.lanes, resultLanes }),
        // Honour an explicit "don't auto-fix / wait for GO" instruction at SEND time, even off-turn:
        // sessionUserMessages falls back to the remembered session file, so the idle reaper reads the
        // same messages an on-turn send would. Suppressed → not sent → the announcement stays pending.
        suppress: reviewAutofixModeFromUserMessages(sessionUserMessages(ctx)) === "manual",
        nonce: record.nonce,
        // Durable one-shot guard: an autofix turn must fire AT MOST ONCE per head even if the delivery
        // nonce hasn't surfaced before the next drain tick (30s) — otherwise a re-send triggers a second
        // fix/commit/push turn = duplicate commits. The marker doubles as the `autofix.requested` flag
        // computeReviewState reads for /review-status. A failed claim → fired:false → stays pending,
        // and the next tick reconciles to visible once the triggered turn's message persists the nonce.
        claim: () => {
          const marker = join(reviewJobDir(state.repo, state.head), "autofix.requested");
          mkdirSync(dirname(marker), { recursive: true });
          try { closeSync(openSync(marker, "wx")); return true; } catch { return false; }
        },
      });
      return { sent: fired };
    } catch (error) {
      // A throw means nothing was enqueued — report sent:false so it is never mistaken for a delivery,
      // but carry the error so the drain loop still counts it as an attempt and escalates honestly.
      return { sent: false, error: String((error as { message?: string })?.message || error) };
    }
  }

  // One delivery tick for an explicit (repo, head): reconcile each non-terminal announcement against
  // the transcript first (so a verified one is never re-sent), then (re)send anything still due.
  function drainAnnouncementsFor(repo: string, head: string, ctx: any): void {
    const state = completedStateFromDurableJob(repo, head);
    if (!state) return;
    const now = Date.now();
    for (const kind of reviewAnnouncementKinds()) {
      const record = readReviewAnnouncement(repo, head, kind);
      if (!record || record.status === "visible" || record.status === "failed") continue;
      const nonceFound = sessionContainsNonce(ctx, record.nonce);
      const verdict = announcementReconcileDecision({ kind: record.kind, status: record.status, attempts: record.attempts, lastAttemptAt: record.lastAttemptAt, nonceFound, now, maxAttempts: ANNOUNCE_MAX_ATTEMPTS, retryDelayMs: ANNOUNCE_RETRY_MS, createdAt: record.createdAt, maxAgeMs: ANNOUNCE_MAX_AGE_MS });
      if (verdict === "visible") {
        writeReviewAnnouncement({ ...record, status: "visible", deliveredAt: now });
        appendReviewEvent(repo, { event: `${kind}_announcement_visible`, head, nonce: record.nonce });
        continue;
      }
      if (verdict === "failed") {
        writeReviewAnnouncement({ ...record, status: "failed", lastError: "delivery nonce not found in session transcript after retries" });
        appendReviewEvent(repo, { event: `${kind}_announcement_failed`, head, attempts: record.attempts });
        if (kind === "summary") { try { ctx?.ui?.notify?.("PR-boundary review results are ready but did not post automatically — run /review-results to see them.", "warning"); } catch { /* best effort */ } }
        continue;
      }
      if (!shouldAttemptAnnouncement({ status: record.status, attempts: record.attempts, lastAttemptAt: record.lastAttemptAt, now, maxAttempts: ANNOUNCE_MAX_ATTEMPTS, retryDelayMs: ANNOUNCE_RETRY_MS })) continue;
      const { sent, error } = sendAnnouncement(record, state, ctx);
      // sent:false with NO error = intentional skip (autofix suppressed / off-turn / already claimed):
      // leave pending without burning an attempt. sent:false WITH an error = a send that threw: count it
      // so a persistently failing send still escalates to `failed` after the cap.
      if (!sent && !error) continue;
      writeReviewAnnouncement({ ...record, status: "attempted", attempts: record.attempts + 1, lastAttemptAt: now, lastError: error });
      appendReviewEvent(repo, { event: `${kind}_announcement_attempted`, head, nonce: record.nonce, attempt: record.attempts + 1 });
    }
    refreshDeliveryStatus(ctx, repo, head);
  }

  // Resolve the current enforced+acked head, then drain its announcements. Safe with or without a
  // live ctx; off-turn it still attempts, and the next ctx-bearing tick proves/retries.
  function drainReviewAnnouncements(ctx: any): void {
    const repo = reviewRepoForCtx(ctx);
    if (!repo || !isSddProject(repo)) return;
    const pr = prState(repo);
    if (!isEnforcedPr(pr)) return;
    const head = reviewCandidateHead(repo, pr);
    if (!head || !acked(repo, head)) return;
    drainAnnouncementsFor(repo, head, ctx);
  }

  // Persistent footer cue: while the SUMMARY announcement for the current head is not yet proven
  // delivered, keep "results ready (not shown) — /review-results"; clear it once visible (or absent).
  function refreshDeliveryStatus(ctx: any, repo: string, head: string): void {
    try {
      const summary = readReviewAnnouncement(repo, head, "summary");
      if (summary && summary.status !== "visible") {
        ctx?.ui?.setStatus?.("codeflare-review", "review: results ready (not shown) — /review-results");
      } else {
        clearReviewStatus(ctx);
      }
    } catch { /* status is best-effort */ }
  }

  function hasActionableFindings(state: PendingReview): boolean {
    return reviewSummaryRows(state).some((row) => actionableReviewCount(row.counts) > 0);
  }

  // Arm the durable delivery intents for a completed review: the summary always, the autofix only when
  // there are actionable findings. Idempotent for a pending/attempted/visible record (never re-arms a
  // delivered one), so it is safe on every finalize and on an already-acked head's recovery path. A
  // `failed` record IS re-armed on purpose: that is the self-heal when an off-turn tick exhausted the
  // retries with no live session — the next live tick redelivers with real context.
  function armReviewAnnouncements(state: PendingReview): void {
    const stamp = Date.now();
    ensureReviewAnnouncementPending(state.repo, state.head, "summary", reviewAnnouncementNonce("summary", state.head, stamp), stamp);
    appendReviewEvent(state.repo, { event: "summary_announcement_pending", head: state.head });
    if (hasActionableFindings(state)) {
      ensureReviewAnnouncementPending(state.repo, state.head, "autofix", reviewAnnouncementNonce("autofix", state.head, stamp), stamp);
      appendReviewEvent(state.repo, { event: "autofix_announcement_pending", head: state.head });
    }
  }

  function publishReviewResultFile(state: PendingReview, lane: string, ctx: any): void {
    const path = reviewResultPath(state.repo, state.head, lane);
    if (!claimReviewAnnouncement(state, lane)) return;
    ctx.ui.notify(`PR-boundary ${lane} completed for ${basename(state.repo)} at ${state.head.slice(0, 12)}. Findings saved: ${path}`, "info");
  }

  function finalizeCompletedReview(state: PendingReview, ctx?: any): void {
    appendReviewEvent(state.repo, { event: "review_acked", head: state.head, lanes: state.lanes });
    writeReviewSummaryFromDisk(state);
    writeAck(state.repo, state.head);
    resetBlockCount(state.repo);
    clearBreaker(state.repo);
    clearPending(state.repo);
    // Execution is done; delivery is a separate, VERIFIED phase. Arm durable delivery intents that
    // survive a Pi reload and off-turn finalization, so a send that silently no-ops (off-turn / stale
    // sender) is retried on the next live tick rather than stranded (the old code claimed a one-shot
    // marker before the send). Then deliver+verify now; off-turn (no ctx) this attempts but cannot
    // prove delivery, so the next ctx-bearing tick (refreshReviewStatusFromDurable / agent_end →
    // drainReviewAnnouncements) proves it.
    armReviewAnnouncements(state);
    drainAnnouncementsFor(state.repo, state.head, ctx);
    pending = undefined;
  }

  function refreshReviewStatusFromDurable(ctx: any): void {
    const state = hydratePending(ctx);
    if (!state) {
      clearReviewStatus(ctx);
      drainReviewAnnouncements(ctx);
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
    // doc-updater is dispatched in the initial parallel wave (durableReviewInitialLanes),
    // so spec-reviewer's completion no longer spawns it — every lane completes independently
    // and the ack-ready check below fires once all report-only lanes have landed.
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
    if (rawPrevious && rawPrevious.head !== head) {
      // The window is moving to a new head, so the PREVIOUS head's still-running lane children are
      // reviewing a now-superseded head and must be killed (R3). Otherwise a fix-push cascade piles up to
      // ~3N detached `pi --mode json` children on the resource-constrained box, and a hung old-head child escapes the
      // review budget forever — its job is never reaped again because reaping is keyed to the CURRENT
      // pending head. This fires for BOTH a descendant roll-forward (reusable: the completed lanes' result
      // files are kept and reused by mergeLaneState; abandonDurableReviewLanes only touches `running`
      // lanes, so only the still-incomplete ones — which the new window re-spawns anyway — are killed) and
      // a non-descendant supersede. Previously the kill fired only on the non-descendant branch, so the
      // far more common descendant fix-push leaked the prior head's reviewer processes.
      abandonDurableReviewLanes(repo, rawPrevious.head);
      if (!reusablePrevious) {
        // Non-descendant supersede (history rewrite, or a switch to a different PR branch): the old window
        // is not reused, so audit the supersede and drop it. The abandoned head stays recoverable via the
        // merge gate (blocks the unacked head, points at /review-run) if the user returns to that PR.
        appendReviewEvent(repo, { event: "review_superseded", head: rawPrevious.head, supersededBy: head });
        clearPending(repo);
      }
    }

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
    });
    const validBase = reviewBase && isAncestor(repo, reviewBase, head) ? reviewBase : undefined;
    resetBlockCount(repo);
    clearBreaker(repo); // new head under review: drop any stale breaker latch from a prior head
    // The push fail-open path (isEnforcedPrForPush) arms review even when gh returned an EMPTY
    // baseRefName on a transient parsing hiccup. Persisting "" here would be self-defeating: loadPending
    // rejects any row with a falsy baseRefName, so the pending review could never be re-read from disk —
    // the reaper couldn't finalize it and the merge gate couldn't see the pending head. Fall back to a
    // concrete label ("main", the only base this path ever fires for). The diff is anchored by the SHA
    // reviewBase, not this label, so the substitution can't mis-scope the review even if the base was master.
    const persistedBase = pr.baseRefName || "main";
    pending = { repo, prNumber: pr.number, baseRefName: persistedBase, headBranch: pr.headRefName, head, reviewBase: validBase, lanes: review.lanes, completed: review.completed, docPromptSent: false, spawned: false, spawnedIds: {}, fallbackLanes: new Set(), requestedAt: {}, reviewStartedAt: Date.now() };
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
  async function reconcileOpenPrReview(ctx: any, force: boolean, options?: { freshPrState?: boolean }): Promise<boolean> {
    const repo = reviewRepoForCtx(ctx);
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
    const pr = options?.freshPrState ? prStateFreshResult(resolvedRepo).pr : prState(resolvedRepo);
    const enforced = isEnforcedPr(pr);
    const head = enforced ? resolveEnforcedHead(resolvedRepo, pr) : "";
    const durableJob = head ? readDurableReviewJob(resolvedRepo, head) : undefined;
    const decision = shouldReconcileOpenPr({
      prOpen: pr?.state === "OPEN",
      prDraft: pr?.isDraft === true,
      enforced,
      head,
      acked: head ? acked(resolvedRepo, head) : false,
      hasReviewJob: (loadPending(resolvedRepo)?.head === head) || durableJobIsActiveWindow(durableJob),
      reviewActive: durableJob?.status === "running",
      breakerOpen: head ? isBreakerOpen(resolvedRepo, head) : false,
    });
    // SEED the per-session, per-branch baseline as soon as we have a resolvable head — even on a
    // non-reconcile outcome (e.g. the head is already acked at launch). The seed must happen BEFORE the
    // early return so that a LATER in-session descendant push on this branch is recognised as an advance
    // beyond the baseline rather than treated as a freshly-inherited head. `priorBaseline` (the value
    // BEFORE this tick's seed) is what the continuation check below compares against, so the very first
    // observation of a head reads `priorBaseline === head` and correctly OFFERS.
    const bkey = baselineKey(resolvedRepo);
    const priorBaseline = reviewBaselineMemory().get(bkey);
    if (head && priorBaseline === undefined) reviewBaselineMemory().set(bkey, head);
    if (!decision.reconcile) {
      // Log only genuine near-misses, not healthy outcomes (window exists / acked / not a PR), and
      // only ONCE per (repo, head, reason) this session — otherwise the 20s reconcile tick re-appends
      // the same latched-breaker row indefinitely and drowns the event log.
      if (decision.reason === "review breaker open for head" || decision.reason === "no resolvable enforced head") {
        if (!ignoreAlreadyLogged(resolvedRepo, head, decision.reason)) {
          appendReviewEvent(resolvedRepo, { event: "boundary_candidate_ignored", head, reason: decision.reason });
        }
      }
      return false;
    }
    // REQ-AGENT-058 (revised): AUTOSTART a missed boundary only when THIS session advanced the head —
    // primarily because a real boundary command ran this session (boundaryActedThisSession, set in
    // onToolEnd before any window guard, so it survives a dropped window), with the per-branch baseline
    // advance as a backstop for a reload that ate the boundary tool-event. A head merely inherited at
    // launch (fresh clone, relaunch) or reached by a bare checkout of another branch matches neither, so
    // it OFFERS and reviewers are never silently auto-spawned. See review-job-helpers::reviewInSessionContinuation.
    const inSessionContinuation = reviewInSessionContinuation({
      boundaryActed: boundaryActedThisSession(resolvedRepo),
      baseline: priorBaseline,
      head,
      isAncestor: (a, b) => isAncestor(resolvedRepo, a, b),
    });
    const action = reconcileBoundaryAction({
      reconcile: decision.reconcile,
      // Dedup the offer PER SESSION (process-scoped), not per-head-ever, so a new session on a
      // still-unchosen offer re-surfaces it.
      alreadyOffered: offerSurfacedThisSession(resolvedRepo, head),
      inSessionContinuation,
    });
    if (action === "noop") return false;
    if (action === "autostart") {
      return await ensureReviewWindow({ repo: resolvedRepo, pr: pr as PrState, head, ctx, trigger: "open-PR reconciliation (in-session continuation)" });
    }
    markOfferSurfaced(resolvedRepo, head);
    appendReviewEvent(resolvedRepo, { event: "boundary_offered", head, reason: decision.reason });
    // The offer surfaces ONLY as a passive toast — deliberately NOT a chat/transcript message.
    // markOfferSurfaced above dedupes it per head FOR THIS SESSION (a new session re-surfaces it).
    // A chat-visible custom message is agent-readable: the agent reads the offer's "Run /review-run …"
    // text as an instruction and spirals into trying to act on it after a clone-only request. The
    // merge gate (the gh pr merge block) is the durable enforcement; this toast is just a heads-up.
    ctx.ui.notify(`PR-boundary review available for ${basename(resolvedRepo)} at ${head.slice(0, 12)} (missed boundary). Run /review-run to start the required reviewers, or /review-skip to skip and ack this HEAD. Merge stays blocked until you choose.`, "warning");
    return false;
  }

  const onAgentStart = (event: any, ctx: any) => {
    if (!isActiveRun()) return;
    remember(ctx);
    const command = commandText(event);
    // commandText() pulls the command from bash (input.command) or, when context-mode is on,
    // the ctx_* tools (code/commands). Gate on the command itself, never the tool name.
    if (isGhPrMerge(command)) {
      // The gate is wired to BOTH tool_call and tool_execution_start (belt-and-suspenders on which event
      // Pi 0.79.1 honors the veto for — the same pattern codeflare-pi's clone gate uses). Evaluate ONCE
      // per tool id: the first event blocks, the second is deduped, so one merge command does not pay two
      // cache-bypassed `gh pr view` calls or write a duplicate merge_blocked audit row.
      const gateId = toolEventId(event);
      if (gateId && mergeGatedToolIds.has(gateId)) return;
      if (gateId) mergeGatedToolIds.add(gateId);
      const repo = reviewRepoForCtx(ctx, cwdFromCommand(command));
      if (!repo || !isSddProject(repo)) return;
      // P1: gate the PR the command actually TARGETS (number / URL / branch / --repo), not just the cwd
      // branch — `gh pr merge 42` from a clean checkout must be checked against PR 42. Read fresh (bypass
      // the prCache) so a stale-acked head can't open the gate while GitHub merges a newer unreviewed one,
      // and keep the full result so we can tell unreadable (fail closed) from no-PR (allow) — P4/R1.
      const target = mergeCommandTarget(command);
      // A `gh pr merge --repo OTHER/REPO` run from inside THIS SDD repo targets a DIFFERENT repository.
      // Its head can never be acked in this repo's state, so gating would falsely BLOCK a legitimate
      // foreign merge; skip enforcement for a foreign target (the foreign repo's own enforcement owns it).
      if (target.repoSlug && isForeignRepoTarget(repo, target.repoSlug)) return;
      const selector = target.prNumber !== undefined ? String(target.prNumber) : target.prBranch;
      const res = prStateFreshResult(repo, selector, target.repoSlug);
      const pr = res.pr;
      const enforced = isEnforcedPr(pr);
      const head = enforced ? resolveEnforcedHead(repo, pr) : "";
      // P3: `--auto` arms a server-side merge that completes once checks pass and never re-hits this gate
      // for the head that actually merges. Block it on an enforced unacked PR (review hasn't happened);
      // warn-but-allow on an acked one (a LATER push could still merge unreviewed — audited, not silent).
      if (target.auto && enforced) {
        if (!acked(repo, head)) {
          appendReviewEvent(repo, { event: "merge_blocked", head, reason: "auto_merge_bypasses_review" });
          return { block: true, reason: `--auto would let ${basename(repo)} #${pr?.number ?? "?"} merge server-side after checks WITHOUT this PR-boundary review (head ${head.slice(0, 12)} unreviewed). Review then merge without --auto, run /review-run, or use the user-only ${REVIEW_BYPASS} bypass.` };
        }
        appendReviewEvent(repo, { event: "auto_merge_armed_after_ack", head });
        ctx.ui.notify(`--auto armed on ${basename(repo)} #${pr?.number ?? "?"} (head ${head.slice(0, 12)} is reviewed). A push AFTER this would merge server-side without re-review — re-check before pushing again.`, "warning");
      }
      const decision = mergeGateDecision({
        prReadable: !res.failed,
        prExists: Boolean(pr),
        prEnforced: enforced,
        prMalformed: Boolean(pr && pr.state === "OPEN" && (!pr.baseRefName || !pr.headRefOid)),
        enforcedHead: head,
        headAcked: head ? acked(repo, head) : false,
        candidates: gateCandidates(repo),
        bypassPresent: bypassPending(),
      });
      if (decision.action === "allow") return;
      if (decision.action === "bypass") { consumeBypass(); acknowledgeBypass(repo, decision.head, ctx); return; }
      appendReviewEvent(repo, { event: "merge_blocked", head: decision.head, reason: decision.reason });
      const why = decision.reason === "head_not_acked"
        ? `PR-boundary review required before merge for ${basename(repo)} at ${decision.head.slice(0, 12)}.`
        : `PR-boundary review state for ${basename(repo)} is unreadable (${decision.reason}) while a review is pending for ${decision.head.slice(0, 12)}.`;
      return { block: true, reason: `${why} Complete required reviewers, run /review-run, or use the user-only ${REVIEW_BYPASS} bypass.` };
    }
    // No doc-updater-after-spec-reviewer ordering gate: the lanes run in parallel
    // (REQ-AGENT-040 AC4/AC5, AD78), so onAgentStart only enforces the merge gate.
  };

  pi.on("session_start", (_event: any, ctx: any) => {
    // A mid-session `/ctx on|off` reload re-runs activate() and installs a fresh runToken, but the OLD
    // module instance's session_start listener stays registered and also fires. Only the latest-activated
    // instance (which owns the live reaper timer + state) may act; a stale instance running reconcile or
    // roll-forward here would double-spawn lanes. Every other handler already guards on this — match them.
    if (!isActiveRun()) return;
    remember(ctx);
    const state = hydratePending(ctx);
    if (state && reviewHeadStatus(state) === "advanced") { void rollForwardAdvancedReview(state, ctx, "session_start detected advanced PR head"); return; }
    refreshReviewStatusFromDurable(ctx);
    // Catch a boundary missed before this session started (forced: once per session start).
    void reconcileOpenPrReview(ctx, true);
  });

  // User controls for a missed-boundary review that reconciliation OFFERED rather than
  // auto-started (REQ-AGENT-058 revised). /review-run launches the required reviewers for the
  // current enforced PR head; /review-skip acks that head so the merge gate opens with no review.
  function resolveCommandRepo(ctx: any): string | undefined {
    return reviewRepoForCtx(ctx);
  }

  pi.registerCommand("review-run", {
    description: "Start the PR-boundary reviewers for the current enforced PR head",
    handler: async (_args: string, ctx: any) => {
      const repo = resolveCommandRepo(ctx);
      if (!repo) {
        const cwd = ctx?.sessionManager?.getCwd?.() ?? process.cwd();
        ctx.ui.notify(`/review-run: could not resolve the active repo. Pi session cwd is ${cwd}; the SDD repo may be nested — work in it (so it becomes the active repo) and retry.`, "warning");
        return;
      }
      if (!isSddProject(repo)) { ctx.ui.notify(`/review-run: ${repo} is not an SDD repository (no sdd/README.md).`, "warning"); return; }
      const pr = prState(repo);
      if (!isEnforcedPr(pr)) { ctx.ui.notify("/review-run: no open PR to main/master for this repo — nothing to review.", "warning"); return; }
      const head = resolveEnforcedHead(repo, pr);
      if (!head) { ctx.ui.notify("/review-run: could not resolve the PR head.", "warning"); return; }
      if (acked(repo, head)) { ctx.ui.notify(`/review-run: head ${head.slice(0, 12)} is already acked; nothing to do.`, "info"); return; }
      remember(ctx);
      const started = await ensureReviewWindow({ repo, pr, head, ctx, trigger: "user /review-run" });
      if (!started) ctx.ui.notify(`/review-run: a review window for ${head.slice(0, 12)} already exists.`, "info");
    },
  });

  pi.registerCommand("review-results", {
    description: "Show the latest PR-boundary review summary for the current enforced PR head",
    handler: (_args: string, ctx: any) => {
      const repo = resolveCommandRepo(ctx);
      if (!repo) {
        const cwd = ctx?.sessionManager?.getCwd?.() ?? process.cwd();
        ctx.ui.notify(`/review-results: could not resolve the active repo. Pi session cwd is ${cwd}; the SDD repo may be nested — work in it and retry.`, "warning");
        return;
      }
      if (!isSddProject(repo)) { ctx.ui.notify(`/review-results: ${repo} is not an SDD repository (no sdd/README.md).`, "warning"); return; }
      const pr = prState(repo);
      const head = isEnforcedPr(pr) ? resolveEnforcedHead(repo, pr) : (localHead(repo) || "");
      const summaryPath = head ? join(reviewResultsDir(repo, head), "summary.md") : "";
      if (!summaryPath || !existsSync(summaryPath)) {
        ctx.ui.notify("/review-results: no completed PR-boundary review summary found for the current head.", "warning");
        return;
      }
      const content = readFileSync(summaryPath, "utf8");
      try {
        // Manual escape hatch: display the persisted summary directly (bypasses the delivery state
        // machine's dedupe — the user explicitly asked to see it), then mark the announcement delivered
        // so the background retry loop stops and the "results ready (not shown)" status clears.
        pi.sendMessage({ customType: "codeflare-review-summary-v3", content, display: true, details: { repo, head, manual: true } });
        const summary = readReviewAnnouncement(repo, head, "summary");
        if (summary && summary.status !== "visible") {
          writeReviewAnnouncement({ ...summary, status: "visible", deliveredAt: Date.now() });
          appendReviewEvent(repo, { event: "summary_announcement_visible", head, manual: true });
        }
        clearReviewStatus(ctx);
      } catch {
        ctx.ui.notify(`/review-results: summary is on disk at ${summaryPath}`, "info");
      }
    },
  });

  pi.registerCommand("review-skip", {
    description: "Skip the PR-boundary review and ack the current enforced PR head",
    handler: (_args: string, ctx: any) => {
      const repo = resolveCommandRepo(ctx);
      if (!repo) {
        const cwd = ctx?.sessionManager?.getCwd?.() ?? process.cwd();
        ctx.ui.notify(`/review-skip: could not resolve the active repo. Pi session cwd is ${cwd}; the SDD repo may be nested — work in it and retry.`, "warning");
        return;
      }
      if (!isSddProject(repo)) { ctx.ui.notify(`/review-skip: ${repo} is not an SDD repository (no sdd/README.md).`, "warning"); return; }
      const pr = prState(repo);
      const head = isEnforcedPr(pr) ? resolveEnforcedHead(repo, pr) : (localHead(repo) || "");
      if (!head) { ctx.ui.notify("/review-skip: could not resolve the current head.", "warning"); return; }
      clearPending(repo);
      clearBreaker(repo);
      writeAck(repo, head);
      // R8: also drop the in-memory window and the rendered status row (mirroring acknowledgeBypass).
      // Without this the dead review row keeps rendering and pendingSameRepo suppresses reconciliation
      // for the repo until the next agent_end self-heals — a stale, confusing UI after an explicit skip.
      pending = undefined;
      clearReviewStatus(ctx);
      appendReviewEvent(repo, { event: "review_skipped", head, reason: "user /review-skip" });
      ctx.ui.notify(`PR-boundary review skipped for ${basename(repo)} at ${head.slice(0, 12)}; merge gate opened (head acked).`, "warning");
    },
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

  // Seed toolStartArgs from BOTH tool_call and tool_execution_start (keyed by tool id). The command is
  // recovered at tool_result via withStartArgs; if ONLY tool_execution_start seeded the cache and that
  // event is lost (reload / turn boundary / different id shape), the push command would be gone by
  // tool_result and the PR-boundary fast-path (onToolEnd) would silently skip the push (observed: a
  // `git push` to an open enforced PR that never created a review window). tool_call carries the same
  // args, so capturing there too closes that hole. tool_execution_start still seeds afterward, so it
  // keeps overriding with the final mutated input on the common path where it does fire.
  const rememberToolStartArgs = (event: any): void => {
    const id = toolEventId(event);
    if (id) toolStartArgs.set(id, event?.args || event?.input || event?.params || event?.arguments || {});
  };
  pi.on("tool_call", (event: any, ctx: any) => {
    rememberToolStartArgs(event);
    return onAgentStart(event, ctx);
  });
  pi.on("tool_execution_start", (event: any, ctx: any) => {
    rememberToolStartArgs(event);
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
    // Never-silent: a successful bash result that arrives with no recoverable command text is the
    // command-loss path (neither tool_call nor tool_execution_start seeded args for this id). With the
    // tool_call seeding above this is rare, but when it still happens the boundary fast-path below would
    // skip a possible push SILENTLY. Record a diagnosable near-miss (deduped per repo) so the reconcile
    // backstop is the only thing that has to catch it, and the miss is no longer invisible.
    if (!command && toolName === "bash") {
      const lostRepo = reviewRepoForCtx(ctx, undefined);
      if (lostRepo && isSddProject(lostRepo) && !ignoreAlreadyLogged(lostRepo, "", "missing_command_text_after_success")) {
        appendReviewEvent(lostRepo, { event: "boundary_tool_end_ignored", reason: "missing_command_text_after_success" });
      }
      return;
    }
    // P2/P3 retroactive truth-layer: the pre-merge gate (onAgentStart) can be slipped by a wrapper the
    // boundary anchor doesn't cover (`bash -c '…'`, `xargs … gh pr merge`) or by `--auto` merging
    // server-side later. This is the backstop Claude relies on wholesale: after ANY gh-pr-merge-shaped
    // command actually ran, if the PR is now MERGED while its head was never acked, raise a loud, durable
    // alert. It cannot un-merge, but it turns a SILENT unreviewed merge into a recorded, visible one (the
    // never-silent principle). The loose word match may also fire on a mention (`grep 'gh pr merge'`),
    // but then nothing merged so state!=MERGED and no alert — a harmless extra `gh pr view`.
    if (/\bgh\b[^\n;&|]*\bpr\b[^\n;&|]*\bmerge\b/.test(command)) {
      const mergeRepo = reviewRepoForCtx(ctx, cwdFromCommand(command));
      if (mergeRepo && isSddProject(mergeRepo)) {
        const t = mergeCommandTarget(command);
        // Foreign-repo merge (--repo OTHER/REPO): not our ack state — mirror the pre-merge gate's
        // foreign-target skip, else a legitimate merge of another repo's PR false-alarms here.
        if (t.repoSlug && isForeignRepoTarget(mergeRepo, t.repoSlug)) return;
        const sel = t.prNumber !== undefined ? String(t.prNumber) : t.prBranch;
        const merged = prStateResultFor(mergeRepo, sel, t.repoSlug).pr;
        const mh = merged?.headRefOid || "";
        if (merged?.state === "MERGED" && mh && !acked(mergeRepo, mh) && !ignoreAlreadyLogged(mergeRepo, mh, "merge_completed_unreviewed")) {
          appendReviewEvent(mergeRepo, { event: "merge_completed_unreviewed", head: mh, prNumber: merged.number });
          ctx.ui.notify(`${basename(mergeRepo)} #${merged.number ?? "?"} was MERGED without completing PR-boundary review (head ${mh.slice(0, 12)} never acked) — the gate was bypassed (wrapper or --auto). Review the merged change and follow up.`, "error");
        }
      }
    }
    if (!isPrBoundaryTrigger(command)) {
      // PR-URL fallback (REQ-AGENT-058 AC5): a `gh pr create` can print the new PR URL even when
      // its command text was not recognized as a boundary trigger (compound `&&`, here-doc body,
      // or a wrapper script). When a pr-create-shaped command emits a PR URL we did not parse as
      // a boundary, record the near-miss and let the bounded open-PR reconciliation start the
      // review. Gated on /pr create/ so read-only gh commands (pr view/list) never trigger it.
      if (/pr\s+create/i.test(command) && prUrlFromText(stringifyReviewResult(toolResultPayload(event)))) {
        const repo = reviewRepoForCtx(ctx, cwdFromCommand(command));
        if (repo && isSddProject(repo)) {
          appendReviewEvent(repo, { event: "boundary_candidate_ignored", reason: "pr_create_url_not_parsed" });
          await reconcileOpenPrReview(ctx, true, { freshPrState: true });
        }
      }
      // Simple truth backstop: after ANY successful shell command that actually invokes git/gh, re-read
      // GitHub PR state FRESH (bypassing prCache). Regex/tool parsing is only an accelerator; `gh pr view`
      // owns the truth. This catches wrapper/compound commands whose exact boundary verb was not
      // classified, and it makes a missed push self-heal immediately instead of waiting for a cache TTL.
      const postCommandDecision = postCommandReconcileDecision(command);
      if (postCommandDecision.reconcile) await reconcileOpenPrReview(ctx, true, { freshPrState: postCommandDecision.freshPrState });
      return;
    }

    const repo = reviewRepoForCtx(ctx, cwdFromCommand(command));
    if (!repo || !isSddProject(repo)) return;

    // Use the failure-distinguishing FRESH read (invalidates the prCache entry first) so a push that
    // landed within the 60s prCache TTL is decided against the new head, not a stale pre-push cache —
    // P4 failure distinction is preserved because prStateFreshResult delegates to prStateResultFor.
    const prRes = prStateFreshResult(repo);
    const pr = prForBoundaryCommand(repo, command, prRes.pr);
    if (!isEnforcedPrForPush(pr)) {
      // P4: gh was unreadable (transient), not a confirmed absence — a real boundary command still ran.
      // Record that this session pushed this branch (so reconciliation AUTOSTARTS once gh recovers rather
      // than degrading to an offer) and audit the near-miss, so the outage window is never a silent skip.
      if (prRes.failed) {
        markBoundaryActed(repo);
        appendReviewEvent(repo, { event: "boundary_tool_end_ignored", reason: "pr_state_unreadable" });
      }
      return;
    }
    // A real PR-boundary command just ran for a confirmed enforced PR on this repo+branch.
    // Record it NOW — before any of the window-creation guards below can bail — so that even if the
    // window is never created (head unresolved, dedup, a reload right after), the reconcile still knows
    // THIS session advanced this branch and will AUTOSTART rather than merely OFFER the missed head.
    // P8: a push to a DRAFT PR does not arm review — symmetric with reconcile (shouldReconcileOpenPr
    // excludes drafts). When the PR is marked ready-for-review its head is still unacked, so reconcile
    // catches it then; and a draft can't be merged on GitHub meanwhile, so the gate never matters.
    if (pr.isDraft) { appendReviewEvent(repo, { event: "boundary_tool_end_ignored", reason: "draft_pr", head: pr.headRefOid || "" }); return; }
    // Key the mark by the PUSHED PR's branch (pr.headRefName), not currentBranch-at-tool-end — a
    // `git push A && git checkout B` would otherwise attribute the push to B and risk auto-starting B's
    // inherited head (R6). Falls back to currentBranch when there is no PR branch yet (push-before-PR).
    markBoundaryActed(repo, pr.headRefName);
    const head = reviewCandidateHead(repo, pr, command);
    // REQ-AGENT-058: from here the PR is a confirmed enforced boundary, so a silent bail is a
    // genuine near-miss. Audit it (reconciliation still backstops the start) so a future miss is
    // diagnosable instead of invisible. Healthy skips (acked/breaker/pending) are not audited.
    if (!head) { appendReviewEvent(repo, { event: "boundary_tool_end_ignored", reason: "no_resolvable_head" }); return; }
    if (consumeBypass()) {
      acknowledgeBypass(repo, head, ctx);
      return;
    }
    if (acked(repo, head)) return;
    if (isBreakerOpen(repo, head)) return; // breaker already gave up on this exact head; push a new commit to retry
    if (loadPending(repo)?.head === head) return; // a window for this head already exists
    if (!shouldProcessPrBoundaryToolEnd(toolEventId(event), true)) { appendReviewEvent(repo, { event: "boundary_tool_end_ignored", reason: "dedupe_skipped", head }); return; }
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
    // P9: withStartArgs consumes a tool's start-args on its matching end event, but a tool call that
    // never emits any end event (user ESC/abort, tool crash) would leave its entry — for a Write that is
    // the entire file content — stranded forever. agent_end is a turn boundary: every tool that ran this
    // turn has settled, so any remaining start-args are orphans. Drop them all (sibling extension
    // codeflare-pi.ts clears its own maps here for the same reason).
    toolStartArgs.clear();
    mergeGatedToolIds.clear();
    const state = hydratePending(ctx);
    if (!state) {
      // No persisted review window: a real open, enforced PR with an unacked head and no
      // review job is a missed boundary. Let bounded reconciliation decide; otherwise drain any
      // pending result-delivery announcements (deliver/verify/retry) and refresh the status.
      if (await reconcileOpenPrReview(ctx, true)) return;
      clearReviewStatus(ctx);
      drainReviewAnnouncements(ctx);
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
      // Already acked: make sure this head's delivery announcements are armed, then drain (deliver/
      // verify/retry) — covers a head acked before its summary was proven delivered.
      const completed = completedStateFromDurableJob(state.repo, activeHead);
      if (completed) armReviewAnnouncements(completed);
      drainAnnouncementsFor(state.repo, activeHead, ctx);
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
