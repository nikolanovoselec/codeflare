# Spec Changes

Semantic changes to the specification. Git history captures diffs; this file captures intent.

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
