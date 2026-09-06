import assert from 'node:assert/strict';
import { test } from 'node:test';
import finalizeToolExposure from '../../preseed/agents/pi/extensions/zz-tool-exposure-finalizer.ts';

function fixture() {
  const handlers = new Map();
  const executed = [];
  let active = ['read', 'bash', 'edit', 'write', 'capability', 'goal_wait'];
  const pi = {
    getActiveTools: () => [...active],
    getAllTools: () => active.map((name) => ({ name })),
    setActiveTools: (names) => { active = [...names]; },
    on: (name, handler) => { handlers.set(name, handler); },
  };
  finalizeToolExposure(pi, () => 'after-first-goal');
  return {
    pi,
    executed,
    async call(toolName) {
      const result = await handlers.get('tool_call')?.({
        type: 'tool_call', toolCallId: 'call-1', toolName, input: {},
      }, {});
      if (!result?.block) executed.push(toolName);
      return result;
    },
    start: () => handlers.get('before_agent_start')?.({}, {}),
  };
}

test('REQ-AGENT-191 AC7: blocks goal_wait execution including after reactivation', async () => {
  const runtime = fixture();
  assert.equal((await runtime.call('goal_wait'))?.block, true);
  runtime.start();
  assert.equal(runtime.pi.getActiveTools().includes('goal_wait'), false);
  runtime.pi.setActiveTools([...runtime.pi.getActiveTools(), 'goal_wait']);
  assert.equal(runtime.pi.getActiveTools().includes('goal_wait'), true);
  const result = await runtime.call('goal_wait');
  assert.equal(result?.block, true);
  assert.match(result.reason, /goal_wait.*disabled/i);
  assert.deepEqual(runtime.executed, []);
});

test('REQ-AGENT-191 AC7: preserves execution of all other tools', async () => {
  const runtime = fixture();
  const tools = ['read', 'bash', 'edit', 'write', 'capability', 'goal_complete',
    'goal_blocked', 'plan_mode_question', 'plan_mode_complete', 'subagent',
    'graphify_query', 'codeflare_submit_inline_result', 'custom_tool'];
  for (const name of tools) assert.equal(await runtime.call(name), undefined);
  assert.deepEqual(runtime.executed, tools);
});
