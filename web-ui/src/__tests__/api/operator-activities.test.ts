import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createComponent } from 'solid-js';
import OperatorActivityButton from '../../components/OperatorActivityButton';
import { acknowledgeOperatorActivities, cancelOperatorActivity, getOperatorActivity, listOperatorActivities } from '../../api/operator-activities';
import { listOperatorInstallations } from '../../api/operator-management';
import { diagnosticRecordSchema } from '../../api/operator-diagnostics-wire';

const detail = { activityId: 'activity-1', operatorId: 'reviewer', executionStatus: 'completed',
  cleanupStatus: 'stopped', collectionStatus: 'ready', attention: false, sessionId: null, source: null,
  updatedAt: '2026-09-28T00:00:00.000Z', checkpoint: null,
  result: { originalReports: [{ lane: 'code-reviewer', findings: [{ message: 'Review finding' }] }] } };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('REQ-OPERATOR-080/081: public SDK diagnostic browser wire', () => {
  const record = { kind: 'event', id: 'e-1', sequence: 1, generation: 1, timestamp: 1700000000000,
    owner: 'sdk', boundary: 'delivery', outcome: 'started', code: 'none', evidence: 'observed', origin: 'state-transition',
    correlation: { submissionDigest: 'a'.repeat(64), rootDigest: 'b'.repeat(64) },
    source: { package: '@flue/runtime', boundary: 'delivery', baseVersion: '2.3.0', patchSetDigest: null, status: 'partial', frames: [] },
    publicSdk: { kind: 'event', eventType: 'submission_running', eventIndex: 1, attemptCount: 2, maxAttempts: 4 } };
  it('accepts bounded public counters without claiming private SDK coordinates', () => {
    expect(diagnosticRecordSchema.parse(record)).toEqual(record);
  });
  it('rejects a public observation claiming an unrelated native attempt identity', () => {
    expect(diagnosticRecordSchema.safeParse({ ...record,
      correlation: { ...record.correlation, sdkAttemptDigest: 'c'.repeat(64) } }).success).toBe(false);
  });
});

describe('REQ-OPERATOR-086 AC2/5: five-entry installation page wire', () => {
  const installation = (index: number) => ({ id: `installation-${index}`, operatorId: 'operator-1', name: 'Review',
    installationName: `Configuration ${index}`, version: null, revision: 1, enabled: false, approved: false,
    canInvoke: true, canManage: false, guidedMode: null, repository: null, automaticRuns: null, repetitionIntervalSeconds: null });

  it.each([null, 'installation-5'])('reads five installations using the authenticated opaque cursor %s', async cursor => {
    const items = Array.from({ length: 5 }, (_, index) => installation(index + (cursor ? 6 : 1)));
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== window.location.origin || url.pathname !== '/api/operator-activities/installations'
        || url.searchParams.get('cursor') !== cursor || request.method !== 'GET' || request.credentials !== 'same-origin') {
        return Response.json({ error: 'Invalid installation read' }, { status: 403 });
      }
      return Response.json({ items, cursor: cursor ? null : 'installation-5' });
    });
    expect(await listOperatorInstallations(cursor)).toEqual({ items, cursor: cursor ? null : 'installation-5' });
  });

  it('rejects a six-installation response rather than silently showing a different page size', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ items: Array.from({ length: 6 }, (_, index) => installation(index + 1)), cursor: null }));
    await expect(listOperatorInstallations()).rejects.toBeDefined();
  });
});

it('REQ-OPERATOR-086 AC3: paging summary rows uses only summary and acknowledgement endpoints', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${url.pathname}`);
    if (method === 'GET' && url.pathname === '/api/operator-activities' && url.searchParams.get('limit') === '5') {
      const older = url.searchParams.get('after') === 'run-1';
      return Response.json({ items: [{ activityId: older ? 'run-2' : 'run-1', operatorId: 'dispatcher',
        operatorName: 'Dispatcher', version: 'v1.2.3', executionStatus: 'completed', cleanupStatus: 'released',
        collectionStatus: 'consumed', attention: false, sessionId: null, source: null, updatedAt: '2026-11-09T00:00:00.000Z',
        resultSummary: { assessed: 3, merged: 1, notMerged: 2, deferred: 0, unknown: 0 } }],
      nextCursor: older ? null : 'run-1', workingCount: 0, unreadCount: 0, latestSequence: 2 });
    }
    if (method === 'POST' && url.pathname === '/api/operator-activities/read') return Response.json({ unreadCount: 0 });
    return Response.json({ error: 'Result bodies are not available to overview paging' }, { status: 403 });
  });
  render(() => createComponent(OperatorActivityButton, { enabled: true }));
  await fireEvent.click(screen.getByRole('button', { name: 'Operator activity' }));
  expect(await screen.findByRole('button', { name: 'View run-1' })).toBeVisible();
  expect(screen.getByText('1 merged')).toBeVisible();
  await fireEvent.click(screen.getByRole('button', { name: 'Load 5 more' }));
  expect(await screen.findByRole('button', { name: 'View run-2' })).toBeVisible();
  expect(screen.getByText('2 not merged')).toBeVisible();
  await fireEvent.click(screen.getByRole('button', { name: 'Newer 5' }));
  expect(await screen.findByRole('button', { name: 'View run-1' })).toBeVisible();
  // Intentional HTTP allowlist: overview paging must not fetch per-row result bodies.
  expect(requests.every(request => request === 'GET /api/operator-activities'
    || request === 'POST /api/operator-activities/read')).toBe(true);
});

describe('REQ-OPERATOR-036: failed activity mutations surface uncertainty instead of replaying', () => {
  const summary = { activityId: 'activity-1', operatorId: 'reviewer', executionStatus: 'cancel-requested',
    cleanupStatus: 'pending', collectionStatus: 'unavailable', attention: false, sessionId: null,
    source: null, updatedAt: detail.updatedAt };
  for (const operation of [
    { name: 'cancel', send: () => cancelOperatorActivity('activity-1'), response: summary },
    { name: 'acknowledge', send: () => acknowledgeOperatorActivities(4), response: { unreadCount: 0 } },
  ]) {
    it.each(['network', 'HTTP 503'])(`${operation.name} preserves the original %s failure even if replay would succeed`, async fault => {
      let initialFailure = true;
      vi.stubGlobal('fetch', async () => {
        if (!initialFailure) return Response.json(operation.response);
        initialFailure = false;
        if (fault === 'network') throw new TypeError('Delivery was lost after submission');
        return Response.json({ error: 'Unavailable' }, { status: 503 });
      });
      // Observable contract: an uncertain mutation must not become successful
      // through an invisible retry. The upstream would succeed on any replay.
      await expect(operation.send()).rejects.toBeDefined();
    });
  }
});

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


describe('REQ-OPERATOR-057: nonsecret native selection and functional authentication wire', () => {
  const selection = { source: 'pi-native', provider: 'openai-codex', model: 'gpt-6.1-sol',
    api: 'openai-codex-responses', reasoningLevel: 'low', reasoningSource: 'installation' };
  const failure = { code: 'PI_LOGIN_REQUIRED', reason: 'expired', provider: 'openai-codex' };
  const failed = { ...detail, executionStatus: 'failed', collectionStatus: 'unavailable', result: null,
    attention: true, authFailure: failure, inferenceSelection: selection };

  it('reads pinned native selection and login recovery without an optional diagnostic report', async () => {
    vi.stubGlobal('fetch', async () => Response.json(failed));
    await expect(getOperatorActivity('activity-1')).resolves.toMatchObject({ executionStatus: 'failed',
      cleanupStatus: 'stopped', authFailure: failure, inferenceSelection: selection });
  });

  it.each([{ ...failure, reason: 'network' }, { ...failure, access: 'fixture-private-access' }])(
    'rejects authentication details outside the closed functional wire %#', async authFailure => {
      // Intentional closed safe-error wire, not SDK authentication/serialization qualification.
      vi.stubGlobal('fetch', async () => Response.json({ ...failed, authFailure }));
      await expect(getOperatorActivity('activity-1')).rejects.toBeDefined();
    });
});
