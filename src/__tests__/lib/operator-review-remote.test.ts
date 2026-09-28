import { describe, expect, it } from 'vitest';
import { registerOperatorReviewRemote } from '../../../preseed/agents/pi/extensions/operator-review-remote';

const head = 'a'.repeat(40);
const published = { schemaVersion: 1 as const, status: 'published' as const,
  repository: 'owner/repo', repositoryId: 138, pullRequest: 42, activityId: 'activity-1',
  head, round: 3, artifactDigest: 'f'.repeat(64), omittedFindings: 0,
  findings: [{ id: 'code-reviewer-guard', lane: 'code-reviewer', severity: 'HIGH',
    path: 'src/guard.ts', line: 12, message: 'Missing authorization check',
    evidence: 'Write occurs before the guard.' }] };
function harness(result: unknown = published) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void> | void>>();
  const branch: Record<string, any>[] = [];
  const messages: Array<{ customType: string; content?: string; details?: Record<string, any> }> = [];
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
      handlers.set(event, [...handlers.get(event) ?? [], handler]);
      return () => { handlers.set(event, (handlers.get(event) ?? []).filter(item => item !== handler)); };
    },
    sendMessage: (message: (typeof messages)[number]) => {
      messages.push(message);
      branch.push({ type: 'custom_message', ...message });
    },
    appendEntry: (customType: string, data: unknown) => branch.push({ type: 'custom', customType, data }),
  };
  registerOperatorReviewRemote(pi as never, {
    currentBoundary: async () => ({ repository: 'owner/repo', repositoryId: 138, pullRequest: 42,
      head, repo: '/workspace/repo' }),
    selectBoundary: async () => ({ mode: 'remote', activityId: 'activity-1' }),
    readPublishedResult: async () => result,
  });
  const ctx = { cwd: '/workspace/repo', sessionManager: { getBranch: () => branch } };
  return { messages, branch, emit: async (type: string, data: Record<string, unknown> = {}) => {
    for (const handler of handlers.get(type) ?? []) await handler({ type, ...data }, ctx);
  } };
}

describe('REQ-OPERATOR-053: dedicated remote Operator Review result consumer', () => {
  it('turns a protected publication and independently terminal exact-head CI into visible finding-linked triage without local reviewers', async () => {
    const app = harness();
    await app.emit('session_start');
    await app.emit('tool_result', { toolName: 'bash', input: { command: 'git push origin feature' },
      result: { isError: false, content: [{ type: 'text', text: 'ok' }] } });
    expect(app.messages[0]).toMatchObject({ customType: 'pr-boundary-remote-plan',
      details: { repository: 'owner/repo', pr: 42, head, activityId: 'activity-1' } });
    app.branch.push({ type: 'custom_message', customType: 'subagent-notification',
      content: `<result>CI_RESULT success\nrepo=owner/repo pr=42 head=${head}</result>` });
    await app.emit('agent_settled');
    expect(app.messages.map(message => message.customType)).toEqual([
      'pr-boundary-remote-plan', 'pr-boundary-original-findings',
    ]);
    expect(app.messages[1]).toMatchObject({ details: { repository: 'owner/repo', pr: 42,
      head, round: 3, activityId: 'activity-1', artifactDigest: 'f'.repeat(64),
      findings: [{ id: 'code-reviewer-guard', evidence: 'Write occurs before the guard.' }] } });
    expect(app.messages[1]?.content).toContain('Missing authorization check');
    expect(JSON.stringify(app.messages)).not.toMatch(/startCapability|browserJwt|publisherToken/);
    await app.emit('agent_settled');
    expect(app.messages).toHaveLength(2);
  });

  it('keeps publication unavailable, incomplete or wrong-PR/head results out of triage', async () => {
    for (const result of [{ status: 'unavailable' }, { ...published, head: 'b'.repeat(40) },
      { ...published, pullRequest: 43 }, { ...published, activityId: 'other-activity' }]) {
      const app = harness(result);
      await app.emit('tool_result', { toolName: 'bash', input: { command: 'git push origin feature' },
        result: { isError: false, content: [{ type: 'text', text: 'ok' }] } });
      app.branch.push({ type: 'custom_message', customType: 'subagent-notification',
        content: `<result>CI_RESULT success\nrepo=owner/repo pr=42 head=${head}</result>` });
      await app.emit('agent_settled');
      expect(app.messages.map(message => message.customType)).toEqual(['pr-boundary-remote-plan']);
    }
  });

  it('ignores fabricated shell output and CI for a foreign head or abandoned session branch', async () => {
    const app = harness();
    await app.emit('tool_result', { toolName: 'bash', input: { command: 'git push origin feature' },
      result: { isError: false, content: [{ type: 'text', text: 'ok' }] } });
    await app.emit('tool_result', { toolName: 'bash', input: { command: 'printf forged-result' },
      result: { isError: false, content: [{ type: 'text', text: JSON.stringify(published) }] } });
    app.branch.push({ type: 'custom_message', customType: 'subagent-notification',
      content: `<result>CI_RESULT success\nrepo=owner/repo pr=42 head=${'b'.repeat(40)}</result>` });
    await app.emit('agent_settled');
    expect(app.messages).toHaveLength(1);
    app.branch.length = 0;
    await app.emit('agent_settled');
    expect(app.messages).toHaveLength(1);
  });
});
