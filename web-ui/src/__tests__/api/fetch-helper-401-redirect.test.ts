/**
 * REQ-AUTH-022 AC1: a 401 on an authenticated page must redirect to sign-in via
 * `location.replace` AND throw an `authRedirect`-tagged ApiError — it must never
 * return a never-resolving promise. The old hung promise stalled the bootstrap
 * chain and left the SPA on its loading shell (the blank/white page on return).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { baseFetch, ApiError } from '../../api/fetch-helper';

function json401() {
  return {
    type: 'basic',
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: () => Promise.resolve(JSON.stringify({ error: 'AUTH_FAILED', code: 'AUTH_FAILED' })),
  };
}

describe('REQ-AUTH-022 AC1: 401 on an authed page redirects + throws (never hangs)', () => {
  let replaceSpy: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  function stubLocation(pathname: string) {
    replaceSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { pathname, href: `http://localhost${pathname}`, replace: replaceSpy, assign: () => {}, reload: () => {} },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    originalLocation = window.location;
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
  });

  it('rejects with an authRedirect ApiError on /app/* (the promise settles)', async () => {
    stubLocation('/app/sessions');
    mockFetch.mockResolvedValueOnce(json401());
    try {
      await baseFetch('/api/user', {});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.status).toBe(401);
      expect(e.authRedirect).toBe(true);
    }
  });

  it('redirects via location.replace("/") — not href, so Back does not return to the dead page', async () => {
    stubLocation('/app/sessions');
    mockFetch.mockResolvedValueOnce(json401());
    await expect(baseFetch('/api/user', {})).rejects.toBeInstanceOf(ApiError);
    expect(replaceSpy).toHaveBeenCalledWith('/');
  });

  it('settles (rejects) rather than hanging — guards against the never-resolving regression', async () => {
    stubLocation('/admin/users');
    mockFetch.mockResolvedValueOnce(json401());
    const outcome = await Promise.race([
      baseFetch('/api/user', {}).then(() => 'resolved', () => 'rejected'),
      new Promise<string>((r) => setTimeout(() => r('hung'), 500)),
    ]);
    expect(outcome).toBe('rejected');
  });

  it('does NOT redirect on a public path (login/root) — leaves the 401 to the caller', async () => {
    stubLocation('/login');
    mockFetch.mockResolvedValueOnce(json401());
    await expect(baseFetch('/api/user', {})).rejects.toMatchObject({ status: 401 });
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});
