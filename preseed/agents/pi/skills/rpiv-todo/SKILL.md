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
