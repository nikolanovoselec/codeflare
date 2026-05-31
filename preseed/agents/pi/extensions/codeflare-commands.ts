/**
 * Codeflare Pi commands that Claude ships but Pi lacks: /debug, /deploy, /brainstorm.
 *
 * Each command injects a faithful, Pi-adapted version of the corresponding Claude
 * command's workflow into the conversation as a user message. Unlike /review (which
 * loads a SKILL.md via skillPrompt), these workflows have no Pi skill file, so the
 * instruction text is embedded here.
 *
 * Pi adaptations: subagents are spawned via the Agent tool; agent state lives
 * under /home/user/.pi; graph lookups use graphify_query / graphify_path /
 * graphify_explain. The workflow text and instruction assembly live in
 * commands-helpers.ts so they can be unit-tested without the Pi package.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEBUG_WORKFLOW, DEPLOY_WORKFLOW, BRAINSTORM_WORKFLOW, commandInstructions, deployTarget } from "./commands-helpers";

async function sendUserPrompt(pi: ExtensionAPI, ctx: ExtensionCommandContext, message: string): Promise<void> {
  await ctx.waitForIdle();
  const contextSender = (ctx as ExtensionCommandContext & { sendUserMessage?: (content: string) => void | Promise<void> }).sendUserMessage;
  if (typeof contextSender === "function") {
    await contextSender.call(ctx, message);
    return;
  }
  pi.sendUserMessage(message);
}

async function dispatchDebug(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  await sendUserPrompt(pi, ctx, commandInstructions("/debug", DEBUG_WORKFLOW, args.trim()));
}

async function dispatchDeploy(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  await sendUserPrompt(pi, ctx, commandInstructions("/deploy", DEPLOY_WORKFLOW, deployTarget(args)));
}

async function dispatchBrainstorm(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
  await sendUserPrompt(pi, ctx, commandInstructions("/brainstorm", BRAINSTORM_WORKFLOW, args.trim()));
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("debug", {
    description: "Systematic root-cause debugging (no fixes before Phase 1; 3-Fix Rule)",
    handler: (args, ctx) => dispatchDebug(pi, args, ctx),
  });

  pi.registerCommand("deploy", {
    description: "Push, cancel stale CI, monitor CI, deploy, and verify the live URL",
    handler: (args, ctx) => dispatchDeploy(pi, args, ctx),
  });

  pi.registerCommand("brainstorm", {
    description: "Structured option-generation with trade-offs and a recommendation",
    handler: (args, ctx) => dispatchBrainstorm(pi, args, ctx),
  });
}
