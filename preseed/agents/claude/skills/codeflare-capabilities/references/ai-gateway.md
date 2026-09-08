# Cloudflare AI Gateway, models, routing, and attribution

A long-context investigation and a small correction need not use the same model route. In Pi, you can choose from your approved catalogue while keeping the repository, tools, and working conversation together. Your administrator can manage the backend routing without asking you to rebuild the agent's provider configuration.

I connect those choices through Cloudflare AI Gateway.

A route is a stable handle. Behind it can sit hosted inference or a compatible customer-operated backend. Gateway credentials and route resolution stay at my Worker boundary; you use the choices assigned to your identity rather than carrying provider tokens into the session.

## A route does more than name a model

Dynamic Routes express configured conditional, weighted, limit, and fallback behavior. Your administrator configures that routing while retaining the handle used by the agent. Codeflare Inference Mesh can supply an additional customer-operated backend, but it is optional; hosted providers remain valid defaults or fallbacks.

In Pi, `/model` shows your available catalogue. Context limits and supported reasoning choices help distinguish a route suited to a long investigation from one suited to a smaller task. A model mentioned in conversation does not become selectable merely because I recognize its name.

Backend fallback stays inside the configured route. It does not permit a jump to another route outside your access policy, and it is not a universal promise of automatic failover. The actual route definition determines what happens.

## Compatibility includes the work between answers

An engineering conversation sends more than prose. The model reasons, calls a tool, receives its result, and continues with replayed history. Providers and custom services can express those steps differently.

I use compatibility profiles to connect the route to Pi's expected protocol: supported reasoning, tool calls, and replay behavior. A profile describes how to communicate with the route; it does not declare the backend's brand or certify its answer quality.

Some backends support a binary thinking switch rather than several distinct reasoning strengths. Several displayed levels may therefore map to the same enabled behavior. I expose what the profile supports instead of inventing capabilities from a model name.

## Access follows your organization's policy

Administrators use identity-provider groups supplied through Cloudflare Access to assign route subsets, defaults, and supported default reasoning. The first matching configured policy wins. Membership in several groups does not produce a union of all their routes.

An empty subset in that first match denies access. An optional unmatched-user fallback can grant its own subset and defaults; if absent or disabled, unmatched users receive no routes. That access fallback is separate from fallback among backends inside a route.

I apply the saved access policy and compatibility profile before inference. Request attribution is attached at the Worker boundary so gateway observations can be associated with the calling user. An available route is something you may use, not an administrator permission over its configuration.

## Make a route usable without turning setup into guesswork

For a known route, an administrator can select an existing profile directly. **Discover Profile** is the optional investigation path: look for matching profiles or produce a custom draft when the existing profiles do not fit. **Assign profile** selects an existing match; **Create & Assign** names and selects a new immutable custom revision in the draft.

There are two explicit ways to establish authority for the selected profile:

- **Verify Profile** performs a live compatibility check. It reports Compatibility, Tool call, and Tool replay for supported levels, with diagnostics under **Technical check details**.
- **Mark as verified** records **Administrator-confirmed** authority when the administrator already knows the profile fits. It performs no paid model probes and does not claim a live test passed.

Both work on the current draft. There is no need to save first or invent a custom-backend description. The administrator assigns group access and defaults, chooses **Review changes**, and then **Confirm Save**. Back to edit preserves the draft. Discovery and confirmation do not silently activate configuration.

For new administrator defaults, reasoning preference is Medium, then Off, then the first supported level. That ordering never adds unsupported reasoning to a route.

## Keep the evidence attached to what was checked

A live check covers the observed path, not every conditional or fallback backend. An untested-backend warning identifies that gap. Administrator confirmation instead makes clear that no live check ran. These warnings require acknowledgment during Save, but acknowledgment cannot replace missing or stale authority.

If rate limiting interrupts discovery, completed matches remain selectable beside the notice. Neither discovery nor verification retries automatically; another check is an explicit action and can use provider capacity. A changed profile or route draft requires a fresh check or explicit administrator confirmation before access is saved.

When a call fails, I interpret the relevant evidence without exposing credentials or extending a result beyond the path checked.

For your daily work, the interface is much simpler: an approved catalogue, supported reasoning choices, and the task in front of you. Provider credentials, route policy, protocol translation, and attribution are handled around the conversation. You choose the available capability that fits the work; you do not have to become its gateway operator.
