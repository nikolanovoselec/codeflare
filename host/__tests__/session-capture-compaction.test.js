import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  buildSessionArchive,
  deleteVerifiedSources,
  parseSessionArchive,
  prepareArchive,
  selectColdCaptures,
  verifyRemoteArchive,
} from '../../scripts/compact-session-captures.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(repoRoot, 'scripts', 'compact-session-captures.mjs');
const TODAY = '2026-03-31';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'session-capture-compact-'));
  const sessionsDir = join(root, 'Raw', 'Sessions');
  const manifestPath = join(root, 'capture-compaction.json');
  mkdirSync(sessionsDir, { recursive: true });
  return { root, sessionsDir, manifestPath };
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 5_000 });
}

function prepare(fx, today = TODAY) {
  return run(['prepare', fx.sessionsDir, fx.manifestPath, '--today', today]);
}

describe('session capture compaction', () => {
  it('installs the image-owned compactor without changing entrypoint orchestration', () => {
    const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');
    assert.match(
      dockerfile,
      /COPY --chmod=0755 scripts\/compact-session-captures\.mjs \/opt\/codeflare\/scripts\/compact-session-captures\.mjs/,
    );
  });

  it('REQ-MEM-023 AC1: accepts only actual capture timestamp shapes and compares their calendar days', () => {
    const fx = fixture();
    const cold = [
      '2026-02-24T20-21-22.123Z-millisecond.md',
      '2026-02-25T20-21-22Z-zulu.md',
      '2026-02-26T20-21-22-naive.md',
      '2026-02-27T23-59-59-1200-offset.md',
    ];
    for (const name of cold) writeFileSync(join(fx.sessionsDir, name), name);
    writeFileSync(join(fx.sessionsDir, '2026-02-28T00-00-00+0000-boundary.md'), 'hot boundary');
    writeFileSync(join(fx.sessionsDir, '2026-03-30T00-00-00+0000-recent.md'), 'hot');
    for (const name of [
      '2026-02-01-not-a-capture.md',
      '2026-02-30T00-00-00Z-bad-date.md',
      '2026-02-01T24-00-00Z-bad-hour.md',
      '2026-02-01T00-60-00Z-bad-minute.md',
      '2026-02-01T00-00-00.12Z-bad-milliseconds.md',
      '2026-02-01T00-00-00.123-no-zone.md',
      '2026-02-01T00-00-00+1401-bad-offset.md',
      '2026-02-01T00:00:00Z-colon-time.md',
      'README.md',
    ]) writeFileSync(join(fx.sessionsDir, name), 'unrecognized markdown');
    writeFileSync(join(fx.sessionsDir, '2026-02-01.txt'), 'not markdown');
    mkdirSync(join(fx.sessionsDir, 'nested'));
    writeFileSync(join(fx.sessionsDir, 'nested', '2026-01-01T00-00-00+0000-nested.md'), 'nested');
    symlinkSync(
      join(fx.sessionsDir, cold[0]),
      join(fx.sessionsDir, '2026-01-01T00-00-00+0000-link.md'),
    );

    const selected = selectColdCaptures(fx.sessionsDir, '2026-02-28');
    assert.deepEqual(selected.map(({ filename }) => filename), cold);
  });

  it('REQ-MEM-023 AC2: builds a deterministic idempotent archive with recoverable source boundaries', () => {
    const names = [
      '2026-01-03T00-00-00+0000-charlie.md',
      '2026-01-01T01-00-00+0000-beta.md',
      '2026-01-01T00-00-00+0000-alpha.md',
    ];
    const bodies = new Map([
      [names[0], Buffer.from('charlie without final newline')],
      [names[1], Buffer.from([0x23, 0x20, 0x42, 0x0a, 0x00, 0xff])],
      [names[2], Buffer.from('alpha\n')],
    ]);
    const left = fixture();
    const right = fixture();
    for (const name of names) writeFileSync(join(left.sessionsDir, name), bodies.get(name));
    for (const name of names.toReversed()) writeFileSync(join(right.sessionsDir, name), bodies.get(name));

    const leftPrepare = prepare(left);
    const rightPrepare = prepare(right);
    assert.equal(leftPrepare.status, 0, leftPrepare.stderr);
    assert.equal(rightPrepare.status, 0, rightPrepare.stderr);
    const prepareOutcome = JSON.parse(leftPrepare.stdout);
    assert.equal(prepareOutcome.phase, 'prepare');
    assert.equal(prepareOutcome.phase_state, 'archive-prepared-sources-present');
    assert.equal(prepareOutcome.status, 'prepared');
    assert.equal(prepareOutcome.deletion_sync_completed, false);
    assert.equal(prepareOutcome.next_phase, 'verify-remote-archive');
    assert.equal(prepareOutcome.source_count, names.length);
    const leftArchive = readFileSync(join(left.sessionsDir, 'Archive.md'));
    assert.deepEqual(leftArchive, readFileSync(join(right.sessionsDir, 'Archive.md')));
    const normalizedManifest = (fx) => readFileSync(fx.manifestPath, 'utf8').replaceAll(fx.root, '<root>');
    assert.equal(normalizedManifest(left), normalizedManifest(right));

    const captures = parseSessionArchive(leftArchive);
    assert.deepEqual(captures.map(({ filename }) => filename), names.toSorted());
    for (const capture of captures) {
      assert.deepEqual(capture.content, bodies.get(capture.filename));
      assert.equal(capture.bytes, bodies.get(capture.filename).length);
      assert.match(capture.sha256, /^[0-9a-f]{64}$/);
    }
    assert.deepEqual(buildSessionArchive(captures), leftArchive);
    for (const name of names) {
      assert.notEqual(leftArchive.indexOf(Buffer.from(`## ${name}\n\n`)), -1, 'archive has a searchable filename heading');
      assert.notEqual(
        leftArchive.indexOf(Buffer.from(`<!-- capture-begin:archive:${name} -->\n`)),
        -1,
        'archive has a deterministic capture-begin marker',
      );
      assert.notEqual(
        leftArchive.indexOf(Buffer.from(`\n<!-- capture-end:archive:${name} -->\n\n`)),
        -1,
        'archive has a deterministic capture-end marker',
      );
    }
    const manifest = JSON.parse(readFileSync(left.manifestPath, 'utf8'));
    for (const source of manifest.sources) {
      assert.equal(source.bytes, bodies.get(source.filename).length);
      assert.equal(source.sha256, createHash('sha256').update(bodies.get(source.filename)).digest('hex'));
      assert.equal(source.source_location, `archive:${source.filename}`);
      assert.equal(source.archive_marker, `<!-- capture-begin:${source.source_location} -->`);
    }

    const firstManifest = readFileSync(left.manifestPath);
    const resumed = prepare(left);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(readFileSync(join(left.sessionsDir, 'Archive.md')), leftArchive);
    assert.deepEqual(readFileSync(left.manifestPath), firstManifest);
    for (const name of names) assert.equal(existsSync(join(left.sessionsDir, name)), true, 'prepare retains sources');
  });

  it('fails closed on malformed, duplicate, and source-conflicting existing archives', () => {
    const malformed = fixture();
    const malformedBytes = Buffer.from('# user-authored archive\n');
    writeFileSync(join(malformed.sessionsDir, 'Archive.md'), malformedBytes);
    writeFileSync(join(malformed.sessionsDir, '2026-01-01T00-00-00+0000-source.md'), 'source');
    const malformedResult = prepare(malformed);
    assert.notEqual(malformedResult.status, 0);
    assert.match(malformedResult.stderr, /malformed archive/i);
    assert.deepEqual(readFileSync(join(malformed.sessionsDir, 'Archive.md')), malformedBytes);
    assert.equal(existsSync(malformed.manifestPath), false);

    const duplicate = fixture();
    const duplicateSource = join(duplicate.sessionsDir, '2026-01-01T00-00-00+0000-source.md');
    writeFileSync(duplicateSource, 'source');
    assert.equal(prepare(duplicate).status, 0);
    const duplicateArchivePath = join(duplicate.sessionsDir, 'Archive.md');
    const archive = readFileSync(duplicateArchivePath);
    const entryOffset = archive.indexOf(Buffer.from('## 2026-'));
    assert.notEqual(entryOffset, -1);
    writeFileSync(duplicateArchivePath, Buffer.concat([archive, archive.subarray(entryOffset)]));
    const duplicateResult = prepare(duplicate);
    assert.notEqual(duplicateResult.status, 0);
    assert.match(duplicateResult.stderr, /duplicate archive entry/i);
    assert.equal(existsSync(duplicateSource), true);

    const conflict = fixture();
    const conflictSource = join(conflict.sessionsDir, '2026-01-01T00-00-00+0000-source.md');
    writeFileSync(conflictSource, 'first bytes');
    assert.equal(prepare(conflict).status, 0);
    const originalArchive = readFileSync(join(conflict.sessionsDir, 'Archive.md'));
    writeFileSync(conflictSource, 'changed bytes');
    const conflictResult = prepare(conflict);
    assert.notEqual(conflictResult.status, 0);
    assert.match(conflictResult.stderr, /conflicts with archived entry/i);
    assert.deepEqual(readFileSync(join(conflict.sessionsDir, 'Archive.md')), originalArchive);
    assert.equal(readFileSync(conflictSource, 'utf8'), 'changed bytes');
  });

  it('prepare re-reads every selected source and the previous archive before replacing output', () => {
    const changedSource = fixture();
    const first = join(changedSource.sessionsDir, '2026-01-01T00-00-00+0000-first.md');
    const second = join(changedSource.sessionsDir, '2026-01-02T00-00-00+0000-second.md');
    writeFileSync(first, 'first');
    writeFileSync(second, 'second');
    assert.throws(() => prepareArchive({
      sessionsDir: changedSource.sessionsDir,
      manifestPath: changedSource.manifestPath,
      today: TODAY,
      beforeRevalidate: () => writeFileSync(second, 'changed during prepare'),
    }), /source changed during prepare/i);
    assert.equal(existsSync(join(changedSource.sessionsDir, 'Archive.md')), false);
    assert.equal(existsSync(changedSource.manifestPath), false);

    const changedArchive = fixture();
    const originalSource = join(changedArchive.sessionsDir, '2026-01-01T00-00-00+0000-first.md');
    writeFileSync(originalSource, 'first');
    assert.equal(prepare(changedArchive).status, 0);
    const archivePath = join(changedArchive.sessionsDir, 'Archive.md');
    const oldManifest = readFileSync(changedArchive.manifestPath);
    writeFileSync(join(changedArchive.sessionsDir, '2026-01-02T00-00-00+0000-second.md'), 'second');
    const concurrentlyChangedArchive = buildSessionArchive([]);
    assert.throws(() => prepareArchive({
      sessionsDir: changedArchive.sessionsDir,
      manifestPath: changedArchive.manifestPath,
      today: TODAY,
      beforeRevalidate: () => writeFileSync(archivePath, concurrentlyChangedArchive),
    }), /archive changed during prepare/i);
    assert.deepEqual(readFileSync(archivePath), concurrentlyChangedArchive);
    assert.deepEqual(readFileSync(changedArchive.manifestPath), oldManifest);
  });

  it('REQ-STOR-052 AC2: remote digest or conflict uncertainty blocks every source deletion', () => {
    const fx = fixture();
    const source = join(fx.sessionsDir, '2026-01-01T00-00-00+0000-source.md');
    writeFileSync(source, 'durable source');
    assert.equal(prepare(fx).status, 0);
    const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'));

    const verified = verifyRemoteArchive({
      manifestPath: fx.manifestPath,
      sessionsDir: fx.sessionsDir,
      remoteSha256: manifest.archive.sha256,
      remoteBytes: manifest.archive.bytes,
      remoteConflictCount: 0,
    });
    assert.deepEqual(verified, {
      phase: 'verify',
      phase_state: 'remote-archive-verified-sources-present',
      verified: true,
      mode: 'digest',
      sha256: manifest.archive.sha256,
      bytes: manifest.archive.bytes,
      deletion_sync_completed: false,
      next_phase: 'relocate-provenance-then-delete-sources',
    });
    const shellVerify = run([
      'verify', fx.manifestPath,
      '--sessions', fx.sessionsDir,
      '--remote-conflicts', '0',
      '--sha256', manifest.archive.sha256,
      '--bytes', String(manifest.archive.bytes),
    ]);
    assert.equal(shellVerify.status, 0, shellVerify.stderr);
    assert.equal(JSON.parse(shellVerify.stdout).mode, 'digest');

    for (const override of [
      { remoteSha256: '0'.repeat(64), remoteBytes: manifest.archive.bytes, remoteConflictCount: 0 },
      { remoteSha256: manifest.archive.sha256, remoteBytes: manifest.archive.bytes + 1, remoteConflictCount: 0 },
      { remoteSha256: manifest.archive.sha256, remoteBytes: manifest.archive.bytes, remoteConflictCount: 1 },
      { remoteSha256: manifest.archive.sha256, remoteBytes: manifest.archive.bytes },
    ]) {
      assert.throws(
        () => verifyRemoteArchive({ manifestPath: fx.manifestPath, sessionsDir: fx.sessionsDir, ...override }),
      );
      assert.equal(existsSync(source), true);
    }

    for (const conflictName of [
      'Archive.md.conflict-copy',
      'Archive.conflict-copy.md',
      'Archive (conflicted copy 2026-03-31).md',
      'Archive.md.conflicted-copy',
    ]) {
      const conflictPath = join(fx.sessionsDir, conflictName);
      writeFileSync(conflictPath, 'conflict');
      assert.throws(() => verifyRemoteArchive({
        manifestPath: fx.manifestPath,
        sessionsDir: fx.sessionsDir,
        remoteSha256: manifest.archive.sha256,
        remoteBytes: manifest.archive.bytes,
        remoteConflictCount: 0,
      }), /local archive conflict/i, conflictName);
      assert.equal(existsSync(source), true);
      unlinkSync(conflictPath);
    }
  });

  it('verifies exact downloaded remote bytes through the phase CLI', () => {
    const fx = fixture();
    writeFileSync(join(fx.sessionsDir, '2026-01-01T00-00-00+0000-source.md'), 'source');
    assert.equal(prepare(fx).status, 0);
    const remoteArchive = join(fx.root, 'remote-Archive.md');
    writeFileSync(remoteArchive, readFileSync(join(fx.sessionsDir, 'Archive.md')));

    const result = run([
      'verify', fx.manifestPath,
      '--sessions', fx.sessionsDir,
      '--remote-conflicts', '0',
      '--archive', remoteArchive,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      bytes: JSON.parse(readFileSync(fx.manifestPath, 'utf8')).archive.bytes,
      deletion_sync_completed: false,
      mode: 'archive',
      next_phase: 'relocate-provenance-then-delete-sources',
      phase: 'verify',
      phase_state: 'remote-archive-verified-sources-present',
      sha256: JSON.parse(readFileSync(fx.manifestPath, 'utf8')).archive.sha256,
      verified: true,
    });
  });

  it('REQ-STOR-052 AC3: deletes only exact unchanged archived sources', () => {
    for (const mutation of ['manifest', 'archive', 'source', 'candidate', 'symlink']) {
      const fx = fixture();
      const first = join(fx.sessionsDir, '2026-01-01T00-00-00+0000-first.md');
      const second = join(fx.sessionsDir, '2026-01-02T00-00-00+0000-second.md');
      writeFileSync(first, 'first');
      writeFileSync(second, 'second');
      assert.equal(prepare(fx).status, 0);

      if (mutation === 'manifest') {
        const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'));
        manifest.untrusted = true;
        writeFileSync(fx.manifestPath, JSON.stringify(manifest));
      } else if (mutation === 'archive') {
        writeFileSync(join(fx.sessionsDir, 'Archive.md'), Buffer.concat([
          readFileSync(join(fx.sessionsDir, 'Archive.md')), Buffer.from('tamper'),
        ]));
      } else if (mutation === 'source') {
        writeFileSync(second, 'changed');
      } else if (mutation === 'candidate') {
        writeFileSync(join(fx.sessionsDir, '2026-01-03T00-00-00+0000-late.md'), 'late arrival');
      } else {
        const moved = `${second}.moved`;
        writeFileSync(moved, readFileSync(second));
        // Replacing a source with a symlink removes it from the direct regular candidate set.
        unlinkSync(second);
        symlinkSync(moved, second);
      }

      assert.throws(() => deleteVerifiedSources({ sessionsDir: fx.sessionsDir, manifestPath: fx.manifestPath }));
      assert.equal(existsSync(first), true, `${mutation}: first source must survive`);
      assert.equal(existsSync(second), true, `${mutation}: second path must survive`);
    }

    const exact = fixture();
    const old = join(exact.sessionsDir, '2026-01-01T00-00-00+0000-old.md');
    const hot = join(exact.sessionsDir, '2026-03-30T00-00-00+0000-hot.md');
    writeFileSync(old, 'old');
    writeFileSync(hot, 'hot');
    writeFileSync(join(exact.sessionsDir, 'README.md'), 'noncapture');
    assert.equal(prepare(exact).status, 0);
    const deleted = deleteVerifiedSources({ sessionsDir: exact.sessionsDir, manifestPath: exact.manifestPath });
    assert.deepEqual(deleted, {
      phase: 'delete',
      phase_state: 'sources-deleted-locally',
      deleted: ['2026-01-01T00-00-00+0000-old.md'],
      deleted_count: 1,
      deletion_sync_completed: false,
      second_sync_required: true,
    });
    assert.equal(existsSync(old), false);

    const archiveOnlyPrepare = prepare(exact);
    assert.equal(archiveOnlyPrepare.status, 0, archiveOnlyPrepare.stderr);
    assert.deepEqual(JSON.parse(archiveOnlyPrepare.stdout), {
      cutoff_date: '2026-02-28',
      deletion_sync_completed: false,
      next_phase: null,
      phase: 'prepare',
      phase_state: 'no-cold-sources',
      source_count: 0,
      status: 'noop',
    });
    assert.equal(readFileSync(hot, 'utf8'), 'hot');
    assert.equal(readFileSync(join(exact.sessionsDir, 'README.md'), 'utf8'), 'noncapture');
  });
});
