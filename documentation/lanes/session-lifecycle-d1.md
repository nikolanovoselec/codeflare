# D1 session lifecycle authority

**Audience:** Operators, Developers

**Owns:** D1-backed session catalog and lifecycle projection.

**Does not own:** Credentials, provider tokens, preferences, entitlement policy, or production cutover execution.

## Contents

- [Lifecycle authority](#lifecycle-authority)
- [Runtime recovery and status](#runtime-recovery-and-status)
- [Cutover boundary](#cutover-boundary)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

## Lifecycle authority

Codeflare stores every complete non-secret session record and shared lifecycle projection in the existing `USAGE_DB` D1 database. KV remains responsible for credentials, provider tokens, preferences, configuration, entitlements, managed-release records, storage caches, Timekeeper data, and unrelated records. <!-- @impl: src/lib/session-repository.ts::D1SessionRepository --> [REQ-SESSION-028](../../sdd/spec/session-lifecycle.md#req-session-028-session-authority-has-no-kv-compatibility-path)

Backend lifecycle states are `stopped`, `starting`, `running`, `unreachable`, and `stopping`. Creating a session inserts `stopped`; Start conditionally advances a lifecycle generation and enters `starting`. The session Durable Object remains the process controller and retains its assigned generation and monotonic observation sequence. Conditional D1 updates reject older generations and delayed same-generation observations. Only confirmed process exit produces `stopped`. <!-- @impl: src/lib/session-repository.ts::D1SessionRepository --> [REQ-SESSION-018](../../sdd/spec/session-lifecycle.md#req-session-018-d1-lifecycle-evidence-is-generation-fenced)

## Runtime recovery and status

A complete host-transport failure opens one D1 incident with an absolute deadline 120 seconds after its first observation. Reconstruction reuses the incident, deadline, generation, SDK process identity, and existing PTY.

Deadline expiry is earliest termination eligibility. Termination is generation-bound and duplicate-safe; signal acceptance remains `stopping` until exit is confirmed. D1 failure is status uncertainty, not transport or stopped evidence. <!-- @impl: src/lib/session-runtime-policy.ts::openUnreachableIncident --> <!-- @impl: src/lib/session-runtime-policy.ts::claimExpiredTermination --> [REQ-SESSION-021](../../sdd/spec/session-lifecycle.md#req-session-021-complete-transport-failure-opens-one-unreachable-incident)

Visible batch status is one owner-indexed primary-consistent D1 query with `no-store`. Normal metrics projection is one authenticated combined host observation followed by one conditional D1 update.

Optional usage, storage, entitlement, managed-release, preseed, and migration refreshes are not part of frequent status projection. <!-- @impl: src/routes/session/lifecycle.ts::app --> <!-- @impl: src/container/container-metrics.ts::collectMetrics --> [REQ-SESSION-020](../../sdd/spec/session-lifecycle.md#req-session-020-runtime-observation-is-bounded-and-projected-once)

Terminal ACTIVE/IDLE is local presentation: a running backend with this device's connected terminal socket is ACTIVE; without it, IDLE. VS Code lifecycle color remains green for a ready running workspace during temporary connectivity recovery, with a separate accessible notice.

D1 outages retain the last ordered state and mounted terminal/editor workspace. <!-- @impl: web-ui/src/lib/session-presentation.ts::terminalPresentation --> <!-- @impl: web-ui/src/lib/session-presentation.ts::vscodePresentation --> <!-- @impl: web-ui/src/lib/session-presentation.ts::applyStatusFailure --> [REQ-SESSION-023](../../sdd/spec/session-lifecycle.md#req-session-023-client-lifecycle-presentation-retains-workspace-through-uncertainty)

## Cutover boundary

Cutover is clean-slate and one-time. After migration, an operator confirms quiescence, admission remains closed by the pending marker, exact `session:${bucketName}:` KV prefixes are purged, and D1 is verified empty before the marker opens admission.

There is no import, backfill, dual write, shadow read, reverse migration, or automatic draining. Post-cutover rollback must remain D1-compatible. <!-- @impl: src/lib/session-cutover.ts::runSessionCutover --> [REQ-SESSION-028](../../sdd/spec/session-lifecycle.md#req-session-028-session-authority-has-no-kv-compatibility-path)

## Schema and mutation design

The concrete schema and conditional mutation design are owned by the additive migration and repository implementation. The design below records the D1 authority boundary without making SQL shape an acceptance criterion. <!-- @impl: migrations/usage/0002_runtime_sessions.sql::CREATE TABLE runtime_sessions --> <!-- @impl: src/lib/session-repository.ts::D1SessionRepository --> [REQ-SESSION-031](../../sdd/spec/session-lifecycle.md#req-session-031-d1-session-schema-stores-complete-ordered-authority)

`runtime_sessions` columns:

| Group | Columns |
| --- | --- |
| Identity | `owner_key TEXT`, `session_id TEXT`, composite primary key |
| Complete record | `name TEXT`, `created_at TEXT`, `last_accessed_at TEXT`, nullable `agent_type TEXT`, `workspace TEXT`, `terminal_mode TEXT`, nullable `tab_config_json TEXT`, nullable `clone_json TEXT` |
| Ordering | `lifecycle_state TEXT`, `lifecycle_generation INTEGER`, `response_revision INTEGER`, `observation_sequence INTEGER` |
| Lifecycle | nullable `last_started_at TEXT`, `last_active_at TEXT`, `transitioned_at TEXT`, nullable `lifecycle_reason TEXT` |
| Readiness | `editor_ready INTEGER`, `editor_ready_error INTEGER`, nullable `readiness_observed_at TEXT` |
| Latest projection | nullable `cpu TEXT`, `memory TEXT`, `disk TEXT`, `sync_status TEXT`, `metrics_observed_at TEXT`, `last_input_at TEXT` |
| Incident | nullable `unreachable_incident_id TEXT`, `unreachable_first_observed_at TEXT`, `unreachable_deadline_ms INTEGER` |
| Termination | nullable `termination_intent_id TEXT`, `termination_generation INTEGER`, `termination_claimed_at TEXT`, `termination_signal_accepted_at TEXT` |

The schema checks the lifecycle vocabulary, non-negative counters, boolean integers, paired incident fields and generation-bound termination fields. `response_revision` and `lifecycle_generation` start at zero; `observation_sequence` starts at `-1` so sequence zero may be accepted. The owner query orders by `last_accessed_at DESC, session_id ASC`; one index on that tuple is sufficient.

`session_cutover` is a singleton row (`id = 1`) with `state`, `updated_at`, and nullable `completed_at`. Migration inserts `pending`; the reviewed one-time cleanup changes it to `complete` only after exact-prefix purge and empty-dashboard verification.

#### Normative mutation predicates

- Create is an ordinary `INSERT` in `stopped`, generation/revision zero, and fails while cutover is not complete.
- Start is one conditional `UPDATE`: cutover complete, current state `stopped`, and no termination intent; it increments generation and revision, resets observation sequence to `-1`, and writes `starting`.
- Runtime projection is one conditional `UPDATE` by owner/session/generation where incoming sequence is greater; accepted mutation stores the sequence and increments revision.
- Incident open uses deterministic incident identity and only the matching generation; retry of an already committed open reconciles as idempotent, while a conflicting incident fails closed.
- Recovery clears only the matching generation and incident.
- Termination claim changes the matching `unreachable` generation/incident to `stopping` and records intent atomically.
- Confirmed exit changes only the matching terminating generation to `stopped` and clears incident/intent fields.
- Delete uses `DELETE` only after confirmed graceful destruction. Delayed runtime writers use `UPDATE`, never `UPSERT` or `INSERT OR REPLACE`.
- `meta.changes === 0` triggers a bounded primary read only on exceptional ownership/idempotency reconciliation paths; the normal projection path performs no readback.

## Requirement and Source Map

- [D1 authority and cutover](../../sdd/spec/session-lifecycle.md#req-session-031-d1-session-schema-stores-complete-ordered-authority): `migrations/usage/0002_runtime_sessions.sql`, `src/lib/session-repository.ts`, and `src/lib/session-cutover.ts`.
- [Runtime recovery](../../sdd/spec/session-lifecycle.md#req-session-021-complete-transport-failure-opens-one-unreachable-incident): `src/lib/session-runtime-policy.ts` and `src/container/container-metrics.ts`.
- [Status and presentation](../../sdd/spec/session-lifecycle.md#req-session-010-session-lifecycle-is-observable-from-one-d1-projection): `src/routes/session/lifecycle.ts` and `web-ui/src/lib/session-presentation.ts`.

## Related Documentation

- [Container](container.md)
- [API Reference](api-reference.md)
- [Storage & Sync](storage-and-sync.md)
