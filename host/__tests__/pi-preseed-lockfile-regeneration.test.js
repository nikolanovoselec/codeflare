import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const regenerateScript = resolve(__dirname, '../../scripts/regenerate-pi-preseed-lock.mjs');

describe('REQ-OPS-020: Pi preseed lockfile regeneration', () => {
  it('creates the lockfile without executing package lifecycle scripts', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'codeflare-pi-lock-'));
    const lifecycleMarker = join(fixture, 'postinstall-ran');

    try {
      writeFileSync(
        join(fixture, 'postinstall.cjs'),
        "require('node:fs').writeFileSync('postinstall-ran', 'ran');\n",
      );
      writeFileSync(
        join(fixture, 'package.json'),
        JSON.stringify({
          name: 'pi-preseed-lock-fixture',
          version: '1.0.0',
          private: true,
          scripts: {
            postinstall: 'node postinstall.cjs',
          },
        }),
      );

      const result = spawnSync(process.execPath, [regenerateScript, fixture], {
        encoding: 'utf8',
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(lifecycleMarker), false);
      const lockfile = JSON.parse(readFileSync(join(fixture, 'package-lock.json'), 'utf8'));
      assert.equal(lockfile.name, 'pi-preseed-lock-fixture');
      assert.equal(lockfile.lockfileVersion, 3);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
