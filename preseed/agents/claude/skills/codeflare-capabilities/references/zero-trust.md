# Cloudflare Access identity, session ownership, and Zero Trust ingress

## What I do

I continue your work after you sign in from a desktop, tablet, or phone while keeping the session attached to you. You do not need to administer Cloudflare Access to use a workspace your organization has admitted you to.

In an Access-backed deployment, I work behind Cloudflare Access for ingress identity. The application starts with an authenticated identity instead of asking each internal tool to invent one. The Worker verifies the Cloudflare Access assertion, resolves the admitted user, and binds sessions, storage, administration, and connected credentials to that identity.

Each user's session is tied to the user's own storage bucket and container identity. A browser-supplied bucket name, email header, hostname, or session ID is not allowed to choose another user's resources. Administrative surfaces require the administrator role, while application admission follows the configured Cloudflare Access policy and groups.

I keep working under the same identity boundary on desktop, tablet, and phone. Switching devices changes the browser. It does not change who owns the session. That is useful when you leave a desktop investigation running and return from another device: I work with your session and files, not a new identity inferred from a browser field.

Your administrator configures admission and group policy. If a connected repository or model route is unavailable, I help you distinguish that service's permissions from workspace sign-in. Successfully reaching the workspace is only the first of those checks.

## Where the boundary sits

This page describes Access-backed sign-in; other configured deployments use Worker-managed GitHub OAuth. Cloudflare Access does not inspect arbitrary outbound traffic, replace GitHub branch protection, or prove that a downstream SaaS accepted the right authorization. Those belong to different controls.

A valid identity also does not grant universal access. Repository permissions, organization policy, storage ownership, and connected-service authorization still apply. If the signed-in user cannot read a private repository, I cannot solve that with enthusiasm.

## Try it

Ask me:

> Help me continue this repository investigation from another device. Explain how I reconnect to my session and which state depends on the container still running.

Other useful requests:

- “I sign in to the workspace but cannot open this repository. Help me identify which connection or permission I need.”
- “Explain which resources belong to my session and which settings require an administrator.”
- “I am building an authenticated application. Review how this resource route binds the signed-in user to ownership, and propose a tested correction.”
