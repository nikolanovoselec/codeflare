import { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

type Config = { url?: string; auth?: { type?: string } };
type Context = { redirect: string; portals: { name: string; url: string }[] };
const unavailable = () => new Error('Hosted MCP authorization unavailable; use /mcp:auth in the managed owner session.');

/** The transport carries OAuth returns only; it is never an MCP client, token
 * store, tool, transcript message or general RPC endpoint. */
export function createHostedOAuthAdapter(channel: Duplex) {
  let context: Context | undefined;
  let closed = false;
  let generation = 0;
  let active: AbortController | undefined;
  let activeTimer: ReturnType<typeof setTimeout> | undefined;
  let buffer = '';
  let readyResolve!: () => void;
  const ready = new Promise<void>(resolve => { readyResolve = resolve; });
  let pending: { state: string; resolve: (code: string) => void; reject: (e: Error) => void;
    registered: () => void; rejectRegistration: (e: Error) => void } | undefined;
  const send = (value: object) => { if (closed) throw unavailable(); channel.write(JSON.stringify(value) + '\n'); };
  const cancel = () => {
    generation += 1;
    active?.abort();
    if (activeTimer) clearTimeout(activeTimer);
    activeTimer = undefined;
    const old = pending; pending = undefined;
    old?.reject(unavailable()); old?.rejectRegistration(unavailable());
    if (!closed) send({ type: 'cancel' });
  };
  const close = () => { closed = true; readyResolve(); cancel(); };
  channel.on('error', close);
  channel.on('close', close);
  channel.on('data', chunk => {
    buffer += chunk.toString();
    if (Buffer.byteLength(buffer) > 16384) { channel.destroy(); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const m = JSON.parse(line);
        if (m.type === 'context') {
          if (context && JSON.stringify(context) !== JSON.stringify({ redirect: m.redirect, portals: m.portals })) cancel();
          const u = new URL(m.redirect);
          if (u.protocol !== 'https:' || u.pathname !== '/auth/mcp/callback' || u.search || u.hash || u.username || u.password || !Array.isArray(m.portals)) throw unavailable();
          context = { redirect: m.redirect, portals: m.portals }; readyResolve();
        } else if (m.type === 'inactive') {
          cancel();
        } else if (m.type === 'cancelled') {
          if (pending?.state === m.state) {
            const old = pending; pending = undefined; old.reject(unavailable()); old.rejectRegistration(unavailable());
          }
        } else if (m.type === 'registered') {
          if (pending?.state === m.state) pending.registered();
        } else if (m.type === 'response' && typeof m.code === 'string') {
          if (pending?.state === m.state) { const old = pending; pending = undefined; old.resolve(m.code); }
        } else throw unavailable();
      } catch { channel.destroy(); }
    }
  });
  return {
    cancel,
    close() { cancel(); channel.destroy(); },
    async begin(serverName: string, config: Config, ctx: ExtensionContext, signal: AbortSignal) {
      await ready;
      if (closed || signal.aborted || !context || pending || active) throw unavailable();
      const portal = context.portals.find(p => serverName === `codeflare-portal-${p.name}`);
      if (!portal || config.url !== portal.url || config.auth?.type !== 'oauth') throw unavailable();
      const redirectUrl = context.redirect;
      const currentGeneration = generation;
      const parentSignal = signal;
      const controller = new AbortController();
      active = controller;
      signal = AbortSignal.any([parentSignal, controller.signal]);
      const timeout = setTimeout(() => cancel(), 300000);
      activeTimer = timeout;
      timeout.unref?.();
      let registration: Promise<void> | undefined;
      const abort = () => cancel();
      parentSignal.addEventListener('abort', abort, { once: true });
      return {
        redirectUrl,
        signal,
        callbackServer: {
          async ensure() { return 0; },
          waitForCallback(state: string) {
            if (closed || generation !== currentGeneration || pending || signal.aborted || !/^[a-f0-9]{64}$/.test(state)) throw unavailable();
            let registered!: () => void, rejectRegistration!: (e: Error) => void;
            registration = new Promise<void>((resolve, reject) => { registered = resolve; rejectRegistration = reject; });
            void registration.catch(() => undefined);
            return new Promise<string>((resolve, reject) => { pending = { state, resolve, reject, registered, rejectRegistration }; });
          },
          cancel,
          async stop() {
            parentSignal.removeEventListener('abort', abort); clearTimeout(timeout); cancel();
            if (active === controller) active = undefined;
          },
        },
        async openBrowser(value: string, discovery: { authorizationServerMetadata?: { issuer: string; authorization_endpoint: string } }) {
          const url = new URL(value), state = url.searchParams.get('state');
          // The original SDK validated discovery. Bind the exact issuer and
          // authorization endpoint, including legitimate cross-origin issuers.
          const metadata = discovery?.authorizationServerMetadata;
          if (!metadata) throw unavailable();
          const issuer = new URL(metadata.issuer), endpoint = new URL(metadata.authorization_endpoint);
          if (closed || generation !== currentGeneration || !pending || state !== pending.state || signal.aborted || issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.hash
            || endpoint.protocol !== 'https:' || url.origin !== endpoint.origin || url.pathname !== endpoint.pathname
            || url.searchParams.get('redirect_uri') !== redirectUrl || url.searchParams.get('code_challenge_method') !== 'S256') throw unavailable();
          send({ type: 'register', state, server: serverName, serverUrl: portal.url, issuer: metadata.issuer, redirect: redirectUrl });
          await registration;
          if (signal.aborted || closed || generation !== currentGeneration) throw unavailable();
          ctx.ui.notify(`pi-mcp: Authorize ${serverName}: ${url.toString()}`, 'info');
        },
      };
    },
  };
}

const processChannel = Symbol.for('codeflare.mcp-oauth.owner-return');
export function mcpPortalOAuth(pi: ExtensionAPI, channel?: Duplex) {
  const shared = globalThis as unknown as Record<symbol, ReturnType<typeof createHostedOAuthAdapter> | undefined>;
  let adapter: ReturnType<typeof createHostedOAuthAdapter> | undefined;
  pi.events.on('codeflare:mcp-hosted-oauth', (value: unknown) => {
    const request = value as { serverName: string; config: Config; ctx: ExtensionContext; signal: AbortSignal;
      resolve: (value: unknown) => void };
    // The prepared package admits only its explicit /mcp:auth command context.
    // Public events are an in-process handoff, never tenant/owner authority.
    request.resolve((async () => {
      if (process.env.CODEFLARE_MCP_HOSTED !== '1') throw unavailable();
      if (!adapter) {
        if (channel) adapter = createHostedOAuthAdapter(channel);
        else {
          // Pi 1.5 replaces the extension runtime on new/resume/fork/reload,
          // not its managed process. Retain that same private fd, cancel flows.
          if (!shared[processChannel]) {
            const socket = new Socket({ fd: 3, readable: true, writable: true });
            socket.unref();
            shared[processChannel] = createHostedOAuthAdapter(socket);
          }
          adapter = shared[processChannel];
        }
      }
      if (!adapter) throw unavailable();
      return adapter.begin(request.serverName, request.config, request.ctx, request.signal);
    })());
  });
  for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree'] as const) {
    pi.on(event, () => adapter?.cancel());
  }
  pi.on('session_shutdown', event => {
    adapter?.cancel();
    if (event.reason === 'quit') {
      adapter?.close();
      if (!channel) delete shared[processChannel];
      adapter = undefined;
    }
  });
}
export default mcpPortalOAuth;
