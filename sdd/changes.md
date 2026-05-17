# Spec Changes

Semantic changes to the specification. Git history captures diffs; this file captures intent.

## 2026-05-17
- REQ-VAULT-001 extended with AC7 + AC8 + new Constraint, and AC3 reworded: `init_user_vault()` now copies `index.md`, `CONFIG.md`, `README.md`, and `STYLES.md` from `/opt/silverbullet-preseed/` into the vault root on every boot (gated so identical files are not rewritten); these four pages are codeflare-authoritative. `graphify-out/graph.json` is seeded only when absent (never overwritten). AC3 reworded: the per-boot block now only `mkdir -p`s critical subdirectories; content sync moved out of the first-init-only gate. New Constraint: `CONFIG.md` is a runtime contract whose `libraries: import` directive triggers Library/Std federation on first browser open; without it the dashboard's `${query[[...]]}` blocks and in-page wikilink handlers fail silently. Two failure modes drove the change: deleting any preseed page silently broke the editor with no recovery short of wiping the vault, and the prior first-init-only sync left R2-restored vaults missing preseed updates indefinitely.
- REQ-VAULT-005 extended with AC9: SilverBullet opens to the codeflare dashboard (`index` page) by default via `indexPage: index` in `.silverbullet/config.yaml`; README is one click away from the dashboard via a link at the top.
- REQ-VAULT-001 vault directory renamed `.user_vault` -> `Vault` (non-hidden basename) across entrypoint, bisync filter, capture + extract prompts, plugin scripts, preseed rules, Worker route, docs, audits, and tests. The non-hidden basename is now a constraint: SilverBullet's file walk skips dot-prefixed roots and would otherwise return an empty listing. Internal identifiers (`init_user_vault` function, `--as user_vault` graphify tag) preserved; no R2 migration code (clean cutover for the single existing user, prior `.user_vault/` in R2 is abandoned).
- REQ-VAULT-001 extended with AC5 + AC6: `init_user_vault()` also auto-creates `/home/user/Uploads/` and `/home/user/Temporary/`; both bisync to R2 via new filter includes ordered before the global graphify-out exclude. The R2 storage panel surfaces Workspace, Vault, Uploads, Temporary as special folders with an info-icon tooltip showing purpose plus in-container path.
- REQ-VAULT-007 extended with AC5: `init_user_vault()` copies the SilverBullet plugs listed in `preseed/silverbullet/plugs/MANIFEST.md` (pdf, treeview, github, graph) into `~/Vault/Library/Codeflare/` on every boot so the editor opens with baseline productivity plugs available without a per-session install step.
- REQ-SEC-012 extended with AC5 + AC6 (token survives DO hibernate/wake; cleared on destroy). Pre-fix the token lived only in `this._containerAuthToken` (in-memory); every DO wake from hibernation re-generated a fresh UUID while the container process retained its original `CONTAINER_AUTH_TOKEN` env var, producing a mismatch and silent `{"error":"Unauthorized"}` on every proxied request from `host/src/server.ts:177-178` until the user manually recreated the session. ACs are phrased as observable behaviour; implementation mechanism (persisted to `ctx.storage` under key `containerAuthToken`, restored in `blockConcurrencyWhile`, write pinned via `ctx.waitUntil(...)` to close the wake-then-immediately-hibernate window, deleted in `destroy()` so the next session under the same DO ID gets a fresh token) is documented in `documentation/security.md` and `documentation/configuration.md`, not in the AC bullets.
- REQ-VAULT-004 AC4 hardened: vault-skip path comparison now canonicalizes `$HOME` via `cd && pwd` (matching how `REPO` is resolved) and also matches on basename `.user_vault`. Pre-fix, the raw `$HOME/.user_vault` string compared against the canonicalized `REPO` would miss the vault on hosts where `$HOME` itself was a symlink or carried a trailing slash, silently re-tagging the vault as `.user_vault` on every vault file touch. Two new regression tests isolate the canonicalization branch from the basename-fallback branch (each guard fails its own test if reverted independently).
- `handleVaultRequest` rewrite no-op warning is now scoped to `status === 200 && path in {/, /index.html}` (exact match, not `endsWith`). Pre-fix the AC7 widening made the warning fire on every non-shell text/html response (error pages, 404 HTML) producing prod log noise; the warning's job is to surface a future SilverBullet template change on the load-bearing shell paths, not to annotate every error render.
- REQ-VAULT-005 AC7 widened: the `<base href="/" />` rewrite in `handleVaultRequest` now fires on EVERY text/html response, not just `/` and `/index.html`. Pre-fix, a `location.reload()` from the SilverBullet client (triggered by its own "going to reload" alert, or any manual reload on a deep page like `/Notes/Today`) re-loaded the SPA shell at the deep path, which returned the bare unrewritten `<base href="/" />`, every relative fetch from client.js then resolved to the Worker root, and the tab went blank with all subsequent writes 404'ing. Independent of the alert path, Quick Notes / Journal saves that happen to land on a non-`/` document base (rare but possible when the SB client navigates via history.pushState then reloads) also silently failed. The text/html guard is sufficient because SilverBullet's API endpoints (`.fs/`, `index.json`, `.attachment/`) return non-HTML content types and never trigger the rewriter.
- Vault directory renamed `.obsidian_vault` -> `.user_vault` everywhere (entrypoint init function `init_obsidian_vault` -> `init_user_vault`, bisync filter `+ .obsidian_vault/**` -> `+ .user_vault/**`, paths in capture+extract prompts, plugin scripts, preseed rules, Worker route, docs). Global-graph tag for the vault renamed `vault` -> `user_vault`. No R2 migration code: the rename is a clean cutover for the single existing user (Nikola); prior `.obsidian_vault/` content in R2 is abandoned.
- REQ-VAULT-004 expanded from 6 to 7 ACs: new AC4 added (vault explicitly excluded from active-repo candidate resolution in `graphify-active-repo.sh` so a tool call inside the vault never re-tags it as `.user_vault` (basename) over the entrypoint-set `user_vault` tag); previous AC4-AC6 renumbered to AC5-AC7. The vault is registered exclusively by `init_user_vault()` at boot and is always-on in the global graph: the active-repo hook neither adds nor prunes it.
- REQ-VAULT-001 Key Concepts updated to record the always-on semantics: `user_vault` tag is set by entrypoint init and never touched by the active-repo prune-on-switch logic.

## 2026-05-16
- REQ-VAULT-005 extended with AC8: `handleVaultRequest` short-circuits browser-initiated Service Worker registration GETs at `/api/vault/<sid>/service_worker.js` (selector: `service-worker: script` header set + no `Cookie`) and serves a static no-op SW from the Worker, bypassing the cookie-auth chain. Chrome 76+ omits credentials on `navigator.serviceWorker.register()` script fetches, so the prior auth path returned 401 and registration failed permanently. The static SW JS contains no user data and is identical for every session; the `service-worker: script` header is a Fetch-spec forbidden header (page JS cannot forge it).
- REQ-VAULT-005 new Constraint: the auth-validated request returned by `maybeSynthesizeCsrfHeader` is the only Request safe to forward to `container.fetch` for body-bearing methods; forwarding the original `request` after the synth has cloned it triggers a Workers `ReadableStream is disturbed` TypeError on PUT/POST/PATCH.
- REQ-VAULT-004 expanded from 4 to 6 ACs: AC2 reworded (hash-diff pre-check before re-add); new AC3 added (prune-on-switch via `flock -w 5 graphify global remove <OLD-basename>` when basename changes); new AC4 added (sentinel-mtime fast-path so the graphify CLI is not spawned on every Bash/Edit/Write/ctx_execute call); original AC3-AC4 renumbered to AC5-AC6. End state: `graphify-active-repo.sh` now implements a single-active-repo global graph holding vault + exactly one active repo's nodes at a time. Same-basename switches (two clones with identical names, or branch switches within the same repo) skip the explicit remove because the `graphify global add --as <tag>` replaces the existing entry via graphify's source_hash dedup.
- REQ-AGENT-024 AC5 reworded: `enforce-graphify.sh` now resolves the active repo via `~/.cache/codeflare-hooks/graphify-active-cwd` (the sentinel `graphify-active-repo.sh` already maintains) before checking `<active-repo>/graphify-out/graph.json`, then falls back to the tool-call envelope `.cwd` when the sentinel is absent. The literal-envelope-cwd check the previous AC text described was permanently dead in codeflare (sessions always have `cwd=~/workspace`, never inside a sub-repo) so the gate never fired. Vault-only-in-global is intentionally NOT enforcement-eligible: only per-repo graphs trigger the hard-block, and only for the repo the user is currently in.
- REQ-AGENT-008 AC3 prose: the MANAGED_HOOKS_REGEX in `entrypoint.sh` now matches `plugins/(codeflare-(hooks|memory|vault)|graphify)/scripts/` (anchored on the literal `plugins/` segment so unrelated future locations with the same basenames are not falsely managed). The previous regex only covered `codeflare-(hooks|memory)/scripts/`; without this extension, vault and graphify hooks accumulated 2x-10x copies in `~/.claude/settings.json` on every container boot because the merge filter never recognised them as managed and so never pruned the prior copy before appending the new one.
- REQ-AGENT-023 / REQ-VAULT-002 implementation hardening: graphify CLI shim now exposed at `/usr/local/bin/graphify` (Dockerfile symlink + idempotent entrypoint self-heal), restoring the auto-seed of `~/.graphify/global-graph.json` that the unified vault+repo graph depends on. The shim previously lived only in `/root/.local/bin/`, invisible to hook subshells.
- REQ-AGENT-024 extended with AC5: in advanced session mode a new PreToolUse hook (`enforce-graphify.sh`) hard-blocks structural searches after 3 grep-class tool calls in the same turn when no `mcp__graphify__*` call (or `graphify query|path|explain` CLI) has been made. Matcher set covers `Grep`, `Bash`, and the ctx_execute family so both standard and custom tiers are gated. AC4's "never blocks" constraint is relaxed to "the AC4 nudge never blocks; AC5 enforces a quantitative threshold (3 grep-class calls without a graph query)". User-only bypass: `touch /tmp/graphify-bypass` (one-shot) or `skip graph` in user message.
- REQ-VAULT-005 extended with AC7: `handleVaultRequest` rewrites `<base href="/" />` to `<base href="/api/vault/<sid>/" />` on text/html responses for shell paths (`/` and `/index.html`) only, so SilverBullet's relative asset paths resolve back through the subpath proxy. Fixes the white-screen symptom on integration. Non-HTML responses pass through unchanged; both `content-length` and `content-encoding` headers are dropped on rewrite (Workers `Response.text()` auto-decompresses upstream encoding).
- SDD review-bypass sentinel moved from `sdd/.skip-next-review` (in-repo, risked accidental commits) to `/tmp/review-bypass` (per-session, never committed, never survives container restart). REQ-AGENT-021 AC4 contract unchanged; only the path moved. Hook bypass logic, magic-phrase fallback, and 3-strike circuit breaker are identical. `REVIEW_BYPASS_FILE` env override added for hermetic test isolation; production reads the default path.
- Memory domain rewritten: the MCP `server-memory` knowledge-graph substrate (per-session JSONL files, merge-on-boot, two-phase capture+compaction, 5000-observation threshold) is removed. The obsidian vault at `/home/user/.obsidian_vault/` is now the sole cross-session memory store; captures land as markdown under `raw/sessions/` and the unified graphify graph (`~/.graphify/global-graph.json`) is queried via `mcp__graphify__*`. REQ-MEM-001, REQ-MEM-002, REQ-MEM-004, REQ-MEM-006, REQ-MEM-008 rewritten; REQ-MEM-003 (two-phase compaction), REQ-MEM-005 (per-session JSONL), REQ-MEM-007 (5000-observation compaction trigger) deleted. New REQ-MEM-001 dependency on REQ-VAULT-002.

## 2026-05-15
- REQ-STOR-004 reordered: terminal server binds port 8080 before R2 sync runs (AC1 reworded; AC8 added for the `/tmp/codeflare-init-complete` flag that gates PTY pre-warm). Cloudflare's container port-wait timeout (~10-15s) was killing the container on cold resume when initial R2 sync was slow. The readiness contract is preserved: loading screen still waits for sync + pre-warm; only the port bind moves earlier.
- REQ-SEC-007 AC10 added: session-stopped WebSocket rejection (4503) runs before the WS rate-limit check, so a browser reconnect-storm against a hibernated container does not consume the user's 30/60s budget and self-lock them out.
- REQ-STOR-004 AC9 and REQ-SEC-007 AC11 added: during container warm-up (between port bind and pre-warm session registration), `/terminal` WebSocket upgrades are rejected with close code 1013 at both the host server and the worker (via `/health` peek), so cold-start reconnect storms do not consume the user's 30/60s rate-limit budget. REQ-TERM-005 Dependencies extended to REQ-STOR-004 to make the cross-domain reliance explicit.

## 2026-05-14
- REQ-AGENT-023 expanded with AC4 (hot-reload tolerance: MCP wrapper presents an empty `LazyGraph` to `graphify.serve` so the server stays up across an empty workspace and rebinds within `GRAPHIFY_POLL_SECONDS` of a `graph.json` appearing) and AC5 (advanced-only active-repo PostToolUse hook on `Bash | Edit | Write | Read | NotebookEdit | mcp__context-mode__ctx_execute | mcp__context-mode__ctx_execute_file | mcp__context-mode__ctx_batch_execute` writing a sentinel that the wrapper reads to bind G to the agent's current repo; fallback is freshest-mtime across `CODEFLARE_WORKSPACE/*/graphify-out/graph.json`). Constraint added: per-branch graphs not supported, `.git/HEAD` read only for log identification. Recorded as AD53.
- Added REQ-AGENT-023 through REQ-AGENT-027 (graphify knowledge-graph integration). Containers ship `graphifyy[mcp,sql,pdf]` globally via `uv tool install`; the graphify MCP server is registered in `~/.claude.json` for both default and advanced session modes (capability is ambient). In advanced session mode only, three hooks (SessionStart context-injection, PostToolUse-on-clone triage, PreToolUse graph-first soft-nudge) plus `rules/graph-first.md` and `skills/graphify/SKILL.md` teach the agent to prefer focused MCP queries over Grep for architecture, dependency, and call-flow questions.
- Persistence model is git, not R2. The rclone bisync filter excludes `**/graphify-out/**`; repo owners with push permission commit `graph.json`, `GRAPH_REPORT.md`, and the small metadata files. The container image registers the graphify semantic merge driver globally (`git config --global merge.graphify.driver`) so any repo wiring `graphify-out/graph.json merge=graphify` in `.gitattributes` gets auto-resolved concurrent edits.
- Discipline-vs-capability tier split codified in AD52: tier independence for the CLI + MCP server + merge driver; session-mode gating only for the discipline pieces (hooks + rule + skill). Coexists cleanly with context-mode (REQ-AGENT-027): `graphify` is whitelisted in `enforce-ctx-mode.sh` when context-mode is preseeded, and the graph-first soft-nudge hook registers both the non-ctx matchers (`Grep`, `Glob`) and the ctx grep-equivalents (`ctx_search`, `ctx_batch_execute`) so the nudge fires in both tier paths.

## 2026-05-12
- Added REQ-AGENT-022 (legacy-codebase transition to SDD via `/sdd init` triage). Import Mode produces two outputs from one analysis pass: official REQs in `sdd/{domain}.md` for behavior clear from source / tests / comments / commits / PRs (written automatically, no per-REQ user confirmation), and a triage queue at `sdd/init-triage.md` for everything ambiguous (magic numbers, retry policies, orphan code, missing Intent). Each triage entry carries Context (file:line, git author, commit refs) and Recommendation with one-line Rationale so the user decides on substance, not archaeology.
- Resume Mode picks up open triage items one at a time with refreshed Context. Five decisions per item: accept / correct (free-form prose) / lost (one-line Reason required) / skip / quit. Only accept and correct promote anything into the official spec. Resume Mode refuses to start on a dirty working tree (same gate as `/sdd clean`).
- During SDD transition (while `sdd/init-triage.md` has any `Status: open` items, `sdd/config.yml` carries `transition: true`) the entire PR-boundary review pipeline is suspended: no code-reviewer, spec-reviewer, or doc-updater fires on push or PR events. Manually-invoked review agents check the same gate and exit no-op. Single rule across all enforcement layers. `/sdd mode unleashed` is rejected (triage requires user judgment).
- Transition closure: when the last open item is resolved or marked `lost`, the closure commit clears `transition: true`, appends a closure entry to `sdd/changes.md`, and enters Plan Mode so the first feature work on the now-real spec is plan-gated. `enforce_tdd` is NOT auto-flipped - the user changes it manually when ready. `sdd/init-triage.md` is preserved as the audit record.
- Triage entry canonical shape: `**Reason:**` is appended only on `lost`-marked items (one-line explanation of why the information is genuinely unrecoverable).
- Discovery degrades gracefully when the GitHub corpus is unreachable (non-GitHub remote / `gh` auth failure / rate-limited / air-gapped): working-tree + git-log evidence only, with a one-line notice recorded in `sdd/changes.md`.
- `/sdd autonomous` renamed to `/sdd mode` with a single-arg shape: `/sdd mode interactive`, `/sdd mode auto`, `/sdd mode unleashed`, or `/sdd mode` to print the current mode. Drops the on/off pair confusion.
- `/sdd init` re-invocation on an existing `sdd/` aborts with a /sdd-clean rescue hint instead of recommending `--force`. Resume Mode now creates `sdd/config.yml` from the template if missing.
- `--branch-confirmed` flag removed from `auto`/`unleashed` modes across `/sdd clean`, spec-reviewer, doc-updater, SKILL.md, and the discipline rules. Agents push to whatever branch is currently checked out; the user is responsible for the right branch.
- code-reviewer transition gate moved to Phase 0 (runs FIRST) and now carries the literal grep regex snippet matching spec-reviewer / doc-updater shape.
- Round-counter detection is path-based per agent: spec-reviewer counts only commits touching `sdd/**`, doc-updater counts only commits touching `documentation/**`. Each agent's spiral guard is scoped to its own lane. Anti-spiral category-matching dropped; `>=2 of the last 3 lane-scoped commits` is the simpler, sufficient trigger.
- Triage-state sanity check: if `transition: true` is set but no open items exist (stuck/corrupted state from a crashed closure step), agents run normally and spec-reviewer emits a HIGH finding asking the user to re-run closure or clear the flag manually.
- doc-updater transition gate regex tightened from `^transition: true` to `^transition:[[:space:]]*true` so the hook and the agent agree on `transition:true` (no space) and two-space configs.
- Hook spawn-detection rewired from RFC3339 timestamp string-compare to transcript line number (`awk NR > PUSH_LINE`), removing ~80 lines of normalize/strip_frac/empty-ts machinery that was solving a problem the line number already answered.
- Three review-agent disciplines extended with content-quality checks (REQ-AGENT-021 AC 12). Closes codeflare#331.
  - **doc-discipline** gains Passes 6-10 on top of the five structural passes: verification-field truth-check, Implements-vs-AC cross-walk, stale code-block detection against current source, content-preservation on auto-trims, and stranger cold-read.
  - **spec-discipline** gains CQ-1..CQ-3: REQ-test truth-check, vendor / external-interface drift detection, and content-preservation on shrink.
  - **tdd-discipline** gains antipattern 8 (test name lies about what's asserted) paired with spec-discipline CQ-1 at MEDIUM severity.
- `Implements REQ-X-NNN` annotations removed entirely (convention, glossary entry, the spec-discipline.md section, and 32 source-file comment lines across 21 files). Test-name-based REQ-ID matching (`test('REQ-X-NNN: ...')`) is the load-bearing coverage signal; source-side annotations were overhead with no consumer.
- REQ-AGENT-005 acceptance criteria rewritten to describe the user-observable Standard-vs-Pro experience (memory persistence, hook coverage on every PR boundary, universal context-mode helpers, Custom-tier-only auto-routing). The detailed per-content-category delivery matrix moved to [documentation/preseed.md](../documentation/preseed.md#session-modes); the spec now backlinks the matrix instead of duplicating it. No change in delivered behavior.

## 2026-05-11
- SDD Stop-hook review gate now fires regardless of which tool surfaced `git push` (REQ-AGENT-021, REQ-AGENT-004). The `enforce-review-spawn.sh` PUSH_LINE detector previously scanned the transcript only for `"name":"Bash"` tool_use entries, so `git push` driven through `mcp__context-mode__ctx_execute` (with `language:"shell"`) or `mcp__context-mode__ctx_batch_execute` was invisible — the gate silently exited 0 and unreviewed PR HEADs slipped past Stop enforcement. The awk now scans three matching shapes: Bash `"command"`, ctx_batch_execute per-entry `"command"`, and ctx_execute `"code"` with sibling `"language":"shell"`. Same anchored-regex semantics across all three. Companion fix to PR #318 (PostToolUse). Closes codeflare#319.
- Attribution gate now fires on MCP shell tools too (REQ-AGENT-004). The `block-attributed-commits.sh` PreToolUse hook is registered on `mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute` in addition to Bash, and parses the same three `.tool_input` shapes as the review-reminder hook. Closes the matching bug-class where attribution lines could land via `gh pr create --body "...Co-Authored-By..."` redirected through ctx_execute when context-mode denied the Bash form.
- CI monitoring rules rewritten to use bounded per-iteration polling and to be context-mode-aware (REQ-AGENT-005, REQ-AGENT-021). `rules/ci-monitoring.md` and `rules/common/git-workflow.md` previously instructed agents to spawn a single long-running `while true; do ...; done` poll loop via Bash + `run_in_background:true` using `gh`, `while`, `echo`, `tail` — every one of which `enforce-ctx-mode.sh` denies on Custom + Pro tiers, AND the long-running script regularly got stuck on CI hangs / network blips / shell quoting bugs with the agent unable to intervene. The new pattern runs ONE bounded `sleep 15 && gh run list ...` check per iteration: context-mode sessions go through `ctx_execute(language:"shell")`; vibe-coding sessions go through Bash directly (no `run_in_background` needed — each call is short). After every iteration the agent reads the status table and explicitly decides succeed / fail-and-fix / poll again. Capped at ~30 iterations (~7-8 min) before escalating, so no path can hang forever.
- Subagents spawned via the Task tool (architect, build-error-resolver, code-reviewer, doc-updater, refactor-cleaner, security-reviewer, spec-reviewer, tdd-guide) now have the `mcp__context-mode__ctx_*` tools in their inventory (REQ-AGENT-005). Previously the strict PreToolUse hook denied native `Grep` / unwhitelisted `Bash` and instructed agents to route through `ctx_execute` / `ctx_search` — but those MCP tools were not in the subagent's tool schema, so the redirect was a dead end. `/review` reports and review-pipeline agents (code-reviewer / spec-reviewer / doc-updater) can now actually search code on Custom + Pro tiers instead of degrading to Read+Glob.
- Entrypoint hook merge now treats `enforce-ctx-mode.sh` invocations as managed (REQ-AGENT-008), so duplicate strict-hook entries no longer accumulate across container restarts. Previously every entrypoint run silently re-appended the strict hook because the managed-hooks regex matched only `codeflare-(hooks|memory)/scripts/` and bare `context-mode` invocations; production settings.json grew to 4× duplicate entries on the `Bash|WebFetch|Grep` matcher.
- SDD review pipeline now fires regardless of which tool surfaces `git push` or `gh pr create` (REQ-AGENT-021). The PostToolUse review-reminder hook is registered on the MCP shell-tool matcher (`mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute`) in addition to Bash, uniformly for every advanced-mode user regardless of context-mode tier — users without context-mode get an inert matcher entry that never fires, users with context-mode get coverage when `enforce-ctx-mode.sh` denies `gh` in Bash and forces the invocation through MCP. The script itself parses three input shapes (`.tool_input.command`, `.tool_input.code` with `language == "shell"`, and `.tool_input.commands[].command`) and applies the same anchored-regex classifier to each, so the trigger model (PR-OPEN / PR-SYNC / DEFERRED) is identical across tools. Previously ctx-mode-routed commands passed through unseen, the directive never fired, and the user discovered the gap by noticing the review pipeline never ran. Closes codeflare#317.

## 2026-05-10
- context-mode routing is now hard-enforced for Custom + Pro users (REQ-AGENT-005 AC6). A fifth PreToolUse hook denies `Bash` outside `{git, mkdir, rm, mv, cd, ls, npm install, pip install}` and every `WebFetch` and `Grep` call, redirecting to the matching `ctx_*` tool. Per-call bypass via `/tmp/ctx-bypass` (user-only sentinel). The four advisory hooks remain.
- Reverted: the disk bump from 6 GB to 8 GB on the default/saas tiers (REQ-OPS-002 AC7, REQ-OPS-007 AC1). Cloudflare's containers cap disk at 2x memory in GiB, so 8 GB requires at least 4 GiB memory; the default tier ships with 3 GiB and the deploy was rejected. Default disk stays at 6 GB until a future tier upgrade raises memory first.
- context-mode `ctx_execute` and `ctx_batch_execute` now succeed for Custom + Pro users on first invocation (REQ-AGENT-005 AC5). Previously every call failed with a dynamic-require error; the executor is now ready at session start with no first-call download. Closes codeflare#309.
- context-mode (REQ-AGENT-005 AC5-AC7) ships in two layers: the MCP server with `ctx_*` helper tools is registered for every user on every session so the agent always has the helpers available on demand, while the plugin folder containing the four auto-routing hooks (PreToolUse, PostToolUse, PreCompact, SessionStart) is delivered only to users on the Custom (`unlimited`) tier in Pro mode. The hooks-layer gate is enforced at the R2 seed filter so the plugin folder never appears in non-qualifying users' sessions.
- context-mode auto-routing hooks now actually fire for Custom + Pro users (REQ-AGENT-005 AC7). Previously the plugin folder was delivered correctly but the hooks never triggered because the plugin manifest did not declare the MCP server, so the plugin loader treated the package as inert. The manifest now carries the declarative wiring that the plugin loader expects, and AC7 is reworded to describe MCP availability as universal regardless of which path performs the wiring.
- Idle-detection now fails safe toward preserving user work (REQ-OPS-006 AC8-AC10): when `sleepAfter` cannot be resolved, the system falls back to the maximum supported value (2h) instead of the minimum, refreshes the persisted preference within one 60-second cycle, and refuses to silently substitute defaults. Hardens the failure surface that caused issue codeflare#294 (containers dying before their configured 2h timer).

## 2026-05-09
- GitHub OAuth state validation is now stateless (REQ-AUTH-002 AC2-AC4), so sign-in works on iOS WebKit (Safari, Brave) and other browsers where prior cookie-based state was unreliable across the github.com bounce-back. State validation failure now redirects to the login page with a friendly error message instead of returning a raw 403.
- Terminal scrollback buffer increased from 400 to 1000 lines (REQ-MOB-004). Users can scroll back roughly 2.5x further through command output history before older lines are trimmed. Both browser xterm.js and host headless serialize buffer were bumped together so reconnect-restore stays in sync.
- User-initiated session Stop and Delete now actually run the final R2 bisync (REQ-SESSION-006, REQ-SESSION-011). The DO's `destroy()` override SIGTERMs the container and waits up to 25 s for the entrypoint trap to complete the final bisync before SDK teardown SIGKILLs the process. Previously both routes called `destroy()` directly, which the SDK delivers as SIGKILL - uncatchable by the trap, so files written between the last 60 s incremental sync and shutdown were lost from R2.
- SDD review pipeline now gates on PR target (REQ-AGENT-021 AC4): code-reviewer + spec-reviewer + doc-updater fire only when the open PR targets `main` or `master`. PRs into intermediate integration branches (`develop`, `staging`, etc.) defer review until the integration branch's own PR-to-`main` opens or syncs, where the cumulative review covers every commit that landed. Cuts review token cost roughly in half on workflows that use `feature → develop → main`.

## 2026-05-05
- `/review` gains a new Phase 5 (Reality Filter) and a persistent triage history file `sdd/.review-decisions.md` (REQ-AGENT-015 AC1 and AC5 updated). The Reality Filter re-evaluates AD-active findings against five questions (repeat-offender, memory-says-no, cluster aggregation, user-impact bar, spec-vs-shipped truth-test) and produces a short list of real findings the user actually triages, with a mandatory audit log of every drop. Empirically the filter takes 71 active findings down to ~10 real findings on a stable codebase. Phases 5-9 of the old pipeline shift to 6-10; output files renumber accordingly (AD46, issue codeflare#271).

## 2026-05-03
- Removed `sdd/.user-overrides.md` (issue codeflare#266). When the user resolves an automated finding as "keep current behavior — this mechanism IS the contract", the resolution is recorded as a real ADR in `documentation/decisions/` with an `Overrides: {rule_id}:{REQ-ID}` header. spec-reviewer and doc-updater grep `documentation/decisions/**/*.md` for that header instead of reading the legacy skip list. Same machine behavior, but the architectural decision is now first-class — discoverable, structured (Context/Decision/Rationale/Consequences), and indexed in `documentation/decisions/README.md` instead of buried in a config-shaped file. Existing entries auto-migrate to ADRs on the next `/sdd clean` run.
- SDD review pipeline switched from per-push to per-PR-boundary triggers (REQ-AGENT-021 AC4): code-reviewer + spec-reviewer + doc-updater now fire on PR open or on push to a branch with an open PR; pushes to feature branches without an open PR defer review until the PR opens. Direct-push-to-main bypass is left to GitHub branch protection (require PR before merge) rather than handled in-session, so the spec describes the workflow without engineering a hook-level workaround.

## 2026-04-26
- Added REQ-SETUP-010: pasting the codeflare.ch URL into Slack, iMessage, WhatsApp, Signal, Twitter, and other unfurl-capable surfaces now renders a branded preview card with the product tagline ("Ideas don't care where you are. Neither does your new ephemeral IDE.") and a 1200×630 preview image instead of a bare link.
- Memory capture trigger lowered from every 30 user messages to every 15 (REQ-MEM-001, REQ-MEM-002, REQ-MEM-003) so insights from shorter exchanges aren't lost when the conversation ends before the threshold. Compaction threshold raised from 1000 to 5000 observations and compaction target raised from ~500 to ~2000 (REQ-MEM-003, REQ-MEM-007) so the graph retains more long-lived context before and after restructuring.
- Stop hook push detection now uses the local git reflog as the source of truth, eliminating false-positive blocks from text-only mentions of "git push" in command output, PR bodies, or documentation. Each repo tracks the most recently acknowledged push independently, so parallel sessions in different repos enforce review without interfering with each other.
- Closed false-positive in Stop hook detection: a `git pull` command whose Bash tool_use carried a `description` field (or sibling text content in the same assistant message) containing the literal phrase "git push" triggered enforcement. Detection now anchors on the `command` JSON field with a string-walk that traverses through `\"` escape sequences, so sibling fields no longer cause spurious blocks. Chained pipeline detection (#243) preserved.
- Fixed REQ-AGENT-021 AC4 enforcement gap (#243): the Stop hook detected pushes only when `git push` was the first token of the Bash command, so chained pipelines like `git add . && git commit -m '...' && git push` silently bypassed the entire review pipeline. Detection now matches `git push` anywhere inside the command field. The PostToolUse reminder hook had the same flaw and is fixed in parallel.
- Codified that the Stop hook bypasses (sentinel file `sdd/.skip-next-review` and `skip review` / `skip verification` magic phrases) are USER-ONLY: agents must never create the sentinel or write the bypass phrase in their own output. The hook's block message and the `spec-discipline` rule both make this explicit.

## 2026-04-25
- SDD review-agent sequential discipline (REQ-AGENT-021 AC4) is now hard-enforced via a Stop hook. After git push on an SDD-bootstrapped project, the main session cannot end its turn until code-reviewer + spec-reviewer are spawned in parallel and doc-updater is spawned after spec-reviewer's task-notification arrives. Three bypass methods preserve user agency: `sdd/.skip-next-review` sentinel file (one-shot), "skip review" / "skip verification" magic phrase in a user message, or 3-strike circuit breaker per push.

## 2026-04-23
- Updated REQ-AGENT-021 AC3: unleashed mode now applies all fixes (SAFE + RISKY + JUDGMENT) as per-category `[sdd-clean]` commits on the current branch. No new branch is created and no pull request is opened; `git revert <sha>` is the rollback surface and `sdd/.last-clean-run.md` carries the audit log. Interactive and auto modes are unchanged. Added AC7 to make the `auto`/`unleashed` `main`/`master` refusal explicit.
- Updated REQ-AGENT-021 AC2: `/sdd init` now resolves top-level dependency versions at scaffold time via the ecosystem's registry (npm, Cargo, pip, Go) instead of emitting memorized ranges, generates a lockfile once as a scoped carveout to no-local-builds, and pins `wrangler` + `@cloudflare/workers-types` + `@cloudflare/vitest-pool-workers` + `vitest` as a single co-resolved cohort on Cloudflare Workers projects.

## 2026-04-20
- Added REQ-SUB-021: new paid subscriptions are anchored to the 1st of UTC month so billing dates match the monthly quota reset. Existing subscriptions keep their original anniversary billing. First charge is prorated for the partial period.
- Clarified REQ-SUB-021 AC2 and AC6: on trial subscriptions the billing cycle anchor falls after trial end, and the first charge's prorated period begins at trial end rather than subscription start.
- Updated REQ-SUB-018 AC4: quota warning banner dismissal is now persisted per UTC month in localStorage instead of session-scoped. Users no longer see the banner on every page reload; dismissal resets naturally when the monthly quota resets.

## 2026-04-18
- Free tier idle timeout changed from 5 minutes to 15 minutes. Onboarding page now includes idle timeout selector as section 1 with billing explanation.
- Removed claude-unleashed dependency. Claude Code now runs directly via `claude --dangerously-skip-permissions` with `IS_SANDBOX=1`. Anthropic shipped Claude Code as a native binary (v2.1.102+), breaking the JavaScript patcher.

## 2026-04-11
- Updated REQ-MEM-001, REQ-MEM-003, REQ-MEM-007, REQ-MEM-008: memory capture agent upgraded from haiku to sonnet for higher-quality observations. Compaction threshold raised from 150 to 1000 observations; compaction target changed from 50-80 per project to ~500 total.
- Updated REQ-MEM-001 AC2/AC7-AC8: memory-capture hook now injects MCP memory scan directive on first message (search_nodes). Message counting method corrected in spec.
- Updated REQ-MEM-002 AC2: first-run baseline now also injects memory scan directive before exiting.
- Updated REQ-AGENT-010 AC9-AC11: GitHub token creation now offers three scope tiers (Minimal/Recommended/Advanced). Cloudflare simplified to "Edit Cloudflare Workers" template. Documentation page for all scopes.
- Updated REQ-AGENT-005 AC4: git-push-review-reminder moved from PreToolUse to PostToolUse so the directive arrives in the same turn as the push result
- Updated REQ-AGENT-008 AC3-AC4: entrypoint hooks merge now preserves user-added hooks while replacing managed hooks; PostToolUse added to hook event types
- REQ-SUB-020 promoted to Implemented: multi-currency pricing code complete with full test coverage

## 2026-04-10
- Added REQ-SUB-020: Multi-currency pricing via Stripe `currency_options`. Subscribe page and checkout auto-detect visitor currency from `CF-IPCountry` (CHF/USD/EUR/GBP).
- Removed multi-currency pricing from Out of Scope.
- Updated REQ-AGENT-004 AC4-AC6: session mode now auto-reconciles on Stripe mode change, subscription termination, and Settings toggle -- no longer requires explicit recreate click
- Updated REQ-SUB-015 AC6-AC7: reconciliation generalized from downgrade-only to any mode change; added AC7 for subscription deletion reconciliation

## 2026-04-08
- SDD opt-in is now binary (REQ-AGENT-021 AC4): non-SDD projects get zero post-push review agents (vibe-coding mode), while projects with an `sdd/` folder get the full code-reviewer + spec-reviewer + doc-updater workflow. The `git-push-review-reminder` hook enforces the gate by exiting silently when `sdd/README.md` is missing.
- REQ-AGENT-005 AC4 updated: the two PreToolUse hooks now use command-pattern `if` gates (`Bash(git *)`, `Bash(gh *)`, `Bash(git push*)`) so they only fire on relevant commands, and the attribution-blocking surface expanded to cover git merge/tag/notes and gh pr/issue/release edit/comment/review/merge in addition to commits and PR creation.

## 2026-04-07
- Setup wizard now honors REQ-AUTH-002 constraint by skipping the `create_access_app` step in SaaS+OIDC mode (issue #140)
- Dockerfile base image now pulled from `public.ecr.aws/docker/library/node:24-bookworm-slim` (AWS ECR Public mirror) instead of Docker Hub to avoid anonymous pull rate limits in CI; image digest preserved, REQ-OPS-011 unaffected (still bookworm-slim Node 24)
- Added REQ-AGENT-021: Spec-Driven Development Workflow (Pro) — three autonomy modes, `/sdd clean` rescue, project-agnostic operation, import mode for existing codebases
- Updated REQ-AGENT-005, REQ-AGENT-006, REQ-AGENT-007, REQ-AGENT-014: preseed bundle expanded to include the `spec-discipline` enforcement rule and 13 SDD scaffolding templates
- Updated REQ-SESSION-004 AC4-AC5 and REQ-SESSION-005 AC5-AC6: idle detection consolidated to a single mechanism. `collectMetrics()` is now the sole enforcer of the user-configured idle timeout; the Container SDK's `sleepAfter` timer is pinned to 24h and the `onActivityExpired` override has been removed. Motivation: @cloudflare/containers v0.2.3 refreshes the SDK timer on any WebSocket message in either direction, which would keep containers alive whenever background processes (`tail -f`, log streams) emit output. Codeflare needs "no user input" semantics, not "no traffic" semantics. Wire protocol and DO storage key remain `sleepAfter` for backwards compatibility; the in-memory field is now `idleTimeoutPref`.

## 2026-04-06
- Updated REQ-SUB-018 AC4-AC5: usage warning banners (80%, 95%) are dismissible with × button; 100% banner remains non-dismissible

## 2026-04-04
- Updated REQ-STOR-004 AC5-AC6: vanishing-file recovery with session-scoped recovery filter (max 3 attempts, workspace files not auto-excluded) and static MCP auth cache exclusion
- Updated REQ-STOR-003 AC4-AC5: daemon now attempts vanishing-file recovery before counting a failure; renumbered consecutive-failure fallback to AC5
- Deprecated REQ-STOR-013: `nuke_corrupted_r2_files` was never implemented; self-healing is handled by vanishing-file recovery (REQ-STOR-004 AC5, REQ-STOR-003 AC4) and rclone `--resilient` + `--recover` flags
- Updated CON-REL-002: replaced `nuke_corrupted_r2_files` reference with vanishing-file recovery mechanism description
- Added glossary term: Recovery Filter

## 2026-03-31
- Updated REQ-AUTH-002 AC3: post-login redirect uses subscription tier check (isActiveTier) instead of subscribedAt timestamp — subscribed users skip /app/subscribe
- Added spec-reviewer agent (opus) for continuous spec maintenance
- Added git-push-review-reminder PreToolUse hook
- Added Pro mode features: spec-driven development workflow, continuous improvement
- Updated agent counts and document totals across spec and documentation
- Fixed post-login redirect: isActiveTier replaces subscribedAt check
- Changed code-reviewer model to opus, doc-updater model to sonnet
- Fixed stale Session Mode Key Concept in agents.md: advanced mode seeds 127 files, not 117

## 2026-03-30
- Added REQ-AUTH-012: Welcome email on first login
- Added REQ-SUB-017: Enterprise tier contact flow
- Added REQ-SESSION-004 constraint: sleepAfter persisted to DO storage (bug fix)
- Updated REQ-AUTH-001, REQ-AUTH-002, REQ-AUTH-003: clarified CF Access vs Direct GitHub OAuth as distinct flows
- Added sleep timer countdown UI on session cards and toolbar
- Added user-configurable auto-sleep timeout in Settings
- Terminal cursor now visible for all CLI agents (was hidden by CSS override)
- Added Bubblewrap sandbox support for Codex agent
- Added MAX_INSTANCES variable for per-environment container concurrency
- Added Gravatar integration with outline icon fallback
- Changed session limit error from generic 429 to QuotaExceededError (402) with actual message

## 2026-03-27
- Added subscription domain (REQ-SUB-001 through REQ-SUB-016): 8-tier system, Stripe Checkout, usage tracking, Timekeeper DO, trial model, quota enforcement
- Updated authentication domain: added REQ-AUTH-002 (Direct GitHub OAuth), REQ-AUTH-003 (CF Access flow), REQ-AUTH-007 (JIT provisioning)
- Added REQ-AUTH-008 (session cookie auto-refresh), REQ-AUTH-009 (mode-dispatched logout)
- Updated security domain: added REQ-SEC-012 (billing status enforcement), REQ-SEC-014 (SaaS header trust guard), REQ-SEC-015 (blocked user subscription guard)
- Added subscribe page redesign: three-phase wizard with lifeline tier selector, mode cards, scramble animations
- Added voice input via Web Speech API (mic floating button + Ctrl+Space shortcut)
- Added storage quotas per tier with enforcement at session start

## 2026-03-18
- Updated REQ-SESSION-005: changed from heartbeat-based to input-based idle detection
- Added REQ-SEC-004 (credential encryption at rest), REQ-SEC-005 (R2 SSE-C encryption), REQ-SEC-006 (transparent KV migration)
- Updated REQ-STOR-003: added self-healing bisync recovery
- Added R2 bucket nuke workflow for encryption migration

## 2026-03-16
- Added agent credential onboarding: zero-login experience with Anthropic, OpenAI, Gemini, Copilot keys
- Added consult-llm preference toggle (default: off)
- Added KV encryption (AES-256-GCM) and R2 SSE-C encryption
- Added visibility heartbeat idle detection (later replaced by input-based in 2026-03-18)

## 2026-03-15
- Added setup domain (REQ-SETUP-001 through REQ-SETUP-008): zero-config wizard, deployment modes, NDJSON streaming
- Added SaaS service mode: custom login page with branded UI, GitHub OAuth button, animated logo
- Added guided onboarding flow at /app/onboarding (GitHub PAT, CF API token setup)
- Added subscribe page with Turnstile CAPTCHA and tier selection
- Added user management admin panel at /admin/users (tier sections, bulk approve, search, delete with full cleanup)
- Added header user dropdown with Gravatar avatar (Profile, Guided Setup, Logout)
- Added JIT user provisioning (auto-create on first login in SaaS mode)
- Added REQ-AUTH-005 (three-tier middleware), REQ-AUTH-006 (email normalization)
- Added REQ-SEC-008 through REQ-SEC-011: security headers, input validation, path traversal, CVE scanning
- Added REQ-MOB-006 (sticky Ctrl), REQ-MOB-007 (voice input)
- Added auth expiry detection mid-session (amber re-auth banner on 401)

## 2026-03-14
- Added Push & Deploy credential management (GitHub + Cloudflare tokens in Settings)
- Branded settings UI redesign with inline-expand provider rows and SVG brand icons
- Terminal scroll stability fixes (distance-based detection, programmatic suppression)

## 2026-03-12
- Added memory domain (REQ-MEM-001 through REQ-MEM-008): automatic capture, two-phase system, compaction
- Updated agents domain: added REQ-AGENT-006 (single-source preseed generation), REQ-AGENT-007 (multi-agent adaptation)
- Added multi-agent preseed generator: 121 seed documents across 5 agents from Claude Code as single source of truth
- Added plugin architecture (codeflare-memory, codeflare-hooks) with SESSION_MODE gating
- Added operations domain: REQ-OPS-004 (E2E tests), REQ-OPS-005 (weekly pentest/fuzz)
- Added REQ-SEC-007 (rate limiting on all mutation endpoints)

## 2026-03-10
- Added /review command: 9-phase multi-perspective codebase review with 6 parallel specialist agents, cross-referencing, AD filtering, optional LLM verification, and interactive triage

## 2026-03-09
- Added REQ-AGENT-004 (Standard vs Pro session modes), REQ-AGENT-005 (Pro mode content)
- Added LLM API key management (OpenAI, Gemini) powering consult-llm MCP server
- Fixed container zombie alarm loop (onStop kills metrics schedule, onActivityExpired sends SIGTERM)

## 2026-03-08
- Added REQ-STOR-007 (web file browser), REQ-STOR-008 (multipart upload)
- Added REQ-STOR-012 (server-side prefix delete for R2 folders)

## 2026-03-05
- Added agents domain (REQ-AGENT-001 through REQ-AGENT-003): multi-agent support, agent selection, auto-start
- Added REQ-AGENT-009 (encrypted LLM API keys), REQ-AGENT-010 (deploy credentials)
- Added REQ-MEM-001 (initial memory persistence concept)
- Added REQ-STOR-009 (getting-started doc seeding), REQ-STOR-010 (agent config seeding)

## 2026-03-01
- Added security domain (REQ-SEC-001 through REQ-SEC-003): auth enforcement, token containment, scoped R2 tokens
- Updated REQ-SESSION-002: circuit breaker on container health checks
- Added REQ-STOR-014 (storage stats caching)
- Added operations domain: REQ-OPS-001 (deploy pipeline), REQ-OPS-002 (Docker scan), REQ-OPS-003 (PR checks)

## 2026-02-28
- Added storage domain (REQ-STOR-001 through REQ-STOR-006): per-user R2 buckets, file persistence, bisync, initial sync, shutdown sync, storage quotas
- Updated REQ-SESSION-001: scoped R2 credentials per container
- Added REQ-TERM-005 (agent auto-start with pre-warming)
- Migrated container base from Alpine to Debian bookworm-slim (Node 24) — fixed CLI crashes for Copilot and Gemini
- Added Fast Start toggle (disables agent CLI auto-updaters for instant startup)

## 2026-02-26
- Added GitHub Copilot as supported agent
- Added REQ-AGENT-001 (initial multi-agent support — Claude Code, Codex, Gemini CLI, Copilot)
- Added mobile domain (REQ-MOB-001 through REQ-MOB-005): mobile usability, virtual keyboard, Samsung quirks, scroll stability, swipe gestures

## 2026-02-25
- Added REQ-OPS-001 through REQ-OPS-003 (initial CI pipeline)
- Added REQ-TERM-003 (WebSocket auto-reconnection), REQ-TERM-004 (4503 close code)
- Expanded terminal domain: REQ-TERM-008 (write batching), REQ-TERM-009 (process name detection)
- Updated constraints: container specs, E2E testing infrastructure
- Added per-user session limits with frontend popup and backend enforcement

## 2026-02-22
- Initial specification
- Core domains: session-lifecycle (REQ-SESSION-001 through REQ-SESSION-003), authentication (REQ-AUTH-001, REQ-AUTH-004), terminal (REQ-TERM-001, REQ-TERM-002)
- Constraints established: Cloudflare Workers, Hono, SolidJS, xterm.js, KV, R2, Containers, Durable Objects
- Principles: isolation per session, files persist, zero setup, scale to zero, stateless dashboard
