#!/usr/bin/env node
/**
 * Measure Pi's complete first-turn input with its real resource loader and a
 * local faux provider. This includes the effective system prompt, active tool
 * schemas, and extension-provided per-turn context without a network request.
 *
 * Usage: node scripts/measure-pi-runtime-context.mjs [--agent-dir <path>]
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const INITIAL_ACTIVE_TOOL_NAMES = ['read', 'bash', 'edit', 'write', 'capability'];

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function validateInitialToolExposure(report) {
  const active = report?.activeToolNames;
  const registered = report?.registeredToolNames;
  if (!Array.isArray(active) || active.length !== INITIAL_ACTIVE_TOOL_NAMES.length
    || active.some((name, index) => name !== INITIAL_ACTIVE_TOOL_NAMES[index])) {
    throw new Error(`initial active tools must be ${INITIAL_ACTIVE_TOOL_NAMES.join(', ')}`);
  }
  if (!Array.isArray(registered)
    || !registered.some((name) => typeof name === 'string' && !active.includes(name))) {
    throw new Error('registered optional tools must remain inactive');
  }
}

export async function main() {
  const agentDir = path.resolve(option('--agent-dir', path.join(homedir(), '.pi/agent')));
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

  try {
    await session.prompt('Reply ok.');
    const response = [...session.messages].reverse().find((message) => message.role === 'assistant');
    const inputTokens = response?.usage?.input;
    if (!Number.isFinite(inputTokens)) throw new Error('Faux provider did not report input usage.');
    const activeToolNames = session.getActiveToolNames();
    const active = new Set(activeToolNames);
    const toolSchemas = session.getAllTools()
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const serializedRegisteredSchemas = JSON.stringify(toolSchemas);
    const activeToolSchemas = toolSchemas.filter((tool) => active.has(tool.name));
    const serializedActiveSchemas = JSON.stringify(activeToolSchemas);
    const result = {
      inputTokens,
      systemPromptChars: session.systemPrompt.length,
      registeredToolNames: toolSchemas.map((tool) => tool.name),
      registeredToolSchemaChars: serializedRegisteredSchemas.length,
      activeToolNames,
      activeToolSchemaChars: serializedActiveSchemas.length,
      activeToolSchemas: activeToolSchemas.map((tool) => ({
        name: tool.name,
        serializedChars: JSON.stringify(tool).length,
      })),
    };
    validateInitialToolExposure(result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    session.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
