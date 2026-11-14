---
name: rpiv-todo
description: Track a multi-step task as a live to-do overlay (tool todo) that survives /reload and conversation compaction. Create/update/list/get/delete/clear tasks with a 4-state machine and blockedBy dependencies.
disable-model-invocation: true
---

# Todo (Pi)

Provides the **`todo`** tool: create / update / list / get / delete / clear tasks. A 4-state machine (`pending` → `in_progress` → `completed`, plus a `deleted` tombstone), `blockedBy` dependency tracking with cycle detection, rendered as a live overlay. Tasks persist via branch replay, so they **survive session compaction and `/reload`**.

## When to use

- A task with **3+ distinct steps** or multiple files/phases, where tracking progress across turns matters.
- Work likely to span a **compaction or `/reload`** — the list is the durable memory of what's done and what's left.
- When the user hands you a multi-part request and you want to show, and keep, a plan.

Mark exactly one task `in_progress` at a time; flip it to `completed` the moment it's done (don't batch completions). Use `blockedBy` when one step genuinely gates another.

## Vault-plan task contract

Applies when creating or updating TODOs from an **existing Vault plan**. Do not require a plan for unrelated tasks or create a new plan merely to satisfy this rule.

**At creation:** read the relevant plan passages and begin each task's `description` with a **READ FIRST at task start/resume** instruction containing the absolute plan file path, exact owning section heading, and related scope, constraints, acceptance/evidence and approval sections needed for that task. Use verified headings (optionally anchors), not brittle line numbers, a bare file link or an entire copied plan. Include the bounded action and completion criteria; the plan retains the detailed contract. Metadata alone is insufficient because an executor must see these instructions in the task description.

```text
READ FIRST at task start/resume: /home/user/Vault/Notes/Plans/<actual-plan>.md
Own section: <exact task heading>
Related sections: <verified headings needed for this task>
Then: <bounded action and observable completion criteria; preserve approval gates>
```

**At start/resume:** the task owner obtains the current task with `todo` action `get`, then uses an exposed file reader to reread its named plan passages before execution, including after reload or compaction. For delegation, forward the read-first references in the worker assignment; the worker reads those passages rather than assuming the parent's session-local TODO IDs exist in its own session. Follow references needed for acceptance criteria; do not reread the whole plan on every tool call. A reference does not auto-load the file or authorize work: check prerequisites and current user approval before marking the task `in_progress` or mutating anything.

If the file moved or a heading no longer resolves, locate and verify the current reference; ask only if unresolved. Do not guess the missing contract or silently execute from an outdated task summary. Keep references current when the plan changes, updating existing tasks without resetting their status, dependencies or approval gates. This is agent guidance, not automatic enforcement by the TODO extension.

## 2.15 atomic creation and dependency ordering

Create independent tasks together with the public `tasks` array:

```json
{"action":"create","tasks":[{"subject":"Inspect published API"},{"subject":"Read managed guidance"}]}
```

Use either a single `subject` or a nonempty `tasks` array, never both. Batch fields such as `description`, `activeForm`, `blockedBy`, `owner` and `metadata` belong on each item, not at the top level. The entire batch is validated before committing: one invalid item leaves the task list unchanged.

A batch item's `blockedBy` may name only already-existing tasks, not siblings in that batch. Create a prerequisite first, read its returned ID, then create the dependent with `blockedBy: [<returned ID>]`; do not guess future IDs. Keep dependency chains ordered across calls. Batch creation does **not** change the one-`in_progress` rule or authorize batching completions. To change status, use `{"action":"update","id":3,"status":"completed"}` with the actual task ID.

## When NOT to use

- Single-step or trivial tasks — a todo list is overhead, just do it.
- As a substitute for actually doing the work, or to narrate steps you'll do immediately anyway.
