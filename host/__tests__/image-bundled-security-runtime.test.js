import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { verifyBundledSecurityRuntimes } from '../../scripts/ci/smoke-openvscode-sidebar-image.mjs';

for (const sharedPi of [true, false]) {
  it(`REQ-OPS-046 AC3: verifies nested Pi runtime without a hoisted brace package (shared Pi ${sharedPi})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'image-security-layout-'));
    const brace = (path) => {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
      writeFileSync(join(path, 'index.cjs'), "exports.expand = () => ['alpha/1', 'alpha/2', 'beta/1', 'beta/2'];\n");
    };
    try {
      brace(join(root, 'usr/local/lib/node_modules/npm/node_modules/brace-expansion'));
      const bases = ['opt/codeflare/pi-agent/npm/node_modules'];
      if (sharedPi) bases.push('opt/codeflare/npm-tools/node_modules');
      for (const base of bases) {
        const agent = join(root, base, '@earendil-works/pi-coding-agent');
        mkdirSync(agent, { recursive: true });
        writeFileSync(join(agent, 'package.json'), '{}');
        brace(join(agent, 'node_modules/brace-expansion'));
      }
      await verifyBundledSecurityRuntimes({ runtimeRoot: root, undiciPaths: [] });
      // Missing installed nested runtime must fail, not silently skip its check.
      rmSync(join(root, bases[0], '@earendil-works/pi-coding-agent/node_modules/brace-expansion'), { recursive: true });
      await assert.rejects(verifyBundledSecurityRuntimes({ runtimeRoot: root, undiciPaths: [] }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const prewarmRuntime of ['valid', 'missing', 'broken']) {
  it(`REQ-OPS-046 AC3: checks the resolved prewarm security runtime alongside nested shared Pi (${prewarmRuntime})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'image-security-hoisted-'));
    const brace = (path, broken = false) => {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'package.json'), JSON.stringify({
        main: 'index.cjs',
        exports: { '.': './index.cjs', './package.json': './package.json' },
      }));
      writeFileSync(join(path, 'index.cjs'), broken
        ? 'exports.expand = () => [];\n'
        : "exports.expand = () => ['alpha/1', 'alpha/2', 'beta/1', 'beta/2'];\n");
    };
    try {
      brace(join(root, 'usr/local/lib/node_modules/npm/node_modules/brace-expansion'));
      const shared = join(root, 'opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent');
      const prewarm = join(root, 'opt/codeflare/pi-agent/npm/node_modules/@earendil-works/pi-coding-agent');
      for (const agent of [shared, prewarm]) {
        mkdirSync(agent, { recursive: true });
        writeFileSync(join(agent, 'package.json'), '{}');
      }
      brace(join(shared, 'node_modules/brace-expansion'));
      if (prewarmRuntime !== 'missing') {
        brace(join(root, 'opt/codeflare/pi-agent/npm/node_modules/brace-expansion'), prewarmRuntime === 'broken');
      }
      const verifying = verifyBundledSecurityRuntimes({ runtimeRoot: root, undiciPaths: [] });
      if (prewarmRuntime === 'valid') await verifying;
      else await assert.rejects(verifying, prewarmRuntime === 'broken'
        ? /brace expansion runtime/
        : /Cannot find module|ENOENT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
