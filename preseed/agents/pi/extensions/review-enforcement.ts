import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recallActiveRepo, rememberActiveRepoFromToolResult } from "./active-repo-memory";
import {
  classifyReviewBoundaryCommand,
  isReviewTransitionSuspended,
  parseControlDirectives,
  requiredReviewLanes,
  reviewRange,
  reviewTranscriptFacts,
  type ReviewBoundaryEvent,
  type ReviewLane,
} from "./review-helpers";
import { scopeContract } from "./review-scope";
import {
  renderReviewWidgetLines,
  type ReviewWidgetAgent,
  type ReviewWidgetTheme,
} from "./review-widget-renderer";

type PrState = {
  state: "OPEN" | "CLOSED" | "MERGED";
  baseRefName: "main" | "master";
  headRefOid: string;
  headRefName: string;
  number: number;
  isDraft?: boolean;
};

type ServiceSpawnOptions = {
  description?: string;
  model?: string;
  maxTurns?: number;
  thinkingLevel?: string;
  inheritContext?: boolean;
  foreground?: boolean;
  bypassQueue?: boolean;
};

type SubagentServiceRecord = {
  status: string;
  description: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  lifetimeUsage: { input: number; output: number; cacheWrite: number };
  compactionCount: number;
};

type SubagentsService = {
  spawn(type: string, prompt: string, options?: ServiceSpawnOptions): string;
  getRecord(id: string): SubagentServiceRecord | undefined;
};

type ReviewWidgetTui = {
  terminal: { columns: number };
  requestRender(): void;
};

type ReviewWidgetComponent = {
  render(width?: number): string[];
  invalidate(): void;
};

type ReviewUi = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: string[] | ((tui: ReviewWidgetTui, theme: ReviewWidgetTheme) => ReviewWidgetComponent) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

type CiMonitorRequest = {
  subagent_type: "ci-monitor";
  description: string;
  prompt: string;
  run_in_background: true;
  inherit_context: false;
  model?: string;
  thinking?: string;
  max_turns?: number;
};

type ResolveCiRequestInput = {
  event: "push" | "pr-create";
  repo: string;
  pr: number;
  reviewState: "launched" | "not-required";
};

type Dependencies = {
  queryPr(repo: string, target?: string): Promise<PrState | undefined>;
  queryHead?(repo: string): Promise<string | undefined>;
  fetchPrHead?(repo: string, pr: PrState): Promise<boolean>;
  sleep?(delayMs: number): Promise<void>;
  headRetryDelaysMs?: number[];
  getSubagentsService?(): SubagentsService | undefined;
  resolveCiRequest?(input: ResolveCiRequestInput): Promise<CiMonitorRequest | undefined>;
};

type ReviewContext = {
  cwd: string;
  ui: ReviewUi;
  sessionManager: {
    getSessionFile(): string | undefined;
    getHeader?(): { parentSession?: string } | undefined;
  };
};

type ReviewPi = {
  on(event: "input" | "tool_result" | "agent_settled" | "turn_start" | "session_start" | "session_shutdown", handler: (event: any, ctx: ReviewContext) => void | Promise<void>): void;
  appendEntry(customType: string, data: unknown): void;
  exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string; code: number }>;
  sendMessage(
    message: { customType: string; content?: string; details?: Record<string, unknown>; display?: boolean },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  events: {
    on(channel: string, handler: (data: unknown) => void): () => void;
  };
};

type QueryPrRunner = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: "utf8"; timeout: number },
) => Promise<{ stdout: string | Buffer }>;

const execFileAsync = promisify(execFile) as unknown as QueryPrRunner;
const MAX_BLOCKS = 5;
const BYPASS_FILE = process.env.REVIEW_BYPASS_FILE || "/tmp/review-bypass";
const CI_RESOLVER = join(process.env.HOME || "/home/user", ".pi", "agent", "skills", "ci-monitoring", "scripts", "monitor-ci.mjs");
const SUBAGENTS_SERVICE = Symbol.for("@gotgenes/pi-subagents:service");
const REVIEW_VISUAL_KEY = "codeflare-review-agents";
const REVIEW_VISUAL_EVENTS = [
  "subagents:created",
  "subagents:started",
  "subagents:completed",
  "subagents:failed",
] as const;

function fullSha(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{40}$/.test(value));
}

function isProtectedPr(pr: PrState | undefined): pr is PrState {
  return Boolean(
    pr
    && ["OPEN", "CLOSED", "MERGED"].includes(pr.state)
    && (pr.baseRefName === "main" || pr.baseRefName === "master")
    && fullSha(pr.headRefOid),
  );
}

function isEnforcedPr(pr: PrState | undefined): pr is PrState {
  return isProtectedPr(pr) && pr.state === "OPEN";
}

function isSddRepo(repo: string): boolean {
  return existsSync(join(repo, "sdd", "README.md"));
}

function sessionFile(ctx: ReviewContext): string | undefined {
  const file = ctx.sessionManager.getSessionFile();
  return typeof file === "string" && file ? file : undefined;
}

function isChildSession(ctx: ReviewContext, file: string | undefined): boolean {
  const liveHeader = ctx.sessionManager.getHeader?.();
  if (liveHeader) return typeof liveHeader.parentSession === "string" && liveHeader.parentSession.length > 0;
  if (!file) return true;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const buffer = Buffer.alloc(16_384);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytes).toString("utf8").split("\n", 1)[0];
    const header = JSON.parse(firstLine);
    return header?.type !== "session" || (typeof header.parentSession === "string" && header.parentSession.length > 0);
  } catch {
    return true;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ackPath(repo: string): string {
  return join(repo, ".git", "sdd-last-ack-pr-head");
}

function countPath(repo: string): string {
  return join(repo, ".git", "sdd-review-block-count");
}

function readAck(repo: string): string | undefined {
  try {
    const value = readFileSync(ackPath(repo), "utf8").trim();
    return fullSha(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function clearAck(repo: string): void {
  try {
    unlinkSync(ackPath(repo));
  } catch {
    // Missing acknowledgement is the normal unreviewed state.
  }
}

function clearCount(repo: string): void {
  try {
    unlinkSync(countPath(repo));
  } catch {
    // No counter is the normal state.
  }
}

function acknowledge(repo: string, head: string): void {
  if (!fullSha(head)) return;
  writeFileSync(ackPath(repo), `${head}\n`, "utf8");
  clearCount(repo);
}

function blockDecision(repo: string, head: string): "block" | "giveup" {
  let count = 0;
  try {
    const [storedHead, storedCount] = readFileSync(countPath(repo), "utf8").trim().split(":", 2);
    if (storedHead === head) {
      if (storedCount === "GIVEUP") return "giveup";
      count = Number.parseInt(storedCount, 10) || 0;
    }
  } catch {
    // Start a fresh counter for this head.
  }
  if (count >= MAX_BLOCKS) {
    writeFileSync(countPath(repo), `${head}:GIVEUP\n`, "utf8");
    return "giveup";
  }
  writeFileSync(countPath(repo), `${head}:${count + 1}\n`, "utf8");
  return "block";
}

function shellCommands(event: any): string[] {
  const input = event?.input;
  const name = String(event?.toolName ?? "");
  if (!input || typeof input !== "object") return [];
  if ((name === "bash" || name === "Bash") && typeof input.command === "string") return [input.command];
  if (name.endsWith("ctx_execute") && input.language === "shell" && typeof input.code === "string") return [input.code];
  if (name.endsWith("ctx_batch_execute") && Array.isArray(input.commands)) {
    return input.commands
      .map((item: Record<string, unknown>) => item?.command)
      .filter((command: unknown): command is string => typeof command === "string");
  }
  return [];
}

function successful(event: any): boolean {
  return event?.isError !== true && event?.result?.isError !== true;
}

function bypassSentinelPresent(): boolean {
  return existsSync(BYPASS_FILE);
}

function consumeBypassSentinel(): boolean {
  if (!bypassSentinelPresent()) return false;
  try {
    unlinkSync(BYPASS_FILE);
    return true;
  } catch {
    return false;
  }
}

function boundaryContext(ctx: ReviewContext, commandRepoPath?: string): { repo: string; file: string } | undefined {
  const commandRepo = commandRepoPath ? resolve(ctx.cwd, commandRepoPath) : undefined;
  if (commandRepo && !existsSync(join(commandRepo, ".git"))) return undefined;
  const repo = commandRepo
    ?? (existsSync(join(ctx.cwd, ".git")) ? ctx.cwd : (recallActiveRepo() ?? ctx.cwd));
  const file = sessionFile(ctx);
  if (!file || isChildSession(ctx, file)) return undefined;
  return { repo, file };
}

function reviewEnabled(repo: string): boolean {
  return process.env.SESSION_MODE !== "default"
    && isSddRepo(repo)
    && !isReviewTransitionSuspended(repo);
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function fetchPrHead(
  repo: string,
  pr: PrState,
  runner: QueryPrRunner = execFileAsync,
): Promise<boolean> {
  try {
    await runner(
      "git",
      ["fetch", "--no-tags", "--quiet", "origin", `refs/pull/${pr.number}/head`],
      { cwd: repo, encoding: "utf8", timeout: 15_000 },
    );
    const result = await runner(
      "git",
      ["rev-parse", "FETCH_HEAD"],
      { cwd: repo, encoding: "utf8", timeout: 5_000 },
    );
    return String(result.stdout).trim() === pr.headRefOid;
  } catch {
    return false;
  }
}

async function currentReview(
  ctx: ReviewContext,
  dependencies: Dependencies,
  target: string | undefined,
  remoteHeadAuthoritative = false,
  commandRepoPath?: string,
): Promise<{ repo: string; file: string; pr: PrState } | undefined> {
  const context = boundaryContext(ctx, commandRepoPath);
  if (!context) return undefined;
  const head = await (dependencies.queryHead ?? queryHead)(context.repo);
  if (!head) return undefined;
  const delays = dependencies.headRetryDelaysMs ?? [0, 250, 1_000];
  const sleep = dependencies.sleep ?? defaultSleep;
  for (const delayMs of delays) {
    if (delayMs > 0) await sleep(delayMs);
    const pr = await dependencies.queryPr(context.repo, target);
    if (!isProtectedPr(pr)) continue;
    if (head === pr.headRefOid) return { ...context, pr };
    if (remoteHeadAuthoritative && await (dependencies.fetchPrHead ?? fetchPrHead)(context.repo, pr)) {
      return { ...context, pr };
    }
  }
  return undefined;
}

type CiBoundaryEvent = "push" | "pr-create";

type LaunchMessage = {
  phase: "plan" | "follow-up";
  repo: string;
  pr: PrState;
  ackHead?: string;
  range?: string;
  reviewers: ReviewLane[];
  reviewState: "launched" | "not-required";
  autonomyOverride: boolean;
  ciEvent?: CiBoundaryEvent;
};

function ciBoundaryEvent(event: ReviewBoundaryEvent | undefined): CiBoundaryEvent | undefined {
  if (event === "pr-update-branch") return "push";
  return event === "push" || event === "pr-create" ? event : undefined;
}

function scopeInstruction(pr: PrState, range: string | undefined): string {
  return range
    ? `scope=diff\nreview_range=${range}`
    : `scope=diff\nreview_base=origin/${pr.baseRefName}`;
}

function subagentsService(dependencies: Dependencies): SubagentsService | undefined {
  const published = (globalThis as Record<symbol, unknown>)[SUBAGENTS_SERVICE];
  return dependencies.getSubagentsService?.() ?? (published as SubagentsService | undefined);
}

function serviceDispatchFailed(service: SubagentsService | undefined, agentId: string | undefined): boolean {
  if (!service || !agentId) return false;
  const status = service.getRecord(agentId)?.status;
  return status === "stopped" || status === "aborted" || status === "error";
}

type ReviewVisualAgent = {
  agentId: string;
  kind: "reviewer" | "ci";
  lane?: ReviewLane;
};

type ReviewVisualController = {
  attach(ui: ReviewUi): void;
  begin(head: string, service: SubagentsService): void;
  restore(head: string, service: SubagentsService, agents: readonly ReviewVisualAgent[]): void;
  track(agent: ReviewVisualAgent): void;
  refresh(): void;
  clearFinished(): void;
  dispose(): void;
};

const REVIEW_VISUAL_LANES: readonly ReviewLane[] = ["code-reviewer", "spec-reviewer", "doc-updater"];
const REVIEW_VISUAL_LABELS: Record<ReviewLane | "ci", string> = {
  "code-reviewer": "Code review",
  "spec-reviewer": "Specification review",
  "doc-updater": "Documentation review",
  ci: "CI monitoring",
};
const REVIEW_REFRESH_INTERVAL_MS = 80;

function createReviewVisualController(): ReviewVisualController {
  let ui: ReviewUi | undefined;
  let service: SubagentsService | undefined;
  let head: string | undefined;
  let tracked: readonly ReviewVisualAgent[] = [];
  let frame = 0;
  let interval: ReturnType<typeof setInterval> | undefined;
  let widgetRegistered = false;
  let tui: ReviewWidgetTui | undefined;
  let lastStatusText: string | undefined;

  const records = (): Array<{ agent: ReviewVisualAgent; record: SubagentServiceRecord }> =>
    tracked.flatMap((agent) => {
      const record = service?.getRecord(agent.agentId);
      return record ? [{ agent, record }] : [];
    });

  const widgetAgents = (): ReviewWidgetAgent[] => records().map(({ agent, record }) => ({
    id: agent.agentId,
    label: REVIEW_VISUAL_LABELS[agent.kind === "ci" ? "ci" : agent.lane!],
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    error: record.error,
    lifetimeUsage: record.lifetimeUsage,
    compactionCount: record.compactionCount,
  }));

  const stopInterval = (): void => {
    if (!interval) return;
    clearInterval(interval);
    interval = undefined;
  };

  const clearPresentation = (): void => {
    stopInterval();
    if (widgetRegistered) ui?.setWidget(REVIEW_VISUAL_KEY, undefined);
    if (lastStatusText !== undefined) ui?.setStatus(REVIEW_VISUAL_KEY, undefined);
    widgetRegistered = false;
    tui = undefined;
    lastStatusText = undefined;
  };

  const updateStatus = (current: ReturnType<typeof records>): void => {
    if (!ui) return;
    const running = current.filter(({ record }) => record.status === "running").length;
    const queued = current.filter(({ record }) => record.status === "queued").length;
    const parts = [
      ...(running > 0 ? [`${running} running`] : []),
      ...(queued > 0 ? [`${queued} queued`] : []),
    ];
    const next = parts.length > 0 ? `Review: ${parts.join(", ")}` : undefined;
    if (next === lastStatusText) return;
    ui.setStatus(REVIEW_VISUAL_KEY, next);
    lastStatusText = next;
  };

  const refresh = (): void => {
    if (!ui || !head || tracked.length === 0) return;
    const current = records();
    if (current.length === 0) {
      clearPresentation();
      return;
    }
    const active = current.some(({ record }) => record.status === "queued" || record.status === "running");
    updateStatus(current);
    if (!active) stopInterval();
    else if (!interval) {
      interval = setInterval(() => {
        frame += 1;
        tui?.requestRender();
      }, REVIEW_REFRESH_INTERVAL_MS);
    }

    if (!widgetRegistered) {
      ui.setWidget(REVIEW_VISUAL_KEY, (nextTui, theme) => {
        tui = nextTui;
        return {
          render: (width) => renderReviewWidgetLines({
            agents: widgetAgents(),
            spinnerFrame: frame,
            terminalWidth: Math.min(width ?? nextTui.terminal.columns, nextTui.terminal.columns),
            theme,
          }),
          invalidate: () => undefined,
        };
      }, { placement: "aboveEditor" });
      widgetRegistered = true;
    } else {
      tui?.requestRender();
    }
  };

  const resetForHead = (nextHead: string, nextService: SubagentsService): void => {
    if (head !== nextHead) {
      clearPresentation();
      tracked = [];
      frame = 0;
    }
    head = nextHead;
    service = nextService;
  };

  return {
    attach(nextUi) {
      if (ui !== nextUi) {
        clearPresentation();
        ui = nextUi;
      }
      refresh();
    },
    begin(nextHead, nextService) {
      resetForHead(nextHead, nextService);
      refresh();
    },
    restore(nextHead, nextService, agents) {
      resetForHead(nextHead, nextService);
      tracked = agents.filter((agent) => nextService.getRecord(agent.agentId));
      refresh();
    },
    track(agent) {
      const key = agent.kind === "ci" ? "ci" : agent.lane;
      tracked = [
        ...tracked.filter((candidate) => (candidate.kind === "ci" ? "ci" : candidate.lane) !== key),
        agent,
      ];
      refresh();
    },
    refresh,
    clearFinished() {
      const current = records();
      if (current.length === 0 || current.some(({ record }) => record.status === "queued" || record.status === "running")) return;
      clearPresentation();
      tracked = [];
      head = undefined;
      service = undefined;
    },
    dispose() {
      clearPresentation();
      tracked = [];
      head = undefined;
      service = undefined;
    },
  };
}

type ReviewTriageController = {
  begin(head: string, service: SubagentsService): void;
  restore(head: string, service: SubagentsService, agents: readonly ReviewVisualAgent[]): void;
  track(agent: ReviewVisualAgent): void;
  complete(data: unknown): void;
  dispose(): void;
};

const TRIAGE_TABLE_COLUMNS = ["FINDING", "PROPOSED FIX", "STATUS", "DECISION"] as const;

function reviewTriageReminder(head: string, lane: ReviewLane, allRequiredReviewersCompleted: boolean): string {
  return [
    `REVIEW TRIAGE REQUIRED — ${lane} completed for ${head}.`,
    "Preserve this result. Do not mutate the project until every required reviewer for this exact head is terminal. Then publish one consolidated adversarial triage before any project mutation.",
    "Critically challenge every finding against its evidence, review scope, current implementation, specifications, documentation, architecture decisions, project intent, and direct current-session instructions. Do not accept reviewer claims at face value.",
    "Output exactly one row per finding, with none omitted:",
    "| FINDING (as output by reviewer) | PROPOSED FIX (by reviewer) | STATUS | DECISION |",
    "|---|---|---|---|",
    "Use STATUS values ACCEPTED, REJECTED, DUPLICATE, SUPERSEDED, ACCEPTED — PROPOSAL REJECTED, or ACCEPTED — PROPOSAL OVERENGINEERED. In DECISION, state the final smallest correct fix and rationale; explain every rejection, duplication, supersession, wrong proposal, or overengineered proposal. Reuse existing machinery, or design a minimal replacement when the reviewer proposal is unsuitable.",
    "After publishing the table, automatically implement every legitimate minimal fix and continue the review/fix cycle. Do not request confirmation unless the user explicitly required review or approval before fixes. The root agent alone owns project mutations.",
    ...(allRequiredReviewersCompleted
      ? ["ALL REQUIRED REVIEWERS ARE TERMINAL. Publish the consolidated triage now, then automatically implement the accepted fixes."]
      : []),
  ].join("\n\n");
}

function createReviewTriageController(pi: ReviewPi): ReviewTriageController {
  let head: string | undefined;
  let service: SubagentsService | undefined;
  let reviewers: readonly ReviewVisualAgent[] = [];
  let emitted = new Set<string>();

  const reset = (nextHead: string, nextService: SubagentsService): void => {
    if (head !== nextHead) {
      reviewers = [];
      emitted = new Set<string>();
    }
    head = nextHead;
    service = nextService;
  };

  return {
    begin(nextHead, nextService) {
      reset(nextHead, nextService);
    },
    restore(nextHead, nextService, agents) {
      reset(nextHead, nextService);
      reviewers = agents.filter((agent) => agent.kind === "reviewer" && nextService.getRecord(agent.agentId));
    },
    track(agent) {
      if (agent.kind !== "reviewer") return;
      reviewers = [
        ...reviewers.filter((candidate) => candidate.kind !== "reviewer" || candidate.lane !== agent.lane),
        agent,
      ];
    },
    complete(data) {
      const agentId = typeof (data as { id?: unknown } | undefined)?.id === "string"
        ? (data as { id: string }).id
        : undefined;
      const reviewer = agentId ? reviewers.find((candidate) => candidate.agentId === agentId) : undefined;
      if (!head || !service || !agentId || reviewer?.kind !== "reviewer" || !reviewer.lane || emitted.has(agentId)) return;
      emitted = new Set([...emitted, agentId]);
      const allRequiredReviewersCompleted = reviewers.length > 0
        && reviewers.every((candidate) => service?.getRecord(candidate.agentId)?.status === "completed");
      const reminderHead = head;
      const lane = reviewer.lane;
      queueMicrotask(() => pi.sendMessage({
        customType: "codeflare:review-triage-reminder",
        content: reviewTriageReminder(reminderHead, lane, allRequiredReviewersCompleted),
        display: true,
        details: {
          agentId,
          head: reminderHead,
          lane,
          allRequiredReviewersCompleted,
          automaticFixes: true,
          confirmationRequired: false,
          tableColumns: [...TRIAGE_TABLE_COLUMNS],
        },
      }, { deliverAs: "followUp", triggerTurn: false }));
    },
    dispose() {
      head = undefined;
      service = undefined;
      reviewers = [];
      emitted = new Set<string>();
    },
  };
}

function restoreReviewControllersFromSession(
  visual: ReviewVisualController,
  triage: ReviewTriageController,
  ctx: ReviewContext,
  dependencies: Dependencies,
): void {
  const context = boundaryContext(ctx);
  const service = subagentsService(dependencies);
  if (!context || !service) return;
  const preview = reviewTranscriptFacts({ sessionFile: context.file, requiredLanes: REVIEW_VISUAL_LANES });
  if (!preview.boundary || !fullSha(preview.reviewHead)) return;
  const facts = reviewTranscriptFacts({
    sessionFile: context.file,
    requiredLanes: REVIEW_VISUAL_LANES,
    ciHead: preview.reviewHead,
  });
  const agents: ReviewVisualAgent[] = [
    ...REVIEW_VISUAL_LANES.flatMap((lane) => {
      const agentId = facts.lanes[lane].agentId;
      return agentId ? [{ agentId, kind: "reviewer" as const, lane }] : [];
    }),
    ...(facts.ciAgentId ? [{ agentId: facts.ciAgentId, kind: "ci" as const }] : []),
  ];
  visual.restore(preview.reviewHead, service, agents);
  triage.restore(preview.reviewHead, service, agents);
}

function reviewerPrompt(input: LaunchMessage, lane: ReviewLane): string {
  const autonomy = input.autonomyOverride ? "\nautonomy_override=fully-autonomous" : "";
  return [
    `Review lane: ${lane}. Report findings only; do not modify files or Git state.`,
    `repo=${input.repo}`,
    `head=${input.pr.headRefOid}`,
    scopeInstruction(input.pr, input.range),
    autonomy,
  ].filter(Boolean).join("\n");
}

function spawnOptions(request: Pick<CiMonitorRequest, "description" | "model" | "thinking" | "max_turns">): ServiceSpawnOptions {
  return {
    description: request.description,
    inheritContext: false,
    foreground: false,
    bypassQueue: true,
    ...(request.model ? { model: request.model } : {}),
    ...(request.thinking ? { thinkingLevel: request.thinking } : {}),
    ...(request.max_turns ? { maxTurns: request.max_turns } : {}),
  };
}

function validCiRequest(value: unknown): value is CiMonitorRequest {
  const request = value as Partial<CiMonitorRequest> | undefined;
  return Boolean(request
    && request.subagent_type === "ci-monitor"
    && typeof request.description === "string"
    && typeof request.prompt === "string"
    && request.run_in_background === true
    && request.inherit_context === false);
}

async function defaultResolveCiRequest(pi: ReviewPi, input: ResolveCiRequestInput): Promise<CiMonitorRequest | undefined> {
  try {
    const repository = await pi.exec("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
      cwd: input.repo,
      timeout: 10_000,
    });
    const nameWithOwner = repository.stdout.trim();
    if (repository.code !== 0 || !/^[^/\s]+\/[^/\s]+$/.test(nameWithOwner)) return undefined;
    const result = await pi.exec(process.execPath, [
      CI_RESOLVER,
      "request",
      `event=${input.event}`,
      "changed=true",
      `repo=${nameWithOwner}`,
      `pr=${input.pr}`,
      `cwd=${input.repo}`,
      `reviewState=${input.reviewState}`,
    ], { cwd: input.repo, timeout: 20_000 });
    if (result.code !== 0 || !result.stdout.trim()) return undefined;
    const request = JSON.parse(result.stdout.trim());
    return validCiRequest(request) ? request : undefined;
  } catch {
    return undefined;
  }
}

function appendDispatch(pi: ReviewPi, input: LaunchMessage, data: {
  agentId: string;
  kind: "reviewer" | "ci";
  lane?: ReviewLane;
}): void {
  pi.appendEntry("codeflare:subagent-dispatch", {
    version: 1,
    ...data,
    head: input.pr.headRefOid,
    ...(input.range ? { range: input.range } : {}),
  });
}

async function dispatchReviewWindow(
  pi: ReviewPi,
  dependencies: Dependencies,
  input: LaunchMessage,
  dispatch = true,
  visual?: ReviewVisualController,
  triage?: ReviewTriageController,
): Promise<void> {
  pi.appendEntry("codeflare:review-window", {
    version: 1,
    phase: input.phase,
    head: input.pr.headRefOid,
    ...(input.ackHead ? { ackHead: input.ackHead } : {}),
    ...(input.range ? { reviewRange: input.range } : {}),
    ...(input.phase === "plan" ? { scope: scopeContract("diff"), requiredLanes: input.reviewers } : { missingLanes: input.reviewers }),
    launchWaves: [input.reviewers, ...(input.ciEvent ? [["ci-monitor"]] : [])],
    ...(input.ciEvent ? { ciEvent: input.ciEvent } : {}),
  });

  if (!dispatch) return;
  const service = subagentsService(dependencies);
  if (!service) return;
  visual?.begin(input.pr.headRefOid, service);
  triage?.begin(input.pr.headRefOid, service);
  let reviewerSpawnFailed = false;
  for (const lane of input.reviewers) {
    const prompt = reviewerPrompt(input, lane);
    try {
      const agentId = service.spawn(lane, prompt, {
        description: `${lane} ${input.pr.headRefOid.slice(0, 8)}`,
        inheritContext: false,
        foreground: false,
      });
      if (!agentId) throw new Error("Subagent service returned no reviewer ID");
      appendDispatch(pi, input, { agentId, kind: "reviewer", lane });
      visual?.track({ agentId, kind: "reviewer", lane });
      triage?.track({ agentId, kind: "reviewer", lane });
    } catch {
      reviewerSpawnFailed = true;
    }
  }

  if (reviewerSpawnFailed || !input.ciEvent) return;
  const request = await (dependencies.resolveCiRequest
    ?? ((ciInput: ResolveCiRequestInput) => defaultResolveCiRequest(pi, ciInput)))({
    event: input.ciEvent,
    repo: input.repo,
    pr: input.pr.number,
    reviewState: input.reviewState,
  });
  if (!request) {
    pi.appendEntry("codeflare:ci-resolution", { version: 1, head: input.pr.headRefOid, outcome: "not-requested" });
    return;
  }
  try {
    const agentId = service.spawn(request.subagent_type, request.prompt, spawnOptions(request));
    if (!agentId) throw new Error("Subagent service returned no CI ID");
    appendDispatch(pi, input, { agentId, kind: "ci" });
    visual?.track({ agentId, kind: "ci" });
  } catch {
    // Leave CI undispatched so the next settled pass can retry it.
  }
}

export function registerReviewEnforcement(pi: ReviewPi, dependencies: Dependencies): void {
  const visual = createReviewVisualController();
  const triage = createReviewTriageController(pi);
  pi.on("input", (event) => {
    const directUserInput = event.source === "interactive" || event.source === "rpc";
    const initiatingPrompt = event.streamingBehavior === undefined;
    if (directUserInput && initiatingPrompt && parseControlDirectives(event.text).includes("skip-review")) {
      writeFileSync(BYPASS_FILE, "", "utf8");
    }
  });
  const removeVisualListeners = REVIEW_VISUAL_EVENTS.map((channel) =>
    pi.events.on(channel, (data) => {
      visual.refresh();
      if (channel === "subagents:completed") triage.complete(data);
    }));
  const attachAndRestoreVisual = (ctx: ReviewContext): void => {
    visual.attach(ctx.ui);
    restoreReviewControllersFromSession(visual, triage, ctx, dependencies);
  };
  pi.on("session_start", (_event, ctx) => attachAndRestoreVisual(ctx));
  pi.on("turn_start", (_event, ctx) => {
    attachAndRestoreVisual(ctx);
    visual.clearFinished();
  });
  pi.on("session_shutdown", () => {
    for (const remove of removeVisualListeners) remove();
    visual.dispose();
    triage.dispose();
  });

  pi.on("tool_result", async (event, ctx) => {
    visual.attach(ctx.ui);
    if (!successful(event)) return;
    rememberActiveRepoFromToolResult(event, ctx.cwd);
    const boundary = shellCommands(event)
      .map((command) => ({ command, classification: classifyReviewBoundaryCommand(command) }))
      .find(({ classification }) => classification.reminder);
    if (!boundary) return;
    const target = boundary.classification.prTarget;
    const review = await currentReview(
      ctx,
      dependencies,
      target,
      boundary.classification.remoteHeadAuthoritative === true,
      boundary.classification.repoPath,
    );
    if (!review || !isEnforcedPr(review.pr)) return;

    const skipReview = bypassSentinelPresent();
    if (skipReview && !boundary.classification.settled) consumeBypassSentinel();
    if (boundary.classification.protectedRetarget) clearAck(review.repo);
    const ackHead = readAck(review.repo);
    const range = reviewRange({ repo: review.repo, ackHead, head: review.pr.headRefOid });
    const requiredLanes = reviewEnabled(review.repo) && !skipReview && ackHead !== review.pr.headRefOid
      ? requiredReviewLanes({ repo: review.repo, ackHead, head: review.pr.headRefOid })
      : [];
    const ciEvent = ciBoundaryEvent(boundary.classification.event);
    if (requiredLanes.length === 0 && !ciEvent) return;

    await dispatchReviewWindow(pi, dependencies, {
      phase: "plan",
      repo: review.repo,
      pr: review.pr,
      ackHead,
      range,
      reviewers: requiredLanes,
      reviewState: requiredLanes.length > 0 ? "launched" : "not-required",
      autonomyOverride: false,
      ciEvent,
    }, false);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    visual.attach(ctx.ui);
    const context = boundaryContext(ctx);
    if (!context) return;
    const preview = reviewTranscriptFacts({ sessionFile: context.file, requiredLanes: [] });
    if (!preview.boundary) return;

    const boundaryClassification = classifyReviewBoundaryCommand(preview.boundary.command);
    const targetedContext = boundaryContext(ctx, boundaryClassification.repoPath);
    if (!targetedContext) return;
    const target = boundaryClassification.prTarget;
    const reviewedPr = await dependencies.queryPr(targetedContext.repo, target);
    const reviewedHead = preview.reviewHead;
    const reviewedAck = readAck(targetedContext.repo);
    if (isEnforcedPr(reviewedPr)
      && reviewEnabled(targetedContext.repo)
      && !preview.bypassed
      && !bypassSentinelPresent()
      && fullSha(reviewedHead)
      && reviewedHead === reviewedPr.headRefOid
      && reviewedAck !== reviewedHead) {
      const reviewedRange = reviewRange({ repo: targetedContext.repo, ackHead: reviewedAck, head: reviewedHead });
      const reviewedLanes = requiredReviewLanes({ repo: targetedContext.repo, ackHead: reviewedAck, head: reviewedHead });
      const reviewedFacts = reviewTranscriptFacts({
        sessionFile: targetedContext.file,
        requiredLanes: reviewedLanes,
        ciHead: reviewedHead,
      });
      const allReviewedLanesTerminal = reviewedLanes.length > 0
        && reviewedLanes.every((lane) => reviewedFacts.lanes[lane].state === "terminal");
      if (reviewedFacts.reviewHead === reviewedHead
        && reviewedFacts.reviewRange === reviewedRange
        && allReviewedLanesTerminal) {
        acknowledge(targetedContext.repo, reviewedHead);
      }
    }

    const review = await currentReview(
      ctx,
      dependencies,
      target,
      boundaryClassification.remoteHeadAuthoritative === true,
      boundaryClassification.repoPath,
    );
    if (!review) return;
    const ackHead = readAck(review.repo);
    const range = reviewRange({ repo: review.repo, ackHead, head: review.pr.headRefOid });
    const bypassed = preview.bypassed || consumeBypassSentinel();
    const shouldReview = isEnforcedPr(review.pr)
      && reviewEnabled(review.repo)
      && !bypassed
      && ackHead !== review.pr.headRefOid;
    const requiredLanes = shouldReview
      ? requiredReviewLanes({ repo: review.repo, ackHead, head: review.pr.headRefOid })
      : [];
    const facts = reviewTranscriptFacts({
      sessionFile: review.file,
      requiredLanes,
      ciHead: review.pr.headRefOid,
    });
    if (!facts.boundary) return;
    if (review.pr.state !== "OPEN") {
      if (reviewEnabled(review.repo) && !facts.closedNotified && classifyReviewBoundaryCommand(facts.boundary.command).settled) {
        pi.sendMessage({
          customType: "pr-boundary-review-closed-unacknowledged",
          content: `PR head ${review.pr.headRefOid} is ${review.pr.state} without review acknowledgement. No acknowledgement was written.`,
          display: true,
          details: { head: review.pr.headRefOid, state: review.pr.state },
        }, { triggerTurn: false });
      }
      return;
    }

    const service = subagentsService(dependencies);
    const ciEvent = facts.ciLaunched && !serviceDispatchFailed(service, facts.ciAgentId)
      ? undefined
      : ciBoundaryEvent(classifyReviewBoundaryCommand(facts.boundary.command).event);
    if (shouldReview && requiredLanes.length === 0) acknowledge(review.repo, review.pr.headRefOid);

    if (shouldReview && requiredLanes.length > 0
      && (facts.reviewHead !== review.pr.headRefOid || facts.reviewRange !== range)) {
      await dispatchReviewWindow(pi, dependencies, {
        phase: "plan",
        repo: review.repo,
        pr: review.pr,
        ackHead,
        range,
        reviewers: requiredLanes,
        reviewState: requiredLanes.length > 0 ? "launched" : "not-required",
        autonomyOverride: facts.fullyAutonomous,
        ciEvent,
      }, true, visual, triage);
      return;
    }

    const allReviewersTerminal = requiredLanes.length > 0
      && requiredLanes.every((lane) => facts.lanes[lane].state === "terminal");
    if (allReviewersTerminal) acknowledge(review.repo, review.pr.headRefOid);

    const missingLanes = allReviewersTerminal || !shouldReview
      ? []
      : requiredLanes.filter((lane): lane is ReviewLane => {
        const fact = facts.lanes[lane];
        return fact.state === "missing"
          || (fact.state === "in-flight" && serviceDispatchFailed(service, fact.agentId));
      });
    if (missingLanes.length === 0 && !ciEvent) return;
    if (missingLanes.length > 0 && blockDecision(review.repo, review.pr.headRefOid) === "giveup") return;

    await dispatchReviewWindow(pi, dependencies, {
      phase: "follow-up",
      repo: review.repo,
      pr: review.pr,
      ackHead,
      range,
      reviewers: missingLanes,
      reviewState: requiredLanes.length > 0 ? "launched" : "not-required",
      autonomyOverride: facts.fullyAutonomous,
      ciEvent,
    }, true, visual, triage);
  });
}

export async function queryHead(repo: string, runner: QueryPrRunner = execFileAsync): Promise<string | undefined> {
  try {
    const { stdout } = await runner(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: repo, encoding: "utf8", timeout: 10_000 },
    );
    const value = String(stdout).trim();
    return fullSha(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function queryPr(
  repo: string,
  runner: QueryPrRunner = execFileAsync,
  target?: string,
): Promise<PrState | undefined> {
  try {
    const args = ["pr", "view", ...(target ? [target] : []), "--json", "state,baseRefName,headRefOid,headRefName,number,isDraft"];
    const { stdout } = await runner(
      "gh",
      args,
      { cwd: repo, encoding: "utf8", timeout: 10_000 },
    );
    const value = JSON.parse(String(stdout)) as PrState;
    return isProtectedPr(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export default function reviewEnforcement(pi: ExtensionAPI): void {
  registerReviewEnforcement(pi as unknown as ReviewPi, {
    queryPr: (repo, target) => queryPr(repo, execFileAsync, target),
  });
}
