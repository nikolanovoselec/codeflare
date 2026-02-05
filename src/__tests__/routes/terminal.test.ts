import { describe, it, expect } from 'vitest';
import { validateWebSocketRoute } from '../../routes/terminal';
import type { Env } from '../../types';

/**
 * Unit tests for the validateWebSocketRoute function.
 *
 * The full handleWebSocketUpgrade function requires a complete Worker runtime
 * (authenticateRequest, getContainer, KV) which is too coupled for unit testing.
 * We focus on the pure routing/validation logic that can be tested in isolation.
 */
describe('validateWebSocketRoute', () => {
  const mockEnv = {} as Env;

  function createRequest(path: string, headers: Record<string, string> = {}): Request {
    return new Request(`https://example.com${path}`, {
      headers: new Headers(headers),
    });
  }

  describe('valid WebSocket routes', () => {
    it('matches /api/terminal/:id/ws with Upgrade: websocket', () => {
      const request = createRequest('/api/terminal/abc123def456-1/ws', {
        Upgrade: 'websocket',
      });

      const result = validateWebSocketRoute(request, mockEnv);

      expect(result.isWebSocketRoute).toBe(true);
      expect(result.fullSessionId).toBe('abc123def456-1');
      expect(result.baseSessionId).toBe('abc123def456');
      expect(result.terminalId).toBe('1');
      expect(result.errorResponse).toBeUndefined();
    });

    it('extracts terminal IDs 1-6', () => {
      for (let i = 1; i <= 6; i++) {
        const request = createRequest(`/api/terminal/abcdef12-${i}/ws`, {
          Upgrade: 'websocket',
        });

        const result = validateWebSocketRoute(request, mockEnv);

        expect(result.isWebSocketRoute).toBe(true);
        expect(result.terminalId).toBe(String(i));
      }
    });

    it('defaults terminalId to 1 when no compound suffix', () => {
      const request = createRequest('/api/terminal/abcdef12/ws', {
        Upgrade: 'websocket',
      });

      const result = validateWebSocketRoute(request, mockEnv);

      expect(result.isWebSocketRoute).toBe(true);
      expect(result.baseSessionId).toBe('abcdef12');
      expect(result.terminalId).toBe('1');
    });

    it('handles case-insensitive Upgrade header', () => {
      const request = createRequest('/api/terminal/abcdef12-1/ws', {
        Upgrade: 'WebSocket',
      });

      const result = validateWebSocketRoute(request, mockEnv);

      expect(result.isWebSocketRoute).toBe(true);
    });
  });

  describe('non-WebSocket routes', () => {
    it('returns isWebSocketRoute false for non-matching path', () => {
      const request = createRequest('/api/sessions', {
        Upgrade: 'websocket',
      });

      const result = validateWebSocketRoute(request, mockEnv);

      expect(result.isWebSocketRoute).toBe(false);
    });

    it('returns isWebSocketRoute false for missing Upgrade header', () => {
      const request = createRequest('/api/terminal/abcdef12-1/ws');

      const result = validateWebSocketRoute(request, mockEnv);

      expect(result.isWebSocketRoute).toBe(false);
    });

    it('returns isWebSocketRoute false for non-websocket Upgrade header', () => {
      const request = createRequest('/api/terminal/abcdef12-1/ws', {
        Upgrade: 'h2c',
      });

      const result = validateWebSocketRoute(request, mockEnv);

      expect(result.isWebSocketRoute).toBe(false);
    });

    it('returns isWebSocketRoute false for matching path but no Upgrade', () => {
      const request = createRequest('/api/terminal/abcdef12-1/ws', {});

      const result = validateWebSocketRoute(request, mockEnv);

      expect(result.isWebSocketRoute).toBe(false);
    });
  });

  describe('validation errors', () => {
    it('returns 400 errorResponse for invalid session ID format', () => {
      // Session ID has uppercase chars which violate SESSION_ID_PATTERN (/^[a-z0-9]{8,24}$/)
      const request = createRequest('/api/terminal/INVALID-1/ws', {
        Upgrade: 'websocket',
      });

      const result = validateWebSocketRoute(request, mockEnv);

      expect(result.isWebSocketRoute).toBe(true);
      expect(result.errorResponse).toBeDefined();
      expect(result.errorResponse!.status).toBe(400);
    });

    it('returns 400 for session ID that is too short', () => {
      const request = createRequest('/api/terminal/abc-1/ws', {
        Upgrade: 'websocket',
      });

      const result = validateWebSocketRoute(request, mockEnv);

      expect(result.isWebSocketRoute).toBe(true);
      expect(result.errorResponse).toBeDefined();
      expect(result.errorResponse!.status).toBe(400);
    });

    it('returns 400 for session ID that is too long (over 24 chars)', () => {
      // 25-char session ID exceeds SESSION_ID_PATTERN max of 24
      const longId = 'a'.repeat(25);
      const request = createRequest(`/api/terminal/${longId}-1/ws`, {
        Upgrade: 'websocket',
      });

      const result = validateWebSocketRoute(request, mockEnv);

      expect(result.isWebSocketRoute).toBe(true);
      expect(result.errorResponse).toBeDefined();
      expect(result.errorResponse!.status).toBe(400);
    });

    it('error response body contains error message', async () => {
      const request = createRequest('/api/terminal/BAD-1/ws', {
        Upgrade: 'websocket',
      });

      const result = validateWebSocketRoute(request, mockEnv);
      const body = await result.errorResponse!.json() as { error: string };

      expect(body.error).toBe('Invalid session ID format');
    });
  });

  describe('edge cases', () => {
    it('handles path with no session ID segment', () => {
      const request = createRequest('/api/terminal//ws', {
        Upgrade: 'websocket',
      });

      const result = validateWebSocketRoute(request, mockEnv);

      // The regex won't match empty segment due to [^\/]+
      expect(result.isWebSocketRoute).toBe(false);
    });

    it('handles long session IDs (24 chars)', () => {
      const sessionId = 'a'.repeat(24);
      const request = createRequest(`/api/terminal/${sessionId}-2/ws`, {
        Upgrade: 'websocket',
      });

      const result = validateWebSocketRoute(request, mockEnv);

      expect(result.isWebSocketRoute).toBe(true);
      expect(result.baseSessionId).toBe(sessionId);
      expect(result.terminalId).toBe('2');
    });
  });
});
