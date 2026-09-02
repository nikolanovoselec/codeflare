# AI Gateway, models, routing, and attribution

## What I can do

I can send supported model traffic through the organization's AI Gateway instead of binding engineering work to one provider account. The route catalog can select hosted providers or customer-operated inference, apply model policy, set context limits, and attach user attribution at the Worker boundary.

A session can use a stable route handle while the Worker resolves the actual gateway destination. That lets operators change the model behind a governed route without rewriting every agent configuration or leaking the gateway credential into the container.

I can inspect routing configuration, trace request rewriting, verify the selected model path, and correlate the call with Gateway analytics. I can also keep different agent tasks on different reviewed routes when the catalog supports them.

## Where the boundary sits

The gateway routes and observes model traffic. It does not guarantee model quality, provider availability, automatic failover, lower cost, or a fixed latency. Those claims need measurements and configured policy, not a logo.

Only the request fields owned by the routing contract are rewritten. A successful response proves that one call completed. It does not prove attribution, policy, or route selection unless the corresponding Gateway evidence agrees.

## Try it

Ask me to trace one model call from the session's route handle through Worker-side resolution to the AI Gateway event, including the effective model, user attribution, and context limit.

Other useful requests:

- “Show which model route this session uses and where attribution is attached.”
- “Compare two reviewed routes for a long-context refactor and a cheap lint-fix pass.”
- “Trace a failed model call without printing secrets.”

Source anchors: `src/llm-interceptor.ts`, `src/lib/aig-config.ts`, `sdd/spec/enterprise-mode.md` REQ-ENTERPRISE-004/005/012/017, and `documentation/lanes/configuration.md`.
