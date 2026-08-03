import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ALL_REVIEW_LANES = ["code-reviewer", "spec-reviewer", "doc-updater"] as const;
export const REVIEW_TRIAGE_HEADER = "| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |";
export const REVIEW_TRIAGE_DIVIDER = "|---|---|---|---|---|";
export type ReviewLane = (typeof ALL_REVIEW_LANES)[number];

export type ReviewBoundaryEvent = "push" | "pr-create" | "pr-merge";
type BoundarySurfaces = {
  reminder: boolean;
  settled: boolean;
  event?: ReviewBoundaryEvent;
  pushSource?: string;
  pushTarget?: string;
  pushRemote?: string;
  mergeSelector?: string;
};
type LaneFact = { state: "missing" | "in-flight" | "terminal"; toolUseId?: string };
export type TranscriptFacts = {
  boundary?: {
    toolUseId: string;
    command: string;
    toolName: string;
    toolArguments: Record<string, unknown>;
  };
  reviewHead?: string;
  reviewRange?: string;
  reviewRepo?: string;
  reviewBranch?: string;
  reviewPrNumber?: number;
  reviewBase?: "main" | "master" | "develop";
  reviewBoundaryToolUseId?: string;
  bypassed: boolean;
  ciLaunched: boolean;
  triageComplete: boolean;
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

export type ShellSeparator = "&&" | "||" | "|" | "&" | ";" | "\n";
export type ExecutableShellSegment = {
  command: string;
  separatorBefore?: ShellSeparator;
  separatorAfter?: ShellSeparator;
};

export function executableShellSegments(command: string): ExecutableShellSegment[] {
  const segments: ExecutableShellSegment[] = [];
  const source = stripHeredocBodies(command);
  let current = "";
  let quote = "";
  let escaped = false;
  let separatorBefore: ShellSeparator | undefined;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if ((char === "'" || char === '"') && !quote) {
      current += char;
      quote = char;
      continue;
    }
    if (char === quote) {
      current += char;
      quote = "";
      continue;
    }
    if (!quote && ";&|\n\r".includes(char)) {
      let separator: ShellSeparator;
      if ((char === "&" || char === "|") && source[index + 1] === char) {
        separator = char === "&" ? "&&" : "||";
        index += 1;
      } else if (char === "\n" || char === "\r") {
        separator = "\n";
        if (char === "\r" && source[index + 1] === "\n") index += 1;
      } else {
        separator = char as ShellSeparator;
      }
      if (current.trim()) {
        segments.push({ command: current.trim(), separatorBefore, separatorAfter: separator });
        current = "";
        separatorBefore = separator;
      }
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push({ command: current.trim(), separatorBefore });
  return segments;
}

export function shellSegments(command: string): string[] {
  return executableShellSegments(command).map((segment) => segment.command);
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

function gitSubcommandIndex(words: ShellWords): number | undefined {
  if (words[0] !== "git") return undefined;
  let index = 1;
  while (words[index] === "-C" && words[index + 1]) index += 2;
  return index < words.length ? index : undefined;
}

function gitSubcommand(words: ShellWords): string | undefined {
  const index = gitSubcommandIndex(words);
  return index === undefined ? undefined : words[index];
}

const PUSH_OPTIONS_WITH_VALUE = new Set(["--exec", "--push-option", "--receive-pack", "-o"]);
const UNSUPPORTED_PUSH_OPTIONS = new Set([
  "--all", "--delete", "--dry-run", "--follow-tags", "--mirror", "--prune", "--tags", "-d", "-n",
]);

function branchRef(value: string): string | undefined {
  if (!value || value === "HEAD") return undefined;
  if (value.startsWith("refs/heads/")) return value.slice("refs/heads/".length) || undefined;
  if (value.startsWith("refs/") || value.includes("*") || value.startsWith(":")) return undefined;
  return value;
}

function pushBoundary(words: ShellWords): { source?: string; target?: string; remote?: string } | undefined {
  const subcommandIndex = gitSubcommandIndex(words);
  if (subcommandIndex === undefined || words[subcommandIndex] !== "push") return undefined;
  const positionals: string[] = [];
  const args = words.slice(subcommandIndex + 1);
  let optionRemote: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (UNSUPPORTED_PUSH_OPTIONS.has(arg)
      || /^-[^-]*[dn]/.test(arg)
      || [...UNSUPPORTED_PUSH_OPTIONS].some((option) => arg.startsWith(`${option}=`))) {
      return undefined;
    }
    if (arg === "--repo") {
      optionRemote = args[index + 1];
      if (!optionRemote) return undefined;
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      optionRemote = arg.slice("--repo=".length) || undefined;
      if (!optionRemote) return undefined;
      continue;
    }
    if (PUSH_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("-")) continue;
    positionals.push(arg);
  }
  const remote = optionRemote ?? positionals[0];
  const refspecs = optionRemote ? positionals : positionals.slice(1);
  if (refspecs.length === 0) return remote ? { remote } : {};
  if (refspecs.length !== 1) return undefined;
  const refspec = refspecs[0] ?? "";
  if (refspec === "HEAD") return remote ? { remote } : {};
  const normalizedRefspec = refspec.startsWith("+") ? refspec.slice(1) : refspec;
  if (!normalizedRefspec || normalizedRefspec.startsWith(":")) return undefined;
  const separator = normalizedRefspec.indexOf(":");
  const sourceRaw = separator === -1 ? normalizedRefspec : normalizedRefspec.slice(0, separator);
  const targetRaw = separator === -1 ? normalizedRefspec : normalizedRefspec.slice(separator + 1);
  if (!sourceRaw || !targetRaw || targetRaw === "HEAD") return undefined;
  const sourceBranch = sourceRaw === "HEAD" ? undefined : branchRef(sourceRaw);
  const source = sourceRaw === "HEAD"
    ? "HEAD"
    : sourceBranch
      ? `refs/heads/${sourceBranch}`
      : undefined;
  const target = branchRef(targetRaw);
  if (!source || !target) return undefined;
  return { source, target };
}

const GH_PR_MERGE_OPTIONS_WITH_VALUE = new Set([
  "--author-email", "-A", "--body", "-b", "--body-file", "-F",
  "--match-head-commit", "--subject", "-t",
]);

function prMergeSelector(words: ShellWords): string | undefined | false {
  let selector: string | undefined;
  for (let index = 3; index < words.length; index += 1) {
    const arg = words[index] ?? "";
    if (arg === "--auto" || arg === "--disable-auto"
      || arg === "--repo" || arg.startsWith("-R") || arg.startsWith("--repo=")) return false;
    if (GH_PR_MERGE_OPTIONS_WITH_VALUE.has(arg)) {
      if (!words[index + 1]) return false;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (selector) return false;
    selector = arg;
  }
  return selector;
}

export function classifyReviewBoundaryCommand(command: string): BoundarySurfaces {
  let boundary: BoundarySurfaces = { reminder: false, settled: false };
  for (const words of commandWords(command)) {
    if (gitSubcommand(words) === "push") {
      const push = pushBoundary(words);
      if (push) {
        boundary = {
          reminder: true,
          settled: true,
          event: "push",
          ...(push.source ? { pushSource: push.source } : {}),
          ...(push.target ? { pushTarget: push.target } : {}),
          ...(!push.target && push.remote ? { pushRemote: push.remote } : {}),
        };
      }
    }
    if (words[0] === "gh" && words[1] === "pr" && words[2] === "create") {
      boundary = { reminder: true, settled: true, event: "pr-create" };
    }
    if (words[0] === "gh" && words[1] === "pr" && words[2] === "merge") {
      const mergeSelector = prMergeSelector(words);
      if (mergeSelector !== false) {
        boundary = {
          reminder: true,
          settled: true,
          event: "pr-merge",
          ...(mergeSelector ? { mergeSelector } : {}),
        };
      }
    }
  }
  return boundary;
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

/**
 * The comment/whitespace prover, seeded from the canonical Claude tree and
 * reaching Pi byte-identically through the standard transform. Both runtimes
 * shell out to this one program rather than carrying a scanner each, because
 * two hand-kept copies of a JavaScript lexer cannot stay in agreement.
 */
const INERT_SOURCE_PROVER = join(homedir(), ".pi", "agent", "skills", "review-scope", "scripts", "inert-source-delta.mjs");

/**
 * True only when every behavioural path in the range provably differs by
 * comments and whitespace alone. Every failure is a false: a missing prover, a
 * missing runtime, an added or deleted or renamed file, an ineligible
 * extension, an unparseable construct. The reduction is one-directional, so
 * doubt always costs a lane rather than saving one.
 */
export function inertSourceDelta(input: {
  repo: string;
  base: string;
  head: string;
  files: string[];
  prover?: string;
}): boolean {
  const prover = input.prover ?? INERT_SOURCE_PROVER;
  if (input.files.length === 0 || !existsSync(prover)) return false;
  try {
    // The prover must SAY it proved something; a zero exit alone is not a
    // proof, because a run that decided nothing also exits zero.
    const proof = execFileSync("node", [prover, input.base, input.head], {
      cwd: input.repo,
      input: input.files.join("\0"),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    // PROOF_TOKEN in skills/review-scope/scripts/inert-source-delta.mjs is the
    // source of truth for this literal; review-helpers.test.ts spawns the real
    // prover, so a rename there fails here rather than silently reading false.
    return proof.trim() === "INERT";
  } catch {
    return false;
  }
}

const isGeneratedPath = (file: string) => file.startsWith("graphify-out/");
const isSpecPath = (file: string) => file.startsWith("sdd/");
const isDocPath = (file: string) =>
  file.startsWith("documentation/") || /^(README|CHANGELOG|CONTRIBUTING|SECURITY)\.md$|^LICENSE$/.test(file);

/** The paths whose content decides the code lane -- the prover's input set. */
function behaviouralPaths(files: string[]): string[] {
  return files.filter((file) => !isGeneratedPath(file) && !isSpecPath(file) && !isDocPath(file));
}

// Does any `@impl` anchor under `tree` cite one of these changed files? That is
// the only route by which a source-only change can invalidate something in the
// spec or documentation tree, and it is the first check those lanes run. Answer
// it with grep and the lane costs nothing when the answer is no; answer it by
// spawning the agent and it costs a full startup to be told the same thing.
// Mirrors anchor_cites_changed in the Claude lane classifier; REQ-AGENT-040 AC7
// requires both runtimes to decide a range identically.
export function anchorCitesChanged(repo: string, tree: string, files: string[]): boolean {
  if (files.length === 0 || !existsSync(join(repo, tree))) return false;
  for (const file of files) {
    if (!file) continue;
    try {
      execFileSync("grep", ["-rqlF", "--", `@impl: ${file}`, tree], {
        cwd: repo,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return true;
    } catch {
      // grep exits non-zero for "no match"; keep scanning the remaining files.
    }
  }
  return false;
}

function reviewLanesForFiles(
  files: string[],
  inertSource = false,
  anchors: { spec: boolean; docs: boolean } = { spec: false, docs: false },
): ReviewLane[] {
  let source = false;
  let spec = false;
  let docs = false;
  for (const file of files) {
    if (isGeneratedPath(file)) continue;
    if (isSpecPath(file)) spec = true;
    else if (isDocPath(file)) docs = true;
    else source = true;
  }
  // A proven-inert source delta contributes the code lane alone -- whether the
  // new comment is TRUE is still a code-review question, and a directive
  // comment still changes behaviour -- while the spec and documentation
  // surfaces provably cannot have drifted. Any lane the same diff independently
  // earns is still added, in canonical order.
  if (source && !inertSource) {
    // A behavioural change always owes the code lane, and owes the other two
    // only where they have something to check: their own surface changed, or
    // one of their anchors cites a file in this diff. Demanding all three
    // unconditionally bought two agent startups that found no lane-owned file
    // and exited.
    const lanes: ReviewLane[] = ["code-reviewer"];
    let wantsDocs = docs;
    if (spec || anchors.spec) {
      lanes.push("spec-reviewer");
      if (spec) wantsDocs = true;
    }
    if (wantsDocs || anchors.docs) lanes.push("doc-updater");
    return lanes;
  }
  const lanes: ReviewLane[] = source ? ["code-reviewer"] : [];
  if (spec) lanes.push("spec-reviewer", "doc-updater");
  else if (docs) lanes.push("doc-updater");
  return lanes;
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

// Lane-specific and deliberately not unified: spec-reviewer counts a subject
// that CONTAINS its tags, doc-updater one that STARTS WITH them. That asymmetry
// is what each lane document says, and collapsing it here would silently change
// when a limit fires. Mirrors ROUND_RULES in the Claude lane-triage; REQ-AGENT-040
// AC7 requires both runtimes to decide a range identically.
const ROUND_RULES: Record<string, { tags: string[]; match: (subject: string, tag: string) => boolean; tree: string }> = {
  "spec-reviewer": {
    tags: ["[autonomous]", "[unleashed]", "[spec-reviewer]"],
    match: (subject, tag) => subject.includes(tag),
    tree: "sdd/",
  },
  "doc-updater": {
    tags: ["[doc-updater]", "[autonomous]", "[unleashed]"],
    match: (subject, tag) => subject.startsWith(tag),
    tree: "documentation/",
  },
};
const BULK_PREFIXES = ["[sdd-init]", "[sdd-clean]", "[sdd-triage]"];
const RS = "\x1e";

/**
 * True when this lane has already been round-tripped five times, which its own
 * document defines as a no-op. Answering it from git costs nothing; answering it
 * by spawning the agent buys a full startup to be told the same thing. Every
 * failure returns false, so doubt costs a lane rather than skipping a review.
 */
export function roundLimitReached(repo: string, lane: ReviewLane): boolean {
  const rule = ROUND_RULES[lane];
  if (!rule) return false;
  let raw = "";
  try {
    raw = execFileSync("git", ["log", "-6", `--format=${RS}%H %s`, "--name-only"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return false;
  }
  let counted = 0;
  for (const record of raw.split(RS)) {
    if (!record.trim()) continue;
    const [header, ...fileLines] = record.split("\n");
    const subject = header.slice(header.indexOf(" ") + 1).trim();
    if (BULK_PREFIXES.some((prefix) => subject.startsWith(prefix))) continue;
    if (!rule.tags.some((tag) => rule.match(subject, tag))) continue;
    if (!fileLines.some((file) => file.trim().startsWith(rule.tree))) continue;
    counted += 1;
  }
  return counted >= 5;
}

export function requiredReviewLanes(
  // `prover` overrides the seeded prover path; production passes nothing.
  input: { repo: string; ackHead?: string; head: string; prover?: string },
): ReviewLane[] {
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
    if (files.length === 0) return [...ALL_REVIEW_LANES];
    const [base, head] = range.split("..");
    const behavioural = behaviouralPaths(files);
    const inertSource = inertSourceDelta({ repo: input.repo, base, head, files: behavioural, prover: input.prover });
    const lanes = reviewLanesForFiles(files, inertSource, {
      spec: anchorCitesChanged(input.repo, "sdd", behavioural),
      docs: anchorCitesChanged(input.repo, "documentation", behavioural),
    });
    return lanes.filter((lane) => !roundLimitReached(input.repo, lane));
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

function messageContentText(entry: Record<string, any>): string {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => part.text).join("\n") : "";
}

function messageText(entry: Record<string, any>, role: "assistant" | "user"): string {
  return entry.type === "message" && entry.message?.role === role ? messageContentText(entry) : "";
}

function userText(entry: Record<string, any>): string {
  return messageText(entry, "user");
}

function nativeNotification(entry: Record<string, any>): { toolUseId: string; succeeded: boolean } | undefined {
  if (entry.type !== "custom_message" || entry.customType !== "subagent-notification" || typeof entry.content !== "string") return undefined;
  const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(entry.content)?.[1];
  if (!toolUseId) return undefined;
  const status = /<status>([^<]+)<\/status>/.exec(entry.content)?.[1]?.trim() ?? "";
  return { toolUseId, succeeded: /^(?:Done|Completed)$/i.test(status) };
}

type ReviewWindow = {
  head?: string;
  range?: string;
  repo?: string;
  branch?: string;
  prNumber?: number;
  base?: "main" | "master" | "develop";
  boundaryToolUseId?: string;
};

function reviewWindow(entry: Record<string, any>): ReviewWindow | undefined {
  if (entry.type !== "custom_message" || ![
    "pr-boundary-launch-plan",
    "pr-boundary-launch-follow-up",
    "pr-boundary-review-reminder",
    "pr-boundary-review-follow-up",
  ].includes(entry.customType)) return undefined;
  const head = typeof entry.details?.head === "string" ? entry.details.head : undefined;
  const range = typeof entry.details?.reviewRange === "string" ? entry.details.reviewRange : undefined;
  const repo = typeof entry.details?.repo === "string" ? entry.details.repo : undefined;
  const branch = typeof entry.details?.branch === "string" ? entry.details.branch : undefined;
  const prNumber = Number.isInteger(entry.details?.prNumber) ? entry.details.prNumber : undefined;
  const base = entry.details?.base === "main"
    || entry.details?.base === "master"
    || entry.details?.base === "develop"
    ? entry.details.base
    : undefined;
  const boundaryToolUseId = typeof entry.details?.boundaryToolUseId === "string"
    ? entry.details.boundaryToolUseId
    : undefined;
  return { head, range, repo, branch, prNumber, base, boundaryToolUseId };
}

export function reviewTranscriptFacts(input: {
  sessionFile: string;
  entries?: Record<string, any>[];
  requiredLanes: ReviewLane[];
  ciHead?: string;
}): TranscriptFacts {
  const entries = input.entries ?? readEntries(input.sessionFile);
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
          boundary = {
            toolUseId: call.id,
            command,
            toolName: String(call.name ?? ""),
            toolArguments: call.arguments && typeof call.arguments === "object" ? call.arguments : {},
          };
        }
      }
    }
  });

  const lanes = Object.fromEntries(ALL_REVIEW_LANES.map((lane) => [lane, { state: "missing" }])) as Record<ReviewLane, LaneFact>;
  if (boundaryIndex < 0) return { bypassed: false, ciLaunched: false, triageComplete: false, closedNotified: false, lanes };
  const later = entries.slice(boundaryIndex + 1);
  const terminalIndexes = new Map<ReviewLane, number>();
  const resultRequests = new Map<string, string>();
  for (const entry of later) {
    for (const call of toolCalls(entry)) {
      if (call.name === "get_subagent_result" && typeof call.arguments?.agent_id === "string") {
        resultRequests.set(call.id, call.arguments.agent_id);
      }
    }
  }
  const completedAgents = new Map<string, { lane: ReviewLane; index: number }>();
  later.forEach((entry, index) => {
    if (entry.type !== "message"
      || entry.message?.role !== "toolResult"
      || entry.message?.toolName !== "get_subagent_result"
      || entry.message?.isError === true) return;
    const requestedAgent = resultRequests.get(entry.message.toolCallId);
    const text = messageContentText(entry);
    const returnedAgent = /^Agent:\s*([^\r\n]+)$/mi.exec(text)?.[1]?.trim();
    const result = /^Type:\s*([^|\r\n]+)\s*\|\s*Status:\s*(completed|done)\b/mi.exec(text);
    const lane = result?.[1]?.trim() as ReviewLane | undefined;
    if (requestedAgent
      && returnedAgent === requestedAgent
      && lane
      && ALL_REVIEW_LANES.includes(lane)
      && !completedAgents.has(requestedAgent)) {
      completedAgents.set(requestedAgent, { lane, index });
    }
  });
  const window = later.reduce<ReviewWindow | undefined>((current, entry) => {
    const candidate = reviewWindow(entry);
    if (!candidate) return current;
    if (candidate.boundaryToolUseId && candidate.boundaryToolUseId !== boundary?.toolUseId) return current;
    return candidate;
  }, undefined);
  later.forEach((entry, entryIndex) => {
    for (const call of toolCalls(entry)) {
      const lane = call.arguments?.subagent_type as ReviewLane;
      const prompt = typeof call.arguments?.prompt === "string" ? call.arguments.prompt : "";
      const wrongRange = window?.range && !prompt.includes(`review_range=${window.range}`);
      if (call.name !== "subagent" || call.arguments?.run_in_background !== true || call.arguments?.inherit_context !== false || !input.requiredLanes.includes(lane) || wrongRange) continue;
      const notifications = later.slice(entryIndex + 1)
        .map((candidate, offset) => ({ value: nativeNotification(candidate), index: entryIndex + offset + 1 }))
        .filter((candidate) => candidate.value?.toolUseId === call.id);
      const nativeTerminal = notifications.find((candidate) => candidate.value?.succeeded === true);
      const launchResult = later.find((candidate) => candidate.type === "message"
        && candidate.message?.role === "toolResult"
        && candidate.message?.toolCallId === call.id
        && candidate.message?.toolName === "subagent"
        && candidate.message?.isError !== true
        && candidate.message?.details?.subagentType === lane);
      const launchedAgent = typeof launchResult?.message?.details?.agentId === "string"
        ? launchResult.message.details.agentId
        : undefined;
      const publicTerminal = launchedAgent && completedAgents.get(launchedAgent)?.lane === lane
        ? completedAgents.get(launchedAgent)
        : undefined;
      const nativeIndex = nativeTerminal?.index;
      const publicIndex = publicTerminal?.index;
      const terminalIndex = nativeIndex === undefined
        ? publicIndex ?? -1
        : publicIndex === undefined ? nativeIndex : Math.min(nativeIndex, publicIndex);
      const failed = notifications.some((candidate) => candidate.value?.succeeded === false);
      if (terminalIndex >= 0) {
        lanes[lane] = { state: "terminal", toolUseId: call.id };
        const previousTerminal = terminalIndexes.get(lane);
        terminalIndexes.set(lane, previousTerminal === undefined
          ? terminalIndex
          : Math.min(previousTerminal, terminalIndex));
      } else if (failed && lanes[lane].state !== "terminal") lanes[lane] = { state: "missing" };
      else if (lanes[lane].state !== "terminal") lanes[lane] = { state: "in-flight", toolUseId: call.id };
    }
  });
  const allRequiredTerminal = input.requiredLanes.length > 0
    && input.requiredLanes.every((lane) => terminalIndexes.has(lane));
  const latestRequiredTerminalIndex = allRequiredTerminal
    ? Math.max(...input.requiredLanes.map((lane) => terminalIndexes.get(lane)!))
    : undefined;
  const triageComplete = latestRequiredTerminalIndex !== undefined && later.some((entry, index) =>
    index > latestRequiredTerminalIndex
    && toolCalls(entry).length === 0
    && messageText(entry, "assistant").split("\n").some((line, lineIndex, lines) =>
      line.trim() === REVIEW_TRIAGE_HEADER && lines[lineIndex + 1]?.trim() === REVIEW_TRIAGE_DIVIDER,
    ),
  );
  const ciLaunched = Boolean(input.ciHead && later.some((entry) => toolCalls(entry).some((call) => {
    const prompt = typeof call.arguments?.prompt === "string" ? call.arguments.prompt : "";
    return call.name === "subagent"
      && call.arguments?.subagent_type === "ci-monitor"
      && call.arguments?.run_in_background === true
      && call.arguments?.inherit_context === false
      && prompt.split(/\s+/).includes(`head=${input.ciHead}`);
  })));
  const bypassed = later.some((entry) => /\bskip (?:the )?(?:review|verification)\b/i.test(userText(entry)));
  const closedNotified = later.some((entry) =>
    entry.type === "custom_message" && entry.customType === "pr-boundary-review-closed-unacknowledged",
  );
  return {
    boundary,
    reviewHead: window?.head,
    reviewRange: window?.range,
    reviewRepo: window?.repo,
    reviewBranch: window?.branch,
    reviewPrNumber: window?.prNumber,
    reviewBase: window?.base,
    reviewBoundaryToolUseId: window?.boundaryToolUseId,
    bypassed,
    ciLaunched,
    triageComplete,
    closedNotified,
    lanes,
  };
}

export default function () {}
