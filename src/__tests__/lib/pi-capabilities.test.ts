import { describe, expect, it } from 'vitest';

import capabilityExtension from '../../../preseed/agents/pi/extensions/capability';
import capabilityHelpersExtension, {
  activateRegisteredTools,
  initialActiveTools,
  searchCapabilities,
  type ToolActivationPi,
} from '../../../preseed/agents/pi/extensions/capability-helpers';

type CapabilityTool = {
  name: string;
  description: string;
  execute(id: string, params: { query?: string; name?: string }): Promise<unknown>;
};

function fakePi(input?: {
  active?: string[];
  tools?: Array<{ name: string; description: string }>;
}): ToolActivationPi & { history: string[][] } {
  let active = [...(input?.active ?? ['read', 'bash'])];
  const tools = input?.tools ?? [
    { name: 'read', description: 'Read files' },
    { name: 'bash', description: 'Run shell commands' },
    { name: 'ask_user_question', description: 'Ask a structured question' },
    { name: 'subagent', description: 'Launch a background specialist' },
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
        { name: 'graphify_query', description: 'Query the code graph' },
        { name: 'subagent', description: 'Launch a background specialist' },
      ],
    });
    const registered = new Map<string, CapabilityTool>();
    const handlers = new Map<string, () => void>();
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
      on(event: string, handler: () => void) {
        handlers.set(event, handler);
      },
    };

    capabilityExtension(pi);
    handlers.get('session_start')?.();

    expect(pi.getActiveTools()).toEqual(['read', 'bash', 'capability', 'graphify_query']);
    const capability = registered.get('capability');
    if (!capability) throw new Error('capability tool was not registered');

    expect(await capability.execute('search', { query: 'background specialist' })).toEqual({
      content: [{ type: 'text', text: 'subagent — Launch a background specialist' }],
      details: {
        matches: [{
          kind: 'tool',
          name: 'subagent',
          description: 'Launch a background specialist',
        }],
      },
    });
    expect(await capability.execute('activate', { name: 'subagent' })).toEqual({
      content: [{ type: 'text', text: 'Loaded tool: subagent' }],
      details: { name: 'subagent', added: ['subagent'] },
    });
    expect(pi.getActiveTools()).toEqual([
      'read',
      'bash',
      'capability',
      'graphify_query',
      'subagent',
    ]);
  });

  it('searches registered inactive tools by name and description', () => {
    const pi = fakePi();
    const matches = searchCapabilities({
      query: 'background specialist',
      tools: pi.getAllTools(),
    });

    expect(matches.map((match) => [match.kind, match.name])).toEqual([
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

  it('keeps the compact core, Graphify, questions, and explicit context-mode opt-in', () => {
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
      'ask_user_question',
      'capability',
      'graphify_query',
      'graphify_path',
      'graphify_explain',
      'ctx_execute',
    ]);
  });
});
