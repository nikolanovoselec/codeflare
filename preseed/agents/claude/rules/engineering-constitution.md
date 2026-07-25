# Engineering Constitution

The non-negotiable spine for ALL planning and coding — applies to Claude, Pi, and any
agent that loads these rules. These four mandates are always in force: you never need to
be told them again, and you restate them as success criteria in every plan so they are
verified, not assumed. They override speed and convenience. (For trivial one-line edits,
use judgment.)

## The four mandates

1. **No overengineering.** Minimum code that solves the actual request. Nothing
   speculative — no features, abstractions, "flexibility", config knobs, or error handling
   nobody asked for. If a senior engineer would call it overcomplicated, cut it until they
   wouldn't. See "Working principles" §2 (Simplicity) and §3 (Surgical changes) below.

2. **Behavioral tests only — zero theater, zero text-matching.** Assert behavior and
   contract values: state, DOM structure, counts, slot routing, variant classes, status
   codes, KV/JSON contents, parsed values, hrefs, attribute presence. NEVER assert UI copy
   or prose (`expect(html).toContain('<some sentence>')`), and never write a test that stays
   green when the implementation is gutted, renamed, or no-op'd. Gut-check every test: *if I
   break what this covers, does it fail?* Contract values (robots directives, scope ids,
   og:site_name) are not "copy". See [[tdd-discipline]].

3. **Reusable, composable components; best practices.** Any structure used more than twice
   is one component — pages/modules are composition. Separate structure (components) /
   content (typed data) / style (tokens, one stylesheet convention); control every
   size/colour/space/value centrally so a change is one edit. Refactor by extracting, not
   rewriting; preserve behavior. Validate at boundaries, trust inside. Immutability — new
   objects, never mutate. See [[frontend-components]] and "Coding concretes" below.

4. **SDD + TDD are enforced, not optional.** Write the failing behavioral test first, then
   make it pass. When `sdd/` exists: every change traces to a REQ; specs, anchors, and docs
   move with the code in the same change; and **nothing is left `Partial`** — if an
   acceptance criterion lacks automated verification, add the test (or build the missing
   piece) until the REQ is honestly `Implemented`. See [[spec-discipline]],
   [[tdd-discipline]], [[documentation-discipline]].

## Working principles

Four habits that prevent the usual LLM coding mistakes. Bias caution over speed; on
trivial edits, use judgment.

1. **Think before coding.** Don't assume and don't hide confusion. State assumptions
   explicitly and ask when uncertain. If a request has several readings, present them
   rather than silently picking one. If a simpler approach exists, say so.
2. **Simplicity first.** Minimum code that solves the problem, nothing speculative. If you
   wrote 200 lines and it could be 50, rewrite it.
3. **Surgical changes.** Touch only what you must and clean up only your own mess. Don't
   improve adjacent code, comments, or formatting; don't refactor what isn't broken; match
   existing style. Notice unrelated dead code, mention it, don't delete it. Remove imports
   and variables *your* change orphaned. Every changed line traces to the request. (A
   legitimate defect found in passing is not speculative work — see "Review findings: fix, don't ask" below.)
4. **Goal-driven execution.** Define success criteria and loop until verified. "Add
   validation" means write the failing tests for invalid input, then pass them. "Fix the
   bug" means write the reproducing test first. State a brief plan with verify steps.

## Coding concretes

- **Immutability.** Create new objects; never mutate existing ones. Mutation creates
  hidden side-effects, complicates debugging, and breaks concurrency safety.
- **The `undefined` trap.** Never set a field to `undefined` in a patch destined for JSON
  storage: `JSON.stringify` strips it and the field is silently deleted. Use an explicit
  reset value, or omit the field.
- **Validate at boundaries, trust inside.** Schema-validate user input, external APIs,
  file content, and queue messages; trust the types on internal calls between modules of
  the same codebase. Validating everywhere is noise.
- **Documentation integrity.** Changing a public API, route signature, env var, CI
  workflow, or architectural shape updates `documentation/` in the same commit. ADRs live
  in `documentation/decisions/README.md`.
- **Security.** Any change touching auth, user input, secrets, file uploads, or external
  integrations applies the security checklist and documents the verification path. Never
  hardcode secrets — use env vars. PR-boundary enforcement spawns reviewers; do not invoke
  review agents manually unless the user asks.

## Review findings: fix, don't ask

A legitimate finding — from a reviewer, an enforcement skill, an audit, or one you spot
yourself — gets **fixed**. The only question that matters is whether it is legitimate.
Whether it is pre-existing, introduced this session, inside your diff or someone else's,
in scope or adjacent, is **irrelevant and must not be raised**.

Never ask the user whether to fix a pre-existing, out-of-scope, or adjacent legitimate
finding. Don't offer it as a choice, defer it, or list it as "remaining — your call". Fix
every legitimate finding in the same session and report what you fixed. Only two reasons
justify not fixing one immediately: it is **not actually legitimate** (say so and explain
why), or the fix is **destructive/irreversible** in a way that requires confirmation.

This overrides the surgical-changes instinct above *for legitimate findings*. That
principle still governs speculative work — unrequested refactors, style churn, renames,
features nobody asked for. A flagged defect is not speculative; it is required work, so it
is fixed rather than merely mentioned. Applies to Claude and Pi alike.

## Graph first

When the active repo has `graphify-out/graph.json`, query the graph **before** a broad
repo search, an architecture / dependency / call-flow question, or "where is X
implemented?" — then read only the files it identifies. Do **not** use it for exact
known-file edits, git or CI state, a single-file string search, or code changed this
session; if you skip it, say why in a few words. After source edits, refresh via the
graphify skill's safe update wrapper before asking further structural questions; that
skill carries the mechanics, wrapper commands, large-repo flags, and enforcement details.

## Work continuity

When a new user message arrives while you are mid-task, do not abandon or switch away from
the active task just because the new message exists. Queue the new instruction mentally,
finish the current concrete step to a safe stopping point, then handle the new request in
order. If the new message explicitly says to stop, pause, or reprioritize, obey it; otherwise
complete what you were doing first.

## Review push gate (absolute)

Never `git push` while a review is running, pending, missing, stale, or incomplete for the
current head. Only explicit user authorisation lifts this; no finding severity, reviewer
instruction, or judgment call does. Commit freely — push once per round, after that head's
review closes. Name the closed round before every push; if you cannot name one, do not push.

## Review-result handoff gate

When a background `review-monitor` completes with `REVIEW_RESULT`, the very next
assistant response MUST start by printing a detailed user-facing review summary before
analysis, excuses, tool calls, todo updates, or fixes. Include the exact result line,
severity counts, lane status, ranked findings, summary path, monitor transcript path if
available, and the planned next action. If the result is `findings`, then immediately read
`summary.md`, verify every MEDIUM/HIGH/CRITICAL finding, fix legitimate findings, commit,
push, start CI monitoring, verify/restart `review-monitor`, and iterate until the exact
head returns `REVIEW_RESULT clean` — or `findings` that are **all LOW**, which also
completes the review for that head. Commit those fixes and let the next push you were
going to make anyway carry them; do not push a head whose only purpose is re-running
review over nits, and do not treat that head as unreviewed. Batching is not deferral: the
fix is written now, in this session, and a finding is still never downgraded to reach the
LOW bucket (see "Review findings: fix, don't ask"). Anything MEDIUM or above means fix now and re-run on the next push after the current round
closes; the push gate outranks this sentence. Stop before commit/push only if the latest
user instruction says not to autofix, wait for approval, or do not push. If a review-monitor
task stops, errors, or completes without `REVIEW_RESULT` for the active head, restart it
from the durable job prompt/result paths instead of treating the review as delivered.

## CI-result handoff gate

When a background CI monitor completes with `CI_RESULT`, the very next assistant response
MUST start by printing a user-facing CI summary before analysis, tool calls, todo updates,
review-status checks, fixes, deploys, or pushes. Include the exact result line, monitored
head, workflow/run id and URL when present, log path, failed-log command when present, and
planned next action. Only after that summary may you inspect logs or edit code. If a
CI monitor task stops, errors, or completes without `CI_RESULT` for the active head,
restart an exact-head CI monitor unless the head was superseded or the user explicitly
skipped CI monitoring.

## Hard gates

- **Plan gate (every plan / ExitPlanMode).** A plan MUST contain an explicit
  "Success criteria & verification" section that restates these four mandates as concrete,
  checkable steps for *this* task (what stays simple, what behavioral tests prove it, what
  is extracted/reused, which REQs + tests close the loop). A plan missing this is
  incomplete — do not present it. This gate is why the user never has to type these again.

- **Done gate (before declaring work complete).** Confirm each mandate held: no speculative
  code; tests are behavioral and would fail if the impl were gutted; repeated structure was
  extracted; and (SDD) no REQ is left `Partial`. State the verification, don't hand-wave it.

A legitimate finding — yours or a reviewer's — gets fixed in-session, never deferred or
raised as a question (see "Review findings: fix, don't ask" below).
