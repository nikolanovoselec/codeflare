import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import OperatorManagement from '../../components/OperatorManagement';
import { getManagementChoices, type ManualInference } from '../../api/operator-management';

const grant = { users: ['viewer@example.test'], groups: [] };
const inference = { allowedSources: ['managed', 'pi-native'], routeIds: ['saved-route', 'draft-route'],
  defaultRouteId: 'saved-route', reasoningLevels: ['off', 'low', 'high'], defaultReasoningLevel: 'low', inheritUserDefaults: false };
const policy = { capabilities: ['inference'], resourceProfileId: null, inference };
const operator = { id: 'operator-1', name: 'Test Dispatcher', revision: 3, repositoryId: 123,
  repositoryUrl: 'https://github.com/acme/operator', profile: 'dispatcher', realm: 'internal', enabled: true,
  managers: grant, invokers: grant, policy, source: { kind: 'github-release', repositoryUrl: 'https://github.com/acme/operator',
    repositoryId: 123, credentialConfigured: true, approvedWorkflow: null } };
const release = { id: 'release-1', operatorId: operator.id, githubReleaseId: 456, sourceCommit: 'a'.repeat(40),
  manifestDigest: 'b'.repeat(64), bundleDigest: 'c'.repeat(64), interfaceVersion: 1, approved: true, tagName: 'v1',
  publishedAt: '2026-10-01T12:00:00Z', description: 'An installed Dispatcher.' };
const installation = { id: 'installation-1', operatorId: operator.id, name: 'default', releaseId: release.id,
  revision: 2, enabled: true, policy, configuration: { unrelated: 'retain' } };
const choices = { users: ['viewer@example.test'], groups: [], capabilities: ['inference'], resourceProfileIds: [],
  ceiling: { capabilities: ['inference'], resourceProfileIds: [] }, managedRoutes: [
    { id: 'saved-route', label: 'Saved Gateway', reasoningLevels: ['off', 'low', 'high'] },
    { id: 'draft-route', label: 'Draft Gateway', reasoningLevels: ['off', 'low', 'high'] },
  ] };
const native: ManualInference = { source: 'pi-native', status: 'selected', provider: 'saved-provider', model: 'saved-model', reasoningLevel: 'off' };
const managed: ManualInference = { source: 'managed', status: 'selected', provider: 'codeflare-gateway', model: 'saved-route',
  routeId: 'saved-route', reasoningLevel: 'low' };
let context: (id: string) => Promise<ManualInference | undefined>;
let installations = [installation];
let writes: unknown[];
beforeEach(() => {
  window.history.replaceState({}, '', '/operators?operator=operator-1');
  context = async () => native; installations = [installation]; writes = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, window.location.origin);
    if (init?.method === 'POST') { writes.push(JSON.parse(String(init.body))); return Response.json({ error: 'No mutation expected' }, { status: 409 }); }
    if (url.pathname.endsWith('/options')) return Response.json({ ...choices,
      inference: url.searchParams.has('installationId') ? await context(url.searchParams.get('installationId')!) : undefined });
    if (url.pathname.endsWith('/operator-1')) return Response.json({ operator, releases: [release], installations,
      grants: { managers: grant, invokers: grant } });
    return Response.json({ items: [operator], cursor: null });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const status = () => screen.getByRole('status', { name: 'Effective inference' });
const gatewayDetails = () => screen.getByText(/Gateway settings — inactive/, { selector: 'summary' }).parentElement as HTMLDetailsElement;

describe('REQ-OPERATOR-096 AC4/5/6/7: effective inference for your next manual run', () => {
  it('labels saved Native provider/model/reasoning as selection, not OAuth success, and preserves one collapsed inactive Gateway pair', async () => {
    render(() => <OperatorManagement userEmail="viewer@example.test" />);
    await waitFor(() => expect(status()).toHaveTextContent('saved-provider'));
    const region = screen.getByRole('region', { name: 'Your next manual run' });
    expect(status()).toHaveTextContent('saved-model'); expect(status()).toHaveTextContent('Reasoning: off');
    // Intentional user-copy contract: source heading and saved-status label are separate, with no em dash.
    expect(within(status()).getByText('Native selection', { selector: 'strong' })).toBeVisible();
    expect(within(status()).getByText('Saved in your R2 profile')).toBeVisible();
    expect(status()).not.toHaveTextContent('Native selection —');
    expect(region).toHaveTextContent('not proof of OAuth');
    expect(region).toHaveTextContent('not the operator creator or another account');
    expect(region).toHaveTextContent('not an automatic fallback');
    expect(gatewayDetails().open).toBe(false);
    // Native details stay in the document, collapsed and inactive until disclosure.
    expect(within(gatewayDetails()).getByRole('combobox', { name: 'default Managed Gateway route', hidden: true })).toBeDisabled();
    fireEvent.click(within(gatewayDetails()).getByText(/Gateway settings — inactive/, { selector: 'summary' }));
    expect(screen.getByRole('combobox', { name: 'default Managed Gateway route' })).toHaveValue('saved-route');
    expect(screen.getByRole('combobox', { name: 'default Managed reasoning' })).toHaveValue('low');
    expect(screen.getByRole('combobox', { name: 'default Managed Gateway route' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save model settings' })).toBeDisabled();
    expect(screen.queryByRole('combobox', { name: /Pi reasoning override/ })).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });
  it('keeps managed controls normal and shows the saved installation pair rather than unsaved drafts', async () => {
    context = async () => managed; render(() => <OperatorManagement />);
    await waitFor(() => expect(status()).toHaveTextContent('Managed selection'));
    expect(within(status()).getByText('Saved for this installation')).toBeVisible();
    expect(status()).not.toHaveTextContent('Managed selection —');
    const route = screen.getByRole('combobox', { name: 'default Managed Gateway route' });
    expect(route).toBeEnabled();
    fireEvent.change(route, { target: { value: 'draft-route' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'default Managed reasoning' }), { target: { value: 'high' } });
    expect(status()).toHaveTextContent('saved-route'); expect(status()).toHaveTextContent('Reasoning: low');
    expect(status()).not.toHaveTextContent('draft-route'); expect(screen.getByRole('button', { name: 'Save model settings' })).toBeEnabled();
    expect(writes).toEqual([]);
  });
  it('REQ-OPERATOR-075 AC5: a late Native status response collapses Gateway without resetting Gateway or Advanced drafts', async () => {
    let finish!: (value: ManualInference) => void;
    context = () => new Promise(resolve => { finish = resolve; });
    render(() => <OperatorManagement />);
    const route = await screen.findByRole('combobox', { name: 'default Managed Gateway route' });
    await waitFor(() => expect(route).toBeEnabled());
    fireEvent.change(route, { target: { value: 'draft-route' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'default Managed reasoning' }), { target: { value: 'high' } });
    fireEvent.click(screen.getByText('Advanced settings', { selector: 'summary' }));
    const limit = screen.getByRole('spinbutton', { name: 'Inference limit (bytes)' });
    fireEvent.input(limit, { target: { value: '2048' } });
    finish(native);
    await waitFor(() => expect(status()).toHaveTextContent('Native selection'));
    expect(limit).toHaveValue(2048);
    fireEvent.click(within(gatewayDetails()).getByText(/Gateway settings — inactive/, { selector: 'summary' }));
    expect(screen.getByRole('combobox', { name: 'default Managed Gateway route' })).toHaveValue('draft-route');
    expect(screen.getByRole('combobox', { name: 'default Managed reasoning' })).toHaveValue('high');
    fireEvent.click(screen.getByText('Advanced settings', { selector: 'summary' }));
    fireEvent.click(screen.getByText('Advanced settings', { selector: 'summary' }));
    expect(screen.getByRole('spinbutton', { name: 'Inference limit (bytes)' })).toHaveValue(2048);
    expect(writes).toEqual([]);
  });
  it('ignores a previous installation response after the invoking context changes', async () => {
    let finishFirst!: (value: ManualInference) => void;
    installations = [installation, { ...installation, id: 'installation-2', name: 'second' }];
    context = id => id === installation.id ? new Promise(resolve => { finishFirst = resolve; }) : Promise.resolve(managed);
    render(() => <OperatorManagement />);
    const selected = await screen.findByRole('combobox', { name: 'Installed configuration' });
    fireEvent.change(selected, { target: { value: installation.id } });
    await waitFor(() => expect(status()).toHaveTextContent('Loading'));
    fireEvent.change(selected, { target: { value: 'installation-2' } });
    await waitFor(() => expect(status()).toHaveTextContent('Managed selection'));
    finishFirst(native);
    await waitFor(() => expect(status()).not.toHaveTextContent('saved-provider'));
    expect(status()).toHaveTextContent('saved-route');
    expect(screen.getByRole('combobox', { name: 'second Managed Gateway route' })).toBeEnabled();
  });
  it.each([
    { value: { source: 'pi-native', status: 'blocked', reason: 'invocation-denied' }, copy: 'does not have invocation permission' },
    { value: { ...native, status: 'blocked', reason: 'policy-denied' }, copy: 'not approved by current restrictions' },
    { value: { source: 'managed', status: 'unconfigured' }, copy: 'Not configured' },
    { value: { source: 'pi-native', status: 'unconfigured' }, copy: 'save a provider and model in your R2 Pi profile' },
    { value: { source: 'pi-native', status: 'unavailable' }, copy: 'Selection unavailable' },
    { value: { ...native, reasoningLevel: null }, copy: 'Reasoning: Provider default' },
  ])('shows truthful selection state: $copy', async ({ value, copy }) => {
    context = async () => value as ManualInference; render(() => <OperatorManagement />);
    await waitFor(() => expect(status()).toHaveTextContent(copy)); expect(writes).toEqual([]);
  });
  it('does not invent selection or authentication success on status failure', async () => {
    context = async () => { throw new Error('Private transport failure'); };
    // A rejected network read is intentionally not an admission or an auth probe.
    render(() => <OperatorManagement />);
    await waitFor(() => expect(status()).toHaveTextContent('Selection unavailable'));
    expect(status()).not.toHaveTextContent('Private transport failure'); expect(writes).toEqual([]);
  });
});

describe('REQ-OPERATOR-096 AC1: inference options public decoding', () => {
  it('decodes contextual profile fields and rejects unsupported reasoning', async () => {
    context = async () => native;
    expect((await getManagementChoices('installation-1')).inference).toEqual(native);
    context = async () => ({ ...native, reasoningLevel: 'automatic' } as unknown as ManualInference);
    await expect(getManagementChoices('installation-1')).rejects.toThrow();
    context = async () => ({ source: 'pi-native', status: 'selected' });
    await expect(getManagementChoices('installation-1')).rejects.toThrow();
  });
});
