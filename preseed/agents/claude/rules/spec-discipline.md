# Spec Discipline

Applies when `sdd/` exists. Inert otherwise.

**Trigger:**
- PR-boundary event (PR opens or syncs against `main`/`master`) → spec-reviewer fires.
- `/sdd clean` invocation.
- Any `/sdd init` / `/sdd edit` / `/sdd add` invocation.

**Route:**
- `spec-driven-development` skill - workflow for `/sdd` sub-commands. Carries REQ format, the 8-field structure, autonomy modes, templates, "What is NOT a requirement", files-alongside catalog.
- `spec-enforce` skill (spine) - 19-row execution manifest on PR-boundary + `/sdd clean`. Carries severity/mode table, REQ rendering template, status-drift rules, changelog discipline. Conditionally invokes `spec-enforce-ac` (when ACs touched) and `spec-enforce-truth` (when Implemented or Partial REQs touched or scope=all — Partial included for CQ-SOURCE anchor validation).

## Status vocabulary (mid-task keepsake)

| Status | Meaning |
|---|---|
| `Proposed` | Being drafted |
| `Planned` | Committed, not yet built |
| `Partial` | Built but some AC unmet OR no automated verification |
| `Implemented` | Built AND tests verify the ACs |

Full Status semantics + transition rules live in `spec-driven-development` skill § "Status semantics" and `spec-enforce` skill § "Status field semantics".

## Lane separation

`spec-reviewer` owns `sdd/` only. `doc-updater` owns `documentation/` + root `README.md`. Other agents own source. Sequential PR-boundary execution: spec-reviewer first, doc-updater second.

## Commit-prefix contract (load-bearing)

Agent-authored commits MUST start with `[autonomous]`, `[unleashed]`, `[spec-reviewer]`, `[doc-updater]`, or `[code-reviewer]`. Excluded (bulk ops): `[sdd-clean]`, `[sdd-init]`, `[sdd-triage]`. Plain commits = user-authored, reset the round counter. Full 5-round-limit mechanics in `spec-enforce`.

Skipping enforcement-skill invocation when the trigger fires is itself HIGH `enforcement-skill-not-invoked`.
