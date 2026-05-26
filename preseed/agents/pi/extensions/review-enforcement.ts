/**
 * Codeflare Pi PR-boundary review enforcement.
 *
 * Native Pi counterpart to Claude Code's git-push-review-reminder.sh and
 * enforce-review-spawn.sh. This is not /review. It watches PR-boundary events
 * and requires code/spec/doc subagent completion for each open PR HEAD that
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
  const input = event?.input ?? event?.params ?? {};
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

function requiredReviewLanes(_repo: string): string[] {
  return ["code-reviewer", "spec-reviewer", "doc-updater"];
}

function ackPath(repo: string): string {
  return join(repo, ".git", "sdd-last-ack-pr-head");
}

function pendingPath(repo: string): string {
  return join(repo, ".git", "sdd-review-pending.json");
}

type PendingReview = { repo: string; head: string; message: string; completed: Set<string>; docPromptSent: boolean };

function savePending(pending: PendingReview): void {
  writeFileSync(pendingPath(pending.repo), JSON.stringify({ head: pending.head, message: pending.message, completed: [...pending.completed], docPromptSent: pending.docPromptSent }) + "\n", "utf8");
}

function loadPending(repo: string): PendingReview | undefined {
  try {
    const state = JSON.parse(readFileSync(pendingPath(repo), "utf8")) as { head?: string; message?: string; completed?: string[]; docPromptSent?: boolean };
    if (!state.head || !state.message) return undefined;
    return { repo, head: state.head, message: state.message, completed: new Set(state.completed ?? []), docPromptSent: Boolean(state.docPromptSent) };
  } catch {
    return undefined;
  }
}

function clearPending(repo: string): void {
  try { unlinkSync(pendingPath(repo)); } catch { /* best effort */ }
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

function resetBlockCount(repo: string): void {
  try { unlinkSync(blockCountPath(repo)); } catch { /* best effort */ }
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
  const tasks = lanes.length > 0 ? lanes : ["code-reviewer", "spec-reviewer", "doc-updater"];
  const parallel = tasks.filter((lane) => lane === "code-reviewer" || lane === "spec-reviewer");
  const commands: string[] = [];
  if (parallel.length === 1) {
    commands.push(`/run ${parallel[0]} ${JSON.stringify(base)} --fork --bg`);
  } else if (parallel.length > 1) {
    commands.push(`/parallel ${parallel.map((lane) => `${lane} ${JSON.stringify(base)}`).join(" -> ")} --fork --bg`);
  }
  if (tasks.includes("doc-updater")) {
    commands.push("After spec-reviewer completes, review enforcement will send the doc-updater command automatically.");
  }
  commands.push("Review acknowledgement is recorded automatically after code-reviewer, spec-reviewer, and doc-updater complete for this PR HEAD.");
  return commands.join("\n");
}

export default function (pi: ExtensionAPI) {
  let pending: PendingReview | undefined;

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

    resetBlockCount(repo);
    const lanes = requiredReviewLanes(repo);
    const message = enforcementMessage(repo, pr, lanes);
    const directive = `${message}\n\n${subagentDirective(repo, pr, lanes)}`;
    pending = { repo, head: pr.headRefOid, message: directive, completed: new Set(), docPromptSent: false };
    savePending(pending);
    ctx.ui.notify(message, "warning");
    pi.sendUserMessage(directive, { deliverAs: "followUp" });
  });

  pi.on("subagents:completed", (event, ctx) => {
    if (!pending) {
      const repo = activeRepoFallback() ?? findGitRoot(ctx.sessionManager.getCwd());
      pending = repo ? loadPending(repo) : undefined;
    }
    if (!pending) return;
    const type = String(event?.type ?? "");
    if (!type) return;
    const current = prState(pending.repo);
    if (!isEnforcedPr(current) || current.headRefOid !== pending.head) {
      clearPending(pending.repo);
      pending = undefined;
      return;
    }
    pending.completed.add(type);
    if (type === "spec-reviewer" && !pending.docPromptSent) {
      pending.docPromptSent = true;
      const base = `Review PR #${current.number ?? "?"} for ${basename(pending.repo)} at head ${pending.head}. Scope is the current diff against ${current.baseRefName}. Report findings only; do not modify files. Run after spec-reviewer so documentation sees final spec changes.`;
      savePending(pending);
      pi.sendUserMessage(`/run doc-updater ${JSON.stringify(base)} --fork --bg`, { deliverAs: "followUp" });
      return;
    }
    savePending(pending);
    if (["code-reviewer", "spec-reviewer", "doc-updater"].every((lane) => pending?.completed.has(lane))) {
      writeFileSync(ackPath(pending.repo), `${pending.head}
`, "utf8");
      resetBlockCount(pending.repo);
      clearPending(pending.repo);
      ctx.ui.notify(`PR-boundary review acknowledged for ${basename(pending.repo)} at ${pending.head.slice(0, 12)}.`, "info");
      pending = undefined;
    }
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
    const current = prState(pending.repo);
    if (!isEnforcedPr(current) || current.headRefOid !== pending.head) {
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
    pi.sendUserMessage(`${pending.message}\n\nThis is enforcement, not /review help. Complete the required subagents or use the user-only bypass ${REVIEW_BYPASS}.`, { deliverAs: "followUp" });
  });
}
