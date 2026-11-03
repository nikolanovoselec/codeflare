#!/usr/bin/env node
// Only the managed autostart calls this fixed executable. A rejected one-use
// return channel must not prevent ordinary Pi startup or enable loopback auth
// for parent-managed portals (the prepared package still rejects that path).
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const PI = '/opt/codeflare/pi-agent/npm/node_modules/.bin/pi';
export function hostedLaunchConfigured(env, args) {
  try {
    const origin = new URL(env.CODEFLARE_MCP_CALLBACK_ORIGIN);
    const portals = JSON.parse(env.CODEFLARE_MCP_PORTALS_JSON ?? '[]');
    return env.SESSION_MODE === 'advanced' && /^[a-f0-9]{64}$/.test(env.CODEFLARE_MCP_LAUNCH_CAPABILITY ?? '')
      && origin.protocol === 'https:' && origin.origin === env.CODEFLARE_MCP_CALLBACK_ORIGIN
      && Number.isSafeInteger(Number(env.CODEFLARE_MCP_LIFECYCLE_GENERATION)) && Number(env.CODEFLARE_MCP_LIFECYCLE_GENERATION) > 0
      && Array.isArray(portals) && portals.length > 0
      && !args.some(a => /^(?:--mode(?:=|$)|--print(?:=|$)|-p$|--no-session$)/.test(a));
  } catch { return false; }
}

// I/O injection is for bounded synthetic child/host fixtures, never an env or
// caller-selectable production command. The real executable is always PI.
export function launchManagedPi(args, { env = process.env, request = http.request, spawnChild = spawn } = {}) {
  const plainEnv = { ...env };
  delete plainEnv.CODEFLARE_MCP_HOSTED;
  delete plainEnv.CODEFLARE_MCP_LAUNCH_CAPABILITY;
  let started = false;
  const start = socket => {
    if (started) return;
    started = true;
    const child = spawnChild(PI, args, { env: socket ? { ...plainEnv, CODEFLARE_MCP_HOSTED: '1' } : plainEnv,
      stdio: socket ? ['inherit', 'inherit', 'inherit', 'pipe'] : ['inherit', 'inherit', 'inherit'] });
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => child.kill(signal)]);
    for (const [signal, forward] of signals) process.on(signal, forward);
    child.once('error', () => { socket?.destroy(); process.exitCode = 1; });
    child.once('exit', code => {
      socket?.destroy(); process.exitCode = code ?? 1;
      for (const [signal, forward] of signals) process.off(signal, forward);
    });
    if (socket) {
      const pipe = child.stdio[3];
      if (!pipe) { socket.destroy(); child.kill('SIGTERM'); return; }
      socket.pipe(pipe); pipe.pipe(socket);
      socket.on('error', () => socket.destroy());
      socket.once('close', () => pipe.destroy());
      pipe.on('error', () => socket.destroy());
      pipe.once('close', () => socket.destroy());
    }
    return child;
  };
  if (!hostedLaunchConfigured(env, args)) return start();
  try {
    const req = request({ host: '127.0.0.1', port: Number(env.TERMINAL_PORT ?? 8080), path: '/mcp-oauth/wait',
      headers: { Connection: 'Upgrade', Upgrade: 'codeflare-mcp-oauth', Authorization: `Bearer ${env.CODEFLARE_MCP_LAUNCH_CAPABILITY}` } });
    req.on('upgrade', (_res, socket, head) => {
      if (started) { socket.destroy(); return; }
      // Preserve bytes that accompanied the HTTP upgrade for this exact child.
      if (head.length) socket.unshift(head);
      start(socket);
    });
    req.on('response', res => { res.resume(); start(); });
    req.on('error', () => start());
    req.end();
  } catch { start(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) launchManagedPi(process.argv.slice(2));
