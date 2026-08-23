#!/usr/bin/env node
// Applies Codeflare's reviewed compatibility patch to the exact locked pi-goal
// release. The package remains upstream-owned and integrity-locked; this version-aware
// image-build transform adds the session-local PR-review control
// channel and a bounded continuation dispatch interval without a companion
// extension or permanent fork. Every transformed source is calculated before
// any package file is written so version or source-layout drift fails closed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXPECTED_PI_GOAL_VERSION = '0.53.0';
export const SUPPORTED_PI_GOAL_VERSIONS = Object.freeze([
  EXPECTED_PI_GOAL_VERSION,
]);
export const PATCH_MARKER = 'CODEFLARE_GOAL_CONTROL_CHANNEL';
export const GOAL_ENTRYPOINT_PATCH_MARKER = 'CODEFLARE_GOAL_LIFECYCLE_COMMANDS';
export const COMMANDS_PATCH_MARKER = 'CODEFLARE_SUPPRESS_RESUME_PROMPT';
export const SETTINGS_PATCH_MARKER = 'CODEFLARE_GOAL_MIN_INTERVAL_SETTINGS';
export const RUNTIME_PATCH_MARKER = 'CODEFLARE_GOAL_MIN_INTERVAL_RUNTIME';
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
\t\tif (this.continuationTimer) return false;
\t\tif (minIntervalMs === 0) return deliver();

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
    ') {\n\tpi.on("session_start", async (_event, ctx) => {',
    `) {${CONTROL_BLOCK}\n\n\tpi.on("session_start", async (_event, ctx) => {`,
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
        'minIntervalMs: 0',
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
  patched = replaceOnce(
    patched,
    continuationLimitNormalizer,
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
              'let remainingMs = this.settings.continuationLimits.minIntervalMs;',
              'const delayMs = Math.min(remainingMs, 2_147_483_647);',
              'this.continuationIntent?.marker !== marker',
              'options: { intervalElapsed?: boolean } = {}',
              'if (this.settings.continuationLimits.minIntervalMs > 0) {',
              'return this.scheduleContinuationDispatch(ctx, intent.goalId);',
              'if (this.continuationDispatchTimer) return false;',
              'this.dispatchContinuationIfSettled(ctx, { intervalElapsed: true });',
            ]
          : [
              'const minIntervalMs = this.settings.continuationLimits.minIntervalMs;',
              'this.menuGeneration !== menuGeneration',
              'this.clearContinuationTimer();',
            ]),
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
        '\t\t\tif (this.continuationDispatchTimer) return false;',
        '\t\t\tif (this.settings.continuationLimits.minIntervalMs > 0) {',
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
    patched = replaceOnce(
      patched,
      RUNTIME_NATIVE_SCHEDULER_SOURCE,
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
    runtime: join(directory, 'src', 'runtime.ts'),
    settings: join(directory, 'src', 'settings.ts'),
  };
  if (Object.values(paths).some((path) => !existsSync(path))) {
    throw new Error(`${directory}: pi-goal package layout is incomplete for ${expectedVersion}`);
  }

  let actualVersion;
  try {
    actualVersion = JSON.parse(readFileSync(paths.packageJson, 'utf8')).version;
  } catch (error) {
    throw new Error(
      `${paths.packageJson}: cannot read pi-goal version: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (actualVersion !== expectedVersion) {
    throw new Error(`pi-goal ${actualVersion ?? 'missing'} != expected ${expectedVersion}`);
  }

  const originals = {
    commands: readFileSync(paths.commands, 'utf8'),
    goal: readFileSync(paths.goal, 'utf8'),
    [sessionSourceName]: readFileSync(paths[sessionSourceName], 'utf8'),
    runtime: readFileSync(paths.runtime, 'utf8'),
    settings: readFileSync(paths.settings, 'utf8'),
  };
  const patched = {
    commands: patchPiGoalCommandsSource(originals.commands),
    goal: patchPiGoalEntrypointSource(originals.goal),
    [sessionSourceName]: sessionSourceName === 'lifecycle'
      ? patchPiGoalLifecycleSource(originals[sessionSourceName])
      : patchPiGoalSource(originals[sessionSourceName]),
    runtime: patchPiGoalRuntimeSource(originals.runtime),
    settings: patchPiGoalSettingsSource(originals.settings),
  };

  const markers = {
    commands: COMMANDS_PATCH_MARKER,
    goal: GOAL_ENTRYPOINT_PATCH_MARKER,
    [sessionSourceName]: PATCH_MARKER,
    runtime: RUNTIME_PATCH_MARKER,
    settings: SETTINGS_PATCH_MARKER,
  };
  for (const [name, marker] of Object.entries(markers)) {
    if (!patched[name].includes(marker)) {
      throw new Error(`${directory}: ${name} patch marker ${marker} is missing`);
    }
  }

  for (const name of ['commands', 'goal', sessionSourceName, 'runtime', 'settings']) {
    writeFileSync(paths[name], patched[name]);
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
