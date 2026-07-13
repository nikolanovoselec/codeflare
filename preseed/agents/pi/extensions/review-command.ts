/**
 * Codeflare Pi /review command.
 *
 * This is the user-invoked review workflow. It is intentionally separate
 * from PR-boundary enforcement: /review reviews a chosen scope; enforcement
 * decides when a PR HEAD must have been reviewed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveReviewScope, scopeContract, type ReviewScopeContract } from "./review-scope";

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

export type ReviewCommandDecision =
  | { kind: "help" }
  | { kind: "workflow"; command: string; scope: ReviewScopeContract };

export function reviewCommandDecision(args: string): ReviewCommandDecision {
  const trimmed = args.trim();
  const mode = resolveReviewScope(trimmed);
  if (!mode) return { kind: "help" };
  return { kind: "workflow", command: `/review ${trimmed}`, scope: scopeContract(mode) };
}

async function dispatchReview(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const decision = reviewCommandDecision(args);
  if (decision.kind === "help") {
    ctx.ui.notify(helpText(), "warning");
    return;
  }

  const reviewInstructions = [
    skillPrompt("review", "Run the Codeflare multi-phase review workflow for the requested scope and report findings."),
    "",
    "This is the user-invoked /review command, not the PR-boundary enforcement hook.",
    `Resolved scope: ${JSON.stringify(decision.scope)}`,
    `User command: ${decision.command}`,
  ].join("\n");

  await sendUserPrompt(pi, ctx, reviewInstructions);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("review", {
    description: "Run Codeflare review workflow",
    handler: (args, ctx) => dispatchReview(pi, args, ctx),
  });
}
