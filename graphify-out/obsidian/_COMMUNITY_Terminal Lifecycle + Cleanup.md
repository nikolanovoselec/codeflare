---
type: community
cohesion: 0.08
members: 42
---

# Terminal Lifecycle + Cleanup

**Cohesion:** 0.08 - loosely connected
**Members:** 42 nodes

## Members
- [[authUrl, setAuthUrl]] - code - web-ui/src/stores/terminal.ts
- [[normalUrl, setNormalUrl]] - code - web-ui/src/stores/terminal.ts
- [[state, setState_3]] - code - web-ui/src/stores/terminal.ts
- [[abortControllers]] - code - web-ui/src/stores/terminal.ts
- [[beginProgrammaticScroll()]] - code - web-ui/src/stores/terminal.ts
- [[cancelPendingFlush()]] - code - web-ui/src/stores/terminal.ts
- [[cancelScheduledDisconnect()]] - code - web-ui/src/stores/terminal.ts
- [[cleanupFitAddonsByPrefix()]] - code - web-ui/src/stores/terminal-layout.ts
- [[cleanupMapByPrefix()]] - code - web-ui/src/stores/terminal.ts
- [[clearFitAddons()]] - code - web-ui/src/stores/terminal-layout.ts
- [[connect()]] - code - web-ui/src/stores/terminal.ts
- [[connections]] - code - web-ui/src/stores/terminal.ts
- [[disconnect()]] - code - web-ui/src/stores/terminal.ts
- [[disconnectAll()]] - code - web-ui/src/stores/terminal.ts
- [[dispose()]] - code - web-ui/src/stores/terminal.ts
- [[disposeAll()]] - code - web-ui/src/stores/terminal.ts
- [[disposeSession()]] - code - web-ui/src/stores/terminal.ts
- [[endProgrammaticScroll()]] - code - web-ui/src/stores/terminal.ts
- [[getConnectionState()]] - code - web-ui/src/stores/terminal.ts
- [[getRetryMessage()]] - code - web-ui/src/stores/terminal.ts
- [[getTerminal()]] - code - web-ui/src/stores/terminal.ts
- [[inputDisposables]] - code - web-ui/src/stores/terminal.ts
- [[isConnected()]] - code - web-ui/src/stores/terminal.ts
- [[isProgrammaticScrollSuppressed()]] - code - web-ui/src/stores/terminal.ts
- [[makeKey()_1]] - code - web-ui/src/stores/terminal.ts
- [[pendingFlushes]] - code - web-ui/src/stores/terminal.ts
- [[reconnect()]] - code - web-ui/src/stores/terminal.ts
- [[reconnectDisconnectedTerminals()]] - code - web-ui/src/stores/terminal.ts
- [[reconnectOnVisibilityReturn()]] - code - web-ui/src/stores/terminal.ts
- [[registerProcessNameCallback()]] - code - web-ui/src/stores/terminal.ts
- [[resize()]] - code - web-ui/src/stores/terminal.ts
- [[retryTimeouts]] - code - web-ui/src/stores/terminal.ts
- [[scheduleDisconnect()]] - code - web-ui/src/stores/terminal.ts
- [[scheduleWrite()]] - code - web-ui/src/stores/terminal.ts
- [[scrollSuppressionCounts]] - code - web-ui/src/stores/terminal.ts
- [[setConnectionState()]] - code - web-ui/src/stores/terminal.ts
- [[setRetryMessage()]] - code - web-ui/src/stores/terminal.ts
- [[setTerminal()]] - code - web-ui/src/stores/terminal.ts
- [[terminal.ts]] - code - web-ui/src/stores/terminal.ts
- [[terminals_6]] - code - web-ui/src/stores/terminal.ts
- [[textDecoder]] - code - web-ui/src/stores/terminal.ts
- [[writeBuffers]] - code - web-ui/src/stores/terminal.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Terminal_Lifecycle__Cleanup
SORT file.name ASC
```

## Connections to other communities
- 9 edges to [[_COMMUNITY_Community 117]]
- 9 edges to [[_COMMUNITY_Floating Terminal UI]]
- 6 edges to [[_COMMUNITY_Community 109]]
- 5 edges to [[_COMMUNITY_Session State Atoms]]
- 5 edges to [[_COMMUNITY_Community 202]]
- 4 edges to [[_COMMUNITY_Session Creation + Header UI]]
- 3 edges to [[_COMMUNITY_Community 68]]
- 2 edges to [[_COMMUNITY_Community 181]]
- 2 edges to [[_COMMUNITY_Setup + Auth Provider API]]
- 2 edges to [[_COMMUNITY_User Management + Tier Resolution]]
- 2 edges to [[_COMMUNITY_Community 80]]
- 2 edges to [[_COMMUNITY_Community 96]]
- 2 edges to [[_COMMUNITY_Community 169]]
- 1 edge to [[_COMMUNITY_Metrics Apply Loop]]
- 1 edge to [[_COMMUNITY_Community 71]]
- 1 edge to [[_COMMUNITY_Community 118]]
- 1 edge to [[_COMMUNITY_Community 95]]
- 1 edge to [[_COMMUNITY_Error Types + Fetch Utilities]]

## Top bridge nodes
- [[terminal.ts]] - degree 88, connects to 18 communities
- [[reconnectOnVisibilityReturn()]] - degree 5, connects to 2 communities
- [[cleanupMapByPrefix()]] - degree 4, connects to 2 communities
- [[makeKey()_1]] - degree 14, connects to 1 community
- [[reconnectDisconnectedTerminals()]] - degree 4, connects to 1 community