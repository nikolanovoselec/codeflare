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

**Intent:** A user connects their GitHub account once; Codeflare obtains a per-user token (GitHub App user-to-server in enterprise/EMU, OAuth App in SaaS) and stores it encrypted so the agent can act as the user.

**Applies To:** User

**Acceptance Criteria:**

1. "Connect GitHub" starts the selected provider's authorize web flow (link mode) and, on callback, exchanges the code for a token persisted to the **existing** deploy-keys entry (`DeployKeys.githubToken`) with a `githubTokenSource` marker; no new KV key is introduced. <!-- @impl: src/lib/github-token.ts::connectGithub --> <!-- @test: src/__tests__/lib/github-token.test.ts (persists a connection to the deploy-keys entry with a source marker; authorizeUrl carries client_id/state/redirect_uri) -->
2. The token is encrypted at rest with the existing KV crypto (AES-256-GCM, AAD bound to the KV key) and is never returned to the browser. <!-- @impl: src/lib/github-token.ts::storeGithubConnection --> <!-- @test: src/__tests__/lib/github-token.test.ts (encrypts the token at rest when ENCRYPTION_KEY is set, round-trips on read, blob never contains the plaintext) -->
3. GitHub App tokens carry an expiry and refresh token; resolving a token returns a currently-valid one, refreshing within the skew window and **failing closed** (returning none) when an expired App token cannot be refreshed — never a stale token. <!-- @impl: src/lib/github-token.ts::getValidGithubToken --> <!-- @test: src/__tests__/lib/github-token.test.ts (refreshes a near-expiry App token + persists the rotated token; fails closed returning null when an expired App token cannot be refreshed) -->
4. The provider is resolved by `getGithubProvider` (async) in **every** mode: it reads the admin's Setup→KV config (provider type + client id + decrypted client secret) first via `getProviderFromKv`, then falls back to deploy-config env vars. A configured GitHub App takes precedence over the OAuth App; with neither configured the integration is unavailable, and a client secret that cannot be decrypted (no `ENCRYPTION_KEY`) is treated as unconfigured (fails closed). See [REQ-GITHUB-008](#req-github-008-enterprise-github-provider-configuration-via-setup). <!-- @impl: src/lib/github-token.ts::getGithubProvider --> <!-- @impl: src/lib/github-token.ts::getProviderFromKv --> <!-- @test: src/__tests__/lib/github-token.test.ts (resolves from KV first in every mode; App over OAuth precedence; KV wins over env; null when neither configured; fails closed on undecryptable secret) -->
5. A manually-pasted fine-grained PAT (existing deploy-keys flow) coexists, marked source `'pat'`, and is never sent to the App/OAuth refresh or revoke endpoints. <!-- @impl: src/routes/deploy-keys.ts --> <!-- @test: src/__tests__/lib/github-token.test.ts (returns a PAT verbatim with no network; disconnect clears a PAT without calling the revoke endpoint) -->

**Constraints:**

- Scopes: the OAuth App's `scope` is derived per connect from the requested tier (default `repo read:org workflow`; see [REQ-GITHUB-007](#req-github-007-broaden-the-panel-gate-beyond-enterprise) AC6); the GitHub App's equivalent permissions (Contents R/W, Pull requests R/W, Workflows W, Metadata R) are fixed at registration and ignore the tier.
- Enterprise GitHub Apps must be **internal** to the customer's enterprise — EMU managed users cannot authorize third-party apps.
- Per-user connect is **OAuth-only** on every surface (dashboard panel, Guided Setup, Settings "Push & Deploy" accordion) — no manual token paste ([REQ-GITHUB-007](#req-github-007-broaden-the-panel-gate-beyond-enterprise)). In enterprise the per-user accordion stays hidden (GitHub via the panel, Cloudflare via the admin-global Setup token, [REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)). The deploy-keys PAT backend path (source `'pat'`) itself is unchanged.

**Priority:** P1

**Dependencies:** [REQ-AUTH-002](authentication.md#req-auth-002-saas-mode-uses-direct-github-oauth), [CON-GH-001](constraints.md#con-gh-001-github-token-encrypted-at-rest-and-never-returned-to-the-browser), [CON-GH-002](constraints.md#con-gh-002-the-real-github-token-never-enters-the-enterprise-container)

**Verification:** [Unit test](../../src/__tests__/lib/github-token.test.ts)

**Status:** Implemented

---

### REQ-GITHUB-002: GitHub panel and repository listing

**Intent:** A panel beside the R2 storage panel lets a user connect GitHub and browse the repositories they can access, gated by deployment mode and tier.

**Applies To:** User

**Acceptance Criteria:**

1. `GET /api/github/status` reports connection state (connected, login, source) without exposing the token. <!-- @impl: src/routes/github.ts --> <!-- @test: src/__tests__/routes/github.test.ts (status reports connected with login + source when a token exists, never the token) -->
2. `GET /api/github/repos` returns the repos the user can access (personal + org via `read:org`), searchable and paginated, fetched server-side with the stored token; the token never reaches the browser. <!-- @impl: src/routes/github.ts --> <!-- @test: src/__tests__/routes/github.test.ts (proxies the user repos with the stored token and never returns the token; 401s when not connected) --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (renders exactly N rows for N repos inside a scroll container; search input filters the rendered row count) -->
3. The panel renders beside the storage panel; its backend feature flag (`githubFeatureEnabled`) is on in every mode, and the advanced-session entitlement is applied in the dashboard ([REQ-GITHUB-007](#req-github-007-broaden-the-panel-gate-beyond-enterprise)). <!-- @impl: src/routes/github.ts::githubFeatureEnabled --> <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx --> <!-- @impl: web-ui/src/components/Dashboard.tsx::githubPanelAvailable --> <!-- @test: src/__tests__/routes/github.test.ts (status reports enabled in every mode) --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (renders nothing when status.enabled is false) -->
4. Not-connected shows a Connect GitHub action; connected shows the account, refresh, Disconnect, and searchable repo list. The controls reuse one tested `IconButton` primitive. <!-- @impl: web-ui/src/components/github/ConnectedHeader.tsx --> <!-- @impl: web-ui/src/components/github/RepoList.tsx --> <!-- @impl: web-ui/src/components/ui/IconButton.tsx --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (refresh reloads repos; Disconnect flips to not-connected; disconnect control is an icon button; private-variant badge; enabled Clone button carrying repo+branch data) --> <!-- @test: web-ui/src/__tests__/components/IconButton.test.tsx (renders icon path, fires onClick, disabled, active/spin) -->
5. The panel is mobile-first and stacks with the storage panel at the existing narrow breakpoint. <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx --> <!-- coverage-gap: narrow-breakpoint stacking is CSS layout, not asserted in jsdom -->
6. The owner/login label and each repo name link to GitHub in a new tab; repo-name clicks do not trigger clone. <!-- @impl: web-ui/src/components/github/ConnectedHeader.tsx --> <!-- @impl: web-ui/src/components/github/RepoRow.tsx --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (connected login links out to the GitHub profile in a new tab; repo name links to the repo on GitHub with target=_blank rel=noopener) -->

**Constraints:**

- `/repos` and `/connect` are rate-limited; repo responses never include the token.
- The panel is available in every mode; outside enterprise it is gated to the `advanced` session (matching the Vault), enforced in the dashboard. See [REQ-GITHUB-007](#req-github-007-broaden-the-panel-gate-beyond-enterprise).

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage)

**Verification:** [Route test](../../src/__tests__/routes/github.test.ts) + [Panel test](../../web-ui/src/__tests__/components/GitHubPanel.test.tsx) + [IconButton test](../../web-ui/src/__tests__/components/IconButton.test.tsx)

**Status:** Implemented

---

### REQ-GITHUB-003: Enterprise egress-injected GitHub credentials

**Intent:** In enterprise mode the agent's git/`gh`/API calls to GitHub are authenticated by injecting the user's token at the container egress boundary, so the real token never enters the container.

**Applies To:** System

**Acceptance Criteria:**

1. `github.com` and `api.github.com` are registered for outbound HTTPS interception and handled by a GitHub interceptor; AI hosts continue to route to the LLM interceptor. <!-- @impl: src/container/index.ts::wireGithubInterception --> <!-- @test: src/__tests__/container/index.test.ts (wires the GitHubInterceptor for github.com + api.github.com with per-session user+bucket props) -->
2. On each intercepted request the interceptor resolves + decrypts the user's token for the bound session, strips any client-supplied auth, and stamps the correct credential (git Basic vs `gh` Bearer/`token`; `X-GitHub-Api-Version` for the API host). <!-- @impl: src/github-interceptor.ts::GitHubInterceptor --> <!-- @test: src/__tests__/github-interceptor.test.ts (stamps Bearer on api.github.com / Basic x-access-token on github.com, removes the placeholder, pins X-GitHub-Api-Version) -->
3. When no valid token exists, the interceptor fails closed with a clear error and performs no upstream request. <!-- @impl: src/github-interceptor.ts::GitHubInterceptor --> <!-- @test: src/__tests__/github-interceptor.test.ts (fails closed and performs no upstream request when no valid token) -->
4. The container holds only a non-secret placeholder `GH_TOKEN` identical for all users; user-scoping comes solely from the per-session interceptor binding (`props.bucket`), never from the request — a session can only ever inject its own user's token. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (emits a non-secret placeholder GH_TOKEN in enterprise mode, real token never enters the container) -->
5. In non-enterprise modes the token reaches the container via the existing deploy-keys→`GH_TOKEN` path, unchanged (see [REQ-GITHUB-006](#req-github-006-other-mode-container-transport)). <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (emits the real GH_TOKEN unchanged in non-enterprise mode) -->

**Constraints:**

- Enterprise interception is wired only when `ENTERPRISE_MODE=active`, at container start (CA-mount timing — see [REQ-ENTERPRISE-005](enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls)).

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [CON-GH-002](constraints.md#con-gh-002-the-real-github-token-never-enters-the-enterprise-container), [CON-GH-003](constraints.md#con-gh-003-egress-injection-is-scoped-by-the-per-session-binding)

**Verification:** [Interceptor test](../../src/__tests__/github-interceptor.test.ts) (injection format, fail-closed, no cross-user spoofing) + [wiring](../../src/__tests__/container/index.test.ts) + [placeholder env](../../src/__tests__/container/container-env.test.ts)

**Status:** Implemented

---

### REQ-GITHUB-004: Clone a repository into a session

**Intent:** From the panel a user clones a repository into a new or running session, into the workspace, ready for the agent.

**Applies To:** User

**Acceptance Criteria:**

1. The clone action offers a session picker: running sessions first, then a separator, then "Clone into a new session". A running-session row matches the new-session agent rows below it — same option-row layout/left edge (one shared `ClonePickerOptionRow`), the session's own agent icon (e.g. the Pi icon for a Pi session, from the agent options) and a "Running in <agent>" subtitle. <!-- @impl: web-ui/src/components/github/ClonePickerOptionRow.tsx --> <!-- @impl: web-ui/src/components/github/ClonePickerSessionRow.tsx --> <!-- @test: web-ui/src/__tests__/components/ClonePicker.test.tsx (running-group then new-session separator, ordering/counts, agent-icon + "Running in <agent>" subtitle) --> <!-- @test: web-ui/src/__tests__/components/ClonePickerOptionRow.test.tsx (icon/label/description/badge slots, onClick, disabled) --> <!-- @test: web-ui/src/__tests__/components/RepoRow.test.tsx (Clone button opens the picker carrying repo data) -->
2. New session → the repo is cloned before the agent process starts (entrypoint.sh, from the `clone` field on session create); running session → cloned via an authenticated internal RPC into the live container. <!-- @impl: src/routes/container/lifecycle.ts --> <!-- @impl: src/routes/github.ts --> <!-- @test: src/__tests__/routes/session-creation.test.ts (clone field accepted + persisted on the session record) --> <!-- @test: src/__tests__/routes/github.test.ts (POST /clone forwards to the container /internal/git-clone and relays the result) --> <!-- @test: src/__tests__/container/container-env.test.ts (emits GIT_CLONE_REPO when set) -->
3. The repo is cloned into `$USER_WORKSPACE/<repo-name-verbatim>`; the clone is refused with a clear message if that folder already exists. <!-- @impl: host/src/git-clone.ts::resolveGitClone --> <!-- @test: host/__tests__/git-clone.test.js (resolveGitClone computes <workspace>/<name>; endpoint refuses existing target with 409 CLONE_TARGET_EXISTS) --> <!-- @test: src/__tests__/routes/session-creation.test.ts (rejects a malformed/traversal repo with 400) -->
4. The clone targets the chosen branch (default branch preselected); authentication uses the per-mode credential path (egress injection in enterprise, `GH_TOKEN` otherwise). <!-- @impl: host/src/git-clone.ts::buildCloneArgs --> <!-- @test: host/__tests__/git-clone.test.js (buildCloneArgs inserts --branch=<ref> before the -- separator; carries a valid ref through) --> <!-- @test: src/__tests__/container/container-env.test.ts (emits GIT_CLONE_REF when set) -->
5. The cloned working tree is ephemeral by default and participates in workspace sync when the user has it enabled. <!-- @impl: host/src/git-clone.ts::resolveGitClone --> <!-- coverage-gap: ephemerality + workspace sync are the existing workspace-sync mechanism (separate REQ); no GitHub-specific code or test asserts this cross-REQ behavior -->

**Constraints:**

- The running-session clone is authenticated by the existing `CONTAINER_AUTH_TOKEN` Worker→DO mechanism.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [REQ-SESSION-001](session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type)

**Verification:** [Session-create clone field](../../src/__tests__/routes/session-creation.test.ts) + [POST /clone forward](../../src/__tests__/routes/github.test.ts) + [clone env](../../src/__tests__/container/container-env.test.ts) + [clone resolution](../../host/__tests__/git-clone.test.js) + [picker UI](../../web-ui/src/__tests__/components/ClonePicker.test.tsx) + [option row](../../web-ui/src/__tests__/components/ClonePickerOptionRow.test.tsx) + [RepoRow opens picker](../../web-ui/src/__tests__/components/RepoRow.test.tsx)

**Status:** Implemented

---

### REQ-GITHUB-005: Disconnect and offboarding revocation

**Intent:** Disconnecting (or offboarding) revokes and removes the user's GitHub token.

**Applies To:** User

**Acceptance Criteria:**

1. `POST /api/github/disconnect` revokes the token at GitHub (App/OAuth sources) and clears the github fields from the deploy-keys entry, removing the entry entirely when nothing else remains. <!-- @impl: src/lib/github-token.ts::disconnectGithub --> <!-- @test: src/__tests__/routes/github.test.ts (POST /api/github/disconnect revokes + clears the token and returns success) --> <!-- @test: src/__tests__/lib/github-token.test.ts (disconnectGithub revokes an App/OAuth token then clears the entry) -->
2. A manually-pasted PAT is cleared but not sent to the GitHub revoke endpoint. <!-- @impl: src/lib/github-token.ts::disconnectGithub --> <!-- @test: src/__tests__/lib/github-token.test.ts (a PAT source is cleared without calling the revoke endpoint) -->
3. User offboarding revokes and clears the GitHub token on the same cleanup path as the scoped R2 token. <!-- @impl: src/lib/user-cleanup.ts::cleanupUserData --> <!-- @test: src/__tests__/lib/user-cleanup.test.ts (revokes the GitHub token at GitHub, then deletes the deploy-keys entry) -->

**Constraints:**

None.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage)

**Verification:** [Unit test](../../src/__tests__/lib/github-token.test.ts) (disconnectGithub) + [offboarding revoke](../../src/__tests__/lib/user-cleanup.test.ts)

**Status:** Implemented

---

### REQ-GITHUB-006: Other-mode container transport

**Intent:** In SaaS / non-enterprise modes the GitHub token reaches the container through the existing deploy-keys→`GH_TOKEN` env path, with no transport change.

**Applies To:** System

**Acceptance Criteria:**

1. With a connected token in a non-enterprise session, `GH_TOKEN` is present in the container env exactly as for a manually-pasted PAT today. <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (emits the real GH_TOKEN unchanged in non-enterprise mode) -->
2. In enterprise mode the container receives a non-secret placeholder `GH_TOKEN` (no real token); the real token is injected at egress per [REQ-GITHUB-003](#req-github-003-enterprise-egress-injected-github-credentials). <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (emits a non-secret placeholder GH_TOKEN in enterprise mode) -->

**Constraints:**

- For non-enterprise modes this is documented as leakage-hygiene, not agent-containment: the agent can read its own user's token (which the user already has).

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [REQ-GITHUB-003](#req-github-003-enterprise-egress-injected-github-credentials)

**Verification:** [Container env test](../../src/__tests__/container/container-env.test.ts) (non-enterprise real `GH_TOKEN` vs enterprise placeholder)

**Status:** Implemented

---

### REQ-GITHUB-007: Broaden the panel gate beyond enterprise

**Intent:** Make the GitHub repository panel + Storage browser available in every non-enterprise mode (onboarding, default, SaaS), gated to the `advanced` session like the Vault, while **decoupling the OAuth connect/disconnect capability from that panel gate** so a user can connect GitHub from Guided Setup and the Settings accordion even when the panel itself is hidden. Connect stays the additive OAuth flow ([REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage)) — never a login-scope escalation, never a manually-pasted PAT. Enterprise is unchanged.

**Applies To:** User

**Acceptance Criteria:**

1. The panel backend (`GET /api/github/status.enabled`, `/repos`, `/clone`) is available in every mode (`githubFeatureEnabled` returns true); the **advanced-session entitlement** is enforced in the frontend dashboard, which makes the GitHub panel face available only for an `advanced` session or enterprise — matching the Vault gate (`sessionMode === 'advanced'`). <!-- @impl: src/routes/github.ts::githubFeatureEnabled --> <!-- @impl: web-ui/src/components/Dashboard.tsx::githubPanelAvailable --> <!-- @test: src/__tests__/routes/github.test.ts (status reports enabled outside enterprise; repos/clone reachable in non-enterprise) --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (advanced gate hides GitHub face for non-advanced non-enterprise) -->
2. The GitHub panel and the Storage browser render in onboarding, default, and SaaS-advanced dashboards with the same labels and flip behavior as enterprise ([REQ-GITHUB-002](#req-github-002-github-panel-and-repository-listing)); a non-advanced, non-enterprise session shows the Storage face only. <!-- @impl: web-ui/src/components/Dashboard.tsx::githubPanelAvailable --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (shows GitHub face for enterprise regardless of session mode; hides it for non-advanced non-enterprise) -->
3. `GET /api/github/connect`, its callback, and `POST /api/github/disconnect` are gated by authentication only (any authenticated user, any non-enterprise mode/tier) — **not** by the panel gate — so connect works from Guided Setup ([REQ-AUTH-015](authentication.md#req-auth-015-guided-onboarding-flow)) and the Settings accordion ([REQ-AGENT-018](agents.md#req-agent-018-push--deploy-credential-management-ui)) when the panel is hidden. Only `status`/`repos`/`clone` follow panel availability. <!-- @impl: src/routes/github.ts --> <!-- @test: src/__tests__/routes/github.test.ts (connect reachable for a non-advanced authed user in non-enterprise) -->
4. Connect/disconnect is one shared, composable component reused across the three surfaces — the dashboard panel, the Guided Setup onboarding flow ([REQ-AUTH-015](authentication.md#req-auth-015-guided-onboarding-flow)), and the Settings "Push & Deploy" accordion ([REQ-AGENT-018](agents.md#req-agent-018-push--deploy-credential-management-ui)) — so connect behavior is defined once. <!-- @impl: web-ui/src/components/connect/OAuthConnectCard.tsx --> <!-- @test: web-ui/src/__tests__/components/connect/OAuthConnectCard.test.tsx (shared card state matrix + connectUrl/tier/disconnect contracts) --> <!-- @test: web-ui/src/__tests__/components/connect/TierChooserDialog.test.tsx (dialog renders tiers + descriptions, marks selected, pick fires onPick) --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (non-enterprise button opens tier dialog; enterprise connects directly without dialog) -->
5. GitHub is connected via the additive OAuth flow ([REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage)), never by escalating the login scopes; the per-user token reaches the container via the existing deploy-keys→`GH_TOKEN` path ([REQ-GITHUB-006](#req-github-006-other-mode-container-transport)). Enterprise continues to use egress injection ([REQ-GITHUB-003](#req-github-003-enterprise-egress-injected-github-credentials)), byte-identical — no Cloudflare OAuth, no new gates. <!-- @impl: src/lib/github-token.ts::connectGithub --> <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/container/container-env.test.ts (real GH_TOKEN flows verbatim in non-enterprise vs enterprise placeholder) -->
6. The connect URL carries a scope `tier` (minimal/recommended/advanced); the server maps the tier to the OAuth-App `scope` parameter from a backend scope catalog (the GitHub App path's fixed permissions ignore it). <!-- @impl: src/lib/oauth-scopes.ts::githubScopeForTier --> <!-- @impl: src/routes/github.ts --> <!-- @test: src/__tests__/lib/oauth-scopes.test.ts (githubScopeForTier escalates capability with tier; tier->scope monotonicity) --> <!-- @test: src/__tests__/routes/github.test.ts (connect feeds the scope tier into the OAuth-App authorize scope param) -->

**Constraints:**

- Non-enterprise modes carry the real token in the container env (leakage-hygiene only, not agent-containment), unchanged from [REQ-GITHUB-006](#req-github-006-other-mode-container-transport).
- The scope catalog lives server-side; the client sends only the tier name (untrusted, normalized to a known tier, default `recommended`).

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [REQ-GITHUB-002](#req-github-002-github-panel-and-repository-listing), [REQ-GITHUB-006](#req-github-006-other-mode-container-transport), [REQ-AUTH-015](authentication.md#req-auth-015-guided-onboarding-flow), [REQ-AGENT-018](agents.md#req-agent-018-push--deploy-credential-management-ui)

**Verification:** [Route test](../../src/__tests__/routes/github.test.ts) + [Dashboard test](../../web-ui/src/__tests__/components/Dashboard.test.tsx) + [Connect card test](../../web-ui/src/__tests__/components/connect/OAuthConnectCard.test.tsx) + [Scope test](../../src/__tests__/lib/oauth-scopes.test.ts)

**Status:** Implemented

---

### REQ-GITHUB-008: Enterprise GitHub provider configuration via Setup

<!-- Title retains "Enterprise" for anchor stability; provider config is now admin-gated
     in every mode (see AC5). Originally enterprise-only, broadened with REQ-GITHUB-007. -->

**Intent:** Admins (in any deployment mode) configure the GitHub provider (GitHub App or OAuth App) and its credentials in the Setup wizard — persisted to KV — so GitHub integration works without GitHub-Actions or Cloudflare-secret access, mirroring the admin-global Browser Rendering token ([REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)).

**Applies To:** Admin

**Acceptance Criteria:**

1. The Setup wizard offers a provider chooser (GitHub App vs OAuth App); selecting one reveals that provider's Client ID + Client Secret inputs. Each provider's credentials are stored under their own KV keys so switching providers preserves the other's. <!-- @impl: web-ui/src/components/setup/GitHubProviderChooser.tsx --> <!-- @test: web-ui/src/__tests__/components/GitHubProviderChooser.test.tsx (provider switch reveals the right id+secret pair) --> <!-- @test: src/__tests__/routes/setup.test.ts (persists provider type + client id plain, secret encrypted) -->
2. On save (admin, any mode) the provider type + client ids are stored plain and each client secret is encrypted at rest (AES-256-GCM via the existing KV crypto); `getGithubProvider` resolves the active provider from these KV values, decrypting the secret, before any env-var fallback. <!-- @impl: src/routes/setup/index.ts --> <!-- @impl: src/lib/github-token.ts::getProviderFromKv --> <!-- @test: src/__tests__/routes/setup.test.ts (persists type+id plain, secret encrypted) --> <!-- @test: src/__tests__/lib/github-token.test.ts (getGithubProvider resolves provider+credentials from KV before env fallback) -->
3. A blank secret on save keeps the stored secret (no clobber); a secret submitted while no `ENCRYPTION_KEY` is configured is rejected with a validation error rather than written in plaintext, and a stored secret that cannot be decrypted is treated as unconfigured (fails closed). <!-- @impl: src/routes/setup/index.ts --> <!-- @test: src/__tests__/routes/setup.test.ts (blank secret no-clobber; rejects secret with no ENCRYPTION_KEY, no write) --> <!-- @test: src/__tests__/lib/github-token.test.ts (KV resolution fails closed on undecryptable secret) -->
4. `GET /api/setup/prefill` echoes the provider type, both client ids, and a `…ClientSecretSet` boolean per provider, but never returns a client secret. <!-- @impl: src/routes/setup/handlers.ts --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (prefill returns type+ids+secret-set flags, never the secret) -->
5. Provider config is **admin-gated in every mode** (the existing Setup admin gate), no longer behind `isEnterpriseMode`; `getGithubProvider` resolves from KV first in every mode ([REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage) AC4), and the prefill echoes the provider type + client ids + `…ClientSecretSet` in non-enterprise too. <!-- @impl: src/routes/setup/handlers.ts --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (prefill surfaces GitHub provider fields in non-enterprise) -->

**Constraints:**

- Removing a stored secret from the UI is not a v1 affordance (mirrors the browser-rendering token); re-registering with a new secret replaces it.
- The OAuth-App `scope` is tier-derived per connect ([REQ-GITHUB-007](#req-github-007-broaden-the-panel-gate-beyond-enterprise) AC6); this REQ covers only the provider client credentials, not the per-connect scope.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-001](#req-github-001-github-token-capture-and-storage), [REQ-BROWSER-007](browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token), [CON-GH-001](constraints.md#con-gh-001-github-token-encrypted-at-rest-and-never-returned-to-the-browser)

**Verification:** [Setup route test](../../src/__tests__/routes/setup.test.ts) + [handlers test](../../src/__tests__/routes/setup/handlers.test.ts) + [token resolver test](../../src/__tests__/lib/github-token.test.ts) + [chooser test](../../web-ui/src/__tests__/components/GitHubProviderChooser.test.tsx)

**Status:** Implemented

---

### REQ-GITHUB-009: GitHub repository list viewport and empty states

**Intent:** Repository lists stay searchable and scrollable without hiding fetched repositories.

**Applies To:** User

**Acceptance Criteria:**

1. A connected account with zero repositories shows the repository-panel empty state. <!-- @impl: web-ui/src/components/github/RepoList.tsx::RepoList --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (no-repositories empty state shown only when account has no repos) -->
2. Search with no matching repositories shows the search-empty state. <!-- @impl: web-ui/src/components/github/RepoList.tsx::RepoList --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (search-empty kept distinct from no-repositories via data-empty-state) -->
3. The repo list renders every fetched repository inside a scroll container. <!-- @impl: web-ui/src/components/github/RepoList.tsx::RepoList --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (renders every repo inside the scroll container, cap is a CSS viewport not truncation) -->
4. The repo list flexes to the height its panel is allotted by the adaptive GitHub/Storage split and scrolls the overflow, rather than capping at a fixed per-breakpoint row count. <!-- @impl: web-ui/src/styles/github-panel.css::.github-repo-rows --> <!-- @impl: web-ui/src/lib/panel-allocation.ts::decidePanelLayoutMode --> <!-- @test: web-ui/src/__tests__/lib/panel-allocation.test.ts (decidePanelLayoutMode) -->

**Constraints:**

- The list never truncates fetched repos; its height is an adaptive viewport set by the split allocation, not a data limit. The pixel allocation is flex/CSS, not unit-asserted in jsdom.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-002](#req-github-002-github-panel-and-repository-listing)

**Verification:** [Panel test](../../web-ui/src/__tests__/components/GitHubPanel.test.tsx)

**Status:** Implemented

---

### REQ-GITHUB-010: Mobile GitHub and storage face switching

**Intent:** Mobile users can switch between GitHub and R2 storage without an unavailable GitHub face covering files.

**Applies To:** User

**Acceptance Criteria:**

1. On mobile, the header flip control swaps GitHub and R2 storage in place when GitHub is available. <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx::GitHubPanel --> <!-- @impl: web-ui/src/components/Dashboard.tsx::effectiveFace --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (REQ-GITHUB-010: renders the mobile flip control only when onFlip is provided, and fires it) --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-GITHUB-010: flips GitHub <-> storage when enabled and the flip controls are used) -->
2. On desktop and tablet both panels stack as an adaptive split. <!-- @impl: web-ui/src/lib/panel-allocation.ts::decidePanelLayoutMode --> <!-- @impl: web-ui/src/components/Dashboard.tsx::measureLayout --> <!-- @test: web-ui/src/__tests__/lib/panel-allocation.test.ts (decidePanelLayoutMode) -->
3. The single-panel flip control is hidden while the column is in split mode and appears only when the column collapses to one panel. <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx::GitHubPanel --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (REQ-GITHUB-010: omits the flip control when onFlip is not provided) -->
4. If GitHub is unavailable, R2 storage is the sole mobile right-column face. <!-- @impl: web-ui/src/components/Dashboard.tsx::effectiveFace --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-GITHUB-010: forces the storage face active when GitHub is disabled so the empty GitHub panel cannot cover R2) -->
5. When GitHub is available, the storage face carries a matching header and flip-back control. <!-- @impl: web-ui/src/components/Dashboard.tsx::effectiveFace --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-GITHUB-010: defaults to the GitHub face and offers the storage back-button when GitHub is enabled) -->
6. The column collapses to a single panel with a flip control when it is narrower than the mobile breakpoint or too short to show both panels usably. <!-- @impl: web-ui/src/lib/panel-allocation.ts::decidePanelLayoutMode --> <!-- @impl: web-ui/src/components/Dashboard.tsx::measureLayout --> <!-- @test: web-ui/src/__tests__/lib/panel-allocation.test.ts (decidePanelLayoutMode) -->
7. In single-panel (flip) mode the active face sizes to its content up to a viewport cap (overflow scrolls inside the list), so a short panel — the connect card or a few repos — collapses instead of reserving the column. <!-- @impl: web-ui/src/styles/dashboard.css::.dashboard-panel-right --> <!-- coverage-gap: mobile flip-mode panel height is a pure CSS media-query allocation (flex:0 0 auto + max-height cap), not unit-assertable in jsdom; same rationale as REQ-GITHUB-009 AC4 -->

**Constraints:**

- The flip transition honors `prefers-reduced-motion: reduce` with an instant CSS-only swap.

**Priority:** P1

**Dependencies:** [REQ-GITHUB-002](#req-github-002-github-panel-and-repository-listing), [REQ-GITHUB-007](#req-github-007-broaden-the-panel-gate-beyond-enterprise)

**Verification:** [Dashboard test](../../web-ui/src/__tests__/components/Dashboard.test.tsx), [Panel test](../../web-ui/src/__tests__/components/GitHubPanel.test.tsx)

**Status:** Implemented

---

### REQ-GITHUB-011: Mobile search disclosure with autofocus

**Intent:** On touch devices the GitHub panel's repository search is disclosed on demand — hidden behind a magnify toggle so the repository list keeps its full whole-row viewport — and revealing it focuses the input so the on-screen keyboard opens immediately. On desktop the search bar stays always visible.

**Applies To:** User

**Acceptance Criteria:**

1. On a touch device, the connected panel hides the search input by default and renders a magnify toggle to the left of the refresh control in the connected header. <!-- @impl: web-ui/src/components/github/ConnectedHeader.tsx::ConnectedHeader --> <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx::GitHubPanel --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (touch hides search behind magnify toggle left of refresh) -->
2. Tapping the magnify toggle reveals the search input and moves focus to it (opening the on-screen keyboard); the toggle reflects the open state. <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx::GitHubPanel --> <!-- @impl: web-ui/src/components/github/RepoSearch.tsx::RepoSearch --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (tap reveals + focuses the input, toggle reflects open state) -->
3. Tapping the toggle again hides the search input and clears the active search filter, so a hidden search box never silently narrows the list. <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx::GitHubPanel --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (re-tap hides search and clears the filter) -->
4. On a non-touch (desktop) device the search input is always visible and no magnify toggle is rendered. <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx::GitHubPanel --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (desktop always-visible, no toggle) -->
5. On a touch device, revealing the search scrolls the input above the on-screen keyboard once it opens, so the field stays visible while typing. <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx::GitHubPanel --> <!-- @impl: web-ui/src/lib/mobile.ts::scrollFieldAboveKeyboard --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (scrollFieldAboveKeyboard reveals the field above the keyboard) -->

**Constraints:**

- The repository list's whole-row viewport cap ([REQ-GITHUB-009](#req-github-009-github-repository-list-viewport-and-empty-states) AC4) is unaffected: showing the search row shifts the list down but the `max-height` row cap still shows only complete rows.
- The on-screen keyboard opens because focus moves to the input synchronously inside the tap handler — iOS Safari opens the keyboard only on a synchronous `focus()` within the user gesture, so the input ref is focused in the toggle handler, not a deferred effect.
- Touch detection uses `isTouchDevice()` (touch hardware + coarse pointer), the same gate as the rest of the mobile UI; capability is read once and never changes mid-session.
- Reuses the shared `IconButton` primitive (magnify face, `active` state); no new control primitive.

**Priority:** P2

**Dependencies:** [REQ-GITHUB-002](#req-github-002-github-panel-and-repository-listing), [REQ-GITHUB-009](#req-github-009-github-repository-list-viewport-and-empty-states)

**Verification:** [Panel test](../../web-ui/src/__tests__/components/GitHubPanel.test.tsx), [Mobile test](../../web-ui/src/__tests__/lib/mobile.test.ts)

**Status:** Implemented
