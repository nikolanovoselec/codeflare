import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ALL_REVIEW_LANES = ["code-reviewer", "spec-reviewer", "doc-updater"] as const;
export type ReviewLane = (typeof ALL_REVIEW_LANES)[number];

export type ReviewBoundaryEvent = "push" | "pr-create" | "pr-edit" | "pr-update-branch" | "pr-merge";
type BoundarySurfaces = {
  reminder: boolean;
  settled: boolean;
  event?: ReviewBoundaryEvent;
  protectedRetarget?: true;
  prTarget?: string;
  repoPath?: string;
  remoteHeadAuthoritative?: true;
};
type LaneFact = {
  state: "missing" | "in-flight" | "terminal";
  toolUseId?: string;
  agentId?: string;
};
export type TranscriptFacts = {
  boundary?: { toolUseId: string; command: string };
  reviewHead?: string;
  reviewRange?: string;
  bypassed: boolean;
  fullyAutonomous: boolean;
  ciLaunched: boolean;
  ciAgentId?: string;
  closedNotified: boolean;
  lanes: Record<ReviewLane, LaneFact>;
};

type ShellWords = string[];

type Heredoc = { delimiter: string; stripTabs: boolean };

function heredocRedirections(line: string): Heredoc[] {
  const found: Heredoc[] = [];
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char !== "<" || line[index + 1] !== "<" || line[index + 2] === "<") continue;

    let cursor = index + 2;
    const stripTabs = line[cursor] === "-";
    if (stripTabs) cursor += 1;
    while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;

    let delimiter = "";
    let delimiterQuote = "";
    while (cursor < line.length) {
      const token = line[cursor] ?? "";
      if (delimiterQuote) {
        if (token === delimiterQuote) delimiterQuote = "";
        else if (token === "\\" && delimiterQuote === '"' && cursor + 1 < line.length) {
          cursor += 1;
          delimiter += line[cursor] ?? "";
        } else delimiter += token;
      } else if (token === "'" || token === '"') delimiterQuote = token;
      else if (token === "\\" && cursor + 1 < line.length) {
        cursor += 1;
        delimiter += line[cursor] ?? "";
      } else if (/\s/.test(token) || ";&|<>".includes(token)) break;
      else delimiter += token;
      cursor += 1;
    }
    if (delimiter) found.push({ delimiter, stripTabs });
    index = cursor - 1;
  }
  return found;
}

function stripHeredocBodies(command: string): string {
  const executable: string[] = [];
  const pending: Heredoc[] = [];
  for (const line of command.split(/\r?\n/)) {
    const heredoc = pending[0];
    if (heredoc) {
      const candidate = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === heredoc.delimiter) pending.shift();
      continue;
    }
    executable.push(line);
    pending.push(...heredocRedirections(line));
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

type CommandEntry = { words: ShellWords; repoPath?: string };

function normalizedWords(segment: string): ShellWords {
  const words = shellWords(segment);
  let index = words[0] === "env" ? 1 : 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(words[index] ?? "")) index += 1;
  return words.slice(index);
}

function gitRepoPath(words: ShellWords): string | undefined {
  if (words[0] !== "git") return undefined;
  let path: string | undefined;
  for (let index = 1; words[index] === "-C" && words[index + 1]; index += 2) path = words[index + 1];
  return path;
}

function commandEntries(command: string): CommandEntry[] {
  const entries: CommandEntry[] = [];
  let repoPath: string | undefined;
  for (const segment of shellSegments(command)) {
    const words = normalizedWords(segment);
    if (words[0] === "cd") {
      const path = words[1] === "--" ? words[2] : words[1];
      if (path) repoPath = path;
      continue;
    }
    const commandRepoPath = gitRepoPath(words) ?? repoPath;
    entries.push({ words, ...(commandRepoPath ? { repoPath: commandRepoPath } : {}) });
  }
  return entries;
}

function gitSubcommand(words: ShellWords): string | undefined {
  if (words[0] !== "git") return undefined;
  let index = 1;
  while (words[index] === "-C" && words[index + 1]) index += 2;
  return words[index];
}

function optionValue(words: ShellWords, names: readonly string[]): string | undefined {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    const inline = names.find((name) => word.startsWith(`${name}=`));
    if (inline) return word.slice(inline.length + 1);
    if (names.includes(word) && words[index + 1]) return words[index + 1];
  }
  return undefined;
}

function explicitPushTarget(words: ShellWords): string | undefined {
  const pushIndex = words.indexOf("push");
  if (pushIndex < 0) return undefined;
  const optionsWithValues = new Set(["--exec", "--receive-pack", "--repo", "--push-option", "-o"]);
  const positionals: string[] = [];
  for (let index = pushIndex + 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (optionsWithValues.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith("-")) continue;
    positionals.push(word);
  }
  const advancingTargets = positionals.slice(1).flatMap((refspec) => {
    const normalized = refspec.replace(/^\+/, "");
    const separator = normalized.indexOf(":");
    if (separator <= 0) return [];
    const destination = normalized.slice(separator + 1).replace(/^refs\/heads\//, "");
    return destination ? [destination] : [];
  });
  return advancingTargets.length === 1 ? advancingTargets[0] : undefined;
}

function protectedEdit(words: ShellWords): boolean {
  if (words[0] !== "gh" || words[1] !== "pr" || words[2] !== "edit") return false;
  return words.some((word, index) =>
    ["--base=main", "--base=master", "-B=main", "-B=master"].includes(word)
    || (["--base", "-B"].includes(word) && ["main", "master"].includes(words[index + 1] ?? "")),
  );
}

function updateBranchTarget(words: ShellWords): { supported: boolean; prTarget?: string } {
  const args = words.slice(3);
  if (args.some((word) => word === "--repo" || word.startsWith("--repo=") || word.startsWith("-R"))) {
    return { supported: false };
  }
  const prTarget = args.find((word) => !word.startsWith("-"));
  if (prTarget && /^https?:\/\//i.test(prTarget)) return { supported: false };
  return { supported: true, ...(prTarget ? { prTarget } : {}) };
}

export function classifyReviewBoundaryCommand(command: string): BoundarySurfaces {
  let reminder = false;
  let settled = false;
  let protectedRetarget = false;
  let event: ReviewBoundaryEvent | undefined;
  let prTarget: string | undefined;
  let repoPath: string | undefined;
  let remoteHeadAuthoritative = false;
  for (const entry of commandEntries(command)) {
    const { words } = entry;
    if (gitSubcommand(words) === "push") {
      reminder = settled = true;
      event = "push";
      repoPath = entry.repoPath;
      prTarget = explicitPushTarget(words);
      remoteHeadAuthoritative = Boolean(prTarget);
    }
    if (words[0] === "gh" && words[1] === "pr" && words[2] === "create") {
      reminder = settled = true;
      event = "pr-create";
      repoPath = entry.repoPath;
      prTarget = optionValue(words, ["--head", "-H"]);
      remoteHeadAuthoritative = Boolean(prTarget);
    }
    if (protectedEdit(words)) {
      reminder = settled = true;
      protectedRetarget = true;
      event = "pr-edit";
      repoPath = entry.repoPath;
      prTarget = undefined;
      remoteHeadAuthoritative = false;
    }
    if (words[0] === "gh" && words[1] === "pr" && words[2] === "update-branch") {
      const target = updateBranchTarget(words);
      if (target.supported) {
        reminder = settled = true;
        event = "pr-update-branch";
        repoPath = entry.repoPath;
        prTarget = target.prTarget;
        remoteHeadAuthoritative = true;
      }
    }
    if (words[0] === "gh" && words[1] === "pr" && words[2] === "merge") {
      settled = true;
      event = "pr-merge";
      repoPath = entry.repoPath;
      prTarget = undefined;
      remoteHeadAuthoritative = false;
    }
  }
  return {
    reminder,
    settled,
    ...(event ? { event } : {}),
    ...(protectedRetarget ? { protectedRetarget: true as const } : {}),
    ...(prTarget ? { prTarget } : {}),
    ...(repoPath ? { repoPath } : {}),
    ...(remoteHeadAuthoritative ? { remoteHeadAuthoritative: true as const } : {}),
  };
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

function nativeNotification(entry: Record<string, any>): { toolUseId: string; succeeded: boolean } | undefined {
  if (entry.type !== "custom_message" || entry.customType !== "subagent-notification" || typeof entry.content !== "string") return undefined;
  const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(entry.content)?.[1];
  if (!toolUseId) return undefined;
  const status = /<status>([^<]+)<\/status>/.exec(entry.content)?.[1]?.trim() ?? "";
  return { toolUseId, succeeded: /^(?:Done|Completed)$/i.test(status) };
}

type ServiceDispatch = {
  agentId: string;
  kind: "reviewer" | "ci";
  head: string;
  range?: string;
  lane?: ReviewLane;
};

type ServiceRecord = { id: string; status: string };

function serviceDispatch(entry: Record<string, any>): ServiceDispatch | undefined {
  if (entry.type !== "custom" || entry.customType !== "codeflare:subagent-dispatch") return undefined;
  const data = entry.data;
  if (!data || typeof data !== "object"
    || typeof data.agentId !== "string"
    || !data.agentId
    || !["reviewer", "ci"].includes(data.kind)
    || !fullSha(data.head)) return undefined;
  if (data.kind === "reviewer" && !ALL_REVIEW_LANES.includes(data.lane)) return undefined;
  return {
    agentId: data.agentId,
    kind: data.kind,
    head: data.head,
    range: typeof data.range === "string" ? data.range : undefined,
    lane: data.lane,
  };
}

function serviceRecord(entry: Record<string, any>): ServiceRecord | undefined {
  if (entry.type !== "custom" || entry.customType !== "subagents:record") return undefined;
  const data = entry.data;
  return data && typeof data.id === "string" && typeof data.status === "string"
    ? { id: data.id, status: data.status }
    : undefined;
}

function fullyAutonomousOverride(entries: Record<string, any>[]): boolean {
  return entries.reduce((active, entry) => {
    const text = userText(entry);
    if (!text) return active;
    if (/\b(?:CANCEL|STOP) FULLY AUTONOMOUS\b/.test(text)) return false;
    return /\bFULLY AUTONOMOUS\b/.test(text);
  }, false);
}

function reviewWindow(entry: Record<string, any>): { head?: string; range?: string } | undefined {
  if (entry.type === "custom" && entry.customType === "codeflare:review-window") {
    const head = typeof entry.data?.head === "string" ? entry.data.head : undefined;
    const range = typeof entry.data?.reviewRange === "string" ? entry.data.reviewRange : undefined;
    return { head, range };
  }
  if (entry.type !== "custom_message" || ![
    "pr-boundary-launch-plan",
    "pr-boundary-launch-follow-up",
    "pr-boundary-review-reminder",
    "pr-boundary-review-follow-up",
  ].includes(entry.customType)) return undefined;
  const head = typeof entry.details?.head === "string" ? entry.details.head : undefined;
  const range = typeof entry.details?.reviewRange === "string" ? entry.details.reviewRange : undefined;
  return { head, range };
}

export function reviewTranscriptFacts(input: {
  sessionFile: string;
  requiredLanes: ReviewLane[];
  ciHead?: string;
}): TranscriptFacts {
  const entries = readEntries(input.sessionFile);
  const fullyAutonomous = fullyAutonomousOverride(entries);
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
  if (boundaryIndex < 0) return {
    bypassed: false,
    fullyAutonomous,
    ciLaunched: false,
    closedNotified: false,
    lanes,
  };
  const later = entries.slice(boundaryIndex + 1);
  const window = later.reduce<{ head?: string; range?: string } | undefined>((current, entry) => reviewWindow(entry) ?? current, undefined);
  const serviceRecords = new Map<string, ServiceRecord>();
  for (const entry of later) {
    const record = serviceRecord(entry);
    if (record) serviceRecords.set(record.id, record);
  }
  for (const dispatch of later.map(serviceDispatch).filter((candidate): candidate is ServiceDispatch => Boolean(candidate))) {
    if (dispatch.kind !== "reviewer"
      || !dispatch.lane
      || !input.requiredLanes.includes(dispatch.lane)
      || dispatch.head !== window?.head
      || dispatch.range !== window?.range) continue;
    const record = serviceRecords.get(dispatch.agentId);
    if (record && (record.status === "completed" || record.status === "steered")) {
      lanes[dispatch.lane] = { state: "terminal", agentId: dispatch.agentId };
    } else if ((!record || record.status === "queued" || record.status === "running")
      && lanes[dispatch.lane].state !== "terminal") {
      lanes[dispatch.lane] = { state: "in-flight", agentId: dispatch.agentId };
    } else if (lanes[dispatch.lane].state !== "terminal") {
      lanes[dispatch.lane] = { state: "missing" };
    }
  }
  later.forEach((entry, entryIndex) => {
    for (const call of toolCalls(entry)) {
      const lane = call.arguments?.subagent_type as ReviewLane;
      const prompt = typeof call.arguments?.prompt === "string" ? call.arguments.prompt : "";
      const wrongRange = window?.range && !prompt.includes(`review_range=${window.range}`);
      if (call.name !== "subagent" || call.arguments?.run_in_background !== true || call.arguments?.inherit_context !== false || !input.requiredLanes.includes(lane) || wrongRange) continue;
      const notifications = later.slice(entryIndex + 1)
        .map(nativeNotification)
        .filter((candidate) => candidate?.toolUseId === call.id);
      const terminal = notifications.some((candidate) => candidate?.succeeded === true);
      const failed = notifications.some((candidate) => candidate?.succeeded === false);
      if (terminal) lanes[lane] = { state: "terminal", toolUseId: call.id };
      else if (failed && lanes[lane].state !== "terminal") lanes[lane] = { state: "missing" };
      else if (lanes[lane].state !== "terminal") lanes[lane] = { state: "in-flight", toolUseId: call.id };
    }
  });
  const matchingCiDispatch = input.ciHead
    ? later.reduce<ServiceDispatch | undefined>((current, entry) => {
      const dispatch = serviceDispatch(entry);
      return dispatch?.kind === "ci" && dispatch.head === input.ciHead ? dispatch : current;
    }, undefined)
    : undefined;
  const ciLaunched = Boolean(input.ciHead && later.some((entry) => {
    const dispatch = serviceDispatch(entry);
    if (dispatch?.kind === "ci" && dispatch.head === input.ciHead) return true;
    if (entry.type === "custom" && entry.customType === "codeflare:ci-resolution" && entry.data?.head === input.ciHead) return true;
    return toolCalls(entry).some((call) => {
      const prompt = typeof call.arguments?.prompt === "string" ? call.arguments.prompt : "";
      return call.name === "subagent"
        && call.arguments?.subagent_type === "ci-monitor"
        && call.arguments?.run_in_background === true
        && call.arguments?.inherit_context === false
        && prompt.split(/\s+/).includes(`head=${input.ciHead}`);
    });
  }));
  const bypassed = later.some((entry) => /\bskip (?:the )?(?:review|verification)\b/i.test(userText(entry)));
  const closedNotified = later.some((entry) =>
    entry.type === "custom_message" && entry.customType === "pr-boundary-review-closed-unacknowledged",
  );
  return {
    boundary,
    reviewHead: window?.head,
    reviewRange: window?.range,
    bypassed,
    fullyAutonomous,
    ciLaunched,
    ciAgentId: matchingCiDispatch?.agentId,
    closedNotified,
    lanes,
  };
}

export default function () {}
