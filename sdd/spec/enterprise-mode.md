# Enterprise Mode Domain Specification

Deploy-time enterprise configuration: single-tenant unlimited access, subscription bypass, and a Worker-side LLM proxy to a customer-owned AI Gateway.

### Key Concepts

| Concept | Definition |
|---------|-----------|
| Enterprise Mode | A deploy-time configuration, toggled by the `ENTERPRISE_MODE` Worker var, that turns a Codeflare deployment into a single-tenant enterprise instance: every user resolves to the `unlimited` tier in Pro (advanced) session mode and subscription/billing is disabled |
| AI Gateway | The customer's Cloudflare AI Gateway endpoint that fronts the upstream LLM providers; its URL and token are held only in the Worker as secrets (`AIG_GATEWAY_URL`, `AIG_TOKEN`) |
| LLM Proxy | A Worker route that forwards an agent's provider-shaped request to the customer's AI Gateway, keeping the gateway credentials out of the container |
| Per-Session Proxy Token | A short-lived signed token, minted per session, that authenticates the agent-to-Worker hop on the LLM proxy route |
| Provider Allowlist | The fixed set of upstream LLM providers the proxy will forward to; any other target is rejected to prevent SSRF |

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
| Agents | Session-mode resolution forces Pro mode and the agent roster is narrowed (see [REQ-AGENT-004](agents.md#req-agent-004-two-session-modes-standard-and-pro)); per-session proxy injection rides the container env pipeline (see [REQ-AGENT-031](agents.md#req-agent-031-llm-api-key-propagation-to-container)) |
| Setup | `ENTERPRISE_MODE`, `AIG_GATEWAY_URL`, and `AIG_TOKEN` are configured at deploy time alongside the existing deployment-mode bindings (see [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes)) |
| Security | The LLM proxy authenticates the agent hop with a signed per-session token and constrains forwarding to a provider allowlist |

---

<!-- @test: src/__tests__/lib/enterprise-mode.test.ts (resolveEnterpriseMode describe -> ENTERPRISE_MODE flag forces unlimited tier + advanced session mode + subscription disabled -> AC1..AC4; flag-unset parity describe -> tier/mode/subscription resolution byte-identical to baseline across Default/Onboarding/SaaS -> AC5) -->
### REQ-ENTERPRISE-001: ENTERPRISE_MODE Forces Unlimited Tier and Pro Mode

<!-- @impl: src/lib/enterprise-mode.ts::resolveEnterpriseMode -->
<!-- @impl: src/lib/subscription.ts -->
<!-- @impl: src/lib/session-mode.ts::resolveSessionMode -->

**Intent:** A deploy-time `ENTERPRISE_MODE` flag must turn a deployment into a single-tenant enterprise instance where every user gets full access without subscription friction.

**Applies To:** Admin

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, every user's effective tier resolves to `unlimited` regardless of the stored `subscriptionTier`.
2. When `ENTERPRISE_MODE` is set, session-mode resolution returns Pro (`advanced`) for every user regardless of the stored preference.
3. When `ENTERPRISE_MODE` is set, subscription enforcement (quota gating, billing-status checks, trial logic) is disabled so no user is ever blocked on a payment or quota condition.
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

<!-- @impl: src/lib/enterprise-mode.ts::resolveEnterpriseMode -->
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

<!-- @test: src/__tests__/routes/session-agent-allowlist.test.ts (enterprise agent allowlist describe -> session creation accepts only claude-code/copilot/pi/bash when enterprise + rejects the other three + accepts all seven when flag unset -> AC1..AC4) -->
### REQ-ENTERPRISE-003: Agent Allowlist in Enterprise Mode

<!-- @impl: src/lib/enterprise-mode.ts::resolveEnterpriseMode -->
<!-- @impl: src/routes/session/crud.ts -->
<!-- @impl: src/types.ts::AgentTypeSchema -->

**Intent:** Enterprise deployments standardize on a curated agent set, so session creation must restrict the selectable agents when the flag is set.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, the selectable agent set is exactly `{claude-code, copilot, pi, bash}`.
2. When `ENTERPRISE_MODE` is set, session creation rejects any agent type outside the enterprise allowlist.
3. When `ENTERPRISE_MODE` is set, the session-creation UI offers only the allowlisted agents.
4. When `ENTERPRISE_MODE` is unset, all seven agent types from [REQ-AGENT-001](agents.md#req-agent-001-support-multiple-ai-coding-agents) remain selectable, byte-identical to current behavior.

**Constraints:**

- The allowlist is applied on top of the existing agent-type validation; it narrows the set rather than replacing the schema.
- The enterprise allowlist is a fixed set, not admin-configurable, in this domain.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-AGENT-001](agents.md#req-agent-001-support-multiple-ai-coding-agents), [REQ-AGENT-002](agents.md#req-agent-002-agent-selection-at-session-creation)

**Verification:** [Automated test](../../src/__tests__/routes/session-agent-allowlist.test.ts)

**Status:** Planned

---

<!-- @test: src/__tests__/routes/llm-proxy.test.ts (LLM proxy describe -> per-provider passthrough to AIG + streaming preserved + cf-aig-metadata stamped with opaque user id + signed per-session token required + provider allowlist rejects unknown target + flag-unset route absent -> AC1..AC7) -->
### REQ-ENTERPRISE-004: Worker-Side LLM Proxy to Customer AI Gateway

<!-- @impl: src/routes/llm-proxy.ts -->
<!-- @impl: src/lib/enterprise-mode.ts::resolveEnterpriseMode -->

**Intent:** Enterprise deployments route all agent LLM traffic through the customer's AI Gateway so the gateway credentials never reach the container and all usage is attributable.

**Applies To:** User

**Acceptance Criteria:**

1. A Worker route forwards an agent's provider-shaped request to the customer's AI Gateway via a per-provider `fetch()` passthrough.
2. The AI Gateway URL and token are read only from Worker secrets (`AIG_GATEWAY_URL`, `AIG_TOKEN`) and are never sent to or readable from the container.
3. Streaming responses are preserved end-to-end (the upstream stream is piped through without buffering the full body).
4. Each forwarded request stamps `cf-aig-metadata` with an opaque per-user identifier that does not expose the user's email or raw identity.
5. The route requires a valid signed per-session token to authenticate the agent-to-Worker hop; requests without a valid token are rejected.
6. The route forwards only to providers on a fixed allowlist; any non-allowlisted target is rejected to prevent SSRF.
7. When `ENTERPRISE_MODE` is unset, the proxy route is not registered and agent LLM traffic follows the current direct-key path, byte-identical to current behavior.

**Constraints:**

- The signed per-session token is minted by the Worker and scoped to a single session; it is not a long-lived credential.
- The opaque per-user id is derived deterministically from the user identity so requests from one user are correlatable in the gateway without revealing the identity.
- The provider allowlist is a fixed set; adding a provider requires a code change, not a request parameter.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-006](#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var)

**Verification:** [Automated test](../../src/__tests__/routes/llm-proxy.test.ts)

**Status:** Planned

---

<!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars enterprise proxy describe -> per-session proxy base-URL + token injected per agent (Claude ANTHROPIC_BASE_URL/_AUTH_TOKEN, Copilot BYOK, Pi base-URL) when enterprise + absent when flag unset -> AC1..AC5) -->
### REQ-ENTERPRISE-005: Per-Session Proxy Credentials Injected per Agent

<!-- @impl: src/container/container-env.ts::buildEnvVars -->
<!-- @impl: src/lib/enterprise-mode.ts::resolveEnterpriseMode -->

**Intent:** Agents in Enterprise Mode must be work-ready against the LLM proxy with zero manual login, so the proxy base URL and per-session token are injected into the container per agent.

**Applies To:** User

**Acceptance Criteria:**

1. When `ENTERPRISE_MODE` is set, the container env pipeline injects the proxy base URL and the per-session signed token for the selected agent.
2. Claude Code receives the proxy base URL and token via `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`.
3. Copilot receives the proxy via its bring-your-own-key configuration channel.
4. Pi receives the proxy base URL via its provider base-URL configuration channel.
5. When `ENTERPRISE_MODE` is unset, none of these proxy variables are injected and the container env is byte-identical to current behavior.

**Constraints:**

- The injected token is the same per-session signed token the proxy route validates ([REQ-ENTERPRISE-004](#req-enterprise-004-worker-side-llm-proxy-to-customer-ai-gateway) AC5), scoped to the session.
- Injection rides the existing container env pipeline ([REQ-AGENT-031](agents.md#req-agent-031-llm-api-key-propagation-to-container)); no per-agent login step is added.
- Only the allowlisted enterprise agents ([REQ-ENTERPRISE-003](#req-enterprise-003-agent-allowlist-in-enterprise-mode)) have a defined injection channel; `bash` receives no LLM proxy variables.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-004](#req-enterprise-004-worker-side-llm-proxy-to-customer-ai-gateway), [REQ-AGENT-031](agents.md#req-agent-031-llm-api-key-propagation-to-container)

**Verification:** [Automated test](../../src/__tests__/container/container-env.test.ts)

**Status:** Planned

---

<!-- @test: src/__tests__/lib/enterprise-mode.test.ts (deploy-time plumbing describe -> AIG_GATEWAY_URL + AIG_TOKEN read as secrets + ENTERPRISE_MODE read as var + off by default when binding absent -> AC1..AC4) -->
### REQ-ENTERPRISE-006: Deploy-Time AIG Secrets and ENTERPRISE_MODE Var

<!-- @impl: wrangler.toml -->
<!-- @impl: src/lib/enterprise-mode.ts::resolveEnterpriseMode -->

**Intent:** Enterprise configuration must be supplied at deploy time through Worker bindings, kept secret where appropriate, and default to off.

**Applies To:** Admin

**Acceptance Criteria:**

1. `AIG_GATEWAY_URL` and `AIG_TOKEN` are configured as Worker secrets so they are not stored in plaintext config or exposed to the container.
2. `ENTERPRISE_MODE` is configured as a Worker var (non-secret) read by the enterprise-mode resolver.
3. Enterprise Mode is off by default: an absent or empty `ENTERPRISE_MODE` binding resolves to disabled.
4. When `ENTERPRISE_MODE` is enabled, the deployment surfaces a clear error path if the `AIG_GATEWAY_URL` or `AIG_TOKEN` secrets are missing, rather than silently proxying to nowhere.

**Constraints:**

- The flag is evaluated at deploy time from bindings, consistent with the deployment-mode determination in [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes).
- Secrets are never written to the container env; only the per-session proxy base URL and token are ([REQ-ENTERPRISE-005](#req-enterprise-005-per-session-proxy-credentials-injected-per-agent)).

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-SETUP-003](setup.md#req-setup-003-three-deployment-modes)

**Verification:** [Automated test](../../src/__tests__/lib/enterprise-mode.test.ts)

**Status:** Planned
