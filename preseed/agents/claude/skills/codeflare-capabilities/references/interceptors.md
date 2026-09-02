# Request interceptors and credential boundaries

**Availability:** Enterprise deployment. Each named interceptor also requires its operator-owned credential or route configuration. Bound R2 credential isolation requires strict Gateway egress.

## What I can do

I can use ordinary client interfaces inside the container while Worker-side interceptors apply real credentials and routing at the egress boundary. Codeflare has bounded named interceptors for GitHub, supported model traffic, and Browser Rendering. The container receives a stable service URL or non-secret placeholder instead of the long-lived credential for those paths.

For GitHub, I can make an approved request while the interceptor resolves the current user's encrypted token from the bound bucket identity, strips the placeholder, and injects the credential only for allowlisted GitHub hosts. For model calls, the LLM interceptor can route supported provider traffic to the configured AI Gateway. Browser Rendering follows the same never-in-container token boundary. In strict Enterprise egress, the catch-all controller separately checks the exact bound user-bucket identity before re-signing R2 requests; strict-off sessions retain the real R2 key.

## Why the boundary matters

The session binding owns identity. A container-supplied hostname or user ID does not. Lookalike destinations must not receive credentials, and one session must not select another user's token. A proxy environment variable alone would not enforce either rule.

## Try it

User task: in a configured Enterprise session, run `gh api user`, then inspect credential presence without printing secret values. The call should identify the signed-in user even though the real token is not an ordinary container credential.

Operator task: exercise one approved GitHub host and one deliberate lookalike while following correlated Worker logs. Only the approved request should take the named credential path.

Source anchors: `src/container/container-interception.ts`, `src/llm-interceptor.ts`, `src/github-interceptor.ts`, `src/egress-controller.ts`, `sdd/spec/enterprise-mode.md` REQ-ENTERPRISE-004/005/011/024/026, and `sdd/spec/browser-run.md` REQ-BROWSER-008.
