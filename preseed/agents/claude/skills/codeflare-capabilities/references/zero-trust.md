# Zero Trust

Enterprise Codeflare can put identity and authorization in front of the workspace instead of teaching every container how to authenticate users. Cloudflare Access gates the application, Access identity can create users just in time, and configured groups can determine administrator access or AI routing policy.

The important boundary is attribution. The session is tied to an authenticated user and one user-owned bucket. Enterprise request interceptors derive credential ownership from session bindings, not from a hostname or user ID supplied by the container. A session cannot ask the egress layer to borrow another user's token.

User example: after signing in through the configured identity provider and connecting GitHub, start a session and confirm GitHub operations are attributed to your identity without copying a personal token into the terminal.

Operator example: create a small Access group for Codeflare administrators, configure that exact group during Initialization, then test one member and one non-member. Check Access logs for the authorization result rather than inferring policy from the UI.

Zero Trust is an Enterprise configuration, not a claim that every deployment has an identity provider or group policy attached. Current Access, Gateway, or SCIM details should be read from the configured account and current platform documentation before changes are made.

Source anchors: `sdd/spec/enterprise-mode.md` REQ-ENTERPRISE-010/014, `sdd/spec/authentication.md`, `sdd/spec/github.md`, and `documentation/lanes/authentication.md`.
