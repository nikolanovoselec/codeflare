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

const REVIEW_BYPASS = "/tmp/review-bypass";
const ALL_LANES = ["code-reviewer", "spec-reviewer", "doc-updater"];

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

export function isPrBoundaryCommand(command: string): boolean {
  return /(^|[;&|]\s*)git\s+push\b/.test(command) || /(^|[;&|]\s*)gh\s+pr\s+(create|merge)\b/.test(command);
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
    const state = JSON.parse(readFileSync(pendingPath(repo), "utf8")) as { prNumber?: number; baseRefName?: string; head?: string; lanes?: string[]; completed?: string[]; docPromptSent?: boolean };
    if (!state.head || !state.baseRefName || !Array.isArray(state.lanes)) return undefined;
    return { repo, prNumber: state.prNumber, baseRefName: state.baseRefName, head: state.head, lanes: state.lanes, completed: new Set(state.completed ?? []), docPromptSent: Boolean(state.docPromptSent) };
  } catch {
    return undefined;
  }
}

function savePending(pending: PendingReview): void {
  writeFileSync(pendingPath(pending.repo), JSON.stringify({ prNumber: pending.prNumber, baseRefName: pending.baseRefName, head: pending.head, lanes: pending.lanes, completed: [...pending.completed], docPromptSent: pending.docPromptSent }) + "\n", "utf8");
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

export function classifyReviewFiles(files: string[] | undefined): string[] | undefined {
  if (files === undefined) return ALL_LANES;
  if (files.length === 0) return [];
  let hasBehavioral = false;
  let touchesSdd = false;
  let touchesDocs = false;
  for (const file of files) {
    if (file.startsWith("sdd/")) touchesSdd = true;
    else if (file.startsWith("documentation/") || ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "LICENSE"].includes(file)) touchesDocs = true;
    else hasBehavioral = true;
  }
  if (hasBehavioral) return ALL_LANES;
  if (touchesSdd) return ["spec-reviewer", "doc-updater"];
  if (touchesDocs) return ["doc-updater"];
  return [];
}

function mergeLaneState(repo: string, currentHead: string, previous?: PendingReview): { lanes: string[]; completed: Set<string> } {
  const base = previous?.head ?? lastAckHead(repo);
  const changed = classifyReviewFiles(changedFiles(repo, base, currentHead));
  const changedLanes = changed ?? ALL_LANES;
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

function reviewPrompt(repo: string, pr: PrState, head: string): string {
  return `Review PR #${pr.number ?? "?"} for ${basename(repo)} at head ${head}. Scope is the current diff against ${pr.baseRefName}. Report findings only; do not modify files.`;
}

function directiveFor(repo: string, pr: PrState, lanes: string[]): string {
  const laneText = lanes.join(", ");
  const base = reviewPrompt(repo, pr, pr.headRefOid!);
  const lines = [
    `PR-boundary review required for ${basename(repo)} PR #${pr.number ?? "?"} (${pr.baseRefName}, head ${pr.headRefOid!.slice(0, 12)}). Required lanes: ${laneText}.`,
    `Freshness gate: verify current PR head is exactly ${pr.headRefOid} before launching agents; ignore this directive if it changed.`,
  ];
  const parallel = lanes.filter((lane) => lane === "code-reviewer" || lane === "spec-reviewer");
  if (parallel.length > 0) {
    lines.push("Launch these Agent calls in parallel:");
    for (const lane of parallel) lines.push(agentCall(lane, base, lane === "code-reviewer" ? "Review code changes" : "Review spec changes"));
  }
  if (lanes.includes("doc-updater")) {
    if (lanes.includes("spec-reviewer")) lines.push("After spec-reviewer completes, this extension sends the doc-updater Agent call automatically.");
    else lines.push(agentCall("doc-updater", base, "Review documentation changes"));
  }
  lines.push(`Acknowledgement is automatic after required lanes complete: ${laneText}.`);
  return lines.join("\n");
}

function docUpdaterPrompt(pending: PendingReview): string {
  return `Review PR #${pending.prNumber ?? "?"} for ${basename(pending.repo)} at head ${pending.head}. Scope is the current diff against ${pending.baseRefName}. Report findings only; do not modify files. Run after spec-reviewer so documentation sees final spec changes.`;
}

function isCurrentPending(pending: PendingReview): boolean {
  const current = prState(pending.repo);
  return Boolean(isEnforcedPr(current) && current.headRefOid === pending.head);
}

export default function (pi: ExtensionAPI) {
  let pending: PendingReview | undefined;

  function hydratePending(ctx: any): PendingReview | undefined {
    if (pending) return pending;
    const repo = activeRepoFallback() ?? findGitRoot(ctx.sessionManager.getCwd());
    pending = repo ? loadPending(repo) : undefined;
    return pending;
  }

  function markCompleted(type: string, ctx: any): void {
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
      pi.sendUserMessage(agentCall("doc-updater", docUpdaterPrompt(state), "Review documentation changes"), { deliverAs: "followUp" });
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

  pi.on("tool_call", (event, ctx) => {
    const toolName = String(event?.toolName ?? "").toLowerCase();
    if (toolName !== "agent") return;
    const input = event?.input ?? event?.params ?? {};
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
  });

  pi.on("tool_result", (event, ctx) => {
    const toolName = String(event?.toolName ?? "").toLowerCase();
    if (toolName === "agent") {
      const input = event?.input ?? event?.params ?? {};
      const type = String(input.subagent_type ?? input.subagentType ?? "");
      if (type) markCompleted(type, ctx);
      return;
    }

    const command = commandText(event);
    const isShellSurface = toolName === "bash" || toolName.includes("ctx_execute") || toolName.includes("ctx_batch_execute");
    if (!isShellSurface || !isPrBoundaryCommand(command)) return;

    const repo = findGitRoot(cwdFromCommand(command) ?? ctx.sessionManager.getCwd()) ?? activeRepoFallback();
    if (!repo || !isSddProject(repo) || consumeBypass()) return;

    const pr = prState(repo);
    if (!isEnforcedPr(pr)) return;
    if (acked(repo, pr.headRefOid)) return;

    const previous = loadPending(repo);
    if (previous && previous.head === pr.headRefOid) return;
    if (previous && !isAncestor(repo, previous.head, pr.headRefOid)) clearPending(repo);

    const review = mergeLaneState(repo, pr.headRefOid, previous && isAncestor(repo, previous.head, pr.headRefOid) ? previous : undefined);
    if (review.lanes.length === 0) {
      writeAck(repo, pr.headRefOid);
      clearPending(repo);
      return;
    }

    resetBlockCount(repo);
    pending = { repo, prNumber: pr.number, baseRefName: pr.baseRefName, head: pr.headRefOid, lanes: review.lanes, completed: review.completed, docPromptSent: false };
    savePending(pending);
    const message = directiveFor(repo, pr, review.lanes);
    ctx.ui.notify(`PR-boundary review required for ${basename(repo)} at ${pr.headRefOid.slice(0, 12)}. Lanes: ${review.lanes.join(", ")}.`, "warning");
    pi.sendUserMessage(message, { deliverAs: "followUp" });
  });

  const onSubagentCompleted = (event: any, ctx: any) => {
    const type = String(event?.type ?? "");
    if (type) markCompleted(type, ctx);
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
    const count = incrementBlockCount(state.repo);
    if (count >= 3) {
      ctx.ui.notify(`Review enforcement circuit breaker opened after ${count} reminders for ${basename(state.repo)}.`, "warning");
      pending = undefined;
      return;
    }
    const remaining = state.lanes.filter((lane) => !state.completed.has(lane)).join(", ") || "none";
    const reminder = `PR-boundary review still pending for ${basename(state.repo)} at ${state.head.slice(0, 12)}. Remaining lanes: ${remaining}. Reminder ${count}/3.`;
    ctx.ui.notify(reminder, "warning");
    pi.sendUserMessage(`${reminder}\nComplete the remaining subagents or use the user-only bypass ${REVIEW_BYPASS}.`, { deliverAs: "followUp" });
  });
}
