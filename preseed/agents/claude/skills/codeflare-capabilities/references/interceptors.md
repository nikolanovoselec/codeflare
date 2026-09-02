# Credential interception and secret boundaries

## What I can do

I can use ordinary command-line clients while selected credentials stay outside the container. Worker-side interceptors recognize exact owned destinations, validate the bound session identity, remove non-secret placeholders, and add the real authorization only at the egress boundary.

GitHub traffic can use the signed-in user's encrypted token for allowlisted GitHub hosts. Supported model traffic can be routed through the configured model gateway. Browser Rendering calls can receive their account authorization without placing the long-lived token in the shell environment.

For strict web egress, the catch-all controller separately checks the bound storage identity and re-signs S3-compatible requests for the user's exact bucket. The container can work with the storage service without gaining a reusable credential for somebody else's bucket.

## Where the boundary sits

A hostname that looks similar is not an approved destination. A user ID supplied by the container is not session identity. A proxy variable is not a security boundary. The Worker owns all three decisions.

Named interceptors cover named services. They are not a universal secret manager, and they do not make every environment variable harmless. I inspect the actual egress path before saying a credential never enters the container.

## Try it

Ask me to trace `gh api user` from the placeholder inside the session to exact-host validation, user-token resolution, and upstream authorization, without printing either credential.

Other useful requests:

- “Show where GitHub auth is injected without exposing the token.”
- “Trace an S3-compatible storage request to the exact bucket binding.”
- “Verify whether this outbound call uses a placeholder, an interceptor, or no credential.”

Source anchors: `src/container/container-interception.ts`, `src/github-interceptor.ts`, `src/llm-interceptor.ts`, `src/egress-controller.ts`, `sdd/spec/enterprise-mode.md` REQ-ENTERPRISE-004/005/011/024/026, and `sdd/spec/browser-run.md` REQ-BROWSER-008.
