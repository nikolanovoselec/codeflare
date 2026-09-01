import type { AdminConfigurationResponse, ConfigurationSection } from '../../types';

export interface EnvironmentArea {
  section: ConfigurationSection;
  label: string;
  description: string;
  summary: string;
  status: 'Configured' | 'Enabled' | 'Disabled' | 'Not configured';
}

const LABELS: Record<ConfigurationSection, string> = {
  access: 'Access and identity',
  domain: 'Domain and DNS',
  aiRouting: 'AI Gateway and routing',
  codingAgents: 'Coding agents',
  browserRendering: 'Browser Run',
  securityEgress: 'Security and egress',
  dataGovernance: 'Data governance',
  managedEnvironment: 'Managed environment',
  github: 'GitHub',
  cloudflareConnection: 'Cloudflare connection',
  usageReports: 'Monthly usage reports',
};

const DESCRIPTIONS: Record<ConfigurationSection, string> = {
  access: 'Administrators, users, and Access groups',
  domain: 'Custom hostname and DNS ownership',
  aiRouting: 'Gateway credentials, routes, and model defaults',
  codingAgents: 'Agents available for new sessions',
  browserRendering: 'Optional Browser Run credentials',
  securityEgress: 'Outbound Gateway policy',
  dataGovernance: 'Storage encryption and download controls',
  managedEnvironment: 'Managed releases and resource policy',
  github: 'GitHub App or OAuth provider',
  cloudflareConnection: 'Cloudflare OAuth client',
  usageReports: 'Recipients and monthly delivery schedule',
};

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function describe(section: ConfigurationSection, raw: unknown): Pick<EnvironmentArea, 'summary' | 'status'> {
  const value = record(raw);
  switch (section) {
    case 'access': {
      const admins = list(value.adminUsers).length;
      const groups = list(value.userAccessGroups).length;
      return { summary: groups ? `${countLabel(admins, 'administrator')} · ${countLabel(groups, 'user group')}` : countLabel(admins, 'administrator'), status: 'Configured' };
    }
    case 'domain': {
      const domain = text(value.customDomain);
      return { summary: domain ?? 'No custom domain', status: domain ? 'Configured' : 'Not configured' };
    }
    case 'aiRouting': {
      const routes = list(value.dynamicRoutes).length;
      const saved = value.tokenState === 'administration' || value.tokenState === 'deployment';
      return { summary: `${countLabel(routes, 'route')} · ${saved ? 'API token saved' : 'API token required'}`, status: saved ? 'Configured' : 'Not configured' };
    }
    case 'codingAgents': {
      const agents = list(value.activeAgents).map(String);
      return { summary: agents.length ? agents.join(', ') : 'No configurable agents', status: agents.length ? 'Enabled' : 'Not configured' };
    }
    case 'browserRendering': {
      const configured = value.configured === true;
      return { summary: configured ? 'Account and API token saved' : 'Optional credentials not configured', status: configured ? 'Enabled' : 'Not configured' };
    }
    case 'securityEgress': {
      const enabled = value.strictGatewayEgress === true;
      return { summary: enabled ? 'Strict Gateway egress' : 'Standard egress', status: enabled ? 'Enabled' : 'Disabled' };
    }
    case 'dataGovernance': {
      const governed = value.governedMode === true;
      const viewOnly = value.viewOnlyStorage === true;
      return { summary: `${governed ? 'Governed' : 'Encrypted'} · ${viewOnly ? 'view-only storage' : 'downloads allowed'}`, status: governed || viewOnly ? 'Enabled' : 'Disabled' };
    }
    case 'managedEnvironment': {
      const configured = value.configured === true;
      const release = text(value.activeReleaseTag);
      return {
        summary: configured ? (release ?? (value.enabled === true ? 'Managed release enabled' : 'Managed environment disabled')) : 'No managed release selected',
        status: configured ? 'Configured' : 'Not configured',
      };
    }
    case 'github': {
      const provider = text(value.providerType);
      return { summary: provider ? `${provider === 'app' ? 'GitHub App' : 'OAuth'} provider` : 'Provider not configured', status: provider ? 'Configured' : 'Not configured' };
    }
    case 'cloudflareConnection': {
      const clientId = text(value.clientId);
      return { summary: clientId ? 'OAuth client configured' : 'OAuth client not configured', status: clientId ? 'Configured' : 'Not configured' };
    }
    case 'usageReports': {
      const configured = value.enabled === true;
      return { summary: configured ? 'Monthly delivery enabled' : 'Disabled by default', status: configured ? 'Enabled' : 'Disabled' };
    }
  }
}

export function environmentAreas(configuration: AdminConfigurationResponse): EnvironmentArea[] {
  return configuration.applicableSections.map((section) => ({
    section,
    label: LABELS[section],
    description: DESCRIPTIONS[section],
    ...describe(section, configuration.sections[section]),
  }));
}

export function filterEnvironmentAreas(areas: EnvironmentArea[], query: string): EnvironmentArea[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return areas;
  return areas.filter((area) => [area.label, area.description, area.summary]
    .some((value) => value.toLocaleLowerCase().includes(normalized)));
}
