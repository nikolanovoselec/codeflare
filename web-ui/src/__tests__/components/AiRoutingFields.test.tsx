import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import EnvironmentAreaFields from '../../components/admin/EnvironmentAreaFields';

const current = {
  gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway',
  dynamicRoutes: ['general_usage', 'development'],
  defaultRoute: { route: 'general_usage', reasoning: 'off' },
  routeContextWindows: { general_usage: 262144, development: 131072 },
  reasoningCatalog: {
    profiles: [
      { id: 'workers-ai-glm-thinking', revision: 1, name: 'GLM thinking', supportedLevels: ['off', 'medium', 'high'] },
      { id: 'workers-ai-kimi-k-thinking', revision: 1, name: 'Kimi thinking', supportedLevels: ['medium', 'high'] },
    ],
  },
  reasoningConfiguration: {
    schemaVersion: 1,
    customProfileRevisions: [],
    routeAssignments: {
      general_usage: { activeProfile: { id: 'workers-ai-glm-thinking', revision: 1, hash: 'a'.repeat(64) } },
      development: { activeProfile: { id: 'workers-ai-kimi-k-thinking', revision: 1, hash: 'b'.repeat(64) } },
    },
  },
  groupRouting: [
    { accessGroup: 'developers', routes: ['general_usage', 'development'], defaultRoute: 'development', reasoning: 'medium' },
    { accessGroup: 'support', routes: ['general_usage'], defaultRoute: 'general_usage', reasoning: 'off' },
  ],
};

afterEach(cleanup);

describe('REQ-ENTERPRISE-031 structured AI routing', () => {
  it('preserves many-to-many group routes with one scope default route and reasoning', () => {
    const { getByLabelText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    expect(getByLabelText('developers allowed routes')).toBeTruthy();
    expect((getByLabelText('developers default route') as HTMLSelectElement).value).toBe('development');
    expect((getByLabelText('developers default reasoning') as HTMLSelectElement).value).toBe('medium');
    expect(getByLabelText('support allowed routes')).toBeTruthy();
  });

  it('adds and removes route cards and exposes context, profile, inventory, and discovery actions', async () => {
    const { getByRole, getByLabelText, queryByLabelText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    expect(getByLabelText('general_usage context window')).toBeTruthy();
    expect(getByLabelText('development capability profile')).toBeTruthy();
    expect(getByRole('button', { name: /inspect development route/i })).toBeTruthy();
    expect(getByRole('button', { name: /discover development compatibility/i })).toBeTruthy();

    await fireEvent.click(getByRole('button', { name: /remove development route/i }));
    expect(queryByLabelText('development context window')).toBeNull();
  });

  it('applies one group policy to all groups only after showing affected groups', async () => {
    const { getByRole, getByText } = render(() => <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />);
    await fireEvent.click(getByRole('button', { name: /apply to all groups/i }));
    expect(getByText(/developers.*support|support.*developers/i)).toBeTruthy();
    expect(getByRole('button', { name: /confirm group changes/i })).toBeTruthy();
  });
});
