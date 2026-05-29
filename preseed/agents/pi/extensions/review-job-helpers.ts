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

export type DurableReviewSummaryRecord = DurableReviewSummaryRow & {
  text: string;
};

export type ReviewFindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type ReviewFinding = {
  lane: string;
  severity: ReviewFindingSeverity;
  title: string;
  file?: string;
  issue?: string;
  fix?: string;
};

export type MergedReviewSummaryInput = {
  repoName: string;
  head: string;
  records: DurableReviewSummaryRecord[];
};

export type MergedReviewSummaryModel = {
  repoName: string;
  head: string;
  headShort: string;
  counts: ReviewSeverityCounts;
  findings: ReviewFinding[];
  recommendation: string;
};

export type ReviewAutofixMessage = {
  customType: "codeflare-review-autofix-request";
  content: string;
  display: false;
  details: { repo: string; head: string };
};

export type ReviewAutofixOptions = {
  triggerTurn: true;
  deliverAs: "followUp";
};

export type ReviewAutofixRequest = {
  message: ReviewAutofixMessage;
  options: ReviewAutofixOptions;
};

export type ReviewAutofixSender = {
  sendMessage: (message: ReviewAutofixMessage, options: ReviewAutofixOptions) => void;
};

export type ReviewAutofixRow = {
  counts: ReviewSeverityCounts;
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

export function reviewAutofixRequest(repo: string, head: string): ReviewAutofixRequest {
  return {
    message: {
      customType: "codeflare-review-autofix-request",
      content: [
        `Fix legitimate PR-boundary review findings for ${basename(repo)} at ${head}.`,
        "Use the merged review summary immediately above as the actionable finding list.",
        "Fix all legitimate MEDIUM, HIGH, and CRITICAL findings only.",
        "Do not rerun or start CI monitoring unless explicitly asked or a merge/deploy gate requires it.",
        "Commit the fix as a new commit and push to the same branch; do not amend or rewrite history.",
      ].join("\n"),
      display: false,
      details: { repo, head },
    },
    options: { triggerTurn: true, deliverAs: "followUp" },
  };
}

export function sendReviewAutofixRequest(sender: ReviewAutofixSender, repo: string, head: string): void {
  const request = reviewAutofixRequest(repo, head);
  sender.sendMessage(request.message, request.options);
}

export function requestReviewAutofixForRows(input: {
  sender: ReviewAutofixSender;
  repo: string;
  head: string;
  rows: ReviewAutofixRow[];
  claim: () => boolean;
}): boolean {
  if (!input.rows.some((row) => actionableReviewCount(row.counts) > 0)) return false;
  if (!input.claim()) return false;
  sendReviewAutofixRequest(input.sender, input.repo, input.head);
  return true;
}

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
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
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

export function laneReviewLabel(lane: string): string {
  if (lane === "code-reviewer") return "code";
  if (lane === "spec-reviewer") return "spec";
  if (lane === "doc-updater") return "docs";
  return lane;
}

export function cleanReviewText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownTableCell(value: string | undefined): string {
  return cleanReviewText(value || "—")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

function reviewFindingBody(text: string): string {
  const withoutSummary = stripExistingReviewSummary(text);
  const match = withoutSummary.match(/(?:^|\n)## Findings\s*\n+([\s\S]*)$/i);
  return (match?.[1] || withoutSummary).trim();
}

function reviewField(block: string, field: string): string | undefined {
  const labels = ["File", "Issue", "Fix", "Recommendation", "Evidence"];
  const lines = block.split("\n");
  const labelPattern = new RegExp(`^\\s*${field}:\\s*`, "i");
  const start = lines.findIndex((line) => labelPattern.test(line));
  if (start === -1) return undefined;
  const first = lines[start].replace(labelPattern, "");
  const rest: string[] = [first];
  for (const line of lines.slice(start + 1)) {
    if (labels.some((label) => new RegExp(`^\\s*${label}:\\s*`, "i").test(line))) break;
    if (/^\s*(?:[-*]\s*)?(?:\d+\.\s*)?(?:\*\*)?\[?(BLOCKING|CRITICAL|HIGH|MEDIUM|LOW)\]?\b/i.test(line)) break;
    if (/^\s*##\s+/.test(line) || /^\s*```/.test(line)) break;
    rest.push(line);
  }
  const value = rest.join("\n").trim();
  return value || undefined;
}

function findingHeaderMatches(body: string): RegExpMatchArray[] {
  const matches: RegExpMatchArray[] = [];
  const header = /^\s*(?:[-*]\s*)?(?:\d+\.\s*)?(?:\*\*)?\[?(BLOCKING|CRITICAL|HIGH|MEDIUM|LOW)\]?\s*(?:\*\*)?\s*(.+?)\s*$/gim;
  let inFence = false;
  let offset = 0;
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      offset += line.length + 1;
      continue;
    }
    if (!inFence) {
      header.lastIndex = 0;
      const match = header.exec(line);
      if (match) {
        match.index = offset + (match.index || 0);
        matches.push(match);
      }
    }
    offset += line.length + 1;
  }
  return matches;
}

export function extractReviewFindings(lane: string, text: string): ReviewFinding[] {
  const body = reviewFindingBody(text);
  if (!body || /^No findings\.?$/i.test(body)) return [];
  const matches = findingHeaderMatches(body);
  return matches.map((match, index) => {
    const severity = match[1].toUpperCase() === "BLOCKING" ? "CRITICAL" : match[1].toUpperCase() as ReviewFindingSeverity;
    const start = match.index || 0;
    const end = matches[index + 1]?.index ?? body.length;
    const block = body.slice(start, end).trim();
    const file = cleanReviewText(reviewField(block, "File") || "") || undefined;
    const issue = cleanReviewText(reviewField(block, "Issue") || "") || undefined;
    const fix = cleanReviewText(reviewField(block, "Fix") || "") || undefined;
    return {
      lane,
      severity,
      title: cleanReviewText(match[2]),
      file,
      issue,
      fix,
    };
  });
}

export function sortReviewFindingsByCriticality(findings: ReviewFinding[]): ReviewFinding[] {
  const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } satisfies Record<ReviewFindingSeverity, number>;
  return [...findings].sort((a, b) => rank[a.severity] - rank[b.severity] || laneReviewLabel(a.lane).localeCompare(laneReviewLabel(b.lane)) || a.title.localeCompare(b.title));
}

export function aggregateReviewSeverityCounts(rows: Array<{ counts: ReviewSeverityCounts }>): ReviewSeverityCounts {
  return rows.reduce((counts, row) => ({
    critical: counts.critical + row.counts.critical,
    high: counts.high + row.counts.high,
    medium: counts.medium + row.counts.medium,
    low: counts.low + row.counts.low,
  }), { critical: 0, high: 0, medium: 0, low: 0 });
}

function mergedReviewSummaryTable(counts: ReviewSeverityCounts): string {
  const status = (count: number, active: string): string => count > 0 ? active : "pass";
  return [
    "| Severity | Count | Status |",
    "|----------|-------|--------|",
    `| CRITICAL | ${counts.critical} | ${status(counts.critical, "block")} |`,
    `| HIGH | ${counts.high} | ${status(counts.high, "warn")} |`,
    `| MEDIUM | ${counts.medium} | ${status(counts.medium, "info")} |`,
    `| LOW | ${counts.low} | ${status(counts.low, "note")} |`,
  ].join("\n");
}

function mergedFindingsTable(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "No findings.";
  return [
    "| Severity | Lane | Finding | File | Fix |",
    "|----------|------|---------|------|-----|",
    ...findings.map((finding) => `| ${finding.severity} | ${laneReviewLabel(finding.lane)} | ${markdownTableCell(finding.title)} | ${markdownTableCell(finding.file)} | ${markdownTableCell(finding.fix || finding.issue)} |`),
  ].join("\n");
}

function mergedFindingsList(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "No findings.";
  return findings.map((finding) => {
    const location = finding.file ? ` (${cleanReviewText(finding.file)})` : "";
    const issue = cleanReviewText(finding.issue || "");
    const fix = cleanReviewText(finding.fix || "");
    const details = [issue && `Issue: ${issue}`, fix && `Fix: ${fix}`].filter(Boolean).join(" ");
    return `- **${finding.severity}** ${laneReviewLabel(finding.lane)} — ${cleanReviewText(finding.title)}${location}${details ? `. ${details}` : ""}`;
  }).join("\n");
}

export function mergedReviewRecommendation(counts: ReviewSeverityCounts): string {
  const actionable = actionableReviewCount(counts);
  if (actionable > 0) return `automatically fix ${actionable} actionable MEDIUM/HIGH/CRITICAL finding(s), commit, and push only the fix diff`;
  if (counts.low > 0) return "review LOW findings when convenient; no MEDIUM/HIGH/CRITICAL findings remain";
  return "no findings remain";
}

export function mergedReviewSummaryModel(input: MergedReviewSummaryInput): MergedReviewSummaryModel {
  const counts = aggregateReviewSeverityCounts(input.records);
  return {
    repoName: input.repoName,
    head: input.head,
    headShort: input.head.slice(0, 12),
    counts,
    findings: sortReviewFindingsByCriticality(input.records.flatMap((record) => extractReviewFindings(record.lane, record.text))),
    recommendation: mergedReviewRecommendation(counts),
  };
}

export function formatMergedReviewSummary(input: MergedReviewSummaryInput): string {
  const model = mergedReviewSummaryModel(input);
  return [
    `PR-boundary review acknowledged for ${model.repoName} at ${model.headShort}.`,
    "",
    "## Review Summary",
    "",
    mergedReviewSummaryTable(model.counts),
    "",
    "## Findings",
    "",
    mergedFindingsTable(model.findings),
    "",
    "## Finding Details",
    "",
    mergedFindingsList(model.findings),
    "",
    `Recommendation: ${model.recommendation}.`,
  ].join("\n");
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

export function durableReviewAckReady(input: { lanes: string[]; resultLanes: string[] }): boolean {
  const resultLanes = new Set(input.resultLanes);
  return input.lanes.every((lane) => resultLanes.has(lane));
}

export function durableReviewJobDir(repo: string, head: string): string {
  return `${repo}/.git/codeflare-review-jobs/${head}`;
}

// Package source strings a durable review lane should load as additionalExtensionPaths.
// graphify always (if configured) - reviewers benefit from graphify_query/path/explain.
// context-mode only when enabled (bare-string form, or an object entry without an
// `extensions` filter - mirrors codeflare-pi's contextModeEnabled), so lanes inherit /ctx on.
// Never @gotgenes/pi-subagents (the lane must not spawn subagents).
export function laneExtensionSources(
  packages: Array<string | { source?: string; extensions?: unknown }>,
): string[] {
  const sources: string[] = [];
  for (const entry of packages) {
    const source = typeof entry === "string" ? entry : entry?.source ?? "";
    if (!source) continue;
    const enabled = typeof entry === "string" || entry.extensions === undefined;
    if (source.includes("@gaodes/pi-graphify")) sources.push(source);
    else if (source.includes("context-mode") && enabled) sources.push(source);
  }
  return sources;
}

export default function () {
  // Helper module for durable review job sequencing; no extension registration.
}
