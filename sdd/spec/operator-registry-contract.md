# Operator Registry contract

Frozen before the RED batch. This is the smallest shared contract; implementations may add private helpers but may not add authority, execution backends or public behavior outside it.

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

| Method and route | Body / result |
|---|---|
| `GET /api/operator-management/operators` | filtered catalog; query `cursor`, `limit`, `query`, `profile`, `realm`, `state` |
| `POST /api/operator-management/operators` | `{ repositoryUrl, githubPat, profile, realm, managers, invokers, policy }` → disabled operator projection |
| `GET /api/operator-management/operators/:operatorId` | operator, releases, installations and grants, never PAT/ciphertext |
| `POST /api/operator-management/operators/:operatorId/releases/refresh` | `{ revision }` → discovered releases only |
| `POST /api/operator-management/operators/:operatorId/installations` | `{ name, policy, revision }` → disabled installation |
| `POST /api/operator-management/installations/:installationId/promote` | `{ releaseId, revision }` → approved pinned disabled installation |
| `POST /api/operator-management/installations/:installationId/enable` | `{ revision, enabled }` → installation |
| `POST /api/operator-management/operators/:operatorId/grants` | `{ managers, invokers, revision }` → operator projection |

Outcomes use existing error envelope conventions: validation 400, unauthenticated 401, denied/non-enumerating 404, conflict 409, unavailable/upstream failure 503. No public endpoint accepts human identity, resource IDs, source credentials, publisher authority or arbitrary artifact URLs.

## Parent capability operations

The platform derives identity, input digest, release, installation and resource scope before loading a package. A package gets only one profile-specific fetcher:

| Profile | Capability operations |
|---|---|
| Conductor | `POST /v1/conductor/review`: prepared packet reference; `GET /v1/conductor/review/:operationId`: bounded progress; `POST /v1/conductor/review/:operationId/cancel`: owned cancellation |
| Dispatcher | `POST /v1/dispatcher/renovate`: authorized repository/PR selection; `GET /v1/dispatcher/renovate/:operationId`: bounded result/progress |

The parent rejects unknown routes, mismatched activity/generation, expired/cancelled authority, changed operation digest and capability/resource requests outside the installed policy. Dispatcher routes never create or expose a session/container. Conductor routes never accept arbitrary session IDs. Both return bounded structured outcomes; network and upstream credentials remain parent-owned.

## Package release files

Each immutable GitHub release supplies exactly `operator-manifest.json`, `operator-bundle.json` and `operator-provenance.json`. The manifest extends the existing v1 metadata with the profile, declared input/output schemas and requested capability names. The parent verifies repository identity, approved workflow/ref, source commit and asset/bundle digests before approval. Package requests never grant a capability.

## Review webhook extension

Existing start/status/result capability routes remain compatible. Add one authenticated continuation operation for an already started activity. Status is metadata-only; start/result remain single-use; continuation cannot change input, renew identity or create a second running generation.
