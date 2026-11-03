#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROFILE = {
  'package.json': '569a7ebea0d140e36a6fc4c81115f4a9922a63229b1880c2c8511efc28744578',
  'src/server-manager.ts': '7b5aee290b94a3e05914008813487d9342bf28fb6263c5b5853a9ddcc238caaf',
  'src/index.ts': '57e7536c337faa073945fd64b1efbae0e597698c783bd41283c16fa5fd1a6cdd',
  'src/authorize-flow.ts': 'cc838b6a13d7d7e76b2e113c075c4d12e6b7dee6aed925b3498e8c9244b28992',
  'src/register-commands.ts': '56078d89e272cd31d5b45e01e8b0bd2965b82c88518f8fdee1908a0b4c2ef571',
  'src/config.ts': 'b7f0c3373d8ac70ddf5119454c99225cd7aa5604497ccf11ad3c5d7b738643b1',
  'src/oauth-provider.ts': 'ebddca05af46d10c848ab640179cd45eeb9daa20cf7a4a6fdcf1235f0d7752c7',
  'src/callback-server.ts': 'c0e090a3447893d2a610ece33d10c3f129402a38b60c6e2981fc2390c3cda88d',
  'src/connection-coordinator.ts': 'c12fff0b4d90550b33a894f182f4881741a4e2d8bf03ed6bceb7dc88c64b8848',
};
const fail = () => { throw new Error('Hosted MCP preparation rejected incompatible inputs'); };
const digest = value => createHash('sha256').update(value).digest('hex');
const HELPER = `// Image-prepared OAuth boundary; the upstream extension remains the sole MCP owner.
let events: { emit(name: string, data: unknown): void } | undefined;
const owners = new WeakMap<object, string>();
export class HostedOwnerAuthRequired extends Error {}
export function bindHostedOAuth(bus: typeof events) { events = bus; }
export function assertHostedConfig(serverName: string, config: any) {
  if (!serverName.startsWith('codeflare-portal-')) return;
  let portals: any;
  try { portals = JSON.parse(process.env.CODEFLARE_MCP_PORTALS_JSON ?? '[]'); } catch {}
  const portal = Array.isArray(portals) && portals.find(p => serverName === 'codeflare-portal-' + p.name);
  if (!portal || config.url !== portal.url || !portal.url.startsWith('https:') || config.command || config.headers
    || config.lifecycle !== 'lazy' || config.transport !== 'streamable-http' || config.auth?.type !== 'oauth' || Object.keys(config.auth).some(k => k !== 'type')) {
    throw new Error('Managed MCP portal configuration does not match its parent configuration.');
  }
}
export async function withHostedOwner<T>(ctx: object, server: string, run: () => Promise<T>): Promise<T> {
  owners.set(ctx, server);
  try { return await run(); } finally { owners.delete(ctx); }
}
export async function hostedAuthorization(serverName: string, ctx: any, signal: AbortSignal, config: any): Promise<any> {
  if (!serverName.startsWith('codeflare-portal-')) return undefined;
  if (process.env.CODEFLARE_MCP_HOSTED !== '1' || !ctx.hasUI || ctx.mode !== 'tui' || owners.get(ctx) !== serverName || signal.aborted) {
    throw new HostedOwnerAuthRequired('Hosted MCP authorization requires owner /mcp:auth in a managed interactive session.');
  }
  let result: unknown;
  events?.emit('codeflare:mcp-hosted-oauth', { serverName, config, ctx, signal, resolve(value: unknown) { result = value; } });
  if (!result) throw new Error('Hosted MCP authorization companion unavailable.');
  return await result;
}
`;

const EDITS = {
  'src/index.ts': [
    ['import { registerCommands } from "./register-commands.js";', 'import { registerCommands } from "./register-commands.js";\nimport { bindHostedOAuth, HostedOwnerAuthRequired } from "./codeflare-hosted-oauth.js";'],
    ['function formatMcpAuthError(err: unknown, hasUI: boolean): string | undefined {', 'function formatMcpAuthError(err: unknown, hasUI: boolean): string | undefined {\n  if (err instanceof HostedOwnerAuthRequired) return "Hosted MCP authorization requires owner /mcp:auth in the managed interactive session.";'],
    ['export default async function (pi: ExtensionAPI, paths: { bootstrapCwd?: string; globalConfigPath?: string; authStorageDir?: string; browserOpen?: (url: string) => void | Promise<void>; callbackServer?: CallbackServer } = {}): Promise<void> {', 'export default async function (pi: ExtensionAPI, paths: { bootstrapCwd?: string; globalConfigPath?: string; authStorageDir?: string; browserOpen?: (url: string) => void | Promise<void>; callbackServer?: CallbackServer } = {}): Promise<void> {\n  bindHostedOAuth(pi.events);'],
  ],
  'src/server-manager.ts': [
    ['import { McpError, AuthCancelledError } from "./errors.js";', 'import { McpError, AuthCancelledError } from "./errors.js";\nimport { assertHostedConfig } from "./codeflare-hosted-oauth.js";'],
    ['    this._updateServerCwd(server, cwd);\n    if (server.attempt', '    assertHostedConfig(name, server.config);\n    this._updateServerCwd(server, cwd);\n    if (server.attempt'],
  ],
  'src/register-commands.ts': [
    ['import type { Client } from "@modelcontextprotocol/sdk/client/index.js";', 'import type { Client } from "@modelcontextprotocol/sdk/client/index.js";\nimport { withHostedOwner } from "./codeflare-hosted-oauth.js";'],
    ['await coordinator.connect(name, ctx, { reset });', 'await withHostedOwner(ctx, name, () => coordinator.connect(name, ctx, { reset }));'],
  ],
  'src/authorize-flow.ts': [
    ['import { spawn } from "node:child_process";', 'import { spawn } from "node:child_process";\nimport { hostedAuthorization } from "./codeflare-hosted-oauth.js";'],
    ['interface RedirectAuthFlowParams {', 'interface RedirectAuthFlowParams {\n  hosted?: boolean;'],
    ['  const code = await waitForOAuthCallback(', '  const code = params.hosted ? await callbackPromise : await waitForOAuthCallback('],
    ['  const config = resolveAuthorizeConfig(deps, serverName);\n  const callbackServer = deps.callbackServer ?? new CallbackServer();\n  const browserOpener = deps.openBrowser ?? openBrowser;',
     '  const config = resolveAuthorizeConfig(deps, serverName);\n  const hosted = await hostedAuthorization(serverName, ctx, signal, config);\n  signal = hosted?.signal ?? signal;\n  // Reuse the original dependency slots; no second initializer or provider.\n  deps = hosted ? { ...deps, callbackServer: hosted.callbackServer, openBrowser: hosted.openBrowser } : deps;\n  const callbackServer = deps.callbackServer ?? new CallbackServer();\n  const browserOpener = deps.openBrowser ?? openBrowser;'],
    ['    const boundRedirectUrl = config.auth?.redirectUrl ?? `http://127.0.0.1:${port}/callback`;', '    const boundRedirectUrl = hosted?.redirectUrl ?? config.auth?.redirectUrl ?? `http://127.0.0.1:${port}/callback`;'],
    ['    const launchAuthorizationBrowser = createAuthorizationBrowserLauncher({', '    const launchAuthorizationBrowser = hosted ? (url: URL) => hosted.openBrowser(url.toString()) : createAuthorizationBrowserLauncher({'],
    ['      onAuthRequired: launchAuthorizationBrowser,', '      onAuthRequired: hosted ? async (url: URL) => hosted.openBrowser(url.toString(), await authProvider.discoveryState()) : launchAuthorizationBrowser,'],
    ['      await completeRedirectAuthFlow({\n', '      await completeRedirectAuthFlow({\n        hosted: Boolean(hosted),\n'],
  ],
};
function transform(source, edits, reverse = false) {
  for (const [before, after] of reverse ? [...edits].reverse() : edits) {
    const from = reverse ? after : before, to = reverse ? before : after;
    if (source.split(from).length !== 2) fail();
    source = source.replace(from, to);
  }
  return source;
}
function regular(path) { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink()) fail(); }

/** Only called against a build/CI candidate, before warming or runtime import.
 * All source identities and the COMPLETE output are checked before mutation. */
export function prepareHostedOAuth(root, { selectedManifest, selectedLock, companionPath } = {}) {
  try {
    root = resolve(root);
    if (root.includes('/.pi/agent/') || lstatSync(root).isSymbolicLink()) fail();
    const sourceDirectory = lstatSync(join(root, 'src'));
    if (!sourceDirectory.isDirectory() || sourceDirectory.isSymbolicLink()) fail();
    for (const path of [join(root, 'package.json'), selectedManifest, selectedLock, companionPath]) regular(path);
    const installed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const selected = JSON.parse(readFileSync(selectedManifest, 'utf8'));
    const lock = JSON.parse(readFileSync(selectedLock, 'utf8'));
    const version = selected.dependencies['pi-mcp-extension'];
    // A reviewed source profile, not an upgrade pin. Candidate updates must add
    // their verified profile and pass the same real-provider qualification.
    if (version !== '1.12.1' || installed.name !== 'pi-mcp-extension' || installed.version !== version
      || lock.packages['node_modules/pi-mcp-extension'].version !== version) fail();
    const companion = readFileSync(companionPath, 'utf8');
    if (digest(companion) !== COMPANION_SHA256) fail();
    const helperPath = join(root, 'src/codeflare-hosted-oauth.ts');
    const prepared = existsSync(helperPath);
    if (prepared) { regular(helperPath); if (readFileSync(helperPath, 'utf8') !== HELPER) fail(); }
    const outputs = new Map();
    for (const [file, hash] of Object.entries(PROFILE)) {
      regular(join(root, file));
      const current = readFileSync(join(root, file), 'utf8');
      const original = prepared && EDITS[file] ? transform(current, EDITS[file], true) : current;
      if (digest(original) !== hash) fail();
      const output = EDITS[file] ? transform(original, EDITS[file]) : original;
      if (prepared && output !== current) fail();
      if (file.startsWith('src/')) outputs.set(file, output);
    }
    if (prepared) return { prepared: true, changed: false };
    // Publish the complete prepared src tree, never a partially patched runnable
    // entry point. Restore the original on any failed rename.
    const staging = mkdtempSync(join(root, '.hosted-oauth-'));
    const backup = join(staging, 'original');
    try {
      cpSync(join(root, 'src'), join(staging, 'src'), { recursive: true });
      for (const [file, output] of outputs) writeFileSync(join(staging, file), output);
      writeFileSync(join(staging, 'src/codeflare-hosted-oauth.ts'), HELPER);
      renameSync(join(root, 'src'), backup);
      try { renameSync(join(staging, 'src'), join(root, 'src')); }
      catch (error) { renameSync(backup, join(root, 'src')); throw error; }
    } finally { rmSync(staging, { recursive: true, force: true }); }
    return { prepared: true, changed: true };
  } catch { fail(); }
}

const COMPANION_SHA256 = '0adfbf9745fc02362f879489f074d4ecc47f38cd1e905ef58b2ed113146f859b';
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  prepareHostedOAuth(process.argv[2], {
    selectedManifest: process.argv[3] ?? join(repo, 'preseed/agents/pi/package.json'),
    selectedLock: process.argv[4] ?? join(repo, 'preseed/agents/pi/package-lock.json'),
    companionPath: process.argv[5] ?? join(repo, 'preseed/agents/pi/extensions/mcp-portal-oauth.ts'),
  });
}
