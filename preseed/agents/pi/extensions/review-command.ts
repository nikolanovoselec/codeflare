/**
 * Codeflare Pi /review command.
 *
 * This is the user-invoked review workflow. It is intentionally separate
 * from PR-boundary enforcement: /review reviews a chosen scope; enforcement
 * decides when a PR HEAD must have been reviewed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

function shell(command: string, cwd: string): string {
  return execFileSync("bash", ["-lc", command], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function findGitRoot(startDir: string): string | undefined {
  try {
    const root = shell("git rev-parse --show-toplevel", startDir);
    return root || undefined;
  } catch {
    return undefined;
  }
}

function currentPrHead(repo: string): string | undefined {
  try {
    const json = shell("gh pr view --json headRefOid,state,baseRefName 2>/dev/null", repo);
    if (!json) return undefined;
    const pr = JSON.parse(json) as { headRefOid?: string; state?: string; baseRefName?: string };
    if (pr.state !== "OPEN") return undefined;
    if (pr.baseRefName !== "main" && pr.baseRefName !== "master") return undefined;
    return pr.headRefOid;
  } catch {
    return undefined;
  }
}

function skillPrompt(name: string, fallback: string): string {
  const candidates = [
    join(process.cwd(), ".agents", "skills", name, "SKILL.md"),
    join("/home/user/.agents/skills", name, "SKILL.md"),
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

async function dispatchReview(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim();
  if (!/(^|\s)--(all|diff)(\s|$)/.test(trimmed)) {
    ctx.ui.notify(helpText(), "warning");
    return;
  }

  const repo = findGitRoot(ctx.sessionManager.getCwd());
  const command = `/review ${trimmed}`;
  const reviewInstructions = [
    skillPrompt("git-review-pipeline", "Run the Codeflare review pipeline."),
    "",
    "This is the user-invoked /review command, not the PR-boundary enforcement hook.",
    "Review the requested scope and report findings clearly. If --deep is present, use deep behavioral REQ verification guidance. If --verify-high is present, include high-severity second-opinion guidance where the configured tool surface supports it.",
    "",
    `User command: ${command}`,
  ].join("\n");

  await ctx.waitForIdle();
  await ctx.sendUserMessage(reviewInstructions);

  // Native Pi has no Claude-style subagent completion event. Until a richer
  // review-run marker exists, treating explicit /review invocation as the
  // acknowledgement is the safest non-blocking equivalent for PR-boundary
  // enforcement.
  if (repo && trimmed.includes("--diff")) {
    const head = currentPrHead(repo);
    if (head) writeFileSync(join(repo, ".git", "sdd-last-ack-pr-head"), head + "\n", "utf8");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("review", {
    description: "Run Codeflare review workflow",
    handler: dispatchReview,
  });
}
