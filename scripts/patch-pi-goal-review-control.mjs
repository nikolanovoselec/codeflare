#!/usr/bin/env node
// Applies Codeflare's reviewed compatibility patch to the exact locked pi-goal
// release. The package remains upstream-owned and integrity-locked; this version-aware
// image-build transform adds the session-local PR-review control
// channel, compact Goal prompts/status, and a bounded continuation dispatch interval
// without a companion extension or permanent fork. Every transformed source is calculated before
// any package file is written so version or source-layout drift fails closed.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXPECTED_PI_GOAL_VERSION = '0.54.3';
export const SUPPORTED_PI_GOAL_VERSIONS = Object.freeze([
  EXPECTED_PI_GOAL_VERSION,
  '0.54.4',
  '0.54.8',
  '0.54.11',
  '0.54.13',
  '0.54.15',
]);
// 0.54.15 npm SHA-512 verified; all src bytes also matched authenticated
// narumiruna/pi-extensions@980db40db9b1db3b8dc92b2b1837eb06841bfea2.
// The only runtime delta from 0.54.13 is completionStatusTimer.unref?.().
// Accept only pristine or our exact prepared bytes, including on repeat runs.
const REVIEWED_05415 = {
  'src/accounting.ts': ['31b3a5a4ddd86fd2e8370af64e5592dfa01fad88316fd7a6217790049d586bcf'],
  'src/command-registration.ts': ['4b643682b31e99d333ceba1c117ca7ee8e08a1d3733463658f26fb7a9bbff6d8'],
  'src/command.ts': ['756dc522b6e35bb7b35786cbb904329a02077edde2f4dc945ae36c5b9f6914e3'],
  'src/commands.ts': ['55a838c0894bba0586088c8e781c533c99e43eb401713fbefda8da29f49e098d', 'b8d91f678b3cc5e9002266f3aa7b68bae7ade5e156d428aca33be681944d63c0'],
  'src/errors.ts': ['afcc4d60414da733f09d0fce7acd00c8d7b961088d7ff701cd96b31eefcc608c'],
  'src/goal-contract.ts': ['8add9c3b4715b09c79962e1aefe0279a9a83fabf3e4a998cef2fff2bc2f29d15'],
  'src/goal.ts': ['edfc9affd3b7b9492f31fea833a67590a97b51a94a68cf39e95908424cf4db3e', '12c9c560d54c1d455ecb69547454b356d2f3386acbe5c63920668e7f6bc8fbd0'],
  'src/index.ts': ['6ab0c01a44bf7bb78010c9d55713edbacb5a1bfbaa10d558835f906d589b6082'],
  'src/lifecycle.ts': ['e758af48b13dd7688bbc6adb9a2881f6cc0d7c34b702eb37b894d22d79b10a23', '9c820876c4ef5dc29a0b0eedb99bbbd0e8adf844548e2846eab05f2f46edb0b2', '8ccb922618033df613ecb8607262f4bf270292d0b4ff200d7df63d1cd8d08cd8'],
  'src/markers.ts': ['cfd25799640ac51230c7f11740cb7d8dd955d7ef7c461e0d3ca9286a7968d837'],
  'src/menu.ts': ['5a64f4eb6c1bc1d2cc02956df30b3f5eeaf9cedafaf7265704c1c958758fede4'],
  'src/persistence.ts': ['fc4a213f97c9396fcdfa9123266c4095d092e64bdc96f5e45322e471614bd47c', '569a15d883edc43f65caf4e2cc4c2aad35c849f0929366d6c693c0ed0d203306'],
  'src/prompts.ts': ['9aec92ac4d8319dd1086a072271c75be8f638a0692fd8a03d10fda4b9337c88c', '8595c4a6aee3b485504f6c0d0ab51091d669fc6bfd9ff89ba94c251934ef2231', 'f32fec7ff2b06897024610b420064f007191732c7f7559a79212ced6063f1f93'],
  'src/run-protocol.ts': ['05a387d77f28502eca06213460fdb375614d784741a306b7e66a7fff9bd3bba3'],
  'src/runtime.ts': ['4dbb2be140a035241265724ebb91401a08417f4d8abed2e58973bf8baa72f706', '3c44ff728961ab627b334a32ce847cfdfefa6125763e9839680df63d2eee1ea0', '86c40489e8c4b0dd8ddf1e04fd7ca02efc9b7056aa11f0173035a8483ef613bb'],
  'src/safety.ts': ['e12c9fb224286697b4424c976a5c159c2a2bdca70feb34e756b208f92182b8e8', 'd08d3a99ac0b4e4e0c87c5c81eb30ea5df832632078a6ab6283aeb01a3a6ff5d'],
  'src/settings-ui.ts': ['a0482ed1fb6bf15a00a251ea576419248e9ae81fbae485145ae78a62798127d5'],
  'src/settings.ts': ['0a16915b084ffc1ec69e3884fe29e8ab2edb3675e5d87f8ccff67e386c3bd4b9', 'e2fafa65a07b40a8c7fbd46fcf95c3177ecd16afaa961443dbdd69d312689ba4', 'b849014f307cafca8195ecbaafd95c2c075226542b9c86a4a025214aa06210e3'],
  'src/tool-policy.ts': ['c0aec081211be439d6dd8ee752240989697e6178673540d7212d1708ba15c627', '863ad95d1d4b5891fbc7b9756be89a4f366027b44e7c46b7c6929f72ef3f5ee0', '6b64f8dea9b2d03119371b3e27352837f97239fa028938447cfb4198e3ec2665'],
  'src/tools.ts': ['97a365b184c80d78444719fd90ab1ccec69ba54675b0d679feccdd36ade99feb', '5cef58223a88445689fb1a83dbae4635677ea54f99daf5afb010563012c2c21b'],
  'src/wait.ts': ['5ab36f8be3270aa9cb34c36cb77c0b696453e4e378f756b159b5274d45711347'],
  'src/workflow-mutex.ts': ['46b8103f49e48092d95d00b5e0877041537c7ee41453689def457c4addbc15d3'],
};
function validate05415(directory) {
  for (const [path, reviewed] of Object.entries(REVIEWED_05415)) {
    const fullPath = join(directory, path);
    const info = lstatSync(fullPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe Goal source path: ${path}`);
    const digest = createHash('sha256').update(readFileSync(fullPath)).digest('hex');
    if (!reviewed.includes(digest)) throw new Error(`Goal source digest changed: ${path}`);
  }
}

export const PATCH_MARKER = 'CODEFLARE_GOAL_CONTROL_CHANNEL';
export const GOAL_ENTRYPOINT_PATCH_MARKER = 'CODEFLARE_GOAL_LIFECYCLE_COMMANDS';
export const TOOL_POLICY_PATCH_MARKER = 'CODEFLARE_GOAL_LAZY_TOOL_ACTIVATION';
export const COMMANDS_PATCH_MARKER = 'CODEFLARE_SUPPRESS_RESUME_PROMPT';
export const PROMPTS_PATCH_MARKER = 'CODEFLARE_COMPACT_GOAL_PROMPTS';
export const SETTINGS_PATCH_MARKER = 'CODEFLARE_GOAL_MIN_INTERVAL_SETTINGS';
export const RUNTIME_PATCH_MARKER = 'CODEFLARE_GOAL_MIN_INTERVAL_RUNTIME';
const STATUS_PATCH_MARKER = 'CODEFLARE_GOAL_COMPACT_STATUS';
export const RUNTIME_SETTLED_RESTART_MARKER = 'CODEFLARE_GOAL_SETTLED_RESTART';
export const CONTROL_CHANNEL = 'codeflare:pi-goal:control';

const CONTROL_BLOCK = `
\tlet codeflareControlCtx: StatusContext | undefined;
\tconst CODEFLARE_GOAL_CONTROL_CHANNEL = "${CONTROL_CHANNEL}";
\tpi.events.on(CODEFLARE_GOAL_CONTROL_CHANNEL, async (data: unknown) => {
\t\tconst request = data as {
\t\t\taction?: unknown;
\t\t\tgoalId?: unknown;
\t\t\taccepted?: () => void;
\t\t\trespond?: (result: { ok: boolean; goalId: string; status: string }) => void;
\t\t};
\t\tif (
\t\t\t(request.action !== "pause" && request.action !== "resume") ||
\t\t\ttypeof request.goalId !== "string" ||
\t\t\ttypeof request.respond !== "function"
\t\t) return;
\t\tconst respond = (ok: boolean, goalId: string, status: string) => {
\t\t\ttry { request.respond?.({ ok, goalId, status }); } catch {}
\t\t};
\t\tconst ctx = codeflareControlCtx;
\t\tconst goal = runtime.activeGoal;
\t\tif (!ctx || !goal || goal.id !== request.goalId) {
\t\t\trespond(false, request.goalId, goal?.status ?? "missing");
\t\t\treturn;
\t\t}
\t\tif (request.action === "pause") {
\t\t\tif (goal.status !== "active") {
\t\t\t\trespond(false, goal.id, goal.status);
\t\t\t\treturn;
\t\t\t}
\t\t\ttry { request.accepted?.(); } catch {}
\t\t\ttry {
\t\t\t\tcommands.pauseGoal(ctx, { abortTurn: false });
\t\t\t\tconst paused = runtime.activeGoal;
\t\t\t\trespond(paused?.id === goal.id && paused.status === "paused", goal.id, paused?.status ?? "missing");
\t\t\t} catch {
\t\t\t\trespond(false, goal.id, runtime.activeGoal?.status ?? "missing");
\t\t\t}
\t\t\treturn;
\t\t}
\t\tif (goal.status !== "paused") {
\t\t\trespond(false, goal.id, goal.status);
\t\t\treturn;
\t\t}
\t\ttry { request.accepted?.(); } catch {}
\t\ttry {
\t\t\tawait commands.resumeGoal(ctx, { sendPrompt: false });
\t\t\tconst resumed = runtime.activeGoal;
\t\t\trespond(Boolean(resumed && resumed.id !== goal.id && resumed.status === "active"), resumed?.id ?? goal.id, resumed?.status ?? "missing");
\t\t} catch {
\t\t\trespond(false, goal.id, runtime.activeGoal?.status ?? "missing");
\t\t}
\t});`;

const RUNTIME_DISPATCH_SOURCE = `\tdispatchContinuationIfSettled(ctx: StatusContext) {
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
\t}`;

const RUNTIME_DISPATCH_SOURCE_049 = RUNTIME_DISPATCH_SOURCE.replace(
  'this.goalToolsAvailable()',
  'this.toolPolicy.toolsAvailable()',
);

const RUNTIME_NATIVE_SCHEDULER_SOURCE = `\tscheduleContinuationDispatch(ctx: StatusContext, goalId: string) {
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
\t}`;

const RUNTIME_NATIVE_SCHEDULER_PATCH = `\tscheduleContinuationDispatch(ctx: StatusContext, goalId: string) {
\t\tif (this.continuationDispatchTimer) return false;
\t\tconst generation = this.menuGeneration;
\t\tconst marker = this.continuationIntent?.marker;
\t\tlet remainingMs = this.settings.continuationLimits.minIntervalMs;
\t\tconst armTimer = () => {
\t\t\tconst delayMs = Math.min(remainingMs, 2_147_483_647);
\t\t\tthis.continuationDispatchTimer = setTimeout(() => {
\t\t\t\tthis.continuationDispatchTimer = undefined;
\t\t\t\tif (
\t\t\t\t\tgeneration !== this.menuGeneration ||
\t\t\t\t\tthis.continuationIntent?.marker !== marker ||
\t\t\t\t\tthis.activeGoal?.id !== goalId ||
\t\t\t\t\t!this.ownsWorkflow(this.activeGoal)
\t\t\t\t) {
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tremainingMs -= delayMs;
\t\t\t\tif (remainingMs > 0) {
\t\t\t\t\tarmTimer();
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tthis.dispatchContinuationIfSettled(ctx, { intervalElapsed: true });
\t\t\t}, delayMs);
\t\t};
\t\tarmTimer();
\t\treturn true;
\t}`;

const RUNTIME_DISPATCH_PATCH = `\tdispatchContinuationIfSettled(ctx: StatusContext) {
\t\tconst intent = this.continuationIntent;
\t\tif (!intent) return false;

\t\tconst isEligible = () => {
\t\t\tif (this.continuationIntent?.marker !== intent.marker) return false;
\t\t\tif (this.activeGoal?.status === "active" && !this.goalToolsAvailable()) {
\t\t\t\tthis.pauseGoalForUnavailableTools(ctx);
\t\t\t\treturn false;
\t\t\t}
\t\t\tif (
\t\t\t\t!this.activeGoal ||
\t\t\t\tthis.activeGoal.id !== intent.goalId ||
\t\t\t\tthis.activeGoal.status !== "active"
\t\t\t) {
\t\t\t\tif (this.continuationIntent?.marker === intent.marker) {
\t\t\t\t\tthis.continuationIntent = undefined;
\t\t\t\t}
\t\t\t\treturn false;
\t\t\t}
\t\t\tif (this.enforceAutomaticTurnLimit(ctx, false) || this.enforceNoProgressLimit(ctx)) {
\t\t\t\treturn false;
\t\t\t}
\t\t\treturn ctx.isIdle?.() === true && !hasPendingMessages(ctx);
\t\t};

\t\tconst deliver = () => {
\t\t\tif (!isEligible()) return false;
\t\t\tthis.continuationIntent = undefined;
\t\t\tthis.continuationDelivery = intent;
\t\t\ttry {
\t\t\t\tthis.pi.sendUserMessage(intent.prompt, { deliverAs: "followUp" });
\t\t\t\treturn true;
\t\t\t} catch (error) {
\t\t\t\tif (this.continuationDelivery?.marker === intent.marker) {
\t\t\t\t\tthis.continuationDelivery = undefined;
\t\t\t\t}
\t\t\t\tif (this.activeGoal?.id === intent.goalId && this.activeGoal.status === "active") {
\t\t\t\t\tthis.continuationIntent = intent;
\t\t\t\t}
\t\t\t\tctx.ui.notify(\`Goal prompt failed: \${formatError(error)}\`, "error");
\t\t\t\treturn false;
\t\t\t}
\t\t};

\t\tif (!isEligible()) return false;
\t\tconst minIntervalMs = this.settings.continuationLimits.minIntervalMs;
\t\tif (minIntervalMs === 0) return deliver();
\t\tthis.clearContinuationTimer(); // CODEFLARE_GOAL_SETTLED_RESTART

\t\tconst menuGeneration = this.menuGeneration;
\t\tconst marker = intent.marker;
\t\tlet remainingMs = minIntervalMs;
\t\tconst armTimer = () => {
\t\t\tconst delayMs = Math.min(remainingMs, 2_147_483_647);
\t\t\tthis.continuationTimer = setTimeout(() => {
\t\t\t\tthis.continuationTimer = undefined;
\t\t\t\tconst currentGoal = this.activeGoal;
\t\t\t\tif (
\t\t\t\t\tthis.menuGeneration !== menuGeneration ||
\t\t\t\t\tthis.continuationIntent?.marker !== marker ||
\t\t\t\t\t!currentGoal ||
\t\t\t\t\tcurrentGoal.id !== intent.goalId ||
\t\t\t\t\tcurrentGoal.status !== "active"
\t\t\t\t) {
\t\t\t\t\tif (
\t\t\t\t\t\tthis.continuationIntent?.marker === marker &&
\t\t\t\t\t\t(!currentGoal || currentGoal.id !== intent.goalId || currentGoal.status !== "active")
\t\t\t\t\t) {
\t\t\t\t\t\tthis.continuationIntent = undefined;
\t\t\t\t\t}
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tremainingMs -= delayMs;
\t\t\t\tif (remainingMs > 0) {
\t\t\t\t\tarmTimer();
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tdeliver();
\t\t\t}, delayMs);
\t\t};
\t\tarmTimer();
\t\treturn false;
\t}`;

function replaceOnce(source, search, replacement, label) {
  const count = source.split(search).length - 1;
  if (count !== 1) throw new Error(`${label} anchor count ${count}; expected 1`);
  return source.replace(search, replacement);
}

function isCompleteMarkedPatch(source, marker, required, label) {
  if (!source.includes(marker)) return false;
  const missing = required.filter((anchor) => !source.includes(anchor));
  if (missing.length > 0) {
    throw new Error(`${label} marker is present but ${missing.length} patched anchor(s) are missing`);
  }
  return true;
}

export function patchPiGoalCommandsSource(source) {
  const usesStopActiveGoal = source.includes('this.runtime.stopActiveGoal(ctx, {');
  if (
    isCompleteMarkedPatch(
      source,
      COMMANDS_PATCH_MARKER,
      [
        'options: { abortTurn?: boolean } = {}',
        usesStopActiveGoal
          ? 'abortTurn: options.abortTurn,'
          : 'if (options.abortTurn !== false) abortCurrentTurn(ctx);',
        'options: { sendPrompt?: boolean } = {}',
        'options.sendPrompt === false || await',
      ],
      'resume command',
    )
  ) return source;
  let patched = replaceOnce(
    source,
    '\tpauseGoal(ctx: StatusContext) {',
    '\tpauseGoal(ctx: StatusContext, options: { abortTurn?: boolean } = {}) {',
    'pause command signature',
  );
  if (usesStopActiveGoal) {
    patched = replaceOnce(
      patched,
      [
        '\t\tconst stoppedGoal = this.runtime.stopActiveGoal(ctx, {',
        '\t\t\tkind: "explicit_pause",',
        '\t\t\texpectedGoalId: this.runtime.activeGoal.id,',
        '\t\t});',
      ].join('\n'),
      [
        '\t\tconst stoppedGoal = this.runtime.stopActiveGoal(ctx, {',
        '\t\t\tkind: "explicit_pause",',
        '\t\t\texpectedGoalId: this.runtime.activeGoal.id,',
        '\t\t\tabortTurn: options.abortTurn,',
        '\t\t});',
      ].join('\n'),
      'pause command stop request',
    );
  } else {
    patched = replaceOnce(
      patched,
      [
        '\t\tthis.runtime.blockStaleGoalToolCalls();',
        '\t\tabortCurrentTurn(ctx);',
        '\t\tthis.runtime.activeGoal = transitionGoal(this.runtime.activeGoal, "paused");',
      ].join('\n'),
      [
        '\t\tthis.runtime.blockStaleGoalToolCalls();',
        '\t\tif (options.abortTurn !== false) abortCurrentTurn(ctx);',
        '\t\tthis.runtime.activeGoal = transitionGoal(this.runtime.activeGoal, "paused");',
      ].join('\n'),
      'pause command turn abort',
    );
  }
  patched = replaceOnce(
    patched,
    '\tasync resumeGoal(ctx: StatusContext) {',
    `\tasync resumeGoal(ctx: StatusContext, options: { sendPrompt?: boolean } = {}) { // ${COMMANDS_PATCH_MARKER}`,
    'resume command signature',
  );
  patched = replaceOnce(
    patched,
    [
      '\t\tconst sent = await this.runtime.sendOwnedGoalPrompt(',
      '\t\t\tctx,',
      '\t\t\tresumedGoal.id,',
      '\t\t\tbuildResumePrompt(resumedGoal, stoppedStatus),',
      '\t\t);',
    ].join('\n'),
    [
      '\t\tconst sent = options.sendPrompt === false || await this.runtime.sendOwnedGoalPrompt(',
      '\t\t\tctx,',
      '\t\t\tresumedGoal.id,',
      '\t\t\tbuildResumePrompt(resumedGoal, stoppedStatus),',
      '\t\t);',
    ].join('\n'),
    'resume continuation prompt',
  );
  return patched;
}

export function patchPiGoalPromptsSource(source) {
  if (
    isCompleteMarkedPatch(
      source,
      PROMPTS_PATCH_MARKER,
      [
        'Do not stop at a plan or partial result.',
        '<external_wait_reason>',
      ],
      'Goal prompts',
    )
  ) return source;
  let patched = replaceOnce(
    source,
    'import { MIN_GOAL_WAIT_DELAY_MS } from "./wait.js";',
    `// ${PROMPTS_PATCH_MARKER}`,
    'Goal wait import',
  );
  patched = replaceOnce(
    patched,
    [
      'function goalModeRules(goalLabel: string) {',
      '\treturn [',
      '\t\t"Goal-mode rules:",',
      '\t\t"- Preserve the full objective across turns; do not redefine success around a narrower, safer, smaller, merely compatible, or easier-to-test result.",',
      '\t\t"- Derive concrete requirements from the objective and any referenced files, plans, specifications, issues, or user instructions.",',
      '\t\t"- Treat the current worktree, command output, tests, runtime behavior, PR state, rendered artifacts, and external state as authoritative. Previous conversation, plans, and summaries are context, not proof; inspect the current state before relying on them.",',
      '\t\t`- Keep working until ${goalLabel} is completely resolved end-to-end. Do not stop at analysis, a plan, TODO list, partial fixes, or suggested next steps.`,',
      '\t\t"- Autonomously implement and verify the work. If a tool fails, try reasonable alternatives instead of yielding early.",',
      '\t\t"- Before completion, treat completion as unproven and audit requirement by requirement. For every explicit requirement, artifact, command, test, gate, invariant, and deliverable, inspect authoritative evidence and match verification scope to requirement scope.",',
      '\t\t"- Weak, indirect, missing, or merely consistent evidence is not enough; gather stronger evidence and keep working.",',
      '\t\t`- Only call the goal_complete tool after evidence proves every requirement of ${goalLabel} is satisfied and no required work remains. Pass this exact goal_id and never reuse an id from an older, stopped, replaced, or cleared turn.`,',
      '\t\t"- Use goal_blocked only at a true impasse after the same blocker recurs for at least three consecutive goal turns, with concrete evidence that user or external action is required. Never use it merely because work is hard, slow, uncertain, incomplete, needs ordinary clarification, or hit a recoverable failure.",',
      '\t\t"- After a blocked goal is resumed, start a fresh three-turn blocker audit before using goal_blocked again.",',
      '\t\t"- When progress genuinely depends on a later external event, first arrange a non-goal wake message, then call goal_wait with the exact current goal_id to keep the goal active without automatic continuation. Use resume_after_ms only as a bounded safety wake-up, not as a polling interval.",',
      '\t\t`- Prefer longer goal_wait deadlines measured in minutes to avoid busy polling. Requests below ${MIN_GOAL_WAIT_DELAY_MS}ms are clamped to ${MIN_GOAL_WAIT_DELAY_MS}ms, and omitting resume_after_ms keeps the goal quiet until external input or explicit resume.`,',
      '\t\t"- Call goal_wait alone because parallel sibling tools can prevent immediate turn termination. Do not use it for ordinary unfinished work, and do not use goal_blocked for a recoverable external wait.",',
      '\t\t"- If the goal is incomplete at the end of a turn and goal_wait was not accepted, expect automatic continuation and keep working from the current state.",',
      '\t].join("\\n");',
      '}',
    ].join('\n'),
    [
      'function goalModeRules(goalLabel: string) {',
      '\treturn [',
      '\t\t"Goal-mode rules:",',
      '\t\t`- Continue until ${goalLabel} is complete; preserve its full scope and verify authoritative state.`,',
      '\t\t"- Do not stop at a plan or partial result.",',
      '\t\t`- Call goal_complete only after every requirement of ${goalLabel} is verified and no work remains.`,',
      '\t\t"- If progress needs user input or an external event, state the required action and stop the turn.",',
      '\t].join("\\n");',
      '}',
    ].join('\n'),
    'Goal mode rules',
  );
  patched = replaceOnce(
    patched,
    '<goal_wait_reason>\\n${escapeXmlText(waitingReason)}\\n</goal_wait_reason>',
    '<external_wait_reason>\\n${escapeXmlText(waitingReason)}\\n</external_wait_reason>',
    'waiting reason tag',
  );
  return patched;
}

export function patchPiGoalSource(source) {
  if (
    isCompleteMarkedPatch(
      source,
      PATCH_MARKER,
      [CONTROL_CHANNEL, 'codeflareControlCtx = ctx;', 'codeflareControlCtx = undefined;'],
      'review control',
    )
  ) return source;
  let patched = replaceOnce(
    source,
    '\tconst runController = new GoalRunController(runtime, commands);\n\trunController.register(pi);',
    `\tconst runController = new GoalRunController(runtime, commands);\n\trunController.register(pi);${CONTROL_BLOCK}`,
    'controller registration',
  );
  patched = replaceOnce(
    patched,
    '\tpi.on("session_start", async (_event, ctx) => {\n\t\truntime.replaceMenuSession();',
    '\tpi.on("session_start", async (_event, ctx) => {\n\t\tcodeflareControlCtx = ctx;\n\t\truntime.replaceMenuSession();',
    'session start',
  );
  patched = replaceOnce(
    patched,
    '\tpi.on("session_shutdown", (_event, ctx) => {\n\t\trunController.unbindSession();',
    '\tpi.on("session_shutdown", (_event, ctx) => {\n\t\tcodeflareControlCtx = undefined;\n\t\trunController.unbindSession();',
    'session shutdown',
  );
  return patched;
}

export function patchPiGoalEntrypointSource(source) {
  if (
    isCompleteMarkedPatch(
      source,
      GOAL_ENTRYPOINT_PATCH_MARKER,
      ['registerGoalLifecycle(pi, runtime, runController, commands, options);'],
      'Goal lifecycle command wiring',
    )
  ) return source;
  return replaceOnce(
    source,
    'registerGoalLifecycle(pi, runtime, runController, options);',
    `registerGoalLifecycle(pi, runtime, runController, commands, options); // ${GOAL_ENTRYPOINT_PATCH_MARKER}`,
    'Goal lifecycle command wiring',
  );
}

export function patchPiGoalToolPolicySource(source) {
  if (
    isCompleteMarkedPatch(
      source,
      TOOL_POLICY_PATCH_MARKER,
      ['pi.setActiveTools([...active, ...missing]);'],
      'Goal lazy tool activation',
    )
  ) return source;
  return replaceOnce(
    source,
    `export function assertGoalToolsAvailable(pi: Pick<ExtensionAPI, "getActiveTools">) {
\tif (goalToolsAvailable(pi)) return;
\tthrow new Error(
\t\t"goal_complete and goal_blocked are unavailable; include them in the active tool allowlist or leave the restrictive tool mode first.",
\t);
}`,
    `export function assertGoalToolsAvailable(
\tpi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
) {
\tconst active = pi.getActiveTools();
\tconst activeSet = new Set(active);
\tconst missing = GOAL_TOOL_NAMES.filter((name) => !activeSet.has(name));
\tif (missing.length > 0) pi.setActiveTools([...active, ...missing]); // ${TOOL_POLICY_PATCH_MARKER}
\tif (goalToolsAvailable(pi)) return;
\tthrow new Error(
\t\t"goal_complete and goal_blocked are unavailable; include them in the active tool allowlist or leave the restrictive tool mode first.",
\t);
}`,
    'Goal lazy tool activation',
  );
}

export function patchPiGoalLifecycleSource(source) {
  if (
    isCompleteMarkedPatch(
      source,
      PATCH_MARKER,
      [
        CONTROL_CHANNEL,
        'commands: GoalCommandController,',
        'codeflareControlCtx = ctx;',
        'codeflareControlCtx = undefined;',
      ],
      'review control',
    )
  ) return source;
  let patched = replaceOnce(
    source,
    'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
    'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\nimport type { GoalCommandController } from "./commands.js";',
    'lifecycle command import',
  );
  patched = replaceOnce(
    patched,
    '\trunController: GoalRunController,\n\toptions: GoalLifecycleOptions = {},',
    '\trunController: GoalRunController,\n\tcommands: GoalCommandController,\n\toptions: GoalLifecycleOptions = {},',
    'lifecycle command parameter',
  );
  patched = replaceOnce(
    patched,
    source.includes('\tlet sessionActive = true;')
      ? '\tlet sessionActive = true;'
      : ') {\n\tpi.on("session_start", async (_event, ctx) => {',
    source.includes('\tlet sessionActive = true;')
      ? `${CONTROL_BLOCK}\n\tlet sessionActive = true;`
      : `) {${CONTROL_BLOCK}\n\n\tpi.on("session_start", async (_event, ctx) => {`,
    'lifecycle registration',
  );
  patched = replaceOnce(
    patched,
    '\tpi.on("session_start", async (_event, ctx) => {',
    '\tpi.on("session_start", async (_event, ctx) => {\n\t\tcodeflareControlCtx = ctx;',
    'session start',
  );
  patched = replaceOnce(
    patched,
    '\tpi.on("session_shutdown", (_event, ctx) => {',
    '\tpi.on("session_shutdown", (_event, ctx) => {\n\t\tcodeflareControlCtx = undefined;',
    'session shutdown',
  );
  return patched;
}

export function patchPiGoalSettingsSource(source) {
  if (
    isCompleteMarkedPatch(
      source,
      SETTINGS_PATCH_MARKER,
      [
        source.includes(PROGRESS_MARKER)
          ? 'automaticTurns: null, noProgressTurns: 5, minIntervalMs: 300000'
          : 'minIntervalMs: 0',
        'normalizeMinIntervalMs(',
        'minIntervalMs: normalized.continuationLimits.minIntervalMs',
      ],
      'continuation settings',
    )
  ) return source;

  let patched = replaceOnce(
    source,
    [
      '\tcontinuationLimits: {',
      '\t\tautomaticTurns: ContinuationLimit;',
      '\t\tnoProgressTurns: ContinuationLimit;',
      '\t};',
    ].join('\n'),
    [
      '\tcontinuationLimits: {',
      '\t\tautomaticTurns: ContinuationLimit;',
      '\t\tnoProgressTurns: ContinuationLimit;',
      `\t\tminIntervalMs: number; // ${SETTINGS_PATCH_MARKER}`,
      '\t};',
    ].join('\n'),
    'continuation settings interface',
  );
  const defaultAutomaticTurns = source.includes(
    '\tcontinuationLimits: { automaticTurns: 25, noProgressTurns: 3 },',
  ) ? '25' : 'null';
  patched = replaceOnce(
    patched,
    `\tcontinuationLimits: { automaticTurns: ${defaultAutomaticTurns}, noProgressTurns: 3 },`,
    `\tcontinuationLimits: { automaticTurns: ${defaultAutomaticTurns}, noProgressTurns: 3, minIntervalMs: 0 },`,
    'continuation settings default',
  );
  patched = replaceOnce(
    patched,
    [
      '\tconst noProgressTurns = continuationLimitsValue',
      '\t\t? normalizeContinuationLimit(',
      '\t\t\t\tReflect.get(continuationLimitsValue, "noProgressTurns"),',
      '\t\t\t\tDEFAULT_GOAL_SETTINGS.continuationLimits.noProgressTurns,',
      '\t\t\t)',
      '\t\t: DEFAULT_GOAL_SETTINGS.continuationLimits.noProgressTurns;',
      '\tif (automaticTurns === undefined || noProgressTurns === undefined) return undefined;',
    ].join('\n'),
    [
      '\tconst noProgressTurns = continuationLimitsValue',
      '\t\t? normalizeContinuationLimit(',
      '\t\t\t\tReflect.get(continuationLimitsValue, "noProgressTurns"),',
      '\t\t\t\tDEFAULT_GOAL_SETTINGS.continuationLimits.noProgressTurns,',
      '\t\t\t)',
      '\t\t: DEFAULT_GOAL_SETTINGS.continuationLimits.noProgressTurns;',
      '\tconst minIntervalMs = continuationLimitsValue',
      '\t\t? normalizeMinIntervalMs(',
      '\t\t\t\tReflect.get(continuationLimitsValue, "minIntervalMs"),',
      '\t\t\t\tDEFAULT_GOAL_SETTINGS.continuationLimits.minIntervalMs,',
      '\t\t\t)',
      '\t\t: DEFAULT_GOAL_SETTINGS.continuationLimits.minIntervalMs;',
      '\tif (',
      '\t\tautomaticTurns === undefined ||',
      '\t\tnoProgressTurns === undefined ||',
      '\t\tminIntervalMs === undefined',
      '\t) return undefined;',
    ].join('\n'),
    'continuation settings normalization',
  );
  patched = replaceOnce(
    patched,
    '\t\tcontinuationLimits: { automaticTurns, noProgressTurns },',
    '\t\tcontinuationLimits: { automaticTurns, noProgressTurns, minIntervalMs },',
    'normalized continuation settings result',
  );
  const continuationLimitNormalizer = [
    'function normalizeContinuationLimit(',
    '\tvalue: unknown,',
    '\tfallback: ContinuationLimit,',
    '): ContinuationLimit | undefined {',
    '\tif (value === undefined) return fallback;',
    '\tif (value === null) return null;',
    '\treturn typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;',
    '}',
  ].join('\n');
  const compactContinuationLimitNormalizer = continuationLimitNormalizer.replace(
    'function normalizeContinuationLimit(\n\tvalue: unknown,\n\tfallback: ContinuationLimit,\n): ContinuationLimit | undefined {',
    'function normalizeContinuationLimit(value: unknown, fallback: ContinuationLimit): ContinuationLimit | undefined {',
  );
  patched = replaceOnce(
    patched,
    source.includes(compactContinuationLimitNormalizer) ? compactContinuationLimitNormalizer : continuationLimitNormalizer,
    [
      continuationLimitNormalizer,
      '',
      'function normalizeMinIntervalMs(',
      '\tvalue: unknown,',
      '\tfallback: number,',
      '): number | undefined {',
      '\tif (value === undefined) return fallback;',
      '\treturn typeof value === "number" && Number.isSafeInteger(value) && value >= 0',
      '\t\t? value',
      '\t\t: undefined;',
      '}',
    ].join('\n'),
    'continuation delay validator',
  );
  patched = replaceOnce(
    patched,
    [
      '\t\t\t\t...continuationLimits,',
      '\t\t\t\tautomaticTurns: normalized.continuationLimits.automaticTurns,',
      '\t\t\t\tnoProgressTurns: normalized.continuationLimits.noProgressTurns,',
      '\t\t\t},',
    ].join('\n'),
    [
      '\t\t\t\t...continuationLimits,',
      '\t\t\t\tautomaticTurns: normalized.continuationLimits.automaticTurns,',
      '\t\t\t\tnoProgressTurns: normalized.continuationLimits.noProgressTurns,',
      '\t\t\t\tminIntervalMs: normalized.continuationLimits.minIntervalMs,',
      '\t\t\t},',
    ].join('\n'),
    'saved continuation settings',
  );
  return patched;
}

export function patchPiGoalRuntimeSource(source) {
  const usesConfigurablePauseRequest = source.includes(
    'stopActiveGoal(ctx: StatusContext, request: GoalStopRequest)',
  );
  const usesNativeContinuationScheduler = source.includes(
    'scheduleContinuationDispatch(ctx: StatusContext, goalId: string)',
  );
  if (
    isCompleteMarkedPatch(
      source,
      RUNTIME_PATCH_MARKER,
      [
        ...(usesNativeContinuationScheduler
          ? [
              `private continuationDispatchTimer?: NodeJS.Timeout; // ${RUNTIME_PATCH_MARKER}`,
              source.includes(PROGRESS_MARKER)
                ? 'let remainingMs = this.progressContinuationDelay();'
                : 'let remainingMs = this.settings.continuationLimits.minIntervalMs;',
              'const delayMs = Math.min(remainingMs, 2_147_483_647);',
              'this.continuationIntent?.marker !== marker',
              'options: { intervalElapsed?: boolean } = {}',
              source.includes(PROGRESS_MARKER)
                ? 'if (this.progressContinuationDelay() > 0) {'
                : 'if (this.settings.continuationLimits.minIntervalMs > 0) {',
              'this.clearContinuationDispatchTimer();',
              'return this.scheduleContinuationDispatch(ctx, intent.goalId);',
              'this.dispatchContinuationIfSettled(ctx, { intervalElapsed: true });',
            ]
          : [
              'const minIntervalMs = this.settings.continuationLimits.minIntervalMs;',
              'this.menuGeneration !== menuGeneration',
              'this.clearContinuationTimer();',
            ]),
        RUNTIME_SETTLED_RESTART_MARKER,
        ...(usesConfigurablePauseRequest
          ? [
              'kind: "explicit_pause"; expectedGoalId: string; abortTurn?: boolean',
              'if (request.abortTurn !== false) abortCurrentTurn(ctx);',
            ]
          : []),
      ],
      'continuation runtime',
    )
  ) return source;

  let patched = source;
  if (usesConfigurablePauseRequest) {
    patched = replaceOnce(
      patched,
      '| { kind: "explicit_pause"; expectedGoalId: string }',
      '| { kind: "explicit_pause"; expectedGoalId: string; abortTurn?: boolean }',
      'explicit pause request options',
    );
    patched = replaceOnce(
      patched,
      [
        '\t\t\tcase "explicit_pause":',
        '\t\t\t\tthis.recordGoalUsage(goal, ctx);',
        '\t\t\t\tthis.cancelContinuationWork();',
        '\t\t\t\tthis.clearGoalRecoveryForGoal(goal.id);',
        '\t\t\t\tthis.clearBudgetWrapUp();',
        '\t\t\t\tthis.blockStaleGoalToolCalls();',
        '\t\t\t\tabortCurrentTurn(ctx);',
        '\t\t\t\tstatus = "paused";',
        '\t\t\t\tbreak;',
      ].join('\n'),
      [
        '\t\t\tcase "explicit_pause":',
        '\t\t\t\tthis.recordGoalUsage(goal, ctx);',
        '\t\t\t\tthis.cancelContinuationWork();',
        '\t\t\t\tthis.clearGoalRecoveryForGoal(goal.id);',
        '\t\t\t\tthis.clearBudgetWrapUp();',
        '\t\t\t\tthis.blockStaleGoalToolCalls();',
        '\t\t\t\tif (request.abortTurn !== false) abortCurrentTurn(ctx);',
        '\t\t\t\tstatus = "paused";',
        '\t\t\t\tbreak;',
      ].join('\n'),
      'explicit pause turn abort',
    );
  }

  if (usesNativeContinuationScheduler) {
    patched = replaceOnce(
      patched,
      '\tdispatchContinuationIfSettled(ctx: StatusContext) {',
      '\tdispatchContinuationIfSettled(\n\t\tctx: StatusContext,\n\t\toptions: { intervalElapsed?: boolean } = {},\n\t) {',
      'native continuation dispatcher options',
    );
    patched = replaceOnce(
      patched,
      [
        '\t\tif (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) return false;',
        '',
        '\t\tthis.clearContinuationDispatchTimer();',
      ].join('\n'),
      [
        '\t\tif (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) return false;',
        '',
        '\t\tif (options.intervalElapsed !== true) {',
        '\t\t\tif (this.settings.continuationLimits.minIntervalMs > 0) {',
        `\t\t\t\tthis.clearContinuationDispatchTimer(); // ${RUNTIME_SETTLED_RESTART_MARKER}`,
        '\t\t\t\treturn this.scheduleContinuationDispatch(ctx, intent.goalId);',
        '\t\t\t}',
        '\t\t}',
        '',
        '\t\tthis.clearContinuationDispatchTimer();',
      ].join('\n'),
      'native continuation dispatch interval gate',
    );
    patched = replaceOnce(
      patched,
      '\tprivate continuationDispatchTimer?: NodeJS.Timeout;',
      `\tprivate continuationDispatchTimer?: NodeJS.Timeout; // ${RUNTIME_PATCH_MARKER}`,
      'native continuation scheduler marker',
    );
    const compactScheduler = RUNTIME_NATIVE_SCHEDULER_SOURCE.replace(
      '\t\t\tif (\n\t\t\t\tgeneration !== this.menuGeneration ||\n\t\t\t\tthis.activeGoal?.id !== goalId ||\n\t\t\t\t!this.ownsWorkflow(this.activeGoal)\n\t\t\t) {',
      '\t\t\tif (generation !== this.menuGeneration || this.activeGoal?.id !== goalId || !this.ownsWorkflow(this.activeGoal)) {',
    );
    patched = replaceOnce(
      patched,
      source.includes(compactScheduler) ? compactScheduler : RUNTIME_NATIVE_SCHEDULER_SOURCE,
      RUNTIME_NATIVE_SCHEDULER_PATCH,
      'native continuation scheduler interval',
    );
    return patched;
  }

  patched = replaceOnce(
    patched,
    '\tcompletionStatusTimer?: NodeJS.Timeout;\n\tcontinuationIntent?: ContinuationTicket;',
    [
      '\tcompletionStatusTimer?: NodeJS.Timeout;',
      `\tcontinuationTimer?: NodeJS.Timeout; // ${RUNTIME_PATCH_MARKER}`,
      '\tcontinuationIntent?: ContinuationTicket;',
    ].join('\n'),
    'continuation timer state',
  );
  const dispatchSource = source.includes('this.toolPolicy.toolsAvailable()')
    ? RUNTIME_DISPATCH_SOURCE_049
    : RUNTIME_DISPATCH_SOURCE;
  patched = replaceOnce(
    patched,
    dispatchSource,
    RUNTIME_DISPATCH_PATCH,
    'continuation dispatcher',
  );
  patched = replaceOnce(
    patched,
    [
      '\tclearContinuationTracking() {',
      '\t\tthis.continuationIntent = undefined;',
      '\t\tthis.continuationDelivery = undefined;',
      '\t\tthis.cancelledContinuationMarkers.clear();',
      '\t\tthis.claimedContinuationMarkers.clear();',
      '\t}',
    ].join('\n'),
    [
      '\tprivate clearContinuationTimer() {',
      '\t\tif (!this.continuationTimer) return;',
      '\t\tclearTimeout(this.continuationTimer);',
      '\t\tthis.continuationTimer = undefined;',
      '\t}',
      '',
      '\tclearContinuationTracking() {',
      '\t\tthis.clearContinuationTimer();',
      '\t\tthis.continuationIntent = undefined;',
      '\t\tthis.continuationDelivery = undefined;',
      '\t\tthis.cancelledContinuationMarkers.clear();',
      '\t\tthis.claimedContinuationMarkers.clear();',
      '\t}',
    ].join('\n'),
    'continuation tracking cancellation',
  );
  patched = replaceOnce(
    patched,
    [
      '\tcancelContinuationWork() {',
      '\t\tif (this.continuationDelivery) {',
      '\t\t\tthis.rememberCancelledContinuationMarker(this.continuationDelivery.marker);',
      '\t\t}',
      '\t\tthis.continuationIntent = undefined;',
      '\t\tthis.continuationDelivery = undefined;',
      '\t}',
    ].join('\n'),
    [
      '\tcancelContinuationWork() {',
      '\t\tthis.clearContinuationTimer();',
      '\t\tif (this.continuationDelivery) {',
      '\t\t\tthis.rememberCancelledContinuationMarker(this.continuationDelivery.marker);',
      '\t\t}',
      '\t\tthis.continuationIntent = undefined;',
      '\t\tthis.continuationDelivery = undefined;',
      '\t}',
    ].join('\n'),
    'continuation work cancellation',
  );
  return patched;
}

// Explicit progress is the only reset signal. Text, tool attempts and output
// fingerprints cannot establish that objective work was completed.
const PROGRESS_MARKER = 'CODEFLARE_GOAL_EXPLICIT_PROGRESS';
const STALL_INTERVAL_MS = 300_000;
const STALL_WINDOW_MS = 1_500_000;

function patchProgressPersistence(source) {
  if (isCompleteMarkedPatch(source, PROGRESS_MARKER, ['stalledRuns?: number;', 'stalledSince?: number;', 'nextAutomaticAt?: number;', 'function validProgressTime(value: unknown)', 'stalledSince: validProgressTime(goal.stalledSince)'], 'Goal progress persistence')) return source;
  let patched = replaceOnce(source, '\twaiting?: GoalWait;', `\twaiting?: GoalWait;
\t// ${PROGRESS_MARKER}: legacy output-repeat counters are not stall history.
\tstalledRuns?: number;
\tstalledSince?: number;
\tnextAutomaticAt?: number;`, 'persisted progress fields');
  // Upstream details/settings still expose this counter. It is a projection,
  // never migration evidence or a second authority for stalled history.
  patched = replaceOnce(patched, 'toolFreeRepeatCount: normalizeSafetyCounter(goal.toolFreeRepeatCount),', 'toolFreeRepeatCount: validProgressTime(goal.stalledSince) === undefined ? 0 : normalizeSafetyCounter(goal.stalledRuns),', 'public progress counter projection');
  patched = replaceOnce(patched, '\t\twaiting,', `\t\tstalledSince: validProgressTime(goal.stalledSince),
\t\tstalledRuns: validProgressTime(goal.stalledSince) === undefined ? undefined : normalizeSafetyCounter(goal.stalledRuns),
\t\tnextAutomaticAt: validProgressTime(goal.nextAutomaticAt),
\t\twaiting,`, 'loaded progress fields');
  return `${patched}\nfunction validProgressTime(value: unknown): number | undefined {
\treturn typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
\t\t? value : undefined;
}\n`;
}

function patchProgressSafety(source) {
  if (isCompleteMarkedPatch(source, PROGRESS_MARKER, ['stalledRuns: undefined,', 'stalledSince: undefined,', 'nextAutomaticAt: undefined,'], 'Goal progress safety reset')) return source;
  return replaceOnce(source, '\t\tautomaticModelTurns: 0,', `\t\tautomaticModelTurns: 0,
\t\tstalledRuns: undefined, // ${PROGRESS_MARKER}
\t\tstalledSince: undefined,
\t\tnextAutomaticAt: undefined,`, 'explicit resume progress reset');
}

function patchProgressSettings(source) {
  if (isCompleteMarkedPatch(source, PROGRESS_MARKER, ['automaticTurns: null, noProgressTurns: 5, minIntervalMs: 300000', 'noProgressTurns: 5, minIntervalMs: Math.max(300000, minIntervalMs)'], 'Goal owned progress settings')) return source;
  let patched = source.replace(/automaticTurns: (?:25|null), noProgressTurns: 3, minIntervalMs: 0/, 'automaticTurns: null, noProgressTurns: 5, minIntervalMs: 300000');
  if (patched === source) throw new Error('progress settings default anchor missing');
  patched = replaceOnce(patched, '\t\tcontinuationLimits: { automaticTurns, noProgressTurns, minIntervalMs },',
    `\t\tcontinuationLimits: { automaticTurns, noProgressTurns: 5, minIntervalMs: Math.max(300000, minIntervalMs) }, // ${PROGRESS_MARKER}`,
    'owned continuation settings');
  return patched;
}

function patchProgressToolPolicy(source) {
  if (isCompleteMarkedPatch(source, PROGRESS_MARKER, ['export const GOAL_PROGRESS_TOOL = "goal_progress";', 'GOAL_TOOL_NAMES = [GOAL_PROGRESS_TOOL,', 'REQUIRED_GOAL_TOOL_NAMES = [GOAL_PROGRESS_TOOL,'], 'Goal progress tool policy')) return source;
  let patched = replaceOnce(source, 'export const GOAL_TOOL_NAMES = [',
    `export const GOAL_PROGRESS_TOOL = "goal_progress"; // ${PROGRESS_MARKER}\nexport const GOAL_TOOL_NAMES = [GOAL_PROGRESS_TOOL, `, 'progress tool activation');
  patched = replaceOnce(patched, 'const REQUIRED_GOAL_TOOL_NAMES = [',
    'const REQUIRED_GOAL_TOOL_NAMES = [GOAL_PROGRESS_TOOL, ', 'progress tool availability');
  return patched;
}

function patchProgressTools(source) {
  if (isCompleteMarkedPatch(source, PROGRESS_MARKER, ['name: "goal_progress",', 'runtime.reportGoalProgress(ctx, params.goal_id, params.state, params.evidence)', 'if (repeatedTurns < 5)', 'minimum: 5,'], 'Goal progress tools')) return source;
  let patched = replaceOnce(source, '\tpi.registerTool(goalCompleteTool);', `\t// ${PROGRESS_MARKER}
\tpi.registerTool(defineTool({
\t\tname: "goal_progress",
\t\tlabel: "Goal Progress",
\t\tdescription: "Report progress for the current owned Goal run with its exact goal_id. Use advanced only with concrete evidence of completed objective work; attempts, polling, failed tools, memory capture and paraphrased waiting are stalled, not advanced. Missing reports count as stalled. This tool does not complete or stop the Goal.",
\t\tparameters: Type.Object({
\t\t\tgoal_id: Type.String({ minLength: 1, maxLength: MAX_GOAL_ID_LENGTH }),
\t\t\tstate: Type.Union([Type.Literal("advanced"), Type.Literal("stalled")]),
\t\t\tevidence: Type.String({ minLength: 1, maxLength: MAX_BLOCKER_EVIDENCE_LENGTH }),
\t\t}),
\t\tasync execute(_toolCallId, params, _signal, _onUpdate, ctx) {
\t\t\tconst rejection = runtime.reportGoalProgress(ctx, params.goal_id, params.state, params.evidence);
\t\t\treturn { content: toolContent(rejection ? "goal_progress rejected: " + rejection + "." : "Goal progress recorded: " + params.state + ".") };
\t\t},
\t}));
\tpi.registerTool(goalCompleteTool);`, 'progress tool registration');
  patched = replaceOnce(patched, 'at least three consecutive Goal turns', 'at least five stalled automatic Goal runs, spaced at least five minutes apart', 'blocker description');
  patched = replaceOnce(patched, '\t\t\tminimum: 3,', '\t\t\tminimum: 5,', 'blocker schema');
  patched = replaceOnce(patched, 'Number of separate turns spent trying to resolve this same blocker.', 'Number of stalled automatic Goal runs spent resolving this blocker, at least five minutes apart.', 'blocker attempt guidance');
  patched = replaceOnce(patched, 'if (repeatedTurns < 3) return reject("repeated_turns must be at least 3");',
    'if (repeatedTurns < 5) return reject("repeated_turns must be at least 5");', 'blocker validation');
  return patched;
}

function patchProgressRuntime(source) {
  if (isCompleteMarkedPatch(source, PROGRESS_MARKER, ['private agentRunProgress?: "advanced" | "stalled";', 'progress: this.agentRunProgress,', 'this.agentRunGoalId !== goal.id || !this.ownsWorkflow(goal)', 'goal.stalledRuns ?? 0) < 5', 'goal.stalledSince + 1500000', 'this.progressContinuationDelay()', 'goal.waiting) this.restoreGoalWaitTimer(ctx)', 'beginRecoveryRunIfNeeded(ctx: StatusContext)', 'Date.now() < (this.activeGoal.nextAutomaticAt ?? 0)'], 'Goal progress runtime')) return source;
  let patched = replaceOnce(source, 'import { nextToolFreeRepeatState, resetGoalSafetyEpoch } from "./safety.js";', 'import { resetGoalSafetyEpoch } from "./safety.js";', 'remove output-based progress inference');
  patched = replaceOnce(patched, '\ttoolAttempted: boolean;', '\ttoolAttempted: boolean;\n\tprogress?: "advanced" | "stalled";', 'completed run progress');
  patched = replaceOnce(patched, '\tbeginAgentRun(goalId: string | null | undefined, origin: GoalRunOrigin | undefined) {', `\tprivate agentRunProgress?: "advanced" | "stalled"; // ${PROGRESS_MARKER}
\n\tbeginAgentRun(goalId: string | null | undefined, origin: GoalRunOrigin | undefined) {`, 'run progress state');
  patched = replaceOnce(patched, '\t\t\ttoolAttempted: this.agentRunToolAttempted,', '\t\t\ttoolAttempted: this.agentRunToolAttempted,\n\t\t\tprogress: this.agentRunProgress,', 'completed run report');
  patched = replaceOnce(patched, '\tclearAgentRun() {', '\tclearAgentRun() {\n\t\tthis.agentRunProgress = undefined;', 'clear run report');
  patched = replaceOnce(patched, '\t\tthis.agentRunGoalId = goalId;', '\t\tthis.agentRunProgress = undefined;\n\t\tthis.agentRunGoalId = goalId;', 'begin run report');
  patched = replaceOnce(patched, '\tbeginRecoveryRunIfNeeded() {', '\tbeginRecoveryRunIfNeeded(ctx: StatusContext) {', 'recovery pacing context');
  patched = replaceOnce(patched, '\t\tthis.beginAgentRun(recovery.goalId, recovery.automaticOwner ? "automatic" : "manual");', `\t\tif (recovery.automaticOwner && this.activeGoal.status === "active" && this.ownsWorkflow(this.activeGoal)) {
\t\t\tif (this.enforceNoProgressLimit(ctx, true)) return;
\t\t\tif (Date.now() < (this.activeGoal.nextAutomaticAt ?? 0)) {
\t\t\t\t// Pi retries have no prompt boundary. Defer Goal ownership to the
\t\t\t\t// existing continuation path instead of spending another attempt now.
\t\t\t\tthis.clearGoalRecoveryForGoal(recovery.goalId);
\t\t\t\tthis.requestContinuation(this.activeGoal);
\t\t\t\tabortCurrentTurn(ctx);
\t\t\t\tthis.dispatchContinuationIfSettled(ctx);
\t\t\t\treturn;
\t\t\t}
\t\t}
\t\tthis.beginAgentRun(recovery.goalId, recovery.automaticOwner ? "automatic" : "manual");`, 'paced automatic recovery');
  const progressMethod = patched.match(/\trecordAutomaticRunProgress\([\s\S]*?\n\t\}/g);
  if (progressMethod?.length !== 1) throw new Error('automatic progress method drift');
  patched = replaceOnce(patched, progressMethod[0], `\treportGoalProgress(ctx: StatusContext, goalId: unknown, state: unknown, evidence: unknown) {
\t\tconst goal = this.activeGoal;
\t\tif (!goal || goal.status !== "active") return "no active goal";
\t\tif (typeof goalId !== "string" || goalId !== goal.id) return "goal_id does not match the active goal";
\t\tif (this.agentRunGoalId !== goal.id || !this.ownsWorkflow(goal)) return "current run does not own the active Goal workflow";
\t\tif (state !== "advanced" && state !== "stalled") return "state must be advanced or stalled";
\t\tif (typeof evidence !== "string" || !evidence.trim() || evidence.length > 4000) return "evidence must contain 1 to 4000 characters";
\t\tif (this.enforceNoProgressLimit(ctx, true)) return "stall deadline reached";
\t\tif (state === "advanced") {
\t\t\tthis.agentRunProgress = "advanced";
\t\t\tgoal.stalledRuns = undefined;
\t\t\tgoal.stalledSince = undefined;
\t\t\tgoal.toolFreeRepeatCount = 0;
\t\t\tgoal.lastToolFreeOutputFingerprint = undefined;
\t\t} else {
\t\t\tif (this.agentRunProgress !== "advanced") this.agentRunProgress = "stalled";
\t\t\tgoal.stalledSince ??= Date.now();
\t\t}
\t\tthis.persistGoal(goal);
\t\treturn undefined;
\t}

\trecordAutomaticRunProgress(ctx: StatusContext, goalId: string, progress: "advanced" | "stalled" | undefined, automatic: boolean) {
\t\tconst goal = this.activeGoal;
\t\tif (goal?.id !== goalId || goal.status !== "active" || !this.ownsWorkflow(goal)) return false;
\t\tgoal.nextAutomaticAt = Date.now() + Math.max(${STALL_INTERVAL_MS}, this.settings.continuationLimits.minIntervalMs);
\t\tif (progress !== "advanced") {
\t\t\tgoal.stalledSince ??= Date.now();
\t\t\tif (automatic) goal.stalledRuns = Math.min(Number.MAX_SAFE_INTEGER, (goal.stalledRuns ?? 0) + 1);
\t\t}
\t\tgoal.toolFreeRepeatCount = goal.stalledRuns ?? 0;
\t\tthis.persistGoal(goal);
\t\tthis.updateStatus(ctx, goal);
\t\tif (goal.waiting) this.restoreGoalWaitTimer(ctx);
\t\treturn this.enforceNoProgressLimit(ctx);
\t}`, 'explicit automatic progress');
  const enforceMethod = patched.match(/\tenforceNoProgressLimit\([\s\S]*?\n\t\}/g);
  if (enforceMethod?.length !== 1) throw new Error('no-progress enforcement method drift');
  patched = replaceOnce(patched, enforceMethod[0], `\tenforceNoProgressLimit(ctx: StatusContext, abortTurn = false) {
\t\tconst goal = this.activeGoal;
\t\tif (goal?.status !== "active" || !this.ownsWorkflow(goal)) return false;
\t\tconst expired = goal.stalledSince !== undefined && Date.now() >= goal.stalledSince + ${STALL_WINDOW_MS};
\t\tif (!expired && (goal.stalledRuns ?? 0) < 5) return false;
\t\tconst reason = expired ? "Goal stalled-window deadline reached (25 minutes)" : "Goal blocked after five stalled automatic runs";
\t\tconst stopped = this.stopActiveGoal(ctx, { kind: "retry_exhausted", expectedGoalId: goal.id, reason });
\t\tif (!stopped) return false;
\t\tif (abortTurn) abortCurrentTurn(ctx);
\t\tnotifyTerminal(ctx.ui, reason, "warning");
\t\treturn true;
\t}`, 'owned stall enforcement');
  // The existing continuation timer owns both spacing and the absolute stall
  // deadline; there is no additional timer or scheduler.
  const native = patched.includes('scheduleContinuationDispatch(ctx: StatusContext, goalId: string)');
  const delayAnchor = native ? '\t\tlet remainingMs = this.settings.continuationLimits.minIntervalMs;' : '\t\tconst minIntervalMs = this.settings.continuationLimits.minIntervalMs;';
  patched = replaceOnce(patched, delayAnchor, `${native ? '\t\tlet remainingMs' : '\t\tconst minIntervalMs'} = this.progressContinuationDelay();`, 'owned continuation delay');
  if (native) {
    patched = replaceOnce(patched, 'if (this.settings.continuationLimits.minIntervalMs > 0) {', 'if (this.progressContinuationDelay() > 0) {', 'owned dispatch interval gate');
    patched = replaceOnce(patched, '\t\t\t\tthis.dispatchContinuationIfSettled(ctx, { intervalElapsed: true });', `\t\t\t\tif (this.enforceNoProgressLimit(ctx)) return;
\t\t\t\t// A backward wall-clock correction must not shorten persisted spacing.
\t\t\t\tconst remainingInterval = (this.activeGoal.nextAutomaticAt ?? 0) - Date.now();
\t\t\t\tif (remainingInterval > 0) {
\t\t\t\t\tremainingMs = remainingInterval;
\t\t\t\t\tarmTimer();
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tthis.dispatchContinuationIfSettled(ctx, { intervalElapsed: true });`, 'persisted continuation spacing');
  }
  patched = replaceOnce(patched, '\trestoreGoalWaitTimer(ctx: StatusContext) {', `\tprivate progressContinuationDelay() {
\t\tconst goal = this.activeGoal;
\t\tconst interval = Math.max(${STALL_INTERVAL_MS}, this.settings.continuationLimits.minIntervalMs,
\t\t\t(goal?.nextAutomaticAt ?? 0) - Date.now());
\t\treturn goal?.stalledSince === undefined ? interval
\t\t\t: Math.max(0, Math.min(interval, goal.stalledSince + ${STALL_WINDOW_MS} - Date.now()));
\t}

\trestoreGoalWaitTimer(ctx: StatusContext) {`, 'continuation deadline delay');
  patched = replaceOnce(patched, '\t\tconst resumeAt = goal?.status === "active" ? goal.waiting?.resumeAt : undefined;', `\t\tconst waitAt = goal?.status === "active" ? goal.waiting?.resumeAt : undefined;
\t\tconst deadline = goal?.status === "active" && goal.stalledSince !== undefined ? goal.stalledSince + ${STALL_WINDOW_MS} : undefined;
\t\tconst resumeAt = goal?.waiting && deadline !== undefined ? Math.min(waitAt ?? deadline, deadline) : waitAt;`, 'quiet wait stall deadline');
  patched = replaceOnce(patched, '\tdispatchDueGoalWait(ctx: StatusContext) {', '\tdispatchDueGoalWait(ctx: StatusContext) {\n\t\tif (this.enforceNoProgressLimit(ctx)) return false;', 'quiet wait deadline enforcement');
  patched = replaceOnce(patched, '\t\tthis.clearGoalWaitTimer();\n\t\tthis.activeGoal = {\n\t\t\t...goal,\n\t\t\twaiting,', '\t\tthis.clearGoalWaitTimer();\n\t\tthis.activeGoal = {\n\t\t\t...goal,\n\t\t\twaiting,\n\t\t\tstalledSince: goal.stalledSince ?? Date.now(),', 'enter quiet stall window');
  // Session restoration also invokes this method even for a non-waiting goal.
  patched = replaceOnce(patched, '\t\tif (!goal || resumeAt === undefined) return false;', `\t\tif (!goal || resumeAt === undefined) {
\t\t\tif (goal?.status === "active" && !goal.waiting && !this.hasContinuationWorkForGoal(goal.id)) {
\t\t\t\tthis.requestContinuation(goal);
\t\t\t\tthis.dispatchContinuationIfSettled(ctx);
\t\t\t}
\t\t\treturn false;
\t\t}`, 'restored continuation');
  return patched;
}

function patchProgressLifecycle(source) {
  if (isCompleteMarkedPatch(source, PROGRESS_MARKER, ['if (run.goalId === undefined) return;', 'runtime.recordAutomaticRunProgress(ctx, goalId, run.progress, run.origin === "automatic")', 'if (runtime.enforceNoProgressLimit(ctx, true)) return;', 'runtime.beginRecoveryRunIfNeeded(_ctx);'], 'Goal progress lifecycle')) return source;
  let patched = replaceOnce(source, 'import { hasAssistantToolCall } from "./safety.js";\n', '', 'remove attempted-tool progress inference');
  patched = replaceOnce(patched, '\t\tconst run = runtime.finishAgentRun();', `\t\tconst run = runtime.finishAgentRun(); // ${PROGRESS_MARKER}
\t\tif (run.goalId === undefined) return;`, 'completed owned run fence');
  // Ordinary user/extension notifications and context recovery are not resume.
  patched = replaceOnce(patched, '\t\truntime.resetActiveSafetyEpoch(ctx);', '\t\t// Only explicit Goal resume/edit resets the safety epoch.', 'input safety reset removal');
  patched = replaceOnce(patched, '\t\tif (resetSafetyEpoch && activeGoalId) runtime.resetActiveSafetyEpoch(ctx);', '\t\t// A non-Goal notification never resets stalled progress.', 'notification safety reset removal');
  const legacyProgress = patched.match(/\t\tif \(\n\t\t\trun.origin === "automatic" &&\n\t\t\truntime.recordAutomaticRunProgress\([\s\S]*?\n\t\t\}/g);
  if (legacyProgress?.length !== 1) throw new Error('lifecycle progress classification drift');
  patched = replaceOnce(patched, legacyProgress[0], '', 'remove tool/text progress inference');
  patched = replaceOnce(patched, '\t\tif (finalAssistant?.stopReason === "error") {', `\t\tif (runtime.limitActiveGoalForBudget(ctx, false)) return;
\t\tif (runtime.recordAutomaticRunProgress(ctx, goalId, run.progress, run.origin === "automatic")) return;

\t\tif (finalAssistant?.stopReason === "error") {`, 'completed run accounting');
  patched = replaceOnce(patched, '\t\truntime.clearGoalRecoveryForGoal(goalId);\n\n\t\tif (runtime.limitActiveGoalForBudget(ctx, false)) return;', '\t\truntime.clearGoalRecoveryForGoal(goalId);', 'preserve budget precedence');
  // An exact owned resume prompt commits its promised safety reset first;
  // stale/unowned prompts still pass through the existing rejection gates.
  patched = replaceOnce(patched, '\t\treturn goalContractBoundaryResult(ctx, runtime.activeGoal);', '\t\tif (runtime.enforceNoProgressLimit(ctx, true)) return;\n\t\treturn goalContractBoundaryResult(ctx, runtime.activeGoal);', 'pre-provider deadline fence');
  patched = replaceOnce(patched, '\t\truntime.beginRecoveryRunIfNeeded();', '\t\truntime.beginRecoveryRunIfNeeded(_ctx);', 'recovery pacing lifecycle context');
  for (const callback of ['pi.on("context", (event, ctx) => {', 'pi.on("tool_call", (event, ctx) => {', 'pi.on("tool_execution_end", (_event, ctx) => {']) {
    const anchor = `\t${callback}\n${source.includes('let sessionActive = true;') ? '\t\tif (!sessionActive) return;\n' : ''}`;
    patched = replaceOnce(patched, anchor, `${anchor}\t\tif (runtime.enforceNoProgressLimit(ctx, true)) return;\n`, 'active execution deadline fence');
  }
  return patched;
}

function patchProgressPrompts(source) {
  if (isCompleteMarkedPatch(source, PROGRESS_MARKER, ['Report goal_progress with this exact goal_id:', 'advanced requires concrete evidence of completed objective work', 'Five stalled automatic runs (at least five minutes apart)'], 'Goal progress prompt')) return source;
  let patched = replaceOnce(source, '\t\t"- If progress needs user input or an external event, state the required action and stop the turn.",',
    `\t\t"- Report goal_progress with this exact goal_id: advanced requires concrete evidence of completed objective work; otherwise report stalled. Polling, tool attempts and memory capture are not progress.",
\t\t"- Missing reports count as stalled. Five stalled automatic runs (at least five minutes apart) or a 25-minute stalled deadline set status BLOCKED. Productive work has no default automatic limit.", // ${PROGRESS_MARKER}
\t\t"- If progress needs user input or an external event, state the required action and stop the turn.",`, 'explicit progress prompt');
  patched = replaceOnce(patched, 'This goal_id is only the goal_complete tool stale-turn guard', "This goal_id is the Goal tools' stale-turn guard", 'Goal tool identity guard');
  return patched;
}

export function patchPiGoalStatusSource(source) {
  const compactFormatter = [
    `// ${STATUS_PATCH_MARKER}`,
    'function formatStatus(goal: ActiveGoal | undefined, _automaticTurnLimit?: number | null) {',
    '\tif (!goal) return undefined;',
    '\tif (goal.status === "complete") return "goal - complete";',
    '\tif (goal.waiting) return "goal - waiting";',
    '\tif (goal.status === "active") {',
    '\t\treturn `goal - active ${formatDuration(goal.timeUsedSeconds).replace(/([hm])(?=\\d)/g, "$1 ")}`;',
    '\t}',
    '\treturn `goal - ${goal.status.replaceAll("_", " ")}`;',
    '}',
  ].join('\n');
  if (isCompleteMarkedPatch(source, STATUS_PATCH_MARKER, [compactFormatter], 'Goal status formatter')) return source;
  const formatters = [...source.matchAll(/function formatStatus\([\s\S]*?\n\}/g)];
  // Reviewed formatter bytes from the existing immutable fixtures, after the
  // directory patch's indentation normalization: 0.54.3/4 and 0.54.8/11.
  const reviewed = [
    '9b91ae43f8ffd7cb79d6e2a1ce740766424c720560e49f136c5b87d86740e74b',
    '3dbaaefd124ef663f783f6dd118c07b4bcfa54e10d865300530faf0ad5ce47e3',
  ];
  if (formatters.length !== 1 || !reviewed.includes(createHash('sha256').update(formatters[0][0]).digest('hex'))) {
    throw new Error('Goal status formatter source layout is not reviewed');
  }
  return replaceOnce(source, formatters[0][0], compactFormatter, 'Goal status formatter');
}

// Pure source preparation is shared with the reviewed artifact-metadata step;
// it never imports or executes the upstream package.
export function preparePiGoalSources(originals) {
  // Retain the parent patch's unchanged security/layout anchors on repeat
  // preparation too; the progress marker is not a bypass for those checks.
  const progress = (source, prepare, transform) => transform(prepare(source));
  return {
    commands: patchPiGoalCommandsSource(originals.commands),
    goal: patchPiGoalEntrypointSource(originals.goal),
    lifecycle: progress(originals.lifecycle, patchPiGoalLifecycleSource, patchProgressLifecycle),
    prompts: progress(originals.prompts, patchPiGoalPromptsSource, patchProgressPrompts),
    runtime: progress(originals.runtime, source => patchPiGoalStatusSource(patchPiGoalRuntimeSource(source)), patchProgressRuntime),
    settings: progress(originals.settings, patchPiGoalSettingsSource, patchProgressSettings),
    toolPolicy: progress(originals.toolPolicy, patchPiGoalToolPolicySource, patchProgressToolPolicy),
    tools: patchProgressTools(originals.tools),
    safety: patchProgressSafety(originals.safety),
    persistence: patchProgressPersistence(originals.persistence),
  };
}

export function patchPiGoalDirectory(expectedVersion, directory) {
  if (!expectedVersion || !directory) {
    throw new Error('expected version and package directory are required');
  }
  if (!SUPPORTED_PI_GOAL_VERSIONS.includes(expectedVersion)) {
    throw new Error(
      `review-control patch supports only pi-goal ${SUPPORTED_PI_GOAL_VERSIONS.join(' or ')}; received ${expectedVersion}`,
    );
  }

  const sessionSourceName = 'lifecycle';
  const paths = {
    packageJson: join(directory, 'package.json'),
    commands: join(directory, 'src', 'commands.ts'),
    goal: join(directory, 'src', 'goal.ts'),
    [sessionSourceName]: join(directory, 'src', `${sessionSourceName}.ts`),
    prompts: join(directory, 'src', 'prompts.ts'),
    runtime: join(directory, 'src', 'runtime.ts'),
    settings: join(directory, 'src', 'settings.ts'),
    toolPolicy: join(directory, 'src', 'tool-policy.ts'),
    tools: join(directory, 'src', 'tools.ts'),
    safety: join(directory, 'src', 'safety.ts'),
    persistence: join(directory, 'src', 'persistence.ts'),
  };
  if (Object.values(paths).some((path) => !existsSync(path))) {
    throw new Error(`${directory}: pi-goal package layout is incomplete for ${expectedVersion}`);
  }

  if (expectedVersion === '0.54.15') {
    const info = lstatSync(paths.packageJson);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe Goal package manifest');
    validate05415(directory);
  }
  let packageManifest;
  try {
    packageManifest = JSON.parse(readFileSync(paths.packageJson, 'utf8'));
  } catch (error) {
    throw new Error(
      `${paths.packageJson}: cannot read pi-goal version: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (packageManifest.version !== expectedVersion) {
    throw new Error(`pi-goal ${packageManifest.version ?? 'missing'} != expected ${expectedVersion}`);
  }
  if (expectedVersion === '0.54.15' && packageManifest.name !== '@narumitw/pi-goal') {
    throw new Error('Goal package identity mismatch');
  }
  const declaredEntrypoints = packageManifest.pi?.extensions;
  const entrypointIsSupported = Array.isArray(declaredEntrypoints)
    && declaredEntrypoints.length === 1
    && (declaredEntrypoints[0] === './dist/index.ts' || declaredEntrypoints[0] === './src/index.ts');
  if (!entrypointIsSupported) {
    throw new Error(`${directory}: pi-goal ${expectedVersion} declares an unsupported Pi extension entrypoint`);
  }
  const patchedPackageManifest = `${JSON.stringify({
    ...packageManifest,
    pi: { ...packageManifest.pi, extensions: ['./src/index.ts'] },
  }, null, '\t')}\n`;

  const originals = {
    commands: readFileSync(paths.commands, 'utf8'),
    goal: readFileSync(paths.goal, 'utf8'),
    [sessionSourceName]: readFileSync(paths[sessionSourceName], 'utf8'),
    prompts: readFileSync(paths.prompts, 'utf8'),
    runtime: readFileSync(paths.runtime, 'utf8'),
    settings: readFileSync(paths.settings, 'utf8'),
    toolPolicy: readFileSync(paths.toolPolicy, 'utf8'),
    tools: readFileSync(paths.tools, 'utf8'),
    safety: readFileSync(paths.safety, 'utf8'),
    persistence: readFileSync(paths.persistence, 'utf8'),
  };
  // These reviewed releases use two-space indentation. Round-trip only
  // leading indentation through the existing exact, fail-closed patch anchors.
  if (expectedVersion === '0.54.8' || expectedVersion === '0.54.11' || expectedVersion === '0.54.13' || expectedVersion === '0.54.15') {
    for (const name of Object.keys(originals)) {
      originals[name] = originals[name].replace(/^(?:  )+/gm, (indent) => '\t'.repeat(indent.length / 2));
    }
  }
  const patched = preparePiGoalSources(originals);

  const markers = {
    commands: COMMANDS_PATCH_MARKER,
    goal: GOAL_ENTRYPOINT_PATCH_MARKER,
    [sessionSourceName]: PATCH_MARKER,
    prompts: PROMPTS_PATCH_MARKER,
    runtime: RUNTIME_PATCH_MARKER,
    settings: SETTINGS_PATCH_MARKER,
    toolPolicy: TOOL_POLICY_PATCH_MARKER,
    tools: PROGRESS_MARKER,
    safety: PROGRESS_MARKER,
    persistence: PROGRESS_MARKER,
  };
  for (const [name, marker] of Object.entries(markers)) {
    if (!patched[name].includes(marker)) {
      throw new Error(`${directory}: ${name} patch marker ${marker} is missing`);
    }
  }

  if (expectedVersion === '0.54.15') {
    for (const [name, source] of Object.entries(patched)) {
      const bytes = source.replace(/^\t+/gm, (indent) => '  '.repeat(indent.length));
      const reviewed = REVIEWED_05415[`src/${name === 'toolPolicy' ? 'tool-policy' : name}.ts`];
      if (createHash('sha256').update(bytes).digest('hex') !== reviewed.at(-1)) {
        throw new Error(`Goal prepared source digest changed: ${name}`);
      }
    }
  }
  writeFileSync(paths.packageJson, patchedPackageManifest);
  for (const name of Object.keys(patched)) {
    const source = expectedVersion === '0.54.8' || expectedVersion === '0.54.11' || expectedVersion === '0.54.13' || expectedVersion === '0.54.15'
      ? patched[name].replace(/^\t+/gm, (indent) => '  '.repeat(indent.length))
      : patched[name];
    writeFileSync(paths[name], source);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    patchPiGoalDirectory(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(`[patch-pi-goal] FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
