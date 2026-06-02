# Graph Report - /home/user/workspace/codeflare  (2026-06-02)

## Corpus Check
- Large corpus: 778 files · ~1,681,359 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 217 nodes · 841 edges · 14 communities (12 shown, 2 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `0836f6b3`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Terminal Session UI|Terminal Session UI]]
- [[_COMMUNITY_Storage Setup UI|Storage Setup UI]]
- [[_COMMUNITY_Container Setup Runtime|Container Setup Runtime]]
- [[_COMMUNITY_Worker Auth Vault Routing|Worker Auth Vault Routing]]
- [[_COMMUNITY_Session Container Lifecycle|Session Container Lifecycle]]
- [[_COMMUNITY_User Admin Credentials|User Admin Credentials]]
- [[_COMMUNITY_R2 Storage API|R2 Storage API]]
- [[_COMMUNITY_Auth Billing Stripe|Auth Billing Stripe]]
- [[_COMMUNITY_Host Session Server|Host Session Server]]
- [[_COMMUNITY_Pi Review Memory Runtime|Pi Review Memory Runtime]]
- [[_COMMUNITY_Splash Cursor Graphics|Splash Cursor Graphics]]
- [[_COMMUNITY_Pi Graphify SDD Guards|Pi Graphify SDD Guards]]
- [[_COMMUNITY_Graphify Update Scripts|Graphify Update Scripts]]
- [[_COMMUNITY_Pi Command Runtime|Pi Command Runtime]]

## God Nodes (most connected - your core abstractions)
1. `src/types.ts` - 55 edges
2. `src/lib/error-types.ts` - 54 edges
3. `src/lib/kv-keys.ts` - 39 edges
4. `src/lib/logger.ts` - 34 edges
5. `src/routes/terminal.ts` - 34 edges
6. `src/index.ts` - 33 edges
7. `src/middleware/auth.ts` - 33 edges
8. `web-ui/src/api/client.ts` - 32 edges
9. `web-ui/src/components/Icon.tsx` - 31 edges
10. `web-ui/src/stores/session.ts` - 28 edges

## Surprising Connections (you probably didn't know these)
- `host/src/session-manager.ts` --depends_on--> `web-ui/src/components/Icon.tsx`  [EXTRACTED]
  host/src/session-manager.ts → web-ui/src/components/Icon.tsx
- `host/src/session-manager.ts` --depends_on--> `web-ui/src/components/ui/Button.tsx`  [EXTRACTED]
  host/src/session-manager.ts → web-ui/src/components/ui/Button.tsx
- `scripts/migrate-tiers.ts` --depends_on--> `src/lib/user-record.ts`  [EXTRACTED]
  scripts/migrate-tiers.ts → src/lib/user-record.ts
- `src/container/index.ts` --depends_on--> `web-ui/src/api/client.ts`  [EXTRACTED]
  src/container/index.ts → web-ui/src/api/client.ts
- `src/lib/circuit-breaker.ts` --depends_on--> `web-ui/src/stores/session-polling.ts`  [EXTRACTED]
  src/lib/circuit-breaker.ts → web-ui/src/stores/session-polling.ts

## Import Cycles
- None detected.

## Communities (14 total, 2 thin omitted)

### Community 0 - "Terminal Session UI"
Cohesion: 0.09
Nodes (53): web-ui/src/components/CreateSessionDialog.tsx, web-ui/src/components/Dashboard.tsx, web-ui/src/components/FilePreview.tsx, web-ui/src/components/FloatingTerminalButtons.tsx, web-ui/src/components/Header.tsx, web-ui/src/components/InitProgress.tsx, web-ui/src/components/Layout.tsx, web-ui/src/components/SessionContextMenu.tsx (+45 more)

### Community 1 - "Storage Setup UI"
Cohesion: 0.09
Nodes (46): web-ui/src/App.tsx, web-ui/src/api/client.ts, web-ui/src/api/fetch-helper.ts, web-ui/src/api/storage.ts, web-ui/src/components/Icon.tsx, web-ui/src/components/KittScanner.tsx, web-ui/src/components/LoginPage.tsx, web-ui/src/components/OnboardingLanding.tsx (+38 more)

### Community 2 - "Container Setup Runtime"
Cohesion: 0.30
Nodes (19): src/container/container-env.ts, src/container/container-metrics.ts, src/container/index.ts, src/lib/activity-policy.ts, src/lib/cf-api.ts, src/lib/circuit-breaker.ts, src/lib/circuit-breakers.ts, src/lib/container-config-schema.ts (+11 more)

### Community 3 - "Worker Auth Vault Routing"
Cohesion: 0.29
Nodes (17): src/index.ts, src/lib/access-tier.ts, src/lib/access.ts, src/lib/cache-reset.ts, src/lib/cors-cache.ts, src/lib/jwt.ts, src/lib/logger.ts, src/lib/oauth-state.ts (+9 more)

### Community 4 - "Session Container Lifecycle"
Cohesion: 0.24
Nodes (16): scripts/generate-agent-seed.mjs, src/lib/agent-config.ts, src/lib/constants.ts, src/lib/container-helpers.ts, src/lib/kv-keys.ts, src/lib/r2-admin.ts, src/lib/session-helpers.ts, src/lib/session-mode.ts (+8 more)

### Community 5 - "User Admin Credentials"
Cohesion: 0.33
Nodes (14): src/lib/access-policy.ts, src/lib/kv-crypto.ts, src/lib/request-helpers.ts, src/middleware/auth.ts, src/routes/admin/tiers.ts, src/routes/container/index.ts, src/routes/deploy-keys.ts, src/routes/llm-keys.ts (+6 more)

### Community 6 - "R2 Storage API"
Cohesion: 0.43
Nodes (14): src/lib/r2-client.ts, src/lib/r2-config.ts, src/lib/r2-seed.ts, src/lib/r2-sse.ts, src/middleware/rate-limit.ts, src/routes/storage/browse.ts, src/routes/storage/delete.ts, src/routes/storage/download.ts (+6 more)

### Community 7 - "Auth Billing Stripe"
Cohesion: 0.27
Nodes (11): scripts/migrate-tiers.ts, src/lib/currency.ts, src/lib/email.ts, src/lib/stripe.ts, src/lib/turnstile.ts, src/lib/user-record.ts, src/lib/xml-utils.ts, src/routes/auth.ts (+3 more)

### Community 8 - "Host Session Server"
Cohesion: 0.46
Nodes (8): host/src/activity-tracker.ts, host/src/auth-check.ts, host/src/metrics.ts, host/src/prewarm-config.ts, host/src/server.ts, host/src/session-manager.ts, host/src/session.ts, host/src/types.ts

### Community 9 - "Pi Review Memory Runtime"
Cohesion: 0.47
Nodes (6): preseed/agents/pi/extensions/memory-vault-helpers.ts, preseed/agents/pi/extensions/memory-vault.ts, preseed/agents/pi/extensions/review-enforcement.ts, preseed/agents/pi/extensions/review-helpers.ts, preseed/agents/pi/extensions/review-job-helpers.ts, preseed/agents/pi/extensions/review-jobs.ts

### Community 10 - "Splash Cursor Graphics"
Cohesion: 0.50
Nodes (5): web-ui/src/components/SplashCursor.tsx, web-ui/src/lib/splash-cursor-logic.ts, web-ui/src/lib/splash-math.ts, web-ui/src/lib/splash-shaders.ts, web-ui/src/lib/webgl-utils.ts

### Community 11 - "Pi Graphify SDD Guards"
Cohesion: 0.50
Nodes (4): preseed/agents/pi/extensions/codeflare-pi.ts, preseed/agents/pi/extensions/graphify-helpers.ts, preseed/agents/pi/extensions/guard-helpers.ts, preseed/agents/pi/extensions/sdd-helpers.ts

## Knowledge Gaps
- **29 isolated node(s):** `host/src/auth-check.ts`, `preseed/agents/claude/plugins/graphify/scripts/safe-graphify-update.sh`, `preseed/agents/pi/extensions/codeflare-commands.ts`, `preseed/agents/pi/extensions/commands-helpers.ts`, `preseed/agents/pi/extensions/graphify-helpers.ts` (+24 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `web-ui/src/App.tsx` connect `Storage Setup UI` to `Terminal Session UI`, `Container Setup Runtime`, `Worker Auth Vault Routing`, `User Admin Credentials`, `Splash Cursor Graphics`?**
  _High betweenness centrality (0.193) - this node is a cross-community bridge._
- **Why does `src/routes/terminal.ts` connect `Worker Auth Vault Routing` to `Terminal Session UI`, `Storage Setup UI`, `Container Setup Runtime`, `Session Container Lifecycle`, `User Admin Credentials`?**
  _High betweenness centrality (0.181) - this node is a cross-community bridge._
- **Why does `web-ui/src/components/Icon.tsx` connect `Storage Setup UI` to `Host Session Server`, `Terminal Session UI`?**
  _High betweenness centrality (0.136) - this node is a cross-community bridge._
- **What connects `host/src/auth-check.ts`, `preseed/agents/claude/plugins/graphify/scripts/safe-graphify-update.sh`, `preseed/agents/pi/extensions/codeflare-commands.ts` to the rest of the system?**
  _29 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Terminal Session UI` be split into smaller, more focused modules?**
  _Cohesion score 0.09361393323657474 - nodes in this community are weakly interconnected._
- **Should `Storage Setup UI` be split into smaller, more focused modules?**
  _Cohesion score 0.08695652173913043 - nodes in this community are weakly interconnected._