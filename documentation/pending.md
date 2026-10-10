# Pending Dispatcher serial execution and retry

The approved contract is [REQ-OPERATOR-048](../sdd/spec/operators.md#req-operator-048-dispatcher-execution), [061](../sdd/spec/operators.md#req-operator-061-prospective-admin-session-renovate-scan) and [062](../sdd/spec/operators.md#req-operator-062-repository-only-dispatcher-transport). The deployed intent3 runtime does not provide this revised behavior. The committed host candidate implements serial responses, deferred-aware settlement and terminal-proof scheduled retry. [CI run 38047355706](https://github.com/nikolanovoselec/codeflare/actions/runs/38047355706) failed at `f99499fa01e7e11d23be7d83aa01398007ec44e2`; subsequent-head behavioral verification and rollout remain outstanding. The package's [coordinated intent4 contract](https://github.com/nikolanovoselec/codeflare-operator-dispatcher/blob/fcb572b0839388f03940dc73813330eb331b049d/documentation/pending.md) owns Renovate policy and its deferred result.

## Existing ownership, revised lifecycle

One Activity-private Facet and the original lease own a serial exact-submission lineage. The package supplies bounded functional phase progress with complete actual disposition prefixes; Codeflare reserves immutable delivery identity, admits only the current phase, records exact terminal settlement and collects the designated final assessment. Observation timeout is not permission to advance.

The candidate uses `src/operators/activity.ts`, bounded collection in `src/operators/dispatcher-result.ts`, phase validation in `src/operators/dispatcher-phases.ts`, and existing capability bindings. Serial admission, functional `dispatcher-progress` and phase context are authored but unverified. Old phase callers cannot acquire current phase authority. The required phase-context response binds actual SDK receipts and complete contiguous past settlements; a visible terminal record is not an invented admission acknowledgement. Lost acknowledgement retains the same delivery/idempotency key. Generation, release, revisions, human expiry and cancellation remain unchanged.

Only newly supported intent4 results can account for PR-local unknown mutations. Completion validates coverage of every unresolved operation, including completed transport lacking domain proof, without resolving or deleting its historical ledger. Mutation timeout/5xx transport completion does not prove definite effect failure; original parent unknown-ledger classification and no-replay fences remain required. Uncovered uncertainty still refuses collection; old intent3 Activities retain their original fences.

## Configured automatic retry

The deployed admission owner permanently reuses repository/PR/head admission. The candidate's `src/operators/registry.ts::reserveProspectiveRenovateActivity` selects a fresh attempt only after original settled, collected failed/deferred proof and the configured due boundary. Concurrent actors elect one attempt; uncertain preparation/start retains its original Activity.

Retry keeps authenticated repository/PR eligibility and original retained-target scope. The existing retry getter refuses unresolved write records and effect-uncertain dispositions: deferred collection does not authorize blind replay. No new interlock or historical index is added. Retention currently covers original prospective singleton admissions; manual repository-journey retry remains unverified.

Configuration, installation, owner/session/grants, enabled automation and current authority are revalidated. There is no new scheduler, Durable Object, retry setting, immediate loop or live automatic activation. Existing interval/default behavior stays unchanged.

## Verification boundary

Behavioral coverage includes serial advancement, provider failure followed by another PR's success, deferred collection, unknown-write no-resend, lost admission acknowledgement, old-phase denial, configured due retry and concurrent election. Implementation and coverage land together, with reviewed exact-head CI before release or rollout.

All 53 native cases, complete 7/32 and 30/36 workloads, three runtimes, original 20-second aborts, immutable collection/recollection and the 180-second workflow gate remain. Authored child-only reconstruction supplements root/facet eviction. Intent4 retires the actual child through runtime facet abort; bookkeeping release alone is not cessation proof. Same-run original-GET recovery is not replaced with next-run retry. No sequential candidate is an attributed repair for the current HTTP500 or abort.

Package publication/installation, both Integration rollouts, actual-scope hosted outcomes and failure isolation, configured retry, durable SDK release and independently verified physical cessation are separate acceptance gates. Historical unknown Activities remain fenced; no Production deployment is implied.
