import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

// Mock all route modules to prevent import side effects — must be Hono instances
vi.mock('../routes/terminal', () => ({
  default: new Hono(),
  validateWebSocketRoute: vi.fn(() => ({ isWebSocketRoute: false })),
  handleWebSocketUpgrade: vi.fn(),
}));
vi.mock('../routes/user-profile', () => ({ default: new Hono() }));
vi.mock('../routes/container/index', () => ({ default: new Hono() }));
vi.mock('../routes/session/index', () => ({ default: new Hono() }));
vi.mock('../routes/setup/index', () => ({ default: new Hono() }));
vi.mock('../routes/users', () => ({ default: new Hono() }));
vi.mock('../routes/storage', () => ({ default: new Hono() }));
vi.mock('../routes/presets', () => ({ default: new Hono() }));
vi.mock('../routes/preferences', () => ({ default: new Hono() }));
vi.mock('../routes/public/index', () => ({ default: new Hono() }));

import { redirectWithHeaders } from '../index';

describe('redirectWithHeaders', () => {
  it('returns a redirect response with correct status', () => {
    const res = redirectWithHeaders('/setup', 302);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/setup');
  });

  it('includes HSTS header', () => {
    const res = redirectWithHeaders('/app/', 302);
    const hsts = res.headers.get('Strict-Transport-Security');
    expect(hsts).toBe('max-age=63072000; includeSubDomains; preload');
  });

  it('includes security headers', () => {
    const res = redirectWithHeaders('/setup', 302);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('defaults to 302 status', () => {
    const res = redirectWithHeaders('/target');
    expect(res.status).toBe(302);
  });

  it('supports different redirect statuses', () => {
    const res301 = redirectWithHeaders('/target', 301);
    expect(res301.status).toBe(301);

    const res307 = redirectWithHeaders('/target', 307);
    expect(res307.status).toBe(307);
  });
});
