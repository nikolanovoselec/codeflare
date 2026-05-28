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
 * graphify_explain.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const DEBUG_WORKFLOW = [
  "Systematic Debugging. Enforce root-cause investigation before any fix attempt. Use for bugs, test failures, unexpected behavior, or when previous fixes have failed.",
  "",
  "HARD GATE: do NOT propose or apply any fix before completing Phase 1. No fixes before root-cause.",
  "",
  "Phase 1 - Root Cause Investigation (before proposing any fix):",
  "1. Read error messages completely: stack traces, line numbers, error codes. Do not skip past them.",
  "2. Reproduce consistently: exact steps, every time? If not reproducible, gather more data, do not guess.",
  "3. Check recent changes: git diff, recent commits, new dependencies, config or environment differences.",
  "4. Multi-component systems: add diagnostic logging at EACH component boundary (log what enters, log what exits, verify config propagation). Run ONCE to gather evidence of WHERE it breaks, then analyze to identify the failing component.",
  "5. Trace data flow: find where the bad value originates, trace backward to the source, fix at the source not the symptom.",
  "",
  "Phase 2 - Pattern Analysis:",
  "1. Find working examples of similar code in the same codebase (use graphify_query / graphify_path to locate them).",
  "2. Compare working vs broken and list every difference.",
  "3. Read reference implementations completely, do not skim.",
  "4. Understand all dependencies, config, and assumptions.",
  "",
  "Phase 3 - Hypothesis and Testing:",
  "1. Form a SINGLE hypothesis: 'X is the root cause because Y'.",
  "2. Make the smallest possible change to test it, one variable at a time.",
  "3. Worked? Go to Phase 4. Did not work? Form a new hypothesis. Do not stack fixes.",
  "",
  "Phase 4 - Implementation:",
  "1. Write a failing test that reproduces the bug.",
  "2. Implement a single fix addressing the root cause.",
  "3. Verify the test passes and no other tests break (tests run via CI, not locally).",
  "",
  "The 3-Fix Rule: if 3 fix attempts have failed, STOP. This is likely a wrong architecture, not a failed hypothesis. Each fix revealing new problems in different places signals an architectural issue. Question the fundamentals (is the pattern sound? are we keeping it through inertia? should we refactor instead?) and discuss with the user before attempting more fixes.",
  "",
  "Red flags - stop and return to Phase 1: 'quick fix for now', 'just try changing X', 'it's probably X', 'I don't fully understand but this might work', proposing solutions before tracing data flow, 'one more fix attempt' after 2+ failures.",
  "",
  "After investigation, present: ROOT CAUSE (what and why), EVIDENCE (what you found), FIX (change addressing root cause), VERIFICATION (how to confirm it works).",
].join("\n");

const DEPLOY_WORKFLOW = [
  "Deploy. Push the current branch, monitor every CI workflow, and deploy to the target environment only after CI passes.",
  "",
  "Target argument: 'integration' (default) or 'production'. If no target is given, assume integration.",
  "",
  "Never run local builds, tests, type checks, or lint: this is a 1-vCPU container and they crash the session. Deploy strictly via push plus CI; never build locally.",
  "",
  "Step 1 - Pre-flight: run 'git status' and warn on uncommitted changes; run 'git log --oneline -3' to show what is about to ship; confirm with the user before proceeding.",
  "",
  "Step 2 - Cancel stale CI: cancel any still-running runs from previous pushes on this branch before pushing again:",
  "  gh run list --branch <branch> --limit 5 --json databaseId,status --jq '.[] | select(.status != \"completed\") | .databaseId' | xargs -I{} gh run cancel {}",
  "",
  "Step 3 - Push: git push origin <branch>",
  "",
  "Step 4 - Monitor CI with bounded per-iteration polling. Do NOT spawn a 'while true' loop and never use 'gh run watch' (it hangs). Run ONE 15-second-spaced check per iteration, read the table, decide, repeat. Cap at ~30 iterations (~7-8 min) before escalating to the user. Each iteration:",
  "  sleep 15; gh run list --branch <branch> --limit 5 --json databaseId,name,status,conclusion --template '{{range .}}{{.databaseId}}{{\"\\t\"}}{{.name}}{{\"\\t\"}}{{.status}}{{\"\\t\"}}{{.conclusion}}{{\"\\n\"}}{{end}}'",
  "Decide each iteration: every row completed + success means CI passed (go to Step 5). Every row completed with at least one non-success means failure: inspect 'gh run view <id> --log-failed', fix, commit, push, restart at iteration 1. Any row queued or in_progress means recheck 15s later. At the iteration cap, stop and escalate. Never claim CI is passing without seeing every row completed AND success in the SAME iteration.",
  "",
  "Step 5 - Evaluate: all rows completed + success means proceed to Step 6. Any failure means report failed run IDs and 'gh run view <id> --log-failed' to the user and do NOT deploy.",
  "",
  "Step 6 - Deploy. For integration: npx wrangler deploy --env integration. For production: first confirm with the user ('Deploying to PRODUCTION. All CI green. Proceed?') and deploy only after explicit confirmation with npx wrangler deploy --env production.",
  "",
  "Step 7 - Verify the live URL: after deploy, hit the deployed health endpoint to confirm the new version is live, e.g. curl -s https://<worker-url>/health | jq . - then report the deployed version and health status. CI green alone does not prove the site works; always verify the live URL.",
].join("\n");

const BRAINSTORM_WORKFLOW = [
  "Brainstorm. Explore a problem space before committing to a solution. Use when starting something new, facing a design decision, or when the right approach is not obvious.",
  "",
  "HARD GATE: no implementation during brainstorming. This is a thinking exercise.",
  "",
  "Step 1 - Understand the problem: what problem are we solving (not what feature are we building)? Who is affected and how? What does success look like? What constraints exist (technical, time, compatibility)? Ask clarifying questions ONE AT A TIME; do not dump a list of 10 questions.",
  "",
  "Step 2 - Explore context: how does the codebase handle similar problems today? Are there existing patterns to follow or deliberately break from? What prior art exists (search the codebase, check dependencies; use graphify_query / graphify_explain to map related code)?",
  "",
  "Step 3 - Generate options: present 2-3 distinct approaches. For each give: How it works (2-3 sentences), Pros (bullets), Cons (bullets), Complexity (low/medium/high), Files touched (key files). Do NOT recommend one yet; present them neutrally.",
  "",
  "Step 4 - Trade-off discussion: ask the user which trade-offs matter most (speed of implementation vs long-term maintainability; minimal change vs proper solution; user-facing impact vs internal cleanliness).",
  "",
  "Step 5 - Recommendation: after hearing the user's priorities, recommend ONE approach with reasoning. If the user agrees, hand off to Plan Mode for implementation planning. If the user wants changes, revise and present again.",
].join("\n");

async function dispatchDebug(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const instructions = [`/debug`, "", DEBUG_WORKFLOW, "", `User input: ${args.trim()}`].join("\n");
  await ctx.waitForIdle();
  await ctx.sendUserMessage(instructions);
}

async function dispatchDeploy(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const target = args.trim() || "integration";
  const instructions = [`/deploy`, "", DEPLOY_WORKFLOW, "", `User input: ${target}`].join("\n");
  await ctx.waitForIdle();
  await ctx.sendUserMessage(instructions);
}

async function dispatchBrainstorm(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const instructions = [`/brainstorm`, "", BRAINSTORM_WORKFLOW, "", `User input: ${args.trim()}`].join("\n");
  await ctx.waitForIdle();
  await ctx.sendUserMessage(instructions);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("debug", {
    description: "Systematic root-cause debugging (no fixes before Phase 1; 3-Fix Rule)",
    handler: dispatchDebug,
  });

  pi.registerCommand("deploy", {
    description: "Push, cancel stale CI, monitor CI, deploy, and verify the live URL",
    handler: dispatchDeploy,
  });

  pi.registerCommand("brainstorm", {
    description: "Structured option-generation with trade-offs and a recommendation",
    handler: dispatchBrainstorm,
  });
}
