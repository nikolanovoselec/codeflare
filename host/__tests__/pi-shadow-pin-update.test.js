import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

for (const name of ['pi-mcp-adapter', 'pi-open-tui']) {
test(`REQ-OPS-054 AC6: the real Pi updater preserves aligned pins and startup filters (${name})`, () => {
  const workflow = readFileSync(new URL('../../.github/workflows/bump-shadow-pins.yml', import.meta.url), 'utf8');
  const scripts = [...workflow.matchAll(/node <<'NODE'\n([\s\S]*?)\n\s*NODE/g)]
    .map(match => match[1]).filter(script => script.includes('const { PKG, CUR, LAT } = process.env;'));
  if (scripts.length !== 1) throw Error('Cannot select the declared Pi package updater');
  const root = mkdtempSync(join(tmpdir(), 'pi-shadow-pin-'));
  const current = '5.3.1';
  const latest = '5.3.2'; // Fixture-only version strings; no installation or publication.
  try {
    for (const path of ['preseed/agents/pi/package.json', 'preseed/npm-tools/package.json']) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), JSON.stringify({ dependencies: { [name]: current, unrelated: current },
        overrides: { [name]: current, unrelated: current } }));
    }
    mkdirSync(join(root, 'host/__tests__'), { recursive: true });
    writeFileSync(join(root, 'entrypoint.sh'), JSON.stringify({ packages: [
      { source: `npm:${name}@${current}`, extensions: [] }, 'npm:unrelated@1.0.0',
    ] }));
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
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'entrypoint.sh'), 'utf8')), { packages: [
      { source: `npm:${name}@${latest}`, extensions: [] }, 'npm:unrelated@1.0.0',
    ] }, 'candidate startup pin changes without removing the adapter-owned extension filter');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
}

test('REQ-OPS-054 AC6: workflow discovery includes Open TUI and excludes retired Usage and dedicated atomic owners', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/bump-shadow-pins.yml', import.meta.url), 'utf8');
  const discovery = workflow.match(/PACKAGES=\$\(node -e '([^']+)'\)/)?.[1];
  if (!discovery) throw Error('Cannot extract the real manifest-based discovery program');
  const result = spawnSync(process.execPath, ['-e', discovery], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const names = JSON.parse(result.stdout);
  assert.ok(names.includes('pi-open-tui'));
  for (const name of ['@narumitw/pi-usage', 'context-mode', '@earendil-works/pi-coding-agent']) {
    assert.ok(!names.includes(name), `${name} must not get an extension bump leg`);
  }
});
