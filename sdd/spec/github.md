# GitHub Integration

Connecting a user's GitHub account, browsing repositories, cloning them into sessions, and letting the in-session agent act on GitHub with the user's own permissions — without the raw token sitting in the container in enterprise mode.

**Domain owner:** Backend (Worker) + Frontend

### Key Concepts

- **Connect GitHub** -- An explicit, additive action (a button in the GitHub panel) that authorizes Codeflare to act as the user on GitHub. It is never the Codeflare login; login stays Cloudflare Access (enterprise) or the existing auth mode.
- **GitHub App (user-to-server)** -- An internal GitHub App, registered and installed on the customer's org, whose user-to-server tokens act **as the user** (commits attributed to them), expire (~8h), and are refreshable. The EMU-reliable path. Codeflare only configures it (Client ID + Secret); no app code and no private key are needed.
- **OAuth App** -- The existing hosted OAuth App, used for non-EMU SaaS. Long-lived token.
- **Provider seam** -- One `GithubOAuthProvider` interface with two implementations (App, OAuth) selected by deploy config; everything downstream is provider-agnostic.
- **DeployKeys.githubToken** -- The existing per-user encrypted KV field (`deploy-keys:<bucket>`) that already flows to the container as `GH_TOKEN`. Connect GitHub populates the same field the manual PAT UI fills. No new KV key.
- **Egress injection** -- In enterprise mode the container holds a non-secret placeholder `GH_TOKEN`; the real per-user token is injected into outbound `github.com` / `api.github.com` requests by a Worker interceptor at the container egress boundary (reusing the AI-Gateway interception layer).

### Out of Scope

- GitHub as a Codeflare login/IdP (login is Cloudflare Access in enterprise; see [Authentication](authentication.md)).
- Webhooks, PR/issue management UI, code review surfaces inside the panel (the panel is connect + repo list + clone only).
- GitHub App installation/bot (server-to-server) tokens — only user-to-server tokens are used, so the agent acts as the user.

### Domain Dependencies

[Authentication](authentication.md) (identity + the OAuth callback), [Security](security.md) (the egress interception layer), [Storage](storage.md) (`bucketName` keying, workspace sync), [Session Lifecycle](session-lifecycle.md) (clone-on-start).

---

### REQ-GITHUB-001: GitHub token capture and storage

**Intent:** A user connects their GitHub account once; Codeflare obtains a per-user token (GitHub App user-to-server in enterprise/EMU, OAuth App in SaaS) and stores it encrypted so the agent can act as the user.

**Applies To:** User

**Acceptance Criteria:**

1. `Connect GitHub` starts the selected provider's authorization flow in link mode. <!-- @impl: src/routes/github.ts::app --> <!-- @test: src/__tests__/routes/github.test.ts (redirects to the provider authorize URL with a signed state + connect callback) -->
2. Token storage uses configured at-rest encryption or the accepted [AD32](../../documentation/decisions/README.md#ad32-encryption_key-is-optional) plaintext JSON fallback. <!-- @impl: src/lib/github-token.ts::storeGithubConnection --> <!-- @impl: src/lib/kv-crypto.ts::encryptAndStore --> <!-- @test: src/__tests__/lib/github-token.test.ts (encrypts the token at rest when ENCRYPTION_KEY is set, and round-trips on read) -->
3. The stored token is never returned to the browser. <!-- @test: src/__tests__/routes/github.test.ts (REQ-GITHUB-002: reports connected with login + source when a token exists) --> <!-- @impl: src/lib/github-token.ts::storeGithubConnection --> <!-- @test: src/__tests__/lib/github-token.test.ts (github-token storage & status) -->
4. GitHub App tokens carry an expiry and refresh token; resolving a token returns a currently-valid one, refreshing within the skew window and **failing closed** (returning none) when an expired App token cannot be refreshed — never a stale token. <!-- @impl: src/lib/github-token.ts::getValidGithubToken --> <!-- @test: src/__tests__/lib/github-token.test.ts (returns a fresh App token without refreshing) --> <!-- @test: src/__tests__/lib/github-token.test.ts (refreshes a near-expiry App token, persists the rotated token+expiry, preserves login) --> <!-- @test: src/__tests__/lib/github-token.test.ts (fails closed (null) when an expired App token has no refresh token) --> <!-- @test: src/__tests__/lib/github-token.test.ts (fails closed (null) when the refresh call fails — never returns the stale token) -->
5. In every mode, prefer Setup KV's selected App or OAuth provider; only unavailable or incomplete Setup permits deploy-env fallback, preferring GitHub App over OAuth App. With neither source supplying a usable provider, the integration is unavailable. <!-- @impl: src/lib/github-token.ts::getGithubProvider --> <!-- @impl: src/lib/github-token.ts::getProviderFromKv --> <!-- @test: src/__tests__/lib/github-token.test.ts (getGithubProvider) -->
6. Outside Enterprise, a manually pasted fine-grained deploy PAT coexists as source `'pat'` and never goes to App/OAuth refresh or revoke endpoints. In Enterprise, [REQ-ENTERPRISE-306](security.md#req-enterprise-306-enterprise-direct-deploy-credential-boundary) governs direct denial and preserves both managed GitHub connections. <!-- @impl: src/routes/deploy-keys.ts::app --> <!-- @test: src/__tests__/lib/github-token.test.ts (getValidGithubToken) -->
7. The link callback exchanges the code and saves the token and its source in the existing deploy-credential record, not a second record. <!-- @impl: src/lib/github-token.ts::connectGithub --> <!-- @test: src/__tests__/routes/github-auth.test.ts (connects when the state is bound to the session bucket) --> <!-- @test: src/__tests__/lib/github-token.test.ts (App exchange stores token + refresh + expiry + login) --> <!-- @test: src/__tests__/lib/github-token.test.ts (OAuth exchange stores a long-lived token with no refresh/expiry) -->

**Constraints:**

- Scopes: the OAuth App's `scope` is derived per connect from the requested tier (default `repo gist read:org workflow read:user`; see [REQ-GITHUB-317](#req-github-317-additive-github-connection-and-scope-contract) AC4 and [REQ-GITHUB-013](#req-github-013-connected-github-tokens-grant-gist-access)); the GitHub App's equivalent permissions are fixed at registration and ignore the tier.
- Enterprise GitHub Apps must be **internal** to the customer's enterprise.
- GitHub connection controls use OAuth without manual token paste on the dashboard ([REQ-GITHUB-007](#req-github-007-broaden-the-panel-gate-beyond-enterprise)); Settings → Integrations manages owner Cloudflare connections independently of administrator Browser Run credentials ([REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)).
- Keep non-Enterprise deploy-key PAT behavior; Enterprise direct-credential denial changes neither provider resolution nor legacy handling.

**Priority:** P1

**Dependencies:** [REQ-AUTH-002](authentication.md#req-auth-002-saas-mode-uses-direct-github-oauth), [CON-GH-001](constraints.md#con-gh-001-github-token-encrypted-at-rest-and-never-returned-to-the-browser), [CON-GH-002](constraints.md#con-gh-002-the-real-github-token-never-enters-the-enterprise-container)

**Verification:** Automated: [github-token.test.ts](../../src/__tests__/lib/github-token.test.ts), [github.test.ts](../../src/__tests__/routes/github.test.ts), [github-auth.test.ts](../../src/__tests__/routes/github-auth.test.ts)

**Status:** Implemented

---

### REQ-GITHUB-002: GitHub panel and repository listing

**Intent:** A panel beside the R2 storage panel lets a user connect GitHub and browse the repositories they can access; it is the default right-column face on every session whenever GitHub is enabled, with no session-tier gate ([REQ-GITHUB-007](#req-github-007-broaden-the-panel-gate-beyond-enterprise)).

**Applies To:** User

**Acceptance Criteria:**

1. Connection-status inspection reports connection state, connected account login and credential source without exposing the token. <!-- @impl: src/routes/github.ts::app --> <!-- @test: src/__tests__/routes/github.test.ts (REQ-GITHUB-002: reports connected with login + source when a token exists) -->
2. The server fetches repository pages with the stored token, including accessible personal and organization repositories. The client filters loaded pages only; clear a zero-match filter to reveal Load more. The token never reaches the browser. <!-- @test: src/__tests__/routes/github.test.ts (REQ-GITHUB-002 AC2: lists accessible organization repositories across provider pages) --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (REQ-GITHUB-002 AC2: clearing zero matches restores Load more and appends organization rows inside the same panel) --> <!-- @impl: src/routes/github.ts::REPOS_PER_PAGE --> <!-- @test: src/__tests__/routes/github.test.ts (REQ-GITHUB-002: proxies the user repos with the stored token and never returns the token) -->
3. GitHub and Storage share the dashboard's right-column panel area under [REQ-GITHUB-012](#req-github-012-responsive-github-and-storage-panel-allocation). The backend and no-tier dashboard gates belong to [REQ-GITHUB-007](#req-github-007-broaden-the-panel-gate-beyond-enterprise). <!-- @impl: web-ui/src/components/Dashboard.tsx::effectiveFace --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-GITHUB-002 AC5: flips one GitHub/storage face at a time on mobile) -->
4. Not-connected shows a Connect GitHub action; connected shows the account, refresh, Disconnect, and searchable repo list. Controls must follow the [shared primitive contract](../../documentation/lanes/terminal-and-ide.md#github-and-storage-workspace). <!-- @impl: web-ui/src/components/github/ConnectedHeader.tsx::ConnectedHeader --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (GitHubPanel Component) -->
5. In the narrow Code Dashboard, the panel shows one flippable GitHub or storage face at a time. <!-- @impl: web-ui/src/components/Dashboard.tsx::effectiveFace --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-GITHUB-002 AC5: flips one GitHub/storage face at a time on mobile) -->
6. The owner/login label and each repo name link to GitHub in a new tab; repo-name clicks do not trigger clone. <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (repo name links to the repo on GitHub in a new tab) --> <!-- @manual -->
7. Dashboard returns reuse loaded repositories and search. The first page refreshes quietly at most once per five minutes on return, never replacing accumulated pages. Manual reload and connection changes bypass the window. <!-- @impl: web-ui/src/stores/github.ts::loadStatus --> <!-- @test: web-ui/src/__tests__/stores/github.test.ts (REQ-GITHUB-002 AC7: reuses fresh repositories and quietly refreshes stale results without clearing search) --> <!-- @test: web-ui/src/__tests__/stores/github.test.ts (REQ-GITHUB-002 AC7: preserves loaded pages until manual reload or account change) -->

**Constraints:**

- `/repos` and `/connect` are rate-limited; repo responses never include the token.
- The panel is available in every mode and renders whenever GitHub is enabled — there is no session-tier gate; it is the default right-column face on every session (connected or not); See [REQ-GITHUB-007](#req-github-007-broaden-the-panel-gate-beyond-enterprise).

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage)

**Verification:** Automated: [github.test.ts](../../src/__tests__/routes/github.test.ts), [Dashboard.test.tsx](../../web-ui/src/__tests__/components/Dashboard.test.tsx), [GitHubPanel.test.tsx](../../web-ui/src/__tests__/components/GitHubPanel.test.tsx), [GitHub store tests](../../web-ui/src/__tests__/stores/github.test.ts); Manual: [GitHub links acceptance](../../documentation/lanes/terminal-and-ide.md#github-links-acceptance)

**Status:** Implemented

---

### REQ-GITHUB-003: Enterprise egress-injected GitHub credentials

**Intent:** In enterprise mode the agent's git/`gh`/API calls to GitHub are authenticated by injecting the user's token at the container egress boundary, so the real token never enters the container.

**Applies To:** System

**Acceptance Criteria:**

1. `github.com`, `api.github.com`, and Copilot's remote GitHub MCP host `api.githubcopilot.com` are registered for outbound HTTPS interception and handled by a GitHub interceptor; AI hosts continue to route to the LLM interceptor. <!-- @test: src/__tests__/github-interceptor.test.ts (REQ-GITHUB-003 AC1: registered GitHub destinations dispatch to GitHub while the AI destination reaches the LLM gateway) --> <!-- @impl: src/container/container-interception.ts::github --> <!-- @impl: src/github-interceptor.ts::interceptedGithubHosts --> <!-- @test: src/__tests__/container/enterprise-llm.test.ts (REQ-GITHUB-003: wires the GitHubInterceptor for the github hosts with the per-session user + bucket props) -->
2. Each mediated git/REST/MCP request decrypts the bound user's token, strips supplied auth, then stamps git Basic, REST bearer plus API version, or Copilot MCP bearer without API version so remote MCP authenticates. <!-- @test: src/__tests__/github-interceptor.test.ts (REQ-GITHUB-003: REST API credential injection) --> <!-- @test: src/__tests__/github-interceptor.test.ts (REQ-GITHUB-003: git Smart-HTTP credential injection) --> <!-- @impl: src/github-interceptor.ts::GitHubInterceptor --> <!-- @test: src/__tests__/github-interceptor.test.ts (REQ-GITHUB-003: Copilot remote GitHub MCP credential injection) -->
3. When no valid mediated GitHub token exists, git/REST/MCP fails closed with a clear error and performs no upstream request. <!-- @test: src/__tests__/github-interceptor.test.ts (%s token denies git and MCP without upstream I/O) --> <!-- @impl: src/github-interceptor.ts::GitHubInterceptor --> <!-- @test: src/__tests__/github-interceptor.test.ts (REQ-GITHUB-003: fail closed) -->
4. Each session can inject only its own user's token, identified solely by the per-session interceptor binding, never the request. <!-- @test: src/__tests__/github-interceptor.test.ts (injects the BOUND bucket token regardless of a real token the request tries to pass through) --> <!-- @impl: src/container/container-interception.ts::github --> <!-- @test: src/__tests__/container/enterprise-llm.test.ts (REQ-GITHUB-003: wires the GitHubInterceptor for the github hosts with the per-session user + bucket props) -->
5. In ordinary non-enterprise human sessions the token reaches the container through the unchanged deploy-credential environment transport; restricted operators retain placeholder transport in every mode (see [REQ-GITHUB-006](#req-github-006-other-mode-container-transport)). <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (REQ-GITHUB-003 / REQ-GITHUB-006: emits the real GH_TOKEN unchanged in non-enterprise mode) -->
6. Internal REST metadata lookups send a valid User-Agent. <!-- @impl: src/github-interceptor.ts::GitHubInterceptor --> <!-- @test: src/__tests__/operators/review-boundary-egress.test.ts (REQ-OPERATOR-053: $name when GitHub requires User-Agent, without staging on check) -->

**Constraints:**

- Enterprise interception is wired only when `ENTERPRISE_MODE=active`, at container start (CA-mount timing — see [REQ-ENTERPRISE-005](models-and-routing.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls)).
- With strict egress active, `GitHubInterceptor` uses `env.EGRESS.fetch` and returns `503 EGRESS_UNAVAILABLE` when unbound; otherwise it uses global fetch ([REQ-ENTERPRISE-016](security.md#req-enterprise-016-strict-gateway-egress)).
- Credential injection, bound-bucket no-spoof scoping, manual redirects, and response hygiene remain identical across both transports.
- Explicit human-native Copilot/OAuth requests use the separate default-off [REQ-ENTERPRISE-090](models-and-routing.md#req-enterprise-090-native-pi-forwarding-under-current-administration-permission) boundary; they never authorize platform-token injection or Operators.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [CON-GH-002](constraints.md#con-gh-002-the-real-github-token-never-enters-the-enterprise-container), [CON-GH-003](constraints.md#con-gh-003-egress-injection-is-scoped-by-the-per-session-binding)

**Verification:** Automated: [github-interceptor.test.ts](../../src/__tests__/github-interceptor.test.ts), [review-boundary-egress.test.ts](../../src/__tests__/operators/review-boundary-egress.test.ts), [enterprise-llm.test.ts](../../src/__tests__/container/enterprise-llm.test.ts), [container-env.test.ts](../../src/__tests__/container/container-env.test.ts)

**Status:** Implemented

---

### REQ-GITHUB-004: Clone a repository into a session

**Intent:** From the panel a user clones a repository into a new or running session, into the workspace, ready for the agent.

**Applies To:** User

**Acceptance Criteria:**

1. Clone offers running sessions first and a separated new-session option; all rows share the option layout and left edge, while running rows use their session agent icon and subtitle. <!-- @impl: web-ui/src/components/github/ClonePickerOptionRow.tsx::ClonePickerOptionRow --> <!-- @impl: web-ui/src/components/github/ClonePicker.tsx::ClonePicker --> <!-- @impl: web-ui/src/components/github/ClonePickerSessionRow.tsx::ClonePickerSessionRow --> <!-- @test: web-ui/src/__tests__/components/ClonePicker.test.tsx (renders the running group before the new-session group through shared option rows) -->
2. On session creation, startup attempts the `clone` without gating terminal readiness. VS Code retains its existing restore-before-release order. A running-session clone instead targets the authenticated live session. <!-- @test: src/__tests__/routes/github.test.ts (forwards to the container /internal/git-clone and relays a 200) --> <!-- @manual -->
3. The validated repository basename is preserved verbatim as a direct child of the normalized user workspace; cloning refuses an existing target with a clear message. <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-014 AC6+AC7: rejects option-leading refs and refuses an existing target without invoking git) --> <!-- @impl: host/src/git-clone.ts::resolveGitClone --> <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-004: resolveGitClone validation + dir computation) -->
4. Both live-session and new-session clone actions omit a ref and clone the repository's default branch. <!-- @test: web-ui/src/__tests__/components/GitHubCloneFlow.test.tsx (REQ-GITHUB-004 AC4: choosing a new-session agent sends the eventual creation request without a ref) --> <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-004 AC4: ${owner} clone checks out the local remote default branch without an explicit ref) --> <!-- @impl: web-ui/src/components/github/ClonePicker.tsx::ClonePicker --> <!-- @test: web-ui/src/__tests__/components/ClonePicker.test.tsx (selecting a running session clones with {repo, sessionId} and NO ref) --> <!-- @impl: host/src/git-clone.ts::buildCloneArgs -->
5. The cloned working tree is ephemeral by default and participates in workspace sync when the user has it enabled. <!-- @impl: host/src/git-clone.ts::resolveGitClone --> <!-- @manual -->
6. The clone panel displays the repository's default branch without offering a branch picker. <!-- @impl: web-ui/src/components/github/ClonePicker.tsx::ClonePicker --> <!-- @manual -->
7. If Stop cancels a new-session Start before readiness, the launch does not report success. <!-- @impl: web-ui/src/stores/session.ts::createSessionWithClone --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (does not report a successful repository launch when Stop cancels Start) -->

**Constraints:**

- The running-session clone is authenticated by the existing `CONTAINER_AUTH_TOKEN` Worker→DO mechanism.
- Enterprise egress injection and non-Enterprise human token transport retain the [GitHub credential boundaries](#req-github-006-other-mode-container-transport), including restricted-Operator placeholder isolation.
- Backend clone transport accepts a supplied ref separately; that capability is not a branch-selection control in the panel.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [REQ-SESSION-001](session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type)

**Verification:** Automated: [git-clone.test.js](../../host/__tests__/git-clone.test.js), [github.test.ts](../../src/__tests__/routes/github.test.ts), [ClonePicker.test.tsx](../../web-ui/src/__tests__/components/ClonePicker.test.tsx), [GitHubCloneFlow.test.tsx](../../web-ui/src/__tests__/components/GitHubCloneFlow.test.tsx), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts); Manual: [GitHub clone acceptance](../../documentation/lanes/architecture.md#github-clone-acceptance)

**Status:** Implemented

---

### REQ-GITHUB-322: Cancelled clone launch feedback

**Intent:** Explain a cancelled new-session launch in the open clone picker.

**Applies To:** User

**Acceptance Criteria:**

1. When a new-session Start cancelled by Stop settles, the clone picker shows failure without closing if it is still open. <!-- @impl: web-ui/src/components/github/ClonePicker.tsx::ClonePicker --> <!-- @test: web-ui/src/__tests__/components/ClonePicker.test.tsx (disables controls while launching and keeps the picker open after a cancelled repository launch) -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-004](#req-github-004-clone-a-repository-into-a-session)

**Verification:** Automated: [ClonePicker.test.tsx](../../web-ui/src/__tests__/components/ClonePicker.test.tsx)

**Status:** Implemented

---

### REQ-GITHUB-014: Clone-created session resume

**Intent:** A session created from a repository retries its original clone safely when ephemeral workspace storage is absent after resume.

**Applies To:** User

**Acceptance Criteria:**

1. Resume re-applies the tracked repository list with the original repository first. Attempts follow [REQ-GITHUB-016](#req-github-016-tracked-repository-restoration). Terminal readiness does not wait for them. <!-- @impl: src/lib/clone-targets.ts::buildCloneTargets --> <!-- @impl: src/container/container-router.ts::dispatchInternalRoute --> <!-- @impl: src/container/container-env.ts::applyPrefsOnRestart --> <!-- @test: src/__tests__/container/container-router.test.ts (REQ-GITHUB-014 AC1: restores the clone directive when a stopped session resumes with a fresh container) -->
2. A failed container configuration request blocks the Start attempt when it carries either the original clone directive or a nonempty tracked target list. This is separate from a later Git clone failure. <!-- @impl: src/routes/container/lifecycle-init.ts::configureContainerDO --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (REQ-GITHUB-014 AC2: blocks resume when clone restoration returns an unexpected status) --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (REQ-GITHUB-014 AC2: blocks resume when clone restoration cannot reach the container) --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (REQ-GITHUB-014 AC2: tracked-only restoration %s controls startup) -->
3. Startup makes one clone attempt per missing tracked target within the restore budget of [REQ-GITHUB-016](#req-github-016-tracked-repository-restoration). <!-- @impl: entrypoint.sh::restore_startup_repositories --> <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-014 AC3: preserves a validated .git basename, branches safely, and keeps argv separated) -->
4. A failed clone attempt is logged. <!-- @impl: entrypoint.sh::restore_startup_repositories --> <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-014 AC4+AC5: logs a clone failure and continues startup successfully) -->
5. A failed clone attempt does not block startup. <!-- @impl: entrypoint.sh::restore_startup_repositories --> <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-014 AC4+AC5: logs a clone failure and continues startup successfully) -->
6. An existing target remains unchanged. <!-- @impl: entrypoint.sh::restore_startup_repositories --> <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-014 AC6+AC7: rejects option-leading refs and refuses an existing target without invoking git) -->
7. Git is not invoked for an existing target. <!-- @impl: entrypoint.sh::restore_startup_repositories --> <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-014 AC6+AC7: rejects option-leading refs and refuses an existing target without invoking git) -->

**Constraints:** Clone authentication continues to use the per-mode credential path defined by [REQ-GITHUB-004](#req-github-004-clone-a-repository-into-a-session).

**Priority:** P1

**Dependencies:** [REQ-GITHUB-004](#req-github-004-clone-a-repository-into-a-session), [REQ-SESSION-001](session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type)

**Verification:** Automated: [container-router.test.ts](../../src/__tests__/container/container-router.test.ts), [container-lifecycle-helpers.test.ts](../../src/__tests__/routes/container-lifecycle-helpers.test.ts), [git-clone.test.js](../../host/__tests__/git-clone.test.js)

**Status:** Implemented

---

### REQ-GITHUB-015: Workspace repository tracking

**Intent:** A session retains a bounded, validated inventory of the GitHub repositories currently present in its workspace.

**Applies To:** User

**Acceptance Criteria:**

1. Repositories present at the workspace top level are reported for tracking, whichever way they arrived. <!-- @impl: host/src/metrics.ts::collectWorkspaceRepos --> <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: host/__tests__/workspace-repos.test.js (REQ-GITHUB-015 AC1: workspace repository inventory) --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-GITHUB-015 AC1: tracks the repositories the container reports in its workspace) -->
2. A repository removed from the workspace is removed from tracking. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-GITHUB-015 AC1: stops tracking a repository the user removed from the workspace) -->
3. Tracking rejects malformed repository or branch identities. <!-- @impl: src/lib/clone-targets.ts::normalizeTrackedClones --> <!-- @test: src/__tests__/lib/clone-targets.test.ts (REQ-GITHUB-015 AC2: normalizeTrackedClones) --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-GITHUB-015 AC2: refuses malformed reported repositories and leaves tracking untouched) -->
4. Tracking retains at most 20 repositories. <!-- @impl: src/lib/clone-targets.ts::normalizeTrackedClones --> <!-- @test: src/__tests__/lib/clone-targets.test.ts (REQ-GITHUB-015 AC4: retains at most 20 repositories) -->
5. The tracked inventory has a stable order independent of report order. <!-- @impl: src/lib/clone-targets.ts::normalizeTrackedClones --> <!-- @test: src/__tests__/lib/clone-targets.test.ts (REQ-GITHUB-015 AC2: orders entries stably regardless of report order) -->
6. A stale host inventory cannot erase a clone tracked after the authority read that precedes the fresh inventory scan; a fresh observation can still reconcile removals. <!-- @impl: src/lib/session-repository.ts::updateTrackedClones --> <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (REQ-GITHUB-015 AC6: %s host inventory cannot erase a clone committed while the scan is in flight) --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (REQ-GITHUB-319: stale host inventory cannot erase a clone but fresh inventory can reconcile removals) -->

**Notes:** [Inventory admission](../../documentation/lanes/container.md#runtime-recovery-and-status) distinguishes a missing inventory from an authoritative empty list.

**Constraints:**

- The inventory limit does not restrict which repositories the user may clone or how many they may clone. Repository-panel tracking follows [REQ-GITHUB-319](#req-github-319-repository-panel-clone-handoff).
- Repository identities reported from a container are untrusted input and are revalidated before reaching a clone.
- Inventory collection inspects at most 20 workspace directories within an eight-second aggregate deadline including filesystem discovery; an incomplete scan is withheld so it cannot prune prior tracking. <!-- @test: host/__tests__/workspace-repos.test.js (REQ-GITHUB-015: withholds inventory when ${method} stalls past the scan deadline) --> <!-- @impl: host/src/metrics.ts::collectWorkspaceRepos --> <!-- @test: host/__tests__/workspace-repos.test.js (REQ-GITHUB-015: distinguishes an unavailable workspace from an empty workspace) --> <!-- @test: host/__tests__/workspace-repos.test.js (REQ-GITHUB-015: withholds the whole inventory when a checkout cannot be inspected) --> <!-- @test: host/__tests__/workspace-repos.test.js (REQ-GITHUB-015: a failed scan omits inventory from the authenticated observation) --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (REQ-GITHUB-015: retains the restore list when inventory is unavailable but reconciles a complete empty scan) -->
- The coordinator reads lifecycle authority before requesting fresh inventory, then fences its write on the observed revision. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (REQ-GITHUB-015 AC6: %s host inventory cannot erase a clone committed while the scan is in flight) -->

**Priority:** P1

**Dependencies:** [REQ-GITHUB-004](#req-github-004-clone-a-repository-into-a-session)

**Verification:** Automated: [session-authority-outcomes.test.ts](../../src/__tests__/lib/session-authority-outcomes.test.ts), [session-d1-lifecycle.test.ts](../../src/__tests__/lib/session-d1-lifecycle.test.ts), [workspace-repos.test.js](../../host/__tests__/workspace-repos.test.js), [container-metrics.test.ts](../../src/__tests__/container-metrics.test.ts), [clone-targets.test.ts](../../src/__tests__/lib/clone-targets.test.ts)

**Status:** Implemented

---

### REQ-GITHUB-319: Repository-panel clone handoff

**Intent:** Persist the bounded restore inventory for repository-panel clones without waiting for a later inventory report or limiting cloning.

**Applies To:** User

**Acceptance Criteria:**

1. Before returning panel clone success, add the clone as a candidate, then persist the validated, stably ordered inventory of at most 20 entries. The cap does not prevent cloning or guarantee the new clone is retained. <!-- @test: src/__tests__/routes/github.test.ts (REQ-GITHUB-319 AC1+AC2: successful overflow clones persist only twenty candidates for the next restore) --> <!-- @impl: src/routes/github.ts::app.post('/clone', --> <!-- @impl: src/lib/clone-targets.ts::normalizeTrackedClones --> <!-- @test: src/__tests__/routes/github.test.ts (REQ-GITHUB-015 AC3: tracks the repository on the session as soon as the clone succeeds) --> <!-- @test: src/__tests__/routes/github.test.ts (REQ-GITHUB-015 AC6: does not return clone success when session persistence fails) --> <!-- @test: src/__tests__/lib/clone-targets.test.ts (REQ-GITHUB-015 AC2: orders entries stably regardless of report order) --> <!-- @test: src/__tests__/lib/clone-targets.test.ts (REQ-GITHUB-015 AC4: retains at most 20 repositories) --> <!-- @impl: src/lib/session-repository.ts::appendTrackedClone -->
2. A panel clone retained in the persisted inventory immediately before a stop is included in the next resume directive. Overflow is intentionally omitted from automatic restore via that inventory. <!-- @test: src/__tests__/routes/github.test.ts (REQ-GITHUB-319 AC1+AC2: successful overflow clones persist only twenty candidates for the next restore) --> <!-- @impl: src/lib/clone-targets.ts::buildCloneTargets --> <!-- @test: src/__tests__/routes/github.test.ts (REQ-GITHUB-015 AC3: tracks the repository on the session as soon as the clone succeeds) --> <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer -->
3. Overlapping successful appends do not erase one another within the inventory bound. <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (REQ-GITHUB-319 AC3: overlapping appends both reach the next restore directive) --> <!-- @impl: src/lib/session-repository.ts::appendTrackedClone -->
4. After a successful checkout, exhausted inventory conflicts return `409 CLONE_TRACKING_UNCONFIRMED`. <!-- @impl: src/routes/github.ts::app --> <!-- @test: src/__tests__/routes/github.test.ts (REQ-GITHUB-319: an existing checkout is reported separately when tracking retries exhaust) -->
5. The clone outcome notice clears five seconds after success. <!-- @impl: web-ui/src/stores/session.ts::cloneRepositoryIntoSession --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-GITHUB-320 AC6: Dashboard clone notification survives picker dismissal and clears after success) -->
6. Existing-folder, unconfirmed tracking and failure notices remain dismissible. <!-- @impl: web-ui/src/stores/session.ts::cloneRepositoryIntoSession --> <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-GITHUB-320 AC6: %s clone outcomes remain dismissible) --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-GITHUB-320 AC6: renders live-clone identity and outcomes in the shared notice) -->
7. The notice distinguishes a checkout with unconfirmed tracking from a failed clone. <!-- @impl: web-ui/src/api/github.ts::cloneIntoSession --> <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-GITHUB-320 AC6: renders live-clone identity and outcomes in the shared notice) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-GITHUB-320 AC6: %s clone outcomes remain dismissible) -->

**Constraints:** Inventory bounds and identity validation from [REQ-GITHUB-015](#req-github-015-workspace-repository-tracking) remain in force. The separate creation-time clone directive is governed by [REQ-GITHUB-014](#req-github-014-clone-created-session-resume).

**Priority:** P1

**Dependencies:** [REQ-GITHUB-004](#req-github-004-clone-a-repository-into-a-session), [REQ-GITHUB-015](#req-github-015-workspace-repository-tracking)

**Verification:** Automated: [session-authority-outcomes.test.ts](../../src/__tests__/lib/session-authority-outcomes.test.ts), [github.test.ts](../../src/__tests__/routes/github.test.ts), [clone-targets.test.ts](../../src/__tests__/lib/clone-targets.test.ts), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts), [Layout.test.tsx](../../web-ui/src/__tests__/components/Layout.test.tsx)

**Status:** Implemented

---

### REQ-GITHUB-016: Tracked repository restoration

**Intent:** A resumed session restores its tracked repositories without allowing a failed restoration to prevent use of the session.

**Applies To:** User

**Acceptance Criteria:**

1. Resume attempts tracked repositories whose workspace folders are absent, while the overall budget in AC3 still permits starting an attempt. <!-- @impl: src/lib/clone-targets.ts::buildCloneTargets --> <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @impl: entrypoint.sh::restore_startup_repositories --> <!-- @test: src/__tests__/container/container-router.test.ts (REQ-GITHUB-015 AC4: restores every tracked repository when a stopped session resumes) --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (REQ-GITHUB-015 AC4: forwards every tracked repository with the session repository first) -->
2. Resume leaves an existing workspace folder untouched. <!-- @impl: entrypoint.sh::restore_startup_repositories --> <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-015 AC4: restores every tracked repository in order and leaves an existing folder alone) -->
3. No restore attempt starts after the configurable overall budget (180 seconds by default) is spent; the budget does not stop an attempt already in progress. <!-- @impl: entrypoint.sh::restore_startup_repositories --> <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-015 AC5: stops attempting repositories once the overall budget is spent) -->
4. Each restore attempt uses a configurable per-repository timeout of 120 seconds by default. A value of `0` disables it, and larger values are not clamped. <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-016 AC4: restore timeout settings at the executable boundary) --> <!-- @impl: entrypoint.sh::restore_startup_repositories --> <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-015 AC5: abandons a repository that exceeds its own time limit and still tries the next) -->
5. Restore never waits for interactive credentials. <!-- @impl: entrypoint.sh::restore_startup_repositories --> <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-015 AC6+AC7: never prompts for credentials, logs failures, and always reaches autostart) -->
6. Every abandoned or failed restore attempt is logged. <!-- @impl: entrypoint.sh::restore_startup_repositories --> <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-015 AC6+AC7: never prompts for credentials, logs failures, and always reaches autostart) -->
7. Restore failure does not prevent the session from reaching a usable state. <!-- @impl: entrypoint.sh::restore_startup_repositories --> <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-015 AC6+AC7: never prompts for credentials, logs failures, and always reaches autostart) -->

**Constraints:**

- Restore authentication continues to use the per-mode credential path defined by [REQ-GITHUB-004](#req-github-004-clone-a-repository-into-a-session).
- Two tracked repositories sharing one folder name collide on the workspace layout of [REQ-GITHUB-004](#req-github-004-clone-a-repository-into-a-session) AC3; the second is skipped rather than merged.
- Uncommitted work and local-only branches are restored by workspace sync ([REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)), not by this restore.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-004](#req-github-004-clone-a-repository-into-a-session), [REQ-GITHUB-014](#req-github-014-clone-created-session-resume), [REQ-GITHUB-015](#req-github-015-workspace-repository-tracking), [REQ-SESSION-006](session-lifecycle.md#req-session-006-user-can-stop-restart-and-delete-sessions)

**Verification:** Automated: [git-clone.test.js](../../host/__tests__/git-clone.test.js), [container-router.test.ts](../../src/__tests__/container/container-router.test.ts), [container-lifecycle-helpers.test.ts](../../src/__tests__/routes/container-lifecycle-helpers.test.ts)

**Status:** Implemented

---

### REQ-GITHUB-320: Nonblocking terminal repository restore notice

**Intent:** Users can open a ready terminal while restoration continues and follow repository cloning into running sessions through the same nonblocking notification.

**Applies To:** User

**Acceptance Criteria:**

1. Terminal Open becomes available after normal terminal readiness, even while repository restore runs. <!-- @impl: entrypoint.sh::complete_managed_curation_startup --> <!-- @impl: src/routes/container/status.ts::app --> <!-- @test: src/__tests__/routes/container-status.test.ts (REQ-GITHUB-320: Ready carries a nonblocking repository restore state and repository names (%s)) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-GITHUB-320: enables Open while restoration runs and shows its later partial outcome) -->
2. The startup restore reports an aggregate success or issues result. Failed or aborted work reports issues. <!-- @impl: entrypoint.sh::restore_startup_repositories --> <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-320: publishes successful and partial restore outcomes) -->
3. A floating notice follows the current restore without shifting the Dashboard metrics or requiring an open view. Success clears automatically; no notice appears when no clone is needed. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-GITHUB-320: shows restore progress on the Dashboard and dismisses a partial outcome) --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-GITHUB-320: places restore notice after the open session tabs and dismisses it while restoring) --> <!-- @manual --> <!-- @impl: web-ui/src/stores/session.ts::watchRepositoryRestore -->
4. On touch layouts, the notice sits below the open session’s tab bar without intercepting tab controls. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-GITHUB-320: places restore notice after the open session tabs and dismisses it while restoring) --> <!-- @manual -->
5. Every notice has an accent-colored dismiss button with a tap target of at least 44 × 44 CSS pixels. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-GITHUB-320: places restore notice after the open session tabs and dismisses it while restoring) --> <!-- @manual -->
6. Selecting a running-session clone target immediately closes the picker and shows repository/session identity in the shared notice. <!-- @impl: web-ui/src/stores/session.ts::cloneRepositoryIntoSession --> <!-- @impl: web-ui/src/components/github/ClonePicker.tsx::ClonePicker --> <!-- @test: web-ui/src/__tests__/components/ClonePicker.test.tsx (REQ-GITHUB-320 AC6: closes immediately and stays closed after a %s clone outcome) --> <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-GITHUB-320 AC6: renders live-clone identity and outcomes in the shared notice) -->
7. Cloning does not start or select a session or alter readiness. Different sessions have independent notices; dismissal or a newer clone prevents late responses from reviving or overwriting the notice. <!-- @impl: web-ui/src/stores/session.ts::cloneRepositoryIntoSession --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-GITHUB-320 AC6: Dashboard clone notification survives picker dismissal and clears after success) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-GITHUB-320 AC7: dismissed and superseded clone responses cannot replace the current notice) --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-GITHUB-320 AC7: concurrent sessions keep independent clone notifications) -->

**Constraints:**

- Already-present targets remain untouched. Inventory is withheld until the startup restore loop ends. <!-- @impl: entrypoint.sh::restore_startup_repositories --> <!-- @impl: host/src/metrics.ts::isWorkspaceInventoryReady --> <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-320 AC2: health withholds workspace inventory during the actual restore loop and publishes it after completion) -->
- Missing detail or a missing/older generation consumes the retry budget. A matching confirmed stop or error, a replacement generation, lost local ownership, or exhaustion ends tracking without proving success. <!-- @impl: web-ui/src/stores/session.ts::watchRepositoryRestore --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (REQ-GITHUB-320: enables Open while restoration runs and shows its later partial outcome) -->
- Clone outcome and dismissal rules are defined in [REQ-GITHUB-319 AC5–7](#req-github-319-repository-panel-clone-handoff).

**Priority:** P1

**Dependencies:** [REQ-GITHUB-016](#req-github-016-tracked-repository-restoration), [REQ-SESSION-015](session-lifecycle.md#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition)

**Verification:** Automated: [git-clone.test.js](../../host/__tests__/git-clone.test.js), [container-status.test.ts](../../src/__tests__/routes/container-status.test.ts), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts), [Layout.test.tsx](../../web-ui/src/__tests__/components/Layout.test.tsx), [ClonePicker.test.tsx](../../web-ui/src/__tests__/components/ClonePicker.test.tsx); Manual: [Repository restore notice](../../documentation/lanes/terminal-and-ide.md#repository-restore-notice)

**Status:** Implemented

---

### REQ-GITHUB-326: Repository names in resume notices

**Intent:** Identify the repositories associated with the current restore notice.

**Applies To:** User

**Acceptance Criteria:**

1. The resume notice lists repository names from the observed launch’s restore targets when available; otherwise it shows the session name. <!-- @impl: host/src/metrics.ts::getRepositoryRestoreRepos --> <!-- @test: host/__tests__/git-clone.test.js (REQ-GITHUB-320 AC2: health withholds workspace inventory during the actual restore loop and publishes it after completion) --> <!-- @impl: src/routes/container/status.ts::app --> <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-GITHUB-320: lists repositories instead of the session name when available) --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-GITHUB-320: shows restore progress on the Dashboard and dismisses a partial outcome) --> <!-- @test: src/__tests__/routes/container-status.test.ts (REQ-GITHUB-320: Ready carries a nonblocking repository restore state and repository names (%s)) --> <!-- @test: web-ui/src/__tests__/api/client.test.ts (should trigger container start and send initial progress) -->
2. An overflowing repository list can be scrolled by touch and keyboard while Dismiss remains visible. <!-- @manual: documentation/lanes/terminal-and-ide.md#repository-restore-notice -->

**Constraints:** The list is not a per-repository outcome. Manual clone notices and restore timing are unchanged.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-320](#req-github-320-nonblocking-terminal-repository-restore-notice)

**Verification:** Automated: [Host restore](../../host/__tests__/git-clone.test.js), [Startup status](../../src/__tests__/routes/container-status.test.ts), [Start client](../../web-ui/src/__tests__/api/client.test.ts), [Layout](../../web-ui/src/__tests__/components/Layout.test.tsx); Manual: [Repository restore notice](../../documentation/lanes/terminal-and-ide.md#repository-restore-notice)

**Status:** Planned

---

### REQ-GITHUB-005: Disconnect and offboarding revocation

**Intent:** Ordinary disconnect removes local GitHub credentials after best-effort provider revocation.

**Applies To:** User

**Acceptance Criteria:**

1. GitHub disconnect attempts App/OAuth revocation using the currently selected provider. The connection does not record its issuing client, so a provider or client change can prevent revocation. <!-- @impl: src/lib/github-token.ts::disconnectGithub --> <!-- @test: src/__tests__/routes/github.test.ts (revokes + clears the token and returns success) --> <!-- @test: src/__tests__/lib/github-token.test.ts (revokes at GitHub and clears the field for an app/oauth token) -->
2. Disconnect clears local GitHub fields even when provider configuration, network access, or revocation fails. <!-- @impl: src/lib/github-token.ts::disconnectGithub --> <!-- @test: src/__tests__/lib/github-token.test.ts (REQ-GITHUB-005 AC2: provider failure clears GitHub fields while preserving unrelated deploy keys) --> <!-- @test: src/__tests__/lib/github-token.test.ts (fails open and clears an OAuth token when provider revocation returns non-success) --> <!-- @test: src/__tests__/lib/github-token.test.ts (fails open and clears an OAuth token when provider revocation rejects) -->
3. Disconnect removes an otherwise empty deploy-keys entry. <!-- @impl: src/lib/github-token.ts::disconnectGithub --> <!-- @test: src/__tests__/lib/github-token.test.ts (fails open and clears an OAuth token when provider configuration is unavailable) -->
4. A manually-pasted PAT is cleared but not sent to the GitHub revoke endpoint. <!-- @impl: src/lib/github-token.ts::disconnectGithub --> <!-- @test: src/__tests__/lib/github-token.test.ts (does NOT call GitHub revoke for a manually-pasted PAT but still clears it) -->

**Constraints:** Administrator-requested offboarding uses the strict revocation contract in [REQ-AUTH-026](authentication.md#req-auth-026-admin-user-offboarding), not ordinary disconnect.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage)

**Verification:** Automated: [github-token.test.ts](../../src/__tests__/lib/github-token.test.ts), [github.test.ts](../../src/__tests__/routes/github.test.ts)

**Status:** Implemented

---

### REQ-GITHUB-006: Other-mode container transport

**Intent:** Ordinary SaaS / non-enterprise human sessions retain the existing GitHub deploy-credential environment transport; restricted operator containers retain placeholder isolation regardless of deployment mode.

**Applies To:** System

**Acceptance Criteria:**

1. Startup projects a connected token for an ordinary non-Enterprise human session in the same environment field as a manually pasted PAT. Restricted Operators get no token or only the non-secret placeholder in every mode. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (REQ-GITHUB-003 / REQ-GITHUB-006: emits the real GH_TOKEN unchanged in non-enterprise mode) -->
2. In enterprise mode the container receives the same non-secret GitHub credential placeholder for every user, never the real token; the real token is injected at egress per [REQ-GITHUB-003](#req-github-003-enterprise-egress-injected-github-credentials). <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (REQ-GITHUB-003 / REQ-GITHUB-006: emits a NON-SECRET placeholder GH_TOKEN in enterprise mode (real token never enters the container)) -->

**Constraints:**

- In ordinary non-Enterprise human sessions, this is leakage hygiene, not containment: the agent can read its own user's token.
- Restricted Operators never receive the real token in any mode; outbound substitution remains owner-bound. A disconnected session's next start omits `GH_TOKEN`; this does not rewrite a running process environment.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [REQ-GITHUB-003](#req-github-003-enterprise-egress-injected-github-credentials)

**Verification:** Automated: [container-env.test.ts](../../src/__tests__/container/container-env.test.ts)

**Status:** Implemented

---

### REQ-GITHUB-007: Broaden the panel gate beyond enterprise

<!-- Title retains "Broaden ... beyond enterprise" for anchor stability; the gate is now
     broadened all the way — the GitHub panel renders whenever GitHub is enabled, with no
     session-tier (advanced) entitlement. Originally enterprise-only, then advanced-in-any-mode
     (REQ-GITHUB-007 v1), now enabled-in-any-mode. -->

**Intent:** Make the GitHub repository panel + Storage browser available in every mode whenever GitHub is enabled — GitHub leads as the default right-column face for every session, with **no session-tier gate**. Enterprise is unchanged.

**Applies To:** User

**Acceptance Criteria:**

1. The panel backend is available in every mode. <!-- @impl: src/routes/github.ts::githubFeatureEnabled --> <!-- @test: src/__tests__/routes/github.test.ts (REQ-GITHUB-007: reports enabled outside enterprise too (panel available in every mode)) --> <!-- @test: src/__tests__/routes/github.test.ts (REQ-GITHUB-002: reports enabled + not connected in enterprise with no token) --> <!-- @test: src/__tests__/routes/github.test.ts (REQ-GITHUB-007: is reachable in non-enterprise (panel no longer enterprise-gated) — 401 when not connected) -->
2. GitHub has **no session-tier entitlement**. When enabled it leads the Code Dashboard, connected or not. <!-- @impl: web-ui/src/components/Dashboard.tsx::effectiveFace --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (Dashboard / REQ-SUB-019 (session limit popup in frontend)) --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (renders nothing when status.enabled is false) -->
3. Code uses panel flipping across deployment modes. Vibe follows [REQ-GITHUB-321](#req-github-321-vibe-dashboard-browser-disclosure); disabled GitHub leaves Storage alone. <!-- @impl: web-ui/src/components/Dashboard.tsx::effectiveFace --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (Dashboard / REQ-SUB-019 (session limit popup in frontend)) -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [REQ-GITHUB-002](#req-github-002-github-panel-and-repository-listing), [REQ-GITHUB-006](#req-github-006-other-mode-container-transport), [REQ-AUTH-015](authentication.md#req-auth-015-guided-onboarding-flow), [REQ-AGENT-018](agents.md#req-agent-018-push--deploy-credential-management-ui)

**Verification:** Automated: [github.test.ts](../../src/__tests__/routes/github.test.ts), [Dashboard.test.tsx](../../web-ui/src/__tests__/components/Dashboard.test.tsx)

**Status:** Implemented

---

### REQ-GITHUB-317: Additive GitHub connection and scope contract

**Intent:** Keep the OAuth connect/disconnect capability decoupled from the dashboard panel so a user can also connect GitHub from Guided Setup and the Settings accordion. Connect stays the additive OAuth flow ([REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage)) — never a login-scope escalation, never a manually-pasted PAT. Enterprise is unchanged.

**Applies To:** User

**Acceptance Criteria:**

1. Connect, callback, and disconnect require authentication but not enabled GitHub, allowing Guided Setup and Settings access without the dashboard panel; only status, repos, and clone require enablement. <!-- @test: src/__tests__/routes/github.test.ts (REQ-GITHUB-317 AC1+AC3: %s nonadvanced connection is additive and authentication guards every connection action) --> <!-- @impl: src/routes/github.ts::REPOS_PER_PAGE --> <!-- @test: src/__tests__/routes/github.test.ts (is reachable for a non-advanced authed user in non-enterprise (connect is not panel-gated)) -->
2. Dashboard, Guided Setup, and Settings use the same OAuth connect/disconnect interaction contract while retaining surface-specific visual chrome; the reusable card accepts surface styling without changing navigation or disconnect behavior. <!-- @impl: web-ui/src/components/connect/OAuthConnectCard.tsx::OAuthConnectCard --> <!-- @test: web-ui/src/__tests__/components/connect/OAuthConnectCard.test.tsx (OAuthConnectCard) --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (GitHubPanel Component) -->
3. GitHub uses additive OAuth and existing per-user token transport; enterprise retains egress injection ([REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [REQ-GITHUB-003](#req-github-003-enterprise-egress-injected-github-credentials), [REQ-GITHUB-006](#req-github-006-other-mode-container-transport)). <!-- @test: src/__tests__/routes/github.test.ts (REQ-GITHUB-317 AC1+AC3: %s nonadvanced connection is additive and authentication guards every connection action) --> <!-- @test: src/__tests__/github-interceptor.test.ts (REQ-GITHUB-317 AC3: restricted Operator keeps GitHub credentials mediated in enterprise=%s) --> <!-- @impl: src/lib/github-token.ts::connectGithub --> <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) -->
4. The connect URL carries a scope `tier` (minimal/recommended/advanced); the server maps the tier to the OAuth-App `scope` parameter from a backend scope catalog (the GitHub App path's fixed permissions ignore it). <!-- @impl: src/lib/oauth-scopes.ts::githubScopeForTier --> <!-- @test: src/__tests__/routes/github.test.ts (feeds the scope tier into the OAuth-App authorize scope param) -->
5. Every OAuth App connection tier requests `read:user` so GitHub can return account-owned repository counters. Existing grants are not modified automatically. <!-- @impl: src/lib/oauth-scopes.ts::githubScopeForTier --> <!-- @test: src/__tests__/routes/github.test.ts (REQ-GITHUB-317 AC5: requests read:user for the %s OAuth-App connection) -->

**Constraints:**

- Ordinary non-enterprise human sessions carry the real token in the container env (leakage-hygiene only, not agent-containment); restricted operators retain the non-secret placeholder regardless of Enterprise mode, as in [REQ-GITHUB-006](#req-github-006-other-mode-container-transport).
- The scope catalog lives server-side; the client sends only the tier name (untrusted, normalized to a known tier, default `recommended`).

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [REQ-GITHUB-002](#req-github-002-github-panel-and-repository-listing), [REQ-GITHUB-006](#req-github-006-other-mode-container-transport), [REQ-AUTH-015](authentication.md#req-auth-015-guided-onboarding-flow), [REQ-AGENT-018](agents.md#req-agent-018-push--deploy-credential-management-ui)

**Verification:** Automated: [github.test.ts](../../src/__tests__/routes/github.test.ts), [OAuthConnectCard.test.tsx](../../web-ui/src/__tests__/components/connect/OAuthConnectCard.test.tsx), [oauth-scopes.test.ts](../../src/__tests__/lib/oauth-scopes.test.ts), [github-interceptor.test.ts](../../src/__tests__/github-interceptor.test.ts)

**Status:** Implemented

---

### REQ-GITHUB-008: Enterprise GitHub provider configuration via Setup

<!-- Title retains "Enterprise" for anchor stability; provider config is now admin-gated
     in every mode (see AC5). Originally enterprise-only, broadened with REQ-GITHUB-007. -->

**Intent:** Admins (in any deployment mode) configure the GitHub provider (GitHub App or OAuth App) and its credentials in the Setup wizard — persisted to KV — so GitHub integration works without GitHub-Actions or Cloudflare-secret access, mirroring the admin-global Browser Rendering token ([REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)).

**Applies To:** Admin

**Acceptance Criteria:**

1. The Setup wizard offers a GitHub App or OAuth App chooser, and selecting a provider reveals its Client ID and Client Secret inputs. <!-- @impl: web-ui/src/components/setup/GitHubProviderChooser.tsx::GitHubProviderChooser --> <!-- @test: web-ui/src/__tests__/components/GitHubProviderChooser.test.tsx (GitHubProviderChooser) -->
2. Switching providers preserves the inactive provider's saved credentials. <!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS --> <!-- @manual: Configure both provider types, switch between them, and confirm each provider's saved values remain available. -->
3. On an admin save in any mode, provider type and client IDs remain non-secret and each client secret is encrypted at rest. <!-- @impl: src/lib/admin-configuration.ts::executeConfigurationTask --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-GITHUB-008: persists the provider type + client id (plain) and the secret (encrypted)) -->
4. Blank secrets preserve stored values. <!-- @impl: src/lib/admin-configuration.ts::executeConfigurationTask --> <!-- @test: src/__tests__/routes/admin-configuration-runs.test.ts (REQ-SETUP-024: preserves saved OAuth secrets when replacements are blank in %j) --> <!-- @manual -->
5. In every mode, including non-enterprise, provider prefill returns the provider type, both client IDs and a `…ClientSecretSet` stored-secret-presence Boolean per provider, never a client secret. <!-- @impl: src/routes/setup/handlers.ts::handlers --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (GET /prefill returns provider type + client ids + secret-set flags, never the secrets) --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (REQ-GITHUB-008: enterprise GitHub provider config prefill (masked)) -->
6. Provider config is **admin-gated in every mode** (the existing Setup admin gate), no longer behind the Enterprise-mode gate. <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-GITHUB-008 AC6: %s nonadmin GitHub provider save preserves all configuration) --> <!-- @impl: src/routes/setup/handlers.ts::handlers --> <!-- @impl: src/routes/setup/index.ts::createConditionalSetupAuth --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (persists the GitHub provider config in non-enterprise (no ENTERPRISE_MODE)) --> <!-- @test: src/__tests__/routes/setup-enterprise-groups.test.ts (REQ-AGENT-230: non-admin configure is rejected with the stored configuration unchanged) -->
7. Saving a secret without a server encryption key is rejected. <!-- @impl: src/lib/admin-configuration.ts::executeConfigurationTask --> <!-- @manual -->

**Constraints:**

- Removing a stored secret from the UI is not a v1 affordance (mirrors the browser-rendering token); re-registering with a new secret replaces it.
- The OAuth-App `scope` is tier-derived per connect ([REQ-GITHUB-317](#req-github-317-additive-github-connection-and-scope-contract) AC4); this REQ covers only the provider client credentials, not the per-connect scope.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token), [CON-GH-001](constraints.md#con-gh-001-github-token-encrypted-at-rest-and-never-returned-to-the-browser)

**Verification:** Automated: [setup/handlers.test.ts](../../src/__tests__/routes/setup/handlers.test.ts), [setup-enterprise-groups.test.ts](../../src/__tests__/routes/setup-enterprise-groups.test.ts), [admin-configuration-runs.test.ts](../../src/__tests__/routes/admin-configuration-runs.test.ts); Manual: [GitHub provider credential acceptance](../../documentation/lanes/configuration.md#github-provider-credential-acceptance)

**Status:** Implemented

---

### REQ-GITHUB-318: Runtime selection of the Setup GitHub provider

**Intent:** Resolve the active provider from admin-saved credentials before environment fallback in every deployment mode.

**Applies To:** Admin

**Acceptance Criteria:**

1. The active provider is resolved from the Setup KV values, decrypting the secret, before any env-var fallback; KV-first precedence follows [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage) AC5. <!-- @impl: src/lib/github-token.ts::getProviderFromKv --> <!-- @test: src/__tests__/lib/github-token.test.ts (enterprise KV config wins over deploy env vars) -->
2. If the saved secret cannot be decrypted with a configured key, the Setup provider is unavailable and environment fallback follows [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage) AC5. A raised KV read error, including JSON read rejection without a configured key, fails provider resolution rather than selecting another provider. <!-- @impl: src/lib/github-token.ts::getGithubProvider --> <!-- @impl: src/lib/kv-crypto.ts::getAndDecrypt --> <!-- @test: src/__tests__/lib/github-token.test.ts (REQ-GITHUB-008 AC4: unreadable Setup ciphertext uses only an available environment provider (fallback=%s)) --> <!-- @test: src/__tests__/lib/github-token.test.ts (REQ-GITHUB-008 AC4: encrypted Setup secret without a configured key propagates the KV JSON rejection without mutation) -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [REQ-GITHUB-008](#req-github-008-enterprise-github-provider-configuration-via-setup)

**Verification:** Automated: [github-token.test.ts](../../src/__tests__/lib/github-token.test.ts); Manual: [GitHub provider credential acceptance](../../documentation/lanes/configuration.md#github-provider-credential-acceptance)

**Status:** Implemented

---

### REQ-GITHUB-009: GitHub repository list viewport and empty states

**Intent:** Repository lists stay searchable and scrollable without hiding fetched repositories.

**Applies To:** User

**Acceptance Criteria:**

1. A connected account with zero repositories shows the repository-panel empty state. <!-- @impl: web-ui/src/components/github/RepoList.tsx::RepoList --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (REQ-GITHUB-009: shows the no-repositories empty state only when the account has no repos) -->
2. Search with no matching repositories shows the search-empty state. <!-- @impl: web-ui/src/components/github/RepoList.tsx::RepoList --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (REQ-GITHUB-009: keeps search-empty results distinct from the no-repositories empty state) -->
3. The repo list renders every fetched repository inside a scroll container. <!-- @impl: web-ui/src/components/github/RepoList.tsx::RepoList --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (REQ-GITHUB-009: renders every repo inside the scroll container (the row cap is a CSS viewport, not truncation)) -->
4. The repo list flexes to the height its panel is allotted by the adaptive GitHub/Storage split and scrolls the overflow, rather than capping at a fixed per-breakpoint row count. <!-- @manual: GitHub workspace manual acceptance in documentation/lanes/terminal-and-ide.md; observe rendered allocation and scrolling. --> <!-- @impl: web-ui/src/styles/github-panel.css::.github-repo-rows --> <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard -->

**Constraints:**

- The list never truncates fetched repos; its height is an adaptive viewport set by the split allocation, not a data limit; The pixel allocation is flex/CSS, not unit-asserted in jsdom; rendered layout is checked manually.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-002](#req-github-002-github-panel-and-repository-listing)

**Verification:** Automated: [Dashboard.test.tsx](../../web-ui/src/__tests__/components/Dashboard.test.tsx), [GitHubPanel.test.tsx](../../web-ui/src/__tests__/components/GitHubPanel.test.tsx); Manual: [GitHub workspace acceptance](../../documentation/lanes/terminal-and-ide.md#github-workspace-manual-acceptance)

**Status:** Implemented

---

### REQ-GITHUB-010: Mobile GitHub and storage face switching

**Intent:** GitHub leads the right column on every breakpoint. On mobile it is the single default face with a flip control to the R2 storage browser (and back); on tablet/desktop both stack as an anchoring split with no flip needed.

**Applies To:** User

**Acceptance Criteria:**

1. In mobile Code, GitHub is the default right-column face and the header flip control swaps to the R2 storage browser (and back) in place whenever GitHub is enabled. <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx::GitHubPanel --> <!-- @impl: web-ui/src/components/Dashboard.tsx::effectiveFace --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-GITHUB-010: flips GitHub <-> storage when enabled and the flip controls are used) -->
2. Flip controls appear only in the mobile layout. Desktop and tablet show both browsers without flip controls. <!-- @manual: GitHub workspace manual acceptance in documentation/lanes/terminal-and-ide.md; observe control visibility across split and single-face layouts. --> <!-- @impl: web-ui/src/components/Dashboard.tsx::flipBrowsers --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-GITHUB-010: keeps both Code browsers without flip controls on %s) -->
3. If GitHub is disabled, R2 storage is the sole right-column face. <!-- @impl: web-ui/src/components/Dashboard.tsx::effectiveFace --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-GITHUB-010: forces the storage face active when GitHub is disabled so the empty GitHub panel cannot cover R2) -->
4. In Code, when GitHub is enabled, the storage panel carries a matching header. The flip-back control appears only on mobile. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-GITHUB-010: defaults to the GitHub face and offers the storage back-button when GitHub is enabled) -->

**Constraints:**

- The flip transition honors `prefers-reduced-motion: reduce` with an instant CSS-only swap.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-002](#req-github-002-github-panel-and-repository-listing), [REQ-GITHUB-007](#req-github-007-broaden-the-panel-gate-beyond-enterprise)

**Verification:** Automated: [Dashboard.test.tsx](../../web-ui/src/__tests__/components/Dashboard.test.tsx), [GitHubPanel.test.tsx](../../web-ui/src/__tests__/components/GitHubPanel.test.tsx); Manual: [GitHub workspace acceptance](../../documentation/lanes/terminal-and-ide.md#github-workspace-manual-acceptance)

**Status:** Implemented

---

### REQ-GITHUB-321: Vibe Dashboard browser disclosure

**Intent:** Keep the Vibe Dashboard focused on sessions until the user asks to browse GitHub or Storage.

**Applies To:** User

**Acceptance Criteria:**

1. Vibe starts with the GitHub and Storage browsers hidden and unavailable to keyboard navigation. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (discloses the existing GitHub and Storage browsers together in Vibe on %s) -->
2. One labeled grip opens and closes the browsers. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (discloses the existing GitHub and Storage browsers together in Vibe on %s) -->
3. Escape from within the drawer closes it and returns focus to its control. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (closes the Vibe drawer from a focused browser and returns focus to the pull) -->
4. Vibe GitHub Details reports account-owned counts from the matching authenticated profile. When the profile omits the private count, show the public count and mark private and total unavailable. <!-- @impl: src/routes/github.ts::app --> <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: src/__tests__/routes/github.test.ts (returns only account-owned totals from the authenticated profile) --> <!-- @test: src/__tests__/routes/github.test.ts (returns public counts without inventing private totals for GitHub App profiles) --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (shows authoritative owned totals for a connected GitHub App account) --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (shows the public count and marks missing private and total counts unavailable) -->
5. When counts are unavailable, GitHub Details still identifies the connected account. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (keeps the connected GitHub account visible when owned totals are unavailable in Vibe) -->
6. Opening or closing the Vibe browsers leaves Profile icon-only and the email inside its menu. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (shows the Profile email only at the top of the open Dashboard menu in %s) -->
7. On desktop and tablet, a transparent double-chevron control sits on the summary’s right edge when closed and the browsers’ far right edge when open. It points right when closed and left when open, with a slow horizontal bounce unless reduced motion is enabled. <!-- @impl: web-ui/src/styles/dashboard.css::.dashboard-panel-pull --> <!-- @manual: documentation/lanes/terminal-and-ide.md#vibe-drawer-acceptance -->

**Constraints:** The desktop and tablet grip is 150px long with a 44px cross-axis hit target. <!-- @manual: documentation/lanes/terminal-and-ide.md#vibe-drawer-acceptance --> Code mode retains standard panel allocation. <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (keeps the existing browser controls without a drawer pull in Code mode) -->

**Priority:** P1

**Dependencies:** [REQ-GITHUB-012](#req-github-012-responsive-github-and-storage-panel-allocation)

**Verification:** Automated: [Dashboard component tests](../../web-ui/src/__tests__/components/Dashboard.test.tsx), [GitHub route tests](../../src/__tests__/routes/github.test.ts); Manual: [Vibe drawer acceptance](../../documentation/lanes/terminal-and-ide.md#vibe-drawer-acceptance)

**Status:** Planned

---

### REQ-GITHUB-323: Responsive Vibe Dashboard layout

**Intent:** Keep both browsers available without crowding the Vibe summary.

**Applies To:** User

**Acceptance Criteria:**

1. On desktop and tablet, the open drawer stacks GitHub above Storage beside the summary. <!-- @manual: documentation/lanes/terminal-and-ide.md#vibe-drawer-acceptance -->
2. On mobile, only the active browser is visible and keyboard-reachable. <!-- @manual: documentation/lanes/terminal-and-ide.md#vibe-drawer-acceptance -->
3. On mobile, flipping moves focus to the destination face’s flip control. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (uses the existing single-face GitHub and Storage controls in the mobile Vibe drawer) -->
4. Mobile face changes use the existing flip animation, except with reduced motion enabled. <!-- @manual: documentation/lanes/terminal-and-ide.md#vibe-drawer-acceptance -->
5. The closed desktop and tablet card is capped at 390 CSS px. <!-- @manual: documentation/lanes/terminal-and-ide.md#vibe-drawer-acceptance -->
6. GitHub Details, when present, sits directly above Storage Usage in the closed desktop and tablet summary. <!-- @manual: documentation/lanes/terminal-and-ide.md#vibe-drawer-acceptance -->
7. In both Vibe and Code, on desktop, tablet and mobile, the padding below New Session equals half the button's rendered height. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @manual: documentation/lanes/terminal-and-ide.md#vibe-drawer-acceptance --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (adds half a New Session button height in both modes on %s) -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-321](#req-github-321-vibe-dashboard-browser-disclosure)

**Verification:** Automated: [Dashboard component tests](../../web-ui/src/__tests__/components/Dashboard.test.tsx); Manual: [Vibe drawer acceptance](../../documentation/lanes/terminal-and-ide.md#vibe-drawer-acceptance)

**Status:** Planned

---

### REQ-GITHUB-324: Dashboard repository loading during GitHub App renewal

**Intent:** Keep a repository request usable when its concurrent counts request ends.

**Applies To:** User

**Acceptance Criteria:**

1. When its App token needs renewal, a Dashboard repository request joins an available retained renewal for that connection and uses the renewed token if it arrives before the wait expires, even if the initiating counts request disconnects. <!-- @impl: src/lib/github-token.ts::getValidGithubToken --> <!-- @test: src/__tests__/routes/github.test.ts (serves a waiting App repository request after a refresh starts in %s) -->

**Constraints:** If the wait expires, the request fails closed rather than using an expired token.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage)

**Verification:** Automated: [GitHub route tests](../../src/__tests__/routes/github.test.ts)

**Status:** Planned

---

### REQ-GITHUB-325: Mobile Vibe browser disclosure gestures

**Intent:** Open GitHub and Storage on phones without the desktop drawer trim.

**Applies To:** User

**Acceptance Criteria:**

1. A white double chevron toggles the mobile browsers from below the Dashboard column. It has no visible button background, points down when closed and up when open, and bounces slowly vertically unless reduced motion is enabled. <!-- @manual: documentation/lanes/terminal-and-ide.md#vibe-drawer-acceptance -->
2. An upward pull from the bottom opens the browsers. A downward pull from the top closes them. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (only lets mobile Vibe pull the browsers open and closed (%s)) --> <!-- @manual: documentation/lanes/terminal-and-ide.md#vibe-drawer-acceptance -->

**Constraints:** Ordinary scroll and horizontal or multi-touch gestures must not toggle the browsers.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-321](#req-github-321-vibe-dashboard-browser-disclosure)

**Verification:** Manual: [Vibe drawer acceptance](../../documentation/lanes/terminal-and-ide.md#vibe-drawer-acceptance)

**Status:** Planned

---

### REQ-GITHUB-012: Responsive GitHub and storage panel allocation

**Intent:** In the standard Dashboard layout, GitHub and storage share the right column as an anchored split on desktop and tablet. Code uses one independently content-sized face only on mobile. The Vibe drawer has a separate disclosure contract.

**Applies To:** User

**Acceptance Criteria:**

1. In the desktop and tablet split, GitHub anchors to the top and Storage to the bottom. Both size to content, letting the longer list use spare height, including inside the open Vibe drawer. <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (updates the open Vibe browser split as content changes on %s) --> <!-- @impl: web-ui/src/styles/dashboard.css::.dashboard-panel-right --> <!-- @impl: web-ui/src/styles/dashboard.css::.panel-flip-face --> <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @impl: web-ui/src/components/Dashboard.tsx::measureLayout --> <!-- @impl: web-ui/src/components/Dashboard.tsx::measureNatural --> <!-- @manual: documentation/lanes/terminal-and-ide.md#github-panel-geometry-acceptance -->
2. In Code, use one browser face with a flip control on mobile. Desktop and tablet stay in split mode regardless of column height. Vibe follows [REQ-GITHUB-321](#req-github-321-vibe-dashboard-browser-disclosure). <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-GITHUB-010: keeps both Code browsers without flip controls on %s) --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-GITHUB-002 AC5: flips one GitHub/storage face at a time on mobile) -->
3. In single-panel mobile/flip mode, the active face uses its own content height up to the current viewport cap, so short content stays compact. <!-- @impl: web-ui/src/components/Dashboard.tsx::activeFlipHeight --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-GITHUB-012: sizes each mobile flip face to its own capped content height) -->
4. Flipping between unequal GitHub and Storage faces recomputes the used height from the newly active face. <!-- @impl: web-ui/src/components/Dashboard.tsx::activeFlipHeight --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-GITHUB-012: sizes each mobile flip face to its own capped content height) -->
5. Resizing the viewport recomputes the active face's cap without requiring a face or content change. <!-- @impl: web-ui/src/components/Dashboard.tsx::measureLayout --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-GITHUB-012: sizes each mobile flip face to its own capped content height) -->
6. Single-panel mobile/flip mode vertically centers the active panel. <!-- @impl: web-ui/src/styles/dashboard.css::.dashboard-panel:not(.dashboard-panel--expanded) --> <!-- @manual: On the protected integration deployment at a mobile viewport, confirm a short active face is vertically centered. -->
7. Overflowing repository or storage content scrolls inside its list rather than expanding beyond the viewport cap. <!-- @impl: web-ui/src/styles/github-panel.css::.github-repo-rows --> <!-- @impl: web-ui/src/styles/storage-browser.css::.storage-drop-zone --> <!-- @impl: web-ui/src/styles/dashboard.css::.dashboard-panel-right --> <!-- @manual: On the protected integration deployment at a mobile viewport, confirm long GitHub and Storage lists remain inside the capped face with internal scrolling. -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-010](#req-github-010-mobile-github-and-storage-face-switching), [REQ-GITHUB-002](#req-github-002-github-panel-and-repository-listing), [REQ-GITHUB-007](#req-github-007-broaden-the-panel-gate-beyond-enterprise)

**Verification:** Automated: [Dashboard.test.tsx](../../web-ui/src/__tests__/components/Dashboard.test.tsx); Manual: [GitHub panel geometry acceptance](../../documentation/lanes/terminal-and-ide.md#github-panel-geometry-acceptance)

**Status:** Implemented

---

### REQ-GITHUB-011: Mobile search disclosure with autofocus

<!-- Title retains "Mobile ..." for anchor stability; the disclosure now applies on
     EVERY breakpoint (desktop included), not only touch. -->

**Intent:** The GitHub panel's repository search is disclosed on demand on every breakpoint — hidden behind a magnify toggle so the repository list keeps its available-height viewport, revealed (and focused) on tap/click and hidden again on a second tap. The only touch-specific behaviour is scrolling the field above the on-screen keyboard once it opens.

**Applies To:** User

**Acceptance Criteria:**

1. On every breakpoint, the connected panel hides the search input by default and renders a magnify toggle to the left of the refresh control in the connected header. <!-- @impl: web-ui/src/components/github/ConnectedHeader.tsx::ConnectedHeader --> <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx::GitHubPanel --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (REQ-GITHUB-011 AC1: on touch, hides the search input behind a magnify toggle placed left of refresh) -->
2. Tapping the magnify toggle reveals the search input and reflects the open state on the toggle. <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx::GitHubPanel --> <!-- @impl: web-ui/src/components/github/RepoSearch.tsx::RepoSearch --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (REQ-GITHUB-011 AC2: tapping the toggle reveals the search input, focuses it, and reflects the open state) -->
3. Tapping the toggle again hides the search input. <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx::GitHubPanel --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (REQ-GITHUB-011 AC3: tapping the toggle again hides the search and clears the active filter) -->
4. Desktop discloses the search the same way as touch — the magnify toggle renders and the search input stays hidden until the toggle is clicked (there is no always-on desktop search bar). <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx::GitHubPanel --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (REQ-GITHUB-011 AC4: on desktop the search is ALSO disclosed behind the magnify toggle (consistent with touch)) -->
5. On a touch device, revealing the search scrolls the input above the on-screen keyboard once it opens, so the field stays visible while typing. <!-- @manual: GitHub workspace manual acceptance in documentation/lanes/terminal-and-ide.md; observe actual OS keyboard and field visibility on a touch device. --> <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx::GitHubPanel --> <!-- @impl: web-ui/src/lib/mobile.ts::scrollFieldAboveKeyboard --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (scrollFieldAboveKeyboard / REQ-GITHUB-011 (reveal the touch search field above the on-screen keyboard)) -->
6. Opening search moves focus to the input, allowing the on-screen keyboard to open. <!-- @impl: web-ui/src/components/github/RepoSearch.tsx::RepoSearch --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (REQ-GITHUB-011 AC2: tapping the toggle reveals the search input, focuses it, and reflects the open state) -->
7. Closing search clears the active search filter. <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx::GitHubPanel --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (REQ-GITHUB-011 AC3: tapping the toggle again hides the search and clears the active filter) -->

**Constraints:**

- Adapt list scrolling to available height per [REQ-GITHUB-009](#req-github-009-github-repository-list-viewport-and-empty-states) AC4, without a fixed complete-row cap.
- Revealed search stays visible and reachable; every fetched repository remains accessible by scrolling.
- The on-screen keyboard opens.
- Touch detection uses `isTouchDevice()` (touch hardware + coarse pointer), the same gate as the rest of the mobile UI; capability is read once and never changes mid-session.
- Reuses the shared `IconButton` primitive (magnify face, `active` state); no new control primitive.

**Priority:** P2

**Dependencies:** [REQ-GITHUB-002](#req-github-002-github-panel-and-repository-listing), [REQ-GITHUB-009](#req-github-009-github-repository-list-viewport-and-empty-states)

**Verification:** Automated: [GitHubPanel.test.tsx](../../web-ui/src/__tests__/components/GitHubPanel.test.tsx), [mobile.test.ts](../../web-ui/src/__tests__/lib/mobile.test.ts); Manual: [GitHub workspace acceptance](../../documentation/lanes/terminal-and-ide.md#github-workspace-manual-acceptance)

**Status:** Implemented

---

### REQ-GITHUB-013: Connected GitHub tokens grant gist access

**Intent:** Every OAuth App connection grants the `gist` capability required by GitHub CLI and agent workflows, independent of the selected connection tier.

**Applies To:** User

**Acceptance Criteria:**

1. The OAuth App authorization redirect includes `gist` as a discrete scope for the minimal, recommended, and advanced connection tiers. <!-- @impl: src/lib/oauth-scopes.ts::githubScopeForTier --> <!-- @test: src/__tests__/routes/github.test.ts (REQ-GITHUB-013: requests gist access for every OAuth-App connection tier) -->

**Constraints:**

- The existing tier-specific repository, organization, workflow, and hook scopes remain unchanged; `read:user` applies to all tiers under [REQ-GITHUB-317](#req-github-317-additive-github-connection-and-scope-contract) AC5.
- GitHub App permissions remain fixed at registration and do not receive an OAuth `scope` parameter.
- Direct GitHub login remains an identity-only flow and does not own connection capabilities.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [REQ-GITHUB-007](#req-github-007-broaden-the-panel-gate-beyond-enterprise)

**Verification:** Automated: [github.test.ts](../../src/__tests__/routes/github.test.ts)

**Status:** Implemented

---
