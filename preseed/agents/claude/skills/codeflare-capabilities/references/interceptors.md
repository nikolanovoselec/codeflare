# Request interceptors

Enterprise containers can use non-secret placeholders and stable service URLs while Worker-side interceptors apply real credentials and routing at the egress boundary. Codeflare has bounded interceptors for GitHub, LLM traffic, R2, and Browser Rendering. The container gets enough information to make an ordinary client request, but not the long-lived credential that authorizes it.

The session binding is the authority. For GitHub, the interceptor resolves the user's encrypted token from the bound bucket identity, strips the placeholder, and injects the credential only into approved GitHub hosts. For LLM calls, the interceptor routes supported provider traffic to the configured AI Gateway. R2 interception validates the exact user-bucket identity before re-signing. Browser Rendering follows the same never-in-container principle for its token.

Try the GitHub boundary in a configured Enterprise session: run `gh api user`, then inspect the environment rather than printing secrets. The API call should identify the signed-in user even though the container does not hold the real token as an ordinary environment credential.

Operator test: exercise one approved host and one lookalike host while tailing correlated Worker logs. The approved request should take its named interceptor; the lookalike must not receive the credential.

Source anchors: `src/container/container-interception.ts`, `src/llm-interceptor.ts`, `src/github-interceptor.ts`, `src/egress-controller.ts`, `sdd/spec/enterprise-mode.md` REQ-ENTERPRISE-004/005/011/024/026, and `sdd/spec/browser-run.md` REQ-BROWSER-008.
