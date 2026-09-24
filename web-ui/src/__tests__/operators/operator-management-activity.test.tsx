import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import OperatorManagement from '../../components/OperatorManagement';
const summary = { activityId: 'activity-1', operatorId: 'operator-1', executionStatus: 'running', cleanupStatus: 'pending', collectionStatus: 'unavailable',
  attention: false, sessionId: null, source: null, updatedAt: Date.now() };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let serve: (url: URL, init?: RequestInit) => Response;
beforeEach(() => {
  window.history.replaceState({}, '', '/operators?view=activity');
  serve = () => json({ items: [summary] });
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => Promise.resolve(serve(new URL(url), init))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('REQ-OPERATOR-049: human-owned invocation and activity', () => {
  it('shows execution independently of cleanup and reconciles an explicit cancellation', async () => {
    let cancelled = false;
    serve = (url, init) => {
      if (url.pathname.endsWith('/cancel') && init?.method === 'POST') { cancelled = true; return json({ ...summary, executionStatus: 'cancel-requested' }); }
      return json({ items: [{ ...summary, executionStatus: cancelled ? 'cancel-requested' : 'running' }] });
    };
    render(() => <OperatorManagement />);
    expect(await screen.findByText(/Execution: running · Cleanup: pending/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel activity-1' }));
    expect(await screen.findByText(/Execution: cancel-requested · Cleanup: pending/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel activity-1' })).toBeDisabled();
  });
  it('binds invocation to the selected installation and never renders its single-use start capability', async () => {
    window.history.replaceState({}, '', '/operators?invoke=installation-1');
    let admitted: unknown;
    serve = (url, init) => {
      if (url.pathname === '/api/operator-activities' && init?.method === 'POST') {
        admitted = JSON.parse(String(init.body));
        return json({ activityId: 'activity-1', startCapability: 's'.repeat(43), startExpiresAt: Date.now() + 30000 });
      }
      if (url.pathname.endsWith('/start')) return json({ ok: true });
      if (url.pathname.endsWith('/activity-1')) return json({ ...summary, checkpoint: null, result: null });
      return json({ items: [summary] });
    };
    render(() => <OperatorManagement />);
    fireEvent.input(screen.getByLabelText('Invocation JSON'), { target: { value: '{"repositoryId":123}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start activity' }));
    await waitFor(() => expect(admitted).toEqual({ installationId: 'installation-1', invocation: { repositoryId: 123 } }));
    expect(await screen.findByText(/Activity start accepted/)).toBeInTheDocument();
    expect(screen.queryByText('s'.repeat(43))).not.toBeInTheDocument();
  });
  it('does not allow another start after an uncertain response until the prepared activity is reconciled', async () => {
    window.history.replaceState({}, '', '/operators?invoke=installation-1');
    let indexed = false;
    serve = (url, init) => {
      if (url.pathname === '/api/operator-activities' && init?.method === 'POST') {
        return json({ activityId: 'activity-2', startCapability: 's'.repeat(43), startExpiresAt: Date.now() + 30000 });
      }
      if (url.pathname.endsWith('/activity-2/start')) return json({ error: 'Unavailable' }, 503);
      if (url.pathname.endsWith('/activity-2')) return indexed
        ? json({ ...summary, activityId: 'activity-2', checkpoint: null, result: null })
        : json({ error: 'Not found' }, 404);
      return json({ items: [summary] });
    };
    render(() => <OperatorManagement />);
    fireEvent.input(screen.getByLabelText('Invocation JSON'), { target: { value: '{}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start activity' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/state could not be confirmed/i);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh activity state' })).not.toBeDisabled());
    expect(screen.getByRole('button', { name: 'Start activity' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh activity state' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Start activity' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'activity-2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/invocation requires its own grant/i);
    expect(screen.getByRole('button', { name: 'Start activity' })).toBeDisabled();
    indexed = true;
    fireEvent.click(screen.getByRole('button', { name: 'activity-2' }));
    expect(await screen.findByRole('heading', { name: 'Activity activity-2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start activity' })).not.toBeDisabled();
  });

  it('does not reconcile failed preparation against an earlier accepted activity', async () => {
    window.history.replaceState({}, '', '/operators?invoke=installation-1');
    let preparationAvailable = true;
    serve = (url, init) => {
      if (url.pathname === '/api/operator-activities' && init?.method === 'POST') return preparationAvailable
        ? json({ activityId: 'activity-1', startCapability: 's'.repeat(43), startExpiresAt: Date.now() + 30000 })
        : json({ error: 'Unavailable' }, 503);
      if (url.pathname.endsWith('/activity-1/start')) return json({ ok: true });
      if (url.pathname.endsWith('/activity-1')) return json({ ...summary, checkpoint: null, result: null });
      return json({ items: [summary] });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(screen.getByRole('button', { name: 'Start activity' }));
    expect(await screen.findByText(/Activity start accepted/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start activity' })).not.toBeDisabled());
    preparationAvailable = false;
    fireEvent.click(screen.getByRole('button', { name: 'Start activity' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/state could not be confirmed/i);
    await waitFor(() => expect(screen.getByRole('button', { name: 'activity-1' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'activity-1' }));
    expect(await screen.findByRole('heading', { name: 'Activity activity-1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start activity' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh activities' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start activity' })).not.toBeDisabled());
  });

  it('denies independent invocation and does not expose activity details on a denied list', async () => {
    serve = () => json({ error: 'Not found' }, 404);
    render(() => <OperatorManagement />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/invocation requires its own grant/i);
    expect(screen.queryByText('activity-1')).not.toBeInTheDocument();
  });
});
