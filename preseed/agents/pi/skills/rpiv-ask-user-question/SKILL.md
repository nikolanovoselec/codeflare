---
name: rpiv-ask-user-question
description: Ask the user a structured, multiple-choice question (tool ask_user_question) instead of guessing when a decision is genuinely the user's to make. Tabbed single/multi-select dialog with previews and an "Other" free-text fallback.
---

# Ask User Question (Pi)

Provides the **`ask_user_question`** tool: present one or more structured questions, each with 2+ typed options, optional `multiSelect`, optional per-option `preview`, and an automatic free-text "Other" fallback. Returns the user's selection(s) plus any notes.

## When to use

Use it only when a decision is **genuinely the user's to make** and you cannot resolve it from the request, the code, or sensible defaults — and the answer changes what you do next:

- Choosing between materially different approaches (auth method, library, data model) where each is a reasonable, mutually-exclusive choice.
- Confirming a hard-to-reverse or outward-facing action before doing it.
- Disambiguating a request that has two+ valid readings.

## When NOT to use

- A choice with a conventional default → pick it, state it, proceed.
- A fact you can verify yourself in the codebase → look it up.
- "Should I proceed?" / "Is this OK?" busywork → just do the obvious thing and report.

## How

`ask_user_question` with 1–4 questions; each question has a short `header` chip and 2–4 options with a `label` + `description`. Put your recommended option first and mark it `(Recommended)`. Use `multiSelect: true` only when choices are not mutually exclusive. Use `preview` to show side-by-side artifacts (mockups, code snippets) the user must compare.
