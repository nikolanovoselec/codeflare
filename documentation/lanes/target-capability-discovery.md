# Target capability discovery

**Audience:** Operators, Developers

**Owns:** explicit target discovery, shared contract selection, independent capability evidence, campaign bounds, and diagnostic limitations. **Does not own:** provider availability, access policy, cache policy, or deployed acceptance.

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

The routing corrections below await exact-head CI and deployment verification. Regression checkpoint `bef54164` failed in CI `34770156766`; historical evidence remains scoped to its recorded checkpoint.

<!-- @impl: src/routes/admin/ai-capability-discovery.ts::routes --> <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields -->

1. Select a gateway-owned Dynamic Route, or select the configured Amazon Bedrock provider and enter/select its exact authorized model, region and context window.
2. Click **Discover**. No profile selection, naming, JSON editing or separate Verify action is required.
3. Read **Check result**, directly below Discover. Tool calling, Reasoning, Streaming and Input caching stay visible when technical details or Advanced are closed. On success, set access/fallback policy as needed, choose **Review changes**, then **Confirm Save**.
4. After a route/model/binding change, Discover again. The application reuses protocol handling; the operator does not write another profile for a model release.

Discover changes only the local draft and issues a temporary server-held receipt. It does not enable targets, change Gateway resources or modify a running session. Normal next container/session start publishes saved capabilities to Pi. Inventory loading and startup never run inference automatically.

Saved-state cleanup uses POST `/api/admin/reasoning/catalog` with `{reconcileSaved:true,baseRevision}` against the current saved gateway only. Ordinary catalog reads and draft overlays remain read-only. Complete Dynamic and Native inventories independently authorize absence-based cleanup; failed or incomplete domains never imply deletion. Existing configuration admission and revision checks apply before writes.

Cleanup preserves shared profile revisions, historical receipts and empty deny-only groups. Only exact absent provider bindings remove Native targets, not unsupported or ambiguous present bindings. Policy references and defaults are repaired without widening access; exhausted fallback is disabled. Native selectors and Pi prefer the user label with model fallback, retaining opaque IDs.

Manual profile selection, the older profile-matching editor, selected-profile verification and explicit administrator confirmation of eligible selected profiles, including generated contracts, share one **Advanced: choose a profile** disclosure. Selected-profile verification updates the same Check result above it. Rechecking clears superseded success and its draft receipt immediately, including while a Native check is pending. Saved Native rows distinguish **Verified** from **Administrator-confirmed**; the latter is an operator assessment, not automated evidence.

These retained controls also recover missing unsaved proof without a new wizard. Field errors preserve the draft; explicitly Verify or Mark as verified, then Review and Confirm Save. No automatic retry or paid recheck is introduced. Other native protocols retain their existing advanced workflow. Native automatic discovery currently supports the observed **Bedrock** boundary only; Azure or another native protocol needs a deliberate adapter extension, not a guessed URL or request form.

## Dedicated boundary

| Owner | Responsibility |
| --- | --- |
| `src/lib/ai-capability-discovery/index.ts` | Finite protocol search, automatic contract selection, campaign budget, exercised-backend correlation |
| `src/lib/ai-capability-discovery/contract.ts` | Shared strict evidence parser and exact profile-evidence eligibility; no browser authority |
| `src/lib/ai-capability-discovery/compatibility-wire.ts` | Shared discovery/runtime OpenAI streaming-or-buffered boundary and bounded provider-specific content translation |
| `src/lib/reasoning-discovery.ts` | Existing Pi canary, replay, bounded parser, cache measurements and sanitized diagnostics |
| `src/lib/bedrock-anthropic-native-adapter.ts` | Existing native Messages/Invoke/Eventstream translation and private replay state |
| `src/routes/admin/ai-capability-discovery.ts` | Admin/rate limit, gateway/provider authorization, inventory before/after, existing server receipt issuance |
| `web-ui/src/components/admin/TargetCapabilityDiscovery.tsx` | Discover action and evidence display only |
| `AiRoutingFields.tsx` / existing Save and access modules | Exact draft adoption, stale-result rejection, reviewed persistence and runtime authorization |

The component is not a second routing architecture, catalog service, background poller or per-model profile generator. Existing authorization, assignments, configuration documents, lifecycle propagation and Pi publication remain authoritative.

## Contracts, not a model list

<!-- @impl: src/lib/ai-capability-discovery/index.ts::capabilityCandidates --> <!-- @impl: src/lib/ai-capability-discovery/compatibility-wire.ts::compatibilityResponse -->

Native Anthropic Messages tests six audited forms: disabled, adaptive Low, Medium, High, XHigh and Max. Successful literal mappings form a reusable `bedrock-anthropic-native-discovered-<24hex>` custom revision; Minimal→Low is an explicit alias only when Low succeeds. Provider-default revision 1 is an exclusive fallback when no configurable form qualifies. Native adapter v5 remains the transport/replay boundary. The model namespace is a protocol candidate only: actual availability, entitlement and usable wire behavior must be established for the selected target. Discovery never substitutes the model, provider binding, region or saved transport. Existing Invoke or compat selections are not silently changed to Eventstream.

Dynamic and direct-Bedrock compatibility candidates are content-addressed **shared request forms**. The finite search begins with Provider default, then the already audited normalized enabled request forms from OpenAI, Workers AI and Mesh. Equivalent forms are deduplicated; each is tested with streaming first and bounded completed JSON second. These are potential wire forms, not assertions about the selected model. Native controls are not copied into Dynamic requests. Dynamic search stops at the first complete tools/replay configuration; missing optional cache reuse does not trigger a buffered alternative. Native discovery instead completes its finite per-mapping campaign before assembling the successful forms.

The canonical custom revision ID is `discovered-<24 hex characters>`, derived from its semantic mapping and bounded wire contract. The same contract is reused across model/route names; adding a marketing name does not add code, a profile definition or another candidate. Verification remains target-specific, never a globally verified shared profile. This is automatic contract construction/selection, not a list asking the user to select and verify a profile.

New compatibility contracts explicitly bind `/compat/chat/completions`, as currently documented for Dynamic Routing. The saved contract is used identically by discovery and dispatch, including stream mode and narrow complete-tool-name repair. Historical assignments retain their existing REST-first/404 fallback behavior. No broad paid retry is introduced.

The 2026-09-14 compatibility handoff reports that Cloudflare's Bedrock `/compat` translator rejected a standard OpenAI PNG data URI with `invalid base64 image data` but accepted the equivalent native Anthropic image block. For a route whose authoritative inventory is entirely `aws-bedrock` Anthropic models, Discover therefore binds `images: bedrock-native-block` into the content-addressed compatibility contract. Runtime converts only allowlisted base64 JPEG, PNG, GIF and WebP data URIs, without mutating the Pi transcript. Mixed routes and every other provider keep standard OpenAI image parts because Codeflare cannot predict their selected branch. Existing saved generated profiles must be discovered and saved once to acquire this changed hashed contract; they are not silently rewritten. See [REQ-ENTERPRISE-084](../../sdd/spec/enterprise-mode.md#req-enterprise-084-bedrock-dynamic-route-image-compatibility). <!-- @impl: src/lib/ai-capability-discovery/compatibility-wire.ts::compatibilityImagesForModels --> <!-- @impl: src/lib/ai-capability-discovery/compatibility-wire.ts::compatibilityRequest -->

Native Runtime has a separate history boundary. Active provider tool turns still restore exact encrypted Bedrock blocks, including signed or redacted thinking. Only completed foreign historical pairs lacking provider state may receive a deterministic `cfh_<hash>` alias when their Pi tool ID contains characters rejected by Anthropic Messages Runtime. The same alias is applied to `tool_use.id` and `tool_result.tool_use_id`; collisions and ambiguous histories fail before provider I/O. Provider-generated current IDs and the client-visible transcript are never rewritten. See [REQ-ENTERPRISE-073](../../sdd/spec/enterprise-mode.md#req-enterprise-073-provider-native-bedrock-replay-integrity) and [REQ-ENTERPRISE-079](../../sdd/spec/enterprise-mode.md#req-enterprise-079-provider-native-bedrock-replay-confidentiality). <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::historicalToolAliases --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::assistantContent --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::buildBedrockAnthropicRequest -->

For a buffered contract, the Worker validates completed OpenAI JSON and sends one SSE chunk plus `[DONE]` to a streaming Pi client. It preserves tool IDs and argument strings at that boundary; it never claims incremental generation. A native Anthropic envelope cannot be passed off as OpenAI JSON. A received-but-incompatible buffered envelope is reported as `unexpected_response_format`, with HTTP status and transport retained, rather than a connection failure; it remains a stop boundary, not permission to adapt or retry. No signed native state is reconstructed from client assertions.

## Evidence and qualification

<!-- @impl: src/lib/ai-capability-discovery/contract.ts::parseCapabilitySummary --> <!-- @impl: src/lib/ai-capability-discovery/contract.ts::capabilityEvidenceMatches --> <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility --> <!-- @impl: src/lib/reasoning-discovery.ts::discoverCache -->

| Capability | Independently reported observation |
| --- | --- |
| Tool calling | Complete valid call and exact result replay, or Not verified |
| Reasoning | Actual tested levels/aliases, verified disabled, accepted but unverified controls, or Provider default |
| Streaming | Incremental public delivery before EOF, buffered delivery, or Not established, scoped to mapping/operation |
| Input caching | Provider-prefix read verified, Not observed, or Not tested, scoped to mapping/operation |

Automated activation requires complete tools/replay for every included executable mapping and unchanged exact server receipt/identity safeguards. Explicit server-issued administrator confirmation is a separate authority basis, including for generated profiles; it invents no capability observations or generated-profile cache permission. Cache is optional; buffered/Invoke support remains usable without an incremental-delivery claim. Optional cache failure cannot erase completed tool evidence. Authentication, quota, server, framing, transport and timeout failures still stop the campaign and withhold a fresh receipt.

Gateway HIT is **whole-response reuse**, never input-prefix evidence, even when its replayed answer contains positive provider counters. Native model-wide `cacheControlFormat: "anthropic"` requires positive same-target prefix evidence for every selectable semantic mapping/operation. Mixed profiles remain usable without that flag and show per-level facts. Dynamic never receives native cache serialization. Missing counters remain unmeasured; sanitized HTTP/provider codes and failed stages contain no provider messages/bodies.

Nested capability schema v2 contains only `schemaVersion: 2` and `mappings`. Each row records exact `levels`, exercised `transport`, `tools`, `replay`, `reasoning`, `streaming` and `cache`. Provider-default uses an exclusive empty level row. The shared strict parser serves Worker/browser; authority additionally validates exact profile coverage, aliases and operation. Outer documents remain v1. Legacy v1 is readable under its original qualification rules, never silently promoted or rewritten into v2. Historical adapter/canary checks remain unchanged. <!-- @impl: src/lib/ai-capability-discovery/contract.ts::legacyCapabilityQualifies -->

| V2 field | Allowed values |
| --- | --- |
| `levels` | Exact Pi semantic aliases; `[]` only for exclusive Provider default |
| `transport` | `rest`, `compat`, `bedrock-invoke`, `bedrock-eventstream` |
| `tools`, `replay` | Booleans, independently measured |
| `reasoning` | `provider-default`, `verified-disabled`, `observed-enabled`, `accepted-unverified`, `not-tested` |
| `streaming` | `incremental`, `not-observed`, `not-tested` |
| `cache` | `provider-prefix`, `gateway-response`, `inconclusive`, `not-tested` |

Rows are bounded to seven, reject unknown fields and duplicate levels, and require exact profile coverage before authority. The generated namespaces select validation only. Advanced generated-Native verification uses `verifyNativeCapabilityProfile` in the shared discovery index, checking only the selected canonical forms under the same campaign bounds.

A provider refusal during cache-fill is distinct from unobserved reuse. The result retains the normalized `content_filter` finish reason, observed write/read counters and whether cache-read was attempted; missing counters are not filled with zero. Refused fills never establish cache permission or launch the paired read; completed tools/replay remain independent. The Native API client keeps only validated diagnostic fields and the sanitized explanation, not raw provider bodies, signed replay or failure receipts. <!-- @impl: src/lib/reasoning-discovery.ts::probeDiagnostic --> <!-- @impl: web-ui/src/api/client.ts::checkNativeTarget -->

Tools/replay precede the cache pair. Each successful Native experiment submits exactly two sequential requests with identical public prefix and native controls but different nonempty user questions. Dynamic whole-response experiments retain identical request bodies. No retry, delay, fallback, parser change, custom cache key, TTL override, purge or sharing change is added. Existing Eventstream/Invoke handling and five-minute checkpoints remain unchanged.

The roughly 60-KiB public prefix remains bounded; its model token count is not assumed. Synthetic positive counters prove fixture handling, not reliable immediate provider reuse. Historical live samples below retain their original experimental scope.

Evidence qualifies only the exercised Dynamic branch. Different **known** backends cannot contribute reasoning, tools/replay and cache to one imaginary result. Capability checks for discovered contracts and the selected Dynamic provider-default profile require response identity on multi-distinct-backend routes; absent identity is inconclusive, not an all-branches test. Historical Advanced verification retains its existing evidence semantics. Other branches remain explicitly unverified and must be configured compatibly by the operator until Cloudflare provides post-selection normalization. A compatible observed path retains its green success pill and separate untested-backup warning, not whole-route certification.

Dynamic and Native Provider-default contracts retain all seven Pi preferences without claiming Off, visible thinking or graduated effort. Explicit mapped profiles publish only supported levels and aliases, including off-only profiles. Older-client Worker normalization remains unchanged; it does not justify publishing unsupported choices. Existing evidence-specific Sonnet/Opus native profiles keep their validated disabled/adaptive mappings and aliases. For newly discovered native forms, auto selects Eventstream through mapped High and Invoke for mapped XHigh/Max, identically during discovery and runtime; explicit saved transports never switch.

Canonical profiles and receipts retain only tested mappings. Dynamic and Native generated controls publish actual supported levels and explicit aliases, not seven preferences normalized to Medium. Off remains a selectable default preference for Provider default, with a no-override/provider-controlled caveat. Literal native Off requires a complete private native observation proving no thinking; stripped public SSE alone cannot prove absence. Private observations expose neither thinking/signatures nor invented counters. Historical profiles remain unchanged. <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @impl: src/lib/reasoning-profiles.ts::translateRuntimeReasoningRequest -->

## Bounds and security

<!-- @impl: src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities --> <!-- @impl: src/routes/admin/ai-capability-discovery.ts::routes --> <!-- @impl: src/lib/native-ai-targets.ts::nativeVerificationMatches -->

An explicit Discover is bounded at **40 HTTP submissions**, 2,048 output tokens each, 90 seconds per request and 10 minutes overall. Dynamic search needs at most 38 submissions. Native discovery uses at most 34: six forms with reasoning/tool/replay/cache-fill/cache-read, plus a four-call Provider-default fallback only if no configurable form qualifies. One submission counter and deadline cover the entire sequential campaign; aliases add no calls and saved transports are not multiplied into a cross-product. Limits do not grow with the catalog.

There are no automatic retries, model substitutions or real tool executions. Authentication, rate-limit, provider/server, malformed-stream and timeout boundaries stop further probing; a specific validation incompatibility may allow the next supported contract. Tests are not promised free; input/cache/output usage is billed by the configured provider.

Response acquisition and reads are bounded. Discovery captures are capped at 8 MiB, native frames retain the existing 2-MiB bound, and required replay state remains encrypted with the existing 64-KiB/30-day limits. Discovery state is ephemeral and cleared; generated content, private thinking, signature values and provider credentials are not returned. Ordinary runtime state remains isolated by user/session/target/tool and exact verified connection/provider/model/region/profile/transport/adapter identity.

Requests use only server-constructed gateway paths and authenticated provider inventory. The browser cannot submit a provider credential identifier, alias, arbitrary endpoint/header, native protocol guess or fabricated capability row to gain authority. Compatibility mutations are bounded enum fields included in the canonical hash.

Save accepts an exact server-issued receipt or unchanged current saved authority after current inventory/binding validation. Dynamic and Native temporary Save receipts have a one-hour minimum and bounded 30-day retention, independently of private replay; saved authority does not expire with a receipt. Save validates unchanged current saved authority first, then adopts a fresh valid receipt, including updated observations. Only unavailable or expired receipts may fall back to saved authority; explicit null clears proof and present mismatched receipts reject. An explicit server-issued administrator receipt can authorize an exact selected generated profile without inventing tools or cache observations. A namespace or browser assertion cannot. Stale saved documents stay readable; they cannot silently become current evidence.

## Evidence and remaining boundaries

The current independent-capability contract follows the supplied tests-only behavioral RED checkpoint, CI `34764775466`. Implementation integration and exact-head verification remain in progress. The historical observations below are unchanged provenance, not acceptance of the new per-mapping campaign, UI or deployments.

A later 2026-09-13 incident investigation used existing Gateway logs, not new inference. The Native cache-fill wrote **29,779** provider cache tokens, then returned a refusal; the checkpoint was present and the paired read was never submitted. This does not negate the proven Native caching capability below. Dynamic pairs remained MISS with absent provider counters, and a buffered response used a native Anthropic envelope; the underlying MISS cause remains unresolved. Diagnostic/UI corrections do not claim repaired cache reuse, altered provider refusal behavior or new live acceptance.

2026-09-13 direct-Gateway validation used the new component with the local native adapter: four calls each for Native Sonnet 5, Native Opus 5, Dynamic `bedrock_sonnet` and Dynamic `bedrock_opus`. All passed tools/replay, Provider default and incremental cold delivery. Native repeated requests read 29,783 and 29,782 cached prefix tokens respectively while Gateway remained MISS. Dynamic repeated requests produced Gateway MISS → HIT without positive provider-prefix counters. All four were recorded as Optimal under the then-current, now-retired grading definition; this is **not** certification of native graduated reasoning, Dynamic prefix caching, every Dynamic branch or deployed Worker/session/UI behavior. Before/after management projections retained the same route versions, Bedrock binding and cache/DLP policy. No configuration was changed.

Offline regressions exercise unfamiliar synthetic model names through discovery → receipt → Save → authorization, shared runtime parity, temporal streaming before withheld stop/EOF, old-document upgrades, opt-out/empty revocation and the lock-installed Pi serializer/parser. Synthetic fixtures prove generic behavior, not that an unreleased model exists. The existing CI Pi lane runs `scripts/verify-bedrock-pi-prompt-cache.mjs`; no CI/deployment was dispatched by this diagnostic task.

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
| Shared contracts, independent evidence, bounds and backend correlation | [REQ-ENTERPRISE-035](../../sdd/spec/enterprise-mode.md#req-enterprise-035-enterprise-pi-protocol-match-selection), [REQ-ENTERPRISE-033](../../sdd/spec/enterprise-mode.md#req-enterprise-033-enterprise-pi-discovery-and-multi-model-evidence) | `src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities`, `src/lib/reasoning-discovery.ts::discoverPiCompatibility` |
| Separate cache permission, not policy mutation | [REQ-ENTERPRISE-083](../../sdd/spec/enterprise-mode.md#req-enterprise-083-native-bedrock-prompt-cache-checkpoints) | `src/lib/reasoning-discovery.ts::discoverCache`, `src/lib/native-ai-targets.ts::nativePromptCacheSupported` |
| Reasoning preferences and publication | [REQ-ENTERPRISE-072](../../sdd/spec/enterprise-mode.md#req-enterprise-072-provider-native-bedrock-reasoning-profiles), [REQ-ENTERPRISE-058](../../sdd/spec/enterprise-mode.md#req-enterprise-058-native-model-container-publication) | `src/lib/reasoning-profiles.ts::translateRuntimeReasoningRequest`, `src/lib/access.ts::loadEnterpriseRouteConfig` |
| Authority and confidential replay | [REQ-ENTERPRISE-074](../../sdd/spec/enterprise-mode.md#req-enterprise-074-provider-native-bedrock-target-identity), [REQ-ENTERPRISE-073](../../sdd/spec/enterprise-mode.md#req-enterprise-073-provider-native-bedrock-replay-integrity) | `src/lib/native-ai-targets.ts::nativeVerificationMatches`, `src/lib/bedrock-anthropic-native-adapter.ts::assistantContent` |

## Related Documentation

- [Administration and historical usage](administration-analytics.md#enterprise-capability-profiles)
- [Generic Anthropic Bedrock model support](bedrock-generic-model-support.md)
- [Bedrock prompt caching](bedrock-prompt-caching.md)
- [AD74 transport history and current amendment](../decisions/README.md#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api)
