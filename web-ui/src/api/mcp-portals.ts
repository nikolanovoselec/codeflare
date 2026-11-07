import { z } from 'zod';
import { baseFetch } from './fetch-helper';

const PortalStatusSchema = z.object({ name: z.string(), url: z.string(), connected: z.boolean() });
const PortalStatusesSchema = z.object({ portals: z.array(PortalStatusSchema) });
export type McpPortalStatus = z.infer<typeof PortalStatusSchema>;
export async function getMcpPortalStatuses(): Promise<McpPortalStatus[]> {
  const result = await baseFetch<z.infer<typeof PortalStatusesSchema>>('/api/mcp-portals', {}, { credentials: 'same-origin', schema: PortalStatusesSchema });
  return result.portals;
}
const RecoverySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready') }),
  z.object({ state: z.literal('authorization'), url: z.string().url().refine(value => new URL(value).protocol === 'https:') }),
  z.object({ state: z.literal('unavailable') }),
  z.object({ state: z.literal('ineligible') }),
]);
export type McpPortalRecovery = z.infer<typeof RecoverySchema>;
export async function recoverMcpPortal(name: string, authorize: boolean): Promise<McpPortalRecovery> {
  return baseFetch<McpPortalRecovery>(`/api/mcp-portals/${encodeURIComponent(name)}/recover`, {
    method: 'POST', body: JSON.stringify({ authorize }),
  }, { credentials: 'same-origin', schema: RecoverySchema });
}
export function mcpPortalConnectUrl(name: string): string { return `/auth/mcp/connect/${encodeURIComponent(name)}`; }
export async function disconnectMcpPortal(name: string): Promise<void> {
  await baseFetch<{ success: boolean }>(`/api/mcp-portals/${encodeURIComponent(name)}/disconnect`, { method: 'POST' }, {
    credentials: 'same-origin', schema: z.object({ success: z.boolean() }),
  });
}
