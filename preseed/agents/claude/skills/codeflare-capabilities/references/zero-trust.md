# Cloudflare Access identity, session ownership, and Zero Trust ingress

I give you and your agents a root-capable Linux session: real files, development tools, and the ability to change the repository within your approved scope. I keep the decisions about whose resources that workload may use outside the environment itself. The tools can remain capable without owning the control plane that authorizes them.

That separation starts before the terminal opens and continues through the editor, storage, model routes, and connected services. There is no single “trusted user” switch that unlocks everything.

## Admission is the first decision

In an Access-backed deployment, Cloudflare Access sits in front of the application. Your organization uses its identity provider and Access policies to decide who may enter. My Worker verifies the Access assertion and resolves the admitted user; a caller-supplied email header is not accepted as proof of identity.

I bind the working session to that user. Browser terminals, the IDE, and private files do not each need an unrelated login scheme or a shared password distributed to the team. You can reach the workspace from another device while retaining the same identity and ownership checks.

Other configured deployments use Worker-managed GitHub OAuth instead. Signing in and connecting GitHub for repository operations are distinct actions: one establishes application identity, the other supplies a supported service connection.

## A session ID is not a permission

I bind each session to its authenticated owner and connect that identity to the user's storage bucket. The browser cannot nominate somebody else's bucket, email, or session identifier and thereby acquire their resources. Administrative routes require administrator authority rather than merely a valid login.

The Browser IDE is another authenticated surface into the selected session, not a public editor service. Its workspace is fixed by the platform. Changing a folder selector does not turn it into a browser for another session's files.

Storage is per user; compute is per session. Two of your sessions may work with the same synchronized material, but another user's bucket is not part of that arrangement. Bucket-scoped access keeps a session's storage work from becoming account-wide object-storage authority.

## Reaching a service is another decision

Once inside, I still need the permissions that belong to the work:

- GitHub decides which repositories the connected identity can access and which protected operations it may perform.
- Model-route policy decides which routes and reasoning choices are made available to you.
- Configured MCP Portals govern entry to approved servers; upstream systems retain their own authorization.
- With Strict Gateway Egress enabled, customer network policy governs direct-internet web destinations outside the container's own proxy configuration.

These controls answer different questions. Cloudflare Access establishes ingress identity; it does not inspect arbitrary outbound traffic. A permitted network destination does not grant a repository permission. An approved model route does not make its user an administrator.

That is why I distinguish a connection problem from a permission problem instead of asking you to paste a more powerful token into the shell.

## Where root stops

Inside the session, tools and trusted extensions remain capable of changing files and executing code. My server-side ownership checks, supported credential interceptors, and configured egress controls retain their authority outside that workload. Root in the session is not root over my deployment's control plane.

For supported intercepted services, I let workload clients make authorized calls while retaining the reusable credential at my Worker boundary. The precise credential and network protections depend on the configured path; they are explained in the interception and Gateway pages. They do not make an allowed destructive API call harmless.

I follow your scope and seek explicit authorization for protected actions. Those engineering instructions complement the platform's technical boundaries. Neither should be confused with a guarantee that an agent can never make a mistake.

## Using the workspace

You should be able to sign in, open your session, and work without administering each layer. If something is unavailable, I locate the relevant decision: admission, session ownership, administrator role, connected-service permission, model policy, or network rule. I explain what needs changing and who owns that change, rather than trying to bypass it.
