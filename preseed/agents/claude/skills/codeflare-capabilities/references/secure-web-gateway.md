# Secure Web Gateway and governed egress

**Availability:** Governed Enterprise deployment with strict egress and customer Gateway configuration enabled.

## What I can do

I can work in a session where named interceptors retain their exact destinations, such as GitHub, AI Gateway, and Browser Rendering, while unmatched HTTP, HTTPS, and WebSocket traffic uses the customer's Cloudflare Gateway path. The strict catch-all controller also owns account-scoped re-signing for the bound user R2 bucket. Raw TCP and UDP internet egress remain outside that catch-all contract.

Strict mode fails closed. Startup must establish the interception transport before agent work begins, and the egress controller validates destination and session context. I do not treat permissive proxy variables inside the container as a security boundary.

## Why the boundary matters

A successful request is not enough evidence. The operator needs the corresponding Gateway action and policy result. If strict egress is unavailable, the answer is to configure Governed mode or correct one narrow owned route, not weaken the catch-all until a tool happens to work.

The customer owns Gateway policy. An ordinary coding session cannot invent allow rules, attribution fields, retention, or DLP behavior that the account has not configured.

## Try it

Operator task: choose one destination allowed by policy and one deliberately blocked test destination. Run both from a fresh governed session, then inspect Gateway activity for destination, action, and rule plus any customer-configured attribution. An allowed response without the expected policy evidence is not a passed check.

Source anchors: `sdd/spec/enterprise-mode.md` REQ-ENTERPRISE-016/023/024/028/029, `src/egress-controller.ts`, and `documentation/lanes/deployment.md`.
