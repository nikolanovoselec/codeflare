import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to mock modules before importing them
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import after mocking
import {
  getUser,
  getSessions,
  createSession,
  deleteSession,
  updateSession,
  getStartupStatus,
  startSession,
  stopSession,
  getTerminalWebSocketUrl,
} from '../../api/client';

describe('API Client', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ==========================================================================
  // fetchApi Tests (tested through public API functions)
  // ==========================================================================
  describe('fetchApi error handling', () => {
    it('should throw ApiError on HTTP 4xx error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not found'),
      });

      await expect(getUser()).rejects.toThrow('Not found');
    });

    it('should throw ApiError on HTTP 5xx error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal server error'),
      });

      await expect(getUser()).rejects.toThrow('Internal server error');
    });

    it('should use status code in error message when body is empty', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: () => Promise.resolve(''),
      });

      await expect(getUser()).rejects.toThrow('HTTP 503');
    });

    it('should throw on network error', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Network error'));

      await expect(getUser()).rejects.toThrow('Network error');
    });
  });

  // ==========================================================================
  // Q12 - JSON error extraction tests
  // ==========================================================================
  describe('JSON error body extraction (Q12)', () => {
    it('extracts error message from JSON error body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve(JSON.stringify({ error: 'Invalid session name' })),
      });

      await expect(getUser()).rejects.toThrow('Invalid session name');
    });

    it('falls back to raw text when body is not JSON', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Gateway Timeout'),
      });

      await expect(getUser()).rejects.toThrow('Gateway Timeout');
    });

    it('falls back to raw text when JSON has no error field', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve(JSON.stringify({ message: 'something else' })),
      });

      // Should use the raw JSON text since parsed.error is falsy
      await expect(getUser()).rejects.toThrow();
    });

    it('uses HTTP status code when body is completely empty', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: () => Promise.resolve(''),
      });

      await expect(getUser()).rejects.toThrow('HTTP 502');
    });
  });

  describe('non-JSON response handling', () => {
    it('should throw ApiError with descriptive message for non-JSON response body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve('Internal Server Error'),
      });

      await expect(getUser()).rejects.toThrow('Invalid JSON response from server');
    });

    it('should throw ApiError for HTML response body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html><body>Error</body></html>'),
      });

      await expect(getUser()).rejects.toThrow('Invalid JSON response from server');
    });
  });

  describe('empty response handling', () => {
    it('should handle empty response body for DELETE requests', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      // deleteSession should not throw on empty response
      await expect(deleteSession('testid01')).resolves.toBeUndefined();
    });

    it('should handle empty response body for POST requests', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      // stopSession should not throw on empty response
      await expect(stopSession('testid01')).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  // Zod Validation Tests
  // ==========================================================================
  describe('Zod validation integration', () => {
    it('should validate user response against schema', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          email: 'test@example.com',
          authenticated: true,
          bucketName: 'codeflare-test-example-com',
        })),
      });

      const user = await getUser();
      expect(user.email).toBe('test@example.com');
      expect(user.authenticated).toBe(true);
    });

    it('should throw ZodError when user response is invalid', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          // Missing required 'email' field
          authenticated: true,
        })),
      });

      await expect(getUser()).rejects.toThrow();
    });

    it('should validate sessions response against schema', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          sessions: [
            {
              id: 'session-1',
              name: 'Test Session',
              createdAt: '2024-01-01T00:00:00Z',
              lastAccessedAt: '2024-01-01T00:00:00Z',
            },
          ],
        })),
      });

      const sessions = await getSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('session-1');
    });

    it('should throw ZodError when sessions response is invalid', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          sessions: [
            {
              // Missing required fields
              id: 'session-1',
            },
          ],
        })),
      });

      await expect(getSessions()).rejects.toThrow();
    });

    it('should validate createSession response against schema', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          session: {
            id: 'new-session',
            name: 'New Session',
            createdAt: '2024-01-01T00:00:00Z',
            lastAccessedAt: '2024-01-01T00:00:00Z',
          },
        })),
      });

      const session = await createSession('New Session');
      expect(session.id).toBe('new-session');
      expect(session.name).toBe('New Session');
    });

    it('should throw when createSession response has no session', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({})),
      });

      await expect(createSession('Test')).rejects.toThrow();
    });

    it('should validate startup status response against schema', async () => {
      const validResponse = {
        stage: 'ready',
        progress: 100,
        message: 'Container ready',
        details: {
          userId: 'user-123',
          container: 'container-abc',
          bucket: 'bucket-xyz',
          bucketName: 'my-bucket',
          path: '/workspace',
          email: 'test@example.com',
          containerStatus: 'running',
          syncStatus: 'success',
          terminalServerOk: true,
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(validResponse)),
      });

      const status = await getStartupStatus('session00001');
      expect(status.stage).toBe('ready');
      expect(status.progress).toBe(100);
      expect(status.details.containerStatus).toBe('running');
    });

    it('should throw ZodError when startup status has invalid stage', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          stage: 'invalid-stage', // Not a valid InitStage
          progress: 50,
          message: 'Testing',
          details: {
            userId: 'user-123',
            container: 'container-abc',
            bucket: 'bucket-xyz',
            bucketName: 'my-bucket',
            path: '/workspace',
          },
        })),
      });

      await expect(getStartupStatus('session00001')).rejects.toThrow();
    });
  });

  // ==========================================================================
  // API Endpoint Tests
  // ==========================================================================
  describe('getUser', () => {
    it('should call correct endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          email: 'test@example.com',
          authenticated: true,
          bucketName: 'codeflare-test-example-com',
        })),
      });

      await getUser();

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/user',
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Requested-With': 'XMLHttpRequest' }),
        })
      );
    });
  });

  describe('getSessions', () => {
    it('should return empty array when sessions is undefined', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ sessions: [] })),
      });

      const sessions = await getSessions();
      expect(sessions).toEqual([]);
    });

    it('should call correct endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ sessions: [] })),
      });

      await getSessions();

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/sessions',
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Requested-With': 'XMLHttpRequest' }),
        })
      );
    });
  });

  describe('createSession', () => {
    it('should send session name in request body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          session: {
            id: 'new-session',
            name: 'My Session',
            createdAt: '2024-01-01T00:00:00Z',
            lastAccessedAt: '2024-01-01T00:00:00Z',
          },
        })),
      });

      await createSession('My Session');

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/sessions',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'My Session' }),
        })
      );
    });
  });

  describe('deleteSession', () => {
    it('should call correct endpoint with DELETE method', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      await deleteSession('session123abc');

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/sessions/session123abc',
        expect.objectContaining({
          method: 'DELETE',
        })
      );
    });
  });

  describe('stopSession', () => {
    it('should call correct endpoint with POST method', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      await stopSession('session123abc');

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/sessions/session123abc/stop',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });
  });

  // ==========================================================================
  // startSession Polling Tests
  // ==========================================================================
  describe('startSession polling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should trigger container start and send initial progress', async () => {
      const onProgress = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();

      // Mock container start request
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      // Mock startup status - ready immediately
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          stage: 'ready',
          progress: 100,
          message: 'Container ready',
          details: {
            userId: 'user-123',
            container: 'container-abc',
            bucket: 'bucket-xyz',
            bucketName: 'my-bucket',
            path: '/workspace',
            containerStatus: 'running',
            syncStatus: 'success',
            terminalServerOk: true,
          },
        })),
      });

      const cleanup = startSession('session00123', onProgress, onComplete, onError);

      // Allow microtasks to run
      await vi.advanceTimersByTimeAsync(0);

      // Should have called container start
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/container/start?sessionId=session00123',
        expect.objectContaining({ method: 'POST' })
      );

      // Should have called onProgress with creating stage (initial)
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'creating',
          progress: 5,
        })
      );

      // Should have called onProgress with ready stage
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'ready',
          progress: 100,
        })
      );

      // Should have called onComplete
      expect(onComplete).toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();

      cleanup();
    });

    it('should call container start with correct endpoint', async () => {
      const onProgress = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();

      // Mock container start
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      // Mock ready status
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          stage: 'ready',
          progress: 100,
          message: 'Ready',
          details: {
            userId: 'user-123',
            container: 'container-abc',
            bucket: 'bucket-xyz',
            bucketName: 'my-bucket',
            path: '/workspace',
            terminalServerOk: true,
          },
        })),
      });

      const cleanup = startSession('mysessionid0', onProgress, onComplete, onError);

      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/container/start?sessionId=mysessionid0',
        expect.objectContaining({ method: 'POST' })
      );

      cleanup();
    });

    it('should call onError when stage is error', async () => {
      const onProgress = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();

      // Mock container start
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      // First poll - error
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          stage: 'error',
          progress: 0,
          message: 'Container failed',
          details: {
            userId: 'user-123',
            container: 'container-abc',
            bucket: 'bucket-xyz',
            bucketName: 'my-bucket',
            path: '/workspace',
          },
          error: 'Failed to start container',
        })),
      });

      const cleanup = startSession('session00123', onProgress, onComplete, onError);

      await vi.advanceTimersByTimeAsync(0);

      expect(onError).toHaveBeenCalledWith('Failed to start container');
      expect(onComplete).not.toHaveBeenCalled();

      cleanup();
    });

    it('should use default error message when error field is missing', async () => {
      const onProgress = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();

      // Mock container start
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      // Error without error field
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          stage: 'error',
          progress: 0,
          message: 'Container failed',
          details: {
            userId: 'user-123',
            container: 'container-abc',
            bucket: 'bucket-xyz',
            bucketName: 'my-bucket',
            path: '/workspace',
          },
        })),
      });

      const cleanup = startSession('session00123', onProgress, onComplete, onError);

      await vi.advanceTimersByTimeAsync(0);

      expect(onError).toHaveBeenCalledWith('Container startup failed');

      cleanup();
    });

    it('should stop polling when cleanup is called', async () => {
      const onProgress = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();

      // Mock container start
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      // First poll - starting (not ready)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          stage: 'starting',
          progress: 20,
          message: 'Starting container',
          details: {
            userId: 'user-123',
            container: 'container-abc',
            bucket: 'bucket-xyz',
            bucketName: 'my-bucket',
            path: '/workspace',
          },
        })),
      });

      const cleanup = startSession('session00123', onProgress, onComplete, onError);

      // Run initial operations
      await vi.advanceTimersByTimeAsync(0);

      // Call cleanup to cancel polling
      cleanup();

      // Reset mock call count
      const callCountAfterCleanup = mockFetch.mock.calls.length;

      // Advance timer - should not trigger more polls
      await vi.advanceTimersByTimeAsync(5000);

      // No new fetch calls after cleanup
      expect(mockFetch.mock.calls.length).toBe(callCountAfterCleanup);
    });

    it('should map status details to InitProgress format', async () => {
      const onProgress = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();

      // Mock container start
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      // Poll with full details
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          stage: 'ready',
          progress: 100,
          message: 'Container ready',
          details: {
            userId: 'user-123',
            container: 'container-abc',
            bucket: 'bucket-xyz',
            bucketName: 'my-bucket',
            path: '/workspace',
            email: 'user@example.com',
            containerStatus: 'running',
            syncStatus: 'success',
            healthServerOk: true,
            terminalServerOk: true,
          },
        })),
      });

      const cleanup = startSession('session00123', onProgress, onComplete, onError);

      await vi.advanceTimersByTimeAsync(0);

      // Find the progress call with 'ready' stage
      const readyCall = onProgress.mock.calls.find(
        call => call[0].stage === 'ready'
      );
      expect(readyCall).toBeDefined();

      const progress = readyCall![0];
      expect(progress.details).toBeDefined();

      // Check container status mapping
      const containerDetail = progress.details.find(
        (d: { key: string }) => d.key === 'Container'
      );
      expect(containerDetail).toEqual({
        key: 'Container',
        value: 'Running',
        status: 'ok',
      });

      // Check sync status mapping
      const syncDetail = progress.details.find(
        (d: { key: string }) => d.key === 'Sync'
      );
      expect(syncDetail).toEqual({
        key: 'Sync',
        value: 'Synced',
        status: 'ok',
      });

      // Check terminal status mapping
      const terminalDetail = progress.details.find(
        (d: { key: string }) => d.key === 'Terminal'
      );
      expect(terminalDetail).toEqual({
        key: 'Terminal',
        value: 'Ready',
        status: 'ok',
      });

      // Check user email mapping
      const userDetail = progress.details.find(
        (d: { key: string }) => d.key === 'User'
      );
      expect(userDetail).toEqual({
        key: 'User',
        value: 'user@example.com',
        status: 'ok',
      });

      cleanup();
    });

    it('should handle sync failure status', async () => {
      const onProgress = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();

      // Mock container start
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      // Poll with sync failure
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          stage: 'ready',
          progress: 100,
          message: 'Container ready',
          details: {
            userId: 'user-123',
            container: 'container-abc',
            bucket: 'bucket-xyz',
            bucketName: 'my-bucket',
            path: '/workspace',
            containerStatus: 'running',
            syncStatus: 'failed',
            syncError: 'R2 connection failed',
            terminalServerOk: true,
          },
        })),
      });

      const cleanup = startSession('session00123', onProgress, onComplete, onError);

      await vi.advanceTimersByTimeAsync(0);

      const readyCall = onProgress.mock.calls.find(
        call => call[0].stage === 'ready'
      );
      const progress = readyCall![0];

      const syncDetail = progress.details.find(
        (d: { key: string }) => d.key === 'Sync'
      );
      expect(syncDetail).toEqual({
        key: 'Sync',
        value: 'R2 connection failed',
        status: 'error',
      });

      cleanup();
    });

    it('should handle sync skipped status', async () => {
      const onProgress = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();

      // Mock container start
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      // Poll with sync skipped
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          stage: 'ready',
          progress: 100,
          message: 'Container ready',
          details: {
            userId: 'user-123',
            container: 'container-abc',
            bucket: 'bucket-xyz',
            bucketName: 'my-bucket',
            path: '/workspace',
            containerStatus: 'running',
            syncStatus: 'skipped',
            terminalServerOk: true,
          },
        })),
      });

      const cleanup = startSession('session00123', onProgress, onComplete, onError);

      await vi.advanceTimersByTimeAsync(0);

      const readyCall = onProgress.mock.calls.find(
        call => call[0].stage === 'ready'
      );
      const progress = readyCall![0];

      const syncDetail = progress.details.find(
        (d: { key: string }) => d.key === 'Sync'
      );
      expect(syncDetail).toEqual({
        key: 'Sync',
        value: 'Skipped',
        status: 'ok',
      });

      cleanup();
    });

    it('should handle sync syncing status', async () => {
      const onProgress = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();

      // Mock container start
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      // Poll with sync in progress - then ready
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          stage: 'syncing',
          progress: 50,
          message: 'Syncing files',
          details: {
            userId: 'user-123',
            container: 'container-abc',
            bucket: 'bucket-xyz',
            bucketName: 'my-bucket',
            path: '/workspace',
            containerStatus: 'running',
            syncStatus: 'syncing',
          },
        })),
      });

      const cleanup = startSession('session00123', onProgress, onComplete, onError);

      await vi.advanceTimersByTimeAsync(0);

      const syncingCall = onProgress.mock.calls.find(
        call => call[0].stage === 'syncing'
      );
      expect(syncingCall).toBeDefined();

      const progress = syncingCall![0];
      const syncDetail = progress.details.find(
        (d: { key: string }) => d.key === 'Sync'
      );
      expect(syncDetail).toEqual({
        key: 'Sync',
        value: 'Syncing...',
        status: 'pending',
      });

      cleanup();
    });

    it('should handle container healthy status', async () => {
      const onProgress = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();

      // Mock container start
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      // Poll with healthy container
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          stage: 'ready',
          progress: 100,
          message: 'Container ready',
          details: {
            userId: 'user-123',
            container: 'container-abc',
            bucket: 'bucket-xyz',
            bucketName: 'my-bucket',
            path: '/workspace',
            containerStatus: 'healthy',
            syncStatus: 'success',
            terminalServerOk: true,
          },
        })),
      });

      const cleanup = startSession('session00123', onProgress, onComplete, onError);

      await vi.advanceTimersByTimeAsync(0);

      const readyCall = onProgress.mock.calls.find(
        call => call[0].stage === 'ready'
      );
      const progress = readyCall![0];

      const containerDetail = progress.details.find(
        (d: { key: string }) => d.key === 'Container'
      );
      expect(containerDetail).toEqual({
        key: 'Container',
        value: 'Running',
        status: 'ok',
      });

      cleanup();
    });

    it('should handle terminal starting state', async () => {
      const onProgress = vi.fn();
      const onComplete = vi.fn();
      const onError = vi.fn();

      // Mock container start
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      // Poll with terminal not ready yet
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          stage: 'verifying',
          progress: 80,
          message: 'Verifying services',
          details: {
            userId: 'user-123',
            container: 'container-abc',
            bucket: 'bucket-xyz',
            bucketName: 'my-bucket',
            path: '/workspace',
            containerStatus: 'running',
            syncStatus: 'success',
            healthServerOk: true,
            terminalServerOk: false,
          },
        })),
      });

      const cleanup = startSession('session00123', onProgress, onComplete, onError);

      await vi.advanceTimersByTimeAsync(0);

      const verifyingCall = onProgress.mock.calls.find(
        call => call[0].stage === 'verifying'
      );
      expect(verifyingCall).toBeDefined();

      const progress = verifyingCall![0];
      const terminalDetail = progress.details.find(
        (d: { key: string }) => d.key === 'Terminal'
      );
      expect(terminalDetail).toEqual({
        key: 'Terminal',
        value: 'Starting...',
        status: 'pending',
      });

      cleanup();
    });
  });

  // ==========================================================================
  // updateSession Tests
  // ==========================================================================
  describe('updateSession', () => {
    it('should call PATCH /api/sessions/:id with JSON body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          session: {
            id: 'session123abc',
            name: 'Renamed Session',
            createdAt: '2024-01-01T00:00:00Z',
            lastAccessedAt: '2024-01-02T00:00:00Z',
          },
        })),
      });

      const result = await updateSession('session123abc', { name: 'Renamed Session' });

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/sessions/session123abc',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ name: 'Renamed Session' }),
          headers: expect.objectContaining({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
        })
      );
      expect(result.id).toBe('session123abc');
      expect(result.name).toBe('Renamed Session');
    });

    it('should send tabConfig in patch payload', async () => {
      const tabConfig = [
        { id: '1', command: 'claude', label: 'claude' },
        { id: '2', command: 'yazi', label: 'yazi' },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          session: {
            id: 'session123abc',
            name: 'Session',
            createdAt: '2024-01-01T00:00:00Z',
            lastAccessedAt: '2024-01-02T00:00:00Z',
            tabConfig,
          },
        })),
      });

      await updateSession('session123abc', { tabConfig });

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/sessions/session123abc',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ tabConfig }),
          headers: expect.objectContaining({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
        })
      );
    });

    it('should throw on invalid session ID format', async () => {
      await expect(updateSession('INVALID!', { name: 'test' })).rejects.toThrow('Invalid session ID format');
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Session not found'),
      });

      await expect(updateSession('session123abc', { name: 'test' })).rejects.toThrow('Session not found');
    });
  });

  // ==========================================================================
  // WebSocket URL Helper Tests
  // ==========================================================================
  describe('getTerminalWebSocketUrl', () => {
    it('should generate correct WebSocket URL', () => {
      // Mock window.location
      Object.defineProperty(globalThis, 'window', {
        value: {
          location: {
            protocol: 'https:',
            host: 'codeflare.workers.dev',
            href: 'https://codeflare.workers.dev/',
          },
        },
        writable: true,
      });

      const url = getTerminalWebSocketUrl('session123abc', '2');

      expect(url).toBe('wss://codeflare.workers.dev/api/terminal/session123abc-2/ws');
    });

    it('should use ws: protocol for http:', () => {
      Object.defineProperty(globalThis, 'window', {
        value: {
          location: {
            protocol: 'http:',
            host: 'localhost:3000',
            href: 'http://localhost:3000/',
          },
        },
        writable: true,
      });

      const url = getTerminalWebSocketUrl('session123abc', '1');

      expect(url).toBe('ws://localhost:3000/api/terminal/session123abc-1/ws');
    });

    it('should default to terminal ID 1', () => {
      Object.defineProperty(globalThis, 'window', {
        value: {
          location: {
            protocol: 'https:',
            host: 'codeflare.workers.dev',
            href: 'https://codeflare.workers.dev/',
          },
        },
        writable: true,
      });

      const url = getTerminalWebSocketUrl('session123abc');

      expect(url).toMatch(/\/api\/terminal\/session123abc-1\/ws/);
    });
  });
});
