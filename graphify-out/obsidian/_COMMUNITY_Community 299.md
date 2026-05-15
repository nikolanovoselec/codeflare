---
type: community
cohesion: 0.50
members: 4
---

# Community 299

**Cohesion:** 0.50 - moderately connected
**Members:** 4 nodes

## Members
- [[Backendfrontend constant parity tests (MAX_TABS, SESSION_ID_PATTERN)]] - code - src/__tests__/contract/constants.test.ts
- [[MAX_TABS = 6 (terminal tabs per session)]] - code - src/lib/constants.ts
- [[SESSION_ID_PATTERN regex (a-z0-9{8,24}$)]] - code - src/lib/constants.ts
- [[generateSessionId (96-bit hex via crypto.getRandomValues)]] - code - src/lib/kv-keys.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Community_299
SORT file.name ASC
```
