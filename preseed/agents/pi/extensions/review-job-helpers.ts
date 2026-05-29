export type DurableReviewLaneSnapshot = {
  lane: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: number;
  completedAt?: number;
  resultPath?: string;
  transcriptPath?: string;
  error?: string;
};

export function recoverDurableReviewLaneState(input: {
  lane: string;
  current?: DurableReviewLaneSnapshot;
  resultExists: boolean;
  resultPath?: string;
  activeInMemory: boolean;
}): DurableReviewLaneSnapshot {
  if (input.resultExists) {
    return { ...input.current, lane: input.lane, status: "completed", resultPath: input.resultPath };
  }
  if (input.current?.status === "completed") {
    return {
      lane: input.lane,
      status: "pending",
      startedAt: input.current.startedAt,
      completedAt: input.current.completedAt,
      transcriptPath: input.current.transcriptPath,
    };
  }
  if (input.current?.status === "running" && !input.activeInMemory) {
    return {
      lane: input.lane,
      status: "pending",
      startedAt: input.current.startedAt,
      transcriptPath: input.current.transcriptPath,
    };
  }
  return input.current ?? { lane: input.lane, status: "pending" };
}

export function durableReviewInitialLanes(lanes: string[]): string[] {
  const hasSpec = lanes.includes("spec-reviewer");
  return lanes.filter((lane) => lane !== "doc-updater" || !hasSpec);
}

export function durableReviewEligibleLanes(input: {
  lanes: string[];
  completed: string[];
  running: string[];
  requestedAt: Record<string, number>;
  now: number;
  retryMs: number;
}): string[] {
  const completed = new Set(input.completed);
  const running = new Set(input.running);
  return input.lanes.filter((lane) => {
    if (completed.has(lane) || running.has(lane)) return false;
    if (lane === "doc-updater" && input.lanes.includes("spec-reviewer") && !completed.has("spec-reviewer")) return false;
    const lastRequested = input.requestedAt[lane] || 0;
    return lastRequested === 0 || input.now - lastRequested >= input.retryMs;
  });
}

export function allDurableReviewLanesComplete(lanes: string[], completed: string[]): boolean {
  const done = new Set(completed);
  return lanes.every((lane) => done.has(lane));
}

export function durableReviewJobDir(repo: string, head: string): string {
  return `${repo}/.git/codeflare-review-jobs/${head}`;
}

export function durableReviewResultPath(repo: string, head: string, lane: string): string {
  return `${repo}/.git/sdd-review-results/${head}/${lane}.md`;
}

export default function () {
  // Helper module for durable review job sequencing; no extension registration.
}
