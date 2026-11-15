import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import OperatorManagementActivity from '../../components/OperatorManagementActivity';

let mutations: Array<{ path: string; body: unknown }>;
let inputSchema: Record<string, unknown>;
let supported: boolean;
const activity = { activityId: 'owned-run', operatorId: 'document-sync', executionStatus: 'queued',
  cleanupStatus: 'pending', collectionStatus: 'unavailable', attention: false,
  sessionId: null, source: null, updatedAt: 1, checkpoint: null, result: null };
const json = (value: unknown) => Response.json(value);
beforeEach(() => {
  mutations = []; inputSchema = { type: 'object', properties: {} }; supported = true;
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const path = new URL(input, window.location.origin).pathname;
    if (init?.method === 'POST') {
      mutations.push({ path, body: JSON.parse(String(init.body)) });
      return path === '/api/operator-activities'
        ? json({ activityId: 'owned-run', startCapability: 's'.repeat(43), startExpiresAt: Date.now() + 60_000 })
        : json({ ok: true });
    }
    if (path.endsWith('/preview')) return json({ name: 'Document sync', description: 'Synchronizes an approved collection.',
      version: 'v1.0.0', guidedAssessment: false, guidedMode: null, requiresSourceHost: false, inputSchema,
      application: supported ? { controlVersion: 1 } : null });
    if (path === '/api/operator-activities') return json({ items: [] });
    if (path === '/api/operator-activities/owned-run') return json(activity);
    return new Response(null, { status: 404 });
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const open = () => render(() => <OperatorManagementActivity installationId="installation" onBackToCatalog={() => {}} />);

describe('generic manual application intake', () => {
  it('REQ-OPERATOR-061: submits the ordinary configured invocation without requiring automatic runs or a workspace', async () => {
    open();
    const start = await screen.findByRole('button', { name: 'Start run' });
    expect(mutations).toEqual([]);
    expect(screen.queryByRole('combobox', { name: 'Source host' })).not.toBeInTheDocument();
    fireEvent.click(start);
    await waitFor(() => expect(mutations).toEqual([
      { path: '/api/operator-activities', body: { installationId: 'installation', invocation: {} } },
      { path: '/api/operator-activities/owned-run/start', body: { capability: 's'.repeat(43) } },
    ]));
    expect(await screen.findByText('Activity start accepted. Observe execution and cleanup separately.')).toBeVisible();
  });

  it('REQ-OPERATOR-209: application-declared input is required and preserved, without a Renovate-specific form', async () => {
    inputSchema = { type: 'object', required: ['collection'], properties: {
      collection: { type: 'string', title: 'Collection to synchronize', pattern: '^[a-z]+$' },
    } };
    open();
    const start = await screen.findByRole('button', { name: 'Start run' });
    fireEvent.submit(start.closest('form')!);
    expect(mutations).toEqual([]);
    fireEvent.input(screen.getByRole('textbox', { name: 'Collection to synchronize' }), { target: { value: 'invoices' } });
    fireEvent.submit(start.closest('form')!);
    await waitFor(() => expect(mutations[0]).toEqual({ path: '/api/operator-activities',
      body: { installationId: 'installation', invocation: { collection: 'invoices' } } }));
  });

  it('REQ-OPERATOR-014: an unsupported installed control contract cannot start work', async () => {
    supported = false; open();
    expect(await screen.findByText(/Install a compatible release before starting Document sync/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Start run' })).not.toBeInTheDocument();
    expect(mutations).toEqual([]);
  });
});
