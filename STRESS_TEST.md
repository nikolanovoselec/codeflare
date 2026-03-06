# Stress Testing

k6-based load testing against the integration worker. Four test suites run in parallel via the `stress-test.yml` GitHub Actions workflow.

## Prerequisites

1. **Integration worker deployed** with `STRESS_TEST_MODE=active` (disables all rate limits)
2. **GitHub `integration` environment** with secrets (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`) and variables (`E2E_BASE_URL`)
3. **`STRESS_TEST_CONCURRENCY`** variable set in the `integration` environment (optional, defaults to `0` which uses baseline VU counts)

## Running

Go to **Actions > Stress Test > Run workflow**. Select a suite or leave as `all`.

To scale concurrency, set `STRESS_TEST_CONCURRENCY` in **Settings > Environments > integration > Environment variables**:

| Value | Effect |
|-------|--------|
| `0` or unset | Baseline VU counts, normal think times, standard thresholds |
| `100` | 10x baseline VUs, reduced think times, standard thresholds |
| `200` | 20x baseline VUs, reduced think times, loosened thresholds (>100 triggers HIGH_CONCURRENCY) |
| `1000` | 100x baseline VUs, minimal think times, loosened thresholds |

## Test Suites

### API Throughput (`api-throughput.js`)

Sustained load + spike test across read-only API endpoints.

| Scenario | Duration | Base VUs | Endpoints |
|----------|----------|----------|-----------|
| `sustained_load` | 4m (ramp up, hold, ramp down) | 10 | `/health`, `/api/sessions`, `/api/user`, `/api/preferences`, `/api/storage/browse`, `/api/sessions/batch-status` |
| `spike` | 50s (starts at 4m30s) | 20 | Same |

**Thresholds:**

| Metric | Standard | High Concurrency (>100 VUs) |
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

### WebSocket Concurrency (`websocket-concurrency.js`)

Concurrent WebSocket connections to a shared container. Creates a session and starts a container in `setup()`, cleans up in `teardown()`.

| Scenario | Duration | Base VUs | Operations |
|----------|----------|----------|------------|
| `ws_connections` | 3m (ramp up, hold, ramp down) | 10 | WebSocket connect to `/api/terminal/:sessionId-:terminalId/ws`, resize command, hold 10-30s, close |

**Thresholds:**

| Metric | Standard | High Concurrency |
|--------|----------|------------------|
| `ws_connect_duration` p95 | <10s | <20s |
| `errors` | <30% | <50% |

**Think time:** 2s between iterations. Reduced to 0.5s when concurrency is set.

## Concurrency Scaling

All scripts use the same scaling pattern:

```js
const CONCURRENCY = parseInt(__ENV.STRESS_TEST_CONCURRENCY || '0', 10);
const BASE_VUS = <N>;
const SCALE = CONCURRENCY > 0 ? CONCURRENCY / BASE_VUS : 1;
function scaled(vus) { return Math.max(1, Math.round(vus * SCALE)); }
const HIGH_CONCURRENCY = CONCURRENCY > 100;
```

When `STRESS_TEST_CONCURRENCY=0` (default), `SCALE=1` and all VU targets remain at baseline. When set to a positive number, VU targets scale proportionally. Example: `STRESS_TEST_CONCURRENCY=500` with `BASE_VUS=10` gives `SCALE=50`, so `scaled(10)=500` VUs.

Think times are reduced when concurrency is set because rate limits are off (`STRESS_TEST_MODE=active` on the worker).

Thresholds loosen automatically when `CONCURRENCY > 100` to account for higher backend load.

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

### GitHub secrets (integration environment)

| Secret | Purpose |
|--------|---------|
| `CF_ACCESS_CLIENT_ID` | Service token ID for auth |
| `CF_ACCESS_CLIENT_SECRET` | Service token secret (also used as `X-Service-Auth`) |

## Workflow Architecture

```
stress-test.yml (workflow_dispatch)
  |
  +-- setup (verify target health + auth)
  |     |
  +--+--+-- api-throughput      (parallel)
  |  |  +-- session-lifecycle   (parallel)
  |  |  +-- storage-operations  (parallel)
  |  |  +-- websocket-concurrency (parallel)
  |  |
  +--+--+-- summary (aggregate results, check thresholds)
```

All 4 test jobs run in parallel after setup. The summary job downloads all result artifacts and fails the workflow if any k6 threshold was breached.

Results are uploaded as artifacts (retained 30 days).

## Files

| File | Purpose |
|------|---------|
| `e2e/stress/api-throughput.js` | API endpoint throughput + spike test |
| `e2e/stress/session-lifecycle.js` | Session CRUD churn test |
| `e2e/stress/storage-operations.js` | R2 storage upload/download/delete cycle |
| `e2e/stress/websocket-concurrency.js` | Concurrent WebSocket connections |
| `.github/workflows/stress-test.yml` | CI workflow |
| `src/middleware/rate-limit.ts` | HTTP rate-limit bypass (`STRESS_TEST_MODE`) |
| `src/routes/terminal.ts` | WebSocket rate-limit bypass (`STRESS_TEST_MODE`) |
| `src/__tests__/middleware/rate-limit.test.ts` | Unit tests for bypass |
| `src/__tests__/routes/terminal-ws.test.ts` | Unit tests for WS bypass |
