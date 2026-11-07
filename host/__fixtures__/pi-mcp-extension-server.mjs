#!/usr/bin/env node
// Synthetic provider boundary: real extension, SDK and stdio transport stay intact.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const receipt = process.argv[2];
const record = event => appendFileSync(receipt, JSON.stringify(event) + '\n');
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const pending = new Map();
record({ event: 'started', pid: process.pid, ...(process.argv[3] === undefined ? {} : { literalMatches: process.env.CODEFLARE_SYNTHETIC_LITERAL === process.argv[3] }) });
const input = createInterface({ input: process.stdin });
input.on('close', () => { for (const { timers } of pending.values()) timers.forEach(clearTimeout); });
for await (const line of input) {
  const request = JSON.parse(line);
  record({ event: 'rpc', method: request.method });
  if (request.method === 'notifications/cancelled') {
    const operation = pending.get(request.params.requestId);
    record({ event: 'cancelled', operation: operation?.operation });
    for (const timer of operation?.timers ?? []) clearTimeout(timer);
    pending.delete(request.params.requestId);
    continue;
  }
  if (request.id === undefined) continue;
  switch (request.method) {
    case 'initialize':
      reply(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-consult', version: '1' } });
      break;
    case 'tools/list':
      reply(request.id, { tools: [{ name: 'consult_llm', description: 'Synthetic consult', inputSchema: { type: 'object', properties: { operation: { type: 'string' }, delayMs: { type: 'number' } }, required: ['operation'] } }] });
      break;
    case 'ping': reply(request.id, {}); break;
    case 'tools/call': {
      const { operation, delayMs = 0 } = request.params.arguments;
      record({ event: 'called', operation });
      if (operation === 'uncertain-mutation') {
        // Record the effect before losing the response. A replay would be observable.
        record({ event: 'mutated' });
        process.exit(0);
      }
      const timers = [];
      if (operation === 'progress') timers.push(setInterval(() => {
        if (request.params._meta?.progressToken !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: request.params._meta.progressToken, progress: 1 } }) + '\n');
      }, 25));
      timers.push(setTimeout(() => {
        timers.forEach(clearTimeout);
        pending.delete(request.id);
        reply(request.id, { content: [{ type: 'text', text: 'Fixture external answer' }] });
      }, delayMs));
      pending.set(request.id, { timers, operation });
      break;
    }
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown synthetic method' } }) + '\n');
  }
}
