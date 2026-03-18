import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendEmail } from '../../lib/email';

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
        WAITLIST_FROM_EMAIL: 'Codeflare <noreply@example.com>',
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
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network error'));

    const result = await sendEmail({
      to: ['admin@example.com'],
      subject: 'Test',
      html: '<p>Test</p>',
      env: { RESEND_API_KEY: 'key' },
    });

    expect(result).toBe(false);
  });

  it('uses default from address when WAITLIST_FROM_EMAIL is not set', async () => {
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
