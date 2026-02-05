import type { Env, UserRole } from '../types';
import { createLogger } from './logger';
import { listAllKvKeys, emailFromKvKey } from './kv-keys';
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
}

/**
 * Get all user entries from KV (keys starting with "user:")
 */
export async function getAllUsers(kv: KVNamespace): Promise<UserEntry[]> {
  const keys = await listAllKvKeys(kv, 'user:');
  const results = await Promise.all(
    keys.map(async (key) => {
      const data = await kv.get(key.name, 'json') as Omit<UserEntry, 'email'> | null;
      if (!data) return null;
      return {
        ...data,
        email: emailFromKvKey(key.name),
        role: data.role ?? 'user',
      } as UserEntry;
    })
  );
  return results.filter((u): u is UserEntry => u !== null);
}

/**
 * Update CF Access policy to include all users from KV.
 * Updates all Access apps that belong to the configured domain
 * (root domain entry or path-scoped entries like /app/*, /api/*, /setup/*).
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
  const adminGroupId = await kv.get('setup:access_group_admin_id');
  const userGroupId = await kv.get('setup:access_group_user_id');
  const adminGroupNameFromKv = await kv.get('setup:access_group_admin_name');
  const userGroupNameFromKv = await kv.get('setup:access_group_user_name');
  let include: Array<Record<string, unknown>>;

  const canUseGroups = Boolean(adminGroupId && userGroupId);
  if (canUseGroups) {
    const groupsRes = await cfApiCB.execute(() =>
      fetch(`${CF_API_BASE}/accounts/${accountId}/access/groups`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
    const groupsData = await groupsRes.json() as CfAccessGroupsResponse;

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

      await Promise.all([
        upsertGroup(adminGroupId!, adminGroupName, adminEmails),
        upsertGroup(userGroupId!, userGroupName, regularEmails),
      ]);

      include = [
        { group: { id: adminGroupId } },
        { group: { id: userGroupId } },
      ];
    } else {
      logger.warn('syncAccessPolicy: Access group IDs exist but names are unavailable, falling back to email includes');
      include = emails.map((email) => ({ email: { email } }));
    }
  } else {
    if (emails.length === 0) return;
    include = emails.map((email) => ({ email: { email } }));
  }

  // Find the access app by domain
  const appsRes = await cfApiCB.execute(() =>
    fetch(`${CF_API_BASE}/accounts/${accountId}/access/apps`, {
      headers: { Authorization: `Bearer ${token}` },
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
  if (matchingApps.length === 0) return;

  await Promise.all(matchingApps.map(async (app) => {
    // Get existing policies
    const policiesRes = await cfApiCB.execute(() =>
      fetch(
        `${CF_API_BASE}/accounts/${accountId}/access/apps/${app.id}/policies`,
        { headers: { Authorization: `Bearer ${token}` } }
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
