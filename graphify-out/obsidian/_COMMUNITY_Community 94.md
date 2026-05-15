---
type: community
cohesion: 0.11
members: 20
---

# Community 94

**Cohesion:** 0.11 - loosely connected
**Members:** 20 nodes

## Members
- [[CON-PERF-002 Bisync interval 60s]] - document - sdd/constraints.md
- [[CON-REL-002 Self-healing bisync recovery]] - document - sdd/constraints.md
- [[Cloud icon]] - image - preseed/tutorials/Assets/cloud.svg
- [[Folder icon]] - image - preseed/tutorials/Assets/folder.svg
- [[Principle Files persist, bad decisions don't]] - document - sdd/README.md
- [[REQ-AGENT-008 Preseed Deployed to Container on Start]] - document - sdd/agents.md
- [[REQ-STOR-001 Dedicated Per-User R2 Bucket]] - document - sdd/storage.md
- [[REQ-STOR-002 File Persistence Across Sessions]] - document - sdd/storage.md
- [[REQ-STOR-003 Bidirectional Sync Every 60 Seconds]] - document - sdd/storage.md
- [[REQ-STOR-004 Initial Sync Restores Files on Start]] - document - sdd/storage.md
- [[REQ-STOR-005 Graceful Shutdown Performs Final Sync]] - document - sdd/storage.md
- [[REQ-STOR-006 Storage Quota Enforced Per Tier at Session Start]] - document - sdd/storage.md
- [[REQ-STOR-007 Web File Browser]] - document - sdd/storage.md
- [[REQ-STOR-008 Multipart Upload for Large Files]] - document - sdd/storage.md
- [[REQ-STOR-009 Getting-Started Docs Auto-Seeded]] - document - sdd/storage.md
- [[REQ-STOR-011 Sync Mode Controls Workspace Scope]] - document - sdd/storage.md
- [[REQ-STOR-012 Session Transcript Cleanup]] - document - sdd/storage.md
- [[REQ-STOR-013 Self-Healing Corrupted R2 Files (Deprecated)]] - document - sdd/storage.md
- [[REQ-STOR-014 R2 Storage Stats Caching]] - document - sdd/storage.md
- [[Upload icon (arrow into tray)]] - image - preseed/tutorials/Assets/upload.svg

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Community_94
SORT file.name ASC
```

## Connections to other communities
- 2 edges to [[_COMMUNITY_Community 106]]
- 2 edges to [[_COMMUNITY_Community 226]]
- 1 edge to [[_COMMUNITY_Community 255]]
- 1 edge to [[_COMMUNITY_Community 225]]
- 1 edge to [[_COMMUNITY_Community 195]]
- 1 edge to [[_COMMUNITY_Community 82]]

## Top bridge nodes
- [[REQ-STOR-001 Dedicated Per-User R2 Bucket]] - degree 10, connects to 3 communities
- [[REQ-STOR-004 Initial Sync Restores Files on Start]] - degree 6, connects to 2 communities
- [[REQ-AGENT-008 Preseed Deployed to Container on Start]] - degree 3, connects to 2 communities
- [[REQ-STOR-006 Storage Quota Enforced Per Tier at Session Start]] - degree 2, connects to 1 community