# Memory

Vault-based cross-session memory, automatic capture, hook delivery, and session-mode gating.

Persistence and derived-graph artifact identities are documented in [Vault](../../documentation/lanes/vault.md).

**Domain owner:** vault subsystem, entrypoint.sh, memory-capture.sh, preseed pipeline

### Key Concepts

- **Vault** -- The persistent per-user vault directory. Single source of truth for cross-session memory; holds agent-written session captures plus user-curated notes, inbox, and journal entries. Attachment uploads land next to the note that referenced them. Bisynced to R2 so the vault survives across sessions.
- **Unified Graph** -- The merged graph combining the vault's graph with every active repo's per-repo graph; merges are hash-keyed. Queryable through the graphify MCP surface so structural questions can span all sources in a single call.
- **Capture** -- A background subagent runs every twenty real user messages and immediately on the first prompt after a resumed session has an uncaptured tail, strips tool I/O, synthesises a markdown capture into the vault's raw-sessions subdirectory, and merges its subgraph under a shared multi-writer lock. Claude retains its chunked scratchpad; Pi processes only the bounded uncaptured interval in one pass.
- **Session Mode** -- Pro mode enables R2 sync of the vault and capture hooks. Standard mode runs the in-session capture flow but the vault is not preserved across container recreations.

### Out of Scope

- Cross-user memory sharing (each user's vault is isolated to their R2 bucket).
- Semantic graph pruning remains out of scope. Deterministic session-file compaction may relocate graph provenance, but it never removes graph identities or evidence as a relevance judgment.
- Legacy MCP server-memory migration (the subsystem has been removed; no historical graph is read or written).
- Bulk memory export (vault files are plain markdown and can be copied with rclone or git).

### Domain Dependencies

- **Vault** -- Capture writes ([REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault)) and global-graph merges depend on the vault skeleton and graph infrastructure from the Vault domain.
- **Storage** -- R2 sync of the vault ([REQ-MEM-004](#req-mem-004-vault-contents-synced-to-r2-across-sessions)) depends on the bisync infrastructure from the Storage domain.
- **Agents** -- Preseed delivery ([REQ-MEM-008](#req-mem-008-memory-prompt-files-preseeded-via-manifest-pipeline)) depends on the preseed pipeline from the Agents domain.
- **Subscription** -- Mode gating ([REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode)) depends on effective tier resolution and tier-allowed-session-modes from the Subscription domain.

---

### REQ-MEM-038: Claude capture launch notice

**Intent:** Users can see that a detached Claude capture started without asking the foreground model to launch it.

**Applies To:** User

**Acceptance Criteria:**

1. Each Claude capture launch notifies the user rather than sending the active model a launch instruction. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::emit_context --> <!-- @test: host/__tests__/memory-capture-hook.test.js (names the first launch and the file the capture will write) --> <!-- @test: host/__tests__/memory-capture-hook.test.js (counts the retry it is announcing) -->

**Constraints:** The active model never owns the capture launch; first-message graph guidance is independent.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault)

**Verification:** Automated: [memory-capture-hook.test.js](../../host/__tests__/memory-capture-hook.test.js)

**Status:** Implemented

---

### REQ-MEM-001: Conversation context automatically captured to vault

**Intent:** Important conversation context (decisions, debugging insights, observations) must be extracted from the transcript and persisted to the vault without manual intervention. This REQ covers the hook trigger, message-counting filter, and the capture pipeline. Hook plumbing (tilde expansion, vars file shape, first-message graphify hint, timezone resolution) is split into [REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing).

**Applies To:** User

**Acceptance Criteria:**

1. Each Claude capture trigger starts a detached capture without instructing the active model to launch it. <!-- @test: host/__tests__/memory-capture-hook.test.js (REQ-MEM-001 AC1: triggered capture survives hook return and destruction of the caller process group) --> <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::launch_capture --> <!-- @test: host/__tests__/memory-capture-hook.test.js (arms a request carrying the capture path the publisher will verify) -->
2. Pi excludes tool results and known synthetic agent envelopes from its real-user count while preserving genuine code-like prompts. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::isSyntheticPrompt --> <!-- @test: src/__tests__/lib/agent-seed-pi-memory.test.ts (REQ-MEM-001 AC2: Pi excludes synthetic envelopes and preserves genuine code-like prompts) -->
3. Each triggered Claude capture receives bounded uncaptured user/assistant content from the durable transcript. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/prefilter-transcript.sh::is_synthetic_marker --> <!-- @test: host/__tests__/memory-capture-pipeline.test.js (prefilter-transcript.sh (REQ-MEM-001 AC3) / REQ-VAULT-002 (conversation captures land in vault as markdown)) --> <!-- @test: host/__tests__/run-memory-capture.test.js (REQ-MEM-001 AC3 / MEM-026 AC2: hook-produced ${progress} resume cursor preserves the uncaptured payload) -->
4. Capture-file timestamps use the configured user timezone, then the process timezone, then UTC, per [REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing) AC4. <!-- @test: host/__tests__/pi-capture-turn-boundary.test.js (REQ-MEM-001 AC4: Pi capture uses ${label}) --> <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh::RESOLVED --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::captureTimestamp --> <!-- @test: host/__tests__/memory-iso-ts-script.test.js (assert-iso-ts.sh / REQ-MEM-010 AC5+AC6+AC7) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (prefers USER_TIMEZONE over TZ when both are present) -->
5. The capture file uses a YAML frontmatter template with session, capture-time, and capture-range fields followed by Context / Decisions / Observations / References sections. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md::captured_at --> <!-- @test: host/__tests__/memory-capture-pipeline.test.js (REQ-MEM-001 AC5: parses a synthetic Claude capture artifact after runner publication) -->
6. A capture is complete only after its required publication outputs are durably accepted; any failure remains incomplete and retryable without advancing the captured message range. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/publish-memory-capture.sh::VARS_FILE --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::memorySuccessQualifies --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeMemorySuccess --> <!-- @test: host/__tests__/memory-capture-pipeline.test.js (publish-memory-capture.sh (REQ-MEM-001 AC6)) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (requires the post-commit note and chunk before exact success advances the frozen counter) -->
7. Pi builds each capture request from only the root-bounded uncaptured interval after the last successful counter. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::compactMessages --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (captures only prompts after the root-owned successful counter) -->

**Notes:** Pi's root-owned extraction lifecycle is documented in [AD102](../../documentation/decisions/README.md#ad102-pi-extraction-delivery-is-root-owned-visible-and-transactional); its bounded execution profile is [AD103](../../documentation/decisions/README.md#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs).

**Constraints:**

- The hook runs in approximately 150ms.
- Memory capture requires advanced mode; only that mode receives the hook, plugin, and rule.
- Claude uses Sonnet with medium reasoning per [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad).
- Pi uses its provider-neutral model lever with medium reasoning per [AD103](../../documentation/decisions/README.md#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs).
- Capture agents produce graph output directly; the headless extraction CLI is not invoked.
- First-message graph guidance ([REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing) AC3) remains separate from capture notifications ([REQ-MEM-038](#req-mem-038-claude-capture-launch-notice)).
- Claude keeps its durable retry carrier until cumulative merge and global publication succeed; failures remain retryable without advancing capture progress.
- Pi requires an exact successful call plus post-commit note and graph-chunk artifacts before advancing its root-owned counter.
- Claude reads hook-provided transcript JSONL; Pi reads persisted session messages.
- Both skip capture for an empty transcript.

**Priority:** P0

**Dependencies:** [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-002](vault.md#req-vault-002-conversation-captures-land-in-the-vault-as-markdown), [REQ-SESSION-016](session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env)

**Verification:** Automated: [memory-capture-pipeline.test.js](../../host/__tests__/memory-capture-pipeline.test.js), [run-memory-capture.test.js](../../host/__tests__/run-memory-capture.test.js), [memory-iso-ts-script.test.js](../../host/__tests__/memory-iso-ts-script.test.js), [agent-seed-pi-memory.test.ts](../../src/__tests__/lib/agent-seed-pi-memory.test.ts), [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts), [memory-capture-hook.test.js](../../host/__tests__/memory-capture-hook.test.js), [pi-capture-turn-boundary.test.js](../../host/__tests__/pi-capture-turn-boundary.test.js)

**Status:** Implemented

---

### REQ-MEM-015: Pi Extraction Transcript Visibility and Child-Session Guard

**Intent:** Pi extraction must read durable root-session input, expose launch requests to the model, and stay inert inside child subagent sessions so work survives reloads without polluting child transcripts.

**Applies To:** User

**Acceptance Criteria:**

1. Capture reads each runtime's durable resume transcript, never volatile memory, so reload and resume retain full history; an empty resolved transcript skips capture instead of writing a placeholder. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (creates work on the twentieth real prompt and emits a visible reminder without private spawn) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-015 AC1: an empty durable transcript never captures volatile agent_end history) -->
2. Pi capture triggers are inert inside subagent child sessions — sessions whose header carries a parent-session pointer (review monitors, CI monitors, capture/extract subagents themselves) — so a background task's transcript never receives an injected capture follow-up as its visible output. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::isChildSession --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (keeps all handlers inert in child sessions) -->
3. After root-session reload or resume, Pi reconstructs each active capture's launch, reminder, running, failure, and success state from the durable root transcript; a bounded turn-limit completion qualifies only with the job's post-commit artifacts, and unrelated or superseded results never count. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionTranscriptFacts --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (correlates exact public calls and reconstructs running, failed, and successful state) -->
4. Due memory, Vault and transcript-maintenance jobs share one launch showing a job/delivery summary and bounded request JSON exactly matching durable metadata. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::sendDueExtractionMessages --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-015 AC4: exposes identical extraction items to the model and durable metadata) --> <!-- @test: host/__tests__/pi-shared-transcript-trim.test.js (REQ-MEM-015 AC3: memory Vault and trim share one extraction launch and queued-boundary deduplication) -->
5. An emitted request remains pending without duplicate reminders or replacement requests until an exact public call occurs. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionTranscriptFacts --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionDue --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::sendDueExtractionMessages --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-015 AC5: keeps an emitted request pending until an exact public call) --> <!-- @test: host/__tests__/pi-capture-turn-boundary.test.js (REQ-MEM-015 AC3: frozen capture dispatch and correlated finalization progress without settlement or duplicate queued launches) --> <!-- @test: host/__tests__/pi-transcript-agent.test.js (REQ-MEM-030 AC6: delivered unlaunched and altered running work remain pending without fresh requests) -->
6. Each failed exact call advances at most one of six delivery attempts. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionTranscriptFacts --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionDue --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-015 AC6: advances one delivery attempt after each failed exact call) -->
7. Six failed exact calls emit one structured terminal notice identifying failed jobs and advertised retry opportunities. A Vault edit may make a later eligible cadence or resume check productive; the edit itself does not trigger that check. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::sendDueExtractionMessages --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-015 AC7: identifies the failed job and next automatic opportunity) --> <!-- @test: host/__tests__/pi-transcript-agent.test.js (REQ-MEM-015 AC7: six failed trim calls emit one shared terminal notice without replacement request spam) -->

**Notes:** Reload-safe transcript correlation is documented in [AD102](../../documentation/decisions/README.md#ad102-pi-extraction-delivery-is-root-owned-visible-and-transactional).

**Constraints:**

- Pi reads its persisted session file via `getSessionFile()` and skips capture when the resolved transcript is empty.
- Child-session detection is header-based and applies to review monitors, CI monitors, capture subagents, and extract subagents.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing)

**Verification:** Automated: [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts), [pi-child-session-guard.test.ts](../../src/__tests__/lib/pi-child-session-guard.test.ts), [vault-migration.fuzz.test.ts](../../src/__tests__/fuzz/vault-migration.fuzz.test.ts)

**Status:** Implemented

---

<a id="req-mem-002-capture-triggers-every-15-user-messages"></a>
### REQ-MEM-002: Capture triggers every 20 user messages and on resume

**Intent:** Memory capture must fire at a regular interval to balance context freshness against overhead.

**Applies To:** User

**Acceptance Criteria:**

1. The hook persists the number of user messages since the last capture for each session. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::COUNTER_DIR --> <!-- @test: host/__tests__/memory-capture-hook.test.js (first run on a brand-new session baselines and emits memory-scan directive) -->
2. A first run with exactly one user prompt initializes the capture baseline and count without launching capture. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::CURRENT_COUNT --> <!-- @test: host/__tests__/memory-capture-hook.test.js (AC7 boundary - missing counter + transcript with exactly 1 prompt is brand-new (no capture)) -->
3. With an existing capture count, fewer than 20 messages since the last capture do not trigger another capture. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::DELTA --> <!-- @test: host/__tests__/memory-capture-hook.test.js (does NOT trigger when 19 new real prompts (boundary, delta < 20)) -->
4. When the delta reaches 20, capture is triggered. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::DELTA --> <!-- @test: host/__tests__/memory-capture-hook.test.js (triggers capture when 20+ NEW real prompts since last_count) --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-002 AC4: baselines the first prompt and arms all three jobs only after twenty new prompts) -->
5. After a Pi memory request reaches GIVEUP, twenty later real-user prompts re-arm capture without allowing generated extraction follow-ups to advance the cadence. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::isSyntheticPrompt --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-002 AC5: re-arms only after twenty later real prompts) -->
6. Only the Pi root advances the prompt counter, after an exact correlated successful result and post-commit capture note/chunk; failed, late, incomplete, or superseded results cannot advance the counter or clear replacement work. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::memorySuccessQualifies --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeMemorySuccess --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (requires the post-commit note and chunk before exact success advances the frozen counter) -->
7. Normal completed assistant turns reconcile queued real-prompt crossings and deliver eligible or already-frozen Pi extraction work without requiring another agent start. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: host/__tests__/pi-capture-turn-boundary.test.js (REQ-MEM-015 AC3: frozen capture dispatch and correlated finalization progress without settlement or duplicate queued launches) --> <!-- @test: host/__tests__/pi-transcript-agent.test.js (REQ-MEM-030 AC6: delivered unlaunched and altered running work remain pending without fresh requests) -->

**Notes:** Pi delivery ownership and retry rationale are documented in [AD102](../../documentation/decisions/README.md#ad102-pi-extraction-delivery-is-root-owned-visible-and-transactional); request bounds and uncaptured-window compaction are in [AD103](../../documentation/decisions/README.md#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs).

**Constraints:**

- Counter state MUST use ephemeral, session-scoped storage.
- `CURRENT_COUNT` alone distinguishes first runs: 1 means a brand-new transcript containing only the submitted prompt; greater values mean prior prompts persisted from a resumed session.
- Fresh/resume detection uses prompt history and counter state, not timestamps or mtimes.
- First-message guidance follows [REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing) AC3.
- Pi Vault checks and size-eligible maintenance share the capture baseline under [REQ-VAULT-031](vault.md#req-vault-031-vault-hash-checks-follow-successful-prompt-cadence) and [REQ-MEM-028](#req-mem-028-pi-active-transcript-size-retention).

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault)

**Verification:** Automated: [memory-capture-hook.test.js](../../host/__tests__/memory-capture-hook.test.js), [pi-capture-turn-boundary.test.js](../../host/__tests__/pi-capture-turn-boundary.test.js), [pi-transcript-agent.test.js](../../host/__tests__/pi-transcript-agent.test.js), [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts)

**Status:** Implemented

---

### REQ-MEM-025: Pi capture follows transcript epochs

**Intent:** Pi captures retained history after transcript shortening or replacement without destroying history or changing active execution.

**Applies To:** User

**Acceptance Criteria:**

1. Pi detects a shortened transcript when saved progress exceeds its real-user count. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-025: rebases a legacy 1013 counter onto three retained prompts) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-025: resumes retained history when only a durable 1013 capture count survives) -->
2. Pi detects replacement of a previously captured prefix even at the same prompt count and after reload. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-025: captures rewritten content with %i prompts under the same session ID) -->
3. Verified own trimming preserves surviving captured coverage and the twenty-prompt cadence; unrecognized shortening or captured-prefix replacement immediately starts retained-history recovery. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-025: rebases a legacy 1013 counter onto three retained prompts) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-025: resumes retained history when only a durable 1013 capture count survives) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-025: captures rewritten content with %i prompts under the same session ID) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-025 AC3: arms all three jobs for %s history despite a legacy Vault count of 741) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-025 AC3: re-arms all three jobs when exhausted history is replaced with %i prompts) --> <!-- @test: host/__tests__/pi-transcript-cadence-integration.test.js (own verified trim translates only the successful frontier: ${order}) -->
4. Rebasing leaves transcript bytes and capture bodies unchanged; verified own trimming may translate only checkpoint metadata. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-025: rebases a legacy 1013 counter onto three retained prompts) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-025: resumes retained history when only a durable 1013 capture count survives) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-025: captures rewritten content with %i prompts under the same session ID) --> <!-- @test: host/__tests__/pi-transcript-cadence-integration.test.js (own verified trim translates only the successful frontier: ${order}) -->
5. Transcript changes never mutate exact in-flight work. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-025: keeps an exact in-flight rebased request frozen when the transcript changes again) -->
6. Exhausted work from a replaced transcript epoch may be replaced immediately. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-025: replaces exhausted work from an earlier transcript epoch) -->
7. Unchanged exhausted work still requires twenty later real-user prompts before replacement. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-002 AC5: re-arms only after twenty later real prompts) -->

**Constraints:**

- Compaction preserving real-user history does not rebase progress.
- Fingerprints exclude tool and extraction lifecycle entries.
- An ephemeral active request pointer enables reload discovery.
- The request-specific execution snapshot in the shared home-backed cache remains immutable after the first exact public call.

**Priority:** P0

**Dependencies:** [REQ-MEM-002](#req-mem-002-capture-triggers-every-20-user-messages-and-on-resume)

**Verification:** Automated: [pi-transcript-cadence-integration.test.js](../../host/__tests__/pi-transcript-cadence-integration.test.js), [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts)

**Status:** Implemented

---

### REQ-MEM-026: Capture resume and durable Pi progress

**Intent:** Resumed capture starts at valid durable progress, including after Pi transcript rebasing and ephemeral-state loss.

**Applies To:** User

**Acceptance Criteria:**

1. A missing counter with multiple real-user prompts triggers resumed-session capture immediately on the first new prompt. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::FORCE_RESUME --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::latestCapturedPromptCount --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (captures only the uncaptured tail and hash-checks Vault on the first resumed prompt) -->
2. Resumed capture starts after durable successful progress only when that progress still belongs to the retained transcript. Claude requires an in-range saved count and matching SHA-256 of the retained real-prompt prefix; legacy or mismatched counts cannot skip unproven history. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::FORCE_RESUME --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::latestCapturedPromptCount --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (captures only the uncaptured tail and hash-checks Vault on the first resumed prompt) --> <!-- @test: host/__tests__/memory-capture-hook.test.js (REQ-MEM-026 AC2: Claude durable retained-prefix recovery) --> <!-- @test: host/__tests__/run-memory-capture.test.js (REQ-MEM-001 AC3 / MEM-026 AC2: hook-produced ${progress} resume cursor preserves the uncaptured payload) -->
3. Pi restores the most recent successful checkpoint by capture instant and name; an older, larger prompt count cannot override a later rebased capture. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::latestCapturedPromptCount --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-026: restores successful rebased progress ahead of an older larger count after restart) -->
4. Only exact correlated success with the required note and graph chunk commits rebased Pi progress. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeMemorySuccess --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-026: does not commit rebased progress for a %s request) -->
5. A successful Pi capture retains enough progress metadata to recover after all ephemeral state is lost. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeMemorySuccess --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-026: restores successful rebased progress ahead of an older larger count after restart) -->
6. Ordinary appends after rebasing resume the twenty-prompt cadence without recapturing the unchanged prefix. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeMemorySuccess --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::shouldCapture --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-026: keeps the twenty-prompt cadence for an unchanged captured prefix after rebasing) -->
7. Legacy captures without a fingerprint remain readable. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::latestCapturedPromptCount --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-025: resumes retained history when only a durable 1013 capture count survives) -->

**Constraints:**

- Durable Pi checkpoints sort by capture instant, then name.
- Creating or delivering a request never advances successful progress.

**Priority:** P0

**Dependencies:** [REQ-MEM-002](#req-mem-002-capture-triggers-every-20-user-messages-and-on-resume), [REQ-MEM-025](#req-mem-025-pi-capture-follows-transcript-epochs)

**Verification:** Automated: [memory-capture-hook.test.js](../../host/__tests__/memory-capture-hook.test.js), [run-memory-capture.test.js](../../host/__tests__/run-memory-capture.test.js), [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts)

**Status:** Implemented

---

### REQ-MEM-004: Vault contents synced to R2 across sessions

**Intent:** Vault content (agent captures + user notes) must persist across container lifecycles by syncing to the user's R2 bucket.

**Applies To:** User

**Acceptance Criteria:**

1. In advanced mode, the user's vault directory and cumulative Vault graph source of truth are included in R2 sync. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (advanced mode: includes the vault tree AND its vault-graph.json despite the global graphify-out exclude (REQ-MEM-004 AC1 / REQ-VAULT-001 AC1)) -->
2. On container boot, R2 restore precedes Vault initialization so returning sessions inherit persisted Vault content without the skeleton overwriting it. <!-- @impl: entrypoint.sh::run_initial_r2_restore --> <!-- @impl: entrypoint.sh::complete_managed_curation_startup --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->
3. Vault directory initialization preserves existing user content while filling missing managed directories and the missing graph page. Repeating complete initialization creates neither further directories nor a graph page; populated but incomplete vaults may receive these missing resources. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (init_user_vault does not clobber existing user vault content on re-run (REQ-MEM-004 AC3)) -->
4. Vault changes are pushed back to R2 on three triggers: the regular sync cadence ([REQ-STOR-003](storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)), the Sync-now button ([REQ-STOR-015](storage.md#req-stor-015-explicit-sync-trigger-from-ui)), and the final shutdown sync ([REQ-STOR-005](storage.md#req-stor-005-graceful-shutdown-performs-final-sync)). <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (SIGUSR1 interrupts the cadence sleep and triggers bisync immediately (REQ-STOR-003 AC2 / REQ-STOR-015 AC5 / REQ-MEM-004 AC4: SIGUSR1 trigger)) -->
5. The ephemeral unified-graph layer and derived Vault graph/visualization intermediates are rebuilt locally and not synced; the served visualization remains durably stored in the Vault. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (advanced mode: excludes the per-run derived vault graph.json but keeps the cumulative one (REQ-MEM-004 AC5: derived layer not synced)) -->
6. The shutdown handler watchdog allows the final bisync up to 120s to drain pending writes before forced termination. <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-STOR-005 AC4 / REQ-MEM-004 AC6: real watchdog signals and kills stuck sync after released 108s and 12s clock waits) --> <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010: Graceful container shutdown preserves data) -->

**Constraints:**

- Vault and ordinary workspace content are synced; transient memory-counter files are not.
- R2 sync must be reliable under multipart-upload conditions without checksum metadata.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-001](vault.md#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** Automated: [entrypoint-bisync-behavior.test.js](../../host/__tests__/entrypoint-bisync-behavior.test.js), [entrypoint-rclone-filters.test.js](../../host/__tests__/entrypoint-rclone-filters.test.js), [entrypoint-shutdown.test.js](../../host/__tests__/entrypoint-shutdown.test.js), [entrypoint-vault-boot.test.js](../../host/__tests__/entrypoint-vault-boot.test.js)

**Status:** Implemented

---

### REQ-MEM-006: Memory available only in Pro (Advanced) mode

**Intent:** Vault persistence and automatic capture are user-facing features gated behind the advanced session mode. This REQ specifies the observable behavior (what works in each mode) and the preseed delta (which files differ between modes). The storage/resolution/propagation of the mode value lives in [REQ-MEM-011](#req-mem-011-session-mode-storage-resolution-and-propagation).

**Applies To:** User

**Acceptance Criteria:**

1. Vault sync preserves the Vault tree across container recreations only in advanced mode and excludes it in default mode. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (entrypoint.sh rclone filter behavior (real) / REQ-MEM-004 (vault in R2 sync) / REQ-MEM-006 (advanced-only) / REQ-VAULT-001 (vault filter order) / REQ-STOR-004 (static excludes)) -->
2. In default mode, no memory-capture hook, capture counter, or persisted Vault write machinery is registered. <!-- @impl: entrypoint.sh::SETTINGS_CONFIG --> <!-- @manual -->
3. The memory plugin, the memory rule (which carries the folded vault trigger/route content), the vault plugin, and the vault-note-capture rule are preseeded only in advanced mode. <!-- @manual -->
4. Pro mode seeds a strict superset of Standard's preseed files; the memory and vault plugins/rules are part of the Pro-only delta. <!-- @manual -->

**Constraints:**

- Plugin registration is not removed on mode downgrade; missing plugin files are silently skipped at runtime.

**Priority:** P1

**Dependencies:** [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier)

**Verification:** Automated: [entrypoint-rclone-filters.test.js](../../host/__tests__/entrypoint-rclone-filters.test.js); Manual: [Memory manifest and prompt delivery acceptance](../../documentation/lanes/preseed.md#memory-manifest-and-prompt-delivery-acceptance)

**Status:** Implemented

---

### REQ-MEM-008: Memory prompt files preseeded via manifest pipeline

**Intent:** Memory capture prompt files must be deployed alongside the rest of the preseed content through the standard manifest pipeline.

**Applies To:** User

**Acceptance Criteria:**

1. The capture prompt is preseeded into the session-installed memory plugin alongside its scripts. <!-- @manual -->
2. The memory plugin's scripts (hook, prompt, prefilter) and the capture subagent definition (with overridable Sonnet defaults per [AD124](../../documentation/decisions/README.md#ad124-bounded-re-delivery-replaces-the-memory-capture-hard-block)) are delivered through the managed manifest as installed content and a named subagent ([REQ-AGENT-008](agents.md#req-agent-008-preseed-deployed-to-container-on-start)). <!-- @impl: preseed/agents/claude/manifest.json::modes --> <!-- @manual -->
3. All memory-plugin entries are marked advanced-only in the manifest. <!-- @manual -->
4. The delivered plugin hook is registered only through the assembled session settings, not through the plugin loader. <!-- @manual -->
5. Memory-plugin source lives in the single preseed source tree. <!-- @manual -->
6. The manifest-derived runtime seed delivered by the Worker contains the memory-plugin files. <!-- @manual -->
7. Claude memory plugin files are not generically adapted for non-Claude agents. <!-- @manual -->

**Constraints:**

- Plugin files are updated when the pipeline is redeployed and users explicitly recreate their preseed.
- Only files listed in the manifest are included in the generated payload.

**Priority:** P1

**Dependencies:** [REQ-AGENT-003](agents.md#req-agent-003-agent-cli-auto-started-in-tab-1)

**Verification:** Manual: [Memory manifest and prompt delivery acceptance](../../documentation/lanes/preseed.md#memory-manifest-and-prompt-delivery-acceptance)

**Status:** Implemented

---

### REQ-MEM-009: Vault graph accumulates monotonically across extractions

**Intent:** Every vault writer, across extraction and capture in both agent runtimes, must add new nodes to one cumulative vault contribution without destroying knowledge from prior passes.

**Applies To:** System

**Acceptance Criteria:**

1. Successive vault graph merges preserve nodes from prior passes. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/merge-vault-graph.py::merge_node_link_evidence --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::merge_node_link_evidence --> <!-- @test: host/__tests__/vault-extract-merge.test.js (REQ-MEM-009 AC1/AC2: successive merges preserve prior nodes and deduplicate IDs) -->
2. Each pass emits at most one graph node for each node ID. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/merge-vault-graph.py::merge_node_link_evidence --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::merge_node_link_evidence --> <!-- @test: host/__tests__/vault-extract-merge.test.js (REQ-MEM-009 AC1/AC2: successive merges preserve prior nodes and deduplicate IDs) -->
3. Duplicate ordinary edge evidence collapses. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/merge-vault-graph.py::edge_evidence_key --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::edge_evidence_key --> <!-- @test: host/__tests__/vault-extract-merge.test.js (REQ-MEM-009 AC3: edge evidence is keyed by semantic tuple) -->
4. The evidence fold ignores malformed edge entries. The preceding Graphify parser can reject non-object edges before that fold runs. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/merge-vault-graph.py::node_link_edges --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::node_link_edges --> <!-- @test: host/__tests__/vault-extract-merge.test.js (REQ-MEM-009 AC4: malformed edge entries are ignored without crashing) -->
5. Evidence from separate archived captures remains distinct through later merges. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/merge-vault-graph.py::edge_evidence_key --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::edge_evidence_key --> <!-- @test: host/__tests__/vault-extract-merge.test.js (REQ-MEM-009: archived edge evidence survives relocation, repetition, and later merges) -->

**Constraints:**

- Vault-extract and memory-capture writers on both runtimes author request chunks and fold them through the shared merge path.
- Vault is always-on in the global graph.
- Vault graph merges share the capture-pipeline/global-graph lock with [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault) publishers; its timeout bounds lock acquisition. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/publish-memory-capture.sh::LOCK_FILE -->
- Missing or unreadable graph files retain the established fresh-graph recovery path.
- Each merge copies the cumulative `vault-graph.json` to the sibling `graph.json`; only `vault-graph.json` is read back and published, and an empty `graph.json` at boot is not evidence there is nothing to publish.
- No HTML visualization is generated for the unified global graph; structural queries are the interface; only the curated vault subset receives a rendered visualization shipped to users.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-VAULT-002](vault.md#req-vault-002-conversation-captures-land-in-the-vault-as-markdown)

**Verification:** Automated: [vault-extract-merge.test.js](../../host/__tests__/vault-extract-merge.test.js)

**Status:** Implemented

---

### REQ-MEM-034: Cumulative Vault Graph Boot Publication

**Intent:** Boot publishes the cumulative vault contribution without replacing it with an empty derived scaffold or failing before the first capture.

**Applies To:** System

**Acceptance Criteria:**

1. The boot seed publishes the cumulative vault graph under the `user_vault` tag, never the derived sibling graph that is empty until the first extraction. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (publishes vault-graph.json under the user_vault tag, never the empty scaffold (REQ-MEM-009)) -->
2. A first boot with no captures yet, and therefore no cumulative vault graph on disk, publishes nothing to the global graph and reports no failure. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (publishes nothing when no cumulative vault graph exists yet (REQ-MEM-009)) -->

**Constraints:**

- Vault is always-on in the global graph.
- Missing or unreadable graph files retain the established fresh-graph recovery path.
- Boot publication shares the capture-pipeline/global-graph lock with [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault) publishers; its timeout bounds lock acquisition. <!-- @impl: entrypoint.sh::init_user_vault -->
- Each merge copies the cumulative `vault-graph.json` to the sibling `graph.json`; only `vault-graph.json` is read back and published, and an empty `graph.json` at boot is not evidence there is nothing to publish.
- No HTML visualization is generated for the unified global graph; structural queries are the interface; only the curated vault subset receives a rendered visualization shipped to users.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-VAULT-002](vault.md#req-vault-002-conversation-captures-land-in-the-vault-as-markdown)

**Verification:** Automated: [entrypoint-vault-boot.test.js](../../host/__tests__/entrypoint-vault-boot.test.js)

**Status:** Implemented
---

### REQ-MEM-010: Memory capture hook plumbing

**Intent:** Capture timestamps reflect the user's local timezone, the hook fires reliably regardless of path format or session state, and a fabrication-resistant timestamp assertion fails closed if the subagent guesses the timestamp instead of producing a real one.

**Applies To:** User

**Acceptance Criteria:**

1. The hook tolerates tilde-prefixed transcript paths. <!-- @test: host/__tests__/memory-capture-hook.test.js (expands ~ in transcript_path to $HOME) --> <!-- @manual -->
2. The model receives bounded self-contained inline metadata and prefiltered uncaptured user/assistant content, not a raw transcript path to retrieve. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/run-memory-capture.sh::TASK --> <!-- @test: host/__tests__/run-memory-capture.test.js (hands the model a prepared payload instead of the raw transcript) --> <!-- @manual -->
3. On the first message of a new container session, the hook injects graph-query guidance before the agent responds. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::MEMORY_SCAN --> <!-- @test: host/__tests__/memory-capture-hook.test.js (AC7 boundary - missing counter + transcript with exactly 1 prompt is brand-new (no capture)) -->
4. The hook resolves the capture timezone from the user preference ([REQ-SESSION-016](session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env)), falling back to the container default and finally to UTC. <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) --> <!-- @manual -->
5. The capture timestamp is validated against the current wall clock and rejected if fabricated, missing a timezone offset, or mismatching the resolved timezone. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh::RESOLVED --> <!-- @test: host/__tests__/memory-iso-ts-script.test.js (assert-iso-ts.sh / REQ-MEM-010 AC5+AC6+AC7) -->
6. A timestamp whose offset does not match the resolved timezone is rejected; this catches dropped-timezone-wrapper bugs without false-positiving legitimately-UTC hosts. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh::RESOLVED --> <!-- @test: host/__tests__/memory-iso-ts-script.test.js (AC6 #416 regression: Europe/Zurich + ISO_TS ending in +0000 rejected) -->
7. A timestamp more than 30 seconds away from the current wall clock is rejected. Any assertion failure halts the capture rather than writing a confabulated timestamp to the vault. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh::RESOLVED --> <!-- @test: host/__tests__/memory-iso-ts-script.test.js (AC7 freshness drift: a year-old fabricated timestamp rejected) --> <!-- @test: host/__tests__/memory-iso-ts-script.test.js (REQ-MEM-010 AC7: admits exactly 30 seconds of drift and rejects 31 in both directions) --> <!-- @test: host/__tests__/memory-capture-hook.test.js (arms nothing and says why when the timestamp helper fails its assertions) -->

**Constraints:**

- Claude: the carrier file is retry state and remains until the locked merge/publication command removes it after success.
- Pi: the separate root-owned delivery contract is specified by [REQ-MEM-002](#req-mem-002-capture-triggers-every-20-user-messages-and-on-resume) AC5–AC7.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-SESSION-016](session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env)

**Verification:** Automated: [memory-capture-hook.test.js](../../host/__tests__/memory-capture-hook.test.js), [run-memory-capture.test.js](../../host/__tests__/run-memory-capture.test.js), [container-env.test.ts](../../src/__tests__/container/container-env.test.ts), [memory-iso-ts-script.test.js](../../host/__tests__/memory-iso-ts-script.test.js); Manual: [Memory hook and short prompt acceptance](../../documentation/lanes/vault.md#memory-hook-and-short-prompt-acceptance)

**Status:** Implemented

---

### REQ-MEM-022: Resumed sessions re-emit memory graph guidance

**Intent:** A resumed conversation must consult durable graph context after its in-memory orientation was lost with the previous container.

**Applies To:** User

**Acceptance Criteria:**

1. On the first message of a resumed container session, the hook injects graph-query guidance before the agent responds. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::MEMORY_SCAN --> <!-- @test: host/__tests__/memory-capture-hook.test.js (AC7 - missing counter + transcript with >1 prompt force-fires capture from line 1) -->

**Constraints:**

- Guidance reuses the existing first-message hook output; no separate retrieval service or launch is added.

**Priority:** P0

**Dependencies:** [REQ-MEM-002](#req-mem-002-capture-triggers-every-20-user-messages-and-on-resume), [REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing)

**Verification:** Automated: [memory-capture-hook.test.js](../../host/__tests__/memory-capture-hook.test.js)

**Status:** Implemented

---

### REQ-MEM-011: Session-mode storage, resolution, and propagation

**Intent:** The session mode behind [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode) must be stored, defaulted, clamped against billing entitlement, and reconciled into agent configuration without trampling user content.

**Applies To:** User

**Acceptance Criteria:**

1. In default mode, only baseline agent permissions are applied; capture hooks are not registered. <!-- @impl: entrypoint.sh::SETTINGS_CONFIG --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (settings.json configuration / REQ-AGENT-015 (/review command)) -->
2. If no session mode has been explicitly set, the default mode applies unless [Enterprise policy](subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) forces Pro. <!-- @impl: src/lib/session-mode.ts::resolveSessionMode --> <!-- @test: src/__tests__/lib/session-mode.test.ts (resolveSessionMode / REQ-AGENT-004 (two session modes: default and advanced; default when prefs unset; honors persisted sessionMode)) --> <!-- @test: src/__tests__/lib/session-mode.test.ts (resolveSessionMode / REQ-ENTERPRISE-001 AC2 (enterprise forces Pro regardless of the stored preference)) -->
3. Agent configuration reconciles on initial bucket creation, explicit "Recreate AI agent skills & rules", a persisted session-mode preference change, subscription-driven mode change, and the one-time Enterprise Pro upgrade at session start ([REQ-ENTERPRISE-315](subscription.md#req-enterprise-315-enterprise-pro-seed-migration) AC1). <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @impl: src/routes/preferences.ts::app --> <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @impl: src/routes/container/lifecycle-init.ts::ensureBucketAndSeed --> <!-- @test: src/__tests__/routes/preferences.test.ts (sessionMode preference / REQ-MEM-011 (sessionMode preference persistence + preseed reconciliation)) --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-MEM-011 AC3: reconcileAgentConfigs gated on the new-bucket trigger) --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-ENTERPRISE-001 AC6: enterprise upgrade reconcile for pre-existing users) -->
4. On a mode change, mode-appropriate managed files are written and out-of-mode files are removed under existing [ownership rules](storage.md#req-stor-021-managed-content-ownership); unrelated user files remain untouched. Desired managed paths may be overwritten, and active [exclusive-policy roots](storage.md#req-stor-032-exclusive-managed-resource-boundaries) retain their authorized cleanup semantics. <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (REQ-STOR-010 AC2/AC3/AC4: real mode reconciliation overwrites variants, removes out-of-mode configs, and retains user bytes) --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/routes/preferences.test.ts (sessionMode preference / REQ-MEM-011 (sessionMode preference persistence + preseed reconciliation)) -->
5. Successful managed mode-change publication preserves unrelated preference fields in its publication snapshot. <!-- @impl: src/routes/preferences.ts::default --> <!-- @test: src/__tests__/routes/preferences.test.ts (REQ-MEM-011 AC5: target journaling preserves concurrent preference changes) --> <!-- @test: src/__tests__/routes/preferences.test.ts (REQ-MEM-011 AC5: preserves a preference update during applied digest preparation) -->
6. A managed mode change does not publish applied state when its publication snapshot contains a different selected mode or managed state. <!-- @impl: src/routes/preferences.ts::default --> <!-- @test: src/__tests__/routes/preferences.test.ts (REQ-MEM-011 AC6: final publication snapshot rejects a concurrent mode change) --> <!-- @test: src/__tests__/routes/preferences.test.ts (REQ-MEM-011 AC6: aborts stale reconciliation without reverting a concurrent mode update) -->

**Constraints:**

- Existing buckets reconcile automatically when persisted preference or subscription mode changes; explicit recreation remains the manual repair/refresh path.
- A billing-canceled user's stored session mode is downgraded to default at resolution time.

**Priority:** P1

**Dependencies:** [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier)

**Verification:** Automated: [entrypoint-hooks-merge.test.js](../../host/__tests__/entrypoint-hooks-merge.test.js), [session-mode.test.ts](../../src/__tests__/lib/session-mode.test.ts), [container-r2-start.test.ts](../../src/__tests__/routes/container-r2-start.test.ts), [preferences.test.ts](../../src/__tests__/routes/preferences.test.ts), [r2-seed-mode.test.ts](../../src/__tests__/lib/r2-seed-mode.test.ts)

**Status:** Implemented

---

<a id="req-mem-012-hard-block-tool-calls-while-memory-capture-is-deferred"></a>
### REQ-MEM-020: Capture requests are re-delivered under a bound

**Intent:** A capture directive that the agent does not act on must come back rather than disappear without making one hook able to wedge the session.

**Applies To:** Agent

**Acceptance Criteria:**

1. Arming a capture writes a durable request carrying the absolute capture path and timestamp the subagent must use verbatim, so success is decided by an artifact rather than by self-report. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::CAPTURE_FILE --> <!-- @test: host/__tests__/memory-capture-hook.test.js (arms a request carrying the capture path the publisher will verify) -->
2. Arming does not advance the committed counter, so a capture that fails leaves its window uncommitted for a later request to cover. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::CAPTURE_FILE --> <!-- @test: host/__tests__/memory-capture-hook.test.js (does not advance the counter when arming, so a failed capture is retried not lost) -->
3. While a request is outstanding the hook relaunches it once per user prompt and counts each launch, instead of arming a second request. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::MAX_ATTEMPTS --> <!-- @test: host/__tests__/memory-capture-hook.test.js (re-delivers an outstanding request on the next prompt instead of dropping it) --> <!-- @test: host/__tests__/memory-capture-hook.test.js (an armed request suppresses a second arm without closing the window) -->
4. After six launches the request latches, consumes no further launch, and the hook falls silent until a replacement may arm. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::LATCH_FILE --> <!-- @test: host/__tests__/memory-capture-hook.test.js (latches after the sixth delivery and stops reminding) -->
5. A prompt arriving while a capture is still running spends no launch, and leaves an outstanding request intact. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::capture_running --> <!-- @test: host/__tests__/memory-capture-hook.test.js (spends no attempt on a prompt that arrives while a capture is running) -->
6. No hook blocks tool calls on behalf of memory capture. <!-- @impl: entrypoint.sh::SETTINGS_CONFIG --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (advanced mode registers each managed hook on its own event type) -->
7. The outstanding capture request retains small durable retry state until successful publication, subject to AC4's bounded replacement rule. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::VARS_FILE --> <!-- @test: host/__tests__/memory-capture-hook.test.js (re-delivers an outstanding request on the next prompt instead of dropping it) --> <!-- @test: host/__tests__/memory-capture-pipeline.test.js (publish-memory-capture.sh (REQ-MEM-001 AC6)) --> <!-- @manual -->

**Constraints:**

- The capture agent carries no `model:` pin; fidelity is selected by `CODEFLARE_MEMORY_MODEL`.
- The capture contract is bounded to six agent turns (`CODEFLARE_MEMORY_MAX_TURNS`, default 6).

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-002](#req-mem-002-capture-triggers-every-20-user-messages-and-on-resume)

**Verification:** Automated: [entrypoint-hooks-merge.test.js](../../host/__tests__/entrypoint-hooks-merge.test.js), [memory-capture-hook.test.js](../../host/__tests__/memory-capture-hook.test.js), [memory-capture-pipeline.test.js](../../host/__tests__/memory-capture-pipeline.test.js); Manual: [Memory hook and short prompt acceptance](../../documentation/lanes/vault.md#memory-hook-and-short-prompt-acceptance)

**Status:** Implemented

---

### REQ-MEM-021: Capture publication requires its artifact

**Intent:** A capture that never produced its requested file must not be recorded as committed.

**Applies To:** Agent

**Acceptance Criteria:**

1. Publication refuses and retains the carrier when the request's capture file is absent. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/publish-memory-capture.sh::CAPTURE_FILE --> <!-- @test: host/__tests__/memory-capture-hook.test.js (refuses to publish and keeps the carrier when the capture file is absent) -->
2. Publication commits the counter and drains the carrier once the capture file exists, and never moves the counter backwards. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/publish-memory-capture.sh::COUNTER_FILE --> <!-- @test: host/__tests__/memory-capture-hook.test.js (commits the counter and drains the carrier once the artifact exists) --> <!-- @test: host/__tests__/memory-capture-hook.test.js (never drags the committed counter backwards) -->
3. A Pi retry recognizes an already-published note/chunk pair only when its frontmatter identity, including the prompt fingerprint when supplied, matches the frozen request and its chunk matches the deterministic graph. <!-- @impl: preseed/agents/pi/scripts/recover-memory-capture.py::main --> <!-- @test: host/__tests__/pi-memory-capture-recovery.test.js (REQ-MEM-021: recovers an exact published note and real deterministic chunk read-only and idempotently) --> <!-- @test: host/__tests__/pi-memory-capture-recovery.test.js (REQ-MEM-021: recovers a fingerprint-bound receipt read-only and idempotently) -->
4. Recovery is read-only: it neither recaptures nor republishes. <!-- @impl: preseed/agents/pi/scripts/recover-memory-capture.py::main --> <!-- @test: host/__tests__/pi-memory-capture-recovery.test.js (REQ-MEM-021: recovers an exact published note and real deterministic chunk read-only and idempotently) -->
5. Partial, mismatched or redirected receipts fail closed. <!-- @impl: preseed/agents/pi/scripts/recover-memory-capture.py::main --> <!-- @test: host/__tests__/pi-memory-capture-recovery.test.js (REQ-MEM-021: refuses an escaped ${component} FIFO before reading outside the Vault) --> <!-- @test: host/__tests__/pi-memory-capture-recovery.test.js (REQ-MEM-021: rejects a partial post-commit receipt missing its ${missing}) --> <!-- @test: host/__tests__/pi-memory-capture-recovery.test.js (REQ-MEM-021: rejects a deterministic pair whose note ${field} differs from the frozen request) -->
6. Root progress still requires exact successful native completion. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeMemorySuccess --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-020 / REQ-MEM-021: published artifacts after a legacy abort wait for an exact completed retry) -->
7. Pi memory workers accept the documented required fields and optional prompt fingerprint; malformed or unknown fields fail closed. <!-- @impl: preseed/agents/pi/prompts/memory-agent-prompt.md::pi-memory-capture-contract --> <!-- @impl: preseed/agents/pi/scripts/recover-memory-capture.py::main --> <!-- @test: host/__tests__/pi-memory-capture-recovery.test.js (REQ-MEM-014: worker contract declares the fingerprinted execution-snapshot wire fields) --> <!-- @test: host/__tests__/pi-memory-capture-recovery.test.js (REQ-MEM-014: accepts a fingerprinted fresh request without modifying root-owned state) -->

**Constraints:**

- The capture agent carries no `model:` pin; fidelity is selected by `CODEFLARE_MEMORY_MODEL`.
- Claude capture is bounded to six agent turns (`CODEFLARE_MEMORY_MAX_TURNS`, default 6); Pi's separate execution budget is owned by [REQ-MEM-016](#req-mem-016-pi-extraction-requests-have-a-bounded-execution-profile).

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-002](#req-mem-002-capture-triggers-every-20-user-messages-and-on-resume), [REQ-MEM-020](#req-mem-020-capture-requests-are-re-delivered-under-a-bound)

**Verification:** Automated: [memory-capture-hook.test.js](../../host/__tests__/memory-capture-hook.test.js), [pi-memory-capture-recovery.test.js](../../host/__tests__/pi-memory-capture-recovery.test.js), [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts)

**Status:** Implemented

---

### REQ-MEM-013: Proactive memory injection on first prompt

**Intent:** The agent receives relevant prior context (vault notes, code concepts, past decisions) automatically on the first user message of each session, without requiring an explicit tool call. Keywords are extracted from the user's prompt and matched against the unified graphify graph; matched nodes are injected as additionalContext in the hook response so the agent sees them before responding.

**Applies To:** Agent

**Acceptance Criteria:**

1. On the first user message of a session, the hook extracts keywords from the prompt and queries the unified graph for matching nodes. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh::COUNTER_DIR --> <!-- @test: host/__tests__/memory-context-inject.test.js (AC1: injects matched nodes from global graph on first prompt) -->
2. Matched nodes (up to 10) are injected as additionalContext in the UserPromptSubmit hook response, with labels, source paths, descriptions, framing, and truncation markers charged against one 4096-byte rendered UTF-8 budget. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh::MAX_RENDERED_BYTES --> <!-- @impl: preseed/agents/pi/extensions/memory-inject-helpers.ts::MEMORY_INJECT_MAX_RENDERED_BYTES --> <!-- @test: host/__tests__/memory-context-inject.test.js (AC2: bounds the complete rendered context in UTF-8 bytes) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (bounds complete Pi injection and recall output with multibyte metadata) -->
3. At most one successful injection is admitted per session, with eligibility consumed only after a successful graph query and independently of the capture count. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh::COUNTER_DIR --> <!-- @test: host/__tests__/memory-context-inject.test.js (AC3: fires at most once per session (sentinel directory prevents re-fire)) -->
4. Prompts shorter than 20 characters are skipped (insufficient signal for keyword extraction). <!-- @test: host/__tests__/memory-context-inject.test.js (AC4: skips prompts shorter than 20 characters) --> <!-- @manual -->
5. The unified graph is the only source queried; no per-repo graph is accepted as a substitute for it. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh::GLOBAL_GRAPH --> <!-- @impl: preseed/agents/pi/extensions/memory-inject.ts::resolveGraphPath --> <!-- @test: src/__tests__/lib/pi-memory-inject.test.ts (AC5: reads the unified graph only, and only within the ceiling) --> <!-- @test: src/__tests__/lib/pi-memory-inject.test.ts (AC5: substitutes no repo graph even when one sits in the working directory) -->
6. Pi injects first-real-prompt results under the shared ranking, node cap and once-per-session guard. <!-- @impl: preseed/agents/pi/extensions/memory-inject.ts::registerMemoryInject --> <!-- @impl: preseed/agents/pi/extensions/memory-inject-helpers.ts::selectNodes --> <!-- @test: src/__tests__/lib/pi-memory-inject.test.ts (AC1: injects matched nodes into the turn as a message) --> <!-- @test: src/__tests__/lib/pi-memory-inject.test.ts (AC3: fires at most once per session) --> <!-- @test: src/__tests__/lib/pi-memory-inject.test.ts (AC2: at most ten nodes are carried) -->
7. An oversized graph does not consume injection eligibility; a later prompt may qualify when the graph is readable again. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh::MAX_GRAPH_BYTES --> <!-- @test: host/__tests__/memory-context-inject.test.js (AC7: skips a graph past the ceiling without spending the session sentinel) -->

**Constraints:**

- Keyword preselection uses Claude’s first 200 bytes and Pi’s first 200 UTF-16 code units; multibyte keyword selection need not match. <!-- @impl: preseed/agents/pi/extensions/memory-inject-helpers.ts::PROMPT_SCAN_CHARS -->

- The JSON ceiling defaults to 104857600 bytes (100 MiB); both runtimes accept positive decimal overrides from 1 through 1073741824 bytes (1 GiB), without guaranteeing resident-memory use or latency.
- Apply the 100 MiB guard when the override is invalid or out of range. <!-- @test: src/__tests__/lib/pi-memory-inject.test.ts (REQ-MEM-013: accepts only positive decimal overrides up to 1 GiB) --> <!-- @test: host/__tests__/memory-context-inject.test.js (AC7: an out-of-range numeric ceiling falls back instead of voiding the guard) --> <!-- @test: src/__tests__/lib/pi-memory-inject.test.ts (AC5: an injected ceiling is not outranked by the ambient environment) -->
- The hook plugin is advanced-session-only by manifest declaration (`preseed/agents/claude/manifest.json`); standard sessions never receive the plugin.
- The hook reads graph JSON directly.
- Claude and Pi use separate injection implementations.
- Ranking weights, node cap, rendered shape, UTF-8 output ceiling and sentinel semantics are shared; keyword preselection uses AC6's runtime-specific units without guaranteed multibyte equivalence.
- The Pi side skips synthetic prompts, which the hook runtime never delivers.
- An injection error exits silently without output or blocking the session.
- Keyword extraction strips non-alphanumerics and keeps words of at least four characters.

**Priority:** P1

**Dependencies:** [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-004](vault.md#req-vault-004-unified-global-graph-merges-vault-and-active-repos)

**Verification:** Automated: [memory-context-inject.test.js](../../host/__tests__/memory-context-inject.test.js), [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts), [pi-memory-inject.test.ts](../../src/__tests__/lib/pi-memory-inject.test.ts); Manual: [Memory hook and short prompt acceptance](../../documentation/lanes/vault.md#memory-hook-and-short-prompt-acceptance)

**Status:** Implemented

---

### REQ-MEM-019: Post-compaction recall of recent session extracts

**Intent:** Compaction replaces the conversation with a summary while keeping the same session, so the first-prompt injection has already fired and never runs again. The agent then resumes from a summary of a summary, having lost the concrete decisions, corrections and identifiers of prior work — restating plans that were settled and to-do items that were finished. Recent session extracts are injected when a session resumes from compaction, so what was actually decided survives the boundary.

**Applies To:** Agent

**Acceptance Criteria:**

1. Post-compaction recall selects the most recent session extracts newest first under the configured count. Pi and Claude use the same selection, bounds and injected wording; Claude injects them as additionalContext. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh::EXTRACT_COUNT --> <!-- @test: host/__tests__/post-compaction-recall.test.js (AC1: injects the N most recent extracts newest-first as SessionStart context) -->
2. Recency is decided by the capture instant carried in the extract name rather than by modification time or by that name's text, so neither a file sync that rewrites timestamps nor a change of UTC offset can reorder or starve the selection. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh::sort_key --> <!-- @test: host/__tests__/post-compaction-recall.test.js (AC2: orders by filename even when mtime disagrees) --> <!-- @test: host/__tests__/post-compaction-recall.test.js (AC2: orders by captured instant across a UTC-offset change) -->
3. No context is injected for a session that did not resume from compaction, so sessions that never lost context pay nothing. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh::SOURCE --> <!-- @test: host/__tests__/post-compaction-recall.test.js (AC3: stays silent unless the session started from compaction) -->
4. Each extract's complete rendered contribution—title, source path, section bodies, and any truncation marker—fits one UTF-8 byte budget. Both runtimes reserve the exact Source path before title/body bytes and omit a block when even minimal source metadata cannot fit. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh::PER_FILE_BYTES --> <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall-helpers.ts::recallBlock --> <!-- @test: host/__tests__/memory-context-inject.test.js (REQ-MEM-019 AC4: charges title, multibyte source path, body, and marker to one extract budget) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (bounds complete Pi injection and recall output with multibyte metadata) -->
5. Content dropped by that bound is marked as truncated, with the exact multibyte source path retained so the remainder stays reachable. <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (REQ-MEM-019 AC5: dropped body has a visible truncation marker and exact multibyte Source within the byte cap) --> <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh::PER_FILE_BYTES --> <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall-helpers.ts::recallBlock --> <!-- @test: host/__tests__/memory-context-inject.test.js (REQ-MEM-019 AC4: charges title, multibyte source path, body, and marker to one extract budget) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (bounds complete Pi injection and recall output with multibyte metadata) -->
6. Pi delivers recall as a persisted message on its compaction event, never in a child session. <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall.ts::registerPostCompactionRecall --> <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall.ts::buildRecall --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::captureFilenameAt --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (delivers the recall on compaction as a persisted follow-up) --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (stays out of a child session) --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (AC1: builds the digest newest-first, bounded by the extract count) --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (AC6: selects a filename produced by Pi capture alongside Claude extracts) -->
7. The parser selects narrative and decision headings and treats backtick-fenced headings as content. Tilde fences are not recognized, so headings inside them can alter selection. The full extract remains reachable through the emitted source path. <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall-helpers.ts::recallBlock --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (AC1: carries Context and Decisions, and never Observations) --> <!-- @test: host/__tests__/post-compaction-recall.test.js (does not end a section at a "## " line inside a fenced block) -->

**Notes:** Claude and Pi carry separate implementations for differing injection surfaces. Recall delivery is documented at [memory delivery](../../documentation/lanes/vault.md#first-prompt-and-post-compaction-retrieval).

**Constraints:**

- Injected text is a record, not instructions.
- The hook plugin is advanced-session-only by manifest declaration; standard sessions never receive it.
- The per-extract bound is a byte bound and is never exceeded; the truncation notice is spent from it and dropped when it cannot fit. <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (AC4: holds the bound even when the cap cannot fit the marker) --> <!-- @test: host/__tests__/post-compaction-recall.test.js (AC4: a nonsensical cap carries nothing rather than everything) -->
- Both runtimes break equal capture instants by descending extract name. <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (AC2: breaks a shared instant on the name, descending) -->
- Both runtimes are fail-safe: an error anywhere — including inside Pi's compaction dispatch — is swallowed with no output and never blocks the session. <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (swallows a delivery failure instead of throwing into the compaction dispatch) -->
- Session selection follows the bounded lookup in [REQ-MEM-027](#req-mem-027-session-scoped-post-compaction-recall).

**Priority:** P1

**Dependencies:** [REQ-MEM-013](#req-mem-013-proactive-memory-injection-on-first-prompt)

**Verification:** Automated: [memory-context-inject.test.js](../../host/__tests__/memory-context-inject.test.js), [post-compaction-recall.test.js](../../host/__tests__/post-compaction-recall.test.js), [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts), [pi-post-compaction-recall.test.ts](../../src/__tests__/lib/pi-post-compaction-recall.test.ts)

**Status:** Implemented

---

### REQ-MEM-027: Session-scoped post-compaction recall

**Intent:** Recall prioritizes usable active-session evidence without mistaking narrative text for session identity or reading unrelated note bodies to discover identity.

**Applies To:** Agent

**Acceptance Criteria:**

1. Within bounded lookup, both runtimes prefer up to the configured count of usable captures whose frontmatter `session_id` exactly matches the active session ID, newest first; a partial matching set is never topped up with unrelated sessions. <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall.ts::buildRecall --> <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh::RAW --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (REQ-MEM-027: prefers exact active-session captures over newer unrelated captures without topping up) --> <!-- @test: host/__tests__/post-compaction-recall.test.js (REQ-MEM-027: prefers the active session and never fills its recall with other sessions) -->
2. If identity is unavailable or no usable match is found within bounded lookup, both runtimes use collected latest global candidates under the same count and byte bounds. <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall.ts::buildRecall --> <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh::RAW --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (REQ-MEM-027: fails open to global recall if session identity cannot be read) --> <!-- @test: host/__tests__/post-compaction-recall.test.js (REQ-MEM-027: falls back to global latest captures when no usable session match exists) -->
3. Identity-like text in a narrative is not metadata. <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall.ts::buildRecall --> <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh::RAW --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (REQ-MEM-027: bounds matching captures before rendering and ignores session IDs in narrative text) --> <!-- @test: host/__tests__/post-compaction-recall.test.js (REQ-MEM-027: bounds active-session matches and ignores identity-like narrative text) -->
4. Session-identity lookup reads at most 2048 bytes per note for frontmatter metadata instead of loading unrelated note bodies. <!-- @test: host/__tests__/post-compaction-recall.test.js (REQ-MEM-027 AC4/AC7: reads at most 2048 metadata bytes per note and no noncandidate bodies) --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (REQ-MEM-027 AC4/AC7: reads at most 2048 metadata bytes per note and no noncandidate bodies) --> <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall.ts::buildRecall --> <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh::RAW --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (REQ-MEM-027: keeps the latest-five global fallback when an older capture has %s) --> <!-- @test: host/__tests__/post-compaction-recall.test.js (REQ-MEM-027: keeps the latest-five global fallback when an older capture has ${label}) -->
5. Symlinked and non-regular captures are rejected, but occupy positions in the initial global filename window and can exclude older usable fallback notes. <!-- @test: host/__tests__/post-compaction-recall.test.js (REQ-MEM-027 AC5: rejected ${kind} occupies the global window and displaces older fallback) --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (REQ-MEM-027 AC5: rejected %s occupies the global window and displaces older fallback) --> <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall.ts::buildRecall --> <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh::RAW --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (REQ-MEM-027 AC5: ignores symlinked capture identities and preserves the global fallback) --> <!-- @test: host/__tests__/post-compaction-recall.test.js (REQ-MEM-027 AC5: skips symlinked and non-regular capture files without losing the global fallback) -->
6. The six-second identity-search budget is checked after the initial global filename window, not between every candidate. Later expiry stops lookup without discarding collected recall. <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall.ts::buildRecall --> <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh::RAW --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (REQ-MEM-027 AC6: retains the collected global fallback when the identity-search time budget expires) -->
7. Full-body reads are limited to matching-session or global-fallback candidates. <!-- @test: host/__tests__/post-compaction-recall.test.js (REQ-MEM-027 AC4/AC7: reads at most 2048 metadata bytes per note and no noncandidate bodies) --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (REQ-MEM-027 AC4/AC7: reads at most 2048 metadata bytes per note and no noncandidate bodies) --> <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall.ts::buildRecall --> <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh::RAW --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (REQ-MEM-027: finds older usable matches beyond the global window after skipping empty matching candidates) --> <!-- @test: host/__tests__/post-compaction-recall.test.js (REQ-MEM-027: finds older usable matches beyond the global window after skipping empty matching candidates) -->

**Constraints:**

- No index, service, dependency, file-count cutoff, or new setting is introduced for identity lookup.
- Claude retains its existing eight-second outer envelope.
- Identity lookup does not promise exhaustive search beyond its deadline.

**Priority:** P1

**Dependencies:** [REQ-MEM-019](#req-mem-019-post-compaction-recall-of-recent-session-extracts)

**Verification:** Automated: [post-compaction-recall.test.js](../../host/__tests__/post-compaction-recall.test.js), [pi-post-compaction-recall.test.ts](../../src/__tests__/lib/pi-post-compaction-recall.test.ts)

**Status:** Implemented

---

### REQ-MEM-014: Pi capture contract, transcript prefilter, and model-fidelity lever

**Intent:** Pi capture and extraction deliver the full prompts, cite REQ/ADR/SHA/PR identifiers verbatim, and use a provider-neutral fidelity control without Claude's multi-pass scratchpad cost.

**Applies To:** User

**Acceptance Criteria:**

1. Pi ships complete capture and Vault extraction prompt files. <!-- @impl: preseed/agents/pi/prompts/memory-agent-prompt.md::pi-memory-capture-contract --> <!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md::pi-vault-extraction-contract --> <!-- @manual -->
2. Pi capture/extraction loads the deployed prompt files rather than inlining their contracts. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::defaultDependencies --> <!-- @manual -->
3. Both capture/extraction prompt files are delivered advanced-only through the manifest-driven seed projection into Pi's user prompt directory. <!-- @impl: scripts/agent-seed-core.mjs::piNativeKey --> <!-- @impl: preseed/agents/pi/manifest.json::prompts/memory-agent-prompt.md --> <!-- @manual -->
4. Each Pi capture/extract request includes the optional configured model only when non-empty; when unset, no model name is hardcoded. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::buildPublicExtractionRequest --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (builds one bounded medium-reasoning public background request) -->
5. Each Pi memory launch makes its immutable execution snapshot readable before exposing the public request. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::memoryExecutionVarsPath --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::sendDueExtractionMessages --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (creates work on the twentieth real prompt and emits a visible reminder without private spawn) -->

**Notes:** Public delivery is documented in [AD102](../../documentation/decisions/README.md#ad102-pi-extraction-delivery-is-root-owned-visible-and-transactional). The bounded execution profile and its requirement ownership are documented in [AD103](../../documentation/decisions/README.md#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs).

**Constraints:**

- Pi uses the optional environment model selection without hardcoding a model; Claude retains [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault)'s model definition ([AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)).
- [REQ-MEM-037](#req-mem-037-bounded-pi-capture-input) owns prefiltered capture input.
- Pi delivery state is root-owned and transcript-derived, while Claude retains its hook carrier-file protocol.
- Memory execution snapshots use the shared home-backed cache.
- Active legacy temp snapshots migrate to the shared cache before retry; legacy requests without a prompt fingerprint remain supported.

**Priority:** P1

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-008](#req-mem-008-memory-prompt-files-preseeded-via-manifest-pipeline)

**Verification:** Automated: [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts); Manual: [Memory manifest and prompt delivery acceptance](../../documentation/lanes/preseed.md#memory-manifest-and-prompt-delivery-acceptance)

**Status:** Implemented

---

### REQ-MEM-037: Bounded Pi capture input

**Intent:** Pi preserves the prefiltered conversational arc and bounded citation rescue established by [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad).

**Applies To:** User

**Acceptance Criteria:**

1. Capture input contains only uncaptured user/assistant text. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::compactMessages --> <!-- @test: src/__tests__/lib/agent-seed-pi-memory.test.ts (REQ-MEM-001: compactMessages prefilter (AD58)) -->
2. Capture input uses a fixed rendered UTF-8-byte aggregate budget, spent newest-first on user prompts before assistant turns. Each turn has a separate code-unit slice and bounded citation rescue. <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-037 AC2: rescues bounded citations beyond the newest user slice within the rendered byte budget) --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::selectTurns --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::capTurn --> <!-- @test: src/__tests__/lib/agent-seed-pi-memory.test.ts (REQ-MEM-001: compactMessages prefilter (AD58)) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (charges role headings, separators, and multibyte text to one byte budget) -->

**Constraints:**

- The prefilter removes tool-use, tool-result, thinking, and synthetic directive content before capture.
- The successful prompt counter defines the start of the uncaptured interval.

**Priority:** P1

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault)

**Verification:** Automated: [agent-seed-pi-memory.test.ts](../../src/__tests__/lib/agent-seed-pi-memory.test.ts), [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts)

**Status:** Implemented

---

<a id="req-mem-016-vault-extraction-runs-on-bounded-one-pass-inputs"></a>
### REQ-MEM-016: Pi extraction requests have a bounded execution profile

**Intent:** Pi memory and Vault extraction requests must finish as bounded background jobs without inheriting an open-ended foreground execution profile.

**Applies To:** Agent

**Acceptance Criteria:**

1. Every emitted Pi capture/extract request disables inherited context. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::buildPublicExtractionRequest --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-016: builds one bounded medium-reasoning public background request) -->
2. Every emitted Pi capture/extract request uses provider-neutral medium reasoning. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::buildPublicExtractionRequest --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-016: builds one bounded medium-reasoning public background request) -->
3. New Pi memory-capture requests stop after ten agent turns and reserve the final turn for native completion. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::buildPublicExtractionRequest --> <!-- @impl: preseed/agents/pi/prompts/memory-agent-prompt.md::Execution budget --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-016: builds one bounded medium-reasoning public background request) -->
4. Vault extraction retains seven turns. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::buildPublicExtractionRequest --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-016: builds one bounded medium-reasoning public background request) -->
5. Existing seven-turn memory calls remain correlatable so their qualified completion is not lost after upgrade. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::buildPublicExtractionRequest --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-016 / REQ-MEM-021: an in-flight legacy seven-turn terminal success still commits after upgrade) -->

**Constraints:**

- Memory capture treats the immutable snapshot's `transcript` field as its sole conversation input and does not discover an `INPUT_FILE` or separate transcript path.
- Vault extraction reads only its request snapshot and frozen input files.
- Model identity remains independently configurable through `CODEFLARE_MEMORY_MODEL`.

**Priority:** P1

**Dependencies:** [REQ-MEM-014](#req-mem-014-pi-capture-contract-transcript-prefilter-and-model-fidelity-lever)

**Verification:** Automated: [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts)

**Status:** Implemented

---

<a id="req-mem-018-background-extraction-agents-are-bounded-and-visible"></a>
### REQ-MEM-018: Pi extraction agent definitions have a bounded profile

**Intent:** Generated Pi memory and Vault extraction agent definitions expose only the tools and reasoning profile required by their bounded background work.

**Applies To:** Agent

**Acceptance Criteria:**

1. Generated Pi memory-capture and vault-extract agent definitions expose only Bash. <!-- @impl: scripts/agent-seed-core.mjs::adaptAgentFrontmatter --> <!-- @test: src/__tests__/lib/agent-seed-pi-memory.test.ts (REQ-MEM-018: Pi extraction agents expose bounded frontmatter (native + transformed)) -->
2. Generated Pi memory-capture and vault-extract agent definitions use provider-neutral medium reasoning. <!-- @impl: scripts/agent-seed-core.mjs::adaptAgentFrontmatter --> <!-- @test: src/__tests__/lib/agent-seed-pi-memory.test.ts (REQ-MEM-018: Pi extraction agents expose bounded frontmatter (native + transformed)) -->

**Constraints:**

- Memory capture treats the immutable snapshot's `transcript` field as its sole conversation input and does not discover an `INPUT_FILE` or separate transcript path.
- Vault extraction reads only its request snapshot and frozen input files.
- Model identity remains independently configurable through `CODEFLARE_MEMORY_MODEL`.

**Priority:** P1

**Dependencies:** [REQ-MEM-016](#req-mem-016-pi-extraction-requests-have-a-bounded-execution-profile)

**Verification:** Automated: [agent-seed-pi-memory.test.ts](../../src/__tests__/lib/agent-seed-pi-memory.test.ts)

**Status:** Implemented

---

### REQ-MEM-017: Session memory graph identity is deterministic

**Intent:** Repeated Pi session capture must produce stable graph identities and evidence for the same note content.

**Applies To:** System

**Acceptance Criteria:**

1. A session document node uses the note H1 as its label. <!-- @impl: preseed/agents/pi/scripts/build-memory-graph.py::build_graph --> <!-- @test: host/__tests__/pi-memory-graph-builder.test.js (REQ-MEM-017: session graph uses its title, canonical concepts, and unique edges) -->
2. A session document node uses a stable identifier derived from its Vault-relative path. <!-- @impl: preseed/agents/pi/scripts/build-memory-graph.py::build_graph --> <!-- @test: host/__tests__/pi-memory-graph-builder.test.js (REQ-MEM-017: session graph uses its title, canonical concepts, and unique edges) -->
3. Repeated references to the same concept label produce one canonical concept identifier. <!-- @impl: preseed/agents/pi/scripts/build-memory-graph.py::build_graph --> <!-- @test: host/__tests__/pi-memory-graph-builder.test.js (REQ-MEM-017: session graph uses its title, canonical concepts, and unique edges) -->
4. Exact duplicate source/target/relation/source-file edges collapse to one edge. <!-- @impl: preseed/agents/pi/scripts/build-memory-graph.py::build_graph --> <!-- @test: host/__tests__/pi-memory-graph-builder.test.js (REQ-MEM-017: session graph uses its title, canonical concepts, and unique edges) -->

**Constraints:**

- The generated advanced Pi seed carries the same graph-builder source as the canonical preseed.
- Graph output remains compatible with the cumulative Vault merge path.

**Priority:** P1

**Dependencies:** [REQ-MEM-009](#req-mem-009-vault-graph-accumulates-monotonically-across-extractions)

**Verification:** Automated: [pi-memory-graph-builder.test.js](../../host/__tests__/pi-memory-graph-builder.test.js)

**Status:** Implemented

---

### REQ-MEM-023: Cold session captures compact without losing memory

**Intent:** Session captures remain useful without leaving every historical batch as a separate hot file. A deterministic daily compactor keeps an approximate latest-month working set, moves older source text into one durable archive, and preserves graph evidence and retrieval order.

**Applies To:** User

**Acceptance Criteria:**

1. For each daily UTC compaction run, capture recency is derived from the leading calendar date in each session filename; files dated before the same UTC calendar date in the prior month are cold, while newer or unrecognized names remain hot. <!-- @impl: scripts/compact-session-captures.mjs::selectColdCaptures --> <!-- @test: host/__tests__/session-capture-compaction.test.js (REQ-MEM-023 AC1: accepts only actual capture timestamp shapes and compares their calendar days) -->
2. Cumulative provenance moves to the archive without changing graph identities or evidence, and separate captures remain distinct. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/merge-vault-graph.py::relocate_node_link_provenance --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::relocate_node_link_provenance --> <!-- @test: host/__tests__/vault-extract-merge.test.js (REQ-MEM-009: archived edge evidence survives relocation, repetition, and later merges) -->
3. The complete cumulative Vault contribution is relocated and republished before source deletion and bisync. <!-- @impl: entrypoint.sh::run_daily_vault_session_compaction --> <!-- @test: host/__tests__/entrypoint-session-capture-compaction.test.js (archives, relocates, deletes, and bisyncs once per UTC day) -->
4. Agent retrieval checks individual hot captures before archived history. Archive edits and capture deletion by agents are forbidden under [REQ-VAULT-032](vault.md#req-vault-032-session-archive-ownership-and-extraction-boundary) AC5. <!-- @impl: preseed/agents/claude/skills/vault-operations/SKILL.md::Reading --> <!-- @impl: preseed/agents/pi/skills/vault-operations/SKILL.md::Reading --> <!-- @manual -->
5. Daily compaction runs in every session mode without an enable flag. <!-- @impl: entrypoint.sh::run_daily_vault_session_compaction --> <!-- @test: host/__tests__/entrypoint-session-capture-compaction.test.js (runs in the default session mode without a feature flag) -->

**Constraints:**

- `Archive.md` is deterministic image-owned output, not a user-curated note or an agent-authored capture.
- Compaction changes storage shape and provenance only.
- Semantic pruning, summarization, node deletion, edge deletion, and relevance-based retention remain out of scope.
- A filename without a recognized leading calendar date is never deleted automatically.

**Priority:** P1

**Dependencies:** [REQ-MEM-009](#req-mem-009-vault-graph-accumulates-monotonically-across-extractions)

**Verification:** Automated: [session-capture-compaction.test.js](../../host/__tests__/session-capture-compaction.test.js), [vault-extract-merge.test.js](../../host/__tests__/vault-extract-merge.test.js), [entrypoint-session-capture-compaction.test.js](../../host/__tests__/entrypoint-session-capture-compaction.test.js); Manual: [Archive ownership instruction review](../../documentation/lanes/vault.md#req-vault-032-manual-qualification)

**Status:** Implemented

---

### REQ-MEM-024: Session archive serialization is deterministic and lossless

**Intent:** Compacted session text retains a stable archive representation that can recover each original source.

**Applies To:** User

**Acceptance Criteria:**

1. Cold captures appear in date-and-name order. <!-- @impl: scripts/compact-session-captures.mjs::buildSessionArchive --> <!-- @test: host/__tests__/session-capture-compaction.test.js (REQ-MEM-024 AC1-AC4: builds a deterministic idempotent archive with recoverable source boundaries) -->
2. Archive boundaries recover each original filename and byte sequence. <!-- @impl: scripts/compact-session-captures.mjs::parseSessionArchive --> <!-- @test: host/__tests__/session-capture-compaction.test.js (REQ-MEM-024 AC1-AC4: builds a deterministic idempotent archive with recoverable source boundaries) -->
3. Identical capture input produces byte-identical archive output. <!-- @impl: scripts/compact-session-captures.mjs::buildSessionArchive --> <!-- @test: host/__tests__/session-capture-compaction.test.js (REQ-MEM-024 AC1-AC4: builds a deterministic idempotent archive with recoverable source boundaries) -->
4. Repeating compaction produces no duplicate source records. <!-- @impl: scripts/compact-session-captures.mjs::prepareArchive --> <!-- @test: host/__tests__/session-capture-compaction.test.js (REQ-MEM-024 AC1-AC4: builds a deterministic idempotent archive with recoverable source boundaries) -->

**Constraints:** Archive serialization preserves source bytes without semantic rewriting.

**Priority:** P1

**Dependencies:** [REQ-MEM-023](#req-mem-023-cold-session-captures-compact-without-losing-memory)

**Verification:** Automated: [session-capture-compaction.test.js](../../host/__tests__/session-capture-compaction.test.js)

**Status:** Implemented

---

### REQ-MEM-028: Pi active transcript size retention

**Intent:** Bound the on-disk active transcript using a simple streamed oldest-prefix cut, without parsing transcript content or modifying the loaded SDK cache.

**Applies To:** User

**Acceptance Criteria:**

1. Maintenance above 50,000,000 bytes runs on the shared memory/Vault cadence or a loaded-parent manual request, with no independent automatic trigger. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::CAP = 50_000_000 --> <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerActiveSessionTranscriptTrimming --> <!-- @test: host/__tests__/pi-transcript-start.test.js (REQ-MEM-030 AC1: shared cadence skips small transcripts while memory delivery remains available) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-002 AC4: baselines the first prompt and arms all three jobs only after twenty new prompts) -->
2. Only the loaded owner session/file is eligible; bounded persisted-header validation rejects foreign IDs, child sessions and unsupported versions. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerActiveSessionTranscriptTrimming --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-028 AC2: switching the loaded owner revokes activation without touching its file) --> <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::validateSessionHeader --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-028 AC2: automatic admission refuses ${name} without changing its file) -->
3. Calculate one byte cutoff targeting 20,000,000 bytes, align forward to a newline, and accept only results within 15,000,000–25,000,000 inclusive. <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::TARGET = 20_000_000 --> <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::MINIMUM = 15_000_000 --> <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::MAXIMUM = 25_000_000 --> <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::rawCut --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-028 AC3/4: one byte cutoff for ${size} MiB copies the exact header and suffix into the size window) -->
4. Preserve the first session-header line and copy the retained suffix byte-for-byte, cutting through the next newline without history-record parsing or semantic refinement. Discarded prefix messages/state/ancestry are intentionally lost. <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::workerJob --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-028 AC3/4: one byte cutoff for ${size} MiB copies the exact header and suffix into the size window) -->
5. Maintenance leaves the loaded SDK cache unchanged. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerActiveSessionTranscriptTrimming --> <!-- @test: host/__tests__/pi-transcript-trimming.test.js (REQ-MEM-028 AC5: streamed cut preserves loaded SDK state, same-path append and disk reopen) -->
6. A later SDK rewrite can regrow the file; only a later legitimate cadence maintains it again. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerActiveSessionTranscriptTrimming --> <!-- @test: host/__tests__/pi-transcript-trimming.test.js (REQ-MEM-028 AC6: a later rewrite waits for the next public due mark) -->
7. Postcommit appends are reported separately from the verified retained-prefix byte count. <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::workerJob --> <!-- @test: host/__tests__/pi-trim-worker-lifecycle.test.js (REQ-MEM-030 AC7: postcommit ordinary growth is verified separately from the accepted committed prefix, without replacement replay) -->

**Constraints:**

- No per-installation policy, semantic categories, padding, transcript backup, SDK mutation or loaded-memory reclamation claim.
- Other sessions, credentials and configuration remain unchanged.

**Priority:** P1

**Dependencies:** [REQ-MEM-002](#req-mem-002-capture-triggers-every-20-user-messages-and-on-resume), [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-MEM-029](#req-mem-029-active-transcript-replacement-safety)

**Verification:** Automated: [pi-transcript-start.test.js](../../host/__tests__/pi-transcript-start.test.js), [pi-trim-byte-cut.test.js](../../host/__tests__/pi-trim-byte-cut.test.js), [pi-transcript-trimming.test.js](../../host/__tests__/pi-transcript-trimming.test.js), [pi-trim-worker-lifecycle.test.js](../../host/__tests__/pi-trim-worker-lifecycle.test.js), [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts)

**Status:** Implemented

---

### REQ-MEM-029: Active transcript replacement safety

**Intent:** Prefix retention preserves admitted appends, never exposes a partial replacement and distinguishes committed work from failed preparation.

**Applies To:** User

**Acceptance Criteria:**

1. A changed authorized prefix, unsafe path, foreign ownership or revoked owner refuses without overwriting the current file. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerActiveSessionTranscriptTrimming --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-029 AC1: a changed authorized prefix is not overwritten) --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-029 AC1: activation rejects a rewritten branch without replacing source bytes) -->
2. Only the live owner atomically replaces the same pathname after worker preparation. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerActiveSessionTranscriptTrimming --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-030 AC4/7: activation includes appended tail and recalculates one cutoff before committing) -->
3. Committed readback verifies the retained prefix. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerActiveSessionTranscriptTrimming --> <!-- @test: host/__tests__/pi-trim-worker-lifecycle.test.js (REQ-MEM-030 AC7: postcommit ordinary growth is verified separately from the accepted committed prefix, without replacement replay) -->
4. A whole-line cut below 15,000,000 bytes or no feasible result at most 25,000,000 bytes refuses without replacement or padding. <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::rawCut --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-029 AC1/4: a line-aligned cut below fifteen MB refuses without replacing the source) --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-029 AC4: an append tail above the ceiling refuses without replacing the source) -->
5. Maintenance creates no transcript backup/archive. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::cleanupRequest --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-028 AC3/4: one byte cutoff for ${size} MiB copies the exact header and suffix into the size window) -->
6. Completion or cancellation removes only owned staging. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::cleanupRequest --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-028 AC3/4: one byte cutoff for ${size} MiB copies the exact header and suffix into the size window) -->
7. Verification-pending recovery is read-only and never replays replacement. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerActiveSessionTranscriptTrimming --> <!-- @test: host/__tests__/pi-trim-adaptive.test.js (REQ-MEM-030 AC7: unavailable asynchronous readback keeps a committed receipt and recovers without a second replacement) -->

**Constraints:**

- The owner alone renames live history.
- Directory-sync failure is not a rollback.
- Worker copying and postcommit readback are asynchronous; owner admission and retry synchronously hash the admitted prefix. No hidden model invocation or unrelated cleanup is introduced.

**Priority:** P1

**Dependencies:** [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode)

**Verification:** Automated: [pi-trim-byte-cut.test.js](../../host/__tests__/pi-trim-byte-cut.test.js), [pi-trim-worker-lifecycle.test.js](../../host/__tests__/pi-trim-worker-lifecycle.test.js), [pi-trim-adaptive.test.js](../../host/__tests__/pi-trim-adaptive.test.js)

**Status:** Implemented

---

### REQ-MEM-030: Visible agent-owned transcript maintenance

**Intent:** Use one correctly scoped background trim operation with a deterministic byte cutoff, not model-driven transcript parsing/refinement.

**Applies To:** User

**Acceptance Criteria:**

1. The parent requests maintenance with `request` only and forwards the controller-issued public background request unchanged; scoped operations require its owner-bound worker. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerTranscriptTrimTool --> <!-- @test: host/__tests__/pi-trim-request-budget.test.js (REQ-MEM-030 AC1: parent request uses shared launch before cadence and scoped trim immediately admits roughly twenty MB) -->
2. The scoped `trim` operation prepares, activates and verifies before return without native Done or parent handover. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerTranscriptTrimTool --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-028 AC3/4: one byte cutoff for ${size} MiB copies the exact header and suffix into the size window) --> <!-- @test: host/__tests__/pi-trim-worker-cancel.test.js (REQ-MEM-030 AC2: owner cancellation settles the CPU child before returning cancellation) -->
3. The worker streams raw bytes in bounded chunks without parsing or classifying transcript records or asking a model to select reductions. <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::copyRange --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-028 AC3/4: one byte cutoff for ${size} MiB copies the exact header and suffix into the size window) -->
4. Activation recalculates the cutoff using the latest admitted tail and preserves those append bytes exactly. <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::workerJob --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-030 AC4/7: activation includes appended tail and recalculates one cutoff before committing) --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-030 AC4: activation preserves a notification appended after its branch snapshot) -->
5. Changed source or later native compaction invalidates stale uncommitted authority while preserving the existing cumulative delivery budget. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerActiveSessionTranscriptTrimming --> <!-- @test: host/__tests__/pi-trim-adaptive.test.js (REQ-MEM-030 AC5/6: fresh native compaction coverage revokes settled scope without duplicating running work or resetting six total attempts) -->
6. Uncommitted failures use the existing shared six-total-attempt budget. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerActiveSessionTranscriptTrimming --> <!-- @test: host/__tests__/pi-trim-window-retry.test.js (REQ-MEM-030 AC6: native failure advances the same reminder and native stop cancels rather than retries) -->
7. Only verified persisted `trimmed` output establishes success. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerActiveSessionTranscriptTrimming --> <!-- @test: host/__tests__/pi-trim-worker-lifecycle.test.js (REQ-MEM-030 AC7: postcommit ordinary growth is verified separately from the accepted committed prefix, without replacement replay) -->

**Constraints:**

- CPU work remains asynchronous and cancelable; explicit stop cancels maintenance. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerActiveSessionTranscriptTrimming --> <!-- @test: host/__tests__/pi-trim-worker-cancel.test.js (REQ-MEM-030 AC2: owner cancellation settles the CPU child before returning cancellation) -->
- No independent live writer, new orchestration framework, invented ancestry, Goal/SDK mutation or new model configuration.
- Old prefix content is intentionally discarded; retained bytes are not semantically rewritten.

**Priority:** P1

**Dependencies:** [REQ-MEM-028](#req-mem-028-pi-active-transcript-size-retention), [REQ-MEM-029](#req-mem-029-active-transcript-replacement-safety)

**Verification:** Automated: [pi-trim-request-budget.test.js](../../host/__tests__/pi-trim-request-budget.test.js), [pi-trim-byte-cut.test.js](../../host/__tests__/pi-trim-byte-cut.test.js), [pi-trim-worker-cancel.test.js](../../host/__tests__/pi-trim-worker-cancel.test.js), [pi-trim-adaptive.test.js](../../host/__tests__/pi-trim-adaptive.test.js), [pi-trim-window-retry.test.js](../../host/__tests__/pi-trim-window-retry.test.js), [pi-trim-worker-lifecycle.test.js](../../host/__tests__/pi-trim-worker-lifecycle.test.js)

**Status:** Implemented

---

### REQ-MEM-031: Advanced transcript runtime delivery

**Intent:** The advanced maintenance extension receives its matching runtime dependency without crossing managed ownership.

**Applies To:** User

**Acceptance Criteria:**

1. Baked advanced delivery makes the trim engine available before it installs or updates the importing extension. <!-- @impl: entrypoint.sh::relay_managed_pi_extensions --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-031 / REQ-MEM-030: advanced trim dependency delivery) -->
2. Default mode does not newly receive the advanced extension or helper. <!-- @impl: entrypoint.sh::relay_managed_pi_extensions --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-031 / REQ-MEM-030: advanced trim dependency delivery) -->
3. Remote curation preserves release-owned extension and helper bytes without substituting the image helper. <!-- @impl: entrypoint.sh::relay_managed_pi_extensions --> <!-- @test: host/__tests__/entrypoint-managed-curation.test.js (REQ-STOR-031 / REQ-MEM-030: advanced trim dependency delivery) -->

**Constraints:** Entrypoint delivers resources; it never executes transcript maintenance.

**Priority:** P1

**Dependencies:** [REQ-AGENT-210](agents.md#req-agent-210-managed-extension-startup-preparation)

**Verification:** Automated: [entrypoint-managed-curation.test.js](../../host/__tests__/entrypoint-managed-curation.test.js)

**Status:** Implemented

---

### REQ-MEM-032: Bounded transcript-worker memory

**Intent:** Enforce a fixed worker budget without changing the owner process memory limit.

**Applies To:** User

**Acceptance Criteria:**

1. Each trim worker runs within a kernel-enforced 1,073,741,824-byte memory limit with swap disabled; the Pi owner and terminal host remain outside that group. <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::WORKER_MEMORY_BYTES = 1_073_741_824 --> <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::runTrimWorker --> <!-- @test: host/__tests__/pi-trim-worker-memory.test.js (REQ-MEM-032 AC1/2: kernel bounds worker memory to one GiB before work, without limiting its parent) -->
2. Node executes only after placement inside the verified group; unavailable enforcement or direct unbounded worker startup refuses before transcript work. <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::verifyMemoryGroup --> <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::runTrimWorker --> <!-- @test: host/__tests__/pi-trim-worker-memory.test.js (REQ-MEM-032 AC2: direct unbounded worker startup refuses before transcript work) -->
3. OOM-killed workers report `worker-oom-killed`, without asserting whether their local limit, ancestor limits or global pressure caused the kill. <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::runTrimWorker --> <!-- @test: host/__tests__/pi-trim-worker-memory.test.js (REQ-MEM-032 AC3: kernel memory exhaustion kills only bounded workers and leaves the owner usable) -->
4. Pending or running maintenance work is never duplicated. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerActiveSessionTranscriptTrimming --> <!-- @test: host/__tests__/pi-trim-window-retry.test.js (REQ-MEM-030 AC6: native failure advances the same reminder and native stop cancels rather than retries) --> <!-- @test: host/__tests__/pi-trim-adaptive.test.js (REQ-MEM-030 AC7: unavailable asynchronous readback keeps a committed receipt and recovers without a second replacement) -->

**Constraints:**

- No heap-only substitute, unbounded fallback or change to the Pi owner's memory limit.
- Owner allocations and ancestor/global OOM survival are outside this guarantee.

**Priority:** P0

**Dependencies:** [REQ-MEM-029](#req-mem-029-active-transcript-replacement-safety)

**Verification:** Automated: [pi-trim-worker-memory.test.js](../../host/__tests__/pi-trim-worker-memory.test.js), [pi-trim-window-retry.test.js](../../host/__tests__/pi-trim-window-retry.test.js), [pi-trim-adaptive.test.js](../../host/__tests__/pi-trim-adaptive.test.js)

**Status:** Implemented

---

### REQ-MEM-033: Preserved session display name

**Intent:** Transcript retention does not make a named session disappear from Pi's resume selector.

**Applies To:** User

**Acceptance Criteria:**

1. A named session keeps its current display name after trimming and disk reopen. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerActiveSessionTranscriptTrimming --> <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::workerJob --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-033: trim preserves latest display name ${latestName??'cleared'}) --> <!-- @test: host/__tests__/pi-transcript-trimming.test.js (REQ-MEM-028 AC5: streamed cut preserves loaded SDK state, same-path append and disk reopen) -->
2. A rename or explicit name clear before activation is not replaced by an older name. <!-- @impl: preseed/agents/pi/extensions/active-session-transcript-trimming.ts::registerActiveSessionTranscriptTrimming --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-033: trim preserves latest display name ${latestName??'cleared'}) -->
3. Preserved naming metadata is included in the retained-output budget. <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::rawCut --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-033: trim preserves latest display name ${latestName??'cleared'}) -->
4. Committed-prefix verification includes the preserved naming metadata. <!-- @impl: preseed/agents/pi/extensions/transcript-trim/engine.mjs::workerJob --> <!-- @test: host/__tests__/pi-trim-byte-cut.test.js (REQ-MEM-033: trim preserves latest display name ${latestName??'cleared'}) -->

**Constraints:**
- Read only current naming metadata from the owner's public SDK state.
- Do not parse history records, rewrite cached history or invent a title.
- Stage naming metadata after the header atomically; leave the retained suffix and final entry unchanged.

**Priority:** P1

**Dependencies:** [REQ-MEM-028](#req-mem-028-pi-active-transcript-size-retention), [REQ-MEM-029](#req-mem-029-active-transcript-replacement-safety)

**Verification:** Automated: [pi-trim-byte-cut.test.js](../../host/__tests__/pi-trim-byte-cut.test.js), [pi-transcript-trimming.test.js](../../host/__tests__/pi-transcript-trimming.test.js)

**Status:** Implemented

---

### REQ-MEM-035: Durable Pi facts with disposable local search

**Intent:** Advanced Pi learns durable user and workspace facts through the unmodified upstream memory package, while SQLite remains local and reconstructible.

**Applies To:** User

**Acceptance Criteria:**

1. With verified memory preparation and a compatible adapter, Advanced Pi loads the pinned upstream memory package through the normal managed dependency path, with policy-only prompting, configured-provider extraction, bounded review windows and no vendor source patch. <!-- @impl: entrypoint.sh::configure_pi_packages_and_review_inventory --> <!-- @impl: preseed/agents/pi/extensions/hermes-memory-runtime.ts::hermesMemoryRuntime --> <!-- @test: host/__tests__/pi-settings-packages.test.js (REQ-MEM-035 AC1: stock Hermes package delivery) --> <!-- @test: host/__tests__/pi-hermes-native.test.js (REQ-MEM-035: AC1/AC5 real foreground review and correction persist facts without primary memory writes; helper stays read-isolated) -->
2. Hermes databases, sidecars, recovery files and locks stay local and never transfer through R2 under either sync policy. Durable Markdown follows [REQ-MEM-041](#req-mem-041-session-isolated-hermes-markdown). <!-- @impl: entrypoint.sh::transfer_pi_hermes_memory --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (round-trips cleared Markdown without transferring Hermes transient files (${syncPolicyMode})) -->
3. Between restore and foreground loading, idempotent storage and configuration preparation preserves Markdown and valid preferences. Malformed configuration or filesystem ownership conflicts are reported without overwriting data or using synchronized database storage. <!-- @impl: entrypoint.sh::configure_pi_hermes_memory --> <!-- @impl: entrypoint.sh::complete_managed_curation_startup --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (Pi Hermes startup (actual entrypoint helper)) -->
4. First use, not Advanced Pi startup, initializes search from working Markdown. Initialization needs no model request or repository sweep, reuses warm search state, and skips historical backfill. <!-- @impl: entrypoint.sh::configure_pi_hermes_memory --> <!-- @impl: preseed/agents/pi/extensions/hermes-memory-runtime.ts::hermesMemoryRuntime --> <!-- @impl: preseed/agents/pi/extensions/hermes-memory-runtime.ts::workspaceMemoryApi --> <!-- @test: host/__tests__/pi-hermes-native.test.js (REQ-MEM-035 AC4: cold startup defers indexing until first search and warm search reuses SQLite without a model request) -->
5. Foreground sessions retain automatic review, corrections and permitted memory tools. Ordinary in-process helper sessions do not run those personal-memory writers; the upstream internal extraction subprocess remains supported. <!-- @impl: preseed/agents/pi/extensions/hermes-memory-runtime.ts::attachHermesMemoryToForeground --> <!-- @test: host/__tests__/pi-hermes-memory.test.js (REQ-MEM-035: AC5 foreground ownership gates stock writers/tools and drains shutdown before release) --> <!-- @test: host/__tests__/pi-hermes-native.test.js (REQ-MEM-035: AC1/AC5 real foreground review and correction persist facts without primary memory writes; helper stays read-isolated) -->
6. Authorized final sync gives foreground Pi its bounded graceful shutdown before transfer. It reports failed or timed-out drains, not successful capture. <!-- @impl: host/src/pi-memory-shutdown.ts::shutdownPiMemoryOwners --> <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @test: host/__tests__/pi-memory-shutdown.test.js (REQ-MEM-035 AC6: bounded foreground owner shutdown) --> <!-- @test: host/__tests__/final-sync-endpoint.test.js (REQ-MEM-035 AC6: foreground shutdown before authoritative final sync) -->
7. Advanced startup retires only the exact obsolete managed-adapter exclusion; default-mode behavior, other exclusions and unrelated packages and settings remain unchanged. <!-- @impl: entrypoint.sh::configure_pi_packages_and_review_inventory --> <!-- @test: host/__tests__/pi-settings-packages.test.js (REQ-MEM-035: Advanced startup removes the obsolete managed Hermes exclusion without changing user settings) --> <!-- @test: host/__tests__/pi-settings-packages.test.js (REQ-MEM-035: default startup preserves the managed Hermes exclusion and user settings) --> <!-- @test: host/__tests__/pi-settings-packages.test.js (REQ-MEM-035: Advanced startup removes only the exact managed absolute negative Hermes selector) -->

**Constraints:**
- One stable workspace scope, not one index per clone.
- Missing or incompatible upstream code neither claims successful activation nor triggers runtime dependency installation.
- Deferred admission leaves Hermes unavailable without preventing ordinary Advanced startup (see [REQ-MEM-042 AC3](#req-mem-042-retain-ten-recent-session-memory-stores)).
- Preserve existing task, historical capture and graph ownership.
- No SQLite backups, new memory service, local embedding model, vendor patch or user-data deletion on bootstrap conflict.
- Previously uploaded cache cleanup requires its own exact-key authorization.
- Capture is asynchronous and R2 sync is periodic; uncaptured or unsynchronized changes are not guaranteed after abrupt termination.
- Existing manual-sync behavior remains unchanged; it does not stop Pi.

**Priority:** P1

**Dependencies:** [REQ-MEM-004](#req-mem-004-vault-contents-synced-to-r2-across-sessions), [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-MEM-015](#req-mem-015-pi-extraction-transcript-visibility-and-child-session-guard), [REQ-STOR-005](storage.md#req-stor-005-graceful-shutdown-performs-final-sync)

**Verification:** Automated: [pi-settings-packages.test.js](../../host/__tests__/pi-settings-packages.test.js), [pi-hermes-startup.test.js](../../host/__tests__/pi-hermes-startup.test.js), [pi-hermes-native.test.js](../../host/__tests__/pi-hermes-native.test.js), [pi-hermes-memory.test.js](../../host/__tests__/pi-hermes-memory.test.js), [pi-memory-shutdown.test.js](../../host/__tests__/pi-memory-shutdown.test.js), [final-sync-endpoint.test.js](../../host/__tests__/final-sync-endpoint.test.js), [agent-seed-core.test.js](../../host/__tests__/agent-seed-core.test.js)

**Status:** Implemented

---

<a id="req-mem-041-session-isolated-hermes-checkpoints"></a>
### REQ-MEM-041: Session-isolated Hermes Markdown

**Intent:** Persist Advanced Pi memory without overwriting the shared masters or borrowing another session’s memory.

**Applies To:** User

**Acceptance Criteria:**

1. After a successful restore confirms an uninitialized store, any shared Vault masters seed only the owning session’s native Markdown. Each absent master seeds an empty file, including for a new user with no masters. <!-- @impl: entrypoint.sh::configure_pi_hermes_memory --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-041 AC1: a new user without Vault masters gets an empty usable session store) --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-041: uses real per-session Markdown and does not import or rewrite legacy checkpoints) -->
2. Sync transfers the session’s Markdown unchanged, including a file cleared to empty. A verified default-encrypted empty object remains restorable in an SSE-C bucket. <!-- @impl: entrypoint.sh::transfer_pi_hermes_memory --> <!-- @impl: scripts/patch-rclone-bisync.py::patch --> <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: scripts/ci/rclone-hermes-empty_test.go (TestCodeflareHermesEmptyRead) --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (round-trips cleared Markdown without transferring Hermes transient files (${syncPolicyMode})) -->
3. Failed or incomplete restore never creates replacement memory. An initialized store missing expected files is not treated as new. <!-- @impl: entrypoint.sh::prepare_pi_hermes_persistence --> <!-- @impl: entrypoint.sh::run_initial_r2_restore --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-041 AC3: refuses to reseed a partially restored initialized store) --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-041 AC3: a timed-out restore releases the terminal without seeding Hermes) -->
4. The new layout does not import, create, or rewrite legacy checkpoints. Checkpoint-only additions do not carry forward. <!-- @impl: entrypoint.sh::configure_pi_hermes_memory --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-041: uses real per-session Markdown and does not import or rewrite legacy checkpoints) -->
5. Stock Hermes reads and writes only the owning session’s direct-layout Markdown. <!-- @impl: preseed/agents/pi/extensions/hermes-memory-runtime.ts::preparedLayout --> <!-- @test: host/__tests__/pi-hermes-native.test.js (REQ-MEM-035: AC1/AC5 real foreground review and correction persist facts without primary memory writes; helper stays read-isolated) -->
6. A replacement container reopens a complete saved store directly once its previous writer is confirmed exited, even if that writer’s final sync failed. The only reseed of an existing store requires the exact merged-snapshot receipt in [REQ-MEM-044](#req-mem-044-consolidate-hermes-on-graceful-shutdown) AC5. <!-- @impl: entrypoint.sh::prepare_pi_hermes_persistence --> <!-- @impl: src/lib/hermes-retention.ts::HermesRetention --> <!-- @test: src/__tests__/lib/hermes-retention.test.ts (REQ-MEM-041 AC2: confirmed exit after failed final sync allows reopening but not eviction) --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (round-trips cleared Markdown without transferring Hermes transient files (${syncPolicyMode})) --> <!-- @test: src/__tests__/container/session-stop.test.ts (REQ-MEM-042 AC3: final-sync status %s governs eviction after the stopped session row is deleted) --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-MEM-041 AC6: replacement preparation opens saved session Markdown without reseeding) -->
7. A confirmed eviction permits reseeding the session from the masters when readmitted. Missing or failed restore is not eviction. <!-- @impl: src/lib/hermes-retention.ts::HermesRetention --> <!-- @impl: entrypoint.sh::configure_pi_hermes_memory --> <!-- @test: src/__tests__/lib/hermes-retention.test.ts (REQ-MEM-041 AC7: a confirmed evicted store can be admitted as new) --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-MEM-041 AC3: refused or incomplete existing restore never reads from masters or reuploads stale local files) --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-041 AC7: new admission on a warm home seeds current masters, not evicted memory) --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-041 AC7: interrupted warm retirement resumes without publishing old bytes) --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-041 AC7: a later admission replaces an interrupted generation’s seed) -->

**Constraints:**

- Ordinary sync does not perform cross-session merging. Explicit Enterprise shutdown consolidation follows [REQ-MEM-044](#req-mem-044-consolidate-hermes-on-graceful-shutdown); the ordinary sync cadence and native recall remain unchanged.
- Transient Hermes files follow [REQ-MEM-035 AC2](#req-mem-035-durable-pi-facts-with-disposable-local-search); retention follows [REQ-MEM-042](#req-mem-042-retain-ten-recent-session-memory-stores).
- Separate files do not imply an atomic multi-file remote snapshot. Signed adapter compatibility follows [REQ-MEM-043](#req-mem-043-hermes-signed-adapter-compatibility).

**Priority:** P1

**Dependencies:** [REQ-MEM-035](#req-mem-035-durable-pi-facts-with-disposable-local-search)

**Verification:** Automated: [rclone SSE-C empty reads](../../scripts/ci/rclone-hermes-empty_test.go), [pi-hermes-startup.test.js](../../host/__tests__/pi-hermes-startup.test.js), [entrypoint-rclone-filters.test.js](../../host/__tests__/entrypoint-rclone-filters.test.js), [hermes-retention.test.ts](../../src/__tests__/lib/hermes-retention.test.ts)

**Status:** Implemented

---

### REQ-MEM-044: Consolidate Hermes on graceful shutdown

**Intent:** Merge the closing session's saved changes into bounded shared masters without rewriting active sessions.

**Applies To:** User

**Acceptance Criteria:**

1. Compare the four saved active files to their exact baseline by whole entries. Ignore timestamp-only changes and do not infer shared deletes from missing entries. A no-op needs no inference. <!-- @impl: host/src/hermes-shutdown-merge.ts::runHermesShutdownMerge --> <!-- @test: host/__tests__/hermes-merge-storage.test.js (REQ-MEM-044: a reseeded baseline preserves subsequent whole-entry change detection) --> <!-- @test: host/__tests__/hermes-shutdown-merge.test.js (REQ-MEM-044: three stops use fresh masters and carry whole additions and corrections without deleting absent facts) --> <!-- @test: host/__tests__/hermes-shutdown-merge.test.js (REQ-MEM-044: timestamp-only changes and removals alone skip inference and do not advance the masters) -->
2. Validate all four candidates as Hermes Markdown within 150,000 UTF-16 units per file. Write only the four fixed masters under `Vault/Memory`. Grant a receipt only after readback matches all four candidates. <!-- @impl: host/src/hermes-shutdown-merge.ts::runHermesShutdownMerge --> <!-- @impl: host/src/hermes-shutdown-merge.ts::createHermesMergeStorage --> <!-- @test: host/__tests__/hermes-shutdown-merge.test.js (REQ-MEM-044 AC2: validated fixed master transfer) --> <!-- @test: host/__tests__/hermes-merge-storage.test.js (REQ-MEM-044: rclone pulls and writes only the four fixed master objects) -->
3. The 20-minute deadline starts after confirmed normal save or admission of a manual retry at the queue head. Repair cannot reset it. Expiry or Kill cancels the writer and fences further writes, without undoing accepted uploads. <!-- @impl: host/src/hermes-shutdown-merge.ts::runHermesShutdownMerge --> <!-- @test: host/__tests__/hermes-shutdown-merge.test.js (REQ-MEM-044: input loading, inference, and repair share the original 20-minute budget) --> <!-- @test: host/__tests__/hermes-shutdown-merge.test.js (REQ-MEM-044 AC3: fixed deadline and cancellation) -->
4. A failed or interrupted merge retains the exact saved input without reporting a merge. Headless retry uses that saved snapshot and baseline with the latest masters; it never opens a terminal or reseeds. <!-- @impl: host/src/hermes-shutdown-merge.ts::runHermesShutdownMerge --> <!-- @impl: src/container/index.ts::retrySavedHermes --> <!-- @test: host/__tests__/hermes-shutdown-merge.test.js (REQ-MEM-044: a headless worker retry uses the same saved change and current masters after an earlier failure) --> <!-- @test: src/__tests__/routes/session-shutdown.test.ts (REQ-SESSION-043: Retry launches only the headless runtime with the same confirmed snapshot) -->
5. Normal Resume, including after Kill, restores an intact saved unmerged store with its baseline. Only a verified fixed-master receipt for that snapshot permits reseeding. Legacy receipts do not. A missing or invalid baseline cannot authorize replacement. <!-- @impl: entrypoint.sh::configure_pi_hermes_memory --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-044 AC5: seeds from the fixed masters only when the receipt matches the restored snapshot) --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-044 AC5: invalid baseline bytes never replace an intact restored store) --> <!-- @test: src/__tests__/routes/session-shutdown.test.ts (REQ-MEM-044: Resume after an unconfirmed master transfer keeps the saved snapshot without a merge receipt) --> <!-- @impl: src/lib/session-repository.ts::fromRow --> <!-- @impl: src/lib/session-repository.ts::start --> <!-- @test: src/__tests__/routes/session-shutdown.test.ts (REQ-MEM-044: a carried-forward legacy receipt cannot authorize reseeding) --> <!-- @test: src/__tests__/routes/session-shutdown.test.ts (REQ-MEM-044: persisted legacy result (%s) cannot authorize Delete or reseed) -->
6. Failed or partial restore or upload retains the receipt. Only an accepted current-generation observation of verified replacement bytes consumes it. <!-- @impl: entrypoint.sh::configure_pi_hermes_memory --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-MEM-044 AC6: a stale runtime observation neither projects metrics nor clears the matching receipt) --> <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-020 AC1-2: one complete authenticated observation projects without a D1 pre-read or readback (%s)) --> <!-- @impl: entrypoint.sh::persist_pi_hermes_memory --> <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @impl: src/lib/session-repository.ts::project --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-MEM-044: an interrupted reseed upload cannot acknowledge a mixed restored snapshot) --> <!-- @test: src/__tests__/routes/session-shutdown.test.ts (REQ-MEM-044: a failed restore does not consume the saved merge receipt) -->
7. After restart, validate the saved proof against the receipt and all restored replacement bytes, independent of later master changes. <!-- @impl: entrypoint.sh::restored_replacement_matches --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-MEM-044: an interrupted reseed upload cannot acknowledge a mixed restored snapshot) -->

**Constraints:**

- No live trimmer, journal, or Operator; keep native search and recall.
- Enterprise scoped master transfers exclude the four fixed masters from ordinary bisync in both filter modes. <!-- @impl: entrypoint.sh::transfer_pi_hermes_memory --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-MEM-044: only scoped sync round-trips the owning baseline) -->
- New sessions can seed mixed master bytes during or after an incomplete transfer. <!-- @impl: entrypoint.sh::restore_pi_hermes_masters --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-MEM-044: new sessions seed both copies from the fixed masters visible after a partial upload) -->
- Retention must not evict pending snapshots. <!-- @impl: src/container/index.ts::hermesWriterSettled --> <!-- @test: src/__tests__/routes/session-shutdown.test.ts (REQ-SESSION-043: retains a saved failed Delete after exit and advances the queue without deleting it) -->
- An authorized SSE-C Markdown read may retry without the key only to verify an empty object. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-MEM-044 AC5: seeds the baseline and active store from four fixed masters, including an empty master) --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-MEM-044: strict egress relays only verified zero-byte Hermes fallback reads) -->

**Priority:** P1

**Dependencies:** [REQ-MEM-041](#req-mem-041-session-isolated-hermes-markdown), [REQ-SESSION-043](session-lifecycle.md#req-session-043-queued-graceful-shutdown-and-memory-recovery)

**Verification:** Automated: [merge worker](../../host/__tests__/hermes-shutdown-merge.test.js), [R2 request contract](../../host/__tests__/hermes-merge-storage.test.js), [startup restore](../../host/__tests__/pi-hermes-startup.test.js), [scoped transfer](../../host/__tests__/entrypoint-rclone-filters.test.js), [strict R2 transport](../../src/__tests__/egress-controller.test.ts), [headless retry](../../src/__tests__/routes/session-shutdown.test.ts), [authenticated receipt projection](../../src/__tests__/container-metrics.test.ts)

**Status:** Planned

---

### REQ-MEM-042: Retain ten recent session memory stores

**Intent:** Bound durable per-user Hermes session memory without deleting live edits or touching unrelated data.

**Applies To:** User

**Acceptance Criteria:**

1. At most ten new-layout Hermes stores are persisted per user. At capacity, each admitted store replaces a distinct least recently updated store. <!-- @test: src/__tests__/lib/hermes-retention.test.ts (REQ-MEM-042 AC1: overlapping admissions evict distinct least recently updated stores) --> <!-- @impl: src/lib/hermes-retention.ts::HermesRetention -->
2. First persistence of session Markdown establishes recency. After that, only a change to its contents advances recency. <!-- @test: src/__tests__/lib/hermes-retention.test.ts (REQ-MEM-042 AC2: an unchanged later sync does not touch rank, but an actual Markdown edit does) --> <!-- @impl: src/lib/hermes-retention.ts::HermesRetention --> <!-- @impl: entrypoint.sh::transfer_pi_hermes_memory --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-MEM-042 AC2: identical Markdown keeps its remote timestamp and equal-size edits still transfer) --> <!-- @impl: src/lib/hermes-retention-r2.ts::hermesRetentionR2 --> <!-- @test: host/__tests__/entrypoint-storage-restart.test.js (REQ-MEM-042 AC2: scoped S3 upload stamps only new or changed Hermes bytes) --> <!-- @test: src/__tests__/lib/r2-migration.test.ts (REQ-MEM-042 AC2: re-encrypting Hermes Markdown preserves its actual write timestamp) --> <!-- @test: src/__tests__/lib/hermes-retention-r2.test.ts (REQ-MEM-042 AC2: an SSE-C store observes only proven-empty default-encrypted Markdown (%s)) --> <!-- @test: src/__tests__/lib/hermes-retention.test.ts (REQ-MEM-042 AC2: a change back to previously observed bytes still counts as an update) -->
3. When admission requires eviction, defer and report new persistence unless the oldest store’s exact writer has confirmed exit and successful final sync. Deferral does not block ordinary session startup or evict a newer store. <!-- @impl: src/container/index.ts::launchSession --> <!-- @impl: src/container/index.ts::hermesWriterSettled --> <!-- @impl: src/lib/hermes-retention.ts::HermesRetention --> <!-- @test: src/__tests__/lib/hermes-retention.test.ts (REQ-MEM-042 AC3/AC4: does not reuse a slot on %s) --> <!-- @test: src/__tests__/container/session-stop.test.ts (REQ-MEM-042 AC3: unavailable memory admission defers persistence without stopping Advanced startup) --> <!-- @test: src/__tests__/container/session-stop.test.ts (REQ-MEM-042 AC3: final-sync status %s governs eviction after the stopped session row is deleted) --> <!-- @test: src/__tests__/routes/session-shutdown.test.ts (REQ-MEM-042 AC3: headless Retry preserves settlement of the saved writer after Delete (pre-rollout %s)) --> <!-- @test: src/__tests__/routes/session-shutdown.test.ts (REQ-MEM-042 AC3: late exit replay after a skipped pre-rollout Retry preserves the saved writer (monitor first %s)) --> <!-- @test: src/__tests__/routes/session-shutdown.test.ts (REQ-MEM-042 AC3: replay settles the admitted writer after interrupted exit cleanup) -->
4. Incomplete inventory or uncertain write ownership prevents eviction. <!-- @impl: src/lib/hermes-retention.ts::HermesRetention --> <!-- @impl: src/lib/hermes-retention-r2.ts::hermesRetentionR2 --> <!-- @test: src/__tests__/lib/hermes-retention-r2.test.ts (REQ-MEM-042 AC4: whole-prefix R2 deletion leaves sibling stores and shared files intact) --> <!-- @test: src/__tests__/lib/hermes-retention-r2.test.ts (REQ-MEM-042 AC4: incomplete R2 listings cannot authorize even a partial delete) --> <!-- @test: src/__tests__/lib/hermes-retention.test.ts (REQ-MEM-042 AC4: a held deletion cannot free a slot after owner reconstruction (empty prefix=%s)) --> <!-- @test: src/__tests__/lib/hermes-retention.test.ts (REQ-MEM-042 AC4: an incomplete non-victim observation blocks eviction) --> <!-- @test: src/__tests__/lib/hermes-retention.test.ts (REQ-MEM-042 AC4: an unconfirmed %s deletion requires empty-prefix readback) -->
5. Eviction removes the whole session memory folder; the slot is freed only after confirming the exact prefix is empty. <!-- @impl: src/lib/hermes-retention.ts::HermesRetention --> <!-- @impl: src/lib/hermes-retention-r2.ts::hermesRetentionR2 --> <!-- @test: src/__tests__/lib/hermes-retention-r2.test.ts (REQ-MEM-042 AC4: whole-prefix R2 deletion leaves sibling stores and shared files intact) --> <!-- @test: src/__tests__/lib/hermes-retention.test.ts (REQ-MEM-042 AC4: an unconfirmed %s deletion requires empty-prefix readback) -->
6. Concurrent sync cannot recreate an evicted store with stale files. <!-- @impl: entrypoint.sh::transfer_pi_hermes_memory --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-MEM-042 AC4: sessions sharing a bucket cannot restore or re-upload each other's Hermes Markdown (${syncPolicyMode})) --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-041 AC7: new admission on a warm home seeds current masters, not evicted memory) -->
7. Equal update times are ordered by ascending session ID. <!-- @impl: src/lib/hermes-retention.ts::HermesRetention --> <!-- @test: src/__tests__/lib/hermes-retention.test.ts (REQ-MEM-042 AC2: sessions with equal content-update times evict by ascending session ID) -->

**Constraints:**

- Pruning removes only `Vault/Memory/Sessions/<session-id>/` for the evicted new-layout store, including all files and subfolders inside it. A legacy checkpoint in that folder is removed with it. Checkpoint-only folders, session records, transcripts, shared masters, and other users’ data are outside retention.
- Creating or resuming a Codeflare session, reading its files, and syncing unchanged Markdown never refresh an existing store’s rank. No container-local listing authorizes pruning. [Pending shutdown merges](#req-mem-044-consolidate-hermes-on-graceful-shutdown) are not settled for eviction.
- A superseded automatic final-sync result cannot overwrite the authoritative Stop receipt for that writer. <!-- @impl: src/container/container-metrics.ts::drainFinalSync --> <!-- @test: src/__tests__/container/container-metrics-drain.test.ts (REQ-MEM-042 AC3: automatic final sync retains a completed receipt for the exact writer) --> <!-- @test: src/__tests__/container/container-metrics-drain.test.ts (REQ-MEM-042 AC3: late automatic failure keeps the manual Stop receipt after %s) -->

**Priority:** P1

**Dependencies:** [REQ-MEM-041](#req-mem-041-session-isolated-hermes-markdown)

**Verification:** Automated: [admission](../../src/__tests__/lib/hermes-retention.test.ts), [R2 prefix and metadata](../../src/__tests__/lib/hermes-retention-r2.test.ts), [session lifecycle](../../src/__tests__/container/session-stop.test.ts), [sync scope](../../host/__tests__/entrypoint-rclone-filters.test.js), [S3 write stamps](../../host/__tests__/entrypoint-storage-restart.test.js), [re-encryption](../../src/__tests__/lib/r2-migration.test.ts)

**Status:** Implemented

---

### REQ-MEM-043: Hermes signed adapter compatibility

**Intent:** Preserve recognized signed layouts during rollout without exposing shared masters to a previously isolated writer.

**Applies To:** User

**Acceptance Criteria:**

1. An eligible session using an exact recognized legacy signed adapter keeps its layout and signed bytes. <!-- @impl: entrypoint.sh::configure_pi_hermes_memory --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-035: a new image preserves the installed legacy signed adapter and activates isolation after seed upgrade) --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-041 AC5: v197 retains its own checkpoint behavior without changing signed bytes) -->
2. Direct-layout memory only opens with a compatible adapter. <!-- @impl: src/container/index.ts::admitHermesStore --> <!-- @impl: entrypoint.sh::configure_pi_hermes_memory --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-041 AC6: direct admission or a local direct marker prevents fallback to signed legacy adapters) -->
3. A previously isolated store never falls back to shared-master writes. Defer master-backed initialization whenever prior isolation cannot be ruled out. <!-- @impl: src/container/index.ts::admitHermesStore --> <!-- @impl: entrypoint.sh::configure_pi_hermes_memory --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-041 AC6: a replacement without a checkpoint never falls back to master writes) -->
4. Failed checkpoint publication preserves the predecessor. If rollback cannot restore its canonical path, retain recoverable bytes and explicitly report incomplete rollback. <!-- @impl: entrypoint.sh::configure_pi_hermes_memory --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-041 AC5: v197 retains its own checkpoint behavior without changing signed bytes) --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-043 AC4: failed checkpoint rollback retains the predecessor and is reported separately) -->

5. Failure to clean up staging after a committed checkpoint does not turn publication into a failure. <!-- @impl: entrypoint.sh::configure_pi_hermes_memory --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (REQ-MEM-043 AC4: committed checkpoint survives staging cleanup failure) -->

**Constraints:**

- No legacy checkpoint is imported into the direct layout.
- Signed adapter bytes are not rewritten.

**Priority:** P1

**Dependencies:** [REQ-MEM-041](#req-mem-041-session-isolated-hermes-markdown)

**Verification:** Automated: [pi-hermes-startup.test.js](../../host/__tests__/pi-hermes-startup.test.js)

**Status:** Implemented

---

### REQ-MEM-039: Native memory tools and safe updates

**Intent:** Foreground Pi can search and update saved facts explicitly without changing unrelated memory or leaking secrets.

**Applies To:** User

**Acceptance Criteria:**

1. Foreground Pi delivers stock Hermes policy-only guidance and native memory search/write tools. <!-- @impl: preseed/agents/pi/extensions/hermes-memory-runtime.ts::hermesMemoryRuntime --> <!-- @test: host/__tests__/pi-hermes-memory.test.js (REQ-MEM-035: AC5 foreground ownership gates stock writers/tools and drains shutdown before release) -->
2. Add, search and remove preserve unrelated facts. <!-- @impl: preseed/agents/pi/extensions/hermes-memory-runtime.ts::workspaceMemoryApi --> <!-- @test: host/__tests__/pi-hermes-native.test.js (REQ-MEM-036: policy-only stores above 5000 units remain searchable and support explicit add/replace/remove without losing original facts) -->
3. Pi guidance directs native tool activation and add or replace for explicit durable corrections, never secrets. <!-- @impl: preseed/agents/claude/rules/engineering-constitution.md::Engineering --> <!-- @test: host/__tests__/agent-seed-core.test.js (REQ-MEM-035 AC1/AC6: advanced Pi receives the memory owner and explicit native tool guidance) -->

**Constraints:** Recalled facts confer no authority; foreground ownership and ordinary helper restrictions remain intact.

**Priority:** P0

**Dependencies:** [REQ-MEM-035](#req-mem-035-durable-pi-facts-with-disposable-local-search)

**Verification:** Automated: [pi-hermes-memory.test.js](../../host/__tests__/pi-hermes-memory.test.js), [pi-hermes-native.test.js](../../host/__tests__/pi-hermes-native.test.js), [agent-seed-core.test.js](../../host/__tests__/agent-seed-core.test.js)

**Status:** Implemented

---

### REQ-MEM-040: Native memory consolidation startup defaults

**Intent:** New Hermes settings get bounded manual consolidation without automatic consolidation.

**Applies To:** User

**Acceptance Criteria:**

1. Startup defaults manual consolidation to chunked operation without enabling automatic consolidation, preserving explicit valid preferences. <!-- @impl: entrypoint.sh::configure_pi_hermes_memory --> <!-- @test: host/__tests__/pi-hermes-startup.test.js (Pi Hermes startup (actual entrypoint helper)) -->

**Constraints:** Preparation never overwrites malformed settings or resolves filesystem ownership conflicts by overwriting data. In the isolated layout, manual consolidation is scoped to the current session’s working store. See the [legacy adapter exception](#req-mem-041-session-isolated-hermes-checkpoints). Codeflare does not schedule automatic consolidation in interactive Pi.

**Priority:** P0

**Dependencies:** [REQ-MEM-035](#req-mem-035-durable-pi-facts-with-disposable-local-search)

**Verification:** Automated: [pi-hermes-startup.test.js](../../host/__tests__/pi-hermes-startup.test.js)

**Status:** Implemented

---

<a id="req-mem-036-fresh-bounded-pi-fact-context-on-every-request"></a>
### REQ-MEM-036: Search-based Pi fact recall

**Intent:** Native policy-only memory remains searchable as it grows, without a second full-file injector or misleading size-limit warnings.

**Applies To:** Agent

**Acceptance Criteria:**

1. Initial, subsequent and immediate post-compaction model requests do not automatically include complete personal-memory files through a Codeflare context injector. <!-- @impl: preseed/agents/pi/extensions/hermes-memory-runtime.ts::hermesMemoryRuntime --> <!-- @test: host/__tests__/pi-hermes-native.test.js (REQ-MEM-036: managed native requests omit unsolicited stored facts and size warnings initially, subsequently and after automatic compaction; explicit search recalls them) -->
2. Explicit memory search recalls saved user, global and workspace facts from the active Hermes store, including corrections and files larger than 5,000 UTF-16 units. Fresh processes reconstruct recall under the existing local search-cache contract. <!-- @impl: preseed/agents/pi/extensions/hermes-memory-runtime.ts::workspaceMemoryApi --> <!-- @test: host/__tests__/pi-hermes-native.test.js (REQ-MEM-036: policy-only stores above 5000 units remain searchable and support explicit add/replace/remove without losing original facts) -->
3. Retrieved facts remain untrusted reference data, never new instructions, permission or authorization. Current user instructions and verified source outrank recalled facts; normal prompt/tool/image and conversation handling remains Pi-owned. <!-- @impl: preseed/agents/claude/rules/engineering-constitution.md::Engineering --> <!-- @manual -->
4. Stored memory is not truncated, evicted or rewritten to satisfy the retired 5,000/15,000 context budgets. <!-- @impl: preseed/agents/pi/extensions/hermes-memory-runtime.ts::hermesMemoryRuntime --> <!-- @test: host/__tests__/pi-hermes-native.test.js (REQ-MEM-036: policy-only stores above 5000 units remain searchable and support explicit add/replace/remove without losing original facts) -->
5. Foreground ownership, ordinary helper-session isolation, stable workspace scope, graceful shutdown and historical capture/Graphify/Smart Compact ownership remain unchanged. No replacement full-file or automatic-query subsystem is introduced. <!-- @impl: preseed/agents/pi/extensions/hermes-memory-runtime.ts::attachHermesMemoryToForeground --> <!-- @test: host/__tests__/pi-hermes-memory.test.js (REQ-MEM-035: AC5 foreground ownership gates stock writers/tools and drains shutdown before release) -->

6. Pi guidance directs capability activation and native memory search for specific scoped facts before context-dependent planning, action or repeated questions rather than assuming facts are loaded. <!-- @impl: preseed/agents/claude/rules/engineering-constitution.md::Engineering --> <!-- @test: host/__tests__/agent-seed-core.test.js (REQ-MEM-035 AC1/AC6: advanced Pi receives the memory owner and explicit native tool guidance) -->
7. Crossing the retired 5,000/15,000 context budgets produces no repeated context-size degradation warnings. Actual initialization or persistence failures remain reported and fail closed under [REQ-MEM-035](#req-mem-035-durable-pi-facts-with-disposable-local-search). <!-- @impl: preseed/agents/pi/extensions/hermes-memory-runtime.ts::hermesMemoryRuntime --> <!-- @test: host/__tests__/pi-hermes-native.test.js (REQ-MEM-036: managed native requests omit unsolicited stored facts and size warnings initially, subsequently and after automatic compaction; explicit search recalls them) -->

**Constraints:**
- Recall is search-driven, not a promise of automatic recall or deterministic model obedience.
- Do not enable historical backfill or standing instructions as a workaround.
- Use public Pi lifecycle interfaces and the unmodified upstream memory package; retain Codeflare lifecycle qualification and shutdown receipts.

**Priority:** P1

**Dependencies:** [REQ-MEM-035](#req-mem-035-durable-pi-facts-with-disposable-local-search), [REQ-MEM-019](#req-mem-019-post-compaction-recall-of-recent-session-extracts)

**Verification:** Automated: [pi-hermes-memory.test.js](../../host/__tests__/pi-hermes-memory.test.js), [pi-hermes-native.test.js](../../host/__tests__/pi-hermes-native.test.js), [agent-seed-core.test.js](../../host/__tests__/agent-seed-core.test.js); Manual: [Native policy-only recall acceptance](../../documentation/lanes/vault.md#native-policy-only-recall-acceptance)

**Status:** Implemented

---
