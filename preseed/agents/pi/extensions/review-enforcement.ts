import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recallActiveRepo, rememberActiveRepoFromToolResult } from "./active-repo-memory";
import {
  classifyReviewBoundaryCommand,
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
  baseRefName: "main" | "master";
  headRefOid: string;
  headRefName: string;
  number: number;
  isDraft?: boolean;
};

type Dependencies = {
  queryPr(repo: string, target?: string): Promise<PrState | undefined>;
  queryHead?(repo: string): Promise<string | undefined>;
  fetchPrHead?(repo: string, pr: PrState): Promise<boolean>;
  sleep?(delayMs: number): Promise<void>;
  headRetryDelaysMs?: number[];
};

type ReviewContext = {
  cwd: string;
  sessionManager: {
    getSessionFile(): string | undefined;
    getHeader?(): { parentSession?: string } | undefined;
  };
};

type ExactToolInvocation = { name: string; arguments: Record<string, unknown> };
type ExactToolResult = { isError?: boolean };
type ReviewPi = {
  on(event: "tool_result" | "agent_settled", handler: (event: any, ctx: ReviewContext) => void | Promise<void>): void;
  invokeTools(invocations: ExactToolInvocation[]): Promise<ExactToolResult[]>;
  exec(command: string, args: string[], options?: { cwd?: string }): Promise<{
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
  }>;
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
const CI_RESOLVER = "/home/user/.pi/agent/skills/ci-monitoring/scripts/monitor-ci.mjs";
const REVIEW_DESCRIPTIONS: Record<ReviewLane, string> = {
  "code-reviewer": "Review source behavior",
  "spec-reviewer": "Review SDD requirements",
  "doc-updater": "Review documentation",
};

function fullSha(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{40}$/.test(value));
}

function isProtectedPr(pr: PrState | undefined): pr is PrState {
  return Boolean(
    pr
    && ["OPEN", "CLOSED", "MERGED"].includes(pr.state)
    && (pr.baseRefName === "main" || pr.baseRefName === "master")
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

function ackPath(repo: string): string {
  return join(repo, ".git", "sdd-last-ack-pr-head");
}

function countPath(repo: string): string {
  return join(repo, ".git", "sdd-review-block-count");
}

function readAck(repo: string): string | undefined {
  try {
    const value = readFileSync(ackPath(repo), "utf8").trim();
    return fullSha(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function clearAck(repo: string): void {
  try {
    unlinkSync(ackPath(repo));
  } catch {
    // Missing acknowledgement is the normal unreviewed state.
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

function shellCommands(event: any): string[] {
  const input = event?.input;
  const name = String(event?.toolName ?? "");
  if (!input || typeof input !== "object") return [];
  if ((name === "bash" || name === "Bash") && typeof input.command === "string") return [input.command];
  if (name.endsWith("ctx_execute") && input.language === "shell" && typeof input.code === "string") return [input.code];
  if (name.endsWith("ctx_batch_execute") && Array.isArray(input.commands)) {
    return input.commands
      .map((item: Record<string, unknown>) => item?.command)
      .filter((command: unknown): command is string => typeof command === "string");
  }
  return [];
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

function boundaryContext(ctx: ReviewContext): { repo: string; file: string } | undefined {
  const repo = existsSync(join(ctx.cwd, ".git")) ? ctx.cwd : (recallActiveRepo() ?? ctx.cwd);
  const file = sessionFile(ctx);
  if (!file || isChildSession(ctx, file)) return undefined;
  return { repo, file };
}

function reviewEnabled(repo: string): boolean {
  return process.env.SESSION_MODE !== "default"
    && isSddRepo(repo)
    && !isReviewTransitionSuspended(repo);
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function fetchPrHead(
  repo: string,
  pr: PrState,
  runner: QueryPrRunner = execFileAsync,
): Promise<boolean> {
  try {
    await runner(
      "git",
      ["fetch", "--no-tags", "--quiet", "origin", `refs/pull/${pr.number}/head`],
      { cwd: repo, encoding: "utf8", timeout: 15_000 },
    );
    const result = await runner(
      "git",
      ["rev-parse", "FETCH_HEAD"],
      { cwd: repo, encoding: "utf8", timeout: 5_000 },
    );
    return String(result.stdout).trim() === pr.headRefOid;
  } catch {
    return false;
  }
}

async function currentReview(
  ctx: ReviewContext,
  dependencies: Dependencies,
  target: string | undefined,
  remoteHeadAuthoritative = false,
): Promise<{ repo: string; file: string; pr: PrState } | undefined> {
  const context = boundaryContext(ctx);
  if (!context) return undefined;
  const head = await (dependencies.queryHead ?? queryHead)(context.repo);
  if (!head) return undefined;
  const delays = dependencies.headRetryDelaysMs ?? [0, 250, 1_000];
  const sleep = dependencies.sleep ?? defaultSleep;
  for (const delayMs of delays) {
    if (delayMs > 0) await sleep(delayMs);
    const pr = await dependencies.queryPr(context.repo, target);
    if (!isProtectedPr(pr)) continue;
    if (!remoteHeadAuthoritative && head === pr.headRefOid) return { ...context, pr };
    if (remoteHeadAuthoritative
      && head !== pr.headRefOid
      && await (dependencies.fetchPrHead ?? fetchPrHead)(context.repo, pr)) {
      return { ...context, pr };
    }
  }
  return undefined;
}

type CiBoundaryEvent = "push" | "pr-create";

type LaunchMessage = {
  phase: "plan" | "follow-up";
  repo: string;
  pr: PrState;
  ackHead?: string;
  range?: string;
  reviewers: ReviewLane[];
  ciEvent?: CiBoundaryEvent;
  reviewState: "launched" | "not-required";
  autonomyOverride?: boolean;
};

function ciBoundaryEvent(event: ReviewBoundaryEvent | undefined): CiBoundaryEvent | undefined {
  if (event === "pr-update-branch") return "push";
  return event === "push" || event === "pr-create" ? event : undefined;
}

function scopeInstruction(pr: PrState, range: string | undefined): string {
  return range
    ? `scope=diff with review_range=${range}`
    : `scope=diff for the full PR against origin/${pr.baseRefName}`;
}

function reviewerInvocation(input: LaunchMessage, lane: ReviewLane): ExactToolInvocation {
  const scope = input.range
    ? `review_range=${input.range}`
    : `Review the full PR against origin/${input.pr.baseRefName}.`;
  return {
    name: "subagent",
    arguments: {
      subagent_type: lane,
      description: REVIEW_DESCRIPTIONS[lane],
      prompt: [
        `repo=${input.repo}`,
        "scope=diff",
        scope,
        ...(input.autonomyOverride ? ["autonomy_override=fully-autonomous"] : []),
        "Remain report-only. Do not modify files or run builds, tests, linters, formatters, CI, deploys, or Git mutations.",
      ].join("\n"),
      run_in_background: true,
      inherit_context: false,
    },
  };
}

function publicSubagentRequest(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const request = value as Record<string, unknown>;
  return typeof request.subagent_type === "string"
    && typeof request.prompt === "string"
    && request.run_in_background === true
    && request.inherit_context === false
    ? request
    : undefined;
}

async function ciMonitorRequest(pi: ReviewPi, input: LaunchMessage): Promise<Record<string, unknown> | undefined> {
  if (!input.ciEvent) return undefined;
  const repository = await pi.exec("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: input.repo });
  const repo = repository.code === 0 ? repository.stdout.trim() : "";
  if (!/^[^\s/]+\/[^\s/]+$/.test(repo)) return undefined;
  const result = await pi.exec(process.execPath, [
    CI_RESOLVER,
    "request",
    `event=${input.ciEvent}`,
    "changed=true",
    `repo=${repo}`,
    `pr=${input.pr.number}`,
    `cwd=${input.repo}`,
    `reviewState=${input.reviewState}`,
  ], { cwd: input.repo });
  if (result.code !== 0 || !result.stdout.trim()) return undefined;
  try {
    return publicSubagentRequest(JSON.parse(result.stdout));
  } catch {
    return undefined;
  }
}

async function dispatchLaunches(pi: ReviewPi, input: LaunchMessage): Promise<void> {
  if (input.reviewers.length > 0) {
    const results = await pi.invokeTools(input.reviewers.map((lane) => reviewerInvocation(input, lane)));
    if (results.length !== input.reviewers.length || results.some((result) => result.isError === true)) return;
  }
  if (!input.ciEvent) return;
  const ciRequest = await ciMonitorRequest(pi, input);
  if (!ciRequest) {
    pi.sendMessage({
      customType: "pr-boundary-ci-resolution",
      content: `Automatic CI resolution completed for ${input.pr.headRefOid}: no monitor request.`,
      display: true,
      details: { head: input.pr.headRefOid, outcome: "no-request" },
    }, { triggerTurn: false });
    return;
  }
  const ciResults = await pi.invokeTools([{ name: "subagent", arguments: ciRequest }]);
  if (ciResults.length === 1 && ciResults[0]?.isError !== true) {
    pi.sendMessage({
      customType: "pr-boundary-ci-resolution",
      content: `Automatic CI resolution completed for ${input.pr.headRefOid}: monitor launched.`,
      display: true,
      details: { head: input.pr.headRefOid, outcome: "launched" },
    }, { triggerTurn: false });
  }
}

async function sendLaunchMessage(pi: ReviewPi, input: LaunchMessage, dispatch = false): Promise<void> {
  const reviewerWave = input.reviewers.length > 0
    ? `Automatic wave 1 dispatch: ${input.reviewers.join(", ")} together through exact public background subagent calls with inherit_context=false; ${scopeInstruction(input.pr, input.range)}.`
    : "Automatic wave 1 dispatch: no reviewer is required.";
  const ciWave = input.ciEvent
    ? `Automatic wave 2 dispatch: after wave 1 starts, the extension runs the ci-monitoring resolver for event=${input.ciEvent}, changed=true, pr=${input.pr.number}, cwd=${input.repo}, and reviewState=${input.reviewState}, then invokes its zero-or-one request unchanged. CI remains independent of review acknowledgement.`
    : "Automatic wave 2 dispatch: no CI launch is required for this boundary.";
  const details: Record<string, unknown> = {
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
    content: `${reviewerWave} ${ciWave}${input.reviewers.length > 0 ? " Wait for every required reviewer result, then automatically publish a triage summary before fixing. Classify each finding's validity, the proposed fix's proportionality, and the smallest correction that reuses existing machinery. Reject unsupported or overengineered proposals; apply legitimate minimal fixes by default unless the user explicitly requested approval." : ""}`,
    display: true,
    details,
  }, { deliverAs: "followUp", triggerTurn: false });
  if (dispatch) await dispatchLaunches(pi, input);
}

export function registerReviewEnforcement(pi: ReviewPi, dependencies: Dependencies): void {
  pi.on("tool_result", async (event, ctx) => {
    if (!successful(event)) return;
    rememberActiveRepoFromToolResult(event, ctx.cwd);
    const boundary = shellCommands(event)
      .map((command) => ({ command, classification: classifyReviewBoundaryCommand(command) }))
      .find(({ classification }) => classification.reminder);
    if (!boundary) return;
    const target = boundary.classification.event === "pr-update-branch"
      ? boundary.classification.prTarget
      : undefined;
    const review = await currentReview(
      ctx,
      dependencies,
      target,
      boundary.classification.event === "pr-update-branch",
    );
    if (!review || !isEnforcedPr(review.pr)) return;

    const skipReview = bypassSentinelPresent();
    if (skipReview && !boundary.classification.settled) consumeBypassSentinel();
    if (boundary.classification.protectedRetarget) clearAck(review.repo);
    const ackHead = readAck(review.repo);
    const range = reviewRange({ repo: review.repo, ackHead, head: review.pr.headRefOid });
    const requiredLanes = reviewEnabled(review.repo) && !skipReview && ackHead !== review.pr.headRefOid
      ? requiredReviewLanes({ repo: review.repo, ackHead, head: review.pr.headRefOid })
      : [];
    const ciEvent = ciBoundaryEvent(boundary.classification.event);
    if (requiredLanes.length === 0 && !ciEvent) return;

    await sendLaunchMessage(pi, {
      phase: "plan",
      repo: review.repo,
      pr: review.pr,
      ackHead,
      range,
      reviewers: requiredLanes,
      ciEvent,
      reviewState: requiredLanes.length > 0 ? "launched" : "not-required",
      autonomyOverride: reviewTranscriptFacts({ sessionFile: review.file, requiredLanes: [] }).fullyAutonomous,
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const context = boundaryContext(ctx);
    if (!context) return;
    const preview = reviewTranscriptFacts({ sessionFile: context.file, requiredLanes: [] });
    if (!preview.boundary) return;

    const boundaryClassification = classifyReviewBoundaryCommand(preview.boundary.command);
    const target = boundaryClassification.event === "pr-update-branch"
      ? boundaryClassification.prTarget
      : undefined;
    const reviewedPr = await dependencies.queryPr(context.repo, target);
    const reviewedHead = preview.reviewHead;
    const reviewedAck = readAck(context.repo);
    if (isEnforcedPr(reviewedPr)
      && reviewEnabled(context.repo)
      && !preview.bypassed
      && !bypassSentinelPresent()
      && fullSha(reviewedHead)
      && reviewedHead === reviewedPr.headRefOid
      && reviewedAck !== reviewedHead) {
      const reviewedRange = reviewRange({ repo: context.repo, ackHead: reviewedAck, head: reviewedHead });
      const reviewedLanes = requiredReviewLanes({ repo: context.repo, ackHead: reviewedAck, head: reviewedHead });
      const reviewedFacts = reviewTranscriptFacts({
        sessionFile: context.file,
        requiredLanes: reviewedLanes,
        ciHead: reviewedHead,
      });
      const allReviewedLanesTerminal = reviewedLanes.length > 0
        && reviewedLanes.every((lane) => reviewedFacts.lanes[lane].state === "terminal");
      if (reviewedFacts.reviewHead === reviewedHead
        && reviewedFacts.reviewRange === reviewedRange
        && allReviewedLanesTerminal) {
        acknowledge(context.repo, reviewedHead);
      }
    }

    const review = await currentReview(
      ctx,
      dependencies,
      target,
      boundaryClassification.event === "pr-update-branch",
    );
    if (!review) return;
    const ackHead = readAck(review.repo);
    const range = reviewRange({ repo: review.repo, ackHead, head: review.pr.headRefOid });
    const bypassed = preview.bypassed || consumeBypassSentinel();
    const shouldReview = isEnforcedPr(review.pr)
      && reviewEnabled(review.repo)
      && !bypassed
      && ackHead !== review.pr.headRefOid;
    const requiredLanes = shouldReview
      ? requiredReviewLanes({ repo: review.repo, ackHead, head: review.pr.headRefOid })
      : [];
    const facts = reviewTranscriptFacts({
      sessionFile: review.file,
      requiredLanes,
      ciHead: review.pr.headRefOid,
    });
    if (!facts.boundary) return;
    if (review.pr.state !== "OPEN") {
      if (reviewEnabled(review.repo) && !facts.closedNotified && classifyReviewBoundaryCommand(facts.boundary.command).settled) {
        pi.sendMessage({
          customType: "pr-boundary-review-closed-unacknowledged",
          content: `PR head ${review.pr.headRefOid} is ${review.pr.state} without review acknowledgement. No acknowledgement was written.`,
          display: true,
          details: { head: review.pr.headRefOid, state: review.pr.state },
        }, { triggerTurn: false });
      }
      return;
    }

    const ciEvent = facts.ciLaunched || facts.ciResolved
      ? undefined
      : ciBoundaryEvent(classifyReviewBoundaryCommand(facts.boundary.command).event);
    if (shouldReview && requiredLanes.length === 0) acknowledge(review.repo, review.pr.headRefOid);

    if (shouldReview && requiredLanes.length > 0
      && (facts.reviewHead !== review.pr.headRefOid || facts.reviewRange !== range)) {
      await sendLaunchMessage(pi, {
        phase: "plan",
        repo: review.repo,
        pr: review.pr,
        ackHead,
        range,
        reviewers: requiredLanes,
        ciEvent,
        reviewState: requiredLanes.length > 0 ? "launched" : "not-required",
        autonomyOverride: preview.fullyAutonomous,
      }, true);
      return;
    }

    const allReviewersTerminal = requiredLanes.length > 0
      && requiredLanes.every((lane) => facts.lanes[lane].state === "terminal");
    if (allReviewersTerminal) acknowledge(review.repo, review.pr.headRefOid);

    const missingLanes = allReviewersTerminal || !shouldReview
      ? []
      : requiredLanes.filter((lane): lane is ReviewLane => facts.lanes[lane].state === "missing");
    if (missingLanes.length === 0 && !ciEvent) return;
    if (missingLanes.length > 0 && blockDecision(review.repo, review.pr.headRefOid) === "giveup") return;

    await sendLaunchMessage(pi, {
      phase: "follow-up",
      repo: review.repo,
      pr: review.pr,
      ackHead,
      range,
      reviewers: missingLanes,
      ciEvent,
      reviewState: requiredLanes.length > 0 ? "launched" : "not-required",
      autonomyOverride: preview.fullyAutonomous,
    }, true);
  });
}

export async function queryHead(repo: string, runner: QueryPrRunner = execFileAsync): Promise<string | undefined> {
  try {
    const { stdout } = await runner(
      "git",
      ["rev-parse", "HEAD"],
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
  });
}
