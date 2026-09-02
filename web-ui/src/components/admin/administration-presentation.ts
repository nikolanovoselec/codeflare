import type { ConfigurationSection } from '../../types';

const SECTION_LABELS: Record<ConfigurationSection, string> = {
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

const TASK_LABELS: Record<string, string> = {
  create_access_app: 'Update Access application',
  configure_access_groups: 'Update Access groups',
  store_access_users: 'Update administrator access',
  configure_custom_domain: 'Update custom domain',
  configure_ai_gateway: 'Update AI Gateway',
  configure_model_routing: 'Update model routing',
  configure_active_agents: 'Update coding agents',
  configure_browser_rendering: 'Update Browser Run',
  configure_strict_egress: 'Update strict egress',
  configure_r2_sse: 'Update storage encryption',
  configure_downloads_disabled: 'Update download policy',
  configure_managed_environment: 'Update managed environment',
  configure_github: 'Update GitHub provider',
  configure_cloudflare_connection: 'Update Cloudflare connection',
  configure_usage_reports: 'Update monthly usage reports',
};

interface EnvironmentContext {
  source: string;
  operation: string;
  effect: string;
}

const ENVIRONMENT_CONTEXT: Record<ConfigurationSection, EnvironmentContext> = {
  access: {
    source: 'Saved Access admission settings',
    operation: 'Updates only administrator and admitted-user access',
    effect: 'New access decisions use the revised lists and groups',
  },
  domain: {
    source: 'Saved custom-domain setting',
    operation: 'Updates the bounded domain and DNS configuration',
    effect: 'The configured hostname becomes the active workspace domain',
  },
  aiRouting: {
    source: 'Saved routing values and effective gateway token',
    operation: 'Updates the AI Gateway and model-routing catalog',
    effect: 'New model requests use the revised routes and defaults',
  },
  codingAgents: {
    source: 'Saved configurable-agent selection',
    operation: 'Updates only the enabled coding-agent set',
    effect: 'New sessions offer the revised agent selection',
  },
  browserRendering: {
    source: 'Saved Browser Rendering account and token',
    operation: 'Updates the optional Browser Run connection',
    effect: 'New Browser Run requests use the revised credentials',
  },
  securityEgress: {
    source: 'Saved egress policy',
    operation: 'Updates strict Gateway egress only',
    effect: 'New outbound requests follow the revised egress policy',
  },
  dataGovernance: {
    source: 'Saved storage governance settings',
    operation: 'Updates storage encryption and download policy',
    effect: 'Subsequent storage access follows the revised controls',
  },
  managedEnvironment: {
    source: 'Saved managed-release settings',
    operation: 'Updates the bounded managed-environment configuration',
    effect: 'Future managed release operations use the revised policy',
  },
  github: {
    source: 'Saved GitHub provider configuration',
    operation: 'Updates the selected GitHub authentication provider',
    effect: 'New GitHub connections use the revised provider settings',
  },
  cloudflareConnection: {
    source: 'Saved Cloudflare OAuth client configuration',
    operation: 'Updates the Cloudflare connection credentials',
    effect: 'New Cloudflare connections use the revised OAuth client',
  },
  usageReports: {
    source: 'Saved monthly-report schedule',
    operation: 'Updates the report schedule and recipients',
    effect: 'Future monthly deliveries use the revised schedule',
  },
};

export function operatorTaskLabel(taskId: string): string {
  return TASK_LABELS[taskId] ?? taskId;
}

export function formatAdminTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()];
  const time = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}, ${time} UTC`;
}

export function environmentContext(section: ConfigurationSection): EnvironmentContext {
  return ENVIRONMENT_CONTEXT[section];
}

export function executionOutcome(section: ConfigurationSection, revision: number): string {
  return `${SECTION_LABELS[section]} updated. Revision ${revision} is active.`;
}
