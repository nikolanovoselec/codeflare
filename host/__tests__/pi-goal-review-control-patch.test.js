import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  COMMANDS_PATCH_MARKER,
  CONTROL_CHANNEL,
  EXPECTED_PI_GOAL_VERSION,
  NEXT_PI_GOAL_VERSION,
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

function writeFixturePackage(root, overrides = {}) {
  mkdirSync(join(root, 'src'));
  const files = {
    'package.json': `${JSON.stringify({ version: EXPECTED_PI_GOAL_VERSION })}\n`,
    'src/commands.ts': fixtureCommandsSource,
    'src/goal.ts': fixtureGoalSource,
    'src/runtime.ts': fixtureRuntimeSource,
    'src/settings.ts': fixtureSettingsSource,
    ...overrides,
  };
  for (const [path, contents] of Object.entries(files)) writeFileSync(join(root, path), contents);
  return files;
}

function readFixturePackage(root, sessionSourceName = 'goal') {
  return Object.fromEntries(
    ['package.json', 'src/commands.ts', `src/${sessionSourceName}.ts`, 'src/runtime.ts', 'src/settings.ts']
      .map((path) => [path, readFileSync(join(root, path), 'utf8')]),
  );
}

const NEXT_PACKAGE_ARCHIVE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '__fixtures__',
  'pi-goal-0.49.7.tgz',
);
const NEXT_PACKAGE_INTEGRITY = 'sha512-7FznIa3HGEsMkppnv7CLW6/TCvtuslKdk+BgrcvNrmJVK/HJfo5rTBCxCzahW2BbEy47Ixfsdqzrg6HL4LX8qw==';

function extractPinnedNextFixturePackage(root) {
  const archive = readFileSync(NEXT_PACKAGE_ARCHIVE);
  assert.equal(`sha512-${createHash('sha512').update(archive).digest('base64')}`, NEXT_PACKAGE_INTEGRITY);
  execFileSync('tar', ['-xzf', NEXT_PACKAGE_ARCHIVE, '-C', root, '--strip-components=1'], { stdio: 'ignore' });
}

describe('REQ-AGENT-111: pi-goal review control and continuation patch', () => {
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

  it('REQ-AGENT-111: applies every marked patch idempotently to the locked fixtures', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-goal-review-control-'));
    writeFixturePackage(root);

    patchPiGoalDirectory(EXPECTED_PI_GOAL_VERSION, root);
    const first = readFixturePackage(root);
    assert.match(first['src/commands.ts'], new RegExp(COMMANDS_PATCH_MARKER));
    assert.match(first['src/goal.ts'], new RegExp(PATCH_MARKER));
    assert.match(first['src/runtime.ts'], new RegExp(RUNTIME_PATCH_MARKER));
    assert.match(first['src/settings.ts'], new RegExp(SETTINGS_PATCH_MARKER));

    patchPiGoalDirectory(EXPECTED_PI_GOAL_VERSION, root);
    assert.deepEqual(readFixturePackage(root), first);
  });

  it('REQ-AGENT-111/REQ-OPS-020: patches the cooldown-eligible pi-goal layout without double registration', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-goal-next-review-control-'));
    extractPinnedNextFixturePackage(root);

    patchPiGoalDirectory(NEXT_PI_GOAL_VERSION, root);
    const first = readFixturePackage(root, 'lifecycle');
    assert.match(first['src/commands.ts'], new RegExp(COMMANDS_PATCH_MARKER));
    assert.match(first['src/commands.ts'], /abortTurn: options\.abortTurn/);
    assert.match(first['src/lifecycle.ts'], new RegExp(PATCH_MARKER));
    assert.match(first['src/runtime.ts'], new RegExp(RUNTIME_PATCH_MARKER));
    assert.match(first['src/runtime.ts'], /kind: "explicit_pause"; expectedGoalId: string; abortTurn\?: boolean/);
    assert.match(first['src/runtime.ts'], /if \(request\.abortTurn !== false\) abortCurrentTurn\(ctx\);/);
    assert.match(first['src/settings.ts'], new RegExp(SETTINGS_PATCH_MARKER));
    assert.equal(first['src/lifecycle.ts'].match(/runController\.register/g), null);
    assert.match(first['src/settings.ts'], /automaticTurns: 25, noProgressTurns: 3, minIntervalMs: 0/);

    patchPiGoalDirectory(NEXT_PI_GOAL_VERSION, root);
    assert.deepEqual(readFixturePackage(root, 'lifecycle'), first);
  });

  it('REQ-AGENT-111: version or source drift fails before any package file is written', () => {
    // The current expected half is derived. The admitted successor stays literal
    // in the refusal assertion, so changing the bounded compatibility window must
    // update both the successful candidate fixture and this fail-closed contract.
    // The installed 0.44.0 stays literal because it is this fixture's own value.
    const expected = EXPECTED_PI_GOAL_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const versionDrift = mkdtempSync(join(tmpdir(), 'pi-goal-version-drift-'));
    writeFixturePackage(versionDrift, { 'package.json': '{"version":"0.44.0"}\n' });
    const versionBytes = readFixturePackage(versionDrift);
    assert.throws(
      () => patchPiGoalDirectory(EXPECTED_PI_GOAL_VERSION, versionDrift),
      new RegExp(`pi-goal 0\\.44\\.0 != expected ${expected}`),
    );
    assert.deepEqual(readFixturePackage(versionDrift), versionBytes);
    assert.throws(
      () => patchPiGoalDirectory('0.44.0', versionDrift),
      new RegExp(`review-control patch supports only pi-goal ${expected} or 0\\.49\\.7`),
    );
    assert.deepEqual(readFixturePackage(versionDrift), versionBytes);

    const sourceDrift = mkdtempSync(join(tmpdir(), 'pi-goal-source-drift-'));
    writeFixturePackage(sourceDrift, {
      'src/runtime.ts': fixtureRuntimeSource.replace(
        'dispatchContinuationIfSettled',
        'dispatchContinuationWhenReady',
      ),
    });
    const sourceBytes = readFixturePackage(sourceDrift);
    assert.throws(
      () => patchPiGoalDirectory(EXPECTED_PI_GOAL_VERSION, sourceDrift),
      /continuation dispatcher anchor count 0; expected 1/,
    );
    assert.deepEqual(readFixturePackage(sourceDrift), sourceBytes);
  });
});
