import { basename } from "node:path";

export type DurableReviewLaneSnapshot = {
  lane: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: number;
  completedAt?: number;
  resultPath?: string;
  transcriptPath?: string;
  error?: string;
  pid?: number;
  pidStart?: string;
};

export function recoverDurableReviewLaneState(input: {
  lane: string;
  current?: DurableReviewLaneSnapshot;
  resultExists: boolean;
  resultPath?: string;
}): DurableReviewLaneSnapshot {
  // Result-file existence is the one durable proof of completion — it survives
  // process death and reloads, so it always wins.
  if (input.resultExists) {
    return { ...input.current, lane: input.lane, status: "completed", resultPath: input.resultPath };
  }
  // Recorded "completed" but the result file is gone (manual clean / corruption):
  // re-open as pending so the lane can be re-run.
  if (input.current?.status === "completed") {
    return {
      lane: input.lane,
      status: "pending",
      startedAt: input.current.startedAt,
      completedAt: input.current.completedAt,
      transcriptPath: input.current.transcriptPath,
    };
  }
  // "running" is preserved verbatim. Lanes now run as detached child `pi`
  // processes, so a lane recorded "running" by another (possibly exited) session
  // may still have a live child or a finished transcript on disk. The single
  // authority for the running → completed/failed transition is reapLaneDecision,
  // which checks child-process liveness and the transcript. Resetting running →
  // pending here (the old in-process-model heuristic) caused re-spawn churn: the
  // spawning session would exit, a later session would re-read the job, flip the
  // lane back to pending, and reconcile would spawn a duplicate (review.md §7.1).
  return input.current ?? { lane: input.lane, status: "pending" };
}

// ── Durable lane reaping (detached child `pi` processes) ────────────────────
// Lanes run as detached `pi --mode json -p` child processes that write a
// newline-delimited JSON event stream to a transcript file. summarizeLaneTranscript
// distils that stream into the facts the reaper needs; reapLaneDecision is the pure
// running → completed/failed transition. Both are process-independent (driven from
// disk facts) so ANY session can reap a lane another session spawned.

export type LaneTranscriptSummary = {
  // agent_end seen → the child finished its run (it may already have exited).
  agentEnded: boolean;
  // The last assistant message_end text — persisted verbatim as the lane result.
  finalText: string;
  // stopReason of the final assistant turn ("stop" = clean; "error"/"aborted" = failure).
  stopReason?: string;
  // The final assistant message carried an error payload.
  errored: boolean;
};

export function summarizeLaneTranscript(lines: string[]): LaneTranscriptSummary {
  let agentEnded = false;
  let finalText = "";
  let stopReason: string | undefined;
  let errored = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: { type?: string; message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string } };
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Partial flush of the last line, or a non-JSON banner — never fatal.
      continue;
    }
    if (event?.type === "agent_end") agentEnded = true;
    if (event?.type === "message_end" && event.message?.role === "assistant") {
      const content = event.message.content;
      const text = Array.isArray(content)
        ? content.map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("")
        : typeof content === "string" ? content : "";
      if (text.trim()) finalText = text;
      if (typeof event.message.stopReason === "string") stopReason = event.message.stopReason;
      if (event.message.errorMessage) errored = true;
    }
  }
  return { agentEnded, finalText, stopReason, errored };
}

export type ReapLaneInput = {
  // Current on-disk lane status.
  status: "pending" | "running" | "completed" | "failed";
  // A result .md already exists (settled by this or another session).
  resultExists: boolean;
  transcript: LaneTranscriptSummary;
  // The lane recorded a child pid.
  hasPid: boolean;
  // The child is still alive AND is still our process (identity-checked against the
  // recorded /proc start-time, so a reused pid reads as not-alive, not an impostor).
  pidAlive: boolean;
  startedAt?: number;
  now: number;
  timeoutMs: number;
};

export type ReapLaneDecision =
  | { action: "none" }
  | { action: "complete"; finalText: string }
  | { action: "fail"; reason: string; kill: boolean };

export function reapLaneDecision(input: ReapLaneInput): ReapLaneDecision {
  // Only running lanes are reapable; everything else is already settled.
  if (input.resultExists) return { action: "none" };
  if (input.status !== "running") return { action: "none" };
  const t = input.transcript;
  const usable = t.finalText.trim().length > 0 && t.stopReason !== "error" && t.stopReason !== "aborted" && !t.errored;
  // agent_end → the run finished; the child is already gone (or exiting), so the work is
  // complete and there is nothing live to kill (kill: false avoids signalling a possibly
  // reused pid). Checked FIRST so a child that finishes and exits in the same tick
  // completes rather than being misread as "exited before result".
  if (t.agentEnded) {
    return usable
      ? { action: "complete", finalText: t.finalText }
      : { action: "fail", reason: `lane finished without a usable result (stopReason=${t.stopReason ?? "unknown"}${t.errored ? ", errored" : ""})`, kill: false };
  }
  // Child is gone but never emitted agent_end. If it nonetheless flushed a usable final
  // assistant message before dying, KEEP it — don't discard a real review over a missing
  // terminal line (transcript flush ordering / abrupt exit). Otherwise it crashed → fail.
  // The child is gone either way, so no kill.
  if (input.hasPid && !input.pidAlive) {
    return usable
      ? { action: "complete", finalText: t.finalText }
      : { action: "fail", reason: "lane process exited before producing a result", kill: false };
  }
  // Verified-alive (pidAlive is identity-checked against the child's /proc start-time, so
  // never a reused-pid impostor) but over its wall-clock budget → reclaim it (kill group).
  if (input.startedAt !== undefined && input.now - input.startedAt > input.timeoutMs) {
    return { action: "fail", reason: `lane exceeded ${input.timeoutMs}ms budget`, kill: true };
  }
  return { action: "none" };
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

export type ReviewAutofixMode = "auto" | "manual" | "unset";

export function reviewAutofixModeFromUserMessages(messages: string[]): ReviewAutofixMode {
  let mode: ReviewAutofixMode = "unset";
  const manualPattern = /\b(?:do not|don't|dont|no|stop)\s+(?:auto(?:matically)?[-\s]*)?(?:fix|implement|apply)\b|\bdo\s+not\s+auto[-\s]*(?:fix|implement)\b|\bdon't\s+auto[-\s]*(?:fix|implement)\b|\bwait\s+for\s+(?:my\s+)?(?:go|approval|command)\b/i;
  const autoPattern = /\bautomatic(?:ally)?\s+is\s+fine\b|\b(?:go|proceed)\b[^.!?]*\b(?:fix|implement|apply)\b[^.!?]*\bfindings?\b|\b(?:fix|implement)\s+(?:all\s+)?(?:legitimate\s+)?(?:PR-boundary\s+review\s+)?findings\b/i;
  for (const message of messages) {
    if (manualPattern.test(message)) mode = "manual";
    if (autoPattern.test(message)) mode = "auto";
  }
  return mode;
}

export function reviewAutofixRequest(repo: string, head: string): ReviewAutofixRequest {
  return {
    message: {
      customType: "codeflare-review-autofix-request",
      content: [
        `Fix legitimate PR-boundary review findings for ${basename(repo)} at ${head}.`,
        "Use the merged review summary immediately above as the actionable finding list; do not fix from partial lane results.",
        "Before editing, committing, or pushing, verify the review job for this exact head is complete and every required lane has a result file.",
        "If any required review lane is still running, pending, missing, or unknown, do not edit, commit, or push; wait for the final merged review summary.",
        "If the user has explicitly said not to automatically fix/implement this round, or to wait for GO/approval, do not edit, commit, or push; present the findings and wait for their command.",
        "Otherwise, fix all legitimate MEDIUM, HIGH, and CRITICAL findings only.",
        "A finding's age is never a reason to skip it: fix every legitimate finding whether it is newly introduced or pre-existing, in this diff or adjacent. Do not exclude, defer, or ask about a legitimate finding because it pre-dates this change — legitimacy is the only criterion.",
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
  reviewComplete: boolean;
  suppress?: boolean;
  claim: () => boolean;
}): boolean {
  if (!input.reviewComplete) return false;
  if (input.suppress) return false;
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
  return `Review ${parts.join(" | ")}`;
}

export function stripExistingReviewSummary(text: string): string {
  return text.replace(/\n+## Review Summary[\s\S]*$/i, "").trim();
}

// A review lane can emit a severity COUNT block inside its findings body — e.g. the doc-updater
// report header lists "CRITICAL: 0", "HIGH: 2", or "HIGH: 2 (A, B)". Those lines start with a
// severity word but are tallies, not findings. Excluding them stops both the counter and the
// finding parser from inflating (a phantom CRITICAL from "CRITICAL: 0 (none)" would otherwise
// flip the merged verdict to block).
function isSeverityCountLine(afterSeverity: string): boolean {
  return /^\s*:?\s*\d+\s*(?:\([^)]*\))?\s*$/.test(afterSeverity);
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
    const match = line.match(/^\s*(?:[-*]\s*)?(?:\d+\.\s*)?(?:\*\*)?\[?(BLOCKING|CRITICAL|HIGH|MEDIUM|LOW)\]?\b(.*)$/i);
    if (!match) continue;
    if (isSeverityCountLine(match[2])) continue;
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
      if (match && !isSeverityCountLine(match[2])) {
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
  // All required lanes dispatch together. The reviewers are report-only and write to
  // disjoint lane files (spec-reviewer → sdd/spec/.review-queue.md, doc-updater →
  // documentation/.doc-coverage.md), so doc-updater no longer waits for spec-reviewer —
  // there is no shared-write race, and the old sequential gate only existed for the
  // superseded auto-fix model where spec-reviewer edited sdd/ in place.
  return [...lanes];
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
    // No lane ordering: all report-only reviewers are eligible immediately (doc-updater
    // no longer gated on spec-reviewer completion — disjoint write targets, no race).
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

// ── Canonical review state (review.md §17.2) ────────────────────────────────
// One pure definition of "what is the review state for this head", derived from
// disk facts injected by the thin fs wrapper in review-jobs.ts. Every read-only
// consumer (the /review-status command, and any future status surface) renders
// THIS instead of re-deriving status from a different subset of the state files.

export type ReviewLaneStatus = "pending" | "running" | "completed" | "failed";
export type ReviewOverall = "none" | "pending" | "running" | "complete" | "failed";

export type ReviewState = {
  repo: string;
  head: string;
  prNumber?: number;
  baseRefName?: string;
  reviewBase?: string;
  lanes: string[];
  laneStatus: Record<string, ReviewLaneStatus>;
  overall: ReviewOverall;
  acked: boolean;
  summaryReady: boolean;
  autofixRequested: boolean;
  breakerOpen: boolean;
  attempts: number;
  startedAt?: number;
};

export type ComputeReviewStateInput = {
  repo: string;
  head: string;
  prNumber?: number;
  baseRefName?: string;
  reviewBase?: string;
  lanes: string[];
  // job.laneState[lane].status, or undefined when no lane record exists yet.
  laneJobStatus: (lane: string) => ReviewLaneStatus | undefined;
  // existsSync(reviewResultPath(repo, head, lane)) — an authored result is authoritative.
  resultLaneExists: (lane: string) => boolean;
  // Legacy hook; always false now that "running" is read from the on-disk lane record
  // (the reaper keeps it accurate cross-process). Retained for call-site compatibility.
  runningInMemory: (lane: string) => boolean;
  ackHead: string;
  breakerHead: string;
  attempts: number;
  autofixRequested: boolean;
  startedAt?: number;
};

// Status precedence — the single source of this rule:
// 1. result .md exists        → completed (existence is proof, survives reload/process death)
// 2. job lane status failed    → failed
// 3. running in memory OR job lane status running → running
// 4. otherwise                 → pending
function laneStatusFrom(lane: string, input: ComputeReviewStateInput): ReviewLaneStatus {
  if (input.resultLaneExists(lane)) return "completed";
  const jobStatus = input.laneJobStatus(lane);
  if (jobStatus === "failed") return "failed";
  if (input.runningInMemory(lane) || jobStatus === "running") return "running";
  return "pending";
}

export function computeReviewStateFrom(input: ComputeReviewStateInput): ReviewState {
  const laneStatus: Record<string, ReviewLaneStatus> = {};
  for (const lane of input.lanes) laneStatus[lane] = laneStatusFrom(lane, input);
  const statuses = input.lanes.map((lane) => laneStatus[lane]);
  const overall: ReviewOverall =
    input.lanes.length === 0 ? "none"
      : statuses.includes("failed") ? "failed"
        : statuses.includes("running") ? "running"
          : statuses.includes("pending") ? "pending"
            : "complete";
  return {
    repo: input.repo,
    head: input.head,
    prNumber: input.prNumber,
    baseRefName: input.baseRefName,
    reviewBase: input.reviewBase,
    lanes: input.lanes,
    laneStatus,
    overall,
    acked: input.head !== "" && input.ackHead === input.head,
    summaryReady: input.lanes.length > 0 && input.lanes.every((lane) => laneStatus[lane] === "completed"),
    autofixRequested: input.autofixRequested,
    breakerOpen: input.head !== "" && input.breakerHead === input.head,
    attempts: input.attempts,
    startedAt: input.startedAt,
  };
}

// ── Open-PR reconciliation (REQ-AGENT-058) ──────────────────────────────────
// The onToolEnd boundary path can miss a PR-open command (compound `&&` + here-doc
// parsing, a reload between command and event, a model that prints the URL without
// the structured tool result). Reconciliation is the durable fallback: on lifecycle
// ticks, if an OPEN, non-draft, ENFORCED main/master PR has a head that is not yet
// acknowledged and has no review window and no open breaker, start one. This is the
// narrow, bounded re-read REQ-036 AC7 permits - it never fires on mere branch/PR
// existence, only on an open enforced PR whose head has no review at all. Returning a
// reason (not a bare boolean) keeps the decision auditable: the caller logs every
// non-reconcile outcome as a boundary_candidate_ignored event (never-silent, AC4).

export type OpenPrReconcileInput = {
  // PR facts (from `gh pr view`): the PR for this branch is OPEN and not a draft.
  prOpen: boolean;
  prDraft: boolean;
  // Enforced = SDD project AND the PR base is main/master (the only gated boundary).
  enforced: boolean;
  // The resolved enforced head commit to review ("" when none could be resolved).
  head: string;
  // Review state for that head, from computeReviewState.
  acked: boolean;
  hasReviewJob: boolean;
  reviewActive: boolean;
  breakerOpen: boolean;
};

export type OpenPrReconcileDecision = { reconcile: boolean; reason: string };

export type OpenPrReconcileLifecycleInput = {
  activeRun: boolean;
  hasRepo: boolean;
  sddProject: boolean;
  pendingSameRepo: boolean;
  throttled: boolean;
};

export type OpenPrReconcileLifecycleDecision = { check: boolean; reason: string };

export function shouldCheckOpenPrReconciliation(input: OpenPrReconcileLifecycleInput): OpenPrReconcileLifecycleDecision {
  if (!input.activeRun) return { check: false, reason: "inactive review run" };
  if (!input.hasRepo) return { check: false, reason: "no repo" };
  if (!input.sddProject) return { check: false, reason: "not an SDD project" };
  if (input.pendingSameRepo) return { check: false, reason: "pending window already managed" };
  if (input.throttled) return { check: false, reason: "reconciliation throttled" };
  return { check: true, reason: "lifecycle check may query open PR state" };
}

export function shouldReconcileOpenPr(input: OpenPrReconcileInput): OpenPrReconcileDecision {
  if (!input.prOpen) return { reconcile: false, reason: "no open PR for branch" };
  if (input.prDraft) return { reconcile: false, reason: "PR is a draft" };
  if (!input.enforced) return { reconcile: false, reason: "PR not enforced (base not main/master, or not an SDD project)" };
  if (!input.head) return { reconcile: false, reason: "no resolvable enforced head" };
  if (input.acked) return { reconcile: false, reason: "head already acknowledged" };
  if (input.breakerOpen) return { reconcile: false, reason: "review breaker open for head" };
  if (input.hasReviewJob || input.reviewActive) return { reconcile: false, reason: "review window already exists for head" };
  return { reconcile: true, reason: "open enforced PR head is unacknowledged with no review window" };
}

// Action gate for a reconciled (missed-boundary) PR head (REQ-AGENT-058 revised).
// shouldReconcileOpenPr decides WHETHER a head is reconcilable; this decides what the
// reconciler DOES with it. The locked design is: an in-session push still AUTO-STARTS the
// review exactly like the onToolEnd boundary path, and only a fresh clone/checkout of a repo
// with a pre-existing open PR is OFFERED (notify + persist the offered marker) so the user
// runs /review-run or /review-skip. `inSessionContinuation` is the caller's verdict that this
// head is continuous work on a branch we have ALREADY reviewed (the new head descends from a
// previously-acked head), which means the onToolEnd auto-start was MISSED (compound `&&`,
// here-doc, `gh pr edit`, or a reload between the command and its event) rather than this being
// a fresh clone — so we auto-start to honour the design. A fresh clone has no prior ack on this
// repo, so it falls through to OFFER, and `git clone` never auto-spawns an unstoppable review.
// Offer is once-per-head (the marker is head-keyed, so a new commit re-offers). Pure: no fs, no
// notify — the caller performs the side effects keyed off the returned action.
export type ReconcileBoundaryInput = { reconcile: boolean; alreadyOffered: boolean; inSessionContinuation: boolean };
export type ReconcileBoundaryAction = "autostart" | "offer" | "noop";

export function reconcileBoundaryAction(input: ReconcileBoundaryInput): ReconcileBoundaryAction {
  if (!input.reconcile) return "noop";
  if (input.inSessionContinuation) return "autostart";
  if (input.alreadyOffered) return "noop";
  return "offer";
}

// In-session continuation = the enforced head ADVANCED during THIS Pi session, i.e. it
// differs from and descends from the head observed when this session first reconciled
// (the in-memory baseline, captured at session start). That is the only signal of an
// in-session push whose on-tool-end auto-start was dropped (so reconciliation should
// auto-start). A head present at session start (baseline undefined, or baseline === head)
// was NOT pushed during this session — it is a fresh launch/clone/checkout and must OFFER,
// never auto-start. Deriving continuation from the on-disk ack marker instead (the prior
// implementation) wrongly treated ANY descendant-of-a-prior-ack head as continuation, so
// every bare Pi start auto-spawned reviewers — the regression this restores to offering.
export function reviewBaselineContinuation(
  baseline: string | undefined,
  head: string,
  isAncestor: (ancestor: string, current: string) => boolean,
): boolean {
  if (!baseline || !head || baseline === head) return false;
  return isAncestor(baseline, head);
}

// Resolve which repo a review handler should act on, WITHOUT consulting the shared graphify
// active-cwd sentinel. That sentinel (/home/user/.cache/codeflare-hooks/graphify-active-cwd) is a
// single-active-repo file written by BOTH Claude's graphify-active-repo.sh hook AND Pi's
// codeflare-pi.ts (proactively, on every tool execution) from each agent's OWN cwd — so under
// concurrent agents it flaps to whichever agent acted last, not the repo THIS Pi session is
// reviewing. When Pi reviews a different (e.g. nested) repo than the one that last wrote the
// sentinel, sentinel-based resolution silently misroutes finalize/footer to the wrong .git: the
// summary never emits, autofix never starts, and the progress footer shows nothing. Precedence:
//   commandCwd (explicit `cd`/`-C` in the boundary command) -> sessionCwd (Pi's session cwd)
//   -> sessionReviewRepo (already-resolved root remembered in-session, for the no-ctx reaper)
//   -> processCwd (Pi process dir, last resort).
// commandCwd/sessionCwd/processCwd are directories resolved to a git root via gitRootOf;
// sessionReviewRepo is already a git root and is returned verbatim.
export function resolveReviewRepo(
  input: { commandCwd?: string; sessionCwd?: string; sessionReviewRepo?: string; processCwd?: string },
  gitRootOf: (dir: string) => string | undefined,
): string | undefined {
  const fromDir = (dir: string | undefined): string | undefined => (dir ? gitRootOf(dir) : undefined);
  return fromDir(input.commandCwd)
    ?? fromDir(input.sessionCwd)
    ?? input.sessionReviewRepo
    ?? fromDir(input.processCwd);
}

// Npm package source strings a durable review lane should load as additionalExtensionPaths.
// Graphify is a first-party LOCAL extension (graphify-native.ts), loaded directly by the lane
// runner alongside codeflare-pi - it is not an npm package and never appears here.
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
    if (source.includes("context-mode") && enabled) sources.push(source);
  }
  return sources;
}

export default function () {
  // Helper module for durable review job sequencing; no extension registration.
}
