import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOperatorActivity } from '../../api/operator-activities';

const detail = { activityId: 'activity-1', operatorId: 'reviewer', executionStatus: 'completed',
  cleanupStatus: 'stopped', collectionStatus: 'ready', attention: false, sessionId: null, source: null,
  updatedAt: '2026-09-28T00:00:00.000Z', checkpoint: null,
  result: { originalReports: [{ lane: 'code-reviewer', findings: [{ message: 'Review finding' }] }] } };

afterEach(() => vi.unstubAllGlobals());

describe('REQ-OPERATOR-041: in-app owned result read', () => {
  it('reads owned result through the authenticated non-consuming GET', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(detail), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);

    expect(await getOperatorActivity('activity-1')).toMatchObject({
      activityId: 'activity-1', result: detail.result,
    });
    expect(fetch).toHaveBeenCalledWith('/api/operator-activities/activity-1/result',
      expect.objectContaining({ credentials: 'same-origin', redirect: 'manual' }));
  });

  it('does not treat an unowned result as an empty owned result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    })));
    await expect(getOperatorActivity('foreign-activity')).rejects.toMatchObject({ status: 404 });
  });
});
