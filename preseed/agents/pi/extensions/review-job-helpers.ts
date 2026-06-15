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
    let event: { type?: string; willRetry?: boolean; message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string } };
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Partial flush of the last line, or a non-JSON banner — never fatal.
      continue;
    }
    if (event?.type === "agent_end") {
      // A retryable attempt end (`willRetry: true`) is NOT terminal: pi retries IN the same
      // child process (e.g. after a transient WebSocket drop), so it must not settle the lane,
      // and the failed attempt's verdict is discarded — errored/stopReason/finalText are judged
      // per-attempt, never sticky across a retry, so an early error can't poison the retry that
      // later succeeds. Only an `agent_end` WITHOUT a pending retry is the terminal lane end.
      if (event.willRetry === true) {
        errored = false;
        stopReason = undefined;
        finalText = "";
      } else {
        agentEnded = true;
      }
      continue;
    }
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
  if (input.resultExists) return { action: "none" };
  const t = input.transcript;
  const usable = t.finalText.trim().length > 0 && t.stopReason !== "error" && t.stopReason !== "aborted" && !t.errored;
  // Self-heal: a lane an earlier reaper tick (or a pre-retry-aware reaper) marked `failed`
  // whose retry later flushed a terminal, clean, usable result is recovered rather than left
  // discarded — a good review must never stay lost. Gated on a TERMINAL agent_end with a
  // usable result; a killed/timed-out/genuinely-errored lane has no such result and stays
  // failed. (resultExists is checked above, so a failed lane that already has a file is left
  // alone.)
  if (input.status === "failed") {
    return t.agentEnded && usable ? { action: "complete", finalText: t.finalText } : { action: "none" };
  }
  // Only running lanes are otherwise reapable; everything else is already settled.
  if (input.status !== "running") return { action: "none" };
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

// --- Review-result delivery announcements (two-phase: execution done != delivery done) ---
// The durable review engine acks a head and writes summary.md, but pushing the summary BACK into
// the live session is unreliable: pi.sendMessage only persists a custom message to the session
// transcript when the agent session emits a `message_end` (role:"custom") event, which never fires
// from the off-turn setInterval reaper (no live session loop) nor from a stale-bound sender after a
// reload. The old code created a one-shot `<lane>.sent` marker BEFORE sending and trusted the send,
// so a silent no-op permanently suppressed every retry. These helpers drive a small durable state
// machine instead — pending -> attempted -> visible|failed — whose ONLY proof of delivery is the
// announcement's nonce appearing in the session transcript (scannable plain text, written iff the
// message actually persisted). Pure decision logic lives here; the disk records live in
// review-jobs.ts and the wiring/transcript-scan in review-enforcement.ts.
export type ReviewAnnouncementKind = "summary" | "autofix";
export type ReviewAnnouncementStatus = "pending" | "attempted" | "visible" | "failed";

export type ReviewAnnouncement = {
  kind: ReviewAnnouncementKind;
  repo: string;
  head: string;
  status: ReviewAnnouncementStatus;
  attempts: number;
  nonce: string;
  createdAt: number;
  lastAttemptAt?: number;
  deliveredAt?: number;
  lastError?: string;
};

// Deterministic, transcript-scannable delivery token. Caller passes the time stamp (Date.now in the
// extension) so this stays pure/testable. No spaces; embeds kind+head so distinct announcements can
// never collide, and the stamp distinguishes a re-created announcement from its predecessor.
export function reviewAnnouncementNonce(kind: ReviewAnnouncementKind, head: string, stamp: number): string {
  return `cf-review-${kind}:${head.slice(0, 12)}:${stamp}`;
}

export type AnnouncementAttemptInput = {
  status: ReviewAnnouncementStatus;
  attempts: number;
  lastAttemptAt?: number;
  now: number;
  maxAttempts: number;
  retryDelayMs: number;
};

// Should emitPendingAnnouncements (re)send this announcement on this tick? `pending` sends once;
// `attempted` re-sends only after the retry delay AND while under the attempt cap; terminal states
// (`visible`/`failed`) never send. This is the SOLE owner of retry/backoff timing.
export function shouldAttemptAnnouncement(input: AnnouncementAttemptInput): boolean {
  if (input.status === "visible" || input.status === "failed") return false;
  if (input.status === "pending") return true;
  if (input.attempts >= input.maxAttempts) return false;
  return input.now - (input.lastAttemptAt ?? 0) >= input.retryDelayMs;
}

export type AnnouncementReconcileInput = {
  kind: ReviewAnnouncementKind;
  status: ReviewAnnouncementStatus;
  attempts: number;
  lastAttemptAt?: number;
  nonceFound: boolean;
  now: number;
  maxAttempts: number;
  retryDelayMs: number;
  createdAt?: number;
  maxAgeMs?: number;
};

export type AnnouncementReconcileDecision = "visible" | "failed" | "keep";

// Post-send verdict from observing whether the nonce is now in the session transcript. Proof of
// delivery wins outright. An `attempted` announcement that has burned its attempt cap AND given the
// final attempt its full retry window without ever appearing is `failed` (the user is told to run
// /review-results); anything still in flight is `keep` (emit retries it per shouldAttemptAnnouncement).
// Age backstop — SUMMARY ONLY: the idle-gated summary defers (no attempt burned) while the agent
// streams, so a record that never observes an idle tick would otherwise retry forever without ever
// escalating; once older than maxAgeMs it becomes `failed` so the documented /review-results fallback
// stays reachable and nothing is acked-and-lost. The AUTOFIX announcement is deliberately EXEMPT: it
// defers off-turn (no live session) without burning an attempt, so aging it would mark it `failed` at
// attempts:0 — expiring the fix turn before it ever fired. An undelivered autofix instead reaches a
// terminal state via head-supersede (a newer push retires the stale head via abandonReviewAnnouncements),
// or via the attempt cap above while still claimable and a send keeps erroring — never on age alone.
// (Once the one-shot autofix.requested marker is claimed, claim() returns false so the record can no
// longer re-fire to accrue attempts; head-supersede is then its only terminal path.) Keyed on
// createdAt, so the summary backstop is independent of the attempt counter and never penalises a
// normal in-flight retry.
export function announcementReconcileDecision(input: AnnouncementReconcileInput): AnnouncementReconcileDecision {
  if (input.nonceFound) return "visible";
  if (input.status === "failed") return "failed";
  if (input.status === "attempted" && input.attempts >= input.maxAttempts) {
    return input.now - (input.lastAttemptAt ?? 0) >= input.retryDelayMs ? "failed" : "keep";
  }
  if (input.kind === "summary" && input.maxAgeMs !== undefined && input.createdAt !== undefined && input.now - input.createdAt >= input.maxAgeMs) return "failed";
  return "keep";
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
  details: { repo: string; head: string; nonce?: string };
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

export function reviewAutofixRequest(repo: string, head: string, nonce?: string): ReviewAutofixRequest {
  const lines = [
    `Fix legitimate PR-boundary review findings for ${basename(repo)} at ${head}.`,
    "Use the merged review summary immediately above as the actionable finding list; do not fix from partial lane results.",
    "Before editing, committing, or pushing, verify the review job for this exact head is complete and every required lane has a result file.",
    "If any required review lane is still running, pending, missing, or unknown, do not edit, commit, or push; wait for the final merged review summary.",
    "If the user has explicitly said not to automatically fix/implement this round, or to wait for GO/approval, do not edit, commit, or push; present the findings and wait for their command.",
    "Otherwise, fix all legitimate MEDIUM, HIGH, and CRITICAL findings only.",
    "A finding's age is never a reason to skip it: fix every legitimate finding whether it is newly introduced or pre-existing, in this diff or adjacent. Do not exclude, defer, or ask about a legitimate finding because it pre-dates this change — legitimacy is the only criterion.",
    "Do not rerun or start CI monitoring unless explicitly asked or a merge/deploy gate requires it.",
    "Commit the fix as a new commit and push to the same branch; do not amend or rewrite history.",
  ];
  // A delivery nonce (when supplied) rides in a trailing HTML comment so it lands verbatim in the
  // persisted transcript line — the announcement state machine proves delivery by finding it there.
  if (nonce) lines.push(`<!-- cf-review-delivery ${nonce} -->`);
  return {
    message: {
      customType: "codeflare-review-autofix-request",
      content: lines.join("\n"),
      display: false,
      details: nonce ? { repo, head, nonce } : { repo, head },
    },
    options: { triggerTurn: true, deliverAs: "followUp" },
  };
}

export function sendReviewAutofixRequest(sender: ReviewAutofixSender, repo: string, head: string, nonce?: string): void {
  const request = reviewAutofixRequest(repo, head, nonce);
  sender.sendMessage(request.message, request.options);
}

export function requestReviewAutofixForRows(input: {
  sender: ReviewAutofixSender;
  repo: string;
  head: string;
  rows: ReviewAutofixRow[];
  reviewComplete: boolean;
  suppress?: boolean;
  nonce?: string;
  claim: () => boolean;
}): boolean {
  if (!input.reviewComplete) return false;
  if (input.suppress) return false;
  if (!input.rows.some((row) => actionableReviewCount(row.counts) > 0)) return false;
  if (!input.claim()) return false;
  sendReviewAutofixRequest(input.sender, input.repo, input.head, input.nonce);
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

// Elapsed wall-clock as M:SS (e.g. 78_000 -> "1:18"), for the leading review badge.
export function formatReviewElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Compact token count for the footer (e.g. 950 -> "950", 2_120 -> "2.1k", 124_000 -> "124k").
export function formatReviewTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, "")}k`;
}

export function compactDurableReviewStatus(input: {
  head: string;
  lanes: string[];
  completed: string[];
  running: string[];
  style?: DurableReviewStatusStyle;
  // Optional leading timer badge: "Review 1:18 · code | spec | docs".
  elapsedMs?: number;
  // Optional best-effort per-lane token totals, appended to each lane label.
  laneTokens?: Record<string, number>;
}): string {
  const styledLabel = (segment: DurableReviewStatusSegment): string => {
    if (segment.state === "completed") return input.style?.done?.(segment.label) ?? segment.label;
    if (segment.state === "running") return input.style?.running?.(segment.label) ?? segment.label;
    return input.style?.pending?.(segment.label) ?? segment.label;
  };
  const parts = durableReviewStatusSegments(input).map((segment) => {
    let label = styledLabel(segment);
    const tokens = input.laneTokens?.[segment.lane];
    if (typeof tokens === "number" && tokens > 0) label = `${label} ${formatReviewTokens(tokens)}`;
    return label;
  });
  const badge = input.elapsedMs !== undefined ? `${formatReviewElapsed(input.elapsedMs)} · ` : "";
  return `Review ${badge}${parts.join(" | ")}`;
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
    // A severity word counts only when DECORATED as a finding label — bracketed [HIGH], bolded
    // **HIGH**, or colon-trailed HIGH: — never as a bare prose adjective. Without this, a lane writing
    // "High-level summary:" or "Critical to the design is…" mints a phantom HIGH/CRITICAL that flips the
    // merged verdict to block and fires a needless autofix turn (P5). Tally lines (HIGH: 2 (…)) match via
    // the colon but are filtered out by isSeverityCountLine below, so the honest count is preserved.
    const match = line.match(/^\s*(?:[-*]\s*|\d+\.\s*)?(\[|\*\*)?(BLOCKING|CRITICAL|HIGH|MEDIUM|LOW)(\]|\*\*|:)(.*)$/i);
    if (!match) continue;
    const open = match[1]; const close = match[3];
    const decorated = (open === "[" && close === "]") || (open === "**" && close === "**") || close === ":";
    if (!decorated) continue;
    if (isSeverityCountLine(match[4])) continue;
    const severity = match[2].toUpperCase();
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
  // Use the SAME anchored decoration rule as countReviewSeverities: the decoration must wrap the LEADING
  // severity word ([HIGH] / **HIGH** / HIGH:), not merely appear somewhere on the line. A line-wide test
  // diverges from the counter on a line like "HIGH risk because [LOW] elsewhere" (counter 0, extractor 1),
  // re-opening the phantom-finding-vs-zero-count gap this is meant to close. This regex is BYTE-IDENTICAL
  // to the counter's (group 4 = (.*) so it also matches an empty title), so the match/no-match decision can
  // never drift. Groups: 1=open, 2=severity, 3=close, 4=title. A bare-prose leading severity word
  // ("Critical to the design…") has a space — not ]/**/: — after it, so it simply fails to match and is
  // never a finding. A bare decorated label with no inline title ([HIGH] alone) is counted by the counter,
  // so it is surfaced here too — extractReviewFindings gives it a placeholder title rather than drop it.
  const header = /^\s*(?:[-*]\s*|\d+\.\s*)?(\[|\*\*)?(BLOCKING|CRITICAL|HIGH|MEDIUM|LOW)(\]|\*\*|:)(.*)$/i;
  let inFence = false;
  let offset = 0;
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      offset += line.length + 1;
      continue;
    }
    if (!inFence) {
      const match = line.match(header);
      if (match) {
        const open = match[1]; const close = match[3];
        const decorated = (open === "[" && close === "]") || (open === "**" && close === "**") || close === ":";
        if (decorated && !isSeverityCountLine(match[4])) {
          match.index = offset + (match.index || 0);
          matches.push(match);
        }
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
    const severity = match[2].toUpperCase() === "BLOCKING" ? "CRITICAL" : match[2].toUpperCase() as ReviewFindingSeverity;
    const start = match.index || 0;
    const end = matches[index + 1]?.index ?? body.length;
    const block = body.slice(start, end).trim();
    const file = cleanReviewText(reviewField(block, "File") || "") || undefined;
    const issue = cleanReviewText(reviewField(block, "Issue") || "") || undefined;
    const fix = cleanReviewText(reviewField(block, "Fix") || "") || undefined;
    return {
      lane,
      severity,
      title: cleanReviewText(match[4]) || "(untitled)",
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
// with a pre-existing open PR is OFFERED (a durable chat message + toast) so the user runs
// /review-run or /review-skip. `inSessionContinuation` is the caller's verdict that THIS session
// advanced the head (a boundary command ran this session, or the head descends from this session's
// branch baseline), which means the onToolEnd auto-start was MISSED (compound `&&`, here-doc, `gh pr
// edit`, or a reload between the command and its event) rather than this being a fresh clone — so we
// auto-start to honour the design. A head merely inherited at launch has neither signal, so it falls
// through to OFFER, and `git clone` never auto-spawns an unstoppable review. The offer is deduped via
// `alreadyOffered` — the caller passes offerSurfacedThisSession, a PER-SESSION (process-scoped) marker,
// NOT an on-disk per-head-ever marker (that on-disk marker was removed: it suppressed the offer forever,
// so a relaunched session saw nothing). A new `pi` re-surfaces a still-unchosen offer exactly once. Pure:
// no fs, no notify — the caller performs the side effects keyed off the returned action.
export type ReconcileBoundaryInput = { reconcile: boolean; alreadyOffered: boolean; inSessionContinuation: boolean };
export type ReconcileBoundaryAction = "autostart" | "offer" | "noop";

export function reconcileBoundaryAction(input: ReconcileBoundaryInput): ReconcileBoundaryAction {
  if (!input.reconcile) return "noop";
  if (input.inSessionContinuation) return "autostart";
  if (input.alreadyOffered) return "noop";
  return "offer";
}

// reviewBaselineContinuation is the BACKSTOP signal for missed-boundary autostart: "the current head
// advanced beyond the head this session first saw on this branch" (a strict descendant of `baseline`).
// It exists to catch the one case the primary signal (boundaryActed, in review-enforcement) misses — a
// jiti reload that ate the boundary tool-event, so onToolEnd never ran to record the push, yet the head
// clearly moved forward from where the session started. It is NOT sufficient alone: a bare `git checkout`
// of a pre-existing descendant branch also "descends from baseline", which is why review-enforcement keys
// the baseline by repo+BRANCH (a checkout changes the branch → its baseline is the inherited head →
// baseline === head → returns false → OFFER, never autostart). A head present at session start (baseline
// undefined or === head) was NOT pushed this session, so it returns false and the caller OFFERS.
// Historical note: deriving this from the on-disk ack marker instead (a prior implementation) wrongly
// treated ANY descendant-of-a-prior-ack head as continuation, so every bare Pi start auto-spawned
// reviewers on every launch. The repo+branch baseline + boundaryActed design replaced it.
export function reviewBaselineContinuation(
  baseline: string | undefined,
  head: string,
  isAncestor: (ancestor: string, current: string) => boolean,
): boolean {
  if (!baseline || !head || baseline === head) return false;
  return isAncestor(baseline, head);
}

// reviewInSessionContinuation is the FULL autostart-vs-offer signal for missed-boundary reconciliation
// (REQ-AGENT-058). The reconcile AUTOSTARTS reviewers for a missed boundary only
// when THIS session is what advanced the head — never for a head merely inherited at launch (a fresh
// clone, a relaunch, or a bare checkout), which instead OFFERS so reviewers are never silently spawned on
// work the user did not do this session. Two independent signals, OR'd:
//   • boundaryActed (PRIMARY): a real PR-boundary command (push / pr create / …) actually executed this
//     session for this repo+branch. Recorded in onToolEnd BEFORE any window-creation guard, so even a
//     dropped window (dedup, unresolved head, reload after the event fired) still leaves the fact for
//     reconcile to autostart on. True exactly when we pushed — independent of head ancestry, so it covers
//     the no-PR-at-launch + in-session push case that the baseline signal alone missed.
//   • baseline backstop (reviewBaselineContinuation): covers the reload-ate-the-tool-event case where
//     boundaryActed was never recorded but the head still advanced beyond the session's branch baseline.
// A bare checkout sets neither (no boundary command ran; the new branch's baseline equals its inherited
// head), so it correctly OFFERS — whereas advancing a repo-keyed baseline on ack made a mere
// checkout of a descendant branch autostart.
export function reviewInSessionContinuation(input: {
  boundaryActed: boolean;
  baseline: string | undefined;
  head: string;
  isAncestor: (ancestor: string, current: string) => boolean;
  ackedThisSession?: boolean;
}): boolean {
  if (input.boundaryActed) return true;
  // Once this branch has been ACKED this session, the baseline backstop is SUPPRESSED: a further
  // descendant of the session baseline is either an in-session push (already covered by boundaryActed
  // above) or a remote-actor head FETCHED via `git pull`, which must OFFER, not auto-start a duplicate
  // review (R7). The backstop only covers the pre-first-ack window, where a dropped boundary tool-event
  // is the plausible reason boundaryActed is missing despite an in-session advance.
  if (input.ackedThisSession) return false;
  return reviewBaselineContinuation(input.baseline, input.head, input.isAncestor);
}

// Pure decision for the `gh pr merge` gate — the LAST line of defense, so it must fail in the safe
// (block) direction whenever review is demonstrably required and the PR state can't be trusted. The
// caller feeds the state for the PR the merge command actually targets (so `gh pr merge 42` is gated
// against PR 42, not the cwd branch — P1) plus every locally-known unacked merge-blocking head. Returns
// one of: allow / bypass (a user-only sentinel was present, consume it + ack) / block (with an audit
// reason code). The reason codes feed the durable `merge_blocked` audit event.
//
//   prReadable  — `gh pr view` for the target succeeded (false = transient gh failure: auth/network/
//                 rate-limit/timeout; NOT "no PR", which is prReadable:true + prExists:false).
//   prMalformed — readable + OPEN but base or headRefOid missing (the transient-parse edge the push
//                 path fails OPEN for; here we fail CLOSED if review is pending — R1).
//   prEnforced  — OPEN + base main/master + headRefOid present.
//   candidates  — locally-known unacked heads that each independently require review even when the PR
//                 itself is unreadable/malformed: the pending head, a latched-breaker head, an
//                 outstanding-offer head (R2 — breaker/offer states deliberately have no pending.json).
export type MergeGateInput = {
  prReadable: boolean;
  prExists: boolean;
  prEnforced: boolean;
  prMalformed: boolean;
  enforcedHead: string;
  headAcked: boolean;
  candidates: Array<{ head: string; acked: boolean }>;
  bypassPresent: boolean;
};
export type MergeGateDecision =
  | { action: "allow" }
  | { action: "bypass"; head: string }
  | { action: "block"; head: string; reason: string };
export function mergeGateDecision(input: MergeGateInput): MergeGateDecision {
  const firstUnacked = input.candidates.find((c) => c.head && !c.acked)?.head;
  let block: { head: string; reason: string } | undefined;
  if (!input.prReadable) {
    // gh is down — block only if a review is demonstrably pending for an unacked head; with nothing
    // pending we cannot even assert this is an enforced PR, so we allow (no basis to block).
    if (firstUnacked) block = { head: firstUnacked, reason: "pr_state_unreadable_review_pending" };
  } else if (input.prMalformed) {
    if (firstUnacked) block = { head: firstUnacked, reason: "pr_state_malformed_review_pending" };
  } else if (input.prEnforced) {
    if (!input.headAcked) block = { head: input.enforcedHead, reason: "head_not_acked" };
  }
  // readable + (no PR OR not enforced: base not protected / closed / draft-by-policy) -> allow.
  if (!block) return { action: "allow" };
  if (input.bypassPresent) return { action: "bypass", head: block.head };
  return { action: "block", head: block.head, reason: block.reason };
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
// activeRepo (added) is the IN-MEMORY active-cwd codeflare-pi.ts tracks on every tool execution —
// the SAME signal the statusline footer resolves the repo from. It is load-bearing when the Pi
// session cwd is a NON-repo parent workspace (/home/user/workspace) and the user works in a nested
// clone via `cd`/`git -C`: commandCwd is absent on a slash command (/review-run) and on a
// no-command reconciliation tick, sessionCwd/processCwd resolve to the parentless workspace, and
// sessionReviewRepo is unset until a review has already run — so without activeRepo BOTH /review-run
// AND open-PR reconciliation returned undefined ("not inside an SDD repository" / reconciliation
// silently bailed on hasRepo=false and never auto-started) even though the footer showed the repo.
// It sits after the reliable signals, before processCwd, validated through gitRootOf. This is the
// recallActiveRepo() in-memory value (this Pi process only), NOT the cross-process on-disk sentinel
// that flaps under concurrent agents — so it is safe for routing, unlike the sentinel above.
export function resolveReviewRepo(
  input: { commandCwd?: string; sessionCwd?: string; sessionReviewRepo?: string; activeRepo?: string; processCwd?: string },
  gitRootOf: (dir: string) => string | undefined,
): string | undefined {
  const fromDir = (dir: string | undefined): string | undefined => (dir ? gitRootOf(dir) : undefined);
  return fromDir(input.commandCwd)
    ?? fromDir(input.sessionCwd)
    ?? input.sessionReviewRepo
    ?? fromDir(input.activeRepo)
    ?? fromDir(input.processCwd);
}

// In-session memory of the repos this Pi session is tracking, shared across
// extensions via globalThis. Under Pi 0.79.1's extension loader
// (createJiti(import.meta.url, { moduleCache:false }) per extension), each
// extension gets a SEPARATE instance of this module — a module-local `let`
// written by codeflare-pi.ts is invisible to review-enforcement.ts and
// local-statusline.ts. globalThis[Symbol.for(...)] is the only cross-extension
// channel (the codebase uses it for Symbol.for("codeflare.activeRepo") /
// Symbol.for("codeflare.reviewRepo"), the prCache, and the autostart signals).
// reviewRepo = the repo THIS session is
// reviewing (review-enforcement remembers it whenever a ctx-bearing handler
// resolves the repo; the no-ctx reaper and the footer recall it). activeRepo =
// the repo the USER is working in (codeflare-pi remembers it on every command
// that resolves a git root). Display + the activeRepo rung of resolveReviewRepo
// read these; review ROUTING precedence stays in resolveReviewRepo unchanged.
const ACTIVE_REPO_KEY = Symbol.for("codeflare.activeRepo");
const REVIEW_REPO_KEY = Symbol.for("codeflare.reviewRepo");

// REVIEW_REPO_KEY is the LAST-pinned review repo (used by the footer and single-repo callers).
// REVIEW_REPOS_KEY accumulates the SET of every repo this session armed/reconciled a review for, so the
// no-ctx reaper can finalize ALL of them, not just the last one (P6) — otherwise a second repo's review
// hangs unfinalized until the user returns to it.
const REVIEW_REPOS_KEY = Symbol.for("codeflare.reviewRepos");
type CodeflareRepoMemory = { [ACTIVE_REPO_KEY]?: string; [REVIEW_REPO_KEY]?: string; [REVIEW_REPOS_KEY]?: Set<string> };
const repoMemory = globalThis as unknown as CodeflareRepoMemory;

export function rememberReviewRepo(repo: string | undefined): void {
  if (!repo) return;
  repoMemory[REVIEW_REPO_KEY] = repo;
  if (!repoMemory[REVIEW_REPOS_KEY]) repoMemory[REVIEW_REPOS_KEY] = new Set<string>();
  repoMemory[REVIEW_REPOS_KEY]!.add(repo);
}
export function recallReviewRepo(): string | undefined {
  return repoMemory[REVIEW_REPO_KEY];
}
export function recallReviewRepos(): string[] {
  return repoMemory[REVIEW_REPOS_KEY] ? [...repoMemory[REVIEW_REPOS_KEY]!] : [];
}

export function rememberActiveRepo(repo: string | undefined): void {
  if (repo) repoMemory[ACTIVE_REPO_KEY] = repo;
}
export function recallActiveRepo(): string | undefined {
  return repoMemory[ACTIVE_REPO_KEY];
}

// Last-resort display-only fallback for the footer's repo:branch segment: the
// on-disk graphify active-cwd sentinel. It is written by BOTH Claude's hook and
// Pi's codeflare-pi extension, so under concurrent agents it flaps to whichever
// acted last — hence the guards: the value must be a git repo AND live inside one
// of this session's roots (session cwd / ctx cwd), so an unrelated repo touched
// by another agent elsewhere can never hijack this session's footer. Pure so the
// guards are unit-testable; the caller injects file content and the .git check.
export function activeRepoSentinelForDisplay(input: {
  sentinelContent: string | undefined;
  sessionRoots: (string | undefined)[];
  hasGitDir: (path: string) => boolean;
}): string | undefined {
  const value = input.sentinelContent?.trim();
  if (!value || !input.hasGitDir(value)) return undefined;
  const inside = input.sessionRoots.some((root) => {
    if (!root) return false;
    return value === root || value.startsWith(root.endsWith("/") ? root : `${root}/`);
  });
  return inside ? value : undefined;
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
