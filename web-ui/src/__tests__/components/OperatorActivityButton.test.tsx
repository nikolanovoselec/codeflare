import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OperatorActivityButton from '../../components/OperatorActivityButton';

const { listMock, cancelMock } = vi.hoisted(() => ({ listMock: vi.fn(), cancelMock: vi.fn() }));
vi.mock('../../api/operator-activities', () => ({
  listOperatorActivities: (...args: unknown[]) => listMock(...args),
  cancelOperatorActivity: (...args: unknown[]) => cancelMock(...args),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const active = { activityId: 'activity-1', operatorId: 'reviewer', executionStatus: 'running' as const,
  cleanupStatus: 'pending' as const, collectionStatus: 'unavailable' as const,
  attention: false, sessionId: 'session-1', source: 'Repository dispatch', updatedAt: new Date().toISOString() };

describe('REQ-OPERATOR-027: operator activity header control', () => {
  it('renders nothing and issues no request outside enterprise', () => {
    const view = render(() => <OperatorActivityButton enabled={false} />);
    expect(view.queryByRole('button', { name: /operator activity/i })).toBeNull();
    expect(listMock).not.toHaveBeenCalled();
  });

  it('shows a working badge and separate execution, cleanup and collection states', async () => {
    listMock.mockResolvedValue({ items: [active, { ...active, activityId: 'activity-2', executionStatus: 'failed',
      cleanupStatus: 'stopped', collectionStatus: 'ready', attention: true, sessionId: null }] });
    const view = render(() => <OperatorActivityButton enabled />);
    await waitFor(() => expect(view.getByText('1')).toBeTruthy());
    await fireEvent.click(view.getByRole('button', { name: /operator activity/i }));
    expect(view.getByText('Execution: running')).toBeTruthy();
    expect(view.getByText('Cleanup: pending')).toBeTruthy();
    expect(view.getByText('Collection: ready')).toBeTruthy();
    expect(view.getByText('Needs attention')).toBeTruthy();
    expect(view.getByRole('link', { name: 'Open session' }).getAttribute('href')).toContain('session-1');
    expect(view.getByRole('button', { name: 'Cancel activity-1' })).toBeTruthy();
  });

  it('uses concise explanatory copy without redundant refresh or close controls', async () => {
    listMock.mockResolvedValue({ items: [] });
    const view = render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(view.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(view.getByText('No activity')).toBeTruthy());
    expect(view.getByText('Operator overview')).toBeTruthy();
    expect(view.getByText('Operators are autonomous agents that work in the background. Track progress and results here.')).toBeTruthy();
    expect(view.getByText('No activity').className).toContain('operator-activity-state--empty');
    expect(view.queryByRole('button', { name: /refresh/i })).toBeNull();
    expect(view.queryByRole('button', { name: /close operator activity/i })).toBeNull();
  });

  it('does not present request failures as empty and supports retry, outside-click and Escape dismissal', async () => {
    listMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ items: [] });
    const view = render(() => <OperatorActivityButton enabled />);
    const trigger = view.getByRole('button', { name: /operator activity/i });
    await fireEvent.click(trigger);
    await waitFor(() => expect(view.getByText('Activity unavailable')).toBeTruthy());
    expect(view.queryByText('No activity')).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(view.getByText('No activity')).toBeTruthy());
    await fireEvent.mouseDown(document.body);
    expect(view.queryByText('No activity')).toBeNull();
    await fireEvent.click(trigger);
    await waitFor(() => expect(view.getByText('No activity')).toBeTruthy());
    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(view.queryByText('No activity')).toBeNull();
  });
});
