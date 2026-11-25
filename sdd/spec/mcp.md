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

1. Owner browser OAuth starts PKCE with expiring state bound to owner, instance, configured portal/resource, issuer and fixed HTTPS callback. <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC2: expired pending state cannot create a grant) --> <!-- @impl: src/lib/mcp-portal-token.ts::beginMcpPortalConnect --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC1: standard OAuth PKCE exchange stores only encrypted owner/portal grants) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC1: OAuth rejects issuer/resource mismatch, unsafe URLs and redirects before credential exchange) -->
2. Invalid, expired, cancelled, wrong-owner, replayed or mismatched returns cannot save grants. Pending consumption and publication use atomic owner-epoch and portal-revision checks; prior offboarding or Disconnect cannot be overwritten. <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC2: expired pending state cannot create a grant) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC2: cancellation consumes state without creating a grant) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC2/7: concurrent publication and Disconnect cannot leave a resurrected grant) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC2: pending consumption is one-use and checks expiry and the portal fence transactionally) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AUTH-026 AC2 / REQ-AGENT-226 AC2: stale completion after reconstruction cannot reopen a newer offboarding operation) --> <!-- @impl: src/lib/mcp-portal-state.ts::consumePending --> <!-- @impl: src/lib/mcp-portal-state.ts::replace --> <!-- @impl: src/lib/mcp-portal-token.ts::finishMcpPortalConnect --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC2: callback rejects owner, instance, state, issuer, configuration and replay mismatches) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC2: disconnect %s cancels the older flow before token issuance) -->
3. Grant lookup decrypts the single fetched ciphertext snapshot and cannot substitute data from a later read. <!-- @impl: src/lib/mcp-portal-token.ts::readGrant --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC4: grant lookup uses one ciphertext snapshot, never a later plaintext substitute) -->
4. Owner grants and pending records require AES-GCM with owner, epoch, kind and identity-bound associated data. Unavailable encryption and moved, plaintext, malformed or wrong-key payloads remain unusable without credential migration, independently of GitHub/Cloudflare deploy-key records. <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC1/4: pending verifier and published provider credentials are encrypted in native owner storage) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC4: ciphertext cannot move to a different portal or pending record kind) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC4: owner and epoch context changes cannot turn moved ciphertext into a token) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC4: plaintext never becomes a usable authoritative grant and storage contains no OAuth secrets) --> <!-- @impl: src/lib/mcp-portal-token.ts::getMcpPortalGrant --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC4: encryption is mandatory and ciphertext cannot move between owner records) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC4: %s grants are unusable without migration writes) --> <!-- @test: src/__tests__/routes/mcp-oauth.test.ts (REQ-AGENT-226 AC4: plaintext saved grants remain disconnected in the owner status API) -->
5. The Worker reuses usable grants without requiring refresh tokens, and silently renews expiring grants when a refresh token exists, without Pi-owned credential entry. <!-- @test: src/__tests__/mcp-portal-interceptor.test.ts (REQ-AGENT-226 AC5 / REQ-AGENT-229 AC4: $format $mode forwards the exact owner token without changing Pi credentials) --> <!-- @impl: src/lib/mcp-portal-token.ts::getValidMcpPortalToken --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC5: current grant refresh rotates without interactive Pi authorization) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC5: refresh token omission still permits the next silent renewal) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC5: a delayed successful refresh reuses only the committed same-lineage winner) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC5: permanently stale legacy ciphertext cannot roll back an authoritative refresh) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC5: racing rotating refreshes reuse only the current generation with lifetime=%s (disconnect=%s)) -->
6. Previously authorized, still-matching grants recover through the authenticated browser’s SSO when Worker refresh needs renewed authorization, without changing Pi credentials or running configuration. <!-- @impl: src/lib/mcp-portal-token.ts::getValidMcpPortalToken --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC6: refresh failure and observed disconnect during refresh fail closed) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC6: observed %s after refresh publication rejects the refresh result) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC6: observed %s before refresh publication rejects the refresh result) --> <!-- @test: src/__tests__/mcp-portal-interceptor.test.ts (REQ-AGENT-226 AC6: diagnostic wire contract for %s keeps reconnect status and metadata only) --> <!-- @impl: src/routes/mcp-oauth.ts::createMcpPortalApiRoutes --> <!-- @impl: web-ui/src/lib/mcp-portal-recovery.ts::createMcpPortalRecovery --> <!-- @impl: web-ui/src/App.tsx::AppContent --> <!-- @test: src/__tests__/routes/mcp-oauth.test.ts (REQ-AGENT-226 AC6 / REQ-AGENT-228 AC4: %s returns only a standard PKCE authorization URL when explicitly permitted) --> <!-- @test: src/__tests__/routes/mcp-oauth.test.ts (REQ-AGENT-226 AC6: %s grants are ineligible without OAuth) --> <!-- @test: web-ui/src/__tests__/components/App.test.tsx (silently renews the owner grant with Settings closed and keeps the active session) --> <!-- @test: web-ui/src/__tests__/components/App.test.tsx (discards an old recovery response while resume owner authentication is pending (%s)) --> <!-- @test: web-ui/src/__tests__/components/App.test.tsx (resumes recovery on authenticated BFCache Back without remounting or repeating authorization) --> <!-- @test: src/__tests__/routes/mcp-oauth.test.ts (REQ-AGENT-226 AC6: browser recovery resumes the unchanged Pi placeholder request without disconnect) --> <!-- @test: web-ui/src/__tests__/lib/mcp-portal-recovery.test.ts (restores the session synchronously on cancelled callback and prevents another authorization across recreations) -->
7. Disconnect clears only the selected owner/portal connection while preserving unrelated credentials, including when provider revocation fails. <!-- @impl: src/lib/mcp-portal-token.ts::disconnectMcpPortal --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC7: disconnect affects only selected owner/portal and never restores failed revocation) --> <!-- @test: src/__tests__/routes/mcp-oauth.test.ts (REQ-AGENT-226 AC7: same-origin disconnect clears only the authenticated owner portal) -->

**Constraints:**

- Secrets stay Worker-only.
- Preserve nonempty visible-ASCII Bearer bytes, including colons; reject whitespace/control/non-ASCII values, other token types and supplied nonpositive/nonfinite lifetimes. <!-- @impl: src/lib/mcp-portal-token.ts::validTokens --> <!-- @impl: src/lib/mcp-portal-token.ts::finishMcpPortalConnect --> <!-- @impl: src/lib/mcp-portal-token.ts::getValidMcpPortalToken --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC1/5: opaque provider tokens survive encrypted publication and silent renewal unchanged) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC1/2: unsafe or invalid token response %# cannot publish an owner grant) --> <!-- @test: src/__tests__/routes/mcp-oauth.test.ts (REQ-AGENT-226 AC1/3 / REQ-AGENT-229 AC1: %s opaque grants persist through callback, status reopen and placeholder forwarding) -->
- Fixed-stage diagnostics allow only closed outcome/error categories, excluding raw exceptions, credentials, provider bodies and user/session identities. Logging failure cannot change functional outcomes. <!-- @impl: src/lib/mcp-portal-token.ts::oauthDiagnostic --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (MCP OAuth fixed-stage confidentiality contract) --> <!-- @test: src/__tests__/routes/mcp-oauth.test.ts (MCP route diagnostics preserve clean outcomes) -->
- Hosted SSO/OAuth, refresh/revocation, CIMD-only metadata reachability and platform-log confidentiality require separate evidence, not synthetic qualification.
- No shared/admin grants, Access-JWT substitution, cookie copying or new issuer/channel.
- TLS remains verified.
- Automatic recovery never creates initial/new-destination grants or undoes Disconnect.
- Transient failures do not initiate OAuth; cancelled returns do not loop.
- Provider login, consent and MFA remain authoritative.
- Existing ownership checks guard restoration; never replay MCP writes.
- Pending authorization is capped at 128 per owner and expires logically after five minutes; encrypted payloads are pruned on pending operations/offboarding, not by an expiry alarm. <!-- @impl: src/lib/mcp-portal-state.ts::prunePending --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC1/2: each owner admits at most 128 pending authorizations without evicting admitted states) --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC1/2/4: the next pending %s erases all expired ciphertext while preserving live authorizations) -->
- Only eligible, unoffboarded owners import legacy grants; Disconnect/offboarding deletes legacy keys. Old pending flows are never imported. <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-226 AC7: Disconnect before legacy import revokes the original grant and erases only its exact KV key) -->

**Priority:** P1

**Dependencies:** None.

**Verification:** Automated: [Owner grant tests](../../src/__tests__/lib/mcp-portal-token.test.ts), [transport tests](../../src/__tests__/mcp-portal-interceptor.test.ts), [OAuth routes](../../src/__tests__/routes/mcp-oauth.test.ts), [security headers](../../src/__tests__/security/security-headers.test.ts), [app recovery](../../web-ui/src/__tests__/components/App.test.tsx), [recovery lifecycle](../../web-ui/src/__tests__/lib/mcp-portal-recovery.test.ts)

**Status:** Implemented

---

<a id="req-agent-227-instance-administration-of-pi-mcp-portals"></a>
<a id="req-agent-227-instance-administration-and-pi-use-of-mcp-portals"></a>
### REQ-AGENT-227: Instance administration of MCP portals

**Intent:** Administrators register portal destinations without provisioning or changing running sessions.

**Applies To:** Admin

**Acceptance Criteria:**

1. Administration Environment lets authorized administrators read portal registrations; unauthorized users cannot read them. <!-- @impl: web-ui/src/components/admin/environment-areas.ts::environmentAreas --> <!-- @test: web-ui/src/__tests__/components/admin/McpEnvironment.test.tsx (REQ-AGENT-227 AC1: normal Environment item and subsection are available in %s) --> <!-- @test: web-ui/src/__tests__/components/admin/McpEnvironment.test.tsx (REQ-AGENT-227 AC1: Overview counts all saved portals using the shared Environment item) --> <!-- @test: src/__tests__/routes/admin-configuration.test.ts (REQ-AGENT-227 AC1: Environment projection reads empty and saved portals from the existing owner in %s) --> <!-- @test: src/__tests__/routes/admin-mcp-portals.test.ts (REQ-AGENT-227 AC1: denies %s read and write) -->
2. Registration accepts unique names and public standard-port HTTPS destinations without credentials or fragments, optionally carrying only `?codemode=search_and_execute`, and returns saved values. <!-- @impl: src/lib/mcp-portals.ts::validateMcpPortals --> <!-- @test: src/__tests__/routes/admin-mcp-portals.test.ts (REQ-AGENT-227 AC2: authorized validated configuration persists without secrets or external actions) --> <!-- @test: src/__tests__/routes/admin-mcp-portals.test.ts (REQ-AGENT-227 AC2: rejects invalid or credential-bearing configuration %#) -->
3. Saved registration persists without provisioning resources, authenticating users, warming compute or restarting sessions. <!-- @impl: src/routes/admin/configuration.ts::app --> <!-- @test: src/__tests__/routes/admin-mcp-portals.test.ts (REQ-AGENT-227 AC3: saving does not mutate running sessions or grants) -->
4. Removed or changed destinations cannot use mismatched stored grants. <!-- @impl: src/lib/mcp-portal-token.ts::getMcpPortalGrant --> <!-- @test: src/__tests__/lib/mcp-portal-token.test.ts (REQ-AGENT-227 AC4: %s destinations invalidate a previously saved grant) -->
5. Administration Environment lets authorized administrators add, edit, remove and save portal registrations; unauthorized users cannot change them. <!-- @impl: web-ui/src/components/admin/McpPortalSettings.tsx::McpPortalSettings --> <!-- @impl: src/routes/admin/configuration.ts::app --> <!-- @test: web-ui/src/__tests__/components/admin/McpPortalSettings.test.tsx (REQ-AGENT-227 AC1: administrators manage multiple named portal URLs) --> <!-- @test: web-ui/src/__tests__/components/admin/McpEnvironment.test.tsx (REQ-AGENT-227 AC1: subsection Save persists and updates Overview and Environment status through removal) --> <!-- @test: src/__tests__/routes/admin-mcp-portals.test.ts (REQ-AGENT-227 AC1: denies %s read and write) -->

**Constraints:**

- Names identify connections, not tool relevance.
- Registration contains no secret/API-key field.
- Preserve existing administrator authorization and unrelated settings.

**Priority:** P1

**Dependencies:** None.

**Verification:** Automated: [Portal validation](../../src/__tests__/routes/admin-mcp-portals.test.ts), [Environment projection](../../src/__tests__/routes/admin-configuration.test.ts), [grant binding](../../src/__tests__/lib/mcp-portal-token.test.ts), [Environment UI](../../web-ui/src/__tests__/components/admin/McpEnvironment.test.tsx), [registration UI](../../web-ui/src/__tests__/components/admin/McpPortalSettings.test.tsx)

**Status:** Implemented

---

### REQ-AGENT-228: Owner Pi MCP configuration and discovery

**Intent:** Owners discover approved portal tools through the native Pi adapter in both supported modes.

**Applies To:** User

**Acceptance Criteria:**

1. Both default/basic and advanced startup expose configured Code Mode wrappers through native adapter registrations with deferred tool discovery and only a public placeholder, with no second client or Pi-owned portal OAuth provider. <!-- @test: host/__tests__/pi-mcp-portals.test.js (REQ-AGENT-228 AC1: both supported Pi modes bootstrap while invalid modes and incomplete migration preserve files) --> <!-- @test: host/__tests__/pi-mcp-portals.test.js (REQ-AGENT-228 AC1: actual entrypoint wiring bootstraps managed portals in default and advanced Pi) --> <!-- @impl: scripts/merge-pi-mcp-portals.mjs::mergePiMcpPortals --> <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: host/__tests__/pi-mcp-portals.test.js (REQ-AGENT-228 AC1: startup produces multiple idle-disconnecting non-secret placeholder portal connections) --> <!-- @test: host/__tests__/pi-mcp-stock.test.js (REQ-AGENT-228: adapter placeholder proxy discovers and executes originating portal wrappers with explicit partial coverage) -->
2. Idempotent reconciliation changes only proven managed registrations and preserves unrelated MCP configuration, stdio/local OAuth grants and native lifecycle behavior. <!-- @impl: scripts/merge-pi-mcp-portals.mjs::mergePiMcpPortals --> <!-- @test: host/__tests__/pi-mcp-portals.test.js (REQ-AGENT-228 AC2: reconciliation preserves unrelated servers and grants) --> <!-- @test: host/__tests__/pi-mcp-stock.test.js (REQ-AGENT-228: unmanaged local OAuth retains real PKCE grant persistence, refresh and shutdown lifecycle) -->
3. Registration changes apply on subsequent startup without rewriting running Pi configuration. <!-- @impl: src/container/container-config.ts::refreshMcpPortalConfiguration --> <!-- @test: src/__tests__/container/container-env.test.ts (REQ-AGENT-228 AC3: startup rereads changed instance portal configuration and clears removals) -->
4. Managed portal connections disconnect after ten idle minutes without stopping active calls, retain cached discovery, and reconnect on the next authorized call. <!-- @impl: scripts/merge-pi-mcp-portals.mjs::mergePiMcpPortals --> <!-- @test: host/__tests__/pi-mcp-stock.test.js (REQ-AGENT-228: native ten-minute idle cleanup disconnects and the next proxy call reconnects) --> <!-- @test: host/__tests__/pi-mcp-stock.test.js (REQ-AGENT-228: idle cleanup protects an active portal call and closes only after completion) -->

**Notes:** Progressive use and distinct CI, signed-delivery, local-reload and hosted acceptance checks are documented in [Model Context Protocol](../../documentation/lanes/mcp.md#delivery-and-acceptance-boundaries).

**Constraints:**

- Availability never bypasses owner, tenant or Operator authorization.
- Builtin MCP remains disabled; pi-mcp-adapter is the sole MCP owner.
- Preserve unrelated user/project MCP and OAuth state.
- Connection affordances and owner feedback follow [REQ-AGENT-251](#req-agent-251-owner-bound-mcp-settings-return-and-status).
- Progressive portal guidance has its own owner, [REQ-AGENT-256](#req-agent-256-progressive-portal-guidance).

**Priority:** P1

**Dependencies:** [REQ-AGENT-226](#req-agent-226-worker-owned-mcp-portal-authorization), [REQ-AGENT-227](#req-agent-227-instance-administration-of-mcp-portals)

**Verification:** Automated: [Startup configuration](../../host/__tests__/pi-mcp-portals.test.js), [native client](../../host/__tests__/pi-mcp-stock.test.js), [startup refresh](../../src/__tests__/container/container-env.test.ts); Manual: [Progressive portal use](../../documentation/lanes/mcp.md#progressive-portal-use)

**Status:** Implemented

---

### REQ-AGENT-256: Progressive portal guidance

**Intent:** Pi loads only the portal guidance it needs and respects approved portal coverage and uncertain effects.

**Applies To:** User

**Acceptance Criteria:**

1. An auto-discoverable native router progressively loads connection, discovery and execution topics in both Pi modes. <!-- @impl: preseed/agents/pi/skills/mcp-portals/SKILL.md::MCP portals --> <!-- @manual: In each Pi mode discover the router and follow its links to load only the required topic; verify the managed artifact identity separately. -->
2. Portal guidance requires approved-set bootstrap before selection, wrapper/inner-method distinction, live schemas, originating-portal methods and explicit partial coverage. <!-- @impl: preseed/agents/pi/skills/mcp-portal-discovery/SKILL.md::Discover portal tools --> <!-- @manual: Bootstrap approved synthetic portals, activate exact search/execute wrappers, inspect live schemas and originating-portal results, and report missing coverage. -->
3. Execution guidance requires readback of an uncertain write before considering a retry. <!-- @impl: preseed/agents/pi/skills/mcp-portal-execution/SKILL.md::Execute portal workflows --> <!-- @manual: Read back the original operation in a controlled uncertain-write fixture before considering retry. -->

**Constraints:**

- Deliver skills through existing seed/Curation.
- Guidance grants no tool, tenant or user authority and does not add a second client.

**Priority:** P1

**Dependencies:** [REQ-AGENT-228](#req-agent-228-owner-pi-mcp-configuration-and-discovery)

**Verification:** Manual: [Progressive portal use](../../documentation/lanes/mcp.md#progressive-portal-use)

**Status:** Implemented

---

### REQ-AGENT-251: Owner-bound MCP Settings return and status

**Intent:** Owners manage each portal in Settings and retain truthful feedback across authorization return.

**Applies To:** User

**Acceptance Criteria:**

1. Fixed MCP return feedback remains visible to the same owner after URL cleanup and owned-session restoration. <!-- @impl: web-ui/src/lib/mcp-portal-recovery.ts::createMcpPortalRecovery --> <!-- @test: web-ui/src/__tests__/components/App.test.tsx (REQ-AGENT-226 AC3/6 / REQ-AGENT-228 AC4: %s survives pre-mount URL cleanup into owner Settings without an authorization loop) -->
2. Activating the MCP section or returning from authorization to it refreshes status; opening Settings on another section does not probe MCP. Late responses from closed or replaced owner lifetimes cannot overwrite it. <!-- @test: web-ui/src/__tests__/components/McpSettingsRecovery.test.tsx (REQ-AGENT-251 AC2: opening other Settings sections sends no MCP status request) --> <!-- @test: web-ui/src/__tests__/components/McpPortalsSection.test.tsx (REQ-AGENT-226 AC6 / REQ-AGENT-228 AC4: late old-owner status and return outcome cannot replace the current owner surface) --> <!-- @test: web-ui/src/__tests__/components/McpPortalsSection.test.tsx (REQ-AGENT-226 AC3/6 / REQ-AGENT-228 AC4: a returned outcome refreshes a mounted section but cannot certify connectivity) --> <!-- @impl: web-ui/src/components/settings/McpPortalsSection.tsx::McpPortalsSection --> <!-- @test: web-ui/src/__tests__/components/McpSettingsRecovery.test.tsx (REQ-AGENT-228 AC4: mounted Settings MCP status recovery) -->
3. Saved MCP authorization and successful-return feedback do not certify live tool access or override disconnected API status. <!-- @impl: web-ui/src/components/settings/McpPortalsSection.tsx::McpPortalsSection --> <!-- @test: web-ui/src/__tests__/components/McpPortalsSection.test.tsx (REQ-AGENT-226 AC3/6 / REQ-AGENT-228 AC4: a returned outcome refreshes a mounted section but cannot certify connectivity) -->
4. Completion and status artifacts expose no authorization code, verifier or token. <!-- @impl: src/routes/mcp-oauth.ts::createMcpOAuthRoutes --> <!-- @test: src/__tests__/routes/mcp-oauth.test.ts (REQ-AGENT-226 AC3: %s uses browser OAuth and clean owner-bound completion without compute startup) --> <!-- @test: src/__tests__/security/security-headers.test.ts (REQ-AGENT-226 AC3: full app preserves no-referrer and routes MCP returns before auth fallback) -->
5. Across deployment, subscription and Pi modes, shared Settings provides multiple portals’ Connect, Re-authorize, Disconnect, saved authorization and accessible loading, error and empty states. <!-- @test: web-ui/src/__tests__/components/McpPortalsSection.test.tsx (REQ-AGENT-228 AC4: empty configuration, loading errors and disconnect errors are actionable and accessible) --> <!-- @impl: web-ui/src/components/settings/McpPortalsSection.tsx::McpPortalsSection --> <!-- @test: web-ui/src/__tests__/components/McpPortalsSection.test.tsx (REQ-AGENT-228 AC4 / REQ-AGENT-226 AC7: saved authorization offers a non-destructive Re-authorize separately from Disconnect) --> <!-- @test: web-ui/src/__tests__/components/McpPortalsSection.test.tsx (REQ-AGENT-228 AC4: multiple portal identities connect through existing browser navigation and disconnect independently) --> <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (REQ-AGENT-228 AC4: MCP Settings is available in both Pi modes and all subscription modes (enterprise=%s)) -->
6. Shared portal Settings keep concise permission guidance visible without a troubleshooting disclosure or hiding connection actions. <!-- @impl: web-ui/src/components/settings/McpPortalsSection.tsx::McpPortalsSection --> <!-- @test: web-ui/src/__tests__/components/McpPortalsSection.test.tsx (REQ-AGENT-228 AC4: concise permission guidance keeps connection actions available without a troubleshooting disclosure) -->

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-AGENT-226](#req-agent-226-worker-owned-mcp-portal-authorization), [REQ-AGENT-228](#req-agent-228-owner-pi-mcp-configuration-and-discovery)

**Verification:** Automated: [MCP status recovery](../../web-ui/src/__tests__/components/McpSettingsRecovery.test.tsx), [MCP presentation](../../web-ui/src/__tests__/components/McpPortalsSection.test.tsx), [Settings modes](../../web-ui/src/__tests__/components/SettingsPanel.test.tsx), [App return feedback](../../web-ui/src/__tests__/components/App.test.tsx), [OAuth routes](../../src/__tests__/routes/mcp-oauth.test.ts), [security headers](../../src/__tests__/security/security-headers.test.ts)

**Status:** Implemented

---

### REQ-AGENT-229: Worker-mediated MCP portal transport

**Intent:** Owners use portal tools without exposing their real credentials to Pi.

**Applies To:** User

**Acceptance Criteria:**

1. Only a trusted parent-bound owner grant replaces agent credentials at the exact currently approved HTTPS portal destination. <!-- @impl: src/mcp-portal-interceptor.ts::forwardMcpPortal --> <!-- @test: src/__tests__/container/mcp-portal-interception.test.ts (REQ-AGENT-229 AC1: registered portal boundary is available in all deployment modes and refuses missing owner grants (enterprise=%s)) --> <!-- @test: src/__tests__/mcp-portal-interceptor.test.ts (REQ-AGENT-229 AC4: stamps the trusted owner grant and preserves functional response streams and downstream URL context) --> <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-AGENT-229 AC1: catch-all stamps only the parent owner grant and preserves MCP wire outcomes) --> <!-- @test: src/__tests__/container/mcp-portal-interception.test.ts (REQ-AGENT-229 AC1: strict catch-all keeps parent portal ownership across R2 refresh (refresh=%s)) -->
2. Wrong owner/resource/instance/configuration bindings, Operators and redirected destinations fail closed without credential forwarding. <!-- @impl: src/mcp-portal-interceptor.ts::forwardMcpPortal --> <!-- @test: src/__tests__/mcp-portal-interceptor.test.ts (REQ-AGENT-229 AC2: rejects wrong resource, owner, Operator, instance, configuration, missing grant and strict-egress absence before sending) --> <!-- @test: src/__tests__/container/mcp-portal-interception.test.ts (REQ-AGENT-229 AC2: parent-bound Operators cannot inherit ordinary owner portal grants) --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-AGENT-229 AC2: catch-all denies %s without a protected send) --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-AGENT-229 AC2: unrelated URL and forged Host retain ordinary auth without owner lookup) --> <!-- @test: src/__tests__/container/mcp-portal-interception.test.ts (REQ-AGENT-229 AC2: strict refresh selects current configuration without adopting an old grant) --> <!-- @test: src/__tests__/container/mcp-portal-interception.test.ts (REQ-AGENT-229 AC2: parent Operator profile cannot inherit a catch-all owner grant (refresh=%s)) -->
3. Unavailable mandatory interception or colliding outbound transports prevents startup. <!-- @impl: src/container/container-interception.ts::wireContainerInterception --> <!-- @test: src/__tests__/container/mcp-portal-interception.test.ts (REQ-AGENT-229 AC3: portal host collisions and unavailable interception fail startup rather than bypassing credential isolation) -->
4. Approved upstream response streams and status codes pass through intact. <!-- @impl: src/mcp-portal-interceptor.ts::forwardMcpPortal --> <!-- @test: src/__tests__/mcp-portal-interceptor.test.ts (REQ-AGENT-229 AC4: stamps the trusted owner grant and preserves functional response streams and downstream URL context) --> <!-- @test: src/__tests__/mcp-portal-interceptor.test.ts (REQ-AGENT-229 AC4: rejects redirects without credential leakage and preserves actual upstream failure status) -->
5. Credential maintenance never replays MCP requests after uncertain write outcomes. <!-- @impl: src/mcp-portal-interceptor.ts::forwardMcpPortal --> <!-- @test: src/__tests__/mcp-portal-interceptor.test.ts (REQ-AGENT-229 AC5: uncertain MCP writes are never replayed after response loss) --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-AGENT-229 AC5: catch-all never replays uncertain MCP writes or follows redirects) -->
6. Response cancellation reaches the original upstream stream. <!-- @impl: src/mcp-portal-interceptor.ts::forwardMcpPortal --> <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/mcp-portal-interceptor.test.ts (REQ-AGENT-229 AC4: response cancellation reaches the original upstream stream) --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-AGENT-229 AC4: catch-all streams downstream authorization context and preserves cancellation) -->
7. Approved responses preserve portal-issued downstream authorization context. <!-- @impl: src/mcp-portal-interceptor.ts::forwardMcpPortal --> <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/mcp-portal-interceptor.test.ts (REQ-AGENT-229 AC4: stamps the trusted owner grant and preserves functional response streams and downstream URL context) --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-AGENT-229 AC4: catch-all streams downstream authorization context and preserves cancellation) -->

**Constraints:**

- TLS verification and strict egress remain enforced.
- No shared service/admin identity or agent-selected owner.
- GitHub upstream requires per-user authentication.
- Exposed write schemas are not authorization for arbitrary mutations.
- Hosted upstream/downstream authorization and revocation require separate evidence from synthetic boundary tests.

**Priority:** P1

**Dependencies:** [REQ-AGENT-226](#req-agent-226-worker-owned-mcp-portal-authorization)

**Verification:** Automated: [Credential-isolated transport](../../src/__tests__/mcp-portal-interceptor.test.ts), [container interception](../../src/__tests__/container/mcp-portal-interception.test.ts), [strict egress](../../src/__tests__/egress-controller.test.ts)

**Status:** Implemented

---

### REQ-AGENT-217: Lossless Pi MCP adapter migration

**Intent:** Selected MCP clients prepare their own configuration without losing unrelated servers, conflicting credentials or displaced originals. Managed startup restores the native adapter and its idle-disconnect behavior.

**Applies To:** User

**Acceptance Criteria:**

1. Managed load prepares the positively selected client only; dual or unknown selections preserve both MCP files and report ambiguity without exposing contents. Exact managed Hermes-wrapper exclusions do not change MCP ownership. <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC1: Hermes exclusion preserves MCP ownership (${form}, ${owner})) --> <!-- @impl: preseed/agents/pi/extensions/00-mcp-adapter-config.ts::registerMcpAdapterMigration --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: selected stock hands off even when the adapter is merely installed) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: configured MCP selection protects native files (${name})) -->  <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-BROWSER-009: native keep-alive browser lifecycle and custom idle minutes survive timeout preparation) --> <!-- @impl: preseed/agents/pi/extensions/00-mcp-adapter-config.ts::migratePiMcpAdapterConfig --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (legacy adapter migration preserves exact bytes, credentials, custom servers and 600000 browser retention) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: managed stock handoff survives native portal reconciliation and repeated startup) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC1/AC2/AC7: Review exclusions preserve selected client behavior (${form}, ${owner})) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC1: Review exception does not authorize other exclusions (${exclusion})) --> <!-- @impl: entrypoint.sh::configure_pi_packages_and_review_inventory --> <!-- @test: host/__tests__/pi-settings-packages.test.js (REQ-AGENT-217: startup retires duplicated managed stock runtime aliases (${form})) -->
2. Native handoff translates supported legacy fields and imports nonconflicting settings/servers into the native adapter configuration; native definitions win for proven generated duplicates. <!-- @impl: preseed/agents/pi/extensions/00-mcp-adapter-config.ts::preparePiMcpAdapterConfig --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: managed stock handoff survives native portal reconciliation and repeated startup) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC2/AC4/AC7: dual restored managed defaults retain native authority and retire exact obsolete source (${shape})) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC2/AC6/AC7: actual dual-file startup refreshes managed constructors and portals (enterprise=${enterprise})) -->
3. Matching, conflicting, unreadable, symlink and directory passive archives never overwrite existing data or block recovery. <!-- @impl: preseed/agents/pi/extensions/00-mcp-adapter-config.ts::preserve --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (existing migration backup is never overwritten or used to discard legacy credentials) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (occupied ${kind} archive is preserved without following it or preventing recovery) -->  <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (unreadable passive archive cannot block custom legacy recovery) -->
4. Preparation preserves original configuration when active inputs are malformed, unsafe or contain conflicting custom definitions. <!-- @impl: preseed/agents/pi/extensions/00-mcp-adapter-config.ts::migratePiMcpAdapterConfig --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (malformed existing destination is archived and recovers exact valid legacy configuration) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (nonregular destination blocks migration and retains legacy) --> <!-- @impl: preseed/agents/pi/extensions/00-mcp-adapter-config.ts::preparePiMcpAdapterConfig --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: native handoff rejects ${path} ${kind} preserving all originals) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: symlink ancestor blocks native preparation) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: native ${collision} collision chooses no winner) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC4: dual-file custom collision preserves both originals (${side}, ${change})) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC4: native-shaped obsolete entries do not broaden stock schema (${duplicate})) -->
5. The active root native adapter configuration, preserved originals, recovery copies and nested files remain baseline/bisync eligible. <!-- @impl: entrypoint.sh::configure_pi_mcp_adapter --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: active native configuration and recovery objects remain baseline-sync eligible) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: failed native preparation blocks Pi shell merge without excluding restored files from baseline) --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-AGENT-217 AC5: native preparation excludes only retired root stock from a real local baseline) -->
6. Startup reconstructs recognizable generated consult and browser entries from current runtime inputs while preserving customized configuration, including when Browser Run is disabled. <!-- @test: host/__tests__/entrypoint-browser-run-mcp.test.js (REQ-BROWSER-006 AC4/REQ-AGENT-217 AC6: ${mode} preserves normalized native Pi without stock or archives (${customization})) --> <!-- @impl: entrypoint.sh::configure_pi_mcp_adapter --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC6: actual startup regenerates proven managed consult and browser from fresh inputs (${origin})) --> <!-- @test: host/__tests__/entrypoint-browser-run-mcp.test.js (REQ-BROWSER-006: startup regenerates the image-owned browser endpoint and headers while preserving custom settings) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC2/AC6/AC7: actual dual-file startup refreshes managed constructors and portals (enterprise=${enterprise})) -->
7. Transformed originals are recoverable before replacement; completed native handoff archives the unchanged stock source before retiring its active filename, and failed writes preserve source data. <!-- @impl: preseed/agents/pi/extensions/00-mcp-adapter-config.ts::preserve --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: one-time handoff retains active stock on ${failure}) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: native replacement failure leaves the active original and recovery bytes intact) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217 AC2/AC4/AC7: dual restored managed defaults retain native authority and retire exact obsolete source (${shape})) -->

**Notes:** Distinct signed-delivery and hosted-handoff checks are documented in [Model Context Protocol](../../documentation/lanes/mcp.md#delivery-and-acceptance-boundaries).

**Constraints:**

- No bucket deletion/sync redesign; only successful native handoff excludes obsolete root `.pi/agent/mcp.json` from subsequent baseline/bisync; initial restore/failed preparation remain eligible. <!-- @impl: entrypoint.sh::configure_pi_mcp_adapter --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: active native configuration and recovery objects remain baseline-sync eligible) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: failed native preparation blocks Pi shell merge without excluding restored files from baseline) -->
- Packages do not prove selection.
- Exact managed exclusions `mcp-portal-oauth.ts`, `review-enforcement.ts`, `operator-review-remote.ts`, `hermes-memory-runtime.ts` are selection-neutral; other unsupported filters fail closed before preparation.
- Registration chooses no settings winner and disables neither client; managed startup selects the native adapter, explicit stock-only retains guarded handoff.
- Preserve transformed custom originals before replacement.
- Positively selected stock-only managed load decodes selected legacy stdio `!!` by one `!`, never valid-destination literal environment. <!-- @test: preseed/agents/pi/test/consult-proxy.test.mjs (REQ-AGENT-217: actual stdio server receives the selected schema's literal env (legacy=${legacy}, regenerate=${regenerate})) --> <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-069: generated native provider environment escapes a literal leading exclamation mark) -->
- Reject selected legacy commands/interpolation before evaluation/writes, preserving originals/content-free diagnostics; unselected expressions cannot block valid destinations. <!-- @test: host/__tests__/pi-mcp-adapter-config.test.js (REQ-AGENT-217: rejected legacy env produces a content-free managed-load diagnostic) -->
- Native conversion escapes literal leading bangs, never evaluating stock values as secret commands; unsupported expressions fail closed.
- Native lifecycle settings remain native; progress resets request timeout, independently of idle disconnect/provider retention.
- Managed timeouts follow [REQ-BROWSER-009](browser-run.md#req-browser-009-mcp-and-chrome-sdk-timeout-profile); constructors/Claude follow [REQ-AGENT-069](agents.md#req-agent-069-pi-consult-llm-mcp-lazy-wiring).

**Priority:** P1

**Dependencies:** [REQ-AGENT-069](agents.md#req-agent-069-pi-consult-llm-mcp-lazy-wiring)

**Verification:** Automated: [Migration behavior](../../host/__tests__/pi-mcp-adapter-config.test.js), [browser reconstruction](../../host/__tests__/entrypoint-browser-run-mcp.test.js), [client selection](../../host/__tests__/pi-settings-packages.test.js), [literal stdio environment](../../preseed/agents/pi/test/consult-proxy.test.mjs), [entrypoint-rclone-filters.test.js](../../host/__tests__/entrypoint-rclone-filters.test.js)

**Status:** Implemented

---

### REQ-AGENT-281: Bundled MCP Manager registration retirement

**Intent:** Keep restored bundled Pi Web registrations from competing with Codeflare’s managed MCP adapter.

**Applies To:** User

**Acceptance Criteria:**

1. Successful managed package reconciliation retires the exact image-bundled Pi Web MCP Manager registration from restored settings without deleting package files or removing unrelated entries as part of that retirement. <!-- @impl: entrypoint.sh::configure_pi_packages_and_review_inventory --> <!-- @test: host/__tests__/pi-settings-packages.test.js (REQ-AGENT-281: startup retires the exact bundled Pi Web MCP Manager registration) --> <!-- @test: scripts/ci/smoke-pi-web-services.mjs (verifyBundledManagerFilePreservation) -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-217](#req-agent-217-lossless-pi-mcp-adapter-migration)

**Verification:** Automated: [Restored package inventory](../../host/__tests__/pi-settings-packages.test.js), [Bundled-file preservation smoke](../../scripts/ci/smoke-pi-web-services.mjs).

**Status:** Implemented

---
