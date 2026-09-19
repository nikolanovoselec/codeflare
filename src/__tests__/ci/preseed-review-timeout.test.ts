import { describe, expect, it } from 'vitest';
import { reviewTranscriptFacts } from '../../../preseed/agents/pi/extensions/review-helpers';

const head = 'a'.repeat(40);
const ciCallId = 'ci-call';
const entries = [
  { type: 'custom_message', customType: 'pr-boundary-launch-plan', details: {
    head, reviewRange: 'base..head', repo: '/repo', prNumber: 1138, base: 'develop',
    boundaryToolUseId: 'push-call', ciEvent: 'push', requiredLanes: [],
  } },
  { type: 'message', message: { role: 'toolResult', toolCallId: ciCallId, toolName: 'subagent', isError: false,
    details: { agentId: 'ci-agent' } } },
  { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: ciCallId, name: 'subagent', arguments: {
    subagent_type: 'ci-monitor', run_in_background: true, inherit_context: false,
    prompt: JSON.stringify({ repo: 'nikolanovoselec/codeflare', pr: 1138, head, cwd: '/repo' }),
  } }] } },
  { type: 'custom', customType: 'task-notification', data: { toolUseId: ciCallId, succeeded: true, text: 'Command timed out after 120 seconds' } },
] as Record<string, unknown>[];

describe('preseed review timeout follow-up', () => {
  it('treats a correlated native CI-monitor timeout as terminal timeout evidence', () => {
    const facts = reviewTranscriptFacts({ sessionFile: '/missing', entries, requiredLanes: [], ci: {
      repository: 'nikolanovoselec/codeflare', repo: '/repo', prNumber: 1138, head,
    }, reviewHead: head, activeBoundaryToolUseId: 'push-call' });
    expect(facts.ciTerminal).toBe(true);
    expect(facts.ciResult).toBe('timeout');
  });
});
