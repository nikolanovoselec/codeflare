import { cleanup, render, screen, waitFor } from '@solidjs/testing-library';
import { Router } from '@solidjs/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAdminUsageMock = vi.fn();

vi.mock('../../api/client', () => ({
  getAdminUsage: (...args: unknown[]) => getAdminUsageMock(...args),
}));

import AnalyticsPage from '../../components/admin/AnalyticsPage';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-03T12:00:00.000Z'));
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
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Analytics historical usage presentation', () => {
  it('charts actual period aggregates, shows snapshot freshness, and exposes a download', async () => {
    render(() => <Router><AnalyticsPage /></Router>);

    await waitFor(() => expect(screen.getByText('9h 33m')).toBeInTheDocument());
    expect(screen.getByRole('img', { name: /accounted runtime history/i })).toBeInTheDocument();
    expect(screen.getByText('2h 0m')).toBeInTheDocument();
    expect(screen.getAllByText('9h 33m')).toHaveLength(2);
    expect(screen.getByText(/can lag live Timekeeper usage/i)).toBeInTheDocument();
    expect(screen.getByText('2026-09-03T11:54:17.007Z')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Export CSV' })).toHaveAttribute('download', 'codeflare-usage-day-2026-09-03.csv');
  });
});
