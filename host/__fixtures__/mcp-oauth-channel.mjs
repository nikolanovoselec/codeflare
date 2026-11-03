import { Duplex } from 'node:stream';
import { McpOAuthReturns } from '../src/mcp-oauth.ts';

export function channelFixture({ portals = [{ name: 'fixture', url: 'https://portal.example/mcp?codemode=search_and_execute' }], generation = 1, owner = 'owner', session = 'abcdefgh', instance = 'https://instance.example' } = {}) {
  const host = new McpOAuthReturns(portals);
  host.configure({ owner, session, generation, instance });
  let connected = true;
  const terminal = {};
  const launch = host.issue(terminal, () => connected);
  let left, right;
  left = new Duplex({ read() {}, write(chunk, _encoding, done) { queueMicrotask(() => { if (!right.destroyed) right.push(Buffer.from(chunk)); done(); }); } });
  right = new Duplex({ read() {}, write(chunk, _encoding, done) { queueMicrotask(() => { if (!left.destroyed) left.push(Buffer.from(chunk)); done(); }); } });
  const channel = new Duplex({ read() {}, write(chunk, _encoding, done) { left.write(chunk, done); } });
  let handshake = '';
  let upgraded = false;
  left.on('data', chunk => {
    if (upgraded) { channel.push(chunk); return; }
    handshake += chunk.toString();
    const end = handshake.indexOf('\r\n\r\n');
    if (end >= 0) { upgraded = true; const rest = handshake.slice(end + 4); if (rest) channel.push(Buffer.from(rest)); }
  });
  for (const side of [left, right, channel]) side.on('error', () => {});
  right.once('close', () => { left.destroy(); channel.destroy(); });
  channel.once('close', () => { left.destroy(); right.destroy(); });
  host.attach({ method: 'GET', headers: { upgrade: 'codeflare-mcp-oauth', authorization: `Bearer ${launch.capability}` } }, right, Buffer.alloc(0));
  return { host, channel, launch, terminal,
    disconnect() { connected = false; host.disconnect(terminal); },
    close() { host.close(); channel.destroy(); },
  };
}
