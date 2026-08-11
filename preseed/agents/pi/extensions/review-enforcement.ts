import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  findGitRoot,
  recallActiveRepo,
  rememberActiveRepoFromToolResult,
  resolveShellInvocationRepo,
  shellInvocations,
  type ShellInvocation,
} from "./active-repo-memory";
import { activateRegisteredTools, type ToolActivationPi } from "./capability-helpers";
import {
  classifyReviewBoundaryCommand,
  REVIEW_TRIAGE_DIVIDER,
  REVIEW_TRIAGE_HEADER,
  isReviewTransitionSuspended,
  requiredReviewLanes,
  reviewRange,
  reviewTranscriptFacts,
  type ReviewBoundaryEvent,
  type ReviewLane,
} from "./review-helpers";
import { scopeContract } from "./review-scope";

type PrState = {
  state: "OPEN" | "CLOSED" | "MERGED";
  baseRefName: "main" | "master" | "develop";
  headRefOid: string;
  headRefName: string;
  number: number;
  isDraft?: boolean;
  mergeCommit?: { oid: string } | null;
};

export const PR_LOOKUP_FAILED = Symbol("pr-lookup-failed");
type PrLookup = PrState | undefined | typeof PR_LOOKUP_FAILED;

type Dependencies = {
  queryPr(repo: string, target?: string): Promise<PrLookup>;
  queryHead?(repo: string, revision?: string): Promise<string | undefined>;
  queryBranch?(repo: string): Promise<string | undefined>;
  sleep?(delayMs: number): Promise<void>;
  headRetryDelaysMs?: number[];
  deferGoalPause?(task: () => void | Promise<void>): void;
};

type ReviewContext = {
  cwd: string;
  hasUI: boolean;
  sessionManager: {
    getSessionFile(): string | undefined;
    getBranch?(): Record<string, any>[];
    getEntries?(): Record<string, any>[];
    getHeader?(): { parentSession?: string } | undefined;
  };
  ui?: {
    select(title: string, options: string[]): Promise<string | undefined>;
    notify(message: string, level?: "info" | "warning" | "error"): void;
  };
};

type ReviewPi = ToolActivationPi & {
  on(event: "session_start" | "tool_result" | "agent_end" | "agent_settled", handler: (event: any, ctx: ReviewContext) => void | Promise<void>): void;
  events: { emit(channel: string, payload: unknown): void };
  appendEntry(customType: string, data: unknown): void;
  sendMessage(
    message: { customType: string; content?: string; details?: Record<string, unknown>; display?: boolean },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
};

type QueryPrRunner = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: "utf8"; timeout: number },
) => Promise<{ stdout: string | Buffer }>;

const execFileAsync = promisify(execFile) as unknown as QueryPrRunner;
const MAX_BLOCKS = 5;
const BYPASS_FILE = process.env.REVIEW_BYPASS_FILE || "/tmp/review-bypass";
const GOAL_STATE_ENTRY_TYPE = "goal-state";
const REVIEW_GOAL_PAUSE_ENTRY_TYPE = "pr-boundary-goal-pause";
const BOUNDARY_EVALUATED_ENTRY_TYPE = "pr-boundary-evaluated";
const GOAL_CONTROL_CHANNEL = "codeflare:pi-goal:control";

type GoalSnapshot = { id: string; status: string };
type ReviewGoalPause = { head: string; goalId: string };
type GoalControlResult = { ok: boolean; goalId: string; status: string };

function readableSessionEntries(ctx: ReviewContext): Record<string, any>[] | undefined {
  try {
    return ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
  } catch {
    return undefined;
  }
}

function sessionEntries(ctx: ReviewContext): Record<string, any>[] {
  return readableSessionEntries(ctx) ?? [];
}

function goalSnapshot(entry: Record<string, any>): GoalSnapshot | undefined {
  const goal = entry?.type === "custom" && entry.customType === GOAL_STATE_ENTRY_TYPE
    ? entry.data?.goal
    : undefined;
  return goal
    && typeof goal.id === "string"
    && typeof goal.status === "string"
    ? { id: goal.id, status: goal.status }
    : undefined;
}

function currentGoal(ctx: ReviewContext): GoalSnapshot | undefined {
  const entry = sessionEntries(ctx)
    .filter((candidate) => (
      candidate?.type === "custom" && candidate.customType === GOAL_STATE_ENTRY_TYPE
    ))
    .at(-1);
  return entry ? goalSnapshot(entry) : undefined;
}

function boundaryWasEvaluated(ctx: ReviewContext, toolUseId: string): boolean {
  return sessionEntries(ctx).some((entry) => entry?.type === "custom"
    && entry.customType === BOUNDARY_EVALUATED_ENTRY_TYPE
    && entry.data?.toolUseId === toolUseId);
}

function reviewGoalPause(ctx: ReviewContext): ReviewGoalPause | undefined {
  const entry = sessionEntries(ctx)
    .filter((candidate) => (
      candidate?.type === "custom" && candidate.customType === REVIEW_GOAL_PAUSE_ENTRY_TYPE
    ))
    .at(-1);
  const data = entry?.data;
  return data
    && fullSha(data.head)
    && typeof data.goalId === "string"
    ? data as ReviewGoalPause
    : undefined;
}

function clearReviewGoalPause(pi: ReviewPi): void {
  try {
    pi.appendEntry(REVIEW_GOAL_PAUSE_ENTRY_TYPE, null);
  } catch {
    // Goal integration is optional and must never block PR enforcement.
  }
}

function notifyGoalBridgeFailure(ctx: ReviewContext, message: string): void {
  try {
    ctx.ui?.notify(message, "error");
  } catch {
    // Notification failure must not change the PR-boundary result.
  }
}

async function requestGoalControl(
  pi: ReviewPi,
  action: "pause" | "resume",
  goalId: string,
): Promise<GoalControlResult | undefined> {
  let accepted = false;
  let resolveResponse: (result: GoalControlResult | undefined) => void = () => {};
  const response = new Promise<GoalControlResult | undefined>((resolve) => {
    resolveResponse = resolve;
  });
  try {
    pi.events.emit(GOAL_CONTROL_CHANNEL, {
      action,
      goalId,
      accepted: () => {
        accepted = true;
      },
      respond: (result: GoalControlResult) => {
        resolveResponse(
          result && typeof result.ok === "boolean" && typeof result.goalId === "string" && typeof result.status === "string"
            ? result
            : undefined,
        );
      },
    });
  } catch {
    return undefined;
  }
  return accepted ? response : undefined;
}

async function pauseGoalForReview(pi: ReviewPi, ctx: ReviewContext, head: string): Promise<void> {
  const goal = currentGoal(ctx);
  const owned = reviewGoalPause(ctx);
  if (!goal) return;
  if (owned?.head === head && owned.goalId === goal.id) return;
  if (owned?.goalId === goal.id && goal.status === "paused") {
    try {
      pi.appendEntry(REVIEW_GOAL_PAUSE_ENTRY_TYPE, { head, goalId: goal.id } satisfies ReviewGoalPause);
    } catch (error) {
      const rollback = await requestGoalControl(pi, "resume", goal.id);
      if (rollback?.ok && rollback.status === "active") {
        clearReviewGoalPause(pi);
        notifyGoalBridgeFailure(ctx, `Could not transfer Goal pause to the new PR head: ${String(error)}`);
      } else {
        notifyGoalBridgeFailure(
          ctx,
          `Could not transfer Goal pause to the new PR head and rollback also failed; review ownership was retained: ${String(error)}`,
        );
      }
    }
    return;
  }
  if (goal.status !== "active") return;

  try {
    pi.appendEntry(REVIEW_GOAL_PAUSE_ENTRY_TYPE, { head, goalId: goal.id } satisfies ReviewGoalPause);
  } catch (error) {
    notifyGoalBridgeFailure(ctx, `Could not record Goal review ownership before pausing: ${String(error)}`);
    return;
  }
  const result = await requestGoalControl(pi, "pause", goal.id);
  const persistedGoal = currentGoal(ctx);
  const bridgeConfirmed = result?.ok && result.goalId === goal.id && result.status === "paused";
  const persistenceConfirmed = persistedGoal?.id === goal.id && persistedGoal.status === "paused";
  if (!bridgeConfirmed && !persistenceConfirmed) clearReviewGoalPause(pi);
}

function ownsReviewGoalPause(ctx: ReviewContext, head: string): boolean {
  const owned = reviewGoalPause(ctx);
  const goal = currentGoal(ctx);
  return Boolean(owned && owned.head === head && goal?.id === owned.goalId && goal.status === "paused");
}

async function releaseReviewGoalPause(pi: ReviewPi, ctx: ReviewContext, head: string): Promise<boolean> {
  const owned = reviewGoalPause(ctx);
  if (!owned) return false;
  const goal = currentGoal(ctx);
  const retainsReplacementOwnership = goal?.id === owned.goalId && goal.status === "paused";
  if (!ownsReviewGoalPause(ctx, head) && !retainsReplacementOwnership) {
    clearReviewGoalPause(pi);
    return false;
  }
  const result = await requestGoalControl(pi, "resume", owned.goalId);
  if (result?.ok && result.status === "active") {
    clearReviewGoalPause(pi);
    return true;
  }
  const persistedGoal = currentGoal(ctx);
  if (persistedGoal?.id !== owned.goalId || persistedGoal.status !== "paused") {
    clearReviewGoalPause(pi);
    return false;
  }
  notifyGoalBridgeFailure(ctx, "Could not resume Goal after PR review; review ownership was retained. Use /goal resume after resolving its current state.");
  return false;
}

function fullSha(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{40}$/.test(value));
}

function isProtectedPr(pr: PrState | undefined): pr is PrState {
  return Boolean(
    pr
    && ["OPEN", "CLOSED", "MERGED"].includes(pr.state)
    && (pr.baseRefName === "main" || pr.baseRefName === "master" || pr.baseRefName === "develop")
    && fullSha(pr.headRefOid),
  );
}

function isEnforcedPr(pr: PrState | undefined): pr is PrState {
  return isProtectedPr(pr) && pr.state === "OPEN";
}

function isSddRepo(repo: string): boolean {
  return existsSync(join(repo, "sdd", "README.md"));
}

function sessionFile(ctx: ReviewContext): string | undefined {
  const file = ctx.sessionManager.getSessionFile();
  return typeof file === "string" && file ? file : undefined;
}

function isChildSession(ctx: ReviewContext, file: string | undefined): boolean {
  const liveHeader = ctx.sessionManager.getHeader?.();
  if (liveHeader) return typeof liveHeader.parentSession === "string" && liveHeader.parentSession.length > 0;
  if (!file) return true;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const buffer = Buffer.alloc(16_384);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytes).toString("utf8").split("\n", 1)[0];
    const header = JSON.parse(firstLine);
    return header?.type !== "session" || (typeof header.parentSession === "string" && header.parentSession.length > 0);
  } catch {
    return true;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function gitMetadataDirectory(repo: string): string | undefined {
  const dotGit = join(repo, ".git");
  try {
    return statSync(dotGit).isDirectory() ? dotGit : undefined;
  } catch {
    return undefined;
  }
}

async function githubRepository(repo: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["remote", "get-url", "origin"],
      { cwd: repo, encoding: "utf8", timeout: 10_000 },
    );
    const remote = String(stdout).trim().replace(/\.git$/, "")
      .replace(/^ssh:\/\/git@ssh\.github\.com:443\//, "https://github.com/");
    const match = /github\.com(?::|\/)([^/:\s]+)\/([^/\s]+)$/.exec(remote);
    return match ? `${match[1]}/${match[2]}` : undefined;
  } catch {
    return undefined;
  }
}

function statePath(repo: string, kind: "ack" | "ci" | "count", prNumber: number): string | undefined {
  const metadata = gitMetadataDirectory(repo);
  return metadata ? join(metadata, `sdd-review-${kind}-pr-${prNumber}`) : undefined;
}

function readAck(repo: string, prNumber: number): string | undefined {
  const path = statePath(repo, "ack", prNumber);
  if (!path) return undefined;
  try {
    const value = readFileSync(path, "utf8").trim();
    return fullSha(value) ? value : undefined;
  } catch {
    try {
      const legacy = readFileSync(join(repo, ".git", "sdd-last-ack-pr-head"), "utf8").trim();
      return fullSha(legacy) ? legacy : undefined;
    } catch {
      return undefined;
    }
  }
}

function readCiHead(repo: string, prNumber: number): string | undefined {
  const path = statePath(repo, "ci", prNumber);
  if (!path) return undefined;
  try {
    const value = readFileSync(path, "utf8").trim();
    return fullSha(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function checkpointCi(repo: string, prNumber: number, head: string): boolean {
  const path = statePath(repo, "ci", prNumber);
  if (!path || !fullSha(head)) return false;
  try {
    writeFileSync(path, `${head}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function clearCount(repo: string, prNumber: number): void {
  const path = statePath(repo, "count", prNumber);
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // No counter is the normal state.
  }
}

function acknowledge(repo: string, prNumber: number, head: string): boolean {
  const path = statePath(repo, "ack", prNumber);
  if (!path || !fullSha(head)) return false;
  try {
    writeFileSync(path, `${head}\n`, "utf8");
    clearCount(repo, prNumber);
    return true;
  } catch {
    return false;
  }
}

function blockDecision(repo: string, prNumber: number, head: string): "block" | "giveup" {
  const path = statePath(repo, "count", prNumber);
  if (!path) return "giveup";
  let count = 0;
  try {
    const [storedHead, storedCount] = readFileSync(path, "utf8").trim().split(":", 2);
    if (storedHead === head) {
      if (storedCount === "GIVEUP") return "giveup";
      count = Number.parseInt(storedCount, 10) || 0;
    }
  } catch {
    // Start a fresh counter for this head.
  }
  try {
    if (count >= MAX_BLOCKS) {
      writeFileSync(path, `${head}:GIVEUP\n`, "utf8");
      return "giveup";
    }
    writeFileSync(path, `${head}:${count + 1}\n`, "utf8");
    return "block";
  } catch {
    return "giveup";
  }
}

type ClassifiedBoundary = {
  invocation: ShellInvocation;
  classification: ReturnType<typeof classifyReviewBoundaryCommand>;
  toolUseId: string;
};

function latestBoundary(event: any, sessionCwd: string): ClassifiedBoundary | undefined {
  const toolUseId = typeof event?.toolCallId === "string" ? event.toolCallId : undefined;
  if (!toolUseId) return undefined;
  return shellInvocations(event, sessionCwd)
    .map((invocation) => ({
      invocation,
      classification: classifyReviewBoundaryCommand(invocation.command),
      toolUseId,
    }))
    .filter(({ classification }) => classification.reminder)
    .at(-1);
}

function successful(event: any): boolean {
  return event?.isError !== true && event?.result?.isError !== true;
}

function bypassSentinelPresent(): boolean {
  return existsSync(BYPASS_FILE);
}

function consumeBypassSentinel(): boolean {
  if (!bypassSentinelPresent()) return false;
  try {
    unlinkSync(BYPASS_FILE);
    return true;
  } catch {
    return false;
  }
}

function rootSessionFile(ctx: ReviewContext): string | undefined {
  const file = sessionFile(ctx);
  return file && !isChildSession(ctx, file) ? file : undefined;
}

function boundaryContext(ctx: ReviewContext, preferredRepo?: string): { repo: string; file: string } | undefined {
  const file = rootSessionFile(ctx);
  if (!file) return undefined;
  const preferredRoot = preferredRepo ? findGitRoot(preferredRepo) : undefined;
  if (preferredRepo && !preferredRoot) return undefined;
  const rememberedRepo = recallActiveRepo();
  const repo = preferredRoot
    ?? findGitRoot(ctx.cwd)
    ?? (rememberedRepo ? findGitRoot(rememberedRepo) : undefined);
  return repo ? { repo, file } : undefined;
}

function reviewEnabled(repo: string): boolean {
  return process.env.SESSION_MODE !== "default"
    && isSddRepo(repo)
    && !isReviewTransitionSuspended(repo);
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function defaultDeferGoalPause(task: () => void | Promise<void>): void {
  setTimeout(() => { void task(); }, 0);
}

async function currentReview(
  ctx: ReviewContext,
  dependencies: Dependencies,
  target: string | undefined,
  revision = "HEAD",
  preferredRepo?: string,
  markRetryable?: () => void,
): Promise<{ repo: string; file: string; pr: PrState } | undefined> {
  const context = boundaryContext(ctx, preferredRepo);
  if (!context || !gitMetadataDirectory(context.repo)) return undefined;
  let branch = target;
  if (!branch) branch = await (dependencies.queryBranch ?? queryBranch)(context.repo);
  if (!branch) {
    markRetryable?.();
    return undefined;
  }
  const head = await (dependencies.queryHead ?? queryHead)(context.repo, revision);
  if (!head) {
    markRetryable?.();
    return undefined;
  }
  const delays = dependencies.headRetryDelaysMs ?? [0];
  const sleep = dependencies.sleep ?? defaultSleep;
  for (const delayMs of delays) {
    if (delayMs > 0) await sleep(delayMs);
    const pr = await dependencies.queryPr(context.repo, branch);
    if (pr === PR_LOOKUP_FAILED) {
      markRetryable?.();
      continue;
    }
    if (!isProtectedPr(pr) || pr.headRefName !== branch) return undefined;
    if (head === pr.headRefOid) return { ...context, pr };
    markRetryable?.();
  }
  return undefined;
}

type CiBoundaryEvent = ReviewBoundaryEvent;

type CiLaunchIdentity = {
  repo: string;
  pr: number;
  head: string;
  cwd: string;
};

type LaunchMessage = {
  phase: "plan" | "follow-up";
  repo: string;
  pr: PrState;
  boundaryToolUseId: string;
  ackHead?: string;
  range?: string;
  reviewers: ReviewLane[];
  ciEvent?: CiBoundaryEvent;
};

function ciBoundaryEvent(event: ReviewBoundaryEvent | undefined): CiBoundaryEvent | undefined {
  return event;
}

function ciLaunchIdentity(event: any): CiLaunchIdentity | undefined {
  if (!successful(event)
    || event?.toolName !== "subagent"
    || event?.input?.subagent_type !== "ci-monitor"
    || event?.input?.run_in_background !== true
    || event?.input?.inherit_context !== false
    || event?.details?.subagentType !== "ci-monitor"
    || typeof event?.input?.prompt !== "string") return undefined;
  try {
    const request = JSON.parse(event.input.prompt);
    return typeof request?.repo === "string"
      && Number.isInteger(request?.pr)
      && fullSha(request?.head)
      && typeof request?.cwd === "string"
      ? request as CiLaunchIdentity
      : undefined;
  } catch {
    return undefined;
  }
}

async function checkpointCiLaunch(
  event: any,
  ctx: ReviewContext,
  dependencies: Dependencies,
): Promise<boolean> {
  const request = ciLaunchIdentity(event);
  if (!request) return false;
  const context = boundaryContext(ctx, request.cwd);
  if (!context || request.cwd !== context.repo || !gitMetadataDirectory(context.repo)) return false;
  const [repository, branch, head, pr] = await Promise.all([
    githubRepository(context.repo),
    (dependencies.queryBranch ?? queryBranch)(context.repo),
    (dependencies.queryHead ?? queryHead)(context.repo, "HEAD"),
    dependencies.queryPr(context.repo, String(request.pr)),
  ]);
  if (repository !== request.repo
    || head !== request.head
    || pr === PR_LOOKUP_FAILED
    || !isEnforcedPr(pr)
    || branch !== pr.headRefName
    || pr.number !== request.pr
    || pr.headRefOid !== request.head) return false;
  return checkpointCi(context.repo, request.pr, request.head);
}

type BoundaryLaunch = { head: string; pauseGoal: boolean };
type BoundaryLaunchResult = BoundaryLaunch | "retry";

async function launchBoundaryPlan(
  pi: ReviewPi,
  ctx: ReviewContext,
  dependencies: Dependencies,
  boundary: ClassifiedBoundary,
  recoverExistingPlan = false,
): Promise<BoundaryLaunchResult | undefined> {
  const eventRepo = resolveShellInvocationRepo(boundary.invocation);
  if (!eventRepo) return undefined;
  let retryable = false;
  const review = await currentReview(
    ctx,
    dependencies,
    undefined,
    "HEAD",
    eventRepo,
    () => { retryable = true; },
  );
  if (!review) return retryable ? "retry" : undefined;
  if (!isEnforcedPr(review.pr)) return undefined;

  const reviewsEnabled = reviewEnabled(review.repo);
  const priorAckHead = readAck(review.repo, review.pr.number);
  if (priorAckHead === review.pr.headRefOid) return undefined;
  const skipReview = reviewsEnabled && bypassSentinelPresent();
  if (skipReview) {
    acknowledge(review.repo, review.pr.number, review.pr.headRefOid);
    if (!boundary.classification.settled) consumeBypassSentinel();
  }
  const range = reviewRange({ repo: review.repo, ackHead: priorAckHead, head: review.pr.headRefOid });
  const existing = transcriptFacts(ctx, review.file, [], undefined, review.pr.headRefOid);
  if (existing.reviewHead === review.pr.headRefOid
    && existing.reviewRange === range
    && existing.reviewRepo === review.repo
    && existing.reviewBranch === review.pr.headRefName
    && existing.reviewPrNumber === review.pr.number
    && existing.reviewBase === review.pr.baseRefName
    && !recoverExistingPlan) return undefined;
  let confirmedEvent = boundary.classification.event;
  if (reviewsEnabled && !skipReview && !confirmedEvent) {
    if (!ctx.hasUI || !ctx.ui) return undefined;
    let decision: string | undefined;
    while (decision !== "Launch review and CI" && decision !== "Acknowledge without review") {
      decision = await ctx.ui.select(
        `PR #${review.pr.number} (${review.pr.headRefName} at ${review.pr.headRefOid})`,
        ["Launch review and CI", "Acknowledge without review"],
      );
    }
    const refreshed = await currentReview(ctx, dependencies, undefined, "HEAD", eventRepo);
    if (!refreshed
      || refreshed.repo !== review.repo
      || refreshed.pr.number !== review.pr.number
      || refreshed.pr.baseRefName !== review.pr.baseRefName
      || refreshed.pr.headRefName !== review.pr.headRefName
      || refreshed.pr.headRefOid !== review.pr.headRefOid) return undefined;
    if (readAck(review.repo, review.pr.number) === review.pr.headRefOid) return undefined;
    if (decision === "Acknowledge without review") {
      acknowledge(review.repo, review.pr.number, review.pr.headRefOid);
      return undefined;
    }
    if (decision !== "Launch review and CI") return undefined;
    confirmedEvent = "push";
  }
  const ackHead = readAck(review.repo, review.pr.number);
  const requiredLanes = reviewsEnabled && !skipReview
    ? requiredReviewLanes({ repo: review.repo, ackHead, head: review.pr.headRefOid })
    : [];
  const ciEvent = readCiHead(review.repo, review.pr.number) === review.pr.headRefOid
    ? undefined
    : ciBoundaryEvent(confirmedEvent);
  if (requiredLanes.length === 0 && !ciEvent) return undefined;

  sendLaunchMessage(pi, {
    phase: "plan",
    repo: review.repo,
    pr: review.pr,
    boundaryToolUseId: boundary.toolUseId,
    ackHead,
    range,
    reviewers: requiredLanes,
    ciEvent,
  });
  return { head: review.pr.headRefOid, pauseGoal: requiredLanes.length > 0 };
}

function scopeSummary(pr: PrState, range: string | undefined): string {
  return range
    ? `diff · \`review_range=${range}\``
    : `full PR against \`origin/${pr.baseRefName}\``;
}

function reviewerPromptScope(pr: PrState, range: string | undefined): string {
  return range
    ? `\`scope=diff\` and \`review_range=${range}\``
    : `\`scope=diff\` and \`review_base=origin/${pr.baseRefName}\``;
}

function sendLaunchMessage(pi: ReviewPi, input: LaunchMessage): void {
  activateRegisteredTools(pi, ["subagent"]);
  const sections: string[] = [];
  const order: string[] = [];
  if (input.reviewers.length > 0) {
    order.push("REVIEWERS");
    sections.push([
      `### ${sections.length + 1}. Start reviewers together`,
      "",
      `- Agents: ${input.reviewers.map((lane) => `\`${lane}\``).join(", ")}`,
      "- Calls: public background subagents",
      "- `inherit_context`: `false`",
      `- Prompt scope: ${reviewerPromptScope(input.pr, input.range)}`,
    ].join("\n"));
  }
  if (input.ciEvent) {
    order.push("CI");
    sections.push([
      `### ${sections.length + 1}. Start CI immediately`,
      "",
      input.reviewers.length > 0
        ? "**Do not wait for reviewers to finish.**"
        : "No reviewer launch is required; start CI now.",
      "",
      "Run the `ci-monitoring` request resolver exactly once with:",
      "",
      `- \`event\`: \`${input.ciEvent}\``,
      "- `changed`: `true`",
      "- `repo`: `<owner/repo>`",
      `- \`pr\`: \`${input.pr.number}\``,
      `- \`head\`: \`${input.pr.headRefOid}\``,
      `- \`cwd\`: \`${input.repo}\``,
      `- \`reviewState\`: \`${input.reviewers.length > 0 ? "launched" : "not-required"}\``,
      "",
      "Submit its returned public `ci-monitor` subagent request unchanged exactly once.",
      "",
      "CI is independent of review acknowledgement.",
    ].join("\n"));
  }
  const lastLaunchSection = sections.length - 1;
  sections[lastLaunchSection] = [
    sections[lastLaunchSection],
    "",
    "**After the final launch:** End this turn immediately.",
    "",
    "Do not run `sleep`, foreground waits, polling, resume an in-flight agent, or retrieve an in-flight result.",
    "",
    "Let native task notifications drive subsequent turns.",
    "",
    "After a terminal notification, public result retrieval is allowed only when the report is truncated or otherwise unavailable.",
  ].join("\n");
  if (input.reviewers.length > 0) {
    order.push("TRIAGE + ACK", "FIX");
    sections.push([
      `### ${sections.length + 1}. Triage and acknowledge before fixing`,
      "",
      "**Triage turn:** publish the triage table; make no mutations; end the turn",
      "",
      "**Fix delivery:** next-turn follow-up after acknowledgement",
      "",
      "Wait for every required reviewer result, then publish one table:",
      "",
      REVIEW_TRIAGE_HEADER,
      REVIEW_TRIAGE_DIVIDER,
      "",
      "For every finding:",
      "",
      "- verify that it is evidence-backed and in scope",
      "- judge the finding separately from its proposed fix",
      "- reject unsupported or overengineered proposals",
      "- prefer the smallest correction that reuses existing machinery",
      "",
      "After publishing the table, make no file or Git changes and end the turn immediately. Settled enforcement acknowledges the reviewed head and starts the FIX phase in a separate follow-up turn.",
    ].join("\n"));
  }
  const title = input.phase === "follow-up"
    ? "## PR boundary follow-up — missing work"
    : input.reviewers.length > 0 && input.ciEvent
      ? "## PR boundary — review + CI"
      : input.reviewers.length > 0
        ? "## PR boundary — review"
        : "## PR boundary — CI";
  const status = [
    ...(input.reviewers.length === 0 ? ["**Review:** No reviewer launch is required for this boundary."] : []),
    ...(!input.ciEvent ? ["**CI:** No CI launch is required for this boundary."] : []),
    ...(input.phase === "follow-up"
      ? ["**Recovery rule:** Launch only the work listed below. Do not duplicate unmatched calls; they remain in flight until native completion."]
      : []),
  ];
  const content = [
    title,
    "",
    `**Order:** ${order.join(" → ")}`,
    "",
    "**Context**",
    "",
    `- PR: #${input.pr.number}`,
    `- Head: \`${input.pr.headRefOid}\``,
    `- Scope: ${scopeSummary(input.pr, input.range)}`,
    ...(status.length > 0 ? ["", ...status] : []),
    "",
    ...sections.flatMap((section, index) => index === sections.length - 1 ? [section] : [section, ""]),
  ].join("\n");
  const details: Record<string, unknown> = {
    repo: input.repo,
    branch: input.pr.headRefName,
    prNumber: input.pr.number,
    base: input.pr.baseRefName,
    boundaryToolUseId: input.boundaryToolUseId,
    launchTurn: {
      disposition: "stop-after-final-launch",
      handoff: "native-task-notifications",
    },
    head: input.pr.headRefOid,
    ackHead: input.ackHead,
    reviewRange: input.range,
    ...(input.phase === "plan" ? { scope: scopeContract("diff") } : {}),
    [input.phase === "plan" ? "requiredLanes" : "missingLanes"]: input.reviewers,
    launchWaves: [input.reviewers, ...(input.ciEvent ? [["ci-monitor"]] : [])],
    ciEvent: input.ciEvent,
  };
  pi.sendMessage({
    customType: input.phase === "plan" ? "pr-boundary-launch-plan" : "pr-boundary-launch-follow-up",
    content,
    display: true,
    details,
  }, { deliverAs: "followUp", triggerTurn: true });
}

function headDriftAlreadyReported(ctx: ReviewContext, reviewedHead: string, liveHead: string): boolean {
  return (liveEntries(ctx) ?? []).some((entry) => entry.type === "custom_message"
    && entry.customType === "pr-boundary-head-drift"
    && entry.details?.reviewedHead === reviewedHead
    && entry.details?.liveHead === liveHead);
}

function sendHeadDriftFollowUp(
  pi: ReviewPi,
  ctx: ReviewContext,
  pr: PrState,
  reviewedHead: string,
  range: string | undefined,
): void {
  if (headDriftAlreadyReported(ctx, reviewedHead, pr.headRefOid)) return;
  pi.sendMessage({
    customType: "pr-boundary-head-drift",
    content: [
      "## PR boundary — reviewed head superseded",
      "",
      `- Reviewed head: \`${reviewedHead}\``,
      `- Live PR head: \`${pr.headRefOid}\``,
      `- Scope: ${scopeSummary(pr, range)}`,
      "- Review acknowledgement: `not written`",
      "- FIX follow-up: `not started`",
      "",
      "The PR changed before acknowledgement, so the completed review cannot authorize fixes on the live head. Synchronize the checked-out PR branch, then let the next eligible Git boundary create one replacement review and CI plan for the live head.",
    ].join("\n"),
    display: true,
    details: { reviewedHead, liveHead: pr.headRefOid, prNumber: pr.number },
  }, { deliverAs: "followUp", triggerTurn: true });
}

async function sendFixFollowUp(
  pi: ReviewPi,
  ctx: ReviewContext,
  pr: PrState,
  range: string | undefined,
): Promise<void> {
  await releaseReviewGoalPause(pi, ctx, pr.headRefOid);
  pi.sendMessage({
    customType: "pr-boundary-fix-follow-up",
    content: [
      "## PR boundary — apply accepted fixes",
      "",
      "**Phase:** FIX",
      "",
      `- Head: \`${pr.headRefOid}\``,
      `- Scope: ${scopeSummary(pr, range)}`,
      "- Review acknowledgement: written",
      "",
      "Apply only the accepted minimal decisions from the preceding triage. The reviewed head is now acknowledged, so fixes may begin without relaunching review or CI for that head.",
    ].join("\n"),
    display: true,
    details: { head: pr.headRefOid, reviewRange: range },
  }, { deliverAs: "followUp", triggerTurn: true });
}

function liveEntries(ctx: ReviewContext): Record<string, any>[] | undefined {
  try {
    return ctx.sessionManager.getEntries?.();
  } catch {
    return undefined;
  }
}

function transcriptFacts(
  ctx: ReviewContext,
  file: string,
  requiredLanes: ReviewLane[],
  ci?: { repository: string; repo: string; prNumber: number; head: string },
  reviewHead?: string,
) {
  return reviewTranscriptFacts({
    sessionFile: file,
    entries: liveEntries(ctx),
    requiredLanes,
    ci,
    reviewHead,
  });
}

function persistedBoundary(ctx: ReviewContext, file: string): ClassifiedBoundary | undefined {
  const boundary = transcriptFacts(ctx, file, []).boundary;
  if (!boundary?.toolName || !boundary.toolArguments) return undefined;
  return shellInvocations({
    toolName: boundary.toolName,
    input: boundary.toolArguments,
  }, ctx.cwd)
    .map((invocation) => ({
      invocation,
      classification: classifyReviewBoundaryCommand(invocation.command),
      toolUseId: boundary.toolUseId,
    }))
    .filter(({ classification }) => classification.reminder)
    .at(-1);
}

function completedTriageReadyAfterResume(ctx: ReviewContext): boolean {
  const file = rootSessionFile(ctx);
  if (!file) return false;
  const preview = transcriptFacts(ctx, file, []);
  if (!fullSha(preview.reviewHead) || !preview.reviewRepo || !preview.reviewPrNumber) return false;
  const context = boundaryContext(ctx, preview.reviewRepo);
  if (!context) return false;
  const ackHead = readAck(context.repo, preview.reviewPrNumber);
  if (ackHead === preview.reviewHead) return false;
  const lanes = requiredReviewLanes({ repo: context.repo, ackHead, head: preview.reviewHead });
  return transcriptFacts(ctx, context.file, lanes, undefined, preview.reviewHead).triageComplete;
}

async function acknowledgeCompletedReview(
  pi: ReviewPi,
  ctx: ReviewContext,
  dependencies: Dependencies,
): Promise<boolean> {
  const file = rootSessionFile(ctx);
  if (!file) return false;
  const preview = transcriptFacts(ctx, file, []);
  if (!preview.boundary
    || !fullSha(preview.reviewHead)
    || !preview.reviewRepo
    || !preview.reviewBranch
    || !preview.reviewPrNumber
    || !preview.reviewBase
    || preview.reviewBoundaryToolUseId !== preview.boundary.toolUseId) return false;
  const context = boundaryContext(ctx, preview.reviewRepo);
  if (!context) return false;
  const classification = classifyReviewBoundaryCommand(preview.boundary.command);
  const reviewedPr = await dependencies.queryPr(context.repo, preview.reviewBranch);
  if (reviewedPr === PR_LOOKUP_FAILED
    || !isEnforcedPr(reviewedPr)
    || reviewedPr.number !== preview.reviewPrNumber
    || reviewedPr.baseRefName !== preview.reviewBase
    || reviewedPr.headRefName !== preview.reviewBranch
    || !reviewEnabled(context.repo)
    || preview.bypassed
    || bypassSentinelPresent()) return false;

  const reviewedHead = preview.reviewHead;
  const reviewedAck = readAck(context.repo, reviewedPr.number);
  if (reviewedAck === reviewedHead) return false;
  const reviewedRange = reviewRange({ repo: context.repo, ackHead: reviewedAck, head: reviewedHead });
  const reviewedLanes = requiredReviewLanes({ repo: context.repo, ackHead: reviewedAck, head: reviewedHead });
  const repository = await githubRepository(context.repo);
  const reviewedFacts = transcriptFacts(ctx, context.file, reviewedLanes, repository ? {
    repository,
    repo: context.repo,
    prNumber: reviewedPr.number,
    head: reviewedHead,
  } : undefined, reviewedHead);
  const allReviewedLanesTerminal = reviewedLanes.length > 0
    && reviewedLanes.every((lane) => reviewedFacts.lanes[lane].state === "terminal");
  if (reviewedFacts.reviewHead !== reviewedHead
    || reviewedFacts.reviewRange !== reviewedRange
    || reviewedFacts.reviewRepo !== context.repo
    || reviewedFacts.reviewBranch !== reviewedPr.headRefName
    || !allReviewedLanesTerminal
    || !reviewedFacts.triageComplete) return false;

  if (reviewedPr.headRefOid !== reviewedHead) {
    sendHeadDriftFollowUp(pi, ctx, reviewedPr, reviewedHead, reviewedRange);
    return false;
  }

  if (reviewedFacts.ciLaunched) checkpointCi(context.repo, reviewedPr.number, reviewedHead);
  if (!acknowledge(context.repo, reviewedPr.number, reviewedHead)) return false;
  const ciEvent = reviewedFacts.reviewCiEvent ?? ciBoundaryEvent(classification.event);
  if (!reviewedFacts.ciLaunched && ciEvent) {
    sendLaunchMessage(pi, {
      phase: "follow-up",
      repo: context.repo,
      pr: reviewedPr,
      boundaryToolUseId: preview.boundary.toolUseId,
      ackHead: reviewedHead,
      range: reviewedRange,
      reviewers: [],
      ciEvent,
    });
  }
  await sendFixFollowUp(pi, ctx, reviewedPr, reviewedRange);
  return true;
}

export function registerReviewEnforcement(pi: ReviewPi, dependencies: Dependencies): void {
  let resumedWithoutBoundary = false;
  let deferredSettledRecoveryHead: string | undefined;
  let pendingGoalPauseHead: string | undefined;
  let pendingBoundary: ClassifiedBoundary | undefined;

  const retryPendingBoundary = async (ctx: ReviewContext): Promise<void> => {
    const boundary = pendingBoundary;
    if (!boundary) return;
    const launch = await launchBoundaryPlan(pi, ctx, dependencies, boundary);
    if (launch === "retry") return;
    pendingBoundary = undefined;
    pi.appendEntry(BOUNDARY_EVALUATED_ENTRY_TYPE, { toolUseId: boundary.toolUseId });
    if (!launch) return;
    resumedWithoutBoundary = false;
    if (launch.pauseGoal) pendingGoalPauseHead = launch.head;
    deferredSettledRecoveryHead = launch.head;
  };

  pi.on("session_start", (event) => {
    resumedWithoutBoundary = event?.reason === "resume";
    deferredSettledRecoveryHead = undefined;
    pendingGoalPauseHead = undefined;
    pendingBoundary = undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!successful(event)) return;
    rememberActiveRepoFromToolResult(event, ctx.cwd);
    await checkpointCiLaunch(event, ctx, dependencies);
    const boundary = latestBoundary(event, ctx.cwd);
    if (!boundary || boundaryWasEvaluated(ctx, boundary.toolUseId)) return;
    const launch = await launchBoundaryPlan(pi, ctx, dependencies, boundary, resumedWithoutBoundary);
    if (launch === "retry") {
      pendingBoundary = boundary;
      return;
    }
    pi.appendEntry(BOUNDARY_EVALUATED_ENTRY_TYPE, { toolUseId: boundary.toolUseId });
    if (!launch) return;
    resumedWithoutBoundary = false;
    if (launch.pauseGoal) pendingGoalPauseHead = launch.head;
    deferredSettledRecoveryHead = launch.head;
  });

  pi.on("agent_end", async (_event, ctx) => {
    await retryPendingBoundary(ctx);
    const pauseHead = pendingGoalPauseHead;
    pendingGoalPauseHead = undefined;
    const goal = currentGoal(ctx);
    const owned = reviewGoalPause(ctx);
    const needsGoalPause = goal?.status === "active"
      || Boolean(owned?.goalId === goal?.id && goal?.status === "paused");
    if (!pauseHead || !needsGoalPause) {
      if (!resumedWithoutBoundary) await acknowledgeCompletedReview(pi, ctx, dependencies);
      return;
    }
    (dependencies.deferGoalPause ?? defaultDeferGoalPause)(async () => {
      try {
        await pauseGoalForReview(pi, ctx, pauseHead);
        if (!resumedWithoutBoundary) await acknowledgeCompletedReview(pi, ctx, dependencies);
      } catch {
        // Optional Goal control must not create an unhandled detached failure.
      }
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await retryPendingBoundary(ctx);
    const recoveryFile = rootSessionFile(ctx);
    if (resumedWithoutBoundary && recoveryFile) {
      const recoveryFacts = transcriptFacts(ctx, recoveryFile, []);
      if (recoveryFacts.boundary
        && recoveryFacts.reviewBoundaryToolUseId !== recoveryFacts.boundary.toolUseId
        && !boundaryWasEvaluated(ctx, recoveryFacts.boundary.toolUseId)) {
        const boundary = persistedBoundary(ctx, recoveryFile);
        if (boundary) {
          const launch = await launchBoundaryPlan(pi, ctx, dependencies, boundary);
          if (launch === "retry") {
            pendingBoundary = boundary;
            return;
          }
          if (launch) {
            pi.appendEntry(BOUNDARY_EVALUATED_ENTRY_TYPE, { toolUseId: boundary.toolUseId });
            resumedWithoutBoundary = false;
            if (launch.pauseGoal) pendingGoalPauseHead = launch.head;
            deferredSettledRecoveryHead = launch.head;
            return;
          }
        }
      }
    }
    if (resumedWithoutBoundary) {
      if (!completedTriageReadyAfterResume(ctx)) return;
      resumedWithoutBoundary = false;
    }
    if (await acknowledgeCompletedReview(pi, ctx, dependencies)) return;
    const file = rootSessionFile(ctx);
    if (!file) return;
    const preview = transcriptFacts(ctx, file, []);
    if (!preview.boundary
      || !fullSha(preview.reviewHead)
      || !preview.reviewRepo
      || !preview.reviewBranch
      || !preview.reviewPrNumber
      || !preview.reviewBase
      || preview.reviewBoundaryToolUseId !== preview.boundary.toolUseId) return;
    const context = boundaryContext(ctx, preview.reviewRepo);
    if (!context) return;
    const pr = await dependencies.queryPr(context.repo, preview.reviewBranch);
    if (pr === PR_LOOKUP_FAILED
      || !isProtectedPr(pr)
      || pr.number !== preview.reviewPrNumber
      || pr.baseRefName !== preview.reviewBase
      || pr.headRefName !== preview.reviewBranch
      || pr.headRefOid !== preview.reviewHead) return;
    const review = { ...context, pr };
    const reviewsEnabled = reviewEnabled(review.repo);
    const reviewIsOpen = isEnforcedPr(review.pr);
    const sentinelBypassed = reviewIsOpen && reviewsEnabled && consumeBypassSentinel();
    const bypassed = reviewIsOpen && reviewsEnabled && (preview.bypassed || sentinelBypassed);
    if (bypassed && !acknowledge(review.repo, review.pr.number, review.pr.headRefOid)) return;
    const ackHead = readAck(review.repo, review.pr.number);
    const range = reviewRange({ repo: review.repo, ackHead, head: review.pr.headRefOid });
    const shouldReview = reviewIsOpen
      && reviewsEnabled
      && !bypassed
      && ackHead !== review.pr.headRefOid;
    const requiredLanes = shouldReview
      ? requiredReviewLanes({ repo: review.repo, ackHead, head: review.pr.headRefOid })
      : [];
    const repository = await githubRepository(review.repo);
    const facts = transcriptFacts(ctx, review.file, requiredLanes, repository ? {
      repository,
      repo: review.repo,
      prNumber: review.pr.number,
      head: review.pr.headRefOid,
    } : undefined);
    if (!facts.boundary) return;
    if (facts.ciLaunched) checkpointCi(review.repo, review.pr.number, review.pr.headRefOid);
    if (deferredSettledRecoveryHead === review.pr.headRefOid) {
      const noLaunchesRecorded = !facts.ciLaunched
        && requiredLanes.every((lane) => facts.lanes[lane].state === "missing");
      deferredSettledRecoveryHead = undefined;
      if (reviewIsOpen && !bypassed && noLaunchesRecorded) return;
    }
    if (review.pr.state !== "OPEN") {
      await releaseReviewGoalPause(pi, ctx, review.pr.headRefOid);
      if (reviewEnabled(review.repo)
        && ackHead !== review.pr.headRefOid
        && !facts.closedNotified
        && classifyReviewBoundaryCommand(facts.boundary.command).settled) {
        pi.sendMessage({
          customType: "pr-boundary-review-closed-unacknowledged",
          content: [
            "## PR review — acknowledgement missing",
            "",
            `- Head: \`${review.pr.headRefOid}\``,
            `- PR state: \`${review.pr.state}\``,
            "- Acknowledgement written: `no`",
            "",
            "Review completion was not proven before the PR closed. This notice is visibility only; review the head manually if required.",
          ].join("\n"),
          display: true,
          details: { head: review.pr.headRefOid, state: review.pr.state },
        }, { triggerTurn: false });
      }
      return;
    }

    const ciEvent = facts.ciLaunched
      || readCiHead(review.repo, review.pr.number) === review.pr.headRefOid
      ? undefined
      : facts.reviewCiEvent ?? ciBoundaryEvent(classifyReviewBoundaryCommand(facts.boundary.command).event);
    if (shouldReview && requiredLanes.length === 0) acknowledge(review.repo, review.pr.number, review.pr.headRefOid);

    if (shouldReview && requiredLanes.length > 0
      && (facts.reviewHead !== review.pr.headRefOid || facts.reviewRange !== range)) {
      await pauseGoalForReview(pi, ctx, review.pr.headRefOid);
      sendLaunchMessage(pi, {
        phase: "plan",
        repo: review.repo,
        pr: review.pr,
        boundaryToolUseId: preview.boundary.toolUseId,
        ackHead,
        range,
        reviewers: requiredLanes,
        ciEvent,
      });
      deferredSettledRecoveryHead = review.pr.headRefOid;
      return;
    }

    const allReviewersTerminal = requiredLanes.length > 0
      && requiredLanes.every((lane) => facts.lanes[lane].state === "terminal");

    const missingLanes = allReviewersTerminal || !shouldReview
      ? []
      : requiredLanes.filter((lane): lane is ReviewLane => facts.lanes[lane].state === "missing");
    if (missingLanes.length === 0 && !ciEvent) return;
    if (missingLanes.length > 0 && blockDecision(review.repo, review.pr.number, review.pr.headRefOid) === "giveup") return;
    if (missingLanes.length > 0) {
      await pauseGoalForReview(pi, ctx, review.pr.headRefOid);
    }

    sendLaunchMessage(pi, {
      phase: "follow-up",
      repo: review.repo,
      pr: review.pr,
      boundaryToolUseId: preview.boundary.toolUseId,
      ackHead,
      range,
      reviewers: missingLanes,
      ciEvent,
    });
  });
}

export async function queryBranch(
  repo: string,
  runner: QueryPrRunner = execFileAsync,
): Promise<string | undefined> {
  try {
    const { stdout } = await runner(
      "git",
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { cwd: repo, encoding: "utf8", timeout: 10_000 },
    );
    const value = String(stdout).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export async function queryHead(
  repo: string,
  revision = "HEAD",
  runner: QueryPrRunner = execFileAsync,
): Promise<string | undefined> {
  try {
    const { stdout } = await runner(
      "git",
      ["rev-parse", revision],
      { cwd: repo, encoding: "utf8", timeout: 10_000 },
    );
    const value = String(stdout).trim();
    return fullSha(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function queryPr(
  repo: string,
  runner: QueryPrRunner = execFileAsync,
  target?: string,
): Promise<PrLookup> {
  try {
    const args = ["pr", "view", ...(target ? [target] : []), "--json", "state,baseRefName,headRefOid,headRefName,number,isDraft,mergeCommit"];
    const { stdout } = await runner(
      "gh",
      args,
      { cwd: repo, encoding: "utf8", timeout: 10_000 },
    );
    const value = JSON.parse(String(stdout)) as PrState;
    return isProtectedPr(value) ? value : undefined;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown })?.stderr ?? "");
    return /no pull requests found|could not resolve to a pullrequest/i.test(stderr)
      ? undefined
      : PR_LOOKUP_FAILED;
  }
}

export default function reviewEnforcement(pi: ExtensionAPI): void {
  registerReviewEnforcement(pi as unknown as ReviewPi, {
    queryPr: (repo, target) => queryPr(repo, execFileAsync, target),
    queryBranch: (repo) => queryBranch(repo, execFileAsync),
  });
}
