import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  completionPath,
  latestAncestorCompletion,
  pruneCompletionState,
  readCompletion,
  writeCompletion,
} from '../../preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/review-completion-state.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-27T12:00:00.000Z');
const roots = [];

function root() {
  const value = mkdtempSync(join(tmpdir(), 'claude-review-completion-'));
  roots.push(value);
  return value;
}

function identity(overrides = {}) {
  return {
    gitHost: 'github.com',
    repository: 'owner/repo',
    pr: 42,
    branch: 'develop',
    base: 'main',
    head: 'a'.repeat(40),
    ...overrides,
  };
}

function options(stateRoot, now = NOW) {
  return { root: stateRoot, now: () => now };
}

afterEach(() => {
  delete process.env.CODEFLARE_SYNC_DAEMON_PIDFILE;
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('Claude review completion helper parity', () => {
  it('writes and reads an immutable exact marker', () => {
    const stateRoot = root();
    assert.deepEqual(writeCompletion(identity(), options(stateRoot)), { written: true });
    const path = completionPath(identity(), stateRoot);
    const first = JSON.parse(readFileSync(path, 'utf8')).reviewedAt;
    assert.equal(readCompletion(identity(), options(stateRoot)).status, 'complete');
    assert.deepEqual(writeCompletion(identity(), options(stateRoot, new Date(NOW.getTime() + DAY))), {
      written: false,
    });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).reviewedAt, first);
  });

  it('isolates protected bases in marker paths', () => {
    const stateRoot = root();
    const main = identity();
    const develop = identity({ base: 'develop' });
    assert.notEqual(completionPath(main, stateRoot), completionPath(develop, stateRoot));
    assert.equal(writeCompletion(main, options(stateRoot)).written, true);
    assert.equal(writeCompletion(develop, options(stateRoot)).written, true);
    assert.equal(readCompletion(main, options(stateRoot)).status, 'complete');
    assert.equal(readCompletion(develop, options(stateRoot)).status, 'complete');
  });

  it('prunes expired and excess markers and finds newest same-PR ancestor', () => {
    const stateRoot = root();
    for (let index = 11; index >= 0; index -= 1) {
      writeCompletion(
        identity({ head: index.toString(16).padStart(40, '0') }),
        options(stateRoot, new Date(NOW.getTime() - index * DAY)),
      );
    }
    pruneCompletionState({ root: stateRoot, now: () => NOW });
    assert.equal(readCompletion(identity({ head: '0'.repeat(40) }), options(stateRoot)).status, 'complete');
    assert.notEqual(readCompletion(identity({ head: 'a'.repeat(40) }), options(stateRoot)).status, 'complete');

    const ancestorHead = '1'.padStart(40, '0');
    const candidate = latestAncestorCompletion(identity({ head: 'f'.repeat(40) }), '/repo', {
      ...options(stateRoot),
      isAncestor: (base) => base === ancestorHead,
    });
    assert.equal(candidate?.head, ancestorHead);
  });

  it('writes local completion without forcing an R2 sync', () => {
    const stateRoot = root();
    const pidFile = join(stateRoot, 'daemon.pid');
    writeFileSync(pidFile, `${process.pid}\n`);
    process.env.CODEFLARE_SYNC_DAEMON_PIDFILE = pidFile;
    const original = process.kill;
    let signals = 0;
    process.kill = () => { signals += 1; return true; };
    try {
      assert.deepEqual(writeCompletion(identity(), { root: stateRoot, now: () => NOW }), { written: true });
    } finally {
      process.kill = original;
    }
    assert.equal(signals, 0);
    assert.equal(readCompletion(identity(), { root: stateRoot, now: () => NOW }).status, 'complete');
  });
});

for (const [owner, modulePath] of [
  ['', '../../preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/review-completion-state.mjs'],
  ['Pi ', '../../preseed/agents/pi/extensions/review-completion-state.ts'],
]) {
  for (const competitor of [false, true]) {
    it(`REQ-STOR-027 AC2: ${owner}atomic publication exposes complete hard-linked bytes (competing winner: ${competitor})`, { timeout: 10_000 }, async () => {
      const module = new URL(modulePath, import.meta.url).href;
      const { completionPath, readCompletion } = await import(module);
      const stateRoot = root();
      const path = completionPath(identity(), stateRoot);
      const gate = new Int32Array(new SharedArrayBuffer(4));
      // Pause the actual filesystem link, not the publisher API. The worker
      // holds a fully written temporary file while this thread observes it.
      const worker = new Worker(`
        const fs = require('node:fs');
        const { syncBuiltinESMExports } = require('node:module');
        const { parentPort, workerData } = require('node:worker_threads');
        const gate = new Int32Array(workerData.gate);
        const link = fs.linkSync;
        fs.linkSync = (temporary, destination) => {
          parentPort.postMessage({ stage: 'prepared', temporary, destination });
          Atomics.wait(gate, 0, 0);
          link(temporary, destination);
          parentPort.postMessage({ stage: 'linked' });
          Atomics.wait(gate, 0, 1);
        };
        syncBuiltinESMExports();
        import(workerData.module).then(({ writeCompletion }) => {
          parentPort.postMessage({ stage: 'done', result: writeCompletion(workerData.identity, {
            root: workerData.root, now: () => new Date(workerData.now),
          }) });
        }).catch(error => { throw error; });
      `, { eval: true, workerData: {
        gate: gate.buffer, root: stateRoot, identity: identity(), now: NOW.toISOString(),
        module,
      } });
      try {
        const [prepared] = await once(worker, 'message', { signal: AbortSignal.timeout(2000) });
        assert.equal(prepared.stage, 'prepared');
        assert.equal(prepared.destination, path);
        assert.equal(dirname(prepared.temporary), dirname(path));
        const temporaryStat = statSync(prepared.temporary);
        assert.equal(temporaryStat.mode & 0o777, 0o600);
        const completeBytes = `${JSON.stringify({ version: 1, ...identity(), reviewedAt: NOW.toISOString() })}\n`;
        assert.equal(readFileSync(prepared.temporary, 'utf8'), completeBytes);
        assert.equal(existsSync(path), false);
        let winnerBytes = completeBytes;
        if (competitor) {
          const other = join(dirname(path), '.competing-publication');
          winnerBytes = `${JSON.stringify({ version: 1, ...identity(), reviewedAt: new Date(NOW.getTime() - DAY).toISOString() })}\n`;
          writeFileSync(other, winnerBytes, { mode: 0o600, flag: 'wx' });
          linkSync(other, path);
          rmSync(other);
        }
        let next = once(worker, 'message', { signal: AbortSignal.timeout(2000) });
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        let [message] = await next;
        if (!competitor) {
          assert.equal(message.stage, 'linked');
          const published = statSync(path);
          assert.equal(published.ino, temporaryStat.ino);
          assert.equal(published.dev, temporaryStat.dev);
          assert.equal(published.nlink, 2);
          assert.equal(readFileSync(path, 'utf8'), completeBytes);
          next = once(worker, 'message', { signal: AbortSignal.timeout(2000) });
          Atomics.store(gate, 0, 2);
          Atomics.notify(gate, 0);
          [message] = await next;
        }
        assert.deepEqual(message, { stage: 'done', result: { written: !competitor } });
        assert.equal(readFileSync(path, 'utf8'), winnerBytes);
        assert.equal(statSync(path).mode & 0o777, 0o600);
        assert.deepEqual(readdirSync(dirname(path)), [path.split('/').at(-1)]);
        assert.equal(readCompletion(identity(), options(stateRoot)).status, 'complete');
      } finally {
        await worker.terminate();
      }
    });
  }
}

for (const [label, patch] of [
  ['wrong schema', { version: 2 }],
  ['missing schema', { version: undefined }],
  ['missing timestamp', { reviewedAt: undefined }],
  ['numeric timestamp', { reviewedAt: NOW.getTime() }],
  ['invalid timestamp', { reviewedAt: 'not-a-date' }],
  ['beyond future tolerance', { reviewedAt: new Date(NOW.getTime() + 300_001).toISOString() }],
]) {
  it(`REQ-STOR-027 AC3: rejects ${label} without changing outside bytes`, () => {
    const sandbox = root();
    const stateRoot = join(sandbox, 'state');
    const path = completionPath(identity(), stateRoot);
    mkdirSync(dirname(path), { recursive: true });
    const sentinel = join(sandbox, 'sentinel');
    writeFileSync(sentinel, 'outside marker tree', { mode: 0o640 });
    writeFileSync(path, JSON.stringify({ version: 1, ...identity(), reviewedAt: NOW.toISOString(), ...patch }));
    assert.equal(readCompletion(identity(), options(stateRoot)).status, 'missing');
    pruneCompletionState(options(stateRoot));
    assert.equal(existsSync(path), false);
    assert.equal(readFileSync(sentinel, 'utf8'), 'outside marker tree');
    assert.equal(statSync(sentinel).mode & 0o777, 0o640);
  });
}

for (const kind of ['directory', 'fifo']) {
  it(`REQ-STOR-027 AC3: refuses a ${kind} marker without blocking or reading its contents`, { timeout: 10_000 }, async () => {
    const sandbox = root();
    const stateRoot = join(sandbox, 'state');
    const path = completionPath(identity(), stateRoot);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(join(sandbox, 'sentinel'), 'outside marker tree');
    if (kind === 'fifo') execFileSync('mkfifo', [path], { timeout: 2000 });
    else {
      mkdirSync(path);
      writeFileSync(join(path, 'marker.json'), JSON.stringify({ version: 1, ...identity(), reviewedAt: NOW.toISOString() }));
    }
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.module).then(({ readCompletion, pruneCompletionState }) => {
        const options = { root: workerData.root, now: () => new Date(workerData.now) };
        const result = readCompletion(workerData.identity, options);
        pruneCompletionState(options);
        parentPort.postMessage(result);
      });
    `, { eval: true, workerData: {
      root: stateRoot, identity: identity(), now: NOW.toISOString(),
      module: new URL('../../preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/review-completion-state.mjs', import.meta.url).href,
    } });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const [result] = await once(worker, 'message', { signal: controller.signal });
      assert.deepEqual(result, { status: 'missing' });
      assert.equal(existsSync(path), false);
      assert.equal(readFileSync(join(sandbox, 'sentinel'), 'utf8'), 'outside marker tree');
    } finally {
      clearTimeout(timer);
      await worker.terminate();
    }
  });
}

for (const redirected of ['root', 'root-parent', 'repository', 'branch']) {
  it(`REQ-STOR-027: ${redirected} symlink refuses read/publication/prune without outside effects`, () => {
    const sandbox = root();
    const outside = root();
    const base = join(sandbox, 'parent', 'state');
    const normalPath = completionPath(identity(), base);
    const destination = redirected === 'root' ? base : redirected === 'root-parent' ? dirname(base)
      : redirected === 'repository' ? dirname(dirname(normalPath)) : dirname(normalPath);
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(outside, destination, 'dir');
    const escaped = completionPath(identity(), base);
    mkdirSync(dirname(escaped), { recursive: true });
    writeFileSync(escaped, JSON.stringify({ version: 1, ...identity(), reviewedAt: NOW.toISOString() }));
    const sentinel = join(dirname(escaped), 'unrelated.txt');
    writeFileSync(sentinel, 'OUTSIDE_MUST_SURVIVE');
    const protectedPath = realpathSync(escaped);
    const protectedSentinel = realpathSync(sentinel);
    const before = readFileSync(protectedPath, 'utf8');
    const mode = statSync(dirname(protectedPath)).mode & 0o777;
    assert.equal(readCompletion(identity(), options(base)).status, 'missing');
    assert.equal(latestAncestorCompletion(identity({ head: 'b'.repeat(40) }), '/unused', { ...options(base), isAncestor: () => true }), undefined);
    assert.throws(() => writeCompletion(identity({ head: 'b'.repeat(40) }), options(base)));
    pruneCompletionState(options(base));
    assert.equal(readFileSync(protectedPath, 'utf8'), before);
    assert.equal(readFileSync(protectedSentinel, 'utf8'), 'OUTSIDE_MUST_SURVIVE');
    assert.equal(statSync(dirname(protectedPath)).mode & 0o777, mode);
    assert.deepEqual(readdirSync(dirname(protectedPath)).sort(), [escaped.split('/').at(-1), 'unrelated.txt'].sort());
  });
}
