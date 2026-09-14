import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as smoke from '../../scripts/ci/smoke-openvscode-sidebar-image.mjs';

describe('REQ-OPS-011 AC1: packaged runtime identity', () => {
  async function withRelease(contents, run) {
    const directory = await mkdtemp(join(tmpdir(), 'container-runtime-smoke-'));
    try {
      const osReleasePath = join(directory, 'os-release');
      await writeFile(osReleasePath, contents);
      await run(osReleasePath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it('accepts Node 26 and Debian bookworm from the runtime release file', async () => {
    for (const release of ['ID=debian\nVERSION_CODENAME=bookworm\n', 'ID="debian"\nVERSION_CODENAME="bookworm"\n']) {
      await withRelease(release, async (osReleasePath) => {
        assert.deepEqual(await smoke.verifyContainerRuntime({ nodeVersion: '26.8.1', osReleasePath }), {
          nodeVersion: '26.8.1', distribution: 'debian', codename: 'bookworm',
        });
      });
    }
  });

  it('rejects an older or malformed Node runtime even on the correct distribution', async () => {
    await withRelease('ID=debian\nVERSION_CODENAME=bookworm\n', async (osReleasePath) => {
      for (const nodeVersion of ['24.16.0', '22.21.1', '126.8.1', '26.8.1-beta.1']) {
        await assert.rejects(smoke.verifyContainerRuntime({ nodeVersion, osReleasePath }), /Node 26/);
      }
    });
  });

  it('rejects another distribution, another Debian release, and commented identity', async () => {
    for (const release of [
      'ID=alpine\nVERSION_CODENAME=bookworm\n',
      'ID=debian\nVERSION_CODENAME=trixie\n',
      '# ID=debian\n# VERSION_CODENAME=bookworm\n',
      '',
    ]) {
      await withRelease(release, async (osReleasePath) => {
        await assert.rejects(smoke.verifyContainerRuntime({ nodeVersion: '26.8.1', osReleasePath }), /Debian|bookworm/);
      });
    }
  });

  it('fails closed if runtime release evidence is missing', async () => {
    await withRelease('', async (osReleasePath) => {
      await rm(osReleasePath);
      await assert.rejects(smoke.verifyContainerRuntime({ nodeVersion: '26.8.1', osReleasePath }), /ENOENT/);
    });
  });
});
