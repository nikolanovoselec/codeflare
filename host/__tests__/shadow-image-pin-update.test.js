import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const agyCandidate = {
  version: '1.999.0',
  url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.999.0-123456/linux-x64/cli_linux_x64.tar.gz',
  sha512: 'b'.repeat(128),
};
test('REQ-AGENT-001 AC3: Antigravity version, immutable URL and publisher SHA512 advance atomically', () => {
  const before = inputs();
  const current = currentImagePin(before, 'antigravity');
  const next = updateShadowImagePins(before, 'antigravity', current, agyCandidate);
  assert.equal(currentImagePin(next, 'antigravity'), agyCandidate.version);
  // Intentional image artifact contract: these ARGs are the install authorization.
  for (const [name, value] of Object.entries({ VERSION: agyCandidate.version, URL: agyCandidate.url, SHA512: agyCandidate.sha512 })) {
    assert.equal(next.Dockerfile.match(new RegExp(`^ARG ANTIGRAVITY_${name}=(.+)$`, 'm'))?.[1], value);
  }
  assert.equal(next[pinsPath], before[pinsPath]);
  assert.equal(next[k6Path], before[k6Path]);
  assert.deepEqual(before, inputs(), 'updates do not mutate the current artifacts');
  for (const patch of [{ version: current }, { version: '2.0.0' }, { sha512: 'bad' }, { url: 'https://example.com/agy' }]) {
    assert.throws(() => updateShadowImagePins(before, 'antigravity', current, { ...agyCandidate, ...patch }));
  }
  assert.throws(() => updateShadowImagePins(next, 'antigravity', current, agyCandidate), /changed since resolution/);
});

const root = fileURLToPath(new URL('../..', import.meta.url));
function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), 'agy-native-pin-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
for (const kind of ['valid', 'digest-mismatch', 'traversal', 'symlink', 'extra-member', 'omitted']) {
  test(`REQ-AGENT-001 AC3: selected native install fixture (${kind}) verifies before extracting or running`, (t) => {
    const dir = fixture(t);
    const payload = join(dir, 'vendor.tar.gz');
    const generated = spawnSync('python3', ['-c', `
import io, sys, tarfile
with tarfile.open(sys.argv[1], 'w:gz') as archive:
    member = tarfile.TarInfo('../escaped' if sys.argv[2] == 'traversal' else 'antigravity')
    content = b'#!/bin/sh\\nprintf "synthetic agy 1.5.4\\\\n"\\n'
    if sys.argv[2] == 'symlink':
        member.type = tarfile.SYMTYPE
        member.linkname = '/bin/sh'
    else:
        member.size = len(content)
    archive.addfile(member, io.BytesIO(content))
    if sys.argv[2] == 'extra-member':
        archive.addfile(tarfile.TarInfo('unexpected'))
`, payload, kind], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const digest = createHash('sha512').update(readFileSync(payload)).digest('hex');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // The only executable under test is a synthetic shell fixture, never a vendor binary.
    writeFileSync(join(bin, 'curl'), `#!/bin/sh\n[ "$1" = --fail ] || exit 91\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then cp "$FIXTURE_PAYLOAD" "$2"; exit; fi; shift; done\nexit 92\n`, { mode: 0o755 });
    const docker = inputs().Dockerfile;
    const start = docker.indexOf('RUN if node /opt/codeflare/scripts/coding-agent-selection.mjs has "$CODEFLARE_CODING_AGENTS" antigravity; then');
    if (start === -1) throw new Error('Cannot locate the native install command for the execution fixture');
    const selector = join(root, 'scripts/ci/coding-agent-selection.mjs');
    const paths = {
      '/opt/codeflare/scripts/coding-agent-selection.mjs': selector,
      '/tmp/agy.tar.gz': join(dir, 'download.tar.gz'),
      '/tmp/agy': join(dir, 'staging-agy'),
      '/usr/local/bin/agy': join(dir, 'installed-agy'),
      '/tmp/*': join(dir, 'cleanup-only'),
    };
    // One pass: a fixture directory under /tmp/agy-* must not itself be remapped.
    const command = docker.slice(start + 4).split('\n\n')[0].replaceAll('\\\n', '\n')
      .replace(/\/opt\/codeflare\/scripts\/coding-agent-selection\.mjs|\/usr\/local\/bin\/agy|\/tmp\/agy\.tar\.gz|\/tmp\/agy|\/tmp\/\*/g, path => paths[path]);
    const outsideFixture = command.replaceAll(selector, '').replaceAll(dir, '');
    if (/\/(?:tmp\/|usr\/local\/bin\/|opt\/codeflare\/)/.test(outsideFixture)) {
      throw new Error('Refusing to execute a native install fixture with unmapped image paths');
    }
    const result = spawnSync('sh', ['-c', command], { encoding: 'utf8', env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_PAYLOAD: payload,
      CODEFLARE_CODING_AGENTS: kind === 'omitted' ? 'pi' : 'antigravity',
      ANTIGRAVITY_VERSION: '1.5.4', ANTIGRAVITY_URL: agyCandidate.url,
      ANTIGRAVITY_SHA512: kind === 'digest-mismatch' ? '0'.repeat(128) : digest,
    } });
    const success = kind === 'valid' || kind === 'omitted';
    assert.equal(result.status === 0, success, result.stdout + result.stderr);
    assert.equal(existsSync(join(dir, 'installed-agy')), kind === 'valid');
    assert.equal(existsSync(join(dir, 'escaped')), false);
    if (kind === 'valid') assert.match(result.stdout, /synthetic agy 1.5.4/);
  });
}

test('REQ-AGENT-001 AC3: normal helper resolve/apply rejects stale metadata and stale version/digest authorization', (t) => {
  const dir = fixture(t);
  const original = inputs();
  for (const [path, value] of Object.entries(original)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), value);
  }
  const preload = join(dir, 'vendor.mjs');
  writeFileSync(preload, `globalThis.fetch = async () => Response.json(JSON.parse(process.env.VENDOR_CANDIDATE));`);
  const helper = join(root, 'scripts/ci/update-shadow-image-pins.mjs');
  const run = (command, env = {}) => spawnSync(process.execPath, ['--import', preload, helper, 'antigravity', command], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, VENDOR_CANDIDATE: JSON.stringify(agyCandidate), ...env },
  });
  const resolution = run('resolve');
  assert.equal(resolution.status, 0, resolution.stderr);
  const outputs = Object.fromEntries(resolution.stdout.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const env = { CUR: outputs.current, CANDIDATE: outputs.candidate, PREVIOUS: outputs.previous };
  assert.equal(run('apply', { ...env, VENDOR_CANDIDATE: JSON.stringify({ ...agyCandidate, sha512: 'c'.repeat(128) }) }).status, 1);
  const changed = original.Dockerfile.replace(/^ARG ANTIGRAVITY_SHA512=.+$/m, `ARG ANTIGRAVITY_SHA512=${'d'.repeat(128)}`);
  writeFileSync(join(dir, 'Dockerfile'), changed);
  assert.equal(run('apply', env).status, 1, 'same-version checksum mutation invalidates authorization');
  assert.equal(readFileSync(join(dir, 'Dockerfile'), 'utf8'), changed);
  writeFileSync(join(dir, 'Dockerfile'), original.Dockerfile);
  const applied = run('apply', env);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(currentImagePin({ ...original, Dockerfile: readFileSync(join(dir, 'Dockerfile'), 'utf8') }, 'antigravity'), agyCandidate.version);
  assert.equal(run('apply', env).status, 1, 'replaying stale resolution cannot reauthorize an installed pin');
});
