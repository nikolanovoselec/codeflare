---
name: rpiv-todo
description: Track a multi-step task as a live to-do overlay (tool todo) that survives /reload and conversation compaction. Create/update/list/get/delete/clear tasks with a 4-state machine and blockedBy dependencies.
---

# Todo (Pi)

Provides the **`todo`** tool: create / update / list / get / delete / clear tasks. A 4-state machine (`pending` → `in_progress` → `completed`, plus a `deleted` tombstone), `blockedBy` dependency tracking with cycle detection, rendered as a live overlay. Tasks persist via branch replay, so they **survive session compaction and `/reload`**.

## When to use

- A task with **3+ distinct steps** or multiple files/phases, where tracking progress across turns matters.
- Work likely to span a **compaction or `/reload`** — the list is the durable memory of what's done and what's left.
- When the user hands you a multi-part request and you want to show, and keep, a plan.

Mark exactly one task `in_progress` at a time; flip it to `completed` the moment it's done (don't batch completions). Use `blockedBy` when one step genuinely gates another.

## When NOT to use

- Single-step or trivial tasks — a todo list is overhead, just do it.
- As a substitute for actually doing the work, or to narrate steps you'll do immediately anyway.
