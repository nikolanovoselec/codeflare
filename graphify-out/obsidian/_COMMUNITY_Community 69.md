---
type: community
cohesion: 0.12
members: 26
---

# Community 69

**Cohesion:** 0.12 - loosely connected
**Members:** 26 nodes

## Members
- [[activity HTTP endpoint]] - code - host/src/server.ts
- [[health HTTP endpoint]] - code - host/src/server.ts
- [[terminal WebSocket endpoint]] - code - host/src/server.ts
- [[AD47 container DO idle policy]] - document - host/src/server.ts
- [[CODEFLARE_INIT_FLAG_FILE entrypoint readiness flag]] - code - host/src/server.ts
- [[CONTAINER_AUTH_TOKEN env (bearer token, timingSafeEqual)]] - code - host/src/server.ts
- [[PREWARM_SESSION_ID = 'prewarm-1' constant]] - code - host/src/session-manager.ts
- [[Session class (PTY lifecycle)]] - code - host/src/session.ts
- [[SessionManager (PTY map + prewarm adoption)]] - code - host/src/session-manager.ts
- [[TAB_CONFIG env (terminal tab list)]] - code - host/src/server.ts
- [[Terminal HTTP+WS server]] - code - host/src/server.ts
- [[Vite dev proxy api and terminal - 8787]] - code - web-ui/vite.config.ts
- [[createActivityTracker for idle hibernation]] - code - host/src/activity-tracker.ts
- [[fast-check fuzz tests for host]] - code - host/__tests__/fuzz-host.test.js
- [[frontend InitProgressStartupStatusResponse types]] - code - web-ui/src/types.ts
- [[frontend Session interface (mirrors backend)]] - code - web-ui/src/types.ts
- [[frontend TabConfig interface]] - code - web-ui/src/types.ts
- [[getPrewarmConfig (extracts tab-1 command)]] - code - host/src/prewarm-config.ts
- [[host shared TypeScript type definitions]] - code - host/src/types.ts
- [[server prewarm config integration test]] - code - host/__tests__/server-prewarm.test.js
- [[server security-hardening + module extraction test]] - code - host/__tests__/server-security.test.js
- [[system metrics + sync status for health]] - code - host/src/metrics.ts
- [[web-ui App.tsx root SolidJS component]] - code - web-ui/src/App.tsx
- [[web-ui Vite devbuild config]] - code - web-ui/vite.config.ts
- [[web-ui Vitest test config (jsdom + Solid)]] - code - web-ui/vitest.config.ts
- [[web-ui frontend shared types]] - code - web-ui/src/types.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Community_69
SORT file.name ASC
```
