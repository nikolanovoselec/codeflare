export const ALL_REVIEW_LANES = ["code-reviewer", "spec-reviewer", "doc-updater"];

export function canMainSessionConsumeReviewBypass(sessionFile: string | undefined, isTaskSession: boolean): boolean {
  return Boolean(sessionFile && !isTaskSession);
}

export function reviewBypassConsumeDecision(consumed: boolean): { action: "ack" } | { action: "block"; reason: "bypass_not_consumed" } {
  return consumed ? { action: "ack" } : { action: "block", reason: "bypass_not_consumed" };
}

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

function isEnvAssignment(word: string): boolean {
  return /^[A-Za-z_]\w*=/.test(word);
}

function unwrapCommandWords(words: ShellCommand): ShellCommand {
  let index = 0;
  while (index < words.length && isEnvAssignment(words[index])) index += 1;
  for (;;) {
    const word = words[index];
    if (word === "env") {
      index += 1;
      while (index < words.length) {
        const current = words[index];
        if (isEnvAssignment(current)) { index += 1; continue; }
        if (current === "-u" || current === "--unset") { index += 2; continue; }
        if (current.startsWith("-")) { index += 1; continue; }
        break;
      }
      continue;
    }
    if (word === "command") { index += 1; continue; }
    if (word === "nice") {
      index += 1;
      if (words[index] === "-n") index += 2;
      else if (words[index]?.startsWith("-n")) index += 1;
      continue;
    }
    if (word === "timeout") {
      index += 1;
      while (words[index]?.startsWith("-")) index += 1;
      if (words[index]) index += 1; // duration
      continue;
    }
    break;
  }
  return words.slice(index);
}

// Bash here-docs (`<<EOF … EOF`, `<<'EOF'`, `<<-EOF`) carry arbitrary DATA, not
// shell commands — a PR body full of markdown pipes (`|`), apostrophes (`doesn't`),
// ampersands, and `$(…)`. Left in place, that body desyncs the quote/separator
// tracking in splitShellCommands, so a trailing `gh pr create --base main` on the
// line AFTER the here-doc is swallowed into a mis-parsed segment and never recognised
// as its own command — the PR boundary is silently missed and review never arms. This
// is the exact failure mode of a develop→main PR opened via the `pr-workflow` pattern
// (`cat > /tmp/pr-body.md <<'EOF' … EOF; gh pr create …`). Strip every complete
// here-doc body (only when its terminator line actually exists, so an arithmetic
// `$((a << b))` or an unterminated `<<` is left untouched) before tokenizing.
function stripHeredocs(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    out.push(lines[index]);
    const match = lines[index].match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (!match) continue;
    const delimiter = match[2];
    let end = index + 1;
    while (end < lines.length && lines[end].replace(/^[ \t]*/, "") !== delimiter) end += 1;
    if (end >= lines.length) continue; // no terminator -> not a real here-doc; do not strip
    index = end; // skip the body and the terminator line
  }
  return out.join("\n");
}

export function completeTranscriptDelta(input: { text: string; start: number; fromCursor: boolean }): { text: string; start: number; nextCursor: number } | undefined {
  let text = input.text;
  let start = input.start;

  if (!input.fromCursor && input.start > 0) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline < 0) return undefined;
    const skipped = text.slice(0, firstNewline + 1);
    start += Buffer.byteLength(skipped, "utf8");
    text = text.slice(firstNewline + 1);
  }

  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return undefined;

  const completeText = text.slice(0, lastNewline + 1);
  return {
    text: completeText,
    start,
    nextCursor: start + Buffer.byteLength(completeText, "utf8"),
  };
}

function reviewBoundaryCommands(command: string): ShellCommand[] {
  return splitShellCommands(stripHeredocs(command))
    .map(shellWords)
    .filter((words) => words.length > 0);
}

function gitCwd(words: ShellCommand): string | undefined {
  const unwrapped = unwrapCommandWords(words);
  if (unwrapped[0] !== "git") return undefined;
  for (let index = 1; index < unwrapped.length; index += 1) {
    const word = unwrapped[index];
    if (word === "-C") return unwrapped[index + 1];
    if (word.startsWith("-C") && word.length > 2) return word.slice(2);
    if (word === "-c" || word === "--git-dir" || word === "--work-tree") { index += 1; continue; }
    if (word.startsWith("--git-dir=") || word.startsWith("--work-tree=")) continue;
    if (!word.startsWith("-")) return undefined;
  }
  return undefined;
}

function gitArgs(words: ShellCommand): ShellCommand | undefined {
  words = unwrapCommandWords(words);
  if (words[0] !== "git") return undefined;
  let index = 1;
  while (index < words.length) {
    const word = words[index];
    if (word === "-C" || word === "-c" || word === "--git-dir" || word === "--work-tree") {
      index += 2;
      continue;
    }
    if ((word.startsWith("-C") && word.length > 2) || word.startsWith("--git-dir=") || word.startsWith("--work-tree=")) {
      index += 1;
      continue;
    }
    break;
  }
  return words.slice(index);
}

function isBoundaryWords(words: ShellCommand): boolean {
  if (isAdvancingGitPushWords(words)) return true;
  const unwrapped = unwrapCommandWords(words);
  if (unwrapped[0] !== "gh") return false;
  if (unwrapped[1] === "repo" && unwrapped[2] === "sync") return true;
  if (unwrapped[1] === "pr" && unwrapped[2] === "edit") return Boolean(prProtectedBaseFromWords(unwrapped));
  return unwrapped[1] === "pr" && ["create", "merge", "update-branch"].includes(unwrapped[2]);
}

// ---------------------------------------------------------------------------
// PR-boundary detection — structural and here-doc-safe. Review correctness comes
// from the `gh pr view` truth layer; these helpers only decide when to run that
// truth layer immediately and how to extract command cwd/targets. Avoid regex
// wrapper grammars here: they caused both misses (`env VAR=... git ...`) and a
// CodeQL ReDoS warning around nested `timeout`/`env` wrappers.
// ---------------------------------------------------------------------------
export type GitPushRefspecTarget = { branch?: string; source?: string };
export type GitPushCommandTarget = { branch?: string; source?: string; targets?: GitPushRefspecTarget[]; advancing: boolean };

function pushFlagTakesValue(flag: string): boolean {
  return flag === "--repo" || flag === "--receive-pack" || flag === "--exec" || flag === "--push-option" || flag === "-o";
}

function pushRefspecTarget(refspec: string): GitPushRefspecTarget | undefined {
  const clean = refspec.replace(/^\+/, "");
  const hasExplicitTarget = clean.includes(":");
  const [rawSource, rawTarget = rawSource] = hasExplicitTarget ? clean.split(":", 2) : [clean, clean];
  if (!rawTarget || rawTarget.startsWith("refs/tags/")) return undefined;
  if (!hasExplicitTarget && (rawTarget === "HEAD" || rawTarget === "@")) return { source: rawTarget };
  const branch = rawTarget.startsWith("refs/heads/") ? rawTarget.slice("refs/heads/".length) : rawTarget;
  const source = rawSource && rawSource.startsWith("refs/heads/") ? rawSource.slice("refs/heads/".length) : rawSource;
  return { branch, source: source || undefined };
}

// Push parsing is deliberately conservative. The common no-refspec form still falls back to the
// current branch, but explicit refspecs (`HEAD:branch`, `local:branch`, `refs/heads/x`) expose the
// PR branch the user actually advanced. Tag-only and delete-only pushes are non-boundaries so a cleanup
// command cannot accidentally autostart review for an inherited open PR on the checkout branch.
function gitPushTargetFromWords(words: ShellCommand): GitPushCommandTarget {
  const git = gitArgs(words);
  if (git?.[0] !== "push") return { advancing: false };

  const args = git.slice(1);
  if (args.some((arg) => arg === "--dry-run" || arg === "--delete" || arg === "-n" || arg === "-d")) return { advancing: false };
  if (args.length > 0 && args.every((arg) => arg === "--tags" || arg.startsWith("refs/tags/"))) return { advancing: false };

  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (pushFlagTakesValue(arg)) { index += 1; continue; }
    if (arg.startsWith("--repo=") || arg.startsWith("--receive-pack=") || arg.startsWith("--exec=") || arg.startsWith("--push-option=") || arg.startsWith("-o=")) continue;
    if (arg.startsWith("-")) continue;
    positionals.push(arg);
  }

  const refspecs = positionals.length > 1 ? positionals.slice(1) : [];
  if (args.includes("--tags") && refspecs.length === 0) return { advancing: false };
  if (refspecs[0] === "tag") return { advancing: false };
  if (refspecs.length > 0 && refspecs.every((ref) => ref.startsWith(":") || ref.startsWith("refs/tags/"))) return { advancing: false };
  const targets = refspecs.map(pushRefspecTarget).filter((value): value is GitPushRefspecTarget => Boolean(value));
  return { advancing: true, branch: targets[0]?.branch, source: targets[0]?.source, targets: targets.length > 0 ? targets : undefined };
}

export function gitPushCommandTarget(command: string): GitPushCommandTarget {
  const words = reviewBoundaryCommands(command).find((candidate) => gitPushTargetFromWords(candidate).advancing);
  return words ? gitPushTargetFromWords(words) : { advancing: false };
}

function isAdvancingGitPushWords(words: ShellCommand): boolean {
  return gitPushTargetFromWords(words).advancing;
}

function firstGhWords(command: string, subcommands: string[], matches: (words: ShellCommand) => boolean = () => true): ShellCommand | undefined {
  return reviewBoundaryCommands(command)
    .map(unwrapCommandWords)
    .find((words) => words[0] === "gh" && subcommands.every((part, index) => words[index + 1] === part) && matches(words));
}

function firstGitPushWords(command: string): ShellCommand | undefined {
  return reviewBoundaryCommands(command).find(isAdvancingGitPushWords);
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

function prBaseFromWords(words: ShellCommand): string | undefined {
  for (let index = 3; index < words.length; index += 1) {
    const word = words[index];
    if ((word === "--base" || word === "-B") && words[index + 1]) return words[index + 1];
    if (word.startsWith("--base=")) return word.slice("--base=".length);
    if (word.startsWith("-B=") && word.length > 3) return word.slice(3);
  }
  return undefined;
}

function prProtectedBaseFromWords(words: ShellCommand): string | undefined {
  const base = prBaseFromWords(words);
  return base === "main" || base === "master" ? base : undefined;
}

const stripQuotes = (s: string): string => s.replace(/^["']|["']$/g, "");

// A `gh pr edit --base main|master` retargets an EXISTING PR onto a protected base — the same
// enforced boundary `gh pr create --base main` establishes, but applied after creation. The
// create path only fires at creation time, so without this a PR opened against another base (or
// via the web UI) and later retargeted to main with `gh pr edit` would never arm a review. Only
// an explicit `--base main|master` qualifies; a `gh pr edit` that changes title/body/labels is not
// a boundary.
export function prEditBoundaryBase(command: string): string | undefined {
  for (const words of reviewBoundaryCommands(command).map(unwrapCommandWords)) {
    if (words[0] !== "gh" || words[1] !== "pr" || words[2] !== "edit") continue;
    const base = prProtectedBaseFromWords(words);
    if (base) return base;
  }
  return undefined;
}

export type PrCommandTarget = { prNumber?: number; prBranch?: string; repoSlug?: string };
export type PrEditCommandTarget = PrCommandTarget;
export type PrUpdateBranchCommandTarget = PrCommandTarget;
export type PrCreateCommandTarget = { repoSlug?: string; headBranch?: string; draft: boolean; dryRun: boolean };

function parsePrSelectorToken(token: string, result: PrCommandTarget): void {
  if (result.prNumber !== undefined || result.prBranch !== undefined) return;
  const stripped = stripQuotes(token);
  const url = /\/pull\/(\d+)/.exec(stripped);
  if (url) result.prNumber = Number(url[1]);
  else if (/^\d+$/.test(stripped)) result.prNumber = Number(stripped);
  else result.prBranch = stripped;
}

// gh subcommands share a dangerous shape: many flags take a value, and any missed value flag can be
// misread as the PR selector. Keep exact allowlists per subcommand and parse selectors only after those
// values are consumed; this is what prevents `--body-file 286 563 --base main` from reviewing PR 286.
function prCommandTarget(words: ShellCommand | undefined, valueFlags: Set<string>): PrCommandTarget {
  const result: PrCommandTarget = {};
  if (!words) return result;
  for (let index = 3; index < words.length; index += 1) {
    const token = words[index];
    if (token === "--repo" || token === "-R") { const value = words[++index]; if (value) result.repoSlug = stripQuotes(value); continue; }
    if (token.startsWith("--repo=")) { result.repoSlug = stripQuotes(token.slice("--repo=".length)); continue; }
    if (valueFlags.has(token)) { index += 1; continue; }
    if (token.startsWith("-")) continue;
    parsePrSelectorToken(token, result);
  }
  return result;
}

export function prEditCommandTarget(command: string): PrEditCommandTarget {
  const words = firstGhWords(command, ["pr", "edit"], (candidate) => Boolean(prProtectedBaseFromWords(candidate)))
    || firstGhWords(command, ["pr", "edit"]);
  return prCommandTarget(words, new Set([
    "--base", "-B", "--title", "-t", "--body", "-b", "--body-file", "-F",
    "--add-label", "--remove-label", "--add-assignee", "--remove-assignee",
    "--add-reviewer", "--remove-reviewer", "--add-project", "--remove-project",
    "--milestone", "-m", "--project",
  ]));
}

export function prUpdateBranchCommandTarget(command: string): PrUpdateBranchCommandTarget {
  return prCommandTarget(firstGhWords(command, ["pr", "update-branch"]), new Set());
}

function prCreateTargetFromWords(words: ShellCommand | undefined): PrCreateCommandTarget {
  const result: PrCreateCommandTarget = { draft: false, dryRun: false };
  if (!words) return result;
  for (let index = 3; index < words.length; index += 1) {
    const token = words[index];
    if (token === "--repo" || token === "-R") { const value = words[++index]; if (value) result.repoSlug = stripQuotes(value); continue; }
    if (token.startsWith("--repo=")) { result.repoSlug = stripQuotes(token.slice("--repo=".length)); continue; }
    if (token === "--head" || token === "-H") { const value = words[++index]; if (value) result.headBranch = stripQuotes(value); continue; }
    if (token.startsWith("--head=")) { result.headBranch = stripQuotes(token.slice("--head=".length)); continue; }
    if (token === "--draft") { result.draft = true; continue; }
    if (token === "--dry-run") { result.dryRun = true; continue; }
    if (["--base", "-B", "--title", "-t", "--body", "-b", "--body-file", "-F", "--assignee", "--label", "--milestone", "-m", "--project", "--reviewer"].includes(token)) { index += 1; continue; }
  }
  return result;
}

function firstReviewablePrCreateWords(command: string, knownBase?: string): ShellCommand | undefined {
  return firstGhWords(command, ["pr", "create"], (candidate) => {
    const target = prCreateTargetFromWords(candidate);
    if (target.dryRun || target.draft) return false;
    const base = prBaseFromWords(candidate) || knownBase || "";
    return !base || base === "main" || base === "master";
  });
}

export function prCreateCommandTarget(command: string): PrCreateCommandTarget {
  return prCreateTargetFromWords(firstReviewablePrCreateWords(command) || firstGhWords(command, ["pr", "create"]));
}

export function isGhPrCreateCommand(command: string): boolean {
  return Boolean(firstGhWords(command, ["pr", "create"]));
}

export function ghPrCreateBase(command: string): string | undefined {
  const words = firstReviewablePrCreateWords(command) || firstGhWords(command, ["pr", "create"]);
  return words ? prBaseFromWords(words) : undefined;
}

export function prCreateBoundaryBase(command: string, knownBase?: string): string | undefined {
  const words = firstReviewablePrCreateWords(command, knownBase);
  if (!words) return undefined;
  const base = prBaseFromWords(words) || knownBase || "";
  return base || "main";
}

export function prBoundaryCommandBase(command: string, knownBase?: string): string | undefined {
  return prCreateBoundaryBase(command, knownBase) || prEditBoundaryBase(command);
}

export function boundaryFallbackHead(input: { localHead?: string; prHead?: string; preferPrHead?: boolean }): string | undefined {
  return input.preferPrHead
    ? (input.prHead || input.localHead)
    : (input.localHead || input.prHead);
}

// Pure push-path enforcement gate (git-push-review-reminder.sh:253-254): an OPEN PR with a
// head OID targeting main/master — OR an empty baseRefName (transient gh/jq parse edge), which
// fails OPEN so a real push never silently skips review on a parsing hiccup. This is the
// push-path-only widening; the strict main/master gate used by the merge gate and the reconcile
// tick lives in review-enforcement.ts::isEnforcedPr. Pure so the fail-open is unit-testable.
export function prEnforcedForPush(pr: { headRefOid?: string | null; state?: string; baseRefName?: string } | undefined): boolean {
  return Boolean(pr?.headRefOid && pr.state === "OPEN" && (pr.baseRefName === "main" || pr.baseRefName === "master" || !pr.baseRefName));
}

// Low-level matcher used to pluck a boundary command out of a tool event
// (commandTextFromEvent). Broader than the trigger predicate: it also matches
// `gh pr merge` (the merge gate) and a `gh pr create` at any base, mirroring the
// old word-matcher's breadth.
export function isPrBoundaryCommand(command: string): boolean {
  return reviewBoundaryCommands(command).some(isBoundaryWords);
}

// THE single PR-boundary trigger predicate (review.md §17.5). A real boundary is a
// git push / gh repo sync, a gh pr update-branch, or a gh pr create/edit targeting
// main/master. `gh pr merge` is deliberately NOT a trigger: it is the merge gate
// (handled separately), so merging never arms a fresh review of the head being
// merged. Use this for "should this command start a review?"; isPrBoundaryCommand
// stays the low-level matcher used to pluck a command out of a tool event.
export function isPrBoundaryTrigger(command: string): boolean {
  if (prCreateBoundaryBase(command)) return true;
  if (prEditBoundaryBase(command)) return true;
  return reviewBoundaryCommands(command).some((words) => {
    if (isAdvancingGitPushWords(words)) return true;
    const unwrapped = unwrapCommandWords(words);
    return (unwrapped[0] === "gh" && unwrapped[1] === "repo" && unwrapped[2] === "sync")
      || (unwrapped[0] === "gh" && unwrapped[1] === "pr" && unwrapped[2] === "update-branch");
  });
}

export type BoundaryTriggerCommand = { command: string; cwd?: string };

export function boundaryTriggerCommandEntries(command: string): BoundaryTriggerCommand[] {
  const entries: BoundaryTriggerCommand[] = [];
  let lastCd: string | undefined;
  for (const segment of splitShellCommands(stripHeredocs(command))) {
    const words = shellWords(segment);
    if (words[0] === "cd" && words[1]) {
      lastCd = words[1];
      continue;
    }
    if (!isPrBoundaryTrigger(segment)) continue;
    entries.push({ command: segment, cwd: cwdFromBoundaryCommand(segment) || lastCd });
  }
  return entries;
}

export function boundaryTriggerCommands(command: string): string[] {
  return boundaryTriggerCommandEntries(command).map((entry) => entry.command);
}

export function isGhPrMergeCommand(command: string): boolean {
  return Boolean(firstGhWords(command, ["pr", "merge"]));
}
export function isGitPushOnlyCommand(command: string): boolean {
  return Boolean(firstGitPushWords(command));
}

// Which PR a `gh pr merge` command actually targets, so the merge gate can check THAT PR rather than
// blindly evaluating the current branch's PR (P1). `gh pr merge 42`, a PR URL, a branch name, or
// `--repo owner/repo` all select something other than the cwd branch; without this the gate both
// FALSE-ALLOWS (`gh pr merge <other-unreviewed-PR>` sails through when the current branch is clean) and
// FALSE-BLOCKS (merging an unrelated ready PR by number from a no-PR checkout). Also surfaces `--auto`,
// which arms a server-side merge that completes after checks pass and never re-consults this gate (P3).
export type MergeCommandTarget = { prNumber?: number; prBranch?: string; repoSlug?: string; auto: boolean };
export function mergeCommandTarget(command: string): MergeCommandTarget {
  const result: MergeCommandTarget = { auto: false };
  const words = firstGhWords(command, ["pr", "merge"]);
  if (!words) return result;
  const toks = words.slice(3);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === "--auto") { result.auto = true; continue; }
    if (t === "--repo" || t === "-R") { const v = toks[++i]; if (v) result.repoSlug = stripQuotes(v); continue; }
    if (t.startsWith("--repo=")) { result.repoSlug = stripQuotes(t.slice(7)); continue; }
    if (t.startsWith("-")) {
      // Skip the VALUE of known value-bearing `gh pr merge` flags so the value is not
      // mistaken for the PR selector. This MUST be an exact allowlist of the flags that
      // actually take a value (`gh pr merge --help`): -A/--author-email, -b/--body,
      // -F/--body-file, -t/--subject, --match-head-commit. (-R/--repo is consumed above.)
      // A blanket "skip the next token after any -flag" would be WRONG — boolean flags
      // (--squash, --merge, --rebase, --admin, --delete-branch, --auto) take no value and
      // would wrongly swallow the PR selector. Both short and long forms are listed because
      // only the space-separated form reaches here; the --flag=value form starts with `-`
      // and is swallowed whole by this same branch.
      if (/^(-A|--author-email|-b|--body|-F|--body-file|-t|--subject|--match-head-commit)$/.test(t)) i++;
      continue;
    }
    // First positional token is the PR selector: a number, a /pull/<n> URL, or a branch name.
    if (result.prNumber === undefined && result.prBranch === undefined) {
      const url = /\/pull\/(\d+)/.exec(t);
      if (url) result.prNumber = Number(url[1]);
      else if (/^\d+$/.test(t)) result.prNumber = Number(t);
      else result.prBranch = stripQuotes(t);
    }
  }
  return result;
}

export type PostCommandReconcileDecision = { reconcile: boolean; freshPrState: boolean };

export function startedBoundaryCommandForToolEnd(input: {
  endToolId?: string;
  startedToolId?: string;
  startedCommand?: string;
  ageMs: number;
  maxAgeMs: number;
}): string | undefined {
  if (!input.endToolId || input.endToolId !== input.startedToolId) return undefined;
  if (!input.startedCommand || input.ageMs > input.maxAgeMs) return undefined;
  return isPrBoundaryTrigger(input.startedCommand) ? input.startedCommand : undefined;
}

export function postCommandReconcileDecision(command: string): PostCommandReconcileDecision {
  const invokesGitOrGh = reviewBoundaryCommands(command)
    .map(unwrapCommandWords)
    .some((words) => words[0] === "git" || words[0] === "gh");
  return invokesGitOrGh ? { reconcile: true, freshPrState: true } : { reconcile: false, freshPrState: false };
}

export function commandTextsFromEvent(event: any): string[] {
  const inputs = [event?.input, event?.params, event?.args, event?.arguments, event?.toolCall?.arguments, event?.toolCall?.input, event?.toolCall?.params];
  const commands: string[] = [];
  for (const input of inputs) {
    if (!input || typeof input !== "object") continue;
    // Shell-only gate, faithful to git-push-review-reminder.sh:74-84: Bash carries
    // `.command`; ctx_execute carries `.code` ONLY when language === "shell" (a JS/TS/
    // python ctx_execute body must NEVER feed the boundary regex — the issue #2B class
    // of false-fire); ctx_batch_execute carries `.commands[].command`. The dropped
    // `.script` / bare-string `commands[]` shapes are not real Pi shell shapes — a
    // legacy `.script` now yields "" by design (regression-pinned in tests).
    if (typeof input.command === "string") commands.push(input.command);
    if (input.language === "shell" && typeof input.code === "string") commands.push(input.code);
    if (Array.isArray(input.commands)) {
      commands.push(...input.commands.map((cmd: any) => (cmd && typeof cmd.command === "string" ? cmd.command : "")));
    }
  }
  return commands.filter((command) => command.trim());
}

export function commandTextFromEvent(event: any): string {
  const commands = commandTextsFromEvent(event);
  // Prefer the first REAL trigger over the broader matcher. The broader matcher intentionally includes
  // non-trigger words such as `gh pr merge` and non-protected creates for merge/backstop checks; choosing
  // it first hid later protected pushes in ctx_batch_execute arrays.
  return commands.find(isPrBoundaryTrigger) || commands.find(isPrBoundaryCommand) || commands[0] || "";
}

export function isFailedToolExecution(event: any): boolean {
  const status = String(event?.status ?? event?.state ?? "").toLowerCase();
  const exitCode = event?.exitCode ?? event?.exit_code ?? event?.code;
  return event?.isError === true
    || event?.error === true
    || status === "error"
    || status === "failed"
    || status === "failure"
    || (typeof exitCode === "number" && exitCode !== 0);
}

// Extract a GitHub PR URL from arbitrary tool-output text. `gh pr create` prints
// the new PR's URL on success; when the command text itself could not be parsed
// out of the tool event, this lets the boundary path still recognise that a PR
// was created and reconcile from it (REQ-AGENT-058 AC5).
export function prUrlFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = text.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/);
  return match ? match[0] : undefined;
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
}): string | undefined {
  const priorIncomplete = params.previous?.lanes.some((lane) => !params.previous?.completed.includes(lane));
  if (priorIncomplete) return params.previous?.reviewBase;
  // Without an explicit ack or a completed previous review proving the earlier PR contents were
  // already covered, return undefined so the next review covers the full PR diff (REQ-AGENT-055 AC5).
  // (A remote-tracking reflog hint was deliberately removed — it was never proof of prior review.)
  return params.previous?.head || params.lastAck;
}

// Generated, machine-authored artifacts checked into the repo. The graphify
// knowledge graph under `graphify-out/` is derived output, not authored source,
// so a diff touching only these needs no prose review lane (REQ-AGENT-040 AC8).
const GENERATED_ARTIFACT_PREFIXES = ["graphify-out/"];

export function isGeneratedArtifactPath(file: string): boolean {
  return GENERATED_ARTIFACT_PREFIXES.some((prefix) => file.startsWith(prefix));
}

// True when a non-empty diff touches ONLY generated artifacts. The caller uses
// this to write an explicit, durable auto-ack audit reason rather than spawning
// reviewers on derived output.
export function isGeneratedOnlyDiff(files: string[] | undefined): boolean {
  return Array.isArray(files) && files.length > 0 && files.every(isGeneratedArtifactPath);
}

export function classifyReviewFiles(files: string[] | undefined): string[] | undefined {
  if (files === undefined) return ALL_REVIEW_LANES;
  if (files.length === 0) return [];
  let hasBehavioral = false;
  let touchesSdd = false;
  let touchesDocs = false;
  for (const file of files) {
    // Generated artifacts contribute no review lane. A diff that mixes them with
    // real source/sdd/docs is still classified by those non-generated files.
    if (isGeneratedArtifactPath(file)) continue;
    if (file.startsWith("sdd/")) touchesSdd = true;
    else if (file.startsWith("documentation/") || ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "LICENSE"].includes(file)) touchesDocs = true;
    else hasBehavioral = true;
  }
  if (hasBehavioral) return ALL_REVIEW_LANES;
  if (touchesSdd) return ["spec-reviewer", "doc-updater"];
  if (touchesDocs) return ["doc-updater"];
  return [];
}

// Pure decision behind resolveEnforcedHead (REQ-AGENT-058 AC3). Given the resolved git facts,
// choose whether the enforced PR-boundary head is the local HEAD or GitHub's reported PR head.
// Prefer local ONLY when it is on the PR's own branch, descends from the reported head, AND was
// actually pushed (the remote-tracking ref contains it) — so a push whose PR metadata still lags
// is enforced, but an unpushed local WIP commit never arms a review for a commit the PR never had.
export function enforcedHeadDecision(input: {
  prHead: string;
  local: string;
  onPrBranch: boolean;
  localDescendsFromPrHead: boolean;
  localPushed: boolean;
}): "local" | "prHead" {
  if (!input.prHead) return "local";
  if (!input.local || input.prHead === input.local) return "prHead";
  if (input.onPrBranch && input.localDescendsFromPrHead && input.localPushed) return "local";
  return "prHead";
}

export default function () {
  // Helper module for review-enforcement.ts; no extension registration needed.
}
