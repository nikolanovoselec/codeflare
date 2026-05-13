---
name: doc-enforce-truth
description: SDD documentation truth-check / source-of-truth enforcement. Runs Pass 8 (verification truth-check), Pass 9 (Implements-vs-AC cross-walk), Pass 10 (stale code-block detection), Pass 11 (content-preservation on trim), Pass 12 (stranger cold-read). Invoked conditionally by doc-enforce when Implemented REQ docs are touched OR scope=all.
version: 1.0.0
---

# Documentation Enforcement — Truth-check passes

This skill cross-references documentation against source code, tests, and REQs to catch stale, mismatched, or lying prose. Invoked by `doc-enforce` (the spine) when Implemented REQ docs are touched or scope=all.

## Inputs

- `diff`: git diff against base
- `scope`: `all` | `diff`
- `mode`: `interactive` | `auto` | `unleashed`
- `src_globs`: from `sdd/config.yml`
- `test_globs`: from `sdd/config.yml`

## Output

Returns findings array + auto-fix actions. Writes evidence-count rows back to the spine's manifest:
- `Pass 8 — Verification truth-check`: `ran (V fields, F files, M findings)`
- `Pass 9 — Implements-vs-AC cross-walk`: `ran (I fields, M findings)`
- `Pass 10 — Stale code-block detection`: `ran (B blocks, M findings)`
- `Pass 11 — Content-preservation on trim`: `ran (T ops, M findings)` or `inert (no trim ops)`
- `Pass 12 — Stranger cold-read`: `ran (T tasks, M findings)` or `ran (cached, hit on SHA <sha>)`

## Pass 8 — Verification truth-check

For every `**Verification:** <test-file>` field, open the cited file and check:

1. The section's `**Implements:** REQ-X-NNN` ID appears in a `describe`/`test`/`it` block name within the cited file.
2. At least one content-word token (>=4 chars, stopwords excluded) from the section's `**Threat:**` or `**Mitigation:**` prose appears anywhere in the cited file.

Neither match: MEDIUM `verification-field-cites-unrelated-test`. The cited file existing on disk is necessary but not sufficient.

Multiple files (comma- or `+`-separated) evaluated independently; if at least one passes, the field passes; first file is load-bearing.

Auto-fix in `auto`/`unleashed`: rewrite failing field to `**Verification:** {kept-files}` (drop unrelated). If every file failed, replace with `**Verification:** audit pending — see documentation/.doc-coverage.md` and append entry.

## Pass 9 — Implements-vs-AC cross-walk

For every `**Implements:** REQ-X-NNN` (or `REQ-X-NNN AC N`) field, read the linked REQ's Intent and ACs and classify the section-vs-REQ relationship:

| Classification | Severity | Auto-fix |
|---|---|---|
| (a) Section describes a specific AC's behaviour, cited AC matches | no finding | Accept |
| (b) Section describes generic REQ context, field cites REQ without AC suffix | no finding | Accept |
| (b') Section describes generic context but field cites specific AC | MEDIUM `implements-field-too-narrow` | Strip AC suffix |
| (c) Section describes behaviour outside every AC of linked REQ | HIGH `implements-field-mismatched` | Replace with better-match REQ or mark audit pending |

If multiple ACs plausibly match: MEDIUM `implements-field-low-confidence` rather than auto-rewrite. Under-flag rather than over-rewrite.

## Pass 10 — Stale code-block detection

For every fenced code block, `**Path:** /api/foo` field, function signature in body, JSON shape example, resolve against `src_globs` from `sdd/config.yml`:

1. **Route paths**: any `**Path:**` or fenced block whose first line is HTTP method + path. Resolve via filename convention. HIGH `route-not-in-source` if no handler resolves; MEDIUM `route-handler-renamed` if near-match at sibling path.
2. **Function signatures**: any `function foo(...)` etc. in body prose or fenced TS/JS. Resolve via `src/**` grep. MEDIUM `function-signature-drift` if different params/types. HIGH `function-removed` if no longer exported.
3. **JSON shape examples**: any fenced `json` block paired with `**Response:**`/`**Request:**`. Compare top-level keys against matching TS type. MEDIUM `json-example-shape-drift`. Prefer `tests/fixtures/` fixture when present.
4. **Env var references**: any `**Variable:** FOO_BAR` or `env.FOO_BAR`. Grep `src/**`. HIGH `env-var-removed-from-source` if no consumer.

Auto-fix in `auto`/`unleashed`: for shape-drift, regenerate from source. Never delete a stale block silently; replace or flag.

## Pass 11 — Content-preservation on trim

When the spine proposes a Pass 1 trim, tokenise removed content clause-by-clause. For each removed clause, check whether its content tokens reappear in: the kept body, surrounding prose, parent section's `**Rationale:**`/`**Consequences:**`/`**Context:**`, or linked ADR body.

Three outcomes:
- All removed clauses match elsewhere: trim commits as-is.
- Some clauses are context-loss but relocation exists (adjacent paragraph, ADR, parent prose): promote with leading `Trimmed from <bullet/section> on <date>:` marker, then commit. Commit body lists `trimmed N clauses; preserved K; promoted M to {target}`.
- Clauses are context-loss with no relocation target: trim is REVERTED. MEDIUM `trim-would-lose-load-bearing-content` listing the bullet and clauses. Cap violation persists; content preserved.

## Pass 12 — Stranger cold-read

For each top-level canonical file, dispatch a fresh subagent (`general-purpose` subtype; **not** `doc-updater`, must come in cold) with: (i) only the contents of the one doc file, (ii) a simulated task. Default task registry:

| File | Simulated task |
|---|---|
| `api-reference.md` | "Call the most-used public endpoint and parse the response. Output the exact curl command + field list." |
| `api-reference-admin.md` | "Manually trigger a backend job listed in this file. Output exact request + success signal." |
| `architecture.md` | "Find the source file that owns request authentication for admin endpoints. Output the path." |
| `configuration.md` | "List every env var the dev-bypass code path consumes. Output: name, type, default, consumed where." |
| `deployment.md` | "Roll back the last production deploy. Output exact commands in order + verification between steps." |
| `security.md` | "External researcher claims session cookie is readable from JavaScript on prod. Refute or confirm using only the doc; output load-bearing sentence." |
| `troubleshooting.md` | "User reports 500 after login. Output first three diagnostic steps from the doc." |
| `decisions/README.md` | "Why was the most recent ADR raised? Output ADR ID and one-line reason." |

Subagent reports `succeeded` / `partial` / `failed`. Partial and failed: MEDIUM `stranger-cold-read-gap` naming the specific information the doc failed to surface.

Project-overridable via `documentation/.cold-read-tasks.yml`. Pass runs at most once per PR-boundary trigger (caches on commit SHA + file mtime). No auto-fix; signal only; written to `documentation/.doc-coverage.md` under `## Cold-read gaps`.

## Severity application

| Severity | Definition |
|---|---|
| **HIGH** | `route-not-in-source`, `function-removed`, `env-var-removed-from-source`, `implements-field-mismatched` (Pass 9 case c) |
| **MEDIUM** | `verification-field-cites-unrelated-test`, `route-handler-renamed`, `function-signature-drift`, `json-example-shape-drift`, `implements-field-too-narrow`, `implements-field-low-confidence`, `trim-would-lose-load-bearing-content`, `stranger-cold-read-gap` |
| **LOW** | none in this skill |

Mode-dependent action mirrors the spine.
