import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SECURITY_PIN_OWNERS, currentSecurityVersion, updateNpmSecurityPins } from '../../scripts/ci/update-npm-security-pins.mjs';

const floor = 'scripts/apply-npm-security-lock-pins.mjs';
const paths = ['Dockerfile', floor, 'package.json', 'preseed/agents/pi/package.json', 'preseed/npm-tools/package.json',
  'preseed/agents/claude/browser-run-mcp/package.json', '.github/npm-tools/wrangler/package.json'];
const files = () => Object.fromEntries(paths.map(path => [path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')]));
function candidate(name, version) {
  return { name, version, license: 'MIT', engines: { node: '>=22.19.0' },
    dist: { tarball: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`, integrity: `sha512-${Buffer.alloc(64, 5).toString('base64')}` } };
}

test('REQ-OPS-020: atomic Undici 7 overlay/floor/override candidate preserves separate major and unrelated packages', () => {
  const before = files();
  const current = currentSecurityVersion(before, 'undici-7');
  const version = `7.${Number(current.split('.')[1]) + 1}.0`;
  const next = updateNpmSecurityPins(before, 'undici-7', current, candidate('undici', version));
  assert.equal(currentSecurityVersion(next, 'undici-7'), version);
  assert.match(next.Dockerfile, new RegExp(`UNDICI_IDE_SHA512="${'05'.repeat(64)}"`), 'artifact digest follows the same candidate');
  assert.equal(JSON.parse(next['.github/npm-tools/wrangler/package.json']).overrides.undici, version);
  assert.equal(JSON.parse(next['preseed/agents/pi/package.json']).overrides.undici,
    JSON.parse(before['preseed/agents/pi/package.json']).overrides.undici, 'Undici 8 cannot become Undici 7');
  assert.equal(JSON.parse(next['preseed/agents/pi/package.json']).dependencies['pi-smart-compact'],
    JSON.parse(before['preseed/agents/pi/package.json']).dependencies['pi-smart-compact']);
  assert.match(next[floor], new RegExp(`https://registry.npmjs.org/undici/-/undici-${version.replaceAll('.', '\\.')}\\.tgz`));
  // A second forward candidate must still parse the rewritten floor identity.
  const next8 = updateNpmSecurityPins(next, 'undici-8', currentSecurityVersion(next, 'undici-8'), candidate('undici', '8.999.0'));
  assert.equal(currentSecurityVersion(next8, 'undici-8'), '8.999.0');
});

test('REQ-OPS-020: security override and floor bumps are forward-only, same-major, and fail closed on registry identity', () => {
  const before = files();
  const current = currentSecurityVersion(before, 'ip-address');
  const next = updateNpmSecurityPins(before, 'ip-address', current, candidate('ip-address', '10.999.0'));
  assert.equal(currentSecurityVersion(next, 'ip-address'), '10.999.0');
  assert.equal(JSON.parse(next['preseed/npm-tools/package.json']).overrides['ip-address'], '10.999.0');
  for (const bad of [candidate('ip-address', current), candidate('ip-address', '10.0.0'), candidate('ip-address', '11.0.0'),
    candidate('unrelated', '10.999.0'), { ...candidate('ip-address', '10.999.0'), dist: { tarball: 'https://attacker.invalid/package.tgz', integrity: 'sha512-invalid' } }]) {
    assert.throws(() => updateNpmSecurityPins(before, 'ip-address', current, bad));
  }
  assert.deepEqual(before, files(), 'rejected candidates never write repository inputs');
});


for (const [id, owner] of Object.entries(SECURITY_PIN_OWNERS)) {
  test(`REQ-OPS-020: ${id} has one observable forward update path`, () => {
    const before = files();
    const current = currentSecurityVersion(before, id);
    const [major, minor] = current.split('.').map(Number);
    const version = `${major}.${minor + 1}.0`;
    const next = updateNpmSecurityPins(before, id, current, candidate(owner.package ?? id, version));
    assert.equal(currentSecurityVersion(next, id), version);
    if (owner.overlay) {
      assert.match(next.Dockerfile, new RegExp(`${owner.overlay}_SHA512="${'05'.repeat(64)}"`));
    } else {
      assert.equal(next.Dockerfile, before.Dockerfile);
    }
    for (const path of paths.filter(path => path.endsWith('/package.json') || path === 'package.json')) {
      const previous = JSON.parse(before[path]);
      const updated = JSON.parse(next[path]);
      assert.deepEqual(updated.dependencies, previous.dependencies, 'direct dependencies retain their existing Dependabot owner');
    }
  });
}
