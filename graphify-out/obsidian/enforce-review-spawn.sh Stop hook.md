---
source_file: "preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh"
type: "code"
community: "Community 112"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Community_112
---

# enforce-review-spawn.sh Stop hook

## Connections
- [[3-strike circuit breaker (GIVEUP state)]] - `implements` [EXTRACTED]
- [[REQ-AGENT-022 SDD transition gate]] - `cites` [EXTRACTED]
- [[SDD Stop-hook enforce-review-spawn behaviour test]] - `references` [EXTRACTED]
- [[code-reviewer subagent]] - `references` [EXTRACTED]
- [[doc-updater subagent]] - `references` [EXTRACTED]
- [[git-push-review-reminder.sh PostToolUse hook]] - `semantically_similar_to` [INFERRED]
- [[mcp__context-mode__ctx_batch_execute MCP tool]] - `references` [EXTRACTED]
- [[mcp__context-mode__ctx_execute MCP tool]] - `references` [EXTRACTED]
- [[sdd-last-ack-pr-head checkpoint]] - `implements` [EXTRACTED]
- [[sdd.review-needed.md escalation log]] - `implements` [EXTRACTED]
- [[sdd.skip-next-review one-shot sentinel]] - `implements` [EXTRACTED]
- [[sddconfig.yml modeenforce_tddtransition config]] - `references` [EXTRACTED]
- [[sddinit-triage.md transition triage list]] - `references` [EXTRACTED]
- [[spec-reviewer subagent]] - `references` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Community_112