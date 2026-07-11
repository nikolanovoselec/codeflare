# Browser IDE

Full VS Code editor (OpenVSCode Server) running inside each session's container, reached from the codeflare UI through the existing Worker proxy, opening that session's workspace. Session-isolated by design -- the deliberate opposite of the bucket-stable Vault editor.

**Domain owner:** Worker `/api/vscode` route, host proxy (`host/src/server.ts`), `entrypoint.sh` (OpenVSCode supervisor), `Dockerfile` (OpenVSCode install), web-ui `Header`

### Key Concepts

- **Browser IDE** -- OpenVSCode Server (the upstream VS Code web server) running inside the session container, bound to localhost only and reachable from the codeflare UI through the Worker proxy. The auth boundary lives at the Worker, exactly like the Vault editor. One IDE server per session container.
- **Session isolation** -- Each session's IDE is fully isolated from every other session's: a distinct URL base path (`/api/vscode/<sessionId>/`), a distinct browser service-worker scope, a distinct per-container server data directory, and a distinct container. This is the deliberate opposite of the Vault, which is bucket-stable ([REQ-VAULT-021](vault.md)) so one notes store is shared across a user's sessions. The workspace differs per session (different repos, branches, working state), so the IDE must never share state across sessions.
- **Base-path native serving** -- OpenVSCode Server is launched with `--server-base-path=/api/vscode/<sessionId>`, so it builds its own asset URLs and registers its service worker under that path. The Worker and host forward the path unchanged (no prefix strip, no HTML base-href graft) -- unlike SilverBullet, which has no base-path flag and requires the Vault's HTML graft.
- **Lazy start** -- The OpenVSCode supervisor does not launch the server at container boot; it waits for the init-complete flag and a first-request trigger the host writes when the first `/api/vscode` request arrives. Sessions that never open the IDE never pay for it.
- **OpenVSCode supervisor** -- A restart loop in the entrypoint (modelled on the SilverBullet supervisor) that keeps the IDE server alive across crashes and is torn down cleanly via pidfile on shutdown so the port is released for the next session.

### Out of Scope

- A second Worker, origin, Durable Object, binding, or iframe host for the IDE (it reuses the session container and the existing proxy chain).
- A separate connection-token auth layer inside OpenVSCode (`--without-connection-token`; the Worker's Cloudflare Access + tier + session-ownership check plus the localhost bind is the auth boundary, identical to the Vault).
- Cross-session persistence of the IDE's own server state or installed extensions (the server data dir is ephemeral per container; workspace files persist via the existing final-sync, editor state does not).
- A bucket-stable IDE URL or shared service worker across sessions (that is the Vault's model and is explicitly rejected here).
- Desktop VS Code, Remote-SSH, or a VNC editor surface (the browser IDE covers the in-session editing surface).
- A standalone IDE-only container (the IDE lives inside the session container).

### Domain Dependencies

- **Session Lifecycle** -- The IDE runs inside the existing session container and is gated on the container being up (`safeCheckContainerHealth`); its supervisor is launched and torn down alongside the other in-container daemons.
- **Vault** -- Reuses the Vault's Worker proxy plumbing (auth chain, container fetch, health gate, WS bridge shape) but deliberately not its bucket-stable serving layer ([REQ-VAULT-021](vault.md)).
- **Storage** -- Workspace edits persist through the existing bisync to R2 (the final-sync drain); the IDE adds no new sync path.
- **Security** -- The `/api/vscode/*` surface is an authenticated Worker proxy; it inherits the container-auth Bearer injection and the same-origin frame policy.
- **Agents** -- The IDE button is gated to advanced session mode, alongside the Vault button.

---

### REQ-IDE-001: Per-session browser IDE served through the Worker proxy

**Intent:** A user in an advanced session opens a full VS Code editor in the browser. The editor runs inside that session's container and opens `~/workspace`, reached through the existing Worker -> Container -> host proxy chain. No new Worker, origin, Durable Object, binding, or auth system is introduced.

**Applies To:** User

**Acceptance Criteria:**

1. The Worker parses `/api/vscode/<sessionId>/...` at the route boundary before the Hono router (so WebSocket upgrades pass through), and rejects a first segment that fails `SESSION_ID_PATTERN` with a 400. <!-- @impl: src/routes/vscode-validation.ts::validateVscodeRoute --> <!-- @test: src/__tests__/routes/vscode-validation.test.ts (validateVscodeRoute (REQ-IDE-001, REQ-IDE-002)) -->
2. A vscode request passes the shared auth chain -- origin allowlist, then authenticate (with CSRF synthesis), then active-tier -- reusing the vault's session-safe guards; an unauthenticated request returns 401 and a disallowed origin returns 403. <!-- @impl: src/routes/vscode.ts::handleVscodeRequest --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (handleVscodeRequest auth chain + forwarding (REQ-IDE-001, REQ-IDE-002)) -->
3. The Worker forwards the request to the session's container via `container.fetch` with the path unchanged (`/api/vscode/<sessionId>/...`) so OpenVSCode's `--server-base-path` matches; the container fetch wrapper supplies the container-auth Bearer. <!-- @impl: src/routes/vscode.ts::handleVscodeRequest --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (handleVscodeRequest auth chain + forwarding (REQ-IDE-001, REQ-IDE-002)) -->
4. HTTP responses carry the embeddable-frame security headers (`frame: sameorigin`, `csp: false`); WebSocket upgrade responses are passed through untouched (status 101 no-op). <!-- @impl: src/index.ts::AppVariables --> <!-- @test: src/__tests__/security/early-return-security.test.ts (CF-001: security headers on pre-Hono early-return responses) -->
5. The host forwards `/api/vscode/*` to OpenVSCode on `127.0.0.1:13337` without stripping the prefix, so the base-path-native server receives its own path. <!-- @impl: host/src/vscode-proxy.ts::isVscodePath --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeUpstreamPath / REQ-IDE-001 (forward UNCHANGED, no strip)) -->
6. Ownership and liveness are enforced after the auth chain: a session the user does not own returns 404, a stopped session returns 503, and an unhealthy container returns 503. <!-- @impl: src/routes/vscode.ts::handleVscodeRequest --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (handleVscodeRequest auth chain + forwarding (REQ-IDE-001, REQ-IDE-002)) -->
7. The host WebSocket endpoint accepts a 256 KiB binary VS Code protocol message, preserves its bytes, and keeps the connection open instead of closing it with code 1009; the IDE does not reuse the terminal protocol's 64 KiB message cap. <!-- @impl: host/src/vscode-proxy.ts::createVscodeWebSocketServer --> <!-- @test: host/__tests__/openvscode-proxy.test.js (REQ-IDE-001: accepts a 256 KiB binary protocol message intact without a 1009 close) -->

**Constraints:**

- No new Worker, origin, Durable Object, or binding is added; the IDE reuses the session container and the existing proxy chain.
- OpenVSCode is installed at a pinned version with a `sha256sum -c` verification in the Docker build, shadow-pinned like the other vendored binaries.
- The IDE binds `127.0.0.1` only; the Worker is the sole auth boundary.

**Priority:** P2

**Dependencies:** [REQ-VAULT-005](vault.md) (Worker vault proxy plumbing, incl. container health probe)

**Verification:** [Route parsing](../../src/__tests__/routes/vscode-validation.test.ts); [Auth chain + forwarding](../../src/__tests__/routes/vscode-auth-chain.test.ts); [Security headers](../../src/__tests__/security/early-return-security.test.ts); [Host no-strip](../../host/__tests__/openvscode-proxy.test.js)

**Status:** Implemented

---

### REQ-IDE-002: Session-isolated IDE, not bucket-stable

**Intent:** Each session's IDE is fully isolated from every other session's -- distinct URL base path, service-worker scope, server data directory, and container. This is the deliberate opposite of the bucket-stable Vault ([REQ-VAULT-021](vault.md)); opening the IDE in two sessions yields two independent editors, each showing its own container's `~/workspace`.

**Applies To:** User

**Acceptance Criteria:**

1. The vscode route is session-keyed only: the route parser has no bucket-token branch and reads no routing cookie; the sessionId in the URL is the sole container selector. <!-- @impl: src/routes/vscode-validation.ts::validateVscodeRoute --> <!-- @test: src/__tests__/routes/vscode-validation.test.ts (REQ-IDE-002: a valid route result carries a sessionId and never a bucketToken) -->
2. OpenVSCode serves under `--server-base-path=/api/vscode/<sessionId>` so its asset URLs and service-worker scope are session-specific. <!-- @impl: entrypoint.sh::start_openvscode_supervisor --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (handleVscodeRequest auth chain + forwarding (REQ-IDE-001, REQ-IDE-002)) -->
3. Each container runs its own OpenVSCode with an ephemeral per-container `--server-data-dir` under `/tmp`, so no server state is shared across sessions and none is synced to R2. <!-- @impl: entrypoint.sh::start_openvscode_supervisor --> <!-- @test: src/__tests__/routes/vscode-auth-chain.test.ts (handleVscodeRequest auth chain + forwarding (REQ-IDE-001, REQ-IDE-002)) -->
4. The IDE is session-keyed at every layer: the route parser, the container routing, the `--server-base-path`, the ephemeral per-container `--server-data-dir`, and the header open-URL all carry the sessionId, so two sessions get isolated editors with distinct workspace, service-worker scope, and server state. <!-- @impl: src/routes/vscode.ts::handleVscodeRequest --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Layout Component / REQ-AUTH-014 (session expiry handling on 401)) -->

**Constraints:**

- The IDE URL must always carry the sessionId; nothing may rewrite it to a bucket-stable or shared path.
- The server data directory is ephemeral (`/tmp`); IDE extension/state persistence across sessions is out of scope.

**Priority:** P2

**Dependencies:** [REQ-IDE-001](#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy) (the proxy chain), [REQ-VAULT-021](vault.md) (the contrasting bucket-stable model)

**Verification:** [Behavioral test](../../src/__tests__/routes/vscode-auth-chain.test.ts)

**Status:** Implemented

---

### REQ-IDE-003: IDE lifecycle (lazy start, supervised, clean teardown)

**Intent:** The IDE server starts on first use rather than at boot, is supervised for crash-restart, tears down cleanly on shutdown without orphaning its port, and its header button appears only for an advanced-mode running session. Workspace edits persist through the existing final-sync.

**Applies To:** User

**Acceptance Criteria:**

1. The OpenVSCode supervisor launches the server only after the init-complete flag exists AND a first-request trigger file is present; until both are present it waits without launching. <!-- @impl: entrypoint.sh::start_openvscode_supervisor --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (_openvscode_should_launch / REQ-IDE-003 AC1 (lazy-start gate)) -->
2. The host writes the request-trigger file on the first `/api/vscode` request (idempotent) and, until OpenVSCode binds, serves a 503 auto-refreshing HTML warming page (not a raw JSON error) so a plain browser tab lands on the editor once it is up. <!-- @impl: host/src/vscode-proxy.ts::vscodeWarmingResponse --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeWarmingResponse / REQ-IDE-003 AC2 (auto-refreshing warming page, not raw JSON)) -->
3. The supervisor restarts the server on crash via a restart loop, matching the SilverBullet supervisor pattern. <!-- @impl: entrypoint.sh::start_openvscode_supervisor --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (kill_pidfile_subtree / REQ-IDE-003 AC4 (shutdown releases the IDE port)) -->
4. The shutdown handler kills the supervisor subtree via its pidfile so the IDE port is released for the next session. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (kill_pidfile_subtree / REQ-IDE-003 AC4 (shutdown releases the IDE port)) -->
5. The header IDE button renders only when the active session is advanced-mode AND running; clicking it opens the session's `/api/vscode/<sessionId>/`. <!-- @impl: web-ui/src/components/Layout.tsx --> <!-- @impl: web-ui/src/components/Header.tsx --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Browser IDE button gating (REQ-IDE-001 / REQ-IDE-003)) -->
6. Workspace edits persist through the existing final-sync; the IDE adds no new drain path and its server data dir is excluded from sync by living under `/tmp`. <!-- @impl: entrypoint.sh::start_openvscode_supervisor --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (kill_pidfile_subtree / REQ-IDE-003 AC4 (shutdown releases the IDE port)) -->
7. The host rejects a non-advanced-mode session's `/api/vscode` request at the host layer -- a 409 non-refreshing page for HTTP, a refused upgrade for WebSocket -- since the supervisor never arms for such a session; this is independent of the header-button gate. <!-- @impl: host/src/vscode-proxy.ts::vscodeModeAllowed --> <!-- @impl: host/src/vscode-proxy.ts::vscodeDisabledResponse --> <!-- @test: host/__tests__/openvscode-proxy.test.js (vscodeDisabledResponse / REQ-IDE-003 (non-advanced session: clear page, no refresh loop)) -->

**Constraints:**

- The IDE is an advanced-mode feature; it is not offered in default session mode.
- No new final-sync/drain code is added; workspace persistence rides the existing bisync.

**Priority:** P2

**Dependencies:** [REQ-IDE-001](#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy) (the proxy chain), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start) (workspace persistence)

**Verification:** [Behavioral test](../../host/__tests__/entrypoint-openvscode.test.js)

**Status:** Implemented
