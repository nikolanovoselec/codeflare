---
type: "query"
date: "2026-08-01T20:23:35.959896+00:00"
question: "I asked you to add gist scope to GitHub connection. Where is it?"
contributor: "graphify"
outcome: "corrected"
correction: "Add gist to every Connect GitHub OAuth App tier in src/lib/oauth-scopes.ts, keep Direct GitHub login at user:email, and require reconnection for existing grants."
source_nodes: ["GhTokenGistScopeGap", "GistVsRepoDivergence", "GITHUB_OAUTH_SCOPES"]
---

# Q: I asked you to add gist scope to GitHub connection. Where is it?

## Answer

The prior change put gist on Direct GitHub login, but the requested capability belongs to the separate Connect GitHub OAuth flow. Connect scopes are selected by the server-side GITHUB_OAUTH_SCOPES catalog for minimal, recommended, and advanced tiers; gist must be present in every tier while Direct GitHub login remains identity-only with user:email. Existing OAuth connections must disconnect and reconnect after deployment to grant the added scope.

## Outcome

- Signal: corrected
- Correction: Add gist to every Connect GitHub OAuth App tier in src/lib/oauth-scopes.ts, keep Direct GitHub login at user:email, and require reconnection for existing grants.

## Source Nodes

- GhTokenGistScopeGap
- GistVsRepoDivergence
- GITHUB_OAUTH_SCOPES