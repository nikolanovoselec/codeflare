import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ACTIVE_REPO_FILE = "/home/user/.cache/codeflare-hooks/graphify-active-cwd";
const CACHE_TTL_MS = 1_000;

type Cache<T> = {
  value: T;
  checkedAt: number;
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
    usage?.tokens !== null && usage?.contextWindow
      ? (usage.tokens / usage.contextWindow) * 100
      : undefined
  );
  return Number.isFinite(percent) ? `${Math.round(percent as number)}%` : "--%";
}

function truncateToWidth(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + "…";
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

      return {
        dispose: unsubscribe,
        invalidate() {
          cached = undefined;
        },
        render(width: number): string[] {
          const now = Date.now();
          if (!cached || now - cached.checkedAt > CACHE_TTL_MS) {
            cached = { value: renderLine(ctx, pi.getThinkingLevel()), checkedAt: now };
          }
          const statuses = Array.from(footerData.getExtensionStatuses().values()).filter(Boolean);
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
