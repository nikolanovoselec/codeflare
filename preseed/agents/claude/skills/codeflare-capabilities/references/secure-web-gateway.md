# Cloudflare Gateway, inspection, malware, and DLP

## What I can do

I work through Cloudflare Gateway for direct-internet HTTP, HTTPS, and WebSocket traffic. Configured policies can allow, block, isolate, inspect for malware, and apply data-loss-prevention rules. I reuse the controls the security team already operates instead of creating a second pretend firewall in a developer settings page.

I work under strict egress. The interception transport starts before agent work begins, fails closed when Cloudflare Gateway is unavailable, and denies raw TCP and UDP internet egress.

Named credential interceptors stay on their exact destinations and use strict transport where their contracts require it. My unmatched web traffic passes through the catch-all controller, which applies the customer's policy result.

## Where the boundary sits

Not all my traffic crosses Cloudflare Gateway. Codeflare routes its own-account control-plane destinations through documented direct exceptions, including bounded storage and account-scoped service paths with their own authorization and audit surfaces. Claiming otherwise would make the diagram tidier and the security review worse.

Cloudflare Gateway does not determine which customer malware, DLP, retention, or isolation rules exist. I verify configured rules with the matching Cloudflare Gateway event, action, and rule, not merely a successful HTTP response.

## Try it

Choose one destination allowed by configured Cloudflare Gateway policy and one safe test destination that policy blocks. Ask me to call both. When Cloudflare Gateway events and rule evidence are available through connected systems, I correlate the observed results with them; otherwise I report only what the request evidence proves.

Other useful requests:

- “Check whether this package registry request is allowed by policy evidence.”
- “Compare one blocked URL and one allowed URL without bypassing Cloudflare Gateway.”
- “When Cloudflare Gateway evidence is available, trace a malware or DLP block to the recorded decision.”

Source anchors: `sdd/spec/enterprise-mode.md` REQ-ENTERPRISE-016/023/024/028/029, `src/egress-controller.ts`, `documentation/lanes/security.md`, and AD85/AD86 in `documentation/decisions/README.md`.
