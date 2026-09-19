import { describe, expect, it } from 'vitest';
import {
  terminalPresentation,
  vscodePresentation,
  applyOrderedProjection,
  applyStatusFailure,
} from '../../lib/session-presentation';

const running = { lifecycle: 'running' as const, generation: 4, revision: 12, editorReady: true };

describe('REQ-SESSION-010 / REQ-TERM-036: device-local terminal presentation', () => {
  it('shows ACTIVE only on the device with a connected terminal socket', () => {
    expect(terminalPresentation(running, { terminalConnected: true })).toMatchObject({ label: 'ACTIVE', color: 'green' });
    expect(terminalPresentation(running, { terminalConnected: false })).toMatchObject({ label: 'IDLE', color: 'blue' });
  });

  it('keeps both devices on the same backend lifecycle and never persists ACTIVE or IDLE', () => {
    const desktop = terminalPresentation(running, { terminalConnected: true });
    const phone = terminalPresentation(running, { terminalConnected: false });
    expect(desktop.lifecycle).toBe('running');
    expect(phone.lifecycle).toBe('running');
    expect(desktop.persistedState).toBeUndefined();
    expect(phone.persistedState).toBeUndefined();
  });

  it('keeps the mounted workspace through unreachable and countdown expiry', () => {
    const unreachable = { ...running, lifecycle: 'unreachable' as const, incidentDeadlineMs: 120_000 };
    expect(terminalPresentation(unreachable, { terminalConnected: false, nowMs: 119_999 })).toMatchObject({
      color: 'yellow', mounted: true, dispose: false,
    });
    expect(terminalPresentation(unreachable, { terminalConnected: false, nowMs: 120_001 })).toMatchObject({
      mounted: true, dispose: false, deadlineExpired: true,
    });
  });

  it('disposes only from newer authoritative stopping or stopped evidence', () => {
    expect(terminalPresentation({ ...running, lifecycle: 'stopping' as const, revision: 13 }, { terminalConnected: false }).dispose).toBe(true);
    expect(terminalPresentation({ ...running, lifecycle: 'stopped' as const, revision: 14 }, { terminalConnected: false }).dispose).toBe(true);
  });
});

describe('REQ-IDE-049: VS Code lifecycle and connectivity presentation', () => {
  it('uses yellow only for starting, green for ready running, and gray for stopped', () => {
    expect(vscodePresentation({ ...running, lifecycle: 'starting', editorReady: false }, { transportReachable: true }).indicator).toBe('yellow');
    expect(vscodePresentation(running, { transportReachable: true }).indicator).toBe('green');
    expect(vscodePresentation({ ...running, lifecycle: 'stopped' }, { transportReachable: false }).indicator).toBe('gray');
  });

  it('shows unreachable as a separate accessible notice without yellowing or unmounting the editor', () => {
    expect(vscodePresentation({ ...running, lifecycle: 'unreachable' }, { transportReachable: false })).toMatchObject({
      indicator: 'green',
      mounted: true,
      connectivityNotice: { visible: true, role: 'status' },
    });
  });
});

describe('REQ-SESSION-029: ordered projection and D1 outage retention', () => {
  it('ignores delayed generation and revision responses', () => {
    expect(applyOrderedProjection(running, { ...running, generation: 3, revision: 99, lifecycle: 'stopped' })).toEqual(running);
    expect(applyOrderedProjection(running, { ...running, revision: 11, lifecycle: 'stopped' })).toEqual(running);
    expect(applyOrderedProjection(running, { ...running, revision: 13, lifecycle: 'unreachable' })).toMatchObject({ revision: 13, lifecycle: 'unreachable' });
  });

  it('retains state and mounted workspace with a distinct status-unavailable warning', () => {
    expect(applyStatusFailure(running, new Error('D1 unavailable'))).toMatchObject({
      ...running,
      mounted: true,
      statusUnavailable: true,
    });
  });
});
