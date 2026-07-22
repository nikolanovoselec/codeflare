import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { effectiveCwdForCommand } from "./graphify-helpers";
import { shellSegments } from "./review-helpers";

const ACTIVE_REPO_KEY = Symbol.for("codeflare.activeRepo");

type ActiveRepoMemory = typeof globalThis & {
  [ACTIVE_REPO_KEY]?: string;
};

const activeRepoMemory = globalThis as ActiveRepoMemory;

export function rememberActiveRepo(repo: string | undefined): void {
  if (repo) activeRepoMemory[ACTIVE_REPO_KEY] = repo;
}

export function recallActiveRepo(): string | undefined {
  return activeRepoMemory[ACTIVE_REPO_KEY];
}

export function findGitRoot(startDir: string): string | undefined {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function unquoteShellToken(value: string): string {
  return value.trim().replace(/^("|')(.*)\1$/, "$2");
}

function effectivePath(command: string, cwd: string): string {
  const gitC = command.match(/(?:^|[;&|\n]\s*)git\s+-C\s+("[^"]+"|'[^']+'|[^\s;&|\n]+)/);
  if (gitC?.[1]) return resolve(cwd, unquoteShellToken(gitC[1]));
  return resolve(effectiveCwdForCommand(command, cwd));
}

export type ShellInvocation = { command: string; cwd: string };

function commandInvocations(command: string, cwd: string): ShellInvocation[] {
  let effectiveCwd = cwd;
  return shellSegments(command).map((segment) => {
    const cd = /^cd(?:\s+--)?\s+(.+)$/.exec(segment);
    if (cd?.[1]) effectiveCwd = resolve(effectiveCwd, unquoteShellToken(cd[1]));
    return { command: segment, cwd: effectiveCwd };
  });
}

export function shellInvocations(event: any, sessionCwd: string): ShellInvocation[] {
  const input = event?.input ?? event?.args;
  const name = String(event?.toolName ?? "");
  if (!input || typeof input !== "object") return [];
  const cwd = typeof input.cwd === "string" ? resolve(sessionCwd, input.cwd) : sessionCwd;
  if ((name === "bash" || name === "Bash") && typeof input.command === "string") {
    return commandInvocations(input.command, cwd);
  }
  if (name.endsWith("ctx_execute") && input.language === "shell" && typeof input.code === "string") {
    return commandInvocations(input.code, cwd);
  }
  if (name.endsWith("ctx_batch_execute") && Array.isArray(input.commands)) {
    return input.commands
      .map((item: Record<string, unknown>) => item?.command)
      .filter((command: unknown): command is string => typeof command === "string")
      .flatMap((command: string) => commandInvocations(command, cwd));
  }
  return [];
}

export function resolveShellInvocationRepo(invocation: ShellInvocation): string | undefined {
  return findGitRoot(effectivePath(invocation.command, invocation.cwd));
}

export function rememberActiveRepoFromToolResult(event: any, sessionCwd: string): string | undefined {
  if (event?.isError === true || event?.result?.isError === true) return undefined;
  let remembered: string | undefined;
  for (const invocation of shellInvocations(event, sessionCwd)) {
    const repo = resolveShellInvocationRepo(invocation);
    if (!repo) continue;
    rememberActiveRepo(repo);
    remembered = repo;
  }
  return remembered;
}

export default function activeRepoMemoryExtension(pi: ExtensionAPI): void {
  pi.on("tool_result", (event: any, ctx: any) => {
    rememberActiveRepoFromToolResult(event, ctx.cwd);
  });
}
