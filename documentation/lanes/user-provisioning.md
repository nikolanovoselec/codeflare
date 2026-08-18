# User Provisioning

**Audience:** Operators, Developers

**Owns:** the transition from verified identity to a durable user record, initial provisioning state, approval/activation transitions, and offboarding handoffs.

**Does not own:** authentication proof, effective entitlement, billing policy, bucket algorithms, Access resource configuration, or frontend component composition.

## Contents

- [Provisioning State Model](#provisioning-state-model)
- [SaaS JIT Provisioning](#saas-jit-provisioning)
- [Enterprise JIT Provisioning](#enterprise-jit-provisioning)
- [Approval and Activation](#approval-and-activation)
- [Offboarding Handoff](#offboarding-handoff)
- [Compatibility and Migration](#compatibility-and-migration)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

## Provisioning State Model

Provisioning begins only after the active authentication mechanism establishes cryptographic identity. Token presence, caller-supplied email, or a sanitized bucket name is insufficient.

| State / transition | Durable authority | Observable result |
|---|---|---|
| Unknown, verified SaaS identity | `user:{normalized-email}` absent | Create pending user, then route to activation/subscription |
| Unknown, verified Enterprise identity | User absent and optional Access entry gate passes | Create Enterprise JIT user with active initial state |
| Existing user | Durable record | Preserve stored role and fields; apply request-time deployment overrides separately |
| Pending → active | Approved free/direct activation or provider-confirmed paid state | Effective entitlement permits application/session behavior |
| Any → blocked | Durable administrator/provider transition | Authentication may succeed, but active-user authorization fails |
| Offboarding | Durable user plus cleanup handoffs | Revoke credentials, destroy sessions, remove scoped storage/control state |

Bucket ownership is resolved through the strongly consistent user/bucket claim boundary before durable provisioning uses it. Storage mechanics remain in [Storage & Sync](storage-and-sync.md). <!-- @impl: src/lib/access.ts::authenticateRequest -->

<a id="jit-user-provisioning"></a>
## SaaS JIT Provisioning

1. The configured Access or session-OIDC verifier produces a normalized, verified identity.
2. The resolver checks `user:{email}` and refuses first-login persistence when verifier provenance is absent.
3. The bucket claim boundary resolves durable ownership.
4. `resolveOrProvisionUser()` creates the initial pending record when the user is unknown.
5. `requireActiveUser` prevents pending application access and routes the browser to activation/subscription. <!-- @impl: src/lib/access.ts::resolveOrProvisionUser -->

This flow is provider-independent: a verified Cloudflare Access-backed SaaS identity is eligible just as a verified GitHub OAuth identity is. Authentication mechanism details belong to [Authentication](authentication.md).

### Concurrent first login

Workers KV is eventually consistent. Simultaneous first requests may both observe no record and write the same initial state; identical writes converge, but there is no per-key serialization. Bucket authority and welcome delivery use their own stronger boundaries so duplicate first-login observations do not grant another user's storage or send repeated welcome messages.

### Welcome-delivery handoff

After successful first provisioning, a strongly serialized Timekeeper claim selects one welcome-delivery owner. The email provider receives a deterministic idempotency key. Delivery is best effort and does not roll back the durable user record; absence or failure remains observable in logs and retry ownership rather than a `welcome-sent:*` KV flag.

## Enterprise JIT Provisioning

<a id="enterprise-mode-provisioning"></a>
Enterprise provisioning runs before the SaaS branch for a verified Access identity.

1. `resolveOrProvisionEnterpriseUser()` returns an existing durable record without rewriting or downgrading it. Request-time Enterprise overrides are applied separately. <!-- @impl: src/lib/access.ts::resolveOrProvisionEnterpriseUser -->
2. For an unknown identity, the optional configured Access entry group is checked live. Unset means no additional group gate; non-membership, missing/invalid Access token, unsafe Access domain, or provider error fails closed and creates no user.
3. On admission, the durable record uses `addedBy: 'enterprise-jit'`, role `user`, initial advanced access fields, and unlimited subscription projection. No subscription/welcome flow runs.
4. Effective tier and mode resolvers force the active Enterprise behavior independently of stale stored compatibility fields.

### Existing-user preservation and admin union

A setup administrator remains a durable admin. An Enterprise admin Access group may elevate an admitted request for admin routes without persisting role changes. Entry-group and admin-group membership are a union of separate concerns: admission does not itself grant administration, and admin elevation does not rewrite stored role or session-limit role resolution. [Authentication](authentication.md#admin-authorization) owns the authorization check.

### Fail-closed outcomes

| Failure | Result |
|---|---|
| Unverified identity | Reject before lookup/provisioning side effects |
| Configured entry group and non-member | Reject; no user write |
| Access identity lookup error or unsafe domain | Treat as non-member; no user write |
| Concurrent identical JIT writes | May both write; deterministic initial state converges |
| Existing record | Return without destructive normalization |

## Approval and Activation

<a id="self-service-subscription-flow"></a>
### Pending activation

Pending users may choose the configured activation path. When Stripe is configured, every non-free paid selection uses checkout; direct `/api/auth/subscribe` does not activate those paid tiers. Free or intentionally provider-free deployment flows follow the route's configured direct behavior.

Turnstile is required only for a new subscription when the site key/secret is configured. Existing active subscribers changing plan are exempt. Missing or rejected required verification performs no provider call and no user mutation. Exact payment and entitlement behavior belongs to [Billing](billing.md); exact request/response envelopes belong to the [API Reference](api-reference.md#auth-saas-mode).

### Approval transitions

Administrator approval, provider-confirmed checkout, onboarding admission, and block/unblock actions must preserve verified identity and unrelated durable fields. A transition becomes visible through active-user middleware and effective entitlement; frontend selection alone cannot activate a user.

<a id="session-mode-authorization"></a>
### Entitlement alias

Configured tier modes, paid `subscribedMode`, stored next-session preference, downgrade policy, and Enterprise override are owned by [Billing](billing.md#concurrent-session-and-mode-gates). When an administrator assigns `advanced`, `max`, or `unlimited`, source may initialize `sessionMode: 'advanced'`; that preference does not bypass effective entitlement. <!-- @impl: src/routes/users.ts::app -->

## Offboarding Handoff

**Requirement:** [REQ-SETUP-013 AC5](../../sdd/spec/setup.md#req-setup-013-managed-coding-environment-configuration)

Managed coding-environment Setup is deployment configuration, not an entitlement source. Enabling, replacing, disabling, or omitting its fields does not infer offboarding or invoke the user-cleanup path. Destructive offboarding requires the explicit authoritative workflow tracked separately in issue #905. <!-- @impl: src/routes/setup/index.ts::default -->

Provisioning owns orchestration; specialist owners perform each operation:

| Handoff | Current result contract |
|---|---|
| Active sessions | Cleanup attempts container destruction; a failure is logged, then the session KV entry is still deleted. Numeric `deletedSessions` counts deleted KV entries, not confirmed container teardowns |
| GitHub provider binding | Cleanup attempts provider revocation, logs failure, clears the local credential, and continues |
| Cloudflare provider binding | Provider revocation failure aborts cleanup under its provider-owned contract |
| User/bucket KV | Cleanup removes normalized user-scoped control keys after the provider handoffs settle |
| R2 token | Deletion failure is logged and can leave `tokenDeleted: false` |
| R2 objects and bucket | Empty/delete failure is logged and can leave `bucketDeleted: false` |
| Usage/accounting state | Billing/Timekeeper cleanup removes the user's projection where implemented |

The current route logs the cleanup result but returns `{ success: true, email }` even when cleanup is unconfirmed. GitHub revocation warnings indicate possible residual provider access but do not retain local credentials or stop cleanup. Operators must treat container-destruction warnings and false `tokenDeleted` or `bucketDeleted` results as residual cleanup work; the numeric session count alone does not confirm teardown. The API does not currently provide a fail-closed completion receipt. Exact route contracts belong to the [API Reference](api-reference.md#user-management).

## Compatibility and Migration

<a id="legacy-compatibility"></a>
- Legacy `accessTier` remains a read fallback while `subscriptionTier` is preferred.
- Tier mutation writes `subscriptionTier` and a compatible legacy `accessTier`; newer tier names map to legacy `advanced` where the old schema has no equivalent.
- Auth status without either stored tier preserves the legacy `advanced` fallback.
- General tier resolution uses the configured tier marked `isDefault`; `isActiveTier(undefined)` remains active for backward compatibility.
- Migration must not invent entitlement beyond those explicit compatibility defaults.
- Enterprise request-time overrides do not require rewriting older durable records.
- Normalized email remains the durable identity key input.
- Eventual consistency is explicit; no prose may claim KV per-key serialization.

<a id="cf-access-configuration-strategy"></a>
### Authentication and configuration alias

Access application creation, policy/group configuration, and deployment-mode selection belong to [Authentication](authentication.md#authentication-modes) and [Configuration](configuration.md). This lane records only how a verified identity crosses the provisioning gate.

<a id="frontend-components"></a>
### Frontend alias

Subscription, pending, administration, and Enterprise-suppression components render backend state. Component composition belongs to frontend/package implementation and is not provisioning authority.

## Requirement and Source Map

Exhaustive status remains in the active SDD domains.

| Transition | Requirements | Implementation | Evidence |
|---|---|---|---|
| Verified SaaS JIT | [REQ-AUTH-007](../../sdd/spec/authentication.md#req-auth-007-jit-user-provisioning-in-saas-mode) | `src/lib/access.ts::resolveOrProvisionUser` | access/JIT suites |
| Enterprise JIT and entry group | [REQ-ENTERPRISE-010](../../sdd/spec/enterprise-mode.md#req-enterprise-010-access-gated-jit-user-provisioning) | `src/lib/access.ts::resolveOrProvisionEnterpriseUser` | Enterprise access-group suites |
| Admin request elevation | [REQ-ENTERPRISE-014](../../sdd/spec/enterprise-mode.md#req-enterprise-014-admin-access-via-cloudflare-access-groups) | `src/lib/access.ts::requireAdmin` | admin group suites |
| Activation/subscription handoff | [REQ-SETUP-009](../../sdd/spec/setup.md#req-setup-009-subscribe-page-with-tier-selection), subscription SDD | auth/billing routes | subscribe/checkout suites |
| Offboarding | [REQ-GITHUB-005](../../sdd/spec/github.md#req-github-005-disconnect-and-offboarding-revocation), user cleanup requirements | user cleanup and specialist owners | cleanup/revocation suites |

<a id="specification-coverage"></a>
## Related Documentation

- [Authentication](authentication.md) — verified identity and authorization
- [Billing](billing.md) — effective entitlement and payment lifecycle
- [Security](security.md) — credential and Access-domain controls
- [Storage & Sync](storage-and-sync.md) — durable bucket behavior
- [API Reference](api-reference.md#user-management) — exact user/admin contracts
- [Architecture](architecture.md) — cross-component provisioning flows
