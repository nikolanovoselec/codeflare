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

function accessRedirect(type: 'basic' | 'opaqueredirect', status: number) {
  return {
    type,
    ok: false,
    status,
    statusText: '',
    text: () => Promise.resolve(''),
  };
}

function accessHtml(status: 200 | 403) {
  return {
    type: 'basic',
    ok: status === 200,
    status,
    statusText: status === 200 ? 'OK' : 'Forbidden',
    headers: new Headers({ 'Content-Type': 'text/html; charset=utf-8' }),
    text: () => Promise.resolve('<!-- Access response --><body>Access login</body>'),
  };
}

describe('REQ-AUTH-022 AC1: 401 on an authed page redirects + throws (never hangs)', () => {
  let replaceSpy: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  function stubLocation(pathname: string) {
    replaceSpy = vi.fn((target: string) => {
      const destination = new URL(target, window.location.href);
      window.location.pathname = destination.pathname;
      window.location.href = destination.href;
    });
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

  it.each([
    { label: 'explicit 401', response: json401 },
    { label: 'basic redirect', response: () => accessRedirect('basic', 302) },
    { label: 'opaque redirect', response: () => accessRedirect('opaqueredirect', 0) },
    { label: 'Samsung status-zero manual redirect', response: () => accessRedirect('basic', 0) },
    { label: '403 HTML login response', response: () => accessHtml(403) },
    { label: '200 HTML login response', response: () => accessHtml(200) },
  ].flatMap((testCase) => ['/app/sessions', '/admin/users'].map((pathname) => ({
    ...testCase, pathname, label: `${testCase.label} on ${pathname}`,
  }))))('REQ-AUTH-022 AC5: Access response shapes navigate the top-level app instead of stranding it ($label)', async ({ response, pathname }) => {
    stubLocation(pathname);
    mockFetch.mockResolvedValueOnce(response());

    await expect(baseFetch('/api/user', {})).rejects.toMatchObject({
      status: 401,
      authRedirect: true,
    });
    expect(replaceSpy).toHaveBeenCalledWith('/');
  });

  describe.each(['/app/sessions/running-session', '/admin/users'])('REQ-AUTH-022 AC5 / REQ-AUTH-014 AC1: server failures on %s', (pathname) => {
    it.each([500, 502, 503, 599].flatMap((status) => [
      {
        status,
        label: 'HTML content type without a document root',
        contentType: 'text/html; charset=utf-8',
        body: '<!-- maintenance --><body>Service unavailable</body>',
      },
      {
        status,
        label: 'HTML doctype without a content type',
        contentType: undefined,
        body: ' \n<!DOCTYPE html><html><body>Bad gateway</body></html>',
      },
      {
        status,
        label: 'HTML root despite a text content type',
        contentType: 'text/plain',
        body: ' \n<html><body>Service unavailable</body></html>',
      },
    ]))('settles HTML $status ($label) without auth recovery or route changes', async ({ status, contentType, body }) => {
      stubLocation(pathname);
      const statusText = status === 502 ? 'Bad Gateway' : status === 503 ? 'Service Unavailable' : 'Server Error';
      mockFetch.mockResolvedValueOnce({
        type: 'basic', ok: false, status, statusText,
        headers: new Headers(contentType ? { 'Content-Type': contentType } : {}),
        text: () => Promise.resolve(body),
      });

      const outcome = await Promise.race([
        baseFetch('/api/user', {}).then(() => 'resolved', (error: unknown) => error),
        new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 500)),
      ]);

      expect(outcome).toBeInstanceOf(ApiError);
      const error = outcome as ApiError;
      expect(error.status).toBe(status);
      expect(error.statusText).toBe(statusText);
      expect(error.message).toContain(`HTTP ${status}`);
      expect(error.message.toLowerCase()).not.toContain('auth');
      expect(error.message).not.toContain('<');
      expect(error.body).toBeUndefined();
      expect(error.authRedirect).toBeUndefined();
      expect(window.location.pathname).toBe(pathname);
      expect(window.location.href).toBe(`http://localhost${pathname}`);
    });

    it.each([502, 503])('preserves JSON $status error semantics without auth recovery', async (status) => {
      stubLocation(pathname);
      const payload = {
        error: 'Service unavailable',
        code: 'SERVICE_UNAVAILABLE',
        steps: [{ step: 'upstream', status: 'error', error: 'Unavailable' }],
      };
      const body = JSON.stringify(payload);
      const statusText = status === 502 ? 'Bad Gateway' : 'Service Unavailable';
      mockFetch.mockResolvedValueOnce({
        type: 'basic', ok: false, status, statusText,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        text: () => Promise.resolve(body),
      });

      const error = await baseFetch('/api/user', {}).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status, statusText, message: payload.error, code: payload.code, steps: payload.steps, body,
      });
      expect((error as ApiError).authRedirect).toBeUndefined();
      expect(window.location.pathname).toBe(pathname);
      expect(window.location.href).toBe(`http://localhost${pathname}`);
    });
  });

  it('does not misclassify a successful JSON API response as expired authentication', async () => {
    stubLocation('/app/sessions');
    mockFetch.mockResolvedValueOnce({
      type: 'basic',
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      text: () => Promise.resolve('{"authenticated":true}'),
    });

    await expect(baseFetch('/api/user', {})).resolves.toEqual({ authenticated: true });
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('does NOT redirect on a public path (login/root) — leaves the 401 to the caller', async () => {
    stubLocation('/login');
    mockFetch.mockResolvedValueOnce(json401());
    await expect(baseFetch('/api/user', {})).rejects.toMatchObject({ status: 401 });
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});
