import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { Route, Router } from '@solidjs/router';
import { Show, createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationPreview } from '../../api/client';
import type { ProfileRevisionRef, ReasoningDiscoveryRequest, ReasoningManagementContext, ReasoningRouteVerification } from '../../types';

const api = vi.hoisted(() => ({ configuration: vi.fn(), catalog: vi.fn(), inventory: vi.fn(), discover: vi.fn(), preview: vi.fn(), start: vi.fn() }));
vi.mock('../../api/client', () => ({
  getAdminConfiguration: (...args: unknown[]) => api.configuration(...args),
  getReasoningCatalog: (...args: unknown[]) => api.catalog(...args),
  getReasoningRouteInventory: (...args: unknown[]) => api.inventory(...args),
  previewConfiguration: (...args: unknown[]) => api.preview(...args),
  startConfigurationRun: (...args: unknown[]) => api.start(...args),
  discoverReasoningCompatibility: (...args: unknown[]) => api.discover(...args),
  getConfigurationRun: vi.fn(),
  ConfigurationRequestError: class extends Error {},
}));

import AiRoutingReview, { AiRoutingSummary } from '../../components/admin/AiRoutingReview';
import AdministrationLayout from '../../components/admin/AdministrationLayout';
import { EnvironmentAreaDetail } from '../../components/admin/EnvironmentIndex';
import { normalizeCustomProfile } from '../../../../src/lib/reasoning-profiles';

const builtin = { id: 'workers-ai-glm-thinking', revision: 1, hash: 'a'.repeat(64) };
const custom = { id: 'custom-platform', revision: 2, hash: 'b'.repeat(64), name: 'Platform reasoning' };
const gatewayUrl = 'https://gateway.ai.cloudflare.com/v1/account/gateway';
const values = () => ({
  gatewayUrl, replacementToken: '', dynamicRoutes: ['development', 'production'],
  defaultRoute: { route: 'development', reasoning: 'medium' },
  routeContextWindows: { development: 262144, production: 128000 },
  reasoningConfiguration: {
    schemaVersion: 1, customProfileRevisions: [custom],
    routeAssignments: { development: { activeProfile: builtin }, production: { activeProfile: { id: custom.id, revision: custom.revision, hash: custom.hash } } },
  },
  groupRouting: [{ accessGroup: 'Platform engineers', routes: ['development', 'production'], defaultRoute: 'production', reasoning: 'high' }],
});
const preview = (overrides: Partial<ConfigurationPreview> = {}): ConfigurationPreview => ({
  section: 'aiRouting', baseRevision: 7, currentRevision: 7,
  changes: [
    { field: 'replacementToken', secret: { willReplace: false } },
    { field: 'reasoningConfiguration', after: values().reasoningConfiguration },
  ],
  tasks: [{ id: 'configure_model_routing', dependsOn: [] }],
  warnings: [], exclusions: ['configure_custom_domain'], ...overrides,
});
const renderReview = (submitted: unknown = values(), reviewed = preview(), current: unknown = {}) => render(() => {
  const [warnings, setWarnings] = createSignal<string[]>([]);
  const [outcome, setOutcome] = createSignal('');
  return <>
    <AiRoutingReview values={submitted} current={current} preview={reviewed} confirmedWarnings={warnings()}
      onWarningChange={(code, checked) => setWarnings((codes) => checked ? [...codes, code] : codes.filter((item) => item !== code))}
      onBack={() => setOutcome('Editing again')}
      onConfirm={() => setOutcome(`Confirmation requested: ${warnings().join(', ')}`)} />
    <Show when={outcome()}><output>{outcome()}</output></Show>
  </>;
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('AI routing review', () => {
  it('REQ-ENTERPRISE-041: summarizes routing changes in human-readable sections', () => {
    renderReview();
    expect(within(screen.getByRole('region', { name: 'Connection' })).getByText(gatewayUrl)).toBeVisible();
    expect(screen.getByText('Preserve saved token')).toBeVisible();
    const table = screen.getByRole('table', { name: 'Route profiles' });
    const development = within(table).getByRole('row', { name: /development/ });
    expect(within(development).getByText('Workers AI · GLM')).toBeVisible();
    expect(within(development).getByText('262,144 tokens')).toBeVisible();
    const production = within(table).getByRole('row', { name: /production/ });
    expect(within(production).getByText('Platform reasoning')).toBeVisible();
    expect(within(production).getByText('128,000 tokens')).toBeVisible();
    const group = within(screen.getByRole('region', { name: 'Group access' })).getByRole('article', { name: 'Platform engineers' });
    expect(within(group).getByRole('list', { name: 'Allowed routes' }).textContent).toBe('developmentproduction');
    expect(within(group).getByText('High')).toBeVisible();
    const fallback = screen.getByRole('region', { name: 'Fallback' });
    expect(within(fallback).getByText(/users without a matching group policy/i)).toBeVisible();
    expect(within(fallback).getByText('Medium')).toBeVisible();
    expect(within(fallback).getByRole('list', { name: 'Allowed routes' }).children).toHaveLength(2);
    expect(table.textContent).not.toContain(builtin.id);
    expect(table.textContent).not.toContain(builtin.hash);
    expect(table.textContent).not.toContain(custom.hash);
  });

  it('REQ-ENTERPRISE-041: resolves pending custom names by exact submitted revision without using a newer or mismatched profile', () => {
    const submitted = values();
    submitted.reasoningConfiguration.customProfileRevisions = [
      { ...custom, revision: 1, name: 'Old name' },
      { ...custom, hash: 'c'.repeat(64), name: 'Wrong hash name' },
      custom,
      { ...custom, id: 'custom-unassigned', name: 'Unassigned profile' },
    ];
    renderReview(submitted, preview(), { reasoningConfiguration: { customProfileRevisions: [{ ...custom, revision: 1 }] } });
    const row = within(screen.getByRole('table', { name: 'Route profiles' })).getByRole('row', { name: /production/ });
    expect(within(row).getByText('Platform reasoning')).toBeVisible();
    expect(within(row).getByText('Pending save')).toBeVisible();
    expect(row.textContent).not.toContain('Old name');
    expect(row.textContent).not.toContain('Wrong hash name');
    const pending = screen.getByRole('region', { name: 'Other profiles pending save' });
    expect(within(pending).getByText('Unassigned profile')).toBeVisible();
    expect(within(pending).getAllByText('Unassigned').length).toBeGreaterThan(0);
  });

  it('REQ-ENTERPRISE-041: masks secrets in summaries, warnings and expanded technical details without rendering raw changes', async () => {
    const token = 'replacement-token-must-stay-private';
    const previous = 'previous-token-must-stay-private';
    const { container } = renderReview({ ...values(), replacementToken: token,
      gatewayUrl: `https://operator:password-in-url@gateway.ai.cloudflare.com/v1/account/gateway?token=${token}#private`,
    }, preview({ changes: [
      { field: 'replacementToken', before: previous, after: token, secret: { willReplace: true } },
      { field: 'unexpectedCredential', after: 'another-private-value', secret: { willReplace: true } },
    ], warnings: [{ code: 'check_token', message: `Check the replacement ${token} before saving.` }] }));
    expect(screen.getByText('Replace saved token')).toBeVisible();
    expect(screen.getByText(gatewayUrl)).toBeVisible();
    expect(screen.getByText('Check the replacement [redacted] before saving.')).toBeVisible();
    await fireEvent.click(screen.getByText('Technical details'));
    expect(screen.getByText('configure_model_routing')).toBeVisible();
    for (const secret of [token, previous, 'another-private-value', 'password-in-url']) expect(container.innerHTML).not.toContain(secret);
    expect(container.textContent).not.toContain('unexpectedCredential');
    expect(container.textContent).not.toContain('replacementToken');
  });

  it('REQ-ENTERPRISE-041: preserves every route in long route sets and separates restricted fallback access from group access', () => {
    const routes = Array.from({ length: 24 }, (_, index) => `region-${index + 1}-long-production-route`);
    renderReview({ ...values(), dynamicRoutes: routes,
      routeContextWindows: Object.fromEntries(routes.map((route) => [route, 262144])),
      reasoningConfiguration: { customProfileRevisions: [], routeAssignments: Object.fromEntries(routes.map((route) => [route, { activeProfile: builtin }])) },
      groupRouting: [{ accessGroup: 'All regions', routes, defaultRoute: routes[0], reasoning: 'off' }],
      defaultRoute: { enabled: true, routes: routes.slice(0, 2), route: routes[0], reasoning: 'off' },
    });
    const table = screen.getByRole('table', { name: 'Route profiles' });
    expect(within(table).getAllByRole('row')).toHaveLength(25);
    const allowed = within(screen.getByRole('region', { name: 'Group access' })).getByRole('list', { name: 'Allowed routes' });
    expect(within(allowed).getAllByRole('listitem').map((item) => item.textContent)).toEqual(routes);
    for (const route of routes) expect(within(table).getByRole('row', { name: new RegExp(`^${route} `) })).toBeInTheDocument();
    const fallback = within(screen.getByRole('region', { name: 'Fallback' })).getByRole('list', { name: 'Allowed routes' });
    expect(within(fallback).getAllByRole('listitem').map((item) => item.textContent)).toEqual(routes.slice(0, 2));
  });

  it('REQ-ENTERPRISE-041: disabled fallback shows no access rather than implying its retained default grants access', () => {
    renderReview({ ...values(), defaultRoute: { enabled: false, routes: ['development'], route: 'development', reasoning: 'medium' }, groupRouting: [] });
    const fallback = screen.getByRole('region', { name: 'Fallback' });
    expect(within(fallback).getByText('No fallback access')).toBeVisible();
    expect(within(fallback).queryByText('development')).not.toBeInTheDocument();
    expect(within(fallback).queryByRole('list')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Group access' })).getByText('No group policies')).toBeVisible();
  });

  it.each(['top-level', 'reasoning configuration'] as const)('REQ-ENTERPRISE-041: uses explicit %s fallback preview data instead of the compatibility default', (location) => {
    const fallbackRouting = { enabled: true, routes: ['production'], defaultRoute: 'production', reasoning: 'high' };
    const changes = location === 'top-level'
      ? [{ field: 'fallbackRouting', after: fallbackRouting }]
      : [{ field: 'reasoningConfiguration', after: { ...values().reasoningConfiguration, fallbackRouting } }];
    renderReview(values(), preview({ changes }));
    const fallback = screen.getByRole('region', { name: 'Fallback' });
    expect(within(fallback).getByText(/users without a matching group policy/i)).toBeVisible();
    expect(within(fallback).getByRole('list', { name: 'Allowed routes' }).textContent).toBe('production');
    expect(within(fallback).getByText('High')).toBeVisible();
    expect(within(fallback).queryByText('development')).not.toBeInTheDocument();
    expect(screen.getAllByRole('region', { name: 'Fallback' })).toHaveLength(1);
  });

  it.each(['top-level', 'reasoning configuration'] as const)('REQ-ENTERPRISE-041: submitted %s disabled fallback overrides an enabled compatibility default', (location) => {
    const submitted = location === 'top-level'
      ? { ...values(), fallbackRouting: { enabled: false } }
      : { ...values(), reasoningConfiguration: { ...values().reasoningConfiguration, fallbackRouting: { enabled: false } } };
    renderReview(submitted);
    const fallback = screen.getByRole('region', { name: 'Fallback' });
    expect(within(fallback).getByText('No fallback access')).toBeVisible();
    expect(within(fallback).queryByRole('list')).not.toBeInTheDocument();
    expect(within(fallback).queryByText('development')).not.toBeInTheDocument();
  });

  it('REQ-ENTERPRISE-041: warnings require individual acknowledgement and an explicit Confirm Save action', async () => {
    renderReview(values(), preview({ warnings: [
      { code: 'observed_path', message: 'Production: observed path passed, but multi-model coverage is incomplete. Review the route before saving.' },
      { code: 'fallback', message: 'Fallback access includes all configured routes.' },
    ] }));
    const warnings = screen.getByRole('region', { name: 'Warnings to acknowledge' });
    expect(within(warnings).getByText(/observed path passed, but multi-model coverage is incomplete/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Confirm Save' })).toBeDisabled();
    expect(screen.queryByText(/Confirmation requested:/)).not.toBeInTheDocument();
    const boxes = within(warnings).getAllByRole('checkbox');
    await fireEvent.click(boxes[0]);
    expect(screen.getByRole('button', { name: 'Confirm Save' })).toBeDisabled();
    await fireEvent.click(boxes[1]);
    expect(screen.getByRole('button', { name: 'Confirm Save' })).toBeEnabled();
    expect(screen.queryByText(/Confirmation requested:/)).not.toBeInTheDocument();
    await fireEvent.click(boxes[0]);
    expect(screen.getByRole('button', { name: 'Confirm Save' })).toBeDisabled();
    await fireEvent.click(boxes[0]);
    const technical = screen.getByText('Technical details').closest('details')!;
    expect(technical.open).toBe(false);
    await fireEvent.click(screen.getByText('Technical details'));
    expect(technical.open).toBe(true);
    expect(within(technical).getByText('Update model routing')).toBeVisible();
    expect(screen.queryByText(/Confirmation requested:/)).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm Save' }));
    expect(screen.getByText('Confirmation requested: fallback, observed_path')).toBeVisible();
  });

  it('REQ-ENTERPRISE-041: an unchanged review allows Back to edit without offering a save', async () => {
    renderReview(values(), preview({ changes: [] }));
    expect(screen.getByRole('heading', { name: 'No changes detected' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Confirm Save' })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Back to edit' }));
    expect(screen.getByText('Editing again')).toBeVisible();
    expect(screen.queryByText(/Confirmation requested:/)).not.toBeInTheDocument();
  });

  it('REQ-ENTERPRISE-041: a successful save reuses readable values without pending labels or credential values', () => {
    const { container } = render(() => <AiRoutingSummary values={{ ...values(), replacementToken: 'secret-after-save' }} current={{}}
      changes={[{ field: 'replacementToken', secret: { willReplace: true } }]} saved />);
    expect(screen.getByRole('table', { name: 'Route profiles' })).toBeVisible();
    expect(screen.getByText('Platform reasoning')).toBeVisible();
    expect(screen.getByText('Saved token replaced')).toBeVisible();
    expect(screen.queryByText('Pending save')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain('secret-after-save');
  });

  it('REQ-ENTERPRISE-041: Back to edit retains the draft and confirmed Save submits unchanged values, warning codes and baseRevision', async () => {
    const storedProfile = normalizeCustomProfile({
      id: custom.id, name: custom.name, revision: custom.revision, schemaVersion: 1, enabled: true,
      supportedLevels: ['off', 'medium', 'high'], removePaths: ['reasoning_effort'],
      levels: { off: [{ path: 'reasoning_effort', value: null }], medium: [{ path: 'reasoning_effort', value: 'medium' }], high: [{ path: 'reasoning_effort', value: 'high' }] },
      offSemantics: { status: 'explicit-value', path: 'reasoning_effort', value: null },
    });
    const refs: Record<string, ProfileRevisionRef> = {
      development: builtin, production: { id: storedProfile.id, revision: storedProfile.revision, hash: storedProfile.hash },
    };
    const proof = (route: string, connectionFingerprint: string): ReasoningRouteVerification => ({
      schemaVersion: 1, profileRef: refs[route], routeVersion: `${route}-v1`, inventoryDigest: `${route}-digest`,
      connectionFingerprint, canaryVersion: 'canary', supportedLevels: ['off', 'medium', 'high'],
      scope: route === 'production' ? 'observed-path' : 'single-model', checkedAt: '2026-09-06T12:00:00Z',
    });
    const initial = { ...values(), reasoningConfiguration: { ...values().reasoningConfiguration, customProfileRevisions: [storedProfile], fallbackRouting: { enabled: false },
      routeAssignments: Object.fromEntries(Object.entries(refs).map(([route, activeProfile]) => [route, { activeProfile, verification: proof(route, 'saved-connection') }])),
    } };
    const gateway = { gatewayUrl: `${gatewayUrl}-edited`, replacementToken: 'never-display-this-token' };
    api.configuration.mockResolvedValue({ mode: 'enterprise', revision: 7, applicableSections: ['aiRouting'], sections: { aiRouting: { ...initial, tokenState: 'administration', availableAccessGroups: ['Platform engineers'] } }, activeRunId: null, latest: {} });
    api.catalog.mockResolvedValue({ schemaVersion: 1, profiles: [
      { ...builtin, name: 'GLM thinking', enabled: true, supportedLevels: ['off', 'medium', 'high'] },
      storedProfile,
    ], notices: [], usage: [], routes: initial.dynamicRoutes, routeCatalogStatus: 'ready', connection: { status: 'ready', message: 'Routes can be read.' } });
    api.inventory.mockImplementation(async (route: string, context?: ReasoningManagementContext) => ({
      route, routeVersion: `${route}-v1`, inventoryDigest: `${route}-digest`,
      legs: [{ nodeId: `${route}-model`, provider: 'workers-ai', declaredModel: `@cf/${route}` },
        ...(route === 'production' ? [{ nodeId: 'backup', provider: 'openai', declaredModel: 'backup-model' }] : [])],
      ...(!context?.gateway && { verification: proof(route, 'saved-connection') }),
    }));
    // These are selected-check server responses. The component still has to read matching
    // before/after inventories and retain each receipt before a policy is eligible.
    api.discover.mockImplementation(async (request: ReasoningDiscoveryRequest) => ({
      classification: 'Verified', assignable: true, compatibleLevels: ['off', 'medium', 'high'], diagnostics: [],
      checkId: `${request.route}-edited-check`, verification: proof(request.route, 'edited-connection'),
    }));
    api.preview.mockImplementation(async (_section, _revision, submitted) => preview({ changes: [
      { field: 'gatewayUrl', after: submitted.gatewayUrl },
      { field: 'replacementToken', secret: { willReplace: true } },
      { field: 'reasoningConfiguration', after: submitted.reasoningConfiguration },
    ], warnings: [{ code: 'reasoning_observed_path', message: 'Production passed on the observed path. Other backends remain untested.' }] }));
    api.start.mockResolvedValue(new Response(`${JSON.stringify({ type: 'snapshot', run: { runId: 'private-execution-id', section: 'aiRouting', state: 'succeeded', tasks: [{ id: 'configure_model_routing', state: 'succeeded' }], resultingRevision: 8 } })}\n`));
    window.history.replaceState({}, '', '/admin/environment/aiRouting');
    render(() => <Router><Route path="/admin" component={AdministrationLayout}><Route path="/environment/:section" component={EnvironmentAreaDetail} /></Route></Router>);
    const section = async (name: string) => {
      const navigation = await screen.findByRole('navigation', { name: 'AI Gateway configuration sections' });
      await fireEvent.click(within(navigation).getByRole('button', { name }));
    };
    await screen.findByRole('button', { name: 'Save' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await section('Connection');
    await fireEvent.input(screen.getByLabelText('AI Gateway URL'), { target: { value: gateway.gatewayUrl } });
    await fireEvent.input(screen.getByLabelText('Replacement API token'), { target: { value: gateway.replacementToken } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!);
    expect(api.preview).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Check connection' }));
    await waitFor(() => expect(screen.getByText('Connected · 2 routes readable')).toBeVisible());
    expect(api.catalog).toHaveBeenLastCalledWith(gateway);
    expect(api.discover).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await section('Routes');
    for (const route of initial.dynamicRoutes) {
      await fireEvent.click(screen.getByRole('button', { name: `Configure ${route}` }));
      expect(screen.getByRole('combobox', { name: `${route} Pi compatibility profile` })).toHaveValue(`${refs[route].id}\u001f${refs[route].revision}\u001f${refs[route].hash}`);
      const verify = screen.getByRole('button', { name: `Verify Profile for ${route}` });
      await waitFor(() => expect(verify).toBeEnabled());
      await fireEvent.click(verify);
      expect(await within(screen.getByRole('article', { name: `${route} route` })).findByText('Check passed. Assign access and confirm Save to activate this draft.')).toBeVisible();
      expect(api.discover).toHaveBeenCalledWith({ route, profileRef: refs[route], gateway, maxCompletionTokens: 4096 });
      expect(api.inventory).toHaveBeenCalledWith(route, { gateway });
    }
    expect(screen.getByText(/Other backends remain untested/)).toBeVisible();
    await section('Access & fallback');
    expect(screen.getByRole('checkbox', { name: 'Platform engineers development route' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Platform engineers production route' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Enable fallback access' })).not.toBeChecked();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'Confirm Save' });
    expect(screen.getByRole('table', { name: 'Route profiles' })).toBeVisible();
    expect(screen.getByText('No fallback access')).toBeVisible();
    expect(document.body.textContent).not.toContain(gateway.replacementToken);
    expect(api.start).not.toHaveBeenCalled();
    const firstPreview = api.preview.mock.calls[api.preview.mock.calls.length - 1]![2];
    expect(firstPreview).toEqual({ ...initial, ...gateway, defaultRoute: { route: 'production', reasoning: 'high' },
      fallbackRouting: { enabled: false }, routeChecks: { development: 'development-edited-check', production: 'production-edited-check' },
      reasoningConfiguration: { ...initial.reasoningConfiguration, routeAssignments: Object.fromEntries(Object.entries(refs).map(([route, activeProfile]) => [route, { activeProfile, routeVersion: `${route}-v1`, verification: proof(route, 'edited-connection') }])) },
    });
    await fireEvent.click(screen.getByRole('checkbox', { name: /confirm warning/i }));
    expect(screen.getByRole('button', { name: 'Confirm Save' })).toBeEnabled();
    await fireEvent.click(screen.getByRole('button', { name: 'Back to edit' }));
    await section('Connection');
    expect(screen.getByLabelText('AI Gateway URL')).toHaveValue(gateway.gatewayUrl);
    expect(screen.getByLabelText('Replacement API token')).toHaveValue(gateway.replacementToken);
    await section('Routes');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Configure production' })).toHaveTextContent('Compatible · backup untested'));
    expect(screen.getByRole('button', { name: 'Configure development' })).toHaveTextContent('Verified');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    // Back rereads inventories with the draft credentials and reuses the receipts;
    // it must neither discard the replacement token nor incur paid Verify again.
    expect(api.discover).toHaveBeenCalledTimes(2);
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'Confirm Save' });
    expect(api.preview).toHaveBeenLastCalledWith('aiRouting', 7, firstPreview);
    expect(screen.getByRole('button', { name: 'Confirm Save' })).toBeDisabled();
    await fireEvent.click(screen.getByRole('checkbox', { name: /confirm warning/i }));
    expect(api.start).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm Save' }));
    await screen.findByText('Saved token replaced');
    expect(api.start).toHaveBeenCalledWith('aiRouting', 7, firstPreview, ['reasoning_observed_path']);
    expect(screen.getByRole('table', { name: 'Route profiles' })).toBeVisible();
    expect(screen.getByText('Platform reasoning')).toBeVisible();
    const technical = screen.getByText('Technical details').closest('details')!;
    expect(technical.open).toBe(false);
    expect(within(technical).getByText('private-execution-id')).not.toBeVisible();
    expect(document.body.textContent).not.toContain(gateway.replacementToken);
  });
});
