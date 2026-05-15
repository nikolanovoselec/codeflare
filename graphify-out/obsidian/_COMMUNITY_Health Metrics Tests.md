---
type: community
cohesion: 0.05
members: 40
---

# Health Metrics Tests

**Cohesion:** 0.05 - loosely connected
**Members:** 40 nodes

## Members
- [[60s user record cache (resetUserRecordCache)]] - code - src/__tests__/timekeeper/index.test.ts
- [[Accent color reset to default]] - code - e2e/ui/error-states.test.ts
- [[AccessTier zod schema]] - code - src/types.ts
- [[AccessUser (Cloudflare Access JWT identity)]] - code - src/types.ts
- [[AgentType zod schema (claude-codecodexcopilotgeminiopencodebash)]] - code - src/types.ts
- [[Auto-start container when clicking stopped session]] - code - e2e/ui/session-lifecycle.test.ts
- [[BillingStatus zod schema + BILLING_STATUS constant]] - code - src/types.ts
- [[CF Access service token headers]] - code - e2e/stress/api-throughput.js
- [[CF-001 (STRESS_TEST_MODE forbidden in SaaS prod)]] - document - src/index.ts
- [[CF-001 STRESS_TEST_MODE blocked in SaaS prod]] - code - src/index.ts
- [[CF-020 (delta clamp + alarm retry + trial quota)]] - document - src/__tests__/timekeeper/index.test.ts
- [[CF-020 delta clamp to 300s per ping]] - code - src/__tests__/timekeeper/index.test.ts
- [[CF-020 trial quota enforcement (trialQuotaHours)]] - code - src/__tests__/timekeeper/index.test.ts
- [[Container metrics unit suite]] - code - src/__tests__/container-metrics.test.ts
- [[ContainerConfigPayload (DO init bundle)]] - code - src/types.ts
- [[Create dialog agent type options]] - code - e2e/ui/dashboard.test.ts
- [[DeployKeys (user GitHubCloudflare tokens)]] - code - src/types.ts
- [[LLM API Keys section (advanced mode)]] - code - e2e/ui/settings-panel.test.ts
- [[LlmKeys (user OpenAIGemini keys)]] - code - src/types.ts
- [[Max 6 terminal tabs constraint]] - code - e2e/ui/terminal-tabs.test.ts
- [[PATCH apipreferences rate limit (20min)]] - code - e2e/stress/rate-limit-validation.js
- [[Preset (saved bookmark)]] - code - src/types.ts
- [[Preset CRUD via apipresets]] - code - e2e/ui/bookmarks.test.ts
- [[Saved bookmark captures tab layout]] - code - e2e/ui/bookmarks.test.ts
- [[Session card metrics after container ready]] - code - e2e/ui/session-lifecycle.test.ts
- [[Session lifecycle E2E suite]] - code - e2e/ui/session-lifecycle.test.ts
- [[Session metadata interface]] - code - src/types.ts
- [[SessionMode zod schema (defaultadvanced)]] - code - src/types.ts
- [[Settings accordion groups (AppearanceSessionLLM)]] - code - e2e/ui/settings-panel.test.ts
- [[SleepAfterOption (5m15m30m1h2h)]] - code - src/types.ts
- [[SubscriptionTier zod schema]] - code - src/types.ts
- [[SubscriptionTierConfig (KV-stored tier config)]] - code - src/types.ts
- [[TabConfig (terminal tab)]] - code - src/types.ts
- [[Tap active tab opens close popup (mobile)]] - code - e2e/ui/mobile-specific.test.ts
- [[Terminal tabs E2E suite]] - code - e2e/ui/terminal-tabs.test.ts
- [[UserPreferences (per-user settings)]] - code - src/types.ts
- [[Workspace sync + fast start toggles]] - code - e2e/ui/settings-panel.test.ts
- [[collectMetrics fetches health TCP port and writes to KV]] - code - src/__tests__/container-metrics.test.ts
- [[k6 sustained_load + spike scenarios]] - code - e2e/stress/api-throughput.js
- [[sleepAfter fail-safe 2h fallback]] - code - src/__tests__/container-metrics.test.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Health_Metrics_Tests
SORT file.name ASC
```
