# Models & Routing

**Audience:** Operators, Developers

**Owns:** sanctioned model/route identity, executable protocol contracts, reasoning semantics, explicit capability discovery, target-bound evidence and runtime authority, native replay/transport, prompt checkpoints and usage translation. **Does not own:** provider availability or entitlement, configuration inventories, administration editing procedures, access membership, Gateway policy, private deployment values, or deployment acceptance. Setting sources and editing remain in [Configuration & Administration](configuration.md); API shapes remain in [API Reference](api-reference.md).

<a id="navigation"></a>
## Contents

- [Identity and executable contracts](#identity-and-executable-contracts)
- [Explicit checks and qualification](#explicit-checks-and-qualification)
- [Capability evidence and authority](#capability-evidence-and-authority)
- [Reasoning and model publication](#reasoning-and-model-publication)
- [Native replay and delivery](#native-replay-and-delivery)
- [Input-prefix caching and accounting](#input-prefix-caching-and-accounting)
- [Compatibility transport boundaries](#compatibility-transport-boundaries)
- [Upgrade, verification and provenance](#upgrade-verification-and-provenance)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

<a id="generic-anthropic-bedrock-model-support"></a>
<a id="contract-not-a-model-release-checklist"></a>
<a id="contracts-not-a-model-list"></a>
<a id="route-model-settings"></a>
<a id="native-provider-targets"></a>
## Identity and executable contracts

<!-- @impl: src/lib/native-ai-target-draft.ts::bedrockAnthropicCandidate --> <!-- @impl: src/lib/native-ai-targets.ts::nativeVerificationMatches --> <!-- @impl: src/lib/reasoning-profiles.ts::BUILT_IN_REASONING_PROFILES --> <!-- @impl: src/lib/reasoning-profiles.ts::COMPATIBILITY_NOTICES -->

A Dynamic Route is a Gateway-owned route, not a direct model binding. A Native target binds an exact authorized provider configuration, model, region where required, saved transport, immutable profile revision/hash and adapter version. Provider/custom selectors, credential identifiers and aliases remain Worker-owned; Pi and Copilot receive opaque native handles. Detection proves presence only. A sole provider binding is selectable; multiple bindings need an unambiguous default. Bedrock model identifiers reject URL, path, ARN, traversal, wildcard, query and fragment forms; other providers retain their bounded slash/colon syntax. Native context windows must exceed 16,384 tokens. Save rejects Dynamic-name/opaque-native-handle collisions and derives typed policy references from target identity, not a handle prefix alone.

The `anthropic.claude-*` namespace, optionally preceded by a supported inference-profile prefix, selects only a protocol candidate. Neither a familiar name nor FoundationModelDetails streaming metadata proves availability, entitlement, usable reasoning, checkpoints, replay or streaming. Model suggestions come from active Dynamic Route inventory; an administrator may enter a documented exact identifier/context window. There is no new catalog service, AWS credential flow, polling or startup inference. A model rejecting the Runtime Messages contract remains unusable through that adapter.

Native discovery constructs reusable `bedrock-anthropic-native-discovered-<24hex>` revisions through canonical content-addressed custom-profile machinery. It tests disabled and adaptive Low, Medium, High, XHigh and Max as six audited forms, retaining only successful complete lifecycles. Minimal→Low exists only when Low passes. Provider-default revision 1 is the exclusive fallback when no configurable form qualifies. No generated per-model source/profile definition or model substitution is needed. Native adapter v5 is the transport/replay boundary; non-Bedrock native protocols retain their existing advanced workflow until deliberately extended.

Dynamic/direct-Bedrock compatibility search uses shared audited OpenAI, Workers AI and Mesh wire forms, starting with Provider default and deduplicating equivalent enabled forms. Each form is tried streaming first, then bounded completed JSON where supported. Dynamic search stops at the first complete tools/replay configuration; missing optional cache reuse does not trigger a buffered alternative. Native search instead finishes its finite per-mapping campaign. A compatibility revision is `discovered-<24 hex characters>`, hashed from semantic mapping and bounded wire contract, reusable across route/model names but never globally verified. Native controls are not copied into Dynamic requests.

Each Dynamic assignment has one runtime `activeProfile`; conditional/fallback legs are selected by AI Gateway only after translation. Atomic reasoning configuration holds immutable custom revisions and exact route/leg assignments, optionally with active-version provenance, leg evidence and a common mapping; context windows remain a separate numeric map. Runtime requires matching saved server-owned authority, not legacy migration proposals or client evidence flags, and does not poll management inventory. Administrative checks/Save revalidate topology. A common mapping still needs current byte-identical evidence across reachable legs; a successful observed path instead carries an explicit untested-backend warning.

Custom compatibility revisions use only `ai-gateway-chat-completions` ingress and literal string, finite-number, boolean or null writes. Limits: 256 KiB per document, 32 custom IDs, 64 retained revisions; ID 64 characters, name 128, description/operator note/limitation 512, at most 16 limitations. Each distinct level allows at most 16 removal paths and 16 writes; paths are at most 128 characters/four object-key segments, without array indexing, protected request roots or transport/provider controls. Scalar strings are at most 256 characters; each revision retains at most 20 sanitized validation/evidence summaries. Validation rejects, never truncates.

Revisions are immutable/hash-addressed; referenced revisions cannot be disabled or collected. Generic native-provider discovery may produce a provider-default custom revision with empty reasoning levels/mappings/aliases; naming it preserves custom identity rather than assigning a Mesh built-in. Verification and explicit Save remain required.

<a id="target-capability-discovery"></a>
<a id="normal-administrator-flow"></a>
<a id="explicit-discovery-and-qualification"></a>
## Explicit checks and qualification

<!-- @impl: src/routes/admin/ai-capability-discovery.ts::routes --> <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @impl: src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities --> <!-- @impl: src/lib/reasoning-discovery.ts::discoverCache -->

For a paper onboarding, keep the deployment's exact model, uniquely selectable provider binding, region, documented context window, and user access policy as parameters. Missing live values or observations do not prevent explaining the conditional workflow, but they prevent claiming availability, qualification, successful Save, cache permission, or deployed acceptance.

Administration's **AI Gateway and routing → Native routes → Add Native Route** opens the draft. Select **Provider** and enter **AWS region** when shown, **Label**, **Exact model identifier**, and **Context window**; use deployment-authorized values, not the form's default context window as provider evidence. **Discover** produces the reviewed check result and eligible draft; field errors retain the draft, not authority. In **Access & fallback**, assign the eligible target to the intended group/default or explicitly enabled fallback; an empty group policy still denies. Configuration owns the full editing contract, summarized here only to connect identity, check, access, and publication. <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields -->

The normal flow is **Select target → Discover → review Check result → Review changes → Confirm Save → next normal session start**. Discover chooses/verifies a shared contract and issues a temporary server-held receipt; it changes only the local draft, never enables targets, changes Gateway resources or mutates a running session. No profile naming/JSON editing or second Verify is required. Tool calling, Reasoning, Streaming and Input caching remain visible above collapsed technical details and **Advanced: choose a profile**. Binding changes require a new check; rechecking immediately clears superseded success and its draft receipt, including while a Native check is pending.

<a id="retained-advanced-workflows"></a>
Advanced retains manual profile choice, broad historical profile matching, selected-profile verification and eligible explicit administrator confirmation, including selected generated contracts. Selected-profile verification uses the same Check result. **Verified** and **Administrator-confirmed** remain distinct authority labels; administrator assessment invents no observations. Field errors preserve the draft; explicit Verify/Mark as verified can recover missing unsaved proof without a new wizard, automatic retry or paid recheck. Advanced generated-Native checks use `verifyNativeCapabilityProfile` to exercise only the selected canonical forms within the same bounds.

For Native Runtime, each candidate first observes reasoning and completes its own Pi function call plus authentic inert-result replay; failed tools do not start cache checks. Only then does it measure optional input reuse with an approximately 60-KiB public prefix, one five-minute checkpoint and two sequential requests with byte-identical prefix/controls but different nonempty user questions. Dynamic whole-response experiments use identical request bodies. No read follows an invalid/refused fill. Prefix size is neither a tokenizer/minimum-prefix guarantee nor a promise of immediate reuse. No real tool executes.

<a id="bounds-and-security"></a>
### Finite, explicit inference

One sequential campaign is bounded to **40 HTTP submissions**, **2,048 output tokens per request**, **90 seconds per request** and **10 minutes overall**. Dynamic search uses at most 38 submissions. Native search uses at most 34: six five-call reasoning/tool/replay/cache-fill/cache-read forms plus at most four Provider-default calls, only when no configurable form qualifies. Aliases add no calls; saved transport is exercised, not multiplied into a cross-product. Limits do not grow with the catalog. There are no automatic retries, delay, speculative models, real tool execution, cache-key/TTL overrides, purge or sharing changes. Configured input/cache/output usage is billable; checks are not promised free.

Authentication, rate-limit/quota, provider/server, malformed-stream/framing, transport and timeout failures stop probing and withhold fresh authority. A specific validation incompatibility may allow the next supported contract; optional cache failure is reported without erasing independently completed tools/replay or guessing parameters. A cache-fill refusal retains normalized `content_filter`, observed read/write counters and whether read was attempted; a write alone grants nothing. Missing counters are not filled with zero. The Native API client retains only validated diagnostics and sanitized explanations, not raw provider bodies, signed replay or failure receipts. <!-- @impl: src/lib/reasoning-discovery.ts::probeDiagnostic --> <!-- @impl: web-ui/src/api/client.ts::checkNativeTarget -->

Response acquisition/reads are bounded: captures at 8 MiB, native frames at 2 MiB, encrypted required replay at 64 KiB/30 days. Ephemeral discovery state is cleared. Generated content, thinking, signatures and credentials are not returned; sanitized HTTP/provider codes and failed stages contain no provider messages/bodies. Requests use only server-constructed Gateway paths and authenticated inventory. Browser-submitted credential IDs, provider aliases, arbitrary endpoints/headers, native protocol guesses or fabricated capability rows cannot grant authority. Compatibility mutations are bounded enum fields in the canonical hash.

<a id="dedicated-boundary"></a>
### Component ownership

| Owner | Responsibility |
| --- | --- |
| `src/lib/ai-capability-discovery/index.ts` | Finite shared-contract search/selection, one campaign budget and exercised-backend correlation |
| `src/lib/ai-capability-discovery/contract.ts` | Strict shared evidence parsing and exact profile/evidence eligibility; no browser authority |
| `src/lib/ai-capability-discovery/compatibility-wire.ts` | Shared discovery/runtime OpenAI streaming-or-buffered boundary; bounded content conversion |
| `src/lib/reasoning-discovery.ts` | Pi canary, replay, bounded parsing, cache measurements and sanitized diagnostics |
| `src/lib/bedrock-anthropic-native-adapter.ts` | Messages/Invoke/Eventstream translation and private replay |
| `src/routes/admin/ai-capability-discovery.ts` | Admin/rate limits, Gateway/provider authorization, before/after inventory and server receipt issuance |
| `web-ui/src/components/admin/TargetCapabilityDiscovery.tsx` | Discover action and evidence display |
| `AiRoutingFields.tsx`, existing Save/access modules | Exact draft adoption, stale-result rejection, reviewed persistence and runtime authorization |

This component is not another routing architecture, catalog, poller or per-model generator. Existing assignments, configuration documents, authorization and lifecycle/Pi publication remain authoritative.

<a id="evidence-and-qualification"></a>
## Capability evidence and authority

<!-- @impl: src/lib/ai-capability-discovery/contract.ts::parseCapabilitySummary --> <!-- @impl: src/lib/ai-capability-discovery/contract.ts::capabilityEvidenceMatches --> <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility --> <!-- @impl: src/lib/ai-capability-discovery/contract.ts::legacyCapabilityQualifies -->

| Capability | Independent observation, scoped to mapping/operation |
| --- | --- |
| Tool calling | Complete valid call and exact result replay, or Not verified |
| Reasoning | Actual levels/aliases, verified disabled, accepted-unverified controls, or Provider default |
| Streaming | Incremental cold public deltas before EOF, buffered/not observed, or Not tested/established |
| Input caching | Provider-prefix read verified, Not observed/inconclusive, or Not tested; Gateway response reuse is separate |

Automated activation requires complete tools/replay on **every included executable mapping**, exact canonical profile/semantic-group/alias coverage and correct mapped operation, plus unchanged server receipt/identity safeguards. Missing, extra or duplicate rows/levels fail closed. Cache and incremental delivery are optional, so buffered/Invoke targets and targets without cache permission remain usable. Explicit server-issued administrator confirmation is a separate selected-profile authority basis, not invented tools/cache evidence or generated-profile cache permission. Namespaces select validation only; no current cumulative grade/capability threshold is published.

### Exact nested evidence schema

Outer documents remain v1. Nested v2 has **only** `schemaVersion: 2` and `mappings`. Each row has exactly the following seven fields; unknown fields are rejected.

| V2 field | Allowed values |
| --- | --- |
| `levels` | Exact Pi semantic levels/aliases (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); `[]` only for exclusive Provider default |
| `transport` | `rest`, `compat`, `bedrock-invoke`, `bedrock-eventstream` |
| `tools`, `replay` | Booleans, independently measured |
| `reasoning` | `provider-default`, `verified-disabled`, `observed-enabled`, `accepted-unverified`, `not-tested` |
| `streaming` | `incremental`, `not-observed`, `not-tested` |
| `cache` | `provider-prefix`, `gateway-response`, `inconclusive`, `not-tested` |

At most seven rows and seven levels per row; duplicate levels are rejected across rows. An empty level row is equivalent to `reasoning: "provider-default"` and must be the sole row. Shared Worker/browser parsing is not authorization: authority additionally requires exact immutable profile coverage, aliases and operation.

Legacy v1 remains strict/read-only under its original qualification rules. Its exact fields are `schemaVersion: 1`, boolean `tools`, `replay`, `nativePromptCache`, `cache` with the four v2 cache values, `reasoning` in `provider-default | observed-enabled | unverified`, `streaming` in `incremental | not-observed`, and `grade` in `Minimum | Acceptable | Optimal | Not qualified`. Qualification still requires tools/replay, `provider-prefix` or `gateway-response`, provider-prefix whenever `nativePromptCache` is true, and the original matching grade: Minimum for unverified reasoning, otherwise Optimal for incremental delivery or Acceptable. Loading/rebinding never upgrades formerly ineligible evidence, coverage, historical adapter/canary checks or v1 into v2.

### Exact target and exercised-backend authority

<!-- @impl: src/lib/native-ai-targets.ts::nativeVerificationMatches -->

Native proof binds verified connection, provider/custom classification and exact provider binding/alias, target ID, model, region, immutable profile reference/hash, saved transport and current adapter. Ordinary replay isolation additionally binds user/session/target/tool. Save accepts exact server-issued proof or unchanged current saved authority after inventory/binding validation. Temporary Dynamic/Native Save receipts have a one-hour minimum and bounded 30-day retention, independently of private replay; saved authority does not expire with the temporary receipt. Save checks unchanged saved authority first, then adopts fresh valid observations. Only unavailable/expired receipts may fall back; explicit null clears proof and present mismatched receipts reject. A browser assertion or manually asserted generic receipt cannot authorize anything.

Discovered Dynamic contracts and selected Dynamic Provider-default checks correlate reasoning, tools/replay and cache to **one exercised backend**, including across retained mappings. Distinct known backends cannot form an imaginary combined result. Multi-distinct-backend inventory requires response provider/model identity even without cache evidence; missing headers remain unobserved/inconclusive, never inferred from inventory. Historical Advanced verification preserves its existing semantics. A compatible observed path retains a green success pill and a separate untested-backup warning, not certification of every conditional/fallback branch. Operators must keep branches compatible until Cloudflare supplies post-selection normalization.

Saved-inventory cleanup is a separate explicit administration operation, not inference/discovery/startup. Ordinary catalog reads/draft overlays are read-only. Complete Dynamic and Native inventories independently authorize absence-based cleanup; failed/incomplete domains never imply deletion. Only exact absent provider bindings remove Native targets, not present unsupported/ambiguous bindings. Cleanup preserves shared revisions, historical receipts and empty deny-only groups, repairs defaults/policy references without widening access, and disables exhausted fallback. The request/revision-confirmation workflow belongs to [Configuration & Administration](configuration.md#enterprise-capability-profiles).

<a id="reasoning-semantics"></a>
## Reasoning and model publication

<!-- @impl: src/lib/reasoning-profiles.ts::translateRuntimeReasoningRequest --> <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @impl: src/lib/reasoning-profiles.ts::BUILT_IN_REASONING_PROFILES --> <!-- @impl: src/llm-interceptor.ts::LlmInterceptor -->

Pi preferences are **Off, Minimal, Low, Medium, High, XHigh, Max**. Dynamic normalized discovered contracts and Dynamic/Native Provider-default contracts retain all seven client choices. Provider default sends **no client reasoning override** for any selection: not fabricated Off, observable thinking or graduated effort. Zero executable mappings does not mean zero selectable preferences. An Off default preference is allowed with a visible no-override/provider-controlled caveat. Dynamic generated single-mapping contracts normalize all seven preferences to the one tested mapping without expanding canonical mappings or receipts. Native configurable discoveries publish only actual successful levels and explicit aliases, including off-only profiles; older-client normalization does not justify publishing unsupported levels. Supported selected Off survives review, Save, reload and startup.

For explicit mapped profiles, the Worker uses the exact requested executable level, otherwise the next higher, otherwise the highest lower within the assigned profile. Without a valid request/scope default it selects mapped Medium, else Off, else the first available level. Provider-default translation strips client reasoning controls while preserving unrelated fields and tool replay. Cataloged Bedrock, Gemini and Mesh defaults remain provider controlled. Native OpenAI compatibility maps only `off` to `reasoning_effort: none`; GPT-6 Astra remains excluded. Gemini retains bounded opaque thought-signature replay metadata; the narrow repeated-complete-tool-name repair belongs to Bedrock compatibility only.

Literal native Off needs a completed private observation of absent thinking, including hidden/redacted blocks even when counters are missing; stripped public SSE cannot prove absence. Accepted controls without observable thinking remain unverified. Enabled reasoning length/token evidence proves enabled behavior, not graduated fidelity or monotonically increasing token counts. Observations expose no thinking text, signatures or invented counters. AWS budgeted/adaptive/adaptive-only forms differ; a model namespace cannot select their semantics.

Retained Sonnet 5/Opus 5 profiles keep validated disabled/adaptive mappings and aliases under exact evidence-model guards; no future-name substring inheritance, dangling alias, unfamiliar-model Sonnet alias or Max→Medium mapping is invented. Minimal→Low is explicit. Retained Sonnet XHigh/Max are High aliases; automatic Opus XHigh/Max remain Invoke. Generic Provider default has no mapped upper effort and uses Eventstream under auto.

Normal next session/container start publishes saved opaque capabilities without hot mutation, forced reset or restart. Pi startup names are `Dynamic Route - <route name>` and `Native Route - <native label>`; selectors prefer the user label with model fallback. Gateway pickers, thinking settings, default/selection messages and footer use those names; requests retain unchanged route IDs/native handles. Pi uses the `system` role rather than OpenAI `developer` for its managed prompt across Dynamic backends. The scope default is reasserted each start; absent reasoning default removes restored thinking overrides rather than manufacturing a provider control.

Publication communicates route-dependent context/output budgets, not provider credentials: Copilot Dynamic defaults advertise 920000 prompt/128000 output tokens; native defaults use 16384 output and configured context minus that reserve. Per-route context windows override Pi's fallback; absent Dynamic values use 256000. Source/default/environment inventories remain in [Configuration](configuration.md), not here.

Per-group sanctioned access is first matching configured policy before eligibility filtering; an empty policy denies rather than falling through. Unmatched users receive only explicitly enabled fallback targets, otherwise none. Personal Pi provider permission is independently default-off; sanctioned defaults do not change. Personal requests recheck bound-session groups, current administration permission, active ownership, generation/shutdown fences and reused native WebSocket frames, not browser leases/stale picker hints/live Access membership. Configured strict egress still applies; cross-origin provider redirects are blocked. Operators get empty authentication and image-owned managed models, never user-edited personal credentials. Credentials retain existing owner storage/governance, not a new secret store. <!-- @impl: src/container/container-interception.ts::getPersonalPiSession --> <!-- @impl: src/lib/personal-pi-forwarding.ts::forwardPersonalPi --> See [Security](security.md) for containment and [REQ-ENTERPRISE-090](../../sdd/spec/models-and-routing.md#req-enterprise-090-native-pi-forwarding-under-current-administration-permission), [REQ-ENTERPRISE-091](../../sdd/spec/models-and-routing.md#req-enterprise-091-operator-personal-provider-isolation).

<a id="prompt-cache-and-replay-boundary"></a>
<a id="streaming-boundary"></a>
## Native replay and delivery

<!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::assistantContent --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::historicalToolAliases --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::buildBedrockAnthropicRequest --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::selectBedrockAnthropicTransport --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::adaptBedrockAnthropicResponse -->

Adapter v5 requires server-held authentic active tool state even when reasoning is disabled/omitted. Complete provider assistant arrays, including signed/redacted thinking, are restored unchanged from encrypted replay; client assertions cannot reconstruct native signed state. Replay keys include exact verified connection/provider/model/region/profile/transport/adapter plus user/session/target/tool isolation, closing cross-profile reuse without exposing bindings to Pi. Encrypted replay retains the 64-KiB/30-day bounds.

Only completed foreign historical tool pairs lacking provider state may receive deterministic `cfh_<hash>` aliases when IDs violate Anthropic Messages' alphabet. Both `tool_use.id` and `tool_result.tool_use_id` use the same alias; collisions or ambiguous histories fail before provider I/O. Authentic active blocks/current provider IDs and the client-visible transcript are unchanged.

A shared transaction boundary validates replay and builds the mapped request **before** selecting initial/continuation operation. Auto selects Eventstream through mapped High and Invoke for mapped XHigh/Max; explicit Invoke/Eventstream/compat authority never switches. Validated stream-supported tool continuations stay Eventstream rather than being forced to Invoke. Per-level evidence can show High incremental delivery alongside buffered upper-level Invoke. Invoke JSON produces synthesized SSE only after complete upstream JSON; caching does not change that delivery model. No paid fallback, transport migration or fake character timer is added. Gateway response-inspection DLP can buffer SSE independently; direct-Gateway delivery does not certify deployed sessions or arbitrary Gateway policies.

Native stop reasons map explicitly: `tool_use`→`tool_calls`, `end_turn`/`stop_sequence`→`stop`, `max_tokens`→`length`, `refusal`→`content_filter`; unknown/missing reasons fail closed. Eventstream success requires message start, valid framing, terminal stop/message, clean EOF and required replay persistence, though public text can arrive earlier.

Provider tool blocks become executable output/stored replay only after `tool_use`; `max_tokens` retains safe text/usage but never publishes a partial call. Completed transactions stay exact/fail-closed. If Pi retained an unexecuted proposal, a later nonempty text-only user turn can abandon it only with zero tool results, retaining safe assistant prose. Partial results, orphan/duplicate ambiguity, assistant boundaries and non-text user content stay protected. Structural recovery also permits summarization to omit old unexecuted proposals without weakening signed replay, changing profile/adapter identity or the one-operation/no-fallback rule. Coverage is fixture-based, not a new live-provider claim. See [REQ-ENTERPRISE-085](../../sdd/spec/models-and-routing.md#req-enterprise-085-provider-native-bedrock-incomplete-tool-recovery).

<a id="bedrock-prompt-caching"></a>
<a id="provider-cache-versus-gateway-cache"></a>
<a id="checkpoint-translation-and-ownership"></a>
## Input-prefix caching and accounting

<!-- @impl: src/lib/native-ai-targets.ts::nativePromptCacheSupported --> <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::buildBedrockAnthropicRequest --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::assistantContent -->

Provider prompt caching reuses an input prefix while generating a new answer; AI Gateway whole-response caching replays a completed answer. `cf-aig-cache-status` and log `cached` measure the latter, never prove/disprove provider reuse. Even a Gateway HIT replaying positive provider counters grants no prefix permission. AWS's explicit/implicit caching documentation establishes provider contracts, not a live hit on every transport.

**Current native permission is at least one positive provider-prefix mapping of the exact receipt-bound target**, after full verification/canonical-profile/provider-binding checks, or retained validated historical permission. It is not an every-mapping gate. Tools/replay still require every included mapping; per-level cache facts remain independent and do not authorize another target. No positive mapping, administrator-confirmed generated proof alone, Gateway-HIT-only, synthetic counters, refused fills or inconclusive observations grant cache permission. A qualifying native target remains usable without cache. Dynamic and native legacy-compat targets never receive this serialization. The Worker rejects unauthorized checkpoints before inference. See [REQ-ENTERPRISE-083](../../sdd/spec/models-and-routing.md#req-enterprise-083-native-bedrock-prompt-cache-checkpoints) and `nativePromptCacheSupported`.

| Boundary | Responsibility |
| --- | --- |
| `access.ts` | Derive eligible opaque `promptCacheTargets`; labels/arbitrary client model names grant nothing |
| Lifecycle → container state → environment | Preserve validated snapshot, explicit empty revocation, and historical-state opt-out when capability field is absent |
| `entrypoint.sh` | Set only eligible models' `cacheControlFormat: "anthropic"`, `supportsLongCacheRetention: false` |
| `buildBedrockAnthropicRequest` | Preserve allowlisted five-minute boundaries and lift only terminal tool-result text markers to native `tool_result` |
| `assistantContent` | Restore authentic complete assistant arrays unchanged; never decorate signed thinking |
| `openAiUsage` | Translate distinct uncached/read/write usage for Pi |

Pi marks its first system/developer message, final tool definition and final cacheable conversation message. Accepted controls are exactly `{"type":"ephemeral"}` or `{"type":"ephemeral","ttl":"5m"}`, at most four request-wide checkpoints. Top-level automatic controls, one-hour TTLs, extra control fields, excess checkpoints and interior tool-result markers requiring boundary movement fail before I/O. Input is not mutated. This is narrower than AWS's caching catalog. `cacheRetention: "none"` omits explicit client checkpoints, not implicit provider caching; five minutes is the only advertised TTL and pinned Pi falls back to short form when long retention is unsupported. No Gateway headers/keys/TTLs, policy changes or provider substitutions enable input caching.

<a id="usage-translation"></a>
### Token accounting

<!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::openAiUsage -->

| Native Anthropic usage | OpenAI-compatible usage consumed by Pi |
| --- | --- |
| `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` | `prompt_tokens` |
| `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` |
| `cache_creation_input_tokens` | `prompt_tokens_details.cache_write_tokens` |
| `output_tokens` | `completion_tokens` |
| `output_tokens_details.thinking_tokens` | `completion_tokens_details.reasoning_tokens` |

Cache writes are not reads; provider thinking is already in output and counted once. Locked Pi's OpenAI parser subtracts reads/writes from total prompt tokens to recover uncached input. Missing/invalid cache-read/write counters stay absent: they must be nonnegative safe integers, and reported zero is retained. Optional thinking counts are forwarded when finite. Aggregate writes already include all TTL buckets: do not add their breakdown again or claim exact mixed-TTL/one-hour Pi pricing. Invoke JSON, synthesized Invoke SSE and terminal Eventstream SSE share this conversion; accounting itself changes neither request controls nor transport.

<a id="dynamic-remains-a-separate-transport"></a>
<a id="dynamic-route-boundary"></a>
## Compatibility transport boundaries

<!-- @impl: src/lib/ai-capability-discovery/index.ts::capabilityCandidates --> <!-- @impl: src/lib/ai-capability-discovery/compatibility-wire.ts::compatibilityResponse --> <!-- @impl: src/lib/native-ai-targets.ts::nativePromptCacheSupported -->

New discovered compatibility contracts explicitly bind `/compat/chat/completions`; discovery/dispatch use the same saved stream mode and narrow complete-tool-name repair. Historical assignments retain REST-first/404 fallback; the reusable `dynamic-bedrock-anthropic-provider-default` contract remains for older assignments. No broad paid retry, direct-model flattening of Dynamic Routes, native cache controls or silent Invoke migration occurs. Existing explicitly administrator-confirmed Dynamic assignments stay distinct, not silently revoked or relabelled automated evidence.

For buffered contracts, completed OpenAI JSON is validated and converted to one SSE chunk plus `[DONE]` for streaming Pi; tool IDs/argument strings are preserved, never an incremental-generation claim. A received native Anthropic envelope is rejected as `unexpected_response_format`, retaining HTTP status/transport rather than calling it a connection failure. It is not permission to adapt/retry or reconstruct signed state.

<!-- @impl: src/lib/ai-capability-discovery/compatibility-wire.ts::compatibilityImagesForModels --> <!-- @impl: src/lib/ai-capability-discovery/compatibility-wire.ts::compatibilityRequest -->

When authoritative route inventory is entirely `aws-bedrock` Anthropic models, the content-addressed compatibility contract binds `images: bedrock-native-block`: runtime converts only allowlisted base64 JPEG, PNG, GIF and WebP data URIs to native Anthropic image blocks without mutating Pi's transcript. Mixed/other routes retain standard OpenAI image parts; the selected branch cannot be predicted. Existing generated assignments need explicit Discover/Save for the changed hash, not silent rewriting. This is the bounded converter contract in [REQ-ENTERPRISE-084](../../sdd/spec/models-and-routing.md#req-enterprise-084-bedrock-dynamic-route-image-compatibility), not native Runtime replay.

Native caching success cannot certify Dynamic prefix forwarding/accounting. Historical cache-marked array-valued system prompts failed input-integrity canaries, while plain strings preserved tool/replay behavior. Keep Dynamic system content string-valued and do not publish native Pi cache metadata, cache headers/keys or TTLs. Experiments preserving user/tool checkpoints without positive categories did not establish reuse; missing counters are unmeasured, not zero or proof implicit caching is impossible. Explicit zero counters in a separate native-shaped buffered response likewise establish neither the converter's cause nor universal impossibility.

Dynamic input-prefix serialization still requires preserved system-prefix semantics and **positive provider-reported prefix reads on a changed-answer request through that exact converter**. Gateway MISS/HIT proves only whole-response behavior; accepted requests or refusals are not successful cache lifecycles. Cloudflare's preservation of Bedrock checkpoints/usage through Dynamic `/compat` remains an external boundary. A custom-provider bridge needs a different endpoint/provider/route architecture and remains outside this contract.

<a id="upgrade-and-next-start-behavior"></a>
## Upgrade, verification and provenance

Historical native adapter v1/v2/v3/v4 documents/receipts remain readable but do not authorize v5. Reconfirm eligible retained evidence-specific profiles through Advanced or Discover an exact target for reusable current handling. Historical transport revisions recorded changed operation contracts, not automatic capability inheritance. A stale historical profile can stay byte-identical and disabled while another target upgrades; editing/enabling it requires a current canonical profile. No automatic receipt rewrite, evidence upgrade, fabricated authority or recurring per-release profile authoring is allowed. Review/Save affects only normal next-start publication; adoption/deployment/deployed Worker/session/Pi acceptance is a separate integrating-owner responsibility.

<a id="verification-and-references"></a>
<a id="reproducible-local-checks"></a>
### Behavioral verification scope

Synthetic future-name regressions exercise admin endpoint → server receipt → Save → authorization → Pi publication → interceptor dispatch, proving lack of release-name coupling, not unreleased-model availability. Real historical hashes exercise collection upgrades. Temporal tests hold later text/stop/EOF while requiring the first public delta; adapter/interceptor, native authority, lifecycle, container, schema and real-entrypoint jq coverage protect replay/checkpoint/opt-out/revocation behavior. Synthetic fixtures contain no live provider thinking/signatures and cannot live-certify future models.

The existing CI `pi-prompt` lane runs [scripts/verify-bedrock-pi-prompt-cache.mjs](../../scripts/verify-bedrock-pi-prompt-cache.mjs) against its installed locked Pi package. It injects every HTTP response, makes zero network calls and exercises the real serializer/parser, complete replay/confidentiality, checkpoint opt-in/out and cache arithmetic. The reproduction form is `node scripts/verify-bedrock-pi-prompt-cache.mjs /path/to/@earendil-works/pi-ai` using the committed `@earendil-works/pi-ai@0.99.1` pin; the installed lock remains authoritative, not historical probe versions. No separate framework or new execution/evidence collection is introduced.

<a id="live-evidence-not-synthetic-capability-claims"></a>
<a id="cherry-pick--reimplementation-contract"></a>
<a id="evidence-and-remaining-boundaries"></a>
### Historical anchors

These aliases retain access to original measurements, retired grades, unresolved diagnostic samples and feature-integration sequences, not current acceptance claims. Immutable original provenance is [Bedrock cache/stream measurements](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/bedrock-prompt-caching.md#live-evidence-not-synthetic-capability-claims), [original integration sequence](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/bedrock-prompt-caching.md#cherry-pick--reimplementation-contract), and [discovery evidence/remaining boundaries](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/target-capability-discovery.md#evidence-and-remaining-boundaries). Historical direct-Gateway/real-Pi samples are model/transport/policy-specific; they do not certify arbitrary prompts, every Dynamic branch, graduated reasoning or deployed application sessions. An unexplained sample failure and a later passing diagnostic are not a fix or explanation.

<a id="authoritative-references"></a>
<a id="evidence-and-references"></a>
### Provider references

Documentation describes provider contracts, not live capability of arbitrary targets.

- AWS: [FoundationModelDetails](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_FoundationModelDetails.html), [model availability](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetFoundationModelAvailability.html), [Anthropic Messages](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages.html), [adaptive thinking](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html), [prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html), [Sonnet 5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html), [Opus 5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html).
- Anthropic: [cache usage fields](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance).
- Cloudflare: [Bedrock forwarding](https://developers.cloudflare.com/ai-gateway/usage/providers/bedrock/), [chat completion](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/), [Dynamic compatibility and backend headers](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/usage/), [whole-response caching](https://developers.cloudflare.com/ai-gateway/features/caching/), [DLP buffering](https://developers.cloudflare.com/ai-gateway/features/dlp/).
- Historical accounting source: `package/dist/api/openai-completions.js::parseChunkUsage` in the [reviewed 0.87.1 package](https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.87.1.tgz); that historical audit is not verification of the current locked client/head.

<a id="traceability"></a>
## Requirement and Source Map

| Contract | Requirements | Primary source |
| --- | --- | --- |
| Route/profile administration and selection | [REQ-ENTERPRISE-022](../../sdd/spec/models-and-routing.md#req-enterprise-022-per-route-context-windows-for-dynamic-routes), [031](../../sdd/spec/models-and-routing.md#req-enterprise-031-enterprise-pi-capability-profile-administration), [032](../../sdd/spec/models-and-routing.md#req-enterprise-032-enterprise-pi-route-selection-and-runtime-translation), [034](../../sdd/spec/setup.md#req-enterprise-034-enterprise-pi-route-administration), [043](../../sdd/spec/models-and-routing.md#req-enterprise-043-enterprise-pi-verified-route-activation) | `reasoning-profiles.ts`, admin discovery routes, `AiRoutingFields.tsx` |
| Independent discovery, shared forms, bounds and backend correlation | [REQ-ENTERPRISE-033](../../sdd/spec/models-and-routing.md#req-enterprise-033-enterprise-pi-discovery-and-multi-model-evidence), [035](../../sdd/spec/models-and-routing.md#req-enterprise-035-enterprise-pi-protocol-match-selection), [037](../../sdd/spec/models-and-routing.md#req-enterprise-037-enterprise-pi-custom-profile-generation), [075](../../sdd/spec/models-and-routing.md#req-enterprise-075-provider-native-bedrock-administration-authority) | `ai-capability-discovery/index.ts::discoverTargetCapabilities`, `capabilityCandidates`, `contract.ts`, `reasoning-discovery.ts::discoverPiCompatibility` |
| Native identity, admission and authority | [REQ-ENTERPRISE-047](../../sdd/spec/models-and-routing.md#req-enterprise-047-native-ai-gateway-provider-discovery-and-selection), [048](../../sdd/spec/models-and-routing.md#req-enterprise-048-native-provider-capability-catalog), [052](../../sdd/spec/models-and-routing.md#req-enterprise-052-native-provider-verification-and-runtime-enforcement), [053](../../sdd/spec/models-and-routing.md#req-enterprise-053-native-target-identity-and-document), [055](../../sdd/spec/models-and-routing.md#req-enterprise-055-native-target-authority-and-save), [060](../../sdd/spec/models-and-routing.md#req-enterprise-060-native-target-input-validation), [061](../../sdd/spec/setup.md#req-enterprise-061-native-target-administration-projection), [074](../../sdd/spec/models-and-routing.md#req-enterprise-074-provider-native-bedrock-target-identity) | `native-ai-target-draft.ts::bedrockAnthropicCandidate`, `native-ai-targets.ts::nativeVerificationMatches` |
| Reasoning, wire adaptation, labels and publication | [REQ-ENTERPRISE-058](../../sdd/spec/models-and-routing.md#req-enterprise-058-native-model-container-publication), [059](../../sdd/spec/models-and-routing.md#req-enterprise-059-native-provider-wire-adaptation), [064](../../sdd/spec/setup.md#req-enterprise-064-route-and-compatibility-profile-presentation), [072](../../sdd/spec/models-and-routing.md#req-enterprise-072-provider-native-bedrock-reasoning-profiles), [082](../../sdd/spec/models-and-routing.md#req-enterprise-082-pi-native-model-display) | `reasoning-profiles.ts::translateRuntimeReasoningRequest`, `access.ts::loadEnterpriseRouteConfig`, `LlmInterceptor` |
| Authentic replay, confidentiality and incomplete proposals | [REQ-ENTERPRISE-073](../../sdd/spec/models-and-routing.md#req-enterprise-073-provider-native-bedrock-replay-integrity), [079](../../sdd/spec/models-and-routing.md#req-enterprise-079-provider-native-bedrock-replay-confidentiality), [085](../../sdd/spec/models-and-routing.md#req-enterprise-085-provider-native-bedrock-incomplete-tool-recovery) | `bedrock-anthropic-native-adapter.ts::assistantContent`, `historicalToolAliases`, `buildBedrockAnthropicRequest` |
| Usage, transport and terminal success | [REQ-ENTERPRISE-076](../../sdd/spec/models-and-routing.md#req-enterprise-076-provider-native-bedrock-protocol-translation), [077](../../sdd/spec/models-and-routing.md#req-enterprise-077-provider-native-bedrock-transport-dispatch), [080](../../sdd/spec/models-and-routing.md#req-enterprise-080-provider-native-bedrock-stream-completion) | `bedrock-anthropic-native-adapter.ts::openAiUsage`, `selectBedrockAnthropicTransport`, `adaptBedrockAnthropicResponse` |
| Checkpoints, authority and lifecycle revocation | [REQ-ENTERPRISE-083](../../sdd/spec/models-and-routing.md#req-enterprise-083-native-bedrock-prompt-cache-checkpoints) | `native-ai-targets.ts::nativePromptCacheSupported`, `access.ts::loadEnterpriseRouteConfig`, `reasoning-discovery.ts::discoverCache`, native adapter, lifecycle/entrypoint |
| Dynamic images | [REQ-ENTERPRISE-084](../../sdd/spec/models-and-routing.md#req-enterprise-084-bedrock-dynamic-route-image-compatibility) | `compatibility-wire.ts::compatibilityImagesForModels`, `compatibilityRequest` |
| Access denial/fallback and separate personal permission | [REQ-ENTERPRISE-013](../../sdd/spec/models-and-routing.md#req-enterprise-013-per-group-dynamic-routing), [044](../../sdd/spec/setup.md#req-enterprise-044-enterprise-pi-minimum-save-and-access-policies), [066](../../sdd/spec/setup.md#req-enterprise-066-native-provider-draft-persistence-before-access), [090](../../sdd/spec/models-and-routing.md#req-enterprise-090-native-pi-forwarding-under-current-administration-permission), [091](../../sdd/spec/models-and-routing.md#req-enterprise-091-operator-personal-provider-isolation) | `access.ts`, `container-interception.ts::getPersonalPiSession`, `personal-pi-forwarding.ts::forwardPersonalPi` |

Source symbols without a prefix are under `src/lib/`, except the named interceptor/container/UI/entrypoint owners. Existing behavioral anchors for the reconciled cache rule are [bedrock-generic-contract.test.ts](../../src/__tests__/lib/bedrock-generic-contract.test.ts), [enterprise-route-config.test.ts](../../src/__tests__/lib/enterprise-route-config.test.ts), [real entrypoint model tests](../../host/__tests__/entrypoint-enterprise-pi-models.test.js) and the [locked-Pi verifier](../../scripts/verify-bedrock-pi-prompt-cache.mjs). Requirement-owned `@test` qualifiers remain authoritative; no test or status is upgraded by this consolidation.

Original adapter composition traceability remains with this owner: Worker replay keys bind user/session/target/tool identity, and Bedrock chunks are decoded through the provider-native adapter before public streaming. <!-- @impl: src/llm-interceptor.ts::nativeReplayStateKey --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::decodeBedrockChunk -->

<a id="adjacent-owners"></a>
## Related Documentation

- [Configuration & Administration](configuration.md): settings, defaults and reviewed edits.
- [Billing & Usage](billing.md): historical accounting and reports, separate from live quota authority.
- [Security](security.md), [Identity & Access](authentication.md): identity, containment and permission controls.
- [Sessions & Runtime](container.md): lifecycle delivery; [API Reference](api-reference.md): wire/API surfaces.
- [CI & Testing](ci-cd.md): hosted verification topology; [Deployment](deployment.md): release and acceptance execution.
- [AD74 transport history and amendment](../decisions/README.md#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api).
