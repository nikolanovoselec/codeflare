import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  return { root: stateRoot, now: () => now, requestSync: () => true };
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('Claude review completion helper parity', () => {
  it('writes and reads an immutable exact marker', () => {
    const stateRoot = root();
    assert.deepEqual(writeCompletion(identity(), options(stateRoot)), { written: true, syncRequested: true });
    const path = completionPath(identity(), stateRoot);
    const first = JSON.parse(readFileSync(path, 'utf8')).reviewedAt;
    assert.equal(readCompletion(identity(), options(stateRoot)).status, 'complete');
    assert.deepEqual(writeCompletion(identity(), options(stateRoot, new Date(NOW.getTime() + DAY))), {
      written: false,
      syncRequested: false,
    });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).reviewedAt, first);
  });

  it('prunes expired and excess markers and finds newest same-PR ancestor', () => {
    const stateRoot = root();
    for (let index = 0; index < 12; index += 1) {
      writeCompletion(
        identity({ head: index.toString(16).padStart(40, '0') }),
        options(stateRoot, new Date(NOW.getTime() - index * DAY)),
      );
    }
    pruneCompletionState({ root: stateRoot, now: () => NOW });
    assert.equal(readCompletion(identity({ head: '0'.repeat(40) }), options(stateRoot)).status, 'complete');
    assert.notEqual(readCompletion(identity({ head: 'a'.repeat(40) }), options(stateRoot)).status, 'complete');

    const candidate = latestAncestorCompletion(identity({ head: 'f'.repeat(40) }), '/repo', {
      ...options(stateRoot),
      isAncestor: (base) => base === '1'.repeat(40),
    });
    assert.equal(candidate?.head, '1'.repeat(40));
  });

  it('keeps local completion when the sync signal fails', () => {
    const stateRoot = root();
    assert.deepEqual(writeCompletion(identity(), {
      root: stateRoot,
      now: () => NOW,
      requestSync: () => false,
    }), { written: true, syncRequested: false });
    assert.equal(readCompletion(identity(), { root: stateRoot, now: () => NOW }).status, 'complete');
  });
});
