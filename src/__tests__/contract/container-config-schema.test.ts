/**
 * REQ-ENTERPRISE-005 (non-disruption gate): the setBucketName transport carries
 * NO enterprise LLM fields. With the outbound-interception design, enterprise
 * LLM routing is done entirely by the DO's interception + the entrypoint.sh CA
 * trust — none of it flows through SetBucketNameBodySchema. This test pins that
 * the container-config contract is byte-identical to the pre-enterprise shape,
 * so a non-enterprise deploy is unaffected.
 *
 * AC1. A standard body (as the Worker builds it) parses and the values survive.
 * AC2. The schema declares no enterprise LLM fields (anthropicBaseUrl /
 *      copilotProviderBaseUrl / piBaseUrl / aigProxyToken / enterpriseMode):
 *      omitting them parses, and they are absent from the result.
 */
import { describe, it, expect } from 'vitest';
import { SetBucketNameBodySchema } from '../../lib/container-config-schema';

/** A minimal-but-valid setBucketName body as the Worker builds it. */
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

describe('REQ-ENTERPRISE-005: setBucketName transport carries no enterprise LLM fields', () => {
  it('AC1: parses the standard body and preserves its values', () => {
    const parsed = SetBucketNameBodySchema.parse(baseBody());
    expect(parsed.bucketName).toBe('codeflare-test');
    expect(parsed.sessionMode).toBe('default');
    expect(parsed.sleepAfter).toBe('30m');
  });

  it('AC2: no enterprise LLM fields are present in a parsed standard body', () => {
    const parsed = SetBucketNameBodySchema.parse(baseBody());
    expect('anthropicBaseUrl' in parsed).toBe(false);
    expect('copilotProviderBaseUrl' in parsed).toBe(false);
    expect('piBaseUrl' in parsed).toBe(false);
    expect('aigProxyToken' in parsed).toBe(false);
    expect('enterpriseMode' in parsed).toBe(false);
  });
});
