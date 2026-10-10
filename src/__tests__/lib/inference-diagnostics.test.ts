import { afterEach, describe, expect, it, vi } from 'vitest';
import { inferenceDiagnostic, inferenceResponseObservation } from '../../lib/inference-diagnostics';
import { setLogLevel } from '../../lib/logger';

const frame = (toolCalls: unknown[]) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls } }] })}\n\n`;
const observe = (body: string) => inferenceResponseObservation({ body, contentType: 'text/event-stream' });
const capture = () => {
  const logs: string[] = [];
  setLogLevel('info');
  vi.spyOn(console, 'log').mockImplementation(value => { logs.push(String(value)); });
  return logs;
};
afterEach(() => { vi.restoreAllMocks(); setLogLevel('silent'); });

// Intentional closed diagnostic wire: shape only, never tool names, keys or values outside allowlists.
describe('REQ-OPERATOR-079: bounded response tool observations', () => {
  it('reconstructs fragmented SSE arguments and emits only allowlisted shape metadata', () => {
    const args = JSON.stringify({ target: { headSha: 'PRIVATE_SHA' }, comment: 'PRIVATE_COMMENT_🦊', claims: [],
      analysis: { configuration: 'PRIVATE_CONFIGURATION' }, PRIVATE_ARGUMENT_KEY: 'PRIVATE_VALUE' });
    const body = frame([{ index: 0, function: { name: 'decide_', arguments: args.slice(0, 31) } }])
      + frame([{ index: 0, function: { name: 'renovate', arguments: args.slice(31) } }])
      + 'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
    const observation = observe(body);
    expect(observation).toMatchObject({ toolCallCount: 1, toolArgumentBytes: new TextEncoder().encode(args).length,
      toolArgumentsObserved: true, toolArgumentsMalformed: false, toolArgumentFieldCount: 5, toolUnknownFieldCount: 1,
      toolRoles: ['decide'], toolArgumentFields: ['target', 'comment', 'claims', 'analysis'], sampled: false, doneObserved: true });
    const logs = capture();
    inferenceDiagnostic({ activityId: 'activity', generation: 1 }, { stage: 'response-commit', outcome: 'completed', ...observation });
    expect(JSON.parse(logs[0]).data).toMatchObject({ toolRoles: ['decide'], toolArgumentFieldCount: 5, toolUnknownFieldCount: 1 });
    expect(JSON.stringify(observation) + logs.join('')).not.toMatch(/PRIVATE_|decide_renovate/);
    expect(body).toContain('PRIVATE_COMMENT');
  });
  it.each(['{"comment":"PRIVATE_UNFINISHED', 'null', '[]'])('classifies malformed or non-object arguments without exposing their content: %s', args => {
    const observation = observe(frame([{ index: 0, function: { name: 'PRIVATE_TOOL_NAME', arguments: args } }]));
    expect(observation).toMatchObject({ toolCallCount: 1, toolRoles: ['unknown'], toolArgumentsObserved: true,
      toolArgumentsMalformed: true, toolArgumentFields: [], toolArgumentFieldCount: 0 });
    expect(JSON.stringify(observation)).not.toContain('PRIVATE_');
  });
  it('marks call-cap overflow sampled and does not claim complete argument shape', () => {
    const calls = Array.from({ length: 17 }, (_, index) => ({ index,
      function: { name: 'research_renovate', arguments: '{"url":"PRIVATE_URL"}' } }));
    const observation = observe(frame(calls));
    expect(observation).toMatchObject({ sampled: true, toolCallCount: 16, toolArgumentsObserved: false,
      toolArgumentFields: [], toolArgumentFieldCount: 0 });
    expect(JSON.stringify(observation)).not.toContain('PRIVATE_URL');
  });
  it.each(['bytes', 'lines'])('marks %s sampling without inventing complete argument observations', mode => {
    const prefix = mode === 'bytes' ? `:${'x'.repeat(65536)}\n` : ': keepalive\n'.repeat(257);
    const observation = observe(prefix + frame([{ index: 0, function: { name: 'comment_renovate', arguments: '{"target":"PRIVATE_TARGET"}' } }]));
    expect(observation).toMatchObject({ sampled: true, toolCallCount: 1, toolRoles: ['comment'], toolArgumentsObserved: false,
      toolArgumentFields: [], toolArgumentFieldCount: 0 });
    expect(JSON.stringify(observation)).not.toContain('PRIVATE_TARGET');
  });
  it('REQ-OPERATOR-078: the attempt diagnostic wire accepts only safe counters and closed outcomes', () => {
    const logs = capture();
    inferenceDiagnostic({ activityId: 'activity', generation: 1 }, { stage: 'inference-attempt', outcome: 'failed',
      inferenceAttempt: 2, inferenceAttemptLimit: 5, inferenceOutcome: 'retryable', operationCount: 9,
      prompt: 'PRIVATE_PROMPT', error: 'PRIVATE_ERROR' });
    expect(JSON.parse(logs[0]).data).toEqual({ schemaVersion: 1, activityId: 'activity', generation: 1,
      stage: 'inference-attempt', outcome: 'failed', inferenceAttempt: 2, inferenceAttemptLimit: 5,
      inferenceOutcome: 'retryable', operationCount: 9 });
    inferenceDiagnostic(undefined, { stage: 'inference-attempt', outcome: 'failed',
      inferenceAttempt: -1, inferenceAttemptLimit: Number.MAX_SAFE_INTEGER + 1, inferenceOutcome: 'PRIVATE_UNKNOWN' });
    expect(JSON.parse(logs[1]).data).toEqual({ schemaVersion: 1, stage: 'inference-attempt', outcome: 'failed' });
    expect(logs.join('')).not.toContain('PRIVATE_');
  });
  it('suppresses response-shape logs when the admitted logging setting is disabled', () => {
    const logs = capture();
    const observation = observe(frame([{ index: 0, function: { name: 'seal_dispatcher', arguments: '{}' } }]));
    inferenceDiagnostic({ activityId: 'activity', generation: 1, loggingEnabled: false }, { stage: 'response-commit', outcome: 'completed', ...observation });
    expect(logs).toEqual([]);
  });
});
