import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cloneTargetHadGit, cloneTargetPath, rememberCloneTargetHadGit } from "./graphify-helpers";
import {
  findGitRoot,
  rememberActiveRepoFromToolResult,
  resolveShellInvocationRepo,
  shellInvocations,
  type ShellInvocation,
} from "./active-repo-memory";
import { activateRegisteredTools, type ToolActivationPi } from "./capability-helpers";
import {
  latestAncestorCompletion,
  pruneCompletionState,
  readCompletion,
  requestCompletionSync,
  writeCompletion,
  type ReviewIdentity,
} from "./review-completion-state";
import {
  classifyReviewBoundaryCommand,
  exposureTargetsCheckedOutBranch,
  REVIEW_TRIAGE_DIVIDER,
  REVIEW_TRIAGE_HEADER,
  isReviewMergeCommand,
  isReviewTransitionSuspended,
  requiredReviewLanes,
  reviewRange,
  reviewTranscriptFacts,
  type ReviewBoundaryEvent,
  type ReviewLane,
  type ReviewLaunchIssue,
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

type RepositoryIdentity = { gitHost: string; repository: string };

export const PR_LOOKUP_FAILED = Symbol("pr-lookup-failed");
type PrLookup = PrState | undefined | typeof PR_LOOKUP_FAILED;

type Dependencies = {
  queryPr(repo: string, target?: string): Promise<PrLookup>;
  queryHead?(repo: string, revision?: string): Promise<string | undefined>;
  queryBranch?(repo: string): Promise<string | undefined>;
  queryRepository?(repo: string): Promise<RepositoryIdentity | undefined>;
  sleep?(delayMs: number): Promise<void>;
  headRetryDelaysMs?: number[];
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
  on(event: "session_start" | "tool_call" | "tool_execution_start" | "tool_result" | "agent_end" | "agent_settled", handler: (event: any, ctx: ReviewContext) => void | Promise<void>): void;
  events: { emit(channel: string, payload: unknown): void };
  appendEntry(customType: string, data: unknown): void;
  sendMessage(
    message: { customType: string; content?: string; details?: Record<string, unknown>; display?: boolean },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
};

type QueryRunner = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: "utf8"; timeout: number },
) => Promise<{ stdout: string | Buffer }>;

const execFileAsync = promisify(execFile) as unknown as QueryRunner;
const GOAL_STATE_ENTRY_TYPE = "goal-state";
const REVIEW_GOAL_PAUSE_ENTRY_TYPE = "pr-boundary-goal-pause";
const GOAL_CONTROL_CHANNEL = "codeflare:pi-goal:control";
const MARK_COMPLETE = "Mark review complete";
const LAUNCH_REVIEW = "Launch review";
let globalPrunePerformed = false;

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

function currentGoal(ctx: ReviewContext): GoalSnapshot | undefined {
  const goal = sessionEntries(ctx)
    .filter((entry) => entry?.type === "custom" && entry.customType === GOAL_STATE_ENTRY_TYPE)
    .at(-1)?.data?.goal;
  return goal && typeof goal.id === "string" && typeof goal.status === "string"
    ? { id: goal.id, status: goal.status }
    : undefined;
}

function reviewGoalPause(ctx: ReviewContext): ReviewGoalPause | undefined {
  const data = sessionEntries(ctx)
    .filter((entry) => entry?.type === "custom" && entry.customType === REVIEW_GOAL_PAUSE_ENTRY_TYPE)
    .at(-1)?.data;
  return data && fullSha(data.head) && typeof data.goalId === "string"
    ? data as ReviewGoalPause
    : undefined;
}

function clearReviewGoalPause(pi: ReviewPi): void {
  try {
    pi.appendEntry(REVIEW_GOAL_PAUSE_ENTRY_TYPE, null);
  } catch {
    // Goal integration is optional.
  }
}

async function requestGoalControl(
  pi: ReviewPi,
  action: "pause" | "resume",
  goalId: string,
): Promise<GoalControlResult | undefined> {
  let accepted = false;
  let resolveResponse: (result: GoalControlResult | undefined) => void = () => {};
  const response = new Promise<GoalControlResult | undefined>((resolve) => { resolveResponse = resolve; });
  try {
    pi.events.emit(GOAL_CONTROL_CHANNEL, {
      action,
      goalId,
      accepted: () => { accepted = true; },
      respond: (result: GoalControlResult) => {
        resolveResponse(result && typeof result.ok === "boolean"
          && typeof result.goalId === "string"
          && typeof result.status === "string" ? result : undefined);
      },
    });
  } catch {
    return undefined;
  }
  return accepted ? response : undefined;
}

async function pauseGoalForReview(pi: ReviewPi, ctx: ReviewContext, head: string): Promise<void> {
  const goal = currentGoal(ctx);
  if (!goal || goal.status !== "active") return;
  try {
    pi.appendEntry(REVIEW_GOAL_PAUSE_ENTRY_TYPE, { head, goalId: goal.id } satisfies ReviewGoalPause);
  } catch {
    return;
  }
  const result = await requestGoalControl(pi, "pause", goal.id);
  if (!result?.ok || result.status !== "paused") clearReviewGoalPause(pi);
}

async function releaseReviewGoalPause(pi: ReviewPi, ctx: ReviewContext, head?: string): Promise<boolean> {
  const owned = reviewGoalPause(ctx);
  if (!owned || (head && owned.head !== head)) return true;
  const goal = currentGoal(ctx);
  if (!goal || goal.id !== owned.goalId || goal.status !== "paused") {
    clearReviewGoalPause(pi);
    return true;
  }
  const result = await requestGoalControl(pi, "resume", goal.id);
  if (!result?.ok || result.status !== "active") return false;
  clearReviewGoalPause(pi);
  return true;
}

function fullSha(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{40}$/.test(value));
}

function isProtectedPr(pr: PrState | undefined): pr is PrState {
  return Boolean(pr
    && ["OPEN", "CLOSED", "MERGED"].includes(pr.state)
    && (pr.baseRefName === "main" || pr.baseRefName === "master" || pr.baseRefName === "develop")
    && fullSha(pr.headRefOid));
}

function isEnforcedPr(pr: PrState | undefined): pr is PrState {
  return isProtectedPr(pr) && pr.state === "OPEN";
}

function isSddRepo(repo: string): boolean {
  return existsSync(join(repo, "sdd", "README.md"));
}

function rootSessionFile(ctx: ReviewContext): string | undefined {
  const file = ctx.sessionManager.getSessionFile();
  if (typeof file !== "string" || !file) return undefined;
  const liveHeader = ctx.sessionManager.getHeader?.();
  if (liveHeader) return liveHeader.parentSession ? undefined : file;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const buffer = Buffer.alloc(16_384);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    const header = JSON.parse(buffer.subarray(0, bytes).toString("utf8").split("\n", 1)[0]);
    return header?.type === "session" && !header.parentSession ? file : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function reviewEnabled(repo: string): boolean {
  return process.env.SESSION_MODE !== "default"
    && isSddRepo(repo)
    && !isReviewTransitionSuspended(repo);
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

type CurrentReview = {
  repo: string;
  file: string;
  pr: PrState;
  identity: ReviewIdentity;
  repository: string;
};

async function currentReview(
  ctx: ReviewContext,
  dependencies: Dependencies,
  repo: string,
  ciEvent?: ReviewBoundaryEvent,
  command?: string,
): Promise<CurrentReview | undefined> {
  const file = rootSessionFile(ctx);
  const root = findGitRoot(repo);
  if (!file || !root || !reviewEnabled(root)) return undefined;
  const branch = await (dependencies.queryBranch ?? queryBranch)(root);
  const head = await (dependencies.queryHead ?? queryHead)(root, "HEAD");
  const repositoryIdentity = await (dependencies.queryRepository ?? queryRepository)(root);
  if (!branch || !head || !repositoryIdentity) return undefined;
  const delays = ciEvent
    ? dependencies.headRetryDelaysMs ?? [0, 1_000, 3_000, 5_000, 10_000, 15_000]
    : [0];
  const sleep = dependencies.sleep ?? defaultSleep;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    const pr = await dependencies.queryPr(root, branch);
    if (pr === PR_LOOKUP_FAILED) return undefined;
    if (!isEnforcedPr(pr) || pr.headRefName !== branch) return undefined;
    if (ciEvent && command && !exposureTargetsCheckedOutBranch(command, {
      branch: pr.headRefName,
      pr: pr.number,
      repository: repositoryIdentity.repository,
    })) return undefined;
    if (pr.headRefOid !== head) {
      if (!ciEvent) return undefined;
      continue;
    }
    return {
      repo: root,
      file,
      pr,
      repository: repositoryIdentity.repository,
      identity: {
        ...repositoryIdentity,
        pr: pr.number,
        branch: pr.headRefName,
        base: pr.baseRefName,
        head: pr.headRefOid,
      },
    };
  }
  return undefined;
}

type ClassifiedBoundary = {
  invocation: ShellInvocation;
  classification: ReturnType<typeof classifyReviewBoundaryCommand>;
  toolUseId: string;
  repo?: string;
  cloneTargetPreexisted?: boolean;
};

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(resultText).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return ["text", "content", "message", "stdout", "stderr", "error", "result"]
    .map((key) => resultText(record[key])).filter(Boolean).join("\n");
}

function latestBoundary(event: any, sessionCwd: string): ClassifiedBoundary | undefined {
  const toolUseId = typeof event?.toolCallId === "string" ? event.toolCallId : undefined;
  if (!toolUseId) return undefined;
  return shellInvocations(event, sessionCwd)
    .map((invocation) => {
      const classification = classifyReviewBoundaryCommand(invocation.command);
      const clonedPath = classification.clone
        ? cloneTargetPath(invocation.command, invocation.cwd, resultText(event))
        : undefined;
      return {
        invocation,
        classification,
        toolUseId,
        repo: clonedPath ? findGitRoot(clonedPath) : undefined,
        cloneTargetPreexisted: classification.clone && clonedPath !== undefined
          && cloneTargetHadGit(toolUseId, clonedPath) === true,
      };
    })
    .filter(({ classification, repo }) => classification.reminder && (!classification.clone || repo))
    .at(-1);
}

function successful(event: any): boolean {
  return event?.isError !== true && event?.result?.isError !== true;
}

function sameIdentity(left: ReviewIdentity, right: ReviewIdentity): boolean {
  return left.gitHost === right.gitHost
    && left.repository === right.repository
    && left.pr === right.pr
    && left.branch === right.branch
    && left.base === right.base
    && left.head === right.head;
}

function scopeSummary(pr: PrState, range: string | undefined): string {
  return range ? `diff · \`review_range=${range}\`` : `full PR against \`origin/${pr.baseRefName}\``;
}

function reviewerScopeAssignment(pr: PrState, range: string | undefined): string {
  return range ? `review_range=${range}` : `review_base=origin/${pr.baseRefName}`;
}

function reviewerOutputPath(pr: PrState, lane: ReviewLane): string {
  return `/tmp/codeflare-pr-${pr.number}-${pr.headRefOid.slice(0, 12)}-${lane}.md`;
}

function reviewerPromptContract(pr: PrState, range: string | undefined, lane: ReviewLane): string[] {
  return [
    `- \`${lane}\``,
    "```text",
    "scope=diff",
    reviewerScopeAssignment(pr, range),
    `output_file=${reviewerOutputPath(pr, lane)}`,
    "```",
  ];
}

type LaunchMessage = {
  repo: string;
  pr: PrState;
  boundaryToolUseId: string;
  ackHead?: string;
  range?: string;
  reviewers: ReviewLane[];
  ciEvent?: ReviewBoundaryEvent;
};

function sendLaunchMessage(pi: ReviewPi, input: LaunchMessage): void {
  activateRegisteredTools(pi, ["subagent"]);
  const sections: string[] = [];
  const order: string[] = [];
  if (input.reviewers.length > 0) {
    order.push("REVIEWERS");
    sections.push([
      `### ${sections.length + 1}. Start reviewers together`, "",
      `- Agents: ${input.reviewers.map((lane) => `\`${lane}\``).join(", ")}`,
      "- Calls: public background subagents",
      "- `inherit_context`: `false`",
      "- Copy each lane's three assignment lines unchanged into its prompt:",
      ...input.reviewers.flatMap((lane) => reviewerPromptContract(input.pr, input.range, lane)),
      "- Keep every assignment on its own line. Do not add punctuation or Markdown delimiters to assignment values.",
    ].join("\n"));
  }
  if (input.ciEvent) {
    order.push("CI");
    sections.push([
      `### ${sections.length + 1}. Start CI immediately`, "",
      input.reviewers.length > 0 ? "**Do not wait for reviewers to finish.**" : "No reviewer launch is required; start CI now.", "",
      "Run the `ci-monitoring` request resolver exactly once with:", "",
      `- \`event\`: \`${input.ciEvent}\``,
      "- `changed`: `true`",
      "- `repo`: `<owner/repo>`",
      `- \`pr\`: \`${input.pr.number}\``,
      `- \`head\`: \`${input.pr.headRefOid}\``,
      `- \`cwd\`: \`${input.repo}\``,
      `- \`reviewState\`: \`${input.reviewers.length > 0 ? "launched" : "not-required"}\``, "",
      "Submit its returned public `ci-monitor` subagent request unchanged exactly once.", "",
      input.reviewers.length > 0
        ? "CI success, failure, or timeout is terminal evidence for joint triage."
        : "CI is independent of review completion.",
    ].join("\n"));
  }
  if (sections.length === 0) return;
  sections[sections.length - 1] = [
    sections.at(-1), "", "**After the final launch:** End this turn immediately.", "",
    "Do not poll or retrieve in-flight results. Let native task notifications drive subsequent turns.",
  ].join("\n");
  if (input.reviewers.length > 0) {
    order.push("JOINT TRIAGE", "FIX");
    sections.push([
      `### ${sections.length + 1}. Triage before fixing`, "",
      input.ciEvent
        ? "Wait for every required reviewer and terminal exact-head CI evidence, then publish one joint table:"
        : "Wait for every required reviewer result, then publish one joint table:", "",
      REVIEW_TRIAGE_HEADER, REVIEW_TRIAGE_DIVIDER, "",
      ...(input.ciEvent
        ? ["CI failure or timeout requires FINDING `Exact-head CI` and PROPOSED FIX `CI_RESULT failure` or `CI_RESULT timeout`.", ""]
        : []),
      "For every finding:", "",
      "- verify that it is evidence-backed and in scope",
      "- judge the finding separately from its proposed fix",
      "- reject unsupported or overengineered proposals",
      "- prefer the smallest correction that reuses existing machinery", "",
      "Make no file or Git changes in the triage turn. End the turn immediately.",
    ].join("\n"));
  }
  pi.sendMessage({
    customType: "pr-boundary-launch-plan",
    content: [
      input.reviewers.length > 0 ? "## PR boundary — review" : "## PR boundary — CI", "",
      `**Order:** ${order.join(" → ")}`, "",
      "**Context**", "",
      `- PR: #${input.pr.number}`,
      `- Head: \`${input.pr.headRefOid}\``,
      `- Scope: ${scopeSummary(input.pr, input.range)}`, "",
      ...sections.flatMap((section, index) => index === sections.length - 1 ? [section] : [section, ""]),
    ].join("\n"),
    display: true,
    details: {
      repo: input.repo,
      branch: input.pr.headRefName,
      prNumber: input.pr.number,
      base: input.pr.baseRefName,
      boundaryToolUseId: input.boundaryToolUseId,
      head: input.pr.headRefOid,
      ackHead: input.ackHead,
      reviewRange: input.range,
      scope: scopeContract("diff"),
      requiredLanes: input.reviewers,
      launchWaves: [input.reviewers, ...(input.ciEvent ? [["ci-monitor"]] : [])],
      ciEvent: input.ciEvent,
    },
  }, { deliverAs: "followUp", triggerTurn: true });
}

function sendTriageCorrectionFollowUp(
  pi: ReviewPi,
  round: ActiveRound,
  ciResult: "failure" | "timeout",
): void {
  pi.sendMessage({
    customType: "pr-boundary-triage-correction",
    content: [
      "## PR boundary — correct joint triage", "",
      `Exact-head CI ended with \`${ciResult}\`, but the triage table did not include the required exact CI row.`, "",
      REVIEW_TRIAGE_HEADER,
      REVIEW_TRIAGE_DIVIDER,
      `| Exact-head CI | Terminal exact-head ${ciResult} | \`CI_RESULT ${ciResult}\` | Required exact contract | Address exact-head CI before FIX |`, "",
      "Republish the complete tool-free joint triage table with that exact FINDING and PROPOSED FIX. Make no file or Git changes. End the turn immediately.",
    ].join("\n"),
    display: true,
    details: { head: round.identity.head, reviewRange: round.range, boundaryToolUseId: round.boundaryToolUseId, ciResult },
  }, { deliverAs: "followUp", triggerTurn: true });
}

function sendLaunchRejectionFollowUp(
  pi: ReviewPi,
  round: ActiveRound,
  issue: ReviewLaunchIssue,
): void {
  pi.sendMessage({
    customType: "pr-boundary-launch-rejection",
    content: [
      "## PR boundary — rejected launch", "",
      `The \`${issue.target}\` launch was not credited for head \`${round.identity.head}\`:`, "",
      ...issue.problems.map((problem) => `- ${problem}`), "",
      "Correct and relaunch only this rejected target. Review and CI completion remain pending.",
    ].join("\n"),
    display: true,
    details: {
      head: round.identity.head,
      reviewRange: round.range,
      boundaryToolUseId: round.boundaryToolUseId,
      launchToolUseId: issue.toolUseId,
      target: issue.target,
      problems: issue.problems,
    },
  }, { deliverAs: "followUp", triggerTurn: true });
}

async function sendFixFollowUp(
  pi: ReviewPi,
  ctx: ReviewContext,
  round: ActiveRound,
): Promise<void> {
  await releaseReviewGoalPause(pi, ctx, round.identity.head);
  pi.sendMessage({
    customType: "pr-boundary-fix-follow-up",
    content: [
      "## PR boundary — apply accepted fixes", "", "**Phase:** FIX", "",
      `- Head: \`${round.identity.head}\``,
      `- Scope: ${scopeSummary(round.pr, round.range)}`,
      "- Review completion: saved", "",
      "Apply only accepted minimal decisions from the preceding triage.",
    ].join("\n"),
    display: true,
    details: { head: round.identity.head, reviewRange: round.range, boundaryToolUseId: round.boundaryToolUseId },
  }, { deliverAs: "followUp", triggerTurn: true });
}

type ActiveRound = {
  repo: string;
  file: string;
  pr: PrState;
  identity: ReviewIdentity;
  repository: string;
  boundaryToolUseId: string;
  range?: string;
  ackHead?: string;
  reviewers: ReviewLane[];
  ciEvent?: ReviewBoundaryEvent;
  ignoreAgentEnds: number;
  triageCorrectionDelivered: boolean;
  launchRejectionsDelivered: Set<string>;
};

function liveEntries(ctx: ReviewContext): Record<string, any>[] | undefined {
  try {
    return ctx.sessionManager.getEntries?.();
  } catch {
    return undefined;
  }
}

function roundFacts(ctx: ReviewContext, round: ActiveRound) {
  return reviewTranscriptFacts({
    sessionFile: round.file,
    entries: liveEntries(ctx),
    requiredLanes: round.reviewers,
    ci: {
      repository: round.repository,
      repo: round.repo,
      prNumber: round.pr.number,
      head: round.identity.head,
    },
    reviewHead: round.identity.head,
    activeBoundaryToolUseId: round.boundaryToolUseId,
  });
}

function statusReason(status: ReturnType<typeof readCompletion>["status"]): string {
  if (status === "expired") return "saved completion expired after 30 days";
  if (status === "changed") return "branch changed since its last saved completion";
  return "no saved completion";
}

export function registerReviewEnforcement(pi: ReviewPi, dependencies: Dependencies): void {
  let activeRound: ActiveRound | undefined;
  let dialogIdentity: string | undefined;
  let pendingGoalPauseHead: string | undefined;
  const mergeBefore = new Map<string, Promise<{
    repo: string;
    branch?: string;
    head?: string;
    command: string;
  }>>();

  const clearRound = async (ctx: ReviewContext): Promise<void> => {
    const head = activeRound?.identity.head;
    activeRound = undefined;
    if (head) await releaseReviewGoalPause(pi, ctx, head);
  };

  const evaluate = async (
    ctx: ReviewContext,
    repo: string,
    boundaryToolUseId: string,
    ciEvent?: ReviewBoundaryEvent,
    command?: string,
  ): Promise<void> => {
    const review = await currentReview(ctx, dependencies, repo, ciEvent, command);
    if (!review) return;
    if (readCompletion(review.identity).status === "complete") return;
    if (activeRound && sameIdentity(activeRound.identity, review.identity)) return;
    let decision: string | undefined;
    if (ciEvent) {
      decision = LAUNCH_REVIEW;
    } else {
      const key = JSON.stringify(review.identity);
      if (dialogIdentity === key || !ctx.hasUI || !ctx.ui) return;
      dialogIdentity = key;
      const initial = readCompletion(review.identity);
      try {
        decision = await ctx.ui.select(
          `Review completion is missing for ${review.repository.split("/").at(-1)}:${review.pr.headRefName}.\nReason: ${statusReason(initial.status)}.`,
          [MARK_COMPLETE, LAUNCH_REVIEW],
        );
      } finally {
        dialogIdentity = undefined;
      }
      if (decision !== MARK_COMPLETE && decision !== LAUNCH_REVIEW) return;
    }
    const refreshed = await currentReview(ctx, dependencies, review.repo, ciEvent);
    if (!refreshed || !sameIdentity(refreshed.identity, review.identity)) return;
    if (readCompletion(refreshed.identity).status === "complete") return;
    if (decision === MARK_COMPLETE) {
      writeCompletion(refreshed.identity);
      return;
    }
    const ancestor = latestAncestorCompletion(refreshed.identity, refreshed.repo);
    const ackHead = ancestor?.head;
    const range = reviewRange({ repo: refreshed.repo, ackHead, head: refreshed.identity.head });
    const reviewers = requiredReviewLanes({ repo: refreshed.repo, ackHead, head: refreshed.identity.head });
    if (reviewers.length === 0) {
      try {
        writeCompletion(refreshed.identity);
      } catch {
        // Exact-head CI remains independent of completion persistence.
      }
      if (ciEvent) sendLaunchMessage(pi, {
        repo: refreshed.repo,
        pr: refreshed.pr,
        boundaryToolUseId,
        ackHead,
        range,
        reviewers,
        ciEvent,
      });
      return;
    }
    const round: ActiveRound = {
      ...refreshed,
      boundaryToolUseId,
      ackHead,
      range,
      reviewers,
      ciEvent,
      ignoreAgentEnds: 1,
      triageCorrectionDelivered: false,
      launchRejectionsDelivered: new Set(),
    };
    sendLaunchMessage(pi, {
      repo: round.repo,
      pr: round.pr,
      boundaryToolUseId,
      ackHead,
      range,
      reviewers,
      ciEvent,
    });
    activeRound = round;
    if (reviewers.length > 0) pendingGoalPauseHead = round.identity.head;
  };

  const recordCloneTargetState = (event: any, ctx: ReviewContext): void => {
    const toolUseId = event?.toolCallId ?? event?.toolUseId ?? event?.id;
    if (typeof toolUseId !== "string") return;
    for (const invocation of shellInvocations(event, ctx.cwd)) {
      if (!classifyReviewBoundaryCommand(invocation.command).clone) continue;
      const target = cloneTargetPath(invocation.command, invocation.cwd);
      if (target && cloneTargetHadGit(toolUseId, target) === undefined) {
        rememberCloneTargetHadGit(toolUseId, target, existsSync(join(target, ".git")));
      }
    }
  };

  const recordMergeState = (event: any, ctx: ReviewContext): void => {
    const toolUseId = event?.toolCallId ?? event?.toolUseId ?? event?.id;
    if (typeof toolUseId !== "string" || mergeBefore.has(toolUseId)) return;
    const invocation = shellInvocations(event, ctx.cwd)
      .find((candidate) => isReviewMergeCommand(candidate.command));
    if (!invocation) return;
    const repo = resolveShellInvocationRepo(invocation);
    if (!repo) return;
    mergeBefore.set(toolUseId, Promise.all([
      (dependencies.queryBranch ?? queryBranch)(repo),
      (dependencies.queryHead ?? queryHead)(repo),
    ]).then(([branch, head]) => ({ repo, branch, head, command: invocation.command })));
  };

  pi.on("tool_call", recordCloneTargetState);
  pi.on("tool_call", recordMergeState);
  pi.on("tool_execution_start", recordCloneTargetState);
  pi.on("tool_execution_start", recordMergeState);

  pi.on("session_start", async (_event, ctx) => {
    await releaseReviewGoalPause(pi, ctx);
    activeRound = undefined;
    dialogIdentity = undefined;
    pendingGoalPauseHead = undefined;
    if (!globalPrunePerformed) {
      globalPrunePerformed = true;
      if (pruneCompletionState()) requestCompletionSync();
    }
    const repo = findGitRoot(ctx.cwd);
    if (repo) await evaluate(ctx, repo, `startup:${Date.now()}`);
  });

  pi.on("tool_result", async (event, ctx) => {
    const toolUseId = event?.toolCallId ?? event?.toolUseId ?? event?.id;
    const beforePromise = typeof toolUseId === "string" ? mergeBefore.get(toolUseId) : undefined;
    if (typeof toolUseId === "string") mergeBefore.delete(toolUseId);
    if (!successful(event)) return;
    rememberActiveRepoFromToolResult(event, ctx.cwd);
    const boundary = latestBoundary(event, ctx.cwd);
    if (boundary) {
      if (boundary.cloneTargetPreexisted) return;
      const repo = boundary.repo ?? resolveShellInvocationRepo(boundary.invocation);
      if (!repo) return;
      await evaluate(ctx, repo, boundary.toolUseId, boundary.classification.event, boundary.invocation.command);
      return;
    }
    if (!beforePromise || typeof toolUseId !== "string") return;
    const before = await beforePromise;
    const [branch, head] = await Promise.all([
      (dependencies.queryBranch ?? queryBranch)(before.repo),
      (dependencies.queryHead ?? queryHead)(before.repo),
    ]);
    if ((branch !== before.branch || head !== before.head) && branch && head) {
      await evaluate(ctx, before.repo, toolUseId, undefined, before.command);
    }
  });

  const settleRound = async (ctx: ReviewContext, endOfTurn: boolean): Promise<void> => {
    const round = activeRound;
    if (!round) return;
    if (endOfTurn && round.ignoreAgentEnds > 0) {
      round.ignoreAgentEnds -= 1;
      return;
    }
    const facts = roundFacts(ctx, round);
    const unresolvedLaunchIssues = facts.launchIssues.filter((issue) => issue.target === "ci-monitor"
      ? !facts.ciLaunched
      : facts.lanes[issue.target].state === "missing");
    for (const issue of unresolvedLaunchIssues) {
      if (round.launchRejectionsDelivered.has(issue.toolUseId)) continue;
      round.launchRejectionsDelivered.add(issue.toolUseId);
      sendLaunchRejectionFollowUp(pi, round, issue);
    }
    if (unresolvedLaunchIssues.length > 0) return;
    const laneStates = round.reviewers.map((lane) => facts.lanes[lane].state);
    if (laneStates.includes("in-flight")) return;
    if (laneStates.includes("missing") || (facts.ciRequired && !facts.ciLaunched)) {
      if (endOfTurn) await clearRound(ctx);
      return;
    }
    if (facts.ciRequired && !facts.ciTerminal) return;
    if (!facts.triageComplete) {
      if (facts.triagePresent
        && !round.triageCorrectionDelivered
        && (facts.ciResult === "failure" || facts.ciResult === "timeout")) {
        round.triageCorrectionDelivered = true;
        sendTriageCorrectionFollowUp(pi, round, facts.ciResult);
      }
      return;
    }
    const refreshed = await currentReview(ctx, dependencies, round.repo);
    if (!refreshed || !sameIdentity(refreshed.identity, round.identity)) {
      await clearRound(ctx);
      return;
    }
    try {
      writeCompletion(round.identity);
      if (readCompletion(round.identity).status !== "complete") return;
    } catch {
      return;
    }
    await sendFixFollowUp(pi, ctx, round);
    activeRound = undefined;
  };

  pi.on("agent_end", async (_event, ctx) => {
    const pauseHead = pendingGoalPauseHead;
    pendingGoalPauseHead = undefined;
    if (pauseHead) await pauseGoalForReview(pi, ctx, pauseHead);
    await settleRound(ctx, true);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await settleRound(ctx, false);
  });
}

export async function queryBranch(repo: string, runner: QueryRunner = execFileAsync): Promise<string | undefined> {
  try {
    const { stdout } = await runner("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repo, encoding: "utf8", timeout: 10_000 });
    return String(stdout).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function queryHead(repo: string, revision = "HEAD", runner: QueryRunner = execFileAsync): Promise<string | undefined> {
  try {
    const { stdout } = await runner("git", ["rev-parse", revision], { cwd: repo, encoding: "utf8", timeout: 10_000 });
    const value = String(stdout).trim();
    return fullSha(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function queryRepository(repo: string, runner: QueryRunner = execFileAsync): Promise<RepositoryIdentity | undefined> {
  try {
    const { stdout } = await runner("gh", ["repo", "view", "--json", "nameWithOwner,url"], { cwd: repo, encoding: "utf8", timeout: 10_000 });
    const value = JSON.parse(String(stdout));
    const url = new URL(value.url);
    return typeof value.nameWithOwner === "string"
      ? { gitHost: url.hostname.toLowerCase(), repository: value.nameWithOwner.toLowerCase() }
      : undefined;
  } catch {
    return undefined;
  }
}

export async function queryPr(repo: string, runner: QueryRunner = execFileAsync, target?: string): Promise<PrLookup> {
  try {
    const args = ["pr", "view", ...(target ? [target] : []), "--json", "state,baseRefName,headRefOid,headRefName,number,isDraft,mergeCommit"];
    const { stdout } = await runner("gh", args, { cwd: repo, encoding: "utf8", timeout: 10_000 });
    const value = JSON.parse(String(stdout)) as PrState;
    return isProtectedPr(value) ? value : undefined;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown })?.stderr ?? "");
    return /no pull requests found|could not resolve to a pullrequest/i.test(stderr) ? undefined : PR_LOOKUP_FAILED;
  }
}

export default function reviewEnforcement(pi: ExtensionAPI): void {
  registerReviewEnforcement(pi as unknown as ReviewPi, {
    queryPr: (repo, target) => queryPr(repo, execFileAsync, target),
    queryBranch: (repo) => queryBranch(repo, execFileAsync),
    queryHead: (repo, revision) => queryHead(repo, revision, execFileAsync),
    queryRepository: (repo) => queryRepository(repo, execFileAsync),
  });
}
