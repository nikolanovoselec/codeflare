import { z } from 'zod';
import { SETUP_KEYS } from './kv-keys';

/** Shared Worker policy for portal and OAuth control destinations. No network I/O. */
export function publicHttps(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')
    || !url.hostname.includes('.') || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')
    || url.hostname.endsWith('.localhost') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) {
    throw new Error('Invalid MCP OAuth HTTPS destination');
  }
  return url;
}

// Only the documented non-credential query is accepted. Never fetch an endpoint here.
const portalSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  url: z.string().max(512).refine((value) => {
    if (!/^https:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/.test(value) || value.split('/')[2]?.includes('@')) return false;
    try {
      const url = publicHttps(value);
      return !value.includes('#')
        && Array.from(url.searchParams).every(([key, val]) => key === 'codemode' && val === 'search_and_execute')
        && url.searchParams.getAll('codemode').length <= 1;
    } catch { return false; }
  }),
}).strict();
const portalsSchema = z.array(portalSchema).superRefine((portals, context) => {
  if (new Set(portals.map((portal) => portal.name)).size !== portals.length
    || new Set(portals.map(portal => { try { return new URL(portal.url).href; } catch { return portal.url; } })).size !== portals.length) {
    context.addIssue({ code: 'custom', message: 'Portal names and destinations must be unique.' });
  }
});

export type McpPortal = z.infer<typeof portalSchema>;

export function validateMcpPortals(value: unknown): McpPortal[] {
  const parsed = portalsSchema.safeParse(value);
  if (!parsed.success) throw new Error('Use unique names (lowercase letter, then letters, digits, _ or -, up to 64 characters) and public HTTPS URLs on the standard port without credentials or fragments. IP addresses and private-suffix hosts are unsupported. Only ?codemode=search_and_execute is supported. URLs may contain at most 512 characters.');
  return parsed.data;
}

export async function getConfiguredMcpPortals(kv: KVNamespace): Promise<McpPortal[]> {
  const raw = await kv.get(SETUP_KEYS.MCP_PORTALS);
  return raw === null ? [] : validateMcpPortals(JSON.parse(raw));
}
