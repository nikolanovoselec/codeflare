# Credential interception and secret boundaries

## What I do

I work with your connected GitHub repositories, use available model routes, and make supported browser calls without asking you to paste reusable service credentials into a terminal. Where the relevant credential interceptor is configured and the connection is authorized, I use ordinary supported clients. You can spend the session on the repository rather than token plumbing.

For GitHub, I inspect an issue, read a pull request, or prepare a change using the signed-in user's connected access. With GitHub interception enabled, the reusable GitHub token stays outside the container: a Worker-side interceptor recognizes an exact allowlisted destination, validates the bound session identity, removes the non-secret placeholder, and adds authorization at the boundary. The placeholder is not a credential you need to look up or copy.

I use the same separation for supported model traffic through Cloudflare AI Gateway and for Browser Rendering calls whose account authorization is added outside the shell. With strict web egress, storage requests pass through a controller that checks the bound storage identity and re-signs them for your exact bucket. I process your synchronized files without gaining access to another user's bucket.

## When a connection needs attention

I distinguish a missing connection from a repository permission problem. Connecting GitHub does not grant access to every repository, and selecting an available model route does not make you its administrator. If access is missing, I explain the supported connection step or what to ask your administrator to enable. I do not ask you to print a token so I diagnose it.

An administrator configures the shared gateway and browser-service boundaries; you authorize your own supported user connections. Named interceptors cover named services, not every secret an arbitrary script might use. Deployments without GitHub interception can pass the token into the container; I do not promise Worker-side containment on that path. If a project asks for an unrelated secret in an environment variable, I point out that processes allowed to read that variable inside the container can see it.

## Where the boundary sits

A similar-looking hostname is not an approved destination, and a user ID sent by the container cannot choose the session identity. The Worker owns those checks. I cannot turn an unconnected client into an authorized one by changing a proxy variable.

With Strict Gateway Egress enabled, direct-internet HTTP, HTTPS, and WebSocket traffic passes through Cloudflare Gateway, raw TCP and UDP internet egress is denied, and configured DLP policy detects or blocks matching transfers of sensitive data. That is useful protection, not a reason to paste secrets into chat. Own-account control-plane exceptions have separate authorization and audit boundaries; actual protection depends on the configured path and policy.

## Try it

After connecting your GitHub identity through the supported connection flow, ask me:

> Read this repository's open issue and the linked pull request. Explain what remains to be fixed, without changing either one or printing credentials.

Other useful requests:

- “Prepare a pull request description from my local changes. Stop before publishing it.”
- “Process this file from my synchronized storage and put the result in a durable folder.”
- “This project asks me to put a service secret in the shell. Explain whether a supported connection can keep it outside the container instead.”
