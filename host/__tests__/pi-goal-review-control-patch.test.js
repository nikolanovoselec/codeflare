import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  COMMANDS_PATCH_MARKER,
  CONTROL_CHANNEL,
  EXPECTED_PI_GOAL_VERSION,
  GOAL_ENTRYPOINT_PATCH_MARKER,
  PATCH_MARKER,
  PROMPTS_PATCH_MARKER,
  RUNTIME_PATCH_MARKER,
  SETTINGS_PATCH_MARKER,
  patchPiGoalCommandsSource,
  patchPiGoalDirectory,
  patchPiGoalPromptsSource,
  patchPiGoalRuntimeSource,
  patchPiGoalSource,
} from '../../scripts/patch-pi-goal-review-control.mjs';
import {
  EXPECTED_PI_PLAN_MODE_VERSION,
  patchPiPlanModeDirectory,
} from '../../scripts/patch-pi-plan-mode-tool-policy.mjs';

// Candidate capture: @narumitw/pi-plan-mode@0.59.4
// https://registry.npmjs.org/@narumitw%2Fpi-plan-mode/0.59.4
// Verified archive: sha512-ISq9YB3+4PWqL4JSxJCBASb844NcnKH/RuGuIJwdNk8xmtGKDYOnjSrkfl+MBiSTImV56m7WX0TBBcG/0FuGYA==
// Upstream: narumiruna/pi-extensions@ed242b63dd40bacc276b6b9fc66440eaaf1bf57b
const CANDIDATE_SOURCE_DELTA = 'H4sIAAAAAAACA91VyZLaSBT8F67D2LUvhzk0GiMENB7oRhLq8KEWSSwSKMxm9dfPE7gdjolZYk7jGC4V8VBV5cvMl/Xy0muM25kyf7c9Hva9fk8KonWBsCxyyp0tNMaOCGwLQpUyhSSOSWQVy3PrHNPS5sg6TS1FzChXcDiikM5jnyujCkqMFQ5pypgnTBbOUk5lTijVglssPfJMcs2Jk85JKyyyjPX6Ly9U9Qnt96LgYePruHWkuthNJKIguk63Sz7dzjfTh8MvvU/9F0VxX8nbt2UUjB+yZNhmCd+Z5HryRLeGPl5cuDutiIYa30+T4R7+R9H2UEbbD+fHll2jzXXyT/v9KG7+uKf36RMg6PnN8fR+s/f5l3enIzDgEYWeRY6VIUJZSRCRnnHMJc6ZVt7BAgzCojwlSOWIEcYKYYmX0lgHR5DcaMyRc0Jg7nLpuS8K6wx2upAFRdxhhgAe5d6gPKdOECM1HCaJ917oG4lCYtZXpN8zCb5aOkbR6Fg6umhNOlhm6fgEfKztcFa5NK5sDWs70FGYtZagMtoNqlU6hvqisQEGicefXauv5gkjn+w2H69NY9PBxe3nZd4OhllYIfjm2YdD5NNZapLFPkvnZfE0qF2tTx23th62PsGNH7lvnE6TU+MDXd33RyfAt4b66zT1TRb6ygeRDMpfblpTsCfrE8H7vWwfn1cUoBFWrugYoC6qZfhlbXf4koXx2/UHG1bnLH08RqPFIUtwNXkayGDzULo6BpjjcxTyyv81/AO0hkwYn7Kna7fnDGe381rv8udDOQl25W/PrPx6x9kmw+tkNFvbukImbf4Ez+IRKO8w6MnzcdK1xBABp2NBOgcPtn5UnoHdsyMxikm1y2CdDAeP8yUvYlR9WKB4maLTMAE4k6HulPiutQf922awBZhrH8ZzGw7Pz4neZfEbk+tXUODqyPrig2vpw3Vlk2XzBkVIjWif6RsS0JnDzJWbVR3XQEyVkvvcpHSGwBcI/F9Owph0tekdeRP9in4Cj91nKazqKFhXML9nH/BTls5eV4mv4lF1zTqkz+CxeoZB74t9ippoNK5A99Zuj29zdfzs3jeV2f9cH3x+Hy2US5JLrAmGiHLMc2Wp5hRLJxFlmHCnc+IVzj1HTDspKKGaYcuJLrBCshstKRy2RCvspS+Id87mOIdqoZzynHrFEBJeCEJ5IQ0XiggmOEwaJVJJ040W1kyJvkZvsaMuURgzIP18jyqMXF3tQTyIkjn4M371oT5NQSRHZ+uMLMtbq/vHcrWvriug5ibi0wDSNm6nSXV2oxhFoe+EfJ2W96ijiIBPfjSBPufHfH8yp81hf9dIG+oh7DTRkOZIgS6UCy0LIh2W8GRQBNQTSL8c3hOui8JDzSONveVFrrs3xFBJDaECO+Mp9lg4kAgV1jNDCcG5BPoNksryvOhSEHklkVOSQDZZY0inkf5/ZR8mjPahv5v4LUQJdvW/jT5+e9myNDp4yBYflg10ooOyqX3Ctz7srPu3+XHs4su9HrooXGehPtvR7s4qvKwJRt/u+rgZLO+xuRPRh3hn0sXFVZ0xATd+O+8exdNWlU+kArvzi6vxGnALwF1m+/H6HvGgVDCAWJ2XcA9ZJV+aLBhQ6BOZEYzQ1wGIwtkR1L12WKLvYhi+3Viy4GDgi6eP5x8r/oXsY67+6/SH3+8IuovqDQoAAA==';

// Unmodified npm runtime-source capture as byte deltas from the retained prior
// archive. No network or rewritten tarball integrity; every reconstructed file
// is verified before use. See the candidate compatibility report for provenance.
function restoreCandidateSources(root) {
  const records = JSON.parse(gunzipSync(Buffer.from(CANDIDATE_SOURCE_DELTA, 'base64')));
  for (const [path, beforeHash, afterHash, edits] of records) {
    let source = existsSync(join(root, path)) ? readFileSync(join(root, path)) : Buffer.alloc(0);
    assert.equal(createHash('sha256').update(source).digest('hex'), beforeHash, path);
    for (const [offset, length, bytes] of edits.toReversed()) {
      source = Buffer.concat([source.subarray(0, offset), Buffer.from(bytes, 'base64'), source.subarray(offset + length)]);
    }
    assert.equal(createHash('sha256').update(source).digest('hex'), afterHash, path);
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
}

// Registry SHA-512 verified captures; every src file matches authenticated GitHub
// contents at 980db40db9b1db3b8dc92b2b1837eb06841bfea2.
// Goal 0.54.15: sha512-BuV7MCvW389fBELeKlcxfFJhPvrpJIV7HceEmiKqI9dsjX0eCX6S0t7N22dYSAKg2X1R7P40nCHkRKuBw0kVIg==
// Plan 0.59.6: sha512-c749Stq0YL0Sj3W62o8puWOUhvjbExGu4MAreepnuodI3mqDdzm10duT3broRD7J0RdRVJ0dotONH7lT5oxEGA==
// Byte deltas retain genuine generated entrypoints/chunks; these are not tarballs.
const TARGET_SOURCE_DELTAS = {
  "goal": "H4sIAAAAAAACA5WSy3LaMBSG38VrT6qjiyUtuqAuJCaQNJDaEIaFpCMxNhiYAKHu01cw0/S26lJH//nO7V8skr1xa7PyN81ht03SRHjUFi1lSLixFrTQxjpkKCVRqBQ6FYBYCVSCVJl0JhgUgfPgiQ4ii4gsOJlZNNRFiqAsGGaDs0I6mjn0gXqTRY6hIv4AYkzWVgYED6iQ2SRdLBhLKU+TIu/V2Jado5s3WxdZkRfnUfOVjJo+FPX5PlmmC5axlFylqyIffp72B48TUo6fiTvZ6qke9XYfLzJNZQpUvAt7L9Wge6nE2lTnI1LdGTZ+c7fr47xa1491rx5POYya3gWwuuasP23ms+HGtpO9zYFZNnx1nT6bKTSWxljrYi5u7Pbpf/MJ/lvz2jQQKdPfmiZ+FiGt5kUToU3/9JDz7z8XASBYytSvCW076LCCPd6562R4V+5H1XGP+WWTQz/OOX2c8nOxulRbpn96IRKTw6v78HraHuvW3xwP8bZGGAQajaFDJomW8YkCnHPeBaoICxycEJYEz0KUcREsR8klzxRRQYmI4GgttR44MYQJyoFmQlLuIzPGwBDFQQaOyliP1AulZfSPssZIGiTJLvbgGiR/v/rdZGdm49Oc6qO7/bbB22iWzQOZzybgIC67KrvRtjy5tmy/dHx3/3y4v47713TL5Q95zPQPDwMAAA==",
  "plan": "H4sIAAAAAAACA72VSXMaSRCF/wtnZNeaVXXwQSADjQBZC92AQodaUbOPaKRBv36yJVkzsh2eiDlMBAQRRXV25fdevrq9bYRyX33294fNcv/6c1KoMxixYfap2jeaDZNMIk4arQQNLKhgCaHJUUNZwA9IHYUOgdEI2geuBLeMckuU05RIobFEjEnS5IM3LjBptU8gXLJJW8ojJxTLMWtJcoZD4lonG1iioJQR1kXtG83bW8GogSZpNrL26Tzr9veOjR5mxSVkvf3cstVhdradZ5sOnU1GxBbmkJVPc1fkz551NrMb/G/ZOXgeVr5sXbpu55B16eOsO577Sb7y/GrnmHzOypYZnG6/NO6at4oLME3Bm43BUS+y3ugxTPqL2Zje+15r59YhHy+fzJTdU7feV/lz+DpaiuPNeHkIveHBFZ2n9vwLVrpr/gLxsJ9DMeqd14jxXR92lJsqPlhflY/x5FCeXHVVu1VA51UNKSFKQwDACgIqWcmdcVE5pR1JlrvkueEqRc+4CcLqKAMFFq2KIroYsQQoICm5pIFGYyEAky6GBBrXFQCVSQntKKMiKqa85MCcszZaHznVIGo1NIEmRzHSdWvt16bK2tlhwEbbUMiHQY44z2YXwyXtDzZXz9lif143yY0yqinZ74HaQpLZpH8/RUnCelyFYlmNl55fkv5ktJz+Hu4P6DqqMxypzs0HyuUmxD9fYSIWQyXxvu7aRxVkQDDeUm+SSpxITwUJzHCJpo+Re2BWGc6IYiEEMLUe3CmpBaKDJIMBtLBLhlDNiZAWd2pnNOBApOQTjkiKQiBuZ1liJNFUw6QSZJOrX9P0R7OwvfxgjxSNfcluFv3R9TUe+pipVwbNWyEMsKYRb8OB348U89zmraNjdOfZeP7tGmlPWo9+c7nNSvH4auHqeYBDFLr5cVrgAE1mq8Ek3w3yfm9ERu38edZ90bJcHqasQ6Zsvj3HvXja4/n1qflWtt5PIyUSep/U3mgVele1vM/jdY5T21nm3VU1m2QHbO84K6afB+V8d/G0/Yec7xrVqu2sX9p5/LTYbzdIPCkfaIja6sSZdeCJ4UIEJlTyjkuuIuPcgHRUBRKEkkYyr7xXDhxxAu3bECxK4QyL3IVgTCCGgg4OjLKccmUkScEKwxhgxHmOgxKSE8yRYLU1/kU0rpuMv/RYIuCjZ6tHV2aA0j0NFmM5WEzL70mCFd9xtPtn1187F1ckH94Qj06+fN+mOW1q9b7vdFZ0EI9c2uKpQhMeLR8++u6ymjKDa3IzKDDYUOdsgeG2+HoYXYsnDL3zf3s+9PLdj8/U76eUow313wdw684xFHQXev79wUFR7UK77rMfh23BLuoC8zftPihVS7d/8J93K7s5WW9DfJs5BZ46ZjTFqySx4L2LNOJq0l4HyYMWhGAoAeMYRFaCZiBA4ghyprSyWIITy7xmaARiBbNYh3GwkTpCAevWM22JwAskEu8U3kre4XXiFTN1jfQ6cwoz9D+b9Ke+vjf7xyHuq3K7Oam229Vrw4AnURgtDoBoTBtAMyZhrecUbMCzciMlkWCAJwIxxBQwNJhBszGjOKkb1phJ0roARFDHubOBU8VqKiCoAGqMdk4FzJfoqKXJ8IhmB4qxJq0ndcMYceT/uz7fGP2E4+7uL7UXcURyCAAA"
};
function restoreTargetSources(key, root) {
  const records = JSON.parse(gunzipSync(Buffer.from(TARGET_SOURCE_DELTAS[key], 'base64')));
  for (const [path, beforeHash, afterHash, edits, basePath] of records) {
    assert.ok(path === 'package.json' || /^(src|dist)\/[a-zA-Z0-9_./-]+$/.test(path));
    assert.ok(!path.split('/').includes('..'));
    assert.ok(!basePath.split('/').includes('..'));
    let source = existsSync(join(root, basePath)) ? readFileSync(join(root, basePath)) : Buffer.alloc(0);
    assert.equal(createHash('sha256').update(source).digest('hex'), beforeHash, path);
    for (const [offset, length, bytes] of edits.toReversed()) {
      source = Buffer.concat([source.subarray(0, offset), Buffer.from(bytes, 'base64'), source.subarray(offset + length)]);
    }
    assert.equal(createHash('sha256').update(source).digest('hex'), afterHash, path);
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
}

const fixtureCommandsSource = `export class GoalCommandController {
\tconstructor(runtime) {
\t\tthis.runtime = runtime;
\t}

\tpauseGoal(ctx: StatusContext) {
\t\tif (!this.runtime.activeGoal || this.runtime.activeGoal.status !== "active") return;
\t\tthis.runtime.recordGoalUsage(this.runtime.activeGoal, ctx);
\t\tthis.runtime.cancelContinuationWork();
\t\tthis.runtime.clearBudgetWrapUp();
\t\tthis.runtime.blockStaleGoalToolCalls();
\t\tabortCurrentTurn(ctx);
\t\tthis.runtime.activeGoal = transitionGoal(this.runtime.activeGoal, "paused");
\t\tthis.runtime.persistGoal(this.runtime.activeGoal);
\t\tthis.runtime.updateStatus(ctx, this.runtime.activeGoal);
\t}

\tasync resumeGoal(ctx: StatusContext) {
\t\tconst resumedGoal = { id: "resumed-goal" };
\t\tconst stoppedStatus = "paused";
\t\tconst sent = await this.runtime.sendOwnedGoalPrompt(
\t\t\tctx,
\t\t\tresumedGoal.id,
\t\t\tbuildResumePrompt(resumedGoal, stoppedStatus),
\t\t);
\t\treturn sent;
\t}
}
`;

const fixtureNextCommandsSource = fixtureCommandsSource.replace(
  `\tpauseGoal(ctx: StatusContext) {
\t\tif (!this.runtime.activeGoal || this.runtime.activeGoal.status !== "active") return;
\t\tthis.runtime.recordGoalUsage(this.runtime.activeGoal, ctx);
\t\tthis.runtime.cancelContinuationWork();
\t\tthis.runtime.clearBudgetWrapUp();
\t\tthis.runtime.blockStaleGoalToolCalls();
\t\tabortCurrentTurn(ctx);
\t\tthis.runtime.activeGoal = transitionGoal(this.runtime.activeGoal, "paused");
\t\tthis.runtime.persistGoal(this.runtime.activeGoal);
\t\tthis.runtime.updateStatus(ctx, this.runtime.activeGoal);
\t}`,
  `\tpauseGoal(ctx: StatusContext) {
\t\tif (!this.runtime.activeGoal || this.runtime.activeGoal.status !== "active") return;
\t\tconst stoppedGoal = this.runtime.stopActiveGoal(ctx, {
\t\t\tkind: "explicit_pause",
\t\t\texpectedGoalId: this.runtime.activeGoal.id,
\t\t});
\t\treturn stoppedGoal;
\t}`,
);

const fixtureGoalSource = `function registerGoalRuntime(pi: ExtensionAPI, options: GoalOptions = {}) {
\tconst runtime = new GoalRuntime(pi);
\tconst commands = new GoalCommandController(runtime);
\tconst runController = new GoalRunController(runtime, commands);
\trunController.register(pi);

\tpi.on("session_start", async (_event, ctx) => {
\t\truntime.replaceMenuSession();
\t});

\tpi.on("session_shutdown", (_event, ctx) => {
\t\trunController.unbindSession();
\t});
}
`;

const fixtureRuntimeSource = `export class GoalRuntime {
\tsettings = { continuationLimits: { minIntervalMs: 0 } };
\tactiveGoal;
\tcompletionStatusTimer?: NodeJS.Timeout;
\tcontinuationIntent?: ContinuationTicket;
\tcontinuationDelivery?: ContinuationTicket;
\tcancelledContinuationMarkers = new Set();
\tclaimedContinuationMarkers = new Set();
\tmenuGeneration = 0;

\tconstructor(pi) {
\t\tthis.pi = pi;
\t}

\tgoalToolsAvailable() {
\t\treturn true;
\t}

\tpauseGoalForUnavailableTools() {
\t\treturn false;
\t}

\tenforceAutomaticTurnLimit() {
\t\treturn false;
\t}

\tenforceNoProgressLimit() {
\t\treturn false;
\t}

\tdispatchContinuationIfSettled(ctx: StatusContext) {
\t\tconst intent = this.continuationIntent;
\t\tif (!intent) return false;
\t\tif (this.activeGoal?.status === "active" && !this.goalToolsAvailable()) {
\t\t\tthis.pauseGoalForUnavailableTools(ctx);
\t\t\treturn false;
\t\t}
\t\tif (
\t\t\t!this.activeGoal ||
\t\t\tthis.activeGoal.id !== intent.goalId ||
\t\t\tthis.activeGoal.status !== "active"
\t\t) {
\t\t\tthis.continuationIntent = undefined;
\t\t\treturn false;
\t\t}
\t\tif (this.enforceAutomaticTurnLimit(ctx, false) || this.enforceNoProgressLimit(ctx)) {
\t\t\treturn false;
\t\t}
\t\tif (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) return false;

\t\tthis.continuationIntent = undefined;
\t\tthis.continuationDelivery = intent;
\t\ttry {
\t\t\tthis.pi.sendUserMessage(intent.prompt, { deliverAs: "followUp" });
\t\t\treturn true;
\t\t} catch (error) {
\t\t\tif (this.continuationDelivery?.marker === intent.marker) {
\t\t\t\tthis.continuationDelivery = undefined;
\t\t\t}
\t\t\tif (this.activeGoal?.id === intent.goalId && this.activeGoal.status === "active") {
\t\t\t\tthis.continuationIntent = intent;
\t\t\t}
\t\t\tctx.ui.notify(\`Goal prompt failed: \${formatError(error)}\`, "error");
\t\t\treturn false;
\t\t}
\t}

\tclearContinuationTracking() {
\t\tthis.continuationIntent = undefined;
\t\tthis.continuationDelivery = undefined;
\t\tthis.cancelledContinuationMarkers.clear();
\t\tthis.claimedContinuationMarkers.clear();
\t}

\tcancelContinuationWork() {
\t\tif (this.continuationDelivery) {
\t\t\tthis.rememberCancelledContinuationMarker(this.continuationDelivery.marker);
\t\t}
\t\tthis.continuationIntent = undefined;
\t\tthis.continuationDelivery = undefined;
\t}

\trememberCancelledContinuationMarker(marker) {
\t\tthis.cancelledContinuationMarkers.add(marker);
\t}
}
`;

const fixtureNextRuntimeSource = [
  `export type GoalStopRequest =\n\t| { kind: "explicit_pause"; expectedGoalId: string };`,
  fixtureRuntimeSource
    .replace(
      '\tcompletionStatusTimer?: NodeJS.Timeout;',
      '\tcompletionStatusTimer?: NodeJS.Timeout;\n\tprivate continuationDispatchTimer?: NodeJS.Timeout;',
    )
    .replace(
      '\tmenuGeneration = 0;',
      '\tmenuGeneration = 0;\n\ttoolPolicy = { toolsAvailable: () => true };',
    )
    .replace('this.goalToolsAvailable()', 'this.toolPolicy.toolsAvailable()')
    .replace(
      '\t\tthis.continuationIntent = undefined;\n\t\tthis.continuationDelivery = intent;',
      '\t\tthis.clearContinuationDispatchTimer();\n\t\tthis.continuationIntent = undefined;\n\t\tthis.continuationDelivery = intent;',
    )
    .replace(
      '\tconstructor(pi) {\n\t\tthis.pi = pi;\n\t}',
      `\tconstructor(pi) {
\t\tthis.pi = pi;
\t}

\trecordGoalUsage() {}
\townsWorkflow(goal = this.activeGoal) { return goal?.status === "active"; }
\tclearGoalRecoveryForGoal() {}
\tclearBudgetWrapUp() {}
\tblockStaleGoalToolCalls() {}
\tpersistGoal() {}
\tupdateStatus() {}

\tstopActiveGoal(ctx: StatusContext, request: GoalStopRequest) {
\t\tconst currentGoal = this.activeGoal;
\t\tif (!currentGoal || currentGoal.id !== request.expectedGoalId) return undefined;
\t\tlet goal = currentGoal;
\t\tlet status;
\t\tswitch (request.kind) {
\t\t\tcase "explicit_pause":
\t\t\t\tthis.recordGoalUsage(goal, ctx);
\t\t\t\tthis.cancelContinuationWork();
\t\t\t\tthis.clearGoalRecoveryForGoal(goal.id);
\t\t\t\tthis.clearBudgetWrapUp();
\t\t\t\tthis.blockStaleGoalToolCalls();
\t\t\t\tabortCurrentTurn(ctx);
\t\t\t\tstatus = "paused";
\t\t\t\tbreak;
\t\t}
\t\tthis.activeGoal = transitionGoal(goal, status);
\t\tthis.persistGoal(this.activeGoal);
\t\tthis.updateStatus(ctx, this.activeGoal);
\t\treturn this.activeGoal;
\t}

\tscheduleContinuationDispatch(ctx: StatusContext, goalId: string) {
\t\tthis.clearContinuationDispatchTimer();
\t\tconst generation = this.menuGeneration;
\t\tthis.continuationDispatchTimer = setTimeout(() => {
\t\t\tthis.continuationDispatchTimer = undefined;
\t\t\tif (
\t\t\t\tgeneration !== this.menuGeneration ||
\t\t\t\tthis.activeGoal?.id !== goalId ||
\t\t\t\t!this.ownsWorkflow(this.activeGoal)
\t\t\t) {
\t\t\t\treturn;
\t\t\t}
\t\t\tthis.dispatchContinuationIfSettled(ctx);
\t\t}, 0);
\t}

\tprivate clearContinuationDispatchTimer() {
\t\tif (!this.continuationDispatchTimer) return;
\t\tclearTimeout(this.continuationDispatchTimer);
\t\tthis.continuationDispatchTimer = undefined;
\t}`,
    )
    .replace(
      '\tclearContinuationTracking() {\n\t\tthis.continuationIntent = undefined;',
      '\tclearContinuationTracking() {\n\t\tthis.clearContinuationDispatchTimer();\n\t\tthis.continuationIntent = undefined;',
    )
    .replace(
      '\tcancelContinuationWork() {\n\t\tif (this.continuationDelivery) {',
      '\tcancelContinuationWork() {\n\t\tthis.clearContinuationDispatchTimer();\n\t\tif (this.continuationDelivery) {',
    ),
].join('\n');

function executablePatchedController(abortCurrentTurn = () => {}) {
  const patched = patchPiGoalCommandsSource(fixtureCommandsSource)
    .replace('export class GoalCommandController', 'class GoalCommandController')
    .replace(
      'ctx: StatusContext, options: { abortTurn?: boolean } = {}',
      'ctx, options = {}',
    )
    .replace(
      'ctx: StatusContext, options: { sendPrompt?: boolean } = {}',
      'ctx, options = {}',
    );
  return Function(
    'buildResumePrompt',
    'abortCurrentTurn',
    'transitionGoal',
    `${patched}\nreturn GoalCommandController;`,
  )(
    (goal, status) => `${goal.id}:${status}`,
    abortCurrentTurn,
    (goal, status) => ({ ...goal, status }),
  );
}

function executablePatchedNextController() {
  const patched = patchPiGoalCommandsSource(fixtureNextCommandsSource)
    .replace('export class GoalCommandController', 'class GoalCommandController')
    .replace(
      'ctx: StatusContext, options: { abortTurn?: boolean } = {}',
      'ctx, options = {}',
    )
    .replace(
      'ctx: StatusContext, options: { sendPrompt?: boolean } = {}',
      'ctx, options = {}',
    );
  return Function(
    'buildResumePrompt',
    `${patched}\nreturn GoalCommandController;`,
  )((goal, status) => `${goal.id}:${status}`);
}

function executablePatchedGoal() {
  const runtimes = [];
  class GoalRuntime {
    constructor(pi) {
      this.pi = pi;
      runtimes.push(this);
    }

    replaceMenuSession() {}

    closeMenuSession() {}
  }
  class GoalCommandController {
    constructor(runtime) {
      this.runtime = runtime;
      this.pauseOptions = [];
      this.resumeOptions = [];
    }

    pauseGoal(_ctx, options) {
      this.pauseOptions.push(options);
      this.runtime.activeGoal = { ...this.runtime.activeGoal, status: 'paused' };
    }

    async resumeGoal(_ctx, options) {
      this.resumeOptions.push(options);
      this.runtime.activeGoal = { id: 'resumed-goal', status: 'active' };
    }
  }
  const controllers = [];
  class GoalRunController {
    constructor(_runtime, commands) {
      controllers.push(commands);
    }

    register() {}

    unbindSession() {}
  }
  const patched = patchPiGoalSource(fixtureGoalSource)
    .replace(
      'function registerGoalRuntime(pi: ExtensionAPI, options: GoalOptions = {})',
      'function registerGoalRuntime(pi, options = {})',
    )
    .replace('let codeflareControlCtx: StatusContext | undefined;', 'let codeflareControlCtx;')
    .replace('async (data: unknown) =>', 'async (data) =>')
    .replace(/const request = data as \{[\s\S]*?\n\t\t\};/, 'const request = data;')
    .replace(
      'const respond = (ok: boolean, goalId: string, status: string) =>',
      'const respond = (ok, goalId, status) =>',
    );
  const registerGoalRuntime = Function(
    'GoalRuntime',
    'GoalCommandController',
    'GoalRunController',
    `${patched}\nreturn registerGoalRuntime;`,
  )(GoalRuntime, GoalCommandController, GoalRunController);

  const lifecycle = new Map();
  const events = new Map();
  registerGoalRuntime({
    events: { on: (name, handler) => events.set(name, handler) },
    on: (name, handler) => lifecycle.set(name, handler),
  });
  return { runtime: runtimes[0], controller: controllers[0], lifecycle, events };
}

function createScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const armedDelays = [];
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      armedDelays.push(delay);
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const pending = [...timers.entries()]
          .filter(([, timer]) => timer.due <= target)
          .sort((left, right) => left[1].due - right[1].due)[0];
        if (!pending) break;
        const [id, timer] = pending;
        timers.delete(id);
        now = timer.due;
        timer.callback();
      }
      now = target;
    },
    pendingCount() {
      return timers.size;
    },
    armedDelays() {
      return [...armedDelays];
    },
  };
}

function executablePatchedRuntime(scheduler) {
  const patched = patchPiGoalRuntimeSource(fixtureRuntimeSource)
    .replace('export class GoalRuntime', 'class GoalRuntime')
    .replace('\tcompletionStatusTimer?: NodeJS.Timeout;', '\tcompletionStatusTimer;')
    .replace(/\tcontinuationTimer\?: NodeJS\.Timeout;[^\n]*/, '\tcontinuationTimer;')
    .replace('\tcontinuationIntent?: ContinuationTicket;', '\tcontinuationIntent;')
    .replace('\tcontinuationDelivery?: ContinuationTicket;', '\tcontinuationDelivery;')
    .replace('dispatchContinuationIfSettled(ctx: StatusContext)', 'dispatchContinuationIfSettled(ctx)')
    .replace('private clearContinuationTimer()', 'clearContinuationTimer()');
  return Function(
    'setTimeout',
    'clearTimeout',
    'hasPendingMessages',
    'formatError',
    `${patched}\nreturn GoalRuntime;`,
  )(
    scheduler.setTimeout,
    scheduler.clearTimeout,
    (ctx) => ctx.hasPendingMessages?.() ?? false,
    (error) => String(error),
  );
}

function executablePatchedNextRuntime(scheduler, abortCurrentTurn = () => {}) {
  const patched = patchPiGoalRuntimeSource(fixtureNextRuntimeSource)
    .replace(
      'export type GoalStopRequest =\n\t| { kind: "explicit_pause"; expectedGoalId: string; abortTurn?: boolean };\n',
      '',
    )
    .replace('export class GoalRuntime', 'class GoalRuntime')
    .replace('\tcompletionStatusTimer?: NodeJS.Timeout;', '\tcompletionStatusTimer;')
    .replace(/\tprivate continuationDispatchTimer\?: NodeJS\.Timeout;[^\n]*/, '\tcontinuationDispatchTimer;')
    .replace('\tcontinuationIntent?: ContinuationTicket;', '\tcontinuationIntent;')
    .replace('\tcontinuationDelivery?: ContinuationTicket;', '\tcontinuationDelivery;')
    .replace('stopActiveGoal(ctx: StatusContext, request: GoalStopRequest)', 'stopActiveGoal(ctx, request)')
    .replace(
      'dispatchContinuationIfSettled(\n\t\tctx: StatusContext,\n\t\toptions: { intervalElapsed?: boolean } = {},\n\t)',
      'dispatchContinuationIfSettled(ctx, options = {})',
    )
    .replace('dispatchContinuationIfSettled(ctx: StatusContext)', 'dispatchContinuationIfSettled(ctx)')
    .replace('scheduleContinuationDispatch(ctx: StatusContext, goalId: string)', 'scheduleContinuationDispatch(ctx, goalId)')
    .replace('private clearContinuationDispatchTimer()', 'clearContinuationDispatchTimer()');
  return Function(
    'setTimeout',
    'clearTimeout',
    'hasPendingMessages',
    'formatError',
    'abortCurrentTurn',
    'transitionGoal',
    `${patched}\nreturn GoalRuntime;`,
  )(
    scheduler.setTimeout,
    scheduler.clearTimeout,
    (ctx) => ctx.hasPendingMessages?.() ?? false,
    (error) => String(error),
    abortCurrentTurn,
    (goal, status) => ({ ...goal, status }),
  );
}

function runtimeHarness(minIntervalMs) {
  const scheduler = createScheduler();
  const messages = [];
  const Runtime = executablePatchedRuntime(scheduler);
  const runtime = new Runtime({
    sendUserMessage(prompt, options) {
      messages.push({ prompt, options });
    },
  });
  runtime.settings = { continuationLimits: { minIntervalMs } };
  runtime.activeGoal = { id: 'goal-a', status: 'active' };
  runtime.continuationIntent = {
    goalId: 'goal-a',
    iteration: 1,
    marker: 'goal-a:1:marker-a',
    prompt: 'continue goal-a',
  };
  const state = { idle: true, pending: false };
  const ctx = {
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    ui: { notify() {} },
  };
  return { runtime, scheduler, messages, state, ctx };
}

function successorRuntimeHarness(minIntervalMs) {
  const scheduler = createScheduler();
  const messages = [];
  const Runtime = executablePatchedNextRuntime(scheduler);
  const runtime = new Runtime({
    sendUserMessage(prompt, options) {
      messages.push({ prompt, options });
    },
  });
  runtime.settings = { continuationLimits: { minIntervalMs } };
  runtime.activeGoal = { id: 'goal-a', status: 'active' };
  runtime.continuationIntent = {
    goalId: 'goal-a',
    iteration: 1,
    marker: 'goal-a:1:successor',
    prompt: 'continue successor goal',
  };
  const state = { idle: true, pending: false };
  const ctx = {
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    ui: { notify() {} },
  };
  return { runtime, scheduler, messages, state, ctx };
}

function readFixturePackage(root, sessionSourceName = 'lifecycle') {
  return Object.fromEntries(
    ['package.json', 'src/commands.ts', 'src/goal.ts', `src/${sessionSourceName}.ts`, 'src/prompts.ts', 'src/runtime.ts', 'src/settings.ts', 'src/tool-policy.ts']
      .map((path) => [path, readFileSync(join(root, path), 'utf8')]),
  );
}

const FIXTURES_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__');
const PINNED_PACKAGE_ARCHIVE = join(FIXTURES_DIRECTORY, 'pi-goal-0.54.3.tgz');
const PINNED_PACKAGE_INTEGRITY = 'sha512-UgPF7uKm6B9XITmOji3uRJGeeQiBeFODwiiyFe3V3dUPWbCSXUUhvF0RuorkxNnsp1uPN46tELNxK9riBTNMZg==';
const PINNED_PLAN_ARCHIVE = join(FIXTURES_DIRECTORY, 'narumitw-pi-plan-mode-0.55.3.tgz');
const PINNED_PLAN_INTEGRITY = 'sha512-pBLJdDWsANbMmRkTtTUcEJO95WY3tRmbWbS57uKIHsbQ5dc5sStD20R4qpcGXSl/r5tyPVR2Gru/YqwCqpmJ3Q==';

function extractPackage(archivePath, integrity, root) {
  if (archivePath === 'candidate:goal' || archivePath === 'candidate:plan') {
    const key = archivePath.slice('candidate:'.length);
    if (key === 'goal') {
      extractPackage(join(FIXTURES_DIRECTORY, 'pi-goal-0.54.13-source.json'),
        'sha512-g770YeTpnO6MPNpldrBA+MQXNE1hXEeSPmdgBS1wqTZKAMhd3emrPFSmivg7wa3ABcfmfE24plrSvzVgfnez5w==', root);
    } else {
      extractPackage(join(FIXTURES_DIRECTORY, 'narumitw-pi-plan-mode-0.59.2.tgz'),
        'sha512-M91Q8doVHnpXziOnoYV9npEmGghQ0rzAPIGrqwR7SP7L2z6ydGH7Xh3nEoowbZ8DqNCKAluptfQvhHAirtkTyw==', root);
      restoreCandidateSources(root);
    }
    restoreTargetSources(key, root);
    return;
  }
  const archive = readFileSync(archivePath);
  assert.equal(`sha512-${createHash('sha512').update(archive).digest('base64')}`, integrity);
  if (archivePath.endsWith('-source.json')) {
    // Small immutable raw-source capture, not a fabricated npm archive. Every
    // source file was compared with the tagged commit before capture.
    const fixture = JSON.parse(archive);
    assert.equal(fixture.commit, '42738907182c43eb99e5134652fd37e7d06b5e3a');
    extractPackage(join(FIXTURES_DIRECTORY, fixture.baseArchive), fixture.baseIntegrity, root);
    for (const [path, source] of Object.entries(fixture.files)) {
      assert.ok(path === 'package.json' || /^src\/[a-z-]+\.ts$/.test(path));
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    }
    for (const [path, sha256] of Object.entries(fixture.sourceSha256)) {
      assert.equal(createHash('sha256').update(readFileSync(join(root, path))).digest('hex'), sha256, path);
    }
    return;
  }
  execFileSync('tar', ['-xzf', archivePath, '-C', root, '--strip-components=1'], { stdio: 'ignore' });
}

function extractPinnedFixturePackage(root) {
  extractPackage(PINNED_PACKAGE_ARCHIVE, PINNED_PACKAGE_INTEGRITY, root);
}

const PINNED_RUNTIME_STUBS = {
  name: 'pinned-runtime-stubs',
  setup(bundle) {
    bundle.onResolve(
      { filter: /^@(?:earendil-works\/pi-(?:ai|coding-agent|tui)|narumitw\/pi-tui-kit(?:\/editor-status-widget)?)$/ },
      ({ path }) => ({ path, namespace: 'pinned-runtime-stub' }),
    );
    bundle.onLoad({ filter: /.*/, namespace: 'pinned-runtime-stub' }, () => ({
      loader: 'js',
      contents: `
        export const DEFAULT_MAX_BYTES = 50_000;
        export const DEFAULT_MAX_LINES = 2_000;
        export const defineMenu = (definition) => definition;
        export const defineTool = (definition) => definition;
        export const getAgentDir = () => process.cwd();
        export const getMarkdownTheme = () => ({});
        export const isContextOverflow = () => false;
        export const isRetryableAssistantError = () => false;
        export const runMenu = async () => ({ kind: "cancel" });
        export const stripTerminalSequences = (value) => value;
        // Fixture inputs contain no terminal controls; UI sanitation is an
        // external boundary, not the workflow ownership behavior under test.
        export const sanitizeTerminalText = (value) => value;
        export const truncateHead = (content) => ({ content, truncated: false });
        export const truncateToWidth = (value) => value;
        export const withFileMutationQueue = async (_path, operation) => operation();
        export class Markdown {}
        export class EditorStatusWidget {}
      `,
    }));
  },
};

async function bundleFixture(entryPoint, outputPath, exportName = 'default') {
  const { build } = await import('esbuild');
  await build({
    entryPoints: [entryPoint],
    outfile: outputPath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    plugins: [PINNED_RUNTIME_STUBS],
    nodePaths: [join(process.cwd(), 'node_modules')],
  });
  const fixture = await import(`${pathToFileURL(outputPath).href}?fixture=${Date.now()}`);
  return exportName === 'namespace' ? fixture : fixture.default;
}

function createExtensionHarness() {
  const commands = new Map();
  const lifecycle = new Map();
  const eventListeners = new Map();
  const notifications = [];
  const statuses = new Map();
  const entries = [];
  const messages = [];
  const tools = [
    { name: 'read', description: 'Read files', sourceInfo: { source: 'builtin' } },
    { name: 'bash', description: 'Run bounded commands', sourceInfo: { source: 'builtin' } },
    { name: 'edit', description: 'Edit files', sourceInfo: { source: 'builtin' } },
  ];
  let activeTools = [];
  let thinkingLevel = 'medium';
  const sessionManager = {
    getBranch: () => entries,
    getEntries: () => entries,
  };
  const ui = new Proxy({
    notify: (message, level) => notifications.push({ message, level }),
    setStatus: (key, text) => { if (text === undefined) statuses.delete(key); else statuses.set(key, text); },
  }, { get: (target, property) => target[property] ?? (() => undefined) });
  const api = new Proxy({
    events: {
      on(channel, listener) {
        const listeners = eventListeners.get(channel) ?? [];
        listeners.push(listener);
        eventListeners.set(channel, listeners);
        return () => eventListeners.set(channel, listeners.filter((candidate) => candidate !== listener));
      },
      emit(channel, payload) {
        return Promise.all((eventListeners.get(channel) ?? []).map((listener) => listener(payload)));
      },
    },
    registerCommand: (name, definition) => commands.set(name, definition),
    registerTool: (definition) => {
      tools.push({
        ...definition,
        sourceInfo: { source: 'extension', path: 'pinned-fixture' },
      });
      activeTools.push(definition.name);
    },
    registerFlag: () => undefined,
    getFlag: () => false,
    on(name, listener) {
      const listeners = lifecycle.get(name) ?? [];
      listeners.push(listener);
      lifecycle.set(name, listeners);
    },
    appendEntry(customType, data) {
      entries.push({ type: 'custom', customType, data });
    },
    sendUserMessage: async (content, options) => { messages.push({ content, options }); },
    sendMessage: (message) => { entries.push({ type: 'custom_message', ...message }); },
    getAllTools: () => [...tools],
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools) => { activeTools = [...tools]; },
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (level) => { thinkingLevel = level; },
  }, { get: (target, property) => target[property] ?? (() => undefined) });
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    mode: 'interactive',
    sessionManager,
    ui,
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
  return {
    activeTools: () => activeTools,
    api,
    commands,
    ctx,
    emit: (channel, payload) => api.events.emit(channel, payload),
    entries,
    messages,
    notifications,
    statuses,
    tools,
    dispatch: async (name, event = {}) => {
      let result;
      for (const listener of lifecycle.get(name) ?? []) result = await listener(event, ctx) ?? result;
      return result;
    },
    startSession: async () => {
      for (const listener of lifecycle.get('session_start') ?? []) await listener({}, ctx);
    },
    runContext: async () => {
      let event = { messages: [] };
      for (const listener of lifecycle.get('context') ?? []) {
        event = await listener(event, ctx) ?? event;
      }
      return event;
    },
  };
}

it('REQ-AGENT-111 / REQ-OPS-020: reviewed Goal target preparation is repeatable and rejects pristine or prepared source drift atomically', t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-goal-05415-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  extractPackage('candidate:goal', undefined, root);
  patchPiGoalDirectory('0.54.15', root);
  const prepared = readFixturePackage(root);
  patchPiGoalDirectory('0.54.15', root);
  assert.deepEqual(readFixturePackage(root), prepared);
  for (const phase of ['pristine', 'prepared']) {
    for (const path of ['src/commands.ts', 'src/goal.ts', 'src/lifecycle.ts', 'src/prompts.ts',
      'src/runtime.ts', 'src/settings.ts', 'src/tool-policy.ts', 'src/accounting.ts']) {
      const driftRoot = mkdtempSync(join(tmpdir(), `pi-goal-${phase}-drift-`));
      t.after(() => rmSync(driftRoot, { recursive: true, force: true }));
      extractPackage('candidate:goal', undefined, driftRoot);
      if (phase === 'prepared') patchPiGoalDirectory('0.54.15', driftRoot);
      writeFileSync(join(driftRoot, path), readFileSync(join(driftRoot, path), 'utf8') + '\n// unreviewed drift\n');
      const before = readFixturePackage(driftRoot);
      const drift = readFileSync(join(driftRoot, path));
      assert.throws(() => patchPiGoalDirectory('0.54.15', driftRoot), /source digest/);
      assert.deepEqual(readFixturePackage(driftRoot), before, 'validation completes before any write');
      assert.deepEqual(readFileSync(join(driftRoot, path)), drift);
    }
  }
});

it('REQ-AGENT-178: Plan 0.59.6 validates the exact chunk and all destinations before writing', t => {
  const paths = ['src/plan-mode.ts', 'dist/index.ts', 'src/tool-policy.ts', 'dist/chunks/chunk-W7D6N2MI.ts'];
  for (const phase of ['pristine', 'prepared']) {
    for (const path of paths) {
      const root = mkdtempSync(join(tmpdir(), 'pi-plan-0596-identity-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      extractPackage('candidate:plan', undefined, root);
      if (phase === 'prepared') {
        patchPiPlanModeDirectory('0.59.6', root);
        const before = paths.map(path => readFileSync(join(root, path)));
        patchPiPlanModeDirectory('0.59.6', root);
        assert.deepEqual(paths.map(path => readFileSync(join(root, path))), before);
      }
      writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8') + '\n// unreviewed drift\n');
      const before = paths.map(path => readFileSync(join(root, path)));
      assert.throws(() => patchPiPlanModeDirectory('0.59.6', root), /source digest/);
      assert.deepEqual(paths.map(path => readFileSync(join(root, path))), before);
    }
  }
});

it('REQ-AGENT-111 / REQ-AGENT-178: target manifest drift fails before preparing any artifact', t => {
  for (const key of ['goal', 'plan']) {
    for (const field of ['name', 'version', 'entrypoint']) {
      const root = mkdtempSync(join(tmpdir(), `pi-${key}-manifest-`));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      extractPackage(`candidate:${key}`, undefined, root);
      const manifestPath = join(root, 'package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (field === 'entrypoint') manifest.pi.extensions = ['./unreviewed.ts'];
      else manifest[field] = 'unreviewed';
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const paths = key === 'goal'
        ? ['src/commands.ts', 'src/goal.ts', 'src/lifecycle.ts', 'src/prompts.ts', 'src/runtime.ts', 'src/settings.ts', 'src/tool-policy.ts']
        : ['src/plan-mode.ts', 'dist/index.ts', 'src/tool-policy.ts', 'dist/chunks/chunk-W7D6N2MI.ts'];
      paths.push('package.json');
      const before = paths.map(path => readFileSync(join(root, path)));
      assert.throws(() => key === 'goal' ? patchPiGoalDirectory('0.54.15', root) : patchPiPlanModeDirectory('0.59.6', root),
        /identity|version|expected|entrypoint/);
      assert.deepEqual(paths.map(path => readFileSync(join(root, path))), before);
    }
  }
});

describe('REQ-AGENT-111: pi-goal review control and continuation patch', () => {
  for (const goalVersion of ['0.54.13', '0.54.15']) {
  it(`REQ-AGENT-111 / REQ-OPS-020: ${goalVersion} retains queued contract order and custom startup ownership`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pi-goal-contract-queue-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    extractPackage(join(FIXTURES_DIRECTORY, 'pi-goal-0.54.13-source.json'),
      'sha512-g770YeTpnO6MPNpldrBA+MQXNE1hXEeSPmdgBS1wqTZKAMhd3emrPFSmivg7wa3ABcfmfE24plrSvzVgfnez5w==', root);
    if (goalVersion === '0.54.15') restoreTargetSources('goal', root);
    patchPiGoalDirectory(goalVersion, root);
    const { GoalRuntime } = await bundleFixture(join(root, 'src/runtime.ts'), join(root, 'runtime.mjs'), 'namespace');
    const harness = createExtensionHarness();
    const deferred = [];
    harness.api.sendMessage = (message) => deferred.push(message);
    const runtime = new GoalRuntime(harness.api);
    const goal = { id: 'queued-goal', text: 'Retain the full objective', status: 'active', iteration: 0,
      tokensUsed: 0, startedAt: 0, updatedAt: 0, timeUsedSeconds: 0, baselineTokens: 0, automaticModelTurns: 0 };
    runtime.ensureGoalContextContract(harness.ctx, goal);
    runtime.ensureGoalContextContract(harness.ctx, goal);
    assert.deepEqual(deferred.map(message => message.details.state), ['active'], 'identical queued contracts coalesce');
    harness.entries.push({ type: 'custom_message', ...deferred.shift() });
    runtime.ensureInactiveGoalContextContract(harness.ctx);
    runtime.ensureGoalContextContract(harness.ctx, goal);
    assert.deepEqual(deferred.map(message => message.details.state), ['inactive', 'active'], 'queued inactive tail cannot suppress a new active contract');
    assert.equal(deferred.at(-1).details.goalId, goal.id);
    harness.entries.push(...deferred.splice(0).map(message => ({ type: 'custom_message', ...message })));
    runtime.ensureGoalContextContract(harness.ctx, goal);
    assert.deepEqual(deferred, [], 'saved publication retires pending state without duplicate output');

    const extension = await bundleFixture(join(root, 'src/index.ts'), join(root, 'goal.mjs'));
    const session = createExtensionHarness();
    extension(session.api, { settingsPath: join(root, 'settings.json') });
    await session.startSession();
    await session.commands.get('goal').handler('Preserve custom-run ownership', session.ctx);
    const before = session.entries.filter(entry => entry.customType === 'goal-contract');
    const result = await session.dispatch('before_agent_start', { messageType: 'custom',
      message: { customType: 'ci-notification', content: 'CI finished', display: true }, systemPrompt: '' });
    assert.equal(result, undefined, 'custom startup does not inject a Goal boundary');
    assert.deepEqual(session.entries.filter(entry => entry.customType === 'goal-contract'), before);
  });

  }

  it('REQ-AGENT-178: unreviewed Plan command layout fails without partial writes', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pi-plan-policy-drift-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    extractPackage(join(FIXTURES_DIRECTORY, 'narumitw-pi-plan-mode-0.58.3.tgz'),
      'sha512-mC2dOLXrsLedLH4VrX0t3wwdXrr9AccoI8SgvYYn0KewaR6hZ0a6fIyLnReVlnJ4zNcjhdwBKWujrM49EW4zsg==', root);
    const paths = ['src/plan-mode.ts', 'dist/index.ts', 'src/tool-policy.ts', 'dist/chunks/chunk-L2CXUWCH.ts'];
    const chunk = join(root, paths[3]);
    writeFileSync(chunk, readFileSync(chunk, 'utf8').replace('if (matchesConfiguredSafeSubcommand(command, safeSubcommands)) return void 0;', 'return void 0;'));
    const before = paths.map((path) => readFileSync(join(root, path), 'utf8'));
    assert.throws(() => patchPiPlanModeDirectory('0.58.3', root), /command policy anchors/);
    assert.deepEqual(paths.map((path) => readFileSync(join(root, path), 'utf8')), before);
    assert.throws(() => patchPiPlanModeDirectory('0.56.1', root), /Unsupported Plan Mode version/);
    assert.deepEqual(paths.map((path) => readFileSync(join(root, path), 'utf8')), before);
  });
  it('REQ-AGENT-178: transformed pinned Plan candidate rejects unsafe commands and invalid publication', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pi-plan-candidate-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    extractPackage(join(FIXTURES_DIRECTORY, 'narumitw-pi-plan-mode-0.58.3.tgz'),
      'sha512-mC2dOLXrsLedLH4VrX0t3wwdXrr9AccoI8SgvYYn0KewaR6hZ0a6fIyLnReVlnJ4zNcjhdwBKWujrM49EW4zsg==', root);
    patchPiPlanModeDirectory('0.58.3', root);
    // Exercise the generated candidate entrypoint, not a command recorder.
    const extension = await bundleFixture(join(root, 'dist/index.ts'), join(root, 'plan.mjs'));
    const harness = createExtensionHarness();
    extension(harness.api, { settingsPath: join(root, 'settings.json') });
    await harness.startSession();
    harness.api.setActiveTools(['read', 'bash']);
    await harness.commands.get('plan').handler('start', harness.ctx);
    await harness.runContext();
    assert.equal(await harness.dispatch('tool_call', { toolName: 'bash', input: { command: 'git status' } }), undefined);
    const denied = await harness.dispatch('tool_call', { toolName: 'bash', input: { command: 'git status && touch sentinel' } });
    assert.equal(denied?.block, true);
    const complete = harness.tools.find((tool) => tool.name === 'plan_mode_complete');
    for (const plan of ['', '   ', 'x'.repeat(50_001), 42]) {
      await assert.rejects(() => complete.execute('invalid', { plan }, undefined, undefined, harness.ctx));
      assert.equal(harness.entries.filter((entry) => entry.customType === 'plan-mode-state').at(-1).data.latestPlan, undefined);
    }
    const candidate = '# Exact candidate\n\nPreserve every decision.';
    const published = await complete.execute('valid', { plan: `  ${candidate}\n` }, undefined, undefined, harness.ctx);
    assert.equal(published.details.plan, candidate);
    assert.equal(published.content[0].text, `**Proposed Plan**\n\n${candidate}`);
    assert.equal(harness.entries.filter((entry) => entry.customType === 'plan-mode-state').at(-1).data.latestPlan, candidate);
    await harness.commands.get('plan').handler('exit', harness.ctx);
    await harness.dispatch('session_shutdown');
  });

  for (const targetVersion of ['0.59.4', '0.59.6']) {
  it(`REQ-AGENT-178: Plan ${targetVersion} prepares both entrypoints with registered-tool policy and parsed shell authorization`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-plan-0594-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    extractPackage(join(FIXTURES_DIRECTORY, 'narumitw-pi-plan-mode-0.59.2.tgz'),
      'sha512-M91Q8doVHnpXziOnoYV9npEmGghQ0rzAPIGrqwR7SP7L2z6ydGH7Xh3nEoowbZ8DqNCKAluptfQvhHAirtkTyw==', root);
    restoreCandidateSources(root);
    if (targetVersion === '0.59.6') restoreTargetSources('plan', root);
    const paths = ['src/plan-mode.ts', 'dist/index.ts', 'src/tool-policy.ts', targetVersion === '0.59.6' ? 'dist/chunks/chunk-W7D6N2MI.ts' : 'dist/chunks/chunk-MJV6WNHK.ts'];
    // Qualify the native no-op before applying any compatibility preparation.
    for (const [index, entry] of paths.slice(0, 2).entries()) {
      const native = await bundleFixture(join(root, entry), join(root, `native-${index}.mjs`));
      const harness = createExtensionHarness();
      native(harness.api, { settingsPath: join(root, `native-settings-${index}.json`) });
      await harness.startSession();
      harness.api.setActiveTools(harness.tools.map(tool => tool.name));
      await harness.commands.get('plan').handler('start', harness.ctx);
      await harness.runContext();
      const plan = '# Upstream intent\n\nThe native boundary preserves this plan.';
      await harness.tools.find(tool => tool.name === 'plan_mode_complete')
        .execute('native-publish', { plan }, undefined, undefined, harness.ctx);
      const current = () => harness.entries.filter(entry => entry.customType === 'plan-mode-state').at(-1).data;
      await harness.dispatch('before_agent_start', { messageType: 'custom',
        message: { customType: 'ci-notification', content: 'CI finished', display: true }, systemPrompt: '' });
      assert.equal(current().latestPlan, plan);
      assert.equal(current().awaitingAction, true);
      await harness.dispatch('before_agent_start', { messageType: 'user', prompt: 'Revise the plan', systemPrompt: '' });
      assert.equal(current().latestPlan, undefined);
      assert.equal(current().awaitingAction, false);
      await harness.commands.get('plan').handler('exit', harness.ctx);
      await harness.dispatch('session_shutdown');
    }
    patchPiPlanModeDirectory(targetVersion, root);
    const prepared = paths.map(path => readFileSync(join(root, path)));
    patchPiPlanModeDirectory(targetVersion, root);
    assert.deepEqual(paths.map(path => readFileSync(join(root, path))), prepared,
      'repeat preparation preserves all generated artifacts');
    for (const [index, entry] of ['src/plan-mode.ts', 'dist/index.ts'].entries()) {
      const extension = await bundleFixture(join(root, entry), join(root, `plan-${index}.mjs`));
      const harness = createExtensionHarness();
      extension(harness.api, { settingsPath: join(root, `settings-${index}.json`) });
      await harness.startSession();
      harness.api.setActiveTools(['read']);
      await harness.commands.get('plan').handler('start', harness.ctx);
      await harness.runContext();
      const state = harness.entries.filter(entry => entry.customType === 'plan-mode-state').at(-1).data;
      assert.equal(state.enabled, true);
      assert.deepEqual(state.workflowToolPolicy.allowedNames, ['bash', 'read']);
      assert.deepEqual(harness.activeTools(), ['read'], 'policy capture does not expand ordinary provider exposure');
      assert.equal(await harness.dispatch('tool_call', { toolName: 'read', input: { path: 'README.md' } }), undefined);
      assert.equal((await harness.dispatch('tool_call', { toolName: 'edit', input: {} }))?.block, true);
      for (const plan of ['', '   ', 42]) {
        await assert.rejects(() => harness.tools.find(tool => tool.name === 'plan_mode_complete')
          .execute('invalid', { plan }, undefined, undefined, harness.ctx));
      }
      const plan = '# Native custom-turn boundary\n\nRetain the published user intent.';
      const complete = harness.tools.find(tool => tool.name === 'plan_mode_complete');
      await complete.execute('publish', { plan }, undefined, undefined, harness.ctx);
      const current = () => harness.entries.filter(entry => entry.customType === 'plan-mode-state').at(-1).data;
      await harness.dispatch('before_agent_start', { messageType: 'custom',
        message: { customType: 'ci-notification', content: 'CI finished', display: true }, systemPrompt: '' });
      assert.equal(current().latestPlan, plan, 'upstream custom-turn boundary needs no second patch');
      assert.equal(current().awaitingAction, true);
      await harness.dispatch('before_agent_start', { messageType: 'user', prompt: 'Revise the plan', systemPrompt: '' });
      assert.equal(current().latestPlan, undefined);
      assert.equal(current().awaitingAction, false);
      await harness.commands.get('plan').handler('exit', harness.ctx);
      await harness.dispatch('session_shutdown');
    }
    for (const [index, path] of paths.slice(2).entries()) {
      const policy = await bundleFixture(join(root, path), join(root, `parsed-${index}.mjs`), 'namespace');
      for (const check of [policy.findBlockedCommandSegment, policy.findBlockedPowerShellCommandSegment]) {
        const configured = { git: ['status', 'diff'], gh: ['pr view'] };
        assert.equal(check('git status', configured), undefined);
        for (const command of ['git status; touch sentinel', 'git status && rm sentinel', 'git status > sentinel',
          'git status $(touch sentinel)', 'git status | sh', 'git diff --output=sentinel', 'gh pr view --json title --web']) {
          assert.notEqual(check(command, configured), undefined, command);
        }
      }
    }
    writeFileSync(join(root, paths[0]), Buffer.concat([prepared[0], Buffer.from('\n// drift after preparation\n')]));
    const drifted = paths.map(path => readFileSync(join(root, path)));
    assert.throws(() => patchPiPlanModeDirectory(targetVersion, root), /source digest/);
    assert.deepEqual(paths.map(path => readFileSync(join(root, path))), drifted,
      'repeat preparation rejects drift before any artifact write');
  });

  }

  for (const version of ['0.59.2', '0.59.4']) {
  it(`REQ-AGENT-152 AC5 / REQ-AGENT-178: candidate Plan ${version} retains published user intent through custom turns but invalidates it on a user prompt`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pi-plan-custom-turn-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    extractPackage(join(FIXTURES_DIRECTORY, 'narumitw-pi-plan-mode-0.59.2.tgz'),
      'sha512-M91Q8doVHnpXziOnoYV9npEmGghQ0rzAPIGrqwR7SP7L2z6ydGH7Xh3nEoowbZ8DqNCKAluptfQvhHAirtkTyw==', root);
    if (version === '0.59.4') restoreCandidateSources(root);
    patchPiPlanModeDirectory(version, root);
    const extension = await bundleFixture(join(root, 'dist/index.ts'), join(root, 'plan.mjs'));
    const harness = createExtensionHarness();
    extension(harness.api, { settingsPath: join(root, 'settings.json') });
    await harness.startSession();
    harness.api.setActiveTools(['read', 'bash']);
    await harness.commands.get('plan').handler('start', harness.ctx);
    await harness.runContext();
    const plan = '# Published intent\n\nKeep the reviewed decisions until the user acts.';
    await harness.tools.find(tool => tool.name === 'plan_mode_complete')
      .execute('publish', { plan }, undefined, undefined, harness.ctx);
    const state = () => harness.entries.filter(entry => entry.customType === 'plan-mode-state').at(-1).data;
    assert.equal(state().latestPlan, plan);
    assert.equal(state().awaitingAction, true);
    await harness.dispatch('before_agent_start', { messageType: 'custom',
      message: { customType: 'ci-notification', content: 'CI finished', display: true }, systemPrompt: '' });
    assert.equal(state().latestPlan, plan);
    assert.equal(state().awaitingAction, true);
    await harness.dispatch('before_agent_start', { messageType: 'user', prompt: 'Revise the proposed plan', systemPrompt: '' });
    assert.equal(state().latestPlan, undefined);
    assert.equal(state().awaitingAction, false);
    await harness.commands.get('plan').handler('exit', harness.ctx);
    await harness.dispatch('session_shutdown');
  });

  it(`REQ-AGENT-178: candidate Plan ${version} chunk drift rejects the complete transform without partial writes`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pi-plan-candidate-drift-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    extractPackage(join(FIXTURES_DIRECTORY, 'narumitw-pi-plan-mode-0.59.2.tgz'),
      'sha512-M91Q8doVHnpXziOnoYV9npEmGghQ0rzAPIGrqwR7SP7L2z6ydGH7Xh3nEoowbZ8DqNCKAluptfQvhHAirtkTyw==', root);
    if (version === '0.59.4') restoreCandidateSources(root);
    const paths = ['package.json', 'src/plan-mode.ts', 'dist/index.ts', 'src/tool-policy.ts', 'dist/chunks/chunk-MJV6WNHK.ts'];
    const chunk = join(root, paths.at(-1));
    writeFileSync(chunk, readFileSync(chunk, 'utf8').replace('if (matchesConfiguredSafeSubcommand(segment, safeSubcommands)) return true;', 'return true;'));
    const before = paths.map(path => readFileSync(join(root, path), 'utf8'));
    assert.throws(() => patchPiPlanModeDirectory(version, root), /command policy anchors|source digest/);
    assert.deepEqual(paths.map(path => readFileSync(join(root, path), 'utf8')), before);
  });

  }

  it('REQ-AGENT-111: latest Goal drift fails before writing any candidate package file', (t) => {
    for (const kind of ['version', 'entrypoint', 'runtime']) {
      const root = mkdtempSync(join(tmpdir(), `pi-goal-latest-${kind}-`));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      extractPackage(join(FIXTURES_DIRECTORY, 'pi-goal-0.54.8.tgz'),
        'sha512-ba165WkOdBEQNYgjTa2MHgRtOh/hTLveObPzdoE29FOrfktymcBlayEHoXd9Jjw44VQ8bX7cq6V57zp0rJLVgQ==', root);
      if (kind === 'runtime') {
        const path = join(root, 'src/runtime.ts');
        writeFileSync(path, readFileSync(path, 'utf8').replace('this.continuationDispatchTimer = setTimeout(() => {', 'this.continuationDispatchTimer = queueMicrotask(() => {'));
      } else {
        const path = join(root, 'package.json');
        const manifest = JSON.parse(readFileSync(path, 'utf8'));
        if (kind === 'version') manifest.version = '0.54.9';
        else manifest.pi.extensions = ['./unknown.ts'];
        writeFileSync(path, JSON.stringify(manifest));
      }
      const before = readFixturePackage(root);
      assert.throws(() => patchPiGoalDirectory('0.54.8', root));
      // No-partial-write artifact contract: all patch destinations stay byte-identical.
      assert.deepEqual(readFixturePackage(root), before);
    }
  });

  for (const versions of [
    { goal: '0.54.15', plan: '0.59.6', goalArchive: 'candidate:goal', planArchive: 'candidate:plan' },
    { goal: EXPECTED_PI_GOAL_VERSION, plan: EXPECTED_PI_PLAN_MODE_VERSION,
      goalArchive: PINNED_PACKAGE_ARCHIVE, goalIntegrity: PINNED_PACKAGE_INTEGRITY,
      planArchive: PINNED_PLAN_ARCHIVE, planIntegrity: PINNED_PLAN_INTEGRITY },
    { goal: '0.54.4', plan: '0.56.0',
      goalArchive: join(FIXTURES_DIRECTORY, 'pi-goal-0.54.4.tgz'),
      goalIntegrity: 'sha512-WqGGYnX5YBaEUlkC2Lh3sFHizJ6/hiGBijybOBv/7RRDZvpMdfygORIl5OHhzqSPekC9+z0ROxiCzPE6hS17jQ==',
      planArchive: join(FIXTURES_DIRECTORY, 'narumitw-pi-plan-mode-0.56.0.tgz'),
      planIntegrity: 'sha512-sxbIODVaV6Ct+eD+lDN+tEn0mKtU9PG7rkkVhF6EC1d7t6YLHi1ixFhrKwMrJmsAPfkCnBKKImJcXx/bMFateg==' },
    { goal: '0.54.8', plan: '0.58.3',
      goalArchive: join(FIXTURES_DIRECTORY, 'pi-goal-0.54.8.tgz'),
      goalIntegrity: 'sha512-ba165WkOdBEQNYgjTa2MHgRtOh/hTLveObPzdoE29FOrfktymcBlayEHoXd9Jjw44VQ8bX7cq6V57zp0rJLVgQ==',
      planArchive: join(FIXTURES_DIRECTORY, 'narumitw-pi-plan-mode-0.58.3.tgz'),
      planIntegrity: 'sha512-mC2dOLXrsLedLH4VrX0t3wwdXrr9AccoI8SgvYYn0KewaR6hZ0a6fIyLnReVlnJ4zNcjhdwBKWujrM49EW4zsg==' },
    { goal: '0.54.13', plan: '0.59.4',
      goalArchive: join(FIXTURES_DIRECTORY, 'pi-goal-0.54.13-source.json'),
      goalIntegrity: 'sha512-g770YeTpnO6MPNpldrBA+MQXNE1hXEeSPmdgBS1wqTZKAMhd3emrPFSmivg7wa3ABcfmfE24plrSvzVgfnez5w==',
      planArchive: join(FIXTURES_DIRECTORY, 'narumitw-pi-plan-mode-0.59.2.tgz'),
      planIntegrity: 'sha512-M91Q8doVHnpXziOnoYV9npEmGghQ0rzAPIGrqwR7SP7L2z6ydGH7Xh3nEoowbZ8DqNCKAluptfQvhHAirtkTyw==' },
    { goal: '0.54.11', plan: '0.59.2',
      goalArchive: join(FIXTURES_DIRECTORY, 'pi-goal-0.54.11.tgz'),
      goalIntegrity: 'sha512-dq19XrMMUYto1q6FDFGxXVbLIu3ZLNpPCw+/Oe1XxIXRVx7FGTp8iVT/jPT5egXjrb6e7jSiJGw5Z77ZGtw3YA==',
      planArchive: join(FIXTURES_DIRECTORY, 'narumitw-pi-plan-mode-0.59.2.tgz'),
      planIntegrity: 'sha512-M91Q8doVHnpXziOnoYV9npEmGghQ0rzAPIGrqwR7SP7L2z6ydGH7Xh3nEoowbZ8DqNCKAluptfQvhHAirtkTyw==' },
  ]) {
  describe(`Goal ${versions.goal}, Plan ${versions.plan}`, () => {
  it('REQ-AGENT-111 AC7: publishes concise Goal status without changing accounting or continuation details', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pi-goal-status-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    extractPackage(versions.goalArchive, versions.goalIntegrity, root);
    patchPiGoalDirectory(versions.goal, root);
    patchPiGoalDirectory(versions.goal, root);
    const { GoalRuntime, goalSummary } = await bundleFixture(join(root, 'src/runtime.ts'), join(root, 'runtime.mjs'), 'namespace');
    const { formatDuration } = await bundleFixture(join(root, 'src/accounting.ts'), join(root, 'accounting.mjs'), 'namespace');
    const harness = createExtensionHarness();
    const runtime = new GoalRuntime(harness.api);
    const goal = { id: 'goal-status', text: 'status presentation', status: 'active', iteration: 4,
      tokensUsed: 250, startedAt: 0, updatedAt: 0, timeUsedSeconds: 63180, baselineTokens: 0, automaticModelTurns: 10 };
    for (const automaticTurns of [null, 10, 25]) {
      runtime.settings = { ...runtime.settings, continuationLimits: { ...runtime.settings.continuationLimits, automaticTurns } };
      for (const tokenBudget of [undefined, 1000]) {
        runtime.updateStatus(harness.ctx, { ...goal, tokenBudget });
        assert.equal(harness.statuses.get('goal'), 'goal - active 17h 33m');
      }
      for (const [status, expected] of [['blocked', 'blocked'], ['paused', 'paused'], ['usage_limited', 'usage limited'],
        ['budget_limited', 'budget limited'], ['complete', 'complete']]) {
        runtime.updateStatus(harness.ctx, { ...goal, status, tokenBudget: 1000 });
        assert.equal(harness.statuses.get('goal'), `goal - ${expected}`);
      }
      for (const safetyPauseCause of ['continuation_limit', 'no_progress']) {
        runtime.updateStatus(harness.ctx, { ...goal, status: 'paused', safetyPauseCause });
        assert.equal(harness.statuses.get('goal'), 'goal - paused');
      }
      runtime.updateStatus(harness.ctx, { ...goal, waiting: { reason: 'external event', resumeAt: 1000 } });
      assert.equal(harness.statuses.get('goal'), 'goal - waiting');
      const summary = goalSummary({ ...goal, tokenBudget: 1000 }, automaticTurns);
      assert.match(summary, /automatic/i);
      assert.match(summary, /250/);
      assert.match(summary, /1k|1,000|1000/i);
    }
    runtime.updateStatus(harness.ctx, { ...goal, timeUsedSeconds: 59 });
    assert.equal(harness.statuses.get('goal'), 'goal - active 59s');
    assert.equal(formatDuration(63180), '17h33m');
  });

  it('REQ-AGENT-111 AC7: unknown Goal status formatter fails before any package bytes are written', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pi-goal-status-drift-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    extractPackage(versions.goalArchive, versions.goalIntegrity, root);
    const paths = ['package.json', 'src/commands.ts', 'src/goal.ts', 'src/lifecycle.ts', 'src/prompts.ts', 'src/runtime.ts', 'src/settings.ts', 'src/tool-policy.ts'];
    const runtimePath = join(root, 'src/runtime.ts');
    writeFileSync(runtimePath, readFileSync(runtimePath, 'utf8').replace('return "complete";', 'return "unknown-status-layout";'));
    const before = paths.map(path => readFileSync(join(root, path), 'utf8'));
    assert.throws(() => patchPiGoalDirectory(versions.goal, root), /Goal status formatter|Goal source digest/);
    assert.deepEqual(paths.map(path => readFileSync(join(root, path), 'utf8')), before);
  });

  it('REQ-AGENT-111 AC2/AC6 / REQ-AGENT-178 AC1/AC2: declared pinned Goal entrypoint carries review control and workflow ownership', async () => {
    const goalRoot = mkdtempSync(join(tmpdir(), 'pi-goal-integration-'));
    const planRoot = mkdtempSync(join(tmpdir(), 'pi-plan-integration-'));
    extractPackage(versions.goalArchive, versions.goalIntegrity, goalRoot);
    extractPackage(versions.planArchive, versions.planIntegrity, planRoot);
    if (versions.plan === '0.59.4') restoreCandidateSources(planRoot);
    patchPiGoalDirectory(versions.goal, goalRoot);
    patchPiPlanModeDirectory(versions.plan, planRoot);
    const patchedPlan = readFileSync(join(planRoot, 'dist/index.ts'), 'utf8');
    patchPiPlanModeDirectory(versions.plan, planRoot);
    assert.equal(readFileSync(join(planRoot, 'dist/index.ts'), 'utf8'), patchedPlan);
    assert.throws(
      () => patchPiPlanModeDirectory('0.55.2', planRoot),
      /Unsupported Plan Mode version/,
    );
    const goalAfter = readFixturePackage(goalRoot);
    patchPiGoalDirectory(versions.goal, goalRoot);
    assert.deepEqual(readFixturePackage(goalRoot), goalAfter);
    if (versions.plan === '0.56.0' || versions.plan === '0.58.3' || versions.plan === '0.59.2' || versions.plan === '0.59.6') {
      const configured = { git: ['status', 'diff'], gh: ['pr view'] };
      const policyChunk = versions.plan === '0.59.6' ? 'dist/chunks/chunk-W7D6N2MI.ts' : versions.plan === '0.59.2' ? 'dist/chunks/chunk-MJV6WNHK.ts'
        : versions.plan === '0.58.3' ? 'dist/chunks/chunk-L2CXUWCH.ts' : 'dist/chunks/chunk-57OBPS7P.js';
      for (const [index, file] of ['src/tool-policy.ts', policyChunk].entries()) {
        const policy = await bundleFixture(join(planRoot, file), join(planRoot, `policy-${index}.mjs`), 'namespace');
        for (const check of [policy.findBlockedCommandSegment, policy.findBlockedPowerShellCommandSegment]) {
          assert.equal(check('git status', configured), undefined);
          for (const command of ['git status; touch sentinel', 'git status && rm sentinel', 'git status > sentinel', 'git status $(touch sentinel)', 'git status | sh', 'git diff --output=sentinel', 'gh pr view --json title --web']) {
            assert.notEqual(check(command, configured), undefined, command);
          }
        }
      }
    }
    const goalManifest = JSON.parse(readFileSync(join(goalRoot, 'package.json'), 'utf8'));
    assert.deepEqual(goalManifest.pi?.extensions, ['./src/index.ts']);
    const goalExtension = await bundleFixture(join(goalRoot, goalManifest.pi.extensions[0]), join(goalRoot, 'goal.mjs'));
    const planExtension = await bundleFixture(join(planRoot, 'dist/index.ts'), join(planRoot, 'plan.mjs'));
    const harness = createExtensionHarness();
    goalExtension(harness.api, { settingsPath: join(goalRoot, 'settings.json') });
    planExtension(harness.api, { settingsPath: join(planRoot, 'settings.json') });
    await harness.startSession();
    harness.api.setActiveTools(['read']);
    assert.ok(!harness.activeTools().includes('goal_complete'));

    await harness.commands.get('goal').handler('first integration objective', harness.ctx);
    assert.equal(harness.entries.at(-1)?.data?.goal?.status, 'active');
    assert.ok(harness.activeTools().includes('goal_complete'));
    assert.ok(harness.activeTools().includes('goal_blocked'));
    assert.ok(harness.activeTools().includes('goal_wait'));
    await harness.commands.get('plan').handler('start', harness.ctx);
    assert.ok(!harness.activeTools().includes('plan_mode_complete'));
    assert.match(harness.notifications.at(-1).message, /Another workflow is active/);

    await harness.commands.get('goal').handler('clear', harness.ctx);
    assert.equal(harness.statuses.has('goal'), false);
    harness.api.setActiveTools(['read']);
    await harness.commands.get('plan').handler('start', harness.ctx);
    await harness.runContext();
    const planState = harness.entries.at(-1);
    assert.equal(planState?.customType, 'plan-mode-state');
    assert.equal(planState?.data?.enabled, true);
    assert.ok(planState?.data?.workflowToolPolicy?.resolved);
    assert.deepEqual(planState.data.workflowToolPolicy.allowedNames, ['bash', 'read']);
    assert.deepEqual(harness.activeTools(), ['read']);
    await harness.commands.get('goal').handler('must not replace active Plan', harness.ctx);
    assert.match(harness.notifications.at(-1).message, /Another workflow is active/);
    assert.notEqual(harness.entries.filter(entry => entry.customType === 'goal-state').at(-1)?.data?.goal?.status, 'active');
    assert.equal(harness.entries.filter(entry => entry.customType === 'plan-mode-state').at(-1)?.data?.enabled, true);
    assert.ok(!harness.activeTools().includes('goal_complete'));
    await harness.commands.get('plan').handler('exit', harness.ctx);
    await harness.commands.get('goal').handler('second integration objective', harness.ctx);
    assert.equal(harness.entries.at(-1)?.data?.goal?.status, 'active');
    assert.ok(harness.activeTools().includes('goal_complete'));
    assert.ok(harness.activeTools().includes('goal_blocked'));
    assert.ok(harness.activeTools().includes('goal_wait'));

    const activeGoalId = harness.entries
      .filter((entry) => entry.data?.goal?.status === 'active')
      .at(-1)?.data.goal.id;
    assert.equal(typeof activeGoalId, 'string');
    let response;
    await harness.emit(CONTROL_CHANNEL, {
      action: 'pause',
      goalId: activeGoalId,
      accepted: () => undefined,
      respond: (value) => { response = value; },
    });
    assert.equal(response?.status, 'paused');
    const pausedGoalId = response?.goalId;
    await harness.emit(CONTROL_CHANNEL, {
      action: 'resume',
      goalId: pausedGoalId,
      respond: (value) => { response = value; },
    });
    assert.equal(response?.ok, true);
    assert.equal(response?.status, 'active');
    assert.notEqual(response?.goalId, pausedGoalId);
    if (versions.goal === '0.54.8' || versions.goal === '0.54.11' || versions.goal === '0.54.13' || versions.goal === '0.54.15') {
      const complete = harness.tools.find((tool) => tool.name === 'goal_complete');
      await harness.dispatch('before_agent_start', { prompt: 'Continue the resumed objective', systemPrompt: '' });
      await harness.dispatch('agent_start');
      const rejected = await complete.execute('stale-completion', { goal_id: pausedGoalId, summary: 'Verified all requirements' }, undefined, undefined, harness.ctx);
      assert.match(rejected.content[0].text, /goal_id does not match the active goal/);
      assert.notEqual(rejected.terminate, true);
      assert.equal(harness.entries.filter((entry) => entry.customType === 'goal-state').at(-1).data.goal.status, 'active');
      const accepted = await complete.execute('current-completion', { goal_id: response.goalId, summary: 'Verified all requirements' }, undefined, undefined, harness.ctx);
      assert.equal(accepted.terminate, true);
      assert.match(accepted.content[0].text, /Goal complete/);
    }
  });

  });
  }

  it('REQ-AGENT-111: emits compact Goal prompts without blocked or wait tool coaching', async (t) => {
    const goalRoot = mkdtempSync(join(tmpdir(), 'pi-goal-prompt-'));
    t.after(() => rmSync(goalRoot, { recursive: true, force: true }));
    extractPackage(join(FIXTURES_DIRECTORY, 'pi-goal-0.54.8.tgz'),
      'sha512-ba165WkOdBEQNYgjTa2MHgRtOh/hTLveObPzdoE29FOrfktymcBlayEHoXd9Jjw44VQ8bX7cq6V57zp0rJLVgQ==', goalRoot);
    patchPiGoalDirectory('0.54.8', goalRoot);
    const prompts = await bundleFixture(join(goalRoot, 'src/prompts.ts'), join(goalRoot, 'prompts.mjs'), 'namespace');
    const goal = {
      id: 'goal-id',
      text: 'complete every open task',
      status: 'active',
      iteration: 4,
      tokensUsed: 0,
      startedAt: 0,
      updatedAt: 0,
      timeUsedSeconds: 0,
      baselineTokens: 0,
    };

    const continuation = prompts.buildContinuePrompt(goal, 'marker');
    assert.ok(continuation.length < 1_600, `continuation prompt grew to ${continuation.length} characters`);
    assert.match(continuation, /complete every open task/);
    assert.match(continuation, /goal_complete/);
    assert.doesNotMatch(continuation, /goal_blocked|goal_wait/);
    const waitingResume = prompts.buildWaitingResumePrompt(goal, 'waiting for user confirmation');
    assert.ok(waitingResume.length < 1_600, `waiting prompt grew to ${waitingResume.length} characters`);
    assert.doesNotMatch(waitingResume, /goal_blocked|goal_wait/);
    assert.match(waitingResume, /external_wait_reason/);

    // Goal prompt copy contract: every entry/resume/system/continuation output
    // carries the authoritative objective and exact completion stale-turn guard.
    for (const prompt of [prompts.buildGoalPrompt(goal), prompts.buildResumePrompt(goal, 'paused'),
      prompts.buildGoalSystemPrompt(goal), continuation, waitingResume]) {
      assert.match(prompt, /complete every open task/);
      assert.match(prompt, /<goal_id>\n?goal-id\n?<\/goal_id>/);
      assert.match(prompt, /goal_complete/);
      assert.doesNotMatch(prompt, /goal_blocked|goal_wait/);
      assert.ok(prompt.length < 1_600);
    }
  });

  it('REQ-AGENT-111/REQ-AGENT-112/REQ-AGENT-114/REQ-AGENT-144: executes the session-bound pause/resume control contract', async () => {
    const { runtime, controller, lifecycle, events } = executablePatchedGoal();
    runtime.activeGoal = { id: 'goal-a', status: 'active' };
    const ctx = { session: 'current' };
    await lifecycle.get('session_start')({}, ctx);

    let accepted = 0;
    let response;
    await events.get(CONTROL_CHANNEL)({
      action: 'pause',
      goalId: 'goal-a',
      accepted: () => { accepted += 1; },
      respond: (value) => { response = value; },
    });
    assert.equal(accepted, 1);
    assert.deepEqual(controller.pauseOptions, [{ abortTurn: false }]);
    assert.deepEqual(response, { ok: true, goalId: 'goal-a', status: 'paused' });

    await events.get(CONTROL_CHANNEL)({
      action: 'resume',
      goalId: 'goal-a',
      respond: (value) => { response = value; },
    });
    assert.deepEqual(controller.resumeOptions, [{ sendPrompt: false }]);
    assert.deepEqual(response, { ok: true, goalId: 'resumed-goal', status: 'active' });

    lifecycle.get('session_shutdown')({}, ctx);
    await events.get(CONTROL_CHANNEL)({
      action: 'pause',
      goalId: 'resumed-goal',
      respond: (value) => { response = value; },
    });
    assert.deepEqual(response, { ok: false, goalId: 'resumed-goal', status: 'active' });
  });

  it('REQ-AGENT-144: preserves manual pause aborts while trusted review pause can suppress them', () => {
    let aborts = 0;
    let continuationCancellations = 0;
    const Controller = executablePatchedController(() => { aborts += 1; });
    const runtime = {
      activeGoal: { id: 'goal-a', status: 'active' },
      recordGoalUsage() {},
      cancelContinuationWork() { continuationCancellations += 1; },
      clearBudgetWrapUp() {},
      blockStaleGoalToolCalls() {},
      persistGoal() {},
      updateStatus() {},
    };
    const controller = new Controller(runtime);

    controller.pauseGoal({ session: 'manual' });
    assert.equal(aborts, 1);
    assert.equal(continuationCancellations, 1);
    assert.equal(runtime.activeGoal.status, 'paused');

    runtime.activeGoal = { id: 'goal-b', status: 'active' };
    controller.pauseGoal({ session: 'review' }, { abortTurn: false });
    assert.equal(aborts, 1);
    assert.equal(continuationCancellations, 2);
    assert.equal(runtime.activeGoal.status, 'paused');
  });

  it('REQ-AGENT-144: executes successor command forwarding and runtime pause semantics together', () => {
    let aborts = 0;
    const scheduler = createScheduler();
    const Runtime = executablePatchedNextRuntime(scheduler, () => { aborts += 1; });
    const Controller = executablePatchedNextController();
    const runtime = new Runtime({ sendUserMessage() {} });
    const controller = new Controller(runtime);

    runtime.activeGoal = { id: 'goal-a', status: 'active' };
    controller.pauseGoal({ session: 'manual' });
    assert.equal(aborts, 1);
    assert.equal(runtime.activeGoal.status, 'paused');

    runtime.activeGoal = { id: 'goal-b', status: 'active' };
    controller.pauseGoal({ session: 'review' }, { abortTurn: false });
    assert.equal(aborts, 1);
    assert.equal(runtime.activeGoal.status, 'paused');
  });

  it('REQ-AGENT-130 AC1: successor zero delay dispatches immediately', () => {
    const { runtime, scheduler, messages, ctx } = successorRuntimeHarness(0);

    assert.equal(runtime.dispatchContinuationIfSettled(ctx), true);
    assert.deepEqual(scheduler.armedDelays(), []);
    assert.deepEqual(messages, [{
      prompt: 'continue successor goal',
      options: { deliverAs: 'followUp' },
    }]);
  });

  it('REQ-AGENT-130 AC2: successor direct dispatch waits the configured interval', () => {
    const { runtime, scheduler, messages, ctx } = successorRuntimeHarness(25);

    assert.equal(runtime.dispatchContinuationIfSettled(ctx), true);
    assert.deepEqual(scheduler.armedDelays(), [25]);
    scheduler.advance(24);
    assert.deepEqual(messages, []);
    scheduler.advance(1);
    assert.deepEqual(messages, [{
      prompt: 'continue successor goal',
      options: { deliverAs: 'followUp' },
    }]);
  });

  it('REQ-AGENT-130 AC3: successor scheduler re-arms delays beyond the Node timer maximum', () => {
    const { runtime, scheduler, messages, ctx } = successorRuntimeHarness(2_147_483_652);

    assert.equal(runtime.dispatchContinuationIfSettled(ctx), true);
    assert.deepEqual(scheduler.armedDelays(), [2_147_483_647]);
    scheduler.advance(2_147_483_647);
    assert.deepEqual(scheduler.armedDelays(), [2_147_483_647, 5]);
    assert.deepEqual(messages, []);
    scheduler.advance(5);
    assert.equal(messages.length, 1);
  });

  it('REQ-AGENT-130 AC4: successor settled activity restarts one pending interval', () => {
    const { runtime, scheduler, messages, ctx } = successorRuntimeHarness(25);

    assert.equal(runtime.dispatchContinuationIfSettled(ctx), true);
    scheduler.advance(20);
    assert.equal(runtime.dispatchContinuationIfSettled(ctx), true);
    assert.equal(scheduler.pendingCount(), 1);
    assert.deepEqual(scheduler.armedDelays(), [25, 25]);
    scheduler.advance(5);
    assert.deepEqual(messages, []);
    scheduler.advance(20);
    assert.equal(messages.length, 1);
  });

  it('REQ-AGENT-130 AC5: successor cancellation clears its pending dispatch', () => {
    const { runtime, scheduler, messages, ctx } = successorRuntimeHarness(25);

    assert.equal(runtime.dispatchContinuationIfSettled(ctx), true);
    runtime.cancelContinuationWork();
    assert.equal(scheduler.pendingCount(), 0);
    scheduler.advance(25);
    assert.deepEqual(messages, []);
    assert.equal(runtime.continuationIntent, undefined);
  });

  it('REQ-AGENT-130 AC6: successor scheduler rejects a replacement continuation marker', () => {
    const { runtime, scheduler, messages, ctx } = successorRuntimeHarness(25);

    assert.equal(runtime.dispatchContinuationIfSettled(ctx), true);
    runtime.continuationIntent = {
      goalId: 'goal-a',
      iteration: 2,
      marker: 'goal-a:2:new',
      prompt: 'new continuation',
    };
    scheduler.advance(25);
    assert.deepEqual(messages, []);
    assert.equal(runtime.continuationIntent.marker, 'goal-a:2:new');
  });

  it('REQ-AGENT-130 AC7: successor busy expiry retains intent for the next settled boundary', () => {
    const { runtime, scheduler, messages, state, ctx } = successorRuntimeHarness(25);

    assert.equal(runtime.dispatchContinuationIfSettled(ctx), true);
    state.idle = false;
    scheduler.advance(25);
    assert.deepEqual(messages, []);
    assert.equal(runtime.continuationIntent.marker, 'goal-a:1:successor');

    state.idle = true;
    assert.equal(runtime.dispatchContinuationIfSettled(ctx), true);
    scheduler.advance(25);
    assert.equal(messages.length, 1);
  });

  it('REQ-AGENT-114: suppresses only the bridge-owned resume prompt', async () => {
    const promptCalls = [];
    const Controller = executablePatchedController();
    const controller = new Controller({
      sendOwnedGoalPrompt: async (...args) => {
        promptCalls.push(args);
        return true;
      },
    });

    assert.equal(await controller.resumeGoal({ session: 'bridge' }, { sendPrompt: false }), true);
    assert.deepEqual(promptCalls, []);

    assert.equal(await controller.resumeGoal({ session: 'user' }), true);
    assert.deepEqual(promptCalls, [[{ session: 'user' }, 'resumed-goal', 'resumed-goal:paused']]);
  });

  it('REQ-AGENT-130 AC2: waits the configured 60 seconds before continuation dispatch', () => {
    const { runtime, scheduler, messages, ctx } = runtimeHarness(60_000);

    assert.equal(runtime.dispatchContinuationIfSettled(ctx), false);
    scheduler.advance(59_999);
    assert.deepEqual(messages, []);
    scheduler.advance(1);
    assert.deepEqual(messages, [
      { prompt: 'continue goal-a', options: { deliverAs: 'followUp' } },
    ]);
  });

  it('REQ-AGENT-130 AC3: safely re-arms delays beyond the Node timer maximum', () => {
    const delay = 2_147_483_648;
    const { runtime, scheduler, messages, ctx } = runtimeHarness(delay);

    runtime.dispatchContinuationIfSettled(ctx);
    assert.deepEqual(scheduler.armedDelays(), [2_147_483_647]);
    scheduler.advance(delay - 1);
    assert.deepEqual(messages, []);
    assert.equal(scheduler.pendingCount(), 1);
    assert.deepEqual(scheduler.armedDelays(), [2_147_483_647, 1]);
    scheduler.advance(1);
    assert.deepEqual(messages, [
      { prompt: 'continue goal-a', options: { deliverAs: 'followUp' } },
    ]);
  });

  it('REQ-AGENT-130 AC4: latest settled activity restarts one pending interval', () => {
    const { runtime, scheduler, messages, ctx } = runtimeHarness(60_000);

    runtime.dispatchContinuationIfSettled(ctx);
    scheduler.advance(45_000);
    runtime.dispatchContinuationIfSettled(ctx);
    assert.equal(scheduler.pendingCount(), 1);

    scheduler.advance(15_000);
    assert.deepEqual(messages, []);
    scheduler.advance(45_000);
    assert.deepEqual(messages, [
      { prompt: 'continue goal-a', options: { deliverAs: 'followUp' } },
    ]);
    assert.equal(scheduler.pendingCount(), 0);
  });

  it('REQ-AGENT-130 AC5: cancellation prevents a delayed continuation', () => {
    const cancelled = runtimeHarness(60_000);
    cancelled.runtime.dispatchContinuationIfSettled(cancelled.ctx);
    cancelled.runtime.cancelContinuationWork();
    cancelled.scheduler.advance(60_000);
    assert.deepEqual(cancelled.messages, []);
    assert.equal(cancelled.scheduler.pendingCount(), 0);

    const cleared = runtimeHarness(60_000);
    cleared.runtime.dispatchContinuationIfSettled(cleared.ctx);
    cleared.runtime.clearContinuationTracking();
    cleared.scheduler.advance(60_000);
    assert.deepEqual(cleared.messages, []);
    assert.equal(cleared.scheduler.pendingCount(), 0);
  });

  it('REQ-AGENT-130 AC1: zero delay dispatches immediately', () => {
    const { runtime, scheduler, messages, ctx } = runtimeHarness(0);

    assert.equal(runtime.dispatchContinuationIfSettled(ctx), true);
    assert.deepEqual(messages, [
      { prompt: 'continue goal-a', options: { deliverAs: 'followUp' } },
    ]);
    assert.equal(scheduler.pendingCount(), 0);
  });

  it('REQ-AGENT-130 AC6: stale menu, marker, and replacement-goal timers cannot dispatch', () => {
    const replaced = runtimeHarness(60_000);
    replaced.runtime.dispatchContinuationIfSettled(replaced.ctx);
    replaced.runtime.activeGoal = { id: 'goal-b', status: 'active' };
    replaced.scheduler.advance(60_000);
    assert.deepEqual(replaced.messages, []);

    const staleMenu = runtimeHarness(60_000);
    staleMenu.runtime.dispatchContinuationIfSettled(staleMenu.ctx);
    staleMenu.runtime.menuGeneration += 1;
    staleMenu.scheduler.advance(60_000);
    assert.deepEqual(staleMenu.messages, []);

    const staleMarker = runtimeHarness(60_000);
    staleMarker.runtime.dispatchContinuationIfSettled(staleMarker.ctx);
    staleMarker.runtime.continuationIntent = {
      goalId: 'goal-a',
      iteration: 2,
      marker: 'goal-a:2:marker-b',
      prompt: 'continue fresh marker',
    };
    staleMarker.scheduler.advance(60_000);
    assert.deepEqual(staleMarker.messages, []);
    assert.equal(staleMarker.runtime.continuationIntent.marker, 'goal-a:2:marker-b');

    staleMarker.runtime.dispatchContinuationIfSettled(staleMarker.ctx);
    staleMarker.scheduler.advance(60_000);
    assert.deepEqual(staleMarker.messages, [
      { prompt: 'continue fresh marker', options: { deliverAs: 'followUp' } },
    ]);
  });

  it('REQ-AGENT-130 AC7: a busy timer retains intent for the next settled boundary', () => {
    const { runtime, scheduler, messages, state, ctx } = runtimeHarness(60_000);
    runtime.dispatchContinuationIfSettled(ctx);
    state.idle = false;
    scheduler.advance(60_000);

    assert.deepEqual(messages, []);
    assert.equal(runtime.continuationIntent.marker, 'goal-a:1:marker-a');
    assert.equal(scheduler.pendingCount(), 0);

    state.idle = true;
    runtime.dispatchContinuationIfSettled(ctx);
    scheduler.advance(60_000);
    assert.deepEqual(messages, [
      { prompt: 'continue goal-a', options: { deliverAs: 'followUp' } },
    ]);
  });

  it('REQ-AGENT-129 AC5: rejects invalid minIntervalMs values', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pi-goal-settings-validation-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    extractPackage(join(FIXTURES_DIRECTORY, 'pi-goal-0.54.8.tgz'),
      'sha512-ba165WkOdBEQNYgjTa2MHgRtOh/hTLveObPzdoE29FOrfktymcBlayEHoXd9Jjw44VQ8bX7cq6V57zp0rJLVgQ==', root);
    patchPiGoalDirectory('0.54.8', root);
    const { normalizeGoalSettings, saveGoalSettings } = await bundleFixture(join(root, 'src/settings.ts'), join(root, 'settings.mjs'), 'namespace');
    const path = join(root, 'settings.json');
    writeFileSync(path, '{}');
    for (const minIntervalMs of [null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(
        normalizeGoalSettings({ continuationLimits: { minIntervalMs } }),
        undefined,
        `expected ${String(minIntervalMs)} to be rejected`,
      );
      assert.throws(() => saveGoalSettings({ continuationLimits: { minIntervalMs } }, path), /invalid/);
      assert.equal(readFileSync(path, 'utf8'), '{}', 'invalid settings must not replace saved settings');
    }
  });

  it('REQ-AGENT-129 AC6: defaults a missing delay to zero', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pi-goal-settings-default-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    extractPackage(join(FIXTURES_DIRECTORY, 'pi-goal-0.54.8.tgz'),
      'sha512-ba165WkOdBEQNYgjTa2MHgRtOh/hTLveObPzdoE29FOrfktymcBlayEHoXd9Jjw44VQ8bX7cq6V57zp0rJLVgQ==', root);
    patchPiGoalDirectory('0.54.8', root);
    const { normalizeGoalSettings } = await bundleFixture(join(root, 'src/settings.ts'), join(root, 'settings.mjs'), 'namespace');
    const normalized = normalizeGoalSettings({ continuationLimits: {} });
    assert.deepEqual(normalized, {
      rpc: { enabled: false },
      continuationLimits: { automaticTurns: 25, noProgressTurns: 3, minIntervalMs: 0 },
    });
  });

  it('REQ-AGENT-129 AC7: saves the delay without dropping unknown fields', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pi-goal-settings-save-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    extractPackage(join(FIXTURES_DIRECTORY, 'pi-goal-0.54.8.tgz'),
      'sha512-ba165WkOdBEQNYgjTa2MHgRtOh/hTLveObPzdoE29FOrfktymcBlayEHoXd9Jjw44VQ8bX7cq6V57zp0rJLVgQ==', root);
    patchPiGoalDirectory('0.54.8', root);
    const { normalizeGoalSettings, saveGoalSettings, readGoalSettings } = await bundleFixture(join(root, 'src/settings.ts'), join(root, 'settings.mjs'), 'namespace');
    const path = join(root, 'settings.json');
    writeFileSync(path, JSON.stringify({ unknownRoot: 'keep', rpc: { unknownRpc: 'keep' }, continuationLimits: { unknownLimit: 'keep' } }));
    saveGoalSettings({ continuationLimits: { automaticTurns: 10, noProgressTurns: null, minIntervalMs: 60_000 } }, path);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      unknownRoot: 'keep',
      rpc: { enabled: false, unknownRpc: 'keep' },
      continuationLimits: {
        unknownLimit: 'keep',
        automaticTurns: 10,
        noProgressTurns: null,
        minIntervalMs: 60_000,
      },
    });
    assert.equal(readGoalSettings(path).settings.continuationLimits.minIntervalMs, 60_000);
    assert.equal(
      normalizeGoalSettings({ continuationLimits: { minIntervalMs: Number.MAX_SAFE_INTEGER } })
        .continuationLimits.minIntervalMs,
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('REQ-AGENT-111/REQ-OPS-020: patches the exact latest pi-goal layout without double registration', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-goal-latest-review-control-'));
    extractPinnedFixturePackage(root);

    assert.equal(EXPECTED_PI_GOAL_VERSION, '0.54.3');
    patchPiGoalDirectory(EXPECTED_PI_GOAL_VERSION, root);
    const first = readFixturePackage(root, 'lifecycle');
    assert.deepEqual(JSON.parse(first['package.json']).pi.extensions, ['./src/index.ts']);
    assert.match(first['src/commands.ts'], new RegExp(COMMANDS_PATCH_MARKER));
    assert.match(first['src/commands.ts'], /abortTurn: options\.abortTurn/);
    assert.match(first['src/commands.ts'], /options\.sendPrompt === false \|\| await this\.runtime\.sendOwnedGoalPrompt/);
    assert.ok(
      first['src/commands.ts'].indexOf('this.runtime.acquireWorkflow(ctx.sessionManager)')
        < first['src/commands.ts'].indexOf('transitionGoal(nextGoalInstance(this.runtime.activeGoal), "active")'),
      'resume must acquire the workflow mutex before activating Goal',
    );
    assert.match(first['src/goal.ts'], new RegExp(GOAL_ENTRYPOINT_PATCH_MARKER));
    assert.match(first['src/goal.ts'], /registerGoalLifecycle\(pi, runtime, runController, commands, options\)/);
    assert.match(first['src/lifecycle.ts'], new RegExp(PATCH_MARKER));
    assert.match(first['src/lifecycle.ts'], /commands: GoalCommandController,/);
    assert.match(first['src/prompts.ts'], new RegExp(PROMPTS_PATCH_MARKER));
    assert.doesNotMatch(first['src/prompts.ts'], /goal_blocked|goal_wait/);
    assert.match(first['src/runtime.ts'], new RegExp(RUNTIME_PATCH_MARKER));
    assert.match(first['src/runtime.ts'], /kind: "explicit_pause"; expectedGoalId: string; abortTurn\?: boolean/);
    assert.match(first['src/runtime.ts'], /if \(request\.abortTurn !== false\) abortCurrentTurn\(ctx\);/);
    assert.match(first['src/runtime.ts'], /private continuationDispatchTimer\?: NodeJS\.Timeout; \/\/ CODEFLARE_GOAL_MIN_INTERVAL_RUNTIME/);
    assert.match(first['src/runtime.ts'], /let remainingMs = this\.settings\.continuationLimits\.minIntervalMs;/);
    assert.match(first['src/runtime.ts'], /const delayMs = Math\.min\(remainingMs, 2_147_483_647\);/);
    assert.match(first['src/runtime.ts'], /this\.continuationIntent\?\.marker !== marker/);
    assert.match(first['src/runtime.ts'], /return this\.scheduleContinuationDispatch\(ctx, intent\.goalId\);/);
    assert.match(first['src/runtime.ts'], /this\.dispatchContinuationIfSettled\(ctx, \{ intervalElapsed: true \}\);/);
    assert.doesNotMatch(first['src/runtime.ts'], /\n\tcontinuationTimer\?:/);
    assert.match(first['src/settings.ts'], new RegExp(SETTINGS_PATCH_MARKER));
    assert.equal(first['src/lifecycle.ts'].match(/runController\.register/g), null);
    assert.match(first['src/settings.ts'], /automaticTurns: 25, noProgressTurns: 3, minIntervalMs: 0/);

    patchPiGoalDirectory(EXPECTED_PI_GOAL_VERSION, root);
    assert.deepEqual(readFixturePackage(root, 'lifecycle'), first);

    const damagedRuntime = first['src/runtime.ts'].replace(
      'if (request.abortTurn !== false) abortCurrentTurn(ctx);',
      'abortCurrentTurn(ctx);',
    );
    writeFileSync(join(root, 'src/runtime.ts'), damagedRuntime);
    assert.throws(
      () => patchPiGoalDirectory(EXPECTED_PI_GOAL_VERSION, root),
      /continuation runtime marker is present but 1 patched anchor\(s\) are missing/,
    );
  });

  it('REQ-AGENT-111: version or source drift fails before any package file is written', () => {
    const expected = EXPECTED_PI_GOAL_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const versionDrift = mkdtempSync(join(tmpdir(), 'pi-goal-version-drift-'));
    extractPinnedFixturePackage(versionDrift);
    writeFileSync(join(versionDrift, 'package.json'), '{"version":"0.44.0"}\n');
    const versionBytes = readFixturePackage(versionDrift, 'lifecycle');
    assert.throws(
      () => patchPiGoalDirectory(EXPECTED_PI_GOAL_VERSION, versionDrift),
      new RegExp(`pi-goal 0\\.44\\.0 != expected ${expected}`),
    );
    assert.deepEqual(readFixturePackage(versionDrift, 'lifecycle'), versionBytes);
    assert.throws(
      () => patchPiGoalDirectory('0.44.0', versionDrift),
      new RegExp(`review-control patch supports only pi-goal ${expected}`),
    );
    assert.deepEqual(readFixturePackage(versionDrift, 'lifecycle'), versionBytes);

    const entrypointDrift = mkdtempSync(join(tmpdir(), 'pi-goal-entrypoint-drift-'));
    extractPinnedFixturePackage(entrypointDrift);
    const entrypointManifestPath = join(entrypointDrift, 'package.json');
    const entrypointManifest = JSON.parse(readFileSync(entrypointManifestPath, 'utf8'));
    writeFileSync(entrypointManifestPath, `${JSON.stringify({
      ...entrypointManifest,
      pi: { ...entrypointManifest.pi, extensions: ['./dist/unknown.ts'] },
    }, null, '\t')}\n`);
    const entrypointBytes = readFixturePackage(entrypointDrift, 'lifecycle');
    assert.throws(
      () => patchPiGoalDirectory(EXPECTED_PI_GOAL_VERSION, entrypointDrift),
      /declares an unsupported Pi extension entrypoint/,
    );
    assert.deepEqual(readFixturePackage(entrypointDrift, 'lifecycle'), entrypointBytes);

    const sourceDrift = mkdtempSync(join(tmpdir(), 'pi-goal-source-drift-'));
    extractPinnedFixturePackage(sourceDrift);
    const runtimePath = join(sourceDrift, 'src/runtime.ts');
    writeFileSync(
      runtimePath,
      readFileSync(runtimePath, 'utf8').replace(
        'this.continuationDispatchTimer = setTimeout(() => {',
        'this.continuationDispatchTimer = queueMicrotask(() => {',
      ),
    );
    const sourceBytes = readFixturePackage(sourceDrift, 'lifecycle');
    assert.throws(
      () => patchPiGoalDirectory(EXPECTED_PI_GOAL_VERSION, sourceDrift),
      /native continuation scheduler interval anchor count 0; expected 1/,
    );
    assert.deepEqual(readFixturePackage(sourceDrift, 'lifecycle'), sourceBytes);
  });
});
