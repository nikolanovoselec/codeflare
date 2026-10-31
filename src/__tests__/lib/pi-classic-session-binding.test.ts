import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import registerClassicSessionBinding, {
  adoptClassicResumedSession,
} from '../../../preseed/agents/pi/extensions/classic-session-binding';

type SessionStart = (event: { reason: string }, ctx: {
  sessionManager: {
    getSessionFile(): string | undefined;
    getSessionId(): string;
  };
  ui: { notify(message: string, level?: string): void };
}) => void;

function sessionFile(home: string, id: string, stamp: string): string {
  const directory = join(home, '.pi', 'agent', 'sessions', '--home-user-workspace--');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${stamp}_${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({
    type: 'session', version: 3, id, timestamp: '2026-09-09T00:00:00.000Z', cwd: join(home, 'workspace'),
  })}\n`);
  return path;
}

function adopt(home: string, path: string, nativeSessionId: string): boolean {
  return adoptClassicResumedSession({ reason: 'resume' }, {
    sessionManager: {
      getSessionFile: () => path,
      getSessionId: () => nativeSessionId,
    },
    ui: { notify: () => undefined },
  }, {
    HOME: home,
    SESSION_ID: 'session12345678',
    CODEFLARE_TERMINAL_MODE: 'classic',
    TERMINAL_ID: '1',
  });
}

function harness(home: string, overrides: Record<string, string | undefined> = {}) {
  let start: SessionStart | undefined;
  const observations: Partial<Record<'message_end' | 'agent_end', SessionStart>> = {};
  const notices: string[] = [];
  registerClassicSessionBinding({
    on(event, handler) {
      if (event === 'session_start') start = handler as SessionStart;
      else observations[event] = handler as SessionStart;
    },
  }, {
    HOME: home,
    SESSION_ID: 'session12345678',
    CODEFLARE_TERMINAL_MODE: 'classic',
    TERMINAL_ID: '1',
    ...overrides,
  });
  if (!start) throw new Error('session_start handler was not registered');
  const sessionStart: SessionStart = start;
  return {
    resume(path: string, nativeSessionId: string, reason = 'resume') {
      sessionStart({ reason }, {
        sessionManager: {
          getSessionFile: () => path,
          getSessionId: () => nativeSessionId,
        },
        ui: { notify: (message) => notices.push(message) },
      });
    },
    observe(event: 'message_end' | 'agent_end', path: string, nativeSessionId: string) {
      observations[event]?.({ reason: '' }, {
        sessionManager: {
          getSessionFile: () => path,
          getSessionId: () => nativeSessionId,
        },
        ui: { notify: (message) => notices.push(message) },
      });
    },
    notices,
    binding: join(home, '.codeflare', 'classic', 'sessions', 'cf-session12345678', 'agent-session-id'),
  };
}

describe('REQ-AGENT-211 AC6: Classic Pi adopts every explicit resumed transcript', () => {
  it('persists the last active transcript across repeated /resume switches', () => {
    const home = mkdtempSync(join(tmpdir(), 'classic-binding-'));
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = 'last-active.jsonl';
    const first = sessionFile(home, firstId, '2026-09-09T00-00-00-000Z');
    const second = sessionFile(home, secondId, '2026-09-09T00-01-00-000Z');
    const bindingDirectory = join(home, '.codeflare', 'classic', 'sessions', 'cf-session12345678');
    const binding = join(bindingDirectory, 'agent-session-id');

    expect(adopt(home, first, firstId)).toBe(true);
    expect(readFileSync(binding, 'utf8')).toBe(`${firstId}\n`);

    expect(adopt(home, second, secondId)).toBe(true);
    expect(readFileSync(binding, 'utf8')).toBe(`${secondId}\n`);
    expect(readdirSync(bindingDirectory)).toEqual(['agent-session-id']);
  });

  it.each(['new', 'fork'])('REQ-AGENT-211 AC6 / REQ-AGENT-224: explicit %s adoption becomes the Classic restart target', (reason) => {
    const home = mkdtempSync(join(tmpdir(), 'classic-chat-adoption-'));
    try {
      const previousId = '11111111-1111-4111-8111-111111111111';
      const adoptedId = '22222222-2222-4222-8222-222222222222';
      const previous = sessionFile(home, previousId, '2026-10-31T00-00-00-000Z');
      const adopted = sessionFile(home, adoptedId, '2026-10-31T00-01-00-000Z');
      const classic = harness(home);
      classic.resume(previous, previousId);
      expect(readFileSync(classic.binding, 'utf8')).toBe(`${previousId}\n`);

      classic.resume(adopted, adoptedId, reason);
      expect(readFileSync(classic.binding, 'utf8')).toBe(`${adoptedId}\n`);
      expect(classic.notices).toEqual([]);

      // Launcher startup is not another adoption and cannot undo the choice.
      classic.resume(previous, previousId, 'startup');
      expect(readFileSync(classic.binding, 'utf8')).toBe(`${adoptedId}\n`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(['message_end', 'agent_end'] as const)('defers empty new adoption without warnings until a native file exists at %s', (event) => {
    const home = mkdtempSync(join(tmpdir(), 'classic-binding-deferred-'));
    try {
      const previousId = 'previous';
      const nextId = 'next';
      const previous = sessionFile(home, previousId, 'previous');
      const next = join(previous, '..', `next_${nextId}.jsonl`);
      const classic = harness(home);
      classic.resume(previous, previousId);
      classic.resume(next, nextId, 'new');
      classic.observe('message_end', next, nextId);
      classic.observe('agent_end', next, nextId);
      expect(readFileSync(classic.binding, 'utf8')).toBe(`${previousId}\n`);
      expect(() => readFileSync(next, 'utf8')).toThrow();
      expect(classic.notices).toEqual([]);

      // Native persistence is represented by a file appearing, not by invoking SDK internals.
      sessionFile(home, nextId, 'next');
      classic.observe(event, next, nextId);
      expect(readFileSync(classic.binding, 'utf8')).toBe(`${nextId}\n`);
      expect(readdirSync(join(classic.binding, '..'))).toEqual(['agent-session-id']);
      expect(classic.notices).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(['changed-id', 'changed-path', 'startup', 'resume', 'new', 'fork'])('does not adopt stale pending new after %s', (transition) => {
    const home = mkdtempSync(join(tmpdir(), 'classic-binding-stale-'));
    try {
      const previous = sessionFile(home, 'previous', 'previous');
      const pending = join(previous, '..', 'pending_pending.jsonl');
      const other = sessionFile(home, 'other', 'other');
      const classic = harness(home);
      classic.resume(previous, 'previous');
      classic.resume(pending, 'pending', 'new');
      sessionFile(home, 'pending', 'pending');
      if (transition === 'changed-id' || transition === 'changed-path') {
        classic.observe('message_end', transition === 'changed-id' ? pending : other,
          transition === 'changed-id' ? 'other' : 'pending');
      } else {
        classic.resume(other, 'other', transition);
      }
      classic.observe('message_end', pending, 'pending');
      classic.observe('agent_end', pending, 'pending');
      expect(readFileSync(classic.binding, 'utf8')).toBe(
        ['resume', 'new', 'fork'].includes(transition) ? 'other\n' : 'previous\n',
      );
      expect(classic.notices).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    { CODEFLARE_TERMINAL_MODE: 'herdr' },
    { TERMINAL_ID: '2' },
    { MANUAL_TAB: '1' },
    { SESSION_ID: '../foreign' },
  ])('does not defer adoption outside the owning Classic primary: %o', (overrides) => {
    const home = mkdtempSync(join(tmpdir(), 'classic-binding-deferred-guard-'));
    try {
      const previous = sessionFile(home, 'previous', 'previous');
      const classic = harness(home);
      classic.resume(previous, 'previous');
      const guarded = harness(home, overrides);
      const next = join(previous, '..', 'next_next.jsonl');
      guarded.resume(next, 'next', 'new');
      sessionFile(home, 'next', 'next');
      guarded.observe('message_end', next, 'next');
      guarded.observe('agent_end', next, 'next');
      expect(readFileSync(classic.binding, 'utf8')).toBe('previous\n');
      expect(guarded.notices).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(['foreign', 'symlink', 'child', 'mismatched-id'])('rejects deferred %s files without changing the restart target', (kind) => {
    const home = mkdtempSync(join(tmpdir(), 'classic-binding-containment-'));
    try {
      const previous = sessionFile(home, 'previous', 'previous');
      const directory = join(previous, '..');
      const outside = join(home, 'outside_next.jsonl');
      const next = kind === 'foreign' ? outside
        : kind === 'child' ? join(directory, 'tasks', 'next_next.jsonl')
        : join(directory, kind === 'mismatched-id' ? 'next_wrong.jsonl' : 'next_next.jsonl');
      const classic = harness(home);
      classic.resume(previous, 'previous');
      classic.resume(next, 'next', 'new');
      mkdirSync(join(next, '..'), { recursive: true });
      if (kind === 'symlink') {
        writeFileSync(outside, 'native fixture\n');
        symlinkSync(outside, next);
      } else writeFileSync(next, 'native fixture\n');
      classic.observe('message_end', next, 'next');
      classic.observe('agent_end', next, 'next');
      expect(readFileSync(classic.binding, 'utf8')).toBe('previous\n');
      expect(classic.notices).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not rewrite bindings for startup, Herdr, child, or malformed sessions', () => {
    const home = mkdtempSync(join(tmpdir(), 'classic-binding-guard-'));
    const id = '33333333-3333-4333-8333-333333333333';
    const rootSession = sessionFile(home, id, '2026-09-09T00-00-00-000Z');
    const classic = harness(home);
    classic.resume(rootSession, id, 'startup');
    expect(() => readFileSync(classic.binding, 'utf8')).toThrow();

    harness(home, { CODEFLARE_TERMINAL_MODE: 'herdr' }).resume(rootSession, id);
    harness(home, { TERMINAL_ID: '2' }).resume(rootSession, id);
    harness(home, { MANUAL_TAB: '1' }).resume(rootSession, id);
    expect(() => readFileSync(classic.binding, 'utf8')).toThrow();

    const child = join(home, '.pi', 'agent', 'sessions', '--home-user-workspace--', 'tasks', `child_${id}.jsonl`);
    mkdirSync(join(child, '..'), { recursive: true });
    writeFileSync(child, `${JSON.stringify({ type: 'session', version: 3, id })}\n`);
    classic.resume(child, id);
    expect(() => readFileSync(classic.binding, 'utf8')).toThrow();

    const mismatched = sessionFile(home, id, '2026-09-09T00-02-00-000Z');
    classic.resume(mismatched, 'wrong/unsafe');
    expect(() => readFileSync(classic.binding, 'utf8')).toThrow();
  });
});
