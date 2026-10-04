# Models & Routing Requirements

## Scope and ownership

This domain owns model routing, authorization, discovery, capability profiles, wire compatibility, replay, caching and container publication. Relocated REQ-ENTERPRISE identifiers retain their whole-record obligations, traceability comments, verification qualifiers, statuses and legacy aliases. Section headings organize existing contracts; they introduce no behavior or status change.

Setup and Administration configuration remains in [Setup](setup.md); tier behavior in [Subscription](subscription.md); agent availability in [Agents](agents.md); identity in [Authentication](authentication.md); network and governance policy in [Security](security.md); storage behavior in [Storage](storage.md).

## Routing and authorization

### REQ-ENTERPRISE-004: Outbound-Interception LLM Routing to Customer AI Gateway

**Intent:** Enterprise deployments route sanctioned agent LLM traffic to the customer's AI Gateway via platform outbound-HTTPS interception, so gateway credentials never reach the container, nothing is exposed over a public route, and all sanctioned usage is attributable. Independently permitted personal providers remain governed by [REQ-ENTERPRISE-090](#req-enterprise-090-native-pi-forwarding-under-current-administration-permission).

**Applies To:** User

**Acceptance Criteria:**

1. The container DO routes outbound HTTPS for the real LLM provider host (`api.openai.com`) through a session-bound Worker interceptor. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-004: compat fallback on REST 404 (dual transport — AD74 amendment)) -->
2. The interceptor receives Worker-resolved gateway coordinates and credentials without exposing them through the container or a public route. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-017: AI Gateway URL/token resolved from props (wizard) with env fallback) --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-004: enabled personal permission preserves sanctioned Dynamic Route routing) --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-004: enabled personal permission preserves sanctioned managed Native Route routing) -->
3. Streaming responses are preserved end-to-end. A streamed chat-completions response whose terminal `finish_reason` chunk is missing as the AI Gateway dynamic-route wrapper omits it on the wire. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-004: streaming terminator repair (AC3 — dynamic-route finish_reason fix)) -->
4. Forwarded requests stamp gateway ID plus user email or bucket fallback; up to four matched groups become deterministic metadata tags, and the session's first configured matching group controls route restrictions. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @impl: src/lib/access.ts::resolveRouteCatalog --> <!-- @impl: src/lib/access.ts::resolveSessionAccessGroup --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
5. The container's placeholder credential (`Authorization` / `x-api-key`) is stripped before forwarding so it never reaches the gateway; gateway auth is stamped separately. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-004: placeholder-auth stripping) -->
6. For sanctioned Gateway routing, the interceptor maps only the known provider host (`api.openai.com`); an unmapped host (including `api.anthropic.com`, which is not an enterprise agent host) fails closed (400) and an unconfigured/unparseable gateway fails closed (503) — neither forwards anywhere. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-004 / REQ-ENTERPRISE-006 AC4: fail-closed guards) -->
7. When `ENTERPRISE_MODE` is unset, the DO never wires interception, the interceptor is never instantiated, and agent LLM traffic follows the current direct-key path, byte-identical to current behavior. <!-- @impl: src/container/index.ts::startAndWaitForPorts --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-016 / AD86: AI Gateway is platform-native — always direct egress, never cf1:network) -->

**Constraints:**

- Interception uses `interceptOutboundHttps` with `ctx.exports` and requires container trust in the platform CA ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls)).
- Provider hosts are fixed in code; request parameters cannot add one.
- REST transport maps the provider path under `/ai`; model-route 404s replay through compat with its authorization header after stripping unsupported `store` and `prompt_cache_key` fields.
- Metadata is capped at user plus four configured-order group tags; excess groups produce a warning.
- AI Gateway always egresses directly, never through strict `cf1:network` egress.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-006](setup.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var)

**Verification:** Automated test ([llm-interceptor](../../src/__tests__/llm-interceptor.test.ts))

**Status:** Implemented

---

### REQ-ENTERPRISE-007: Gateway Route-Pinning

**Intent:** The gateway route must be selected Worker-side from the Setup-configured catalog so agents carry only a slash-free model handle, eliminating agent-side model-string parsing (e.g. Pi reading a `dynamic/<route>` slash as `provider/model`) that would misroute traffic away from the interceptor.

**Applies To:** User

**Acceptance Criteria:**

1. On model-routable requests, catalog handles, including allowed pre-prefixed dynamic/<route> handles, map to dynamic/<route>; absent or unknown handles resolve to the eligible scope default. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (assigns the eligible scope default when a JSON inference body omits model) --> <!-- @test: src/__tests__/llm-interceptor.test.ts (retains an allowed pre-prefixed route distinct from the default on %s) -->
2. Sanctioned model-routable requests without an eligible catalog or valid JSON body are rejected before upstream I/O; the separately Administration-permitted personal path cannot rescue stale sanctioned selectors. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (denies an empty catalog without forwarding an agent model) --> <!-- @test: src/__tests__/llm-interceptor.test.ts (rejects non-JSON inference bodies that cannot be assigned an eligible route) -->

**Constraints:**

- The route catalog and default live in KV; slash-free handles reach agents, while gateway routes resolve Worker-side ([REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-012](setup.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list)).
- Route pinning rewrites only `model`, apart from configured profile translation under [REQ-ENTERPRISE-032](#req-enterprise-032-enterprise-pi-route-selection-and-runtime-translation); unrelated request fields and response bytes remain unchanged by pinning.
- Route mapping runs only when interception is active ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)); when `ENTERPRISE_MODE` is unset the interceptor is never instantiated.

- Requests outside model-routable paths retain their bodies unchanged. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (does NOT rewrite a non-model-routable path (e.g. /v1/embeddings)) -->

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-006](setup.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var)

**Verification:** Automated test ([llm-interceptor](../../src/__tests__/llm-interceptor.test.ts))

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

### REQ-ENTERPRISE-013: Per-group dynamic routing

**Intent:** An enterprise admin can scope the dynamic-route catalog per Cloudflare Access group — which routes a group's members may use, and the group's default route + reasoning — so different teams get different model access from one deployment, while sessions without a matching configured group policy receive only the explicitly enabled fallback subset, or no routes when fallback is absent or disabled.

**Applies To:** Admin

**Acceptance Criteria:**

1. Without a matching configured group policy, a session receives only the explicitly enabled fallback subset. <!-- @impl: src/lib/access.ts::resolveRouteCatalog --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (unmatched users use only the enabled fallback subset) -->
2. The first matching configured group remains authoritative even when filtering leaves no eligible routes. <!-- @impl: src/lib/access.ts::resolveRouteCatalog --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (selects the first matching group before eligibility filtering) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (does not fall through from the first matching policy when its routes become ineligible) -->
3. Setup stores per-group route maps, rejects unknown groups, out-of-catalog routes, or defaults outside their group routes with 400, and deletes empty maps. <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) -->
4. The LLM interceptor and container environment consume the same eligible policy catalog, including live-verified and administrator-confirmed routes, and supported scope defaults. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (returns only the allowed verified routes with exact profile levels and scope defaults) -->
5. The Setup wizard renders one per-group routing card per Access group (only when ≥1 group and ≥1 route exist): toggleable route **pills** (selected = green, deselected = gray). <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx::ConfigureStep --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (ConfigureStep) -->
6. All reads/writes are inside the existing `ENTERPRISE_MODE` gate; in non-enterprise modes the Setup request/response shape and route resolution are byte-identical to before. <!-- @test: src/__tests__/routes/setup/handlers.test.ts (Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)) --> <!-- @manual -->

**Constraints:**

- A user matching several configured groups is resolved deterministically by first match in the admin's configured group-list order (not by union or by most-permissive).
- The global catalog remains the universe of routes; a group can only narrow it, never add a route outside it.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-010](authentication.md#req-enterprise-010-access-gated-jit-user-provisioning), [REQ-ENTERPRISE-012](setup.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-ENTERPRISE-032: Enterprise Pi Route Selection and Runtime Translation

**Intent:** Users can select any allowed dynamic route while Codeflare applies that route's configured reasoning contract safely.

**Applies To:** User

**Acceptance Criteria:**

1. Pi lists the live-verified or administrator-confirmed routes allowed by the user's effective policy and starts with that scope's configured supported defaults. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (returns only the allowed verified routes with exact profile levels and scope defaults) -->
2. A `/model` selection uses the selected allowed route's active profile; an unknown handle falls back to the effective default. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (AC2: loads the profile for the route selected through Pi /model) -->
3. Reasoning selections use the assigned profile's exact executable level, otherwise the next higher level, otherwise its highest lower level. <!-- @impl: src/lib/reasoning-profiles.ts::selectRuntimeReasoningLevel --> <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-032: translates Kimi %s within the selected profile to wire effort %s, using the next higher level for Off) --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-032: maps %s to the only executable level in the assigned off-only Dynamic Route profile) -->
4. For authorized requests, existing Chat Completions fallback, Responses passthrough, parsing, replay, and stream repair behavior remains unchanged. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (AC1: replays a model-routable request to the compat path when the REST API returns 404) --> <!-- @test: src/__tests__/llm-interceptor.test.ts (does not touch a non-chat-completions stream (e.g. /responses passes through unchanged)) --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (preserves the validated Pi 0.84.4 canary request and replay fixtures) --> <!-- @test: src/__tests__/llm-interceptor.test.ts (injects a finish_reason:"stop" chunk before [DONE] when the upstream omits it (dynamic-route bug)) -->
5. Without an atomic configuration containing server-owned verification, legacy assignments grant no runtime routes. <!-- @impl: src/lib/access.ts::resolveRouteCatalog --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (does not silently grandfather legacy %s evidence into authority) -->

6. An empty or ineligible sanctioned runtime catalog denies sanctioned inference before upstream I/O; personal forwarding remains independently authorized by current Administration permission and the bound owner/session/generation under [REQ-ENTERPRISE-090](#req-enterprise-090-native-pi-forwarding-under-current-administration-permission). <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (denies an empty catalog on %s before any upstream I/O) -->

7. An eligible unowned native-shaped Dynamic Route dispatches under its exact route selector and assigned profile, including when prefixed with `dynamic/`. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-032: dispatches an authorized unowned native-shaped Dynamic Route with %s prefix and its assigned reasoning) -->

**Constraints:**

- Group-to-route access remains many-to-many; the first configured matching group wins, otherwise only explicitly enabled fallback applies.
- Runtime uses one active profile per route and never predicts a gateway leg from route names or response headers.
- Missing, disabled, invalid, or non-executable profiles remain hard gates.
- Provider-default requests discard explicit reasoning controls while preserving tools and unrelated fields. <!-- @impl: src/lib/reasoning-profiles.ts::translateRuntimeReasoningRequest --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-032: normalizes Dynamic Route provider-default %s without losing tools, replay, or unrelated fields) -->
- Gateway credentials and backend model identities remain outside the container.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-031](#req-enterprise-031-enterprise-pi-capability-profile-administration)

**Verification:** Automated tests in the anchored runtime and host suites above.

**Status:** Implemented

---

### REQ-ENTERPRISE-049: Unified Enterprise Model Authorization

**Intent:** Dynamic Routes and native targets share one fail-closed Worker authorization path.

**Applies To:** Worker

**Acceptance Criteria:**

1. The first matching group policy wins; fallback applies only without a match; native references require enabled, verified targets with current provider identity. <!-- @impl: src/lib/access.ts::resolveRouteCatalog --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (REQ-ENTERPRISE-049: resolves mixed typed targets under first-match policy and current provider authority) -->
2. Provider discovery uses a 60-second cache keyed by account, gateway, and connection fingerprint; expiry failure denies native targets without stale fallback while retaining valid Dynamic Routes. <!-- @impl: src/lib/access.ts::resolveRouteCatalog --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (REQ-ENTERPRISE-049: expired native provider refresh fails closed without denying Dynamic Routes) -->
3. Every interceptor request reauthorizes the opaque handle; revoked or unknown handles fail closed without model fallback. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-049: revoked native handles fail before upstream I/O without fallback) --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-049: rejects a revoked native handle with %s prefix despite an eligible ordinary Dynamic Route) -->

**Constraints:** Dynamic Route KV contains only Dynamic Routes.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-044](setup.md#req-enterprise-044-enterprise-pi-minimum-save-and-access-policies), [REQ-ENTERPRISE-048](#req-enterprise-048-native-provider-capability-catalog), [REQ-ENTERPRISE-052](#req-enterprise-052-native-provider-verification-and-runtime-enforcement), [REQ-ENTERPRISE-053](#req-enterprise-053-native-target-identity-and-document), [REQ-ENTERPRISE-055](#req-enterprise-055-native-target-authority-and-save)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-050: Native Provider Compat Dispatch

**Intent:** Authorized native-provider handles use direct compat dispatch without changing Dynamic Routes.

**Applies To:** Worker

**Acceptance Criteria:**

1. Dynamic Routes retain REST-first behavior; an authorized native handle resolves to its exact Worker-owned selector and performs one direct compat request. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-050: dispatches an authorized native handle once through compat with its Worker-only model selector) --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-050: dispatches %s through its exact Worker-owned selector) -->
2. Native requests carry bounded metadata, credentials, and any validated BYOK alias without changing opaque browser or container identity. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-050: dispatches an authorized native handle once through compat with its Worker-only model selector) --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-050: dispatches %s through its exact Worker-owned selector) -->

**Constraints:** Custom targets require OpenAI-compatible chat completions; dispatch adds no provider fallback or paid retry.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-049](#req-enterprise-049-unified-enterprise-model-authorization)

**Verification:** Anchored interceptor fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-077: Provider-native Bedrock Transport Dispatch

**Intent:** The Worker chooses the validated provider-native Bedrock operation within the target's authorized transport contract.

**Applies To:** Worker

**Acceptance Criteria:**

1. An initial Invoke request calls its configured region-scoped operation exactly once. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::bedrockAnthropicGatewayPath --> <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-073/077: dispatches provider-native Bedrock Invoke with exact reasoning controls and hides signed replay state) -->
2. An initial eventstream request calls its configured region-scoped operation exactly once. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::bedrockAnthropicGatewayPath --> <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-077: dispatches one initial provider-native Bedrock eventstream request) -->
3. A validated continuation for an eventstream profile retains Eventstream, with the complete authentic assistant array restored before provider I/O. A tool result alone must not force non-streaming Invoke. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::selectBedrockAnthropicTransport --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-073/077: continues an authentic %s High tool response through encrypted replay and Eventstream) -->
4. A failed provider-native request causes no fallback or paid retry. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-073/077: dispatches provider-native Bedrock Invoke with exact reasoning controls and hides signed replay state) -->

5. After authorization and replay validation, auto selects Eventstream through mapped High and Invoke for mapped XHigh/Max in discovery and runtime, including generated native profiles. Historical Sonnet upper levels remain mapped High aliases; Provider default sends no effort. Explicit transports never switch. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::selectBedrockAnthropicTransport --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-072/077/078: dispatches initial %s once with the evidenced mapped effort) --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-077/078: selects automatic transport from mapped %s without changing explicit transports) -->
6. Automatic eventstream turns require streaming requests and never fall back to Invoke. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-077: rejects nonstreaming automatic eventstream turns without an Invoke fallback) -->

7. Authorized streaming continuations emit public text before upstream EOF, without weakening replay confidentiality, stream validation, or terminal success gating. Missing/mismatched state fails before either operation. <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-077/080: delivers replay text while upstream EOF is withheld) --> <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-073/077: validates signed continuation before Eventstream and keeps state private) -->

**Constraints:**

- Each logical request selects one provider operation.
- `classifyBedrockToolTurn` remains authoritative for active replay validation inside request translation; neither active nor historical tool results alone force Invoke.
- Automatic routing never widens existing explicit-transport authority or changes the assigned profile.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-073](#req-enterprise-073-provider-native-bedrock-replay-integrity), [REQ-ENTERPRISE-074](#req-enterprise-074-provider-native-bedrock-target-identity)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-087: Native AI Gateway request timeout authority

**Intent:** Enterprise Native Bedrock requests receive a bounded first-byte allowance without overriding administrator-owned Dynamic Route timeout policy.

**Applies To:** Enterprise native Bedrock targets

**Acceptance Criteria:**

1. Authorized Native Bedrock dispatch sets the AI Gateway first-byte request timeout to 120 seconds. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-074: authorized synthetic future model normalizes %s through the shared native boundary) -->
2. Dynamic Route dispatch removes a container-supplied request-timeout override and retains its deployed AI Gateway graph as timeout authority. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (AC2: forwards the gateway id (from AIG_GATEWAY_URL) without overriding Dynamic Route timeout) -->

**Constraints:** The timeout header is Worker-owned and applies only after Native target authorization.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-077](#req-enterprise-077-provider-native-bedrock-transport-dispatch)

**Verification:** Automated interceptor tests.

**Status:** Implemented

---

<!-- Historical slug retained for link compatibility; it does not require a browser-derived authority lease. -->
<a id="req-enterprise-090-current-human-native-provider-authority"></a>
### REQ-ENTERPRISE-090: Native Pi forwarding under current Administration permission

**Intent:** Administration-permitted native Pi traffic forwards directly to personal providers within the existing parent-bound owner/session/generation and network boundaries, without browser-derived authority prerequisites.

**Applies To:** User

**Acceptance Criteria:**

1. Current Administration permission uses the bound session's trusted configured groups: the first matching configured group is authoritative, and only unmatched users may use enabled fallback, independently of sanctioned model eligibility. <!-- @impl: src/lib/access.ts::resolvePersonalPiPermission --> <!-- @test: src/__tests__/lib/personal-pi-policy.test.ts (REQ-ENTERPRISE-088 AC3: first policy wins independently of sanctioned model eligibility) --> <!-- @test: src/__tests__/personal-pi-interception.test.ts (REQ-ENTERPRISE-090 AC1: enabled fallback grants native transport without a browser lease or sanctioned routes) -->
2. Missing, invalid or inactive bound-session context and failed session/policy reads deny before provider I/O. <!-- @impl: src/container/container-interception.ts::getPersonalPiSession --> <!-- @impl: src/container/index.ts::getPersonalPiSession --> <!-- @impl: src/lib/personal-pi-forwarding.ts::forwardPersonalPi --> <!-- @test: src/__tests__/personal-pi-interception.test.ts (REQ-ENTERPRISE-088 AC5: real registry wiring binds human requests and denies unbound and Operator paths) -->
3. Native effects require current Administration permission and the pinned active owner/session/generation; missing, expired or unavailable browser authority neither denies an otherwise permitted request nor triggers Access identity I/O. <!-- @impl: src/container/container-interception.ts::wireContainerInterception --> <!-- @impl: src/lib/personal-pi-forwarding.ts::forwardPersonalPi --> <!-- @test: src/__tests__/personal-pi-interception.test.ts (REQ-ENTERPRISE-090 AC3: Administration-enabled native transport does not depend on browser authority: %s) --> <!-- @test: src/__tests__/personal-pi-interception.test.ts (REQ-ENTERPRISE-090 AC3: a stale parent-bound generation denies native effects: %s) --> <!-- @test: src/__tests__/personal-pi-interception.test.ts (REQ-ENTERPRISE-088 AC5: token-derived Copilot service hosts remain policy gated) --> <!-- @test: src/__tests__/personal-pi-interception.test.ts (REQ-ENTERPRISE-088 AC5: deployment-bound Copilot enterprise hosts use native credentials) -->
4. Reused WebSocket frames reauthorize current Administration permission and the bound owner/session/generation before provider effects; browser authority expiry alone does not revoke native forwarding. <!-- @impl: src/lib/personal-pi-forwarding.ts::forwardPersonalPi --> <!-- @test: src/__tests__/personal-pi-interception.test.ts (REQ-ENTERPRISE-090 AC4: a reused native WebSocket outlives browser expiry but not Administration revocation) --> <!-- @test: src/__tests__/personal-pi-interception.test.ts (REQ-ENTERPRISE-090 AC4: registered regional Vertex transport denies revoked traffic with strict mode off) -->
5. Native credentials and wire bodies remain owner-private and are forwarded unchanged. <!-- @impl: src/lib/personal-pi-forwarding.ts::forwardPersonalPi --> <!-- @test: src/__tests__/personal-pi-interception.test.ts (REQ-ENTERPRISE-088 AC5: bound native requests preserve wire auth and warm revocation prevents provider I/O) -->
6. Strict personal transport requires its binding and cannot use platform exemptions or stale direct hints. <!-- @impl: src/lib/personal-pi-forwarding.ts::forwardPersonalPi --> <!-- @test: src/__tests__/personal-pi-interception.test.ts (REQ-ENTERPRISE-088 AC6: strict personal transport requires its binding and does not use platform exemption) --> <!-- @test: src/__tests__/personal-pi-interception.test.ts (REQ-ENTERPRISE-088 AC6: warm strict activation cannot use a stale direct transport hint) --> <!-- @test: src/__tests__/personal-pi-interception.test.ts (REQ-ENTERPRISE-088 AC6: native OAuth traffic is bound and warm-strict gated: %s) -->
7. Credential-bearing provider redirects cannot cross origins automatically. <!-- @impl: src/lib/personal-pi-forwarding.ts::forwardPersonalPi --> <!-- @test: src/__tests__/personal-pi-interception.test.ts (REQ-ENTERPRISE-088 AC6: personal credentials cannot follow a cross-origin provider redirect) --> <!-- @test: preseed/agents/pi/test/enterprise-routing.test.mjs (REQ-ENTERPRISE-088 AC6: pinned native OAuth login and refresh destinations reach the policy boundary) -->

**Constraints:**

- Exited generations deny native effects despite failed Review cleanup. <!-- @impl: src/container/container-lifecycle.ts::confirmMonitoredExit --> <!-- @test: src/__tests__/routes/terminal-native-pi-authority.test.ts (REQ-ENTERPRISE-090: confirmed exit still denies provider access when %s cleanup rolls back) -->
- Replacement-native effects require matching process generations, regardless of Review renewal. <!-- @impl: src/container/container-lifecycle.ts::onStart --> <!-- @impl: src/container/review-session-human.ts::discardReviewSessionHuman --> <!-- @test: src/__tests__/routes/terminal-native-pi-authority.test.ts (REQ-TERM-002: monitored exit permits next-generation reconnect and native OAuth/device forwarding without manual authority discard) --> <!-- @test: src/__tests__/routes/terminal-native-pi-authority.test.ts (REQ-TERM-002: actual destroy and fresh Start on the surviving host permit same-owner native provider renewal) --> <!-- @test: src/__tests__/routes/terminal-native-pi-authority.test.ts (REQ-ENTERPRISE-090: monitored replacement renews authority while old cleanup waits after fence commit) -->
- Delayed cleanup preserves replacement-native context and separate Review authority. <!-- @impl: src/container/container-lifecycle.ts::confirmMonitoredExit --> <!-- @test: src/__tests__/routes/terminal-native-pi-authority.test.ts (REQ-SESSION-018: delayed old-exit cleanup preserves replacement-generation sealed authority and provider access) -->
- Start completion cannot lift a newer shutdown fence. <!-- @impl: src/container/container-lifecycle.ts::onStart --> <!-- @test: src/__tests__/routes/terminal-native-pi-authority.test.ts (REQ-SESSION-033: fresh-start completion preserves a newer shutdown when durable fencing fails) -->
- Credential-free parent context is rechecked after policy I/O; its checks are detailed in [Security](../../documentation/lanes/security.md#api-token-containment).
- Enterprise human Pi only.
- Review authority and immutable-principal checks remain separate.
- Dynamic/managed Native Routes retain Gateway routing.
- Stale handles cannot borrow personal permission.
- Fixed native destinations and cloud region/resource families retain network policy, without arbitrary origins.
- Native OpenAI JSON remains bounded at eight MiB.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-088](setup.md#req-enterprise-088-group-scoped-native-pi-providers), [REQ-ENTERPRISE-016](security.md#req-enterprise-016-strict-gateway-egress)

**Verification:** Anchored policy/interceptor/runtime tests describe the source repair; current-head acceptance/regression execution and exact-head CI remain pending. No deployment or live-fix verification is claimed.

**Status:** Implemented

---

### REQ-ENTERPRISE-091: Operator personal-provider isolation

**Intent:** Human personal-provider permission never supplies Operator authority or rescues a revoked sanctioned selector.

**Applies To:** System

**Acceptance Criteria:**

1. Operators receive neither personal permission nor human authentication or inline provider secrets. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @impl: entrypoint.sh::run_operator_startup --> <!-- @test: host/__tests__/entrypoint-operator-startup.test.js (REQ-ENTERPRISE-088 AC7: real Operator startup excludes human authentication and inline provider secrets) -->
2. Stale managed handles cannot fall back to personal inference. <!-- @impl: src/lib/personal-pi-forwarding.ts::forwardPersonalPi --> <!-- @test: src/__tests__/personal-pi-interception.test.ts (REQ-ENTERPRISE-088 AC7: Operator and stale managed handles never use personal transport) --> <!-- @test: src/__tests__/personal-pi-interception.test.ts (REQ-ENTERPRISE-091 AC2: enabling personal providers does not redirect Dynamic or Native Route selectors to personal transport) -->

**Constraints:** No production deployment, Operator activation, new origin or parallel OAuth service is implied.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-088](setup.md#req-enterprise-088-group-scoped-native-pi-providers), [REQ-ENTERPRISE-090](#req-enterprise-090-native-pi-forwarding-under-current-administration-permission)

**Verification:** Anchored real Operator startup and interceptor tests; current-head regression execution and CI remain pending.

**Status:** Implemented

---

## Discovery and verification

### REQ-ENTERPRISE-033: Enterprise Pi Discovery and Multi-Model Evidence

**Intent:** Administrators can collect bounded compatibility evidence for every reachable route leg without changing runtime routing.

**Applies To:** Admin

**Acceptance Criteria:**

1. Discovery bounds each single-target run by its probe, response-size, completion-token, and whole-attempt time limits. <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (REQ-ENTERPRISE-033: preserves the outbound canary ceiling against a profile $mutation on $transport) --> <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility --> <!-- @impl: src/lib/reasoning-discovery.ts::fetchWithTimeout --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (rejects excessive ceilings and reasoning-probe budgets before provider I/O) --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (REQ-ENTERPRISE-033: cancels a stalled $stage body at the attempt deadline without retrying) --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (REQ-ENTERPRISE-033: sanitizes an oversized REST 404 instead of attempting compat fallback) -->
2. Tool verification requires a streamed Pi-compatible function call, synthetic result replay, and final assistant completion. <!-- @impl: src/lib/reasoning-discovery.ts::executeToolLifecycle --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (counts one reasoning probe and one complete tool lifecycle per distinct semantic mapping) --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (REQ-ENTERPRISE-033: refuses verification for a $label replay) --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (REQ-ENTERPRISE-033: repairs missing replay terminators only with a final assistant answer) -->
3. Within 256 nodes, 512 edges, and 1,024 output paths, inventory returns every reachable model path and accepts documented terminal sentinels; malformed or over-budget graphs are rejected. <!-- @impl: src/lib/dynamic-route-inventory.ts::inventoryDynamicRoute --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (finds every conditional and fallback model while accepting mixed end/END sentinels) --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (retains every path when branches converge before a downstream model) --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (rejects graphs exceeding the %s budget with a sanitized code) -->
4. Custom-provider backend identity remains administrator-owned provenance and is never inferred. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/admin-reasoning.test.ts (returns exact active-version leg/path summaries and only administrator-owned custom-provider identity) -->
5. Common mappings contain only levels with current tool/replay evidence and byte-identical mutations across every reachable leg. <!-- @impl: src/lib/dynamic-route-inventory.ts::deriveCommonMapping --> <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (derives only byte-identical levels with current compatible tool/replay evidence) --> <!-- @test: src/__tests__/routes/admin-reasoning.test.ts (derives and returns common levels from current byte-identical per-leg evidence) -->
6. Discovery returns sanitized evidence without generated content, credentials, complete response IDs, or arbitrary error bodies. <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (returns sanitized non-activating evidence with no credentials, generated text, response IDs, or error bodies) -->
7. Route catalog, inventory, compatibility revalidation, and custom-profile discovery reuse the saved encrypted AI Gateway connection without exposing credentials to the browser. <!-- @impl: src/lib/aig-config.ts::getAigConfig --> <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/admin-reasoning.test.ts (reuses the saved gateway credential and accepts the compatible result.routes envelope) -->

**Constraints:**

- The canary retains its validated Pi 0.84.4 streaming-envelope baseline, distinct from the installed runtime pinned in [Pi dependencies](../../preseed/agents/pi/package.json).
- Its system instruction is an ordinary task instruction, with unchanged function schema and replay requirements. <!-- @impl: src/lib/reasoning-discovery.ts::basePiMessages --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (preserves the validated Pi 0.84.4 canary request and replay fixtures) -->
- Logical probes are counted separately from HTTP attempts.
- Each attempt deadline includes response-body consumption and cancels stalled reads before any fallback or further probe.
- Missing replay terminators may be repaired, but an empty, non-SSE, or error-only response cannot prove final assistant completion.
- Discovery exposes only the approved authenticated endpoints. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/admin-reasoning.test.ts (exposes exactly catalog, route inventory, and one-target discovery) -->
- Discovery neither activates its result nor adds branch forcing or runtime profile switching. <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (returns sanitized non-activating evidence with no credentials, generated text, response IDs, or error bodies) -->
- Fallback evidence comes from separately addressable single-leg routes; discovery never intentionally fails a production primary.
- Generated content, credentials, complete provider response IDs, and arbitrary provider error bodies are not retained.
- Route versions are checked during inventory, Revalidate, preview, and Apply, never by per-request management polling.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-031](#req-enterprise-031-enterprise-pi-capability-profile-administration)

**Verification:** Automated tests in the anchored discovery and Administration API suites above.

**Status:** Implemented

---

### REQ-ENTERPRISE-035: Enterprise Pi Protocol Match Selection

**Intent:** Normal target discovery automatically selects and verifies reusable protocol handling without per-model profile authoring or backend-family claims. The old profile-matching workflow remains available under Advanced.

**Applies To:** Admin

**Acceptance Criteria:**

1. The retained Advanced matcher offers every compatible enabled catalog revision by exact reference, including matches completed before a later HTTP 429. <!-- @test: src/__tests__/routes/admin-reasoning-discovery.test.ts (retains complete Gemma and GLM matches when a later candidate is rate limited) --> <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @impl: web-ui/src/components/admin/ReasoningProfileEditor.tsx::ReasoningProfileEditor --> <!-- @test: src/__tests__/routes/admin-reasoning-discovery.test.ts (recommends the exact existing Kimi revision when non-off tools and replay pass but off still reasons) --> <!-- @test: src/__tests__/routes/admin-reasoning-discovery.test.ts (retains equivalent Gemma and GLM choices instead of mistaking deduplication order for identity) --> <!-- @test: src/__tests__/routes/admin-reasoning-discovery.test.ts (recommends a saved custom revision from matching bounded evidence without additional custom probes) --> <!-- @test: src/__tests__/routes/admin-reasoning-discovery.test.ts (retains equivalent Kimi and saved custom choices when alias representations differ) --> <!-- @test: web-ui/src/__tests__/components/ReasoningProfileEditor.test.tsx (names each match row and describes identically named Assign profile buttons without changing immutable refs) -->
2. For custom-draft construction, a maximal compatible mapping subsumes matching subsets only when their shared mutations match. <!-- @impl: src/routes/admin/reasoning.ts::selectUnambiguousCandidateMatch --> <!-- @test: src/__tests__/routes/admin-reasoning.test.ts (prefers one compatible superset protocol over its matching off-only subset) -->
3. In the Advanced matcher, divergent passing existing profiles remain selectable without automatic assignment. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/admin-reasoning.test.ts (REQ-ENTERPRISE-035 AC3: offers existing revisions without activation when compatible mappings diverge) --> <!-- @test: src/__tests__/routes/admin-reasoning-discovery.test.ts (offers every compatible Dynamic Route profile and enabled custom revision without choosing a runtime mapping) --> <!-- @test: src/__tests__/routes/admin-reasoning-discovery.test.ts (offers GPT full and off plus Kimi when worker and Mesh off modes still reason) -->
4. Authentication, quota, server, transport, malformed-stream or unexpected buffered-envelope failures terminate further scan requests. <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility --> <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/admin-reasoning-discovery.test.ts (stops the whole candidate scan after HTTP %s) --> <!-- @test: src/__tests__/routes/admin-reasoning-discovery.test.ts (suppresses earlier matches when a later candidate encounters a fatal failure) --> <!-- @test: src/__tests__/routes/admin-reasoning-discovery.test.ts (stops all candidates after malformed SSE without retaining the malformed content) -->
5. Token-exhausted tool calls or replays remain inconclusive rather than proving incompatibility. <!-- @impl: src/lib/reasoning-discovery.ts::mappingDiagnostics --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (REQ-ENTERPRISE-035: reports completion limits at %s without retrying or claiming incompatibility) --> <!-- @test: src/__tests__/routes/admin-reasoning-discovery.test.ts (reports incomplete tool generation at the selected ceiling rather than unsupported reasoning) -->
6. The Advanced matcher prioritizes assignable matches and actionable incomplete-check notices without candidate diagnostic panels. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @impl: web-ui/src/components/admin/ReasoningProfileEditor.tsx::ReasoningProfileEditor --> <!-- @test: web-ui/src/__tests__/components/ReasoningProfileEditor.test.tsx (shows an actionable incomplete result without candidate diagnostics or counters) --> <!-- @test: web-ui/src/__tests__/components/ReasoningProfileEditor.test.tsx (keeps Gemma Off failures scoped to Gemma instead of coloring the matched GPT profile) -->
7. Failed checks distinguish provider refusal, unobserved cache reuse and an unexpected buffered response envelope from connection failure, without exposing provider content. <!-- @test: web-ui/src/__tests__/components/ReasoningProfileEditor.test.tsx (REQ-ENTERPRISE-035: Advanced discovery explains $code and leaves the route unassignable) --> <!-- @test: src/__tests__/lib/target-capability-discovery.test.ts (REQ-ENTERPRISE-035: classifies a buffered Dynamic native envelope as unexpected response format without replay or qualification) --> <!-- @impl: web-ui/src/components/admin/ReasoningProfileEditor.tsx::reasoningCheckSummary --> <!-- @test: web-ui/src/__tests__/components/ReasoningProfileEditor.test.tsx (reports concrete %s failure without exposing raw data) --> <!-- @test: src/__tests__/routes/admin-reasoning-discovery.test.ts (reports incompatible %s with a clear diagnostic and no invented draft) -->
8. Normal Discover returns one automatically constructed/reused shared contract plus target-bound verification, not a matching-profile shopping list. Unlisted synthetic identifiers require no per-model definition. <!-- @impl: src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities --> <!-- @impl: src/routes/admin/ai-capability-discovery.ts::routes --> <!-- @test: src/__tests__/routes/target-capability-discovery.test.ts --> <!-- @test: web-ui/src/__tests__/components/TargetCapabilityDiscovery.test.tsx -->
9. Discovery reports tools/replay, reasoning, streaming and input caching independently for each tested semantic mapping, without cumulative grades. <!-- @impl: src/lib/ai-capability-discovery/contract.ts::parseCapabilitySummary --> <!-- @test: src/__tests__/lib/target-capability-discovery.test.ts (REQ-ENTERPRISE-075: returns independent $reasoning capability rows without input caching while retaining seven Dynamic preferences) --> <!-- @test: src/__tests__/lib/bedrock-capability-discovery.test.ts (REQ-ENTERPRISE-072/078: preserves High incremental delivery beside XHigh and Max Invoke evidence in one native result) -->
10. The finite request-form campaign stays within 40 submissions/2,048 output tokens/90 seconds each/10 minutes overall, independently of model/catalog additions. Dynamic stops at its first complete tools/replay contract; Native assembles successful audited forms before returning. Hash-bound wire choices match runtime. <!-- @impl: src/lib/ai-capability-discovery/index.ts::capabilityCandidates --> <!-- @impl: src/lib/ai-capability-discovery/compatibility-wire.ts::compatibilityResponse --> <!-- @test: src/__tests__/lib/target-capability-discovery.test.ts --> <!-- @test: src/__tests__/lib/target-capability-runtime.test.ts -->
11. Evidence covers one correlated exercised Dynamic backend across retained mappings, never a union of conflicting known backends. Multi-distinct-backend routes with unidentified selection remain inconclusive even without cache evidence. <!-- @impl: src/lib/reasoning-discovery.ts::probeDiagnostic --> <!-- @impl: src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities --> <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: src/__tests__/lib/target-capability-discovery.test.ts --> <!-- @test: web-ui/src/__tests__/components/TargetCapabilityDiscovery.test.tsx -->

**Constraints:**

- Cache-fill refusal diagnostics retain measured write/read counters and the unattempted-read flag without granting cache permission or erasing completed tools/replay. <!-- @impl: src/lib/reasoning-discovery.ts::probeDiagnostic --> <!-- @test: src/__tests__/lib/bedrock-capability-discovery.test.ts (REQ-ENTERPRISE-035: surfaces a sanitized cache-fill refusal after a positive write without submitting a read (%s)) -->

- Buffered-envelope rejection retains HTTP status and transport rather than claiming a connection error. <!-- @impl: src/lib/reasoning-discovery.ts::probeDiagnostic --> <!-- @test: src/__tests__/lib/target-capability-discovery.test.ts (REQ-ENTERPRISE-035: classifies a buffered Dynamic native envelope as unexpected response format without replay or qualification) -->

- V2 capability summaries contain only `schemaVersion: 2` and `mappings`; rows contain exact `levels`, exercised `transport`, `tools`, `replay`, `reasoning`, `streaming` and `cache`. <!-- @impl: src/lib/ai-capability-discovery/contract.ts::parseCapabilitySummary -->
- Worker/browser share strict parsing; outer document schemas remain v1. <!-- @impl: src/lib/ai-capability-discovery/contract.ts::parseCapabilitySummary --> <!-- @test: src/__tests__/lib/independent-capability-authority.test.ts (round-trips per-mapping evidence and authorizes verified tools without input cache evidence) --> <!-- @test: src/__tests__/lib/independent-capability-authority.test.ts (rejects malformed or extra evidence without restoring a grade (%j)) -->
- V2 authority requires complete tools/replay and exact profile semantic-group/alias coverage with the correct mapped operation; duplicate, missing or extra rows/levels fail closed. <!-- @impl: src/lib/ai-capability-discovery/contract.ts::capabilityEvidenceMatches --> <!-- @test: src/__tests__/lib/independent-capability-authority.test.ts (binds evidence levels and transport to the actual immutable profile rather than trusting capability booleans) -->
- Cache is optional. <!-- @impl: src/lib/ai-capability-discovery/contract.ts::capabilityEvidenceMatches --> <!-- @test: src/__tests__/routes/target-capability-discovery.test.ts (REQ-ENTERPRISE-035/043: lets an administrator activate verified tools without cache reuse and save an Off preference through real receipt authority) -->
- Strict legacy v1 decoding preserves original qualification and current adapter/canary rules; formerly ineligible evidence cannot gain authority from v2 policy or load/rebind. <!-- @impl: src/lib/ai-capability-discovery/contract.ts::legacyCapabilityQualifies --> <!-- @test: src/__tests__/lib/independent-capability-authority.test.ts (retains legacy failed evidence for reading without upgrading it to current usable authority) -->
- Optional cache misses/refusals do not erase valid tool/replay evidence or trigger buffered cache chasing. <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility -->
- Invalid fills never launch a paired read; fatal authentication, quota, server, framing, transport and timeout boundaries still withhold a fresh receipt. <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility --> <!-- @test: src/__tests__/lib/target-capability-discovery.test.ts (REQ-ENTERPRISE-035: keeps a working streaming Dynamic path assignable without cache reuse or buffered cache chasing) -->
- Streaming requires cold public deltas over time before EOF for that mapping/operation; Invoke or synthesized buffered SSE and Gateway HIT cannot establish it.
- Buffered routes remain usable without an incremental claim.
- No arbitrary native protocol, URL, header, model substitution or transport cross-product is introduced.
- Failed stages retain sanitized diagnostics; stale draft/inventory evidence cannot authorize Save.
- The following matching/selection constraints apply to the retained Advanced workflow. It remains deterministic, sanitized, non-assigning and non-activating under REQ-ENTERPRISE-033; normal Discover instead adopts a qualified draft automatically and still requires reviewed Save.
- Results do not identify the backend model family or prove increasing reasoning effort; compatibility and Pi tool/replay observations are not reasoning-strength measurements.
- The finite built-in protocol bank bounds route-only probes.
- Saved custom revisions reuse those observations without additional paid probes.
- Unknown request properties are not inferred.
- Selected-profile verification remains a separate explicit check.
- Candidate-specific request rejection stops that candidate without retry.
- Complete existing-profile matches precede partial candidate drafts.
- Rate limiting never triggers automatic retries or custom-draft creation.
- Completed matches require explicit selection followed by live verification or administrator confirmation before activation.
- Other fatal failures suppress recommendations and drafts.
- Retained matches show a notice that remaining checks stopped on rate limiting. <!-- @test: web-ui/src/__tests__/components/ReasoningProfileEditor.test.tsx (REQ-ENTERPRISE-035: offers completed matches with a rate-limit notice without retrying) -->
- Partial drafts require one unambiguous maximal mapping, never a union of contradictory protocols.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-031](#req-enterprise-031-enterprise-pi-capability-profile-administration), [REQ-ENTERPRISE-033](#req-enterprise-033-enterprise-pi-discovery-and-multi-model-evidence), [REQ-ENTERPRISE-034](setup.md#req-enterprise-034-enterprise-pi-route-administration)

**Verification:** Automated tests in the anchored discovery and Administration API suites above.

**Status:** Implemented

---

<a id="req-enterprise-037-enterprise-pi-custom-profile-generation"></a>
### REQ-ENTERPRISE-037: Enterprise Pi Custom Profile Generation

**Intent:** Discovery produces safe custom drafts when existing catalog revisions do not fit.

**Applies To:** Admin

**Acceptance Criteria:**

1. Discovery generates a custom draft only when no existing revision fits an unambiguous set of passed modes. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/admin-reasoning.test.ts (recommends existing catalog revisions without creating a duplicate profile draft) --> <!-- @test: src/__tests__/routes/admin-reasoning-discovery.test.ts (creates a normalized custom draft from passed modes when no complete existing profile fits) --> <!-- @test: src/__tests__/routes/admin-reasoning-discovery.test.ts (does not recommend disabled custom revisions) -->
2. Generated drafts exclude failed, incomplete, and unproven off modes together with dangling aliases. <!-- @impl: src/routes/admin/reasoning.ts::observedCandidate --> <!-- @impl: src/routes/admin/reasoning.ts::generatedProfileDraft --> <!-- @test: src/__tests__/routes/admin-reasoning-discovery.test.ts (creates a normalized custom draft from passed modes when no complete existing profile fits) --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (REQ-ENTERPRISE-035: excludes off from compatible modes when hidden reasoning tokens are reported) -->
3. Each retained mode preserves the observed removals and literal writes. <!-- @impl: src/routes/admin/reasoning.ts::generatedProfileDraft --> <!-- @test: src/__tests__/routes/admin-reasoning-discovery.test.ts (creates a normalized custom draft from passed modes when no complete existing profile fits) -->

4. Provider-default discovery drafts normalize and round-trip as custom revisions with empty reasoning levels, mappings, and aliases. <!-- @impl: src/lib/reasoning-profiles.ts::normalizeCustomProfile --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-037: round-trips a generic provider-default discovery draft as its own custom revision) -->

**Constraints:**

- Generation does not persist, assign, or activate the draft.
- Provider-default mode does not relax configurable-level validation or permit hidden mappings and aliases. <!-- @impl: src/lib/reasoning-profiles.ts::normalizeCustomProfile --> <!-- @test: src/__tests__/lib/reasoning-profiles.test.ts (REQ-ENTERPRISE-031: rejects a custom draft with %s) -->

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-031](#req-enterprise-031-enterprise-pi-capability-profile-administration), [REQ-ENTERPRISE-035](#req-enterprise-035-enterprise-pi-protocol-match-selection)

**Verification:** Automated tests in the anchored Administration API and discovery suites above.

**Status:** Implemented

---

### REQ-ENTERPRISE-038: Enterprise Pi Selected-Profile Verification

**Intent:** Administrators can inspect selected-profile checks and save correctly scoped route evidence without confusing compatibility with reasoning strength.

**Applies To:** Admin

**Acceptance Criteria:**

1. Verify accepts an exact selected saved or canonical draft revision without requiring Save first. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (verifies an unsaved canonical custom profile and draft gateway without activation) --> <!-- @test: web-ui/src/__tests__/components/AiRoutingWorkspace.test.tsx (REQ-ENTERPRISE-042: verifies a three-model route without requiring a custom backend description) -->
2. Expandable Technical check details show one row per supported level with Compatibility, Tool call, and Tool replay columns, using labeled green Passed, red Failed, and orange Unclear states derived from level/stage evidence rather than classification alone. <!-- @impl: web-ui/src/components/admin/ReasoningProfileEditor.tsx::ReasoningCheckOverview --> <!-- @test: web-ui/src/__tests__/components/ReasoningProfileEditor.test.tsx (uses one row per level with associated headers and never passes classification alone) --> <!-- @test: web-ui/src/__tests__/components/ReasoningProfileEditor.test.tsx (associates passed, failed, and incomplete checks with their exact level and stage) --> <!-- @test: web-ui/src/__tests__/components/ReasoningProfileEditor.test.tsx (gives diagnostics priority and leaves unattempted replay unclear without an irrelevant Off control) --> <!-- @test: web-ui/src/__tests__/components/ReasoningProfileEditor.test.tsx (retains successful tool-call evidence when %s does not complete) -->
3. A successful selected check attaches server-issued verification to the exact route draft only when its before/after inventory is unchanged. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (issues no receipt when inventory drifts during an otherwise complete canary) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (persists reconciled backend identities after successful re-verification of a changed model) --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-038: Verify Profile uses fixed 4096 and attaches the server receipt only to the exact route draft) -->
4. Multi-model success is eligible as an observed path with an untested-backend warning, without inventing per-leg or whole-route evidence. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingWorkspace.test.tsx (REQ-ENTERPRISE-043: a successful observed-path check enables assignment with an untested-backup warning) -->
5. Explicit confirmed Save persists attached evidence through configuration GET. <!-- @impl: web-ui/src/components/admin/EnvironmentIndex.tsx::EnvironmentAreaDetail --> <!-- @impl: src/lib/admin-configuration.ts::executeConfigurationTask --> <!-- @test: web-ui/src/__tests__/components/EnvironmentIndex.test.tsx (REQ-ENTERPRISE-038: saves %s verification through Review, Back, confirmation and reload) --> <!-- @test: src/__tests__/routes/admin-configuration-runs.test.ts (REQ-ENTERPRISE-038: retains exact %s verification through confirmed Save and configuration GET) -->
6. Reloaded verification status requires matching fresh inventory and current server-owned verification. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (copies inventory verification only while current connection and topology still match) --> <!-- @test: web-ui/src/__tests__/components/EnvironmentIndex.test.tsx (REQ-ENTERPRISE-038: saves %s verification through Review, Back, confirmation and reload) -->

**Constraints:**

- Selected-profile verdicts stay visible outside Technical check details. <!-- @impl: web-ui/src/components/admin/TargetCapabilityDiscovery.tsx::TargetCheckResult --> <!-- @test: web-ui/src/__tests__/components/TargetCapabilityDiscovery.test.tsx (REQ-ENTERPRISE-038: Advanced verification updates the same visible result without requiring the disclosure to stay open) -->

- Inventory reads never mutate assignments or start paid checks.
- Verification changes only the draft until Save confirmation.
- Save requires server-recomputed warning confirmation at the same `baseRevision`.
- Compatibility does not prove increasing reasoning effort.
- Off-disabled evidence remains separate from tool success. <!-- @impl: web-ui/src/components/admin/ReasoningProfileEditor.tsx::ReasoningCheckOverview --> <!-- @test: web-ui/src/__tests__/components/ReasoningProfileEditor.test.tsx (does not equate a Pi tool pass with verified Off or reasoning configuration) -->
- Candidate diagnostics remain scoped to their candidate, never another matched profile. <!-- @impl: web-ui/src/components/admin/ReasoningProfileEditor.tsx::ReasoningCheckDetails --> <!-- @test: web-ui/src/__tests__/components/ReasoningProfileEditor.test.tsx (keeps Gemma Off failures scoped to Gemma instead of coloring the matched GPT profile) -->
- This retained selected-profile check introduces no runtime/Gateway/credential change. New compatibility-wire behavior and its separate budget belong to the dedicated component in REQ-ENTERPRISE-035.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-031](#req-enterprise-031-enterprise-pi-capability-profile-administration), [REQ-ENTERPRISE-033](#req-enterprise-033-enterprise-pi-discovery-and-multi-model-evidence), [REQ-ENTERPRISE-034](setup.md#req-enterprise-034-enterprise-pi-route-administration), [REQ-ENTERPRISE-035](#req-enterprise-035-enterprise-pi-protocol-match-selection)

**Verification:** Behavioral tests are anchored above; CI is pending. Browser and visual acceptance are not claimed.

**Status:** Implemented

---

### REQ-ENTERPRISE-040: Enterprise Pi Check Lifecycle

**Intent:** Mapping and verification have explicit start and evidence-invalidation boundaries.

**Applies To:** Admin

**Acceptance Criteria:**

1. Advanced Discover Profile starts exactly once when its editor mounts; normal Discover starts only on its explicit target action. <!-- @impl: web-ui/src/components/admin/ReasoningProfileEditor.tsx::ReasoningProfileEditor --> <!-- @test: web-ui/src/__tests__/components/ReasoningProfileEditor.test.tsx (starts on mount with fixed 4096 and offers no second start or token input, including after incomplete results) -->
2. Verify Profile starts once per explicit activation for the exact selected revision. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-038: Verify Profile uses fixed 4096 and attaches the server receipt only to the exact route draft) -->
3. Changing the selected profile invalidates earlier draft evidence, including when switching back. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-040: profile changes clear the result and invalidate receipts even when switching back) -->
4. Starting a Dynamic or Native recheck immediately clears earlier results, draft receipts and current verification while pending, so failure cannot retain green verification. <!-- @test: web-ui/src/__tests__/components/TargetCapabilityDiscovery.test.tsx (REQ-ENTERPRISE-040: Native Advanced recheck clears prior discovery success and receipt while pending and after failure) --> <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-040: a failed recheck invalidates the draft receipt and leaves loaded snapshot evidence detached) -->

**Constraints:**

- Draft evidence changes must not mutate the loaded configuration snapshot.
- Existing backend descriptions remain preserved without exposing a metadata editor. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-038: retains %s saved custom backend descriptions without a metadata editor) -->

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-034](setup.md#req-enterprise-034-enterprise-pi-route-administration), [REQ-ENTERPRISE-038](#req-enterprise-038-enterprise-pi-selected-profile-verification)

**Verification:** Anchored behavioral tests run in CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-043: Enterprise Pi Verified Route Activation

**Intent:** Allow policy and Pi use for an exact route translation after either live verification or explicit administrator confirmation.

**Applies To:** Admin

**Acceptance Criteria:**

1. A selected live check issues authority only after complete Pi tools/replay on every included executable semantic mapping against stable inventory; optional cache evidence is not an activation gate. <!-- @impl: src/lib/reasoning-verification.ts::completedProfileCheck --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (issues no receipt for %s checks) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (issues no receipt when inventory drifts during an otherwise complete canary) -->
2. Route-only mapping never issues activation authority. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (route-only Map never creates an eligibility receipt) -->
3. Save validates unchanged current saved authority first, adopts fresh valid receipts, and falls back to saved authority only for unavailable or expired receipts. Explicit null invalidates saved proof; present mismatched receipts and fabricated browser authority remain rejected. <!-- @impl: src/lib/admin-configuration.ts::normalizeAiReasoningConfiguration --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (never trusts forged verification or legacy evidence flags in Save) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (rejects a receipt after $identity identity changes (administrator: $administratorConfirmed)) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (does not accept browser-fabricated administrator confirmation as saved authority) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-043: an unavailable old receipt cannot block unchanged current server-owned route authority) -->
4. A successful observed path remains green Compatible with an untested-backup warning; assigning it never certifies the other backends. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingWorkspace.test.tsx (REQ-ENTERPRISE-043: a successful observed-path check enables assignment with an untested-backup warning) --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-038: observed-path receipts enable access with a backup warning without fabricating per-leg evidence) -->
5. Missing unsaved proof fails closed with field errors and preserves the draft. Recovery uses existing Advanced Verify or explicit Mark as verified, followed by Review and Confirm Save; no wizard or automatic paid recheck is introduced. <!-- @impl: src/lib/reasoning-verification.ts::readRouteCheck --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (fails closed on delayed receipt visibility with retry advice and no automatic paid checks) --> <!-- @impl: web-ui/src/components/admin/EnvironmentIndex.tsx::EnvironmentAreaDetail -->
6. Save preserves new verification or administrator confirmation on inactive drafts without granting policy access. <!-- @impl: src/lib/admin-configuration.ts::normalizeAiReasoningConfiguration --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (persists a newly checked inactive draft without granting policy access or repeating paid checks) -->

7. Mark as verified explicitly confirms an eligible exact canonical selected profile, including generated discovery profiles, without model probes. The server issues target/profile/connection/inventory-bound administrator authority, distinct from automated observations. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (confirms an administrator-selected profile without paid probes and preserves authority through Save and runtime loading) --> <!-- @test: src/__tests__/routes/target-capability-discovery.test.ts (REQ-ENTERPRISE-043: confirms selected Dynamic $id through endpoint, Save and runtime without inventing observations) -->

**Constraints:**

- Receipt recovery never retries automatically, clears unrelated draft edits or bypasses current identity, warning acknowledgement or baseRevision checks. <!-- @impl: web-ui/src/components/admin/EnvironmentIndex.tsx::EnvironmentAreaDetail -->

- Administrator confirmation invents no tools, reasoning, streaming or cache observations and grants no inferred cache permission to generated profiles. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/lib/independent-capability-authority.test.ts (REQ-ENTERPRISE-043: Save rejects $label without an issued receipt) --> <!-- @test: src/__tests__/routes/target-capability-discovery.test.ts (REQ-ENTERPRISE-075: confirms selected Native $profile.id through endpoint, Save and runtime without borrowing tools or cache evidence) -->

- Both live and administrator-confirmed receipts bind the exact profile revision, gateway credential context, inventory, any supplied provenance, and compatibility contract version.
- Administrator confirmation retains its distinct method through browser response validation and persistence, never becoming live-check evidence. <!-- @impl: web-ui/src/lib/schemas.ts::ReasoningRouteVerificationSchema --> <!-- @test: web-ui/src/__tests__/api/reasoning-client.test.ts (REQ-ENTERPRISE-043: retains %s authority through real discovery and inventory response parsing) -->
- Dynamic and Native temporary Save receipts must remain valid for at least one hour; bounded retention is 30 days on immutable unique KV keys. Future-dated/expired receipts fail closed. Saved authority does not expire with receipts; private replay retention is independent. <!-- @impl: src/lib/reasoning-verification.ts::issueRouteCheck --> <!-- @impl: src/lib/reasoning-verification.ts::readRouteCheck --> <!-- @impl: src/lib/native-ai-targets.ts::issueNativeTargetCheck --> <!-- @impl: src/lib/native-ai-targets.ts::readNativeTargetCheck --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (uses unique immutable receipt keys with a bounded TTL and never rewrites an earlier check) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-043: Confirm Save retains exact Dynamic and Native authority after %i milliseconds of configuration) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-043: receipt readers still reject outside the bounded lifetime (%i milliseconds)) -->
- Generated namespaces, missing evidence and browser-supplied administrator methods grant no authority. Incomplete automated replay remains insufficient; only explicit server-issued administrator confirmation establishes the separate assessment basis. <!-- @impl: src/lib/reasoning-verification.ts::verificationMatches --> <!-- @test: src/__tests__/lib/independent-capability-authority.test.ts (REQ-ENTERPRISE-043: incomplete automated replay cannot replace executable evidence) -->
- Runtime performs no management polling or branch forcing.
- Observed-path authority is not per-leg or whole-route certification.
- Legacy Setup cannot inject verification authority.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-031](#req-enterprise-031-enterprise-pi-capability-profile-administration), [REQ-ENTERPRISE-042](setup.md#req-enterprise-042-enterprise-pi-draft-connection-and-verification)

**Verification:** Regression checkpoint `bef54164` failed in CI `34770156766`. Updated implementation and behavioral fixtures await exact-head CI; no deployed acceptance is claimed.

**Status:** Planned

---

<a id="req-enterprise-047-native-ai-gateway-target-administration"></a>
### REQ-ENTERPRISE-047: Native AI Gateway Provider Discovery and Selection

**Intent:** The Worker discovers and selects configured native and custom AI Gateway providers without changing existing Dynamic Route behavior.

**Applies To:** Worker

**Acceptance Criteria:**

1. The authenticated reasoning catalog discovers all gateway-scoped provider configurations through bounded pagination. <!-- @impl: src/lib/ai-gateway-management.ts::listNativeProviderConfigs --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-047: discovers all sanitized provider bindings through bounded gateway-scoped pages) -->
2. The catalog discovers sanitized account custom-provider slugs independently of provider configurations. <!-- @impl: src/lib/ai-gateway-management.ts::listCustomProviderSlugs --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-047: discovers sanitized custom-provider slugs independently) -->
3. Provider discovery rejects malformed, over-budget, cross-gateway, or ambiguous data. <!-- @impl: src/lib/ai-gateway-management.ts::listNativeProviderConfigs --> <!-- @impl: src/lib/ai-gateway-management.ts::selectNativeProviderConfig --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-047: rejects malformed, over-budget, cross-gateway and ambiguous provider discovery) -->
4. Dynamic and Native inventory domains fail independently. Only a complete authoritative domain permits absence-based cleanup; failed, malformed, incomplete or incoherent pagination never proves absence. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/admin-reasoning.test.ts (REQ-ENTERPRISE-047: provider discovery failure leaves Dynamic Routes usable) --> <!-- @test: src/__tests__/routes/live-routing-reconciliation.test.ts (REQ-ENTERPRISE-047: only a complete domain authorizes deletion when the other inventory is unavailable) --> <!-- @test: src/__tests__/routes/live-routing-reconciliation.test.ts (REQ-ENTERPRISE-047: errors and incomplete or incoherent pages never prove absence) -->
5. Custom-provider discovery failure leaves built-in provider discovery, validation, and reauthorization usable. <!-- @impl: src/lib/ai-gateway-management.ts::listCustomProviderSlugsForProviders --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (uses failed custom-provider lookup only as a built-in classification fallback) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (keeps built-in discovery, validation, and reauthorization available when custom-provider lookup fails) -->
6. A sole provider binding is selectable; multiple bindings require exactly one default. <!-- @impl: src/lib/ai-gateway-management.ts::selectNativeProviderConfig --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-047: discovers all sanitized provider bindings through bounded gateway-scoped pages) --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-047: rejects malformed, over-budget, cross-gateway and ambiguous provider discovery) -->

**Constraints:** Dynamic Routes remain backward compatible; detection proves presence only; custom-provider detection changes only the Worker selector prefix.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-042](setup.md#req-enterprise-042-enterprise-pi-draft-connection-and-verification)

**Verification:** Regression checkpoint `bef54164` failed in CI `34770156766`. Updated implementation and behavioral fixtures await exact-head CI; no deployed acceptance is claimed.

**Status:** Planned

---

### REQ-ENTERPRISE-052: Native Provider Verification and Runtime Enforcement

**Intent:** Native targets use exact verification authority and fail-closed reasoning enforcement.

**Applies To:** Worker

**Acceptance Criteria:**

1. Automated native verification performs a streamed tool-call and exact replay canary against the exact provider/model selector; an empty reasoning-level list alone never passes. <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (REQ-ENTERPRISE-048: provider-default verification requires a complete tool lifecycle) --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (REQ-ENTERPRISE-052: verifies a generalized native provider selector directly through compat) --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (REQ-ENTERPRISE-052: preserves the bounded native selector %s through compat) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-052: discovers and verifies an OpenAI native selector through the real compat helper) -->
2. Receipts bind target kind, ID, provider kind, model, provider configuration, alias, connection, profile, transport, and adapter; changed identity fails closed. <!-- @impl: src/lib/native-ai-targets.ts::nativeVerificationMatches --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-055: changed target or connection authority fails verification matching) -->
3. Provider-default targets discard client reasoning overrides while preserving unrelated request fields and tool replay. <!-- @impl: src/lib/reasoning-profiles.ts::translateRuntimeReasoningRequest --> <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-048: ignores %s and removes only reasoning controls while preserving tools and replay) --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-059: normalizes Gemini provider-default %s while round-tripping thought signatures through Pi replay metadata) -->

**Constraints:** Evidence applies only to exact tested mappings and does not change unrelated canary revisions.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-043](#req-enterprise-043-enterprise-pi-verified-route-activation), [REQ-ENTERPRISE-047](#req-enterprise-047-native-ai-gateway-provider-discovery-and-selection), [REQ-ENTERPRISE-048](#req-enterprise-048-native-provider-capability-catalog)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-075: Provider-native Bedrock Administration Authority

**Intent:** Administrators reuse a native protocol contract and explicitly establish target-bound capabilities through the existing verification workflow, while retaining distinct explicit administrator confirmation authority.

**Applies To:** Admin

**Acceptance Criteria:**

1. Normal Bedrock Discover adopts a verified shared contract and target-bound receipt for any compatible model without changing saved transport. <!-- @impl: src/routes/admin/ai-capability-discovery.ts::routes --> <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: src/__tests__/routes/target-capability-discovery.test.ts (certifies a synthetic future native model through the saved Invoke transport and authentic replay) --> <!-- @test: src/__tests__/routes/target-capability-discovery.test.ts (does not infer Azure support or accept a browser endpoint/credential override) --> <!-- @test: web-ui/src/__tests__/components/TargetCapabilityDiscovery.test.tsx (selects a future Bedrock model and adopts its reusable native contract in one Discover action) --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-075: selects older/current/synthetic future models with one reusable native profile and explicit verification) -->
2. Native capability probes require an explicit administrator check, never template listing, target selection, or session startup. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-075: offers the reusable native contract without a paid probe and preserves historical explicit confirmation) --> <!-- @test: src/__tests__/routes/bedrock-generic-upgrade.test.ts (certifies, saves and authorizes a synthetic future model through the existing workflow without authoring a profile) -->
3. Automated Native v2 receipts bind the returned canonical profile and complete tools/replay for every executable mapping with exact transport coverage. Explicit server-issued administrator confirmation remains a separate authority basis for eligible generated or historical profiles. <!-- @impl: src/routes/admin/ai-capability-discovery.ts::routes --> <!-- @test: src/__tests__/routes/target-capability-discovery.test.ts (REQ-ENTERPRISE-072/075: binds discovered Native selectable mappings to the receipt and saved target rather than replacing them with Provider default) --> <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/bedrock-generic-upgrade.test.ts (certifies, saves and authorizes a synthetic future model through the existing workflow without authoring a profile) --> <!-- @test: src/__tests__/routes/bedrock-generic-upgrade.test.ts (upgrades one real old profile reference via explicit confirmation while retaining another disabled stale target) --> <!-- @test: src/__tests__/routes/target-capability-discovery.test.ts (REQ-ENTERPRISE-075: confirms selected Native $profile.id through endpoint, Save and runtime without borrowing tools or cache evidence) -->
4. Missing or incomplete cache evidence remains inconclusive without blocking an otherwise receipt-eligible native target. <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility --> <!-- @impl: src/lib/ai-capability-discovery/contract.ts::capabilityEvidenceMatches --> <!-- @test: src/__tests__/lib/bedrock-capability-discovery.test.ts (REQ-ENTERPRISE-075: keeps native tools and authentic replay assignable without input-cache evidence (%s)) -->
5. Provider-native Bedrock profiles are ineligible in Dynamic Route draft selections, including previously stored selections. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-034: loads every detected inventory read-only and exposes models in the selected route outside advanced disclosures) --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-075: removes hidden provider-native authority from a Dynamic Route draft until an allowed profile is selected) -->
6. After generic adoption, reselecting an applicable saved explicit profile in Advanced requires fresh exact verification before the unchanged-transport target becomes ready. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/TargetCapabilityDiscovery.test.tsx (retains saved $profileId in Advanced after generic adoption, requiring a fresh exact check when reselected) -->

**Constraints:**

- Native failure parsing retains only validated diagnostics and the sanitized explanation, never raw provider bodies, signed replay or a successful receipt. <!-- @impl: web-ui/src/api/client.ts::checkNativeTarget --> <!-- @test: web-ui/src/__tests__/api/client.test.ts (REQ-ENTERPRISE-075: retains sanitized Native cache-refusal evidence through API parsing) -->

- Administration performs no provider fallback or paid retry.
- Other native protocols retain Advanced flows until deliberately extended.
- Advanced listing offers the reusable Provider-default template without certifying model capability; it does not make Provider default the first normal native probe.
- Native discovery uses at most 34 calls: six five-call forms plus at most four Provider-default fallback calls, with one shared submission counter/deadline, no alias probes and no transport cross-product. <!-- @impl: src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities --> <!-- @test: src/__tests__/lib/bedrock-capability-discovery.test.ts (REQ-ENTERPRISE-074: discovers selectable native forms on an unknown model with exact replay and $transport dispatch) -->
- Advanced generated-Native verification uses the same bounded per-semantic runner, without repeating the campaign or exceeding inner probe limits. <!-- @impl: src/lib/ai-capability-discovery/index.ts::verifyNativeCapabilityProfile --> <!-- @test: src/__tests__/routes/target-capability-discovery.test.ts (REQ-ENTERPRISE-075: re-verifies only selected Native mappings with exact receipt authority (failed replay: %s)) -->
- The shared normal UI discloses 40 submissions/10 minutes overall, 2,048 output tokens each and 90 seconds per request. <!-- @impl: web-ui/src/components/admin/TargetCapabilityDiscovery.tsx::TargetCapabilityDiscovery --> <!-- @test: web-ui/src/__tests__/components/TargetCapabilityDiscovery.test.tsx (selects a future Bedrock model and adopts its reusable native contract in one Discover action) -->
- Server receipts, not UI adoption or profile names, authorize Save and runtime.
- Discovery does not persist activation; incomplete tools/replay and fatal campaign failures never enable targets. Optional cache failure grants no cache permission and does not erase completed lifecycle evidence.
- Historical documents remain readable, and unchanged stale targets may stay disabled.
- Historical Advanced verification retains its existing evidence semantics.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-052](#req-enterprise-052-native-provider-verification-and-runtime-enforcement), [REQ-ENTERPRISE-074](#req-enterprise-074-provider-native-bedrock-target-identity)

**Verification:** Historical RED checkpoint CI `34764775466` remains provenance. Administrator-confirmation regressions failed in CI `34770156766`; updated implementation awaits exact-head CI. No live or deployed acceptance is claimed.

**Status:** Planned

---

## Target identity and persistence

<a id="req-enterprise-053-native-target-identity-persistence-and-save-lifecycle"></a>
### REQ-ENTERPRISE-053: Native Target Identity and Document

**Intent:** The Worker owns stable native-target identity and its bounded authority document.

**Applies To:** Worker

**Acceptance Criteria:**

1. The Worker assigns a server-owned target UUID and derives its stable opaque `cf-native-<uuid>` handle from that UUID. <!-- @impl: src/lib/native-ai-targets.ts::reconcileNativeTargets --> <!-- @impl: src/lib/native-ai-targets.ts::nativeTargetHandle --> <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-054: administrator confirmation issues server identity, persists authority, and leaves it unchanged on route-only Save) -->
2. The versioned Worker KV document persists raw provider-configuration identity and any validated BYOK alias. <!-- @impl: src/lib/native-ai-targets.ts::reconcileNativeTargets --> <!-- @impl: src/lib/admin-configuration.ts::executeConfigurationTask --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-054: administrator confirmation issues server identity, persists authority, and leaves it unchanged on route-only Save) -->

**Constraints:** The document contains at most 64 unique targets and keeps exact provider authority Worker-only.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-047](#req-enterprise-047-native-ai-gateway-provider-discovery-and-selection), [REQ-ENTERPRISE-048](#req-enterprise-048-native-provider-capability-catalog), [REQ-ENTERPRISE-060](#req-enterprise-060-native-target-input-validation)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-055: Native Target Authority and Save

**Intent:** Verification, runtime dispatch, and Save use the same current Worker-owned provider authority while preserving valid proof and rejecting stale authority.

**Applies To:** Worker

**Acceptance Criteria:**

1. Native verification applies the exact validated BYOK alias selected by current provider discovery. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-055: applies the discovered provider alias during native verification) -->
2. Native runtime dispatch applies the identical stored validated BYOK alias. <!-- @impl: src/lib/access.ts::resolveRouteCatalog --> <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-050: dispatches %s through its exact Worker-owned selector) -->
3. Save validates current provider discovery and submitted target data, including Dynamic Route/native-target name collisions, before any routing KV write. <!-- @impl: src/lib/admin-configuration.ts::validateConfigurationValues --> <!-- @impl: src/lib/admin-configuration.ts::executeConfigurationTask --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-055: rejects invalid native target data before any routing write) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-055: rejects a Dynamic Route that collides with a submitted native handle before any routing write) --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-055: submits saved native identity during a policy-only edit) -->
4. Label and context edits retain identity and unchanged current saved proof. <!-- @impl: src/lib/native-ai-targets.ts::reconcileNativeTargets --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-055: unchanged provider authority retains identity and proof across label and context edits) -->
5. Proof is rejected when provider, model, binding, profile, transport, adapter, target, or gateway identity changes. <!-- @impl: src/lib/native-ai-targets.ts::reconcileNativeTargets --> <!-- @impl: src/lib/native-ai-targets.ts::nativeVerificationMatches --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-055: changed provider authority invalidates proof) --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-055: changed target or connection authority fails verification matching) -->
6. A route-only Save that omits native targets neither creates nor rewrites the native-target document. <!-- @impl: src/lib/admin-configuration.ts::validateConfigurationValues --> <!-- @impl: src/lib/admin-configuration.ts::executeConfigurationTask --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-054: administrator confirmation issues server identity, persists authority, and leaves it unchanged on route-only Save) -->
7. A route name is classified as native only when a submitted native target owns it; an unowned native-shaped name remains a Dynamic Route. <!-- @impl: src/lib/admin-configuration.ts::validateConfigurationValues --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-055: validates a native-shaped Dynamic Route as a Dynamic Route when no native target owns it) -->

**Constraints:**

- Save validates complete routing values before writes.
- Receipt recovery follows [REQ-ENTERPRISE-043](#req-enterprise-043-enterprise-pi-verified-route-activation) and requires matching target and connection authority. <!-- @impl: src/lib/admin-configuration.ts::validateConfigurationValues -->
- Fresh valid receipts replace observations.
- Unavailable or expired receipts may use unchanged current saved proof. <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-065: an unavailable old Native receipt cannot block unchanged current saved target authority) -->
- Explicit null clears proof.
- Present mismatched receipts reject.
- Existing multi-key KV writes are not transactional. Reconciliation reports persistence failures rather than claiming committed cleanup. <!-- @impl: src/routes/admin/configuration-runs.ts::reconcileSavedAiRoutingConfiguration --> <!-- @test: src/__tests__/routes/live-routing-reconciliation.test.ts (REQ-SETUP-018: a failed %s write cannot report committed cleanup) -->
- Reconciliation removes a Native target only when its exact stored provider binding is authoritatively absent. Ambiguous, unsupported or alias-changed present bindings remain stored without regaining readiness; replacement bindings cannot retain a deleted target. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/live-routing-reconciliation.test.ts (REQ-ENTERPRISE-055: exact binding presence retains ambiguous or unsupported targets but a replacement binding cannot retain a deleted target) -->

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-047](#req-enterprise-047-native-ai-gateway-provider-discovery-and-selection), [REQ-ENTERPRISE-048](#req-enterprise-048-native-provider-capability-catalog), [REQ-ENTERPRISE-052](#req-enterprise-052-native-provider-verification-and-runtime-enforcement), [REQ-ENTERPRISE-053](#req-enterprise-053-native-target-identity-and-document)

**Verification:** Regression checkpoint `bef54164` failed in CI `34770156766`. Updated implementation and behavioral fixtures await exact-head CI; no deployed acceptance is claimed.

**Status:** Planned

---

### REQ-ENTERPRISE-060: Native Target Input Validation

**Intent:** The Worker validates native target inputs without erasing provider-specific model syntax.

**Applies To:** Worker

**Acceptance Criteria:**

1. Native target context is an integer greater than 16,384. <!-- @impl: src/lib/native-ai-targets.ts::nativeTargetDraftSchema --> <!-- @impl: src/lib/native-ai-targets.ts::createNativeTarget --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-060: enforces the Bedrock model boundary without restricting custom-provider model syntax) -->
2. Bedrock models reject paths, URLs, ARNs, traversal, wildcards, queries, and fragments. <!-- @impl: src/lib/native-ai-targets.ts::nativeTargetDraftSchema --> <!-- @impl: src/lib/native-ai-targets.ts::createNativeTarget --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-060: enforces the Bedrock model boundary without restricting custom-provider model syntax) -->
3. Other providers retain their bounded slash and colon model syntax. <!-- @impl: src/lib/native-ai-targets.ts::nativeTargetDraftSchema --> <!-- @impl: src/lib/native-ai-targets.ts::createNativeTarget --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-060: enforces the Bedrock model boundary without restricting custom-provider model syntax) -->

**Constraints:** Validation rejects invalid input rather than rewriting exact model identity.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-047](#req-enterprise-047-native-ai-gateway-provider-discovery-and-selection)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-065: Native Verification Credential Rebinding

**Intent:** Replacement AI Gateway credentials preserve native verification authority only for the same gateway and native target identity.

**Applies To:** Worker

**Acceptance Criteria:**

1. Authoritative preview rebinds saved proof only when saved and submitted gateway coordinates are equivalent and provider, binding, model, profile, transport, adapter, and target identity remain unchanged. <!-- @impl: src/lib/admin-configuration.ts::validateConfigurationValues --> <!-- @impl: src/lib/native-ai-targets.ts::rebindNativeVerificationConnection --> <!-- @impl: src/routes/admin/configuration-previews.ts::app --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-065: rebinds saved native authority only for equivalent coordinates and unchanged identity) -->

**Constraints:** Rebinding does not persist checks or invoke a model probe; changed identity fails closed under [REQ-ENTERPRISE-055](#req-enterprise-055-native-target-authority-and-save).

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-055](#req-enterprise-055-native-target-authority-and-save), [REQ-ENTERPRISE-057](setup.md#req-enterprise-057-ai-gateway-connection-rotation)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-074: Provider-native Bedrock Target Identity

**Intent:** Administrators bind each provider-native Bedrock target to its exact validated identity without migrating compatibility targets.

**Applies To:** Admin

**Acceptance Criteria:**

1. Native-target identity binds the exact Bedrock model, AWS region, profile revision, and automatic or explicit transport contract. <!-- @impl: src/lib/native-ai-targets.ts::createNativeTarget --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-074: binds provider-native Bedrock profiles to the validated model, region, and transport) --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-074: preserves the selected region through successive model edits without submitting it for compatibility) -->
2. Existing compatibility targets retain their compatibility transport. <!-- @impl: src/lib/native-ai-targets.ts::createNativeTarget --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-074: binds provider-native Bedrock profiles to the validated model, region, and transport) -->
3. Compatibility targets reject a region. <!-- @impl: src/lib/native-ai-targets.ts::createNativeTarget --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-074: binds provider-native Bedrock profiles to the validated model, region, and transport) -->
4. New Anthropic Messages candidates use automatic Worker-owned transport without an administrator transport selector; the exact model requires target-bound verification. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-075: selects older/current/synthetic future models with one reusable native profile and explicit verification) -->
5. Existing explicit transport and compatibility identities retain their authority on unrelated edits. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-074/078: preserves saved %s / %s identity and real levels on unrelated edits) -->

**Constraints:** Existing compatibility targets are not migrated automatically.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-048](#req-enterprise-048-native-provider-capability-catalog)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

## Reasoning and capability profiles

### REQ-ENTERPRISE-031: Enterprise Pi Capability Profile Administration

**Intent:** Administrators can define and assign safe capability profiles without binding Codeflare to a finite model list.

**Applies To:** Admin

**Acceptance Criteria:**

1. The catalog exposes sixteen executable built-ins, including the reusable native Provider-default contract, and keeps failed families as non-assignable notices. Catalog presence does not establish target capability. <!-- @impl: src/lib/reasoning-profiles.ts::BUILT_IN_REASONING_PROFILES --> <!-- @impl: src/lib/reasoning-profiles.ts::COMPATIBILITY_NOTICES --> <!-- @test: src/__tests__/lib/reasoning-profiles.test.ts (ships the reusable native contract alongside unchanged historical built-ins and failed-family notices) -->
2. Custom revisions accept bounded scalar mappings and reject protected request fields or executable transforms. <!-- @impl: src/lib/reasoning-profiles.ts::normalizeCustomProfile --> <!-- @impl: src/lib/reasoning-discovery.ts::mappingFromWrites --> <!-- @test: src/__tests__/lib/reasoning-profiles.test.ts (normalizes bounded scalar mappings and rejects protected request roots) --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-031: verifies canonical custom scalar paths beyond discovery candidate roots) --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (REQ-ENTERPRISE-031: rejects unsafe write and removal path %s without mutating the request) -->
3. Profile assignments reference immutable revisions, and referenced custom revisions cannot be disabled or collected. <!-- @impl: src/lib/reasoning-configuration.ts::validateReasoningConfigurationUpdate --> <!-- @test: src/__tests__/lib/reasoning-configuration.test.ts (rejects disabling or collecting a custom revision while a route or leg references it) -->
4. Legacy migration proposes GLM and Kimi assignments but leaves GPT-OSS unresolved. <!-- @impl: src/lib/reasoning-configuration.ts::migrateLegacyReasoningAssignments --> <!-- @test: src/__tests__/lib/reasoning-configuration.test.ts (proposes GLM and Kimi migration in preview without persisting it) --> <!-- @test: src/__tests__/lib/reasoning-configuration.test.ts (leaves GPT-OSS unresolved and requires correction for a Kimi off startup default) -->
5. Observed-path activation requires explicit acknowledgement of server-recomputed warnings at the current revision. <!-- @impl: src/lib/admin-configuration.ts::buildConfigurationPreview --> <!-- @test: src/__tests__/routes/admin-configuration-runs.test.ts (REQ-ENTERPRISE-043: recomputes observed-path warnings and requires explicit codes at the same base revision) -->
6. ID-only routing saves preserve omitted custom revisions. <!-- @impl: src/lib/admin-configuration.ts::normalizeAiReasoningConfiguration --> <!-- @test: src/__tests__/routes/admin-configuration-runs.test.ts (REQ-ENTERPRISE-031: persists named custom revisions and exact assignments through Save→GET and preserves the catalog when legacy saves omit it) -->
7. ID-only routing saves retain unchanged exact assignments without selecting newer custom revisions. <!-- @impl: src/lib/admin-configuration.ts::normalizeAiReasoningConfiguration --> <!-- @test: src/__tests__/routes/admin-configuration-runs.test.ts (REQ-ENTERPRISE-031: retains an already assigned exact custom revision on ID-only saves without choosing a newer revision) -->

**Constraints:**

- Canonical levels remain `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; declared `off` mappings never alias an enabled level.
- Runtime hint selection is separate from profile declarations.
- Built-ins are immutable.
- Custom profiles are bounded declarative data and cannot control credentials, providers, transport, messages, tools, models, or streams.
- Legacy migration of unsupported startup defaults requires administrator correction before activation, consistent with [REQ-ENTERPRISE-032](#req-enterprise-032-enterprise-pi-route-selection-and-runtime-translation) AC1. <!-- @impl: src/lib/reasoning-configuration.ts::migrateLegacyReasoningAssignments --> <!-- @test: src/__tests__/lib/reasoning-configuration.test.ts (leaves GPT-OSS unresolved and requires correction for a Kimi off startup default) -->
- Missing, disabled, malformed, non-executable, and protected-field failures remain hard gates; discovery rejects unmapped probe levels, while runtime maps hints within the assigned profile; legacy compatibility evidence remains advisory, while activation authority follows [REQ-ENTERPRISE-043](#req-enterprise-043-enterprise-pi-verified-route-activation).

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-012](setup.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list), [REQ-ENTERPRISE-013](#req-enterprise-013-per-group-dynamic-routing)

**Verification:** Automated tests in the anchored backend and web-ui suites above.

**Status:** Implemented

---

### REQ-ENTERPRISE-039: Enterprise Pi Default Reasoning Controls

**Intent:** Administrators understand which default reasoning choices a route permits.

**Applies To:** Admin

**Acceptance Criteria:**

1. Each fallback or group reasoning selector offers all seven Provider-default preferences, or only the explicit profile's supported levels and aliases, including off-only profiles. Provider-default Off explains no override and provider-controlled behavior. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-039: supported levels and associated helpers explain checked group and fallback defaults) -->
2. Associated help explains absent eligible routes and single-mode disabled states. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-039: supported levels and associated helpers explain checked group and fallback defaults) --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-039: default reasoning help distinguishes pending connection from missing checked route assignment) -->
3. Disabling a single-mode selector preserves that mode in the Save payload. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @test: web-ui/src/__tests__/components/AiRoutingFields.test.tsx (REQ-ENTERPRISE-039: a single non-off mode stays disabled yet serializes its selected policy value) -->
4. An absent global default is represented by an empty route with Off reasoning. <!-- @impl: src/lib/admin-configuration.ts::validateConfigurationValues --> <!-- @test: src/__tests__/routes/admin-configuration-preview.test.ts (accepts an AI Gateway connection before routes or access policies exist) -->
5. Authoritative validation rejects a non-Off global reasoning level without a route. <!-- @impl: src/lib/admin-configuration.ts::validateConfigurationValues --> <!-- @test: src/__tests__/routes/admin-configuration-preview.test.ts (REQ-ENTERPRISE-039: rejects reasoning without a global default route) -->

**Constraints:**

- Policy defaults require eligible live-verified or administrator-confirmed routes; profile selection alone remains a draft operation. <!-- @test: web-ui/src/__tests__/components/AiRoutingWorkspace.test.tsx (REQ-ENTERPRISE-043: explicit administrator confirmation enables access without claiming live-check results) -->
- Catalog hydration preserves existing selections, including supported Off; changing the route/profile replaces only unsupported selections. Native configurable defaults must match the resolved canonical profile and evidence on Save, not rely on runtime fallback. <!-- @impl: src/lib/admin-configuration.ts::validateConfigurationValues -->
- Provider-default Off is a selectable preference, not verified disabled; the Worker sends no reasoning override. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::PolicyFields --> <!-- @test: web-ui/src/__tests__/components/TargetCapabilityDiscovery.test.tsx (REQ-ENTERPRISE-045: %s receipt permits an Off default preference and access without inventing cache or saving) -->

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-034](setup.md#req-enterprise-034-enterprise-pi-route-administration)

**Verification:** Regression checkpoint `bef54164` failed in CI `34770156766`. Updated implementation and behavioral fixtures await exact-head CI; no deployed acceptance is claimed.

**Status:** Planned

---

<a id="req-enterprise-048-native-provider-capability-verification"></a>
### REQ-ENTERPRISE-048: Native Provider Capability Catalog

**Intent:** Native providers use evidence-backed compatibility profiles that state only the capabilities demonstrated for each cataloged family.

**Applies To:** Admin

**Acceptance Criteria:**

1. Evidence-backed built-ins cover Bedrock Claude Sonnet/Opus, Google AI Studio Gemini 3.1 Pro and 3.7/3.8 Flash, OpenAI GPT-5.6 Sol/Terra/Luna, and Codeflare Inference Mesh Ornith. <!-- @impl: src/lib/reasoning-profiles.ts::BUILT_IN_REASONING_PROFILES --> <!-- @test: src/__tests__/lib/reasoning-profiles.test.ts (REQ-ENTERPRISE-048: ships live-evidenced native profiles without overstating reasoning controls) -->
2. Compatibility-mode Bedrock, Gemini, and Mesh use provider-default reasoning; provider-native Bedrock controls are specified separately. <!-- @impl: src/lib/reasoning-profiles.ts::BUILT_IN_REASONING_PROFILES --> <!-- @test: src/__tests__/lib/reasoning-profiles.test.ts (REQ-ENTERPRISE-048: Bedrock Anthropic uses provider-default opaque reasoning without Pi levels) -->
3. OpenAI GPT-5.6 exposes only the verified `off` mapping `reasoning_effort: none`. <!-- @impl: src/lib/reasoning-profiles.ts::BUILT_IN_REASONING_PROFILES --> <!-- @test: src/__tests__/lib/reasoning-profiles.test.ts (REQ-ENTERPRISE-048: ships live-evidenced native profiles without overstating reasoning controls) -->
4. GPT-6 Astra remains excluded after live Chat Completions tool failure. <!-- @impl: src/lib/reasoning-profiles.ts::BUILT_IN_REASONING_PROFILES --> <!-- @test: src/__tests__/lib/reasoning-profiles.test.ts (REQ-ENTERPRISE-048: ships live-evidenced native profiles without overstating reasoning controls) -->

**Constraints:** Provider-default profiles do not claim Off, Medium, High, or signed-thinking semantics.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-031](#req-enterprise-031-enterprise-pi-capability-profile-administration)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-070: Bedrock Dynamic Route Provider-default Profile

**Intent:** Administrators can assign verified Bedrock Claude Dynamic Routes without overstating reasoning control.

**Applies To:** Admin

**Acceptance Criteria:**

1. The profile catalogue provides a Dynamic Route Bedrock Anthropic profile with verified tool compatibility, provider-default reasoning, and no selectable Pi reasoning levels. <!-- @impl: src/lib/reasoning-profiles.ts::BUILT_IN_REASONING_PROFILES --> <!-- @impl: web-ui/src/components/admin/pi-profile-presentation.ts::profileDisplayName --> <!-- @test: src/__tests__/lib/reasoning-profiles.test.ts (REQ-ENTERPRISE-070: gives Bedrock Dynamic Routes a distinct tool-capable provider-default profile) -->
2. Verification can issue and persist exact route authority when the selected provider-default profile has no selectable Pi reasoning levels. <!-- @impl: src/lib/reasoning-configuration.ts::parseRouteVerification --> <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/reasoning-eligibility.test.ts (REQ-ENTERPRISE-070: persists authority for a provider-default Dynamic Route with no selectable Pi levels) -->
3. Dynamic Route discovery can match this exact profile from successful tool-call replay without claiming Pi reasoning levels or offering provider-native profiles. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/routes/admin-reasoning-discovery.test.ts (REQ-ENTERPRISE-070: discovers the provider-default Bedrock Dynamic Route profile from tool replay without inventing reasoning levels) -->

**Constraints:** Dynamic Routing exposes no verified Off or graduated reasoning controls for this profile; native-provider evidence is not transferred to it.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-043](#req-enterprise-043-enterprise-pi-verified-route-activation)

**Verification:** Anchored behavioral fixtures; execution is CI-only.

**Status:** Implemented

---

### REQ-ENTERPRISE-072: Provider-native Bedrock Reasoning Profiles

**Intent:** Compatible Anthropic Messages releases discover reusable, target-evidenced native controls without per-model code; historical profiles remain immutable and bounded.

**Applies To:** System

**Acceptance Criteria:**

1. The native Sonnet profile exposes every Pi level using validated Minimal→Low and XHigh/Max→High aliases. <!-- @impl: src/lib/reasoning-profiles.ts::BUILT_IN_REASONING_PROFILES --> <!-- @test: src/__tests__/lib/reasoning-profiles.test.ts (REQ-ENTERPRISE-072/078: maps native Bedrock reasoning only to evidence-supported controls and fails closed above streaming High) -->
2. The native Opus eventstream profile exposes Off through High with Minimal→Low. <!-- @impl: src/lib/reasoning-profiles.ts::BUILT_IN_REASONING_PROFILES --> <!-- @test: src/__tests__/lib/reasoning-profiles.test.ts (REQ-ENTERPRISE-072/078: maps native Bedrock reasoning only to evidence-supported controls and fails closed above streaming High) -->
3. The separate native Opus Invoke profile exposes distinct XHigh and Max controls. <!-- @impl: src/lib/reasoning-profiles.ts::BUILT_IN_REASONING_PROFILES --> <!-- @test: src/__tests__/lib/reasoning-profiles.test.ts (REQ-ENTERPRISE-072/078: maps native Bedrock reasoning only to evidence-supported controls and fails closed above streaming High) -->
4. Automatic Opus routing has its own immutable all-level profile. <!-- @impl: src/lib/reasoning-profiles.ts::BUILT_IN_REASONING_PROFILES --> <!-- @test: src/__tests__/lib/reasoning-profiles.test.ts (REQ-ENTERPRISE-072/078: gives automatic Opus routing its own immutable all-level profile) -->
5. Existing explicit profiles retain their capability limits. <!-- @impl: src/lib/reasoning-profiles.ts::BUILT_IN_REASONING_PROFILES --> <!-- @test: src/__tests__/lib/reasoning-profiles.test.ts (REQ-ENTERPRISE-072/078: maps native Bedrock reasoning only to evidence-supported controls and fails closed above streaming High) -->
6. A new compatible Anthropic Bedrock identifier discovers successful disabled/Low/Medium/High/XHigh/Max forms without a model-list addition, returning their canonical reusable native custom revision. <!-- @impl: src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities --> <!-- @test: src/__tests__/lib/bedrock-capability-discovery.test.ts (REQ-ENTERPRISE-074: discovers selectable native forms on an unknown model with exact replay and $transport dispatch) -->
7. Provider default is an exclusive fallback when no configurable native form qualifies; it retains client preferences without sending reasoning overrides or claiming true Off. <!-- @impl: src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities --> <!-- @impl: src/lib/reasoning-profiles.ts::translateRuntimeReasoningRequest --> <!-- @test: src/__tests__/lib/bedrock-capability-discovery.test.ts (REQ-ENTERPRISE-072: uses provider default only when every configurable native form is rejected) -->

**Constraints:**

- Each retained form needs its own complete tools/replay; accepted controls without observable reasoning remain `accepted-unverified`, not measured effort strength.
- Minimal→Low is the only generated alias, included only when Low passes. <!-- @impl: src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities -->
- Failed forms and dangling aliases are excluded; no Max→Medium or unfamiliar-model Sonnet aliases are fabricated. <!-- @impl: src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities --> <!-- @test: src/__tests__/lib/bedrock-capability-discovery.test.ts (REQ-ENTERPRISE-072: excludes rejected native controls and dangling Minimal aliases instead of borrowing default evidence) -->
- Verified native Off requires literal disable plus complete clean native reasoning observation. <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility -->
- Private thinking/redacted presence must survive public stripping as sanitized presence/completion only, never text, signatures or invented counters. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::adaptBedrockAnthropicResponse --> <!-- @test: src/__tests__/lib/bedrock-capability-discovery.test.ts (REQ-ENTERPRISE-072: private $kind without counters cannot prove Off after public stripping ($transport)) -->
- Generated IDs use `bedrock-anthropic-native-discovered-<24hex>`; namespace selects validation, never authority. <!-- @impl: src/lib/reasoning-profiles.ts::isGeneratedNativeProfileId -->
- Canonical maps/hash, exact target/provider and server receipts remain mandatory. <!-- @impl: src/lib/native-ai-targets.ts::nativeVerificationMatches -->
- Native profile evidence changes neither Dynamic transport nor its existing seven-preference publication/normalization.
- Historical evidence-model guards remain exact.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-048](#req-enterprise-048-native-provider-capability-catalog)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-078: Provider-native Bedrock Level Enforcement

**Intent:** Provider-native Bedrock requests translate client reasoning hints into executable values within the assigned profile and transport.

**Applies To:** Worker

**Acceptance Criteria:**

1. Requested reasoning selects an exact executable level, otherwise the next higher level, otherwise the highest lower level. <!-- @impl: src/lib/reasoning-profiles.ts::selectRuntimeReasoningLevel --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-078: maps Opus %s to High within the explicit eventstream profile without switching to Invoke) -->
2. Mapped requests retain the assigned transport and signed-replay validation. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-073: downward mapping of Max still requires signed native tool replay) --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (REQ-ENTERPRISE-058: maps a native streaming default Max down to High without losing the authorized catalog) -->

**Constraints:**

- Runtime mapping never widens profile capability, migrates profile identity, or changes an explicit transport.
- Verification/discovery retains strict exact-level translation.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-072](#req-enterprise-072-provider-native-bedrock-reasoning-profiles)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

## Wire compatibility, replay and stream integrity

### REQ-ENTERPRISE-059: Native Provider Wire Adaptation

**Intent:** Provider-specific wire repair applies only where demonstrated and preserves unrelated protocol data.

**Applies To:** Worker

**Acceptance Criteria:**

1. Bedrock streams suppress an exact repeated complete tool name while preserving fragments, arguments, IDs, content, finish reasons, and nonmatching names. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/lib/openai-sse-tool-name-repair.test.ts (REQ-ENTERPRISE-059: suppresses only repeated complete Bedrock tool names) -->
2. Gemini streaming exposes its bounded opaque thought signature through preserved reasoning metadata. <!-- @impl: src/lib/gemini-thought-signature-adapter.ts::exposeGeminiThoughtSignatures --> <!-- @test: src/__tests__/lib/gemini-thought-signature-adapter.test.ts (REQ-ENTERPRISE-059: thought-signature exposure preserves unrelated response data) -->
3. Gemini replay restores a thought signature only to its matching assistant tool call. <!-- @impl: src/lib/gemini-thought-signature-adapter.ts::restoreGeminiThoughtSignatures --> <!-- @test: src/__tests__/lib/gemini-thought-signature-adapter.test.ts (REQ-ENTERPRISE-059: thought-signature restoration preserves unrelated request data) -->
4. Thought-signature exposure preserves unrelated response data. <!-- @impl: src/lib/gemini-thought-signature-adapter.ts::exposeGeminiThoughtSignatures --> <!-- @test: src/__tests__/lib/gemini-thought-signature-adapter.test.ts (REQ-ENTERPRISE-059: thought-signature exposure preserves unrelated response data) -->
5. Thought-signature exposure bounds each SSE line independently of transport chunk size. <!-- @impl: src/lib/gemini-thought-signature-adapter.ts::exposeGeminiThoughtSignatures --> <!-- @test: src/__tests__/lib/gemini-thought-signature-adapter.test.ts (REQ-ENTERPRISE-059: accepts one large transport chunk containing bounded SSE lines) --> <!-- @test: src/__tests__/lib/gemini-thought-signature-adapter.test.ts (REQ-ENTERPRISE-059: rejects an oversized newline-terminated SSE line) --> <!-- @test: src/__tests__/lib/gemini-thought-signature-adapter.test.ts (REQ-ENTERPRISE-059: rejects an oversized SSE prefix before its newline arrives) --> <!-- @test: src/__tests__/lib/gemini-thought-signature-adapter.test.ts (REQ-ENTERPRISE-059: rejects final decoder output that crosses the SSE line limit) -->
6. Thought-signature restoration preserves unrelated request data. <!-- @impl: src/lib/gemini-thought-signature-adapter.ts::restoreGeminiThoughtSignatures --> <!-- @test: src/__tests__/lib/gemini-thought-signature-adapter.test.ts (REQ-ENTERPRISE-059: thought-signature restoration preserves unrelated request data) -->
7. Provider-specific adapters leave every untargeted protocol path unchanged. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/lib/openai-sse-tool-name-repair.test.ts (REQ-ENTERPRISE-059: leaves ordinary fragmented tool names and Dynamic Route streams unchanged) --> <!-- @test: src/__tests__/llm-interceptor.test.ts (does not touch a non-chat-completions stream (e.g. /responses passes through unchanged)) -->

**Constraints:** Repair performs no generic response rewriting or cumulative-prefix trimming.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-050](#req-enterprise-050-native-provider-compat-dispatch), [REQ-ENTERPRISE-052](#req-enterprise-052-native-provider-verification-and-runtime-enforcement)

**Verification:** Anchored adapter and interceptor fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-071: Bedrock Dynamic Route Tool-call Normalization

**Intent:** The Worker preserves Pi-compatible Bedrock tool calls across discovery and runtime dispatch.

**Applies To:** Worker

**Acceptance Criteria:**

1. Discovery normalizes repeated complete Bedrock tool names while preserving tool IDs and argument fragments. <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility --> <!-- @test: src/__tests__/lib/reasoning-discovery.test.ts (REQ-ENTERPRISE-071: repairs repeated Bedrock tool names while verifying a Dynamic Route provider-default profile) -->
2. Runtime normalizes repeated complete Bedrock tool names before Pi consumes the stream. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-071: applies Bedrock tool-name repair to a Dynamic Route provider-default profile) -->
3. Runtime dispatches the selected profile through its original `dynamic/<route>` selector. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-071: applies Bedrock tool-name repair to a Dynamic Route provider-default profile) -->

**Constraints:** Normalization does not grant Dynamic Routing native-provider reasoning controls.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-032](#req-enterprise-032-enterprise-pi-route-selection-and-runtime-translation), [REQ-ENTERPRISE-070](#req-enterprise-070-bedrock-dynamic-route-provider-default-profile)

**Verification:** Anchored behavioral fixtures; execution is CI-only.

**Status:** Implemented

---

### REQ-ENTERPRISE-073: Provider-native Bedrock Replay Integrity

**Intent:** Provider tool-turn continuation state remains bounded, confidential at rest, conversation-isolated, and bound to its authentic tool call.

**Applies To:** Worker

**Acceptance Criteria:**

1. Serialized provider tool-turn replay state does not exceed 64 KiB. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::MAX_REPLAY_BYTES = 64 * 1024 --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::cloneBlocks --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-073: rejects signed replay state above the 64 KiB serialized limit) -->
2. Provider tool-turn replay state remains confidential at rest. <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-073/077: continues an authentic %s High tool response through encrypted replay and Eventstream) --> <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-073/077: dispatches provider-native Bedrock Invoke with exact reasoning controls and hides signed replay state) -->
3. Replay state is isolated by authenticated user, session, target/tool identity, and verified connection/provider/model/region/profile/transport/adapter binding. <!-- @impl: src/llm-interceptor.ts::nativeReplayStateKey --> <!-- @test: src/__tests__/llm-interceptor.test.ts -->
4. Available provider blocks are restored exactly, in historical and active turns, only when the complete assistant tool-call identity matches; a mismatch is never treated as absent state. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::assistantContent --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-073/076: translates OpenAI tools and restores the exact server-held signed assistant blocks) --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-073: fails closed when signed replay does not match the tool name and arguments) -->
5. Historical tool calls before the classified active turn may be translated when signed state is absent, including paired interrupted tools with no final assistant answer. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::buildBedrockAnthropicRequest --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-073: accepts completed foreign tool history before a new native user turn) --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-073: accepts a new text question after paired interrupted tools) -->
6. Complete validated provider tool-turn content is retained even without normal thinking blocks. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::persistReplay --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-073/076: restores authentic $label content from its emitted tool call) --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-073: preserves successive signed and unsigned tools in one active turn (%s)) -->
7. Completed foreign historical tool pairs are deterministically mapped to the Anthropic Messages Runtime tool-ID alphabet, preserving assistant/result correlation without changing the client transcript. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::historicalToolAliases --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-073: aliases completed foreign tool IDs to the Bedrock Messages alphabet) -->

**Constraints:**

- Replay state is never supplied by an untrusted client.
- Normal thinking is optional ([Anthropic's thinking and tool-use guidance](https://platform.claude.com/docs/en/build-with-claude/thinking)).
- Present thinking and redacted blocks remain intact.
- The active-turn boundary follows [REQ-ENTERPRISE-076](#req-enterprise-076-provider-native-bedrock-protocol-translation).
- Absent historical state does not waive validation of available blocks or active replay, including Provider-default and disabled-thinking requests.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-059](#req-enterprise-059-native-provider-wire-adaptation)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-076: Provider-native Bedrock Protocol Translation

**Intent:** Provider-native Bedrock requests and responses preserve Pi's OpenAI tool-calling protocol.

**Applies To:** Worker

**Acceptance Criteria:**

1. Runtime translates OpenAI Chat Completions messages and tools to the Bedrock Anthropic request contract. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::buildBedrockAnthropicRequest --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-073/076: translates OpenAI tools and restores the exact server-held signed assistant blocks) -->
2. Runtime translates Invoke responses back to Pi's OpenAI protocol. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::adaptBedrockAnthropicResponse --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-076/079/085: converts Invoke responses and stores signed thinking without exposing it downstream) -->
3. Runtime decodes AWS eventstream headers and base64 chunk payloads into Pi's OpenAI stream, preserving text, tools, and usage. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::decodeBedrockChunk --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::adaptBedrockAnthropicResponse --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-073/076: decodes eventstream blocks into OpenAI SSE and stores exact signed replay state) --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-076: decodes split and coalesced AWS chunk envelopes without losing UTF-8 text) --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-076/077: delivers AWS chunk-wrapped native Bedrock text to Pi without a fallback request) -->
4. A nonempty text-only user message starts a new turn when preceding tool-call IDs and results are completely paired without orphan or duplicate ambiguity. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::classifyBedrockToolTurn --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-073: accepts a new text question after paired interrupted tools) -->
5. Image-bearing, unknown, or empty user content does not establish a new turn or waive active replay protection. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::classifyBedrockToolTurn --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-079: user-role content does not close an unfinished tool turn) -->
6. Native usage preserves provider prompt-cache reads and writes as separate Pi-compatible counters. OpenAI `prompt_tokens` includes uncached input, cache reads, and cache writes exactly once; completion tokens already include thinking. Invoke JSON, Invoke's synthesized SSE, and Eventstream's terminal usage follow the same accounting. Absent or invalid cache counters are not advertised as measured zeroes. This reports provider input caching, not an AI Gateway whole-response cache hit, and changes no request controls or transport selection. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::openAiUsage --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-076: preserves separate prompt-cache counters in %s usage) --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-076: omits unmeasured cache counters and preserves explicit zeroes) -->
7. A completed tool-call/result pair needs no final assistant answer before the next nonempty text-only user turn. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::classifyBedrockToolTurn --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-073: accepts a new text question after paired interrupted tools) -->

**Constraints:** Provider-signed state remains outside the translated client protocol. `classifyBedrockToolTurn` in `src/lib/bedrock-anthropic-native-adapter.ts` classifies original OpenAI messages before tool results become native user blocks. Request translation uses that classification to validate replay. Only after validation does transport selection consume the saved transport and mapped effort; it does not directly consume replay classification.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-059](#req-enterprise-059-native-provider-wire-adaptation), [REQ-ENTERPRISE-073](#req-enterprise-073-provider-native-bedrock-replay-integrity)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-079: Provider-native Bedrock Replay Confidentiality

**Intent:** Authentic continuation state is never exposed; missing active state and invalid available state fail closed, independently of selected reasoning controls.

**Applies To:** Worker

**Acceptance Criteria:**

1. Signed-thinking state is omitted from downstream responses. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::adaptBedrockAnthropicResponse --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-076/079/085: converts Invoke responses and stores signed thinking without exposing it downstream) -->
2. Signed-thinking state is omitted from logs. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::adaptBedrockAnthropicResponse --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-079: never logs signed-thinking replay state) -->
3. Missing server-held active tool state fails before provider I/O for adaptive, disabled, and omitted thinking; legitimate unsigned provider turns are persisted too. Absent historical state remains allowed under the existing classifier. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::buildBedrockAnthropicRequest --> <!-- @test: src/__tests__/lib/bedrock-generic-contract.test.ts (REQ-ENTERPRISE-073: active replay requires authentic state even with thinking=%j) --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-073: restores active signed continuation after completed unsigned history) -->
4. Malformed or identity-mismatched available replay blocks fail before provider I/O, including historical blocks before a new question. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::assistantContent --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-079: rejects malformed stored history even after a new question) --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-073: fails closed when signed replay does not match the tool name and arguments) -->

5. Historical tool-ID alias collisions fail before provider I/O. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::historicalToolAliases --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-079: rejects a historical alias collision before provider I/O) -->

**Constraints:** Failure responses contain no signed state.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-073](#req-enterprise-073-provider-native-bedrock-replay-integrity)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-080: Provider-native Bedrock Stream Completion

**Intent:** Eventstream responses report decoding and persistence failures before successful completion.

**Applies To:** Worker

**Acceptance Criteria:**

1. Malformed framing, headers, payload encoding, or provider error events emit one sanitized terminal error instead of successful completion. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::adaptBedrockAnthropicResponse --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-080: emits a terminal SSE error for %s) --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-080: rejects absent, duplicate, invalid-type and truncated headers) --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-080: rejects %s before a later message_stop) --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-080: honors exception headers even when their payload resembles a valid chunk) -->
2. Replay persistence failure emits a terminal protocol error instead of successful completion. <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-080: does not advertise usable $label tools after persistence fails) --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::adaptBedrockAnthropicResponse --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-080: emits a terminal SSE error for %s) -->
3. A streamed success terminator requires message stop and clean upstream EOF. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::adaptBedrockAnthropicResponse --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-080: rejects trailing corruption before emitting a successful stream terminator) -->
4. Generic stream repair never converts a native error into success. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-ENTERPRISE-080: preserves native stream errors without adding a success terminator) -->

**Constraints:** The response remains streaming before its terminal event.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-076](#req-enterprise-076-provider-native-bedrock-protocol-translation)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-084: Bedrock Dynamic Route Image Compatibility

**Intent:** The Worker preserves image input through a verified, route-scoped Bedrock compatibility contract.

**Applies To:** Worker

**Acceptance Criteria:**

1. Automatic discovery selects native Anthropic image-block translation only for nonempty inventories consisting entirely of Amazon Bedrock Anthropic models. <!-- @impl: src/lib/ai-capability-discovery/compatibility-wire.ts::compatibilityImagesForModels --> <!-- @impl: src/routes/admin/ai-capability-discovery.ts::routes --> <!-- @test: src/__tests__/routes/target-capability-discovery.test.ts (binds the Bedrock image wire when discovery inventory is homogeneous Anthropic Bedrock) --> <!-- @test: src/__tests__/lib/target-capability-runtime.test.ts (selects Bedrock image translation only for homogeneous Anthropic Bedrock inventory) -->
2. The immutable discovered profile identity includes its selected image-wire contract. <!-- @impl: src/lib/ai-capability-discovery/index.ts::capabilityCandidates --> <!-- @test: src/__tests__/lib/target-capability-discovery.test.ts (binds the Bedrock image wire to a distinct immutable discovered contract) -->
3. Runtime converts supported user-message data-URI images through the verified image-wire contract without changing the client transcript; mixed and non-Bedrock routes retain OpenAI image parts. <!-- @impl: src/lib/ai-capability-discovery/compatibility-wire.ts::compatibilityRequest --> <!-- @test: src/__tests__/lib/target-capability-runtime.test.ts (translates OpenAI data-URI images only for a verified Bedrock compatibility wire) --> <!-- @test: src/__tests__/lib/target-capability-runtime.test.ts (dispatches a verified Bedrock discovered profile with native image blocks) -->

**Constraints:** Image compatibility does not grant native-provider reasoning controls or certify mixed-route image support.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-032](#req-enterprise-032-enterprise-pi-route-selection-and-runtime-translation)

**Verification:** Anchored behavioral fixtures; execution is CI-only.

**Status:** Implemented

---

### REQ-ENTERPRISE-085: Provider-native Bedrock Incomplete-tool Recovery

**Intent:** Native Bedrock exposes only terminally complete tool calls and safely recovers later turns from abandoned proposals.

**Applies To:** Worker

**Acceptance Criteria:**

1. A provider tool block becomes executable client output and stored replay state only after a native `tool_use` terminal reason. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::adaptBedrockAnthropicResponse --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-076/079/085: converts Invoke responses and stores signed thinking without exposing it downstream) -->
2. A `max_tokens` response retains safe text, usage, and `length` without publishing or persisting an incomplete tool call. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::adaptInvoke --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::adaptEventstream --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-073/076/085: does not publish or persist an Invoke tool call truncated by max_tokens) --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-073/076/085: terminates Eventstream as length without publishing partial tool JSON) -->
3. A zero-result tool proposal may be omitted after a later nonempty text-only user turn proves abandonment; safe assistant prose remains. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::omitAbandonedToolTurns --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-073/076/085: omits an unexecuted poisoned tool turn after a new user turn) -->
4. Matching or partial results, orphan or duplicate ambiguity, intervening assistant messages, and non-text user content retain fail-closed replay validation. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::omitAbandonedToolTurns --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::classifyBedrockToolTurn --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-079: incomplete parallel tool results remain protected despite later assistant and user text) -->

**Constraints:** Profiles, transport authority, retry policy, adapter identity, and authentic signed replay remain unchanged.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-073](#req-enterprise-073-provider-native-bedrock-replay-integrity), [REQ-ENTERPRISE-076](#req-enterprise-076-provider-native-bedrock-protocol-translation)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

## Input caching

### REQ-ENTERPRISE-083: Native Bedrock Prompt-cache Checkpoints

**Intent:** Let Pi request provider input-prefix reuse through the existing Bedrock Runtime adapter without confusing it with Gateway whole-response caching or widening the Dynamic Route contract.

**Applies To:** Enterprise native Bedrock targets

**Acceptance Criteria:**

1. Pi model-wide `cacheControlFormat: "anthropic"` is published only for authorized native Runtime handles with retained historical permission or positive provider-prefix evidence on at least one mapping of the same receipt-bound target. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @impl: src/lib/native-ai-targets.ts::nativePromptCacheSupported --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (REQ-ENTERPRISE-074: publishes synthetic future model capabilities only from qualifying %s evidence) --> <!-- @test: src/__tests__/lib/bedrock-generic-contract.test.ts (REQ-ENTERPRISE-083: one positive Runtime prefix-read mapping enables checkpoints for the exact Native target) --> <!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (REQ-ENTERPRISE-083: enables Pi checkpoints only for the authorized native Runtime handle) -->
2. Startup and restart preserve the validated capability snapshot, including explicit empty revocation and opt-out for historical state without a capability field. <!-- @impl: src/container/container-env.ts::applyPrefsOnRestart --> <!-- @impl: src/container/container-router.ts::handleSetBucketName --> <!-- @test: src/__tests__/container/container-env.test.ts (REQ-ENTERPRISE-083: publishes and revokes opaque native cache capabilities on restart) --> <!-- @test: src/__tests__/container/container-router.test.ts (REQ-ENTERPRISE-083: persists native cache capabilities through the first-config receiver) --> <!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (REQ-ENTERPRISE-083: enables Pi checkpoints only for the authorized native Runtime handle) --> <!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (REQ-ENTERPRISE-083: rejects malformed cache-capability publication through guarded startup) -->
3. Runtime preserves allowed five-minute checkpoints at content and tool boundaries and rejects invalid or broadened controls before provider I/O. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::buildBedrockAnthropicRequest --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-083: preserves Pi checkpoints at native prefix boundaries without mutating input) --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-083: rejects malformed or broadened checkpoint semantics before provider I/O) -->
4. Checkpoint translation leaves client input and authentic stored assistant content unchanged; signed thinking is restored exactly and never decorated with cache controls. <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::assistantContent --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::buildBedrockAnthropicRequest --> <!-- @test: src/__tests__/lib/bedrock-anthropic-native-adapter.test.ts (REQ-ENTERPRISE-083: lifts a final Pi tool-result checkpoint without changing signed assistant replay) -->
5. Old adapter authority cannot activate a target until explicit contract-appropriate verification or reconfirmation issues current authority. <!-- @impl: src/lib/native-ai-targets.ts::nativeVerificationMatches --> <!-- @test: src/__tests__/lib/native-ai-targets.test.ts (REQ-ENTERPRISE-074: binds provider-native Bedrock profiles to the validated model, region, and transport) --> <!-- @test: src/__tests__/routes/bedrock-generic-upgrade.test.ts (upgrades one real old profile reference via explicit confirmation while retaining another disabled stale target) --> <!-- @test: src/__tests__/routes/bedrock-generic-upgrade.test.ts (certifies, saves and authorizes a synthetic future model through the existing workflow without authoring a profile) -->
6. Pi `cacheRetention: none` omits explicit checkpoints without promising that AWS implicit caching is disabled. <!-- @impl: entrypoint.sh::prompt_cache --> <!-- @test: scripts/verify-bedrock-pi-prompt-cache.mjs (REQ-ENTERPRISE-083: locked Pi preserves checkpoint opt-in, opt-out and exact replay) --> <!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (REQ-ENTERPRISE-083: enables Pi checkpoints only for the authorized native Runtime handle) -->
7. For discovered contracts and selected Dynamic provider-default checks, normal and Advanced verification correlate observed reasoning, tools/replay and any cache observations to one backend across retained mappings; distinct-backend inventory requires response identity even without cache evidence. <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility --> <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @test: src/__tests__/lib/bedrock-capability-discovery.test.ts (does not combine tool evidence from one observed branch with cache evidence from another) --> <!-- @test: src/__tests__/lib/bedrock-capability-discovery.test.ts (accepts Dynamic Gateway %s honestly, without native serialization or an all-branches gate) --> <!-- @test: src/__tests__/lib/target-capability-discovery.test.ts (qualifies token-backed reasoning with tools/cache only on the same backend ($sameBackend)) --> <!-- @test: src/__tests__/routes/target-capability-discovery.test.ts (requires response identities on a multi-backend route (identified: %s)) -->

**Constraints:**

- Cache experiments add no retry, delay, fallback, parser change, or all-branch probing. <!-- @impl: src/lib/reasoning-discovery.ts::discoverCache -->
- Native experiment pairs retain identical prefix and controls but different questions; Dynamic pairs remain identical. <!-- @test: src/__tests__/lib/bedrock-capability-discovery.test.ts (REQ-ENTERPRISE-083: changes only the user question in each Native Eventstream cache pair while preserving independent %s evidence) -->
- Gateway hits, synthetic counters, refused fills, and inconclusive observations grant no prefix permission. <!-- @impl: src/lib/native-ai-targets.ts::nativePromptCacheSupported -->
- Targets without permission remain usable; unauthorized checkpoints fail before inference.
- Refused cache fills do not submit paired reads. <!-- @impl: src/lib/reasoning-discovery.ts::discoverCache -->
- Invalid or duplicate capability handles are rejected.
- Reasoning length or token evidence may prove enabled reasoning without exposing content. <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility -->
- Enabled reasoning does not prove graduated fidelity.
- Only final tool-result text may lift to `tool_result`; invalid controls or excess checkpoints fail before I/O.
- Malformed cache responses stop discovery with sanitized diagnostics. <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility -->
- Replay, privacy, usage, and continuation follow [REQ-ENTERPRISE-073](#req-enterprise-073-provider-native-bedrock-replay-integrity), [REQ-ENTERPRISE-079](#req-enterprise-079-provider-native-bedrock-replay-confidentiality), [REQ-ENTERPRISE-058](#req-enterprise-058-native-model-container-publication), [REQ-ENTERPRISE-076](#req-enterprise-076-provider-native-bedrock-protocol-translation), and [REQ-ENTERPRISE-077](#req-enterprise-077-provider-native-bedrock-transport-dispatch).
- Five-minute retention is the only advertised TTL; transport, campaign, authority, and Dynamic routing remain unchanged.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-058](#req-enterprise-058-native-model-container-publication), [REQ-ENTERPRISE-074](#req-enterprise-074-provider-native-bedrock-target-identity), [REQ-ENTERPRISE-076](#req-enterprise-076-provider-native-bedrock-protocol-translation), [REQ-ENTERPRISE-079](#req-enterprise-079-provider-native-bedrock-replay-confidentiality)

**Verification:** Anchored behavioral fixtures and CI.

**Status:** Implemented

---

## Container publication and startup

### REQ-ENTERPRISE-005: Container-Side Enterprise Routing (CA Trust + Constant Base-URLs)

**Intent:** Agents in Enterprise Mode must be work-ready against the AI Gateway with zero manual login and zero injected credentials, so the container only learns it is in enterprise mode and configures itself to use the intercepted provider hosts.

**Applies To:** User

**Acceptance Criteria:**

1. Enterprise containers receive the active flag plus configured non-secret catalog, default, reasoning (including explicit empty reasoning), and context-window hints resolved from the session's first matching group or global fallback; gateway coordinates, credentials, and resolved model IDs remain absent. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (REQ-ENTERPRISE-005: enterprise env injection (flag-on emit)) --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (REQ-ENTERPRISE-005: emits an explicit empty reasoning hint for a provider-default enterprise snapshot) -->
2. When `ENTERPRISE_MODE=active`, the Cloudflare containers CA is installed into the system trust store and the Node/Python CA env vars are prepended to `.bashrc` so the PTY-spawned agent shells inherit them and all agent HTTPS clients trust the intercepted (TLS-terminated) connections. <!-- @impl: entrypoint.sh::CF_OAUTH_CA_SRC --> <!-- @test: host/__tests__/entrypoint-enterprise-ca-copilot.test.js (REQ-ENTERPRISE-005 AC2: NODE_EXTRA_CA_CERTS in .bashrc points at the CF_CA_SRC path) -->
3. Enterprise Copilot receives persistent-shell BYOK base URL, placeholder, default route, and prompt/output limits; startup overwrites stale defaults. It exposes only the default dynamic route, which maps on egress, and route changes require relaunch. <!-- @impl: entrypoint.sh::_merge_consult_llm_mcp --> <!-- @test: host/__tests__/entrypoint-enterprise-ca-copilot.test.js (REQ-ENTERPRISE-005 AC3: COPILOT_MODEL in .bashrc equals the ENTERPRISE_DEFAULT_ROUTE value) -->
4. The container never receives the AI Gateway URL, gateway token or mediated Gateway per-session secrets; routing to the gateway is done entirely by the DO's outbound interception ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)). <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (REQ-ENTERPRISE-005: enterprise env injection (flag-on emit)) -->
5. When `ENTERPRISE_MODE` is unset, `ENTERPRISE_MODE` is not emitted, no agent configuration block runs, and the container env is byte-identical to current behavior. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (REQ-ENTERPRISE-005: enterprise env injection (flag-on emit)) --> <!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (REQ-ENTERPRISE-005 AC5: outer Enterprise gate skips Pi provider config when mode is unset) -->
6. No mode receives AWS credentials. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (never emits AWS_* in enterprise; R2_* still emitted (rclone reads creds from rclone.conf)) --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (never emits AWS_* in non-enterprise either (dropped everywhere — no consumer); R2_* still emitted) -->
7. Pi authentication survives only for permitted human sessions under [REQ-ENTERPRISE-089](#req-enterprise-089-human-native-pi-startup); Operator isolation remains under [REQ-ENTERPRISE-091](#req-enterprise-091-operator-personal-provider-isolation). <!-- @impl: entrypoint.sh::ENTERPRISE_PI_PERSONAL_PROVIDERS --> <!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (REQ-ENTERPRISE-088 AC4: permitted startup preserves owner authentication and sanctioned models) -->

**Constraints:**

- The placeholder credential is a fixed non-secret constant; the interceptor strips it before forwarding ([REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC5), so it never reaches the gateway.
- `ENTERPRISE_MODE` rides the existing container env pipeline ([REQ-AGENT-031](agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity)); no per-agent login step is added.
- Route catalog, default, and reasoning values are non-secret container hints; slash-free handles map Worker-side, and backend keys remain in the gateway.
- Only the allowlisted enterprise agents ([REQ-ENTERPRISE-003](agents.md#req-enterprise-003-agent-allowlist-in-enterprise-mode)) are configured; `bash` needs no LLM configuration.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-ENTERPRISE-004](#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-007](#req-enterprise-007-gateway-route-pinning), [REQ-AGENT-031](agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity)

**Verification:** Automated test ([env-pipeline test](../../src/__tests__/container/container-env-llm.test.ts) (AC1/AC4/AC5 env injection; AC6 — no AWS_* in either mode; Enterprise credential mediation now belongs to REQ-ENTERPRISE-092); [Pi models.json build test](../../host/__tests__/entrypoint-enterprise-pi-models.test.js) (AC1 — per-route contextWindow; AC5 — inactive gate skips Pi provider config; AC7 — default-off auth clearing and permitted human auth retention under REQ-ENTERPRISE-089); [entrypoint CA-trust + Copilot BYOK test](../../host/__tests__/entrypoint-enterprise-ca-copilot.test.js) (AC2 — CA env prepended to .bashrc, idempotent, enterprise-gated; AC3 — Copilot BYOK vars + token-limit hints prepended, stale route overwritten on re-run, enterprise-gated). Named evidence is not final current-head execution.)

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

**Dependencies:** [REQ-ENTERPRISE-012](setup.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list), [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-031](#req-enterprise-031-enterprise-pi-capability-profile-administration)

**Verification:** Automated test ([Setup configure tests](../../src/__tests__/routes/setup-enterprise-groups.test.ts), [prefill tests](../../src/__tests__/routes/setup/handlers.test.ts), [setup store](../../web-ui/src/__tests__/stores/setup.test.ts), [ConfigureStep](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx), [container env fan](../../src/__tests__/container/container-env-llm.test.ts), and [entrypoint Pi models](../../host/__tests__/entrypoint-enterprise-pi-models.test.js).)

**Status:** Implemented

---

### REQ-ENTERPRISE-058: Native Model Container Publication

**Intent:** Containers receive authorized model identities with client hints distinct from backend executable capabilities.

**Applies To:** Container

**Acceptance Criteria:**

1. Session publication supplies route names, opaque native handles, safe display names, contexts, and selected-profile reasoning levels without exact native authority. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (REQ-ENTERPRISE-058: publishes opaque mixed and authoritative empty enterprise model snapshots) --> <!-- @test: preseed/agents/pi/test/enterprise-routing.test.mjs (REQ-ENTERPRISE-058: generated routing consumed by the pinned Pi runtime without inference) -->
2. Startup replaces prior managed Pi models and defaults with the authorized snapshot, including explicit empty resets. <!-- @impl: src/routes/container/lifecycle-init.ts::configureContainerDO --> <!-- @impl: src/container/container-env.ts::applyPrefsOnRestart --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (REQ-ENTERPRISE-058: publishes opaque mixed and authoritative empty enterprise model snapshots) --> <!-- @impl: entrypoint.sh::ENTERPRISE_ROUTE_CATALOG --> <!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (REQ-ENTERPRISE-058: complete enterprise Pi startup publication) -->
3. An empty enterprise catalog or failed Pi publication removes stale managed Pi configuration without altering unrelated providers and settings. <!-- @impl: entrypoint.sh::ENTERPRISE_ROUTE_CATALOG --> <!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (REQ-ENTERPRISE-058: authoritative empty enterprise catalog removes managed Pi and Copilot configuration) --> <!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (REQ-ENTERPRISE-058: complete enterprise Pi startup publication) -->
4. An explicit empty enterprise catalog removes managed Copilot configuration. <!-- @impl: entrypoint.sh::ENTERPRISE_ROUTE_CATALOG --> <!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (REQ-ENTERPRISE-058: authoritative empty enterprise catalog removes managed Pi and Copilot configuration) -->
5. Provider-default routes retain all seven Pi preferences without expanding canonical mappings. Explicit profiles publish only supported levels and aliases, including off-only profiles. Administrator context remains unchanged; all Native routes publish a 16,384-token output cap. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/lib/enterprise-route-config.test.ts (REQ-ENTERPRISE-058: publishes only the explicitly mapped discovered level while retaining Worker normalization) --> <!-- @impl: entrypoint.sh::ENTERPRISE_ROUTE_CATALOG --> <!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (REQ-ENTERPRISE-058: emits honest Pi metadata for a provider-default native model) --> <!-- @test: preseed/agents/pi/test/enterprise-routing.test.mjs (REQ-ENTERPRISE-058: provider-default Dynamic routes expose and preserve all seven Pi thinking choices) --> <!-- @test: preseed/agents/pi/test/enterprise-routing.test.mjs (REQ-ENTERPRISE-058: the real provider-default thinking selector renders and selects all seven choices) --> <!-- @test: preseed/agents/pi/test/enterprise-routing.test.mjs (REQ-ENTERPRISE-058: ${id === nativeHandle ? 'Native' : 'Dynamic'} mapped ${levels.join('/')} offers only supported Pi choices) --> <!-- @test: preseed/agents/pi/test/enterprise-routing.test.mjs (REQ-ENTERPRISE-058: Native provider-default offers seven choices without serializing an override) -->
6. Copilot uses the same opaque default with an output cap of 16,384 and a prompt limit bounded by the administrator context. <!-- @impl: entrypoint.sh::ENTERPRISE_ROUTE_CATALOG --> <!-- @test: host/__tests__/entrypoint-enterprise-ca-copilot.test.js (REQ-ENTERPRISE-058: bounds Copilot output for a provider-default native model) --> <!-- @test: host/__tests__/entrypoint-enterprise-ca-copilot.test.js (REQ-ENTERPRISE-058: derives bounded Copilot limits for an off-only native profile) -->
7. Container state omits exact native models, provider identity, credentials, aliases, and connection authority. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (REQ-ENTERPRISE-058: publishes opaque mixed and authoritative empty enterprise model snapshots) -->

**Constraints:**

- Container-visible state contains no account or gateway authority.
- Client thinking choices do not widen backend profile levels.
- Worker normalization for older clients remains unchanged: exact, next higher, then highest lower executable mapping. <!-- @test: preseed/agents/pi/test/enterprise-routing.test.mjs (serializes generated provider-default and native models before the network boundary) -->
- Provider-default sends no reasoning override.
- Pi publication stages models and defaults together and reports success only after application; failure keeps the container available. <!-- @impl: entrypoint.sh::ENTERPRISE_ROUTE_CATALOG --> <!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (REQ-ENTERPRISE-058: complete enterprise Pi startup publication) -->

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-049](#req-enterprise-049-unified-enterprise-model-authorization), [REQ-ENTERPRISE-053](#req-enterprise-053-native-target-identity-and-document)

**Verification:** Regression checkpoint `bef54164` failed in CI `34770156766`. Updated implementation and behavioral fixtures await exact-head CI; no deployed acceptance is claimed.

**Status:** Planned

---

<a id="req-enterprise-082-pi-native-model-display"></a>
### REQ-ENTERPRISE-082: Pi Gateway Model Display

**Intent:** Dynamic and native gateway models display their published route-category names without changing routing identity.

**Applies To:** User

**Acceptance Criteria:**

1. Pi's model picker displays published names for all `codeflare-gateway` models. <!-- @impl: scripts/patch-pi-native-model-display.mjs::patchPiNativeModelDisplay --> <!-- @test: preseed/agents/pi/test/enterprise-model-display.test.mjs (REQ-ENTERPRISE-082: Pi native model display) -->
2. Pi's model-thinking settings display those same published gateway names. <!-- @impl: scripts/patch-pi-native-model-display.mjs::patchPiNativeModelDisplay --> <!-- @test: preseed/agents/pi/test/enterprise-model-display.test.mjs (REQ-ENTERPRISE-082: Pi native model display) -->
3. Selecting or saving a named gateway model retains its provider/model routing identity, including opaque native IDs. <!-- @impl: scripts/patch-pi-native-model-display.mjs::patchPiNativeModelDisplay --> <!-- @test: preseed/agents/pi/test/enterprise-model-display.test.mjs (REQ-ENTERPRISE-082: Pi native model display) -->
4. Startup publishes `Dynamic Route - <route name>` and `Native Route - <native label>` without changing IDs; a trimmed user label takes precedence over the native model fallback. <!-- @impl: entrypoint.sh::PI_MODELS_JSON --> <!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (REQ-ENTERPRISE-058: complete enterprise Pi startup publication) --> <!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (REQ-ENTERPRISE-082: publishes a native ${scenario} without changing its handle) --> <!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (REQ-ENTERPRISE-082: an unowned native-shaped Dynamic route retains its published kind and identity) -->
5. Model-command status messages use the published gateway name. <!-- @impl: scripts/patch-pi-native-model-display.mjs::patchPiNativeModelDisplay --> <!-- @test: preseed/agents/pi/test/enterprise-model-display.test.mjs (REQ-ENTERPRISE-082: Pi native model display) -->
6. Picker selection, including saving the default, confirms the published gateway name. <!-- @impl: scripts/patch-pi-native-model-display.mjs::patchPiNativeModelDisplay --> <!-- @test: preseed/agents/pi/test/enterprise-model-display.test.mjs (REQ-ENTERPRISE-082: Pi native model display) -->
7. The local footer uses the same published gateway name. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::renderLine --> <!-- @test: src/__tests__/lib/local-statusline-repo.test.ts (REQ-ENTERPRISE-082: renders the published Dynamic Route name without changing its route identity) --> <!-- @test: src/__tests__/lib/local-statusline-repo.test.ts (REQ-ENTERPRISE-058: renders the enterprise native label without changing its opaque identity) -->

**Constraints:** Display substitution applies to all models under `codeflare-gateway`, not only native handles; unrelated providers retain their existing display and selection behavior.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-058](#req-enterprise-058-native-model-container-publication)

**Verification:** Regression checkpoint `bef54164` failed in CI `34770156766`. Updated implementation and behavioral fixtures await exact-head CI; no deployed acceptance is claimed.

**Status:** Planned

---

### REQ-ENTERPRISE-089: Human native Pi startup

**Intent:** Permitted humans retain native authentication alongside sanctioned models without treating startup hints as authority.

**Applies To:** User

**Acceptance Criteria:**

1. Trusted permitted human startup retains owner authentication. <!-- @impl: entrypoint.sh::ENTERPRISE_PI_PERSONAL_PROVIDERS --> <!-- @test: host/__tests__/entrypoint-enterprise-pi-models.test.js (REQ-ENTERPRISE-088 AC4: permitted startup preserves owner authentication and sanctioned models) -->
2. Pinned Pi exposes authenticated built-ins alongside unchanged sanctioned models. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: preseed/agents/pi/test/enterprise-routing.test.mjs (REQ-ENTERPRISE-088 AC4: pinned Pi retains native authenticated providers alongside sanctioned models) -->
3. Missing or malformed hints remain default off. <!-- @impl: entrypoint.sh::ENTERPRISE_PI_PERSONAL_PROVIDERS --> <!-- @manual -->
4. Warm internal configuration can emit or revoke the next-start hint. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-router.test.ts (REQ-ENTERPRISE-088 AC4: warm internal configuration emits and revokes the native Pi startup hint) -->

**Constraints:** Startup permission changes require container restart; request authorization never relies on picker state, and owner authentication follows the existing storage/governance regime.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-088](setup.md#req-enterprise-088-group-scoped-native-pi-providers)

**Verification:** Anchored startup, pinned-runtime and internal configuration tests; focused startup GREEN is historical, not final exact-head CI.

**Status:** Implemented

---

### REQ-ENTERPRISE-092: Mode-scoped platform credential delivery

**Intent:** Credential mediation and personal human authentication are distinct from mode-specific owner credential delivery.

**Applies To:** User

**Acceptance Criteria:**

1. Enterprise R2 and Browser credentials follow existing mediation rules rather than delivering real platform credentials. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (REQ-BROWSER-008: in enterprise emits ONLY the placeholder CLOUDFLARE_API_TOKEN, never a real token) --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (REQ-ENTERPRISE-016/021: strict egress + Governed Mode leaves CONTAINER_AUTH_TOKEN as the ONLY real secret) -->
2. Deployment tokens remain excluded from container delivery. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @manual -->
3. Non-enterprise retains owner-configured Cloudflare and provider credentials. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env-llm.test.ts (non-enterprise emits the real Connect-to-Cloudflare token + account id (byte-identical regression)) --> <!-- @manual -->

**Constraints:** The historical strict-egress/Governed fixture concerns mediated environment variables, not all human Pi authentication storage. Explicit personal permission remains default off and limited to bound human sessions under [REQ-ENTERPRISE-090](#req-enterprise-090-native-pi-forwarding-under-current-administration-permission); no platform credential exception or Operator privilege is introduced.

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-005](#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [REQ-ENTERPRISE-089](#req-enterprise-089-human-native-pi-startup), [REQ-ENTERPRISE-091](#req-enterprise-091-operator-personal-provider-isolation)

**Verification:** Adjacent environment-output tests prove the respective R2/Browser/owner-Cloudflare contracts. Deployment-token exclusion and owner-provider outcomes retain manual verification; current-head CI is pending. The historical capstone title is not universal human-auth evidence.

**Status:** Implemented
