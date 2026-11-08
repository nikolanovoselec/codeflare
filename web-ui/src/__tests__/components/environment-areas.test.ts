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
  it.each([undefined, 'exclude', 'include'])('Data governance summary makes selected persistence scope %s discoverable', syncPolicyMode => {
    const configuration: AdminConfigurationResponse = {
      mode: 'enterprise', revision: 1, applicableSections: ['dataGovernance'], activeRunId: null, latest: {},
      sections: { dataGovernance: { governedMode: false, viewOnlyStorage: false, syncPolicyMode } },
    };
    const areas = environmentAreas(configuration);
    expect(areas[0].summary).toContain(syncPolicyMode === 'include' ? 'approved locations only' : 'save unless excluded');
    expect(filterEnvironmentAreas(areas, 'persistence').map(area => area.section)).toEqual(['dataGovernance']);
  });

  it('REQ-SETUP-023 AC3: orders areas by displayed label without changing their summaries or authoritative input', () => {
    const configuration: AdminConfigurationResponse = {
      mode: 'enterprise', revision: 1, applicableSections: ['securityEgress', 'mcpPortals', 'domain', 'aiRouting', 'access'],
      activeRunId: null, latest: {}, sections: {
        securityEgress: { strictGatewayEgress: true },
        mcpPortals: { portals: [{ name: 'tools', url: 'https://portal.example.com/mcp' }] },
        domain: { customDomain: 'enterprise.example.com' },
        aiRouting: { tokenState: 'administration', dynamicRoutes: [] },
        access: { adminUsers: ['admin@example.com'] },
      },
    };
    const areas = environmentAreas(configuration);
    expect(areas.map(area => area.label)).toEqual([
      'Access and identity', 'AI Gateway and routing', 'Domain and DNS', 'Model Context Protocol', 'Security and egress',
    ]);
    expect(areas.find(area => area.section === 'mcpPortals')).toMatchObject({ summary: '1 portal', status: 'Configured' });
    expect(configuration.applicableSections).toEqual(['securityEgress', 'mcpPortals', 'domain', 'aiRouting', 'access']);
    expect(filterEnvironmentAreas(areas, 'gateway').map(area => area.section)).toEqual(['aiRouting', 'securityEgress']);
  });

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

  it('REQ-SETUP-023 AC1: filters loaded areas by label, description, and current summary', () => {
    const configuration: AdminConfigurationResponse = {
      mode: 'enterprise', revision: 1, applicableSections: ['domain', 'usageReports'], activeRunId: null, latest: {},
      sections: { domain: { customDomain: 'enterprise.example.com' }, usageReports: { enabled: false } },
    };
    const areas = environmentAreas(configuration);

    expect(filterEnvironmentAreas(areas, 'DNS').map((area) => area.section)).toEqual(['domain']);
    expect(filterEnvironmentAreas(areas, 'monthly delivery').map((area) => area.section)).toEqual(['usageReports']);
    expect(filterEnvironmentAreas(areas, 'ENTERPRISE.EXAMPLE.COM').map((area) => area.section)).toEqual(['domain']);
    expect(filterEnvironmentAreas(areas, 'no matching area')).toEqual([]);
  });
});
