import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendEmail, sendWelcomeEmail, sendSubscriptionEmail, sendSubscriptionAdminNotification, getModeLabel, buildPlanChangeRows, buildSubscriptionDetailRows } from '../../lib/email';

describe('getModeLabel', () => {
  it('returns "Pro" for "advanced" mode', () => {
    expect(getModeLabel('advanced')).toBe('Pro');
  });

  it('returns "Standard" for "default" mode', () => {
    expect(getModeLabel('default')).toBe('Standard');
  });

  it('returns "Standard" for undefined', () => {
    expect(getModeLabel(undefined)).toBe('Standard');
  });

  it('returns "Standard" for any other string', () => {
    expect(getModeLabel('custom')).toBe('Standard');
  });
});

describe('buildPlanChangeRows', () => {
  it('returns Previous/New table with tier names and mode labels', () => {
    const rows = buildPlanChangeRows({
      previousTierName: 'Starter',
      tierName: 'Advanced',
      previousMode: 'default',
      sessionMode: 'advanced',
    });
    const html = rows.join('\n');
    expect(html).toContain('Previous');
    expect(html).toContain('Starter (Standard)');
    expect(html).toContain('New');
    expect(html).toContain('Advanced (Pro)');
    expect(html).toContain('<table');
    expect(html).toContain('</table>');
  });

  it('uses tierName as fallback when previousTierName is undefined', () => {
    const rows = buildPlanChangeRows({ tierName: 'Max', sessionMode: 'default' });
    const html = rows.join('\n');
    expect(html).toContain('Max (Standard)');
  });

  it('escapes HTML in tier names', () => {
    const rows = buildPlanChangeRows({ previousTierName: '<script>xss</script>', tierName: 'Safe' });
    const html = rows.join('\n');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('buildSubscriptionDetailRows', () => {
  it('includes Compute row when monthlyHours provided', () => {
    const html = buildSubscriptionDetailRows({ monthlyHours: '40h' }).join('\n');
    expect(html).toContain('Compute');
    expect(html).toContain('40h');
  });

  it('includes Sessions row when maxSessions provided', () => {
    const html = buildSubscriptionDetailRows({ maxSessions: 3 }).join('\n');
    expect(html).toContain('Sessions');
    expect(html).toContain('3');
  });

  it('includes Price row when price provided', () => {
    const html = buildSubscriptionDetailRows({ price: '$29' }).join('\n');
    expect(html).toContain('Price');
    expect(html).toContain('$29');
  });

  it('excludes Price row when price not provided', () => {
    const html = buildSubscriptionDetailRows({ monthlyHours: '40h' }).join('\n');
    expect(html).not.toContain('Price');
  });

  it('includes Trial row when trialHours > 0', () => {
    const html = buildSubscriptionDetailRows({ trialHours: 40 }).join('\n');
    expect(html).toContain('Trial');
    expect(html).toContain('40h');
  });

  it('shows billing active when trialHours is 0 and price exists', () => {
    const html = buildSubscriptionDetailRows({ trialHours: 0, price: '$29' }).join('\n');
    expect(html).toContain('Billing');
    expect(html).toContain('Monthly billing active');
  });

  it('excludes rows when all params are undefined', () => {
    const html = buildSubscriptionDetailRows({}).join('\n');
    expect(html).toContain('<table');
    expect(html).toContain('</table>');
    expect(html).not.toContain('Compute');
    expect(html).not.toContain('Sessions');
    expect(html).not.toContain('Price');
  });

  it('escapes HTML in monthlyHours', () => {
    const html = buildSubscriptionDetailRows({ monthlyHours: '<img onerror=alert(1)>' }).join('\n');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

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

  it('returns false when API returns non-ok response', async () => {
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
  });

  it('returns false when fetch throws', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network error'));

    const result = await sendEmail({
      to: ['admin@example.com'],
      subject: 'Test',
      html: '<p>Test</p>',
      env: { RESEND_API_KEY: 'key' },
    });

    expect(result).toBe(false);
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
