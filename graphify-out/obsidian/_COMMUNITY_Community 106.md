---
type: community
cohesion: 0.12
members: 19
---

# Community 106

**Cohesion:** 0.12 - loosely connected
**Members:** 19 nodes

## Members
- [[Codeflare Specification]] - document - sdd/README.md
- [[Principle Isolation per session]] - document - sdd/README.md
- [[Principle Stateless dashboard, stateful containers]] - document - sdd/README.md
- [[REQ-SESSION-001 Session creation with name and agent type]] - document - sdd/session-lifecycle.md
- [[REQ-SESSION-002 One container per session (isolation)]] - document - sdd/session-lifecycle.md
- [[REQ-SESSION-003 R2 bucket mountedsynced on start]] - document - sdd/session-lifecycle.md
- [[REQ-SESSION-006 User can stoprestartdelete sessions]] - document - sdd/session-lifecycle.md
- [[REQ-SESSION-007 Running session count limited per tier]] - document - sdd/session-lifecycle.md
- [[REQ-SESSION-008 Container restart preserves R2 bucket]] - document - sdd/session-lifecycle.md
- [[REQ-SESSION-009 Container destroy wipes session state]] - document - sdd/session-lifecycle.md
- [[REQ-SESSION-010 Session status observable from dashboard]] - document - sdd/session-lifecycle.md
- [[REQ-SESSION-012 Wake-loop prevention]] - document - sdd/session-lifecycle.md
- [[REQ-TERM-001 Up to 6 terminal tabs per session]] - document - sdd/terminal.md
- [[REQ-TERM-004 Close code 4503 is authoritative]] - document - sdd/terminal.md
- [[REQ-TERM-005 Tab 1 auto-starts configured agent]] - document - sdd/terminal.md
- [[REQ-TERM-006 User-created tabs start plain bash]] - document - sdd/terminal.md
- [[REQ-TERM-007 Tiling layouts (2-split3-split4-grid)]] - document - sdd/terminal.md
- [[REQ-TERM-010 Session presets (saved tab configurations)]] - document - sdd/terminal.md
- [[Terminal (console prompt) icon]] - image - preseed/tutorials/Assets/console.svg

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Community_106
SORT file.name ASC
```

## Connections to other communities
- 4 edges to [[_COMMUNITY_Community 141]]
- 2 edges to [[_COMMUNITY_Community 94]]
- 2 edges to [[_COMMUNITY_Community 195]]
- 1 edge to [[_COMMUNITY_Community 82]]
- 1 edge to [[_COMMUNITY_Community 255]]
- 1 edge to [[_COMMUNITY_Community 227]]
- 1 edge to [[_COMMUNITY_Community 256]]

## Top bridge nodes
- [[Codeflare Specification]] - degree 8, connects to 6 communities
- [[REQ-TERM-005 Tab 1 auto-starts configured agent]] - degree 3, connects to 2 communities
- [[REQ-SESSION-002 One container per session (isolation)]] - degree 6, connects to 1 community
- [[REQ-SESSION-003 R2 bucket mountedsynced on start]] - degree 4, connects to 1 community
- [[REQ-SESSION-012 Wake-loop prevention]] - degree 3, connects to 1 community