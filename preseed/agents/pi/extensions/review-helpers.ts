export const ALL_REVIEW_LANES = ["code-reviewer", "spec-reviewer", "doc-updater"];

type ShellCommand = string[];

function splitShellCommands(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | "" = "";
  let escaped = false;
  let parenDepth = 0;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      current += char;
      continue;
    }
    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      current += char;
      continue;
    }
    if (char === quote) {
      quote = "";
      current += char;
      continue;
    }
    if (!quote && char === "(" && command[index - 1] === "$") {
      parenDepth += 1;
      current += char;
      continue;
    }
    if (!quote && char === ")" && parenDepth > 0) {
      parenDepth -= 1;
      current += char;
      continue;
    }
    if (!quote && parenDepth === 0 && (char === ";" || char === "\n" || char === "|" || char === "&")) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      if ((char === "|" && next === "|") || (char === "&" && next === "&")) index += 1;
      continue;
    }
    current += char;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | "" = "";
  let escaped = false;

  for (const char of segment) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = "";
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) words.push(current);
  return words;
}

function reviewBoundaryCommands(command: string): ShellCommand[] {
  return splitShellCommands(command)
    .map(shellWords)
    .filter((words) => words.length > 0);
}

function gitCwd(words: ShellCommand): string | undefined {
  if (words[0] !== "git") return undefined;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === "-C") return words[index + 1];
    if (word.startsWith("-C") && word.length > 2) return word.slice(2);
    if (!word.startsWith("-")) return undefined;
  }
  return undefined;
}

function gitArgs(words: ShellCommand): ShellCommand | undefined {
  if (words[0] !== "git") return undefined;
  let index = 1;
  while (index < words.length) {
    const word = words[index];
    if (word === "-C") {
      index += 2;
      continue;
    }
    if (word.startsWith("-C") && word.length > 2) {
      index += 1;
      continue;
    }
    break;
  }
  return words.slice(index);
}

function isBoundaryWords(words: ShellCommand): boolean {
  const git = gitArgs(words);
  if (git?.[0] === "push") return true;
  if (words[0] !== "gh") return false;
  if (words[1] === "repo" && words[2] === "sync") return true;
  return words[1] === "pr" && ["create", "merge", "update-branch"].includes(words[2]);
}

function prCreateWords(command: string): ShellCommand | undefined {
  return reviewBoundaryCommands(command).find((words) => words[0] === "gh" && words[1] === "pr" && words[2] === "create");
}

export function cwdFromBoundaryCommand(command: string): string | undefined {
  let lastCd: string | undefined;
  for (const words of reviewBoundaryCommands(command)) {
    if (words[0] === "cd" && words[1]) {
      lastCd = words[1];
      continue;
    }
    const cwd = gitCwd(words);
    if (cwd) return cwd;
    if (isBoundaryWords(words)) return lastCd;
  }
  return undefined;
}

export function isGhPrCreateCommand(command: string): boolean {
  return Boolean(prCreateWords(command));
}

export function ghPrCreateBase(command: string): string | undefined {
  const words = prCreateWords(command);
  if (!words) return undefined;
  for (let index = 3; index < words.length; index += 1) {
    const word = words[index];
    if ((word === "--base" || word === "-B") && words[index + 1]) return words[index + 1];
    if (word.startsWith("--base=")) return word.slice("--base=".length);
    if (word.startsWith("-B=") && word.length > 3) return word.slice(3);
  }
  return undefined;
}

export function prCreateBoundaryBase(command: string, knownBase?: string): string | undefined {
  if (!isGhPrCreateCommand(command)) return undefined;
  const base = ghPrCreateBase(command) || knownBase || "";
  if (base && base !== "main" && base !== "master") return undefined;
  return base || "main";
}

export function isPrBoundaryCommand(command: string): boolean {
  return reviewBoundaryCommands(command).some(isBoundaryWords);
}

function isGitPushWords(words: ShellCommand): boolean {
  return gitArgs(words)?.[0] === "push";
}

function isGhRepoSyncWords(words: ShellCommand): boolean {
  return words[0] === "gh" && words[1] === "repo" && words[2] === "sync";
}

function isGhPrUpdateBranchWords(words: ShellCommand): boolean {
  return words[0] === "gh" && words[1] === "pr" && words[2] === "update-branch";
}

// THE single PR-boundary trigger predicate (review.md §17.5). A real boundary is a
// git push / gh repo sync, a gh pr update-branch, or a gh pr create targeting
// main/master. `gh pr merge` is deliberately NOT a trigger: it is the merge gate
// (handled separately), so merging never arms a fresh review of the head being
// merged. Use this for "should this command start a review?"; isPrBoundaryCommand
// stays the low-level word matcher used to pluck a command out of a tool event.
export function isPrBoundaryTrigger(command: string): boolean {
  if (prCreateBoundaryBase(command)) return true;
  return reviewBoundaryCommands(command).some(
    (words) => isGitPushWords(words) || isGhRepoSyncWords(words) || isGhPrUpdateBranchWords(words),
  );
}

export function commandTextFromEvent(event: any): string {
  const inputs = [event?.input, event?.params, event?.args, event?.arguments, event?.toolCall?.arguments, event?.toolCall?.input, event?.toolCall?.params];
  const commands: string[] = [];
  for (const input of inputs) {
    if (!input || typeof input !== "object") continue;
    if (typeof input.command === "string") commands.push(input.command);
    if (typeof input.code === "string") commands.push(input.code);
    if (typeof input.script === "string") commands.push(input.script);
    if (Array.isArray(input.commands)) commands.push(...input.commands.map((cmd: any) => String(cmd?.command || cmd?.code || cmd || "")));
  }
  return commands.find(isPrBoundaryCommand) || commands.find((command) => command.trim()) || "";
}

export function isFailedToolExecution(event: any): boolean {
  return event?.isError === true || event?.error === true || String(event?.status ?? "").toLowerCase() === "error";
}

export type ReviewHeadStatus = "current" | "advanced" | "stale" | "unknown";

export function bypassAckHeadForStatus(params: { status: ReviewHeadStatus; pendingHead: string; currentHead?: string }): string | undefined {
  if (params.status === "current") return params.pendingHead;
  if (params.status === "advanced") return params.currentHead || undefined;
  return undefined;
}

// Decide whether a pending review window still applies to the live PR head.
// Critically separates a PR that has definitively moved on / closed ("stale",
// safe to discard) from a PR state we could not read because `gh` failed
// ("unknown"). A transient `gh pr view` failure must never be mistaken for a
// stale head, because discarding pending state without an ack drops the merge
// gate and leaves a reviewed head un-acked (see documentation/decisions/README.md AD64).
export function classifyReviewHead(params: {
  pendingHead: string;
  localHead: string | undefined;
  prOpenAtBase: boolean;
  prHead: string | undefined;
  prQueryFailed: boolean;
  localHeadDescendsFromPending?: boolean;
  prHeadDescendsFromPending?: boolean;
}): ReviewHeadStatus {
  if (params.localHead === params.pendingHead) return "current";
  if (params.prQueryFailed) return "unknown";
  if (params.prOpenAtBase) {
    if (params.prHead === params.pendingHead) return "current";
    if (params.prHead) return params.prHeadDescendsFromPending ? "advanced" : "stale";
    if (params.localHead && params.localHeadDescendsFromPending) return "advanced";
  }
  return "stale";
}

export type ReviewSpawnRequest = {
  lane: string;
  prompt: string;
  description: string;
};

export function extractBackgroundAgentId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, any>;
  const direct = record.details?.agentId || record.agentId;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const textParts: string[] = [];
  const collectText = (value: unknown): void => {
    if (typeof value === "string") textParts.push(value);
    else if (Array.isArray(value)) value.forEach(collectText);
    else if (value && typeof value === "object") {
      const maybeText = (value as Record<string, unknown>).text;
      if (typeof maybeText === "string") textParts.push(maybeText);
    }
  };
  collectText(record.content);
  collectText(record.result);
  collectText(record.output);
  const match = textParts.join("\n").match(
    /Agent ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-(?:[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{3,4}))\b/i,
  );
  return match?.[1];
}

export function createBoundedOnceTracker(limit = 200): (id: string | undefined) => boolean {
  const seen = new Set<string>();
  const order: string[] = [];
  return (id: string | undefined): boolean => {
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    order.push(id);
    while (order.length > limit) {
      const stale = order.shift();
      if (stale) seen.delete(stale);
    }
    return true;
  };
}

export function createReadyOnceTracker(limit = 200): (id: string | undefined, ready: boolean) => boolean {
  const shouldProcess = createBoundedOnceTracker(limit);
  return (id: string | undefined, ready: boolean): boolean => {
    if (!ready) return false;
    return shouldProcess(id);
  };
}

export function reusablePendingReview<T extends { head: string }>(previous: T | undefined, currentHead: string, isAncestor: (ancestor: string, current: string) => boolean): T | undefined {
  if (!previous || previous.head === currentHead) return previous;
  return isAncestor(previous.head, currentHead) ? previous : undefined;
}

export function selectReviewBase(params: {
  previous?: { head: string; reviewBase?: string; lanes: string[]; completed: string[] };
  lastAck?: string;
  previousRemoteHead?: string;
}): string | undefined {
  const priorIncomplete = params.previous?.lanes.some((lane) => !params.previous?.completed.includes(lane));
  if (priorIncomplete) return params.previous?.reviewBase;
  // A remote-tracking reflog entry is only an optimization hint, not proof that
  // everything before it was reviewed. If no explicit ack or completed previous
  // review exists, return undefined so the next review covers the full PR diff.
  return params.previous?.head || params.lastAck;
}

export function classifyReviewFiles(files: string[] | undefined): string[] | undefined {
  if (files === undefined) return ALL_REVIEW_LANES;
  if (files.length === 0) return [];
  let hasBehavioral = false;
  let touchesSdd = false;
  let touchesDocs = false;
  for (const file of files) {
    if (file.startsWith("sdd/")) touchesSdd = true;
    else if (file.startsWith("documentation/") || ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "LICENSE"].includes(file)) touchesDocs = true;
    else hasBehavioral = true;
  }
  if (hasBehavioral) return ALL_REVIEW_LANES;
  if (touchesSdd) return ["spec-reviewer", "doc-updater"];
  if (touchesDocs) return ["doc-updater"];
  return [];
}

export default function () {
  // Helper module for review-enforcement.ts; no extension registration needed.
}
