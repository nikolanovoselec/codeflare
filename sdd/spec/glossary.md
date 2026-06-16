# Glossary

Canonical definitions for domain concepts. Use these terms consistently across all spec files, implementation, and documentation.

| Term | Definition |
|------|-----------|
| Session | A single working environment mapped to one container. Users can have multiple sessions. |
| Container | An isolated Cloudflare Container running a terminal server, agent CLI, and rclone sync. One per session. |
| Bucket | A per-user R2 storage bucket (`codeflare-{bucketName}`) holding all persistent files. |
| Agent | An AI coding CLI tool (Claude Code, Codex, Antigravity, Copilot, OpenCode, Pi, or plain bash). |
| Session Mode | Standard (default) or Pro (advanced). Controls which preseed configs are deployed. |
| Preseed | Pre-configured rules, skills, agents, commands, and plugins deployed to a container on start. |
| Tier | Subscription level (blocked, pending, free, trial, standard, advanced, max, unlimited/Custom). |
| Durable Object (DO) | Cloudflare's stateful compute primitive. Container DO manages per-session state; Timekeeper DO tracks per-user usage. |
| KV | Cloudflare Workers KV - globally distributed key-value store for session metadata, user records, and preferences. |
| Worker | The Cloudflare Worker running the Hono router - handles all HTTP/WebSocket requests. |
| Connect GitHub | An explicit action authorizing Codeflare to act as the user on GitHub (a GitHub App or OAuth App authorization). Never the Codeflare login. |
| GitHub App (user-to-server) | An internal GitHub App whose user-to-server token acts as the user, expires (~8h), and is refreshable; the EMU-reliable connect path. Distinct from installation/bot tokens, which are not used. |
| Egress injection | Replacing a container's placeholder credential with the real secret at the outbound HTTPS boundary (a Worker interceptor), so the real token never enters the container. Used for AI keys and, in enterprise, GitHub tokens. |
| DeployKeys | The per-user encrypted KV entry (`deploy-keys:<bucket>`) holding the user's GitHub + Cloudflare deploy tokens; `githubToken` flows to the container as `GH_TOKEN`. |
| Browser Rendering token | A narrowly-scoped Cloudflare `Browser Rendering - Edit` API token used by the browser-run MCP servers and the Pi native browser extension. In enterprise mode it is set once admin-globally in the Setup wizard (not per-user), stored encrypted, and injected into the container env as `CLOUDFLARE_API_TOKEN`; when absent the browser-run surface is not seeded. |
| GitHub Provider Config | The enterprise admin's Setup-wizard choice of GitHub provider (GitHub App or OAuth App) plus its client id (plain) and client secret (encrypted), stored in KV under `SETUP_KEYS.GITHUB_*` and resolved by `getGithubProvider` before any env-var fallback ([REQ-GITHUB-008](github.md#req-github-008-enterprise-github-provider-configuration-via-setup)). |
| Per-group dynamic routing | An optional enterprise mapping of each Cloudflare Access group to its active dynamic routes + default route + reasoning (`SETUP_KEYS.GROUP_ROUTING`). A session resolves the first of its matched groups (in configured order) with an entry; with none configured, the global catalog applies unchanged ([REQ-ENTERPRISE-013](enterprise-mode.md#req-enterprise-013-per-group-dynamic-routing)). |
| Admin Access Group | An enterprise Setup-configured Cloudflare Access group (`SETUP_KEYS.ENTERPRISE_ADMIN_ACCESS_GROUP`) whose members are granted admin (= Setup / user-administration) access, parallel to the email-based Admin Users list. Resolved live per-request in `requireAdmin` (never the hot auth path); elevation lives only on the request context. Distinct from the user-access groups — admin groups never participate in per-group routing ([REQ-ENTERPRISE-014](enterprise-mode.md#req-enterprise-014-admin-access-via-cloudflare-access-groups)). |
| Bisync | rclone's bidirectional sync mode - keeps container local files and R2 bucket in sync. |
| sleepAfter | Configurable idle timeout (5m-2h) before a container is stopped. Input-based detection. |
| PTY | Pseudo-terminal - the terminal server multiplexes up to 6 PTY sessions per container. |
| Tiling | Multi-terminal layout modes: tabbed (default), 2-split, 3-split, 4-grid. |
| CF Access | Cloudflare Access - external auth service used in default/onboarding modes. |
| Direct GitHub OAuth | Worker-managed GitHub OAuth flow used in SaaS mode when OAUTH_CLIENT_ID is configured. Completely separate from CF Access. |
| Timekeeper | Durable Object that tracks per-user compute usage for quota enforcement. |
| Setup Wizard | First-time configuration flow that provisions domain, auth, R2 credentials, and Turnstile. |
| SSE-C | Server-Side Encryption with Customer-Provided Keys - R2 file encryption using ENCRYPTION_KEY |
| NDJSON | Newline-Delimited JSON - streaming response format used by the setup wizard |
| Circuit Breaker | Resilience pattern that stops calling a failing service after consecutive failures |
| SaaS Mode | Deployment mode (SAAS_MODE=active) enabling subscriptions, JIT provisioning, and usage tracking |
| Onboarding Mode | Deployment mode with public waitlist landing page (ONBOARDING_LANDING_PAGE=active) |
| Effective Tier | The billing-resolved subscription tier after applying grace periods and expiry rules |
| Fast Start | Container optimization that disables agent CLI auto-updaters to reduce startup time |
| Bisync Baseline | Initial rclone --resync state that establishes bidirectional sync tracking |
| Pre-warm | Pre-spawning tab 1 PTY during container startup before the terminal server is ready |
| Reconcile | Process of syncing preseed configs to match the current session mode (overwrite + cleanup) |
| BillingStatus | Subscription state: active, trialing, past_due, or canceled |
| Anti-flapping | 3-minute startup guard preventing stale KV data from toggling session status |
| Rate Limiting | Per-user request throttling (KV-backed sliding window with in-memory fallback) |
| Webhook | HTTP callback from Stripe to the Worker for billing event processing |
| JWT | JSON Web Token - used for both CF Access (RS256) and GitHub OIDC (HMAC-SHA256) auth |
| HSTS | HTTP Strict-Transport-Security header enforcing HTTPS connections |
| CSP | Content-Security-Policy header restricting resource loading origins |
| Trivy | Container image vulnerability scanner run during CI deploy pipeline |
| Service Token | Secret-based auth for E2E tests and automation via X-Service-Auth header |
| Sync Daemon | Background process in entrypoint.sh running rclone bisync every 15 minutes, SIGUSR1-interruptible for manual triggers |
| Sync-now | User-triggered manual sync action. Button in the storage browser ([REQ-STOR-015](storage.md#req-stor-015-explicit-sync-trigger-from-ui) AC1) sends SIGUSR1 to the sync daemon, fanning out to every session of the user's account ([REQ-STOR-015](storage.md#req-stor-015-explicit-sync-trigger-from-ui) AC2). One of three bisync triggers: 15-minute cadence, Sync-now, and final shutdown bisync. |
| Entrypoint | entrypoint.sh - container initialization script handling sync, config, and terminal server startup |
| Recovery Filter | Session-scoped rclone filter file (`/tmp/rclone-recovery-filters.txt`) that dynamically excludes transient files which vanish between listing and copy, preventing bisync fatal errors |
| Scoped R2 Token | Per-user R2 API token restricted to that user's bucket only |
| Spec Discipline | The universal SDD enforcement layer (`rules/spec-discipline.md`) inlined into every agent's instructions; activates only when `sdd/` exists in the project |
| Autonomy Mode | One of `interactive`, `auto`, or `unleashed` set in `sdd/config.yml`; controls how aggressively spec-reviewer and doc-updater apply fixes without human confirmation |
| Enforce TDD | The SDD enforcement mode set via `enforce_tdd: true` in `sdd/config.yml` (default true); makes spec-reviewer auto-demote `Implemented` REQs without tests to `Partial`, flag `Planned`/`Partial` REQs whose source code exists but has no test, and run test-quality heuristics on every push. Unleashed mode refuses to run when `enforce_tdd: false` (preserves the project-level opt-out); the user flips the value manually when ready. |
| Import Mode | The `/sdd init` mode that activates when an existing codebase is detected; derives a spec from observed code behavior instead of bootstrapping from prose |
| Vault Encryption Key | A 32-byte random key generated by the Container DO on first start and persisted in DO storage. Used as the SilverBullet IDB encryption key. Never transmitted outside the Worker-to-DO channel. Wiped when container.destroy() runs (forward-secret on session delete). |
