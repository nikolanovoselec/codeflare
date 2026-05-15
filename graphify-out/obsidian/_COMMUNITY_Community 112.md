---
type: community
cohesion: 0.14
members: 18
---

# Community 112

**Cohesion:** 0.14 - loosely connected
**Members:** 18 nodes

## Members
- [[3-strike circuit breaker (GIVEUP state)]] - code - preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh
- [[REQ-AGENT-022 SDD transition gate]] - document - host/__tests__/enforce-review-spawn.test.js
- [[REQ-AGENT-025 graphify clone triage]] - document - host/__tests__/graphify-clone-prompt.test.js
- [[SDD Stop-hook enforce-review-spawn behaviour test]] - code - host/__tests__/enforce-review-spawn.test.js
- [[code-reviewer subagent]] - document - host/__tests__/enforce-review-spawn.test.js
- [[enforce-review-spawn.sh Stop hook]] - code - preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh
- [[git-push-review-reminder PostToolUse hook test]] - code - host/__tests__/git-push-review-reminder.test.js
- [[git-push-review-reminder.sh PostToolUse hook]] - code - preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh
- [[graphify-clone-prompt behaviour test]] - code - host/__tests__/graphify-clone-prompt.test.js
- [[graphify-clone-prompt.sh PostToolUse hook]] - code - preseed/agents/claude/plugins/graphify/scripts/graphify-clone-prompt.sh
- [[mcp__context-mode__ctx_batch_execute MCP tool]] - code - host/__tests__/enforce-review-spawn.test.js
- [[mcp__context-mode__ctx_execute MCP tool]] - code - host/__tests__/enforce-review-spawn.test.js
- [[sdd-last-ack-pr-head checkpoint]] - code - preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh
- [[sdd-pr-cache 3-line PR-state cache file]] - code - preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh
- [[sdd.review-needed.md escalation log]] - document - preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh
- [[sdd.skip-next-review one-shot sentinel]] - code - preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh
- [[sddconfig.yml modeenforce_tddtransition config]] - document - host/__tests__/enforce-review-spawn.test.js
- [[sddinit-triage.md transition triage list]] - document - host/__tests__/enforce-review-spawn.test.js

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Community_112
SORT file.name ASC
```

## Connections to other communities
- 2 edges to [[_COMMUNITY_Community 113]]
- 1 edge to [[_COMMUNITY_Community 212]]
- 1 edge to [[_COMMUNITY_Community 81]]

## Top bridge nodes
- [[graphify-clone-prompt.sh PostToolUse hook]] - degree 5, connects to 2 communities
- [[enforce-review-spawn.sh Stop hook]] - degree 14, connects to 1 community