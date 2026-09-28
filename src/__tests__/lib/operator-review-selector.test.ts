import { describe, expect, it } from 'vitest';
import { registerOperatorReviewSelector } from '../../../preseed/agents/pi/extensions/operator-review-selector';

type Mode = 'local' | 'remote' | 'unavailable';
function harness(verdicts: Record<string, Mode>) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void> | void>>();
  const messages: string[] = [];
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
      handlers.set(event, [...handlers.get(event) ?? [], handler]);
      return () => { handlers.set(event, (handlers.get(event) ?? []).filter(item => item !== handler)); };
    },
    sendMessage: (message: { customType: string }) => { messages.push(message.customType); },
  };
  registerOperatorReviewSelector(pi as never, {
    local: (reviewPi: typeof pi) => {
      reviewPi.on('session_start', () => { messages.push('local-start'); });
      reviewPi.on('tool_call', () => { messages.push('local-call'); });
      reviewPi.on('tool_result', () => { messages.push('local-result'); });
    },
    remote: (reviewPi: typeof pi) => {
      reviewPi.on('session_start', () => { messages.push('remote-start'); });
      reviewPi.on('tool_call', () => { messages.push('remote-call'); });
      reviewPi.on('tool_result', () => { messages.push('remote-result'); });
    },
    applicability: async (_event: unknown, ctx: { target: string }) => verdicts[ctx.target] ?? 'unavailable',
  });
  return { messages, emit: async (type: string, target: string) => {
    for (const handler of handlers.get(type) ?? []) await handler({ type, input: { command: 'git push' } },
      { cwd: target, target, sessionManager: { getBranch: () => [] } });
  } };
}

describe('REQ-OPERATOR-053: exclusive local versus dedicated remote Review extensions', () => {
  it('runs only dedicated remote handlers for an authenticated applicable Action', async () => {
    const app = harness({ '/remote': 'remote' });
    await app.emit('session_start', '/remote');
    await app.emit('tool_call', '/remote');
    await app.emit('tool_result', '/remote');
    expect(app.messages).toEqual(['remote-start', 'remote-call', 'remote-result']);
  });
  it('retains unchanged local behavior only for confirmed absence or inactive enrollment', async () => {
    const app = harness({ '/local': 'local' });
    await app.emit('session_start', '/local');
    await app.emit('tool_call', '/local');
    await app.emit('tool_result', '/local');
    expect(app.messages).toEqual(['local-start', 'local-call', 'local-result']);
  });
  it('never falls back to local or runs both paths for a broken or ambiguous active Action', async () => {
    const app = harness({ '/uncertain': 'unavailable' });
    await app.emit('session_start', '/uncertain');
    await app.emit('tool_call', '/uncertain');
    await app.emit('tool_result', '/uncertain');
    expect(app.messages).not.toContain('local-result');
    expect(app.messages).not.toContain('remote-result');
    expect(app.messages).toContain('pr-boundary-remote-unavailable');
  });
  it('switches repositories in one Pi session without delivering the switched boundary to the prior path', async () => {
    const app = harness({ '/local': 'local', '/remote': 'remote', '/uncertain': 'unavailable' });
    await app.emit('session_start', '/local');
    await app.emit('tool_call', '/remote');
    await app.emit('tool_result', '/remote');
    await app.emit('tool_call', '/uncertain');
    await app.emit('tool_result', '/uncertain');
    await app.emit('tool_call', '/local');
    await app.emit('tool_result', '/local');
    expect(app.messages.filter(item => item.endsWith('-result'))).toEqual(['remote-result', 'local-result']);
    expect(app.messages.filter(item => item.endsWith('-call'))).toEqual(['remote-call', 'local-call']);
  });
});
