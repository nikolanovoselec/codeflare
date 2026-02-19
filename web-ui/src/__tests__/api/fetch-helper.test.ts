import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { baseFetch, ApiError } from '../../api/fetch-helper';
import { z } from 'zod';

describe('fetch-helper: baseFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Redirect Detection
  // ==========================================================================
  describe('redirect detection', () => {
    it('should throw ApiError with 401 on opaqueredirect response', async () => {
      mockFetch.mockResolvedValueOnce({
        type: 'opaqueredirect',
        ok: false,
        status: 0,
        text: () => Promise.resolve(''),
      });

      await expect(baseFetch('/api/test', {})).rejects.toThrow(ApiError);
      await expect(baseFetch('/api/test', {})).rejects.toThrow(
        // Second call to verify message (first was consumed)
      );

      // Verify exact error properties
      mockFetch.mockResolvedValueOnce({
        type: 'opaqueredirect',
        ok: false,
        status: 0,
        text: () => Promise.resolve(''),
      });
      try {
        await baseFetch('/api/test', {});
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(401);
        expect(apiErr.statusText).toBe('Unauthorized');
        expect(apiErr.message).toContain('redirect');
      }
    });

    it('should throw ApiError with 401 on 3xx redirect status', async () => {
      mockFetch.mockResolvedValueOnce({
        type: 'basic',
        ok: false,
        status: 302,
        text: () => Promise.resolve(''),
      });

      try {
        await baseFetch('/api/test', {});
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(401);
        expect(apiErr.message).toContain('session may have expired');
      }
    });

    it('should not treat 2xx as redirect', async () => {
      mockFetch.mockResolvedValueOnce({
        type: 'basic',
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ ok: true })),
      });

      const result = await baseFetch('/api/test', {});
      expect(result).toEqual({ ok: true });
    });
  });

  // ==========================================================================
  // Zod Validation of Responses
  // ==========================================================================
  describe('Zod validation', () => {
    const TestSchema = z.object({
      id: z.string(),
      value: z.number(),
    });

    it('should validate response against provided schema', async () => {
      mockFetch.mockResolvedValueOnce({
        type: 'basic',
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ id: 'abc', value: 42 })),
      });

      const result = await baseFetch('/api/test', {}, { schema: TestSchema });
      expect(result).toEqual({ id: 'abc', value: 42 });
    });

    it('should throw ZodError when response does not match schema', async () => {
      mockFetch.mockResolvedValueOnce({
        type: 'basic',
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ id: 123, value: 'not-a-number' })),
      });

      await expect(
        baseFetch('/api/test', {}, { schema: TestSchema })
      ).rejects.toThrow();
    });

    it('should throw ApiError when schema expects body but response is empty', async () => {
      mockFetch.mockResolvedValueOnce({
        type: 'basic',
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      await expect(
        baseFetch('/api/test', {}, { schema: TestSchema })
      ).rejects.toThrow('Expected response body but received empty response');
    });

    it('should return data without validation when no schema provided', async () => {
      mockFetch.mockResolvedValueOnce({
        type: 'basic',
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ anything: 'goes' })),
      });

      const result = await baseFetch('/api/test', {});
      expect(result).toEqual({ anything: 'goes' });
    });
  });

  // ==========================================================================
  // Error Wrapping
  // ==========================================================================
  describe('error wrapping', () => {
    it('should wrap HTTP errors in ApiError with status and body', async () => {
      mockFetch.mockResolvedValueOnce({
        type: 'basic',
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve('Something broke'),
      });

      try {
        await baseFetch('/api/test', {});
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(500);
        expect(apiErr.statusText).toBe('Internal Server Error');
        expect(apiErr.message).toBe('Something broke');
        expect(apiErr.body).toBe('Something broke');
      }
    });

    it('should extract error field from JSON error response', async () => {
      mockFetch.mockResolvedValueOnce({
        type: 'basic',
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve(JSON.stringify({ error: 'Invalid input' })),
      });

      await expect(baseFetch('/api/test', {})).rejects.toThrow('Invalid input');
    });

    it('should use HTTP status when error body is empty', async () => {
      mockFetch.mockResolvedValueOnce({
        type: 'basic',
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: () => Promise.resolve(''),
      });

      await expect(baseFetch('/api/test', {})).rejects.toThrow('HTTP 502');
    });

    it('should throw ApiError for non-JSON success response', async () => {
      mockFetch.mockResolvedValueOnce({
        type: 'basic',
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve('<html>Not JSON</html>'),
      });

      await expect(baseFetch('/api/test', {})).rejects.toThrow('Invalid JSON response');
    });

    it('should return undefined for empty success response without schema', async () => {
      mockFetch.mockResolvedValueOnce({
        type: 'basic',
        ok: true,
        status: 204,
        text: () => Promise.resolve(''),
      });

      const result = await baseFetch('/api/test', {});
      expect(result).toBeUndefined();
    });
  });

  // ==========================================================================
  // Request Configuration
  // ==========================================================================
  describe('request configuration', () => {
    it('should use redirect:manual to detect auth redirects', async () => {
      mockFetch.mockResolvedValueOnce({
        type: 'basic',
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({})),
      });

      await baseFetch('/api/test', {});

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/test',
        expect.objectContaining({ redirect: 'manual' })
      );
    });

    it('should include X-Requested-With header', async () => {
      mockFetch.mockResolvedValueOnce({
        type: 'basic',
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({})),
      });

      await baseFetch('/api/test', {});

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/test',
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Requested-With': 'XMLHttpRequest',
          }),
        })
      );
    });

    it('should add Content-Type header when body is present', async () => {
      mockFetch.mockResolvedValueOnce({
        type: 'basic',
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({})),
      });

      await baseFetch('/api/test', { body: JSON.stringify({ key: 'value' }) });

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/test',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should prepend basePath when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        type: 'basic',
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({})),
      });

      await baseFetch('/config', {}, { basePath: '/public' });

      expect(mockFetch).toHaveBeenCalledWith(
        '/public/config',
        expect.any(Object)
      );
    });
  });

  // ==========================================================================
  // SetupError Steps Extraction
  // ==========================================================================
  describe('SetupError steps extraction', () => {
    it('should attach steps array from error response body to ApiError', async () => {
      const errorBody = {
        success: false,
        error: 'Setup configuration failed',
        code: 'SETUP_ERROR',
        steps: [
          { step: 'get_account', status: 'success' },
          { step: 'create_access_app', status: 'error', error: 'Permission denied' },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        type: 'default',
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve(JSON.stringify(errorBody)),
      });

      try {
        await baseFetch('/api/setup/configure', { method: 'POST' });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(400);
        expect(apiErr.steps).toBeDefined();
        expect(apiErr.steps).toHaveLength(2);
        expect(apiErr.steps![0]).toEqual({ step: 'get_account', status: 'success' });
        expect(apiErr.steps![1].status).toBe('error');
        expect(apiErr.steps![1].error).toBe('Permission denied');
      }
    });

    it('should not set steps when error body has no steps array', async () => {
      mockFetch.mockResolvedValueOnce({
        type: 'default',
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve(JSON.stringify({ error: 'Something broke' })),
      });

      try {
        await baseFetch('/api/test', {});
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.steps).toBeUndefined();
      }
    });
  });
});
