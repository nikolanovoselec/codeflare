# Enterprise Mode Domain Specification

Deploy-time enterprise configuration: single-tenant unlimited access, subscription bypass, and platform outbound-HTTPS interception that routes agent LLM traffic to a customer-owned AI Gateway with no credential ever placed in the container.

### Key Concepts

| Concept | Definition |
|---------|-----------|
| Enterprise Mode | A deploy-time configuration, toggled by the `ENTERPRISE_MODE` Worker var, that turns a Codeflare deployment into a single-tenant enterprise instance: every user resolves to the `unlimited` tier in Pro (advanced) session mode and subscription/billing is disabled |
| AI Gateway | The customer's Cloudflare AI Gateway endpoint that fronts the upstream LLM providers; its URL and token are held only in the Worker/interceptor env as secrets (`AIG_GATEWAY_URL`, `AIG_TOKEN`) |
| LLM Interceptor | A `WorkerEntrypoint` (`LlmInterceptor`) the container DO wires into container egress via `ctx.container.interceptOutboundHttps`; it receives the container's outbound HTTPS to the real provider hosts at the platform level (never the public internet, never Cloudflare Access), maps each onto the gateway provider path, and forwards with gateway auth + per-user attribution stamped on |
| Outbound Interception | The Cloudflare Containers platform mechanism (`interceptOutboundHttps` + `ctx.exports`, on by default at this project's compat date — the `enable_ctx_exports` flag became the platform default in late 2025, so no flag is set) that routes a container's matching egress hostnames through a `WorkerEntrypoint` with no credential, URL, or token in the container |
| Per-User Attribution | The user's email passed to the interceptor as a per-session DO prop (sourced from `_userEmail` in `setupEnterpriseInterception`, falling back to the deterministic bucket id when absent) and stamped as `cf-aig-metadata.user` so the customer's gateway per-user analytics attribute usage to the real identity; **every** Cloudflare Access group the user matches (when groups are configured) is stamped alongside as a per-group `group_<sanitized>_<hash>=1` tag (the scalar `group` key is not used), within CF's 5-entry metadata cap (`user` + up to 4 groups, deterministic truncation), so the gateway can branch routing/cost/rate-limit policies per group. The `_<hash>` suffix is a deterministic djb2/base-36 hash of the original group name (`sanitizeGroupKey`), appended to every key so lossy `[a-z0-9_]` sanitization cannot collide two distinct groups (`Dev Team` and `dev-team` both sanitize to `dev_team`); a gateway equals-filter must target the full hashed key (e.g. `group_codeflare_admins_150f5d1`), not the bare name |
| JIT Provisioning | Auto-creation of an `unlimited` Codeflare user on first authenticated access in Enterprise Mode, keyed by the Cloudflare-Access-verified `email`; gated optionally by `ENTERPRISE_ACCESS_GROUP` membership (see [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning)) |
| Access get-identity | The Cloudflare Access endpoint `${iss}/cdn-cgi/access/get-identity`, called with the request's `CF_Authorization` token, returning the full identity (including IdP group membership) used to enforce `ENTERPRISE_ACCESS_GROUP` — the application JWT carries no group claim by default |
| `ENTERPRISE_ACCESS_GROUP` | Optional value set during the setup wizard and stored in KV (`SETUP_KEYS.ENTERPRISE_ACCESS_GROUP`), editable by re-running setup; names one or more **customer-managed** Cloudflare Access groups (comma/newline-separated) that gate Codeflare entry — a user in ANY configured group is admitted. Codeflare references them (via `get-identity`) but never creates or populates them — unlike the non-enterprise admin/user groups it manages itself. When set, JIT provisioning verifies membership and denies non-members; when unset, any user who clears Cloudflare Access is provisioned an account (the gate then lives entirely in the customer's Access application policy) |
| Strict Gateway Egress | An optional, enterprise-gated, default-OFF setup-wizard toggle (`SETUP_KEYS.STRICT_EGRESS`, `'active'`/`'inactive'`) that, when ON, forces the container's **direct-internet** HTTP/HTTPS (and WebSocket) egress through the Workers VPC `EGRESS` binding and from there the customer's Cloudflare (Zero Trust) Gateway. Only this deployment's own-account destinations (its R2 + account-scoped CF API / Browser Rendering) are exempt and egress direct; any other account's host rides the Gateway ([AD86](../../documentation/decisions/README.md#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network)). It fails closed (503 `EGRESS_UNAVAILABLE`) when the binding is unbound and is byte-identical to today when OFF ([REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress)) |
| EgressController | A `WorkerEntrypoint` the container DO wires as the catch-all (`interceptOutboundHttps('*', controller)`) when Strict Gateway Egress is ON (the DO passes `{accountId, strict}` via `ctx.props`, resolved once at wiring — no per-request KV). A **transparent proxy** for every host except this account's own R2: it stamps no identity and preserves the caller's `authorization`/`cookie`/`set-cookie`, forwarding direct-internet hosts (incl. any other account's Cloudflare host) through `env.EGRESS.fetch` and this account's account-scoped CF API direct via global `fetch`. This account's own R2 is the exception: its placeholder `authorization` is stripped and the request is **re-signed** with the worker-held R2 key (the container holds only a placeholder R2 key). WebSocket upgrades are **bridged** (a fresh `WebSocketPair` accepted on both ends and forwarded), not returned as-is. Fails closed ([REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress)) |
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

### REQ-ENTERPRISE-001: ENTERPRISE_MODE Forces Unlimited Tier and Pro Mode

**Intent:** A deploy-time `ENTERPRISE_MODE` flag must turn a deployment into a single-tenant enterprise instance where every user gets full access without subscription friction.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, every user's effective tier resolves to `unlimited` regardless of the stored `subscriptionTier`. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/enterprise-mode.test.ts (REQ-ENTERPRISE-001 AC4: resolveEffectiveSleepAfter enterprise override) -->
2. When `ENTERPRISE_MODE` is set, session-mode resolution returns Pro (`advanced`) for every user regardless of the stored preference. <!-- @impl: src/lib/session-mode.ts::resolveSessionMode --> <!-- @test: src/__tests__/lib/enterprise-mode.test.ts (REQ-ENTERPRISE-001 AC4: resolveEffectiveSleepAfter enterprise override) -->
3. When `ENTERPRISE_MODE` is set, every user is treated as a custom `unlimited` user: the unlimited tier's session cap applies, the monthly compute quota (timekeeper) is never enforced, and billing-status checks and trial logic are disabled. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (Container lifecycle extracted helpers / REQ-SESSION-007 (validateSessionAndCheckLimits enforces per-tier MAX_SESSIONS at session start) / REQ-SUB-013 (concurrent session caps from MAX_SESSIONS_USER/MAX_SESSIONS_ADMIN)) -->
4. The flag is read from a single resolver; all callers consult the resolver rather than reading the raw binding. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode --> <!-- @test: src/__tests__/lib/enterprise-mode.test.ts (REQ-ENTERPRISE-001 AC4: resolveEffectiveSleepAfter enterprise override) -->
5. When `ENTERPRISE_MODE` is unset, tier resolution, session-mode resolution, and subscription enforcement are byte-identical to current behavior across the Default, Onboarding, and SaaS deployment modes. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode --> <!-- @test: src/__tests__/routes/preferences-enterprise.test.ts (Preferences Routes under ENTERPRISE_MODE / REQ-ENTERPRISE-001 + REQ-ENTERPRISE-003) -->

**Constraints:**

- The flag is read at deploy time from a Worker binding, not from request data, so it cannot be toggled per request.
- When the flag is unset there is no new code path: every enterprise branch is gated behind the resolver returning false.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](subscription.md#req-sub-001-eight-tier-subscription-system), [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier), [REQ-AGENT-004](agents.md#req-agent-004-two-session-modes-standard-and-pro)

**Verification:** [Automated test](../../src/__tests__/lib/enterprise-mode.test.ts)

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

**Verification:** [Header subscription-hide](../../web-ui/src/__tests__/components/Header.test.tsx) (AC1 billing surfaces hidden in enterprise, AC4 shown in SaaS), [subscribe route guard](../../web-ui/src/__tests__/components/enterprise-app-routing.test.tsx) (AC2 `/app/subscribe` redirects to `/app/` in a non-SaaS/enterprise deployment), [API enterpriseMode flag](../../src/__tests__/routes/user-profile-enterprise.test.ts) (AC3 deploy-time signal, AC4 flag-off parity).

**Status:** Implemented

---

### REQ-ENTERPRISE-003: Agent Allowlist in Enterprise Mode

**Intent:** Enterprise deployments standardize on a curated agent set, so session creation must restrict the selectable agents when the flag is set.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, the selectable agent set is exactly `{copilot, pi, bash}`. <!-- @impl: src/lib/agent-allowlist.ts::allowedAgents --> <!-- @impl: src/lib/subscription.ts::isEnterpriseMode --> <!-- @test: src/__tests__/routes/session-agent-allowlist.test.ts (REQ-ENTERPRISE-003: Agent allowlist at session creation) -->
2. When `ENTERPRISE_MODE` is set, session creation rejects any agent type outside the enterprise allowlist. <!-- @impl: src/lib/agent-allowlist.ts::allowedAgents --> <!-- @test: src/__tests__/routes/session-agent-allowlist.test.ts (REQ-ENTERPRISE-003: Agent allowlist at session creation) -->
3. When `ENTERPRISE_MODE` is set, the session-creation UI offers only the allowlisted agents. <!-- @impl: web-ui/src/components/CreateSessionDialog.tsx::CreateSessionDialog --> <!-- @test: src/__tests__/routes/session-agent-allowlist.test.ts (REQ-ENTERPRISE-003: Agent allowlist at session creation) -->
4. When `ENTERPRISE_MODE` is unset, all seven agent types from [REQ-AGENT-001](agents.md#req-agent-001-support-multiple-ai-coding-agents) remain selectable, byte-identical to current behavior. <!-- @impl: src/types.ts::AgentTypeSchema --> <!-- @test: src/__tests__/routes/session-agent-allowlist.test.ts (REQ-ENTERPRISE-003: Agent allowlist at session creation) -->

**Constraints:**

- The allowlist is applied on top of the existing agent-type validation; it narrows the set.
- The enterprise allowlist is a fixed set, not admin-configurable, in this domain.
- Only OpenAI-wire-format agents plus `bash` are allowed; their traffic uses the AI Gateway REST API ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)).
- Claude Code is excluded; its Anthropic-native wire format is unsupported ([AD74](../../documentation/decisions/README.md)).

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-AGENT-001](agents.md#req-agent-001-support-multiple-ai-coding-agents), [REQ-AGENT-002](agents.md#req-agent-002-agent-selection-at-session-creation)

**Verification:** [Automated test](../../src/__tests__/routes/session-agent-allowlist.test.ts)

**Status:** Implemented

---

### REQ-ENTERPRISE-004: Outbound-Interception LLM Routing to Customer AI Gateway

**Intent:** Enterprise deployments route all agent LLM traffic to the customer's AI Gateway via platform outbound-HTTPS interception, so the gateway credentials never reach the container, nothing is exposed over a public route, and all usage is attributable.

**Applies To:** User

**Acceptance Criteria:**

1. The container DO routes the container's outbound HTTPS to the real LLM provider host (`api.openai.com`) through a `WorkerEntrypoint` (`LlmInterceptor`) via `ctx.container.interceptOutboundHttps` + `ctx.exports`. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-004: compat fallback on REST 404 (dual transport — AD74 amendment)) -->
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

**Verification:** [Automated test](../../src/__tests__/llm-interceptor.test.ts)

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
- The route catalog/default/reasoning are non-secret routing hints fanned to the container so the agents can list/select routes; the actual gateway route is mapped Worker-side by the interceptor from the slash-free handle ([REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning)); Backend keys stay in the gateway (BYOK).
- Only the allowlisted enterprise agents ([REQ-ENTERPRISE-003](#req-enterprise-003-agent-allowlist-in-enterprise-mode)) are configured; `bash` needs no LLM configuration.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning), [REQ-AGENT-031](agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity)

**Verification:** [env-pipeline test](../../src/__tests__/container/container-env-llm.test.ts) (AC1/AC5/AC6 env injection; AC7 secret hygiene — no AWS_* in either mode, enterprise CLOUDFLARE_API_TOKEN placeholder-only); [Pi models.json build test](../../host/__tests__/entrypoint-enterprise-pi-models.test.js) (AC4 — one model per catalog route + per-route contextWindow, empty-catalog fallback, reserved-keyword jq guard; AC7 — auth.json cleared to {}); [entrypoint CA-trust + Copilot BYOK test](../../host/__tests__/entrypoint-enterprise-ca-copilot.test.js) (AC2 — CA env prepended to .bashrc, idempotent, enterprise-gated; AC3 — Copilot BYOK vars + token-limit hints prepended, stale route overwritten on re-run, enterprise-gated). All acceptance criteria are covered by automated tests.

**Status:** Implemented

---

### REQ-ENTERPRISE-006: Deploy-Time AIG Secrets and ENTERPRISE_MODE Var

**Intent:** Enterprise configuration must be supplied at deploy time through Worker bindings, kept secret where appropriate, and default to off.

**Applies To:** Admin

**Acceptance Criteria:**

1. `AIG_GATEWAY_URL` and `AIG_TOKEN` may be configured as Worker secrets so they are not stored in plaintext config or exposed to the container. <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-004: compat fallback on REST 404 (dual transport — AD74 amendment)) -->
2. `ENTERPRISE_MODE` is configured as a non-secret Worker var. The dynamic-route catalog and default route are NOT deploy-time vars — they are configured in the setup wizard and stored in KV, editable with no redeploy; the former static `AIG_LANGUAGE_MODEL` route-pin var is removed. <!-- @impl: wrangler.toml::binding -->
3. Enterprise Mode is off by default: an absent or empty `ENTERPRISE_MODE` binding resolves to disabled. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode --> <!-- @test: src/__tests__/lib/enterprise-mode.test.ts (REQ-ENTERPRISE-001 AC1 / REQ-ENTERPRISE-006 AC3: isEnterpriseMode) -->
4. When `ENTERPRISE_MODE` is enabled, the interceptor fails closed (503) if the resolved AI Gateway URL (wizard KV or deploy-secret fallback — `getAigConfig`, [REQ-ENTERPRISE-017](#req-enterprise-017-ai-gateway-configured-in-the-setup-wizard)) is missing or unparseable (no `/v1/{account_id}/{gateway_id}` segments),. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-017: AI Gateway URL/token resolved from props (wizard) with env fallback) --> <!-- @impl: src/container/index.ts::wireLlmInterception -->
5. When `ENTERPRISE_MODE` is configured, the CF Access application created by the setup wizard is host-scoped (bare custom domain, no path suffix) so the session cookie covers all paths uniformly; non-enterprise deployments retain the path-scoped (`/app/*`) application. <!-- @impl: src/routes/setup/access.ts::handleCreateAccessApp --> <!-- @test: src/__tests__/routes/setup/access.test.ts (enterprise mode creates a host-scoped app (bare host domain + whole-host destination)) -->
6. Enterprise setup best-effort provisions a higher-priority public service-worker bypass. It never aborts host setup, stores the app ID only after policy success, and rolls back a new app on policy failure; non-enterprise creates none. <!-- @impl: src/routes/setup/access.ts::handleCreateAccessApp --> <!-- @test: src/__tests__/routes/setup/access.test.ts (Setup Access) -->
7. `deploy.yml` exposes `enterprise` and `enterprise integration` as manual-dispatch environments deployable from any branch, separate from production and integration. <!-- @impl: .github/workflows/deploy.yml::deploy -->

**Notes:** Manual verification procedures are documented in the [security checklist](../../documentation/lanes/security.md#manual-verification-checklist).

**Constraints:**

- The enterprise flag is evaluated from deploy-time bindings, consistent with [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes).
- Container env receives only the enterprise flag and non-secret route hints derived from Worker config, never session state; gateway URL, token, account ID, and resolved route remain Worker-only.
- The resolved AI Gateway URL uses wizard KV before the deploy-secret fallback and is the single source for account and gateway coordinates, so no separate account-ID binding is required.
- The Workers VPC `EGRESS` binding is enterprise-only, committed disabled, and injected at deploy only when enterprise mode is active; default, fork, and test deployments remain unaffected.
- A missing `EGRESS` binding fails strict egress closed; non-enterprise and toggle-off deployments remain inert.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-ENTERPRISE-007: Gateway Route-Pinning

**Intent:** The gateway route must be selected Worker-side from the Setup-configured catalog so agents carry only a slash-free model handle, eliminating agent-side model-string parsing (e.g. Pi reading a `dynamic/<route>` slash as `provider/model`) that would misroute traffic away from the interceptor.

**Applies To:** User

**Acceptance Criteria:**

1. On model-routable requests, catalog handles map to `dynamic/<route>`; unknown or pre-prefixed handles re-resolve to the configured default when valid, otherwise the first catalog entry. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (Feature C: catalog-driven dynamic-route mapping (replaces AIG_LANGUAGE_MODEL)) -->
2. When the catalog is empty, or the body is non-JSON, has no `model` field, or the path is not model-routable, the request body is forwarded unchanged. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (Feature C: catalog-driven dynamic-route mapping (replaces AIG_LANGUAGE_MODEL)) -->

**Constraints:**

- The route catalog and default live in KV ([REQ-ENTERPRISE-012](#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list)), not a deploy-time var; the catalog of slash-free handles is fanned to the container so agents can list/select routes, but the gateway route is resolved Worker-side ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC3, AC4).
- Only the request `model` field is rewritten; no other request field and no response byte is altered.
- Route mapping runs only when interception is active ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)); when `ENTERPRISE_MODE` is unset the interceptor is never instantiated.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var)

**Verification:** [Automated test](../../src/__tests__/llm-interceptor.test.ts)

**Status:** Implemented

---

### REQ-ENTERPRISE-008: Enterprise Frontend Surface Suppression

**Intent:** Frontend surfaces are suppressed along two axes. (a) The SaaS-billing / consumption surfaces — subscription, plans, the monthly-quota / "Upgrade" banners, the subscription-tier admin, the Standard/Pro session-mode selector, and the username dropdown's "Usage" entry — are meaningful only in SaaS mode, so they render only when `SAAS_MODE` is active and are hidden in enterprise, onboarding, and default deployments alike (a non-SaaS deployment showing a "choose your plan" / "upgrade" surface is misleading; onboarding originally inherited these because the gate was `!enterprise`, which this REQ corrects to `saasMode`). The "Usage" entry was previously also shown in enterprise, but the enterprise usage view always reports zero (the Timekeeper read path is not wired for enterprise), so the entry is gated to SaaS until that is fixed. (b) In-product user administration, first-login routing, the username dropdown's "Guided Setup" (per-user onboarding) and "Logout" entries, and the setup "Regular Users" section are enterprise-specific suppressions keyed off `ENTERPRISE_MODE`. Because every username-dropdown entry is gated away in enterprise (Subscription + Usage by axis a, Guided Setup + Logout by axis b), the avatar/username trigger stays visible (users always see their identity) but clicking it opens no dropdown.

**Applies To:** User

**Acceptance Criteria:**

1. The "Manage Subscriptions" entry in Settings → Administration renders only when `SAAS_MODE` is active (hidden in enterprise, onboarding, and default). The "Manage Users" entry renders in every mode except enterprise (hidden only when `ENTERPRISE_MODE` is set). <!-- @impl: web-ui/src/components/SettingsPanel.tsx::SettingsPanel --> <!-- @test: web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx (REQ-ENTERPRISE-008 AC1/AC3: SettingsPanel) -->
2. The username dropdown in both the Header menu and the Dashboard menu renders its "Subscription" and "Usage" entries only when `SAAS_MODE` is active. In enterprise the avatar/username trigger stays visible but its dropdown never opens, so neither entry appears. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Header Component / REQ-VAULT-012 (vault button render and readiness gating) / REQ-AUTH-016 (header user dropdown)) -->
3. The Standard/Pro session-mode selector renders only when `SAAS_MODE` is active; in enterprise every user is implicitly Pro (advanced) per [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC2, and onboarding / default deployments have no Standard/Pro plans. <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection --> <!-- @test: web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx (REQ-ENTERPRISE-008 AC3: SessionSection mode selector) -->
4. The monthly-quota warning banners and their "Upgrade" calls-to-action render only when `SAAS_MODE` is active. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/enterprise-layout-suppression.test.tsx (REQ-ENTERPRISE-008 AC4: quota banners render only in SaaS mode) -->
5. When `ENTERPRISE_MODE` is set, a first-time (auto-provisioned) user is routed to the application home, never to `/app/subscribe` or the self-serve onboarding/waitlist flow. <!-- @impl: web-ui/src/App.tsx::App --> <!-- @test: web-ui/src/__tests__/components/enterprise-app-routing.test.tsx (redirects /app/subscribe to /app/ in a non-SaaS (enterprise) deployment, never rendering the checkout flow) -->
6. Three-mode parity: in SaaS mode every surface in AC1–AC4 renders; in onboarding and default deployments the SaaS-billing surfaces do not render while AC1 "Manage Users" does; in enterprise mode every SaaS-billing surface in AC1–AC5 is suppressed and the username dropdown never opens. <!-- @impl: web-ui/src/App.tsx::App --> <!-- @test: web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx (REQ-ENTERPRISE-008 AC2: Header username dropdown) -->

**Constraints:**

- SaaS-billing surfaces use deploy-time `saasMode`; admin and routing surfaces use `enterpriseMode`, never user tier or role ([REQ-ENTERPRISE-015](#req-enterprise-015-enterprise-mode-admin-and-dropdown-suppressions)).
- `GET /api/user` exposes both signals to `sessionStore`; `GET /api/auth/status` also exposes `saasMode` for `SubscribeGuard`.
- Suppression is render-gating only: it removes no component code path for non-enterprise deployments and deletes no stored user state.
- Visibility only: this REQ adds the client `SubscribeGuard` saasMode redirect plus the admin-button, mode-selector, quota-banner, and first-login-routing surfaces; the matching routes are made unreachable server-side in [REQ-ENTERPRISE-009](#req-enterprise-009-enterprise-backend-route-hardening).

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-002](#req-enterprise-002-subscription-ui-hidden-and-subscribe-route-guarded), [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning)

**Verification:** [Automated test](../../web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx) (AC1–AC3, AC6, REQ-ENTERPRISE-015 AC2); [enterprise-layout-suppression.test.tsx](../../web-ui/src/__tests__/components/enterprise-layout-suppression.test.tsx) (AC4); [enterprise-app-routing.test.tsx](../../web-ui/src/__tests__/components/enterprise-app-routing.test.tsx) (AC5); [Header.test.tsx](../../web-ui/src/__tests__/components/Header.test.tsx) (AC2/REQ-ENTERPRISE-015 AC2/REQ-ENTERPRISE-015 AC3); [Dashboard.test.tsx](../../web-ui/src/__tests__/components/Dashboard.test.tsx) (AC2/REQ-ENTERPRISE-015 AC2/REQ-ENTERPRISE-015 AC3)

**Status:** Implemented

---

### REQ-ENTERPRISE-009: Enterprise Backend Route Hardening

**Intent:** Hiding a SaaS or admin surface in the frontend is not sufficient; in Enterprise Mode the corresponding routes must fail closed so the disabled capabilities cannot be reached by direct API call, URL manipulation, or a stray external event.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, the user-management routes (`GET`/`PUT`/`DELETE`/`PATCH` under `/api/users`) return 403 and perform no mutation; user administration is delegated entirely to Cloudflare Access. <!-- @impl: src/routes/users.ts::app --> <!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (REQ-ENTERPRISE-009 AC1: /api/users fails closed in enterprise mode) -->
2. When `ENTERPRISE_MODE` is set, the billing action routes (`POST /api/billing/checkout`, `/api/billing/portal`, `/api/billing/switch`) return 403, and `GET /api/billing/status` returns an empty/disabled billing state without contacting Stripe. <!-- @impl: src/routes/billing.ts::portalRateLimiter --> <!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (REQ-ENTERPRISE-009 AC2: /api/billing is disabled in enterprise mode) -->
3. When `ENTERPRISE_MODE` is set, the self-serve routes `POST /api/auth/subscribe` and `POST /api/auth/request-access` return 403 and send no email. <!-- @impl: src/routes/auth.ts::RequestAccessSchema --> <!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (REQ-ENTERPRISE-009 AC3: self-serve auth routes 403 with no email) -->
4. When `ENTERPRISE_MODE` is set, the Stripe webhook route acknowledges the event without mutating any user's tier or billing state, so a late or stray Stripe event cannot downgrade an enterprise user. <!-- @impl: src/routes/stripe-webhook.ts::DEDUPE_TTL_SECONDS --> <!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (REQ-ENTERPRISE-009 AC4: Stripe webhook is a no-op in enterprise mode) -->
5. When `ENTERPRISE_MODE` is set, the admin tier/subscription configuration routes return 403 (there is a single effective tier, `unlimited`, for all users). <!-- @impl: src/routes/admin/tiers.ts::PutTiersBodySchema --> <!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (REQ-ENTERPRISE-009 AC5: admin tier config routes 403 in enterprise mode) -->
6. When `ENTERPRISE_MODE` is set, `PATCH /api/preferences` is **not** fail-closed: the SaaS advanced-mode entitlement gate is bypassed so any user may select Pro, and the effective session mode is forced to Pro by `clampSessionModeToTier` regardless of the stored value. <!-- @impl: src/lib/session-mode.ts::clampSessionModeToTier --> <!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (REQ-ENTERPRISE-009 AC6: PATCH /api/preferences is not fail-closed in enterprise mode) -->
7. When `ENTERPRISE_MODE` is unset, every route above behaves byte-identically to current behavior. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode --> <!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (REQ-ENTERPRISE-009 AC7: flag unset is byte-identical to current behavior) -->

**Constraints:**

- All guards consult the single `isEnterpriseMode(env)` resolver ([REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC4); no route reads the raw binding.
- Action endpoints fail closed with 403; the read-only billing-status endpoint returns an empty state (200) so non-enterprise clients that still poll it do not error.
- These guards are defense-in-depth behind the frontend suppression in [REQ-ENTERPRISE-008](#req-enterprise-008-enterprise-frontend-surface-suppression); neither layer alone is sufficient.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-002](#req-enterprise-002-subscription-ui-hidden-and-subscribe-route-guarded), [REQ-ENTERPRISE-008](#req-enterprise-008-enterprise-frontend-surface-suppression)

**Verification:** [Automated test](../../src/__tests__/routes/enterprise-route-hardening.test.ts)

**Status:** Implemented

---

### REQ-ENTERPRISE-010: Access-Gated JIT User Provisioning

**Intent:** In Enterprise Mode users are managed by the customer's Cloudflare Access, not inside Codeflare, so any Access-authenticated user entitled to the deployment must be provisioned automatically on first access — a fresh user lands work-ready with no in-product allowlisting or approval step.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set and an authenticated request presents a valid Cloudflare Access JWT for an `email` with no existing user record, Codeflare auto-creates a record `{ addedBy: 'enterprise-jit', role: 'user', accessTier: 'advanced', subscriptionTier: 'unlimited' }` keyed by the JWT's IdP-verified `email`. <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser --> <!-- @impl: src/lib/jwt.ts::verifyAccessJWT --> <!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning) -->
2. When the optional `ENTERPRISE_ACCESS_GROUP` is configured, provisioning first resolves the user's group membership via the Access `get-identity` endpoint and, when the user is in none of the configured groups, denies the request with Codeflare's standard not-authorized response and creates no record. <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser --> <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning) -->
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

**Verification:** [Automated test](../../src/__tests__/lib/enterprise-jit-provisioning.test.ts)

**Status:** Implemented

---

### REQ-ENTERPRISE-011: Container Start Interception Ordering

**Intent:** Enterprise LLM interception must be wired before the container boots, so the ephemeral Cloudflare containers CA exists when the container entrypoint installs it into the trust store; wiring it after boot makes the intercepted TLS handshake fail and no agent can reach the gateway.

**Applies To:** User

**Acceptance Criteria:**

1. `startAndWaitForPorts` registers interception before container start so the platform CA mounts before entrypoint installs trust; post-boot wiring would make intercepted TLS fail. <!-- @impl: src/container/index.ts::startAndWaitForPorts --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
2. When `ENTERPRISE_MODE` is unset, the `startAndWaitForPorts` override performs no interception work and the container start path is byte-identical to current behavior. <!-- @impl: src/container/index.ts::startAndWaitForPorts --> <!-- @test: src/__tests__/container/index.test.ts (enterprise LLM interception wiring (REQ-ENTERPRISE-011)) -->

**Constraints:**

- Wiring runs on the start chokepoint that all start paths funnel through (explicit start + container-fetch auto-start), before the SDK boots the container.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls)

**Verification:** [Automated test](../../src/__tests__/container/index.test.ts)

**Status:** Implemented

---

### REQ-ENTERPRISE-012: Setup-Configured Dynamic-Route Catalog and Access-Group List

**Intent:** An enterprise admin must manage an unlimited set of Cloudflare Access groups and an unlimited set of gateway dynamic routes from the setup wizard with no redeploy — the same way admin users are managed — so adding a team or a route is a wizard edit, not a code or deploy-var change.

**Applies To:** Admin

**Acceptance Criteria:**

1. Existing setup configure saves chip-list access groups and routes without a new endpoint. Names are trimmed, 1–256 characters, allow spaces, and reject commas or newlines; groups use lossless joined storage parsed by `parseAccessGroups`. <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: src/__tests__/routes/setup.test.ts (POST /api/setup/configure) -->
2. The JSON route catalog defaults to its first entry with reasoning off; configured defaults must belong or return 400. Optional per-group route/default/reasoning maps persist separately. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
3. `GET /api/setup/prefill` round-trips the stored groups, catalog, and default route so a setup re-run shows the current configuration; a malformed stored value degrades to empty defaults rather than failing the prefill. <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (GET /prefill degrades to empty defaults when stored route JSON is malformed) -->
4. Catalog/default feed the interceptor route mapping ([REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning)) and the container env fan ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC1) via the shared `loadEnterpriseRouteConfig` resolver; the group list feeds the JIT gate ([REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning)), the per-group metadata tags ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC4), and the per-group route editor ([REQ-ENTERPRISE-013](#req-enterprise-013-per-group-dynamic-routing)). <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (loadEnterpriseRouteConfig per-group routing (REQ-ENTERPRISE-013)) -->
5. When `ENTERPRISE_MODE` is unset, the dynamic-route catalog UI and KV reads add no behavior; the access-group field already existed and is unchanged for non-enterprise deployments. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (GET /prefill omits the enterprise extras when ENTERPRISE_MODE is unset (regression)) -->
6. In enterprise mode, the setup wizard blocks "Continue" until at least one dynamic route is added. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (keeps Continue disabled in enterprise mode until a dynamic route is added (AC6)) -->
7. `POST /api/setup/configure` rejects empty or absent `dynamicRoutes` with `400` before any KV write. The interceptor's empty-catalog passthrough ([REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning) AC2) is defensive only. <!-- @impl: src/routes/setup/index.ts::app --> <!-- @test: src/__tests__/routes/setup.test.ts (POST /api/setup/configure) -->

**Constraints:**

- No new persistence layer or endpoint: the lists ride the existing setup wizard configure flow and KV (`SETUP_KEYS`), consistent with how `ENTERPRISE_ACCESS_GROUP` was already stored ([REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning)).
- Access groups are stored comma/newline-joined (back-compat with the prior single-value config) and routes as a JSON array; the comma/newline ban on names keeps the joined encoding lossless.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning), [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning)

**Verification:** [Setup configure tests](../../src/__tests__/routes/setup.test.ts), [prefill tests](../../src/__tests__/routes/setup/handlers.test.ts), [route-config resolver tests](../../src/__tests__/lib/enterprise-route-config.test.ts), [access-group parsing](../../src/__tests__/lib/access-group-resolution.test.ts), [setup store](../../web-ui/src/__tests__/stores/setup.test.ts), [ConfigureStep](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx)

**Status:** Implemented

---

### REQ-ENTERPRISE-022: Per-Route Context Windows for Dynamic Routes

**Intent:** An enterprise admin can set a context window per dynamic route so routed agents advertise each model route's usable window without redeploying.

**Applies To:** Admin

**Acceptance Criteria:**

1. The wizard shows a per-route **context window** number input for each dynamic route, prefilled with `DEFAULT_ROUTE_CONTEXT_WINDOW` (`256000`), that the admin can raise or reset to the default. Adding a route seeds its window to the default; removing a route drops its entry. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (Setup Store) -->

**Constraints:**

- Route context windows stay keyed by configured route.
- Each value is a positive integer; missing entries back-fill the default route context window.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-012](#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls)

**Verification:** [Setup configure tests](../../src/__tests__/routes/setup.test.ts), [prefill tests](../../src/__tests__/routes/setup/handlers.test.ts), [setup store](../../web-ui/src/__tests__/stores/setup.test.ts), [ConfigureStep](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx), [container env fan](../../src/__tests__/container/container-env-llm.test.ts), and [entrypoint Pi models](../../host/__tests__/entrypoint-enterprise-pi-models.test.js).

**Status:** Implemented

---

### REQ-ENTERPRISE-013: Per-group dynamic routing

**Intent:** An enterprise admin can scope the dynamic-route catalog per Cloudflare Access group — which routes a group's members may use, and the group's default route + reasoning — so different teams get different model access from one deployment, while a deployment with no per-group config behaves exactly as the global catalog does today.

**Applies To:** Admin

**Acceptance Criteria:**

1. With no per-group routing configured, behavior is unchanged: every session resolves the global `DYNAMIC_ROUTES` catalog and `DEFAULT_ROUTE`. <!-- @impl: src/lib/access.ts::resolveRouteCatalog --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (loadEnterpriseRouteConfig per-group routing (REQ-ENTERPRISE-013)) -->
2. When per-group routing is configured, a session resolves the routes/default/reasoning of the **first** of its matched Access groups that has a non-empty entry; a matched group with no entry, or no matched group at all, falls back to the global catalog. <!-- @impl: src/lib/access.ts::resolveRouteCatalog --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (loadEnterpriseRouteConfig per-group routing (REQ-ENTERPRISE-013)) -->
3. Setup stores per-group route maps, rejects unknown groups, out-of-catalog routes, or defaults outside their group routes with 400, and deletes empty maps. <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
4. Both routing sinks — the LLM interceptor's per-request route enforcement ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC4) and the container env fan ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC1) — read the same group-aware `resolveRouteCatalog` core, so they cannot drift; the existing default-drift rule is preserved. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (loadEnterpriseRouteConfig per-group routing (REQ-ENTERPRISE-013)) -->
5. The Setup wizard renders one per-group routing card per Access group (only when ≥1 group and ≥1 route exist): toggleable route **pills** (selected = green, deselected = gray). <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (ConfigureStep) -->
6. All reads/writes are inside the existing `isEnterpriseMode` gate; in non-enterprise modes the Setup request/response shape and route resolution are byte-identical to before. <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->

**Notes:** Manual verification procedures are documented in the [security checklist](../../documentation/lanes/security.md#manual-verification-checklist).

**Constraints:**

- A user matching several configured groups is resolved deterministically by first match in the admin's configured group-list order (not by union or by most-permissive).
- The global catalog remains the universe of routes; a group can only narrow it, never add a route outside it.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning), [REQ-ENTERPRISE-012](#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-ENTERPRISE-014: Admin access via Cloudflare Access groups

**Intent:** An enterprise admin can grant admin (= Setup / user-administration) access to members of one or more named Cloudflare Access groups, parallel to the email-based admin list, so admin rights track the customer's directory instead of a hand-maintained email list. Admin groups govern administration only — they never participate in per-group model routing.

**Applies To:** Admin

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set and admin Access groups are configured, a non-admin user who belongs to **any** configured admin group is elevated to `admin` for the request, granting access to admin-gated routes. <!-- @impl: src/middleware/auth.ts::requireAdmin --> <!-- @impl: src/lib/access.ts::resolveAdminAccessGroup --> <!-- @test: src/__tests__/middleware/auth.test.ts (Auth Middleware) -->
2. A non-admin user who is in none of the configured admin groups still receives `403` from admin-gated routes. <!-- @impl: src/middleware/auth.ts::requireAdmin --> <!-- @test: src/__tests__/middleware/auth.test.ts (requireAdmin — enterprise admin-by-group (REQ-ENTERPRISE-014)) -->
3. The admin-group check runs **only** inside `requireAdmin` (an admin-gated path), never in the hot `authenticateRequest`/`requireIdentity` identity path and it short-circuits for a user already resolved as `admin` so every non-admin request and every request on a non-admin route stays byte-identical. <!-- @impl: src/lib/access.ts::resolveAdminAccessGroup --> <!-- @test: src/__tests__/middleware/auth.test.ts (Auth Middleware) -->
4. An active user-access gate admits members of either user or admin groups. Admin groups alone never arm the gate, so entry remains open without configured user groups. <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser --> <!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning) -->
5. Admin groups persist under `SETUP_KEYS.ENTERPRISE_ADMIN_ACCESS_GROUP`, comma-joined, saved through `POST /api/setup/configure`; an empty list deletes the key. They are excluded from per-group routing by construction — only `ENTERPRISE_ACCESS_GROUP` keys may carry a `GROUP_ROUTING` entry. <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
6. Setup renders optional admin-group chips beside unchanged email admins, round-trips them through prefill, and excludes them from per-group routing cards. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: web-ui/src/__tests__/stores/setup.test.ts (Setup Store) -->
7. All reads/writes are inside the existing `isEnterpriseMode` gate; in non-enterprise modes the Setup request/response shape and admin authorization are byte-identical to before. <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->

**Notes:** Manual verification procedures are documented in the [security checklist](../../documentation/lanes/security.md#manual-verification-checklist).

**Constraints:**

- Elevation is per-request and lives only on the Hono context; no KV `role:'admin'` record is written for a group-admin (so revocation is immediate and leaves no residue); The email-based admin list remains the durable admin source.
- The live get-identity check fails CLOSED (treated as non-member) on any missing token, non-`*.cloudflareaccess.com` domain, or fetch error — an admin gate must never elevate on uncertainty.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning), [REQ-ENTERPRISE-012](#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-ENTERPRISE-015: Enterprise-mode admin and dropdown suppressions

**Intent:** When ENTERPRISE_MODE is set, the in-product user-administration surfaces and the username dropdown are suppressed: the setup wizard's regular-user section is omitted and the username dropdown never opens (every entry is independently gated away).

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, the setup wizard's "Regular Users" section is not rendered — setup configures only Admin Users and the optional Cloudflare Access group, since regular users are provisioned via Cloudflare Access on first sign-in per [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning); when unset, the section renders unchanged. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (ConfigureStep) -->
2. When `ENTERPRISE_MODE` is set, the username dropdown does not open in either the Header menu or the Dashboard menu the avatar/username trigger stays visible, but clicking it is inert. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Header Component / REQ-VAULT-012 (vault button render and readiness gating) / REQ-AUTH-016 (header user dropdown)) -->
3. The username dropdown's "Logout" entry is treated as enterprise-suppressed. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (Dashboard / REQ-SUB-019 (session limit popup in frontend)) -->

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-008](#req-enterprise-008-enterprise-frontend-surface-suppression)

**Verification:** [ConfigureStep.test.tsx](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx) (AC1); [enterprise-surface-suppression.test.tsx](../../web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx) (AC2 — also covers REQ-ENTERPRISE-008 AC1–AC3, AC6); [Header.test.tsx](../../web-ui/src/__tests__/components/Header.test.tsx) (AC2/AC3 — also covers REQ-ENTERPRISE-008 AC2); [Dashboard.test.tsx](../../web-ui/src/__tests__/components/Dashboard.test.tsx) (AC2/AC3 — also covers REQ-ENTERPRISE-008 AC2)

**Status:** Implemented

---

### REQ-ENTERPRISE-016: Strict Gateway Egress

**Intent:** An enterprise admin can force the container's **direct-internet** HTTP/HTTPS egress through the customer's Cloudflare (Zero Trust) Gateway — over the Workers VPC `EGRESS` binding — with one setup-wizard toggle, so every agent call to the outside world is subject to the account's existing egress policies. Only THIS deployment's own Cloudflare account destinations (its R2 + account-scoped CF API / Browser Rendering) are exempt and egress direct — they are codeflare's own control-plane backends, not the agent's external reach; any OTHER account's host rides the Gateway, closing the cross-account exfiltration channel ([AD86](../../documentation/decisions/README.md#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network)). A deployment with the toggle OFF (the default) is byte-identical to today.

**Applies To:** System

**Acceptance Criteria:**

1. Existing enterprise setup persists a default-off strict-egress toggle explicitly as active or inactive, never writes it outside enterprise, and rejects enabling before write when `EGRESS` is unbound. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
2. `GET /api/setup/prefill` round-trips the toggle: a seeded `SETUP_KEYS.STRICT_EGRESS` prefills `true`, an absent key prefills `false`, and it is omitted from a non-enterprise prefill. <!-- @impl: src/routes/setup/handlers.ts::AccessGroupForPrefill --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (REQ-ENTERPRISE-016: strict gateway egress prefill) -->
3. The toggle is resolved by a single gate-then-read helper = enterprise mode AND KV `SETUP_KEYS.STRICT_EGRESS === 'active'`, defaulting OFF when the key is absent or when the KV read throws, and never reading KV in a non-enterprise deploy. <!-- @impl: src/lib/controller-egress.ts::hasStrictGatewayEgress --> <!-- @test: src/__tests__/lib/controller-egress.test.ts (REQ-ENTERPRISE-016: hasStrictGatewayEgress) -->
4. When the toggle is ON, the container DO wires the catch-all `interceptOutboundHttps('*', EgressController)` before the container starts (alongside, and lower-precedence than, the per-host LLM/GitHub registrations), so every otherwise-unintercepted host routes through the `EgressController`; when OFF or non-enterprise the catch-all is never wired. <!-- @impl: src/container/index.ts::wireEgressInterception --> <!-- @impl: src/container/index.ts::setupEnterpriseInterception --> <!-- @test: src/__tests__/container/index.test.ts (enterprise LLM interception wiring (REQ-ENTERPRISE-011)) -->
5. When the toggle is OFF or the deployment is non-enterprise, no catch-all is wired, the `GitHubInterceptor` transport swap is inert, no toggle KV read/write occurs outside enterprise, and the container egress path plus the configure request/response shape are byte-identical to today. <!-- @impl: src/lib/controller-egress.ts::hasStrictGatewayEgress --> <!-- @impl: src/container/index.ts::setupEnterpriseInterception --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
6. When strict egress is ON, the container is started with `enableInternet=false`, so the Containers platform allows only ports 80/443 + Cloudflare DNS and DENIES all raw TCP/UDP egress at the platform boundary the container cannot manipulate. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->

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

**Verification:** [setup persistence](../../src/__tests__/routes/setup.test.ts), [prefill](../../src/__tests__/routes/setup/handlers.test.ts), [setup store](../../web-ui/src/__tests__/stores/setup.test.ts), [container catch-all wiring + enableInternet](../../src/__tests__/container/index.test.ts), and [strict-gate resolver tests](../../src/__tests__/lib/controller-egress.test.ts). The `[[vpc_networks]]` `EGRESS` binding is deploy-time config (a Constraint: enterprise-only, committed commented-out and injected by `deploy.yml` when `ENTERPRISE_MODE=active`) — verified at deploy time, not unit-testable.

**Status:** Implemented

---

### REQ-ENTERPRISE-023: Strict Gateway Egress Controller Transport

**Intent:** When Strict Gateway Egress is active, the catch-all egress controller transparently proxies direct-internet traffic through the Gateway while preserving the deployment's own Cloudflare control-plane paths.

**Applies To:** System

**Acceptance Criteria:**

1. `EgressController` is a transparent proxy for every host EXCEPT this account's own R2: it stamps no `Authorization`/`cf-aig-*`/identity header, preserves the caller's `authorization`/`cookie` on the request and `set-cookie` on the response, strips only hop-by-hop headers, and forwards with `redirect:'manual'`. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @impl: src/lib/controller-egress.ts::controllerFetch --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-ENTERPRISE-016 / AD86: EgressController account-scoped exemption (own account direct, all else Gateway)) -->
2. **Account-scoped exemption.** Only destinations belonging to THIS deployment's own Cloudflare account egress **direct** via global `fetch`, never through `env.EGRESS`/`cf1:network`, even when the binding is bound: its R2 endpoint `<accountId>.r2.cloudflarestorage.com` and its account-scoped CF API path `api.cloudflare.com/client. <!-- @impl: src/lib/controller-egress.ts::isAccountScopedDestination --> <!-- @impl: src/lib/controller-egress.ts::isOwnAccountR2 --> <!-- @impl: src/lib/controller-egress.ts::controllerFetch --> <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @impl: src/lib/r2-client.ts::createR2Client --> <!-- @impl: src/container/index.ts::wireEgressInterception --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
3. **WebSocket proxying (bridged).** WebSocket upgrades reaching the `EgressController` catch-all are forwarded **transparently** through the account-scoped selector, then **bridged**: the controller `accept()`s the upstream `webSocket` and the server end of a fresh `WebSocketPair`, forwards messages/close/error in both directions. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @impl: src/lib/controller-egress.ts::controllerFetch --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-ENTERPRISE-016: EgressController bridges WebSocket upgrades (catch-all fallback)) -->
4. **Container holds no real R2 key (strict only).** When strict is active, `buildEnvVars` emits a non-secret placeholder R2 access key/secret into the container instead of the real key. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @impl: src/lib/constants.ts::ENTERPRISE_R2_KEY_PLACEHOLDER --> <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) -->
5. Before any upstream send, `EgressController` rejects SSRF targets — loopback, RFC 1918, link-local (incl. the `169.254.169.254` metadata endpoint), unspecified, and IPv6 literals — with `403 EGRESS_TARGET_BLOCKED` and performs no fetch. <!-- @impl: src/lib/controller-egress.ts::isDisallowedEgressHost --> <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/lib/controller-egress.test.ts (REQ-ENTERPRISE-016: isDisallowedEgressHost SSRF guard) -->
6. Unbound strict egress makes direct-internet and GitHub paths return `503 EGRESS_UNAVAILABLE` without fallback; this account's own platform destinations and LLM routing remain direct and independent of `EGRESS`. <!-- @impl: src/lib/controller-egress.ts::controllerFetch --> <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @impl: src/github-interceptor.ts::GitHubInterceptor --> <!-- @test: src/__tests__/lib/controller-egress.test.ts (REQ-ENTERPRISE-016: controllerFetch transport selection) -->

**Constraints:**

- `EgressController` remains a transparent proxy, not an identity-stamping interceptor.
- Only this deployment's own account-scoped Cloudflare control-plane destinations bypass `env.EGRESS`; other accounts ride the Gateway.
- Direct-internet failures fail closed when strict egress is active and the binding is unavailable.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress), [REQ-BROWSER-008](browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container)

**Verification:** [controller-egress resolver/transport/SSRF/account-scoped](../../src/__tests__/lib/controller-egress.test.ts), [EgressController transparent proxy + fail-closed + account-scoped passthrough + WebSocket](../../src/__tests__/egress-controller.test.ts), [container catch-all wiring + account-id prop](../../src/__tests__/container/index.test.ts), and [container env vars placeholder R2 key](../../src/__tests__/container/container-env.test.ts).

**Status:** Implemented

---

### REQ-ENTERPRISE-024: Strict Gateway Egress Host-Specific Interceptor Routing

**Intent:** Host-specific interceptors keep their credential-stamping responsibilities under Strict Gateway Egress: GitHub rides the Gateway, while Cloudflare AI Gateway remains a platform-native direct path.

**Applies To:** System

**Acceptance Criteria:**

1. Strict GitHub egress swaps only upstream transport to `env.EGRESS.fetch`; credential injection, no-spoof scoping, manual redirects, and response hygiene remain unchanged. Toggle-off traffic uses global fetch. <!-- @impl: src/github-interceptor.ts::GitHubInterceptor --> <!-- @test: src/__tests__/github-interceptor.test.ts (REQ-ENTERPRISE-016: strict gateway egress transport swap) -->
2. The `LlmInterceptor` does NOT swap — AI Gateway (`api.cloudflare.com` / `gateway.ai.cloudflare.com`) is a platform-native Cloudflare primitive, so its upstream forward ALWAYS egresses direct via global `fetch`, independent of the toggle and of `env.EGRESS` ([AD86](../../documentation/decisions/README.md#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network)). <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-016 / AD86: AI Gateway is platform-native — always direct egress, never cf1:network) -->

**Constraints:**

- GitHub is external direct-internet egress and fails closed when strict egress is active without an `EGRESS` binding.
- AI Gateway remains platform-native Cloudflare control-plane egress and never depends on the `EGRESS` binding.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress), [REQ-ENTERPRISE-023](#req-enterprise-023-strict-gateway-egress-controller-transport), [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)

**Verification:** [GitHub transport swap](../../src/__tests__/github-interceptor.test.ts) and [LLM always-direct (AI Gateway platform-native)](../../src/__tests__/llm-interceptor.test.ts).

**Status:** Implemented

---

### REQ-ENTERPRISE-017: AI Gateway Configured in the Setup Wizard

**Intent:** An enterprise admin can configure the customer's AI Gateway URL + token in the Setup wizard (persisted in KV, the token encrypted) instead of supplying them as deploy-time GitHub secrets, so a fresh enterprise deployment is configurable end-to-end from the wizard with no redeploy. The deploy-time secrets ([REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var)) remain an OPTIONAL fallback, so existing deployments keep working unchanged.

**Applies To:** Admin

**Acceptance Criteria:**

1. Enterprise setup accepts gateway URL and token, preserves each on blank, rejects token storage without encryption, and reports its progress step; non-enterprise setup writes neither. <!-- @impl: src/routes/setup/index.ts::app --> <!-- @test: src/__tests__/routes/setup.test.ts (Feature A/C: enterprise groups chip list + dynamic routes) -->
2. `GET /api/setup/prefill` round-trips the AI Gateway config (enterprise-only): it surfaces the non-secret `aigGatewayUrl` and a masked `aigTokenSet` boolean (never the token itself), reports unset/empty when nothing is stored, and omits both fields entirely in a non-enterprise prefill. <!-- @impl: src/routes/setup/handlers.ts::resolveAccountId --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->
3. A single resolver resolves the gateway URL + token wizard-first (KV) with the deploy-secret env as a per-field fallback, returns `undefined` for a field unset in both, and degrades to the env fallback (never throws) on a KV/crypto error at the container-start seam. <!-- @impl: src/lib/aig-config.ts::getAigConfig --> <!-- @test: src/__tests__/lib/aig-config.test.ts (getAigConfig (REQ-ENTERPRISE-017)) -->
4. The container DO resolves the gateway URL + token once and passes them to the `LlmInterceptor` via per-session props; the interceptor prefers the props and falls back to its own env only when a prop is absent. The token never enters the container. <!-- @impl: src/container/index.ts::wireLlmInterception --> <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-017: AI Gateway URL/token resolved from props (wizard) with env fallback) -->
5. The Setup wizard renders the enterprise-only AI Gateway URL + token fields inside an organized `SetupSection` group; they are not rendered outside enterprise mode, and their inputs route to the store's write-only `aigGatewayUrl`/`aigToken`. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/components/setup/SetupSection.tsx::SetupSection --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (ConfigureStep) -->
6. The "Configuring Codeflare" progress screen reflects the enterprise configuration steps it runs: the configure endpoint emits named `configure_*` steps (access groups, model routing, AI gateway, browser rendering, strict egress), and the progress UI maps each to a friendly label. <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->

**Notes:** Manual verification procedures are documented in the [security checklist](../../documentation/lanes/security.md#manual-verification-checklist).

**Constraints:**

- The token is a secret: stored encrypted (kv-crypto, same shape as the Browser Rendering token, [REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)), masked on prefill, no-clobber on blank, and never returned to the client; The URL is non-secret and stored plain.
- URL and token resolve independently with wizard KV before deploy secrets, allowing mixed sources while deploy secrets remain a silent fallback ([REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var) AC1).
- Grouping fields into `SetupSection`s preserves every field, store binding, and conditional gate; only visual grouping changes.
- `SetupSection` is a reusable structure-only component with no copy.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var), [REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-ENTERPRISE-018: Governed Mode Toggle and Configuration Surface

**Intent:** In enterprise, bucket data is corporate-owned and the company must be able to scan agent config (skills, hooks, extensions) for malicious content with its own security tooling. By default every R2 object is encrypted with SSE-C (`ENCRYPTION_KEY`), so the bucket is opaque even to the company. An enterprise admin can enable **Governed Mode** — a deployment-wide, KV-backed toggle (no redeploy) that disables R2 SSE-C so objects use R2's default at-rest encryption and stay readable/scannable by R2-credential holders. Default OFF (SSE-C on); when off, behavior is byte-identical to before. The toggle is configured from the Setup wizard behind an explicit admin confirmation and forwarded to each session's container as the resolved regime, which drives the re-encrypt migration in [REQ-ENTERPRISE-020](#req-enterprise-020-governed-mode-re-encrypt-migration-engine).

**Applies To:** Admin

**Acceptance Criteria:**

1. `POST /api/setup/configure` accepts an enterprise-only `r2SseDisabled` boolean, persisted `'active'`/`'inactive'` at `SETUP_KEYS.R2_SSE_DISABLED` and surfaced as a `configure_r2_sse` progress step; a non-enterprise configure never writes it. `GET /api/setup/prefill` round-trips it. <!-- @impl: src/routes/setup/index.ts::app --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
2. SSE helpers suppress headers for disabled buckets; every writer follows the bucket's committed regime, while readers use dual-regime fallback throughout migration. <!-- @impl: src/lib/r2-sse.ts::getSseHeaders --> <!-- @impl: src/lib/r2-sse.ts::getSseCopyHeaders --> <!-- @impl: src/lib/r2-regime-state.ts::isR2SseDisabledForBucket --> <!-- @impl: src/lib/r2-seed.ts::seedDocuments --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (regime helpers (REQ-ENTERPRISE-018)) -->
3. The bucket's resolved regime is forwarded to the container as `R2_SSE_DISABLED`, and the entrypoint omits the SSE-C block from rclone.conf and re-enables checksums when it is set. `buildEnvVars` ALSO omits `ENCRYPTION_KEY` itself in Governed Mode. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @impl: src/container/container-env.ts::applyBucketName --> <!-- @impl: src/container/container-env.ts::applyPrefsOnRestart --> <!-- @impl: entrypoint.sh::create_rclone_config --> <!-- @test: src/__tests__/container/container-env.test.ts (applyBucketName / applyPrefsOnRestart propagate userTimezone (REQ-SESSION-016 AC3 wiring regression) / REQ-AGENT-029 (container env vars contract)) -->
4. The Setup wizard renders an enterprise-only Governed Mode toggle (default off, not rendered outside enterprise) whose change requires an explicit admin confirmation of the re-encrypt consequence before it flips the store value. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (ConfigureStep) -->

**Constraints:**

- `ENCRYPTION_KEY` has three orthogonal roles — R2 SSE-C, vault HKDF master, and secret-at-rest KV crypto; Governed Mode gates ONLY the R2 SSE-C path (`getSseHeaders`/`getSseCopyHeaders`); vault and secret-at-rest crypto are untouched, so disabling SSE-C never weakens secret storage or the vault.
- Deployment-wide policy stored in KV (no redeploy to flip), mirroring [REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress); With Governed Mode off (the default) all SSE-C behavior, seeding, and sync are byte-identical to before.

**Priority:** P2

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** [wizard persistence](../../src/__tests__/routes/setup.test.ts) + [prefill](../../src/__tests__/routes/setup/handlers.test.ts) (AC1), [SSE-C gate](../../src/__tests__/lib/r2-sse.test.ts) + [regime helpers](../../src/__tests__/lib/r2-migration.test.ts) (AC2), [container env propagation](../../src/__tests__/container/container-env.test.ts) + [ENCRYPTION_KEY omission](../../src/__tests__/container/container-env-llm.test.ts) + [rclone.conf branch](../../host/__tests__/entrypoint-governed-sync.test.js) (AC3), [wizard toggle + confirmation](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx) + [setup store](../../web-ui/src/__tests__/stores/setup.test.ts) (AC4)

**Status:** Implemented

---

### REQ-ENTERPRISE-020: Governed Mode Re-Encrypt Migration Engine

**Intent:** Flipping [REQ-ENTERPRISE-018](#req-enterprise-018-governed-mode-toggle-and-configuration-surface)'s Governed Mode toggle must reconcile every existing bucket to the new SSE-C regime **losslessly** (in-place server-side re-encryption, never a nuke) rather than forcing an admin to accept data loss or a manual migration. The reconcile is a per-bucket **state machine** (`r2-regime:<bucket>`) driven in the background by the dashboard's `batch-status` poll, in resumable chunks verified before the regime commits. The safety boundary around this engine — write gate, container drain, dual-regime reads, and the zero-secret container footprint — is [REQ-ENTERPRISE-021](#req-enterprise-021-governed-mode-migration-safety-and-access-boundary).

**Applies To:** Admin

**Acceptance Criteria:**

1. Re-encryption uses conditional same-key server copy, preserving metadata and ETag while applying source and destination SSE-C headers; success requires a parsed result ETag without an embedded error. <!-- @impl: src/lib/r2-migration.ts::migrateBucketEncryption --> <!-- @impl: src/lib/r2-sse.ts::computeKeyMd5 --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (migrateBucketEncryption (lossless REPLACE re-encrypt)) -->
2. That same source-regime HEAD is the idempotency check: a `400`/`403` SSE-mismatch means the object already reads in the target regime and is skipped ([AD91](../../documentation/decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile)). An object over the 5 GB single-`CopyObject` limit is recorded `oversized` and skipped. <!-- @impl: src/lib/r2-migration.ts::migrateBucketEncryption --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (migrateBucketEncryption (lossless REPLACE re-encrypt)) -->
3. Each poll advances ready, migrating, and mixed-recovery bucket state: policy drift starts migration only without a healthy container, otherwise remaining pending. <!-- @impl: src/lib/r2-regime-state.ts::getRegimeState --> <!-- @impl: src/lib/r2-migration.ts::planRegimeReconcile --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (REQ-ENTERPRISE-020: Governed Mode reconcile + chunk advance on batch-status) -->
4. Each poll's background work scans the bucket in `LIST_PAGE_SIZE`-sized pages (up to 1,000 keys), re-encrypting each page in `MIGRATION_CONCURRENCY`-sized slices (6). Per-object failures are isolated, and each R2 op runs under an `AbortController` timeout. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->
5. The `cursor` is a `start-after` key checkpointed after every chunk. Each invocation starts another list+slice only while one more fits its ~22s work deadline (`WORK_DEADLINE_MS`), then releases the `leaseExpiresAt` lock before exit ([AD91](../../documentation/decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile)). <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->
6. The migrate→verify transition happens within one invocation: migrate re-encrypts, verify HEAD-scans every object, and the regime plus `generation` advance only after a clean full verify. A failed chunk never throws — it records `lastError` and releases the lease for retry. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->
7. The bucket's object `total` is counted once (list-only, ≤ `COUNT_LIST_CAP` pages) at drain, and `processed` accumulates across both passes; `batch-status` derives `bucketMigrationPercent` = round(processed/(2·total)·100), omitted until `total` is known. A `halted` state (verify-retry ceiling or key-rotation) also suppresses the percent. <!-- @impl: src/lib/r2-migration.ts::advanceMigration --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (advanceMigration (chunked, verified, self-healing)) -->

**Constraints:**

- The migration is lossless — bytes never leave R2, and metadata is re-supplied via `MetadataDirective=REPLACE`; a >5 GB object exceeds the single-`CopyObject` limit and is recorded + skipped.
- The migration is slice-chunked and `start-after`-resumable across `batch-status` polls, and the regime commits only after a full verify HEAD-scan; a crashed lease expires and the next poll resumes safely ([AD91](../../documentation/decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile)).
- Termination is guaranteed: verify skips the same oversized objects migrate skips, per-object failures are isolated, and the bounded migrate↔verify retry (`MAX_VERIFY_RETRIES`) halts an unfixable object for admin review.
- Session creation never migrates a bucket — it only resolves the committed regime, and a new bucket adopts the current policy immediately.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-018](#req-enterprise-018-governed-mode-toggle-and-configuration-surface), [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket)

**Verification:** [REPLACE copy + idempotent/oversized skip](../../src/__tests__/lib/r2-migration.test.ts) (AC1-2), [state machine + reconcile decision](../../src/__tests__/lib/r2-migration.test.ts) + [chunk-advance wiring](../../src/__tests__/routes/session-batch-status.test.ts) (AC3), [chunked scan driver (list/slice, timeout, cursor, deadline, lease release)](../../src/__tests__/lib/r2-migration.test.ts) (AC4-5), [migrate→verify transition + progress %](../../src/__tests__/lib/r2-migration.test.ts) + [batch-status wiring](../../src/__tests__/routes/session-batch-status.test.ts) (AC6-7), [session-start lazy-create path](../../src/__tests__/lib/r2-migration.test.ts) + [ensureBucketAndSeed](../../src/__tests__/routes/container-lifecycle-helpers.test.ts) (Constraints)

**Status:** Implemented

---

### REQ-ENTERPRISE-021: Governed Mode Migration Safety and Access Boundary

**Intent:** While a bucket's regime migrates ([REQ-ENTERPRISE-020](#req-enterprise-020-governed-mode-re-encrypt-migration-engine)), the system must stay correct and safe for concurrent access: writers are backend-gated so nothing lands in the wrong regime, running containers are drained, reads stay up via a dual-regime fallback with self-heal for any stray object, and the dashboard reflects migration progress. Under strict Gateway egress ([REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress)) together with Governed Mode, this boundary also keeps the container's real-secret footprint down to just the DO-issued `CONTAINER_AUTH_TOKEN`.

**Applies To:** Admin

**Acceptance Criteria:**

1. **Zero-secret invariant.** Under strict Gateway egress ([REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress)) and Governed Mode together, the container's only real secret is the DO-issued `CONTAINER_AUTH_TOKEN`: R2, GitHub, and Browser Rendering credentials are non-secret placeholders, `ENCRYPTION_KEY` is omitted, and `AWS_*` plus per-user LLM keys are never emitted. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (container secret hygiene: no AWS_* anywhere, CF token placeholder-only in enterprise) -->
2. While a bucket's state is not `ready`, every R2 writer (container `/start`, upload, reseed, preference reconcile) rejects `409 BUCKET_MIGRATING`, and the sync fan-out returns empty. On migration start, running containers are drained once and in-flight multipart uploads are aborted. <!-- @impl: src/lib/error-types.ts::BucketMigratingError --> <!-- @impl: src/lib/r2-regime-state.ts::isBucketMigrating --> <!-- @impl: src/lib/migration-containers.ts::drainContainers --> <!-- @impl: src/lib/sync-fanout.ts::fanOutBisyncTrigger --> <!-- @test: src/__tests__/routes/sessions-sync.test.ts (skips the entire fan-out while the bucket is migrating (no container is contacted)) -->
3. The dashboard reuses the REQ-AGENT-049 "Upgrading" affordance: `batch-status` returns `bucketMigrating` plus a 0–99 `bucketMigrationPercent` (omitted while `halted`), and the New Session button disables and labels "Migrating N%". Both the full session load and the 5s background poll mirror these flags. <!-- @test: web-ui/src/__tests__/stores/session.test.ts (Session Store) -->
4. Read paths (download, preview) try the committed regime first and fall back once to the opposite regime on a `400`/`403` SSE-mismatch, so a partially-migrated bucket stays readable. <!-- @impl: src/lib/r2-migration.ts::fetchObjectWithRegimeFallback --> <!-- @impl: src/lib/r2-regime-state.ts::resolveReadRegime --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (fetchObjectWithRegimeFallback (D2 reads stay up)) -->
5. A fallback hit on a `ready` bucket schedules a one-time `mixed-recovery` scan that re-encrypts every stray cross-regime object to the committed regime and returns to `ready` without changing the regime or generation. <!-- @impl: src/lib/r2-migration.ts::markMixedRecovery --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (fetchObjectWithRegimeFallback (D2 reads stay up)) -->

**Notes:** Manual verification procedures are documented in the [security checklist](../../documentation/lanes/security.md#manual-verification-checklist).

**Constraints:**

- The backend gate + container drain are the safety boundary; a container regime generation guard was deliberately not built ([AD91](../../documentation/decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile)) — the verify-rescan + read self-heal catch any stray write.
- `mixed-recovery` respects D1 (no force-kill); key rotation is detect-only, with no old-key fallback.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-020](#req-enterprise-020-governed-mode-re-encrypt-migration-engine), [REQ-ENTERPRISE-018](#req-enterprise-018-governed-mode-toggle-and-configuration-surface), [REQ-ENTERPRISE-016](#req-enterprise-016-strict-gateway-egress), [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-SEC-005](security.md#req-sec-005-r2-files-encrypted-at-rest-with-sse-c-when-operator-configures-an-encryption-key), [REQ-BROWSER-008](browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-ENTERPRISE-019: View-Only Storage (download disable)

**Intent:** An enterprise admin can switch the R2 Storage Panel to view-only with one Setup-wizard toggle, so users and agents can open/view files but cannot download them — blocking bulk exfiltration of bucket contents (e.g. zipping a repo and downloading it). Default OFF; non-enterprise modes are byte-identical to today.

**Applies To:** System

**Acceptance Criteria:**

1. The Setup wizard exposes an enterprise-gated view-only-storage toggle, default OFF, persisted to KV `SETUP_KEYS.DOWNLOADS_DISABLED` as `'active'`/`'inactive'` through the existing `POST /api/setup/configure` (no new endpoint); a non-enterprise configure never writes it. <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
2. `GET /api/setup/prefill` round-trips the toggle: a seeded `SETUP_KEYS.DOWNLOADS_DISABLED` prefills `true`, an absent key prefills `false`, and it is omitted from a non-enterprise prefill. <!-- @impl: src/routes/setup/handlers.ts::AccessGroupForPrefill --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) -->
3. Active enterprise view-only policy runs before R2 access: attachments and non-viewable inline types return distinct `403 DOWNLOADS_DISABLED`; text, Markdown, HTML-as-text, images, and PDF remain inline. The resolver never reads policy outside enterprise. <!-- @impl: src/routes/storage/download.ts::isInlineViewable --> <!-- @impl: src/lib/error-types.ts::DownloadsDisabledError --> <!-- @impl: src/lib/downloads-policy.ts::isDownloadsDisabled --> <!-- @test: src/__tests__/routes/storage-download.test.ts (Storage Download Routes) -->
4. `GET /api/user` returns `downloadsDisabled` so the client renders the Storage Panel download controls as **blocked** visible but disabled-looking and still tappable and any interaction opens a notice that downloads are disabled by the administrator instead of fetching. <!-- @impl: web-ui/src/lib/schemas.ts::UserResponseSchema --> <!-- @impl: web-ui/src/lib/download.ts::downloadFile --> <!-- @impl: web-ui/src/stores/storage.ts::storageStore --> <!-- @impl: web-ui/src/stores/storage.ts::refreshDownloadsDisabled --> <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (StorageBrowser / REQ-STOR-016 AC1/AC2 (file browser drawer/bottom-sheet presentation, R2 as source of truth via Worker API)) -->
5. When the toggle is OFF or the deployment is non-enterprise, no KV read occurs outside enterprise and the storage download path and the configure request/response shape are byte-identical to today; the toolbar download control renders and behaves exactly as before (downloads succeed). <!-- @impl: src/lib/downloads-policy.ts::isDownloadsDisabled --> <!-- @test: src/__tests__/routes/storage-download.test.ts (Storage Download Routes) -->

**Constraints:**

- Enforcement is **server-side** in `download.ts`; the frontend blocked-control + notice are convenience only, so a prompt-injected agent cannot bypass the policy by crafting the download URL.
- The toggle is written explicitly (`'active'`/`'inactive'`, no delete-on-off) so it round-trips deterministically; default OFF on an absent key; Enterprise-gated like the other Setup toggles (`isDownloadsDisabled` never reads KV in a non-enterprise deploy; a transient KV error defaults OFF so storage stays usable).
- Scope is **download (exfil) only**: upload and delete are intentionally unaffected (they are not exfiltration vectors).

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-SEC-013](security.md#req-sec-013-content-disposition-hardening-on-downloads)

**Verification:** [download guard + isInlineViewable](../../src/__tests__/routes/storage-download.test.ts) (AC2, AC4), [setup persistence](../../src/__tests__/routes/setup.test.ts) + [prefill](../../src/__tests__/routes/setup/handlers.test.ts) (AC1, AC1a), [setup store](../../web-ui/src/__tests__/stores/setup.test.ts) + [wizard toggle](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx) (AC1), [view-only download guard + downloads-enabled baseline](../../web-ui/src/__tests__/components/StorageBrowser.test.tsx) (AC3, AC4), [downloadFile server-truth backstop](../../web-ui/src/__tests__/lib/download.test.ts) (AC3), [blocked preview control](../../web-ui/src/__tests__/components/FilePreview.test.tsx) + [disabled notice](../../web-ui/src/__tests__/components/DownloadsDisabledPopup.test.tsx) + [notice store flag](../../web-ui/src/__tests__/stores/storage.test.ts) + [response-schema field survival](../../web-ui/src/__tests__/api/contract.test.ts) (AC3).

**Status:** Implemented
