import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recallActiveRepo } from "./codeflare-pi";
import {
  classifyReviewBoundaryCommand,
  isReviewTransitionSuspended,
  requiredReviewLanes,
  reviewTranscriptFacts,
  type ReviewLane,
} from "./review-helpers";

type PrState = {
  state: "OPEN" | "CLOSED" | "MERGED";
  baseRefName: "main" | "master";
  headRefOid: string;
  headRefName: string;
  number: number;
  isDraft?: boolean;
};

type Dependencies = {
  queryPr(repo: string): Promise<PrState | undefined>;
};

type ReviewContext = {
  cwd: string;
  sessionManager: {
    getSessionFile(): string | undefined;
    getHeader?(): { parentSession?: string } | undefined;
  };
};

type ReviewPi = {
  on(event: "tool_result" | "agent_settled", handler: (event: any, ctx: ReviewContext) => void | Promise<void>): void;
  sendMessage(
    message: { customType: string; content?: string; details?: Record<string, unknown>; display?: boolean },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
};

const execFileAsync = promisify(execFile);
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

function reviewContext(ctx: ReviewContext): { repo: string; file: string } | undefined {
  const repo = isSddRepo(ctx.cwd) ? ctx.cwd : (recallActiveRepo() ?? ctx.cwd);
  const file = sessionFile(ctx);
  if (!file || isChildSession(ctx, file) || !isSddRepo(repo) || isReviewTransitionSuspended(repo)) return undefined;
  return { repo, file };
}

async function currentReview(
  ctx: ReviewContext,
  dependencies: Dependencies,
): Promise<{ repo: string; file: string; pr: PrState } | undefined> {
  const context = reviewContext(ctx);
  if (!context) return undefined;
  const pr = await dependencies.queryPr(context.repo);
  return isProtectedPr(pr) ? { ...context, pr } : undefined;
}

function reviewRange(ackHead: string | undefined, head: string): string | undefined {
  return fullSha(ackHead) ? `${ackHead}..${head}` : undefined;
}

export function registerReviewEnforcement(pi: ReviewPi, dependencies: Dependencies): void {
  pi.on("tool_result", async (event, ctx) => {
    if (!successful(event)) return;
    const boundary = shellCommands(event).find((command) => classifyReviewBoundaryCommand(command).reminder);
    if (!boundary) return;
    const review = await currentReview(ctx, dependencies);
    if (!review || !isEnforcedPr(review.pr) || bypassSentinelPresent()) return;
    const ackHead = readAck(review.repo);
    if (ackHead === review.pr.headRefOid) return;
    const range = reviewRange(ackHead, review.pr.headRefOid);
    const requiredLanes = requiredReviewLanes({ repo: review.repo, ackHead, head: review.pr.headRefOid });
    const scope = range ? `Review only review_range=${range}. Include that exact marker in every reviewer prompt.` : `Review the full PR against origin/${review.pr.baseRefName}.`;
    pi.sendMessage({
      customType: "pr-boundary-review-reminder",
      content: `PR head ${review.pr.headRefOid} requires these review agents: ${requiredLanes.join(", ")}. ${scope} Launch them together with the public subagent tool, in the background without inherited context. Wait for every result before fixing, committing, or pushing.`,
      display: true,
      details: { head: review.pr.headRefOid, ackHead, reviewRange: range, requiredLanes },
    }, { deliverAs: "followUp", triggerTurn: true });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const context = reviewContext(ctx);
    if (!context) return;
    const preview = reviewTranscriptFacts({ sessionFile: context.file, requiredLanes: [] });
    if (!preview.boundary) return;
    const review = await currentReview(ctx, dependencies);
    if (!review) return;
    const ackHead = readAck(review.repo);
    if (ackHead === review.pr.headRefOid) return;
    const range = reviewRange(ackHead, review.pr.headRefOid);
    const requiredLanes = isEnforcedPr(review.pr)
      ? requiredReviewLanes({ repo: review.repo, ackHead, head: review.pr.headRefOid })
      : [];
    const facts = reviewTranscriptFacts({ sessionFile: review.file, requiredLanes });
    if (!facts.boundary) return;
    if (review.pr.state !== "OPEN") {
      if (!facts.closedNotified && /(?:^|[;&|\n]\s*)gh\s+pr\s+merge(?:\s|$)/.test(facts.boundary.command)) {
        pi.sendMessage({
          customType: "pr-boundary-review-closed-unacknowledged",
          content: `PR head ${review.pr.headRefOid} is ${review.pr.state} without review acknowledgement. No acknowledgement was written.`,
          display: true,
          details: { head: review.pr.headRefOid, state: review.pr.state },
        }, { triggerTurn: false });
      }
      return;
    }
    if (facts.bypassed || consumeBypassSentinel()) return;
    if (facts.reviewHead !== review.pr.headRefOid || facts.reviewRange !== range) return;

    if (requiredLanes.every((lane) => facts.lanes[lane].state === "terminal")) {
      acknowledge(review.repo, review.pr.headRefOid);
      return;
    }

    const missingLanes = requiredLanes.filter((lane): lane is ReviewLane => facts.lanes[lane].state === "missing");
    if (missingLanes.length === 0 || blockDecision(review.repo, review.pr.headRefOid) === "giveup") return;
    const scope = range ? `Review only review_range=${range}. Include that exact marker in every reviewer prompt.` : `Review the full PR against origin/${review.pr.baseRefName}.`;
    pi.sendMessage({
      customType: "pr-boundary-review-follow-up",
      content: `Launch these missing review agents together now: ${missingLanes.join(", ")}. ${scope} Use public background subagent calls without inherited context, then wait for every required review before fixing, committing, or pushing.`,
      display: true,
      details: { head: review.pr.headRefOid, ackHead, reviewRange: range, missingLanes },
    }, { deliverAs: "followUp", triggerTurn: true });
  });
}

async function queryPr(repo: string): Promise<PrState | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", "--json", "state,baseRefName,headRefOid,headRefName,number,isDraft"],
      { cwd: repo, encoding: "utf8", timeout: 10_000 },
    );
    const value = JSON.parse(String(stdout)) as PrState;
    return isProtectedPr(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export default function reviewEnforcement(pi: ExtensionAPI): void {
  registerReviewEnforcement(pi as unknown as ReviewPi, { queryPr });
}
