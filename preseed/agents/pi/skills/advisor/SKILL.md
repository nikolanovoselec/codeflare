---
name: advisor
description: Escalate the current work to a stronger reviewer model for a second opinion via the advisor tool. Use when stuck on a hard decision, before a risky or irreversible action, to sanity-check a plan or approach, or when the user says "ask the advisor", "get a second opinion", "check with a stronger model", "am I on the right track", "/advisor".
---

# Advisor (Pi): Escalate to a Stronger Reviewer Model

The `advisor` tool (provided by the `@juicesharp/rpiv-advisor` extension) hands the **entire current conversation branch** to a stronger reviewer model and returns its guidance — a concrete **plan**, a **correction** if you are going down a wrong path, or a **stop signal** telling you to halt and escalate to the user. It is the "let me check this with a smarter model before I act" move.

This is distinct from [consult-llm](../consult-llm/SKILL.md): `advisor` auto-forwards the whole conversation to a model from **Pi's own model registry** (zero parameters, no prompt to write), whereas `consult_llm` asks external OpenAI/Gemini a prompt you compose. Use `advisor` to review *your current trajectory*; use `consult_llm` to ask an outside question.

## No API keys

`advisor` authenticates through **Pi's model registry** — it reuses whatever auth Pi already has for the chosen model, so there is **no separate API key**. Picking a stronger model on the **same provider as your session** just works (same credentials/gateway). It develops on your normal model and reviews on a stronger one, exactly as configured.

## Step 1 — Select the reviewer model (one-time, `/advisor`)

The `advisor` tool is **inactive until a model is selected.** Run the `/advisor` slash command:

- It opens a picker over **any model in Pi's registry** (fuzzy-filter by name or `provider/id`) plus a reasoning-effort picker for reasoning-capable models.
- The selection **persists across sessions** (`~/.config/rpiv-advisor/advisor.json`).
- Choose **"No advisor"** to disable it.

Pick a model genuinely stronger than your executor model (that is the point of escalation).

## Step 2 — Call `advisor` when it adds value

Call `advisor` (zero parameters — the full conversation branch is serialized automatically) when:

- You are **stuck** on a decision you cannot confidently resolve alone.
- You are about to take a **risky or irreversible** action and want a sanity check first.
- You want a **plan reviewed** or a chosen approach validated before committing to it.
- You suspect you may be on the **wrong path** and want a course-correction.

Do **not** call it for trivial steps — it is a deliberate escalation, not a per-step reflex.

## Step 3 — Act on the guidance

The reviewer returns one of: a **plan** (follow the concrete next steps), a **correction** (redirect — you were heading the wrong way), or a **stop signal** (halt and escalate to the user). Integrate the guidance into your work; tell the user when you escalated and what the advisor changed.

## Examples

- About to refactor a load-bearing module and unsure of the approach → `advisor()` → follow the returned plan, then proceed.
- "ask the advisor whether this migration is safe" → `advisor()` → relay its verdict and act on it.
- Two reasonable designs and you cannot decide → `advisor()` → adopt the recommended one, note the runner-up.

## Troubleshooting

If the `advisor` tool is not available or returns an error:

1. Run `/advisor` and select a model — the tool is inactive until one is chosen.
2. "No API key" means the selected model's provider is not authenticated in this session; pick a model on a provider Pi already has (e.g. the same provider as your current session) and retry.
3. The selection persists, so you only configure it once per environment.
