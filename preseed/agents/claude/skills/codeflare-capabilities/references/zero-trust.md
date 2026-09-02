# Zero Trust identity and authorization

**Availability:** Enterprise deployment plus operator-configured Cloudflare Access, identity provider, and applicable groups.

## What I can do

I can work behind Cloudflare Access so identity and authorization sit in front of the workspace instead of being reimplemented inside every container. Access identity can create users just in time. Configured groups can determine administrator access and AI-routing policy.

I can start a session bound to the authenticated user and one user-owned bucket. Enterprise request interceptors derive credential ownership from that trusted binding, not from a hostname, email, or user ID supplied by the container. I cannot ask the egress layer to borrow another user's token by changing a request parameter.

## Why the boundary matters

Authentication says who entered. Session binding says whose credentials and storage the work may use. Egress policy says where the session may go. Collapsing those into one “Zero Trust enabled” badge would hide the exact boundary an operator needs to verify.

Zero Trust support does not prove that this deployment has an IdP, Access group policy, Gateway policy, or SCIM integration configured. I check current account configuration and active operator documentation before claiming any of those.

## Try it

User task: sign in through the configured identity provider, connect GitHub, start a session, and run an attributed GitHub operation without copying a personal token into the terminal.

Operator task: configure a small Access administrator group during Initialization, test one member and one non-member, then verify the authorization result in Access logs rather than inferring it from the UI.

Source anchors: `sdd/spec/enterprise-mode.md` REQ-ENTERPRISE-010/014, `sdd/spec/authentication.md`, `sdd/spec/github.md`, and `documentation/lanes/authentication.md`.
