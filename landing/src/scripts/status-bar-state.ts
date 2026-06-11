/**
 * Pure state for the fixed bottom status bar. Segments derive entirely from
 * scroll-derived input, so the bar (including the destroy finale) is a pure
 * function of page position — deep links land coherent and scrolling back
 * up always restores the running state.
 */
export interface StatusBarInput {
  /** Active prompt path segment, e.g. '02-security'. */
  sectionPath: string;
  /** Session clock readout from sessionClock(). */
  clock: string;
  /** Live session count (1 before the split, 4 after, 0 destroyed). */
  sessions: number;
  /** Attributed gateway requests; omitted until the transcript commits them. */
  gwRequests?: number;
  destroyed: boolean;
}

export function statusBarState(input: StatusBarInput): string[] {
  const sessionsLabel = `${input.sessions} ${input.sessions === 1 ? 'session' : 'sessions'} · 1 engineer`;

  const segments = [input.sectionPath, input.clock, sessionsLabel];
  if (input.gwRequests !== undefined) {
    segments.push(`gw ${input.gwRequests} req`);
  }
  segments.push(input.destroyed ? 'container:destroyed · zero residue' : 'container:running');
  return segments;
}
