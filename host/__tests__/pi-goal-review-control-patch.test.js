import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, transform } from 'esbuild';

import {
  COMMANDS_PATCH_MARKER,
  CONTROL_CHANNEL,
  EXPECTED_PI_GOAL_VERSION,
  GOAL_ENTRYPOINT_PATCH_MARKER,
  PATCH_MARKER,
  RUNTIME_PATCH_MARKER,
  SETTINGS_PATCH_MARKER,
  patchPiGoalCommandsSource,
  patchPiGoalDirectory,
  patchPiGoalRuntimeSource,
  patchPiGoalSettingsSource,
  patchPiGoalSource,
} from '../../scripts/patch-pi-goal-review-control.mjs';

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

const fixtureSettingsSource = `export interface GoalSettings {
\tcontinuationLimits: {
\t\tautomaticTurns: ContinuationLimit;
\t\tnoProgressTurns: ContinuationLimit;
\t};
}

export const DEFAULT_GOAL_SETTINGS: GoalSettings = {
\tcontinuationLimits: { automaticTurns: null, noProgressTurns: 3 },
};

export function normalizeGoalSettings(value: unknown) {
\tif (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
\tconst continuationLimitsValue = Object.hasOwn(value, "continuationLimits")
\t\t? Reflect.get(value, "continuationLimits")
\t\t: undefined;
\tif (
\t\tcontinuationLimitsValue !== undefined &&
\t\t(typeof continuationLimitsValue !== "object" ||
\t\t\tcontinuationLimitsValue === null ||
\t\t\tArray.isArray(continuationLimitsValue))
\t) {
\t\treturn undefined;
\t}
\tconst automaticTurns = continuationLimitsValue
\t\t? normalizeContinuationLimit(
\t\t\t\tReflect.get(continuationLimitsValue, "automaticTurns"),
\t\t\t\tDEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns,
\t\t\t)
\t\t: DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns;
\tconst noProgressTurns = continuationLimitsValue
\t\t? normalizeContinuationLimit(
\t\t\t\tReflect.get(continuationLimitsValue, "noProgressTurns"),
\t\t\t\tDEFAULT_GOAL_SETTINGS.continuationLimits.noProgressTurns,
\t\t\t)
\t\t: DEFAULT_GOAL_SETTINGS.continuationLimits.noProgressTurns;
\tif (automaticTurns === undefined || noProgressTurns === undefined) return undefined;

\treturn {
\t\tcontinuationLimits: { automaticTurns, noProgressTurns },
\t};
}

function normalizeContinuationLimit(
\tvalue: unknown,
\tfallback: ContinuationLimit,
): ContinuationLimit | undefined {
\tif (value === undefined) return fallback;
\tif (value === null) return null;
\treturn typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function buildSavedGoalSettings(normalized, raw) {
\tconst continuationLimits = raw.continuationLimits ?? {};
\treturn {
\t\t...raw,
\t\tcontinuationLimits: {
\t\t\t\t...continuationLimits,
\t\t\t\tautomaticTurns: normalized.continuationLimits.automaticTurns,
\t\t\t\tnoProgressTurns: normalized.continuationLimits.noProgressTurns,
\t\t\t},
\t};
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
\t\t\t\tthis.activeGoal.status !== "active"
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

function executablePatchedSettings() {
  const patched = patchPiGoalSettingsSource(fixtureSettingsSource)
    .replace(/export interface GoalSettings \{[\s\S]*?\n\}\n\n/, '')
    .replace(
      'export const DEFAULT_GOAL_SETTINGS: GoalSettings =',
      'const DEFAULT_GOAL_SETTINGS =',
    )
    .replace('export function normalizeGoalSettings(value: unknown)', 'function normalizeGoalSettings(value)')
    .replace(
      'function normalizeContinuationLimit(\n\tvalue: unknown,\n\tfallback: ContinuationLimit,\n): ContinuationLimit | undefined {',
      'function normalizeContinuationLimit(value, fallback) {',
    )
    .replace(
      'function normalizeMinIntervalMs(\n\tvalue: unknown,\n\tfallback: number,\n): number | undefined {',
      'function normalizeMinIntervalMs(value, fallback) {',
    )
    .replace('export function buildSavedGoalSettings', 'function buildSavedGoalSettings');
  return Function(
    `${patched}\nreturn { DEFAULT_GOAL_SETTINGS, normalizeGoalSettings, buildSavedGoalSettings };`,
  )();
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
    ['package.json', 'src/commands.ts', 'src/goal.ts', `src/${sessionSourceName}.ts`, 'src/runtime.ts', 'src/settings.ts']
      .map((path) => [path, readFileSync(join(root, path), 'utf8')]),
  );
}

const FIXTURES_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__');
const PINNED_PACKAGE_ARCHIVE = join(FIXTURES_DIRECTORY, 'pi-goal-0.53.0.tgz');
const PINNED_PACKAGE_INTEGRITY = 'sha512-cmWowqAzlkgRLKYp2hFnUZvEEs6G6aGjEOazBWNW88T7LB9cd/AzOFOGYvA1QxxsGtIdOuFRZJVhfAJDGsAcjw==';
const PINNED_PLAN_ARCHIVE = join(FIXTURES_DIRECTORY, 'narumitw-pi-plan-mode-0.52.0.tgz');
const PINNED_PLAN_INTEGRITY = 'sha512-h2mye4GFa9slqP17NhInBHv2GW3pYwMY76HHENHuwrMr/dOGXRdNacxfwbJSy1njozxlcnWvgdG6a7pE8UPBiw==';

function extractPackage(archivePath, integrity, root) {
  const archive = readFileSync(archivePath);
  assert.equal(`sha512-${createHash('sha512').update(archive).digest('base64')}`, integrity);
  execFileSync('tar', ['-xzf', archivePath, '-C', root, '--strip-components=1'], { stdio: 'ignore' });
}

function extractPinnedFixturePackage(root) {
  extractPackage(PINNED_PACKAGE_ARCHIVE, PINNED_PACKAGE_INTEGRITY, root);
}

async function bundleFixture(entryPoint, outputPath) {
  await build({
    entryPoints: [entryPoint],
    outfile: outputPath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    nodePaths: [join(process.cwd(), 'node_modules')],
  });
  return (await import(`${pathToFileURL(outputPath).href}?fixture=${Date.now()}`)).default;
}

function createExtensionHarness() {
  const commands = new Map();
  const lifecycle = new Map();
  const eventListeners = new Map();
  const notifications = [];
  const entries = [];
  let activeTools = [];
  let thinkingLevel = 'medium';
  const sessionManager = {
    getBranch: () => entries,
    getEntries: () => entries,
  };
  const ui = new Proxy({
    notify: (message, level) => notifications.push({ message, level }),
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
    registerTool: () => undefined,
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
    sendUserMessage: async () => undefined,
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
    notifications,
    startSession: async () => {
      for (const listener of lifecycle.get('session_start') ?? []) await listener({}, ctx);
    },
  };
}

describe('REQ-AGENT-111: pi-goal review control and continuation patch', () => {
  it('REQ-AGENT-111 AC6/AC7: pinned Goal and Plan Mode refuse overlap and release ownership', async () => {
    const goalRoot = mkdtempSync(join(tmpdir(), 'pi-goal-integration-'));
    const planRoot = mkdtempSync(join(tmpdir(), 'pi-plan-integration-'));
    extractPinnedFixturePackage(goalRoot);
    extractPackage(PINNED_PLAN_ARCHIVE, PINNED_PLAN_INTEGRITY, planRoot);
    patchPiGoalDirectory(EXPECTED_PI_GOAL_VERSION, goalRoot);
    const goalExtension = await bundleFixture(join(goalRoot, 'src/index.ts'), join(goalRoot, 'goal.mjs'));
    const planExtension = await bundleFixture(join(planRoot, 'dist/index.ts'), join(planRoot, 'plan.mjs'));
    const harness = createExtensionHarness();
    goalExtension(harness.api, { settingsPath: join(goalRoot, 'settings.json') });
    planExtension(harness.api, { settingsPath: join(planRoot, 'settings.json') });
    await harness.startSession();

    await harness.commands.get('goal').handler('first integration objective', harness.ctx);
    assert.ok(harness.activeTools().includes('goal_complete'));
    await harness.commands.get('plan').handler('start', harness.ctx);
    assert.ok(!harness.activeTools().includes('plan_mode_complete'));
    assert.match(harness.notifications.at(-1).message, /Another workflow is active/);

    await harness.commands.get('goal').handler('clear', harness.ctx);
    await harness.commands.get('plan').handler('start', harness.ctx);
    assert.ok(harness.activeTools().includes('plan_mode_complete'));
    await harness.commands.get('plan').handler('exit', harness.ctx);
    await harness.commands.get('goal').handler('second integration objective', harness.ctx);
    assert.ok(harness.activeTools().includes('goal_complete'));

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

  it('REQ-AGENT-130 AC4: successor repeated dispatch remains single-flight', () => {
    const { runtime, scheduler, messages, ctx } = successorRuntimeHarness(25);

    assert.equal(runtime.dispatchContinuationIfSettled(ctx), true);
    assert.equal(runtime.dispatchContinuationIfSettled(ctx), false);
    assert.equal(scheduler.pendingCount(), 1);
    assert.deepEqual(scheduler.armedDelays(), [25]);
    scheduler.advance(25);
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

  it('REQ-AGENT-130 AC4: keeps repeated settled events single-flight', () => {
    const { runtime, scheduler, messages, ctx } = runtimeHarness(60_000);

    runtime.dispatchContinuationIfSettled(ctx);
    runtime.dispatchContinuationIfSettled(ctx);
    runtime.dispatchContinuationIfSettled(ctx);
    assert.equal(scheduler.pendingCount(), 1);

    scheduler.advance(60_000);
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

  it('REQ-AGENT-129 AC5: rejects invalid minIntervalMs values', () => {
    const { normalizeGoalSettings } = executablePatchedSettings();
    for (const minIntervalMs of [null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(
        normalizeGoalSettings({ continuationLimits: { minIntervalMs } }),
        undefined,
        `expected ${String(minIntervalMs)} to be rejected`,
      );
    }
  });

  it('REQ-AGENT-129 AC6: defaults a missing delay to zero', () => {
    const { normalizeGoalSettings } = executablePatchedSettings();
    const normalized = normalizeGoalSettings({ continuationLimits: {} });
    assert.deepEqual(normalized, {
      continuationLimits: { automaticTurns: null, noProgressTurns: 3, minIntervalMs: 0 },
    });
  });

  it('REQ-AGENT-129 AC7: saves the delay without dropping unknown fields', () => {
    const { normalizeGoalSettings, buildSavedGoalSettings } = executablePatchedSettings();
    const saved = buildSavedGoalSettings(
      { continuationLimits: { automaticTurns: 10, noProgressTurns: null, minIntervalMs: 60_000 } },
      { unknownRoot: 'keep', continuationLimits: { unknownLimit: 'keep' } },
    );
    assert.deepEqual(saved, {
      unknownRoot: 'keep',
      continuationLimits: {
        unknownLimit: 'keep',
        automaticTurns: 10,
        noProgressTurns: null,
        minIntervalMs: 60_000,
      },
    });
    assert.equal(
      normalizeGoalSettings({ continuationLimits: { minIntervalMs: Number.MAX_SAFE_INTEGER } })
        .continuationLimits.minIntervalMs,
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('REQ-AGENT-111/REQ-OPS-020: patches the exact latest pi-goal layout without double registration', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-goal-latest-review-control-'));
    extractPinnedFixturePackage(root);

    assert.equal(EXPECTED_PI_GOAL_VERSION, '0.53.0');
    patchPiGoalDirectory(EXPECTED_PI_GOAL_VERSION, root);
    const first = readFixturePackage(root, 'lifecycle');
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
