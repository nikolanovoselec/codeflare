import { describe, expect, it } from 'vitest';
import { environmentAreas, filterEnvironmentAreas } from '../../components/admin/environment-areas';
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

  it('uses singular labels for one administrator and one user group', () => {
    const configuration: AdminConfigurationResponse = {
      mode: 'enterprise', revision: 1, applicableSections: ['access'], activeRunId: null, latest: {},
      sections: { access: { adminUsers: ['admin@example.com'], userAccessGroups: ['employees'] } },
    };

    expect(environmentAreas(configuration)[0].summary).toBe('1 administrator · 1 user group');
  });

  it('REQ-SETUP-019 AC8: filters loaded areas by label, description, and current summary', () => {
    const configuration: AdminConfigurationResponse = {
      mode: 'enterprise', revision: 1, applicableSections: ['domain', 'usageReports'], activeRunId: null, latest: {},
      sections: { domain: { customDomain: 'enterprise.example.com' }, usageReports: { enabled: false } },
    };
    const areas = environmentAreas(configuration);

    expect(filterEnvironmentAreas(areas, 'DNS').map((area) => area.section)).toEqual(['domain']);
    expect(filterEnvironmentAreas(areas, 'monthly delivery').map((area) => area.section)).toEqual(['usageReports']);
    expect(filterEnvironmentAreas(areas, 'ENTERPRISE.EXAMPLE.COM').map((area) => area.section)).toEqual(['domain']);
  });
});
