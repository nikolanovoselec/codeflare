# Bedrock prompt caching

## Provider cache versus Gateway cache

Bedrock prompt caching reuses an input prefix and still generates a new answer. AI Gateway's whole-response cache replays a completed answer. `cf-aig-cache-status` and the Gateway log's `cached` flag measure the latter; neither proves nor disproves provider prompt caching. Do not add Gateway cache keys or change Gateway TTLs to enable Bedrock input caching.

AWS documents implicit and explicit prompt caching for Claude Sonnet 5 and Claude Opus 5, including `InvokeModelWithResponseStream`. Explicit checkpoints use native `cache_control` blocks. This documentation establishes provider capability, not a live hit through every Cloudflare transport.

## Usage translation

`openAiUsage` in `src/lib/bedrock-anthropic-native-adapter.ts` preserves the provider's distinct input categories:

| Native Anthropic usage | OpenAI-compatible usage consumed by Pi |
| --- | --- |
| `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` | `prompt_tokens` |
| `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` |
| `cache_creation_input_tokens` | `prompt_tokens_details.cache_write_tokens` |
| `output_tokens` | `completion_tokens` |
| `output_tokens_details.thinking_tokens` | `completion_tokens_details.reasoning_tokens` |

Cache writes are not cache reads, and thinking is already included in output tokens. The locked `@earendil-works/pi-ai` 0.85.1 OpenAI parser subtracts reads and writes from total prompt tokens to recover uncached input. Missing or malformed optional cache counters remain absent; a provider-reported zero is preserved. The aggregate write counter includes all TTL buckets and must not be added to its own TTL breakdown again.

Invoke JSON, Invoke's synthesized SSE and Eventstream's terminal SSE use this one conversion. The accounting converter itself changes no request controls or transport selection. Pi's OpenAI parser does not separately price one-hour writes; do not claim exact mixed-TTL billing from the aggregate alone.

## Checkpoint translation and ownership

The second change enables the already-existing Pi 0.85.1 OpenAI serializer's Anthropic cache format **only for eligible native Runtime handles**. It is a per-model capability, not a provider-wide switch. The Worker remains authoritative for provider binding, target model, region, reasoning profile, and credentials.

| Boundary | Responsibility | Why it exists |
| --- | --- | --- |
| `access.ts` | Derive `promptCacheTargets` from eligible native Runtime targets | A display label or arbitrary client model name cannot grant a protocol capability |
| Lifecycle → container state → environment | Preserve the opaque list, including explicit empty revocation | Startup/restart must not keep stale capability metadata |
| `entrypoint.sh` | Set model-level `cacheControlFormat: "anthropic"`, `supportsLongCacheRetention: false` | Let the locked Pi client place its own checkpoints without enabling them for Dynamic/compat models |
| `buildBedrockAnthropicRequest` | Preserve allowlisted five-minute checkpoints; lift a terminal tool-result marker to native `tool_result` | OpenAI tool-result content nesting differs from native Anthropic's cache boundary |
| `assistantContent` | Restore the complete authentic assistant array unchanged | A cache optimization must never rewrite, fabricate, or expose signed thinking |
| `openAiUsage` | Translate separate cache categories into Pi's accounting | Pi subtracts cache categories from total input; omitting them hides real reuse |

Pi marks the first system/developer message, the final tool definition, and the final cacheable conversation message. The adapter accepts `{"type":"ephemeral"}` or the explicit equivalent with `"ttl":"5m"`, with at most four checkpoints across the request. It rejects top-level automatic controls, one-hour TTLs, extra control fields, and interior tool-result checkpoints that would require moving a boundary. This is intentionally narrower than AWS's complete catalog of caching features.

`cacheRetention: "none"` means **no explicit client checkpoints**, not a guaranteed provider-cache Off state: AWS also supports implicit caching. Five-minute retention is the validated contract; one-hour retention is not advertised. The pinned Pi client falls back to its short checkpoint form when long retention is not supported. No `cf-aig-cache-*` headers, Gateway TTLs, custom keys, policy changes, or provider substitutions are introduced.

## Live evidence, not synthetic capability claims

Direct Gateway probes on 2026-09-12 used the locked Pi 0.85.1 serializer/parser, the local request/response adapter, the existing Bedrock BYOK integration, region `eu-central-1`, and the exact `eu.anthropic.claude-{sonnet,opus}-5` models. They used Runtime `invoke-with-response-stream` for the initial call **and the explicit diagnostic continuation**, with adaptive High, automatic tool choice, a public reusable prefix, and a 2,048-token total-output cap. No real tool ran.

| Evidence | Sonnet | Opus |
| --- | ---: | ---: |
| Initial/replay HTTP | 200 / 200 | 200 / 200 |
| Initial structured thinking tokens | 1,422 | 591 |
| Initial provider cache-write tokens | 7,721 | 7,656 |
| Replay provider cache-read tokens | 7,721 | 7,656 |
| Exact authentic assistant replay | true | true |
| Initial/replay native stop reasons | `tool_use` / `end_turn` | `tool_use` / `end_turn` |
| Pi tool/result handling and usage | Passed | Passed |

The authenticated Gateway log metadata independently reported the same cache-read/write counts. Gateway whole-response status remained MISS / `cached:false`, proving these are **provider input-prefix reads**, not replayed whole answers. Complete assistant arrays contained actual thinking and tool-use blocks; only counts and equality booleans were retained, not their text or signatures.

These initial observations proved native cache-aware signed tool replay and valid Eventstream/Pi protocol handling, but not smooth delivery: public deltas arrived within approximately 1.7 ms (Sonnet) and 2.0 ms (Opus) after multi-second waits. The Gateway then had enabled DLP with `check: ["RESPONSE", "REQUEST"]` and `action: "BLOCK"`. Cloudflare documents complete buffering for DLP-inspected SSE responses.

The operator subsequently disabled **response** inspection. A fresh authenticated read confirmed `check: ["REQUEST"]`, still enabled with `action: "BLOCK"`; the diagnostic agent changed no policy. Fresh High native tool lifecycles then passed again, with 7,722 (Sonnet) and 7,659 (Opus) cached input tokens on exact signed replay. Public text arrived in 48 deltas over 2.158 seconds and 38 deltas over 2.385 seconds respectively, before terminal events and EOF. Both Dynamic Routes also delivered incremental Pi text after the change. This verifies direct Gateway delivery under the observed request-only policy, not a deployed Worker/Pi session or every possible Gateway policy.

The remaining distinct stream-supported native mappings were then tested, each with one initial call and one exact tool-result replay per model:

| Native mapping | Sonnet initial thinking / replay cache-read tokens | Opus initial thinking / replay cache-read tokens |
| --- | ---: | ---: |
| Disabled, no effort | 0 / 7,719 | 0 / 7,649 |
| Adaptive Low | 1,542 / 7,719 | 417 / 7,650 |
| Adaptive Medium | 687 / 7,718 | 485 / 7,652 |
| Adaptive High | 691 / 7,722 | 535 / 7,659 |

Every initial call ended `tool_use`; every exact replay ended `end_turn` and delivered public text incrementally. Off had no thinking blocks. Each enabled initial call had authentic thinking plus a signature, retained unchanged on replay. Effort is not a promise of monotonically increasing token counts. Pi Minimal is an explicit Low alias; Sonnet XHigh/Max are High aliases. Opus XHigh/Max Eventstream remains unverified and is not enabled by this change.

## Dynamic Route boundary

The exact active `bedrock_sonnet` and `bedrock_opus` routes still resolve through Gateway `/compat/chat/completions`. Their existing plain-system Pi tool call/replay works with the existing repeated-complete-tool-name repair. No new Dynamic reasoning levels or cache capability are published.

Do not copy the native Pi cache flag onto Dynamic models: on both inspected routes a public phrase supplied only in a cache-marked array-valued system prompt failed the tool-input integrity canary, whereas string-valued system prompts passed. The token counts also fell from thousands to hundreds in the array case. This establishes a compatibility regression for that input shape, not the internal implementation of Cloudflare's converter. Native success cannot certify Dynamic prefix forwarding or cache accounting.

Keeping the system prompt string-valued while retaining only user/tool checkpoints also passed the integrity and tool-replay tests for both models. However, neither the response nor authenticated Gateway usage metadata exposed cache categories. That narrower experiment therefore does not certify input-cache reuse and is not enabled in the implementation.

The Dynamic profile remains honestly `provider-default`: an opaque response is not evidence for configurable Off/Medium/High. Gateway `/compat` did not expose cache categories or structured reasoning in these calls. Missing counters are not provider-reported zeroes or proof that implicit caching can never occur.

A follow-up non-streaming diagnostic exposed **native Anthropic JSON**, not an OpenAI `choices` envelope. It reported explicit zero cache-read/write counters for a 7,571-token Sonnet input and 7,573/7,585-token Opus inputs despite the user-block checkpoint. Opus returned `refusal`, so those calls are not successful lifecycle evidence. This distinguishes missing SSE accounting from the zero counters actually observed in JSON; it still does not prove the internal cause or that all Dynamic caching is impossible.

The remaining external contract to resolve is Cloudflare's preservation of Bedrock checkpoints and usage during Dynamic `/compat` conversion. An accepted request is not a cache-hit certificate. Require a preserved system-prefix canary and a positive provider-reported cache read on a changed-answer request before enabling Dynamic cache metadata. A custom-provider bridge could avoid that converter but would require a new endpoint and route/provider configuration; it is a different, unverified architecture, not part of these commits.

## Cherry-pick / reimplementation contract

1. Apply the cache-accounting repair first; it is independent and does not change paid request bodies.
2. Apply checkpoint translation and its complete capability plumbing together. Publishing Pi's flag without native translation is incomplete; enabling it provider-wide breaks the Dynamic boundary.
3. The checkpoint commit uses adapter v2; the subsequent streaming-continuation commit uses `bedrock-anthropic-native-v3`. v1/v2 target documents remain readable, but old receipts must not authorize v3. The Opus-auto profile is revision 2 because its recorded transport behavior changed; reasoning mappings did not change. The existing native flow requires explicit administrator confirmation of recorded validation evidence, not an automatic paid verification. Do not fabricate or migrate receipts.
4. Keep all existing Dynamic/compat configuration unchanged. Native region and saved transport identity remain unchanged too. Do not flatten a Dynamic Route into a direct model call or silently migrate an Invoke target.
5. Apply the streaming-continuation commit separately if wanted. It removes forced Invoke after validated tool replay for the already stream-supported mappings. Explicit Invoke targets and automatic Opus XHigh/Max remain Invoke. It does not bypass Gateway response inspection, add fallback, or claim a deployed-session test.

The code comments explain the non-obvious prefix boundaries, trust boundary, signed-state invariants, counter arithmetic, and version invalidation. They deliberately do not claim that caching fixes buffering.

## Reproducible local checks

Run the relevant Vitest adapter/interceptor, native authority, lifecycle, container, and schema suites directly (avoid unrelated generator hooks). Run the real entrypoint jq tests with `node --test --test-isolation=none host/__tests__/entrypoint-enterprise-pi-models.test.js`, and `tsc --noEmit` after the repository's local Worker type generation.

The completed local run passed 577 tests across 14 relevant Vitest files, 20 real-entrypoint jq tests, TypeScript checking, and the offline locked-Pi check below. The cache-accounting regressions and eight encrypted-replay dispatch regressions were observed failing before their respective repairs. New tests hold upstream EOF open while requiring public text from the actual interceptor. This is bounded verification of the changed paths, not a claim that the entire repository or a deployed session was tested.

For the locked client's serializer and parser, install the existing `@earendil-works/pi-ai@0.85.1` dependency in a temporary directory, then run:

```sh
node scripts/verify-bedrock-pi-prompt-cache.mjs /path/to/@earendil-works/pi-ai
```

This test injects its only HTTP implementation, makes **zero network calls**, and uses explicitly synthetic signed-state fixtures. It exercises opt-out/opt-in checkpoint placement, complete tool replay, confidentiality, and the actual Pi cache-token arithmetic. It complements, rather than substitutes for, the live evidence above.

## Streaming boundary

The native adapter streams Eventstream public text incrementally. At the inspected develop baseline, active tool continuations selected Invoke, whose client SSE is synthesized only after complete upstream JSON. The third commit now preserves the stream-supported operation after exact replay validation; the cache-accounting and checkpoint commits remain independent. Explicit Invoke targets and automatic Opus XHigh/Max still have synthesized, non-incremental SSE. Input caching does not change that operation's delivery model. No fake character timers or transport migration are introduced.

## Evidence and references

- [AWS: Prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html).
- [AWS: Claude Sonnet 5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html).
- [AWS: Claude Opus 5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html).
- [Anthropic: Cache usage fields](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance).
- [Cloudflare: Gateway response caching](https://developers.cloudflare.com/ai-gateway/features/caching/).
- [Cloudflare: DLP response buffering](https://developers.cloudflare.com/ai-gateway/features/dlp/).
- [Cloudflare: Dynamic Route `/compat` contract](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/usage/).
- Pi accounting source: `package/dist/api/openai-completions.js::parseChunkUsage` in the [locked 0.85.1 package](https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.85.1.tgz), verified against `preseed/agents/pi/package-lock.json` integrity.

Documentation accessed 2026-09-12. Regression fixtures are synthetic; they contain no live provider thinking or signatures.
