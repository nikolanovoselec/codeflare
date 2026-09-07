# Cloudflare Gateway, inspection, malware, and DLP

## What I do

I research documentation and work with a project's web dependencies under your organization's outbound policy. You do not need to configure a proxy for every task. If a dependency download is blocked, I help identify the destination the project needs and explain the next step instead of trying to evade the block.

With Strict Gateway Egress enabled, I route direct-internet HTTP, HTTPS, and WebSocket traffic through Cloudflare Gateway, which enforces the customer's configured allow, block, isolation, malware-inspection, and DLP rules. The transport starts before agent work, fails closed if Cloudflare Gateway is unavailable, and denies raw TCP and UDP internet egress.

Destination-specific credential interceptors keep their exact routes. Remaining web traffic uses the catch-all controller and inherits the customer's policy decision.

Your administrator owns the Cloudflare Gateway rules for allowed destinations, inspection, malware, and data-loss prevention. Configured blocking rules reject web requests that match their destination or sensitive-data criteria. I work under the policy that is actually configured; enabling the transport does not automatically create all those protections.

## Where the boundary sits

Codeflare's own-account control-plane and bounded storage paths are scoped direct exceptions with separate authorization and audit boundaries. The customer owns Cloudflare Gateway policy; Codeflare neither creates it nor infers a DLP or malware decision from a successful request. I verify those decisions against the matching event, action, and rule when that evidence is available.

## Try it

Ask me:

> This dependency download was blocked. Use the existing error and project configuration to explain what destination is needed and draft a narrow request for my administrator. Do not retry the download or bypass the policy.

For a new project, I also prepare its destination list before anyone tries to install it. I separate HTTP, HTTPS, and WebSocket calls from raw TCP or UDP requirements, so a database client that needs a direct TCP connection does not become a surprise halfway through setup.

Other useful requests:

- “Review this project's documented network requirements before I start using it here.”
- “Explain whether this workflow sends sensitive files to an external service, using its configuration without running it.”
