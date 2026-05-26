/**
 * Codeflare Pi PR-boundary review enforcement.
 *
 * Native Pi counterpart to Claude Code's PR-boundary review hooks.
 * It watches pushes/PR creation/PR merges for SDD projects with an open PR to
 * main/master, computes the minimal required review lanes, emits Agent calls
 * for only those lanes, persists progress under .git/, and acknowledges the PR
 * head only after the required lanes complete.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ALL_REVIEW_LANES, classifyReviewFiles, isPrBoundaryCommand } from "./review-helpers";

const REVIEW_BYPASS = "/tmp/review-bypass";

type PrState = {
  state?: string;
  baseRefName?: string;
  headRefOid?: string;
  number?: number;
  isDraft?: boolean;
};

type PendingReview = {
  repo: string;
  prNumber?: number;
  baseRefName: string;
  head: string;
  lanes: string[];
  completed: Set<string>;
  docPromptSent: boolean;
  spawned: boolean;
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
  const input = event?.input ?? event?.params ?? event?.args ?? {};
  if (typeof input.command === "string") return input.command;
  if (typeof input.code === "string") return input.code;
  if (Array.isArray(input.commands)) return input.commands.map((cmd: any) => String(cmd?.command ?? "")).join("\n");
  return "";
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

function localHead(repo: string): string | undefined {
  try {
    return shell("git rev-parse HEAD", repo);
  } catch {
    return undefined;
  }
}

function isEnforcedPr(pr: PrState | undefined): pr is Required<Pick<PrState, "headRefOid" | "baseRefName" | "state">> & PrState {
  return Boolean(pr?.headRefOid && pr.state === "OPEN" && (pr.baseRefName === "main" || pr.baseRefName === "master"));
}

function ackPath(repo: string): string {
  return join(repo, ".git", "sdd-last-ack-pr-head");
}

function pendingPath(repo: string): string {
  return join(repo, ".git", "sdd-review-pending.json");
}

function blockCountPath(repo: string): string {
  return join(repo, ".git", "sdd-review-block-count");
}

function lastAckHead(repo: string): string {
  try { return readFileSync(ackPath(repo), "utf8").trim(); } catch { return ""; }
}

function acked(repo: string, head: string): boolean {
  return lastAckHead(repo) === head;
}

function writeAck(repo: string, head: string): void {
  writeFileSync(ackPath(repo), `${head}\n`, "utf8");
}

function clearPending(repo: string): void {
  try { unlinkSync(pendingPath(repo)); } catch { /* best effort */ }
}

function resetBlockCount(repo: string): void {
  try { unlinkSync(blockCountPath(repo)); } catch { /* best effort */ }
}

function incrementBlockCount(repo: string): number {
  const path = blockCountPath(repo);
  let count = 0;
  try { count = Number.parseInt(readFileSync(path, "utf8").trim(), 10) || 0; } catch { count = 0; }
  count += 1;
  writeFileSync(path, String(count), "utf8");
  return count;
}

function consumeBypass(): boolean {
  if (!existsSync(REVIEW_BYPASS)) return false;
  try { unlinkSync(REVIEW_BYPASS); } catch { /* best effort */ }
  return true;
}

function loadPending(repo: string): PendingReview | undefined {
  try {
    const state = JSON.parse(readFileSync(pendingPath(repo), "utf8")) as { prNumber?: number; baseRefName?: string; head?: string; lanes?: string[]; completed?: string[]; docPromptSent?: boolean; spawned?: boolean };
    if (!state.head || !state.baseRefName || !Array.isArray(state.lanes)) return undefined;
    return { repo, prNumber: state.prNumber, baseRefName: state.baseRefName, head: state.head, lanes: state.lanes, completed: new Set(state.completed ?? []), docPromptSent: Boolean(state.docPromptSent), spawned: Boolean(state.spawned) };
  } catch {
    return undefined;
  }
}

function savePending(pending: PendingReview): void {
  writeFileSync(pendingPath(pending.repo), JSON.stringify({ prNumber: pending.prNumber, baseRefName: pending.baseRefName, head: pending.head, lanes: pending.lanes, completed: [...pending.completed], docPromptSent: pending.docPromptSent, spawned: pending.spawned }) + "\n", "utf8");
}

function isAncestor(repo: string, ancestor: string, current: string): boolean {
  if (!ancestor) return false;
  try {
    return shell(`git merge-base ${ancestor} ${current}`, repo) === ancestor;
  } catch {
    return false;
  }
}

function changedFiles(repo: string, from: string, to: string): string[] | undefined {
  if (!from || from === to) return from === to ? [] : undefined;
  if (!isAncestor(repo, from, to)) return undefined;
  try {
    const out = execFileSync("git", ["diff", "-z", "--name-only", "--no-renames", from, to], { cwd: repo, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });
    return out.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return undefined;
  }
}

function mergeLaneState(repo: string, currentHead: string, previous?: PendingReview): { lanes: string[]; completed: Set<string> } {
  const base = previous?.head ?? lastAckHead(repo);
  const changed = classifyReviewFiles(changedFiles(repo, base, currentHead));
  const changedLanes = changed ?? ALL_REVIEW_LANES;
  if (!previous) return { lanes: changedLanes, completed: new Set() };

  const incompletePrevious = previous.lanes.filter((lane) => !previous.completed.has(lane));
  const lanes = [...new Set([...incompletePrevious, ...changedLanes])];
  const completed = new Set(
    previous.lanes.filter((lane) => previous.completed.has(lane) && lanes.includes(lane) && !changedLanes.includes(lane)),
  );
  return { lanes, completed };
}

function agentCall(type: string, prompt: string, description: string): string {
  return `Agent({ subagent_type: ${JSON.stringify(type)}, prompt: ${JSON.stringify(prompt)}, description: ${JSON.stringify(description)}, run_in_background: true })`;
}

function subagentsService(): any | undefined {
  return (globalThis as Record<symbol, unknown>)[Symbol.for("@gotgenes/pi-subagents:service")];
}

async function spawnLane(type: string, prompt: string, description: string): Promise<boolean> {
  const service = subagentsService();
  if (!service?.spawn) return false;
  service.spawn(type, prompt, { description, inheritContext: false });
  return true;
}

async function spawnInitialLanes(pending: PendingReview, pr: PrState): Promise<boolean> {
  const base = reviewPrompt(pending.repo, pr, pending.head);
  let spawned = false;
  if (pending.lanes.includes("code-reviewer")) {
    spawned = await spawnLane("code-reviewer", base, "Review code changes") || spawned;
  }
  if (pending.lanes.includes("spec-reviewer")) {
    spawned = await spawnLane("spec-reviewer", base, "Review spec changes") || spawned;
  }
  if (pending.lanes.includes("doc-updater") && !pending.lanes.includes("spec-reviewer")) {
    spawned = await spawnLane("doc-updater", base, "Review documentation changes") || spawned;
  }
  return spawned;
}

function reviewPrompt(repo: string, pr: PrState, head: string): string {
  return `Work in ${repo}. Review PR #${pr.number ?? "?"} for ${basename(repo)} at head ${head}. Scope is the current diff against ${pr.baseRefName}. Report findings only; do not modify files.`;
}

function directiveFor(repo: string, pr: PrState, lanes: string[]): string {
  const laneText = lanes.join(", ");
  const head = pr.headRefOid!;
  const sequence = lanes.includes("spec-reviewer") && lanes.includes("doc-updater")
    ? `${lanes.filter((lane) => lane !== "doc-updater").join(" + ")} first; doc-updater after spec-reviewer completes`
    : laneText;
  return `PR-boundary review required for ${basename(repo)} PR #${pr.number ?? "?"} at ${head.slice(0, 12)}. Current head must equal ${head}; ignore if stale. Required lanes: ${laneText}. Run: ${sequence}. Acknowledgement is automatic after required lanes complete.`;
}

function docUpdaterPrompt(pending: PendingReview): string {
  return `Work in ${pending.repo}. Review PR #${pending.prNumber ?? "?"} for ${basename(pending.repo)} at head ${pending.head}. Scope is the current diff against ${pending.baseRefName}. Report findings only; do not modify files. Run after spec-reviewer so documentation sees final spec changes.`;
}

function isCurrentPending(pending: PendingReview): boolean {
  const current = prState(pending.repo);
  if (!isEnforcedPr(current)) return false;
  const effectiveHead = localHead(pending.repo) ?? current.headRefOid;
  return effectiveHead === pending.head;
}

export default function (pi: ExtensionAPI) {
  let pending: PendingReview | undefined;

  function hydratePending(ctx: any): PendingReview | undefined {
    if (pending) return pending;
    const repo = activeRepoFallback() ?? findGitRoot(ctx.sessionManager.getCwd());
    pending = repo ? loadPending(repo) : undefined;
    return pending;
  }

  async function markCompleted(type: string, ctx: any): Promise<void> {
    const state = hydratePending(ctx);
    if (!state || !state.lanes.includes(type)) return;
    if (!isCurrentPending(state)) {
      clearPending(state.repo);
      pending = undefined;
      return;
    }
    state.completed.add(type);
    if (type === "spec-reviewer" && state.lanes.includes("doc-updater") && !state.docPromptSent) {
      state.docPromptSent = true;
      savePending(state);
      const spawned = await spawnLane("doc-updater", docUpdaterPrompt(state), "Review documentation changes");
      if (!spawned) pi.sendUserMessage(agentCall("doc-updater", docUpdaterPrompt(state), "Review documentation changes"), { deliverAs: "followUp" });
      return;
    }
    savePending(state);
    if (state.lanes.every((lane) => state.completed.has(lane))) {
      writeAck(state.repo, state.head);
      resetBlockCount(state.repo);
      clearPending(state.repo);
      ctx.ui.notify(`PR-boundary review acknowledged for ${basename(state.repo)} at ${state.head.slice(0, 12)}.`, "info");
      pending = undefined;
    }
  }

  const onAgentStart = (event: any, ctx: any) => {
    const toolName = String(event?.toolName ?? "").toLowerCase();
    if (toolName !== "agent") return;
    const input = event?.input ?? event?.params ?? event?.args ?? {};
    const type = String(input.subagent_type ?? input.subagentType ?? "");
    if (type !== "doc-updater") return;
    const state = hydratePending(ctx);
    if (!state) return;
    if (!isCurrentPending(state)) {
      clearPending(state.repo);
      pending = undefined;
      return;
    }
    if (state.lanes.includes("spec-reviewer") && !state.completed.has("spec-reviewer")) {
      return { block: true, reason: "PR-boundary review order violation: doc-updater must run only after spec-reviewer completes for this PR HEAD." };
    }
  };

  pi.on("tool_call", onAgentStart);
  pi.on("tool_execution_start", onAgentStart);

  const onToolEnd = async (event: any, ctx: any) => {
    const toolName = String(event?.toolName ?? "").toLowerCase();
    if (toolName === "agent") {
      const input = event?.input ?? event?.params ?? event?.args ?? {};
      const type = String(input.subagent_type ?? input.subagentType ?? "");
      if (type) await markCompleted(type, ctx);
      return;
    }

    const command = commandText(event);
    const isShellSurface = toolName === "bash" || toolName.includes("ctx_execute") || toolName.includes("ctx_batch_execute");
    if (!isShellSurface || !isPrBoundaryCommand(command)) return;

    const repo = findGitRoot(cwdFromCommand(command) ?? ctx.sessionManager.getCwd()) ?? activeRepoFallback();
    if (!repo || !isSddProject(repo) || consumeBypass()) return;

    const pr = prState(repo);
    if (!isEnforcedPr(pr)) return;
    const head = localHead(repo) ?? pr.headRefOid;
    const effectivePr = { ...pr, headRefOid: head };
    if (acked(repo, head)) return;

    const previous = loadPending(repo);
    if (previous && previous.head === head) return;
    if (previous && !isAncestor(repo, previous.head, head)) clearPending(repo);

    const review = mergeLaneState(repo, head, previous && isAncestor(repo, previous.head, head) ? previous : undefined);
    if (review.lanes.length === 0) {
      writeAck(repo, head);
      clearPending(repo);
      return;
    }

    resetBlockCount(repo);
    pending = { repo, prNumber: pr.number, baseRefName: pr.baseRefName, head, lanes: review.lanes, completed: review.completed, docPromptSent: false, spawned: false };
    const spawned = await spawnInitialLanes(pending, effectivePr);
    pending.spawned = spawned;
    savePending(pending);
    ctx.ui.notify(`PR-boundary review required for ${basename(repo)} at ${head.slice(0, 12)}. Lanes: ${review.lanes.join(", ")}.`, "warning");
    if (!spawned) {
      pi.sendUserMessage(directiveFor(repo, effectivePr, review.lanes), { deliverAs: "followUp" });
    }
  };

  pi.on("tool_result", onToolEnd);
  pi.on("tool_execution_end", onToolEnd);

  const onSubagentCompleted = async (event: any, ctx: any) => {
    const type = String(event?.type ?? "");
    if (type) await markCompleted(type, ctx);
  };

  pi.on("subagents:completed", onSubagentCompleted);
  (pi as any).events?.on?.("subagents:completed", (event: any) => onSubagentCompleted(event, { sessionManager: { getCwd: () => process.cwd() }, ui: { notify: () => undefined } }));

  pi.on("agent_end", (_event, ctx) => {
    const state = hydratePending(ctx);
    if (!state) return;
    if (acked(state.repo, state.head) || consumeBypass()) {
      clearPending(state.repo);
      pending = undefined;
      return;
    }
    if (!isCurrentPending(state)) {
      clearPending(state.repo);
      pending = undefined;
      return;
    }
    const currentState = loadPending(state.repo) ?? state;
    if (currentState.spawned) {
      return;
    }
    const service = subagentsService();
    if (service?.hasRunning?.()) {
      return;
    }
    const count = incrementBlockCount(state.repo);
    if (count >= 3) {
      ctx.ui.notify(`Review enforcement circuit breaker opened after ${count} reminders for ${basename(state.repo)}.`, "warning");
      pending = undefined;
      return;
    }
    const remaining = currentState.lanes.filter((lane) => !currentState.completed.has(lane)).join(", ") || "none";
    const reminder = `PR-boundary review still pending for ${basename(state.repo)} at ${state.head.slice(0, 12)}. Remaining lanes: ${remaining}. Reminder ${count}/3.`;
    ctx.ui.notify(reminder, "warning");
    pi.sendUserMessage(`${reminder}\nComplete the remaining subagents or use the user-only bypass ${REVIEW_BYPASS}.`, { deliverAs: "followUp" });
  });
}
