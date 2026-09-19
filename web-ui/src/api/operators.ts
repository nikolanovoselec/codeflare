/**
 * Browser API boundary: wire contracts, strict response schemas and thin request adapters.
 * All requests reuse authenticated fetch handling and canonical same-origin paths. No automatic
 * mutation retries or persistent secret storage; plaintext keys exist only in rotation responses.
 */
import { z } from 'zod';
import { baseFetch } from './fetch-helper';

/** Operator administration wire contracts; secrets are mutation-only, never readback fields. */
export interface OperatorRegistration {
  operatorId: string;
  revision: number;
  enabled: boolean;
  approvedArtifactDigest: string | null;
}
export interface OperatorPolicyInput {
  schemaVersion: 1;
  networkHosts: string[];
  github: { repositories: string[]; methods: string[] };
  storage: { readPrefixes: string[]; writePrefixes: string[] };
  inference: { routeIds: string[]; defaultRouteId: string | null; reasoningLevels: string[];
    defaultReasoningLevel: string | null; inheritUserDefaults: boolean };
}
export interface OperatorDetails {
  registration: OperatorRegistration;
  endpoint: string | null;
  connectionSecretConfigured: boolean;
  webhookKeyConfigured: boolean;
  discoveredManifestJson: string | null;
  approvedManifestJson: string | null;
  policyJson: string | null;
}
const registrationSchema: z.ZodType<OperatorRegistration> = z.strictObject({
  operatorId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), revision: z.number().int().positive(),
  enabled: z.boolean(), approvedArtifactDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});
const jsonText = z.string().max(65536).nullable();
const detailsSchema: z.ZodType<OperatorDetails> = z.strictObject({
  registration: registrationSchema, endpoint: z.string().nullable(),
  connectionSecretConfigured: z.boolean(), webhookKeyConfigured: z.boolean(),
  discoveredManifestJson: jsonText, approvedManifestJson: jsonText, policyJson: jsonText,
});
const path = (id: string) => `/${encodeURIComponent(id)}`;
/** Existing authenticated fetch/error behavior; no mutation retries or secret persistence. */
function request<T>(suffix: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  return baseFetch(`/api/admin/operators${suffix}`, { method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { credentials: 'same-origin', schema });
}
export function listOperators(): Promise<{ operators: OperatorRegistration[] }> {
  return request('', z.strictObject({ operators: z.array(registrationSchema) }));
}
export function getOperator(id: string): Promise<OperatorDetails> { return request(path(id), detailsSchema); }
export function registerOperator(input: { endpoint: string; connectionSecret: string; policy: OperatorPolicyInput }): Promise<OperatorRegistration> {
  return request('', registrationSchema, input);
}
export function discoverOperator(id: string): Promise<{ manifestJson: string }> {
  return request(`${path(id)}/discover`, z.strictObject({ manifestJson: z.string().max(65536) }), {});
}
export function approveOperator(id: string, expectedRevision: number, artifactDigest: string): Promise<OperatorRegistration> {
  return request(`${path(id)}/approve`, registrationSchema, { expectedRevision, artifactDigest });
}
export function setOperatorEnabled(id: string, expectedRevision: number, enabled: boolean): Promise<OperatorRegistration> {
  return request(`${path(id)}/enable`, registrationSchema, { expectedRevision, enabled });
}
export function setOperatorDistribution(id: string, expectedRevision: number, endpoint: string, connectionSecret: string): Promise<OperatorRegistration> {
  return request(`${path(id)}/distribution`, registrationSchema, { expectedRevision, endpoint, connectionSecret });
}
export function setOperatorPolicy(id: string, expectedRevision: number, policy: OperatorPolicyInput): Promise<OperatorRegistration> {
  return request(`${path(id)}/policy`, registrationSchema, { expectedRevision, policy });
}
export function rotateOperatorWebhookKey(id: string, expectedRevision: number): Promise<{ registration: OperatorRegistration; key: string }> {
  return request(`${path(id)}/webhook-key`, z.strictObject({ registration: registrationSchema,
    key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }), { expectedRevision });
}
