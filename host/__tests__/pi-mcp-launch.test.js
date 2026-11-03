import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpOAuthReturns } from '../src/mcp-oauth.ts';
import { launchManagedPi } from '../../image/herdr/codeflare-pi-mcp-launch.mjs';

const configured = { SESSION_MODE: 'advanced', CODEFLARE_MCP_CALLBACK_ORIGIN: 'https://instance.example',
  CODEFLARE_MCP_LIFECYCLE_GENERATION: '1', CODEFLARE_MCP_PORTALS_JSON: JSON.stringify([{ name: 'fixture', url: 'https://portal.example/mcp' }]) };
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-launch-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const returns = new McpOAuthReturns([{ name: 'fixture', url: 'https://portal.example/mcp' }]);
  returns.configure({ owner: 'owner', session: 'abcdefgh', generation: 1, instance: 'https://instance.example' });
  const lease = returns.issue({}, () => true);
  const server = http.createServer((_req, res) => { res.writeHead(401); res.end(); });
  server.on('upgrade', (req, socket, head) => returns.attach(req, socket, head));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { returns.close(); server.close(); });
  return { dir, lease, port: server.address().port };
}
async function launch(f, extra = {}, args = ['--session-id', '11111111-1111-4111-a111-111111111111']) {
  const receipt = join(f.dir, 'receipt.jsonl');
  let complete;
  const exited = new Promise(resolve => { complete = resolve; });
  const childSource = `const fs=require('node:fs'); const row={executable:process.env.FIXED_PI,args:process.argv.slice(1),hosted:process.env.CODEFLARE_MCP_HOSTED,capability:process.env.CODEFLARE_MCP_LAUNCH_CAPABILITY};
const done=(data)=>{row.returnContext=data;fs.appendFileSync(process.env.RECEIPT,JSON.stringify(row)+'\\n');process.exit(0)};
if(row.hosted==='1'){const s=new(require('node:net').Socket)({fd:3,readable:true,writable:true});s.once('data',b=>done(JSON.parse(b.toString().trim()).redirect));}else done();`;
  launchManagedPi(args, { env: { ...process.env, ...configured, CODEFLARE_MCP_LAUNCH_CAPABILITY: f.lease.capability,
    CODEFLARE_MCP_HOSTED: 'inherited-stale', TERMINAL_PORT: String(f.port), ...extra },
    spawnChild(executable, childArgs, options) {
      // Real bounded synthetic child, never Pi/SDK. Record the production spawn
      // boundary contract along with recipient-visible args/environment/fd data.
      const child = spawn(process.execPath, ['-e', childSource, '--', ...childArgs], {
        env: { ...options.env, FIXED_PI: executable, RECEIPT: receipt }, stdio: options.stdio.map(v => v === 'inherit' ? 'ignore' : v),
      });
      child.once('exit', code => complete(code)); return child;
    },
  });
  assert.equal(await exited, 0);
  const rows = readFileSync(receipt, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1, 'a failed channel must not launch duplicate Pi children');
  assert.equal(rows[0].executable, '/opt/codeflare/pi-agent/npm/node_modules/.bin/pi');
  assert.deepEqual(rows[0].args, args);
  return rows[0];
}

test('REQ-AGENT-226: managed Pi launch preserves exact args and delivers only its private fd context', async t => {
  const f = await fixture(t), row = await launch(f);
  assert.equal(row.hosted, '1'); assert.equal(row.capability, undefined);
  assert.equal(row.returnContext, 'https://instance.example/auth/mcp/callback');
});
for (const [name, env] of Object.entries({ 'missing capability': { CODEFLARE_MCP_LAUNCH_CAPABILITY: '' },
  'missing origin': { CODEFLARE_MCP_CALLBACK_ORIGIN: '' }, 'invalid generation': { CODEFLARE_MCP_LIFECYCLE_GENERATION: '0' },
  'empty portals': { CODEFLARE_MCP_PORTALS_JSON: '[]' }, 'ordinary mode': { SESSION_MODE: 'default' },
  'rejected capability': { CODEFLARE_MCP_LAUNCH_CAPABILITY: 'f'.repeat(64) }, 'unreachable host': { TERMINAL_PORT: '0' } })) {
  test(`REQ-AGENT-226: ${name} preserves ordinary Pi startup without hosted authority`, async t => {
    const f = await fixture(t), row = await launch(f, env);
    assert.equal(row.hosted, undefined); assert.equal(row.capability, undefined); assert.equal(row.returnContext, undefined);
  });
}
test('REQ-AGENT-226: consumed capability cannot bind another pane but preserves ordinary startup', async t => {
  const f = await fixture(t);
  const request = http.request({ host: '127.0.0.1', port: f.port, path: '/mcp-oauth/wait',
    headers: { Connection: 'Upgrade', Upgrade: 'codeflare-mcp-oauth', Authorization: `Bearer ${f.lease.capability}` } });
  const upgraded = once(request, 'upgrade'); request.end(); const [, socket] = await upgraded;
  t.after(() => socket.destroy());
  const row = await launch(f); assert.equal(row.hosted, undefined); assert.equal(row.capability, undefined);
});
