/**
 * Behavioral tests for `validateWebSocketRoute` — the WS-upgrade entry point.
 *
 * Replaces the text-matching audits in `host/__audits__/terminal-compound-key.audit.js`
 * for the parts that the Worker can exercise directly (REQ-TERM-001 AC2/3/6 routing,
 * REQ-TERM-002 AC1 URL pattern). Host-side PTY env wiring (REQ-TERM-002 AC3..AC7)
 * lives inside the container process and is covered by container-process audits
 * separately; this file replaces the route-parsing portion with real Request calls.
 *
 * Each test passes only if `validateWebSocketRoute` actually parses the URL
 * the way the spec describes. Deleting or renaming the compound-key parser
 * (or the SESSION_ID_PATTERN check) makes the matching tests fail at the
 * function boundary, not via regex on the source.
 */
import { describe, it, expect } from 'vitest';
import { validateWebSocketRoute } from '../../routes/terminal';

function wsRequest(path: string, upgrade: string | null = 'websocket'): Request {
  const headers: Record<string, string> = {};
  if (upgrade !== null) headers['Upgrade'] = upgrade;
  return new Request(`https://test.workers.dev${path}`, { headers });
}

describe('REQ-TERM-002 AC1: WS URL pattern /api/terminal/{sessionId}-{terminalId}/ws', () => {
  it('REQ-TERM-002 AC1: matches /api/terminal/{sessionId}/ws with Upgrade: websocket', () => {
    const result = validateWebSocketRoute(wsRequest('/api/terminal/abcdef1234567890abcdef12-1/ws'));
    expect(result.isWebSocketRoute).toBe(true);
    expect(result.errorResponse).toBeUndefined();
  });

  it('REQ-TERM-002 AC1: returns isWebSocketRoute=false when path does not match', () => {
    const result = validateWebSocketRoute(wsRequest('/api/terminal/abcdef1234567890abcdef12'));
    expect(result.isWebSocketRoute).toBe(false);
  });

  it('REQ-TERM-002 AC1: returns isWebSocketRoute=false when Upgrade header is missing', () => {
    const result = validateWebSocketRoute(wsRequest('/api/terminal/abc12345-1/ws', null));
    expect(result.isWebSocketRoute).toBe(false);
  });

  it('REQ-TERM-002 AC1: returns isWebSocketRoute=false for non-WebSocket Upgrade (e.g. h2c)', () => {
    const result = validateWebSocketRoute(wsRequest('/api/terminal/abc12345-1/ws', 'h2c'));
    expect(result.isWebSocketRoute).toBe(false);
  });

  it('REQ-TERM-002 AC1: Upgrade header is case-insensitive', () => {
    const result = validateWebSocketRoute(wsRequest('/api/terminal/abc12345-1/ws', 'WebSocket'));
    expect(result.isWebSocketRoute).toBe(true);
  });
});

describe('REQ-TERM-001 AC2: compound key {baseSession}-{terminalId} parsed from URL', () => {
  it('REQ-TERM-001 AC2: terminal IDs 1..6 are extracted into terminalId', () => {
    for (const tid of ['1', '2', '3', '4', '5', '6']) {
      const result = validateWebSocketRoute(wsRequest(`/api/terminal/abc12345-${tid}/ws`));
      expect(result.isWebSocketRoute, `tid=${tid}`).toBe(true);
      expect(result.terminalId, `tid=${tid}`).toBe(tid);
      expect(result.baseSessionId, `tid=${tid}`).toBe('abc12345');
      expect(result.fullSessionId, `tid=${tid}`).toBe(`abc12345-${tid}`);
    }
  });

  it('REQ-TERM-001 AC2: terminal ID 7 is NOT matched as suffix (defaults to terminalId="1" + full as base)', () => {
    // Production regex is `[1-6]`, so `abc12345-7` does not compound-match and
    // baseSessionId falls back to the full string, then SESSION_ID_PATTERN rejects
    // because it contains '-7' (the hyphen).
    const result = validateWebSocketRoute(wsRequest('/api/terminal/abc12345-7/ws'));
    expect(result.isWebSocketRoute).toBe(true);
    expect(result.errorResponse?.status).toBe(400);
  });

  it('REQ-TERM-001 AC2: terminal ID 0 is NOT matched as suffix', () => {
    const result = validateWebSocketRoute(wsRequest('/api/terminal/abc12345-0/ws'));
    expect(result.isWebSocketRoute).toBe(true);
    expect(result.errorResponse?.status).toBe(400);
  });

  it('REQ-TERM-001 AC2: sessionId without compound suffix defaults terminalId to "1"', () => {
    const result = validateWebSocketRoute(wsRequest('/api/terminal/abcdef1234567890abcdef12/ws'));
    expect(result.isWebSocketRoute).toBe(true);
    expect(result.terminalId).toBe('1');
    expect(result.baseSessionId).toBe('abcdef1234567890abcdef12');
    expect(result.fullSessionId).toBe('abcdef1234567890abcdef12');
  });
});

describe('REQ-TERM-001 AC3: baseSessionId is validated against SESSION_ID_PATTERN', () => {
  it('REQ-TERM-001 AC3: returns 400 INVALID_SESSION when baseSessionId is uppercase', async () => {
    const result = validateWebSocketRoute(wsRequest('/api/terminal/ABCDEF12-1/ws'));
    expect(result.isWebSocketRoute).toBe(true);
    expect(result.errorResponse).toBeDefined();
    expect(result.errorResponse!.status).toBe(400);
    const body = await result.errorResponse!.json() as { error: string; code: string };
    expect(body.code).toBe('INVALID_SESSION');
  });

  it('REQ-TERM-001 AC3: returns 400 when baseSessionId is too short (<8 chars)', () => {
    const result = validateWebSocketRoute(wsRequest('/api/terminal/short-1/ws'));
    expect(result.isWebSocketRoute).toBe(true);
    expect(result.errorResponse?.status).toBe(400);
  });

  it('REQ-TERM-001 AC3: returns 400 when baseSessionId is too long (>24 chars)', () => {
    const tooLong = 'a'.repeat(25);
    const result = validateWebSocketRoute(wsRequest(`/api/terminal/${tooLong}-1/ws`));
    expect(result.isWebSocketRoute).toBe(true);
    expect(result.errorResponse?.status).toBe(400);
  });

  it('REQ-TERM-001 AC3: returns 400 when baseSessionId contains non-alphanumeric chars', () => {
    const result = validateWebSocketRoute(wsRequest('/api/terminal/abc_def123-1/ws'));
    expect(result.isWebSocketRoute).toBe(true);
    expect(result.errorResponse?.status).toBe(400);
  });

  it('REQ-TERM-001 AC3: accepts the minimum 8-char base sessionId', () => {
    const result = validateWebSocketRoute(wsRequest('/api/terminal/abcdef12-1/ws'));
    expect(result.isWebSocketRoute).toBe(true);
    expect(result.errorResponse).toBeUndefined();
    expect(result.baseSessionId).toBe('abcdef12');
  });

  it('REQ-TERM-001 AC3: accepts the maximum 24-char base sessionId', () => {
    const max = 'a'.repeat(24);
    const result = validateWebSocketRoute(wsRequest(`/api/terminal/${max}-1/ws`));
    expect(result.isWebSocketRoute).toBe(true);
    expect(result.errorResponse).toBeUndefined();
    expect(result.baseSessionId).toBe(max);
  });
});
