# Spec Changes

Semantic changes to the specification. Git history captures diffs; this file captures intent.

Earlier history is retained in the [November archive](changes-archive-2026-11.md).

## 2026-11-08

- Keep execution permissions independent of deployment CPU, memory or storage: builds and ordinary test runners remain CI-only; the existing tuned managed wrapper remains the sole local-test route with unchanged functionality. Deployment resource profiles and their allocations remain configurable and unchanged ([REQ-AGENT-052](agents.md#req-agent-052-pi-commit-attribution-and-local-build-hook-hardening), [REQ-OPS-007](operations.md#req-ops-007-container-specs-configurable-per-environment)).

## 2026-11-07

- Retire restored obsolete MCP configuration after exact archival instead of rejecting known generated duplicates. Keep valid native definitions authoritative, import missing supported legacy servers and retain genuine custom-conflict, credential, path and concurrency guards. The native adapter pin, portal transport, browser retention and successful-only sync exclusion remain unchanged ([REQ-AGENT-217](mcp.md#req-agent-217-lossless-pi-mcp-adapter-migration)).

- Complete the review refinements with evidenced workload/concurrency scenarios, responsibility-based maintainability findings and clear consequences. Re-evaluate deferred findings when concrete evidence meets their recorded revisit trigger, preserve existing decision history separately from the live queue, and consume evidence-enabled review packets in memory across both runtimes ([REQ-AGENT-015](agents.md#req-agent-015-review-command-for-multi-perspective-codebase-review), [REQ-AGENT-088](agents.md#req-agent-088-user-invoked-review-ownership-and-triage)).

- Sharpen the shared Engineering Constitution with explicit reuse preferences, complete caller/fixture impact tracing and owning-path fixes. Consolidate wording without removing existing testing, security, authorization, continuity or review obligations; retain readability and required safeguards rather than minimizing line count ([REQ-AGENT-065](agents.md#req-agent-065-engineering-constitution-preseeded-to-all-agents)).

- Preserve optional accepted operating limits and actionable revisit triggers in existing review debt reports, history and approved issues. Leave irrelevant fields out and applicable unestablished values explicitly unknown; do not invent thresholds, add a ledger, require shortcut comments or change review permissions ([REQ-AGENT-088](agents.md#req-agent-088-user-invoked-review-ownership-and-triage)).

- Wire bounded, generation-fenced unreachable recovery into production: preserve the 120-second incident deadline, use native SIGTERM, and escalate after the existing 135-second shutdown budget to one same-generation destruction attempt. Failed or unconfirmed destruction retains ownership and manual recovery; source implementation and automated coverage do not establish CI or hosted acceptance ([REQ-SESSION-021](session-lifecycle.md#req-session-021-complete-transport-failure-opens-one-unreachable-incident), [REQ-SESSION-024](session-lifecycle.md#req-session-024-recovery-deadline-and-termination-intent-are-durable), [REQ-SESSION-032](session-lifecycle.md#req-session-032-final-notification-drain-precedes-shutdown-sync)).

- Change managed Goal startup pacing from three to five minutes through the existing configuration, preserving unrelated preferences and the existing five-attempt retry policy without modifying the Goal extension or either Constitution ([REQ-AGENT-129](agents.md#req-agent-129-goal-continuation-settings-policy)).

- Preserve successful memory coverage across verified local trimming without an immediate duplicate capture or loss of later uncaptured prompts; retain recovery for unrelated history replacement ([REQ-MEM-025](memory.md#req-mem-025-pi-capture-follows-transcript-epochs)).

- Pi memory capture, Vault checks and size-eligible trimming now share the memory progress baseline and transcript rebase handling; legacy Vault counters cannot stall maintenance ([REQ-MEM-002](memory.md#req-mem-002-capture-triggers-every-20-user-messages-and-on-resume), [REQ-VAULT-031](vault.md#req-vault-031-vault-hash-checks-follow-successful-prompt-cadence)).

- Recover existing owner portal authorization through Worker refresh and browser SSO, preserving active-session navigation, credential isolation and explicit Disconnect without restarting Pi ([REQ-AGENT-226](mcp.md#req-agent-226-worker-owned-mcp-portal-authorization)).

- Clarify native MCP cold discovery as metadata-only: lazy startup remains deferred, and external consultation still requires an explicit user request ([REQ-AGENT-069](agents.md#req-agent-069-pi-consult-llm-mcp-lazy-wiring)).

- Reuse observed fresh same-generation portal renewals and avoid returning stale access tokens after refresh publication, retaining disconnect/configuration fences and metadata-only request failure diagnostics ([REQ-AGENT-226](mcp.md#req-agent-226-worker-owned-mcp-portal-authorization)).

- Restore the previous unmodified native MCP adapter as the sole managed owner, with guarded stock-to-native configuration handoff, deferred discovery, ten-minute idle disconnect and honest progress-resetting six-minute request semantics; portal OAuth remains on Cloudflare ([REQ-AGENT-217](mcp.md#req-agent-217-lossless-pi-mcp-adapter-migration), [REQ-AGENT-228](mcp.md#req-agent-228-owner-pi-mcp-configuration-and-discovery), [REQ-BROWSER-009](browser-run.md#req-browser-009-mcp-and-chrome-sdk-timeout-profile)).

- Record policy provenance and timing decisions in existing idle metrics logs without adding storage I/O, settings or endpoints, so fallback and timing uncertainty can be distinguished during reproduction ([REQ-OPS-017](operations.md#req-ops-017-sleepafter-fail-safe-invariants)).

- Keep valid input-based idle expiry independent of unavailable no-input startup timing while preserving conservative no-input recovery ([REQ-SESSION-004](session-lifecycle.md#req-session-004-idle-containers-sleep-after-configurable-timeout), [REQ-SESSION-034](session-lifecycle.md#req-session-034-durable-idle-baseline-survives-coordinator-reconstruction)).

- Remove the bulk extension-update command from the runtime updater while preserving Fast Start network behavior, missing configured-package restoration, model-catalog refreshes and governed image/lock delivery ([REQ-AGENT-206](agents.md#req-agent-206-fast-start-off-runtime-updates)).
- Carry the normal Dispatcher Activity/generation/profile authority through strict egress for catalogued personal-provider hosts, retaining validated generic strict forwarding for custom SDK endpoints and current owner checks without legacy credential bindings or Gateway routing changes ([REQ-OPERATOR-007](operators.md#req-operator-007-operator-aware-inference-selection), [REQ-OPERATOR-047](operators.md#req-operator-047-generic-directed-profile-admission)).
