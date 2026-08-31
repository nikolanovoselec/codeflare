import { describe, expect, it } from 'vitest';
import { environmentAreas } from '../../components/admin/environment-areas';
import type { AdminConfigurationResponse } from '../../types';

function managedEnvironmentArea(section: unknown) {
  const configuration: AdminConfigurationResponse = {
    mode: 'enterprise',
    revision: 1,
    applicableSections: ['managedEnvironment'],
    sections: { managedEnvironment: section },
    activeRunId: null,
    latest: {},
  };
  return environmentAreas(configuration)[0];
}

describe('Environment area summaries', () => {
  it('REQ-SETUP-021 AC1: reports configured, disabled, and unconfigured managed-environment states', () => {
    expect(managedEnvironmentArea({ configured: true, enabled: true, activeReleaseTag: 'seed-v41' })).toMatchObject({
      summary: 'seed-v41',
      status: 'Configured',
    });
    expect(managedEnvironmentArea({ configured: true, enabled: false })).toMatchObject({
      summary: 'Managed environment disabled',
      status: 'Configured',
    });
    expect(managedEnvironmentArea({ configured: false, enabled: false })).toMatchObject({
      summary: 'No managed release selected',
      status: 'Not configured',
    });
  });
});
