import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to import fresh each time to reset store state
let setupStore: typeof import('../../stores/setup').setupStore;

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

/**
 * Build a Response whose body is NDJSON (newline-delimited JSON).
 * Each argument becomes one JSON line.  The final line is always the
 * "done" summary that `configure()` looks for.
 */
function ndjsonResponse(...lines: Record<string, unknown>[]): Response {
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

describe('Setup Store', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Reset fetch mock
    mockFetch.mockReset();

    // Re-import to get fresh store state
    const module = await import('../../stores/setup');
    setupStore = module.setupStore;
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('initial state', () => {
    it('should start at step 1', () => {
      expect(setupStore.step).toBe(1);
    });

    it('should have tokenDetected as false', () => {
      expect(setupStore.tokenDetected).toBe(false);
    });

    it('should have tokenDetecting as false', () => {
      expect(setupStore.tokenDetecting).toBe(false);
    });

    it('should have no token detect error', () => {
      expect(setupStore.tokenDetectError).toBeNull();
    });

    it('should have no account info', () => {
      expect(setupStore.accountInfo).toBeNull();
    });

    it('should have empty custom domain', () => {
      expect(setupStore.customDomain).toBe('');
    });

    it('should have no custom domain error', () => {
      expect(setupStore.customDomainError).toBeNull();
    });

    it('should have empty allowedUsers', () => {
      expect(setupStore.allowedUsers).toEqual([]);
    });

    it('should not be configuring', () => {
      expect(setupStore.configuring).toBe(false);
    });

    it('should have empty configureSteps', () => {
      expect(setupStore.configureSteps).toEqual([]);
    });

    it('should have no configure error', () => {
      expect(setupStore.configureError).toBeNull();
    });

    it('should have setup not complete', () => {
      expect(setupStore.setupComplete).toBe(false);
    });

    it('should have no customDomainUrl', () => {
      expect(setupStore.customDomainUrl).toBeNull();
    });

    it('should have no accountId', () => {
      expect(setupStore.accountId).toBeNull();
    });
  });

  describe('detectToken', () => {
    it('should call GET /api/setup/detect-token', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ detected: true, valid: true, account: { id: '123', name: 'Test' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await setupStore.detectToken();

      expect(mockFetch).toHaveBeenCalledWith('/api/setup/detect-token', expect.objectContaining({
        headers: expect.objectContaining({ 'X-Requested-With': 'XMLHttpRequest' }),
      }));
    });

    it('should set tokenDetecting during detection', async () => {
      let resolvePromise: (value: Response) => void;
      mockFetch.mockReturnValue(
        new Promise((resolve) => {
          resolvePromise = resolve;
        })
      );

      const detectPromise = setupStore.detectToken();

      expect(setupStore.tokenDetecting).toBe(true);

      resolvePromise!(
        new Response(
          JSON.stringify({ detected: true, valid: true, account: { id: '123', name: 'Test' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await detectPromise;

      expect(setupStore.tokenDetecting).toBe(false);
    });

    it('should set tokenDetected and accountInfo on success', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            detected: true,
            valid: true,
            account: { id: 'account-123', name: 'Test Account' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await setupStore.detectToken();

      expect(setupStore.tokenDetected).toBe(true);
      expect(setupStore.accountInfo).toEqual({ id: 'account-123', name: 'Test Account' });
      expect(setupStore.tokenDetectError).toBeNull();
    });

    it('should set error when token not detected', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ detected: false, error: 'No token found in environment' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await setupStore.detectToken();

      expect(setupStore.tokenDetected).toBe(false);
      expect(setupStore.tokenDetectError).toBe('No token found in environment');
    });

    it('should set error when token detected but invalid', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ detected: true, valid: false, error: 'Token lacks required permissions' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await setupStore.detectToken();

      expect(setupStore.tokenDetected).toBe(false);
      expect(setupStore.tokenDetectError).toBe('Token lacks required permissions');
    });

    it('should use default error message when API returns no error string', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ detected: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await setupStore.detectToken();

      expect(setupStore.tokenDetectError).toBe('Token not detected');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await setupStore.detectToken();

      expect(setupStore.tokenDetected).toBe(false);
      expect(setupStore.tokenDetectError).toBe('Network error');
    });

    it('should clear previous error on new detection attempt', async () => {
      // First call fails
      mockFetch.mockRejectedValue(new Error('Network error'));
      await setupStore.detectToken();
      expect(setupStore.tokenDetectError).toBe('Network error');

      // Second call succeeds
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ detected: true, valid: true, account: { id: '123', name: 'Test' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await setupStore.detectToken();

      expect(setupStore.tokenDetectError).toBeNull();
      expect(setupStore.tokenDetected).toBe(true);
    });
  });

  describe('allowedUsers management', () => {
    it('should add an allowed user', () => {
      setupStore.addAllowedUser('user@example.com');

      expect(setupStore.allowedUsers).toContain('user@example.com');
    });

    it('should add multiple allowed users', () => {
      setupStore.addAllowedUser('user1@example.com');
      setupStore.addAllowedUser('user2@example.com');

      expect(setupStore.allowedUsers).toEqual(['user1@example.com', 'user2@example.com']);
    });

    it('should not add duplicate user', () => {
      setupStore.addAllowedUser('user@example.com');
      setupStore.addAllowedUser('user@example.com');

      expect(setupStore.allowedUsers.length).toBe(1);
    });

    it('should not add empty string', () => {
      setupStore.addAllowedUser('');

      expect(setupStore.allowedUsers.length).toBe(0);
    });

    it('should remove an allowed user', () => {
      setupStore.addAllowedUser('user1@example.com');
      setupStore.addAllowedUser('user2@example.com');

      setupStore.removeAllowedUser('user1@example.com');

      expect(setupStore.allowedUsers).not.toContain('user1@example.com');
      expect(setupStore.allowedUsers).toContain('user2@example.com');
    });

    it('should handle removing non-existent user gracefully', () => {
      setupStore.addAllowedUser('user@example.com');
      setupStore.removeAllowedUser('nonexistent@example.com');

      expect(setupStore.allowedUsers).toEqual(['user@example.com']);
    });
  });

  describe('custom domain', () => {
    it('should set custom domain', () => {
      setupStore.setCustomDomain('my-app.example.com');

      expect(setupStore.customDomain).toBe('my-app.example.com');
    });

    it('should clear customDomainError when setting domain', () => {
      setupStore.setCustomDomain('new-domain.com');

      expect(setupStore.customDomainError).toBeNull();
    });
  });

  describe('step navigation', () => {
    it('should go to next step', () => {
      setupStore.nextStep();

      expect(setupStore.step).toBe(2);
    });

    it('should go to step 3 (max)', () => {
      setupStore.nextStep(); // 1 -> 2
      setupStore.nextStep(); // 2 -> 3

      expect(setupStore.step).toBe(3);
    });

    it('should not go beyond step 3', () => {
      setupStore.nextStep(); // 1 -> 2
      setupStore.nextStep(); // 2 -> 3
      setupStore.nextStep(); // 3 -> still 3

      expect(setupStore.step).toBe(3);
    });

    it('should go to previous step', () => {
      setupStore.nextStep();
      setupStore.nextStep();
      setupStore.prevStep();

      expect(setupStore.step).toBe(2);
    });

    it('should not go below step 1', () => {
      setupStore.prevStep();

      expect(setupStore.step).toBe(1);
    });

    it('should go to specific step', () => {
      setupStore.goToStep(3);

      expect(setupStore.step).toBe(3);
    });

    it('should clamp goToStep to valid range', () => {
      setupStore.goToStep(5);

      expect(setupStore.step).toBe(3);
    });

    it('should clamp goToStep minimum to 1', () => {
      setupStore.goToStep(0);

      expect(setupStore.step).toBe(1);
    });
  });

  describe('configure', () => {
    it('should set configuring during configuration', async () => {
      let resolvePromise: (value: Response) => void;
      mockFetch.mockReturnValue(
        new Promise((resolve) => {
          resolvePromise = resolve;
        })
      );

      const configurePromise = setupStore.configure();

      expect(setupStore.configuring).toBe(true);

      resolvePromise!(
        ndjsonResponse({ done: true, success: true, steps: [] })
      );

      await configurePromise;

      expect(setupStore.configuring).toBe(false);
    });

    it('should send customDomain and allowedUsers in request body', async () => {
      mockFetch.mockResolvedValue(
        ndjsonResponse({ done: true, success: true, steps: [] })
      );

      setupStore.setCustomDomain('my-app.example.com');
      setupStore.addAllowedUser('user@example.com');

      await setupStore.configure();

      const [url, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(url).toBe('/api/setup/configure');
      expect(body.customDomain).toBe('my-app.example.com');
      expect(body.allowedUsers).toEqual(['user@example.com']);
      expect(body.allowedOrigins).toBeUndefined();
    });

    it('should not include token in request body', async () => {
      mockFetch.mockResolvedValue(
        ndjsonResponse({ done: true, success: true, steps: [] })
      );

      await setupStore.configure();

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(body.token).toBeUndefined();
    });

    it('should return true and set setupComplete on success', async () => {
      mockFetch.mockResolvedValue(
        ndjsonResponse(
          { step: 'Create R2', status: 'success' },
          { done: true, success: true, steps: [{ step: 'Create R2', status: 'success' }], customDomainUrl: 'https://my-app.example.com', accountId: 'acc-456' },
        )
      );

      const result = await setupStore.configure();

      expect(result).toBe(true);
      expect(setupStore.setupComplete).toBe(true);
      expect(setupStore.customDomainUrl).toBe('https://my-app.example.com');
      expect(setupStore.accountId).toBe('acc-456');
    });

    it('should return false and set error on failure', async () => {
      mockFetch.mockResolvedValue(
        ndjsonResponse(
          { step: 'Create R2', status: 'error', error: 'R2 error' },
          { done: true, success: false, error: 'Configuration failed', steps: [{ step: 'Create R2', status: 'failed', error: 'R2 error' }] },
        )
      );

      const result = await setupStore.configure();

      expect(result).toBe(false);
      expect(setupStore.configureError).toBe('Configuration failed');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await setupStore.configure();

      expect(result).toBe(false);
      expect(setupStore.configureError).toBe('Network error');
    });

    it('should store configure steps', async () => {
      mockFetch.mockResolvedValue(
        ndjsonResponse(
          { step: 'Create R2', status: 'running' },
          { step: 'Create R2', status: 'success' },
          { step: 'Set secrets', status: 'running' },
          { step: 'Set secrets', status: 'success' },
          { done: true, success: true, steps: [{ step: 'Create R2', status: 'success' }, { step: 'Set secrets', status: 'success' }] },
        )
      );

      await setupStore.configure();

      expect(setupStore.configureSteps.length).toBe(2);
      expect(setupStore.configureSteps[0].step).toBe('Create R2');
    });

    it('should set customDomainUrl when provided', async () => {
      mockFetch.mockResolvedValue(
        ndjsonResponse(
          { done: true, success: true, steps: [], customDomainUrl: 'https://my-app.example.com' },
        )
      );

      await setupStore.configure();

      expect(setupStore.customDomainUrl).toBe('https://my-app.example.com');
    });

    it('should store accountId from configure response', async () => {
      mockFetch.mockResolvedValue(
        ndjsonResponse(
          { done: true, success: true, steps: [], accountId: 'acc-456' },
        )
      );

      await setupStore.configure();

      expect(setupStore.accountId).toBe('acc-456');
    });

    it('should clear configureSteps and error before starting', async () => {
      // First configure call fails
      mockFetch.mockResolvedValue(
        ndjsonResponse(
          { step: 'Step 1', status: 'error' },
          { done: true, success: false, error: 'First failure', steps: [{ step: 'Step 1', status: 'failed' }] },
        )
      );
      await setupStore.configure();
      expect(setupStore.configureError).toBe('First failure');

      // Second configure call - should start fresh
      let resolvePromise: (value: Response) => void;
      mockFetch.mockReturnValue(
        new Promise((resolve) => {
          resolvePromise = resolve;
        })
      );

      const configurePromise = setupStore.configure();

      // During the request, old error and steps should be cleared
      expect(setupStore.configureError).toBeNull();
      expect(setupStore.configureSteps).toEqual([]);

      resolvePromise!(
        ndjsonResponse({ done: true, success: true, steps: [] })
      );

      await configurePromise;
    });
  });

  describe('configure error with steps', () => {
    it('should populate configureSteps from ApiError on HTTP error', async () => {
      const errorSteps = [
        { step: 'get_account', status: 'success' },
        { step: 'derive_r2_credentials', status: 'success' },
        { step: 'create_access_app', status: 'error', error: 'Failed to upsert Access application' },
      ];

      // Mock fetch for configure endpoint to return SetupError
      mockFetch.mockResolvedValueOnce({
        type: 'default',
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve(JSON.stringify({
          success: false,
          error: 'Setup configuration failed',
          code: 'SETUP_ERROR',
          steps: errorSteps,
        })),
      });

      // Need to add at least one admin user for configure to work
      setupStore.addAdminUser('admin@test.com');

      const result = await setupStore.configure();

      expect(result).toBe(false);
      expect(setupStore.configureError).toBeTruthy();
      expect(setupStore.configureSteps).toHaveLength(3);
      expect(setupStore.configureSteps[2].status).toBe('error');
      expect(setupStore.configureSteps[2].error).toBe('Failed to upsert Access application');
    });
  });

  describe('reset', () => {
    it('should reset all state to initial values', async () => {
      // Modify state
      setupStore.nextStep();
      setupStore.setCustomDomain('test.com');
      setupStore.addAllowedUser('user@example.com');

      // Mock successful detect
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ detected: true, valid: true, account: { id: '123', name: 'Test' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await setupStore.detectToken();

      // Now reset
      setupStore.reset();

      // Verify all state is reset
      expect(setupStore.step).toBe(1);
      expect(setupStore.tokenDetected).toBe(false);
      expect(setupStore.tokenDetecting).toBe(false);
      expect(setupStore.tokenDetectError).toBeNull();
      expect(setupStore.accountInfo).toBeNull();
      expect(setupStore.customDomain).toBe('');
      expect(setupStore.customDomainError).toBeNull();
      expect(setupStore.allowedUsers).toEqual([]);
      expect(setupStore.configuring).toBe(false);
      expect(setupStore.configureSteps).toEqual([]);
      expect(setupStore.configureError).toBeNull();
      expect(setupStore.setupComplete).toBe(false);
      expect(setupStore.customDomainUrl).toBeNull();
      expect(setupStore.accountId).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should set tokenDetectError when API returns no detected/valid flags', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ detected: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await setupStore.detectToken();

      expect(setupStore.tokenDetectError).toBe('Token not detected');
    });

    it('should use custom error message from detect API', async () => {
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ detected: false, error: 'Custom error message' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await setupStore.detectToken();

      expect(setupStore.tokenDetectError).toBe('Custom error message');
    });

    it('should use default error for configure failure without message', async () => {
      mockFetch.mockResolvedValue(
        ndjsonResponse(
          { done: true, success: false },
        )
      );

      await setupStore.configure();

      expect(setupStore.configureError).toBe('Configuration failed');
    });
  });

  describe('loadExistingConfig', () => {
    it('uses setup prefill endpoint when setup is not configured', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/setup/status') {
          return Promise.resolve(new Response(
            JSON.stringify({ configured: false }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ));
        }
        if (url === '/api/setup/prefill') {
          return Promise.resolve(new Response(
            JSON.stringify({
              adminUsers: ['admin@example.com'],
              allowedUsers: ['member@example.com'],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ));
        }
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      await setupStore.loadExistingConfig();

      expect(setupStore.customDomain).toBe('');
      expect(setupStore.adminUsers).toEqual(['admin@example.com']);
      expect(setupStore.allowedUsers).toEqual(['member@example.com']);
      expect(mockFetch).toHaveBeenCalledWith('/api/setup/prefill', expect.any(Object));
    });

    it('uses users endpoint when setup is already configured', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/setup/status') {
          return Promise.resolve(new Response(
            JSON.stringify({ configured: true, customDomain: 'claude.example.com' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ));
        }
        if (url === '/api/users') {
          return Promise.resolve(new Response(
            JSON.stringify({
              users: [
                { email: 'admin@example.com', addedBy: 'setup', addedAt: '2024-01-01T00:00:00Z', role: 'admin' },
                { email: 'member@example.com', addedBy: 'setup', addedAt: '2024-01-01T00:00:00Z', role: 'user' },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ));
        }
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      await setupStore.loadExistingConfig();

      expect(setupStore.customDomain).toBe('claude.example.com');
      expect(setupStore.adminUsers).toEqual(['admin@example.com']);
      expect(setupStore.allowedUsers).toEqual(['member@example.com']);
      expect(mockFetch).toHaveBeenCalledWith('/api/users', expect.any(Object));
    });
  });
});
