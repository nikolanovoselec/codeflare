---
name: planning
description: "Plan changes with Vault, questionnaires, dependent TODOs and Goal handoffs."
license: MIT
---

# Planning in Codeflare

Turn the user's request into the smallest complete, executable plan. Decide what the implementer cannot infer: scope, owning files, interfaces, observable tests, evidence and delivery gates. Do not write the implementation in prose or add optional features. Planning is not permission to execute.

Use for multi-step implementation planning or an explicit plan review. Skip trivial one-file work, ordinary factual questions, and execution of an already-approved plan unless the user requests replanning. Respect the current task and any instruction to stop, pause or switch.

## 1. Establish the contract from evidence

- Read applicable `AGENTS.md`, current source/callers/configuration/tests/docs and any existing plan. With `sdd/`, read its index/config and the owning requirements. Load design guidance before planning visual work; read installed Pi docs/examples before planning SDK changes.
- Query the existing Graphify graph before broad architecture/ownership searches; check relevant Vault notes and session captures. Current source outranks stale graph/history. Do not build/refresh graphs without authorization.
- Extract the user's exact requested outcomes, corrections, non-goals, security boundaries and execution/delivery instructions. Preserve unrelated work. Separate verified facts, proposals and unresolved external contracts.
- Reuse project/platform solutions. Do not invent APIs, interfaces to an unknown alpha, requirements, dependencies, fallbacks, configuration knobs or parallel infrastructure. Unknowns get one bounded resolution task and a stop condition, not a speculative subsystem.
- Minimize implementation, not required behavior. Authentication, authorization, isolation, credential containment, fail-closed disposition, error/data-loss handling, accessibility and necessary tests remain intact. Include actionable safe logging through the project's existing observability where needed to operate/debug the change; no extra diagnostics product.

## 2. Resolve choices with the questionnaire

Search discoverable facts first. Ask only material decisions genuinely owned by the user: conflicting scope, consequential tradeoffs, missing permission or behavior that changes the design. Use one focused batch, not repeated busywork.

Use the exposed `ask_user_question` tool (the installed questionnaire extension), not an invented `ask_the_user` alias. Follow its current schema: concise headers, distinct choices, recommendation only when justified, previews only for concrete alternatives. Do not author its reserved free-text row. Cancellation/errors are not approval; do not infer approval from silence. If a platform-verified automatic choice is returned, preserve its provenance and apply only the authorization its contract actually grants. Never use timeout/default handling to bypass an explicit approval gate or protected boundary.

If active `/plan` policy only permits `plan_mode_question`, use that exposed helper instead. If no structured UI is available, ask one concise plain-text question. Do not change extension settings or widen tool policy to obtain an answer. Read `../rpiv-ask-user-question/SKILL.md` only if further questionnaire guidance is needed; actual tool schemas outrank stale examples.

## 3. Write a lean, precise plan

Default path: `~/Vault/Notes/Plans/YYYY-MM-DD-<project>-<feature>-plan.md`. **Plans go under Plans, not Projects.** Resolve to an absolute path for file tools. Use the user's explicit destination if different. Update an existing agreed plan in place rather than creating duplicate versions; inspect before replacing. If Vault is unavailable, report that and agree a destination instead of claiming it was saved. Never write captures or authoritative Vault index/config pages. Exclude secrets, credentials and sensitive raw output.

Use this shape, omitting empty sections rather than padding:

```markdown
# <Feature> implementation plan
Date / repository / branch and inspected revision
Status: draft | ready for approval | approved; actual execution gate

## Goal, scope and non-goals
Exact requested outcomes; preserved behavior/security; explicit exclusions.

## Evidence and necessary decisions
Owning requirements/source/docs; verified interfaces; material assumptions;
unresolved provider/runtime facts with a bounded resolution task and stop rule.

## Approach and constraints
Smallest complete design; reuse; exact specified defaults and permissions;
actual configuration/lifecycle/error/observability behavior. No imagined SLA.

## Tasks
### <ID>: <independently checkable deliverable>
- Depends on: <real predecessor IDs>
- Requirements/ACs: <actual owning references, or pending assignment before code>
- Files: <exact create/modify/test/docs paths; symbols instead of brittle lines>
- Interfaces: <consumed/produced names, types and signatures when verified>
- [ ] <one action with an observable result>
- Tests: <behavior/test names, assertions and specified values>
- Verification: <permitted command/runner, expected outcome, evidence to retain>
- Done when: <deliverable and required anchors/docs agree>

## Delivery and completion
User's actual commit/push/PR/review/CI/deployment order; prohibited operations;
acceptance and rollback only as needed; evidence required before completion.
```

Size tasks by meaningful deliverables, not arbitrary time estimates, every file, or reviewer-per-task gates. Include essential setup/docs with their owning deliverable unless a real dependency requires a separate phase. Keep cross-task signatures consistent. Use concise test assertions or small examples when needed to remove ambiguity; avoid full function bodies, duplicated code, placeholders such as “handle edge cases,” and scope-free “best practices.”

### SDD, tests and delivery

- Map **all approved behavior** to owning requirements/atomic ACs before implementation. Reuse existing ownership; create only missing bounded obligations. Preserve stable fragments and truthful status. Keep actual adjacent `@impl` and `@test` anchors aligned with implementing symbols and observable behavioral test blocks; link genuine manual procedures where required. Do not leave touched requirements Partial or label unverified work Implemented.
- Follow the repository's actual SDD/TDD policy. Where plan-batched TDD applies, complete the test-only RED phase before GREEN implementation; do not substitute per-task RED/GREEN loops. Non-functional changes do not need manufactured RED tests. No source/private-call/mock-count test theatre.
- Record actual RED/GREEN evidence, not expectations as results. Use permitted background checks; local tests go through `safe-local-checks`, with builds/CI-only checks remaining on their permitted runner. Never invent a runner, bypass safeguards, or hide a missing verification method.
- Preserve the user's push/review/deploy sequencing exactly. “Deliver RED/GREEN together” means no intermediate RED push/PR. Do not impose that sequence on other tasks without such an instruction.
- Do not add PRs, reviewer launches, deployments, merges or production actions by default. When requested, use their owning skills, exact-head evidence and current authorization. Respect immediate turn-ending after qualifying PR mutations and only execute an actual later boundary plan. No automatic reviewer fanout or merge.

## 4. Self-review, then stage TODOs

Check the plan against the request/spec: every requested outcome has a task/test; every planned behavior is requested or necessary; no weak security workaround, invented fact, duplicate subsystem, signature mismatch or unowned verification gap. Check the important failure cases implied by the feature rather than manufacturing a fixed quota of risks. Cut prose that decides nothing. Use `advisor` only when the user explicitly requests advisor in the current message; do not create a mandatory review ceremony or suggest it as an automatic planning step.

Once the plan is accepted, or the user asks for implementation tasks, use the exposed `todo` tool for pending tasks and genuine `blockedBy` dependencies. Read `../rpiv-todo/SKILL.md` if not already loaded. List first, reuse/update related tasks, preserve unrelated tasks, and avoid duplicate plan/task inventories.

- For tasks derived from an existing Vault plan, follow the Todo skill's **Vault-plan task contract**; it owns the reference format and start/resume rereading procedure. Keep only task-specific action/acceptance context in descriptions rather than copying the plan. Record returned TODO IDs in the plan.
- Create prerequisites first and use returned IDs; a batch may contain independent tasks but cannot reference sibling IDs not yet created. Never guess IDs.
- Leave implementation tasks pending until authorized. During execution keep at most one task `in_progress`, complete each immediately when verified, and reconcile plan/TODO state after material changes. Saving a plan does not complete implementation tasks.

If the user requested plan-only, do not start execution, create unrelated tasks or manufacture an execution method. Reuse the approved workflow rather than asking the same preferences again.

## 5. Respect Plan mode and hand off to Goal mode honestly

A skill supplies guidance; it does not activate an extension. `/skill:planning` works in normal mode. `/plan` is a separate installed extension with a restrictive tool policy, and `/goal` controls automatic continuation. Do not silently start, stop, resume or configure either extension; they may be mutually exclusive.

**While `/plan` is explicitly active:** obey its current contract. Do not use Bash to evade blocked writes/TODO tools or modify extension state files. Submit the complete Markdown through `plan_mode_complete({ plan })` **alone as the final action**, only when the plan is decision-ready. The user can export through `/plan export <absolute Vault plan path>` and choose the extension's save/implementation route. Do not claim a Vault file or live TODOs exist until actually saved/created through an allowed route; stage missing TODOs after returning to an authorized mode.

**Goal handoff:** ask for the user's approval using their exact requested gate, such as `GO$`; do not invent a new gate if they supplied one. Do not start implementation while approval is pending. A user's explicit implementation approval can authorize ordinary execution without automatically enabling Goal mode.

When the user wants Goal-driven execution, provide a concise `/goal` objective referencing the **absolute approved plan path**, its existing TODO IDs, exact scope/non-goals, verification requirements, delivery order and prohibited actions. Reference the plan instead of copying its full contents; Goal objectives are limited to 4,000 characters. Let the user start/resume Goal mode through its supported command/UI. Do not create a fake goal-start tool or edit Goal settings/state, budgets, model or reasoning choices.

If Goal mode is already active, retain the latest actual contract and matching `goal_id`; tool visibility or a plan's word “Goal” is not activation. Planning completion is not implementation completion. Call `goal_complete` only when evidence verifies **every requirement of the actual current objective**; use block helpers only when exposed and justified by that contract and applicable retry policy. Managed Codeflare prohibits `goal_wait`; do not call or reactivate it. Use current `goal_progress` reporting when the active contract requires it. Arrange permitted asynchronous continuation for external work; do not busy-wait or terminally block for normal clarification. Approval, PR-boundary and security gates remain binding during automatic continuation.

Finish by reporting the saved plan path, pending TODO readiness, unresolved material facts and the next user action. Do not claim runtime behavior, model-quality improvement or extension activation from static validation alone. After editing this skill, ask the user to `/reload`; explicit invocation is `/skill:planning`.

MIT attribution: `../_licenses/superpowers-MIT.txt`.
