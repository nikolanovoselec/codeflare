import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
};

type Dependencies = {
  queryPr(repo: string, target?: string): Promise<PrState | undefined>;
  queryHead?(repo: string, revision?: string): Promise<string | undefined>;
  queryBranch?(repo: string): Promise<string | undefined>;
  queryPushBranch?(repo: string, branch: string, remote?: string): Promise<string | undefined>;
  sleep?(delayMs: number): Promise<void>;
  headRetryDelaysMs?: number[];
  deferGoalPause?(task: () => void | Promise<void>): void;
};

type ReviewContext = {
  cwd: string;
  sessionManager: {
    getSessionFile(): string | undefined;
    getBranch?(): Record<string, any>[];
    getEntries?(): Record<string, any>[];
    getHeader?(): { parentSession?: string } | undefined;
  };
  ui?: { notify(message: string, level?: "info" | "warning" | "error"): void };
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

function sessionEntries(ctx: ReviewContext): Record<string, any>[] {
  try {
    return ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
  } catch {
    return [];
  }
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

function gitMetadataDirectory(repo: string): string {
  const dotGit = join(repo, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const pointer = /^gitdir:\s*(.+)$/i.exec(readFileSync(dotGit, "utf8").trim())?.[1];
    return pointer ? resolve(repo, pointer) : dotGit;
  } catch {
    return dotGit;
  }
}

function ackPath(repo: string): string {
  return join(gitMetadataDirectory(repo), "sdd-last-ack-pr-head");
}

function countPath(repo: string): string {
  return join(gitMetadataDirectory(repo), "sdd-review-block-count");
}

function readAck(repo: string): string | undefined {
  try {
    const value = readFileSync(ackPath(repo), "utf8").trim();
    return fullSha(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function clearCount(repo: string): void {
  try {
    unlinkSync(countPath(repo));
  } catch {
    // No counter is the normal state.
  }
}

function acknowledge(repo: string, head: string): void {
  if (!fullSha(head)) return;
  writeFileSync(ackPath(repo), `${head}\n`, "utf8");
  clearCount(repo);
}

function blockDecision(repo: string, head: string): "block" | "giveup" {
  let count = 0;
  try {
    const [storedHead, storedCount] = readFileSync(countPath(repo), "utf8").trim().split(":", 2);
    if (storedHead === head) {
      if (storedCount === "GIVEUP") return "giveup";
      count = Number.parseInt(storedCount, 10) || 0;
    }
  } catch {
    // Start a fresh counter for this head.
  }
  if (count >= MAX_BLOCKS) {
    writeFileSync(countPath(repo), `${head}:GIVEUP\n`, "utf8");
    return "giveup";
  }
  writeFileSync(countPath(repo), `${head}:${count + 1}\n`, "utf8");
  return "block";
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
  resolvePushDestination = false,
  pushRemote?: string,
): Promise<{ repo: string; file: string; pr: PrState } | undefined> {
  const context = boundaryContext(ctx, preferredRepo);
  if (!context) return undefined;
  let branch = target;
  if (!branch) {
    const localBranch = await (dependencies.queryBranch ?? queryBranch)(context.repo);
    if (!localBranch) return undefined;
    if (!resolvePushDestination) branch = localBranch;
    else if (dependencies.queryPushBranch) {
      branch = await dependencies.queryPushBranch(context.repo, localBranch, pushRemote);
    } else {
      branch = await queryPushBranch(context.repo, localBranch, execFileAsync, pushRemote);
    }
  }
  if (!branch) return undefined;
  const head = await (dependencies.queryHead ?? queryHead)(context.repo, revision);
  if (!head) return undefined;
  const delays = dependencies.headRetryDelaysMs ?? [0, 250, 1_000];
  const sleep = dependencies.sleep ?? defaultSleep;
  for (const delayMs of delays) {
    if (delayMs > 0) await sleep(delayMs);
    const pr = await dependencies.queryPr(context.repo, branch);
    if (!isProtectedPr(pr) || pr.headRefName !== branch) continue;
    if (head === pr.headRefOid) return { ...context, pr };
  }
  return undefined;
}

type CiBoundaryEvent = "push" | "pr-create";

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
  return event === "push" || event === "pr-create" ? event : undefined;
}

async function launchBoundaryPlan(
  pi: ReviewPi,
  ctx: ReviewContext,
  dependencies: Dependencies,
  boundary: ClassifiedBoundary,
): Promise<{ head: string; pauseGoal: boolean } | undefined> {
  const eventRepo = resolveShellInvocationRepo(boundary.invocation);
  if (!eventRepo) return undefined;
  const target = boundary.classification.event === "push"
    ? boundary.classification.pushTarget
    : undefined;
  const revision = boundary.classification.event === "push"
    ? boundary.classification.pushSource ?? "HEAD"
    : "HEAD";
  const review = await currentReview(
    ctx,
    dependencies,
    target,
    revision,
    eventRepo,
    boundary.classification.event === "push" && !target,
    boundary.classification.pushRemote,
  );
  if (!review || !isEnforcedPr(review.pr)) return undefined;

  const reviewsEnabled = reviewEnabled(review.repo);
  const skipReview = reviewsEnabled && bypassSentinelPresent();
  if (skipReview) {
    acknowledge(review.repo, review.pr.headRefOid);
    if (!boundary.classification.settled) consumeBypassSentinel();
  }
  const ackHead = readAck(review.repo);
  const range = reviewRange({ repo: review.repo, ackHead, head: review.pr.headRefOid });
  const requiredLanes = reviewsEnabled && !skipReview && ackHead !== review.pr.headRefOid
    ? requiredReviewLanes({ repo: review.repo, ackHead, head: review.pr.headRefOid })
    : [];
  const ciEvent = ciBoundaryEvent(boundary.classification.event);
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
  ciHead?: string,
) {
  return reviewTranscriptFacts({
    sessionFile: file,
    entries: liveEntries(ctx),
    requiredLanes,
    ciHead,
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
  if (!fullSha(preview.reviewHead) || !preview.reviewRepo) return false;
  const context = boundaryContext(ctx, preview.reviewRepo);
  if (!context) return false;
  const ackHead = readAck(context.repo);
  if (ackHead === preview.reviewHead) return false;
  const lanes = requiredReviewLanes({ repo: context.repo, ackHead, head: preview.reviewHead });
  return transcriptFacts(ctx, context.file, lanes, preview.reviewHead).triageComplete;
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
  if (!isEnforcedPr(reviewedPr)
    || reviewedPr.number !== preview.reviewPrNumber
    || reviewedPr.baseRefName !== preview.reviewBase
    || reviewedPr.headRefName !== preview.reviewBranch
    || reviewedPr.headRefOid !== preview.reviewHead
    || !reviewEnabled(context.repo)
    || preview.bypassed
    || bypassSentinelPresent()) return false;

  const reviewedHead = preview.reviewHead;
  const reviewedAck = readAck(context.repo);
  if (reviewedAck === reviewedHead) return false;
  const reviewedRange = reviewRange({ repo: context.repo, ackHead: reviewedAck, head: reviewedHead });
  const reviewedLanes = requiredReviewLanes({ repo: context.repo, ackHead: reviewedAck, head: reviewedHead });
  const reviewedFacts = transcriptFacts(ctx, context.file, reviewedLanes, reviewedHead);
  const allReviewedLanesTerminal = reviewedLanes.length > 0
    && reviewedLanes.every((lane) => reviewedFacts.lanes[lane].state === "terminal");
  if (reviewedFacts.reviewHead !== reviewedHead
    || reviewedFacts.reviewRange !== reviewedRange
    || reviewedFacts.reviewRepo !== context.repo
    || reviewedFacts.reviewBranch !== reviewedPr.headRefName
    || !allReviewedLanesTerminal
    || !reviewedFacts.triageComplete) return false;

  acknowledge(context.repo, reviewedHead);
  const ciEvent = ciBoundaryEvent(classification.event);
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

  pi.on("session_start", (event) => {
    resumedWithoutBoundary = event?.reason === "resume";
    deferredSettledRecoveryHead = undefined;
    pendingGoalPauseHead = undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!successful(event)) return;
    rememberActiveRepoFromToolResult(event, ctx.cwd);
    const boundary = latestBoundary(event, ctx.cwd);
    if (!boundary) return;
    const launch = await launchBoundaryPlan(pi, ctx, dependencies, boundary);
    pi.appendEntry(BOUNDARY_EVALUATED_ENTRY_TYPE, { toolUseId: boundary.toolUseId });
    if (!launch) return;
    resumedWithoutBoundary = false;
    if (launch.pauseGoal) pendingGoalPauseHead = launch.head;
    deferredSettledRecoveryHead = launch.head;
  });

  pi.on("agent_end", async (_event, ctx) => {
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
    const recoveryFile = rootSessionFile(ctx);
    if (resumedWithoutBoundary && recoveryFile) {
      const recoveryFacts = transcriptFacts(ctx, recoveryFile, []);
      if (recoveryFacts.boundary
        && recoveryFacts.reviewBoundaryToolUseId !== recoveryFacts.boundary.toolUseId
        && !boundaryWasEvaluated(ctx, recoveryFacts.boundary.toolUseId)) {
        const boundary = persistedBoundary(ctx, recoveryFile);
        const launch = boundary
          ? await launchBoundaryPlan(pi, ctx, dependencies, boundary)
          : undefined;
        if (launch) {
          resumedWithoutBoundary = false;
          if (launch.pauseGoal) pendingGoalPauseHead = launch.head;
          deferredSettledRecoveryHead = launch.head;
          return;
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
    if (!isProtectedPr(pr)
      || pr.number !== preview.reviewPrNumber
      || pr.baseRefName !== preview.reviewBase
      || pr.headRefName !== preview.reviewBranch
      || pr.headRefOid !== preview.reviewHead) return;
    const review = { ...context, pr };
    const reviewsEnabled = reviewEnabled(review.repo);
    const reviewIsOpen = isEnforcedPr(review.pr);
    const sentinelBypassed = reviewIsOpen && reviewsEnabled && consumeBypassSentinel();
    const bypassed = reviewIsOpen && reviewsEnabled && (preview.bypassed || sentinelBypassed);
    if (bypassed) acknowledge(review.repo, review.pr.headRefOid);
    const ackHead = readAck(review.repo);
    const range = reviewRange({ repo: review.repo, ackHead, head: review.pr.headRefOid });
    const shouldReview = reviewIsOpen
      && reviewsEnabled
      && !bypassed
      && ackHead !== review.pr.headRefOid;
    const requiredLanes = shouldReview
      ? requiredReviewLanes({ repo: review.repo, ackHead, head: review.pr.headRefOid })
      : [];
    const facts = transcriptFacts(ctx, review.file, requiredLanes, review.pr.headRefOid);
    if (!facts.boundary) return;
    if (deferredSettledRecoveryHead === review.pr.headRefOid) {
      const noLaunchesRecorded = !facts.ciLaunched
        && requiredLanes.every((lane) => facts.lanes[lane].state === "missing");
      deferredSettledRecoveryHead = undefined;
      if (reviewIsOpen && !bypassed && noLaunchesRecorded) return;
    }
    if (review.pr.state !== "OPEN") {
      await releaseReviewGoalPause(pi, ctx, review.pr.headRefOid);
      if (reviewEnabled(review.repo) && !facts.closedNotified && classifyReviewBoundaryCommand(facts.boundary.command).settled) {
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
      ? undefined
      : ciBoundaryEvent(classifyReviewBoundaryCommand(facts.boundary.command).event);
    if (shouldReview && requiredLanes.length === 0) acknowledge(review.repo, review.pr.headRefOid);

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
    if (missingLanes.length > 0 && blockDecision(review.repo, review.pr.headRefOid) === "giveup") return;
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

export async function queryPushBranch(
  repo: string,
  branch: string,
  runner: QueryPrRunner = execFileAsync,
  remote?: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await runner(
      "git",
      [
        ...(remote ? ["-c", `branch.${branch}.pushRemote=${remote}`] : []),
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        `${branch}@{push}`,
      ],
      { cwd: repo, encoding: "utf8", timeout: 10_000 },
    );
    const pushRefs = String(stdout).trim().split("\n").filter(Boolean);
    const pushRef = pushRefs.length === 1 ? pushRefs[0] : undefined;
    if (!pushRef || pushRef.startsWith("refs/")) return undefined;
    if (remote) return pushRef.startsWith(`${remote}/`)
      ? pushRef.slice(remote.length + 1) || undefined
      : undefined;
    const separator = pushRef.indexOf("/");
    return separator > 0 ? pushRef.slice(separator + 1) || undefined : undefined;
  } catch {
    return undefined;
  }
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
): Promise<PrState | undefined> {
  try {
    const args = ["pr", "view", ...(target ? [target] : []), "--json", "state,baseRefName,headRefOid,headRefName,number,isDraft"];
    const { stdout } = await runner(
      "gh",
      args,
      { cwd: repo, encoding: "utf8", timeout: 10_000 },
    );
    const value = JSON.parse(String(stdout)) as PrState;
    return isProtectedPr(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export default function reviewEnforcement(pi: ExtensionAPI): void {
  registerReviewEnforcement(pi as unknown as ReviewPi, {
    queryPr: (repo, target) => queryPr(repo, execFileAsync, target),
    queryBranch: (repo) => queryBranch(repo, execFileAsync),
    queryPushBranch: (repo, branch, remote) => queryPushBranch(repo, branch, execFileAsync, remote),
  });
}
