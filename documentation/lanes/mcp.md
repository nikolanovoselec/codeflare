# Model Context Protocol

**Audience:** Users, administrators and agent developers.

**Owns:** MCP portal connection, owner authorization, discovery, execution and recovery.

**Does not own:** [Configuration](configuration.md) owns saved settings; [API Reference](api-reference.md#admin) owns route contracts; [Agent Environment](preseed.md) owns delivery; [Security](security.md) owns shared trust controls. Browser automation remains a separate [Browser Run contract](../../sdd/spec/browser-run.md).

## Contents

- [Register and connect](#register-and-connect)
- [Owner authorization and recovery](#owner-authorization-and-recovery)
- [Discover and execute](#discover-and-execute)
- [Client configuration and migration](#client-configuration-and-migration)
- [Failure and recovery](#failure-and-recovery)
- [Acceptance procedures](#acceptance-procedures)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

## Register and connect

An administrator registers unique portal names and public HTTPS destinations through Administration → Environment. [Configuration](configuration.md#mcp-portal-registration) specifies URL validation and supported options. Registration contains no credential field; saving neither authenticates an owner nor provisions resources, starts compute or restarts a session. Names identify connections, not tool relevance. ([REQ-AGENT-227](../../sdd/spec/mcp.md#req-agent-227-instance-administration-of-mcp-portals))

The owner opens Settings → Model Context Protocol and chooses **Connect** for the intended portal. Login, consent and MFA occur in the browser. Each owner connects independently; an administrator's grant is not shared with users or Operators. **Authorize again** starts the same owner flow without deleting saved authorization; **Disconnect** remains a separate selected-owner/portal action. **Authorization saved** does not certify live upstream access or tool readiness. ([REQ-AGENT-226](../../sdd/spec/mcp.md#req-agent-226-worker-owned-mcp-portal-authorization), [REQ-AGENT-228](../../sdd/spec/mcp.md#req-agent-228-owner-pi-mcp-configuration-and-discovery))

## Owner authorization and recovery

Settings → Model Context Protocol obtains the owner's browser OAuth grant, stores it encrypted in dedicated Worker KV records and provides per-portal Disconnect. Both Pi modes receive native lazy registrations with ten-minute idle disconnect, cached/deferred discovery, disabled Pi-owned portal OAuth and only `Authorization: Bearer codeflare-mcp-portal`, preserving unrelated configuration and grants. ([REQ-AGENT-228](../../sdd/spec/mcp.md#req-agent-228-owner-pi-mcp-configuration-and-discovery))

The interceptor refreshes matching grants outside Pi when a usable refresh token is available, without replaying MCP writes. Eligible missing-refresh-token or `invalid_grant` recovery can request owner browser authorization; provider login, consent or MFA may require interaction. Neither path changes Pi credentials or requires a restart. New or disconnected portals still require explicit Connect. ([REQ-AGENT-226](../../sdd/spec/mcp.md#req-agent-226-worker-owned-mcp-portal-authorization), [REQ-AGENT-228](../../sdd/spec/mcp.md#req-agent-228-owner-pi-mcp-configuration-and-discovery), [REQ-AGENT-229](../../sdd/spec/mcp.md#req-agent-229-worker-mediated-mcp-portal-transport)) <!-- @impl: scripts/merge-pi-mcp-portals.mjs::mergePiMcpPortals --> <!-- @impl: src/lib/mcp-portal-token.ts::getValidMcpPortalToken -->

Recovery runs on authenticated app entry/resume and visible checks, independently of Settings. It serializes browser authorization, preserves a canonical session return path, and prevents failed/cancelled returns from looping. Fixed return outcomes survive URL cleanup into the same owner's Settings; late or foreign-owner responses cannot replace the current surface. Existing session ownership checks still govern restoration. Provider login, consent or MFA may require interaction; no cookies or credentials are copied into Pi. <!-- @impl: web-ui/src/lib/mcp-portal-recovery.ts::createMcpPortalRecovery -->

Settings refreshes status when the panel/MCP section opens or authorization returns. It shows loading, error and empty states, portal identity, an **Authorization saved** badge and separate Connect/**Authorize again**/Disconnect actions. Return notices do not override API status or certify tool readiness. Existing authorization is retained while the owner corrects provider access; no setup-help category or upstream health probe is introduced. <!-- @impl: web-ui/src/components/settings/McpPortalsSection.tsx::McpPortalsSection -->

Dynamic client registration is preferred when supported. A CIMD-only issuer must be able to fetch the fixed `/auth/mcp/client-metadata` document externally. Its anonymous Worker handler does not bypass host-wide Cloudflare Access; verify reachability before hosted acceptance. Codeflare does not provision an Access bypass or change grants automatically. <!-- @impl: src/lib/mcp-portal-token.ts::beginMcpPortalConnect -->

Keep the GitHub upstream at `https://api.githubcopilot.com/mcp/` with Require user auth ON, never `/readonly` or a shared service credential. ([REQ-AGENT-229](../../sdd/spec/mcp.md#req-agent-229-worker-mediated-mcp-portal-transport))

Credentials remain Worker-only. Never copy portal tokens, browser cookies or Access JWTs into Pi. Provider-issued downstream authorization URLs belong to the same portal user/grant; complete that provider's authorized browser flow rather than substituting a shared identity. KV publication is non-atomic; the documented in-flight Disconnect race remains tracked in [#1386](https://github.com/nikolanovoselec/codeflare/issues/1386), not represented as solved.

## Discover and execute

Use the installed [MCP portal router](../../preseed/agents/pi/skills/mcp-portals/SKILL.md), then load only its connection, discovery or execution topic as needed.

1. Establish catalogue coverage for the entire configured, owner-approved portal set. Reuse valid cached discovery; connect when access or missing metadata requires it.
2. Inspect each portal's live wrapper schemas. Pi wrapper discovery is not discovery of remote inner methods.
3. Search the observed catalogues for the requested capability. An unavailable portal means partial coverage, not proof a tool is absent.
4. Execute the exact originating-portal method using its live schema. Sequence dependent calls; parallelize only independent, authorized reads.
5. Preserve partial failures and downstream authorization context. For an uncertain write, obtain authoritative readback before considering a retry; credential recovery never replays the write.

Tool availability is not permission for production, billing, destructive or user-data operations. Existing owner, tenant and Operator authorization remains binding. ([REQ-AGENT-228](../../sdd/spec/mcp.md#req-agent-228-owner-pi-mcp-configuration-and-discovery), [REQ-AGENT-229](../../sdd/spec/mcp.md#req-agent-229-worker-mediated-mcp-portal-transport))

## Client configuration and migration

The native adapter is the sole managed MCP owner in default/basic and advanced Pi; built-in MCP stays disabled. Registration changes apply at subsequent startup, not by rewriting an active Pi configuration. Managed connections disconnect after ten idle minutes, protect active calls, retain discovery and reconnect for the next authorized call. ([REQ-AGENT-228](../../sdd/spec/mcp.md#req-agent-228-owner-pi-mcp-configuration-and-discovery))

Migration preserves unrelated servers, local stdio OAuth and recoverable originals. A valid native destination remains authoritative; selected supported legacy entries may be imported. Conflicting custom definitions, unsafe expressions and failed preparation fail closed. Only successful native handoff excludes obsolete root `mcp.json` from later baseline/bisync; initial restore and failed preparation retain its eligibility. Do not delete bucket content or create a second client to bypass a migration failure. ([REQ-AGENT-217](../../sdd/spec/mcp.md#req-agent-217-lossless-pi-mcp-adapter-migration))

### Delivery and acceptance boundaries

CI test results, a signed managed release, installed artifact identity, deliberate local reload and hosted handoff/use establish different outcomes. [Agent Environment](preseed.md) owns delivery and identity checks. Reloading activates the installed guidance; it is not proof of a successful portal call. Hosted checks below retain their own authorization and sanitized evidence. ([REQ-AGENT-217](../../sdd/spec/mcp.md#req-agent-217-lossless-pi-mcp-adapter-migration), [REQ-AGENT-228](../../sdd/spec/mcp.md#req-agent-228-owner-pi-mcp-configuration-and-discovery))

## Failure and recovery

| Observation | Action | Expected result |
|---|---|---|
| No configured portals | Ask an authorized administrator to inspect Environment registration | Settings reflects saved names/URLs; no owner grant is invented |
| Authorization saved, but tools unavailable | Inspect allowed servers/upstream authorization; use Authorize again when needed | Report missing coverage honestly; retry authorization without Disconnect |
| Expired matching grant | Allow normal authenticated recovery; complete requested provider login/consent | The existing session stays selected; no Pi credential or MCP write is replayed |
| New, changed or disconnected portal | Explicitly Connect the intended destination | No old or unrelated grant is adopted |
| CIMD issuer cannot fetch metadata | Inspect host-wide Access reachability using the owning deployment runbook | Metadata is reachable under the approved policy; no automatic bypass is created |
| Client preparation fails | Inspect content-free diagnostics and retained originals | Startup does not silently switch clients or discard recoverable configuration |

### Secret-safe OAuth diagnostics

Connect, callback completion and attempted renewal emit fixed lifecycle stages with allowlisted outcomes/error or timeout categories. They do not log raw exceptions, provider bodies, codes, state, verifiers, tokens, cookies, headers or user/session identities. A grant-publication completion records the write outcome, not successful tool use or atomic KV publication. Missing-grant status polling does not create a diagnostic stream. Hosted SSO/renewal and platform-log confidentiality still require their own authorized observations; application instrumentation alone is not acceptance. ([REQ-AGENT-226](../../sdd/spec/mcp.md#req-agent-226-worker-owned-mcp-portal-authorization)) <!-- @impl: src/lib/mcp-portal-token.ts::oauthDiagnostic --> <!-- @impl: src/lib/mcp-portal-token.ts::getValidMcpPortalToken -->

## Acceptance procedures

These are procedures, not passing receipts. Use explicitly authorized disposable accounts, portals and sessions; do not modify production, credentials or user data merely because a procedure is documented. Synthetic tests do not establish hosted SSO, downstream provider access, refresh/revocation, external CIMD reachability or platform-log confidentiality.

### Owner connection and recovery

In an approved environment, connect one test owner's portal through Settings, complete any downstream provider authorization, then perform a harmless catalogue read. ([REQ-AGENT-226](../../sdd/spec/mcp.md#req-agent-226-worker-owned-mcp-portal-authorization))

Let the test issuer expire the grant and resume the authenticated app with Settings closed; cancel a separate authorization return. Expect current-grant renewal or explicit provider interaction, retained session navigation, no cancellation loop and no replay of a preceding MCP write. Disconnect the selected test connection and verify another owner's/portal's connection is unchanged; an unsuccessful provider revocation must not restore local connection state. Record only sanitized outcomes, never codes, verifiers, tokens or cookies.

Reopen Settings and re-expand MCP without remounting the app; expect fresh saved-authorization state. A failed/cancelled return must remain visible after the URL is cleaned, and Authorize again must leave the existing grant intact until successful replacement. A successful return notice must not override a disconnected API response or certify tool access.

This exercises [REQ-AGENT-226](../../sdd/spec/mcp.md#req-agent-226-worker-owned-mcp-portal-authorization) and [REQ-AGENT-229](../../sdd/spec/mcp.md#req-agent-229-worker-mediated-mcp-portal-transport).

For a CIMD-only test issuer, request its advertised metadata document from outside the authenticated owner browser under the approved deployment policy. Expect the fixed document without owner identity or credentials; an Access login page is not successful issuer reachability. Inspect authorized sanitized application/platform-log evidence for the test flow; retain only the confidentiality outcome. Do not provision an Access bypass as part of checking it. ([REQ-AGENT-226](../../sdd/spec/mcp.md#req-agent-226-worker-owned-mcp-portal-authorization))

### Progressive portal use

In each supported Pi mode, discover the router and load only the topic required for the task. With approved synthetic portals, inspect native registrations, activate the exact search/execute wrappers, discover their live schemas and invoke a harmless observed inner method through its originating portal. Make one catalogue unavailable: expect explicit partial coverage rather than an absence claim. For a controlled uncertain-write fixture, read back the original operation before any authorized retry. Expect unchanged owner credentials and no automatic replay. This checks [REQ-AGENT-228](../../sdd/spec/mcp.md#req-agent-228-owner-pi-mcp-configuration-and-discovery) AC5–6; managed artifact identity is verified separately through [Agent Environment](preseed.md).

### Guarded configuration handoff

Use disposable restored native/legacy configuration fixtures and the existing migration suites. Preserve a valid native definition, an unrelated stdio server and a recoverable custom original; separately test a genuine conflict and rejected legacy expression. Expect only supported selected entries to migrate, retained originals on failure and successful-only obsolete-file sync exclusion. Never execute an inspected adapter or delete real configuration merely to diagnose it. This checks [REQ-AGENT-217](../../sdd/spec/mcp.md#req-agent-217-lossless-pi-mcp-adapter-migration); signed delivery and installed identity do not alone prove a successful hosted handoff.

## Requirement and Source Map

| Concern | Requirements | Source owner | Evidence |
|---|---|---|---|
| Owner grants and browser recovery | [REQ-AGENT-226](../../sdd/spec/mcp.md#req-agent-226-worker-owned-mcp-portal-authorization) | `src/lib/mcp-portal-token.ts::getValidMcpPortalToken`, `web-ui/src/lib/mcp-portal-recovery.ts::createMcpPortalRecovery` | [Grant tests](../../src/__tests__/lib/mcp-portal-token.test.ts), [route tests](../../src/__tests__/routes/mcp-oauth.test.ts), [recovery tests](../../web-ui/src/__tests__/lib/mcp-portal-recovery.test.ts) |
| Instance registration | [REQ-AGENT-227](../../sdd/spec/mcp.md#req-agent-227-instance-administration-of-mcp-portals) | `src/lib/mcp-portals.ts::validateMcpPortals` | [API tests](../../src/__tests__/routes/admin-mcp-portals.test.ts), [Settings tests](../../web-ui/src/__tests__/components/admin/McpPortalSettings.test.tsx) |
| Native configuration and progressive use | [REQ-AGENT-228](../../sdd/spec/mcp.md#req-agent-228-owner-pi-mcp-configuration-and-discovery) | `scripts/merge-pi-mcp-portals.mjs::mergePiMcpPortals` | [Configuration tests](../../host/__tests__/pi-mcp-portals.test.js), [native client tests](../../host/__tests__/pi-mcp-stock.test.js); [progressive-use procedure](#progressive-portal-use) |
| Credential-isolated transport | [REQ-AGENT-229](../../sdd/spec/mcp.md#req-agent-229-worker-mediated-mcp-portal-transport) | `src/mcp-portal-interceptor.ts::forwardMcpPortal` | [Transport tests](../../src/__tests__/mcp-portal-interceptor.test.ts), [interception tests](../../src/__tests__/container/mcp-portal-interception.test.ts) |
| Lossless migration | [REQ-AGENT-217](../../sdd/spec/mcp.md#req-agent-217-lossless-pi-mcp-adapter-migration) | `preseed/agents/pi/extensions/00-mcp-adapter-config.ts::preparePiMcpAdapterConfig` | [Migration tests](../../host/__tests__/pi-mcp-adapter-config.test.js), [stdio tests](../../preseed/agents/pi/test/consult-proxy.test.mjs); [handoff procedure](#guarded-configuration-handoff) |

## Related Documentation

- [Configuration](configuration.md#mcp-portal-registration) — registration and saved settings.
- [API Reference](api-reference.md#admin) — authenticated endpoint contracts.
- [Agent Environment](preseed.md) — delivery and client preparation.
- [Security](security.md) — shared authorization and credential boundaries.
