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

function reviewBoundaryCommands(command: string): ShellCommand[] {
  return splitShellCommands(stripHeredocs(command))
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
  if (words[1] === "pr" && words[2] === "edit") return Boolean(prEditBaseFromWords(words));
  return words[1] === "pr" && ["create", "merge", "update-branch"].includes(words[2]);
}

// ---------------------------------------------------------------------------
// PR-boundary detection — STATELESS regex, mirroring the Claude Stop hook's awk
// approach (enforce-review-spawn.sh). A here-doc PR body (markdown table pipes,
// an apostrophe in "doesn't") or any unbalanced quote desyncs a stateful shell
// tokenizer, so a trailing `gh pr create --base main` on the line after the
// here-doc is silently swallowed and the boundary is missed — the exact failure
// behind a develop→main PR that never armed review. A regex anchored at
// start-of-command / after a shell separator cannot be desynced by preceding
// content. Loose-candidate false positives (e.g. a boundary command quoted
// inside `rg "..."` or `printf '...'`) are filtered downstream by the gh-pr-view
// truth layer (prForBoundaryCommand → isEnforcedPr), exactly as in Claude's
// Layer-1-candidate / Layer-2-truth split. The shell tokenizer above is retained
// ONLY for cwdFromBoundaryCommand (cd / git -C extraction), now here-doc-safe via
// stripHeredocs.
// ---------------------------------------------------------------------------
// Start-of-string OR a shell separator (\n ; & |), optional whitespace, optional `VAR=val ` prefixes,
// then optional command wrappers (`env`, `command`, `nice [-n N]`, `timeout [-flags] DURATION`). The
// wrapper class is load-bearing for the MERGE gate especially: agents routinely emit `timeout 60 gh pr
// merge …` / `env gh pr merge …`, and unlike detection (where the gh-pr-view reconcile backstops a
// missed boundary) the gate has no second chance — a wrapper that slips past it is an unreviewed merge.
// `bash -c '…'` / `xargs … gh pr merge` (gh inside quotes) is NOT covered here by design; the post-merge
// retroactive "MERGED while unacked" audit in review-enforcement is the truth-layer backstop for those.
const BOUNDARY_ANCHOR = String.raw`(?:^|[\n;&|])[ \t]*(?:[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|\S*)[ \t]+)*(?:(?:env|command|nice(?:[ \t]+-n[ \t]*\S+)?|timeout(?:[ \t]+-\S+)*[ \t]+\S+)[ \t]+)*`;
// The matched verb must end at a separator / whitespace / quote / end-of-string (a whole word).
const BOUNDARY_TAIL = String.raw`(?=[ \t"';&|]|$)`;
// git global options that can sit between `git` and the `push` subcommand (e.g. `git -C /repo push`).
const GIT_GLOBAL_OPTS = String.raw`(?:-C[ \t]*\S+[ \t]+|-c[ \t]+\S+[ \t]+|--git-dir[= \t]\S+[ \t]+|--work-tree[= \t]\S+[ \t]+)*`;
const RE_GIT_PUSH = new RegExp(BOUNDARY_ANCHOR + String.raw`git[ \t]+` + GIT_GLOBAL_OPTS + String.raw`push` + BOUNDARY_TAIL);
// A `git push` that cannot ADVANCE a PR head — a dry run (`--dry-run`/`-n`) or a branch DELETE
// (`--delete`/`-d`) — is not a PR boundary. Excluded so a credential-probe dry-run or a branch teardown
// doesn't arm review on an inherited unacked head (which would wrongly AUTOSTART where the design says
// OFFER — finding from the third deep review). `--tags` is deliberately NOT excluded: `git push origin
// main --tags` advances a head too, and the reconcile gh-pr-view backstop covers a rare tags-only push.
const RE_GIT_PUSH_NONADVANCING = new RegExp(BOUNDARY_ANCHOR + String.raw`git[ \t]+` + GIT_GLOBAL_OPTS + String.raw`push\b[^\n;&|]*?[ \t](?:--dry-run|--delete|-n|-d)(?![\w-])`);
function isAdvancingGitPush(command: string): boolean {
  return RE_GIT_PUSH.test(command) && !RE_GIT_PUSH_NONADVANCING.test(command);
}
const RE_GH_REPO_SYNC = new RegExp(BOUNDARY_ANCHOR + String.raw`gh[ \t]+repo[ \t]+sync` + BOUNDARY_TAIL);
const RE_GH_PR_UPDATE_BRANCH = new RegExp(BOUNDARY_ANCHOR + String.raw`gh[ \t]+pr[ \t]+update-branch` + BOUNDARY_TAIL);
const RE_GH_PR_CREATE = new RegExp(BOUNDARY_ANCHOR + String.raw`gh[ \t]+pr[ \t]+create` + BOUNDARY_TAIL);
const RE_GH_PR_MERGE = new RegExp(BOUNDARY_ANCHOR + String.raw`gh[ \t]+pr[ \t]+merge` + BOUNDARY_TAIL);
// `--base X` / `--base=X` / `-B X` / `-B=X`, value optionally single/double quoted. `[^\n;&|]*?` keeps
// the flag scan within the same command segment (not bleeding across a separator into another command).
const BASE_FLAG = String.raw`(?:--base[ \t]+|--base=|-B[ \t]+|-B=)["']?([\w./-]+)["']?`;
const RE_PR_EDIT_BASE = new RegExp(BOUNDARY_ANCHOR + String.raw`gh[ \t]+pr[ \t]+edit[^\n;&|]*?[ \t]` + BASE_FLAG);
const RE_PR_CREATE_BASE = new RegExp(BOUNDARY_ANCHOR + String.raw`gh[ \t]+pr[ \t]+create[^\n;&|]*?[ \t]` + BASE_FLAG);

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

function prEditBaseFromWords(words: ShellCommand): string | undefined {
  let base: string | undefined;
  for (let index = 3; index < words.length; index += 1) {
    const word = words[index];
    if ((word === "--base" || word === "-B") && words[index + 1]) { base = words[index + 1]; break; }
    if (word.startsWith("--base=")) { base = word.slice("--base=".length); break; }
    if (word.startsWith("-B=") && word.length > 3) { base = word.slice(3); break; }
  }
  if (!base || (base !== "main" && base !== "master")) return undefined;
  return base;
}

// A `gh pr edit --base main|master` retargets an EXISTING PR onto a protected base — the same
// enforced boundary `gh pr create --base main` establishes, but applied after creation. The
// create path only fires at creation time, so without this a PR opened against another base (or
// via the web UI) and later retargeted to main with `gh pr edit` would never arm a review. Only
// an explicit `--base main|master` qualifies; a `gh pr edit` that changes title/body/labels is not
// a boundary.
export function prEditBoundaryBase(command: string): string | undefined {
  const match = command.match(RE_PR_EDIT_BASE);
  if (!match) return undefined;
  return match[1] === "main" || match[1] === "master" ? match[1] : undefined;
}

export function isGhPrCreateCommand(command: string): boolean {
  return RE_GH_PR_CREATE.test(command);
}

export function ghPrCreateBase(command: string): string | undefined {
  const match = command.match(RE_PR_CREATE_BASE);
  return match ? match[1] : undefined;
}

export function prCreateBoundaryBase(command: string, knownBase?: string): string | undefined {
  if (!isGhPrCreateCommand(command)) return undefined;
  const base = ghPrCreateBase(command) || knownBase || "";
  if (base && base !== "main" && base !== "master") return undefined;
  return base || "main";
}

export function prBoundaryCommandBase(command: string, knownBase?: string): string | undefined {
  return prCreateBoundaryBase(command, knownBase) || prEditBoundaryBase(command);
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
  return (
    isAdvancingGitPush(command) ||
    RE_GH_REPO_SYNC.test(command) ||
    RE_GH_PR_UPDATE_BRANCH.test(command) ||
    RE_GH_PR_CREATE.test(command) ||
    RE_GH_PR_MERGE.test(command) ||
    Boolean(prEditBoundaryBase(command))
  );
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
  return isAdvancingGitPush(command) || RE_GH_REPO_SYNC.test(command) || RE_GH_PR_UPDATE_BRANCH.test(command);
}

// The merge gate and head-resolution predicates MUST share the same env-prefix-tolerant
// anchored regexes as detection, or a command detection recognises (e.g. `GH_TOKEN=x gh pr
// merge`, `GIT_SSH_COMMAND='…' git push`) slips past the gate / takes the wrong head branch.
export function isGhPrMergeCommand(command: string): boolean {
  return RE_GH_PR_MERGE.test(command);
}
export function isGitPushOnlyCommand(command: string): boolean {
  return isAdvancingGitPush(command);
}

// Which PR a `gh pr merge` command actually targets, so the merge gate can check THAT PR rather than
// blindly evaluating the current branch's PR (P1). `gh pr merge 42`, a PR URL, a branch name, or
// `--repo owner/repo` all select something other than the cwd branch; without this the gate both
// FALSE-ALLOWS (`gh pr merge <other-unreviewed-PR>` sails through when the current branch is clean) and
// FALSE-BLOCKS (merging an unrelated ready PR by number from a no-PR checkout). Also surfaces `--auto`,
// which arms a server-side merge that completes after checks pass and never re-consults this gate (P3).
const RE_GH_PR_MERGE_ARGS = new RegExp(BOUNDARY_ANCHOR + String.raw`gh[ \t]+pr[ \t]+merge\b([^\n;&|]*)`);
const stripQuotes = (s: string): string => s.replace(/^["']|["']$/g, "");
export type MergeCommandTarget = { prNumber?: number; prBranch?: string; repoSlug?: string; auto: boolean };
export function mergeCommandTarget(command: string): MergeCommandTarget {
  const result: MergeCommandTarget = { auto: false };
  const m = RE_GH_PR_MERGE_ARGS.exec(command);
  if (!m) return result;
  // Tokenize with the quote-aware splitter, NOT a raw whitespace split: a quoted multi-word
  // value (`gh pr merge -t "fix the gateway" 42`) must stay one token, else the value's tail
  // ("gateway") is read as the PR selector and the gate is pointed at the wrong PR (fail open).
  const toks = shellWords(m[1]);
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

export function commandTextFromEvent(event: any): string {
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
  return commands.find(isPrBoundaryCommand) || commands.find((command) => command.trim()) || "";
}

export function isFailedToolExecution(event: any): boolean {
  return event?.isError === true || event?.error === true || String(event?.status ?? "").toLowerCase() === "error";
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
