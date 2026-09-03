# Secure Web Gateway, inspection, malware, and DLP

## What I can do

I can work inside a session whose direct-internet HTTP, HTTPS, and WebSocket traffic passes through the corporate Secure Web Gateway. Existing organization policy can allow, block, isolate, inspect for malware, and apply data-loss-prevention rules to that traffic. The point is to reuse the controls the security team already operates, not create a second pretend firewall in a developer settings page.

Strict egress fails closed. The session establishes its interception transport before agent work begins. If the Gateway path is unavailable, web traffic does not quietly fall back to unrestricted global access. Raw TCP and UDP internet egress is denied.

Named credential interceptors keep their exact destinations and still use the strict transport where their contract requires it. Unmatched web traffic goes through the catch-all controller and receives the customer's policy result.

## Where the boundary sits

Not every byte crosses the Gateway. Codeflare's own-account control-plane destinations have documented direct exceptions, including bounded storage and account-scoped service paths with their own authorization and audit surfaces. Claiming otherwise would make the diagram tidier and the security review worse.

Gateway enforcement also cannot promise which malware, DLP, retention, or isolation rule exists. Those are customer policy. Verification requires the matching Gateway event, action, and rule, not merely a successful HTTP response.

## Try it

Choose one destination allowed by corporate policy and one safe test destination that policy blocks. Ask me to call both, then correlate the observed result with Gateway activity and the exact rule that decided it.

Other useful requests:

- “Check whether this package registry request is allowed by policy evidence.”
- “Compare one blocked URL and one allowed URL without bypassing Gateway.”
- “Trace a malware or DLP block to the exact Gateway decision.”

Source anchors: `sdd/spec/enterprise-mode.md` REQ-ENTERPRISE-016/023/024/028/029, `src/egress-controller.ts`, `documentation/lanes/security.md`, and AD85/AD86 in `documentation/decisions/README.md`.
