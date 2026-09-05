import { z } from 'zod';
import type { Env } from '../types';
import { AgentTypeSchema } from '../types';
import { getAllUsers } from './access-policy';
import { parseAccessGroups, resolveBucketName } from './access';
import { CONFIGURABLE_ENTERPRISE_AGENTS, installedAgents } from './agent-allowlist';
import { ADMIN_CONFIGURATION_KEYS, SETUP_KEYS, getPreferencesKey, getUsageReportNextKey } from './kv-keys';
import { encryptAndStore, getOrImportKey } from './kv-crypto';
import { isOnboardingLandingPageActive, isSaasModeActive, isSessionOidcMode } from './onboarding';
import { isEnterpriseMode } from './subscription';
import { nextReportDelivery, normalizeReportSettings, type EnabledReportSettings, type ReportSettingsInput } from './usage-reports';
import { handleCreateAccessApp } from '../routes/setup/access';
import { handleConfigureCustomDomain } from '../routes/setup/custom-domain';
import { getWorkerNameFromHostname } from '../routes/setup/shared';
import { reactivateUsageUser } from './admin-usage';
import { REASONING_PROFILE_IDS, parseRouteSettings, serializeRouteSettings } from './reasoning-profiles';
import {
  configureManagedEnvironment,
  readManagedEnvironmentSnapshot,
  resolveManagedResourcePolicy,
} from './remote-curation';

export const CONFIGURATION_SECTIONS = [
  'access',
  'domain',
  'aiRouting',
  'codingAgents',
  'browserRendering',
  'securityEgress',
  'dataGovernance',
  'managedEnvironment',
  'github',
  'cloudflareConnection',
  'usageReports',
] as const;

export type ConfigurationSection = typeof CONFIGURATION_SECTIONS[number];
export type AdministrationMode = 'default' | 'onboarding' | 'saas' | 'enterprise';
export type ConfigurationValues = Record<string, unknown>;

interface ConfigurationTask {
  id: string;
  dependsOn: string[];
}

interface ConfigurationChange {
  field: string;
  before?: unknown;
  after?: unknown;
  secret?: { willReplace: boolean };
}

export interface ConfigurationPreview {
  section: ConfigurationSection;
  baseRevision: number;
  currentRevision: number;
  changes: ConfigurationChange[];
  tasks: ConfigurationTask[];
  warnings: Array<{ code: string; message: string }>;
  exclusions: string[];
}

const COMMON_SECTIONS: ConfigurationSection[] = [
  'access', 'domain', 'managedEnvironment', 'github', 'cloudflareConnection', 'usageReports',
];

const ENTERPRISE_SECTIONS: ConfigurationSection[] = [
  'access', 'domain', 'aiRouting', 'codingAgents', 'browserRendering', 'securityEgress',
  'dataGovernance', 'managedEnvironment', 'github', 'usageReports',
];

const email = z.string().trim().toLowerCase().email();
const name = z.string().trim().min(1).max(256).refine((value) => !/[,\r\n]/.test(value));
const reasoning = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const domain = z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i);
const replacementSecret = z.string().max(2_048).optional().default('');

const accessSchema = z.object({
  adminUsers: z.array(email).min(1),
  allowedUsers: z.array(email).optional(),
  userAccessGroups: z.array(name).optional(),
  adminAccessGroups: z.array(name).optional(),
}).strict();

const aiRoutingSchema = z.object({
  gatewayUrl: z.string().trim().url().max(512),
  replacementToken: replacementSecret,
  dynamicRoutes: z.array(name).min(1),
  defaultRoute: z.object({ route: name, reasoning }).strict(),
  routeContextWindows: z.record(name, z.number().int().positive()),
  routeReasoningProfiles: z.record(name, z.enum(REASONING_PROFILE_IDS)),
  groupRouting: z.array(z.object({
    accessGroup: name,
    routes: z.array(name).min(1),
    defaultRoute: name,
    reasoning,
  }).strict()),
}).strict().superRefine((value, context) => {
  if (!value.dynamicRoutes.includes(value.defaultRoute.route)) {
    context.addIssue({ code: 'custom', message: 'Default route must be in dynamicRoutes', path: ['defaultRoute', 'route'] });
  }
  if (value.dynamicRoutes.some((route) => !value.routeReasoningProfiles[route])) {
    context.addIssue({ code: 'custom', message: 'Every dynamic route requires a reasoning profile', path: ['routeReasoningProfiles'] });
  }
  if (Object.keys(value.routeReasoningProfiles).some((route) => !value.dynamicRoutes.includes(route))) {
    context.addIssue({ code: 'custom', message: 'Reasoning profiles must use the route catalog', path: ['routeReasoningProfiles'] });
  }
  for (const [index, group] of value.groupRouting.entries()) {
    if (!group.routes.includes(group.defaultRoute) || group.routes.some((route) => !value.dynamicRoutes.includes(route))) {
      context.addIssue({ code: 'custom', message: 'Group routes must use the route catalog', path: ['groupRouting', index] });
    }
  }
});

const sectionSchemas: Record<ConfigurationSection, z.ZodType<ConfigurationValues>> = {
  access: accessSchema,
  domain: z.object({ customDomain: domain }).strict(),
  aiRouting: aiRoutingSchema,
  codingAgents: z.object({ activeAgents: z.array(AgentTypeSchema).min(1) }).strict(),
  browserRendering: z.object({
    accountId: z.string().trim().max(128).optional().default(''),
    replacementToken: replacementSecret,
  }).strict(),
  securityEgress: z.object({ strictGatewayEgress: z.boolean() }).strict(),
  dataGovernance: z.object({ governedMode: z.boolean(), viewOnlyStorage: z.boolean() }).strict(),
  managedEnvironment: z.discriminatedUnion('enabled', [
    z.object({ enabled: z.literal(false) }).strict(),
    z.object({
      enabled: z.literal(true),
      repository: z.string().trim().max(256),
      personalAccessToken: replacementSecret,
      publicKey: z.string().trim().refine((value) => value === '' || /^[0-9a-f]{64}$/.test(value)),
      immutableResources: z.boolean().optional(),
      disableUserCreatedResources: z.boolean().optional(),
    }).strict(),
  ]),
  github: z.object({
    providerType: z.enum(['app', 'oauth']),
    appClientId: z.string().trim().max(256),
    appReplacementSecret: replacementSecret,
    oauthClientId: z.string().trim().max(256),
    oauthReplacementSecret: replacementSecret,
  }).strict(),
  cloudflareConnection: z.object({
    clientId: z.string().trim().max(256),
    replacementSecret,
  }).strict(),
  usageReports: z.discriminatedUnion('enabled', [
    z.object({ enabled: z.literal(false) }).strict(),
    z.object({
      enabled: z.literal(true),
      recipients: z.array(email).min(1).max(25),
      day: z.number().int().min(1).max(31),
      hour: z.number().int().min(0).max(23),
      timezone: z.string().trim().min(1).max(128),
    }).strict(),
  ]),
};

const TASKS: Record<ConfigurationSection, ConfigurationTask[]> = {
  access: [
    { id: 'store_access_users', dependsOn: [] },
    { id: 'create_access_app', dependsOn: ['store_access_users'] },
  ],
  domain: [
    { id: 'configure_custom_domain', dependsOn: [] },
    { id: 'create_access_app', dependsOn: ['configure_custom_domain'] },
  ],
  aiRouting: [
    { id: 'configure_model_routing', dependsOn: [] },
    { id: 'configure_ai_gateway', dependsOn: ['configure_model_routing'] },
  ],
  codingAgents: [{ id: 'configure_active_agents', dependsOn: [] }],
  browserRendering: [{ id: 'configure_browser_rendering', dependsOn: [] }],
  securityEgress: [{ id: 'configure_strict_egress', dependsOn: [] }],
  dataGovernance: [
    { id: 'configure_r2_sse', dependsOn: [] },
    { id: 'configure_downloads_disabled', dependsOn: [] },
  ],
  managedEnvironment: [{ id: 'configure_managed_environment', dependsOn: [] }],
  github: [{ id: 'configure_github', dependsOn: [] }],
  cloudflareConnection: [{ id: 'configure_cloudflare_connection', dependsOn: [] }],
  usageReports: [{ id: 'configure_usage_reports', dependsOn: [] }],
};

const SETUP_ONLY_TASKS = ['get_account', 'derive_r2_credentials', 'set_secrets', 'configure_turnstile', 'finalize'];
const SECRET_FIELDS: Partial<Record<ConfigurationSection, string[]>> = {
  aiRouting: ['replacementToken'],
  browserRendering: ['replacementToken'],
  managedEnvironment: ['personalAccessToken'],
  github: ['appReplacementSecret', 'oauthReplacementSecret'],
  cloudflareConnection: ['replacementSecret'],
};

export function resolveAdministrationMode(env: Env): AdministrationMode {
  if (isEnterpriseMode(env)) return 'enterprise';
  if (isSaasModeActive(env.SAAS_MODE)) return 'saas';
  if (isOnboardingLandingPageActive(env.ONBOARDING_LANDING_PAGE)) return 'onboarding';
  return 'default';
}

export function applicableConfigurationSections(mode: AdministrationMode): ConfigurationSection[] {
  return [...(mode === 'enterprise' ? ENTERPRISE_SECTIONS : COMMON_SECTIONS)];
}

export function parseConfigurationRevision(raw: string | null): number {
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const revision = Number(raw);
  return Number.isSafeInteger(revision) ? revision : 0;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()))].sort();
}

function normalizeValues(section: ConfigurationSection, mode: AdministrationMode, values: ConfigurationValues): ConfigurationValues {
  if (section === 'access') {
    const admins = uniqueSorted(values.adminUsers as string[]);
    if (mode === 'enterprise') {
      return {
        adminUsers: admins,
        userAccessGroups: uniqueSorted((values.userAccessGroups as string[] | undefined) ?? []),
        adminAccessGroups: uniqueSorted((values.adminAccessGroups as string[] | undefined) ?? []),
      };
    }
    const allowed = uniqueSorted((values.allowedUsers as string[] | undefined) ?? admins);
    return { adminUsers: admins, allowedUsers: allowed };
  }
  if (section === 'aiRouting') {
    return {
      ...values,
      dynamicRoutes: [...new Set(values.dynamicRoutes as string[])],
      groupRouting: [...(values.groupRouting as unknown[])],
    };
  }
  if (section === 'usageReports') {
    return normalizeReportSettings(values as unknown as ReportSettingsInput) as unknown as ConfigurationValues;
  }
  return values;
}

function parseJson(raw: string | null, fallback: unknown): unknown {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function readCurrentConfigurationValues(
  env: Env,
  section: ConfigurationSection,
  mode: AdministrationMode,
): Promise<ConfigurationValues> {
  switch (section) {
    case 'access': {
      const users = await getAllUsers(env.KV);
      const adminUsers = users.filter((user) => user.role === 'admin').map((user) => user.email).sort();
      if (mode === 'enterprise') {
        return {
          adminUsers,
          userAccessGroups: parseAccessGroups(await env.KV.get(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP)).sort(),
          adminAccessGroups: parseAccessGroups(await env.KV.get(SETUP_KEYS.ENTERPRISE_ADMIN_ACCESS_GROUP)).sort(),
        };
      }
      return { adminUsers, allowedUsers: users.map((user) => user.email).sort() };
    }
    case 'domain':
      return { customDomain: (await env.KV.get(SETUP_KEYS.CUSTOM_DOMAIN)) ?? '' };
    case 'aiRouting': {
      const routeSettings = parseRouteSettings(parseJson(await env.KV.get(SETUP_KEYS.ROUTE_CONTEXT_WINDOWS), {}));
      return {
        gatewayUrl: (await env.KV.get(SETUP_KEYS.AIG_GATEWAY_URL)) || env.AIG_GATEWAY_URL || '',
        dynamicRoutes: parseJson(await env.KV.get(SETUP_KEYS.DYNAMIC_ROUTES), []),
        defaultRoute: parseJson(await env.KV.get(SETUP_KEYS.DEFAULT_ROUTE), null),
        routeContextWindows: routeSettings.contextWindows,
        routeReasoningProfiles: routeSettings.reasoningProfiles,
        groupRouting: parseJson(await env.KV.get(SETUP_KEYS.GROUP_ROUTING), {}),
      };
    }
    case 'codingAgents':
      return { activeAgents: CONFIGURABLE_ENTERPRISE_AGENTS.filter((agent) => installedAgents(env).includes(agent)) };
    case 'browserRendering':
      return { accountId: (await env.KV.get(SETUP_KEYS.BROWSER_RENDER_ACCOUNT_ID)) ?? '' };
    case 'securityEgress':
      return { strictGatewayEgress: (await env.KV.get(SETUP_KEYS.STRICT_EGRESS)) === 'active' };
    case 'dataGovernance':
      return {
        governedMode: (await env.KV.get(SETUP_KEYS.R2_SSE_DISABLED)) === 'active',
        viewOnlyStorage: (await env.KV.get(SETUP_KEYS.DOWNLOADS_DISABLED)) === 'active',
      };
    case 'managedEnvironment':
      return parseJson(await env.KV.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG), { enabled: false }) as ConfigurationValues;
    case 'github':
      return {
        providerType: (await env.KV.get(SETUP_KEYS.GITHUB_PROVIDER_TYPE)) ?? 'app',
        appClientId: (await env.KV.get(SETUP_KEYS.GITHUB_APP_CLIENT_ID)) ?? '',
        oauthClientId: (await env.KV.get(SETUP_KEYS.GITHUB_OAUTH_CLIENT_ID)) ?? '',
      };
    case 'cloudflareConnection':
      return { clientId: (await env.KV.get(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_ID)) ?? '' };
    case 'usageReports':
      return parseJson(await env.KV.get(ADMIN_CONFIGURATION_KEYS.USAGE_REPORT_SETTINGS), { enabled: false }) as ConfigurationValues;
  }
}

export interface PreviewValidationResult {
  values?: ConfigurationValues;
  fieldErrors?: Record<string, string[]>;
}

export async function validateConfigurationValues(
  env: Env,
  section: ConfigurationSection,
  mode: AdministrationMode,
  rawValues: unknown,
  initiatedBy?: string,
): Promise<PreviewValidationResult> {
  const parsed = sectionSchemas[section].safeParse(rawValues);
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]> };
  let values: ConfigurationValues;
  try {
    values = normalizeValues(section, mode, parsed.data);
  } catch (error) {
    return { fieldErrors: { settings: [error instanceof Error ? error.message : 'Invalid settings'] } };
  }

  if (section === 'access') {
    const admins = values.adminUsers as string[];
    if (initiatedBy && !admins.includes(initiatedBy.trim().toLowerCase())) {
      return { fieldErrors: { adminUsers: ['You cannot remove yourself from the administrator list'] } };
    }
    if (mode !== 'enterprise' && !admins.every((admin) => (values.allowedUsers as string[]).includes(admin))) {
      return { fieldErrors: { adminUsers: ['Every administrator must also be an allowed user'] } };
    }
    if (mode === 'enterprise') {
      const routing = parseJson(await env.KV.get(SETUP_KEYS.GROUP_ROUTING), {});
      const routingOwners = routing !== null && typeof routing === 'object' && !Array.isArray(routing)
        ? Object.keys(routing as Record<string, unknown>)
        : [];
      const userGroups = values.userAccessGroups as string[];
      if (routingOwners.some((owner) => !userGroups.includes(owner))) {
        return { fieldErrors: { userAccessGroups: ['Access groups that own routing policies cannot be removed'] } };
      }
    }
  }
  if (section === 'aiRouting') {
    const hasSavedToken = Boolean(await env.KV.get(SETUP_KEYS.AIG_TOKEN));
    const replacing = Boolean((values.replacementToken as string).trim());
    if (!(values.gatewayUrl as string).trim() || (!replacing && !hasSavedToken && !env.AIG_TOKEN)) {
      return { fieldErrors: { credentials: ['AI Gateway URL and API token are required'] } };
    }
  }
  if (section === 'browserRendering') {
    const accountId = (values.accountId as string).trim();
    const hasToken = Boolean((values.replacementToken as string).trim()) || Boolean(await env.KV.get(SETUP_KEYS.BROWSER_RENDER_TOKEN));
    if (Boolean(accountId) !== hasToken) {
      return { fieldErrors: { credentials: ['Browser Run requires both account ID and API token'] } };
    }
  }
  if (section === 'codingAgents') {
    const installed = installedAgents(env);
    if (!(values.activeAgents as string[]).every((agent) => installed.includes(agent as never))) {
      return { fieldErrors: { activeAgents: ['Active coding agents must be installed'] } };
    }
  }
  if (section === 'securityEgress') {
    if (values.strictGatewayEgress === true && !env.EGRESS) {
      return { fieldErrors: { strictGatewayEgress: ['Strict Gateway egress requires the EGRESS binding'] } };
    }
    if (values.strictGatewayEgress === false) {
      const snapshot = await readManagedEnvironmentSnapshot(env);
      if ((snapshot.config?.resourcePolicy ?? 'mutable') !== 'mutable') {
        return { fieldErrors: { strictGatewayEgress: ['Strict Gateway egress is required by the managed resource policy'] } };
      }
    }
  }
  if (section === 'github') {
    const replacing = Boolean((values.appReplacementSecret as string).trim() || (values.oauthReplacementSecret as string).trim());
    if (replacing && !(await getOrImportKey(env))) {
      return { fieldErrors: { credentials: ['ENCRYPTION_KEY is required to replace GitHub credentials'] } };
    }
  }
  if (section === 'cloudflareConnection' && (values.replacementSecret as string).trim() && !(await getOrImportKey(env))) {
    return { fieldErrors: { credentials: ['ENCRYPTION_KEY is required to replace Cloudflare credentials'] } };
  }
  if (section === 'managedEnvironment') {
    if (values.enabled === true && (values.personalAccessToken as string).trim() && !(await getOrImportKey(env))) {
      return { fieldErrors: { personalAccessToken: ['ENCRYPTION_KEY is required to replace the repository token'] } };
    }
    const snapshot = await readManagedEnvironmentSnapshot(env);
    const currentPolicy = snapshot.config?.resourcePolicy ?? 'mutable';
    const requestedPolicy = resolveManagedResourcePolicy(values as never, currentPolicy);
    if (requestedPolicy !== 'mutable') {
      const strictEgress = (await env.KV.get(SETUP_KEYS.STRICT_EGRESS)) === 'active';
      if (mode !== 'enterprise' || !strictEgress || !env.EGRESS) {
        return { fieldErrors: { immutableResources: ['Immutable managed resources require Enterprise Mode and Strict Gateway Egress'] } };
      }
    }
  }
  return { values };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function buildConfigurationPreview(
  env: Env,
  section: ConfigurationSection,
  mode: AdministrationMode,
  baseRevision: number,
  currentRevision: number,
  values: ConfigurationValues,
): Promise<ConfigurationPreview> {
  const current = await readCurrentConfigurationValues(env, section, mode);
  const secretFields = new Set(SECRET_FIELDS[section] ?? []);
  const changes: ConfigurationChange[] = [];
  for (const [field, after] of Object.entries(values)) {
    if (secretFields.has(field)) {
      changes.push({ field, secret: { willReplace: typeof after === 'string' && after.trim().length > 0 } });
    } else if (!same(current[field], after)) {
      changes.push({ field, ...(current[field] !== undefined && { before: current[field] }), after });
    }
  }

  const tasks = section === 'access'
    ? mode === 'enterprise'
      ? [
          { id: 'store_access_users', dependsOn: [] },
          { id: 'configure_access_groups', dependsOn: ['store_access_users'] },
          { id: 'create_access_app', dependsOn: ['configure_access_groups'] },
        ]
      : mode === 'onboarding' || mode === 'saas'
        ? TASKS.access.slice(0, 1)
        : TASKS.access
    : TASKS[section];
  return {
    section,
    baseRevision,
    currentRevision,
    changes,
    tasks: tasks.map((task) => ({ ...task, dependsOn: [...task.dependsOn] })),
    warnings: [],
    exclusions: SETUP_ONLY_TASKS.filter((task) => !tasks.some((selected) => selected.id === task)),
  };
}

interface ConfigurationExecutionContext {
  mode: AdministrationMode;
  requestUrl: string;
  resultingRevision: number;
}

async function requireCloudflareSetupContext(env: Env): Promise<{ token: string; accountId: string }> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = await env.KV.get(SETUP_KEYS.ACCOUNT_ID);
  if (!token || !accountId) throw new Error('Cloudflare setup context unavailable');
  return { token, accountId };
}

async function storeAccessUsers(
  env: Env,
  values: ConfigurationValues,
  mode: AdministrationMode,
  workerName: string,
): Promise<void> {
  const admins = values.adminUsers as string[];
  const allowed = mode === 'enterprise' ? admins : values.allowedUsers as string[];
  const adminSet = new Set(admins);
  await Promise.all(allowed.map(async (email) => {
    const existing = await env.KV.get<Record<string, unknown>>(`user:${email}`, 'json');
    const role = adminSet.has(email) ? 'admin' : 'user';
    await env.KV.put(`user:${email}`, JSON.stringify({
      ...existing,
      addedBy: 'administration',
      addedAt: typeof existing?.addedAt === 'string' ? existing.addedAt : new Date().toISOString(),
      role,
      ...(mode === 'saas' && { accessTier: 'unlimited', subscriptionTier: 'unlimited' }),
      ...(mode !== 'saas' && role === 'admin' && { accessTier: 'advanced', subscriptionTier: 'unlimited' }),
    }));
    if (role === 'admin') {
      const bucketName = await resolveBucketName(env, email, workerName);
      const preferencesKey = getPreferencesKey(bucketName);
      if (await env.KV.get(preferencesKey) === null) {
        await env.KV.put(preferencesKey, JSON.stringify({ sessionMode: 'advanced' }));
      }
    }
    if (env.USAGE_DB) {
      await reactivateUsageUser(env.USAGE_DB, email).catch(() => {});
    }
  }));
}

export async function executeConfigurationTask(
  env: Env,
  taskId: string,
  values: ConfigurationValues,
  context: ConfigurationExecutionContext,
): Promise<void> {
  const workerName = getWorkerNameFromHostname(context.requestUrl, env.CLOUDFLARE_WORKER_NAME);
  switch (taskId) {
    case 'store_access_users':
      await storeAccessUsers(env, values, context.mode, workerName);
      return;
    case 'configure_access_groups': {
      const userGroups = (values.userAccessGroups as string[]).join(',');
      const adminGroups = (values.adminAccessGroups as string[]).join(',');
      if (userGroups) await env.KV.put(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP, userGroups);
      else await env.KV.delete(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP);
      if (adminGroups) await env.KV.put(SETUP_KEYS.ENTERPRISE_ADMIN_ACCESS_GROUP, adminGroups);
      else await env.KV.delete(SETUP_KEYS.ENTERPRISE_ADMIN_ACCESS_GROUP);
      return;
    }
    case 'configure_custom_domain': {
      const { token, accountId } = await requireCloudflareSetupContext(env);
      const customDomain = values.customDomain as string;
      await handleConfigureCustomDomain(token, accountId, customDomain, context.requestUrl, [], workerName);
      await env.KV.put(SETUP_KEYS.CUSTOM_DOMAIN, customDomain);
      return;
    }
    case 'create_access_app': {
      if (isSessionOidcMode(env) && env.OAUTH_CLIENT_ID) return;
      const { token, accountId } = await requireCloudflareSetupContext(env);
      const access = 'adminUsers' in values
        ? values
        : await readCurrentConfigurationValues(env, 'access', context.mode);
      const customDomain = typeof values.customDomain === 'string'
        ? values.customDomain
        : await env.KV.get(SETUP_KEYS.CUSTOM_DOMAIN);
      if (!customDomain) throw new Error('Custom domain unavailable');
      const admins = access.adminUsers as string[];
      const allowed = context.mode === 'enterprise' ? admins : access.allowedUsers as string[];
      await handleCreateAccessApp(
        token,
        accountId,
        customDomain,
        allowed,
        admins,
        [],
        env.KV,
        workerName,
        context.mode === 'saas',
        context.mode === 'enterprise',
      );
      return;
    }
    case 'configure_model_routing': {
      await env.KV.put(SETUP_KEYS.DYNAMIC_ROUTES, JSON.stringify(values.dynamicRoutes));
      if (values.defaultRoute) await env.KV.put(SETUP_KEYS.DEFAULT_ROUTE, JSON.stringify(values.defaultRoute));
      else await env.KV.delete(SETUP_KEYS.DEFAULT_ROUTE);
      const windows = values.routeContextWindows as Record<string, number>;
      const profiles = values.routeReasoningProfiles as Record<string, (typeof REASONING_PROFILE_IDS)[number]>;
      const routeSettings = serializeRouteSettings(windows, profiles);
      if (Object.keys(routeSettings).length) await env.KV.put(SETUP_KEYS.ROUTE_CONTEXT_WINDOWS, JSON.stringify(routeSettings));
      else await env.KV.delete(SETUP_KEYS.ROUTE_CONTEXT_WINDOWS);
      const submittedGroups = values.groupRouting;
      const groups = Array.isArray(submittedGroups)
        ? Object.fromEntries((submittedGroups as Array<Record<string, unknown>>).map((group) => [
            group.accessGroup as string,
            { routes: group.routes, defaultRoute: group.defaultRoute, reasoning: group.reasoning },
          ]))
        : submittedGroups as Record<string, unknown>;
      if (Object.keys(groups).length) await env.KV.put(SETUP_KEYS.GROUP_ROUTING, JSON.stringify(groups));
      else await env.KV.delete(SETUP_KEYS.GROUP_ROUTING);
      return;
    }
    case 'configure_ai_gateway': {
      await env.KV.put(SETUP_KEYS.AIG_GATEWAY_URL, values.gatewayUrl as string);
      const token = (values.replacementToken as string).trim();
      if (token) {
        const key = await getOrImportKey(env);
        if (!key) throw new Error('Encryption key unavailable');
        await encryptAndStore(env.KV, SETUP_KEYS.AIG_TOKEN, { token }, key);
      }
      return;
    }
    case 'configure_active_agents': {
      const requested = values.activeAgents as string[];
      const canonical = CONFIGURABLE_ENTERPRISE_AGENTS.filter((agent) => requested.includes(agent));
      await env.KV.put(SETUP_KEYS.ACTIVE_AGENTS, JSON.stringify(canonical));
      return;
    }
    case 'configure_browser_rendering': {
      const accountId = (values.accountId as string).trim();
      const token = (values.replacementToken as string).trim();
      if (accountId) await env.KV.put(SETUP_KEYS.BROWSER_RENDER_ACCOUNT_ID, accountId);
      if (token) {
        const key = await getOrImportKey(env);
        await encryptAndStore(env.KV, SETUP_KEYS.BROWSER_RENDER_TOKEN, { token }, key);
      }
      return;
    }
    case 'configure_strict_egress':
      await env.KV.put(SETUP_KEYS.STRICT_EGRESS, values.strictGatewayEgress === true ? 'active' : 'inactive');
      return;
    case 'configure_r2_sse':
      await env.KV.put(SETUP_KEYS.R2_SSE_DISABLED, values.governedMode === true ? 'active' : 'inactive');
      return;
    case 'configure_downloads_disabled':
      await env.KV.put(SETUP_KEYS.DOWNLOADS_DISABLED, values.viewOnlyStorage === true ? 'active' : 'inactive');
      return;
    case 'configure_managed_environment': {
      const { accountId } = await requireCloudflareSetupContext(env);
      await configureManagedEnvironment({
        env,
        accountId,
        workerName,
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        r2Credentials: {
          R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
          R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
        },
        request: values as never,
      });
      return;
    }
    case 'configure_github': {
      await env.KV.put(SETUP_KEYS.GITHUB_PROVIDER_TYPE, values.providerType as string);
      const appClientId = (values.appClientId as string).trim();
      const oauthClientId = (values.oauthClientId as string).trim();
      if (appClientId) await env.KV.put(SETUP_KEYS.GITHUB_APP_CLIENT_ID, appClientId);
      else await env.KV.delete(SETUP_KEYS.GITHUB_APP_CLIENT_ID);
      if (oauthClientId) await env.KV.put(SETUP_KEYS.GITHUB_OAUTH_CLIENT_ID, oauthClientId);
      else await env.KV.delete(SETUP_KEYS.GITHUB_OAUTH_CLIENT_ID);
      const appSecret = (values.appReplacementSecret as string).trim();
      const oauthSecret = (values.oauthReplacementSecret as string).trim();
      if (appSecret || oauthSecret) {
        const key = await getOrImportKey(env);
        if (!key) throw new Error('Encryption key unavailable');
        if (appSecret) await encryptAndStore(env.KV, SETUP_KEYS.GITHUB_APP_CLIENT_SECRET, { secret: appSecret }, key);
        if (oauthSecret) await encryptAndStore(env.KV, SETUP_KEYS.GITHUB_OAUTH_CLIENT_SECRET, { secret: oauthSecret }, key);
      }
      return;
    }
    case 'configure_cloudflare_connection': {
      const clientId = (values.clientId as string).trim();
      if (clientId) await env.KV.put(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_ID, clientId);
      else await env.KV.delete(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_ID);
      const secret = (values.replacementSecret as string).trim();
      if (secret) {
        const key = await getOrImportKey(env);
        if (!key) throw new Error('Encryption key unavailable');
        await encryptAndStore(env.KV, SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_SECRET, { secret }, key);
      }
      return;
    }
    case 'configure_usage_reports': {
      const settings = { ...values, settingsRevision: context.resultingRevision };
      await env.KV.put(ADMIN_CONFIGURATION_KEYS.USAGE_REPORT_SETTINGS, JSON.stringify(settings));
      if (values.enabled === true) {
        const now = new Date();
        await env.KV.put(getUsageReportNextKey(context.resultingRevision), JSON.stringify({
          settingsRevision: context.resultingRevision,
          nextDeliveryAt: nextReportDelivery(values as unknown as EnabledReportSettings, now).toISOString(),
          updatedAt: now.toISOString(),
        }), { expirationTtl: 90 * 24 * 60 * 60 });
      }
      return;
    }
    default:
      throw new Error(`Unsupported configuration task: ${taskId}`);
  }
}
