import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';
import { getConfiguredMcpPortals, type McpPortal } from './lib/mcp-portals';
import { getMcpPortalGrant, getValidMcpPortalToken } from './lib/mcp-portal-token';

export interface McpPortalInterceptorProps { bucket: string; portals: McpPortal[]; strict?: boolean; operator?: boolean }
const denied = (status: number, code: string) => Response.json({ code, error: 'MCP portal unavailable. Connect or reconnect this portal in Settings.' },
  { status, headers: { 'Cache-Control': 'no-store' } });

/** No JSON-RPC parsing/buffering/replay: preserve real upstream streams and statuses. */
export async function forwardMcpPortal(request: Request, env: Env, props: McpPortalInterceptorProps | undefined,
  send: typeof fetch = fetch): Promise<Response> {
  if (!props?.bucket || props.operator || !Array.isArray(props.portals)) return denied(403, 'MCP_OWNER_REQUIRED');
  const url = new URL(request.url);
  const matches = props.portals.filter(p => new URL(p.url).href === url.href);
  if (url.protocol !== 'https:' || matches.length !== 1) return denied(403, 'MCP_DESTINATION_DENIED');
  const portal = matches[0]!;
  if (!(await getConfiguredMcpPortals(env.KV)).some(p => p.name === portal.name && p.url === portal.url)) return denied(403, 'MCP_CONFIGURATION_CHANGED');
  if (props.strict && !env.EGRESS) return denied(503, 'MCP_EGRESS_UNAVAILABLE');
  let token: string | null;
  try {
    const grant = await getMcpPortalGrant(env, props.bucket, portal);
    if (!grant) return denied(401, 'MCP_RECONNECT_REQUIRED');
    token = await getValidMcpPortalToken(env, props.bucket, portal, send);
  } catch { return denied(401, 'MCP_RECONNECT_REQUIRED'); }
  if (!token) return denied(401, 'MCP_RECONNECT_REQUIRED');
  const headers = new Headers();
  // Forward MCP transport context, never agent-asserted identity/credentials.
  for (const key of ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
    const value = request.headers.get(key);
    if (value !== null) headers.set(key, value);
  }
  headers.set('Authorization', `Bearer ${token}`);
  const upstream = props.strict ? env.EGRESS!.fetch.bind(env.EGRESS) : send;
  let response: Response;
  try {
    response = await upstream(new Request(request, { headers, redirect: 'manual' }));
  } catch { return denied(502, 'MCP_UPSTREAM_UNAVAILABLE'); }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return denied(502, 'MCP_REDIRECT_DENIED');
  }
  const returned = new Headers(response.headers);
  for (const header of ['set-cookie', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) returned.delete(header);
  // In particular, preserve portal-issued downstream authorization URLs and WWW-Authenticate context.
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: returned });
}
export class McpPortalInterceptor extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return forwardMcpPortal(request, this.env, (this.ctx as unknown as { props?: McpPortalInterceptorProps }).props);
  }
}
