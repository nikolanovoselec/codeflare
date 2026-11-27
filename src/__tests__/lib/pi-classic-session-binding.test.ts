import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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

const stateScript = new URL('../../../image/pi-web/classic-session-state.mjs', import.meta.url).pathname;
const homes: string[] = [];
function createHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'classic-binding-'));
  homes.push(home);
  mkdirSync(join(home, 'workspace'));
  return home;
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function sessionFile(home: string, id: string, stamp: string, header: object = {}, workspace = join(home, 'workspace')): string {
  const directory = join(home, '.pi', 'agent', 'sessions', `--${workspace.slice(1).replace(/[\\/:]/g, '-')}--`);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${stamp}_${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({
    type: 'session', version: 3, id, timestamp: '2026-09-09T00:00:00.000Z', cwd: workspace, ...header,
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
    CLASSIC_PI_STATE_SCRIPT: stateScript,
    SESSION_ID: 'session12345678',
    CODEFLARE_TERMINAL_MODE: 'classic',
    TERMINAL_ID: '1',
  });
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
    CLASSIC_PI_STATE_SCRIPT: stateScript,
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
    const home = createHome();
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = 'last-active.jsonl';
    const first = sessionFile(home, firstId, '2026-09-09T00-00-00-000Z');
    const second = sessionFile(home, secondId, '2026-09-09T00-01-00-000Z', { parentSession: first });
    const bindingDirectory = join(home, '.codeflare', 'classic', 'sessions', 'cf-session12345678');
    const binding = join(bindingDirectory, 'agent-session-id');

    expect(adopt(home, first, firstId)).toBe(true);
    expect(readFileSync(binding, 'utf8')).toBe(`${firstId}\n`);

    expect(adopt(home, second, secondId)).toBe(true);
    expect(readFileSync(binding, 'utf8')).toBe(`${secondId}\n`);
    expect(readdirSync(bindingDirectory)).toEqual(['agent-session-id']);
  });

  it('does not rewrite bindings for startup, Herdr, child, or malformed sessions', () => {
    const home = createHome();
    const id = '33333333-3333-4333-8333-333333333333';
    const rootSession = sessionFile(home, id, '2026-09-09T00-00-00-000Z');
    const classic = harness(home);
    classic.resume(rootSession, id, 'startup');
    expect(() => readFileSync(classic.binding, 'utf8')).toThrow();

    harness(home, { CODEFLARE_TERMINAL_MODE: 'herdr' }).resume(rootSession, id);
    harness(home, { TERMINAL_ID: '2' }).resume(rootSession, id);
    harness(home, { MANUAL_TAB: '1' }).resume(rootSession, id);
    harness(home, { CODEFLARE_PI_SURFACE: 'terminal' }).resume(rootSession, id);
    expect(() => readFileSync(classic.binding, 'utf8')).toThrow();

    const child = join(dirname(rootSession), 'tasks', `child_${id}.jsonl`);
    mkdirSync(join(child, '..'), { recursive: true });
    writeFileSync(child, `${JSON.stringify({ type: 'session', version: 3, id })}\n`);
    classic.resume(child, id);
    expect(() => readFileSync(classic.binding, 'utf8')).toThrow();

    const mismatched = sessionFile(home, id, '2026-09-09T00-02-00-000Z');
    classic.resume(mismatched, 'wrong/unsafe');
    expect(() => readFileSync(classic.binding, 'utf8')).toThrow();
  });

  it('keeps the previous binding when the selected native header or path is invalid or ambiguous', () => {
    const home = createHome();
    const classic = harness(home);
    classic.resume(sessionFile(home, 'original', '1'), 'original');
    const bad = [
      sessionFile(home, 'bad-id', '1', { id: 'other' }),
      sessionFile(home, 'bad-version', '1', { version: 999 }),
      sessionFile(home, 'bad-workspace', '1', { cwd: home }),
      sessionFile(home, 'bad-stamp', '1', { timestamp: 'not-a-date' }),
      sessionFile(home, 'wrong-store', '1', { cwd: join(home, 'workspace') }, join(home, 'other')),
      sessionFile(home, 'duplicate', '1'),
    ];
    sessionFile(home, 'duplicate', '2');
    for (const [i, id] of ['bad-id', 'bad-version', 'bad-workspace', 'bad-stamp', 'wrong-store', 'duplicate'].entries()) {
      classic.resume(bad[i], id);
      expect(readFileSync(classic.binding, 'utf8')).toBe('original\n');
    }
  });

  it('does not create binding directories under a redirected .codeflare ancestor', () => {
    const home = createHome();
    const native = sessionFile(home, 'selected', '1');
    const outside = join(home, 'redirected');
    mkdirSync(outside);
    symlinkSync(outside, join(home, '.codeflare'));
    const classic = harness(home);
    classic.resume(native, 'selected');
    expect(readdirSync(outside)).toEqual([]);
    expect(classic.notices).toHaveLength(1);
  });

});
