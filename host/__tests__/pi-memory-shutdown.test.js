// REQ-MEM-035 AC7: host-owned graceful shutdown, not a process-tree kill.
// Exercise only disposable Node processes and receipts in a fresh /tmp tree.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { shutdownPiMemoryOwners } from '../dist/pi-memory-shutdown.js';

const MARKDOWN = '# Final foreground memory\n\nUser prefers metric units.\n';
const relatedScript = `
  const fs = require('node:fs');
  process.title = 'pi';
  process.on('SIGTERM', () => fs.writeFileSync(process.argv[1], 'DIRECTLY SIGNALLED'));
  setInterval(() => {}, 1000);
  process.send({ ready: true });
`;
const ownerScript = `
  const fs = require('node:fs');
  const { spawn } = require('node:child_process');
  const config = JSON.parse(process.argv[1]);
  process.title = config.title;
  process.on('SIGTERM', () => {
    fs.writeFileSync(config.term, 'SIGTERM');
    if (config.replaceReceipt) fs.writeFileSync(config.ownersDir + '/' + process.pid + '.json', '{"changed":true}');
    setTimeout(() => {
      fs.writeFileSync(config.marker, config.markdown);
      process.exit(0);
    }, config.delayMs);
  });
  setInterval(() => {}, 1000);
  if (config.related) {
    const child = spawn(process.execPath, ['-e', config.relatedScript, config.relatedTerm],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    process.send({ relatedPid: child.pid });
    child.once('message', () => process.send({ ready: true }));
  } else process.send({ ready: true });
`;

function procIdentity(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  // comm may contain spaces/parentheses; field 22 is offset 19 after its last ')'.
  const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { startTime: tail[19], state: tail[0] };
}

function alive(pid) {
  try { return !['Z', 'X'].includes(procIdentity(pid).state); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function waitFor(predicate, explanation, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(explanation);
    await delay(10);
  }
}

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'pi-memory-shutdown-'));
  const ownersDir = join(root, 'owners');
  fs.mkdirSync(ownersDir);
  const children = [];
  const descendants = [];
  t.after(async () => {
    // Only positive PIDs created by this fixture; never process groups or live Pi.
    for (const { pid, startTime } of descendants) {
      try {
        if (procIdentity(pid).startTime === startTime) process.kill(pid, 'SIGKILL');
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await waitFor(() => children.every(child => child.exitCode !== null || child.signalCode !== null)
      && descendants.every(({ pid, startTime }) => !alive(pid) || procIdentity(pid).startTime !== startTime),
    'fixture processes did not exit');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, ownersDir,
    async owner(name, options = {}) {
      const marker = join(root, `${name}.md`);
      const term = join(root, `${name}.term`);
      const relatedTerm = join(root, `${name}.related-term`);
      const config = { title: 'pi', delayMs: 80, markdown: MARKDOWN,
        ...options, marker, term, relatedTerm, relatedScript, ownersDir };
      const child = spawn(process.execPath, ['-e', ownerScript, JSON.stringify(config)], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      children.push(child);
      let stderr = '', relatedPid;
      child.stderr.on('data', chunk => { stderr += chunk; });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`fixture startup: ${stderr}`)), 2500);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          reject(new Error(`fixture exited before ready (${code ?? signal}): ${stderr}`));
        });
        child.on('message', message => {
          if (message.relatedPid) {
            relatedPid = message.relatedPid;
            descendants.push({ pid: relatedPid, startTime: procIdentity(relatedPid).startTime });
          }
          if (message.ready) { clearTimeout(timer); resolve(); }
        });
      });
      const receipt = join(ownersDir, `${child.pid}.json`);
      const identity = { pid: child.pid, startTime: procIdentity(child.pid).startTime };
      return { child, pid: child.pid, relatedPid, marker, term, relatedTerm, receipt, identity,
        register(value = identity) { fs.writeFileSync(receipt, JSON.stringify(value)); } };
    },
  };
}

function assertNotSignalled(owner) {
  assert.equal(alive(owner.pid), true, 'a nonowner must remain alive');
  assert.equal(fs.existsSync(owner.term), false, 'a nonowner must never receive SIGTERM');
  assert.equal(fs.existsSync(owner.marker), false);
}

describe('REQ-MEM-035 AC7: bounded foreground owner shutdown', { timeout: 10_000 }, () => {
  it('REQ-MEM-035: AC7 waits for every registered Pi owner final write, not children or unlisted Pi', async t => {
    const f = fixture(t);
    const first = await f.owner('first', { delayMs: 120, related: true });
    const second = await f.owner('second', { delayMs: 240 });
    const unrelated = await f.owner('unlisted');
    first.register(); second.register();

    const result = await shutdownPiMemoryOwners(f.ownersDir, Date.now() + 2500);

    assert.deepEqual(result, { status: 'exited', count: 2 });
    for (const owner of [first, second]) {
      assert.equal(fs.readFileSync(owner.term, 'utf8'), 'SIGTERM');
      assert.equal(fs.readFileSync(owner.marker, 'utf8'), MARKDOWN);
      assert.equal(alive(owner.pid), false, 'writing alone is not completion: owner must exit');
    }
    assertNotSignalled(unrelated);
    assert.equal(alive(first.relatedPid), true, 'the owner descendant is not a shutdown target');
    assert.equal(fs.existsSync(first.relatedTerm), false, 'no direct descendant/group SIGTERM');
  });

  it('REQ-MEM-035: AC7 empty receipts and already-exited stale owners are harmless', async t => {
    const f = fixture(t);
    assert.deepEqual(await shutdownPiMemoryOwners(f.ownersDir, Date.now() + 1000), { status: 'exited', count: 0 });
    const stale = await f.owner('stale');
    stale.register();
    stale.child.kill('SIGKILL');
    await waitFor(() => stale.child.signalCode !== null, 'stale fixture did not exit');
    const owner = await f.owner('live');
    owner.register();
    assert.deepEqual(await shutdownPiMemoryOwners(f.ownersDir, Date.now() + 2000), { status: 'exited', count: 1 });
    assert.equal(fs.readFileSync(owner.marker, 'utf8'), MARKDOWN);
    assert.equal(fs.existsSync(stale.marker), false);
  });

  for (const mismatch of ['start-time', 'process-name', 'filename-pid']) {
    it(`REQ-MEM-035: AC7 ${mismatch} identity mismatch is unconfirmed and never signalled`, async t => {
      const f = fixture(t);
      const owner = await f.owner('mismatch', { title: mismatch === 'process-name' ? 'not-pi' : 'pi' });
      owner.register(mismatch === 'start-time'
        ? { ...owner.identity, startTime: String(BigInt(owner.identity.startTime) + 1n) }
        : owner.identity);
      if (mismatch === 'filename-pid') fs.renameSync(owner.receipt, join(f.ownersDir, `${owner.pid + 1}.json`));
      const result = await shutdownPiMemoryOwners(f.ownersDir, Date.now() + 1000);
      assert.deepEqual(result, { status: 'unconfirmed' });
      assertNotSignalled(owner);
    });
  }

  for (const invalid of ['malformed', 'oversized', 'invalid-pid', 'missing-start-time', 'symlink', 'directory']) {
    it(`REQ-MEM-035: AC7 ${invalid} receipt fails closed without targeting outside files`, async t => {
      const f = fixture(t);
      const outside = await f.owner('outside');
      const externalReceipt = join(f.root, 'outside.json');
      const original = JSON.stringify(outside.identity);
      fs.writeFileSync(externalReceipt, original);
      if (invalid === 'symlink') fs.symlinkSync(externalReceipt, outside.receipt);
      else if (invalid === 'directory') fs.mkdirSync(outside.receipt);
      else fs.writeFileSync(outside.receipt, invalid === 'malformed' ? '{bad json'
        : invalid === 'oversized' ? JSON.stringify({ ...outside.identity, padding: 'x'.repeat(1024 * 1024) })
        : invalid === 'invalid-pid' ? JSON.stringify({ ...outside.identity, pid: -outside.pid })
        : JSON.stringify({ pid: outside.pid }));
      assert.deepEqual(await shutdownPiMemoryOwners(f.ownersDir, Date.now() + 1000), { status: 'unconfirmed' });
      assertNotSignalled(outside);
      assert.equal(fs.readFileSync(externalReceipt, 'utf8'), original, 'external receipt is not modified');
    });
  }

  it('REQ-MEM-035: AC7 discovery failure is unconfirmed, not a successful empty shutdown', async t => {
    const f = fixture(t);
    const unrelated = await f.owner('unrelated');
    const notDirectory = join(f.root, 'not-a-directory');
    fs.writeFileSync(notDirectory, 'not an owners directory');
    assert.deepEqual(await shutdownPiMemoryOwners(notDirectory, Date.now() + 1000), { status: 'unconfirmed' });
    assertNotSignalled(unrelated);
  });

  it('REQ-MEM-035: AC7 a receipt changed during graceful drain cannot confirm capture', async t => {
    const f = fixture(t);
    // The child replaces its own receipt after SIGTERM, while shutdown is waiting.
    const owner = await f.owner('changed', { replaceReceipt: true, delayMs: 150 });
    owner.register();
    const result = await shutdownPiMemoryOwners(f.ownersDir, Date.now() + 1500);
    assert.deepEqual(result, { status: 'unconfirmed' });
    assert.equal(fs.readFileSync(owner.term, 'utf8'), 'SIGTERM');
    assert.deepEqual(JSON.parse(fs.readFileSync(owner.receipt, 'utf8')), { changed: true });
  });

  it('REQ-MEM-035: AC7 shares one short deadline across owners and reports only survivors', async t => {
    const f = fixture(t);
    const fast = await f.owner('fast', { delayMs: 40 });
    const slowOwners = [];
    for (let n = 0; n < 3; n++) slowOwners.push(await f.owner(`slow-${n}`, { delayMs: 5000 }));
    for (const owner of [fast, ...slowOwners]) owner.register();
    const start = performance.now();
    const result = await shutdownPiMemoryOwners(f.ownersDir, Date.now() + 400);
    const elapsed = performance.now() - start;
    assert.deepEqual(result, { status: 'timeout', remaining: 3 });
    assert.ok(elapsed < 1000, `one shared deadline, not a fresh wait per owner: ${elapsed}ms`);
    assert.equal(fs.readFileSync(fast.marker, 'utf8'), MARKDOWN);
    assert.equal(alive(fast.pid), false);
    for (const owner of slowOwners) {
      assert.equal(fs.readFileSync(owner.term, 'utf8'), 'SIGTERM');
      assert.equal(alive(owner.pid), true, 'timeout must not escalate to SIGKILL');
      assert.equal(fs.existsSync(owner.marker), false);
    }
  });
});
