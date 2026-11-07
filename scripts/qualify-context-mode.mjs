#!/usr/bin/env node
// Image-only acceptance of the real lock-installed v2 CLI, SQLite and MCP tools.
// No registry access, setup, upgrade, provider or user data is involved.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

const directory = await mkdtemp(join(tmpdir(), 'context-mode-image-'));
const child = spawn(process.execPath, [join(resolve(process.argv[2]), 'cli.mjs'), 'server', '--agent', 'claude-code'], {
  cwd: directory,
  env: { ...process.env, HOME: directory, CLAUDE_PROJECT_DIR: directory,
    CONTEXT_MODE_DATA_DIR: join(directory, 'data'), CLAUDE_CODE_SESSION_ID: 'image-smoke' },
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: true, // Own the CLI + server process group; never leave a helper behind.
});
child.stdin.on('error', () => {}); // Early server exit is reported by the request deadline/diagnostics.
let sequence = 0;
let buffer = '';
let diagnostics = '';
const pending = new Map();
let terminalError;
function failPending(error) {
  terminalError = error;
  for (const receive of pending.values()) receive({ error: { message: error.message } });
  pending.clear();
}
child.on('error', failPending);
child.on('exit', (code, signal) => failPending(new Error(`server exited (${code ?? signal}): ${diagnostics}`)));

child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-4096); });
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try {
      const message = JSON.parse(line);
      const receiver = pending.get(message.id);
      if (receiver) { pending.delete(message.id); receiver(message); }
    } catch { /* Non-protocol stdout cannot satisfy the acceptance request. */ }
  }
});
async function request(method, params) {
  if (terminalError) throw terminalError;
  const id = ++sequence;
  let timeout;
  try {
    return await new Promise((accept, reject) => {
      timeout = setTimeout(() => reject(new Error(`${method} timed out: ${diagnostics}`)), 15000);
      pending.set(id, (message) => message.error ? reject(new Error(JSON.stringify(message.error))) : accept(message.result));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  } finally { clearTimeout(timeout); pending.delete(id); }
}
try {
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'codeflare-image-smoke', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await request('tools/list', {});
  const names = new Set(listed.tools.map((tool) => tool.name));
  for (const name of ['ctx_execute', 'ctx_batch', 'ctx_index', 'ctx_search']) assert.ok(names.has(name), `${name} unavailable`);
  const marker = 'codeflare_context_mode_image_marker';
  const executed = await request('tools/call', { name: 'ctx_execute', arguments: { language: 'shell', code: `printf ${marker}` } });
  assert.notEqual(executed.isError, true, JSON.stringify(executed));
  assert.ok(JSON.stringify(executed.content).includes(marker), 'shell result missing');
  const indexed = await request('tools/call', { name: 'ctx_index', arguments: { content: marker + ' SQLite acceptance', source: 'image-smoke' } });
  assert.notEqual(indexed.isError, true, JSON.stringify(indexed));
  const found = await request('tools/call', { name: 'ctx_search', arguments: { queries: [marker] } });
  assert.notEqual(found.isError, true, JSON.stringify(found));
  assert.ok(JSON.stringify(found.content).includes(marker), 'SQLite search did not recover indexed content');
  console.log('context-mode: CLI MCP handshake, shell execution and SQLite index/search accepted');
} finally {
  const killGroup = (signal) => {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const exited = child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve();
  const killTimer = setTimeout(() => killGroup('SIGKILL'), 2000);
  try {
    killGroup('SIGTERM');
    await exited;
  } finally {
    killGroup('SIGKILL'); // Also reap a server that outlived its CLI parent.
    clearTimeout(killTimer);
  }
  await rm(directory, { recursive: true, force: true });
}
