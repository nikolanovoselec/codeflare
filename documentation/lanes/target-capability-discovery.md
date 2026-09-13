# Target capability discovery

**Audience:** Operators, Developers

**Owns:** explicit target discovery, shared contract selection, evidence grades, campaign bounds, and diagnostic limitations. **Does not own:** provider availability, access policy, cache policy, or deployed acceptance.

## Contents

- [Normal administrator flow](#normal-administrator-flow)
- [Dedicated boundary](#dedicated-boundary)
- [Contracts, not a model list](#contracts-not-a-model-list)
- [Evidence and qualification](#evidence-and-qualification)
- [Bounds and security](#bounds-and-security)
- [Evidence and remaining boundaries](#evidence-and-remaining-boundaries)
- [Authoritative references](#authoritative-references)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

## Normal administrator flow

<!-- @impl: src/routes/admin/ai-capability-discovery.ts::routes --> <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields -->

1. Select a gateway-owned Dynamic Route, or select the configured Amazon Bedrock provider and enter/select its exact authorized model, region and context window.
2. Click **Discover**. No profile selection, naming, JSON editing or separate Verify action is required.
3. Review the automatically selected working configuration, its evidence grade and any limitations. Assign access/fallback policy and use the existing reviewed **Save** to enable it.
4. After a route/model/binding change, Discover again. The application reuses protocol handling; the operator does not write another profile for a model release.

Discover changes only the local draft and issues a temporary server-held receipt. It does not enable targets, change Gateway resources or modify a running session. Normal next container/session start publishes saved capabilities to Pi. Inventory loading and startup never run inference automatically.

Manual profile selection, the older profile-matching editor, selected-profile verification and eligible historical administrator confirmation remain under **Advanced**. They are retained compatibility tools, not the normal discovery flow. Other native protocols retain their existing advanced workflow. Native automatic discovery currently supports the observed **Bedrock** boundary only; Azure or another native protocol needs a deliberate adapter extension, not a guessed URL or request form.

## Dedicated boundary

| Owner | Responsibility |
| --- | --- |
| `src/lib/ai-capability-discovery/index.ts` | Finite protocol search, automatic contract selection, campaign budget, exercised-backend correlation |
| `src/lib/ai-capability-discovery/contract.ts` | Shared sanitized result, grades and qualification predicate; no browser authority |
| `src/lib/ai-capability-discovery/compatibility-wire.ts` | Shared discovery/runtime OpenAI streaming-or-buffered boundary |
| `src/lib/reasoning-discovery.ts` | Existing Pi canary, replay, bounded parser, cache measurements and sanitized diagnostics |
| `src/lib/bedrock-anthropic-native-adapter.ts` | Existing native Messages/Invoke/Eventstream translation and private replay state |
| `src/routes/admin/ai-capability-discovery.ts` | Admin/rate limit, gateway/provider authorization, inventory before/after, existing server receipt issuance |
| `web-ui/src/components/admin/TargetCapabilityDiscovery.tsx` | Discover action and evidence display only |
| `AiRoutingFields.tsx` / existing Save and access modules | Exact draft adoption, stale-result rejection, reviewed persistence and runtime authorization |

The component is not a second routing architecture, catalog service, background poller or per-model profile generator. Existing authorization, assignments, configuration documents, lifecycle propagation and Pi publication remain authoritative.

## Contracts, not a model list

<!-- @impl: src/lib/ai-capability-discovery/index.ts::capabilityCandidates --> <!-- @impl: src/lib/ai-capability-discovery/compatibility-wire.ts::compatibilityResponse -->

Native Anthropic Messages uses the existing shared `bedrock-anthropic-native-provider-default` revision 1 and native adapter v4. The model namespace is a protocol candidate only: actual availability, entitlement and usable wire behavior must be established for the selected target. Discovery never substitutes the model, provider binding, region or saved transport. Existing Invoke or compat selections are not silently changed to Eventstream.

Dynamic and direct-Bedrock compatibility candidates are content-addressed **shared request forms**. The finite search begins with Provider default, then the already audited normalized enabled request forms from OpenAI, Workers AI and Mesh. Equivalent forms are deduplicated; each is tested with streaming first and bounded completed JSON second. These are potential wire forms, not assertions about the selected model. Native controls are not copied into Dynamic requests. Search stops at the first qualifying configuration, respecting the user's priority of tools/replay and cache ahead of reasoning-level fidelity or streaming.

The canonical custom revision ID is `discovered-<24 hex characters>`, derived from its semantic mapping and bounded wire contract. The same contract is reused across model/route names; adding a marketing name does not add code, a profile definition or another candidate. Verification remains target-specific, never a globally verified shared profile. This is automatic contract construction/selection, not a list asking the user to select and verify a profile.

New compatibility contracts explicitly bind `/compat/chat/completions`, as currently documented for Dynamic Routing. The saved contract is used identically by discovery and dispatch, including stream mode and narrow complete-tool-name repair. Historical assignments retain their existing REST-first/404 fallback behavior. No broad paid retry is introduced.

For a buffered contract, the Worker validates completed OpenAI JSON and sends one SSE chunk plus `[DONE]` to a streaming Pi client. It preserves tool IDs and argument strings at that boundary; it never claims incremental generation. A native Anthropic envelope cannot be passed off as OpenAI JSON. No signed native state is reconstructed from client assertions.

## Evidence and qualification

<!-- @impl: src/lib/ai-capability-discovery/contract.ts::capabilityMinimum --> <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility --> <!-- @impl: src/lib/reasoning-discovery.ts::discoverCache -->

| Grade | Required observation |
| --- | --- |
| Minimum | Valid tool call and exact tool-result lifecycle, plus positive provider prefix-cache read **or Gateway HIT** |
| Acceptable | Minimum plus Provider-default policy, or visible reasoning output / positive structured reasoning-token evidence under the tested normalized mapping |
| Optimal | Acceptable plus multiple public deltas spread over time before EOF, excluding cached delivery, native Invoke and synthesized buffered SSE |
| Not qualified | Minimum not established; no discovery receipt/enablement |

Gateway HIT satisfies the explicitly agreed relaxed cache threshold, but remains **whole-response reuse**, not input-prefix evidence. Only positive target-bound native prefix evidence enables that target's `cacheControlFormat: "anthropic"`. Dynamic never receives native cache serialization. Missing counters, misses, truncation, refusals and failed probes are inconclusive where they do not establish protocol rejection. HTTP/provider error codes and the failed stage are shown without provider messages/bodies.

Tools/replay are checked before the cache pair. One fresh public marker is reused in two identical sequential cache requests; no custom keys, TTL overrides, purges or sharing changes are made. The roughly 60-KiB public prefix is intentionally bounded, but its model token count is not assumed (the current live Claude samples used about 29.8k cached-prefix tokens). Each native request uses only the existing supported five-minute checkpoint translation. This repeated-request measurement is narrower than changed-answer prefix reuse; the prior live report covers that stronger native experiment.

Evidence qualifies only the exercised Dynamic branch. Different **known** backends cannot contribute reasoning, tools/replay and cache to one imaginary result. A multi-distinct-backend route needs the selected provider/model response identity to correlate its observations; absent identity is inconclusive, not an all-branches test. Other branches remain explicitly unverified and must be configured compatibly by the operator until Cloudflare provides post-selection normalization.

The intended client contract keeps all seven Pi preferences selectable; Provider default sends no reasoning override and does not assert Off, visible thinking, or graduated effort. A discovered normalized enabled form maps every preference to that one evidenced form; it does not claim seven controls. Existing evidence-specific Sonnet/Opus native profiles keep their validated disabled/adaptive mappings and aliases. The old automatic Opus XHigh/Max Invoke rule is not imposed on future model names.

**Checkpoint limitation (PR1086):** generated enabled contracts still publish only their tested level. Their seven-choice publication awaits the corrected test's behavioral RED; provider-default models already offer seven choices. Worker normalization alone does not prove picker availability. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @impl: src/lib/reasoning-profiles.ts::translateRuntimeReasoningRequest -->

## Bounds and security

<!-- @impl: src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities --> <!-- @impl: src/routes/admin/ai-capability-discovery.ts::routes --> <!-- @impl: src/lib/native-ai-targets.ts::nativeVerificationMatches -->

An explicit Discover is bounded at **40 HTTP submissions**, 2,048 output tokens each, 90 seconds per request and 10 minutes overall. The complete current search needs at most 38 submissions; ordinary Provider-default success uses four, including native Runtime success. Limits do not grow with the catalog. There are no automatic retries, model substitutions or real tool executions. Authentication, rate-limit, provider/server, malformed-stream and timeout boundaries stop further probing; a specific validation incompatibility may allow the next supported contract. Tests are not promised free; input/cache/output usage is billed by the configured provider.

Response acquisition and reads are bounded. Discovery captures are capped at 8 MiB, native frames retain the existing 2-MiB bound, and required replay state remains encrypted with the existing 64-KiB/30-day limits. Discovery state is ephemeral and cleared; generated content, private thinking, signature values and provider credentials are not returned. Ordinary runtime state remains isolated by user/session/target/tool and exact verified connection/provider/model/region/profile/transport/adapter identity.

Requests use only server-constructed gateway paths and authenticated provider inventory. The browser cannot submit a provider credential identifier, alias, arbitrary endpoint/header, native protocol guess or fabricated grade to gain authority. Compatibility mutations are bounded enum fields included in the canonical hash. Save requires the existing server-issued receipt and current inventory/binding. A discovered profile cannot be administrator-confirmed past a failed minimum. Stale saved documents stay readable; they cannot silently become current evidence.

## Evidence and remaining boundaries

2026-09-13 direct-Gateway validation used the new component with the local native adapter: four calls each for Native Sonnet 5, Native Opus 5, Dynamic `bedrock_sonnet` and Dynamic `bedrock_opus`. All passed tools/replay, Provider default and incremental cold delivery. Native repeated requests read 29,783 and 29,782 cached prefix tokens respectively while Gateway remained MISS. Dynamic repeated requests produced Gateway MISS → HIT without positive provider-prefix counters. All four qualify as Optimal under the agreed definition; this is **not** certification of native graduated reasoning, Dynamic prefix caching, every Dynamic branch or deployed Worker/session/UI behavior. Before/after management projections retained the same route versions, Bedrock binding and cache/DLP policy. No configuration was changed.

Offline regressions exercise unfamiliar synthetic model names through discovery → receipt → Save → authorization, shared runtime parity, temporal streaming before withheld stop/EOF, old-document upgrades, opt-out/empty revocation and the actual locked Pi 0.85.1 serializer/parser. Synthetic fixtures prove generic behavior, not that an unreleased model exists. The existing CI Pi lane runs `scripts/verify-bedrock-pi-prompt-cache.mjs`; no CI/deployment was dispatched by this diagnostic task.

An additional ten live submissions used **actual local Pi 0.85.1**, its real OpenAI serializer/parser, the discovered contracts and this branch's local translation boundary. Both Dynamic Routes and Native Sonnet passed their complete two-call lifecycles. Native Sonnet's changed-answer continuation read 30,256 cached prefix tokens.

Native Opus's first replay returned HTTP 200, positive prefix reuse and public text but ended with Pi `error`. Its original raw terminal reason was not captured; the error remains unresolved. A separate two-call diagnostic with a simpler public instruction passed unchanged model/transport/exact replay and read 30,200 cached tokens. That later pass is neither a fix nor an explanation of the original error.

All four have successful real-Pi samples; universal prompt/model reliability and deployed-session acceptance are not claimed. Total fresh inference in that diagnostic task: 26 submissions, with no automatic retries or resource mutations.

Adoption: retain all prior feature commits, integrate the complete feature on develop with review/CI, explicitly Discover affected targets and review/Save, then exercise normal next-start deployed sessions. No push, deployment, forced restart or silent migration is part of this handoff. See the sanitized Downloads handoff for commit/test/request ledgers.

## Authoritative references

Accessed 2026-09-13. Documentation establishes contracts, not live capability of an arbitrary model.

- [Cloudflare chat completion / Dynamic compatibility endpoint](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/).
- [Cloudflare Bedrock forwarding](https://developers.cloudflare.com/ai-gateway/usage/providers/bedrock/).
- [Cloudflare Dynamic selected-backend headers](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/usage/).
- [Cloudflare whole-response caching](https://developers.cloudflare.com/ai-gateway/features/caching/).
- [AWS Anthropic Messages](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages.html).
- [AWS prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html): model-dependent thresholds and best-effort reuse.
- [AWS adaptive thinking](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html).
- [AWS FoundationModelDetails](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_FoundationModelDetails.html): a streaming flag is not complete reasoning/cache/replay metadata.

## Requirement and Source Map

| Section / contract | Requirement | Primary source symbols |
|---|---|---|
| Normal flow and retained Advanced | [REQ-ENTERPRISE-034](../../sdd/spec/enterprise-mode.md#req-enterprise-034-enterprise-pi-route-administration), [REQ-ENTERPRISE-075](../../sdd/spec/enterprise-mode.md#req-enterprise-075-provider-native-bedrock-administration-authority) | `src/routes/admin/ai-capability-discovery.ts::routes`, `web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields` |
| Shared contracts, grading, bounds and backend correlation | [REQ-ENTERPRISE-035](../../sdd/spec/enterprise-mode.md#req-enterprise-035-enterprise-pi-protocol-match-selection), [REQ-ENTERPRISE-033](../../sdd/spec/enterprise-mode.md#req-enterprise-033-enterprise-pi-discovery-and-multi-model-evidence) | `src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities`, `src/lib/reasoning-discovery.ts::discoverPiCompatibility` |
| Cache qualification, not policy mutation | [REQ-ENTERPRISE-083](../../sdd/spec/enterprise-mode.md#req-enterprise-083-native-bedrock-prompt-cache-checkpoints) | `src/lib/reasoning-discovery.ts::discoverCache`, `src/lib/native-ai-targets.ts::nativePromptCacheSupported` |
| Reasoning preferences and publication | [REQ-ENTERPRISE-072](../../sdd/spec/enterprise-mode.md#req-enterprise-072-provider-native-bedrock-reasoning-profiles), [REQ-ENTERPRISE-058](../../sdd/spec/enterprise-mode.md#req-enterprise-058-native-model-container-publication) | `src/lib/reasoning-profiles.ts::translateRuntimeReasoningRequest`, `src/lib/access.ts::loadEnterpriseRouteConfig` |
| Authority and confidential replay | [REQ-ENTERPRISE-074](../../sdd/spec/enterprise-mode.md#req-enterprise-074-provider-native-bedrock-target-identity), [REQ-ENTERPRISE-073](../../sdd/spec/enterprise-mode.md#req-enterprise-073-provider-native-bedrock-replay-integrity) | `src/lib/native-ai-targets.ts::nativeVerificationMatches`, `src/lib/bedrock-anthropic-native-adapter.ts::assistantContent` |

## Related Documentation

- [Administration and historical usage](administration-analytics.md#enterprise-capability-profiles)
- [Generic Anthropic Bedrock model support](bedrock-generic-model-support.md)
- [Bedrock prompt caching](bedrock-prompt-caching.md)
- [AD74 transport history and current amendment](../decisions/README.md#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api)
