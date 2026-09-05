import { cleanup, render } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import EnvironmentAreaFields, { environmentValues } from '../../components/admin/EnvironmentAreaFields';

afterEach(cleanup);

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

  it('REQ-ENTERPRISE-031 AC4: edits route reasoning profiles beside existing route context configuration', () => {
    const current = {
      gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway',
      dynamicRoutes: ['development'],
      defaultRoute: { route: 'development', reasoning: 'high' },
      routeContextWindows: { development: 262144 },
      routeReasoningProfiles: { development: 'workers-ai-kimi-k2.6' },
      groupRouting: [],
    };
    const { getByLabelText, container } = render(() => (
      <EnvironmentAreaFields section="aiRouting" mode="enterprise" current={current} />
    ));

    expect((getByLabelText('development reasoning profile') as HTMLSelectElement).value)
      .toBe('workers-ai-kimi-k2.6');

    const form = document.createElement('form');
    form.append(...Array.from(container.querySelectorAll('input, select, textarea')).map((node) => node.cloneNode(true)));
    const values = environmentValues('aiRouting', 'enterprise', new FormData(form)) as Record<string, unknown>;
    expect(values.routeReasoningProfiles).toEqual({ development: 'workers-ai-kimi-k2.6' });
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
