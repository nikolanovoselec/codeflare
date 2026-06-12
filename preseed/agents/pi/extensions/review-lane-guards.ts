/**
 * Minimal guard extension for detached PR-boundary review lanes.
 *
 * Lanes run with `--no-extensions` so they cannot load the full Codeflare runtime
 * (especially review-enforcement), but they still expose `bash` for git/gh
 * inspection. Keep local-build/test/lint/dev-server and AI-attribution blockers
 * without loading recursive review machinery. The review lane intentionally ignores
 * the main-session local-build bypass sentinel: headless reviewers are never allowed
 * to consume a user override intended for an interactive session.
 */
import { attributionBlockReason, localBuildBlockReason } from "./guard-helpers";
import { commandTextFromEvent } from "./review-helpers";

type ExtensionAPI = { on(event: string, handler: (event: unknown) => unknown): void };

function toolEventId(event: unknown): string | undefined {
  const record = event as { toolCallId?: unknown; toolUseId?: unknown; id?: unknown } | undefined;
  const id = record?.toolCallId ?? record?.toolUseId ?? record?.id;
  return typeof id === "string" ? id : undefined;
}

export function reviewLaneBlockReason(command: string): string | undefined {
  const attributionReason = attributionBlockReason(command);
  if (attributionReason) return attributionReason;
  return localBuildBlockReason(command, {
    existsSync: () => false,
    unlinkSync: () => undefined,
  });
}

type ReviewScope = { base?: string; head?: string; baseRef?: string };

/**
 * When a review lane runs in incremental mode — a prior clean head was acked, so
 * CODEFLARE_REVIEW_BASE names it — the lane must review ONLY base..head, never the
 * full PR diff. The shared agent/skill prompts already instruct this; this guard makes
 * it binding so a reviewer cannot fall back to a full-PR diff and re-review the whole
 * PR every round. Allows the window forms (`git diff <base> <head>`, a bare
 * `<base>..<head>` SHA range, `--name-only`, `-- <path>`); blocks the full-PR forms
 * (`gh pr diff`, and a `git diff` ranging two- or three-dot against the base branch —
 * `origin/<ref>`, the base ref, or main/master/develop). With no base set (first
 * review), nothing is blocked.
 */
export function reviewScopeBlockReason(command: string, scope: ReviewScope): string | undefined {
  if (!scope.base) return undefined;
  const windowCmd = `git diff ${scope.base} ${scope.head ?? "HEAD"}`;
  if (/\bgh\s+pr\s+diff\b/.test(command)) {
    return `Full-PR diff is blocked in incremental review mode — review only the window (${windowCmd}), not the whole PR.`;
  }
  // A `git diff` that ranges (two- OR three-dot) against the base branch — `origin/<ref>`,
  // the base ref itself, or main/master/develop — is a full-PR diff. The window form ranges
  // between the acked base SHA and the head SHA, so it never matches these branch endpoints
  // (and a bare SHA range like `<base>..<head>` stays allowed). `\.\.` catches both `..` and `...`.
  if (/\bgit\s+diff\b/.test(command)) {
    const baseRef = scope.baseRef ? scope.baseRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
    const fullPrRange = new RegExp(`\\b(?:origin/[^\\s.]+|${baseRef ? `${baseRef}|` : ""}main|master|develop)\\.\\.`);
    if (fullPrRange.test(command)) {
      return `Full-PR diff is blocked in incremental review mode — review only the window (${windowCmd}), not the full PR diff against ${scope.baseRef ?? "the base branch"}.`;
    }
  }
  return undefined;
}

function scopeFromEnv(): ReviewScope {
  return {
    base: process.env.CODEFLARE_REVIEW_BASE || undefined,
    head: process.env.CODEFLARE_REVIEW_HEAD || undefined,
    baseRef: process.env.CODEFLARE_REVIEW_BASE_REF || undefined,
  };
}

function guardTool(event: unknown): { block: true; reason: string } | undefined {
  const command = commandTextFromEvent(event);
  if (!command) return undefined;
  const reason = reviewLaneBlockReason(command) ?? reviewScopeBlockReason(command, scopeFromEnv());
  return reason ? { block: true, reason } : undefined;
}

export default function (pi: ExtensionAPI) {
  const gatedToolIds = new Set<string>();
  const runOnce = (event: unknown): { block: true; reason: string } | undefined => {
    const id = toolEventId(event);
    if (id && gatedToolIds.has(id)) return undefined;
    if (id) gatedToolIds.add(id);
    return guardTool(event);
  };
  pi.on("tool_call", runOnce);
  pi.on("tool_execution_start", runOnce);
}
