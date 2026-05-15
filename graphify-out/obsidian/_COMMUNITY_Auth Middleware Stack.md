---
type: community
cohesion: 0.05
members: 48
---

# Auth Middleware Stack

**Cohesion:** 0.05 - loosely connected
**Members:** 48 nodes

## Members
- [[AGENT_CONFIGS map (codex, gemini, copilot, opencode)]] - code - scripts/generate-agent-seed.mjs
- [[Advanced example Astro blog with Durable Objects + R2]] - document - preseed/tutorials/Examples/Advanced.md
- [[AuthVariables Hono context type]] - code - src/middleware/auth.ts
- [[CONTRIBUTING]] - document - CONTRIBUTING.md
- [[CSRF X-Requested-With header requirement]] - document - SECURITY.md
- [[Codeflare README]] - document - README.md
- [[Container Durable Object class]] - code - src/container/index.ts
- [[Examples Intro (spec-driven projects)]] - document - preseed/tutorials/Examples/Intro.md
- [[Getting Started tutorial]] - document - preseed/tutorials/Getting Started.md
- [[Intermediate example CV website with Turnstile contact form]] - document - preseed/tutorials/Examples/Intermediate.md
- [[POST apicontainerstart route handler]] - code - src/routes/container/lifecycle.ts
- [[Preseed spec-discipline.md (SDD core rule)]] - document - preseed/agents/claude/rules/spec-discipline.md
- [[RateLimitConfig interface]] - code - src/middleware/rate-limit.ts
- [[SDK sleepAfter pinned to 24h (disabled in favor of collectMetrics)]] - code - src/container/index.ts
- [[SECURITY]] - document - SECURITY.md
- [[STRESS_TEST_MODE bypass for rate limiting]] - code - src/middleware/rate-limit.ts
- [[Simple example Hello World Worker]] - document - preseed/tutorials/Examples/Simple.md
- [[SolidJS SPA index.html (web-ui entry)]] - code - web-ui/index.html
- [[TOOL_MAP (Claude tools - per-agent equivalents)]] - code - scripts/generate-agent-seed.mjs
- [[Three-tier access control (requireIdentity  requireActiveUser  requireAdmin)]] - document - SECURITY.md
- [[Timekeeper usage ping (60s cadence, SaaS mode)]] - code - src/container/container-metrics.ts
- [[Toolchain GitHub to Cloudflare Workers tutorial]] - document - preseed/tutorials/Documentation/Toolchain.md
- [[Tutorials Documentation Readme]] - document - preseed/tutorials/Documentation/Readme.md
- [[User-input-based idle detection (overrides SDK sleepAfter timer)]] - code - src/container/container-metrics.ts
- [[applyBucketName]] - code - src/container/container-env.ts
- [[applyPrefsOnRestart]] - code - src/container/container-env.ts
- [[buildEnvVars]] - code - src/container/container-env.ts
- [[buildSetBucketNameBody]] - code - src/routes/container/lifecycle.ts
- [[collectMetrics function]] - code - src/container/container-metrics.ts
- [[configureContainerDO]] - code - src/routes/container/lifecycle.ts
- [[containerStartRateLimiter (5min)]] - code - src/routes/container/lifecycle.ts
- [[createRateLimiter factory]] - code - src/middleware/rate-limit.ts
- [[ensureBucketAndSeed]] - code - src/routes/container/lifecycle.ts
- [[fix-broken-sourcemaps.js (strips @cloudflarecontainers sourcemaps)]] - code - scripts/fix-broken-sourcemaps.js
- [[generate-agent-seed.mjs (multi-agent config builder)]] - code - scripts/generate-agent-seed.mjs
- [[generate-tutorial-seed.mjs (preseed - TS module)]] - code - scripts/generate-tutorial-seed.mjs
- [[handleSetBucketName internal route]] - code - src/container/index.ts
- [[mapTier (tier mapping function)]] - code - scripts/migrate-tiers.ts
- [[migrateUsers (accessTier - subscriptionTier)]] - code - scripts/migrate-tiers.ts
- [[parseSleepAfterMs]] - code - src/container/container-metrics.ts
- [[requireActiveUser middleware]] - code - src/middleware/auth.ts
- [[requireAdmin middleware]] - code - src/middleware/auth.ts
- [[requireIdentity middleware]] - code - src/middleware/auth.ts
- [[setupR2Credentials]] - code - src/routes/container/lifecycle.ts
- [[startOrRestartContainer]] - code - src/routes/container/lifecycle.ts
- [[updateKvStatus]] - code - src/container/container-metrics.ts
- [[validateBucketNameInput]] - code - src/container/container-env.ts
- [[validateSessionAndCheckLimits]] - code - src/routes/container/lifecycle.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Auth_Middleware_Stack
SORT file.name ASC
```
