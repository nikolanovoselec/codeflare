import { afterEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeOperatorActivities, getOperatorActivity, listOperatorActivities } from '../../api/operator-activities';

const detail = { activityId: 'activity-1', operatorId: 'reviewer', executionStatus: 'completed',
  cleanupStatus: 'stopped', collectionStatus: 'ready', attention: false, sessionId: null, source: null,
  updatedAt: '2026-09-28T00:00:00.000Z', checkpoint: null,
  result: { originalReports: [{ lane: 'code-reviewer', findings: [{ message: 'Review finding' }] }] } };

afterEach(() => vi.unstubAllGlobals());

describe('REQ-OPERATOR-041: in-app owned result read', () => {
  it('REQ-OPERATOR-059: acknowledges the observed summary revision with authenticated CSRF POST', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ unreadCount: 0 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);
    expect(await acknowledgeOperatorActivities(4)).toEqual({ unreadCount: 0 });
    expect(fetch).toHaveBeenCalledWith('/api/operator-activities/read', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', redirect: 'manual', body: JSON.stringify({ through: 4 }),
      headers: expect.objectContaining({ 'X-Requested-With': 'XMLHttpRequest' }),
    }));
  });
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

describe('REQ-OPERATOR-085: evidence-qualified cleanup wire', () => {
  const releasedDetail = { ...detail, operatorId: 'dispatcher', cleanupStatus: 'released',
    collectionStatus: 'consumed', sdkCleanupReleased: true };
  const response = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

  it('REQ-OPERATOR-085: accepts confirmed SDK release without claiming physical cessation', async () => {
    vi.stubGlobal('fetch', async () => response(releasedDetail));
    const value = await getOperatorActivity('activity-1');
    expect(value).toMatchObject({ executionStatus: 'completed', collectionStatus: 'consumed',
      cleanupStatus: 'released', sdkCleanupReleased: true });
    expect(value.result).toEqual(detail.result);
  });

  it.each(['false', 'missing'])('REQ-OPERATOR-085: rejects %s SDK release confirmation', async fault => {
    const invalid: Record<string, unknown> = { ...releasedDetail };
    if (fault === 'missing') delete invalid.sdkCleanupReleased;
    else invalid.sdkCleanupReleased = false;
    vi.stubGlobal('fetch', async () => response(invalid));
    await expect(getOperatorActivity('activity-1')).rejects.toBeDefined();
  });

  it('REQ-OPERATOR-085: accepts a server-confirmed released owner summary', async () => {
    const summary = { activityId: 'activity-1', operatorId: 'dispatcher', executionStatus: 'completed',
      cleanupStatus: 'released', collectionStatus: 'consumed', attention: false, sessionId: null,
      source: null, updatedAt: detail.updatedAt };
    vi.stubGlobal('fetch', async () => response({ items: [summary], nextCursor: null,
      workingCount: 0, unreadCount: 0, latestSequence: 1 }));
    expect(await listOperatorActivities()).toEqual({ items: [summary], nextCursor: null,
      workingCount: 0, unreadCount: 0, latestSequence: 1 });
  });
});

describe('REQ-OPERATOR-086 AC3: bounded optional owner outcome metadata wire', () => {
  const summary = { activityId: 'activity-1', operatorId: 'dispatcher', executionStatus: 'completed',
    cleanupStatus: 'pending', collectionStatus: 'ready', attention: false, sessionId: null, source: null,
    updatedAt: detail.updatedAt, version: '0.1.27', resultSummary: { assessed: 4, merged: 1, notMerged: 1, deferred: 1, unknown: 1 } };
  const respond = (item: unknown) => vi.stubGlobal('fetch', async () => Response.json({ items: [item], nextCursor: null,
    workingCount: 0, unreadCount: 0, latestSequence: 1 }));
  it('accepts safe optional version and outcome quantities without requesting result bytes', async () => {
    respond(summary);
    expect(await listOperatorActivities()).toMatchObject({ items: [summary] });
  });
  it.each(['negative', 'contradiction', 'unsafeInteger', 'excessive'])('rejects invalid outcome metadata: %s', async fault => {
    const changed = structuredClone(summary);
    if (fault === 'negative') changed.resultSummary.merged = -1;
    if (fault === 'contradiction') changed.resultSummary.assessed = 3;
    if (fault === 'unsafeInteger') changed.resultSummary.assessed = Number.MAX_SAFE_INTEGER + 1;
    if (fault === 'excessive') changed.resultSummary = { assessed: 1025, merged: 1025, notMerged: 0, deferred: 0, unknown: 0 };
    respond(changed);
    await expect(listOperatorActivities()).rejects.toBeDefined();
  });
});

describe('REQ-OPERATOR-041: AC7 retired-effect-receipts.v1 client wire', () => {
  const receipt = { version: 1, activityId: 'activity-1', generation: 1, inputDigest: 'a'.repeat(64),
    artifactDigest: 'b'.repeat(64), admissionDigest: 'c'.repeat(64), scan: 'complete', pageStatus: 'complete',
    journalCount: 1, inspectedEntries: 1, unresolvedJournalEntries: 0, unclassifiedEntries: 0,
    nextAfterOrdinal: null, items: [{ ordinal: 0, operationDigest: 'd'.repeat(64), requestDigest: 'e'.repeat(64),
      responseDigest: 'f'.repeat(64), journalPhase: 'completed', binding: 'verified', method: 'POST', effect: 'comment',
      phaseIndex: 0, submissionDigest: '1'.repeat(64), deliveryDigest: '2'.repeat(64),
      target: { repository: 'owner/repo', pullRequest: 17, headSha: '3'.repeat(40) },
      observedResponse: { kind: 'comment', status: 201, commentId: 91, responseBodyDigest: '4'.repeat(64) } }] };
  const response = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  it('accepts validated optional receipts without consuming or losing original result data', async () => {
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url !== '/api/operator-activities/activity-1/result' || init?.credentials !== 'same-origin' || init?.method === 'POST')
        return new Response(null, { status: 403 });
      return response({ ...detail, effectReceipts: receipt });
    });
    expect(await getOperatorActivity('activity-1')).toMatchObject({ result: detail.result, effectReceipts: receipt });
  });
  it.each(['extra', 'digest', 'id', 'sha', 'version', 'tooMany', 'falseSuccess', 'foreignActivity', 'badCursor']) (
    'rejects malformed or contradictory receipt claims: %s', async fault => {
      const invalid = structuredClone(receipt);
      if (fault === 'extra') Object.assign(invalid.items[0], { privateBody: 'PRIVATE_VALUE' });
      if (fault === 'digest') invalid.inputDigest = 'invalid';
      if (fault === 'id') invalid.items[0].observedResponse.commentId = Number.MAX_SAFE_INTEGER + 1;
      if (fault === 'sha') invalid.items[0].target.headSha = 'invalid';
      if (fault === 'version') invalid.version = 2;
      if (fault === 'tooMany') invalid.items = Array.from({ length: 9 }, () => structuredClone(receipt.items[0]));
      if (fault === 'falseSuccess') invalid.items[0].journalPhase = 'unknown';
      if (fault === 'foreignActivity') invalid.activityId = 'foreign-activity';
      if (fault === 'badCursor') Object.assign(invalid, { pageStatus: 'more', nextAfterOrdinal: null });
      vi.stubGlobal('fetch', async () => response({ ...detail, effectReceipts: invalid }));
      await expect(getOperatorActivity('activity-1')).rejects.toBeDefined();
    });
  it.each(['ordinalOutsideCompleteJournal', 'itemInEmptyJournal', 'itemsExceedInspectedMetadata']) (
    'REQ-OPERATOR-041: AC7 rejects impossible receipt coordinates: %s', async fault => {
      const invalid = structuredClone(receipt);
      if (fault === 'ordinalOutsideCompleteJournal') invalid.items[0].ordinal = 1;
      if (fault === 'itemInEmptyJournal') { invalid.journalCount = 0; invalid.inspectedEntries = 0; }
      if (fault === 'itemsExceedInspectedMetadata') {
        invalid.journalCount = 2;
        invalid.scan = 'partial'; invalid.pageStatus = 'partial';
        invalid.items = [invalid.items[0], { ...structuredClone(invalid.items[0]), ordinal: 1 }];
      }
      vi.stubGlobal('fetch', async () => response({ ...detail, effectReceipts: invalid }));
      await expect(getOperatorActivity('activity-1')).rejects.toBeDefined();
    });
  it('REQ-OPERATOR-041: AC7 preserves explicitly partial evidence with inconsistent journal counters', async () => {
    const partial = structuredClone(receipt);
    partial.scan = 'partial'; partial.pageStatus = 'partial'; partial.items[0].ordinal = 2;
    vi.stubGlobal('fetch', async () => response({ ...detail, effectReceipts: partial }));
    expect(await getOperatorActivity('activity-1')).toMatchObject({ result: detail.result, effectReceipts: partial });
  });
  it('accepts explicit unavailable evidence without fabricating successful effects', async () => {
    const unavailable = { version: 1, activityId: 'activity-1', scan: 'unavailable', pageStatus: 'unavailable',
      journalCount: null, inspectedEntries: 0, unresolvedJournalEntries: null, unclassifiedEntries: 0,
      items: [], nextAfterOrdinal: null };
    vi.stubGlobal('fetch', async () => response({ ...detail, effectReceipts: unavailable }));
    expect(await getOperatorActivity('activity-1')).toMatchObject({ result: detail.result, effectReceipts: unavailable });
  });
});
