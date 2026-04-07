# Plan

Shortcut that enters Plan Mode with SDD awareness. Discipline lives in Plan Mode itself.

## Behavior

1. Check if `sdd/` exists in the project root.
2. Enter Plan Mode (Claude Code: `EnterPlanMode`; other agents: equivalent planning primitive). "Go" / "execute" / "build now" authorize starting this command, never skipping Plan Mode.
3. Inside Plan Mode, follow `Plan Mode integration` in the `spec-driven-development` skill: read `sdd/`, filter to `Planned`+`Partial`, topo-sort by `Dependencies:`, present RED/GREEN/VERIFY phases, author RED via `tdd-guide`, name the test framework.
4. If `sdd/` does not exist: still enter Plan Mode, present a generic plan for `$ARGUMENTS`.

## Arguments

`$ARGUMENTS`: optional task description. Informational when `sdd/` exists (REQs drive the plan).
