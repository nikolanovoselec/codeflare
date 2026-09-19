import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { effectiveCwdForCommand } from "./graphify-helpers";
import { executableShellSegments } from "./review-helpers";
import { executableShellCommands, shellCommandExecutable } from "./guard-helpers.js";

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

function supportedLeadingGitCPath(command: string): string | undefined {
  const match = /^git\s+-C\s+(?:"([^"$`()]+)"|'([^'$`()]+)'|([^\s;&|"'$`()]+))(?=\s|$)/.exec(command);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function effectivePath(command: string, cwd: string): string {
  const gitC = supportedLeadingGitCPath(command);
  if (gitC) return resolve(cwd, gitC);
  return resolve(effectiveCwdForCommand(command, cwd));
}

export type ShellInvocation = { command: string; cwd: string; certain: boolean };

type LiteralPathBindings = Map<string, string | undefined>;

function expandLiteralGitC(command: string, bindings: LiteralPathBindings): string {
  return command.replace(/^(git\s+-C\s+)"\$([A-Za-z_][A-Za-z0-9_]*)"(?=\s|$)/, (_match, prefix, name) => {
    const value = bindings.get(name);
    return value ? `${prefix}${JSON.stringify(value)}` : _match;
  });
}

function literalPathAssignment(command: string): { name: string; value: string } | undefined {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(\/[A-Za-z0-9._/@%+=,:~-]+)$/.exec(command);
  return match ? { name: match[1]!, value: match[2]! } : undefined;
}

function bindingMutation(command: string): string | undefined {
  return /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(command)?.[1];
}

function supportedStraightLineSegment(command: string): boolean {
  if (literalPathAssignment(command)) return true;
  if (/`|\$\{|\$\(\(/.test(command)) return false;
  const allowed = new Set(["set", "git", "grep", "sed", "test", "[", "awk"]);
  const commands = executableShellCommands(command);
  const supported = commands.length > 0 && commands.every((words) => {
    const executable = shellCommandExecutable(words);
    return executable !== undefined && allowed.has(executable);
  });
  // A bracket assertion runs substitutions in a child shell and cannot rebind
  // the preceding literal path. Keep that binding only when every parsed
  // command is already in the read-only straight-line allowlist.
  if (/\$\(/.test(command) && !/^\[\s+"\$\(.+\)"\s+=\s+[^\s]+\s+\]$/.test(command)) return false;
  return supported;
}

function hasUnsupportedScope(command: string): boolean {
  return /(?:^|[;&|\n]\s*)[({]|\)\s*\{/.test(command);
}

function hasUnresolvedGitCExpression(command: string): boolean {
  const rawPath = /\bgit\b[\s\S]*?\s-C\s+("[^"\n]*"|'[^'\n]*'|[^\s;&|\n]+)/.exec(command)?.[1];
  if (rawPath && /[$`()]/.test(rawPath)) return true;
  // effectivePath intentionally resolves only an unwrapped leading `git -C`.
  // Reject other explicit forms rather than validating one path and using cwd.
  if (rawPath && !/^git\s+-C\s+/.test(command)) return true;
  for (const words of executableShellCommands(command)) {
    const gitIndex = words.findIndex((word, index) => word === "git"
      && shellCommandExecutable(words.slice(0, index + 1)) === "git");
    if (gitIndex < 0) continue;
    const paths: string[] = [];
    for (let index = gitIndex + 1; index < words.length; index += 1) {
      const value = words[index] ?? "";
      if (value === "--") break;
      if (value === "-C") {
        const path = words[++index];
        if (typeof path !== "string") return true;
        paths.push(path);
        continue;
      }
      if (value.startsWith("-C") && value.length > 2) paths.push(value.slice(2));
      if (!value.startsWith("-")) break;
      if (["-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path", "--super-prefix"].includes(value)) index += 1;
    }
    if (paths.length > 1) return true;
    if (paths.length === 1 && !supportedLeadingGitCPath(command)) return true;
    if (paths.some((path) => /[$`()]/.test(path))) return true;
  }
  return false;
}

function commandInvocations(command: string, cwd: string): ShellInvocation[] {
  let effectiveCwd = cwd;
  let cwdCertain = true;
  let errexit = false;
  const bindings: LiteralPathBindings = new Map();
  let scopeUnsafe = hasUnsupportedScope(command);
  return executableShellSegments(command).map((segment) => {
    const certain = cwdCertain && segment.separatorBefore !== "||";
    if (!supportedStraightLineSegment(segment.command)) scopeUnsafe = true;
    const invocation = {
      command: scopeUnsafe ? segment.command : expandLiteralGitC(segment.command, bindings),
      cwd: effectiveCwd,
      certain,
    };
    const parentShell = segment.separatorBefore !== "|"
      && segment.separatorBefore !== "&"
      && segment.separatorAfter !== "|"
      && segment.separatorAfter !== "&";
    if (invocation.certain && parentShell && /^set(?:\s|$)/.test(segment.command)) {
      const words = segment.command.split(/\s+/).slice(1);
      for (let index = 0; index < words.length; index += 1) {
        const word = words[index] ?? "";
        if (word === "--") break;
        if (word === "+e" || (word === "+o" && words[index + 1] === "errexit")) errexit = false;
        if ((word.startsWith("-") && !word.startsWith("--") && word.includes("e"))
          || (word === "-o" && words[index + 1] === "errexit")) errexit = true;
      }
    }

    if (scopeUnsafe) bindings.clear();
    const assignment = literalPathAssignment(segment.command);
    const assignedName = bindingMutation(segment.command);
    if (assignedName) {
      // Only one preceding absolute literal assignment is expanded. Any other
      // assignment or rebinding makes the variable ambiguous rather than
      // selecting a repository.
      const trusted = assignment && !scopeUnsafe && certain && parentShell && !bindings.has(assignment.name);
      bindings.set(assignedName, trusted ? assignment.value : undefined);
    }

    const cd = /^cd(?:\s+--)?\s+(.+)$/.exec(segment.command);
    if (!cd?.[1]) return invocation;
    if (!invocation.certain) {
      cwdCertain = false;
      return invocation;
    }

    const target = unquoteShellToken(cd[1]);
    const failClosedSequence = errexit
      && (segment.separatorAfter === ";" || segment.separatorAfter === "\n");
    if (segment.separatorAfter === "&&" || failClosedSequence) {
      if (cwdCertain || isAbsolute(target)) {
        effectiveCwd = resolve(effectiveCwd, target);
        cwdCertain = true;
      }
    } else if (segment.separatorAfter !== "|" && segment.separatorAfter !== "&") {
      cwdCertain = false;
    }
    return invocation;
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
  if (!invocation.certain || hasUnresolvedGitCExpression(invocation.command)) return undefined;
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
