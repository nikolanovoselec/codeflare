import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { recallActiveRepo } from "./active-repo-memory";

const CACHE_TTL_MS = 1_000;

type ExtensionContext = {
  mode: string;
  cwd: string;
  hasUI: boolean;
  sessionManager: { getCwd(): string };
  ui: { setStatus(key: string, value: string | undefined): void };
};

type ExtensionAPI = {
  on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void): void;
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

// Shared with codeflare-pi.ts (which owns the writes); read here only as the
// guarded display-only last resort in repositoryLabel.
const ACTIVE_REPO_SENTINEL = "/home/user/.cache/codeflare-hooks/graphify-active-cwd";

function sentinelRepoForDisplay(ctx: ExtensionContext): string | undefined {
  let content: string | undefined;
  try {
    content = readFileSync(ACTIVE_REPO_SENTINEL, "utf8");
  } catch {
    return undefined;
  }
  const value = content.trim();
  if (!value || !existsSync(join(value, ".git"))) return undefined;
  const insideSessionRoot = [ctx.sessionManager.getCwd(), ctx.cwd].some((root) =>
    Boolean(root) && (value === root || value.startsWith(root.endsWith("/") ? root : `${root}/`)),
  );
  return insideSessionRoot ? value : undefined;
}

function repositoryLabel(ctx: ExtensionContext): string | undefined {
  // The cwd git roots miss whenever the session cwd is a non-repo parent
  // workspace and work happens in a nested repo via `git -C` / `cd repo &&`.
  // Fall back to the repo codeflare-pi last resolved in this process, then the
  // guarded display-only sentinel.
  const repo = findGitRoot(ctx.sessionManager.getCwd()) ?? findGitRoot(ctx.cwd)
    ?? recallActiveRepo() ?? sentinelRepoForDisplay(ctx);
  if (!repo) return undefined;

  const branch = gitOutput(repo, ["branch", "--show-current"])
    ?? gitOutput(repo, ["rev-parse", "--short", "HEAD"])
    ?? "detached";
  return `${basename(repo)}:${branch}`;
}

export default function (pi: ExtensionAPI) {
  let current: ExtensionContext | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;

  function refreshStatus(): void {
    if (!current) return;
    let text: string | undefined;
    try { text = repositoryLabel(current); } catch { /* Cosmetic metadata is optional. */ }
    current.ui.setStatus("codeflare-session", text);
  }

  function stop(): void {
    if (interval) clearInterval(interval);
    interval = undefined;
    current?.ui.setStatus("codeflare-session", undefined);
    current = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    stop();
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    current = ctx;
    refreshStatus();
    interval = setInterval(refreshStatus, CACHE_TTL_MS);
    interval.unref?.();
  });
  pi.on("session_shutdown", stop);

  const refresh = (_event: unknown, ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    current = ctx;
    refreshStatus();
  };
  pi.on("resources_discover", refresh);
  pi.on("turn_start", refresh);
  pi.on("turn_end", refresh);
  pi.on("tool_execution_end", refresh);
  pi.on("model_select", refresh);
  pi.on("thinking_level_select", refresh);
}
