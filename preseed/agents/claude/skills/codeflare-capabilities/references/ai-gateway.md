# Cloudflare AI Gateway, models, routing, and attribution

## What I do

I use the available dynamic routes through Cloudflare AI Gateway to work with hosted models or customer-operated backends. Codeflare Inference Mesh is one optional custom provider, not a requirement for using dynamic routes. A route is a stable handle for the work: the administrator manages its backend routing without asking you to rewrite agent configuration. You do not need provider tokens or gateway credentials to use the routes made available to you.

For a difficult refactor, I help you choose an available route with suitable context and supported reasoning. For a small correction, I work with a lighter available choice. In Pi, `/model` shows the choices available to you. I work within that catalog; a model name mentioned in conversation does not make it selectable.

Pi compatibility describes how I communicate with the route: reasoning, tool calls, and replay of conversation history. It is not a declaration of provider identity. A route backed by a custom service still needs the behavior Pi expects, especially when I resume a conversation or continue after a tool result. A plausible answer to one prompt is not enough to establish that compatibility.

## How an administrator makes routes usable

I help an administrator load the available dynamic routes through the saved AI Gateway connection. For a known route, the administrator selects an existing compatibility profile directly. **Discover Profile** is the optional way to find matching profiles or generate a custom draft when the existing profiles do not fit. **Assign profile** selects an existing match; **Create & Assign** names and selects a new immutable custom revision in the draft.

The administrator chooses **Verify Profile** for a live compatibility check, or **Mark as verified** when they already know the selected profile fits the route. Mark as verified records an **Administrator-confirmed** status without paid model probes; it does not claim a successful live test. Both work on the current draft, without saving first or filling in custom-backend descriptions.

Next, the administrator assigns the route to at least one group, chooses supported route and reasoning defaults, then selects **Review changes** and **Confirm Save**. Back to edit preserves the draft. Discovery, profile selection, and either confirmation action do not silently save or activate configuration.

I use the reasoning controls the profile actually supports. A binary-thinking mapping distinguishes thinking on/off; several displayed levels may map to the same enabled behavior rather than distinct reasoning strengths.

The runtime profile applies route-wide. Live verification or explicit administrator confirmation makes a route eligible. An untested-backend warning identifies gaps in a live check: the observed path was checked, not every conditional or fallback leg. Administrator confirmation instead warns that no live compatibility check was performed. These warnings require acknowledgment during Save. Missing or stale authority requires a fresh check or explicit confirmation; acknowledging a warning alone does not replace either action. Backend fallback within a route remains inside that route's configured routing, not permission to switch to a route outside your access policy.

## When a check does not finish

An incomplete check is not proof that a profile is incompatible. If rate limiting interrupts Discover Profile, completed matches remain selectable beside a rate-limit notice. When no match or custom draft is available, discovery explains the result instead. Neither discovery nor verification retries automatically; another check is an explicit action and uses provider capacity.

Verify Profile shows Compatibility, Tool call, and Tool replay for each supported level. Open **Technical check details** for the selected-profile check's diagnostics. If the profile or route configuration changes, verify or explicitly confirm the changed draft again before saving access to it. I help interpret those results without asking an ordinary user for gateway credentials or operator analytics.

## Which choices I use for you

An administrator uses identity-provider groups supplied through Cloudflare Access to assign route subsets, a default route, and supported default reasoning. The first matching configured policy wins. I do not receive a union of every matching group's routes. An empty route subset in that first match denies access; it does not fall through to a later policy.

An optional unmatched fallback policy gives users who match no group policy its own route subset and defaults when an administrator enables it. If that fallback is absent or disabled, unmatched users receive no routes. This access fallback answers “which routes may this user use?” It is separate from backend fallback inside an allowed route.

For new administrator defaults, reasoning preference is Medium, then Off, then the first supported level. That does not add unsupported reasoning to a route. I use the choices the saved policy and compatibility profile actually support.

## What that gives you

I keep engineering work on stable, governed routes while the administrator manages the backend connections. The Worker resolves the gateway destination and attaches user attribution at its boundary; route policy and context limits still apply. Where connected evidence is available, I help investigate a failed call without exposing secrets. You should not have to become a gateway operator to ask me to fix a bug.

Cloudflare AI Gateway provides routing, attribution, and observability. I do not promise model quality, provider availability, automatic failover, lower cost, or fixed latency without the relevant configuration and evidence. One completed response proves that call completed, not that every backend or policy path was verified.

## Try it

In Pi, open `/model` to see your available choices, then ask me:

> Help me choose among my available routes for a long-context refactor. Explain which supported reasoning setting fits the task, then help me plan the work. Do not change administrator settings.

Other useful requests:

- “Explain why this route offers different reasoning choices from the one I used before.”
- “Help me continue this investigation using the routes available to my account.”
- “I administer this workspace. Help me select a profile or use Discover Profile, then explain live verification versus marking it as verified myself. Help me assign group access and defaults, and stop at Review changes before Confirm Save.”
