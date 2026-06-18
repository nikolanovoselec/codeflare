# Enterprise Mode Domain Specification

Deploy-time enterprise configuration: single-tenant unlimited access, subscription bypass, and platform outbound-HTTPS interception that routes agent LLM traffic to a customer-owned AI Gateway with no credential ever placed in the container.

### Key Concepts

| Concept | Definition |
|---------|-----------|
| Enterprise Mode | A deploy-time configuration, toggled by the `ENTERPRISE_MODE` Worker var, that turns a Codeflare deployment into a single-tenant enterprise instance: every user resolves to the `unlimited` tier in Pro (advanced) session mode and subscription/billing is disabled |
| AI Gateway | The customer's Cloudflare AI Gateway endpoint that fronts the upstream LLM providers; its URL and token are held only in the Worker/interceptor env as secrets (`AIG_GATEWAY_URL`, `AIG_TOKEN`) |
| LLM Interceptor | A `WorkerEntrypoint` (`LlmInterceptor`) the container DO wires into container egress via `ctx.container.interceptOutboundHttps`; it receives the container's outbound HTTPS to the real provider hosts at the platform level (never the public internet, never Cloudflare Access), maps each onto the gateway provider path, and forwards with gateway auth + per-user attribution stamped on |
| Outbound Interception | The Cloudflare Containers platform mechanism (`interceptOutboundHttps` + `ctx.exports`, on by default at this project's compat date — the `enable_ctx_exports` flag became the default on 2025-11-17, so no flag is set) that routes a container's matching egress hostnames through a `WorkerEntrypoint` with no credential, URL, or token in the container |
| Per-User Attribution | The user's email passed to the interceptor as a per-session DO prop (sourced from `_userEmail` in `setupEnterpriseInterception`, falling back to the deterministic bucket id when absent) and stamped as `cf-aig-metadata.user` so the customer's gateway per-user analytics attribute usage to the real identity; **every** Cloudflare Access group the user matches (when groups are configured) is stamped alongside as a per-group `group_<sanitized>=1` tag (the scalar `group` key is not used), within CF's 5-entry metadata cap (`user` + up to 4 groups, deterministic truncation), so the gateway can branch routing/cost/rate-limit policies per group |
| JIT Provisioning | Auto-creation of an `unlimited` Codeflare user on first authenticated access in Enterprise Mode, keyed by the Cloudflare-Access-verified `email`; gated optionally by `ENTERPRISE_ACCESS_GROUP` membership (see [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning)) |
| Access get-identity | The Cloudflare Access endpoint `${iss}/cdn-cgi/access/get-identity`, called with the request's `CF_Authorization` token, returning the full identity (including IdP group membership) used to enforce `ENTERPRISE_ACCESS_GROUP` — the application JWT carries no group claim by default |
| `ENTERPRISE_ACCESS_GROUP` | Optional value set during the setup wizard and stored in KV (`SETUP_KEYS.ENTERPRISE_ACCESS_GROUP`), editable by re-running setup; names one or more **customer-managed** Cloudflare Access groups (comma/newline-separated) that gate Codeflare entry — a user in ANY configured group is admitted. Codeflare references them (via `get-identity`) but never creates or populates them — unlike the non-enterprise admin/user groups it manages itself. When set, JIT provisioning verifies membership and denies non-members; when unset, any user who clears Cloudflare Access is provisioned an account (the gate then lives entirely in the customer's Access application policy) |

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

<!-- @test: src/__tests__/lib/enterprise-mode.test.ts (resolveEnterpriseMode describe -> ENTERPRISE_MODE flag forces unlimited tier + advanced session mode + subscription disabled -> AC1..AC4; flag-unset parity describe -> tier/mode/subscription resolution byte-identical to baseline across Default/Onboarding/SaaS -> AC5) -->
<!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (enterprise bypass describe -> unlimited session cap AC3 — enterprise resolves unlimited cap not stored free-tier cap) -->
### REQ-ENTERPRISE-001: ENTERPRISE_MODE Forces Unlimited Tier and Pro Mode

<!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->
<!-- @impl: src/lib/subscription.ts -->
<!-- @impl: src/lib/session-mode.ts::resolveSessionMode -->
**Intent:** A deploy-time `ENTERPRISE_MODE` flag must turn a deployment into a single-tenant enterprise instance where every user gets full access without subscription friction.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, every user's effective tier resolves to `unlimited` regardless of the stored `subscriptionTier`. <!-- @impl: src/lib/subscription.ts::getEffectiveTier -->
2. When `ENTERPRISE_MODE` is set, session-mode resolution returns Pro (`advanced`) for every user regardless of the stored preference. <!-- @impl: src/lib/session-mode.ts::resolveSessionMode -->
3. When `ENTERPRISE_MODE` is set, every user is treated as a custom `unlimited` user: the unlimited tier's session cap applies (not the stored tier's), the monthly compute quota (timekeeper) is never enforced, and billing-status checks and trial logic are disabled — no user is ever blocked on a payment, quota, or time-limit condition. <!-- @impl: src/lib/subscription.ts::getEffectiveTier -->
4. The flag is read from a single resolver; all callers consult the resolver rather than reading the raw binding. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->
5. When `ENTERPRISE_MODE` is unset, tier resolution, session-mode resolution, and subscription enforcement are byte-identical to current behavior across the Default, Onboarding, and SaaS deployment modes.

**Constraints:**

- The flag is read at deploy time from a Worker binding, not from request data, so it cannot be toggled per request.
- When the flag is unset there is no new code path: every enterprise branch is gated behind the resolver returning false.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](subscription.md#req-sub-001-eight-tier-subscription-system), [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier), [REQ-AGENT-004](agents.md#req-agent-004-two-session-modes-standard-and-pro)

**Verification:** [Automated test](../../src/__tests__/lib/enterprise-mode.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/enterprise-mode.test.ts (subscribe-surface gating describe -> billing UI hidden + /app/subscribe returns guarded response when enterprise + unchanged when flag unset -> AC1..AC4) -->
### REQ-ENTERPRISE-002: Subscription UI Hidden and Subscribe Route Guarded

<!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->
<!-- @impl: web-ui/src/components -->
<!-- @impl: src/routes -->
<!-- @test: src/__tests__/routes/user-profile-enterprise.test.ts (GET /api/user enterpriseMode flag / REQ-ENTERPRISE-002 -> deploy-time enterpriseMode signal AC3 + flag-off parity AC4) -->
<!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Subscription menu hidden when enterpriseMode -> billing UI hidden AC1 + shown when flag unset AC4) -->

**Intent:** When the deployment is in Enterprise Mode there is no self-serve billing, so the subscription UI and the subscribe route must not be reachable.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, the subscription/billing settings surfaces (tier display, plan switching, usage-quota controls) are hidden in the frontend. <!-- @impl: web-ui/src/components/Header.tsx::Header -->
2. When `ENTERPRISE_MODE` is set, the `/app/subscribe` route is guarded so it does not render the tier-selection or checkout flow.
3. The frontend determines whether to hide billing surfaces from a deploy-time mode signal, not from the user's tier. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->
4. When `ENTERPRISE_MODE` is unset, the subscription UI and `/app/subscribe` behave byte-identically to current behavior.

**Constraints:**

- Guarding the subscribe route must not break links from non-enterprise deployments; the guard is conditional on the resolver.
- Hiding the billing UI does not delete a user's stored tier; the field is retained and simply unused while the flag is set.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-SUB-016](subscription.md#req-sub-016-customer-portal-and-plan-switching), [REQ-SUB-017](subscription.md#req-sub-017-enterprise-tier-contact-flow)

**Verification:** [API enterpriseMode flag](../../src/__tests__/routes/user-profile-enterprise.test.ts) (AC3 deploy-time signal, AC4 flag-off), [Header subscription-hide](../../web-ui/src/__tests__/components/Header.test.tsx) (AC1 billing UI hidden, AC4 parity). AC2 (`/app/subscribe` route guard) has no automated test yet; REQ held `Planned`.

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

1. When `ENTERPRISE_MODE` is set, the selectable agent set is exactly `{copilot, pi, bash}`. <!-- @impl: src/lib/agent-allowlist.ts::allowedAgents -->
2. When `ENTERPRISE_MODE` is set, session creation rejects any agent type outside the enterprise allowlist. <!-- @impl: src/lib/agent-allowlist.ts::allowedAgents -->
3. When `ENTERPRISE_MODE` is set, the session-creation UI offers only the allowlisted agents.
4. When `ENTERPRISE_MODE` is unset, all seven agent types from [REQ-AGENT-001](agents.md#req-agent-001-support-multiple-ai-coding-agents) remain selectable, byte-identical to current behavior. <!-- @impl: src/types.ts::AgentTypeSchema -->

**Constraints:**

- The allowlist is applied on top of the existing agent-type validation; it narrows the set rather than replacing the schema.
- The enterprise allowlist is a fixed set, not admin-configurable, in this domain.
- The set is OpenAI-wire-format agents only (plus `bash`): their traffic routes through the AI Gateway REST API ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)). Claude Code is excluded because it speaks the Anthropic-native wire format, which the gateway REST transport does not carry ([AD74](../../documentation/decisions/README.md)).

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-AGENT-001](agents.md#req-agent-001-support-multiple-ai-coding-agents), [REQ-AGENT-002](agents.md#req-agent-002-agent-selection-at-session-creation)

**Verification:** [Automated test](../../src/__tests__/routes/session-agent-allowlist.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/llm-interceptor.test.ts (LlmInterceptor describe -> api.openai.com mapped onto the AI Gateway REST API (api.cloudflare.com/.../ai/v1/*) with account+gateway parsed from AIG_GATEWAY_URL + Authorization Bearer AIG_TOKEN + cf-aig-gateway-id + cf-aig-metadata stamped with the user email + one group_<sanitized>=1 tag per matched group (scalar group dropped; empty-groups → {user} only; truncated to user+4 deterministically in configured order with a warn) + placeholder auth replaced + streaming preserved + streaming terminator repair (missing finish_reason synthesized before [DONE]; idempotent; tool_calls vs stop) + compat fallback on REST 404 for a model-routable request (gateway.ai.cloudflare.com/v1/{acct}/{gw}/compat/* with cf-aig-authorization, buffered body replayed, OpenAI-only fields (store/prompt_cache_key) stripped on the compat leg but kept on REST; no fallback on non-404 or non-model-routable path) + unmapped host (incl. api.anthropic.com) 400 + gateway-unset/unparseable 503 -> AC1..AC7) -->
<!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (enterprise bypass describe -> monthly compute quota never enforced AC3 — enterprise users are never blocked by the monthly compute quota) -->
<!-- @test: src/__tests__/container/index.test.ts (enterprise LLM interception wiring describe -> "stamps the user email (not the bucket id) as the interceptor per-user prop" -> AC4; the describe is labelled REQ-ENTERPRISE-011 for the wiring-ordering subject, but this it() also verifies REQ-ENTERPRISE-004 AC4 email attribution) -->
### REQ-ENTERPRISE-004: Outbound-Interception LLM Routing to Customer AI Gateway

<!-- @impl: src/lib/access.ts::resolveSessionAccessGroup -->

**Intent:** Enterprise deployments route all agent LLM traffic to the customer's AI Gateway via platform outbound-HTTPS interception, so the gateway credentials never reach the container, nothing is exposed over a public route, and all usage is attributable.

**Applies To:** User

**Acceptance Criteria:**

1. The container DO routes the container's outbound HTTPS to the real LLM provider host (`api.openai.com`) through a `WorkerEntrypoint` (`LlmInterceptor`) via `ctx.container.interceptOutboundHttps` + `ctx.exports`; the interceptor forwards each request to the customer's AI Gateway **REST API** (`https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/*`), mapping the OpenAI path verbatim under `/ai`. If the REST API returns `404` for a model-routable request (a `POST` to a `/chat/completions` or `/responses` path, whose body is buffered so it can be replayed), the interceptor replays the buffered request to the deprecated compat path (`https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/<path>`) with `cf-aig-authorization: Bearer <AIG_TOKEN>` in place of `Authorization: Bearer`; non-model-routable paths and non-404 responses do not trigger the fallback. On this compat replay the interceptor strips OpenAI-only request fields (`store`, `prompt_cache_key`) that non-OpenAI providers (e.g. `google-ai-studio`) reject with a `400`; the REST API leg keeps them so OpenAI prompt caching is unaffected. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor -->
2. The AI Gateway URL and token are read only from the interceptor's Worker env (`AIG_GATEWAY_URL`, `AIG_TOKEN`) and are never sent to or readable from the container; there is no public Worker route carrying LLM traffic, so the path never traverses Cloudflare Access. The account id (URL path) and gateway id (`cf-aig-gateway-id` header) are parsed from `AIG_GATEWAY_URL`. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor -->
3. Streaming responses are preserved end-to-end (the upstream stream is piped through without buffering the full body). A streamed chat-completions response whose terminal `finish_reason` chunk is missing — as the AI Gateway dynamic-route wrapper omits it on the wire — is normalized: a synthetic terminator chunk (`finish_reason` `stop`, or `tool_calls` when the stream carried tool-call deltas) is injected before `data: [DONE]` so strict OpenAI-wire clients (Pi, Copilot) see a complete stream and do not error/retry. Idempotent — when the upstream already sends a non-null `finish_reason` nothing is injected; only streamed `chat/completions` responses are touched. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor -->
4. Each forwarded request stamps `cf-aig-gateway-id` with the gateway id and `cf-aig-metadata` with the user's email (a per-session DO prop) for per-user analytics, falling back to the deterministic bucket id when no email is set; when Access groups are configured, **every** matched group is stamped as a per-group `group_<sanitized>=1` tag (no scalar `group` key) within CF's 5-entry metadata cap — `user` + up to 4 groups, excess truncated deterministically in configured order with a `console.warn` — so gateway rules can branch routing/cost/rate-limit policies per group. On the REST API leg the gateway auth is `Authorization: Bearer <AIG_TOKEN>`; on the compat fallback leg it is `cf-aig-authorization: Bearer <AIG_TOKEN>` (the compat endpoint requires this header instead). The per-request route catalog + default the interceptor enforces are resolved from the session's matched groups (first matching configured group wins, else the global catalog) via the shared resolver, so per-group route restrictions apply in addition to the metadata tags ([REQ-ENTERPRISE-013](#req-enterprise-013-per-group-dynamic-routing)). <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @impl: src/lib/access.ts::resolveRouteCatalog -->
5. The container's placeholder credential (`Authorization` / `x-api-key`) is stripped before forwarding so it never reaches the gateway; gateway auth is stamped separately. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor -->
6. The interceptor maps only the known provider host (`api.openai.com`); an unmapped host (including `api.anthropic.com`, which is not an enterprise agent host) fails closed (400) and an unconfigured/unparseable gateway fails closed (503) — neither forwards anywhere. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor -->
7. When `ENTERPRISE_MODE` is unset, the DO never wires interception, the interceptor is never instantiated, and agent LLM traffic follows the current direct-key path, byte-identical to current behavior. <!-- @impl: src/container/index.ts::startAndWaitForPorts -->

**Constraints:**

- Interception uses the Cloudflare Containers platform mechanism (`interceptOutboundHttps` + `ctx.exports`, on by default at this project's compat date — the `enable_ctx_exports` flag became the default on 2025-11-17, so no flag is set); HTTPS interception requires the container to trust the CA at `/etc/cloudflare/certs/cloudflare-containers-ca.crt` ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls)).
- The per-user attribution stamped into `cf-aig-metadata` is the user's email (falling back to the deterministic bucket id when absent), so the customer's gateway analytics attribute usage to the real identity — an enterprise requirement that intentionally overrides the original opaque-id design.
- The set of intercepted provider hosts is fixed in code; adding a provider requires a code change, not a request parameter.
- The primary transport target is the AI Gateway REST API (`api.cloudflare.com`); when a model-routable request returns `404` (e.g. the `google-ai-studio` provider being absent from the REST API), the interceptor falls back to the deprecated compat path (`gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/*`, `cf-aig-authorization: Bearer`) — safe because a 404 is a complete error body, not a started stream, so there is no double-billing or truncation risk ([AD74](../../documentation/decisions/README.md) dual-transport amendment). Backend selection is gateway-side via the route id stamped by the interceptor ([REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning)); agents carry only a fixed slash-free handle.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var)

**Verification:** [Automated test](../../src/__tests__/llm-interceptor.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/container/container-env-llm.test.ts (REQ-ENTERPRISE-005 enterprise env injection describe -> emits ENTERPRISE_MODE=active AC1 + fans ENTERPRISE_ROUTE_CATALOG/DEFAULT_ROUTE/DEFAULT_REASONING when enterprise+catalog present, omits them when catalog unset AC1 + never fans COPILOT_MODEL/PI_MODEL or a gateway URL/token/base-URL AC1/AC5 + ENTERPRISE_MODE + route vars omitted when flag unset/non-active AC6) -->
### REQ-ENTERPRISE-005: Container-Side Enterprise Routing (CA Trust + Constant Base-URLs)

<!-- @impl: src/container/container-env.ts::buildEnvVars -->
<!-- @impl: entrypoint.sh -->
<!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->
<!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (AC4 Pi models.json build: one model per catalog route + empty-catalog fallback to default + guard against reserved-keyword jq args that crash the container) -->
<!-- @test: host/__tests__/entrypoint-enterprise-ca-copilot.test.js (CA-trust env prepended to .bashrc: NODE_EXTRA_CA_CERTS at CF_CA_SRC, idempotent, omitted when ENTERPRISE_MODE unset -> AC2) -->
<!-- @test: host/__tests__/entrypoint-enterprise-ca-copilot.test.js (Copilot BYOK prepended to .bashrc: api.openai.com base-url + placeholder cred + COPILOT_MODEL=default route + token-limit hints, stale route overwritten on re-run, omitted when ENTERPRISE_MODE unset -> AC3) -->

**Intent:** Agents in Enterprise Mode must be work-ready against the AI Gateway with zero manual login and zero injected credentials, so the container only learns it is in enterprise mode and configures itself to use the intercepted provider hosts.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, the container env pipeline emits `ENTERPRISE_MODE=active` plus — when a route catalog is configured — the non-secret routing hints `ENTERPRISE_ROUTE_CATALOG`/`ENTERPRISE_DEFAULT_ROUTE`/`ENTERPRISE_DEFAULT_REASONING`; it never injects a gateway URL/token, account id, per-agent base-URL, or a resolved gateway model id (`COPILOT_MODEL`/`PI_MODEL`). The catalog/default fanned to the container are resolved for the session's matched Access groups (first matching configured group wins, else the global catalog — [REQ-ENTERPRISE-013](#req-enterprise-013-per-group-dynamic-routing)). <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig -->
2. When `ENTERPRISE_MODE=active`, the Cloudflare containers CA is installed into the system trust store and the Node/Python CA env vars (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`) are prepended to `.bashrc` (idempotent, enterprise-gated) so the PTY-spawned agent shells inherit them and all agent HTTPS clients trust the intercepted (TLS-terminated) connections — a process-only export does not reach the agents.
3. When `ENTERPRISE_MODE=active`, Copilot is configured via the complete BYOK contract pointing at the constant real provider base-URL (`api.openai.com`) with a non-secret placeholder credential and the configured default route's slash-free handle (`ENTERPRISE_DEFAULT_ROUTE`, re-asserted each start so a changed default overwrites a stale persisted value); the BYOK vars (`COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_API_KEY`, `COPILOT_MODEL`) plus the token-limit hints (`COPILOT_PROVIDER_MAX_PROMPT_TOKENS`, `COPILOT_PROVIDER_MAX_OUTPUT_TOKENS`) are prepended to `.bashrc` so the copilot PTY inherits them — a process-only export does not reach the agent and leaves Copilot to fall back to GitHub-hosted models; the token-limit hints suppress Copilot's "model not in catalog" warning and right-size the context to the routed model's window (gpt-5.5: 920,000 / 128,000), since the slash-free route handle is a dynamic-route alias absent from Copilot's built-in catalog (Copilot cannot enumerate multiple BYOK models — GitHub #3282 — so it launches on the default route only; switching routes requires a relaunch); the interceptor maps the handle to `dynamic/<route>` on egress ([REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning) AC1).
4. When `ENTERPRISE_MODE=active`, Pi is configured with a custom provider entry pointing at `api.openai.com` using the `openai-completions` adapter (`api: "openai-completions"`). `models.json` registers **one model per catalog route** (Pi natively switches between them via `/model`), each with `reasoning: true` so the thinking-level selector stays available (Shift+Tab / `/settings`); `settings.json` overwrites only `defaultProvider`/`defaultModel`/`defaultThinkingLevel` each start (authoritative for those three keys, everything else preserved), pinning `defaultModel` to the configured default route and `defaultThinkingLevel` to that route's reasoning grade (container-side; default `off`) — so every session starts at the configured default and a user `/model`/thinking change does not persist across restarts. Starting with thinking off keeps gpt-5.5 at 200 (it rejects `reasoning_effort` + function tools together on `/v1/chat/completions`, and the CF AI Gateway's `/ai/v1/responses` endpoint currently rejects valid Responses bodies, "Required value missing: messages", which blocks the `openai-responses` adapter). Raising the level lets a route model that supports reasoning over chat/completions (e.g. Gemini) think; gpt-5.5 returns HTTP 400 for any thinking level above "off" until CF fixes `/ai/v1/responses`. The provider uses the same placeholder credential and the slash-free route handles, and an empty catalog falls back to the default route so Pi always boots work-ready with no manual login step.
5. The container never receives the AI Gateway URL, the gateway token, or any per-session secret; routing to the gateway is done entirely by the DO's outbound interception ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)). <!-- @impl: src/container/container-env.ts::buildEnvVars -->
6. When `ENTERPRISE_MODE` is unset, `ENTERPRISE_MODE` is not emitted, no agent configuration block runs, and the container env is byte-identical to current behavior.

**Constraints:**

- The placeholder credential is a fixed non-secret constant; the interceptor strips it before forwarding ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC5), so it never reaches the gateway.
- `ENTERPRISE_MODE` rides the existing container env pipeline ([REQ-AGENT-031](agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity)); no per-agent login step is added.
- The route catalog/default/reasoning are non-secret routing hints fanned to the container so the agents can list/select routes; the actual gateway route is mapped Worker-side by the interceptor from the slash-free handle ([REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning)). Backend keys stay in the gateway (BYOK).
- Only the allowlisted enterprise agents ([REQ-ENTERPRISE-003](#req-enterprise-003-agent-allowlist-in-enterprise-mode)) are configured; `bash` needs no LLM configuration.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning), [REQ-AGENT-031](agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity)

**Verification:** [env-pipeline test](../../src/__tests__/container/container-env-llm.test.ts) (AC1/AC5/AC6 env injection); [Pi models.json build test](../../host/__tests__/entrypoint-enterprise-pi-models.test.js) (AC4 — one model per catalog route, empty-catalog fallback, reserved-keyword jq guard); [entrypoint CA-trust + Copilot BYOK test](../../host/__tests__/entrypoint-enterprise-ca-copilot.test.js) (AC2 — CA env prepended to .bashrc, idempotent, enterprise-gated; AC3 — Copilot BYOK vars + token-limit hints prepended, stale route overwritten on re-run, enterprise-gated). All acceptance criteria are covered by automated tests.

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/enterprise-mode.test.ts (deploy-time plumbing describe -> AIG_GATEWAY_URL + AIG_TOKEN read as secrets + ENTERPRISE_MODE read as var + off by default when binding absent -> AC1..AC4) -->
<!-- @test: src/__tests__/routes/setup/access.test.ts (handleCreateAccessApp describe -> enterprise mode creates a host-scoped app (bare host domain + whole-host destination) AC5 + default/SaaS app stays path-scoped (/app/* primary + path destinations) regression) -->
### REQ-ENTERPRISE-006: Deploy-Time AIG Secrets and ENTERPRISE_MODE Var

<!-- @impl: wrangler.toml -->
<!-- @impl: .github/workflows/deploy.yml -->
<!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->
<!-- @impl: src/routes/setup/access.ts::getManagedAppDomain -->
<!-- @impl: src/routes/setup/access.ts::upsertSwBypassAccessApp -->
<!-- @test: src/__tests__/routes/setup/access.test.ts (handleCreateAccessApp describe -> enterprise mode provisions a higher-precedence SW-bypass Access app with decision 'bypass' + include everyone scoped to the SW path AC6 + default/non-enterprise mode does NOT create a SW-bypass app) -->

**Intent:** Enterprise configuration must be supplied at deploy time through Worker bindings, kept secret where appropriate, and default to off.

**Applies To:** Admin

**Acceptance Criteria:**

1. `AIG_GATEWAY_URL` and `AIG_TOKEN` are configured as Worker secrets so they are not stored in plaintext config or exposed to the container. `AIG_TOKEN` must carry **both** the Workers AI permission (required for the REST API path, `Authorization: Bearer`) and the AI Gateway Run permission (required for the compat fallback path, `cf-aig-authorization: Bearer`); a token missing either scope is rejected with `error 10000` on the corresponding transport.
2. `ENTERPRISE_MODE` is configured as a non-secret Worker var. The dynamic-route catalog and default route are NOT deploy-time vars — they are configured in the setup wizard and stored in KV ([REQ-ENTERPRISE-012](#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list)), editable with no redeploy; the former static `AIG_LANGUAGE_MODEL` route-pin var (and its `deploy.yml` plumbing) is removed.
3. Enterprise Mode is off by default: an absent or empty `ENTERPRISE_MODE` binding resolves to disabled. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->
4. When `ENTERPRISE_MODE` is enabled, the interceptor fails closed (503) if the `AIG_GATEWAY_URL` secret is missing or unparseable (no `/v1/{account_id}/{gateway_id}` segments), rather than silently routing to nowhere, and the DO logs a warning when it skips interception wiring.
5. When `ENTERPRISE_MODE` is configured, the CF Access application created by the setup wizard is host-scoped (bare custom domain, no path suffix) so the session cookie covers all paths uniformly; non-enterprise deployments retain the path-scoped (`/app/*`) application. <!-- @impl: src/routes/setup/access.ts::handleCreateAccessApp -->
6. When `ENTERPRISE_MODE` is configured, the setup wizard also provisions a higher-precedence Access app + `decision:'bypass'` (include everyone) policy scoped to `/api/vault/*/service_worker.js`, so the credential-less SW registration fetch reaches the Worker's short-circuit ([REQ-VAULT-017](vault.md#req-vault-017-silverbullet-native-service-worker)) instead of a host-wide-Access 302 to the IdP. Best-effort: it never aborts the host-wide Access setup, persists the app id (`SETUP_KEYS.ACCESS_SW_BYPASS_APP_ID`) only after the policy succeeds, and rolls back a freshly-created app on policy failure (a policy-less self-hosted app would deny the path). Non-enterprise leaves the SW path reachable, so no bypass app is created. <!-- @impl: src/routes/setup/access.ts::handleCreateAccessApp -->
7. `deploy.yml` exposes `enterprise` and `enterprise integration` as manual-dispatch environments deployable from any branch, separate from production and integration.

**Constraints:**

- The flag is evaluated at deploy time from bindings, consistent with the deployment-mode determination in [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes).
- Secrets are never written to the container env; the enterprise env vars the container receives are the `ENTERPRISE_MODE` flag plus the non-secret route catalog/default/reasoning hints, all derived from Worker config (deploy var + KV), never from session state ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC1). The gateway URL/token/account-id and the resolved gateway route stay Worker-only.
- `AIG_GATEWAY_URL` is the single source for the gateway coordinates: the interceptor parses the account id and gateway id from it for the REST API call ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC2), so no separate account-id binding is required.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes)

**Verification:** [SW-bypass Access app provisioning](../../src/__tests__/routes/setup/access.test.ts) (AC6 — enterprise provisions the higher-precedence SW-bypass app, rolls it back on policy failure and persists no id, and creates none when non-enterprise). AC1–AC5 and AC7 are deploy-time Worker-binding / GitHub Actions plumbing with no automated test; REQ held `Planned`.

**Status:** Planned

---

<!-- @test: src/__tests__/llm-interceptor.test.ts (Feature C: catalog-driven dynamic-route mapping describe -> maps a known slash-free handle to dynamic/<route> AC1 + fails safe to the default route on an unknown handle AC1 + resolves the default to the first catalog entry when none configured AC1 + tolerates a pre-prefixed dynamic/<handle> AC1 + forwards unchanged when the catalog is empty / non-model-routable path / non-JSON / model-less body AC2 + preserves the rest of the payload AC1) -->
### REQ-ENTERPRISE-007: Gateway Route-Pinning

**Intent:** The gateway route must be selected Worker-side from the Setup-configured catalog so agents carry only a slash-free model handle, eliminating agent-side model-string parsing (e.g. Pi reading a `dynamic/<route>` slash as `provider/model`) that would misroute traffic away from the interceptor.

**Applies To:** User

**Acceptance Criteria:**

1. When a route catalog is configured (KV `SETUP_KEYS.DYNAMIC_ROUTES`), the interceptor maps the request body's slash-free `model` handle to `dynamic/<route>` before forwarding, on the model-routable endpoints `/chat/completions` and `/responses`: a handle in the catalog maps to itself; an unknown handle fails safe to the resolved default route (the configured default if it is in the catalog, else the first catalog entry). A pre-prefixed `dynamic/<handle>` is tolerated and re-resolved through the catalog. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor -->
2. When the catalog is empty, or the body is non-JSON, has no `model` field, or the path is not model-routable, the request body is forwarded unchanged. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor -->

**Constraints:**

- The route catalog and default live in KV ([REQ-ENTERPRISE-012](#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list)), not a deploy-time var; the catalog of slash-free handles is fanned to the container so agents can list/select routes, but the gateway route is resolved Worker-side ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC3, AC4).
- Only the request `model` field is rewritten; no other request field and no response byte is altered.
- Route mapping runs only when interception is active ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)); when `ENTERPRISE_MODE` is unset the interceptor is never instantiated.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var)

**Verification:** [Automated test](../../src/__tests__/llm-interceptor.test.ts)

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx (AC2 Header username dropdown describe -> avatar stays visible but dropdown does not open in enterprise + Subscription/Usage SaaS-only AC2; AC1/AC3 SettingsPanel describe -> Manage Subscriptions saasMode-only + Manage Users hidden only in enterprise AC1 + mode selector saasMode-only AC3 + three-mode parity AC6; AC3 SessionSection mode selector describe -> Standard/Pro selector saasMode-only AC3) -->
<!-- @test: web-ui/src/__tests__/components/enterprise-layout-suppression.test.tsx (Layout -> quota banners + upgrade CTAs render only in saasMode (hidden in enterprise/onboarding/default) AC4 + enterpriseMode threaded to TerminalArea→Dashboard dropdown AC2 + SettingsPanel admin AC1 + three-mode parity AC6) -->
<!-- @test: web-ui/src/__tests__/components/enterprise-app-routing.test.tsx (App -> first-time enterprise user routed to /app/ not onboarding/subscribe AC5 + non-enterprise SaaS user still redirected when flag unset AC6) -->
<!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (Enterprise mode surface suppression describe -> setup wizard hides Regular Users section when enterpriseMode set + still renders Admin Users + Access Group field AC7 + Regular Users renders when flag unset, default render tests) -->
<!-- @test: web-ui/src/__tests__/components/Header.test.tsx (enterprise user menu -> avatar visible but clicking opens no dropdown in enterprise AC8 (subsumes Subscription/Usage SaaS-only AC2, Guided Setup AC8, Logout AC9); SaaS/onboarding Subscription+Usage gating AC2, in Header menu) -->
<!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (Dashboard / REQ-SUB-019 describe, Enterprise dropdown gating -> "keeps the avatar visible but opens no dropdown in enterprise mode" AC2/AC8/AC9 + "shows Guided Setup + Logout and hides Usage outside enterprise mode") -->
### REQ-ENTERPRISE-008: Enterprise Frontend Surface Suppression

**Intent:** Frontend surfaces are suppressed along two axes. (a) The SaaS-billing / consumption surfaces — subscription, plans, the monthly-quota / "Upgrade" banners, the subscription-tier admin, the Standard/Pro session-mode selector, and the username dropdown's "Usage" entry — are meaningful only in SaaS mode, so they render only when `SAAS_MODE` is active and are hidden in enterprise, onboarding, and default deployments alike (a non-SaaS deployment showing a "choose your plan" / "upgrade" surface is misleading; onboarding originally inherited these because the gate was `!enterprise`, which this REQ corrects to `saasMode`). The "Usage" entry was previously also shown in enterprise, but the enterprise usage view always reports zero (the Timekeeper read path is not wired for enterprise), so the entry is gated to SaaS until that is fixed. (b) In-product user administration, first-login routing, the username dropdown's "Guided Setup" (per-user onboarding) and "Logout" entries, and the setup "Regular Users" section are enterprise-specific suppressions keyed off `ENTERPRISE_MODE`. Because every username-dropdown entry is gated away in enterprise (Subscription + Usage by axis a, Guided Setup + Logout by axis b), the avatar/username trigger stays visible (users always see their identity) but clicking it opens no dropdown.

**Applies To:** User

**Acceptance Criteria:**

1. The "Manage Subscriptions" entry in Settings → Administration renders only when `SAAS_MODE` is active (hidden in enterprise, onboarding, and default). The "Manage Users" entry renders in every mode except enterprise (hidden only when `ENTERPRISE_MODE` is set). <!-- @impl: web-ui/src/components/SettingsPanel.tsx::SettingsPanel -->
2. The username dropdown — in both the Header menu and the Dashboard menu — renders its "Subscription" and "Usage" entries only when `SAAS_MODE` is active. (Usage was previously shown in enterprise too, but the enterprise usage view always reports zero, so the entry is gated to SaaS until that read path is fixed.) In enterprise the avatar/username trigger stays visible but its dropdown never opens (AC8), so neither entry appears. The `/app/usage` page route is unchanged; its in-page "Subscription" billing button stays hidden outside SaaS. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @impl: web-ui/src/components/Dashboard.tsx --> <!-- @impl: web-ui/src/components/UsagePage.tsx -->
3. The Standard/Pro session-mode selector renders only when `SAAS_MODE` is active; in enterprise every user is implicitly Pro (advanced) per [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC2, and onboarding / default deployments have no Standard/Pro plans. <!-- @impl: web-ui/src/components/settings/SessionSection.tsx::SessionSection -->
4. The monthly-quota warning banners and their "Upgrade" calls-to-action render only when `SAAS_MODE` is active. <!-- @impl: web-ui/src/components/Layout.tsx::Layout -->
5. When `ENTERPRISE_MODE` is set, a first-time (auto-provisioned) user is routed to the application home, never to `/app/subscribe` or the self-serve onboarding/waitlist flow. <!-- @impl: web-ui/src/App.tsx::App -->
6. Three-mode parity: in SaaS mode every surface in AC1–AC4 renders; in onboarding and default deployments the SaaS-billing surfaces (AC1 "Manage Subscriptions", AC2, AC3, AC4) do not render while AC1 "Manage Users" does; in enterprise mode every SaaS-billing surface in AC1–AC5 is suppressed and the username dropdown never opens — the avatar/username stays visible but clicking it does nothing (AC2/AC8). `/app/subscribe` is reachable only in SaaS mode — the client `SubscribeGuard` redirects to `/app/` whenever `saasMode` is not active. <!-- @impl: web-ui/src/App.tsx::App -->
7. When `ENTERPRISE_MODE` is set, the setup wizard's "Regular Users" section is not rendered — setup configures only Admin Users and the optional Cloudflare Access group, since regular users are provisioned via Cloudflare Access on first sign-in per [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning); when unset, the section renders unchanged. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep -->
8. When `ENTERPRISE_MODE` is set, the username dropdown does not open in either the Header menu or the Dashboard menu — the avatar/username trigger stays visible (so the user always sees their identity), but clicking it is inert. Every entry is independently gated away (Subscription + Usage are SaaS-only per AC2; "Guided Setup" is per-user onboarding, irrelevant when an admin configures the instance via Setup; "Logout" is ineffective under SSO per AC9), leaving nothing to show, so the avatar's click opens no dropdown; when unset the dropdown opens unchanged. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @impl: web-ui/src/components/Dashboard.tsx -->
9. The username dropdown's "Logout" entry is treated as enterprise-suppressed because under SSO the in-app logout is ineffective (it clears the Cloudflare Access session but the IDP silently re-authenticates on the next request), so sign-out is governed by the IDP / device. In enterprise this is realized by the dropdown not opening at all (AC8 — the avatar's click is inert); when `ENTERPRISE_MODE` is unset the entry renders unchanged. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @impl: web-ui/src/components/Dashboard.tsx -->

**Constraints:**

- The frontend gates the SaaS-billing surfaces (AC1 "Manage Subscriptions", AC2, AC3, AC4) on the deploy-time `saasMode` signal, and the admin / routing surfaces (AC1 "Manage Users", AC5, AC7, AC8) on the `enterpriseMode` signal; never on the user's tier or role. Both signals are exposed by `GET /api/user` (consumed via `sessionStore`); `saasMode` is additionally exposed by `GET /api/auth/status` for the `SubscribeGuard` redirect.
- Suppression is render-gating only: it removes no component code path for non-enterprise deployments and deletes no stored user state.
- This REQ concretizes the surface list implied by [REQ-ENTERPRISE-002](#req-enterprise-002-subscription-ui-hidden-and-subscribe-route-guarded) AC1 (which owns the server-side `/app/subscribe` route guard) and adds the client `SubscribeGuard` saasMode redirect plus the admin-button, mode-selector, quota-banner, and first-login-routing surfaces. Visibility only; the matching routes are made unreachable server-side in [REQ-ENTERPRISE-009](#req-enterprise-009-enterprise-backend-route-hardening).

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-002](#req-enterprise-002-subscription-ui-hidden-and-subscribe-route-guarded), [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning)

**Verification:** [Automated test](../../web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx) (AC1–AC3, AC6, AC8); [enterprise-layout-suppression.test.tsx](../../web-ui/src/__tests__/components/enterprise-layout-suppression.test.tsx) (AC4); [enterprise-app-routing.test.tsx](../../web-ui/src/__tests__/components/enterprise-app-routing.test.tsx) (AC5); [ConfigureStep.test.tsx](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx) (AC7); [Header.test.tsx](../../web-ui/src/__tests__/components/Header.test.tsx) (AC2/AC8/AC9); [Dashboard.test.tsx](../../web-ui/src/__tests__/components/Dashboard.test.tsx) (AC2/AC8/AC9)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (enterprise route hardening describe -> user-mgmt routes 403 AC1 + billing checkout/portal/switch 403 & status empty AC2 + auth subscribe/request-access 403 no email AC3 + stripe webhook no-op no KV mutation AC4 + admin tier/sub config 403 AC5 + PATCH preferences not fail-closed, accepts sessionMode AC6 (entitlement-gate detail in preferences-enterprise.test.ts) + every route byte-identical when flag unset AC7) -->
### REQ-ENTERPRISE-009: Enterprise Backend Route Hardening

<!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->

**Intent:** Hiding a SaaS or admin surface in the frontend is not sufficient; in Enterprise Mode the corresponding routes must fail closed so the disabled capabilities cannot be reached by direct API call, URL manipulation, or a stray external event.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, the user-management routes (`GET`/`PUT`/`DELETE`/`PATCH` under `/api/users`) return 403 and perform no mutation; user administration is delegated entirely to Cloudflare Access.
2. When `ENTERPRISE_MODE` is set, the billing action routes (`POST /api/billing/checkout`, `/api/billing/portal`, `/api/billing/switch`) return 403, and `GET /api/billing/status` returns an empty/disabled billing state without contacting Stripe.
3. When `ENTERPRISE_MODE` is set, the self-serve routes `POST /api/auth/subscribe` and `POST /api/auth/request-access` return 403 and send no email.
4. When `ENTERPRISE_MODE` is set, the Stripe webhook route acknowledges the event without mutating any user's tier or billing state, so a late or stray Stripe event cannot downgrade an enterprise user.
5. When `ENTERPRISE_MODE` is set, the admin tier/subscription configuration routes return 403 (there is a single effective tier, `unlimited`, for all users).
6. When `ENTERPRISE_MODE` is set, `PATCH /api/preferences` is **not** fail-closed (unlike the routes above): the SaaS advanced-mode entitlement gate is bypassed so any user may select Pro, and the effective session mode is forced to Pro by `clampSessionModeToTier` regardless of the stored value (already guarded — see [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC2).
7. When `ENTERPRISE_MODE` is unset, every route above behaves byte-identically to current behavior.

**Constraints:**

- All guards consult the single `isEnterpriseMode(env)` resolver ([REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC4); no route reads the raw binding.
- Action endpoints fail closed with 403; the read-only billing-status endpoint returns an empty state (200) so non-enterprise clients that still poll it do not error.
- These guards are defense-in-depth behind the frontend suppression in [REQ-ENTERPRISE-008](#req-enterprise-008-enterprise-frontend-surface-suppression); neither layer alone is sufficient.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-002](#req-enterprise-002-subscription-ui-hidden-and-subscribe-route-guarded), [REQ-ENTERPRISE-008](#req-enterprise-008-enterprise-frontend-surface-suppression)

**Verification:** [Automated test](../../src/__tests__/routes/enterprise-route-hardening.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (enterprise JIT describe -> valid Access JWT for unknown email auto-creates unlimited enterprise-jit user keyed by verified email AC1 + ENTERPRISE_ACCESS_GROUP set gates on get-identity group membership (403 when not a member) AC2 + group unset provisions on valid JWT alone AC3 + idempotent concurrent first-login + existing admin/user record returned unchanged AC4 + no welcome/subscription email + bucket/token still lazy AC5 + non-enterprise unknown user still 403 AC6) -->
<!-- @test: src/__tests__/lib/access-group-resolution.test.ts (parseAccessGroups list/single/blank parsing + resolveUserAccessGroup any-of intersection returns the matched group, first-of-several on multi-match, fail-closed returning null AND making no get-identity fetch on missing token or auth domain / non-cloudflareaccess host (SSRF guard) + non-OK/throw) -->
<!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-010: Access-gated JIT provisioning describe -> AC2 (any-of): admits a user who is in ANY one of several configured groups + AC2 (any-of): denies a user who is in NONE of several configured groups) -->
### REQ-ENTERPRISE-010: Access-Gated JIT User Provisioning

<!-- @impl: src/lib/jwt.ts::verifyAccessJWT -->
<!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS -->

**Intent:** In Enterprise Mode users are managed by the customer's Cloudflare Access, not inside Codeflare, so any Access-authenticated user entitled to the deployment must be provisioned automatically on first access — a fresh user lands work-ready with no in-product allowlisting or approval step.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set and an authenticated request presents a valid (RS256-verified, audience-checked) Cloudflare Access JWT for an `email` with no existing user record, Codeflare auto-creates a record `{ addedBy: 'enterprise-jit', role: 'user', accessTier: 'advanced', subscriptionTier: 'unlimited' }` keyed by the JWT's IdP-verified `email`, and the request proceeds as that user. (`accessTier` tops out at `advanced`; `unlimited` is the *subscription* tier — `getEffectiveTier` already resolves enterprise users to `unlimited` per REQ-ENTERPRISE-001.) <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser -->
2. When the optional `ENTERPRISE_ACCESS_GROUP` (set at setup, stored in KV) is configured, provisioning first resolves the user's group membership via the Access `get-identity` endpoint (derived from the JWT `iss`, authenticated with the request's `CF_Authorization` token) and, when the user is in none of the configured groups, denies the request with Codeflare's standard not-authorized response (the existing `ForbiddenError` 403 path — the same one a non-allowlisted user hits in Cloudflare-Access mode) and creates no record. <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser -->
3. When `ENTERPRISE_ACCESS_GROUP` is unset, a valid Access JWT alone is sufficient to provision; the group gate is delegated to the customer's Access application policy. <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser -->
4. Provisioning is idempotent: concurrent first-logins converge on a single record, and an existing record — whether a setup admin or a prior JIT user — is returned unchanged (JIT never overwrites a role or downgrades an admin). <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser -->
5. Enterprise JIT sends no welcome or subscription email; the per-user R2 bucket and scoped token continue to be created lazily on first session start, unchanged. <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser -->
6. When `ENTERPRISE_MODE` is unset, an Access-authenticated user with no record still receives 403 with no auto-provisioning, and the authentication path is byte-identical to current behavior. <!-- @impl: src/lib/access.ts::authenticateRequest -->

**Constraints:**

- Codeflare trusts a valid Access JWT as proof that the customer's Access policy authorized the user; it does not re-implement IdP authentication. The only authorization Codeflare adds is the optional `ENTERPRISE_ACCESS_GROUP` membership check via `get-identity`.
- `ENTERPRISE_ACCESS_GROUP` is configured during the setup wizard and stored in KV (`SETUP_KEYS.ENTERPRISE_ACCESS_GROUP`), alongside the existing setup Access config (`ACCESS_AUD`, the admin/user group ids), so an admin changes it by re-running setup with no redeploy. It names one or more customer-managed Access groups (comma/newline-separated) that Codeflare references but never creates or populates; a user in ANY configured group is admitted; absent ⇒ JWT-trust mode (the gate is delegated to the customer's Access application policy).
- The account key is the IdP-verified `email`; the JWT `sub` is stored for reference. An email change at the IdP yields a new account (consistent with the existing SaaS JIT behavior).
- The group check runs once at provisioning; the resulting record is the cache, so steady-state requests incur no `get-identity` call.
- This REQ uses only the deployment's existing Cloudflare Access auth mode; it adds no new identity-provider integration (consistent with this domain's Out of Scope).

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var), [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes)

**Verification:** [Automated test](../../src/__tests__/lib/enterprise-jit-provisioning.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/container/index.test.ts (enterprise LLM interception wiring describe -> interceptOutboundHttps registered before super.startAndWaitForPorts so the ephemeral CA is mounted when entrypoint.sh trusts it + non-enterprise start performs no wiring -> AC1, AC2) -->
### REQ-ENTERPRISE-011: Container Start Interception Ordering

**Intent:** Enterprise LLM interception must be wired before the container boots, so the ephemeral Cloudflare containers CA exists when the container entrypoint installs it into the trust store; wiring it after boot makes the intercepted TLS handshake fail and no agent can reach the gateway.

**Applies To:** User

**Acceptance Criteria:**

1. The DO registers outbound interception (`interceptOutboundHttps`, [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC1) **before the container starts** — in the `startAndWaitForPorts` override, ahead of the SDK's `container.start()`, mirroring where the SDK applies its own pre-start interception — so the ephemeral Cloudflare containers CA at `/etc/cloudflare/certs/` is mounted in time for entrypoint.sh to install it into the trust store ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC2). Wiring after boot (e.g. in `onStart`) leaves the entrypoint with no cert to trust, so every intercepted-TLS handshake to the provider host fails with a connection error. <!-- @impl: src/container/index.ts::startAndWaitForPorts -->
2. When `ENTERPRISE_MODE` is unset, the `startAndWaitForPorts` override performs no interception work and the container start path is byte-identical to current behavior. <!-- @impl: src/container/index.ts::startAndWaitForPorts -->

**Constraints:**

- Wiring runs on the start chokepoint that all start paths funnel through (explicit start + container-fetch auto-start), before the SDK boots the container.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls)

**Verification:** [Automated test](../../src/__tests__/container/index.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/setup.test.ts (enterprise configure -> persists dynamicRoutes as a JSON array AC2 + persists defaultRoute as JSON / clears the key when null AC2 + rejects defaultRoute.route not in the catalog AC2 + persists the enterpriseAccessGroup chip list AC1 + rejects a comma/newline in a group/route name + rejects a >256-char name AC1) -->
<!-- @test: src/__tests__/routes/setup/handlers.test.ts (GET /prefill -> round-trips the stored access groups, dynamicRoutes, and defaultRoute + returns empty defaults when nothing stored + degrades to empty defaults when stored route JSON is malformed AC3 + omits all enterprise extras when ENTERPRISE_MODE unset AC5) -->
<!-- @test: src/__tests__/lib/access-group-resolution.test.ts (parseAccessGroups -> list/single/blank parsing AC1) -->
<!-- @test: web-ui/src/__tests__/stores/setup.test.ts (setup store -> add/remove/dedup access-group and dynamic-route chips AC1/AC2) -->
<!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (loadEnterpriseRouteConfig -> catalog parse + configured-default-in-catalog + fallback-to-first-drops-reasoning + unset-default-first-route-reasoning-off + malformed-degrades + non-enterprise-empty -> AC2/AC3/AC4/AC5) -->
<!-- @test: src/__tests__/routes/setup.test.ts (enterprise configure -> rejects empty/absent dynamicRoutes with 400 before any KV write AC6) -->
<!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (Continue disabled in enterprise mode until >=1 route added + route select offers no empty default option AC6/AC2) -->
<!-- @test: web-ui/src/__tests__/stores/setup.test.ts (first route added auto-becomes the default + default falls back to the new first route on removal AC2) -->
### REQ-ENTERPRISE-012: Setup-Configured Dynamic-Route Catalog and Access-Group List

<!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS -->

**Intent:** An enterprise admin must manage an unlimited set of Cloudflare Access groups and an unlimited set of gateway dynamic routes from the setup wizard with no redeploy — the same way admin users are managed — so adding a team or a route is a wizard edit, not a code or deploy-var change.

**Applies To:** Admin

**Acceptance Criteria:**

1. The setup wizard edits the access-group list and the dynamic-route catalog as add/Enter/chip-with-x lists (cloning the admin-user interaction), batch-saved through the existing `POST /api/setup/configure` (no new endpoint). Names validate 1–256 chars, trimmed, comma/newline forbidden (so a name with spaces like `Agentic AI Test Account` is allowed); access groups persist comma/newline-joined under `SETUP_KEYS.ENTERPRISE_ACCESS_GROUP`, split back via `parseAccessGroups`. <!-- @impl: web-ui/src/stores/setup.ts::setupStore -->
2. The route catalog persists as a JSON `string[]` (`SETUP_KEYS.DYNAMIC_ROUTES`) and one `{route, reasoning}` default (`SETUP_KEYS.DEFAULT_ROUTE`) where the first route added auto-becomes the default; `defaultRoute.route` must be a member of the catalog (rejected `400` otherwise). An unset default resolves at read time to the first catalog route with reasoning off. Optional per-group overrides persist as a JSON map under `SETUP_KEYS.GROUP_ROUTING` ([REQ-ENTERPRISE-013](#req-enterprise-013-per-group-dynamic-routing)). <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig -->
3. `GET /api/setup/prefill` round-trips the stored groups, catalog, and default route so a setup re-run shows the current configuration; a malformed stored value degrades to empty defaults rather than failing the prefill.
4. The catalog/default feed the interceptor's route mapping ([REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning)) and the container env fan ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC1) via the shared `loadEnterpriseRouteConfig` resolver; the group list feeds the JIT gate ([REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning)), the per-group metadata tags ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC4), and the optional per-group route editor ([REQ-ENTERPRISE-013](#req-enterprise-013-per-group-dynamic-routing)). <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig -->
5. When `ENTERPRISE_MODE` is unset, the dynamic-route catalog UI and KV reads add no behavior; the access-group field already existed and is unchanged for non-enterprise deployments. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig -->
6. In enterprise mode, the setup wizard blocks "Continue" until at least one dynamic route is added. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep -->
7. `POST /api/setup/configure` rejects empty or absent `dynamicRoutes` with `400` before any KV write. The interceptor's empty-catalog passthrough ([REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning) AC2) is defensive only.

**Constraints:**

- No new persistence layer or endpoint: the lists ride the existing setup wizard configure flow and KV (`SETUP_KEYS`), consistent with how `ENTERPRISE_ACCESS_GROUP` was already stored ([REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning)).
- Access groups are stored comma/newline-joined (back-compat with the prior single-value config) and routes as a JSON array; the comma/newline ban on names keeps the joined encoding lossless.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning), [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning)

**Verification:** [Setup configure tests](../../src/__tests__/routes/setup.test.ts), [prefill tests](../../src/__tests__/routes/setup/handlers.test.ts), [route-config resolver tests](../../src/__tests__/lib/enterprise-route-config.test.ts), [access-group parsing](../../src/__tests__/lib/access-group-resolution.test.ts), [setup store](../../web-ui/src/__tests__/stores/setup.test.ts)

**Status:** Implemented

---

### REQ-ENTERPRISE-013: Per-group dynamic routing

<!-- @impl: src/lib/access.ts::resolveRouteCatalog -->
<!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig -->
<!-- @impl: src/llm-interceptor.ts::LlmInterceptor -->
<!-- @impl: src/routes/setup/index.ts -->
<!-- @impl: src/routes/setup/handlers.ts -->
<!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS -->
<!-- @impl: web-ui/src/components/setup/PerGroupRoutingCard.tsx -->
<!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep -->
<!-- @impl: web-ui/src/components/ui/PillToggle.tsx -->
<!-- @impl: web-ui/src/stores/setup.ts::setupStore -->
<!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (per-group routing REQ-ENTERPRISE-013 describe -> AC1..AC4) -->
<!-- @test: src/__tests__/llm-interceptor.test.ts (per-group catalog resolution -> AC2,AC4) -->
<!-- @test: src/__tests__/routes/setup.test.ts (groupRouting persist, clear, validation 400s -> AC3,AC5) -->
<!-- @test: src/__tests__/routes/setup/handlers.test.ts (groupRouting prefill echo + non-enterprise guard -> AC5,AC6) -->
<!-- @test: web-ui/src/__tests__/components/PerGroupRoutingCard.test.tsx (route pills on/off + default constraint + apply-to-all gating -> AC5) -->
<!-- @test: web-ui/src/__tests__/components/PillToggle.test.tsx (pill on/off state, click toggles + fires -> AC5) -->
<!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (global Default Route hidden once a group exists, apply-to-all gating -> AC5) -->
<!-- @test: web-ui/src/__tests__/stores/setup.test.ts (seed-on-add, apply-to-all, save + prefill round-trip -> AC5) -->
**Intent:** An enterprise admin can scope the dynamic-route catalog per Cloudflare Access group — which routes a group's members may use, and the group's default route + reasoning — so different teams get different model access from one deployment, while a deployment with no per-group config behaves exactly as the global catalog does today.

**Applies To:** Admin

**Acceptance Criteria:**

1. With no per-group routing configured, behavior is unchanged: every session resolves the global `DYNAMIC_ROUTES` catalog and `DEFAULT_ROUTE`. <!-- @impl: src/lib/access.ts::resolveRouteCatalog -->
2. When per-group routing is configured, a session resolves the routes/default/reasoning of the **first** of its matched Access groups (in the admin's configured group-list order) that has a non-empty entry; a matched group with no entry, or no matched group at all, falls back to the global catalog. <!-- @impl: src/lib/access.ts::resolveRouteCatalog -->
3. Per-group config persists under `SETUP_KEYS.GROUP_ROUTING` as a JSON map `{ [group]: { routes, defaultRoute, reasoning } }` saved through `POST /api/setup/configure`; `configure` rejects (`400`) a group whose `defaultRoute` is not one of its `routes`, whose `routes` are not a subset of the global catalog, or whose key is not a configured Access group; an empty map is deleted rather than stored. <!-- @impl: src/routes/setup/index.ts -->
4. Both routing sinks — the LLM interceptor's per-request route enforcement ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC4) and the container env fan ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC1) — read the same group-aware `resolveRouteCatalog` core, so they cannot drift; the existing default-drift rule (default not in the resolved catalog → first route, reasoning off) is preserved. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig -->
5. The Setup wizard renders one per-group routing card per Access group (only when ≥1 group and ≥1 route exist): toggleable route **pills** (selected = green, deselected = gray) rather than checkboxes, a default-route selector constrained to the group's active routes, a reasoning selector, and an "Apply to all groups" shortcut — shown only when more than one group exists — that copies one group's config to the rest. The global "Default Route" editor renders only while **no** Access group exists; once any group is added it is hidden (routing is configured per-group), though the stored global default remains the backend fallback for users who match no configured group. `GET /api/setup/prefill` round-trips the stored map. <!-- @impl: web-ui/src/components/setup/PerGroupRoutingCard.tsx --> <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/components/ui/PillToggle.tsx --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore -->
6. All reads/writes are inside the existing `isEnterpriseMode` gate; in non-enterprise modes the Setup request/response shape and route resolution are byte-identical to before. <!-- @impl: src/routes/setup/handlers.ts -->

**Constraints:**

- A user matching several configured groups is resolved deterministically by first match in the admin's configured group-list order (not by union or by most-permissive).
- The global catalog remains the universe of routes; a group can only narrow it, never add a route outside it.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning), [REQ-ENTERPRISE-012](#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list)

**Verification:** [Resolver tests](../../src/__tests__/lib/enterprise-route-config.test.ts), [interceptor tests](../../src/__tests__/llm-interceptor.test.ts), [Setup configure tests](../../src/__tests__/routes/setup.test.ts), [prefill tests](../../src/__tests__/routes/setup/handlers.test.ts), [per-group card](../../web-ui/src/__tests__/components/PerGroupRoutingCard.test.tsx), [pill toggle](../../web-ui/src/__tests__/components/PillToggle.test.tsx), [ConfigureStep gating](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx), [setup store](../../web-ui/src/__tests__/stores/setup.test.ts)

**Status:** Implemented

---

### REQ-ENTERPRISE-014: Admin access via Cloudflare Access groups

<!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS -->
<!-- @impl: src/routes/setup/index.ts -->
<!-- @impl: src/routes/setup/handlers.ts -->
<!-- @impl: src/middleware/auth.ts::requireAdmin -->
<!-- @impl: src/lib/access.ts::resolveAdminAccessGroup -->
<!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser -->
<!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep -->
<!-- @impl: web-ui/src/stores/setup.ts::setupStore -->
<!-- @test: src/__tests__/middleware/auth.test.ts (requireAdmin enterprise admin-by-group describe -> AC1,AC2,AC3,AC7) -->
<!-- @test: src/__tests__/lib/enterprise-jit-provisioning.test.ts (REQ-ENTERPRISE-014 entry-gate union admits admin-group member, denies non-member, admin groups alone do not arm the gate -> AC4) -->
<!-- @test: src/__tests__/routes/setup.test.ts (REQ-ENTERPRISE-014 adminAccessGroup persist joined (comma-joined under SETUP_KEYS.ENTERPRISE_ADMIN_ACCESS_GROUP), clear empty, non-enterprise ignore -> AC5,AC6,AC7) -->
<!-- @test: src/__tests__/routes/setup/handlers.test.ts (REQ-ENTERPRISE-014 prefill split + non-enterprise omit -> AC6,AC7) -->
<!-- @test: web-ui/src/__tests__/stores/setup.test.ts (admin-group add/remove without routing seeding (AC5 routing-exclusion), configure body, prefill round-trip -> AC5,AC6) -->
<!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (admin-groups field render/route + no per-group card -> AC6) -->

**Intent:** An enterprise admin can grant admin (= Setup / user-administration) access to members of one or more named Cloudflare Access groups, parallel to the email-based admin list, so admin rights track the customer's directory instead of a hand-maintained email list. Admin groups govern administration only — they never participate in per-group model routing.

**Applies To:** Admin

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set and admin Access groups are configured, a non-admin user who belongs to **any** configured admin group is elevated to `admin` for the request, granting access to admin-gated routes (including re-running Setup). The membership check is **live** (one Cloudflare Access get-identity call) so removing a user from the group revokes their admin access on the next request. <!-- @impl: src/middleware/auth.ts::requireAdmin --> <!-- @impl: src/lib/access.ts::resolveAdminAccessGroup -->
2. A non-admin user who is in none of the configured admin groups still receives `403` from admin-gated routes. <!-- @impl: src/middleware/auth.ts::requireAdmin -->
3. The admin-group check runs **only** inside `requireAdmin` (an admin-gated path), never in the hot `authenticateRequest`/`requireIdentity` identity path — and it short-circuits for a user already resolved as `admin` — so every non-admin request and every request on a non-admin route stays byte-identical (no extra get-identity cost). It is a no-op (returns `[]`) outside enterprise mode or when no admin groups are configured. <!-- @impl: src/lib/access.ts::resolveAdminAccessGroup -->
4. The entry-entitlement gate ([REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning)) admits admin-group members too: when the user-access gate is active (`ENTERPRISE_ACCESS_GROUP` non-empty) it tests membership against the union of user-access + admin groups, so an admin in no *user* group is not locked out. Admin groups never arm the gate by themselves — with no user-access groups configured, entry stays open exactly as before. <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser -->
5. Admin groups persist under `SETUP_KEYS.ENTERPRISE_ADMIN_ACCESS_GROUP`, comma-joined (the format `parseAccessGroups` reads), saved through `POST /api/setup/configure`; an empty list deletes the key. They are excluded from per-group routing by construction — only `ENTERPRISE_ACCESS_GROUP` keys may carry a `GROUP_ROUTING` entry. <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @impl: src/routes/setup/index.ts -->
6. The Setup wizard renders a "Cloudflare Admin Access Groups (optional)" chip field beside the user-access groups field; the email-based "Admin Users" list stays. `GET /api/setup/prefill` round-trips the stored list. Admin groups produce no per-group routing card. <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @impl: src/routes/setup/handlers.ts -->
7. All reads/writes are inside the existing `isEnterpriseMode` gate; in non-enterprise modes the Setup request/response shape and admin authorization are byte-identical to before. <!-- @impl: src/routes/setup/handlers.ts -->

**Constraints:**

- Elevation is per-request and lives only on the Hono context; no KV `role:'admin'` record is written for a group-admin (so revocation is immediate and leaves no residue). The email-based admin list remains the durable admin source.
- The live get-identity check fails CLOSED (treated as non-member) on any missing token, non-`*.cloudflareaccess.com` domain, or fetch error — an admin gate must never elevate on uncertainty.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning), [REQ-ENTERPRISE-012](#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list)

**Verification:** [requireAdmin admin-by-group](../../src/__tests__/middleware/auth.test.ts), [entry-gate union](../../src/__tests__/lib/enterprise-jit-provisioning.test.ts), [Setup persist/ignore](../../src/__tests__/routes/setup.test.ts) (AC5 comma-joined persistence), [prefill](../../src/__tests__/routes/setup/handlers.test.ts), [setup store](../../web-ui/src/__tests__/stores/setup.test.ts) (AC5 routing exclusion), [ConfigureStep field](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx)

**Status:** Implemented
