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

type ServiceSpawnOptions = {
  description?: string;
  model?: string;
  maxTurns?: number;
  thinkingLevel?: string;
  inheritContext?: boolean;
  foreground?: boolean;
  bypassQueue?: boolean;
};

type SubagentServiceRecord = { status: string };

type SubagentsService = {
  spawn(type: string, prompt: string, options?: ServiceSpawnOptions): string;
  getRecord(id: string): SubagentServiceRecord | undefined;
};

type CiMonitorRequest = {
  subagent_type: "ci-monitor";
  description: string;
  prompt: string;
  run_in_background: true;
  inherit_context: false;
  model?: string;
  thinking?: string;
  max_turns?: number;
};

type ResolveCiRequestInput = {
  event: "push" | "pr-create";
  repo: string;
  pr: number;
  reviewState: "launched" | "not-required";
};

type Dependencies = {
  queryPr(repo: string, target?: string): Promise<PrState | undefined>;
  queryHead?(repo: string): Promise<string | undefined>;
  fetchPrHead?(repo: string, pr: PrState): Promise<boolean>;
  sleep?(delayMs: number): Promise<void>;
  headRetryDelaysMs?: number[];
  getSubagentsService?(): SubagentsService | undefined;
  resolveCiRequest?(input: ResolveCiRequestInput): Promise<CiMonitorRequest | undefined>;
};

type ReviewContext = {
  cwd: string;
  sessionManager: {
    getSessionFile(): string | undefined;
    getHeader?(): { parentSession?: string } | undefined;
  };
};

type ReviewPi = {
  on(event: "tool_result" | "agent_settled" | "turn_start" | "session_start" | "session_shutdown", handler: (event: any, ctx: ReviewContext) => void | Promise<void>): void;
  appendEntry(customType: string, data: unknown): void;
  exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string; code: number }>;
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
const CI_RESOLVER = join(process.env.HOME || "/home/user", ".pi", "agent", "skills", "ci-monitoring", "scripts", "monitor-ci.mjs");
const SUBAGENTS_SERVICE = Symbol.for("@gotgenes/pi-subagents:service");

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
  reviewState: "launched" | "not-required";
  autonomyOverride: boolean;
  ciEvent?: CiBoundaryEvent;
};

function ciBoundaryEvent(event: ReviewBoundaryEvent | undefined): CiBoundaryEvent | undefined {
  if (event === "pr-update-branch") return "push";
  return event === "push" || event === "pr-create" ? event : undefined;
}

function scopeInstruction(pr: PrState, range: string | undefined): string {
  return range
    ? `scope=diff\nreview_range=${range}`
    : `scope=diff\nreview_base=origin/${pr.baseRefName}`;
}

function subagentsService(dependencies: Dependencies): SubagentsService | undefined {
  const published = (globalThis as Record<symbol, unknown>)[SUBAGENTS_SERVICE];
  return dependencies.getSubagentsService?.() ?? (published as SubagentsService | undefined);
}

function serviceDispatchFailed(service: SubagentsService | undefined, agentId: string | undefined): boolean {
  if (!service || !agentId) return false;
  const status = service.getRecord(agentId)?.status;
  return status === "stopped" || status === "aborted" || status === "error";
}

function reviewerPrompt(input: LaunchMessage, lane: ReviewLane): string {
  const autonomy = input.autonomyOverride ? "\nautonomy_override=fully-autonomous" : "";
  return [
    `Review lane: ${lane}. Report findings only; do not modify files or Git state.`,
    `repo=${input.repo}`,
    `head=${input.pr.headRefOid}`,
    scopeInstruction(input.pr, input.range),
    autonomy,
  ].filter(Boolean).join("\n");
}

function spawnOptions(request: Pick<CiMonitorRequest, "description" | "model" | "thinking" | "max_turns">): ServiceSpawnOptions {
  return {
    description: request.description,
    inheritContext: false,
    foreground: false,
    bypassQueue: true,
    ...(request.model ? { model: request.model } : {}),
    ...(request.thinking ? { thinkingLevel: request.thinking } : {}),
    ...(request.max_turns ? { maxTurns: request.max_turns } : {}),
  };
}

function validCiRequest(value: unknown): value is CiMonitorRequest {
  const request = value as Partial<CiMonitorRequest> | undefined;
  return Boolean(request
    && request.subagent_type === "ci-monitor"
    && typeof request.description === "string"
    && typeof request.prompt === "string"
    && request.run_in_background === true
    && request.inherit_context === false);
}

async function defaultResolveCiRequest(pi: ReviewPi, input: ResolveCiRequestInput): Promise<CiMonitorRequest | undefined> {
  try {
    const repository = await pi.exec("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
      cwd: input.repo,
      timeout: 10_000,
    });
    const nameWithOwner = repository.stdout.trim();
    if (repository.code !== 0 || !/^[^/\s]+\/[^/\s]+$/.test(nameWithOwner)) return undefined;
    const result = await pi.exec(process.execPath, [
      CI_RESOLVER,
      "request",
      `event=${input.event}`,
      "changed=true",
      `repo=${nameWithOwner}`,
      `pr=${input.pr}`,
      `cwd=${input.repo}`,
      `reviewState=${input.reviewState}`,
    ], { cwd: input.repo, timeout: 20_000 });
    if (result.code !== 0 || !result.stdout.trim()) return undefined;
    const request = JSON.parse(result.stdout.trim());
    return validCiRequest(request) ? request : undefined;
  } catch {
    return undefined;
  }
}

function appendDispatch(pi: ReviewPi, input: LaunchMessage, data: {
  agentId: string;
  kind: "reviewer" | "ci";
  lane?: ReviewLane;
}): void {
  pi.appendEntry("codeflare:subagent-dispatch", {
    version: 1,
    ...data,
    head: input.pr.headRefOid,
    ...(input.range ? { range: input.range } : {}),
  });
}

async function dispatchReviewWindow(
  pi: ReviewPi,
  dependencies: Dependencies,
  input: LaunchMessage,
  dispatch = true,
): Promise<void> {
  pi.appendEntry("codeflare:review-window", {
    version: 1,
    phase: input.phase,
    head: input.pr.headRefOid,
    ...(input.ackHead ? { ackHead: input.ackHead } : {}),
    ...(input.range ? { reviewRange: input.range } : {}),
    ...(input.phase === "plan" ? { scope: scopeContract("diff"), requiredLanes: input.reviewers } : { missingLanes: input.reviewers }),
    launchWaves: [input.reviewers, ...(input.ciEvent ? [["ci-monitor"]] : [])],
    ...(input.ciEvent ? { ciEvent: input.ciEvent } : {}),
  });

  if (!dispatch) return;
  const service = subagentsService(dependencies);
  if (!service) return;
  let reviewerSpawnFailed = false;
  for (const lane of input.reviewers) {
    const prompt = reviewerPrompt(input, lane);
    try {
      const agentId = service.spawn(lane, prompt, {
        description: `${lane} ${input.pr.headRefOid.slice(0, 8)}`,
        inheritContext: false,
        foreground: false,
      });
      if (!agentId) throw new Error("Subagent service returned no reviewer ID");
      appendDispatch(pi, input, { agentId, kind: "reviewer", lane });
    } catch {
      reviewerSpawnFailed = true;
    }
  }

  if (reviewerSpawnFailed || !input.ciEvent) return;
  const request = await (dependencies.resolveCiRequest
    ?? ((ciInput: ResolveCiRequestInput) => defaultResolveCiRequest(pi, ciInput)))({
    event: input.ciEvent,
    repo: input.repo,
    pr: input.pr.number,
    reviewState: input.reviewState,
  });
  if (!request) {
    pi.appendEntry("codeflare:ci-resolution", { version: 1, head: input.pr.headRefOid, outcome: "not-requested" });
    return;
  }
  try {
    const agentId = service.spawn(request.subagent_type, request.prompt, spawnOptions(request));
    if (!agentId) throw new Error("Subagent service returned no CI ID");
    appendDispatch(pi, input, { agentId, kind: "ci" });
  } catch {
    // Leave CI undispatched so the next settled pass can retry it.
  }
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

    await dispatchReviewWindow(pi, dependencies, {
      phase: "plan",
      repo: review.repo,
      pr: review.pr,
      ackHead,
      range,
      reviewers: requiredLanes,
      reviewState: requiredLanes.length > 0 ? "launched" : "not-required",
      autonomyOverride: false,
      ciEvent,
    }, false);
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

    const service = subagentsService(dependencies);
    const ciEvent = facts.ciLaunched && !serviceDispatchFailed(service, facts.ciAgentId)
      ? undefined
      : ciBoundaryEvent(classifyReviewBoundaryCommand(facts.boundary.command).event);
    if (shouldReview && requiredLanes.length === 0) acknowledge(review.repo, review.pr.headRefOid);

    if (shouldReview && requiredLanes.length > 0
      && (facts.reviewHead !== review.pr.headRefOid || facts.reviewRange !== range)) {
      await dispatchReviewWindow(pi, dependencies, {
        phase: "plan",
        repo: review.repo,
        pr: review.pr,
        ackHead,
        range,
        reviewers: requiredLanes,
        reviewState: requiredLanes.length > 0 ? "launched" : "not-required",
        autonomyOverride: facts.fullyAutonomous,
        ciEvent,
      }, true);
      return;
    }

    const allReviewersTerminal = requiredLanes.length > 0
      && requiredLanes.every((lane) => facts.lanes[lane].state === "terminal");
    if (allReviewersTerminal) acknowledge(review.repo, review.pr.headRefOid);

    const missingLanes = allReviewersTerminal || !shouldReview
      ? []
      : requiredLanes.filter((lane): lane is ReviewLane => {
        const fact = facts.lanes[lane];
        return fact.state === "missing"
          || (fact.state === "in-flight" && serviceDispatchFailed(service, fact.agentId));
      });
    if (missingLanes.length === 0 && !ciEvent) return;
    if (missingLanes.length > 0 && blockDecision(review.repo, review.pr.headRefOid) === "giveup") return;

    await dispatchReviewWindow(pi, dependencies, {
      phase: "follow-up",
      repo: review.repo,
      pr: review.pr,
      ackHead,
      range,
      reviewers: missingLanes,
      reviewState: requiredLanes.length > 0 ? "launched" : "not-required",
      autonomyOverride: facts.fullyAutonomous,
      ciEvent,
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
