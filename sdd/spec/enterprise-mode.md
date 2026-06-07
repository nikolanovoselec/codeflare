# Enterprise Mode Domain Specification

Deploy-time enterprise configuration: single-tenant unlimited access, subscription bypass, and platform outbound-HTTPS interception that routes agent LLM traffic to a customer-owned AI Gateway with no credential ever placed in the container.

### Key Concepts

| Concept | Definition |
|---------|-----------|
| Enterprise Mode | A deploy-time configuration, toggled by the `ENTERPRISE_MODE` Worker var, that turns a Codeflare deployment into a single-tenant enterprise instance: every user resolves to the `unlimited` tier in Pro (advanced) session mode and subscription/billing is disabled |
| AI Gateway | The customer's Cloudflare AI Gateway endpoint that fronts the upstream LLM providers; its URL and token are held only in the Worker/interceptor env as secrets (`AIG_GATEWAY_URL`, `AIG_TOKEN`) |
| LLM Interceptor | A `WorkerEntrypoint` (`LlmInterceptor`) the container DO wires into container egress via `ctx.container.interceptOutboundHttps`; it receives the container's outbound HTTPS to the real provider hosts at the platform level (never the public internet, never Cloudflare Access), maps each onto the gateway provider path, and forwards with gateway auth + per-user attribution stamped on |
| Outbound Interception | The Cloudflare Containers platform mechanism (`interceptOutboundHttps` + `ctx.exports`, on by default at this project's compat date — the `enable_ctx_exports` flag became the default on 2025-11-17, so no flag is set) that routes a container's matching egress hostnames through a `WorkerEntrypoint` with no credential, URL, or token in the container |
| Per-User Attribution | The user's email passed to the interceptor as a per-session DO prop (sourced from `_userEmail` in `setupEnterpriseInterception`, falling back to the deterministic bucket id when absent) and stamped as `cf-aig-metadata.user` so the customer's gateway per-user analytics attribute usage to the real identity; the user's single matched Access group (when groups are configured) is stamped alongside as `cf-aig-metadata.group` for per-group gateway routing/cost/rate-limit policies |
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

**Status:** Implemented

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

**Status:** Implemented

---

<!-- @test: src/__tests__/llm-interceptor.test.ts (LlmInterceptor describe -> api.openai.com mapped onto the AI Gateway REST API (api.cloudflare.com/.../ai/v1/*) with account+gateway parsed from AIG_GATEWAY_URL + Authorization Bearer AIG_TOKEN + cf-aig-gateway-id + cf-aig-metadata stamped with the user email (+ matched group when the group prop is set, omitted when absent) + placeholder auth replaced + streaming preserved + streaming terminator repair (missing finish_reason synthesized before [DONE]; idempotent; tool_calls vs stop) + compat fallback on REST 404 for a model-routable request (gateway.ai.cloudflare.com/v1/{acct}/{gw}/compat/* with cf-aig-authorization, buffered body replayed, OpenAI-only fields (store/prompt_cache_key) stripped on the compat leg but kept on REST; no fallback on non-404 or non-model-routable path) + unmapped host (incl. api.anthropic.com) 400 + gateway-unset/unparseable 503 -> AC1..AC7) -->
<!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (enterprise bypass describe -> monthly compute quota never enforced AC3 — enterprise users are never blocked by the monthly compute quota) -->
<!-- @test: src/__tests__/container/index.test.ts (enterprise LLM interception wiring describe -> "stamps the user email (not the bucket id) as the interceptor per-user prop" -> AC4; the describe is labelled REQ-ENTERPRISE-011 for the wiring-ordering subject, but this it() also verifies REQ-ENTERPRISE-004 AC4 email attribution) -->
### REQ-ENTERPRISE-004: Outbound-Interception LLM Routing to Customer AI Gateway

<!-- @impl: src/llm-interceptor.ts::LlmInterceptor -->
<!-- @impl: src/container/index.ts::setupEnterpriseInterception -->
<!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->

**Intent:** Enterprise deployments route all agent LLM traffic to the customer's AI Gateway via platform outbound-HTTPS interception, so the gateway credentials never reach the container, nothing is exposed over a public route, and all usage is attributable.

**Applies To:** User

**Acceptance Criteria:**

1. The container DO routes the container's outbound HTTPS to the real LLM provider host (`api.openai.com`) through a `WorkerEntrypoint` (`LlmInterceptor`) via `ctx.container.interceptOutboundHttps` + `ctx.exports`; the interceptor forwards each request to the customer's AI Gateway **REST API** (`https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/*`), mapping the OpenAI path verbatim under `/ai`. If the REST API returns `404` for a model-routable request (a `POST` to a `/chat/completions` or `/responses` path, whose body is buffered so it can be replayed), the interceptor replays the buffered request to the deprecated compat path (`https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/<path>`) with `cf-aig-authorization: Bearer <AIG_TOKEN>` in place of `Authorization: Bearer`; non-model-routable paths and non-404 responses do not trigger the fallback. On this compat replay the interceptor strips OpenAI-only request fields (`store`, `prompt_cache_key`) that non-OpenAI providers (e.g. `google-ai-studio`) reject with a `400`; the REST API leg keeps them so OpenAI prompt caching is unaffected.
2. The AI Gateway URL and token are read only from the interceptor's Worker env (`AIG_GATEWAY_URL`, `AIG_TOKEN`) and are never sent to or readable from the container; there is no public Worker route carrying LLM traffic, so the path never traverses Cloudflare Access. The account id (URL path) and gateway id (`cf-aig-gateway-id` header) are parsed from `AIG_GATEWAY_URL`.
3. Streaming responses are preserved end-to-end (the upstream stream is piped through without buffering the full body). A streamed chat-completions response whose terminal `finish_reason` chunk is missing — as the AI Gateway dynamic-route wrapper omits it on the wire — is normalized: a synthetic terminator chunk (`finish_reason` `stop`, or `tool_calls` when the stream carried tool-call deltas) is injected before `data: [DONE]` so strict OpenAI-wire clients (Pi, Copilot) see a complete stream and do not error/retry. Idempotent — when the upstream already sends a non-null `finish_reason` nothing is injected; only streamed `chat/completions` responses are touched.
4. Each forwarded request stamps `cf-aig-gateway-id` with the gateway id and `cf-aig-metadata` with the user's email (passed as a per-session DO prop) so the gateway's per-user analytics attribute usage to the real identity, falling back to the deterministic bucket id when no email is set; when the deployment configures Access groups, the user's single matched group is stamped alongside as `cf-aig-metadata.group` (omitted when absent) so gateway rules can branch routing/cost/rate-limit policies per group. On the REST API leg the gateway auth is `Authorization: Bearer <AIG_TOKEN>`; on the compat fallback leg it is `cf-aig-authorization: Bearer <AIG_TOKEN>` (the compat endpoint requires this header instead).
5. The container's placeholder credential (`Authorization` / `x-api-key`) is stripped before forwarding so it never reaches the gateway; gateway auth is stamped separately.
6. The interceptor maps only the known provider host (`api.openai.com`); an unmapped host (including `api.anthropic.com`, which is not an enterprise agent host) fails closed (400) and an unconfigured/unparseable gateway fails closed (503) — neither forwards anywhere.
7. When `ENTERPRISE_MODE` is unset, the DO never wires interception, the interceptor is never instantiated, and agent LLM traffic follows the current direct-key path, byte-identical to current behavior.

**Constraints:**

- Interception uses the Cloudflare Containers platform mechanism (`interceptOutboundHttps` + `ctx.exports`, on by default at this project's compat date — the `enable_ctx_exports` flag became the default on 2025-11-17, so no flag is set); HTTPS interception requires the container to trust the CA at `/etc/cloudflare/certs/cloudflare-containers-ca.crt` ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls)).
- The per-user attribution stamped into `cf-aig-metadata` is the user's email (falling back to the deterministic bucket id when absent), so the customer's gateway analytics attribute usage to the real identity — an enterprise requirement that intentionally overrides the original opaque-id design.
- The set of intercepted provider hosts is fixed in code; adding a provider requires a code change, not a request parameter.
- The primary transport target is the AI Gateway REST API (`api.cloudflare.com`); when a model-routable request returns `404` (e.g. the `google-ai-studio` provider being absent from the REST API), the interceptor falls back to the deprecated compat path (`gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/*`, `cf-aig-authorization: Bearer`) — safe because a 404 is a complete error body, not a started stream, so there is no double-billing or truncation risk ([AD74](../../documentation/decisions/README.md) dual-transport amendment). Backend selection is gateway-side via the route id stamped by the interceptor ([REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning)); agents carry only a fixed slash-free handle.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var)

**Verification:** [Automated test](../../src/__tests__/llm-interceptor.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/container/container-env-llm.test.ts (enterprise env injection describe -> ENTERPRISE_MODE emitted from env when active + COPILOT_MODEL/PI_MODEL never fanned into the container (route id is Worker-only) + no gateway URL/token/route/base-URL ever injected + ENTERPRISE_MODE omitted when flag unset/non-active -> AC1..AC6) -->
### REQ-ENTERPRISE-005: Container-Side Enterprise Routing (CA Trust + Constant Base-URLs)

<!-- @impl: src/container/container-env.ts::buildEnvVars -->
<!-- @impl: entrypoint.sh -->
<!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->

**Intent:** Agents in Enterprise Mode must be work-ready against the AI Gateway with zero manual login and zero injected credentials, so the container only learns it is in enterprise mode and configures itself to use the intercepted provider hosts.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, the container env pipeline emits exactly one enterprise var — `ENTERPRISE_MODE=active`; no gateway route id, agent model id, base-URL, or token is ever injected into the container.
2. When `ENTERPRISE_MODE=active`, the Cloudflare containers CA is installed into the system trust store and the Node/Python CA env vars (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`) are prepended to `.bashrc` (idempotent, enterprise-gated) so the PTY-spawned agent shells inherit them and all agent HTTPS clients trust the intercepted (TLS-terminated) connections — a process-only export does not reach the agents.
3. When `ENTERPRISE_MODE=active`, Copilot is configured via the complete BYOK contract pointing at the constant real provider base-URL (`api.openai.com`) with a non-secret placeholder credential and a fixed, slash-free model handle (`codeflare`); the BYOK vars (`COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_API_KEY`, `COPILOT_MODEL`) plus the token-limit hints (`COPILOT_PROVIDER_MAX_PROMPT_TOKENS`, `COPILOT_PROVIDER_MAX_OUTPUT_TOKENS`) are prepended to `.bashrc` so the copilot PTY inherits them — a process-only export does not reach the agent and leaves Copilot to fall back to GitHub-hosted models; the token-limit hints suppress Copilot's "model not in catalog" warning and right-size the context to the routed model's window (gpt-5.5: 1,050,000 / 128,000), since the slash-free `codeflare` handle is a dynamic-route alias absent from Copilot's built-in catalog; the interceptor rewrites the model to the gateway route on egress ([REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning) AC1).
4. When `ENTERPRISE_MODE=active`, Pi is configured with a custom provider entry pointing at `api.openai.com` using the `openai-completions` adapter (`api: "openai-completions"`). The model is registered with `reasoning: true` so Pi's thinking-level selector stays available (Shift+Tab / `/settings`), but `settings.json` pins `defaultThinkingLevel: "off"` so every session starts with thinking off and Pi sends no `reasoning_effort` by default — which keeps gpt-5.5 at 200 (it rejects `reasoning_effort` + function tools together on `/v1/chat/completions`, and the CF AI Gateway's `/ai/v1/responses` endpoint currently rejects valid Responses bodies, "Required value missing: messages", which blocks the `openai-responses` adapter). Raising the level lets a route model that supports reasoning over chat/completions (e.g. Gemini) think; gpt-5.5 returns HTTP 400 for any thinking level above "off" until CF fixes `/ai/v1/responses`. The provider uses the same placeholder credential and the same slash-free handle, and its default provider and model are pinned so it reaches the gateway without any manual login step.
5. The container never receives the AI Gateway URL, the gateway token, or any per-session secret; routing to the gateway is done entirely by the DO's outbound interception ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)).
6. When `ENTERPRISE_MODE` is unset, `ENTERPRISE_MODE` is not emitted, no agent configuration block runs, and the container env is byte-identical to current behavior.

**Constraints:**

- The placeholder credential is a fixed non-secret constant; the interceptor strips it before forwarding ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC5), so it never reaches the gateway.
- `ENTERPRISE_MODE` rides the existing container env pipeline ([REQ-AGENT-031](agents.md#req-agent-031-llm-api-key-propagation-to-container)); no per-agent login step is added.
- `AIG_LANGUAGE_MODEL` is a non-secret Worker-only routing hint; it is never injected into the container. Backend keys stay in the gateway (BYOK).
- Only the allowlisted enterprise agents ([REQ-ENTERPRISE-003](#req-enterprise-003-agent-allowlist-in-enterprise-mode)) are configured; `bash` needs no LLM configuration.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning), [REQ-AGENT-031](agents.md#req-agent-031-llm-api-key-propagation-to-container)

**Verification:** [Automated test](../../src/__tests__/container/container-env-llm.test.ts)

**Status:** Planned

---

<!-- @test: src/__tests__/lib/enterprise-mode.test.ts (deploy-time plumbing describe -> AIG_GATEWAY_URL + AIG_TOKEN read as secrets + ENTERPRISE_MODE read as var + off by default when binding absent -> AC1..AC4) -->
<!-- @test: src/__tests__/routes/setup/access.test.ts (handleCreateAccessApp describe -> enterprise mode creates a host-scoped app (bare host domain + whole-host destination) AC5 + default/SaaS app stays path-scoped (/app/* primary + path destinations) regression) -->
### REQ-ENTERPRISE-006: Deploy-Time AIG Secrets and ENTERPRISE_MODE Var

<!-- @impl: wrangler.toml -->
<!-- @impl: .github/workflows/deploy.yml -->
<!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->
<!-- @impl: src/routes/setup/access.ts::getManagedAppDomain -->

**Intent:** Enterprise configuration must be supplied at deploy time through Worker bindings, kept secret where appropriate, and default to off.

**Applies To:** Admin

**Acceptance Criteria:**

1. `AIG_GATEWAY_URL` and `AIG_TOKEN` are configured as Worker secrets so they are not stored in plaintext config or exposed to the container. `AIG_TOKEN` must carry **both** the Workers AI permission (required for the REST API path, `Authorization: Bearer`) and the AI Gateway Run permission (required for the compat fallback path, `cf-aig-authorization: Bearer`); a token missing either scope is rejected with `error 10000` on the corresponding transport.
2. `ENTERPRISE_MODE` and the optional `AIG_LANGUAGE_MODEL` (gateway route id) are configured as non-secret Worker vars; `AIG_LANGUAGE_MODEL` is read only by the interceptor for route-pinning (see [REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning)) and is never injected into the container.
3. Enterprise Mode is off by default: an absent or empty `ENTERPRISE_MODE` binding resolves to disabled.
4. When `ENTERPRISE_MODE` is enabled, the interceptor fails closed (503) if the `AIG_GATEWAY_URL` secret is missing or unparseable (no `/v1/{account_id}/{gateway_id}` segments), rather than silently routing to nowhere, and the DO logs a warning when it skips interception wiring.
5. When `ENTERPRISE_MODE` is configured, the CF Access application created by the setup wizard is host-scoped (bare custom domain, no path suffix) so the session cookie covers all paths uniformly; non-enterprise deployments retain the path-scoped (`/app/*`) application.

**Constraints:**

- The flag is evaluated at deploy time from bindings, consistent with the deployment-mode determination in [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes).
- Secrets are never written to the container env; the only enterprise env var the container receives is the `ENTERPRISE_MODE` flag, derived from a Worker deploy var, never from session state ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC1). The gateway route id stays Worker-only.
- `AIG_GATEWAY_URL` is the single source for the gateway coordinates: the interceptor parses the account id and gateway id from it for the REST API call ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC2), so no separate account-id binding is required.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes)

**Verification:** [Automated test](../../src/__tests__/lib/enterprise-mode.test.ts)

**Status:** Planned

---

<!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-007: gateway route-pinning (model rewrite) describe -> request model rewritten to AIG_LANGUAGE_MODEL on /chat/completions & /responses AC1 + passthrough when unset/non-routable/non-JSON/model-less AC2 -> AC1..AC2) -->
### REQ-ENTERPRISE-007: Gateway Route-Pinning

<!-- @impl: src/llm-interceptor.ts::LlmInterceptor -->
<!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->

**Intent:** The gateway route must be selected Worker-side so agents carry only a fixed slash-free model handle, eliminating agent-side model-string parsing (e.g. Pi reading a `dynamic/<route>` slash as `provider/model`) that would misroute traffic away from the interceptor.

**Applies To:** User

**Acceptance Criteria:**

1. When `AIG_LANGUAGE_MODEL` is set, the interceptor rewrites the request body's `model` field to that route id before forwarding, on the model-routable endpoints `/chat/completions` and `/responses`.
2. When `AIG_LANGUAGE_MODEL` is unset, or the body is non-JSON, has no `model` field, or the path is not model-routable, the request body is forwarded unchanged.

**Constraints:**

- `AIG_LANGUAGE_MODEL` is a non-secret Worker-only var ([REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var) AC2); it is never injected into the container, and agents carry only a fixed slash-free handle (`codeflare`) ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC3, AC4).
- Only the request `model` field is rewritten; no other request field and no response byte is altered.
- Route-pinning runs only when interception is active ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)); when `ENTERPRISE_MODE` is unset the interceptor is never instantiated.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var)

**Verification:** [Automated test](../../src/__tests__/llm-interceptor.test.ts)

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx (real-component renders -> SettingsPanel Administration hides Manage Subscriptions + Manage Users AC1 + Header username dropdown hides Usage + Subscription AC2 + SettingsPanel/SessionSection mode selector not rendered AC3 + every surface byte-identical when flag unset AC6) -->
<!-- @test: web-ui/src/__tests__/components/enterprise-layout-suppression.test.tsx (Layout -> quota banners + upgrade CTAs not rendered AC4 + enterpriseMode threaded to TerminalArea→Dashboard dropdown AC2 + SettingsPanel admin AC1 + byte-identical when flag unset AC6) -->
<!-- @test: web-ui/src/__tests__/components/enterprise-app-routing.test.tsx (App -> first-time enterprise user routed to /app/ not onboarding/subscribe AC5 + non-enterprise SaaS user still redirected when flag unset AC6) -->
<!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (Enterprise mode surface suppression describe -> setup wizard hides Regular Users section when enterpriseMode set + still renders Admin Users + Access Group field AC7 + Regular Users renders when flag unset, default render tests) -->
### REQ-ENTERPRISE-008: Enterprise Frontend Surface Suppression

<!-- @impl: web-ui/src/components/SettingsPanel.tsx -->
<!-- @impl: web-ui/src/components/Header.tsx -->
<!-- @impl: web-ui/src/components/Dashboard.tsx -->
<!-- @impl: web-ui/src/components/Layout.tsx -->
<!-- @impl: web-ui/src/components/settings/SessionSection.tsx -->
<!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx -->
<!-- @impl: web-ui/src/App.tsx -->

**Intent:** In Enterprise Mode the deployment is single-tenant with no self-serve billing and no in-product user administration, so every SaaS- and admin-oriented frontend surface that would be meaningless or misleading must not render.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, the Settings → Administration section renders neither the "Manage Subscriptions" nor the "Manage Users" entry.
2. When `ENTERPRISE_MODE` is set, the username dropdown — in both the Header menu and the Dashboard menu — renders neither the "Usage" nor the "Subscription" entry.
3. When `ENTERPRISE_MODE` is set, the Standard/Pro session-mode selector is not rendered; every user is implicitly Pro (advanced) per [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC2.
4. When `ENTERPRISE_MODE` is set, the monthly-quota warning banners and their "Upgrade" calls-to-action are not rendered.
5. When `ENTERPRISE_MODE` is set, a first-time (auto-provisioned) user is routed to the application home, never to `/app/subscribe` or the self-serve onboarding/waitlist flow.
6. When `ENTERPRISE_MODE` is unset, every surface in AC1–AC5 renders byte-identically to current behavior.
7. When `ENTERPRISE_MODE` is set, the setup wizard's "Regular Users" section is not rendered — setup configures only Admin Users and the optional Cloudflare Access group, since regular users are provisioned via Cloudflare Access on first sign-in per [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning); when unset, the section renders unchanged.

**Constraints:**

- The frontend decides what to suppress from the deploy-time `enterpriseMode` signal already exposed by `GET /api/user`, never from the user's tier or role.
- Suppression is render-gating only: it removes no component code path for non-enterprise deployments and deletes no stored user state.
- This REQ concretizes the surface list implied by [REQ-ENTERPRISE-002](#req-enterprise-002-subscription-ui-hidden-and-subscribe-route-guarded) AC1 (which owns the `/app/subscribe` route guard) and adds the admin-button, mode-selector, and first-login-routing surfaces. Visibility only; the matching routes are made unreachable server-side in [REQ-ENTERPRISE-009](#req-enterprise-009-enterprise-backend-route-hardening).

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-002](#req-enterprise-002-subscription-ui-hidden-and-subscribe-route-guarded), [REQ-ENTERPRISE-010](#req-enterprise-010-access-gated-jit-user-provisioning)

**Verification:** [Automated test](../../web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx) (AC1–AC3, AC6); [enterprise-layout-suppression.test.tsx](../../web-ui/src/__tests__/components/enterprise-layout-suppression.test.tsx) (AC4); [enterprise-app-routing.test.tsx](../../web-ui/src/__tests__/components/enterprise-app-routing.test.tsx) (AC5); [ConfigureStep.test.tsx](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx) (AC7)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/enterprise-route-hardening.test.ts (enterprise route hardening describe -> user-mgmt routes 403 AC1 + billing checkout/portal/switch 403 & status empty AC2 + auth subscribe/request-access 403 no email AC3 + stripe webhook no-op no KV mutation AC4 + admin tier/sub config 403 AC5 + PATCH preferences not fail-closed, accepts sessionMode AC6 (entitlement-gate detail in preferences-enterprise.test.ts) + every route byte-identical when flag unset AC7) -->
### REQ-ENTERPRISE-009: Enterprise Backend Route Hardening

<!-- @impl: src/routes/users.ts -->
<!-- @impl: src/routes/billing.ts -->
<!-- @impl: src/routes/stripe-webhook.ts -->
<!-- @impl: src/routes/auth.ts -->
<!-- @impl: src/routes/preferences.ts -->
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

<!-- @impl: src/lib/access.ts::authenticateRequest -->
<!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser -->
<!-- @impl: src/lib/jwt.ts -->
<!-- @impl: src/routes/setup/index.ts -->
<!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS -->
<!-- @impl: src/lib/subscription.ts::isEnterpriseMode -->

**Intent:** In Enterprise Mode users are managed by the customer's Cloudflare Access, not inside Codeflare, so any Access-authenticated user entitled to the deployment must be provisioned automatically on first access — a fresh user lands work-ready with no in-product allowlisting or approval step.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set and an authenticated request presents a valid (RS256-verified, audience-checked) Cloudflare Access JWT for an `email` with no existing user record, Codeflare auto-creates a record `{ addedBy: 'enterprise-jit', role: 'user', accessTier: 'advanced', subscriptionTier: 'unlimited' }` keyed by the JWT's IdP-verified `email`, and the request proceeds as that user. (`accessTier` tops out at `advanced`; `unlimited` is the *subscription* tier — `getEffectiveTier` already resolves enterprise users to `unlimited` per REQ-ENTERPRISE-001.)
2. When the optional `ENTERPRISE_ACCESS_GROUP` (set at setup, stored in KV) is configured, provisioning first resolves the user's group membership via the Access `get-identity` endpoint (derived from the JWT `iss`, authenticated with the request's `CF_Authorization` token) and, when the user is in none of the configured groups, denies the request with Codeflare's standard not-authorized response (the existing `ForbiddenError` 403 path — the same one a non-allowlisted user hits in Cloudflare-Access mode) and creates no record.
3. When `ENTERPRISE_ACCESS_GROUP` is unset, a valid Access JWT alone is sufficient to provision; the group gate is delegated to the customer's Access application policy.
4. Provisioning is idempotent: concurrent first-logins converge on a single record, and an existing record — whether a setup admin or a prior JIT user — is returned unchanged (JIT never overwrites a role or downgrades an admin).
5. Enterprise JIT sends no welcome or subscription email; the per-user R2 bucket and scoped token continue to be created lazily on first session start, unchanged.
6. When `ENTERPRISE_MODE` is unset, an Access-authenticated user with no record still receives 403 with no auto-provisioning, and the authentication path is byte-identical to current behavior.

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

<!-- @impl: src/container/index.ts::startAndWaitForPorts -->
<!-- @impl: src/container/index.ts::setupEnterpriseInterception -->

**Intent:** Enterprise LLM interception must be wired before the container boots, so the ephemeral Cloudflare containers CA exists when the container entrypoint installs it into the trust store; wiring it after boot makes the intercepted TLS handshake fail and no agent can reach the gateway.

**Applies To:** User

**Acceptance Criteria:**

1. The DO registers outbound interception (`interceptOutboundHttps`, [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC1) **before the container starts** — in the `startAndWaitForPorts` override, ahead of the SDK's `container.start()`, mirroring where the SDK applies its own pre-start interception — so the ephemeral Cloudflare containers CA at `/etc/cloudflare/certs/` is mounted in time for entrypoint.sh to install it into the trust store ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC2). Wiring after boot (e.g. in `onStart`) leaves the entrypoint with no cert to trust, so every intercepted-TLS handshake to the provider host fails with a connection error.
2. When `ENTERPRISE_MODE` is unset, the `startAndWaitForPorts` override performs no interception work and the container start path is byte-identical to current behavior.

**Constraints:**

- Wiring runs on the start chokepoint that all start paths funnel through (explicit start + container-fetch auto-start), before the SDK boots the container.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls)

**Verification:** [Automated test](../../src/__tests__/container/index.test.ts)

**Status:** Implemented
