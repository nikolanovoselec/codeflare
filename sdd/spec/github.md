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

[Authentication](authentication.md) (identity + the OAuth callback), [Enterprise Mode](enterprise-mode.md) (the egress interception layer), [Storage](storage.md) (`bucketName` keying, workspace sync), [Session Lifecycle](session-lifecycle.md) (clone-on-start).

---

### REQ-GITHUB-001: GitHub token capture and storage

<!-- @test: src/__tests__/lib/github-token.test.ts (github-token storage & status, getValidGithubToken, getGithubProvider, authorizeUrl, connectGithub, disconnectGithub -> AC1..AC5) -->
<!-- @impl: src/lib/github-token.ts::connectGithub -->
<!-- @impl: src/lib/github-token.ts::getGithubProvider -->
<!-- @impl: src/lib/github-token.ts::getValidGithubToken -->
**Intent:** A user connects their GitHub account once; Codeflare obtains a per-user token (GitHub App user-to-server in enterprise/EMU, OAuth App in SaaS) and stores it encrypted so the agent can act as the user.

**Applies To:** User

**Acceptance Criteria:**

1. "Connect GitHub" starts the selected provider's authorize web flow (link mode) and, on callback, exchanges the code for a token persisted to the **existing** deploy-keys entry (`DeployKeys.githubToken`) with a `githubTokenSource` marker; no new KV key is introduced. <!-- @impl: src/lib/github-token.ts::connectGithub -->
2. The token is encrypted at rest with the existing KV crypto (AES-256-GCM, AAD bound to the KV key) and is never returned to the browser. <!-- @impl: src/lib/github-token.ts::storeGithubConnection -->
3. GitHub App tokens carry an expiry and refresh token; resolving a token returns a currently-valid one, refreshing within the skew window and **failing closed** (returning none) when an expired App token cannot be refreshed — never a stale token. <!-- @impl: src/lib/github-token.ts::getValidGithubToken -->
4. The provider is resolved by `getGithubProvider` (async): in enterprise mode it reads the admin's Setup→KV config (provider type + client id + decrypted client secret) first, then falls back to deploy-config env vars; in non-enterprise modes it uses the env vars only. A configured GitHub App takes precedence over the OAuth App; with neither configured the integration is unavailable, and a client secret that cannot be decrypted (no `ENCRYPTION_KEY`) is treated as unconfigured (fails closed). See [REQ-GITHUB-008](#req-github-008-enterprise-github-provider-configuration-via-setup). <!-- @impl: src/lib/github-token.ts::getGithubProvider -->
5. A manually-pasted fine-grained PAT (existing deploy-keys flow) coexists, marked source `'pat'`, and is never sent to the App/OAuth refresh or revoke endpoints. <!-- @impl: src/routes/deploy-keys.ts -->

**Constraints:**

- Scopes: the OAuth App requests `repo read:org workflow`; the GitHub App's equivalent permissions (Contents R/W, Pull requests R/W, Workflows W, Metadata R) are set at registration.
- Enterprise GitHub Apps must be **internal** to the customer's enterprise — EMU managed users cannot authorize third-party apps.
- In enterprise mode the per-user "Push & Deploy" settings accordion (the manual PAT entry) is hidden — GitHub is connected via the panel and Cloudflare via the admin-global Setup token ([REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)). The PAT backend path (source `'pat'`) itself is unchanged.

**Priority:** P1

**Dependencies:** [REQ-AUTH-002](authentication.md#req-auth-002-saas-mode-uses-direct-github-oauth), [CON-GH-001](constraints.md#con-gh-001-github-token-encrypted-at-rest-and-never-returned-to-the-browser), [CON-GH-002](constraints.md#con-gh-002-the-real-github-token-never-enters-the-enterprise-container)

**Verification:** [Unit test](../../src/__tests__/lib/github-token.test.ts)

**Status:** Implemented

---

### REQ-GITHUB-002: GitHub panel and repository listing

<!-- @impl: src/routes/github.ts -->
<!-- @impl: web-ui/src/components/github/GitHubPanel.tsx -->
<!-- @impl: web-ui/src/components/github/ConnectedHeader.tsx -->
<!-- @impl: web-ui/src/components/github/RepoList.tsx -->
<!-- @impl: web-ui/src/components/github/RepoRow.tsx -->
<!-- @impl: web-ui/src/components/ui/IconButton.tsx -->
<!-- @impl: web-ui/src/components/Dashboard.tsx -->
<!-- @test: src/__tests__/routes/github.test.ts (status/repos/connect/disconnect -> AC1,AC2) -->
<!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (panel gating + states, refresh, icon-disconnect, external links, repo-row scroll container, mobile flip -> AC3,AC4,AC5,AC6,AC7,AC8) -->
<!-- @test: web-ui/src/__tests__/components/IconButton.test.tsx (icon path, onClick, disabled, active/spin -> AC4,AC6) -->
<!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (mobile right-column flip face: storage forced when GitHub disabled, flip round-trip when enabled -> AC8) -->
**Intent:** A panel beside the R2 storage panel lets a user connect GitHub and browse the repositories they can access, gated by deployment mode and tier.

**Applies To:** User

**Acceptance Criteria:**

1. `GET /api/github/status` reports connection state (connected, login, source) without exposing the token. <!-- @impl: src/routes/github.ts -->
2. `GET /api/github/repos` returns the repos the user can access (personal + org via `read:org`), searchable and paginated, fetched server-side with the stored token; the token never reaches the browser. <!-- @impl: src/routes/github.ts -->
3. The panel renders beside the storage panel and is gated to enterprise mode (`githubFeatureEnabled`). <!-- @impl: src/routes/github.ts::githubFeatureEnabled --> <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx -->
4. Not-connected shows a "Connect GitHub" action that starts the authorize flow; connected shows the account, a refresh control (reloads the repo list, the same `mdiSync` icon as the storage panel) and an icon-only Disconnect control (`mdiConnection`), and the searchable repo list. The refresh and disconnect controls reuse one tested `IconButton` primitive. <!-- @impl: web-ui/src/components/github/ConnectedHeader.tsx --> <!-- @impl: web-ui/src/components/ui/IconButton.tsx -->
5. The panel is mobile-first / responsive — it stacks with the storage panel at the existing narrow breakpoint.
6. The repo list is a scroll container, not a truncating list: every fetched repo is rendered, but the viewport caps the visible rows at ~10 on desktop (`--repo-row-h` × 10, hidden scrollbar) and on mobile grows to fill the available vertical space while never showing fewer than 3 rows. <!-- @impl: web-ui/src/styles/github-panel.css --> <!-- @impl: web-ui/src/components/github/RepoList.tsx -->
7. The owner/login label and each repo name are external links to GitHub (`https://github.com/<login>` and `https://github.com/<full_name>`), opening in a new tab (`target="_blank" rel="noopener noreferrer"`); a repo-name click does not trigger the row/clone action. <!-- @impl: web-ui/src/components/github/ConnectedHeader.tsx --> <!-- @impl: web-ui/src/components/github/RepoRow.tsx -->
8. On mobile a flip control (`mdiFlipVertical`) at the right of the panel header swaps the GitHub panel with the R2 storage panel in place; on desktop both panels stack as before and the flip control is hidden. The flip applies only when the GitHub panel is enabled; when GitHub is disabled (non-enterprise / onboarding) the R2 storage panel is the sole mobile right-column face and no flip control is shown, so the empty GitHub panel can never become the active face and cover the file browser. When the GitHub panel is enabled the storage face carries a matching "STORAGE" panel header — an uppercase label with a gray bottom border mirroring the GitHub panel header — and the flip-back control lives in that header; when GitHub is disabled the storage panel has no such header (it is the lone panel, so there is no GitHub header to mirror). <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx --> <!-- @impl: web-ui/src/components/Dashboard.tsx::effectiveFace --> <!-- @impl: web-ui/src/styles/dashboard.css -->

**Constraints:**

- `/repos` and `/connect` are rate-limited; repo responses never include the token.
- The panel gate is currently enterprise-only; broadening to the SaaS `advanced` tier and a per-user toggle (default off) is tracked as [REQ-GITHUB-007](#req-github-007-broaden-the-panel-gate-beyond-enterprise).
- The 10-row desktop cap is a CSS viewport (max-height), not a data limit — all fetched repos remain in the scroll container and searchable; the px cap is not unit-asserted in jsdom.
- The mobile flip transition is animated; the stylesheet honours `prefers-reduced-motion: reduce` with an instant swap. This is CSS-only (`web-ui/src/styles/dashboard.css`) and, like the row cap, is not unit-asserted in jsdom.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage)

**Verification:** [Route test](../../src/__tests__/routes/github.test.ts) + [Panel test](../../web-ui/src/__tests__/components/GitHubPanel.test.tsx) + [IconButton test](../../web-ui/src/__tests__/components/IconButton.test.tsx) (AC4, AC6)

**Status:** Implemented

---

### REQ-GITHUB-003: Enterprise egress-injected GitHub credentials

<!-- @impl: src/github-interceptor.ts::GitHubInterceptor -->
<!-- @impl: src/container/index.ts::wireGithubInterception -->
<!-- @impl: src/container/container-env.ts::buildEnvVars -->
<!-- @test: src/__tests__/github-interceptor.test.ts (injection format, fail-closed, no cross-user spoofing -> AC1..AC4) -->
<!-- @test: src/__tests__/container/container-env.test.ts (REQ-GITHUB-003 placeholder GH_TOKEN -> AC4) -->
<!-- @test: src/__tests__/container/index.test.ts (REQ-GITHUB-003 wiring -> AC1) -->
**Intent:** In enterprise mode the agent's git/`gh`/API calls to GitHub are authenticated by injecting the user's token at the container egress boundary, so the real token never enters the container.

**Applies To:** System

**Acceptance Criteria:**

1. `github.com` and `api.github.com` are registered for outbound HTTPS interception and handled by a GitHub interceptor; AI hosts continue to route to the LLM interceptor. <!-- @impl: src/container/index.ts::wireGithubInterception -->
2. On each intercepted request the interceptor resolves + decrypts the user's token for the bound session, strips any client-supplied auth, and stamps the correct credential (git Basic vs `gh` Bearer/`token`; `X-GitHub-Api-Version` for the API host). <!-- @impl: src/github-interceptor.ts::GitHubInterceptor -->
3. When no valid token exists, the interceptor fails closed with a clear error and performs no upstream request. <!-- @impl: src/github-interceptor.ts::GitHubInterceptor -->
4. The container holds only a non-secret placeholder `GH_TOKEN` identical for all users; user-scoping comes solely from the per-session interceptor binding (`props.bucket`), never from the request — a session can only ever inject its own user's token. <!-- @impl: src/container/container-env.ts::buildEnvVars -->
5. In non-enterprise modes the token reaches the container via the existing deploy-keys→`GH_TOKEN` path, unchanged (see [REQ-GITHUB-006](#req-github-006-other-mode-container-transport)).

**Constraints:**

- Enterprise interception is wired only when `ENTERPRISE_MODE=active`, at container start (CA-mount timing — see [REQ-ENTERPRISE-005](enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls)).

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [CON-GH-002](constraints.md#con-gh-002-the-real-github-token-never-enters-the-enterprise-container), [CON-GH-003](constraints.md#con-gh-003-egress-injection-is-scoped-by-the-per-session-binding)

**Verification:** [Interceptor test](../../src/__tests__/github-interceptor.test.ts) (injection format, fail-closed, no cross-user spoofing) + [wiring](../../src/__tests__/container/index.test.ts) + [placeholder env](../../src/__tests__/container/container-env.test.ts)

**Status:** Implemented

---

### REQ-GITHUB-004: Clone a repository into a session

<!-- @impl: src/routes/github.ts -->
<!-- @impl: src/routes/session/crud.ts -->
<!-- @impl: src/routes/container/lifecycle.ts -->
<!-- @impl: src/container/container-env.ts::buildEnvVars -->
<!-- @impl: web-ui/src/components/github/ClonePicker.tsx -->
<!-- @impl: web-ui/src/components/github/ClonePickerOptionRow.tsx -->
<!-- @impl: web-ui/src/components/github/ClonePickerSessionRow.tsx -->
<!-- @impl: web-ui/src/components/github/ClonePickerNewSession.tsx -->
<!-- @impl: entrypoint.sh -->
<!-- @impl: host/src/git-clone.ts -->
<!-- @impl: host/src/server.ts -->
<!-- @test: src/__tests__/routes/session-creation.test.ts (clone field accepted/persisted/rejected -> AC2,AC3) -->
<!-- @test: src/__tests__/routes/github.test.ts (POST /clone forward+relay -> AC2) -->
<!-- @test: src/__tests__/container/container-env.test.ts (GIT_CLONE_REPO/REF env -> AC2,AC3) -->
<!-- @test: host/__tests__/git-clone.test.js (repo/ref validation + dir computation -> AC3,AC4) -->
<!-- @test: web-ui/src/__tests__/components/ClonePicker.test.tsx (running-group then new-session separator, ordering/counts, running-row agent-icon + "Running in <agent>" subtitle, shared option-row layout -> AC1) -->
<!-- @test: web-ui/src/__tests__/components/ClonePickerOptionRow.test.tsx (icon/label/description/badge slots, onClick, disabled -> AC1) -->
<!-- @test: web-ui/src/__tests__/components/RepoRow.test.tsx (Clone button opens the picker -> AC1) -->
**Intent:** From the panel a user clones a repository into a new or running session, into the workspace, ready for the agent.

**Applies To:** User

**Acceptance Criteria:**

1. The clone action offers a session picker: running sessions first, then a separator, then "Clone into a new session". A running-session row matches the new-session agent rows below it — same option-row layout/left edge (one shared `ClonePickerOptionRow`), the session's own agent icon (e.g. the Pi icon for a Pi session, from the agent options) and a "Running in <agent>" subtitle. <!-- @impl: web-ui/src/components/github/ClonePickerOptionRow.tsx --> <!-- @impl: web-ui/src/components/github/ClonePickerSessionRow.tsx -->
2. New session → the repo is cloned before the agent process starts (entrypoint.sh, from the `clone` field on session create); running session → cloned via an authenticated internal RPC into the live container. <!-- @impl: src/routes/container/lifecycle.ts --> <!-- @impl: src/routes/github.ts -->
3. The repo is cloned into `$USER_WORKSPACE/<repo-name-verbatim>`; the clone is refused with a clear message if that folder already exists. <!-- @impl: host/src/git-clone.ts::resolveGitClone -->
4. The clone targets the chosen branch (default branch preselected); authentication uses the per-mode credential path (egress injection in enterprise, `GH_TOKEN` otherwise). <!-- @impl: host/src/git-clone.ts::buildCloneArgs -->
5. The cloned working tree is ephemeral by default and participates in workspace sync when the user has it enabled.

**Constraints:**

- The running-session clone is authenticated by the existing `CONTAINER_AUTH_TOKEN` Worker→DO mechanism.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [REQ-SESSION-001](session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type)

**Verification:** [Session-create clone field](../../src/__tests__/routes/session-creation.test.ts) + [POST /clone forward](../../src/__tests__/routes/github.test.ts) + [clone env](../../src/__tests__/container/container-env.test.ts) + [clone resolution](../../host/__tests__/git-clone.test.js) + [picker UI](../../web-ui/src/__tests__/components/ClonePicker.test.tsx) + [option row](../../web-ui/src/__tests__/components/ClonePickerOptionRow.test.tsx) + [RepoRow opens picker](../../web-ui/src/__tests__/components/RepoRow.test.tsx)

**Status:** Implemented

---

### REQ-GITHUB-005: Disconnect and offboarding revocation

<!-- @impl: src/lib/github-token.ts::disconnectGithub -->
<!-- @impl: src/lib/user-cleanup.ts::cleanupUserData -->
<!-- @impl: src/routes/github.ts -->
<!-- @test: src/__tests__/routes/github.test.ts (POST /api/github/disconnect > revokes + clears the token and returns success -> AC1) -->
<!-- @test: src/__tests__/lib/github-token.test.ts (disconnectGithub revoke vs pat -> AC1,AC2) -->
<!-- @test: src/__tests__/lib/user-cleanup.test.ts (REQ-GITHUB-005: revokes the GitHub token at GitHub, then deletes the deploy-keys entry -> AC3) -->
**Intent:** Disconnecting (or offboarding) revokes and removes the user's GitHub token.

**Applies To:** User

**Acceptance Criteria:**

1. `POST /api/github/disconnect` revokes the token at GitHub (App/OAuth sources) and clears the github fields from the deploy-keys entry, removing the entry entirely when nothing else remains. <!-- @impl: src/lib/github-token.ts::disconnectGithub -->
2. A manually-pasted PAT is cleared but not sent to the GitHub revoke endpoint. <!-- @impl: src/lib/github-token.ts::disconnectGithub -->
3. User offboarding revokes and clears the GitHub token on the same cleanup path as the scoped R2 token. <!-- @impl: src/lib/user-cleanup.ts::cleanupUserData -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage)

**Verification:** [Unit test](../../src/__tests__/lib/github-token.test.ts) (disconnectGithub) + [offboarding revoke](../../src/__tests__/lib/user-cleanup.test.ts)

**Status:** Implemented

---

### REQ-GITHUB-006: Other-mode container transport

<!-- @impl: src/container/container-env.ts::buildEnvVars -->
<!-- @test: src/__tests__/container/container-env.test.ts (non-enterprise real GH_TOKEN vs enterprise placeholder -> AC1,AC2) -->
**Intent:** In SaaS / non-enterprise modes the GitHub token reaches the container through the existing deploy-keys→`GH_TOKEN` env path, with no transport change.

**Applies To:** System

**Acceptance Criteria:**

1. With a connected token in a non-enterprise session, `GH_TOKEN` is present in the container env exactly as for a manually-pasted PAT today.
2. In enterprise mode the container receives a non-secret placeholder `GH_TOKEN` (no real token); the real token is injected at egress per [REQ-GITHUB-003](#req-github-003-enterprise-egress-injected-github-credentials).

**Constraints:**

- For non-enterprise modes this is documented as leakage-hygiene, not agent-containment: the agent can read its own user's token (which the user already has).

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [REQ-GITHUB-003](#req-github-003-enterprise-egress-injected-github-credentials)

**Verification:** [Container env test](../../src/__tests__/container/container-env.test.ts) (non-enterprise real `GH_TOKEN` vs enterprise placeholder)

**Status:** Implemented

---

### REQ-GITHUB-007: Broaden the panel gate beyond enterprise

**Intent:** Make the GitHub panel available outside enterprise mode — to SaaS at the `advanced` tier and, in other modes, behind a per-user toggle (default off) — so non-enterprise users can connect GitHub through the panel rather than only via a manually-pasted PAT.

**Applies To:** User

**Acceptance Criteria:**

1. `githubFeatureEnabled` returns true in SaaS mode when the subscribed tier is `advanced`, in addition to enterprise mode.
2. In other (non-enterprise, non-advanced-SaaS) modes the panel is available only when a per-user toggle is enabled; the toggle defaults to off and is persisted per user.
3. When the panel is available in a non-enterprise session, a connected token reaches the container via the existing deploy-keys→`GH_TOKEN` path ([REQ-GITHUB-006](#req-github-006-other-mode-container-transport)); enterprise continues to use egress injection ([REQ-GITHUB-003](#req-github-003-enterprise-egress-injected-github-credentials)).

**Constraints:**

- Non-enterprise modes carry the real token in the container env (leakage-hygiene only, not agent-containment); the toggle copy must make that boundary explicit before a user opts in.

**Priority:** P2

**Dependencies:** [REQ-GITHUB-002](#req-github-002-github-panel-and-repository-listing), [REQ-GITHUB-006](#req-github-006-other-mode-container-transport)

**Verification:** None

**Status:** Planned

---

### REQ-GITHUB-008: Enterprise GitHub provider configuration via Setup

<!-- @impl: src/routes/setup/index.ts -->
<!-- @impl: src/routes/setup/handlers.ts -->
<!-- @impl: src/lib/github-token.ts::getEnterpriseProviderFromKv -->
<!-- @impl: src/lib/github-token.ts::getGithubProvider -->
<!-- @impl: src/lib/kv-keys.ts::SETUP_KEYS -->
<!-- @impl: web-ui/src/components/setup/GitHubProviderChooser.tsx -->
<!-- @test: src/__tests__/routes/setup.test.ts (github provider config persist, no-clobber, fail-closed -> AC1..AC3) -->
<!-- @test: src/__tests__/routes/setup/handlers.test.ts (github prefill echo + non-enterprise guard -> AC4,AC5) -->
<!-- @test: src/__tests__/lib/github-token.test.ts (enterprise KV provider resolution + fail-closed -> AC2,AC3) -->
<!-- @test: web-ui/src/__tests__/components/GitHubProviderChooser.test.tsx (provider switch reveals the right pair -> AC1) -->
**Intent:** Enterprise admins configure the GitHub provider (GitHub App or OAuth App) and its credentials in the Setup wizard — persisted to KV — so GitHub integration works without GitHub-Actions or Cloudflare-secret access, mirroring the admin-global Browser Rendering token ([REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)).

**Applies To:** Admin

**Acceptance Criteria:**

1. The Setup wizard offers a provider chooser (GitHub App vs OAuth App); selecting one reveals that provider's Client ID + Client Secret inputs. Each provider's credentials are stored under their own KV keys so switching providers preserves the other's. <!-- @impl: web-ui/src/components/setup/GitHubProviderChooser.tsx -->
2. On save (enterprise mode only) the provider type + client ids are stored plain and each client secret is encrypted at rest (AES-256-GCM via the existing KV crypto); `getGithubProvider` resolves the active provider from these KV values, decrypting the secret, before any env-var fallback. <!-- @impl: src/routes/setup/index.ts --> <!-- @impl: src/lib/github-token.ts::getEnterpriseProviderFromKv -->
3. A blank secret on save keeps the stored secret (no clobber); a secret submitted while no `ENCRYPTION_KEY` is configured is rejected with a validation error rather than written in plaintext, and a stored secret that cannot be decrypted is treated as unconfigured (fails closed). <!-- @impl: src/routes/setup/index.ts -->
4. `GET /api/setup/prefill` echoes the provider type, both client ids, and a `…ClientSecretSet` boolean per provider, but never returns a client secret. <!-- @impl: src/routes/setup/handlers.ts -->
5. All reads/writes are inside the existing `isEnterpriseMode` gate; in non-enterprise modes the Setup request/response shape and `getGithubProvider`'s env-var path are byte-identical to before. <!-- @impl: src/routes/setup/handlers.ts -->

**Constraints:**

- Removing a stored secret from the UI is not a v1 affordance (mirrors the browser-rendering token); re-registering with a new secret replaces it.
- SaaS OAuth-app-with-extra-scopes is out of scope.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token), [CON-GH-001](constraints.md#con-gh-001-github-token-encrypted-at-rest-and-never-returned-to-the-browser)

**Verification:** [Setup route test](../../src/__tests__/routes/setup.test.ts) + [handlers test](../../src/__tests__/routes/setup/handlers.test.ts) + [token resolver test](../../src/__tests__/lib/github-token.test.ts) + [chooser test](../../web-ui/src/__tests__/components/GitHubProviderChooser.test.tsx)

**Status:** Implemented
