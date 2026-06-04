/**
 * REQ-ENTERPRISE-005: SetBucketNameBodySchema must accept the 5 optional
 * LLM-proxy fields (anthropicBaseUrl / copilotProviderBaseUrl / piBaseUrl /
 * aigProxyToken / enterpriseMode) when present, and continue to parse existing
 * bodies that omit them (non-enterprise deploys, flag-off regression).
 *
 * AC1. A body carrying the 5 fields parses and the values survive.
 * AC2. A body WITHOUT the 5 fields still parses (existing contract unchanged).
 * AC3. The 5 fields are optional - omitting them does not introduce them as
 *      undefined keys that would break the truthy spread downstream.
 */
import { describe, it, expect } from 'vitest';
import { SetBucketNameBodySchema } from '../../lib/container-config-schema';

/** A minimal-but-valid setBucketName body as the Worker builds today (no enterprise fields). */
function baseBody() {
  return {
    bucketName: 'codeflare-test',
    sessionId: 'sid-abcdef12',
    userEmail: 'user@example.com',
    r2AccessKeyId: 'AK',
    r2SecretAccessKey: 'SK',
    r2AccountId: 'acc',
    r2Endpoint: 'https://r2.test',
    tabConfig: [],
    workspaceSyncEnabled: false,
    fastStartEnabled: true,
    sessionMode: 'default',
    sleepAfter: '30m',
  };
}

describe('REQ-ENTERPRISE-005: SetBucketNameBodySchema LLM-proxy fields', () => {
  it('AC1: parses a body carrying all 5 LLM-proxy fields and preserves them', () => {
    const parsed = SetBucketNameBodySchema.parse({
      ...baseBody(),
      anthropicBaseUrl: 'https://w/api/llm/sid/anthropic',
      copilotProviderBaseUrl: 'https://w/api/llm/sid/compat',
      piBaseUrl: 'https://w/api/llm/sid/compat',
      aigProxyToken: 'signed.proxy.token',
      enterpriseMode: 'active',
    });
    expect(parsed.anthropicBaseUrl).toBe('https://w/api/llm/sid/anthropic');
    expect(parsed.copilotProviderBaseUrl).toBe('https://w/api/llm/sid/compat');
    expect(parsed.piBaseUrl).toBe('https://w/api/llm/sid/compat');
    expect(parsed.aigProxyToken).toBe('signed.proxy.token');
    expect(parsed.enterpriseMode).toBe('active');
  });

  it('AC2: parses an existing body WITHOUT the LLM-proxy fields (flag-off regression)', () => {
    const parsed = SetBucketNameBodySchema.parse(baseBody());
    expect(parsed.bucketName).toBe('codeflare-test');
    expect(parsed.sessionMode).toBe('default');
    expect(parsed.sleepAfter).toBe('30m');
  });

  it('AC3: the LLM-proxy fields are absent (not undefined keys) when omitted', () => {
    const parsed = SetBucketNameBodySchema.parse(baseBody());
    expect('anthropicBaseUrl' in parsed).toBe(false);
    expect('aigProxyToken' in parsed).toBe(false);
    expect('enterpriseMode' in parsed).toBe(false);
  });

  it('AC1: a partial set of fields (only enterpriseMode) still parses', () => {
    const parsed = SetBucketNameBodySchema.parse({
      ...baseBody(),
      enterpriseMode: 'active',
    });
    expect(parsed.enterpriseMode).toBe('active');
    expect('anthropicBaseUrl' in parsed).toBe(false);
  });
});
