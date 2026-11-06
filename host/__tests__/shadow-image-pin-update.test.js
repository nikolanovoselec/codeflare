import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { currentImagePin, updateShadowImagePins } from '../../scripts/ci/update-shadow-image-pins.mjs';

const pinsPath = '.github/workflow-tool-pins.json';
const k6Path = '.github/actions/install-k6/action.yml';
function inputs() {
  return Object.fromEntries(['Dockerfile', pinsPath, k6Path]
    .map(path => [path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')]));
}
const digest = 'a'.repeat(64);

test('REQ-OPS-020 AC4: rclone source checksum invalidates while matching CI archive remains authenticated', () => {
  const before = inputs();
  const current = currentImagePin(before, 'rclone');
  const next = updateShadowImagePins(before, 'rclone', current, { version: '1.999.0', ciSha256: digest });
  assert.equal(currentImagePin(next, 'rclone'), '1.999.0');
  assert.deepEqual(JSON.parse(next[pinsPath]).rclone, { version: '1.999.0', sha256: digest });
  assert.match(next.Dockerfile, /NEEDS_UPDATE_SEE_PR_BODY  \/tmp\/rclone.tar.gz/, 'unpublished source digest cannot reuse previous trust');
  assert.match(next.Dockerfile, /patch-rclone-bisync.py \/src\/rclone 1\.999\.0/);
  assert.match(next.Dockerfile, /prepare-rclone-s3-fixture\.py prepare \/src\/rclone 1\.999\.0/);
  assert.match(next.Dockerfile, /prepare-rclone-s3-fixture\.py restore \/src\/rclone 1\.999\.0/);
  assert.match(next.Dockerfile, /fs.Version=v1\.999\.0-codeflare-bisync1/);
  assert.equal(next[k6Path], before[k6Path]);
  assert.throws(() => updateShadowImagePins(before, 'rclone', current, { version: '1.999.0' }), /checksum/);
});

test('REQ-OPS-020: release version/digest/date pairs change atomically without touching another owner', () => {
  const before = inputs();
  for (const [id, version] of [['go', '1.999.0'], ['rust', '1.999.0'], ['github-cli', '2.999.0'], ['k6', '0.999.0']]) {
    const current = currentImagePin(before, id);
    const next = updateShadowImagePins(before, id, current, { version, sha256: digest, date: '2026-10-01' });
    assert.equal(currentImagePin(next, id), version);
    assert.equal(next[pinsPath], before[pinsPath]);
    assert.ok((id === 'k6' ? next[k6Path] : next.Dockerfile).includes(digest), `${id} carries authoritative candidate checksum`);
    assert.throws(() => updateShadowImagePins(before, id, current, { version, sha256: 'old-checksum' }), /SHA256/);
  }
  for (const [id, version] of [['grpc', '1.999.0'], ['compress', '1.999.0']]) {
    const next = updateShadowImagePins(before, id, currentImagePin(before, id), { version });
    assert.equal(currentImagePin(next, id), version);
    assert.equal(next[pinsPath], before[pinsPath]);
    assert.equal(next[k6Path], before[k6Path]);
  }
});

test('REQ-OPS-020: CI-only pins update data rather than executable workflows; Node remains patch-only', () => {
  const before = inputs();
  for (const id of ['ci-node-26', 'ci-node-22', 'trivy']) {
    const current = currentImagePin(before, id);
    const [major, minor, patch] = current.split('.').map(Number);
    const version = `${major}.${minor}.${patch + 1}`;
    const next = updateShadowImagePins(before, id, current, { version });
    assert.equal(currentImagePin(next, id), version);
    assert.equal(next.Dockerfile, before.Dockerfile);
    assert.equal(next[k6Path], before[k6Path]);
    const previousPins = JSON.parse(before[pinsPath]);
    assert.deepEqual(JSON.parse(next[pinsPath]), { ...previousPins, [id]: { version } });
    if (id.startsWith('ci-node-')) {
      assert.throws(() => updateShadowImagePins(before, id, current, { version: `${major}.${minor + 1}.0` }), /patch-only/);
    }
    assert.throws(() => updateShadowImagePins(before, id, current, { version: current }), /advance/);
    assert.throws(() => updateShadowImagePins(before, id, current, { version: `${major + 1}.0.0` }), /pinned major/);
  }
});

for (const [id, canonical, nearMatch] of [
  ['grpc', 'google.golang.org/grpc', 'googleXgolangYorg/grpc'],
  ['compress', 'github.com/klauspost/compress', 'githubXcom/klauspost/compress'],
  ['rust', 'https://static.rust-lang.org/dist/', 'https://staticXrust-langYorg/dist/'],
]) {
  test(`REQ-OPS-020: rejects near-match ${id} owner without changing input artifacts`, () => {
    const original = inputs();
    const malformed = { ...original, Dockerfile: original.Dockerfile.replaceAll(canonical, nearMatch) };
    const unchanged = { ...malformed };
    assert.throws(() => currentImagePin(malformed, id), /missing or ambiguous/);
    assert.throws(() => updateShadowImagePins(malformed, id, currentImagePin(original, id), {
      version: '1.999.0', sha256: digest, date: '2026-10-01',
    }), /missing or ambiguous/);
    assert.deepEqual(malformed, unchanged, 'foreign owner rejection cannot rewrite any artifact');
  });
}
