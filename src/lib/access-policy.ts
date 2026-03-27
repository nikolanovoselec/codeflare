import type { AccessTier, SubscriptionTier, UserRole } from '../types';
import { AccessTierSchema, SubscriptionTierSchema } from '../types';
import { createLogger } from './logger';
import { listAllKvKeys, emailFromKvKey, SETUP_KEYS } from './kv-keys';
import { CF_API_BASE } from './constants';
import { cfApiCB } from './circuit-breakers';

const logger = createLogger('access-policy');

/** Response shape from the CF Access applications list endpoint */
interface CfAccessAppsResponse {
  success: boolean;
  result?: Array<{ id: string; domain: string; aud: string }>;
}

/** Response shape from the CF Access policies list endpoint */
interface CfAccessPoliciesResponse {
  success: boolean;
  result?: Array<{ id: string; name: string; decision: string; include: unknown[]; exclude?: unknown[] }>;
}

interface CfAccessGroupsResponse {
  success: boolean;
  result?: Array<{ id: string; name: string }>;
}

interface UserEntry {
  email: string;
  addedBy: string;
  addedAt: string;
  role: UserRole;
  accessTier?: AccessTier;
  subscriptionTier?: SubscriptionTier;
}

/**
 * Get all user entries from KV (keys starting with "user:")
 */
export async function getAllUsers(kv: KVNamespace): Promise<UserEntry[]> {
  const keys = await listAllKvKeys(kv, 'user:');
  const results = await Promise.all(
    keys.map(async (key) => {
      const data = await kv.get(key.name, 'json') as Record<string, unknown> | null;
      if (!data) return null;
      const tierParsed = AccessTierSchema.safeParse(data.accessTier);
      const subTierParsed = SubscriptionTierSchema.safeParse(data.subscriptionTier);
      return {
        ...data,
        email: emailFromKvKey(key.name),
        addedBy: (data.addedBy as string) ?? 'unknown',
        addedAt: (data.addedAt as string) ?? '',
        role: (data.role as UserRole) ?? 'user',
        accessTier: tierParsed.success ? tierParsed.data : undefined,
        subscriptionTier: subTierParsed.success ? subTierParsed.data : undefined,
      } as UserEntry;
    })
  );
  return results.filter((u): u is UserEntry => u !== null);
}

/**
 * Get email addresses of all admin users from KV.
 */
export async function getAdminEmails(kv: KVNamespace): Promise<string[]> {
  const users = await getAllUsers(kv);
  return users.filter((u) => u.role === 'admin').map((u) => u.email);
}

/**
 * Sync CF Access policy to match current KV users (non-SaaS mode only).
 * Updates admin and user Access groups with emails from KV.
 * Then updates all Access apps' policies to reference these groups.
 *
 * In SaaS mode, this is skipped because policies use login_method includes
 * instead of group includes. User authorization is handled by access tiers.
 */
export async function syncAccessPolicy(
  token: string,
  accountId: string,
  domain: string,
  kv: KVNamespace
): Promise<void> {
  const users = await getAllUsers(kv);
  const emails = users.map((u) => u.email);
  const adminEmails = users.filter((u) => u.role === 'admin').map((u) => u.email);
  const regularEmails = users.filter((u) => u.role !== 'admin').map((u) => u.email);
  const adminGroupId = await kv.get(SETUP_KEYS.ACCESS_GROUP_ADMIN_ID);
  const userGroupId = await kv.get(SETUP_KEYS.ACCESS_GROUP_USER_ID);
  const adminGroupNameFromKv = await kv.get(SETUP_KEYS.ACCESS_GROUP_ADMIN_NAME);
  const userGroupNameFromKv = await kv.get(SETUP_KEYS.ACCESS_GROUP_USER_NAME);
  let include: Array<Record<string, unknown>>;

  // When group IDs are available, update them with current email lists
  const canUseGroups = Boolean(adminGroupId && userGroupId);
  if (canUseGroups) {
    const groupsRes = await cfApiCB.execute(() =>
      fetch(`${CF_API_BASE}/accounts/${accountId}/access/groups`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      })
    );
    const groupsData = await groupsRes.json() as CfAccessGroupsResponse;

    // Resolve group names from API or KV cache
    const groupsById = new Map((groupsData.result || []).map((group) => [group.id, group.name]));
    const adminGroupName = adminGroupNameFromKv || groupsById.get(adminGroupId!);
    const userGroupName = userGroupNameFromKv || groupsById.get(userGroupId!);

    if (adminGroupName && userGroupName) {
      const upsertGroup = async (groupId: string, groupName: string, groupUsers: string[]) => {
        const updateRes = await cfApiCB.execute(() =>
          fetch(`${CF_API_BASE}/accounts/${accountId}/access/groups/${groupId}`, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: groupName,
              include: groupUsers.map((email) => ({ email: { email } })),
            }),
            signal: AbortSignal.timeout(10_000),
          })
        );

        if (!updateRes.ok) {
          const response = await updateRes.json().catch(() => null);
          logger.error('syncAccessPolicy: Failed to update Access group', new Error(`HTTP ${updateRes.status}`), {
            groupId,
            groupName,
            status: updateRes.status,
            response,
          });
        }
      };

      const groupUpserts = [upsertGroup(adminGroupId!, adminGroupName, adminEmails)];
      if (regularEmails.length > 0) {
        groupUpserts.push(upsertGroup(userGroupId!, userGroupName, regularEmails));
      }
      await Promise.all(groupUpserts);

      include = [
        { group: { id: adminGroupId } },
        ...(regularEmails.length > 0 ? [{ group: { id: userGroupId } }] : []),
      ];
    } else {
      logger.warn('syncAccessPolicy: Access group IDs exist but names are unavailable, falling back to email includes');
      include = emails.map((email) => ({ email: { email } }));
    }
  } else {
    if (emails.length === 0) return;
    include = emails.map((email) => ({ email: { email } }));
  }

  // Fetch all Access apps and filter to those matching the configured domain
  // (exact match or path-scoped like domain/app/*, domain/api/*, domain/setup/*)
  const appsRes = await cfApiCB.execute(() =>
    fetch(`${CF_API_BASE}/accounts/${accountId}/access/apps`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
  );
  const appsData = await appsRes.json() as CfAccessAppsResponse;

  if (!appsData.success) {
    logger.error('syncAccessPolicy: Failed to fetch Access apps', new Error('API request failed'), { response: appsData });
    return;
  }

  const matchingApps = (appsData.result || []).filter((app) =>
    app.domain === domain || app.domain.startsWith(`${domain}/`)
  );
  if (matchingApps.length === 0) return; // No apps for this domain — nothing to sync

  await Promise.all(matchingApps.map(async (app) => {
    // Get existing policies
    const policiesRes = await cfApiCB.execute(() =>
      fetch(
        `${CF_API_BASE}/accounts/${accountId}/access/apps/${app.id}/policies`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }
      )
    );
    const policiesData = await policiesRes.json() as CfAccessPoliciesResponse;

    if (!policiesData.success || !policiesData.result?.length) return;

    // Prefer the 'Allow Users' policy by name; fall back to first policy
    const policy = policiesData.result.find(
      (p) => p.name === 'Allow Users' || p.name === 'Allow users'
    ) || policiesData.result[0];

    // Update policy with email includes - explicitly pick fields for the PUT body
    const updateRes = await cfApiCB.execute(() =>
      fetch(
        `${CF_API_BASE}/accounts/${accountId}/access/apps/${app.id}/policies/${policy.id}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: policy.name,
            decision: policy.decision,
            include,
            exclude: policy.exclude || [],
          }),
          signal: AbortSignal.timeout(10_000),
        }
      )
    );

    if (!updateRes.ok) {
      const updateData = await updateRes.json().catch(() => null);
      logger.error('syncAccessPolicy: Failed to update Access policy', new Error(`HTTP ${updateRes.status}`), {
        status: updateRes.status,
        response: updateData,
        appId: app.id,
        policyId: policy.id,
      });
    }
  }));
}
