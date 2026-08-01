---
type: "query"
date: "2026-08-01T16:04:20.573246+00:00"
question: "Where are GitHub OAuth sign-in scopes defined, selected by tier, included in authorization URLs, tested, and documented? Identify the smallest change to request the gist scope for user login."
contributor: "graphify"
outcome: "useful"
source_nodes: ["GITHUB_OAUTH_SCOPES", "oauth-scopes.ts", "oauth-scopes.test.ts"]
---

# Q: Where are GitHub OAuth sign-in scopes defined, selected by tier, included in authorization URLs, tested, and documented? Identify the smallest change to request the gist scope for user login.

## Answer

Direct GitHub login is implemented in src/routes/github-auth.ts, where GET /login constructs the GitHub authorization URL with scope=user:email; src/__tests__/routes/github-auth.test.ts verifies that redirect. The tiered GITHUB_OAUTH_SCOPES catalog in src/lib/oauth-scopes.ts belongs to the separate Connect GitHub flow, not login. The smallest correct change is to add gist to the login scope, strengthen the redirect test to assert discrete user:email and gist scopes, and update REQ-AUTH-002 plus the authentication lane.

## Outcome

- Signal: useful

## Source Nodes

- GITHUB_OAUTH_SCOPES
- oauth-scopes.ts
- oauth-scopes.test.ts