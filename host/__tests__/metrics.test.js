import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Behavioral tests for metrics.ts.
 *
 * We mock node:fs, node:os, and node:child_process so these tests
 * run without real system calls and can verify caching, error handling,
 * and composition logic.
 */

// ── Mocks ────────────────────────────────────────────────────────────

const fsMock = {
  readFileSync: mock.fn(() => '{"status":"synced","error":null,"userPath":"/home/user"}'),
  // Preserve all other fs exports as stubs
  default: { readFileSync: null },
};
fsMock.default.readFileSync = fsMock.readFileSync;

const osMock = {
  loadavg: mock.fn(() => [0.5, 0.4, 0.3]),
  cpus: mock.fn(() => [{ model: 'cpu', speed: 2400 }]),
  totalmem: mock.fn(() => 4 * 1024 * 1024 * 1024), // 4 GB
  freemem: mock.fn(() => 1 * 1024 * 1024 * 1024),   // 1 GB free
  default: {},
};
osMock.default = {
  loadavg: osMock.loadavg,
  cpus: osMock.cpus,
  totalmem: osMock.totalmem,
  freemem: osMock.freemem,
};

const execFileMock = mock.fn((_cmd, _args, cb) => {
  cb(null, {
    stdout: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       50G   30G   20G  60% /home/user\n',
  });
});

// node:child_process default export + named export
mock.module('node:fs', {
  defaultExport: fsMock.default,
  namedExports: { readFileSync: fsMock.readFileSync },
});

mock.module('node:os', {
  defaultExport: osMock.default,
  namedExports: {
    loadavg: osMock.loadavg,
    cpus: osMock.cpus,
    totalmem: osMock.totalmem,
    freemem: osMock.freemem,
  },
});

mock.module('node:child_process', {
  namedExports: { execFile: execFileMock },
});

// Import after mocks are in place
const { getSyncStatus, getDiskMetrics, getSystemMetrics } = await import('../dist/metrics.js');

// No-op logger for test calls
const noopLog = () => {};

describe('getSyncStatus()', () => {
  beforeEach(() => {
    fsMock.readFileSync.mock.resetCalls();
  });

  it('returns parsed sync status from file', () => {
    fsMock.readFileSync.mock.mockImplementation(
      () => '{"status":"synced","error":null,"userPath":"/home/user"}'
    );
    const result = getSyncStatus();
    assert.equal(result.status, 'synced');
    assert.equal(result.error, null);
    assert.equal(result.userPath, '/home/user');
  });

  it('returns fallback on missing file', () => {
    fsMock.readFileSync.mock.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });
    const result = getSyncStatus();
    assert.equal(result.status, 'pending');
    assert.equal(result.error, null);
    assert.equal(result.userPath, null);
  });

  it('returns fallback on malformed JSON', () => {
    fsMock.readFileSync.mock.mockImplementation(() => '{{not json');
    const result = getSyncStatus();
    assert.equal(result.status, 'pending');
    assert.equal(result.error, null);
    assert.equal(result.userPath, null);
  });
});

describe('getDiskMetrics()', () => {
  beforeEach(() => {
    execFileMock.mock.resetCalls();
  });

  it('caches within TTL (uses fake timers)', async () => {
    mock.timers.enable({ apis: ['Date'] });

    // Force cache to be stale by setting time far in the future
    mock.timers.setTime(100_000);

    execFileMock.mock.mockImplementation((_cmd, _args, cb) => {
      cb(null, {
        stdout: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       50G   30G   20G  60% /home/user\n',
      });
    });

    // First call — should invoke execFile
    await getDiskMetrics(noopLog);
    assert.equal(execFileMock.mock.callCount(), 1, 'first call should shell out');

    // Advance time by less than 30s TTL
    mock.timers.setTime(100_000 + 15_000);

    // Second call — should use cache
    await getDiskMetrics(noopLog);
    assert.equal(execFileMock.mock.callCount(), 1, 'second call within TTL should use cache');

    // Advance past TTL
    mock.timers.setTime(100_000 + 31_000);

    await getDiskMetrics(noopLog);
    assert.equal(execFileMock.mock.callCount(), 2, 'call after TTL should shell out again');

    mock.timers.reset();
  });

  it('handles malformed df output without crashing', async () => {
    mock.timers.enable({ apis: ['Date'] });
    mock.timers.setTime(300_000); // ensure cache is stale

    execFileMock.mock.mockImplementation((_cmd, _args, cb) => {
      cb(null, { stdout: 'unexpected single line' });
    });

    // Should not throw — returns whatever was previously cached (or '...')
    const result = await getDiskMetrics(noopLog);
    assert.equal(typeof result, 'string', 'should return a string');

    mock.timers.reset();
  });

  it('handles execFile error without crashing', async () => {
    mock.timers.enable({ apis: ['Date'] });
    mock.timers.setTime(400_000);

    execFileMock.mock.mockImplementation((_cmd, _args, cb) => {
      cb(new Error('command not found'));
    });

    const result = await getDiskMetrics(noopLog);
    assert.equal(typeof result, 'string', 'should return a string even on error');

    mock.timers.reset();
  });
});

describe('getSystemMetrics()', () => {
  beforeEach(() => {
    osMock.loadavg.mock.resetCalls();
    osMock.cpus.mock.resetCalls();
    osMock.totalmem.mock.resetCalls();
    osMock.freemem.mock.resetCalls();
    execFileMock.mock.resetCalls();
  });

  it('composes values from sub-functions', async () => {
    mock.timers.enable({ apis: ['Date'] });
    mock.timers.setTime(500_000); // ensure disk cache stale

    osMock.loadavg.mock.mockImplementation(() => [0.5, 0.4, 0.3]);
    osMock.cpus.mock.mockImplementation(() => [{ model: 'cpu' }]); // 1 CPU
    osMock.totalmem.mock.mockImplementation(() => 4 * 1024 * 1024 * 1024);
    osMock.freemem.mock.mockImplementation(() => 1 * 1024 * 1024 * 1024);
    execFileMock.mock.mockImplementation((_cmd, _args, cb) => {
      cb(null, {
        stdout: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       50G   30G   20G  60% /home/user\n',
      });
    });

    const metrics = await getSystemMetrics(noopLog);

    // CPU: (0.5 / 1) * 100 = 50%
    assert.equal(metrics.cpu, '50%');

    // Memory: used = 4 - 1 = 3 GB / 4 GB
    assert.equal(metrics.mem, '3.0/4.0G');

    // Disk: fields[2]/fields[1] = 30G/50G
    assert.equal(metrics.hdd, '30G/50G');

    mock.timers.reset();
  });

  it('returns fallback values when os functions throw', async () => {
    mock.timers.enable({ apis: ['Date'] });
    mock.timers.setTime(600_000);

    osMock.loadavg.mock.mockImplementation(() => { throw new Error('no loadavg'); });
    osMock.cpus.mock.mockImplementation(() => { throw new Error('no cpus'); });
    osMock.totalmem.mock.mockImplementation(() => { throw new Error('no totalmem'); });
    osMock.freemem.mock.mockImplementation(() => { throw new Error('no freemem'); });
    execFileMock.mock.mockImplementation((_cmd, _args, cb) => {
      cb(new Error('no df'));
    });

    const metrics = await getSystemMetrics(noopLog);
    assert.equal(typeof metrics.cpu, 'string');
    assert.equal(typeof metrics.mem, 'string');
    assert.equal(typeof metrics.hdd, 'string');

    mock.timers.reset();
  });
});
