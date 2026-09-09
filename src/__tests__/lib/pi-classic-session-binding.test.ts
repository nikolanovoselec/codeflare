import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import registerClassicSessionBinding from '../../../preseed/agents/pi/extensions/classic-session-binding';

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

function harness(home: string, overrides: Record<string, string> = {}) {
  let start: SessionStart | undefined;
  const notices: string[] = [];
  registerClassicSessionBinding({
    on(event, handler) {
      if (event === 'session_start') start = handler as SessionStart;
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
    notices,
    binding: join(home, '.codeflare', 'classic', 'sessions', 'cf-session12345678', 'agent-session-id'),
  };
}

describe('REQ-AGENT-211 AC6: Classic Pi adopts every explicit resumed transcript', () => {
  it('persists the last active transcript across repeated /resume switches', () => {
    const home = mkdtempSync(join(tmpdir(), 'classic-binding-'));
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = 'last-active.session';
    const first = sessionFile(home, firstId, '2026-09-09T00-00-00-000Z');
    const second = sessionFile(home, secondId, '2026-09-09T00-01-00-000Z');
    const runtime = harness(home);

    runtime.resume(first, firstId);
    expect(readFileSync(runtime.binding, 'utf8')).toBe(`${firstId}\n`);

    runtime.resume(second, secondId);
    expect(readFileSync(runtime.binding, 'utf8')).toBe(`${secondId}\n`);
    expect(readdirSync(join(home, '.codeflare', 'classic', 'sessions', 'cf-session12345678')))
      .toEqual(['agent-session-id']);
    expect(runtime.notices).toEqual([]);
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
