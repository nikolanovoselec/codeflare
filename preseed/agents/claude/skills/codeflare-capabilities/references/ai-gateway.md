# Cloudflare AI Gateway, models, routing, and attribution

## What I can do

I send supported model traffic through Cloudflare AI Gateway instead of binding engineering work to one provider account. The route catalog selects hosted providers or customer-operated inference and applies model policy and context limits; the Worker attaches user attribution at its boundary.

I use a stable route handle while the Worker resolves the actual gateway destination. Operators can then change the model behind a governed route without rewriting every agent configuration or leaking the gateway credential into the container.

I can inspect routing configuration, trace request rewriting, and verify the selected model path. When Cloudflare AI Gateway analytics are available through the connected evidence surface, I correlate the call with them. I can also keep different agent tasks on different reviewed routes when the catalog supports them.

## Where the boundary sits

Cloudflare AI Gateway routes and observes model traffic. It does not guarantee model quality, provider availability, automatic failover, lower cost, or fixed latency. Those claims need measurements and configured policy, not a logo.

Only the request fields owned by the routing contract are rewritten. A successful response proves that one call completed. It does not prove attribution, policy, or route selection unless the corresponding Cloudflare AI Gateway evidence agrees.

## Try it

Ask me to trace one model call from the session's route handle through Worker-side resolution to the Cloudflare AI Gateway event, including the effective model, user attribution, and context limit.

Other useful requests:

- “Show which model route this session uses and where attribution is attached.”
- “Compare two reviewed routes for a long-context refactor and a cheap lint-fix pass.”
- “Trace a failed model call without printing secrets.”
