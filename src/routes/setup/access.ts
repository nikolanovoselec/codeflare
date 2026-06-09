import { SetupError, toErrorMessage } from '../../lib/error-types';
import { parseCfResponse } from '../../lib/cf-api';
import { cfApiCB } from '../../lib/circuit-breakers';
import { CF_API_BASE, logger, addStep, withSetupRetry } from './shared';
import { SETUP_KEYS } from '../../lib/kv-keys';
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

function getManagedAppDomain(customDomain: string, enterprise = false): string {
  // Enterprise: host-scoped app (bare host). A path-scoped primary domain
  // (`/app/*`) scopes the CF Access session cookie to /app, so it is never sent
  // on /api/* sibling requests -> those 401 and the SPA redirect-loops. The bare
  // host makes the cookie host-wide so one login covers /app + /api uniformly.
  return enterprise ? customDomain : `${customDomain}${PRIMARY_PROTECTED_SUFFIX}`;
}

function getManagedDestinations(customDomain: string, enterprise = false): Array<{ type: 'public'; uri: string }> {
  // Enterprise protects the whole host: there are no public paths on an
  // enterprise custom domain (no Stripe webhook, no public landing; `/` just
  // redirects to /app), so a single host-wide Access session is correct and
  // safe. Default/SaaS keep the path scoping so `/`, `/public/*` (Stripe
  // webhook), and `/auth/*` stay reachable without Access.
  if (enterprise) {
    // Enterprise supersedes SaaS: if both flags are ever set, the whole-host
    // scope wins (SaaS still governs *who* may authenticate via its IdP list,
    // but the Access session covers the full host). Enterprise is single-tenant,
    // so this co-activation is not expected — the precedence is made explicit.
    return [{ type: 'public', uri: customDomain }];
  }
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
  managedAppName: string,
  enterprise = false
): Promise<AccessApp | null> {
  // 4-tier fallback strategy to find existing Access app:
  // 1. Exact domain match (highest specificity)
  // 2. Stored app ID from prior setup
  // 3. Name match + domain validation (prevent cross-env collision)
  // 4. /app/* suffix + domain validation (prevent cross-env collision)

  const desiredDomain = getManagedAppDomain(customDomain, enterprise);
  const byDesiredDomain = existingApps.find((app) => app.domain === desiredDomain) ?? null;
  if (byDesiredDomain) {
    return byDesiredDomain;
  }

  const storedAppId = await kv.get(SETUP_KEYS.ACCESS_APP_ID);
  if (storedAppId) {
    const byStoredId = existingApps.find((app) => app.id === storedAppId) ?? null;
    if (byStoredId) {
      return byStoredId;
    }
  }

  // Tier 3: Name match + domain validation
  // Handles fresh KV + pre-existing Access app from prior setup
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

  // Tier 4: /app/* suffix + domain validation (legacy app format)
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

function isAlreadyExistsError(errors: Array<{ message?: string }> | undefined): boolean {
  return errors?.some((e) =>
    e.message?.toLowerCase().includes('already exists')
    || e.message?.toLowerCase().includes('duplicate')
  ) ?? false;
}

async function upsertAccessApp(
  token: string,
  accountId: string,
  customDomain: string,
  existingAppId: string | null,
  managedAppName: string,
  steps: SetupStep[],
  stepIndex: number,
  saasIdpIds?: string[],
  enterprise = false
): Promise<AccessAppResult | null> {
  const appDomain = getManagedAppDomain(customDomain, enterprise);
  const method = existingAppId ? 'PUT' : 'POST';
  const url = existingAppId
    ? `${CF_API_BASE}/accounts/${accountId}/access/apps/${existingAppId}`
    : `${CF_API_BASE}/accounts/${accountId}/access/apps`;

  // SaaS mode: configure app to restrict login methods to social IdPs.
  // Note: This is the APPLICATION config (controls login UI), separate from the POLICY
  // (controls who is allowed). In SaaS mode, the policy uses login_method includes,
  // allowing any authenticated user. Worker enforces access-tier authorization.
  const appBody: Record<string, unknown> = {
    name: managedAppName,
    domain: appDomain,
    destinations: getManagedDestinations(customDomain, enterprise),
    type: 'self_hosted',
    session_duration: '24h',
    skip_interstitial: true,
    auto_redirect_to_identity: saasIdpIds ? saasIdpIds.length === 1 : false,
  };
  // Restrict login to GitHub IdP in SaaS mode (social IdP)
  if (saasIdpIds && saasIdpIds.length > 0) {
    appBody.allowed_idps = saasIdpIds;
  }

  const response = await withSetupRetry(
    () => cfApiCB.execute(() => fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(appBody),
    signal: AbortSignal.timeout(10000),
  })), 'upsertAccessApp');

  const data = await parseCfResponse<AccessAppResult>(response);
  if (!data.success || !data.result?.id) {
    if (isAlreadyExistsError(data.errors) && !existingAppId) {
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

// Enterprise SW-bypass destination. CF Access mid-path wildcards (a `*` that is
// not the trailing segment) are not reliably supported; PRIMARY is the tight
// mid-path glob, with the path-prefix as the documented fallback. The Worker's
// own auth chain still gates every other /api/vault/* request — this bypass only
// removes the edge-302 that pre-empts the credential-less SW script fetch
// (REQ-VAULT-017), so the Worker's method+header SW short-circuit can run.
function getSwBypassDestinations(customDomain: string): Array<{ type: 'public'; uri: string }> {
  return [{ type: 'public', uri: `${customDomain}/api/vault/*/service_worker.js` }];
}

// Higher-precedence self-hosted Access app scoped to the vault service-worker
// script, with a BYPASS policy (decision: 'bypass', include everyone) so the
// credential-less SW registration GET reaches the Worker instead of being 302'd
// by the host-wide enterprise Access app. Enterprise-only. Mirrors
// upsertAccessApp's create/PUT + already-exists-retry shape and
// upsertAccessPolicy's list-then-create shape.
async function upsertSwBypassAccessApp(
  token: string,
  accountId: string,
  customDomain: string,
  kv: KVNamespace,
  existingApps: AccessApp[],
): Promise<void> {
  // Best-effort: a failure here must NEVER abort the already-succeeded host-wide
  // Access setup, and must never leave a policy-less self_hosted app on the SW path
  // (a self_hosted app with no policy DENIES the path — worse than the 302 we fix).
  // So the app id is persisted only after the bypass policy succeeds, a freshly
  // created app is rolled back if the policy step fails, and every failure warns loudly.
  const swAppName = 'codeflare-vault-sw-bypass';
  const destinations = getSwBypassDestinations(customDomain);
  const storedId = await kv.get(SETUP_KEYS.ACCESS_SW_BYPASS_APP_ID);
  const existing = (storedId && existingApps.find((a) => a.id === storedId))
    || existingApps.find((a) => a.name === swAppName) || null;
  const method = existing ? 'PUT' : 'POST';
  const url = existing
    ? `${CF_API_BASE}/accounts/${accountId}/access/apps/${existing.id}`
    : `${CF_API_BASE}/accounts/${accountId}/access/apps`;

  const appBody: Record<string, unknown> = {
    name: swAppName,
    // CF resolves overlapping apps by precedence; this more-specific path must win
    // over the host-wide app. Verify in-dashboard that the SW path resolves here.
    domain: `${customDomain}/api/vault/*/service_worker.js`,
    destinations,
    type: 'self_hosted',
    session_duration: '24h',
    skip_interstitial: true,
    precedence: 1,
  };

  let createdAppId: string | null = null;
  try {
    const appRes = await withSetupRetry(
      () => cfApiCB.execute(() => fetch(url, {
        method,
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(appBody),
        signal: AbortSignal.timeout(10000),
      })),
      'upsertSwBypassAccessApp',
    );
    const appData = await parseCfResponse<AccessAppResult>(appRes);
    if (!appData.success || !appData.result?.id) {
      // If the mid-path scope is rejected, an operator must know to apply the
      // documented /api/vault prefix fallback — warn loudly, never silent.
      logger.warn('SW-bypass Access app upsert failed; vault service-worker may 302 under enterprise Access', {
        domain: appBody.domain,
        error: appData.errors?.[0]?.message ?? 'unknown',
      });
      return;
    }
    const swAppId = appData.result.id;
    if (!existing) createdAppId = swAppId;

    // BYPASS policy: include everyone, decision 'bypass' (no auth required).
    const policyBody = { name: 'Vault SW bypass', decision: 'bypass', include: [{ everyone: {} }] };
    const polListRes = await cfApiCB.execute(() => fetch(
      `${CF_API_BASE}/accounts/${accountId}/access/apps/${swAppId}/policies`,
      { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(10000) },
    ));
    const polList = await parseCfResponse<Array<{ id: string }>>(polListRes);
    const existingPolicyId = (polList.success && polList.result && polList.result.length > 0)
      ? polList.result[0].id
      : null;
    const polRes = existingPolicyId
      ? await cfApiCB.execute(() => fetch(
          `${CF_API_BASE}/accounts/${accountId}/access/apps/${swAppId}/policies/${existingPolicyId}`,
          { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(policyBody), signal: AbortSignal.timeout(10000) },
        ))
      : await cfApiCB.execute(() => fetch(
          `${CF_API_BASE}/accounts/${accountId}/access/apps/${swAppId}/policies`,
          { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(policyBody), signal: AbortSignal.timeout(10000) },
        ));
    if (!polRes.ok) {
      logger.warn('SW-bypass Access policy failed; rolling back the bypass app to avoid blocking the vault service-worker', { swAppId, status: polRes.status });
      if (createdAppId) await deleteAccessApp(token, accountId, createdAppId).catch(() => { /* best effort */ });
      return;
    }
    // Persist the id only after the bypass policy is in place.
    await kv.put(SETUP_KEYS.ACCESS_SW_BYPASS_APP_ID, swAppId);
    logger.info('SW-bypass Access app + policy provisioned', { swAppId, domain: appBody.domain });
  } catch (error) {
    logger.warn('SW-bypass Access provisioning errored; vault service-worker may 302 under enterprise Access', { error: toErrorMessage(error) });
    if (createdAppId) await deleteAccessApp(token, accountId, createdAppId).catch(() => { /* best effort */ });
  }
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
  managedAppName: string,
  enterprise = false
): Promise<AccessApp[]> {
  const desiredDomain = getManagedAppDomain(customDomain, enterprise);
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

async function listIdentityProviders(
  token: string,
  accountId: string
): Promise<Array<{ id: string; type: string; name: string }>> {
  const res = await cfApiCB.execute(() => fetch(
    `${CF_API_BASE}/accounts/${accountId}/access/identity_providers`,
    { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
  ));
  const data = await parseCfResponse<Array<{ id: string; type: string; name: string }>>(res);
  if (data.success && Array.isArray(data.result)) {
    return data.result.map(p => ({ id: p.id, type: p.type, name: p.name }));
  }
  return [];
}

async function upsertAccessPolicy(
  token: string,
  accountId: string,
  appId: string,
  adminGroupId: string,
  userGroupId: string | null,
  saasLoginMethods?: Array<{ id: string }>
): Promise<void> {
  // Policy include strategy (determines who passes CF Access):
  // - SaaS mode: login_method includes (any user authenticating via GitHub).
  //   Worker applies access-tier gating. Admin group NOT in policy (Worker checks role).
  // - Default mode: group includes (admin + user groups with allowlisted emails).
  const include = saasLoginMethods
    ? saasLoginMethods.map(m => ({ login_method: { id: m.id } }))
    : [
        { group: { id: adminGroupId } },
        ...(userGroupId ? [{ group: { id: userGroupId } }] : []),
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
    await kv.put(SETUP_KEYS.ACCESS_AUD, audienceTags[0]);
    await kv.put(SETUP_KEYS.ACCESS_AUD_LIST, JSON.stringify(audienceTags));
  }
  if (accessAppId) {
    await kv.put(SETUP_KEYS.ACCESS_APP_ID, accessAppId);
  }
  await kv.put(SETUP_KEYS.ACCESS_GROUP_ADMIN_ID, groupIds.admin);
  await kv.put(SETUP_KEYS.ACCESS_GROUP_USER_ID, groupIds.user);
  await kv.put(SETUP_KEYS.ACCESS_GROUP_ADMIN_NAME, groupNames.admin);
  await kv.put(SETUP_KEYS.ACCESS_GROUP_USER_NAME, groupNames.user);

  try {
    const orgRes = await cfApiCB.execute(() => fetch(
      `${CF_API_BASE}/accounts/${accountId}/access/organizations`,
      { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
    ));
    const orgData = await parseCfResponse<{ auth_domain: string }>(orgRes);

    if (orgData.success && orgData.result?.auth_domain) {
      await kv.put(SETUP_KEYS.AUTH_DOMAIN, orgData.result.auth_domain);
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
  workerName?: string,
  saasMode?: boolean,
  enterprise = false
): Promise<void> {
  const stepIndex = addStep(steps, 'create_access_app');

  try {
    const groupNames = getAccessGroupNames(workerName);
    const managedAppName = getManagedAppName(workerName);
    const adminSet = new Set(adminUsers.map((email) => email.trim().toLowerCase()));
    const dedupedAllowedUsers = Array.from(new Set(allowedUsers.map((email) => email.trim().toLowerCase())));
    const regularUsers = dedupedAllowedUsers.filter((email) => !adminSet.has(email));

    // Fetch IdPs early — needed for SaaS mode policy AND stored in KV for login page
    const idpList = await listIdentityProviders(token, accountId);
    if (idpList.length > 0) {
      await kv.put(SETUP_KEYS.IDP_LIST, JSON.stringify(idpList));
      logger.info('Stored IdP list in KV', { count: idpList.length });
    }

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

    // In SaaS mode, skip user group creation because:
    // - Access policy uses login_method includes (any authenticated GitHub user)
    // - Worker enforces per-user access-tier authorization (pending/standard/advanced)
    let userGroup: AccessGroupResult | null = null;
    if (!saasMode && regularUsers.length > 0) {
      userGroup = await upsertAccessGroup(
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
    }

    const listedApps = await listAccessApps(token, accountId);
    const existingApps = await pruneLegacyAccessApps(token, accountId, customDomain, listedApps, managedAppName, enterprise);
    const audienceTags: string[] = [];
    const existingManagedApp = await resolveManagedAccessApp(kv, customDomain, existingApps, managedAppName, enterprise);

    // In SaaS mode, restrict the Access app to GitHub IdP only.
    // With exactly one IdP, auto_redirect_to_identity=true skips the CF Access login interstitial.
    const saasIdpIds = saasMode
      ? idpList.filter(p => p.type === 'github').map(p => p.id)
      : undefined;

    const appResult = await upsertAccessApp(
      token,
      accountId,
      customDomain,
      existingManagedApp?.id ?? null,
      managedAppName,
      steps,
      stepIndex,
      saasIdpIds,
      enterprise
    );
    if (!appResult) {
      throw new SetupError('Failed to create or update Access application', steps);
    }

    if (appResult.aud) {
      audienceTags.push(appResult.aud);
    }

    // Access policy includes strategy:
    // - SaaS mode: login_method include (any GitHub-authenticated user passes CF Access).
    //   Worker enforces per-user access-tier authorization (pending/standard/advanced).
    // - Default mode: group-based includes (only allowlisted email addresses).
    const saasLoginMethods = saasMode && saasIdpIds
      ? saasIdpIds.map(id => ({ id }))
      : undefined;
    await upsertAccessPolicy(token, accountId, appResult.id, adminGroup.id, userGroup?.id ?? null, saasLoginMethods);

    await storeAccessConfig(token, accountId, kv, audienceTags, groupNames, {
      admin: adminGroup.id,
      user: userGroup?.id ?? '',
    }, appResult.id);

    // Enterprise-only: the host-wide Access app would 302 the credential-less
    // vault service-worker registration fetch before the Worker runs (REQ-VAULT-017,
    // Point 5). A higher-precedence bypass app scoped to the SW path lets that one
    // request through to the Worker's own SW short-circuit. Default/SaaS leave the
    // SW path reachable already, so no bypass app is created.
    if (enterprise) {
      await upsertSwBypassAccessApp(token, accountId, customDomain, kv, existingApps);
    }

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
