# D1 session lifecycle authority

Codeflare stores every complete non-secret session record and shared lifecycle projection in the existing `USAGE_DB` D1 database. KV remains responsible for credentials, provider tokens, preferences, configuration, entitlements, managed-release records, storage caches, Timekeeper data, and unrelated records.

Backend lifecycle states are `stopped`, `starting`, `running`, `unreachable`, and `stopping`. Creating a session inserts `stopped`; Start conditionally advances a lifecycle generation and enters `starting`. The session Durable Object remains the process controller and retains its assigned generation and monotonic observation sequence. Conditional D1 updates reject older generations and delayed same-generation observations. Only confirmed process exit produces `stopped`.

A complete host-transport failure opens one D1 incident with an absolute deadline 120 seconds after its first observation. Reconstruction reuses the incident, deadline, generation, SDK process identity, and existing PTY. Deadline expiry is earliest termination eligibility. Termination is generation-bound and duplicate-safe; signal acceptance remains `stopping` until exit is confirmed. D1 failure is status uncertainty, not transport or stopped evidence.

Visible batch status is one owner-indexed primary-consistent D1 query with `no-store`. Normal metrics projection is one authenticated combined host observation followed by one conditional D1 update. Optional usage, storage, entitlement, managed-release, preseed, and migration refreshes are not part of frequent status projection.

Terminal ACTIVE/IDLE is local presentation: a running backend with this device's connected terminal socket is ACTIVE; without it, IDLE. VS Code lifecycle color remains green for a ready running workspace during temporary connectivity recovery, with a separate accessible notice. D1 outages retain the last ordered state and mounted terminal/editor workspace.

Cutover is clean-slate and one-time. After migration, an operator confirms quiescence, admission remains closed by the pending marker, exact `session:${bucketName}:` KV prefixes are purged, D1 is verified empty, and the marker opens admission. There is no import, backfill, dual write, shadow read, reverse migration, or automatic draining. Post-cutover rollback must remain D1-compatible.
