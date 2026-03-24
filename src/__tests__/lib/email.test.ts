import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendEmail, sendWelcomeEmail, sendSubscriptionEmail, sendRenewalEmail, sendSubscriptionAdminNotification } from '../../lib/email';

describe('sendEmail', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls Resend API with correct params', async () => {
    await sendEmail({
      to: ['admin@example.com'],
      subject: 'Test Subject',
      html: '<p>Hello</p>',
      replyTo: 'user@example.com',
      env: {
        RESEND_API_KEY: 'test-api-key',
        RESEND_EMAIL: 'Codeflare <noreply@example.com>',
      },
    });

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://api.resend.com/emails');
    const opts = call[1];
    expect(opts.method).toBe('POST');
    expect(opts.headers['Authorization']).toBe('Bearer test-api-key');

    const body = JSON.parse(opts.body);
    expect(body.to).toEqual(['admin@example.com']);
    expect(body.subject).toBe('Test Subject');
    expect(body.html).toBe('<p>Hello</p>');
    expect(body.reply_to).toBe('user@example.com');
  });

  it('returns false when RESEND_API_KEY is missing', async () => {
    const result = await sendEmail({
      to: ['admin@example.com'],
      subject: 'Test',
      html: '<p>Test</p>',
      env: {},
    });

    expect(result).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns false when recipients array is empty', async () => {
    const result = await sendEmail({
      to: [],
      subject: 'Test',
      html: '<p>Test</p>',
      env: { RESEND_API_KEY: 'key' },
    });

    expect(result).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns true on successful send', async () => {
    const result = await sendEmail({
      to: ['admin@example.com'],
      subject: 'Test',
      html: '<p>Test</p>',
      env: { RESEND_API_KEY: 'key' },
    });

    expect(result).toBe(true);
  });

  it('returns false and does not throw on fetch failure', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network error'));

    const result = await sendEmail({
      to: ['admin@example.com'],
      subject: 'Test',
      html: '<p>Test</p>',
      env: { RESEND_API_KEY: 'key' },
    });

    expect(result).toBe(false);
    consoleSpy.mockRestore();
  });

  it('logs error when API returns non-ok response', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('{"message":"Invalid API key"}', { status: 401 })
    );

    const result = await sendEmail({
      to: ['admin@example.com'],
      subject: 'Test',
      html: '<p>Test</p>',
      env: { RESEND_API_KEY: 'bad-key' },
    });

    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Email send failed'),
      expect.objectContaining({ status: 401 })
    );
    consoleSpy.mockRestore();
  });

  it('logs error when fetch throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network error'));

    const result = await sendEmail({
      to: ['admin@example.com'],
      subject: 'Test',
      html: '<p>Test</p>',
      env: { RESEND_API_KEY: 'key' },
    });

    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Email send error'),
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });

  it('uses default from address when RESEND_EMAIL is not set', async () => {
    await sendEmail({
      to: ['admin@example.com'],
      subject: 'Test',
      html: '<p>Test</p>',
      env: { RESEND_API_KEY: 'key' },
    });

    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.from).toBe('Codeflare <onboarding@resend.dev>');
  });
});

const testEnv = { RESEND_API_KEY: 'test-key', RESEND_EMAIL: 'Codeflare <noreply@test.com>' };
const noKeyEnv = {};

describe('sendWelcomeEmail', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 })); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('sends welcome email with correct subject', async () => {
    const result = await sendWelcomeEmail({ userEmail: 'alice@example.com', env: testEnv });
    expect(result).toBe(true);
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.subject).toBe('Welcome to Codeflare');
    expect(body.to).toEqual(['alice@example.com']);
  });

  it('returns false without API key', async () => {
    const result = await sendWelcomeEmail({ userEmail: 'alice@example.com', env: noKeyEnv });
    expect(result).toBe(false);
  });
});

describe('sendSubscriptionEmail', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 })); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('sends new subscription confirmation', async () => {
    const result = await sendSubscriptionEmail({
      userEmail: 'alice@example.com', tierName: 'Starter', monthlyHours: '40h',
      maxSessions: 3, trialHours: 40, env: testEnv,
    });
    expect(result).toBe(true);
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.subject).toBe('Your Codeflare plan: Starter (Standard)');
    expect(body.html).toContain('Starter');
    expect(body.html).toContain('40h');
  });

  it('sends plan change confirmation with previous tier', async () => {
    await sendSubscriptionEmail({
      userEmail: 'alice@example.com', tierName: 'Max', previousTierName: 'Starter',
      monthlyHours: '160h', maxSessions: 10, trialHours: 160, env: testEnv,
    });
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.subject).toBe('Plan changed to Max (Standard)');
    expect(body.html).toContain('Starter');
    expect(body.html).toContain('Max');
  });

  it('escapes HTML in tier names', async () => {
    await sendSubscriptionEmail({
      userEmail: 'alice@example.com', tierName: '<script>alert(1)</script>',
      monthlyHours: '40h', maxSessions: 3, trialHours: 0, env: testEnv,
    });
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.html).not.toContain('<script>');
    expect(body.html).toContain('&lt;script&gt;');
  });

  it('returns false without API key', async () => {
    const result = await sendSubscriptionEmail({
      userEmail: 'alice@example.com', tierName: 'Starter', monthlyHours: '40h',
      maxSessions: 3, trialHours: 0, env: noKeyEnv,
    });
    expect(result).toBe(false);
  });

  it('sends email with price in body when price is provided', async () => {
    await sendSubscriptionEmail({
      userEmail: 'alice@example.com', tierName: 'Max', monthlyHours: '160h',
      maxSessions: 10, trialHours: 0, price: '$29', env: testEnv,
    });
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.html).toContain('$29');
    expect(body.html).toContain('Price');
  });

  it('sends email with formatted activation date when subscribedAt is provided', async () => {
    await sendSubscriptionEmail({
      userEmail: 'alice@example.com', tierName: 'Starter', monthlyHours: '40h',
      maxSessions: 3, trialHours: 0, subscribedAt: '2025-06-15T14:30:00.000Z', env: testEnv,
    });
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.html).toContain('Activated');
    expect(body.html).toContain('2025');
  });

  it('mode-only change triggers "Plan Changed" subject', async () => {
    await sendSubscriptionEmail({
      userEmail: 'alice@example.com', tierName: 'Starter', monthlyHours: '40h',
      maxSessions: 3, trialHours: 0, sessionMode: 'advanced', previousMode: 'default', env: testEnv,
    });
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.subject).toContain('Plan changed');
    expect(body.html).toContain('Plan Changed');
  });
});

describe('sendRenewalEmail', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 })); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('sends renewal confirmation', async () => {
    const result = await sendRenewalEmail({
      userEmail: 'alice@example.com', tierName: 'Starter', monthlyHours: '40h',
      maxSessions: 3, env: testEnv,
    });
    expect(result).toBe(true);
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.subject).toContain('renewed');
    expect(body.html).toContain('Starter');
  });
});

describe('sendSubscriptionAdminNotification', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 })); });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('sends admin notification with correct subject and recipients', async () => {
    const result = await sendSubscriptionAdminNotification({
      userEmail: 'alice@example.com', tierName: 'Starter', sessionMode: 'default',
      adminEmails: ['admin1@example.com', 'admin2@example.com'], env: testEnv,
    });
    expect(result).toBe(true);
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.subject).toContain('New subscriber');
    expect(body.subject).toContain('alice@example.com');
    expect(body.subject).toContain('Starter');
    expect(body.to).toEqual(['admin1@example.com', 'admin2@example.com']);
  });

  it('includes user email, tier, mode in body', async () => {
    await sendSubscriptionAdminNotification({
      userEmail: 'alice@example.com', tierName: 'Max', sessionMode: 'advanced',
      adminEmails: ['admin@example.com'], env: testEnv,
    });
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.html).toContain('alice@example.com');
    expect(body.html).toContain('Max');
    expect(body.html).toContain('Pro');
  });

  it('returns false when adminEmails is empty', async () => {
    const result = await sendSubscriptionAdminNotification({
      userEmail: 'alice@example.com', tierName: 'Starter',
      adminEmails: [], env: testEnv,
    });
    expect(result).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns false without API key', async () => {
    const result = await sendSubscriptionAdminNotification({
      userEmail: 'alice@example.com', tierName: 'Starter',
      adminEmails: ['admin@example.com'], env: noKeyEnv,
    });
    expect(result).toBe(false);
  });
});
