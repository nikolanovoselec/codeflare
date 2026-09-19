/// <reference types="@cloudflare/vitest-pool-workers/types" />
/** REQ-OPERATOR-025: optional dispatch encryption is independent of edge capability verification. */
import { describe, expect, it } from 'vitest';
import { createWebhookHandoff, openWebhookHandoff } from '../../operators/webhook-handoff';

const context = { deployment: 'enterprise', operatorId: 'operator', activityId: 'activity',
  workflow: 'consumer.yml', revision: 3, expiresAt: Date.now() + 60_000 };
const token = 's'.repeat(43);
const key = btoa('a'.repeat(32)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const wrongKey = btoa('b'.repeat(32)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('REQ-OPERATOR-025: optional encrypted webhook handoff', () => {
  it('encrypts with fresh AES-GCM nonces and exact bound context when a key is configured', async () => {
    const first = await createWebhookHandoff({ startCapability: token, webhookKey: key, context });
    const second = await createWebhookHandoff({ startCapability: token, webhookKey: key, context });
    expect(first).toMatchObject({ mode: 'encrypted', envelope: { version: 1, context } });
    expect(JSON.stringify(first)).not.toContain(token);
    expect(first).not.toEqual(second);
    if (first.mode !== 'encrypted') throw new Error('expected encrypted handoff');
    expect(await openWebhookHandoff(first.envelope, key, context)).toBe(token);
    await expect(openWebhookHandoff(first.envelope, wrongKey, context)).rejects.toThrow(/invalid/i);
    await expect(openWebhookHandoff(first.envelope, key, { ...context, activityId: 'other' })).rejects.toThrow(/invalid/i);
  });

  it('uses the one-time token with a visibility warning only when no key is configured', async () => {
    expect(await createWebhookHandoff({ startCapability: token, context })).toEqual({
      mode: 'token', token,
      warning: 'Webhook dispatch input is visible to people who can access workflow inputs.',
    });
    await expect(createWebhookHandoff({ startCapability: token, webhookKey: 'configured-but-invalid', context }))
      .rejects.toThrow(/invalid/i);
  });
});
