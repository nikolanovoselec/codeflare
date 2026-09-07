# Credential interception and secret boundaries

A Git client needs permission to access a repository. It does not necessarily need the reusable token sitting in its environment. For supported intercepted connections, I separate those two things: the client performs the work, while authorization is attached outside the container.

You can use familiar clients and workflows without distributing the underlying service credential to every process in a root-capable session.

## What happens to a supported request

The container uses a non-secret placeholder where the client expects authorization. At my Worker boundary, the interceptor recognizes the exact supported destination, resolves the identity already bound to the session, removes the placeholder, and supplies the appropriate credential.

A lookalike hostname does not qualify. A caller-provided user ID cannot select whose token to use. The request does not gain authority by claiming to belong to another bucket or account.

The service receives an authorized request; the workload still does not receive the reusable secret. Upstream permissions remain in force, including repository access and protected operations.

That arrangement matters precisely because the session is useful: its tools can inspect files, run processes, and examine their own environment. Keeping a token outside that environment is a technical separation, rather than a reminder to avoid printing it.

## Different services need different handling

With GitHub interception configured, I support the relevant repository, web, and API traffic under the connected user's access. Missing repository permission stays a permission problem; it is not solved by substituting an administrator's token.

Model interception routes supported inference traffic through Cloudflare AI Gateway, keeping gateway authorization and route resolution at the trusted boundary. A model route still has to be allowed for the user and compatible with the agent's protocol.

Browser Rendering needs both ordinary API calls and interactive browser-control connections. Its interceptor handles the supported account-scoped authorization, including the WebSocket path used for browser control.

Supported Cloudflare OAuth connections also require refresh handling. I obtain current authorization at the boundary for supported requests instead of letting a long-running session depend on a reusable access token copied into its shell at startup.

With strict storage interception, I validate the bound storage identity and sign requests for the exact user's bucket. A storage request cannot fall back to an account-wide management credential when its scoped authorization is missing.

These paths preserve the client's transport needs—authorization formats, streams, and supported WebSockets—while keeping credential selection under trusted ownership.

## Connect once through the supported flow

You authorize your user connections through the appropriate connection surface. Administrators configure shared gateway and browser-service connections. I can then work with the access supplied by those connections without asking you to retrieve and paste their tokens.

If a call fails, I distinguish an absent connection, expired authorization, insufficient service permission, an unsupported destination, and a network policy decision. I use the error and configuration evidence without exposing credentials. A valid workspace login does not automatically provide all of these connections.

## Containment is specific

Interception covers named services and configured paths. Deployments without GitHub interception can pass a real token into the container; an unrelated project secret placed in an environment variable is visible to processes allowed to read it. I do not describe those paths as Worker-side containment.

Network enforcement is another layer. With Strict Gateway Egress enabled, supported direct-internet web traffic follows customer Gateway policy, while raw TCP and UDP internet egress is denied. Scoped platform exceptions keep their own authorization checks.

A permitted API request may publish, delete, deploy, or spend money, so protected actions still need your explicit scope. Credential containment and permission to act remain separate.

Within that scope, you can use familiar repository, model, browser, and storage workflows while their supported reusable credentials stay outside the workload. The client does its job; my trusted boundary supplies the authorization it is entitled to use.
