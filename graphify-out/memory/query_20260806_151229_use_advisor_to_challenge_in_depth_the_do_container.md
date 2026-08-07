---
type: "query"
date: "2026-08-06T15:12:29.446600+00:00"
question: "use advisor to challenge in depth the DO/container zombie analysis and conclusion and fix to solve the problem. detailed end to end research and validation"
contributor: "graphify"
outcome: "useful"
source_nodes: ["reconcileContainerTransport()", "collectMetrics()", "activity-tracker.ts", "REQ-SESSION-021: Unreachable container transport initiates coordinator reconstruction"]
---

# Q: use advisor to challenge in depth the DO/container zombie analysis and conclusion and fix to solve the problem. detailed end to end research and validation

## Answer

The stale Durable-Object attachment diagnosis is plausible but not proven. Both /activity and /health are routes on the same Node HTTP server, port 8080, process, and event loop, so simultaneous failure cannot distinguish a stale DO attachment from a wedged host event loop, CPU starvation, listener failure, or container-network failure. ctx.container.running proves process existence only, and ptyAlive means the host still holds a non-null node-pty object, not that the PTY or host event loop is responsive. The recovery patch safely initiates a DO reset after three complete failures and preserves the workload/KV state, while the SDK constructor recreates monitor tracking for an already-running container and Durable Object alarms are at-least-once. However, successful private-port and WebSocket reattachment is still unverified; the code clears its failure streak before abort, has no post-reset recovery marker, can repeat aborts without a bound if the host remains wedged, and continues recovery when the shutdown-marker read fails. Keep PR #799 unmerged until SDK alarm/reset semantics are confirmed in a controlled integration experiment that proves the same PTY PID and container uptime survive, KV remains running, the browser reconnects, a post-reset probe succeeds, and later metrics alarms continue.

## Outcome

- Signal: useful

## Source Nodes

- reconcileContainerTransport()
- collectMetrics()
- activity-tracker.ts
- REQ-SESSION-021: Unreachable container transport initiates coordinator reconstruction