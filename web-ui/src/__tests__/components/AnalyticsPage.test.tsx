import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { Route, Router } from '@solidjs/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAdminUsageMock = vi.fn();

vi.mock('../../api/client', () => ({
  getAdminUsage: (...args: unknown[]) => getAdminUsageMock(...args),
}));

import AnalyticsPage from '../../components/admin/AnalyticsPage';

beforeEach(() => {
  getAdminUsageMock.mockResolvedValue({
    period: 'day',
    start: '2026-09-03',
    timezone: 'UTC',
    sort: 'runtimeSeconds',
    direction: 'desc',
    summary: { runtimeSeconds: 34380, sessionCount: 2, activeUsers: 1 },
    series: [
      { start: '2026-09-02', runtimeSeconds: 7200, sessionCount: 1, historyUpdatedAt: '2026-09-02T23:54:17.007Z' },
      { start: '2026-09-03', runtimeSeconds: 34380, sessionCount: 2, historyUpdatedAt: '2026-09-03T11:54:17.007Z' },
    ],
    dataSince: '2026-09-02T01:39:17.004Z',
    historyUpdatedAt: '2026-09-03T11:54:17.007Z',
    users: [],
    nextCursor: null,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Analytics historical usage presentation', () => {
  it('requests the selected period immediately rather than leaving day totals under a week selection', async () => {
    render(() => <Router><Route path="*" component={AnalyticsPage} /></Router>);
    await screen.findByRole('img', { name: /accounted runtime history/i });
    await fireEvent.click(screen.getByRole('button', { name: 'week', exact: true }));
    await waitFor(() => expect(getAdminUsageMock).toHaveBeenLastCalledWith(expect.objectContaining({ period: 'week' })));
    const request = getAdminUsageMock.mock.calls.at(-1)![0];
    expect(new Date(`${request.start}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(screen.getByText('Week start (Monday, 00:00 UTC)')).toBeVisible();
  });

  it('charts actual period aggregates, shows snapshot freshness, and exposes a download', async () => {
    render(() => <Router><Route path="*" component={AnalyticsPage} /></Router>);

    await waitFor(() => expect(screen.getAllByText('9h 33m')).toHaveLength(2));
    expect(screen.getByRole('img', { name: /accounted runtime history/i })).toBeInTheDocument();
    expect(screen.getByText('2h 0m')).toBeInTheDocument();
    expect(screen.getByText(/can lag live Timekeeper usage/i)).toBeInTheDocument();
    expect(screen.getByText(/excludes usage before collection began/i)).toBeVisible();
    expect(screen.getByText('2026-09-03T11:54:17.007Z')).toBeInTheDocument();
    const request = getAdminUsageMock.mock.calls[0]?.[0] as { start: string } | undefined;
    if (!request) throw new Error('Expected the Analytics page to request usage data');
    expect(screen.getByRole('link', { name: 'Export CSV' })).toHaveAttribute('download', `codeflare-usage-day-${request.start}.csv`);
  });

  it('charts earlier history when the selected period has no aggregate row', async () => {
    getAdminUsageMock.mockResolvedValueOnce({
      period: 'day',
      start: '2026-09-03',
      timezone: 'UTC',
      sort: 'runtimeSeconds',
      direction: 'desc',
      summary: { runtimeSeconds: 0, sessionCount: 0, activeUsers: 0 },
      series: [
        { start: '2026-09-02', runtimeSeconds: 7200, sessionCount: 1, historyUpdatedAt: '2026-09-02T23:54:17.007Z' },
      ],
      dataSince: null,
      historyUpdatedAt: null,
      users: [],
      nextCursor: null,
    });

    render(() => <Router><Route path="*" component={AnalyticsPage} /></Router>);

    await waitFor(() => expect(screen.getByRole('img', { name: /accounted runtime history/i })).toBeInTheDocument());
    expect(screen.queryByText('No historical usage yet')).not.toBeInTheDocument();
    expect(screen.getByText('2h 0m')).toBeInTheDocument();
    expect(screen.getByText('No selected-period row')).toBeInTheDocument();
  });
});
