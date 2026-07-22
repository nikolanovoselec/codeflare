import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'vitest';

import {
  SIDEBAR_PROCESS_GENERATION_ENV,
  listSidebarGenerationMembers,
  reapSidebarGeneration,
} from '../src/process-generation.ts';

const startedGroups: number[] = [];

afterEach(() => {
  for (const processGroup of startedGroups.splice(0)) {
    try {
      process.kill(-processGroup, 'SIGKILL');
    } catch {
      // The generation reaper normally removed the fixture already.
    }
  }
});

test('REQ-IDE-005 AC7: one sidebar generation reaps a TERM-ignoring descendant in another process group', async () => {
  const token = `test-${randomUUID()}`;
  const leader = spawn(
    '/bin/sh',
    [
      '-c',
      "trap '' TERM; /usr/bin/setsid /bin/sh -c 'trap \"\" TERM; while :; do sleep 1; done' & while :; do sleep 1; done",
    ],
    {
      detached: true,
      env: { ...process.env, [SIDEBAR_PROCESS_GENERATION_ENV]: token },
      stdio: 'ignore',
    },
  );
  const leaderPid = leader.pid;
  assert.ok(leaderPid);
  startedGroups.push(leaderPid);

  const before = await waitForMembers(token, 2);
  assert.ok(new Set(before.map((member) => member.processGroup)).size >= 2);

  await reapSidebarGeneration(token, { termGraceMs: 50, killGraceMs: 500, pollMs: 10 });

  assert.deepEqual(await listSidebarGenerationMembers(token), []);
});

async function waitForMembers(token: string, minimum: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const members = await listSidebarGenerationMembers(token);
    if (members.length >= minimum) return members;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return listSidebarGenerationMembers(token);
}
