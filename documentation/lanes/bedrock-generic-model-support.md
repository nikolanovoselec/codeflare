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

New native Anthropic Messages targets reuse `bedrock-anthropic-native-provider-default` revision 1. Its canonical hash comes from the existing profile registry; it has no per-model generated source or profile definition. The `anthropic.claude-*` namespace, optionally preceded by the supported geographic inference-profile prefix, only selects a protocol **candidate**. It does not assert availability, entitlement, reasoning, caching, or streaming support.

The existing native administration flow binds the exact authorized provider configuration, model, region, saved transport, profile hash, and adapter version. Model suggestions still come from active Dynamic Route inventory; administrators may enter a documented model identifier and context window. No new catalog service, AWS credentials, polling, or automatic startup probing is introduced. A model that rejects this Runtime Messages contract remains unusable through this adapter; selecting a familiar name never grants capabilities.

## Explicit discovery and qualification

<!-- @impl: src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities --> <!-- @impl: src/lib/reasoning-discovery.ts::discoverCache -->

The normal flow is now **Select target → Discover → review result → Save**. The dedicated [target capability component](target-capability-discovery.md) automatically chooses the shared contract, verifies it and attaches the existing server-issued receipt. The user does not select/name a profile or click a second Verify. Native automation is deliberately based on the observed Bedrock boundary; other native protocols retain their existing advanced workflow until a separate extension is implemented. Historical profile matching and selected-profile verification remain under Advanced.

For Native Runtime, this one explicit action uses the existing engine and adapter:

1. Send the existing Pi streaming function canary.
2. Replay its authentic provider tool turn and the fixed inert result through the same native adapter.
3. Submit a public approximately 60-KiB prefix with one five-minute checkpoint and a short requested answer.
4. Repeat that public cache request byte-identically and sequentially.

Native Runtime discovery uses at most four HTTP submissions, no fallback/retry, at most 2,048 output tokens per call and 90 seconds per call, with captures bounded to 8 MiB and the adapter's existing 2-MiB frame limit. The shared UI discloses the larger compatibility-search ceiling of 40 submissions and 10 minutes; native does not exhaust it speculatively. The public prefix is deliberately long but is not a tokenizer/minimum-prefix guarantee. An authentication, provider, malformed-stream, or invalid-tool failure stops the affected lifecycle; failed tools do not launch cache checks. A cache failure is reported, not retried with guessed parameters. Price depends on the configured model and input/cache/output usage; this is not a free check.

| Evidence | Meaning and authority |
| --- | --- |
| Valid tools + exact replay + positive second-request prefix-read counters without Gateway HIT | Minimum met; permits the target's native Pi checkpoint serialization |
| Valid tools + exact replay + Gateway HIT | Minimum met by whole-response reuse only; does not enable explicit native checkpoints |
| No hit / absent counters / rejected or capped cache probe | Inconclusive, minimum not met; not proof that caching is universally unsupported |
| Minimum + Provider default | Acceptable under the operator's chosen reasoning policy |
| Above + multiple cold public deltas observed over time before EOF | Optimal for the tested path and policy |

Success issues a server-held receipt containing a small capability summary, not executable browser-supplied mappings. Save and runtime authorization validate the current binding. A manually asserted generic receipt is rejected. Historical explicit administrator confirmation remains available only for the retained evidence-specific profiles and existing compatibility workflows; it is not an automated capability grade.

Discovery's identical cache pair certifies the measured reuse mechanism for that target. It is narrower than the prior live changed-answer tool-continuation prefix evidence. The actual locked Pi serializer and complete checkpoint/replay transformations are separately covered offline; future models are not claimed live-certified by synthetic tests.

## Reasoning semantics

<!-- @impl: src/lib/reasoning-profiles.ts::translateRuntimeReasoningRequest -->

The intended client contract retains all seven Pi preferences: Off, Minimal, Low, Medium, High, XHigh, Max. Provider-default models send **no client reasoning override**, regardless of that selection. This is neither fabricated Off nor proof that reasoning occurred. Zero executable effort mappings must not mean zero selectable Pi preferences.

**Checkpoint limitation (PR1086):** generated enabled contracts still publish only their tested level; [their seven-choice correction awaits behavioral RED](target-capability-discovery.md#evidence-and-qualification). Provider-default models already offer seven choices. Runtime normalization alone does not establish picker availability. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig -->

Existing Sonnet 5 and Opus 5 saved profiles retain validated disabled/adaptive mappings and aliases. Their exact evidence-model guards prevent a future name from inheriting these controls via a substring. Automatic Opus XHigh/Max still use Invoke; generic Provider default has no such mapped effort and uses Eventstream under auto. Explicit Invoke/Eventstream/compat authority remains unchanged.

AWS documents genuinely different budgeted, adaptive, and adaptive-only reasoning contracts. FoundationModelDetails exposes streaming metadata but not the complete effort/checkpoint/replay contract. Anthropic platform model metadata is not Bedrock transport/entitlement authority. Therefore this change does not guess a native effort vocabulary from the model name or automatically manufacture stronger control profiles. Unknown controls use the accepted provider-default baseline. A future authoritative Bedrock/Cloudflare capability contract is needed for automatic graduated controls beyond that baseline.

## Prompt-cache and replay boundary

<!-- @impl: src/lib/native-ai-targets.ts::nativePromptCacheSupported --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::assistantContent --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::adaptBedrockAnthropicResponse -->

Only a target with its own qualifying prefix evidence, or a retained validated historical native profile, publishes `cacheControlFormat: "anthropic"`. Gateway-HIT-only generic targets do not. The Worker independently rejects client checkpoints when that capability is absent. Dynamic targets never receive this serialization.

Existing five-minute allowlisting, maximum four checkpoints, tool-result marker lifting, uncached/read/write accounting, `cacheRetention: none` semantics, and lifecycle explicit-empty revocation remain intact. Missing optional counters stay unmeasured. Provider thinking is included in output usage exactly once.

Adapter v4 requires server-held authentic active tool state even when reasoning is omitted or disabled. Replay keys now include the verified connection/provider/model/region/profile/transport/adapter binding as well as existing user/session/target/tool isolation. This closes accidental cross-profile reuse. It does not expose bindings to Pi. Authentic assistant blocks remain unchanged, encrypted with the existing 30-day/64-KiB bounds. Historical completed foreign turns retain the established classification rules.

Known native stop reasons map explicitly (`tool_use`→`tool_calls`, `end_turn`/`stop_sequence`→`stop`, `max_tokens`→`length`, `refusal`→`content_filter`). Unknown or missing stop reasons fail closed. Eventstream requires message start, valid framing, terminal stop/message, clean EOF, and required replay persistence before success. Public text can arrive earlier; no character timer or paid fallback is added.

## Dynamic remains a separate transport

<!-- @impl: src/lib/ai-capability-discovery/index.ts::capabilityCandidates --> <!-- @impl: src/lib/ai-capability-discovery/compatibility-wire.ts::compatibilityResponse -->

The reusable `dynamic-bedrock-anthropic-provider-default` contract remains for old assignments. Normal Dynamic **Discover** now automatically tests shared OpenAI wire forms and returns a canonical content-addressed configuration with target-bound evidence, not a profile shopping list. The existing narrow complete-name repair and a bounded buffered alternative live behind the shared compatibility boundary. Reasoning, tools/replay and cache must not report conflicting observed backends. Missing Gateway backend headers are recorded as unobserved; multi-distinct-backend certification cannot invent selection from inventory. This certifies the exercised route path only, not every conditional/fallback branch. Operators remain responsible for mixing compatible branches until Cloudflare normalizes them.

The existing broad profile-matching scan is now an Advanced compatibility workflow; its separate Verify step is not the normal user flow. Existing explicit administrator-confirmed Dynamic assignments remain distinctly labelled rather than silently revoked by this new grade. A newly discovered contract cannot use administrator assertion to bypass the cache/tools minimum.

Native success does not repair Dynamic input caching. Earlier array-valued cache-marked system prompts failed integrity canaries; other tested Dynamic shapes produced no positive prefix evidence. Keep Dynamic system content string-valued, do not add native checkpoints or cache headers/keys/TTLs. Gateway HIT can satisfy the relaxed minimum, but enabling Dynamic prefix serialization still requires preserved input semantics and positive changed-answer prefix-read evidence through that exact converter. This remains an external limitation.

The subsequent 2026-09-13 live campaign qualified all four tested targets as **Optimal**: Native Sonnet/Opus showed positive prefix reads; Dynamic Sonnet/Opus showed Gateway MISS → HIT. All passed tools/replay and cold public streaming under the existing request-only DLP policy. The exact calls and limits are in the new Downloads handoff. These observations correct the earlier absence of current Dynamic cache certification, without turning Gateway HIT into prefix-cache evidence or claiming a deployed application test.

## Upgrade and next-start behavior

<!-- @impl: src/lib/native-ai-targets.ts::nativeVerificationMatches --> <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig -->

Keep the original three feature commits in order. Apply the generic changes together with their tests and CI step. No main backport, provider migration, or deploy is implied.

Old v1/v2/v3 receipts and profile references remain readable but do not authorize v4. Reconfirm a retained evidence-specific profile through the Advanced workflow, or simply **Discover** the target to select and verify reusable handling automatically. A stale historical profile can remain byte-identical and disabled while another target is upgraded; editing or enabling it requires a current canonical profile. No fabricated receipt, automatic rewrite, or recurring per-release profile authoring is required.

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
