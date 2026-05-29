export const ALL_REVIEW_LANES = ["code-reviewer", "spec-reviewer", "doc-updater"];

export function isPrBoundaryCommand(command: string): boolean {
  return /(^|[;&|]\s*)git\s+push\b/.test(command) || /(^|[;&|]\s*)gh\s+pr\s+(create|merge)\b/.test(command);
}

export function isFailedToolExecution(event: any): boolean {
  return event?.isError === true || event?.error === true || String(event?.status ?? "").toLowerCase() === "error";
}

export function isCurrentReviewHead(pendingHead: string, prHead: string | undefined, localHead: string | undefined): boolean {
  return prHead === pendingHead || localHead === pendingHead;
}

export type ReviewHeadStatus = "current" | "stale" | "unknown";

// Decide whether a pending review window still applies to the live PR head.
// Critically separates a PR that has definitively moved on / closed ("stale",
// safe to discard) from a PR state we could not read because `gh` failed
// ("unknown"). A transient `gh pr view` failure must never be mistaken for a
// stale head, because discarding pending state without an ack drops the merge
// gate and leaves a reviewed head un-acked (see pi-failure.md failure #13).
export function classifyReviewHead(params: {
  pendingHead: string;
  localHead: string | undefined;
  prOpenAtBase: boolean;
  prHead: string | undefined;
  prQueryFailed: boolean;
}): ReviewHeadStatus {
  if (params.localHead === params.pendingHead) return "current";
  if (params.prQueryFailed) return "unknown";
  if (params.prOpenAtBase && params.prHead === params.pendingHead) return "current";
  return "stale";
}

export type ReviewCompletionState = {
  head: string;
  lanes: string[];
  spawned: boolean;
  spawnedIds?: Record<string, string>;
  fallbackLanes?: string[];
};

export type ReviewSpawnRequest = {
  lane: string;
  prompt: string;
  description: string;
};

export type ReviewSpawnSnapshot = {
  completed: string[];
  spawnedIds: Record<string, string>;
  fallbackLanes: string[];
  requestedAt: Record<string, number>;
  spawned: boolean;
  reviewStartedAt: number;
  spawnedAt?: number;
};

export type ReviewSpawnService = {
  spawn: (lane: string, prompt: string, options: Record<string, unknown>) => string | undefined;
};

export function extractBackgroundAgentId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, any>;
  const direct = record.details?.agentId || record.agentId;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const textParts: string[] = [];
  const collectText = (value: unknown): void => {
    if (typeof value === "string") textParts.push(value);
    else if (Array.isArray(value)) value.forEach(collectText);
    else if (value && typeof value === "object") {
      const maybeText = (value as Record<string, unknown>).text;
      if (typeof maybeText === "string") textParts.push(maybeText);
    }
  };
  collectText(record.content);
  collectText(record.result);
  collectText(record.output);
  const match = textParts.join("\n").match(
    /Agent ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-(?:[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{3,4}))\b/i,
  );
  return match?.[1];
}

export function isReviewCompletionForLane(state: ReviewCompletionState, type: string, completionId?: string, prompt?: string): boolean {
  if (!state.lanes.includes(type)) return false;
  const spawnedId = state.spawnedIds?.[type];
  if (spawnedId) return completionId === spawnedId;
  if (state.fallbackLanes?.includes(type)) return prompt !== undefined && prompt.includes(state.head);
  if (state.spawned) return prompt !== undefined && prompt.includes(state.head);
  return prompt !== undefined && prompt.includes(state.head);
}

export function createBoundedOnceTracker(limit = 200): (id: string | undefined) => boolean {
  const seen = new Set<string>();
  const order: string[] = [];
  return (id: string | undefined): boolean => {
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    order.push(id);
    while (order.length > limit) {
      const stale = order.shift();
      if (stale) seen.delete(stale);
    }
    return true;
  };
}

export function createReadyOnceTracker(limit = 200): (id: string | undefined, ready: boolean) => boolean {
  const shouldProcess = createBoundedOnceTracker(limit);
  return (id: string | undefined, ready: boolean): boolean => {
    if (!ready) return false;
    return shouldProcess(id);
  };
}

export function reusablePendingReview<T extends { head: string }>(previous: T | undefined, currentHead: string, isAncestor: (ancestor: string, current: string) => boolean): T | undefined {
  if (!previous || previous.head === currentHead) return previous;
  return isAncestor(previous.head, currentHead) ? previous : undefined;
}

export function selectReviewBase(params: {
  previous?: { head: string; reviewBase?: string; lanes: string[]; completed: string[] };
  lastAck?: string;
  previousRemoteHead?: string;
}): string | undefined {
  const priorIncomplete = params.previous?.lanes.some((lane) => !params.previous?.completed.includes(lane));
  if (priorIncomplete) return params.previous?.reviewBase;
  return params.previous?.head || params.lastAck || params.previousRemoteHead;
}

export function startReviewLaneSpawns(input: {
  state: ReviewSpawnSnapshot;
  requests: ReviewSpawnRequest[];
  service: ReviewSpawnService;
  now: number;
}): { state: ReviewSpawnSnapshot; launched: string[] } {
  const completed = new Set(input.state.completed);
  let next: ReviewSpawnSnapshot = {
    completed: input.state.completed,
    spawnedIds: { ...input.state.spawnedIds },
    fallbackLanes: [...input.state.fallbackLanes],
    requestedAt: { ...input.state.requestedAt },
    spawned: input.state.spawned,
    reviewStartedAt: input.state.reviewStartedAt,
    spawnedAt: input.state.spawnedAt,
  };
  let launched: string[] = [];

  for (const request of input.requests) {
    if (completed.has(request.lane) || next.spawnedIds[request.lane]) continue;
    next = { ...next, requestedAt: { ...next.requestedAt, [request.lane]: input.now } };
    let id: string | undefined;
    try {
      id = input.service.spawn(request.lane, request.prompt, {
        description: request.description,
        inheritContext: false,
        maxTurns: 8,
        bypassQueue: true,
      });
    } catch {
      id = undefined;
    }
    if (typeof id === "string" && id.length > 0) {
      const { [request.lane]: _removed, ...requestedAt } = next.requestedAt;
      next = {
        ...next,
        spawnedIds: { ...next.spawnedIds, [request.lane]: id },
        requestedAt,
        fallbackLanes: next.fallbackLanes.filter((lane) => lane !== request.lane),
        spawned: true,
        spawnedAt: next.spawnedAt || input.now,
      };
      launched = [...launched, `${request.lane}:${id}`];
    } else if (!next.fallbackLanes.includes(request.lane)) {
      next = { ...next, fallbackLanes: [...next.fallbackLanes, request.lane] };
    }
  }

  return { state: next, launched };
}

export function classifyReviewFiles(files: string[] | undefined): string[] | undefined {
  if (files === undefined) return ALL_REVIEW_LANES;
  if (files.length === 0) return [];
  let hasBehavioral = false;
  let touchesSdd = false;
  let touchesDocs = false;
  for (const file of files) {
    if (file.startsWith("sdd/")) touchesSdd = true;
    else if (file.startsWith("documentation/") || ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "LICENSE"].includes(file)) touchesDocs = true;
    else hasBehavioral = true;
  }
  if (hasBehavioral) return ALL_REVIEW_LANES;
  if (touchesSdd) return ["spec-reviewer", "doc-updater"];
  if (touchesDocs) return ["doc-updater"];
  return [];
}

export default function () {
  // Helper module for review-enforcement.ts; no extension registration needed.
}
