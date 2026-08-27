import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  completionPath,
  latestAncestorCompletion,
  pruneCompletionState,
  readCompletion,
  writeCompletion,
  type ReviewIdentity,
} from '../../../preseed/agents/pi/extensions/review-completion-state';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-27T12:00:00.000Z');
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'review-completion-'));
  roots.push(value);
  return value;
}

function identity(overrides: Partial<ReviewIdentity> = {}): ReviewIdentity {
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

function options(stateRoot: string, now = NOW) {
  return { root: stateRoot, now: () => now, requestSync: vi.fn(() => true) };
}

afterEach(() => {
  delete process.env.CODEFLARE_SYNC_DAEMON_PIDFILE;
  vi.restoreAllMocks();
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('user-scoped review completion state', () => {
  it('writes one immutable exact marker and never refreshes its age', () => {
    const stateRoot = root();
    const first = options(stateRoot);
    expect(writeCompletion(identity(), first)).toEqual({ written: true, syncRequested: true });

    const path = completionPath(identity(), stateRoot);
    const initial = JSON.parse(readFileSync(path, 'utf8')) as { reviewedAt: string };
    expect(readCompletion(identity(), first)).toMatchObject({ status: 'complete' });

    const later = options(stateRoot, new Date(NOW.getTime() + DAY));
    expect(writeCompletion(identity(), later)).toEqual({ written: false, syncRequested: false });
    expect(JSON.parse(readFileSync(path, 'utf8')).reviewedAt).toBe(initial.reviewedAt);
  });

  it('isolates host, repository, PR, branch, base, and head identities', () => {
    const stateRoot = root();
    const base = options(stateRoot);
    writeCompletion(identity(), base);
    const otherBase = identity({ base: 'develop' });
    expect(completionPath(otherBase, stateRoot)).not.toBe(completionPath(identity(), stateRoot));
    expect(writeCompletion(otherBase, base).written).toBe(true);
    expect(readCompletion(identity(), base).status).toBe('complete');
    expect(readCompletion(otherBase, base).status).toBe('complete');

    const mismatches: ReviewIdentity[] = [
      identity({ gitHost: 'github.enterprise.test' }),
      identity({ repository: 'owner/other' }),
      identity({ pr: 43 }),
      identity({ branch: 'feature' }),
      identity({ head: 'b'.repeat(40) }),
    ];
    for (const candidate of mismatches) {
      expect(readCompletion(candidate, base).status).not.toBe('complete');
    }
  });

  it('deletes expired markers and retains ten newest per repository and branch', () => {
    const stateRoot = root();
    writeCompletion(
      identity({ head: 'f'.repeat(40), pr: 99 }),
      options(stateRoot, new Date(NOW.getTime() - 31 * DAY)),
    );
    for (let index = 11; index >= 0; index -= 1) {
      writeCompletion(
        identity({ head: index.toString(16).padStart(40, '0') }),
        options(stateRoot, new Date(NOW.getTime() - index * DAY)),
      );
    }

    pruneCompletionState({ root: stateRoot, now: () => NOW });
    expect(readCompletion(identity({ head: '0'.repeat(40) }), options(stateRoot)).status).toBe('complete');
    expect(readCompletion(identity({ head: 'a'.repeat(40) }), options(stateRoot)).status).not.toBe('complete');
    expect(readCompletion(identity({ head: 'f'.repeat(40), pr: 99 }), options(stateRoot)).status).toBe('missing');
  });

  it('selects the newest retained same-PR ancestor and ignores other PRs', () => {
    const stateRoot = root();
    const older = identity({ head: '1'.repeat(40) });
    const newest = identity({ head: '2'.repeat(40) });
    writeCompletion(older, options(stateRoot, new Date(NOW.getTime() - DAY)));
    writeCompletion(newest, options(stateRoot));
    writeCompletion(identity({ pr: 99, head: '3'.repeat(40) }), options(stateRoot));

    const isAncestor = vi.fn((base: string) => base === older.head);
    expect(latestAncestorCompletion(identity({ head: '4'.repeat(40) }), '/repo', {
      ...options(stateRoot),
      isAncestor,
    })?.head).toBe(older.head);
    expect(isAncestor).not.toHaveBeenCalledWith('3'.repeat(40), '4'.repeat(40), '/repo');
  });

  it('replaces an invalid exact destination once and rejects symlinks', () => {
    const stateRoot = root();
    const path = completionPath(identity(), stateRoot);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{broken', 'utf8');

    expect(writeCompletion(identity(), options(stateRoot)).written).toBe(true);
    expect(readCompletion(identity(), options(stateRoot)).status).toBe('complete');

    rmSync(path);
    const target = join(stateRoot, 'outside.json');
    writeFileSync(target, '{}', 'utf8');
    symlinkSync(target, path);
    expect(readCompletion(identity(), options(stateRoot)).status).toBe('missing');
  });

  it('warns for malformed daemon PID state without changing local acknowledgement', async () => {
    const stateRoot = root();
    const pidFile = join(stateRoot, 'daemon.pid');
    writeFileSync(pidFile, 'not-a-pid\n', 'utf8');
    process.env.CODEFLARE_SYNC_DAEMON_PIDFILE = pidFile;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(writeCompletion(identity(), { root: stateRoot, now: () => NOW })).toEqual({
      written: true,
      syncRequested: false,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('R2 sync trigger unavailable');
    delete process.env.CODEFLARE_SYNC_DAEMON_PIDFILE;
    warn.mockRestore();
  });

  it('keeps local acknowledgement when sync signaling fails', () => {
    const stateRoot = root();
    const requestSync = vi.fn(() => false);
    expect(writeCompletion(identity(), { root: stateRoot, now: () => NOW, requestSync })).toEqual({
      written: true,
      syncRequested: false,
    });
    expect(readCompletion(identity(), { root: stateRoot, now: () => NOW }).status).toBe('complete');
  });
});
