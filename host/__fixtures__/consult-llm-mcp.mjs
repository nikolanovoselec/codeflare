#!/usr/bin/env node
// External MCP service fixture. The adapter, SDK client, stdio transport and
// lifecycle remain real; this process replaces only consult's provider service.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const receipt = process.env.CODEFLARE_Q17_RECEIPT;
appendFileSync(receipt, JSON.stringify({ event: 'started', phase: process.env.CODEFLARE_Q17_PHASE }) + '\n');
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case 'initialize':
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'consult-llm-fixture', version: '1.0.0' } };
      break;
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      result = { tools: [{ name: 'consult_llm', description: 'Consult an external LLM', inputSchema: {
        type: 'object', properties: { prompt: { type: 'string' }, model: { type: 'string' }, task_mode: { type: 'string' } }, required: ['prompt', 'model'],
      } }] };
      break;
    case 'tools/call':
      if (request.params.name !== 'consult_llm') throw new Error('Unexpected fixture tool');
      appendFileSync(receipt, JSON.stringify({ event: 'consulted', arguments: request.params.arguments, configuredCredential: process.env.OPENAI_API_KEY === 'synthetic-openai' }) + '\n');
      result = { content: [{ type: 'text', text: 'Fixture external answer: compare the stated alternatives.' }] };
      break;
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
      continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
