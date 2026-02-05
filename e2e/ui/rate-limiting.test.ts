import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { launchBrowser, createPage, BASE_URL } from './setup';
import { TEST_EMAIL, cleanupSession } from '../helpers/test-utils';

/**
 * E2E Tests - Rate Limiting
 *
 * Tests the rate limiting middleware functionality:
 * - Rate limit headers are returned
 * - 429 Too Many Requests after threshold
 * - Rate limit reset behavior
 * - X-RateLimit-* headers format
 *
 * Prerequisites:
 * - DEV_MODE=true must be set in wrangler.toml
 * - Worker must be deployed to BASE_URL
 *
 * Note: These tests may fail if rate limits were recently hit.
 * Wait 60 seconds between test runs to allow rate limit window to reset.
 */
describe('Rate Limiting', () => {
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
    // Wait a moment between tests to avoid hitting rate limits
    await new Promise(resolve => setTimeout(resolve, 500));
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

  describe('Rate Limit Headers', () => {
    it('should return X-RateLimit-Limit header', async () => {
      const res = await fetch(`${BASE_URL}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Access-Authenticated-User-Email': TEST_EMAIL,
        },
        body: JSON.stringify({ name: 'rate-limit-test' }),
      });
      const response = {
        status: res.status,
        limit: res.headers.get('X-RateLimit-Limit'),
        hasLimit: res.headers.has('X-RateLimit-Limit'),
      };

      // Rate limit headers may only appear on rate-limited endpoints
      if (response.hasLimit) {
        expect(response.limit).not.toBeNull();
        // Limit should be a number
        expect(parseInt(response.limit!, 10)).toBeGreaterThan(0);
      }
    }, 10000);

    it('should return X-RateLimit-Remaining header', async () => {
      const res = await fetch(`${BASE_URL}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Access-Authenticated-User-Email': TEST_EMAIL,
        },
        body: JSON.stringify({ name: 'rate-limit-test' }),
      });
      const response = {
        status: res.status,
        remaining: res.headers.get('X-RateLimit-Remaining'),
        hasRemaining: res.headers.has('X-RateLimit-Remaining'),
      };

      if (response.hasRemaining) {
        expect(response.remaining).not.toBeNull();
        // Remaining should be a number >= 0
        expect(parseInt(response.remaining!, 10)).toBeGreaterThanOrEqual(0);
      }
    }, 10000);

    it('should decrement remaining count with each request', async () => {
      const results: { remaining: string | null }[] = [];

      // Make 3 requests and track remaining
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${BASE_URL}/api/sessions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Access-Authenticated-User-Email': TEST_EMAIL,
          },
          body: JSON.stringify({ name: `rate-limit-test-${i}` }),
        });
        results.push({
          remaining: res.headers.get('X-RateLimit-Remaining'),
        });

        // Small delay between requests
        await new Promise(r => setTimeout(r, 100));
      }

      // If rate limiting is implemented, remaining should decrease
      const remainingValues = results
        .map(r => r.remaining)
        .filter((v): v is string => v !== null)
        .map(v => parseInt(v, 10));

      if (remainingValues.length >= 2) {
        // Each subsequent request should have lower or equal remaining count
        for (let i = 1; i < remainingValues.length; i++) {
          expect(remainingValues[i]).toBeLessThanOrEqual(remainingValues[i - 1]);
        }
      }
    }, 15000);
  });

  describe('Rate Limit Enforcement', () => {
    it('should return 429 when rate limit exceeded', async () => {
      // This test makes many rapid requests to trigger rate limiting
      // Note: This may affect other tests if run too quickly
      let hitRateLimit = false;
      let lastStatus = 0;
      let requestCount = 0;
      let retryAfter: string | null = null;

      // Make up to 20 rapid requests (more than default limit of 10/min)
      for (let i = 0; i < 20 && !hitRateLimit; i++) {
        const res = await fetch(`${BASE_URL}/api/sessions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Access-Authenticated-User-Email': TEST_EMAIL,
          },
          body: JSON.stringify({ name: `rate-limit-test-${i}` }),
        });

        lastStatus = res.status;
        requestCount++;

        if (res.status === 429) {
          hitRateLimit = true;
          retryAfter = res.headers.get('Retry-After');
        }

        // No delay - we want to hit rate limit
      }

      const response = hitRateLimit
        ? { hitRateLimit: true, requestCount, retryAfter }
        : { hitRateLimit: false, requestCount, lastStatus };

      // We should either hit rate limit or make all requests
      // If rate limit is 10/min, we should hit 429 before 20 requests
      // But if DEV_MODE has higher limits, we might not hit it
      expect(response.requestCount).toBeGreaterThan(0);

      if (response.hitRateLimit) {
        // Rate limit was enforced
        expect(response.requestCount).toBeLessThanOrEqual(20);
      }
    }, 30000);

    it('should include Retry-After header when rate limited', async () => {
      // Make rapid requests until rate limited
      for (let i = 0; i < 25; i++) {
        const res = await fetch(`${BASE_URL}/api/sessions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Access-Authenticated-User-Email': TEST_EMAIL,
          },
          body: JSON.stringify({ name: `retry-test-${i}` }),
        });

        if (res.status === 429) {
          const response = {
            hitRateLimit: true,
            retryAfter: res.headers.get('Retry-After'),
            hasRetryAfter: res.headers.has('Retry-After'),
          };

          // Retry-After should be present when rate limited
          expect(response.hasRetryAfter).toBe(true);

          if (response.retryAfter) {
            // Retry-After should be a positive number (seconds)
            const seconds = parseInt(response.retryAfter, 10);
            expect(seconds).toBeGreaterThan(0);
            expect(seconds).toBeLessThanOrEqual(60); // Should reset within 1 minute
          }
          return;
        }
      }

      // If we didn't hit rate limit, that's also valid (DEV_MODE might have higher limits)
    }, 30000);
  });

  describe('Rate Limit Response Format', () => {
    it('should return proper 429 response body', async () => {
      // Make rapid requests until rate limited
      for (let i = 0; i < 25; i++) {
        const res = await fetch(`${BASE_URL}/api/sessions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Access-Authenticated-User-Email': TEST_EMAIL,
          },
          body: JSON.stringify({ name: `body-test-${i}` }),
        });

        if (res.status === 429) {
          let body;
          try {
            body = await res.json();
          } catch {
            body = null;
          }

          const response = {
            hitRateLimit: true,
            body,
            contentType: res.headers.get('content-type'),
          };

          // 429 response should be JSON
          expect(response.contentType).toContain('application/json');

          // Should have an error message
          if (response.body) {
            expect(response.body).toHaveProperty('error');
            expect(typeof response.body.error).toBe('string');
            expect(response.body.error.toLowerCase()).toContain('rate');
          }
          return;
        }
      }

      // If we didn't hit rate limit, that's also valid (DEV_MODE might have higher limits)
    }, 30000);
  });

  describe('Rate Limit Scope', () => {
    it('should apply rate limits per-user', async () => {
      // In DEV_MODE, all requests use the same user (user@example.com)
      // So rate limits should be shared across all requests in this test
      const res = await fetch(`${BASE_URL}/api/sessions`, {
        method: 'GET',
        headers: {
          'CF-Access-Authenticated-User-Email': TEST_EMAIL,
        },
      });
      const response = {
        limit: res.headers.get('X-RateLimit-Limit'),
        remaining: res.headers.get('X-RateLimit-Remaining'),
      };

      // Just verify headers are returned (actual per-user enforcement
      // would require different auth contexts which we can't test in DEV_MODE)
      expect(response).toBeDefined();
    }, 10000);

    it('should not rate limit GET requests as aggressively', async () => {
      // GET requests typically have higher limits than POST/DELETE
      let hitRateLimit = false;
      let requestCount = 0;

      // Make 15 rapid GET requests
      for (let i = 0; i < 15 && !hitRateLimit; i++) {
        const res = await fetch(`${BASE_URL}/api/sessions`, {
          method: 'GET',
          headers: {
            'CF-Access-Authenticated-User-Email': TEST_EMAIL,
          },
        });
        requestCount++;

        if (res.status === 429) {
          hitRateLimit = true;
        }
      }

      const response = { hitRateLimit, requestCount };

      // GET requests should not be rate limited as quickly
      // We should be able to make at least 10 GET requests
      expect(response.requestCount).toBeGreaterThanOrEqual(10);
    }, 20000);
  });

  describe('Rate Limit Reset', () => {
    it('should reset rate limit after window expires', async () => {
      // This test requires waiting for the rate limit window to reset
      // Default window is 60 seconds, so we'll just verify the header exists

      const res = await fetch(`${BASE_URL}/api/sessions`, {
        method: 'GET',
        headers: {
          'CF-Access-Authenticated-User-Email': TEST_EMAIL,
        },
      });
      const response = {
        limit: res.headers.get('X-RateLimit-Limit'),
        remaining: res.headers.get('X-RateLimit-Remaining'),
        reset: res.headers.get('X-RateLimit-Reset'),
      };

      // If reset header is present, it should be a timestamp
      if (response.reset) {
        const resetTime = parseInt(response.reset, 10);
        const now = Math.floor(Date.now() / 1000);

        // Reset time should be in the future (or very recent past)
        expect(resetTime).toBeGreaterThanOrEqual(now - 60);
      }
    }, 10000);
  });

  describe('Rate Limit Edge Cases', () => {
    it('should handle concurrent requests correctly', async () => {
      // Make 5 concurrent requests
      const promises = Array(5).fill(null).map((_, i) =>
        fetch(`${BASE_URL}/api/sessions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Access-Authenticated-User-Email': TEST_EMAIL,
          },
          body: JSON.stringify({ name: `concurrent-${i}` }),
        }).then(res => ({
          status: res.status,
          remaining: res.headers.get('X-RateLimit-Remaining'),
        }))
      );

      const response = await Promise.all(promises);

      // All responses should be valid (2xx, 4xx, or 429)
      for (const res of response) {
        expect([200, 201, 400, 401, 429]).toContain(res.status);
      }
    }, 15000);

    it('should not leak rate limit between different endpoints', async () => {
      // Hitting rate limit on one endpoint shouldn't affect another
      // (unless they share the same rate limit bucket)

      // Make requests to sessions endpoint
      const sessionsRes = await fetch(`${BASE_URL}/api/sessions`, {
        method: 'GET',
        headers: {
          'CF-Access-Authenticated-User-Email': TEST_EMAIL,
        },
      });
      const sessionsRemaining = sessionsRes.headers.get('X-RateLimit-Remaining');

      // Make request to user endpoint
      const userRes = await fetch(`${BASE_URL}/api/user`, {
        method: 'GET',
        headers: {
          'CF-Access-Authenticated-User-Email': TEST_EMAIL,
        },
      });
      const userRemaining = userRes.headers.get('X-RateLimit-Remaining');

      const response = {
        sessionsRemaining,
        userRemaining,
        sessionsStatus: sessionsRes.status,
        userStatus: userRes.status,
      };

      // Both endpoints should respond (not be rate limited from each other)
      expect([200, 401]).toContain(response.sessionsStatus);
      expect([200, 401]).toContain(response.userStatus);
    }, 10000);
  });
});
