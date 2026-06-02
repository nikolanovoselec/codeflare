import { describe, it, expect } from 'vitest';
import { SetBucketNameBodySchema, SetSessionIdBodySchema } from '../../lib/container-config-schema';

// CF-046
// Direct schema unit tests for the /_internal transport schemas. These were
// previously exercised only indirectly via buildSetBucketNameBody and the DO
// receiver. The schemas are the validation boundary for inbound container
// payloads, so the valid / invalid / nullable-cred shapes are pinned here.

function validBucketNameBody(): Record<string, unknown> {
  return {
    bucketName: 'cf-alice',
    sessionId: 'aabbccdd11223344',
    userEmail: 'alice@example.com',
    r2AccessKeyId: 'AKIA_TEST',
    r2SecretAccessKey: 'secret',
    r2AccountId: 'acct123',
    r2Endpoint: 'https://r2.test',
    tabConfig: [{ id: '1', command: 'claude', label: 'Terminal 1' }],
    workspaceSyncEnabled: true,
    fastStartEnabled: false,
    sessionMode: 'pro',
    sleepAfter: '30m',
  };
}

describe('CF-046: SetBucketNameBodySchema', () => {
  // CF-006: shared transport schema for /_internal/setBucketName
  describe('valid payloads', () => {
    it('accepts a fully-populated valid body', () => {
      const result = SetBucketNameBodySchema.safeParse(validBucketNameBody());
      expect(result.success).toBe(true);
    });

    it('accepts a body with optional API keys present', () => {
      const result = SetBucketNameBodySchema.safeParse({
        ...validBucketNameBody(),
        openaiApiKey: 'sk-openai',
        geminiApiKey: 'gm-key',
        userTimezone: 'Europe/Zurich',
      });
      expect(result.success).toBe(true);
    });

    it('passes through unknown extra fields (.passthrough)', () => {
      const parsed = SetBucketNameBodySchema.parse({
        ...validBucketNameBody(),
        futureField: 'survives',
      });
      expect((parsed as Record<string, unknown>).futureField).toBe('survives');
    });

    it('passes through unknown keys inside tabConfig objects (.passthrough)', () => {
      const parsed = SetBucketNameBodySchema.parse({
        ...validBucketNameBody(),
        tabConfig: [{ id: '1', command: 'claude', label: 'T1', extra: 'kept' }],
      });
      const tab = (parsed.tabConfig as Array<Record<string, unknown>>)[0];
      expect(tab.extra).toBe('kept');
    });
  });

  describe('invalid payloads', () => {
    it('rejects a body missing a required field (bucketName)', () => {
      const { bucketName: _omit, ...rest } = validBucketNameBody();
      const result = SetBucketNameBodySchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it('rejects a non-boolean workspaceSyncEnabled', () => {
      const result = SetBucketNameBodySchema.safeParse({
        ...validBucketNameBody(),
        workspaceSyncEnabled: 'yes',
      });
      expect(result.success).toBe(false);
    });

    it('rejects a non-array tabConfig', () => {
      const result = SetBucketNameBodySchema.safeParse({
        ...validBucketNameBody(),
        tabConfig: { id: '1' },
      });
      expect(result.success).toBe(false);
    });
  });

  // REQ-AGENT-029 AC2: an explicit null deploy credential is a deliberate clear
  // that must validate so it propagates to the container and unsets the value.
  describe('REQ-AGENT-029 AC2: nullable deploy credentials', () => {
    it('accepts null for githubToken / cloudflareApiToken / cloudflareAccountId (explicit clear)', () => {
      const result = SetBucketNameBodySchema.safeParse({
        ...validBucketNameBody(),
        githubToken: null,
        cloudflareApiToken: null,
        cloudflareAccountId: null,
      });
      expect(result.success).toBe(true);
    });

    it('accepts a string githubToken (set, not cleared)', () => {
      const result = SetBucketNameBodySchema.safeParse({
        ...validBucketNameBody(),
        githubToken: 'ghp_token',
      });
      expect(result.success).toBe(true);
    });

    it('accepts the deploy-credential fields being omitted entirely (optional)', () => {
      const result = SetBucketNameBodySchema.safeParse(validBucketNameBody());
      expect(result.success).toBe(true);
    });

    it('rejects a numeric githubToken (nullable string, not coerced)', () => {
      const result = SetBucketNameBodySchema.safeParse({
        ...validBucketNameBody(),
        githubToken: 123,
      });
      expect(result.success).toBe(false);
    });
  });
});

// TD5: receiver-side schema for /_internal/setSessionId
describe('CF-046: SetSessionIdBodySchema', () => {
  it('accepts a string sessionId', () => {
    const result = SetSessionIdBodySchema.safeParse({ sessionId: 'aabbccdd11223344' });
    expect(result.success).toBe(true);
  });

  it('accepts an absent sessionId (idempotent no-op contract)', () => {
    const result = SetSessionIdBodySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects a non-string sessionId (no silent coercion)', () => {
    const result = SetSessionIdBodySchema.safeParse({ sessionId: 42 });
    expect(result.success).toBe(false);
  });
});
