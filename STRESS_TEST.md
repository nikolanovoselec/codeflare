# Stress Testing

k6-based load testing against the integration worker. Four test suites run in parallel via the `stress-test.yml` GitHub Actions workflow.

## Prerequisites

1. **Integration worker deployed** with `STRESS_TEST_MODE=active` (disables all rate limits — required because all VUs share one service identity)
2. **GitHub `integration` environment** with secrets (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`) and variables (`E2E_BASE_URL`, `CLOUDFLARE_WORKER_NAME`)
3. **Repository-level secrets** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (used by setup job to push `SERVICE_AUTH_SECRET` and seed KV via wrangler)
4. **`STRESS_TEST_CONCURRENCY`** variable set in the `integration` environment (optional, defaults to `0` which uses baseline VU counts)

## Running

Go to **Actions > Stress Test > Run workflow**. Select a suite or leave as `all`.

To scale concurrency, set `STRESS_TEST_CONCURRENCY` in **Settings > Environments > integration > Environment variables**:

| Value | Effect | Real-user equivalent |
|-------|--------|---------------------|
| `0` or unset | Baseline VU counts, normal think times, standard thresholds | ~50 users |
| `50` | 5-17x baseline VUs, reduced think times, loosened thresholds | ~1 000 users |
| `200` | 20-67x baseline VUs, minimal think times, loosened thresholds | ~4 000 users |
| `1000` | 100-333x baseline VUs, minimal think times, loosened thresholds | ~20 000 users |

## Test Suites

### API Throughput (`api-throughput.js`)

Sustained load + spike test across read-only API endpoints.

| Scenario | Duration | Base VUs | Endpoints |
|----------|----------|----------|-----------|
| `sustained_load` | 4m (ramp up, hold, ramp down) | 10 | `/health`, `/api/sessions`, `/api/user`, `/api/preferences`, `/api/storage/browse`, `/api/sessions/batch-status` |
| `spike` | 50s (starts at 4m30s) | 20 | Same |

**Thresholds:**

| Metric | Standard | High Concurrency (>20 VUs) |
|--------|----------|-----------------------------|
| `http_req_duration` p95 | <2s | <5s |
| `http_req_failed` | <5% | <5% |
| `health_duration` p95 | <500ms | <2s |
| `session_list_duration` p95 | <3s | <8s |

### Session Lifecycle (`session-lifecycle.js`)

Create-read-delete cycle testing session churn.

| Scenario | Duration | Base VUs | Operations |
|----------|----------|----------|------------|
| `session_churn` | 3m (ramp up, hold, ramp down) | 3 | `POST /api/sessions`, `GET /api/sessions`, `GET /api/sessions/:id`, `DELETE /api/sessions/:id` |

**Thresholds:**

| Metric | Standard | High Concurrency |
|--------|----------|------------------|
| `session_create_duration` p95 | <5s | <10s |
| `session_delete_duration` p95 | <3s | <8s |
| `errors` | <15% | <15% |

**Think time:** 6s between iterations (respects 10 req/min session rate limit). Reduced to 1s when `STRESS_TEST_CONCURRENCY` is set (rate limits bypassed).

### Storage Operations (`storage-operations.js`)

Upload-browse-download-delete cycle with random file sizes (1 KB, 50 KB, 500 KB).

| Scenario | Duration | Base VUs | Operations |
|----------|----------|----------|------------|
| `storage_load` | 3m (ramp up, hold, ramp down) | 5 | `POST /api/storage/upload`, `GET /api/storage/browse`, `GET /api/storage/download`, `POST /api/storage/delete` |

**Thresholds:**

| Metric | Standard | High Concurrency |
|--------|----------|------------------|
| `upload_duration` p95 | <10s | <20s |
| `download_duration` p95 | <5s | <10s |
| `browse_duration` p95 | <3s | <8s |
| `errors` | <15% | <15% |

**Think time:** 2s between iterations. Reduced to 0.5s when concurrency is set.

### Stress Test with Rate Limits (`rate-limit-validation.js`)

Validates that rate limits ARE enforced when `STRESS_TEST_MODE` is **not** set. Runs a single VU that bursts session creates past the configured limit and verifies 429 responses.

**Must be run separately** — select `rate-limit-validation` from the suite dropdown. Not included in `all` because the load test suites require rate limits to be off.

| Check | Pass condition |
|-------|---------------|
| Rate limit enforced | At least one 429 returned |
| Requests succeed before limit | Some 201s before hitting cap |
| Cap not exceeded | Successful creates ≤ rate limit cap |
| No server errors | Unexpected error rate < 5% |

**Prerequisite:** `STRESS_TEST_MODE` must NOT be set on the worker (or set to anything other than `"active"`).

## VU-to-Real-User Mapping

Each k6 virtual user generates far more traffic than a real Codeflare user. A real user typically loads the dashboard (a few API calls), then works in a terminal (one WebSocket held for minutes), with occasional storage operations — roughly 1 request every 5-10 seconds during active use.

k6 VUs differ because they have near-zero think time (0.3-1s vs 5-30s for real users), hit all endpoints on every iteration, and never idle.

| Suite | Requests per VU per second | Multiplier vs real user |
|-------|---------------------------|------------------------|
| API throughput | ~20 (6 endpoints, 0.3s sleep) | ~100-200x |
| Session lifecycle | ~1 (4 ops + 4s sleeps) | ~5-10x |
| Storage operations | ~2 (4 ops + 2s sleeps) | ~10-20x |

**Rule of thumb: 1 VU ≈ 20 real users.** At `STRESS_TEST_CONCURRENCY=50`, the three suites running in parallel simulate load equivalent to roughly 1 000 concurrent Codeflare users.

## Concurrency Scaling

All scripts use the same scaling pattern:

```js
const CONCURRENCY = parseInt(__ENV.STRESS_TEST_CONCURRENCY || '0', 10);
const BASE_VUS = <N>;
const SCALE = CONCURRENCY > 0 ? CONCURRENCY / BASE_VUS : 1;
function scaled(vus) { return Math.max(1, Math.round(vus * SCALE)); }
const HIGH_CONCURRENCY = CONCURRENCY > 20;
```

When `STRESS_TEST_CONCURRENCY=0` (default), `SCALE=1` and all VU targets remain at baseline. When set to a positive number, VU targets scale proportionally. Example: `STRESS_TEST_CONCURRENCY=500` with `BASE_VUS=10` gives `SCALE=50`, so `scaled(10)=500` VUs.

Think times are reduced when concurrency is set because rate limits are off (`STRESS_TEST_MODE=active` on the worker).

Thresholds loosen automatically when `CONCURRENCY > 20` to account for higher backend load.

## Rate Limit Bypass

All VUs share a single CF Access service token (single identity). Without bypass, per-user rate limits block meaningful load testing:

| Rate Limit | Normal | Effect on Stress Tests |
|------------|--------|----------------------|
| Session create/delete | 10/min | Max ~1.6 VUs for session lifecycle |
| Container start | 5/min | Max ~0.8 VUs for container operations |
| WebSocket connect | 30/min | Max ~5 VUs for WebSocket tests |

Setting `STRESS_TEST_MODE=active` on the integration worker disables all rate-limit KV reads/writes. The bypass:

- Requires the exact string `"active"` -- any other value keeps limits enforced
- Skips before any KV I/O (zero overhead)
- Logs a one-time warning per isolate when activated
- Is implemented in `src/middleware/rate-limit.ts` (HTTP) and `src/routes/terminal.ts` (WebSocket)

**Production must never have `STRESS_TEST_MODE` set.**

## Configuration Reference

### Worker environment variable

| Variable | Where | Value | Purpose |
|----------|-------|-------|---------|
| `STRESS_TEST_MODE` | Integration worker only | `"active"` | Disables all rate limits |

Set via `wrangler secret put STRESS_TEST_MODE` or `--var STRESS_TEST_MODE=active` at deploy time.

### GitHub variables (integration environment)

| Variable | Default | Purpose |
|----------|---------|---------|
| `STRESS_TEST_CONCURRENCY` | `0` | k6 virtual user scaling factor |
| `E2E_BASE_URL` | - | Target worker URL |
| `CLOUDFLARE_WORKER_NAME` | - | Worker name for wrangler secret/KV operations |

### GitHub secrets

**Integration environment secrets:**

| Secret | Purpose |
|--------|---------|
| `CF_ACCESS_CLIENT_ID` | Service token ID for CF Access |
| `CF_ACCESS_CLIENT_SECRET` | Service token secret (also pushed as `SERVICE_AUTH_SECRET` and used as `X-Service-Auth` header) |

**Repository-level secrets** (used by setup job for wrangler):

| Secret | Purpose |
|--------|---------|
| `CLOUDFLARE_API_TOKEN` | Wrangler API access for `secret put` and KV operations |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account for wrangler commands |

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

## Files

| File | Purpose |
|------|---------|
| `e2e/stress/api-throughput.js` | API endpoint throughput + spike test |
| `e2e/stress/session-lifecycle.js` | Session CRUD churn test |
| `e2e/stress/storage-operations.js` | R2 storage upload/download/delete cycle |
| `e2e/stress/rate-limit-validation.js` | Rate limit enforcement validation |
| `.github/workflows/stress-test.yml` | CI workflow |
| `src/middleware/rate-limit.ts` | HTTP rate-limit bypass (`STRESS_TEST_MODE`) |
| `src/routes/terminal.ts` | WebSocket rate-limit bypass (`STRESS_TEST_MODE`) |
| `src/__tests__/middleware/rate-limit.test.ts` | Unit tests for bypass |
| `src/__tests__/routes/terminal-ws.test.ts` | Unit tests for WS rate-limit bypass |
