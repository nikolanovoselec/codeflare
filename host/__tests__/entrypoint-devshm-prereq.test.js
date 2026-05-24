// REQ-AGENT-023 prerequisite: /dev/shm must be present + tmpfs-mounted
// after entrypoint.sh's boot-time prereq block, because Python's
// multiprocessing.Lock (used by graphify's AST extractor, memory-capture
// chunker, and vault-extract writer) needs POSIX shared memory to
// allocate semaphores. Without it, `concurrent.futures.ProcessPoolExecutor`
// fails at startup with `[Errno 2] No such file or directory` from
// `multiprocessing/synchronize.py:57` (SemLock.__init__ -> sem_open).
//
// This test extracts the /dev/shm prereq block from entrypoint.sh, runs
// it through a real bash interpreter against the actual filesystem,
// and proves Python multiprocessing works afterwards. If a future
// refactor removes the mount logic, the Python smoke test fails on
// any runner whose rootfs ships without /dev/shm (Firecracker microVMs,
// some chrooted CI images).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(
  resolve(__dirname, '../../entrypoint.sh'),
  'utf8'
);

function extractDevShmBlock() {
  const startMarker = '# Ensure /dev/shm exists and is mounted as tmpfs.';
  const startIdx = entrypoint.indexOf(startMarker);
  assert.ok(startIdx !== -1, '/dev/shm prereq block marker missing from entrypoint.sh');
  // Block runs from the comment header through the closing `fi`.
  const afterStart = entrypoint.slice(startIdx);
  const fiIdx = afterStart.indexOf('\nfi\n');
  assert.ok(fiIdx !== -1, 'closing fi for /dev/shm block missing');
  return afterStart.slice(0, fiIdx + 3);
}

describe('REQ-AGENT-023 prereq: /dev/shm tmpfs mount in entrypoint.sh', () => {
  it('the prereq block is present in entrypoint.sh', () => {
    const block = extractDevShmBlock();
    // The block must source-set /dev/shm in a way the rest of the
    // script can rely on: mkdir + mountpoint check + mount tmpfs.
    assert.match(block, /mkdir -p \/dev\/shm/, 'block must mkdir -p /dev/shm');
    assert.match(block, /mount -t tmpfs tmpfs \/dev\/shm/, 'block must mount tmpfs at /dev/shm');
    assert.match(block, /mountpoint -q \/dev\/shm/, 'block must mountpoint-check /dev/shm');
  });

  it('after the block runs, /dev/shm is a tmpfs mountpoint', () => {
    const block = extractDevShmBlock();
    // Run the block through bash. On CI runners that already have
    // /dev/shm (most do), the block is a no-op. On runners that don't,
    // it mounts tmpfs. Either way, the post-condition must hold.
    const res = spawnSync('bash', ['-c', `${block}\nmountpoint -q /dev/shm && echo MOUNTED || echo MISSING`], {
      encoding: 'utf-8',
    });
    assert.equal(res.status, 0, `bash exited non-zero:\n${res.stderr}`);
    assert.match(res.stdout, /MOUNTED/, `/dev/shm is not a mountpoint after block ran:\n${res.stdout}`);
  });

  it('after the block runs, Python multiprocessing.Lock can be allocated', (t) => {
    // The behaviour the block exists to guarantee: that
    // concurrent.futures.ProcessPoolExecutor can start. If /dev/shm
    // is missing or unmountable, this fails at startup. Run the
    // entrypoint snippet, then immediately try a tiny ProcessPool.
    //
    // Skip cleanly if python3 is not on PATH (some minimal CI runners).
    // Codeflare prod always has python3, but the test stays portable.
    const probeAvail = spawnSync('bash', ['-c', 'command -v python3'], { encoding: 'utf-8' });
    if (probeAvail.status !== 0) {
      t.skip('python3 not on PATH on this runner');
      return;
    }
    const block = extractDevShmBlock();
    const probe = [
      block,
      `python3 -c '`,
      `from concurrent.futures import ProcessPoolExecutor`,
      `with ProcessPoolExecutor(max_workers=1) as p:`,
      `    result = list(p.map(int, ["1", "2", "3"]))`,
      `print("PYOK:" + repr(result))`,
      `'`,
    ].join('\n');
    const res = spawnSync('bash', ['-c', probe], { encoding: 'utf-8' });
    assert.equal(
      res.status, 0,
      `Python multiprocessing probe failed:\nstdout=${res.stdout}\nstderr=${res.stderr}`
    );
    assert.match(
      res.stdout,
      /PYOK:\[1, 2, 3\]/,
      `ProcessPoolExecutor did not return [1,2,3]:\n${res.stdout}`
    );
  });

  it('the block is idempotent (re-running on a warm boot is a no-op)', () => {
    const block = extractDevShmBlock();
    // Run the block twice. The second run must succeed (exit 0) and
    // must NOT print the "mounted tmpfs" log line because the
    // mountpoint check should short-circuit it.
    const res = spawnSync('bash', ['-c', `${block}\n${block}\necho DONE`], {
      encoding: 'utf-8',
    });
    assert.equal(res.status, 0, `second run failed:\n${res.stderr}`);
    assert.match(res.stdout, /DONE/, 'second run did not complete');
    // Count how many times the "mounted tmpfs" log fired. It should
    // fire at most once across both runs (the first only if the
    // mount was actually performed).
    const mountedLogs = (res.stdout.match(/mounted tmpfs/g) || []).length;
    assert.ok(
      mountedLogs <= 1,
      `expected mount log to fire at most once across 2 runs (got ${mountedLogs}): ${res.stdout}`
    );
  });
});
