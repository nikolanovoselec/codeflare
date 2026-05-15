---
type: community
cohesion: 0.05
members: 52
---

# Frontend API Client Layer

**Cohesion:** 0.05 - loosely connected
**Members:** 52 nodes

## Members
- [[API client test suite]] - code - web-ui/src/__tests__/api/client.test.ts
- [[ApiError class]] - code - web-ui/src/api/fetch-helper.ts
- [[Auto-redirect on 401 from appadmin pages]] - code - web-ui/src/api/fetch-helper.ts
- [[Breadcrumbs derivation from currentPrefix]] - code - web-ui/src/__tests__/stores/storage.test.ts
- [[CF Access redirect detection (manual redirect, opaqueredirect, HTML body)]] - code - web-ui/src/api/fetch-helper.ts
- [[Compound session-terminal id (sessionId-terminalId)]] - code - web-ui/src/api/client.ts
- [[Deploy Keys API surface]] - code - web-ui/src/api/client.ts
- [[Deploy Keys API test suite]] - code - web-ui/src/__tests__/api/deploy-keys.test.ts
- [[Dotfilehidden-items default-hide toggle]] - code - web-ui/src/__tests__/components/StorageBrowser.test.tsx
- [[Drag dataTransfer key applicationx-r2-key]] - code - web-ui/src/__tests__/components/StorageBrowser.test.tsx
- [[FIX-14 customDomain in SetupStatusResponse]] - document - web-ui/src/__tests__/stores/setup.test.ts
- [[FIX-27 stopping is frontend-only status]] - document - web-ui/src/__tests__/api/contract.test.ts
- [[FIX-7 batched setState in detectToken]] - document - web-ui/src/__tests__/stores/setup.test.ts
- [[FilePreview component tests]] - code - web-ui/src/__tests__/components/FilePreview.test.tsx
- [[Frontend API Client]] - code - web-ui/src/api/client.ts
- [[Frontend propertyfuzz tests (md5, isActionableUrl, cleanupMapByPrefix)]] - code - web-ui/src/__tests__/fuzz/frontend-fuzz.test.ts
- [[Frontend-backend contract suite (Zod schemas)]] - code - web-ui/src/__tests__/api/contract.test.ts
- [[LLM Keys API surface]] - code - web-ui/src/api/client.ts
- [[MockWebSocket fixture]] - code - web-ui/src/__tests__/setup.ts
- [[Multipart upload protocol (initiatepartcompleteabort)]] - code - web-ui/src/api/storage.ts
- [[Preferences store test]] - code - web-ui/src/__tests__/stores/preferences.test.ts
- [[Q12 JSON error body extraction]] - document - web-ui/src/__tests__/api/client.test.ts
- [[R2 readiness polling test]] - code - web-ui/src/__tests__/stores/r2-readiness.test.ts
- [[SESSION_ID_RE format guard]] - code - web-ui/src/api/client.ts
- [[Selection-mode click interception (folderfile toggles)]] - code - web-ui/src/__tests__/components/StorageBrowser.test.tsx
- [[Session presets store test]] - code - web-ui/src/__tests__/stores/session-presets.test.ts
- [[Session tabs store test]] - code - web-ui/src/__tests__/stores/session-tabs.test.ts
- [[Setup store test (NDJSON streaming)]] - code - web-ui/src/__tests__/stores/setup.test.ts
- [[Setup wizard API surface]] - code - web-ui/src/api/client.ts
- [[SetupError steps streaming protocol]] - document - web-ui/src/api/fetch-helper.ts
- [[Storage API client]] - code - web-ui/src/api/storage.ts
- [[Storage API client test suite]] - code - web-ui/src/__tests__/api/storage.test.ts
- [[Storage Store Tests]] - code - web-ui/src/__tests__/stores/storage.test.ts
- [[Storage browser breadcrumb navigation]] - code - e2e/ui/storage.test.ts
- [[Storage uploadbrowsedownloaddelete cycle]] - code - e2e/stress/storage-operations.js
- [[StorageApiError back-compat subclass]] - code - web-ui/src/api/storage.ts
- [[StorageBrowser component tests]] - code - web-ui/src/__tests__/components/StorageBrowser.test.tsx
- [[StorageListResult (R2 listing)]] - code - src/types.ts
- [[StoragePreview discriminated union]] - code - web-ui/src/api/storage.ts
- [[Terminal URL auth detection test]] - code - web-ui/src/__tests__/stores/terminal-url-detection.test.ts
- [[Terminal layout test]] - code - web-ui/src/__tests__/stores/terminal-layout.test.ts
- [[Terminal store test (WS retryrestore)]] - code - web-ui/src/__tests__/stores/terminal.test.ts
- [[Test infrastructure smoke suite]] - code - web-ui/src/__tests__/smoke.test.ts
- [[Three preview modes (textimagebinary)]] - code - web-ui/src/__tests__/components/FilePreview.test.tsx
- [[Vitest test setup (mocks for localStorageWebSocketResizeObserver)]] - code - web-ui/src/__tests__/setup.ts
- [[WS close code 4503 container-stopped]] - document - web-ui/src/__tests__/stores/terminal.test.ts
- [[Workspace folder capitalization + container sync icon]] - code - web-ui/src/__tests__/components/StorageBrowser.test.tsx
- [[baseFetch + ApiError helper]] - code - web-ui/src/api/fetch-helper.ts
- [[baseFetch test suite (redirectHTMLsteps)]] - code - web-ui/src/__tests__/api/fetch-helper.test.ts
- [[fetchApi private wrapper]] - code - web-ui/src/api/client.ts
- [[getTerminalWebSocketUrl compound id]] - code - web-ui/src/api/client.ts
- [[startSession progress polling]] - code - web-ui/src/api/client.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Frontend_API_Client_Layer
SORT file.name ASC
```

## Connections to other communities
- 1 edge to [[_COMMUNITY_Community 246]]

## Top bridge nodes
- [[Storage Store Tests]] - degree 5, connects to 1 community