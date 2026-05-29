import { basename } from "node:path";

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

export function durableReviewMessageKey(input: {
  customType: string;
  repo?: string;
  head?: string;
  lane?: string;
  path?: string;
}): string {
  return [input.customType, input.repo || "", input.head || "", input.lane || "summary", input.path || ""].join("\u0000");
}

export type ReviewSeverityCounts = {
  critical: number;
  high: number;
  medium: number;
  low: number;
};

export type DurableReviewRecommendation = "fix" | "review" | "none";

export type DurableReviewSummaryRow = {
  lane: string;
  path: string;
  counts: ReviewSeverityCounts;
  recommendation: DurableReviewRecommendation;
};

export type DurableReviewSummaryModel = {
  columns: string[];
  rows: DurableReviewSummaryRow[];
  actionable: number;
  recommendation: string;
};

export type DurableReviewStatusState = "completed" | "running" | "pending";

export type DurableReviewStatusSegment = {
  lane: string;
  label: string;
  state: DurableReviewStatusState;
};

export type DurableReviewStatusStyle = {
  done?: (text: string) => string;
  running?: (text: string) => string;
  pending?: (text: string) => string;
};

export function durableReviewStatusSegments(input: {
  lanes: string[];
  completed: string[];
  running: string[];
}): DurableReviewStatusSegment[] {
  const completed = new Set(input.completed);
  const running = new Set(input.running);
  const labels: Array<[string, string]> = [
    ["code-reviewer", "code"],
    ["spec-reviewer", "spec"],
    ["doc-updater", "docs"],
  ];
  return labels
    .filter(([lane]) => input.lanes.includes(lane))
    .map(([lane, label]) => ({
      lane,
      label,
      state: completed.has(lane) ? "completed" : running.has(lane) ? "running" : "pending",
    }));
}

export function compactDurableReviewStatus(input: {
  head: string;
  lanes: string[];
  completed: string[];
  running: string[];
  style?: DurableReviewStatusStyle;
}): string {
  const styledLabel = (segment: DurableReviewStatusSegment): string => {
    if (segment.state === "completed") return input.style?.done?.(segment.label) ?? segment.label;
    if (segment.state === "running") return input.style?.running?.(segment.label) ?? segment.label;
    return input.style?.pending?.(segment.label) ?? segment.label;
  };
  const parts = durableReviewStatusSegments(input).map(styledLabel);
  return `Review ${input.head.slice(0, 7)} --> ${parts.join(" | ")}`;
}

export function stripExistingReviewSummary(text: string): string {
  return text.replace(/\n+## Review Summary[\s\S]*$/i, "").trim();
}

export function countReviewSeverities(text: string): ReviewSeverityCounts {
  const counts: ReviewSeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:[-*]\s*)?(?:\d+\.\s*)?(?:\*\*)?\[?(BLOCKING|CRITICAL|HIGH|MEDIUM|LOW)\]?\b/i);
    if (!match) continue;
    const severity = match[1].toUpperCase();
    if (severity === "BLOCKING" || severity === "CRITICAL") counts.critical += 1;
    else if (severity === "HIGH") counts.high += 1;
    else if (severity === "MEDIUM") counts.medium += 1;
    else if (severity === "LOW") counts.low += 1;
  }
  return counts;
}

export function actionableReviewCount(counts: ReviewSeverityCounts): number {
  return counts.critical + counts.high + counts.medium;
}

export function durableReviewRecommendation(counts: ReviewSeverityCounts): DurableReviewRecommendation {
  if (counts.critical > 0 || counts.high > 0 || counts.medium > 0) return "fix";
  if (counts.low > 0) return "review";
  return "none";
}

export function durableReviewSummaryModel(rows: DurableReviewSummaryRow[]): DurableReviewSummaryModel {
  const actionable = rows.reduce((total, row) => total + actionableReviewCount(row.counts), 0);
  return {
    columns: ["Lane", "Findings document", "Critical", "High", "Medium", "Low", "Recommendation"],
    rows,
    actionable,
    recommendation: actionable > 0
      ? `automatically fix ${actionable} actionable MEDIUM/HIGH/CRITICAL finding(s), commit, and push only the fix diff`
      : "no actionable MEDIUM/HIGH/CRITICAL findings remain",
  };
}

export function reviewSummaryTable(counts: ReviewSeverityCounts): string {
  const verdict = counts.critical > 0
    ? "BLOCKING — critical findings must be resolved before merge."
    : counts.high > 0
      ? "WARNING — high findings should be resolved before merge."
      : counts.medium > 0
        ? "INFO — medium findings should be reviewed."
        : counts.low > 0
          ? "NOTE — low findings only."
          : "PASS — no findings reported.";
  return [
    "## Review Summary",
    "",
    "| Severity | Count | Status |",
    "|----------|-------|--------|",
    `| CRITICAL | ${counts.critical} | ${counts.critical > 0 ? "block" : "pass"} |`,
    `| HIGH     | ${counts.high} | ${counts.high > 0 ? "warn" : "pass"} |`,
    `| MEDIUM   | ${counts.medium} | ${counts.medium > 0 ? "info" : "pass"} |`,
    `| LOW      | ${counts.low} | ${counts.low > 0 ? "note" : "pass"} |`,
    "",
    `Verdict: ${verdict}`,
  ].join("\n");
}

export type DurableReviewResultModel = {
  repoName: string;
  head: string;
  prNumber?: number;
  lane: string;
  body: string;
  counts: ReviewSeverityCounts;
  recommendation: DurableReviewRecommendation;
};

export function durableReviewResultModel(job: { repo: string; head: string; prNumber?: number }, lane: string, text: string): DurableReviewResultModel {
  const body = stripExistingReviewSummary(text.trim()) || "No findings reported.";
  const counts = countReviewSeverities(body);
  return {
    repoName: basename(job.repo),
    head: job.head,
    prNumber: job.prNumber,
    lane,
    body,
    counts,
    recommendation: durableReviewRecommendation(counts),
  };
}

export function formatDurableReviewResult(job: { repo: string; head: string; prNumber?: number }, lane: string, text: string): string {
  const model = durableReviewResultModel(job, lane, text);
  return [
    `# PR-boundary ${model.lane}`,
    "",
    `Repo: ${model.repoName}`,
    `Head: ${model.head}`,
    `PR: ${model.prNumber || "?"}`,
    "",
    "## Findings",
    "",
    model.body,
    "",
    reviewSummaryTable(model.counts),
    "",
  ].join("\n");
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
