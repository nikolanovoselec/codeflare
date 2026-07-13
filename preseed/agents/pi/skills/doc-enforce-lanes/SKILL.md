---
name: doc-enforce-lanes
description: Pi-native documentation lane ownership and layout enforcement.
version: 3.0.0
---

# Pi Documentation Lane Enforcement

Operate only on the file set resolved by `doc-enforce`; `scope=all` supplies every doc file.

## Owner lanes

| Content | Owner |
|---|---|
| Layout, components, data flow, integration boundaries | `architecture.md` |
| HTTP methods, paths, status, request/response schemas | `api-reference*.md` |
| Environment variables, defaults, and consumption | `configuration.md` |
| Deploy, rollback, migrations, operator commands | `deployment.md` |
| Threat model, auth, authorization, rate-limit rationale | `security.md` |
| Symptom, cause, fix recipes | `troubleshooting.md` |
| Decision context, choice, alternatives, consequences | `decisions/README.md` |

An admin route may split its contract into API reference and its runbook into deployment. Do not duplicate a full narrative.

## Valid layout

Nested layout allows:

- `documentation/README.md`;
- seven standard files under `documentation/lanes/`;
- first-level `api-reference-*.md` siblings;
- any other first-level project lane explicitly linked from `documentation/README.md`;
- `documentation/decisions/README.md` and recognized audit/support files.

A first-level project lane linked by the index is valid. Unindexed lanes and nested lane subdirectories are HIGH `layout-violation`. Flat legacy layout uses the same ownership rules at `documentation/*.md`.

## Pass 3: implementation prose

Flag AC-shaped normative prose (`must`, `shall`, `the system rejects`) when docs are acting as the only specification. If a matching REQ exists, suggest a concise explanation plus backlink. If none exists, HIGH `unspec-feature-documented`. Exclude fenced examples and explicit runbook steps.

## Pass 4: lane violations

Flag these concrete mismatches:

- method/path/status contract outside API reference;
- env/default/consumption details outside configuration;
- copy-paste deploy commands outside deployment (except a troubleshooting Fix block);
- symptom/cause/fix outside troubleshooting;
- threat/auth rationale outside security or ADR;
- decision rationale outside ADR.

Also flag:

- inline Big-O jargon without a measured requirement or actual algorithm section;
- an accepted ADR containing two current decisions instead of a superseding ADR;
- stale historical mechanics described as current behavior.

## Output

Return Pass 3 and Pass 4 evidence counts. Each finding names source section, detected signature, owner lane, severity, and move/rewrite recommendation. Review purpose reports only; clean purpose may move text only when content and backlinks are preserved.
