import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recallActiveRepo, rememberActiveRepoFromToolResult } from "./active-repo-memory";
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

type ReviewPi = ToolActivationPi & {
  on(event: "tool_result" | "agent_settled", handler: (event: any, ctx: ReviewContext) => void | Promise<void>): void;
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
};

function ciBoundaryEvent(event: ReviewBoundaryEvent | undefined): CiBoundaryEvent | undefined {
  if (event === "pr-update-branch") return "push";
  return event === "push" || event === "pr-create" ? event : undefined;
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

function sendFixFollowUp(pi: ReviewPi, pr: PrState, range: string | undefined): void {
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

    sendLaunchMessage(pi, {
      phase: "plan",
      repo: review.repo,
      pr: review.pr,
      ackHead,
      range,
      reviewers: requiredLanes,
      ciEvent,
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const context = boundaryContext(ctx);
    if (!context) return;
    const preview = reviewTranscriptFacts({ sessionFile: context.file, requiredLanes: [] });
    if (!preview.boundary) return;

    const boundaryClassification = classifyReviewBoundaryCommand(preview.boundary.command);
    if (boundaryClassification.event !== "pr-merge" && !fullSha(preview.reviewHead)) return;
    const target = boundaryClassification.event === "pr-update-branch"
      ? boundaryClassification.prTarget
      : undefined;
    const reviewedPr = await dependencies.queryPr(context.repo, target);
    if (fullSha(preview.reviewHead) && reviewedPr?.headRefOid !== preview.reviewHead) return;
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
        && allReviewedLanesTerminal
        && reviewedFacts.triageComplete) {
        acknowledge(context.repo, reviewedHead);
        sendFixFollowUp(pi, reviewedPr, reviewedRange);
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
      sendLaunchMessage(pi, {
        phase: "plan",
        repo: review.repo,
        pr: review.pr,
        ackHead,
        range,
        reviewers: requiredLanes,
        ciEvent,
      });
      return;
    }

    const allReviewersTerminal = requiredLanes.length > 0
      && requiredLanes.every((lane) => facts.lanes[lane].state === "terminal");

    const missingLanes = allReviewersTerminal || !shouldReview
      ? []
      : requiredLanes.filter((lane): lane is ReviewLane => facts.lanes[lane].state === "missing");
    if (missingLanes.length === 0 && !ciEvent) return;
    if (missingLanes.length > 0 && blockDecision(review.repo, review.pr.headRefOid) === "giveup") return;

    sendLaunchMessage(pi, {
      phase: "follow-up",
      repo: review.repo,
      pr: review.pr,
      ackHead,
      range,
      reviewers: missingLanes,
      ciEvent,
    });
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
