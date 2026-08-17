# Agents Domain Specification

Multi-agent support, preseed system, and session modes.

### Key Concepts

| Concept | Definition |
|---------|-----------|
| Agent | One of seven supported AI coding tools (`claude-code`, `codex`, `copilot`, `antigravity`, `opencode`, `pi`, `bash`) that runs inside the container and is auto-started in terminal tab 1 |
| Preseed | A set of configuration files (rules, skills, agents, commands, plugins) generated from a single Claude Code source of truth and deployed to each user's R2 bucket |
| Session Mode | Either Standard (`default`) or Pro (`advanced`) controlling the scope of agent enhancements seeded to a user's storage |
| Manifest | The declarative `manifest.json` file that maps each preseed source file to its applicable modes and drives the code generation pipeline |

### Out of Scope

- **Custom agent creation by users** -- Users cannot define their own agent types or register third-party CLI tools as agents. The seven supported agents are hardcoded.
- **Agent marketplace** -- No mechanism for browsing, installing, or sharing community-contributed agent configurations or plugins.
- **Runtime agent switching** -- Agent type is immutable after session creation. Switching requires creating a new session.
- **Explicit consult-llm preference toggle** -- There is no separate Settings switch for the multi-model consultation feature. It is active implicitly whenever the user has at least one LLM provider key configured; removing the key is the off-switch.
- **Graphify hard-block enforcement** -- The count-based PreToolUse hard-block for structural-search tools was removed; graph-first discipline is advisory only (the preseeded rule in [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline) plus the per-call soft nudge in [REQ-AGENT-091](#req-agent-091-advanced-session-graph-first-runtime-reminders)). The hard-block misfired on legitimate single-file searches the graph-first rule itself excludes.

### Domain Dependencies

| Domain | Dependency |
|--------|-----------|
| Session Lifecycle | Container start triggers agent CLI auto-start in tab 1; session creation accepts `agentType` selection |
| Storage | R2 bucket stores preseed files; initial sync restores agent configs to the container filesystem |
| Subscription | Session mode gating (`REQ-SUB-014`) controls whether a user can select Pro mode |

---

### REQ-AGENT-001: Support Multiple AI Coding Agents

**Intent:** The platform must support multiple AI coding agents so users can choose the tool that fits their workflow.

**Applies To:** User

**Acceptance Criteria:**

1. Seven agent types are defined: `claude-code`, `codex`, `copilot`, `antigravity`, `opencode`, `pi`, `bash`. <!-- @impl: src/types.ts::AgentTypeSchema --> <!-- @test: src/__tests__/lib/agent-config.test.ts (AGENT_COMMANDS exhaustiveness / REQ-AGENT-001 AC1/AC2 (seven agent types: claude-code, codex, copilot, antigravity, opencode, pi, bash; enforced via AgentTypeSchema)) -->
2. The supported agent-type values are schema-validated at the request boundary. <!-- @impl: src/types.ts::AgentTypeSchema --> <!-- @test: src/__tests__/lib/agent-config.test.ts (AGENT_COMMANDS exhaustiveness / REQ-AGENT-001 AC1/AC2 (seven agent types: claude-code, codex, copilot, antigravity, opencode, pi, bash; enforced via AgentTypeSchema)) -->
3. Each coding-agent CLI selected for a deployment is installed in the container image from a committed lock-backed npm tree or a checksum-pinned native artifact; an unspecified selection installs the full supported set. <!-- @impl: Dockerfile::CODEFLARE_CODING_AGENTS --> <!-- @impl: scripts/ci/coding-agent-selection.mjs::resolveCodingAgents --> <!-- @test: host/__tests__/coding-agent-selection.test.js (REQ-OPS-038: deployment coding-agent selection) -->
4. Of the Node.js-based agent CLIs, only Pi is pre-warmed at image build time; Codex and Copilot pay the compile cost on first launch. <!-- @impl: Dockerfile::NODE_COMPILE_CACHE --> <!-- @manual -->
5. Pi extension npm dependencies are available from the image cache without overwriting restored user package metadata. <!-- @impl: entrypoint.sh::warm_pi_npm_dependencies --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (REQ-AGENT-001: Pi npm warm cache seeds dependencies without overwriting user package metadata) -->
6. The image build fails if either committed pre-warmed Pi SDK dependency/override pin differs from the lock-backed runtime-agent pin or installed version. <!-- @impl: Dockerfile::verify-pi-lockstep --> <!-- @impl: scripts/verify-pi-lockstep.mjs::verifyPiLockstep --> <!-- @test: host/__tests__/pi-lockstep.test.js (REQ-AGENT-001 AC6: Pi image lockstep fails closed) -->
7. When Claude Code is selected, the image build verifies that its shared CLI can start; official Claude IDE inventory verification remains unconditional. <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::main --> <!-- @manual: Build an image with and without Claude Code and inspect the packaged-image evidence. -->

**Constraints:**

- Agent CLI versions move only through reviewed lockfile bump PRs after the configured cooldown.
- Major version jumps remain compatibility-sensitive and require normal review and CI.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-111: Native Goal Workflow in Pi Sessions

**Intent:** Pi sessions must provide session-scoped autonomous goal completion without adding cold-start transpilation work.

**Applies To:** User

**Acceptance Criteria:**

1. Pi's required package set includes one exact-pinned, integrity-locked `@narumitw/pi-goal` package. <!-- @impl: entrypoint.sh::required --> <!-- @impl: preseed/agents/pi/package.json::dependencies --> <!-- @test: host/__tests__/pi-settings-packages.test.js (Goal package preseed) -->
2. Image construction warms the installed Goal extension so a new session uses its path-correct transpile cache instead of cold-transpiling it. <!-- @impl: Dockerfile::goal_source --> <!-- @manual: Start a new Pi session from the complete image and confirm Goal's installed extension loads from the baked jiti cache. -->
3. The image build fails if Goal's path-correct transpile-cache artifact is absent. <!-- @impl: Dockerfile::goal_hit --> <!-- @impl: scripts/verify-pi-lockstep.mjs::verifyJitiCacheArtifact --> <!-- @test: host/__tests__/pi-lockstep.test.js (REQ-AGENT-111 AC3: Goal jiti cache path and fail-closed artifact verification) --> <!-- @manual: Run the deployment image build; in a controlled build omit or replace Goal's expected cache file and confirm the jiti warm-cache layer exits non-zero before image publication. -->
4. Startup supplies `toolVisibility: "after-first-goal"` only when the Goal visibility preference is missing. <!-- @impl: entrypoint.sh::configure_pi_goal_defaults --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (REQ-AGENT-111 AC4 / REQ-AGENT-129 AC1: creates every Codeflare-owned Goal startup default when config is absent) -->
5. Capability initialization keeps both terminal Goal tools for an unfinished Goal or Goal's already-active `always` policy; absent, cleared, completed, malformed, or lazy fresh state does not independently widen the set. <!-- @impl: preseed/agents/pi/extensions/capability.ts::hasUnfinishedGoal --> <!-- @test: src/__tests__/lib/pi-capabilities.test.ts (REQ-AGENT-111: restores terminal Goal tools only for an unfinished session Goal) --> <!-- @test: src/__tests__/lib/pi-capabilities.test.ts (REQ-AGENT-111: preserves Goal tools already active under the always-visible policy) -->

**Constraints:**

- Goal remains an exact-pinned upstream dependency and must pass normal package review, lock regeneration, and deployment-image verification.

**Priority:** P1

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents), [REQ-SESSION-015](session-lifecycle.md#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition)

**Verification:** Entrypoint runtime behavior test; capability-filtering tests; deployment image verification

**Status:** Implemented

---

### REQ-AGENT-129: Goal Continuation Settings Policy

**Intent:** Codeflare must configure continuation pacing without overriding valid user-owned Goal settings.

**Applies To:** User

**Acceptance Criteria:**

1. Missing Goal configuration receives lazy tool visibility, 10 automatic turns, and a 60000ms continuation delay. <!-- @impl: entrypoint.sh::configure_pi_goal_defaults --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (REQ-AGENT-111 AC4 / REQ-AGENT-129 AC1: creates every Codeflare-owned Goal startup default when config is absent) -->
2. Startup preserves explicit Goal values while adding missing owned values. <!-- @impl: entrypoint.sh::configure_pi_goal_defaults --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (REQ-AGENT-129 AC2/AC3: adds missing values while preserving explicit and unknown preferences) -->
3. Startup preserves unknown Goal settings while adding missing owned values. <!-- @impl: entrypoint.sh::configure_pi_goal_defaults --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (REQ-AGENT-129 AC2/AC3: adds missing values while preserving explicit and unknown preferences) -->
4. Startup leaves malformed Goal configuration byte-for-byte unchanged. <!-- @impl: entrypoint.sh::configure_pi_goal_defaults --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (REQ-AGENT-129 AC4: preserves malformed Goal config byte-for-byte) -->
5. `minIntervalMs` accepts only non-negative safe integers. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalSettingsSource --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-129 AC5: rejects invalid minIntervalMs values) -->
6. A missing `minIntervalMs` normalizes to zero. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalSettingsSource --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-129 AC6: defaults a missing delay to zero) -->
7. Saving `minIntervalMs` persists it without dropping unknown settings. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalSettingsSource --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-129 AC7: saves the delay without dropping unknown fields) -->

**Constraints:**

- Goal remains the exact-pinned upstream 0.46.0 dependency; Codeflare carries no vendored fork, companion extension, or settings-UI patch.
- A future Goal upgrade requires deliberate review of the exact-version contract and source anchors.
- The weekly shadow-pin workflow runs the transform against the candidate installation before opening a PR. <!-- @impl: .github/workflows/bump-shadow-pins.yml::pi-extensions --> <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalDirectory --> <!-- @test: src/__tests__/ci/suite-gates.test.ts (REQ-AGENT-111: pi-goal shadow bumps preflight the locked review-control patch) --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-111/REQ-OPS-020: patches the cooldown-eligible pi-goal layout without double registration) -->
- Version or layout drift fails before any patched Goal source is written. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalDirectory --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-111: version or source drift fails before any package file is written) -->

**Priority:** P1

**Dependencies:** [REQ-AGENT-111](#req-agent-111-native-goal-workflow-in-pi-sessions)

**Verification:** Entrypoint startup tests; executable settings-patch tests; weekly shadow-pin workflow contract

**Status:** Implemented

---

### REQ-AGENT-130: Goal Continuation Runtime Pacing

**Intent:** Automatic Goal continuation must honor its configured delay without stale or duplicate dispatch.

**Applies To:** User

**Acceptance Criteria:**

1. A zero continuation delay dispatches immediately at an eligible settled boundary. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalRuntimeSource --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-130 AC1: zero delay dispatches immediately) --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-130 AC1: successor zero delay dispatches immediately) -->
2. A configured positive continuation delay waits its full duration before dispatch. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalRuntimeSource --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-130 AC2: waits the configured 60 seconds before continuation dispatch) --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-130 AC2: successor direct dispatch waits the configured interval) -->
3. Supported continuation delays above 2147483647ms wait their full duration. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalRuntimeSource --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-130 AC3: safely re-arms delays beyond the Node timer maximum) --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-130 AC3: successor scheduler re-arms delays beyond the Node timer maximum) -->
4. Repeated settled events retain one pending continuation timer. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalRuntimeSource --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-130 AC4: keeps repeated settled events single-flight) --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-130 AC4: successor repeated dispatch remains single-flight) -->
5. Existing continuation cancellation owners remove a pending timer. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalRuntimeSource --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-130 AC5: cancellation prevents a delayed continuation) --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-130 AC5: successor cancellation clears its pending dispatch) -->
6. Timer expiry rejects stale session generation, Goal identity, or continuation markers. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalRuntimeSource --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-130 AC6: stale menu, marker, and replacement-goal timers cannot dispatch) --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-130 AC6: successor scheduler rejects a replacement continuation marker) -->
7. Timer expiry retains intent when only idle eligibility changed. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalRuntimeSource --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-130 AC7: a busy timer retains intent for the next settled boundary) --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-130 AC7: successor busy expiry retains intent for the next settled boundary) -->

**Constraints:**

- Delays above Node's single-timer maximum are divided into bounded timer arms.

**Priority:** P1

**Dependencies:** [REQ-AGENT-129](#req-agent-129-goal-continuation-settings-policy)

**Verification:** Executable continuation scheduler tests

**Status:** Implemented

---

### REQ-AGENT-131: Native Usage Workflow in Pi Sessions

**Intent:** Pi sessions must preload the reviewed Usage package without cold-transpiling its entrypoint on first use.

**Applies To:** User

**Acceptance Criteria:**

1. Startup assembles `@narumitw/pi-usage` into Pi's required package set. <!-- @impl: entrypoint.sh::required --> <!-- @test: host/__tests__/pi-settings-packages.test.js (REQ-AGENT-076 AC1 / REQ-AGENT-131 AC1 / REQ-AGENT-133 AC1: fresh container assembles required packages and disables context-mode by default) -->
2. The preseed owns an exact version and SHA-512 integrity lock for `@narumitw/pi-usage`. <!-- @impl: preseed/agents/pi/package.json::dependencies --> <!-- @impl: preseed/agents/pi/package-lock.json::node_modules/@narumitw/pi-usage --> <!-- @test: host/__tests__/pi-settings-packages.test.js (pins the reviewed upstream package and integrity-locks its Pi entrypoint) -->
3. Image construction explicitly loads every declared Usage entrypoint into the path-correct JITI cache. <!-- @impl: Dockerfile::usage_source --> <!-- @impl: scripts/verify-pi-lockstep.mjs::warmAndVerifyJitiEntrypoints --> <!-- @test: host/__tests__/pi-lockstep.test.js (warms every requested entrypoint and fails when Usage produces no cache artifact) --> <!-- @test: host/__tests__/pi-lockstep.test.js (declares, warms, and re-verifies each locked package entrypoint) -->
4. Image construction fails when Usage's path-correct JITI artifact is absent. <!-- @impl: Dockerfile::usage_hit --> <!-- @impl: scripts/verify-pi-lockstep.mjs::verifyJitiCacheArtifact --> <!-- @test: host/__tests__/pi-lockstep.test.js (warms every requested entrypoint and fails when Usage produces no cache artifact) --> <!-- @test: host/__tests__/pi-lockstep.test.js (declares, warms, and re-verifies each locked package entrypoint) -->

**Constraints:**

- Package upgrades remain lock-backed and use the existing Pi-extension shadow-pin workflow.

**Priority:** P1

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents)

**Verification:** Package assembly and JITI cache contract tests; deployment image build

**Status:** Implemented

---

### REQ-AGENT-133: Native Evaluation Workflow in Pi Sessions

**Intent:** Pi sessions must preload the reviewed Evaluate package without cold-transpiling its entrypoint on first use.

**Applies To:** User

**Acceptance Criteria:**

1. Startup assembles `pi-evaluate` into Pi's required package set. <!-- @impl: entrypoint.sh::required --> <!-- @test: host/__tests__/pi-settings-packages.test.js (REQ-AGENT-076 AC1 / REQ-AGENT-131 AC1 / REQ-AGENT-133 AC1: fresh container assembles required packages and disables context-mode by default) -->
2. The preseed owns an exact version and SHA-512 integrity lock for `pi-evaluate`. <!-- @impl: preseed/agents/pi/package.json::dependencies --> <!-- @impl: preseed/agents/pi/package-lock.json::node_modules/pi-evaluate --> <!-- @test: host/__tests__/pi-settings-packages.test.js (pins the reviewed upstream release and integrity-locks its declared extension entrypoint) -->
3. Image construction explicitly loads the declared Evaluate entrypoint into the path-correct JITI cache. <!-- @impl: Dockerfile::evaluate_source --> <!-- @impl: scripts/verify-pi-lockstep.mjs::warmAndVerifyJitiEntrypoints --> <!-- @test: host/__tests__/pi-lockstep.test.js (declares, warms, and re-verifies each locked package entrypoint) --> <!-- @test: host/__tests__/pi-lockstep.test.js (warms every requested entrypoint and fails when Usage produces no cache artifact) -->
4. Image construction fails when Evaluate's path-correct JITI artifact is absent. <!-- @impl: Dockerfile::evaluate_hit --> <!-- @impl: scripts/verify-pi-lockstep.mjs::verifyJitiCacheArtifact --> <!-- @test: host/__tests__/pi-lockstep.test.js (declares, warms, and re-verifies each locked package entrypoint) -->

**Constraints:**

- The package contributes a skill only; Codeflare adds no tool, command, patch, or fork on top of it.
- Package upgrades remain lock-backed and use the existing Pi-extension shadow-pin workflow.

**Priority:** P2

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents)

**Verification:** Package assembly and JITI cache contract tests; deployment image build

**Status:** Implemented

---

### REQ-AGENT-112: Goal Pause Ownership Across PR Heads

**Intent:** Reviewer-bearing PR boundaries must not pause a Pi Goal unless its release ownership is recoverable.

**Applies To:** User

**Acceptance Criteria:**

1. A reviewer-bearing boundary records ownership before pausing one active Goal. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::pauseGoalForReview --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-112/REQ-AGENT-113/REQ-AGENT-114/REQ-AGENT-117: queues the review plan before pausing the Goal after the boundary turn ends) -->
2. Ownership persistence failure leaves the Goal active while review proceeds. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::pauseGoalForReview --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-112: does not pause when review ownership cannot be recorded) -->
3. Repeated handling of one boundary does not issue another pause request. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::pauseGoalForReview --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-112/REQ-AGENT-113/REQ-AGENT-114/REQ-AGENT-117: queues the review plan before pausing the Goal after the boundary turn ends) -->
4. A replacement PR head transfers existing pause ownership without pausing again. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::pauseGoalForReview --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-112: transfers an owned pause to a replacement PR head and resumes after its FIX reminder) -->
5. Failure to persist replacement-head ownership requests rollback resume. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::pauseGoalForReview --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-112: rolls back a paused Goal when replacement-head ownership cannot be recorded) -->
6. Successful rollback clears stale review ownership. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::pauseGoalForReview --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-112: rolls back a paused Goal when replacement-head ownership cannot be recorded) -->
7. Failed rollback retains recoverable ownership for the replacement review's release. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::pauseGoalForReview --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::releaseReviewGoalPause --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-112: retains failed rollback ownership and releases it after replacement-head review) -->

**Constraints:**

- Once ownership is recorded, the exact persisted paused Goal confirms it even when the bridge response is unavailable. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::pauseGoalForReview --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-112/REQ-AGENT-113: retains release ownership when the exact Goal persists paused despite a failed pause response) -->

**Priority:** P1

**Dependencies:** [REQ-AGENT-111](#req-agent-111-native-goal-workflow-in-pi-sessions)

**Verification:** Review-enforcement behavioral tests

**Status:** Implemented

---

### REQ-AGENT-113: Review-owned Goal Release

**Intent:** Review completion must release only the Goal pause owned by the applicable PR boundary.

**Applies To:** User

**Acceptance Criteria:**

1. The matching acknowledged FIX follow-up resumes a review-owned Goal. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::releaseReviewGoalPause --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendFixFollowUp --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-112/REQ-AGENT-113/REQ-AGENT-114/REQ-AGENT-117: queues the review plan before pausing the Goal after the boundary turn ends) -->
2. CI notifications do not resume a review-owned Goal. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::acknowledgeCompletedReview --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-112/REQ-AGENT-113/REQ-AGENT-114/REQ-AGENT-117: queues the review plan before pausing the Goal after the boundary turn ends) -->
3. Individual reviewer notifications do not resume a review-owned Goal. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::acknowledgeCompletedReview --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-112/REQ-AGENT-113/REQ-AGENT-114/REQ-AGENT-117: queues the review plan before pausing the Goal after the boundary turn ends) -->
4. Goal-control unavailability never blocks review launch or FIX delivery. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::requestGoalControl --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-113: fails open when the Goal extension is unavailable) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-113: keeps FIX delivery fail-open when Goal is removed during review) -->
5. A replacement Goal is not resumed from stale review ownership. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::releaseReviewGoalPause --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-113: never resumes a replacement Goal after the boundary pause) -->
6. An independently reactivated owned Goal is not resumed again. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::releaseReviewGoalPause --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-113: never resumes the same Goal after independent reactivation) -->
7. PR closure releases a matching review-owned pause without blocking closure handling. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::releaseReviewGoalPause --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-041/REQ-AGENT-058/REQ-AGENT-113/REQ-AGENT-114: a merged PR releases Goal without consuming bypass or acknowledging) -->

**Constraints:**

- PR enforcement never depends on Goal availability.

**Priority:** P1

**Dependencies:** [REQ-AGENT-112](#req-agent-112-goal-pause-ownership-across-pr-heads)

**Verification:** Review-enforcement behavioral tests

**Status:** Implemented

---

### REQ-AGENT-114: Review-owned Goal Continuation

**Intent:** Releasing a review-owned Goal must produce exactly the continuation appropriate to the release trigger.

**Applies To:** User

**Acceptance Criteria:**

1. Bridge-controlled resume suppresses Goal's separate continuation prompt. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalSource --> <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalLifecycleSource --> <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalCommandsSource --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-114: suppresses only the bridge-owned resume prompt) -->
2. The FIX follow-up owns the continuation turn after FIX-triggered resume. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendFixFollowUp --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-112/REQ-AGENT-113/REQ-AGENT-114/REQ-AGENT-117: queues the review plan before pausing the Goal after the boundary turn ends) -->
3. FIX-triggered continuation does not populate user input. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalSource --> <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalLifecycleSource --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendFixFollowUp --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-114: suppresses only the bridge-owned resume prompt) -->
4. Closure-triggered release schedules no continuation turn. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::releaseReviewGoalPause --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-041/REQ-AGENT-058/REQ-AGENT-113/REQ-AGENT-114: a merged PR releases Goal without consuming bypass or acknowledging) -->

**Constraints:**

- Managed Run RPC remains disabled for review-owned Goal control.

**Priority:** P1

**Dependencies:** [REQ-AGENT-113](#req-agent-113-review-owned-goal-release)

**Verification:** Patched-controller and review-enforcement behavioral tests

**Status:** Implemented

---

### REQ-AGENT-117: Non-disruptive review-owned Goal control

**Intent:** Optional Goal pause and release must not interrupt the PR-boundary turn or its background review work.

**Applies To:** User

**Acceptance Criteria:**

1. A reviewer-bearing boundary emits its launch plan before any Goal pause request. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-112/REQ-AGENT-113/REQ-AGENT-114/REQ-AGENT-117: queues the review plan before pausing the Goal after the boundary turn ends) -->
2. The successful boundary operation completes before any Goal pause request. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-112/REQ-AGENT-113/REQ-AGENT-114/REQ-AGENT-117: queues the review plan before pausing the Goal after the boundary turn ends) -->
3. Exactly one owned Goal pause follows the completed boundary launch turn. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::defaultDeferGoalPause --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-112/REQ-AGENT-113/REQ-AGENT-114/REQ-AGENT-117: queues the review plan before pausing the Goal after the boundary turn ends) -->
4. Missing Goal control does not block review launch. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::requestGoalControl --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-113: fails open when the Goal extension is unavailable) -->
5. Missing Goal control after review does not block FIX delivery. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::requestGoalControl --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-113: keeps FIX delivery fail-open when Goal is removed during review) -->
6. A manual resume that wins a release request clears stale ownership without reporting failure. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::releaseReviewGoalPause --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-113: clears stale review ownership when a manual resume wins the release race) -->
7. A recovered reviewer-bearing launch restores its deferred Goal pause. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-112/REQ-AGENT-121/REQ-AGENT-141: resumed sessions keep a visible plan inert through FIX and restore Goal pause) -->

**Constraints:** A failure in detached Goal pause control cannot block review or CI work.

**Priority:** P1

**Dependencies:** [REQ-AGENT-112](#req-agent-112-goal-pause-ownership-across-pr-heads), [REQ-AGENT-113](#req-agent-113-review-owned-goal-release)

**Verification:** Review-enforcement behavioral tests

**Status:** Implemented

---

### REQ-AGENT-144: Review-owned Goal pause command compatibility

**Intent:** Trusted review control must preserve pi-goal's native pause behavior without aborting unrelated Pi work.

**Applies To:** User

**Acceptance Criteria:**

1. A trusted review-owned pause does not abort the current Pi turn. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalCommandsSource --> <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalSource --> <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalLifecycleSource --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-111/REQ-AGENT-112/REQ-AGENT-114/REQ-AGENT-144: executes the session-bound pause/resume control contract) --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-144: preserves manual pause aborts while trusted review pause can suppress them) -->
2. A trusted review-owned pause cancels pending Goal continuation work. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalCommandsSource --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-144: preserves manual pause aborts while trusted review pause can suppress them) -->
3. A trusted review-owned pause transitions the active Goal to paused. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalCommandsSource --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-144: preserves manual pause aborts while trusted review pause can suppress them) -->
4. A manual Goal pause retains pi-goal's current-turn abort behavior. <!-- @impl: scripts/patch-pi-goal-review-control.mjs::patchPiGoalCommandsSource --> <!-- @test: host/__tests__/pi-goal-review-control-patch.test.js (REQ-AGENT-144: preserves manual pause aborts while trusted review pause can suppress them) -->

**Constraints:** Only the trusted session-local review-control channel may select the non-aborting pause path.

**Priority:** P1

**Dependencies:** [REQ-AGENT-111](#req-agent-111-native-goal-workflow-in-pi-sessions), [REQ-AGENT-114](#req-agent-114-review-owned-goal-continuation), [REQ-AGENT-117](#req-agent-117-non-disruptive-review-owned-goal-control)

**Verification:** pi-goal compatibility-transform behavioral tests

**Status:** Implemented

---

### REQ-AGENT-118: Enterprise consult-LLM unavailability

**Intent:** Enterprise users must use managed AI Gateway routes without receiving the per-user LLM-key or consult-LLM surface.

**Applies To:** User

**Acceptance Criteria:**

1. Enterprise sessions receive no per-user LLM provider keys. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (REQ-AGENT-118 AC1: injects no LLM keys in enterprise mode) -->
2. Enterprise users cannot access LLM-key management through the API. <!-- @impl: src/routes/llm-keys.ts::app --> <!-- @test: src/__tests__/routes/llm-keys.test.ts (enterprise mode (REQ-AGENT-118 AC2)) -->
3. Enterprise users do not see LLM-key management in Settings. <!-- @impl: web-ui/src/components/SettingsPanel.tsx::SettingsPanel --> <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (REQ-AGENT-118 AC3: hides LLM key management in enterprise mode) -->

**Constraints:** Enterprise models route through the managed AI Gateway instead.

**Priority:** P1

**Dependencies:** [REQ-AGENT-031](#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity)

**Verification:** Automated container, route, and Settings tests

**Status:** Implemented

---

<a id="req-agent-119-bounded-settled-review-follow-ups"></a>
### REQ-AGENT-119: Settled review follow-up accounting

**Intent:** Missing PR-boundary launch recovery must be bounded independently for each PR head in a normal checkout.

**Applies To:** User

**Acceptance Criteria:**

1. One unreviewed head emits at most five settled follow-ups before latching `GIVEUP`. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::blockDecision --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-041/REQ-AGENT-119: blocks five times then latches GIVEUP for the same head without acknowledging it) -->
2. Follow-up counts are isolated by PR number. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::statePath --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055: keeps acknowledgements isolated by pull request) -->
3. A different head starts a fresh follow-up count. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::blockDecision --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-041/REQ-AGENT-119: blocks five times then latches GIVEUP for the same head without acknowledging it) -->

**Constraints:** Accounting never acknowledges an unreviewed head.

**Priority:** P1

**Dependencies:** [REQ-AGENT-041](#req-agent-041-pr-boundary-review-bypass-surfaces)

**Verification:** Automated Pi review-enforcement tests

**Status:** Implemented

---

<a id="req-agent-120-claude-protected-base-review-boundaries"></a>
### REQ-AGENT-120: Claude review enforcement lifecycle

**Intent:** Claude must complete an eligible review through bounded enforcement, tool-free triage, exact-head acknowledgement, and a separate FIX handoff.

**Applies To:** User

**Acceptance Criteria:**

1. Before its access-preserving circuit breaker is exhausted, an eligible unacknowledged head prevents root-response completion. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::emit_block --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh — 5-strike circuit breaker / REQ-AGENT-044 (review-agent discipline enforcement)) -->
2. The root ends its triage turn without mutation. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::DIRECTIVE --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (does not repeat the launch reminder for the same unacknowledged head) -->
3. The Stop hook acknowledges the triaged head before issuing the separate FIX directive. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::ROUND_COMPLETE_LINE --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (drives the FIX phase once the verdict is published) -->
4. A synchronized closed or merged head emits one visibility notice only when it differs from the acknowledgement checkpoint; it never fabricates acknowledgement or consumes the bypass sentinel. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::CLOSED_NOTICE_FILE --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (reports a merged unacknowledged head without consuming the bypass sentinel) --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (keeps an acknowledged merged head silent and preserves the bypass sentinel) -->

**Constraints:** GitHub PR state and exact local-head equality decide enforcement eligibility.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-132](#req-agent-132-pr-delivery-and-existing-head-consent), [REQ-AGENT-122](#req-agent-122-per-pr-review-checkpoints)

**Verification:** Automated Claude Stop-hook behavior tests

**Status:** Implemented

---

### REQ-AGENT-132: PR delivery and existing-head consent

**Intent:** Pi and Claude must launch review automatically only for PR delivery commands while asking before reviewing an existing protected-base PR discovered through other Git or GitHub activity.

**Applies To:** User

**Acceptance Criteria:**

1. Successful executable `git push` and `gh pr create` commands are automatic delivery boundaries. Other successful executable `git` or `gh` commands require confirmation, except Claude automatically resumes the same PR when its authoritative synchronized head descends from that PR's local acknowledgement. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewBoundaryCommand --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::ACK_IS_PR_SPECIFIC --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::BOUNDARY_KIND --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-063/REQ-AGENT-116/REQ-AGENT-121: classifies delivery commands for automatic review and other Git activity for confirmation) --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (asks before review for non-delivery Git activity but auto-launches after push or PR creation) --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (auto-launches an acknowledged PR continuation even when the exposing command is non-delivery activity) --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (does not treat a repository-global legacy acknowledgement as same-PR continuation evidence) --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (does not accept a repository-global legacy acknowledgement for the current PR exact head) -->
2. A successful delivery command launches automatically only when the checked-out branch has an open protected-base PR whose authoritative head exactly equals local `HEAD`. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::currentReview --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::CURRENT_PR_HEAD --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-120/REQ-AGENT-121: automatically launches after PR creation without prompting) --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh — PR state gating) -->
3. Other successful Git or GitHub activity asks for an explicit launch or acknowledgement choice only when no same-PR acknowledged ancestor proves an active Claude review-fix continuation; choices are neutral and agent self-verification never recommends bypass. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::launchBoundaryPlan --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::ACK_IS_PR_SPECIFIC --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::DIRECTIVE --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-120/REQ-AGENT-121/REQ-AGENT-132: asks before reviewing an existing PR and acknowledges the exact head when declined) --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (asks before review for non-delivery Git activity but auto-launches after push or PR creation) --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (auto-launches an acknowledged PR continuation even when the exposing command is non-delivery activity) --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (does not treat a repository-global legacy acknowledgement as same-PR continuation evidence) --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (does not accept a repository-global legacy acknowledgement for the current PR exact head) -->
4. Cancelling the choice asks again without launching or acknowledging the head. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::launchBoundaryPlan --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::DIRECTIVE --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-120/REQ-AGENT-121/REQ-AGENT-132: repeats a cancelled review question until the user launches) -->
5. Choosing acknowledgement revalidates the live PR identity and routes through the existing exact-head acknowledgement. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::launchBoundaryPlan --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::DIRECTIVE --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-120/REQ-AGENT-121/REQ-AGENT-132: asks before reviewing an existing PR and acknowledges the exact head when declined) --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (prompts on branch navigation and acknowledges the exact head after the user declines) -->
6. Choosing launch continues the existing review and CI paths, with CI launched after reviewers and before the boundary turn ends. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::launchBoundaryPlan --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::DIRECTIVE --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074/REQ-AGENT-110/REQ-AGENT-132: emits one plan before settled recovery) --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (asks before review for non-delivery Git activity but auto-launches after push or PR creation) -->

**Constraints:** The existing structural tokenizer distinguishes automatic delivery commands from confirmation-required activity; GitHub PR state and exact local-head equality decide eligibility. Claude additionally reuses the PR-specific acknowledgement to recover an automatic review-fix continuation when the original delivery directive was missed.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-041](#req-agent-041-pr-boundary-review-bypass-surfaces), [REQ-AGENT-122](#req-agent-122-per-pr-review-checkpoints)

**Verification:** Automated Pi and Claude boundary behavior tests

**Status:** Implemented

---

### REQ-AGENT-145: Failed PR creation reconciliation

**Intent:** Pi recovers bounded failed PR creation outcomes only when authoritative checked-out-branch state proves the exact created PR head.

**Applies To:** User

**Acceptance Criteria:**

1. A failed `gh pr create` reporting HTTP 5xx reconciles only when the checked-out branch has an open protected-base PR whose authoritative head exactly equals local `HEAD`. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::ambiguousPrCreateFailure --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::currentReview --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-121/REQ-AGENT-145 AC1: reconciles an ambiguous failed PR creation against authoritative exact-head state) -->
2. A failed `gh pr create` reporting an already-existing PR reconciles only through the same authoritative exact-head check. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::ambiguousPrCreateFailure --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::currentReview --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-145 AC2: reconciles an already-existing PR failure against authoritative exact-head state) -->
3. Every other failed command remains inert. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-145 AC3: keeps non-ambiguous failed commands inert) -->

**Constraints:** Reconciliation never bypasses protected-base, branch, local-head, or authoritative-PR identity checks.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-121](#req-agent-121-checked-out-branch-boundary-synchronization), [REQ-AGENT-132](#req-agent-132-pr-delivery-and-existing-head-consent)

**Verification:** Automated Pi boundary behavior tests.

**Status:** Implemented

---

<a id="req-agent-121-downstream-boundary-after-develop-merge"></a>
### REQ-AGENT-121: Checked-out branch boundary synchronization

**Intent:** Pi and Claude must use authoritative checked-out-branch state to determine whether a PR head is eligible for review.

**Applies To:** User

**Acceptance Criteria:**

1. Any successful executable `git` or `gh` command requests an authoritative check for the command repository's checked-out branch, while the existing tokenizer marks only `git push` and `gh pr create` for automatic launch. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewBoundaryCommand --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::BOUNDARY_KIND --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-063/REQ-AGENT-116/REQ-AGENT-121: classifies delivery commands for automatic review and other Git activity for confirmation) -->
2. The checked-out branch name and local full `HEAD` are resolved without deriving a source or destination from command arguments. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::currentReview --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/gh-pr-state.sh::gh_pr_state --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063: verifies only the checked-out branch and rejects detached HEAD) -->
3. Automatic or confirmed review applies only to an open protected-base PR whose branch and authoritative head exactly equal the checked-out branch and local `HEAD`. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::currentReview --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::CURRENT_PR_HEAD --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063: checks authoritative current-branch state after any git or gh command) --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh — PR state gating) -->
4. A delivery whose authoritative head is still synchronizing retains bounded retries of the authoritative query, so its round opens once the head matches and a head that never matches stays ineligible. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::RETRY_DELAY --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::currentReview --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (opens the round once the authoritative head catches up) --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (gives up silently when the head never synchronizes) -->
5. Non-delivery activity never retries the authoritative query and never waits. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::BOUNDARY_KIND --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (never retries for non-delivery activity) -->

**Constraints:**

- The user workflow uses a normal checked-out branch.
- Detached HEAD and linked-worktree execution are unsupported and inert.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-055](#req-agent-055-pi-session-scoped-review-window), [REQ-AGENT-063](#req-agent-063-pr-boundary-candidate-detection), [REQ-AGENT-132](#req-agent-132-pr-delivery-and-existing-head-consent)

**Verification:** Automated Pi and Claude boundary behavior tests

**Status:** Implemented

---

### REQ-AGENT-141: Authoritative-head review launch continuity

**Intent:** An eligible authoritative head must preserve explicit launch and acknowledgement choices without duplicating a review round during the active session or its first recovery.

**Applies To:** User

**Acceptance Criteria:**

1. Non-delivery activity requires an explicit choice for the eligible exact head; cancellation repeats the choice, declining revalidates and writes the existing PR-specific acknowledgement, accepting launches the existing review and CI plan, and automatic delivery never prompts. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::launchBoundaryPlan --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-120/REQ-AGENT-121/REQ-AGENT-132: repeats a cancelled review question until the user launches) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-120/REQ-AGENT-121/REQ-AGENT-132: asks before reviewing an existing PR and acknowledges the exact head when declined) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-120/REQ-AGENT-121: launches the existing review and CI plan when confirmation is accepted) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-120/REQ-AGENT-121: automatically launches after PR creation without prompting) -->
2. Before queued follow-up delivery becomes transcript-visible, one accepted launch for the unchanged authoritative head remains single-flight. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::launchBoundaryPlan --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::PLAN_FILE --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-141: queues one same-head plan while follow-up delivery is not yet transcript-visible) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-112/REQ-AGENT-113/REQ-AGENT-114/REQ-AGENT-117: queues the review plan before pausing the Goal after the boundary turn ends) --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (does not repeat the launch reminder for the same unacknowledged head) -->
3. Startup or resume recovers one accepted-but-undelivered same-head launch. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::launchBoundaryPlan --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-110/REQ-AGENT-141: startup and resume recover one evaluated plan whose queued follow-up was lost) -->
4. Retroactive checkpoint recovery never claims the current head, so the live path acknowledges it and issues the fix handoff. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::RETRO_SHA --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (hands off to FIX when an upstream makes the just-written ack look fresh) -->
5. A transcript-visible launch plan for the unchanged authoritative head remains inert across normal resume and later Git or GitHub activity. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::launchBoundaryPlan --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::PLAN_FILE --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-141: normal resume keeps a visible exact-head plan inert) -->
6. An acknowledgement for the unchanged authoritative head remains inert during later Git or GitHub activity. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::launchBoundaryPlan --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-068: acknowledged current branch state stays inert) -->

**Constraints:** The user workflow uses a normal checked-out branch; detached HEAD and linked-worktree execution are unsupported and inert.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-055](#req-agent-055-pi-session-scoped-review-window), [REQ-AGENT-063](#req-agent-063-pr-boundary-candidate-detection), [REQ-AGENT-121](#req-agent-121-checked-out-branch-boundary-synchronization), [REQ-AGENT-132](#req-agent-132-pr-delivery-and-existing-head-consent)

**Verification:** Automated Pi and Claude boundary behavior tests

**Status:** Implemented

---

<a id="req-agent-122-downstream-merge-retry-and-recovery"></a>
### REQ-AGENT-122: Per-PR review checkpoints

**Intent:** Feature and integration PR reviews must retain independent incremental checkpoints without bookkeeping failures crashing either runtime.

**Applies To:** User

**Acceptance Criteria:**

1. Acknowledgement and enforcement counters are keyed by PR number in the normal checkout's Git metadata directory. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::statePath --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::ACK_FILE --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055: keeps acknowledgements isolated by pull request) -->
2. The acknowledgement for one PR never suppresses review of another PR at the same repository head. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::readAck --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::ACK_FILE --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055: keeps acknowledgements isolated by pull request) -->
3. Invalid, missing, or non-directory bookkeeping on an unsupported checkout remains inert or releases enforcement without throwing; after triage in a validated normal checkout, failure to persist the PR-specific acknowledgement blocks FIX so the incremental base is not lost. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::acknowledge --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::blockDecision --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::GIT_DIR --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::write_acknowledgement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-121/REQ-AGENT-122: rejects a nonstandard worktree without bookkeeping errors) --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (blocks FIX when the PR-specific acknowledgement cannot be persisted) -->
4. A valid legacy repository-global acknowledgement remains readable as a migration fallback. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::readAck --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::LAST_ACK_PR_HEAD --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-068: acknowledged current branch state stays inert) -->
5. New acknowledgements write only the PR-specific checkpoint. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::acknowledge --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::ACK_FILE --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-041: consumes a one-shot bypass and acknowledges the exact PR head) -->
6. A Claude PR-boundary lane binds its scope to that PR's acknowledged ancestor and current head, overriding a stale full-base argument. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/run-review-lane.sh::BOUNDARY_PR --> <!-- @test: host/__tests__/run-review-lane.test.js (normalizes a PR-boundary full-diff request to the acknowledged incremental range) -->
7. A Claude PR-boundary lane invoked for an already acknowledged head returns without invoking a model or opening a duplicate reviewer wave. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/run-review-lane.sh::BOUNDARY_ACK --> <!-- @test: host/__tests__/run-review-lane.test.js (does not invoke a model for an already acknowledged PR head) -->

**Constraints:**

- Checkpoints do not support detached or linked worktrees.
- Accounting never acknowledges an unreviewed head.
- A validated normal checkout never enters FIX unless its reviewed-head acknowledgement is readable after write.

**Priority:** P1

**Dependencies:** [REQ-AGENT-055](#req-agent-055-pi-session-scoped-review-window), [REQ-AGENT-119](#req-agent-119-bounded-settled-review-follow-ups)

**Verification:** Automated Pi and Claude review-enforcement tests

**Status:** Implemented

---

### REQ-AGENT-002: Agent Selection at Session Creation

**Intent:** Users must be able to choose which AI agent to use when creating a session.

**Applies To:** User

**Acceptance Criteria:**

1. `POST /api/sessions` accepts an optional `agentType` field in the request body. <!-- @impl: src/routes/session/crud.ts::CreateSessionBody --> <!-- @test: src/__tests__/routes/session-agent-type.test.ts (REQ-AGENT-002 AC2: POST /api/sessions accepts all seven valid agent types) -->
2. Invalid agent types are rejected at session creation. <!-- @impl: src/types.ts::AgentTypeSchema --> <!-- @test: src/__tests__/routes/session-agent-type.test.ts (REQ-AGENT-002 AC2: POST /api/sessions accepts all seven valid agent types) -->
3. The selected agent type is persisted in the session record. <!-- @test: src/__tests__/routes/session-agent-type.test.ts (REQ-AGENT-002: Agent Selection at Session Creation) --> <!-- @manual -->
4. The UI defaults to the agent type used in the user's most recent session. <!-- @test: src/__tests__/routes/session-agent-type.test.ts (REQ-AGENT-002: Agent Selection at Session Creation) --> <!-- @manual -->
5. When `agentType` is omitted, creation leaves a sparse record for installed Claude Code and otherwise records the first selectable coding agent or Bash. <!-- @impl: src/routes/session/crud.ts::app --> <!-- @test: src/__tests__/routes/session-agent-type.test.ts (REQ-AGENT-002 AC5: session created without agentType has no agentType field in response) --> <!-- @test: src/__tests__/routes/session-agent-allowlist.test.ts (REQ-AGENT-002 AC5: an omitted agentType falls back to the first installed coding agent) -->
6. The session-creation UI renders a `beta` badge on agents in preview status: `antigravity` and `opencode` carry the badge; all other agents (Claude Code, Codex, Copilot, Pi, Bash) render without one. <!-- @impl: web-ui/src/components/CreateSessionDialog.tsx::CreateSessionDialog --> <!-- @test: web-ui/src/__tests__/components/CreateSessionDialog.test.tsx (Agent type selection) -->
7. Session creation rejects a valid agent type whose shared launcher is omitted from the deployment image. <!-- @impl: src/routes/session/crud.ts::app --> <!-- @test: src/__tests__/routes/session-agent-allowlist.test.ts (REQ-AGENT-002 AC7: omitted agentType '%s' is rejected) -->

**Constraints:**

- Agent type is immutable after session creation (a new session is required to switch agents).
- The `bash` agent type provides a plain terminal without an AI agent.
- Enterprise session selection follows [REQ-ENTERPRISE-003](enterprise-mode.md#req-enterprise-003-agent-allowlist-in-enterprise-mode).

**Priority:** P0

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-123: Installed-agent runtime availability

**Intent:** Users can select and start only agents whose shared launchers exist in the deployed image.

**Applies To:** User

**Acceptance Criteria:**

1. Runtime availability intersects build-installed agents with any narrower deployment policy. <!-- @impl: src/lib/agent-allowlist.ts::allowedAgents --> <!-- @test: src/__tests__/routes/session-agent-allowlist.test.ts (REQ-AGENT-123 AC1: enterprise and build allowlists are intersected) -->
2. Malformed installed-agent configuration resolves to Bash only. <!-- @impl: src/lib/agent-allowlist.ts::installedAgents --> <!-- @test: src/__tests__/routes/session-agent-allowlist.test.ts (REQ-AGENT-123 AC2: malformed configuration fails closed to bash) -->
3. The user profile publishes the resolved creation set. <!-- @impl: src/routes/user-profile.ts::app --> <!-- @test: src/__tests__/routes/user-profile-enterprise.test.ts (REQ-AGENT-123 AC3: allowedAgents lists only build-installed agents plus bash) -->
4. Last-agent preference writes reject an agent whose launcher is omitted. <!-- @impl: src/routes/preferences.ts::app --> <!-- @test: src/__tests__/routes/preferences-enterprise.test.ts (REQ-AGENT-123 AC4: lastAgentType is rejected when its CLI is omitted from the image) -->
5. Starting a persisted session whose launcher is omitted fails before container startup. <!-- @impl: src/routes/container/lifecycle.ts::app --> <!-- @test: src/__tests__/routes/container/lifecycle.test.ts (REQ-AGENT-123 AC5: rejects starting a persisted session whose CLI is omitted from the image) -->

**Constraints:**

- Bash remains available without a coding-agent package.
- An absent installed-agent value preserves every supported agent for backward compatibility.
- A malformed installed-agent value fails closed to Bash.
- Every narrower policy intersects with the resolved installed set.

**Priority:** P1

**Dependencies:** [REQ-AGENT-002](#req-agent-002-agent-selection-at-session-creation), [REQ-OPS-040](operations.md#req-ops-040-selected-coding-agent-packaging), [REQ-ENTERPRISE-003](enterprise-mode.md#req-enterprise-003-agent-allowlist-in-enterprise-mode)

**Verification:** Automated API, profile, preference, and persisted-session tests

**Status:** Implemented

---

### REQ-AGENT-124: Agent-choice profile hydration

**Intent:** Session-creation surfaces expose no unverified launcher before profile hydration while remaining compatible with older user-profile responses.

**Applies To:** User

**Acceptance Criteria:**

1. The New Session dialog withholds every choice before profile hydration. <!-- @impl: web-ui/src/components/CreateSessionDialog.tsx::agentOptions --> <!-- @test: web-ui/src/__tests__/components/CreateSessionDialog.test.tsx (withholds every agent choice until /api/user hydrates) -->
2. The clone-into-new-session surface withholds every choice before profile hydration. <!-- @impl: web-ui/src/components/github/ClonePickerNewSession.tsx::agentOptions --> <!-- @test: web-ui/src/__tests__/components/ClonePicker.test.tsx (withholds new-session agent choices until /api/user hydrates) -->
3. After hydration, the New Session dialog renders only the resolved profile set. <!-- @impl: web-ui/src/components/CreateSessionDialog.tsx::agentOptions --> <!-- @test: web-ui/src/__tests__/components/CreateSessionDialog.test.tsx (renders only build-installed agents outside enterprise mode) -->
4. After hydration, the clone-into-new-session surface renders only the resolved profile set. <!-- @impl: web-ui/src/components/github/ClonePickerNewSession.tsx::agentOptions --> <!-- @test: web-ui/src/__tests__/components/ClonePicker.test.tsx (renders only build-installed agents outside enterprise mode) -->
5. A successful legacy non-enterprise profile without `allowedAgents` hydrates to the full catalog. <!-- @impl: web-ui/src/App.tsx::AppContent --> <!-- @test: web-ui/src/__tests__/components/enterprise-app-routing.test.tsx (REQ-AGENT-124: legacy profile agent fallback) -->
6. A successful legacy enterprise profile without `allowedAgents` hydrates to the enterprise catalog. <!-- @impl: web-ui/src/App.tsx::AppContent --> <!-- @test: web-ui/src/__tests__/components/enterprise-app-routing.test.tsx (REQ-AGENT-124: legacy profile agent fallback) -->

**Constraints:**

- `null` denotes only unresolved hydration.
- Legacy defaults apply only after a successful profile response omits the optional field.

**Priority:** P1

**Dependencies:** [REQ-AGENT-123](#req-agent-123-installed-agent-runtime-availability), [REQ-ENTERPRISE-003](enterprise-mode.md#req-enterprise-003-agent-allowlist-in-enterprise-mode)

**Verification:** Automated pre-hydration, resolved-set, and legacy-profile UI tests

**Status:** Implemented

---

### REQ-AGENT-003: Agent CLI Auto-Started in Tab 1

**Intent:** When a session starts, the selected agent's CLI must be running and ready in the first terminal tab without manual user intervention.

**Applies To:** User

**Acceptance Criteria:**

1. The container entrypoint configures the selected agent's launch command to run automatically when tab 1's shell starts. <!-- @impl: entrypoint.sh::configure_tab_autostart --> <!-- @test: host/__tests__/entrypoint-tab-autostart.test.js (AC1 dynamic: an agy (Antigravity) tab emits its launch command into .bashrc) -->
2. Claude Code starts in permissions-bypass mode appropriate for an isolated sandbox container. <!-- @impl: entrypoint.sh::configure_tab_autostart --> <!-- @test: host/__tests__/entrypoint-tab-autostart.test.js (AC1+AC2+AC4: default layout writes the claude --dangerously-skip-permissions launch line + hardened PATH into .bashrc) -->
3. User-opened tabs beyond tab 1 do not auto-start an agent. <!-- @impl: entrypoint.sh::configure_tab_autostart --> <!-- @test: host/__tests__/entrypoint-tab-autostart.test.js (AC3: generated .bashrc guards autostart with the MANUAL_TAB skip branch) -->
4. The agent CLI is findable on the system PATH in all terminal sessions. <!-- @impl: entrypoint.sh::configure_tab_autostart --> <!-- @test: host/__tests__/entrypoint-tab-autostart.test.js (AC1+AC2+AC4: default layout writes the claude --dangerously-skip-permissions launch line + hardened PATH into .bashrc) -->
5. First PTY output begins a fixed 1.5-second settlement period; readiness becomes true after that period so the initial terminal UI can render before opening. <!-- @impl: host/src/server.ts::PREWARM_SETTLE_MS --> <!-- @impl: host/src/server.ts::server.listen --> <!-- @manual: Observe first PTY output and confirm `/health` reports `prewarmReady: true` only after the fixed settlement period. -->
6. A 20-second hard timeout exists as a safety net if the PTY produces no output. <!-- @impl: host/src/server.ts::server.listen --> <!-- @manual -->

**Constraints:**

- Auto-update checks for agent CLIs are suppressed at session start to keep startup latency low.
- Each agent has its own mechanism for suppressing auto-updates.
- The autostart command must complete after the initial R2 sync but before bisync baseline to avoid hash mismatches.

**Priority:** P0

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents), [REQ-AGENT-002](#req-agent-002-agent-selection-at-session-creation), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-004: Two Session Modes: Standard and Pro

**Intent:** Users must be able to choose between a Standard mode (essential configs) and a Pro (Advanced) mode (full agent enhancement suite).

**Applies To:** User

**Acceptance Criteria:**

1. Session mode (Standard or Pro) is stored durably in the user's preferences record; the value is absent for users who have never expressed a preference. <!-- @test: src/__tests__/lib/session-mode.test.ts (clampSessionModeToTier / REQ-SEC-015 (AC2 clamp at container start + AC3 canceled-user stale advanced => default)) --> <!-- @manual -->
2. A single resolver provides the default-to-Standard fallback when no preference is recorded; all callers read through the resolver rather than checking the raw field directly. <!-- @impl: src/lib/session-mode.ts::resolveSessionMode --> <!-- @test: src/__tests__/lib/session-mode.test.ts (resolveSessionMode / REQ-AGENT-004 (two session modes: default and advanced; default when prefs unset; honors persisted sessionMode)) -->
3. Mode selection is available in Settings under the session-defaults area. <!-- @test: web-ui/src/__tests__/components/settings/SessionSection.test.tsx (REQ-AGENT-004 AC3: mode selection in Settings session-defaults) --> <!-- @manual -->
4. Mode takes effect on any of: explicit "Recreate AI agent skills & rules" action, new bucket creation, payment-provider mode change (upgrade or downgrade via webhook), subscription termination, or Settings toggle of the session-mode preference. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-004 AC4: overwrite:true writes all docs regardless of existing state (recreate button)) -->
5. On webhook-driven or Settings-driven reconciliation, preseed files are overwritten to match the new mode; user-created files are never deleted (see [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers) Constraints). <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-004 AC5: cleanup:true deletes advanced-only keys when switching to default mode) -->
6. Reconciliation triggered by webhooks or Settings is non-fatal: failure does not block the webhook response or the preference write. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-004 AC6: reconcileAgentConfigs is non-fatal when DELETE calls fail) -->

**Constraints:**

- Only tiers whose allowed-session-modes list includes Pro can use Pro mode (see [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier)).
- When a user is promoted to a Pro-eligible tier, Pro mode becomes their persisted default if they had not already selected a mode.

**Priority:** P1

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-005: Pro Mode Includes Additional Skills, Rules, Agents, and MCP Servers

**Intent:** Pro mode must provide a significantly enhanced agent experience over Standard - more rules, skills, agent definitions, commands, hooks, and persistent memory. Pi sessions remain fully functional whether or not context-mode is active. Pi's own default runtime behavior — context-mode enablement and tool-extension defaults — is specified separately in [REQ-AGENT-076](#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults).

**Applies To:** User

**Acceptance Criteria:**

1. Pro mode delivers a strict superset of Standard mode's content — memory persistence, language rules, agent definitions, slash commands, skills, the spec/docs/tests discipline triad, and commit-attribution/PR-boundary review hooks. The per-content-category matrix lives in [documentation/preseed.md](../../documentation/lanes/preseed.md#session-modes). <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-005 + REQ-AGENT-014: getConfigsForMode) --> <!-- @manual -->
2. Pro mode enables persistent memory by including the user's Vault directory tree in the R2 sync filters; Standard mode excludes the Vault tree, so memory does not persist across container restarts. The legacy `.memory/` directory is no longer written. <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-005 AC2: getConfigsForMode("advanced") returns docs for both default and advanced modes) --> <!-- @manual -->
3. Pro-mode hooks fire uniformly regardless of tool surface — Custom tier routes commands through context-mode, other tiers run them directly — so commit attribution, the PR-boundary SDD review trigger, the unreviewed-PR turn-block, and prompt-cadence memory capture all fire identically on both paths. <!-- @impl: entrypoint.sh::CONTEXT_MODE_MANIFEST --> <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-005 + REQ-AGENT-014: getConfigsForMode) -->
4. Pi agents remain fully functional whether or not context-mode is active: native Bash/Read/Grep/Find/Edit/Write plus graphify tools suffice alone. Agent definitions declare context-mode helpers under Pi-native names in frontmatter. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::commandText --> <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-005: Pi agents keep context-mode tool declarations (inert when off); enforcement extension is removed) -->

**Constraints:**

- Cleanup on mode switch is scoped strictly to preseed-managed content; user-created files are never deleted.

**Priority:** P1

**Dependencies:** [REQ-AGENT-004](#req-agent-004-two-session-modes-standard-and-pro), [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** Automated test ([r2-seed-mode-req-coverage](../../src/__tests__/lib/r2-seed-mode-req-coverage.test.ts))

**Status:** Implemented

---

### REQ-AGENT-006: Preseed Configs Generated from Single Source of Truth

**Intent:** Shared agent configuration is generated once, while harness-specific runtime assets retain one canonical owner and are never overwritten by transformed copies from another harness.

**Applies To:** User

**Acceptance Criteria:**

1. Every manifest-declared Pi target key has exactly one generated owner per applicable mode, and its emitted bytes equal that owner source. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (emits every manifest-declared Pi asset exactly once per mode with canonical bytes) -->
2. A declarative manifest maps each preseed file to its applicable session modes (default, advanced, or both). <!-- @impl: scripts/generate-agent-seed.mjs::validateModes --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) -->
3. A build-time seed generator reads the manifest and source files, producing the runtime payload the Worker ships to the container. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) -->
4. The generator ignores files absent from the manifest. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) -->
5. The generator produces output for all supported agents (Claude Code plus generated lanes for Codex, Copilot, OpenCode, Antigravity, and Pi). <!-- @impl: scripts/generate-agent-seed.mjs::AGENT_CONFIGS --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
6. Runtime-appropriate shared operational gate sections are present in every generated non-Claude instruction surface. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (preseeds runtime-appropriate continuity, push, and result handoff gates) -->

**Constraints:**

- The generated output must stay in sync with the manifest and sources; the build pipeline enforces this.
- The generated output is never hand-edited; updates go through the source tree and the generator.

**Priority:** P1

**Dependencies:** None.

**Verification:** Automated test ([Seed manifest tests](../../src/__tests__/lib/agent-seed-manifest.test.ts), [Pi-native review ownership tests](../../host/__tests__/pi-native-review-assets.test.js))

**Status:** Implemented

---

### REQ-AGENT-007: Multi-Agent Adaptation Pipeline

**Intent:** Each supported agent receives shared adapted configuration plus any manifest-declared native assets required by its runtime.

**Applies To:** User

**Acceptance Criteria:**

1. Every supported non-Claude agent receives an instruction document in both default and advanced modes. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (instructions files appear twice (one per mode, different content)) -->
2. Tool names are remapped per agent (e.g., `Read` -> `read` for Codex and Pi). <!-- @impl: scripts/generate-agent-seed.mjs::remapTools --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. Codex, Copilot, OpenCode, and Antigravity receive monolithic transformed instructions, while Pi receives one compact `AGENTS.md` plus grouped native skills for canonical path-scoped rules. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: src/__tests__/lib/pi-compact-context.test.ts (REQ-AGENT-007/REQ-AGENT-095: compact Pi context generated from the Claude canon) -->
4. Every Pi manifest entry is emitted once in each declared mode with bytes equal to its canonical Pi source. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (emits every manifest-declared Pi asset exactly once per mode with canonical bytes) -->

**Constraints:**

- Hooks, commands, and plugins are excluded from generic transformed agents.
- `rules/memory.md` and `consult-llm` skill are excluded from non-CC agents (they depend on CC-specific MCP).
- Generic non-CC agents get a strictly-smaller config than Claude Code, since CC is the source-of-truth lane and those agents drop CC-specific content.
- Antigravity (`agy`) receives an adapted lane written to its global config directory `~/.gemini/`: rules concatenate into `~/.gemini/GEMINI.md`, skills into `~/.gemini/skills/`.
- The per-agent format transforms (frontmatter shape, removed fields, path rewrites, file extensions) live in [REQ-AGENT-030](#req-agent-030-multi-agent-format-transforms).

**Priority:** P1

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-008: Preseed Deployed to Container on Start

**Intent:** Preseed files must be available in the container's filesystem when the agent launches so that rules, skills, and agent definitions are active from the first prompt.

**Applies To:** User

**Acceptance Criteria:**

1. On first bucket creation, mode-appropriate preseed files are written to the user's R2 bucket without overwriting any existing objects and without removing anything. <!-- @impl: src/lib/r2-seed.ts::seedAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-004 AC4: overwrite:false skips existing R2 objects (new-bucket path)) -->
2. During container startup, the initial R2-to-local sync restores preseed files into each supported agent's per-user config directory before the agent launches. <!-- @impl: entrypoint.sh::initial_sync_from_r2 --> <!-- @test: src/__tests__/lib/r2-seed.test.ts (seedAgentConfigs / REQ-AGENT-008 (preseed deployed to container on start) / REQ-STOR-010 (reconcileAgentConfigs deletes orphaned seed entries on tier change)) -->

**Constraints:**

- All file modifications must complete after initial sync but before bisync baseline so the baseline observes a stable snapshot.

**Priority:** P0

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-099: Agent Settings and Plugins Assembled at Container Start

**Intent:** Once the preseed files are on disk, the container entrypoint must assemble each agent's settings and plugin configuration so codeflare-owned hooks and plugins are active from the first prompt without discarding anything the user added in a previous session.

**Applies To:** User

**Acceptance Criteria:**

1. The container entrypoint merges agent settings using a hooks-aware merge: non-hook fields use recursive merge; hook arrays are rebuilt per event type by preserving user-added hooks and replacing managed (codeflare-owned) hooks with the current platform version. <!-- @impl: entrypoint.sh::SETTINGS_CONFIG --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (settings.json configuration / REQ-AGENT-015 (/review command)) -->
2. In Pro mode, the settings merge includes the codeflare-owned hook registrations across the PreToolUse, PostToolUse, and UserPromptSubmit event families; Standard mode omits them. <!-- @impl: entrypoint.sh::SETTINGS_CONFIG --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (settings.json configuration / REQ-AGENT-015 (/review command)) -->
3. The container entrypoint enables the codeflare-managed plugins in the agent's plugin configuration permanently (not mode-gated). Missing plugin files are silently skipped so a plugin removal does not break agent startup. <!-- @impl: entrypoint.sh::PLUGINS_CONFIG --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (plugin enablement) -->
4. Settings merge handles three cases: file doesn't exist (create), file exists (recursive merge), file malformed (skip with warning). <!-- @impl: entrypoint.sh::SETTINGS_FILE --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (settings.json configuration / REQ-AGENT-015 (/review command)) -->
5. Both session modes disable the full-screen agent view, so background agents never replace the terminal with it. <!-- @impl: entrypoint.sh::SETTINGS_CONFIG --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (both SETTINGS_CONFIG literals disable agent view) -->
6. A registration whose target this release retires counts as managed and is removed by the merge, so retiring the object cannot leave a command pointing at a missing file, while a user-authored hook on the same event is untouched. <!-- @impl: entrypoint.sh::SETTINGS_CONFIG --> <!-- @test: host/__tests__/entrypoint-enforce-ctx-mode-dedup.test.js (prunes the bare-path cache-heal registration) --> <!-- @test: host/__tests__/entrypoint-enforce-ctx-mode-dedup.test.js (retires every persisted graphify SessionStart registration) --> <!-- @test: host/__tests__/entrypoint-enforce-ctx-mode-dedup.test.js (keeps a user-authored SessionStart hook while pruning it) -->

**Constraints:**

- Plugin enablement is permanent.
- The managed-hook detector uses a codeflare-owned namespace prefix so unrelated workspace tools with identical script basenames cannot be falsely flagged as managed.
- The managed-hook surface set is the spec-side single source of truth; adding a new codeflare hook requires extending the detector or prior copies accumulate on every container boot instead of being replaced.

**Priority:** P0

**Dependencies:** [REQ-AGENT-008](#req-agent-008-preseed-deployed-to-container-on-start)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-009: LLM API Key Storage (Encrypted in KV)

**Intent:** Users must be able to store LLM provider API keys so that cross-model consultation features work without re-entering keys each session.

**Applies To:** User

**Acceptance Criteria:**

1. Users can store one or both supported LLM provider keys (OpenAI and Gemini) through a single management endpoint. <!-- @impl: src/routes/llm-keys.ts::validateOpenAIKey --> <!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes / REQ-AGENT-020 (LLM API key storage) / REQ-AGENT-009 (LLM API Key Storage endpoint shape, KV path, encryption-at-rest, masking, GET behaviour)) -->
2. The update interface supports three semantics per key: a new value replaces, an explicit null deletes, an absent field leaves the existing value unchanged. <!-- @impl: src/routes/llm-keys.ts::app --> <!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes / REQ-AGENT-020 (LLM API key storage) / REQ-AGENT-009 (LLM API Key Storage endpoint shape, KV path, encryption-at-rest, masking, GET behaviour)) -->
3. Keys are persisted in durable storage scoped to the user's bucket so two users cannot read each other's keys. <!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes / REQ-AGENT-020 (LLM API key storage) / REQ-AGENT-009 (LLM API Key Storage endpoint shape, KV path, encryption-at-rest, masking, GET behaviour)) --> <!-- @manual -->
4. When platform-level credential encryption is configured, values are encrypted before persistence. <!-- @impl: src/lib/kv-crypto.ts::encryptAndStore --> <!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes / REQ-AGENT-020 (LLM API key storage) / REQ-AGENT-009 (LLM API Key Storage endpoint shape, KV path, encryption-at-rest, masking, GET behaviour)) -->
5. Read responses return masked values (only the trailing characters are visible); the full key is never returned to the client. <!-- @impl: src/routes/llm-keys.ts::app --> <!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes / REQ-AGENT-020 (LLM API key storage) / REQ-AGENT-009 (LLM API Key Storage endpoint shape, KV path, encryption-at-rest, masking, GET behaviour)) -->

**Constraints:**

- Encryption follows the cryptographic contract in [REQ-SEC-004](security.md#req-sec-004-credential-encryption-at-rest-cryptographic-contract).
- The ciphertext carries a version prefix so future schemes can be added without breaking reads.
- Plaintext values are transparently upgraded to encrypted on read when encryption is configured.
- Propagation to the container env + MCP wiring live in [REQ-AGENT-031](#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity).
- Unavailable in enterprise mode: every method on `/api/llm-keys` returns 403.

**Priority:** P1

**Dependencies:** [REQ-SEC-004](security.md#req-sec-004-credential-encryption-at-rest-cryptographic-contract)

**Verification:** Automated test ([llm-keys](../../src/__tests__/routes/llm-keys.test.ts))

**Status:** Implemented

---

### REQ-AGENT-010: Deploy Credential Storage (GitHub PAT, CF API Token)

**Intent:** Users must be able to store GitHub and Cloudflare credentials so that git push, repository management, and Cloudflare deployments work without re-authenticating each session.

**Applies To:** User

**Acceptance Criteria:**

1. Tokens are validated against the provider's own API before being stored, so an invalid or expired token is rejected up front rather than discovered at use time. <!-- @impl: src/routes/deploy-keys.ts::app --> <!-- @test: src/__tests__/routes/deploy-keys.test.ts (Deploy Keys routes / REQ-AGENT-018 (deploy credential storage)) -->
2. Read responses return masked tokens; the full value is never returned to the client. <!-- @impl: src/routes/deploy-keys.ts::app --> <!-- @test: src/__tests__/routes/deploy-keys.test.ts (Deploy Keys routes / REQ-AGENT-018 (deploy credential storage)) -->
3. Users can clear all stored deploy credentials in a single action. <!-- @test: src/__tests__/routes/deploy-keys.test.ts (Deploy Keys routes / REQ-AGENT-018 (deploy credential storage)) --> <!-- @manual -->
4. Deploy credentials are persisted in durable storage scoped to the user's bucket and are encrypted at rest when platform-level credential encryption is configured. <!-- @impl: src/lib/kv-crypto.ts::encryptAndStore --> <!-- @test: src/__tests__/routes/deploy-keys.test.ts (Deploy Keys routes / REQ-AGENT-018 (deploy credential storage)) -->

**Constraints:**

- Tokens are validated against the provider's API before being persisted; an unreachable provider is surfaced as an upstream error and the credential is not stored, so the store never contains a token of unknown validity.

**Priority:** P1

**Dependencies:** [REQ-SEC-004](security.md#req-sec-004-credential-encryption-at-rest-cryptographic-contract)

**Verification:** Automated test ([deploy-keys](../../src/__tests__/routes/deploy-keys.test.ts))

**Status:** Implemented

---

### REQ-AGENT-011: Agent Skills & Rules Manually Recreatable from Settings

**Intent:** Users must be able to reset their agent skills and rules to the platform defaults at any time, recovering from accidental deletion or corruption.

**Applies To:** User

**Acceptance Criteria:**

1. A "Recreate AI agent skills & rules" action in the settings UI triggers a reseed of preseed-managed agent configuration. <!-- @test: src/__tests__/routes/storage-seed.test.ts (Agent Config Seed Routes / REQ-AGENT-011 (skills/rules manually recreatable)) --> <!-- @manual -->
2. The reseed performs a full overwrite-and-cleanup of all preseed-managed files for the user's current session mode. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @manual -->
3. Overwrite replaces every preseed-managed file with the current default content. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/routes/storage-seed.test.ts (Agent Config Seed Routes / REQ-AGENT-011 (skills/rules manually recreatable)) -->
4. Cleanup removes preseed-managed files that are not part of the user's current session mode. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @manual -->
5. User-created files (files not generated by the preseed pipeline) are never overwritten or deleted. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @manual -->
6. The endpoint is rate-limited (3/min). <!-- @test: src/__tests__/routes/storage-seed.test.ts (Agent Config Seed Routes / REQ-AGENT-011 (skills/rules manually recreatable)) --> <!-- @manual -->
7. After seeding, the storage stats KV cache is invalidated. <!-- @test: src/__tests__/routes/storage-seed.test.ts (Agent Config Seed Routes / REQ-AGENT-011 (skills/rules manually recreatable)) --> <!-- @manual -->

**Constraints:**

- Cleanup uses explicit key lists, not bucket listing or prefix scans.
- Partial delete failures produce warnings but do not fail the overall operation.
- Container must perform a bisync cycle to pull the updated R2 files into the local filesystem.
- Starter-documentation recreation lives in [REQ-AGENT-032](#req-agent-032-starter-documentation-manually-recreatable-from-settings).

**Priority:** P1

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-STOR-010](storage.md#req-stor-010-agent-configs-auto-seeded-based-on-session-mode)

**Verification:** Automated test ([storage-seed](../../src/__tests__/routes/storage-seed.test.ts))

**Status:** Implemented

---

### REQ-AGENT-012: Fast CLI Start (Configurable)

**Intent:** Agent CLIs must start quickly by default, with an option for users who want automatic updates.

**Applies To:** User

**Acceptance Criteria:**

1. A fast-start preference (default: enabled) controls whether agent CLIs skip auto-update checks at launch, and the user's choice is propagated into the container's runtime environment. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/routes/preferences.test.ts (sessionMode preference / REQ-MEM-011 (sessionMode preference persistence + preseed reconciliation)) -->
2. When enabled, Codeflare applies the supported environment-based update suppressors before agent startup. <!-- @impl: entrypoint.sh::configure_fast_start_environment --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (REQ-AGENT-012: Fast Start controls Pi update suppression and the disabled update path) -->
3. Codeflare removes only its own settings-file suppressor and preserves an operator-owned Codex version preference. <!-- @impl: entrypoint.sh::configure_fast_start_tool_settings --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (REQ-AGENT-012: disabled Fast Start removes only Codeflare-managed settings suppressors) -->
4. When disabled, environment suppressors are cleared, Codeflare's Codex suppressor is removed, and Pi's normal update path runs before session startup. <!-- @impl: entrypoint.sh::configure_fast_start_environment --> <!-- @impl: entrypoint.sh::configure_fast_start_tool_settings --> <!-- @impl: entrypoint.sh::update_pi_when_fast_start_disabled --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (REQ-AGENT-012: Fast Start controls Pi update suppression) -->
5. Users can toggle the preference from the session defaults area of the application settings. <!-- @test: src/__tests__/routes/preferences.test.ts (Preferences Routes) --> <!-- @manual -->

**Constraints:**

- Codex `~/.codex/` directory is excluded from sync, so `version.json` is safe to recreate on every start.
- Restored user-added Pi packages outside the Codeflare image cache may require Fast Start OFF once so Pi can reconcile package state.

**Priority:** P1

**Dependencies:** [REQ-AGENT-003](#req-agent-003-agent-cli-auto-started-in-tab-1)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-013: Browser Shim for OAuth Flows

**Intent:** Agent CLIs that attempt to open a browser for OAuth must degrade gracefully to printing clickable URLs in the terminal.

**Applies To:** User

**Acceptance Criteria:**

1. A browser-shim is installed in the container that intercepts browser-launch attempts and exits with a non-zero code, causing the calling CLI to fall back to plain-text URL output. <!-- @test: host/__tests__/dockerfile-browser-shim-behavior.test.js (Dockerfile browser-shim behavior (real) / REQ-AGENT-013 (browser-shim intercepts launch and exits non-zero)) --> <!-- @manual -->
2. The XDG browser-launch entry-point is similarly shimmed so any tool that bypasses the BROWSER convention also degrades to text output. <!-- @test: host/__tests__/dockerfile-browser-shim-behavior.test.js (Dockerfile browser-shim behavior (real) / REQ-AGENT-013 (browser-shim intercepts launch and exits non-zero)) --> <!-- @manual -->
3. CLIs fall back to printing auth URLs as plain text in the PTY when the browser fails to open. <!-- @test: host/__tests__/dockerfile-browser-shim-behavior.test.js (Dockerfile browser-shim behavior (real) / REQ-AGENT-013 (browser-shim intercepts launch and exits non-zero)) --> <!-- @manual -->
4. The xterm.js link provider detects URLs in terminal output and makes them clickable, joining continuation rows for URLs that span multiple terminal rows so long OAuth URLs on narrow or mobile-keyboard-shrunk viewports are assembled and offered in full, never truncated mid-URL. <!-- @impl: web-ui/src/lib/terminal-link-provider.ts::registerMultiLineLinkProvider --> <!-- @impl: web-ui/src/stores/terminal-url-detection.ts::getLastUrlFromBuffer --> <!-- @test: web-ui/src/__tests__/stores/terminal-url-detection.test.ts (joins a long OAuth URL whose tail wraps past the viewport edge (no truncation)) -->

**Constraints:**

- The shim must not block or hang; it must exit immediately with a non-zero code.
- All CLI tools that attempt browser-based OAuth (Claude Code, OpenCode, Antigravity) must be covered.
- The number of continuation rows joined per logical line is bounded by a fixed cap so the periodic buffer scan cannot walk an unbounded scrollback.

**Priority:** P1

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents)

**Verification:** Automated test ([terminal-url-detection](../../web-ui/src/__tests__/stores/terminal-url-detection.test.ts))

**Status:** Implemented

---

### REQ-AGENT-014: Manifest-Driven Preseed Pipeline

**Intent:** The preseed system must use a declarative manifest to control which files are included, their mode assignments, and their target agents, ensuring auditable and reproducible builds.

**Applies To:** User

**Acceptance Criteria:**

1. A single declarative manifest is the source of truth for all preseed files and their session-mode assignments. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) --> <!-- @manual -->
2. The manifest organizes entries by type: rules (including the discipline triad: spec-discipline, documentation-discipline, tdd-discipline), agents, commands, skills (including SDD scaffolding templates), and plugins (memory and hook plugins). <!-- @impl: preseed/agents/claude/manifest.json::plugins/codeflare-hooks --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. Each entry declares the session modes (default, advanced, or both) it applies to. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) --> <!-- @manual -->
4. The seed generator is manifest-driven and ignores files not in the manifest. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
5. The generator produces a runtime payload the Worker consumes at session start. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
6. Within a single mode, no two preseed entries may share the same storage key. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) --> <!-- @manual -->
7. Variant-per-mode keys (same storage key, different content per mode) are excluded from cleanup when the mode changes. <!-- @impl: src/lib/r2-seed.ts::deleteNonModeConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode-req-coverage.test.ts (REQ-AGENT-014 AC7: variant-per-mode keys excluded from cleanup (key exists in target mode)) -->

**Constraints:**

- All preseed file additions, removals, and re-categorizations flow through the manifest.
- The generated output is a build artifact and is never hand-edited.

**Priority:** P1

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-100: Pi Rule-Transform Membership Validation

**Intent:** A Claude rule that is renamed or merged must fail the build rather than silently stop being excluded from Pi's instructions.

**Applies To:** Agent

**Acceptance Criteria:**

1. Every key in a Pi rule-transform collection resolves to a rule present in the Claude source set. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: host/__tests__/pi-rule-transform-membership.test.js (every Pi rule-transform key resolves to a Claude rule in the shipped tree) -->
2. A key that resolves to nothing fails generation and names both the missing rule and the collection holding it. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: host/__tests__/pi-rule-transform-membership.test.js (fails generation when a compacted rule no longer exists) -->

**Constraints:**

- Directory-shaped keys match by path prefix, mirroring the lookup they drive.
- Rule-transform collections name Claude rules by path, so renaming or merging a rule must update every collection referencing it in the same change.

**Priority:** P1

**Dependencies:** [REQ-AGENT-014](#req-agent-014-manifest-driven-preseed-pipeline)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-015: /review command for multi-perspective codebase review

**Intent:** Comprehensive code review using specialized AI agents catches issues a single reviewer would miss.

**Applies To:** User

**Acceptance Criteria:**

1. `/review` launches the six existing specialist roles (security, architecture, code quality, dead code, test gaps, documentation) in one parallel wave. <!-- @manual: Run `/review --diff --deep` on a clean fixture branch; observe one parallel wave of the six existing specialist types followed by Reality Filter, confirm every subagent returns a report without changing `git status`, and confirm only the root writes review artifacts or applies an explicitly approved fix. -->
2. The complete specialist reports are cross-referenced and deduplicated. <!-- @manual -->
3. Canonical findings are filtered against accepted architecture decisions. <!-- @manual -->
4. A sequential Reality Filter evaluates every still-active finding. <!-- @manual -->
5. Optional external verification covers HIGH and CRITICAL findings. <!-- @manual -->

**Constraints:**

- On Claude this workflow ships as the `commands/review.md` slash command; on Pi (where Claude slash commands do not deploy) the same workflow is delivered through the dedicated Pi-native `review` skill injected by the `/review` command handler, per [REQ-AGENT-050](#req-agent-050-pi-native-review-workflow-skill).
- Report persistence, interactive triage, and mutation ownership live in [REQ-AGENT-088](#req-agent-088-user-invoked-review-ownership-and-triage).

**Priority:** P1

**Dependencies:** None.

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-017: Bubblewrap sandbox for Codex

**Intent:** Codex agent runs in a bubblewrap sandbox for additional isolation within the container.

**Applies To:** User

**Acceptance Criteria:**

1. bubblewrap (bwrap) is installed in the container image. <!-- @impl: Dockerfile::bubblewrap --> <!-- @manual -->
2. bubblewrap is available on the system PATH for Codex's built-in sandbox; the sandbox invocation is owned by the upstream Codex CLI, not by codeflare source. <!-- @impl: Dockerfile::bubblewrap --> <!-- @manual -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-018: Push & Deploy credential management UI

**Intent:** Users connect their GitHub and Cloudflare accounts through a visual interface — OAuth, with no CLI commands and no manual token paste.

**Applies To:** User

**Acceptance Criteria:**

1. The Settings "Push & Deploy" accordion presents one shared OAuth connect card per provider (GitHub, Cloudflare) — the same composable card reused by the dashboard panel and Guided Setup ([REQ-GITHUB-007](github.md#req-github-007-broaden-the-panel-gate-beyond-enterprise), [REQ-AGENT-064](#req-agent-064-connect-to-cloudflare-via-oauth)). <!-- @impl: web-ui/src/components/settings/DeployKeysSection.tsx::DeployKeysSection --> <!-- @test: web-ui/src/__tests__/components/settings/DeployKeysSection.test.tsx (DeployKeysSection (OAuth connect surface)) -->
2. Connecting runs the provider OAuth flow (no manual token entry); the per-user token is stored encrypted server-side and never reaches the browser, and disconnect revokes + clears it. <!-- @impl: src/lib/kv-crypto.ts::encryptAndStore --> <!-- @test: src/__tests__/routes/deploy-keys.test.ts (Deploy Keys routes / REQ-AGENT-018 (deploy credential storage)) -->
3. A connected card shows the account identity and (Cloudflare) an account picker; a scope tier can be selected before connecting. <!-- @impl: web-ui/src/components/connect/OAuthConnectCard.tsx::OAuthAccountOption --> <!-- @test: web-ui/src/__tests__/components/connect/OAuthConnectCard.test.tsx (OAuthConnectCard) -->
4. Deploy credentials are propagated into the container environment so the agent CLIs can authenticate to GitHub and Cloudflare without additional configuration. <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) --> <!-- @manual -->

**Constraints:**

- Must comply with [CON-SEC-003](constraints.md#con-sec-003-credentials-encrypted-at-rest-when-encryption_key-configured)

**Priority:** P1

**Dependencies:** [REQ-AGENT-010](#req-agent-010-deploy-credential-storage-github-pat-cf-api-token)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-019: Branded settings UI

**Intent:** Professional, intuitive settings panel for managing all user preferences and credentials.

**Applies To:** User

**Acceptance Criteria:**

1. Settings panel uses accordion groups (appearance, session, deploy, LLM, admin). <!-- @impl: web-ui/src/components/SettingsPanel.tsx::ACCORDION_SUBTITLES --> <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (SettingsPanel Component / REQ-AGENT-019 (branded settings UI)) -->
2. Provider rows with SVG brand icons and inline expansion. <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (renders OpenAI and Gemini provider rows) --> <!-- @manual -->
3. Appearance section with accent color picker. <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (SettingsPanel Component / REQ-AGENT-019 (branded settings UI)) --> <!-- @manual -->
4. Session section with a session-mode toggle and a sleep-timeout select; agent type is chosen at session creation, not here. <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (SettingsPanel Component / REQ-AGENT-019 (branded settings UI)) --> <!-- @manual -->

**Constraints:**

None.

**Priority:** P2

**Dependencies:** None.

**Verification:** Automated test ([SettingsPanel](../../web-ui/src/__tests__/components/SettingsPanel.test.tsx))

**Status:** Implemented

---

### REQ-AGENT-020: LLM API key management UI

**Intent:** Users can store their OpenAI and Gemini API keys through a visual interface.

**Applies To:** User

**Acceptance Criteria:**

1. Settings panel has LLM Keys section with masked password inputs for OpenAI and Gemini. <!-- @impl: src/routes/llm-keys.ts::app --> <!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes / REQ-AGENT-020 (LLM API key storage) / REQ-AGENT-009 (LLM API Key Storage endpoint shape, KV path, encryption-at-rest, masking, GET behaviour)) -->
2. Keys validated before saving. <!-- @test: src/__tests__/routes/llm-keys.test.ts (LLM Keys routes / REQ-AGENT-020 (LLM API key storage) / REQ-AGENT-009 (LLM API Key Storage endpoint shape, KV path, encryption-at-rest, masking, GET behaviour)) --> <!-- @manual -->
3. One clear-all button clears both keys through the management endpoint and updates the local controls only after success. <!-- @impl: web-ui/src/components/settings/LlmKeysSection.tsx::handleClearAll --> <!-- @test: web-ui/src/__tests__/components/settings/LlmKeysSection.test.tsx (LlmKeysSection / REQ-AGENT-020) -->
4. Keys are displayed using only the masks returned by the server, never the submitted full values. <!-- @impl: web-ui/src/components/settings/LlmKeysSection.tsx::LlmKeysSection --> <!-- @test: web-ui/src/__tests__/components/settings/LlmKeysSection.test.tsx (LlmKeysSection / REQ-AGENT-020) -->
5. Initial key loading distinguishes pending, failed, successful disconnected, and successful connected states. Editable disconnected controls appear only after a successful load, and a failed load offers retry through the same API. <!-- @impl: web-ui/src/components/settings/LlmKeysSection.tsx::loadKeys --> <!-- @test: web-ui/src/__tests__/components/settings/LlmKeysSection.test.tsx (LlmKeysSection / REQ-AGENT-020) -->

**Constraints:**

- Must comply with [CON-SEC-003](constraints.md#con-sec-003-credentials-encrypted-at-rest-when-encryption_key-configured)
- Hidden in enterprise mode: the Settings "LLM API Keys" section is not rendered, matching the 403 backend gate (see [REQ-AGENT-031](#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity) AC6).

**Priority:** P1

**Dependencies:** [REQ-AGENT-009](#req-agent-009-llm-api-key-storage-encrypted-in-kv)

**Verification:** Automated test ([llm-keys](../../src/__tests__/routes/llm-keys.test.ts))

**Status:** Implemented

---

### REQ-AGENT-021: Pro-Mode SDD Workflow Preseed and Tool-Surface Portability

**Intent:** Pro users need the spec-driven-development workflow available out of the box, with every sub-command working through the native shell/file tools available in the active runtime so the workflow still works when context-mode is absent.

**Applies To:** User

**Acceptance Criteria:**

1. Pro mode preseeds the `spec-driven-development`, `sdd-init`, `sdd-clean`, `vault-operations`, and `ci-monitoring` skills; `/sdd`; and the `spec-reviewer` and `doc-updater` agents. Claude receives the `spec-discipline`, `documentation-discipline`, and `tdd-discipline` rules ambiently; Pi receives the same policy through grouped skills without duplicate ambient copies. <!-- @impl: scripts/generate-agent-seed.mjs::PI_COVERED_RULES --> <!-- @test: src/__tests__/lib/pi-compact-context.test.ts (uses one existing canonical skill instead of generating duplicate covered rules) --> <!-- @test: src/__tests__/lib/agent-seed-ecc-rules.test.ts (ECC rules in agent-seed) --> <!-- @manual: Invoke `/sdd init` in a clean fixture without `sdd/`, then `/sdd clean --auto` after introducing spec drift; confirm both remain in the root session, launch no PR reviewer, and execute specification enforcement before documentation enforcement. -->
2. Every `/sdd` sub-command (`init`, `edit`, `add`, `clean`, `mode`) works in Pi without context-mode by using native Bash/Read/Grep/Find/Write/Edit tools; context-management helper tools, when present in another runtime, are optional rather than required. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
3. Large discovery commands use Pi-native discovery tools when context-mode is absent. <!-- @impl: scripts/generate-agent-seed.mjs::PI_SDD_COMPATIBILITY_NOTE --> <!-- @manual -->
4. Pi-transformed SDD skills use Pi-native graphify tools and `Agent`/`Plan` terminology. <!-- @impl: scripts/generate-agent-seed.mjs::PI_SDD_COMPATIBILITY_NOTE --> <!-- @manual -->
5. The native `/sdd` command enforces command-file hard gates before workflow dispatch. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::sddRepoState --> <!-- @impl: preseed/agents/pi/extensions/sdd-helpers.ts::sddCommandDecision --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (native /sdd hard gates / REQ-AGENT-021 AC5 (the native /sdd command enforces command-file hard gates before workflow dispatch)) -->
6. `/sdd init` and `/sdd clean` are root-session mutation workflows and do not dispatch PR-boundary reviewer agents. <!-- @impl: preseed/agents/pi/extensions/sdd-helpers.ts::sddWorkflowExecutionText --> <!-- @impl: preseed/agents/claude/commands/sdd.md::Execution ownership (binding) --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-021/REQ-AGENT-037: keeps SDD mutation workflows in the root session) -->
7. `/sdd init` and `/sdd clean` run required specification and documentation enforcement inline in that order. <!-- @impl: preseed/agents/pi/extensions/sdd-helpers.ts::rootSddExecution --> <!-- @impl: preseed/agents/claude/skills/sdd-clean/SKILL.md::Execution ownership (binding) --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-021/REQ-AGENT-037: keeps SDD mutation workflows in the root session) -->

**Constraints:**

- CI-monitoring launch, reporting, and non-blocking wait policy lives in [REQ-AGENT-068](#req-agent-068-independent-pi-ci-monitoring).
- `/sdd init` scaffolding lives in [REQ-AGENT-033](#req-agent-033-sdd-init-scaffolding-and-canonical-render); enrichment lives in [REQ-AGENT-034](#req-agent-034-sdd-init-enrichment-pass-with-graphify).
- Phase 7a / 7b verifier gates live in [REQ-AGENT-035](#req-agent-035-sdd-init-phase-7a-source-anchor-verifier-gate) and [REQ-AGENT-039](#req-agent-039-sdd-init-phase-7b-enumeration-coverage-verifier-gate).
- PR-boundary review lives in [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions); `/sdd clean` rescue lives in [REQ-AGENT-037](#req-agent-037-sdd-clean-rescue-and-autonomy-modes).

**Priority:** P1

**Dependencies:** [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers), [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-AGENT-007](#req-agent-007-multi-agent-adaptation-pipeline), [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify), [REQ-AGENT-025](#req-agent-025-post-clone-graph-triage)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-022: Legacy-codebase Import Mode Discovery

**Intent:** Enterprises migrating a legacy codebase from manual development to autonomous agentic development need a transition path that converts un-extracted intent into a real spec. `/sdd init` Import Mode runs discovery against the full project history and produces two outputs from the same pass: official REQs for behavior clear from that surface, and a triage queue for everything unclear. The triage entry shape, transition gate, and Status semantics live in [REQ-AGENT-045](#req-agent-045-import-mode-triage-queue-and-transition-state), [REQ-AGENT-092](#req-agent-092-import-transition-review-suppression), and [REQ-AGENT-093](#req-agent-093-import-mode-tdd-status-assignment).

**Applies To:** User

**Acceptance Criteria:**

1. `/sdd init` Import Mode emits two outputs simultaneously: spec REQs in `sdd/{domain}.md` for anything clearly determinable from the full discovery surface, and triage entries in `sdd/.init-triage.md` for anything unclear. <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh - SDD transition gate (REQ-AGENT-022)) --> <!-- @manual -->
2. The discovery surface during Import Mode is the full project history, not just source code. <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh - SDD transition gate (REQ-AGENT-022)) --> <!-- @manual -->
3. The agent pulls evidence from the working tree (README, configs, source, tests, inline comments, ADR-shaped files) and git history (commit messages on entry-point files, tag annotations). <!-- @manual -->
4. When a GitHub remote is detected, the agent additionally pulls pull requests with their review comments and inline threads, issues open and closed with their comments, release notes, and the wiki via the GitHub API. <!-- @manual -->
5. When one artifact references another ("Closes #142"), the agent follows the chain backward through every linked artifact rather than stopping at the first hit. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Traverse linked artifacts backward recursively --> <!-- @manual -->
6. When the GitHub corpus is unreachable, the agent skips GitHub sources and proceeds with working-tree + git-log evidence only; a one-line notice naming the reason is printed before scaffolding and appended to the `sdd/changes.md` import entry. <!-- @test: host/__tests__/git-push-review-reminder.test.js (git-push-review-reminder.sh - SDD transition gate (REQ-AGENT-022)) --> <!-- @manual -->

**Constraints:**

- GitHub-corpus evidence collection uses `gh pr list --state all`, `gh pr view {n} --comments`, `gh issue list --state all`, `gh issue view {n} --comments`, `gh release list`, and `gh release view {tag}`.

**Priority:** P1

**Dependencies:** [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-023: Knowledge-Graph Capability (Graphify)

**Intent:** Every container ships the graphify code-knowledge-graph capability as ambient infrastructure, so any session (default or advanced session mode) can query an existing graph or build a new one without per-tier provisioning.

**Applies To:** Agent

**Acceptance Criteria:**

1. `graphifyy` installs in every container image with MCP, SQL, and PDF extras, pinned to one tracked version; the entrypoint restores its command path when missing without replacing an existing destination. <!-- @impl: Dockerfile::graphifyy --> <!-- @impl: entrypoint.sh::ensure_graphify_cli_path --> <!-- @test: host/__tests__/entrypoint-runtime-behavior.test.js (REQ-AGENT-023: restores a missing Graphify CLI path without replacing an existing destination) -->
2. Claude receives the Graphify MCP server, while Pi receives native `graphify_query`/`graphify_path`/`graphify_explain` tools; both use the upstream engine. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-mcp-lazy.py::LazyGraph --> <!-- @impl: preseed/agents/pi/extensions/graphify-native.ts::graphify_query --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (REQ-AGENT-023: Pi native runtime assets expose first-party graphify-native tools (no MCP, no third-party wrapper)) -->
3. AC1 and AC2 hold across all paid tiers for ambient query/build capability; advanced-mode agent orchestration keeps `/graphify` extraction context bounded via subagent chunking. <!-- @impl: Dockerfile::graphifyy --> <!-- @impl: preseed/agents/pi/skills/graphify/SKILL.md::subagent --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
4. Startup with no graph is tolerated: Claude starts empty and rebinds later; advanced-mode Pi clone triage asks before graph work. Query tools use the active repo graph after it exists. <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::graphifyCloneAction --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::fallbackGraphifyToolResult --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
5. Advanced mode tracks the active repository; resolution walks up to the nearest Git repo or graph artefact and understands command-local `cd ... &&` plus `git -C ...` forms. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::effectivePathForCommand --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::updateActiveRepoFromPath --> <!-- @test: host/__tests__/graphify-active-repo.test.js (graphify-active-repo.sh / REQ-VAULT-004 (unified global graph merges vault + active repos)) -->
6. When the active-repo signal is absent or stale, Pi graphify query tools fall back from the session cwd repo graph to the same-repo sentinel graph and then to the merged global graph. <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::pickGraphSource --> <!-- @test: host/__tests__/graphify-mcp-lazy.test.js (graphify-mcp-lazy.py static contract) -->
7. Claude and Pi full-semantic extraction scope each semantic-cache write to the files actually dispatched in the current uncached set, preventing a model-attributed out-of-scope node from replacing another file's complete cache entry. <!-- @impl: preseed/agents/claude/skills/graphify/references/extraction-spec.md::Step B3 - Collect, cache, and merge --> <!-- @impl: preseed/agents/pi/skills/graphify/references/build.md::Step 3 — merge chunks into Graphify semantic cache and local fragment --> <!-- @test: host/__tests__/graphify-build-scripts.test.js (REQ-AGENT-023 AC7: Claude and Pi semantic extraction scope cache writes to dispatched files) --> <!-- @manual -->

**Constraints:**

- The image uses upstream graphify without a fork; provider/office/video/Neo4j/local-backend extras are not installed.
- Pi query tools resolve the session cwd repo graph, then the same-repo sentinel graph, then the merged global graph; no graph fails soft.
- Ambient MCP/native query capability is all-mode; graph-first discipline, Pi workflow assets, clone triage, active-repo tracking, and graph summaries are advanced-only.
- Per-branch graphs are unsupported; users refresh after checkout.
- Existing graph refreshes use the bounded update wrapper, never bare `graphify update`.
- Pi first-build scripts own AST and architecture graph creation.
- Entrypoint mounts tmpfs `/dev/shm` for Graphify AST multiprocessing, memory capture, and vault extraction.

**Priority:** P1

**Dependencies:** [REQ-AGENT-001](#req-agent-001-support-multiple-ai-coding-agents), [REQ-AGENT-004](#req-agent-004-two-session-modes-standard-and-pro), [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers), [REQ-AGENT-008](#req-agent-008-preseed-deployed-to-container-on-start)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-024: Advanced-Session-Mode Graph-First Discipline

**Intent:** In advanced session mode, the preseeded graph-first rule and graphify skill teach the agent to prefer the knowledge graph over Grep-style text search for structural questions. Runtime reminder hooks live in [REQ-AGENT-091](#req-agent-091-advanced-session-graph-first-runtime-reminders), and `/graphify` build dispatch lives in [REQ-AGENT-043](#req-agent-043-graphify-build-mode-dispatch).

**Applies To:** Agent

**Acceptance Criteria:**

1. In advanced session mode only, a short authoritative graph-first rule is preseeded, stating MUST / MUST NOT bullets for graph vs grep and routing to the graphify skill for mechanics rather than restating them. <!-- @manual -->
2. In advanced session mode only, the graphify skill is preseeded for Claude Code, with per-agent adapted variants emitted for Codex, Copilot, OpenCode, and Antigravity by the seed generator. <!-- @test: host/__tests__/preseed-graphify-discipline.test.js (graphify preseed - advanced-mode discipline (REQ-AGENT-024)) --> <!-- @manual -->
3. The skill documents the safe build path for large repos (more than 2000 files). <!-- @manual -->
4. The skill instructs the agent on first build to add canonical ignore and attribute rules so regenerable graph build outputs and working-tree intermediates are not committed while the queryable graph remains under git merge control. <!-- @manual -->

**Constraints:**

- The soft nudge never blocks; graph-first discipline stays advisory through the preseeded rule and per-call nudge.
- The soft-nudge matcher set covers both the non-ctx tool surface (`Grep`/`Glob`) and the ctx grep-equivalents (`mcp__context-mode__ctx_search`/`mcp__context-mode__ctx_batch_execute`).

**Priority:** P1

**Dependencies:** [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-127: Graph publication artifacts and optional labels

**Intent:** Graph publication keeps its durable artifacts available with or without optional community labels.

**Applies To:** Agent

**Acceptance Criteria:**

1. The published graph surface includes the queryable graph, human-readable report, visual exploration page, generated callflow, and optional wiki tree. <!-- @impl: preseed/agents/pi/scripts/build-graphify-ast.sh::callflow.html --> <!-- @impl: preseed/agents/pi/scripts/build-graphify-architecture.sh::callflow.html --> <!-- @impl: preseed/agents/pi/scripts/local-graphify-labels.sh::graphify-out/graph.json --> <!-- @impl: preseed/agents/pi/skills/graphify/references/build.md::graphify-out/graph.json --> <!-- @test: host/__tests__/graphify-build-scripts.test.js (Pi AST-only build writes a portable manifest and unlabeled HTML) --> <!-- @test: host/__tests__/graphify-build-scripts.test.js (REQ-AGENT-128 AC2: Pi architecture build forwards the visualization limit and writes a portable manifest) --> <!-- @manual -->
2. Community labels are published only when the user requests community naming. <!-- @manual -->
3. Skipping community labels never blocks graph publication. <!-- @impl: preseed/agents/pi/skills/graphify/references/build.md::graphify_labels --> <!-- @test: host/__tests__/graphify-build-scripts.test.js (REQ-AGENT-127 AC3 / REQ-AGENT-128 AC3: Pi semantic publication works unlabeled and forwards the visualization limit) --> <!-- @test: host/__tests__/graphify-build-scripts.test.js (Pi AST-only build writes a portable manifest and unlabeled HTML) --> <!-- @test: host/__tests__/graphify-build-scripts.test.js (REQ-AGENT-128 AC2: Pi architecture build forwards the visualization limit and writes a portable manifest) -->

**Constraints:** Optional labels never replace the official graph artifacts.

**Priority:** P1

**Dependencies:** [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline), [REQ-AGENT-043](#req-agent-043-graphify-build-mode-dispatch)

**Verification:** Automated tests and manual check

**Status:** Implemented

---

### REQ-AGENT-128: Graph visualization node limits

**Intent:** Graph publication bounds visualization export work consistently across every owned publication path.

**Applies To:** Agent

**Acceptance Criteria:**

1. AST publication honors the configured visualization node limit. <!-- @impl: preseed/agents/pi/scripts/build-graphify-ast.sh::GRAPHIFY_VIZ_NODE_LIMIT --> <!-- @test: host/__tests__/graphify-build-scripts.test.js (REQ-AGENT-128 AC1: Pi AST build forwards the configured visualization limit) -->
2. Architecture publication honors the configured visualization node limit. <!-- @impl: preseed/agents/pi/scripts/build-graphify-architecture.sh::GRAPHIFY_VIZ_NODE_LIMIT --> <!-- @test: host/__tests__/graphify-build-scripts.test.js (REQ-AGENT-128 AC2: Pi architecture build forwards the visualization limit and writes a portable manifest) -->
3. Semantic-merge publication honors the configured visualization node limit. <!-- @impl: preseed/agents/pi/skills/graphify/references/build.md::GRAPHIFY_VIZ_NODE_LIMIT --> <!-- @test: host/__tests__/graphify-build-scripts.test.js (REQ-AGENT-127 AC3 / REQ-AGENT-128 AC3: Pi semantic publication works unlabeled and forwards the visualization limit) -->
4. Label-apply publication honors the configured visualization node limit. <!-- @impl: preseed/agents/pi/scripts/local-graphify-labels.sh::GRAPHIFY_VIZ_NODE_LIMIT --> <!-- @test: host/__tests__/graphify-build-scripts.test.js (REQ-AGENT-128 AC4: Pi labeled graph publication forwards the visualization limit) -->
5. An absent visualization node-limit setting defaults to `100000`. <!-- @impl: preseed/agents/pi/scripts/build-graphify-ast.sh::GRAPHIFY_VIZ_NODE_LIMIT --> <!-- @impl: preseed/agents/pi/scripts/build-graphify-architecture.sh::GRAPHIFY_VIZ_NODE_LIMIT --> <!-- @test: host/__tests__/graphify-build-scripts.test.js (Pi AST-only build writes a portable manifest and unlabeled HTML) -->
6. Non-positive or non-integer visualization node limits reject publication. <!-- @impl: preseed/agents/pi/scripts/build-graphify-ast.sh::GRAPHIFY_VIZ_NODE_LIMIT --> <!-- @impl: preseed/agents/pi/scripts/build-graphify-architecture.sh::GRAPHIFY_VIZ_NODE_LIMIT --> <!-- @impl: preseed/agents/pi/scripts/local-graphify-labels.sh::GRAPHIFY_VIZ_NODE_LIMIT --> <!-- @test: host/__tests__/graphify-build-scripts.test.js (REQ-AGENT-128 AC6: Pi AST build rejects an invalid visualization limit) --> <!-- @test: host/__tests__/graphify-build-scripts.test.js (REQ-AGENT-128 AC6: Pi label apply rejects an invalid limit before publication) -->

**Constraints:** Publication limits never remove the durable queryable graph.

**Priority:** P1

**Dependencies:** [REQ-AGENT-043](#req-agent-043-graphify-build-mode-dispatch), [REQ-AGENT-127](#req-agent-127-graph-publication-artifacts-and-optional-labels)

**Verification:** Automated tests and manual check

**Status:** Implemented

---

### REQ-AGENT-091: Advanced-session graph-first runtime reminders

**Intent:** Advanced sessions receive a non-blocking graph-first reminder before grep-class tool calls when a repository graph exists.

**Applies To:** Agent

**Acceptance Criteria:**

1. In advanced session mode only, a soft-nudge hook fires on grep-class tool calls and emits a reminder to prefer the graph MCP tools when a graph exists for the cwd; the hook never blocks. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graph-first-nudge.sh::TOOL --> <!-- @test: host/__tests__/entrypoint-graphify-hooks.test.js (manifest present + advanced mode: PreToolUse graph-first nudge wired for Grep|Glob and the ctx grep-equivalents (REQ-AGENT-091 AC1)) -->

**Constraints:**

- The soft nudge never blocks; graph-first discipline stays advisory through the preseeded rule and per-call nudge.
- The soft-nudge matcher set covers both the non-ctx tool surface (`Grep`/`Glob`) and the ctx grep-equivalents (`mcp__context-mode__ctx_search`/`mcp__context-mode__ctx_batch_execute`).

**Priority:** P1

**Dependencies:** [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-025: Post-Clone Graph Triage

**Intent:** After the agent clones a repo, it must triage whether to build (or refresh) a knowledge graph for it before doing other work, so users on unfamiliar repos do not start cold.

**Applies To:** Agent

**Acceptance Criteria:**

1. In advanced session mode only, a PostToolUse hook on `Bash` and `mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute` matchers detects real `git clone` and `gh repo clone` invocations using anchored token parsing that rejects quoted or echoed false positives. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-clone-prompt.sh::COMMAND --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::isGitClone --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::shellCommandText --> <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::ENV_PREFIX --> <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::cloneTargetPath --> <!-- @test: host/__tests__/graphify-clone-prompt.test.js (graphify-clone-prompt.sh / REQ-AGENT-025 (post-clone graph triage)) -->
2. Pi implements clone triage with native tool lifecycle events and Pi follow-up messages. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::graphifyClonePromptDecision --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. Clone destination resolution prefers the tool result's `Cloning into '...'` line before falling back to command parsing, so shell variables such as `$repo` never surface as literal user-facing paths. <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::cloneTargetPath --> <!-- @test: host/__tests__/graphify-clone-prompt.test.js (graphify-clone-prompt.sh / REQ-AGENT-025 (post-clone graph triage)) -->
4. When `<cloned-dir>/graphify-out/graph.json` is absent, the directive asks which graph action the user wants before any graph work, offering Full repo AST-only, Full repo semantic intent, or no graph action. <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::renderGraphifyCloneDirective --> <!-- @test: host/__tests__/graphify-clone-prompt.test.js (graphify-clone-prompt.sh / REQ-AGENT-025 (post-clone graph triage)) -->
5. When `<cloned-dir>/graphify-out/graph.json` exists, fresh graphs are used as-is; a stale graph opens the directive with an explicit STALE warning before the choices, while an unknown-freshness graph asks without the stale flag. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::existingGraphCloneNotice --> <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::renderGraphifyCloneDirective --> <!-- @impl: preseed/agents/pi/extensions/graphify-helpers.ts::graphifyClonePromptDecision --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
6. The bounded upstream-update wrapper runs only after the user chooses AST-only, and Full semantic build/refresh must pass through graphify skill detection plus post-detection count confirmation before semantic subagents dispatch. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
7. The hook is idempotent per cloned directory per session via a marker key that includes both the session identifier and cloned repository path; Pi clone triage suppresses follow-up prompts for failed clone commands, skipped/already-cloned targets, and durable PR-boundary review lanes. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::shouldHandleClonePrompt --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Constraints:**

- The hook never invokes Graphify or authorizes updates; it directs the agent to ask before building or refreshing.
- A same-turn clone-time AST-only or no-graph choice remains valid after detection; Full semantic intent still requires post-detection count confirmation.

**Priority:** P1

**Dependencies:** [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify), [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-026: Knowledge-Graph Persistence via Git

**Intent:** Graphify artifacts persist with the repository, not with the user, so contributors on a clone inherit the graph for free and Codeflare's R2 bisync does not carry per-repo graph data.

**Applies To:** Agent

**Acceptance Criteria:**

1. Knowledge-graph artefacts are excluded from R2 sync, so they never round-trip through user-bucket storage. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (statically excludes ephemeral caches, repo graphify-out, and R2 secrets in both modes (REQ-STOR-004 AC6 / REQ-AGENT-026 AC1)) -->
2. The container image registers the graphify semantic merge driver globally, independent of session mode. <!-- @impl: Dockerfile::merge.graphify.driver --> <!-- @manual -->
3. Repo owners with push permission commit the knowledge-graph artefacts to git so contributors inherit the graph and the visualization on clone; concurrent edits to the graph artefact are auto-resolved by the registered merge driver without manual JSON conflict resolution. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
4. For repos without push permission, the graph lives in the working tree only and is ephemeral. <!-- @manual -->

**Constraints:**

- Per-repo ignore and merge-attribute wiring is the responsibility of the graphify skill ([REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline) AC4); this REQ covers only the platform-level pieces (sync exclusion, global merge-driver registration).

**Priority:** P1

**Dependencies:** [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify)

**Verification:** Automated test ([entrypoint rclone filter behavior](../../host/__tests__/entrypoint-rclone-filters.test.js))

**Status:** Implemented

---

### REQ-AGENT-027: Context-Mode Interoperability

**Intent:** When the context-mode plugin is preseeded, the graphify CLI must coexist with context-mode and the graph-first soft-nudge must reach the agent through context-mode's redirected tool-call path.

**Applies To:** Agent

**Acceptance Criteria:**

1. When the context-mode plugin is preseeded, `graphify update .` and `graphify query ...` run unimpeded: context-mode is wired as a tool only, with no Bash deny-gate, so no command-routing whitelist is needed. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
2. The [REQ-AGENT-091](#req-agent-091-advanced-session-graph-first-runtime-reminders) AC1 PreToolUse soft-nudge hook registers both the non-ctx matchers (`Grep`, `Glob`) and the ctx grep-equivalents (`mcp__context-mode__ctx_search`, `mcp__context-mode__ctx_batch_execute`) so the nudge fires in both tier paths. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graph-first-nudge.sh::INPUT --> <!-- @test: host/__tests__/graph-first-nudge.test.js (graph-first-nudge.sh) -->

**Constraints:**

- Graphify must not depend on context-mode at runtime; `/graphify` extraction uses upstream graphify's subagent-chunking model; context-mode, when present, provides bonus per-subagent token routing via its existing `Read|Grep|Glob|Agent` PreToolUse matchers, but is not a precondition.

**Priority:** P2

**Dependencies:** [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify), [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline), [REQ-AGENT-091](#req-agent-091-advanced-session-graph-first-runtime-reminders)

**Verification:** Automated test ([graph-first-nudge](../../host/__tests__/graph-first-nudge.test.js))

**Status:** Implemented

---

### REQ-AGENT-028: Deploy Credential Token-Creation UX

**Intent:** Connecting GitHub and Cloudflare must guide users through scope selection so they grant the smallest scope set that unlocks the features they need, without copy-pasting raw scope strings — the chosen tier flows into the OAuth `scope` parameter.

**Applies To:** User

**Acceptance Criteria:**

1. The GitHub connect card offers three scope tiers (Minimal, Recommended, Advanced) with Recommended pre-selected; the selection is sent to the server as the connect URL's `tier` query param. <!-- @impl: web-ui/src/lib/token-scopes.ts::GITHUB_TIERS --> <!-- @test: web-ui/src/__tests__/components/connect/OAuthConnectCard.test.tsx (offers the scope tiers as a segmented control + subtitle, encodes the selected tier into the connect URL, and routes changes) -->
2. The Cloudflare connect card offers the same three-tier selector with Recommended pre-selected, sent the same way. <!-- @impl: web-ui/src/lib/token-scopes.ts::CLOUDFLARE_TIERS --> <!-- @test: web-ui/src/__tests__/components/connect/OAuthConnectCard.test.tsx (offers the scope tiers as a segmented control + subtitle, encodes the selected tier into the connect URL, and routes changes) -->
3. The server maps the requested tier to the OAuth `scope` parameter from a backend scope catalog (the catalog never leaves the server); higher tiers are supersets of lower tiers, and the Cloudflare scope always includes `offline_access`. <!-- @impl: src/lib/oauth-scopes.ts::githubScopeForTier --> <!-- @impl: src/lib/oauth-scopes.ts::cloudflareScopeForTier --> <!-- @test: src/__tests__/lib/oauth-scopes.test.ts (REQ-BROWSER-002: Browser Rendering scope in the Cloudflare token template) -->

**Constraints:**

- The client sends only the tier name (untrusted, normalized server-side to a known tier; default `recommended`); the concrete scope strings are defined once, server-side ([REQ-GITHUB-007](github.md#req-github-007-broaden-the-panel-gate-beyond-enterprise) AC6, [REQ-AGENT-064](#req-agent-064-connect-to-cloudflare-via-oauth)).
- A GitHub App's permissions are fixed at registration, so the tier affects only the OAuth-App path.

**Priority:** P1

**Dependencies:** [REQ-AGENT-018](#req-agent-018-push--deploy-credential-management-ui), [REQ-GITHUB-007](github.md#req-github-007-broaden-the-panel-gate-beyond-enterprise), [REQ-AGENT-064](#req-agent-064-connect-to-cloudflare-via-oauth)

**Verification:** Automated test ([Tier catalog test](../../web-ui/src/__tests__/lib/token-scopes.test.ts) + [Connect card test](../../web-ui/src/__tests__/components/connect/OAuthConnectCard.test.tsx) + [Scope mapping test](../../src/__tests__/lib/oauth-scopes.test.ts))

**Status:** Implemented

---

### REQ-AGENT-029: Deploy Credential Propagation to Container

**Intent:** Stored deploy credentials must reach the container as environment variables and be consumed by git, wrangler, and the Cloudflare API auto-fetch step, so the in-container agent can push code and deploy without re-authentication.

**Applies To:** User

**Acceptance Criteria:**

1. Stored GitHub and Cloudflare deploy credentials are injected into the container as environment variables on session start. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) -->
2. Credentials are sent as explicit `null` when absent (not omitted) so revocation propagates on session restart. <!-- @impl: src/routes/container/lifecycle-init.ts::buildSetBucketNameBody --> <!-- @impl: src/container/container-env.ts::applyPrefsOnRestart --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (DEEP-20-002: sends newly absent deploy credentials as explicit null on restart) --> <!-- @test: src/__tests__/container/container-env.test.ts (applyBucketName / applyPrefsOnRestart propagate userTimezone (REQ-SESSION-016 AC3 wiring regression) / REQ-AGENT-029 (container env vars contract)) -->
3. When a GitHub credential is present, the container configures git for authenticated HTTPS access. <!-- @test: host/__tests__/entrypoint-credentials.test.js (does NOT configure git credential.helper when GH_TOKEN is unset (REQ-AGENT-029 AC3: guard)) --> <!-- @manual -->
4. The Cloudflare account ID is resolved automatically from the API token when one is stored, so users need not supply it separately. <!-- @impl: src/routes/setup/account.ts::handleGetAccount --> <!-- @test: src/__tests__/routes/setup/account.test.ts (returns account ID on success) -->

**Constraints:**

- Misconfigured Copilot scope can cause silent agent auth failure; full Copilot support requires the Advanced tier (see [REQ-AGENT-028](#req-agent-028-deploy-credential-token-creation-ux)).

**Priority:** P1

**Dependencies:** [REQ-AGENT-010](#req-agent-010-deploy-credential-storage-github-pat-cf-api-token)

**Verification:** Automated test ([container-env](../../src/__tests__/container/container-env.test.ts))

**Status:** Implemented

---

### REQ-AGENT-030: Multi-Agent Format Transforms

**Intent:** Each non-Claude agent has its own config-file conventions (frontmatter shape, model-field presence, path layout, file extensions). The generator must apply the right per-agent transform so the adapted config is valid for the consumer.

**Applies To:** User

**Acceptance Criteria:**

1. Agent definitions use correct frontmatter format per agent (e.g., `tools` as record `{read: true}` for OpenCode, as array or comma-separated names according to the target schema). <!-- @impl: scripts/generate-agent-seed.mjs::adaptAgentFrontmatter --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. `model` field is removed from frontmatter for non-CC agents where the target runtime resolves model selection independently. <!-- @impl: scripts/generate-agent-seed.mjs::adaptAgentFrontmatter --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. Path references (e.g., `~/.claude/`) are replaced with agent-specific config paths, including Pi's `.pi/agent/agents/` subagent path. <!-- @impl: scripts/generate-agent-seed.mjs::adaptPaths --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
4. File extensions match agent conventions (e.g., `.agent.md` for Copilot agents and `.md` for Pi subagents). <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
5. Pi subagent transforms emit Pi-compatible frontmatter for tools, prompt mode, extension/skill inheritance, context inheritance, and background defaults. <!-- @impl: scripts/generate-agent-seed.mjs::adaptPiSkillContent --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Constraints:**

- Format transforms are derived from each agent's documented config schema; missing schema means the agent is unsupported, not silently passed through.

**Priority:** P1

**Dependencies:** [REQ-AGENT-007](#req-agent-007-multi-agent-adaptation-pipeline)

**Verification:** Automated test ([agent-seed-multi-agent](../../src/__tests__/lib/agent-seed-multi-agent.test.ts))

**Status:** Implemented

---

### REQ-AGENT-031: consult-llm Key Isolation, Subscription Backend, and Multi-Agent Parity

**Intent:** Stored LLM API keys must reach the `consult-llm-mcp` MCP server WITHOUT leaking into the coding agents' general environment (where the latest Pi/opencode/antigravity auto-detect them as their own provider credentials and silently drain the user's API account), must prefer the user's subscription over per-call API billing, and must be available identically to Claude Code and Pi.

**Applies To:** User

**Acceptance Criteria:**

1. LLM provider keys are injected ONLY under a `CODEFLARE_`-namespaced name; the bare `OPENAI_API_KEY` / `GEMINI_API_KEY` names NEVER appear in the container's global environment. Keys are read fresh from KV on each container start and are not persisted in DO storage. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) -->
2. The entrypoint maps namespaced provider keys to standard names only inside the scoped Claude and Pi `consult-llm-mcp` environments; it never exports them globally. <!-- @impl: entrypoint.sh::_merge_consult_llm_mcp --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (entrypoint consult-llm configuration / REQ-AGENT-031 (key isolation, subscription backend, Pi parity, enterprise gate)) -->
3. Pi preserves a provider key beginning with literal `!` as data and never executes it. <!-- @impl: entrypoint.sh::_merge_consult_llm_mcp --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (entrypoint consult-llm configuration / REQ-AGENT-031 (key isolation, subscription backend, Pi parity, enterprise gate)) -->
4. Per provider the entrypoint prefers the subscription over the API key: OpenAI uses the Codex CLI backend when the user is logged into Codex, passing the API key only as a fallback; otherwise it uses the API key. Gemini always uses the API key. <!-- @impl: entrypoint.sh::configure_consult_llm --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (entrypoint consult-llm configuration / REQ-AGENT-031 (key isolation, subscription backend, Pi parity, enterprise gate)) -->
5. The `consult-llm` tooling is scoped to Claude Code and Pi only; no other agent receives the skill or MCP server. <!-- @impl: entrypoint.sh::_merge_consult_llm_mcp --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) -->
6. Claude and Pi consult-llm skills implement the invocation and model-selection behavior in [REQ-AGENT-067](#req-agent-067-consult-llm-invocation-and-model-selection-behavior). <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) --> <!-- @manual -->
7. On a provider-less or Enterprise Mode start, the entrypoint removes Codeflare's stale Claude and Pi `consult-llm` MCP entries while preserving every unrelated MCP server and setting. <!-- @impl: entrypoint.sh::_remove_disabled_consult_llm --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (${mode} start removes only stale owned consult-llm MCP entries) -->

**Constraints:**

- The container reads keys at start and on restart; mid-session key changes take effect only after the next session start.
- AC6 is skill-directed agent behaviour; the consult-llm SKILL.md files (Claude + Pi) are the implementation surface and are verified through [REQ-AGENT-067](#req-agent-067-consult-llm-invocation-and-model-selection-behavior).
- The consult-llm MCP config is wrapped in a shell function invoked with `|| echo WARNING`; a jq/IO failure cannot abort the entrypoint before the init-complete flag.

**Priority:** P1

**Dependencies:** [REQ-AGENT-009](#req-agent-009-llm-api-key-storage-encrypted-in-kv)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-032: Starter Documentation Manually Recreatable from Settings

**Intent:** Users must be able to reset the starter "getting-started" docs to the platform defaults at any time, in case they deleted them while exploring or want to see updates that shipped after their original session.

**Applies To:** User

**Acceptance Criteria:**

1. "Recreate starter documentation" button triggers `POST /api/storage/seed/getting-started`. <!-- @impl: src/routes/storage/seed.ts::app --> <!-- @test: src/__tests__/routes/storage-seed.test.ts (Storage Seed Routes / REQ-AGENT-032 (starter docs manually recreatable)) -->
2. The endpoint is rate-limited (3/min). <!-- @impl: src/routes/storage/seed.ts::storageSeedRateLimiter --> <!-- @test: src/__tests__/routes/storage-seed-rate-limit.test.ts (REQ-AGENT-032 AC2: storage-seed rate limiter (3/min)) -->
3. After seeding, the storage stats KV cache is invalidated. <!-- @test: src/__tests__/routes/storage-seed.test.ts (invalidates storage-stats KV cache after successful getting-started seed) --> <!-- @manual -->

**Constraints:**

- The starter docs are the welcome / getting-started pages; user-authored documentation under other paths is never touched.

**Priority:** P1

**Dependencies:** [REQ-STOR-009](storage.md#req-stor-009-getting-started-docs-auto-seeded-on-first-session)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-033: `/sdd init` Scaffolding and Canonical Render

**Intent:** `/sdd init` must bootstrap a working spec in a single coherent flow whether the project is greenfield or import-mode, with every drafted REQ rendered in the canonical shape and the supporting scaffold (lockfile, review queue file) created in the same pass.

**Applies To:** User

**Acceptance Criteria:**

1. `/sdd init` scaffolds a new `sdd/` from templates for greenfield projects. <!-- @manual -->
2. In import mode, `/sdd init` derives a spec from existing source code rather than scaffolding from templates. <!-- @manual -->
3. When `/sdd init` generates a package manifest, top-level dependency versions are resolved at scaffold time via the ecosystem's registry (npm, Cargo, pip, Go). The Cloudflare Workers stack pins `wrangler`, `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers`, and `vitest` as a single co-resolved cohort. <!-- @manual -->
4. Lockfile generation during `/sdd init` is a scoped carveout to the no-local-builds rule (resolution only, with `--ignore-scripts` on npm; no installs, tests, or builds). <!-- @manual -->
5. `/sdd init` runs as a lean two-confirm flow: the agent asks one vision question, drafts the entire spec in memory, presents the full draft as one review surface, and applies user edits in place until the user accepts. <!-- @manual -->
6. Every REQ written by `/sdd init` renders in the canonical shape: ACs numbered (`1.`, `2.`, `3.`), each labeled field on its own line with blank-line separators between trailing fields, and `**Constraints:**` + `**Dependencies:**` always present. <!-- @manual -->
7. `/sdd init` pre-creates the verification-queue file `sdd/spec/.review-queue.md` at scaffold time with the placeholder `_Awaiting first finding._`; after scaffold the layout-resolved review queue accumulates findings appended by spec-reviewer, `/sdd clean`, or `/sdd init` Import-Mode triage. <!-- @manual -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-034: `/sdd init` Enrichment Pass with Graphify

**Intent:** After `/sdd init` accepts the user's draft, an enrichment pass tightens the spec by walking the project's knowledge graph: cross-link dependencies, seed ADRs from architecturally-central nodes, seed glossary terms from concept nodes.

**Applies To:** User

**Acceptance Criteria:**

1. After the full draft is accepted, an enrichment pass runs before files are written, executing three sub-passes (cross-link, ADR-seed, glossary-seed) in one in-memory cycle with no additional user prompts. <!-- @manual -->
2. The cross-link sub-pass adds every REQ that references another REQ concept by name to the parent's `Dependencies:` as a linked `REQ-X-NNN` heading anchor. <!-- @manual -->
3. The ADR-seed sub-pass drafts 3-8 founding ADRs covering non-obvious technology choices (tech stack, framework, deployment target, auth pattern, data store, key middleware) and writes them to `documentation/decisions/README.md` with an index table at the top and per-ADR sections below. <!-- @manual -->
4. The glossary-seed sub-pass extracts every product noun, vendor name, and protocol mentioned in any REQ Intent or AC body and gives each a one-line definition in `sdd/spec/glossary.md`. <!-- @manual -->
5. The enrichment pass queries the project's `graphify-out/graph.json` via the `mcp__graphify__*` MCP tool family: `get_neighbors` drives the cross-link pass, `god_nodes` surfaces ADR-seed candidates, `query_graph` extracts glossary concept-tagged nodes, and `shortest_path` validates non-obvious dependency edges. <!-- @manual -->
6. When the graph is missing at enrichment time, `/sdd init` prompts the user once with a `/graphify cluster-only` build offer; on decline, enrichment falls back to an in-memory heuristic and appends a one-line notice to `sdd/changes.md` recording reduced cross-link density. <!-- @manual -->
7. Graphify MCP tools are tool-agnostic across Bash and context-mode surfaces; the enrichment-pass contract is identical regardless of which tool surface is active. <!-- @manual -->

**Constraints:**

- Backlink density drops materially when the graph is absent; the changes.md notice exists so future readers can correlate spec quality with the build state at init time.

**Priority:** P1

**Dependencies:** [REQ-AGENT-033](#req-agent-033-sdd-init-scaffolding-and-canonical-render), [REQ-AGENT-023](#req-agent-023-knowledge-graph-capability-graphify), [REQ-AGENT-025](#req-agent-025-post-clone-graph-triage)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-035: `/sdd init` Phase 7a Source-Anchor Verifier Gate

**Intent:** `/sdd init` must not declare success on a spec that contains unanchored claims. A programmatic source-anchor verifier runs before iterate-to-clean so every `<!-- @impl -->` claim is proven against the source tree, closing the "agent wrote what isn't there" half of the Validation-Equals-Generation gap. Phase 7b (enumeration coverage) is split into [REQ-AGENT-039](#req-agent-039-sdd-init-phase-7b-enumeration-coverage-verifier-gate).

**Applies To:** User

**Acceptance Criteria:**

1. `/sdd init` runs Phase 7a as a CRITICAL non-skippable gate BEFORE invoking `spec-enforce` and `doc-enforce`. <!-- @test: host/__tests__/sdd-init-phase-7a-verifier.test.js (REQ-AGENT-035: /sdd init Phase 7a source-anchor verifier gate) --> <!-- @manual -->
2. The verifier resolves every spec and documentation source anchor on disk, checks symbols and local literal values, and counts malformed anchors and unreadable files. <!-- @impl: preseed/agents/claude/skills/sdd-init/references/verify-source-anchors.py::main --> <!-- @test: host/__tests__/sdd-init-phase-7a-verifier.test.js (REQ-AGENT-035: /sdd init Phase 7a source-anchor verifier gate) -->
3. The verifier emits a machine-readable JSON report containing counts of parsed, resolved, orphaned, drifted, malformed, and unreadable anchors, plus per-entry failure details and an exit-code field, written to a Phase-7a evidence file the commit body can reference. <!-- @impl: preseed/agents/claude/skills/sdd-init/references/verify-source-anchors.py::main --> <!-- @test: host/__tests__/sdd-init-phase-7a-verifier.test.js (emits all 9 contract fields: parsed/resolved/orphaned/drifted/malformed/unreadable/failures/malformed_entries/unreadable_entries/exit_code) -->
4. The `[sdd-init]` commit body MUST include the verbatim summary line `Phase 7a verifier: parsed=N resolved=N orphaned=N drifted=N malformed=N unreadable=N exit_code=0|1`. <!-- @test: host/__tests__/sdd-init-phase-7a-verifier.test.js (REQ-AGENT-035: /sdd init Phase 7a source-anchor verifier gate) --> <!-- @manual -->
5. A non-zero `exit_code` blocks the commit until every failure is fixed in source or escalated to `sdd/spec/.review-queue.md`. <!-- @test: host/__tests__/sdd-init-phase-7a-verifier.test.js (AC5: non-zero exit_code blocks until every failure is fixed) --> <!-- @manual -->
6. Substituting a structural sanity check or agent self-attestation, partial coverage, running the verifier AFTER the enforcement skills, bypassing on a missing-tool error, or committing without the summary line each carry a CRITICAL severity (`phase-7a-self-attestation`, `phase-7a-incomplete-coverage`, `phase-7a-pipeline-inversion`, `phase-7a-tooling-bypass`, `phase-7a-evidence-missing`). <!-- @manual -->
7. After `/sdd init`, steady-state CQ-SOURCE (`spec-enforce-truth`) and Pass 15 (`doc-enforce-truth`) consume Phase 7a's JSON when available rather than re-deriving. <!-- @test: host/__tests__/sdd-init-phase-7a-verifier.test.js (REQ-AGENT-035: /sdd init Phase 7a source-anchor verifier gate) --> <!-- @manual -->

**Constraints:**

- The verifier is a programmatic Python script shipping with the `sdd-init` skill; agent self-attestation MUST NOT be substituted for the verifier output.

**Priority:** P1

**Dependencies:** [REQ-AGENT-033](#req-agent-033-sdd-init-scaffolding-and-canonical-render), [REQ-AGENT-034](#req-agent-034-sdd-init-enrichment-pass-with-graphify)

**Verification:** Automated test ([sdd-init-phase-7a-verifier](../../host/__tests__/sdd-init-phase-7a-verifier.test.js))

**Status:** Implemented

---

### REQ-AGENT-036: PR-Boundary Review Trigger Conditions

**Intent:** Pi evaluates authoritative review state after successful Git or GitHub CLI activity in the root session and launches only for an unacknowledged exact head of the checked-out branch's open protected-base PR.

**Applies To:** User

**Acceptance Criteria:**

1. Successful executable `git` and `gh` commands request one authoritative branch-state evaluation. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewBoundaryCommand --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-063/REQ-AGENT-116/REQ-AGENT-121: classifies delivery commands for automatic review and other Git activity for confirmation) -->
2. Evaluation resolves the checked-out branch and local full `HEAD`, then queries that branch's PR without deriving refs from command arguments. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::currentReview --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::queryBranch --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063: verifies only the checked-out branch and rejects detached HEAD) -->
3. Review launches only when the PR is open, targets `main`, `master`, or `develop`, names the checked-out branch, and reports local `HEAD` as its exact head. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::currentReview --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063: checks authoritative current-branch state after any git or gh command) -->
4. Failed commands other than bounded ambiguous `gh pr create` reconciliation, quoted examples, absent PRs, detached HEAD, nonstandard worktrees, unsynchronized remote heads, and acknowledged heads request no work. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::launchBoundaryPlan --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-121/REQ-AGENT-145 AC1: reconciles an ambiguous failed PR creation against authoritative exact-head state) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063: checks an absent matching PR only once) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-068: acknowledged current branch state stays inert) -->
5. Root and nested SDD layouts suppress review only while transition is true and the layout-resolved `.init-triage.md` contains an open item; ordinary review queues never suspend transition review. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isReviewTransitionSuspended --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-092/REQ-AGENT-047: suspends root and nested SDD layouts only during an open transition) -->
6. Passive lifecycle and child sessions cannot start or complete review. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-058: keeps child sessions inert for reminders, settled follow-ups, and state writes) -->
7. Each candidate remains paired with its executable shell segment and resolved repository. <!-- @impl: preseed/agents/pi/extensions/active-repo-memory.ts::shellInvocations --> <!-- @impl: preseed/agents/pi/extensions/active-repo-memory.ts::resolveShellInvocationRepo --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-055: binds git -C review and acknowledgement to the boundary repository) -->

**Constraints:**

- Command parsing only detects candidates as defined by [REQ-AGENT-063](#req-agent-063-pr-boundary-candidate-detection).
- Authoritative branch and PR state determine eligibility.
- Draft protected-base PRs remain eligible.

**Priority:** P1

**Dependencies:** [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability), [REQ-AGENT-063](#req-agent-063-pr-boundary-candidate-detection)

**Verification:** Automated test ([Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts))

**Status:** Implemented

---

### REQ-AGENT-037: `/sdd clean` Rescue and Autonomy Modes

**Intent:** Three autonomy modes (interactive, auto, unleashed) give the user a knob between hand-holding and walk-away autopilot, and the `/sdd clean` rescue pass restores rotted specs to canonical shape without overwriting intent. Review-agent discipline enforcement (the content-quality passes each review agent applies) lives in [REQ-AGENT-044](#req-agent-044-review-agent-discipline-enforcement).

**Applies To:** User

**Acceptance Criteria:**

1. Three autonomy modes (`interactive`, `auto`, `unleashed`) are selectable via the layout-resolved config file (`sdd/spec/config.yml` on the nested layout, `sdd/config.yml` on the flat-legacy layout). <!-- @test: host/__tests__/skill-sdd-clean-contract.test.js (REQ-AGENT-037: /sdd clean rescue and autonomy modes) --> <!-- @manual: On disposable current branches, exercise `--auto` and `--unleashed`; confirm the root applies repairs in specification-then-documentation order and pushes the checked-out branch without creating a branch or PR. -->
2. `interactive` and `auto` modes apply fixes on the current branch (auto silently, interactive after confirmation). <!-- @test: host/__tests__/skill-sdd-clean-contract.test.js (REQ-AGENT-037: /sdd clean rescue and autonomy modes) --> <!-- @manual -->
3. `unleashed` mode applies SAFE + RISKY + JUDGMENT fixes on the current branch via per-category `[sdd-clean]` commits and uses conservative JUDGMENT auto-resolution that never overwrites intent. <!-- @test: host/__tests__/skill-sdd-clean-contract.test.js (REQ-AGENT-037: /sdd clean rescue and autonomy modes) --> <!-- @manual -->
4. `unleashed` refuses when `enforce_tdd: false`; users must enable TDD or use `auto`. It creates no branch or PR, and per-category commits remain independently revertible. <!-- @test: host/__tests__/skill-sdd-clean-contract.test.js (REQ-AGENT-037: /sdd clean rescue and autonomy modes) --> <!-- @manual -->
5. `/sdd clean` rescues rotted specs with conservative JUDGMENT auto-resolution that never overwrites spec intent (mark Partial + Notes, move to Out of Scope, shrink in place). <!-- @test: host/__tests__/skill-sdd-clean-contract.test.js (REQ-AGENT-037: /sdd clean rescue and autonomy modes) --> <!-- @manual -->
6. A successful `auto` or `unleashed` cleanup leaves its resulting commits on the checked-out remote branch. <!-- @impl: preseed/agents/pi/extensions/sdd-helpers.ts::rootSddExecution --> <!-- @impl: preseed/agents/claude/skills/sdd-clean/SKILL.md::Execution ownership (binding) --> <!-- @manual -->
7. Specification repair completes before documentation repair. <!-- @impl: preseed/agents/pi/extensions/sdd-helpers.ts::rootSddExecution --> <!-- @impl: preseed/agents/claude/skills/sdd-clean/SKILL.md::Execution ownership (binding) --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-021/REQ-AGENT-037: keeps SDD mutation workflows in the root session) -->

**Constraints:**

- Status semantics, `Deprecated` requirements, the spec-discipline enforcement layer, and the `enforce_tdd` test-coverage rule follow `rules/spec-discipline.md`.
- Inline repair invokes `spec-enforce` before `doc-enforce`; report-only reviewers never own mutations or Git operations.

**Priority:** P1

**Dependencies:** [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability), [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)

**Verification:** Automated test ([pi-review-scope](../../src/__tests__/lib/pi-review-scope.test.ts))

**Status:** Implemented

---

### REQ-AGENT-038: Resume Mode Drain Workflow

**Intent:** Re-invoking `/sdd init` on a transitioning project enters Resume Mode, which surfaces open triage items one at a time, refreshes their Context, accepts one of five decisions, and commits each decision so the user can drain the queue at their own pace. When the last item closes, the project exits SDD transition.

**Applies To:** User

**Acceptance Criteria:**

1. Re-invoking `/sdd init` on a project where `sdd/` already exists and `sdd/.init-triage.md` has at least one open item enters Resume Mode. <!-- @manual -->
2. The user chooses one of five decisions per item (`accept`, `correct`, `lost`, `skip`, `quit`); per-decision semantics are enumerated in Constraints. <!-- @manual -->
3. Only `accept` and `correct` promote behavioral content into the official spec; `skip` and `lost` add no behavioral content to `sdd/{domain}.md` (a `lost` decision may annotate the related REQ with a `Notes:` gap-marker recording that the intent was lost during the SDD transition). <!-- @manual -->
4. Each resolved decision is its own commit with exactly one accepted subject: `[sdd-init] resolve TRIAGE-{NNN}` for `accept` or `correct`, and `[sdd-init] mark lost TRIAGE-{NNN}` for `lost`. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Resume Mode — picking up where you left off --> <!-- @manual -->
5. Resume Mode entry refuses to start when the working tree has uncommitted changes and is always interactive regardless of `sdd/config.yml`'s `mode`. <!-- @manual -->
6. Queue-drain closure mechanics are specified in [REQ-AGENT-047](#req-agent-047-resume-mode-closure-and-review-pipeline-gate). <!-- @manual -->

**Constraints:**

- Resume Mode is interactive only; `mode: auto` and `mode: unleashed` are suspended for the duration of the drain.
- AC2 `accept`: use the recommendation as-is and fold into the relevant REQ.
- AC2 `correct`: free-form prose describing what the thing is for and how it works; agent folds purpose into REQ Intent and behavior into AC bullets.
- AC2 `lost`: record the gap with a one-line Reason; the related REQ (if any) gets a `Notes: intent lost during SDD transition - see TRIAGE-{NNN}` annotation; nothing is fabricated into the spec.
- AC2 `skip`: leave Status: open, write nothing to the spec, advance to next.
- AC2 `quit`: commit progress and exit.

**Priority:** P1

**Dependencies:** [REQ-AGENT-022](#req-agent-022-legacy-codebase-import-mode-discovery)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-039: `/sdd init` Phase 7b Enumeration-Coverage Verifier Gate

**Intent:** Phase 7a verifies that every claim the agent wrote is anchored; Phase 7b closes the second half of the Validation-Equals-Generation gap by verifying the agent did not silently drop entire source files from the enumeration. The verifier runs after Phase 7a and before iterate-to-clean so unenumerated load-bearing source surfaces as a CRITICAL gate failure rather than a silent omission.

**Applies To:** User

**Acceptance Criteria:**

1. `/sdd init` runs Phase 7b as a second CRITICAL non-skippable gate AFTER Phase 7a and BEFORE iterate-to-clean. <!-- @test: host/__tests__/sdd-init-phase-7b-verifier.test.js (REQ-AGENT-039: /sdd init Phase 7b enumeration-coverage verifier gate) --> <!-- @manual -->
2. The verifier walks the working tree, identifies load-bearing source files, and checks each file's repo-relative path against source-anchor paths in `sdd/**/*.md` and `documentation/**/*.md` plus literal mentions in layout-appropriate triage files. <!-- @impl: preseed/agents/claude/skills/sdd-init/references/verify-enumeration-coverage.py::main --> <!-- @test: host/__tests__/sdd-init-phase-7b-verifier.test.js (REQ-AGENT-039: /sdd init Phase 7b enumeration-coverage verifier gate) -->
3. The verifier emits a JSON report `{enumerated, accounted, unaccounted, coverage_pct, accounted_via, unaccounted_entries, exit_code}`. <!-- @impl: preseed/agents/claude/skills/sdd-init/references/verify-enumeration-coverage.py::CoverageReport --> <!-- @test: host/__tests__/sdd-init-phase-7b-verifier.test.js (emits enumerated/accounted/unaccounted/coverage_pct/accounted_via/unaccounted_entries/exit_code) -->
4. The `[sdd-init]` step-10 commit body MUST include the verbatim summary line `Phase 7b enum verifier: enumerated=N accounted=N unaccounted=N coverage_pct=P exit_code=0|1` alongside the Phase 7a line. <!-- @test: host/__tests__/sdd-init-phase-7b-verifier.test.js (REQ-AGENT-039: /sdd init Phase 7b enumeration-coverage verifier gate) --> <!-- @manual -->
5. An empty triage queue on Import Mode with `unaccounted > 0` is CRITICAL `import-mode-narrowed-scope`. <!-- @test: host/__tests__/sdd-init-phase-7b-verifier.test.js (REQ-AGENT-039: /sdd init Phase 7b enumeration-coverage verifier gate) --> <!-- @manual -->
6. Agent self-attestation, sampling, running `spec-enforce` first without Phase 7b, or committing without the summary line each carry a CRITICAL severity (`phase-7b-self-attestation`, `phase-7b-incomplete-coverage`, `phase-7b-pipeline-inversion`, `phase-7b-evidence-missing`). <!-- @manual -->
7. A per-project waiver file `sdd/spec/.phase-7b-waiver.txt` excludes framework-boilerplate files from coverage; greenfield runs that produce `enumerated=0` and `coverage_pct=100.0` are advisory but still emit the commit body line so the audit-trail format stays uniform across modes. <!-- @impl: preseed/agents/claude/skills/sdd-init/references/verify-enumeration-coverage.py::main --> <!-- @test: host/__tests__/sdd-init-phase-7b-verifier.test.js (REQ-AGENT-039: /sdd init Phase 7b enumeration-coverage verifier gate) -->

**Constraints:**

- The verifier is a programmatic Python script shipping with the `sdd-init` skill; agent self-attestation MUST NOT be substituted for the verifier output.

**Priority:** P1

**Dependencies:** [REQ-AGENT-035](#req-agent-035-sdd-init-phase-7a-source-anchor-verifier-gate)

**Verification:** Automated test ([sdd-init-phase-7b-verifier](../../host/__tests__/sdd-init-phase-7b-verifier.test.js))

**Status:** Implemented

---

### REQ-AGENT-040: PR-Boundary Lane Classification and Agent Dispatch

**Intent:** One pure classifier must select the smallest safe reviewer set from the acknowledged-to-current diff so reminders and settled enforcement cannot disagree.

**Applies To:** User

**Acceptance Criteria:**

1. Generated-only changes require no lane, documentation-only changes require `doc-updater`, SDD-only or SDD-plus-documentation changes require `spec-reviewer` and `doc-updater`, and source, test, configuration, workflow, preseed, mixed, or unknown changes require the code lane. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::requiredReviewLanes --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-040: classifies generated, docs, spec, source, and mixed commit ranges into reviewer lanes) -->
2. Unusual filenames and source-to-documentation renames cannot reduce the required reviewer set or bypass code review. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::requiredReviewLanes --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-040: classifies tricky filenames and source-to-doc renames without bypassing code review) -->
3. An invalid or empty review range falls back to all three lanes. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::requiredReviewLanes --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-055: falls back to all lanes for malformed and non-ancestor acknowledgements) -->
4. An acknowledged current head requires no reviewer lane. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::requiredReviewLanes --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-068: acknowledged current branch state stays inert) -->
5. A source delta proven to be comments or whitespace only requires the code lane alone. <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/inert-source-delta.mjs::inert --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh::compute_required_lanes --> <!-- @test: host/__tests__/lane-classifier.test.js (compute_required_lanes - inert source deltas) --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (git-push-review-reminder.sh - inert source delta emission) --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-040: reduces a proven comment-only source delta to the code lane alone) -->
6. When the prover cannot establish that a source delta is inert, the code lane remains required. Prover uncertainty does not invent spec or documentation ownership; those lanes are added only when their surfaces or source anchors independently require them. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::requiredReviewLanes --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh::compute_required_lanes --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-040: reduces a proven comment-only source delta to the code lane alone) -->
7. Both runtimes decide a given range identically. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::inertSourceDelta --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-040: Pi and Claude resolve the same range to the same lanes) -->

**Constraints:**

- Pi lane classification consumes NUL-delimited paths with Git rename detection disabled.
- Content-based lane reduction never removes the code lane, and never applies to an added, deleted, renamed, mode-changed, binary, ineligible-extension, or unparseable file.
- One prover, seeded from the canonical Claude tree, decides content-based reduction for every runtime; a missing prover or runtime reduces nothing.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)

**Verification:** Automated test ([Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Claude lane classifier tests](../../host/__tests__/lane-classifier.test.js))

**Status:** Implemented

---

### REQ-AGENT-106: Round-Limit Lane Suppression

**Intent:** A lane that has exhausted its review rounds must stop costing model invocations, so a stuck review converges instead of billing another full round per push.

**Applies To:** Agent

**Acceptance Criteria:**

1. A lane already at its round limit costs no model invocation in either runtime. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::roundLimitReached --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-triage.mjs::roundCounter --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (drops a lane at its round limit instead of demanding it) --> <!-- @test: host/__tests__/lane-triage.test.js (lane-triage.mjs — round counter) -->

**Constraints:**

- Suppression counts agent-authored review-loop commits only; user-directed commits reset the counter.
- The limit bounds invocations, never findings: a suppressed lane is reported as suppressed, never as clean.

**Priority:** P1

**Dependencies:** [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch)

**Verification:** Automated test ([Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts))

**Status:** Implemented

---

### REQ-AGENT-101: Reviewer Lane Spawn Requires Surface Ownership

**Intent:** A reviewer lane that provably owns nothing in a range must not be spawned, because an agent costs its full startup to reach the same conclusion the classifier can reach for free.

**Applies To:** Agent

**Acceptance Criteria:**

1. A behavioural change requires the spec or documentation lane only when that surface changed or one of its source anchors cites a changed file. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh::anchor_cites_changed --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::anchorCitesChanged --> <!-- @test: host/__tests__/lane-classifier.test.js (compute_required_lanes - file classification) --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-040: a behavioural change earns a lane only where that surface changed or an anchor cites it) -->

2. A repository root that cannot be resolved keeps the all-lane posture. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-classifier.sh::compute_required_lanes --> <!-- @test: host/__tests__/lane-classifier.test.js (compute_required_lanes - initial state) -->

**Constraints:** The code lane is never gated by this rule; only the spec and documentation lanes are.

**Priority:** P1

**Dependencies:** [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch)

**Verification:** Automated test ([Claude lane classifier tests](../../host/__tests__/lane-classifier.test.js), [Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts))

**Status:** Implemented

---

### REQ-AGENT-041: PR-Boundary Review Bypass Surfaces

**Intent:** Review enforcement accepts only explicit user-controlled bypasses. A bypass acknowledges the exact validated open-PR boundary head so settled recovery cannot launch reviewers for that head.

**Applies To:** User

**Acceptance Criteria:**

1. A user-controlled one-shot sentinel bypasses one otherwise eligible root review boundary and acknowledges its exact validated open PR head, whether created directly by the user, created after the user selects `Acknowledge without review`, present when the boundary completes, or created before settled recovery. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::BYPASS_FILE --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-041: consumes a one-shot bypass and acknowledges the exact PR head) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-041: a post-boundary sentinel acknowledges the exact PR head) --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (exits 0 and deletes the sentinel for an eligible open head (one-shot)) -->
2. A non-SDD project or an absent, acknowledged, closed, or merged PR head does not consume the one-shot sentinel. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::BYPASS_FILE --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (H1: vibe-coding project does NOT consume the /tmp/review-bypass sentinel) --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (preserves the sentinel when no PR exists for the current branch) --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (keeps an acknowledged merged head silent and preserves the bypass sentinel) -->
3. Only a finalized user message after the latest boundary containing `skip review` or `skip verification` is recognized as a transcript bypass. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-041: recognizes an explicit user bypass only when it follows the latest boundary) -->
4. A recognized post-boundary user bypass emits no reviewer reminder and acknowledges the exact validated open PR head. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-041: an explicit post-boundary user bypass acknowledges the exact PR head) -->
5. Child sessions never consume the sentinel, write acknowledgement, or mutate the block counter. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-058: keeps child sessions inert for reminders, settled follow-ups, and state writes) -->

**Constraints:**

- Agent-authored instructions may create the sentinel only immediately after the user explicitly selects `Acknowledge without review` for the displayed exact PR head; no autonomous bypass is permitted.
- The sentinel path remains overridable for hermetic tests.
- Claude acknowledges the validated eligible open head before consuming the sentinel; ineligible and settled heads do not spend it.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)

**Verification:** Automated test ([Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts), [Claude Stop-hook tests](../../host/__tests__/enforce-review-spawn.test.js))

**Status:** Implemented

---

### REQ-AGENT-043: Graphify Build Mode Dispatch

**Intent:** Before graph extraction begins, the user chooses whether to build a graph and at what supported scope. Each runtime presents its supported modes, semantic work uses runtime-native workers, and official Graphify flows own graph generation and derived outputs.

**Applies To:** Agent

**Acceptance Criteria:**

1. Before dispatching semantic-extraction subagents in a Claude `/graphify` build, the agent presents an `AskUserQuestion` with exactly two modes: AST-only and Full. The Full option includes the actual subagent count and a wall-time estimate. <!-- @impl: preseed/agents/claude/skills/graphify/SKILL.md::AskUserQuestion --> <!-- @impl: preseed/agents/claude/skills/graphify/SKILL.md::uncached_doc_paper_files --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (REQ-AGENT-025 / REQ-AGENT-043: Pi graphify clone triage resolves clone destinations and branches on graph state) -->
2. In Pi, after detection, the graph refresh choice offers Architecture graph, Full repo AST-only, Full repo semantic, and an explicit no-graph option that stops without modifying `graphify-out`. <!-- @impl: preseed/agents/pi/skills/graphify/SKILL.md::Architecture --> <!-- @impl: preseed/agents/pi/skills/graphify/SKILL.md::graphify-out --> <!-- @test: host/__tests__/graphify-clone-prompt.test.js (graphify-clone-prompt.sh / REQ-AGENT-025 (post-clone graph triage)) -->
3. Clone-time AST-only and no-graph choices suppress the duplicate post-detection mode question; clone-time Full semantic is intent only, and the agent must show the actual uncached file/subagent counts after detection and get confirmation before dispatching semantic subagents. <!-- @impl: preseed/agents/claude/skills/graphify/SKILL.md::uncached --> <!-- @impl: preseed/agents/pi/skills/graphify/SKILL.md::uncached --> <!-- @test: host/__tests__/graphify-clone-prompt.test.js (graphify-clone-prompt.sh / REQ-AGENT-025 (post-clone graph triage)) -->
4. The semantic option is hidden when the corpus contains zero docs/papers/images; code-only repos still offer the Pi Architecture graph, Full repo AST-only, and no-graph options. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (REQ-AGENT-025 / REQ-AGENT-043: Pi graphify clone triage resolves clone destinations and branches on graph state) --> <!-- @manual -->
5. In advanced session mode only, Claude Code Part B semantic subagents use the Claude graphify skill's configured reliable extraction model, while Pi Part B semantic subagents omit `model` overrides so they inherit the current main-session model. <!-- @manual -->
6. The Part C merge step preserves all data structures produced by Part B subagents - including hyperedges - by saving subagent chunks into Graphify's semantic cache before official Graphify extraction/build consumes the cache. <!-- @manual -->
7. Pi's native graphify skill does not instruct the agent to run headless semantic extraction or Graphify provider labeling. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->

**Constraints:**

- Claude Code's graphify skill owns Claude-specific extraction model selection; Pi's graphify skill must remain provider/model agnostic unless the user explicitly requests a model override.

**Priority:** P1

**Dependencies:** [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-044: Review-Agent Discipline Enforcement

**Intent:** The three review agents (doc-updater, spec-reviewer, code-reviewer) enforce content-quality beyond structural compliance. Each owns a distinct set of substantive passes (truth-check against source, content-preservation on trims, test-name-vs-assertion match) so a structurally-clean change cannot ship with semantically-wrong content.

**Applies To:** User

**Acceptance Criteria:**

1. All three review agents (doc, spec, tdd) enforce both structural compliance and content-quality on every applicable lane. <!-- @test: host/__tests__/git-push-review-reminder.test.js (git-push-review-reminder.sh - lane-aware emission (compute_required_lanes integration)) --> <!-- @manual -->
2. doc-updater runs structural passes (shape, budgets, lane) and content-quality passes (verification truth-check, Implements-vs-AC cross-walk, stale code-block detection against source, content-preservation on trims, stranger cold-read usability). <!-- @manual -->
3. spec-reviewer runs the spec analogs (REQ-test truth-check beyond literal ID match, vendor/protocol drift detection, content-preservation on shrink). <!-- @manual -->
4. code-reviewer flags tests whose name claims behavior the assertions don't actually verify (the test-name-lies antipattern from `tdd-discipline`). <!-- @manual -->
5. Auto-fixes derive concrete content from source or REQ when possible; load-bearing clauses that would be lost to a word-cap trim are promoted to surrounding prose, or the trim is reverted with a finding. <!-- @manual -->
6. A resolved source anchor is checked for whether the body contradicts what the criterion or documented fact asserts, never for whether their words overlap. <!-- @impl: preseed/agents/claude/skills/spec-enforce-truth/SKILL.md::CQ-SOURCE --> <!-- @impl: preseed/agents/claude/skills/doc-enforce-truth/SKILL.md::Pass 15 --> <!-- @manual -->
7. Reviewer lanes of a given kind use one shared category policy across runtimes. <!-- @impl: preseed/agents/claude/skills/code-review-checklist/SKILL.md::Review checklist --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (REQ-AGENT-084: expands canonical policy into each generated reviewer system prompt) -->

**Constraints:**

- The structural-vs-content-quality split, per-pass severity, and auto-fix behavior follow `rules/documentation-discipline.md`; the cold-read task registry is owned by the same file.
- spec-reviewer's content-quality passes are defined by `rules/spec-discipline.md`; code-reviewer's test-name-lies detection follows `rules/tdd-discipline.md`.

**Priority:** P1

**Dependencies:** [REQ-AGENT-037](#req-agent-037-sdd-clean-rescue-and-autonomy-modes), [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions)

**Verification:** Automated test ([shared reviewer policy](../../host/__tests__/pi-native-review-assets.test.js))

**Status:** Implemented

---

### REQ-AGENT-045: Import-Mode Triage Queue and Transition State

**Intent:** Every unclear item from Import Mode lands in a typed triage entry with concrete Context evidence so the human resolver can decide without re-investigating.

**Applies To:** User

**Acceptance Criteria:**

1. Every Import-Mode triage entry carries concrete Context, Recommendation, and Rationale fields. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Import Mode — two-output model --> <!-- @manual -->
2. The enforce pass rejects missing, placeholder, or nonspecific Context, Recommendation, and Rationale guidance before an imported scaffold can commit. <!-- @impl: preseed/agents/claude/skills/spec-enforce/scripts/validate-import-triage.mjs::main --> <!-- @impl: preseed/agents/claude/skills/spec-enforce/SKILL.md::Import-triage substantive guidance --> <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Import Mode — two-output model --> <!-- @test: host/__tests__/spec-enforce-import-triage.test.js (spec-enforce import-triage substantive validator) -->
3. A lost triage entry carries a one-line Reason. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Resume Mode — picking up where you left off --> <!-- @manual -->

**Constraints:**

- Triage state lives only in `sdd/.init-triage.md` and Git history.
- Triage resolution is interactive only.
- `/sdd init` owns the triage file.
- spec-reviewer may read the triage file.
- Each code-only domain carries one verification footnote when `enforce_tdd: false`.
- Unleashed mode is unavailable while transition triage remains open.
- Resume Mode drain behavior is owned by [REQ-AGENT-038](#req-agent-038-resume-mode-drain-workflow).

**Priority:** P1

**Dependencies:** [REQ-AGENT-022](#req-agent-022-legacy-codebase-import-mode-discovery)

**Verification:** Automated test ([Import-triage validator tests](../../host/__tests__/spec-enforce-import-triage.test.js))

**Status:** Implemented

---

### REQ-AGENT-092: Import transition review suppression

**Intent:** Open Import Mode transition triage suppresses every automatic review path until the specification is ready for enforcement.

**Applies To:** User

**Acceptance Criteria:**

1. Only open Import Mode triage in the layout-resolved `.init-triage.md` suppresses Pi review lanes; `.review-queue.md` and `.review-needed.md` never do. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isReviewTransitionSuspended --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-092/REQ-AGENT-047: suspends root and nested SDD layouts only during an open transition) -->
2. Open transition triage suppresses the Claude PR-review hooks. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::_triage_init --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (git-push-review-reminder.sh - SDD transition gate (REQ-AGENT-022)) -->

**Constraints:**

- Unleashed mode is unavailable while transition triage remains open; shared triage-state ownership rules live on [REQ-AGENT-045](#req-agent-045-import-mode-triage-queue-and-transition-state).

**Priority:** P1

**Dependencies:** [REQ-AGENT-045](#req-agent-045-import-mode-triage-queue-and-transition-state)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-093: Import-mode TDD status assignment

**Intent:** Import Mode assigns requirement status according to the project's TDD policy so imported implementations are not misclassified.

**Applies To:** User

**Acceptance Criteria:**

1. Import Mode with `enforce_tdd: false` marks source-implemented CLEAR requirements Implemented. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Import Mode — two-output model --> <!-- @manual -->
2. Import Mode with `enforce_tdd: true` marks requirements without REQ-referencing tests Partial. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Import Mode — two-output model --> <!-- @manual -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-045](#req-agent-045-import-mode-triage-queue-and-transition-state)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-047: Resume Mode closure and review-pipeline gate

**Intent:** When the Resume Mode triage queue drains, the project must cleanly exit SDD transition: clear the `transition: true` flag, record totals, and re-arm the gates that were suspended during drain. The PR-boundary review pipeline must stay silent while triage items remain open so legacy code does not trigger review agents before the spec is real.

**Applies To:** User

**Acceptance Criteria:**

1. Resolving the final open triage item clears transition. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Resume Mode — picking up where you left off --> <!-- @manual -->
2. Transition closure records resolved and lost entry totals. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Resume Mode — picking up where you left off --> <!-- @manual -->
3. Transition closure leaves `enforce_tdd` unchanged. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Resume Mode — picking up where you left off --> <!-- @manual -->
4. Transition closure preserves the triage file as its audit record. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Resume Mode — picking up where you left off --> <!-- @manual -->
5. Open transition triage suppresses the Claude PR-review hooks. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::SDD transition gate (REQ-AGENT-022) --> <!-- @test: host/__tests__/git-push-review-reminder.test.js (git-push-review-reminder.sh - SDD transition gate (REQ-AGENT-022)) --> <!-- @manual -->
6. Open transition triage suppresses Pi PR review. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::isReviewTransitionSuspended --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-092/REQ-AGENT-047: suspends root and nested SDD layouts only during an open transition) -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-038](#req-agent-038-resume-mode-drain-workflow)

**Verification:** Automated test ([review-helpers](../../src/__tests__/lib/review-helpers.test.ts))

**Status:** Implemented

---

### REQ-AGENT-048: Audit accumulator surfaces

**Intent:** SDD ships two adjacent audit-trail surfaces beyond the spec review queue: an optional doc-lane coverage accumulator persisted by the root, and a `/sdd clean` execution audit. The locations and lifecycle of these surfaces are specified here so neither workflow re-derives them.

**Applies To:** Agent

**Acceptance Criteria:**

1. Doc-updater remains report-only. When its report contains a substantive coverage record worth retaining, the root may lazy-create `documentation/.doc-coverage.md` or place the record in the applicable commit body; no scaffold-time placeholder is created. <!-- @impl: preseed/agents/claude/agents/doc-updater.md::REPORT-ONLY --> <!-- @impl: preseed/agents/claude/skills/doc-enforce/SKILL.md::Output contract --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-086 AC3-AC5: seeded reviewers and review command carry the report-only root-handoff contract) --> <!-- @manual -->
2. The `/sdd clean` execution audit lives in per-category commit bodies (recoverable via `git log --grep='\[sdd-clean\]'`), not in a dotfile. <!-- @test: host/__tests__/skill-sdd-clean-contract.test.js (REQ-AGENT-048: Audit accumulator surfaces (sdd-clean half)) --> <!-- @manual -->

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-AGENT-033](#req-agent-033-sdd-init-scaffolding-and-canonical-render), [REQ-AGENT-037](#req-agent-037-sdd-clean-rescue-and-autonomy-modes)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-049: Auto-upgrade preseed on release

**Intent:** When a new codeflare release ships changed preseed content (agent skills, rules, plugins), the user's R2 bucket should be reconciled automatically on first dashboard load - no manual "Recreate Agent Skills & Rules" click required. Session creation and stopped-session access are prevented in the UI during the brief upgrade.

**Applies To:** User

**Acceptance Criteria:**

1. The preseed generation script computes a deterministic content hash over all preseed documents (sorted by key) and emits it as a build-time constant accessible to the runtime. <!-- @impl: src/lib/agent-seed.generated.ts::PRESEED_CONTENT_HASH --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. After a successful reconcile (manual or auto), the applied hash is persisted in the user's preferences store. <!-- @test: src/__tests__/routes/storage-seed.test.ts (Agent Config Seed Routes / REQ-AGENT-011 (skills/rules manually recreatable)) --> <!-- @manual -->
3. On initial dashboard load, the backend compares the stored hash against the build-time constant (and, under enterprise, the stored session mode against the forced Pro mode) and returns whether an upgrade is needed. This check is omitted from periodic polling to avoid overhead. <!-- @test: src/__tests__/routes/session-batch-status.test.ts (returns preseedNeedsUpgrade true when hash missing from preferences) --> <!-- @test: src/__tests__/routes/session-batch-status.test.ts (enterprise: returns preseedNeedsUpgrade true when stored sessionMode is not advanced despite matching hash) --> <!-- @manual -->
4. On initial dashboard load, if an upgrade is needed, the frontend triggers the reconcile in the background. <!-- @impl: web-ui/src/stores/session.ts::loadSessions --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (Session Store) -->
5. While the upgrade is in progress, the "+ New Session" button is disabled and displays "Upgrading" (both Dashboard and SessionDropdown), and stopped session cards are visually dimmed (reduced opacity) and click-disabled. <!-- @impl: web-ui/src/stores/session.ts::loadSessions --> <!-- @test: web-ui/src/__tests__/components/SessionStatCard.test.tsx (REQ-AGENT-049 AC6: stopped card dimmed during preseed upgrade) -->
6. If the auto-upgrade fails, the error is logged but the dashboard remains fully usable. A page refresh retries the check. <!-- @impl: web-ui/src/stores/session.ts::loadSessions --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-AGENT-049 AC7: should clear preseedUpgrading on failure so dashboard remains usable) -->
7. The reconcile respects the user's current session mode and tier (standard/pro/unlimited) - identical behavior to the manual "Recreate" button. <!-- @test: src/__tests__/routes/storage-seed.test.ts (Agent Config Seed Routes / REQ-AGENT-011 (skills/rules manually recreatable)) --> <!-- @manual -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-AGENT-011](#req-agent-011-agent-skills--rules-manually-recreatable-from-settings), [REQ-AGENT-014](#req-agent-014-manifest-driven-preseed-pipeline)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-050: Pi-Native `/review` Workflow Skill

**Intent:** Pi users running `/review` must get the same multi-perspective workflow as Claude users through a dedicated Pi-native review skill, separate from PR-boundary enforcement.

**Applies To:** User

**Acceptance Criteria:**

1. The Pi `/review` command injects a dedicated Pi-native `review` skill that mirrors the Claude `commands/review.md` workflow, instead of injecting the `git-review-pipeline` enforcement skill. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::dispatchReview --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-050 AC1/REQ-AGENT-088 AC1: dispatches the dedicated /review workflow contract) -->
2. The Pi `review` skill is the user-invoked review workflow (multi-perspective specialist subagents, cross-reference, architecture-decision filter, optional external verification, interactive triage), explicitly distinct from PR-boundary enforcement; it does not run the `git-review-pipeline`. <!-- @manual: Start Pi from a workspace parent, run `/review --diff`, confirm the dedicated review workflow receives the absolute project root and report-only execution contract, then repeat in a fixture lacking `sdd/` or `documentation/` and confirm the documentation lane produces the stable no-op report. -->
3. The skill scopes review by `--all` or `--diff` parsed from the appended command line, prints help and runs no phases when neither flag is present, and supports the `--deep` and `--verify-high` flags. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::dispatchReview --> <!-- @manual -->
4. The skill is static-analysis only: it never runs builds, tests, or linters (the container is resource-constrained). <!-- @manual -->
5. The skill maps Claude primitives to Pi-native ones: subagents spawn via Pi's `Agent` tool with `subagent_type`, graph queries use Pi-native `graphify_query`/`graphify_path`/`graphify_explain`, and plan entry uses the `Plan` agent or an explicit written-and-approved plan. <!-- @manual -->
6. The skill is delivered advanced-only via the Pi manifest (`skills/review/SKILL.md`) through the standard seed pipeline. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
7. When either `sdd/` or `documentation/` is absent, the documentation lane returns a stable no-op report instead of leaving a missing artifact. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::reviewDocumentationSurfaceDecision --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-050 AC7: resolves the documentation lane to a stable no-surface report) -->

**Constraints:**

- The skill mirrors the Claude `/review` interactive-triage contract from [REQ-AGENT-015](#req-agent-015-review-command-for-multi-perspective-codebase-review): findings are never auto-applied; the user confirms each fix.

**Priority:** P1

**Dependencies:** [REQ-AGENT-007](#req-agent-007-multi-agent-adaptation-pipeline), [REQ-AGENT-015](#req-agent-015-review-command-for-multi-perspective-codebase-review)

**Verification:** Automated test ([pi-review-scope](../../src/__tests__/lib/pi-review-scope.test.ts))

**Status:** Implemented

---

### REQ-AGENT-051: Pi `/debug`, `/deploy`, and `/brainstorm` Commands

**Intent:** Workflows that Claude ships as slash commands (`/debug`, `/deploy`, `/brainstorm`) are unavailable in Pi because Claude commands do not deploy to Pi. Pi must reimplement them as native command handlers so Pi users get the same systematic debugging, deploy-and-verify, and structured-brainstorming workflows.

**Applies To:** User

**Acceptance Criteria:**

1. A Pi extension registers three native commands: `debug`, `deploy`, and `brainstorm`. <!-- @impl: preseed/agents/pi/extensions/codeflare-commands.ts::dispatchDebug --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi /debug, /deploy, /brainstorm commands / REQ-AGENT-051 (Claude-only slash commands reimplemented as Pi native command handlers)) -->
2. Each command injects its adapted workflow text plus the user's input, rather than loading a SKILL.md, because these workflows have no Pi skill file. <!-- @impl: preseed/agents/pi/extensions/commands-helpers.ts::commandInstructions --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi /debug, /deploy, /brainstorm commands / REQ-AGENT-051 (Claude-only slash commands reimplemented as Pi native command handlers)) -->
3. `/debug` runs a systematic root-cause debugging workflow (no fixes before root cause is established; the 3-Fix Rule). <!-- @impl: preseed/agents/pi/extensions/commands-helpers.ts::DEBUG_WORKFLOW --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi /debug, /deploy, /brainstorm commands / REQ-AGENT-051 (Claude-only slash commands reimplemented as Pi native command handlers)) -->
4. `/deploy` runs the push, stale-CI cancellation, CI monitoring, deploy, and live-URL verification workflow. <!-- @impl: preseed/agents/pi/extensions/commands-helpers.ts::DEPLOY_WORKFLOW --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi /debug, /deploy, /brainstorm commands / REQ-AGENT-051 (Claude-only slash commands reimplemented as Pi native command handlers)) -->
5. `/brainstorm` runs a structured option-generation workflow that produces trade-offs and a recommendation. <!-- @impl: preseed/agents/pi/extensions/commands-helpers.ts::BRAINSTORM_WORKFLOW --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi /debug, /deploy, /brainstorm commands / REQ-AGENT-051 (Claude-only slash commands reimplemented as Pi native command handlers)) -->
6. The extension is delivered advanced-only via the Pi manifest through the standard seed pipeline. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (AC6: codeflare-commands.ts is delivered advanced-only through the seed pipeline (manifest mode-gate)) --> <!-- @manual -->

**Constraints:**

- These commands adapt the Claude command workflows to Pi-native tool surfaces; they are not generic transforms of the Claude command files (Claude commands are not deployed to Pi).

**Priority:** P1

**Dependencies:** [REQ-AGENT-007](#req-agent-007-multi-agent-adaptation-pipeline)

**Verification:** Automated test ([agent-seed-manifest](../../src/__tests__/lib/agent-seed-manifest.test.ts))

**Status:** Implemented

---

### REQ-AGENT-052: Pi Commit-Attribution and Local-Build Hook Hardening

**Intent:** Pi's PreToolUse guards that block AI attribution and local builds must cover the same surfaces and detection set as the canonical Claude hooks, so no attributed commit, PR, issue, release, or tag can slip through any subcommand and a local build is not silently allowed.

**Applies To:** Agent

**Acceptance Criteria:**

1. The attribution guard fires not only on `git commit` and `gh pr create` but across `git merge`, `git tag`, `git notes`, and the `gh pr`, `gh issue`, and `gh release` subcommand families, including accepted global-option forms. <!-- @impl: preseed/agents/pi/extensions/guard-helpers.ts::attributionBlockReason --> <!-- @test: host/__tests__/pi-review-workset.test.js (REQ-AGENT-052/REQ-AGENT-063: Pi structurally finds executable Git across shell composition) --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi commit-attribution and local-build guards / REQ-AGENT-052 (Pi PreToolUse guards match the canonical Claude detection sets)) -->
2. The attribution detection set matches genuine attribution signatures only - the canonical commit-attribution-block set plus the brain emoji and `ChatGPT` as a deliberate Pi-guard superset since a Pi session may run a non-Claude model. <!-- @impl: preseed/agents/pi/extensions/guard-helpers.ts::attributionBlockReason --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi commit-attribution and local-build guards / REQ-AGENT-052 (Pi PreToolUse guards match the canonical Claude detection sets)) -->
3. The attribution guard does not match a bare `Claude`, so `git`/`gh` commands that name `preseed/agents/claude/` paths are not false-positives. <!-- @impl: preseed/agents/pi/extensions/guard-helpers.ts::attributionBlockReason --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi commit-attribution and local-build guards / REQ-AGENT-052 (Pi PreToolUse guards match the canonical Claude detection sets)) -->
4. The local-build guard covers the package-manager build/test/lint/typecheck/dev verbs plus `pytest`, `vitest`, `go test`, `swift test`, `cargo test`, `tsc`, `eslint`, `oxlint`, `prettier`, and `wrangler dev`. <!-- @impl: preseed/agents/pi/extensions/guard-helpers.ts::isLocalBuildCommand --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi commit-attribution and local-build guards / REQ-AGENT-052 (Pi PreToolUse guards match the canonical Claude detection sets)) -->
5. The local-build guard honors a user-only consume-on-use sentinel at `/tmp/local-build-bypass`: when present, the guard deletes it and allows the one command through; the block message names the override path. <!-- @impl: preseed/agents/pi/extensions/guard-helpers.ts::localBuildBlockReason --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi commit-attribution and local-build guards / REQ-AGENT-052 (Pi PreToolUse guards match the canonical Claude detection sets)) -->

**Constraints:**

- The attribution and local-build detection sets are kept aligned with the canonical Claude hook scripts (`block-attributed-commits.sh`, the no-local-builds rule); divergence is a regression, except the documented Pi superset (brain emoji + `ChatGPT`) in AC2.
- The bypass sentinel is user-only and consume-on-use, mirroring the user-only `/tmp/review-bypass` sentinel discipline in [REQ-AGENT-041](#req-agent-041-pr-boundary-review-bypass-surfaces) AC1.

**Priority:** P1

**Dependencies:** [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers)

**Verification:** Automated test ([agent-seed-manifest](../../src/__tests__/lib/agent-seed-manifest.test.ts))

**Status:** Implemented

---

### REQ-AGENT-053: Pi Native Review Result Correlation

**Intent:** Pi review completion must be proven only by visible public reviewer calls and their correlated successful terminal evidence in the root transcript.

**Applies To:** User

**Acceptance Criteria:**

1. Only eligible public reviewer calls after the latest successful boundary can satisfy its review window. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-055/REQ-AGENT-063: correlates reviewers after the latest executable git or gh candidate) -->
2. A reviewer lane becomes terminal at its first correlated successful native notification or public result retrieval; later equivalent evidence does not reopen that completion boundary. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-053/REQ-AGENT-059: correlates successful native notifications by XML tool-use-id) --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-098: first public reviewer result keeps triage complete after later terminal evidence) -->
3. A failed native reviewer notification leaves its lane unacknowledged and eligible for relaunch. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: failed reviewer notification remains unacknowledged and recoverable) -->
4. A reviewer call without correlated successful terminal evidence remains in flight without an age timeout. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-071/REQ-AGENT-074: keeps unmatched reviewer calls in flight until native terminal notification) -->
5. Except for an explicit REQ-AGENT-041 user bypass of the validated open PR head, acknowledgement changes only after every required reviewer reports successful completion and the root publishes its post-notification triage proof. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: acknowledges only after terminal lanes and triage) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-041: an explicit post-boundary user bypass acknowledges the exact PR head) -->
6. Completion for an earlier reminder never acknowledges a replacement PR head. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-074: never acknowledges terminal reviews for a replacement PR head) -->
7. Delayed successful completion acknowledges its reviewed head only while that head remains authoritative. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/055/074 + REQ-AGENT-080 AC6: delayed completion acknowledges the pushed review head, not unpublished local work) -->

**Constraints:**

- Native Pi task transcripts remain ordinary Pi history, not Codeflare review state.

**Priority:** P1

**Dependencies:** [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch)

**Verification:** Automated test ([Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts))

**Status:** Implemented

---

### REQ-AGENT-055: Pi Session-Scoped Review Window

**Intent:** Pi review completion must use the latest root-transcript boundary and correlated reviewer terminal evidence as its complete session-scoped window, without pending JSON, roll-forward state, or a merge interceptor.

**Applies To:** User

**Acceptance Criteria:**

1. Only reviewer calls after the latest successful boundary belong to its active window. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-055/REQ-AGENT-063: correlates reviewers after the latest executable git or gh candidate) -->
2. Partial or failed reviewer completion leaves acknowledgement unchanged. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: failed reviewer notification remains unacknowledged and recoverable) -->
3. Completion for an earlier reminder never acknowledges a replacement PR head. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-074: never acknowledges terminal reviews for a replacement PR head) -->
4. Child sessions and shutdown cannot acknowledge active review. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-058: keeps child sessions inert for reminders, settled follow-ups, and state writes) -->
5. The emitted review window persists its boundary tool call, repository, branch, PR, base, and full head. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendLaunchMessage --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074/REQ-AGENT-110/REQ-AGENT-132: emits one plan before settled recovery) --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-071: counts reviewer calls only when their prompt carries the acknowledged-to-current range) -->
6. Delayed successful completion may acknowledge the persisted unchanged PR identity after reload without consulting ambient active-repository memory. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-055: binds git -C review and acknowledgement to the boundary repository) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/055/074 + REQ-AGENT-080 AC6: delayed completion acknowledges the pushed review head, not unpublished local work) -->
7. An acknowledged current head requests no reviewer. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::requiredReviewLanes --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-068: acknowledged current branch state stays inert) -->

**Constraints:**

- Pi has no merge-command gate; after a merge, review is discovered only from synchronized checked-out-branch state under [REQ-AGENT-121](#req-agent-121-checked-out-branch-boundary-synchronization).

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch), [REQ-AGENT-053](#req-agent-053-pi-native-review-result-correlation), [REQ-AGENT-082](#req-agent-082-pi-review-range-selection)

**Verification:** Automated test ([Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts))

**Status:** Implemented

---

### REQ-AGENT-056: Pi Local Statusline Footer

**Intent:** Pi users need a compact footer in every session mode that shows session context without hiding extension-owned status rows.

**Applies To:** User

**Acceptance Criteria:**

1. The Pi local statusline extension is preseeded in both Standard and Pro modes. <!-- @impl: preseed/agents/pi/manifest.json::local-statusline.ts --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (REQ-AGENT-056 AC1: seeds the Pi local statusline in default and advanced modes) -->
2. The first footer line renders context usage, active model with thinking effort, and the active repository label when resolved. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::renderLine --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::contextPercent --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::repositoryLabel --> <!-- @test: src/__tests__/lib/local-statusline-repo.test.ts (REQ-AGENT-056: renders context, model effort, cwd repository, extension statuses, and width-safe truncation) -->
3. If cwd metadata is outside git, the footer falls back to active repository memory shared by the main Pi extension. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::rememberActiveRepo --> <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::recallActiveRepo --> <!-- @test: src/__tests__/lib/local-statusline-repo.test.ts (REQ-AGENT-056: resolves the active repository remembered by the main Pi extension) -->
4. The graphify active-cwd sentinel is display-only and accepted only for git repositories inside a session root. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::sentinelRepoForDisplay --> <!-- @test: src/__tests__/lib/local-statusline-repo.test.ts (REQ-AGENT-056: uses the display sentinel only when its repository is inside the session root) -->
5. Non-empty extension statuses render on a separate footer line without replacing session context. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::installFooter --> <!-- @test: src/__tests__/lib/local-statusline-repo.test.ts (REQ-AGENT-056: renders context, model effort, cwd repository, extension statuses, and width-safe truncation) -->
6. Footer lines are truncated by visible width, preserving ANSI color sequences and appending a reset before the ellipsis so colored statuses do not consume visible width or bleed styling past truncation. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::truncateToWidth --> <!-- @test: src/__tests__/lib/local-statusline-repo.test.ts (REQ-AGENT-056: renders context, model effort, cwd repository, extension statuses, and width-safe truncation) -->
7. The statusline refreshes on session start, resource discovery, turn boundaries, model changes, thinking-effort changes, and cache-TTL repaint intervals. <!-- @impl: preseed/agents/pi/extensions/local-statusline.ts::refreshFooter --> <!-- @test: src/__tests__/lib/local-statusline-repo.test.ts (REQ-AGENT-056: refreshes the footer on session, resource, turn, model, and effort changes) -->

**Constraints:**

- The statusline is cosmetic and must not block agent execution if repository or context metadata cannot be read.
- Idle sessions render no empty extra footer lines.

**Priority:** P2

**Dependencies:** [REQ-AGENT-004](#req-agent-004-two-session-modes-standard-and-pro), [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** Automated test ([Pi seed manifest tests](../../src/__tests__/lib/agent-seed-multi-agent.test.ts) (AC1); [Pi local statusline behavioral tests](../../src/__tests__/lib/local-statusline-repo.test.ts) (AC2-AC7))

**Status:** Implemented

---

### REQ-AGENT-058: Supported Boundary Recovery

**Intent:** Pi must recover review demand from the root transcript at agent end or settled fallback instead of depending on durable reconciliation, passive polling, or child-command visibility.

**Applies To:** User

**Acceptance Criteria:**

1. Settled enforcement recovers the latest successful supported root boundary only when its emitted window and fresh PR state report the same boundary-call, repository, branch, PR, base, and full-head identity. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-055: binds git -C review and acknowledgement to the boundary repository) -->
2. Without a successful persisted boundary window, settled enforcement performs no PR query and emits no follow-up. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036 + REQ-AGENT-080 AC6: an unpublished local commit emits no launch plan without a boundary) -->
3. A replacement PR identity is inert and cannot satisfy recovery. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-058: recovered review requires a matching emitted head) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-074: never acknowledges terminal reviews for a replacement PR head) -->
4. A temporarily unavailable or stale candidate boundary remains unevaluated and retries at root lifecycle recovery until GitHub reports the local full head SHA; only then does Pi emit and checkpoint one launch plan. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::currentReview --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::queryPr --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::queryHead --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-058/REQ-AGENT-063: lifecycle recovery preserves a transient non-delivery lookup) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-058/REQ-AGENT-132: preserves a temporarily stale pushed boundary until lifecycle recovery launches it) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-058 + REQ-AGENT-080 AC6: an eligible pushed boundary emits one authoritative launch plan) -->
5. Failed persisted pushes are not recovered as successful boundaries. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036: ignores a failed persisted push during settled enforcement) -->
6. Only calls after the latest successful boundary can satisfy recovered review demand. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-055/REQ-AGENT-063: correlates reviewers after the latest executable git or gh candidate) -->
7. A merged PR head without successful review acknowledgement never consumes a pending review-bypass sentinel or writes acknowledgement. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-041/REQ-AGENT-058/REQ-AGENT-113/REQ-AGENT-114: a merged PR releases Goal without consuming bypass or acknowledging) -->

**Constraints:**

- Pushes performed outside the active root Pi session are detected only when a later supported root boundary appears.
- Pi creates no review audit/event ledger.
- A merged unacknowledged head emits one structured visibility notice with its head, PR state, and unwritten acknowledgement.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-055](#req-agent-055-pi-session-scoped-review-window)

**Verification:** Automated test ([Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts))

**Status:** Implemented

---

### REQ-AGENT-059: Pi Native Review Findings Handoff

**Intent:** Reviewer findings must reach the main session through each native subagent result, without Codeflare-owned result files, summaries, severity parsing, or an automatic fix state machine.

**Applies To:** User

**Acceptance Criteria:**

1. Tool-use-ID correlation leaves each native reviewer result intact for the main session. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-053/REQ-AGENT-059: correlates successful native notifications by XML tool-use-id) -->
2. Correlated successful native notifications or public result retrievals are the completion proof. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: acknowledges only after terminal lanes and triage) --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-098: first public reviewer result keeps triage complete after later terminal evidence) -->
3. Every ranged PR-boundary plan carries the executable diff work-set contract. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendLaunchMessage --> <!-- @impl: preseed/agents/pi/extensions/review-scope.ts::scopeContract --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074/REQ-AGENT-110/REQ-AGENT-132: emits one plan before settled recovery) -->
4. `/review` maps diff and all flags to their executable work sets. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::reviewCommandDecision --> <!-- @impl: preseed/agents/pi/extensions/review-scope.ts::scopeContract --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (AC3: resolves /review diff and all into executable work-set contracts) -->
5. `/sdd clean` rejects invalid scope flags before dispatching its resolved work set. <!-- @impl: preseed/agents/pi/extensions/sdd-helpers.ts::sddCommandDecision --> <!-- @impl: preseed/agents/pi/extensions/sdd-helpers.ts::sddWorkflowScopeText --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (dispatches the resolved /sdd clean work set and rejects ambiguous scope flags) -->
6. The shared packet builder validates diff ancestry and returns only lane-owned changed hunks. <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs::buildReviewPacket --> <!-- @test: host/__tests__/pi-review-workset.test.js (REQ-AGENT-059 AC6: diff packets contain only lane-owned changed hunks) -->
7. All scope returns the tracked lane tree without a diff patch. <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs::buildReviewPacket --> <!-- @test: host/__tests__/pi-review-workset.test.js (REQ-AGENT-059 AC7: all scope enumerates the lane tree while diff rejects an invalid range) -->

**Constraints:**
- Main-session rules require waiting for every required reviewer before fixing, committing, or pushing.
- The main session verifies and fixes legitimate findings unless the latest user instruction says to wait or not autofix.
- Report-only reviewer types never own a `/review` mutation phase; triage/history/ADR/issue writes route to a non-review mutation agent.

**Priority:** P1

**Dependencies:** [REQ-AGENT-053](#req-agent-053-pi-native-review-result-correlation), [REQ-AGENT-071](#req-agent-071-pr-boundary-review-agent-dispatch)

**Verification:** Automated test ([Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts), [Pi scope entry-point tests](../../src/__tests__/lib/pi-review-scope.test.ts), [Pi review work-set tests](../../host/__tests__/pi-review-workset.test.js))

**Status:** Implemented

---

<a id="req-agent-063-pr-boundary-command-parsing"></a>
### REQ-AGENT-063: PR-Boundary Candidate Detection

**Intent:** Pi identifies executable Git and GitHub CLI activity across supported shell tool-result surfaces without interpreting subcommands, flags, selectors, or refspecs as eligibility evidence.

**Applies To:** User

**Acceptance Criteria:**

1. Only successful supported shell tool results expose commands to candidate detection. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-063: extracts boundaries only from supported shell tool result surfaces) -->
2. Any executable `git` or `gh` command is a candidate regardless of its subcommand, options, or arguments. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewBoundaryCommand --> <!-- @impl: preseed/agents/pi/extensions/guard-helpers.ts::executableShellCommands --> <!-- @test: host/__tests__/pi-review-workset.test.js (REQ-AGENT-052/REQ-AGENT-063: Pi structurally finds executable Git across shell composition) -->
3. Commands are recognized only at executable shell command boundaries, so quoted text and heredoc bodies remain inert. <!-- @impl: preseed/agents/pi/extensions/guard-helpers.ts::executableShellCommands --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewBoundaryCommand --> <!-- @test: host/__tests__/pi-review-workset.test.js (REQ-AGENT-052/REQ-AGENT-063: Pi structurally finds executable Git across shell composition) -->
4. Candidate detection never decides PR eligibility; [REQ-AGENT-121](#req-agent-121-checked-out-branch-boundary-synchronization) performs the authoritative branch-and-head check. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::currentReview --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063: checks authoritative current-branch state after any git or gh command) -->
5. Supported shell surfaces are Bash, shell `ctx_execute`, and `ctx_batch_execute`. <!-- @impl: preseed/agents/pi/extensions/active-repo-memory.ts::shellInvocations --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-063: extracts boundaries only from supported shell tool result surfaces) -->

**Constraints:**

- Candidate detection remains broad and cheap.
- Eligibility evidence consists only of GitHub PR state, the checked-out branch, and exact local-head equality.

**Priority:** P1

**Dependencies:** None.

**Verification:** Automated test ([Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts))

**Status:** Implemented

---

### REQ-AGENT-064: Connect to Cloudflare via OAuth

**Intent:** In non-enterprise modes a user connects their own Cloudflare account via OAuth — mirroring the GitHub connect — so the per-user deploy token is obtained without pasting a dashboard-created API token. One operator-registered OAuth client serves every user; each user authorizes their own account.

**Applies To:** User

**Acceptance Criteria:**

1. The Cloudflare OAuth integration supports authorize, exchange, refresh, and revoke; encrypted OAuth credentials reuse the bucket deploy-key fields without a new key. Exchanges use `client_secret_post` and surface Cloudflare `error_description` on failure. <!-- @impl: src/lib/cloudflare-token.ts::postToken --> <!-- @test: src/__tests__/lib/cloudflare-token.test.ts (CloudflareOAuthProvider) -->
2. `GET /api/cloudflare/connect`, its callback, and `POST /api/cloudflare/disconnect` are gated by authentication only (any authenticated user) — reachable from Guided Setup and the Settings accordion, never tier-gated — and the token never reaches the browser. <!-- @impl: src/routes/cloudflare.ts::app --> <!-- @test: src/__tests__/routes/cloudflare-oauth.test.ts (GET /auth/cloudflare/connect/callback) -->
3. The callback binds a signed, single-use state to the initiating user's bucket, rejecting forged, expired, or replayed states without exchanging the code; success stores the token and auto-selects a sole accessible account, else redirects to an account picker. <!-- @impl: src/lib/cloudflare-token.ts::connectCloudflare --> <!-- @test: src/__tests__/routes/cloudflare-oauth.test.ts (GET /auth/cloudflare/connect/callback) -->
4. A currently valid token is returned, refreshed within the skew window, and fails closed rather than returning a stale token. <!-- @impl: src/lib/cloudflare-token.ts::getValidCloudflareToken --> <!-- @test: src/__tests__/lib/cloudflare-token.test.ts (getValidCloudflareToken) -->
5. The connect URL carries a scope `tier`; the server maps it to the OAuth `scope`, with every tier including `analytics.read` and `offline_access` so zone analytics are readable and a refresh token is issued. <!-- @impl: src/lib/oauth-scopes.ts::cloudflareScopeForTier --> <!-- @test: src/__tests__/routes/cloudflare-oauth.test.ts (feeds every scope tier into OAuth with Analytics read and offline access) -->
6. The operator's Cloudflare OAuth client id + secret are configured in the admin-gated Setup wizard (KV; id plain, secret encrypted at rest, fail-closed without `ENCRYPTION_KEY`), mirroring the GitHub provider config ([REQ-GITHUB-008](github.md#req-github-008-enterprise-github-provider-configuration-via-setup)). <!-- @test: src/__tests__/routes/setup.test.ts (Setup Routes / REQ-SETUP-001 (zero pre-config first-time setup) / REQ-SETUP-002 (step sequence) / REQ-SETUP-004 (idempotent setup) / REQ-SETUP-012 (setup completion record)) --> <!-- @manual -->
7. Enterprise is unchanged: the OAuth provider resolves to none in enterprise, so every Cloudflare-OAuth route fails closed there; enterprise keeps the admin-global Browser Rendering token ([REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)). <!-- @impl: src/lib/cloudflare-token.ts::getCloudflareProvider --> <!-- @test: src/__tests__/lib/cloudflare-token.test.ts (applyCloudflareOAuthToken (REQ-AGENT-078: injects the placeholder, real token never in the container)) -->

**Constraints:**

- One OAuth client per operator account; each user authorizes their own Cloudflare account.
- The operator's OAuth client must be registered with `token_endpoint_auth_method = client_secret_post`.
- Cloudflare's client-secret **rotation is broken** (Cloudflare-side bug): only the secret returned at client *creation* authenticates.
- The exact OAuth scope set must be granted on the operator's client — see the [Configuration](../../documentation/lanes/configuration.md) lane and verify against `GET /client/v4/oauth/scopes`.

**Priority:** P1

**Dependencies:** [REQ-AGENT-029](#req-agent-029-deploy-credential-propagation-to-container)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-AGENT-078: Cloudflare OAuth token refreshed at the `api.cloudflare.com` boundary

**Intent:** A Cloudflare-dashboard OAuth **access token** is short-lived by design (expires in hours), so baking it into the container as `CLOUDFLARE_API_TOKEN` at start left a running non-enterprise session broken after expiry — `wrangler` and browser-run both got `9109 Invalid access token`, with nothing refreshing the container's env var. Instead of baking the real token, inject a non-secret placeholder and intercept `api.cloudflare.com` at the container-egress boundary, stamping a **freshly refreshed** token per request. This reuses the enterprise Browser Rendering interceptor's transport ([REQ-BROWSER-008](browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container)) — one interceptor per host, serving two modes — rather than adding a new class, a container-side refresher, or new storage.

**Applies To:** User

**Acceptance Criteria:**

1. When the session's Cloudflare token source is `'oauth'`, the container receives only a non-secret placeholder (`CLOUDFLARE_OAUTH_TOKEN_PLACEHOLDER`) as `CLOUDFLARE_API_TOKEN` — the real access token never enters the container env. A non-oauth source (PAT / enterprise) is passed through untouched. <!-- @impl: src/lib/cloudflare-token.ts::applyCloudflareOAuthToken --> <!-- @impl: src/lib/constants.ts::CLOUDFLARE_OAUTH_TOKEN_PLACEHOLDER --> <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/lib/cloudflare-token.test.ts (applyCloudflareOAuthToken (REQ-AGENT-078: injects the placeholder, real token never in the container)) -->
2. In OAuth sessions (non-enterprise, oauth source only) `api.cloudflare.com` is intercepted and every request — on every path — is re-stamped with a token refreshed within the skew window, so the forwarded credential is the refreshed token, not the baked placeholder. <!-- @impl: src/cloudflare-browser-interceptor.ts::fetchOAuth --> <!-- @impl: src/container/container-interception.ts::cloudflareOauthApi --> <!-- @test: src/__tests__/cloudflare-browser-interceptor.test.ts (stamps a FRESH refreshed token on ANY api.cloudflare.com path (e.g. wrangler), egress DIRECT) -->
3. Both the REST surface and the CDP WebSocket upgrade (browser-run) are stamped and forwarded via the shared transport, so a session survives past the access-token lifetime for wrangler **and** interactive browser-run. <!-- @impl: src/cloudflare-browser-interceptor.ts::bridge --> <!-- @test: src/__tests__/cloudflare-browser-interceptor.test.ts (bridges the CDP upgrade with the fresh token, returning a FRESH client socket, direct not Gateway) -->
4. The token is resolved **solely** from the session-bound bucket, never from any request-supplied header — no cross-user token spoofing — and the interceptor fails closed with `401` and no upstream call when no valid token can be minted. <!-- @impl: src/cloudflare-browser-interceptor.ts::fetchOAuth --> <!-- @test: src/__tests__/cloudflare-browser-interceptor.test.ts (REQ-AGENT-078: CloudflareBrowserInterceptor OAuth mode (non-enterprise) — REST) -->
5. AI Gateway data-plane requests (`gateway.ai.cloudflare.com`) are intercepted in OAuth mode and stamped with the refreshed token as `cf-aig-authorization` (the token's `aig.run` scope), leaving the caller's `Authorization` untouched, so a connected user's authenticated AI Gateway survives past the token lifetime. <!-- @impl: src/cloudflare-browser-interceptor.ts::fetchOAuth --> <!-- @impl: src/cloudflare-browser-interceptor.ts::INTERCEPTED_CF_OAUTH_HOSTS --> <!-- @test: src/__tests__/cloudflare-browser-interceptor.test.ts (REQ-AGENT-078: OAuth mode — AI Gateway data-plane (gateway.ai.cloudflare.com)) -->
6. In an OAuth session the container trusts the platform-mounted intercept CA (`/etc/cloudflare/certs/cloudflare-containers-ca.crt`) so the intercepted `api.cloudflare.com` / `gateway.ai.cloudflare.com` TLS validates in agent runtimes instead of failing `SELF_SIGNED_CERT_IN_CHAIN`. <!-- @impl: entrypoint.sh::CF_OAUTH_CA_SRC --> <!-- @test: host/__tests__/entrypoint-oauth-ca-trust.test.js (REQ-AGENT-078 AC6: non-enterprise OAuth intercept-CA trust (entrypoint.sh)) -->

**Constraints:**

- Enterprise is untouched: the OAuth CF-API interception-registry entry (`cloudflareOauthApi`) is double-guarded (`!isEnterpriseMode` **and** placeholder-value match), so it can never wire or collide on `api.cloudflare.com` in enterprise; the enterprise branch is unchanged.
- The AI Gateway host lives only in `INTERCEPTED_CF_OAUTH_HOSTS` (never the enterprise browser list), so enterprise never intercepts its own `LlmInterceptor` gateway rewrites.
- `CLOUDFLARE_OAUTH_TOKEN_PLACEHOLDER` must stay distinct from `ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER` — the placeholder value is itself the DO's OAuth-mode wiring signal.
- The GitHub interceptor is not touched — non-enterprise git stays direct (GitHub tokens are long-lived); `api.cloudflare.com` and `gateway.ai.cloudflare.com` are the only hosts newly intercepted (OAuth-mode only).
- The AC6 CA-trust is an isolated `entrypoint.sh` sibling of the enterprise CA-trust: distinct `CF_OAUTH_CA_SRC` var + `# cf-ca-trust` sentinel, gated `ENTERPRISE_MODE != active` && CA-present; a no-interception deploy is byte-identical to before.

**Priority:** P1

**Dependencies:** [REQ-AGENT-064](#req-agent-064-connect-to-cloudflare-via-oauth), [REQ-BROWSER-008](browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container), [REQ-SEC-002](security.md#req-sec-002-api-tokens-never-enter-containers)

**Verification:** Automated test ([Interceptor test](../../src/__tests__/cloudflare-browser-interceptor.test.ts) + [Lib test](../../src/__tests__/lib/cloudflare-token.test.ts) + [OAuth CA-trust test](../../host/__tests__/entrypoint-oauth-ca-trust.test.js))

**Status:** Implemented

---

### REQ-AGENT-079: Advanced Cloudflare OAuth Tier Scope Catalog

**Intent:** The advanced Cloudflare OAuth tier requests the operator-finalized full-platform capability set, maintained as a single server-side catalog and pinned by a test so the connect flow, the tier tables, and the operator's registered client cannot silently drift — as they did when the catalog carried only 21 scopes while the docs described the full set and no test tied the two together.

**Applies To:** User

**Acceptance Criteria:**

1. The advanced tier's Cloudflare OAuth scope catalog requests exactly the 61 operator-verified Cloudflare scopes — including `analytics.read` and the AI family (Workers AI, AI Gateway `aig.*`, Agents Gateway `agw.*`, AI Search, AI Audit, Firewall for AI, Websearch) — plus `user-details.read` and the always-appended `offline_access`. <!-- @impl: src/lib/oauth-scopes.ts::cloudflareScopeForTier --> <!-- @impl: src/lib/oauth-scopes.ts::CF_ADVANCED --> <!-- @test: src/__tests__/lib/oauth-scopes.test.ts (REQ-BROWSER-002: Browser Rendering scope in the Cloudflare token template) -->
2. The advanced tier is a superset of recommended: it keeps the combined `zone-access.write`/`access-acct.write` and adds the granular Access ids (`access-app`/`access-policy`/`access-org`/`access-idp`/`access-group`), so every recommended (and every minimal) scope is present in advanced. <!-- @impl: src/lib/oauth-scopes.ts::CF_ADVANCED --> <!-- @test: src/__tests__/lib/oauth-scopes.test.ts (REQ-AGENT-079: cloudflareScopeForTier advanced-tier scope catalog) -->
3. `Logs: Edit` resolves to `logs.write` and `Firewall (Magic): Edit` to `magic-firewall.write`; three requested capabilities have no OAuth scope and are intentionally absent. <!-- @impl: src/lib/oauth-scopes.ts::CF_ADVANCED --> <!-- @test: src/__tests__/lib/oauth-scopes.test.ts (REQ-BROWSER-002: Browser Rendering scope in the Cloudflare token template) -->

**Constraints:**

- The operator's OAuth client must be registered with the full advanced superset; a per-connect request can only narrow within the registered scopes.
- The server-side catalog is the single source of truth; the public ([Configuration](../../documentation/lanes/configuration.md)) and private tier tables mirror it.

**Priority:** P2

**Dependencies:** [REQ-AGENT-064](#req-agent-064-connect-to-cloudflare-via-oauth)

**Verification:** Automated test ([oauth-scopes](../../src/__tests__/lib/oauth-scopes.test.ts))

**Status:** Implemented

---

### REQ-AGENT-065: Engineering Constitution Preseeded to All Agents

**Intent:** One always-on engineering constitution is hardwired into every preseed-managed agent so its four mandates are applied to all planning and coding without being restated each task: (1) no overengineering, (2) behavioral tests only — no theater or text-matching, (3) reusable/composable components and best practices, (4) SDD + TDD enforced (failing behavioral test first, every change traces to a REQ, specs/anchors/docs move with the code, nothing left `Partial`). It also imposes a **plan gate** (every plan must restate the four mandates as concrete success criteria) and a **done gate** (confirm them before declaring work complete). The preseed is the single source of truth; each per-user copy is a downstream seed artifact.

**Applies To:** Agent

**Acceptance Criteria:**

1. In advanced session mode, the constitution is seeded as a Claude rule — the preseed rule file is present and the seed manifest gates it to `advanced` only, matching the other engineering rules ([REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline)). <!-- @test: host/__tests__/engineering-constitution.test.js (seeds the Claude constitution rule, gated to advanced mode) --> <!-- @manual -->
2. Pi receives one compact native constitution rule in both session modes, with the shared four mandates aligned to the Claude canon and Pi-only review/CI mechanics owned by that native adaptation rather than a duplicate per-turn injection. <!-- @impl: preseed/agents/pi/rules/engineering-constitution.md::Four mandates --> <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: src/__tests__/lib/pi-compact-context.test.ts (REQ-AGENT-007/REQ-AGENT-095: compact Pi context generated from the Claude canon) -->

**Constraints:**

- The preseed is the single source of truth; the per-user `~/.claude/rules/engineering-constitution.md` is a downstream seed artifact, not separately authored.
- The Claude rule and the Pi `<codeflare_constitution>` block carry the same four mandates and must be kept in sync.
- Mode parity with the other engineering rules (advanced session mode); content correctness is prose and is intentionally not pinned by tests (mandate #2).

**Priority:** P1

**Dependencies:** [REQ-AGENT-024](#req-agent-024-advanced-session-mode-graph-first-discipline)

**Verification:** Automated test ([engineering-constitution](../../host/__tests__/engineering-constitution.test.js))

**Status:** Implemented

---

### REQ-AGENT-067: consult-llm Invocation and Model-Selection Behavior

**Intent:** consult-llm must only run when the user explicitly asks for external LLM input, and model selection must be explicit without leaking provider keys.

**Applies To:** User

**Acceptance Criteria:**

1. The skill is invoked only when the user's current request asks for external LLMs or names GPT, ChatGPT, Gemini, OpenAI, or `consult_llm`. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) --> <!-- @manual -->
2. Without a named model, the agent asks one model-selection question with latest Gemini, latest OpenAI, both, list-all, and the tool-provided write-in option. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) --> <!-- @manual -->
3. The list-all path reads concrete Gemini/OpenAI model IDs from the consult-llm startup log, not from provider selectors. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) --> <!-- @manual -->
4. Latest-model choices use server-side `"openai"` / `"gemini"` selectors and never perform provider model-list HTTP requests with raw keys. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) --> <!-- @manual -->
5. When the user names a specific model, no dialog is shown and that exact ID is passed. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-031/REQ-AGENT-067 consult-llm invocation behaviour (explicit gate + model dialog + selectors)) --> <!-- @manual -->

**Constraints:**

- Generic "second opinion" wording is not enough unless the user names external LLMs.
- Exact model discovery may fall back to clearly labelled provider selectors if the startup log is unreadable.

**Priority:** P1

**Dependencies:** [REQ-AGENT-031](#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-068: Independent Pi CI Monitoring

**Intent:** One background agent must monitor one exact protected-base PR head through a bounded, deterministic provider loop.

**Applies To:** Agent

**Acceptance Criteria:**

1. An eligible boundary resolves one public `ci-monitor` request only while its required full head equals the live protected-base PR head. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::resolveCiMonitorRequest --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-068 AC1: eligible push resolves the affected PR exactly once) --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-068 AC1: CI resolver rejects a live head that differs from the review plan) --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-068 AC1: CI request requires explicit head, review launch state, and repository cwd) -->
2. Valid check JSON remains usable when GitHub CLI returns a pending or failure exit status. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::monitorCi --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-068 AC2: valid check JSON is parsed despite gh exit statuses 1 and 8) -->
3. CI success requires the same non-empty all-terminal fingerprint in two polls. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::monitorCi --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-068 AC2/AC3: pending checks wait for a stable pass and skipping fingerprint) -->
4. An authoritative head mismatch reports `CI_RESULT timeout superseded`. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::monitorCi --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-068 AC4: a superseded head stops before checks are queried) -->

**Constraints:** Empty checks time out after five minutes; provider commands are bounded; total monitoring is bounded at thirty minutes; the root Pi Git workflow is the sole automatic trigger; Claude behavior is unchanged.

**Priority:** P1

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability)

**Verification:** Automated test ([Pi CI monitor behavioral tests](../../host/__tests__/pi-ci-monitor.test.js))

**Status:** Implemented

---

### REQ-AGENT-125: Pi CI result and launch checkpoint

**Intent:** CI must report provider failure faithfully and persist one exact successful launch identity without coupling that checkpoint to review acknowledgement.

**Applies To:** Agent

**Acceptance Criteria:**

1. Failed or cancelled checks report `CI_RESULT failure` with provider evidence, including providers whose workflow label is empty. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::monitorCi --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-125 AC1: a failed check with an empty workflow reports immediately) --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-125 AC1: failed and cancelled arbitrary providers report failure with links) -->
2. Monitoring creates no Codeflare state, log, or PID files. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::monitorCi --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-125 AC2: monitoring creates no Codeflare state, log, or PID files) -->
3. Malformed or transient provider responses never become success; every terminal check row has string provider fields, an HTTP(S) link, and a recognized bucket before evaluation. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::validCheckRow --> <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::monitorCi --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-125 AC3: malformed and transient GitHub responses never become success) --> <!-- @test: host/__tests__/pi-review-workset.test.js (REQ-AGENT-125 AC3: stable malformed provider rows never become CI success) -->
4. A correlated successful public monitor launch checkpoints its exact canonical repository, local path, PR, and head independently from review acknowledgement; failed or mismatched launches remain retryable. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::checkpointCiLaunch --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-125: checkpoints a successful CI launch before stale live transcript recovery) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-125: failed or mismatched direct CI launch results remain retryable) --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-125 AC4: CI request identity preserves repository paths containing whitespace) -->

**Constraints:** The monitor is report-only and seeded in Standard and Pro modes; review handoffs and shutdown never restart it; later sessions do not repeat an unchanged checkpointed head; enabling review still requires its lanes.

**Priority:** P1

**Dependencies:** [REQ-AGENT-068](#req-agent-068-independent-pi-ci-monitoring), [REQ-AGENT-098](#req-agent-098-pi-review-triage-acknowledgement-barrier)

**Verification:** Automated tests ([Pi CI monitor behavioral tests](../../host/__tests__/pi-ci-monitor.test.js), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts))

**Status:** Implemented

---

### REQ-AGENT-069: Pi consult-llm MCP lazy wiring

**Intent:** Pi must reach consult-llm through the MCP adapter without starting `consult-llm-mcp` until the user explicitly asks for external LLM input.

**Applies To:** User

**Acceptance Criteria:**

1. Pi reads `consult-llm` from `~/.pi/agent/mcp.json` through the pi-mcp-adapter `mcp` proxy. <!-- @impl: entrypoint.sh::configure_consult_llm --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (REQ-AGENT-069: Pi mcp.json mirrors the server through the lazy mcp proxy) -->
2. The Pi `consult-llm` entry uses `lifecycle:"lazy"`, so `consult-llm-mcp` starts on proxy use rather than session start. <!-- @impl: entrypoint.sh::_merge_consult_llm_mcp --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (REQ-AGENT-069: Pi mcp.json mirrors the server through the lazy mcp proxy) -->
3. Each container start replaces Codeflare's owned `mcpServers["consult-llm"]` object, removing stale `keep-alive` and `directTools` fields. <!-- @impl: entrypoint.sh::_merge_consult_llm_mcp --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (replaces only the owned consult-llm entry and stays idempotent across starts) -->
4. The replacement preserves unrelated user MCP servers in the same file. <!-- @impl: entrypoint.sh::_merge_consult_llm_mcp --> <!-- @test: host/__tests__/entrypoint-consult-llm.test.js (entrypoint consult-llm configuration / REQ-AGENT-031 (key isolation, subscription backend, Pi parity, enterprise gate)) -->

**Constraints:**

- The Claude server carries no Pi-only `lifecycle` field.
- Pi's native consult skill must call through `mcp`, not through a promoted direct tool.

**Priority:** P1

**Dependencies:** [REQ-AGENT-031](#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity), [REQ-AGENT-067](#req-agent-067-consult-llm-invocation-and-model-selection-behavior)

**Verification:** Automated test ([entrypoint consult-llm host test](../../host/__tests__/entrypoint-consult-llm.test.js))

**Status:** Implemented

---

### REQ-AGENT-070: Claude on-demand CI monitoring policy

**Intent:** Claude and Claude-transformed agents monitor CI for an eligible PR boundary, when a user asks, or when a deploy/merge decision needs a fresh result. CI remains independent from reviewer completion and acknowledgement.

**Applies To:** Agent

**Acceptance Criteria:**

1. Routine non-boundary pushes do not auto-start Claude `ci-monitoring`. <!-- @impl: preseed/agents/claude/rules/git-workflow.md::Hard obligations --> <!-- @manual -->
2. Claude invokes `ci-monitoring` for an eligible PR-boundary plan, an explicit request, or a fresh deploy/merge gate. PR-boundary CI starts independently after reviewer launch rather than waiting for review completion. <!-- @impl: preseed/agents/claude/rules/git-workflow.md::Hard obligations --> <!-- @manual -->
3. The Claude monitor launcher returns the monitored head, detached process identity, and durable log path. <!-- @impl: preseed/agents/claude/skills/ci-monitoring/SKILL.md::The monitor launcher --> <!-- @test: host/__tests__/ci-monitoring-skill.test.js (REQ-AGENT-070 AC3: Claude ci monitor launcher starts detached work and returns a durable log path) --> <!-- @manual -->
4. Claude success requires a non-empty workflow/run fingerprint that remains stable across two polls. <!-- @impl: preseed/agents/claude/skills/ci-monitoring/SKILL.md::Reading the result --> <!-- @test: host/__tests__/ci-monitoring-skill.test.js (REQ-AGENT-070 AC4: Claude ci monitor waits for a stable workflow/run set before success) --> <!-- @manual -->
5. A failed workflow row writes a terminal failure result to the durable log. <!-- @impl: preseed/agents/claude/skills/ci-monitoring/SKILL.md::Reading the result --> <!-- @test: host/__tests__/ci-monitoring-skill.test.js (REQ-AGENT-070 AC5: Claude ci monitor reports failed workflow rows) --> <!-- @manual -->
6. Unavailable GitHub CLI access writes a terminal timeout result to the durable log. <!-- @impl: preseed/agents/claude/skills/ci-monitoring/SKILL.md::Reading the result --> <!-- @test: host/__tests__/ci-monitoring-skill.test.js (REQ-AGENT-070 AC6: Claude ci monitor reports gh access failures in the durable log) --> <!-- @manual -->

**Constraints:**

- Claude monitoring remains independent of Pi's automatic policy in [REQ-AGENT-068](#req-agent-068-independent-pi-ci-monitoring).

**Priority:** P1

**Dependencies:** [REQ-AGENT-068](#req-agent-068-independent-pi-ci-monitoring)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-071: PR-Boundary Review Agent Dispatch

**Intent:** The main Pi session must launch the minimal required report-only reviewers together through visible public subagent calls and must not mistake one slow lane for completion of its peers.

**Applies To:** User

**Acceptance Criteria:**

1. Settled enforcement requests every missing required lane in one reviewer wave. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074/REQ-AGENT-110/REQ-AGENT-132: emits one plan before settled recovery) -->
2. An unmatched public reviewer call suppresses only its own lane until correlated successful terminal evidence arrives, while other missing lanes are requested together. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-071/REQ-AGENT-074: requests missing reviewers together without duplicating unmatched public calls) -->
3. Only public background reviewer calls with inherited context disabled count toward completion. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-071: rejects reviewer calls that inherit or omit parent context isolation) -->
4. Completion order does not change a lane's terminal state. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-071/REQ-AGENT-074: keeps unmatched reviewer calls in flight until native terminal notification) -->
5. A valid prior acknowledgement scopes lane selection to its acknowledged-to-current range. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::requiredReviewLanes --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-040: classifies generated, docs, spec, source, and mixed commit ranges into reviewer lanes) -->
6. Each counted reviewer prompt carries the exact valid acknowledged-to-current range. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewRange --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-071: counts reviewer calls only when their prompt carries the acknowledged-to-current range) -->
7. Missing, malformed, or non-ancestor acknowledgement requests full-PR review. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewRange --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-071: invalid acknowledgements request a full-PR review) -->

**Constraints:**

- Reviewer calls use `run_in_background: true` and `inherit_context: false`.
- Reviewers retain their complete lane enforcement policy.
- Each reviewer loads its lane packet once.
- Batching never truncates scoped rows or hunks.
- Review agents never edit or push.
- The root waits for every required result before changing the head.

**Priority:** P1

**Dependencies:** [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch), [REQ-AGENT-053](#req-agent-053-pi-native-review-result-correlation)

**Verification:** Automated test ([Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts))

**Status:** Implemented

---

### REQ-AGENT-074: Pi Settled Review Handoff

**Intent:** Pi must hand missing review work back to the main session and reliably acknowledge transcript-proven triage when the root agent run ends. It owns no review monitor, durable claim, or restart path.

**Applies To:** Agent

**Acceptance Criteria:**

1. Settled enforcement emits one follow-up containing every missing lane for the reminder head. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074/REQ-AGENT-110/REQ-AGENT-132: emits one plan before settled recovery) -->
2. An eligible boundary with invalid acknowledgement emits full-PR scope. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-071: invalid acknowledgements request a full-PR review) -->
3. Unmatched public reviewer calls are not duplicated, while missing peers are requested together. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-071/REQ-AGENT-074: requests missing reviewers together without duplicating unmatched public calls) -->
4. Complete successful reviewer completion followed by root triage in live session state acknowledges the reminder head at agent end, even before the session file flushes. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::acknowledgeCompletedReview --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-074: agent end acknowledges triage from live session state before disk flush) -->
5. Terminal evidence for an earlier reminder never acknowledges a replacement PR head. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-074: never acknowledges terminal reviews for a replacement PR head) -->
6. Child sessions are inert, and shutdown or reload alone writes no acknowledgement or replacement request. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-058: keeps child sessions inert for reminders, settled follow-ups, and state writes) -->
7. After reload or newer unpublished local work, delayed terminal evidence acknowledges its reminder head only while the authoritative PR head still matches that reviewed head. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::completedTriageReadyAfterResume --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::acknowledgeCompletedReview --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/055/074 + REQ-AGENT-080 AC6: delayed completion acknowledges the pushed review head, not unpublished local work) -->

**Constraints:**

- The handoff requests reviewer lanes directly.
- `ci-monitor` is never a reviewer or acknowledgement condition.
- No hidden fallback spawn or automatic restart exists.

**Priority:** P1

**Dependencies:** [REQ-AGENT-053](#req-agent-053-pi-native-review-result-correlation), [REQ-AGENT-055](#req-agent-055-pi-session-scoped-review-window), [REQ-AGENT-071](#req-agent-071-pr-boundary-review-agent-dispatch), [REQ-AGENT-082](#req-agent-082-pi-review-range-selection)

**Verification:** Automated test ([Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts))

**Status:** Implemented

---

### REQ-AGENT-075: Cloudflare Platform Skills Bundled into the Advanced Seed

**Intent:** Codeflare is a Cloudflare-native build platform AND an enterprise Zero Trust product, so the official Cloudflare skills ([github.com/cloudflare/skills](https://github.com/cloudflare/skills), Apache-2.0) are vendored into the advanced-mode agent seed via the existing manifest pipeline ([REQ-AGENT-014](#req-agent-014-manifest-driven-preseed-pipeline)) — giving Pro agents authoritative, retrieval-first guidance for Workers/KV/D1/R2, the Agents SDK, Durable Objects, stable and preview Sandbox SDK lines, Wrangler, Turnstile, email, web performance, and Cloudflare One (Zero Trust / SASE). The bundle is **slimmed for the Worker bundle budget**: the cloudflare mega-skill's 319-file `references/` tree is dropped (it is retrieval-first — agents fetch live docs), keeping only its decision-tree `SKILL.md`. The bundled remote-MCP config is excluded (strict-egress + interactive OAuth incompatible); retrieval is via WebFetch of `developers.cloudflare.com`.

**Applies To:** Agent

**Acceptance Criteria:**

1. The 13 skills (`cloudflare`, `cloudflare-one`, `cloudflare-one-migrations`, `wrangler`, `workers-best-practices`, `durable-objects`, `agents-sdk`, `sandbox-stable`, `sandbox-next`, `sandbox-migrate-to-next`, `turnstile-spin`, `cloudflare-email-service`, `web-perf`) and both build commands reach every skill-capable runtime in advanced mode only; default mode receives none. <!-- @test: src/__tests__/lib/cloudflare-skills-seed.test.ts (all 13 current Cloudflare skills are seeded to Claude and are advanced-only) --> <!-- @test: src/__tests__/lib/cloudflare-skills-seed.test.ts (bundles the 2 Cloudflare commands (advanced-only)) --> <!-- @test: src/__tests__/lib/cloudflare-skills-seed.test.ts (is seeded to non-Claude agents too (not Claude-only) — e.g. Pi gets the cloudflare skill) --> <!-- @test: src/__tests__/lib/cloudflare-skills-seed.test.ts (default mode receives NONE of the Cloudflare skills (advanced/Pro-only)) --> <!-- @manual -->
2. Stable Sandbox work, 1.0-preview work, and migration use distinct `sandbox-stable`, `sandbox-next`, and `sandbox-migrate-to-next` skills; the ambiguous `sandbox-sdk` skill is absent. <!-- @impl: preseed/agents/claude/manifest.json::skills/sandbox-stable/SKILL.md --> <!-- @impl: preseed/agents/claude/manifest.json::skills/sandbox-next/SKILL.md --> <!-- @impl: preseed/agents/claude/manifest.json::skills/sandbox-migrate-to-next/SKILL.md --> <!-- @test: src/__tests__/lib/cloudflare-skills-seed.test.ts (keeps stable, next, and migration Sandbox APIs as separate skills) --> <!-- @manual -->
3. The cloudflare mega-skill is slimmed: its `SKILL.md` decision tree is kept (with the dangling `references:` frontmatter removed) but the `references/` tree is NOT bundled, so the Worker bundle does not carry ~2.2 MB × every agent of retrieval-first reference markdown. <!-- @test: src/__tests__/lib/cloudflare-skills-seed.test.ts (SLIMS the cloudflare mega-skill: SKILL.md is kept, the references/ tree is NOT bundled) --> <!-- @manual -->
4. Doc retrieval is via WebFetch of `developers.cloudflare.com`: a `paths:`-scoped `rules/cloudflare-workers.md` (loaded only on Workers files, not always-on) carries the retrieval-first guidance, and the upstream remote-MCP config (`.mcp.json`) is NOT bundled. <!-- @test: src/__tests__/lib/cloudflare-skills-seed.test.ts (the Workers retrieval rule is path-conditional (not always-on) and WebFetch-oriented) --> <!-- @manual -->
5. The upstream Apache-2.0 `LICENSE` is vendored alongside the skills for attribution. <!-- @test: src/__tests__/lib/cloudflare-skills-seed.test.ts (carries the upstream Apache-2.0 LICENSE alongside the vendored skills (attribution)) --> <!-- @manual -->

**Constraints:**

- Bundled via the manifest pipeline ([REQ-AGENT-014](#req-agent-014-manifest-driven-preseed-pipeline)); the per-user seed is a downstream artifact, never separately authored; Skill bodies/references load on demand (progressive disclosure), so the always-on token cost is only the trimmed one-line descriptions.
- In enterprise strict-egress ([REQ-ENTERPRISE-016](enterprise-mode.md#req-enterprise-016-strict-gateway-egress)), the operator must allowlist `developers.cloudflare.com` for the skills' retrieval to function (documented in the configuration + security lanes).
- Skill/command/rule prose is upstream-authored and intentionally not pinned by tests (mandate #2); tests assert bundling, mode-gating, slimming, and attribution — the contract — not copy.

**Priority:** P2

**Dependencies:** [REQ-AGENT-014](#req-agent-014-manifest-driven-preseed-pipeline)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-138: Bundled Turnstile Scripts Fail Closed

**Intent:** Bundled Turnstile automation must bound external requests, distinguish missing authorization from valid payload rejection, and remove transient persistence state after failure.

**Applies To:** Agent

**Acceptance Criteria:**

1. Every Turnstile API request applies bounded connection and total deadlines. <!-- @impl: preseed/agents/claude/skills/turnstile-spin/scripts/auth-probe.sh::probe_response --> <!-- @impl: preseed/agents/claude/skills/turnstile-spin/scripts/widget-create.sh::API_RESPONSE --> <!-- @impl: preseed/agents/claude/skills/turnstile-spin/scripts/validate.sh::WIDGET_RESPONSE --> <!-- @test: host/__tests__/turnstile-spin-scripts.test.js (bounds the auth probe and reports curl timeout failure) --> <!-- @test: host/__tests__/turnstile-spin-scripts.test.js (bounds cleanup after an unexpected widget creation) --> <!-- @test: host/__tests__/turnstile-spin-scripts.test.js (bounds widget creation and returns structured network failure) --> <!-- @test: host/__tests__/turnstile-spin-scripts.test.js (bounds widget metadata validation requests) --> <!-- @test: host/__tests__/turnstile-spin-scripts.test.js (bounds dummy-token Siteverify requests) -->
2. Error code 10000 is classified as missing scope regardless of HTTP status. <!-- @impl: preseed/agents/claude/skills/turnstile-spin/scripts/auth-probe.sh::first_code --> <!-- @test: host/__tests__/turnstile-spin-scripts.test.js (classifies Cloudflare code 10000 over HTTP 400 as missing scope) -->
3. Skill persistence removes its temporary clone after failure. <!-- @impl: preseed/agents/claude/skills/turnstile-spin/scripts/persist-skill.sh::TEMP_DIR --> <!-- @test: host/__tests__/turnstile-spin-scripts.test.js (removes its temporary clone after persistence fails) -->

**Constraints:**

None.

**Priority:** P2

**Dependencies:** [REQ-AGENT-075](#req-agent-075-cloudflare-platform-skills-bundled-into-the-advanced-seed)

**Verification:** Automated tests ([Turnstile script tests](../../host/__tests__/turnstile-spin-scripts.test.js))

**Status:** Implemented

---

### REQ-AGENT-134: Advanced Design Skill Suite

**Intent:** Advanced sessions expose one composable design entry point that routes interface, UX-system, static-art, and frontend-direction work to focused skills without copying every specialist into the always-on prompt.

**Applies To:** Agent

**Acceptance Criteria:**

1. Advanced mode delivers `design`, `ui-ux-pro-max`, `canvas-design`, and `frontend-design` to Claude and every skill-capable generated runtime; default mode receives none. <!-- @impl: preseed/agents/claude/manifest.json::skills/design --> <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: src/__tests__/lib/design-skills-seed.test.ts (REQ-AGENT-134: delivers the master router and three specialists to every skill-capable agent) -->
2. The `design` skill routes to the three new specialists and relevant installed Codeflare design specialists, selecting the smallest useful composition. <!-- @impl: preseed/agents/claude/skills/design/SKILL.md::Route the request --> <!-- @manual: Invoke the router with requests spanning one and multiple design domains and verify it selects only the smallest useful specialist composition. -->
3. The vendored UI UX Pro Max and Canvas Design sources retain their MIT and Apache-2.0 license texts. <!-- @impl: preseed/agents/claude/skills/ui-ux-pro-max/LICENSE::MIT License --> <!-- @impl: preseed/agents/claude/skills/canvas-design/LICENSE.txt::Apache License --> <!-- @test: src/__tests__/lib/design-skills-seed.test.ts (REQ-AGENT-134: ships upstream licenses and marks the adapted Canvas file) -->
4. The vendored UI UX Pro Max and Canvas Design sources retain their pinned upstream provenance. <!-- @impl: preseed/agents/claude/skills/ui-ux-pro-max/ORIGIN.md::Upstream provenance --> <!-- @impl: preseed/agents/claude/skills/canvas-design/ORIGIN.md::Upstream provenance --> <!-- @test: src/__tests__/lib/design-skills-seed.test.ts (REQ-AGENT-134: preserves pinned provenance values and omits a Copilot skill lane) -->
5. Modified Canvas instructions carry a prominent modification notice. <!-- @impl: preseed/agents/claude/skills/canvas-design/SKILL.md::Modification notice --> <!-- @test: src/__tests__/lib/design-skills-seed.test.ts (REQ-AGENT-134: ships upstream licenses and marks the adapted Canvas file) -->
6. Frontend Design is independently authored and Codeflare-owned rather than copied or transformed from Anthropic's all-rights-reserved Claude Code repository. <!-- @impl: preseed/agents/claude/skills/frontend-design/SKILL.md::Frontend Design --> <!-- @manual: Compare the committed skill and its creation history against the referenced Anthropic source before release; verify independent wording and no transformed proprietary text. -->
7. UI UX Pro Max invokes its auxiliary search implementation from each generated runtime's own skills directory. <!-- @impl: scripts/generate-agent-seed.mjs::adaptPaths --> <!-- @test: src/__tests__/lib/design-skills-seed.test.ts (REQ-AGENT-134: rewrites UI UX Pro Max search paths for each generated runtime) -->

**Constraints:**

- The Claude preseed remains canonical; supported agents receive generated path adaptations.
- Copilot receives no skills because its runtime has no skills directory contract.
- `impeccable` remains optional and available only in the runtimes that carry its full tool bundle.
- Vendored auxiliary data and scripts load on demand rather than entering always-on instructions.
- The compact `design` router references specialists instead of embedding their bodies.

**Priority:** P2

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-AGENT-007](#req-agent-007-multi-agent-adaptation-pipeline), [REQ-AGENT-014](#req-agent-014-manifest-driven-preseed-pipeline)

**Verification:** Generated-seed artifact tests plus manual router-selection and provenance review

**Status:** Partial

---

### REQ-AGENT-135: UI UX Pro Max Query and Generation

**Intent:** The advanced design suite returns relevant records and a generated recommendation from its delivered database.

**Applies To:** Agent

**Acceptance Criteria:**

1. A domain query returns matching records from the delivered design database. <!-- @impl: preseed/agents/claude/skills/ui-ux-pro-max/scripts/core.py::search --> <!-- @test: host/__tests__/design-skill-runtime.test.js (REQ-AGENT-135: returns matching records and a generated recommendation) -->
2. Design-system generation returns a recommendation for the query. <!-- @impl: preseed/agents/claude/skills/ui-ux-pro-max/scripts/design_system.py::generate_design_system --> <!-- @test: host/__tests__/design-skill-runtime.test.js (REQ-AGENT-135: returns matching records and a generated recommendation) -->

**Constraints:** The helper remains standard-library-only.

**Priority:** P2

**Dependencies:** [REQ-AGENT-134](#req-agent-134-advanced-design-skill-suite)

**Verification:** UI UX Pro Max CLI behavioral tests

**Status:** Partial

---

### REQ-AGENT-136: UI UX Pro Max Persistence

**Intent:** Persisted design systems remain inside their selected root and preserve prior decisions unless replacement is explicit.

**Applies To:** Agent

**Acceptance Criteria:**

1. Persistence writes project and page files beneath sanitized path segments. <!-- @impl: preseed/agents/claude/skills/ui-ux-pro-max/scripts/design_system.py::safe_slug --> <!-- @impl: preseed/agents/claude/skills/ui-ux-pro-max/scripts/design_system.py::persist_design_system --> <!-- @test: host/__tests__/design-skill-runtime.test.js (REQ-AGENT-136: safely persists design systems without overwriting by default) -->
2. Persistence preserves an existing master unless the caller explicitly forces replacement. <!-- @impl: preseed/agents/claude/skills/ui-ux-pro-max/scripts/design_system.py::persist_design_system --> <!-- @test: host/__tests__/design-skill-runtime.test.js (REQ-AGENT-136: safely persists design systems without overwriting by default) -->
3. Persistence rejects symbolic links in every owned destination directory or file. <!-- @impl: preseed/agents/claude/skills/ui-ux-pro-max/scripts/design_system.py::_open_owned_directory --> <!-- @impl: preseed/agents/claude/skills/ui-ux-pro-max/scripts/design_system.py::_write_file_atomically --> <!-- @test: host/__tests__/design-skill-runtime.test.js (REQ-AGENT-136: rejects symlinked persistence destinations) -->

**Constraints:** Persistence writes only beneath the caller-selected output root. Regular destination files are replaced atomically through a temporary file owned by the opened destination directory.

**Priority:** P2

**Dependencies:** [REQ-AGENT-135](#req-agent-135-ui-ux-pro-max-query-and-generation)

**Verification:** UI UX Pro Max CLI behavioral tests

**Status:** Partial

---

### REQ-AGENT-137: UI UX Pro Max Data Validation

**Intent:** Invalid design data is reported before it can silently degrade search recommendations.

**Applies To:** Agent

**Acceptance Criteria:**

1. Data validation reports duplicate identifiers. <!-- @impl: preseed/agents/claude/skills/ui-ux-pro-max/scripts/validate_data.py::_check_file --> <!-- @test: host/__tests__/design-skill-runtime.test.js (REQ-AGENT-137: reports duplicate identifiers and malformed JSON rule values) -->
2. Data validation reports malformed JSON rule values. <!-- @impl: preseed/agents/claude/skills/ui-ux-pro-max/scripts/validate_data.py::_check_file --> <!-- @test: host/__tests__/design-skill-runtime.test.js (REQ-AGENT-137: reports duplicate identifiers and malformed JSON rule values) -->

**Constraints:** Validation remains standard-library-only.

**Priority:** P2

**Dependencies:** [REQ-AGENT-135](#req-agent-135-ui-ux-pro-max-query-and-generation)

**Verification:** UI UX Pro Max CLI behavioral tests

**Status:** Partial

---

### REQ-AGENT-076: Pi Context-Mode Enablement and Tool-Extension Defaults

**Intent:** Pi's own default runtime behavior — independent of which Pro/Standard content [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers) delivers — must stay predictable and crash-free out of the box: context-mode is disabled by default for Pi pending an upstream memory-safe adapter while explicit `/ctx on` remains available, the five always-on Pi tool extensions install without duplication, context-mode's own npm update-check probe is neutralized at build time, and `web_search` defaults to the headless-safe non-interactive workflow.

**Applies To:** User

**Acceptance Criteria:**

1. On a fresh container, context-mode skills and its Pi adapter are disabled until the user opts in with `/ctx on`. <!-- @impl: entrypoint.sh::warm_pi_npm_dependencies --> <!-- @test: host/__tests__/pi-settings-packages.test.js (REQ-AGENT-076 AC1 / REQ-AGENT-131 AC1 / REQ-AGENT-133 AC1: fresh container assembles required packages and disables context-mode by default) -->
2. A state-changing `/ctx` command reloads Pi into the selected enabled or disabled state. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::handleContextModeCommand --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (REQ-AGENT-076 AC2: /ctx reloads Pi into the selected state) --> <!-- @manual: Start a fresh container and confirm `ctx_*` tools are absent; run `/ctx on` and confirm reload restores working tools; run `/ctx off` and confirm reload removes them. Container startup restores the disabled default. -->
3. Custom-tier Claude may receive automatic context-window reduction only while its tier remains eligible. <!-- @impl: src/lib/r2-seed.ts::getConfigsForMode --> <!-- @test: host/__tests__/entrypoint-context-mode.test.js (entrypoint context-mode preseed gate / REQ-AGENT-005 + REQ-AGENT-076 (context-mode MCP registration)) -->
4. The Pi settings required set installs the five always-on tool extensions. <!-- @impl: entrypoint.sh::warm_pi_npm_dependencies --> <!-- @test: host/__tests__/pi-settings-packages.test.js (Pi settings.json packages assembly (entrypoint.sh)) -->
5. Build-time patching neutralizes context-mode's npm update probe in both installed copies. <!-- @impl: scripts/patch-context-mode-bundles.mjs::patchContextModeInstallations --> <!-- @test: host/__tests__/dockerfile-context-mode-patch.test.js (Context-mode installation patch (createRequire shim + REQ-AGENT-076 AC5 update-check disable)) -->
6. Pi `web_search` defaults to the headless-safe `auto-summary` workflow. <!-- @impl: entrypoint.sh::PI_WEB_SEARCH_JSON --> <!-- @test: host/__tests__/entrypoint-pi-web-search.test.js (entrypoint.sh Pi web-search workflow default) -->
7. An inherited bridge-idle override does not disable context-mode's managed idle policy. The entrypoint preserves an operator-provided nonzero timeout and creates no global override when none is supplied; the managed Pi extension clears stale disabling values before context-mode initializes. <!-- @impl: preseed/agents/pi/extensions/context-mode-runtime.ts::clearInheritedContextModeBridgeIdleOverride --> <!-- @test: host/__tests__/entrypoint-context-mode-runtime.test.js (REQ-AGENT-076 AC7: entrypoint preserves context-mode bridge idle reaping) --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (REQ-AGENT-076 AC7: Pi context-mode runtime extension clears an inherited bridge-idle override so context-mode governs per-session) -->

**Constraints:**

- Custom-tier behavior is delivered only through the platform preseed.
- Package assembly preserves user-added entries and deduplicates managed entries.
- Advisor startup overrides guidance only.
- Advisor remains user-invoked only.
- Tool extensions require no per-user API key.
- The update probe patch is build-owned, not a self-upgrade path.
- Every Pi workflow retains an equivalent non-context fallback.
- Container startup restores the disabled context-mode package marker regardless of a prior session's opt-in state.
- Foreground ownership and in-process subagent isolation after explicit opt-in are owned by [REQ-AGENT-089](#req-agent-089-pi-context-mode-foreground-ownership).

**Priority:** P1

**Dependencies:** [REQ-AGENT-005](#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers), [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth)

**Verification:** Automated test ([Agent seed manifest tests](../../src/__tests__/lib/agent-seed-multi-agent.test.ts))

**Status:** Implemented

---

### REQ-AGENT-115: Pi web-access 0.14 skill compatibility

**Intent:** Pi web research retains accurate tool guidance and the visible librarian workflow across the upstream 0.14 package boundary.

**Applies To:** User

**Acceptance Criteria:**

1. The owned `pi-web-access` skill documents the default `source_check` claim-verification tool. <!-- @impl: preseed/agents/pi/skills/pi-web-access/SKILL.md::source_check --> <!-- @manual -->
2. The owned `pi-web-access` skill directs callers to retrieve stored content as bounded `offset`/`limit` slices rather than claiming a full-result response. <!-- @impl: preseed/agents/pi/skills/pi-web-access/SKILL.md::get_search_content --> <!-- @manual -->
3. The former upstream `librarian` skill remains an owned Codeflare skill delivered in both Pi modes after upstream removes its bundled copy. <!-- @impl: preseed/agents/pi/skills/librarian/SKILL.md::Librarian --> <!-- @impl: preseed/agents/pi/manifest.json::skills/librarian/SKILL.md --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (REQ-AGENT-115 AC3: librarian skill ships in both Pi modes) -->

**Constraints:**

- Codeflare owns the preserved librarian bytes and manifest entry; package installation no longer supplies a second copy.
- `auto-summary` remains the default for headless containers.

**Priority:** P1

**Dependencies:** [REQ-AGENT-076](#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults)

**Verification:** Automated generated-seed delivery test for AC3; direct skill review for AC1 and AC2.

**Status:** Implemented

---

### REQ-AGENT-116: Heredoc-safe PR-boundary classification

**Intent:** Shell heredocs must never turn example or payload text into a protected-branch review boundary.

**Applies To:** User

**Acceptance Criteria:**

1. Heredoc bodies never expose embedded boundary-looking commands to classification. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewBoundaryCommand --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-063/REQ-AGENT-116/REQ-AGENT-121: classifies delivery commands for automatic review and other Git activity for confirmation) -->
2. Punctuation-bearing heredoc delimiters match exactly. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewBoundaryCommand --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-063/REQ-AGENT-116/REQ-AGENT-121: classifies delivery commands for automatic review and other Git activity for confirmation) -->
3. Multiple heredoc bodies are consumed in declaration order. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewBoundaryCommand --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-063/REQ-AGENT-116/REQ-AGENT-121: classifies delivery commands for automatic review and other Git activity for confirmation) -->

**Constraints:** Supported shell surfaces remain defined by [REQ-AGENT-063](#req-agent-063-pr-boundary-candidate-detection).

**Priority:** P1

**Dependencies:** [REQ-AGENT-063](#req-agent-063-pr-boundary-candidate-detection)

**Verification:** Automated review-helper tests

**Status:** Implemented

---

### REQ-AGENT-080: Unified Pi PR-Boundary Launch Plan

**Intent:** A successful Pi PR boundary must produce one ordered, visible launch plan so reviewers start together before independent exact-head CI, without duplicate triggers or lifecycle coupling.

**Applies To:** Agent

**Acceptance Criteria:**

1. An eligible SDD head-changing boundary emits a numbered runbook with PR/head/scope context, `REVIEWERS → CI → TRIAGE + ACK → FIX` order, and a fixed triage table whose turn ends without mutation. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendLaunchMessage --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074/REQ-AGENT-110/REQ-AGENT-132: emits one plan before settled recovery) -->
2. An eligible non-SDD boundary emits a CI-only plan. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-068: emits a CI-only launch plan outside SDD mode) -->
3. An eligible default-mode boundary emits a CI-only plan from its effective repository context. <!-- @impl: preseed/agents/pi/extensions/active-repo-memory.ts::rememberActiveRepoFromToolResult --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewEnabled --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (Pi review reminder and settled enforcement) -->
4. Transcript correlation recognizes a matching exact-head `ci-monitor` call independently from reviewer state. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-068: recognizes one matching CI launch independently of reviewer completion) -->
5. After the final launch, the plan ends the turn without foreground waiting, polling, resuming, or retrieving in-flight agents; native terminal notifications drive later turns. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendLaunchMessage --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074/REQ-AGENT-110/REQ-AGENT-132: emits one plan before settled recovery) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-068: acknowledged current branch state stays inert) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-071/REQ-AGENT-074: requests missing reviewers together without duplicating unmatched public calls) -->
6. Only a boundary plan emitted for an unacknowledged authoritative checked-out-branch PR head authorizes reviewer launches; unpublished or unsynchronized local commits do not. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-058 + REQ-AGENT-080 AC6: an eligible pushed boundary emits one authoritative launch plan) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036 + REQ-AGENT-080 AC6: an unpublished local commit emits no launch plan without a boundary) -->

**Constraints:**

- Reviewer and CI lifecycles remain independent.
- The root launches every reviewer together before CI.
- The resolver's CI request is submitted unchanged once.
- Git commands create no second CI trigger.
- All launches use isolated public background subagents.
- The dispatcher stores no durable job or result state.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-053](#req-agent-053-pi-native-review-result-correlation), [REQ-AGENT-068](#req-agent-068-independent-pi-ci-monitoring)

**Verification:** Automated test ([Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts), [Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi CI monitor tests](../../host/__tests__/pi-ci-monitor.test.js))

**Status:** Implemented

---

### REQ-AGENT-110: Pi PR-boundary missing-launch follow-up

**Intent:** Settled enforcement requests only the reviewer or CI launch work still missing for the current head and acknowledges reviewer-bearing work only after complete triage proof.

**Applies To:** Agent

**Acceptance Criteria:**

1. Settled follow-up requests only missing reviewer lanes while unmatched calls remain in flight. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendLaunchMessage --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-071/REQ-AGENT-074: requests missing reviewers together without duplicating unmatched public calls) -->
2. Settled follow-up requests one missing CI wave without duplicating in-flight reviewers or its queued message. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-068/REQ-AGENT-074: requests a missing CI launch without duplicating in-flight reviewers) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-110 AC2: keeps a queued CI-only recovery single-flight before delivery) -->
3. Required successful reviewer completion plus post-notification triage proof is the only reviewer-bearing acknowledgement condition. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: acknowledges only after terminal lanes and triage) -->
4. The first settled recovery after an initial plan defers when no reviewer or CI launch is recorded. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074/REQ-AGENT-110/REQ-AGENT-132: emits one plan before settled recovery) -->
5. After reload, a persisted successful boundary that was not evaluated by its live handler and has no correlated launch plan emits that initial plan exactly once. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::persistedBoundary --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::launchBoundaryPlan --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-110 AC5: reload recovers one launch plan for a successful boundary whose live handler was missed) -->
6. A live-evaluated ineligible boundary remains inert after reload. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::boundaryWasEvaluated --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-110 AC6: reload does not reconsider a live-evaluated ineligible boundary) -->
7. Existing-session startup or resume recovers one exact-head launch whose accepted evaluation was persisted but whose queued follow-up is absent, without asking again. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::persistedBoundary --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-110/REQ-AGENT-141: startup and resume recover one evaluated plan whose queued follow-up was lost) -->

**Constraints:**

- Reviewer and CI lifecycles remain independent.
- Unmatched calls remain in flight and are never duplicated.
- Follow-up presentation distinguishes missing launch work from the post-acknowledgement FIX phase.

**Priority:** P1

**Dependencies:** [REQ-AGENT-080](#req-agent-080-unified-pi-pr-boundary-launch-plan), [REQ-AGENT-053](#req-agent-053-pi-native-review-result-correlation), [REQ-AGENT-068](#req-agent-068-independent-pi-ci-monitoring), [REQ-AGENT-074](#req-agent-074-pi-settled-review-handoff)

**Verification:** Automated test ([Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts))

**Status:** Implemented

---

### REQ-AGENT-082: Pi Review Range Selection

**Intent:** Pi must derive review lanes and scope from an ancestry-validated acknowledged-to-head range, with a safe full-PR fallback when acknowledgement cannot define that range.

**Applies To:** User

**Acceptance Criteria:**

1. Missing, malformed, or non-ancestor acknowledgement falls back to all review lanes. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::requiredReviewLanes --> <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewRange --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-055: falls back to all lanes for malformed and non-ancestor acknowledgements) -->
2. Enforcement renders invalid acknowledgement as full protected-base PR scope. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-055/REQ-AGENT-071: invalid acknowledgements request a full-PR review) -->
3. A valid ancestor acknowledgement classifies every changed path through the fresh PR head. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::requiredReviewLanes --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-040: classifies tricky filenames and source-to-doc renames without bypassing code review) -->

**Constraints:**

- The range uses full Git SHAs and is never inferred from reviewer output.
- Lane classification consumes NUL-delimited paths with Git rename detection disabled.
- Invalid acknowledgement never narrows review.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-040](#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch)

**Verification:** Automated test ([Pi review helper tests](../../src/__tests__/lib/review-helpers.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts))

**Status:** Implemented

---

### REQ-AGENT-083: User-Invoked Pi Review Repository Context

**Intent:** `/review` must execute against the active Git repository even when Pi itself started from a workspace parent.

**Applies To:** User

**Acceptance Criteria:**

1. `/review` prefers a Git repository containing the command cwd, including a linked worktree. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::reviewWorkflowDecision --> <!-- @impl: preseed/agents/pi/skills/review/scripts/resolve-project-root.mjs::resolveProjectRoot --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-036/REQ-AGENT-083: resolves /review repository context and fails when absent) -->
2. Outside Git, `/review` resolves the remembered active repository. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::reviewWorkflowDecision --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-036/REQ-AGENT-083: resolves /review repository context and fails when absent) --> <!-- @manual: Start Pi outside Git, select a remembered repository whose path contains spaces, and confirm `/review --diff` targets that absolute root without changing the process cwd. -->
3. The workflow contract carries the validated absolute repository root. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::dispatchReview --> <!-- @impl: preseed/agents/pi/skills/review/SKILL.md::Phase 1: Parse arguments + create run directory (main session) --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-036/REQ-AGENT-083: resolves /review repository context and fails when absent) -->
4. `/review` fails before dispatch when neither repository source resolves. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::dispatchReview --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-083: suppresses /review workflow dispatch when no repository resolves) -->
5. Repository-root validation preserves valid whitespace in the resolved path. <!-- @impl: preseed/agents/pi/skills/review/scripts/resolve-project-root.mjs::replace(/\r?\n$/, '') --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-036/REQ-AGENT-083: resolves /review repository context and fails when absent) -->

**Constraints:**

- Repository resolution never changes the Pi process cwd globally.

**Priority:** P1

**Dependencies:** [REQ-AGENT-036](#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-059](#req-agent-059-pi-native-review-findings-handoff)

**Verification:** Automated test ([Pi scope entry-point tests](../../src/__tests__/lib/pi-review-scope.test.ts))

**Status:** Implemented

---

### REQ-AGENT-081: rpiv-todo Session Isolation

**Intent:** Pi task lists must remain session-scoped without allowing child or background session lifecycle events to erase the foreground session's tasks.

**Applies To:** User

**Acceptance Criteria:**

1. The pinned `@juicesharp/rpiv-todo` release ships session-keyed task state upstream (the reviewed equivalent of the retired [AD100](../../documentation/decisions/README.md#ad100-pin-the-upstream-rpiv-todo-session-isolation-fix) override), and every runtime pin surface names that exact release. <!-- @impl: preseed/agents/pi/package.json::dependencies --> <!-- @impl: entrypoint.sh::required --> <!-- @test: host/__tests__/pi-settings-packages.test.js (rpiv-todo upstream session isolation (REQ-AGENT-081)) -->
2. No Codeflare source override of rpiv-todo remains: no postinstall guard, no payload files, no manifest entries. <!-- @impl: preseed/agents/pi/package.json::dependencies --> <!-- @test: host/__tests__/pi-settings-packages.test.js (rpiv-todo upstream session isolation (REQ-AGENT-081)) -->

**Constraints:**

- Task persistence remains transcript/branch-scoped; Codeflare adds no global task database.
- Reintroducing a source override requires a new reviewed decision; the retired AD100 machinery must not return unreviewed.
- User-added Pi packages and unrelated rpiv-todo behavior remain unchanged.

**Priority:** P1

**Dependencies:** [REQ-AGENT-076](#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults)

**Verification:** Automated test ([Pi settings/packages tests](../../host/__tests__/pi-settings-packages.test.js))

**Status:** Implemented

---

### REQ-AGENT-084: Reviewer Policy Contract

**Intent:** Every runtime's reviewers must hold the same policy set and begin a run holding the part of it that applies to almost every run, so no reviewer reads a diff before the rules it is judged against have arrived, and no reviewer spends a turn discovering policy.

**Applies To:** Agent

**Acceptance Criteria:**

1. Every reviewer begins holding the canonical policy that applies to almost every run; a policy gated on a diff condition may instead arrive in the evidence wave the lane was already making. <!-- @impl: scripts/generate-agent-seed.mjs::expandSkillIncludes --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (REQ-AGENT-084: expands canonical policy into each generated reviewer system prompt) -->
2. Reviewer configuration omits unsupported skill-access declarations. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (REQ-AGENT-084: expands canonical policy into each generated reviewer system prompt) -->
3. Policy available to each reviewer is identical to its separately seeded canonical policy. <!-- @impl: scripts/generate-agent-seed.mjs::expandSkillIncludes --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (REQ-AGENT-084: expands canonical policy into each generated reviewer system prompt) -->

**Constraints:**

- Canonical skill files remain the only hand-maintained policy source.
- Reviewer launch prompts carry only dynamic repository, scope, range, and direct-user override inputs.
- Preloading changes no review scope, manifest row, or acknowledgement condition.
- One policy set per reviewer in every runtime; whether a policy is carried or fetched is chosen per lane from measurement, never by default.

**Priority:** P1

**Dependencies:** [REQ-AGENT-071](#req-agent-071-pr-boundary-review-agent-dispatch)

**Verification:** Automated test ([Pi-native review asset tests](../../host/__tests__/pi-native-review-assets.test.js))

**Status:** Implemented

---

### REQ-AGENT-108: Reviewer Evidence Resolution Fidelity

**Intent:** The evidence a review lane is handed must be produced fast enough that every transport delivers it and must resolve a documented name by any honest form it can be written in, so a lane never re-derives what it holds nor acts on a list of names that were never stale.

**Applies To:** Agent

**Acceptance Criteria:**

1. Reference resolution costs a bounded pass over the tree regardless of how many names a document cites. <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/lane-evidence.mjs::declarationIndex --> <!-- @test: host/__tests__/lane-evidence.test.js (answers two hundred names for the cost of reading the tree) --> <!-- @test: host/__tests__/lane-evidence.test.js (does not resolve a name by the identifier next to it) -->
2. A name declared only inside generated output is not a declaration. <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/lane-evidence.mjs::declarationIndex --> <!-- @test: host/__tests__/lane-evidence.test.js (does not let a generated tree declare a symbol) -->
3. A documented name resolves by the strongest form holding it, never a weaker one: path tail, basename, directory, declaration in any repository language, exact npm dependency, registered string, then a token in a dependency manifest. <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/lane-evidence.mjs::trackedNames --> <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/lane-evidence.mjs::quotedLiterals --> <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/lane-evidence.mjs::declaredDependencies --> <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/lane-evidence.mjs::DECL_SHAPES --> <!-- @test: host/__tests__/lane-evidence.test.js (resolves a file named by a path tail, a command by its registered name, and a declared package) --> <!-- @test: host/__tests__/lane-evidence.test.js (resolves a name that appears under more than one directory) --> <!-- @test: host/__tests__/lane-evidence.test.js (resolves declarations and dependencies in a repo that is not JavaScript) --> <!-- @test: host/__tests__/lane-evidence.test.js (does not let a control keyword in another language declare a name) --> <!-- @test: host/__tests__/lane-evidence.test.js (does not demote a real declaration that a manifest happens to also mention) -->
4. Notation that documents an interface rather than naming code is never a resolvable candidate. <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/lane-evidence.mjs::resolveDocReferences --> <!-- @test: host/__tests__/lane-evidence.test.js (resolves a file named by a path tail, a command by its registered name, and a declared package) -->
5. The unresolved list carries an explicit bound, and a list reaching that bound is marked truncated so the remainder is known to be outstanding. <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/lane-evidence.mjs::summarise --> <!-- @test: host/__tests__/lane-evidence.test.js (reports every unresolved reference rather than a capped sample) --> <!-- @test: host/__tests__/lane-evidence.test.js (marks a list that reaches the bound as truncated) -->
6. A name resolved only on the weakest evidence the resolver accepts -- a registered string, or a token in a dependency manifest -- is reported in its own class rather than as an ordinary pass. <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/lane-evidence.mjs::summarise --> <!-- @test: host/__tests__/lane-evidence.test.js (reports a name known only from a manifest as a weak resolution rather than a pass) --> <!-- @test: host/__tests__/lane-evidence.test.js (retries the last segment for a package but never for a version fragment) -->

**Constraints:**

- One resolver serves every runtime, under one bound; a transport may not change what it can deliver.
- Resolution answers whether a name still names something, never which file it named.
- Outside `package.json`, dependency manifests are tokenised; a manifest setting may resolve alongside a real package (rationale: `sdd/spec/changes.md`, 2026-07-27).
- The resolver is seeded into every repository `/sdd` bootstraps, so nothing in it may assume the language the repository is written in or the package manager it uses; a stack it does not recognise indexes no declarations and reports a consistent tree as entirely stale.

**Priority:** P1

**Dependencies:** [REQ-AGENT-105](#req-agent-105-review-lane-turn-economy)

**Verification:** Automated test ([lane evidence tests](../../host/__tests__/lane-evidence.test.js))

**Status:** Implemented

---

### REQ-AGENT-109: Reviewer Evidence Absence Contract

**Intent:** A resolver that could not produce evidence must be visible as a failure rather than as a packet with one fewer block, and every lane that meets an absent block must already know what to do about it, so nothing is silently reviewed against evidence that was never gathered.

**Applies To:** Agent

**Acceptance Criteria:**

1. A resolver that fails names the reason in the packet instead of omitting the block. <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs::laneEvidence --> <!-- @test: host/__tests__/pi-review-workset.test.js (REQ-AGENT-109: an evidence failure is named in the packet, not dropped) -->
2. Every reviewer that builds its own packet is told what to do when the evidence block is absent. <!-- @impl: preseed/agents/pi/agents/doc-updater.md::evidenceOmitted --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (REQ-AGENT-109: a self-building reviewer is told how to proceed without evidence) -->

**Constraints:**

- An absent block is a lookup the lane owes by hand, never a check that is skipped and never a failed packet call.

**Priority:** P1

**Dependencies:** [REQ-AGENT-108](#req-agent-108-reviewer-evidence-resolution-fidelity)

**Verification:** Automated test ([Pi review workset tests](../../host/__tests__/pi-review-workset.test.js), [Pi native review asset tests](../../host/__tests__/pi-native-review-assets.test.js))

**Status:** Implemented

---

### REQ-AGENT-107: Deterministic Round-Limit Gate

**Intent:** The anti-spiral round limit must be decided by one executable gate every runtime is directed to, so the same window yields the same verdict regardless of which agent reads it, and so releasing the limit is a stated contract rather than a reader's judgment.

**Applies To:** Agent

**Acceptance Criteria:**

1. At five or more counted commits, the direct-user fully-autonomous marker changes only the enforced round-limit decision from stop to continue. <!-- @impl: preseed/agents/claude/skills/spec-enforce/SKILL.md::Explicit fully-autonomous override --> <!-- @impl: preseed/agents/claude/skills/spec-enforce/scripts/round-limit.mjs::action --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (REQ-AGENT-107: enforcement round limit honors only the exact fully autonomous marker) -->
2. The agent executing a user-invoked clean reports the round-limit row inert without consulting the gate. <!-- @impl: preseed/agents/claude/skills/spec-enforce/SKILL.md::The 5-round commit cycle limit --> <!-- @impl: preseed/agents/claude/skills/sdd-clean/SKILL.md::Execution ownership (binding) --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (REQ-AGENT-107: the user-invoked exemption is wired on both sides in every runtime) -->
3. Every reviewer takes both its round count and its round-limit decision from the deterministic gate it is directed to, which counts any agent-authored tag that touched the lane rather than only the reviewer's own. <!-- @impl: preseed/agents/claude/skills/spec-enforce/SKILL.md::Required execution manifest --> <!-- @impl: preseed/agents/claude/skills/spec-enforce/scripts/round-limit.mjs::countRounds --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (REQ-AGENT-107: the round-limit row routes the verdict to the gate in every runtime) --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (counts any agent tag that touched the lane, and only those) -->
4. Every reviewer reports both the counted total and the gate's decision as enforcement evidence. <!-- @impl: preseed/agents/claude/skills/spec-enforce/SKILL.md::Required execution manifest --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (REQ-AGENT-107: the round-limit row routes the verdict to the gate in every runtime) -->
5. A gate that cannot read the commit history fails with a non-zero status and a concise diagnostic rather than a verdict, so an unreadable window is never mistaken for a permissive one. <!-- @impl: preseed/agents/claude/skills/spec-enforce/scripts/round-limit.mjs::resolveCount --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (refuses to return a verdict when the history cannot be read) -->

**Constraints:**

- The limit binds agent-authored review rounds only; user-invoked runs are released, never counted down.
- One gate serves every runtime; a reviewer that derives count or verdict itself is in breach.

**Priority:** P1

**Dependencies:** [REQ-AGENT-071](#req-agent-071-pr-boundary-review-agent-dispatch), [REQ-AGENT-084](#req-agent-084-reviewer-policy-contract)

**Verification:** Automated test ([Pi-native review asset tests](../../host/__tests__/pi-native-review-assets.test.js))

**Status:** Implemented

---

### REQ-AGENT-094: Per-AC Test Evidence Supports Multiple Anchors

**Intent:** Specification traceability must represent real behavioral coverage when one acceptance criterion is verified by multiple named test blocks or files, without forcing test structure into requirement granularity.

**Applies To:** Agent

**Acceptance Criteria:**

1. Every non-manual AC carries at least one `@test` anchor, and the canonical parser returns every adjacent anchor independently while preserving parentheses inside block titles. <!-- @impl: preseed/agents/claude/skills/spec-enforce-truth/references/parse-test-anchors.mjs::parseTestAnchors --> <!-- @test: host/__tests__/test-anchor-parser.test.js (REQ-AGENT-094 AC1: accepts one or more anchors per AC in declaration order) -->
2. Multiple anchors on one AC are valid, while every declared anchor remains subject to file, named-block, and behavioral-quality verification. <!-- @manual: Add one resolving and one orphaned anchor to a fixture AC, run specification enforcement, and confirm the resolving block counts as coverage while the orphan still emits `spec-test-anchor-orphaned`. -->

**Constraints:**

- Anchor lists provide traceability evidence, not an exhaustive inventory of every test that touches the behavior.
- Distinct observable behaviors still split under the existing AC-granularity rules; anchor count alone never triggers a split.

**Priority:** P1

**Dependencies:** [REQ-AGENT-021](#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability), [REQ-AGENT-084](#req-agent-084-reviewer-policy-contract)

**Verification:** Automated test ([Test-anchor parser tests](../../host/__tests__/test-anchor-parser.test.js))

**Status:** Implemented

---

### REQ-AGENT-095: Compact Pi Skill Catalog

**Intent:** Pi must start with a focused model-visible skill catalog that preserves the canonical policy and discovers proactive workflows without loading specialized bodies into every turn.

**Applies To:** User

**Acceptance Criteria:**

1. Pi packages canonical path-scoped Claude rules into grouped native skills while keeping Claude and other agent outputs unchanged. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: src/__tests__/lib/pi-compact-context.test.ts (REQ-AGENT-007/REQ-AGENT-095: compact Pi context generated from the Claude canon) -->
2. Proactive workflows remain visible in Pi's model-facing skill catalog. <!-- @impl: scripts/generate-agent-seed.mjs::adaptPiSkillContent --> <!-- @test: src/__tests__/lib/pi-compact-context.test.ts (REQ-AGENT-007/REQ-AGENT-095: compact Pi context generated from the Claude canon) -->
3. Codeflare-owned model-visible skill descriptions contain at most 80 characters. <!-- @impl: scripts/generate-agent-seed.mjs::compactPiSkillDescription --> <!-- @test: src/__tests__/lib/pi-compact-context.test.ts (REQ-AGENT-007/REQ-AGENT-095: compact Pi context generated from the Claude canon) -->
4. Compact descriptions preserve the routing triggers needed for Pi to select each proactive workflow. <!-- @impl: scripts/generate-agent-seed.mjs::PI_SKILL_DESCRIPTION_OVERRIDES --> <!-- @manual: Ask Pi for representative proactive workflows and confirm it selects the matching visible skills from their compact descriptions. -->
5. Pi hides only internals loaded by a named command, deterministic event, or reviewer embedding. <!-- @impl: scripts/generate-agent-seed.mjs::setPiModelVisibility --> <!-- @test: src/__tests__/lib/pi-compact-context.test.ts (REQ-AGENT-007/REQ-AGENT-095: compact Pi context generated from the Claude canon) -->
6. Upstream-owned Pi skill metadata remains unchanged. <!-- @impl: scripts/generate-agent-seed.mjs::generate --> <!-- @test: host/__tests__/pi-native-review-assets.test.js (emits every manifest-declared Pi asset exactly once per mode with canonical bytes) -->

**Constraints:**

- Claude rule and skill files remain the shared policy canon; Pi changes delivery and runtime names only.
- Project `AGENTS.md` files and project skills are never truncated or hidden by Codeflare.
- `pi-mcp-adapter` remains an unmodified dependency.

**Priority:** P1

**Dependencies:** [REQ-AGENT-006](#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-AGENT-007](#req-agent-007-multi-agent-adaptation-pipeline), [REQ-AGENT-065](#req-agent-065-engineering-constitution-preseeded-to-all-agents), [REQ-AGENT-084](#req-agent-084-reviewer-policy-contract)

**Verification:** Automated test ([Pi compact-context tests](../../src/__tests__/lib/pi-compact-context.test.ts), [Pi native-asset tests](../../host/__tests__/pi-native-review-assets.test.js))

**Status:** Implemented

---

### REQ-AGENT-096: On-Demand Pi Tool Activation

**Intent:** Pi must expose a small default tool set and activate specialized registered tools only when needed, without changing authorization or event-owner delivery semantics.

**Applies To:** User

**Acceptance Criteria:**

1. On session start, Pi activates registered basic editing, question, capability, and Graphify tools; ordinary specialized tools stay inactive. Goal terminal tools remain active only when the latest canonical Goal is unfinished or both were already visible under the user's Goal policy. <!-- @impl: preseed/agents/pi/extensions/capability.ts::capabilityExtension --> <!-- @impl: preseed/agents/pi/extensions/capability-helpers.ts::initialActiveTools --> <!-- @test: src/__tests__/lib/pi-capabilities.test.ts (REQ-AGENT-096: registered Pi tool discovery and activation) -->
2. Capability search returns matching registered tools by name or description. <!-- @impl: preseed/agents/pi/extensions/capability.ts::capabilityExtension --> <!-- @impl: preseed/agents/pi/extensions/capability-helpers.ts::searchCapabilities --> <!-- @test: src/__tests__/lib/pi-capabilities.test.ts (REQ-AGENT-096: registered Pi tool discovery and activation) -->
3. Capability activation additively enables only registered tools without granting authorization. <!-- @impl: preseed/agents/pi/extensions/capability.ts::capabilityExtension --> <!-- @impl: preseed/agents/pi/extensions/capability-helpers.ts::activateRegisteredTools --> <!-- @test: src/__tests__/lib/pi-capabilities.test.ts (REQ-AGENT-096: registered Pi tool discovery and activation) -->
4. The PR-boundary launch owner activates `subagent` before delivering its unchanged reviewer-and-CI follow-up request. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendLaunchMessage --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074/REQ-AGENT-110/REQ-AGENT-132: emits one plan before settled recovery) -->
5. The memory/Vault extraction launch owner activates `subagent` before delivering unchanged extraction follow-up requests. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::sendDueExtractionMessages --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (creates work on the fifteenth real prompt and emits a visible reminder without private spawn) -->
6. Context-mode remains absent on fresh startup and explicit `/ctx on` reloads a foreground owner whose registered `ctx_*` tools remain active. <!-- @impl: preseed/agents/pi/extensions/context-mode-runtime.ts::attachConfiguredContextMode --> <!-- @test: src/__tests__/lib/pi-capabilities.test.ts (REQ-AGENT-096: registered Pi tool discovery and activation) --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (REQ-AGENT-076 AC2: /ctx reloads Pi into the selected state) -->

**Constraints:**

- Tool activation is additive and uses Pi's public extension API.
- Context-mode remains an unmodified dependency.
- Review, CI, memory, and Vault request payloads remain unchanged and exactly once.

**Priority:** P1

**Dependencies:** [REQ-AGENT-076](#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults), [REQ-AGENT-080](#req-agent-080-unified-pi-pr-boundary-launch-plan), [REQ-AGENT-095](#req-agent-095-compact-pi-skill-catalog)

**Verification:** Automated test ([Pi capability tests](../../src/__tests__/lib/pi-capabilities.test.ts), [Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts), [Pi memory/Vault delivery tests](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts))

**Status:** Implemented

---

### REQ-AGENT-097: Bounded Pi Startup Context

**Intent:** Pi's release seed must keep both its complete first-turn context and its Codeflare-managed generated seed within explicit independent budgets.

**Applies To:** User

**Acceptance Criteria:**

1. After release-seed materialization, Pi's complete first-turn context stays below 10,000 approximate tokens under the local faux-provider measurement. <!-- @impl: scripts/measure-pi-runtime-context.mjs::inputTokens --> <!-- @manual: Materialize the advanced release seed into a Pi agent directory, run `node scripts/measure-pi-runtime-context.mjs`, and confirm `inputTokens` is below 10,000. -->
2. The generated Codeflare-managed seed stays below 6,500 approximate tokens in each Pi mode. <!-- @impl: scripts/measure-seed-tokens.mjs::measurePiSeed --> <!-- @test: src/__tests__/lib/pi-compact-context.test.ts (REQ-AGENT-007/REQ-AGENT-095: compact Pi context generated from the Claude canon) -->

**Constraints:**

- The two budgets are measured independently; the managed-seed budget is not evidence for complete runtime context.
- Measurement does not modify Pi, context-mode, or upstream-owned skill metadata.

**Priority:** P1

**Dependencies:** [REQ-AGENT-095](#req-agent-095-compact-pi-skill-catalog)

**Verification:** Automated test ([Pi compact-context tests](../../src/__tests__/lib/pi-compact-context.test.ts), manual release-seed measurement)

**Status:** Implemented

---

### REQ-AGENT-098: Pi Review Triage Acknowledgement Barrier

**Intent:** Pi must checkpoint the exact reviewed PR head after visible triage but before any accepted fix mutates the work, so a follow-up push reviews only the acknowledged-to-current increment without adding a second acknowledgement path.

**Applies To:** Agent

**Acceptance Criteria:**

1. A reviewer-bearing boundary plan orders `REVIEWERS → CI → TRIAGE + ACK → FIX` and instructs the root to publish triage, make no mutation, and end that turn. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendLaunchMessage --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-036/REQ-AGENT-063/REQ-AGENT-074/REQ-AGENT-110/REQ-AGENT-132: emits one plan before settled recovery) -->
2. Agent-end enforcement acknowledges and emits one FIX follow-up only after every required terminal result and a structural triage table. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::acknowledgeCompletedReview --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-098: recognizes structural triage only after all reviewer notifications) --> <!-- @test: src/__tests__/lib/review-helpers.test.ts (REQ-AGENT-098: first public reviewer result keeps triage complete after later terminal evidence) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-074: agent end acknowledges triage from live session state before disk flush) -->
3. Later same-head or unpublished local boundary candidates do not replace or hide the active persisted review window. <!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::reviewTranscriptFacts --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::launchBoundaryPlan --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-074/REQ-AGENT-126: a newer unpublished Git candidate does not hide completed review triage) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-112/REQ-AGENT-113/REQ-AGENT-114/REQ-AGENT-117: queues the review plan before pausing the Goal after the boundary turn ends) -->
4. Settled enforcement provides the acknowledgement fallback when agent-end enforcement did not complete it. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: acknowledges only after terminal lanes and triage) -->

**Constraints:** Review acknowledgement remains independent of CI completion; fixes begin only in the post-acknowledgement follow-up turn.

**Priority:** P1

**Dependencies:** [REQ-AGENT-053](#req-agent-053-pi-native-review-result-correlation), [REQ-AGENT-074](#req-agent-074-pi-settled-review-handoff), [REQ-AGENT-080](#req-agent-080-unified-pi-pr-boundary-launch-plan), [REQ-AGENT-082](#req-agent-082-pi-review-range-selection)

**Verification:** Automated test ([Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts))

**Status:** Implemented

---

### REQ-AGENT-126: Pi review checkpoint persistence and head drift

**Intent:** A completed review checkpoint must remain idempotent and must never authorize FIX after its PR head changes.

**Applies To:** Agent

**Acceptance Criteria:**

1. A persisted acknowledgement suppresses duplicate delivered or queued FIX follow-ups across later agent-end, settled, and reload events. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::acknowledgeCompletedReview --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/055/074 + REQ-AGENT-080 AC6: delayed completion acknowledges the pushed review head, not unpublished local work) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-074/REQ-AGENT-126 AC1+AC3: a delivered FIX does not emit stale drift after the next push) -->
2. The FIX follow-up requests no reviewer or CI launch for the acknowledged head. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendFixFollowUp --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-053/REQ-AGENT-055/REQ-AGENT-074: acknowledges only after terminal lanes and triage) -->
3. Before matching acknowledgement and FIX delivery, a live PR head change after complete triage writes neither checkpoint and emits one visible triggering handoff naming both heads. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::acknowledgeCompletedReview --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::sendHeadDriftFollowUp --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-126 AC3: reports head drift instead of acknowledging a superseded review) --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-074/REQ-AGENT-126 AC1+AC3: a delivered FIX does not emit stale drift after the next push) -->
4. Existing-session startup or resume resends one transcript-proven acknowledged FIX handoff when its queued message is absent and the authoritative head is unchanged. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::acknowledgeCompletedReview --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-AGENT-074: existing-session startup recovers an acknowledged review whose FIX follow-up was not delivered) -->

**Constraints:** A superseded review remains historical evidence only; it never acknowledges the replacement head.

**Priority:** P1

**Dependencies:** [REQ-AGENT-098](#req-agent-098-pi-review-triage-acknowledgement-barrier)

**Verification:** Automated test ([Pi review enforcement tests](../../src/__tests__/lib/review-enforcement.test.ts))

**Status:** Implemented

---

### REQ-AGENT-085: Pi Reviewer Direct Evidence Transport

**Intent:** Pi reviewers must consume exact scoped evidence without recovering prior output through indexed searches.

**Applies To:** Agent

**Acceptance Criteria:**

1. Indexed retrieval and context-mode tools are unavailable to every reviewer. <!-- @impl: preseed/agents/pi/agents/code-reviewer.md::tools --> <!-- @impl: preseed/agents/pi/agents/spec-reviewer.md::tools --> <!-- @impl: preseed/agents/pi/agents/doc-updater.md::tools --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (REQ-AGENT-085 AC1/AC2: generated reviewers expose only direct Bash evidence execution) -->
2. Every reviewer exposes Bash as its direct evidence execution tool. <!-- @impl: preseed/agents/pi/agents/code-reviewer.md::tools --> <!-- @impl: preseed/agents/pi/agents/spec-reviewer.md::tools --> <!-- @impl: preseed/agents/pi/agents/doc-updater.md::tools --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (REQ-AGENT-085 AC1/AC2: generated reviewers expose only direct Bash evidence execution) -->
3. Reviewer Bash execution is rooted in the caller-supplied repository. <!-- @impl: preseed/agents/pi/extensions/review-tool-guard.ts::registerReviewerToolGuard --> <!-- @test: src/__tests__/lib/review-tool-guard.test.ts (REQ-AGENT-085: roots Bash-first fallback in the reviewer repository) -->
4. Cross-lane changed inputs carry exact old and new hunk ranges. <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs::buildReviewPacket --> <!-- @test: host/__tests__/pi-review-workset.test.js (REQ-AGENT-085 AC4/AC5: changed inputs expose exact hunk ranges and enforce intersection) -->
5. An anchored symbol or named test is invalidated only when its line range intersects a changed-input hunk; path equality alone is insufficient. <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs::changedInputIntersects --> <!-- @test: host/__tests__/pi-review-workset.test.js (REQ-AGENT-085 AC4/AC5: changed inputs expose exact hunk ranges and enforce intersection) -->
6. Foreground context execution and reviewer Bash execution produce the same packet work set. <!-- @impl: preseed/agents/pi/skills/review-scope/SKILL.md::Build the lane packet once --> <!-- @test: host/__tests__/pi-review-workset.test.js (REQ-AGENT-085: CLI and module produce identical worksets without persistence) --> <!-- @manual: Change one named block in a cross-lane file and confirm only anchors whose old/new ranges intersect that hunk enter the reviewer work set under both direct context execution and Bash fallback. -->

**Constraints:**

- Review scope, manifest coverage, evidence truth, and severity remain unchanged.
- Evidence already returned is never recovered through global index searches or marker-only commands.
- Reviewers consume packet evidence directly, consolidate independent checks, and continue only for named unresolved candidates.
- Foreground context-mode execution and reviewer Bash invoke the same seeded CLI and apply identical changed-hunk intersection semantics.
- The packet builder is one canonical source shared by every runtime; Pi receives it through the standard seed transform, byte-identical to that source.
- Commands inspect the complete scoped work set internally while emitting compact counts, failures, and candidate snippets; packet files and redirected raw logs are never persisted or reread.
- Generated seed is reviewed through canonical preseed plus deterministic identity verification, not repeated generated-line searches.
- No token, turn, output-size, or concurrency cap substitutes for complete scoped review.

**Priority:** P1

**Dependencies:** [REQ-AGENT-071](#req-agent-071-pr-boundary-review-agent-dispatch), [REQ-AGENT-084](#req-agent-084-reviewer-policy-contract)

**Verification:** Automated test ([Agent seed manifest tests](../../src/__tests__/lib/agent-seed-multi-agent.test.ts), [reviewer tool-guard tests](../../src/__tests__/lib/review-tool-guard.test.ts), [review work-set tests](../../host/__tests__/pi-review-workset.test.js))

**Status:** Implemented

---

### REQ-AGENT-086: Claude Reviewer Direct Evidence and Root Handoff

**Intent:** Claude PR reviewers must complete exact scoped reviews through first-hand, context-efficient evidence while leaving every project-file and Git mutation to the root session.

**Applies To:** Agent

**Acceptance Criteria:**

1. Claude `code-reviewer`, `spec-reviewer`, and `doc-updater` expose direct shell execution as their only tool, with their enforcement policy embedded, and no repository-wide search, indexed-retrieval, native file-read, or file-mutation tool. <!-- @impl: preseed/agents/claude/agents/code-reviewer.md::tools --> <!-- @impl: preseed/agents/claude/agents/spec-reviewer.md::tools --> <!-- @impl: preseed/agents/claude/agents/doc-updater.md::tools --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-086 AC1/AC7: Claude PR reviewers carry the packet transport and no repository-wide scan tools) -->
2. Source, specification, and documentation trees stay read-only to reviewers. <!-- @impl: preseed/agents/claude/agents/code-reviewer.md::Operating Mode: Research + Report --> <!-- @impl: preseed/agents/claude/agents/spec-reviewer.md::REPORT-ONLY --> <!-- @impl: preseed/agents/claude/agents/doc-updater.md::REPORT-ONLY --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-086 AC3-AC5: seeded reviewers and review command carry the report-only root-handoff contract) -->
3. PR-boundary reviewers return structured findings without writing project or triage files. <!-- @impl: preseed/agents/claude/agents/code-reviewer.md::Operating Mode: Research + Report --> <!-- @impl: preseed/agents/claude/agents/spec-reviewer.md::REPORT-ONLY --> <!-- @impl: preseed/agents/claude/agents/doc-updater.md::REPORT-ONLY --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-086 AC3-AC5: seeded reviewers and review command carry the report-only root-handoff contract) --> <!-- @manual: Trigger a Claude SDD PR-boundary review; confirm each reviewer returns structured findings without writing files, confirm the root alone persists triage, then confirm the root evaluates and applies each legitimate finding. -->
4. The root session alone persists PR-boundary triage content. <!-- @impl: preseed/agents/claude/commands/review.md::Review ownership (binding) --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::DIRECTIVE --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-086 AC3-AC5: seeded reviewers and review command carry the report-only root-handoff contract) -->
5. The root session evaluates and applies legitimate PR-boundary fixes. <!-- @impl: preseed/agents/claude/commands/review.md::Review ownership (binding) --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::DIRECTIVE --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-086 AC3-AC5: seeded reviewers and review command carry the report-only root-handoff contract) -->
6. Every Claude PR-boundary reviewer runs pinned `medium` reasoning effort; transformed runtimes never inherit the Claude-only effort key. <!-- @impl: preseed/agents/claude/agents/code-reviewer.md::effort = medium --> <!-- @impl: preseed/agents/claude/agents/spec-reviewer.md::effort = medium --> <!-- @impl: preseed/agents/claude/agents/doc-updater.md::effort = medium --> <!-- @impl: scripts/generate-agent-seed.mjs::adaptAgentFrontmatter --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-086 AC6: reviewer effort pins are seeded for Claude and stripped from transforms) -->
7. Each Claude PR-boundary reviewer reasons from one `review-scope` evidence packet instead of repository-wide scans, building it through the seeded CLI only when the runner did not hand it one. <!-- @impl: preseed/agents/claude/skills/review-scope/SKILL.md::Build the lane packet once --> <!-- @impl: preseed/agents/claude/agents/code-reviewer.md::Your lane packet --> <!-- @impl: preseed/agents/claude/agents/spec-reviewer.md::Your lane packet --> <!-- @impl: preseed/agents/claude/agents/doc-updater.md::Your lane packet --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-086 AC1/AC7: Claude PR reviewers carry the packet transport and no repository-wide scan tools) -->

**Constraints:**

- Exact-head checkpoints, ancestry-derived ranges, lane classification, parallel launch, and completion correlation remain unchanged.
- Review scope, enforcement manifests, severity, and evidence truth remain complete.
- Reviewers inspect the complete scoped work set; the evidence packet bounds context, never scope.
- `/review` persists returned Phase 2/4/5/6 reports in the root; external verification, triage history, ADR updates, and issue creation are root-owned.
- Every reviewer search is bounded to counts or named candidates; an unbounded scan is the failure the packet transport exists to prevent.
- The reduced toolset applies wherever these agents run, including `/review`; graph-traversal verification of REQ-to-implementation chains belongs to `deep-reviewer`, which is unaffected.

**Priority:** P1

**Dependencies:** [REQ-AGENT-015](#req-agent-015-review-command-for-multi-perspective-codebase-review)

**Verification:** Automated test ([Agent seed manifest tests](../../src/__tests__/lib/agent-seed-manifest.test.ts), [Claude review reminder tests](../../host/__tests__/git-push-review-reminder.test.js))

**Status:** Implemented

---

### REQ-AGENT-102: Claude Reviewer Headless Lane Transport

**Intent:** A PR-boundary lane must pay for its own review policy and nothing else, so the lane runs in a process whose context it fully controls rather than inheriting a session it cannot trim.

**Applies To:** Agent

**Acceptance Criteria:**

1. Each Claude PR-boundary lane runs as a headless `claude -p` subprocess whose system prompt is the lane's own agent document. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/run-review-lane.sh::SYSTEM_PROMPT --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh — headless lane transport) -->
2. The review gate credits a lane under either that headless transport or a legacy Agent subagent spawn. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::lane_spawn_lines --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::tool_use_id_completed --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh — headless lane transport) -->
3. A lane whose range contains no file it owns returns a no-op report without invoking a model. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/run-review-lane.sh::REQUIRED --> <!-- @test: host/__tests__/run-review-lane.test.js (run-review-lane.sh — no-op short-circuit) -->
4. The lane subprocess carries a validated, escalating time bound that a zero, empty, or non-numeric override cannot disable; an unavailable supervisor refuses launch. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/run-review-lane.sh::LANE_TIMEOUT --> <!-- @test: host/__tests__/run-review-lane.test.js (run-review-lane.sh — timeout bound) --> <!-- @test: host/__tests__/run-review-lane.test.js (run-review-lane.sh — supervisor availability) -->
5. Guard re-injection fails closed on a missing guard, an absent JSON-processing dependency, an empty settings file, or a config path containing a space. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/run-review-lane.sh::GUARD_SETTINGS --> <!-- @test: host/__tests__/run-review-lane.test.js (run-review-lane.sh — guard settings under a hostile config path) -->
6. A lane whose background run ended without success counts as ended rather than in flight, so the gate re-demands it instead of awaiting it. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::tool_use_id_terminal --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (treats an unrecognised end status as terminal and a running status as not) -->
7. That demand states the lane already ran without being credited. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::spawn_ended_unsuccessfully --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh — headless lane transport) -->

**Constraints:**

- Lane floor reduction requires replacing the system prompt and pruning tool schemas (both CLI-only); a lane is therefore a subprocess, not a subagent.
- `--lane <name>` is the gate's match token; renaming the flag silently disables review enforcement.
- Dropping inherited settings drops hooks; build/test guards are re-injected explicitly and invoked as `bash <script>` (seeded hooks ship non-executable).
- Transport detection is additive: the legacy Agent shape stays credited, so a migrated lane is still counted as reviewed.
- A runner reference matched inside another command, or a background spawn's start receipt, must not credit a lane.
- A lane subprocess is time-bounded; an unbounded lane would hold the review gate open.
- Guard settings are constructed programmatically and verified non-empty before use.
- Triage state that alters a round is reported to the launching session, not only to the lane.

**Priority:** P1

**Dependencies:** [REQ-AGENT-086](#req-agent-086-claude-reviewer-direct-evidence-and-root-handoff)

**Verification:** Automated test ([Review spawn gate tests](../../host/__tests__/enforce-review-spawn.test.js))

**Status:** Implemented

---

### REQ-AGENT-103: Deterministic Lane Triage

**Intent:** A lane's Phase 0 answers are the same for every lane on a given range, so resolving them once outside the model costs nothing per lane and cannot drift between them.

**Applies To:** Agent

**Acceptance Criteria:**

1. Each lane's Phase 0 triage is resolved deterministically before the subprocess starts and handed to it. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-triage.mjs::main --> <!-- @test: host/__tests__/lane-triage.test.js (lane-triage.mjs — transition gate) --> <!-- @test: host/__tests__/lane-triage.test.js (lane-triage.mjs — round counter) -->
2. The pre-computed triage reproduces the bulk-op audit and round-limit gates the reviewer prose defines. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-triage.mjs::bulkOpAudit --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-triage.mjs::roundCounter --> <!-- @test: host/__tests__/lane-triage.test.js (lane-triage.mjs — bulk-op audit) -->
3. A lane whose triage resolves to a no-op returns without invoking a model only when the result carries positive evidence for a supported bootstrap, transition, or round-limit no-op. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/run-review-lane.sh::TRIAGE_JSON --> <!-- @test: host/__tests__/run-review-lane.test.js (run-review-lane.sh — triage no-op short-circuit) -->
4. Every triage condition that cannot be resolved, including malformed JSON or a wrong lane/decision/layout shape, resolves to running the review. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-triage.mjs::main --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/run-review-lane.sh::TRIAGE_JSON --> <!-- @test: host/__tests__/lane-triage.test.js (lane-triage.mjs — fail-safe direction) --> <!-- @test: host/__tests__/run-review-lane.test.js (run-review-lane.sh — triage no-op short-circuit) -->

5. A config that never mentions `enforce_tdd` resolves to on, not to a silent opt-out. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-triage.mjs::main --> <!-- @test: host/__tests__/lane-triage.test.js (lane-triage.mjs — config defaults) -->

**Constraints:**

- The packet and inlined triage block are byte-capped; over-cap blocks degrade to normal review.
- Triage answers the SDD questions only; documentation scaffolding is not among them and the doc lane still checks its own index.
- Lane ownership stays with the shell classifier and is passed in, never reimplemented in triage.
- The no-op decision is read as a field; matching it anywhere in the serialised document would drop a required review.

**Priority:** P1

**Dependencies:** [REQ-AGENT-102](#req-agent-102-claude-reviewer-headless-lane-transport)

**Verification:** Automated test ([Lane triage tests](../../host/__tests__/lane-triage.test.js))

**Status:** Implemented

---

### REQ-AGENT-104: Review Acknowledgement Requires a Published Verdict

**Intent:** A checkpoint that advances on lane exit records that processes ran, not that findings were read, so a later range can be measured from a head whose findings nobody acted on.

**Applies To:** Agent

**Acceptance Criteria:**

1. The review checkpoint advances only after every required lane has returned, the first Stop observation has yielded one notification-delivery turn, and the triage verdict has been published. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::completion_delivery_pending --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::triage_published_after_line --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh — headless lane transport) -->
2. A verdict forced before the required notification-delivery turn does not advance the checkpoint; only the later root-visible round may be triaged. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::completion_delivery_pending --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::latest_required_completion_line --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh — headless lane transport) -->
3. The verdict demand requires a gate-matching table with one row per finding across all required lanes. A fully clean round still publishes the table shape but does not add redundant clean-lane rows. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::triage_published_after_line --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/git-push-review-reminder.sh::DIRECTIVE --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh — headless lane transport) -->
4. Acknowledgement is followed by a fix directive that states the head is already acknowledged, then commits and pushes accepted file changes without renewed consent, waiting first for this head's terminal CI result; it never merges or creates a no-op commit. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::ROUND_COMPLETE_LINE --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (drives the FIX phase once the verdict is published) -->
5. Every path that advances the checkpoint applies the verdict requirement, including the retroactive scan. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::retroactive_ack_scan --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (applies the verdict requirement on the retroactive scan path, not just the live path) -->
6. Repeated unanswered verdict demands acknowledge the head rather than leave the checkpoint wedged. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::reack_on_repeated_demand --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (acknowledges after repeated unanswered demands instead of staying wedged) -->
7. Once every lane spawned in the session has returned and no verdict follows the last return, tool execution other than result reading is refused mid-turn until the verdict is published. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::PRETOOL_MODE --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::pretool_allow --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (enforce-review-spawn.sh — PreToolUse triage gate) -->

**Constraints:**

- The verdict is recognised by its stacked table header, divider, and data row in assistant text, even when tool calls share the message; quoting the header inline is not a verdict.
- A terminal record can precede native notification delivery; the first Stop observation ends silently so queued reports reach the root before triage is demanded.
- Result retrieval may use `Read` or `TaskOutput`; only the final verdict message is tool-free and ends the turn.
- The acknowledgement's fix directive owns accepted-fix commit delivery and never orders the push; a successful fix push is still automatic review consent, not a new approval question.
- The verdict demand is counted and rate-limited on its own, never on the counter that limits lane demands.
- Both runtimes recognise the same table shape, so a verdict is portable between them.
- The mid-turn refusal never writes acknowledgement or counter state, reads the bypass sentinel without consuming it, and releases after five refused calls; a lane still in flight or ended without success never triggers it.

**Priority:** P1

**Dependencies:** [REQ-AGENT-102](#req-agent-102-claude-reviewer-headless-lane-transport)

**Verification:** Automated test ([Review spawn gate tests](../../host/__tests__/enforce-review-spawn.test.js))

**Status:** Implemented

---

### REQ-AGENT-105: Review Lane Turn Economy

**Intent:** A lane re-sends its whole prompt every turn, so cost grows with the square of the turn count and the drip — one lookup per turn — is what a review actually pays for.

**Applies To:** Agent

**Acceptance Criteria:**

1. Lane evidence gathering is structured as waves, each collecting every outstanding question in one call. <!-- @impl: preseed/agents/claude/skills/review-scope/SKILL.md::`scope=diff` execution --> <!-- @manual: Inspect one completed reviewer transcript and confirm each evidence call batches all questions known at that point. -->
2. Where a runtime fetches a sub-policy rather than carrying it, the read happens inside a wave that was already being made rather than on a turn of its own. <!-- @impl: preseed/agents/claude/skills/review-scope/SKILL.md::`scope=diff` execution --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-105: large conditional policy is fetched, small always-applicable policy is embedded) -->
3. Policy that applies on almost every run is embedded in the reviewer document, whether or not it is nominally conditional. <!-- @impl: preseed/agents/claude/agents/code-reviewer.md::Embedded canonical policy --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-AGENT-105: large conditional policy is fetched, small always-applicable policy is embedded) -->
4. Every path that demands a lane passes an incremental range or protected PR base, so the demanded lane receives its packet and ownership short-circuit; the runner refuses a demand carrying neither. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::LANE_SCOPE --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/run-review-lane.sh::RANGE --> <!-- @test: host/__tests__/enforce-review-spawn.test.js (scopes the lanes it demands to the range under review) --> <!-- @test: host/__tests__/run-review-lane.test.js (run-review-lane.sh — scope contract) -->
5. Inlined evidence over its byte cap degrades deterministically by named field, keeping compact resolved answers. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/run-review-lane.sh::shed_to_cap --> <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/lane-evidence.mjs::bound --> <!-- @test: host/__tests__/run-review-lane.test.js (sheds the verbatim indexes rather than the whole evidence block) -->
6. A lane exceeding its wave budget is reported without being stopped. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/run-review-lane.sh::rawBudget --> <!-- @test: host/__tests__/run-review-lane.test.js (run-review-lane.sh — wave budget telemetry) -->
7. The lookups a lane checklist would order — index presence, tree layout, anchor resolution, documented-reference resolution, call sites, the decision ledger — are resolved before the lane starts and handed to it. <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/lane-evidence.mjs::main --> <!-- @test: host/__tests__/lane-evidence.test.js (reports an anchor whose symbol no longer exists as unresolved) --> <!-- @test: host/__tests__/lane-evidence.test.js (carries the diff of each cited file, not just the citation) --> <!-- @test: host/__tests__/lane-evidence.test.js (reports a tracked doc the index does not link, and passes one it does) --> <!-- @test: host/__tests__/run-review-lane.test.js (inlines the evidence block) --> <!-- @test: host/__tests__/run-review-lane.test.js (states the repository root so the lane does not spend a turn finding it) --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/run-review-lane.sh::EVIDENCE_JSON -->

**Constraints:**

- No hard turn, call, or token cap; truncating a review is worse than paying.
- A wave never licenses skipping a required check; it batches it.
- Broad discovery is forbidden: no survey, no indexed search, no re-reading returned evidence, no re-deriving a resolved block.
- Over-cap evidence degrades by field, never by block, each shed field a named marker stating its recovery.
- Resolved evidence counts passes and lists failures in full.
- A resolver failure yields an absent field, never an empty one.
- Report length is bounded: a finding short, a clean pass a count, the search never narrated.
- The lane prompt arrives on standard input, not as one argument.
- One canonical resolver serves both runtimes, reaching Pi byte-identically, and bounds itself so no caller is the unbounded one.
- Evidence covers why a lane was spawned, not only the files it owns.

**Priority:** P1

**Dependencies:** [REQ-AGENT-102](#req-agent-102-claude-reviewer-headless-lane-transport)

**Verification:** Automated test ([Review lane runner tests](../../host/__tests__/run-review-lane.test.js))

**Status:** Implemented

---

### REQ-AGENT-087: Pi Reviewer Execution Profile

**Intent:** Pi review lanes need a bounded provider-neutral reasoning profile so complete enforcement remains responsive without coupling the workflow to one model provider.

**Applies To:** Agent

**Acceptance Criteria:**

1. Code, specification, and documentation reviewers use Pi's provider-neutral `medium` thinking level instead of inheriting the root session's level. <!-- @impl: preseed/agents/pi/agents/code-reviewer.md::thinking = medium --> <!-- @impl: preseed/agents/pi/agents/spec-reviewer.md::thinking = medium --> <!-- @impl: preseed/agents/pi/agents/doc-updater.md::thinking = medium --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (REQ-AGENT-087: generated reviewers use provider-neutral medium thinking) --> <!-- @manual: Inspect one launch of each Pi PR reviewer and confirm its effective thinking level is `medium` while the selected provider remains unpinned. -->

**Constraints:**

- Pi maps `medium` to each selected model's supported reasoning controls without pinning a provider.
- Reviewer scope, enforcement policy, evidence, and severity remain unchanged.

**Priority:** P1

**Dependencies:** [REQ-AGENT-071](#req-agent-071-pr-boundary-review-agent-dispatch), [REQ-AGENT-084](#req-agent-084-reviewer-policy-contract)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-AGENT-088: User-Invoked Review Ownership and Triage

**Intent:** User-invoked review must preserve specialist independence while keeping every persisted artifact and mutation under explicit root and user control.

**Applies To:** User

**Acceptance Criteria:**

1. Pi `/review` dispatches a report-only execution contract whose reports belong to the root. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::REVIEW_EXECUTION --> <!-- @test: src/__tests__/lib/pi-review-scope.test.ts (REQ-AGENT-050 AC1/REQ-AGENT-088 AC1: dispatches the dedicated /review workflow contract) -->
2. Claude `/review` gives every subagent a binding report-only execution mode. <!-- @impl: preseed/agents/claude/commands/review.md::Review ownership (binding) --> <!-- @manual: Run `/review --diff --deep` with at least two surfaced findings; confirm each subagent returns without writes, the root persists every report, triage records exactly one decision per finding, defer/ignore/debt decisions reach `sdd/.review-decisions.md`, and no fix is applied before explicit approval. -->
3. The root session persists every returned review report. <!-- @impl: preseed/agents/claude/commands/review.md::Review ownership (binding) --> <!-- @impl: preseed/agents/pi/skills/review/SKILL.md::Review ownership (binding) --> <!-- @manual -->
4. The root applies a review fix only after the user approves it. <!-- @impl: preseed/agents/claude/commands/review.md::Review ownership (binding) --> <!-- @impl: preseed/agents/pi/skills/review/SKILL.md::Review ownership (binding) --> <!-- @manual -->
5. Interactive triage records exactly one decision for each surfaced finding. <!-- @impl: preseed/agents/claude/commands/review.md::Phase 8: Interactive Triage --> <!-- @impl: preseed/agents/pi/skills/review/SKILL.md::Phase 8: Interactive triage --> <!-- @manual -->
6. Defer, ignore, and technical-debt decisions persist to `sdd/.review-decisions.md`. <!-- @impl: preseed/agents/claude/commands/review.md::Phase 9: Save Triage Results + Append to .review-decisions --> <!-- @impl: preseed/agents/pi/skills/review/SKILL.md::Phase 9: Save triage results + append to .review-decisions --> <!-- @manual -->

**Constraints:**

- Existing specialist agent types are reused; this requirement introduces no duplicate review agents.
- Reviewer scope, evidence completeness, and severity remain unchanged.

**Priority:** P1

**Dependencies:** [REQ-AGENT-015](#req-agent-015-review-command-for-multi-perspective-codebase-review), [REQ-AGENT-050](#req-agent-050-pi-native-review-workflow-skill)

**Verification:** Automated test ([pi-review-scope](../../src/__tests__/lib/pi-review-scope.test.ts))

**Status:** Implemented

---

### REQ-AGENT-089: Pi Context-Mode Foreground Ownership

**Intent:** When a user explicitly enables context-mode, Pi must retain it in the interactive session without allowing in-process subagents to create competing context-mode owners.

**Applies To:** Agent

**Acceptance Criteria:**

1. Starting an in-process Pi subagent does not initialize a second context-mode owner. <!-- @impl: preseed/agents/pi/extensions/context-mode-runtime.ts::attachContextModeToForeground --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (REQ-AGENT-089 AC1: one process owner rejects child context-mode initialization) --> <!-- @manual: Launch code/spec/doc reviewers, confirm their tool manifests contain `bash` but no `ctx_*`, and after they finish verify the Pi process owns exactly one `context-mode/server.bundle.mjs` child. -->
2. After the owning session shuts down, a new session can initialize context-mode. <!-- @impl: preseed/agents/pi/extensions/context-mode-runtime.ts::attachContextModeToForeground --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (REQ-AGENT-089 AC2: owner shutdown permits context-mode reattachment) -->

**Constraints:**

- The integration imports the installed context-mode adapter without modifying context-mode or pi-subagents.
- Package settings retain context-mode skills while disabling shared extension autoload.
- In-process subagents use their documented native transports.
- Foreground `/ctx off` and `/ctx on` behavior remains owned by [REQ-AGENT-076](#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults).

**Priority:** P1

**Dependencies:** [REQ-AGENT-076](#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults)

**Verification:** Automated test ([Pi package settings tests](../../host/__tests__/pi-settings-packages.test.js), [agent seed manifest tests](../../src/__tests__/lib/agent-seed-multi-agent.test.ts))

**Status:** Implemented

---

### REQ-AGENT-090: CI monitor head correction is authoritative and fail-closed

**Intent:** The Pi CI monitor may recover the observed one-character-appended head transcription only when GitHub confirms the exact intended PR head; every other malformed head remains invalid.

**Applies To:** Agent

**Acceptance Criteria:**

1. A 41-character hexadecimal head is corrected only when its first 40 characters exactly equal the authoritative PR head. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::monitorCi --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-090 AC1: one appended head character is corrected only against the authoritative PR head) -->
2. Any malformed head that does not satisfy AC1 reports `invalid_request` before checks are queried. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::monitorCi --> <!-- @test: host/__tests__/pi-ci-monitor.test.js (REQ-AGENT-090 AC2: unrelated malformed heads remain invalid) -->

**Constraints:**

- Superseded valid heads continue to report `superseded`; correction never authorizes an obsolete head.
- No other truncation, padding, or malformed-head normalization is allowed.

**Priority:** P1

**Dependencies:** [REQ-AGENT-068](#req-agent-068-independent-pi-ci-monitoring)

**Verification:** Automated test ([Pi CI monitor behavioral tests](../../host/__tests__/pi-ci-monitor.test.js))

**Status:** Implemented

---

### REQ-AGENT-139: Optimized Documentation Lane Rendering and Delivery

**Intent:** Greenfield and imported SDD projects must receive the same concise documentation lanes through the existing initialization and seed-delivery workflows.

**Applies To:** User

**Acceptance Criteria:**

1. The bundled templates cover Architecture, API, Configuration, Deployment, Security, Observability, Troubleshooting, and the shared envelope for optional indexed project lanes. <!-- @impl: preseed/agents/claude/skills/spec-driven-development/references/templates/documentation-architecture.md::System Components --> <!-- @impl: preseed/agents/claude/skills/spec-driven-development/SKILL.md::Templates location --> <!-- @test: host/__tests__/documentation-template-contract.test.js (renders every canonical lane and a project lane consistently in both init modes) -->
2. Greenfield and Import Mode pass their evidence-selected lanes through one renderer. <!-- @impl: preseed/agents/claude/skills/sdd-init/references/render-documentation-templates.mjs::renderDocumentationTemplates --> <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Phase 6 — Documentation lane emission and audit (binding) --> <!-- @test: host/__tests__/documentation-template-contract.test.js (renders every canonical lane and a project lane consistently in both init modes) -->
3. Rendering emits only selected lane files and matching index rows. <!-- @impl: preseed/agents/claude/skills/sdd-init/references/render-documentation-templates.mjs::renderDocumentationTemplates --> <!-- @test: host/__tests__/documentation-template-contract.test.js (emits only selected lane rows) -->
4. Rendering requires a fresh non-symlink staging path. <!-- @impl: preseed/agents/claude/skills/sdd-init/references/render-documentation-templates.mjs::renderDocumentationTemplates --> <!-- @test: host/__tests__/documentation-template-contract.test.js (requires fresh non-symlink staging and removes partial render output) -->
5. A rendering failure removes its partial staging output. <!-- @impl: preseed/agents/claude/skills/sdd-init/references/render-documentation-templates.mjs::renderDocumentationTemplates --> <!-- @test: host/__tests__/documentation-template-contract.test.js (requires fresh non-symlink staging and removes partial render output) -->
6. Checked promotion keeps the live documentation tree restorable until post-promotion validation succeeds. <!-- @impl: preseed/agents/claude/skills/sdd-init/SKILL.md::Greenfield — lean two-confirm flow --> <!-- @manual: On a disposable Import Mode fixture with existing documentation, force post-promotion validation to fail and confirm the original tree is restored from the sibling backup. -->
7. The renderer and new templates reach Claude and Pi through the canonical manifest and generated-seed pipeline. <!-- @impl: preseed/agents/claude/manifest.json::skills/sdd-init/references/render-documentation-templates.mjs --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (REQ-AGENT-139 AC7: optimized documentation templates reach Claude and Pi seeds) -->

**Constraints:** Existing discovery, Import Mode triage, and review ownership remain unchanged. Architecture and the ADR ledger remain universal; other lanes require source evidence. Project lanes stay first-level, indexed, source-backed, and outside canonical lane ownership. No project schema engine or replacement migration subsystem is introduced.

**Priority:** P1

**Dependencies:** [REQ-AGENT-033](#req-agent-033-sdd-init-scaffolding-and-canonical-render)

**Verification:** Automated test ([documentation template contract tests](../../host/__tests__/documentation-template-contract.test.js), [generated seed parity tests](../../src/__tests__/lib/agent-seed-multi-agent.test.ts)) and manual promotion/rollback validation

**Status:** Implemented

---

### REQ-AGENT-140: Lossless Documentation Lane Cleanup and Enforcement

**Intent:** Existing SDD projects must converge toward the optimized lane structures without hiding genuine defects or losing project knowledge.

**Applies To:** User

**Acceptance Criteria:**

1. `/sdd clean` normalizes a recognized collection only when every load-bearing clause, link, diagram, compatibility fragment, requirement, decision, and source anchor is preserved. <!-- @impl: preseed/agents/claude/skills/sdd-clean/SKILL.md::What gets cleaned --> <!-- @impl: preseed/agents/claude/skills/doc-enforce-shape/SKILL.md::Pass 6 — Collection rendering consistency --> <!-- @manual: On a disposable advanced-mode fixture, run `/sdd clean --scope=all` over a mixed-shape collection containing each protected artifact and confirm the normalized output preserves all of them byte-for-byte or defers unchanged. -->
2. Shape enforcement validates positively recognized lane records. <!-- @impl: preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs::checkDocuments --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (optimized documentation lane shapes) -->
3. Shape enforcement accepts documented legacy field aliases. <!-- @impl: preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs::checkDocuments --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (accepts Description as a legacy configuration Purpose alias) --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (accepts legacy deployment field aliases without making them canonical) --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (accepts minimal and legacy API sections and validates detailed standard-method sections) -->
4. Shape enforcement exempts unrelated headings and tables. <!-- @impl: preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs::checkDocuments --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (does not confuse unrelated tables with governed collections) -->
5. The reusable checker contains no product-specific item inventory. <!-- @impl: preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs::checkDocuments --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (accepts the current indexed Codeflare lane corpus without product inventory names) -->
6. Indexed first-level project lanes retain the shared ownership, navigation, evidence-map, and related-document envelope. <!-- @impl: preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs::scanProjectLane --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (checks the shared envelope of first-level project lanes) -->

**Constraints:** Existing cleanup modes, layout migration, and root-owned mutation order remain unchanged. Ambiguous or conflicting content is reported and left intact. No suppression baseline or separate migration subsystem is introduced.

**Priority:** P1

**Dependencies:** [REQ-AGENT-037](#req-agent-037-sdd-clean-rescue-and-autonomy-modes), [REQ-AGENT-044](#req-agent-044-review-agent-discipline-enforcement), [REQ-AGENT-139](#req-agent-139-optimized-documentation-lane-rendering-and-delivery)

**Verification:** Automated test ([documentation shape tests](../../host/__tests__/doc-enforce-shape.test.js)) and manual cleanup validation

**Status:** Implemented

---

### REQ-AGENT-142: Unambiguous Documentation Decision History

**Intent:** SDD-generated and cleaned decision ledgers must make historical state understandable while preserving stable references and useful history.

**Applies To:** User

**Acceptance Criteria:**

1. Every decision-index identifier links to a matching stable ADR section, and every ADR section has an index row. <!-- @impl: preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs::scanDecisions --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (requires ADR index/section pairing and retained superseded history) --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (requires linked ADR IDs to target their matching section anchors) -->
2. A fully superseded ADR retains substantive historical content beyond its status in the stable section. <!-- @impl: preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs::scanDecisions --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (requires ADR index/section pairing and retained superseded history) --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (does not use later unrelated sections as superseded ADR history) -->
3. A fully superseded ADR has both its linked ID and decision cells visibly struck through in the decision index. <!-- @impl: preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs::scanDecisions --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (requires superseded ADR index entries to be visibly struck through) -->
4. A partially superseded ADR remains unstruck in the decision index. <!-- @impl: preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs::scanDecisions --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (keeps partial ADRs unstruck and requires a linked successor with clause detail) -->
5. A partially superseded ADR names the replaced clause and links its successor in the section status. <!-- @impl: preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs::scanDecisions --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (keeps partial ADRs unstruck and requires a linked successor with clause detail) --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (independently requires partial clause detail and redirect destinations) -->
6. A merged or reclassified ADR uses the explicit `Redirect anchor` state instead of parenthetical redirect shorthand. <!-- @impl: preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs::scanDecisions --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (rejects ambiguous redirect category labels in ADR indexes) -->
7. A merged or reclassified ADR links its destination from the section status. <!-- @impl: preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs::scanDecisions --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (independently requires partial clause detail and redirect destinations) -->

**Constraints:** Cleanup never deletes historical ADR bodies or guesses whether a record is fully versus partially superseded. Existing inbound AD anchors remain stable. Strikethrough is allowed only in the ID and decision cells of fully superseded index rows.

**Priority:** P1

**Dependencies:** [REQ-AGENT-139](#req-agent-139-optimized-documentation-lane-rendering-and-delivery), [REQ-AGENT-140](#req-agent-140-lossless-documentation-lane-cleanup-and-enforcement)

**Verification:** Automated test ([documentation shape tests](../../host/__tests__/doc-enforce-shape.test.js))

**Status:** Implemented

---

### REQ-AGENT-143: Resolvable Documentation Evidence References

**Intent:** Documentation evidence maps must resolve each requirement and decision reference without forcing readers to interpret shorthand.

**Applies To:** User

**Acceptance Criteria:**

1. Every ADR identifier in a Security verification/source map links directly to its decision anchor. <!-- @impl: preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs::scanTables --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (requires linked AD references and rejects vague SDD labels in security source maps) --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (rejects Security source-map links with wrong files or anchors) -->
2. Every REQ or CON identifier in a Security verification/source map links directly to its specification anchor. <!-- @impl: preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs::scanTables --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (requires linked AD references and rejects vague SDD labels in security source maps) --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (rejects Security source-map links with wrong files or anchors) -->
3. Requirement-domain references in a Security verification/source map link the exact specification file instead of using unexplained `SDD` labels. <!-- @impl: preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs::scanTables --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (requires linked AD references and rejects vague SDD labels in security source maps) --> <!-- @test: host/__tests__/doc-enforce-shape.test.js (rejects Security source-map links with wrong files or anchors) -->

**Constraints:** The reusable checker recognizes reference syntax and contains no product-specific decision or requirement inventory.

**Priority:** P1

**Dependencies:** [REQ-AGENT-140](#req-agent-140-lossless-documentation-lane-cleanup-and-enforcement), [REQ-AGENT-142](#req-agent-142-unambiguous-documentation-decision-history)

**Verification:** Automated test ([documentation shape tests](../../host/__tests__/doc-enforce-shape.test.js))

**Status:** Implemented

---
