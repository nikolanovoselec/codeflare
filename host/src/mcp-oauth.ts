import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';

export interface McpOAuthContext {
  owner: string; session: string; generation: number; instance: string;
}
interface Launch {
  capability: string; process: string; terminal: object; ownerConnected: () => boolean; socket?: Duplex;
  pending?: { state: string; server: string; issuer: string; redirect: string; flow: string; expires: number; timer: ReturnType<typeof setTimeout> };
}
const valid = (v: unknown, max = 2048): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x20\x7f]/.test(v);
function https(value: unknown): value is string {
  if (!valid(value)) return false;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.hash; } catch { return false; }
}
function same(a: string, b: string): boolean {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

/** Ephemeral OAuth returns only. A launch is parent-issued and claimed once by a
 * live connection. The launcher passes a dedicated fd to exactly its Pi child;
 * neither a PID nor an inherited environment value is a callback recipient. */
export class McpOAuthReturns {
  private context?: McpOAuthContext;
  private readonly launches = new Set<Launch>();
  private readonly portals: readonly { name: string; url: string }[];
  constructor(portals: readonly { name: string; url: string }[] = []) {
    this.portals = portals.filter(p => /^[a-z][a-z0-9_-]{0,63}$/.test(p.name) && https(p.url));
  }
  private ready(launch: Launch): void {
    if (this.context) this.send(launch, { type: 'context', redirect: `${this.context.instance}/auth/mcp/callback`, portals: this.portals });
  }
  configure(value: unknown): boolean {
    const c = value as McpOAuthContext;
    if (!c || !valid(c.owner) || !valid(c.session, 128) || !Number.isSafeInteger(c.generation) || c.generation < 1
      || !https(c.instance) || new URL(c.instance).origin !== c.instance) return false;
    if (this.context && JSON.stringify(this.context) !== JSON.stringify(c)) {
      for (const launch of this.launches) { this.cancel(launch); this.send(launch, { type: 'inactive' }); }
    }
    this.context = { owner: c.owner, session: c.session, generation: c.generation, instance: c.instance };
    for (const launch of this.launches) this.ready(launch);
    return true;
  }
  issue(terminal: object, ownerConnected: () => boolean): { capability: string; revoke: () => void } {
    const launch: Launch = { terminal, ownerConnected, capability: randomBytes(32).toString('hex'), process: randomUUID() };
    this.launches.add(launch);
    return { capability: launch.capability, revoke: () => {
      this.cancel(launch); launch.socket?.destroy(); this.launches.delete(launch);
    } };
  }
  disconnect(terminal: object): void {
    for (const launch of this.launches) if (launch.terminal === terminal) {
      this.cancel(launch); this.send(launch, { type: 'inactive' });
    }
  }
  attach(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const launch = [...this.launches].find(l => l.capability && same(l.capability, supplied));
    if (!launch || launch.socket || head.length || req.method !== 'GET' || req.headers.upgrade !== 'codeflare-mcp-oauth') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    launch.capability = ''; // A disconnected launch cannot be reclaimed.
    launch.socket = socket;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: codeflare-mcp-oauth\r\n\r\n');
    this.ready(launch);
    if (!this.context) this.send(launch, { type: 'unavailable' });
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 16384) { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { this.message(launch, JSON.parse(line)); } catch { socket.destroy(); return; }
      }
    });
    socket.on('error', () => socket.destroy());
    socket.once('close', () => { this.cancel(launch); this.launches.delete(launch); });
  }
  private send(launch: Launch, value: object): void { if (launch.socket && !launch.socket.destroyed) launch.socket.write(JSON.stringify(value) + '\n'); }
  private cancel(launch: Launch): void {
    if (!launch.pending) return;
    const state = launch.pending.state;
    clearTimeout(launch.pending.timer); launch.pending = undefined;
    this.send(launch, { type: 'cancelled', state });
  }
  private message(launch: Launch, m: Record<string, unknown>): void {
    if (m.type === 'cancel') { this.cancel(launch); return; }
    if (m.type !== 'register' || !this.context || !launch.ownerConnected() || launch.pending || !valid(m.state, 128) || !/^[a-f0-9]{64}$/.test(m.state)
      || !valid(m.server, 128) || !https(m.issuer)
      || !this.portals.some(p => m.server === `codeflare-portal-${p.name}` && m.serverUrl === p.url)
      || m.redirect !== `${this.context.instance}/auth/mcp/callback`
      || [...this.launches].some(l => l.pending?.state === m.state)) throw new Error('OAuth return unavailable');
    launch.pending = { state: m.state, server: m.server, issuer: m.issuer, redirect: m.redirect as string,
      flow: randomUUID(), expires: Date.now() + 300000, timer: setTimeout(() => this.cancel(launch), 300000) };
    this.send(launch, { type: 'registered', state: m.state });
  }
  lookup(state: unknown): object | undefined {
    if (!valid(state, 128) || !this.context) return;
    for (const l of this.launches) {
      const p = l.pending;
      if (p && p.state === state && p.expires > Date.now() && l.ownerConnected() && l.socket && !l.socket.destroyed) {
        const { timer: _timer, ...pending } = p;
        return { ...this.context, ...pending, process: l.process };
      }
    }
  }
  deliver(value: unknown): boolean {
    const v = value as Record<string, unknown>;
    if (!v || (v.cancelled !== true && !valid(v.code, 8192))) return false;
    const binding = this.lookup(v.state) as Record<string, unknown> | undefined;
    if (!binding || Object.keys(binding).some(key => binding[key] !== v[key])) return false;
    const launch = [...this.launches].find(l => l.process === binding.process)!;
    if (v.cancelled === true) { this.cancel(launch); return true; }
    clearTimeout(launch.pending!.timer); launch.pending = undefined; // consume before delivery
    this.send(launch, { type: 'response', code: v.code, state: v.state });
    return true;
  }
  close(): void { for (const l of [...this.launches]) { this.cancel(l); l.socket?.destroy(); } this.launches.clear(); }
}
