# Spec Changes

Semantic changes to the specification. Git history captures diffs; this file captures intent.

Earlier history is retained in the [November archive](changes-archive-2026-11.md).

## 2026-11-22: Recover interrupted uploads and deliver local FIX earlier

- [REQ-STOR-008 AC7](storage.md#req-stor-008-multipart-upload-for-large-files) lets the upload queue rediscover and explicitly abort pending completion after reload.
- Local Pi can deliver FIX on the next turn ([REQ-AGENT-244 AC5](agents.md#req-agent-244-exact-round-review-completion)). A missing reviewer notification no longer blocks FIX when Pi retained a matching successful completion ([REQ-AGENT-053 AC2](agents.md#req-agent-053-pi-native-review-result-correlation)).
- [REQ-GITHUB-015](github.md#req-github-015-workspace-repository-tracking) keeps the previous automatic restore list when a workspace scan cannot finish.

## 2026-11-22: Defer Hermes indexing in Advanced Pi

- [REQ-MEM-035 AC4](memory.md#req-mem-035-durable-pi-facts-with-disposable-local-search) defers Markdown-to-SQLite initialization until the first Hermes operation that needs the store. [REQ-MEM-041](memory.md#req-mem-041-session-isolated-hermes-checkpoints) uses a session-local copy of the four masters and syncs verified session checkpoints without writing the masters. Cross-session merging is deferred.

## 2026-11-22: Stock Todo Loop, simpler Operators navigation, and Smart Compact defaults

- [REQ-AGENT-111](agents.md#req-agent-111-native-todo-loop-workflow-in-pi-sessions) replaces managed Goal with stock Todo Loop in both Pi modes, without changing existing user task or preference data.
- [REQ-OPERATOR-040](operators.md#req-operator-040-owned-activity-control-presentation) keeps the Enterprise Operators header control and removes the account-menu link. Management authorization is unchanged.
- [REQ-AGENT-222](agents.md#req-agent-222-pi-smart-compact-defaults) and [REQ-AGENT-223](agents.md#req-agent-223-pi-smart-compact-settings-preservation) seed the Thorough/background Smart Compact preset before Pi loads, keeping secret scrubbing and honoring existing settings.

## 2026-11-21: Keep non-review transitions silent

- [REQ-OPERATOR-053](operators.md#req-operator-053-enterprise-pr-boundary-review-handoff) does not treat background clone submission or a confirmed missing, closed, or unprotected PR as a Review boundary. Unknown enrollment still cannot clear an eligible PR.
- [REQ-AGENT-092](agents.md#req-agent-092-import-transition-review-suppression) applies the existing open Import transition suppression before Pi routing.

## 2026-11-21: Keep terminal trust, dependency sync, and Vault extraction scoped

- [REQ-ENTERPRISE-005](models-and-routing.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) gives early Enterprise terminal launches the mounted interception CA settings before shell setup.
- [REQ-STOR-011](storage.md#req-stor-011-sync-mode-controls-workspace-scope) excludes directories ending in `node_modules` in both Include and Exclude sync modes, without excluding regular files by that suffix.
- [REQ-VAULT-003](vault.md#req-vault-003-user-curated-edits-use-bounded-prompt-cadenced-ingestion) excludes the root `Memory/` tree from Pi and Claude extraction without changing Hermes recall, sync, or the existing graph.

## 2026-11-21: Align OAuth and Browser Run acceptance

- Removed browser-mode-specific OAuth acceptance from [REQ-AUTH-002](authentication.md#req-auth-002-saas-mode-uses-direct-github-oauth) and historical token qualification from [REQ-BROWSER-002](browser-run.md#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template). Cookie-free signed OAuth state, verified-primary-email enforcement, and permission additivity remain required.

## 2026-11-20: Use one idle-timeout policy across plans

- [REQ-SESSION-014](session-lifecycle.md#req-session-014-user-configurable-auto-sleep-timeout-in-settings) gives Free, paid, and Enterprise the same 1h default and 1h/2h/4h/8h/12h presets, while preserving saved preferences. Guided Setup keeps its selector and matches Settings.

## 2026-11-20: Keep session credentials scoped and legacy preferences readable

- [REQ-SESSION-003](session-lifecycle.md#req-session-003-r2-bucket-mounted-and-synced-on-start) leaves direct storage unavailable if the bucket-scoped credential pair is incomplete, rather than passing deployment credentials to the container.
- [REQ-SESSION-014](session-lifecycle.md#req-session-014-user-configurable-auto-sleep-timeout-in-settings) accepts the saved `5m` timeout in preference responses without making it a new selectable preset.
- [REQ-SESSION-006](session-lifecycle.md#req-session-006-user-can-stop-restart-and-delete-sessions) keeps a delayed Start from marking a later run ready. Stop waits for pending startup to settle before confirming exit. Delete uses the existing Stop path when needed and removes only the captured stopped generation.

## 2026-11-20: Retain trial history on subscription deletion

- [REQ-SUB-005](subscription.md#req-sub-005-trial-is-compute-based-not-time-based) records trial use when Stripe deletes the same subscription while its stored state is trialing. Stale deletions cannot alter a replacement subscription or its trial history.

## 2026-11-20: Verify D1 inventory before provisioning

- [REQ-OPS-056](operations.md#req-ops-056-non-destructive-d1-deployment-boundary) distinguishes a valid empty database inventory from blank or malformed output. An invalid initial listing blocks creation; an invalid post-create listing blocks binding and migration.

## 2026-11-20: Preserve sync retry after a baseline timeout

- [REQ-STOR-045](storage.md#req-stor-045-bisync-baseline-recovery) reports a timed-out baseline rebuild as timeout, then retries the rebuild after one more failed cycle. Only a completed rebuild reports success; shutdown still has its best-effort final sync backstop.

## 2026-11-20: Keep active app sessions signed in across HTTP routes

- REQ-AUTH-008 renews eligible SaaS and onboarding sessions on static and proxied HTTP responses as well as API responses. Renewal preserves logout, existing cookies and WebSocket upgrades; responses carrying a renewed credential are never cacheable.

## 2026-11-20: Re-authorize a Cloudflare integration

- REQ-AGENT-018 and REQ-AGENT-028 label the connected Account ID and add Re-authorize to Settings. Select a permission tier to continue without disconnecting; Cancel leaves the connection unchanged.
- REQ-AGENT-064 checks all account pages before keeping the prior selection or selecting the sole account.
- REQ-AGENT-239 offers account selection or retry in Integrations or Guided Setup. Retry loading missing choices without restarting OAuth; failed, incomplete or empty authorization lookups leave the saved connection intact.
- REQ-AGENT-228 renames the existing MCP action to Re-authorize; Disconnect remains separate.

## 2026-11-19: Resolve local Review before GitHub discovery

- REQ-OPERATOR-053 adds a bounded, ordinary-session-owned enrollment read on the existing owner transport. Empty/disabled enrollment and another known repository's Action select the existing local engine before GitHub discovery; legacy unknown names and unreadable configuration cannot establish absence. Verified enrollment retains its canonical repository name. A remote candidate still requires the existing exact-PR, Action, Conductor and human-authority checks.
- REQ-AGENT-036 keeps failed Git transitions inert in the Enterprise selector, including failed pushes that previously emitted a misleading unavailable-boundary warning.
- Selection is not review clearance. Local metadata verification and all configured remote trust checks remain mandatory; no credential or review-gate bypass is introduced.

## 2026-11-19: Temporary native Codex prompt-prefix backport

- [REQ-AGENT-261](agents.md#req-agent-261-codex-prompt-prefix-backport-preparation) carries upstream Pi PR 12319 in both installed library and bundled CLI paths, keeping the initial system prompt in the input prefix while preserving WebSocket continuation semantics ([REQ-AGENT-238](agents.md#req-agent-238-native-codex-prompt-prefix-compatibility)).
- Image and post-update preparation share the guarded backport. Pristine upstream that already includes the fix, or has incompatible bytes, fails tests and Pi shadow-pin admission before publication; receipt-verified local reapplication remains separate. No dependency version, provider credentials or user settings change, and no live cache-hit or deployment acceptance is inferred.

## 2026-11-19: Compact Operator recovery controls

- REQ-OPERATOR-210 keeps the shared recovery launcher as an accessible lock-reset icon: left of Run once in Installed, right of Activate/Deactivate in Administration. Preview and explicit confirmation remain unchanged.
- REQ-OPERATOR-209 removes default fieldset borders from expanded Configure forms without removing keyboard-focus indicators. Rendered visual acceptance remains separate from source checks.

## 2026-11-19: Identify internal GitHub discovery requests

- REQ-GITHUB-003 supplies the required User-Agent on internal REST metadata lookups used by Review selection and preparation.
- REQ-OPERATOR-053 uses remote Review only for a trusted target Action and a Conductor installation enabled for the user. Confirmed absent, disabled or ineligible installations automatically select the existing local review system before remote-only authority checks. Failed or untrusted discovery grants no remote authority; ownership and workflow-trust protections remain intact.

## 2026-11-19: Restore managed Hermes after the direct-package trial

- REQ-MEM-035 retires the exact obsolete managed-adapter exclusion during Advanced startup while retaining adapter-owned package loading, default-mode behavior, other exclusions and capture preferences. Registered Hermes tools remain discoverable and individually activatable through the existing REQ-AGENT-096 live capability registry; no separate catalog or eager activation is introduced.

## 2026-11-19: Goal resume resets expired stall history before enforcement

- REQ-AGENT-236 resets stopped-goal stall history, deadline and its public counter at explicit resume, before persistence or lifecycle enforcement can apply an old deadline. Deferred automatic-count reset, failed-delivery rollback, genuine restoration/waiting stalls and the five-stall/25-minute bound remain intact.

## 2026-11-19: Responsive notification enrollment and quiet Pi startup

- REQ-TERM-025 repairs inactive notification registrations without waiting indefinitely on global service-worker readiness. Activation alone is bounded; subscription creation and authenticated writes retain completion ownership. Settings exposes pending work, rejects duplicate gestures and preserves enrollment after failed removal, with retryable privacy-safe feedback.
- REQ-AGENT-237 prepares the upstream pi-web-access version marker from the installed package before releasing the agent, suppressing unsolicited upgrade notices without modifying upstream code or hiding real errors. Unsafe state is preserved and reported rather than overwritten.

## 2026-11-19: Chunked manual Hermes consolidation by default

- REQ-MEM-035 prepares Advanced Pi with chunked manual consolidation enabled when the setting is absent. Explicit choices survive startup; automatic consolidation and default-mode behavior remain unchanged.

## 2026-11-19: Review corrections and bounded raw-capture manifests

- REQ-OPERATOR-090/091 extends existing encrypted framing to bounded authenticated manifest pages so paced captures retain complete cold readback without an event-count ceiling. Existing v1 archives and small receipts remain compatible; missing, modified or incorrectly bound pages cannot certify completion.
- REQ-MEM-036's native compaction fixture retains stable indexed canaries and verifies original Markdown preservation instead of assuming that arbitrary live file edits refresh SQLite. Native mutation and automatic-correction coverage remain separate.

## 2026-11-19: Active dependency integration and Impeccable policy compatibility

- Integrates the active dependency PRs #1492–1506; inactive draft #1349/ui-progression and promotion #1432 remain excluded. The combined tree retains the intentional Cloudflare Vitest plugin 1.6.1 constraint, qualified exact xterm beta, and independent security-pin ownership.
- The explicitly approved ws 8.23.0 security update covers the host and both managed package trees. Context-mode 2.1.9 does not inherit its accidental Hono adapter override; the dedicated adapter update supplies 2.1.8. No vulnerability ignore or renewed exception is introduced for context-mode's inherited bundled Zod risk.
- Impeccable 4.10.0 preserves REQ-AGENT-181 image ownership and REQ-AGENT-194 evidence boundaries with local-command defaults, explicit account authority and usable isolated-role handoffs. Relocated rubric anchors, browser regression coverage and current Goal/Plan references follow the integrated versions. Source and local checks do not establish signed publication, image acceptance or full CI success.

## 2026-11-19: Hermes-wrapper exclusion does not block MCP handoff

- REQ-AGENT-217 treats the exact managed `hermes-memory-runtime.ts` exclusion as unrelated to MCP client ownership. Native Hermes can replace that wrapper without causing false ambiguous-client warnings.
- Baked preseed and curation retain fail-closed handling for unknown/lookalike exclusions and truly ambiguous client selections; regression fixtures verify selected-client handoff and preservation of configuration/settings.

## 2026-11-19: Review applicability before Operator execution authority

- REQ-OPERATOR-053 AC1/AC3 resolves trusted target-Action applicability before requiring an Operator session generation, human credential or Activity binding. Confirmed unconfigured/absent or explicitly inactive enrollment preserves local Review; custom Action paths, unknown-state refusal and active remote authorization remain intact.
- This is a backend applicability-ordering correction, not a new review launcher or authorization bypass. Source and regression coverage do not establish deployed behavior or CI success.
- The unchanged, matching baked/curated selectors retain authoritative local/remote/unavailable routing. Both trees carry native behavioral routing regression coverage; the Codeflare interceptor suite additionally exercises the packaged selector against the backend. The workspace-only local-review override is not managed content.

## 2026-11-19: Enterprise credential boundary and independent native context

- REQ-ENTERPRISE-306 disables the complete authenticated deploy-keys router in Enterprise, including administrators, before parsing, credential access or provider work. Non-Enterprise PAT support and both managed GitHub providers remain unchanged; no legacy cleanup is included.
- REQ-AGENT-240 carries the owner's selected OAuth account as non-secret startup metadata, separately from administrator Browser Run. Explicit clears, partial omission, transport validation and Operator exclusion preserve credential routing and account authority.
- REQ-MEM-036 AC6 strengthens proactive scoped recall; REQ-MEM-036 replaces full-file context injection and its incompatible size budgets with native policy-only search. Keep lifecycle/path/native-binding qualification, foreground ownership, workspace scope, final writes and the old requirement fragment.
- Test-only source was preserved before runtime changes. Source/readiness and supplemental checks are not exact-revision CI, signed publication, deployment or runtime acceptance evidence.
- Shadow-pin preparation qualifies the existing Goal/Plan transforms for 0.55.1/0.60.1 and Impeccable 4.10.0 with additive engine 0.1.27 support, preserving prior engines and evidence/idle/traversal guards. Current shipped pins remain unchanged until their normal bump PRs. Context-mode manifest updates now target only the named dependency, preserving unrelated same-version overrides.

## 2026-11-18: Dependency compatibility and shadow-pin repair

- Shadow-pin metadata authenticates only GitHub API requests; the GitHub CLI source build and installed support package now advance as one release identity (REQ-OPS-020).
- Exact-source Goal 0.55.0 and Plan 0.60.0 preparation retains transactional aborts, recovery ownership, configured progress bounds and native custom-turn isolation (REQ-AGENT-111/129/144/152/236).
- Impeccable 4.9.1 selects engine 0.1.24 while retaining older engines and the existing evidence, idle-grace and traversal boundaries (REQ-AGENT-163/164/194).
- Updated dependency locks and source checks are not exact-head CI, deployment, managed-publication or runtime-acceptance evidence.

## 2026-11-18: Startup, completed retries and prompt CI results

- Post-restore settings recreate a missing parent without discarding existing settings; fatal startup retains its exit status through final cleanup (REQ-AGENT-099 AC4; REQ-OPS-010 AC7).
- Original execution readback accounts for charged managed/native inference attempts, not only logical operations. It preserves immutable result/receipt, owner, generation and unresolved-write fences (REQ-OPERATOR-211).
- Pi CI monitoring reports the first non-empty all-terminal snapshot after rechecking the exact PR head; pending/unavailable checks and existing deadlines remain unchanged (REQ-AGENT-068/125).

## 2026-11-17: Durable-buffer raw receipts and replacement cleanup (planned)

- REQ-OPERATOR-213 separates original upload payload identity and immutable replay acknowledgement from REQ-OPERATOR-091's policy, transport and private-readback obligations. Partial, conflicting or unavailable original evidence cannot authorize replacement; the extracted obligations remain Planned pending qualification.
- REQ-OPERATOR-107 preserves existing verified-replacement cleanup without waiting for an obsolete Worker's unsent diagnostic buffer. Root results, receipts, journals, archives and uncertain-write protections remain intact; this adds no quiescence/status API or new cleanup engine.
- Specification changes alone establish neither source qualification nor CI, deployment or runtime acceptance.

## 2026-11-17: Read-only SDK authorization

- REQ-OPERATOR-007/048 keep private SDK authorization independent of cold execution recovery. Configuration, credential and model guards retain fresh authority, generation, connection and deadline checks without starting pending planning/admission. Ordinary entry and alarm recovery remain unchanged; this source correction alone does not establish the historical timeout or OOM cause or hosted acceptance.

## 2026-11-17: Compact raw-capture retention

- REQ-OPERATOR-090/091 require lossless compact native-binary capture and cold encrypted readback without per-byte descriptor expansion or encoded console credential disclosure. Pending capture authorization keeps immutable pins rather than complete admission/checkpoint/result payloads.
- Original policy, authority/revocation, cancellation, explicit incompleteness, sequential full-history persistence and historical archives remain unchanged. Source changes do not establish a historical OOM origin or hosted acceptance.

## 2026-11-16: Shared processing coordination across authorized actors

- REQ-OPERATOR-061/210/211 separate nonprivate application/work-repository coordination from private execution ownership. A different authorized login does not prevent processing-state reads or safe recovery; original facts are selected internally by scoped key/version, not a caller-supplied historical identity.
- Private values, credentials and archives remain owner-bound. Existing CAS, closed-authority/no-write proof, source/tenant isolation and preserved original/requester audit lineage remain mandatory; no identity alias, blanket reset or new coordination service is introduced.

## 2026-11-16: Obsolete Dispatcher infrastructure cleanup

- REQ-OPERATOR-107 replaces indefinite old Worker/SDK-namespace retention with proven-owned cleanup after verified replacement activation. Original admissions are fenced before deletion; Root history, receipts, journals and uncertain-write holds remain intact. Failed cleanup remains visible and retryable without replacing the serving Worker. Implementation, exact-head CI and authorized hosted cleanup verification remain separate gates.

## 2026-11-16: Delivery proof, verified release and configuration refusals

- REQ-OPERATOR-048/062 preserve ordinary settlement for completed unassociated SDK model HTTP without inventing delivery association; unresolved effects remain blocking and historical recovery still requires its original proof.
- REQ-OPERATOR-211 retains compact original per-delivery settlement, fencing and effect accounting before planner I/O; authorized delivery reads do not depend on unrelated later completion or collection. Original receipts, current authority and uncertain-effect protection remain mandatory.
- REQ-OPERATOR-061/210 represent verified original-owner release as an exact-version vacancy without exposing private prior state to a fresh authorized claimant; retained audit/legacy lineage protects successor updates, and package-written reset values do not authorize takeover. Recovery reports distinguish actual ownership and functional-proof gates without inventing missing evidence.
- REQ-OPERATOR-007/090/091 remove redundant full owner rediscovery from configuration-read liveness checks while retaining current read authorization, entry/return owner/source checks, original budgets and closed private refusal provenance. Credential refresh/persistence authorization is unchanged; source changes do not recover the historical missing abort reason.
- REQ-OPERATOR-212 distinguishes absent decisions from unreadable supplied content and shows bounded application-reported reasons. No generated decision, runtime qualification, deployment or acceptance is implied.

## 2026-11-16: Functional recovery proof

- Keep accounted no-write recovery eligibility and original generation independent of optional diagnostic bindings; retain original ownership, admission, generation-fence, lease and complete no-write journal checks ([REQ-OPERATOR-210](operators.md#req-operator-210-owner-authorized-application-state-recovery)).

## 2026-11-15: Conductor documentation ownership split

- Narrow mixed REQ-OPERATOR-053/055/056/064/065/072/074 prose to implemented Root authority, credential isolation, claim, evidence and receipt fences; preserve fragment compatibility and qualification limits. Fixed packet/history helpers and the protected-Action compatibility publisher remain Root implementation, not claimed runtime migrations. Document the existing frozen publication-preparation API, not a new schema.
- Correct the active delegation/activation reference to `application-schedule.ts::activateApplicationSchedule` and the Registry wrapper; `activateProspectiveRenovate` is refusal-only compatibility. No source/test changes, validation run, status upgrade, deployment or release is implied. Previous Dispatcher ownership edits remain unchanged.

## 2026-11-15: Application runtime traceability and preservation

- Rebind retired named test references to inspected equivalent assertions, retaining unmapped obligations for exact replacement evidence rather than inventing coverage. Keep existing requirement IDs and AC1–7 numbering; fold metadata selection into REQ-OPERATOR-209's existing schema contract and separate coordination/security constraints from wire details.
- Clarify REQ-OPERATOR-048: initial Root-committed no-work completion needs no SDK receipt; after SDK work, failed settlement cannot certify completion. Preserve separate existing checkpoint/result allowances through commit and collection, without a new setting.
- Clarify REQ-OPERATOR-061/090/091: read historical full values sequentially, flush authorized encrypted originals before the next read and retain compact decision proofs without discarding original payloads. No history cutoff, new index or change to other 128-entry metadata scans; original/current policy isolation, incomplete-evidence refusal and independent raw readback remain mandatory for manual and automatic intake.
- Keep REQ-OPERATOR-067's anti-spoof/provenance boundary while preserving authored package names without Renovate-specific name replacement. Root documentation covers runtime contracts; application policy/procedures stay in operator repositories. These corrections do not establish runtime GREEN, generated-package acceptance or hosted qualification.

## 2026-11-15: Dispatcher ownership extraction (qualification pending)

- Keep runtime contracts here and application policy/procedures in Dispatcher; remove duplicated operation-cost and qualification procedures, correct the generic activation endpoint and retain the inert publication response. Relocate REQ-OPERATOR-051/060/071/093 application obligations to Dispatcher with stable links; split REQ-OPERATOR-061 into generic triggers/coordination and Dispatcher-owned shared discovery/admission. REQ-OPERATOR-048/062 retain opaque delivery/receipt/authority fences, not Renovate phase or effect policy.
- Manual and automatic triggers must use the same application workflow and immutable configuration. New configuration pointers, authenticated plan and state/CAS contracts reuse the existing runtime. Historical reservations, foreign-owner isolation, uncertain effects and Root capture obligations remain intact. Exact completed/failed settlement evidence preserves original authority and journal fences; failed data is exact-submission only, not invented success. Planning uses state/CAS without protected source calls. Historical full values are read sequentially and retained in authorized encrypted capture; decision proofs are compact without a new record-count cap. One coordinated tests/code/docs batch; no separate RED rounds, qualification or release claim.

## 2026-11-15

- Native background outcomes reach the next model request after the current tool batch instead of waiting for all queued follow-ups to drain; claimed/consumed suppression, ordering and shutdown guards remain intact ([REQ-AGENT-053](agents.md#req-agent-053-pi-native-review-result-correlation)).

- Keep historical reconciliation on a one-way Registry-to-Activity exchange with authoritative admission/ledger results and bounded private evidence streaming. Preserve atomic retirement guards and logging non-interference; reacquire the same Activity's stub for the existing guarded fence after RPC failure ([REQ-OPERATOR-061](operators.md#req-operator-061-prospective-admin-authorized-renovate-scan), [REQ-OPERATOR-063](operators.md#req-operator-063-bounded-dispatcher-diagnostics), [REQ-OPERATOR-090](operators.md#req-operator-090-protected-raw-execution-logs), [REQ-OPERATOR-091](operators.md#req-operator-091-protected-raw-logging-transport-and-delivery)).

## 2026-11-14

- Add the Pi-native planning skill to both mode inventories and capability guidance, with Vault Plans storage, structured clarification, dependent TODOs and user-approved Goal handoff. Native Plan/Goal ownership, user-requested advisor and existing safety boundaries remain unchanged ([REQ-AGENT-095](agents.md#req-agent-095-compact-pi-skill-catalog), [REQ-AGENT-207](agents.md#req-agent-207-user-focused-capability-deep-dives)).

- Apply existing validated source timeout/byte capacities to pre-admission metadata and automatic Renovate discovery instead of hidden eight-second/two-MiB transport caps. Share the original request deadline across headers/body, bounded by original authority expiry; preserve complete-scan, cancellation, revision and raw-capture/no-renewal fences ([REQ-OPERATOR-061](operators.md#req-operator-061-prospective-admin-authorized-renovate-scan), [REQ-OPERATOR-101](operators.md#req-operator-101-operator-budget-policy), [REQ-OPERATOR-090](operators.md#req-operator-090-protected-raw-execution-logs), [REQ-OPERATOR-091](operators.md#req-operator-091-protected-raw-logging-transport-and-delivery)).

- Make existing private raw archives readable by the currently authenticated original-owner administrator, including Registry observations before Activity admission. Reuse encrypted locators and incremental verification, requiring full persisted reconstruction rather than HTTP success while preserving separate bounded diagnostics and granting no execution or recovery authority ([REQ-OPERATOR-091](operators.md#req-operator-091-protected-raw-logging-transport-and-delivery)).

## 2026-11-13

- Retain complete admin-enabled parent and public Flue/SDK evidence without raw-value redaction in existing private Durable Object storage. Authenticated SDK uploads require independent byte reconstruction before completion acknowledgement; console projections remain separate, with original execution, byte limits and cancellation preserved ([REQ-OPERATOR-090](operators.md#req-operator-090-protected-raw-execution-logs), [REQ-OPERATOR-091](operators.md#req-operator-091-protected-raw-logging-transport-and-delivery)).

- Retain discovery body-error causes for existing bounded fingerprints without changing public errors, read limits, authority or scheduling ([REQ-OPERATOR-063](operators.md#req-operator-063-bounded-dispatcher-diagnostics)).

- Add four privacy-safe, best-effort receiver checkpoints and first-failure receiver correlation; diagnostics remain non-authorizing and establish neither a runtime repair nor SDK acceptance ([REQ-OPERATOR-063](operators.md#req-operator-063-bounded-dispatcher-diagnostics)).

- Use shared authorized preparation for automatic Dispatcher work, validating its exact Registry reservation and saving the proof link atomically with pending intent instead of a separate binding RPC. Preserve manual behavior, original authority, target pins and no-replay guarantees ([REQ-OPERATOR-016](operators.md#req-operator-016-durable-activity-admission-and-cleanup), [REQ-OPERATOR-061](operators.md#req-operator-061-prospective-admin-session-renovate-scan)).

- Correlate automatic admission proof-RPC/storage observations by a one-way digest, preserve the first handoff failure's inner stage and retain secondary fence errors separately. Best-effort diagnostics preserve original returns, exceptions, authority and cadence; they do not establish a runtime cause or authorize replay ([REQ-OPERATOR-063](operators.md#req-operator-063-bounded-dispatcher-diagnostics)).

- Bound stalled Goal work to five spaced automatic continuations or a persisted 25-minute deadline, using current-owned-Goal progress evidence rather than output repetition or tool activity. Preserve productive-work preferences, resume/reset semantics, stale-run guards and cancellation; repair disabled startup safety and expose registered progress controls in both seeds ([REQ-AGENT-111](agents.md#req-agent-111-native-goal-workflow-in-pi-sessions), [REQ-AGENT-129](agents.md#req-agent-129-goal-continuation-settings-policy), [REQ-AGENT-130](agents.md#req-agent-130-goal-continuation-runtime-pacing), [REQ-AGENT-191](agents.md#req-agent-191-goal-tool-visibility-across-workflows), [REQ-AGENT-236](agents.md#req-agent-236-goal-stalled-work-bound)).

- Reconcile positive late native Stop completion through the existing durable exit ledger, retaining captured owner/generation/intent and the original 135-second caller deadline. No extra destruction attempt, age-only status repair or new scheduler is introduced ([REQ-SESSION-035](session-lifecycle.md#req-session-035-stale-stopping-retains-ownership-until-confirmed-exit), [REQ-SESSION-018](session-lifecycle.md#req-session-018-d1-lifecycle-evidence-is-generation-fenced)).

## 2026-11-11

- Separate Installed manual actions from automatic configuration, add profile-backed Dispatcher/Conductor role help and expose the existing explicit current-session activation flow. Saved settings remain distinct from acknowledgement, which does not confirm displayed settings; automatic activation uses verified package support, not display names, while authority, expiry and no-replay boundaries remain unchanged ([REQ-OPERATOR-099](operators.md#req-operator-099-installed-review-invocation-and-presentation), [REQ-OPERATOR-209](operators.md#req-operator-209-installed-schema-and-scheduling-safeguards), [REQ-OPERATOR-226](operators.md#req-operator-226-installed-role-and-activation-projection), [REQ-OPERATOR-061](operators.md#req-operator-061-prospective-admin-session-renovate-scan)).

- Add Cloudflare-only Integrations to Settings and Administration in every deployment mode, with GitHub retained on the dashboard. Enterprise management APIs use separate Worker-held owner grants without borrowing administrator Browser credentials or changing LLM routing ([REQ-AGENT-018](agents.md#req-agent-018-integrations-connection-management-ui), [REQ-AGENT-064](agents.md#req-agent-064-connect-to-cloudflare-via-oauth), [REQ-AGENT-078](agents.md#req-agent-078-cloudflare-oauth-token-refreshed-at-the-apicloudflarecom-boundary), [REQ-BROWSER-008](browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container)).

- Preserve header-safe opaque MCP access tokens, including provider-issued colon separators, through callback publication and renewal without imposing base64/JWT syntax. Retain encryption, owner binding, token-type/lifetime validation and rejection of unsafe header values; hosted acceptance remains separate ([REQ-AGENT-226](mcp.md#req-agent-226-worker-owned-mcp-portal-authorization)).

- Preserve supported 8h/12h preferences through client validation and Advanced controls, and project canonical billing-effective SaaS mode availability into Settings. Next-start idle policy and backend authorization remain unchanged ([REQ-SESSION-014](session-lifecycle.md#req-session-014-user-configurable-auto-sleep-timeout-in-settings), [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier)).

- Expose the existing persistence policy to authorized administrators in every deployment mode, with strict sync-only common-mode reads, previews and applies. Enterprise retains its aggregate encryption/download controls ([REQ-SETUP-028](setup.md#req-setup-028-administration-persistence-policy-selection)).

- Add explicit current-session Activate and retain bounded Dispatcher observations through temporary authority unavailability without protected work, shortened intervals or renewed expiry. Save and Enable remain separate ([REQ-OPERATOR-061](operators.md#req-operator-061-prospective-admin-session-renovate-scan)).

- Format Operator run and diagnostic timestamps using browser-preferred regions and the saved timezone while preserving original ISO instants and native hour-cycle choices ([REQ-OPERATOR-086](operators.md#req-operator-086-dropdown-runs-and-installed-workspace), [REQ-OPERATOR-084](operators.md#req-operator-084-activity-causal-diagnosis)).

- Retain owner-bound MCP return feedback, refresh Settings status and offer non-destructive reauthorization with truthful saved-authorization wording. Fixed-stage OAuth diagnostics preserve credential privacy and do not certify hosted completion or renewal ([REQ-AGENT-226](mcp.md#req-agent-226-worker-owned-mcp-portal-authorization), [REQ-AGENT-251](mcp.md#req-agent-251-owner-bound-mcp-settings-return-and-status)).

## 2026-11-09

- Keep existing fixed latency thresholds when a stress run enables a concurrency override; no load-test behavior change ([REQ-OPS-008](operations.md#req-ops-008-stress-testing-validates-rate-limits-and-concurrency)).

- Clarify payment-less activation for selectable subscription tiers, retaining protected blocked/pending states ([REQ-SUB-011](subscription.md#req-sub-011-graceful-degradation-without-stripe)).

- Source the tier maximum from the authoritative session-status flow without a separate entitlement-only request, preserving ancillary-status ownership ([REQ-SUB-019](subscription.md#req-sub-019-session-limit-popup-in-frontend)).

- Use pre-authorized native tools for owned Pi conversations rather than an interactive approval-pause protocol. Preserve owner authorization, tool restrictions, conversation isolation and ordinary PTY behavior ([REQ-OPERATOR-021](operators.md#req-operator-021-structured-owned-pi-conversation)).

- Align existing presentation contracts with model-first configured native rows, label-first policy options, independently retained editor windows and Dashboard-owned status-unavailable notices. Do not require an additional recovery countdown or in-workspace notice; preserve authoritative disposal and the chosen host-snapshot terminal restore. Runtime behavior is unchanged ([REQ-ENTERPRISE-064](setup.md#req-enterprise-064-route-and-compatibility-profile-presentation), [REQ-IDE-055](browser-ide.md#req-ide-055-ide-lifecycle-and-connectivity-are-presented-separately), [REQ-IDE-063](browser-ide.md#req-ide-063-retained-browser-editor-window-ownership), [REQ-TERM-045](terminal.md#req-term-045-local-terminal-presence-presents-active-or-idle)).

- Preserve complete newer session metadata against stale catalog rows, use transitional polling for starting/unreachable sessions, and apply the existing native context-window maximum to client readiness and policy eligibility. Keep ancillary failure retention and fail-closed managed discovery distinct ([REQ-SESSION-029](session-lifecycle.md#req-session-029-ordered-client-state-retains-last-good-authority), [REQ-SESSION-010](session-lifecycle.md#req-session-010-session-lifecycle-is-observable-from-one-d1-projection), [REQ-ENTERPRISE-056](setup.md#req-enterprise-056-native-target-disclosure-and-readiness)).

- Preserve originating `body-limit` classification and consumed-byte bounds for normal installed Dispatcher inference overflow through the existing bounded-reader observer. Logging OFF, diagnostic failures, reader cancellation, generic refusal and operation accounting retain their existing behavior ([REQ-OPERATOR-088](operators.md#req-operator-088-host-request-preparation-evidence)).

- Mark direct develop repair protection Partial after read-only inspection established missing non-fast-forward prevention. Keep that safeguard mandatory and require explicit authorization for configuration repair; no repository protection was changed ([REQ-OPS-037](operations.md#req-ops-037-develop-direct-fast-forward-repairs)).

## 2026-11-08

- Defer background storage re-encryption while D1 records a workload-owning session, including an unreachable runtime, and recheck ownership before mutating objects after drain attempts. Preserve bounded recovery when a fresh check confirms no owner ([REQ-ENTERPRISE-020](storage.md#req-enterprise-020-governed-mode-re-encrypt-migration-engine), [REQ-ENTERPRISE-021](storage.md#req-enterprise-021-governed-mode-migration-safety-and-access-boundary)).
- Derive the custom-domain DNS record name relative to the resolved zone (apex `@`, otherwise the hostname minus the zone suffix) on create, update and duplicate recovery, so hostnames in subdomain zones get the correct record name ([REQ-SETUP-007](setup.md#req-setup-007-custom-domain-with-dns-validation)).

- Refuse protected container forwarding without lifecycle credentials, retire IDE backends blocked on cancelled prompt writes, and retain generation/incident context when required recovery alarms fail. Preserve internal routes, ordinary completed-turn reuse and retry ownership ([REQ-SEC-022](security.md#req-sec-022-container-proxy-bearer-validation), [REQ-IDE-008](browser-ide.md#req-ide-008-ide-agent-process-lifecycle), [REQ-SESSION-026](session-lifecycle.md#req-session-026-lifecycle-scheduling-and-persistence-failures-remain-actionable)).
- Relay terminal and IDE WebSocket upgrades through the Container Durable Object with accepted ends instead of passing the private-port socket through, so established sessions survive Durable Object alarm boundaries. The relay never starts a runtime and forwards messages, close code/reason and errors (as 1011); a terminal relay also sends a 15 s heartbeat frame to the container end only, so the object keeps pending work across alarm boundaries ([REQ-SESSION-012](session-lifecycle.md#req-session-012-wake-loop-prevention)).

- Keep execution permissions independent of deployment CPU, memory or storage: builds and ordinary test runners remain CI-only; the existing tuned managed wrapper remains the sole local-test route with unchanged functionality. Deployment resource profiles and their allocations remain configurable and unchanged ([REQ-AGENT-052](agents.md#req-agent-052-pi-commit-attribution-and-local-build-hook-hardening), [REQ-OPS-007](operations.md#req-ops-007-container-specs-configurable-per-environment)).

## 2026-11-07

- Retire restored obsolete MCP configuration after exact archival instead of rejecting known generated duplicates. Keep valid native definitions authoritative, import missing supported legacy servers and retain genuine custom-conflict, credential, path and concurrency guards. The native adapter pin, portal transport, browser retention and successful-only sync exclusion remain unchanged ([REQ-AGENT-217](mcp.md#req-agent-217-lossless-pi-mcp-adapter-migration)).

- Complete the review refinements with evidenced workload/concurrency scenarios, responsibility-based maintainability findings and clear consequences. Re-evaluate deferred findings when concrete evidence meets their recorded revisit trigger, preserve existing decision history separately from the live queue, and consume evidence-enabled review packets in memory across both runtimes ([REQ-AGENT-015](agents.md#req-agent-015-review-command-for-multi-perspective-codebase-review), [REQ-AGENT-268](agents.md#req-agent-268-user-invoked-review-disposition)).

- Sharpen the shared Engineering Constitution with explicit reuse preferences, complete caller/fixture impact tracing and owning-path fixes. Consolidate wording without removing existing testing, security, authorization, continuity or review obligations; retain readability and required safeguards rather than minimizing line count ([REQ-AGENT-065](agents.md#req-agent-065-engineering-constitution-preseeded-to-all-agents)).

- Preserve optional accepted operating limits and actionable revisit triggers in existing review debt reports, history and approved issues. Leave irrelevant fields out and applicable unestablished values explicitly unknown; do not invent thresholds, add a ledger, require shortcut comments or change review permissions ([REQ-AGENT-268](agents.md#req-agent-268-user-invoked-review-disposition)).

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
