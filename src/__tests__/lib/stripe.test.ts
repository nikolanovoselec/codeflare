import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getStripePriceId,
  resolveTierFromPriceId,
  isStripeConfigured,
  verifyWebhookSignature,
  createCheckoutSession,
  parseStripeEvent,
} from '../../lib/stripe';

describe('getStripePriceId', () => {
  it('returns correct price ID for standard/default', () => {
    expect(getStripePriceId('standard', 'default')).toBe('price_1TEd7TLQzoadEf8HOKThTum9');
  });

  it('returns correct price ID for standard/advanced', () => {
    expect(getStripePriceId('standard', 'advanced')).toBe('price_1TEd7TLQzoadEf8HgRwmmrpo');
  });

  it('returns correct price ID for advanced/default', () => {
    expect(getStripePriceId('advanced', 'default')).toBe('price_1TEd7ULQzoadEf8H2yUwbrky');
  });

  it('returns correct price ID for max/advanced', () => {
    expect(getStripePriceId('max', 'advanced')).toBe('price_1TEd7VLQzoadEf8H8ZUi7m4t');
  });

  it('returns null for free tier', () => {
    expect(getStripePriceId('free', 'default')).toBeNull();
  });

  it('returns null for unknown tier', () => {
    expect(getStripePriceId('super-mega', 'default')).toBeNull();
  });

  it('returns null for unknown mode', () => {
    expect(getStripePriceId('standard', 'unknown')).toBeNull();
  });
});

describe('resolveTierFromPriceId', () => {
  it('resolves standard/default from price ID', () => {
    expect(resolveTierFromPriceId('price_1TEd7TLQzoadEf8HOKThTum9')).toEqual({ tier: 'standard', mode: 'default' });
  });

  it('resolves max/advanced from price ID', () => {
    expect(resolveTierFromPriceId('price_1TEd7VLQzoadEf8H8ZUi7m4t')).toEqual({ tier: 'max', mode: 'advanced' });
  });

  it('returns null for unknown price ID', () => {
    expect(resolveTierFromPriceId('price_unknown_123')).toBeNull();
  });
});

describe('isStripeConfigured', () => {
  it('returns true when STRIPE_SECRET_KEY is set', () => {
    expect(isStripeConfigured({ STRIPE_SECRET_KEY: 'sk_test_123' })).toBe(true);
  });

  it('returns false when STRIPE_SECRET_KEY is undefined', () => {
    expect(isStripeConfigured({ STRIPE_SECRET_KEY: undefined })).toBe(false);
  });

  it('returns false when STRIPE_SECRET_KEY is empty string', () => {
    expect(isStripeConfigured({ STRIPE_SECRET_KEY: '' })).toBe(false);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'whsec_test_secret';

  async function generateSignature(body: string, timestampOverride?: number): Promise<string> {
    const timestamp = timestampOverride ?? Math.floor(Date.now() / 1000);
    const payload = `${timestamp}.${body}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signatureBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    const hex = Array.from(new Uint8Array(signatureBytes))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `t=${timestamp},v1=${hex}`;
  }

  it('accepts valid signature', async () => {
    const body = '{"test":"data"}';
    const sig = await generateSignature(body);
    const result = await verifyWebhookSignature(body, sig, secret);
    expect(result).toBe(true);
  });

  it('rejects invalid signature', async () => {
    const body = '{"test":"data"}';
    const sig = `t=${Math.floor(Date.now() / 1000)},v1=invalidsignaturehex`;
    const result = await verifyWebhookSignature(body, sig, secret);
    expect(result).toBe(false);
  });

  it('rejects expired timestamp', async () => {
    const body = '{"test":"data"}';
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const sig = await generateSignature(body, oldTimestamp);
    const result = await verifyWebhookSignature(body, sig, secret);
    expect(result).toBe(false);
  });

  it('rejects missing timestamp', async () => {
    const result = await verifyWebhookSignature('body', 'v1=abc', secret);
    expect(result).toBe(false);
  });

  it('rejects missing v1 signature', async () => {
    const result = await verifyWebhookSignature('body', `t=${Math.floor(Date.now() / 1000)}`, secret);
    expect(result).toBe(false);
  });
});

describe('createCheckoutSession', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends correct Stripe API call and returns id + url', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'cs_test_123', url: 'https://checkout.stripe.com/test' }), { status: 200 }),
    ) as typeof globalThis.fetch;

    const result = await createCheckoutSession({
      priceId: 'price_test_123',
      customerEmail: 'user@example.com',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      secretKey: 'sk_test_key',
    });

    expect(result).toEqual({ id: 'cs_test_123', url: 'https://checkout.stripe.com/test' });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(fetchCall[1].method).toBe('POST');
    expect(fetchCall[1].headers['Authorization']).toBe('Bearer sk_test_key');
  });

  it('throws on Stripe API error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'Invalid price' } }), { status: 400 }),
    ) as typeof globalThis.fetch;

    await expect(createCheckoutSession({
      priceId: 'price_invalid',
      customerEmail: 'user@example.com',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      secretKey: 'sk_test_key',
    })).rejects.toThrow('Invalid price');
  });
});

describe('parseStripeEvent', () => {
  it('parses valid event', () => {
    const raw = JSON.stringify({
      id: 'evt_123',
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_123' } },
    });
    const event = parseStripeEvent(raw);
    expect(event.id).toBe('evt_123');
    expect(event.type).toBe('checkout.session.completed');
    expect(event.data.object.customer).toBe('cus_123');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseStripeEvent('not json')).toThrow();
  });

  it('throws on missing required fields', () => {
    expect(() => parseStripeEvent(JSON.stringify({ id: 'evt_123' }))).toThrow('Invalid Stripe event payload');
  });
});
