---
type: community
cohesion: 0.09
members: 33
---

# OAuth Nonce + HMAC

**Cohesion:** 0.09 - loosely connected
**Members:** 33 nodes

## Members
- [[KNOWN_ERRORS]] - code - src/routes/github-auth.ts
- [[nonce, iat]] - code - src/__tests__/lib/oauth-state.test.ts
- [[app_38]] - code - src/routes/github-auth.ts
- [[b64url()]] - code - src/lib/oauth-state.ts
- [[b64urlDecode()]] - code - src/lib/oauth-state.ts
- [[callbackRateLimiter]] - code - src/routes/github-auth.ts
- [[claimOauthNonce()]] - code - src/lib/oauth-state.ts
- [[code]] - code - src/routes/github-auth.ts
- [[enc_1]] - code - src/lib/oauth-state.ts
- [[enc]] - code - src/__tests__/lib/oauth-state.test.ts
- [[errorParam]] - code - src/routes/github-auth.ts
- [[getBaseUrl()_1]] - code - src/lib/kv-keys.ts
- [[github-auth.ts]] - code - src/routes/github-auth.ts
- [[headers_2]] - code - src/routes/github-auth.ts
- [[hmacKey()]] - code - src/lib/oauth-state.ts
- [[iat]] - code - src/__tests__/lib/oauth-state.test.ts
- [[kv]] - code - src/__tests__/lib/oauth-state.test.ts
- [[logger_17]] - code - src/routes/github-auth.ts
- [[loginRateLimiter]] - code - src/routes/github-auth.ts
- [[oauth-state.test.ts]] - code - src/__tests__/lib/oauth-state.test.ts
- [[oauth-state.ts]] - code - src/lib/oauth-state.ts
- [[params_1]] - code - src/routes/github-auth.ts
- [[parseOauthState()]] - code - src/lib/oauth-state.ts
- [[parsed_4]] - code - src/__tests__/lib/oauth-state.test.ts
- [[parsed_9]] - code - src/routes/github-auth.ts
- [[primary]] - code - src/routes/github-auth.ts
- [[queryState]] - code - src/routes/github-auth.ts
- [[sigB64]] - code - src/__tests__/lib/oauth-state.test.ts
- [[signOauthState()]] - code - src/lib/oauth-state.ts
- [[signWithIat()]] - code - src/__tests__/lib/oauth-state.test.ts
- [[url_6]] - code - src/routes/github-auth.ts
- [[userRecord_1]] - code - src/routes/github-auth.ts
- [[verifyOauthState()]] - code - src/lib/oauth-state.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/OAuth_Nonce__HMAC
SORT file.name ASC
```

## Connections to other communities
- 5 edges to [[_COMMUNITY_Community 103]]
- 5 edges to [[_COMMUNITY_Error Types + Fetch Utilities]]
- 3 edges to [[_COMMUNITY_Community 135]]
- 2 edges to [[_COMMUNITY_KV Mock Test Infrastructure]]
- 2 edges to [[_COMMUNITY_Session State + Limit Validation]]
- 1 edge to [[_COMMUNITY_CF Access AppsGroups Models]]
- 1 edge to [[_COMMUNITY_Container Env + Prefs]]
- 1 edge to [[_COMMUNITY_Community 78]]
- 1 edge to [[_COMMUNITY_Community 67]]
- 1 edge to [[_COMMUNITY_Admin TierSlot Counting]]
- 1 edge to [[_COMMUNITY_Community 77]]
- 1 edge to [[_COMMUNITY_Community 88]]

## Top bridge nodes
- [[github-auth.ts]] - degree 37, connects to 10 communities
- [[getBaseUrl()_1]] - degree 4, connects to 3 communities
- [[oauth-state.test.ts]] - degree 14, connects to 1 community
- [[oauth-state.ts]] - degree 11, connects to 1 community
- [[signOauthState()]] - degree 6, connects to 1 community