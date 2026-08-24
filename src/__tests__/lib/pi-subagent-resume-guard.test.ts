import { describe, expect, it } from 'vitest';

import subagentResumeGuard, {
  registerSubagentResumeGuard,
  subagentResumeBlockReason,
  type SubagentRecordLookup,
} from '../../../preseed/agents/pi/extensions/subagent-resume-guard';

type ToolCallEvent = { toolName: string; input: unknown };
type ToolCallResult = { block: true; reason: string } | undefined;

function harness(lookup: SubagentRecordLookup) {
  let handler: ((event: ToolCallEvent) => ToolCallResult) | undefined;
  registerSubagentResumeGuard({
    on(event, candidate) {
      if (event === 'tool_call') {
        handler = (toolEvent) => candidate(toolEvent as never, {} as never) as ToolCallResult;
      }
    },
  }, lookup);
  if (!handler) throw new Error('tool_call guard was not registered');
  return handler;
}

describe('REQ-AGENT-159: active subagent resume guard', () => {
  it('loads as a side-effect-free extension when the package service is unavailable', () => {
    expect(subagentResumeGuard({ on() {} })).toBeUndefined();
  });

  it('captures service status during session_start before guarding later tool calls', async () => {
    let status = 'running';
    let sessionStart: (() => Promise<void>) | undefined;
    let toolCall: ((event: ToolCallEvent) => ToolCallResult) | undefined;
    subagentResumeGuard({
      on(event, candidate) {
        if (event === 'session_start') {
          sessionStart = async () => { await candidate({} as never, {} as never); };
        }
        if (event === 'tool_call') {
          toolCall = (toolEvent) => candidate(toolEvent as never, {} as never) as ToolCallResult;
        }
      },
    }, async () => ({ getRecord: (id) => ({ id, status }) }));
    if (!sessionStart || !toolCall) throw new Error('resume guard lifecycle handlers were not registered');

    await sessionStart();
    expect(toolCall({ toolName: 'subagent', input: { resume: 'agent-1' } })?.block).toBe(true);
    status = 'queued';
    expect(toolCall({ toolName: 'subagent', input: { resume: 'agent-1' } })?.block).toBe(true);
    status = 'completed';
    expect(toolCall({ toolName: 'subagent', input: { resume: 'agent-1' } })).toBeUndefined();
  });

  it.each(['queued', 'running'] as const)('blocks %s records before upstream resume execution', (status) => {
    const block = harness((id) => ({ id, status }))({
      toolName: 'subagent',
      input: { resume: 'agent-1', prompt: 'continue' },
    });

    expect(block).toEqual({
      block: true,
      reason: `Agent "agent-1" is ${status}. Use get_subagent_result for status or steer_subagent to redirect it; resume only a settled retained session.`,
    });
  });

  it.each(['completed', 'steered', 'aborted', 'stopped', 'error'] as const)('allows upstream resume handling for %s records', (status) => {
    expect(harness((id) => ({ id, status }))({
      toolName: 'subagent',
      input: { resume: 'agent-1', prompt: 'continue' },
    })).toBeUndefined();
  });

  it('allows upstream not-found handling for an unknown record', () => {
    expect(harness(() => undefined)({
      toolName: 'subagent',
      input: { resume: 'missing', prompt: 'continue' },
    })).toBeUndefined();
  });

  it('blocks resume when package status is unavailable instead of risking state mutation', () => {
    expect(subagentResumeBlockReason(
      { toolName: 'subagent', input: { resume: 'agent-1' } },
      undefined,
    )).toEqual(
      'Subagent status is unavailable. Use get_subagent_result before resuming a retained session.',
    );
  });

  it('does not affect new subagents, other tools, or malformed resume input', () => {
    const lookup: SubagentRecordLookup = () => {
      throw new Error('lookup must not run');
    };
    expect(subagentResumeBlockReason({ toolName: 'subagent', input: { prompt: 'new work' } }, lookup)).toBeUndefined();
    expect(subagentResumeBlockReason({ toolName: 'read', input: { resume: 'agent-1' } }, lookup)).toBeUndefined();
    expect(subagentResumeBlockReason({ toolName: 'subagent', input: { resume: '   ' } }, lookup)).toBeUndefined();
  });
});
