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
  requestId: 'inline-12345678',
  edits: [{
    startLine: 2,
    startCharacter: 1,
    endLine: 4,
    endCharacter: 3,
    newText: 'const answer = 42;\n',
  }],
};

test('REQ-IDE-025: inline edit mode exposes only one proposal tool and restores unrestricted panel tools', async () => {
  assert.equal(INLINE_EDIT_COMMAND, BACKEND_INLINE_EDIT_COMMAND);
  assert.equal(INLINE_EDIT_TOOL, BACKEND_INLINE_EDIT_TOOL);
  const runtime = fixture();
  await runtime.emit('session_start');
  assert.deepEqual(runtime.activeTools(), ['read', 'bash', 'edit', 'write']);

  const command = runtime.commands.get(INLINE_EDIT_COMMAND);
  assert.ok(command);
  await command.handler(encodeInlineEditCommandPayload({
    requestId: proposal.requestId,
    prompt: 'Replace the selected function.',
  }), {
    waitForIdle: async () => undefined,
  });

  assert.deepEqual(runtime.activeTools(), [INLINE_EDIT_TOOL]);
  assert.deepEqual(runtime.sentUserMessages, ['Replace the selected function.']);
  const start = await runtime.emit('before_agent_start', { systemPrompt: 'base system' });
  assert.match(start.systemPrompt, new RegExp(proposal.requestId));
  assert.match(start.systemPrompt, new RegExp(INLINE_EDIT_TOOL));
  assert.deepEqual(
    await runtime.emit('tool_call', { toolName: 'write', toolCallId: 'write-1', input: { path: '/tmp/x' } }),
    { block: true, reason: 'Native Inline Chat permits only host-owned edit proposals' },
  );

  const tool = runtime.tools.get(INLINE_EDIT_TOOL);
  assert.ok(tool);
  const result = await tool.execute('proposal-1', proposal);
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, { requestId: proposal.requestId, editCount: 1 });

  await runtime.emit('agent_settled');
  assert.deepEqual(runtime.activeTools(), ['read', 'bash', 'edit', 'write']);
});

test('REQ-IDE-026: inline edit mode rejects stale or duplicate proposals before restoration', async () => {
  const runtime = fixture();
  await runtime.emit('session_start');
  const command = runtime.commands.get(INLINE_EDIT_COMMAND);
  const tool = runtime.tools.get(INLINE_EDIT_TOOL);
  assert.ok(command);
  assert.ok(tool);

  await command.handler(encodeInlineEditCommandPayload({
    requestId: proposal.requestId,
    prompt: 'Generate code here.',
  }), {
    waitForIdle: async () => undefined,
  });

  await assert.rejects(
    tool.execute('proposal-stale', { ...proposal, requestId: 'inline-stale00' }),
    /request correlation/i,
  );
  await tool.execute('proposal-valid', proposal);
  await assert.rejects(tool.execute('proposal-duplicate', proposal), /already submitted/i);

  await runtime.emit('agent_settled');
  assert.deepEqual(runtime.activeTools(), ['read', 'bash', 'edit', 'write']);
});
