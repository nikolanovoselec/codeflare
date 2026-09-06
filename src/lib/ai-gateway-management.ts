import { z } from 'zod';
import type { Env } from '../types';
import { getAigConfig } from './aig-config';

const MAX_MANAGEMENT_RESPONSE_BYTES = 1024 * 1024;
const MANAGEMENT_REQUEST_TIMEOUT_MS = 10_000;
export const dynamicRouteSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase()));
export const gatewayDraftSchema = z.object({
  gatewayUrl: z.string().trim().max(512).refine((value) => parseGatewayUrl(value) !== null),
  replacementToken: z.string().trim().max(2048).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
}).strict();
export const backendDescriptionsSchema = z.record(
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase())),
  z.string().trim().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/),
).refine((value) => Object.keys(value).length <= 256);
export type GatewayDraft = z.infer<typeof gatewayDraftSchema>;
export interface GatewayConnection { gatewayUrl?: string; token?: string }
export interface ConnectionStatus { status: 'ready' | 'missing' | 'permission-denied' | 'unavailable'; message: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function safeString(value: unknown, maxLength = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}
export function parseGatewayUrl(raw: string | undefined): { accountId: string; gatewayId: string } | null {
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'gateway.ai.cloudflare.com' || url.port || url.username || url.password || url.search || url.hash) return null;
  const match = /^\/v1\/([a-f0-9]{32})\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/|\/compat\/?)?$/i.exec(url.pathname);
  return match ? { accountId: match[1], gatewayId: match[2] } : null;
}
export async function resolveGatewayConnection(env: Env, draft?: GatewayDraft): Promise<GatewayConnection> {
  // The incumbent source remains the sole owner of stored encrypted credentials.
  const saved = await getAigConfig(env);
  return { gatewayUrl: draft?.gatewayUrl ?? saved.gatewayUrl, token: draft?.replacementToken?.trim() || saved.token };
}
class GatewayManagementError extends Error {
  constructor(public readonly status: number) { super('management_request_failed'); }
}
export function connectionStatus(error?: unknown, missing = false): ConnectionStatus {
  if (missing) return { status: 'missing', message: 'Configure an AI Gateway URL and API token.' };
  if (error instanceof GatewayManagementError && (error.status === 401 || error.status === 403)) {
    return { status: 'permission-denied', message: 'Management access was denied. Use a valid API token with AI Gateway Read access to this gateway. AI Gateway Run alone does not allow route inspection.' };
  }
  if (error) return { status: 'unavailable', message: 'AI Gateway route inspection is unavailable. Retry when the connection is available.' };
  return { status: 'ready', message: 'AI Gateway route inspection is available.' };
}
async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = ''; let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_MANAGEMENT_RESPONSE_BYTES) {
      await reader.cancel('management response too large');
      throw new Error('management_response_too_large');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try { return JSON.parse(text); } catch { throw new Error('management_response_malformed'); }
}
function extractElements(value: Record<string, unknown>): unknown {
  if (Array.isArray(value.data)) return value.data;
  if (typeof value.data === 'string') {
    try {
      const parsed: unknown = JSON.parse(value.data);
      if (Array.isArray(parsed)) return parsed;
      if (isPlainObject(parsed) && Array.isArray(parsed.elements)) return parsed.elements;
    } catch { return undefined; }
  }
  if (Array.isArray(value.elements)) return value.elements;
  if (isPlainObject(value.configuration) && Array.isArray(value.configuration.elements)) return value.configuration.elements;
  if (isPlainObject(value.config) && Array.isArray(value.config.elements)) return value.config.elements;
  return undefined;
}
function extractVersion(value: unknown): { versionId: string; elements?: unknown } | null {
  if (!isPlainObject(value)) return null;
  const result = isPlainObject(value.result) ? value.result : value;
  const active = isPlainObject(result.version) ? result.version
    : isPlainObject(result.active_version) ? result.active_version
      : isPlainObject(result.activeVersion) ? result.activeVersion : result;
  const versionId = [active.id, active.version_id, active.versionId, result.active_version_id, result.activeVersionId]
    .find((candidate): candidate is string => safeString(candidate, 128));
  if (!versionId) return null;
  if (isPlainObject(result.version)) {
    if (active.active !== true && active.active !== 'true') return null;
    const deployedVersion = isPlainObject(result.deployment)
      ? [result.deployment.version_id, result.deployment.versionId].find((candidate): candidate is string => safeString(candidate, 128)) : undefined;
    if (deployedVersion && deployedVersion !== versionId) return null;
  }
  const elements = extractElements(active) ?? extractElements(result);
  return elements === undefined ? { versionId } : { versionId, elements };
}
async function managementRequest(url: string, token: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('management request timeout'), MANAGEMENT_REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'manual', signal: controller.signal });
    } catch { throw new Error('management_transport_failure'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new GatewayManagementError(response.status);
    }
    const payload = await readBoundedJson(response);
    if (isPlainObject(payload) && payload.success === false) throw new GatewayManagementError(response.status);
    return payload;
  } finally { clearTimeout(timeout); }
}
export async function listDynamicRoutes(accountId: string, gatewayId: string, token: string): Promise<Array<{ id: string; name: string }>> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/routes`;
  const payload = await managementRequest(base, token);
  if (!isPlainObject(payload)) throw new Error('route_list_malformed');
  const envelope = isPlainObject(payload.data) ? payload.data : isPlainObject(payload.result) ? payload.result : null;
  if (!envelope || !Array.isArray(envelope.routes)) throw new Error('route_list_malformed');
  return envelope.routes.map((candidate) => {
    if (!isPlainObject(candidate) || !safeString(candidate.id, 128) || !dynamicRouteSchema.safeParse(candidate.name).success) throw new Error('route_list_malformed');
    return { id: candidate.id, name: candidate.name as string };
  });
}
export async function loadActiveRouteVersion(accountId: string, gatewayId: string, route: string, token: string): Promise<{ versionId: string; elements: unknown }> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/routes`;
  const listed = (await listDynamicRoutes(accountId, gatewayId, token)).find((candidate) => candidate.name === route);
  if (!listed) throw new Error('route_not_found');
  const active = extractVersion(await managementRequest(`${base}/${encodeURIComponent(listed.id)}`, token));
  if (!active || active.elements === undefined) throw new Error('active_version_malformed');
  return { versionId: active.versionId, elements: active.elements };
}
