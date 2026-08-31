import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReportArtifacts, reportIdempotencyKey, scheduledDispatchId, testDispatchId } from '../../lib/usage-reports';
import { sendUsageReportEmail } from '../../lib/email';

afterEach(() => vi.unstubAllGlobals());

describe('usage report artifacts and email boundary (REQ-SUB-027)', () => {
  it('builds one escaped summary and exact deterministic CSV', () => {
    const report = buildReportArtifacts('2027-07', [
      { email: 'a+one@example.com', runtimeSeconds: 61, sessionCount: 2 },
      { email: '<ops>@example.com', runtimeSeconds: 3600, sessionCount: 1 },
    ]);
    expect(report.html).toContain('&lt;ops&gt;@example.com');
    expect(report.html).not.toContain('<ops>');
    expect(report.csv).toBe('email,runtime_seconds,session_count\r\n<ops>@example.com,3600,1\r\na+one@example.com,61,2\r\n');
  });

  it('separates scheduled and repeated test dispatch identities', () => {
    expect(scheduledDispatchId(7, '2027-07')).toBe('scheduled:7:2027-07');
    expect(testDispatchId('request-a')).not.toBe(testDispatchId('request-b'));
    expect(reportIdempotencyKey(7, '2027-07', ' Admin@Example.com ')).toBe(reportIdempotencyKey(7, '2027-07', 'admin@example.com'));
  });

  it('sends one bounded CSV attachment with deterministic idempotency', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendUsageReportEmail({
      recipient: 'admin@example.com', reportMonth: '2027-07', html: '<p>summary</p>', csv: 'email,runtime_seconds,session_count\r\n',
      idempotencyKey: 'usage-report:7:2027-07:admin@example.com', env: { RESEND_API_KEY: 'key', RESEND_EMAIL: 'reports@example.com' },
    })).resolves.toBe('accepted');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toEqual(['admin@example.com']);
    expect(body.attachments).toHaveLength(1);
    expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toBe('usage-report:7:2027-07:admin@example.com');
  });

  it('fails closed for absent provider configuration and oversized attachments', async () => {
    await expect(sendUsageReportEmail({ recipient: 'a@example.com', reportMonth: '2027-07', html: '', csv: '', idempotencyKey: 'x', env: {} }))
      .resolves.toBe('provider_unavailable');
    await expect(sendUsageReportEmail({ recipient: 'a@example.com', reportMonth: '2027-07', html: '', csv: 'x'.repeat(8 * 1024 * 1024 + 1), idempotencyKey: 'x', env: { RESEND_API_KEY: 'key' } }))
      .resolves.toBe('attachment_too_large');
  });
});
