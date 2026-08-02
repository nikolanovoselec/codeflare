#!/usr/bin/env node
// Adds Codeflare's session-local PR-review pause/resume control channel to the
// exact locked pi-goal release. The reviewed upstream layout exposes no public
// control for an ordinary /goal: Managed Run RPC can only cancel an RPC-owned
// run, and pi.sendUserMessage('/goal pause') is a model prompt rather than a
// command invocation. The image-build patch therefore delegates directly to
// pi-goal's own GoalCommandController so persistence, stale guards, accounting,
// prompts, and tool policy remain owned by pi-goal.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PATCH_MARKER = 'CODEFLARE_GOAL_CONTROL_CHANNEL';
export const CONTROL_CHANNEL = 'codeflare:pi-goal:control';

const CONTROL_BLOCK = `
\tlet codeflareControlCtx: StatusContext | undefined;
\tconst CODEFLARE_GOAL_CONTROL_CHANNEL = "${CONTROL_CHANNEL}";
\trunController.register(pi);
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
\t\t\t\tcommands.pauseGoal(ctx);
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
\t\t\tawait commands.resumeGoal(ctx);
\t\t\tconst resumed = runtime.activeGoal;
\t\t\trespond(Boolean(resumed && resumed.id !== goal.id && resumed.status === "active"), resumed?.id ?? goal.id, resumed?.status ?? "missing");
\t\t} catch {
\t\t\trespond(false, goal.id, runtime.activeGoal?.status ?? "missing");
\t\t}
\t});`;

function replaceOnce(source, search, replacement, label) {
  const count = source.split(search).length - 1;
  if (count !== 1) throw new Error(`${label} anchor count ${count}; expected 1`);
  return source.replace(search, replacement);
}

export function patchPiGoalSource(source) {
  if (source.includes(PATCH_MARKER)) return source;
  let patched = replaceOnce(
    source,
    '\tconst runController = new GoalRunController(runtime, commands);\n\trunController.register(pi);',
    `\tconst runController = new GoalRunController(runtime, commands);${CONTROL_BLOCK}`,
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

export function patchPiGoalDirectory(expectedVersion, directory) {
  if (!expectedVersion || !directory) throw new Error('expected version and package directory are required');
  const packageJsonPath = join(directory, 'package.json');
  const goalSourcePath = join(directory, 'src', 'goal.ts');
  if (!existsSync(packageJsonPath) || !existsSync(goalSourcePath)) {
    throw new Error(`${directory}: pi-goal package layout is incomplete`);
  }
  const actualVersion = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
  if (actualVersion !== expectedVersion) {
    throw new Error(`pi-goal ${actualVersion ?? 'missing'} != expected ${expectedVersion}`);
  }
  const patched = patchPiGoalSource(readFileSync(goalSourcePath, 'utf8'));
  writeFileSync(goalSourcePath, patched);
  if (!readFileSync(goalSourcePath, 'utf8').includes(PATCH_MARKER)) {
    throw new Error(`${goalSourcePath}: review control patch is missing`);
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
