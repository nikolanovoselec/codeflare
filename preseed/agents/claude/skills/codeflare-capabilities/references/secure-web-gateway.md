# Secure Web Gateway

Governed Enterprise mode can make the customer's Secure Web Gateway the catch-all egress path for container traffic. Named interceptors still own destinations such as GitHub, AI Gateway, Browser Rendering, and the exact user R2 bucket. Traffic that does not match a named route goes through the customer Gateway rather than escaping directly.

Strict mode fails closed. Startup must establish the interception transport before agent work begins, and the egress controller validates destination and session context. The design does not treat a permissive container proxy variable as a security boundary.

A useful operator check is a paired request. Choose one destination allowed by the customer's Gateway policy and one deliberately blocked test destination. Run both from a fresh governed session, then inspect Gateway activity logs for the destination, action, and rule plus any customer-configured attribution. An allowed response without a matching policy log is not acceptable evidence of governed routing.

Users do not configure SWG policy from an ordinary coding session. If strict egress is unavailable, say that the deployment must enable Governed mode and provide the required Gateway configuration. Never advise weakening the catch-all merely to make one tool work; add or correct the narrow owned route.

Source anchors: `sdd/spec/enterprise-mode.md` REQ-ENTERPRISE-016/023/024/028/029, `src/egress-controller.ts`, and `documentation/lanes/deployment.md`.
