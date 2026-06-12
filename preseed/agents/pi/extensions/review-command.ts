/**
 * Codeflare Pi /review command.
 *
 * This is the user-invoked review workflow. It is intentionally separate
 * from PR-boundary enforcement: /review reviews a chosen scope; enforcement
 * decides when a PR HEAD must have been reviewed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { computeReviewState } from "./review-jobs";
import { activeRepoSentinelForDisplay, recallActiveRepo, recallReviewRepo, resolveReviewRepo } from "./review-job-helpers";

function shell(command: string, cwd: string): string {
  // P7: bound every shell-out (every other module passes a 5s timeout). /review-status' `gh pr view`
  // can otherwise hang the command handler indefinitely on a stalled network call.
  return execFileSync("bash", ["-lc", command], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
}

function findGitRoot(startDir: string): string | undefined {
  try {
    const root = shell("git rev-parse --show-toplevel", startDir);
    return root || undefined;
  } catch {
    return undefined;
  }
}

function skillPrompt(name: string, fallback: string): string {
  const candidates = [
    join(process.cwd(), ".pi", "agent", "skills", name, "SKILL.md"),
    join("/home/user/.pi/agent/skills", name, "SKILL.md"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return fallback;
}

function helpText(): string {
  return [
    "USAGE",
    "  /review                                    Show this help",
    "  /review --all  [flags] [scope]             Review the entire codebase",
    "  /review --diff [flags] [scope]             Review the current diff vs base",
    "",
    "FLAGS",
    "  --deep          Include behavioral REQ-vs-code verification guidance",
    "  --verify-high   Include external/second-opinion verification guidance where available",
  ].join("\n");
}

async function sendUserPrompt(pi: ExtensionAPI, ctx: ExtensionCommandContext, message: string): Promise<void> {
  await ctx.waitForIdle();
  const contextSender = (ctx as ExtensionCommandContext & { sendUserMessage?: (content: string) => void | Promise<void> }).sendUserMessage;
  if (typeof contextSender === "function") {
    await contextSender.call(ctx, message);
    return;
  }
  pi.sendUserMessage(message);
}

async function dispatchReview(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim();
  if (!/(^|\s)--(all|diff)(\s|$)/.test(trimmed)) {
    ctx.ui.notify(helpText(), "warning");
    return;
  }

  const command = `/review ${trimmed}`;
  const reviewInstructions = [
    skillPrompt("review", "Run the Codeflare multi-phase review workflow for the requested scope and report findings."),
    "",
    "This is the user-invoked /review command, not the PR-boundary enforcement hook.",
    `User command: ${command}`,
  ].join("\n");

  await sendUserPrompt(pi, ctx, reviewInstructions);
}

// ── /review-status (read-only PR-boundary review state) ─────────────────────
// Renders the canonical computeReviewState for the current head plus a tail of the
// decision audit log, so "is a review running / why is it stuck / why is merge
// blocked" is answerable without inspecting .git/ by hand (review.md §17.3). Never
// mutates state.

type PrView = { number?: number; state?: string; baseRefName?: string; headRefOid?: string };

// Shared with codeflare-pi.ts (which owns the writes); read here only as the
// guarded, display-only last resort in reviewStatusRepo (mirrors local-statusline).
const ACTIVE_REPO_SENTINEL = "/home/user/.cache/codeflare-hooks/graphify-active-cwd";

// Resolve the repo /review-status should report on. /review-status used to resolve ONLY from the
// session cwd, so it warned "not inside a git repository" whenever the Pi session cwd was a
// non-repo parent workspace and the user worked in a nested clone via `cd repo && ...` /
// `git -C repo`. It now uses the SAME shared resolver the rest of the review system uses
// (resolveReviewRepo: session cwd -> in-session review repo -> in-memory active repo -> process
// cwd; in-memory recall only, never the flap-prone sentinel for routing). Because /review-status
// is strictly read-only, it then falls back to the guarded on-disk sentinel for DISPLAY — the
// identical last resort the statusline footer uses (activeRepoSentinelForDisplay, guarded so a
// repo another agent touched elsewhere can never hijack this session's status).
function reviewStatusRepo(ctx: ExtensionCommandContext): string | undefined {
  const sessionCwd = ctx?.sessionManager?.getCwd?.();
  const resolved = resolveReviewRepo(
    {
      sessionCwd,
      sessionReviewRepo: recallReviewRepo(),
      activeRepo: recallActiveRepo(),
      processCwd: process.cwd(),
    },
    findGitRoot,
  );
  if (resolved) return resolved;
  let sentinelContent: string | undefined;
  try {
    sentinelContent = readFileSync(ACTIVE_REPO_SENTINEL, "utf8");
  } catch {
    return undefined;
  }
  return activeRepoSentinelForDisplay({
    sentinelContent,
    sessionRoots: [sessionCwd, (ctx as { cwd?: string }).cwd],
    hasGitDir: (path) => existsSync(join(path, ".git")),
  });
}

function prView(repo: string): PrView | undefined {
  try {
    const out = shell("gh pr view --json number,state,baseRefName,headRefOid 2>/dev/null", repo);
    return out ? JSON.parse(out) as PrView : undefined;
  } catch {
    return undefined;
  }
}

function gitHead(repo: string): string {
  try { return shell("git rev-parse HEAD", repo); } catch { return ""; }
}

function readTrimmed(path: string): string {
  try { return readFileSync(path, "utf8").trim(); } catch { return ""; }
}

function shortHead(head: string): string {
  return head ? head.slice(0, 12) : "—";
}

function recentReviewEvents(repo: string, count: number): string[] {
  const raw = readTrimmed(join(repo, ".git", "codeflare-review-events.jsonl"));
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).slice(-count);
}

function formatReviewStatus(repo: string): string {
  const pr = prView(repo);
  const local = gitHead(repo);
  const enforced = Boolean(pr?.headRefOid && pr.state === "OPEN" && (pr.baseRefName === "main" || pr.baseRefName === "master"));
  const head = (enforced ? local || pr?.headRefOid : local) || "";
  const state = computeReviewState(repo, head);
  const ackHead = readTrimmed(join(repo, ".git", "sdd-last-ack-pr-head"));

  const lines: string[] = [];
  lines.push(pr?.number ? `PR:          #${pr.number} -> ${pr.baseRefName ?? "?"} (${pr.state ?? "?"})` : "PR:          none open");
  lines.push(`PR head:     ${shortHead(pr?.headRefOid ?? "")}`);
  lines.push(`Local head:  ${shortHead(local)}`);
  lines.push(`Last acked:  ${shortHead(ackHead)}`);
  lines.push(`Review job:  ${state.overall}`);
  if (state.lanes.length > 0) {
    lines.push("Lanes:");
    for (const lane of state.lanes) lines.push(`  ${lane}: ${state.laneStatus[lane]}`);
  } else {
    lines.push("Lanes:       none required for this head");
  }
  lines.push(`Summary:     ${state.summaryReady ? join(repo, ".git", "sdd-review-results", head, "summary.md") : "not ready yet"}`);
  lines.push(`Autofix:     ${state.autofixRequested ? "requested" : "not requested"}`);
  lines.push(`Breaker:     ${state.breakerOpen ? "OPEN — push a new commit or use /tmp/review-bypass" : "closed"}`);
  lines.push(`Merge gate:  ${state.acked ? "OPEN (current head acked)" : "BLOCKED until current head is acked"}`);
  const events = recentReviewEvents(repo, 5);
  if (events.length > 0) {
    lines.push("Recent events:");
    for (const event of events) lines.push(`  ${event}`);
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("review", {
    description: "Run Codeflare review workflow",
    handler: (args, ctx) => dispatchReview(pi, args, ctx),
  });

  pi.registerCommand("review-status", {
    description: "Show PR-boundary review enforcement state for the current repo",
    handler: (_args, ctx) => {
      // Resolve through the shared review resolver (+ guarded display sentinel) so a nested-clone
      // session whose cwd is a non-repo parent workspace still reports the right repo.
      const repo = reviewStatusRepo(ctx);
      if (!repo) {
        ctx.ui.notify("/review-status: not inside a git repository.", "warning");
        return;
      }
      ctx.ui.notify(formatReviewStatus(repo), "info");
    },
  });
}
