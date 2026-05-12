# Stress Testing: Results & File Reference

Latest benchmark results, test file index, and subscription/Timekeeper load considerations.

**Audience:** Operators

See [Stress Testing](STRESS_TEST.md) for test setup, running instructions, and configuration.

---

## Latest Results (2026-03-07, 50 VUs)

All three suites passed every threshold at `STRESS_TEST_CONCURRENCY=50`. Run: [#22808941531](https://github.com/nikolanovoselec/codeflare/actions/runs/22808941531).

### API Throughput

| Metric | avg | p95 | max | Result |
|--------|-----|-----|-----|--------|
| `http_req_duration` | 1.37s | 3.07s | 5.63s | PASS (<5s p95) |
| `health_duration` | 27ms | 40ms | 171ms | PASS (<1s p95) |
| `session_list_duration` | 2.55s | 3.11s | 5.63s | PASS (<5s p95) |
| `http_req_failed` | 0.00% | - | - | PASS (<5%) |
| `errors` | 0.00% | - | - | PASS |
| `checks` | 100.00% (7 729/7 729) | - | - | - |

### Session Lifecycle

| Metric | avg | p95 | max | Result |
|--------|-----|-----|-----|--------|
| `session_create_duration` | 103ms | 199ms | 384ms | PASS (<5s p95) |
| `session_delete_duration` | 792ms | 1.64s | 5.21s | PASS (<3s p95) |
| `errors` | 0.00% | - | - | PASS (<15%) |
| `checks` | 100.00% (804/804) | - | - | - |

### Storage Operations

| Metric | avg | p95 | max | Result |
|--------|-----|-----|-----|--------|
| `upload_duration` | 285ms | 459ms | 1.04s | PASS (<10s p95) |
| `download_duration` | 112ms | 149ms | 403ms | PASS (<5s p95) |
| `browse_duration` | 80ms | 97ms | 140ms | PASS (<3s p95) |
| `errors` | 3.44% (10/290) | - | - | PASS (<15%) |
| `checks` | 98.76% (1 116/1 130) | - | - | - |

At 50 VUs with realistic think times, this represents approximately **1 000-5 000 concurrent real users** worth of load.

---

## Files

| File | Purpose |
|------|---------|
| `e2e/stress/api-throughput.js` | API endpoint throughput + spike test |
| `e2e/stress/session-lifecycle.js` | Session CRUD churn test |
| `e2e/stress/storage-operations.js` | R2 storage upload/download/delete cycle |
| `e2e/stress/rate-limit-validation.js` | Rate limit enforcement validation |
| `.github/workflows/stress-test.yml` | CI workflow orchestration |
| `src/middleware/rate-limit.ts` | HTTP rate-limit middleware; `STRESS_TEST_MODE` bypass at line 54 |
| `src/routes/terminal.ts` | WebSocket auth + rate-limit; `STRESS_TEST_MODE` bypass at line 178 |
| `src/lib/rate-limit-core.ts` | Core rate-limit logic (KV + in-memory fallback) |
| `src/lib/constants.ts` | `WS_RATE_LIMIT_*` constants (lines 47-53) |

---

## Subscription and Timekeeper Considerations

The subscription system introduces endpoints and a Durable Object not yet covered by existing k6 suites.

### Endpoints not yet stress-tested

| Endpoint | Method | Rate Limit | Notes |
|----------|--------|------------|-------|
| `/api/auth/subscribe` | POST | 3/min | Self-service tier selection; Turnstile required |
| `/api/auth/tiers` | GET | None | Returns subscribable tier config |
| `/api/usage` | GET | None | Queries Timekeeper DO with KV fallback |
| `/api/admin/tiers` | GET/PUT | None | Admin tier config; low traffic |
| `/api/auth/onboarding-config` | GET | None | Turnstile site key |

### Timekeeper DO load characteristics

The Timekeeper DO receives pings every 60 seconds from each active container session:

- **Write amplification:** Each ping triggers DO storage writes plus a KV read for quota checks
- **Flush interval:** KV writes batch every 5 minutes via alarm (not per-ping)
- **Session eviction:** `sessionTotals` map caps at 30 entries to prevent unbounded growth
- **Fail-open design:** KV read failures during quota checks are non-fatal

### Container start quota check

`validateSessionAndCheckLimits()` in `src/routes/container/lifecycle.ts` performs a KV read at session start. With `STRESS_TEST_MODE=active`, usage quota enforcement is bypassed (same as rate limits).

---

## Related Documentation

- [Stress Testing](STRESS_TEST.md) - Setup, running, configuration, and test suite descriptions
- [Security Reference — Rate Limiting](security.md#rate-limiting) - Rate limits per endpoint
- [PENTEST.md](PENTEST.md) - Security scan results
