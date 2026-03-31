# Spec Changes

Semantic changes to the specification. Git history captures diffs; this file captures intent.

## 2026-03-31
- Added REQ-AUTH-012: Welcome email on first login
- Added REQ-SUB-017: Enterprise tier contact flow
- Spec compliance pass: added Applies To, Priority, Dependencies, Verification to all requirements
- Added Key Concepts, Out of Scope, Domain Dependencies to all domain files
- Added Actors table, expanded glossary, added CON-* constraint IDs

## 2026-03-30
- Added REQ-SESSION-004 constraint: sleepAfter persisted to DO storage (bug fix)
- Updated REQ-AUTH-001, REQ-AUTH-002, REQ-AUTH-003: clarified CF Access vs Direct GitHub OAuth as distinct flows
- Updated REQ-SEC-001: both auth cookies documented (CF_Authorization + codeflare_session)

## 2026-03-27
- Added subscription domain (REQ-SUB-001 through REQ-SUB-016): 8-tier system, Stripe Checkout, usage tracking, Timekeeper DO, trial model, quota enforcement
- Updated authentication domain: added REQ-AUTH-002 (Direct GitHub OAuth), REQ-AUTH-003 (CF Access flow), REQ-AUTH-007 (JIT provisioning)
- Added REQ-AUTH-008 (session cookie auto-refresh), REQ-AUTH-009 (mode-dispatched logout)
- Updated security domain: added REQ-SEC-012 (billing status enforcement), REQ-SEC-014 (SaaS header trust guard), REQ-SEC-015 (blocked user subscription guard)

## 2026-03-18
- Updated REQ-SESSION-005: changed from heartbeat-based to input-based idle detection
- Added REQ-SEC-004 (credential encryption at rest), REQ-SEC-005 (R2 SSE-C encryption), REQ-SEC-006 (transparent KV migration)
- Updated REQ-STOR-003: added self-healing bisync recovery

## 2026-03-15
- Added setup domain (REQ-SETUP-001 through REQ-SETUP-008): zero-config wizard, deployment modes, NDJSON streaming
- Added REQ-AUTH-005 (three-tier middleware), REQ-AUTH-006 (email normalization)
- Added REQ-SEC-008 through REQ-SEC-011: security headers, input validation, path traversal, CVE scanning
- Added REQ-MOB-006 (sticky Ctrl), REQ-MOB-007 (voice input)

## 2026-03-12
- Added memory domain (REQ-MEM-001 through REQ-MEM-008): automatic capture, two-phase system, compaction
- Updated agents domain: added REQ-AGENT-006 (single-source preseed generation), REQ-AGENT-007 (multi-agent adaptation)
- Added operations domain: REQ-OPS-004 (E2E tests), REQ-OPS-005 (weekly pentest/fuzz)
- Added REQ-SEC-007 (rate limiting on all mutation endpoints)

## 2026-03-08
- Added REQ-AGENT-004 (Standard vs Pro session modes), REQ-AGENT-005 (Pro mode content)
- Added REQ-STOR-007 (web file browser), REQ-STOR-008 (multipart upload)
- Added REQ-STOR-012 (server-side prefix delete)

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

## 2026-02-26
- Added REQ-AGENT-001 (initial multi-agent support — Claude Code, Codex, Gemini CLI, Copilot)
- Added mobile domain (REQ-MOB-001 through REQ-MOB-005): mobile usability, virtual keyboard, Samsung quirks, scroll stability, swipe gestures

## 2026-02-25
- Added REQ-OPS-001 through REQ-OPS-003 (initial CI pipeline)
- Added REQ-TERM-003 (WebSocket auto-reconnection), REQ-TERM-004 (4503 close code)
- Expanded terminal domain: REQ-TERM-008 (write batching), REQ-TERM-009 (process name detection)
- Updated constraints: container specs, E2E testing infrastructure

## 2026-02-22
- Initial specification
- Core domains: session-lifecycle (REQ-SESSION-001 through REQ-SESSION-003), authentication (REQ-AUTH-001, REQ-AUTH-004), terminal (REQ-TERM-001, REQ-TERM-002)
- Constraints established: Cloudflare Workers, Hono, SolidJS, xterm.js, KV, R2, Containers, Durable Objects
- Principles: isolation per session, files persist, zero setup, scale to zero, stateless dashboard
- REQ-SESSION-001: one container per session
- REQ-AUTH-001: Cloudflare Access authentication
- REQ-TERM-001: up to 6 terminal tabs per session
- REQ-TERM-002: WebSocket-to-PTY terminal connection
