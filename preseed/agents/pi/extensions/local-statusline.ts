import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { compactDurableReviewStatus } from "./review-job-helpers";

const ACTIVE_REPO_FILE = "/home/user/.cache/codeflare-hooks/graphify-active-cwd";
const CACHE_TTL_MS = 1_000;

type Cache<T> = {
  value: T;
  checkedAt: number;
};

type ExtensionContext = {
  cwd: string;
  hasUI: boolean;
  model?: { id?: string };
  getContextUsage?: () => { percent?: number; tokens?: number | null; contextWindow?: number } | undefined;
  sessionManager: { getCwd(): string };
  ui: { setFooter(renderer: FooterRendererFactory): void };
};

type ExtensionAPI = {
  getThinkingLevel(): string;
  on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void): void;
};

type FooterRendererFactory = (
  tui: { requestRender(): void },
  theme: { fg(style: string, text: string): string },
  footerData: {
    onBranchChange(handler: () => void): () => void;
    getExtensionStatuses(): Map<string, string>;
  },
) => {
  dispose(): void;
  invalidate(): void;
  render(width: number): string[];
};

function findGitRoot(startDir: string): string | undefined {
  let current = startDir;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function activeRepoFromSentinel(): string | undefined {
  try {
    const repo = readFileSync(ACTIVE_REPO_FILE, "utf8").trim();
    return repo && existsSync(repo) ? repo : undefined;
  } catch {
    return undefined;
  }
}

function gitOutput(repo: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function repositoryLabel(ctx: ExtensionContext): string | undefined {
  const repo = activeRepoFromSentinel() ?? findGitRoot(ctx.sessionManager.getCwd()) ?? findGitRoot(ctx.cwd);
  if (!repo) return undefined;

  const branch = gitOutput(repo, ["branch", "--show-current"])
    ?? gitOutput(repo, ["rev-parse", "--short", "HEAD"])
    ?? "detached";
  return `${basename(repo)}:${branch}`;
}

function contextPercent(ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage?.();
  const percent = usage?.percent ?? (
    typeof usage?.tokens === "number" && usage.contextWindow
      ? (usage.tokens / usage.contextWindow) * 100
      : undefined
  );
  return Number.isFinite(percent) ? `${Math.round(percent as number)}%` : "--%";
}

function visibleWidth(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncateToWidth(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;

  let visible = 0;
  let output = "";
  for (let index = 0; index < text.length && visible < Math.max(0, width - 1);) {
    const ansi = text.slice(index).match(/^\x1b\[[0-9;]*m/);
    if (ansi) {
      output += ansi[0];
      index += ansi[0].length;
      continue;
    }
    output += text[index];
    visible += 1;
    index += 1;
  }
  return `${output}\x1b[0m…`;
}

// Compute the PR-boundary review row FRESH FROM DISK each render. The review-enforcement
// extension can only push its status via ctx.ui.setStatus on a user turn, so a lane advanced
// by the autonomous reaper timer (no ctx) never repaints the footer. Reading the durable job
// here — the footer already re-renders every CACHE_TTL_MS — makes the row reflect disk truth
// (e.g. doc-updater turning yellow) regardless of who advanced it. Returns undefined when no
// review is active or every lane is done, so the row appears only while a review is in flight.
function liveReviewRow(repo: string, theme: { fg(style: string, text: string): string }): string | undefined {
  try {
    const pending = JSON.parse(readFileSync(join(repo, ".git", "sdd-review-pending.json"), "utf8")) as { head?: string; lanes?: string[] };
    const head = pending.head;
    const lanes = pending.lanes;
    if (!head || !lanes || lanes.length === 0) return undefined;
    let laneState: Record<string, { status?: string }> = {};
    try {
      laneState = (JSON.parse(readFileSync(join(repo, ".git", "codeflare-review-jobs", head, "job.json"), "utf8")).laneState) || {};
    } catch {
      // no durable job yet — lanes are all pending
    }
    const completed = lanes.filter((lane) => existsSync(join(repo, ".git", "sdd-review-results", head, `${lane}.md`)) || laneState[lane]?.status === "completed");
    if (completed.length === lanes.length) return undefined; // review finished — clear the row
    const running = lanes.filter((lane) => laneState[lane]?.status === "running");
    return compactDurableReviewStatus({
      head,
      lanes,
      completed,
      running,
      style: {
        done: (label: string) => theme.fg("success", label),
        running: (label: string) => theme.fg("warning", label),
      },
    });
  } catch {
    return undefined;
  }
}

function renderLine(ctx: ExtensionContext, effort: string): string {
  const model = ctx.model?.id ?? "model";
  return [
    contextPercent(ctx),
    `${model}:${effort}`,
    repositoryLabel(ctx),
  ].filter((segment): segment is string => Boolean(segment)).join(" | ");
}

export default function (pi: ExtensionAPI) {
  let cached: Cache<string> | undefined;

  function installFooter(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => {
        cached = undefined;
        tui.requestRender();
      });
      const interval = setInterval(() => tui.requestRender(), CACHE_TTL_MS);

      return {
        dispose() {
          clearInterval(interval);
          unsubscribe();
        },
        invalidate() {
          cached = undefined;
        },
        render(width: number): string[] {
          const now = Date.now();
          if (!cached || now - cached.checkedAt > CACHE_TTL_MS) {
            cached = { value: renderLine(ctx, pi.getThinkingLevel()), checkedAt: now };
          }
          // Take every extension status EXCEPT codeflare-review (that one only refreshes on a
          // user turn); compute the review row fresh from disk so timer-driven lane changes show.
          const statuses = Array.from(footerData.getExtensionStatuses().entries())
            .filter(([key]) => key !== "codeflare-review")
            .map(([, value]) => value)
            .filter(Boolean);
          const repo = activeRepoFromSentinel() ?? findGitRoot(ctx.sessionManager.getCwd()) ?? findGitRoot(ctx.cwd);
          const reviewRow = repo ? liveReviewRow(repo, theme) : undefined;
          if (reviewRow) statuses.push(reviewRow);
          const lines = [theme.fg("dim", truncateToWidth(cached.value, width))];
          if (statuses.length > 0) lines.push(truncateToWidth(statuses.join(" | "), width));
          return lines;
        },
      };
    });
  }

  const refreshFooter = (_event: unknown, ctx: ExtensionContext): void => {
    cached = undefined;
    installFooter(ctx);
  };

  pi.on("session_start", refreshFooter);
  pi.on("resources_discover", refreshFooter);
  pi.on("turn_start", refreshFooter);
  pi.on("turn_end", refreshFooter);
  pi.on("model_select", refreshFooter);
  pi.on("thinking_level_select", refreshFooter);
}
