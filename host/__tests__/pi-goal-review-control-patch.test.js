import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  CONTROL_CHANNEL,
  PATCH_MARKER,
  patchPiGoalCommandsSource,
  patchPiGoalDirectory,
  patchPiGoalSource,
} from '../../scripts/patch-pi-goal-review-control.mjs';

const fixtureCommandsSource = `export class GoalCommandController {
\tconstructor(runtime) {
\t\tthis.runtime = runtime;
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

function executablePatchedController() {
  const patched = patchPiGoalCommandsSource(fixtureCommandsSource)
    .replace('export class GoalCommandController', 'class GoalCommandController')
    .replace(
      'ctx: StatusContext, options: { sendPrompt?: boolean } = {}',
      'ctx, options = {}',
    );
  return Function(
    'buildResumePrompt',
    `${patched}\nreturn GoalCommandController;`,
  )((goal, status) => `${goal.id}:${status}`);
}

const fixtureSource = `function registerGoalRuntime(pi: ExtensionAPI, options: GoalOptions = {}) {
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

describe('REQ-AGENT-111: pi-goal review control patch', () => {
  it('REQ-AGENT-111/REQ-AGENT-112: adds one idempotent session-bound pause/resume control contract', () => {
    const patched = patchPiGoalSource(fixtureSource);

    assert.match(patched, new RegExp(PATCH_MARKER));
    assert.match(patched, new RegExp(CONTROL_CHANNEL.replaceAll(':', '\\:')));
    assert.match(patched, /commands\.pauseGoal\(ctx\)/);
    assert.match(patched, /request\.accepted\?\.\(\)/);
    assert.match(patched, /await commands\.resumeGoal\(ctx, \{ sendPrompt: false \}\)/);
    const patchedCommands = patchPiGoalCommandsSource(fixtureCommandsSource);
    assert.match(patchedCommands, /options: \{ sendPrompt\?: boolean \} = \{\}/);
    assert.match(patchedCommands, /options\.sendPrompt === false \|\| await this\.runtime\.sendOwnedGoalPrompt/);
    assert.equal(patchPiGoalCommandsSource(patchedCommands), patchedCommands);
    assert.match(patched, /codeflareControlCtx = ctx/);
    assert.match(patched, /codeflareControlCtx = undefined/);
    assert.equal(patchPiGoalSource(patched), patched);
  });

  it('REQ-AGENT-112: suppresses only the bridge-owned resume prompt', async () => {
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

  it('REQ-AGENT-111: fails closed on package-version or source-layout drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-goal-review-control-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), '{"version":"0.43.0"}\n');
    writeFileSync(join(root, 'src/commands.ts'), fixtureCommandsSource);
    writeFileSync(join(root, 'src/goal.ts'), fixtureSource);

    patchPiGoalDirectory('0.43.0', root);
    assert.match(readFileSync(join(root, 'src/goal.ts'), 'utf8'), new RegExp(PATCH_MARKER));
    assert.throws(() => patchPiGoalDirectory('0.44.0', root), /0\.43\.0 != expected 0\.44\.0/);

    const driftedRoot = mkdtempSync(join(tmpdir(), 'pi-goal-review-control-drift-'));
    mkdirSync(join(driftedRoot, 'src'));
    writeFileSync(join(driftedRoot, 'package.json'), '{"version":"0.43.0"}\n');
    writeFileSync(
      join(driftedRoot, 'src/commands.ts'),
      fixtureCommandsSource.replace('async resumeGoal', 'async continueGoal'),
    );
    writeFileSync(join(driftedRoot, 'src/goal.ts'), fixtureSource);

    assert.throws(
      () => patchPiGoalDirectory('0.43.0', driftedRoot),
      /resume command signature anchor count 0; expected 1/,
    );
    assert.equal(readFileSync(join(driftedRoot, 'src/goal.ts'), 'utf8'), fixtureSource);
  });
});
