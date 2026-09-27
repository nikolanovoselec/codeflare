import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import OperatorManagement from '../../components/OperatorManagement';
const summary = { activityId: 'activity-1', operatorId: 'operator-1', executionStatus: 'running', cleanupStatus: 'pending', collectionStatus: 'unavailable',
  attention: false, sessionId: null, source: null, updatedAt: Date.now() };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let serve: (url: URL, init?: RequestInit) => Response;
let preview: { name: string; version: string; guidedAssessment: boolean };
beforeEach(() => {
  window.history.replaceState({}, '', '/operators?view=activity');
  serve = () => json({ items: [summary] });
  preview = { name: 'Renovate Dispatcher', version: 'v0.1.2', guidedAssessment: true };
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => Promise.resolve(
    new URL(url).pathname.endsWith('/preview') ? json(preview) : serve(new URL(url), init))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('REQ-OPERATOR-049: human-owned invocation and activity', () => {
  it('returns from the guided form to the catalog without starting an activity', async () => {
    window.history.replaceState({}, '', '/operators?invoke=installation-1');
    let admissions = 0;
    serve = (url, init) => {
      if (url.pathname === '/api/operator-activities' && init?.method === 'POST') admissions++;
      return json({ items: [], cursor: null });
    };
    render(() => <OperatorManagement />);
    fireEvent.click(await screen.findByRole('link', { name: 'Back to operators' }));
    expect(await screen.findByRole('heading', { name: 'Catalog', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Assess a Renovate pull request' })).not.toBeInTheDocument();
    expect(window.location.search).toBe('');
    expect(admissions).toBe(0);
  });
  it('prefills a user-chosen read-only Renovate demo without starting it, and rejects invalid targets before preparation', async () => {
    window.history.replaceState({}, '', '/operators?invoke=installation-1&repository=nikolanovoselec%2Fkomodo&pullRequest=1253');
    let preparations = 0;
    serve = (url, init) => {
      if (url.pathname === '/api/operator-activities' && init?.method === 'POST') preparations++;
      return json({ items: [] });
    };
    render(() => <OperatorManagement />);
    expect(await screen.findByRole('textbox', { name: 'Repository' })).toHaveValue('nikolanovoselec/komodo');
    expect(screen.getByRole('spinbutton', { name: 'Pull request number' })).toHaveValue(1253);
    expect(preparations).toBe(0);
    fireEvent.input(screen.getByRole('textbox', { name: 'Repository' }), { target: { value: 'https://github.com/other/repository' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start assessment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/repository.*owner\/repository/i);
    expect(preparations).toBe(0);
  });
  it('does not offer a Renovate form for an unsupported installed package', async () => {
    window.history.replaceState({}, '', '/operators?invoke=installation-1');
    preview = { name: 'Another Dispatcher', version: 'v2', guidedAssessment: false };
    render(() => <OperatorManagement />);
    expect(await screen.findByText(/No guided assessment is available for Another Dispatcher/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start assessment' })).not.toBeInTheDocument();
  });
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
    await screen.findByRole('button', { name: 'Start assessment' });
    expect(screen.queryByLabelText('Invocation JSON')).not.toBeInTheDocument();
    fireEvent.input(screen.getByRole('textbox', { name: 'Repository' }), { target: { value: 'nikolanovoselec/komodo' } });
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Pull request number' }), { target: { value: '1253' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start assessment' }));
    await waitFor(() => expect(admitted).toEqual({ installationId: 'installation-1', invocation: { repository: 'nikolanovoselec/komodo', pullRequest: 1253 } }));
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
    await screen.findByRole('button', { name: 'Start assessment' });
    fireEvent.input(screen.getByRole('textbox', { name: 'Repository' }), { target: { value: 'nikolanovoselec/komodo' } });
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Pull request number' }), { target: { value: '1253' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start assessment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/state could not be confirmed/i);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh activity state' })).not.toBeDisabled());
    expect(screen.getByRole('button', { name: 'Start assessment' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh activity state' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Start assessment' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'activity-2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/invocation requires its own grant/i);
    expect(screen.getByRole('button', { name: 'Start assessment' })).toBeDisabled();
    indexed = true;
    fireEvent.click(screen.getByRole('button', { name: 'activity-2' }));
    expect(await screen.findByRole('heading', { name: 'Activity detail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start assessment' })).not.toBeDisabled();
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
    await screen.findByRole('button', { name: 'Start assessment' });
    fireEvent.input(screen.getByRole('textbox', { name: 'Repository' }), { target: { value: 'nikolanovoselec/komodo' } });
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Pull request number' }), { target: { value: '1253' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start assessment' }));
    expect(await screen.findByText(/Activity start accepted/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start assessment' })).not.toBeDisabled());
    preparationAvailable = false;
    fireEvent.click(screen.getByRole('button', { name: 'Start assessment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/state could not be confirmed/i);
    await waitFor(() => expect(screen.getByRole('button', { name: 'activity-1' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'activity-1' }));
    expect(await screen.findByRole('heading', { name: 'Activity detail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start assessment' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh activities' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start assessment' })).not.toBeDisabled());
  });

  it('denies independent invocation and does not expose activity details on a denied list', async () => {
    serve = () => json({ error: 'Not found' }, 404);
    render(() => <OperatorManagement />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/invocation requires its own grant/i);
    expect(screen.queryByText('activity-1')).not.toBeInTheDocument();
  });
});
