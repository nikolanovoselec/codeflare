/// <reference types="@cloudflare/vitest-pool-workers/types" />
/** REQ-OPERATOR-006: optional dispatch encryption is independent of edge capability verification. */
import { describe, expect, it } from 'vitest';
import { createWebhookHandoff, openWebhookHandoff } from '../../operators/webhook-handoff';

const context = { deployment: 'enterprise', operatorId: 'operator', activityId: 'activity',
  workflow: 'consumer.yml', revision: 3, expiresAt: Date.now() + 60_000 };
const token = 's'.repeat(43);
const key = 'a'.repeat(43);

describe('REQ-OPERATOR-006: optional encrypted webhook handoff', () => {
  it('encrypts with fresh AES-GCM nonces and exact bound context when a key is configured', async () => {
    const first = await createWebhookHandoff({ startCapability: token, webhookKey: key, context });
    const second = await createWebhookHandoff({ startCapability: token, webhookKey: key, context });
    expect(first).toMatchObject({ mode: 'encrypted', envelope: { version: 1, context } });
    expect(JSON.stringify(first)).not.toContain(token);
    expect(first).not.toEqual(second);
    if (first.mode !== 'encrypted') throw new Error('expected encrypted handoff');
    expect(await openWebhookHandoff(first.envelope, key, context)).toBe(token);
    await expect(openWebhookHandoff(first.envelope, 'b'.repeat(43), context)).rejects.toThrow('invalid');
    await expect(openWebhookHandoff(first.envelope, key, { ...context, activityId: 'other' })).rejects.toThrow('invalid');
  });

  it('uses the one-time token with a visibility warning only when no key is configured', async () => {
    expect(await createWebhookHandoff({ startCapability: token, context })).toEqual({
      mode: 'token', token,
      warning: 'Webhook dispatch input is visible to people who can access workflow inputs.',
    });
    await expect(createWebhookHandoff({ startCapability: token, webhookKey: 'configured-but-invalid', context }))
      .rejects.toThrow('invalid');
  });
});
