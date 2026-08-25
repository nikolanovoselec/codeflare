import { describe, expect, it } from 'vitest';

import capabilityExtension from '../../../preseed/agents/pi/extensions/capability';
import toolExposureFinalizer from '../../../preseed/agents/pi/extensions/zz-tool-exposure-finalizer';
import capabilityHelpersExtension, {
  activateRegisteredTools,
  activationGroup,
  initialActiveTools,
  searchCapabilities,
  type ToolActivationPi,
} from '../../../preseed/agents/pi/extensions/capability-helpers';

type CapabilityTool = {
  name: string;
  description: string;
  execute(id: string, params: { query?: string; name?: string }): Promise<unknown>;
};

type CapabilitySessionContext = {
  sessionManager?: {
    getBranch?(): Array<{ type?: string; customType?: string; data?: unknown }>;
    getEntries?(): Array<{ type?: string; customType?: string; data?: unknown }>;
  };
};

function fakePi(input?: {
  active?: string[];
  tools?: Array<{ name: string; description: string }>;
}): ToolActivationPi & { history: string[][] } {
  let active = [...(input?.active ?? ['read', 'bash'])];
  const tools = input?.tools ?? [
    { name: 'read', description: 'Read files' },
    { name: 'bash', description: 'Run shell commands' },
    { name: 'edit', description: 'Edit files' },
    { name: 'write', description: 'Write files' },
    { name: 'capability', description: 'Search tools' },
    { name: 'ask_user_question', description: 'Ask a structured question' },
    { name: 'subagent', description: 'Launch a background specialist' },
    { name: 'get_subagent_result', description: 'Check a background specialist' },
    { name: 'steer_subagent', description: 'Steer a background specialist' },
    { name: 'graphify_query', description: 'Query the code graph' },
  ];
  const history: string[][] = [];
  return {
    history,
    getActiveTools: () => [...active],
    getAllTools: () => tools.map((tool) => ({ ...tool })),
    setActiveTools: (names) => {
      active = [...names];
      history.push([...names]);
    },
  };
}

describe('REQ-AGENT-096: registered Pi tool discovery and activation', () => {
  it('loads the helper module as a side-effect-free standalone extension', () => {
    expect(capabilityHelpersExtension()).toBeUndefined();
  });

  it('exposes startup, search, and activation through Pi public APIs', async () => {
    const base = fakePi({
      active: ['read', 'subagent'],
      tools: [
        { name: 'read', description: 'Read files' },
        { name: 'bash', description: 'Run shell commands' },
        { name: 'edit', description: 'Edit files' },
        { name: 'write', description: 'Write files' },
        { name: 'graphify_query', description: 'Query the code graph' },
        { name: 'subagent', description: 'Launch a background specialist' },
        { name: 'get_subagent_result', description: 'Check a background specialist' },
        { name: 'steer_subagent', description: 'Steer a background specialist' },
      ],
    });
    const registered = new Map<string, CapabilityTool>();
    const handlers = new Map<string, (event: unknown, ctx: CapabilitySessionContext) => void>();
    const pi = {
      ...base,
      getAllTools: () => [
        ...base.getAllTools(),
        ...Array.from(registered.values(), ({ name, description }) => ({ name, description })),
      ],
      registerTool(tool: unknown) {
        const candidate = tool as CapabilityTool;
        registered.set(candidate.name, candidate);
      },
      on(event: string, handler: (event: unknown, ctx: CapabilitySessionContext) => void) {
        handlers.set(event, handler);
      },
    };

    capabilityExtension(pi);
    toolExposureFinalizer(pi);
    handlers.get('before_agent_start')?.({}, {});

    expect(pi.getActiveTools()).toEqual(['read', 'bash', 'edit', 'write', 'capability']);
    const capability = registered.get('capability');
    if (!capability) throw new Error('capability tool was not registered');

    expect(await capability.execute('search', { query: 'background specialist' })).toEqual({
      content: [{
        type: 'text',
        text: 'get_subagent_result — Check a background specialist\nsteer_subagent — Steer a background specialist\nsubagent — Launch a background specialist',
      }],
      details: {
        matches: [
          {
            kind: 'tool',
            name: 'get_subagent_result',
            description: 'Check a background specialist',
          },
          {
            kind: 'tool',
            name: 'steer_subagent',
            description: 'Steer a background specialist',
          },
          {
            kind: 'tool',
            name: 'subagent',
            description: 'Launch a background specialist',
          },
        ],
      },
    });
    expect(await capability.execute('activate', { name: 'subagent' })).toEqual({
      content: [{
        type: 'text',
        text: 'Loaded tools: subagent, get_subagent_result, steer_subagent. Use get_subagent_result or steer_subagent while an agent is queued or running; resume only a settled retained session.',
      }],
      details: {
        name: 'subagent',
        added: ['subagent', 'get_subagent_result', 'steer_subagent'],
      },
    });
    expect(pi.getActiveTools()).toEqual([
      'read',
      'bash',
      'edit',
      'write',
      'capability',
      'subagent',
      'get_subagent_result',
      'steer_subagent',
    ]);

    handlers.get('before_agent_start')?.({}, {});
    expect(pi.getActiveTools()).toEqual(['read', 'bash', 'edit', 'write', 'capability']);
  });

  it('REQ-AGENT-111: restores terminal Goal tools only for an unfinished session Goal', () => {
    const base = fakePi({
      active: ['read'],
      tools: [
        { name: 'read', description: 'Read files' },
        { name: 'bash', description: 'Run shell commands' },
        { name: 'goal_complete', description: 'Complete Goal' },
        { name: 'goal_blocked', description: 'Block Goal' },
      ],
    });
    const handlers = new Map<string, (event: unknown, ctx: CapabilitySessionContext) => void>();
    const pi = {
      ...base,
      registerTool() {},
      on(event: string, handler: (event: unknown, ctx: CapabilitySessionContext) => void) {
        handlers.set(event, handler);
      },
    };
    capabilityExtension(pi);
    toolExposureFinalizer(pi);
    const session = (status: string | null) => ({
      sessionManager: {
        getBranch: () => [{
          type: 'custom',
          customType: 'goal-state',
          data: { goal: status === null ? null : { id: 'goal-1', status } },
        }],
      },
    });

    handlers.get('before_agent_start')?.({}, session('paused'));
    expect(pi.getActiveTools()).toEqual(['read', 'bash', 'goal_complete', 'goal_blocked']);
  });

  it('REQ-AGENT-111: preserves Goal tools already active under the always-visible policy', () => {
    const base = fakePi({
      active: ['read', 'goal_complete', 'goal_blocked'],
      tools: [
        { name: 'read', description: 'Read files' },
        { name: 'bash', description: 'Run shell commands' },
        { name: 'goal_complete', description: 'Complete Goal' },
        { name: 'goal_blocked', description: 'Block Goal' },
      ],
    });
    const handlers = new Map<string, (event: unknown, ctx: CapabilitySessionContext) => void>();
    const pi = {
      ...base,
      registerTool() {},
      on(event: string, handler: (event: unknown, ctx: CapabilitySessionContext) => void) {
        handlers.set(event, handler);
      },
    };
    capabilityExtension(pi);
    toolExposureFinalizer(pi);

    handlers.get('before_agent_start')?.({}, {
      sessionManager: { getBranch: () => [] },
    });

    expect(pi.getActiveTools()).toEqual(['read', 'bash', 'goal_complete', 'goal_blocked']);
  });

  it('searches registered inactive tools by name and description', () => {
    const pi = fakePi();
    const matches = searchCapabilities({
      query: 'background specialist',
      tools: pi.getAllTools(),
    });

    expect(matches.map((match) => [match.kind, match.name])).toEqual([
      ['tool', 'get_subagent_result'],
      ['tool', 'steer_subagent'],
      ['tool', 'subagent'],
    ]);
  });

  it('activates only registered tools and preserves the existing active set', () => {
    const pi = fakePi();

    const added = activateRegisteredTools(pi, ['subagent', 'missing', 'subagent']);

    expect(added).toEqual(['subagent']);
    expect(pi.getActiveTools()).toEqual(['read', 'bash', 'subagent']);
    expect(pi.history).toEqual([['read', 'bash', 'subagent']]);
  });

  it('REQ-AGENT-158 AC3: treats subagent and its controls as one additive activation group', () => {
    expect(activationGroup('subagent')).toEqual([
      'subagent',
      'get_subagent_result',
      'steer_subagent',
    ]);
    expect(activationGroup('graphify_query')).toEqual(['graphify_query']);

    const pi = fakePi({
      active: ['read'],
      tools: [
        { name: 'read', description: 'Read files' },
        { name: 'subagent', description: 'Launch a background specialist' },
        { name: 'steer_subagent', description: 'Steer a background specialist' },
      ],
    });
    expect(activateRegisteredTools(pi, activationGroup('subagent'))).toEqual([
      'subagent',
      'steer_subagent',
    ]);
  });

  it('REQ-AGENT-158 AC1+AC2: final filtering removes tools registered by an earlier before-agent handler', async () => {
    const base = fakePi({
      active: ['read', 'bash'],
      tools: [
        { name: 'read', description: 'Read files' },
        { name: 'bash', description: 'Run shell commands' },
        { name: 'edit', description: 'Edit files' },
        { name: 'write', description: 'Write files' },
        { name: 'capability', description: 'Search tools' },
        { name: 'ctx_search', description: 'Large late context schema' },
      ],
    });
    const handlers: Array<(event: unknown, ctx: CapabilitySessionContext) => void | Promise<void>> = [];
    const pi = {
      ...base,
      registerTool() {},
      on(event: string, handler: (event: unknown, ctx: CapabilitySessionContext) => void | Promise<void>) {
        if (event === 'before_agent_start') handlers.push(handler);
      },
    };

    pi.on('before_agent_start', () => {
      pi.setActiveTools([...pi.getActiveTools(), 'ctx_search']);
    });
    toolExposureFinalizer(pi);
    for (const handler of handlers) await handler({}, {});

    expect(pi.getActiveTools()).toEqual(['read', 'bash', 'edit', 'write', 'capability']);
  });

  it('REQ-AGENT-158 AC1+AC2: keeps only bootstrap tools regardless of optional registrations', () => {
    const pi = fakePi({
      active: ['read', 'bash', 'ctx_execute', 'web_search'],
      tools: [
        { name: 'read', description: 'Read files' },
        { name: 'bash', description: 'Run shell commands' },
        { name: 'edit', description: 'Edit files' },
        { name: 'write', description: 'Write files' },
        { name: 'ask_user_question', description: 'Ask a structured question' },
        { name: 'capability', description: 'Search tools' },
        { name: 'subagent', description: 'Launch a background specialist' },
        { name: 'graphify_query', description: 'Query graph' },
        { name: 'graphify_path', description: 'Trace graph path' },
        { name: 'graphify_explain', description: 'Explain graph node' },
        { name: 'ctx_execute', description: 'Run context-mode code' },
        { name: 'web_search', description: 'Search the web' },
      ],
    });

    expect(initialActiveTools(pi)).toEqual([
      'read',
      'bash',
      'edit',
      'write',
      'capability',
    ]);
  });
});
