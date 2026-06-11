import { describe, it, expect } from 'vitest';
import { statusBarState } from '../scripts/status-bar-state';

describe('status-bar-state', () => {
  it('renders the running session segments in order', () => {
    const segments = statusBarState({
      sectionPath: '02-security',
      clock: '00:09:02',
      sessions: 1,
      destroyed: false,
    });

    expect(segments).toEqual(['02-security', '00:09:02', '1 session · 1 engineer', 'container:running']);
  });

  it('pluralizes sessions and appends the gateway tally when present', () => {
    const segments = statusBarState({
      sectionPath: '01-boot',
      clock: '00:00:42',
      sessions: 4,
      gwRequests: 38,
      destroyed: false,
    });

    expect(segments).toContain('4 sessions · 1 engineer');
    expect(segments).toContain('gw 38 req');
  });

  it('omits the gateway segment before any request has been attributed', () => {
    const segments = statusBarState({
      sectionPath: '01-boot',
      clock: '00:00:00',
      sessions: 1,
      destroyed: false,
    });

    expect(segments.some((segment) => segment.startsWith('gw '))).toBe(false);
  });

  it('flips to the destroyed state and back as a pure function of input', () => {
    const destroyed = statusBarState({
      sectionPath: '09-session-end',
      clock: '00:47:00',
      sessions: 0,
      destroyed: true,
    });
    expect(destroyed.at(-1)).toBe('container:destroyed · zero residue');
    expect(destroyed).toContain('0 sessions · 1 engineer');

    // Scrolling back up restores the running state — no sticky death.
    const restored = statusBarState({
      sectionPath: '02-security',
      clock: '00:09:02',
      sessions: 4,
      destroyed: false,
    });
    expect(restored.at(-1)).toBe('container:running');
  });
});
