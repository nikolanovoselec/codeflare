# Cloudflare Gateway, inspection, malware, and DLP

## What I can do

With Strict Gateway Egress enabled, I route direct-internet HTTP, HTTPS, and WebSocket traffic through Cloudflare Gateway, where the customer's existing policy can allow, block, isolate, inspect for malware, or apply DLP. The transport starts before agent work, fails closed if Cloudflare Gateway is unavailable, and denies raw TCP and UDP internet egress.

Destination-specific credential interceptors keep their exact routes. Remaining web traffic uses the catch-all controller and inherits the customer's policy decision.

## Where the boundary sits

Codeflare's own-account control-plane and bounded storage paths are scoped direct exceptions with separate authorization and audit boundaries. The customer owns Cloudflare Gateway policy; Codeflare neither creates it nor infers a DLP or malware decision from a successful request. I verify those decisions against the matching event, action, and rule when that evidence is available.

## Try it

Paste this request:

> Inventory the external destinations this project needs for install, build, test, and runtime. Separate HTTP, HTTPS, and WebSocket traffic from raw TCP or UDP, identify which calls carry credentials, and produce a least-privilege destination list I can give my Cloudflare Gateway administrator.
