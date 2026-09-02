# Enterprise Mode Domain Specification

Deploy-time enterprise configuration: single-tenant unlimited access, subscription bypass, and platform outbound-HTTPS interception that routes agent LLM traffic to a customer-owned AI Gateway with no credential ever placed in the container.

### Key Concepts

| Concept | Definition |
|---------|-----------|
| Enterprise Mode | A deploy-time configuration, toggled by the `ENTERPRISE_MODE` Worker var, that turns a Codeflare deployment into a single-tenant enterprise instance: every user resolves to the `unlimited` tier in Pro (advanced) session mode and subscription/billing is disabled |
| AI Gateway | The customer's Cloudflare AI Gateway endpoint that fronts the upstream LLM providers; its URL and token are held only in the Worker/interceptor env as secrets (`AIG_GATEWAY_URL`, `AIG_TOKEN`) |
| LLM Interceptor | A `WorkerEntrypoint` (`LlmInterceptor`) the container DO wires into container egress via `ctx.container.interceptOutboundHttps`; it receives the container's outbound HTTPS to the real provider hosts at the platform level (never the public internet, never Cloudflare Access), maps each onto the gateway provider path, and forwards with gateway auth + per-user attribution stamped on |
| Outbound Interception | The Cloudflare Containers platform mechanism (`interceptOutboundHttps` + `ctx.exports`) that routes a container's matching egress hostnames through a `WorkerEntrypoint` with no credential, URL, or token in the container |
| Per-User Attribution | The user's email passed to the interceptor as a per-session DO prop (sourced from `_userEmail` in the `llm` entry of the interception registry, falling back to the deterministic bucket id when absent) and stamped as `cf-aig-metadata.user` so the customer's gateway per-user analytics attribute usage to the real identity; every group the user matches from the configured user-access list is stamped alongside as a per-group `group_<sanitized>_<hash>=1` tag (the scalar `group` key is not used), within CF's 5-entry metadata cap (`user` + up to 4 groups, deterministic truncation in configured-list order), so the gateway can branch routing/cost/rate-limit policies per group. Unconfigured IdP memberships and separately configured admin-group memberships are not stamped. The `_<hash>` suffix is a deterministic djb2/base-36 hash of the original group name (`sanitizeGroupKey`), appended to every key so lossy `[a-z0-9_]` sanitization cannot collide two distinct groups (`Dev Team` and `dev-team` both sanitize to `dev_team`); a gateway equals-filter must target the full hashed key (e.g. `group_codeflare_admins_150f5d1`), not the bare name |
| JIT Provisioning | Auto-creation of an `unlimited` Codeflare user on first authenticated access in Enterprise Mode, keyed by the Cloudflare-Access-verified `email`; gated optionally by `ENTERPRISE_ACCESS_GROUP` membership (see [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning)) |
| Access get-identity | The Cloudflare Access endpoint `${iss}/cdn-cgi/access/get-identity`, called with the request's `CF_Authorization` token, returning the full identity (including IdP group membership) used to enforce `ENTERPRISE_ACCESS_GROUP` — the application JWT carries no group claim by default |
| `ENTERPRISE_ACCESS_GROUP` | Optional value set during the setup wizard and stored in KV (`SETUP_KEYS.ENTERPRISE_ACCESS_GROUP`), editable by re-running setup; names one or more **customer-managed** Cloudflare Access groups (comma/newline-separated) that gate Codeflare entry — a user in ANY configured group is admitted. Codeflare references them (via `get-identity`) but never creates or populates them — unlike the non-enterprise admin/user groups it manages itself. When set, JIT provisioning verifies membership and denies non-members; when unset, any user who clears Cloudflare Access is provisioned an account (the gate then lives entirely in the customer's Access application policy) |
| Strict Gateway Egress | An optional, enterprise-gated, default-OFF setup-wizard toggle (`SETUP_KEYS.STRICT_EGRESS`, `'active'`/`'inactive'`) that, when ON, forces the container's **direct-internet** HTTP/HTTPS (and WebSocket) egress through the Workers VPC `EGRESS` binding and from there the customer's Cloudflare (Zero Trust) Gateway. Only this deployment's own-account destinations (its R2 + account-scoped CF API / Browser Rendering) are exempt and egress direct; any other account's host rides the Gateway ([AD86](../../documentation/decisions/README.md#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network)). It fails closed (503 `EGRESS_UNAVAILABLE`) when the binding is unbound and is byte-identical to today when OFF ([REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress)) |
| EgressController | A `WorkerEntrypoint` the container DO wires as the catch-all (`interceptOutboundHttps('*', controller)`) when Strict Gateway Egress is ON. Account, bound bucket, bucket-scoped R2 credentials, and strict state arrive through Worker-side `ctx.props`, resolved once at wiring with no per-request KV read. A **transparent proxy** for every host except the bound bucket in this account's R2: it stamps no identity and preserves caller authorization and cookies, forwarding direct-internet hosts through `env.EGRESS.fetch` and this account's account-scoped CF API directly. Bound-bucket R2 requests have placeholder authorization stripped and are **re-signed** with that user's scoped key; another bucket is rejected. WebSocket upgrades are **bridged**, not returned as-is. Fails closed ([REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress)) |
| EGRESS binding | The Workers VPC `[[vpc_networks]]` Fetcher binding (`binding="EGRESS"`, `network_id="cf1:network"`) that routes egress through the customer's Cloudflare Gateway. Enterprise-only: committed **commented-out** in `wrangler.toml` and injected at deploy time by `deploy.yml` when `ENTERPRISE_MODE=active`, so on non-enterprise deploys `env.EGRESS` is undefined and Strict Gateway Egress is dormant (fail-closed) ([REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress)) |
| Workers VPC | The Cloudflare Workers VPC / Connectivity Directory capability that exposes a private network to a Worker as a Fetcher binding; the `EGRESS` binding's `cf1:network` is its Cloudflare Mesh network id ([REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress)) |
| Cloudflare Gateway | The customer's Zero Trust (Secure Web) Gateway that applies the account's existing egress traffic policies (allow/block/isolate/DLP) to traffic leaving over `cf1:network`. Strict Gateway Egress inherits these policies unchanged; codeflare never creates or modifies them ([REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress)) |

### Out of Scope

- **SSO / directory integration** -- Enterprise Mode does not add SAML, OIDC-for-end-users, SCIM, or any identity-provider integration beyond the deployment's existing auth mode.
- **Audit logging, SLA, and compliance tooling** -- No per-request audit trail, uptime guarantees, or compliance certifications are introduced by this domain.
- **Multi-team / multi-tenant org structures** -- An Enterprise Mode deployment is single-tenant; there is no team, org, or workspace hierarchy within one instance.
- **Per-user billing in Enterprise Mode** -- Billing is disabled wholesale when the flag is set; there is no enterprise invoicing, seat counting, or metered billing inside the product.
- **New agent types** -- Enterprise Mode narrows the existing agent roster; it does not add agents beyond the seven defined in [REQ-AGENT-001](agents.md#req-agent-001-support-multiple-ai-coding-agents).

### Domain Dependencies

| Domain | Dependency |
|--------|-----------|
| Subscription | When the flag is set, tier resolution short-circuits to `unlimited` and the subscribe/billing surfaces are disabled (see [REQ-SUB-001](subscription.md#req-sub-001-eight-tier-subscription-system), [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier)) |
| Agents | Session-mode resolution forces Pro mode and the agent roster is narrowed (see [REQ-AGENT-004](agents.md#req-agent-004-two-session-modes-standard-and-pro)); the container env pipeline emits only the `ENTERPRISE_MODE` flag (see [REQ-AGENT-031](agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity)), and entrypoint.sh points each agent at the constant provider base-URLs |
| Setup | `ENTERPRISE_MODE`, `AIG_GATEWAY_URL`, and `AIG_TOKEN` are configured at deploy time alongside the existing deployment-mode bindings (see [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes)) |
| Security | LLM traffic leaves the container only via platform interception to the interceptor `WorkerEntrypoint`; the gateway URL/token live solely in the interceptor env, never in the container, and the interception never traverses Cloudflare Access |

---

<a id="req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode"></a>
### REQ-ENTERPRISE-001: ENTERPRISE_MODE Forces Unlimited Tier and Pro Mode

**Intent:** A deploy-time `ENTERPRISE_MODE` flag must turn a deployment into a single-tenant enterprise instance where every user gets full access without subscription friction.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, every user's effective tier resolves to `unlimited` regardless of stored tier, billing status, or trial state. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/enterprise-mode.test.ts (REQ-ENTERPRISE-001 AC1: getEffectiveTier enterprise override) -->
2. When `ENTERPRISE_MODE` is set, session-mode resolution returns Pro (`advanced`) for every user regardless of the stored preference. <!-- @impl: src/lib/session-mode.ts::resolveSessionMode --> <!-- @impl: src/lib/session-mode.ts::withEffectiveSessionMode --> <!-- @test: src/__tests__/lib/session-mode.test.ts (resolveSessionMode / REQ-ENTERPRISE-001 AC2 (enterprise forces Pro regardless of the stored preference)) --> <!-- @test: src/__tests__/routes/preferences-enterprise.test.ts (AC2 (REQ-ENTERPRISE-001): GET returns sessionMode=advanced under enterprise with no stored preference) --> <!-- @test: src/__tests__/routes/container-lifecycle.test.ts (REQ-ENTERPRISE-001 AC2: enterprise start resolves sessionMode=advanced with no stored preference (JIT user)) -->
3. When `ENTERPRISE_MODE` is set, monthly Timekeeper quota enforcement is disabled. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (REQ-ENTERPRISE-001 AC3: enterprise users are never blocked by the monthly compute quota) -->
4. The flag is read from a single resolver; all callers consult the resolver rather than reading the raw binding. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode --> <!-- @manual: Search production source for raw ENTERPRISE_MODE reads and confirm only the resolver owns binding interpretation. -->
5. When `ENTERPRISE_MODE` is unset, tier resolution, session-mode resolution, and subscription enforcement are byte-identical to current behavior across the Default, Onboarding, and SaaS deployment modes. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode --> <!-- @test: src/__tests__/routes/preferences-enterprise.test.ts (Preferences Routes under ENTERPRISE_MODE / REQ-ENTERPRISE-001 + REQ-ENTERPRISE-003) -->
6. An enterprise user remains upgrade-pending until the bucket's agent configuration is successfully reconciled to Pro, including the initial reconciliation for a newly created bucket, after which the stored mode is marked Pro. <!-- @impl: src/routes/container/lifecycle-init.ts::ensureBucketAndSeed --> <!-- @impl: src/routes/session/lifecycle.ts::preseedNeedsUpgrade --> <!-- @impl: src/routes/storage/seed.ts::updatedPreferences --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-ENTERPRISE-001 AC6: enterprise upgrade reconcile for pre-existing users) --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (DEEP-18-007/008: a failed new-bucket reconcile leaves Pro unstamped for retry) --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (enterprise: returns preseedNeedsUpgrade true when stored sessionMode is not advanced despite matching hash) --> <!-- @test: src/__tests__/routes/storage-seed.test.ts (enterprise: reconciles as advanced and stamps sessionMode alongside lastPreseedHash) -->
7. If either initial or upgrade reconciliation fails, the preference is not stamped and the upgrade retries on the next trigger. <!-- @impl: src/routes/container/lifecycle-init.ts::ensureBucketAndSeed --> <!-- @impl: src/routes/storage/seed.ts::updatedPreferences --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (DEEP-18-007/008: a failed new-bucket reconcile leaves Pro unstamped for retry) --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (enterprise: a failed upgrade reconcile does NOT stamp the preference (retries next start) and the start still succeeds) --> <!-- @test: src/__tests__/routes/storage-seed.test.ts (enterprise: a failed reconcile returns 500 and does NOT stamp sessionMode or lastPreseedHash) -->

**Constraints:**

- The flag is read at deploy time from a Worker binding, not from request data, so it cannot be toggled per request.
- When the flag is unset there is no new code path: every enterprise branch is gated behind the resolver returning false.
- Successful enterprise upgrade stamps preserve the latest stored preference fields they do not own. <!-- @impl: src/routes/container/lifecycle-init.ts::ensureBucketAndSeed --> <!-- @impl: src/routes/storage/seed.ts::updatedPreferences --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-ENTERPRISE-001 constraint: enterprise upgrade preserves preferences changed while reconciliation is running) --> <!-- @test: src/__tests__/routes/storage-seed.test.ts (REQ-ENTERPRISE-001 constraint: enterprise reseed preserves preferences changed during reconciliation) -->
- Enterprise deployment-variable values, rollout, and rollback procedures are owned by the private [Enterprise deployment runbook](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/deployment/enterprise.md); this public specification records only runtime behavior.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](subscription.md#req-sub-001-eight-tier-subscription-system), [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier), [REQ-AGENT-004](agents.md#req-agent-004-two-session-modes-standard-and-pro)

**Verification:** Automated test ([enterprise-mode](../../src/__tests__/lib/enterprise-mode.test.ts))

**Status:** Implemented

---

### REQ-ENTERPRISE-002: Subscription UI Hidden and Subscribe Route Guarded

**Intent:** When the deployment is in Enterprise Mode there is no self-serve billing, so the subscription UI and the subscribe route must not be reachable.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, the subscription/billing settings surfaces (tier display, plan switching, usage-quota controls) are hidden in the frontend. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Header Component / REQ-VAULT-012 (vault button render and readiness gating) / REQ-AUTH-016 (header user dropdown)) -->
2. When `ENTERPRISE_MODE` is set, the `/app/subscribe` route is guarded so it does not render the tier-selection or checkout flow. <!-- @impl: web-ui/src/App.tsx::SubscribeGuard --> <!-- @test: web-ui/src/__tests__/components/enterprise-app-routing.test.tsx (REQ-ENTERPRISE-002 AC2: subscribe route guard) -->
3. The frontend determines whether to hide billing surfaces from a deploy-time mode signal, not from the user's tier. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode --> <!-- @test: src/__tests__/routes/user-profile-enterprise.test.ts (GET /api/user enterpriseMode flag / REQ-ENTERPRISE-002) -->
4. When `ENTERPRISE_MODE` is unset, the subscription UI and `/app/subscribe` behave byte-identically to current behavior. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode --> <!-- @test: src/__tests__/routes/user-profile-enterprise.test.ts (GET /api/user enterpriseMode flag / REQ-ENTERPRISE-002) -->

**Constraints:**

- Guarding the subscribe route must not break links from non-enterprise deployments; the guard is conditional on the resolver.
- Hiding the billing UI does not delete a user's stored tier; the field is retained and simply unused while the flag is set.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-SUB-016](subscription.md#req-sub-016-customer-portal-and-plan-switching), [REQ-SUB-017](subscription.md#req-sub-017-enterprise-tier-contact-flow)

**Verification:** Automated test ([Header subscription-hide](../../web-ui/src/__tests__/components/Header.test.tsx) (AC1 billing surfaces hidden in enterprise, AC4 shown in SaaS), [subscribe route guard](../../web-ui/src/__tests__/components/enterprise-app-routing.test.tsx) (AC2 `/app/subscribe` redirects to `/app/` in a non-SaaS/enterprise deployment), [API enterpriseMode flag](../../src/__tests__/routes/user-profile-enterprise.test.ts) (AC3 deploy-time signal, AC4 flag-off parity).)

**Status:** Implemented

---

### REQ-ENTERPRISE-003: Agent Allowlist in Enterprise Mode

**Intent:** Enterprise deployments standardize on a curated agent set: session creation and the session-start UI enforce the admin-selected active agents ([REQ-ENTERPRISE-025](#req-enterprise-025-active-coding-agents-configured-in-the-setup-wizard)) within a fixed gateway-capable universe.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, the selectable universe is capped at the enterprise-capable set `{copilot, pi, bash}`; session creation rejects any agent type outside it. <!-- @impl: src/lib/agent-allowlist.ts::ENTERPRISE_AGENTS --> <!-- @impl: src/lib/agent-allowlist.ts::allowedAgents --> <!-- @test: src/__tests__/routes/session-agent-allowlist.test.ts (AC1: agentType '%s' is rejected 400 when ENTERPRISE_MODE=active) -->
2. The wizard-selected active agents gate the selectable set: session creation and `lastAgentType` preference writes reject a deactivated coding agent, while active agents and the always-on `bash` stay accepted. <!-- @impl: src/lib/agent-allowlist.ts::allowedAgents --> <!-- @test: src/__tests__/routes/session-agent-allowlist.test.ts (AC2: a KV-deactivated coding agent is rejected 400) --> <!-- @test: src/__tests__/routes/preferences-enterprise.test.ts (AC2 (REQ-ENTERPRISE-003): a KV-deactivated lastAgentType is rejected 400 under enterprise) -->
3. A session created without an explicit `agentType` is stamped with the first active coding agent, so the container's `claude-code` fallback never applies in enterprise mode. <!-- @impl: src/routes/session/crud.ts::CreateSessionBody --> <!-- @test: src/__tests__/routes/session-agent-allowlist.test.ts (AC3: an omitted agentType is stamped with the first active coding agent) -->
4. The session-creation UI offers exactly the active agents delivered by `GET /api/user` on every creation surface (CreateSession dialog and GitHub clone picker). <!-- @impl: web-ui/src/components/CreateSessionDialog.tsx::CreateSessionDialog --> <!-- @impl: web-ui/src/components/github/ClonePickerNewSession.tsx::ClonePickerNewSession --> <!-- @impl: web-ui/src/lib/schemas.ts::UserResponseSchema --> <!-- @test: web-ui/src/__tests__/components/CreateSessionDialog.test.tsx (renders only the wizard-activated agents delivered by /api/user) --> <!-- @test: web-ui/src/__tests__/components/ClonePicker.test.tsx (renders only the wizard-activated agents delivered by /api/user in enterprise mode) --> <!-- @test: src/__tests__/routes/user-profile-enterprise.test.ts (enterprise: allowedAgents reflects the wizard-selected active agents plus bash) -->
5. An absent, malformed, or capable-agent-free stored selection resolves to the full enterprise-capable set, preserving pre-feature behavior for existing deployments. <!-- @impl: src/lib/agent-allowlist.ts::readActiveAgents --> <!-- @test: src/__tests__/routes/session-agent-allowlist.test.ts (AC5: a malformed stored selection resolves to the full enterprise set) -->
6. When `ENTERPRISE_MODE` and build-agent selection are unset, all seven agent types from [REQ-AGENT-001](agents.md#req-agent-001-support-multiple-ai-coding-agents) remain selectable. <!-- @impl: src/types.ts::AgentTypeSchema --> <!-- @impl: src/lib/agent-allowlist.ts::installedAgents --> <!-- @test: src/__tests__/routes/session-agent-allowlist.test.ts (flag-off: agentType '%s' is accepted 201 when ENTERPRISE_MODE unset) -->
7. When `ENTERPRISE_MODE` is unset, the stored active-agent selection is ignored. <!-- @impl: src/lib/agent-allowlist.ts::allowedAgents --> <!-- @test: src/__tests__/routes/session-agent-allowlist.test.ts (AC7: the KV selection is ignored outside enterprise mode) -->

**Constraints:**

- The wizard-configured selection narrows the enterprise-capable universe; it can never widen it.
- Only OpenAI-wire-format agents plus `bash` are capable, per [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway); Claude Code stays excluded ([AD74](../../documentation/decisions/README.md)).
- `bash` is always selectable (it needs no LLM).
- Existing sessions remain active after wizard deactivation while their CLI remains installed; later images without that CLI reject start.
- This is selection-level standardization, not a container boundary: a wizard-deactivated agent's CLI remains manually invocable from a bash tab when the build includes it.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-025](#req-enterprise-025-active-coding-agents-configured-in-the-setup-wizard), [REQ-AGENT-001](agents.md#req-agent-001-support-multiple-ai-coding-agents), [REQ-AGENT-002](agents.md#req-agent-002-agent-selection-at-session-creation)

**Verification:** Automated test ([session-agent-allowlist](../../src/__tests__/routes/session-agent-allowlist.test.ts))

**Status:** Implemented

---

### REQ-ENTERPRISE-004: Outbound-Interception LLM Routing to Customer AI Gateway

**Intent:** Enterprise deployments route all agent LLM traffic to the customer's AI Gateway via platform outbound-HTTPS interception, so the gateway credentials never reach the container, nothing is exposed over a public route, and all usage is attributable.

**Applies To:** User

**Acceptance Criteria:**

1. The container DO routes outbound HTTPS for the real LLM provider host (`api.openai.com`) through a session-bound Worker interceptor. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-004: compat fallback on REST 404 (dual transport — AD74 amendment)) -->
2. Gateway URL and token resolve Worker-side from wizard KV before deploy secrets and pass through session props; the interceptor falls back to its env per missing prop. Neither credential enters the container or a public Worker route. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-017: AI Gateway URL/token resolved from props (wizard) with env fallback) -->
3. Streaming responses are preserved end-to-end. A streamed chat-completions response whose terminal `finish_reason` chunk is missing as the AI Gateway dynamic-route wrapper omits it on the wire. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-004: streaming terminator repair (AC3 — dynamic-route finish_reason fix)) -->
4. Forwarded requests stamp gateway ID plus user email or bucket fallback; up to four matched groups become deterministic metadata tags, and the session's first configured matching group controls route restrictions. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @impl: src/lib/access.ts::resolveRouteCatalog --> <!-- @impl: src/lib/access.ts::resolveSessionAccessGroup --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
5. The container's placeholder credential (`Authorization` / `x-api-key`) is stripped before forwarding so it never reaches the gateway; gateway auth is stamped separately. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-004: placeholder-auth stripping) -->
6. The interceptor maps only the known provider host (`api.openai.com`); an unmapped host (including `api.anthropic.com`, which is not an enterprise agent host) fails closed (400) and an unconfigured/unparseable gateway fails closed (503) — neither forwards anywhere. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-004 / REQ-ENTERPRISE-006 AC4: fail-closed guards) -->
7. When `ENTERPRISE_MODE` is unset, the DO never wires interception, the interceptor is never instantiated, and agent LLM traffic follows the current direct-key path, byte-identical to current behavior. <!-- @impl: src/container/index.ts::startAndWaitForPorts --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-016 / AD86: AI Gateway is platform-native — always direct egress, never cf1:network) -->

**Constraints:**

- Interception uses `interceptOutboundHttps` with `ctx.exports` and requires container trust in the platform CA ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls)).
- Provider hosts are fixed in code; request parameters cannot add one.
- REST transport maps the provider path under `/ai`; model-route 404s replay through compat with its authorization header after stripping unsupported `store` and `prompt_cache_key` fields.
- Metadata is capped at user plus four configured-order group tags; excess groups produce a warning.
- AI Gateway always egresses directly, never through strict `cf1:network` egress.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var)

**Verification:** Automated test ([llm-interceptor](../../src/__tests__/llm-interceptor.test.ts))

**Status:** Implemented

---

### REQ-ENTERPRISE-005: Container-Side Enterprise Routing (CA Trust + Constant Base-URLs)

**Intent:** Agents in Enterprise Mode must be work-ready against the AI Gateway with zero manual login and zero injected credentials, so the container only learns it is in enterprise mode and configures itself to use the intercepted provider hosts.

**Applies To:** User

**Acceptance Criteria:**

1. Enterprise containers receive the active flag plus configured non-secret catalog, default, reasoning, and context-window hints resolved from the session's first matching group or global fallback; gateway coordinates, credentials, and resolved model IDs remain absent. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (REQ-ENTERPRISE-005: enterprise env injection (flag-on emit)) -->
2. When `ENTERPRISE_MODE=active`, the Cloudflare containers CA is installed into the system trust store and the Node/Python CA env vars are prepended to `.bashrc` so the PTY-spawned agent shells inherit them and all agent HTTPS clients trust the intercepted (TLS-terminated) connections. <!-- @impl: entrypoint.sh::CF_OAUTH_CA_SRC --> <!-- @test: host/__tests__/entrypoint-enterprise-ca-copilot.test.js (REQ-ENTERPRISE-005 AC2: NODE_EXTRA_CA_CERTS in .bashrc points at the CF_CA_SRC path) -->
3. Enterprise Copilot receives persistent-shell BYOK base URL, placeholder, default route, and prompt/output limits; startup overwrites stale defaults. It exposes only the default dynamic route, which maps on egress, and route changes require relaunch. <!-- @impl: entrypoint.sh::_merge_consult_llm_mcp --> <!-- @test: host/__tests__/entrypoint-enterprise-ca-copilot.test.js (REQ-ENTERPRISE-005 AC3: COPILOT_MODEL in .bashrc equals the ENTERPRISE_DEFAULT_ROUTE value) -->
4. When `ENTERPRISE_MODE=active`, Pi is configured with a custom provider entry pointing at `api.openai.com` using the `openai-completions` adapter. <!-- @impl: entrypoint.sh::configure_consult_llm --> <!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (builds models.json with one model per catalog route under set -euo pipefail) -->
5. The container never receives the AI Gateway URL, the gateway token, or any per-session secret; routing to the gateway is done entirely by the DO's outbound interception ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)). <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (REQ-ENTERPRISE-005: enterprise env injection (flag-on emit)) -->
6. When `ENTERPRISE_MODE` is unset, `ENTERPRISE_MODE` is not emitted, no agent configuration block runs, and the container env is byte-identical to current behavior. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (REQ-ENTERPRISE-005: enterprise env injection (flag-on emit)) -->
7. AWS credentials are absent in every mode. Enterprise keeps R2 credentials and only the Browser Rendering placeholder/account, excludes deploy tokens, and clears Pi provider auth each start; non-enterprise retains real Cloudflare credentials and populated provider auth. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (container secret hygiene: no AWS_* anywhere, CF token placeholder-only in enterprise) -->

**Constraints:**

- The placeholder credential is a fixed non-secret constant; the interceptor strips it before forwarding ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC5), so it never reaches the gateway.
- `ENTERPRISE_MODE` rides the existing container env pipeline ([REQ-AGENT-031](agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity)); no per-agent login step is added.
- Route catalog, default, and reasoning values are non-secret container hints; slash-free handles map Worker-side, and backend keys remain in the gateway.
- Only the allowlisted enterprise agents ([REQ-ENTERPRISE-003](#req-enterprise-003-agent-allowlist-in-enterprise-mode)) are configured; `bash` needs no LLM configuration.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning), [REQ-AGENT-031](agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity)

**Verification:** Automated test ([env-pipeline test](../../src/__tests__/container/container-env-llm.test.ts) (AC1/AC5/AC6 env injection; AC7 secret hygiene — no AWS_* in either mode, enterprise CLOUDFLARE_API_TOKEN placeholder-only); [Pi models.json build test](../../host/__tests__/entrypoint-enterprise-pi-models.test.js) (AC4 — one model per catalog route + per-route contextWindow, empty-catalog fallback, reserved-keyword jq guard; AC7 — auth.json cleared to {}); [entrypoint CA-trust + Copilot BYOK test](../../host/__tests__/entrypoint-enterprise-ca-copilot.test.js) (AC2 — CA env prepended to .bashrc, idempotent, enterprise-gated; AC3 — Copilot BYOK vars + token-limit hints prepended, stale route overwritten on re-run, enterprise-gated). All acceptance criteria are covered by automated tests.)

**Status:** Implemented

---

<a id="req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var"></a>
### REQ-ENTERPRISE-006: Deploy-Time AIG Secrets and ENTERPRISE_MODE Var

**Intent:** Enterprise configuration must be supplied at deploy time through Worker bindings, kept secret where appropriate, and default to off.

**Applies To:** Admin

**Acceptance Criteria:**

1. `AIG_GATEWAY_URL` and `AIG_TOKEN` may be configured as Worker secrets so they are not stored in plaintext config or exposed to the container. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @manual: Inspect the deployed Worker bindings and a running container environment; confirm the values are secret bindings and absent from the container. -->
2. Enterprise mode is a non-secret deployment setting; dynamic route catalog and default remain wizard-managed KV configuration. <!-- @impl: wrangler.toml::binding --> <!-- @manual -->
3. Enterprise Mode is off by default: an absent or empty `ENTERPRISE_MODE` binding resolves to disabled. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode --> <!-- @test: src/__tests__/lib/enterprise-mode.test.ts (REQ-ENTERPRISE-001 AC1 / REQ-ENTERPRISE-006 AC3: isEnterpriseMode) -->
4. When `ENTERPRISE_MODE` is enabled, the interceptor fails closed (503) if the resolved AI Gateway URL (wizard KV or deploy-secret fallback, [REQ-ENTERPRISE-017](#req-enterprise-017-ai-gateway-configured-in-the-setup-wizard)) is missing or unparseable (no `/v1/{account_id}/{gateway_id}` segments). <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-017: AI Gateway URL/token resolved from props (wizard) with env fallback) --> <!-- @impl: src/container/container-interception.ts::llm -->
5. When `ENTERPRISE_MODE` is configured, the CF Access application created by the setup wizard is host-scoped (bare custom domain, no path suffix) so the session cookie covers all paths uniformly; non-enterprise deployments retain the path-scoped (`/app/*`) application. <!-- @impl: src/routes/setup/access.ts::handleCreateAccessApp --> <!-- @test: src/__tests__/routes/setup/access.test.ts (enterprise mode creates a host-scoped app (bare host domain + whole-host destination)) -->
6. Enterprise setup best-effort provisions a higher-priority public service-worker bypass. It never aborts host setup, stores the app ID only after policy success, and rolls back a new app on policy failure; non-enterprise creates none. <!-- @impl: src/routes/setup/access.ts::handleCreateAccessApp --> <!-- @test: src/__tests__/routes/setup/access.test.ts (Setup Access) -->
7. The deployment workflow exposes `enterprise` and `enterprise integration` as manual-dispatch environments deployable from any branch, separate from production and integration. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @manual -->

**Constraints:**

- The enterprise flag is evaluated from deploy-time bindings, consistent with [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes).
- Container env receives only the enterprise flag and non-secret route hints derived from Worker config, never session state; gateway URL, token, account ID, and resolved route remain Worker-only.
- The resolved AI Gateway URL uses wizard KV before the deploy-secret fallback and is the single source for account and gateway coordinates, so no separate account-ID binding is required.
- The Workers VPC `EGRESS` binding is enterprise-only, committed disabled, and injected at deploy only when enterprise mode is active; default, fork, and test deployments remain unaffected.
- A missing `EGRESS` binding fails strict egress closed; non-enterprise and toggle-off deployments remain inert.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ENTERPRISE-007: Gateway Route-Pinning

**Intent:** The gateway route must be selected Worker-side from the Setup-configured catalog so agents carry only a slash-free model handle, eliminating agent-side model-string parsing (e.g. Pi reading a `dynamic/<route>` slash as `provider/model`) that would misroute traffic away from the interceptor.

**Applies To:** User

**Acceptance Criteria:**

1. On model-routable requests, catalog handles map to `dynamic/<route>`; unknown or pre-prefixed handles re-resolve to the configured default when valid, otherwise the first catalog entry. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (Feature C: catalog-driven dynamic-route mapping (replaces AIG_LANGUAGE_MODEL)) -->
2. When the catalog is empty, or the body is non-JSON, has no `model` field, or the path is not model-routable, the request body is forwarded unchanged. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (Feature C: catalog-driven dynamic-route mapping (replaces AIG_LANGUAGE_MODEL)) -->

**Constraints:**

- The route catalog and default live in KV; slash-free handles reach agents, while gateway routes resolve Worker-side ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-012](#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list)).
- Only the request `model` field is rewritten; no other request field and no response byte is altered.
- Route mapping runs only when interception is active ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)); when `ENTERPRISE_MODE` is unset the interceptor is never instantiated.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var)

**Verification:** Automated test ([llm-interceptor](../../src/__tests__/llm-interceptor.test.ts))

**Status:** Implemented

---

### REQ-ENTERPRISE-008: Enterprise Frontend Surface Suppression

**Intent:** Each deployment shows only applicable billing, quota, routing, and user-administration surfaces.

**Applies To:** User

**Acceptance Criteria:**

1. The "Manage Subscriptions" entry in Settings → Administration renders only in SaaS mode. <!-- @impl: web-ui/src/components/SettingsPanel.tsx::SettingsPanel --> <!-- @test: web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx (REQ-ENTERPRISE-008 AC1-AC2 and REQ-SETUP-026 AC1-AC2: SettingsPanel and session mode) -->
2. The Standard/Pro session-mode selector renders only in SaaS mode; in enterprise every user is implicitly Pro (advanced) per [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC2, and onboarding/default deployments have no Standard/Pro plans. <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx (REQ-ENTERPRISE-008 AC2: SessionSection mode selector) -->
3. The monthly-quota warning banners and their "Upgrade" calls-to-action render only in SaaS mode. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/enterprise-layout-suppression.test.tsx (REQ-ENTERPRISE-008 AC3: quota banners render only in SaaS mode) -->
4. In enterprise mode, a first-time auto-provisioned user is routed to the application home instead of `/app/subscribe` or the self-serve onboarding/waitlist flow. <!-- @impl: web-ui/src/App.tsx::App --> <!-- @test: web-ui/src/__tests__/components/enterprise-app-routing.test.tsx (REQ-ENTERPRISE-008 AC4: enterprise first-login routing) -->

**Constraints:**

- Billing, quota, and session-mode surfaces depend on SaaS mode.
- Administrator user-management availability depends on enterprise mode ([REQ-ENTERPRISE-015](#req-enterprise-015-enterprise-setup-user-administration-suppression)).
- Routing availability depends on enterprise mode.
- Deployment-mode gates never depend on user tier.
- Workspace Administration entry visibility is role-gated by [REQ-SETUP-026](setup.md#req-setup-026-workspace-administration-entry).
- Personal usage data and account actions are governed separately by [REQ-SUB-022](subscription.md#req-sub-022-cross-mode-personal-usage-data) and [REQ-SUB-023](subscription.md#req-sub-023-deployment-mode-account-actions).
- `GET /api/user` exposes both signals to `sessionStore`; `GET /api/auth/status` also exposes `saasMode` for `SubscribeGuard`.
- Suppression is render-gating only: it removes no component code path for non-enterprise deployments and deletes no stored user state.
- Visibility only: this REQ adds the client `SubscribeGuard` saasMode redirect plus the subscription, mode-selector, quota-banner, and first-login-routing surfaces; the matching routes are made unreachable server-side in [REQ-ENTERPRISE-009](#req-enterprise-009-enterprise-backend-route-hardening).

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-002](#req-enterprise-002-subscription-ui-hidden-and-subscribe-route-guarded), [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning), [REQ-SUB-023](subscription.md#req-sub-023-deployment-mode-account-actions)

**Verification:** Automated tests ([enterprise-surface-suppression](../../web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx), [enterprise-layout-suppression.test.tsx](../../web-ui/src/__tests__/components/enterprise-layout-suppression.test.tsx), and [enterprise-app-routing.test.tsx](../../web-ui/src/__tests__/components/enterprise-app-routing.test.tsx))

**Status:** Implemented

---

### REQ-ENTERPRISE-009: Enterprise Backend Route Hardening

**Intent:** Hiding a SaaS or admin surface in the frontend is not sufficient; in Enterprise Mode the corresponding routes must fail closed so the disabled capabilities cannot be reached by direct API call, URL manipulation, or a stray external event.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, the user-management routes (`GET`/`PUT`/`DELETE`/`PATCH` under `/api/users`) return 403 and perform no mutation; user administration is delegated entirely to Cloudflare Access. <!-- @impl: src/routes/users.ts::app --> <!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (REQ-ENTERPRISE-009 AC1: /api/users fails closed in enterprise mode) -->
2. In enterprise mode, the billing action routes (`POST /api/billing/checkout`, `/api/billing/portal`, `/api/billing/switch`) return 403 before their route-specific limiters, and `GET /api/billing/status` returns an empty/disabled billing state without contacting Stripe. <!-- @impl: src/routes/billing.ts::default --> <!-- @test: src/__tests__/routes/billing.test.ts (DEEP-22-004: enterprise billing guards precede action limiters) -->
3. In enterprise mode, the self-serve routes `POST /api/auth/subscribe` and `POST /api/auth/request-access` return 403 before their route-specific limiters and send no email. <!-- @impl: src/routes/auth.ts::default --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (DEEP-22-005: SaaS subscribe requests remain rate-limited) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (DEEP-22-005: enterprise subscribe guard remains 403 after the SaaS limiter budget) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (DEEP-22-005: enterprise request-access guard runs before its fail-closed limiter) -->
4. In enterprise mode, the Stripe webhook route acknowledges the event before the SaaS limiter without mutating any user's tier or billing state, so a late or stray Stripe event cannot downgrade an enterprise user. <!-- @impl: src/routes/stripe-webhook.ts::default --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (DEEP-22-006: enterprise webhook acknowledgement precedes limiter) -->
5. When `ENTERPRISE_MODE` is set, the admin tier/subscription configuration routes return 403 (there is a single effective tier, `unlimited`, for all users). <!-- @impl: src/routes/admin/tiers.ts::isEnterpriseMode --> <!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (REQ-ENTERPRISE-009 AC5: admin tier config routes 403 in enterprise mode) -->
6. When `ENTERPRISE_MODE` is set, `PATCH /api/preferences` is **not** fail-closed: the SaaS advanced-mode entitlement gate is bypassed so any user may select Pro, and the effective session mode is forced to Pro regardless of the stored value. <!-- @impl: src/lib/session-mode.ts::clampSessionModeToTier --> <!-- @impl: src/lib/session-mode.ts::resolveSessionMode --> <!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (REQ-ENTERPRISE-009 AC6: PATCH /api/preferences is not fail-closed in enterprise mode) --> <!-- @test: src/__tests__/routes/preferences-enterprise.test.ts (AC2 (REQ-ENTERPRISE-001): PATCH response reports advanced under enterprise while persisting the raw preference) -->
7. When `ENTERPRISE_MODE` is unset, every route above behaves byte-identically to current behavior. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode --> <!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (REQ-ENTERPRISE-009 AC7: flag unset is byte-identical to current behavior) -->

**Constraints:**

- All guards consult the single `isEnterpriseMode(env)` resolver ([REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC4); no route reads the raw binding.
- Action endpoints fail closed with 403; the read-only billing-status endpoint returns an empty state (200) so non-enterprise clients that still poll it do not error.
- These guards are defense-in-depth behind the frontend suppression in [REQ-ENTERPRISE-008](#req-enterprise-008-enterprise-frontend-surface-suppression); neither layer alone is sufficient.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-002](#req-enterprise-002-subscription-ui-hidden-and-subscribe-route-guarded), [REQ-ENTERPRISE-008](#req-enterprise-008-enterprise-frontend-surface-suppression)

**Verification:** Automated test ([enterprise-route-hardening](../../src/__tests__/routes/enterprise-route-hardening.test.ts))

**Status:** Implemented

---

### REQ-ENTERPRISE-010: Access-Gated JIT User Provisioning

**Intent:** In Enterprise Mode users are managed by the customer's Cloudflare Access, not inside Codeflare, so any Access-authenticated user entitled to the deployment must be provisioned automatically on first access — a fresh user lands work-ready with no in-product allowlisting or approval step.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set and an authenticated request presents a valid Cloudflare Access JWT for an `email` with no existing user record, Codeflare auto-creates a record `{ addedBy: 'enterprise-jit', role: 'user', accessTier: 'advanced', subscriptionTier: 'unlimited' }` keyed by the JWT's IdP-verified `email`. <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser --> <!-- @impl: src/lib/jwt.ts::verifyAccessJWT --> <!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning) -->
2. Configured Access groups gate provisioning before record creation; users outside every allowed group receive the standard denial. <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser --> <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning) -->
3. When `ENTERPRISE_ACCESS_GROUP` is unset, a valid Access JWT alone is sufficient to provision; the group gate is delegated to the customer's Access application policy. <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser --> <!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning) -->
4. Provisioning is idempotent: concurrent first-logins converge on a single record, and an existing record — whether a setup admin or a prior JIT user — is returned unchanged (JIT never overwrites a role or downgrades an admin). <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser --> <!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning) -->
5. Enterprise JIT sends no welcome or subscription email; the per-user R2 bucket and scoped token continue to be created lazily on first session start, unchanged. <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser --> <!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning) -->
6. When `ENTERPRISE_MODE` is unset, an Access-authenticated user with no record still receives 403 with no auto-provisioning, and the authentication path is byte-identical to current behavior. <!-- @impl: src/lib/access.ts::authenticateRequest --> <!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning) -->

**Constraints:**

- Codeflare trusts a valid Access JWT as proof that the customer's Access policy authorized the user; it does not re-implement IdP authentication.
- `ENTERPRISE_ACCESS_GROUP` is configured during the setup wizard and stored in KV, alongside the existing setup Access config, so an admin changes it by re-running setup.
- The account key is the IdP-verified `email`; the JWT `sub` is stored for reference; An email change at the IdP yields a new account (consistent with the existing SaaS JIT behavior).
- The group check runs once at provisioning; the resulting record is the cache, so steady-state requests incur no `get-identity` call.
- This REQ uses only the deployment's existing Cloudflare Access auth mode; it adds no new identity-provider integration (consistent with this domain's Out of Scope).

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var), [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes)

**Verification:** Automated test ([enterprise-jit-provisioning](../../src/__tests__/lib/enterprise-jit-provisioning.test.ts))

**Status:** Implemented

---

### REQ-ENTERPRISE-011: Container Start Interception Ordering

**Intent:** Enterprise LLM interception must be wired before the container boots, so the ephemeral Cloudflare containers CA exists when the container entrypoint installs it into the trust store; wiring it after boot makes the intercepted TLS handshake fail and no agent can reach the gateway.

**Applies To:** User

**Acceptance Criteria:**

1. Interception is registered before container start so the platform CA mounts before entrypoint installs trust; post-boot wiring would make intercepted TLS fail. <!-- @impl: src/container/index.ts::startAndWaitForPorts --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
2. Outside enterprise mode, enterprise LLM, GitHub, and strict-egress interception is not registered. Independently specified non-enterprise Cloudflare OAuth interception may still run. <!-- @impl: src/container/container-interception.ts::wireContainerInterception --> <!-- @test: src/__tests__/container/enterprise-llm.test.ts (enterprise LLM interception wiring (REQ-ENTERPRISE-011)) -->
3. Enterprise LLM provider hosts are always registered before startup, including when Gateway configuration is missing; missing or malformed configuration fails requests with 503, while a mandatory LLM registration exception aborts startup. <!-- @impl: src/container/container-interception.ts::llm --> <!-- @impl: src/container/container-interception.ts::applyInterception --> <!-- @test: src/__tests__/container/enterprise-llm.test.ts (enterprise LLM interception wiring (REQ-ENTERPRISE-011)) -->

**Constraints:**

- Wiring runs on the start chokepoint that all start paths funnel through (explicit start + container-fetch auto-start), before the SDK boots the container.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls)

**Verification:** Automated test ([index](../../src/__tests__/container/index.test.ts))

**Status:** Implemented

---

### REQ-ENTERPRISE-012: Setup-Configured Dynamic-Route Catalog and Access-Group List

**Intent:** An enterprise admin must manage an unlimited set of Cloudflare Access groups and an unlimited set of gateway dynamic routes from the setup wizard with no redeploy — the same way admin users are managed — so adding a team or a route is a wizard edit, not a code or deploy-var change.

**Applies To:** Admin

**Acceptance Criteria:**

1. Existing setup configure saves chip-list access groups and routes without a new endpoint. Names are trimmed, 1–256 characters, allow spaces, and reject commas, carriage returns, or line feeds; groups use lossless joined storage and prefill returns the trimmed values. <!-- @impl: src/routes/setup/index.ts::ConfigureBodySchema --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (rejects a group containing %s before setup starts) --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (round-trips trimmed access-group values through prefill) -->
2. The JSON route catalog defaults to its first entry with reasoning off; configured defaults must belong or return 400. Optional per-group route/default/reasoning maps persist separately. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
3. `GET /api/setup/prefill` round-trips the stored groups, catalog, and default route so a setup re-run shows the current configuration; a malformed stored value degrades to empty defaults rather than failing the prefill. <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (GET /prefill degrades to empty defaults when stored route JSON is malformed) -->
4. One route configuration supplies interception, container routing, JIT access, group metadata, and per-group editing ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning), [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning), [REQ-ENTERPRISE-013](#req-enterprise-013-per-group-dynamic-routing)). <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (loadEnterpriseRouteConfig per-group routing (REQ-ENTERPRISE-013)) -->
5. When `ENTERPRISE_MODE` is unset, the dynamic-route catalog UI and KV reads add no behavior; the access-group field already existed and is unchanged for non-enterprise deployments. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (GET /prefill omits the enterprise extras when ENTERPRISE_MODE is unset (regression)) -->
6. In enterprise mode, the AI-routing stage blocks "Continue" until at least one dynamic route, a Gateway URL, and a saved or newly entered Gateway token are present. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (blocks AI-routing Continue when route, Gateway URL, or token is missing (REQ-ENTERPRISE-012 AC6)) --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (enables AI-routing Continue once route, Gateway URL, and token exist (REQ-ENTERPRISE-012 AC6)) -->
7. `POST /api/setup/configure` rejects empty or absent `dynamicRoutes` with `400` before any KV write. The interceptor's empty-catalog passthrough ([REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning) AC2) is defensive only. <!-- @impl: src/routes/setup/index.ts::app --> <!-- @test: src/__tests__/routes/setup.test.ts (POST /api/setup/configure) -->

**Constraints:**

- No new persistence layer or endpoint: the lists ride the existing setup wizard configure flow and KV (`SETUP_KEYS`), consistent with how `ENTERPRISE_ACCESS_GROUP` was already stored ([REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning)).
- Access groups are stored comma/newline-joined (back-compat with the prior single-value config) and routes as a JSON array; the comma/newline ban on names keeps the joined encoding lossless.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning), [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning)

**Verification:** Automated test ([Setup configure tests](../../src/__tests__/routes/setup.test.ts), [prefill tests](../../src/__tests__/routes/setup/handlers.test.ts), [route-config resolver tests](../../src/__tests__/lib/enterprise-route-config.test.ts), [access-group parsing](../../src/__tests__/lib/access-group-resolution.test.ts), [setup store](../../web-ui/src/__tests__/stores/setup.test.ts), [ConfigureStep](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx))

**Status:** Implemented

---

### REQ-ENTERPRISE-022: Per-Route Context Windows for Dynamic Routes

**Intent:** An enterprise admin can set a context window per dynamic route so routed agents advertise each model route's usable window without redeploying.

**Applies To:** Admin

**Acceptance Criteria:**

1. The wizard shows a **context window** number input for each dynamic route, prefilled with `DEFAULT_ROUTE_CONTEXT_WINDOW` (`256000`), that the admin can raise or reset to the default. Adding a route seeds its window to the default; removing a route drops its entry. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (Setup Store) -->

**Constraints:**

- Route context windows stay keyed by configured route.
- Each value is a positive integer; missing entries back-fill the default route context window.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-012](#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls)

**Verification:** Automated test ([Setup configure tests](../../src/__tests__/routes/setup-enterprise-groups.test.ts), [prefill tests](../../src/__tests__/routes/setup/handlers.test.ts), [setup store](../../web-ui/src/__tests__/stores/setup.test.ts), [ConfigureStep](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx), [container env fan](../../src/__tests__/container/container-env-llm.test.ts), and [entrypoint Pi models](../../host/__tests__/entrypoint-enterprise-pi-models.test.js).)

**Status:** Implemented

---

### REQ-ENTERPRISE-013: Per-group dynamic routing

**Intent:** An enterprise admin can scope the dynamic-route catalog per Cloudflare Access group — which routes a group's members may use, and the group's default route + reasoning — so different teams get different model access from one deployment, while a deployment with no per-group config behaves exactly as the global catalog does today.

**Applies To:** Admin

**Acceptance Criteria:**

1. With no per-group routing configured, behavior is unchanged: every session resolves the global `DYNAMIC_ROUTES` catalog and `DEFAULT_ROUTE`. <!-- @impl: src/lib/access.ts::resolveRouteCatalog --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (loadEnterpriseRouteConfig per-group routing (REQ-ENTERPRISE-013)) -->
2. A session uses its first matched group with non-empty routing configuration; otherwise it falls back to the global catalog. <!-- @impl: src/lib/access.ts::resolveRouteCatalog --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (loadEnterpriseRouteConfig per-group routing (REQ-ENTERPRISE-013)) -->
3. Setup stores per-group route maps, rejects unknown groups, out-of-catalog routes, or defaults outside their group routes with 400, and deletes empty maps. <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
4. Both routing sinks — the LLM interceptor's per-request route enforcement ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC4) and the container env fan ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC1) — read the same group-aware route catalog, so they cannot drift; the existing default-drift rule is preserved. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (loadEnterpriseRouteConfig per-group routing (REQ-ENTERPRISE-013)) -->
5. The Setup wizard renders one per-group routing card per Access group (only when ≥1 group and ≥1 route exist): toggleable route **pills** (selected = green, deselected = gray). <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (ConfigureStep) -->
6. All reads/writes are inside the existing `ENTERPRISE_MODE` gate; in non-enterprise modes the Setup request/response shape and route resolution are byte-identical to before. <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) --> <!-- @manual -->

**Constraints:**

- A user matching several configured groups is resolved deterministically by first match in the admin's configured group-list order (not by union or by most-permissive).
- The global catalog remains the universe of routes; a group can only narrow it, never add a route outside it.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning), [REQ-ENTERPRISE-012](#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ENTERPRISE-014: Admin access via Cloudflare Access groups

**Intent:** An enterprise admin can grant admin (= Setup / user-administration) access to members of one or more named Cloudflare Access groups, parallel to the email-based admin list, so admin rights track the customer's directory instead of a hand-maintained email list. Admin groups govern administration only — they never participate in per-group model routing.

**Applies To:** Admin

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set and admin Access groups are configured, a non-admin user who belongs to **any** configured admin group is elevated to `admin` for the request, granting access to admin-gated routes. <!-- @impl: src/middleware/auth.ts::requireAdmin --> <!-- @impl: src/lib/access.ts::resolveAdminAccessGroup --> <!-- @test: src/__tests__/middleware/auth.test.ts (Auth Middleware) -->
2. A non-admin user who is in none of the configured admin groups still receives `403` from admin-gated routes. <!-- @impl: src/middleware/auth.ts::requireAdmin --> <!-- @test: src/__tests__/middleware/auth.test.ts (requireAdmin — enterprise admin-by-group (REQ-ENTERPRISE-014)) -->
3. Admin-group checks run only on admin-gated paths and short-circuit for users already resolved as administrators. <!-- @impl: src/lib/access.ts::resolveAdminAccessGroup --> <!-- @test: src/__tests__/middleware/auth.test.ts (Auth Middleware) -->
4. An active user-access gate admits members of either user or admin groups. Admin groups alone never arm the gate, so entry remains open without configured user groups. <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser --> <!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning) -->
5. Admin groups persist as comma-joined setup state, saved through `POST /api/setup/configure`; an empty list deletes the key. They are excluded from per-group routing by construction — only `ENTERPRISE_ACCESS_GROUP` keys may carry a `GROUP_ROUTING` entry. <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
6. Setup renders optional admin-group chips beside unchanged email admins, round-trips them through prefill, and excludes them from per-group routing cards. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (Setup Store) -->
7. All reads/writes are inside the existing `ENTERPRISE_MODE` gate; in non-enterprise modes the Setup request/response shape and admin authorization are byte-identical to before. <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) --> <!-- @manual -->

**Constraints:**

- Elevation is per-request and lives only on the Hono context; no KV `role:'admin'` record is written for a group-admin (so revocation is immediate and leaves no residue); The email-based admin list remains the durable admin source.
- The live get-identity check fails CLOSED (treated as non-member) on any missing token, non-`*.cloudflareaccess.com` domain, or fetch error — an admin gate must never elevate on uncertainty.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning), [REQ-ENTERPRISE-012](#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ENTERPRISE-015: Enterprise Setup User-Administration Suppression

**Intent:** Enterprise setup omits the regular-user administration surface because Cloudflare Access provisions regular users on first sign-in.

**Applies To:** User

**Acceptance Criteria:**

1. In enterprise mode, the setup wizard's "Regular Users" section is not rendered. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (ConfigureStep) -->
2. Outside enterprise mode, the setup wizard's "Regular Users" section renders unchanged. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (ConfigureStep) -->

**Constraints:** Enterprise setup still configures Admin Users and the optional Cloudflare Access group per [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning). Account-menu actions are owned by [REQ-SUB-023](subscription.md#req-sub-023-deployment-mode-account-actions).

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-008](#req-enterprise-008-enterprise-frontend-surface-suppression), [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning)

**Verification:** Automated test ([ConfigureStep](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx))

**Status:** Implemented

---

### REQ-ENTERPRISE-016: Strict Gateway Egress

**Intent:** An enterprise admin can force the container's **direct-internet** HTTP/HTTPS egress through the customer's Cloudflare (Zero Trust) Gateway — over the Workers VPC `EGRESS` binding — with one setup-wizard toggle, so every agent call to the outside world is subject to the account's existing egress policies. Only THIS deployment's own Cloudflare account destinations (its R2 + account-scoped CF API / Browser Rendering) are exempt and egress direct — they are codeflare's own control-plane backends, not the agent's external reach; any OTHER account's host rides the Gateway, closing the cross-account exfiltration channel ([AD86](../../documentation/decisions/README.md#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network)). A deployment with the toggle OFF (the default) is byte-identical to today.

**Applies To:** System

**Acceptance Criteria:**

1. Enterprise setup presents a default-off strict-egress toggle, persists explicit active or inactive values, and never writes it outside enterprise mode. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @impl: src/routes/setup/index.ts::strictGatewayEgress --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (Strict gateway egress toggle (REQ-ENTERPRISE-016)) --> <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (strict gateway egress (REQ-ENTERPRISE-016)) --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-016: persists the toggle as active when true (EGRESS bound)) --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-016: persists the toggle as inactive when false) --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-016: never writes the toggle in non-enterprise mode (regression)) -->
2. Enabling strict egress is rejected before any write when `EGRESS` is unbound. <!-- @impl: src/routes/setup/index.ts::strictGatewayEgress --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-016: refuses to enable the toggle when EGRESS is unbound (no brick)) -->
3. `GET /api/setup/prefill` round-trips the toggle: a seeded strict-egress setting prefills `true`, an absent key prefills `false`, and it is omitted from a non-enterprise prefill. <!-- @impl: src/routes/setup/handlers.ts::handlers --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (REQ-ENTERPRISE-016: strict gateway egress prefill) -->
4. The toggle is resolved by a single gate-then-read helper = enterprise mode AND KV `SETUP_KEYS.STRICT_EGRESS === 'active'`, defaulting OFF when the key is absent or when the KV read throws, and never reading KV in a non-enterprise deploy. <!-- @impl: src/lib/controller-egress.ts::hasStrictGatewayEgress --> <!-- @test: src/__tests__/lib/controller-egress.test.ts (REQ-ENTERPRISE-016: hasStrictGatewayEgress) -->
5. Strict egress registers a pre-start catch-all below per-host interceptors; disabled and non-enterprise modes register no catch-all. <!-- @impl: src/container/container-interception.ts::strictEgress --> <!-- @impl: src/container/container-interception.ts::wireContainerInterception --> <!-- @test: src/__tests__/container/enterprise-llm.test.ts (enterprise LLM interception wiring (REQ-ENTERPRISE-011)) -->
6. Disabled or non-enterprise mode leaves GitHub transport, container egress, and configuration behavior unchanged and performs no strict-egress KV access. <!-- @impl: src/lib/controller-egress.ts::hasStrictGatewayEgress --> <!-- @impl: src/container/container-interception.ts::wireContainerInterception --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
7. When strict egress is ON, the container is started with direct internet disabled, so the Containers platform allows only ports 80/443 + Cloudflare DNS and DENIES all raw TCP/UDP egress at the platform boundary the container cannot manipulate. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->

**Constraints:**

- The global admin toggle is stored explicitly as `active` or `inactive`, read directly from KV, and never threaded through session configuration.
- Per-host LLM/GitHub interceptors take precedence over the transparent catch-all `EgressController`; denied hosts and allowed-host policy retain the SDK's established precedence.
- Existing Cloudflare Gateway traffic policies remain authoritative; Codeflare does not create or modify them.
- Only this deployment's account-scoped R2 and Cloudflare API or Browser Rendering destinations egress directly; absent account identity and every other account ride the Gateway ([AD86](../../documentation/decisions/README.md#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network)).
- The LLM interceptor always egresses directly; GitHub and other external destinations use `EGRESS`.
- The enterprise-only Workers VPC `EGRESS` binding is injected only for active enterprise deploys; default, fork, and test deployments remain unaffected, and unavailable egress fails closed.
- `EGRESS` carries HTTP, HTTPS, and WebSocket traffic; upgrades use the fresh-socket bridge specified by [REQ-ENTERPRISE-023](#req-enterprise-023-strict-gateway-egress-controller-transport).

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var), [REQ-ENTERPRISE-012](#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list), [REQ-BROWSER-008](browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container)

**Verification:** Automated test ([setup persistence](../../src/__tests__/routes/setup.test.ts), [prefill](../../src/__tests__/routes/setup/handlers.test.ts), [setup store](../../web-ui/src/__tests__/stores/setup.test.ts), [container catch-all wiring + enableInternet](../../src/__tests__/container/index.test.ts), and [strict-gate resolver tests](../../src/__tests__/lib/controller-egress.test.ts). The `[[vpc_networks]]` `EGRESS` binding is deploy-time config (a Constraint: enterprise-only, committed commented-out and injected by `deploy.yml` when `ENTERPRISE_MODE=active`) — verified at deploy time, not unit-testable.)

**Status:** Implemented

---

### REQ-ENTERPRISE-023: Strict Gateway Egress Controller Transport

**Intent:** When Strict Gateway Egress is active, the catch-all egress controller transparently proxies direct-internet traffic through the Gateway while preserving the deployment's own Cloudflare control-plane paths.

**Applies To:** System

**Acceptance Criteria:**

1. The strict-egress controller transparently proxies every destination except this account's own R2. It adds no authorization or identity header, preserves caller authorization and cookies, strips only hop-by-hop headers, and does not follow redirects. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @impl: src/lib/controller-egress.ts::controllerFetch --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-ENTERPRISE-016 / AD86: EgressController account-scoped exemption (own account direct, all else Gateway)) -->
2. Only this deployment's account-scoped R2 endpoint and Cloudflare API account path bypass the strict-egress binding; every other account uses the binding. <!-- @impl: src/lib/controller-egress.ts::isAccountScopedDestination --> <!-- @impl: src/lib/controller-egress.ts::isOwnAccountR2 --> <!-- @impl: src/lib/controller-egress.ts::controllerFetch --> <!-- @test: src/__tests__/lib/controller-egress.test.ts (REQ-ENTERPRISE-016 / AD86: isAccountScopedDestination (own account only)) -->
3. **WebSocket proxying (bridged).** WebSocket upgrades reaching the strict-egress catch-all are forwarded **transparently** through the account-scoped selector, then **bridged** through a fresh client/server pair that forwards messages, closure, and errors in both directions. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @impl: src/lib/controller-egress.ts::controllerFetch --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-ENTERPRISE-016: EgressController bridges WebSocket upgrades (catch-all fallback)) -->
4. **Container holds no real R2 key (strict only).** When strict is active, a non-secret placeholder R2 access key/secret is emitted into the container instead of the real key. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @impl: src/lib/constants.ts::ENTERPRISE_R2_KEY_PLACEHOLDER --> <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) -->
5. Before any upstream send, the strict-egress controller rejects loopback, RFC 1918/private, link-local (including `169.254.169.254`), unspecified, and IPv4-mapped prohibited IPv6 targets with `403 EGRESS_TARGET_BLOCKED` and performs no fetch. Public IPv6 literals remain permitted. <!-- @impl: src/lib/controller-egress.ts::isDisallowedEgressHost --> <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/lib/controller-egress.test.ts (REQ-ENTERPRISE-016: isDisallowedEgressHost SSRF guard) -->
6. Unbound strict egress makes direct-internet and GitHub paths return `503 EGRESS_UNAVAILABLE` without fallback; this account's own platform destinations and LLM routing remain direct and independent of the strict-egress binding. <!-- @impl: src/lib/controller-egress.ts::controllerFetch --> <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @impl: src/github-interceptor.ts::GitHubInterceptor --> <!-- @test: src/__tests__/lib/controller-egress.test.ts (REQ-ENTERPRISE-016: controllerFetch transport selection) -->

**Constraints:**

- `EgressController` remains a transparent proxy, not an identity-stamping interceptor.
- Only this deployment's own account-scoped Cloudflare control-plane destinations bypass `env.EGRESS`; other accounts ride the Gateway.
- Direct-internet failures fail closed when strict egress is active and the binding is unavailable.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress), [REQ-ENTERPRISE-026](#req-enterprise-026-strict-r2-interception-preserves-user-bucket-authority), [REQ-BROWSER-008](browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container)

**Verification:** Automated test ([controller-egress resolver/transport/SSRF/account-scoped](../../src/__tests__/lib/controller-egress.test.ts), [EgressController transparent proxy + fail-closed + account-scoped passthrough + WebSocket](../../src/__tests__/egress-controller.test.ts), [container catch-all wiring + account-id prop](../../src/__tests__/container/index.test.ts), and [container env vars placeholder R2 key](../../src/__tests__/container/container-env.test.ts).)

**Status:** Implemented

---

### REQ-ENTERPRISE-026: Strict R2 Interception Preserves User-Bucket Authority

**Intent:** Strict egress re-signs own-account R2 traffic only for the session's bound bucket and only with that user's scoped credential, preserving the per-user storage boundary outside the root container.

**Applies To:** System

**Acceptance Criteria:**

1. Path-style and virtual-hosted own-account R2 requests are accepted only when they identify the session's exact bound bucket. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (accepts the bound bucket in virtual-hosted R2 form and signs with its scoped key) --> <!-- @test: src/__tests__/egress-controller.test.ts (re-signs the bound bucket with its user-scoped key, never the deployment-wide key, while preserving streaming and SSE-C) -->
2. A request for another path-style or virtual-hosted bucket returns `403 EGRESS_R2_BUCKET_FORBIDDEN` before signing or forwarding. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (rejects another virtual-hosted bucket in the same account before signing or forwarding) --> <!-- @test: src/__tests__/egress-controller.test.ts (rejects another path-style bucket in the same account before signing or forwarding) -->
3. An accepted request is re-signed only with the session's bucket-scoped credential; the placeholder signature is discarded and deployment-wide R2 credentials are never used. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @impl: src/container/container-interception.ts::strictEgress --> <!-- @test: src/__tests__/egress-controller.test.ts (re-signs the bound bucket with its user-scoped key, never the deployment-wide key, while preserving streaming and SSE-C) -->
4. Re-signing preserves streaming payload hashes and SSE-C headers. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (re-signs the bound bucket with its user-scoped key, never the deployment-wide key, while preserving streaming and SSE-C) -->
5. Missing scoped credentials return `503 EGRESS_R2_NOT_CONFIGURED` before any upstream send and never fall back to deployment-wide credentials. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (fails closed when scoped credentials are missing instead of falling back to deployment credentials) -->
6. A validated complete replacement pair becomes the authority for subsequent intercepted requests, including after a Durable Object wake or in an already-wired warm container. <!-- @impl: src/container/container-router.ts::handleSetBucketName --> <!-- @impl: src/container/container-interception.ts::refreshStrictEgressInterception --> <!-- @test: src/__tests__/container/container-router.test.ts (restores scoped R2 credentials from the validated restart payload after a Durable Object wake) --> <!-- @test: src/__tests__/container/container-router.test.ts (REQ-ENTERPRISE-026: refreshes warm strict interception with a changed scoped pair) -->
7. The in-memory pair changes only after a complete validated replacement is installed as the warm catch-all; otherwise the prior pair remains unchanged. <!-- @impl: src/container/container-router.ts::handleSetBucketName --> <!-- @impl: src/container/container-interception.ts::refreshStrictEgressInterception --> <!-- @test: src/__tests__/container/container-router.test.ts (rejects invalid restart credentials without replacing the in-memory scoped pair) --> <!-- @test: src/__tests__/container/container-router.test.ts (rejects a partial restart credential pair without mutating prior credentials) --> <!-- @test: src/__tests__/container/container-router.test.ts (REQ-ENTERPRISE-026: preserves the prior pair when warm catch-all replacement fails) -->

**Constraints:**

- Scoped credentials and the bound bucket remain Worker-side interceptor props; the strict container receives placeholders only.
- Governed Mode controls SSE-C behavior, not R2 signer authority.

**Priority:** P0

**Dependencies:** [REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress), [REQ-SEC-003](security.md#req-sec-003-per-user-r2-tokens-scoped-to-user-bucket)

**Verification:** Automated test ([bound-bucket authorization and scoped signing](../../src/__tests__/egress-controller.test.ts) and [atomic restart restoration](../../src/__tests__/container/container-router.test.ts).)

**Status:** Implemented

---

### REQ-ENTERPRISE-024: Strict Gateway Egress Host-Specific Interceptor Routing

**Intent:** Host-specific interceptors keep their credential-stamping responsibilities under Strict Gateway Egress: GitHub rides the Gateway, while Cloudflare AI Gateway remains a platform-native direct path.

**Applies To:** System

**Acceptance Criteria:**

1. Strict GitHub egress swaps only the upstream transport to the strict-egress binding; credential injection, no-spoof scoping, manual redirects, and response hygiene remain unchanged. Toggle-off traffic uses global fetch. <!-- @impl: src/github-interceptor.ts::GitHubInterceptor --> <!-- @test: src/__tests__/github-interceptor.test.ts (REQ-ENTERPRISE-016: strict gateway egress transport swap) -->
2. LLM interception does NOT swap — AI Gateway (`api.cloudflare.com` / `gateway.ai.cloudflare.com`) is a platform-native Cloudflare primitive, so its upstream forward ALWAYS egresses direct via global `fetch`, independent of the toggle and strict-egress binding ([AD86](../../documentation/decisions/README.md#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network)). <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-016 / AD86: AI Gateway is platform-native — always direct egress, never cf1:network) -->

**Constraints:**

- GitHub is external direct-internet egress and fails closed when strict egress is active without an `EGRESS` binding.
- AI Gateway remains platform-native Cloudflare control-plane egress and never depends on the `EGRESS` binding.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress), [REQ-ENTERPRISE-023](#req-enterprise-023-strict-gateway-egress-controller-transport), [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)

**Verification:** Automated test ([GitHub transport swap](../../src/__tests__/github-interceptor.test.ts) and [LLM always-direct (AI Gateway platform-native)](../../src/__tests__/llm-interceptor.test.ts).)

**Status:** Implemented

---

### REQ-ENTERPRISE-017: AI Gateway Configured in the Setup Wizard

**Intent:** An enterprise admin can configure the customer's AI Gateway URL + token in the Setup wizard (persisted in KV, the token encrypted) instead of supplying them as deploy-time GitHub secrets, so a fresh enterprise deployment is configurable end-to-end from the wizard with no redeploy. The deploy-time secrets ([REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var)) remain an OPTIONAL fallback, so existing deployments keep working unchanged.

**Applies To:** Admin

**Acceptance Criteria:**

1. Enterprise setup accepts gateway URL and token, preserves each on blank, rejects token storage without encryption, and reports its progress step; non-enterprise setup writes neither. <!-- @impl: src/routes/setup/index.ts::app --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (Feature A/C: enterprise groups chip list + dynamic routes) -->
2. `GET /api/setup/prefill` round-trips the AI Gateway config (enterprise-only): it surfaces the non-secret `aigGatewayUrl` and a masked `aigTokenSet` boolean (never the token itself), reports unset/empty when nothing is stored, and omits both fields entirely in a non-enterprise prefill. <!-- @impl: src/routes/setup/handlers.ts::handlers --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->
3. Gateway configuration resolves wizard values before per-field deployment fallbacks and falls back without throwing on KV or crypto errors. <!-- @impl: src/lib/aig-config.ts::getAigConfig --> <!-- @test: src/__tests__/lib/aig-config.test.ts (getAigConfig (REQ-ENTERPRISE-017)) -->
4. The container DO resolves the gateway URL + token once and passes them to the LLM interceptor as per-session properties; the interceptor prefers the props and falls back to its own env only when a prop is absent. The token never enters the container. <!-- @impl: src/container/container-interception.ts::llm --> <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-017: AI Gateway URL/token resolved from props (wizard) with env fallback) -->
5. The Setup wizard renders the enterprise-only AI Gateway URL + token fields inside an organized group; they are not rendered outside enterprise mode, and their inputs persist the entered URL and token through setup state. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/components/setup/SetupSection.tsx::SetupSection --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (ConfigureStep) -->
6. The "Configuring Codeflare" progress screen reflects the steps it runs: the configure endpoint emits named `configure_*` steps (`configure_access_groups`, `configure_model_routing`, `configure_ai_gateway`, `configure_browser_rendering`, `configure_strict_egress`), and the progress UI maps each to a friendly label. <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) --> <!-- @manual -->

**Constraints:**

- The token is a secret: stored encrypted (kv-crypto, same shape as the Browser Rendering token, [REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)), masked on prefill, no-clobber on blank, and never returned to the client; The URL is non-secret and stored plain.
- URL and token resolve independently with wizard KV before deploy secrets, allowing mixed sources while deploy secrets remain a silent fallback ([REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var) AC1).
- Grouping fields into `SetupSection`s preserves every field, store binding, and conditional gate; only visual grouping changes.
- `SetupSection` is a reusable structure-only component with no copy.
- Routine Administration reads and validates the same effective URL and token through [REQ-SETUP-017](setup.md#req-setup-017-mode-aware-administration-configuration-read); no Worker-binding or unauthenticated transport is added.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var), [REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ENTERPRISE-018: Governed Mode Toggle and Configuration Surface

**Intent:** In enterprise, bucket data is corporate-owned and the company must be able to scan agent config (skills, hooks, extensions) for malicious content with its own security tooling. By default every R2 object is encrypted with SSE-C (`ENCRYPTION_KEY`), so the bucket is opaque even to the company. An enterprise admin can enable **Governed Mode** — a deployment-wide, KV-backed toggle (no redeploy) that disables R2 SSE-C so objects use R2's default at-rest encryption and stay readable/scannable by R2-credential holders. Default OFF (SSE-C on); when off, behavior is byte-identical to before. The toggle is configured from the Setup wizard behind an explicit admin confirmation and forwarded to each session's container as the resolved regime, which drives the re-encrypt migration in [REQ-ENTERPRISE-020](#req-enterprise-020-governed-mode-re-encrypt-migration-engine).

**Applies To:** Admin

**Acceptance Criteria:**

1. `POST /api/setup/configure` accepts an enterprise-only `r2SseDisabled` boolean, persisted as `'active'`/`'inactive'` setup state and surfaced as a `configure_r2_sse` progress step; a non-enterprise configure never writes it. `GET /api/setup/prefill` round-trips it. <!-- @impl: src/routes/setup/index.ts::app --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
2. SSE helpers suppress headers for disabled buckets; every writer follows the bucket's committed regime, while readers use dual-regime fallback throughout migration. <!-- @impl: src/lib/r2-sse.ts::getSseHeaders --> <!-- @impl: src/lib/r2-sse.ts::getSseCopyHeaders --> <!-- @impl: src/lib/r2-regime-state.ts::isR2SseDisabledForBucket --> <!-- @impl: src/lib/r2-seed.ts::seedDocuments --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (regime helpers (REQ-ENTERPRISE-018)) -->
3. The bucket's resolved regime is forwarded to the container as `R2_SSE_DISABLED`, and the entrypoint omits the SSE-C sync configuration and re-enables checksums when it is set. `ENCRYPTION_KEY` itself is also omitted from the container env in Governed Mode. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @impl: src/container/container-env.ts::applyBucketName --> <!-- @impl: src/container/container-env.ts::applyPrefsOnRestart --> <!-- @impl: entrypoint.sh::create_rclone_config --> <!-- @test: src/__tests__/container/container-env.test.ts (applyBucketName / applyPrefsOnRestart propagate userTimezone (REQ-SESSION-016 AC3 wiring regression) / REQ-AGENT-029 (container env vars contract)) -->
4. The Setup wizard renders an enterprise-only Governed Mode toggle (default off, not rendered outside enterprise) whose change requires an explicit admin confirmation of the re-encrypt consequence before it flips the store value. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (ConfigureStep) -->

**Constraints:**

- Governed Mode gates only R2 SSE-C; vault and secret-at-rest encryption remain active.
- Deployment-wide policy stored in KV (no redeploy to flip), mirroring [REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress); With Governed Mode off (the default) all SSE-C behavior, seeding, and sync are byte-identical to before.

**Priority:** P2

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated test ([wizard persistence](../../src/__tests__/routes/setup.test.ts) + [prefill](../../src/__tests__/routes/setup/handlers.test.ts) (AC1), [SSE-C gate](../../src/__tests__/lib/r2-sse.test.ts) + [regime helpers](../../src/__tests__/lib/r2-migration.test.ts) (AC2), [container env propagation](../../src/__tests__/container/container-env.test.ts) + [ENCRYPTION_KEY omission](../../src/__tests__/container/container-env-llm.test.ts) + [rclone.conf branch](../../host/__tests__/entrypoint-governed-sync.test.js) (AC3), [wizard toggle + confirmation](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx) + [setup store](../../web-ui/src/__tests__/stores/setup.test.ts) (AC4))

**Status:** Implemented

---

### REQ-ENTERPRISE-020: Governed Mode Re-Encrypt Migration Engine

**Intent:** Flipping [REQ-ENTERPRISE-018](#req-enterprise-018-governed-mode-toggle-and-configuration-surface)'s Governed Mode toggle must reconcile every existing bucket to the new SSE-C regime **losslessly** (in-place server-side re-encryption, never a nuke) rather than forcing an admin to accept data loss or a manual migration. The reconcile is a per-bucket **state machine** (`r2-regime:<bucket>`) driven in the background by the dashboard's `batch-status` poll, in resumable chunks verified before the regime commits. The safety boundary around this engine — write gate, container drain, dual-regime reads, and the zero-secret container footprint — is [REQ-ENTERPRISE-021](#req-enterprise-021-governed-mode-migration-safety-and-access-boundary).

**Applies To:** Admin

**Acceptance Criteria:**

1. Re-encryption uses conditional same-key server copy, preserving metadata and ETag while applying source and destination SSE-C headers; success requires a parsed result ETag without an embedded error. <!-- @impl: src/lib/r2-migration.ts::migrateBucketEncryption --> <!-- @impl: src/lib/r2-sse.ts::computeKeyMd5 --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (migrateBucketEncryption (lossless REPLACE re-encrypt)) -->
2. That same source-regime HEAD is the idempotency check: a `400`/`403` SSE-mismatch means the object already reads in the target regime and is skipped ([AD91](../../documentation/decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile)). An object over the 5 GB single-copy limit is recorded `oversized` and skipped. <!-- @impl: src/lib/r2-migration.ts::migrateBucketEncryption --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (migrateBucketEncryption (lossless REPLACE re-encrypt)) -->
3. Each poll advances ready, migrating, and mixed-recovery bucket state: policy drift starts migration only without a healthy container, otherwise remaining pending. <!-- @impl: src/lib/r2-regime-state.ts::getRegimeState --> <!-- @impl: src/lib/r2-migration.ts::planRegimeReconcile --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-ENTERPRISE-020: Governed Mode reconcile + chunk advance on batch-status) -->
4. Each poll's background work scans the bucket in `LIST_PAGE_SIZE`-sized pages (up to 1,000 keys), re-encrypting each page in `MIGRATION_CONCURRENCY`-sized slices (6). Per-object failures are isolated, and each R2 op runs under an `AbortController` timeout. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->
5. After every chunk, the cursor checkpoints the last processed key so resume starts at the next key; each invocation accepts only work that fits its deadline and releases its lease before exit. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->
6. The migrate→verify transition happens within one invocation: migrate re-encrypts, verify HEAD-scans every object, and the regime plus `generation` advance only after a clean full verify. A failed chunk never throws — it records the last error and releases the lease for retry. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->
7. At drain, the bucket object `total` is counted once via a bounded listing, and `processed` accumulates across both passes. `batch-status` returns the rounded `bucketMigrationPercent`, omitted until `total` is known and while `halted`. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->

**Constraints:**

- The migration is lossless — bytes never leave R2, and metadata is re-supplied via `MetadataDirective=REPLACE`; a >5 GB object exceeds the single-`CopyObject` limit and is recorded + skipped.
- The migration is slice-chunked and `start-after`-resumable across `batch-status` polls, and the regime commits only after a full verify HEAD-scan; a crashed lease expires and the next poll resumes safely ([AD91](../../documentation/decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile)).
- Termination is guaranteed: verify skips the same oversized objects migrate skips, per-object failures are isolated, and the bounded migrate↔verify retry (`MAX_VERIFY_RETRIES`) halts an unfixable object for admin review.
- Session creation never migrates a bucket — it only resolves the committed regime, and a new bucket adopts the current policy immediately.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-018](#req-enterprise-018-governed-mode-toggle-and-configuration-surface), [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** Automated test ([REPLACE copy + idempotent/oversized skip](../../src/__tests__/lib/r2-migration.test.ts) (AC1-2), [state machine + reconcile decision](../../src/__tests__/lib/r2-migration.test.ts) + [chunk-advance wiring](../../src/__tests__/routes/session-batch-status.test.ts) (AC3), [chunked scan driver (list/slice, timeout, cursor, deadline, lease release)](../../src/__tests__/lib/r2-migration.test.ts) (AC4-5), [migrate→verify transition + progress %](../../src/__tests__/lib/r2-migration.test.ts) + [batch-status wiring](../../src/__tests__/routes/session-batch-status.test.ts) (AC6-7), [session-start lazy-create path](../../src/__tests__/lib/r2-migration.test.ts) + [ensureBucketAndSeed](../../src/__tests__/routes/container-lifecycle-helpers.test.ts) (Constraints))

**Status:** Implemented

---

### REQ-ENTERPRISE-021: Governed Mode Migration Safety and Access Boundary

**Intent:** While a bucket's regime migrates ([REQ-ENTERPRISE-020](#req-enterprise-020-governed-mode-re-encrypt-migration-engine)), the system must stay correct and safe for concurrent access: writers are backend-gated so nothing lands in the wrong regime, running containers are drained, reads stay up via a dual-regime fallback with self-heal for any stray object, and the dashboard reflects migration progress. Under strict Gateway egress ([REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress)) together with Governed Mode, this boundary also keeps the container's real-secret footprint down to just the DO-issued `CONTAINER_AUTH_TOKEN`.

**Applies To:** Admin

**Acceptance Criteria:**

1. Strict egress with Governed Mode exposes only the DO-issued container credential; all service credentials remain placeholders or absent ([REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress)). <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (container secret hygiene: no AWS_* anywhere, CF token placeholder-only in enterprise) -->
2. While a bucket's state is not `ready`, every R2 writer (container `/start`, upload, reseed, preference reconcile) rejects `409 BUCKET_MIGRATING`, and the sync fan-out returns empty. On migration start, running containers are drained once and in-flight multipart uploads are aborted. <!-- @impl: src/lib/error-types.ts::BucketMigratingError --> <!-- @impl: src/lib/r2-regime-state.ts::isBucketMigrating --> <!-- @impl: src/lib/migration-containers.ts::drainContainers --> <!-- @impl: src/lib/sync-fanout.ts::fanOutBisyncTrigger --> <!-- @test: src/__tests__/routes/sessions-sync.test.ts (skips the entire fan-out while the bucket is migrating (no container is contacted)) -->
3. The dashboard reuses the REQ-AGENT-049 "Upgrading" affordance: `batch-status` returns `bucketMigrating` plus a 0–99 `bucketMigrationPercent` (omitted while `halted`), and the New Session button disables and labels "Migrating N%". Both the full session load and the 5s background poll mirror these flags. <!-- @test: web-ui/src/__tests__/stores/session.test.ts (Session Store) --> <!-- @impl: src/routes/session/lifecycle.ts::bucketMigrationPercent --> <!-- @manual -->
4. Read paths (download, preview) try the committed regime first and fall back once to the opposite regime on a `400`/`403` SSE-mismatch, so a partially-migrated bucket stays readable. <!-- @impl: src/lib/r2-migration.ts::fetchObjectWithRegimeFallback --> <!-- @impl: src/lib/r2-regime-state.ts::resolveReadRegime --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (fetchObjectWithRegimeFallback (D2 reads stay up)) -->
5. A fallback on a `ready` bucket starts one `mixed-recovery` scan only without a healthy container, otherwise keeps the bucket ready, and changes neither regime nor generation. <!-- @impl: src/lib/r2-migration.ts::markMixedRecovery --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (fetchObjectWithRegimeFallback (D2 reads stay up)) -->

**Constraints:**

- The backend gate + container drain are the safety boundary; a container regime generation guard was deliberately not built ([AD91](../../documentation/decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile)) — the verify-rescan + read self-heal catch any stray write.
- `mixed-recovery` respects D1 (no force-kill); key rotation is detect-only, with no old-key fallback.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-020](#req-enterprise-020-governed-mode-re-encrypt-migration-engine), [REQ-ENTERPRISE-018](#req-enterprise-018-governed-mode-toggle-and-configuration-surface), [REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress), [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-SEC-005](security.md#req-sec-005-r2-files-encrypted-at-rest-with-sse-c-when-operator-configures-an-encryption-key), [REQ-BROWSER-008](browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ENTERPRISE-019: View-Only Storage (download disable)

**Intent:** An enterprise admin can switch the R2 Storage Panel to view-only with one Setup-wizard toggle, so users and agents can open/view files but cannot download them — blocking bulk exfiltration of bucket contents (e.g. zipping a repo and downloading it). Default OFF; non-enterprise modes are byte-identical to today.

**Applies To:** System

**Acceptance Criteria:**

1. The Setup wizard exposes an enterprise-gated view-only-storage toggle, default OFF, persisted to KV as `'active'`/`'inactive'` through the existing `POST /api/setup/configure` (no new endpoint); a non-enterprise configure never writes it. <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
2. `GET /api/setup/prefill` round-trips the toggle: a seeded download-disable setting prefills `true`, an absent key prefills `false`, and it is omitted from a non-enterprise prefill. <!-- @impl: src/routes/setup/handlers.ts::handlers --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->
3. Active enterprise view-only policy runs before R2 access: attachments and non-viewable inline types return distinct `403 DOWNLOADS_DISABLED`; text, Markdown, HTML-as-text, images, and PDF remain inline. The resolver never reads policy outside enterprise. <!-- @impl: src/routes/storage/download.ts::isInlineViewable --> <!-- @impl: src/lib/error-types.ts::DownloadsDisabledError --> <!-- @impl: src/lib/downloads-policy.ts::isDownloadsDisabled --> <!-- @test: src/__tests__/routes/storage-download.test.ts (Storage Download Routes) -->
4. `GET /api/user` returns `downloadsDisabled` so the client renders the Storage Panel download controls as **blocked** visible but disabled-looking and still tappable and any interaction opens a notice that downloads are disabled by the administrator instead of fetching. <!-- @impl: web-ui/src/lib/schemas.ts::UserResponseSchema --> <!-- @impl: web-ui/src/lib/download.ts::downloadFile --> <!-- @impl: web-ui/src/stores/storage.ts::storageStore --> <!-- @impl: web-ui/src/stores/storage.ts::refreshDownloadsDisabled --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (StorageBrowser / REQ-STOR-016 AC1/AC2 (file browser drawer/bottom-sheet presentation, R2 as source of truth via Worker API)) -->
5. Outside enterprise or with the toggle off, no policy KV read occurs; the storage download path and configure request/response shape are unchanged. A transient policy-read failure defaults off, keeps downloads available, and reports `downloadsDisabled: false`. <!-- @impl: src/lib/downloads-policy.ts::isDownloadsDisabled --> <!-- @test: src/__tests__/routes/storage-download.test.ts (REQ-ENTERPRISE-019 AC5: keeps downloads available when the enterprise policy KV read rejects) --> <!-- @test: src/__tests__/routes/user-profile.test.ts (REQ-ENTERPRISE-019 AC5: reports downloadsDisabled false when the policy KV read rejects) -->

**Constraints:**

- Enforcement is **server-side** in `download.ts`; the frontend blocked-control + notice are convenience only, so a prompt-injected agent cannot bypass the policy by crafting the download URL.
- The toggle persists explicit active or inactive state; absent or unreadable state defaults off, and non-enterprise deployments never read it.
- Scope is **download (exfil) only**: upload and delete are intentionally unaffected (they are not exfiltration vectors).

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-SEC-013](security.md#req-sec-013-content-disposition-hardening-on-downloads)

**Verification:** Automated test ([download guard + isInlineViewable](../../src/__tests__/routes/storage-download.test.ts) (AC2, AC4), [setup persistence](../../src/__tests__/routes/setup.test.ts) + [prefill](../../src/__tests__/routes/setup/handlers.test.ts) (AC1, AC1a), [setup store](../../web-ui/src/__tests__/stores/setup.test.ts) + [wizard toggle](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx) (AC1), [view-only download guard + downloads-enabled baseline](../../web-ui/src/__tests__/components/StorageBrowser.test.tsx) (AC3, AC4), [downloadFile server-truth backstop](../../web-ui/src/__tests__/lib/download.test.ts) (AC3), [blocked preview control](../../web-ui/src/__tests__/components/FilePreview.test.tsx) + [disabled notice](../../web-ui/src/__tests__/components/DownloadsDisabledPopup.test.tsx) + [notice store flag](../../web-ui/src/__tests__/stores/storage.test.ts) + [response-schema field survival](../../web-ui/src/__tests__/api/contract.test.ts) (AC3).)

**Status:** Implemented

---

### REQ-ENTERPRISE-025: Active Coding Agents Configured in the Setup Wizard

**Intent:** An enterprise admin selects in the Setup wizard which build-installed, gateway-capable coding agents users may pick at session creation (minimum one when that universe is non-empty), persisted in KV with no redeploy; an absent configuration keeps every installed capable agent active.

**Applies To:** Admin

**Acceptance Criteria:**

1. The wizard's Coding Agents offering and pre-checked selection derive from the setup prefill: installed stored selections when present, every installed capable agent otherwise. <!-- @impl: src/routes/setup/handlers.ts::handlers --> <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (hydrates the selection and the governable universe from the enterprise prefill) --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (GET /prefill defaults to every governable agent when nothing is stored) --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (REQ-ENTERPRISE-025 AC1: GET /prefill hides capable agents omitted from the image) -->
2. The admin's selection persists through its own `configure_active_agents` setup step to KV `setup:active_agents` and round-trips on the wizard prefill together with the governable universe. <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-025: persists the active-agent selection as JSON with its own step) --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (GET /prefill surfaces the stored selection plus the governable universe) -->
3. The configure endpoint rejects an empty, non-capable, or build-omitted agent selection. <!-- @impl: src/routes/setup/index.ts::ConfigureBodySchema --> <!-- @impl: src/routes/setup/index.ts::app --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-025: rejects an empty active-agent selection with 400) --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-025 AC3: rejects a capable agent whose CLI is omitted from the image) -->
4. The wizard blocks unchecking the last active agent (minimum one). <!-- @impl: web-ui/src/stores/setup.ts::toggleActiveAgent --> <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (toggling removes an active agent but never the last one) -->
5. A reconfigure that omits the field leaves the stored selection untouched, and non-enterprise setups never write it. <!-- @impl: src/routes/setup/index.ts::ConfigureBodySchema --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-ENTERPRISE-025: never writes the selection when the field is absent) -->

**Constraints:**

- The selectable universe is capped by gateway routability and the build-installed set ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-OPS-040](operations.md#req-ops-040-selected-coding-agent-packaging)); the wizard can never add an agent beyond either boundary.
- `bash` is not wizard-governable — tabs 2-6 are plain bash in every session, so deactivating it would remove nothing.
- The selection is KV-backed like every sibling wizard toggle; a change propagates within KV's eventual-consistency window, not as a per-session strong-consistency guarantee.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-AGENT-001](agents.md#req-agent-001-support-multiple-ai-coding-agents), [REQ-OPS-040](operations.md#req-ops-040-selected-coding-agent-packaging)

**Verification:** Automated test ([Setup persistence + validation](../../src/__tests__/routes/setup-enterprise-groups.test.ts), [prefill](../../src/__tests__/routes/setup/handlers.test.ts), [wizard store](../../web-ui/src/__tests__/stores/setup.test.ts))

**Status:** Implemented

---

### REQ-ENTERPRISE-027: Managed-resource admission and transport

**Intent:** Enterprise sessions admit protected managed resources only from verified applied identity and transport that identity without moving authority into the container.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Session admission compares desired release, sequence, effective mode, extension digest, resource policy, and path digest with the applied stamp. A mismatch returns managed-update-pending before bucket or container work. <!-- @impl: src/routes/container/lifecycle.ts::app --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (blocks a desired and applied resource-policy mismatch before bucket work) -->
2. Protected start requires Enterprise Strict Gateway Egress and its binding, then requires fresh verification of exact user-bucket policy identity before container work. <!-- @impl: src/routes/container/lifecycle.ts::app --> <!-- @impl: src/lib/managed-r2-policy.ts::readVerifiedManagedR2Policy --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (verifies protected bucket policy without cache and transports only its identity) --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (blocks corrupt protected policy before container work) -->
3. Authenticated lifecycle transport uses one normalized policy enum, one path digest, and the existing curation release digest. <!-- @impl: src/lib/container-config-schema.ts::SetBucketNameBodySchema --> <!-- @impl: src/routes/container/lifecycle-init.ts::buildSetBucketNameBody --> <!-- @test: src/__tests__/lib/container-config-schema.test.ts (accepts mutable only with a null managed path identity) -->
4. Invalid policy identity combinations do not cross the Worker-to-DO boundary. <!-- @impl: src/lib/container-config-schema.ts::SetBucketNameBodySchema --> <!-- @impl: src/container/container-router.ts::handleSetBucketName --> <!-- @test: src/__tests__/lib/container-config-schema.test.ts (requires the curation release and managed path digests for both protected modes) --> <!-- @test: src/__tests__/container/container-router.test.ts (rejects injected policy digests when policy mode is omitted) --> <!-- @test: src/__tests__/container/container-router.test.ts (rejects injected policy digests when policy mode is omitted) -->
5. A warm Durable Object refreshes strict interception before committing changed bucket, scoped credential, policy, release, or path-digest security state. <!-- @impl: src/container/container-router.ts::handleSetBucketName --> <!-- @impl: src/container/container-interception.ts::refreshStrictEgressInterception --> <!-- @test: src/__tests__/container/container-router.test.ts (refreshes warm strict interception when only policy identity changes) -->
6. Explicit mutable identity clears stale protected state. <!-- @impl: src/container/container-env.ts::applyPrefsOnRestart --> <!-- @test: src/__tests__/container/container-env.test.ts (clears protected state and env on an explicit mutable warm reset) -->
7. The container receives only non-authoritative policy identity hints; policy bytes and scoped credentials remain Worker-side. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (emits protected identity without exposing Worker-held scoped credentials) -->

**Constraints:** Durable Objects do not persist policy bytes or make authorization decisions.

**Priority:** P0

**Dependencies:** [REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress), [REQ-STOR-030](storage.md#req-stor-030-managed-resource-policy-loading)

**Verification:** Automated admission, schema, transport, and warm-refresh tests

**Status:** Implemented

---

### REQ-ENTERPRISE-028: Managed-resource request classification

**Intent:** The Worker classifies every own-bucket S3 mutation before scoped signing without changing ordinary reads or adjacent personal paths.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. The classifier allows reads and listing for the bound user bucket. <!-- @impl: src/lib/managed-r2-policy.ts::classifyManagedR2Request --> <!-- @test: src/__tests__/lib/managed-r2-request.test.ts (allows reads and listing while denying cross-bucket targets) -->
2. Exact-path and exclusive-root mutations are denied across path-style, virtual-host, multipart, tagging, metadata-replacement, and copy destinations. <!-- @impl: src/lib/managed-r2-policy.ts::classifyManagedR2Request --> <!-- @test: src/__tests__/lib/managed-r2-request.test.ts (denies protected mutation %s %s) -->
3. Malformed, ambiguous, bucket-level, or noncanonical mutation targets fail closed without double decoding. <!-- @impl: src/lib/managed-r2-policy.ts::classifyManagedR2Request --> <!-- @test: src/__tests__/lib/managed-r2-request.test.ts (decodes exactly once and rejects malformed, noncanonical, backslash, duplicate-control, and empty mutations) -->
4. Multi-delete accepts bounded, uncompressed strict XML with no namespace or the canonical S3 namespace and at most 1,000 keys. <!-- @impl: src/lib/managed-r2-policy.ts::classifyManagedR2Request --> <!-- @test: src/__tests__/lib/managed-r2-request.test.ts (denies a whole mixed multi-delete and forwards exact ordinary bytes) --> <!-- @test: src/__tests__/lib/managed-r2-request.test.ts (fails closed above the multi-delete byte and key-count bounds) --> <!-- @test: src/__tests__/lib/managed-r2-request.test.ts (fails closed on malformed, compressed, or ambiguous multi-delete) -->
5. A protected or uncertain multi-delete key denies the whole request. <!-- @impl: src/lib/managed-r2-policy.ts::classifyManagedR2Request --> <!-- @test: src/__tests__/lib/managed-r2-request.test.ts (denies a whole mixed multi-delete and forwards exact ordinary bytes) -->
6. Approved multi-delete bytes are forwarded unchanged. <!-- @impl: src/lib/managed-r2-policy.ts::classifyManagedR2Request --> <!-- @test: src/__tests__/lib/managed-r2-request.test.ts (denies a whole mixed multi-delete and forwards exact ordinary bytes) -->

**Constraints:** Classification runs before scoped signing and decodes keys exactly once.

**Priority:** P0

**Dependencies:** [REQ-STOR-028](storage.md#req-stor-028-canonical-managed-resource-persistence-policy), [REQ-STOR-032](storage.md#req-stor-032-exclusive-managed-resource-boundaries)

**Verification:** Automated addressing, mutation-form, canonical-key, multi-delete, and adjacent-path tests

**Status:** Implemented

---

### REQ-ENTERPRISE-029: Managed-resource Egress enforcement

**Intent:** Egress applies verified policy with the exact scoped user credential and fails closed before forwarding protected mutations.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Egress derives policy location and identity only from Worker state. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (loads policy with scoped credentials and denies protected mutation before user forwarding) -->
2. Policy reads use only the scoped user key. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (loads policy with scoped credentials and denies protected mutation before user forwarding) -->
3. Approved user requests use only the scoped user key. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (signs approved adjacent mutation only with the scoped user key) -->
4. Missing or mismatched policy returns S3 XML `503` without forwarding the mutation. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (returns S3 503 and never forwards mutation when policy loading fails) -->
5. Protected mutation returns S3 XML `403` before user forwarding. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (loads policy with scoped credentials and denies protected mutation before user forwarding) -->
6. Policy decisions log only operation, identity/hash prefixes, request ID, and reason. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (loads policy with scoped credentials and denies protected mutation before user forwarding) --> <!-- @test: src/__tests__/egress-controller.test.ts (signs approved adjacent mutation only with the scoped user key) --> <!-- @test: src/__tests__/egress-controller.test.ts (returns S3 503 and never forwards mutation when policy loading fails) -->

**Constraints:** Worker interception immediately before scoped signing is authoritative.

**Priority:** P0

**Dependencies:** [REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress), [REQ-ENTERPRISE-026](#req-enterprise-026-strict-r2-interception-preserves-user-bucket-authority), [REQ-ENTERPRISE-027](#req-enterprise-027-managed-resource-admission-and-transport), [REQ-ENTERPRISE-028](#req-enterprise-028-managed-resource-request-classification), [REQ-STOR-030](storage.md#req-stor-030-managed-resource-policy-loading)

**Verification:** Automated scoped-policy-read, scoped-forwarding, policy-failure, protected-denial, and privacy-safe logging tests

**Status:** Implemented

---

### REQ-ENTERPRISE-030: Managed-resource Storage enforcement

**Intent:** User-facing Storage mutations enforce the same applied policy before any user-object R2 request.

**Applies To:** Enterprise

**Acceptance Criteria:**

1. Storage uploads, multipart operations, and exact, batch, or prefix deletes check bucket migration before policy evaluation. <!-- @impl: src/routes/storage/upload.ts::app --> <!-- @impl: src/routes/storage/delete.ts::app --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (Storage Upload Routes / REQ-STOR-008 (file upload via direct-to-R2 PUT)) -->
2. Storage compares full desired and applied identity before policy loading. <!-- @impl: src/lib/managed-storage-guard.ts::guardManagedStorageMutation --> <!-- @test: src/__tests__/lib/managed-storage-guard.test.ts (fails update-pending before policy lookup on %s mismatch) -->
3. Storage verifies policy before a user-object R2 request. <!-- @impl: src/lib/managed-storage-guard.ts::guardManagedStorageMutation --> <!-- @test: src/__tests__/routes/storage-upload.test.ts (REQ-ENTERPRISE-030: denies protected upload before the user-object R2 request) -->
4. Exact or intersecting protected targets return `403`. <!-- @impl: src/lib/managed-storage-guard.ts::guardManagedStorageMutation --> <!-- @test: src/__tests__/lib/managed-storage-guard.test.ts (blocks exact keys and intersecting prefixes but permits adjacent paths) -->
5. Uncertain desired, applied, pending-target, or policy state returns managed-update-pending without a user-object R2 request. <!-- @impl: src/lib/managed-storage-guard.ts::guardManagedStorageMutation --> <!-- @test: src/__tests__/lib/managed-storage-guard.test.ts (fails update-pending before policy lookup on %s mismatch) --> <!-- @test: src/__tests__/lib/managed-storage-guard.test.ts (REQ-ENTERPRISE-030 AC5: blocks storage mutation while interrupted targets remain pending) -->
6. Managed-update-pending Storage responses explain that uploads and deletions remain blocked until the update finishes. <!-- @impl: src/lib/managed-storage-guard.ts::guardManagedStorageMutation --> <!-- @test: src/__tests__/lib/managed-storage-guard.test.ts (explains why uploads and deletions are blocked during a managed update) --> <!-- @test: src/__tests__/lib/managed-storage-guard.test.ts (keeps storage guidance when managed policy verification is unavailable) -->

**Constraints:** Storage uses the verified user-bucket policy and does not create another authority.

**Priority:** P0

**Dependencies:** [REQ-ENTERPRISE-027](#req-enterprise-027-managed-resource-admission-and-transport), [REQ-STOR-030](storage.md#req-stor-030-managed-resource-policy-loading)

**Verification:** Automated migration, identity, policy, protected-target, and uncertainty tests

**Status:** Implemented

---
