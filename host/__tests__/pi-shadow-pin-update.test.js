import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('REQ-OPS-054 AC6: the real Pi updater preserves aligned direct dependency and override pins', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/bump-shadow-pins.yml', import.meta.url), 'utf8');
  const scripts = [...workflow.matchAll(/node <<'NODE'\n([\s\S]*?)\n\s*NODE/g)]
    .map(match => match[1]).filter(script => script.includes('const { PKG, CUR, LAT } = process.env;'));
  if (scripts.length !== 1) throw Error('Cannot select the declared Pi package updater');
  const root = mkdtempSync(join(tmpdir(), 'pi-shadow-pin-'));
  const name = '@earendil-works/pi-coding-agent';
  const current = '0.99.1';
  const latest = '0.99.2'; // Synthetic candidate; never installed or published.
  try {
    for (const path of ['preseed/agents/pi/package.json', 'preseed/npm-tools/package.json']) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), JSON.stringify({ dependencies: { [name]: current, unrelated: current },
        overrides: { [name]: current, unrelated: current } }));
    }
    mkdirSync(join(root, 'host/__tests__'), { recursive: true });
    writeFileSync(join(root, 'entrypoint.sh'), `npm:${name}@${current}\nnpm:unrelated@${current}\n`);
    writeFileSync(join(root, 'host/__tests__/pi-settings-packages.test.js'), `pkg.dependencies['${name}'], '${current}'\n`);
    const result = spawnSync(process.execPath, ['-e', scripts[0]], { cwd: root, encoding: 'utf8',
      env: { ...process.env, PKG: name, CUR: current, LAT: latest } });
    assert.equal(result.status, 0, result.stderr);
    for (const path of ['preseed/agents/pi/package.json', 'preseed/npm-tools/package.json']) {
      const manifest = JSON.parse(readFileSync(join(root, path), 'utf8'));
      assert.equal(manifest.dependencies[name], latest);
      assert.equal(manifest.overrides[name], latest, 'the candidate lock must not resolve the previous override');
      assert.equal(manifest.dependencies.unrelated, current);
      assert.equal(manifest.overrides.unrelated, current);
    }
    assert.equal(readFileSync(join(root, 'entrypoint.sh'), 'utf8'), `npm:${name}@${latest}\nnpm:unrelated@${current}\n`,
      'generated runtime version-pin contract');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
