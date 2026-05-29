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

export default function (pi: ExtensionAPI) {
  pi.registerCommand("review", {
    description: "Run Codeflare review workflow",
    handler: (args, ctx) => dispatchReview(pi, args, ctx),
  });
}
