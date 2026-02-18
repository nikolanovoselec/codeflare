import { SetupError, toErrorMessage } from '../../lib/error-types';
import { parseCfResponse } from '../../lib/cf-api';
import { cfApiCB } from '../../lib/circuit-breakers';
import { CF_API_BASE, logger, addStep, withSetupRetry } from './shared';
import type { SetupStep } from './shared';

interface AccessApp {
  id: string;
  domain: string;
  name: string;
  aud?: string;
  destinations?: Array<{ type: 'public'; uri: string }>;
}

interface AccessAppResult {
  id: string;
  aud?: string;
}

interface AccessGroup {
  id: string;
  name: string;
}

interface AccessGroupResult {
  id: string;
  name: string;
}

const PRIMARY_PROTECTED_SUFFIX = '/app/*';
const PROTECTED_DESTINATION_SUFFIXES = ['/app', '/app/*', '/api/*', '/setup', '/setup/*'] as const;

function getManagedAppName(workerName?: string): string {
  const trimmedWorkerName = workerName?.trim();
  return trimmedWorkerName && trimmedWorkerName.length > 0 ? trimmedWorkerName : 'codeflare';
}

function getManagedAppDomain(customDomain: string): string {
  return `${customDomain}${PRIMARY_PROTECTED_SUFFIX}`;
}

function getManagedDestinations(customDomain: string): Array<{ type: 'public'; uri: string }> {
  return PROTECTED_DESTINATION_SUFFIXES.map((suffix) => ({
    type: 'public',
    uri: `${customDomain}${suffix}`,
  }));
}

function getLegacyManagedDomains(customDomain: string): Set<string> {
  return new Set([
    customDomain,
    `${customDomain}/*`,
    `${customDomain}/app`,
    `${customDomain}/api/*`,
    `${customDomain}/setup`,
    `${customDomain}/setup/*`,
    `${customDomain}/login/*`,
  ]);
}

/**
 * Resolve an existing managed Access app using a 4-tier fallback:
 * 1. Exact domain match (most specific)
 * 2. Stored app ID from KV
 * 3. Name match + domain validation (prevents cross-environment collision)
 * 4. /app/* suffix + domain validation (prevents cross-environment collision)
 */
async function resolveManagedAccessApp(
  kv: KVNamespace,
  customDomain: string,
  existingApps: AccessApp[],
  managedAppName: string
): Promise<AccessApp | null> {
  const desiredDomain = getManagedAppDomain(customDomain);
  const byDesiredDomain = existingApps.find((app) => app.domain === desiredDomain) ?? null;
  if (byDesiredDomain) {
    return byDesiredDomain;
  }

  const storedAppId = await kv.get('setup:access_app_id');
  if (storedAppId) {
    const byStoredId = existingApps.find((app) => app.id === storedAppId) ?? null;
    if (byStoredId) {
      return byStoredId;
    }
  }

  // Fallback for fresh KV + pre-existing Access app: prefer a uniquely named managed app.
  const byManagedName = existingApps.filter((app) => app.name === managedAppName && app.domain.includes(customDomain));
  if (byManagedName.length === 1) {
    return byManagedName[0];
  }
  if (byManagedName.length > 1) {
    logger.warn('Multiple managed Access apps found by name; choosing first', {
      count: byManagedName.length,
      chosenId: byManagedName[0].id,
    });
    return byManagedName[0];
  }

  const byAppSuffix = existingApps.filter((app) => app.domain.endsWith('/app/*') && app.domain.includes(customDomain));
  if (byAppSuffix.length === 1) {
    return byAppSuffix[0];
  }
  if (byAppSuffix.length > 1) {
    logger.warn('Multiple /app/* Access apps found; choosing first', {
      count: byAppSuffix.length,
      chosenId: byAppSuffix[0].id,
    });
    return byAppSuffix[0];
  }

  return null;
}

async function listAccessApps(token: string, accountId: string): Promise<AccessApp[]> {
  const response = await withSetupRetry(
    () => cfApiCB.execute(() => fetch(
      `${CF_API_BASE}/accounts/${accountId}/access/apps`,
      { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
    )),
    'listAccessApps'
  );

  const data = await parseCfResponse<AccessApp[]>(response);
  if (!data.success || !Array.isArray(data.result)) {
    throw new Error(`Failed to list Access apps: ${data.errors?.map(e => e.message).join(', ') ?? 'unknown'}`);
  }
  return data.result;
}

async function upsertAccessApp(
  token: string,
  accountId: string,
  customDomain: string,
  existingAppId: string | null,
  managedAppName: string,
  steps: SetupStep[],
  stepIndex: number
): Promise<AccessAppResult | null> {
  const appDomain = getManagedAppDomain(customDomain);
  const method = existingAppId ? 'PUT' : 'POST';
  const url = existingAppId
    ? `${CF_API_BASE}/accounts/${accountId}/access/apps/${existingAppId}`
    : `${CF_API_BASE}/accounts/${accountId}/access/apps`;

  const response = await withSetupRetry(
    () => cfApiCB.execute(() => fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: managedAppName,
      domain: appDomain,
      destinations: getManagedDestinations(customDomain),
      type: 'self_hosted',
      session_duration: '24h',
      auto_redirect_to_identity: false,
      skip_interstitial: true,
    }),
    signal: AbortSignal.timeout(10000),
  })), 'upsertAccessApp');

  const data = await parseCfResponse<AccessAppResult>(response);
  if (!data.success || !data.result?.id) {
    const alreadyExistsError = data.errors?.some((e) =>
      e.message?.toLowerCase().includes('already exists')
      || e.message?.toLowerCase().includes('duplicate')
    );
    if (alreadyExistsError && !existingAppId) {
      logger.warn('Access app already exists but was not found in initial lookup, retrying list', { appDomain });
      const retriedApps = await listAccessApps(token, accountId);
      const existingByDomain = retriedApps.find((app) => app.domain === appDomain);
      if (existingByDomain) {
        return { id: existingByDomain.id, aud: existingByDomain.aud };
      }
      steps[stepIndex].status = 'error';
      steps[stepIndex].error = `Failed to resolve Access application after already-exists retry for ${appDomain}`;
      throw new SetupError(`Failed to resolve Access application after already-exists retry`, steps);
    }

    const rawError = data.errors?.[0]?.message || 'unknown';
    steps[stepIndex].status = 'error';
    steps[stepIndex].error = `Failed to upsert Access application for ${appDomain}`;
    throw new SetupError(`Failed to upsert Access application: ${rawError}`, steps);
  }

  logger.info(`Access app ${existingAppId ? 'updated' : 'created'}`, {
    appDomain,
    appId: data.result.id,
  });
  return data.result;
}

async function listAccessGroups(token: string, accountId: string): Promise<AccessGroup[]> {
  const response = await withSetupRetry(
    () => cfApiCB.execute(() => fetch(
      `${CF_API_BASE}/accounts/${accountId}/access/groups`,
      { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
    )),
    'listAccessGroups'
  );

  const data = await parseCfResponse<AccessGroup[]>(response);
  if (!data.success || !Array.isArray(data.result)) {
    throw new Error(`Failed to list Access groups: ${data.errors?.map(e => e.message).join(', ') ?? 'unknown'}`);
  }
  return data.result;
}

function isAlreadyExistsError(errors: Array<{ message?: string }> | undefined): boolean {
  return errors?.some((e) =>
    e.message?.toLowerCase().includes('already exists')
    || e.message?.toLowerCase().includes('duplicate')
  ) ?? false;
}

async function upsertAccessGroup(
  token: string,
  accountId: string,
  groupName: string,
  members: string[],
  existingGroups: AccessGroup[],
  steps: SetupStep[],
  stepIndex: number
): Promise<AccessGroupResult | null> {
  const existing = existingGroups.find((group) => group.name === groupName) ?? null;
  const method = existing ? 'PUT' : 'POST';
  const url = existing
    ? `${CF_API_BASE}/accounts/${accountId}/access/groups/${existing.id}`
    : `${CF_API_BASE}/accounts/${accountId}/access/groups`;

  const include = members.map((email) => ({ email: { email } }));

  const response = await withSetupRetry(
    () => cfApiCB.execute(() => fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: groupName,
      include,
    }),
    signal: AbortSignal.timeout(10000),
  })), 'upsertAccessGroup');

  const data = await parseCfResponse<AccessGroupResult>(response);
  if (!data.success || !data.result?.id) {
    if (!existing && isAlreadyExistsError(data.errors)) {
      logger.warn('Access group already exists but was not found in initial lookup, retrying list', { groupName });
      const retriedGroups = await listAccessGroups(token, accountId);
      const retried = retriedGroups.find((group) => group.name === groupName);
      if (retried) {
        return { id: retried.id, name: retried.name };
      }
      steps[stepIndex].status = 'error';
      steps[stepIndex].error = `Failed to resolve Access group ${groupName} after already-exists retry`;
      throw new SetupError(`Failed to resolve Access group ${groupName} after already-exists retry`, steps);
    }

    const rawError = data.errors?.[0]?.message || 'unknown';
    steps[stepIndex].status = 'error';
    steps[stepIndex].error = `Failed to upsert Access group ${groupName}`;
    throw new SetupError(`Failed to upsert Access group ${groupName}: ${rawError}`, steps);
  }

  logger.info(`Access group ${existing ? 'updated' : 'created'}`, {
    groupName,
    groupId: data.result.id,
    memberCount: members.length,
  });
  return data.result;
}

export function getAccessGroupNames(workerName?: string): { admin: string; user: string } {
  const normalizedWorkerName = workerName?.trim().toLowerCase() || 'codeflare';
  return {
    admin: `${normalizedWorkerName}-admins`,
    user: `${normalizedWorkerName}-users`,
  };
}

async function deleteAccessApp(
  token: string,
  accountId: string,
  appId: string
): Promise<boolean> {
  const response = await cfApiCB.execute(() => fetch(
    `${CF_API_BASE}/accounts/${accountId}/access/apps/${appId}`,
    {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10000),
    }
  ));

  if (response.ok) {
    return true;
  }

  const data = await parseCfResponse(response);
  logger.warn('Failed to delete legacy Access app', {
    appId,
    status: response.status,
    errors: data.errors,
  });
  return false;
}

async function pruneLegacyAccessApps(
  token: string,
  accountId: string,
  customDomain: string,
  existingApps: AccessApp[],
  managedAppName: string
): Promise<AccessApp[]> {
  const desiredDomain = getManagedAppDomain(customDomain);
  const legacyDomains = getLegacyManagedDomains(customDomain);
  const sameDomainApps = existingApps.filter((app) => app.domain === desiredDomain);
  const preferredManagedId = sameDomainApps.find((app) => app.name === managedAppName)?.id
    ?? sameDomainApps[0]?.id
    ?? null;

  const staleApps = existingApps.filter((app) =>
    (legacyDomains.has(app.domain) && app.domain !== desiredDomain)
    || (app.domain === desiredDomain && preferredManagedId !== null && app.id !== preferredManagedId)
  );

  if (staleApps.length === 0) {
    return existingApps;
  }

  const staleIds = new Set<string>();
  await Promise.all(staleApps.map(async (app) => {
    const deleted = await deleteAccessApp(token, accountId, app.id);
    if (deleted) {
      staleIds.add(app.id);
      logger.info('Deleted legacy Access app', {
        appId: app.id,
        domain: app.domain,
      });
    }
  }));

  return existingApps.filter((app) => !staleIds.has(app.id));
}

async function upsertAccessPolicy(
  token: string,
  accountId: string,
  appId: string,
  adminGroupId: string,
  userGroupId: string
): Promise<void> {
  const include = [
    { group: { id: adminGroupId } },
    { group: { id: userGroupId } },
  ];

  let updated = false;
  try {
    const policiesRes = await cfApiCB.execute(() => fetch(
      `${CF_API_BASE}/accounts/${accountId}/access/apps/${appId}/policies`,
      { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
    ));
    const policiesData = await parseCfResponse<Array<{ id: string; name: string }>>(policiesRes);

    if (policiesData.success && policiesData.result?.length) {
      const existingPolicy = policiesData.result[0];
      const updateRes = await cfApiCB.execute(() => fetch(
        `${CF_API_BASE}/accounts/${accountId}/access/apps/${appId}/policies/${existingPolicy.id}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Allow users',
            decision: 'allow',
            include,
          }),
          signal: AbortSignal.timeout(10000),
        }
      ));
      if (updateRes.ok) {
        updated = true;
      } else {
        logger.warn('Access policy update failed', { appId, status: updateRes.status });
      }
    }
  } catch (policyLookupError) {
    logger.warn('Access policy lookup failed, falling back to create', {
      appId,
      error: toErrorMessage(policyLookupError),
    });
  }

  if (updated) return;

  const createRes = await cfApiCB.execute(() => fetch(
    `${CF_API_BASE}/accounts/${accountId}/access/apps/${appId}/policies`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Allow users',
        decision: 'allow',
        include,
      }),
      signal: AbortSignal.timeout(10000),
    }
  ));

  if (!createRes.ok) {
    const errorText = await createRes.text().catch(() => '');
    throw new Error(`Failed to create Access policy (${createRes.status}): ${errorText}`);
  }
}

async function storeAccessConfig(
  token: string,
  accountId: string,
  kv: KVNamespace,
  audienceTags: string[],
  groupNames: { admin: string; user: string },
  groupIds: { admin: string; user: string },
  accessAppId?: string
): Promise<void> {
  if (audienceTags.length > 0) {
    await kv.put('setup:access_aud', audienceTags[0]);
    await kv.put('setup:access_aud_list', JSON.stringify(audienceTags));
  }
  if (accessAppId) {
    await kv.put('setup:access_app_id', accessAppId);
  }
  await kv.put('setup:access_group_admin_id', groupIds.admin);
  await kv.put('setup:access_group_user_id', groupIds.user);
  await kv.put('setup:access_group_admin_name', groupNames.admin);
  await kv.put('setup:access_group_user_name', groupNames.user);

  try {
    const orgRes = await cfApiCB.execute(() => fetch(
      `${CF_API_BASE}/accounts/${accountId}/access/organizations`,
      { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
    ));
    const orgData = await parseCfResponse<{ auth_domain: string }>(orgRes);

    if (orgData.success && orgData.result?.auth_domain) {
      await kv.put('setup:auth_domain', orgData.result.auth_domain);
      logger.info('Stored auth_domain in KV', { authDomain: orgData.result.auth_domain });
    } else {
      logger.warn('Could not retrieve auth_domain from Access organization', { success: orgData.success });
    }
  } catch (orgError) {
    logger.warn('Failed to fetch Access organization for auth_domain', {
      error: toErrorMessage(orgError),
    });
  }
}

/**
 * Step 5: Create/update protected Cloudflare Access applications.
 * Current model protects /app, /api, and /setup under one Access application
 * and references worker-scoped Access groups for authorization.
 */
export async function handleCreateAccessApp(
  token: string,
  accountId: string,
  customDomain: string,
  allowedUsers: string[],
  adminUsers: string[],
  steps: SetupStep[],
  kv: KVNamespace,
  workerName?: string
): Promise<void> {
  const stepIndex = addStep(steps, 'create_access_app');

  try {
    const groupNames = getAccessGroupNames(workerName);
    const managedAppName = getManagedAppName(workerName);
    const adminSet = new Set(adminUsers.map((email) => email.trim().toLowerCase()));
    const dedupedAllowedUsers = Array.from(new Set(allowedUsers.map((email) => email.trim().toLowerCase())));
    const regularUsers = dedupedAllowedUsers.filter((email) => !adminSet.has(email));

    const listedGroups = await listAccessGroups(token, accountId);
    const adminGroup = await upsertAccessGroup(
      token,
      accountId,
      groupNames.admin,
      Array.from(adminSet),
      listedGroups,
      steps,
      stepIndex
    );
    if (!adminGroup) {
      throw new Error(`Could not resolve Access group ${groupNames.admin}`);
    }

    const userGroup = await upsertAccessGroup(
      token,
      accountId,
      groupNames.user,
      regularUsers,
      listedGroups,
      steps,
      stepIndex
    );
    if (!userGroup) {
      throw new Error(`Could not resolve Access group ${groupNames.user}`);
    }

    const listedApps = await listAccessApps(token, accountId);
    const existingApps = await pruneLegacyAccessApps(token, accountId, customDomain, listedApps, managedAppName);
    const audienceTags: string[] = [];
    const existingManagedApp = await resolveManagedAccessApp(kv, customDomain, existingApps, managedAppName);
    const appResult = await upsertAccessApp(
      token,
      accountId,
      customDomain,
      existingManagedApp?.id ?? null,
      managedAppName,
      steps,
      stepIndex
    );
    if (!appResult) {
      throw new SetupError('Failed to create or update Access application', steps);
    }

    if (appResult.aud) {
      audienceTags.push(appResult.aud);
    }
    await upsertAccessPolicy(token, accountId, appResult.id, adminGroup.id, userGroup.id);

    await storeAccessConfig(token, accountId, kv, audienceTags, groupNames, {
      admin: adminGroup.id,
      user: userGroup.id,
    }, appResult.id);
    steps[stepIndex].status = 'success';
  } catch (error) {
    steps[stepIndex].status = 'error';
    steps[stepIndex].error = 'Failed to configure Access applications';
    if (error instanceof SetupError) {
      throw error;
    }
    throw new SetupError(`Failed to configure Access applications: ${toErrorMessage(error)}`, steps);
  }
}
