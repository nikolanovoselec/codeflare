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

Invoke JSON, Invoke's synthesized SSE and Eventstream's terminal SSE use this one conversion. The change does not alter model requests, cache checkpoint placement, reasoning controls, saved transport, signed replay, Gateway headers, or verification identity. It is an accounting repair, not a live cache-hit certification. Pi's OpenAI parser does not separately price one-hour writes; do not claim exact mixed-TTL billing from the aggregate alone.

## Streaming boundary

The existing adapter streams native Eventstream public text incrementally. Active tool continuations still select Invoke under REQ-ENTERPRISE-077, and Invoke's client SSE is synthesized only after the complete upstream JSON response. Input caching does not make that operation incremental. Changing continuation dispatch requires its own authentic replay and streaming evidence; this accounting repair does not change it.

## Evidence and references

- [AWS: Prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html).
- [AWS: Claude Sonnet 5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html).
- [AWS: Claude Opus 5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html).
- [Anthropic: Cache usage fields](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance).
- [Cloudflare: Gateway response caching](https://developers.cloudflare.com/ai-gateway/features/caching/).
- Pi accounting source: `package/dist/api/openai-completions.js::parseChunkUsage` in the [locked 0.85.1 package](https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.85.1.tgz), verified against `preseed/agents/pi/package-lock.json` integrity.

Documentation accessed 2026-09-12. Regression fixtures are synthetic; they contain no live provider thinking or signatures.
