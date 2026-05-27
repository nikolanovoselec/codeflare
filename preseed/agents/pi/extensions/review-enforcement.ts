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
import { ALL_REVIEW_LANES, classifyReviewFiles, isCurrentReviewHead, isFailedToolExecution, isPrBoundaryCommand, isReviewCompletionForLane } from "./review-helpers";

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
  reviewBase?: string;
  lanes: string[];
  completed: Set<string>;
  docPromptSent: boolean;
  spawned: boolean;
  spawnedIds: Record<string, string>;
  fallbackLanes: Set<string>;
  spawnedAt?: number;
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
  const input = event?.input || event?.params || event?.args || {};
  if (typeof input.command === "string") return input.command;
  if (typeof input.code === "string") return input.code;
  if (Array.isArray(input.commands)) return input.commands.map((cmd: any) => String(cmd?.command || "")).join("\n");
  return "";
}


function isGhPrMerge(command: string): boolean {
  return /(^|[;&|]\s*)gh\s+pr\s+merge\b/.test(command);
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
    const state = JSON.parse(readFileSync(pendingPath(repo), "utf8")) as { prNumber?: number; baseRefName?: string; head?: string; reviewBase?: string; lanes?: string[]; completed?: string[]; docPromptSent?: boolean; spawned?: boolean; spawnedIds?: Record<string, string>; fallbackLanes?: string[]; spawnedAt?: number };
    if (!state.head || !state.baseRefName || !Array.isArray(state.lanes)) return undefined;
    return { repo, prNumber: state.prNumber, baseRefName: state.baseRefName, head: state.head, reviewBase: state.reviewBase, lanes: state.lanes, completed: new Set(state.completed || []), docPromptSent: Boolean(state.docPromptSent), spawned: Boolean(state.spawned), spawnedIds: state.spawnedIds || {}, fallbackLanes: new Set(state.fallbackLanes || []), spawnedAt: state.spawnedAt };
  } catch {
    return undefined;
  }
}

function savePending(pending: PendingReview): void {
  writeFileSync(pendingPath(pending.repo), JSON.stringify({ prNumber: pending.prNumber, baseRefName: pending.baseRefName, head: pending.head, reviewBase: pending.reviewBase, lanes: pending.lanes, completed: [...pending.completed], docPromptSent: pending.docPromptSent, spawned: pending.spawned, spawnedIds: pending.spawnedIds, fallbackLanes: [...pending.fallbackLanes], spawnedAt: pending.spawnedAt }) + "\n", "utf8");
}

function isAncestor(repo: string, ancestor: string, current: string): boolean {
  if (!ancestor || !/^[0-9a-f]{7,40}$/.test(ancestor)) return false;
  try {
    return execFileSync("git", ["merge-base", ancestor, current], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() === ancestor;
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
  const base = previous?.head || lastAckHead(repo);
  const changed = classifyReviewFiles(changedFiles(repo, base, currentHead));
  const changedLanes = changed || ALL_REVIEW_LANES;
  if (!previous) return { lanes: changedLanes, completed: new Set() };

  const incompletePrevious = previous.lanes.filter((lane) => !previous.completed.has(lane));
  const lanes = [...new Set([...incompletePrevious, ...changedLanes])];
  const completed = new Set(
    previous.lanes.filter((lane) => previous.completed.has(lane) && lanes.includes(lane) && !changedLanes.includes(lane)),
  );
  return { lanes, completed };
}

function agentCall(type: string, prompt: string, description: string): string {
  return `Agent({ subagent_type: ${JSON.stringify(type)}, prompt: ${JSON.stringify(prompt)}, description: ${JSON.stringify(description)}, run_in_background: false })`;
}

function subagentsService(): any | undefined {
  return (globalThis as Record<symbol, unknown>)[Symbol.for("@gotgenes/pi-subagents:service")];
}

async function spawnLane(type: string, prompt: string, description: string, notify?: (message: string) => void): Promise<string | undefined> {
  const service = subagentsService();
  if (!service?.spawn) {
    notify?.(`Pi subagent service unavailable; falling back for ${type}.`);
    return undefined;
  }
  try {
    const id = service.spawn(type, prompt, { description, inheritContext: false });
    return typeof id === "string" ? id : undefined;
  } catch (error) {
    notify?.(`Failed to spawn ${type}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function spawnInitialLanes(pending: PendingReview, pr: PrState, notify?: (message: string) => void): Promise<boolean> {
  const base = reviewPrompt(pending.repo, pr, pending.head, pending.reviewBase);
  let spawned = false;
  if (pending.lanes.includes("code-reviewer")) {
    const id = await spawnLane("code-reviewer", base, "Review code changes", notify);
    if (id) { pending.spawnedIds["code-reviewer"] = id; spawned = true; }
  }
  if (pending.lanes.includes("spec-reviewer")) {
    const id = await spawnLane("spec-reviewer", base, "Review spec changes", notify);
    if (id) { pending.spawnedIds["spec-reviewer"] = id; spawned = true; }
  }
  if (pending.lanes.includes("doc-updater") && !pending.lanes.includes("spec-reviewer")) {
    const id = await spawnLane("doc-updater", docUpdaterPrompt(pending), "Review documentation changes", notify);
    if (id) { pending.spawnedIds["doc-updater"] = id; spawned = true; }
  }
  if (spawned) pending.spawnedAt = Date.now();
  return spawned;
}

function reviewPrompt(repo: string, pr: PrState, head: string, reviewBase?: string): string {
  if (reviewBase) {
    return `Work in ${repo}. Review PR #${pr.number || "?"} for ${basename(repo)}. Scope is ONLY the incremental diff from ${reviewBase} to ${head}. Run: git diff --name-only ${reviewBase} ${head} to see changed files, then git diff ${reviewBase} ${head} -- <path> for each. Do NOT review the full PR diff against ${pr.baseRefName}. Report findings only; do not modify files.`;
  }
  return `Work in ${repo}. Review PR #${pr.number || "?"} for ${basename(repo)} at head ${head}. Scope is the full PR diff (no prior review base). Run: git diff origin/${pr.baseRefName}...${head}. Report findings only; do not modify files.`;
}

function directiveFor(repo: string, pr: PrState, lanes: string[], reviewBase?: string): string {
  const laneText = lanes.join(", ");
  const head = pr.headRefOid!;
  const sequence = lanes.includes("spec-reviewer") && lanes.includes("doc-updater")
    ? `${lanes.filter((lane) => lane !== "doc-updater").join(" + ")} first; doc-updater after spec-reviewer completes`
    : laneText;
  const scope = reviewBase
    ? `Scope is ONLY the incremental diff: git diff ${reviewBase} ${head}. Do NOT review the full PR diff against ${pr.baseRefName}.`
    : `Scope is the full PR diff: git diff origin/${pr.baseRefName}...${head} (no prior review base).`;
  return `PR-boundary review required for ${basename(repo)} PR #${pr.number || "?"} at ${head.slice(0, 12)}. ${scope} Required lanes: ${laneText}. Run: ${sequence}. Acknowledgement is automatic after required lanes complete.`;
}

function docUpdaterPrompt(pending: PendingReview): string {
  if (pending.reviewBase) {
    return `Work in ${pending.repo}. Review PR #${pending.prNumber || "?"} for ${basename(pending.repo)}. Scope is ONLY the incremental diff from ${pending.reviewBase} to ${pending.head}. Run: git diff ${pending.reviewBase} ${pending.head} -- documentation/ sdd/. Do NOT review the full PR diff against ${pending.baseRefName}. Report findings only; do not modify files.`;
  }
  return `Work in ${pending.repo}. Review PR #${pending.prNumber || "?"} for ${basename(pending.repo)} at head ${pending.head}. Scope is the full PR diff (no prior review base). Run: git diff origin/${pending.baseRefName}...${pending.head}. Report findings only; do not modify files.`;
}

function isCurrentPending(pending: PendingReview): boolean {
  const current = prState(pending.repo);
  if (!isEnforcedPr(current)) return false;
  return isCurrentReviewHead(pending.head, current.headRefOid, localHead(pending.repo));
}

export default function (pi: ExtensionAPI) {
  let pending: PendingReview | undefined;
  const toolStartArgs = new Map<string, any>();

  function toolEventId(event: any): string | undefined {
    const id = event?.toolCallId || event?.toolUseId || event?.id;
    return typeof id === "string" ? id : undefined;
  }

  function withStartArgs(event: any): any {
    const id = toolEventId(event);
    const cached = id ? toolStartArgs.get(id) : undefined;
    if (id) toolStartArgs.delete(id);
    if (commandText(event) || !cached) return event;
    const current = event?.args || event?.input || event?.params || {};
    return { ...event, args: { ...cached, ...current } };
  }

  function hydratePending(ctx: any): PendingReview | undefined {
    if (pending) return pending;
    const repo = activeRepoFallback() || findGitRoot(ctx.sessionManager.getCwd());
    pending = repo ? loadPending(repo) : undefined;
    return pending;
  }

  async function markCompleted(type: string, ctx: any, completionId?: string, prompt?: string): Promise<void> {
    const state = hydratePending(ctx);
    if (!state || !state.lanes.includes(type)) return;
    if (!isReviewCompletionForLane({ ...state, fallbackLanes: [...state.fallbackLanes] }, type, completionId, prompt)) return;
    if (!isCurrentPending(state)) {
      clearPending(state.repo);
      pending = undefined;
      return;
    }
    state.completed.add(type);
    if (type === "spec-reviewer" && state.lanes.includes("doc-updater") && !state.docPromptSent) {
      state.docPromptSent = true;
      savePending(state);
      const docPrompt = docUpdaterPrompt(state);
      const spawnedId = await spawnLane("doc-updater", docPrompt, "Review documentation changes", (message) => ctx.ui.notify(message, "warning"));
      if (spawnedId) {
        state.spawnedIds["doc-updater"] = spawnedId;
        state.spawned = true;
        savePending(state);
      } else {
        state.fallbackLanes.add("doc-updater");
        savePending(state);
        pi.sendUserMessage(agentCall("doc-updater", docPrompt, "Review documentation changes"), { deliverAs: "followUp" });
      }
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
    const toolName = String(event?.toolName || "").toLowerCase();
    const input = event?.input || event?.params || event?.args || {};
    const command = commandText(event);
    const isShellSurface = toolName === "bash" || toolName.includes("ctx_execute") || toolName.includes("ctx_batch_execute");
    if (isShellSurface && isGhPrMerge(command)) {
      const repo = findGitRoot(cwdFromCommand(command) || ctx.sessionManager.getCwd()) || activeRepoFallback();
      if (!repo || !isSddProject(repo) || consumeBypass()) return;
      const pr = prState(repo);
      if (!isEnforcedPr(pr)) return;
      const head = pr.headRefOid;
      if (!acked(repo, head)) {
        return { block: true, reason: `PR-boundary review required before merge for ${basename(repo)} at ${head.slice(0, 12)}. Complete required reviewers or use the user-only ${REVIEW_BYPASS} bypass.` };
      }
      return;
    }

    if (toolName !== "agent") return;
    const type = String(input.subagent_type || input.subagentType || "");
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
  pi.on("tool_execution_start", (event: any, ctx: any) => {
    const id = toolEventId(event);
    if (id) toolStartArgs.set(id, event?.args || event?.input || event?.params || {});
    return onAgentStart(event, ctx);
  });

  const onToolEnd = async (event: any, ctx: any) => {
    const toolName = String(event?.toolName || "").toLowerCase();
    if (isFailedToolExecution(event)) return;

    if (toolName === "agent") {
      const input = event?.input || event?.params || event?.args || {};
      const type = String(input.subagent_type || input.subagentType || "");
      const prompt = String(input.prompt || "");
      const state = hydratePending(ctx);
      if (type && state?.fallbackLanes.has(type) && input.run_in_background !== true) {
        await markCompleted(type, ctx, undefined, prompt);
      }
      return;
    }

    const command = commandText(event);
    const isShellSurface = toolName === "bash" || toolName.includes("ctx_execute") || toolName.includes("ctx_batch_execute");
    if (!isShellSurface || !isPrBoundaryCommand(command)) return;

    const repo = findGitRoot(cwdFromCommand(command) || ctx.sessionManager.getCwd()) || activeRepoFallback();
    if (!repo || !isSddProject(repo) || consumeBypass()) return;

    const pr = prState(repo);
    if (!isEnforcedPr(pr)) return;
    const head = localHead(repo) || pr.headRefOid;
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

    const reviewBase = previous?.head || lastAckHead(repo) || undefined;
    const validBase = reviewBase && isAncestor(repo, reviewBase, head) ? reviewBase : undefined;
    resetBlockCount(repo);
    pending = { repo, prNumber: pr.number, baseRefName: pr.baseRefName, head, reviewBase: validBase, lanes: review.lanes, completed: review.completed, docPromptSent: false, spawned: false, spawnedIds: {}, fallbackLanes: new Set() };
    await spawnInitialLanes(pending, effectivePr, (message) => ctx.ui.notify(message, "warning"));
    const initialLanes = pending.lanes.filter((lane) => lane !== "doc-updater" || !pending.lanes.includes("spec-reviewer"));
    pending.spawned = initialLanes.length > 0 && initialLanes.every((lane) => Boolean(pending.spawnedIds[lane]));
    savePending(pending);
    ctx.ui.notify(`PR-boundary review required for ${basename(repo)} at ${head.slice(0, 12)}. Lanes: ${review.lanes.join(", ")}.`, "warning");
    if (!pending.spawned) {
      for (const lane of initialLanes) {
        if (!pending.spawnedIds[lane]) pending.fallbackLanes.add(lane);
      }
      savePending(pending);
      const fallbackLanes = initialLanes.filter((lane) => !pending.spawnedIds[lane]);
      pi.sendUserMessage(directiveFor(repo, effectivePr, fallbackLanes.length > 0 ? fallbackLanes : review.lanes, validBase), { deliverAs: "followUp" });
    }
  };

  pi.on("tool_result", onToolEnd);
  pi.on("tool_execution_end", (event: any, ctx: any) => onToolEnd(withStartArgs(event), ctx));

  const onSubagentCompleted = async (event: any, ctx: any) => {
    const type = String(event?.type || "");
    if (type) await markCompleted(type, ctx, typeof event?.id === "string" ? event.id : undefined);
  };

  pi.on("subagents:completed", onSubagentCompleted);
  (pi as any).events?.on?.("subagents:completed", (event: any) => onSubagentCompleted(event, { sessionManager: { getCwd: () => process.cwd() }, ui: { notify: () => undefined } }));

  const onSubagentFailed = async (event: any, ctx: any) => {
    const state = hydratePending(ctx);
    if (!state || !isCurrentPending(state)) return;
    const id = typeof event?.id === "string" ? event.id : undefined;
    const lane = Object.entries(state.spawnedIds).find(([, spawnedId]) => spawnedId === id)?.[0];
    if (!lane) return;
    delete state.spawnedIds[lane];
    state.fallbackLanes.add(lane);
    state.spawned = Object.keys(state.spawnedIds).length > 0;
    savePending(state);
    ctx.ui.notify(`PR-boundary ${lane} failed for ${basename(state.repo)} at ${state.head.slice(0, 12)}; review remains pending.`, "warning");
  };

  pi.on("subagents:failed", onSubagentFailed);
  (pi as any).events?.on?.("subagents:failed", (event: any) => onSubagentFailed(event, { sessionManager: { getCwd: () => process.cwd() }, ui: { notify: () => undefined } }));

  pi.on("agent_end", async (_event, ctx) => {
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

    const service = subagentsService();
    const currentState = loadPending(state.repo) || state;
    for (const [lane, spawnedId] of Object.entries(currentState.spawnedIds)) {
      const record = service?.getRecord?.(spawnedId);
      if (record?.status === "completed" || record?.status === "steered") {
        await markCompleted(lane, ctx, spawnedId);
        return;
      }
      if (["error", "stopped", "aborted"].includes(String(record?.status || ""))) {
        delete currentState.spawnedIds[lane];
        currentState.fallbackLanes.add(lane);
        currentState.spawned = Object.keys(currentState.spawnedIds).length > 0;
        savePending(currentState);
        ctx.ui.notify(`PR-boundary ${lane} ended with ${record.status} for ${basename(currentState.repo)} at ${currentState.head.slice(0, 12)}; review remains pending.`, "warning");
        return;
      }
      if (!record && !service?.hasRunning?.()) {
        delete currentState.spawnedIds[lane];
        currentState.spawned = Object.keys(currentState.spawnedIds).length > 0;
        savePending(currentState);
      }
    }

    const STALL_TIMEOUT_MS = 10 * 60 * 1000;
    const pendingAge = Date.now() - (currentState.spawnedAt ?? Date.now());
    if (service?.hasRunning?.() && pendingAge < STALL_TIMEOUT_MS) {
      return;
    }

    const eligibleUnstarted = currentState.lanes.filter((lane) => {
      if (currentState.completed.has(lane) || currentState.spawnedIds[lane]) return false;
      return !(lane === "doc-updater" && currentState.lanes.includes("spec-reviewer") && !currentState.completed.has("spec-reviewer"));
    });
    if (eligibleUnstarted.length > 0) {
      const pr = prState(currentState.repo);
      const basePrompt = pr ? reviewPrompt(currentState.repo, pr, currentState.head, currentState.reviewBase) : reviewPrompt(currentState.repo, { baseRefName: currentState.baseRefName, number: currentState.prNumber, headRefOid: currentState.head } as PrState, currentState.head, currentState.reviewBase);
      let respawned = false;
      for (const lane of eligibleUnstarted) {
        const prompt = lane === "doc-updater" ? docUpdaterPrompt(currentState) : basePrompt;
        const id = await spawnLane(lane, prompt, lane === "doc-updater" ? "Review documentation changes" : lane === "spec-reviewer" ? "Review spec changes" : "Review code changes", (message) => ctx.ui.notify(message, "warning"));
        if (id) {
          currentState.spawnedIds[lane] = id;
          currentState.fallbackLanes.delete(lane);
          respawned = true;
        } else {
          currentState.fallbackLanes.add(lane);
        }
      }
      currentState.spawned = Object.keys(currentState.spawnedIds).length > 0;
      savePending(currentState);
      if (respawned) return;
    }

    const count = incrementBlockCount(currentState.repo);
    if (count >= 3) {
      ctx.ui.notify(`Review enforcement circuit breaker opened after ${count} reminders for ${basename(currentState.repo)}.`, "warning");
      pending = undefined;
      return;
    }
    const remaining = currentState.lanes.filter((lane) => !currentState.completed.has(lane)).join(", ") || "none";
    const reminder = `PR-boundary review still pending for ${basename(currentState.repo)} at ${currentState.head.slice(0, 12)}. Remaining lanes: ${remaining}. Reminder ${count}/3.`;
    ctx.ui.notify(reminder, "warning");
    pi.sendUserMessage(`${reminder}\nComplete the remaining subagents or use the user-only bypass ${REVIEW_BYPASS}.`, { deliverAs: "followUp" });
  });
}
