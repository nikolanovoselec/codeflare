import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { isAllowedOrigin, resetCorsOriginsCache } from '../../lib/cors-cache';
import { createMockKV } from '../helpers/mock-kv';
import type { Env } from '../../types';

describe('cors-cache', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  function createEnv(overrides: Partial<Env> = {}): Env {
    return {
      KV: mockKV as unknown as KVNamespace,
      ALLOWED_ORIGINS: '',
      ...overrides,
    } as unknown as Env;
  }

  beforeEach(() => {
    mockKV = createMockKV();
    resetCorsOriginsCache();
  });

  afterEach(() => {
    resetCorsOriginsCache();
  });

  describe('isAllowedOrigin', () => {
    describe('static patterns from env.ALLOWED_ORIGINS', () => {
      it('matches origin against comma-separated env patterns', async () => {
        const env = createEnv({ ALLOWED_ORIGINS: '.workers.dev,.example.com' });

        expect(await isAllowedOrigin('https://my-app.workers.dev', env)).toBe(true);
        expect(await isAllowedOrigin('https://app.example.com', env)).toBe(true);
        expect(await isAllowedOrigin('https://evil.attacker.com', env)).toBe(false);
      });

      it('trims whitespace from patterns', async () => {
        const env = createEnv({ ALLOWED_ORIGINS: ' .workers.dev , .example.com ' });

        expect(await isAllowedOrigin('https://my-app.workers.dev', env)).toBe(true);
      });
    });

    describe('default patterns', () => {
      it('falls back to DEFAULT_ALLOWED_ORIGINS when env.ALLOWED_ORIGINS is not set', async () => {
        const env = createEnv({ ALLOWED_ORIGINS: undefined });

        // DEFAULT_ALLOWED_ORIGINS is ['.workers.dev']
        expect(await isAllowedOrigin('https://my-app.workers.dev', env)).toBe(true);
        expect(await isAllowedOrigin('https://other.com', env)).toBe(false);
      });

      it('falls back to DEFAULT_ALLOWED_ORIGINS when env.ALLOWED_ORIGINS is empty', async () => {
        const env = createEnv({ ALLOWED_ORIGINS: '' });

        // Empty string is falsy, so fallback applies
        expect(await isAllowedOrigin('https://my-app.workers.dev', env)).toBe(true);
      });
    });

    describe('KV-stored origins', () => {
      it('matches exact custom domain', async () => {
        const env = createEnv({ ALLOWED_ORIGINS: '.workers.dev' });
        mockKV._store.set('setup:custom_domain', 'claude.example.com');

        expect(await isAllowedOrigin('https://claude.example.com', env)).toBe(true);
      });

      it('matches subdomain of custom domain', async () => {
        const env = createEnv({ ALLOWED_ORIGINS: '.workers.dev' });
        mockKV._store.set('setup:custom_domain', 'claude.example.com');

        expect(await isAllowedOrigin('https://sub.claude.example.com', env)).toBe(true);
      });

      it('matches against allowed origins list from KV', async () => {
        const env = createEnv({ ALLOWED_ORIGINS: '.workers.dev' });
        mockKV._store.set('setup:allowed_origins', JSON.stringify(['.custom-app.dev']));

        expect(await isAllowedOrigin('https://my.custom-app.dev', env)).toBe(true);
      });

      it('rejects origin not matching any pattern', async () => {
        const env = createEnv({ ALLOWED_ORIGINS: '.workers.dev' });
        mockKV._store.set('setup:custom_domain', 'claude.example.com');

        expect(await isAllowedOrigin('https://evil.attacker.com', env)).toBe(false);
      });
    });

    describe('security: evil prefix domains', () => {
      it('rejects evil prefix domain for custom domain', async () => {
        const env = createEnv({ ALLOWED_ORIGINS: '.workers.dev' });
        mockKV._store.set('setup:custom_domain', 'claude.novoselec.ch');

        // "evilclaude.novoselec.ch" is NOT a subdomain of "claude.novoselec.ch"
        expect(await isAllowedOrigin('https://evilclaude.novoselec.ch', env)).toBe(false);
      });

      it('rejects evil prefix domain for dot-prefixed patterns', async () => {
        const env = createEnv({ ALLOWED_ORIGINS: '.example.com' });

        // ".example.com" requires a dot boundary — "notexample.com" has no leading dot
        expect(await isAllowedOrigin('https://notexample.com', env)).toBe(false);
      });

      it('allows legitimate subdomain while rejecting evil prefix', async () => {
        const env = createEnv({ ALLOWED_ORIGINS: '.workers.dev' });
        mockKV._store.set('setup:custom_domain', 'claude.novoselec.ch');

        // Legitimate subdomain
        expect(await isAllowedOrigin('https://api.claude.novoselec.ch', env)).toBe(true);
        // Evil prefix — not a subdomain
        expect(await isAllowedOrigin('https://evilclaude.novoselec.ch', env)).toBe(false);
      });
    });

    describe('origin parsing', () => {
      it('rejects malformed origin strings', async () => {
        const env = createEnv({ ALLOWED_ORIGINS: '.workers.dev' });

        expect(await isAllowedOrigin('not-a-url', env)).toBe(false);
        expect(await isAllowedOrigin('', env)).toBe(false);
      });

      it('handles origins with ports correctly', async () => {
        const env = createEnv({ ALLOWED_ORIGINS: '.workers.dev' });
        mockKV._store.set('setup:custom_domain', 'claude.example.com');

        // URL.hostname strips the port
        expect(await isAllowedOrigin('https://claude.example.com:8443', env)).toBe(true);
      });

      it('handles http and https origins', async () => {
        const env = createEnv({ ALLOWED_ORIGINS: '.workers.dev' });
        mockKV._store.set('setup:custom_domain', 'claude.example.com');

        expect(await isAllowedOrigin('https://claude.example.com', env)).toBe(true);
        expect(await isAllowedOrigin('http://claude.example.com', env)).toBe(true);
      });
    });

    describe('cache behavior', () => {
      it('caches KV origins so subsequent calls do not re-read KV', async () => {
        const env = createEnv({ ALLOWED_ORIGINS: '.workers.dev' });
        mockKV._store.set('setup:custom_domain', 'claude.example.com');

        // First call reads KV
        await isAllowedOrigin('https://claude.example.com', env);
        const callCount1 = mockKV.get.mock.calls.length;

        // Second call should use cache (no additional KV reads)
        await isAllowedOrigin('https://claude.example.com', env);
        const callCount2 = mockKV.get.mock.calls.length;

        expect(callCount2).toBe(callCount1);
      });

      it('resetCorsOriginsCache clears cache so next call re-reads KV', async () => {
        const env = createEnv({ ALLOWED_ORIGINS: '.workers.dev' });
        mockKV._store.set('setup:custom_domain', 'claude.example.com');

        // First call reads KV
        await isAllowedOrigin('https://claude.example.com', env);
        const callCount1 = mockKV.get.mock.calls.length;

        // Reset cache
        resetCorsOriginsCache();

        // Next call should re-read KV
        await isAllowedOrigin('https://claude.example.com', env);
        const callCount2 = mockKV.get.mock.calls.length;

        expect(callCount2).toBeGreaterThan(callCount1);
      });
    });

    describe('KV error handling', () => {
      it('falls back gracefully when KV read fails', async () => {
        const env = createEnv({ ALLOWED_ORIGINS: '.workers.dev' });
        mockKV.get.mockRejectedValue(new Error('KV unavailable'));

        // Should still match static patterns
        expect(await isAllowedOrigin('https://my-app.workers.dev', env)).toBe(true);
        // KV origins unavailable, so custom domains won't match
        expect(await isAllowedOrigin('https://claude.example.com', env)).toBe(false);
      });
    });
  });
});
