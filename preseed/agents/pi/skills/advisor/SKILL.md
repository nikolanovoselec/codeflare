---
name: advisor
description: User-invoked only. Never call the advisor tool, run /advisor, or suggest /advisor unless the user's current request explicitly asks for advisor. Forbidden for proactive planning, review, debugging, risk checks, stuck states, or completion checks.
---

# Advisor (Pi): User-Invoked Stronger-Model Review

The `advisor` tool (provided by the `@juicesharp/rpiv-advisor` extension) hands the **entire current conversation branch** to a stronger reviewer model and returns guidance.

## Hard gate — user request only

Only the user may invoke advisor. Do **not** call the `advisor` tool, run `/advisor`, or suggest `/advisor` unless the user's current message explicitly asks for advisor, for example:

- `/advisor`
- "ask the advisor"
- "use the advisor"
- "call advisor"
- "check this with the advisor"

The assistant must not invoke advisor proactively for:

- planning;
- being stuck;
- routine debugging or CI fixes;
- code review;
- risky or irreversible actions;
- before writing, committing, pushing, deploying, or declaring done;
- generic "second opinion" requests that do not name advisor.

If advisor might help but the user did not explicitly ask for it, continue without advisor or ask a normal clarification question. Do not mention advisor as a required step, and do not tell the user to run `/advisor` proactively.

## Configuration

Advisor authenticates through **Pi's model registry** and uses the model selected by the user through the user-only `/advisor` command. The selection persists across sessions at `~/.config/rpiv-advisor/advisor.json`. Only the user should open `/advisor`; the assistant must not run, simulate, or recommend that command unless asked.

## When explicitly requested

When the user's current message explicitly requests advisor, call `advisor` with no parameters. Relay the returned guidance and make clear what, if anything, it changes.

## Troubleshooting

If the `advisor` tool is unavailable or returns an error, report that directly. Do not retry repeatedly and do not substitute another external LLM unless the user explicitly asks for that.
