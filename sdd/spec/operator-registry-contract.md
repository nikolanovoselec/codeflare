# Operator Registry contract

Frozen before the RED batch; Dispatcher hosting refined after native API/source analysis on 22 September 2026. This is the smallest shared contract; implementations may add private helpers but may not add authority, execution backends or public behavior outside it.

## Records

```ts
type OperatorProfile = 'conductor' | 'dispatcher';
type OperatorRealm = 'internal' | 'external';
type OperatorGrant = { users: string[]; groups: Array<{ issuer: string; id: string }> };
type GitHubReleaseSource = {
  kind: 'github-release'; repositoryUrl: string; repositoryId: number;
  credentialConfigured: boolean; approvedWorkflow: { id: number; ref: string };
};
type OperatorRelease = {
  id: string; operatorId: string; githubReleaseId: number; sourceCommit: string;
  manifestDigest: string; bundleDigest: string; interfaceVersion: 1; approved: boolean;
};
type OperatorInstallation = {
  id: string; operatorId: string; name: string; releaseId: string | null;
  revision: number; enabled: boolean; policy: { capabilities: string[]; resourceProfileId: string | null };
};
```

Repository URL and PAT are registration input only. The PAT is write-only and is never returned. Release approval and enablement are separate. Existing endpoint registrations remain unchanged and are represented through the existing compatibility adapter.

## Management API

All routes are Enterprise-only and reauthorize server-side. Unknown fields fail validation. List results are authorization-filtered and use `{ items, cursor }` with default 50/max 100.

One admin-owned control record lives in the existing OperatorRegistry: `{ revision, managers: OperatorGrant, ceiling: { capabilities: string[], resourceProfileIds: string[] } }`. Missing controls mean revision 0 and empty grants/ceiling. Only a current verified human platform admin may read/change this record. Other managers need its explicit eligibility grant AND the operator's manager grant; request-body ACLs cannot grant global eligibility. Existing verified platform-admin management authority is preserved, but ceiling restrictions apply to everyone. A null resource profile requests no profile; other IDs and capabilities must be within the ceiling and installation policy must only narrow its operator. Recheck controls/current grants after upstream I/O and CAS the controls revision with target mutations; no separate ACL service or hierarchy.

| Method and route | Body / result |
|---|---|
| `GET /api/operator-management/access` | admin-only global management-control record |
| `POST /api/operator-management/access` | admin-only `{ revision, managers, ceiling }` → revision-CAS control record |
| `GET /api/operator-management/operators` | filtered catalog; query `cursor`, `limit`, `query`, `profile`, `realm`, `state` |
| `POST /api/operator-management/operators` | `{ repositoryUrl, githubPat, profile, realm, managers, invokers, policy }` → disabled operator projection |
| `GET /api/operator-management/operators/:operatorId` | operator, releases, installations and grants, never PAT/ciphertext |
| `POST /api/operator-management/operators/:operatorId/source` | `{ revision, repositoryUrl, githubPat }` → operator projection; source/trust change invalidates approval; PAT remains write-only |
| `POST /api/operator-management/operators/:operatorId/releases/refresh` | `{ revision }` → discovered releases only; reload detail for the new revision |
| `POST /api/operator-management/operators/:operatorId/installations` | `{ name, policy, revision }` → disabled installation |
| `POST /api/operator-management/installations/:installationId/configure` | `{ revision, policy, configuration }` → installation; configuration JSON bounded to 64 KiB |
| `POST /api/operator-management/installations/:installationId/promote` | `{ releaseId, revision }` → approved pinned disabled installation |
| `POST /api/operator-management/installations/:installationId/enable` | `{ revision, enabled }` → installation |
| `POST /api/operator-management/operators/:operatorId/grants` | `{ managers, invokers, revision }` → operator projection |

Outcomes use existing error envelope conventions: validation 400, unauthenticated 401, denied/non-enumerating 404, conflict 409, unavailable/upstream failure 503. No public endpoint accepts human identity, resource IDs, source credentials, publisher authority or arbitrary artifact URLs.

Installed invocation uses existing `POST /api/operator-activities` with `{ installationId, invocation }`, returning the existing prepared activity/start-capability envelope. The parent resolves the installation/release/profile/configuration and verifies independent invocation rights before admission. Legacy `{ operatorId, invocation }` remains for existing registrations; the alternatives are exclusive. Neither path accepts execution identity, profile or resource authority from the caller.

## Parent capability operations

The platform derives identity, input digest, release, installation and resource scope before loading a package. A package gets only one profile-specific fetcher:

| Profile | Capability operations |
|---|---|
| Conductor | `POST /v1/conductor/review`: prepared packet reference; `GET /v1/conductor/review/:operationId`: bounded progress; `POST /v1/conductor/review/:operationId/cancel`: owned cancellation |
| Dispatcher | Package-owned Flue/Renovate execution receives only activity-scoped GitHub-read and inference primitives. Existing `/v1/dispatcher/renovate` start/progress semantics select the admitted package operation; they are not a parent implementation of the model/tool loop. |

The Dispatcher production primitive wire is deliberately narrow:

- `POST /v1/dispatcher/github/read`: `{ operationId, resource: "pull-request" | "files" | "checks" }`. Repository and PR come only from the persisted invocation. The parent confirms the Renovate login/ID and observed head; file/check reads are limited to the first 100-item page and return `{ data, observedHead, truncated }`. The installation must permit `fetch`.
- `POST /v1/dispatcher/inference`: `{ operationId, input: { messages, tools?, tool_choice?, max_tokens?, temperature?, stream? } }`. The installation must permit `inference`. The parent selects only the current human default eligible route/reasoning and sends the OpenAI Chat Completions wire through `LlmInterceptor`; no child-selected model, identity, token, URL or headers are forwarded. Token output is capped at 8192; messages/tools are capped at 128/32.
- Both use `https://operator.internal`, JSON request bodies and a 64 KiB request/response ceiling. An activity retains at most 128 operation records; completed response bodies are separate bounded storage values. Lost/oversized/upstream-uncertain completion fences the lease and is never replayed. A non-null resource profile is rejected until an existing parent resource resolver supports it; this slice adds no resolver or configuration setting.
- The capability's only RPC methods are the nine pinned Agents facet schedule/list/cancel, keepalive and fiber-registration methods. Paths must name the exact Activity and fixed `dispatcher` facet. Only Flue's `__flueWakeAgentSubmissions` callback is schedulable, with bounded timing/counts; root callbacks and foreign paths are denied. Direct egress is null.

The parent rejects unknown routes, mismatched activity/generation, expired/cancelled authority, changed operation digest and capability/resource requests outside the installed policy. Dispatcher routes never create or expose a session/container. Conductor routes never accept arbitrary session IDs. Both return bounded structured outcomes; network and upstream credentials remain parent-owned.

## Package release files

Each immutable GitHub release supplies exactly `operator-manifest.json`, `operator-bundle.json` and `operator-provenance.json`. The manifest extends the existing v1 metadata with the profile, declared input/output schemas and requested capability names. The parent verifies repository identity, approved workflow/ref, source commit and asset/bundle digests before approval. Package requests never grant a capability.

## Dispatcher durable host

REQ-OPERATOR-047/048/051 extend the existing 015–018 owners, not a second lifecycle service. `OperatorActivity` owns admission, protected operation receipts and one activity-private facet containing real Flue code and isolated SQLite. Package CI builds the generated Flue Durable Object class; Codeflare selects the approved class export through Worker Loader, never arbitrary caller exports. Legacy default-entrypoint bundles remain valid. Vite is package build tooling, not a new Codeflare build pipeline.

Facets have no independent physical alarm. Reuse the pinned Agents SDK root alarm/fiber machinery in the existing Activity, with a narrowly scoped dynamic-facet/root bridge. SDK-internal resolution/init seams must be pinned and proven in the native fixture before production base-class integration. No copied scheduler, new DO namespace/migration, per-operator deployment, container, full Activity stub or unrestricted namespace binding. Bundle compatibility settings are child-specific; any parent compatibility change requires demonstrated API need and regression tests.

One durable execution lease binds generation, submission, input/release digests, expiry and state. Async Flue admission leaves that execution running; HTTP return/status polling does not commit a false `waiting`, increment generation or renew the lease. Only a persisted safe quiescent checkpoint permits explicit continuation. Each effect carries its original generation and stable operation ID/digest. Recheck current human eligibility/policy, expiry/cancellation and result generation; never upgrade stale warmed callers to current authority. Complete receipts reconcile; changed digest conflicts; unknown external completion is not replayed. Fence cancellation before signaling Flue. Alarm recovery/settlement grants no new execution authority.

The child receives only scoped read/inference and required scheduler bridge operations. It cannot select another activity/facet, invoke arbitrary parent callbacks, obtain credentials, access sessions/containers or use direct outbound networking. All resource limits remain bounded as before. Native proof must execute the actual pinned generated Flue artifact, delegated alarm/fiber work, eviction/recovery, two-activity isolation, safe continuation, stale/expired/cancelled denial and completed/uncertain operation handling. Mock capability tests are not native proof.

## Review webhook extension

Existing start/status/result capability routes remain compatible. Add one authenticated continuation operation for an already started activity. Status is metadata-only; start/result remain single-use; continuation cannot change input, renew identity or create a second running generation.
