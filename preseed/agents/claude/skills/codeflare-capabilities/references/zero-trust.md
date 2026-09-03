# Cloudflare Access identity, session ownership, and Zero Trust ingress

## What I can do

I work behind Cloudflare Access for ingress identity. The application starts with an authenticated identity instead of asking each internal tool to invent one. The Worker verifies the Cloudflare Access assertion, resolves the admitted user, and binds sessions, storage, administration, and connected credentials to that identity.

Each user's session is tied to the user's own storage bucket and container identity. A browser-supplied bucket name, email header, hostname, or session ID is not allowed to choose another user's resources. Administrative surfaces require the administrator role, while application admission follows the configured Cloudflare Access policy and groups.

I keep working under the same identity boundary on desktop, tablet, and phone. Switching devices changes the browser. It does not change who owns the session.

## Where the boundary sits

I work behind Cloudflare Access for ingress and identity. Cloudflare Access does not inspect arbitrary outbound traffic, replace GitHub branch protection, or prove that a downstream SaaS accepted the right authorization. Those belong to different controls.

A valid identity also does not grant universal access. Repository permissions, organization policy, storage ownership, and connected-service authorization still apply. If the signed-in user cannot read a private repository, I cannot solve that with enthusiasm.

## Try it

Ask me to trace one request from the Cloudflare Access assertion through user resolution, session ownership, bucket binding, and the final route guard. I will identify where each untrusted browser value stops being authoritative.

Other useful requests:

- “Trace this request from Cloudflare Access identity to session ownership.”
- “Show why one user can reach their bucket but not another user’s bucket.”
- “Explain which browser-provided values are ignored at each boundary.”

Source anchors: `sdd/spec/authentication.md`, `sdd/spec/enterprise-mode.md` REQ-ENTERPRISE-001/010/011/015, `sdd/spec/storage.md` REQ-STOR-001, and `src/middleware/auth.ts`.
