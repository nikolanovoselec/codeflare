import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  CONTROL_CHANNEL,
  PATCH_MARKER,
  patchPiGoalDirectory,
  patchPiGoalSource,
} from '../../scripts/patch-pi-goal-review-control.mjs';

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
  it('adds one idempotent session-bound pause/resume control contract', () => {
    const patched = patchPiGoalSource(fixtureSource);

    assert.match(patched, new RegExp(PATCH_MARKER));
    assert.match(patched, new RegExp(CONTROL_CHANNEL.replaceAll(':', '\\:')));
    assert.match(patched, /commands\.pauseGoal\(ctx\)/);
    assert.match(patched, /request\.accepted\?\.\(\)/);
    assert.match(patched, /await commands\.resumeGoal\(ctx\)/);
    assert.match(patched, /codeflareControlCtx = ctx/);
    assert.match(patched, /codeflareControlCtx = undefined/);
    assert.equal(patchPiGoalSource(patched), patched);
  });

  it('fails closed on package-version or source-layout drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-goal-review-control-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), '{"version":"0.43.0"}\n');
    writeFileSync(join(root, 'src/goal.ts'), fixtureSource);

    patchPiGoalDirectory('0.43.0', root);
    assert.match(readFileSync(join(root, 'src/goal.ts'), 'utf8'), new RegExp(PATCH_MARKER));
    assert.throws(() => patchPiGoalDirectory('0.44.0', root), /0\.43\.0 != expected 0\.44\.0/);
  });
});
