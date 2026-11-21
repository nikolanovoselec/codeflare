import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import publicRoutes from '../../routes/public';
import { AppError, ValidationError } from '../../lib/error-types';
import { CONTACT_TOPICS } from '../../lib/contact-topics';
import { createMockKV } from '../helpers/mock-kv';
import { setLogLevel } from '../../lib/logger';

/**
 * REQ-LANDING-002: enterprise contact endpoint. Mirrors the waitlist suite —
 * same Turnstile + Resend pattern — but gated on (SaaS OR onboarding) mode
 * because the landing page is served in both.
 */
describe('Public contact route (REQ-LANDING-002)', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockKV = createMockKV();
    originalFetch = globalThis.fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function createTestApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env }>();

    app.onError((err, c) => {
      if (err instanceof AppError || err instanceof ValidationError) {
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      }
      return c.json({ error: err.message }, 500);
    });

    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
        ONBOARDING_LANDING_PAGE: 'inactive',
        ...envOverrides,
      } as Env;
      return next();
    });

    app.route('/public', publicRoutes);
    return app;
  }

  function validBody(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      company: 'Analytical Engines AG',
      topic: 'enterprise-deployment',
      message: 'We want to evaluate Codeflare for 200 engineers.',
      turnstileToken: 'token',
      ...overrides,
    });
  }

  function postContact(app: ReturnType<typeof createTestApp>, body: string) {
    return app.request('/public/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.12' },
      body,
    });
  }

  /** Wires admin recipient + Turnstile/Resend success responses. */
  function arrangeSuccessfulDelivery(assertEmail?: (body: Record<string, unknown>) => void) {
    mockKV._set('user:admin@example.com', {
      addedBy: 'setup',
      addedAt: new Date().toISOString(),
      role: 'admin',
    });

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (requestUrl.includes('/turnstile/v0/siteverify')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (requestUrl === 'https://api.resend.com/emails') {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        assertEmail?.(body);
        return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof globalThis.fetch;
  }

  const SECRETS = { TURNSTILE_SECRET_KEY: 'turnstile-secret', RESEND_API_KEY: 're_123' };

  // ===========================================================================
  // Mode gating: available in SaaS mode AND onboarding mode, 404 otherwise
  // ===========================================================================

  it('returns 404 when neither SaaS nor onboarding mode is active', async () => {
    const app = createTestApp();

    const res = await postContact(app, validBody());

    expect(res.status).toBe(404);
  });

  it('accepts submissions in SaaS mode with onboarding inactive', async () => {
    const app = createTestApp({ SAAS_MODE: 'active', ...SECRETS });
    arrangeSuccessfulDelivery();

    const res = await postContact(app, validBody());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  it('accepts submissions in onboarding mode with SaaS inactive', async () => {
    const app = createTestApp({ ONBOARDING_LANDING_PAGE: 'active', ...SECRETS });
    arrangeSuccessfulDelivery();

    const res = await postContact(app, validBody());

    expect(res.status).toBe(200);
  });

  it('keeps the waitlist endpoint onboarding-only: 404 in pure SaaS mode', async () => {
    const app = createTestApp({ SAAS_MODE: 'active', ...SECRETS });

    const res = await app.request('/public/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.co', turnstileToken: 't' }),
    });

    expect(res.status).toBe(404);
  });

  // ===========================================================================
  // Validation
  // ===========================================================================

  it('returns 400 for an invalid email', async () => {
    const app = createTestApp({ SAAS_MODE: 'active', ...SECRETS });

    const res = await postContact(app, validBody({ email: 'not-an-email' }));

    expect(res.status).toBe(400);
  });

  it('returns 400 for a topic outside the shared enum', async () => {
    const app = createTestApp({ SAAS_MODE: 'active', ...SECRETS });

    const res = await postContact(app, validBody({ topic: 'sales-spam' }));

    expect(res.status).toBe(400);
  });

  it('returns 400 for a message shorter than 10 characters', async () => {
    const app = createTestApp({ SAAS_MODE: 'active', ...SECRETS });

    const res = await postContact(app, validBody({ message: 'hi' }));

    expect(res.status).toBe(400);
  });

  it.each([
    { edge: 'name length 1', input: { name: 'A' } },
    { edge: 'name length 100', input: { name: 'N'.repeat(100) } },
    { edge: 'company omitted', input: { company: undefined } },
    { edge: 'company empty', input: { company: '' } },
    { edge: 'company length 200', input: { company: 'C'.repeat(200) } },
    { edge: 'message length 10', input: { message: 'M'.repeat(10) } },
    { edge: 'message length 4000', input: { message: 'M'.repeat(4000) } },
  ])('REQ-LANDING-002 AC1: accepts $edge and relays the submitted fields', async ({ input }) => {
    const app = createTestApp({ SAAS_MODE: 'active', ...SECRETS });
    const deliveries: Record<string, unknown>[] = [];
    arrangeSuccessfulDelivery(body => deliveries.push(body));
    const submission = validBody(input);

    const res = await postContact(app, submission);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const submitted = JSON.parse(submission) as Record<string, string>;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].to).toEqual(['admin@example.com']);
    expect(deliveries[0].reply_to).toBe('ada@example.com');
    const email = String(deliveries[0].html);
    expect(email).toContain(`<strong>Name:</strong> ${submitted.name}</p>`);
    expect(email).toContain(`<strong>Company:</strong> ${submitted.company || 'not provided'}</p>`);
    expect(email).toContain(`<p>${submitted.message}</p>`);
  });

  it.each([
    { edge: 'name length 0', input: { name: '' } },
    { edge: 'name length 101', input: { name: 'N'.repeat(101) } },
    { edge: 'company length 201', input: { company: 'C'.repeat(201) } },
    { edge: 'message length 9', input: { message: 'M'.repeat(9) } },
    { edge: 'message length 4001', input: { message: 'M'.repeat(4001) } },
  ])('REQ-LANDING-002 AC1: rejects $edge without delivering email', async ({ input }) => {
    const app = createTestApp({ SAAS_MODE: 'active', ...SECRETS });
    const deliveries: Record<string, unknown>[] = [];
    arrangeSuccessfulDelivery(body => deliveries.push(body));

    const res = await postContact(app, validBody(input));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String), code: 'VALIDATION_ERROR' });
    expect(deliveries).toEqual([]);
  });

  it('accepts every topic from the shared CONTACT_TOPICS enum', async () => {
    const app = createTestApp({ SAAS_MODE: 'active', ...SECRETS });
    arrangeSuccessfulDelivery();

    for (const topic of CONTACT_TOPICS) {
      const res = await postContact(app, validBody({ topic }));
      expect(res.status, `topic ${topic} should be accepted`).toBe(200);
    }
  });

  // ===========================================================================
  // Abuse protection
  // ===========================================================================

  it('returns 503 when Turnstile/Resend secrets are not configured', async () => {
    const app = createTestApp({ SAAS_MODE: 'active' });

    const res = await postContact(app, validBody());

    expect(res.status).toBe(503);
  });

  it('rejects failed Turnstile verification with a CAPTCHA error', async () => {
    const app = createTestApp({ SAAS_MODE: 'active', ...SECRETS });
    mockKV._set('user:admin@example.com', {
      addedBy: 'setup',
      addedAt: new Date().toISOString(),
      role: 'admin',
    });

    const outboundUrls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      outboundUrls.push(requestUrl);
      if (requestUrl.includes('/turnstile/v0/siteverify')) {
        return new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), {
          status: 200,
        });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof globalThis.fetch;

    const res = await postContact(app, validBody());

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain('captcha');
    expect(outboundUrls).toEqual(['https://challenges.cloudflare.com/turnstile/v0/siteverify']);
  });

  it.each(['transport rejection', 'invalid JSON'] as const)(
    'REQ-LANDING-002 AC3: Turnstile %s blocks delivery without a CAPTCHA verdict',
    async failure => {
      const app = createTestApp({ SAAS_MODE: 'active', ...SECRETS });
      const deliveries: Record<string, unknown>[] = [];
      arrangeSuccessfulDelivery(body => deliveries.push(body));
      const successfulFetch = globalThis.fetch;
      const verificationRequests: { url: string; method: string | undefined; body: string }[] = [];
      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (requestUrl === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
          verificationRequests.push({ url: requestUrl, method: init?.method, body: String(init?.body) });
          if (failure === 'transport rejection') throw new TypeError('verification transport unavailable');
          return new Response('not JSON', { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return successfulFetch(url, init);
      }) as typeof globalThis.fetch;

      const res = await postContact(app, validBody());

      expect(res.status).toBe(500);
      const body = await res.json() as { error: string; code?: string };
      expect(body.error).toEqual(expect.any(String));
      expect(body.error.toLowerCase()).not.toContain('captcha');
      expect(body.code).not.toBe('VALIDATION_ERROR');
      expect(verificationRequests).toEqual([{
        url: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        method: 'POST',
        body: 'secret=turnstile-secret&response=token&remoteip=203.0.113.12',
      }]);
      expect(deliveries).toEqual([]);
    },
  );

  // ===========================================================================
  // Delivery
  // ===========================================================================

  it('emails admins with all fields, reply-to set to the submitter', async () => {
    const app = createTestApp({ SAAS_MODE: 'active', ...SECRETS });
    let emailBody: Record<string, unknown> | undefined;
    arrangeSuccessfulDelivery((body) => {
      emailBody = body;
    });

    const res = await postContact(app, validBody());

    expect(res.status).toBe(200);
    expect(emailBody).toBeDefined();
    expect(emailBody!.to).toEqual(['admin@example.com']);
    expect(emailBody!.reply_to).toBe('ada@example.com');
    expect(String(emailBody!.subject)).toContain('enterprise-deployment');
    const html = String(emailBody!.html);
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('Analytical Engines AG');
    expect(html).toContain('We want to evaluate Codeflare for 200 engineers.');
  });

  it('escapes HTML in user-controlled fields before emailing', async () => {
    const app = createTestApp({ SAAS_MODE: 'active', ...SECRETS });
    let emailHtml = '';
    arrangeSuccessfulDelivery((body) => {
      emailHtml = String(body.html);
    });

    const res = await postContact(
      app,
      validBody({ name: '<script>alert(1)</script>', message: 'A <img src=x onerror=y> message.' })
    );

    expect(res.status).toBe(200);
    expect(emailHtml).not.toContain('<script>');
    expect(emailHtml).toContain('&lt;script&gt;');
    expect(emailHtml).not.toContain('<img src=x');
  });

  it.each([true, false])('REQ-LANDING-002 AC5: contact logs omit personal data on verification success=%s', async success => {
    const app = createTestApp({ SAAS_MODE: 'active', ...SECRETS });
    arrangeSuccessfulDelivery();
    if (!success) {
      globalThis.fetch = vi.fn(async () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] })) as typeof fetch;
    }
    const logs: unknown[][] = [];
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map(method =>
      vi.spyOn(console, method as 'log').mockImplementation((...args: unknown[]) => { logs.push(args); })
    );
    setLogLevel('debug');
    try {
      const res = await postContact(app, validBody());
      expect(res.status).toBe(success ? 200 : 400);
      const output = JSON.stringify(logs);
      expect(output).toContain(success ? 'Contact submission accepted' : 'Turnstile verification failed');
      for (const privateValue of ['ada@example.com', 'ad***@example.com', 'enterprise-deployment', 'Ada Lovelace', 'Analytical Engines AG', 'We want to evaluate']) {
        expect(output).not.toContain(privateValue);
      }
      if (!success) expect(output).toContain('invalid-input-response');
    } finally {
      setLogLevel('silent');
      spies.forEach(spy => spy.mockRestore());
    }
  });

  it('never persists submission content — only rate-limiter bookkeeping touches KV (AC5)', async () => {
    const app = createTestApp({ SAAS_MODE: 'active', ...SECRETS });
    arrangeSuccessfulDelivery();

    const res = await postContact(app, validBody());

    expect(res.status).toBe(200);
    const contentWrites = mockKV.put.mock.calls.filter(
      (call) => !String(call[0]).startsWith('contact-submit')
    );
    expect(contentWrites).toEqual([]);
  });

  it('returns 503 when no admin recipient exists', async () => {
    const app = createTestApp({ SAAS_MODE: 'active', ...SECRETS });
    // No admin user in KV

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ success: true }), { status: 200 })
    ) as typeof globalThis.fetch;

    const res = await postContact(app, validBody());

    expect(res.status).toBe(503);
  });

  // ===========================================================================
  // GET /public/contact-config
  // ===========================================================================

  it('returns the Turnstile site key in SaaS mode', async () => {
    const app = createTestApp({ SAAS_MODE: 'active' });
    mockKV._store.set('setup:turnstile_site_key', '0xABCDEF123456');

    const res = await app.request('/public/contact-config');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { turnstileSiteKey: string | null };
    expect(body.turnstileSiteKey).toBe('0xABCDEF123456');
  });

  it('REQ-LANDING-002 AC6: onboarding contact-config exposes only the public site key', async () => {
    const app = createTestApp({ ONBOARDING_LANDING_PAGE: 'active', ...SECRETS });
    mockKV._store.set('setup:turnstile_site_key', '0xONBOARDING');
    mockKV._store.set('setup:turnstile_secret_key', 'private-verifier-canary');

    const res = await app.request('/public/contact-config');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ turnstileSiteKey: '0xONBOARDING' });
  });

  it('returns 404 for contact-config when neither mode is active', async () => {
    const app = createTestApp();

    const res = await app.request('/public/contact-config');

    expect(res.status).toBe(404);
  });
});
