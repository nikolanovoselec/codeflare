import { describe, expect, it } from 'vitest';

import { AGENTS_SEEDED_CONFIGS } from '../../lib/agent-seed.generated';
import reviewerToolGuard from '../../../preseed/agents/pi/extensions/review-tool-guard';

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown | Promise<unknown>;

function makeHarness() {
  const handlers = new Map<string, Handler[]>();
  reviewerToolGuard({
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as never);

  return {
    async emit(event: string, payload: Record<string, unknown>) {
      for (const handler of handlers.get(event) ?? []) {
        await handler(payload, {});
      }
    },
  };
}

describe('reviewer direct-execution guard', () => {
  it('REQ-AGENT-085: roots Bash-first fallback in the reviewer repository', async () => {
    const harness = makeHarness();
    const reviewerPrompt = AGENTS_SEEDED_CONFIGS.find((doc) =>
      doc.key === '.pi/agent/agents/code-reviewer.md',
    )?.content ?? '';
    await harness.emit('session_start', {});
    await harness.emit('before_agent_start', {
      systemPrompt: reviewerPrompt,
      prompt: 'You are reviewing the project.\nProject root: /home/user/workspace/codeflare\nreview_mode=report-only',
    });
    const input = { command: 'git status --short' };

    await harness.emit('tool_call', { toolName: 'bash', input });

    expect(input.command).toBe("cd '/home/user/workspace/codeflare' && git status --short");
  });

  it('REQ-AGENT-085: strips intent only from marked reviewer direct execution', async () => {
    const harness = makeHarness();
    const reviewerPrompts = ['code-reviewer', 'spec-reviewer', 'doc-updater'].map((reviewer) =>
      AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === `.pi/agent/agents/${reviewer}.md`)?.content ?? '',
    );

    for (const systemPrompt of reviewerPrompts) {
      await harness.emit('session_start', {});
      await harness.emit('before_agent_start', { systemPrompt });
      const input = { language: 'javascript', code: 'console.log("ok")', intent: 'index this output' };

      await harness.emit('tool_call', { toolName: 'ctx_execute', input });

      expect(input).toEqual({ language: 'javascript', code: 'console.log("ok")' });
    }

    const rootSystemPrompt = AGENTS_SEEDED_CONFIGS.find((doc) =>
      doc.key === '.pi/agent/AGENTS.md' && doc.modes.includes('advanced'),
    )?.content ?? '';
    await harness.emit('session_start', {});
    await harness.emit('before_agent_start', { systemPrompt: rootSystemPrompt });
    const rootInput = { language: 'javascript', code: 'console.log("ok")', intent: 'root-owned intent' };
    const bashInput = { command: 'printf ok', intent: 'unrelated field' };

    await harness.emit('tool_call', { toolName: 'ctx_execute', input: rootInput });
    await harness.emit('tool_call', { toolName: 'bash', input: bashInput });

    expect(rootInput.intent).toBe('root-owned intent');
    expect(bashInput.intent).toBe('unrelated field');
  });
});
