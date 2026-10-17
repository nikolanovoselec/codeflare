# Dispatcher native qualification

## Current intent4 artifact selection

[REQ-OPERATOR-048 AC1/6/7](../../../../sdd/spec/operators.md#req-operator-048-dispatcher-execution) qualification selects the exact published [v0.1.24](https://github.com/nikolanovoselec/codeflare-operator-dispatcher/releases/tag/v0.1.24) bundle, manifest and provenance in `dispatcher-v024-native.*`. The existing intent4 selectors pin source `987af47fb295147d445436b428a410b90cb09be0` and Flue runtime/plugin2.2.2 with Agents0.20.1; no platform-side rebuild occurs. <!-- @impl: src/__tests__/operators/fixtures/flue-native-cases.ts::pinnedArtifact --> <!-- @impl: src/__tests__/operators/fixtures/dispatcher-composed-fixture.ts -->

The remaining47-case population comprises8 composed cases selecting2.2.2 and39 historical2.1.0 controls. All historical JSON files remain byte-identical. The three file-owned runtimes, remaining assertions, request aborts, case budgets and180-second whole-workflow target remain unchanged; exact-head runtime/timing evidence is pending. The ordinary table workload, including its isolation/diagnostic/brief supplements, and committed-reset workload are retired after HTTP500/ProxyWorker connection loss in [CI38987310891](https://github.com/nikolanovoselec/codeflare/actions/runs/38987310891). Do not instrument, retry or recreate them. Earlier seven-/thirty-target workloads and the saved submission-limit `undefined` case remain retired. Deletion is not passing behavior or hosted collection, SDK release or physical cessation proof.

The saved-submission-limit `1` row and its bundled interruption check are retired after [CI39047218203](https://github.com/nikolanovoselec/codeflare/actions/runs/39047218203) failed with ProxyWorker connection loss; the `17` row remains. The removed completion and one-attempt interruption assertions provide no current native evidence.

## Remaining W2 recovery qualification

The remaining `REQ-OPERATOR-048: composed %s inference reaches a real collected assessment with one repository effect` table retains incomplete, native-error, duplicate and precommit-reset and **always runs the original official v24 package first**. Only precommit-reset then runs a separately selected derived SDK package. The ordinary-only isolation, withheld-import, live settlement-witness and nonserial brief supplements are removed with their retired table workload, not moved into another case or renamed. Separate Node61, the20-second composed request abort, unchanged90-second table-case budget and180-second workflow target remain intact. Timing is pending final exact-head GHA, not waived. No renewed RED gate, local execution or replacement native workload is required or claimed.

### Selection and immutable assets

`pinnedArtifact()` has no global diagnostics override. Original `DISPATCHER_INTENT4_NATIVE_*` selectors and the exact v24 source pin stay unchanged for every original caller. `dispatcher-sdk-qualification.ts::diagnosticsQualificationAssets()` is called only by the remaining precommit-reset case after its original assertions:

- No qualification inputs: run original controls and print an explicit **no candidate qualification claimed** message. No release-brief or new SDK feature assertion runs against unpatched v24.
- Any qualification selector: require **both complete three-file packages**, all six independently verified byte digests and their common exact SDK/package source commit. Partial configuration fails closed, rather than skipping some feature assertions.
- Final candidate GHA **sets `DISPATCHER_DIAGNOSTICS_QUALIFICATION_REQUIRED=1`** and supplies all selectors below through the existing Node job. With that marker, absent assets fail closed. A historical-controls-only job without this marker is not new capability evidence; no fixture or workflow change itself establishes a successful native run.
- Retired `DISPATCHER_DIAGNOSTICS_NATIVE_ARTIFACT` / `DISPATCHER_DIAGNOSTICS_NATIVE_SHA256` overrides are rejected with a migration explanation. They never select v24's replacement.

The host vendors the verified successful exact-source package GHA bytes, three files each, at these explicit fixture paths:

```
src/__tests__/operators/fixtures/dispatcher-diagnostics-native/operator-bundle.json
src/__tests__/operators/fixtures/dispatcher-diagnostics-native/operator-manifest.json
src/__tests__/operators/fixtures/dispatcher-diagnostics-native/operator-provenance.json
src/__tests__/operators/fixtures/dispatcher-release-brief/operator-bundle.json
src/__tests__/operators/fixtures/dispatcher-release-brief/operator-manifest.json
src/__tests__/operators/fixtures/dispatcher-release-brief/operator-provenance.json
```

The existing Node workflow supplies directories via `DISPATCHER_DIAGNOSTICS_NATIVE_PACKAGE` and `DISPATCHER_RELEASE_BRIEF_PACKAGE`, each prefix's `_BUNDLE_SHA256`, `_MANIFEST_SHA256` and `_PROVENANCE_SHA256`, and the common source in `DISPATCHER_DIAGNOSTICS_NATIVE_SOURCE_SHA`. Independent verification binds these pins to [successful push run38669886010](https://github.com/nikolanovoselec/codeflare-operator-dispatcher/actions/runs/38669886010), source `b9e382814f2d88421156c927b39b3bb97c243e59`; PR merge-ref packages were not substituted. Existing v24 and historical selectors/artifacts remain required and unchanged.

| Candidate | Actions artifact ID | Verified archive SHA-256 |
|---|---|---|
| Serial native | `11943490684` | `16a03b3526d54751cca4967c12dcbaf41f7df54a5f220333f06aa50d466b0ee5` |
| Nonserial brief | `11944020471` | `7bc23423306ef0788be73cf10a68decf288a2ac133a3c3991b87acc8feb97d25` |

Both archives contain exactly the three allowlisted root JSON files and match Actions digest metadata. Byte-level package, manifest, compiler and SDK provenance checks passed without executing artifacts; root rehashed the six files before and after vendoring. Both carry patch-set digest `f4466823ccb55eaf7819203211c49705ecad79da6a9ee6e29406a01e8789e9b9`. This profile carries the actual committed/idempotently verified SQLite batch sequence instead of numerically converting Flue's compound stream offset; actual host import remains subject to the unchanged native assertions. The workflow's SDK artifact-contract job consumes only the native package; the brief has independent data verification and a successful build, not a separate behavioral-contract job.

The helper checks original file bytes before parsing, manifest-to-bundle/provenance cross-binding, source commit, compiler50 and exact2.2.2/plugin2.2.2/Agents0.20.1 versions. It validates the fixed compiler-carried `codeflare/sdk-diagnostics-provenance.json`, its canonical patch digest and declared capabilities, then requires the serial and brief packages to carry the same derived SDK manifest. Root's package integrity/source audit remains responsible for original/transformed/source-file and patch/applicator verification against official inputs. The admitted fixture bundle is normalized JSON, as in the original serial transport; its manifest is explicitly rebound to that normalized digest **in memory only**. No compiler asset is rewritten and no release/installation is created.

### Genuine execution and retained owner readback

- `dispatcher-composed-fixture.ts` admits a candidate only from its caller-supplied manifest and validated embedded derived provenance. It never constructs a candidate manifest from the v24 manifest. The brief uses its own intent1/no-phase manifest and the same production Activity/Loader/capability/provider/real SQLite path.
- `dispatcher-owner-diagnostics.ts` mounts the real authenticated-session middleware and Activity Hono routes. Its signed fixture Access JWT goes through real signature/issuer/audience verification, current exact identity upstream and durable owner checks; no fabricated user or verified-Access context is injected. The fixture supplies the same bucket-ownership collaborator as the composed Activity and retains real owner-index updates. Only synthetic upstreams/catalog/bucket ownership are fixture substitutions; no child lookup, SQL probe or SDK event synthesis is added to owner reads. This does not claim the complete outer Worker stack is exercised.
- `qualifyImportedSdk()` reads v2 summary/history **after actual collection/SDK release**, then again after owner eviction/reconstruction. It requires original immutable generation/artifact/input binding, admitted patch identity, source-mapped canonical commits, actual SDK root/submission/attempt and batch/record/producer coordinates, actual input application and operational finalization associated with a committed attempt. Recovery requires two source-observed running attempts of one actual submission, not two phase IDs. Public history must truly exhaust and remain private/no-store. Reconstruction preserves the original records and binding; effects must stay identical.
- The removed brief supplement intended one latest-release GET, no repository write or phase state, exact cited collection and post-release/post-reconstruction qualification. Its verified assets remain, but it has no current native execution or behavioral acceptance claim.

The remaining precommit-reset assertions supply only their bounded recovery evidence. Retired ordinary, isolation, withheld-import and brief assertions do not establish current native coverage of REQ-DISPATCHER-007 AC1/4/6/7, REQ-OPERATOR-081 AC1/3, REQ-OPERATOR-082 AC1 or REQ-OPERATOR-083 AC1/2. Verified assets and workflow pins alone are not qualification; full behavior remains subject to hosted acceptance.

### Retired ordinary-only design (not executable CI coverage)

Items1–4 record the removed ordinary-only supplements, not current execution or permission to reintroduce them. Their acceptance concerns remain unverified; no replacement Miniflare workload is introduced.

1. The retired candidate ordinary design arms a fixed trigger on the actual selected-submission canonical-batch table, rejecting its first real INSERT. Only a genuine locally captured append-failure envelope after the arming watermark disarms it; no transaction-local counter is used. Assertions require the same attempt's caught failure, actual writer recovery and committed SDK coordinates. This is authored qualification, not a successful GHA result or originating-stack proof.
2. That retired design also rejects the selected discovery submission's first `terminalizing`→`settled` update. The existing external fixture observer reads that same canonical settlement obligation during the next already-live phase and correlates prior canonical coordinates, the actual catching error and later operational finalization. No child/capability→parent callback or retirement barrier is introduced. Missing the live observation window fails qualification; it does not delay release or reopen a retired child. Candidate precommit-reset uses the existing reset barrier plus a selected running-attempt replacement rejection, then requires two actual attempts and successful recovery/application/finalization. These retired assertions are not an exact-head CI gate; their behavior requires hosted evidence.
3. That retired design delegates the selected keepalive release to the production bridge successfully, then throws one fixed fixture Error. The actual Agents disposer must catch and safely report it without changing result/effect counts. Cleanup and recovery/finalization error mappings remain partial/catching with no invented originating frames; canonical mappings retain their explicit patch-boundary labels. Native stack accessors remain unread, with bounded safe capture loss exposed rather than fabricated stack digests.
4. A removed negative supplement was authored inside ordinary, preserving the positive imported-window assertions. It leaves exact candidate-bound runtime diagnostic POSTs pending before the parent transaction and removes only the diagnostic header from genuine native facet responses; all other native methods retain their original receivers, and execution response bodies remain untouched. During the next already-live phase, the existing external observer witnesses actual unimported failure/recovery outbox rows and committed coordinates. After normal collection/release and reconstruction, separate owner-HTTP assertions require pending/incomplete import, absent withheld SDK cause and no tail-only explanation for known omission. Results, effects, inference work and release must equal the positive execution. Parent source counts remain unavailable when neither channel supplied them; initialized bookkeeping is not zero-loss proof. No diagnostic acknowledgement, callback, flush, retirement barrier or retired-child read is added. Native decorator compatibility and live-witness behavior remain unqualified; retirement does not authorize rerunning the supplement or substituting synthetic proof.
5. Package source/provider/parser callback noninterference, logging OFF and patch activation verification remain separately owned. No assertion here identifies the historical v24 failure's origin.

### Package GHA handoff (root-owned; no publication)

After exact SDK patch verification and the existing npm-ci/compiler/workflow-identity setup in package `native-artifact`, build the brief using:

```sh
npx vite build --config fixtures/release-brief/vite.config.ts
node fixtures/release-brief/package.mjs
```

Use existing `CODEFLARE_COMPILER_ROOT`, repository/workflow IDs and Actions run/ref variables. Output defaults to `artifacts-release-brief/` with exactly `operator-{manifest,bundle,provenance}.json`; upload a distinct CI-only artifact. The serial candidate uses the existing native package build with the same exact derived SDK. Root verified both successful run/source identities and immutable assets before vendoring and wiring the selectors above. No local tests/builds/installs/typechecks/servers/linters/applicators or artifact execution were performed during that integration. Package CI results and data verification are recorded above; final host-native behavioral CI remains pending.

## Historical supplemental native RED handoff

The following records the original2.1.0 handoff, not the current host's implementation or current artifact qualification.

This fixture extends `loader-runtime.test.ts` in **Backend tests (node)**. The existing Wrangler process, Gate 1 and legacy Activity cases remain in that suite. No new runner, deployment or production migration is involved. The parent fixture compatibility date remains `2026-02-05`; only the generated child carries `2026-09-10` (the newest date supported by the pinned CI workerd). Do not increase the parent date without native evidence.

## CI prerequisites owned by root

1. Add exact **devDependency `agents: "0.20.1"`** to the platform package and generate its lock in CI. Flue 2.1.0 declares `^0.20.1`; do not choose Agents 0.24 independently. No Flue/Vite dependency is needed in the platform.
2. Generate and commit the profile lock for its exact package.json changes in CI, before `npm ci`. The old profile lock is deliberately not hand-fabricated here.
3. At the pinned profile revision run `npm ci` and `npm run build:fixture` in **profile CI**, not Codeflare. The official Flue/Vite + Cloudflare plugin generate `FlueDispatcherAgent`; `scripts/package-fixture.mjs` packages the output without rewriting generated code. The build fails at the existing 8 MiB / 128 module ceiling instead of expanding it.
4. Retrieve the successful exact-source profile Actions artifact `dispatcher-native-<source SHA>` using the existing authorized artifact mechanism. Verify its run/source and Actions artifact digest. Either make its verified bytes available before the canonical Node leg, or check those exact generated bytes into a root-owned platform fixture path. Never rebuild the package in the platform lane.
5. Set these environment variables on **the existing Backend tests (node) invocation**:
   - `DISPATCHER_NATIVE_ARTIFACT`: absolute path to `dispatcher-native.json`.
   - `DISPATCHER_NATIVE_SHA256`: independently pinned SHA-256 of those exact bytes (the profile artifact includes `dispatcher-native.sha256`).
   - `DISPATCHER_NATIVE_SOURCE_SHA`: exact profile commit that produced them.
6. Keep the existing suite manifest: `loader-runtime.test.ts` imports and registers `flue-native-cases.ts`. No suite-list edit is needed. Run canonical CI once after prerequisites are complete. Missing artifacts/dependencies/build failures are infrastructure failures, **not behavioral RED evidence**.

`test.yml` in the profile builds/uploads the native fixture independently of its deliberately RED unit tests. It neither publishes nor creates an operator release. The native fixture JSON is not a registry release/provenance substitute. Future release CI must produce `operator-manifest.json`, `operator-bundle.json`, `operator-provenance.json` and upload those same three files at the ZIP root of `operator-package`, matching the frozen registry provenance contract.

## What is real and what is synthetic

Real: package-generated Flue class, official model/tool loop, durable ToolStep, SQLite stores, Worker Loader, native facets, Agent 0.20.1 alarm/fiber machinery and native `ctx.abort()` eviction.

Synthetic: model SSE, read-only GitHub evidence, external-effect ledger and controlled hold/lost-response faults. The transport deliberately accepts all effect paths. It is an **upstream fixture**, not authorization. GREEN must put the actual restricted host bridge in front of it; otherwise authority/scope cases fail. No credentials, Internet, session/container bindings or production data are used.

The CI-only `FixtureFlueRoot` isolates the SDK compatibility milestone from production `OperatorActivity`. Existing `FixtureActivity` owns the real admission/drive state used by the assertions. This test arrangement does not claim the eventual production integration has two lifecycle owners. Do not carry the extra fixture namespace into production.

## Intended RED boundary and acceptance map

The loader selects the approved generated class and uses SDK `_cf_initAsFacet`. No `_rootAlarmOwner` adapter or `_cf_resolveSubAgent` override is implemented in RED. Agents' static-root/class lookup is expected to reject this dynamic class; the request returns a diagnostic admission outcome (`501`, stage `native-facet-admission`) and the test asserts actual `202` admission. This is an assertion failure, not a failed import or top-level fixture startup crash. Any build/parse problem is separate CI setup evidence and must be corrected before claiming native RED.

- REQ-048/051: real tool evidence + completed fiber + physical root alarm + no session; two activities have separate SQLite markers/transcripts, restart as different native root/facet instances and retain the pinned digest.
- REQ-048: HTTP `202` and repeated status reads leave the generation running. Segment A must really settle before Activity records safe waiting. Evict, explicitly reserve generation 2, then submit segment B. No pause/resume scheduler is invented.
- REQ-047/048: completed receipt survives eviction in the external-commit/ToolStep-record window; changed operation digest conflicts; unknown accepted effects are not replayed; live timeout is not waiting.
- REQ-047/048: warmed closures retain generation 1 after adversarial parent rollover, expiry or cancellation; no further external effect or stale Activity result commits. A separate case fences a late result after an already-admitted effect, without claiming cancellation undid it.
- REQ-048/051: allowed read control plus denied session/container/mutation/storage/arbitrary callback/foreign facet and direct egress probes. Supervisor SQL and environment stay unavailable to the child.

The forced-rollover authority test is a fault injection, not proof of a safe checkpoint. The real continuation case separately requires settled Flue output and a persisted host checkpoint. All negative cases either execute an allowed operation in the same scenario or establish a real generated-Flue positive control first.

Production Activity, loader/parser and capabilities are unchanged. Stop at this RED commit for root CI; do not implement the host adapter or claim GREEN from syntax checks.
