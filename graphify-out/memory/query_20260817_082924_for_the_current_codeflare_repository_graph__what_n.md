---
type: "query"
date: "2026-08-17T08:29:24.238931+00:00"
question: "For the current codeflare repository graph, what nodes and call relationships represent the user-managed VS Code extension persistence restore, security acknowledgement, settings restoration, and capture flow? Confirm the graph includes restoreExtensionManifest and captureExtensionManifest after the latest source edits."
contributor: "graphify"
outcome: "useful"
source_nodes: ["restoreExtensionManifest()", "captureExtensionManifest()", "persistSecurityAcknowledgement()", "capture()"]
---

# Q: For the current codeflare repository graph, what nodes and call relationships represent the user-managed VS Code extension persistence restore, security acknowledgement, settings restoration, and capture flow? Confirm the graph includes restoreExtensionManifest and captureExtensionManifest after the latest source edits.

## Answer

The refreshed graph contains restoreExtensionManifest() at openvscode/agent-sidebar/src/extension-persistence.ts:L415, captureExtensionManifest() at L344, persistSecurityAcknowledgement() at L324, and the Python reap capture() at scripts/browser-ide-extensions.py:L208. These nodes confirm the latest restore, acknowledgement, live capture, and post-reap persistence boundaries are represented; detailed call edges were truncated by the bounded query and were not inferred beyond the returned evidence.

## Outcome

- Signal: useful

## Source Nodes

- restoreExtensionManifest()
- captureExtensionManifest()
- persistSecurityAcknowledgement()
- capture()