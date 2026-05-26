/**
 * Codeflare Pi PR-boundary review enforcement.
 *
 * Native Pi counterpart to Claude Code's git-push-review-reminder.sh and
 * enforce-review-spawn.sh. This is not /review. It watches PR-boundary events
 * and requires a /review --diff acknowledgement for each open PR HEAD that
 * targets main/master in SDD projects.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REVIEW_BYPASS = "/tmp/review-bypass";

type PrState = {
  state?: string;
  baseRefName?: string;
  headRefOid?: string;
  number?: number;
  isDraft?: boolean;
};

function shell(command: string, cwd: string): string {
  return execFileSync("bash", ["-lc", command], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function findGitRoot(startDir: string): string | undefined {
  let current = startDir;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function cwdFromCommand(command: string): string | undefined {
  const match = command.match(/(?:^|[;&|]\s*)cd\s+([^;&|]+)\s*&&/);
  if (!match) return undefined;
  return match[1].trim().replace(/^(["'])(.*)\1$/, "$2");
}

function activeRepoFallback(): string | undefined {
  try {
    const p = "/home/user/.cache/codeflare-hooks/graphify-active-cwd";
    if (existsSync(p)) return readFileSync(p, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
  return undefined;
}

function commandText(event: any): string {
  const input = event?.input ?? {};
  if (typeof input.command === "string") return input.command;
  if (typeof input.code === "string") return input.code;
  if (Array.isArray(input.commands)) return input.commands.map((cmd: any) => String(cmd?.command ?? "")).join("\n");
  return "";
}

function isGitPush(command: string): boolean {
  return /(^|[;&|]\s*)git\s+push\b/.test(command);
}

function isPrCreate(command: string): boolean {
  return /(^|[;&|]\s*)gh\s+pr\s+create\b/.test(command);
}

function isSddProject(repo: string): boolean {
  return existsSync(join(repo, "sdd", "README.md"));
}

function prState(repo: string): PrState | undefined {
  try {
    const out = shell("gh pr view --json number,state,baseRefName,headRefOid,isDraft 2>/dev/null", repo);
    return out ? JSON.parse(out) as PrState : undefined;
  } catch {
    return undefined;
  }
}

function isEnforcedPr(pr: PrState | undefined): pr is Required<Pick<PrState, "headRefOid" | "baseRefName" | "state">> & PrState {
  return Boolean(pr?.headRefOid && pr.state === "OPEN" && (pr.baseRefName === "main" || pr.baseRefName === "master"));
}

function changedFiles(repo: string): string[] {
  try {
    const base = shell("git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD origin/master 2>/dev/null || git rev-parse HEAD~1", repo);
    const out = shell(`git diff --name-only ${base}...HEAD`, repo);
    return out ? out.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

function requiredReviewLanes(repo: string): string[] {
  const files = changedFiles(repo);
  const lanes = new Set<string>();
  for (const file of files) {
    if (file.startsWith("sdd/")) lanes.add("spec-reviewer");
    else if (file.startsWith("documentation/") || file === "README.md") lanes.add("doc-updater");
    else lanes.add("code-reviewer");
  }
  if (lanes.has("spec-reviewer")) lanes.add("doc-updater");
  return [...lanes];
}

function ackPath(repo: string): string {
  return join(repo, ".git", "sdd-last-ack-pr-head");
}

function blockCountPath(repo: string): string {
  return join(repo, ".git", "sdd-review-block-count");
}

function acked(repo: string, head: string): boolean {
  try {
    return readFileSync(ackPath(repo), "utf8").trim() === head;
  } catch {
    return false;
  }
}

function incrementBlockCount(repo: string): number {
  const path = blockCountPath(repo);
  let count = 0;
  try {
    count = Number.parseInt(readFileSync(path, "utf8").trim(), 10) || 0;
  } catch {
    count = 0;
  }
  count += 1;
  writeFileSync(path, String(count), "utf8");
  return count;
}

function consumeBypass(): boolean {
  if (!existsSync(REVIEW_BYPASS)) return false;
  try { unlinkSync(REVIEW_BYPASS); } catch { /* best effort */ }
  return true;
}

function enforcementMessage(repo: string, pr: PrState, lanes: string[]): string {
  const laneText = lanes.length > 0 ? lanes.join(", ") : "code-reviewer";
  return `PR-boundary review required for ${basename(repo)} PR #${pr.number ?? "?"} (${pr.baseRefName}, head ${pr.headRefOid?.slice(0, 12)}). Required lanes: ${laneText}. Run the requested subagents or /review --diff before finishing this turn.`;
}

function subagentDirective(repo: string, pr: PrState, lanes: string[]): string {
  const base = `Review PR #${pr.number ?? "?"} for ${basename(repo)} at head ${pr.headRefOid}. Scope is the current diff against ${pr.baseRefName}. Report findings only; do not modify files.`;
  const tasks = lanes.length > 0 ? lanes : ["code-reviewer"];
  const parallel = tasks.filter((lane) => lane !== "doc-updater");
  const commands: string[] = [];
  if (parallel.length === 1) {
    commands.push(`/run ${parallel[0]} ${JSON.stringify(base)} --fork`);
  } else if (parallel.length > 1) {
    commands.push(`/parallel ${parallel.map((lane) => `${lane} ${JSON.stringify(base)}`).join(" -> ")} --fork`);
  }
  if (tasks.includes("doc-updater")) {
    commands.push(`/run doc-updater ${JSON.stringify(`${base} Run after spec-reviewer so documentation sees final spec changes.`)} --fork`);
  }
  commands.push("After required subagents report, run /review --diff to acknowledge this PR HEAD.");
  return commands.join("\n");
}

export default function (pi: ExtensionAPI) {
  let pending: { repo: string; head: string; message: string } | undefined;

  pi.on("tool_result", (event, ctx) => {
    const toolName = String(event?.toolName ?? "").toLowerCase();
    const command = commandText(event);
    if (toolName !== "bash" && !toolName.startsWith("context_mode_ctx_execute")) return;
    if (!isGitPush(command) && !isPrCreate(command)) return;

    const repo = findGitRoot(cwdFromCommand(command) ?? ctx.sessionManager.getCwd()) ?? activeRepoFallback();
    if (!repo || !isSddProject(repo)) return;
    if (consumeBypass()) return;

    const pr = prState(repo);
    if (!isEnforcedPr(pr)) return;
    if (acked(repo, pr.headRefOid)) return;

    const lanes = requiredReviewLanes(repo);
    const message = enforcementMessage(repo, pr, lanes);
    const directive = `${message}\n\n${subagentDirective(repo, pr, lanes)}`;
    pending = { repo, head: pr.headRefOid, message: directive };
    ctx.ui.notify(message, "warning");
    pi.sendUserMessage(directive, { deliverAs: "followUp" });
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!pending) return;
    if (acked(pending.repo, pending.head)) {
      pending = undefined;
      return;
    }
    if (consumeBypass()) {
      pending = undefined;
      return;
    }
    const count = incrementBlockCount(pending.repo);
    if (count >= 3) {
      ctx.ui.notify(`Review enforcement circuit breaker opened after ${count} reminders for ${basename(pending.repo)}.`, "warning");
      pending = undefined;
      return;
    }
    ctx.ui.notify(`${pending.message} Reminder ${count}/3.`, "warning");
    pi.sendUserMessage(`${pending.message}\n\nThis is enforcement, not /review help. Complete /review --diff or use the user-only bypass ${REVIEW_BYPASS}.`, { deliverAs: "followUp" });
  });
}
