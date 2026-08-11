// Fixture directories that clean themselves up.
//
// Every mkdtempSync fixture in this suite used to outlive its run. On one
// container that came to 603 leftover directories and 112 MB, on a 5.5 GB
// disk, discovered only when the disk filled. node:test has no implicit
// teardown, so the ask lives here once instead of at twelve call sites.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const created = [];

export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

// Best effort, and deliberately so: a fixture still held open by a detached
// lock holder must not fail a run that already passed. splice(0) keeps this
// idempotent if the module is ever shared across files in one process.
after(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
