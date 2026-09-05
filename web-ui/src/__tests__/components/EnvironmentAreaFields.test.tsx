import { cleanup, render } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EnvironmentAreaFields, { environmentValues } from '../../components/admin/EnvironmentAreaFields';

const catalogMock = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({
  getReasoningCatalog: (...args: unknown[]) => catalogMock(...args),
  getReasoningRouteInventory: vi.fn(),
  discoverReasoningCompatibility: vi.fn(),
}));

beforeEach(() => {
  catalogMock.mockResolvedValue({
    schemaVersion: 1,
    profiles: [{ id: 'workers-ai-kimi-k-thinking', revision: 1, hash: 'a'.repeat(64), name: 'Kimi thinking', supportedLevels: ['medium', 'high'] }],
    notices: [],
    usage: [],
    routes: ['development'],
    routeCatalogStatus: 'ready',
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Environment report fields', () => {
  it('REQ-SETUP-020 AC1: renders canonical IANA timezone choices as a select', () => {
    const { getByLabelText } = render(() => (
      <EnvironmentAreaFields
        section="usageReports"
        mode="enterprise"
        current={{ enabled: true, recipients: [], day: 1, hour: 9, timezone: 'Europe/Zurich' }}
      />
    ));

    const timezone = getByLabelText('IANA timezone') as HTMLSelectElement;
    expect(timezone.tagName).toBe('SELECT');
    expect(timezone.value).toBe('Europe/Zurich');
    expect(Array.from(timezone.options, (option) => option.value)).toContain('UTC');
  });

  it('REQ-ENTERPRISE-031 AC11: delegates AI routing to structured controls without JSON authoring', async () => {
    const current = {
      gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway',
      dynamicRoutes: ['development'],
      defaultRoute: { route: 'development', reasoning: 'high' },
      routeContextWindows: { development: 262144 },
      reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: { development: { activeProfile: { id: 'workers-ai-kimi-k-thinking', revision: 1, hash: 'a'.repeat(64) } } } },
      groupRouting: [{ accessGroup: 'developers', routes: ['development'], defaultRoute: 'development', reasoning: 'medium' }],
    };
    const { getByLabelText, queryByLabelText, queryByRole, findByText, container } = render(() => (
      <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />
    ));
    await findByText('Selected: Kimi thinking');

    expect(queryByRole('button', { name: /add route/i })).toBeNull();
    expect((getByLabelText('development context window') as HTMLInputElement).value).toBe('262144');
    expect((getByLabelText('development capability profile') as HTMLSelectElement).selectedOptions[0]?.textContent).toContain('Kimi thinking');
    expect(getByLabelText('developers allowed routes')).toBeTruthy();
    expect(queryByLabelText(/route context windows.*json/i)).toBeNull();
    expect(queryByLabelText(/per-group routing.*json/i)).toBeNull();
    expect(Array.from(container.querySelectorAll('textarea')).every((field) => field.readOnly)).toBe(true);

    const form = document.createElement('form');
    form.append(container.firstElementChild!);
    const values = environmentValues('aiRouting', 'enterprise', new FormData(form)) as Record<string, any>;
    expect(values.dynamicRoutes).toEqual(['development']);
    expect(values.groupRouting[0]).toMatchObject({ accessGroup: 'developers', routes: ['development'], defaultRoute: 'development', reasoning: 'medium' });
    expect(values.reasoningConfiguration.routeAssignments.development.activeProfile.id).toBe('workers-ai-kimi-k-thinking');
  });

  it('REQ-SETUP-020 AC2: retains an accepted stored timezone outside bundled choices', () => {
    const { getByLabelText } = render(() => (
      <EnvironmentAreaFields
        section="usageReports"
        mode="enterprise"
        current={{ enabled: true, recipients: [], day: 1, hour: 9, timezone: 'Etc/GMT+1' }}
      />
    ));

    const timezone = getByLabelText('IANA timezone') as HTMLSelectElement;
    expect(timezone.value).toBe('Etc/GMT+1');
    expect(Array.from(timezone.options, (option) => option.value)[0]).toBe('Etc/GMT+1');
  });
});
