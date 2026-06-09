# Spec Discipline

Applies when `sdd/` exists. Inert otherwise.

**Trigger:**
- PR-boundary event (PR opens or syncs against `main`/`master`) → spec-reviewer fires.
- `/sdd clean` invocation.
- Any `/sdd init` / `/sdd edit` / `/sdd add` invocation.

**Route:**
- `spec-driven-development` skill - workflow for `/sdd` sub-commands. Carries REQ format, the 8-field structure, autonomy modes, templates, "What is NOT a requirement", files-alongside catalog.
- `spec-enforce` skill (spine) - 20-row execution manifest on PR-boundary + `/sdd clean`. Carries severity/mode table, REQ rendering template, status-drift rules, changelog discipline. Conditionally invokes `spec-enforce-ac` (when ACs touched) and `spec-enforce-truth` (when Implemented or Partial REQs touched or scope=all — Partial included for CQ-SOURCE anchor validation).

## Status vocabulary (mid-task keepsake)

| Status | Meaning |
|---|---|
| `Proposed` | Being drafted |
| `Planned` | Committed, not yet built |
| `Partial` | Built but some AC unmet OR no automated verification |
| `Implemented` | Built AND tests verify the ACs |

Full Status semantics + transition rules live in `spec-driven-development` skill § "Status semantics" and `spec-enforce` skill § "Status field semantics".

## Lane separation

`spec-reviewer` owns `sdd/` only. `doc-updater` owns `documentation/` + root `README.md`. Other agents own source. PR-boundary review runs all three lanes **in parallel**: the reviewers are report-only (findings go to a lane triage file; the main session applies fixes), so there is no shared-write race or spec→doc ordering dependency. (`/sdd clean` is different — it *applies* fixes inline and runs spec-enforce before doc-enforce, since doc cross-references depend on the just-fixed spec.)

## Commit-prefix contract (load-bearing)

Agent-authored autonomous/review-loop commits MUST start with `[autonomous]`, `[unleashed]`, `[spec-reviewer]`, `[doc-updater]`, or `[code-reviewer]`. Example: PR opens → review agents run → findings are generated → the agent fixes findings → the agent pushes; that fix commit is `[autonomous]`. Excluded (bulk ops): `[sdd-clean]`, `[sdd-init]`, `[sdd-triage]`. User-directed commits made during ordinary requested work use normal plain commit messages and reset the round counter. Full 5-round-limit mechanics in `spec-enforce`.

Skipping enforcement-skill invocation when the trigger fires is itself HIGH `enforcement-skill-not-invoked`.
