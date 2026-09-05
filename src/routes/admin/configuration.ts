import { Hono } from 'hono';
import type { Env } from '../../types';
import { authMiddleware, requireAdmin, type AuthVariables } from '../../middleware/auth';
import {
  applicableConfigurationSections,
  resolveAdministrationMode,
  type ConfigurationSection,
} from '../../lib/admin-configuration';
import { getAllUsers } from '../../lib/access-policy';
import { parseAccessGroups } from '../../lib/access';
import { installedAgents, CONFIGURABLE_ENTERPRISE_AGENTS, readActiveAgents } from '../../lib/agent-allowlist';
import { getManagedEnvironmentPrefill } from '../../lib/remote-curation';
import { parseRouteSettings } from '../../lib/reasoning-profiles';
import { migrateLegacyReasoningAssignments, parseReasoningConfiguration } from '../../lib/reasoning-configuration';
import {
  ADMIN_CONFIGURATION_KEYS,
  getAdminConfigurationLatestKey,
  SETUP_KEYS,
} from '../../lib/kv-keys';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authMiddleware);

type SecretState = 'administration' | 'deployment' | 'none';

function secretState(administrationValue: string | null, deploymentValue?: string): SecretState {
  if (administrationValue) return 'administration';
  if (deploymentValue) return 'deployment';
  return 'none';
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function parseRevision(raw: string | null): number {
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : 0;
}

app.get('/', requireAdmin, async (c) => {
  const mode = resolveAdministrationMode(c.env);
  const applicableSections = applicableConfigurationSections(mode);
  const latestEntries = await Promise.all(applicableSections.map(async (section) => {
    const value = parseObject(await c.env.KV.get(getAdminConfigurationLatestKey(section)));
    return [section, value] as const;
  }));

  const [
    revisionRaw,
    activeRunRaw,
    customDomain,
    allUsers,
    managedEnvironment,
    githubProviderType,
    githubAppClientId,
    githubAppClientSecret,
    githubOauthClientId,
    githubOauthClientSecret,
    cloudflareOauthClientId,
    cloudflareOauthClientSecret,
    usageReportsRaw,
  ] = await Promise.all([
    c.env.KV.get(ADMIN_CONFIGURATION_KEYS.REVISION),
    c.env.KV.get(ADMIN_CONFIGURATION_KEYS.ACTIVE_RUN),
    c.env.KV.get(SETUP_KEYS.CUSTOM_DOMAIN),
    getAllUsers(c.env.KV),
    getManagedEnvironmentPrefill(c.env).catch(() => null),
    c.env.KV.get(SETUP_KEYS.GITHUB_PROVIDER_TYPE),
    c.env.KV.get(SETUP_KEYS.GITHUB_APP_CLIENT_ID),
    c.env.KV.get(SETUP_KEYS.GITHUB_APP_CLIENT_SECRET),
    c.env.KV.get(SETUP_KEYS.GITHUB_OAUTH_CLIENT_ID),
    c.env.KV.get(SETUP_KEYS.GITHUB_OAUTH_CLIENT_SECRET),
    c.env.KV.get(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_ID),
    c.env.KV.get(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_SECRET),
    c.env.KV.get(ADMIN_CONFIGURATION_KEYS.USAGE_REPORT_SETTINGS),
  ]);

  const sections: Partial<Record<ConfigurationSection, unknown>> = {
    access: {
      adminUsers: allUsers.filter((user) => user.role === 'admin').map((user) => user.email),
      ...(mode === 'default' || mode === 'onboarding'
        ? { allowedUsers: allUsers.map((user) => user.email) }
        : {}),
    },
    domain: { customDomain: customDomain ?? '' },
    managedEnvironment,
    github: {
      providerType: githubProviderType,
      appClientId: githubAppClientId ?? '',
      appClientSecretState: secretState(githubAppClientSecret, c.env.GITHUB_APP_CLIENT_SECRET),
      oauthClientId: githubOauthClientId ?? '',
      oauthClientSecretState: secretState(githubOauthClientSecret),
    },
    usageReports: parseObject(usageReportsRaw),
  };

  if (mode !== 'enterprise') {
    sections.cloudflareConnection = {
      clientId: cloudflareOauthClientId ?? '',
      clientSecretState: secretState(cloudflareOauthClientSecret),
    };
  } else {
    const [
      enterpriseAccessGroup,
      enterpriseAdminAccessGroup,
      aigGatewayUrl,
      aigToken,
      browserAccountId,
      browserToken,
      strictEgress,
      r2SseDisabled,
      downloadsDisabled,
      dynamicRoutes,
      defaultRoute,
      routeContextWindows,
      reasoningConfigurationRaw,
      groupRouting,
      storedActiveAgents,
    ] = await Promise.all([
      c.env.KV.get(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP),
      c.env.KV.get(SETUP_KEYS.ENTERPRISE_ADMIN_ACCESS_GROUP),
      c.env.KV.get(SETUP_KEYS.AIG_GATEWAY_URL),
      c.env.KV.get(SETUP_KEYS.AIG_TOKEN),
      c.env.KV.get(SETUP_KEYS.BROWSER_RENDER_ACCOUNT_ID),
      c.env.KV.get(SETUP_KEYS.BROWSER_RENDER_TOKEN),
      c.env.KV.get(SETUP_KEYS.STRICT_EGRESS),
      c.env.KV.get(SETUP_KEYS.R2_SSE_DISABLED),
      c.env.KV.get(SETUP_KEYS.DOWNLOADS_DISABLED),
      c.env.KV.get(SETUP_KEYS.DYNAMIC_ROUTES),
      c.env.KV.get(SETUP_KEYS.DEFAULT_ROUTE),
      c.env.KV.get(SETUP_KEYS.ROUTE_CONTEXT_WINDOWS),
      c.env.KV.get(SETUP_KEYS.REASONING_CONFIGURATION),
      c.env.KV.get(SETUP_KEYS.GROUP_ROUTING),
      readActiveAgents(c.env.KV),
    ]);
    const configurableAgents = CONFIGURABLE_ENTERPRISE_AGENTS.filter((agent) => installedAgents(c.env).includes(agent));
    const activeAgents = storedActiveAgents?.filter((agent) => configurableAgents.includes(agent)) ?? configurableAgents;

    sections.access = {
      adminUsers: allUsers.filter((user) => user.role === 'admin').map((user) => user.email),
      userAccessGroups: parseAccessGroups(enterpriseAccessGroup),
      adminAccessGroups: parseAccessGroups(enterpriseAdminAccessGroup),
    };
    const rawRouteSettings = routeContextWindows === null
      ? {}
      : (() => {
          try { return JSON.parse(routeContextWindows) as unknown; }
          catch { return routeContextWindows; }
        })();
    const routeSettings = parseRouteSettings(rawRouteSettings);
    const parsedDefaultRoute = parseObject(defaultRoute);
    const parsedGroupRouting = parseObject(groupRouting) ?? {};
    const migration = reasoningConfigurationRaw ? null : migrateLegacyReasoningAssignments({
      routeSettings: rawRouteSettings,
      defaults: {
        global: parsedDefaultRoute,
        groups: parsedGroupRouting as Record<string, { defaultRoute?: unknown; reasoning?: unknown }>,
      },
    });
    const reasoningConfiguration = reasoningConfigurationRaw
      ? parseReasoningConfiguration(reasoningConfigurationRaw)
      : migration!.proposed;
    sections.aiRouting = {
      gatewayUrl: aigGatewayUrl || c.env.AIG_GATEWAY_URL || '',
      tokenState: secretState(aigToken, c.env.AIG_TOKEN),
      dynamicRoutes: parseArray(dynamicRoutes),
      defaultRoute: parsedDefaultRoute,
      routeContextWindows: routeSettings.contextWindows,
      routeReasoningProfiles: Object.fromEntries(Object.entries(reasoningConfiguration.routeAssignments).map(([route, assignment]) => [route, assignment.activeProfile.id])),
      reasoningConfiguration,
      ...(migration && { reasoningMigration: { persisted: false, errors: migration.errors } }),
      availableAccessGroups: parseAccessGroups(enterpriseAccessGroup),
      groupRouting: parsedGroupRouting,
    };
    sections.codingAgents = { activeAgents, configurableAgents };
    sections.browserRendering = {
      configured: Boolean(browserAccountId && browserToken),
      ...(browserAccountId && { accountId: browserAccountId }),
      tokenState: secretState(browserToken),
    };
    sections.securityEgress = { strictGatewayEgress: strictEgress === 'active' };
    sections.dataGovernance = {
      governedMode: r2SseDisabled === 'active',
      viewOnlyStorage: downloadsDisabled === 'active',
    };
  }

  const activeRun = parseObject(activeRunRaw);
  const latest = Object.fromEntries(latestEntries.filter((entry): entry is [ConfigurationSection, Record<string, unknown>] => entry[1] !== null));

  return c.json({
    mode,
    revision: parseRevision(revisionRaw),
    applicableSections,
    sections,
    activeRunId: typeof activeRun?.runId === 'string' ? activeRun.runId : null,
    latest,
  });
});

export default app;
