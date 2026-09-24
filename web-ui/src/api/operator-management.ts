/** Dedicated management client; legacy endpoint administration remains unchanged. */
import { z } from 'zod';
import { baseFetch } from './fetch-helper';
import { operatorActivitySummarySchema } from './operator-activities';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z.number().int().positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const grantSchema = z.object({ users: z.array(z.string()).max(128),
  groups: z.array(z.object({ issuer: z.string(), id: z.string() })).max(128) });
export const policySchema = z.object({ capabilities: z.array(z.string()).max(32), resourceProfileId: z.string().nullable() });
export type ManagementGrant = z.infer<typeof grantSchema>;
export type ManagementPolicy = z.infer<typeof policySchema>;
const summarySchema = z.object({ id, name: z.string().optional(), repositoryUrl: z.string().optional(),
  profile: z.enum(['conductor', 'dispatcher']), realm: z.enum(['internal', 'external']), enabled: z.boolean() });
const operatorSchema = summarySchema.extend({ revision, repositoryId: z.number().int().positive(),
  repositoryUrl: z.string(), managers: grantSchema, invokers: grantSchema, policy: policySchema,
  source: z.object({ kind: z.literal('github-release'), repositoryUrl: z.string(), repositoryId: z.number().int().positive(),
    credentialConfigured: z.boolean(), approvedWorkflow: z.object({ id: z.number().int().positive(), ref: z.string() }).nullable() }),
});
const releaseSchema = z.object({ id, operatorId: id, githubReleaseId: z.number().int().positive(), sourceCommit: z.string(),
  manifestDigest: digest, bundleDigest: digest, interfaceVersion: z.literal(1), approved: z.boolean(),
  name: z.string().optional(), version: z.string().optional(), coreVersion: z.string().optional(), intentVersion: z.string().optional(),
  requestedCapabilities: z.array(z.string()).max(32).optional() });
const installationSchema = z.object({ id, operatorId: id, name: z.string(), releaseId: id.nullable(), revision,
  enabled: z.boolean(), policy: policySchema, configuration: z.record(z.string(), z.json()).optional() });
const detailSchema = z.object({ operator: operatorSchema, releases: z.array(releaseSchema),
  installations: z.array(installationSchema), grants: z.object({ managers: grantSchema, invokers: grantSchema }) });
export type ManagementSummary = z.infer<typeof summarySchema>;
export type ManagementRelease = z.infer<typeof releaseSchema>;
export type ManagementInstallation = z.infer<typeof installationSchema>;
export type ManagementDetail = z.infer<typeof detailSchema>;
export interface CatalogQuery { cursor?: string; query?: string; profile?: string; realm?: string; state?: string }
export interface RegistrationInput { repositoryUrl: string; githubPat: string; profile: 'conductor' | 'dispatcher'; realm: 'internal' | 'external';
  managers: ManagementGrant; invokers: ManagementGrant; policy: ManagementPolicy }
const segment = (value: string) => encodeURIComponent(value);
function request<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  // Absolute same-origin URL also keeps the native Request boundary usable by tests.
  return baseFetch(new URL(`/api/operator-management${path}`, window.location.origin).href,
    { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    { credentials: 'same-origin', schema });
}
export function listManagedOperators(query: CatalogQuery = {}) {
  const search = new URLSearchParams({ limit: '50' });
  for (const [key, value] of Object.entries(query)) if (value) search.set(key, value);
  return request(`/operators?${search}`, z.object({ items: z.array(summarySchema).max(100), cursor: z.string().nullable() }));
}
const accessSchema = z.object({ revision: z.number().int().nonnegative(), managers: grantSchema,
  ceiling: z.object({ capabilities: z.array(z.string()).max(32), resourceProfileIds: z.array(z.string()).max(128) }) });
export type ManagementAccess = z.infer<typeof accessSchema>;
export const getManagementAccess = () => request('/access', accessSchema);
export const saveManagementAccess = (input: ManagementAccess) => request('/access', accessSchema, input);
export const getManagedOperator = (operatorId: string) => request(`/operators/${segment(operatorId)}`, detailSchema);
export const replaceOperatorSource = (operatorId: string, input: { revision: number; repositoryUrl: string; githubPat: string }) =>
  request(`/operators/${segment(operatorId)}/source`, operatorSchema, input);
export const configureInstallation = (installationId: string, input: { revision: number; policy: ManagementPolicy; configuration: unknown }) =>
  request(`/installations/${segment(installationId)}/configure`, installationSchema, input);
export const registerManagedOperator = (input: RegistrationInput) => request('/operators', operatorSchema, input);
export const refreshManagedReleases = (operatorId: string, revision: number) =>
  request(`/operators/${segment(operatorId)}/releases/refresh`, z.object({ items: z.array(releaseSchema) }), { revision });
export const createInstallation = (operatorId: string, input: { name: string; policy: ManagementPolicy; revision: number }) =>
  request(`/operators/${segment(operatorId)}/installations`, installationSchema, input);
export const promoteInstallation = (installationId: string, releaseId: string, revision: number) =>
  request(`/installations/${segment(installationId)}/promote`, installationSchema, { releaseId, revision });
export const enableInstallation = (installationId: string, enabled: boolean, revision: number) =>
  request(`/installations/${segment(installationId)}/enable`, installationSchema, { enabled, revision });
export const saveOperatorGrants = (operatorId: string, input: { managers: ManagementGrant; invokers: ManagementGrant; revision: number }) =>
  request(`/operators/${segment(operatorId)}/grants`, operatorSchema, input);

// Directed execution stays under the existing owner-scoped activity API.
function activityRequest<T>(suffix: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  return baseFetch(new URL(`/api/operator-activities${suffix}`, window.location.origin).href,
    { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    { credentials: 'same-origin', schema });
}
export const getOwnedActivities = () => activityRequest('', z.object({ items: z.array(operatorActivitySummarySchema).max(100) }));
export const prepareInstallationActivity = (installationId: string, invocation: unknown) => activityRequest('',
  z.object({ activityId: id, startCapability: z.string().min(43).max(128), startExpiresAt: z.number() }), { installationId, invocation });
export const startInstallationActivity = (activityId: string, capability: string) =>
  activityRequest(`/${segment(activityId)}/start`, z.object({ ok: z.literal(true) }), { capability });
const activityDetailSchema = operatorActivitySummarySchema.strip().extend({ checkpoint: z.unknown(), result: z.unknown() });
export const getOwnedActivity = (activityId: string) => activityRequest(`/${segment(activityId)}`, activityDetailSchema);
export const cancelOwnedActivity = (activityId: string) => activityRequest(`/${segment(activityId)}/cancel`, operatorActivitySummarySchema.strip(), {});
export const continueOwnedActivity = (activityId: string) => activityRequest(`/${segment(activityId)}/continue`, z.object({ ok: z.literal(true) }), {});
