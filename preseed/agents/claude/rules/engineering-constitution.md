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
   wouldn't. See [[karpathy]] §2 (Simplicity) and §3 (Surgical Changes).

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
   objects, never mutate. See [[frontend-components]] and [[common/coding-style]].

4. **SDD + TDD are enforced, not optional.** Write the failing behavioral test first, then
   make it pass. When `sdd/` exists: every change traces to a REQ; specs, anchors, and docs
   move with the code in the same change; and **nothing is left `Partial`** — if an
   acceptance criterion lacks automated verification, add the test (or build the missing
   piece) until the REQ is honestly `Implemented`. See [[spec-discipline]],
   [[tdd-discipline]], [[documentation-discipline]].

## Work continuity

When a new user message arrives while you are mid-task, do not abandon or switch away from
the active task just because the new message exists. Queue the new instruction mentally,
finish the current concrete step to a safe stopping point, then handle the new request in
order. If the new message explicitly says to stop, pause, or reprioritize, obey it; otherwise
complete what you were doing first.

## Review push gate

Do not push while a PR-boundary review is running, pending, missing, stale, or otherwise
not complete for the current head, unless the user explicitly authorizes pushing despite
that active/incomplete review. Wait for the final merged review summary for the exact head,
then fix legitimate findings before pushing another head.

## Review-result handoff gate

When a background `review-monitor` completes with `REVIEW_RESULT`, the very next
assistant response MUST start by printing a detailed user-facing review summary before
analysis, excuses, tool calls, todo updates, or fixes. Include the exact result line,
severity counts, lane status, ranked findings, summary path, monitor transcript path if
available, and the planned next action. Only after that summary may you read files,
triage findings, or edit code.

## CI-result handoff gate

When a background CI monitor completes with `CI_RESULT`, the very next assistant response
MUST start by printing a user-facing CI summary before analysis, tool calls, todo updates,
review-status checks, fixes, deploys, or pushes. Include the exact result line, monitored
head, workflow/run id and URL when present, log path, failed-log command when present, and
planned next action. Only after that summary may you inspect logs or edit code.

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
raised as a question ([[review-findings]]).
