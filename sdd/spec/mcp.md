# Model Context Protocol Domain Specification

MCP portal registration, owner authorization, client configuration and discovery, credential-isolated transport, and lossless client migration.

## Scope and ownership

This domain owns the shared MCP connection lifecycle and its portal-specific authorization boundaries. [Agents](agents.md) retains agent selection, preseed delivery and capability-specific policies such as consult-llm consent. [Browser Run](browser-run.md) retains browser behavior and browser-specific MCP surfaces. [Models & Routing](models-and-routing.md) retains inference routing; [Authentication](authentication.md) and [Security](security.md) retain general identity, credential and egress rules.

Operational guidance remains in [Configuration](../../documentation/lanes/configuration.md), [API Reference](../../documentation/lanes/api-reference.md) and [Preseed](../../documentation/lanes/preseed.md). Existing REQ-AGENT identifiers are retained.

---

<a id="req-agent-226-hosted-owner-initiated-pi-mcp-oauth"></a>
### REQ-AGENT-226: Worker-owned MCP portal authorization

**Intent:** Owners authorize portal grants without delivering credentials to Pi.

**Applies To:** User

**Acceptance Criteria:**

1. Owner browser OAuth starts PKCE with expiring state bound to owner, instance, configured portal/resource, issuer and fixed HTTPS callback. <!-- @impl: src/lib/mcp-portal-token.ts::beginMcpPortalConnect --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC1: standard OAuth PKCE exchange stores only encrypted owner/portal grants) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC1: OAuth rejects issuer/resource mismatch, unsafe URLs and redirects before credential exchange) -->
2. Invalid, expired, cancelled, wrong-owner, replayed or mismatched returns cannot save grants. <!-- @impl: src/lib/mcp-portal-token.ts::finishMcpPortalConnect --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC2: callback rejects owner, instance, state, issuer, configuration and replay mismatches) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC2: disconnect %s cancels the older flow before token issuance) -->
3. Completion and status artifacts expose no authorization code, verifier or token. <!-- @impl: src/routes/mcp-oauth.ts::createMcpOAuthRoutes --> <!-- @test: src/__tests__/routes/mcp-oauth.test.ts (REQ-AGENT-226 AC3: %s uses browser OAuth and clean owner-bound completion without compute startup) --> <!-- @test: src/__tests__/security/security-headers.test.ts (REQ-AGENT-226 AC3: full app preserves no-referrer and routes MCP returns before auth fallback) -->
4. Dedicated owner-and-portal KV records require AES-GCM encryption with key-bound associated data; unavailable encryption and moved/plaintext records are unusable independently of GitHub/Cloudflare deploy-key records. <!-- @impl: src/lib/mcp-portal-token.ts::getMcpPortalGrant --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC4: encryption is mandatory and ciphertext cannot move between owner records) -->
5. The Worker reuses valid grants and silently refreshes expiring grants without Pi-owned credential entry. <!-- @impl: src/lib/mcp-portal-token.ts::getValidMcpPortalToken --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC5: current grant refresh rotates without interactive Pi authorization) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC5: refresh token omission still permits the next silent renewal) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC5: successful refresh reuses an observed same-generation renewal before publication) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC5: stale encrypted readback after refresh publication never returns the old access token) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC5: racing rotating refreshes reuse only the current generation with lifetime=%s (disconnect=%s)) -->
6. Previously authorized, still-matching grants recover through the authenticated browser’s SSO when Worker refresh needs renewed authorization, without changing Pi credentials or running configuration. <!-- @impl: src/lib/mcp-portal-token.ts::getValidMcpPortalToken --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC6: refresh failure and observed disconnect during refresh fail closed) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC6: observed %s after refresh publication rejects the refresh result) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC6: observed %s before refresh publication rejects the refresh result) --> <!-- @test: src/__tests__/mcp-portal-interceptor.test.ts (REQ-AGENT-226 AC6: diagnostic wire contract for %s keeps reconnect status and metadata only) --> <!-- @impl: src/routes/mcp-oauth.ts::createMcpPortalApiRoutes --> <!-- @impl: web-ui/src/lib/mcp-portal-recovery.ts::createMcpPortalRecovery --> <!-- @impl: web-ui/src/App.tsx::AppContent --> <!-- @test: src/__tests__/routes/mcp-oauth.test.ts (REQ-AGENT-226 AC6 / REQ-AGENT-228 AC4: %s returns only a standard PKCE authorization URL when explicitly permitted) --> <!-- @test: src/__tests__/routes/mcp-oauth.test.ts (REQ-AGENT-226 AC6: %s grants are ineligible without OAuth) --> <!-- @test: web-ui/src/__tests__/components/App.test.tsx (silently renews the owner grant with Settings closed and keeps the active session) --> <!-- @test: web-ui/src/__tests__/components/App.test.tsx (discards an old recovery response while resume owner authentication is pending (%s)) --> <!-- @test: web-ui/src/__tests__/components/App.test.tsx (resumes recovery on authenticated BFCache Back without remounting or repeating authorization) --> <!-- @test: src/__tests__/routes/mcp-oauth.test.ts (REQ-AGENT-226 AC6: browser recovery resumes the unchanged Pi placeholder request without disconnect) --> <!-- @test: web-ui/src/__tests__/lib/mcp-portal-recovery.test.ts (restores the session synchronously on cancelled callback and prevents another authorization across recreations) -->
7. Disconnect clears only the selected owner/portal connection while preserving unrelated credentials, including when provider revocation fails. <!-- @impl: src/lib/mcp-portal-token.ts::disconnectMcpPortal --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC7: disconnect affects only selected owner/portal and never restores failed revocation) --> <!-- @test: src/__tests__/routes/mcp-oauth.test.ts (REQ-AGENT-226 AC7: same-origin disconnect clears only the authenticated owner portal) -->

**Constraints:**

- Secrets stay Worker-only.
- No shared/admin grants, Access-JWT substitution, cookie copying or new issuer/channel.
- TLS remains verified.
- Automatic recovery never creates initial/new-destination grants or undoes Disconnect.
- Transient failures do not initiate OAuth; cancelled returns do not loop.
- Provider login, consent and MFA remain authoritative.
- Canonical session restoration uses existing ownership checks; MCP writes are never replayed.
- KV publication is non-atomic; the in-flight Disconnect race is explicitly deferred in [#1386](https://github.com/nikolanovoselec/codeflare/issues/1386).

**Priority:** P1

**Dependencies:** None.

**Verification:** Synthetic OAuth/KV/route tests and managed CI; hosted owner SSO, downstream OAuth, refresh/revocation, CIMD-only metadata reachability and platform-log confidentiality require separate evidence.

**Status:** Implemented

---

<a id="req-agent-227-instance-administration-of-pi-mcp-portals"></a>
<a id="req-agent-227-instance-administration-and-pi-use-of-mcp-portals"></a>
### REQ-AGENT-227: Instance administration of MCP portals

**Intent:** Administrators register portal destinations without provisioning or changing running sessions.

**Applies To:** Admin

**Acceptance Criteria:**

1. Administration Environment lets authorized administrators read, add, edit, remove and save portal registrations; unauthorized users cannot read or change instance configuration. <!-- @impl: web-ui/src/components/admin/McpPortalSettings.tsx::McpPortalSettings --> <!-- @test: web-ui/src/__tests__/components/admin/McpPortalSettings.test.tsx (REQ-AGENT-227 AC1: administrators manage multiple named portal URLs) --> <!-- @impl: web-ui/src/components/admin/environment-areas.ts::environmentAreas --> <!-- @test: web-ui/src/__tests__/components/admin/McpEnvironment.test.tsx (REQ-AGENT-227 AC1: subsection Save persists and updates Overview and Environment status through removal) --> <!-- @test: web-ui/src/__tests__/components/admin/McpEnvironment.test.tsx (REQ-AGENT-227 AC1: normal Environment item and subsection are available in %s) --> <!-- @test: web-ui/src/__tests__/components/admin/McpEnvironment.test.tsx (REQ-AGENT-227 AC1: Overview counts all saved portals using the shared Environment item) --> <!-- @test: src/__tests__/routes/admin-configuration.test.ts (REQ-AGENT-227 AC1: Environment projection reads empty and saved portals from the existing owner in %s) --> <!-- @test: src/__tests__/routes/admin-mcp-portals.test.ts (REQ-AGENT-227 AC1: denies %s read and write) -->
2. Registration accepts unique names and public standard-port HTTPS destinations without credentials or fragments, optionally carrying only `?codemode=search_and_execute`, and returns saved values. <!-- @impl: src/lib/mcp-portals.ts::validateMcpPortals --> <!-- @test: src/__tests__/routes/admin-mcp-portals.test.ts (REQ-AGENT-227 AC2: authorized validated configuration persists without secrets or external actions) --> <!-- @test: src/__tests__/routes/admin-mcp-portals.test.ts (REQ-AGENT-227 AC2: rejects invalid or credential-bearing configuration %#) -->
3. Saved registration persists without provisioning resources, authenticating users, warming compute or restarting sessions. <!-- @impl: src/routes/admin/configuration.ts::app --> <!-- @test: src/__tests__/routes/admin-mcp-portals.test.ts (REQ-AGENT-227 AC3: saving does not mutate running sessions or grants) -->
4. Removed or changed destinations cannot use mismatched stored grants. <!-- @impl: src/lib/mcp-portal-token.ts::getMcpPortalGrant --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-227 AC4: %s destinations invalidate a previously saved grant) -->

**Constraints:** Names identify connections, not tool relevance. Registration contains no secret/API-key field. Preserve existing administrator authorization and unrelated settings.

**Priority:** P1

**Dependencies:** None.

**Verification:** Administration API/UI tests and managed CI; saving is not authentication, deployment or hosted acceptance.

**Status:** Implemented

---

### REQ-AGENT-228: Owner Pi MCP configuration and discovery

**Intent:** Owners connect and discover approved portal tools across deployment and supported Pi modes.

**Applies To:** User

**Acceptance Criteria:**

1. Both default/basic and advanced startup expose configured Code Mode wrappers through native adapter registrations with deferred tool discovery, lazy ten-minute idle disconnect and only a public placeholder, with no second client or Pi-owned portal OAuth provider. <!-- @impl: scripts/merge-pi-mcp-portals.mjs::mergePiMcpPortals --> <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: host/__tests__/pi-mcp-portals.test.js (REQ-AGENT-228 AC1: startup produces multiple idle-disconnecting non-secret placeholder portal connections) --> <!-- @test: host/__tests__/pi-mcp-stock.test.js (REQ-AGENT-228: adapter placeholder proxy discovers and executes originating portal wrappers with explicit partial coverage) -->
2. Idempotent reconciliation changes only proven managed registrations and preserves unrelated MCP configuration, stdio/local OAuth grants and native lifecycle behavior. <!-- @impl: scripts/merge-pi-mcp-portals.mjs::mergePiMcpPortals --> <!-- @test: host/__tests__/pi-mcp-portals.test.js (REQ-AGENT-228 AC2: reconciliation preserves unrelated servers and grants) --> <!-- @test: host/__tests__/pi-mcp-stock.test.js (REQ-AGENT-228: unmanaged local OAuth retains real PKCE grant persistence, refresh and shutdown lifecycle) -->
3. Registration changes apply on subsequent startup without rewriting running Pi configuration. <!-- @impl: src/container/container-config.ts::refreshMcpPortalConfiguration --> <!-- @test: src/__tests__/container/container-env.test.ts (REQ-AGENT-228 AC3: startup rereads changed instance portal configuration and clears removals) -->
4. Settings offers owner Connect/status/Disconnect for multiple portal IDs across deployment, subscription and Pi modes in one shared surface, with concise guidance without troubleshooting disclosures and accessible loading/error/empty states. <!-- @impl: web-ui/src/components/settings/McpPortalsSection.tsx::McpPortalsSection --> <!-- @test: web-ui/src/__tests__/components/McpPortalsSection.test.tsx (REQ-AGENT-228 AC4: multiple portal identities connect through existing browser navigation and disconnect independently) --> <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (REQ-AGENT-228 AC4: MCP Settings is available in both Pi modes and all subscription modes (enterprise=%s)) --> <!-- @test: web-ui/src/__tests__/components/McpPortalsSection.test.tsx (REQ-AGENT-228 AC4: concise permission guidance keeps connection actions available without a troubleshooting disclosure) -->
5. An auto-discoverable native router progressively loads connection, discovery and execution topics in both Pi modes. <!-- @impl: preseed/agents/pi/skills/mcp-portals/SKILL.md::MCP portals --> <!-- @manual: In each Pi mode discover the router and follow its links to load only the required topic; verify the managed artifact identity separately. -->
6. Portal guidance requires approved-set bootstrap before selection, wrapper/inner-method distinction, live schemas, originating-portal methods, explicit partial coverage and readback before considering retries of uncertain writes. <!-- @impl: preseed/agents/pi/skills/mcp-portal-discovery/SKILL.md::Discover portal tools --> <!-- @impl: preseed/agents/pi/skills/mcp-portal-execution/SKILL.md::Execute portal workflows --> <!-- @manual: Bootstrap approved synthetic portals, activate exact search/execute wrappers, inspect live schemas and originating-portal results, report missing coverage, and read back an uncertain operation before considering retry. -->
7. Managed portal connections disconnect after ten idle minutes without stopping active calls, retain cached discovery, and reconnect on the next authorized call. <!-- @impl: scripts/merge-pi-mcp-portals.mjs::mergePiMcpPortals --> <!-- @test: host/__tests__/pi-mcp-stock.test.js (REQ-AGENT-228: native ten-minute idle cleanup disconnects and the next proxy call reconnects) --> <!-- @test: host/__tests__/pi-mcp-stock.test.js (REQ-AGENT-228: idle cleanup protects an active portal call and closes only after completion) -->

**Constraints:** Availability never bypasses owner, tenant or Operator authorization. Builtin MCP remains disabled; pi-mcp-adapter is the sole MCP owner. Preserve unrelated user/project MCP and OAuth state. Deliver skills through existing seed/Curation.

**Priority:** P1

**Dependencies:** [REQ-AGENT-226](#req-agent-226-worker-owned-mcp-portal-authorization), [REQ-AGENT-227](#req-agent-227-instance-administration-of-mcp-portals)

**Verification:** Startup/native-client and Settings tests plus native progressive-use inspection. CI, signed delivery, deliberate local reload and hosted acceptance are separate gates.

**Status:** Implemented

---

### REQ-AGENT-229: Worker-mediated MCP portal transport

**Intent:** Owners use portal tools without exposing their real credentials to Pi.

**Applies To:** User

**Acceptance Criteria:**

1. Only a trusted parent-bound owner grant replaces agent credentials at the exact currently approved HTTPS portal destination. <!-- @impl: src/mcp-portal-interceptor.ts::forwardMcpPortal --> <!-- @test: src/__tests__/container/mcp-portal-interception.test.ts (REQ-AGENT-229 AC1: registered portal boundary is available in all deployment modes and refuses missing owner grants (enterprise=%s)) --> <!-- @test: src/__tests__/mcp-portal-interceptor.test.ts (REQ-AGENT-229 AC4: stamps the trusted owner grant and preserves functional response streams and downstream URL context) --> <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-AGENT-229 AC1: catch-all stamps only the parent owner grant and preserves MCP wire outcomes) --> <!-- @test: src/__tests__/container/mcp-portal-interception.test.ts (REQ-AGENT-229 AC1: strict catch-all keeps parent portal ownership across R2 refresh (refresh=%s)) -->
2. Wrong owner/resource/instance/configuration bindings, Operators and redirected destinations fail closed without credential forwarding. <!-- @impl: src/mcp-portal-interceptor.ts::forwardMcpPortal --> <!-- @test: src/__tests__/mcp-portal-interceptor.test.ts (REQ-AGENT-229 AC2: rejects wrong resource, owner, Operator, instance, configuration, missing grant and strict-egress absence before sending) --> <!-- @test: src/__tests__/container/mcp-portal-interception.test.ts (REQ-AGENT-229 AC2: parent-bound Operators cannot inherit ordinary owner portal grants) --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-AGENT-229 AC2: catch-all denies %s without a protected send) --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-AGENT-229 AC2: unrelated URL and forged Host retain ordinary auth without owner lookup) --> <!-- @test: src/__tests__/container/mcp-portal-interception.test.ts (REQ-AGENT-229 AC2: strict refresh selects current configuration without adopting an old grant) --> <!-- @test: src/__tests__/container/mcp-portal-interception.test.ts (REQ-AGENT-229 AC2: parent Operator profile cannot inherit a catch-all owner grant (refresh=%s)) -->
3. Unavailable mandatory interception or colliding outbound transports prevents startup. <!-- @impl: src/container/container-interception.ts::wireContainerInterception --> <!-- @test: src/__tests__/container/mcp-portal-interception.test.ts (REQ-AGENT-229 AC3: portal host collisions and unavailable interception fail startup rather than bypassing credential isolation) -->
4. Upstream streams, cancellation, statuses and portal-issued downstream authorization context remain intact. <!-- @impl: src/mcp-portal-interceptor.ts::forwardMcpPortal --> <!-- @test: src/__tests__/mcp-portal-interceptor.test.ts (REQ-AGENT-229 AC4: stamps the trusted owner grant and preserves functional response streams and downstream URL context) --> <!-- @test: src/__tests__/mcp-portal-interceptor.test.ts (REQ-AGENT-229 AC4: response cancellation reaches the original upstream stream) --> <!-- @test: src/__tests__/mcp-portal-interceptor.test.ts (REQ-AGENT-229 AC4: rejects redirects without credential leakage and preserves actual upstream failure status) --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-AGENT-229 AC4: catch-all streams downstream authorization context and preserves cancellation) -->
5. Credential maintenance never replays MCP requests after uncertain write outcomes. <!-- @impl: src/mcp-portal-interceptor.ts::forwardMcpPortal --> <!-- @test: src/__tests__/mcp-portal-interceptor.test.ts (REQ-AGENT-229 AC5: uncertain MCP writes are never replayed after response loss) --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-AGENT-229 AC5: catch-all never replays uncertain MCP writes or follows redirects) -->

**Constraints:** TLS verification and strict egress remain enforced. No shared service/admin identity or agent-selected owner. GitHub upstream requires per-user authentication. Exposed write schemas are not authorization for arbitrary mutations.

**Priority:** P1

**Dependencies:** [REQ-AGENT-226](#req-agent-226-worker-owned-mcp-portal-authorization)

**Verification:** Synthetic boundary, startup, stream and no-replay tests; hosted upstream/downstream authorization and revocation require separate evidence.

**Status:** Implemented

---

### REQ-AGENT-217: Lossless Pi MCP adapter migration

**Intent:** Selected MCP clients prepare their own configuration without losing unrelated servers, conflicting credentials or displaced originals. Managed startup restores the native adapter and its idle-disconnect behavior.

**Applies To:** User

**Acceptance Criteria:**

1. Managed load prepares the positively selected client only; dual or unknown selections preserve both MCP files and report ambiguity without exposing contents. <!-- @impl: preseed/agents/pi/extensions/00-mcp-adapter-config.ts::registerMcpAdapterMigration --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: selected stock hands off even when the adapter is merely installed) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: configured MCP selection protects native files (${name})) -->  <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-BROWSER-009: native keep-alive browser lifecycle and custom idle minutes survive timeout preparation) --> <!-- @impl: preseed/agents/pi/extensions/00-mcp-adapter-config.ts::migratePiMcpAdapterConfig --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (legacy adapter migration preserves exact bytes, credentials, custom servers and 600000 browser retention) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: managed stock handoff survives native portal reconciliation and repeated startup) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC1/AC2/AC7: Review exclusions preserve selected client behavior (${form}, ${owner})) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC1: Review exception does not authorize other exclusions (${exclusion})) --> <!-- @impl: entrypoint.sh::configure_pi_packages_and_review_inventory --> <!-- @test: host/__tests__/pi-settings-packages.test.js (REQ-AGENT-217: startup retires duplicated managed stock runtime aliases (${form})) -->
2. Native handoff translates supported legacy fields and imports nonconflicting settings/servers into `mcp-adapter.json`; native definitions win for proven generated duplicates. <!-- @impl: preseed/agents/pi/extensions/00-mcp-adapter-config.ts::preparePiMcpAdapterConfig --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: managed stock handoff survives native portal reconciliation and repeated startup) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC2/AC4/AC7: dual restored managed defaults retain native authority and retire exact obsolete source (${shape})) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC2/AC6/AC7: actual dual-file startup refreshes managed constructors and portals (enterprise=${enterprise})) -->
3. Matching, conflicting, unreadable, symlink and directory passive archives never overwrite existing data or block recovery. <!-- @impl: preseed/agents/pi/extensions/00-mcp-adapter-config.ts::preserve --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (existing migration backup is never overwritten or used to discard legacy credentials) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (occupied ${kind} archive is preserved without following it or preventing recovery) -->  <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (unreadable passive archive cannot block custom legacy recovery) -->
4. Preparation preserves original configuration when active inputs are malformed, unsafe or contain conflicting custom definitions. <!-- @impl: preseed/agents/pi/extensions/00-mcp-adapter-config.ts::migratePiMcpAdapterConfig --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (malformed existing destination is archived and recovers exact valid legacy configuration) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (nonregular destination blocks migration and retains legacy) --> <!-- @impl: preseed/agents/pi/extensions/00-mcp-adapter-config.ts::preparePiMcpAdapterConfig --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: native handoff rejects ${path} ${kind} preserving all originals) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: symlink ancestor blocks native preparation) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: native ${collision} collision chooses no winner) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC4: dual-file custom collision preserves both originals (${side}, ${change})) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC4: native-shaped obsolete entries do not broaden stock schema (${duplicate})) -->
5. Active root `.pi/agent/mcp-adapter.json`, preserved originals, recovery copies and nested files remain baseline/bisync eligible. <!-- @impl: entrypoint.sh::configure_pi_mcp_adapter --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: active native configuration and recovery objects remain baseline-sync eligible) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: failed native preparation blocks Pi shell merge without excluding restored files from baseline) -->
6. Startup reconstructs recognizable generated consult and browser entries from current runtime inputs while preserving customized configuration. <!-- @impl: entrypoint.sh::configure_pi_mcp_adapter --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC6: actual startup regenerates proven managed consult and browser from fresh inputs (${origin})) --> <!-- @test: host/__tests__/entrypoint-browser-run-mcp.test.js (REQ-BROWSER-006: startup regenerates the image-owned browser endpoint and headers while preserving custom settings) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC2/AC6/AC7: actual dual-file startup refreshes managed constructors and portals (enterprise=${enterprise})) -->
7. Transformed originals are recoverable before replacement; completed native handoff archives the unchanged stock source before retiring its active filename, and failed writes preserve source data. <!-- @impl: preseed/agents/pi/extensions/00-mcp-adapter-config.ts::preserve --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: one-time handoff retains active stock on ${failure}) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: native replacement failure leaves the active original and recovery bytes intact) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC2/AC4/AC7: dual restored managed defaults retain native authority and retire exact obsolete source (${shape})) -->

**Constraints:**

- No bucket deletion/sync redesign; only successful native handoff excludes obsolete root `.pi/agent/mcp.json` from subsequent baseline/bisync; initial restore/failed preparation remain eligible. <!-- @impl: entrypoint.sh::configure_pi_mcp_adapter --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: active native configuration and recovery objects remain baseline-sync eligible) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: failed native preparation blocks Pi shell merge without excluding restored files from baseline) -->
- Packages do not prove selection.
- Exact managed exclusions `mcp-portal-oauth.ts`, `review-enforcement.ts`, `operator-review-remote.ts` are selection-neutral; other unsupported filters fail closed before preparation.
- Registration chooses no settings winner and disables neither client; managed startup selects the native adapter, explicit stock-only retains guarded handoff.
- Preserve transformed custom originals before replacement.
- Positively selected stock-only managed load decodes selected legacy stdio `!!` by one `!`, never valid-destination literal environment. <!-- @test: preseed/agents/pi/test/consult-proxy.test.mjs (REQ-AGENT-217: actual stdio server receives the selected schema's literal env (legacy=${legacy}, regenerate=${regenerate})) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-069: generated native provider environment escapes a literal leading exclamation mark) -->
- Reject selected legacy commands/interpolation before evaluation/writes, preserving originals/content-free diagnostics; unselected expressions cannot block valid destinations. <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: rejected legacy env produces a content-free managed-load diagnostic) -->
- Native conversion escapes literal leading bangs, never evaluating stock values as secret commands; unsupported expressions fail closed.
- Native lifecycle settings remain native; progress resets request timeout, independently of idle disconnect/provider retention.
- Managed timeouts follow [REQ-BROWSER-009](browser-run.md#req-browser-009-mcp-and-chrome-sdk-timeout-profile); constructors/Claude follow [REQ-AGENT-069](agents.md#req-agent-069-pi-consult-llm-mcp-lazy-wiring).

**Priority:** P1

**Dependencies:** [REQ-AGENT-069](agents.md#req-agent-069-pi-consult-llm-mcp-lazy-wiring)

**Verification:** Guarded native/stock configuration and client-selection tests: [pi-mcp-adapter-config.test.js](../../host/__tests__/pi-mcp-adapter-config.test.js). Exact-head CI, signed delivery and deployed handoff acceptance remain distinct.

**Status:** Implemented

---
