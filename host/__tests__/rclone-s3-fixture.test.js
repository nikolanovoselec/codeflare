import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const helper = join(root, 'scripts/prepare-rclone-s3-fixture.py');
const patch = join(root, 'scripts/patch-rclone-bisync.py');
const sources = ['VERSION', 'backend/s3/s3.go', 'cmd/bisync/listing.go', 'cmd/bisync/queue.go',
  'fs/operations/copy.go', 'fs/operations/logger.go', 'fs/operations/multithread.go'];
const digest = (data) => createHash('sha256').update(data).digest('hex');
const run = (script, args) => spawnSync('python3', [script, ...args], { encoding: 'utf8', timeout: 10000 });
const fixture = (action, directory, version, backup) => run(helper, [action, directory, version, backup]);
const success = (result) => assert.equal(result.status, 0, result.stderr);

// Opt-in inert release data, never an SDK checkout or executable. Downloaded outside
// the repository; no network, Go, SDK execution or build occurs in these tests.
const artifacts = process.env.CODEFLARE_RCLONE_ARTIFACT_DIR;
const artifactOptions = { skip: !artifacts && 'Set CODEFLARE_RCLONE_ARTIFACT_DIR to reviewed release archives' };
function extract(directory, version) {
  const archive = join(artifacts, `release-${version}.tar.gz`);
  const sha = {
    '1.73.5': 'e52541bc238dd434a0335f467697d7d9575529698a74aab534ad39b8649f8a49',
    '1.75.2': '68afd7f68c84bd978966feae2116339aa7bf454b39c573910c462e87c3774d5a',
    '1.76.0': '8cb7e5d576fe9a3aef8b1a0785e2ffc6c1953f8ed109f42000b0b86718f6628b',
  }[version];
  assert.equal(digest(readFileSync(archive)), sha, 'release artifact identity contract');
  const paths = [...sources, version === '1.73.5' ? 'cmd/serve/s3/pager.go' : 'cmd/serve/s3/list.go'];
  const result = spawnSync('python3', ['-c', `
import pathlib, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for relative in sys.argv[4:]:
        member = archive.getmember('rclone-' + sys.argv[3] + '/' + relative)
        assert member.isfile()
        target = pathlib.Path(sys.argv[2]) / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(archive.extractfile(member).read())
`, archive, directory, version, ...paths], { encoding: 'utf8', timeout: 10000 });
  success(result);
}

function temporary(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'rclone-fixture-contract-'));
  try { callback(directory, join(directory, 'pager.backup')); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('rclone S3 fixture source identity and preparation', () => {
  it('rejects unknown or mismatched versions without creating a backup', () => temporary((directory, backup) => {
    writeFileSync(join(directory, 'VERSION'), 'v1.73.5\n');
    for (const version of ['99.0.0', '1.75.2', '1.76.0']) {
      assert.notEqual(fixture('prepare', directory, version, backup).status, 0);
      assert.equal(existsSync(backup), false);
      assert.equal(readFileSync(join(directory, 'VERSION'), 'utf8'), 'v1.73.5\n');
    }
  }));

  for (const version of ['1.73.5', '1.75.2', '1.76.0']) {
    it(`rejects unreviewed ${version} fixture bytes before any write`, () => temporary((directory, backup) => {
      writeFileSync(join(directory, 'VERSION'), `v${version}\n`);
      const path = join(directory, 'cmd/serve/s3', version === '1.73.5' ? 'pager.go' : 'list.go');
      mkdirSync(join(directory, 'cmd/serve/s3'), { recursive: true });
      const data = version === '1.73.5'
        ? 'list.Contents[i].LastModified.Before(list.Contents[j].LastModified.Time)'
        : 'return strings.Compare(sortKey(a), sortKey(b))';
      writeFileSync(path, data);
      const result = fixture('prepare', directory, version, backup);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /source digest/);
      assert.equal(readFileSync(path, 'utf8'), data);
      assert.equal(existsSync(backup), false);
    }));

    it(`prepares and restores original ${version} release fixture`, artifactOptions, () => temporary((directory, backup) => {
      extract(directory, version);
      const path = join(directory, 'cmd/serve/s3', version === '1.73.5' ? 'pager.go' : 'list.go');
      const original = readFileSync(path);
      success(fixture('prepare', directory, version, backup));
      if (version === '1.73.5') {
        // Intentional fixture artifact contract: change only LastModified order to key order.
        assert.equal(readFileSync(path, 'utf8'), original.toString().replace(
          'list.Contents[i].LastModified.Before(list.Contents[j].LastModified.Time)',
          'list.Contents[i].Key < list.Contents[j].Key'));
        assert.deepEqual(readFileSync(backup), original);
        assert.notEqual(fixture('prepare', directory, version, backup).status, 0);
      } else {
        assert.deepEqual(readFileSync(path), original, 'already key-ordered release must remain byte-identical');
        assert.equal(existsSync(backup), false);
      }
      success(fixture('restore', directory, version, backup));
      assert.deepEqual(readFileSync(path), original);
      assert.equal(existsSync(backup), false);
    }));

    it(`qualifies all sequential bookkeeping transforms against original ${version}`, artifactOptions, () => temporary((directory) => {
      extract(directory, version);
      const before = new Map(sources.map((path) => [path, readFileSync(join(directory, path), 'utf8')]));
      success(run(patch, [directory, version]));
      assert.deepEqual(sources.filter((path) => readFileSync(join(directory, path), 'utf8') !== before.get(path)), sources.slice(1),
        'reviewed generated artifact changed-path contract');
      if (version !== '1.73.5') {
        const original = before.get('backend/s3/s3.go');
        const generated = readFileSync(join(directory, 'backend/s3/s3.go'), 'utf8');
        // Intentional new Copy artifact contract: completion selection must not truncate
        // upstream NoHeadObject metadata, Object Lock side effects/errors or final return.
        const oldBlock = '\tdstObj, err := f.NewObject(ctx, remote)\n\tif err != nil {\n\t\treturn nil, err\n\t}';
        const start = original.indexOf(oldBlock);
        assert.notEqual(start, -1);
        const end = original.indexOf('\n}\n', start) + 3;
        const preserved = original.slice(start + oldBlock.length, end);
        const generatedStart = generated.indexOf('\tvar dstObj fs.Object\n');
        assert.notEqual(generatedStart, -1);
        const generatedEnd = generated.indexOf('\n}\n', generatedStart) + 3;
        assert.ok(generated.slice(generatedStart, generatedEnd).endsWith(preserved),
          'completed destination must flow through unchanged upstream Copy tail');
      }
    }));

    it(`rejects anchor-preserving changes to ${version} without partial writes`, artifactOptions, () => temporary((directory) => {
      extract(directory, version);
      const changed = join(directory, 'backend/s3/s3.go');
      writeFileSync(changed, readFileSync(changed, 'utf8') + '\n// unreviewed bytes\n');
      const before = sources.map((path) => digest(readFileSync(join(directory, path))));
      const result = run(patch, [directory, version]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /source digest.*no files patched/);
      assert.deepEqual(sources.map((path) => digest(readFileSync(join(directory, path)))), before);
    }));

    it(`rejects a late incompatible ${version} anchor without partial writes`, artifactOptions, () => temporary((directory) => {
      extract(directory, version);
      const last = join(directory, 'fs/operations/multithread.go');
      writeFileSync(last, 'unreviewed source\n');
      const before = sources.map((path) => digest(readFileSync(join(directory, path))));
      const result = run(patch, [directory, version]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /no files patched/);
      assert.deepEqual(sources.map((path) => digest(readFileSync(join(directory, path)))), before);
    }));
  }

  it('refuses to restore a changed old fixture or consume its recovery backup', artifactOptions, () => temporary((directory, backup) => {
    extract(directory, '1.73.5');
    success(fixture('prepare', directory, '1.73.5', backup));
    const path = join(directory, 'cmd/serve/s3/pager.go');
    writeFileSync(path, 'changed after preparation\n');
    const saved = readFileSync(backup);
    assert.notEqual(fixture('restore', directory, '1.73.5', backup).status, 0);
    assert.equal(readFileSync(path, 'utf8'), 'changed after preparation\n');
    assert.deepEqual(readFileSync(backup), saved);
  }));
});
