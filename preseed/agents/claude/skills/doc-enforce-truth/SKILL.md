---
name: doc-enforce-truth
description: SDD documentation truth-check / source-of-truth enforcement. Runs Pass 8 (verification truth-check), Pass 9 (Implements-vs-AC cross-walk), Pass 10 (stale code-block detection), Pass 11 (content-preservation on trim), Pass 12 (stranger cold-read), Pass 15 (doc source-anchor truth-check, ALWAYS runs). Invoked conditionally by doc-enforce when Implemented REQ docs are touched OR scope=all.
version: 2.0.0
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
- `Pass 15 — Doc source-anchor truth-check`: `ran (D docs, A anchors verified, V drift, O orphaned, U unanchored)` — ALWAYS runs, never inert

**Layout-awareness.** Doc file discovery uses `documentation/lanes/**/*.md` and `documentation/decisions/**/*.md` when the nested layout exists; falls back to `documentation/*.md` and `documentation/decisions/*.md` on flat layout.

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

## Pass 15 — Doc source-anchor truth-check (ALWAYS runs)

Pass 15 is the doc-lane mirror of `spec-enforce-truth` CQ-SOURCE. It enforces the Truth guarantee for documentation: every load-bearing fact in a lane file must trace to source either via inline `<!-- @impl: <path>::<symbol>[ = <value-pattern>] -->` anchor OR via REQ backlink to a spec REQ whose AC carries an anchor (transitive verification).

**This pass runs unconditionally** — independent of `enforce_tdd`, independent of SDD transition state. Doc content that lies about source is the failure mode this guarantee exists to prevent.

### Scope and detection

Walk every `documentation/lanes/**/*.md` file (or `documentation/*.md` flat) plus `documentation/decisions/README.md`. Within each file, identify load-bearing facts:

1. **Build-constants tables** in `configuration.md` (rows like `kMaxRetries | constants.dart | 3`).
2. **Persistence claims** in `architecture.md` (lines like "├─ persist to shared_preferences (UUID key)", "stored in D1 column session_version").
3. **Lifecycle arrows** in `architecture.md` Request Lifecycles sections.
4. **ADR `Context:` blocks** in `documentation/decisions/README.md` (the chosen-path Context paragraph).
5. **Per-endpoint contracts** in `api-reference*.md` (Method/Path triplets).
6. **Per-control claims** in `security.md` (Threat → Mitigation citing specific source mechanism).
7. **Per-signal entries** in `observability.md` (event names from the structured-log emitter).

Each load-bearing fact must satisfy ONE of:

- (a) Carries inline `<!-- @impl: <path>::<symbol>[ = <value-pattern>] -->` HTML comment trailing the fact (single line) or trailing the section's title line (section-wide anchor).
- (b) Section header carries `(REQ-X-NNN)` backlink AND the linked REQ's AC carries an anchor that CQ-SOURCE has validated.

### Validation contract (identical to spec-enforce-truth CQ-SOURCE)

For each direct `<!-- @impl: ... -->` comment in a doc file:

1. **Resolve symbol** via `mcp__graphify__get_node(<symbol>)`. Fallback: grep `<symbol>` in `<path>`. Symbol not resolved → HIGH `doc-anchor-orphaned` listing file, section, anchor.
2. **Verify value (when `<value-pattern>` present).** Grep symbol body for literal pattern. Not found → HIGH `doc-value-drift`.
3. **Verify behaviour overlap (when no `<value-pattern>`).** Token overlap between the fact's surrounding prose (≥4-char content words) and the symbol body must be ≥3. Below threshold → MEDIUM `doc-behavior-orphaned`.

For each load-bearing fact WITHOUT direct anchor AND WITHOUT REQ backlink: MEDIUM `doc-fact-not-anchored` listing file, section, the fact. Auto-fix in `auto`/`unleashed`: best-effort retrofit — attempt to source-scan the fact's noun phrase against the project source via graphify; on plausible match, insert `<!-- @impl: ... -->`. On no plausible match, escalate to `documentation/.doc-coverage.md` under `## Anchor gaps`.

### Block-emit at /sdd init time

When Pass 15 runs as part of `/sdd init`'s Phase 6 iterate-to-clean (rather than as a steady-state doc-updater check on an existing file), any HIGH finding blocks the file write. Doc-updater retries: source-scan for plausible anchors, regenerate the section, attempt emit again. On second-pass failure, the section content becomes a `sdd/spec/triage.md` entry instead of being emitted.

The block-emit rule is `/sdd init`-specific because that's the one moment where the agent can hold the entire lane file in-memory and choose not to commit a fabricated fact. Steady-state doc-updater on existing files cannot rewrite history; it flags and escalates.

### Cross-reference: spec CQ-SOURCE

CQ-SOURCE (in `spec-enforce-truth`) verifies the spec side. Pass 15 verifies the doc side. They share the `@impl` convention but operate independently. The cleanest signal that the framework is truthful end-to-end: both pass with zero HIGH findings.

## Severity application

| Severity | Definition |
|---|---|
| **HIGH** | `route-not-in-source`, `function-removed`, `env-var-removed-from-source`, `implements-field-mismatched` (Pass 9 case c), `doc-anchor-orphaned`, `doc-value-drift` |
| **MEDIUM** | `verification-field-cites-unrelated-test`, `route-handler-renamed`, `function-signature-drift`, `json-example-shape-drift`, `implements-field-too-narrow`, `implements-field-low-confidence`, `trim-would-lose-load-bearing-content`, `stranger-cold-read-gap`, `doc-behavior-orphaned`, `doc-fact-not-anchored` |
| **LOW** | none in this skill |

Mode-dependent action mirrors the spine. Pass 15 HIGH findings (`doc-anchor-orphaned`, `doc-value-drift`) NEVER silently rewrite — Truth findings always escalate to `documentation/.doc-coverage.md` (or `sdd/spec/triage.md` when fired during `/sdd init`).
