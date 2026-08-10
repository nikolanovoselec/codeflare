import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@solidjs/testing-library';
import SelectableSessionCard from '../../components/SelectableSessionCard';
import type { SessionWithStatus } from '../../types';

vi.mock('../../stores/session', () => ({
  sessionStore: {
    getMetricsForSession: vi.fn(() => ({
      bucketName: 'codeflare-test',
      cpu: '15%',
      mem: '1.2/3.0G',
      hdd: '2.1G/10G',
      syncStatus: 'success',
    })),
    getInitProgressForSession: vi.fn(() => null),
    preferences: { sleepAfter: '30m' },
    preseedUpgrading: false,
  },
}));

vi.mock('../../stores/terminal', () => ({
  terminalStore: {
    getConnectionState: vi.fn(() => 'connected'),
  },
}));

const runningSession: SessionWithStatus = {
  id: 'running-1',
  name: 'Running Session',
  createdAt: '2024-01-15T10:00:00Z',
  lastAccessedAt: '2024-01-15T12:00:00Z',
  status: 'running',
  agentType: 'claude-code',
};

describe('SelectableSessionCard', () => {
  afterEach(() => cleanup());

  it('REQ-SESSION-010 AC5: retains CPU, memory, and storage metrics without an internal agent/sync diagnostic line', () => {
    render(() => (
      <SelectableSessionCard
        session={runningSession}
        isActive
        selected={false}
        selecting={false}
        disabled={false}
        onSelect={vi.fn()}
        onStop={vi.fn()}
        onDelete={vi.fn()}
      />
    ));

    expect(screen.getByTestId('session-stat-card-running-1-metric-cpu')).toHaveTextContent('15%');
    expect(screen.getByTestId('session-stat-card-running-1-metric-mem')).toHaveTextContent('1.2/3.0G');
    expect(screen.getByTestId('session-stat-card-running-1-metric-hdd')).toHaveTextContent('2.1G/10G');

    const selectableCard = screen.getByTestId('session-card-running-1');
    expect(selectableCard).not.toHaveTextContent('claude-code');
    expect(selectableCard).not.toHaveTextContent('Sync:');
    expect(screen.queryByTestId('session-card-running-1-live-state')).not.toBeInTheDocument();
  });
});
