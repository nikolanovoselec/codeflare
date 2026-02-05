import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SessionSchema,
  UserResponseSchema,
  StartupStatusResponseSchema,
  CreateSessionResponseSchema,
  SessionsResponseSchema,
  InitStageSchema,
} from '../../lib/schemas';

/**
 * Integration-style tests that verify the frontend-backend contract.
 * These tests ensure that:
 * 1. Request formats match what the backend expects
 * 2. Response formats match the Zod schemas used for validation
 * 3. The contract between frontend and backend is maintained
 * 4. Runtime schemas (client.ts) stay in sync with shared schemas (schemas.ts)
 */

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import after mocking
import {
  getUser,
  getSessions,
  createSession,
  getStartupStatus,
} from '../../api/client';

describe('Frontend-Backend Contract Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Session Creation Contract
  // ==========================================================================
  describe('Session Creation Contract', () => {
    describe('Request Format', () => {
      it('should send POST to /api/sessions with JSON body', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({
            session: {
              id: 'abc123def456789012345678',
              name: 'Test Session',
              createdAt: '2024-01-15T10:30:00Z',
              lastAccessedAt: '2024-01-15T10:30:00Z',
            },
          })),
        });

        await createSession('Test Session');

        // Verify request format matches backend expectations
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/sessions',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
            body: JSON.stringify({ name: 'Test Session' }),
          })
        );
      });

      it('should handle session names with special characters', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({
            session: {
              id: 'abc123def456789012345678',
              name: 'Test "Session" with <special> & chars',
              createdAt: '2024-01-15T10:30:00Z',
              lastAccessedAt: '2024-01-15T10:30:00Z',
            },
          })),
        });

        await createSession('Test "Session" with <special> & chars');

        const call = mockFetch.mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.name).toBe('Test "Session" with <special> & chars');
      });
    });

    describe('Response Format', () => {
      it('should validate response against SessionSchema', async () => {
        // This is the exact response format the backend should return
        const backendResponse = {
          session: {
            id: 'abc123def456789012345678',
            name: 'My Session',
            createdAt: '2024-01-15T10:30:00.000Z',
            lastAccessedAt: '2024-01-15T10:30:00.000Z',
            status: 'stopped',
          },
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(backendResponse)),
        });

        const session = await createSession('My Session');

        // Verify response can be validated against SessionSchema
        expect(() => SessionSchema.parse(session)).not.toThrow();
        expect(session.id).toBe('abc123def456789012345678');
        expect(session.name).toBe('My Session');
      });

      it('should accept minimal valid session (without optional status)', async () => {
        // Backend may return session without status field
        const backendResponse = {
          session: {
            id: 'abc123def456789012345678',
            name: 'Minimal Session',
            createdAt: '2024-01-15T10:30:00Z',
            lastAccessedAt: '2024-01-15T10:30:00Z',
          },
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(backendResponse)),
        });

        const session = await createSession('Minimal Session');

        // Should still validate
        expect(() => SessionSchema.parse(session)).not.toThrow();
      });

      it('should accept session with all backend status values', async () => {
        // Backend returns 'stopped' | 'running' | 'stopping' in KV. 'initializing' and 'error' are frontend-computed states.
        const validStatuses = ['stopped', 'running', 'stopping'];

        for (const status of validStatuses) {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify({
              session: {
                id: 'abc123def456789012345678',
                name: 'Test',
                createdAt: '2024-01-15T10:30:00Z',
                lastAccessedAt: '2024-01-15T10:30:00Z',
                status,
              },
            })),
          });

          const session = await createSession('Test');
          expect(() => SessionSchema.parse(session)).not.toThrow();
        }
      });
    });
  });

  // ==========================================================================
  // Startup Status Polling Contract
  // ==========================================================================
  describe('Startup Status Polling Contract', () => {
    describe('Request Format', () => {
      it('should send GET to /api/container/startup-status with sessionId query param', async () => {
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
            },
          })),
        });

        await getStartupStatus('sessionabc123');

        expect(mockFetch).toHaveBeenCalledWith(
          '/api/container/startup-status?sessionId=sessionabc123',
          expect.objectContaining({
            headers: expect.objectContaining({ 'X-Requested-With': 'XMLHttpRequest' }),
          })
        );
      });
    });

    describe('Response Format - All Stages', () => {
      const validStages = ['creating', 'starting', 'syncing', 'mounting', 'verifying', 'ready', 'error', 'stopped'];

      it.each(validStages)('should accept "%s" as valid stage', async (stage) => {
        const response = {
          stage,
          progress: stage === 'ready' ? 100 : 50,
          message: `Container ${stage}`,
          details: {
            userId: 'user-123',
            container: 'container-abc',
            bucket: 'bucket-xyz',
            bucketName: 'my-bucket',
            path: '/workspace',
          },
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(response)),
        });

        const status = await getStartupStatus('session01234');
        expect(status.stage).toBe(stage);
      });

      it('should reject invalid stage values', async () => {
        const response = {
          stage: 'invalid-stage',
          progress: 50,
          message: 'Testing',
          details: {
            userId: 'user-123',
            container: 'container-abc',
            bucket: 'bucket-xyz',
            bucketName: 'my-bucket',
            path: '/workspace',
          },
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(response)),
        });

        await expect(getStartupStatus('session01234')).rejects.toThrow();
      });
    });

    describe('Response Format - Required Fields', () => {
      it('should require all mandatory fields in details', async () => {
        // Missing 'bucketName' which is required
        const response = {
          stage: 'ready',
          progress: 100,
          message: 'Ready',
          details: {
            userId: 'user-123',
            container: 'container-abc',
            bucket: 'bucket-xyz',
            // bucketName is missing!
            path: '/workspace',
          },
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(response)),
        });

        await expect(getStartupStatus('session01234')).rejects.toThrow();
      });

      it('should accept response with all optional fields', async () => {
        const response = {
          stage: 'ready',
          progress: 100,
          message: 'Container fully ready',
          details: {
            userId: 'user-123',
            container: 'container-abc',
            bucket: 'bucket-xyz',
            bucketName: 'my-bucket',
            path: '/workspace',
            email: 'user@example.com',
            containerStatus: 'running',
            syncStatus: 'success',
            syncError: null,
            healthServerOk: true,
            terminalServerOk: true,
            cpu: '15%',
            mem: '512MB',
            hdd: '2.5GB',
          },
          error: undefined,
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(response)),
        });

        const status = await getStartupStatus('session01234');

        expect(status.stage).toBe('ready');
        expect(status.details.email).toBe('user@example.com');
        expect(status.details.cpu).toBe('15%');
        expect(status.details.mem).toBe('512MB');
      });
    });

    describe('Response Format - Error Stage', () => {
      it('should include error field when stage is error', async () => {
        const response = {
          stage: 'error',
          progress: 0,
          message: 'Container failed to start',
          details: {
            userId: 'user-123',
            container: 'container-abc',
            bucket: 'bucket-xyz',
            bucketName: 'my-bucket',
            path: '/workspace',
          },
          error: 'Failed to pull container image',
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(response)),
        });

        const status = await getStartupStatus('session01234');

        expect(status.stage).toBe('error');
        expect(status.error).toBe('Failed to pull container image');
      });
    });
  });

  // ==========================================================================
  // User Info Contract
  // ==========================================================================
  describe('User Info Contract', () => {
    describe('Request Format', () => {
      it('should send GET to /api/user', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({
            email: 'user@example.com',
            authenticated: true,
            bucketName: 'codeflare-user-example-com',
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

    describe('Response Format', () => {
      it('should validate user response', async () => {
        const backendResponse = {
          email: 'user@example.com',
          authenticated: true,
          bucketName: 'codeflare-user-example-com',
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(backendResponse)),
        });

        const user = await getUser();

        expect(user.email).toBe('user@example.com');
        expect(user.authenticated).toBe(true);
        expect(user.bucketName).toBe('codeflare-user-example-com');
      });

      it('should reject response without required email field', async () => {
        const backendResponse = {
          authenticated: true,
          bucketName: 'codeflare-user-example-com',
          // email is missing
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(backendResponse)),
        });

        await expect(getUser()).rejects.toThrow();
      });

      it('should accept user response with role field', async () => {
        const backendResponse = {
          email: 'admin@example.com',
          authenticated: true,
          bucketName: 'codeflare-admin-example-com',
          role: 'admin',
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(backendResponse)),
        });

        const user = await getUser();
        expect(user.role).toBe('admin');
      });

      it('should accept user response without role field (backward compat)', async () => {
        const backendResponse = {
          email: 'user@example.com',
          authenticated: true,
          bucketName: 'codeflare-user-example-com',
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(backendResponse)),
        });

        const user = await getUser();
        expect(user.role).toBeUndefined();
      });
    });
  });

  // ==========================================================================
  // Sessions List Contract
  // ==========================================================================
  describe('Sessions List Contract', () => {
    describe('Request Format', () => {
      it('should send GET to /api/sessions', async () => {
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

    describe('Response Format', () => {
      it('should return array of sessions', async () => {
        const backendResponse = {
          sessions: [
            {
              id: 'session00001',
              name: 'Session 1',
              createdAt: '2024-01-15T10:00:00Z',
              lastAccessedAt: '2024-01-15T11:00:00Z',
              status: 'running',
            },
            {
              id: 'session00002',
              name: 'Session 2',
              createdAt: '2024-01-14T10:00:00Z',
              lastAccessedAt: '2024-01-14T12:00:00Z',
              status: 'stopped',
            },
          ],
        };

        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(backendResponse)),
        });

        const sessions = await getSessions();

        expect(sessions).toHaveLength(2);
        expect(sessions[0].id).toBe('session00001');
        expect(sessions[1].id).toBe('session00002');

        // Each session should validate against schema
        sessions.forEach(session => {
          expect(() => SessionSchema.parse(session)).not.toThrow();
        });
      });

      it('should handle empty sessions array', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ sessions: [] })),
        });

        const sessions = await getSessions();

        expect(sessions).toEqual([]);
      });
    });
  });

  // ==========================================================================
  // Schema Compatibility Tests
  // ==========================================================================
  describe('Schema Compatibility', () => {
    describe('SessionSchema', () => {
      it('should validate minimal session', () => {
        const minimal = {
          id: 'abc123',
          name: 'Test',
          createdAt: '2024-01-01T00:00:00Z',
          lastAccessedAt: '2024-01-01T00:00:00Z',
        };

        expect(() => SessionSchema.parse(minimal)).not.toThrow();
      });

      it('should validate session with optional status', () => {
        const withStatus = {
          id: 'abc123',
          name: 'Test',
          createdAt: '2024-01-01T00:00:00Z',
          lastAccessedAt: '2024-01-01T00:00:00Z',
          status: 'running',
        };

        expect(() => SessionSchema.parse(withStatus)).not.toThrow();
      });

      it('should reject session with invalid status', () => {
        const invalidStatus = {
          id: 'abc123',
          name: 'Test',
          createdAt: '2024-01-01T00:00:00Z',
          lastAccessedAt: '2024-01-01T00:00:00Z',
          status: 'invalid',
        };

        expect(() => SessionSchema.parse(invalidStatus)).toThrow();
      });
    });

    describe('StartupStatusResponseSchema', () => {
      it('should validate startup status with required details', () => {
        const valid = {
          stage: 'creating',
          progress: 10,
          message: 'Creating...',
          details: {
            bucketName: 'my-bucket',
            container: 'container-abc',
            path: '/workspace',
          },
        };

        expect(() => StartupStatusResponseSchema.parse(valid)).not.toThrow();
      });

      it('should validate startup status with all optional fields', () => {
        const withDetails = {
          stage: 'ready',
          progress: 100,
          message: 'Ready',
          details: {
            bucketName: 'my-bucket',
            container: 'container-abc',
            path: '/workspace',
            containerStatus: 'running',
            syncStatus: 'success',
          },
        };

        expect(() => StartupStatusResponseSchema.parse(withDetails)).not.toThrow();
      });

      it('should reject startup status without required details fields', () => {
        const missingDetails = {
          stage: 'creating',
          progress: 10,
          message: 'Creating...',
          details: {
            containerStatus: 'running',
            // missing bucketName, container, path
          },
        };

        expect(() => StartupStatusResponseSchema.parse(missingDetails)).toThrow();
      });
    });

    describe('UserResponseSchema', () => {
      it('should validate user with required fields', () => {
        const user = {
          email: 'test@example.com',
          authenticated: true,
          bucketName: 'codeflare-test-example-com',
        };

        expect(() => UserResponseSchema.parse(user)).not.toThrow();
      });

      it('should reject user without email', () => {
        const noEmail = {
          authenticated: true,
          bucketName: 'codeflare-test-example-com',
        };

        expect(() => UserResponseSchema.parse(noEmail)).toThrow();
      });

      it('should reject user without bucketName', () => {
        const noBucket = {
          email: 'test@example.com',
          authenticated: true,
        };

        expect(() => UserResponseSchema.parse(noBucket)).toThrow();
      });
    });
  });

  // ==========================================================================
  // Error Response Contract
  // ==========================================================================
  describe('Error Response Contract', () => {
    it('should handle 401 unauthorized error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      await expect(getUser()).rejects.toThrow('Unauthorized');
    });

    it('should handle 403 forbidden error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: () => Promise.resolve('Forbidden'),
      });

      await expect(getSessions()).rejects.toThrow('Forbidden');
    });

    it('should handle 404 not found error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Session not found'),
      });

      await expect(getStartupStatus('nonexistent12')).rejects.toThrow('Session not found');
    });

    it('should handle 500 server error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal server error'),
      });

      await expect(createSession('Test')).rejects.toThrow('Internal server error');
    });

    it('should handle rate limiting (429)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve('Rate limit exceeded'),
      });

      await expect(createSession('Test')).rejects.toThrow('Rate limit exceeded');
    });
  });

  // ==========================================================================
  // Runtime Schema Contract Tests
  // ==========================================================================
  // These tests validate against the ACTUAL runtime schemas from client.ts
  // (not the loose shared schemas from schemas.ts).
  // If someone changes a backend response without updating client.ts, these fail.
  // ==========================================================================
  describe('Runtime Schema Contract — UserResponseSchema', () => {
    it('should accept the exact backend /api/user response shape', () => {
      // This is the exact shape returned by src/routes/user.ts
      const backendResponse = {
        email: 'user@example.com',
        authenticated: true,
        bucketName: 'codeflare-user-example-com',
      };

      expect(() => UserResponseSchema.parse(backendResponse)).not.toThrow();
    });

    it('should reject response missing required bucketName', () => {
      const response = {
        email: 'user@example.com',
        authenticated: true,
        // bucketName missing — shared UserSchema would accept this, runtime won't
      };

      expect(() => UserResponseSchema.parse(response)).toThrow();
    });

    it('should reject response missing required email', () => {
      const response = {
        authenticated: true,
        bucketName: 'codeflare-user-example-com',
      };

      expect(() => UserResponseSchema.parse(response)).toThrow();
    });

    it('should reject response missing required authenticated', () => {
      const response = {
        email: 'user@example.com',
        bucketName: 'codeflare-user-example-com',
      };

      expect(() => UserResponseSchema.parse(response)).toThrow();
    });

    it('should accept response with role: admin', () => {
      const response = {
        email: 'admin@example.com',
        authenticated: true,
        bucketName: 'codeflare-admin-example-com',
        role: 'admin',
      };

      expect(() => UserResponseSchema.parse(response)).not.toThrow();
    });

    it('should accept response with role: user', () => {
      const response = {
        email: 'user@example.com',
        authenticated: true,
        bucketName: 'codeflare-user-example-com',
        role: 'user',
      };

      expect(() => UserResponseSchema.parse(response)).not.toThrow();
    });

    it('should reject response with invalid role value', () => {
      const response = {
        email: 'user@example.com',
        authenticated: true,
        bucketName: 'codeflare-user-example-com',
        role: 'superadmin',
      };

      expect(() => UserResponseSchema.parse(response)).toThrow();
    });
  });

  describe('Runtime Schema Contract — StartupStatusResponseSchema', () => {
    it('should accept a full backend startup-status response', () => {
      // This matches the exact shape from src/routes/container/status.ts
      const backendResponse = {
        stage: 'ready',
        progress: 100,
        message: 'Container ready (workspace synced)',
        details: {
          bucketName: 'codeflare-user-example-com',
          container: 'container-abc123def456789012345678',
          path: '/home/user/workspace',
          email: 'user@example.com',
          containerStatus: 'running',
          syncStatus: 'success',
          syncError: null,
          healthServerOk: true,
          terminalServerOk: true,
          cpu: '15%',
          mem: '512MB',
          hdd: '2.5GB',
        },
      };

      expect(() => StartupStatusResponseSchema.parse(backendResponse)).not.toThrow();
    });

    it('should accept minimal startup-status (stopped state)', () => {
      const backendResponse = {
        stage: 'stopped',
        progress: 0,
        message: 'Container not running',
        details: {
          bucketName: 'codeflare-user-example-com',
          container: 'container-abc123',
          path: '/home/user/workspace',
          email: 'user@example.com',
          containerStatus: 'stopped',
          syncStatus: 'pending',
          healthServerOk: false,
          terminalServerOk: false,
        },
      };

      expect(() => StartupStatusResponseSchema.parse(backendResponse)).not.toThrow();
    });

    it('should accept error stage with error field', () => {
      const backendResponse = {
        stage: 'error',
        progress: 0,
        message: 'R2 sync failed',
        details: {
          bucketName: '',
          container: '',
          path: '/home/user/workspace',
        },
        error: 'R2 sync failed',
      };

      expect(() => StartupStatusResponseSchema.parse(backendResponse)).not.toThrow();
    });

    it('should reject missing required details.bucketName', () => {
      const response = {
        stage: 'ready',
        progress: 100,
        message: 'Ready',
        details: {
          // bucketName missing — shared StartupStatusSchema would accept this
          container: 'container-abc',
          path: '/workspace',
        },
      };

      expect(() => StartupStatusResponseSchema.parse(response)).toThrow();
    });

    it('should reject missing required details.container', () => {
      const response = {
        stage: 'ready',
        progress: 100,
        message: 'Ready',
        details: {
          bucketName: 'my-bucket',
          // container missing
          path: '/workspace',
        },
      };

      expect(() => StartupStatusResponseSchema.parse(response)).toThrow();
    });

    it('should reject missing required details.path', () => {
      const response = {
        stage: 'ready',
        progress: 100,
        message: 'Ready',
        details: {
          bucketName: 'my-bucket',
          container: 'container-abc',
          // path missing
        },
      };

      expect(() => StartupStatusResponseSchema.parse(response)).toThrow();
    });

    it('should reject invalid stage value', () => {
      const response = {
        stage: 'unknown-stage',
        progress: 50,
        message: 'Testing',
        details: {
          bucketName: 'my-bucket',
          container: 'container-abc',
          path: '/workspace',
        },
      };

      expect(() => StartupStatusResponseSchema.parse(response)).toThrow();
    });

    it.each(['creating', 'starting', 'syncing', 'mounting', 'verifying', 'ready', 'error', 'stopped'])(
      'should accept stage "%s"',
      (stage) => {
        const response = {
          stage,
          progress: 50,
          message: `Stage: ${stage}`,
          details: {
            bucketName: 'my-bucket',
            container: 'container-abc',
            path: '/workspace',
          },
        };

        expect(() => StartupStatusResponseSchema.parse(response)).not.toThrow();
      }
    );
  });

  describe('Runtime Schema Contract — SessionsResponseSchema', () => {
    it('should accept sessions list response', () => {
      const response = {
        sessions: [
          {
            id: 'abc123def456789012345678',
            name: 'My Session',
            createdAt: '2024-01-15T10:30:00Z',
            lastAccessedAt: '2024-01-15T10:30:00Z',
            status: 'running',
          },
        ],
      };

      expect(() => SessionsResponseSchema.parse(response)).not.toThrow();
    });

    it('should accept empty sessions list', () => {
      expect(() => SessionsResponseSchema.parse({ sessions: [] })).not.toThrow();
    });
  });

  describe('Runtime Schema Contract — CreateSessionResponseSchema', () => {
    it('should accept create session response', () => {
      const response = {
        session: {
          id: 'abc123def456789012345678',
          name: 'New Session',
          createdAt: '2024-01-15T10:30:00Z',
          lastAccessedAt: '2024-01-15T10:30:00Z',
        },
      };

      expect(() => CreateSessionResponseSchema.parse(response)).not.toThrow();
    });
  });

  describe('Schema Strictness (consolidated)', () => {
    it('UserResponseSchema requires bucketName', () => {
      const noBucket = {
        email: 'user@example.com',
        authenticated: true,
      };

      expect(() => UserResponseSchema.parse(noBucket)).toThrow();
    });

    it('StartupStatusResponseSchema requires typed details fields', () => {
      const missingDetails = {
        stage: 'ready',
        progress: 100,
        message: 'Ready',
        details: {
          randomField: 'value',
          // missing bucketName, container, path
        },
      };

      expect(() => StartupStatusResponseSchema.parse(missingDetails)).toThrow();
    });

    it('InitStageSchema enforces valid enum values', () => {
      expect(() => InitStageSchema.parse('banana')).toThrow();
      expect(() => InitStageSchema.parse('ready')).not.toThrow();
    });
  });
});
