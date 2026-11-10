// REQ-VAULT-004 AC6 / REQ-VAULT-014 AC5 on the Pi runtime. Pi previously only
// ever ran `graphify global add`, so the global manifest accumulated every repo
// a session touched and a graph-less checkout kept publishing the repo before
// it. These assert the reconcile plan Pi now computes before taking the lock.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Redirect only Pi's hardcoded manifest read into the temporary fixture.
// Other filesystem operations remain real; never inspect the user's graph.
const fixture = vi.hoisted(() => ({ manifest: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, readFileSync: (path: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) =>
    Reflect.apply(fs.readFileSync, fs, [
      path === '/home/user/.graphify/global-manifest.json' ? fixture.manifest : path, ...args,
    ]) };
});

import { planGlobalGraphReconcile, reconcileGlobalGraph } from '../../../preseed/agents/pi/extensions/codeflare-pi';

const manifest = (...tags: string[]) =>
  JSON.stringify({ repos: Object.fromEntries(tags.map((tag) => [tag, { source_hash: '0123456789abcdef' }])) });

describe('planGlobalGraphReconcile / REQ-VAULT-014 AC5 (Pi holds the same single-active-repo invariant)', () => {
  it('removes every repo tag that is not the active checkout, and adds the active one', () => {
    const plan = planGlobalGraphReconcile(manifest('user_vault', 'repo-a', 'repo-b'), '/w/repo-b', true);
    expect(plan.remove).toEqual(['repo-a']);
    expect(plan.add).toEqual({ graph: '/w/repo-b/graphify-out/graph.json', tag: 'repo-b' });
  });

  it('never removes user_vault, which is always-on and never a repo tag', () => {
    const plan = planGlobalGraphReconcile(manifest('user_vault', 'repo-a'), '/w/repo-b', true);
    expect(plan.remove).not.toContain('user_vault');
  });

  it('sweeps tags no previous-repo comparison could name, such as a crashed run leftover', () => {
    // repo-z and workspace are reachable from the manifest alone; a diff
    // against the previously active repo would only ever have found repo-a.
    const plan = planGlobalGraphReconcile(manifest('user_vault', 'repo-a', 'repo-z', 'workspace'), '/w/repo-b', true);
    expect(plan.remove.sort()).toEqual(['repo-a', 'repo-z', 'workspace']);
  });

  it('a checkout without a graph removes every repo tag and adds nothing', () => {
    const plan = planGlobalGraphReconcile(manifest('user_vault', 'repo-a'), '/w/repo-b', false);
    expect(plan.remove).toEqual(['repo-a']);
    expect(plan.add).toBeUndefined();
  });

  it('re-adds the active checkout rather than removing it when it is already published', () => {
    const plan = planGlobalGraphReconcile(manifest('user_vault', 'repo-b'), '/w/repo-b', true);
    expect(plan.remove).toEqual([]);
    expect(plan.add?.tag).toBe('repo-b');
  });

  it('an absent or malformed manifest removes nothing, since adding is idempotent and removing is not', () => {
    expect(planGlobalGraphReconcile(undefined, '/w/repo-b', true).remove).toEqual([]);
    expect(planGlobalGraphReconcile('{not json', '/w/repo-b', true).remove).toEqual([]);
    expect(planGlobalGraphReconcile('{"repos":null}', '/w/repo-b', true).remove).toEqual([]);
    // The addition still happens; only the removal set is withheld.
    expect(planGlobalGraphReconcile('{not json', '/w/repo-b', true).add?.tag).toBe('repo-b');
  });

  it('skips the add when the manifest already records this graph, matching the shell hook', () => {
    const published = JSON.stringify({
      repos: {
        'repo-b': { source_hash: '0123456789abcdef', source_path: '/w/repo-b/graphify-out/graph.json' },
      },
    });
    const plan = planGlobalGraphReconcile(published, '/w/repo-b', true, '0123456789abcdef');
    expect(plan.add).toBeUndefined();
    expect(plan.remove).toEqual([]);
  });

  it('still adds when another checkout of the same basename published an identical graph', () => {
    // Tags are keyed by basename, so /elsewhere/repo-b owns the tag here. Its
    // graph hashes the same (an empty or freshly scaffolded graph.json is the
    // common case), so a hash-only dedup would skip the add and leave the tag
    // resolving to a repo the user is no longer in.
    const otherCheckout = JSON.stringify({
      repos: {
        'repo-b': {
          source_hash: '0123456789abcdef',
          source_path: '/elsewhere/repo-b/graphify-out/graph.json',
        },
      },
    });
    const plan = planGlobalGraphReconcile(otherCheckout, '/w/repo-b', true, '0123456789abcdef');
    expect(plan.add).toEqual({ graph: '/w/repo-b/graphify-out/graph.json', tag: 'repo-b' });
  });

  it('still adds when the recorded hash differs, and still removes other tags alongside it', () => {
    const stale = JSON.stringify({
      repos: { 'repo-a': {}, 'repo-b': { source_hash: '0123456789abcdef' } },
    });
    const plan = planGlobalGraphReconcile(stale, '/w/repo-b', true, 'fedcba9876543210');
    expect(plan.add?.tag).toBe('repo-b');
    expect(plan.remove).toEqual(['repo-a']);
  });

  it('refuses the dedup when the manifest records no source path at all', () => {
    // Degrading to "never skip" is the safe direction, but it has to be stated:
    // if graphify stopped recording source_path the optimisation would go dead
    // while still looking healthy.
    const noPath = JSON.stringify({ repos: { 'repo-b': { source_hash: '0123456789abcdef' } } });
    expect(planGlobalGraphReconcile(noPath, '/w/repo-b', true, '0123456789abcdef').add?.tag).toBe('repo-b');
  });

  it('refuses the dedup on a malformed stored hash rather than trusting it', () => {
    // graphify records exactly 16 lowercase hex chars. Both a resized value and
    // a right-sized non-hex one fall back to publishing.
    const path = '/w/repo-b/graphify-out/graph.json';
    const short = JSON.stringify({ repos: { 'repo-b': { source_hash: 'abc', source_path: path } } });
    expect(planGlobalGraphReconcile(short, '/w/repo-b', true, 'abc').add?.tag).toBe('repo-b');
    const notHex = JSON.stringify({
      repos: { 'repo-b': { source_hash: 'zzzzzzzzzzzzzzzz', source_path: path } },
    });
    expect(planGlobalGraphReconcile(notHex, '/w/repo-b', true, 'zzzzzzzzzzzzzzzz').add?.tag).toBe('repo-b');
  });
});

// reconcileGlobalGraph's return value is the signal session_start warns on, so
// these drive the real function against real subprocesses rather than asserting
// on a mock. A repo with a graph and no manifest always yields work to do.
describe('reconcileGlobalGraph failure semantics / REQ-VAULT-014 AC6', () => {
  let root: string;
  let repo: string;
  let bin: string;
  const realPath = process.env.PATH;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-reconcile-'));
    repo = join(root, 'repo-a');
    bin = join(root, 'bin');
    mkdirSync(join(repo, 'graphify-out'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    fixture.manifest = join(root, 'global-manifest.json');
    writeFileSync(fixture.manifest, manifest());
    writeFileSync(join(repo, 'graphify-out', 'graph.json'), '{"nodes":[],"links":[]}');
  });

  afterEach(() => {
    process.env.PATH = realPath;
    rmSync(root, { recursive: true, force: true });
    fixture.manifest = '';
  });

  function stub(name: string, body: string) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }

  // Translate the protected path only; preserve real flock exclusion/timeout.
  function realFixtureLock() {
    stub('flock', `[ "$3" = /run/codeflare/locks/graphify-global.lock ] || exit 2
wait_flag="$1"; seconds="$2"; shift 3
exec /usr/bin/flock "$wait_flag" "$seconds" "${join(root, 'global.lock')}" "$@"`);
  }

  it('reports success when the reconcile transaction exits cleanly', () => {
    realFixtureLock();
    stub('graphify', 'exit 0');
    process.env.PATH = `${bin}:${realPath}`;
    expect(reconcileGlobalGraph(repo)).toBe(true);
  });

  it('reports failure when graphify exits non-zero, which is what session_start warns on', () => {
    realFixtureLock();
    stub('graphify', 'exit 1');
    process.env.PATH = `${bin}:${realPath}`;
    expect(reconcileGlobalGraph(repo)).toBe(false);
  });

  it('stays silent when flock is absent, a supported configuration rather than a failure', () => {
    // Empty PATH: spawning flock raises ENOENT. Warning here would nag about
    // a disabled graphify plugin the user cannot act on from the session.
    process.env.PATH = bin;
    expect(reconcileGlobalGraph(repo)).toBe(true);
  });

  it('stays silent when graphify is absent, which reaches the caller as an exit status', () => {
    // The disabled-plugin case entrypoint.sh actually produces: flock is
    // present, graphify is not. graphify runs inside the locked script, so its
    // absence can never surface as ENOENT the way flock's does; the script
    // reports it as 127 instead. Treating that as a failure would warn on every
    // session start about something the user cannot act on from the session.
    realFixtureLock();
    symlinkSync('/bin/bash', join(bin, 'bash'));
    process.env.PATH = bin;
    expect(reconcileGlobalGraph(repo)).toBe(true);
  });

  it('still reports failure when graphify is present and the transaction fails', () => {
    // Guards the test above: 127 must not become a blanket "any error is fine".
    realFixtureLock();
    stub('graphify', 'exit 3');
    process.env.PATH = `${bin}:${realPath}`;
    expect(reconcileGlobalGraph(repo)).toBe(false);
  });

  it('IG0318: real lock contention reports failure without running graphify, then permits retry', async () => {
    realFixtureLock();
    const reached = join(root, 'graphify-reached');
    stub('graphify', `printf reached > "${reached}"`);
    process.env.PATH = `${bin}:${realPath}`;
    const holder = spawn('/usr/bin/flock', [join(root, 'global.lock'), '/bin/bash', '-c',
      'printf ready; read -r release'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise(resolve => holder.once('close', resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fixture lock acquisition timed out')), 2000);
        holder.once('error', error => { clearTimeout(timer); reject(error); });
        holder.stdout.once('data', () => { clearTimeout(timer); resolve(); });
        holder.once('exit', () => { clearTimeout(timer); reject(new Error('fixture lock holder exited before release')); });
      });
      expect(reconcileGlobalGraph(repo)).toBe(false);
      expect(existsSync(reached)).toBe(false);
    } finally {
      holder.stdin.end();
      await exited;
    }
    expect(reconcileGlobalGraph(repo)).toBe(true);
    expect(existsSync(reached)).toBe(true);
    // CLI exclusion/return semantics only, not persisted graph convergence.
    // Neither this nor sequential retry resolves RQ0081.
  }, 10000);
});
