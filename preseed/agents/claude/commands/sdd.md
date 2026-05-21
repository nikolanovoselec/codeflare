# Spec-Driven Development

Turn rough product ideas into structured specifications. Keep the spec honest as the project grows. The spec is the single source of truth for **what the product does and why**.

**Route:** invoke the `spec-driven-development` skill. It carries the full workflow for every sub-command (init, edit, add, clean, mode), the canonical REQ render, the Phase 5 enrichment pass, the templates, and the mode semantics.

## When the user types `/sdd` with no arguments

Print this help screen and exit. Do not invoke any sub-command.

```
sdd — spec-driven development

USAGE
  /sdd                              Show this help
  /sdd <subcommand> [arguments]     Run a subcommand

SUBCOMMANDS
  init [idea]            Bootstrap a new project (greenfield) OR derive a spec
                         from existing source (import). Re-running while
                         sdd/.init-triage.md has open items resumes triage.
  edit <domain>          Add or modify requirements in an existing domain.
  add <domain>           Create a new domain in an existing spec.
  clean                  Refactor a rotted spec. Mode-aware. Flags:
                           --scope=all (default) | --scope=diff
                           --interactive | --auto | --unleashed
  mode <name>            Set autonomy mode: interactive | auto | unleashed
                         (no arg prints current mode).

MODES
  interactive  (default)   Agent confirms every fix.
  auto                     Auto-fix CRITICAL+HIGH+MEDIUM; defer LOW.
                           JUDGMENT → triage file (sdd/spec/.review-queue.md
                           nested, sdd/.review-needed.md flat legacy).
  unleashed                Auto-fix everything including LOW + JUDGMENT
                           (conservative). Refuses to run on enforce_tdd: false.

  Mode is sticky per project (sdd/config.yml). /sdd clean honors it.

WORKFLOW
  /sdd init              Bootstrap once per project.
  Triage drains          Resolve every open item via Resume Mode.
  /sdd edit/add          Iterate on the spec as features land.
  PR-boundary review     spec-reviewer + doc-updater fire automatically.
  /sdd clean             Run periodically (or after rotted spec is detected).

FILES
  sdd/                   The spec. Nested layout: sdd/README.md + sdd/spec/
                         (per-domain .md + glossary.md + constraints.md +
                         changes.md + .review-queue.md + config.yml). Flat legacy:
                         sdd/*.md at the top level.
  documentation/         The how. Nested layout: documentation/README.md +
                         documentation/lanes/ (architecture, api-reference,
                         configuration, deployment, security, troubleshooting)
                         + documentation/decisions/. Flat legacy: flat files
                         under documentation/.
  pending.md             TODOs / known gaps not yet ready to be REQs.

For full workflow details: invoke the spec-driven-development skill.
```

## When the user types `/sdd <subcommand>`

Parse `$ARGUMENTS`. Match the first token and dispatch:

| Sub-command | Skill to invoke |
|---|---|
| `init [idea]` | `sdd-init` skill |
| `clean [--scope=...] [--mode-override]` | `sdd-clean` skill |
| `edit <domain>` | `spec-driven-development` skill (§ /sdd edit) |
| `add <domain>` | `spec-driven-development` skill (§ /sdd add) |
| `mode [name]` | `spec-driven-development` skill (§ /sdd mode) |

For `init` and `clean`, the sub-command skills reference `spec-driven-development` in their descriptions so REQ format, Status semantics, and templates surface alongside.

Unknown sub-command: print the help screen, exit.

## Hard gates (apply before any sub-command runs)

1. `git status --porcelain` must be empty (clean working tree). Refuse otherwise with the dirty-tree message.
2. If sub-command is `clean` or `mode`: `sdd/` must exist; otherwise tell the user to run `/sdd init` first.
3. If sub-command is `init` and `sdd/` already exists: enter Resume Mode if `sdd/.init-triage.md` has open items, else inform the user `/sdd init` has already run and suggest `/sdd edit` or `/sdd add`.

The skill body owns everything else.
