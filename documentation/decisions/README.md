
# Architecture Decisions

Architecture Decision Records for Codeflare. Each active record documents a real choice between alternatives and preserves its rationale, trade-offs, and consequences. AD identifiers remain stable because requirements, source, and historical documents link to them.

## How to read this ledger

- **Active:** the decision still governs the system.
- **Superseded:** a newer linked decision or requirement replaced the whole record. Superseded entries are struck through in the index, while their original sections remain readable as history.
- **Partially superseded:** only the explicitly named clause was replaced; the record remains active for everything else.
- **Redirect anchor:** the numbered heading remains for inbound links, but its content moved to another ADR or canonical documentation lane. Follow the destination in the index and section status.

**Audience:** Developers

---

## Decision Index

`Decision` is a concise label of at most 90 rendered characters. `Summary` is one sentence of 40–180 rendered characters naming the affected component or boundary, chosen mechanism, and a body-supported driver or operational consequence; historical rows also link the successor, retained scope, or redirect destination.

| ID | Decision | Summary | Category | State |
|----|----------|---------|----------|-------|
| [AD1](#ad1-one-container-per-session) | Isolate each terminal session in its own container | Each terminal tab receives a dedicated 1-vCPU container, preventing noisy-neighbor contention and making teardown a clean-slate operation. | Architecture | Active |
| [AD2](#ad2-container-id-format) | Derive container IDs from bucket and session IDs | Container IDs use `{bucketName}-{sessionId}` for direct Durable Object lookup without KV, and invalid session IDs never fall back to avoid orphans. | Architecture | Active |
| [AD3](#ad3-per-user-r2-buckets) | Create an isolated R2 bucket for each user | The Worker derives and creates one S3-compatible bucket per email identity, isolating files and reducing user deletion to emptying and deleting that bucket. | Architecture | Active |
| ~~[AD4](#ad4-periodic-rclone-bisync)~~ | ~~Replace the original periodic bisync policy~~ | The 60-second daemon cadence moved to [AD56](#ad56-15-minute-bisync-cadence-with-manual-triggers), and final-drain timing moved to [AD57](#ad57-135-second-shutdown-budget-for-final-bisync). | Architecture | Superseded |
| [AD5](#ad5-login-shell-autostart) | Autostart the configured agent from the login shell | The PTY launches `bash -l`, whose `.bashrc` starts the `TAB_CONFIG` agent unless `MANUAL_TAB=1` marks a user-created shell. | Architecture | Active |
| [AD6](#ad6-kv-read-modify-write-races-and-collectmetrics-atomicity) | Accept KV races and keep metrics collection in one alarm | KV session state remains last-writer-wins, while one `alarm()` callback groups activity, health, and status work because stricter coordination adds unjustified latency. | Architecture | Active |
| [AD7](#ad7-merged-into-ad10) | Redirect pre-setup endpoint risk to the bootstrap-window ADR | [AD10](#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation) now contains the pre-setup public-endpoint risk acceptance formerly recorded here. | Security | Redirect anchor |
| [AD8](#ad8-root-container-no-internal-auth) | Run root containers behind the Durable Object boundary | Containers run as root for rclone and trust a per-lifecycle proxy token because only the Durable Object can reach their internal port 8080. | Architecture | Active |
| [AD9](#ad9-ressource_tier-spelling) | Redirect RESSOURCE_TIER compatibility to configuration docs | [Configuration](../lanes/configuration.md#container-specs) now owns the backward-compatible `RESSOURCE_TIER` spelling and its do-not-rename guidance. | Configuration | Redirect anchor |
| [AD10](#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation) | Permit a bounded unauthenticated bootstrap window | Setup routes relax authentication and CSRF until `setup:complete` reaches KV, enabling self-hosted configuration before Cloudflare Access exists. | Security | Active |
| [AD11](#ad11-suffix-pattern-cors-with-credentials) | Allow credentialed CORS through boundary-checked suffix patterns | `matchesPattern()` accepts configured suffixes such as `.workers.dev` with credentials while enforcing domain boundaries and leaving JWT validation as the primary gate. | Security | Active |
| [AD12](#ad12-kv-based-setup-lock-non-atomic) | Use a non-atomic KV lock for one-time setup | Setup reads and then writes `setup:complete` in KV because its Cloudflare API steps are idempotent and a rare race causes redundant calls rather than corrupt state. | Security | Active |
| [AD13](#ad13-per-user-scoped-r2-tokens) | Issue bucket-scoped R2 credentials per user | Per-user R2 tokens remain bucket-scoped; [AD143](#ad143-strict-r2-interception-signs-only-with-the-bound-users-scoped-credential) replaces direct container delivery only under strict interception. | Security | Partially superseded |
| ~~[AD14](#ad14-never-auto---resync-on-bisync-failure)~~ | ~~Replace the ban on automatic bisync resync~~ | [AD125](#ad125-bounded-automatic-resync-after-exhausted-recovery) permits baseline re-establishment only after bounded recovery fails, while preserving deletion-safety concerns. | Storage | Superseded |
| [AD15](#ad15-tabconfigschema-allows-arbitrary-command-strings) | Allow arbitrary bounded tab command strings | `TabConfigSchema` accepts command strings up to 200 characters because users already control a root shell inside their own ephemeral sandbox. | UI/Frontend | Active |
| [AD16](#ad16-entrypointsh-1090-lines-complexity) | Retain the large entrypoint shell implementation | `entrypoint.sh` keeps its accumulated orchestration logic because rewriting production-tested migration, sync, PTY, and shutdown paths risks reviving solved defects. | Architecture | Active |
| [AD17](#ad17-merged-into-ad6) | Redirect collectMetrics atomicity to the KV-races ADR | [AD6](#ad6-kv-read-modify-write-races-and-collectmetrics-atomicity) now owns the rationale for grouping `collectMetrics` work in one `alarm()` callback. | Architecture | Redirect anchor |
| [AD18](#ad18-vendored-creativewebgl-code-uses-untyped-patterns) | Keep untyped patterns inside isolated vendored WebGL modules | Vendored WebGL utilities retain confined `any` casts and an adapted constructor because upstream types are absent and refactoring visual code adds regression risk. | UI/Frontend | Active |
| [AD19](#ad19-merged-into-ad18) | Redirect splash cursor casts to the vendored WebGL ADR | [AD18](#ad18-vendored-creativewebgl-code-uses-untyped-patterns) now contains the rationale for `as any` pointer and shader-uniform casts in `splash-cursor-logic.ts`. | UI/Frontend | Redirect anchor |
| [AD20](#ad20-toctou-in-containerlifecyclets) | Treat lifecycle TOCTOU warnings as false positives | Durable Object serialization prevents `alarm()` and `fetch()` handlers for one ID from executing concurrently, so flagged lifecycle read/write races cannot occur. | Architecture | Active |
| [AD21](#ad21-inconsistent-function-signatures) | Preserve mixed helper function signatures | Legacy helpers keep positional arguments and newer helpers use options objects because both contracts are typed, while normalization could regress callers. | Architecture | Active |
| [AD22](#ad22-jwks-30s-cache-staleness) | Cache JWKS keys for 30 seconds | `jwt.ts` caches JWKS responses for 30 seconds because Cloudflare Access overlaps rotated keys and shorter caching would add verification latency without material benefit. | Security | Active |
| [AD23](#ad23-cors-origin-pattern-validation) | Redirect CORS administrator trust rationale to security docs | [Security](../lanes/security.md#static-analyzer-false-positives) and the `isAllowedOrigin` docstring now own the administrator-trust basis for the CORS analyzer exception. | Security | Redirect anchor |
| [AD24](#ad24-predictable-session-ids) | Redirect session ID rationale to security docs | [Security](../lanes/security.md#session-id-validation) and `src/lib/constants.ts` now explain that session IDs are KV namespace keys, while JWT remains the authentication gate. | Security | Redirect anchor |
| [AD25](#ad25-e2e-service-email-hardcoded) | Redirect E2E fixture identity evidence to security docs | [Security](../lanes/security.md#static-analyzer-false-positives) and `src/lib/access.ts` now identify the hardcoded service email as a test fixture, not a credential. | Security, Testing | Redirect anchor |
| [AD26](#ad26-stress-test-rate-limit-bypass-integration-only) | Gate rate-limit bypass behind the integration environment | `STRESS_TEST_MODE=active` bypasses rate-limit I/O only in GitHub Actions' integration environment so shared-token k6 tests can exceed ordinary per-user limits. | Security | Active |
| [AD27](#ad27-server-side-prefix-delete) | Delete R2 prefixes with server-side list and batch operations | `emptyR2Bucket()` lists objects and deletes batches of 1,000 through the S3 API, avoiding frontend rate limits that break large-folder deletion. | Storage | Active |
| [AD28](#ad28-merged-into-ad26) | Redirect stress-test environment scoping to AD26 | [AD26](#ad26-stress-test-rate-limit-bypass-integration-only) now owns the GitHub Actions environment boundary that keeps `STRESS_TEST_MODE` out of production. | Security | Redirect anchor |
| [AD29](#ad29-container-secrets-as-env-vars) | Expose secrets as environment variables in single-tenant containers | The Container Durable Object injects scoped credentials and user keys as plaintext environment variables because the same user already controls the container's root shell. | Security | Active |
| [AD30](#ad30-worker-name-from-host-header) | Derive the Worker name from Host during initial setup | Setup parses `.workers.dev` hosts for the Worker name and uses `CLOUDFLARE_WORKER_NAME` on custom domains, limiting spoofing exposure to an authenticated, idempotent setup window. | Security | Active |
| [AD31](#ad31-root-container-is-intentional) | Redirect root-container rationale to security evidence | [Security](../lanes/security.md#static-analyzer-false-positives) and the Dockerfile now own the network-isolation rationale for intentionally omitting a non-root `USER`. | Security | Redirect anchor |
| [AD32](#ad32-encryption_key-is-optional) | Make KV credential encryption optional | Deployments may omit `ENCRYPTION_KEY` and store credentials as plaintext JSON in KV, trading storage protection for simpler self-hosted onboarding. | Security | Active |
| [AD33](#ad33-merged-into-ad10) | Redirect pre-setup CSRF risk to the bootstrap-window ADR | [AD10](#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation) now owns the accepted CSRF risk while setup bypasses `X-Requested-With` checks. | Security | Redirect anchor |
| [AD34](#ad34-websocket-auth-bypass-of-hono-middleware) | Maintain a parallel authentication path for WebSocket upgrades | The WebSocket handler mirrors authentication, CORS, rate limits, and tier gates before Hono because workerd upgrades cannot traverse the normal middleware chain. | Security | Active |
| [AD35](#ad35-merged-into-ad18) | Redirect the legacy splash constructor to the vendored WebGL ADR | [AD18](#ad18-vendored-creativewebgl-code-uses-untyped-patterns) now owns the rationale for the `this: any` constructor and downstream untyped rendering code. | UI/Frontend | Redirect anchor |
| [AD36](#ad36-websocket-origin-check-is-optional-for-non-browser-clients) | Permit originless WebSockets for non-browser clients | `terminal.ts` requires Origin only when `Sec-Fetch-Mode` signals a browser, allowing CLI clients while `authenticateRequest()` remains the mandatory credential gate. | Security | Active |
| [AD37](#ad37-kv-as-billing-read-cache----signal-and-sync-cf-015) | Use Stripe as truth and KV as a billing read cache | Webhooks call `syncSubscriptionState()` to fetch and cache a complete Stripe snapshot, with `lastSyncedAt` preventing stale concurrent writes. | Billing | Active |
| [AD38](#ad38-github-oidc-replaces-cf-access-in-saas-mode) | Authenticate SaaS users with GitHub OIDC instead of Cloudflare Access | GitHub OIDC and HMAC session cookies remain active, but [AD48](#ad48-oauth-state-replaced-by-hmac-signed-stateless-token) replaced only the cookie-based OAuth state clause. | Billing | Partially superseded |
| [AD39](#ad39-max-users-capacity-cap-counts-paid-slots-only) | Count only paid slots toward the user capacity cap | `countPaidSlots()` includes admins and active or trialing paid tiers while excluding free, pending, and blocked users so free accounts cannot consume paid capacity. | Billing | Active |
| [AD40](#ad40-webhook-route-order-publicstripe-before-public) | Mount the Stripe webhook before the public catch-all route | Hono registers `/public/stripe` before `/public` so the catch-all router cannot intercept webhook requests or future specialized public sub-routes. | Billing | Active |
| [AD41](#ad41-custom-tier-uses-contact-flow-not-self-service-checkout) | Route Custom-tier prospects through an email contact flow | The Custom tier sends a rate-limited Resend inquiry through `/api/auth/contact-team` instead of offering Stripe checkout because the plan requires enterprise discussion. | Billing | Active |
| [AD42](#ad42-unauthenticated-first-setbucketname-call-cf-010) | Allow the first internal bucket-name call without a token | The initial `/_internal/setBucketName` call relies on the non-public Durable Object binding because its per-lifecycle container token does not exist until afterward. | Security | Active |
| [AD43](#ad43-parse-and-exclude-vanishing-files-before-escalating-to-nuke) | Exclude vanished files before destructive bisync recovery | Bisync parses missing-file errors into a session filter and retries up to three times, reserving R2 object nuking for actual corruption rather than transient deletes. | Storage | Active |
| [AD44](#ad44-sdd-three-mode-autonomy-with-conservative-judgment-resolution) | Ship SDD with three autonomy modes and conservative judgment handling | SDD provides interactive, auto, and unleashed modes under shared agent rules; unleashed marks unresolved spec conflicts Partial instead of overwriting intent. | Architecture | Active |
| ~~[AD45](#ad45-user-overrides-recorded-as-adrs-not-skip-list)~~ | ~~Remove per-rule ADR overrides~~ | The SDD override mechanism moved to [AD51](#ad51-rip-out-six-overengineered-sdd-framework-features), leaving recurring findings to rule or REQ fixes. | Process | Superseded |
| [AD46](#ad46-review-reality-filter-as-phase-5) | Add a stateful Reality Filter to review | The `/review` pipeline adds a Phase 5 Reality Filter backed by `sdd/.review-decisions.md` to suppress repeat noise while preserving an audit log. | Architecture | Active |
| [AD47](#ad47-pty-keepalive-as-safety-net-only-not-the-idle-policy) | Keep PTY reaping subordinate to idle-stop policy | The PTY reaper uses a four-hour floor as a stuck-lifecycle safety net, so it cannot terminate an agent before the maximum `sleepAfter` policy. | Architecture | Active |
| [AD48](#ad48-oauth-state-replaced-by-hmac-signed-stateless-token) | Sign OAuth state in a stateless HMAC token | GitHub OAuth carries state as a 30-minute HMAC-SHA256 token, avoiding cookie loss under iOS ITP while retaining an expiry-bound CSRF check. | Security | Active |
| [AD49](#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install) | Preseed context-mode instead of installing it at runtime | The Custom-tier preseed hook path remains active, while MCP registration moved to [AD109](#ad109-context-mode-mcp-registration-is-universal-and-entrypoint-owned). | Architecture | Partially superseded |
| [AD50](#ad50-unified-adr-file-with-structural-doc-allow-large-exemption) | Keep one ADR ledger with stable anchors | The unified `decisions/README.md` and stable AD anchors remain, while [AD51](#ad51-rip-out-six-overengineered-sdd-framework-features) removed `doc-allow-large`. | Process | Partially superseded |
| [AD51](#ad51-rip-out-six-overengineered-sdd-framework-features) | Remove six overengineered SDD features | The SDD framework removes override, hatch, split-proposal, collision, commit-category, and annotation checks to reduce operator and authoring surface. | Architecture | Active |
| [AD52](#ad52-graphify-mcp-available-everywhere-discipline-advanced-only) | Expose Graphify everywhere but gate proactive discipline | Graphify tools ship in every paid session, while advanced mode alone adds clone triage and graph-first nudges to avoid changing default agent behavior. | Architecture | Active |
| [AD53](#ad53-graphify-hot-reload-wrapper-with-multi-repo-sentinel-tracking) | Hot-reload Graphify across repositories | A lazy Graphify wrapper atomically swaps graph data and follows an advanced-mode active-repository sentinel, keeping one MCP process usable after clones and repo changes. | Architecture | Active |
| [AD54](#ad54-vault-directory-must-use-a-non-hidden-basename) | Use a visible Vault directory basename | The vault lives at `/home/user/Vault/` because SilverBullet aborts walks of dot-prefixed roots, and the clean cutover restores file listing without a binary patch. | Storage | Active |
| [AD55](#ad55-codeflare-brands-the-vault-editor-via-preseed-managed-stylesmd) | Manage Vault styling through preseed | Codeflare overwrites Vault `STYLES.md` from preseed on boot, binding SilverBullet theme variables to product tokens at the cost of in-editor theme customization. | Architecture | Active |
| [AD56](#ad56-15-minute-bisync-cadence-with-manual-triggers) | Run bisync every 15 minutes with explicit triggers | The bisync daemon uses a 15-minute cadence plus manual and final-sync triggers, cutting idle R2 operations while accepting wider ungraceful-loss and convergence windows. | Storage | Active |
| [AD57](#ad57-135-second-shutdown-budget-for-final-bisync) | Drain final bisync before container stop | Container teardown awaits an authenticated `/internal/final-sync` drain within 120 seconds and a 135-second hard cap, preserving recent writes before stop when possible. | Storage | Active |
| [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) | Use higher-fidelity, prefiltered memory capture | Memory capture filters raw transcript tool noise, processes bounded chunks, and uses Sonnet-tier synthesis to reduce recency bias and fabricated citations. | Memory | Active |
| [AD59](#ad59-zero-ui-vault-encryption-with-per-session-do-storage-key) | Encrypt Vault browser storage without a passphrase | Each session DO supplies a persisted random key to SilverBullet for encrypted IndexedDB, protecting offline browser profiles while accepting authenticated-page access. | Security | Active |
| [AD60](#ad60-pi-memory-capture-reuses-the-ad58-contract-and-transcript-prefilter) | Reuse the memory-capture contract on Pi | Pi reads durable transcripts through the AD58 prefilter and shared prompt contracts, preserving citation discipline while AD103 bounds extraction to one pass. | Memory | Active |
| [AD61](#ad61-pi-review-ships-as-a-dedicated-native-skill) | Ship review as a native Pi skill | Pi deploys `/review` as a native 11-phase skill with report-only agents and root-owned persistence, because Claude slash commands do not transform into Pi workflows. | Architecture | Active |
| [AD62](#ad62-pi-model-name-genericization-with-codeflare_memory_model-lever) | Select Pi memory models through a generic lever | Pi uses optional `CODEFLARE_MEMORY_MODEL` for capture and extraction requests, avoiding vendor model literals while defaulting to the session model. | Architecture | Active |
| [AD63](#ad63-pi-safe-graphify-updatesh-is-a-thin-bounded-upstream-update-wrapper) | Bound Graphify updates without forking output | Pi wraps upstream `graphify update` with memory and worker limits, leaving graph generation to Graphify so constrained containers avoid OOM without semantic drift. | Architecture | Active |
| ~~[AD64](#ad64-durable-review-lanes-load-extensions-additively-behind-the-noextensions-shield)~~ | ~~Move review lanes out of the additive extension model~~ | Detached review processes in [AD76](#ad76-durable-review-lanes-run-as-detached-headless-pi-processes) replaced in-process lanes and their `noExtensions` additive allowlist. | Architecture | Superseded |
| [AD65](#ad65-gemini-cli-replaced-by-antigravity-agy) | Install Antigravity as the Google coding agent | The curl-installed `agy` replacement remains outside npm and V8 warm-up, while [AD67](#ad67-antigravity-reads-the-gemini-cli-config-tree-preseed-lane-restored) restored its preseed lane. | Architecture | Partially superseded |
| [AD66](#ad66-security-sensitive-rate-limiters-fail-closed-on-kv-outage) | Fail security-sensitive rate limiters closed | Security-sensitive KV-backed limiters return 429 on store failure, accepting endpoint unavailability rather than multiplying abuse allowance across Worker isolates. | Security | Active |
| [AD67](#ad67-antigravity-reads-the-gemini-cli-config-tree-preseed-lane-restored) | Restore Antigravity's Gemini-compatible preseed lane | The seed generator writes rules, skills, and agents into Antigravity's home-scoped `.gemini` tree, replacing stale R2 artifacts with generated configuration. | Architecture | Active |
| [AD68](#ad68-service-token-admin-bypass-must-be-environment-gated-and-hostname-restricted) | Constrain the service-token admin bypass | The `X-Service-Auth` bypass requires stress-test mode, rejects SaaS mode, and restricts test hostnames so a misplaced secret cannot mint production admins. | Security | Active |
| [AD69](#ad69-silverbullet-vault-runs-its-native-service-worker-for-persistent-encrypted-client-indexing) | Run SilverBullet's grafted native service worker | The Vault serves SilverBullet's native worker with key-recovery grafts, preserving encrypted `sb_files_*` storage so cold loads sync incrementally instead of reindexing. | Architecture | Active |
| [AD70](#ad70-container-exit-writes-kv-stopped-no-read-side-reconciliation) | Make persisted session status authoritative | Container exit paths write KV `stopped` and the dashboard removes heartbeat-age reconciliation, preventing both dangling sessions and false live-session kicks. | Architecture | Active |
| [AD71](#ad71-preseed-corpus-statically-imported-into-the-worker-bundle-bound-by-compressed-bundle-size-ci-guarded) | Bundle the preseed corpus with a compressed-size guard | The Worker statically imports the agent preseed corpus while CI guards compressed bundle size, retaining a simple synchronous seed path until headroom shrinks. | Architecture | Active |
| [AD72](#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing) | Intercept enterprise LLM traffic at container egress | A WorkerEntrypoint intercepts provider HTTPS and forwards with Worker-held AI Gateway credentials, keeping secrets out of containers and avoiding a public proxy route. | Architecture, Security | Active |
| [AD73](#ad73-workersdev-enabled-on-every-deployment-for-setup-wizard-bootstrap) | Keep workers.dev enabled as the bootstrap host | Every deployment exposes its `workers.dev` URL so fresh accounts can run setup before a custom domain exists, with operators responsible for post-setup Access protection. | Security | Active |
| [AD74](#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api) | Route enterprise LLM calls through AI Gateway APIs | The LLM interceptor uses REST first with a 404 compat replay and catalog-driven routes, preserving streaming while covering providers absent from the REST surface. | Architecture, Security | Active |
| [AD75](#ad75-pi-graphify-tools-replaced-by-a-first-party-native-extension) | Replace Pi's Graphify wrapper with a native extension | Pi registers first-party Graphify tools that call the same CLI engine as Claude, removing divergent query behavior and two npm dependencies. | Architecture | Active |
| ~~[AD76](#ad76-durable-review-lanes-run-as-detached-headless-pi-processes)~~ | ~~Replace detached review lanes with visible agents~~ | Visible session-scoped agents in [AD98](#ad98-pi-pr-review-uses-visible-session-scoped-agents) replaced detached headless Pi lanes and their disk-backed recovery machinery. | Agents | Superseded |
| [AD77](#ad77-enterprise-vault-service-worker-reached-via-a-higher-precedence-access-bypass-app) | Bypass Access only for the Vault worker script | Enterprise setup creates a higher-precedence Access bypass for the non-sensitive Vault service-worker path so script fetches reach the Worker without credentials. | Architecture, Security | Active |
| [AD78](#ad78-pr-boundary-review-lanes-run-in-parallel-report-only-reviewers) | Run PR-boundary reviewers in parallel | PR-boundary lanes execute concurrently as report-only reviewers and return findings to the root, while mutation-owning `/sdd clean` remains sequential. | Agents | Active |
| [AD79](#ad79-image-baked-pi-extension-transpile-cache) | Bake Pi's path-correct extension transpile cache | The image warms Jiti at runtime-equivalent paths and verifies managed extension cache entries so first Pi output arrives under the pre-warm cap. | Performance | Active |
| ~~[AD80](#ad80-pi-pr-boundary-merge-gate-is-report-only-and-defended-in-depth)~~ | ~~Remove the durable Pi merge gate~~ | The visible-agent model in [AD98](#ad98-pi-pr-review-uses-visible-session-scoped-agents) replaced the hard pre-merge gate and its retroactive unreviewed-merge audit. | Architecture | Superseded |
| [AD81](#ad81-reuse-the-container-egress-injection-layer-for-per-user-github-tokens) | Inject per-user GitHub tokens at container egress | Enterprise GitHub HTTPS interception replaces the container placeholder with a session-bound Worker token so the real credential never enters the container. | Architecture, Security | Active |
| [AD82](#ad82-visible-terminal-panes-own-websockets-and-multiview-is-virtual) | Let visible terminal panes own WebSockets | The frontend mounts terminal sockets only for visible panes and models MultiView as a local composition, preventing hidden sessions from reconnecting or resizing PTYs. | Architecture, UI/Frontend | Active |
| ~~[AD83](#ad83-vault-indexeddb-cannot-be-persisted-across-sessions-by-keying-the-encryption-key-to-the-r2-bucket)~~ | ~~Persist Vault IndexedDB with a bucket-stable identity~~ | [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key) replaced the rejection with a bucket-stable URL and HKDF key, enabling cross-session IndexedDB reuse. | Architecture | Superseded |
| [AD84](#ad84-retain-the-vault-sw-encryption-key-in-memory-neuter-the-proactive-flush-and-open-a-green-vault-button-directly) | Retain the Vault worker key and open ready Vaults directly | The grafted Vault worker keeps its AES key until natural termination, and a green Vault control opens through the bootstrap hop without redundant readiness checks. | Architecture | Active |
| [AD85](#ad85-controller-mediated-cloudflare-gateway-egress-as-a-mandatory-web-boundary-wizard-toggled-default-off) | Offer strict Gateway egress as a default-off boundary | An enterprise wizard toggle wires a fail-closed catch-all egress controller through the Workers VPC binding, applying customer Gateway policy to container web traffic. | Architecture, Security | Active |
| [AD86](#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network) | Exempt own-account platform traffic from strict egress | Own-account platform traffic bypasses Gateway only after account-scoped matching, while EgressController preserves fail-closed direct-internet routing. | Architecture, Security | Active |
| [AD87](#ad87-egresscontroller-re-signs-own-account-r2-container-holds-a-placeholder-key-bridges-websocket-upgrades-and-resolves-strict-via-props) | Re-sign R2 and bridge WebSockets at the egress controller | R2 re-signing, WebSocket bridging, and props-based strict state remain; [AD143](#ad143-strict-r2-interception-signs-only-with-the-bound-users-scoped-credential) replaces deployment-wide signer authority. | Architecture, Security | Partially superseded |
| [AD88](#ad88-bisync-compares-via-server-modtime-from-fast-list-not-per-object-mtime-heads) | Compare bisync state with server modification times | Both bisync paths use `--use-server-modtime` with fast listings and 64 checkers, eliminating per-object HEAD storms while accepting R2 upload time as the conflict key. | Storage | Active |
| [AD89](#ad89-governed-mode-deployment-wide-r2-sse-c-disable-via-a-kv-toggle-with-lossless-in-place-re-encrypt-migration) | Governed Mode controls deployment-wide R2 SSE-C policy | The enterprise-only KV toggle controls R2 SSE-C policy, separating deployment-wide encryption mode from the verified migration state machine. | Architecture, Security, Storage | Active |
| [AD90](#ad90-governed-mode-preseed-bake--checksum-delta-initial-sync) | Bake Governed Mode seed files for checksum delta sync | Governed Mode lays an image-baked agent seed down before checksum-based R2 sync, avoiding full seed downloads while preserving user deltas. | Storage | Active |
| [AD91](#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile) | Run R2 regime migration as a verified chunked state machine | The R2 regime driver uses leased chunks, REPLACE self-copies, writer gates, verification, and dual-regime reads so policy flips remain resumable and readable. | Storage | Active |
| [AD92](#ad92-bundle-the-official-cloudflare-skills-into-the-advanced-seed-slimmed-references-webfetch-retrieval) | Seed slim official Cloudflare skills in advanced mode | The advanced agent seed bundles 11 official skills and two commands but omits bulky references and MCP configuration to stay within Worker limits. | Agents | Active |
| [AD93](#ad93-refresh-the-non-enterprise-cloudflare-oauth-token-at-the-apicloudflarecom-boundary-reusing-the-browser-interceptor) | Refresh Cloudflare OAuth tokens at the API egress boundary | The container interceptor replaces an OAuth placeholder with a fresh token on each api.cloudflare.com request, keeping real tokens out of live containers. | Architecture, Security | Active |
| [AD94](#ad94-content-hash-manifest-for-vault-extract-change-detection-mtime-is-reset-by-the-r2-restore) | Track Vault extraction changes with a SHA-256 manifest | Vault extraction compares persisted path-to-SHA-256 entries instead of restored mtimes, preventing unchanged notes from being reprocessed after restart. | Storage | Active |
| [AD95](#ad95-browser-ide-is-session-isolated-the-deliberate-opposite-of-the-bucket-stable-vault) | Keep Browser IDE runtime state session-isolated | The Browser IDE stays on a session-keyed route with ephemeral live state, preventing one session's workspace and editor state from bleeding into another. | Architecture, Security | Active |
| [AD96](#ad96-deactivate-codexcopilot-v8-warm-up-and-opencode-db-pre-init-image-size) | Disable low-value CLI warm-ups to shrink the image | The Dockerfile skips Codex and Copilot V8 warming plus OpenCode database pre-init, saving about 147 MB while shifting cost to first launch. | Build / Container | Active |
| ~~[AD97](#ad97-keep-openvscode-upstream-clean-and-accept-known-vulnerability-risk)~~ | ~~Retire the OpenVSCode vulnerability-risk acceptance~~ | [AD119](#ad119-replace-openvscode-with-pinned-code-server-behind-the-existing-session-proxy) replaces the pinned OpenVSCode runtime, removing the accepted upstream vulnerability posture and its scanner suppressions. | Security, Build / Container | Superseded |
| [AD98](#ad98-pi-pr-review-uses-visible-session-scoped-agents) | Run Pi PR review through visible session-scoped agents | Pi launches parallel report-only reviewers as public session agents and acknowledges an exact PR head only after root-published triage, avoiding a second durable lane system. | Agents | Active |
| [AD99](#ad99-pi-ci-monitoring-uses-one-attached-native-background-subagent) | Monitor Pi CI with one attached native subagent | A single resolver launches one public ci-monitor for the authoritative PR head, making CI independent of review and preventing duplicate detached monitors. | Agents | Active |
| [AD100](#ad100-pin-the-upstream-rpiv-todo-session-isolation-fix) | Use upstream rpiv-todo 2.0.0 session isolation | The Pi seed pins rpiv-todo 2.0.0's session-keyed store and removes the temporary source override, so child lifecycle events cannot erase foreground tasks. | Agents | Active |
| [AD101](#ad101-context-mode-is-foreground-owned-in-pi-in-process-subagents-use-native-transports) | Give the foreground Pi session sole context-mode ownership | A managed process-global claim gives the root Pi session the only context-mode bridge, while in-process subagents use native or Bash transports to prevent helper leaks. | Agents, Architecture | Active |
| [AD102](#ad102-pi-extraction-delivery-is-root-owned-visible-and-transactional) | Make Pi extraction root-owned and transactional | The root Pi session launches visible request-scoped extraction jobs and advances memory or Vault state only after validated artifacts and graph publication succeed. | Agents, Architecture | Active |
| [AD103](#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs) | Bound Pi extraction to medium reasoning and one-pass inputs | Pi memory and Vault workers receive frozen inputs, Bash-only tools, medium reasoning, and four turns, bounding cost while preserving transactional graph publication. | Agents, Memory, Performance | Active |
| ~~[AD104](#ad104-terminal-viewport-ownership-is-mode-based-xterm-owns-manual-scrollback-trimming)~~ | ~~Retire xterm-owned trimming during manual scrollback~~ | [AD105](#ad105-streamed-output-defers-while-the-user-reads-scrollback-keyboard-open-swipes-are-always-terminal-input) retains mode ownership but replaces reader trimming and keyboard-open wheel routing after both failed in the field. | Architecture, Mobile | Superseded |
| [AD105](#ad105-streamed-output-defers-while-the-user-reads-scrollback-keyboard-open-swipes-are-always-terminal-input) | Defer terminal output while users read scrollback | The terminal freezes normal-buffer writes during manual scrollback and routes navigation through buffer state, preventing trims and DOM drift from yanking the viewport. | Architecture, Mobile | Active |
| [AD106](#ad106-sdd-enforcement-policy-is-one-canonical-cross-agent-contract-with-per-ac-manual-verification) | Use one cross-agent SDD enforcement contract | Claude's canonical enforcement skills are transformed for Pi, and per-AC manual markers replace REQ-wide exemptions so both runtimes apply the same checks. | Process, Agents | Active |
| ~~[AD107](#ad107-context-mode-is-opt-in-in-pi-pending-upstream-memory-safety)~~ | ~~Keep context-mode opt-in for Pi sessions~~ | [AD138](#ad138-context-mode-is-on-by-default-in-pi) replaced opt-in with enabled startup before [AD140](#ad140-pi-starts-context-mode-off-and-exposes-optional-tool-schemas-on-demand) restored opt-in while retaining the managed single-owner adapter. | Agents, Architecture, Reliability | Superseded |
| [AD108](#ad108-per-ac-test-evidence-permits-multiple-resolving-anchors) | Permit multiple resolving test anchors per acceptance criterion | The SDD parser validates every comment-bounded `@test` anchor independently, allowing distributed behavioral evidence without splitting a coherent acceptance criterion. | Process, Agents, Testing | Active |
| [AD109](#ad109-context-mode-mcp-registration-is-universal-and-entrypoint-owned) | Make entrypoint the sole Claude context-mode registrar | Container entrypoint always writes Claude's context-mode MCP registration, preventing tier-specific plugin metadata from creating duplicate servers. | Agents, Architecture | Active |
| [AD110](#ad110-terminal-scrolling-is-buffer-authoritative-on-every-route-held-output-ring-drops) | Make terminal scrolling buffer-authoritative on every route | Wheel, input, refit, and bottom-anchor paths use terminal buffer state, while held output drops oldest chunks at its cap so no write path can move a reader. | Architecture | Active |
| [AD111](#ad111-synchronized-output-frames-are-delivered-atomically-at-the-write-boundary) | Deliver synchronized terminal frames as atomic writes | A per-terminal assembler emits each DEC 2026 synchronized frame in one write, preventing xterm's timeout from painting partial transcript rebuilds. | Architecture, Reliability | Active |
| [AD112](#ad112-ci-runs-as-parallel-path-filtered-lanes-and-deploys-reuse-content-addressed-container-images) | Parallelize CI lanes and reuse verified container images | Path-filtered PR lanes run in parallel while deployment alone builds or reuses provenance-verified content-addressed images, reducing checks without weakening evidence. | Architecture, Operations | Active |
| ~~[AD113](#ad113-one-owned-browser-ide-extension-uses-pi-rpc-and-a-claude-pty)~~ | ~~Retire the owned dual-agent Browser IDE extension~~ | [AD114](#ad114-native-pi-chat-and-the-official-claude-extension-own-editor-integration) replaces the custom Pi RPC and Claude PTY sidebar with editor-native integrations that can access editor context. | Architecture, Security | Superseded |
| [AD114](#ad114-native-pi-chat-and-the-official-claude-extension-own-editor-integration) | Use native Pi Chat and the official Claude IDE extension | Native Pi and official Claude integrations retain panel, provider, runtime, and settings ownership, while [AD127](#ad127-native-inline-chat-uses-proposal-only-pi-turns-and-host-owned-text-edits) replaces Pi Inline execution. | Architecture, Security, Supply Chain | Partially superseded |
| [AD115](#ad115-claude-pr-boundary-review-lanes-run-as-headless-claude--p-subprocesses) | Run Claude review lanes as bounded headless subprocesses | Each review lane runs `claude -p` with isolated settings, its own model and effort, Bash-only tools, and validated guards to remove inherited prompt overhead. | Architecture, Cost | Active |
| [AD116](#ad116-review-lane-phase-0-is-computed-deterministically-and-handed-to-the-lane) | Precompute review-lane Phase 0 deterministically | The lane launcher computes SDD triage before model invocation and passes authoritative results in the opening prompt, eliminating repeated discovery turns. | Architecture, Cost | Active |
| [AD117](#ad117-review-lane-cost-is-governed-by-turn-count-so-evidence-gathering-is-structured-in-waves) | Gather review evidence in structured waves | Review lanes derive available evidence first and batch only named gaps into a second call, reducing quadratic turn cost without imposing a completeness cap. | Architecture, Cost | Active |
| [AD118](#ad118-seed-provenance-is-carried-in-r2-custom-metadata-verified-before-it-was-relied-on) | Mark seeded R2 objects with verified provenance metadata | Seed writes stamp a build hash in R2 custom metadata, so cleanup deletes retired files only with positive product-ownership evidence and preserves user replacements. | Storage, Agents | Active |
| [AD119](#ad119-replace-openvscode-with-pinned-code-server-behind-the-existing-session-proxy) | Run pinned code-server behind the session proxy | The Browser IDE uses a checksum-verified unmodified code-server release on loopback while preserving authenticated session routes, fixed inventories, and lazy lifecycle. | Architecture, Security, Build / Container | Active |
| [AD120](#ad120-browser-ide-uses-fixed-public-workspace-selection-and-exported-ui-state-continuity) | Fix Browser IDE workspace selection and export safe UI state | The host rejects public workspace selectors and projects `/home/user/workspace`, while a bounded allowlist persists only safe UI preferences across sessions. | Architecture, Security, Storage, Build / Container | Active |
| ~~[AD121](#ad121-a-review-boundary-is-a-delivery-subcommand-not-any-git-invocation)~~ | ~~Anchor review coverage on delivery subcommands~~ | [AD142](#ad142-review-ingress-is-delivery-only-and-completion-is-joint) replaces broad Git/GitHub candidacy and merge delivery with automatic push/PR-create ingress plus clone-only consent. | Architecture, Build / Container | Superseded |
| [AD122](#ad122-the-ci-monitor-observes-and-reports-it-does-not-cancel-runs-or-chase-the-remote) | Keep the CI monitor observational | The CI monitor reports GitHub's terminal result with its head SHA and leaves cancellation to workflow concurrency, avoiding ambiguous branch-based remote control. | Architecture, Build / Container | Active |
| [AD123](#ad123-the-claude-fix-directive-owns-delivery-pi-leaves-it-to-standing-rules) | Let Claude's FIX directive own conditional delivery | Claude's FIX directive commits, handles any terminal CI result, and then pushes, while Pi keeps standing-rule delivery because its follow-up has different precedence. | Architecture, Cost | Active |
| [AD124](#ad124-bounded-re-delivery-replaces-the-memory-capture-hard-block) | Redeliver memory capture requests within a fixed bound | Claude persists and reissues a capture request up to six times instead of blocking tools, preventing review-gate deadlocks while retrying failed publication. | Architecture, Cost, Agents | Active |
| [AD125](#ad125-bounded-automatic-resync-after-exhausted-recovery) | Rebuild bisync baseline after bounded recovery fails | The sync daemon tries resilient recovery and vanished-file repair before rebuilding its baseline after three failures, restoring persistence with bounded deletion risk. | Storage | Active |
| [AD126](#ad126-vault-browser-realm-scripts-are-authored-source-never-serialized-worker-functions) | Author Vault browser-realm scripts as explicit source | Vault bootstrap scripts cross the Worker-to-browser boundary as self-contained source with JSON-encoded inputs, avoiding bundler helpers leaked by function serialization. | Architecture, Security, Storage | Active |
| [AD127](#ad127-native-inline-chat-uses-proposal-only-pi-turns-and-host-owned-text-edits) | Use proposal-only Pi turns for native Inline edits | Host-validated text edits remain active; [AD128](#ad128-inline-review-lifecycle-belongs-to-the-pinned-controller) replaces review ownership and [AD135](#ad135-inline-chat-requires-one-host-correlated-result) replaces the edit-only model envelope. | Architecture, Security | Partially superseded |
| [AD128](#ad128-inline-review-lifecycle-belongs-to-the-pinned-controller) | Give Inline review lifecycle to the pinned controller | Inline Chat binds edits to `request.location2.document` and lets the host controller own Keep, Close, settlement, and navigation, avoiding duplicate extension review UI. | Architecture, Security | Active |
| ~~[AD129](#ad129-proxied-inline-uri-identity-must-be-observed-before-lifecycle-changes)~~ | ~~Retire the exact-URI Inline diagnostics evidence gate~~ | [AD131](#ad131-inline-diagnostics-retain-only-sanitized-resource-identity) replaces exact URI capture after the probe identified the authority mismatch and [AD130](#ad130-the-projected-workspace-uses-the-canonical-browser-authority) corrected it. | Architecture, Operations | Superseded |
| [AD130](#ad130-the-projected-workspace-uses-the-canonical-browser-authority) | Project the workspace with canonical browser authority | The authenticated host uses its validated external authority in the fixed `folderUri`, making renderer and extension-host resources identical for native Inline review. | Architecture, Security | Active |
| [AD131](#ad131-inline-diagnostics-retain-only-sanitized-resource-identity) | Sanitize retained Inline diagnostic identity | Inline diagnostics keep only scheme, stripped authority, basename, and input type, preserving rollout evidence without retaining paths, queries, fragments, or content. | Architecture, Security, Operations | Active |
| [AD132](#ad132-user-extensions-are-a-bounded-manifest-over-an-immutable-base-inventory) | Persist user extensions as a bounded intent manifest | The Browser IDE restores exact extension intent from one bounded R2-synced manifest over immutable base inventories, avoiding raw extension and credential-state persistence. | Architecture, Security, Storage, Build / Container | Active |
| [AD133](#ad133-adr-indexes-use-bounded-self-contained-summaries) | Give ADR indexes bounded self-contained summaries | ADR indexes pair concise labels with body-supported one-sentence summaries so readers understand choices and state without opening every record. | Process | Active |
| [AD135](#ad135-inline-chat-requires-one-host-correlated-result) | Require one host-correlated Inline result | [AD137](#ad137-inline-chat-is-edit-first-and-responses-support-is-explicit) replaces informational no-change and Chat-only scope; the one-result envelope and host correlation remain active. | Architecture, Security | Partially superseded |
| [AD136](#ad136-managed-environments-reconcile-signed-releases-before-session-start) | Reconcile signed managed-environment releases before session start | The dashboard verifies and applies immutable releases through existing R2 upgrade machinery, avoiding a second container-start materializer and running-session conflicts. | Architecture, Security, Storage, Supply Chain | Active |
| [AD137](#ad137-inline-chat-is-edit-first-and-responses-support-is-explicit) | Make Inline Chat edit-first with explicit Responses support | Editor turns reserve no-change for safe exceptions, force the result tool on recognized OpenAI payloads, and request provider summaries without changing Qwen. | Architecture, Security | Active |
| ~~[AD138](#ad138-context-mode-is-on-by-default-in-pi)~~ | ~~Enable context-mode by default in Pi~~ | [AD140](#ad140-pi-starts-context-mode-off-and-exposes-optional-tool-schemas-on-demand) restores disabled startup after provider-boundary measurement showed default context schemas outweighed prompt compaction. | Agents, Architecture, Reliability | Superseded |
| [AD139](#ad139-pi-skill-discovery-uses-one-compiler-generated-compact-index) | Generate one compact Pi skill index per mode | The seed compiler indexes each mode's model-invocable source skills and suppresses duplicate native catalog entries without removing explicit invocation paths. | Agents, Architecture, Performance | Active |
| [AD140](#ad140-pi-starts-context-mode-off-and-exposes-optional-tool-schemas-on-demand) | Start context-mode off and expose optional Pi tools on demand | Fresh containers keep context-mode installed but disabled, while Pi sends five bootstrap tool schemas and activates registered optional tools through capability only when required. | Agents, Architecture, Performance | Active |
| [AD141](#ad141-browser-ide-startup-follows-the-session-workspace-snapshot) | Start Browser IDE services by immutable session workspace | Terminal sessions retain lazy editor startup and PTY prewarm, while VS Code sessions eagerly warm code-server without a host browser-terminal PTY. | Architecture, Build / Container | Active |
| [AD142](#ad142-review-ingress-is-delivery-only-and-completion-is-joint) | Use delivery-only review ingress with joint completion | Push and PR creation launch automatically, clone alone asks for consent, and acknowledgement waits for reviewer plus exact-head CI triage. | Agents, Architecture, Build / Container | Active |
| [AD143](#ad143-strict-r2-interception-signs-only-with-the-bound-users-scoped-credential) | Keep strict R2 signer authority inside the user's bucket | Strict interception re-signs only the session's exact bucket with its scoped credential and never falls back to deployment-wide R2 authority. | Architecture, Security | Active |
---

## Decisions

### AD1: One container per session

**Category:** Architecture

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** CPU isolation -- each tab gets full 1 vCPU instead of sharing.

Alternative was one container per user with multiplexed PTYs. Per-session containers avoid noisy-neighbor CPU contention between tabs running different agents, and simplify cleanup (destroy container = clean slate).


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD2: Container ID format

**Category:** Architecture

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** `{bucketName}-{sessionId}`

Example: `codeflare-user-example-com-abc12345`. Deterministic from user email + session ID. Enables DO lookup without KV round-trip. `getContainerId()` must NEVER fallback on invalid sessionId -- that was root cause of orphaned containers.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD3: Per-user R2 buckets

**Category:** Architecture

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Bucket name derived from email, auto-created on first login.

Isolation boundary: each user's files live in their own bucket. Simplifies deletion (empty + delete bucket). Bucket name sanitized from email (max 63 chars, S3-compatible). Per-user scoped R2 tokens ([AD13](#ad13-per-user-scoped-r2-tokens)) further restrict access.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD4: Periodic rclone bisync

**Category:** Architecture

**Context:** The original compact ADR did not separate a context field from its decision rationale.
**Status:** Superseded by [AD56](#ad56-15-minute-bisync-cadence-with-manual-triggers) (cadence rationale) and [AD57](#ad57-135-second-shutdown-budget-for-final-bisync) (shutdown budget).

**Decision:** Background daemon every 60s + final sync on shutdown. Superseded cadence rationale: see [AD56](#ad56-15-minute-bisync-cadence-with-manual-triggers) (now 15min). Superseded shutdown budget rationale: see [AD57](#ad57-135-second-shutdown-budget-for-final-bisync) (now an awaited live drain within a 120s budget before stop, 135s DO destroy hard cap; the SIGTERM trap is only a backstop -- see the Revision in AD57).

Local disk for all file operations (fast I/O). Bisync daemon runs in background, syncing changes bidirectionally; manual triggers via SIGUSR1 (storage panel Sync-now button). SIGINT/SIGTERM trap runs final bisync before exit. Alternative (s3fs FUSE) was fragile and slow -- see Lessons Learned #1.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD5: Login shell autostart

**Category:** Architecture

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** `.bashrc` auto-starts the configured agent in workspace.

PTY spawns `bash -l` (login shell). `.bashrc` reads `TAB_CONFIG` env var and launches the configured agent. `MANUAL_TAB=1` env var skips autostart for user-created tabs.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD6: KV read-modify-write races and `collectMetrics` atomicity

**Category:** Architecture

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Last-writer-wins is acceptable for KV state; `collectMetrics` keeps activity, health, and KV updates inside a single `alarm()` callback for natural atomicity.

Session PATCH/stop overlap is rare, rate limit off-by-one is minor, `lastAccessedAt` is best-effort. KV doesn't support atomic read-modify-write. Durable Objects would add latency for negligible consistency gain in this use case.

**Update (2026-08-14, explicit product decision):** concurrent-session admission remains best effort. A start counts KV list metadata before a later write marks its session `running`; simultaneous starts may both pass and exceed the nominal per-user limit until a session stops. This check discourages ordinary overuse but is not a lock or security boundary. Deployment `max_instances` remains the separate hard platform capacity. [Issue #880](https://github.com/nikolanovoselec/codeflare/issues/880) tracks one role-independent Enterprise limit, not atomic admission.

`collectMetrics` KV read-modify-write can revert session status. Mitigated: session status changes are only observed from the Dashboard, not during active terminal use. Sessions are never interrupted while in Terminal view.

**Update (2026-06-02, [AD70](#ad70-container-exit-writes-kv-stopped-no-read-side-reconciliation)):** the specific Dashboard-side revert this note worried about was the read-side `reconcileStaleStatus` heuristic (a separate later addition), which inferred `stopped` from a stale `metrics.updatedAt` heartbeat and could falsely kick a still-live session. That heuristic was removed in [codeflare#153](https://github.com/nikolanovoselec/codeflare/issues/153); KV `status` is now authoritative and written on every container exit, so the Dashboard renders it verbatim with no reconciliation. The remaining `collectMetrics` RMW concern (overlapping writes to the same record) is unchanged and still last-writer-wins.

**`collectMetrics` density** (formerly [AD17](#ad17-merged-into-ad6)): the function performs activity checking, health probing, and KV status updates in a single `alarm()` callback. Splitting into separate alarms would require coordination logic more complex than the current monolithic approach. The `alarm()` context provides natural atomicity across these tightly coupled operations - same theme as the KV race trade-off above (accept the cheap option until evidence forces change).


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD7: Merged into AD10

**Category:** Redirect anchor

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Follow the redirect or supersession recorded by this ADR.

**Status:** Reclassified — merged into [AD10](#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation) on 2026-05-03. Pre-setup public-endpoint risk acceptance is now consolidated under the bootstrap-window ADR alongside the related CSRF trade-off. Inbound `AD7` references in the codebase remain valid; this entry preserves the anchor.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD8: Root container, no internal auth

**Category:** Architecture

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Network isolation via DO proxy is sufficient.

Root needed for rclone mount. Container auth token (random UUID per DO lifecycle) validates all proxied requests. Network boundary: only the DO can reach the container's port 8080. Wildcard CORS inside container is safe -- it's internal-only.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD9: RESSOURCE_TIER spelling

**Category:** Redirect anchor

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Follow the redirect or supersession recorded by this ADR.

**Status:** Reclassified on 2026-05-09. Naming/spelling preserved for backward compatibility is not an architectural decision; documentation lives at [configuration.md "Container Specs"](../lanes/configuration.md#container-specs) with a do-not-rename note. Inbound `AD9` references in the codebase remain valid; this entry preserves the anchor.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD10: Bootstrap window: pre-setup endpoints, CSRF, and Worker-name derivation

**Category:** Security

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** A narrow pre-setup window (seconds to minutes) is the unavoidable shape of a self-hosted bootstrap; auth and CSRF protections are intentionally relaxed during it, mitigated by short exposure, rate limiting, and the `setup:complete` KV flag.

`/api/setup/configure` is public before `setup:complete` is written to KV. This allows the deployer to configure their instance without pre-existing auth infrastructure (Cloudflare Access isn't set up yet - that's what setup configures).

**Trade-off**: A narrow window (seconds to minutes) exists where any actor could claim the deployment. Accepted because the target audience is self-hosted single-user/small-team deployments where the deployer is watching the process.

**Mitigation**: `setup:complete` KV flag prevents re-configuration. Rate limiting applies to setup routes.

**Future**: A one-time bootstrap secret injected at deploy time would close this window entirely.

**Pre-setup public endpoints** (formerly [AD7](#ad7-merged-into-ad10)): the same risk acceptance covers all pre-setup endpoints, not just `/configure`. Setup runs once during initial deploy. Pre-setup auth trusts a spoofable email header - bootstrap problem (can't require CF Access auth when CF Access isn't configured yet). Mitigated by rate limiting and the same short exposure window.

**Pre-setup CSRF** (formerly [AD33](#ad33-merged-into-ad10)): `createConditionalSetupAuth()` calls `next()` directly when setup is not complete, bypassing the `X-Requested-With` CSRF check. The pre-setup CSRF risk is accepted under the same rationale as above: the window is seconds to minutes, the self-hosted audience makes a drive-by CSRF attack from a third-party origin implausible, and the attacker would need to know the exact `workers.dev` URL during its unconfigured window. Adding `Origin` validation to the pre-setup path is a low-cost future hardening that complements the bootstrap-secret idea above.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD11: Suffix-pattern CORS with credentials

**Category:** Security

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** `matchesPattern()` with domain-boundary enforcement.

Default `ALLOWED_ORIGINS` includes `.workers.dev` as a suffix pattern, with `Access-Control-Allow-Credentials: true` on matching responses.

**Trade-off**: Any `*.workers.dev` subdomain passes the CORS check. Accepted because: `matchesPattern()` enforces domain boundaries (`evil-workers.dev` does NOT match), custom domains replace the wildcard, `ALLOWED_ORIGINS` is configurable, and CF Access JWT is the primary auth gate.

**Mitigation**: Setup adds `.workers.dev` suffix and `.{customDomain}` suffix to `setup:allowed_origins` in KV.

**Future**: Restricting credentialed CORS to exact known hosts would tighten the trust surface.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD12: KV-based setup lock (non-atomic)

**Category:** Security

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Read-then-write pattern, acceptable for one-time setup.

Read `setup:complete`, check if false, perform setup, write true. Not atomic -- two simultaneous requests could both proceed.

**Trade-off**: Accepted because setup is a one-time operation by a single admin. Each sub-step (CF API calls) is individually idempotent -- duplicate execution produces the same result. Worst case is redundant API calls, not corrupted state.

**Future**: Moving to a Durable Object would provide strict serialization, deferred until there's evidence of the race occurring.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD13: Per-user scoped R2 tokens

**Category:** Security

**Status:** Partially superseded by [AD143](#ad143-strict-r2-interception-signs-only-with-the-bound-users-scoped-credential) for direct credential delivery under strict interception. Bucket scope, creation, caching, verification, and revocation remain active.

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Each container gets an R2 token scoped to its user's bucket only.

Replaces previous shared credential model. Token lifecycle:

1. **Creation**: `getOrCreateScopedR2Token()` creates token with Object Read+Write policy restricted to user's bucket
2. **Caching**: Token data cached in KV as `r2token:{email}` (encrypted via AES-256-GCM) -- survives container restarts
3. **Verification**: `verifyTokenExists()` validates cached tokens via `GET /tokens/{id}` before use. Only 404 invalidates; transient errors assume valid (prevents API blips from causing rclone 401s)
4. **Delivery**: Passed via `setBucketName` body -> container env vars -> rclone config. [AD143](#ad143-strict-r2-interception-signs-only-with-the-bound-users-scoped-credential) replaces the env/rclone leg with Worker-side props when strict interception is active.
5. **Revocation**: `deleteScopedR2Token()` on user deletion

**Trade-off**: Requires `API Tokens: Edit` permission on deploy token (broader than ideal). Accepted because manual R2 credential management per user is operationally impractical.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD14: Never auto-`--resync` on bisync failure

**Category:** Storage

**Status:** Superseded by [AD125](#ad125-bounded-automatic-resync-after-exhausted-recovery) (2026-08-14)

**Context:** This decision recorded the deletion-safety reason to avoid routine baseline resets. It did not match the daemon's already-existing fallback path and was later contradicted explicitly by [REQ-STOR-003](../../sdd/spec/storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers) AC6.

**Historical decision:** Prefer resilient/recover semantics over automatic baseline reset because `--resync` can resurrect a deletion that has not propagated. Startup baseline establishment remains safe after the one-way restore.

**Consequences:** The deletion-resurrection risk remains current. AD125 narrows the disagreement: ordinary recovery still avoids `--resync`, while bounded baseline re-establishment is accepted only after the tracked failure budget is exhausted or the required listing state is absent.

---

### AD15: TabConfigSchema allows arbitrary command strings

**Category:** UI/Frontend

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** `z.string().max(200)` -- no additional security risk.

Users already have full root shell access inside their own ephemeral container. Restricting tab commands provides no additional security benefit since the container is their sandbox.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD16: entrypoint.sh ~1090 lines complexity

**Category:** Architecture

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Battle-tested, rewrite risk > benefit.

Handles Alpine->Debian migration, PTY pre-warm, rclone sync orchestration, tab autostart, and graceful shutdown. Accumulated complexity reflects real-world edge cases discovered over months of production use. A rewrite risks reintroducing solved bugs for marginal readability gains.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD17: Merged into AD6

**Category:** Redirect anchor

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Follow the redirect or supersession recorded by this ADR.

**Status:** Reclassified — merged into [AD6](#ad6-kv-read-modify-write-races-and-collectmetrics-atomicity) on 2026-05-03. The `collectMetrics` `alarm()`-context atomicity rationale is now part of the consolidated KV-races ADR. Inbound `AD17` references in the codebase remain valid; this entry preserves the anchor.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD18: Vendored creative/WebGL code uses untyped patterns

**Category:** UI/Frontend

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Both isolated WebGL utilities and adapted creative-coding modules use `any` types where upstream TS definitions don't exist; refactoring offers no runtime benefit and risks regressing battle-tested visual code.

**`webgl-utils.ts`**: extensions like `OES_texture_half_float`, `WEBGL_lose_context`, etc. have no official TypeScript definitions. The `any` casts are isolated to this single utility file and the WebGL API surface is stable. Adding custom type definitions would be maintenance burden with no runtime benefit.

**`splash-cursor-logic.ts` `as any` casts** (formerly [AD19](#ad19-merged-into-ad18)): pointer-tracking objects and WebGL shader uniforms in this creative-coding module have no typed definitions upstream. The code is adapted from a visual-effect library; type assertions are confined to this isolated module.

**`splash-cursor-logic.ts` old-style constructor with `any` types** (formerly [AD35](#ad35-merged-into-ad18)): an old-style constructor function with `this: any` causes all downstream pointer/rendering functions to use `any` types - it's the root cause of the casts above. The constructor is adapted from the same visual-effect library. The entire module is isolated, has no production data path, and is invoked once per canvas element (not in a hot loop). Refactoring to a typed factory function would require significant rework of adapted code for marginal benefit.

**Common rationale across all three surfaces**: vendored creative/WebGL code is type-foreign by design. The boundary at the module's import surface is what matters; internal `any` is acceptable when the module is small, isolated, and has no production data path.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD19: Merged into AD18

**Category:** Redirect anchor

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Follow the redirect or supersession recorded by this ADR.

**Status:** Reclassified — merged into [AD18](#ad18-vendored-creativewebgl-code-uses-untyped-patterns) on 2026-05-03. The `splash-cursor-logic.ts` `as any` rationale is now part of the consolidated vendored-creative-code ADR. Inbound `AD19` references in the codebase remain valid; this entry preserves the anchor.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD20: TOCTOU in container/lifecycle.ts

**Category:** Architecture

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Durable Objects are single-threaded per ID -- false positive.

Static analysis flags time-of-check-time-of-use patterns between KV reads and subsequent writes. However, Durable Objects guarantee that `alarm()` and `fetch()` handlers are serialized by the runtime -- no concurrent execution within a single DO instance. The TOCTOU pattern is architecturally impossible here.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD21: Inconsistent function signatures

**Category:** Architecture

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Old helpers use positional args, new ones use options objects.

Legacy helper functions accept positional parameters while newer ones use destructured options objects. Normalizing all signatures risks caller regressions across the codebase. The inconsistency is cosmetic -- both styles are well-typed and documented.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD22: JWKS 30s cache staleness

**Category:** Security

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Industry-standard tradeoff for key rotation.

The 30-second JWKS cache in `jwt.ts` means a rotated key might not be recognized for up to 30s. This is an industry-standard tradeoff -- Cloudflare Access uses key overlap periods during rotation, and shorter cache durations add latency to every JWT verification without meaningful security improvement.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD23: CORS origin pattern validation

**Category:** Redirect anchor

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Follow the redirect or supersession recorded by this ADR.

**Status:** Reclassified on 2026-05-09. Static-analyzer false positive accepted with admin-trust rationale; documented inline at `src/lib/cors-cache.ts` (the `isAllowedOrigin` docstring) and summarized in [security.md "Static-Analyzer False Positives"](../lanes/security.md#static-analyzer-false-positives). Inbound `AD23` references in the codebase remain valid; this entry preserves the anchor.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD24: Predictable session IDs

**Category:** Redirect anchor

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Follow the redirect or supersession recorded by this ADR.

**Status:** Reclassified on 2026-05-09. Static-analyzer false positive (analyzer treats session IDs as auth tokens, but they are KV namespace keys; JWT is the auth gate); documented inline at `src/lib/constants.ts:6` and summarized in [security.md "Session ID Validation"](../lanes/security.md#session-id-validation). Inbound `AD24` references in the codebase remain valid; this entry preserves the anchor.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD25: E2E service email hardcoded

**Category:** Redirect anchor

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Follow the redirect or supersession recorded by this ADR.

**Status:** Reclassified on 2026-05-09. Static-analyzer false positive (test fixture flagged as hardcoded credential); documented inline at `src/lib/access.ts:166` and summarized in [security.md "Static-Analyzer False Positives"](../lanes/security.md#static-analyzer-false-positives). Inbound `AD25` references in the codebase remain valid; this entry preserves the anchor.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD26: Stress test rate-limit bypass (integration-only)

**Category:** Security

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** `STRESS_TEST_MODE=active` skips all rate limiting; the variable is scoped to the GitHub Actions `integration` environment only.

k6 stress tests share a single CF Access service token (single identity), so per-user rate limits (10/min sessions, 5/min containers, 30/min WebSocket) block meaningful load testing above ~5 VUs. Setting `STRESS_TEST_MODE=active` on the integration worker disables all rate-limit KV reads/writes at the top of the middleware, before any I/O. The value must be exactly `"active"` - any other value (including `"true"`) keeps limits enforced.

**Integration-only scoping** (formerly [AD28](#ad28-merged-into-ad26)): no CI-level guard is needed because GitHub Actions environment separation controls it. The variable is only set via the workflow scoped to the `integration` environment. Production deployments use `environment: production` and never receive this variable. A repo admin could theoretically set it for production, but that requires deliberate action - the same trust model that already governs every other production secret.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD27: Server-side prefix delete

**Category:** Storage

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Server-side list+batch delete via R2 S3 API instead of frontend recursive browse+delete.

Frontend folder deletion was subject to API rate limits (30/min browse, 20/min delete), causing failures for large folders. R2 has no native "delete prefix" API, and lifecycle rules (Days=0) take up to 24h. Server-side ListObjectsV2 + batch DeleteObjects (1000 keys/call) using `emptyR2Bucket()` is the fastest approach. No `[[r2_buckets]]` binding needed -- per-user dynamic buckets use account-level S3 credentials directly.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD28: Merged into AD26

**Category:** Redirect anchor

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Follow the redirect or supersession recorded by this ADR.

**Status:** Reclassified — merged into [AD26](#ad26-stress-test-rate-limit-bypass-integration-only) on 2026-05-03. The integration-only environment-scoping rationale is now part of the consolidated `STRESS_TEST_MODE` ADR. Inbound `AD28` references in the codebase remain valid; this entry preserves the anchor.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD29: Container secrets as env vars

**Category:** Security

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Plaintext env vars acceptable for single-tenant containers.

Container DO injects R2 credentials, LLM API keys, and auth tokens as plaintext environment variables. Users already have full terminal access (`env` command). Secrets are: R2 credentials (bucket-scoped), LLM keys (user's own), container auth token (internal DO-to-container). Any process can read via `/proc/self/environ` but containers are single-tenant.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD30: Worker name from Host header

**Category:** Security

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Host header parsing for `.workers.dev` domains during setup only.

Worker name derived from Host header for `.workers.dev` subdomains during first-time setup. Custom domains use `CLOUDFLARE_WORKER_NAME` env var instead. Exposure window: only during setup (minutes), requires CF Access JWT, setup is idempotent. Spoofed Host could theoretically direct to wrong worker name but requires authenticated access and extremely narrow window.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD31: Root container is intentional

**Category:** Redirect anchor

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Follow the redirect or supersession recorded by this ADR.

**Status:** Reclassified on 2026-05-09. Static-analyzer false positive (missing `USER` directive flagged as privilege issue) accepted with network-isolation rationale; documented inline in `Dockerfile` (search `SAST-false-positive`) and summarized in [security.md "Static-Analyzer False Positives"](../lanes/security.md#static-analyzer-false-positives). Inbound `AD31` references in the codebase remain valid; this entry preserves the anchor.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

<a id="ad32-encryption_key-is-optional"></a>
### AD32: ENCRYPTION_KEY is optional

**Category:** Security

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Optional encryption eases onboarding; operators accept plaintext KV storage as trade-off.

When ENCRYPTION_KEY is absent, LLM API keys, GitHub tokens, and Cloudflare API tokens are stored as plaintext JSON in KV with no warning. This is an intentional deployment-complexity trade-off. New deployers can get a running instance without generating and managing an encryption key. The target audience is self-hosted single-user/small-team deployments where the operator and the user are the same person. A startup warning when ENCRYPTION_KEY is absent is a recommended future improvement. Operators who want encryption set ENCRYPTION_KEY.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD33: Merged into AD10

**Category:** Redirect anchor

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Follow the redirect or supersession recorded by this ADR.

**Status:** Reclassified — merged into [AD10](#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation) on 2026-05-03. Pre-setup CSRF risk acceptance is now consolidated under the bootstrap-window ADR. Inbound `AD33` references in the codebase remain valid; this entry preserves the anchor.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD34: WebSocket auth bypass of Hono middleware

**Category:** Security

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** workerd constraint -- WS upgrades cannot use Hono middleware; parallel auth path is manually synchronized.

WebSocket upgrades must be intercepted before the Hono middleware chain (documented workaround for cloudflare/workerd#2319). This creates a parallel auth path replicating authentication, CORS, rate limiting, and subscription-tier gating. The duplication is explicit and documented. Any change to the Hono middleware auth chain must be manually mirrored in the WebSocket handler. SaaS tier gating tests for the parallel path are tracked as a fix item.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD35: Merged into AD18

**Category:** Redirect anchor

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Follow the redirect or supersession recorded by this ADR.

**Status:** Reclassified — merged into [AD18](#ad18-vendored-creativewebgl-code-uses-untyped-patterns) on 2026-05-03. The old-style-constructor `this: any` rationale is now part of the consolidated vendored-creative-code ADR. Inbound `AD35` references in the codebase remain valid; this entry preserves the anchor.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD36: WebSocket Origin check is optional for non-browser clients

**Category:** Security

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** JWT auth is the security gate, not Origin -- CLI tools need originless connections.

The WebSocket upgrade handler in `terminal.ts` only requires the `Origin` header when `Sec-Fetch-Mode` is present (browser heuristic). CLI tools (websocat, wscat) omit `Sec-Fetch-Mode` and are intentionally allowed without Origin. The primary security gate is `authenticateRequest()` which validates JWT/session credentials -- Origin check is defense-in-depth for CSRF protection on browser connections only. An attacker omitting `Sec-Fetch-Mode` still cannot connect without a valid JWT.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD37: KV as billing read cache -- Signal and Sync (CF-015)

**Category:** Billing

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Webhooks signal; `syncSubscriptionState()` fetches latest from Stripe API and writes complete snapshot to KV.

Previous design had 6 webhook handlers incrementally patching KV fields, causing race conditions, silent tier update failures, and wrong emails. "Signal and Sync" pattern: Stripe is source of truth, KV is read cache. `lastSyncedAt` timestamp guard prevents stale overwrites. Concurrent webhooks are idempotent (both fetch same latest state). Price metadata on Stripe Price objects carries tier/mode, eliminating reverse lookups. `getEffectiveTier()` provides read-time enforcement with safe defaults. `past_due` grace period keeps paid tier while `billingPeriodEnd` is in the future.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD38: GitHub OIDC replaces CF Access in SaaS mode

**Category:** Billing

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Status:** Partially superseded by [AD48](#ad48-oauth-state-replaced-by-hmac-signed-stateless-token) (2026-05-09): only the `oauth_state` cookie mechanism was replaced; GitHub OIDC and the session-cookie decision remain active.

**Decision:** CF Access costs $3/user/month beyond 50 users -- GitHub OIDC is free.

When `OAUTH_CLIENT_ID` is configured in SaaS mode, the Worker handles authentication directly via GitHub OAuth with HMAC-SHA256 session cookies. CF Access is bypassed at runtime. OAuth state uses HttpOnly cookies (not KV) to avoid eventual consistency issues. Only verified GitHub emails are accepted. The `codeflare_session` cookie is HttpOnly, Secure, SameSite=Lax with 1-hour TTL. Middleware in `index.ts` auto-refreshes when < 15 minutes remain -- active users stay logged in indefinitely. Expired cookie triggers frontend auto-redirect to `/` for re-authentication.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD39: Max users capacity cap counts paid slots only

**Category:** Billing

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** `countPaidSlots()` excludes free/pending/blocked users from the cap.

The `setup:max_users` KV key limits subscribing users. Free tier users (4h/month, 1 session) use minimal resources and shouldn't block paid customers. `countPaidSlots()` counts admins + users with paid tiers (standard/advanced/max/unlimited) whose billing is active or trialing. Canceled users count until `billingPeriodEnd` expires. Unlimited free users allowed without hitting cap.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD40: Webhook route order (`/public/stripe` before `/public`)

**Category:** Billing

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Hono catch-all ordering is load-bearing.

Hono's `app.route('/public', publicRoutes)` catches all `/public/*` paths. The Stripe webhook at `/public/stripe/webhook` must be mounted first. Future `/public/*` sub-routes must also be mounted before the catch-all.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD41: Custom tier uses contact flow (not self-service checkout)

**Category:** Billing

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Enterprise tier -- "Let's talk" button sends admin email via Resend.

The Custom tier (unlimited compute, 5 sessions, custom SLA) is enterprise-grade. Renamed from "Team" to "Custom" -- `getTierConfig()` auto-migrates legacy `displayName: 'Team'` to `'Custom'` on read. `POST /api/auth/contact-team` (rate-limited 1/hour) sends inquiry email. Button changes to "We'll get in touch" (disabled) after click. No Stripe checkout for Custom tier.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD42: Unauthenticated first setBucketName call (CF-010)

**Category:** Security

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Worker-only access is the effective security boundary -- DO binding is not externally reachable.

The first `/_internal/setBucketName` request is unauthenticated because the container auth token (random UUID per DO lifecycle) is generated after this call. The endpoint is only reachable via the Worker's internal Durable Object binding, not from external callers. For orphaned R2 tokens from failed KV writes, token ID is logged at creation time for manual revocation via CF dashboard. A periodic sweeper is deferred as a future improvement.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD43: Parse-and-exclude vanishing files before escalating to nuke

**Category:** Storage

**Status:** Accepted (date not recorded)

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** When bisync fails with `lstat: no such file or directory`, parse the error output to identify the vanishing file, add it to a session-scoped exclusion filter, and retry - before escalating to `nuke_corrupted_r2_files`.

The race condition is: rclone lists a file at path X, then the file is deleted (by an agent, MCP auth cache cleanup, or any ephemeral write) before rclone can copy it. The file is gone; there is nothing to recover or repair. Nuking R2 objects is the wrong response - it targets corruption (wrong encryption key, size mismatch, bad object metadata), not transience. Retrying the exact same bisync command without excluding the file would hit the same error. The correct response is:

1. Parse `failed to open source object.*no such file` from rclone output.
2. Append `- <path>` to `/tmp/rclone-recovery-filters.txt` (session-scoped, never synced to R2).
3. Clear bisync lock files.
4. Retry the same operation (max 3 attempts per call site).

Non-workspace files are auto-excluded because they are config/cache files that will regenerate. Workspace files (user code) are not auto-excluded - they get a plain retry on the assumption the file reappeared after a save completed. Known ephemeral files (`.claude/mcp-*.json` - MCP auth cache with millisecond lifetime) are statically excluded from `RCLONE_FILTERS_COMMON` to prevent the race from occurring at all.

The recovery applies at both call sites: `establish_bisync_baseline()` (startup) and `bisync_with_r2()` (daemon). The filter file is initialized empty on every container start via `init_recovery_filters()`.

**Amendment (2026-08-25):** The session-scoped filter now lives at `/run/codeflare/sync/recovery-filters.txt`. This preserves the decision while ensuring disposable `/tmp` cleanup cannot disable recovery in a running container. <!-- @impl: entrypoint.sh::init_recovery_filters -->

**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD44: SDD three-mode autonomy with conservative JUDGMENT resolution

**Category:** Architecture

**Status:** Accepted (date not recorded)

**Decision:** Codeflare ships SDD (Spec-Driven Development) as a Pro feature with three autonomy modes (`interactive`, `auto`, `unleashed`), with a universal enforcement layer (`rules/spec-discipline.md`) inlined into every agent's instructions, and conservative JUDGMENT auto-resolution that never overwrites spec intent. The spec-reviewer and doc-updater agents are project-agnostic and detect `sdd/` automatically.

**Context:** A previous SDD workflow shipped as a skill + agent pair, but real-world use on a downstream project revealed several failure modes:

- changes.md grew to 2,517 lines / 159 entries because the spec-reviewer agent treated every commit as a "verification pass" event
- 16 of 91 requirements were marked Deprecated as a graveyard for never-built ideas instead of actual deprecations
- Status fields contained multi-line prose with commit SHAs
- Implementation details (hex codes, CSS class names, function names, file paths, env vars) leaked into REQs in 800+ places
- 35 of 37 Implemented REQs had no test coverage (the spec lied about verification)
- The micro-fix loop produced 485 commits for 5,976 lines of source code
- The doc-updater agent was hardcoded to Codeflare's specific file structure and couldn't help other projects
- Codex users got no agent enforcement (no agent files), Copilot users got no skill loading (skill mechanism is opaque)

**Alternatives considered:**

1. **Single mode** with strict enforcement and no auto-resolution. Rejected: too rigid for users who want walk-away workflows.
2. **Two modes** (interactive + auto). Rejected: users who trust the agent fully need a third mode that handles JUDGMENT calls without escalating; but auto would be unsafe if it auto-resolved JUDGMENT.
3. **Three modes with "code wins" auto-resolution in unleashed**.

Rejected after design review (opus ultrathink): "code wins" overwrites spec intent and turns the spec into a passive description of whatever the code happens to do, defeating "single source of truth".
4. **Per-run change cap** (max 50 fixes per run). Rejected: contradicts the walk-away intent of unleashed mode.
5. **Dry-run gate by default** for /sdd clean. Rejected for unleashed mode: contradicts walk-away. Replaced by PR-based safety net (unleashed creates a new branch + PR; user reviews when they return).

**Rationale:**

- **Three modes** map to three user types: new SDD users (interactive), solo developers in steady-state (auto), trusting power users with PR review habits (unleashed).
- **Conservative JUDGMENT auto-resolution in unleashed**:

doc-vs-spec conflicts mark BOTH sides as `Partial` with `Notes:` (never overwrite intent); oversized REQs shrink in place by extracting implementation prose to docs (never split, since LLMs cannot reliably preserve meaning when splitting); fake-Deprecated REQs move to README "Out of Scope" section (never delete, satisfying the existing "never delete" rule).
- **PR-based safety net** for unleashed mode: walk-away users get reviewable surface (PR description has full audit log), and rollback is "close the PR" - the working branch is never touched.
- **Universal enforcement layer** (`rules/spec-discipline.md`) inlined into every agent's instructions file ensures Codex (no agent files) and Copilot (no skill loading) get the same discipline as Claude.
- **Project-agnostic agent refactor**:

spec-reviewer and doc-updater drop hardcoded Codeflare domain mappings and read `documentation/README.md` to discover the project's actual file structure. Both agents gate on `sdd/` existence - on non-SDD projects (vibe-coding mode) they exit silently and the post-push `git-push-review-reminder` hook also emits no reminder, so `git push` proceeds with zero review agents. `doc-updater` no longer auto-scaffolds `documentation/README.md` on non-SDD projects (previous behavior was too aggressive). Opt-in to the full workflow is binary: run `/sdd init` and all three review agents (code-reviewer, spec-reviewer, doc-updater) fire on every push; don't, and none do.
- **Sequential execution in `/sdd clean`** prevents shared-file races because `/sdd clean` applies fixes inline and docs depend on the just-fixed spec.
- **PR-boundary review differs** because reviewers are report-only and run in parallel; see [AD78](#ad78-pr-boundary-review-lanes-run-in-parallel-report-only-reviewers).
- **2-round commit-cycle limit** with `[sdd-clean]` tag exclusion catches micro-fix spirals without crashing the rescue command itself.
- **`enforce_tdd` rule**

(renamed from `auto_demote`, default `true`): spec-reviewer auto-demotes `Implemented` REQs without test coverage to `Partial`, detects `Planned`/`Partial` REQs whose source code exists but has no corresponding test (code-without-test finding), and runs test-quality heuristics (AC-count vs test-count ratio, tautology detection, skipped-test detection) on every push. Forced `true` in unleashed mode where the PR review is the safety net.
- **Plan Mode mandate**:

`/sdd init`, `/sdd edit`, and `/sdd add` emit `EnterPlanMode` directives so spec-to-code transitions always go through Plan Mode (a built-in Claude Code primitive). The `/plan` custom slash command is removed - Plan Mode replaces it.
- **Template scaffolding** in `references/templates/` lets `/sdd init` bootstrap any project with no external dependencies.

**Trade-offs accepted:**

- The PR-based safety net adds friction for users who want true zero-touch (the PR has to be merged manually). Acceptable trade-off for the rollback story.
- The forbidden-content allowlist requires per-project tuning for projects that legitimately use vendor names, protocol names, or HTTP status codes in their REQs. Configurable via `sdd/config.yml`.

**Related requirements:**

- [REQ-AGENT-005](../../sdd/spec/agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers) (Pro mode preseed inventory)
- [REQ-AGENT-006](../../sdd/spec/agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth) (preseed bundle generation)
- [REQ-AGENT-007](../../sdd/spec/agents.md#req-agent-007-multi-agent-adaptation-pipeline) (per-agent adaptation pipeline)
- [REQ-AGENT-014](../../sdd/spec/agents.md#req-agent-014-manifest-driven-preseed-pipeline) (manifest as single source of truth)
- [REQ-AGENT-021](../../sdd/spec/agents.md#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability) (SDD workflow as Pro feature) - added in this overhaul

**Implementation references:**

- `preseed/agents/claude/rules/spec-discipline.md` (universal enforcement layer)
- `preseed/agents/claude/skills/spec-driven-development/SKILL.md` (workflow + modes documentation)
- `preseed/agents/claude/skills/spec-driven-development/references/templates/` (scaffolding templates for /sdd init)
- `preseed/agents/claude/agents/spec-reviewer.md` (project-agnostic spec-reviewer agent)
- `preseed/agents/claude/agents/doc-updater.md` (project-agnostic doc-updater agent)
- `preseed/agents/claude/commands/sdd.md` (sub-command dispatcher with help screen)


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD45: User overrides recorded as ADRs, not skip-list

**Category:** Superseded

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Decision:** Follow the redirect or supersession recorded by this ADR.

**Status:** Superseded by [AD51](#ad51-rip-out-six-overengineered-sdd-framework-features) (2026-05-12). The override-via-ADR mechanism was ripped out alongside five other overengineered SDD features. There is now no per-rule override mechanism at all -- if a finding keeps re-firing, fix the rule or the REQ. Body removed on trim-to-tombstone; this anchor is retained for inbound references. See [AD51](#ad51-rip-out-six-overengineered-sdd-framework-features) for the rip-out rationale.


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD46: `/review` Reality Filter as Phase 5

**Category:** Architecture

**Status:** Accepted (2026-05-05)

**Context:** Empirical data from 5 successive `/review` cycles on the `ai-news-digest` codebase showed that finding count does not decrease as the codebase improves: cycle 4 fixed 67 real issues; cycle 5 still produced 71 active findings of which only 10 were real. Repeat-offender churn (`processOneChunk too long` flagged 3 cycles, `Date.now() lacks Clock seam` flagged 4 cycles), aspirational-rule clusters (15 `?raw` text-match files persisting after the rule was added), and severity inflation (HIGH used as the agent's internal scale, not user-impact) accounted for ~85% of cycle 5's noise. Triage cost was ~45 minutes for findings that should have taken 5 minutes.

The pipeline's only memory was Phase 4's AD filter, which only catches findings that have an explicit ADR justifying the exact pattern - too narrow to absorb the long tail of "decided not to fix" calls.

**Decision:** Insert a new Phase 5 (Reality Filter) between Phase 4 (AD filtering) and the LLM verification + interactive triage phases. Phase 5 is a single Task agent that reads the AD-active findings, prior triage history (`sdd/.review-decisions.md`), full ADR bodies, MCP memory, recent git log, and `sdd/changes.md`, and re-evaluates every finding against five questions:

- **Q1** repeat-offender drop (location+category match in `.review-decisions` with no commits since)
- **Q2** memory-says-no drop (contradicts an MCP feedback memory)
- **Q3** cluster aggregation (≥3 same-category findings collapse into ONE cluster finding triaged once)
- **Q4** user-impact bar (re-evaluate severity against data-loss / money / access / security / CI-break - below-bar findings demote to a "Tech-Debt Surfaced" section, still triaged)
- **Q5** spec-vs-shipped truth-test (doc-drift findings must be verified by reading cited source)

Phase 5 produces a single output file `09-real-findings.md` with three sections: Real Findings, Tech-Debt Surfaced, and an Auto-Filtered audit log. The audit log is mandatory - every drop has a one-line reason keyed by which question dropped it. The orchestrator early-stops if Real + Tech-Debt totals are zero.

A new persistent file `sdd/.review-decisions.md` is committed to the repo and append-written by Phase 8 with every Defer/Ignore/Tech-Debt decision. Cluster-finding triage decisions expand to one entry per location at write time so Q1's per-location lookup remains a literal-string match in cycle N+1. The file is the **primary** source of triage history; the local-only `/home/user/Temporary/Review/` corpus is no longer load-bearing.

**Alternatives considered:**

1. **Inject memory into the 6 Phase 2 reviewers.**

Rejected as the v1 approach: bigger blast radius (modifies 6 agent prompts), harder to measure, doesn't address repeat-offender churn or aspirational-rule clusters. Phase 5 is the incremental win; memory injection is a possible follow-up if Phase 5 doesn't shrink output enough.
2. **Extend Phase 4 AD filter to also drop findings whose REQ-X-NNN backlinks have a recent triage decision.**

Rejected: AD filter's job is categorical ("this pattern is intentional"), not per-finding instance triage. Conflating the two muddies both filters and makes future debugging harder.
3. **Tighten the 6 reviewer agents' severity rubrics so they produce fewer findings.**

Rejected: agents have an implicit incentive to produce findings (zero findings reads as "didn't try").

Tightening the rubric is a reasonable follow-up but doesn't solve the stateful-memory problem - cycle N still has no memory of cycle N-1's decisions. Phase 5 solves both.
4. **Write triage decisions into the existing `sdd/.review-needed.md`.** Rejected: `.review-needed.md` is for findings escalated for human review (cleared on resolution) - mixing it with permanent triage history blurs the file's purpose and breaks the "cleared on resolution" semantics.
5. **Promote durable `.review-decisions` patterns to ADRs automatically after N cycles.** Rejected: turns ADRs into "anything I deferred 3 times" instead of intentional design choices. User manually promotes when a pattern proves durable; the manual step preserves the architectural-decision concept.

**Rationale:**

- The proposal is empirically grounded:

a hand-run of the Phase 5 prompt on cycle-5 data filtered 71 active findings to 10 real findings (14% pass rate) - the 4 source-bug fixes that actually mattered all survived. The fixture is publicly available at `https://gist.github.com/nikolanovoselec/060f6d3cbebe889864360835ee375a41` for regression testing.
- ADR vs `.review-decisions` is a clean lane separation:

ADRs document permanent design choices (categorical, by rule, via `Overrides:` headers); `.review-decisions` records per-cycle, per-finding triage history (instance-level, by location+category). The two are complementary, not alternatives. Combining both as filter inputs is what makes 71 → 10 achievable.
- Single-file output (`09-real-findings.md` with three sections) keeps the cycle self-contained for debugging. The audit log lives next to the surviving findings so spot-checking a drop is one read, not two.
- Phase 5 is a single Task agent, mirroring the existing single-agent shape of Phases 3, 4, 6, 8, 9. No new architectural pattern.
- MCP knowledge graph is the primary memory system; `code-reviewer`'s tool allowlist is extended with `mcp__memory__search_nodes` and `mcp__memory__open_nodes` so the Reality Filter agent can query it directly.
- File-based `~/.claude/projects/.../memory/MEMORY.md` is a fallback when MCP is unreachable.
- Q3's cluster-aggregation threshold of 3 is the smallest "this is a pattern, not individual issues" count.

Below 3 the user fixes the violations one by one; at 3+ the user wants a sweep PR. This replaces an earlier proposal of a magic ≥5 threshold with binary drop-to-appendix - the magic number was unjustified and the appendix had no sunset, so aspirational rules would stay quarantined forever.

**Trade-offs accepted:**

- Phase 5 adds one Task agent per `/review` invocation.

On the cycle-5 fixture the agent ran in ~7 minutes and consumed ~150K tokens with ~47 file reads. Treated as "a 7th reviewer that synthesizes the other 6," the per-cycle cost increase is ~17%; the saving on triage time is ~40 minutes per cycle. Net positive after the first cycle.
- File renames are not tracked (literal path matching in Q1).

Renames are rare; if one happens, the prior decision will not match and the finding gets surfaced fresh. The audit log makes this visible and the user can re-defer if appropriate. `git log --follow` was considered and rejected as overengineering for a rare event.
- The 3-cycle expectation (active CRITICAL/HIGH/MEDIUM trends to zero by the third successive run) is informational only - shown in the Phase 5 Cycle Health header.

It is not a hard gate; cycle 3 with non-zero CRITICAL/HIGH/MEDIUM still completes normally. The user uses the metric to decide whether the filter needs re-tuning or new code is genuinely introducing real bugs faster than they get fixed.
- Phase numbering shifts:

old phases 5-9 become 6-10. File numbering shifts: old `08-active-findings.md` stays as Phase 4's output, new `09-real-findings.md` is Phase 5, LLM-verified is `10-llm-verified.md`, triage is `11-triage-results.md`. One-time documentation churn; the new numbering is monotonic and each phase produces exactly one output number.

**Migration:**

- Existing projects with prior `/review` runs do not auto-migrate the local `/home/user/Temporary/Review/2026*/09-triage-results.md` corpus into `sdd/.review-decisions.md`.

First run in the new pipeline starts the persistent log fresh; cycle 1 will produce no Q1 drops. The user can backfill manually if desired by hand-converting the most relevant prior decisions.
- The Reality Filter agent uses the `code-reviewer` subagent type with extended MCP memory tools. No new agent type is introduced.
- `/review` Phase 5 is mandatory; the orchestrator-level "Active = 0 → STOP" gate moves from Phase 4's tail to Phase 5's tail (so the cycle counter and audit log are always written, even on clean cycles).

**Related requirements:**

- [REQ-AGENT-015](../../sdd/spec/agents.md#req-agent-015-review-command-for-multi-perspective-codebase-review) (`/review` command for multi-perspective codebase review) - AC1 and AC5 updated to reflect the Reality Filter pass and persistent `.review-decisions.md`.

**Implementation references:**

- `preseed/agents/claude/commands/review.md` (Phase 5 Reality Filter)
- `preseed/agents/claude/agents/code-reviewer.md` (MCP memory tools added to allowlist)
- `preseed/agents/claude/rules/spec-discipline.md` (`sdd/.review-decisions.md` added to "Files alongside sdd/")
- `preseed/agents/claude/skills/spec-driven-development/SKILL.md` (spec structure diagram)

**Issue:** [codeflare#271](https://github.com/nikolanovoselec/codeflare/issues/271)


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD47: PTY keepalive as safety net only, not the idle policy

**Category:** Architecture

**Status:** Accepted (2026-05-09)

**Context:** The host process inside each container ran a per-PTY reaper at `PTY_KEEPALIVE_MS = 2700000` (45 min). When a session's WebSocket clients all disconnected (dashboard navigation 60s grace, backgrounded mobile tab dropping WS, network blip, laptop sleep), `Session.detach()` armed a 45-min `setTimeout`; on expiry the PTY was SIGTERMed, killing the `bash -l` and the child `claude` process. On reconnect, `Session.start()` re-spawned `bash -l` which re-launched `claude` from `.bashrc` (a fresh process with empty in-memory state, forcing the user to `/resume` from the on-disk JSONL transcript). Users with `sleepAfter` set to 2h experienced what felt like "Claude Code restarted" after roughly an hour of idle, even though the container itself was nowhere near the configured timeout.

The reaper was unspec'd (no REQ, no prior ADR), introduced at initial release and never tuned.

The original justification considered was per-PTY RAM cleanup when one tab in a multi-tab session went idle while sibling tabs kept the container hot. That premise does not hold in codeflare: each tab is its own session with its own container DO and its own `lastInputAt`, so there is no "sibling tabs keep container alive while orphan PTY hoards RAM" case. Per-tab orphaning cannot occur because the container's `collectMetrics` reaches its idle threshold whenever no input is happening; at that point the entire container is stopped and every PTY in it dies along with it.

**Decision:** Keep the per-PTY reaper but reframe its role as a pure **safety net** for the case where `lastInputAt` tracking gets stuck (terminal server bug, stuck activity polling, broken `/activity` endpoint), and raise the floor to 120 minutes (equal to the maximum user-configurable `sleepAfter`). Concretely, change `PTY_KEEPALIVE_MS` default from `2700000` (45 min) to `7200000` (120 min) in `host/src/server.ts` and `host/src/session.ts`.

**Amendment (2026-07-04, [REQ-SESSION-014](../../sdd/spec/session-lifecycle.md#req-session-014-user-configurable-auto-sleep-timeout-in-settings)):** a `4h` idle option was added, raising the maximum user-configurable `sleepAfter` from 2h to 4h. To preserve this decision's core invariant — the reaper floor must equal the maximum `sleepAfter` so it can never fire before the authoritative idle-stop — `PTY_KEEPALIVE_MS` was raised from `7200000` (120 min) to `14400000` (240 min) in the same two files. References to "120 min" / "2h" below describe the original decision; the current floor is **240 min (4h)**. The parallel `SLEEP_AFTER_FALLBACK_MS` / `idleTimeoutPref` fail-safe defaults were likewise raised 2h → 4h ([REQ-OPS-017](../../sdd/spec/operations.md#req-ops-017-sleepafter-fail-safe-invariants)) so "fail-safe = the maximum supported value" also stays true.

**Alternatives considered:**

1. **Remove the reaper entirely.** Rejected: leaves no recourse if `collectMetrics` ever silently fails to stop a container with a stuck `lastInputAt`. The cost of keeping the reaper is one `setTimeout` per orphaned session.
2. **Make `PTY_KEEPALIVE_MS` track the user's `sleepAfter` preference dynamically.**

Rejected: requires plumbing `sleepAfter` from the container DO through `buildEnvVars` into the host process and re-arming the timer on preference change. The 120-min floor matches the maximum `sleepAfter` and saves the plumbing. A user with `sleepAfter=15m` whose container has stuck `lastInputAt` gets a slightly longer-lived orphan PTY than ideal, but the tradeoff is acceptable for a safety net that is not expected to fire in normal operation.
3. **Make the reaper kill only the agent process while keeping the shell alive, so context persists.**

Rejected: the agent's in-memory state (conversation history, tool-use cache) is what `/resume` reloads from JSONL; killing only the agent and re-spawning still loses in-memory state. The user-facing symptom is identical to today's behavior, with extra plumbing for no gain.
4. **Bump to a smaller floor (e.g. 90 min).**

Rejected: arbitrary midpoint with no principled basis. 120 min has a clear justification: it equals the maximum `sleepAfter` so the reaper is guaranteed not to fire before the container's authoritative idle-stop has had a chance to run.

**Rationale:**

- The user-facing idle contract is [REQ-SESSION-004](../../sdd/spec/session-lifecycle.md#req-session-004-idle-containers-sleep-after-configurable-timeout)'s `sleepAfter` (15m / 30m / 1h / 2h / 4h).

The PTY reaper sits *below* that contract and must never undercut it. Setting the floor at the maximum `sleepAfter` ensures it cannot fire before the authoritative policy.
- The reaper's value is purely defensive:

it prevents a single orphaned PTY from outliving its container forever in pathological scenarios (e.g., `lastInputAt` polling dies but the container DO doesn't notice). With the floor pinned to the maximum `sleepAfter` (now 240 min) it still does that job; it just doesn't fire on the happy path.
- The change is one constant in two files; risk is bounded.

**Trade-offs accepted:**

- Users with `sleepAfter` < 4h will, in the rare case of stuck `lastInputAt`, see PTY orphans last up to 240 min instead of 45 min.

The container would also be stuck (because `collectMetrics` is the trigger for both stop paths), so the practical impact is "container survives extra minutes when something is broken". Acceptable because the user can manually stop the session from the dashboard.
- The default is hardcoded; a future operator who hits memory pressure on a long-orphaned PTY can still override via `PTY_KEEPALIVE_MS` env var. No new user-facing setting is added.

**Related requirements:**

- [REQ-SESSION-004](../../sdd/spec/session-lifecycle.md#req-session-004-idle-containers-sleep-after-configurable-timeout) (idle containers sleep after configurable timeout): the authoritative idle policy. [AD47](#ad47-pty-keepalive-as-safety-net-only-not-the-idle-policy) documents that the PTY-level reaper is subordinate to and must never undercut this REQ.
- [REQ-SESSION-005](../../sdd/spec/session-lifecycle.md#req-session-005-input-based-idle-detection) (input-based idle detection via `lastInputAt`): the signal `collectMetrics` uses; the reaper is the safety net for cases where this signal gets stuck.

**Implementation references:**

- `host/src/server.ts` (`PTY_KEEPALIVE_MS` default)
- `host/src/session.ts` (`_ptyKeepaliveMs` fallback)
- `host/src/session.ts` (`detach()` arms the timer; `keepAliveTimeout` fires `kill()`)


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD48: OAuth state replaced by HMAC-signed stateless token

**Category:** Security

**Status:** Accepted (2026-05-09)

**Supersedes:** [AD38](#ad38-github-oidc-replaces-cf-access-in-saas-mode) (oauth_state mechanism only; the broader GitHub OIDC-over-CF-Access decision in [AD38](#ad38-github-oidc-replaces-cf-access-in-saas-mode) remains valid)

**Context:** [AD38](#ad38-github-oidc-replaces-cf-access-in-saas-mode) specified that the OAuth CSRF state parameter was carried as an HttpOnly cookie (a random UUID, 5-minute TTL). The cookie was validated server-side by comparing the query-param value returned by GitHub against the stored cookie value. iOS WebKit's Intelligent Tracking Prevention (ITP) and third-party cookie restrictions in private-browsing modes silently drop the state cookie before the GitHub callback completes, breaking the OAuth flow for a meaningful fraction of mobile and privacy-conscious users.

**Decision:** Replace the HttpOnly state cookie with a stateless HMAC-signed token. The token is structured as `nonce.iat.sig` where `nonce` is a random value, `iat` is the issued-at Unix timestamp, and `sig` is an HMAC-SHA256 signature over `nonce.iat` using `OAUTH_JWT_SECRET`. The callback handler recomputes the signature and rejects tokens whose `iat` is outside a 30-minute window. No server-side state is stored; no cookie is required for the CSRF check.

**Alternatives considered:**

1. **Keep the cookie, add `SameSite=None; Secure`** to survive cross-site redirects. Rejected: does not help on iOS ITP, which drops third-party cookies regardless of SameSite attribute on the state-checking round-trip.
2. **Store state in KV with a 5-min TTL.**

Rejected: [AD38](#ad38-github-oidc-replaces-cf-access-in-saas-mode) explicitly chose cookies over KV to avoid eventual consistency lag on the Cloudflare edge. HMAC-signed tokens remove the need for any server-side state and are strictly better on both axes.
3. **State in the `state` query param only, validated by nonce replay prevention in KV.** Rejected: same KV consistency concern as option 2.

**Rationale:**

- Stateless HMAC tokens are immune to ITP and private-browsing cookie restrictions because they carry no server-side state -- nothing to look up, nothing to lose on a blocked cookie jar.
- The `iat`-window bound (30 min) gives the same CSRF protection as a short-lived cookie: a state token cannot be replayed after it expires.
- `OAUTH_JWT_SECRET` is already required for `codeflare_session` signing ([AD38](#ad38-github-oidc-replaces-cf-access-in-saas-mode)); reusing it for state signing adds no new secret-management surface.
- Failure path is explicit: state verification failure redirects to `/?error=session-expired` rather than a generic 500.

**Trade-offs accepted:**

- A compromised `OAUTH_JWT_SECRET` now also allows forging state tokens (not just session cookies). The attack surface increase is minimal -- an attacker with the secret could already forge sessions, which is the higher-value target.
- The 30-min window is longer than the previous 5-min cookie TTL. The trade-off is intentional: the broader window accommodates slow mobile networks and interrupted OAuth flows that previously forced re-login.

**Related requirements:** [REQ-AUTH-002](../../sdd/spec/authentication.md#req-auth-002-saas-mode-uses-direct-github-oauth) (GitHub OAuth CSRF protection)

**Implementation references:**

- `src/routes/github-oauth.ts` (`generateState()`, `verifyState()`)


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD49: context-mode delivered as preseed plugin, not runtime install

**Category:** Architecture

**Status:** Partially superseded by [AD109](#ad109-context-mode-mcp-registration-is-universal-and-entrypoint-owned): MCP registration wiring only; accepted 2026-05-10, while the Custom-tier hook decision remains active.

**Context:** [context-mode](https://github.com/mksglu/context-mode) reduces Claude Code's context-window pressure by routing tool calls through hooks that summarize before content lands in the conversation. It ships as an npm package whose Claude Code plugin metadata is normally written into the user's `~/.claude/plugins/` and `~/.claude/settings.json` by `claude plugin install context-mode`. During the first integration attempt (PR codeflare#293, since closed), a research subagent invoked that installer in the host's session and the upstream installer wrote `"matcher": null` for the SessionStart hook entry, which Claude Code 2.1.138 rejects with "Expected string, but received null", silently disabling every other hook in the file.

The bug is recoverable for a single user but unacceptable as default behavior delivered to all paid users.

**Decision:** Ship context-mode in two layers with separate gating.

The **MCP server layer** exposes `ctx_*` helper tools to the agent so they can be called manually regardless of session mode. How the MCP server is registered depends on tier: Custom + Pro users receive it via the `mcpServers` block declared in the preseed `plugin.json`, which Claude Code's plugin loader reads automatically when the plugin folder is present. Non-Custom users have no plugin folder on disk, so `entrypoint.sh` injects the `mcpServers["context-mode"]` entry directly into `~/.claude.json` at session start.

Both paths invoke the bare `context-mode` binary installed globally in the Docker image at build time (`npm install -g context-mode@<ver>` reading the version from `preseed/agents/claude/plugins/context-mode/.claude-plugin/plugin.json`); no source is redistributed since the npm package is fetched from the public registry during image build.

The **plugin folder layer** delivers `~/.claude/plugins/context-mode/` (containing the plugin manifest and `hooks/hooks.json`) as a preseed asset, R2-bisync'd into the user's bucket only when the user's effective tier is `unlimited` (Custom) AND session mode is `advanced` (Pro). The R2 seed filter in `src/lib/r2-seed.ts:getConfigsForMode` strips the entire `.claude/plugins/context-mode/` subtree from the deploy set when the user's tier or mode does not qualify.

The container's `entrypoint.sh` detects the preseeded plugin manifest. When the manifest is present (Custom + Pro), the plugin loader has already registered the MCP server via `plugin.json`; `entrypoint.sh` skips the `~/.claude.json` injection entirely to avoid duplicate registration and instead adds `context-mode: true` to `enabledPlugins` so the four hooks (PreToolUse, PostToolUse, PreCompact, SessionStart) auto-route tool calls. When the manifest is absent (non-Custom tier), the entrypoint injects `mcpServers["context-mode"]` into `~/.claude.json` using the version pin and skips `enabledPlugins` (no auto-routing for non-Custom users).

The MCP layer is what users observe as "context-mode is always available"; the plugin layer is the premium behavior change reserved for Custom-tier Pro users.

**Alternatives considered:**

1. Runtime install via `claude plugin install context-mode`. Rejected: triggers the upstream `matcher: null` self-registration bug, breaks every other hook on session start, and ties Codeflare's hook config integrity to upstream release timing.
2. Runtime jq-merge of mcpServers + SETTINGS_CONFIG hooks in `entrypoint.sh` (PR codeflare#293's approach, closed). Rejected: configuration-as-shell-heredoc is harder to review than configuration-as-data, and doesn't match the operational model already used for `codeflare-hooks` and `codeflare-memory` (preseed plugins).
3. Use the upstream `claude-plugins-official` marketplace. Rejected: relies on an out-of-Codeflare registry path; we want plugin updates to land via Dependabot bumps to a single version pin reviewed and CI-tested before deploy.
4. Ship the npm package contents under preseed instead of relying on `npx`. Rejected: bloats R2 per user and offers no operational benefit since `npx -y context-mode@<pinned>` cache-resolves after first invocation.

**Rationale:**

- The preseed model is identical to how `codeflare-hooks` and `codeflare-memory` already ship: plugin-shaped data delivered via R2 bisync, enabled in `~/.claude.json`'s `enabledPlugins`, discovered by Claude Code on session start. Symmetry across all three plugins reduces operational surprise.
- Tier-gating at the seed-filter layer (worker-side) means the plugin folder never appears on disk for non-qualifying users.

There is no need to sanitize a user's settings.json after the fact, and there is no reachable code path through which a non-qualifying user receives the plugin.
- The matcher-null bug (the entrypoint registered hooks correctly, but the upstream installer corrupted `~/.claude/settings.json` for the host user) is structurally impossible under this model: we never call `claude plugin install`, and the entrypoint never writes `matcher: null`.
- Plugin updates are a Dependabot PR bumping the version pin in `hooks/hooks.json` (mechanical four-line diff), reviewed and CI-gated like any other dependency.

**Trade-offs accepted:**

- The preseed plugin's `hooks/hooks.json` carries the pinned version four times (one per event command string). A future generator could fan this out from a single pin.
- First-call latency: resolved by codeflare#309. The Dockerfile bakes `npm install -g context-mode@<pinned>` into the image and patches the bundles, so the binary is on PATH from session start with no first-call download delay.
- A tier downgrade requires a reconcile pass (already triggered by `/api/preferences` PATCH and Stripe webhook handlers) to remove the plugin folder from R2.

Until reconcile fires, a freshly-downgraded user could still load context-mode on next session, bounded to the next PATCH or webhook event.

**License posture (ELv2):** context-mode is licensed under Elastic License 2.0, which is source-available but explicitly prohibits providing the software as a hosted or managed service that gives third parties access to substantial features of the software. Codeflare's integration is sized to stay within ELv2's permitted-use envelope on three axes.

*No redistribution.* Codeflare does not redistribute context-mode source. The npm package is fetched from the npm registry at Docker image build time and installed globally; users receive a pre-built image, not the source. Our preseed contains only plugin metadata (`plugin.json`, `README.md`) which is our own configuration code, not context-mode's source.

*No commercial automation.* Commercial (non-Custom) users receive `mcpServers["context-mode"]` registration so `ctx_*` tools appear in the agent's tool list, but our preseed contains no skill, rule, agent definition, command, or hook that instructs Claude to invoke those tools. The agent's tool-selection is its own, exactly as it is for any other listed MCP tool. Codeflare provides no automation or routing layer for commercial users.

*Custom-tier auto-routing is admin-only.* The Custom (`unlimited`) tier with the auto-routing hooks is, in current product policy, an admin-only sandbox used for testing and personal development. ELv2 fully permits personal use. If the Custom tier ever opens to paying third parties with the auto-routing hooks active, that crosses the ELv2 line and requires either a commercial license from the upstream author (mksglu) or removal of the hook layer.

A future contributor who adds a SessionStart-style ctx_* nudge, a context-mode skill, an `Implements ctx_*` rule, or any other automation that pushes commercial users toward context-mode functionality must update this ADR before merging.

**Related requirements:** [REQ-AGENT-005](../../sdd/spec/agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers) (Pro mode skills/rules/agents/MCP, tier-gated context-mode plugin delivery) and [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) AC2 (Custom-tier context-window-reduction reconcile-on-downgrade boundary)

**Implementation references:**

- Preseed assets: `preseed/agents/claude/plugins/context-mode/.claude-plugin/plugin.json` (bare manifest; matches `codeflare-memory`/`codeflare-hooks` shape), `preseed/agents/claude/plugins/context-mode/README.md`
- Manifest: `preseed/agents/claude/manifest.json` (two entries with `modes: ["advanced"]`)
- Runtime wiring:

`entrypoint.sh` registers the `context-mode` MCP server in `~/.claude.json` (`command: "context-mode"`, no args) and appends four `context-mode hook claude-code <event>` commands to `~/.claude/settings.json` when the plugin manifest is present and `SESSION_MODE=advanced`. Mirrors the wiring path used by `codeflare-memory` and `codeflare-hooks`.
- Build-time install: the Dockerfile installs the context-mode version declared by the Claude plugin manifest.

  It then prepends the two-line `createRequire` shim to the global `cli.bundle.mjs` and `server.bundle.mjs` files.
- Bun for executor perf:

Bun is installed globally in the image (`npm install -g bun`). context-mode autodetects Bun on first run and uses it as the JS/TS subprocess runtime for `ctx_execute` / `ctx_batch_execute`. Bun starts short-lived JS subprocesses faster than Node, which adds up across hook-heavy sessions. No spec contract on the perf delta - if a Bun release regresses, context-mode falls back to Node. Bun is a perf-only addition; the shim above is what fixes #309.
- esbuild ESM-bundle bug (codeflare#309):

without the shim, `ctx_execute` and `ctx_batch_execute` fail on every dynamic `require('node:*')` with `Dynamic require of "node:fs" is not supported` because esbuild does not inject a CommonJS-require polyfill in `--format=esm` output. The bug reproduces under both Node and Bun ESM loaders, so a runtime swap from `npx` to `bunx` does not fix it. The build-time patch is the durable fix until upstream `mksglu/context-mode` ships a release with the esbuild banner.
- R2 seed tier filter: `src/lib/r2-seed.ts` (`getConfigsForMode(mode, contextModeEnabled)`, `getPreseedKeysNotInMode`, `reconcileAgentConfigs`)
- Worker-side tier gate: `src/routes/container/lifecycle.ts` (`contextModeEnabled = effectiveTier === 'unlimited' && sessionMode === 'advanced'`)
- Worker-side reconcile call sites: `src/routes/preferences.ts`, `src/routes/storage/seed.ts`, `src/routes/stripe-webhook.ts`
- Container-side detection: `entrypoint.sh` (`CONTEXT_MODE_MANIFEST` existence check; conditional `mcpServers["context-mode"]` jq merge; conditional `enabledPlugins["context-mode"]: true`)
- Tests: `src/__tests__/lib/r2-seed-context-mode.test.ts`, `host/__tests__/entrypoint-context-mode.test.js`, `host/__tests__/context-mode-version-pin.test.js`

**Consequences:** The original compact ADR did not record a separate consequences field.
### AD50: Unified ADR file with structural doc-allow-large exemption

**Category:** Process, partially superseded

**Context:** The original compact ADR did not separate a context field from its decision rationale.

**Status:** Partially superseded by [AD51](#ad51-rip-out-six-overengineered-sdd-framework-features) (2026-05-12). The `<!-- doc-allow-large -->` escape hatch was removed; the unified ADR ledger and stable-anchor decision remain active.

**Decision:** (still in effect) All ADRs live in a single `decisions/README.md`. AD-N identifiers are referenced throughout the codebase, so splitting into one file per ADR would mean rewriting every inbound `README.md#ad-N` anchor for no product value. The file-size overage is an accepted, known LOW the operator defers; per-ADR budget enforcement still applies, so any new ADR over the per-ADR cap is split or compressed. Only the `<!-- doc-allow-large -->` hatch-exemption machinery was superseded ([AD51](#ad51-rip-out-six-overengineered-sdd-framework-features)).


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD51: Rip out six overengineered SDD framework features

**Status:** Accepted (2026-05-12)
**Supersedes:** [AD45](#ad45-user-overrides-recorded-as-adrs-not-skip-list), [AD50](#ad50-unified-adr-file-with-structural-doc-allow-large-exemption)

**Category:** Architecture

**Context:** A third-wave architect review of the SDD framework after the second-wave fixes surfaced 30 findings. Per-finding triage on the highest-severity ones revealed that several of the framework features themselves -- not bugs in their implementation but the features as designed -- were adding surface area without proportionate value. User feedback during triage was unambiguous: "overengineered bullshit, remove all commit category idiocity", "wtf is this overengineered shit now". The decision was to rip the six worst offenders before continuing to act on architect findings on what remained.

**Decision:** Remove the following six features from the SDD framework:

1. **ADR Overrides skip-list**

([AD45](#ad45-user-overrides-recorded-as-adrs-not-skip-list)). The `Overrides: {rule}:{target}` ADR header that spec-reviewer / doc-updater parsed at the start of every run to skip matching findings. If a finding keeps re-firing, fix the underlying rule or REQ -- no per-rule bypass.
2. **Hatch markers + audit**

([AD50](#ad50-unified-adr-file-with-structural-doc-allow-large-exemption) and supporting machinery). `<!-- sdd-allow-large -->`, `<!-- doc-allow-large -->`, and `<!-- doc-template-exempt -->` markers plus the Pass 6 / Pass 10 ADR-cross-check audit. Oversized files produce a finding; the operator defers via `sdd/.review-decisions.md` if appropriate.
3. **REQ split-proposal mode**. spec-reviewer draft files at `sdd/.split-proposals/{REQ-ID}.md` consumed by `/sdd clean` on `**Status:** Approved`. Oversized REQs shrink in place; the user splits manually when actually needed.
4. **Out-of-Scope collision check**. Full-spec pass cross-referencing `## Out of Scope` bullets against shipped REQs with content-word-overlap heuristics. Spec drift is normal-quality work, not a separate detector.
5. **Anti-spiral "category" matching**.

Round counter required `≥2 commits on the same target REQ-ID or category` parsed from the commit subject's `fix(spec): {category}` infix. Simplified to `≥2 of the last 3 lane-scoped commits` -- same protection, no parser.
6. **`Implements REQ-X-NNN` annotation enforcement**.

code-reviewer flagged source files implementing a REQ's behavior without the annotation. spec-reviewer CQ-2 cross-walked source annotations against REQ ACs. Annotations remain a human-discoverability convention but are no longer flagged. The test-name-based coverage check is the load-bearing signal.

doc-discipline drops from twelve passes to ten (deleted Pass 6 hatch audit and Pass 10 hatch overuse). spec-discipline drops CQ-2, CQ-4, and CQ-6 (kept and renumbered CQ-1/CQ-3/CQ-5 to CQ-1/CQ-2/CQ-3). `/sdd clean` drops the legacy `sdd/.user-overrides.md` migration step. `/sdd mode` no longer lists recent ADR overrides.

**Consequences:** Smaller surface for both the agent author and the human operator. [AD45](#ad45-user-overrides-recorded-as-adrs-not-skip-list) and [AD50](#ad50-unified-adr-file-with-structural-doc-allow-large-exemption) are marked Superseded but preserved for anchor stability. Architect findings that still need addressing on the remaining surface (six HIGH fixes from the third-wave review) are tracked separately. The framework now has: `/sdd init`, `/sdd clean`, `/sdd mode`, the three-agent PR-boundary pipeline, transition state, and the three discipline rules (spec / doc / tdd). That is the entire surface.

**Issue:** Architect review triage 2026-05-12; user authorization in conversation.

---

### AD52: Graphify MCP available everywhere, discipline advanced-only

**Status:** Accepted (2026-05-14)

**Category:** Architecture

**Context:** Graphify (upstream `graphifyy` Python package, Apache-2.0) turns a folder into a queryable knowledge graph and exposes it via an MCP server (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`). Integrating it into Codeflare required a tier-gating decision: every preseed plugin so far chose between "advanced-only" (codeflare-memory, codeflare-hooks) and "custom-tier-only" (context-mode via [AD49](#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install)). Graphify did not fit either bucket cleanly. The MCP server itself is harmless ambient capability that any session benefits from when the user reaches for it; the discipline that says "use the graph before grepping" is what produces token savings and is what changes agent behaviour.

**Decision:** Split delivery on a discipline-vs-capability axis, not on tier:

- **Plugin folder + `plugin.json` + MCP server registration**: ships in both `default` and `advanced` session modes. The `graphify` MCP server is registered in `~/.claude.json` whenever the preseed manifest is present, which is every paid tier.
- **PostToolUse-on-clone triage hook, PreToolUse graph-first nudge, the graph-first discipline, and `graphify/SKILL.md`**: ship in `advanced` session mode only. These are the load-bearing pieces that teach the agent to use the graph proactively.

The prompt-independent `SessionStart[startup]` context-injection hook was retired on 2026-07-27. It read a non-canonical edge key, ignored graph freshness, and its corrected highest-degree output was dominated by generic duplicate labels. Prompt-aware first-turn memory and focused graph queries provide the relevant context without carrying that startup list.

The graph-first discipline was a standalone `graph-first.md` rule until 2026-07-25; it is now a section of `engineering-constitution.md`.

Tier-gating is not part of the decision: graphify ships uniformly across standard, advanced, max, and custom paid tiers. The discipline gating is keyed only on session mode.

**Consequences:**
- Default session mode users CAN reach for graphify by name (CLI on PATH, MCP tools exposed) but do not get nudged toward it. No triage on clone and no rule in `~/.claude/rules/`.
- Advanced session mode users get the full discipline: the agent prompts on clone and prefers focused MCP queries over Grep for architecture questions.
- Advanced mode also adds a PreToolUse soft-nudge when reaching for Grep/Glob (or the context-mode grep-equivalents `ctx_search`/`ctx_batch_execute`) in a repo that has a graph.
- Image cost (~220 MB for Python + tree-sitter wheels) is paid by every container regardless of mode, justified by one-time build cost vs. universal capability.
- Coexists cleanly with context-mode ([AD49](#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install)) without depending on it.

Graphify's own subagent-chunking model is the load-bearing context-bounding mechanism for `/graphify` extraction; context-mode routing through `ctx_execute` is bonus per-subagent savings when present. The `enforce-ctx-mode.sh` Bash whitelist gets `graphify` added (in custom tier where the file ships) but no behaviour depends on that whitelist for other tiers. The graph-first soft-nudge hook covers both tier paths: `Grep`/`Glob` matchers fire in non-custom tier where those tools are not denied; `mcp__context-mode__ctx_search`/`ctx_batch_execute` matchers fire in custom tier where the agent is routed through ctx for grep-equivalents.
- The MCP server registration is keyed on `GRAPHIFY_MANIFEST` presence rather than `SESSION_MODE`, so the "capability everywhere" half is enforced by the manifest gate rather than a mode check.
- Persistence model: graphify artifacts (`graphify-out/`) live in the repo, not in R2.

  Repo owners commit `graphify-out/graph.json`, `GRAPH_REPORT.md`, and `graph.html` to git; the working tree gets them on clone and contributors inherit both the graph and a browser-openable interactive visualization for free. Repos without push permission keep the graph local-only and ephemeral. R2 bisync explicitly excludes `**/graphify-out/**`.

  The container image registers the graphify semantic merge driver globally (`git config --global merge.graphify.driver`) so any repo that wires `graphify-out/graph.json merge=graphify` in its `.gitattributes` gets auto-resolution of concurrent `graph.json` edits without manual JSON intervention.

  SKILL guidance instructs the agent on first build to add the canonical `.gitignore` block (regenerable build outputs under `graphify-out/`, the `.graphify_*` working-tree intermediates the build creates mid-run, and per-machine markers) and the merge-driver attribute line to `.gitattributes`. The full pattern list and rationale live in `/graphify` SKILL.md note 3; `documentation/container.md` mirrors the explanation.
- Obsidian stub vault is deliberately gitignored: `graphify-out/obsidian/` is a per-node markdown vault that gives an Obsidian-app user a familiar graph-browse UI.

  Every `graphify update .` rerun rewrites centrality + community-label frontmatter across all those files, producing PR diffs in the thousands of files for one structural change. The standalone `graph.html` covers the casual-browse use case in any browser without needing Obsidian installed, and a developer who actually wants the Obsidian workflow can regenerate the stub vault locally from `graph.json` in seconds. The trade-off keeps PR signal clean at the cost of one local command for the rare power-user.

**Alternative considered:** Match context-mode ([AD49](#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install)) and gate the whole thing on custom tier. Rejected: graphify's MCP query tools are cheap, structurally bounded, and useful even when no discipline rule pushes the agent toward them. Hiding the capability behind a tier wall would have been more conservative but would have wasted the build-time install for the 99% of paid users who are not on custom tier.

**Issue:** [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify); PR #354.

---

### AD53: Graphify hot-reload wrapper with multi-repo sentinel tracking

**Status:** Accepted (2026-05-14)

**Category:** Architecture

**Context:** Two problems surfaced after [AD52](#ad52-graphify-mcp-available-everywhere-discipline-advanced-only) shipped. First, upstream `graphify.serve` `sys.exit(1)`s when `graphify-out/graph.json` is missing at startup. Codeflare sessions start with an empty workspace and a user typically clones one or more repos mid-session, so the MCP server died on every fresh session and there was no way to restart Claude Code without losing the container (killing the session kills the Durable Object).

Second, sessions typically hold 2-3 cloned repos; the MCP server is one persistent process and has no native notion of "the current repo." When the agent moved between repos via Bash `cd`, ctx_execute, git/gh clone, or simply by editing files in a different directory, the wrapper bound G to whichever path resolved first at startup and never switched, silently returning wrong-repo answers.

**Decision:** Two coupled mechanisms:

1. **`graphify-mcp-lazy.py` wrapper** ships to both `default` and `advanced` session modes.

   It is ambient capability, paired with the MCP registration per [AD52](#ad52-graphify-mcp-available-everywhere-discipline-advanced-only). The wrapper monkey-patches `graphify.serve._load_graph` to return a `LazyGraph` (subclass of `nx.DiGraph` so `isinstance` checks in graphify and networkx pass cleanly).

   LazyGraph starts empty, then a daemon watcher thread polls the active graph file every `GRAPHIFY_POLL_SECONDS` (default 2s). On mtime change, it builds a fresh `nx.DiGraph` and swaps the underlying `_node`/`_adj`/`_pred`/`_succ`/`graph` dict members atomically under a lock so concurrent readers (graphify's tool handlers running on the main thread) never see a half-mutated graph. The tool list stays static (the upstream graphify tools); only G's contents swap.

2. **`graphify-active-repo.sh` PostToolUse hook** ships to `advanced` session mode only. It writes the agent's current repo root to a sentinel at `~/.cache/codeflare-hooks/graphify-active-cwd`.

   Matcher set is `Bash | Edit | Write | Read | NotebookEdit | mcp__context-mode__ctx_execute | mcp__context-mode__ctx_execute_file | mcp__context-mode__ctx_batch_execute` because the cwd signal differs by tool surface and tier: Bash uses Claude Code's session cwd which updates on `cd`; Edit/Write/Read provide an absolute `file_path` that the hook walks up to find a `.git/` or `graphify-out/` ancestor; ctx_execute variants need the shell snippet parsed for `cd X` because Claude Code's session cwd never sees changes inside ctx_execute subshells.

   The wrapper polls the sentinel and rebinds G when it changes. When the sentinel is absent (default mode, or before the first hook fires), the wrapper falls back to the freshest mtime across `CODEFLARE_WORKSPACE/*/graphify-out/graph.json`.

**Consequences:**
- Sessions starting empty no longer require a Claude Code restart to bring graphify online. The MCP shows as connected from the first prompt; tool calls return empty (`Nodes: 0`) until a graph appears.
- Multi-repo precision is advanced-only.

Default-mode users typing `/graphify` explicitly for a single repo get correct answers via the freshest-mtime fallback; default-mode users juggling multiple graphs would get wrong-repo answers, but that path is rare-by-design (no SKILL or clone-prompt is preseeded to push them toward multi-graph builds).
- Per-branch graphs are not supported.

The wrapper reads `<repo>/.git/HEAD` only for an informative stderr log line on rebind. Users run `graphify update` after a checkout; the wrapper's mtime watcher picks up the rebuild within 2 seconds. Forking graphify upstream to model branches was rejected as out of scope and orthogonal to the codeflare integration.
- Reader-safety is load-bearing:

an earlier draft used `G.clear()` + `G.add_nodes_from()` and crashed graphify tool handlers mid-iteration under the exact workload the wrapper was built for (`graphify update` immediately followed by `query_graph`). The atomic dict-swap pattern resolves this without forking graphify or wrapping the tool handlers.
- Sentinel race under concurrent batch-execute hooks is acceptable: last writer wins, wrapper converges within 2 seconds. Hook only rewrites on change so mtime churn is bounded.

**Alternatives considered:**

Alternative 1 — Spawn one MCP server per repo on first `cd` into it. Rejected because Claude Code does not natively support per-cwd MCP servers, the spawn/teardown logic would have to live in `entrypoint.sh` with `proc` watching, and the wrapper-based approach lets a single process handle every repo in the session at the cost of one short stderr log line per rebind.

Alternative 2 — Pass repo path as an explicit MCP tool argument on every call. Rejected because graphify's upstream tool handlers query G in closure and would need rewriting; relying on the agent to remember a `repo_path` arg every invocation would silently degrade in practice.



**Issue:** [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify).

---

### AD54: Vault directory must use a non-hidden basename

**Category:** Storage

**Status:** Accepted

**Context:** The original vault path was `/home/user/.user_vault/`. SilverBullet's disk walker (`server/disk_space_primitives.go` `FetchFileList`) aborts the directory walk immediately when the root directory's basename begins with `.`, returning an empty file listing even when notes are present on disk. This is not a configurable behaviour in SilverBullet 2.8 -- it is hardcoded in the Go source. The result was that opening the vault in the editor showed no files at all despite a populated directory on disk.

**Decision:** The vault directory is renamed to `/home/user/Vault/` (non-hidden basename). All references in entrypoint.sh, bisync filters, preseed scripts, agent rules, Worker route, audits, and tests are updated in the same commit. The internal identifier `init_user_vault()` and the `--as user_vault` global-graph tag are preserved (no manifest migration needed). R2 is a clean cutover for the single existing user; prior `.user_vault/` content in R2 is abandoned rather than migrated.

**Constraint (permanent):** The vault directory must never be renamed to a dot-prefixed basename. Any future relocation of the vault must preserve a non-hidden basename or the SilverBullet disk walker will silently return an empty file list. This constraint is documented in `documentation/lanes/vault.md#directory-layout` and enforced by the `host/__audits__/entrypoint-vault.audit.js` structural audit (checks that the supervisor command references `$HOME/Vault`, not `$HOME/.user_vault` or any other hidden path).

**Consequences:**
- SilverBullet correctly walks and indexes all vault files after rename.
- The path `/home/user/Vault/` is visible in `ls /home/user/` output (non-hidden), which is the desired UX: users can see the vault directory without `ls -a`.
- The bisync filter gains `+ Vault/**` (replacing `+ .user_vault/**`). Filter order is preserved: vault include comes before the global `- **/graphify-out/**` exclude so the vault's own `graphify-out/` subdirectory is included in sync.

**Alternatives considered:**

Alternative 1 — Configure SilverBullet via `SB_SPACE_FOLDER` or a command-line flag to skip the hidden-basename check. Rejected: the check is not configurable in SilverBullet 2.8's Go source; patching the binary was out of scope.

Alternative 2 — Mount the dot-prefixed directory into a non-hidden path via bind mount or symlink. Rejected: adds fragile entrypoint complexity and bisync would still see the original dot-prefixed path. A clean rename is simpler and permanent.



**Related REQ:** [REQ-VAULT-001](../../sdd/spec/vault.md#req-vault-001-persistent-vault-directory-survives-across-sessions).

---

### AD55: Codeflare brands the vault editor via preseed-managed STYLES.md

**Category:** Architecture

**Status:** Accepted

**Context:** SilverBullet supports custom editor themes via a `STYLES.md` page at the vault root tagged `#meta/styles`. Without a managed theme, the editor renders SilverBullet's default visual language, which has no codeflare identity (different palette, different fonts, different border treatments from the rest of the codeflare UI). The vault is a user-owned space inside a user-owned R2 bucket; allowing per-user theme customisation would let the editor drift visually from the rest of codeflare, but defaulting to no theme would make the editor feel grafted-on rather than native.

**Decision:** `STYLES.md` is a preseed-managed, always-overwritten file. Codeflare owns its content; `init_user_vault()` syncs it from `/opt/silverbullet-preseed/STYLES.md` on every container boot, gated so identical files are not rewritten. Users cannot customise the editor theme by editing `STYLES.md` in-place inside SilverBullet -- edits are silently reverted on the next session start. Theme changes must go through a `preseed/silverbullet/STYLES.md` change in the repo. The shipped theme mirrors the codeflare design tokens (`web-ui/src/styles/design-tokens.css`): zinc dark palette, Inter sans / JetBrains Mono code, blue accent (HSL 217 / 91% / 60%).

The initial implementation defined only `--cf-*`-namespaced custom properties on `:root`, on the (incorrect) assumption that SilverBullet would consume them. SilverBullet 2.x reads its own `--root-*`, `--ui-accent-*`, `--top-*`, `--button-*`, `--editor-*`, `--modal-*`, `--panel-*`, `--editor-wiki-link-*` variables instead (verified against `client/styles/theme.scss` in the 2.8.0 source), so the original theme had zero visual effect: STYLES.md shipped but the editor still rendered SilverBullet's default palette. The fix wires all SB variables under `html[data-theme="dark"]` and keeps the `--cf-*` palette as a local token layer the SB variables consume. The `--cf-*` indirection is retained for readability (`--root-background-color: var(--cf-bg-base)` is easier to maintain than a raw hex value sprinkled across 80 declarations).

**Consequences:**
- The vault editor reflects codeflare branding consistently across users and sessions; switching between codeflare UI and SilverBullet feels native rather than grafted.
- Users who want custom styling cannot achieve it without forking the project or opening a PR to `preseed/silverbullet/STYLES.md`. This is the explicit trade-off: brand consistency over per-user theming.
- Preseed theme updates propagate to all users on next session boot with no per-user migration.
- The always-overwrite contract is documented in `documentation/lanes/vault.md` (three-tier durability) and in the in-vault `README.md` so users discover the constraint before hand-editing.
- The variable-namespace lesson is preserved in the `STYLES.md` header so maintainers do not regress to a `--cf-*`-only theme.

  The Vault first-session expectations document the zinc base, blue accent, Inter body, and JetBrains Mono code smoke check.

**Alternatives considered:**

Alternative 1 — Ship `STYLES.md` as recreate-if-missing only, preserving user edits. Rejected: the same user who deletes `index.md` or `CONFIG.md` and expects automatic recovery (the always-overwrite contract for those files) would not expect `STYLES.md` to behave differently. Mixing tiers within the same set of preseed pages was deemed more confusing than the cost of disallowing in-place theme edits.

Alternative 2 — Use SilverBullet's `theme:` setting in `.silverbullet/config.yaml` instead of a separate `STYLES.md` page. Rejected: the bootstrap `config.yaml` carries only the runtime essentials (indexPage, defaultMode); a 200-line CSS payload belongs in a markdown page where the `#meta/styles` tag is SilverBullet's canonical extension point.



**Related REQ:** [REQ-VAULT-001](../../sdd/spec/vault.md#req-vault-001-persistent-vault-directory-survives-across-sessions) (AC7 lists the four preseed-authoritative pages including STYLES.md).

---

### AD56: 15-minute bisync cadence with manual triggers

**Category:** Storage

**Status:** Accepted (2026-05-18)

**Context:** The periodic rclone bisync daemon ran every 60 seconds, producing ~1440 invocations per session per day even on idle sessions. Each invocation does at minimum one LIST on each side plus N HEADs across both encrypted and unencrypted configs; for users with multiple active sessions the R2 operation count scaled into terabytes/month of metadata traffic and Class A operations. The dominant cost was not transferred bytes but listing overhead on idle sessions.

Three options were considered: (a) keep 60s, (b) inotify-driven local-flush plus a 15-minute ceiling, (c) pure 15-minute cadence with explicit user-driven triggers. Option (b) was initially recommended for its sub-minute convergence on active sessions, but the Claude-projects directory writes session transcripts continuously and would trigger the inotify wake on every keystroke; restricting inotify to specific folders added complexity without clearly winning over option (c). Option (c) was chosen for simplicity.

**Decision:** The periodic bisync runs every 15 minutes. Three trigger points cover the gap:

1. **15-minute wall clock** -- the daemon's `sleep` is interruptible by SIGUSR1, otherwise wakes after 900 seconds.
2. **Manual UI trigger** -- the storage panel's Sync-now button posts to `POST /api/sessions/sync`, which fans out per-session triggers across all the authenticated user's running sessions.
3. **Final sync at shutdown**

-- the Container DO drains a fresh bisync via an awaited `POST /internal/final-sync` while the container is still running, BEFORE signalling stop (the SIGTERM trap is now only a backstop, since the platform SIGKILLs ~3s after stop) ([REQ-STOR-005](../../sdd/spec/storage.md#req-stor-005-graceful-shutdown-performs-final-sync), [REQ-SESSION-011](../../sdd/spec/session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync), [AD57](#ad57-135-second-shutdown-budget-for-final-bisync)).

An earlier draft of this ADR included a fourth trigger ("upload-side auto-trigger" -- fire-and-forget fan-out on every R2 PUT through the storage panel). It was removed: a single 20-file drag-drop produced 20 separate KV-enumeration + fan-out RPCs, blowing Worker subrequest budget for a feature the Sync-now button + 15-minute cadence already cover at lower cost. The container-side SIGUSR1 trap coalesces to at most one in-flight + one queued bisync regardless, so the only thing the upload-side trigger ever gave us was Worker-layer waste.

The daemon's SIGUSR1 trap is coalescing: signals received during a running bisync set a rerun-requested flag rather than queueing, so N signals during one cycle produce exactly one rerun after the current cycle completes.

**Why fan-out across sessions is safe (and serial would not be better):**

- bisync uses `--conflict-resolve newer`. Newest-mtime-wins is commutative and associative on absolute mtime: for any file with versions across N sessions, the final R2 state is always `max(mtime_1, ..., mtime_N)` regardless of order.
- The system already runs in this concurrent mode every 60 seconds today for any user with multiple active sessions.
- The existing `--check-sync=false / --resilient / --recover / --ignore-checksum / --max-delete 100` flag set already hardens bisync against listing divergence from concurrent writers. Manual fan-out introduces no new concurrency model.
- R2 (S3-compatible) guarantees atomic per-object writes. Concurrent LISTs from different sessions see slightly different snapshots, but each individual file is either fully old or fully new -- never partial.
- Serial fan-out would be ~Nx slower with no different outcome. Worse, the "winner" under serial would depend on which session the Worker happened to schedule first, replacing a mathematically deterministic max-mtime outcome with an arbitrary one.

**Consequences:**
- Estimated ~14x reduction in R2 ops on idle sessions (96 cycles/day vs 1440).
- Ungraceful exit (OOM, container eviction, kernel panic) can lose up to 15 minutes of work. Graceful exit (idle stop, explicit delete, user stop) remains safe via the awaited final-sync drain before stop ([AD57](#ad57-135-second-shutdown-budget-for-final-bisync) Revision).
- Multi-tab convergence latency widens from <=60s to <=15min unless the user clicks Sync-now.
- Storage-panel-after-terminal-write freshness widens to <=15min unless the user clicks Sync-now.
- Tier-uniform: free, standard, advanced, max, and custom paid tiers all run on the same cadence.

**Alternatives considered:**

Alternative 1 — inotify-driven local-flush with a 15-minute ceiling. Rejected: requires either watching the whole filesystem (Claude-projects flooding) or per-folder include lists (complexity that pure 15-min plus Sync-now avoids). The simplicity win outweighed the sub-minute convergence loss for active sessions.

Alternative 2 — Activity-gated 60s plus 15-min idle fallback. Rejected: same complexity floor as inotify without the upside; misses out-of-band writes (vault editor on host).



**Related REQ:** [REQ-STOR-003](../../sdd/spec/storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers) (rewritten in this change), [REQ-STOR-015](../../sdd/spec/storage.md#req-stor-015-explicit-sync-trigger-from-ui) (manual trigger surface).

---

### AD57: 135-second shutdown budget for final bisync

**Category:** Storage

**Status:** Accepted (2026-05-18)

**Context:** The pre-existing Container DO `destroy()` budget was 75 seconds (vault rollout had already raised it from 25s -> 75s when vault edits in the last seconds before shutdown were silently truncated by the SDK's SIGKILL mid-bisync). The entrypoint shutdown handler's watchdog was 60 seconds (50s SIGTERM + 10s SIGKILL), nested cleanly inside the 75s DO budget with 15s buffer for clean process exit.

Under the new 15-minute cadence ([AD56](#ad56-15-minute-bisync-cadence-with-manual-triggers)), any single bisync run can accumulate more changes than under the old 60s cadence -- in the worst case, up to ~15 minutes of writes since the last sync. The 60s shutdown watchdog is therefore too tight: large vault edits or workspace deletes accumulated over a long idle window can routinely exceed 60s on the final bisync, triggering the watchdog's SIGKILL mid-write and leaving R2 in a partial state.

**Decision:** Raise the shutdown chain by 60 seconds at both layers:

- **entrypoint shutdown_handler watchdog**: 50s SIGTERM + 10s SIGKILL -> 108s SIGTERM + 12s SIGKILL (120 seconds total).
- **Container DO `destroy()` timeout**: 75_000ms -> 135_000ms (120s bisync + 15s clean-exit buffer, preserving the existing 15s margin between the entrypoint giving up and the SDK SIGKILL).

The DO's `_shutdownStartedAt` telemetry already logs `shutdownElapsedMs` on `onStop()`. Augment with a `logger.warn` at 110 seconds elapsed so any session approaching the new budget surfaces in logs and we can bump again if real-world bisyncs routinely exceed 110s.

**Revision (2026-06-04) -- the final sync moved off the SIGTERM trap onto an awaited live drain:** The original decision assumed the entrypoint's SIGTERM trap would run the final bisync inside the 108s/120s grace, with the 135s DO budget nested cleanly around it. Production proved that assumption false: the platform SIGKILLs the container ~3 seconds after the DO signals stop, never honoring the 108s SIGTERM grace. The logs are unambiguous -- `shutdownElapsedMs:2960`, `Graceful shutdown complete elapsed:3000`, and `onStop` firing at 16.824 BEFORE `Graceful shutdown complete` at 16.864 (the container dies before `superDestroy()`).

The trap's final bisync was therefore always cut off, and under the 15-minute cadence ([AD56](#ad56-15-minute-bisync-cadence-with-manual-triggers)) that meant a session stopped or deleted shortly after edits lost everything since the last cadence sync (observed: a session deleted then recreated under the same agent was missing its last few minutes of work). Manual and cadence syncs worked precisely because they run while the container is fully alive (SIGUSR1 to the daemon), not during the kill grace.

The fix is the synchronous-drain RPC the "Alternative considered" below originally rejected: before signalling stop, the DO drains a fresh bisync while the container is still running and the DO holds teardown open. `drainFinalSync` (container-metrics.ts) calls a new awaitable host endpoint `POST /internal/final-sync` (`host/src/request-router.ts`, evaluated by `host/src/final-sync.ts::evaluateFinalSync`) that triggers the daemon via SIGUSR1 and blocks until that run reaches a terminal status; completion is detected by a monotonic epoch-ms `ts` stamp on `sync-status.json` plus a `syncing` emission before each daemon run, so the endpoint waits for OUR triggered run (`syncing` stamped strictly after the trigger, then `success`/`failed`) and ignores an already-in-flight bisync.

`destroy()` awaits the drain (120s budget, best-effort) before `stop('SIGTERM')`; idle-stop and quota-stop in `collectMetrics` drain identically; STOP and DELETE both route through `destroy()` so they behave identically by construction. The 135s teardown hard-cap and the 110s warn threshold are unchanged and now bound the drain-then-stop sequence (120s sync + 15s stop). The SIGTERM trap is retained as a best-effort backstop, not the primary mechanism. The cost is that a deliberate stop/delete now blocks up to ~120s in the worst case (large unsynced accumulation) to guarantee no loss -- the same user-accepted floor the original budget already implied, now actually enforced. See [REQ-SESSION-011](../../sdd/spec/session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync).

**Revision (2026-06-10) -- the host endpoint's internal timeout was inverted *below* the DO budget:** The 2026-06-04 live-drain fix was still losing the last edits on delete in production. Root cause, confirmed in code: the in-container final-sync endpoint capped its own poll loop at `INTERNAL_TIMEOUT_MS = 115_000` -- *below* the DO's 120s drain budget (the comment literally read "just under the DO's 120s budget"). For any final bisync landing in the 115-120s band -- exactly the long-idle sessions AD56's 15-minute cadence produces -- the host returned 504 first, `drainFinalSyncAudited` mapped it to `incomplete`, and the session deleted with unsynced edits.

Every prior "raise the budget" attempt raised numbers on the wrong side of the inverted ceiling, and a regression test (`host/__tests__/final-sync-endpoint.test.js`) even asserted the inversion (`INTERNAL_TIMEOUT_MS < 120_000`) as an invariant, so any correct fix would have failed CI -- a large part of why this survived ~10 attempts. **Fix:** the host endpoint timeout is raised strictly ABOVE the DO budget (`125_000`), so the DO's `AbortSignal(120s)` is the sole authoritative ceiling; the guard test now asserts host `> 120_000`; and `finalSyncAudit` additionally records the final-sync HTTP status + reason + session id so a residual non-completed sync is queryable post-mortem.

Per the product decision, a genuinely >135s sync still deletes (data loss accepted past the hard cap) -- but it is now audited, not silent. A suspected rclone state-wedge (held lock / stale `.lst` poisoning the next session) was ruled out: those live in `~/.cache/rclone/bisync`, which is both ephemeral per container and excluded from R2 sync (`--filter "- .cache/**"`), so a fresh session cannot inherit a wedged baseline -- no entrypoint change was warranted.

**Revision (2026-06-10, later the same day) -- the drain never reached the timeout machinery at all: it 401'd at the in-container auth gate on every single stop/delete.** Live-incident forensics (integration, full Workers Observability history) showed every teardown drain failing in ~51-300ms with HTTP 401 -- and **zero successful teardown final syncs ever recorded in ≥30 days of logs**, before AND after the budget-inversion fix shipped. Root cause: both drains (`drainFinalSyncAudited` on delete, `drainFinalSync` on idle/quota-stop) called the host with a bare `port.fetch('http://localhost/internal/final-sync')`.

The raw TCP-port fetch bypasses the DO's public `fetch()` override -- the only place the `Authorization: Bearer` header is injected (the reason `/health` and `/activity` are explicitly auth-exempt in `host/src/auth-check.ts`; `/internal/final-sync` is not) -- so the host's auth gate rejected the drain before the final-sync handler ever ran. Compounding it on the delete path, `destroy()` wipes `containerAuthToken` from storage and memory *before* the drain fires (REQ-SESSION-009 resurrection-guard ordering), so even an auth-aware drain would have had no token to send. The manual storage-panel "Sync R2" button always worked because it routes through the worker's authenticated container fetch -- the working reference path that exposed the contrast.

**Fix:** `destroy()` captures the token before the storage clear (alongside the audit session id) and passes it to the drain; both drains now set `Authorization: Bearer <token>` (the idle/quota-stop path reads the still-intact token from DO storage). The budget-inversion fix above remains correct and necessary -- but it was unreachable behind this 401; the auth header is the prerequisite for any of the timeout machinery to matter. REQ-SESSION-011 AC1/AC6 pin the behavior; tests assert the header on both paths and that the delete-path token is the pre-clear capture.

**Consequences:**
- Final bisync has headroom for the worst-case 15-minute accumulation.
- Session-delete UX shows a "Saving final changes to storage..." spinner up to ~130 seconds before reporting success. The session-delete handler in `src/routes/session/crud.ts` already awaits `container.destroy()` end-to-end, so no fire-and-forget fix is required.
- The 2-minute SIGKILL is the user-accepted floor: anything still running at 120 seconds is hard-killed and the last writes accepted as potentially lost.
- If telemetry shows shutdownElapsedMs P95 exceeds 110 seconds in production, the budget can be raised again to 150s/165s without architectural change -- the warn threshold gives early signal.

**Alternative considered:** Telemetry-first canary -- ship the 15-min cadence behind an env var, gather shutdownElapsedMs P95/P99 for one week, then commit to the budget. Rejected by the user: the 2-minute budget plus SIGKILL is the explicit floor; if it is not enough, the warn threshold and post-merge telemetry will tell us within 24 hours.

**Alternative considered (originally rejected, ADOPTED 2026-06-04 -- see Revision above):** Block container destruction on an explicit "prepare-shutdown" RPC that runs the final bisync synchronously and only returns on completion. This was rejected in the original decision on the premise that "the existing trap-driven shutdown already runs the final bisync." That premise was wrong -- the trap is cut off by the ~3s platform SIGKILL -- so the awaited drain (`POST /internal/final-sync`) is now the primary mechanism and the trap is the backstop. Extending the budget alone never helped because the budget governs the DO's wait, not the container's lifetime after stop is signalled.

**Revision (2026-07-20) -- two windows closed inside the existing 120s/135s budget, which is unchanged:**

- `trap shutdown_handler SIGTERM SIGINT EXIT` fired the handler **twice** -- once as the signal trap, once as the `EXIT` trap it triggers itself by ending in `exit 0`. A `shutdown_once`/`SHUTDOWN_RAN` guard makes the second entry a no-op.
- `walk_kill` sends TERM but does not reap, so a still-live daemon `rclone bisync` made the final sync's stale-lock guard back off and fast-fail, losing up to one cadence (AD56) of work.
- `shutdown_handler` now polls for up to 5s first.

The second pass previously found the first pass's SIGKILLed rclone gone, cleared the `.lck` as stale, and started a *fresh* bisync at t≈120s that the DO's t=135s SIGKILL then cut mid-write to R2 -- the exact failure this ADR exists to prevent. Separately, the watchdog's SIGTERM sleep is shortened by however long the quiesce poll took (`sleep $(( 108 - QUIESCE_SECS ))`), so the wait is taken **out of** the 120s/135s budget rather than added to it; exhausting the 5s logs a warning rather than falling through silently.

Two related shutdown-correctness fixes in the same function: `TERMINAL_PID` initialises to `""` rather than `0`, because the kill site guards on `[ -n ]` -- which `"0"` passes -- so `kill "$TERMINAL_PID"` signalled the whole process group from PID 1; and the background init subshell (`BISYNC_INIT_PID`) is killed before the pidfile sweep, closing a race where it started supervisors *after* the sweep that then competed with the final bisync for CPU and R2 bandwidth inside the budget.

**Related REQ:** [REQ-STOR-005](../../sdd/spec/storage.md#req-stor-005-graceful-shutdown-performs-final-sync) (AC4 + AC5 codify the new budget), [REQ-OPS-010](../../sdd/spec/operations.md#req-ops-010-graceful-container-shutdown-preserves-data) (Constraints codify the quiesce wait).

---

### AD58: Sonnet for memory capture, with prefilter and scratchpad

**Category:** Memory

**Status:** Accepted (2026-05-18)

**Context:** [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault)'s capture pipeline ran haiku as the background subagent and read raw transcript JSONL directly. Two problems emerged in production:

1. **Recency bias.**

A 1466-line transcript is ~3.8 MB of JSONL; ~99% of those bytes are `tool_use` and `tool_result` records. Haiku reading the raw stream burned its working memory on tool I/O and produced a capture summarising only the most recent topic. Bench: a session that ran 6 hours of R2-bisync design work yielded a 1431-byte note covering just the final 15 minutes' stop-hook mechanics; the substantive arc was lost.
2. **Confabulated citations.**

Even after prefilter+chunking removed the recency bias, haiku invented adjacent ADR numbers in benchmarking (`AD58`, `AD59` cited in a note where the actual references were `AD56` + `AD57`). For a memory subsystem whose value is "queryable cross-session truth," false citations are worse than missing ones - they pollute the unified graph and mislead future agents that match on the wrong ID.

**Decision:** Three coupled changes that ship as one PR:

- **Prefilter pipeline.**

New `prefilter-transcript.sh` runs a `jq` filter that drops tool_use/tool_result/thinking blocks, slash-command wrappers, task-notifications, hook feedback, resume markers, and meta records. Output is NDJSON of `{role, text, ts}` per kept entry. On the benchmark transcript: 3.8 MB raw → 50 KB clean (76× reduction).
- **Chunked scratchpad.**

The capture agent splits the clean NDJSON into chunks of ~20 entries (`chunk-aa.md`, `chunk-ab.md`, ...), processes each chunk in turn, and appends per-chunk observations to a scratchpad file before synthesising the final note. The scratchpad becomes working memory; recency bias is structurally prevented because each chunk gets equal attention.
- **Model: sonnet, not haiku.**

The capture agent runs at sonnet tier. Same-input bench against haiku: sonnet produced 52 bullets vs 30, cited 15 commit SHAs verbatim (haiku cited 0), and invented zero IDs vs haiku's 2. The model is bound at the agent-file level via frontmatter in `preseed/agents/claude/agents/memory-capture.md` (and `vault-extract.md` for the vault path); hook directives instruct the main agent not to pass a model override to the Task tool, so the pin cannot be silently downgraded by a caller.

Three smaller decisions bundled in:

- **Timezone for capture filenames**

is resolved at capture time from `$USER_TIMEZONE` env var, then `$TZ`, then `/etc/timezone`, falling back to UTC. No hardcoded zone -- codeflare is forkable and users live everywhere. The container clock is typically UTC; the Dashboard auto-syncs the browser's IANA timezone to the `userTimezone` preference on mount ([REQ-SESSION-016](../../sdd/spec/session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env) AC5), so captures record the user's actual wall-clock time (filenames like `2026-05-18T14-22-15+0200-...md`) on the next session start after first login.
- **Prefilter script joins the manifest.** Adding `plugins/codeflare-memory/scripts/prefilter-transcript.sh` to `preseed/agents/claude/manifest.json` so it ships through the standard agent-seed pipeline. Otherwise the capture agent would call a script that does not exist in production.
- **Marker filter**

explicitly excludes string content beginning with `<` (slash-command + task-notification wrappers), `Stop hook` (stop-hook feedback synthetic injection), `This session is being continued` (resume header), and `[Request interrupted` (interrupt notice). These were all leaking into the haiku's view of "real user prompts" before this pass.

**Consequences:**
- Capture cost rises ~3x per fire (haiku → sonnet pricing).

The capture fires at most once per 15 real user prompts, so a typical long session triggers it 1-5 times. Absolute cost is cents per session - well worth the fidelity gain.
- Capture latency rises modestly:

chunked-scratchpad introduces N+1 LLM round-trips per fire (one per chunk plus the synthesis pass). On the benchmark the haiku run took ~88 s end-to-end; sonnet with the new pipeline ~228 s. The agent runs in the background via `executionCtx.waitUntil`, so user-facing latency is unchanged.
- Vault notes are denser (5-10 KB typical vs 1-2 KB before). SilverBullet renders all of them fine; the unified graph picks up more concept nodes per capture, which improves cross-session retrieval recall.
- Stale `Raw/Sessions/` files written by the old pipeline are not migrated. They remain as historical record; future captures use the new format.

**Alternatives considered:**

Alternative 1 — Keep haiku and ratchet the prompt harder ("only cite IDs verbatim"). Rejected because haiku's confabulation is a model-level behaviour, not a prompt-comprehension issue; tightening the prompt reduces inventions on the margin but does not eliminate them, and the false-citation cost dominates the haiku cost saving.

Alternative 2 — Prefilter only (keep haiku). Rejected as a half-measure: prefilter fixes recency bias, but the citation-accuracy gap (haiku invents IDs; sonnet doesn't) remains uncovered.

Alternative 3 — Capture model gated by env var (default haiku, advanced users override to sonnet). Rejected as unnecessary mechanism - capture quality is a system-wide property, and the cost difference at the actual capture cadence is negligible. Per-user opt-out can be added later if cost telemetry shows it matters.




**Related REQ:** [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault) (capture pipeline contract), [REQ-MEM-008](../../sdd/spec/memory.md#req-mem-008-memory-prompt-files-preseeded-via-manifest-pipeline) (preseed manifest includes the new script).

---

### AD59: Zero-UI vault encryption with per-session DO-storage key

**Category:** Security
**Status:** Accepted (2026-05-18)

**Context:** SilverBullet's IndexedDB cache stores every vault file as plaintext on the user's browser profile. Three concerns are coupled: (1) SB cold-start is ~30s on every new session because the per-`:sid` URL produces a new IDB hash every time; (2) plaintext IDB exposes vault content to anyone with read access to the user's browser profile (backup leak, profile theft, ransomware scan); (3) deleted sessions leave orphan IDBs that grow monotonically against the per-origin quota. The team wanted encryption-at-rest without adding a passphrase UI (it would create a "forgotten passphrase" support load and the vault is already coupled to the codeflare login).

**Decision:** Each session's Container DO mints a 32-byte random key on first boot, persists in `ctx.storage`, and exposes it via an RPC method `ensureVaultKey()`. The Worker `/.config` proxy fetches the key via RPC and injects it into SilverBullet's BootConfig. A Worker-side `<script>` injection into the shell HTML exposes `window.__codeflareVaultBoot` carrying the key, raised sync concurrency, and lazy-path prefixes for the SB client to consume. The frontend nukes the per-session IDB on session DELETE and runs an orphan-sweep on Dashboard mount.

**Threat model (BitLocker-grade, not Bitwarden-grade):**
- DEFEATS: offline disk attacks - recovered/stolen browser profile, leaked filesystem backup, ransomware filesystem scan, forensic IDB extraction from a powered-off machine.
- DOES NOT DEFEAT: anyone with an authenticated browser tab on the codeflare origin (they can read `window.__codeflareVaultBoot` directly from page JS); the codeflare Worker operator (the key crosses the Worker on every request); a compromised Cloudflare edge.

**Consequences:**
- Vault contents in IndexedDB become AES ciphertext rather than plaintext markdown - a recovered profile no longer leaks notes.
- The encryption is forward-secret: `container.destroy()` (session DELETE) wipes both the DO key and the browser IDB, so deletion is unrecoverable even by the user.
- The key MUST NOT rotate mid-session - rotation would orphan all existing IDB ciphertext and force re-sync on every container restart, defeating the cold-start optimisation.
- The key is per-session, so cross-session reads remain isolated (each `:sid` has its own IDB hash).
- Worker-side script injection is fragile:

a future SB upstream change to the shell HTML template could break the `</head>` insertion point. The fail-safe is "return HTML unchanged" so a missed injection degrades to a passphrase prompt rather than a white screen.

**Alternatives considered:**

Alternative 1 — Per-user passphrase derived via PBKDF2 from the codeflare password. Rejected - adds a "forgotten passphrase" recovery flow that requires the user to re-enter their vault password on every fresh device, defeating the always-on coupling to the codeflare session.

Alternative 2 — Build SilverBullet from source with native encryption support baked in. Rejected - Deno toolchain in the image adds ~400MB and locks codeflare to a fork rather than tracking SB upstream. Runtime injection through the already-text-rewriting Worker proxy is the lowest-overhead option.

Alternative 3 — Server-side encryption only (rclone bisync to R2 SSE-C, leave IDB plaintext). Rejected - R2 SSE-C already covers at-rest on R2; the gap is the browser cache, which is where the new requirement lives.




**Related REQ:** [REQ-VAULT-008](../../sdd/spec/vault.md#req-vault-008-zero-ui-vault-encryption) (zero-UI vault encryption + cold-start payload + IDB lifecycle), [REQ-VAULT-005](../../sdd/spec/vault.md#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor) (Worker proxy exposes vault editor).

---

### AD60: Pi memory capture reuses the AD58 contract and transcript prefilter

**Category:** Memory

**Status:** Accepted (2026-05-29)

**Context:** [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) raised Claude-side memory-capture quality with three coupled changes (jq prefilter, chunked scratchpad, sonnet-tier model) because the background capture agent was reading raw transcript JSONL, burning its working memory on tool I/O, and confabulating citations. Making Pi a first-class codeflare resident meant Pi had to capture memory at the same fidelity. The Pi extension previously carried a thin inline capture contract embedded in `memory-vault.ts` and sliced the raw last-40 transcript entries, which reproduced exactly the two failure modes [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) fixed: recency bias from raw tool records and weak citation discipline.

**Decision:** Pi memory capture reuses the [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) semantic fidelity and transcript-prefilter contract rather than maintaining a thin Pi-specific one. [AD103](#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs) later replaced Pi's multi-pass scratchpad mechanics with a bounded one-pass execution contract while preserving note shape and citation discipline.

Two full contracts are deployed as Pi-native preseed assets: `preseed/agents/pi/prompts/memory-agent-prompt.md` for capture and `preseed/agents/pi/prompts/vault-extract-prompt.md` for Vault-graph extraction. The generator maps `prompts/` to `.pi/agent/prompts/`, so both land at `~/.pi/agent/prompts/*.md`.

`memory-vault.ts` reads the deployed contracts instead of embedding one inline. Its prefilter retains only user and assistant text, dropping tool-call and thinking blocks before capture and preserving [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)'s prefilter intent on Pi.

**Consequences:**
- Pi captures retain [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)-grade citation discipline and prefiltered arc coverage, but [AD103](#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs) deliberately gives Pi a one-pass medium-reasoning implementation instead of Claude's scratchpad round trips; both populate the same unified graph.
- The capture contract has a single owner in source. A future change to the [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) contract updates the Claude agent files and the Pi prompts from the same intent; the Pi copies are deployed prompts, not a fork.
- The prefilter shifts work to spawn time. The transcript is reduced to user/assistant text before the subagent reads it, so the subagent never sees raw tool I/O and recency bias is structurally prevented as on the Claude path.
- Stale captures written by the old thin-contract Pi path are not migrated; they remain as historical record.
- Later refinement ([REQ-MEM-015](../../sdd/spec/memory.md#req-mem-015-pi-extraction-transcript-visibility-and-child-session-guard), 2026-05-30) changed the prefilter input.
- The prefilter reads the durable `/resume` session transcript via `ctx.sessionManager.getSessionFile()` and `parseSessionMessages`, not the original volatile in-memory message buffer.

That buffer was empty immediately after a Pi reload/resume, so the first capture-boundary prompt produced a hollow "no substantive content" note even though the full session JSONL was on disk; reading the persisted file fixed it, and a skip-empty guard now suppresses the capture rather than writing a placeholder note.
- Later refinement ([REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-15-user-messages), 2026-06-19): Pi treats the `.vars` carrier as the pending-capture lock and advances the prompt counter only after the capture note is written.
- Capture retry impact ([REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-15-user-messages) AC5-AC6): a stopped capture keeps the prior counter and retries after the stale pending marker clears.

<!-- @impl: preseed/agents/pi/prompts/memory-agent-prompt.md::Pi Memory Capture Contract -->
<!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md::Pi Vault Extraction Contract -->
<!-- @impl: scripts/agent-seed-core.mjs::piNativeKey -->
<!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::compactMessages -->
<!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::createMemoryRequest -->
<!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeMemorySuccess -->

**Alternative considered:** Keep the thin inline Pi contract and ratchet its prompt. Rejected for the same reason [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) rejected prompt-only tightening: recency bias is a function of feeding raw tool records to the model, not a prompt-comprehension gap, and a divergent contract drifts from the [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) source of truth over time.

**Related REQ:** [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault) (conversation context automatically captured to Vault), [REQ-MEM-016](../../sdd/spec/memory.md#req-mem-016-pi-extraction-requests-have-a-bounded-execution-profile) (bounded Pi extraction requests), [REQ-MEM-018](../../sdd/spec/memory.md#req-mem-018-pi-extraction-agent-definitions-have-a-bounded-profile) (bounded Pi extraction agent definitions).

---

### AD61: Pi `/review` ships as a dedicated native skill

**Category:** Architecture

**Status:** Accepted (2026-05-29); amended for root-owned report persistence (2026-07-14)

**Context:** The Claude `/review` UX is a slash command (`preseed/agents/claude/commands/review.md`) carrying a multi-phase review workflow. Slash commands are a Claude Code primitive; the generator does not deploy commands to other agents (see the "Excluded from non-CC transformed assets" list in [preseed.md](../lanes/preseed.md#multi-agent-preseed)). On Pi this left the user-invoked `/review` workflow with no home: PR-boundary enforcement was covered by `review-enforcement.ts`, and the transformed `git-review-pipeline` skill carries the enforcement spine, but neither reproduces the full user-driven review flow (scope flags, phased perspectives, reality-filter triage) that the Claude command provides.

**Decision:** Ship the Pi `/review` workflow as a dedicated Pi-native skill at `preseed/agents/pi/skills/review/SKILL.md` (full 11-phase workflow), deployed to `~/.pi/agent/skills/review/SKILL.md`. The native skill is distinct from `review-enforcement.ts` (PR-boundary HEAD watching) and from the transformed `git-review-pipeline` enforcement skill: the skill owns the user-requested review UX, while the enforcement extension owns the automatic PR-boundary gate.

<!-- doc-allow-element: AD61 accepted decision paragraph is preserved verbatim -->
The Pi `review/SKILL.md` joins the Pi manifest as a native skill override so the generator does not also emit a transformed copy of any same-named Claude skill into the Pi skill set. Every `/review` subagent runs in binding report-only mode and returns its report; the root owns report persistence, external verification, triage/ADR/issue mutations, and approved fixes. <!-- @impl: preseed/agents/pi/extensions/review-command.ts::REVIEW_EXECUTION --> <!-- @impl: preseed/agents/pi/skills/review/SKILL.md::Review ownership (binding) --> <!-- @impl: preseed/agents/claude/commands/review.md::Review ownership (binding) --> <!-- @impl: preseed/agents/claude/agents/refactor-cleaner.md::Binding /review override --> <!-- @impl: preseed/agents/claude/agents/tdd-guide.md::Binding /review override --> <!-- @impl: preseed/agents/claude/agents/deep-reviewer.md::Binding /review override -->

**Consequences:**
- Pi users get the full `/review` flow at parity with the Claude command, expressed in Pi-native tool and subagent vocabulary.
- No duplicate review-only agent types are introduced: existing specialist definitions honor `review_mode=report-only` for this workflow and retain their normal behavior outside it.
- The review surface is split by responsibility on Pi: the native skill is the user-invoked path, `review-enforcement.ts` is the automatic PR-boundary path, and the root is the sole mutation owner.

**Alternatives considered:**

Alternative 1 — Transform the Claude `/review` command into a Pi instruction file. Rejected because commands are deliberately excluded from non-CC transforms, and a command is a different surface from a skill; folding command prose into the single Pi instructions file would bury an on-demand workflow in always-on context.

Alternative 2 — Rely solely on `git-review-pipeline` for both enforcement and user-invoked review on Pi. Rejected because the enforcement spine does not carry the phased user-review UX (scope flags, per-perspective passes, reality-filter), so Pi users would lose the `/review` experience entirely.



**Related REQ:** [REQ-AGENT-015](../../sdd/spec/agents.md#req-agent-015-review-command-for-multi-perspective-codebase-review) (`/review` command for multi-perspective codebase review), [REQ-AGENT-044](../../sdd/spec/agents.md#req-agent-044-review-agent-discipline-enforcement) (review-agent discipline enforcement), [REQ-AGENT-050](../../sdd/spec/agents.md#req-agent-050-pi-native-review-workflow-skill) (Pi-native workflow).

---

### AD62: Pi model-name genericization with `CODEFLARE_MEMORY_MODEL` lever

**Category:** Architecture

**Status:** Accepted (2026-05-29)

**Context:** Codeflare is forkable and runs six AI tools; hardcoding a specific model name (for example a `sonnet` or `haiku` literal) into Pi-bound prose or extension code couples the deployment to one vendor's model lineup and goes stale as model names change. [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) pins the capture model for Claude via agent-definition frontmatter, but Pi subagents are spawned programmatically from `memory-vault.ts`, and the generator strips the `model` frontmatter field for runtimes that do not support it. Pi therefore needed a model-selection mechanism that names no model in the shipped artifact.

**Decision:** Two coupled changes. (1) Genericize model references in Pi-bound prose: Pi-facing documentation and extension code describe model selection by role ("higher-fidelity model", "session model") rather than by literal model name. The generator removes `model` frontmatter for runtimes that do not support it while preserving Pi subagent model pins where the runtime does. (2) Introduce the optional `CODEFLARE_MEMORY_MODEL` container env var (documented in [configuration.md](../lanes/configuration.md#container-environment)). When set, `memory-vault.ts` includes it as the `model` option in the visible public `memory-capture` and `vault-extract` requests; when unset, no override is emitted and the subagents inherit the session model. [AD103](#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs) fixes reasoning effort separately at medium.

The lever pins capture/extract fidelity per [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) without a hardcoded model name anywhere in the preseed.

**Consequences:**
- The Pi preseed artifact names no specific model. An operator who wants [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)-grade capture fidelity on Pi sets one env var; the default behavior (inherit session model) is sensible with no configuration.
- Fork-friendliness is preserved: a fork running a different model lineup sets `CODEFLARE_MEMORY_MODEL` to whatever its highest-fidelity model is, with no source edit.
- The Claude and Pi capture paths reach the same outcome ([AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) fidelity) through runtime-appropriate mechanisms: frontmatter pin on Claude, env-var lever on Pi.
- The lever is capture-scoped. It does not change the session's primary model and is read only by the memory/Vault-extract spawn path.

**Alternatives considered:**

Alternative 1 — Hardcode the [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) model literal into the Pi extension. Rejected because it staleness-couples the fork to one vendor's naming and contradicts the no-hardcoded-model-name discipline; a model rename would silently break or mislabel the pin.

Alternative 2 — Reuse `SESSION_MODE` or another existing variable to imply the capture model. Rejected as overloading: `SESSION_MODE` already controls memory persistence and rclone filters, and conflating model fidelity with session mode would make both harder to reason about.



**Related REQ:** [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault) (conversation context automatically captured to Vault), [REQ-AGENT-001](../../sdd/spec/agents.md#req-agent-001-support-multiple-ai-coding-agents) (support multiple AI coding agents).

---

### AD63: Pi `safe-graphify-update.sh` is a thin bounded upstream-update wrapper

**Category:** Architecture

**Status:** Accepted (2026-05-29); revised (2026-06-02, 2026-08-04)

**Context:** [AD53](#ad53-graphify-hot-reload-wrapper-with-multi-repo-sentinel-tracking)'s graphify hot-reload wrapper hardens `graphify update` on the 1 vCPU container by capping virtual memory (`ulimit -v`) and worker count so a runaway AST rebuild dies with ENOMEM instead of OOM-killing the session. Earlier Pi guidance added a divergent two-step wrapper that ran extra clustering/report logic after `graphify update`. That divergence proved brittle as upstream Graphify gained the desired extract/build/cluster/label/report/html pipeline: Codeflare-specific post-processing risked stale IDs, duplicate edges, and drift from official `safishamsi/graphify` output.

**Decision:** The Pi wrapper stays only as a safety envelope around upstream `graphify update`. It resolves the target repository, applies the bounded resource environment (`GRAPHIFY_MAX_WORKERS`, `GRAPHIFY_SAFE_RLIMIT_KB`, and `GRAPHIFY_VIZ_NODE_LIMIT`), then delegates graph output to Graphify. It does not hand-edit graph JSON, normalize imports, apply Codeflare-specific allowlists, or run a custom cluster pass. First-time Pi full AST builds use `build-graphify-ast.sh`, which calls Graphify's own detect/extract/build/cluster/report/export modules for the missing-graph case. Pi Architecture graph builds use `build-graphify-architecture.sh`, which applies generic noise filters and projects Graphify's symbol graph into file/module dependencies for navigation.

Full semantic builds have Pi Agent subagents write Graphify-schema cache chunks/local fragments, recreate a fresh AST-only baseline, and merge cached/new semantic data without passing semantic source files as `prune_sources` (Graphify prunes after adding). Community labeling is optional in Pi and Claude. When requested, the active session writes `.graphify_labels.json` and local Graphify module calls regenerate graph/report/html from existing community assignments. When skipped, Graphify's official report/html remain final and `callflow.html` is exported directly; publication does not require a labels file.

**Consequences:**
- Codeflare keeps the 1-vCPU safety limits without forking Graphify's output semantics.
- Graph IDs, clusters, report contents, and HTML visualization stay compatible with upstream Graphify; optional community labels remain a local presentation layer.
- Pi and Claude Graphify behavior converge around official Graphify flows; Pi-specific code exists only for runtime prompting, architecture-scope filtering/projection, cache production by session agents, active-repo fallback, and resource bounds.
- The structural gate in `codeflare-pi.ts` remains fail-open: a missing or failed graph never blocks user work.

**Alternatives considered:**

Alternative 1 — Keep the previous fail-closed/two-step Pi wrapper. Rejected because the custom post-processing duplicated upstream responsibilities and could reintroduce stale/duplicated graph structure after Graphify upgrades.

Alternative 2 — Run bare `graphify update` without a wrapper. Rejected because the 1-vCPU Codeflare container still needs bounded memory and worker defaults to avoid crashing the session.



**Related REQ:** [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify) (knowledge-graph capability via graphify), [REQ-AGENT-043](../../sdd/spec/agents.md#req-agent-043-graphify-build-mode-dispatch) (graphify build-mode dispatch).

---

### AD64: Durable review lanes load extensions additively behind the `noExtensions` shield

**Category:** Architecture

**Status:** Superseded by [AD76](#ad76-durable-review-lanes-run-as-detached-headless-pi-processes) (2026-06-08)

**Context:** PR-boundary review enforcement ([REQ-AGENT-040](../../sdd/spec/agents.md#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch)/053/054) runs each lane as an in-process `createAgentSession` (`review-jobs.ts::runDurableLane`) with `DefaultResourceLoader({ noExtensions: true })`. That shield exists because extension factories run synchronously during load (pi's `loader.js` `await factory(api)`), and `review-enforcement.ts`'s factory writes a process-global run token (`__codeflareReviewEnforcementRun`) at load time; if a lane loaded that extension in the same process it would overwrite the token and silently disable the **main** session's enforcement (the merge gate). `@gotgenes/pi-subagents` similarly couples in-process state. But the blunt `noExtensions: true` also stripped every useful capability, leaving lanes with only the 7 built-in tools: reviewers had no `graphify_*`, no `ctx_*`, and none of `codeflare-pi`'s guards.

A transient `gh pr view` failure once dropped the merge gate by mis-classifying a live head as stale (the "failure #13" referenced in `review-helpers.ts`); `classifyReviewHead` now separates `stale` from `unknown` to keep the gate fail-closed, and the durable `.git/`-persisted state makes that classification recoverable.

**Decision:** Keep `noExtensions: true` and load capabilities **additively** via `additionalExtensionPaths` (which still load under `noExtensions`): always the graphify package, the `context-mode` package only when enabled in Pi settings (so lanes inherit `/ctx on`), and `codeflare-pi.ts` as a local file (for the local-build blocker, attribution gate, and graphify-first gate). `review-enforcement` and `@gotgenes/pi-subagents` are never added, so neither clobbers the main session. Lane source selection is the pure `review-job-helpers.ts::laneExtensionSources`. `codeflare-pi`'s `session_start` global-graph merge is skipped inside lanes via a `globalThis.__codeflareReviewLaneDepth` counter set by `runDurableLane`, avoiding a redundant `graphify global add` subprocess per lane on the 1 vCPU container.

**Consequences:**
- Reviewers gain graphify and (when enabled) context-mode, and run under the same build-blocker/graphify-first gates as the main agent.
- The `noExtensions` shield is load-bearing and must stay; a future maintainer must not "simplify" by removing it, because that reloads `review-enforcement`'s clobbering factory in-process.
- `extensionsOverride` cannot substitute for this: it filters after factories have already run, so it cannot prevent the load-time global clobber.
- graphify tools spawn bounded Python; lanes are steered (system prompt) to read-only `graphify_query/path/explain`.

**Alternatives considered:**

Alternative 1 — Remove `noExtensions` and filter `review-enforcement` out with `extensionsOverride`. Rejected: factories run during load, so the clobber happens before the filter.

Alternative 2 — Self-guard `review-enforcement` to no-op when loaded in a lane. Rejected as the primary mechanism: it does not cover `@gotgenes/pi-subagents`' in-process coupling, and the additive allowlist is simpler and strictly scopes what a lane can load.



**Related REQ:** [REQ-AGENT-040](../../sdd/spec/agents.md#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch) (PR-boundary lane classification), [REQ-AGENT-071](../../sdd/spec/agents.md#req-agent-071-pr-boundary-review-agent-dispatch) (visible reviewer dispatch), and [AD98](#ad98-pi-pr-review-uses-visible-session-scoped-agents) (the replacement Pi execution model).

---

### AD65: Gemini CLI replaced by Antigravity (agy)

**Category:** Architecture

**Status:** Partially superseded by [AD67](#ad67-antigravity-reads-the-gemini-cli-config-tree-preseed-lane-restored) (2026-06-01): the no-preseed-lane clause only; accepted 2026-05-30, with the remaining decisions active.

**Context:** `@google/gemini-cli` (npm, `gemini` command) was removed from the Dockerfile and entrypoint. The replacement is Antigravity (`agy`), Google's successor CLI, installed via `curl -fsSL https://antigravity.google/cli/install.sh | bash` as a Go-native binary. Because `agy` is not an npm package it is excluded from the V8 compile-cache warm-up step (same as `opencode`). The `~/.gemini/settings.json` auto-update suppressor written by Fast Start is also removed; `agy` has no equivalent config-file suppressor mechanism at this time.

**Decision:** Install Antigravity via its official curl installer in the Dockerfile. Do not add it to the npm `install -g` line. ~~Antigravity gets no preseed adaptation lane (it has no stable config-file convention to target).~~ (Superseded by [AD67](#ad67-antigravity-reads-the-gemini-cli-config-tree-preseed-lane-restored): agy reads the Gemini CLI `~/.gemini/` config tree, so the lane was restored.) The `--filter "- .gemini/tmp/**"` rclone filter excludes only agy's transient tmp dir; the seeded `~/.gemini/` config does sync.

**Consequences:**
- The Gemini CLI interactive agent (`gemini`) is no longer available in containers; users needing the Google AI agent use `agy` instead.
- The Gemini *API* (GEMINI_API_KEY, `/api/llm-keys` geminiApiKey, consult-llm model selector) is unaffected - it is a separate provider, not the CLI agent.
- ~~No preseed documents are generated for Antigravity; it gets no per-agent document set.~~ Superseded by [AD67](#ad67-antigravity-reads-the-gemini-cli-config-tree-preseed-lane-restored): an adapted `.gemini/` lane is generated.

**Related REQ:** [REQ-AGENT-001](../../sdd/spec/agents.md#req-agent-001-support-multiple-ai-coding-agents) (agent CLI pre-install).

---

### AD66: Security-sensitive rate limiters fail closed on KV outage

**Category:** Security

**Status:** Accepted (2026-05-31)

**Context:** `checkRateLimit` ([rate-limit-core.ts](../../src/lib/rate-limit-core.ts)) uses KV as the primary store with a per-isolate in-memory fallback when KV operations fail. The default posture is fail-open: when KV is unreachable, the in-memory map allows the request and the limit is enforced only within a single isolate. Cloudflare fans a Worker out across many isolates, so under a KV outage the effective limit multiplies by the isolate count, silently defeating the limiter. For general resource-protection limiters (UX throttles, read endpoints) this degraded-mode allowance is acceptable. For security-sensitive limiters guarding unauthenticated or mutating endpoints (Turnstile-backed access-request, subscribe, the Stripe webhook), a fail-open KV outage is an availability-for-security trade that lets an attacker amplify abuse precisely when the store is degraded.

**Decision:** Security-sensitive `createRateLimiter` sites pass `failClosed: true`, which makes `checkRateLimit` deny the request (429 with a 60s `Retry-After`) when the KV operation throws, instead of falling back to the per-isolate in-memory map. Purely cosmetic / UX limiters keep the default fail-open posture so a KV blip does not lock users out of read paths. The Stripe webhook limiter ([stripe-webhook.ts](../../src/routes/stripe-webhook.ts)) is `failClosed` because it is an unauthenticated mutation endpoint; the request-access limiter is already `failClosed`. The 429 path also emits advisory `Retry-After` and `X-RateLimit-*` headers set on the Hono context before the `RateLimitError` throw, which survive into the `app.onError` response.

**Consequences:**
- Under a KV outage, security-sensitive endpoints return 429 rather than silently allowing fan-out-multiplied traffic; this is a deliberate availability cost on those few endpoints.
- General limiters are unchanged and still degrade open, so a KV blip does not break read-heavy UX.
- A future maintainer adding a limiter on an auth/mutation/unauthenticated endpoint must set `failClosed: true`; the default remains fail-open by design.

**Alternatives considered:**

Alternative 1 — Make every limiter fail closed. Rejected because a transient KV outage would then 429 read paths and degrade UX for no security benefit on endpoints that are not abuse-sensitive.

Alternative 2 — Replace the per-isolate in-memory fallback with a Durable Object counter to keep a single global count during KV outages. Rejected as disproportionate: it adds a DO round-trip to the hot path of every limited request for a degraded-mode edge case the fail-closed flag already covers correctly.



**Related REQ:** [REQ-SEC-007](../../sdd/spec/security.md#req-sec-007-rate-limiting-infrastructure) (rate-limiting infrastructure - KV primary with in-memory fallback, 429 with advisory headers).

---

### AD67: Antigravity reads the Gemini CLI config tree; preseed lane restored

**Category:** Architecture

**Status:** Accepted (2026-06-01)

**Context:** [AD65](#ad65-gemini-cli-replaced-by-antigravity-agy) replaced the Gemini CLI agent with Antigravity (`agy`) and asserted that `agy` "has no stable config-file convention to target," so the seed generator's `gemini` adaptation lane was deleted. That premise was wrong. Antigravity is Go-native and curl-installed, but it inherits the Gemini CLI configuration tree: Google's migration guidance states that `~/.gemini/GEMINI.md` is "automatically loaded and enforced across all workspaces" and global skills under `~/.gemini/skills/` "load automatically," both unchanged from Gemini CLI. The `GEMINI.md` -> `AGENTS.md` and `.gemini/skills` -> `.agents/skills` renames apply only to per-workspace (repo-root) config; the home-directory global config that codeflare seeds is unaffected.

The deletion was silently masked because the pre-AD65 lane's `.gemini/` output persisted in user R2 buckets and was bisynced back, so `agy` kept reading codeflare's skills/rules even though the generator no longer produced them.

**Decision:** Restore the adaptation lane in `scripts/generate-agent-seed.mjs`, keyed `antigravity`, targeting the home config tree: rules concatenate into `~/.gemini/GEMINI.md`, skills into `~/.gemini/skills/<name>/SKILL.md`, and subagents into `~/.gemini/agents/*.md`. Claude tool names remap to the Gemini CLI vocabulary (`Read`->`read_file`, `Write`->`write_file`, `Edit`->`replace`, `Bash`->`run_shell_command`, `Grep`->`search_file_content`, `Glob`->`glob`). The lane needs no seeding-layer change: `getConfigsForMode` filters by session mode only, not agent type, so every agent's documents seed together and each agent reads its own config dir.

**Consequences:**
- Antigravity sessions receive codeflare's adapted rules, skills, and subagents from a generated source of truth instead of stale bisynced R2 artifacts that drift from the manifest.
- The supersession is partial: AD65's curl-install / no-npm / no-V8-warmup decisions still stand; only the no-preseed-lane clause is reversed.
- A maintainer changing the seeded agent roster must keep the `.gemini` paths home-directory-scoped; the workspace-level `.gemini` -> `.agents` rename does not apply to what codeflare seeds.

**Related REQ:** [REQ-AGENT-006](../../sdd/spec/agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth) (single-source preseed generation), [REQ-AGENT-007](../../sdd/spec/agents.md#req-agent-007-multi-agent-adaptation-pipeline) (multi-agent adaptation pipeline).

---

### AD68: Service-token admin bypass must be environment-gated and hostname-restricted

**Category:** Security

**Status:** Accepted (2026-06-01)

**Context:** `getUserFromRequest` in `src/lib/access.ts` (~L170-205) validates a custom `X-Service-Auth` header against the `SERVICE_AUTH_SECRET` worker secret, checked FIRST - before SaaS GitHub OIDC and before CF Access JWT verification. The header exists because CF Access injects a JWT for service tokens whose audience does not match the app's `access_aud` and strips `CF-Access-Client-Secret` from forwarded requests, so the custom header is the only reliable service-token signal. On a constant-time match the function returns `{ email, authenticated: true, role: 'admin' }` - the caller is trusted as an admin without any KV allowlist lookup.

The bypass is active whenever `SERVICE_AUTH_SECRET` is present and carries no environment guard: there is no check that the deployment is a stress-test or integration environment, no refusal when `SAAS_MODE` is `active`, and no restriction on which hostname the request targeted. The secret is intended for k6 stress tests and E2E runs (see [AD26](#ad26-stress-test-rate-limit-bypass-integration-only)), but nothing structurally prevents the same admin-granting path from being honored on a production SaaS deployment if the secret were ever set there.

**Decision:** The service-token admin bypass must be gated behind `STRESS_TEST_MODE`, never honored when `SAAS_MODE === 'active'`, and hostname-restricted to the non-production test surfaces. This records the accepted direction; the implementation is tracked separately in [codeflare#130](https://github.com/nikolanovoselec/codeflare/issues/130) and is NOT applied in this branch.

Concretely, the accepted shape is: short-circuit the `X-Service-Auth` check entirely unless `STRESS_TEST_MODE` is set to its active sentinel (matching the AD26 rate-limit bypass gate), refuse the bypass on any request where SaaS mode is active so a production SaaS worker can never mint an admin identity from the header, and bind acceptance to the expected test hostnames so a misdirected request to the production host cannot exercise the path.

**Consequences:**
- A production SaaS deployment that inadvertently receives `SERVICE_AUTH_SECRET` no longer grants `role: 'admin'` from a forged-or-leaked `X-Service-Auth` header, because the `SAAS_MODE === 'active'` refusal and the `STRESS_TEST_MODE` gate both fail closed.
- The stress-test and E2E flows are unaffected: those environments already set `STRESS_TEST_MODE` and run against the integration hostname, so the bypass continues to work exactly where it is needed.
- Environment separation stops being the only control:

the bypass is now defense-in-depth (env scoping at deploy time PLUS a runtime guard in the auth path), aligning the service-token surface with the trust model the rest of the auth chain already enforces.
- Until [codeflare#130](https://github.com/nikolanovoselec/codeflare/issues/130) lands, the current behavior stands and the residual risk is mitigated only by GitHub Actions environment scoping of the secret (same posture as [AD26](#ad26-stress-test-rate-limit-bypass-integration-only)).

**Related REQ:** [REQ-AUTH-004](../../sdd/spec/authentication.md#req-auth-004-service-token-authentication-for-service-automation) (service-token authentication), [REQ-AUTH-011](../../sdd/spec/authentication.md#req-auth-011-auth-resolution-order) (authentication resolution order).

---

### AD69: SilverBullet vault runs its native service worker for persistent, encrypted client indexing

**Category:** Architecture

**Status:** Accepted (2026-06-01)

**Context:** Within a single browser SilverBullet (SB) rebuilds its IndexedDB index from scratch on every cold load ([codeflare#445](https://github.com/nikolanovoselec/codeflare/issues/445)): a browser restart against a still-running session, same `:sid`, same encryption key, re-crawls and re-indexes the entire vault over HTTP.

Three independent signals confirm the cause. (1) Runtime console logs show the space read path is `evented -> checked -> http_space_primitives` (straight to network, no local datastore primitive), the boot logs `Not loading space scripts, since full indexing has not completed yet`, and only `sb_data_*` ever appears in IndexedDB, never `sb_files_*`. (2) SilverBullet 2.8.1 source (`client/service_worker.ts`, `client/boot.ts`) shows the sync engine and the persistent local file store (`sb_files_*`) live exclusively in SB's real service worker;

codeflare replaces that worker with `VAULT_KEY_SHIM_SERVICE_WORKER_JS` (`src/lib/vault-view.ts`), a key-bridge-only shim with no fetch handler, so the local file mirror is never created and SB has no resumable snapshot. (3) SB v2's architecture keeps the query index in the browser (client Datastore / IndexedDB); the server stores only raw files plus an RPC surface and has **no server-side query index**, so a "thin client, nothing on the browser" model is not achievable with stock SB 2.8 - the index, which carries page content, is unavoidably a browser artifact.

Two facts from the SB 2.8.1 source reshape the fix. First, SB's real service worker **natively** implements `set-encryption-key` / `get-encryption-key` over an in-SW `encryptionKeyMemoryStore`; the codeflare shim merely re-implements behaviour SB already ships, and the bootstrap-hop's `postMessage` works against the real worker unchanged. Second, the shim exists only because SB's real worker fails to install under codeflare's auth gate: its `install` handler runs `cache.addAll(precacheFiles)`, which rejects on any non-2xx response, and per the existing `isServiceWorkerRegistration` comment one precached path (the vault root) 302-redirects to the bootstrap-hop when the bootstrap cookie is absent, hanging `navigator.serviceWorker.ready`.

Separately, two encryption layers already coexist and are independent of SB's mode: rclone R2 SSE-C (`ENCRYPTION_KEY`, `entrypoint.sh`) encrypts the vault at rest in R2, and [AD59](#ad59-zero-ui-vault-encryption-with-per-session-do-storage-key) / [REQ-VAULT-008](../../sdd/spec/vault.md#req-vault-008-zero-ui-vault-encryption) client-side IDB encryption (`vaultKey`) protects the unavoidable browser index against profile theft (BitLocker-grade).

**Empirical validation (2026-06-01):** a headless-Chrome (puppeteer) probe against the in-container SB server confirmed the mechanism directly. Against raw SB - real service worker, codeflare key-shim out of the path - both `sb_data_*` and `sb_files_*` IndexedDB stores are created, and a reload re-indexes **zero** files (`Initial index complete, loading full page list via index.`) rather than the full re-crawl observed under the shim (hundreds of `Indexing file` lines per load in production console captures). This proves SB's native service worker is the persistence layer and that suppressing it via the key-shim is the direct cause of #445.

The probe covers the SB-native half only; the codeflare-proxy half (serving the real worker past the auth gate and the `/` bootstrap-302) remains to be verified on the integration deployment, since the Worker's Cloudflare bindings cannot be faithfully reproduced locally.

**Integration finding (2026-06-01, `SB-fix`):** the first integration deploy served the native worker WITHOUT the recovery graft (to observe). It reproduced the keyless-`.auth` bounce predicted below - but on **cold boot**, not only after idle. Reading the vendored 2.8.1 worker explains why: it not only holds the key in module memory (lost on idle-termination) but actively flushes it `5s` after the last client disconnects (`"No more clients, flushing encryption key", y=void 0`). During the bootstrap-hop -> `location.replace('/')` transition the client count momentarily drops, so the key can be gone before the shell boots. The graft is therefore mandatory for cold boot too, not just the mobile idle case.

<!-- doc-allow-element: AD69 accepted decision paragraph is preserved verbatim -->
A first attempt grafted only the `get-encryption-key` handler and STILL bounced to `.auth` - because that is not the path that fails. The actual trigger is the worker's **`config`** message handler: when the client posts `config` with codeflare-injected `enableClientEncryption:true` while `y` is empty, the gate `if(t.enableClientEncryption&&!y)` posts `auth-error` -> client navigates to `.auth` (console: "Supposed to use encryption, but no phrase set yet, auth error"). It reads `y` directly, never asking `get-encryption-key`. So `graftVaultKeyRecovery` (`src/routes/vault/native-sw.ts`) injects a shared `__cfRecover()` helper (re-fetch + decode from `/.vault-key`) and calls it at BOTH `y`-empty failure points - the `config` auth-gate (the load-bearing one) and the `get-encryption-key` reply - before either gives up. An `activate`-handler graft remains unnecessary.

The same deploy also resolved the `/.client/*` precache-auth question (the other half of the decision below): the native worker reached `activated` and SB booted under its control, which can only happen if `install` -> `cache.addAll(precacheFiles)` resolved, i.e. the `/` and `/.client/*` precache fetches all returned 2xx. Service-worker `fetch()` carries same-origin credentials, so the precache fetches send the session cookie and pass the normal auth chain - no static-asset exemption is required. The exemption is therefore NOT implemented; the precache-auth exemption ([REQ-VAULT-017](../../sdd/spec/vault.md#req-vault-017-silverbullet-native-service-worker), the native-SW contract) stays reserved as a fallback only if a future browser strips credentials on precache fetches.

**Verified (2026-06-01, mobile, integration):** the final deploy (graft at both checkpoints) cleared the bug end-to-end. Console: "47 client files cached" (precache OK), "Activating new service worker!", "[Service Worker] Using IndexedDB database sb_files_..." (the persistent SW-context store, ABSENT under the shim - the direct #445 fix), "Recovered encryption key from codeflare" (the graft fired because the hop's posted key had already been flushed), no `auth-error` / `.auth` redirect, and the sync engine running "[Sync] Completed: 0 operations" cycles. The one-time first-load index (81 `Indexing file` lines) populates `sb_files_*`; the store now persists, so subsequent cold loads are incremental. AD69 is fully realized: `VAULT_KEY_SHIM_SERVICE_WORKER_JS` and its tests have been removed. REQ-VAULT-008 and REQ-VAULT-013 moved to Implemented.

**Decision:** Keep SB in sync mode and run SB's **native** service worker in place of the key-shim, so the client index persists and indexing is incremental (resolving #445), while preserving client-side encryption (AD59).

The implementation, integration-iterated on the `SB-fix` branch: serve SB's real `service_worker.js` for the registration GET via Worker-side container auth (the credential-stripped registration GET cannot pass the user-cookie chain); make `cache.addAll` succeed by not 302-redirecting service-worker-context fetches of the shell path to the bootstrap-hop, and by auth-exempting the static client-bundle asset paths (open-source SB frontend bytes, zero user data - the same safety basis as the existing `service_worker.js` bypass), while data endpoints (`.fs/`, `.config`, file content) stay auth-gated; retain the bootstrap-hop solely for encryption-key delivery, since the real worker's `set-encryption-key` handler is native.

Critically, the codeflare-served worker must NOT be SB's stock worker: SB's native worker has no key auto-recovery (its `get-encryption-key` returns only the in-memory key, and SB boot hard-redirects to `.auth` and throws when the worker has none), whereas the current shim adds `.vault-key` recovery (fetch `GET .vault-key` on `activate` and on a keyless `get-encryption-key`) for [REQ-VAULT-024](../../sdd/spec/vault.md#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC5.

Cold boots are covered because the session-scoped bootstrap cookie re-runs the hop (and its `set-encryption-key` post), but a mid-session service-worker idle-termination - relevant on the mobile-first surface - would leave the native worker keyless and break the encrypted open. So codeflare must serve SB's real worker WITH the shim's `.vault-key` recovery grafted into its key-empty checkpoints - the `config` auth-gate AND the `get-encryption-key` reply (the integration finding above showed the `config` gate is the one that actually fires, and that an `activate` graft is unnecessary) - keeping both the native sync engine and the keyless-recovery.

Note encrypted persistence itself is unaffected: `EncryptedKvPrimitives` wraps values inside the same `sb_data_*` / `sb_files_*` stores, so the proven `sb_files_*` creation and incremental reload hold with encryption on. Retire `VAULT_KEY_SHIM_SERVICE_WORKER_JS` once the grafted real-worker path is verified on integration. Validation is integration-only (service-worker install and sync behaviour are not meaningfully unit-testable): verified by a cold reload showing incremental sync rather than full reindex, and DevTools showing `sb_files_*` present.

`SB_DISABLE_SERVICE_WORKER` and `SB_READ_ONLY` are rejected. Disabling the worker does not move the index server-side (SB v2 has none), still re-indexes client-side, and removes the SW-hosted encryption key store - leaving the browser index in **plaintext**, strictly worse for the AD59 threat model. `SB_READ_ONLY` disables all writes, which the vault cannot accept.

**Consequences:**
- #445 resolved: `sb_files_*` persists and sync becomes incremental, eliminating the cold-boot full reindex; the per-load broken-wikilink 404 walk (342 distinct dangling `[[links]]` in `Raw/Sessions/*.md` captures) collapses from every-load to once-per-change.
- Client-side encryption (AD59 / REQ-VAULT-008) is preserved and now clearly load-bearing rather than redundant: SB v2 forces a content-bearing index into the browser, so encrypting it is justified, and R2 SSE-C continues to protect the at-rest copy independently.
- New auth surface: the static client-bundle asset paths become auth-exempt. The exemption MUST be enumerated precisely during implementation so no user-data path (`.fs/`, `.config`, attachments) is ever exempted; it is bounded to open-source frontend bytes.
- Offline editing returns as a side effect of restoring sync mode. Not required by the user, but not harmful.
- Risk: the real ~97KB worker interacts with the live vault auth chain, and a prior attempt (`silverbullet-index` branch) stalled on boot timeouts.

Mitigated by integration-only rollout and keeping the shim available as a one-line revert until the native path is proven.

**Related REQ:** [REQ-VAULT-008](../../sdd/spec/vault.md#req-vault-008-zero-ui-vault-encryption) (zero-UI vault encryption), [REQ-VAULT-024](../../sdd/spec/vault.md#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) (bootstrap-hop key arming and service-worker retention), [REQ-VAULT-017](../../sdd/spec/vault.md#req-vault-017-silverbullet-native-service-worker) (SilverBullet native service worker), [REQ-VAULT-025](../../sdd/spec/vault.md#req-vault-025-silverbullet-native-service-worker-runtime-graft) (native service-worker runtime graft), [REQ-VAULT-013](../../sdd/spec/vault.md#req-vault-013-silverbullet-subpath-adapter) (SilverBullet subpath adapter), [REQ-VAULT-015](../../sdd/spec/vault.md#req-vault-015-vault-idb-lifecycle-and-listing-filters) (vault IDB lifecycle). Supersedes the shim rationale documented in [vault.md - Service Worker registration noop bypass](../lanes/vault.md#service-worker-registration-noop-bypass). Tracks [codeflare#445](https://github.com/nikolanovoselec/codeflare/issues/445).

---

### AD70: Container exit writes KV `stopped`; no read-side reconciliation

**Category:** Architecture

**Status:** Accepted (2026-06-02)

**Context:** Two user-facing symptoms shared one defect. (1) A live session was falsely flipped to `stopped` and the user bounced to the dashboard; reopening showed "Starting session" then instantly green. (2) A container that exited unexpectedly (crash, deploy-roll, or platform idle-reap) dangled as `running` in KV forever and had to be deleted by hand. Production observability (96h) proved the chain: when a container exits via an unexpected path the SDK (`@cloudflare/containers` v0.3.5) calls `onError()`, **not** `onStop()`; `onError` only logged, `collectMetrics`'s `!running` branch only logged-and-returned, and `onStop` (which does write `stopped`) was never invoked. So KV dangled at `running` and the heartbeat `metrics.updatedAt` froze.

A read-side heuristic, `reconcileStaleStatus` (added in [#459](https://github.com/nikolanovoselec/codeflare/pull/459)), then inferred `stopped` from the stale heartbeat age on the dashboard poll - which is exactly what produced the false kick on still-live sessions whose alarm loop had legitimately paused. The June 1→2 incident was a deploy (the user's agent merging a PR to main) that rolled the container → `Container error` with no KV write. Over 96h the SDK `onActivityExpired` fired 0 times (the `sleepAfter='24h'` pin holds), 69/72 clean stops were manual `destroy()`, and 7 `Container error` events each leaked a dangling session.

**Decision:** Make KV `status` the single authoritative source of truth and delete the read-side guess. (a) `onError()` writes `stopped` via the shared `updateKvStatus()` helper, guarded on `!ctx.container.running` so a transient startup error cannot flip a still-starting container. (b) `collectMetrics()`'s `!running` branch writes `stopped` on the next 60s tick as the catch-all for any exit the hooks missed. (c) `reconcileStaleStatus` and its `STALE_RUNNING_MS` constant are removed; all five call sites (`routes/session/{crud,lifecycle}.ts`, `routes/container/lifecycle.ts`) return the raw KV status. `metrics.updatedAt` / `m.u` is **kept** but is display-only (metrics-staleness), never a liveness signal.

Safety rests on `updateKvStatus` re-reading sessionId/bucketName from DO storage and the session from KV on every call, and `destroy()` clearing those identifiers first - so a post-destroy write no-ops instead of resurrecting a deleted record (the same invariant as [AD6](#ad6-kv-read-modify-write-races-and-collectmetrics-atomicity)). Whether a session should **survive** a deploy at all (container persistence across Worker versions) is explicitly out of scope.

**Consequences:**
- Dangling `running` is eliminated: a container that exits for any reason converges to `stopped` within ~60s without manual deletion.
- The false kick is eliminated at the root: with no heartbeat-age heuristic, a live-but-idle session can never be inferred `stopped` from a paused alarm loop.
- The dashboard becomes a pure mirror of KV `status`; the frontend `running→stopped` disposal path (REQ-SESSION-010 AC7) stays, but now fires on the authoritative KV status written on exit (REQ-SESSION-018 AC1) rather than a read-side guess.
- Trade-off: a brief, accurate `stopped` can appear during a failed start before `onStart()` re-asserts `running`. Acceptable - it reflects reality.

**Related REQ:** [REQ-SESSION-018](../../sdd/spec/session-lifecycle.md#req-session-018-persisted-status-is-authoritative-on-container-exit) (persisted status authoritative on container exit) and [REQ-SESSION-010](../../sdd/spec/session-lifecycle.md#req-session-010-session-status-observable-from-dashboard) (session status observable from dashboard). Tracks [codeflare#153](https://github.com/nikolanovoselec/codeflare/issues/153). Refines [AD6](#ad6-kv-read-modify-write-races-and-collectmetrics-atomicity).

---

### AD71: Preseed corpus statically imported into the Worker bundle; bound by compressed bundle size, CI-guarded

**Category:** Architecture

**Status:** Accepted (2026-06-03)

**Context:** The agent preseed corpus (`src/lib/agent-seed.generated.ts`, ~3.9 MB on disk / ~1 MB gzipped) is statically imported at module top level: `src/lib/r2-seed.ts` does `import { AGENTS_SEEDED_CONFIGS } from './agent-seed.generated'`. A static top-level import lands the full corpus in the Worker bundle that is shipped on every deploy, so the corpus competes for the same byte budget as application code. Cloudflare Workers enforces the limit on the **gzipped** bundle, and the paid-plan ceiling is 10 MB gzipped, so the relevant bound is the ~1 MB gzipped contribution of this corpus against that 10 MB headroom, not the 3.9 MB on-disk figure.

**Decision:** Accept the static import for now. The corpus is read once at seed time and the static import keeps the seed path synchronous and simple, which is worth the bundle cost while the gzipped corpus is ~1 MB against a 10 MB gzipped ceiling. The bound MUST be guarded by a CI check on the gzipped Worker bundle size so the corpus cannot silently grow the bundle toward the ceiling between deploys.

The structural escape hatch, taken as the gzipped bundle approaches the ceiling, is to stop statically importing the corpus: either relocate it to R2 and fetch it at seed time, or convert the top-level import to a lazy `await import('./agent-seed.generated')` so it is only pulled when seeding actually runs. Either path removes the corpus from the always-shipped bundle.

**Consequences:**
- The corpus ships in every Worker bundle and is counted against the gzipped size limit; a CI bundle-size check is the guardrail that keeps this from regressing.
- The seed path stays synchronous and simple while the corpus is small relative to the ceiling.
- Trade-off: corpus growth is bounded by deploy mechanics rather than by application need; once the CI check trends toward the ceiling, the R2-relocation / lazy-`import()` escape hatch must be taken rather than raising the budget.

**Related REQ/finding:** Recorded from finding CF-011 (preseed corpus bundle-size bound). Relates to [AD3](#ad3-per-user-r2-buckets) (per-user R2 buckets) as the R2-relocation target for the escape hatch.

---

### AD72: Outbound-HTTPS interception over a Worker-side LLM proxy for enterprise gateway routing

**Category:** Architecture, Security

**Status:** Accepted (2026-06-05). Interception mechanism stands; its upstream transport (gateway endpoint, auth header, agent set) is amended by [AD74](#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api).

**Context:** Enterprise Mode must route all agent LLM traffic (Claude, Copilot, Pi) through the customer's AI Gateway without exposing gateway credentials to the container or creating a new public HTTP route. Three approaches were evaluated:

1. **Worker-side `/llm-proxy` route:**

A public Worker route that the container calls instead of the real provider. The container env would need the Worker's own URL (a non-secret), but the route is publicly reachable over Cloudflare Access, adding an Access-policy attack surface and a round-trip through the internet. The route also requires rewriting every agent's base-URL to point at the Worker, and every agent would need a container-env credential to authenticate against that route.

2. **Credential injection into the container:**

Pass `AIG_GATEWAY_URL` and `AIG_TOKEN` directly to the container via env vars and let each agent use them directly. This keeps the gateway URL and token accessible from within the container, contradicting the operator's expectation that gateway credentials stay out of user-reachable surfaces (terminal, any future agent file-read path).

3. **Platform outbound-HTTPS interception (`ctx.container.interceptOutboundHttps` + `ctx.exports`):**

The Container DO wires a `WorkerEntrypoint` (`LlmInterceptor`) into the platform's outbound-HTTPS interception mechanism. The platform TLS-terminates the container's connections to the real provider hosts and delivers them to the interceptor. The interceptor forwards to the AI Gateway with the real credentials. The gateway URL and token live only in the Worker environment; the container never sees them. The container communicates with the real provider host as if it were not intercepted — no base-URL rewrite, no new auth surface.

**Decision:** Use platform outbound-HTTPS interception (option 3). The `LlmInterceptor` WorkerEntrypoint is exported from `src/index.ts` and wired via `ctx.container.interceptOutboundHttps` in `src/container/container-interception.ts::wireContainerInterception`. `ctx.exports` is default-on at compat date `2026-02-05`; no `enable_ctx_exports` flag is needed (the earlier draft constraint referencing that flag was removed before implementation).

**Consequences:**

- Gateway credentials (`AIG_GATEWAY_URL`, `AIG_TOKEN`) never enter the container. The container only receives `ENTERPRISE_MODE=active` (a non-secret deploy var) and a constant non-secret placeholder credential for CLI initialization.
- The container must trust the Cloudflare containers CA (`/etc/cloudflare/certs/cloudflare-containers-ca.crt`) so TLS-intercepted connections validate. `entrypoint.sh` installs it on every Enterprise Mode boot.
- No new public Worker route is created; gateway traffic is platform-internal and cannot be targeted by external requests or CF Access policies.
- When `ENTERPRISE_MODE` is unset, `interceptOutboundHttps` is never called, and the codebase is byte-identical to a non-enterprise deployment (no interception overhead, no CA install).
- Trade-off accepted: the platform interception mechanism is Cloudflare-specific. If the project were ever migrated off Cloudflare Containers, enterprise gateway routing would need a different mechanism (likely option 1 or 2).

**Related:** [REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [Architecture - Enterprise LLM Routing](../lanes/architecture.md#enterprise-llm-routing), [Security - Enterprise Mode](../lanes/security.md#enterprise-mode-credential-containment-and-ca-trust).

### AD73: workers.dev enabled on every deployment for setup-wizard bootstrap

**Category:** Security

**Status:** Accepted (2026-06-05)

**Context:** The setup wizard bootstraps on the `<worker>.<account>.workers.dev` URL — on a fresh deploy that is the only reachable host, because the custom domain does not exist until the wizard provisions it. An earlier config set `workers_dev = false` to lock the deployment to the custom domain only (citing OAuth host-mismatch risk and a larger auth surface). That is a chicken-and-egg break: a first-time deploy into a fresh account — most importantly an Enterprise tenant in a separate Cloudflare account — has no custom domain and therefore no URL at all, so the wizard can never run. Disabling workers.dev makes initial setup impossible.

**Decision:** Set `workers_dev = true` in `wrangler.toml` for every deployment and every environment (production, integration, enterprise, and any future target). The workers.dev URL is the mandatory bootstrap host the wizard runs on; after it provisions a custom domain, normal traffic flows through that domain while the workers.dev URL remains the always-available bootstrap/fallback host. The earlier enterprise-only deploy-time `sed` that flipped the flag was removed in favor of this single source of truth.

**Consequences:**

- Initial setup works on any fresh deploy, including a brand-new Cloudflare account, with no manual custom-domain step first.
- Every deployment also exposes a public `*.workers.dev` URL alongside its custom domain.

This does not bypass authentication: every protected route is gated regardless of host — Cloudflare Access in default/enterprise mode, GitHub-OIDC session cookies in SaaS mode (see [AD10](#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation), [AD68](#ad68-service-token-admin-bypass-must-be-environment-gated-and-hostname-restricted)).
- **Operator responsibility:**

turning on Cloudflare Access for the `*.workers.dev` hostname is the operator's job, not the deployment's. The deploy enables the URL but cannot attach an Access policy to it; in CF Access mode the operator must enable Cloudflare Access on the workers.dev hostname in the Cloudflare dashboard so the bootstrap URL is not left open after setup. (The wizard configures Access for the custom domain; the workers.dev host is the operator's to protect.)
- The `.workers.dev` CORS allowance is an already-accepted, bounded trade-off ([AD11](#ad11-suffix-pattern-cors-with-credentials)): dot-prefixed matching prevents `evilworkers.dev`, and custom domains supersede the wildcard after setup.
- The pre-setup window (before auth is configured) is the same bounded bootstrap window analyzed in [AD10](#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation): seconds-to-minutes, operator/self-hosted audience, idempotent setup.

**Related:** [AD10](#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation), [AD11](#ad11-suffix-pattern-cors-with-credentials), [AD68](#ad68-service-token-admin-bypass-must-be-environment-gated-and-hostname-restricted), [Architecture](../lanes/architecture.md), [Configuration](../lanes/configuration.md).

### AD74: Enterprise LLM transport on the AI Gateway REST API

**Category:** Architecture, Security

**Status:** Accepted (2026-06-05)

**Context:** [AD72](#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing) established platform outbound-HTTPS interception as the enterprise LLM transport, forwarding intercepted provider traffic to the customer's AI Gateway. The original implementation targeted the gateway's legacy endpoints on `gateway.ai.cloudflare.com` — the OpenAI-compatible `/compat/chat/completions` path and the provider-native `/anthropic/v1/messages` path, authenticated with the `cf-aig-authorization` header. Cloudflare has since **deprecated** those paths (they "continue to work for existing integrations") and recommends the REST API at `api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/*` (standard `Authorization` header) for new integrations.

Building enterprise on a deprecated surface was latent migration debt; a live smoke test against the `codeflare-enterprise` gateway confirmed the REST API supports everything the transport needs — dynamic routing via `model: "dynamic/<route>"`, SSE streaming, `cf-aig-metadata` attribution, BYOK + Workers AI.

A second finding shaped the design: the REST API requires author-prefixed model ids (`anthropic/claude-…`) on its Anthropic-compatible `/ai/v1/messages` endpoint, while Claude Code emits a bare `claude-…` model — which would force the interceptor to buffer-and-rewrite each request body, breaking the zero-copy passthrough. Every other enterprise agent (Copilot, Pi) speaks the OpenAI chat-completions format and can reach any backend — native Anthropic/OpenAI, Amazon Bedrock, or Workers AI — through the one OpenAI-compatible REST endpoint by model id, with no rewrite.

**Decision:** Migrate the `LlmInterceptor` transport off the deprecated `/compat` + `/anthropic` paths onto the REST API at `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/*`, authenticated with the standard `Authorization: Bearer <AIG_TOKEN>` header and routed with `cf-aig-gateway-id`. The account id and gateway id are parsed from the existing `AIG_GATEWAY_URL` secret (no new binding). **Drop Claude Code from the enterprise agent set** ([REQ-ENTERPRISE-003](../../sdd/spec/enterprise-mode.md#req-enterprise-003-agent-allowlist-in-enterprise-mode)): with only OpenAI-wire-format agents remaining, the interceptor needs no format translation and intercepts only `api.openai.com`. It performs one targeted request edit — **gateway route-pinning** (see amendment below) — substituting only the `model` field; the response is always streamed zero-copy.

The interception mechanism from [AD72](#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing) is unchanged — only the upstream target, auth header, and agent set change.

**Consequences:**

- The transport is on Cloudflare's recommended, non-deprecated surface; no migration debt.
- The response is a zero-copy streaming passthrough.

The request body is passed through except for gateway route-pinning, which substitutes only the `model` field on a (small) chat request; no format translation or response buffering occurs because the agent set is OpenAI-format-only.
- ~~Backend selection — native provider, Amazon Bedrock, Workers AI, or a dynamic route with rate-limit/budget/fallback — is entirely gateway-side via the route id in `AIG_LANGUAGE_MODEL` (e.g.

`dynamic/<route>`), which the interceptor stamps onto each request (route-pinning, below). Agents carry only a fixed slash-free handle, never the route id.~~ codeflare holds no provider keys; BYOK lives in the gateway. *(Route selection superseded by the catalog-driven routing amendment 2026-06-09 below: backend selection is now mapped from the Setup-configured catalog via `loadRouteCatalog`, and `AIG_LANGUAGE_MODEL` is removed.)*
- `api.anthropic.com` is no longer intercepted and Claude Code is not selectable in enterprise mode; Anthropic models remain available via Copilot/Pi by model id.
- **The `AIG_TOKEN` and `AIG_GATEWAY_URL` *bindings* are reused.** No new secret or deploy var is added; the URL is now also parsed for account + gateway, and the token moves from the `cf-aig-authorization` header to `Authorization`.

  **The token's required type/scope changes, however.** The `/ai/v1/*` endpoint takes a Cloudflare API token in `Authorization`, **not** the `cf-aig-authorization` gateway *authentication* token the deprecated `/compat` path used (the REST API rejects that type with `error 10000`).

  Live testing 2026-06-05 pinned down the operative permission: the `/ai/v1/*` surface is the **Workers AI** namespace, so a CF API token with **Workers AI** (`Read`/`Edit`) succeeds end-to-end through the gateway's dynamic route, while a token scoped only to **`AI Gateway: Run`** is *also* rejected with `error 10000`.

  Cloudflare's docs phrase the requirement loosely as "a Cloudflare API token that has AI Gateway permission" and point operators at the gateway's **Create authentication token** button ([REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/) · [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)) — but that button mints an **`AI Gateway: Run`** token (confirmed by the operator, twice) which this endpoint rejects, so it is the wrong tool here.

  The empirically-confirmed permission is **Workers AI**, created manually as a CF API token. An operator migrating an existing enterprise deploy must reissue `AIG_TOKEN` accordingly (see [configuration.md](../lanes/configuration.md#enterprise-mode-secrets-optional)).
- Flag-unset parity preserved: when `ENTERPRISE_MODE` is unset the interceptor is never instantiated and non-enterprise behavior is byte-identical.
- Operator dependency: third-party models require BYOK provider keys (or Unified Billing) configured on the gateway; a dynamic route is the recommended way to consume BYOK keys with availability/rate-limit/budget control.

**Route-pinning amendment (2026-06-05):** A gateway route is invoked by sending `model: dynamic/<route>` in the request body. Configuring that id *in the container* failed for Pi: Pi parses a slash in a model id as `provider/model`, so `dynamic/codeflare-enterprise` bound to a built-in provider (amazon-bedrock — falsely "authenticated" by the container's R2 S3 keys, which are exported under the generic `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` names) and was signed as a SigV4 call that never reached `api.openai.com` — empty gateway logs, looking like a broken route.

Resolution: the route id stays a **Worker-only var** (`AIG_LANGUAGE_MODEL`, no longer fanned into the container); agents are configured with a fixed slash-free handle (`codeflare`) so they reliably route to `api.openai.com`; and the `LlmInterceptor` rewrites the request `model` to `AIG_LANGUAGE_MODEL` on egress (only for `/chat/completions` and `/responses`; non-JSON or model-less bodies pass through untouched). This keeps the route name out of the container entirely and lets the operator change routes by editing one Worker var with no agent reconfig.

Pi is additionally pinned via `~/.pi/agent/settings.json` `defaultProvider`/`defaultModel` so it is gateway-bound zero-touch; Copilot's BYOK uses the complete 3-var contract (`COPILOT_PROVIDER_BASE_URL` + `COPILOT_PROVIDER_API_KEY` + `COPILOT_MODEL`=handle), with `GH_TOKEN` left in place for GitHub-hosted features (the documented fallback if Copilot ever ignores BYOK is `COPILOT_OFFLINE=true`).

**Dual-transport amendment (2026-06-07):** The migration above moved the transport onto the REST API as Cloudflare's "recommended, non-deprecated surface" — but the 2026-06-05 smoke test that justified it only exercised OpenAI + Workers AI. A later live evaluation (selecting Gemini through a dynamic route) found the REST API at `api.cloudflare.com/.../ai/v1/*` **does not carry the `google-ai-studio` provider**: every Gemini model id returns `404 Model not found`, and a dynamic route resolving to a Google node returns the masked `404 Model execution failed`. The same model/route works on the **deprecated** `gateway.ai.cloudflare.com/v1/{acct}/{gw}/compat/chat/completions` path (confirmed against a sibling Worker using BYOK + `cf-aig-authorization`). So Cloudflare's recommended REST surface is, today, *less capable* than the deprecated compat surface.

Resolution: the `LlmInterceptor` now uses **both transports** — it sends to the REST API first and, only on a `404` for a model-routable request, **replays the (buffered) request to the compat path**. The retry is safe because a 404 is a complete error body, not a started stream (no double-billing, no truncation), and harmless on genuine failures (worst case: one extra fast round-trip). As Cloudflare migrates providers onto the REST API the 404 stops and traffic rides the REST API automatically — no code change.

**Token-scope consequence (supersedes the `AIG_TOKEN` consequence above):** because the two transports authenticate differently — REST API via `Authorization: Bearer` (Workers AI scope), compat via `cf-aig-authorization: Bearer` (AI Gateway Run scope) — `AIG_TOKEN` must now carry **BOTH** Workers AI **and** AI Gateway Run permissions (a token with only one is rejected by the other transport with `error 10000`). This narrows the original "no migration debt" consequence: the transport still depends on the deprecated compat path for any provider not yet on the REST API (Google today), until Cloudflare closes the gap.

**Compat field-strip + email attribution amendment (2026-06-07):** Two further consequences surfaced once Gemini traffic actually reached `google-ai-studio` via the compat leg. (1) Non-OpenAI providers reject OpenAI-only request fields: Google returns `400 Invalid JSON payload received. Unknown name store` (and would next reject `prompt_cache_key`). Cloudflare's compat layer forwards these fields verbatim, so the interceptor strips `store` and `prompt_cache_key` **only on the compat replay** — the REST/OpenAI leg keeps them, so OpenAI prompt caching (which does not depend on `store`) is unaffected. (2) Per-user attribution: `cf-aig-metadata.user` now carries the IdP-verified **email** (from the container DO's `_userEmail`, falling back to the bucket id) rather than the opaque bucket id, so the customer's gateway analytics attribute usage to a real identity.

This intentionally overrides REQ-ENTERPRISE-004's original "does not expose the user's email" wording — an accepted enterprise attribution requirement; the email stays within the customer-owned Cloudflare account.

**Catalog-driven routing + multi-group attribution amendment (2026-06-09):** Two changes supersede earlier mechanisms in this ADR. (1) **Route selection moves from the single `AIG_LANGUAGE_MODEL` Worker var to a Setup-configured catalog** ([REQ-ENTERPRISE-012](../../sdd/spec/enterprise-mode.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list)): the setup wizard persists an unlimited route list plus one optional default `route:reasoning` in KV (`setup:dynamic_routes`, `setup:default_route`), editable with no redeploy; `AIG_LANGUAGE_MODEL` and its `deploy.yml` plumbing are **removed**. The `LlmInterceptor` now maps the agent's slash-free handle to `dynamic/<route>` from the catalog (`loadRouteCatalog`), failing safe to the resolved default on an unknown handle — superseding both the route-pinning amendment's single-var stamp and the `AIG_LANGUAGE_MODEL` backend-selection consequence above.

The catalog/default/reasoning are fanned to the container (`ENTERPRISE_ROUTE_CATALOG` / `ENTERPRISE_DEFAULT_ROUTE` / `ENTERPRISE_DEFAULT_REASONING`) so Pi's `models.json` lists every route (switchable via `/model`, `reasoning: true`, `defaultThinkingLevel` pinned from the default route's grade) and Copilot launches on the default route only (GitHub #3282 — Copilot cannot enumerate multiple BYOK models, so route switching is a relaunch). (2) **Per-group attribution supersedes the single-group `cf-aig-metadata` stamp**: the resolver now returns every match from the configured user-access list and the interceptor stamps one `group_<sanitized>_<hash>=1` tag per group plus `user`, dropping the scalar `group` key, within CF's 5-entry metadata cap (`user` + up to 4 groups, deterministic truncation in configured-list order with a warning). Unconfigured IdP memberships and separately configured admin-group memberships are excluded.

Per-group KEYS — not a CSV value — because the AI Gateway log/route filter operators are equals/not-equals only (no `contains`), so each `group_*` key is independently equals-filterable to build per-group Dynamic-Route if/else conditions ([REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC4). `sanitizeGroupKey` lowercases + replaces non-alphanumerics + appends a djb2 hash suffix so distinct names never collide on a sanitized key.

**Alternative considered — Cloudflare Access-based gateway auth (rejected):** Cloudflare's "identity-driven budgets" announcement (2026-06-05) proposes putting Cloudflare Access in front of the gateway so it derives caller identity from the Access JWT instead of caller-supplied metadata; Cloudflare pitched this as removing the gateway token and "honor-system metadata headers." It was evaluated as a replacement for `AIG_TOKEN` + Worker-stamped `cf-aig-metadata` and rejected on four grounds.

The REST API at `api.cloudflare.com/.../ai/v1/*` still requires a Cloudflare API token per request. It is Cloudflare's control-plane API, not a hostname an operator can front with their own Access application. The identity-aware integration attaches to the legacy `gateway.ai.cloudflare.com` endpoint this ADR deliberately migrated off.

codeflare's caller is a machine-to-machine `WorkerEntrypoint` with no interactive browser/JWT flow. Non-interactive Access uses a service token (a client-id/secret pair), so it remains a static secret and adds no containment gain over the Worker-only secret model already established in [AD72](#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing).

codeflare runs many end-users behind one Worker credential. A single Access identity cannot carry per-user attribution; gateway spend limits split on Worker-stamped `cf-aig-metadata.user` and the bounded `group_<sanitized>_<hash>` tags, so the application must keep supplying that per-request attribution.

codeflare's metadata is not honor-system. The Worker stamps it from a server-side DO prop and strips any container-supplied value, so the container cannot forge it.

Identity-driven budgets are additionally a closed beta. Net: keep `AIG_TOKEN` + Worker-stamped `cf-aig-metadata`; per-user budgets are achieved today via gateway spend-limit rules splitting on the `cf-aig-metadata` `user` field.

**Related:** [AD72](#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing) (interception mechanism, unchanged), [REQ-ENTERPRISE-003](../../sdd/spec/enterprise-mode.md#req-enterprise-003-agent-allowlist-in-enterprise-mode), [REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [REQ-ENTERPRISE-006](../../sdd/spec/enterprise-mode.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var), [REQ-ENTERPRISE-007](../../sdd/spec/enterprise-mode.md#req-enterprise-007-gateway-route-pinning).

---

### AD75: Pi graphify tools replaced by a first-party native extension

**Category:** Architecture

**Status:** Accepted (2026-06-08); amended for Pi reviewer execution by [AD98](#ad98-pi-pr-review-uses-visible-session-scoped-agents) (2026-07-12)

**Context:** Pi has no MCP client, so the graphify query tools (`graphify_query`/`graphify_path`/`graphify_explain`) were exposed on Pi through the third-party `@gaodes/pi-graphify` npm wrapper plus a never-consumed `mcp.json`. The wrapper re-implemented graphify query logic independently of the Claude MCP-server path, so Pi and Claude could diverge in ranking/output from the same graph, and it added an npm dependency (plus the transitive `@gaodes/pi-utils-ui`) that `bump-shadow-pins.yml` had to track and that re-baked the image on every upstream bump. <!-- @impl: preseed/agents/pi/extensions/graphify-native.ts::resolveGraph -->

**Decision:** Replace `@gaodes/pi-graphify` with a first-party native Pi extension, `preseed/agents/pi/extensions/graphify-native.ts`, registered via `pi.registerTool` (mirroring `browser-run.ts`). It shells the same `graphify` CLI that Claude's MCP server runs (`graphify.serve._query_graph_text`), so both agents query through one engine with identical ranking and output. Delete the dead `preseed/agents/pi/mcp.json` and its seed path-mapping and context-mode strip-branch.

**Consequences:**

- Pi and Claude graphify queries share one engine — no divergent third-party reimplementation.
- The Pi npm closure shrinks by `@gaodes/pi-graphify` (and the transitive `@gaodes/pi-utils-ui`); `bump-shadow-pins.yml` and `dependabot.yml` no longer track it.
- Graph resolution prefers the current repository graph, then the same-repository active sentinel graph, then the merged global graph.

  A graphless session fails softly with a "build a graph first" message.
- Pi reviewers run as visible session-scoped public subagents using the native Graphify tool surface.
- The `save-result` feedback loop is restored in both agents' graphify skills, which move to the `references/` progressive-disclosure layout.
- Clone-time triage (detect graph, prompt build/update/skip) is unchanged in both agents — only the query-tool provider changed.

**Implements:** [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify), [REQ-AGENT-024](../../sdd/spec/agents.md#req-agent-024-advanced-session-mode-graph-first-discipline), [REQ-AGENT-091](../../sdd/spec/agents.md#req-agent-091-advanced-session-graph-first-runtime-reminders).

**Related:** [AD98](#ad98-pi-pr-review-uses-visible-session-scoped-agents) (Pi reviewers run as visible session-scoped public subagents).

---

### AD76: Durable review lanes run as detached headless Pi processes

**Category:** Agents

**Status:** Superseded by [AD98](#ad98-pi-pr-review-uses-visible-session-scoped-agents) (2026-07-12)

**Supersedes:** [AD64](#ad64-durable-review-lanes-load-extensions-additively-behind-the-noextensions-shield)

**Context:** In-process `createAgentSession` lanes could die when the spawning Pi session exited, leaving `.git/codeflare-review-jobs/<head>/` stuck `running`.

**Decision:** Launch each durable lane as a detached `pi --mode json -p --no-session --no-extensions --no-context-files` child with stdin from `/dev/null`.

Load only explicit `-e` extensions: `graphify-native.ts`, `review-lane-guards.ts`, and settings-enabled context-mode.

**Consequences:**

- Lanes survive the spawning session and are reaped from disk.
- The idle reaper advances durable jobs without a user turn.

  Completed windows start a background review monitor that reports `REVIEW_RESULT` to the main session.
- Reviewers get a bounded inspection tool allowlist: bash for git/gh inspection, graphify tools, local-build blockers, and optional `ctx_search`.
- Lanes do not load `codeflare-pi.ts`, `review-enforcement`, or `@gotgenes/pi-subagents`.

**Related:** [AD98](#ad98-pi-pr-review-uses-visible-session-scoped-agents), which supersedes this detached-lane architecture.

---

### AD77: Enterprise vault service-worker reached via a higher-precedence Access bypass app

**Category:** Architecture, Security

**Status:** Accepted (2026-06-09)

**Context:** In Enterprise Mode the setup wizard provisions a **host-scoped** Cloudflare Access application ([REQ-ENTERPRISE-006](../../sdd/spec/enterprise-mode.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var) AC5) so the session cookie covers every path. SilverBullet's vault editor registers a native service worker by fetching `/api/vault/:sid/service_worker.js` — a browser-initiated registration fetch that carries **no credentials** (browsers omit them on SW script fetches). The host-wide Access app therefore 302s that fetch to the IdP login *before* the Worker runs, so the Worker's own credential-less SW short-circuit ([REQ-VAULT-017](../../sdd/spec/vault.md#req-vault-017-silverbullet-native-service-worker)) never executes and SilverBullet cannot register its worker (confirmed live: `curl` → 302 to `*.cloudflareaccess.com`).

The SW script bytes are non-sensitive — the encryption key arrives later via `postMessage` — so the path can safely skip Access.

**Key-lifecycle update (2026-08):** [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key) later replaced the original per-session key with a bucket-derived key so encrypted browser caches persist across sessions. That change does not alter this decision's security boundary: the key still never appears in the bypassed worker script and reaches the worker only through the authenticated bootstrap hop.

**Decision:** During enterprise setup, auto-provision a **second, higher-precedence** Access application + policy scoped to `<domain>/api/vault/*/service_worker.js` with `decision: 'bypass'` and `include: [{ everyone: {} }]`, so that one path resolves to the Worker (which then serves the version-locked native SW) instead of the host-wide Access 302. The app id is stored in KV (`setup:access_sw_bypass_app_id`). Provisioning is **best-effort and self-healing**: it never aborts the already-succeeded host-wide Access setup, persists the app id only after the bypass policy succeeds, and rolls back a freshly-created app if the policy step fails — because a `self_hosted` Access app with no policy DENIES its path, which would be worse than the 302 it fixes.

**Rationale:** A second, higher-precedence app is the least-privilege fix: it carves out exactly one non-sensitive path and leaves the host-wide Access protection untouched on every other path. The best-effort + rollback design means a provisioning failure degrades to the original 302 rather than a half-provisioned deny-all state.

**Alternatives considered:**

- **A `bypass` policy inside the host-wide app (rejected):**

Access can scope a bypass policy to a path within the existing app, but that means mutating the wizard-provisioned host-wide app in place — risking the main session-auth destination — and gives no clean rollback target. A separate app owns its own id in KV (`setup:access_sw_bypass_app_id`) and is independently deletable, which is exactly what the rollback-on-policy-failure path relies on.
- **A Worker-side bypass with no Access app (rejected):**

REQ-VAULT-017 already serves the SW credential-less inside the Worker, but Access enforces at the Cloudflare edge and 302s the fetch *before* the Worker runs, so a Worker-only change never sees the request. The bypass must live in Access.

**Consequences:**

- The enterprise vault editor registers its service worker and works behind Access with no operator action.
- One extra Access app per enterprise deployment, scoped to a single non-sensitive path; its precedence must stay above the host-wide app (verified in-dashboard).
- A failed provision degrades to the pre-fix behavior (SW 302) with a `logger.warn`, never a half-provisioned deny-all app; re-running setup re-attempts it.
- Flag-unset parity: non-enterprise deployments are path-scoped (`/app/*`) already and reach the SW path, so no bypass app is created.

**Related:** [REQ-ENTERPRISE-006](../../sdd/spec/enterprise-mode.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var) AC6, [REQ-VAULT-017](../../sdd/spec/vault.md#req-vault-017-silverbullet-native-service-worker).

---

### AD78: PR-boundary review lanes run in parallel (report-only reviewers)

**Category:** Agents

**Status:** Accepted (2026-06-09); amended for Pi execution by [AD98](#ad98-pi-pr-review-uses-visible-session-scoped-agents) (2026-07-12); amended for Claude direct evidence and root-only persistence (2026-07-13); Claude direct-evidence transport reverted after measured cost regression, root-only persistence retained (2026-07-16)

**Context:** At a PR boundary the SDD pipeline dispatches three review lanes — `code-reviewer` (source), `spec-reviewer` (`sdd/`), and `doc-updater` (`documentation/` + root `README.md`). The original design ran them sequentially because reviewers edited their lanes in place and documentation validation depended on completed spec edits (the race concern recorded in [AD44](#ad44-sdd-three-mode-autonomy-with-conservative-judgment-resolution)).

PR-boundary reviewers are now report-only and the root main session applies findings. Claude reviewers publish independent lane results through Claude's existing review pipeline. Pi reviewers return native terminal notifications to the root transcript under [AD98](#ad98-pi-pr-review-uses-visible-session-scoped-agents); Pi has no durable review result files or lane jobs. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement -->

**Decision:** Dispatch every required review lane in parallel at a PR boundary. Reviewers are read-only with respect to source, specs, and documentation, so they have no shared-write ordering dependency. Claude code/spec/doc reviewers return structured findings to the root and gather evidence through native reads, indexed context-mode retrieval, and Graphify discovery — the 2026-07-13 direct-evidence-only transport multiplied review token cost roughly tenfold (~270-310k tokens per full-diff lane, ~85-260k per small incremental lane; raw scan output entered reviewer context uncapped) and was reverted. Pi reviewers are unaffected: their native agents, packet CLI, and enforcement skills are dedicated Pi manifest overrides. Pi launches visible public background reviewer calls and correlates their native notifications.

`/sdd clean` is explicitly excluded because it applies fixes inline. It keeps the AD44 sequential order: spec enforcement before documentation enforcement, so documentation cross-references see the corrected spec.

**Rationale:** Parallelism is correct because PR-boundary reviewers do not edit the shared source of truth. Running the lanes concurrently reduces review latency without creating a write race; the engine-specific result transport does not change that property.

**Alternatives considered:**

- **Keep the sequential gate (rejected):** it bought nothing once the reviewers stopped editing — `doc-updater` reads the *committed* spec, not an in-flight `spec-reviewer` edit — and cost a full lane of serial latency on every PR-boundary.
- **Parallelize `/sdd clean` too (rejected):** `/sdd clean` applies fixes inline, so doc cross-references genuinely depend on the just-fixed spec; parallelizing it would reintroduce the exact race AD44 guards against. The report-only/apply-inline distinction is the dividing line.

**Consequences:**

- PR-boundary review completes faster, and the main session applies findings only after every required lane reports.
- Claude returns complete reports to the root, which alone persists triage and review artifacts; Pi uses session-scoped native notifications defined by AD98.
- `/sdd clean` behavior is unchanged.

**Related:** [REQ-AGENT-040](../../sdd/spec/agents.md#req-agent-040-pr-boundary-lane-classification-and-agent-dispatch) AC1, [REQ-AGENT-086](../../sdd/spec/agents.md#req-agent-086-claude-reviewer-direct-evidence-and-root-handoff), [AD44](#ad44-sdd-three-mode-autonomy-with-conservative-judgment-resolution), [AD76](#ad76-durable-review-lanes-run-as-detached-headless-pi-processes), and [AD98](#ad98-pi-pr-review-uses-visible-session-scoped-agents).

---

### AD79: Image-baked Pi extension transpile cache

**Category:** Performance

**Status:** Accepted (2026-06-10)

**Context:** The 2026-06-10 preseed bundle grew Pi's loaded extension set from 1 npm package to 6 (context-mode enabled by default + four tool extensions). Pi loads every extension through jiti (`moduleCache: false`); jiti caches transpiles on disk under `$TMPDIR/jiti` because no `node_modules` directory sits next to `~/.pi/agent/extensions/` (and this pi build ignores a path-valued `JITI_FS_CACHE` env — verified empirically). `/tmp` starts empty in every fresh container, so **every session cold-transpiled the full extension graph before Pi's first PTY output** — measured live at ~9s cold vs ~4s warm.

The host pre-warm (REQ-SESSION-015) treats first PTY output as its readiness signal with a 20s hard cap; the cold transpile pushed it past the cap, doubling perceived session startup (15s → 30-35s, user-reported).

**Decision:** Bake a warmed jiti cache into the image. A Dockerfile layer runs a throwaway `pi -p` at build with `TMPDIR` redirected, against an agent dir that mirrors the runtime layout (npm symlinked to the image preseed cache; package list **derived** from the preseed `package.json`, never duplicated), then moves the result to `/opt/codeflare/jiti-cache` and **fails the build if the cache is empty**.

The original entrypoint symlinked `/tmp/jiti` to the baked cache at boot (the same pattern as the npm preseed `node_modules` symlink); the 2026-08-24 update below moves that runtime root out of disposable `/tmp`. <!-- @impl: Dockerfile::PI_CODING_AGENT_DIR --> <!-- @impl: entrypoint.sh::relay_managed_pi_extensions --> At the time of this decision, all coding agents—including Pi—resolved from `@latest`; the warm run therefore used the exact Pi/Jiti installed in that build. The 2026-08-02 update below supersedes that mutable-resolution policy.

**Rationale:** The bake works only when the warm run transpiles each extension at the **exact path Pi loads it from at runtime** — jiti's async cache filename contains `hash(realpath)`, while the compiled output carries the source/version marker used to reject stale content. An entry therefore hits only when both the resolved path and the bytes match. (The original 2026-06-10 rationale assumed a content-only key; that was corrected 2026-06-28 under REQ-STOR-017 — see Update below.

The live "153/153 cache hits" validation at the time covered the npm packages, which hit regardless because their warm and runtime paths resolve through the same symlink realpath; the extension `.ts` files were in fact still cold-transpiling.) The empty-cache build guard turns "a pi CLI change broke the warm-up" into a visible build failure instead of a silent production startup regression.

**Update (2026-06-28, REQ-STOR-017):** Empirical testing proved jiti's key is path-sensitive — identical bytes at two paths produce two cache entries that never hit each other — so the original warm bake at a throwaway `TMPDIR` path never hit for the extension `.ts` files, and every advanced session cold-transpiled them (~2.4s).

Three changes close this: the warm bake now runs at the real runtime paths (`PI_CODING_AGENT_DIR=/home/user/.pi/agent`, `HOME=/home/user`); `entrypoint.sh::relay_managed_pi_extensions` re-lays the image-baked managed extension bytes after each R2 restore so the embedded content marker also matches in **all** deployment modes (not just Governed); and the empty-cache guard was hardened to a per-extension fail-closed assertion — every extension must produce a baked `extensions-<base>.<hash>.mjs` entry or the build fails. <!-- @impl: Dockerfile::PI_CODING_AGENT_DIR --> <!-- @impl: entrypoint.sh::relay_managed_pi_extensions -->

**Update (2026-08-02):** Privileged npm tools, including Pi, now install from exact manifests and committed integrity locks ([REQ-AGENT-001](../../sdd/spec/agents.md#req-agent-001-support-multiple-ai-coding-agents), [REQ-OPS-033](../../sdd/spec/operations.md#req-ops-033-lock-backed-npm-bump-coherence)). Each image warms extensions with the same locked Pi/Jiti it ships. This supersedes the earlier `@latest` policy without changing the path-correct cache design.

**Update (2026-08-24):** Runtime no longer exposes the baked cache through `/tmp/jiti`. Entrypoint exports `TMPDIR=/run/codeflare/pi-tmp` before starting the terminal host and symlinks that root's `jiti` child to `/opt/codeflare/jiti-cache`. Late interactive imports can write new chunks without failing when disposable `/tmp` content is cleaned during a live container. <!-- @impl: entrypoint.sh::configure_pi_jiti_runtime_cache -->

**Alternatives considered:**

- **`JITI_FS_CACHE=<path>` env (rejected):** ignored by this jiti build — entries land in `$TMPDIR/jiti` regardless (tested).
- **Lazy/deferred extension loading upstream (rejected for now):** requires pi-core changes; the cache bake achieves the same perceived latency without forking load semantics.
- **Raising the pre-warm 20s cap (rejected):** treats the symptom; sessions would still pay the cold transpile, just behind a quieter gate.
- **Pinning the Pi version for bisectability (rejected at the time; superseded 2026-08-02):** agent auto-resolution was then the product stance. Exact lock-backed versions now provide bisectability while Shadow Pins retains reviewed updates.

**Consequences:**

- First Pi launch in a fresh container loads warm (~4s); pre-warm settles on real output, under its cap.
- A preseed package bump automatically re-warms the derived package set; each deploy now uses the exact Pi version and integrity tree in the committed locks.
- The V8 compile cache (`NODE_COMPILE_CACHE`, already baked for `--version` paths) additionally gains the extension-graph entries from the same warm run.

**Related:** [REQ-SESSION-015](../../sdd/spec/session-lifecycle.md#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition) AC5, [AD57](#ad57-135-second-shutdown-budget-for-final-bisync) (the same incident's data-loss half).

---

### AD80: Pi PR-boundary merge gate is report-only and defended in depth

**Category:** Architecture

**Status:** Superseded by [AD98](#ad98-pi-pr-review-uses-visible-session-scoped-agents) (2026-07-12)

**Context:** A Fable-5 deep review of the Pi PR-boundary review subsystem found the merge gate was the weakest-covered layer. The gate is the `onAgentStart`/`tool_call` interceptor that blocks `gh pr merge` until the reviewed head is acked.

The review raised two questions that are product decisions rather than defects. First: what does "reviewed" mean for the gate? `durableReviewAckReady` opens the gate once all required lanes have *produced a result*, regardless of severity; three CRITICAL lane reports still ack the head.

Second: how strong should interception be? The Pi gate is a hard pre-block: it returns `{block: true}` and the merge tool never runs. Claude's enforcement is retroactive: the merge command executes, then a PostToolUse directive and Stop-hook turn-block reacts afterward through a `gh pr view`-at-turn-end truth layer, with a 5-strike fail-open.

**Decision:** (1) **Report-only semantics.** The gate blocks until the required reviewers have *run* (their head is acked), NOT until their findings are *addressed*. The lanes are advisory (AD78): they surface findings; acting on them is the user's call. "Merge blocked until review" means "until review *ran*", and `/review-skip` is the explicit user override. (2) **Defense in depth.** Pi keeps its hard pre-block — strengthened so it evaluates the PR the merge command actually targets (`mergeCommandTarget` → a specific number/URL/branch/`--repo`, not just the cwd branch), fails *closed* on a readable-but-malformed PR or a transient `gh` failure while any unacked review (pending, latched-breaker, or outstanding-offer head) exists, and recognises `--auto` and wrapper-prefixed (`timeout`/`env`/`command`/`nice`) forms.

On TOP of the pre-block, Pi now also runs Claude's retroactive model as a backstop: after any `gh pr merge`-shaped command runs, if the PR is observed MERGED while its head was never acked, it emits a loud, durable `merge_completed_unreviewed` audit + toast. The pre-block stops the common cases; the retroactive layer catches what no anchor can (`bash -c '…'`, `xargs`, server-side `--auto`). The whole gate decision is the pure, unit-tested `mergeGateDecision`.

**Rationale:** Verdict-gating (blocking the merge until CRITICAL/HIGH findings clear) would make the gate authoritative over a process that is deliberately advisory, would need an override path and a severity contract, and would diverge from Claude's engine — keeping both engines "reviewers ran, not findings fixed" keeps them coherent. Defense in depth is the right answer to "the regex is the gate" for merges: detection has the reconcile backstop, but a single missed merge is unreviewed, so the gate needs both a stronger pre-block AND a retroactive truth layer rather than an ever-more-baroque pre-block regex.

**Alternatives considered:**

- **Block the merge on unaddressed CRITICAL/HIGH (rejected):** stronger, but makes the gate authoritative over advisory lanes, needs a spec + tests + an override path, and diverges from Claude. Revisit if findings are routinely ignored.
- **Pre-block only, no retroactive layer (rejected):** leaves `bash -c`/`xargs`/`--auto` as silent unreviewed-merge holes.
- **Match `gh pr merge` anywhere in the command for the gate (rejected):** over-blocks on mentions (`grep 'gh pr merge'`); the wrapper-word anchor plus the retroactive audit covers the realistic forms without the false-block tax.

**Consequences:**

- The merge gate's correctness is pinned by `mergeGateDecision` unit tests; the inline handler is thin wiring.
- An unreviewed merge that bypasses the pre-block is no longer silent — it leaves a durable audit and a visible toast.
- A subagent/Agent push is treated as an in-session PR-boundary event when the enforced PR head changes during the Agent tool call, because child Bash events are invisible to the parent session.
- A reviewed head with unaddressed CRITICAL findings can still be merged; the findings are surfaced, not enforced. If that proves too weak, AD80 is the place to revisit.

**Related:** [REQ-AGENT-055](../../sdd/spec/agents.md#req-agent-055-pi-session-scoped-review-window), [REQ-AGENT-058](../../sdd/spec/agents.md#req-agent-058-supported-boundary-recovery), [AD78](#ad78-pr-boundary-review-lanes-run-in-parallel-report-only-reviewers), and [AD98](#ad98-pi-pr-review-uses-visible-session-scoped-agents).

---

### AD81: Reuse the container egress-injection layer for per-user GitHub tokens

**Category:** Architecture, Security

**Status:** Accepted (date not recorded)

**Decision:** In enterprise mode, authenticate the agent's GitHub traffic by injecting the user's token at the container egress boundary — reusing the existing AI-Gateway `interceptOutboundHttps` layer — rather than placing the token in the container. `github.com` and `api.github.com` are registered for outbound interception; a `GitHubInterceptor` WorkerEntrypoint resolves and decrypts the per-user token (`DeployKeys.githubToken`, keyed by the bound session's `bucket`), strips the container's placeholder credential, and stamps the real one. The container holds only a non-secret placeholder `GH_TOKEN`.

**Context:** The agent must act with the user's full GitHub permissions (clone/push/PR/merge), but a prompt-injected agent or a malicious dependency could exfiltrate a raw token from the container environment. Codeflare already runs the platform egress-injection pattern for AI keys (placeholder in container → real secret stamped at the Worker boundary, with the Cloudflare containers CA trusted container-wide). Extending it to the GitHub hosts is ~90% reuse and covers git-over-HTTPS and the REST API uniformly — both are HTTPS to github hosts — which dissolves the "token in the container / `gh` has no per-call broker" problem.

**Consequences:**

- Enterprise gets real anti-exfiltration: the real token never enters the container; `printenv` shows only the placeholder, and a session can only ever inject its own user's token (scoping is by the per-session interceptor binding, never the request).
- Non-enterprise (SaaS / other) modes keep the existing deploy-keys→`GH_TOKEN` path — the real token is in the container env, documented as leakage-hygiene, not agent-containment (the user already holds that token).

Short-lived GitHub App tokens cap the exfiltration value there.
- The interceptor resolves the token per request (supporting GitHub App refresh and connect-mid-session); a short in-isolate cache bounds KV reads.
- Alternatives rejected: a git credential-helper callback (covers git but not `gh`/REST, and the agent can still request the token — security by obscurity); placing the real `GH_TOKEN` in the enterprise container (defeats the no-secret-in-container guarantee).

**Related:** [REQ-GITHUB-003](../../sdd/spec/github.md#req-github-003-enterprise-egress-injected-github-credentials), [REQ-GITHUB-001](../../sdd/spec/github.md#req-github-001-github-token-capture-and-storage), [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls), [CON-GH-002](../../sdd/spec/constraints.md#con-gh-002-the-real-github-token-never-enters-the-enterprise-container), [CON-GH-003](../../sdd/spec/constraints.md#con-gh-003-egress-injection-is-scoped-by-the-per-session-binding).

---

### AD82: Visible terminal panes own WebSockets, and MultiView is virtual

**Category:** Architecture, UI/Frontend

**Status:** Accepted (2026-06-18)

**Decision:** The browser opens terminal WebSockets only for panes visible in the current frontend workspace. Dashboard has zero visible panes, a real session has one visible pane, and `MultiView #1` is a local virtual workspace that renders one visible pane for each selected real session. MultiView is never represented as a backend session ID. <!-- @impl: web-ui/src/stores/terminal-workspace.ts::terminalWorkspaceStore --> <!-- @impl: web-ui/src/stores/terminal-workspace.ts::createOrUpdateMultiView -->

**Context:** Dashboard and hidden session surfaces previously mounted terminals for every running session. Those hidden terminals attached extra WebSocket clients to server PTYs, sent stale resize frames, and made the Dashboard status look connected even when the user was not viewing a terminal. The same problem would become worse with a multi-session view unless running, visible, connected, and focused were separated. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea -->

**Consequences:**

- Dashboard status and storage polling are no longer coupled to terminal side effects.
- Hidden running sessions do not mount terminals, reconnect, resize, forward input, or run URL detection. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea -->
- Browser visibility return reconnects only the current workspace's visible pane keys. <!-- @impl: web-ui/src/components/Layout.tsx::visibleTerminalKeys -->
- `MultiView #1` can compose existing running or initializing sessions without quota, storage, lifecycle, or terminal-route changes. <!-- @impl: web-ui/src/stores/terminal-workspace.ts::createOrUpdateMultiView -->
- A shared `TerminalGrid` renders tiled terminal surfaces for both per-session tab tiling and MultiView, so repeated layout structure stays centralized. <!-- @impl: web-ui/src/components/TerminalGrid.tsx::TerminalGrid -->
- The host terminal server assigns resize authority to the focused WebSocket so stale clients cannot shrink a shared PTY. <!-- @impl: host/src/session.ts::claimResizeAuthority -->

**Related:** [REQ-TERM-011](../../sdd/spec/terminal.md#req-term-011-visible-terminal-panes-own-websocket-connections), [REQ-TERM-012](../../sdd/spec/terminal.md#req-term-012-multiview-virtual-session-workspace), [REQ-TERM-013](../../sdd/spec/terminal.md#req-term-013-multiview-selection-flow), [REQ-TERM-014](../../sdd/spec/terminal.md#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming).

---

### AD83: Vault IndexedDB cannot be persisted across sessions by keying the encryption key to the R2 bucket

**Category:** Architecture

**Status:** Superseded by [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key) (2026-06-25). Option A below (bucket-stable vault URL) was implemented — the editor is now served under `/api/vault/<token>/` with the session id carried in the `cf_vault_sid` cookie, and the encryption key is HKDF-derived per bucket — so the SB IndexedDB persists across sessions. The "do NOT key to the bucket / reject persistence" decision below no longer holds; this record is retained for its DB-id analysis (which correctly identified that BOTH `Ie` and the key had to become bucket-stable — the reason Option B's key-only approach was insufficient).

**Decision:** (SUPERSEDED — see REQ-VAULT-021) Do NOT key the vault's client-side encryption key to the user's R2 bucket. Preserve the existing per-Durable-Object key lifecycle: `ensureVaultKey()` mints 32 bytes of raw random entropy per per-session container DO (base64-encoded into DO storage; SilverBullet later consumes those bytes for its own AES-CTR IDB encryption) and explicitly wipes it on `destroy()` (`storage.delete('vaultKey')` + nulled in-memory cache), so deletion stays forward-secret ([AD59](#ad59-zero-ui-vault-encryption-with-per-session-do-storage-key), [REQ-VAULT-008](../../sdd/spec/vault.md#req-vault-008-zero-ui-vault-encryption)). A bucket-stable key is rejected because it cannot deliver the persistence it was meant to buy and would only relax forward secrecy for zero benefit.

**Context:** A request asked to key the SilverBullet (SB) vault IndexedDB to the user's R2 bucket ID instead of the session ID so the SB store would persist across sessions, and proposed achieving this by making the encryption key bucket-stable. Reading the vendored SB worker disproves the premise. SB derives its IndexedDB name as `sb_<type>_<SHA-256(`${spaceFolderPath}:${Ie}:${keyDigest}`)>`, built by `Xe(type, spaceFolderPath, Ie, key)` in `src/routes/vault/native-sw.ts` (verbatim SilverBullet code; call site `let i=t.spaceFolderPath,n=await Xe("files",i,Ie,y)`).

Of the three inputs: `spaceFolderPath` is the constant `/home/user/Vault`; `keyDigest` is a digest of the per-session encryption key; and `Ie` is the service-worker/page **directory URL** — `Ie = location.href.substring(0, location.href.length - kt.length - 1)`. The vault editor and its worker are served at `/api/vault/<sid>/` and `/api/vault/<sid>/service_worker.js` (e.g. `web-ui/src/lib/vault-prewarm.ts`, `vault-local-readiness.ts`), so `Ie = https://<domain>/api/vault/<sid>` and **carries the per-session session id**. Each new session has a new `sid` → a new `Ie` → a different SHA-256 → a different DB id, regardless of the key.

Therefore a bucket-stable key alone would NOT persist the SB IndexedDB across sessions; the DB id is dominated by the per-session vault URL, not the key.

Making the key bucket-stable would only weaken the forward-secrecy property of [AD59](#ad59-zero-ui-vault-encryption-with-per-session-do-storage-key) for no persistence gain, so it must not be done in isolation.

**Alternatives considered:**

- **Option A — bucket-stable vault URL (clean, large).** Serve the editor at a bucket-scoped path so `Ie` is constant across sessions, making the SB DB id stable.

  This is a substantial change to the per-session vault proxy and Durable Object model: it touches routing (`/api/vault/<sid>/`), the per-session container DO id (`${bucketName}-${sessionId}`), service-worker registration scope, the bootstrap-hop, the IDB recorder, dashboard cleanup (`cleanupSessionVaultCache` / `sweepOrphanVaultCaches`, keyed by sid), and the enterprise Access SW-bypass app whose destination wildcard is `/api/vault/*/service_worker.js` ([AD77](#ad77-enterprise-vault-service-worker-reached-via-a-higher-precedence-access-bypass-app)).

  It also raises which session/container backs a shared bucket-stable vault URL. This is the recommended path **if** persistence is pursued, but only as its own scoped project — it cannot be done safely without local test capability for service-worker and sync behaviour.
- **Option B — bucket-stable key plus a symmetric db-name override (fragile, smaller).**

Make the key bucket-stable AND graft a bucket-stable middle component in place of `Ie` in BOTH contexts: the served SW (re-pointing the `Xe(...)` call) and the page context (the IDB recorder already wraps page-context `indexedDB.open` for `sb_*` names, so a remap would live there). This is asymmetric, modifies the SHA-256-guarded verbatim vendored SW graft and the page recorder, is untestable locally, and risks a split, duplicated, or unreadable store. NOT recommended.

Persistence is deferred. The actual drivers of the per-session terminal/keyboard freeze are sync-health bugs already fixed on this branch — the stray CF Access 302 ([REQ-SETUP-003](../../sdd/spec/setup.md#req-setup-003-three-deployment-modes) `isSessionOidcMode` gate) and the non-array `fetchFileList` crash-loop ([REQ-VAULT-025](../../sdd/spec/vault.md#req-vault-025-silverbullet-native-service-worker-runtime-graft) AC2 graft coercion). A separate, still-needed follow-up is a non-blocking / off-main-thread prewarm for the cold FIRST load: even with the two sync-health fixes, the same-origin iframe's first cold rebuild still blocks the terminal main thread. That is a known follow-up, not part of this branch, and persistence (Option A) should be revisited only if cold first-load remains a real pain.

**Consequences:**

- No cross-session persistence of the SB IndexedDB store today: each session cold-rebuilds the client index. This is unchanged from the current behaviour and is NOT regressed by this decision.
- Forward secrecy is preserved: the per-DO key is minted fresh and wiped on `destroy()`, so a deleted session's encrypted browser index is unrecoverable ([AD59](#ad59-zero-ui-vault-encryption-with-per-session-do-storage-key)).
- The per-session terminal/keyboard freeze is addressed by the sync-health fixes on this branch ([REQ-SETUP-003](../../sdd/spec/setup.md#req-setup-003-three-deployment-modes), [REQ-VAULT-025](../../sdd/spec/vault.md#req-vault-025-silverbullet-native-service-worker-runtime-graft)), not by persistence.
- The cold FIRST load still blocks the terminal main thread during the iframe's initial rebuild; a non-blocking / off-main-thread prewarm is tracked as a separate follow-up, independent of this decision and this branch.
- True cross-session persistence remains achievable only via Option A (bucket-stable vault URL), to be pursued as a scoped project if cold first-load justifies it.

**Related:** [AD69](#ad69-silverbullet-vault-runs-its-native-service-worker-for-persistent-encrypted-client-indexing), [AD59](#ad59-zero-ui-vault-encryption-with-per-session-do-storage-key), [REQ-VAULT-008](../../sdd/spec/vault.md#req-vault-008-zero-ui-vault-encryption), [REQ-VAULT-015](../../sdd/spec/vault.md#req-vault-015-vault-idb-lifecycle-and-listing-filters), [REQ-VAULT-025](../../sdd/spec/vault.md#req-vault-025-silverbullet-native-service-worker-runtime-graft), [REQ-SETUP-003](../../sdd/spec/setup.md#req-setup-003-three-deployment-modes), [Troubleshooting lane — vault sync / SW-302 rows](../lanes/troubleshooting.md).

---

### AD84: Retain the vault SW encryption key in memory (neuter the proactive flush) and open a green Vault button directly

**Category:** Architecture

**Status:** Accepted (2026-06-26). Implemented on `fix/vault-keyflush-and-direct-open`; readiness-marker residual superseded by the v3 clean cutover in [REQ-VAULT-029](../../sdd/spec/vault.md#req-vault-029-canonical-browser-state-cutover-and-future-worker-safety).

**2026-08 clean-cutover addendum:** The deferred bucket-keyed marker design was not adopted. SilverBullet precaches its shell, so shell-embedded session readiness metadata is the wrong authority regardless of marker key. The v3 release instead removes stale Vault service workers on the user's explicit first click, installs one permanent canonical scope, and arms only from current runtime/sync/index/required-file proof. Persistent reload auto-arming and background retry are removed; each fresh dashboard load keeps the white → click-one accent → green → click-two open lifecycle. Historical IndexedDB databases remain untouched orphan caches.

**Decision:** Two coupled changes to the vault open path. (1) The native-SW graft NEUTERS SilverBullet's proactive "no window clients" key flush — the `setInterval` that wiped the in-memory AES key `y` 5s after the last client disconnected — keeping its no-client log but dropping the `y=void 0` wipe, so the key is retained for the worker's natural lifetime; `__cfRecover` (re-fetch from the auth-gated `/.vault-key`) is kept only for a genuinely idle-terminated worker. (2) `handleVaultOpen` opens a green (`pw === 'ready'`) Vault button DIRECTLY via the bootstrap-hop, dropping the per-open re-verify of local readiness + key recoverability and its re-prewarm fallback.

**Context:** Two user-reported symptoms shared a key-availability root and an over-defensive workaround.

- **`.auth` 403 on cold open.**

The bootstrap-hop posts `set-encryption-key` then immediately `location.replace`s to the editor, leaving a brief 0-client window. SilverBullet's 5s flush tick lands in that gap and wipes the just-posted key; the editor boots `config` with `y` empty and bounces to `/.auth` ("Authentication not enabled"), which the codeflare proxy returns 403. `__cfRecover` recovers a beat too late. Reopening (worker warm) works. The flush was a forward-secrecy gesture, but the key is re-derivable from `/.vault-key` and the browser idle-terminates the worker anyway, so it bought ~nothing while causing the race.
- **~10s "re-index" on every subsequent green click.**

Not a content reindex (the bucket-stable store is healthy — "0 operations", "already configured"). The dashboard gated the open on `checkVaultLocalReadiness(activeSessionId)`, reading `localStorage["vault-session-<activeSessionId>-idbs"]`. But that marker is written by the injected recorder and validated by the prewarm bridge keyed by `boot.sessionId` = the `cf_vault_sid` cookie session — and SilverBullet serves the shell from PRECACHE, freezing `boot.sessionId` to whatever session was active when the SW installed. For any later/returning session the dashboard reads a never-written marker → `no-recorder` → re-prewarm. The first open worked because the `armed`-intent path never ran the gate.

**Alternatives considered:**

- **Bucket-key the readiness marker (the true durable fix for the divergence).**

Key `vault-session-*-idbs`/`-prewarmed` by the bucket token (like the bucket-stable SW/DBs, [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key)) instead of the session id, so recorder/bridge/dashboard all agree. Deferred: the dashboard does not know the bucket token (it is server-side), so this needs the token plumbed to the client — a larger, separately-scoped change. Tracked as the durable fix in [REQ-VAULT-022](../../sdd/spec/vault.md#req-vault-022-vault-armed-state-open-flow-and-persistence) AC1.
- **Hop→SW ack before `location.replace`, and/or add `__cfRecover` to the service-proxy-error auth path.** Rejected as overengineering: neutering the flush removes the dominant race; the residual service-proxy-error path is flagged as residual-risk, not patched speculatively.
- **Keep the per-open re-verify but fix its key.** Rejected: even keyed correctly, re-verifying an already-green button on every click adds latency and a pop-up-blocker risk for no behavioral benefit — a green button is ready by definition.

**Consequences:**

- The cold-open `.auth` bounce and the in-session "re-index on every click" are both resolved; a green button opens immediately and identically on mobile/tablet/desktop.
- The two changes are COUPLED: opening a green button directly is only safe because the key is retained (no flush race), so they ship together.
- Forward secrecy is marginally relaxed (the key lives in SW memory until idle-termination — tens of seconds — instead of 5s after close); accepted because the key is re-derivable from `/.vault-key` regardless.
- The former marker-key divergence and reload-skip residual are superseded by the v3 clean cutover: no persistent readiness marker auto-arms a fresh dashboard load. The residual service-proxy-error `.auth` path remains unpatched because authentication failure is not encryption-key recovery.

**Related:** [AD69](#ad69-silverbullet-vault-runs-its-native-service-worker-for-persistent-encrypted-client-indexing), [AD59](#ad59-zero-ui-vault-encryption-with-per-session-do-storage-key), [AD83](#ad83-vault-indexeddb-cannot-be-persisted-across-sessions-by-keying-the-encryption-key-to-the-r2-bucket), [REQ-VAULT-024](../../sdd/spec/vault.md#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention), [REQ-VAULT-025](../../sdd/spec/vault.md#req-vault-025-silverbullet-native-service-worker-runtime-graft), [REQ-VAULT-018](../../sdd/spec/vault.md#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger), [REQ-VAULT-019](../../sdd/spec/vault.md#req-vault-019-vault-key-recoverable-open-gate), [REQ-VAULT-022](../../sdd/spec/vault.md#req-vault-022-vault-armed-state-open-flow-and-persistence), [Troubleshooting lane — vault rows](../lanes/troubleshooting.md).

---

### AD85: Controller-mediated Cloudflare Gateway egress as a mandatory web boundary (wizard-toggled, default OFF)

**Category:** Architecture, Security

**Status:** Accepted (2026-06-27). Ships OFF; the Workers VPC binding is enterprise-only, injected at deploy time by `deploy.yml` when `ENTERPRISE_MODE=active` (see Consequences). Reuses the [AD72](#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing) interception mechanism for a different goal.

**Context:** Enterprise customers want the option to force *all* container egress — not just LLM and GitHub traffic — through their Cloudflare (Zero Trust) Gateway, so the account's existing egress policies (allow/block/isolate/DLP) govern every network call an agent or tool makes. The existing enterprise interception ([AD72](#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing) / [AD74](#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api)) covers only the known LLM/GitHub hosts and *injects identity* (gateway / GitHub credentials); it is not a general egress boundary. Three shapes were considered:

1. **Per-host allowlist of additional interceptors.** Register each extra host with its own WorkerEntrypoint. Does not scale (every new destination is a code change) and cannot be a *mandatory* boundary — an unlisted host escapes.
2. **Container-network firewall / deniedHosts only.**

Block direct egress at the platform and rely on allowedHosts. Coarse, hard to keep in sync with the customer's Gateway policy, and still does not route the traffic *through* the Gateway (so the customer's DLP / isolate rules never see it).
3. **A catch-all controller that forwards through a Workers VPC binding to the Gateway.**

Wire `interceptOutboundHttps('*', EgressController)` so every host not already owned by the LLM/GitHub interceptors is forwarded through `env.EGRESS.fetch` (a Workers VPC `[[vpc_networks]]` Fetcher binding → the customer's Gateway over `cf1:network`). The controller is a transparent proxy (no identity), and the per-host interceptors swap their single upstream `fetch` to the same `env.EGRESS.fetch` when strict is ON.

**Decision:** Adopt option 3 as an optional, enterprise-gated, **default-OFF** feature (Strict Gateway Egress, [REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress)). The on/off toggle lives in the existing setup wizard and is persisted in KV (`SETUP_KEYS.STRICT_EGRESS`, `'active'`/`'inactive'`), read straight from KV via `hasStrictGatewayEgress` (the `ENTERPRISE_MODE` global-flag precedent, not per-session threading). When ON the DO wires the `EgressController` catch-all (lower precedence than the per-host registrations) and passes `strict:true` to the LLM/GitHub interceptors. The defining property is **fail-closed**: when `env.EGRESS` is unbound every path returns `503 EGRESS_UNAVAILABLE` and never falls back to global `fetch`.

**Consequences:**

- The customer's Cloudflare Gateway becomes a *mandatory* boundary for all container HTTP/HTTPS egress when the toggle is ON; the account's existing Gateway policies apply unchanged and codeflare never creates, modifies, or deletes them.
- The `EgressController` is deliberately a transparent proxy (no identity stamping), unlike the identity-stamping `LlmInterceptor` / `GitHubInterceptor`.
- It adds no new credential-injection surface; the per-host interceptors keep their existing injection and only change the destination of their single upstream `fetch`.
- The literal-IP SSRF guard is defense-in-depth only; it does not stop a public hostname that resolves to a private IP (DNS rebinding) — the Gateway policy is the authoritative egress control.
- The `[[vpc_networks]]` `EGRESS` binding is committed **commented-out** in `wrangler.toml` and injected by `deploy.yml` **only when `ENTERPRISE_MODE=active`**.
- Default and fork deployments without Workers VPC (`cf1:network`) remain unaffected, as does the `vitest-pool-workers` test runtime.

On non-enterprise deploys `env.EGRESS` is undefined, so the feature fails closed and the dormant state (toggle OFF or binding absent) is inert — which is what makes shipping the code OFF safe.
- When OFF or non-enterprise the catch-all is never wired and the interceptor transport swap is inert, so the egress path and the setup configure request/response shape are byte-identical to today.

**Related:** [AD72](#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing) (same `interceptOutboundHttps` mechanism, identity-stamping LLM proxy — different goal), [AD74](#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api), [AD81](#ad81-reuse-the-container-egress-injection-layer-for-per-user-github-tokens) (egress-injection layer reused for GitHub), [AD86](#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network) (refines this — narrows the boundary to direct-internet egress; platform-native primitives bypass), [REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress), [Architecture — Strict Gateway Egress](../lanes/architecture.md#strict-gateway-egress), [Security — Strict Gateway Egress](../lanes/security.md#strict-gateway-egress-enterprise-mode), [Deployment — Strict Gateway Egress](../lanes/deployment.md#strict-gateway-egress-enterprise-mode).

---

### AD86: Platform-native Cloudflare primitives bypass strict Gateway egress (only direct-internet egress takes cf1:network)

**Category:** Architecture, Security

**Status:** Accepted (2026-06-27). Refines [AD85](#ad85-controller-mediated-cloudflare-gateway-egress-as-a-mandatory-web-boundary-wizard-toggled-default-off): the "force *all* egress" boundary is narrowed to *direct-internet* egress; this deployment's own-account platform destinations egress direct. Same-day amendment: the exemption is narrowed from a bare-host match to an **account-scoped** match (only THIS deployment's own account is exempt; any other account's R2/CF host rides the Gateway), which closes the cross-account residual this ADR originally accepted; and the `EgressController` now proxies WebSocket upgrades verbatim so browser-run's CDP works under strict egress ([REQ-ENTERPRISE-023](../../sdd/spec/enterprise-mode.md#req-enterprise-023-strict-gateway-egress-controller-transport) AC2/AC3).

**Superseded in part by [AD87](#ad87-egresscontroller-re-signs-own-account-r2-container-holds-a-placeholder-key-bridges-websocket-upgrades-and-resolves-strict-via-props):** the WebSocket proxy is a `WebSocketPair` **bridge**, not the upstream `101` returned as-is (returning it as-is left the CDP socket stalled → `canceled`); own-account R2 is **re-signed** with the worker-held key so the container holds only a non-secret placeholder R2 key (the real key no longer enters the container); and `strict` is resolved **once via `ctx.props`** (no per-request KV read).

**Context:** [AD85](#ad85-controller-mediated-cloudflare-gateway-egress-as-a-mandatory-web-boundary-wizard-toggled-default-off) adopted a catch-all `EgressController` forcing *all* container egress through `cf1:network` → the customer's Gateway, with the per-host LLM/GitHub interceptors swapping their upstream `fetch` to `env.EGRESS.fetch` when strict. In practice this routes codeflare's OWN control-plane traffic through the customer's public Gateway egress: the container's rclone vault/workspace **R2** bisync, the **AI Gateway** LLM calls, and **Browser Rendering** ("browser-run"). Two problems surfaced on `enterprise-integration`:

1. **Scaling / availability.**

rclone's per-file R2 sync is the dominant container-egress volume. Routing it over the beta `cf1:network` path produced a TLS-handshake storm (~16% of requests failing) that stalled session startup at "Syncing…". And it does not scale: per-container rclone throttling bounds only one container, but the `cf1:network` → Gateway path has account-level connection/rate limits — 100 users × N containers each bisyncing would saturate the shared path regardless. It also couples every container's bootstrap-critical persistence to the customer's Gateway being up and correctly policy-configured.
2. **Wrong boundary.**

An egress firewall exists to police the *workload's reach to the outside world*. R2 / AI Gateway / Browser Rendering are codeflare's own platform backends, reached with codeflare-managed credentials to Cloudflare-owned hosts, each already with its own audit trail (R2 access logs, AI Gateway analytics). Auditing them through the customer's Gateway adds no security value and a hard dependency.

**Decision:** Only genuine **direct-internet** egress takes the `cf1:network` path. This deployment's **own-account** platform destinations egress **direct** (global `fetch`) and never traverse `cf1:network`, even when strict is ON; everything else — including any OTHER account's Cloudflare host — rides `env.EGRESS` → the Gateway:

- The exemption is **account-scoped** via `isAccountScopedDestination(url, accountId)` (`src/lib/controller-egress.ts`), checked *before* the `env.EGRESS` guard.
- Own-account destinations include this account's **R2** (`<accountId>.r2.cloudflarestorage.com` + the `<bucket>.<accountId>.…` vhost form) and account-scoped **CF API / Browser Rendering** paths.
- The account id is resolved once by the DO (`getR2Config`) and passed to the controller via `ctx.props.accountId`; an absent/empty id exempts nothing.
- `gateway.ai.cloudflare.com` (AI Gateway compat) is **not** in the controller's exemption set — the container never reaches it directly; the worker-side `LlmInterceptor` does, and that leg always egresses direct (below).
- The **`LlmInterceptor`** does not swap to `env.EGRESS` — AI Gateway is a platform-native Cloudflare primitive, so it always egresses direct.
- The **`GitHubInterceptor`** is unchanged: `github.com` / `api.github.com` is genuine external egress and still rides `env.EGRESS` → Gateway when strict.
- **WebSocket upgrades**

reaching the `EgressController` (e.g. browser-run Chrome DevTools at `…/browser-rendering/devtools/…`) are proxied through the same account-scoped selector, and the upstream `101`+`webSocket` was returned as-is in this initial implementation. *(Corrected by [AD87](#ad87-egresscontroller-re-signs-own-account-r2-container-holds-a-placeholder-key-bridges-websocket-upgrades-and-resolves-strict-via-props): returning the response as-is leaves the CDP socket stalled and `canceled`; the `WebSocketPair` bridge is what actually makes interactive browser-run work.)*

The container→SDK leg is still TLS-terminated by the platform (the SDK presents the Cloudflare containers CA), so the container still trusts that CA for R2; only the SDK→upstream leg goes direct instead of through `env.EGRESS`.

**Consequences:**

- R2 vault/workspace sync runs at full speed off `cf1:network`, decoupled from the customer's Gateway — fixing the "Syncing…" startup hang and removing the fleet-scale saturation risk.

The earlier per-container rclone throttle is unnecessary and was reverted; enterprise rclone is byte-identical to non-enterprise again.
- Strict Gateway Egress now means: the customer's Gateway policies (allow/block/isolate/DLP) govern the agent's reach to the *outside world*; codeflare's own platform backends are out of scope by design.
- The exemption is **account-scoped** to this deployment's own Cloudflare account:

own-account R2 (the `.r2.cloudflarestorage.com` suffix requires the leading dot, so lookalikes like `r2.cloudflarestorage.com.attacker.example` are not exempt) and the own-account `api.cloudflare.com/client/v4/accounts/<accountId>/` path. Any other account's R2/CF host falls through to the Gateway. Adding a future own-account platform primitive is a localized change to `isAccountScopedDestination`.
- **Residual surface (accepted, documented):** with the account-scoped exemption the **cross-account channel is closed** — another account's R2 or CF API now rides the Gateway and is inspected like any direct-internet egress.

  What remains is bounded and own-account only: traffic to *this deployment's own* R2 and account-scoped CF API egresses direct, so the customer's Gateway DLP does not see it. That is by design — these are codeflare's own control-plane backends, reached with codeflare-managed credentials to the customer's own account, each already carrying its own audit trail (R2 access logs, AI Gateway analytics), and browser-run itself runs *in* Cloudflare's Browser Rendering where the account's Gateway policies/inspection/DLP apply by design.

  The residual is not an un-gatewayed channel to arbitrary destinations; it is potential **DLP evasion of the customer's own Gateway for traffic to the customer's own account**, which the account's own R2/AI-Gateway/Browser-Rendering audit already records. The exposure is further bounded by the feature being dormant while the `EGRESS` binding is unbound. Documented in the security lane so operators enabling strict egress for DLP know the own-account control-plane backends are outside the Gateway boundary by design.

**Related:** [AD85](#ad85-controller-mediated-cloudflare-gateway-egress-as-a-mandatory-web-boundary-wizard-toggled-default-off) (refined by this), [AD72](#ad72-outbound-https-interception-over-a-worker-side-llm-proxy-for-enterprise-gateway-routing), [AD74](#ad74-enterprise-llm-transport-on-the-ai-gateway-rest-api), [REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress), [REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway), [Security — Strict Gateway Egress](../lanes/security.md#strict-gateway-egress-enterprise-mode), [Architecture — Strict Gateway Egress](../lanes/architecture.md#strict-gateway-egress).

---

### AD87: EgressController re-signs own-account R2 (container holds a placeholder key), bridges WebSocket upgrades, and resolves strict via props

**Category:** Architecture, Security

**Status:** Partially superseded by [REQ-BROWSER-008](../../sdd/spec/browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container) for browser-token injection and [AD143](#ad143-strict-r2-interception-signs-only-with-the-bound-users-scoped-credential) for R2 signer authority. Accepted 2026-06-27; R2 re-signing, WebSocket bridging, props-based strict state, the own-account exemption, and the [AD85](#ad85-controller-mediated-cloudflare-gateway-egress-as-a-mandatory-web-boundary-wizard-toggled-default-off) fail-closed boundary remain active.

**Context:** AD86 narrowed strict egress to direct-internet traffic and added an account-scoped exemption, but its first deploy left three problems on `enterprise-integration`:

1. **browser-run still failed.**

The Chrome DevTools (CDP) WebSocket reached the `EgressController` with intact upgrade headers, then `outcome=canceled` (~2s, no exception). AD86 returned the upstream `101`+`webSocket` **as-is**; in an *outbound* `interceptOutboundHttps` controller that does not hand the socket back to the container — it stalls and is canceled. (The SDK's own `ContainerProxy` bridges a `WebSocketPair` for exactly this reason.)
2. **The real R2 key sat in the container.**

rclone's `rclone.conf` carried the bucket-scoped R2 S3 key (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`). Under prompt injection an agent could read it and exfiltrate R2 directly — and AD86's own-account R2 exemption egresses direct, so the customer's Gateway DLP would not even see the exfil. The egress boundary is worthless for R2 if the key it protects is sitting in the sandbox.
3. **Per-request KV read.** `hasStrictGatewayEgress` did a `KV.get(setup:strict_egress)` on *every* forwarded request — i.e. once per synced file (~1844 HEADs/sync). The DO only wires the catch-all when strict is ON, so the per-request re-read is redundant.

Bindings were ruled out as the containment path (verified): R2 bindings are static deploy-time declarations with a fixed `bucket_name`, so per-user dynamic buckets cannot bind, and there is no by-name accessor.

**Decision:**

- **R2 key containment via re-sign.** When strict is active, `buildEnvVars` emits a **non-secret placeholder** R2 key into the container (`ENTERPRISE_R2_KEY_PLACEHOLDER`, which is the single canonical enterprise placeholder value `'codeflare-enterprise'`).

  That value is the same as the GitHub-token placeholder and entrypoint.sh's `ENTERPRISE_PLACEHOLDER_TOKEN`. rclone runs in signed mode with the placeholder; for own-account R2 the `EgressController` **strips the placeholder `Authorization` and re-signs** the request with the worker-held key (`createR2Client` / aws4fetch) at the R2 boundary.

  The re-sign reuses the request's existing `x-amz-content-sha256` so the body streams through unbuffered, and signs every present header so SSE-C `x-amz-*` headers are preserved. The real R2 key never enters the container. Non-enterprise / strict-off sessions keep the real key (rclone connects to R2 directly), byte-identical to today.
- **WebSocket upgrades are bridged, not returned as-is.**

For a `101` upstream the controller accepts both ends of a fresh `WebSocketPair`, forwards `message`/`close`/`error` both ways, and returns a 101 carrying the *client* end. The original upgrade request is forwarded **verbatim**; a non-`101` upstream (e.g. an error) is surfaced unchanged. **Amended by [REQ-BROWSER-008](../../sdd/spec/browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container):** browser-run's CDP WS is now claimed by the per-host `CloudflareBrowserInterceptor` (precedence over this catch-all), which bridges it the same way and injects the real token worker-side — the container holds only the placeholder. This EgressController bridge now serves any other catch-all WS.
- **`strict` resolved once via props.**

The DO resolves `hasStrictGatewayEgress` once at construction (`_strictEgress`) and passes `{ accountId, strict }` to the controller via `ctx.props`; the controller reads `props.strict` (defense-in-depth `503 EGRESS_NOT_CONFIGURED` if absent/false) instead of reading KV per request. `buildEnvVars` reads the same `_strictEgress` to choose the placeholder vs real key, so the wiring and the container creds always agree.
- **The browser-run CDP token stayed in the container under AD87 ([REQ-BROWSER-007](../../sdd/spec/browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)) — SUPERSEDED by [REQ-BROWSER-008](../../sdd/spec/browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container).**

AD87 kept the narrowly-scoped "Browser Rendering - Edit" token in the container, judging injection low-value churn. The zero-secret-container goal (strict egress + Governed Mode ⇒ only `CONTAINER_AUTH_TOKEN`, [REQ-ENTERPRISE-020](../../sdd/spec/enterprise-mode.md#req-enterprise-020-governed-mode-re-encrypt-migration-engine) AC3) reversed that call: `applyEnterpriseBrowserToken` now emits only the non-secret placeholder, and the per-host `CloudflareBrowserInterceptor` strips it and stamps the real `Bearer` token at `api.cloudflare.com/client/v4/accounts/<acct>/browser-rendering/*` (REST + CDP WS), account-scoped to the wizard-configured account.

**Consequences:**

- browser-run's interactive CDP works under strict egress (verified on deploy by re-running browser-run + watching the `bridged:true` egress log).

**Open empirical point (A):** whether an *outbound* `interceptOutboundHttps` controller propagates a returned `101`+`webSocket` back to the container is undocumented; high confidence from the SDK `ContainerProxy` precedent and working terminal WS, resolved by the deploy verify. **Resolution (now the implemented design, [REQ-BROWSER-008](../../sdd/spec/browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container)):** the per-host `CloudflareBrowserInterceptor` claims `api.cloudflare.com` ahead of the `'*'` catch-all and bridges the CDP WS itself, injecting the real token at that boundary while the container carries only the placeholder. R2 + KV + re-sign are independent of (A).
- The real R2 key is removed from the container's blast radius:

a prompt-injected read now yields only a non-secret placeholder; R2 access is gated by the worker-held key the agent cannot reach. This is the actual containment the egress boundary needs for R2.
- The redundant per-request `KV.get` is removed.

  A temporary per-operation diagnostic (`{h, sc, tx, rs, fMs}`) attributes the measured R2 wall time so deployment data can identify the next speed improvement.
- The non-hex placeholder triggers entrypoint.sh's non-fatal `R2_ACCESS_KEY_ID contains unexpected characters (expected hex)` warning in strict mode.
- This is expected and harmless: rclone signs with the placeholder, the controller re-signs, and the troubleshooting lane documents the warning.

**Related:** [AD86](#ad86-platform-native-cloudflare-primitives-bypass-strict-gateway-egress-only-direct-internet-egress-takes-cf1network) (refined by this), [AD85](#ad85-controller-mediated-cloudflare-gateway-egress-as-a-mandatory-web-boundary-wizard-toggled-default-off), [AD81](#ad81-reuse-the-container-egress-injection-layer-for-per-user-github-tokens) (placeholder-credential containment precedent for GitHub), [REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress), [REQ-BROWSER-007](../../sdd/spec/browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token), [Security — Strict Gateway Egress](../lanes/security.md#strict-gateway-egress-enterprise-mode), [Architecture — Strict Gateway Egress](../lanes/architecture.md#strict-gateway-egress), [Configuration — Container env vars](../lanes/configuration.md), [Troubleshooting — Strict Gateway Egress](../lanes/troubleshooting.md).

---

### AD88: Bisync compares via server-modtime from fast-list (not per-object mtime HEADs)

**Category:** Storage

**Status:** Accepted (2026-06-28).

**Context:** The steady-state `rclone bisync` (every 15 min, plus baseline + manual triggers) issued one HEAD per object to read its mtime metadata for change detection. On a populated bucket this was the dominant sync cost — measured ~2,900 HEADs per cycle — even when almost nothing changed. The bulk `--fast-list` already returns each object's `LastModified` from R2 in a handful of list calls, so the per-object HEAD is redundant.

**Decision:** Both bisync invocations (the `--resync` baseline in `establish_bisync_baseline` and the steady-state cycle in `bisync_with_r2`) add `--use-server-modtime` (compare via the `LastModified` already returned by `--fast-list`, not a per-object mtime HEAD) and widen `--checkers 32` → `--checkers 64` to overlap the remaining work. Applies in all modes (independent of Governed Mode). The initial one-way sync (`initial_sync_from_r2`) is unaffected.

**Consequences:** The per-cycle HEAD storm is eliminated, cutting the dominant steady-state sync cost. The trade-off of `--use-server-modtime` — it compares the R2 upload time rather than the source file's own mtime — is acceptable for codeflare's newest-wins bisync, where the bucket is the per-user source of truth and absolute upload order is the conflict key. Verified on deploy by the drop in HEADs/cycle in `/tmp/sync.log`.

**Amendment (2026-08-25):** Current containers expose this diagnostic at `/run/codeflare/sync/sync.log`; the historical path above records the original deployment. <!-- @impl: entrypoint.sh::bisync_with_r2 -->

**Related:** [REQ-STOR-017](../../sdd/spec/storage.md#req-stor-017-faster-startup-sync--bisync-head-storm-fix--governed-mode-preseed-bake), [AD56](#ad56-15-minute-bisync-cadence-with-manual-triggers), [Storage & Sync lane](../lanes/storage-and-sync.md).

---

### AD89: Governed Mode, deployment-wide R2 SSE-C disable via a KV toggle, with lossless in-place re-encrypt migration

**Category:** Architecture, Security, Storage

**Status:** Accepted (2026-06-28).

**Context:** In enterprise, bucket data is corporate-owned and the company must be able to scan agent config (skills, hooks, extensions) for malicious content with its own security tooling. By default every R2 object is SSE-C encrypted with `ENCRYPTION_KEY`, so the bucket is opaque even to the company's R2-credential holders. The customer asked for a way to make the bucket scannable; their first instinct was to **nuke and recreate** each bucket on toggle, which would lose the user's own content (custom skills/hooks/extensions, transcripts, vault, workspace).

**Decision:** A deployment-wide, enterprise-only, **default-OFF** toggle (`SETUP_KEYS.R2_SSE_DISABLED`, `'active'`/`'inactive'`, in the Setup wizard, no redeploy to flip — the [AD85](#ad85-controller-mediated-cloudflare-gateway-egress-as-a-mandatory-web-boundary-wizard-toggled-default-off)/[REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress) toggle precedent). When ON, R2 SSE-C is disabled so objects use R2's default at-rest encryption and are readable/scannable.

- **`ENCRYPTION_KEY` gating is surgical.**

The key has three orthogonal roles — R2 SSE-C, vault HKDF master, and secret-at-rest KV crypto. Governed Mode gates ONLY the R2 SSE-C path (`getSseHeaders`/`getSseCopyHeaders` gain an `r2SseDisabled` parameter that returns `{}` even when the key is set); vault and secret-at-rest crypto are untouched. Disabling SSE-C therefore never weakens secret storage or the vault.
- **Per-bucket regime marker drives header choice.**

Every R2 read/write call site (download/upload/preview/seed/migration) chooses SSE-C vs plaintext by a per-bucket marker (`UserPreferences.r2SseRegime`), not the raw policy. The marker is the truth about how the bucket's objects are actually stored, so reads stay correct during the rollout window between an admin flipping the toggle and each bucket being reconciled on its owner's next login.
- **Lossless re-encrypt, not nuke.** Switching regimes re-encrypts each object **in place** via a server-side `CopyObject` (verified R2-supported): copy-source SSE-C headers decrypt the source on→off; destination SSE-C headers encrypt off→on.

  `MetadataDirective=COPY` preserves Content-Type + system metadata (more lossless than the `REPLACE` the plan first assumed — COPY keeps metadata, and the encryption-attribute change is what makes the same-key self-copy legal). Object bytes never leave R2.

  The migration is **idempotent and resumable**: each object is HEAD-probed with the target regime's read headers and skipped on a 200, so a partial run — or a completed run whose marker write failed — converges on retry instead of erroring on already-done objects.

  It runs **in the background on the owner's next login** (the dashboard initial-load probe, `reconcileBucketRegimeOnLogin`, registered with `waitUntil`) — NOT on the container-start path. `ensureBucketAndSeed` only resolves the current regime, so a slow re-encrypt can never block session creation. At login no container is running yet, so there is no concurrent writer. The marker advances only after a fully-complete pass, and a per-bucket KV lock dedupes concurrent logins/tabs.
- **Bound + limits.** A single background login pass is capped by the Workers Paid 10,000-subrequest budget (≈4,500 objects with the idempotence probe).

  Because it runs in `waitUntil` off the request path, a larger bucket simply does not finish in one pass — the marker stays un-advanced and the idempotent HEAD-probe resumes on the next login until a pass completes (no batched/queue migration needed at current scale — the live bucket is ~1,265 objects).

  A single `CopyObject` is capped at 5 GB; an oversized object fails the migration loudly rather than being silently skipped, which would leave it unreadable once the marker flips.
- **Regime reaches the container**

as `R2_SSE_DISABLED` (mirrors the `_strictEgress` state field): emitted only when the bucket is plain, but always carried in the setBucketName body as a definite boolean so a regime flip OFF on a warm DO resets stale state. The entrypoint then drops the SSE-C block from rclone.conf.
- **UI guard.** The wizard toggle requires an explicit admin confirmation (the consequence is a re-encrypt of every bucket) before it flips.

**Consequences:** Enterprise admins get a scannable, controllable bucket with zero data loss. With the toggle OFF (the default), all SSE-C behavior, seeding, and sync are byte-identical to before. The rollout window is the one soft edge: while a bucket is mid-migration its objects are briefly mixed-regime, so a concurrent read can transiently fail until migration completes — acceptable for a rare, admin-initiated, confirmation-gated flip on small config buckets, and documented in the troubleshooting lane.

**Revised 2026-06-28 (post-deploy):** the migration was first placed inline at session start, which **bricked container creation** on the live enterprise-integration bucket — the synchronous per-object re-encrypt outran the request lifetime and the worker was canceled before configuring the container (the `try/catch` never logged because a cancellation is not a catchable throw; `Set bucket name` never fired). Moving it to a background first-login reconcile (`waitUntil`, off the container-start path) is the fix. **Rejected:** nuke-and-recreate (loses user content); `MetadataDirective=REPLACE` (would drop Content-Type unless re-sent); distributed migration locking (overengineered for a rarely-flipped toggle); inline-at-session-start (bricks `/start`).

**Related:** [REQ-ENTERPRISE-018](../../sdd/spec/enterprise-mode.md#req-enterprise-018-governed-mode-toggle-and-configuration-surface), [REQ-ENTERPRISE-020](../../sdd/spec/enterprise-mode.md#req-enterprise-020-governed-mode-re-encrypt-migration-engine), [AD90](#ad90-governed-mode-preseed-bake--checksum-delta-initial-sync), [AD13](#ad13-per-user-scoped-r2-tokens), [REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress), [Security lane](../lanes/security.md), [Configuration lane](../lanes/configuration.md), [Deployment lane](../lanes/deployment.md), [Storage & Sync lane](../lanes/storage-and-sync.md).

---

### AD90: Governed Mode preseed bake + checksum delta initial sync

**Category:** Storage

**Status:** Accepted (2026-06-28).

**Context:** The blocking `initial_sync_from_r2` re-downloads the entire agent seed (~627 files, ~9 MB — about half of a populated bucket) on every boot, because the container filesystem is ephemeral and the seed lives only in R2. It used `--size-only` (the only safe comparison under SSE-C, whose ETags are opaque), so even with the seed present locally it could not prove content equality and re-downloaded everything. Disabling SSE-C (AD89) restores usable MD5 ETags, which makes `--checksum` viable — and `--checksum` with a locally-present seed skips the unchanged files.

**Decision:** In Governed Mode only:

- **Bake the seed into the image.**

A new `scripts/materialize-agent-seed.mjs` writes `getConfigsForMode('default'/'advanced', false)` to an on-disk tree; the Dockerfile generates it **in-image** from the committed, freshness-enforced `src/lib/agent-seed.generated.ts` (the single source of truth — `getConfigsForMode` is a pure filter, so the bake is byte-identical to what is seeded to R2). The byte-identity is the load-bearing precondition for the checksum-skip and is guarded by a behavioral drift test. The tier-gated context-mode subtree is intentionally excluded (it delta-syncs from R2).
- **Lay it down before the sync.** A new `lay_down_agent_seed_preseed` copies the mode's baked tree into the user home before `initial_sync_from_r2`, and the initial sync switches `--size-only` → `--checksum`.
- The unchanged ~627 seed files are skipped and only user deltas transfer.
- **Gated on Governed Mode.**

Both the lay-down and `--checksum` activate only when `R2_SSE_DISABLED=true`, because only an SSE-C-off bucket exposes usable MD5 ETags. Under SSE-C (the default), `--size-only` cannot detect a same-size edit to a seed file, so laying down the bake there could silently lose an in-container seed edit; the path stays byte-identical to before (no lay-down, `--size-only`).

**Consequences:** Governed Mode startup transfers only the user's deltas instead of re-downloading the whole seed every boot. The in-image generation needs no host build ordering (the seed source is always committed) and cannot drift from the seed. The dependency on AD89 is deliberate: REQ-STOR-017(b) ships with REQ-ENTERPRISE-018. Verified on deploy by the before/after Step-1 transfer count in `/tmp/sync.log`.

**Amendment (2026-08-25):** Current containers expose Step-1 diagnostics at `/run/codeflare/sync/sync.log`; the historical path above records the original deployment. <!-- @impl: entrypoint.sh::initial_sync_from_r2 -->

**Addendum (2026-06-29) — scope of the sibling relay:** A related mechanism in the same lay-down family, `entrypoint.sh::relay_managed_pi_extensions`, re-lays the image-baked managed Pi extension bytes before the bisync `--resync` baseline. Unlike the Governed-Mode-only seed bake above, the relay runs in **all** deployment modes: it guarantees the content half of the path-sensitive jiti prewarm cache key (see [AD79 Update](#ad79-image-baked-pi-extension-transpile-cache)) so the cache hits at runtime. In Governed Mode the subsequent `--checksum` sync then skips the unchanged relaid files; outside Governed Mode the relay simply precedes the `--size-only` sync. This is why REQ-STOR-017 entrypoint code references the relay as all-modes even though this ADR's seed-bake decision is Governed-only.

**Related:** [REQ-STOR-017](../../sdd/spec/storage.md#req-stor-017-faster-startup-sync--bisync-head-storm-fix--governed-mode-preseed-bake), [AD89](#ad89-governed-mode-deployment-wide-r2-sse-c-disable-via-a-kv-toggle-with-lossless-in-place-re-encrypt-migration), [AD88](#ad88-bisync-compares-via-server-modtime-from-fast-list-not-per-object-mtime-heads), [AD79](#ad79-image-baked-pi-extension-transpile-cache), [Preseed lane](../lanes/preseed.md), [Storage & Sync lane](../lanes/storage-and-sync.md).

### AD91: Governed Mode migration is a verified, gated, chunked state machine (REPLACE copy), not a boolean-marker lazy reconcile

**Category:** Storage

**Status:** Accepted (2026-06-30). Supersedes the migration mechanics of [AD89](#ad89-governed-mode-deployment-wide-r2-sse-c-disable-via-a-kv-toggle-with-lossless-in-place-re-encrypt-migration) (the policy toggle + intent are unchanged).

**Context:** The AD89 first-login lazy reconcile broke in production on an enterprise bucket. Verified live via the R2 S3 API: of 663 objects, 0 were migrated, the boolean `UserPreferences.r2SseRegime` marker was never set, and the migration lock was stuck — yet the in-container rclone bisync daemon wrote a few plaintext files, leaving a **mixed** bucket whose SSE-C reads then 400'd, so R2 sync failed and the vault never became ready; toggling OFF did not recover (the revert path early-returned without scanning for the outliers).

Four root causes: (1) `migrateBucketEncryption` issued a same-key self-copy with `MetadataDirective=COPY`, which R2 rejects → every copy failed; (2) a single boolean marker cannot describe a partially in-place-migrated bucket — reads key off it, so any converted object 400s mid-migration; (3) the revert path early-returned when `marker==policy`, never scanning for strays; (4) the in-container rclone daemon writes R2 directly with its baked regime and the worker cannot header-gate it. Confirmed by a GPT-5.5 consult + a 3-agent analysis workflow.

**Decision:**

- **Per-bucket state object**

`r2-regime:<bucket>` (`{status: ready|migrating|mixed-recovery, regime, from?, to?, generation, cursor?, phase?, drained?, leaseExpiresAt?, keyMd5?, stuckCount?, lastFailedKey?, total?, processed?, halted?}`) is the single source of truth, replacing the boolean marker AND the standalone lock (the `leaseExpiresAt` is the per-chunk in-flight lock; a legacy `r2SseRegime='plain'` is still read one-way for pre-existing migrated buckets).
- **REPLACE copy.** Re-encrypt in place with `MetadataDirective=REPLACE` (not COPY), re-supplying source-HEAD metadata + `copy-source-if-match`, and parse the 200 CopyObject body for an embedded `<Error>`. Oversized (>5 GB) objects are recorded + skipped, not fatal.
- **Bounded, verified driver that always releases its lease.** The dashboard `batch-status` poll calls `planRegimeReconcile` synchronously (reports `bucketMigrating`) and `waitUntil(advanceMigration)` runs the copy work as a **slice-driven scan**.

  It lists a large page (`LIST_PAGE_SIZE`, up to 1,000 keys) and re-encrypts it in `MIGRATION_CONCURRENCY`-sized slices (6 = the platform's outgoing-connection-per-invocation limit). Each object is **one source-regime HEAD** (`400/403` SSE-mismatch ⇒ already migrated ⇒ skip; `200` ⇒ migrate) then a same-key `CopyObject` — two R2 ops, not three.

  Each op runs under a **per-op timeout that AbortController-cancels** on expiry (`withTimeout` + `fetchWithTimeout`), freeing the connection. The `cursor` is a **`start-after` key** checkpointed after every chunk (resume continues exactly past it — no re-scan), and migrate→verify transitions in one invocation when budget remains.

  Crucially, each invocation **starts another list + slice only while one more fits before its ~22s work deadline** (`WORK_DEADLINE_MS`, checking *real elapsed time* and reserving one list + slice's worst case `LIST_TIMEOUT_MS` + `MIGRATE_SLICE_MS`/`VERIFY_SLICE_MS`; the first slice of an invocation always runs for forward progress) — or its R2-op count nears `MAX_SUBREQUESTS` — then **releases the lease**, so the next poll resumes from the cursor; `MIGRATION_LEASE_MS` (60s) is now only a crash backstop.

  The regime + `generation` advance **only after a clean full verify**. `WORK_DEADLINE_MS + MIGRATE_SLICE_MS < 30s` guarantees the last started slice finishes before the uncatchable force-kill, which would leave the lease held.

  This took FOUR iterations, each verified live on the 680-object integration bucket. Draft 1: one sequential page per poll, 10-min lease → blew the `waitUntil` clock, killed mid-page before persisting the cursor, long lease blocked every poll. Draft 2: 16-way concurrency + a multi-page loop on a 15s budget → exceeded the 6-connection limit and overran the ~30s window → force-killed (uncatchable) → lease held → still stalled.

  Draft 3: page pinned to one 6-object slice, gated on the WORST-CASE page wall-clock (~20s of a 26s budget) — correct, but it reserved ~77% of every invocation as headroom → ~30 objects/poll → minutes for a few-hundred-object bucket (user-rejected as too slow). Draft 4 (this one): gate per-SLICE on real elapsed time with `start-after` checkpointing and a 2-op object chain, using the whole budget → a small bucket converges in ONE poll in seconds. Root-caused/validated via GPT-5.5 consults + code-review passes over live KV/worker forensics.
- **Backend gate + container drain (the safety boundary).**

While not `ready`, every writer returns `409 BUCKET_MIGRATING`, the sync fan-out is skipped, running containers are drained (best-effort — a drain failure leaves a brief stray-write window, caught by the verification rescan + read self-heal), and in-flight multipart uploads are aborted. The frontend reuses the "Upgrading" affordance (New Session → "Migrating N%").
- **Dual-regime reads + self-heal.**

Reads try the committed regime then fall back once on a 400/403; a fallback hit on a `ready` bucket triggers a one-time `mixed-recovery` scan that re-encrypts strays to the committed regime — exactly the production-incident shape, now self-healing.

**Revised 2026-07-01 (migration UX, no engine change):** live forensics (1,068-object integration bucket) confirmed the engine completes in ~2 min (`status:ready`, `generation` bumped) — the "stuck on Migrating" report was two UI gaps, now fixed: the 5s background poll (`refreshSessionStatuses`), not just the full load, mirrors the migration flags so a completed migration clears without a reload; and a 0–99 `bucketMigrationPercent` (from a one-time object `total` count + `processed` across both passes, suppressed when `halted`) drives a "Migrating N%" label. The ~2 min is at the platform ceiling (6 connections/invocation × single-invocation lease); the fix is UX, not concurrency.

**Rejected — container regime generation guard.** A secondary guard threading a regime `generation` into the container and refusing stale-regime bisync was scoped but **not built**: `/start` is gated and containers are drained at migration start, so no container runs with a stale regime; and the verify-rescan + read self-heal already catch any object an un-drainable zombie writes. It added surface (container-env, entrypoint, container-router) for no coverage the gate+verify+self-heal don't provide. **Rejected — Durable Object / Queue / Workflow:** overkill for single-tenant ~hundreds-of-objects buckets; a chunked-resumable `waitUntil` pass is provably sufficient under either subrequest budget. **Rejected — ENCRYPTION_KEY old-key fallback:** key rotation is detect-only via `keyMd5`.

**Consequences:** A regime flip (both directions) is atomic from the user's view, resumable, verified, and never leaves the bucket unreadable; the prior mixed-bucket incident self-heals on next read. Residual risk: a container whose best-effort drain `destroy()` fails could write a stray during the ~tens-of-seconds window — caught by the verify-rescan and read self-heal, and bounded by the idle timeout. New modules: `src/lib/r2-regime-state.ts` (state), `src/lib/migration-containers.ts` (drain/health). Verified on enterprise-integration by an R2 S3 HEAD-scan (0 objects in the wrong regime) both directions.

**Related:** [REQ-ENTERPRISE-020](../../sdd/spec/enterprise-mode.md#req-enterprise-020-governed-mode-re-encrypt-migration-engine), [REQ-ENTERPRISE-021](../../sdd/spec/enterprise-mode.md#req-enterprise-021-governed-mode-migration-safety-and-access-boundary), [AD89](#ad89-governed-mode-deployment-wide-r2-sse-c-disable-via-a-kv-toggle-with-lossless-in-place-re-encrypt-migration), [Deployment lane](../lanes/deployment.md#governed-mode-migration-batch-status-driven), [Configuration lane](../lanes/configuration.md), [Storage & Sync lane](../lanes/storage-and-sync.md), [Security lane](../lanes/security.md).

---

### AD92: Bundle the official Cloudflare skills into the advanced seed (slimmed references, WebFetch retrieval)

**Category:** Agents

**Status:** Accepted (2026-06-30).

**Context:** Codeflare is a Cloudflare-native build platform (agents scaffold/deploy Workers, D1, R2, KV, DNS) AND an enterprise Zero Trust product (the enterprise mode *is* Cloudflare One — Access, Secure Web Gateway, WARP, AI Gateway). The official Cloudflare skills repo ([github.com/cloudflare/skills](https://github.com/cloudflare/skills), Apache-2.0, ~2k★) ships 11 Agent Skills + 2 commands directly on-point for what Codeflare's Pro agents do. The agent seed is bundled into the Worker (`r2-seed.ts` imports `AGENTS_SEEDED_CONFIGS`), and every skill is copied per-agent (Claude/Codex/Gemini/OpenCode/Pi), so seed size is a **Worker-bundle-size** concern, not just per-bucket sync.

**Decision:**

- **Bundle all 11 skills + 2 commands, advanced-mode only,** via the existing manifest pipeline ([REQ-AGENT-014](../../sdd/spec/agents.md#req-agent-014-manifest-driven-preseed-pipeline)) — including `cloudflare-one` (Zero Trust / SASE) which maps to enterprise Codeflare. Auto-seeded to all agents; default mode gets none.
- **Slim the cloudflare mega-skill.**

Keep its decision-tree `SKILL.md` (and drop the now-dangling `references:` frontmatter); **drop its 319-file `references/` tree.** Bundling it copied ~2.2 MB × ~5 agents into the Worker, doubling the seed to **19 MB raw / 5.26 MB gzip** (verified). The skill is explicitly retrieval-first ("the references are starting points, not source of truth"), so the references are redundant with live-doc retrieval. Slimmed, the seed is **11 MB raw / 3.3 MB gzip** (Worker total ~3.7 MB gzip, well under the 10 MB limit), back near the pre-bundle 2.76 MB.
- **WebFetch retrieval, not the bundled MCP.**

Exclude the upstream `.mcp.json` (5 remote MCP servers — strict-egress-blocked + interactive OAuth + always-on MCP-schema token cost). Convert the upstream Cursor `workers.mdc` into a `paths:`-scoped Claude rule (`rules/cloudflare-workers.md`) that loads only on Workers files and points retrieval at `developers.cloudflare.com` via WebFetch. In enterprise strict-egress the operator allowlists that host.
- **Apache-2.0 attribution:** the upstream `LICENSE` is vendored alongside the skills.

**Rejected — bundle the full references/ tree:** it fits the 10 MB limit but spends ~half the remaining Worker headroom on retrieval-first markdown the skill itself disclaims; redundant with the chosen WebFetch path. **Rejected — wire the cloudflare-docs MCP:** adds egress-allowlist + lazy-MCP wiring and an always-on tool-schema cost for a capability WebFetch already covers. **Rejected — language-rules-to-skills token optimization:** the language rules are already `paths:`-conditional (not always-on), so there was nothing to reclaim there.

**Consequences:** Pro agents get authoritative, retrieval-first Cloudflare guidance (platform, Workers best practices, Wrangler, Durable Objects, Agents SDK, Sandbox SDK, Turnstile, email, web-perf, Zero Trust) without growing the always-on token budget meaningfully (~+450 tok of trimmed descriptions; bodies/references load on demand) and without bloating the Worker. A `scripts/measure-seed-tokens.mjs` tool reports the always-on seed budget per mode.

**Related:** [REQ-AGENT-075](../../sdd/spec/agents.md#req-agent-075-cloudflare-platform-skills-bundled-into-the-advanced-seed), [REQ-AGENT-014](../../sdd/spec/agents.md#req-agent-014-manifest-driven-preseed-pipeline), [REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress), [Configuration lane](../lanes/configuration.md), [Security lane](../lanes/security.md), [Preseed lane](../lanes/preseed.md).

---

### AD93: Refresh the non-enterprise Cloudflare OAuth token at the `api.cloudflare.com` boundary, reusing the browser interceptor

**Category:** Architecture, Security

**Status:** Accepted (2026-07-04).

**Context:** Non-enterprise "Connect to Cloudflare" ([REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth)) authenticates a user against Cloudflare's dashboard OAuth, which — like `wrangler login` — issues **short-lived access tokens** that expire within hours (`offline_access` yields a `refresh_token`, but the access token still expires; there is no long-lived-token option). `applyCloudflareOAuthToken` resolved a valid token at session start and baked it into the container as `CLOUDFLARE_API_TOKEN`. Nothing refreshes an env var already set in a running container, so after the TTL every `api.cloudflare.com` call — `wrangler` deploys and browser-run's Browser Rendering REST + CDP WebSocket — failed with `9109 Invalid access token`.

Reproduced live against a running container (its 93-char OAuth token returned `9109`). The refresh machinery (`getValidCloudflareToken`, which mints a fresh token from the encrypted per-user `refresh_token`) already existed but only ran server-side at container start — never reaching a live session.

**Decision:** Stop baking the token in. For an `'oauth'`-source session inject only a non-secret placeholder (`CLOUDFLARE_OAUTH_TOKEN_PLACEHOLDER = 'codeflare-oauth'`) as `CLOUDFLARE_API_TOKEN`, and intercept `api.cloudflare.com` at the container-egress boundary, stamping a **freshly-refreshed** token per request.

Reuse — not rebuild — the existing enterprise `CloudflareBrowserInterceptor` ([REQ-BROWSER-008](../../sdd/spec/browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container)): there is only one interceptor per host, and browser-run's CDP surface is a WebSocket that needs the interceptor's existing `bridge()`, so the wrangler REST path and the browser-run WS path must share one interceptor.

The interceptor gains a second **OAuth mode** (props carry `bucket`): it trusts **all** `api.cloudflare.com` paths (the OAuth token is a full-scope API token, unlike the enterprise browser-rendering-path-only trust), resolves the token solely from the session-bound `props.bucket` via `getValidCloudflareToken` (never a request header — no cross-user spoof), reuses `relay()`/`bridge()` for REST + CDP, and fails closed `401` with no upstream when no valid token can be minted.

Wiring (the `cloudflareOauthApi` interception-registry entry in `container-interception.ts`) is double-guarded: `!isEnterpriseMode(env)` **and** the container token equals the OAuth placeholder — so enterprise (which never has an oauth source) can never wire it, and there is no host collision with the enterprise browser interceptor. The placeholder **value** is itself the DO's OAuth-mode signal, so no new DO state or plumbing is needed.

**Rejected — a container-side pull/refresh helper (poll the worker for a fresh token, rewrite the env):** heavier, and a POSIX process's environment cannot be mutated by another process after it starts, so a refreshed value would never reach the already-running `wrangler`/browser-run — the boundary is the only place a per-call fresh token can be applied. **Rejected — a background worker that re-issues the container env var:** same env-immutability problem, plus new lifecycle machinery.

**Rejected — ungating the GitHub interceptor for non-enterprise too:** unnecessary — GitHub tokens are long-lived, so non-enterprise git has no expiry bug and no reason to route high-frequency git traffic through the worker; the only host newly intercepted is `api.cloudflare.com`, and only for OAuth sessions. **Rejected — a new dedicated interceptor class:** one-interceptor-per-host and the shared WS `bridge()` requirement make extending the existing class strictly simpler than a parallel class.

**Consequences:** A non-enterprise OAuth session now survives indefinitely past the access-token TTL for both wrangler and interactive browser-run. The real OAuth access token never enters the (untrusted) container — the blast radius of a prompt-injected read is a non-secret placeholder — extending the [REQ-SEC-002](../../sdd/spec/security.md#req-sec-002-api-tokens-never-enter-containers) "tokens never enter containers" invariant to the per-user OAuth token. Enterprise is byte-identical: the enterprise interceptor branch and `applyEnterpriseBrowserToken` are unchanged, and the existing REQ-BROWSER-008 suite is the regression oracle. A **PAT**-source non-enterprise session is unchanged (its token is long-lived and still passes to the container). One added per-request worker hop on `api.cloudflare.com` for OAuth sessions — a low-frequency host — with `getValidCloudflareToken` short-circuiting when the cached token is still valid.

**Related:** [REQ-AGENT-078](../../sdd/spec/agents.md#req-agent-078-cloudflare-oauth-token-refreshed-at-the-apicloudflarecom-boundary), [REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth), [REQ-BROWSER-008](../../sdd/spec/browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container), [REQ-SEC-002](../../sdd/spec/security.md#req-sec-002-api-tokens-never-enter-containers), [AD81](#ad81-reuse-the-container-egress-injection-layer-for-per-user-github-tokens).

---

### AD94: Content-hash manifest for vault-extract change detection (mtime is reset by the R2 restore)

**Category:** Storage

**Status:** Accepted (2026-07-05).

**Context:** vault-extract detected user edits by **file mtime**: `vault-extract.last` (a marker in ephemeral `~/.cache/codeflare-hooks/`) plus a `find -newer` scan (Claude daemon + contract) / `statSync().mtimeMs > since` walk (Pi). The boot R2 restore is `rclone sync` **without** `--use-server-modtime` (only the later bisync baseline uses it), and it rewrites **every** vault file's mtime to download-time — measured live on a real vault: a May-authored note comes back stamped that day's date, all 31 files clustered at one instant. `~/.cache/**` is excluded from R2 sync ([entrypoint.sh](../../entrypoint.sh) filters), so the marker is re-seeded fresh each boot.

On the boot where the restore (or a subsequent bisync with `--conflict-resolve newer`) stamps file mtimes *after* the seeded marker, `find -newer` matches the whole vault and the sonnet extractor re-reads every note — **~200k tokens / ~20 min every session**. The failure is a race, which is why it presented intermittently.

**Decision:** Detect changes by **content, not time**. A stdlib `vault-manifest.py` (Claude daemon + vault-extract contract) and a byte-parity `vault-manifest-fs.ts` (Pi extension) compute `{vault-relative path → sha256 of bytes}` and report a file changed iff its hash differs from — or is absent in — a persisted manifest at `graphify-out/vault-extract-manifest.json`. That path is allow-listed through the `- Vault/graphify-out/**` bisync exclusion (alongside `vault-graph.json`), so it round-trips to R2 and survives restart.

The manifest is baselined from current content **only when absent** (the first session for a vault); on every later boot it is restored and never re-baselined, so a prior session's edited-but-unextracted file is still detected. `vault-extract.last` is retained purely as the ephemeral within-session vars-staleness dedup timestamp — never change detection — and the obsolete `init_user_vault` preseed-page marker-bump is removed (the four pages are excluded and unchanged bytes never register).

**Rejected — preserve/round-trip mtimes on the restore (add `--use-server-modtime` to Step 1):** fragile and fights [AD88](#ad88-bisync-compares-via-server-modtime-from-fast-list-not-per-object-mtime-heads)'s deliberate server-modtime bisync; the round-trip does not faithfully preserve edit times anyway (measured), and any editor or process touch would re-fire a full scan.

**Rejected — move the mtime marker into the synced vault:** the restore resets the *marker's* mtime too, so an mtime-vs-mtime comparison stays meaningless after restart.

**Rejected — store the high-water timestamp as marker *content* and compare it against file mtimes:** the file mtimes are also reset to download-time, so the comparison is still meaningless. Only comparing content hashes is immune.

**Consequences:** A returning session re-extracts nothing when content is unchanged — the mtime reset becomes a total non-issue because the manifest is read by its JSON contents and its own mtime is never consulted. No data loss: a prior session's unextracted file has no manifest entry, so it is still detected next session (the constraint that ruled out stamping a fresh baseline at boot). One implementation format shared across runtimes (Claude bash + Pi TypeScript). The enterprise / OAuth token boundary is untouched — this is vault/memory-graph infrastructure only, running identically in both runtimes. Cost: a sha256 pass over ~100 small markdown files per 60s daemon tick — negligible, stdlib-only, no graphify/networkx dependency.

**Revision (2026-08-10):** `graphify-out/vault-extract-initialized` now records that the first durable initialization has occurred and is R2-allow-listed beside the manifest. Only a newly created vault with neither that marker nor prior vault state receives a current-content baseline. An existing or restored vault that predates the marker follows a migration path: init records the marker without baselining. If the manifest is missing during migration, or goes missing after initialization, all eligible content remains full-delta eligible. This narrows the historical "only when absent" wording above: manifest absence by itself no longer proves a first session.

**Related:** [REQ-VAULT-026](../../sdd/spec/vault.md#req-vault-026-vault-extract-change-detection-survives-container-restart-content-hash-manifest), [REQ-VAULT-003](../../sdd/spec/vault.md#req-vault-003-user-curated-edits-are-detected-and-ingested-within-60s), [REQ-VAULT-001](../../sdd/spec/vault.md#req-vault-001-persistent-vault-directory-survives-across-sessions), [AD88](#ad88-bisync-compares-via-server-modtime-from-fast-list-not-per-object-mtime-heads), [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad).

---

### AD95: Browser IDE is session-isolated (the deliberate opposite of the bucket-stable Vault)

**Category:** Architecture, Security

**Status:** Accepted (2026-07-11); amended by [AD119](#ad119-replace-openvscode-with-pinned-code-server-behind-the-existing-session-proxy) and [AD120](#ad120-browser-ide-uses-fixed-public-workspace-selection-and-exported-ui-state-continuity) on 2026-07-28, then by [AD132](#ad132-user-extensions-are-a-bounded-manifest-over-an-immutable-base-inventory) on 2026-08-17.

**Context:** The Vault editor (SilverBullet) is deliberately **bucket-stable** ([REQ-VAULT-021](../../sdd/spec/vault.md)): it is served under `/api/vault/<bucketToken>/` (a per-R2-bucket token; the session id rides in the `cf_vault_sid` cookie, never the URL) so `location.href`, the service-worker scope, and IndexedDB store names stay identical across all of a user's sessions — one persistent notes store, no re-index every session. The new browser IDE (OpenVSCode Server, [REQ-IDE-001](../../sdd/spec/browser-ide.md#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy)) reuses the same Worker → Container → host proxy chain, so the obvious move is to copy the vault pattern wholesale.

That would be wrong: each session has a *different* `~/workspace` (different repos, branches, working state), so a bucket-stable IDE URL is ambiguous ("which session's workspace?") and would bleed one session's editor state into another.

**Decision:** The IDE is **session-isolated** — the exact opposite of the vault. The sessionId is the sole container selector and appears at every layer: the route parser (`validateVscodeRoute`, session-keyed only, no bucket-token branch), the container routing (`getContainerId(bucket, sessionId)`), OpenVSCode's `--server-base-path=/api/vscode/<sessionId>` (so it builds its own asset + service-worker URLs under the per-session path), an ephemeral per-container `--server-data-dir` under `/tmp` (never R2-synced), and the header open-URL.

Because `--server-base-path` makes OpenVSCode base-path native, the Worker and host forward the path **unchanged** — no `/vault`-style strip, no HTML base-href / service-worker graft (the entire `vault-view.ts` machinery is unnecessary). The auth boundary is identical to the vault: Cloudflare Access + effective-tier + session-ownership at the Worker, the container-auth Bearer injected by the container DO fetch wrapper, and a localhost-only bind with `--without-connection-token`.

**2026-07-28 amendment:** AD119 preserves the session-keyed external URL and ephemeral live state but changes the internal routing mechanism. code-server does not receive the session prefix: the host strips exactly `/api/vscode/<sessionId>` before forwarding HTTP and WebSocket traffic, and canonical validated forwarded host/protocol headers preserve code-server's Origin enforcement. AD120 then adds one deliberately bucket-level exception: a bounded exported UI snapshot, never a live editor store. The earlier OpenVSCode `--server-base-path` and unchanged-path details are historical, not current implementation constraints.

**2026-08-25 amendment:** Session-isolated live editor data now uses `/run/codeflare/openvscode`. It remains container-lifetime and never R2-synced, but disposable `/tmp` cleanup can no longer break the running editor or its supervisor. <!-- @impl: entrypoint.sh::_openvscode_launch_once -->

**Rejected — reuse the vault's bucket-stable serving ([REQ-VAULT-021](../../sdd/spec/vault.md)) for the IDE:** that layer exists to *share* one store across sessions; applied to the IDE it collapses every session's editor onto one bucket-scoped service worker + storage, so switching sessions would show the wrong workspace and leak state. Session isolation is a hard requirement, not a preference.

**Rejected — run OpenVSCode at root (`--server-base-path=/`) and strip the prefix like the vault:** OpenVSCode would then build asset / service-worker URLs at `/`, which resolve against the Worker root (no handler → white screen), forcing the same HTML base-href graft the vault carries. The `--server-base-path` flag (confirmed in `microsoft/vscode`'s `serverEnvironmentService.ts`) removes the entire class of problem, so the IDE is *simpler* than the vault, not a copy of it.

**Consequences:** Two sessions yield two fully isolated editors (distinct base path, service-worker scope, server-data-dir, and container); a session the user does not own is unreachable (the ownership guard 404s). The IDE lazy-starts — a supervisor gated on the init flag, a first-request trigger, and a resolved `SESSION_ID` — so sessions that never open it pay nothing, and it is advanced-mode only. Workspace edits persist via the *existing* final-sync R2 bisync (no new drain path); live editor/extension state under `/tmp` is intentionally ephemeral; only AD120's bounded theme, keyboard-layout, Explorer, and open-file snapshot persists. A future maintainer must not "unify" the two editors: keep the vault bucket-stable and the IDE session-keyed.

**Related:** [REQ-IDE-001](../../sdd/spec/browser-ide.md#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-IDE-002](../../sdd/spec/browser-ide.md#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-003](../../sdd/spec/browser-ide.md#req-ide-003-ide-lifecycle-and-availability), [REQ-VAULT-021](../../sdd/spec/vault.md), [REQ-SEC-008](../../sdd/spec/security.md).

---

### AD96: Deactivate codex/copilot V8 warm-up and OpenCode DB pre-init (image size)

**Category:** Build / Container

**Status:** Accepted (2026-07-11).

**Context:** [container.md](../lanes/container.md#v8-compile-cache-warm-up) documented that `codex` and `copilot` are warmed at Docker build time via `--version`, and that `opencode run "hello"` pre-runs OpenCode's one-time Goose DB migration at build time. The OpenCode warm-up alone baked ~147MB of `opencode` data into the image.

**Decision:** Both warm-ups are commented out (not deleted) in the Dockerfile. `codex` and `copilot` skip the V8 compile-cache bake; OpenCode skips the build-time DB migration. Each CLI now pays its own first-launch cost instead of paying it at build time for every image. Claude Code (its own `--version` verify) and Pi (V8 `--version` + the jiti extension warm, [AD79](#ad79-image-baked-pi-extension-transpile-cache)) keep their prewarm.

**Consequences:** Smaller image (~147MB saved from the OpenCode change alone); first launch of `codex`, `copilot`, and `opencode` inside a fresh container is slower (pays JS compile / DB migration cost once per container instead of never, at build time). Re-enabling either is a Dockerfile uncomment (see inline comments next to `RUN pi --version` and the `opencode run "hello"` block).

**Related:** [container.md § V8 Compile Cache Warm-Up](../lanes/container.md#v8-compile-cache-warm-up), [container.md § OpenCode Database Pre-Initialization](../lanes/container.md#opencode-database-pre-initialization).

---

### AD97: Keep OpenVSCode upstream-clean and accept known vulnerability risk

**Category:** Security, Build / Container

**Status:** Superseded by [AD119](#ad119-replace-openvscode-with-pinned-code-server-behind-the-existing-session-proxy) on 2026-07-28.

**Context:** The pinned OpenVSCode release installed by the [Dockerfile](../../Dockerfile) includes upstream packages and bundled extensions reported with known HIGH/CRITICAL vulnerabilities, including command-injection and remote-code-execution classes. Repositories opened in the editor are untrusted input, and a successful exploit could access that session's workspace and credentials. Codeflare's container isolation, inspection, and platform guardrails reduce blast radius and improve detection; they do not eliminate this risk. Those accepted findings were explicit in [`.trivyignore`](../../.trivyignore) until AD119 removed the runtime and its suppressions; the historical acceptance was governed by [REQ-IDE-001](../../sdd/spec/browser-ide.md#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-container-image-scanned-for-cves-before-deploy), and the historical security posture now superseded by [AD119](#ad119-replace-openvscode-with-pinned-code-server-behind-the-existing-session-proxy).

**Decision:** Ship the pinned OpenVSCode artifact unchanged. Clean upstream version bumps take precedence over local vendored-package rewrites, extension removal, or a Codeflare-maintained fork because a locally modified artifact would obscure provenance, complicate verification, and make each upstream security update harder to adopt. This is an explicit acceptance of the known vulnerability and RCE risk, not a claim that session isolation makes the artifact safe.

**Alternatives considered:** Disable the Browser IDE until upstream clears every finding; patch or fork OpenVSCode and its bundled packages locally; remove vulnerable bundled extensions; or publish a separately patched artifact. Each can reduce current exposure, but each either removes the approved product surface or creates a local artifact lifecycle that competes with prompt upstream upgrades.

**Consequences:** Operators accept the documented editor risk while retaining reproducible, upstream-clean upgrades. Enterprise mitigations are per-session Codeflare container isolation plus enterprise inspection and guardrails; they constrain and observe the workload but cannot guarantee containment of an editor exploit. Every OpenVSCode upstream bump must re-review this decision, the scanner exceptions, and available fixed releases. Review is also required immediately when credible evidence shows critical exploitation in the wild or a materially more severe reachable exploit path. Acceptance expires at either trigger until the review records whether to upgrade, disable, or renew the decision.

**Related:** [REQ-IDE-001](../../sdd/spec/browser-ide.md#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-container-image-scanned-for-cves-before-deploy), [Browser IDE security](../lanes/security.md#code-server-supply-chain-and-reverse-proxy-boundary).

---

### AD98: Pi PR review uses visible session-scoped agents

**Category:** Agents

**Status:** Accepted (2026-07-12); amended 2026-07-22 with live-session agent-end acknowledgement, settled fallback, and event-scoped boundary identity; amended 2026-07-30 so explicit user bypasses acknowledge the validated boundary head; amended 2026-08-03 to derive eligibility from authoritative checked-out-branch state; amended 2026-08-17 with exact-head disposition checkpoints and pre-delivery recovery; amended 2026-08-20 with initiating-cycle recovery isolation.

**Supersedes:** [AD76](#ad76-durable-review-lanes-run-as-detached-headless-pi-processes), [AD80](#ad80-pi-pr-boundary-merge-gate-is-report-only-and-defended-in-depth)

**Amends:** [AD78](#ad78-pr-boundary-review-lanes-run-in-parallel-report-only-reviewers)

**Context:** Pi's durable review design accumulated detached lane processes, job directories, PID recovery, monitor claims, result summaries, status rendering, and a hard merge gate. The recovery machinery became larger and less reliable than the review behavior it protected. Pi exposes visible public subagent calls, completion notifications correlated by tool-use ID, root/child session lineage, live session entries at `agent_end`, and an `agent_settled` fallback. Those primitives express reminder and completion proof without a second execution system. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement -->

**Decision:** Pi PR-boundary review is session-scoped ([REQ-AGENT-055](../../sdd/spec/agents.md#req-agent-055-pi-session-scoped-review-window), [REQ-AGENT-071](../../sdd/spec/agents.md#req-agent-071-pr-boundary-review-agent-dispatch)). Each executable `git` or `gh` candidate is paired with the repository resolved from its exact executable shell segment. The repository's checked-out branch and local `HEAD` must exactly match that branch's authoritative open protected-base PR head; command arguments do not supply push source, destination, configured push branch, or merge identity. Deterministic parent-shell `cd` changes are carried between segments; pipeline cwd changes do not propagate, and unresolved conditional cwd changes fail closed.

The emitted review window persists boundary-call, repository, branch, PR, base, and full-head identity, while PR-number-specific checkpoints preserve independent incremental ranges, so lifecycle acknowledgement never reroutes through ambient cwd or active-repository memory. <!-- @impl: preseed/agents/pi/extensions/active-repo-memory.ts::commandInvocations --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::launchBoundaryPlan --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::currentReview -->

The live handler records a boundary as evaluated only after authoritative state resolves to a launch or a conclusive no-plan outcome. A launch or acknowledgement checkpoint includes its exact repository, PR, head, and disposition before Pi queues the follow-up; runtime-local queued identities suppress duplicate plans and missing-work messages until delivery becomes visible. A temporarily unavailable or stale boundary defers that marker and retries through same-session agent-end and settled recovery. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement -->

Existing-session startup or resume recovers an accepted plan only within its initiating boundary cycle when the queued message is absent. A newer raw Git boundary is evaluated independently and never inherits the older cycle's launch authorization. An acknowledged FIX handoff can likewise be recovered once, and a transcript-visible FIX retires its review window before later head-drift handling. Each path emits the initial plan once ([REQ-AGENT-058](../../sdd/spec/agents.md#req-agent-058-supported-boundary-recovery), [REQ-AGENT-110](../../sdd/spec/agents.md#req-agent-110-pi-pr-boundary-missing-launch-follow-up), [REQ-AGENT-126](../../sdd/spec/agents.md#req-agent-126-pi-review-checkpoint-persistence-and-head-drift), [REQ-AGENT-141](../../sdd/spec/agents.md#req-agent-141-authoritative-head-review-launch-continuity)). <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement -->

With a valid prior acknowledgement, the reminder and every counted reviewer prompt carry the exact acknowledged-to-current range; otherwise the full protected-base PR is reviewed. Unmatched calls remain in flight until native terminal notification. Only the reminder SHA can be acknowledged. The ordinary completion path requires a tool-free root response containing the fixed triage table after every required successful notification; `agent_end` reads live session state, writes the acknowledgement, and emits one next-turn FIX handoff, with `agent_settled` as the idempotent fallback ([REQ-AGENT-055](../../sdd/spec/agents.md#req-agent-055-pi-session-scoped-review-window), [REQ-AGENT-098](../../sdd/spec/agents.md#req-agent-098-pi-review-triage-acknowledgement-barrier)).

The explicit user-only sentinel and post-boundary bypass wording are the sole exception: after fresh repository, branch, open-PR, base, and head validation they write that same reminder SHA directly, consume the sentinel when present, and launch no reviewers for it. They do not fabricate reviewer evidence or a FIX phase ([REQ-AGENT-041](../../sdd/spec/agents.md#req-agent-041-pr-boundary-review-bypass-surfaces), [REQ-AGENT-098](../../sdd/spec/agents.md#req-agent-098-pi-review-triage-acknowledgement-barrier)).

Review agents remain parallel and report-only. The root main session alone fixes, commits, and pushes. Pi keeps no pre-command merge gate, durable lane, `review-monitor`, result file, summary, or lane/result recovery state. Its tool-use evaluation marker prevents an old ineligible push from becoming eligible later; missing-handler recovery cannot fabricate completion.

Pi owns native reviewer agents, engineering rules, and spec/document enforcement skills. Their shared `review-scope` contract treats PR-boundary review as diff scope, limits diff work to changed hunks and direct invalidations, and reserves exhaustive scans for explicit all scope. Seed generation gives these Pi manifest paths precedence over transformed Claude paths, so Claude review behavior is unchanged.

**Alternatives considered:** Retain detached lanes and repair their recovery paths; keep only a durable checkpoint; call `SubagentsService` directly; parse reviewer findings into another state machine; or preserve the hard Pi merge interceptor. Each adds a second source of execution or completion truth. The public tool call plus root transcript already provides the required proof with fewer failure modes.

**Consequences:** Review execution is visible and simple, but active reviews end with the Pi session. A missed initial live handler is recovered once from its persisted successful boundary after reload; already-launched unfinished work requires a later supported boundary to rerun. An explicitly bypassed head is already acknowledged and therefore does not rerun. Triage and fixing consume separate root turns for reviewed heads, preventing accepted fixes from replacing the reviewed head before acknowledgement and preserving incremental push ranges. AD78's parallel report-only policy remains; only Pi's durable result-file mechanics are replaced. AD76's detached lane architecture and AD80's hard merge gate no longer govern Pi.

**Related REQ:** [REQ-AGENT-036](../../sdd/spec/agents.md#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-041](../../sdd/spec/agents.md#req-agent-041-pr-boundary-review-bypass-surfaces), [REQ-AGENT-053](../../sdd/spec/agents.md#req-agent-053-pi-native-review-result-correlation), [REQ-AGENT-055](../../sdd/spec/agents.md#req-agent-055-pi-session-scoped-review-window), [REQ-AGENT-071](../../sdd/spec/agents.md#req-agent-071-pr-boundary-review-agent-dispatch), [REQ-AGENT-074](../../sdd/spec/agents.md#req-agent-074-pi-settled-review-handoff), [REQ-AGENT-098](../../sdd/spec/agents.md#req-agent-098-pi-review-triage-acknowledgement-barrier), [REQ-AGENT-110](../../sdd/spec/agents.md#req-agent-110-pi-pr-boundary-missing-launch-follow-up), [REQ-AGENT-126](../../sdd/spec/agents.md#req-agent-126-pi-review-checkpoint-persistence-and-head-drift), [REQ-AGENT-132](../../sdd/spec/agents.md#req-agent-132-pr-delivery-and-existing-head-consent), [REQ-AGENT-141](../../sdd/spec/agents.md#req-agent-141-authoritative-head-review-launch-continuity), [REQ-AGENT-145](../../sdd/spec/agents.md#req-agent-145-failed-pr-creation-reconciliation).

---

### AD99: Pi CI monitoring uses one attached native background subagent

**Category:** Agents

**Status:** Accepted (2026-07-12; amended 2026-08-04)

**Context:** Pi CI monitoring mixed three conflicting paths: a review-owned handoff, a generic agent prompt, and a detached shell embedded in a skill. Native task completion could arrive before the detached monitor finished. Historical incidents included duplicate launches, startup prompt collisions, shell and `jq` false results, workflow-name drift, PR checks missed by commit-SHA lookup, and lost delivery after reload. The replacement therefore needs one executable request resolver that validates the event, repository, open PR, protected base, and authoritative head before returning one native monitor request. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::resolveCiMonitorRequest -->

**Decision:** CI monitoring is independent of review completion and acknowledgement ([REQ-AGENT-068](../../sdd/spec/agents.md#req-agent-068-independent-pi-ci-monitoring)). After an eligible head-changing boundary, the PR-boundary extension emits one ordered launch plan: required reviewer calls first and an independent CI request second. The root invokes the resolver exactly once with the affected repository cwd and explicit review launch state immediately after reviewer calls. The resolver returns no action or one public background `ci-monitor` request for the authoritative PR number and `headRefOid`.

The dedicated agent runs one attached Node process and returns `CI_RESULT` through native task notification. Script timeouts bound runtime; no agent turn cap may replace the verbatim result with a wrapper summary. Malformed and superseded heads fail closed. [REQ-AGENT-090](../../sdd/spec/agents.md#req-agent-090-ci-monitor-head-correction-is-authoritative-and-fail-closed) permits only the remote-qualified 41-character transcription correction. <!-- @impl: preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs::monitorCi -->

A correlated successful public launch tool result immediately writes the exact per-PR CI-head checkpoint independently from review acknowledgement. Agent-end and settled transcript correlation remain idempotent fallbacks. Settled recovery checks the durable checkpoint before requesting missing CI, so a live transcript snapshot that has not yet incorporated the tool result cannot create a repeated follow-up loop. Failed, mismatched, or transiently unverifiable launches remain retryable. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::checkpointCiLaunch --> <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement -->

**Alternatives considered:** Repair the shared review/CI handoff; add a durable CI claim; keep the detached shell and watch its log; monitor hard-coded workflows or `gh run list --commit`; or auto-restart after reload. These retain the failures caused by conflicting ownership or disconnected lifecycles. One attached process and one native result path are sufficient.

**Consequences:** CI launch and monitoring truth become behaviorally testable through one boundary plan, one resolver script, and one tiny agent. The separate root-rule trigger is removed, so a Git command cannot create a duplicate launch. Non-SDD repositories and default-mode sessions receive CI-only plans. A successful launch is durable before settled recovery runs, while failures remain retryable; review acknowledgement is unchanged. Reload may abort a monitor without a result; a later eligible boundary plan or explicit user request can start a fresh one. Review and CI never track, wait for, or restart each other, and CI never becomes a review lane. Claude CI behavior is unchanged.

**Related REQ:** [REQ-AGENT-068](../../sdd/spec/agents.md#req-agent-068-independent-pi-ci-monitoring), [REQ-AGENT-070](../../sdd/spec/agents.md#req-agent-070-claude-on-demand-ci-monitoring-policy), [REQ-AGENT-090](../../sdd/spec/agents.md#req-agent-090-ci-monitor-head-correction-is-authoritative-and-fail-closed).

---

### AD100: Pin the upstream rpiv-todo session-isolation fix

**Category:** Agents

**Status:** Retired (2026-07-31); previously Accepted (2026-07-13)

**Context:** `@juicesharp/rpiv-todo` 1.20.0 stores every Pi session's tasks in one module-level cell. Foreground snapshots remained in transcript ancestry, but child/subagent `session_start`, `session_compact`, and `session_tree` replayed into that shared cell and replaced the foreground list with the child's state. Live history showed valid lists of one, five, and four tasks followed by `No tasks`; a background CI-log agent reproduced the reset during this fix. Upstream main already partitions state by session ID and gates the render pointer to the foreground session, but no npm release contains that correction.

**Decision:** Keep rpiv-todo's session-scoped transcript semantics rather than replace it with a global disk-backed task product. While npm remains at 1.20.0, Codeflare applies a minimal source override after install: task state is keyed by Pi session ID, lifecycle replay mutates only that session's slot, child shutdown evicts only its slot, and context-free rendering reads the foreground slot. The installer fails closed on any package version other than 1.20.0 so a future upstream release must be reviewed instead of silently overwritten.

**Alternatives considered:** `pi-tasklists` has the same session-replay shape and does not solve child isolation. `armory-todo` persists one global cross-session list, changing the desired session-local semantics. A Codeflare-global task database would add ownership, migration, and recovery machinery for a defect upstream has already fixed.

**Consequences:** Reload and branch replay keep their existing task semantics, while subagent lifecycle events cannot erase foreground tasks. The image prewarm and generated Pi npm seed carry the same patch payload. The temporary override adds four pinned source files and must be removed when a reviewed upstream release ships the fix.

**Retirement (2026-07-31):** `@juicesharp/rpiv-todo` 2.0.0 ships the equivalent session-keyed store upstream — `state/store.ts` partitions task state by Pi session ID and binds context-free rendering to the foreground slot, reviewed against the override payload before adoption; tool and command names are unchanged. The pin moved to 2.0.0 and the override machinery (payload directory, postinstall version guard, installer test, manifest entries) is removed. [REQ-AGENT-081](../../sdd/spec/agents.md#req-agent-081-rpiv-todo-session-isolation) now pins the reviewed upstream release and guards that no source override returns unreviewed.

**Related REQ:** [REQ-AGENT-081](../../sdd/spec/agents.md#req-agent-081-rpiv-todo-session-isolation), [Pi preseed](../lanes/preseed.md#agent-preseed-system).

---

### AD101: context-mode is foreground-owned in Pi; in-process subagents use native transports

**Category:** Agents, Architecture

**Status:** Accepted (2026-07-14)

**Context:** `@gotgenes/pi-subagents` creates child `AgentSession`s inside the foreground Pi process and deliberately loads the parent's extension set. context-mode 1.0.169 assumes one Pi extension owner per process: each registration has a local start latch, but its bridge handle/readiness and session identity are module-global. Concurrent child registrations overwrite the foreground bridge handle. Child bridges eventually idle-reap, but the displaced foreground bridge has `CONTEXT_MODE_BRIDGE_IDLE_MS=0`; later root reload cleanup cannot reach it. A live long-running session accumulated 17 idle-disabled `server.bundle.mjs` children (~0.78 GiB PSS). The current npm release is already 1.0.169, and modifying either installed upstream package would create an unowned fork.

**Decision:** Keep context-mode installed and keep its skills visible, but filter its Pi extension out of the shared package resource set (`extensions: []`). The managed `context-mode-runtime.ts` extension owns a process-global claim: the first/root Pi resource load imports and initializes the installed context-mode adapter; subsequent in-process subagent loads observe the claim and return without initializing it. The root releases the claim on `session_shutdown` after context-mode registers its own cleanup, so `/reload` and `/ctx off|on` can detach and reattach cleanly. `/ctx off` is represented by filtering both extensions and skills; `/ctx on` restores skills while extension loading remains owner-guarded. Pi reviewers declare only `bash` and consume the same exact review packet through Bash/Node.

**Alternatives considered:** Patch context-mode's module globals or pi-subagents' disposal lifecycle — rejected because Codeflare must not carry source fixes for upstream packages. Globally disable context-mode — rejected because the foreground session benefits from its tools. Let every child spawn a bridge and rely on the idle timeout — rejected because it leaves transient process growth and does not recover displaced idle-disabled foreground handles. Run reviewers in separate Pi processes — rejected because visible session-scoped `@gotgenes/pi-subagents` are the accepted review execution model.

**Consequences:** One Pi process owns at most one active context-mode bridge. In-process reviewers, memory capture, CI monitors, and other children use their documented native/Bash fallbacks; exact review scope and evidence are unchanged. The wrapper imports the registry-installed adapter rather than copying or modifying it, so npm upgrades remain upstream-owned. A full Pi process restart is required once to reap helpers leaked by sessions created before this decision.

**Related REQ:** [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults), [REQ-AGENT-085](../../sdd/spec/agents.md#req-agent-085-pi-reviewer-direct-evidence-transport), [REQ-AGENT-089](../../sdd/spec/agents.md#req-agent-089-pi-context-mode-foreground-ownership), [AD98](#ad98-pi-pr-review-uses-visible-session-scoped-agents), [Pi preseed](../lanes/preseed.md#agent-preseed-system).

---

### AD102: Pi extraction delivery is root-owned, visible, and transactional

**Category:** Agents, Architecture

**Status:** Accepted (2026-07-14)

**Context:** Pi memory and Vault extraction privately invoked the subagents service, hid launches from the root transcript, and treated mtimes/sentinels as delivery truth. Memory agents advanced counters before required graph publication, while Vault detection advanced the committed manifest before extraction; shared chunk paths and separate merge/publication locks allowed late or interleaved work to consume the wrong state. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault -->

**Decision:** The root Pi session emits public background requests and reconstructs launch, running, failure, success, reminder, and GIVEUP state from durable session JSONL. Every launch serializes identical bounded items into model-facing content and durable metadata. One tiny active request-ID pointer enables reload discovery, while one request-specific immutable snapshot prevents a late call from reading replacement work.

Memory snapshots use the shared home-backed cache so child Bash sees them; active legacy temp snapshots migrate before retry, as detailed in [Pi Memory and Vault Extraction Data Flow](../lanes/architecture.md#pi-memory-and-vault-extraction-data-flow). Memory counters and the committed Vault manifest advance only after exact native success plus request-specific post-commit artifacts.

Vault promotion validates staged bytes, prelaunch edits coalesce, and during-run edits become one follow-up request. Request-specific chunks and one lock spanning cumulative merge plus global publication prevent cross-request graph corruption. [AD103](#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs) bounds the workers without changing this delivery ownership.

**Alternatives considered:** Keep private service spawning and add logs; let agents delete vars and advance high-water state; add receipts, leases, a durable queue, scheduler, recovery service, or new endpoint; or serialize all extraction through one mega-agent. These either preserve invisible ownership/races or add machinery beyond the two independent extraction domains.

**Consequences:** Extraction launches and bounded retries are visible in the root transcript and survive reload without a separate service. Failed, timed-out, corrupt, late, or superseded work cannot consume newer prompts/Vault edits. Orphan request snapshots are harmless and excluded from extraction; root cleanup is idempotent after a rename-before-cleanup crash. Memory and Vault remain separate agents and share only the existing graph commit boundary.

**Related REQ:** [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-15-user-messages), [REQ-MEM-014](../../sdd/spec/memory.md#req-mem-014-pi-capture-contract-transcript-prefilter-and-model-fidelity-lever), [REQ-MEM-015](../../sdd/spec/memory.md#req-mem-015-pi-extraction-transcript-visibility-and-child-session-guard), [REQ-VAULT-026](../../sdd/spec/vault.md#req-vault-026-vault-extract-change-detection-survives-container-restart-content-hash-manifest), [REQ-VAULT-027](../../sdd/spec/vault.md#req-vault-027-pi-vault-extraction-delivery-is-visible-and-transactional), [REQ-VAULT-028](../../sdd/spec/vault.md#req-vault-028-vault-edits-remain-isolated-after-extraction-starts).

---

### AD103: Pi extraction agents use bounded medium reasoning and one-pass inputs

**Category:** Agents, Memory, Performance

**Status:** Accepted (2026-07-14)

**Context:** The first post-reload transactional Vault smoke contained one frozen 51 KB markdown file. The Pi `vault-extract` worker inherited the foreground reasoning level and broad read/search/context tools. It reread policy and input repeatedly, reaching 84.2k tokens, 12 tool calls, and 336 seconds without committing a chunk. The prior legacy Vault task took 762.9 seconds and 130.6k tokens.

Pi session capture also replayed up to 200 historical turns at 8000 characters and imposed Claude's multi-pass scratchpad after root prefiltering. The first bounded live capture produced a strong note in two tool calls, but model-authored graph JSON used noncanonical concept IDs, duplicated edges, and labeled the document from its filename rather than H1.

**Decision:** Pi's `memory-capture` and `vault-extract` workers are finite extraction jobs, not open-ended research agents. Generated frontmatter and every public request use provider-neutral medium reasoning; requests stop after four agent turns; generated workers expose only Bash.
<!-- @impl: scripts/agent-seed-core.mjs::adaptAgentFrontmatter -->
<!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::buildPublicExtractionRequest -->

Their embedded contract forbids discovery and defines a two-call normal path. Memory capture reads one self-contained snapshot whose `transcript` is the sole conversation input; Vault extraction reads only its snapshot and frozen files. Each then performs one write and required graph commit. Memory capture retains uncaptured text turns up to a fixed character budget, spent on user prompts before assistant turns and with each turn individually capped, and writes the note directly. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::MEMORY_CAPTURE_MAX_TOTAL_CHARS --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::MEMORY_CAPTURE_MAX_TURN_CHARS -->

A deterministic helper derives the memory graph from the note H1, stable Vault-relative document ID, canonical concept IDs, and unique edges. The shared cumulative merge preserves distinct serialized edge evidence while collapsing exact duplicates.
<!-- @impl: preseed/agents/pi/scripts/build-memory-graph.py::build_graph -->
<!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::merge_node_link_evidence -->

Vault extraction builds a compact semantic graph rather than an exhaustive inline-token inventory. Noncritical visualization receives 15 seconds and cannot hold task success open. <!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md::at most 15 seconds --> <!-- @impl: preseed/agents/pi/prompts/memory-agent-prompt.md::at most 15 seconds -->

Required graph publication remains unchanged. Each worker writes its graph to `<CHUNK>.work`; only after merge plus `graphify global add` succeeds does it atomically expose the canonical request chunk. Memory likewise publishes the capture note only after graph success. The root requires those post-commit artifacts before advancing the memory counter or Vault manifest and then removes the chunk. This reuses the already-required request chunk rather than adding a receipt, lease, queue, or service.

**Consequences:** Typical one-file/15-prompt work has a bounded number of model/tool turns and cannot inherit foreground `high`/`xhigh` reasoning. Identifier fidelity remains model-selectable through `CODEFLARE_MEMORY_MODEL`; reasoning effort and model identity remain separate controls. Claude keeps AD58's sonnet/chunked-scratchpad implementation unchanged. A failed merge, cooperative stop, or native completion without the post-commit artifact leaves root high-water state unchanged and enters the existing reminder path. Pi may report a successfully completed final bounded turn as `Wrapped up (turn limit)`; that terminal status qualifies only when the job's post-commit artifacts exist.

**Alternatives considered:** Keep broad tools and rely on stronger prose; retain 200-turn replay and merely lower reasoning; move extraction into a new service/queue; or add a separate success receipt. Prompt-only restraint did not stop the live worker, lowering reasoning alone would leave repeated input cost, a service/queue is disproportionate, and the canonical request chunk already provides a post-commit qualification artifact.

**Related REQ:** [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-15-user-messages), [REQ-MEM-014](../../sdd/spec/memory.md#req-mem-014-pi-capture-contract-transcript-prefilter-and-model-fidelity-lever), [REQ-MEM-016](../../sdd/spec/memory.md#req-mem-016-pi-extraction-requests-have-a-bounded-execution-profile), [REQ-MEM-018](../../sdd/spec/memory.md#req-mem-018-pi-extraction-agent-definitions-have-a-bounded-profile), [REQ-MEM-017](../../sdd/spec/memory.md#req-mem-017-session-memory-graph-identity-is-deterministic), [REQ-VAULT-027](../../sdd/spec/vault.md#req-vault-027-pi-vault-extraction-delivery-is-visible-and-transactional), [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad), [AD60](#ad60-pi-memory-capture-reuses-the-ad58-contract-and-transcript-prefilter), [AD102](#ad102-pi-extraction-delivery-is-root-owned-visible-and-transactional).

---

### AD104: Terminal viewport ownership is mode-based; xterm owns manual scrollback trimming

**Category:** Architecture, Mobile

**Status:** Superseded by [AD105](#ad105-streamed-output-defers-while-the-user-reads-scrollback-keyboard-open-swipes-are-always-terminal-input) (2026-07-16). The per-mode ownership model survives, but its two operative clauses failed in the field: letting xterm trim a full buffer under a reader pinned the reader to the top within seconds of agent output, and the keyboard-open fullscreen wheel exception broke the typing-mode scroll-lock.

**Context:** Under sustained output with a full scrollback buffer, xterm legitimately moves a manually selected viewport toward zero as old lines are discarded. Codeflare's write callback restored a saved distance at the zero boundary while a separate scroll-event path interpreted the same transition as a browser reset. Each programmatic correction emitted more scroll events, so competing paths repeatedly snapped between the oldest content and the live prompt. The bug intensified after the prior programmatic-scroll suppression handoff was removed. The next xterm beta changes only WebGL atlas invalidation and does not alter this event ordering.

**Decision:** Terminal scrolling has one owner per mode. A synchronous scroll-event guard owns `FOLLOW_OUTPUT` and yields to correlated user intent. Registered intent enters `READ_SCROLLBACK`; ownership persists until the viewport returns to the live bottom. Xterm owns every output-driven trim, including a legitimate zero offset after viewed lines age out.

`MOBILE_INPUT_LOCKED` is the explicit exception: the keyboard lifecycle performs fit plus bottom anchoring, generic correction stays inactive, and vertical swipes remain terminal input or fullscreen application wheel gestures. The write buffer performs no scroll correction.
<!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection -->
<!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal -->
<!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer -->
<!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures -->

**Consequences:** Sustained output cannot create a write/onScroll/programmatic-scroll feedback loop. A user reading history is never pulled toward the prompt, although content that has actually aged out cannot be preserved and correctly leaves the viewport at the oldest available line. Returning to bottom deterministically restores following. Mobile keyboard-open behavior remains intentionally bottom-locked instead of inheriting desktop manual-scroll ownership.

**Alternatives considered:** Upgrade xterm alone; retain write-side zero-clamp recovery; keep a distance-based browser-reset heuristic; or use a short grace timer as ownership. The available xterm update has no relevant scroll change, both correction heuristics misclassify valid full-buffer transitions, and a timer cannot represent the persistent user state.

**Related REQ:** [REQ-TERM-014](../../sdd/spec/terminal.md#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming), [REQ-MOB-004](../../sdd/spec/mobile.md#req-mob-004-scroll-drop-detection-during-burst-output), [REQ-MOB-005](../../sdd/spec/mobile.md#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll), [REQ-MOB-012](../../sdd/spec/mobile.md#req-mob-012-scroll-anchoring-during-keyboard-transitions), [REQ-MOB-019](../../sdd/spec/mobile.md#req-mob-019-keyboard-mode-swipe-semantics), [Mobile scroll stability](../lanes/mobile.md#scroll-stability).

---

### AD105: Streamed output defers while the user reads scrollback; keyboard-open swipes are always terminal input

**Category:** Architecture, Mobile

**Status:** Accepted (2026-07-16)

**Context:** [AD104](#ad104-terminal-viewport-ownership-is-mode-based-xterm-owns-manual-scrollback-trimming) accepted that a full 1000-line scrollback trims under a reader, "correctly" leaving them at the oldest available line. In practice agent bursts fill the buffer within seconds, so any scrolled-up reader slid to `viewportY = 0` and watched their content get destroyed — one form of the reported "terminal snaps to the top while the agent is outputting".

No viewport correction can fix content deletion.

Field testing with slow output exposed a second, instant form of the symptom: xterm 6.1 routes every public `scrollLines()` through the viewport's DOM scroll state, applying deltas relative to its current `scrollTop` (`CoreBrowserTerminal`: "All scrollLines methods need to go via the viewport").

That DOM state can silently diverge from the buffer — `Viewport._sync()` clamps `scrollTop` during `setScrollDimensions()` with its scroll handler suppressed (a refit passing through zero height), and no repair runs while `ydisp` matches the viewport's cached `_latestYDisp` — after which xterm resolves the divergence on the next relative tick as one giant `scrollLines()` straight to the top of scrollback. Every prior heuristic missed it because the yank rides on the user's own gesture event, which intent-based guards exempt.

Separately, AD104 kept the keyboard-open fullscreen wheel exception, so with the keyboard open a vertical swipe over Claude Code scrolled the application instead of sending arrow keys, breaking the typing-mode gesture contract; and touch drags only marked scroll intent at `pointerdown`, so a drag's first scroll event after the 150ms grace was misread as a displacement and snapped to the bottom mid-gesture.

**Decision:** Keep AD104's per-mode ownership (`FOLLOW_OUTPUT` / `READ_SCROLLBACK` / `MOBILE_INPUT_LOCKED`) and change four behaviors. (1) While manual ownership is active in the normal buffer, `flushWriteBuffer()` defers streamed output instead of writing it — the buffer freezes under the reader, and returning to the live bottom (or exceeding a 2,000,000-character held-output cap) releases everything in one write; alternate-buffer output never defers. (2) User-driven scrollback navigation is buffer-authoritative: touch scrolling and floating page controls call the internal `BufferService.scrollLines()` with buffer-derived deltas instead of the public viewport-relative API, each resulting buffer scroll event makes `Viewport._sync()` re-command the DOM scroll state absolutely — divergence is repaired every tick instead of amplified into an edge jump.

(3) Vertical swipes with the touch keyboard open are always terminal input (arrow keys); fullscreen wheel routing applies only while the keyboard is closed. (4) `touchmove` refreshes the scroll-intent window so an in-progress drag is always correlated with its own scroll events.
<!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer -->
<!-- @impl: web-ui/src/lib/xterm-internals.ts::scrollBufferLines -->
<!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures -->
<!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection -->

**Consequences:** A reader's viewport is perfectly stable during agent output — no trims occur beneath them — and scrolling back down shows the held output at once, at the cost of the display lagging live output during a read (bounded by the cap; a cap-exceeding flush may still trim beneath a very long read). A desynced DOM scroll state can move the viewport by at most one gesture delta before the next buffer scroll event resnaps it to buffer truth, eliminating the instant yank-to-top.

Keyboard-open gestures are deterministic again: arrows while typing, wheel/scrollback only with the keyboard closed. Mid-drag bottom snaps are gone. Held output is dropped with the write buffer on disconnect, where the server-side restore replay already owns repainting. Buffer-authoritative scrolling depends on the pinned xterm build exposing `_core._bufferService` (already relied on by the mobile debug overlay); the helper falls back to the public API if internals disappear. Direct buffer scrolls bypass xterm's `onRequestScrollLines`-to-`refresh(0, rows-1)` repaint pairing, so the helper issues that repaint itself — omitting it leaves the scrollbar moving over a frozen canvas.

**Alternatives considered:** Enlarge scrollback (delays, does not remove, the top-pin and costs mobile memory); restore distance-from-bottom after trims (AD104 already showed it yanks the reader through moving content); pause the PTY via flow control (server-side complexity, risks blocking the agent); keep keyboard-open wheel routing behind a setting (two gesture contracts to document and test for one mode); patch the DOM desync via a distance-jump heuristic in the scroll hook (the old Strategy 2 — structurally blind to yanks that ride on user-intent windows, which is exactly how this one fires).

**Related REQ:** [REQ-TERM-014](../../sdd/spec/terminal.md#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming), [REQ-MOB-004](../../sdd/spec/mobile.md#req-mob-004-scroll-drop-detection-during-burst-output), [REQ-MOB-005](../../sdd/spec/mobile.md#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll), [REQ-MOB-012](../../sdd/spec/mobile.md#req-mob-012-scroll-anchoring-during-keyboard-transitions), [REQ-MOB-019](../../sdd/spec/mobile.md#req-mob-019-keyboard-mode-swipe-semantics), [REQ-MOB-017](../../sdd/spec/mobile.md#req-mob-017-fullscreen-application-touch-scrolling), [Mobile scroll stability](../lanes/mobile.md#scroll-stability).

---

### AD106: SDD enforcement policy is one canonical cross-agent contract with per-AC manual verification

**Category:** Process, Agents

**Status:** Accepted (2026-07-17)

**Context:** The seven SDD enforcement skills (`spec-enforce`, `spec-enforce-ac`, `spec-enforce-truth`, `doc-enforce`, `doc-enforce-lanes`, `doc-enforce-shape`, `doc-enforce-truth`) existed twice: full versions in the Claude preseed and hand-maintained condensed rewrites in the Pi preseed, each declaring itself authoritative. The copies drifted within weeks of the split — different element budgets (list items 40 vs ~60 words), different severities (`prose-unverifiable` HIGH vs MEDIUM), Pi missing the mandated index-integrity command, Claude missing Pi's one-`@test`-per-AC rule and the deterministic round-limit override — so the same repository received different findings depending on which agent reviewed it.

Separately, manual verification was REQ-level: `Verification: Manual check` exempted a whole REQ (157 of 341) from every anchor requirement even when most of its ACs carried resolving anchors, sustained by 161 boilerplate Notes pointers into four generated checklist sections whose rows were almost all "verify every acceptance criterion". The `.doc-coverage.md` lane-scope-broad escalation had already concluded the clean resolution was a whole-structure decision requiring explicit user direction.

**Decision:** The Claude-tree skill files are the single canonical, agent-neutral enforcement contract; Pi receives them through the existing seed-generator transform (tool-name remap, path rewrites, appended compatibility note), and the seven Pi-native overrides plus their manifest entries are deleted. Reviewer agent definitions and Pi's `review`/`review-scope` dispatch layer are unchanged ([AD61](#ad61-pi-review-ships-as-a-dedicated-native-skill) still governs the Pi-native `review` skill; this decision covers only the enforcement-policy layer). Where the copies conflicted, the stricter side won: 40-word list items, `prose-unverifiable` HIGH, mandated verbatim integrity commands. Pi-only rules were ported into the canon: `spec-test-anchor-multiple` (HIGH — the greedy title capture cannot parse two `@test` anchors on one line) and the FULLY AUTONOMOUS round-limit override backed by the shared `round-limit.mjs` gate.

Manual verification became per-AC: an AC that cannot be automatically verified carries inline `<!-- @manual -->` (bare) or `<!-- @manual: <procedure> -->` (with dedicated guidance) instead of anchors; the `Verification:` field derives categorically from the markers (`Manual check` iff every AC is `@manual`; drift is MEDIUM `verification-field-marker-drift`); the four checklist sections, their TOC entries, and all pointer sites were deleted, with the eleven bespoke procedures relocated verbatim into their owning REQs' marker payloads ([REQ-AGENT-084](../../sdd/spec/agents.md#req-agent-084-reviewer-policy-contract), [REQ-AGENT-021](../../sdd/spec/agents.md#req-agent-021-pro-mode-sdd-workflow-preseed-and-tool-surface-portability)).
<!-- @impl: scripts/agent-seed-core.mjs::adaptPiSkillContent -->
<!-- @impl: preseed/agents/claude/skills/spec-enforce/SKILL.md::Explicit fully-autonomous override -->
<!-- @impl: preseed/agents/claude/skills/spec-driven-development/SKILL.md::Manual-verification convention (@manual, per-AC) -->

**Consequences:** Both agents now emit identical findings, severities, and category vocabulary for the same repository state, and parity can no longer rot silently because there is nothing to keep in parity. `grep -rn '@manual' sdd/` is the complete, always-current manual-verification inventory — every fully-anchored AC the REQ-level exemption previously blanket-skipped re-entered CQ-SOURCE/CQ-TEST enforcement, and future coverage work retrofits anchors AC-by-AC and deletes markers, shrinking the manual set monotonically. Pi reviewer prompts embed the full contract instead of the condensed rewrites, an accepted token-cost increase; the transform's compatibility note now appends only to SKILL.md files, which also fixed latent corruption of transformed executable aux files.

---

### AD107: context-mode is opt-in in Pi pending upstream memory safety

**Category:** Agents, Architecture, Reliability

**Status:** Superseded by [AD138](#ad138-context-mode-is-on-by-default-in-pi)

**Context:** [AD101](#ad101-context-mode-is-foreground-owned-in-pi-in-process-subagents-use-native-transports) eliminated competing context-mode owners, but the upstream Pi adapter still keeps foreground lifecycle state in the long-lived Pi process and disables its bridge idle reaper. Long tool-heavy sessions can therefore exhaust the constrained container before Pi reaches a compaction boundary. The latest reviewed context-mode release remains 1.0.169, and Codeflare will not patch or fork either package's lifecycle or ownership implementation; the existing image-build transforms remain limited to the ESM compatibility shim and update-probe suppression. <!-- @impl: preseed/agents/pi/extensions/context-mode-runtime.ts::attachConfiguredContextMode --> <!-- @impl: preseed/agents/pi/extensions/context-mode-runtime.ts::CONTEXT_MODE_PACKAGE = "npm:context-mode@1.0.169" -->

**Decision:** Keep the pinned context-mode package installed, but write its disabled marker (`extensions: []`, `skills: []`) on every container start. `/ctx on` remains an explicit per-container opt-in and continues to use AD101's single foreground owner; `/ctx off` removes the tools again. A later container start restores the disabled default. Reconsider default enablement only after a reviewed upstream release provides a memory-safe Pi lifecycle. <!-- @impl: entrypoint.sh::warm_pi_npm_dependencies --> <!-- @impl: preseed/agents/pi/extensions/ctx-command.ts::handleContextModeCommand -->

**Alternatives considered:** Leave context-mode enabled and accept recurring OOM failures; patch third-party lifecycle code; or route only its MCP tools through the stock generic adapter. The first is not crash-safe, the second creates an unowned fork, and the third removes context-mode's steering/session behavior without providing a hard bound during continuous use.

**Consequences:** Fresh Pi sessions expose no `ctx_*` tools or context-mode steering and use the already-required native fallbacks. The five unrelated Pi tool extensions remain enabled. Users may opt in knowingly for one container lifetime, but Codeflare does not present that state as safe or persist it across container restart.

**Related REQ:** [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults), [REQ-AGENT-089](../../sdd/spec/agents.md#req-agent-089-pi-context-mode-foreground-ownership), [AD101](#ad101-context-mode-is-foreground-owned-in-pi-in-process-subagents-use-native-transports), [Pi preseed](../lanes/preseed.md#agent-preseed-system).

---

### AD108: Per-AC test evidence permits multiple resolving anchors

**Category:** Process, Agents, Testing

**Status:** Accepted (2026-07-18)

**Context:** AD106 adopted a one-`@test`-anchor limit because the canonical greedy title regex could not separate adjacent HTML comments. That limit governs anchor pointers, not actual test cardinality: one pointer may name an outer suite containing many cases, while one AC may legitimately require blocks in different files. Source traceability already permits multiple `@impl` anchors. <!-- @impl: preseed/agents/claude/skills/spec-enforce-truth/references/parse-test-anchors.mjs::parseTestAnchors -->

**Decision:** Require at least one resolving `@test` anchor on every non-manual AC, permit multiple anchors, and validate every declared file/block independently for resolution and behavioral quality. Replace the greedy single capture with the shared global comment-bounded parser; remove `spec-test-anchor-multiple`; let `/sdd clean` backfill multiple independently verified candidates without treating existing anchors as an exhaustive inventory. The Claude preseed remains canonical, transformed skills inherit the policy, and the dedicated Pi reviewer states the same rule directly. <!-- @impl: preseed/agents/claude/skills/spec-enforce-truth/references/parse-test-anchors.mjs::parseTestAnchors --> <!-- @impl: scripts/agent-seed-core.mjs::compileAgentSeed -->

**Alternatives considered:** Retain one pointer and force an outer suite; split a coherent AC to mirror test layout; or permit multiple comments without changing the parser. These respectively weaken precision, couple requirements to test organization, or preserve malformed extraction.

**Consequences:** Existing Codeflare specs produce no new cardinality findings because every non-manual AC already has one anchor and none has multiple anchors. Future ACs may cite distributed evidence without artificial splitting; every extra anchor also creates another truth claim that can emit `spec-test-anchor-orphaned` or a test-quality finding.

**Related REQ:** [REQ-AGENT-094](../../sdd/spec/agents.md#req-agent-094-per-ac-test-evidence-supports-multiple-anchors), [AD106](#ad106-sdd-enforcement-policy-is-one-canonical-cross-agent-contract-with-per-ac-manual-verification), [Test discipline](../lanes/preseed.md#agent-preseed-system).

---

### AD109: context-mode MCP registration is universal and entrypoint-owned

**Category:** Agents, Architecture

**Status:** Accepted (2026-07-18)

**Context:** AD49 originally assigned Claude MCP registration to either plugin metadata or entrypoint according to tier. The shipped plugin manifest is now intentionally bare, while the container entrypoint writes the `context-mode` MCP registration for every Claude user. The image already installs and patches the package before any session starts.

**Decision:** Keep one Claude registration owner: entrypoint always writes the MCP server configuration, independent of tier. Custom-tier Advanced delivery adds the context-mode plugin hooks only; it does not register a second MCP server. Pi uses its separate image-prewarmed package and enables it through the managed single foreground owner under [AD138](#ad138-context-mode-is-on-by-default-in-pi).

**Consequences:** Claude users have the same manual `ctx_*` capability in every tier, Custom-tier users alone receive automatic routing hooks, first invocation performs no package download, and plugin metadata cannot create duplicate MCP registrations.

**Related REQ:** [REQ-AGENT-005](../../sdd/spec/agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers), [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults), [AD49](#ad49-context-mode-delivered-as-preseed-plugin-not-runtime-install), [Pi preseed](../lanes/preseed.md#third-party-plugin-context-mode).

---

### AD110: Terminal scrolling is buffer-authoritative on every route; held output ring-drops

**Category:** Architecture

**Status:** Accepted (2026-07-19)

**Context:** [AD105](#ad105-streamed-output-defers-while-the-user-reads-scrollback-keyboard-open-swipes-are-always-terminal-input) rerouted touch gestures and floating page controls to the internal `BufferService`, but desktop kept three paths on xterm 6.1's DOM-relative machinery: the mouse wheel (viewport-internal), `scrollOnUserInput` keystroke anchoring (`scrollToLine` clamped against possibly-stale scroll dimensions), and every app-initiated `scrollToBottom()` (relative resolve — `scrollLines(ybase - ydisp)`, a no-op at the bottom that can never repair a diverged DOM state).

Source verification of the pinned build (`6.1.0-beta.288`; unchanged through `beta.290`) confirmed the divergence class: `Viewport._sync()` clamps `scrollTop` with its handler suppressed, resize syncs run against the cached `_latestYDisp` and never re-command position, and the first relative tick afterwards resolves the divergence as one jump to the top of scrollback (upstream [xterm.js#5620](https://github.com/xtermjs/xterm.js/issues/5620); the merged [#5770](https://github.com/xtermjs/xterm.js/pull/5770) sync-output deferral is already in the pinned build and insufficient).

Separately, AD105's hold released in ONE write and force-flushed past its cap — xterm pins a scrolled-up reader at `ydisp = 0` while a full buffer trims (`BufferService` keeps text stable by decrementing), so both the release flood and the cap breach dragged stationary readers to the top during agent output.

**Decision:** Extend buffer authority to every remaining scroll route and make the hold reader-proof:

- A capture-phase wheel interceptor converts deltas to lines and scrolls the `BufferService` directly (normal buffer only; alternate-buffer and zoom-modified wheel pass through).
- `scrollOnUserInput` is disabled; an `onData` listener re-anchors an owned normal-buffer viewport through the buffer service, covering hardware keys, the mobile compositor jail, swipe arrows, and voice.
- All app-initiated bottom anchors use `scrollBufferToBottom()`; refits that do not re-anchor call `resyncViewportScrollState()` to re-command the DOM scroll state absolutely.
- The hold releases in bounded whole-chunk slices (65,536 characters per flush tick), re-checking ownership between ticks, and past its 2,000,000-character cap drops the OLDEST held chunks at message boundaries instead of writing through the reader.
- Scrollback grows 1,000 → 5,000 lines.

**Consequences:** No input route can resolve a stale DOM scroll state into a buffer jump, and no write path can move a reader — the two mechanisms behind the remaining desktop "snap to top". A reader who out-waits the cap loses the oldest held output (it was destined for scrollback trimming regardless); an escape sequence split at a drop boundary may render transient artifacts until the application's next repaint. Keyboard-open mobile behavior is unchanged: the keyboard lifecycle still owns fit-plus-bottom-anchor, now through the buffer service. Wheel interception bypasses xterm's `smoothScrollDuration`/`scrollSensitivity` options; the app owns wheel feel in the normal buffer.
<!-- @impl: web-ui/src/lib/terminal-wheel.ts::attachWheelScrolling -->
<!-- @impl: web-ui/src/lib/xterm-internals.ts::scrollBufferToBottom -->
<!-- @impl: web-ui/src/lib/xterm-internals.ts::resyncViewportScrollState -->
<!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer -->

**Related REQ:** [REQ-TERM-014](../../sdd/spec/terminal.md#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming), [REQ-MOB-004](../../sdd/spec/mobile.md#req-mob-004-scroll-drop-detection-during-burst-output), [AD104](#ad104-terminal-viewport-ownership-is-mode-based-xterm-owns-manual-scrollback-trimming), [AD105](#ad105-streamed-output-defers-while-the-user-reads-scrollback-keyboard-open-swipes-are-always-terminal-input).

---

### AD111: Synchronized-output frames are delivered atomically at the write boundary

**Category:** Architecture, Reliability

**Status:** Accepted (2026-07-19)

**Context:** Pi renders through DEC 2026 synchronized frames (`ESC[?2026h` … `ESC[?2026l`) at up to ~62 fps; when differential rendering cannot reach a changed line it clears the screen AND scrollback (`CSI 2J`/`CSI H`/`CSI 3J`) and replays the entire transcript. Live capture measured such replays at 385–401 KB across ~100 WebSocket messages over 344–623 ms host-side. The pinned xterm (`6.1.0-beta.288`) defers rendering inside a sync block but arms a 1,000 ms safety timeout at the first buffered row (`RenderService.SYNCHRONIZED_OUTPUT_TIMEOUT_MS`); the host forwards raw PTY chunks and the frontend fed them to `terminal.write()` incrementally, so network arrival plus 33 ms batching consumed that budget.

On timeout xterm abandons atomicity and paints the partially rebuilt transcript, then walks through it as later chunks parse — the observed split-second scroll through the entire scrollback (browser-reproduced on the exact pinned build; coalesced delivery showed zero intermediate paints). Separately, `CSI 3J` resets `ydisp`/`ybase` but leaves `BufferService.isUserScrolling` stale (upstream [xterm.js#6046](https://github.com/xtermjs/xterm.js/issues/6046)), pinning the regrowing buffer at the top — and [AD110](#ad110-terminal-scrolling-is-buffer-authoritative-on-every-route-held-output-ring-drops)'s `scrollBufferToBottom()` returned early at zero delta, repairing neither that lock nor a diverged DOM position.

**Decision:** Preserve the frame boundary the application authored, at the single WebSocket-to-write boundary:

- A per-terminal frame assembler splits ingest into atomic units: ordinary bytes pass through under the existing 33 ms batching.
- Everything from a begin marker to the first end marker (set/reset mode semantics matching xterm; split markers carried across messages) is parked and emitted as ONE `terminal.write()` call.
- One synchronous parse cannot be interleaved by the timeout callback — the end marker clears the timer in the same task.
- Malformed streams fail open: a frame idle past 2,000 ms or grown past 4,000,000 characters is released as-is (pre-assembly behavior), never deferred indefinitely.
- The read-hold, held-output cap, and bounded release compose at unit granularity: a held frame releases in one write even past the 65,536-character slice budget; ring-drop discards whole units (a dropped full replay is superseded by the next one).
- A partially assembled frame is dropped at every WebSocket stream boundary; queued complete units are superseded by the serialize-based restore on reconnectable closes, or painted once when the close is final.
- The zero-delta bottom anchor now repairs stale state instead of no-opping: internal `scrollLines(0)` clears a stale user-scroll lock (no scroll event, no repaint — `ydisp` unchanged) and the viewport resync re-commands the DOM position absolutely.

**Consequences:** Refines AD110 — buffer authority governs every scroll route, and atomic frame delivery is the missing half its "definitive" scope did not cover: corrections no longer race mid-frame buffer states because those states are never observable between writes. Applications that never emit the markers see byte-identical passthrough (one `indexOf` per chunk); Claude Code and Codex gain the same atomicity. First paint of a frame moves after its full arrival — no added latency in practice, since xterm's sync deferral already withheld painting until the end marker. Atomicity depends on xterm parsing one write chunk synchronously, so no asynchronous parser handlers may ever be registered on the terminal.
<!-- @impl: web-ui/src/lib/terminal-frames.ts::createFrameAssembler -->
<!-- @impl: web-ui/src/stores/terminal-output.ts::scheduleWrite -->
<!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer -->
<!-- @impl: web-ui/src/stores/terminal.ts::handleWebSocketClose -->
<!-- @impl: web-ui/src/lib/xterm-internals.ts::scrollBufferToBottom -->

**Related REQ:** [REQ-TERM-021](../../sdd/spec/terminal.md#req-term-021-synchronized-output-frame-atomicity), [REQ-TERM-014](../../sdd/spec/terminal.md#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming), [AD110](#ad110-terminal-scrolling-is-buffer-authoritative-on-every-route-held-output-ring-drops).

---

### AD112: CI runs as parallel path-filtered lanes and deploys reuse content-addressed container images

**Category:** Architecture, Operations

**Status:** Accepted (2026-07-20); amended 2026-08-02 to keep container construction exclusively in deployment; amended 2026-08-05 to partition scheduled verification and verify retained-image provenance

**Context:** PR Checks ran as one serial job (~10 min: lint → knip → build → backend tests → host → frontend → landing → typecheck → audit) regardless of what changed, with the backend suite forced to `maxWorkers: 1` by the Workers-pool teardown crash and gated by a grep-on-prose guard duplicated in test.yml and deploy.yml. Deploy was a single 729-line job that re-ran the entire test suite it had already gated on via `workflow_run`, rebuilt and rescanned the multi-GB container image on every deploy even when no container input changed, and carried a 533-line Docker Hub near-copy (`deploy-dockerhub.yml`).

The scripted e2e suite was dispatch-only, fully serial, and fail-open — `describe.skipIf(!isSetup)` turned a failed setup probe into a green run with zero executed tests.

**Decision:**

- PR Checks split into parallel workload lanes gated by the [`changes` job](../../.github/workflows/test.yml): quality, typecheck, sharded backend/frontend tests, path-specific backend/frontend coverage, landing, host, and Browser IDE.
- [Dependency review](../../.github/workflows/test.yml) is an independent pull-request-only gate.
- A `summary` job keeps the required `test` status context. Path-filtered skips pass; failed or cancelled lanes fail.
- Ordinary test suites use `.github/actions/vitest-suite`; its teardown-crash guard requires `scripts/ci/check-vitest-report.mjs` to accept a parsed Vitest JSON report rather than grepping reporter prose.
- Path-specific coverage jobs use `.github/actions/coverage-suite`; its classifier requires the coverage table, rejects reported test or threshold failures, and bounds the backend-only crash exception.
- Non-zero ordinary-suite exits are accepted only with a parsed report showing >0 tests, 0 failures, and the exact crash fingerprint; coverage accepts its backend exception only after the required coverage evidence passes. Missing or corrupt evidence fails closed.
- Deploy stages into `prepare` → (`build-worker` ∥ `container`) → `deploy`, drops test re-runs after verification, uploads secrets through one `wrangler secret bulk` call, and prunes the registry through `scripts/ci/prune-registry.mjs`.
- Manual dispatch can reuse an explicit successful PR Checks run when its uploaded checked-out-tree receipt equals the deploy tree; otherwise checks run inline.
- The `/health` smoke check and the public `/health` route were both removed later; the deploy currently performs no post-deploy verification.
- Container build/smoke/scan/push moves exclusively to reusable `container-image.yml`; PR Checks never construct, load, run, publish, or authenticate a container image.
- Deployment alone imports and publishes the GHCR-backed BuildKit cache. Login failure disables cache use; export errors cannot fail the image build.
- Images are tagged `in-<hash>` over every Dockerfile COPY source plus an ISO-week salt; identical-input deploys reuse the already-scanned digest only after its GitHub provenance verifies against the reusable image workflow.
- A COPY-coverage gap or invalid retained-image provenance disables reuse. The first deploy under a new weekly identity rebuilds and rescans; no unconditional scheduled image build is implied.
- Scheduled full-matrix checks call `test.yml` through a separately named wrapper, so Deploy's `workflow_run` trigger matches post-merge `PR Checks` but not nightly verification.
- The scripted e2e suite is deleted rather than repaired; the k6 stress suites move to `stress/`.
- Deploy exclusively owns service-auth secret and KV service-user provisioning; Stress Test validates the deployed target without Cloudflare mutation credentials.
- `zizmor.yml` audits the workflows themselves (SARIF, informational).

**2026-08-02 amendment:** PR Checks target a sub-three-minute critical path by running every workload lane at maximum parallelism and never building a container image. Deployment is the sole owner of image build, packaged smoke, scan, SBOM, provenance, and push. The exact-tree PR receipt proves source verification only.

**Consequences:** PR wall-clock drops to the slowest source-validation lane, docs-only changes skip every path-gated workload lane, and PRs never pay the multi-gigabyte image cost. Nightly verification retains the same matrix without creating a daily skipped Deploy run. Deploys skip build and scan for unchanged container inputs only when the retained digest's signed provenance verifies, then bind that digest rather than its mutable tag; the original scan and SBOM are reused rather than regenerated. Missing provenance safely costs a fresh build. Same-environment deploys queue instead of cancelling partial mutation, and configured service-user seed failure leaves the deployment red.

The ordinary-suite guard cannot pass an empty run or depend on reporter prose; coverage requires its table and rejects reported failures or threshold misses. Accepted trade-offs are replicated test scaffolding across split test files (vi.mock hoisting is per module) and no scripted browser e2e; deployed-UI verification uses the agent-driven browser-e2e path.

---

### AD113: One owned Browser IDE extension uses Pi RPC and a Claude PTY

**Category:** Architecture, Security

**Status:** Superseded (2026-07-23) by [AD114](#ad114-native-pi-chat-and-the-official-claude-extension-own-editor-integration). This records the initial 2026-07-22 implementation.

**Context:** The Browser IDE needs a conversation separate from terminal tab 1 for the selected Pi or Claude agent. Reusing the terminal process would couple history and control. A Worker bridge or second container would add an unnecessary trust boundary. Anthropic's official VSIX adds a large proprietary artifact and vendor UI behavior that Codeflare does not need because the pinned Claude CLI was already in the image.

**Decision:** Build one Codeflare-owned OpenVSCode extension and install identical package bytes into fixed Pi and Claude inventories, with an empty inventory for unsupported agents. The Pi adapter starts a fixed no-session RPC child and binds each serialized approval manifest to its extension-host request by SHA-256 digest. The Claude adapter starts the fixed global CLI in a real `node-pty` and renders its native TUI with local xterm assets, preserving Claude's own interactive permission prompts. Both adapters share the container and approved configuration sources but use separate sidebar history. The classifier maps tab 1 to a closed non-executing enum and does not amend AD15. The extension is external to the upstream OpenVSCode artifact, preserving AD97.

The extension compiles its exact `node-pty` dependency for OpenVSCode's Node 22 extension-host ABI in a digest-pinned builder. Claude uses a temporary `CLAUDE_CONFIG_DIR` that projects approved credentials/configuration but excludes terminal transcripts and runtime state. Each OpenVSCode launch records its PID, process group, start time, and generation token. Pi and Claude descendants inherit that token, so restart cleanup finished before replacement.

**Alternatives rejected:** Anthropic's VSIX (proprietary artifact and unnecessary vendor surface); ACP (extra adapter with no first-release benefit); VS Code Terminal/Pseudoterminal APIs (cannot render in an Activity Bar sidebar); Python PTY bridge (extra process and custom framing); a second container or Worker process API (new network and lifecycle boundaries).

**Consequences:** Codeflare owned the first sidebar renderer, PTY/RPC transports, security boundary, and behavioral tests. The superseding decision removes its custom renderer, xterm, and native addon after deployed use showed that a chat surface without editor context was not useful enough.

---

### AD114: Native Pi Chat and the official Claude extension own editor integration

**Category:** Architecture, Security, Supply Chain, partially superseded

**Status:** Accepted 2026-07-23 and amended through the direct panel-routing decision on 2026-08-16. Partially superseded later on 2026-08-16 by [AD127](#ad127-native-inline-chat-uses-proposal-only-pi-turns-and-host-owned-text-edits): only editor Inline execution was replaced; the remaining native Pi, official Claude, provider, runtime, and settings decisions stay active. Implements [REQ-IDE-005](../../sdd/spec/browser-ide.md#req-ide-005-selected-native-ide-agent), [REQ-IDE-007](../../sdd/spec/browser-ide.md#req-ide-007-ide-guarded-approval), [REQ-IDE-008](../../sdd/spec/browser-ide.md#req-ide-008-ide-agent-process-lifecycle), [REQ-IDE-009](../../sdd/spec/browser-ide.md#req-ide-009-frictionless-workspace-open-for-every-ide-agent), and [REQ-IDE-019](../../sdd/spec/browser-ide.md#req-ide-019-codeflare-eligibility-in-editor-inline-chat); deployed integration run `30413127704` provides manual evidence for [REQ-IDE-006](../../sdd/spec/browser-ide.md#req-ide-006-ide-conversation-context-and-credential-isolation), whose active specification status remains authoritative.

**Context:** The owned webview from AD113 could chat with Pi or render Claude's PTY, but it could not see the active editor, selected text, open files, diagnostics, or native references. Users had to copy file contents into a UI presented as an IDE agent. OpenVSCode 1.109.5 has a native Chat participant API for Pi, while Anthropic publishes its official Claude Code extension for VS Code forks through Open VSX. The owner explicitly accepts both the extension's all-rights-reserved licensing ambiguity for server-image inclusion and its authenticated loopback IDE MCP transport. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate -->

**Decision:** Keep fixed tab-1 inventory selection, but give each supported agent its editor-native integration. The Pi inventory contains one Codeflare-owned extension that registers `codeflare.pi` as the default participant in panel and editor Inline Chat. The pinned host resolves a non-optional eligible model before invoking either location, so the extension publishes one account-free selectable compatibility model and enables the extension-qualified `chatParticipantAdditions`, `chatParticipantPrivate`, `chatProvider`, and `defaultChatParticipant` proposals only for that package and host. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: openvscode/agent-sidebar/package.json::enabledApiProposals -->

Two inert compatibility providers satisfy separate pinned-host boundaries. A hidden, non-selectable `copilot`-vendor model is panel-default only so the extension host's absent-request-model lookup can construct the participant request. A selectable panel/editor-default model under the distinct `codeflare` vendor stays outside Code OSS's Copilot entitlement and sign-in path and reports tool calling solely for the pinned editor filter. Both request no authorization and reject generation; the participant never reads `request.model` or sends a prompt through either. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::HOST_FALLBACK_MODEL --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::HOST_VISIBLE_MODEL --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate -->

The Pi settings disable the duplicate `~/.claude/agents` discovery path while retaining `~/.copilot/agents` for Code OSS and `~/.pi/agent/agents` for Pi itself. <!-- @impl: openvscode/claude/managed-settings.mjs::buildPiOpenVscodeSettings -->

The first panel request, or the panel continuation of an editor-originated request, lazily starts one IDE-owned `pi --mode rpc --no-session --no-themes` process. Strict FIFO serialization is mandatory because Pi stream events do not identify their prompt. Normally completed turns retain the process; active cancellation, protocol or process failure, unexpected exit, and deactivation boundedly reap it before replacement. Queued cancellation skips only that request. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::runNativePiChat -->

Panel requests and editor-originated turns continued into panel Chat intentionally share the process's in-memory conversation, separate from terminal Pi. Cold creation or replacement hydrates from the owning panel request's bounded visible Chat history. Warm turns send only the current request and editor context so visible history is not duplicated into Pi's transcript. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::buildNativePiPrompt --> <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-native-chat.ts::collectNativePiPromptInput -->

Pi remains unrestricted and may write files or run commands beyond an Inline Chat selection; those direct effects are not host text-edit parts and carry no transactional Keep/Undo guarantee. Code OSS 1.132's editor Inline Chat filters ordinary participant output and waits for host-owned edit transactions. Its `inlineChat2.continueInChat` action is termination-only, so invoking it during the active participant request is rejected as a no-op. The private request location instead submits the unchanged prompt to visible panel Chat through `workbench.action.chat.open` before Pi inference.

Replaying already-applied Pi effects as host edits, patching Code OSS, or leaving output on an invisible response stream are also rejected. It never asks for a VS Code authentication session. Sidebar Pi registers no guarded tool replacements, and extension confirmation requests auto-approve without UI.

The Claude inventory contains the exact official `Anthropic.claude-code` linux-x64 package pinned by `openvscode/agent-sidebar/official-claude.json`. The Docker build downloads that Open VSX artifact, verifies its pinned SHA-256 and publisher/name/version/platform/engine/entry point, extracts unchanged package files, deletes the VSIX archive, and stages the files root-owned and immutable. Codeflare does not patch or serve Anthropic's package. External ephemeral settings point its bundled CLI at the allowlisted temporary `CLAUDE_CONFIG_DIR`, unrestricted `bypassPermissions` mode, enabled dangerous permission skipping, no managed ask hook, disabled Anthropic login prompt, right-sidebar location, and disabled OpenVSCode AI features so the unrelated Copilot setup is absent.

Anthropic's documented IDE MCP remains loopback-only with a fresh token in that private config root. <!-- @impl: openvscode/agent-sidebar/src/package-extension.ts::stageSidebarExtension --> <!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::prepareOfficialClaudeIde --> <!-- @impl: openvscode/claude/managed-settings.mjs::buildOpenVscodeSettings -->

Before launch, every agent kind seeds OpenVSCode User settings that disable workspace trust and ignore extension recommendations, so the session workspace opens without either prompt. Pi receives those settings plus its single-personal-agent-source setting, the empty inventory receives the base settings alone, and Claude receives them alongside its isolated configuration. A settings-preparation failure fails closed and refuses the launch. <!-- @impl: openvscode/claude/managed-settings.mjs::buildBaseOpenVscodeSettings --> <!-- @impl: entrypoint.sh::_openvscode_prepare_agent -->

Disabling workspace trust removes VS Code's own gate on the untrusted repository input recorded in [AD97](#ad97-keep-openvscode-upstream-clean-and-accept-known-vulnerability-risk). This adds no protection the sandbox does not already assume, because the container is the security boundary and IDE agents already run unrestricted ([REQ-IDE-007](../../sdd/spec/browser-ide.md#req-ide-007-ide-guarded-approval), [REQ-IDE-009](../../sdd/spec/browser-ide.md#req-ide-009-frictionless-workspace-open-for-every-ide-agent)).

**2026-07-28 amendment:** AD119 changes only the host runtime. The original Decision's references to OpenVSCode 1.109.5 and OpenVSCode settings are historical; code-server 4.130.0 and its embedded Code OSS 1.130.0 now own the native Chat host and settings contracts. Code OSS remains at or above the owned Pi extension's API floor and is required to admit `chatParticipantAdditions`, `chatParticipantPrivate`, `chatProvider`, and `defaultChatParticipant`; CI must prove those APIs against the actual image. The exact official Claude package and loopback-only IDE MCP contract remain unchanged. Private source paths and shell symbol names containing `openvscode` remain temporarily as implementation identifiers rather than runtime claims.

**Alternatives rejected:** Patching OpenVSCode to admit a model-less participant (violates the upstream-clean boundary); retaining the custom Pi webview (no native editor context); retaining the Claude PTY as the primary IDE UI (same usability gap); injecting `GH_TOKEN` into Copilot or VS Code Authentication (unrelated identity, entitlement, and token boundary); downloading the 85 MiB Claude package on every session (latency and availability regression); patching Anthropic's package; adding a Codeflare Worker relay, public listener, second container, ACP adapter, or workspace crawler.

**Consequences:** Pi uses the main native Chat sidebar without a login or attached-file copying. Panel turns and editor-originated turns share one hidden IDE transcript for the lifetime of the healthy RPC process; editor submission opens the visible panel response because the pinned upstream Inline Chat cannot represent unrestricted direct effects truthfully. Users should expect a turn originating from either surface to inform later turns. Anthropic's package provides native selections, `@` references, diffs, plans, history, and diagnostics; integration deployment run `30413127704` passed authenticated Claude context pass@3 on three fresh sessions.

<!-- doc-allow-element: AD114 accepted decision paragraph is preserved verbatim -->
The custom webviews, xterm, node-pty, ABI-127 addon build, and owned Claude PTY code are removed. The image grows by the extracted official extension (about 285 MiB), and a code-server, embedded Code OSS, or Anthropic API change can break integration; exact package, manifest, proposal, complete-image, and laziness checks therefore fail closed. The owner accepts the proprietary-license and local authenticated-MCP boundaries. <!-- @test: openvscode/agent-sidebar/test/native-chat.test.ts (REQ-IDE-005 AC2 + REQ-IDE-006 AC1: native Pi receives bounded editor, reference, diagnostic, and chat context) --> <!-- @test: openvscode/agent-sidebar/test/packaging.test.ts (REQ-IDE-005 AC1: stages native Pi, official Claude, and empty unsupported inventories) --> <!-- @test: openvscode/claude/test/prepare-sidebar-config.test.mjs (REQ-IDE-005 AC2 + REQ-IDE-006 AC1: official Claude launch writes isolated OpenVSCode settings) -->


---

<a id="ad115-review-lanes-run-as-headless-claude--p-subprocesses"></a>
### AD115: Claude PR-boundary review lanes run as headless `claude -p` subprocesses

**Category:** Architecture, Cost

**Status:** Accepted (2026-07-26). Implements [REQ-AGENT-102](../../sdd/spec/agents.md#req-agent-102-claude-reviewer-headless-lane-transport).

**Context:** A review lane began work already holding context it had no way to refuse. Claude Code injects CLAUDE.md, every `~/.claude/rules/*.md`, MEMORY.md and the SessionStart blocks into every subagent, and exposes no frontmatter field that excludes any of them — measured at 20,513 prompt tokens against an agent whose own document is nearly empty, so the figure is the harness rather than the lane.

Reducing the reviewers to `tools: ["Bash"]` moved it by roughly 1,200 tokens, because tool schemas are already loaded on demand and were never where the cost sat. What a lane actually carried was a memory index of files it has no tool to open, a block instructing it to prefer retrieval tools it is explicitly denied, and rule files whose enforcement content it already embeds. Every turn re-sends the whole prompt, so that overhead multiplied by turn count rather than being paid once. This mirrors the Pi-side problem settled in [AD76](#ad76-durable-review-lanes-run-as-detached-headless-pi-processes) and superseded by [AD98](#ad98-pi-pr-review-uses-visible-session-scoped-agents).

**Decision:** Run each lane as a headless subprocess — `claude -p --setting-sources "" --strict-mcp-config --system-prompt <agent-doc> --tools Bash` — rather than an Agent subagent. The three controls that collapse the floor exist only on the command line, which is what forces a subprocess: `--setting-sources ""` takes the measured floor to 21,034, `--system-prompt` to 17,598, and `--tools Bash` to 1,533. Each lane's declared `model` and `effort` are read from its own frontmatter and passed through, so the transport change re-tiers nothing. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/run-review-lane.sh::SYSTEM_PROMPT -->

Declining inherited settings also declines hooks, so the container guards are passed back explicitly via `--settings` and invoked as `bash <script>`: the seeded hook scripts ship non-executable, and a bare command path fails silently, which reads as permission rather than as breakage.

A lane that owns no changed file in the range short-circuits before the model is invoked. Measured, an empty range otherwise took seven turns and 67,609 prompt tokens for the model to conclude there was nothing to review — the most expensive possible way to answer a question Git answers for free. Uncertainty falls through to a full review rather than skipping one.

The Stop-hook gate matched an Agent envelope, which a subprocess never emits. It now credits either transport, so migrating a lane can never narrow what qualifies as reviewed. Lanes are dispatched as background calls, and a background Bash call completes with the same notification shape a background subagent does, so one completion contract still covers both and is unchanged from before the transport existed.

What must never count as completion is the tool_result the harness returns the instant a background call is launched: it carries the same identifier but holds a background shell id and means "launched". Accepting it would credit all three lanes at launch and acknowledge a head whose review was still running — the gate inverted. Spawn detection is likewise structural rather than textual, because a substring match let one command quoting the runner path satisfy every lane at once; the runner must occupy command position, quoted or not.

`--lane <name>` is the gate's match token, and renaming it would disable enforcement silently. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::lane_spawn_lines --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::tool_use_id_completed -->

A launched lane can also end *badly*, and that is a third state the gate originally lacked. `completed` and `failed` are both terminal — the process is gone either way — but only `completed` may credit a review. Treating `failed` as indistinguishable from "still running" meant the gate waited on a dead process until a staleness bound expired, the head was never acknowledged, and the next push measured its range from the last *acknowledged* head rather than the last reviewed one. 

One lost lane therefore widened every subsequent review permanently: measured once as a ten-commit re-review where a single commit was due. A failed lane is now re-demanded immediately and named in the demand, because its report can be readable enough to look like a finished round. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::spawn_ended_unsuccessfully --> <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::lane_has_coverage_after_line -->

Acknowledgement itself was also making the wrong claim. Advancing the checkpoint on lane exit records that three processes ran, not that anything was read, so a round returning into a session that never triaged it moved the checkpoint past its own unacted findings. The gate now requires the triage verdict — recognised structurally, by the table header and divider anywhere in the assistant text of a message following the last lane's completion — and then issues the fix directive itself rather than trusting the session to remember. The Pi enforcement path already worked this way, so both runtimes key on one table shape. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::triage_published_after_line -->

A published verdict can also fail to reach the transcript at all: a message whose tool call this same gate rejects is never persisted by the harness, so a table sharing a message with a blocked tool call can be invisible to a later scan. An interim round-stamped checkpoint file compensated for that gap, but it surfaced in the UI as diff noise and was superseded by aligning the contract to the Pi runtime's: the verdict is a tool-free message that ends the turn — the one shape the harness always persists — verified finding-by-finding before publication, with the acknowledgement's fix directive driving the following turn. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::stacked_table_in_stream -->

The subprocess is also time-bounded, and the bound is validated rather than merely defaulted: `timeout 0` means *no* timeout, so an empty, zero, or non-numeric override resolves to the default instead of silently removing the bound, and expiry escalates past `SIGTERM` so a lane wedged in an auth prompt or a retry loop is actually reaped. Guard settings are built programmatically and verified non-empty before use for the same fail-closed reason: a missing dependency, a missing guard script, or a config path containing a space must stop the lane rather than yield a settings file whose hooks never fire. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/run-review-lane.sh::bounded_cap -->

**Related:** [AD76](#ad76-durable-review-lanes-run-as-detached-headless-pi-processes), [AD98](#ad98-pi-pr-review-uses-visible-session-scoped-agents), [REQ-AGENT-086](../../sdd/spec/agents.md#req-agent-086-claude-reviewer-direct-evidence-and-root-handoff).


**Consequences:** The original compact ADR did not record a separate consequences field.

---

### AD116: Review-lane Phase 0 is computed deterministically and handed to the lane

**Category:** Architecture, Cost

**Status:** Accepted (2026-07-26). Implements [REQ-AGENT-103](../../sdd/spec/agents.md#req-agent-103-deterministic-lane-triage).

**Context:** Every PR-boundary lane opened with a six-step Phase 0 — SDD bootstrap, layout resolution, config read, transition check, round counter, bulk-op audit. Each step was its own Bash call and therefore its own turn. Measured at ~3,945 tokens and 5–6 turns per lane before any reviewing began. Because a lane re-sends its whole prompt every turn, triage output is the most expensive evidence a lane can hold: arriving first, it is re-read on every turn that follows. Not one of the six steps requires a model — they are `test -f`, a config read, and two `git log` walks — and the diff-classification step was already answered by the lane classifier before the lane was spawned.

**Decision:** Resolve Phase 0 in `lib/lane-triage.mjs` before the subprocess starts and inline the result, with the already-built review packet, into the lane's opening prompt. The reviewer documents instruct the lane to treat that block as authoritative and never re-derive it. A triage-proven no-op (no SDD bootstrap, an active transition, a round limit) returns without invoking a model, extending the existing zero-token short-circuit. Lane ownership is still computed by the shell classifier and passed in rather than reimplemented, so there remains one source of truth for it.

**Consequences:** Measured on one range, all three lanes: 67 turns → 19, and 1,874,525 prompt tokens → 468,537. Finding quality did not drop — the doc lane returned more findings than before, because precise triage replaced evidence it previously had to derive. The cost is that triage now reproduces two enforcement gates (round limit, bulk-op audit) in a second place; both are pinned by behavioral tests, and every unresolvable condition resolves to running the review rather than skipping it, so a triage bug degrades to a redundant review rather than a silent enforcement hole.

**Supersedes:** none. Extends [AD115](#ad115-claude-pr-boundary-review-lanes-run-as-headless-claude--p-subprocesses).

---

### AD117: Review-lane cost is governed by turn count, so evidence gathering is structured in waves

**Category:** Architecture, Cost

**Status:** Accepted (2026-07-26). Implements [REQ-AGENT-105](../../sdd/spec/agents.md#req-agent-105-review-lane-turn-economy).

**Context:** Four measured review rounds refused to correlate with diff size — a two-commit range cost 1.30M prompt tokens while a nine-commit range cost 0.80M. Fitting all twelve lane-runs gives `prompt_tokens ~= T*(S+E) + 2.75k*T^2`, where `T` is turns, `S` the system prompt and `E` the inlined evidence. The fit is close: the spec lane at sixteen turns predicts 1,113k against 1,117k actual, the doc lane at eight predicts 362k against 401k. A lane re-sends its entire prompt every turn, so the accumulated conversation makes the second term quadratic and it dominates everything else past a handful of turns.

Every cost lever considered before this was linear in `T` and therefore worth 5-10%: trimming reviewer prose, splitting apply-only policy out of the enforcement skills, narrowing the packet. The one lever that is quadratic had not been touched.

**Decision:** Structure lane evidence gathering into waves rather than capping it. Wave one parses what the lane was handed, derives everything derivable, and reads any conditional sub-policy the manifest triggers. Wave two, entered only when a *named* candidate still lacks evidence, collects all of it in one call. Then the lane reports, stopping when every packet hunk, manifest row and invalidated anchor has exactly one disposition. <!-- @impl: preseed/agents/claude/skills/review-scope/SKILL.md::`scope=diff` execution -->

This is a completeness rule, not a budget, and the distinction is load-bearing: an earlier "at most four Bash calls" cap made a lane exhaust its allowance on environment discovery and report its required sub-policy read as unverified. Truncating a review is a worse failure than an expensive one. The wave budget is therefore surfaced on stderr and never enforced. <!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/run-review-lane.sh::rawBudget -->

The same measurement settles what to embed. Inlining beats fetching only when the fetch would cost an extra turn; inside a wave that was happening anyway, a fetch costs nothing while carrying the policy costs its bytes on every turn. So small, always-applicable policy is embedded — `review-scope`, the enforcement spines, `tdd-enforce` — and large conditional policy is read in wave one. Inlining `tdd-enforce` (15 KB) took the code lane from fourteen turns to eight; inlining `spec-enforce-ac` and `spec-enforce-truth` (41 KB) took the spec lane from ten turns to sixteen and cost 2.4x. Both followed from the same rule applied with and without regard to size.

**Consequences:** Predicted at three turns: 57k for the code lane, 72k for spec, 61k for doc, against 262k / 1,117k / 401k measured at eight, sixteen and eight. The prediction is the point of the model and the next round is its test. The risk is that a lane reads the wave structure as permission to stop early; the completeness rule and the unchanged verdict gate are what hold against that, and the stderr line makes an over-budget run visible rather than silently truncated.

**Related:** [AD115](#ad115-claude-pr-boundary-review-lanes-run-as-headless-claude--p-subprocesses), [AD116](#ad116-review-lane-phase-0-is-computed-deterministically-and-handed-to-the-lane).

---

### AD118: Seed provenance is carried in R2 custom metadata, verified before it was relied on

**Category:** Storage, Agents

**Status:** Accepted (2026-07-27). Implements [REQ-STOR-019](../../sdd/spec/storage.md#req-stor-019-seeded-files-are-marked-and-retired-ones-are-removed).

**Context:** Files a release stopped shipping were never removed from existing buckets, so retired policy kept loading beside whatever replaced it. Cleanup derived its delete list from the generated seed, so a key dropped from the seed also vanished from the delete list; the escape hatch was a hand-maintained enumeration carrying three entries against a real backlog of 165.

Removing them by name alone is not safe, because a key is a filename and not proof of ownership — a user may have their own file at a retired path. The distinguishing fact has to be recorded when the file is written, not guessed when it is deleted.

**Decision:** Every seed write stamps `x-amz-meta-codeflare-preseed` with the writing build's preseed hash. A reconcile rewrites every live key before cleaning, so an object still carrying an older build's marker is one the product has dropped — which removes the bookkeeping rather than automating it, since the object already records what a list would have had to remember. <!-- @impl: src/lib/r2-seed.ts::seedDocuments -->

**Verification (empirical, 2026-07-27).** The mechanism rests on three claims about systems we do not control, so they were probed against a real R2 bucket before anything was built on them, with a throwaway key deleted afterwards:

- a PUT carrying `x-amz-meta-*` round-trips: HEAD returned `x-amz-meta-codeflare-preseed` verbatim;
- a rewrite without the header drops it — S3 replaces object metadata wholesale, so an edit through the file browser or by rclone (which does not send custom metadata unless asked) silently transfers ownership to the user at no cost;
- **a listing does not expose custom metadata.** The key appeared in `ListObjectsV2`; the marker did not.

The third result is why the sweep is shaped as it is: the marker can only be read with a HEAD, so candidates are narrowed to keys the current build did not just write, listing is issued per two-segment prefix rather than per runtime root, runtime-owned paths are excluded before counting, and a candidate count past the cap skips the sweep rather than spending the requests. <!-- @impl: src/lib/r2-seed.ts::deleteNonModeConfigs -->

**Consequences:** Deletion always requires positive evidence, so the failure direction is a leak and never lost user data. Files already in buckets predate the marker and carry none, so they are enumerated once from the seed module's history and deleted by name in a single clean-slate pass; that list is frozen, and nothing is appended to it. Two guards were rejected on evidence: an age cutoff, because rclone rewrites object timestamps on sync and would have made the backlog immortal, and a content-hash match, because the clean slate is one-time and the marker takes over after it.

**Related:** [REQ-AGENT-049](../../sdd/spec/agents.md#req-agent-049-auto-upgrade-preseed-on-release) supplies the upgrade that runs it.

---

### AD119: Replace OpenVSCode with pinned code-server behind the existing session proxy

**Category:** Architecture, Security, Build / Container

**Status:** Accepted (2026-07-28); amended by [AD120](#ad120-browser-ide-uses-fixed-public-workspace-selection-and-exported-ui-state-continuity), [AD132](#ad132-user-extensions-are-a-bounded-manifest-over-an-immutable-base-inventory), and [AD141](#ad141-browser-ide-startup-follows-the-session-workspace-snapshot). Amends [AD95](#ad95-browser-ide-is-session-isolated-the-deliberate-opposite-of-the-bucket-stable-vault), supersedes [AD97](#ad97-keep-openvscode-upstream-clean-and-accept-known-vulnerability-risk), and amends [AD114](#ad114-native-pi-chat-and-the-official-claude-extension-own-editor-integration).

**Context:** OpenVSCode Server no longer provides a sufficiently current base for further Browser IDE investment. Codeflare must replace it without changing the authenticated session route, isolation boundary, lazy lifecycle, ephemeral editor state, owned native Pi integration, or exact official Claude integration.

code-server has an authoritative [release history](https://github.com/coder/code-server/releases), an [MIT license at v4.130.0](https://github.com/coder/code-server/blob/v4.130.0/LICENSE), an embedded [`lib/vscode` gitlink](https://github.com/coder/code-server/tree/v4.130.0/lib/vscode). Codeflare verifies the required extension proposals against the installed host and chooses one exact session-prefix stripping boundary so code-server receives root-relative paths.

**Decision:** Install the unmodified `coder/code-server` 4.130.0 linux-amd64 release from its immutable upstream artifact, verifying SHA-256 `3de23052e34fa705b3817efa66201cbc8d8ba6615b4cd03120c39bfc0ae1b7ab` during the image build. Shadow Pins derives the embedded Code OSS version and source commit from the immutable release tag's `lib/vscode` gitlink; the image verifies the actual embedded package version and records that derived source identity rather than trusting mutable release prose. Bind only to loopback, disable code-server's own password authentication because Codeflare's Access, ownership, and container-token chain remains authoritative, and do not configure a wildcard trusted-origin escape hatch.

Keep the established public `/api/vscode/<sessionId>/` location so the migration does not introduce a second session boundary. [REQ-IDE-001](../../sdd/spec/browser-ide.md#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy) owns authenticated HTTP/WebSocket routing beneath that location; [REQ-IDE-012](../../sdd/spec/browser-ide.md#req-ide-012-fixed-clean-browser-ide-workspace-selection) owns public selector rejection; and [REQ-IDE-015](../../sdd/spec/browser-ide.md#req-ide-015-fixed-workspace-projection-and-clean-browser-ide-url) owns private workspace projection and clean redirects. These are behavioral contracts rather than assumptions about code-server CLI flags.

Preserve the existing lazy init/restart/generation cleanup and fixed Pi, Claude, and empty inventories. Remove code-server's bundled GitHub Copilot extension at image build while leaving code-server and Code OSS source unpatched. Pass code-server explicit ephemeral user-data and extension directories matching the settings preparation layout. The Pi package keeps the `chatParticipantAdditions`, `chatParticipantPrivate`, `chatProvider`, and `defaultChatParticipant` proposals only if the actual embedded Code host admits them. The exact official Anthropic package and authenticated loopback-only IDE MCP remain unchanged. Legacy private `openvscode` file paths and function names are retained for this bounded migration to avoid an unrelated mass rename.

**Verification and rollout:** Automated suites exercise exact HTTP/WebSocket prefix stripping, queries, preserved caller Origin with canonical Host behavior, redirect, cookie, and `Service-Worker-Allowed` header rewriting, launch flags, settings paths, lifecycle cleanup, runtime pin/checksum, embedded Code metadata, and extension discovery. The deployment container-image workflow retains SBOM and Trivy evidence, while the complete-image job enforces readiness, image-size, process-count, and RSS ceilings informed by the captured rollback baseline. Deployed integration verification owns service-worker scope, reconnect URLs, and real Pi/Claude activation.

Integration promotion requires pass@3 evidence for Pi native Chat, official Claude loopback IDE MCP/editor context, empty inventory, route behavior, restart, and shutdown. Before the integration deployment mutates the environment, the operator must record the currently deployed immutable image digest and an exact-digest rollback command as deployment evidence; no promotion follows failed compatibility or resource gates.

**Alternatives rejected:** Continue investing on OpenVSCode despite its maintenance lag; use Microsoft's official VS Code Server under licensing unsuitable for this hosted offering; move directly to Eclipse Theia and rewrite the IDE integration surface; patch or fork code-server; accept wildcard trusted origins; change the public route; or rename all legacy private identifiers in the same migration.

**Consequences:** Codeflare gains a pinned upstream Code OSS runtime while retaining the established user-visible and security contracts. The image may grow and code-server's reverse-proxy behavior may expose compatibility gaps, so deployed evidence and immutable rollback are mandatory. Upstream-clean provenance remains auditable, but every code-server bump must re-verify checksum, embedded Code metadata, extension proposals, Origin behavior, scanner findings, resources, and pass@3 integration behavior.

**Related:** [REQ-IDE-001](../../sdd/spec/browser-ide.md#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-IDE-002](../../sdd/spec/browser-ide.md#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-003](../../sdd/spec/browser-ide.md#req-ide-003-ide-lifecycle-and-availability), [REQ-IDE-005](../../sdd/spec/browser-ide.md#req-ide-005-selected-native-ide-agent), [REQ-IDE-008](../../sdd/spec/browser-ide.md#req-ide-008-ide-agent-process-lifecycle), [REQ-IDE-009](../../sdd/spec/browser-ide.md#req-ide-009-frictionless-workspace-open-for-every-ide-agent), [REQ-IDE-010](../../sdd/spec/browser-ide.md#req-ide-010-pinned-ide-inventory-compatibility), [REQ-OPS-003](../../sdd/spec/operations.md#req-ops-003-pr-checks-run-lint-test-typecheck-and-security-audit), [REQ-OPS-027](../../sdd/spec/operations.md#req-ops-027-code-server-coupled-pin-automation).

---

### AD120: Browser IDE uses fixed public workspace selection and exported UI-state continuity

**Category:** Architecture, Security, Storage, Build / Container

**Status:** Accepted (2026-07-28); amended by [AD132](#ad132-user-extensions-are-a-bounded-manifest-over-an-immutable-base-inventory) on 2026-08-17. Amends [AD95](#ad95-browser-ide-is-session-isolated-the-deliberate-opposite-of-the-bucket-stable-vault), [AD114](#ad114-native-pi-chat-and-the-official-claude-extension-own-editor-integration), and [AD119](#ad119-replace-openvscode-with-pinned-code-server-behind-the-existing-session-proxy).

**Context:** code-server's CLI folder made `/home/user/workspace` the initial location but its root redirect exposed that path as a public `folder` query, and callers could substitute `folder`, `workspace`, or `ew`. Code OSS reads browser-visible selectors or a server-provided `folderUri`; a selector added only to the private proxy request therefore leaves a clean browser document as an empty window.

Code OSS also contributed an account-backed **Code Review** action while setup was incomplete. Users want theme, keyboard-layout, Explorer, and open-file continuity, but syncing live code-server storage would also carry mutable databases, arbitrary User settings, extension/global state, SecretStorage, authentication, chat history, logs, and unsafe WAL/SHM companions. <!-- @impl: scripts/browser-ide-ui-state.py::safe_setting_value --> <!-- @impl: scripts/browser-ide-ui-state.py::capture --> <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON -->

The image-size audit also found a 120.2 MiB uncompressed duplicate Pi SDK inside the extension prewarm tree. Replacing it with a symlink would save only about 27.7 MiB compressed while changing the realpath and dependency topology used by the path-sensitive Jiti prewarm cache.

**Decision:** Reject decoded public `folder`, `workspace`, and `ew` selectors independently at both Worker and host HTTP/WebSocket boundaries. The host injects `folder=/home/user/workspace` only into the private root request and removes workspace selectors from redirects before they become browser-visible. For a successful root document, the host also projects the equivalent fixed `vscode-remote` `folderUri` into the pinned workbench configuration. Missing, duplicate, malformed, compressed, or oversized configuration fails closed. Non-root traffic remains streaming and unchanged. This is workspace-selection confinement, not a filesystem sandbox: terminals, trusted extensions, and agents retain their existing container access.

Keep live code-server data container-local and unsynced. After the launch generation is fully reaped, export only allowlisted theme settings, string-valued `keyboard.layout`, and Explorer/open-file rows whose file resources resolve canonically inside `/home/user/workspace`. Write one atomic, mode-0600, maximum-1-MiB per-user snapshot at `~/.codeflare/ide-ui-state.json`; R2 sync includes only that exact path under `~/.codeflare/`. Restore into a fresh workspace database before managed Pi, Claude, or unsupported-inventory settings overwrite owned keys. Never sync other User settings, raw databases, workspace/global extension state, SecretStorage, Accounts authentication, chat history, logs, WAL, or SHM.

**Amendment (2026-08-25):** The live code-server root is `/run/codeflare/openvscode`, preserving the ephemeral container-local contract while surviving disposable `/tmp` cleanup. <!-- @impl: entrypoint.sh::_openvscode_launch_once -->

The Pi inventory activates after startup, marks generic Chat setup complete to suppress Code OSS's account-backed **Code Review** action, and keeps **Review with Codeflare**. All visible owned Pi/provider labels become **Codeflare** while stable private IDs remain unchanged. Preserve the physical Pi SDK prewarm install and established Jiti realpath topology; the measured compressed saving does not justify a startup regression risk.

**Consequences:** Public Browser IDE URLs remain clean and cannot choose another workspace through code-server's supported selectors. Safe UI preferences follow the user without making live editor or credential state bucket-stable. The workbench meta-element shape, context-key workaround, and exact Code OSS menu gate must be reverified on every coupled code-server bump and during pass@3 integration. Complete-image smoke starts the packaged server and checks the projection against its actual root HTML. Larger image reductions require a separate measured proposal; this change deliberately takes no Pi deduplication saving.

**Related:** [REQ-IDE-002](../../sdd/spec/browser-ide.md#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-005](../../sdd/spec/browser-ide.md#req-ide-005-selected-native-ide-agent), [REQ-IDE-011](../../sdd/spec/browser-ide.md#req-ide-011-file-review-with-codeflare), [REQ-IDE-012](../../sdd/spec/browser-ide.md#req-ide-012-fixed-clean-browser-ide-workspace-selection), [REQ-IDE-013](../../sdd/spec/browser-ide.md#req-ide-013-account-backed-code-review-suppression), [REQ-IDE-014](../../sdd/spec/browser-ide.md#req-ide-014-active-editor-review-with-codeflare), [REQ-IDE-015](../../sdd/spec/browser-ide.md#req-ide-015-fixed-workspace-projection-and-clean-browser-ide-url), [REQ-IDE-016](../../sdd/spec/browser-ide.md#req-ide-016-ui-state-capture-and-restore-ordering).

---

## Related Documentation

- [Architecture - System Components](../lanes/architecture.md#system-components) - Component overview
- [Architecture - Design Rationale](../lanes/architecture.md#design-rationale) - Architectural principles
- [Security - Authentication Gate](../lanes/security.md#authentication-gate) - Security model
- [Authentication - Auth Modes](../lanes/authentication.md#authentication-modes) - CF Access vs Direct GitHub OAuth
- [Mobile - Scroll Stability](../lanes/mobile.md#scroll-stability) - Mobile terminal design decisions
- [Vault - Directory Layout](../lanes/vault.md#directory-layout) - Vault path, hidden-root constraint, special folders

### AD121: A review boundary is a delivery subcommand, not any Git invocation

**Category:** Architecture, Build / Container

**Status:** Superseded by [AD142](#ad142-review-ingress-is-delivery-only-and-completion-is-joint) (2026-08-26).

**Context:** `enforce-review-spawn.sh` measures lane coverage strictly after `PUSH_LINE`, the last transcript line its Layer 1 detector matched. That detector matched the bare words `git` and `gh` in command position, so every `git log`, `git status`, and `git diff` was a boundary. Reading a lane report is done with exactly those commands, so the anchor routinely moved past the spawns of the round being read and the gate re-demanded lanes that had already returned. Replayed against one session's transcript: 58 matches against 8 real pushes, with `PUSH_LINE` resolving to a `git diff` issued while diagnosing this.

The same breadth reached `retroactive_ack_scan`. That scan carried its own narrower matcher until #814 deleted it and repointed the scan at the shared broad function, leaving a comment claiming the two had always been identical. Windows then ended at the next read-only Git call rather than the next push, so real-push windows still containing their own lane spawns fell from 7 of 8 to 5 of 8; those windows could not complete and no head was retroactively acknowledged.

`git-push-review-reminder.sh` had already solved the classification, and Pi's `classifyReviewBoundaryCommand` solves it the same way: parse any `git`/`gh` in command position, then read the subcommand to name the event.

**Decision:** Separate what triggers enforcement from what anchors the coverage window. Candidacy stays exactly as broad as it has always been: any executable `git` or `gh` command triggers the gate, and Layer 2 (`gh pr view`) decides eligibility. That breadth is a tested contract, not an accident, and narrowing it silently disables enforcement for read-only activity that a reviewed head still depends on.

What narrows is the anchor. The delivery vocabulary is `git push`, `gh pr create`, and `gh pr merge`, classified with the global-option sets both siblings already share, and lane coverage plus `retroactive_ack_scan` measure from the last delivery rather than the last candidate. Both views come from one parse, so they cannot drift apart the way the two matchers did. Marking the event decides only *where* a delivery happened; it grants no authority over whether that delivery is reviewable.

`git-push-review-reminder.sh` needs no anchor and keeps only the candidate surface, varying which message it emits.

**Consequences:** With no delivery anywhere in the transcript the anchor is the start of the file, so every lane spawn present counts; anchoring on the last candidate instead would subtract earned coverage and would reinstate this decision's own defect whenever the delivery sits outside a rotated transcript.

A PR opened by a path outside that vocabulary, `gh api repos/.../pulls` or a push wrapper, produces no boundary and no enforcement until the next qualifying command on that branch. That gap is accepted rather than closed by pattern-matching REST paths inside the classifier, which would rebuild the imprecision this decision removes; every PR in this repository is opened with `gh pr create`. `gh pr ready` is deliberately excluded: it changes a draft flag, not a head. Both hooks must move together when the vocabulary changes, and they hold two copies of the classifier today; a shared `lib/` extraction is the standing follow-up.

### AD122: The CI monitor observes and reports; it does not cancel runs or chase the remote

**Status:** Accepted (2026-08-11). Amends [AD121](#ad121-a-review-boundary-is-a-delivery-subcommand-not-any-git-invocation)'s sibling work on the CI monitor.

**Context:** Two mechanisms were added to the CI-monitoring skill and both were the wrong answer to a real problem.

The first was a launcher step that listed in-flight runs on the branch and cancelled the ones whose head was not the current HEAD. It was wrong three times in a row: an ancestry guard that excluded exactly the amended and force-pushed heads worth cancelling, then no guard at all, which exposed fork pull requests sharing a branch name, then a lineage guard that was merely less wrong. An older section of the same skill told the agent to cancel every non-completed run on the branch with no head filter at all, which cancels the run it is about to monitor.

The second was supersession detection: on every poll the monitor compared the branch tip to its own head and exited on a distinct token when they diverged. It was added because stale results were arriving after a newer monitor had started. But the reason a stale result was indistinguishable from a fresh one is that `CI_RESULT success` and `CI_RESULT failure` carried no head at all. Only `timeout` did. The machinery grew to a `git ls-remote` per fifteen seconds, a conditional `git fetch`, an object-existence probe, an ancestry test, two terminal tokens and two exit codes, and it generated a review finding in every round it survived.

In both cases each fix repaired the previous fix. That is the signal that the mechanism, not the guard, was the mistake.

**Decision:** The monitor observes GitHub and reports what it sees. It does not cancel runs, and it does not consult the remote about its own relevance.

<!-- doc-allow-element: AD122 accepted decision paragraph is preserved verbatim -->
Cancellation belongs to the workflows. Every one whose superseded runs are worth killing declares `concurrency` with `cancel-in-progress: true`; most key the group on `github.ref`, which for a `pull_request` event is the per-PR merge ref, so two pull requests sharing a head branch name never cancel each other while superseded pushes of the same pull request always do. A client reconstructing that from a branch name cannot match it, because the branch name is precisely the ambiguous part. The workflows that omit `cancel-in-progress` omit it on purpose: `deploy.yml` mutates the worker, secrets, KV, and registry in sequence and sets it false so a cancelled deploy cannot leave a half-configured target, and `sign-release.yml` and `bump-shadow-pins.yml` serialise for the same reason. A cancel loop keyed on a branch name cannot see that policy and will eventually cancel the one run that must never be cancelled.

Staleness is answered by naming the head. Every terminal `CI_RESULT` line carries `head=<sha>`, so a result is self-identifying and a reader comparing it against the current HEAD needs nothing else. That check already exists as an obligation: the CI-result handoff gate requires the monitored head to be reported. The data was missing, not the discipline.

**Consequences:** The skill keeps one bash block and no `git` calls beyond the caller's `rev-parse`. A stale monitor still runs to its deadline and still writes a result; that result names a head that is not current, which costs nothing and cannot be misread. `container-image.yml` and `nightly-pr-checks.yml` need no concurrency key, being `workflow_call` and `schedule` only, and `promotion-source.yml` is a seconds-long pull-request check with nothing to burn.

A future agent that notices a superseded matrix still running must add or fix a `concurrency` block in the workflow, never a `gh run cancel` loop in a client script. One that notices a stale verdict must check `head=`, not teach the monitor to poll the remote.

### AD123: The Claude fix directive owns delivery; Pi leaves it to standing rules

**Status:** Accepted (2026-08-11)

**Context:** Both runtimes end a review round the same way: acknowledge the reviewed head, then hand the accepted findings to a separate FIX turn. Pi's FIX follow-up says only that the head is acknowledged and fixes may begin. It names no push, so delivery falls to the agent's standing rules, which forbid pushing while a review is incomplete and require a CI result first. That absence is why a Pi round never delivers a head whose CI is still in flight.

Claude was aligned to that shape on the reasoning that Pi is authoritative. The result was a loop that stopped after the fix commit and waited to be told to push. The reason is asymmetric between the runtimes: in Claude the FIX directive arrives as a hook-injected instruction, and a hook directive outranks a standing rule. Moving the delivery condition into `git-workflow.md` therefore did not relocate it, it demoted it. The rule was correct and inert.

The original defect that prompted removing the push order was real but different. The order fired unconditionally, so a fix landed on the remote while the reviewed head's CI was still running, discarding that run and opening a round on a head whose predecessor was never verified.

**Decision:** Claude's FIX directive orders the delivery push, and carries the condition with it rather than delegating it. It commits, waits for this head's terminal `CI_RESULT` if one has not landed, then pushes without asking. An absent result may only delay the push, never cancel it: no monitor, or a log that has not advanced, means push now. A failing result is different in kind — it is a finding, fixed in the same commit before the push ([AD124](#ad124-bounded-re-delivery-replaces-the-memory-capture-hard-block) round). Pi is unchanged and continues to rely on its standing rules.

**Consequences:** The two runtimes diverge at exactly one point, deliberately, and this record is why. A reader comparing them will find Pi's follow-up silent on delivery and Claude's explicit; that is not drift and should not be "fixed" by deleting either.

Anyone weakening the Claude directive must move the instruction, not merely restate it somewhere quieter, because a rule cannot outrank the directive it is meant to constrain. Anyone adding a wait to that directive must give it a terminal escape, or the round stalls on a line that never lands, which is the same failure the push order exists to prevent.

### AD124: Bounded re-delivery replaces the memory-capture hard block

**Status:** Accepted (2026-08-11)

**Context:** Claude's capture directive was advisory, and REQ-MEM-012 (since removed from the spec, superseded by [REQ-MEM-020](../../sdd/spec/memory.md#req-mem-020-capture-requests-are-re-delivered-under-a-bound)) closed that gap with a PreToolUse hook that blocked every tool call except the capture spawn itself. The gap was real: a directive nobody acts on leaves the carrier undrained, and the threshold only re-fires on a crossing, so a long session could pass with zero captures.

The block bought that guarantee at a price the design never accounted for. It made a second hook the sole arbiter of whether any work could proceed, and the review gate refuses exactly the spawn the block demands during the post-lane, pre-triage window. Reading the lane report is a tool call, publishing the triage table is what lifts the review gate, and the block forbids the read.

The escape observed in practice was accidental: both are PreToolUse, the block runs first and marks its in-flight sentinel before the review gate refuses, so a 600-second window opened on behalf of a spawn that never happened. Reorder the hooks, or make the sentinel conditional on the spawn succeeding, and the session deadlocks with no bypass.

Pi meets the same requirement without a block. Its request is durable, `extractionDue` re-sends the launch at every settle until the artifacts verify, it latches after six deliveries, and a later arm replaces a latched request. An ignored directive comes back rather than freezing the session.

**Decision:** Retire the hard block and adopt bounded re-delivery. The arming hook writes a durable request and re-emits it once per prompt up to six times, then latches and stays silent until fifteen further prompts allow a replacement. Two related properties move with it. The capture filename and timestamp are fixed when the request is armed rather than derived by the subagent, which makes success checkable from an artifact instead of self-report. The counter advances only inside `publish-memory-capture.sh`, after the merge and global publication succeed and only if the named capture file exists, and it never moves backwards.

**Consequences:** No hook can wedge a session on behalf of memory capture. A capture that fails is retried instead of being recorded as done: the old arming hook advanced the counter immediately, so a failed capture silently discarded its window forever, which was a data-loss bug independent of the deadlock. The agent definition drops its `model:` pin in favour of `CODEFLARE_MEMORY_MODEL`, and carries a six-turn budget, raised from four after a large window exhausted the smaller budget on every attempt — a deterministic failure that re-delivery cannot clear, so all six deliveries burned on one window; [AD58](#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)'s fidelity reasoning still holds and is now expressed as a default rather than a hard pin. Pi's own four-turn extraction budget ([AD103](#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs)) is unchanged.

The cost is that a capture can be skipped six times and then dropped, where the block made it eventually mandatory. That is deliberate: an ignored capture costs one window of memory, and a wedged session costs the whole turn. Anyone tempted to reintroduce a blocking enforcement hook must first show it cannot refuse the spawn some other gate requires.

### AD125: Bounded automatic resync after exhausted recovery

**Category:** Storage

**Status:** Accepted (2026-08-14); supersedes [AD14](#ad14-never-auto---resync-on-bisync-failure)

**Context:** Steady-state bisync can lose the listing state required for another ordinary recovery attempt, or remain unrecoverable after its internal retries and vanished-file repair. Leaving the daemon in that state preserves deletion tracking in theory and stops persistence in practice. The runtime already resolved this by rebuilding the baseline after a bounded failure budget, and [REQ-STOR-003](../../sdd/spec/storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers) AC6 makes that observable behavior explicit. <!-- @impl: entrypoint.sh::start_sync_daemon -->

**Decision:** Use resilient/recover semantics and vanished-file repair first. If three consecutive cycles remain unrecoverable after their internal retries, call `establish_bisync_baseline()` to rebuild the baseline. When exit code 7 coincides with missing prior listings, rebuild immediately because two more attempts cannot operate without that state. A failed rebuild remains visible and is retried only after another failed cycle; it does not terminate the daemon.

**Alternatives rejected:** Never rebuilding automatically, because a session with absent or irrecoverable listings would keep running without persistence; rebuilding on the first ordinary failure, because that spends the deletion-safety trade-off before resilient recovery has had a chance to work; deleting suspected R2 objects, because corruption was not established and user data is not disposable recovery state.

**Consequences:** Baseline reconstruction can resurrect a deletion that existed on only one side. The runtime accepts that bounded risk to restore a functioning persistence loop after ordinary recovery is exhausted. Logs and sync health expose the fallback and its outcome. Startup continues to establish a baseline after one-way restore, while healthy steady-state cycles never invoke `--resync`.

### AD126: Vault browser-realm scripts are authored source, never serialized Worker functions

**Category:** Architecture, Security, Storage

**Status:** Accepted (2026-08-15)

**Context:** Vault bootstrap, stale-worker removal, registration, readiness, focus, and reload logic originates in the Cloudflare Worker bundle but executes in a browser realm after HTML injection. A v3 refactor serialized bundled Worker functions with `Function.prototype.toString()`. Wrangler's esbuild `keepNames` transform added calls to the bundle-local `__name` helper inside four serialized functions, but `toString()` copied only each function body into the page. A production bundle of that implementation emitted browser source that would throw `Codeflare vault bootstrap: __name is not defined`; because stale-worker cleanup precedes canonical registration, execution could not continue to registration, IndexedDB creation, sync, indexing, or readiness. Direct source-level helper execution could not expose that cross-realm dependency. This boundary is independent of [AD69](#ad69-silverbullet-vault-runs-its-native-service-worker-for-persistent-encrypted-client-indexing)'s native-worker decision and [AD84](#ad84-retain-the-vault-sw-encryption-key-in-memory-neuter-the-proactive-flush-and-open-a-green-vault-button-directly)'s encryption-key lifecycle. <!-- @impl: src/lib/vault-browser-scripts.ts::VAULT_UNREGISTER_STALE_WORKERS_SOURCE --> <!-- @impl: src/lib/vault-view.ts::injectVaultBootstrapHopHtml --> <!-- @test: src/__tests__/lib/vault-browser-bundle.test.ts (production-bundled Vault browser scripts) -->

**Decision:** Reusable callable bodies for Vault scripts injected from the Worker are maintained as explicit, self-contained authored source in `src/lib/vault-browser-scripts.ts`; `src/lib/vault-view.ts` owns their injection wrappers and bootstrap orchestration. Browser-realm source must not be produced by `Function.prototype.toString()`, by serializing any callable transformed by the Worker bundler, or by post-processing compiled output. It may not depend on Worker-module bindings or bundler-only helpers. Dynamic values cross the boundary only as JSON-encoded arguments escaped for an HTML script context.

The executable contract is the production-like bundle test: bundle the real injector with esbuild `keepNames`, extract the exact generated scripts, and execute them in isolated VM realms. The test must retain observable coverage of stale/canonical/unrelated worker handling, cleanup-before-registration ordering, focus behavior, readiness rejection and convergence, exact encryption-key transport, persistence-before-redirect ordering, and controlled reload. A source refactor that bypasses this boundary or tests only pre-bundle helpers is incomplete even when its TypeScript tests pass.

**Alternatives rejected:** `Function.prototype.toString()` for functions that happen not to contain transformed nested callables, because a later local refactor can silently reintroduce bundle-only dependencies; injecting an `__name` shim, because it couples browser behavior to an undocumented bundler implementation detail and does not cover other possible helpers; disabling `keepNames`, because Worker diagnostics and unrelated bundled code own that setting; regex-stripping or rewriting compiled output, because it is syntax-fragile and cannot prove semantic self-containment.

**Consequences:** Browser-realm code has an explicit source representation rather than inheriting TypeScript function bodies, so changes must keep the authored script and its production-bundle behavioral test aligned. That small duplication is intentional: the realm boundary is visible, reviewable, and independent of Wrangler's current transform strategy. Future cleanup may reorganize or generate the authored source only if the emitted browser bytes remain self-contained and the same production-bundle execution contract stays authoritative; converting the boundary back to serialized Worker functions is not a behavior-preserving refactor.

### AD127: Native Inline Chat uses proposal-only Pi turns and host-owned text edits

**Category:** Architecture, Security

**Status:** Partially superseded by [AD128](#ad128-inline-review-lifecycle-belongs-to-the-pinned-controller) for review ownership and by [AD135](#ad135-inline-chat-requires-one-host-correlated-result) for the edit-only model envelope and model-repeated request ID; host-owned edit validation remains active. Accepted 2026-08-16 and partially supersedes [AD114](#ad114-native-pi-chat-and-the-official-claude-extension-own-editor-integration) only for editor Inline Chat execution. Implements [REQ-IDE-020](../../sdd/spec/browser-ide.md#req-ide-020-native-pi-editor-proposal-execution), [REQ-IDE-025](../../sdd/spec/browser-ide.md#req-ide-025-shared-ide-pi-surface-isolation), [REQ-IDE-026](../../sdd/spec/browser-ide.md#req-ide-026-native-inline-chat-edit-validation), [REQ-IDE-028](../../sdd/spec/browser-ide.md#req-ide-028-native-inline-chat-dispatch-error-isolation), [REQ-IDE-029](../../sdd/spec/browser-ide.md#req-ide-029-native-inline-chat-feedback), and [REQ-IDE-030](../../sdd/spec/browser-ide.md#req-ide-030-native-inline-chat-result-envelope).

**Context:** Code OSS 1.132 editor Inline Chat expects host-owned edit transactions, which cannot truthfully represent unrestricted Pi direct writes. Its pinned controller excludes an entire response view-model unless that response has a [pending confirmation](https://github.com/microsoft/vscode/blob/df53daabb18cd157bdb08c7f01c34df936cf12f4/src/vs/workbench/contrib/inlineChat/browser/inlineChatController.ts#L239-L244). While admitted, the response can render its parts; visibility is not durable after confirmation resolves. Result details are only a secondary status because the zone hides them after review focus moves. AD114 initially selected `inlineChat2.continueInChat`. The pinned action is guarded by visible and terminated inline-session context in the [exact Code OSS source](https://github.com/microsoft/vscode/blob/df53daabb18cd157bdb08c7f01c34df936cf12f4/src/vs/workbench/contrib/inlineChat/browser/inlineChatActions.ts#L358-L377). Integration deployment [`31914050650`](https://github.com/nikolanovoselec/codeflare/actions/runs/31914050650) confirmed that invoking it during Codeflare's active participant request did nothing while the Codeflare model remained selectable. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate -->

Fresh-session validation after deployment [`31918973796`](https://github.com/nikolanovoselec/codeflare/actions/runs/31918973796) exposed a second silent wait. The command called `sendUserMessage` on `ExtensionCommandContext`, where Pi 0.84.1 does not define it. Pi swallowed the command exception as an `extension_error`, treated the slash command as handled, and started no agent turn; the RPC backend ignored that envelope and therefore waited forever for settlement.

**Decision:** Keep one persistent IDE-owned Pi process. Panel turns retain its normal unrestricted tools. A serialized editor turn invokes the owned `codeflare-inline-edit` command, which saves the active tools, exposes only one terminating proposal tool, and restores the exact prior set at settlement. The RPC backend correlates that tool call and validates a bounded single-line what-and-why explanation; the VS Code adapter validates document version, range bounds, overlap, count, and size before emitting `response.textEdit`. Pi never writes the target file directly.

The command dispatches through `ExtensionAPI.sendUserMessage`, not its command context. A command-attributed failure or the nested dispatch's `<runtime>` `send_user_message` failure rejects the editor request and retires the shared IDE backend so a later request can use its replacement; unrelated extension errors remain isolated. Pi 0.84.1 [awaits extension settlement handlers before emitting external settlement](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/agent-session.ts#L596-L603), so serialization cannot release a panel turn before tool restoration. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: openvscode/agent-sidebar/src/pi/inline-edit-validation.ts::validateInlineTextEdits --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-028: inline command extension errors reject immediately and retire the backend) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-028: asynchronous inline dispatch errors reject after command acceptance and retire the backend) --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) -->

Editor requests publish immediate bounded progress and forward provider reasoning while keeping unstructured final-answer markdown hidden. After emitting the validated edit transaction, the participant places the bounded explanation in a native confirmation with Keep/Undo buttons and repeats it in the non-blocking fallback notification; result details retain the explanation and edit count only as secondary status.

Both owned action paths invoke the pinned host's URI-scoped [`chatEditing.acceptFile` or `chatEditing.discardFile`](https://github.com/microsoft/vscode/blob/df53daabb18cd157bdb08c7f01c34df936cf12f4/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingActions.ts#L144-L190) command, then reopen the captured ordinary text document. A bounded correlation registry retains only the current request for each URI, evicts beyond 32 pending URIs, and consumes a decision before invoking its command, so delayed superseded or duplicate actions cannot resolve a newer proposal. That navigation addresses the observed extension-host failure where a later editor request could otherwise use a review-owned URI absent from `ExtHostDocuments`; dismissing the notification leaves the native confirmation and review pending.

**Alternatives rejected:** Invoking the termination-only continuation action during the active request, because deployed behavior proved it was a no-op; relying on ordinary Markdown, thinking, command buttons, or result details for the explanation, because the pinned controller excludes responses without pending confirmation or focus-hides result details; routing every editor request to panel Chat, because it does not generate code inline; leaving mutation tools active and replaying their filesystem changes as host edits, because that can double-apply or overwrite concurrent work; patching Code OSS; building a duplicate Changes view; or launching a third Pi process solely for editor requests.

**Consequences:** Terminal Pi and one IDE Pi remain the only agent processes. Panel and editor turns share the IDE process's in-memory conversation, but editor turns temporarily replace its tool surface with one proposal tool. Valid edits render through native Inline Chat with a correlated explanation and native confirmation Keep/Undo; the notification remains a reliable fallback outside the focus-sensitive zone. A confirmation click creates one host follow-up request, but the extension consumes its correlated decision without invoking Pi.

Stale proposals, malformed proposals, superseded or malformed confirmation decisions, duplicate review actions, and matching inline-dispatch failures fail closed. The proposal contract is bounded to one active workspace document and remains Partial until a fresh integration session proves rendered generation, both review actions, immediate second-request recovery, and tool restoration.

### AD128: Inline review lifecycle belongs to the pinned controller

**Category:** Architecture, Security

**Status:** Accepted (2026-08-16). Supersedes only AD127's extension-owned confirmation, notification actions, decision registry, and editor-reopening behavior; [AD135](#ad135-inline-chat-requires-one-host-correlated-result) later replaces the model-facing result envelope without changing controller ownership. Implements [REQ-IDE-029](../../sdd/spec/browser-ide.md#req-ide-029-native-inline-chat-feedback), [REQ-IDE-030](../../sdd/spec/browser-ide.md#req-ide-030-native-inline-chat-result-envelope), and [REQ-IDE-033](../../sdd/spec/browser-ide.md#req-ide-033-controller-owned-inline-review-lifecycle).

**Context:** Integration proved that Pi can generate valid host-owned edits, while extension-owned confirmation clicks create another participant request and duplicate the host's review UI. Later exact-host reproduction established that confirmation follow-ups carry no `location2` and skip document lookup; the observed `ExtHostDocuments` error instead requires first-request location data whose document is not synchronized. Uploaded runtime evidence also showed duplicate file tabs and a side editor group. The pinned host supplies the invoking editor through private `location2`; Codeflare instead read whichever editor had focus when its handler ran. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate -->

The pinned controller opens a side group only when an editing entry's URI differs from the initiating session URI. Its Keep/Close actions call `acceptSession()` or `rejectSession()`, which settle and dispose controller state. `showTextDocument()` routes by resource and cannot guarantee replacement of a review editor with an ordinary editor. [Pinned request conversion](https://github.com/microsoft/vscode/blob/df53daabb18cd157bdb08c7f01c34df936cf12f4/src/vs/workbench/api/common/extHostTypeConverters.ts#L3486-L3504), [pre-handler document resolution](https://github.com/microsoft/vscode/blob/df53daabb18cd157bdb08c7f01c34df936cf12f4/src/vs/workbench/api/common/extHostChatAgents2.ts#L924-L945), and [controller review actions](https://github.com/microsoft/vscode/blob/df53daabb18cd157bdb08c7f01c34df936cf12f4/src/vs/workbench/contrib/inlineChat/browser/inlineChatActions.ts#L260-L334) define that boundary.

**Decision:** Use `request.location2.document`, selection, and whole range as the sole editor identity. Missing or malformed editor location fails before Pi starts. Use a host-ingested empty text-edit start marker, one validated edit batch, and a completion marker for the same URI. Keep `accessibility.openChatEditedFiles` false to disable the [configuration-gated edited-file opener](https://github.com/microsoft/vscode/blob/df53daabb18cd157bdb08c7f01c34df936cf12f4/src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingServiceImpl.ts#L240-L259); it does not gate the controller's different-URI side-group path. `InlineChatController` owns Keep/Close, settlement, disposal, and navigation. Remove extension confirmation, notification actions, direct Chat Editing commands, decision correlation, and document reopening. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::parseInlineEditorLocation --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-native-chat.ts::collectNativePiPromptInput --> <!-- @impl: openvscode/claude/managed-settings.mjs::buildPiOpenVscodeSettings --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-018 + REQ-IDE-019 AC6 + REQ-IDE-021 AC1 + REQ-IDE-033: Pi settings keep Inline edits in the invoking editor) -->

Raw tool-start events precede Pi argument validation, so the backend may retain up to three attempts and accept the first valid correlated proposal. Invalid-only settlement reports a bounded correlation, summary, count, or geometry category; a second valid proposal still fails closed. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend -->

**Alternatives rejected:** An arbitrary cursor-distance threshold, because the evidenced side group is URI-driven; a staged confirmation, because it adds another participant request; retaining notification review actions, because they bypass controller disposal; removing `showTextDocument()` without changing ownership, because that leaves the original URI defect; or patching Code OSS.

**Consequences:** Pi execution, shared conversation, proposal-only editor tools, and host-owned edit validation remain unchanged. When edit and session URIs match, the pinned zone status renders result details while the native controls own Keep/Close. Runtime acceptance requires one invoking editor, native Keep/Close, immediate second requests after both outcomes, and no missing-document error.

### AD129: Proxied Inline URI identity must be observed before lifecycle changes

**Category:** Architecture, Operations

**Status:** Superseded (2026-08-16) by [AD131](#ad131-inline-diagnostics-retain-only-sanitized-resource-identity) after the integration probe recorded in [AD130](#ad130-the-projected-workspace-uses-the-canonical-browser-authority) satisfied this evidence gate. The historical decision added an evidence gate to [AD128](#ad128-inline-review-lifecycle-belongs-to-the-pinned-controller) without changing review ownership and introduced [REQ-IDE-034](../../sdd/spec/browser-ide.md#req-ide-034-bounded-inline-lifecycle-diagnostics).

**Context:** Exact-host reproduction with a third-party default editor participant completed the one-tab native Keep/Undo lifecycle on code-server 4.132.0. Integration instead opened another tab and lost the invoking editor's review controls. Core edit ingestion has no participant-identity branch. The controller unconditionally opens an editing entry in a side group when its modified URI differs from the Inline session URI, while Keep requires the invoking editor group to own a modified entry. [Side-group selection](https://github.com/microsoft/vscode/blob/df53daabb18cd157bdb08c7f01c34df936cf12f4/src/vs/workbench/contrib/inlineChat/browser/inlineChatController.ts#L375-L396) and [Keep preconditions](https://github.com/microsoft/vscode/blob/df53daabb18cd157bdb08c7f01c34df936cf12f4/src/vs/workbench/contrib/inlineChat/browser/inlineChatActions.ts#L278-L310) make URI identity the leading proxied-runtime boundary.

Repository CI activates the packaged extension against a mocked VS Code API and does not run `InlineChatController`, Chat Editing, or a renderer. Deployment receipts therefore cannot distinguish an old container, wrong invocation surface, or URI-authority mismatch.

**Decision:** Preserve the controller-owned lifecycle unchanged. During a bounded editor-request window, record a local diagnostic revision, effective settings, the exact invoking and streamed URIs, and capped tab-change/snapshot metadata in the **Codeflare Inline Chat** Output channel. Record no document content and no panel activity. One fresh proxied integration run must classify image freshness, request surface, and tab URI identity before another lifecycle or proxy change. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::createInlineDiagnostics --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5 + REQ-IDE-034: native Pi registers account-free panel and editor Chat) --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) -->

**Alternatives rejected:** Restoring confirmation and notification review duplicates native controls; direct `chatEditing.acceptFile`/`discardFile` resolves a session from widget focus rather than URI identity; another setting cannot gate the unconditional side-group path; and changing the Worker proxy before capturing both URI identities would be another guess.

**Consequences:** The probe commit was intentionally diagnostic, not a claimed product fix. Integration supplied the required activation, request, stream, tab-change, and delayed snapshot lines: the correct image and editor surface streamed the same extension-host `file:` URI, then the controller opened an ordinary duplicate file tab in a side group. [AD130](#ad130-the-projected-workspace-uses-the-canonical-browser-authority) owns the resulting narrow proxy correction. The full one-tab Keep/Undo sequence still requires repetition in a fresh deployed session.

### AD130: The projected workspace uses the canonical browser authority

**Category:** Architecture, Security

**Status:** Accepted (2026-08-16). Implements [REQ-IDE-035](../../sdd/spec/browser-ide.md#req-ide-035-canonical-browser-ide-workspace-projection) AC2 and preserves [AD128](#ad128-inline-review-lifecycle-belongs-to-the-pinned-controller).

**Context:** Integration run `31970207463` deployed diagnostic revision `uri-authority-probe-v1` at exact head `13a8e567865380ca7f356364d0510bcd7cb83dd6`. A real editor request carried `location2`, and the invoking and streamed extension-host URIs were both `file:///home/user/workspace/graymatter.ch/astro.config.mjs`. Within 283 ms of streaming, the pinned controller opened an ordinary tab for that same visible file in `SIDE_GROUP`; native feedback and Keep/Undo stayed absent. This rules out stale rollout, the wrong participant surface, the configuration-gated edited-file opener, and an extension-selected target.

The extension API shows remote workspace documents as `file:` URIs. Across the RPC boundary, the pinned [extension-host URI transformer](https://github.com/microsoft/vscode/blob/df53daabb18cd157bdb08c7f01c34df936cf12f4/src/vs/base/common/uriTransformer.ts) maps an outgoing `file:` URI to `vscode-remote://<initData.remote.authority>/...`. Pinned code-server's [base-path patch](https://github.com/coder/code-server/blob/313bf0359b4d391ba18f1fa131aad8a583bc2919/patches/base-path.diff) deliberately emits `remote` as the server-side workbench authority and later replaces `remoteAuthority` with `location.host` in browser bootstrap code. That replacement does not rewrite a server-provided `folderUri`. Codeflare's earlier fixed-workspace projection copied the placeholder into `folderUri`, so the renderer session used `vscode-remote://remote/...` while streamed edits arrived as `vscode-remote://<public-host>/...`. The Inline controller correctly treated those as different resources and opened the edit entry in a side group.

**Decision:** Keep the Worker route, participant lifecycle, native edit parts, and pinned host unchanged. The authenticated host already derives one canonical external authority for upstream `Host` and `X-Forwarded-Host`; use that same validated value for the projected fixed `folderUri.authority`. Continue preserving the server-provided `remoteAuthority` and all unrelated workbench configuration. Fail closed when either the server placeholder or canonical browser authority is malformed. <!-- @impl: host/src/vscode-proxy.ts::projectVscodeWorkbenchWorkspace --> <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::verifyCodeServerWorkspaceProjection --> <!-- @test: host/__tests__/openvscode-proxy.test.js (projectVscodeWorkbenchWorkspace / REQ-IDE-035 AC1+AC2+AC3+AC4 (canonical fixed workbench configuration)) --> <!-- @test: host/__tests__/request-router.test.js (REQ-IDE-035 AC1+AC2+AC3+AC4: root workbench configuration projection) -->

**Alternatives rejected:** Restoring extension-owned confirmation or notifications would duplicate and bypass the native lifecycle; reopening the document would preserve the identity mismatch; forcing an authority in the Pi extension would fight the host's URI transformer; suppressing the side-group tab would hide an invalid editing entry; changing Worker routing lacks evidence; and patching code-server or Code OSS violates the owned-source boundary.

**Consequences:** Renderer models and remote-extension-host edits now converge on one main-thread URI while the clean public route and fixed workspace remain unchanged. The packaged-image smoke and host seam tests exercise the real code-server placeholder/public-authority split. Deployment and CI can prove packaging only; a fresh integration session must still prove one editor tab, localized diff/status, native Keep, immediate follow-up, native Undo, another immediate follow-up, and no missing-document error.

### AD131: Inline diagnostics retain only sanitized resource identity

**Category:** Architecture, Security, Operations

**Status:** Accepted (2026-08-16). Supersedes [AD129](#ad129-proxied-inline-uri-identity-must-be-observed-before-lifecycle-changes) after its exact-URI evidence gate completed. Implements [REQ-IDE-034](../../sdd/spec/browser-ide.md#req-ide-034-bounded-inline-lifecycle-diagnostics) AC6.

**Context:** AD129 intentionally captured exact invoking, streamed, and tab URIs for one bounded integration probe. That evidence exposed the hidden remote-authority mismatch and enabled AD130's correction. Keeping exact URIs afterward no longer served the investigation: filesystem directories, URI userinfo, query values, fragments, and arbitrary tab labels could enter local diagnostic output and then be copied into support material.

The diagnostic channel still needs enough identity to distinguish a stale image, the wrong invocation surface, and an authority mismatch. Scheme, authority, basename, and stable input type supply that evidence without retaining the full resource location. A basename can collide across directories, so matching sanitized identities is supporting evidence rather than proof that two resources are equal.

**Decision:** Diagnostic revision v2 retains only scheme, authority with userinfo removed, basename, and stable input type for request, stream, and tab identities. It records no directory path, query, fragment, tab label, or document content. The existing local-only channel, event and line bounds, delayed snapshots, and deterministic disposal remain unchanged. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::describeUri --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::describeTab --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) -->

**Alternatives rejected:** Retaining exact URIs after the evidence gate would preserve unnecessary support-data exposure; removing diagnostics would discard useful rollout and authority evidence; hashing the whole URI would hide the authority needed for classification; and adding a configurable full-URI mode would recreate the same exposure behind another setting.

**Consequences:** Operators can compare sanitized scheme, authority, basename, and input type but must treat basename collisions as inconclusive. AD129 remains the immutable historical record of the exact-URI probe; AD131 owns all retained diagnostic identity after that probe.

### AD132: User extensions are a bounded manifest over an immutable base inventory

**Category:** Architecture, Security, Storage, Build / Container

**Status:** Accepted (2026-08-17). Amends [AD95](#ad95-browser-ide-is-session-isolated-the-deliberate-opposite-of-the-bucket-stable-vault), [AD119](#ad119-replace-openvscode-with-pinned-code-server-behind-the-existing-session-proxy), and [AD120](#ad120-browser-ide-uses-fixed-public-workspace-selection-and-exported-ui-state-continuity). Implements [REQ-IDE-036](../../sdd/spec/browser-ide.md#req-ide-036-persistent-user-managed-extensions), [REQ-IDE-037](../../sdd/spec/browser-ide.md#req-ide-037-lazy-extension-restoration), [REQ-IDE-038](../../sdd/spec/browser-ide.md#req-ide-038-extension-warning-acknowledgement), and [REQ-IDE-040](../../sdd/spec/browser-ide.md#req-ide-040-user-extension-allowance-policy).

**Context:** The pinned code-server workbench already exposes Open VSX install, update, and uninstall, but Codeflare launches it directly against one image-owned Pi, Claude, or empty extension directory. Those roots and all live User/extension state are ephemeral, while R2 admits only `~/.codeflare/ide-ui-state.json`. A user install can therefore affect one live container yet disappears on replacement. Persisting raw extension trees or code-server User data would copy hundreds of MiB, mutable registries and databases, credentials, SecretStorage, global/workspace state, logs, and unsafe WAL/SHM files into newest-wins bisync.

Pinned-source and exact-runtime evidence for code-server 4.132.0 established a smaller boundary: the workbench can install an exact `id@version` after startup, fresh installs register live, uninstall updates the on-disk registry before the extension API, and symlink-seeded fixed extensions coexist with real user directories. Every prepared profile receives the supported `extensions.allowed` wildcard plus one explicit Codeflare entry. <!-- @impl: openvscode/claude/managed-settings.mjs::buildBaseOpenVscodeSettings -->

**Decision:** Keep Pi, Claude, and unsupported selections as immutable base inventories. For each container, seed one writable `/tmp` session extension directory with symlinks to the selected base and pass only that directory to code-server. The built-in `codeflare-welcome` extension lazily restores missing user extensions after `onStartupFinished`, so initial code-server readiness and agent selection remain unchanged.

**Amendment (2026-08-25):** The writable session extension directory now lives under `/run/codeflare/openvscode/data/extensions`. It remains container-local and unsynced while surviving disposable `/tmp` cleanup. <!-- @impl: entrypoint.sh::_openvscode_extensions_dir -->

Persist one atomic mode-0600 `~/.codeflare/ide-extensions.json` file through the existing rclone allowlist. A shared policy defines the 64 KiB envelope, 50-extension ceiling, fixed IDs, version/platform/timestamp/hash bounds, and settings limits for both TypeScript and the Python reap backstop. The manifest stores canonical lowercase IDs, exact versions, optional audit metadata, contributed global User settings excluding managed/UI-continuity keys, and one durable `securityWarningShown` acknowledgement. It stores no VSIX or extracted package bytes.

Treat the disk registry plus `.obsolete` as capture truth: normalize registry IDs, exclude fixed identities, add/update present user extensions, and remove a manifest entry only when a bounded obsolete marker proves uninstall, even if the registry still carries a stale row. This distinction preserves user intent when an exact gallery version is temporarily unavailable. Malformed, redirected, oversized, uppercase, or unknown manifest content is retained byte-for-byte and disables capture for that session. Restored intent cannot execute until the durable security warning is accepted. Exact-version restore recognizes structured not-found errors, attempts one unpinned fallback, continues other installs with concurrency two, applies contributed settings after extension registration, and emits one bounded failure warning without a retry loop.

Registry, extension-host, and contributed-setting changes debounce one in-session capture. Welcome deactivation flushes a pending setting capture; a post-reap Python capture closes the remaining registry debounce race while preserving settings and warning acknowledgement. A changed atomic write sends `SIGUSR1` only to the existing sync daemon; cadence, Sync-now, coalescing, and final drain remain the sole R2 ownership. Whole-file newest-wins across concurrent sessions is explicit and unchanged.

**Alternatives rejected:** Syncing live `--extensions-dir` or `--user-data-dir` violates the credential/state boundary and creates thousands of mutable R2 objects. Mutating the fixed `/opt` directory weakens managed inventory identity. Persisting hashed VSIX artifacts, content-addressed storage, rollback generations, or a Durable Object registry adds a byte store and coordinator that v1 does not need. Pre-launch gallery installation delays lazy readiness. Direct R2 writes or another sync worker duplicate established ownership. Browser automation, Chromium, and manual validation are not feature gates; deterministic package, shell, registry, and complete-image CI own verification.

**Consequences:** User extensions execute arbitrary root-capable code inside the session container and receive code-server's inherited proposed-API posture. Open VSX availability and TLS are runtime dependencies; code-server disables VSIX signature verification, and the workbench path does not expose bytes for Codeflare hashing. Enablement state, private VSIX persistence, extension storage/Secrets/Accounts, secondary downloads, keybindings, snippets, multi-writer serialization, and artifact rollback remain out of scope. The unsupported base inventory remains empty even when the user layer restores ordinary extensions, and fixed package bytes remain unchanged across install, update, and uninstall.

---

### AD133: ADR indexes use bounded self-contained summaries

**Category:** Process

**Status:** Accepted (2026-08-17)

**Context:** The decision index exposed stable IDs, titles, and categories but forced readers to open each ADR to learn the chosen mechanism, its driver, its consequence, or whether only part remained active. A longer Decision cell obscures the label, while separate Outcome and Why columns make the ledger too wide. <!-- @impl: preseed/agents/claude/skills/doc-enforce-shape/scripts/check-shape.mjs::scanDecisions -->

**Decision:** Use `ID | Decision | Summary | Category | State`. Decision is a label of at most 90 rendered characters. Summary is one sentence of 40–180 rendered characters that names the concrete subject and choice plus a body-supported driver or operational consequence. Historical summaries link their successor, retained scope, or redirect destination.

**Alternatives considered:** Expand the Decision cell to one long sentence; split Outcome and Why into separate columns; add a Related column containing unexplained identifiers; enforce only numeric limits without semantic review.

**Consequences:** The index is wider than the former three-column table but each row can be understood independently. Deterministic checks enforce shape and measurable limits; documentation review verifies body support, clarity, and preserved trade-offs. Existing ADR bodies and stable anchors remain unchanged.

**Related requirements:** [REQ-AGENT-146](../../sdd/spec/agents.md#req-agent-146-self-contained-adr-decision-index-summaries)

---

### AD135: Inline Chat requires one host-correlated result

**Category:** Architecture, Security

**Status:** Accepted (2026-08-18). Supersedes AD127 only where it required an edit-only proposal tool and model-repeated request correlation; host-owned text-edit validation remains active. Partially superseded by [AD137](#ad137-inline-chat-is-edit-first-and-responses-support-is-explicit), which replaces the informational no-change rationale and Chat-Completions-only provider scope; the one-result envelope and host correlation remain active. Implements [REQ-IDE-025](../../sdd/spec/browser-ide.md#req-ide-025-shared-ide-pi-surface-isolation), [REQ-IDE-029](../../sdd/spec/browser-ide.md#req-ide-029-native-inline-chat-feedback), [REQ-IDE-030](../../sdd/spec/browser-ide.md#req-ide-030-native-inline-chat-result-envelope), and [REQ-IDE-043](../../sdd/spec/browser-ide.md#req-ide-043-native-pi-provider-history-isolation).

**Context:** Kimi-K2.6 behind the enterprise OpenAI-compatible dynamic route received a large shared-conversation request with two tools, optional tool choice, and an edit-only contract. It could emit reasoning without a tool call, causing settlement to fail with no proposal. A separate call copied the host request identifier incorrectly, even though that model-visible value was not a security boundary. Informational prompts also had no truthful successful outcome except fabricating an edit.

**Decision:** Inline mode exposes `codeflare_submit_inline_result` with one flat `{ outcome, summary, edits }` envelope. `edit` requires bounded validated edits; `noChange` requires an empty edit list and renders its summary without invoking the host text-edit API. The model does not receive the host request identifier. The backend binds the accepted result to its active process generation, serialized turn, command state, expected tool, and one-result guard.

While Inline mode is active, Pi receives a minimal dedicated system prompt and only the current Inline turn suffix, including tool-validation feedback needed for a bounded retry; stored panel conversation remains unchanged. For the observed OpenAI Chat Completions payload, the final request retains only the result tool, selects it exactly, and disables parallel calls. Unknown provider payload shapes remain unchanged rather than receiving guessed syntax. Panel turns recover their exact prior tools at settlement.

**Alternatives rejected:** Prompt-only encouragement, because the failing model already understood but did not follow the optional transaction; accepting arbitrary model request IDs, because it weakens correlation without adding ownership; forcing an edit-only tool for informational requests, because it encourages fabricated changes; session-global thinking changes, completion caps, custom providers, and speculative multi-provider payload rewriting, because none is required to fix the evidenced failure and each adds shared-state or compatibility risk.

**Consequences:** Every supported dynamic-route Inline turn must settle through one edit or no-change result, and stale generations or duplicate results still fail closed. Persistent panel history no longer inflates Inline provider requests but remains available on the next panel turn. Large legitimate edits retain the provider's existing output ceiling; latency is improved through forced settlement and context isolation, with completion caps deferred until measured integration evidence requires one.

---

### AD136: Managed environments reconcile signed releases before session start

**Category:** Architecture, Security, Storage, Supply Chain

**Status:** Accepted (2026-08-18; extended 2026-08-22). Implements [REQ-SETUP-013](../../sdd/spec/setup.md#req-setup-013-managed-environment-configuration), [REQ-SETUP-014](../../sdd/spec/setup.md#req-setup-014-managed-repository-credential-boundary), [REQ-AGENT-147](../../sdd/spec/agents.md#req-agent-147-signed-managed-agent-configuration-releases), [REQ-AGENT-148](../../sdd/spec/agents.md#req-agent-148-protected-managed-release-publication), [REQ-AGENT-149](../../sdd/spec/agents.md#req-agent-149-shared-compiler-cli-compatibility), [REQ-AGENT-150](../../sdd/spec/agents.md#req-agent-150-independent-managed-release-activation-validation), [REQ-AGENT-154](../../sdd/spec/agents.md#req-agent-154-build-compatible-managed-release-discovery), [REQ-AGENT-151](../../sdd/spec/agents.md#req-agent-151-bounded-managed-release-streaming), [REQ-STOR-020](../../sdd/spec/storage.md#req-stor-020-managed-environment-reconciliation), [REQ-STOR-021](../../sdd/spec/storage.md#req-stor-021-managed-content-ownership), [REQ-STOR-022](../../sdd/spec/storage.md#req-stor-022-managed-reconciliation-admission), [REQ-STOR-023](../../sdd/spec/storage.md#req-stor-023-managed-release-status-and-discovery), [REQ-STOR-024](../../sdd/spec/storage.md#req-stor-024-managed-release-application), [REQ-IDE-042](../../sdd/spec/browser-ide.md#req-ide-042-additive-company-extension-reconciliation), [REQ-IDE-044](../../sdd/spec/browser-ide.md#req-ide-044-exact-company-vsix-verification), [REQ-IDE-045](../../sdd/spec/browser-ide.md#req-ide-045-company-extension-reconciliation-orchestration), and [REQ-IDE-046](../../sdd/spec/browser-ide.md#req-ide-046-session-local-company-vsix-installation).

**Context:** Codeflare already compiles one manifest-driven agent seed, writes it to each user's R2 bucket with provenance metadata, detects image-hash drift during dashboard load, blocks session creation while reconciliation runs, and restores R2 before agent startup. <!-- @impl: scripts/agent-seed-core.mjs::compileAgentSeed --> <!-- @impl: src/routes/session/lifecycle.ts::default -->

A separate container-start downloader would duplicate transformation, trust, state, and failure machinery at the most fragile lifecycle seam. It could also change a shared bucket while another session syncs it. Operators need one deployment-level source for company agent configuration and exact Browser IDE extension requirements without rebuilding Codeflare for each content release. <!-- @impl: src/lib/remote-curation.ts::resolveManagedEnvironmentRelease -->

**Decision:** Expose a deployment-level Setup section named **Managed environment** in every deployment mode. It references one private GitHub release repository, an encrypted repository-scoped read PAT, and an Ed25519 public key. A shared side-effect-free compiler produces default and advanced documents through the image-seed transformations. <!-- @impl: src/routes/setup/index.ts::default --> <!-- @impl: scripts/agent-seed-core.mjs::compileAgentSeed -->

The private repository is the runtime master for curated content; Codeflare's baked preseed is an independent fallback and is not synchronized from private releases. Codeflare owns the shared compiler and runtime ABI, so compiler changes land here before advancing the private repository's literal commit pin. See [REQ-AGENT-147](../../sdd/spec/agents.md#req-agent-147-signed-managed-agent-configuration-releases).

The private one-trigger workflow independently rebuilds bytes, signs only that artifact inside a dedicated deployment environment that scopes the signing key and release-write permission, rechecks exact draft release and asset identities and digests, and publishes immutable monotonically sequenced assets by release ID. Approval enforcement on that environment is deployment configuration rather than workflow behaviour. Production activation requires the protected-environment acceptance in [REQ-AGENT-148](../../sdd/spec/agents.md#req-agent-148-protected-managed-release-publication).

The Worker is the trust boundary. It conditionally checks GitHub and searches at most ten 100-record release-history pages for the first release matching the deployed runtime hash. A hash mismatch continues the scan; any other managed-release validation failure stops it. Verification covers repository identity, immutable metadata, asset digests, signature, sequence, schema, paths, bounds, seed ABI, runtime hash, and extension records. <!-- @impl: src/lib/remote-curation.ts::resolveManagedEnvironmentRelease -->

Verified content-addressed bytes live in one deterministic deployment R2 bucket under `releases/<digest>/`. Each trust configuration advances monotonically within a runtime dependency set and may replace a globally newer incompatible pointer. A repository-stable conditional pointer records the authoritative selection; a losing concurrent signing-key change performs bounded KV repair and fails explicitly if the pointer does not settle. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment -->

Setup primes a new namespace before committing the KV configuration that selects it, so failed credential, repository, or signing-key replacement cannot move the prior pointer. GitHub and cache failure retain the last verified release. An enabled configuration without GitHub availability or a verified last-known-good release blocks new reconciliation rather than substituting baked content, while already-applied buckets remain unchanged. Credentials, signing material, and release transport never enter a user bucket or container. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment -->

The fixed seed-v1 resource boundary is shared by compiler and Worker: <!-- @impl: scripts/agent-seed-release-limits.mjs::MANAGED_RELEASE_LIMITS --> 8 MiB compressed, 32 MiB expanded, 5,000 documents, 1 MiB per document, 24 MiB aggregate document content, 512 UTF-8 bytes per path, 5,000 retired paths, 20 managed extensions, 128 MiB per VSIX, 256 MiB aggregate VSIX bytes, and one HTTPS redirect.

The existing dashboard upgrade path compares the already-verified active release descriptor plus the user's resolved mode with applied state without re-expanding an unchanged payload; the existing five-minute resolver verifies and caches the newest release compatible with that deployment once. <!-- @impl: src/lib/managed-release-active.ts::getActiveManagedRelease --> <!-- @impl: src/routes/session/lifecycle.ts::default --> With no owning session it reports UPGRADING and calls the existing agent-config reconcile route. While any session owns the bucket it reports UPDATE PENDING, leaves that session unchanged, and blocks another start until the final owner stops.

A `sessionMode` preference change enforces this update-pending gate only when a managed release has ever been applied or is currently active; an unconfigured deployment's plain sessionMode change is unaffected. When a managed environment is involved, a failed auto-reconcile on that change propagates as an error instead of being logged and swallowed, and the pre-request preference document is restored so the retry reconciles rather than short-circuiting. <!-- @impl: src/routes/preferences.ts::default -->

Reconciliation reads one cached gzip, validates it without retaining the full expanded release, streams the same bytes through at most six concurrent writes, writes one company extension manifest, deletes an obsolete key only when its prior release marker still proves company ownership, completes required image-owned context-mode reconciliation, and stamps applied state last. Disabling the feature converges through the same path back to the baked image hash. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->

Container startup remains R2-first. A narrow active flag plus the exact applied release digest skips Governed image pre-laydown and the image Pi extension relay only while a verified managed release is active and binds restored company-extension metadata to that release. Initial restore, transcript retention before initial PTY release and outbound bisync, hook executable repair, agent startup, and sync ownership remain unchanged. <!-- @impl: entrypoint.sh::relay_managed_pi_extensions -->

Browser IDE settings add explicit company IDs without removing the wildcard personal-extension policy. After workbench readiness, exact verified VSIX bytes are downloaded to a bounded temporary file, checked by size and SHA-256, installed before the unchanged personal restore, and deleted. Company IDs absent from the active manifest are uninstalled before any saved personal version is restored. A failed uninstall remains company-protected, is reported, and retries on the next reconciliation; VSIX bytes never enter R2. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::reconcileCompanyExtensions --> <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::activateExtensionPersistence -->

**Alternatives rejected:** Per-start repository cloning or signature verification duplicates Worker trust and delays every session. A webhook, queue, D1 database, Durable Object coordinator, daemon, or second polling loop adds machinery the existing dashboard refresh and R2 cache do not need. Persisting VSIX bytes or complete extension trees expands the secret and mutable-state boundary. Mutating a shared bucket while a session runs risks bisync conflict. Treating curated paths as permanently immutable would contradict current user-editable seed semantics and attempt to defend against a root user inside their own container.

**Consequences:** Managed content can change independently of a Codeflare image while mode entitlement and all non-curated behavior remain unchanged. The design deliberately provides weaker per-start self-healing than an immutable materializer: a user edit drops provenance and survives until a later release owns that path again. Availability fails open only to the last verified state for the same runtime dependency set or to already-applied user content, while invalid and incompatible candidates never activate. Operators must protect release immutability and the signing key, publish updates through higher sequences, and publish rollback as a new immutable release rather than mutating history.

---

### AD137: Inline Chat is edit-first and Responses support is explicit

**Category:** Architecture, Security

**Status:** Accepted (2026-08-20). Partially supersedes [AD135](#ad135-inline-chat-requires-one-host-correlated-result) where it treated informational prompts as a general `noChange` path and limited exact provider-tool forcing to observed Chat Completions payloads. AD135's one-result envelope, host correlation, and validation remain active. Implements [REQ-IDE-025](../../sdd/spec/browser-ide.md#req-ide-025-shared-ide-pi-surface-isolation), [REQ-IDE-027](../../sdd/spec/browser-ide.md#req-ide-027-native-pi-panel-reasoning-and-bounded-progress), and [REQ-IDE-030](../../sdd/spec/browser-ide.md#req-ide-030-native-inline-chat-result-envelope).

**Context:** Terse editor change requests could still settle as informational `noChange` results because the shared prompt left that outcome to model discretion. Structurally recognized OpenAI Responses payloads carry a reasoning-summary selection that the extension can make explicit. The existing host-owned result envelope remains correct. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::requestSidebarReasoningSummary --> <!-- @test: host/__tests__/pi-inline-edit-mode.test.js (REQ-IDE-025: inline result mode isolates provider tools and context then restores panel tools) --> <!-- @test: host/__tests__/pi-inline-edit-mode.test.js (REQ-IDE-027: sidebar panel requests ask OpenAI Responses models for visible reasoning summaries) -->

**Decision:** Frame every editor Inline invocation as a requested document change. Reserve `noChange` for an already-satisfied request or one for which no valid safe edit can be produced. Structurally recognized OpenAI Chat Completions and Responses payloads expose and select only `codeflare_submit_inline_result` with parallel tool calls disabled. Browser IDE panel Responses requests select provider-authored detailed reasoning summaries; payloads without that Responses reasoning shape, including Qwen, remain unchanged. Only provider summaries reach native thinking UI. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::constrainInlineOpenAiPayload --> <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::requestSidebarReasoningSummary -->

**Alternatives rejected:** A prompt classifier, retry loop, direct file writes, Code OSS fork, speculative provider fallback, raw chain-of-thought exposure, or Qwen payload rewrite adds machinery or changes established behavior without addressing the evidenced boundaries proportionally.

**Consequences:** Brief source-change requests should produce host-owned proposals consistently while truthful safe exceptions remain available. Provider forcing still fails open for unknown payload structures rather than guessing syntax. The stochastic edit-first outcome requires deployed repeated-request evidence in addition to deterministic payload, tool, settlement, and publication tests. The signed curated runtime and independent image fallback carry the same extension behavior.

---

### AD138: context-mode is on by default in Pi

**Category:** Agents, Architecture, Reliability

**Status:** Superseded by [AD140](#ad140-pi-starts-context-mode-off-and-exposes-optional-tool-schemas-on-demand) (2026-08-24). Previously accepted 2026-08-22 and superseded [AD107](#ad107-context-mode-is-opt-in-in-pi-pending-upstream-memory-safety).

**Context:** Codeflare now clears inherited process-wide bridge-idle overrides before context-mode initializes and retains [AD101](#ad101-context-mode-is-foreground-owned-in-pi-in-process-subagents-use-native-transports)'s single foreground owner. In-process reviewers, CI monitors, and capture workers continue using native transports and cannot create competing bridges. The user chose context-mode as the default Pi experience after operating the managed adapter explicitly. The upstream package remains exact-pinned without lifecycle or ownership patches; the existing ESM-compatibility and update-probe transforms remain limited to image construction. The remaining long-lived-process risk does not justify making every fresh session opt in again. <!-- @impl: preseed/agents/pi/extensions/context-mode-runtime.ts::clearInheritedContextModeBridgeIdleOverride --> <!-- @impl: preseed/agents/pi/extensions/context-mode-runtime.ts::attachContextModeToForeground -->

**Decision:** On every container start, normalize the context-mode package entry to `{ source, extensions: [] }`. This keeps upstream skills enabled while filtering its package extension, because Codeflare's managed runtime bridge is the sole adapter owner. `/ctx off` remains an explicit per-container opt-out that reloads Pi; `/ctx on` restores the same managed owner. A later container start restores the enabled default. <!-- @impl: entrypoint.sh::warm_pi_npm_dependencies --> <!-- @impl: preseed/agents/pi/extensions/ctx-command.ts::handleContextModeCommand -->

**Alternatives rejected:** Preserve opt-in startup despite the user's default preference; load the upstream extension alongside Codeflare's bridge; patch or fork context-mode; or remove `/ctx off`. These respectively preserve unwanted friction, create duplicate ownership, add upgrade debt, or remove the bounded operational escape hatch.

**Consequences:** Fresh Pi sessions expose context-mode skills and `ctx_*` tools immediately. The managed foreground owner, idle-policy reset, exact pin, and native subagent transports remain unchanged. Users can disable context-mode for the current container, but restart returns to the managed enabled state.

**Related REQ:** [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults), [REQ-AGENT-089](../../sdd/spec/agents.md#req-agent-089-pi-context-mode-foreground-ownership), [REQ-AGENT-096](../../sdd/spec/agents.md#req-agent-096-on-demand-pi-tool-activation), [AD101](#ad101-context-mode-is-foreground-owned-in-pi-in-process-subagents-use-native-transports).

---

### AD139: Pi skill discovery uses one compiler-generated compact index

**Category:** Agents, Architecture, Performance

**Status:** Accepted (2026-08-23).

**Context:** Pi's native model-visible skill catalog repeats XML framing and absolute paths for every skill. That representation dominated the measured provider-boundary prompt even after descriptions and permanent policy were compressed. Removing skill files or maintaining a second routing registry would reduce bytes by weakening discovery or creating a source that can drift from the actual source-root projection. <!-- @impl: scripts/verify-pi-prompt.mjs::verifyPiProjection -->

**Decision:** The shared seed compiler derives a deterministic `name — purpose` index from each final source root after mode resolution and appends it to that mode's generated Pi `AGENTS.md`. Every model-invocable indexed name maps to the conventional `~/.pi/agent/skills/<name>/SKILL.md` path. The compiler then suppresses duplicate native XML entries without deleting skill documents or changing explicit `/skill:name` invocation. Skills already restricted to explicit user, command, event, or reviewer invocation remain installed but absent from the model-invocable index. Codeflare's public fallback and codeflare-curation's managed source each generate their own index through the same pinned compiler; no generated index synchronizes between repositories. <!-- @impl: scripts/agent-seed-core.mjs::finalizePiSkillIndex -->

**Alternatives rejected:** Patch Pi's XML formatter; add a runtime search tool or persistent registry; maintain content-router tables; delete optional skills; synchronize a generated public index into curation; or raise the prompt cap. These add runtime machinery, duplicate inventory ownership, lose capabilities, omit curated content, or abandon the reduction goal.

**Consequences:** The source manifests and skill files remain authoritative and composable. Inventory or mode changes automatically change the matching index, duplicate names and missing conventional paths fail compilation, and package-owned skills may retain native discovery independently. Default and advanced prompt projections remain measurable without transferring prompt prose into tool schemas.

**Related REQ:** [REQ-AGENT-156](../../sdd/spec/agents.md#req-agent-156-bounded-lossless-pi-prompt).

---

### AD140: Pi starts context-mode off and exposes optional tool schemas on demand

**Category:** Agents, Architecture, Performance

**Status:** Accepted (2026-08-24). Supersedes [AD138](#ad138-context-mode-is-on-by-default-in-pi).

**Context:** The compact skill index reduced the managed Advanced prompt projection from 32,416 to about 12,417 characters, but a fresh production `hi` request still rose from roughly 8,477 to 11,256 input tokens. Provider-boundary evidence separated the successful prompt reduction from active tool schemas: enabling context-mode on every fresh container registered its bridge tools, while capability filtering ran too early to contain later registrations. A tool installed in Pi costs no provider tokens until Pi marks it active and serializes its description and parameter schema.

**Decision:** Fresh container startup writes context-mode's disabled package marker while retaining its exact package, image patches, JITI cache, data, and managed foreground-owner path for explicit `/ctx on`. A dedicated `/ctx` command extension reaches Standard and Advanced without broadening advanced Codeflare commands. At each new user prompt, after context-mode's lazy bridge registration and before provider serialization, the schema-free finalizer selects only `read`, `bash`, `edit`, `write`, and `capability`; registered optional tools remain searchable and activate additively for the next model step. Subagent activation includes its result and steering controls, and a schema-free local hook blocks resume attempts for queued or running records through the package's public service. Registered and active schema sizes remain separate diagnostics rather than a fixed promotion threshold. <!-- @impl: entrypoint.sh::warm_pi_npm_dependencies --> <!-- @impl: preseed/agents/pi/extensions/zz-tool-exposure-finalizer.ts::finalizeToolExposure --> <!-- @impl: preseed/agents/pi/extensions/ctx-command.ts::handleContextModeCommand --> <!-- @impl: preseed/agents/pi/extensions/subagent-resume-guard.ts::subagentResumeGuard -->

**Alternatives rejected:** Remove tools or skills; patch Pi; patch package-owned descriptions; keep context-mode active but hide only some of its tools; impose a fixed provider-token gate; or reintroduce shared-preseed synchronization. These lose functionality, add upgrade debt, leave avoidable startup work, create brittle limits, or violate repository ownership.

**Consequences:** Optional tools add schema cost only after selection. `/ctx on` pays context-mode startup cost only for containers that request it, and `/ctx off` or a new container restores the disabled state. Codeflare-curation remains the complete managed source while Codeflare carries an independent embedded fallback and image/runtime ownership. Existing subagent max-turn behavior is unchanged.

**Related REQs:** [REQ-AGENT-076](../../sdd/spec/agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults), [REQ-AGENT-156](../../sdd/spec/agents.md#req-agent-156-bounded-lossless-pi-prompt), [REQ-AGENT-158](../../sdd/spec/agents.md#req-agent-158-bounded-initial-pi-tool-exposure), and [REQ-AGENT-159](../../sdd/spec/agents.md#req-agent-159-active-subagent-resume-guard).

---

### AD141: Browser IDE startup follows the session workspace snapshot

**Category:** Architecture, Build / Container

**Status:** Accepted (2026-08-24). Amends [AD119](#ad119-replace-openvscode-with-pinned-code-server-behind-the-existing-session-proxy).

**Context:** AD119 retained request-lazy code-server startup for Terminal sessions. A user-selected VS Code workspace instead needs editor readiness on the dashboard and must not create an unused host browser-terminal PTY. The workspace choice is captured immutably on each session, including across later preference or entitlement changes. <!-- @impl: src/routes/session/crud.ts::app --> <!-- @impl: src/container/container-env.ts::buildEnvVars -->

**Decision:** Use the immutable session workspace snapshot to select startup. Terminal sessions keep host PTY prewarm and request-lazy code-server startup. VS Code sessions skip host PTY creation, arm the existing code-server supervisor after initialization, and expose bounded editor readiness through the existing startup-status path. A preserved VS Code session continues using this lifecycle after the user's future default returns to Terminal or Standard mode. <!-- @impl: entrypoint.sh::complete_managed_curation_startup --> <!-- @impl: host/src/workspace-readiness.ts::startWorkspaceServices --> <!-- @test: host/__tests__/entrypoint-openvscode.test.js (complete_managed_curation_startup / REQ-IDE-048 AC3 (eager workspace launch)) --> <!-- @test: host/__tests__/workspace-readiness.test.js (REQ-IDE-048 AC3: host workspace startup selection) -->

**Alternatives rejected:** Create both a browser-terminal PTY and code-server for every session; infer workspace from mutable `SESSION_MODE`; migrate existing VS Code sessions on downgrade; add a second editor process owner; or open the editor asynchronously from dashboard polling.

**Consequences:** VS Code sessions become editor-ready without duplicate host PTYs, while Terminal startup remains unchanged. Startup status has workspace-specific readiness semantics, and restart must clear stale editor readiness before a replacement container begins warming.

**Related REQs:** [REQ-IDE-003](../../sdd/spec/browser-ide.md#req-ide-003-ide-lifecycle-and-availability), [REQ-IDE-047](../../sdd/spec/browser-ide.md#req-ide-047-bash-first-browser-ide-terminals), and [REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions).

---

### AD142: Review ingress is delivery-only and completion is joint

**Category:** Agents, Architecture, Build / Container

**Status:** Accepted (2026-08-26). Supersedes [AD121](#ad121-a-review-boundary-is-a-delivery-subcommand-not-any-git-invocation).

**Context:** AD121 kept every executable Git or GitHub command as a review candidate and treated merge as delivery. That breadth moved coverage during ordinary inspection, while one-shot GitHub lookup and pre-delivery launch state made real push and PR-create boundaries easy to miss. Reviewer completion also advanced independently from exact-head CI, so the visible triage could omit terminal CI evidence.

**Decision:** Automatic ingress is limited to successful executable `git push` and `gh pr create`. Successful clone is the only consent boundary and applies to the checkout that command produced. Ordinary Git/GitHub activity and `gh pr merge` are inert for review ingress; the mutation guard may still block merge while triage is pending. GitHub remains authoritative for the open protected-base PR, branch, and exact head.

Reviewer calls start together and exact-head CI starts immediately afterward. Acknowledgement and FIX wait for every required reviewer, terminal CI success, failure, or timeout, and one later joint triage table. Failure and timeout require a dedicated `Exact-head CI` row with the exact matching `CI_RESULT` token. Delivery reconciliation retries immediately and then after 1, 3, 5, 10, and 15 seconds. Goal pause ownership, head drift, closure, bypass, and reload recovery retain their existing lifecycle.

**Consequences:** Read-only commands cannot open or move a review round. A clone command cannot borrow consent state from another target in the same tool call. Each Pi reviewer prompt names its temporary report path, and CI evidence is correlated with the exact launched monitor before acknowledgement. Claude queries CI by commit SHA, so Git branch text never enters the monitor command.

**Related REQs:** [REQ-AGENT-036](../../sdd/spec/agents.md#req-agent-036-pr-boundary-review-trigger-conditions), [REQ-AGENT-080](../../sdd/spec/agents.md#req-agent-080-unified-pi-pr-boundary-launch-plan), [REQ-AGENT-098](../../sdd/spec/agents.md#req-agent-098-pi-review-triage-acknowledgement-barrier), [REQ-AGENT-121](../../sdd/spec/agents.md#req-agent-121-checked-out-branch-boundary-synchronization), and [REQ-AGENT-132](../../sdd/spec/agents.md#req-agent-132-pr-delivery-and-existing-head-consent).

<!-- @impl: preseed/agents/pi/extensions/review-helpers.ts::classifyReviewBoundaryCommand -->
<!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::reviewerOutputPath -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh::ci_completion_line_for_current_head -->

---

### AD143: Strict R2 interception signs only with the bound user's scoped credential

**Category:** Architecture, Security

**Status:** Accepted (2026-08-26). Supersedes [AD87](#ad87-egresscontroller-re-signs-own-account-r2-container-holds-a-placeholder-key-bridges-websocket-upgrades-and-resolves-strict-via-props) only for R2 signer authority and [AD13](#ad13-per-user-scoped-r2-tokens) only for strict-mode container delivery.

**Context:** AD13 created one Object Read and Write token scoped to each user's exact bucket. AD87 later removed real R2 credentials from strict-mode containers, but its first implementation re-signed intercepted requests with deployment-wide Worker credentials. Account-host validation did not preserve the per-user bucket boundary, so strict interception widened data-plane authority while claiming to contain it.

**Decision:** The Container Durable Object passes its existing memory-only scoped credential and bound bucket to `EgressController` through Worker-side props. Path-style and virtual-hosted own-account R2 requests must identify that exact bucket. Another bucket or missing scoped credentials fails before any upstream send. The controller constructs its signer only from the scoped pair and never falls back to deployment-wide R2 credentials. Each validated restart payload restores the memory-only pair before interception wiring after a Durable Object wake.

Placeholder credentials remain inside the strict container. Streaming request bodies, SSE-C headers, Governed Mode, account-scoped direct routing, WebSocket bridging, and strict state resolved through props remain as AD87 decided.

**Consequences:** Strict interception retains AD13's user-bucket authority without exposing the usable credential to root inside the container. Durable Object reconstruction depends on the existing start payload to restore credentials in memory; a missing pair fails closed instead of silently acquiring broader authority.

**Related REQs:** [REQ-SEC-003](../../sdd/spec/security.md#req-sec-003-per-user-r2-tokens-scoped-to-user-bucket), [REQ-ENTERPRISE-023](../../sdd/spec/enterprise-mode.md#req-enterprise-023-strict-gateway-egress-controller-transport).

<!-- @impl: src/container/container-interception.ts::strictEgress -->
<!-- @impl: src/container/container-router.ts::dispatchInternalRoute -->
<!-- @impl: src/egress-controller.ts::EgressController -->

---
