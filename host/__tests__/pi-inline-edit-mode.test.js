import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INLINE_EDIT_COMMAND as BACKEND_INLINE_EDIT_COMMAND,
  INLINE_EDIT_TOOL as BACKEND_INLINE_EDIT_TOOL,
} from '../../openvscode/agent-sidebar/src/pi/node-rpc-backend.ts';
import registerInlineEditMode, {
  INLINE_EDIT_COMMAND,
  INLINE_EDIT_TOOL,
  encodeInlineEditCommandPayload,
} from '../../preseed/agents/pi/extensions/inline-edit.ts';

function fixture() {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  let activeTools = ['read', 'bash', 'edit', 'write', INLINE_EDIT_TOOL];
  const activeToolHistory = [];
  const sentUserMessages = [];
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(definition) { tools.set(definition.name, definition); },
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      handlers.set(event, [...existing, handler]);
    },
    getActiveTools() { return [...activeTools]; },
    sendUserMessage(message) { sentUserMessages.push(message); },
    setActiveTools(names) {
      activeTools = [...names];
      activeToolHistory.push([...names]);
    },
  };
  registerInlineEditMode(pi);
  return {
    commands,
    tools,
    activeToolHistory,
    activeTools: () => [...activeTools],
    sentUserMessages,
    async emit(event, payload = {}, context = {}) {
      let result;
      for (const handler of handlers.get(event) ?? []) {
        const next = await handler(payload, context);
        if (next !== undefined) result = next;
      }
      return result;
    },
  };
}

const proposal = {
  outcome: 'edit',
  summary: 'Replaced the function because the selected implementation was stale.',
  edits: [{
    startLine: 2,
    startCharacter: 1,
    endLine: 4,
    endCharacter: 3,
    newText: 'const answer = 42;\n',
  }],
};

test('REQ-IDE-025: inline result mode isolates provider tools and context then restores panel tools', async () => {
  assert.equal(INLINE_EDIT_COMMAND, BACKEND_INLINE_EDIT_COMMAND);
  assert.equal(INLINE_EDIT_TOOL, BACKEND_INLINE_EDIT_TOOL);
  const runtime = fixture();
  await runtime.emit('session_start');
  assert.deepEqual(runtime.activeTools(), ['read', 'bash', 'edit', 'write']);

  const command = runtime.commands.get(INLINE_EDIT_COMMAND);
  assert.ok(command);
  await command.handler(encodeInlineEditCommandPayload({
    requestId: 'inline-12345678',
    prompt: 'Replace the selected function.',
  }), {
    waitForIdle: async () => undefined,
  });

  assert.deepEqual(runtime.activeTools(), [INLINE_EDIT_TOOL]);
  assert.deepEqual(runtime.sentUserMessages, ['Replace the selected function.']);
  const tool = runtime.tools.get(INLINE_EDIT_TOOL);
  assert.ok(tool);
  assert.deepEqual(tool.parameters.properties.outcome.enum, ['edit', 'noChange']);
  assert.equal(tool.parameters.properties.requestId, undefined);
  const start = await runtime.emit('before_agent_start', { systemPrompt: 'base system canary' });
  assert.match(start.systemPrompt, new RegExp(INLINE_EDIT_TOOL));
  assert.doesNotMatch(start.systemPrompt, /base system canary|inline-12345678/);

  const priorPanelMessage = { role: 'assistant', content: 'panel-history-canary' };
  const currentInlineMessage = { role: 'user', content: 'Replace the selected function.' };
  const currentToolCall = { role: 'assistant', content: [{ type: 'toolCall', name: INLINE_EDIT_TOOL }] };
  const currentValidation = { role: 'toolResult', content: 'Correct the invalid edit geometry.' };
  assert.deepEqual(await runtime.emit('context', {
    messages: [priorPanelMessage, currentInlineMessage, currentToolCall, currentValidation],
  }), { messages: [currentInlineMessage, currentToolCall, currentValidation] });

  const providerPayload = {
    model: '@cf/moonshotai/kimi-k2.6',
    messages: [{ role: 'user', content: 'request' }],
    tools: [
      { type: 'function', function: { name: 'ask_user_question', parameters: {} } },
      { type: 'function', function: { name: INLINE_EDIT_TOOL, parameters: {} } },
    ],
    stream: true,
  };
  assert.deepEqual(await runtime.emit('before_provider_request', { payload: providerPayload }), {
    ...providerPayload,
    tools: [{ type: 'function', function: { name: INLINE_EDIT_TOOL, parameters: {} } }],
    tool_choice: { type: 'function', function: { name: INLINE_EDIT_TOOL } },
    parallel_tool_calls: false,
  });
  const unknownPayload = { input: [{ role: 'user', content: 'request' }] };
  assert.equal(await runtime.emit('before_provider_request', { payload: unknownPayload }), unknownPayload);

  assert.deepEqual(
    await runtime.emit('tool_call', { toolName: 'write', toolCallId: 'write-1', input: { path: '/tmp/x' } }),
    { block: true, reason: 'Native Inline Chat permits only the host-owned result tool' },
  );

  const result = await tool.execute('result-1', proposal);
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, {
    requestId: 'inline-12345678',
    outcome: 'edit',
    editCount: 1,
    summary: proposal.summary,
  });

  await runtime.emit('agent_settled');
  assert.deepEqual(runtime.activeTools(), ['read', 'bash', 'edit', 'write']);
});

test('REQ-IDE-030: inline results use host correlation and reject duplicates', async () => {
  const runtime = fixture();
  await runtime.emit('session_start');
  const command = runtime.commands.get(INLINE_EDIT_COMMAND);
  const tool = runtime.tools.get(INLINE_EDIT_TOOL);
  assert.ok(command);
  assert.ok(tool);

  await assert.rejects(tool.execute('result-stale', proposal), /active editor turn/i);
  await command.handler(encodeInlineEditCommandPayload({
    requestId: 'inline-12345678',
    prompt: 'Explain this code.',
  }), {
    waitForIdle: async () => undefined,
  });

  const noChange = {
    outcome: 'noChange',
    summary: 'The selected code already satisfies the request.',
    edits: [],
  };
  assert.deepEqual((await tool.execute('result-valid', noChange)).details, {
    requestId: 'inline-12345678',
    outcome: 'noChange',
    editCount: 0,
    summary: noChange.summary,
  });
  await assert.rejects(tool.execute('result-duplicate', noChange), /already submitted/i);

  await runtime.emit('agent_settled');
  assert.deepEqual(runtime.activeTools(), ['read', 'bash', 'edit', 'write']);
});
