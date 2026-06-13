import { describe, it, expect, vi } from 'vitest';
import { buildContactPayload, submitContact, pickDeepLinkTopic } from '../scripts/contact-controller';
import { CONTACT_TOPICS } from '../../../src/lib/contact-topics';

function formDataFrom(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    data.set(key, value);
  }
  return data;
}

describe('contact-controller (REQ-LANDING-002)', () => {
  describe('buildContactPayload', () => {
    it('builds a payload from form fields plus the turnstile token', () => {
      const payload = buildContactPayload(
        formDataFrom({
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          company: 'Analytical Engines AG',
          topic: 'enterprise-deployment',
          message: 'We want to evaluate Codeflare for 200 engineers.',
        }),
        'ts-token-123'
      );

      expect(payload).toEqual({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        company: 'Analytical Engines AG',
        topic: 'enterprise-deployment',
        message: 'We want to evaluate Codeflare for 200 engineers.',
        turnstileToken: 'ts-token-123',
      });
    });

    it('omits company entirely when left blank so JSON serialization drops it', () => {
      const payload = buildContactPayload(
        formDataFrom({
          name: 'Ada',
          email: 'ada@example.com',
          company: '',
          topic: 'general',
          message: 'A message long enough to pass.',
        }),
        't'
      );

      expect('company' in JSON.parse(JSON.stringify(payload))).toBe(false);
    });

    it('only ever produces topics the backend schema accepts', () => {
      for (const topic of CONTACT_TOPICS) {
        const payload = buildContactPayload(
          formDataFrom({ name: 'A', email: 'a@b.co', topic, message: 'Long enough message.' }),
          't'
        );
        expect(CONTACT_TOPICS).toContain(payload.topic);
      }
    });
  });

  describe('submitContact', () => {
    const payload = buildContactPayload(
      formDataFrom({
        name: 'Ada',
        email: 'ada@example.com',
        topic: 'general',
        message: 'A perfectly valid message.',
      }),
      'token'
    );

    it('POSTs JSON to /public/contact and reports success', async () => {
      const fetchFn = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));

      const result = await submitContact(payload, fetchFn as unknown as typeof fetch);

      expect(result.ok).toBe(true);
      expect(result.message.toLowerCase()).toContain('thank you');
      expect(fetchFn).toHaveBeenCalledWith(
        '/public/contact',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      );
    });

    it('surfaces the API error message on a rejected submission', async () => {
      const fetchFn = vi.fn(
        async () => new Response(JSON.stringify({ error: 'CAPTCHA verification failed' }), { status: 400 })
      );

      const result = await submitContact(payload, fetchFn as unknown as typeof fetch);

      expect(result.ok).toBe(false);
      expect(result.message).toBe('CAPTCHA verification failed');
    });

    it('falls back to a generic message when the error body is not JSON', async () => {
      const fetchFn = vi.fn(async () => new Response('<html>502</html>', { status: 502 }));

      const result = await submitContact(payload, fetchFn as unknown as typeof fetch);

      expect(result.ok).toBe(false);
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.message).not.toContain('<html>');
    });

    it('reports a network failure without throwing', async () => {
      const fetchFn = vi.fn(async () => {
        throw new TypeError('fetch failed');
      });

      const result = await submitContact(payload, fetchFn as unknown as typeof fetch);

      expect(result.ok).toBe(false);
      expect(result.message.toLowerCase()).toContain('network');
    });
  });

  describe('pickDeepLinkTopic', () => {
    it('returns the topic when the query value is an allowed option (the enterprise CTA path)', () => {
      expect(pickDeepLinkTopic('?topic=enterprise-deployment', CONTACT_TOPICS)).toBe('enterprise-deployment');
    });

    it('ignores a topic that is not an allowed option (a crafted URL cannot inject one)', () => {
      expect(pickDeepLinkTopic('?topic=delete-everything', CONTACT_TOPICS)).toBeNull();
    });

    it('returns null when no topic param is present', () => {
      expect(pickDeepLinkTopic('?utm=x', CONTACT_TOPICS)).toBeNull();
      expect(pickDeepLinkTopic('', CONTACT_TOPICS)).toBeNull();
    });

    it('only ever returns a value the backend schema accepts', () => {
      for (const topic of CONTACT_TOPICS) {
        const picked = pickDeepLinkTopic(`?topic=${topic}`, CONTACT_TOPICS);
        expect(picked).not.toBeNull();
        expect(CONTACT_TOPICS).toContain(picked!);
      }
    });
  });
});
