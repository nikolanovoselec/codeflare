# Enterprise Mode Domain Specification

Deploy-time enterprise configuration: single-tenant unlimited access, subscription bypass, and platform outbound-HTTPS interception that routes agent LLM traffic to a customer-owned AI Gateway with no credential ever placed in the container.

### Key Concepts

| Concept | Definition |
|---------|-----------|
| Enterprise Mode | A deploy-time configuration, toggled by the `ENTERPRISE_MODE` Worker var, that turns a Codeflare deployment into a single-tenant enterprise instance: every user resolves to the `unlimited` tier in Pro (advanced) session mode and subscription/billing is disabled |
| AI Gateway | The customer's Cloudflare AI Gateway endpoint that fronts the upstream LLM providers; its URL and token are held only in the Worker/interceptor env as secrets (`AIG_GATEWAY_URL`, `AIG_TOKEN`) |
| LLM Interceptor | A `WorkerEntrypoint` (`LlmInterceptor`) the container DO wires into container egress via `ctx.container.interceptOutboundHttps`; it receives the container's outbound HTTPS to the real provider hosts at the platform level (never the public internet, never Cloudflare Access), maps each onto the gateway provider path, and forwards with gateway auth + per-user attribution stamped on |
| Outbound Interception | The Cloudflare Containers platform mechanism (`interceptOutboundHttps` + `ctx.exports`, on by default at this project's compat date — the `enable_ctx_exports` flag became the default on 2025-11-17, so no flag is set) that routes a container's matching egress hostnames through a `WorkerEntrypoint` with no credential, URL, or token in the container |
| Per-User Attribution | The opaque per-user bucket id passed to the interceptor as a per-session DO prop and stamped as `cf-aig-metadata.user` (never an email) so usage is correlatable in the gateway |

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
| Agents | Session-mode resolution forces Pro mode and the agent roster is narrowed (see [REQ-AGENT-004](agents.md#req-agent-004-two-session-modes-standard-and-pro)); the container env pipeline emits only the `ENTERPRISE_MODE` flag (see [REQ-AGENT-031](agents.md#req-agent-031-llm-api-key-propagation-to-container)), and entrypoint.sh points each agent at the constant provider base-URLs |
| Setup | `ENTERPRISE_MODE`, `AIG_GATEWAY_URL`, and `AIG_TOKEN` are configured at deploy time alongside the existing deployment-mode bindings (see [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes)) |
| Security | LLM traffic leaves the container only via platform interception to the interceptor `WorkerEntrypoint`; the gateway URL/token live solely in the interceptor env, never in the container, and the interception never traverses Cloudflare Access |

---

<!-- @test: src/__tests__/lib/enterprise-mode.test.ts (resolveEnterpriseMode describe -> ENTERPRISE_MODE flag forces unlimited tier + advanced session mode + subscription disabled -> AC1..AC4; flag-unset parity describe -> tier/mode/subscription resolution byte-identical to baseline across Default/Onboarding/SaaS -> AC5) -->
<!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (enterprise bypass describe -> unlimited session cap AC3 — enterprise resolves unlimited cap not stored free-tier cap) -->
### REQ-ENTERPRISE-001: ENTERPRISE_MODE Forces Unlimited Tier and Pro Mode

<!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->
<!-- @impl: src/lib/subscription.ts -->
<!-- @impl: src/lib/session-mode.ts::resolveSessionMode -->

**Intent:** A deploy-time `ENTERPRISE_MODE` flag must turn a deployment into a single-tenant enterprise instance where every user gets full access without subscription friction.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, every user's effective tier resolves to `unlimited` regardless of the stored `subscriptionTier`.
2. When `ENTERPRISE_MODE` is set, session-mode resolution returns Pro (`advanced`) for every user regardless of the stored preference.
3. When `ENTERPRISE_MODE` is set, every user is treated as a custom `unlimited` user: the unlimited tier's session cap applies (not the stored tier's), the monthly compute quota (timekeeper) is never enforced, and billing-status checks and trial logic are disabled — no user is ever blocked on a payment, quota, or time-limit condition.
4. The flag is read from a single resolver; all callers consult the resolver rather than reading the raw binding.
5. When `ENTERPRISE_MODE` is unset, tier resolution, session-mode resolution, and subscription enforcement are byte-identical to current behavior across the Default, Onboarding, and SaaS deployment modes.

**Constraints:**

- The flag is read at deploy time from a Worker binding, not from request data, so it cannot be toggled per request.
- When the flag is unset there is no new code path: every enterprise branch is gated behind the resolver returning false.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](subscription.md#req-sub-001-eight-tier-subscription-system), [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier), [REQ-AGENT-004](agents.md#req-agent-004-two-session-modes-standard-and-pro)

**Verification:** [Automated test](../../src/__tests__/lib/enterprise-mode.test.ts)

**Status:** Planned

---

<!-- @test: src/__tests__/lib/enterprise-mode.test.ts (subscribe-surface gating describe -> billing UI hidden + /app/subscribe returns guarded response when enterprise + unchanged when flag unset -> AC1..AC4) -->
### REQ-ENTERPRISE-002: Subscription UI Hidden and Subscribe Route Guarded

<!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->
<!-- @impl: web-ui/src/components -->
<!-- @impl: src/routes -->

**Intent:** When the deployment is in Enterprise Mode there is no self-serve billing, so the subscription UI and the subscribe route must not be reachable.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, the subscription/billing settings surfaces (tier display, plan switching, usage-quota controls) are hidden in the frontend.
2. When `ENTERPRISE_MODE` is set, the `/app/subscribe` route is guarded so it does not render the tier-selection or checkout flow.
3. The frontend determines whether to hide billing surfaces from a deploy-time mode signal, not from the user's tier.
4. When `ENTERPRISE_MODE` is unset, the subscription UI and `/app/subscribe` behave byte-identically to current behavior.

**Constraints:**

- Guarding the subscribe route must not break links from non-enterprise deployments; the guard is conditional on the resolver.
- Hiding the billing UI does not delete a user's stored tier; the field is retained and simply unused while the flag is set.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-SUB-016](subscription.md#req-sub-016-customer-portal-and-plan-switching), [REQ-SUB-017](subscription.md#req-sub-017-enterprise-tier-contact-flow)

**Verification:** [Automated test](../../src/__tests__/lib/enterprise-mode.test.ts)

**Status:** Planned

---

<!-- @test: src/__tests__/routes/session-agent-allowlist.test.ts (enterprise agent allowlist describe -> session creation accepts only copilot/pi/bash when enterprise + rejects the other four (claude-code/codex/antigravity/opencode) + accepts all seven when flag unset -> AC1..AC4) -->
### REQ-ENTERPRISE-003: Agent Allowlist in Enterprise Mode

<!-- @impl: src/lib/agent-allowlist.ts::allowedAgents -->
<!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->
<!-- @impl: src/routes/session/crud.ts -->
<!-- @impl: src/types.ts::AgentTypeSchema -->

**Intent:** Enterprise deployments standardize on a curated agent set, so session creation must restrict the selectable agents when the flag is set.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, the selectable agent set is exactly `{copilot, pi, bash}`.
2. When `ENTERPRISE_MODE` is set, session creation rejects any agent type outside the enterprise allowlist.
3. When `ENTERPRISE_MODE` is set, the session-creation UI offers only the allowlisted agents.
4. When `ENTERPRISE_MODE` is unset, all seven agent types from [REQ-AGENT-001](agents.md#req-agent-001-support-multiple-ai-coding-agents) remain selectable, byte-identical to current behavior.

**Constraints:**

- The allowlist is applied on top of the existing agent-type validation; it narrows the set rather than replacing the schema.
- The enterprise allowlist is a fixed set, not admin-configurable, in this domain.
- The set is OpenAI-wire-format agents only (plus `bash`): their traffic routes through the AI Gateway REST API ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)). Claude Code is excluded because it speaks the Anthropic-native wire format, which the gateway REST transport does not carry ([AD74](../../documentation/decisions/README.md)).

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-AGENT-001](agents.md#req-agent-001-support-multiple-ai-coding-agents), [REQ-AGENT-002](agents.md#req-agent-002-agent-selection-at-session-creation)

**Verification:** [Automated test](../../src/__tests__/routes/session-agent-allowlist.test.ts)

**Status:** Planned

---

<!-- @test: src/__tests__/llm-interceptor.test.ts (LlmInterceptor describe -> api.openai.com mapped onto the AI Gateway REST API (api.cloudflare.com/.../ai/v1/*) with account+gateway parsed from AIG_GATEWAY_URL + Authorization Bearer AIG_TOKEN + cf-aig-gateway-id + cf-aig-metadata stamped with opaque user + placeholder auth replaced + streaming preserved + unmapped host (incl. api.anthropic.com) 400 + gateway-unset/unparseable 503 -> AC1..AC7) -->
<!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (enterprise bypass describe -> monthly compute quota never enforced AC3 — enterprise users are never blocked by the monthly compute quota) -->
### REQ-ENTERPRISE-004: Outbound-Interception LLM Routing to Customer AI Gateway

<!-- @impl: src/llm-interceptor.ts::LlmInterceptor -->
<!-- @impl: src/container/index.ts::setupEnterpriseInterception -->
<!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->

**Intent:** Enterprise deployments route all agent LLM traffic to the customer's AI Gateway via platform outbound-HTTPS interception, so the gateway credentials never reach the container, nothing is exposed over a public route, and all usage is attributable.

**Applies To:** User

**Acceptance Criteria:**

1. The container DO routes the container's outbound HTTPS to the real LLM provider host (`api.openai.com`) through a `WorkerEntrypoint` (`LlmInterceptor`) via `ctx.container.interceptOutboundHttps` + `ctx.exports`; the interceptor forwards each request to the customer's AI Gateway **REST API** (`https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/*`), mapping the OpenAI path verbatim under `/ai`.
2. The AI Gateway URL and token are read only from the interceptor's Worker env (`AIG_GATEWAY_URL`, `AIG_TOKEN`) and are never sent to or readable from the container; there is no public Worker route carrying LLM traffic, so the path never traverses Cloudflare Access. The account id (URL path) and gateway id (`cf-aig-gateway-id` header) are parsed from `AIG_GATEWAY_URL`.
3. Streaming responses are preserved end-to-end (the upstream stream is piped through without buffering the full body).
4. Each forwarded request stamps the standard `Authorization: Bearer <AIG_TOKEN>` header (the REST API gateway auth), `cf-aig-gateway-id` with the gateway id, and `cf-aig-metadata` with an opaque per-user identifier (the bucket id, passed as a per-session DO prop) that does not expose the user's email or raw identity.
5. The container's placeholder credential (`Authorization` / `x-api-key`) is stripped before forwarding so it never reaches the gateway; gateway auth is stamped separately.
6. The interceptor maps only the known provider host (`api.openai.com`); an unmapped host (including `api.anthropic.com`, which is not an enterprise agent host) fails closed (400) and an unconfigured/unparseable gateway fails closed (503) — neither forwards anywhere.
7. When `ENTERPRISE_MODE` is unset, the DO never wires interception, the interceptor is never instantiated, and agent LLM traffic follows the current direct-key path, byte-identical to current behavior.

**Constraints:**

- Interception uses the Cloudflare Containers platform mechanism (`interceptOutboundHttps` + `ctx.exports`, on by default at this project's compat date — the `enable_ctx_exports` flag became the default on 2025-11-17, so no flag is set); HTTPS interception requires the container to trust the CA at `/etc/cloudflare/certs/cloudflare-containers-ca.crt` ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls)).
- The opaque per-user id is the deterministic bucket id so requests from one user are correlatable in the gateway without revealing the identity.
- The set of intercepted provider hosts is fixed in code; adding a provider requires a code change, not a request parameter.
- The transport target is the AI Gateway REST API (`api.cloudflare.com`), not the deprecated `gateway.ai.cloudflare.com` `/compat` + provider-native paths ([AD74](../../documentation/decisions/README.md)). Because the enterprise agents are OpenAI-wire-format only ([REQ-ENTERPRISE-003](#req-enterprise-003-agent-allowlist-in-enterprise-mode)), the interceptor forwards the request body unchanged — no model rewrite. Backend selection (native provider, Amazon Bedrock, Workers AI, or a dynamic route) is gateway-side via the agent's configured model id.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var)

**Verification:** [Automated test](../../src/__tests__/llm-interceptor.test.ts)

**Status:** Planned

---

<!-- @test: src/__tests__/container/container-env-llm.test.ts (enterprise env injection describe -> ENTERPRISE_MODE emitted from env when active + COPILOT_MODEL/PI_MODEL both fanned out from AIG_LANGUAGE_MODEL when set + no gateway URL/token/base-URL ever injected + all omitted when flag unset/non-active -> AC1..AC5) -->
### REQ-ENTERPRISE-005: Container-Side Enterprise Routing (CA Trust + Constant Base-URLs)

<!-- @impl: src/container/container-env.ts::buildEnvVars -->
<!-- @impl: entrypoint.sh -->
<!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->

**Intent:** Agents in Enterprise Mode must be work-ready against the AI Gateway with zero manual login and zero injected credentials, so the container only learns it is in enterprise mode and configures itself to use the intercepted provider hosts.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, the container env pipeline emits the enterprise flag `ENTERPRISE_MODE=active` plus, when the operator deploy var `AIG_LANGUAGE_MODEL` is set, the non-secret container model ids `COPILOT_MODEL` / `PI_MODEL` (both fanned out from that single var) — all derived directly from Worker deploy vars. No per-session base-URL or token is ever injected.
2. When `ENTERPRISE_MODE=active`, entrypoint.sh installs the Cloudflare containers CA (`/etc/cloudflare/certs/cloudflare-containers-ca.crt`) into the system trust store and exports the Node/Python CA env hooks so the agents' HTTPS clients trust the intercepted (TLS-terminated) connections.
3. When `ENTERPRISE_MODE=active`, entrypoint.sh points each enterprise agent at the constant real provider base-URL (`api.openai.com`) with a non-secret placeholder credential: Copilot via `COPILOT_PROVIDER_BASE_URL`/`COPILOT_PROVIDER_API_KEY`, Pi via its `models.json` provider — so each CLI enters API mode without a login step. When the operator sets `AIG_LANGUAGE_MODEL` (fanned out to the container's `COPILOT_MODEL` / `PI_MODEL`), each agent is pinned to that gateway model/route (e.g. `dynamic/<route>`); when unset, each agent uses its own default model id. Claude Code is not configured (excluded from the enterprise agent set — [REQ-ENTERPRISE-003](#req-enterprise-003-agent-allowlist-in-enterprise-mode)).
4. The container never receives the AI Gateway URL, the gateway token, or any per-session secret; routing to the gateway is done entirely by the DO's outbound interception ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)).
5. When `ENTERPRISE_MODE` is unset, neither `ENTERPRISE_MODE` nor `COPILOT_MODEL` / `PI_MODEL` is emitted (even if `AIG_LANGUAGE_MODEL` is set), the entrypoint.sh block is skipped, and the container env is byte-identical to current behavior.

**Constraints:**

- The placeholder credential is a fixed non-secret constant; the interceptor strips it before forwarding ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC5), so it never reaches the gateway.
- `ENTERPRISE_MODE` rides the existing container env pipeline ([REQ-AGENT-031](agents.md#req-agent-031-llm-api-key-propagation-to-container)); no per-agent login step is added.
- `AIG_LANGUAGE_MODEL` (fanned out to the container's `COPILOT_MODEL` / `PI_MODEL`) is a non-secret routing hint (a gateway model id / dynamic-route name), not a credential; it selects which backend the gateway uses but carries no secret. Backend keys stay in the gateway (BYOK).
- Only the allowlisted enterprise agents ([REQ-ENTERPRISE-003](#req-enterprise-003-agent-allowlist-in-enterprise-mode)) are configured; `bash` needs no LLM configuration.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-AGENT-031](agents.md#req-agent-031-llm-api-key-propagation-to-container)

**Verification:** [Automated test](../../src/__tests__/container/container-env-llm.test.ts)

**Status:** Planned

---

<!-- @test: src/__tests__/lib/enterprise-mode.test.ts (deploy-time plumbing describe -> AIG_GATEWAY_URL + AIG_TOKEN read as secrets + ENTERPRISE_MODE read as var + off by default when binding absent -> AC1..AC4) -->
### REQ-ENTERPRISE-006: Deploy-Time AIG Secrets and ENTERPRISE_MODE Var

<!-- @impl: wrangler.toml -->
<!-- @impl: .github/workflows/deploy.yml -->
<!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->

**Intent:** Enterprise configuration must be supplied at deploy time through Worker bindings, kept secret where appropriate, and default to off.

**Applies To:** Admin

**Acceptance Criteria:**

1. `AIG_GATEWAY_URL` and `AIG_TOKEN` are configured as Worker secrets so they are not stored in plaintext config or exposed to the container.
2. `ENTERPRISE_MODE` is configured as a Worker var (non-secret) read by the enterprise-mode resolver. The optional model id `AIG_LANGUAGE_MODEL` is likewise a non-secret Worker var, passed at deploy time and fanned out to the container's `COPILOT_MODEL` / `PI_MODEL` only in enterprise mode ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC1).
3. Enterprise Mode is off by default: an absent or empty `ENTERPRISE_MODE` binding resolves to disabled.
4. When `ENTERPRISE_MODE` is enabled, the interceptor fails closed (503) if the `AIG_GATEWAY_URL` secret is missing or unparseable (no `/v1/{account_id}/{gateway_id}` segments), rather than silently routing to nowhere, and the DO logs a warning when it skips interception wiring.

**Constraints:**

- The flag is evaluated at deploy time from bindings, consistent with the deployment-mode determination in [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes).
- Secrets are never written to the container env; the enterprise env vars the container receives are the `ENTERPRISE_MODE` flag and, when `AIG_LANGUAGE_MODEL` is set, the non-secret model-id vars `COPILOT_MODEL` / `PI_MODEL` — all derived from Worker deploy vars, never from session state ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC1).
- `AIG_GATEWAY_URL` is the single source for the gateway coordinates: the interceptor parses the account id and gateway id from it for the REST API call ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC2), so no separate account-id binding is required.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes)

**Verification:** [Automated test](../../src/__tests__/lib/enterprise-mode.test.ts)

**Status:** Planned
