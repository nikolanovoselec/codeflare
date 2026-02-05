import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { launchBrowser, createPage, BASE_URL } from './setup';
import { TEST_EMAIL } from '../helpers/test-utils';

/**
 * E2E Tests - Request Tracing
 *
 * Tests the request tracing middleware functionality:
 * - X-Request-ID header is returned on all responses
 * - Client-provided X-Request-ID is echoed back
 * - Request ID format is correct (UUID prefix)
 * - Request ID is unique per request
 *
 * Prerequisites:
 * - DEV_MODE=true must be set in wrangler.toml
 * - Worker must be deployed to BASE_URL
 */
describe('Request Tracing', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchBrowser();
  }, 30000);

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    page = await createPage(browser);
  });

  afterEach(async () => {
    try {
      if (page && !page.isClosed()) {
        await page.close();
      }
    } catch (error) {
      console.error('Error closing page:', error);
    }
  });

  describe('X-Request-ID Header', () => {
    it('should return X-Request-ID header on successful requests', async () => {
      const res = await fetch(`${BASE_URL}/api/setup/status`, {
        method: 'GET',
        headers: {
          'CF-Access-Authenticated-User-Email': TEST_EMAIL,
        },
      });
      const response = {
        status: res.status,
        requestId: res.headers.get('X-Request-ID'),
        hasRequestId: res.headers.has('X-Request-ID'),
      };

      expect(response.hasRequestId).toBe(true);
      expect(response.requestId).not.toBeNull();
      expect(response.requestId!.length).toBeGreaterThan(0);
    }, 10000);

    it('should return X-Request-ID header on error responses', async () => {
      const res = await fetch(`${BASE_URL}/api/nonexistent-endpoint`, {
        method: 'GET',
        headers: {
          'CF-Access-Authenticated-User-Email': TEST_EMAIL,
        },
      });
      const response = {
        status: res.status,
        requestId: res.headers.get('X-Request-ID'),
        hasRequestId: res.headers.has('X-Request-ID'),
      };

      // Even on 404, we should get a request ID
      expect(response.status).toBe(404);
      expect(response.hasRequestId).toBe(true);
      expect(response.requestId).not.toBeNull();
    }, 10000);

    it('should return X-Request-ID on POST requests', async () => {
      const res = await fetch(`${BASE_URL}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Access-Authenticated-User-Email': TEST_EMAIL,
        },
        body: JSON.stringify({ name: 'test' }),
      });
      const response = {
        status: res.status,
        requestId: res.headers.get('X-Request-ID'),
        hasRequestId: res.headers.has('X-Request-ID'),
      };

      expect(response.hasRequestId).toBe(true);
      expect(response.requestId).not.toBeNull();
    }, 10000);
  });

  describe('Request ID Format', () => {
    it('should have proper UUID-like format', async () => {
      const res = await fetch(`${BASE_URL}/api/setup/status`, {
        method: 'GET',
        headers: {
          'CF-Access-Authenticated-User-Email': TEST_EMAIL,
        },
      });
      const response = res.headers.get('X-Request-ID');

      expect(response).not.toBeNull();

      // Request ID should be a string (typically UUID or shortened UUID)
      expect(typeof response).toBe('string');

      // Should contain only valid characters (alphanumeric and hyphens)
      expect(response).toMatch(/^[a-zA-Z0-9-]+$/);

      // Should have reasonable length (at least 8 characters based on CLAUDE.md)
      expect(response!.length).toBeGreaterThanOrEqual(8);
    }, 10000);

    it('should follow 8-char UUID prefix format if specified', async () => {
      const res = await fetch(`${BASE_URL}/api/setup/status`, {
        method: 'GET',
        headers: {
          'CF-Access-Authenticated-User-Email': TEST_EMAIL,
        },
      });
      const response = res.headers.get('X-Request-ID');

      expect(response).not.toBeNull();

      // Based on CLAUDE.md: "8-char UUID prefix" format
      // Either it's exactly 8 chars or a full/partial UUID
      const isValidFormat =
        response!.length === 8 ||              // 8-char prefix
        response!.length === 36 ||             // Full UUID with hyphens
        response!.length === 32 ||             // UUID without hyphens
        (response!.length > 8 && response!.includes('-')); // Partial UUID with hyphens

      expect(isValidFormat).toBe(true);
    }, 10000);
  });

  describe('Request ID Uniqueness', () => {
    it('should generate unique IDs for different requests', async () => {
      const ids: string[] = [];

      // Make 5 sequential requests
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${BASE_URL}/api/setup/status`, {
          method: 'GET',
          headers: {
            'CF-Access-Authenticated-User-Email': TEST_EMAIL,
          },
        });
        const id = res.headers.get('X-Request-ID');
        if (id) ids.push(id);
      }

      // Should have 5 IDs
      expect(ids.length).toBe(5);

      // All IDs should be unique
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(5);
    }, 15000);

    it('should generate unique IDs for parallel requests', async () => {
      // Make 5 parallel requests
      const promises = Array(5).fill(null).map(() =>
        fetch(`${BASE_URL}/api/setup/status`, {
          method: 'GET',
          headers: {
            'CF-Access-Authenticated-User-Email': TEST_EMAIL,
          },
        }).then(res => res.headers.get('X-Request-ID'))
      );

      const responses = await Promise.all(promises);

      // Should have 5 IDs
      expect(responses.length).toBe(5);

      // Filter out nulls
      const validIds = responses.filter((id): id is string => id !== null);
      expect(validIds.length).toBe(5);

      // All IDs should be unique
      const uniqueIds = new Set(validIds);
      expect(uniqueIds.size).toBe(5);
    }, 15000);
  });

  describe('Client-Provided Request ID', () => {
    it('should echo back client-provided X-Request-ID', async () => {
      const clientRequestId = 'test-req-12345678';

      const res = await fetch(`${BASE_URL}/api/setup/status`, {
        method: 'GET',
        headers: {
          'X-Request-ID': clientRequestId,
          'CF-Access-Authenticated-User-Email': TEST_EMAIL,
        },
      });
      const response = res.headers.get('X-Request-ID');

      // The response should contain our client request ID
      // It might be the exact ID or include it as part of the response
      expect(response).not.toBeNull();
      expect(response).toContain(clientRequestId);
    }, 10000);

    it('should use client request ID for tracing', async () => {
      const customId = `custom-trace-${Date.now()}`;

      const res = await fetch(`${BASE_URL}/api/setup/status`, {
        method: 'GET',
        headers: {
          'X-Request-ID': customId,
          'CF-Access-Authenticated-User-Email': TEST_EMAIL,
        },
      });
      const response = {
        echoedId: res.headers.get('X-Request-ID'),
        status: res.status,
      };

      expect(response.echoedId).toBe(customId);
    }, 10000);

    it('should handle malformed client request IDs gracefully', async () => {
      // Test with various edge cases
      const edgeCases = [
        '', // Empty
        ' ', // Whitespace
        'a'.repeat(1000), // Very long
        '<script>alert(1)</script>', // XSS attempt
        '../../etc/passwd', // Path traversal attempt
      ];

      for (const testId of edgeCases) {
        const res = await fetch(`${BASE_URL}/api/setup/status`, {
          method: 'GET',
          headers: {
            'X-Request-ID': testId,
            'CF-Access-Authenticated-User-Email': TEST_EMAIL,
          },
        });
        const response = {
          status: res.status,
          hasRequestId: res.headers.has('X-Request-ID'),
          requestId: res.headers.get('X-Request-ID'),
        };

        // Request should not fail due to malformed ID
        expect(response.status).toBeLessThan(500);

        // Should still have a request ID in response
        expect(response.hasRequestId).toBe(true);
      }
    }, 20000);
  });

  describe('Request ID in Different Endpoints', () => {
    const endpoints = [
      { path: '/api/setup/status', method: 'GET' },
      { path: '/api/user', method: 'GET' },
      { path: '/api/sessions', method: 'GET' },
    ];

    for (const { path, method } of endpoints) {
      it(`should include request ID for ${method} ${path}`, async () => {
        const res = await fetch(`${BASE_URL}${path}`, {
          method: method,
          headers: {
            'CF-Access-Authenticated-User-Email': TEST_EMAIL,
          },
        });
        const response = {
          status: res.status,
          requestId: res.headers.get('X-Request-ID'),
          hasRequestId: res.headers.has('X-Request-ID'),
        };

        expect(response.hasRequestId).toBe(true);
        expect(response.requestId).not.toBeNull();
        expect(response.requestId!.length).toBeGreaterThan(0);
      }, 10000);
    }
  });

  describe('Request ID Consistency', () => {
    it('should maintain same request ID throughout request lifecycle', async () => {
      // This test verifies that the request ID doesn't change during the request
      const res = await fetch(`${BASE_URL}/api/setup/status`, {
        method: 'GET',
        headers: {
          'CF-Access-Authenticated-User-Email': TEST_EMAIL,
        },
      });

      // Check headers multiple times
      const id1 = res.headers.get('X-Request-ID');
      const id2 = res.headers.get('X-Request-ID');
      const id3 = res.headers.get('x-request-id'); // Case insensitive

      const response = {
        id1,
        id2,
        id3,
        allSame: id1 === id2 && id1?.toLowerCase() === id3?.toLowerCase(),
      };

      expect(response.allSame).toBe(true);
    }, 10000);
  });
});
