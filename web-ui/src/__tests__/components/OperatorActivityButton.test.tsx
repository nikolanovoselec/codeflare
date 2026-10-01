import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OperatorActivityButton from '../../components/OperatorActivityButton';

const { listMock, cancelMock, detailMock, readMock } = vi.hoisted(() => ({
  listMock: vi.fn(), cancelMock: vi.fn(), detailMock: vi.fn(), readMock: vi.fn(async (_through: number) => ({ unreadCount: 0 })) }));
vi.mock('../../api/operator-activities', () => ({
  listOperatorActivities: async (...args: unknown[]) => {
    const value = await listMock(...args);
    return value && { ...value, workingCount: value.workingCount ?? value.items.filter(
      (item: { executionStatus: string }) => ['queued', 'running', 'waiting', 'cancel-requested', 'unknown'].includes(item.executionStatus)).length,
    unreadCount: value.unreadCount ?? 0,
    latestSequence: value.latestSequence ?? value.items.length };
  },
  cancelOperatorActivity: (...args: unknown[]) => cancelMock(...args),
  getOperatorActivity: (...args: unknown[]) => detailMock(...args),
  acknowledgeOperatorActivities: (through: number) => readMock(through),
}));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); detailMock.mockReset(); });

const active = { activityId: 'activity-1', operatorId: 'reviewer', executionStatus: 'running' as const,
  cleanupStatus: 'pending' as const, collectionStatus: 'unavailable' as const,
  attention: false, sessionId: 'session-1', source: 'Repository dispatch', updatedAt: new Date().toISOString() };

describe('REQ-OPERATOR-027: operator activity header control', () => {
  it('renders nothing and issues no request outside enterprise', () => {
    render(() => <OperatorActivityButton enabled={false} />);
    expect(screen.queryByRole('button', { name: /operator activity/i })).toBeNull();
    expect(listMock).not.toHaveBeenCalled();
  });

  it('shows an unread badge and execution states in the overview', async () => {
    listMock.mockResolvedValue({ unreadCount: 1, workingCount: 2, items: [active, { ...active, activityId: 'activity-2', executionStatus: 'failed',
      cleanupStatus: 'stopped', collectionStatus: 'ready', attention: true, sessionId: null }] });
    render(() => <OperatorActivityButton enabled />);
    await waitFor(() => expect(screen.getByText('1')).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByText('running')).toBeTruthy());
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open session' }).getAttribute('href')).toContain('session-1');
    expect(screen.getByRole('button', { name: 'Cancel activity-1' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: /operator activity/i }).className).toContain('operator-activity-panel--active');
    expect(screen.getByRole('dialog', { name: /operator activity/i }).className).not.toContain('operator-activity-panel--compact');
  });

  it('REQ-OPERATOR-059: shows new summaries since last open and opening acknowledges only observed admissions', async () => {
    let unreadCount = 2;
    listMock.mockImplementation(async () => ({ items: [active], workingCount: 17,
      unreadCount, latestSequence: 2 }));
    readMock.mockImplementationOnce(async (through: number) => { expect(through).toBe(2); unreadCount = 0; return { unreadCount }; });
    render(() => <OperatorActivityButton enabled />);
    await waitFor(() => expect(screen.getByText('2')).toBeTruthy());
    expect(screen.queryByText('17')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.queryByText('2')).toBeNull());
    expect(readMock).toHaveBeenCalledWith(2);
    expect(detailMock).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    expect(readMock).toHaveBeenCalledTimes(1);
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
    await waitFor(() => expect(screen.getByText('completed')).toBeTruthy());
    expect(screen.getByRole('dialog', { name: /operator activity/i }).className).toContain('operator-activity-panel--compact');
    expect(screen.getByRole('dialog', { name: /operator activity/i }).className).not.toContain('operator-activity-panel--active');
  });

  it('uses compact sizing for completed history and returns to it when work completes', async () => {
    vi.useFakeTimers();
    const completed = { ...active, executionStatus: 'completed' as const, cleanupStatus: 'stopped' as const };
    listMock.mockResolvedValue({ items: [completed], unreadCount: 0 });
    listMock.mockResolvedValueOnce({ items: [active], unreadCount: 1 });
    render(() => <OperatorActivityButton enabled />);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('1')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    expect(screen.getByRole('dialog', { name: /operator activity/i }).className).toContain('operator-activity-panel--active');

    await vi.advanceTimersByTimeAsync(15_000);
    expect(screen.getByText('completed')).toBeTruthy();
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
    const height = window.innerHeight;
    try {
      render(() => <OperatorActivityButton enabled />);
      await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
      await waitFor(() => expect(screen.getByText('No activity')).toBeTruthy());

      // Height-only resize: on-screen keyboard or URL bar, nothing measured changed.
      Object.defineProperty(window, 'innerHeight', { value: height - 260, configurable: true, writable: true });
      window.dispatchEvent(new Event('resize'));
      expect(screen.getByText('No activity')).toBeTruthy();

      Object.defineProperty(window, 'innerWidth', { value: 480, configurable: true, writable: true });
      window.dispatchEvent(new Event('resize'));
      await waitFor(() => expect(screen.queryByText('No activity')).toBeNull());
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
      Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
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


describe('REQ-OPERATOR-027: readable owned activity and bounded history', () => {
  it('shows trusted name, admitted task context and progress without making an old terminal observation an alert', async () => {
    listMock.mockResolvedValue({ items: [{ ...active, operatorName: 'Renovate Dispatcher', context: 'owner/repo · PR #42',
      progress: 'Checking compatibility', executionStatus: 'completed', attention: false, updatedAt: 1 }] });
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByText('Renovate Dispatcher')).toBeTruthy());
    expect(screen.getByText('owner/repo · PR #42')).toBeTruthy();
    expect(screen.getByText('Checking compatibility')).toBeTruthy();
    expect(screen.queryByText('Needs attention')).toBeNull();
    expect(screen.queryByRole('link', { name: 'View result' })).toBeNull();
  });

  it('REQ-OPERATOR-027: labels an old working observation as stale but reserves attention for an explicit signal', async () => {
    listMock.mockResolvedValue({ items: [{ ...active, updatedAt: 1, attention: false }] });
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByText(/Last observation may be stale/)).toBeTruthy());
    expect(screen.queryByText('Needs attention')).toBeNull();
  });

  it('pages five retained owned entries without changing unread status', async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ ...active, activityId: `activity-${i + 1}` }));
    listMock.mockImplementation(async (after: string | null) => ({
      items: after === 'activity-10' ? items.slice(10) : after === 'activity-5' ? items.slice(5, 10) : items.slice(0, 5),
      nextCursor: after === 'activity-10' ? null : after === 'activity-5' ? 'activity-10' : 'activity-5', workingCount: 12,
      unreadCount: 0, latestSequence: 12 }));
    render(() => <OperatorActivityButton enabled />);
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(5));
    expect(screen.getByRole('button', { name: 'View activity-1' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Load next 5' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View activity-6' })).toBeTruthy());
    expect(screen.getAllByRole('article')).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'View activity-1' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Newer 5' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View activity-1' })).toBeTruthy());
    expect(screen.queryByText('12')).toBeNull();
  });

  it('REQ-OPERATOR-027: trigger dismissal resets older history and selected detail on reopen', async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ ...active, activityId: `activity-${i + 1}` }));
    listMock.mockImplementation(async (after: string | null) => ({
      items: after ? items.slice(5) : items.slice(0, 5), nextCursor: after ? null : 'activity-5', workingCount: 6 }));
    detailMock.mockResolvedValue({ ...active, executionStatus: 'completed', checkpoint: null, result: { verdict: 'reviewed' } });
    render(() => <OperatorActivityButton enabled />);
    const trigger = screen.getByRole('button', { name: /operator activity/i });
    await fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load next 5' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'Load next 5' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View activity-6' })).toBeTruthy());
    await fireEvent.click(trigger);
    await fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole('button', { name: 'View activity-1' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Newer 5' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
    await waitFor(() => expect(screen.getByText('Conclusion: reviewed')).toBeTruthy());
    await fireEvent.click(trigger);
    await fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole('button', { name: 'View activity-1' })).toBeTruthy());
    expect(screen.queryByText('Conclusion: reviewed')).toBeNull();
  });

  it('keeps the older page stable when polling prepends a newer activity', async () => {
    vi.useFakeTimers();
    const initial = Array.from({ length: 8 }, (_, i) => ({ ...active, activityId: `activity-${i + 1}` }));
    listMock.mockImplementation(async (after: string | null) => after === 'activity-5'
      ? { items: initial.slice(5), nextCursor: null, workingCount: 9 }
      : { items: initial.slice(0, 5), nextCursor: 'activity-5', workingCount: 8 });
    render(() => <OperatorActivityButton enabled />);
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.click(screen.getByRole('button', { name: 'Load next 5' }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(screen.getByRole('button', { name: 'View activity-6' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'View activity-5' })).toBeNull();
    expect(screen.getAllByRole('article')).toHaveLength(3);
  });

  it('opens an in-app owner-scoped readable result, with diagnostics and a way back, without collecting or restarting', async () => {
    listMock.mockResolvedValue({ items: [active] });
    detailMock.mockResolvedValue({ ...active, executionStatus: 'completed', cleanupStatus: 'unknown',
      collectionStatus: 'consumed', checkpoint: { stage: 'review' }, result: { verdict: 'incomplete' } });
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View activity-1' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
    await waitFor(() => expect(screen.getByText(/incomplete/)).toBeTruthy());
    expect(screen.getByText('Execution: completed')).toBeTruthy();
    expect(screen.getByText('Cleanup: unknown')).toBeTruthy();
    expect(screen.getByText('Collection: consumed')).toBeTruthy();
    expect(screen.getByText('Checkpoint saved. Work may still be in progress.')).toBeTruthy();
    expect(detailMock).toHaveBeenCalledWith('activity-1');
    expect(cancelMock).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Back to activities' }));
    expect(screen.getByRole('button', { name: 'View activity-1' })).toBeTruthy();
  });

  it('shows pending, unknown and inaccessible detail states without a replay action', async () => {
    listMock.mockResolvedValue({ items: [active] });
    detailMock.mockResolvedValueOnce({ ...active, checkpoint: null, result: null })
      .mockResolvedValueOnce({ ...active, executionStatus: 'unknown', checkpoint: null, result: null })
      .mockRejectedValueOnce(new Error('denied'));
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View activity-1' })).toBeTruthy());
    for (const message of ['Result pending', 'Outcome unknown', 'Activity detail unavailable']) {
      await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
      await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
      expect(screen.queryByRole('button', { name: /retry activity|restart activity/i })).toBeNull();
      await fireEvent.click(screen.getByRole('button', { name: 'Back to activities' }));
    }
  });
  it('REQ-OPERATOR-033: distinguishes failed and completed-without-result outcomes from pending work', async () => {
    listMock.mockResolvedValue({ items: [active] });
    detailMock.mockResolvedValueOnce({ ...active, executionStatus: 'failed', checkpoint: null, result: null })
      .mockResolvedValueOnce({ ...active, executionStatus: 'completed', collectionStatus: 'consumed', checkpoint: null, result: null });
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View activity-1' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
    await waitFor(() => expect(screen.getByText('Activity failed without a result')).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'Back to activities' }));
    await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
    await waitFor(() => expect(screen.getByText('Result unavailable')).toBeTruthy());
    expect(screen.getByText('Collection: consumed')).toBeTruthy();
  });

  it('REQ-OPERATOR-057: presents original Review lane findings and incomplete reports as readable evidence, not raw JSON', async () => {
    listMock.mockResolvedValue({ items: [active] });
    detailMock.mockResolvedValue({ ...active, executionStatus: 'completed', checkpoint: null,
      // Published Review contract: host/__tests__/operator-boundary-action.test.js, not the legacy native fixture.
      result: { schemaVersion: 1, activityId: 'activity-1', status: 'incomplete', cleanup: 'unknown',
        operationId: 'private-id', originalReports: [
          { lane: 'code-reviewer', findings: [
            { id: 'unresolved', lane: 'code-reviewer', message: 'Unsafe redirect', secret: 'do-not-render' }] },
          { lane: 'spec-reviewer', findings: [] }],
        history: { clear: false, findings: [{ id: 'unresolved', message: 'Unsafe redirect' }] },
        presentation: { check: { conclusion: 'failure', summary: 'Redirect escapes approved host' } } } });
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View activity-1' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
    await waitFor(() => expect(screen.getByText('Unsafe redirect')).toBeTruthy());
    expect(screen.getByText('Review: Redirect escapes approved host')).toBeTruthy();
    expect(screen.getByText('Review check failed. Findings require attention.')).toBeTruthy();
    expect(screen.getByText(/Review reports incomplete/)).toBeTruthy();
    expect(screen.queryByText(/do-not-render|private-id/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'View result' })).toBeNull();
  });

  it('REQ-OPERATOR-057: presents every Review report, omission and finding without hiding later evidence', async () => {
    listMock.mockResolvedValue({ items: [active] });
    detailMock.mockResolvedValue({ ...active, executionStatus: 'completed', checkpoint: null,
      result: { originalReports: Array.from({ length: 17 }, (_, i) => ({ lane: `lane-${i}`,
        omissions: i === 16 ? Array.from({ length: 21 }, (_, j) => `Omission ${j}`) : [],
        findings: i === 16 ? Array.from({ length: 51 }, (_, j) => ({ message: `Finding ${j}` })) : [] })) } });
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View activity-1' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
    await waitFor(() => expect(screen.getByText('lane-16')).toBeTruthy());
    expect(screen.getByText('Missing: Omission 20')).toBeTruthy();
    expect(screen.getByText('Finding 50')).toBeTruthy();
  });

  it('REQ-OPERATOR-057: keeps early and late Review findings and omissions readable together', async () => {
    listMock.mockResolvedValue({ items: [active] });
    detailMock.mockResolvedValue({ ...active, executionStatus: 'completed', checkpoint: null,
      result: { originalReports: [
        { lane: 'code-reviewer', omissions: ['Missing security check'], findings: [{ message: 'Unsafe redirect' }] },
        { lane: 'spec-reviewer', omissions: [], findings: [] },
        { lane: 'doc-updater', omissions: ['Missing migration note'], findings: [{ message: 'Outdated recovery step' }] },
      ] } });
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View activity-1' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
    await waitFor(() => expect(screen.getByText('Unsafe redirect')).toBeTruthy());
    expect(screen.getByText('Outdated recovery step')).toBeTruthy();
    expect(screen.getByText('Missing: Missing security check')).toBeTruthy();
    expect(screen.getByText('Missing: Missing migration note')).toBeTruthy();
  });

  it('REQ-OPERATOR-057: marks unreadable Review evidence explicitly without exposing unsafe text', async () => {
    listMock.mockResolvedValue({ items: [active] });
    detailMock.mockResolvedValue({ ...active, executionStatus: 'completed', checkpoint: null,
      result: { originalReports: [{ lane: 'code-reviewer', omissions: ['x'.repeat(1001)],
        findings: [{ message: 'y'.repeat(1001) }, { title: 'Known finding', description: 'z'.repeat(1001) }] }] } });
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View activity-1' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
    await waitFor(() => expect(screen.getByText('Missing: Content unavailable (not safely readable)')).toBeTruthy());
    expect(screen.getAllByText('Content unavailable (not safely readable)')).toHaveLength(2);
    expect(screen.getByText('Known finding')).toBeTruthy();
    expect(screen.queryByText('x'.repeat(1001))).toBeNull();
    expect(screen.queryByText('y'.repeat(1001))).toBeNull();
    expect(screen.queryByText('z'.repeat(1001))).toBeNull();
  });

  it('REQ-OPERATOR-057: reads the compiler-produced native Conductor reports variant', async () => {
    listMock.mockResolvedValue({ items: [active] });
    // src/__tests__/operators/loader-runtime.test.ts: compiled /conductor-bundle result.
    detailMock.mockResolvedValue({ ...active, executionStatus: 'completed', checkpoint: null,
      result: { operationId: 'review-generation-1', cleanup: 'stopped', reports: [
        { lane: 'code-reviewer', packetDigest: 'a'.repeat(64), generation: 1, complete: true,
          omissions: [], findings: [{ message: 'Resolve alert' }] },
        { lane: 'spec-reviewer', complete: true, omissions: [], findings: [] }] } });
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View activity-1' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
    await waitFor(() => expect(screen.getByText('Resolve alert')).toBeTruthy());
    expect(screen.getByText('Reported cleanup: stopped')).toBeTruthy();
    expect(screen.queryByText(/review-generation-1|packetDigest/)).toBeNull();
  });

  it('REQ-OPERATOR-057: reads the cited Dispatcher compatibility assessment without equating safe with merge readiness', async () => {
    listMock.mockResolvedValue({ items: [active] });
    detailMock.mockResolvedValueOnce({ ...active, executionStatus: 'completed', checkpoint: null,
      result: { repository: 'nikolanovoselec/komodo', pullRequest: 1299, privateToken: 'do-not-render',
        assessment: { classification: 'unknown', observedHead: 'b'.repeat(40), baseSha: 'a'.repeat(40),
          checks: { state: 'unconfigured', observedHead: 'b'.repeat(40) },
          compatibility: 'The agent configuration change could not be established.',
          reasons: ['Upstream migration guidance is inconclusive'], gaps: ['Agent command not verified'],
          citations: [{ kind: 'guide', source: 'https://github.com/amir20/dozzle/guide',
            quote: 'Start the agent with its agent command.' }] } } })
      .mockResolvedValueOnce({ ...active, executionStatus: 'completed', checkpoint: null,
        result: { repository: 'nikolanovoselec/komodo', pullRequest: 1299, privateToken: 'do-not-render',
          assessment: { classification: 'safe', observedHead: 'b'.repeat(40), baseSha: 'a'.repeat(40),
            checks: { state: 'passing', observedHead: 'b'.repeat(40) },
            compatibility: 'The documented default configuration remains compatible.',
            reasons: ['Release and guide support compatibility'], gaps: [],
            citations: [{ kind: 'release', source: 'https://github.com/amir20/dozzle/releases/tag/v11.1.2',
              quote: 'No default configuration changes are required.' }] } } });
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View activity-1' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
    await waitFor(() => expect(screen.getByText(/agent configuration change could not be established/i)).toBeTruthy());
    expect(screen.getByText(/Upstream migration guidance is inconclusive/)).toBeTruthy();
    expect(screen.getByText(/Agent command not verified/)).toBeTruthy();
    expect(screen.getByText(/Start the agent with its agent command/)).toBeTruthy();
    expect(screen.getByText(/Checks? unconfigured/)).toBeTruthy();
    expect(screen.queryByText(/do-not-render/)).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Back to activities' }));
    await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
    await waitFor(() => expect(screen.getByText(/documented default configuration remains compatible/)).toBeTruthy());
    expect(screen.getByText(/not merge authorization/i)).toBeTruthy();
    expect(screen.queryByText(/do-not-render/)).toBeNull();
  });

  it('REQ-OPERATOR-057: distinguishes unsafe assessment and refuses malformed or unreadable evidence', async () => {
    listMock.mockResolvedValue({ items: [active] });
    detailMock.mockResolvedValueOnce({ ...active, executionStatus: 'completed', checkpoint: null,
      result: { assessment: { classification: 'unsafe', compatibility: 'Agent command requires migration.',
        reasons: ['Breaking command change'], gaps: ['New configuration not verified'],
        checks: { state: 'failing' }, citations: [{ kind: 'guide', source: 'source', quote: 'secret\u0000content' }] } } })
      .mockResolvedValueOnce({ ...active, executionStatus: 'completed', checkpoint: null,
        result: { assessment: { classification: 'safe', compatibility: 'Unsubstantiated',
          reasons: ['x'.repeat(1001)], gaps: [], checks: { state: 'passing' },
          citations: [{ kind: 'release', source: 'source', quote: 'Bad\u0000citation' }] } } })
      .mockResolvedValueOnce({ ...active, executionStatus: 'completed', checkpoint: null,
        result: { assessment: { classification: ['safe'], compatibility: 'Not independently safe',
          reasons: ['No evidence'], gaps: [], checks: { state: 'passing' }, citations: [] } } });
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View activity-1' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
    await waitFor(() => expect(screen.getByText(/Agent command requires migration/)).toBeTruthy());
    expect(screen.getByText(/Compatibility: unsafe/i)).toBeTruthy();
    expect(screen.getByText(/Breaking command change/)).toBeTruthy();
    expect(screen.getByText(/New configuration not verified/)).toBeTruthy();
    expect(screen.queryByText(/secret.*content/)).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Back to activities' }));
    await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
    await waitFor(() => expect(screen.getByText(/Result format unavailable/)).toBeTruthy());
    expect(screen.queryByText(/Unsubstantiated|Bad.*citation/)).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Back to activities' }));
    await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
    await waitFor(() => expect(screen.getByText(/Result format unavailable/)).toBeTruthy());
    expect(screen.queryByText(/Not independently safe|Compatibility: SAFE/)).toBeNull();
  });

  it('REQ-OPERATOR-057: summarizes the actual Dispatcher assessment and rejects opaque result bytes', async () => {
    listMock.mockResolvedValue({ items: [active] });
    // Settled data-assessment shape persisted by src/operators/activity.ts (dispatcher-production test).
    const assessment = { repository: 'owner/repo', pullRequest: 17, observedHead: 'b'.repeat(40), readOnly: true,
      evidence: { complete: false, stale: false, truncated: true, bot: 'renovate[bot]' },
      bounds: { files: 3, checks: 76 }, unknownField: 'secret-data' };
    detailMock.mockResolvedValueOnce({ ...active, executionStatus: 'completed', checkpoint: null, result: assessment })
      .mockResolvedValueOnce({ ...active, executionStatus: 'completed', checkpoint: null,
        result: { ...assessment, summary: 'Needs a migration check' } })
      .mockResolvedValueOnce({ ...active, executionStatus: 'failed', checkpoint: null,
        result: { code: 'CONDUCTOR_REVIEW_FAILED', credential: 'secret-data' } });
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View activity-1' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
    await waitFor(() => expect(screen.getByText('owner/repo · PR #17')).toBeTruthy());
    expect(screen.getByText('Observed author: renovate[bot]')).toBeTruthy();
    expect(screen.getByText(/Evidence incomplete/)).toBeTruthy();
    expect(screen.getByText(/Evidence truncated/)).toBeTruthy();
    expect(screen.queryByText('secret-data')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Back to activities' }));
    await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
    await waitFor(() => expect(screen.getByText('Needs a migration check')).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'Back to activities' }));
    await fireEvent.click(screen.getByRole('button', { name: 'View activity-1' }));
    await waitFor(() => expect(screen.getByText(/CONDUCTOR_REVIEW_FAILED/)).toBeTruthy());
    expect(screen.queryByText('secret-data')).toBeNull();
  });

  it('REQ-OPERATOR-027: offers a safe return to newest if retention evicts the page cursor', async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ ...active, activityId: `activity-${i + 1}` }));
    listMock.mockImplementation(async (after: string | null) => {
      if (after) throw new Error('Activity history changed');
      return { items, nextCursor: 'activity-5', workingCount: 5 };
    });
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load next 5' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'Load next 5' }));
    await waitFor(() => expect(screen.getByText('Activity unavailable')).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'Return to newest' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View activity-1' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Newer 5' })).toBeNull();
  });

});


describe('REQ-OPERATOR-027: repository-only Dispatcher result presentation', () => {
  it.each([[], [{ pullRequest: 17, headSha: 'a'.repeat(40), decision: 'DO_NOT_MERGE', comment: 'Migration evidence is incomplete', outcome: 'NOT_MERGED' }]])('shows repository discovery and bounded decisions without raw payloads', async results => {
    listMock.mockResolvedValue({ items: [active] });
    detailMock.mockResolvedValue({ ...active, executionStatus: 'completed', checkpoint: null,
      result: { repository: 'authorized/project', results, privateData: 'do-not-render' } });
    render(() => <OperatorActivityButton enabled />);
    await fireEvent.click(screen.getByRole('button', { name: /operator activity/i }));
    await fireEvent.click(await screen.findByRole('button', { name: 'View activity-1' }));
    expect(await screen.findByText('Repository: authorized/project')).toBeTruthy();
    if (!results.length) expect(screen.getByText('No eligible pull requests discovered.')).toBeTruthy();
    else {
      expect(screen.getByText('PR #17')).toBeTruthy();
      expect(screen.getByText('Decision: DO_NOT_MERGE')).toBeTruthy();
      expect(screen.getByText('Outcome: NOT_MERGED')).toBeTruthy();
      expect(screen.getByText('Migration evidence is incomplete')).toBeTruthy();
    }
    expect(screen.queryByText('do-not-render')).toBeNull();
    expect(screen.queryByText(/Result format unavailable/)).toBeNull();
  });
});
