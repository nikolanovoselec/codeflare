import { describe, expect, it } from 'vitest';
import { applicationWire, fixture, remoteMutations, start, writableApplication } from './fixtures/dispatcher-production';

const headSha = 'b'.repeat(40);
const target = { repository: 'owner/repository', pullRequest: 17, headSha };

// The displaced assessment assertions have actual package equivalents in
// codeflare-operator-dispatcher/test/renovate/renovate.test.ts:
// "assesses only bounded authorized Renovate PR and CI evidence through parent-bound reads"
// and "makes an observed stale head, truncated diff, and rate-limited evidence explicit in the assessment".
// Root proves retirement here, not those domain outcomes.
describe('REQ-OPERATOR-051: retired Renovate Dispatcher assessment', () => {
  it.each([
    { name: 'complete evidence', body: { ...target, bot: 'renovate[bot]',
      checks: [{ name: 'tests', conclusion: 'success' }], diff: { files: 2, bytes: 1024, truncated: false } } },
    { name: 'stale incomplete evidence', body: { ...target, headSha: 'c'.repeat(40), bot: 'renovate[bot]', checks: [],
      diff: { files: 300, bytes: 2_000_000, truncated: true }, evidence: { rateLimited: true } } },
    { name: 'foreign bot', body: { ...target, bot: 'dependabot[bot]' } },
    { name: 'repository mutation', body: { ...target, mutation: { method: 'POST', path: '/merge' } } },
    { name: 'session creation', body: { ...target, createSession: true } },
    { name: 'container creation', body: { ...target, createContainer: true } },
    { name: 'unattended rerun', body: { ...target, schedule: 'hourly' } },
  ])('refuses $name without I/O or an assessment and preserves generic source authority', ({ body }) => fixture(async f => {
    await start(f);
    const source = { operationId: 'original-evidence', url: 'https://api.github.com/repos/another/service' };
    const original = await f.capability.fetch(applicationWire(f, 'source', source));
    expect(original.status).toBe(200);
    const bytes = await original.text();
    const receipt = async () => {
      const response = await f.capability.fetch(applicationWire(f, 'receipt', { operationId: source.operationId }));
      expect(response.status).toBe(200);
      return response.json();
    };
    const before = await receipt();
    expect(before).toMatchObject({ phase: 'completed', operationCount: 1 });
    const sent = [...f.sent];
    for (const reload of [false, true]) {
      if (reload) f.restart();
      const denied = await f.capability.fetch(applicationWire(f, 'renovate', body));
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED', reason: 'request-invalid', disposition: 'operation-local' });
      expect(await receipt()).toEqual(before);
      const cached = await f.capability.fetch(applicationWire(f, 'source', source));
      expect(cached.status).toBe(200);
      expect(await cached.text()).toBe(bytes);
      expect(f.sent).toEqual(sent);
      expect(remoteMutations(f)).toEqual([]);
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    }
    const corrected = await f.capability.fetch(applicationWire(f, 'source', { ...source, operationId: 'supported-after-refusal' }));
    expect(corrected.status).toBe(200);
    expect(await corrected.text()).toBe(bytes);
    expect(await receipt()).toMatchObject({ operationCount: 2 });
  }, writableApplication));
});
