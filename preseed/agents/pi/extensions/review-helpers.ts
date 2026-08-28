import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { executableShellCommands, shellCommandArguments, shellCommandExecutable } from "./guard-helpers.js";

export const ALL_REVIEW_LANES = ["code-reviewer", "spec-reviewer", "doc-updater"] as const;
export const REVIEW_TRIAGE_HEADER = "| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |";
export const REVIEW_TRIAGE_DIVIDER = "|---|---|---|---|---|";
export type ReviewLane = (typeof ALL_REVIEW_LANES)[number];

export type ReviewBoundaryEvent = "push" | "pr-create";
export type ReviewExposureKind = "clone" | "switch" | "checkout" | "pr-checkout" | "pull" | "push" | "pr-create" | "pr-reopen";
type BoundarySurfaces = {
  reminder: boolean;
  settled: boolean;
  event?: ReviewBoundaryEvent;
  clone?: boolean;
  kind?: ReviewExposureKind;
};
type LaneFact = { state: "missing" | "in-flight" | "terminal"; toolUseId?: string };
export type ReviewLaunchIssue = {
  toolUseId: string;
  target: ReviewLane | "ci-monitor";
  problems: string[];
};
type TranscriptBoundary = {
  toolUseId: string;
  command: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
};
export type TranscriptFacts = {
  boundary?: TranscriptBoundary;
  latestBoundary?: TranscriptBoundary;
  reviewHead?: string;
  reviewRange?: string;
  reviewRepo?: string;
  reviewBranch?: string;
  reviewPrNumber?: number;
  reviewBase?: "main" | "master" | "develop";
  reviewBoundaryToolUseId?: string;
  reviewCiEvent?: ReviewBoundaryEvent;
  reviewRequiredLanes?: ReviewLane[];
  bypassed: boolean;
  ciLaunched: boolean;
  ciRequired: boolean;
  ciTerminal: boolean;
  ciResult?: "success" | "failure" | "timeout";
  triagePresent: boolean;
  triageComplete: boolean;
  fixDelivered: boolean;
  closedNotified: boolean;
  lanes: Record<ReviewLane, LaneFact>;
  launchIssues: ReviewLaunchIssue[];
};

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

export function isReviewMergeCommand(command: string): boolean {
  return executableShellCommands(command).some((words) => {
    const executable = shellCommandExecutable(words);
    if (executable !== "git" && executable !== "gh") return false;
    const args = shellCommandArguments(words, executable);
    return (executable === "git" && args[0] === "merge")
      || (executable === "gh" && args[0] === "pr" && args[1] === "merge");
  });
}

export function classifyReviewBoundaryCommand(command: string): BoundarySurfaces {
  let exposure: BoundarySurfaces = { reminder: false, settled: false };
  for (const words of executableShellCommands(command)) {
    const executable = shellCommandExecutable(words);
    if (executable !== "git" && executable !== "gh") continue;
    const args = shellCommandArguments(words, executable);
    if ((executable === "git" && args[0] === "clone")
      || (executable === "gh" && args[0] === "repo" && args[1] === "clone")) {
      exposure = { reminder: true, settled: true, clone: true, kind: "clone" };
    } else if (executable === "git" && args[0] === "switch"
      && !args.includes("--detach") && !args.includes("-d")) {
      exposure = { reminder: true, settled: true, kind: "switch" };
    } else if (executable === "git" && args[0] === "checkout"
      && !args.includes("--") && !args.includes("--detach")) {
      exposure = { reminder: true, settled: true, kind: "checkout" };
    } else if (executable === "gh" && args[0] === "pr" && args[1] === "checkout") {
      exposure = { reminder: true, settled: true, kind: "pr-checkout" };
    } else if (executable === "git" && args[0] === "pull") {
      exposure = { reminder: true, settled: true, kind: "pull" };
    } else if (executable === "git" && args[0] === "push") {
      exposure = { reminder: true, settled: true, event: "push", kind: "push" };
    } else if (executable === "gh" && args[0] === "pr" && args[1] === "create") {
      exposure = { reminder: true, settled: true, event: "pr-create", kind: "pr-create" };
    } else if (executable === "gh" && args[0] === "pr" && args[1] === "reopen") {
      exposure = { reminder: true, settled: true, event: "pr-create", kind: "pr-reopen" };
    }
  }
  return exposure;
}

function reopenTarget(args: string[]): string | undefined {
  for (let index = 2; index < args.length; index += 1) {
    const value = args[index] ?? "";
    if (value === "-c" || value === "--comment") {
      index += 1;
      continue;
    }
    if (value.startsWith("--comment=") || value.startsWith("-")) continue;
    return value;
  }
  return undefined;
}

function ghRepository(words: string[]): string | undefined {
  const ghIndex = words.findIndex((word, index) => word === "gh"
    && shellCommandExecutable(words.slice(0, index + 1)) === "gh");
  for (let index = ghIndex + 1; ghIndex >= 0 && index < words.length; index += 1) {
    const value = words[index] ?? "";
    if (value === "-R" || value === "--repo") return words[index + 1]?.toLowerCase();
    if (value.startsWith("--repo=")) return value.slice("--repo=".length).toLowerCase();
    if (!value.startsWith("-")) break;
  }
  return undefined;
}

export function exposureTargetsCheckedOutBranch(
  command: string,
  identity: { branch: string; pr: number; repository: string },
): boolean {
  const relevant = executableShellCommands(command)
    .flatMap((words) => {
      const executable = shellCommandExecutable(words);
      return executable === "git" || executable === "gh"
        ? [{ executable, args: shellCommandArguments(words, executable), words }]
        : [];
    })
    .filter(({ executable, args }) => (executable === "git" && args[0] === "push")
      || (executable === "gh" && args[0] === "pr" && (args[1] === "create" || args[1] === "reopen")))
    .at(-1);
  if (!relevant) return true;
  const branch = identity.branch;
  if (relevant.executable === "gh") {
    const repository = ghRepository(relevant.words);
    if (repository && repository !== identity.repository.toLowerCase()) return false;
    if (relevant.args[1] === "reopen") {
      const target = reopenTarget(relevant.args);
      if (!target) return true;
      const url = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/i.exec(target);
      if (url) return url[1]?.toLowerCase() === identity.repository.toLowerCase()
        && Number(url[2]) === identity.pr;
      if (/^[0-9]+$/.test(target)) return Number(target) === identity.pr;
      return target === branch || target.endsWith(`:${branch}`);
    }
    const headIndex = relevant.args.findIndex((arg) => arg === "--head" || arg === "-H");
    const inline = relevant.args.find((arg) => arg.startsWith("--head="))?.slice("--head=".length);
    const head = inline ?? (headIndex >= 0 ? relevant.args[headIndex + 1] : undefined);
    return !head || head === branch || head.endsWith(`:${branch}`);
  }
  const takesValue = new Set(["--repo", "--receive-pack", "--exec", "--push-option", "-o"]);
  const positional: string[] = [];
  for (let index = 1; index < relevant.args.length; index += 1) {
    const value = relevant.args[index] ?? "";
    if (value === "--") {
      positional.push(...relevant.args.slice(index + 1));
      break;
    }
    if (takesValue.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) continue;
    positional.push(value);
  }
  const refspecs = positional.slice(1);
  if (refspecs.length === 0) return true;
  return refspecs.every((refspec) => {
    const [source, destination] = refspec.replace(/^\+/, "").split(":", 2);
    const sourceMatches = source === branch || source === `refs/heads/${branch}` || source === "HEAD";
    const destinationMatches = !destination || destination === branch || destination === `refs/heads/${branch}`;
    return sourceMatches && destinationMatches;
  });
}

export function isReviewTransitionSuspended(repo: string): boolean {
  const nested = existsSync(join(repo, "sdd/spec/config.yml"));
  const config = nested ? join(repo, "sdd/spec/config.yml") : join(repo, "sdd/config.yml");
  const triage = nested ? join(repo, "sdd/spec/.init-triage.md") : join(repo, "sdd/.init-triage.md");
  if (!existsSync(config) || !existsSync(triage)) return false;
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
    const touchedLane = fileLines.some((file) => file.trim().startsWith(rule.tree));
    if (BULK_PREFIXES.some((prefix) => subject.startsWith(prefix))) continue;
    if (!rule.tags.some((tag) => rule.match(subject, tag))) {
      if (touchedLane) break;
      continue;
    }
    if (touchedLane) counted += 1;
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

function nativeNotification(entry: Record<string, any>): { toolUseId: string; succeeded: boolean; text: string } | undefined {
  if (entry.type !== "custom_message" || entry.customType !== "subagent-notification" || typeof entry.content !== "string") return undefined;
  const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(entry.content)?.[1];
  if (!toolUseId) return undefined;
  const status = /<status>([^<]+)<\/status>/.exec(entry.content)?.[1]?.trim() ?? "";
  return { toolUseId, succeeded: /^(?:Done|Completed)$/i.test(status), text: entry.content };
}

type CiTerminalResult = "success" | "failure" | "timeout";

function ciTerminalResult(
  text: string,
  expected: { repository: string; prNumber: number; head: string },
): CiTerminalResult | undefined {
  const result = /(?:^|>)CI_RESULT\s+(success|failure|timeout)\b/mi.exec(text)?.[1] as CiTerminalResult | undefined;
  const identity = /^pr=(\d+)\s+head=([0-9a-f]{40})\s+repo=([^\s<]+)(?:\s+[^<]*)?(?:<|$)/mi.exec(text);
  return result
    && Number(identity?.[1]) === expected.prNumber
    && identity?.[2] === expected.head
    && identity?.[3] === expected.repository
    ? result
    : undefined;
}

function triageTablePresent(text: string): boolean {
  const lines = text.split("\n").map((line) => line.trim());
  return lines.some((line, index) => line === REVIEW_TRIAGE_HEADER
    && lines[index + 1] === REVIEW_TRIAGE_DIVIDER);
}

function triageTableIncludesRequiredCiResult(text: string, result: CiTerminalResult | undefined): boolean {
  const lines = text.split("\n").map((line) => line.trim());
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== REVIEW_TRIAGE_HEADER || lines[index + 1] !== REVIEW_TRIAGE_DIVIDER) continue;
    if (result !== "failure" && result !== "timeout") return true;
    for (let row = index + 2; row < lines.length && lines[row].startsWith("|"); row += 1) {
      if (!lines[row].endsWith("|")) continue;
      const cells = lines[row].slice(1, -1).split("|").map((cell) => cell.trim());
      const proposedFix = /^`([^`]*)`$/.exec(cells[2] ?? "")?.[1] ?? cells[2];
      if (cells.length === 5
        && cells[0] === "Exact-head CI"
        && proposedFix === `CI_RESULT ${result}`) return true;
    }
  }
  return false;
}

function completedPublicCiResult(
  text: string,
  expected: { repository: string; prNumber: number; head: string },
): CiTerminalResult | undefined {
  return /^Type:\s*ci-monitor\s*\|\s*Status:\s*(?:completed|done)\b/mi.test(text)
    ? ciTerminalResult(text, expected)
    : undefined;
}

type ReviewWindow = {
  head?: string;
  range?: string;
  repo?: string;
  branch?: string;
  prNumber?: number;
  base?: "main" | "master" | "develop";
  boundaryToolUseId?: string;
  ciEvent?: ReviewBoundaryEvent;
  requiredLanes?: ReviewLane[];
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
  const ciEvent = entry.details?.ciEvent === "push" || entry.details?.ciEvent === "pr-create"
    ? entry.details.ciEvent
    : undefined;
  const requiredLanes = Array.isArray(entry.details?.requiredLanes)
    ? entry.details.requiredLanes.filter((lane: unknown): lane is ReviewLane => (
      typeof lane === "string" && ALL_REVIEW_LANES.includes(lane as ReviewLane)
    ))
    : undefined;
  return { head, range, repo, branch, prNumber, base, boundaryToolUseId, ciEvent, requiredLanes };
}

export function reviewTranscriptFacts(input: {
  sessionFile: string;
  entries?: Record<string, any>[];
  requiredLanes: ReviewLane[];
  ci?: { repository: string; repo: string; prNumber: number; head: string };
  reviewHead?: string;
  activeBoundaryToolUseId?: string;
}): TranscriptFacts {
  const entries = input.entries ?? readEntries(input.sessionFile);
  const successfulToolIds = new Set(entries
    .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.isError !== true)
    .map((entry) => entry.message.toolCallId));
  const reconciledBoundaryIds = new Set(entries
    .filter((entry) => entry.type === "custom"
      && entry.customType === "pr-boundary-evaluated"
      && entry.data?.disposition === "launch"
      && typeof entry.data?.toolUseId === "string")
    .map((entry) => entry.data.toolUseId));
  const successfulSubagentToolIds = new Set(entries
    .filter((entry) => entry.type === "message"
      && entry.message?.role === "toolResult"
      && entry.message?.toolName === "subagent"
      && entry.message?.isError !== true)
    .map((entry) => entry.message.toolCallId));
  const referencedBoundaryIds = new Set(entries
    .map(reviewWindow)
    .map((window) => window?.boundaryToolUseId)
    .filter((toolUseId): toolUseId is string => typeof toolUseId === "string"));
  const boundaries = new Map<string, { index: number; value: NonNullable<TranscriptFacts["boundary"]> }>();
  let boundaryIndex = -1;
  let boundary: TranscriptFacts["boundary"];
  entries.forEach((entry, index) => {
    for (const call of toolCalls(entry)) {
      for (const command of shellCommands(call)) {
        if ((successfulToolIds.has(call.id) || reconciledBoundaryIds.has(call.id))
          && (classifyReviewBoundaryCommand(command).settled || referencedBoundaryIds.has(call.id))) {
          const value = {
            toolUseId: call.id,
            command,
            toolName: String(call.name ?? ""),
            toolArguments: call.arguments && typeof call.arguments === "object" ? call.arguments : {},
          };
          boundaries.set(call.id, { index, value });
          boundaryIndex = index;
          boundary = value;
        }
      }
    }
  });
  const latestBoundary = boundary;
  const windows = entries
    .map((entry, index) => ({ value: reviewWindow(entry), index }))
    .filter(({ value }) => value?.boundaryToolUseId
      && (boundaries.has(value.boundaryToolUseId)
        || value.boundaryToolUseId === input.activeBoundaryToolUseId));
  const reviewHead = input.reviewHead ?? windows.at(-1)?.value?.head;
  const selected = reviewHead
    ? windows.filter(({ value }) => value?.head === reviewHead).at(-1)
    : undefined;
  const selectedWindow = selected?.value;
  const selectedBoundary = selectedWindow?.boundaryToolUseId
    ? boundaries.get(selectedWindow.boundaryToolUseId)
      ?? (selectedWindow.boundaryToolUseId === input.activeBoundaryToolUseId && selected
        ? {
            index: selected.index,
            value: {
              toolUseId: selectedWindow.boundaryToolUseId,
              command: "",
              toolName: "",
              toolArguments: {},
            },
          }
        : undefined)
    : undefined;
  if (selectedBoundary) {
    boundaryIndex = selectedBoundary.index;
    boundary = selectedBoundary.value;
  }

  const lanes = Object.fromEntries(ALL_REVIEW_LANES.map((lane) => [lane, { state: "missing" }])) as Record<ReviewLane, LaneFact>;
  if (boundaryIndex < 0) return {
    latestBoundary,
    bypassed: false,
    ciLaunched: false,
    ciRequired: false,
    ciTerminal: false,
    triagePresent: false,
    triageComplete: false,
    fixDelivered: false,
    closedNotified: false,
    lanes,
    launchIssues: [],
  };
  const later = entries.slice(boundaryIndex + 1);
  const launchIssues: ReviewLaunchIssue[] = [];
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
    return {
      ...candidate,
      ciEvent: candidate.ciEvent ?? current?.ciEvent,
      requiredLanes: candidate.requiredLanes ?? current?.requiredLanes,
    };
  }, selectedWindow);
  later.forEach((entry, entryIndex) => {
    for (const call of toolCalls(entry)) {
      const lane = call.arguments?.subagent_type as ReviewLane;
      const prompt = typeof call.arguments?.prompt === "string" ? call.arguments.prompt : "";
      const expectedScope = window?.range
        ? `review_range=${window.range}`
        : window?.base ? `review_base=origin/${window.base}` : undefined;
      const expectedOutput = window?.prNumber && window.head
        ? `output_file=/tmp/codeflare-pr-${window.prNumber}-${window.head.slice(0, 12)}-${lane}.md`
        : undefined;
      const assignmentLines = new Set(prompt.split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean));
      if (call.name !== "subagent" || !input.requiredLanes.includes(lane)) continue;
      const problems = [
        ...(call.arguments?.run_in_background === true ? [] : ["run_in_background must be true"]),
        ...(call.arguments?.inherit_context === false ? [] : ["inherit_context must be false"]),
        ...(!window || assignmentLines.has("scope=diff") ? [] : ["prompt must include exact scope=diff"]),
        ...(!window || !expectedScope || assignmentLines.has(expectedScope) ? [] : [`prompt must include exact ${expectedScope}`]),
        ...(!window || !expectedOutput || assignmentLines.has(expectedOutput) ? [] : [`prompt must include exact ${expectedOutput}`]),
      ];
      if (problems.length > 0) {
        if (successfulSubagentToolIds.has(call.id)) launchIssues.push({ toolUseId: call.id, target: lane, problems });
        continue;
      }
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
  const ci = input.ci;
  const ciRequired = Boolean(window?.ciEvent);
  let ciLaunched = false;
  let ciTerminalIndex: number | undefined;
  let ciResult: CiTerminalResult | undefined;
  if (ci) {
    later.forEach((entry, entryIndex) => {
      for (const call of toolCalls(entry)) {
        if (call.name !== "subagent" || call.arguments?.subagent_type !== "ci-monitor") continue;
        let request: Record<string, unknown> | undefined;
        if (typeof call.arguments?.prompt === "string") {
          try {
            request = JSON.parse(call.arguments.prompt);
          } catch {
            // Report the malformed resolver payload below.
          }
        }
        const problems = [
          ...(call.arguments?.run_in_background === true ? [] : ["run_in_background must be true"]),
          ...(call.arguments?.inherit_context === false ? [] : ["inherit_context must be false"]),
          ...(request ? [] : ["prompt must be exact resolver JSON"]),
          ...(!request || request.repo === ci.repository ? [] : [`prompt repo must equal ${ci.repository}`]),
          ...(!request || request.pr === ci.prNumber ? [] : [`prompt pr must equal ${ci.prNumber}`]),
          ...(!request || request.head === ci.head ? [] : [`prompt head must equal ${ci.head}`]),
          ...(!request || request.cwd === ci.repo ? [] : [`prompt cwd must equal ${ci.repo}`]),
        ];
        if (problems.length > 0) {
          if (ciRequired && successfulSubagentToolIds.has(call.id)) {
            launchIssues.push({ toolUseId: call.id, target: "ci-monitor", problems });
          }
          continue;
        }
        if (!successfulSubagentToolIds.has(call.id)) continue;
        ciLaunched = true;

        const nativeTerminal = later.slice(entryIndex + 1)
          .map((candidate, offset) => ({ value: nativeNotification(candidate), index: entryIndex + offset + 1 }))
          .find((candidate) => {
            const notification = candidate.value;
            return notification !== undefined
              && notification.toolUseId === call.id
              && notification.succeeded
              && ciTerminalResult(notification.text, ci) !== undefined;
          });
        const launchResult = later.find((candidate) => candidate.type === "message"
          && candidate.message?.role === "toolResult"
          && candidate.message?.toolCallId === call.id
          && candidate.message?.toolName === "subagent"
          && candidate.message?.isError !== true);
        const launchedAgent = typeof launchResult?.message?.details?.agentId === "string"
          ? launchResult.message.details.agentId
          : undefined;
        const publicTerminal = launchedAgent ? later
          .map((candidate, index) => ({ candidate, index }))
          .find(({ candidate }) => candidate.type === "message"
            && candidate.message?.role === "toolResult"
            && candidate.message?.toolName === "get_subagent_result"
            && candidate.message?.isError !== true
            && resultRequests.get(candidate.message.toolCallId) === launchedAgent
            && completedPublicCiResult(messageContentText(candidate), ci) !== undefined)
          : undefined;
        const terminal = nativeTerminal && publicTerminal
          ? nativeTerminal.index <= publicTerminal.index
            ? { index: nativeTerminal.index, result: ciTerminalResult(nativeTerminal.value!.text, ci)! }
            : { index: publicTerminal.index, result: completedPublicCiResult(messageContentText(publicTerminal.candidate), ci)! }
          : nativeTerminal
            ? { index: nativeTerminal.index, result: ciTerminalResult(nativeTerminal.value!.text, ci)! }
            : publicTerminal
              ? { index: publicTerminal.index, result: completedPublicCiResult(messageContentText(publicTerminal.candidate), ci)! }
              : undefined;
        if (terminal && (ciTerminalIndex === undefined || terminal.index < ciTerminalIndex)) {
          ciTerminalIndex = terminal.index;
          ciResult = terminal.result;
        }
      }
    });
  }
  const allRequiredTerminal = input.requiredLanes.length > 0
    && input.requiredLanes.every((lane) => terminalIndexes.has(lane));
  const latestRequiredTerminalIndex = allRequiredTerminal
    ? Math.max(...input.requiredLanes.map((lane) => terminalIndexes.get(lane)!))
    : undefined;
  const completionIndex = latestRequiredTerminalIndex === undefined
    || (ciRequired && ciTerminalIndex === undefined)
    ? undefined
    : Math.max(latestRequiredTerminalIndex, ciTerminalIndex ?? -1);
  const triagePresent = completionIndex !== undefined && later.some((entry, index) =>
    index > completionIndex
    && toolCalls(entry).length === 0
    && triageTablePresent(messageText(entry, "assistant")),
  );
  const triageComplete = completionIndex !== undefined && later.some((entry, index) =>
    index > completionIndex
    && toolCalls(entry).length === 0
    && triageTableIncludesRequiredCiResult(messageText(entry, "assistant"), ciResult),
  );
  const bypassed = later.some((entry) => /\bskip (?:the )?(?:review|verification)\b/i.test(userText(entry)));
  const fixDelivered = later.some((entry) => entry.type === "custom_message"
    && entry.customType === "pr-boundary-fix-follow-up"
    && entry.details?.head === window?.head
    && entry.details?.boundaryToolUseId === window?.boundaryToolUseId);
  const closedNotified = later.some((entry) =>
    entry.type === "custom_message" && entry.customType === "pr-boundary-review-closed-unacknowledged",
  );
  return {
    boundary,
    latestBoundary,
    reviewHead: window?.head,
    reviewRange: window?.range,
    reviewRepo: window?.repo,
    reviewBranch: window?.branch,
    reviewPrNumber: window?.prNumber,
    reviewBase: window?.base,
    reviewBoundaryToolUseId: window?.boundaryToolUseId,
    reviewCiEvent: window?.ciEvent,
    reviewRequiredLanes: window?.requiredLanes,
    bypassed,
    ciLaunched,
    ciRequired,
    ciTerminal: ciTerminalIndex !== undefined,
    ciResult,
    triagePresent,
    triageComplete,
    fixDelivered,
    closedNotified,
    lanes,
    launchIssues,
  };
}

export default function () {}
