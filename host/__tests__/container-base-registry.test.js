import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');

// REQ-OPS-011 AC5: the approved base-source and immutable version pins are a security allowlist.
// Both OCI index digests and their Linux amd64 child/layer availability were checked at the mirror.
describe('REQ-OPS-011 AC5: approved immutable Node base source', () => {
  it('resolves every build and runtime stage to the same verified Node 26 and Node 22 indices', () => {
    const stages = [...dockerfile.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/gm)]
      .map(([, reference, stage]) => [stage ?? 'runtime', reference]);
    const node26 = 'mirror.gcr.io/library/node:26-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e';
    const node22 = 'mirror.gcr.io/library/node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c';

    assert.deepEqual(stages, [
      ['builder', node26],
      ['rclone-builder', node26],
      ['impeccable-builder', node26],
      ['openvscode-agent-sidebar-builder', node22],
      ['openvscode-official-claude-extension', node22],
      ['openvscode-agent-inventories', node22],
      ['runtime', node26],
    ]);
  });
});
