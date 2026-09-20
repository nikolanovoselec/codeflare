import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OperatorActivityButton from '../../components/OperatorActivityButton';

const { listMock, cancelMock } = vi.hoisted(() => ({ listMock: vi.fn(), cancelMock: vi.fn() }));
vi.mock('../../api/operator-activities', () => ({
  listOperatorActivities: (...args: unknown[]) => listMock(...args),
  cancelOperatorActivity: (...args: unknown[]) => cancelMock(...args),
}));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

const active = { activityId: 'activity-1', operatorId: 'reviewer', executionStatus: 'running' as const,
  cleanupStatus: 'pending' as const, collectionStatus: 'unavailable' as const,
  attention: false, sessionId: 'session-1', source: 'Repository dispatch', updatedAt: new Date().toISOString() };

describe('REQ-OPERATOR-027: operator activity header control', () => {
  it('renders nothing and issues no request outside enterprise', () => {
    render(() => <OperatorActivityButton enabled={false} />);
    expect(screen.queryByRole('button', { name: /operator activity/i })).toBeNull();
    expect(listMock).not.toHaveBeenCalled();
  });

  it('shows a working badge and separate execution, cleanup and collection states', async () => {
    listMock.mockResolvedValue({ items: [active, { ...active, activityId: 'activity-2', executionStatus: 'failed',
      cleanupStatus: 'stopped', collectionStatus: 'ready', attention: true, sessionId: null }] });
    render(() => <OperatorActivityButton enabled />);
    await waitFor(() => expect(screen.getByText('1')).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    expect(screen.getByText('Execution: running')).toBeTruthy();
    expect(screen.getByText('Cleanup: pending')).toBeTruthy();
    expect(screen.getByText('Collection: ready')).toBeTruthy();
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open session' }).getAttribute('href')).toContain('session-1');
    expect(screen.getByRole('button', { name: 'Cancel activity-1' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: /operator activity/i }).className).toContain('operator-activity-panel--active');
    expect(screen.getByRole('dialog', { name: /operator activity/i }).className).not.toContain('operator-activity-panel--compact');
  });

  it('REQ-OPERATOR-040: uses concise explanatory copy without redundant refresh or close controls', async () => {
    listMock.mockResolvedValue({ items: [] });
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByText('No activity')).toBeTruthy());
    expect(screen.getByText('Operator overview')).toBeTruthy();
    expect(screen.getByText('Operators are autonomous agents that work in the background. Track progress and results here.')).toBeTruthy();
    expect(screen.getByText('No activity').className).toContain('operator-activity-state--empty');
    expect(screen.getByRole('dialog', { name: /operator activity/i }).className).toContain('operator-activity-panel--empty');
    expect(screen.getByRole('dialog', { name: /operator activity/i }).className).toContain('operator-activity-panel--compact');
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /close operator activity/i })).toBeNull();
  });

  it('uses compact sizing for completed-only history', async () => {
    listMock.mockResolvedValue({ items: [{ ...active, executionStatus: 'completed' as const, cleanupStatus: 'stopped' as const }] });
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByText('Execution: completed')).toBeTruthy());
    expect(screen.getByRole('dialog', { name: /operator activity/i }).className).toContain('operator-activity-panel--compact');
    expect(screen.getByRole('dialog', { name: /operator activity/i }).className).not.toContain('operator-activity-panel--active');
  });

  it('uses compact sizing for completed history and returns to it when work completes', async () => {
    vi.useFakeTimers();
    const completed = { ...active, executionStatus: 'completed' as const, cleanupStatus: 'stopped' as const };
    listMock.mockResolvedValueOnce({ items: [active] }).mockResolvedValueOnce({ items: [completed] });
    render(() => <OperatorActivityButton enabled />);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('1')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    expect(screen.getByRole('dialog', { name: /operator activity/i }).className).toContain('operator-activity-panel--active');

    await vi.advanceTimersByTimeAsync(15_000);
    expect(screen.getByText('Execution: completed')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: /operator activity/i }).className).toContain('operator-activity-panel--compact');
    expect(screen.getByRole('dialog', { name: /operator activity/i }).className).not.toContain('operator-activity-panel--active');
  });

  it('renders the panel outside the control so no filtered ancestor can contain it, anchored to the trigger', async () => {
    listMock.mockResolvedValue({ items: [] });
    const view = render(() => <OperatorActivityButton enabled />);
    const trigger = screen.getByRole('button', { name: /operator activity/i });
    trigger.getBoundingClientRect = () => ({ top: 8, bottom: 44, left: 900, right: 944,
      width: 44, height: 36, x: 900, y: 8, toJSON: () => ({}) }) as DOMRect;
    await fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByText('No activity')).toBeTruthy());

    const panel = screen.getByRole('dialog', { name: /operator activity/i });
    const control = view.container.querySelector('.operator-activity-control');
    expect(control).not.toBeNull();
    expect(control!.contains(panel)).toBe(false);
    expect(panel.className).toContain('operator-activity-panel--portal');
    // jsdom reports innerWidth 1024, so the desktop branch measures the trigger rect.
    expect(panel.style.top).toBe('52px');
    expect(panel.style.right).toBe(`${1024 - 944}px`);
  });

  it('leaves the panel free of inline offsets at mobile width so the bottom-sheet rule applies', async () => {
    listMock.mockResolvedValue({ items: [] });
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 480, configurable: true, writable: true });
    try {
      render(() => <OperatorActivityButton enabled />);
      await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
      await waitFor(() => expect(screen.getByText('No activity')).toBeTruthy());

      const panel = screen.getByRole('dialog', { name: /operator activity/i });
      expect(panel.style.top).toBe('');
      expect(panel.style.right).toBe('');
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
    }
  });

  it('closes on a width change so a measured layout cannot outlive the width it was measured at, but survives height-only resizes', async () => {
    listMock.mockResolvedValue({ items: [] });
    const width = window.innerWidth;
    try {
      render(() => <OperatorActivityButton enabled />);
      await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
      await waitFor(() => expect(screen.getByText('No activity')).toBeTruthy());

      // Height-only resize: on-screen keyboard or URL bar, nothing measured changed.
      window.dispatchEvent(new Event('resize'));
      expect(screen.getByText('No activity')).toBeTruthy();

      Object.defineProperty(window, 'innerWidth', { value: 480, configurable: true, writable: true });
      window.dispatchEvent(new Event('resize'));
      await waitFor(() => expect(screen.queryByText('No activity')).toBeNull());
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
    }
  });

  it('REQ-OPERATOR-033 AC3: moves focus into the portalled panel and returns it to the trigger on dismissal', async () => {
    listMock.mockResolvedValue({ items: [] });
    render(() => <OperatorActivityButton enabled />);
    const trigger = screen.getByRole('button', { name: /operator activity/i });
    await fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByText('No activity')).toBeTruthy());

    const panel = screen.getByRole('dialog', { name: /operator activity/i });
    await waitFor(() => expect(document.activeElement).toBe(panel));
    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('No activity')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the portalled panel open when its own content is clicked', async () => {
    listMock.mockResolvedValue({ items: [] });
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByText('No activity')).toBeTruthy());

    await fireEvent.mouseDown(screen.getByRole('dialog', { name: /operator activity/i }));
    expect(screen.getByText('No activity')).toBeTruthy();
  });

  it('does not present request failures as empty and supports retry, outside-click and Escape dismissal', async () => {
    listMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ items: [] });
    render(() => <OperatorActivityButton enabled />);
    const trigger = screen.getByRole('button', { name: /operator activity/i });
    await fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByText('Activity unavailable')).toBeTruthy());
    expect(screen.queryByText('No activity')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('No activity')).toBeTruthy());
    await fireEvent.mouseDown(document.body);
    expect(screen.queryByText('No activity')).toBeNull();
    await fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByText('No activity')).toBeTruthy());
    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('No activity')).toBeNull();
  });
});
