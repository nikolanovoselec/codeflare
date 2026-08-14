# Stress Testing

k6-based load testing against an integration worker. Three load suites require `STRESS_TEST_MODE=active`; rate-limit validation requires it inactive. The workflow currently selects rate-limit validation for `all` as well, so one unchanged target cannot satisfy the combined `all` selection.

Implements [REQ-OPS-008](../../sdd/spec/operations.md#req-ops-008-stress-testing-validates-rate-limits-and-concurrency) (rate-limit + concurrency validation) and [REQ-OPS-044](../../sdd/spec/operations.md#req-ops-044-read-only-stress-target-verification) (validated, non-mutating target setup).

**Audience:** Operators

**Owns:** suite scenarios, prerequisites, thresholds, execution safety, and dated results. **Does not own:** canonical endpoint limits, deployment variables, workflow internals, or capacity guarantees.

## Contents

- [Prerequisites](#prerequisites)
- [Running](#running)
- [Test Suites](#test-suites)
- [Session Lifecycle Rate Limits Detail](#session-lifecycle-rate-limits-detail)
- [Think Time Model](#think-time-model)
- [VU-to-Real-User Mapping](#vu-to-real-user-mapping)
- [Concurrency Scaling](#concurrency-scaling)
- [Rate Limit Bypass](#rate-limit-bypass)
- [Configuration Reference](#configuration-reference)
- [Workflow Architecture](#workflow-architecture)
- [Results](#results)
- [Related Documentation](#related-documentation)
- [Specification Coverage](#specification-coverage)

## Prerequisites

1. **Integration worker deployed** with `STRESS_TEST_MODE=active` for the three load suites, or with it inactive for `rate-limit-validation`
2. **Deploy completed with service authentication configured.** Deploy writes `SERVICE_AUTH_SECRET` and fail-closed seeds `e2e-service@codeflare.local`; Stress Test only validates and exercises that deployed state.
3. **GitHub `integration` environment** with secrets (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`) and variable `E2E_BASE_URL`.
4. **`STRESS_TEST_CONCURRENCY`** variable set in the `integration` environment (optional, defaults to `0` which uses baseline VU counts).

## Running

Go to **Actions > Stress Test > Run workflow** and select one compatible suite. Do not use `all` against one unchanged target until the workflow owns a mode transition or separate target: source currently includes rate-limit validation in `all`, but its prerequisite is opposite to the load suites. The setup job rejects a non-origin target, confirms reachability and service authentication, and does not mutate Worker secrets, KV, or deployment resources.

To scale concurrency, set `STRESS_TEST_CONCURRENCY` in **Settings > Environments > integration > Environment variables**:

| Value | Effect | Real-user equivalent |
|-------|--------|---------------------|
| `0` or unset | Baseline VU counts, normal think times, standard thresholds | ~50 users |
| `50` | 5-17x baseline VUs, unchanged per-VU think times, loosened thresholds | ~1 000 users |
| `200` | 20-67x baseline VUs, unchanged per-VU think times, loosened thresholds | ~4 000 users |
| `1000` | 100-333x baseline VUs, unchanged per-VU think times, loosened thresholds | ~20 000 users |

## Test Suites

### API Throughput (`api-throughput.js`)

Sustained load plus spike traffic simulating dashboard activity. The suite is mostly reads but occasionally writes preferences with `PATCH /api/preferences`; it is not read-only.

| Scenario | Duration | Base VUs | Operations |
|----------|----------|----------|------------|
| `sustained_load` | 4m (ramp up, hold, ramp down) | 10 | Dashboard poll: `GET /api/sessions` (list), `GET /api/sessions/batch-status` (single-call status check), Optional: `GET /api/user`, `GET /api/preferences`, `GET /api/storage/browse` |
| `spike` | 50s (starts at 4m30s) | 10 | Same weighted operation mix as sustained load |

**Thresholds:**

| Metric | Threshold |
|--------|-----------|
| `http_req_duration` p95 | <5s |
| `http_req_failed` | <5% |
| `errors` | <10% |
| `session_list_duration` p95 | <5s |

**Think time:** `think(4, 6)` seconds between poll cycles - matches real frontend's ~5s poll interval. Per cycle: user/preferences (30% chance), storage/browse (20% chance). Remaining 50% of cycles are dashboard-only polling.

### Session Lifecycle (`session-lifecycle.js`)

Create-read-delete cycle testing session churn with realistic delays between operations.

| Scenario | Duration | Base VUs | Operations |
|----------|----------|----------|------------|
| `session_churn` | 3m (ramp up, hold, ramp down) | 3 | `POST /api/sessions` (create), `GET /api/sessions` (list), `GET /api/sessions/:id` (get), `DELETE /api/sessions/:id` (delete); the suite does not call stop |

**Rate limits hit by this suite:**
- Session create: 10/min → max ~1.6 VUs without bypass
- Session delete: 10/min → max ~1.6 VUs without bypass
- Session stop: 10/min → max ~1.6 VUs without bypass

**Thresholds:**

| Metric | Threshold |
|--------|-----------|
| `session_create_duration` p95 | <5s |
| `session_delete_duration` p95 | <3s |
| `errors` | <15% |

**Think time:** `think(3, 8)` after create, `think(2, 5)` between list/get/stop, `think(5, 15)` before delete, `think(10, 30)` between full cycles. Models a user who creates a session, works for a while, then cleans up.

### Storage Operations (`storage-operations.js`)

Upload-browse-download-delete cycle simulating an interactive agent session with weighted random file sizes.

File size distribution:
- 60% small files (1 KB)
- 30% medium files (20 KB)
- 10% large files (50 KB)

Folder delete testing: ~20% of iterations also test server-side prefix delete by uploading 3 files into a folder, then deleting the folder via the `prefixes` parameter (R2 list + batch delete via API).

| Scenario | Duration | Base VUs | Operations |
|----------|----------|----------|------------|
| `storage_load` | 3m (ramp up, hold, ramp down) | 5 | `POST /api/storage/upload` (simple), `GET /api/storage/browse`, `GET /api/storage/download`, `POST /api/storage/delete` (keys for individual files; prefixes for folders) |

**Rate limits hit by this suite:**
- Storage upload: 60/min → supports up to 10 VUs at baseline
- Storage browse: 30/min → max ~5 VUs
- Storage download: 120/min → max ~20 VUs (not the bottleneck)
- Storage delete: 20/min → max ~3 VUs

**Thresholds:**

| Metric | Threshold |
|--------|-----------|
| `upload_duration` p95 | <10s |
| `download_duration` p95 | <5s |
| `browse_duration` p95 | <3s |
| `errors` | <15% |

**Think time:** `think(3, 8)` after upload, `think(2, 5)` between browse/download/delete, `think(5, 15)` between full cycles. Models a user editing files in an active Codeflare session. Folder prefix delete operations add `think(1, 3)` between folder setup and delete.

### Stress Test with Rate Limits (`rate-limit-validation.js`)

Validates that rate limits are enforced when `STRESS_TEST_MODE` is **not** set. One VU bursts session creation and `PATCH /api/preferences` past their configured limits and verifies 429 responses.

**Must target a rate-limited deployment** — select `rate-limit-validation` and keep `STRESS_TEST_MODE` inactive. The workflow source also selects this job for `all`; that combined selection is currently unusable against the same target because the three load suites require bypass active.

| Check | Pass condition |
|-------|---------------|
| Rate limit enforced | At least one 429 returned |
| Requests succeed before limit | Some 201s before hitting cap |
| Cap not exceeded | Successful creates ≤ rate limit cap |
| No server errors | Unexpected error rate < 5% |

**Prerequisite:** `STRESS_TEST_MODE` must NOT be set on the worker (or set to anything other than `"active"`).

## Session Lifecycle Rate Limits Detail

The session lifecycle suite hits multiple 10/min rate limits:

1. **Session create** (`POST /api/sessions`) - 10/min
2. **Session delete** (`DELETE /api/sessions/:id`) - 10/min

The suite does not exercise the stop endpoint. With 3 base VUs and each cycle taking ~20-60 seconds, the VUs are throttled by the 10/min cap. `STRESS_TEST_MODE=active` is essential for testing beyond this limit.

The test validates that:
- Sessions are created successfully (201)
- Sessions can be fetched (200)
- Sessions can be stopped (204)
- Sessions can be deleted (204)
- Error rates remain <15% throughout

## Think Time Model

All scripts use a `think(min, max)` helper that adds realistic pauses between operations:

```js
function think(minS, maxS) {
  sleep(minS + Math.random() * (maxS - minS));
}
```

This produces uniformly distributed delays between `min` and `max` seconds, simulating real user behavior (reading output, deciding next action). `STRESS_TEST_CONCURRENCY` changes VU counts, not per-VU think times; the goal is sustained throughput, not a burst attack.

**Per-user behavior stays constant regardless of VU count.** Scaling `STRESS_TEST_CONCURRENCY` adds more virtual users running the same realistic interaction pattern. A single VU's think times, request sequences, and file sizes don't change - only the number of concurrent users increases.

## VU-to-Real-User Mapping

**50 VUs with realistic think times approximate 1 000-5 000 real concurrent users.**

The math: with think times of 4-15s between actions, each VU's effective request rate is ~0.1-0.2 req/s - matching real human behavior (load dashboard, read output, think, act). The multiplier comes from VUs hitting all endpoint types on every iteration while real users only touch 1-2 endpoints per interaction.

Each k6 virtual user generates more traffic than a real Codeflare user. A real user typically loads the dashboard (a few API calls), then works in a terminal (one WebSocket held for minutes), with occasional storage operations - roughly 1 request every 5-10 seconds during active use.

k6 VUs use realistic think times (4-15s between actions) but hit all endpoint types on every iteration. Real users only interact with 1-2 endpoints per session.

| Suite | Think time per cycle | Requests per cycle | Effective req/s per VU | Multiplier vs real user |
|-------|---------------------|-------------------|----------------------|------------------------|
| API throughput | 4-6s (dashboard poll) | 4-6 | ~1.0 | ~5-10x |
| Session lifecycle | 20-60s (create→delete) | 4 | ~0.1 | ~1-2x |
| Storage operations | 13-33s (upload→delete) | 4 | ~0.2 | ~2-3x |

**Rule of thumb: 1 VU ≈ 20-100 real users** (varies by suite). At `STRESS_TEST_CONCURRENCY=50`, the three suites running in parallel simulate load equivalent to roughly 1 000-5 000 concurrent Codeflare users.

## Concurrency Scaling

All scripts use the same scaling pattern:

```js
const CONCURRENCY = parseInt(__ENV.STRESS_TEST_CONCURRENCY || '0', 10);
const BASE_VUS = <N>;
const SCALE = CONCURRENCY > 0 ? CONCURRENCY / BASE_VUS : 1;
function scaled(vus) { return Math.max(1, Math.round(vus * SCALE)); }
```

When `STRESS_TEST_CONCURRENCY=0` (default), `SCALE=1` and all VU targets remain at baseline. When set to a positive number, VU targets scale proportionally. Example: `STRESS_TEST_CONCURRENCY=50` with `BASE_VUS=10` gives `SCALE=5`, so `scaled(10)=50` VUs.

Think times stay constant regardless of concurrency - scaling adds more users running the same realistic behavior, not faster robots.

## Rate Limit Bypass

All VUs share a single CF Access service token (single identity). Without bypass, per-user rate limits block meaningful load testing:

| Rate Limit | Limit | Effective VUs without bypass |
|------------|-------|------------------------------|
| Session create | 10/min | Max ~1.6 VUs (one cycle every 6 seconds) |
| Session delete | 10/min | Max ~1.6 VUs |
| Session stop | 10/min | Max ~1.6 VUs |
| Container start | 5/min | Max ~0.8 VUs |
| WebSocket connect | 30/min | Max ~5 VUs (one connection every 2 seconds) |
| Storage upload | 60/min | Max ~10 VUs |
| Storage browse | 30/min | Max ~5 VUs |

Setting `STRESS_TEST_MODE=active` on the integration worker disables all rate-limit checks. The bypass:

- Requires the exact string `"active"` as an environment variable/secret - any other value keeps limits enforced
- Skips rate-limit KV reads/writes before they are checked, with zero overhead
- Logs a one-time warning per isolate when activated (`STRESS_TEST_MODE is active - all HTTP rate limits bypassed`)
- Is implemented at:
  - **HTTP requests:** `src/middleware/rate-limit.ts` (checkRateLimit skipped)
  - **WebSocket connections:** `src/routes/terminal.ts` (checkRateLimit skipped)

**Production must never have `STRESS_TEST_MODE` set.** Enable the flag only on integration workers used for load testing.

## Configuration Reference

### Worker environment variable

| Variable | Where | Value | Purpose | Must be exact |
|----------|-------|-------|---------|---------------|
| `STRESS_TEST_MODE` | Integration worker only | `"active"` | Disables all rate limits | Yes - any other value (e.g., `"true"`, `"enabled"`) keeps limits enforced |

Set via one of:
```bash
# Option 1: Set as environment variable (one-time, this session)
wrangler secret put STRESS_TEST_MODE
# Paste: active

# Option 2: Set via command line at deploy time
wrangler deploy --var STRESS_TEST_MODE=active

# Option 3: Set in wrangler.toml
[env.integration]
vars = { STRESS_TEST_MODE = "active" }
```

After setting, re-deploy the worker for the variable to take effect:
```bash
wrangler deploy --env integration
```

### GitHub variables (integration environment)

| Variable | Default | Purpose |
|----------|---------|---------|
| `STRESS_TEST_CONCURRENCY` | `0` | k6 virtual user scaling factor |
| `E2E_BASE_URL` | - | Target Worker HTTPS origin |

### GitHub secrets

**Integration environment secrets:**

| Secret | Purpose |
|--------|---------|
| `CF_ACCESS_CLIENT_ID` | Service token ID for CF Access |
| `CF_ACCESS_CLIENT_SECRET` | Service token secret used by the probe; Deploy owns the matching Worker secret and service-user seed |
| `OAUTH_E2E_TEST_SECRET` | Optional service-auth fallback used when CF Access credentials are not configured |

## Workflow Architecture

```
stress-test.yml (workflow_dispatch)
  |
  +-- setup (verify target health + auth)
  |     |
  +--+--+-- api-throughput      (parallel)
  |  |  +-- session-lifecycle   (parallel)
  |  |  +-- storage-operations  (parallel)
  |  |
  +--+--+-- summary (aggregate results, check thresholds)
```

All 3 test jobs run in parallel after setup. The summary job downloads all result artifacts and fails the workflow if any k6 threshold was breached.

Results are uploaded as artifacts (retained 30 days).

## Results

### Historical Results (2026-03-07 workflow and suite definitions, 50 VUs)

All three suites passed every threshold at `STRESS_TEST_CONCURRENCY=50`. Run: [#22808941531](https://github.com/nikolanovoselec/codeflare/actions/runs/22808941531).

#### API Throughput

| Metric | avg | p95 | max | Result |
|--------|-----|-----|-----|--------|
| `http_req_duration` | 1.37s | 3.07s | 5.63s | PASS (<5s p95) |
| `health_duration` | 27ms | 40ms | 171ms | PASS (<1s p95) |
| `session_list_duration` | 2.55s | 3.11s | 5.63s | PASS (<5s p95) |
| `http_req_failed` | 0.00% | - | - | PASS (<5%) |
| `errors` | 0.00% | - | - | PASS |
| `checks` | 100.00% (7 729/7 729) | - | - | - |

#### Session Lifecycle

| Metric | avg | p95 | max | Result |
|--------|-----|-----|-----|--------|
| `session_create_duration` | 103ms | 199ms | 384ms | PASS (<5s p95) |
| `session_delete_duration` | 792ms | 1.64s | 5.21s | PASS (<3s p95) |
| `errors` | 0.00% | - | - | PASS (<15%) |
| `checks` | 100.00% (804/804) | - | - | - |

#### Storage Operations

| Metric | avg | p95 | max | Result |
|--------|-----|-----|-----|--------|
| `upload_duration` | 285ms | 459ms | 1.04s | PASS (<10s p95) |
| `download_duration` | 112ms | 149ms | 403ms | PASS (<5s p95) |
| `browse_duration` | 80ms | 97ms | 140ms | PASS (<3s p95) |
| `errors` | 3.44% (10/290) | - | - | PASS (<15%) |
| `checks` | 98.76% (1 116/1 130) | - | - | - |

At 50 VUs with realistic think times, this represents approximately **1 000-5 000 concurrent real users** worth of load.

### Files

| File | Purpose |
|------|---------|
| `stress/api-throughput.js` | API endpoint throughput + spike test |
| `stress/session-lifecycle.js` | Session CRUD churn test |
| `stress/storage-operations.js` | R2 storage upload/download/delete cycle |
| `stress/rate-limit-validation.js` | Rate limit enforcement validation |
| `.github/workflows/stress-test.yml` | CI workflow orchestration |
| `src/middleware/rate-limit.ts` | HTTP rate-limit middleware; `STRESS_TEST_MODE` bypass |
| `src/routes/terminal.ts` | WebSocket auth + rate-limit; `STRESS_TEST_MODE` bypass |
| `src/lib/rate-limit-core.ts` | Core rate-limit logic (KV + in-memory fallback) |
| `src/lib/constants.ts` | `WS_RATE_LIMIT_*` constants |

### Subscription and Timekeeper Considerations

The subscription system introduces endpoints and a Durable Object not yet covered by existing k6 suites.

#### Endpoints not yet stress-tested

| Endpoint | Method | Rate Limit | Notes |
|----------|--------|------------|-------|
| `/api/auth/subscribe` | POST | 3/min | Self-service tier selection; Turnstile required |
| `/api/auth/tiers` | GET | None | Returns subscribable tier config |
| `/api/usage` | GET | None | Queries Timekeeper DO with KV fallback |
| `/api/admin/tiers` | GET/PUT | None | Admin tier config; low traffic |
| `/api/auth/onboarding-config` | GET | None | Turnstile site key |

#### Timekeeper DO load characteristics

The Timekeeper DO receives pings every 60 seconds from each active container session:

- **Write amplification:** Each ping triggers DO storage writes plus a KV read for quota checks
- **Flush interval:** KV writes batch every 5 minutes via alarm (not per-ping)
- **Session eviction:** `sessionTotals` map caps at 30 entries to prevent unbounded growth
- **Fail-open design:** KV read failures during quota checks are non-fatal

#### Container start quota check

`validateSessionAndCheckLimits()` in `src/routes/container/lifecycle-validation.ts` performs a KV read at session start. With `STRESS_TEST_MODE=active`, usage quota enforcement is bypassed (same as rate limits).

---

## Related Documentation

- [Security Reference - Rate Limiting](security.md#rate-limiting) - Rate limits per endpoint
- [Security Policy](../../SECURITY.md) - Vulnerability reporting
- [pentest.md](pentest.md) - Security scan results
- [Configuration - Worker Environment](configuration.md#worker-environment) - Environment variables
- [CI/CD & Testing](ci-cd.md#testing) - CI test suites

---

## Specification Coverage

- [REQ-OPS-008](../../sdd/spec/operations.md#req-ops-008-stress-testing-validates-rate-limits-and-concurrency) - Stress testing validates rate limits and concurrency
- [REQ-OPS-044](../../sdd/spec/operations.md#req-ops-044-read-only-stress-target-verification) - Read-only stress target verification
