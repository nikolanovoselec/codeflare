# Generic Anthropic Bedrock model support

**Audience:** Operators, Developers

**Owns:** the reusable native Bedrock contract, reasoning semantics, target authority, and upgrades. **Does not own:** model availability, discovery UI details, historical probe ledgers, or deployment acceptance.

## Contents

- [Contract, not a model-release checklist](#contract-not-a-model-release-checklist)
- [Explicit discovery and qualification](#explicit-discovery-and-qualification)
- [Reasoning semantics](#reasoning-semantics)
- [Prompt-cache and replay boundary](#prompt-cache-and-replay-boundary)
- [Dynamic remains a separate transport](#dynamic-remains-a-separate-transport)
- [Upgrade and next-start behavior](#upgrade-and-next-start-behavior)
- [Verification and references](#verification-and-references)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

## Contract, not a model-release checklist

<!-- @impl: src/lib/native-ai-target-draft.ts::bedrockAnthropicCandidate --> <!-- @impl: src/lib/native-ai-targets.ts::nativeVerificationMatches -->

New native Anthropic Messages targets discover reusable audited mappings in `bedrock-anthropic-native-discovered-<24hex>` revisions, content-addressed through the existing canonical custom-profile machinery. Provider-default revision 1 is the exclusive fallback if no configurable form qualifies. No per-model generated source or profile definition is needed. The `anthropic.claude-*` namespace, optionally preceded by the supported geographic inference-profile prefix, only selects a protocol **candidate**. It does not assert availability, entitlement, reasoning, caching, or streaming support.

The existing native administration flow binds the exact authorized provider configuration, model, region, saved transport, profile hash, and adapter version. Model suggestions still come from active Dynamic Route inventory; administrators may enter a documented model identifier and context window. No new catalog service, AWS credentials, polling, or automatic startup probing is introduced. A model that rejects this Runtime Messages contract remains unusable through this adapter; selecting a familiar name never grants capabilities.

## Explicit discovery and qualification

<!-- @impl: src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities --> <!-- @impl: src/lib/reasoning-discovery.ts::discoverCache -->

The normal flow is now **Select target → Discover → review result → Save**. The dedicated [target capability component](target-capability-discovery.md) automatically chooses the shared contract, verifies it and attaches the existing server-issued receipt. The user does not select/name a profile or click a second Verify. Native automation is deliberately based on the observed Bedrock boundary; other native protocols retain their existing advanced workflow until a separate extension is implemented. Historical profile matching and selected-profile verification share **Advanced: choose a profile**. Discovery and verification report to one visible **Check result** above it, with technical evidence collapsed. Success directs the operator through **Review changes → Confirm Save → next normal session start**; a recheck clears the old result and receipt immediately.

For Native Runtime, one explicit action uses the existing engine and adapter:

1. Test disabled, adaptive Low, Medium, High, XHigh and Max as six distinct audited forms.
2. For each form, observe reasoning and complete its own Pi function call plus authentic inert-result replay.
3. After completed tools/replay, measure optional input caching with a public approximately 60-KiB prefix, one five-minute checkpoint and a byte-identical sequential repeat. Do not send a read after an invalid fill.
4. Assemble successful forms and Minimal→Low only if Low passed. Use Provider default only when no configurable form qualifies.

Native discovery uses at most 34 HTTP submissions under one 40-submission/10-minute campaign, 2,048 output tokens per call and 90 seconds per call. Six five-call forms plus at most four Provider-default calls bound the campaign; aliases add no calls. Saved transport is exercised, not multiplied into a cross-product. Captures remain bounded to 8 MiB and native frames to 2 MiB. No retries or speculative model substitution occur. The public prefix is not a tokenizer/minimum-prefix guarantee.

An authentication, provider, malformed-stream, or invalid-tool failure stops the affected lifecycle; failed tools do not launch cache checks. A cache failure is reported, not retried with guessed parameters. A refused cache-fill response retains observed cache counters and the unattempted-read distinction without granting cache permission or erasing completed tools/replay. Fatal authentication, quota, server, framing, transport and timeout failures still withhold a fresh receipt. A native-shaped buffered Dynamic envelope remains rejected with an unexpected-format diagnostic and HTTP/transport context, not a transport-error label. Price depends on the configured model and input/cache/output usage; this is not a free check.

| Capability | Meaning and authority |
| --- | --- |
| Tool calling | Complete tools and exact replay on every included mapping are required for receipt eligibility |
| Reasoning | Actual levels/aliases, verified disabled, accepted-unverified, or Provider default; no inferred effort strength |
| Streaming | Incremental cold public deltas before EOF, or buffered/not established, per mapping/operation |
| Input caching | Positive provider-prefix read, not observed, or not tested; optional for activation |

Gateway HIT remains whole-response reuse, never input-prefix proof. Each v2 row binds exact levels and transport to the returned canonical profile through server-owned evidence. No current grade or cumulative capability threshold is published.

Success issues a server-held receipt containing a small capability summary, not executable browser-supplied mappings. Save and runtime authorization validate the current binding. A manually asserted generic receipt is rejected. Historical explicit administrator confirmation remains available only for the retained evidence-specific profiles and existing compatibility workflows; it is not automated capability evidence.

Discovery's identical cache pair certifies the measured reuse mechanism for that target. It is narrower than the prior live changed-answer tool-continuation prefix evidence. The actual locked Pi serializer and complete checkpoint/replay transformations are separately covered offline; future models are not claimed live-certified by synthetic tests.

## Reasoning semantics

<!-- @impl: src/lib/reasoning-profiles.ts::translateRuntimeReasoningRequest -->

Dynamic Provider-default and discovered normalized contracts retain all seven Pi preferences: Off, Minimal, Low, Medium, High, XHigh, Max. Native configurable discoveries instead expose their actual successful levels and explicit aliases. Provider-default models send **no client reasoning override**, regardless of that selection. This is neither fabricated Off nor proof that reasoning occurred. Zero executable effort mappings must not mean zero selectable Pi preferences.

Dynamic generated single-mapping contracts retain seven client choices without expanding canonical mappings or receipts; all choices normalize to the one tested mapping. Provider-default permits an Off default preference with a visible no-override/provider-controlled caveat, not a disabled claim. Verified literal native Off requires a completed private observation of absent thinking, including hidden/redacted blocks even when counters are absent. Selected supported Off persists through review, save, reload and startup. Historical profiles remain unchanged. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig -->

Existing Sonnet 5 and Opus 5 saved profiles retain validated disabled/adaptive mappings and aliases. Their exact evidence-model guards prevent a future name from inheriting these controls via a substring. Automatic Opus XHigh/Max still use Invoke; generic Provider default has no such mapped effort and uses Eventstream under auto. Explicit Invoke/Eventstream/compat authority remains unchanged.

AWS documents distinct budgeted, adaptive and adaptive-only contracts. FoundationModelDetails streaming metadata is not complete effort/checkpoint/replay authority. The six audited request forms are candidates, not model-name capability claims. Each retained mapping requires its own complete lifecycle; failed forms and dangling aliases are excluded. Accepted controls without observable thinking remain unverified as reasoning. No Max→Medium or unfamiliar-model Sonnet alias is fabricated.

Discovery and runtime build the mapped native request and validate replay before choosing operation. Auto uses Eventstream through mapped High and Invoke for mapped XHigh/Max; explicit transports never change. Per-level results preserve High incremental delivery alongside upper-level buffered Invoke evidence. Private thinking-presence/completion observations expose no text, signatures or invented counters.

## Prompt-cache and replay boundary

<!-- @impl: src/lib/native-ai-targets.ts::nativePromptCacheSupported --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::assistantContent --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::adaptBedrockAnthropicResponse -->

At least one positive provider-prefix observation may authorize model-wide `cacheControlFormat: "anthropic"` only for that exact receipt-bound target; retained validated historical authority keeps its original rules. No positive mapping, Gateway-HIT-only evidence, and inconclusive observations remain insufficient. Per-level UI facts must not imply permission for another target. The Worker independently rejects client checkpoints when that capability is absent. Dynamic targets never receive this serialization.

Existing five-minute allowlisting, maximum four checkpoints, tool-result marker lifting, uncached/read/write accounting, `cacheRetention: none` semantics, and lifecycle explicit-empty revocation remain intact. Missing optional counters stay unmeasured. Provider thinking is included in output usage exactly once.

Adapter v5 requires server-held authentic active tool state even when reasoning is omitted or disabled. Replay keys include the verified connection/provider/model/region/profile/transport/adapter binding as well as existing user/session/target/tool isolation. Completed foreign historical tool pairs are deterministically aliased only when their IDs violate the Anthropic Messages alphabet; authentic active blocks remain unchanged. This closes accidental cross-profile reuse without exposing bindings to Pi. Authentic assistant blocks remain encrypted with the existing 30-day/64-KiB bounds.

Known native stop reasons map explicitly (`tool_use`→`tool_calls`, `end_turn`/`stop_sequence`→`stop`, `max_tokens`→`length`, `refusal`→`content_filter`). Unknown or missing stop reasons fail closed. Eventstream requires message start, valid framing, terminal stop/message, clean EOF, and required replay persistence before success. Public text can arrive earlier; no character timer or paid fallback is added.

## Dynamic remains a separate transport

<!-- @impl: src/lib/ai-capability-discovery/index.ts::capabilityCandidates --> <!-- @impl: src/lib/ai-capability-discovery/compatibility-wire.ts::compatibilityResponse -->

The reusable `dynamic-bedrock-anthropic-provider-default` contract remains for old assignments. Normal Dynamic **Discover** now automatically tests shared OpenAI wire forms and returns a canonical content-addressed configuration with target-bound evidence, not a profile shopping list. The existing narrow complete-name repair and a bounded buffered alternative live behind the shared compatibility boundary. Reasoning, tools/replay and cache must not report conflicting observed backends. Missing Gateway backend headers are recorded as unobserved; multi-distinct-backend certification cannot invent selection from inventory. This certifies the exercised route path only, not every conditional/fallback branch. Operators remain responsible for mixing compatible branches until Cloudflare normalizes them.

The existing broad profile-matching scan is now an Advanced compatibility workflow; its separate Verify step is not the normal user flow. Existing explicit administrator-confirmed Dynamic assignments remain distinctly labelled rather than silently revoked by the independent-capability contract. A newly discovered contract cannot use administrator assertion or a generated namespace to bypass exact tools/replay and receipt authority.

Native success does not repair Dynamic input caching. Earlier array-valued cache-marked system prompts failed integrity canaries; other tested Dynamic shapes produced no positive prefix evidence. Keep Dynamic system content string-valued, do not add native checkpoints or cache headers/keys/TTLs. Gateway HIT is only whole-response evidence; enabling Dynamic prefix serialization still requires preserved input semantics and positive changed-answer prefix-read evidence through that exact converter. This remains an external limitation.

The historical 2026-09-13 live campaign recorded all four tested targets as **Optimal** under the now-retired grading definition: Native Sonnet/Opus showed positive prefix reads; Dynamic Sonnet/Opus showed Gateway MISS → HIT. All passed tools/replay and cold public streaming under the existing request-only DLP policy. The exact calls and limits are in the new Downloads handoff. These observations correct the earlier absence of current Dynamic cache certification, without turning Gateway HIT into prefix-cache evidence or claiming a deployed application test.

## Upgrade and next-start behavior

<!-- @impl: src/lib/native-ai-targets.ts::nativeVerificationMatches --> <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig -->

Keep the original three feature commits in order. Apply the generic changes together with their tests and CI step. No main backport, provider migration, or deploy is implied.

Historical native adapter v1/v2/v3/v4 receipts and profile references remain readable but do not authorize adapter v5. Nested capability evidence v2 changes no outer document version. Strict legacy capability-v1 parsing preserves its original qualification rules: formerly ineligible evidence gains no authority, and load/rebind never upgrades evidence or coverage. Reconfirm a retained evidence-specific profile through the Advanced workflow, or simply **Discover** the target to select and verify reusable handling automatically. A stale historical profile can remain byte-identical and disabled while another target is upgraded; editing or enabling it requires a current canonical profile. No fabricated receipt, automatic rewrite, or recurring per-release profile authoring is required.

After review and Save, normal next session/container start publishes current opaque model capabilities. No hot process mutation, restart, or forced reset is introduced. Before production adoption, the integrating agent still owns CI/review, deployment, and authorized deployed Worker/session/Pi acceptance.

## Verification and references

Synthetic future-name regressions cover the real admin endpoint → server-issued receipt → Save validation → authorization → Pi publication and interceptor dispatch. They prove absence of release-name coupling, not availability of an unreleased model. Real historical profile hashes exercise collection-level upgrading. Temporal tests withhold later text/stop/EOF while requiring the first public delta. Existing provider, lifecycle, replay, and checkpoint regressions remain in scope.

The existing CI `pi-prompt` lane now executes `scripts/verify-bedrock-pi-prompt-cache.mjs` against its already installed locked Pi 0.85.1 package. It injects every HTTP response, uses unmistakably synthetic private blocks, and makes zero network calls. No dependency upgrade or separate framework was added.

Official documentation accessed 2026-09-13:

- [AWS FoundationModelDetails](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_FoundationModelDetails.html): metadata scope.
- [AWS model availability](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetFoundationModelAvailability.html): separate account/region authorization status.
- [AWS Anthropic Messages](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages.html): native protocol.
- [AWS adaptive thinking](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html): differing reasoning contracts.
- [AWS prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html): model-dependent thresholds and cache semantics.
- [Cloudflare Bedrock forwarding](https://developers.cloudflare.com/ai-gateway/usage/providers/bedrock/): Runtime BYOK and separate compatibility paths.
- [Cloudflare Dynamic usage](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/usage/): selected-backend headers.
- [Cloudflare caching](https://developers.cloudflare.com/ai-gateway/features/caching/): whole-response reuse, distinct from provider input caching.

## Requirement and Source Map

| Section / contract | Requirement | Primary source symbols |
|---|---|---|
| Reusable identity and reasoning | [REQ-ENTERPRISE-072](../../sdd/spec/enterprise-mode.md#req-enterprise-072-provider-native-bedrock-reasoning-profiles), [REQ-ENTERPRISE-074](../../sdd/spec/enterprise-mode.md#req-enterprise-074-provider-native-bedrock-target-identity) | `src/lib/reasoning-profiles.ts::translateRuntimeReasoningRequest`, `src/lib/native-ai-targets.ts::nativeVerificationMatches` |
| Explicit discovery and Dynamic separation | [REQ-ENTERPRISE-035](../../sdd/spec/enterprise-mode.md#req-enterprise-035-enterprise-pi-protocol-match-selection), [REQ-ENTERPRISE-075](../../sdd/spec/enterprise-mode.md#req-enterprise-075-provider-native-bedrock-administration-authority) | `src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities`, `capabilityCandidates` |
| Checkpoints and replay | [REQ-ENTERPRISE-083](../../sdd/spec/enterprise-mode.md#req-enterprise-083-native-bedrock-prompt-cache-checkpoints), [REQ-ENTERPRISE-073](../../sdd/spec/enterprise-mode.md#req-enterprise-073-provider-native-bedrock-replay-integrity), [REQ-ENTERPRISE-079](../../sdd/spec/enterprise-mode.md#req-enterprise-079-provider-native-bedrock-replay-confidentiality) | `src/lib/native-ai-targets.ts::nativePromptCacheSupported`, `src/lib/bedrock-anthropic-native-adapter.ts::assistantContent` |
| Transport and terminal success | [REQ-ENTERPRISE-077](../../sdd/spec/enterprise-mode.md#req-enterprise-077-provider-native-bedrock-transport-dispatch), [REQ-ENTERPRISE-080](../../sdd/spec/enterprise-mode.md#req-enterprise-080-provider-native-bedrock-stream-completion) | `src/lib/bedrock-anthropic-native-adapter.ts::selectBedrockAnthropicTransport`, `adaptBedrockAnthropicResponse` |
| Upgrade and publication | [REQ-ENTERPRISE-058](../../sdd/spec/enterprise-mode.md#req-enterprise-058-native-model-container-publication), [REQ-ENTERPRISE-083](../../sdd/spec/enterprise-mode.md#req-enterprise-083-native-bedrock-prompt-cache-checkpoints) | `src/lib/native-ai-targets.ts::nativeVerificationMatches`, `src/lib/access.ts::loadEnterpriseRouteConfig` |

## Related Documentation

- [Target capability discovery](target-capability-discovery.md)
- [Bedrock prompt caching](bedrock-prompt-caching.md)
- [Administration and historical usage](administration-analytics.md#enterprise-capability-profiles)
