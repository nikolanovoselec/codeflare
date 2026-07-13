import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ALL_REVIEW_LANES = ["code-reviewer", "spec-reviewer", "doc-updater"] as const;
export type ReviewLane = (typeof ALL_REVIEW_LANES)[number];

type BoundarySurfaces = { reminder: boolean; settled: boolean };
type LaneFact = { state: "missing" | "in-flight" | "terminal"; toolUseId?: string };
export type TranscriptFacts = {
  boundary?: { toolUseId: string; command: string };
  reviewHead?: string;
  reviewRange?: string;
  bypassed: boolean;
  closedNotified: boolean;
  lanes: Record<ReviewLane, LaneFact>;
};

type ShellWords = string[];

function stripHeredocBodies(command: string): string {
  const executable: string[] = [];
  let delimiter = "";
  let stripTabs = false;
  for (const line of command.split(/\r?\n/)) {
    if (delimiter) {
      const candidate = stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === delimiter) delimiter = "";
      continue;
    }
    executable.push(line);
    const match = line.match(/<<(-?)\s*(['"]?)([A-Za-z0-9_]+)\2/);
    if (match) {
      stripTabs = match[1] === "-";
      delimiter = match[3] ?? "";
    }
  }
  return executable.join("\n");
}

function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of stripHeredocBodies(command)) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
    } else if ((char === "'" || char === '"') && !quote) {
      current += char;
      quote = char;
    } else if (char === quote) {
      current += char;
      quote = "";
    } else if (!quote && ";&|\n\r".includes(char)) {
      if (current.trim()) segments.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function shellWords(segment: string): ShellWords {
  const words: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of segment) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if ((char === "'" || char === '"') && !quote) {
      quote = char;
    } else if (char === quote) {
      quote = "";
    } else if (!quote && /\s/.test(char)) {
      if (current) words.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) words.push(current);
  return words;
}

function commandWords(command: string): ShellWords[] {
  return shellSegments(command).map(shellWords).map((words) => {
    let index = words[0] === "env" ? 1 : 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(words[index] ?? "")) index += 1;
    return words.slice(index);
  });
}

function protectedEdit(words: ShellWords): boolean {
  if (words[0] !== "gh" || words[1] !== "pr" || words[2] !== "edit") return false;
  return words.some((word, index) =>
    ["--base=main", "--base=master", "-B=main", "-B=master"].includes(word)
    || (["--base", "-B"].includes(word) && ["main", "master"].includes(words[index + 1] ?? "")),
  );
}

export function classifyReviewBoundaryCommand(command: string): BoundarySurfaces {
  let reminder = false;
  let settled = false;
  for (const words of commandWords(command)) {
    if (words[0] === "git" && words[1] === "push") reminder = settled = true;
    if (words[0] === "gh" && words[1] === "pr" && words[2] === "create") reminder = true;
    if (protectedEdit(words)) reminder = settled = true;
    if (words[0] === "gh" && words[1] === "pr" && words[2] === "merge") settled = true;
  }
  return { reminder, settled };
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find(existsSync);
}

export function isReviewTransitionSuspended(repo: string): boolean {
  const nested = existsSync(join(repo, "sdd/spec/config.yml"));
  const config = nested ? join(repo, "sdd/spec/config.yml") : join(repo, "sdd/config.yml");
  const triage = firstExisting(nested
    ? [join(repo, "sdd/spec/.init-triage.md"), join(repo, "sdd/spec/.review-queue.md")]
    : [join(repo, "sdd/.init-triage.md"), join(repo, "sdd/.review-needed.md")]);
  if (!existsSync(config) || !triage) return false;
  const transition = /^transition:\s*true\s*$/mi.test(readFileSync(config, "utf8"));
  const open = /^\*\*Status:\*\*\s*open\b/mi.test(readFileSync(triage, "utf8"));
  return transition && open;
}

function fullSha(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{40}$/.test(value));
}

function reviewLanesForFiles(files: string[]): ReviewLane[] {
  let source = false;
  let spec = false;
  let docs = false;
  for (const file of files) {
    if (file.startsWith("graphify-out/")) continue;
    if (file.startsWith("sdd/")) spec = true;
    else if (file.startsWith("documentation/") || /^(README|CHANGELOG|CONTRIBUTING|SECURITY)\.md$/.test(file)) docs = true;
    else source = true;
  }
  if (source) return [...ALL_REVIEW_LANES];
  if (spec) return ["spec-reviewer", "doc-updater"];
  if (docs) return ["doc-updater"];
  return [];
}

export function reviewRange(input: { repo: string; ackHead?: string; head: string }): string | undefined {
  if (!fullSha(input.ackHead) || !fullSha(input.head) || input.ackHead === input.head) return undefined;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", input.ackHead, input.head], {
      cwd: input.repo,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return `${input.ackHead}..${input.head}`;
  } catch {
    return undefined;
  }
}

export function requiredReviewLanes(input: { repo: string; ackHead?: string; head: string }): ReviewLane[] {
  if (input.ackHead === input.head && fullSha(input.head)) return [];
  const range = reviewRange(input);
  if (!range) return [...ALL_REVIEW_LANES];
  try {
    const output = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", range],
      { cwd: input.repo, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] },
    );
    const files = output.toString("utf8").split("\0").filter(Boolean);
    return files.length === 0 ? [...ALL_REVIEW_LANES] : reviewLanesForFiles(files);
  } catch {
    return [...ALL_REVIEW_LANES];
  }
}

function readEntries(sessionFile: string): Record<string, any>[] {
  try {
    return readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function toolCalls(entry: Record<string, any>): Array<Record<string, any>> {
  if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) return [];
  return entry.message.content.filter((part: Record<string, any>) => part?.type === "toolCall");
}

function shellCommands(call: Record<string, any>): string[] {
  const name = String(call.name ?? "");
  const args = call.arguments ?? {};
  if ((name === "bash" || name === "Bash") && typeof args.command === "string") return [args.command];
  if (name.endsWith("ctx_execute") && args.language === "shell" && typeof args.code === "string") return [args.code];
  if (name.endsWith("ctx_batch_execute") && Array.isArray(args.commands)) {
    return args.commands.map((item: Record<string, any>) => item?.command).filter((value: unknown): value is string => typeof value === "string");
  }
  return [];
}

function userText(entry: Record<string, any>): string {
  if (entry.type !== "message" || entry.message?.role !== "user") return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => part.text).join("\n") : "";
}

function notificationToolId(entry: Record<string, any>): string | undefined {
  if (entry.type !== "custom_message" || entry.customType !== "subagent-notification" || typeof entry.content !== "string") return undefined;
  return /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(entry.content)?.[1];
}

function reviewWindow(entry: Record<string, any>): { head?: string; range?: string } | undefined {
  if (entry.type !== "custom_message" || !["pr-boundary-review-reminder", "pr-boundary-review-follow-up"].includes(entry.customType)) return undefined;
  const head = typeof entry.details?.head === "string" ? entry.details.head : undefined;
  const range = typeof entry.details?.reviewRange === "string" ? entry.details.reviewRange : undefined;
  return { head, range };
}

export function reviewTranscriptFacts(input: {
  sessionFile: string;
  requiredLanes: ReviewLane[];
}): TranscriptFacts {
  const entries = readEntries(input.sessionFile);
  const successfulToolIds = new Set(entries
    .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.isError !== true)
    .map((entry) => entry.message.toolCallId));
  let boundaryIndex = -1;
  let boundary: TranscriptFacts["boundary"];
  entries.forEach((entry, index) => {
    for (const call of toolCalls(entry)) {
      for (const command of shellCommands(call)) {
        if (successfulToolIds.has(call.id) && classifyReviewBoundaryCommand(command).settled) {
          boundaryIndex = index;
          boundary = { toolUseId: call.id, command };
        }
      }
    }
  });

  const lanes = Object.fromEntries(ALL_REVIEW_LANES.map((lane) => [lane, { state: "missing" }])) as Record<ReviewLane, LaneFact>;
  if (boundaryIndex < 0) return { bypassed: false, closedNotified: false, lanes };
  const later = entries.slice(boundaryIndex + 1);
  const window = later.reduce<{ head?: string; range?: string } | undefined>((current, entry) => reviewWindow(entry) ?? current, undefined);
  later.forEach((entry, entryIndex) => {
    for (const call of toolCalls(entry)) {
      const lane = call.arguments?.subagent_type as ReviewLane;
      const prompt = typeof call.arguments?.prompt === "string" ? call.arguments.prompt : "";
      const wrongRange = window?.range && !prompt.includes(`review_range=${window.range}`);
      if (call.name !== "subagent" || call.arguments?.run_in_background !== true || call.arguments?.inherit_context !== false || !input.requiredLanes.includes(lane) || wrongRange) continue;
      const terminal = later.slice(entryIndex + 1).some((candidate) => notificationToolId(candidate) === call.id);
      if (terminal) lanes[lane] = { state: "terminal", toolUseId: call.id };
      else if (lanes[lane].state !== "terminal") lanes[lane] = { state: "in-flight", toolUseId: call.id };
    }
  });
  const bypassed = later.some((entry) => /\bskip (?:the )?(?:review|verification)\b/i.test(userText(entry)));
  const closedNotified = later.some((entry) =>
    entry.type === "custom_message" && entry.customType === "pr-boundary-review-closed-unacknowledged",
  );
  return { boundary, reviewHead: window?.head, reviewRange: window?.range, bypassed, closedNotified, lanes };
}

export default function () {}
