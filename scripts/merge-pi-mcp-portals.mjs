import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ownershipKey = '_codeflareMcpPortals';
const serverKey = (name) => `codeflare-portal-${name}`;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Image-owned standalone script: same credential-free boundary as Administration.
function validate(portals) {
  if (!Array.isArray(portals)) throw new Error('Invalid MCP portal list');
  const names = new Set();
  const destinations = new Set();
  for (const portal of portals) {
    if (!object(portal) || Object.keys(portal).sort().join(',') !== 'name,url'
      || typeof portal.name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(portal.name)
      || names.has(portal.name) || typeof portal.url !== 'string' || portal.url.length > 512
      || !/^https:\/\//i.test(portal.url) || /[\s\u0000-\u001f\u007f]/.test(portal.url)
      || portal.url.split('/')[2]?.includes('@')) throw new Error('Invalid MCP portal configuration');
    let url;
    try { url = new URL(portal.url); } catch { throw new Error('Invalid MCP portal URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || portal.url.includes('#')
      || (url.port && url.port !== '443') || !url.hostname.includes('.')
      || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal') || url.hostname.endsWith('.localhost')
      || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')
      || [...url.searchParams].some(([key, value]) => key !== 'codemode' || value !== 'search_and_execute')
      || url.searchParams.getAll('codemode').length > 1) throw new Error('Invalid MCP portal URL');
    if (destinations.has(url.href)) throw new Error('MCP destinations must be unique');
    destinations.add(url.href);
    names.add(portal.name);
  }
  return portals;
}

/** Pure reconciliation; the explicit previous list, never a prefix match, proves ownership. */
export function mergePiMcpPortals(config, portals) {
  validate(portals);
  if (!object(config) || (config.mcpServers !== undefined && !object(config.mcpServers))) throw new Error('Invalid MCP configuration');
  const previous = config[ownershipKey] === undefined ? [] : validate(config[ownershipKey]);
  const servers = { ...config.mcpServers };
  if (Object.values(servers).some((server) => !object(server))) throw new Error('Invalid MCP server configuration');
  const previousNames = new Set(previous.map(({ name }) => serverKey(name)));
  for (const portal of previous) {
    const server = servers[serverKey(portal.name)];
    if (server !== undefined && (!object(server) || server.url !== portal.url
      || !Object.keys(server).every(key => ['url', 'transport', 'type', 'headers', 'auth', 'lifecycle',
        'idleTimeout', 'requestTimeoutMs', 'directTools', 'httpTransport', 'protocolVersion'].includes(key))
      || !['lazy', 'eager'].includes(server.lifecycle)
      || !(object(server.auth) && server.auth.type === 'oauth'
        || (server.auth === undefined || server.auth === false) && object(server.headers) && server.headers.Authorization === 'Bearer codeflare-mcp-portal')
      || server.command !== undefined || (server.transport !== undefined && server.transport !== 'streamable-http'))) {
      throw new Error('Managed MCP portal registration was changed; leaving configuration unchanged');
    }
  }
  for (const portal of portals) {
    const key = serverKey(portal.name);
    if (Object.hasOwn(servers, key) && !previousNames.has(key)) throw new Error('MCP portal name collision; leaving configuration unchanged');
  }
  const nextNames = new Set(portals.map(({ name }) => serverKey(name)));
  for (const key of previousNames) if (!nextNames.has(key)) delete servers[key];
  for (const portal of portals) {
    const key = serverKey(portal.name);
    servers[key] = { url: portal.url,
      headers: { Authorization: 'Bearer codeflare-mcp-portal' }, auth: false,
      lifecycle: 'lazy', idleTimeout: 10, requestTimeoutMs: 360000, directTools: 'search' };
  }
  return { ...config, mcpServers: servers, [ownershipKey]: portals.map(({ name, url }) => ({ name, url })) };
}

/** Called only after migration. No network, OAuth storage, legacy config, or running process access. */
export function configurePiMcpPortals({ configPath, portalsJson = '[]', sessionMode, configReady }) {
  if (!['default', 'advanced'].includes(sessionMode) || configReady !== '1') return false;
  const portals = validate(JSON.parse(portalsJson));
  let original;
  let mode = 0o600;
  try { original = readFileSync(configPath, 'utf8'); mode = statSync(configPath).mode & 0o777; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const next = mergePiMcpPortals(original === undefined ? {} : JSON.parse(original), portals);
  const output = JSON.stringify(next, null, 2) + '\n';
  if (output === original) return true;
  mkdirSync(dirname(configPath), { recursive: true });
  const temporary = `${configPath}.codeflare-portals-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, output, { mode, flag: 'wx' });
    renameSync(temporary, configPath);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      try { unlinkSync(temporary); } catch { /* Preserve the original write failure. */ }
    }
    throw error;
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2]) throw new Error('Missing MCP config path');
    configurePiMcpPortals({ configPath: process.argv[2], portalsJson: process.env.CODEFLARE_MCP_PORTALS_JSON ?? '[]', sessionMode: process.env.SESSION_MODE, configReady: process.env.PI_MCP_CONFIG_READY });
  } catch {
    console.error('[entrypoint] WARNING: MCP portal configuration was not applied; configuration left unchanged.');
    process.exitCode = 1;
  }
}
