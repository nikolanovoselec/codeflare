#!/usr/bin/env node
/**
 * Measure Pi's complete first-turn input with its real resource loader and a
 * local faux provider. This includes the effective system prompt, active tool
 * schemas, and extension-provided per-turn context without a network request.
 *
 * Usage: node scripts/measure-pi-runtime-context.mjs [--agent-dir <path>] [--limit <tokens>]
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const agentDir = path.resolve(option('--agent-dir', path.join(homedir(), '.pi/agent')));
const limit = Number(option('--limit', '10000'));
const piRoot = process.env.PI_CODING_AGENT_ROOT
  ?? '/opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent';
const cwd = process.cwd();

const sdk = await import(pathToFileURL(path.join(piRoot, 'dist/index.js')));
const { createFauxCore, fauxAssistantMessage } = await import(pathToFileURL(
  path.join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/providers/faux.js'),
));

const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager });
await resourceLoader.reload();

const faux = createFauxCore({});
faux.setResponses([fauxAssistantMessage('ok')]);
const modelRuntime = {
  stream: faux.stream,
  streamSimple: faux.streamSimple,
  hasConfiguredAuth: () => true,
  getAuth: async () => ({ apiKey: 'faux' }),
};

const { session } = await sdk.createAgentSession({
  cwd,
  agentDir,
  model: faux.models[0],
  modelRuntime,
  resourceLoader,
  settingsManager,
  sessionManager: sdk.SessionManager.inMemory(cwd),
  thinkingLevel: 'off',
  sessionStartEvent: { type: 'session_start', reason: 'startup' },
});

await session.bindExtensions({ mode: 'interactive' });

let exitCode = 1;
try {
  await session.prompt('Reply ok.');
  const response = [...session.messages].reverse().find((message) => message.role === 'assistant');
  const inputTokens = response?.usage?.input;
  if (!Number.isFinite(inputTokens)) throw new Error('Faux provider did not report input usage.');
  const result = {
    inputTokens,
    limit,
    activeTools: session.getActiveToolNames(),
    systemPromptChars: session.systemPrompt.length,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  exitCode = inputTokens < limit ? 0 : 1;
} finally {
  session.dispose();
  process.exit(exitCode);
}
