import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');

// REQ-OPS-011 AC5: the approved base-source and immutable version pins are a security allowlist.
// The new tooling index and Linux amd64 manifest digests were checked at the mirror.
// Actual layer pulls and compiled-artifact execution remain image qualification gates.
describe('REQ-OPS-011 AC5: approved immutable Node base source', () => {
  it('resolves every build and runtime stage to the approved compiler, dependency-install and runtime indices', () => {
    const stages = [...dockerfile.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/gm)]
      .map(([, reference, stage]) => [stage ?? 'runtime', reference]);
    const node26 = 'mirror.gcr.io/library/node:26-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9';
    const sidebarTooling = 'mirror.gcr.io/library/node:26.12.0-bookworm-slim@sha256:742a0fe7320e09e0321222b68165e6ac731d30470e7ea7f98f9bfc3a6e1034fe';
    const node22 = 'mirror.gcr.io/library/node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c';

    assert.deepEqual(stages, [
      ['builder', node26],
      ['rclone-builder', node26],
      ['impeccable-builder', node26],
      ['openvscode-agent-sidebar-dependencies', node22],
      ['openvscode-agent-sidebar-builder', sidebarTooling],
      ['openvscode-official-claude-extension', sidebarTooling],
      ['openvscode-agent-inventories', sidebarTooling],
      ['runtime', node26],
    ]);
  });
});
