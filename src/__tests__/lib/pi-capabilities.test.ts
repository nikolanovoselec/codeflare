import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import capabilityExtension from '../../../preseed/agents/pi/extensions/capability';
import toolExposureFinalizer from '../../../preseed/agents/pi/extensions/zz-tool-exposure-finalizer';
import capabilityHelpersExtension, {
  activateRegisteredTools,
  activationGroup,
  initialActiveTools,
  resolveAgentDir,
  searchCapabilities,
  type ToolActivationPi,
} from '../../../preseed/agents/pi/extensions/capability-helpers';

type CapabilityTool = {
  name: string;
  description: string;
  execute(id: string, params: { query?: string; name?: string }): Promise<unknown>;
};

type CapabilitySessionContext = {
  isProjectTrusted?(): boolean;
  sessionManager?: {
    getBranch?(): Array<{ type?: string; customType?: string; data?: unknown }>;
    getEntries?(): Array<{ type?: string; customType?: string; data?: unknown }>;
  };
};

type EventHandler = (event: unknown, ctx: CapabilitySessionContext) => unknown;

// Pi dispatches every listener in registration order, not just the last listener.
class EventRegistry {
  private handlers = new Map<string, EventHandler[]>();

  set(event: string, handler: EventHandler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  get(event: string) {
    return (payload: unknown, ctx: CapabilitySessionContext) => {
      const results = (this.handlers.get(event) ?? []).map((handler) => handler(payload, ctx));
      return Promise.all(results);
    };
  }
}

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
    { name: 'plan_mode_question', description: 'Ask a Plan question' },
    { name: 'plan_mode_complete', description: 'Complete a Plan' },
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

type SearchMatch = { kind: 'tool' | 'skill'; name: string; description: string; filePath?: string };

function resultMatches(result: unknown): SearchMatch[] {
  expect(result).toMatchObject({ details: { matches: expect.any(Array) } });
  return (result as { details: { matches: SearchMatch[] } }).details.matches;
}

function identities(matches: Array<{ kind: string; name: string }>): string[] {
  return matches.map(({ kind, name }) => `${kind}:${name}`);
}

// Scalar shape from Pi 0.85.1 Skill / SourceInfo and prompt-customizer.ts.
// Do not load an SDK resource loader or parse skill bodies in this harness.
type NativeSkill = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: {
    path: string;
    source: string;
    scope: 'user' | 'project' | 'temporary';
    origin: 'top-level' | 'package';
    baseDir?: string;
  };
};

const temporaryRoots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function discoveryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'capability-discovery-'));
  temporaryRoots.push(root);
  const agentDir = join(root, 'agent');
  mkdirSync(agentDir);
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  const policyPath = join(agentDir, 'capability-skill-policy.json');
  const base = fakePi();
  const registered = new Map<string, CapabilityTool>();
  const handlers = new EventRegistry();
  const pi = {
    ...base,
    registerTool(tool: unknown) {
      const candidate = tool as CapabilityTool;
      registered.set(candidate.name, candidate);
    },
    on: (event: string, handler: EventHandler) => handlers.set(event, handler),
  };
  capabilityExtension(pi);
  const capability = registered.get('capability');
  if (!capability) throw new Error('Missing registered capability tool');
  const skill = (name: string, overrides: Partial<NativeSkill> = {}): NativeSkill => {
    const filePath = join(agentDir, 'skills', name, 'SKILL.md');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, new Uint8Array([0, 255, 1, 254]));
    return {
      name,
      description: 'Query repository architecture and dependencies',
      filePath,
      baseDir: dirname(filePath),
      disableModelInvocation: false,
      sourceInfo: { path: filePath, source: 'local', scope: 'user', origin: 'top-level' },
      ...overrides,
    };
  };
  return {
    root, agentDir, policyPath, pi, handlers, capability, skill,
    policy: (skills: unknown[], version: unknown = 1) => {
      writeFileSync(policyPath, JSON.stringify({ version, skills }));
    },
    observe: (skills: NativeSkill[], trusted = true) => handlers.get('before_agent_start')({
      type: 'before_agent_start',
      prompt: '',
      systemPrompt: '',
      systemPromptOptions: { cwd: root, skills },
    }, { isProjectTrusted: () => trusted }),
    search: async (query: string) => resultMatches(await capability.execute('lookup', { query })),
  };
}

const affirmativeEntry = { name: 'graphify', path: 'skills/graphify/SKILL.md', modelInvocable: true };

// Frozen search-test-cases.json identities; ranking-contract.mjs is not executed
// as an oracle, so this suite exercises the installed implementation only.
const rankingCandidates: SearchMatch[] = [
  { kind: 'tool', name: 'graphify_query', description: 'Query the code graph' },
  { kind: 'skill', name: 'graphify', description: 'Query repository architecture and dependencies', filePath: '/fixture/graphify/SKILL.md' },
  { kind: 'tool', name: 'subagent', description: 'Launch a background specialist' },
  { kind: 'tool', name: 'get_subagent_result', description: 'Check a background specialist' },
  { kind: 'tool', name: 'steer_subagent', description: 'Steer a background specialist' },
  { kind: 'tool', name: 'noise', description: 'Utility. Repository architecture appears in an unrelated example.' },
  { kind: 'tool', name: 'goal_wait', description: 'Wait for Goal progress' },
  { kind: 'skill', name: 'vault-note-capture', description: 'Capture and save notes in Vault', filePath: '/fixture/vault-note-capture/SKILL.md' },
  { kind: 'skill', name: 'mcp-scripting', description: 'Write JavaScript for MCP tools', filePath: '/fixture/mcp-scripting/SKILL.md' },
];

function ranked(query: string, candidates = rankingCandidates, limit?: number) {
  // Existing API plus eligible scalar skill metadata. Eligibility belongs to
  // capabilityExtension's event boundary, not the ranking fixtures.
  const input = {
    query,
    tools: candidates.filter((candidate) => candidate.kind === 'tool'),
    skills: candidates.filter((candidate) => candidate.kind === 'skill').map((candidate) => ({
      name: candidate.name, description: candidate.description, filePath: candidate.filePath!,
    })),
    limit,
  };
  return searchCapabilities(input);
}

describe('REQ-AGENT-096: relevant capability discovery', () => {
  it('keeps exact names authoritative and preserves kind filters', () => {
    expect(identities(ranked('skill:graphify'))).toEqual(['skill:graphify']);
    expect(identities(ranked('tool:graphify_query'))).toEqual(['tool:graphify_query']);
  });

  it('finds relevant capabilities despite natural-language filler', () => {
    expect(ranked('please query the code graph')[0]?.name).toBe('graphify_query');
    expect(ranked('please launch a background specialist')[0]?.name).toBe('subagent');
  });

  it('ranks a name match above a description-only match', () => {
    const candidates: SearchMatch[] = [
      { kind: 'tool', name: 'graph_query', description: 'Query Graphify for repository relationships.' },
      { kind: 'skill', name: 'graphify', description: 'Query the repository graph for architecture, dependencies and call flow.',
        filePath: '/managed/skills/graphify/SKILL.md' },
    ];
    expect(identities(ranked('graphify repository', candidates))).toEqual(['skill:graphify', 'tool:graph_query']);
  });

  it('uses distinctive terms to separate otherwise similar candidates', () => {
    const candidates: SearchMatch[] = [
      { kind: 'tool', name: 'deployment_status', description: 'Inspect deployment workflow status.' },
      { kind: 'tool', name: 'deployment_monitor', description: 'Monitor a deployment workflow while it runs.' },
      { kind: 'tool', name: 'deployment_history', description: 'List deployment workflow history.' },
    ];
    expect(ranked('monitor deployment', candidates)[0]?.name).toBe('deployment_monitor');
  });

  it('returns no result without meaningful lexical overlap', () => {
    expect(ranked('calculate orbital frobnication')).toEqual([]);
  });

  it('returns executable next actions and honors result limits', () => {
    expect(ranked('tool:graphify_query')[0]?.nextAction).toEqual({ action: 'activate-tool', name: 'graphify_query' });
    expect(ranked('skill:graphify')[0]?.nextAction).toEqual({ action: 'read-skill', path: '/fixture/graphify/SKILL.md' });
    const candidates: SearchMatch[] = [
      { kind: 'tool', name: 'shared', description: 'Run the shared tool.' },
      { kind: 'skill', name: 'shared', description: 'Guide the shared workflow.', filePath: '/managed/skills/shared/SKILL.md' },
    ];
    expect(ranked('shared', candidates, 1)).toHaveLength(1);
  });

  it('accepts missing optional tool descriptions at the public search boundary', () => {
    expect(identities(searchCapabilities({ query: 'graphify_query', tools: [{ name: 'graphify_query' }] })))
      .toEqual(['tool:graphify_query']);
    expect(searchCapabilities({ query: 'unrelated', tools: [{ name: 'graphify_query' }] })).toEqual([]);
  });
});

describe('REQ-AGENT-095/096: event-backed skill discovery and policy boundaries', () => {
  it('observes scalar metadata without changing event or active tools; later observers still run', async () => {
    const fixture = discoveryFixture();
    const native = fixture.skill('graphify');
    const event = Object.freeze({
      type: 'before_agent_start', prompt: '', systemPrompt: '',
      systemPromptOptions: Object.freeze({ cwd: fixture.root, skills: Object.freeze([Object.freeze(native)]) }),
    });
    let observed = 0;
    fixture.pi.on('before_agent_start', () => { observed++; });
    const active = fixture.pi.getActiveTools();
    expect(await fixture.handlers.get('before_agent_start')(event, { isProjectTrusted: () => true }))
      .toEqual([undefined, undefined]);
    expect(observed).toBe(1);
    const matches = await fixture.search('skill:graphify');
    expect(identities(matches)).toEqual(['skill:graphify']);
    expect(matches[0].filePath).toBe(native.filePath);
    expect(Array.from(readFileSync(matches[0].filePath!))).toEqual([0, 255, 1, 254]);
    expect(fixture.pi.getActiveTools()).toEqual(active);
    expect(fixture.pi.history).toEqual([]);
  });

  it('refreshes metadata only at the event boundary and clears it on session start', async () => {
    const fixture = discoveryFixture();
    const native = fixture.skill('graphify');
    await fixture.observe([native]);
    native.name = 'mutated';
    native.filePath = '/mutated/SKILL.md';
    expect(identities(await fixture.search('skill:graphify'))).toEqual(['skill:graphify']);
    expect((await fixture.search('skill:graphify'))[0].filePath).toBe(join(fixture.agentDir, 'skills/graphify/SKILL.md'));
    await fixture.observe([fixture.skill('replacement')]);
    expect(await fixture.search('skill:graphify')).toEqual([]);
    expect(identities(await fixture.search('skill:replacement'))).toEqual(['skill:replacement']);
    await fixture.handlers.get('session_start')({ type: 'session_start' }, {});
    expect(identities(await fixture.search('background specialist'))).toEqual([
      'tool:get_subagent_result', 'tool:steer_subagent', 'tool:subagent',
    ]);
    // Either a structured empty result or a tool error may signal unavailable
    // metadata; never accept stale matches and never assert explanatory prose.
    const result = await fixture.capability.execute('unavailable', { query: 'skill:replacement' }).catch((error: unknown) => error);
    if (result instanceof Error) expect(result).toBeInstanceOf(Error);
    else expect(resultMatches(result)).toEqual([]);
  });

  it('supports tool-only discovery before a snapshot and rejects empty input and kind prefixes', async () => {
    const fixture = discoveryFixture();
    expect(identities(await fixture.search('tool:subagent'))).toEqual(['tool:subagent']);
    for (const query of ['', '   ', 'tool:', ' SKILL: ']) {
      await expect(fixture.capability.execute('invalid', { query })).rejects.toBeInstanceOf(Error);
    }
    expect(await fixture.search('quantum banana')).toEqual([]);
    expect(fixture.pi.history).toEqual([]);
  });

  it('normalizes absent registered descriptions through ordinary tool execution', async () => {
    const fixture = discoveryFixture();
    fixture.pi.getAllTools = () => [{ name: 'descriptionless' }];
    expect(identities(await fixture.search('tool:descriptionless'))).toEqual(['tool:descriptionless']);
    expect(await fixture.search('unrelated')).toEqual([]);
    expect(fixture.pi.history).toEqual([]);
  });

  it('keeps name precedence, activation groups and idempotence after metadata observation', async () => {
    const fixture = discoveryFixture();
    await fixture.observe([fixture.skill('subagent')]);
    expect(await fixture.capability.execute('activate', { name: 'subagent', query: 'skill:subagent' }))
      .toMatchObject({ details: { name: 'subagent', added: ['subagent', 'get_subagent_result', 'steer_subagent'] } });
    expect(await fixture.capability.execute('again', { name: 'subagent' }))
      .toMatchObject({ details: { name: 'subagent', added: [] } });
    const active = fixture.pi.getActiveTools();
    await expect(fixture.capability.execute('invalid', { name: 'missing', query: 'tool:read' }))
      .rejects.toBeInstanceOf(Error);
    await expect(fixture.capability.execute('invalid', { name: 'skill:subagent' }))
      .rejects.toBeInstanceOf(Error);
    expect(fixture.pi.getActiveTools()).toEqual(active);
  });

  it('grants only originally eligible hidden seeds and refreshes policy at each event', async () => {
    const fixture = discoveryFixture();
    const hidden = fixture.skill('graphify', { disableModelInvocation: true });
    const restricted = fixture.skill('restricted', { disableModelInvocation: true });
    fixture.policy([affirmativeEntry, { name: 'restricted', path: 'skills/restricted/SKILL.md', modelInvocable: false }]);
    await fixture.observe([hidden, restricted]);
    expect(identities(await fixture.search('skill:graphify'))).toEqual(['skill:graphify']);
    expect(await fixture.search('skill:restricted')).toEqual([]);
    fixture.policy([{ ...affirmativeEntry, modelInvocable: false }]);
    expect(identities(await fixture.search('skill:graphify'))).toEqual(['skill:graphify']);
    await fixture.observe([hidden, restricted]);
    expect(await fixture.search('skill:graphify')).toEqual([]);
  });

  it.each(['project', 'package', 'temporary', 'different-path'] as const)(
    'does not transfer a seed exception to a %s winner', async (source) => {
      const fixture = discoveryFixture();
      fixture.policy([affirmativeEntry]);
      const selected = fixture.skill('graphify', { disableModelInvocation: true });
      if (source === 'project' || source === 'temporary') selected.sourceInfo.scope = source;
      if (source === 'package') selected.sourceInfo.origin = 'package';
      if (source === 'different-path') {
        selected.filePath = join(fixture.root, 'override/SKILL.md');
        selected.baseDir = dirname(selected.filePath);
        selected.sourceInfo.path = selected.filePath;
      }
      await fixture.observe([selected]);
      expect(await fixture.search('skill:graphify')).toEqual([]);
    },
  );

  it('respects project trust for ordinary native winners without requiring seed policy', async () => {
    const fixture = discoveryFixture();
    const project = fixture.skill('project-native');
    project.sourceInfo.scope = 'project';
    const user = fixture.skill('user-native');
    const packaged = fixture.skill('package-native');
    packaged.sourceInfo.origin = 'package';
    await fixture.observe([project, user, packaged], false);
    expect(identities(await fixture.search('skill:project-native'))).not.toContain('skill:project-native');
    expect(identities(await fixture.search('skill:user-native'))).toEqual(['skill:user-native']);
    expect(identities(await fixture.search('skill:package-native'))).toEqual(['skill:package-native']);
    await fixture.observe([project, user, packaged], true);
    expect(identities(await fixture.search('skill:project-native'))).toEqual(['skill:project-native']);
  });

  it.each<[string, unknown]>([
    ['unknown version', { version: 2, skills: [affirmativeEntry] }],
    ['wrong version type', { version: '1', skills: [affirmativeEntry] }],
    ['missing version', { skills: [affirmativeEntry] }],
    ['non-array skills', { version: 1, skills: {} }],
    ['null document', null],
    ['null entry', { version: 1, skills: [affirmativeEntry, null] }],
    ['duplicate name', { version: 1, skills: [affirmativeEntry, { ...affirmativeEntry, path: 'skills/other/SKILL.md' }] }],
    ['duplicate path', { version: 1, skills: [affirmativeEntry, { ...affirmativeEntry, name: 'other' }] }],
    ['wrong boolean type', { version: 1, skills: [{ ...affirmativeEntry, modelInvocable: 'true' }] }],
    ['missing boolean', { version: 1, skills: [{ name: 'graphify', path: affirmativeEntry.path }] }],
    ['wrong name type', { version: 1, skills: [affirmativeEntry, { name: 42, path: 'skills/other/SKILL.md', modelInvocable: true }] }],
    ['wrong path type', { version: 1, skills: [affirmativeEntry, { name: 'other', path: 42, modelInvocable: true }] }],
    ['escaping path', { version: 1, skills: [affirmativeEntry, { name: 'other', path: '../other/SKILL.md', modelInvocable: true }] }],
    ['noncanonical path', { version: 1, skills: [{ ...affirmativeEntry, path: 'skills/graphify/../graphify/SKILL.md' }] }],
    ['absolute path', { version: 1, skills: [{ ...affirmativeEntry, path: '/skills/graphify/SKILL.md' }] }],
    ['mismatched directory', { version: 1, skills: [{ ...affirmativeEntry, path: 'skills/other/SKILL.md' }] }],
  ])('fails closed for %s policy without disabling native discovery', async (_label, document) => {
    const fixture = discoveryFixture();
    writeFileSync(fixture.policyPath, JSON.stringify(document));
    await fixture.observe([
      fixture.skill('graphify', { disableModelInvocation: true }),
      fixture.skill('native'),
    ]);
    expect(await fixture.search('skill:graphify')).toEqual([]);
    expect(identities(await fixture.search('skill:native'))).toEqual(['skill:native']);
  });

  it.each(['missing', 'malformed', 'oversized'] as const)('grants no hidden exceptions for %s policy', async (state) => {
    const fixture = discoveryFixture();
    if (state === 'malformed') writeFileSync(fixture.policyPath, '{');
    if (state === 'oversized') {
      writeFileSync(fixture.policyPath, JSON.stringify({ version: 1, skills: [affirmativeEntry], padding: 'x'.repeat(1024 * 1024) }));
    }
    await fixture.observe([fixture.skill('graphify', { disableModelInvocation: true }), fixture.skill('native')]);
    expect(await fixture.search('skill:graphify')).toEqual([]);
    expect(identities(await fixture.search('skill:native'))).toEqual(['skill:native']);
  });

  it('rejects a canonical-looking skill path whose symlink escapes the agent directory', async () => {
    const fixture = discoveryFixture();
    fixture.policy([affirmativeEntry]);
    const selected = fixture.skill('graphify', { disableModelInvocation: true });
    const outside = join(fixture.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'SKILL.md'), new Uint8Array([7]));
    rmSync(selected.baseDir, { recursive: true });
    symlinkSync(outside, selected.baseDir, 'dir');
    await fixture.observe([selected, fixture.skill('native')]);
    expect(await fixture.search('skill:graphify')).toEqual([]);
    expect(identities(await fixture.search('skill:native'))).toEqual(['skill:native']);
  });

  it('returns the selected native path intact, bounds structured purposes and never exposes tool paths', async () => {
    const fixture = discoveryFixture();
    const filePath = join(fixture.root, 'space "quote" 😀', 'SKILL.md');
    mkdirSync(dirname(filePath));
    writeFileSync(filePath, new Uint8Array([9, 8, 7]));
    const native = fixture.skill('graphify', {
      filePath, baseDir: dirname(filePath),
      description: `Query ${'😀'.repeat(150)}.\n${'Unrelated detail '.repeat(100)}`,
      sourceInfo: { path: filePath, source: 'local', scope: 'user', origin: 'top-level' },
    });
    await fixture.observe([native]);
    const matches = await fixture.search('skill:graphify');
    expect(identities(matches)).toEqual(['skill:graphify']);
    expect(matches[0].filePath).toBe(filePath);
    expect(Array.from(readFileSync(matches[0].filePath!))).toEqual([9, 8, 7]);
    expect([...matches[0].description].length).toBeLessThanOrEqual(100);
    const tools = await fixture.search('tool:subagent');
    expect(identities(tools)).toEqual(['tool:subagent']);
    expect(Object.hasOwn(tools[0], 'filePath')).toBe(false);
    expect(fixture.pi.history).toEqual([]);
  });
});

describe('REQ-AGENT-096: registered Pi tool discovery and activation', () => {
  it('loads the helper module as a side-effect-free standalone extension', () => {
    expect(capabilityHelpersExtension()).toBeUndefined();
  });

  it('resolves Pi agent-directory overrides with home expansion', () => {
    expect(resolveAgentDir('~/custom-agent', '/different-home')).toBe('/different-home/custom-agent');
    expect(resolveAgentDir('/configured/agent', '/different-home')).toBe('/configured/agent');
    expect(resolveAgentDir(undefined, '/different-home')).toBe('/different-home/.pi/agent');
  });

  it('reads the Pi agent-directory override from the environment', () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = '/configured/agent';
    try {
      expect(resolveAgentDir()).toBe('/configured/agent');
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
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
    const handlers = new EventRegistry();
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
    toolExposureFinalizer(pi, () => 'after-first-goal');
    handlers.get('before_agent_start')?.({}, {});

    expect(pi.getActiveTools()).toEqual(['read', 'bash', 'edit', 'write', 'capability']);
    const capability = registered.get('capability');
    if (!capability) throw new Error('capability tool was not registered');

    expect(identities(resultMatches(await capability.execute('search', {
      query: 'background specialist',
    })))).toEqual(['tool:get_subagent_result', 'tool:steer_subagent', 'tool:subagent']);
    await expect(capability.execute('activate-skill', { name: 'codeflare-capabilities' }))
      .rejects.toBeInstanceOf(Error);
    expect(await capability.execute('activate', { name: 'subagent' })).toMatchObject({
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

  it('REQ-AGENT-191 AC1: hides registered Goal tools for a fresh lazy session', () => {
    const base = fakePi({
      active: ['read', 'goal_complete', 'goal_blocked', 'goal_wait'],
      tools: [
        { name: 'read', description: 'Read files' },
        { name: 'bash', description: 'Run shell commands' },
        { name: 'goal_complete', description: 'Complete Goal' },
        { name: 'goal_blocked', description: 'Block Goal' },
        { name: 'goal_wait', description: 'Wait for an external event' },
      ],
    });
    const handlers = new EventRegistry();
    const pi = {
      ...base,
      registerTool() {},
      on(event: string, handler: (event: unknown, ctx: CapabilitySessionContext) => void) {
        handlers.set(event, handler);
      },
    };
    toolExposureFinalizer(pi, () => 'after-first-goal');

    handlers.get('before_agent_start')?.({}, {
      sessionManager: { getBranch: () => [] },
    });

    expect(pi.getActiveTools()).toEqual(['read', 'bash']);
  });

  it('REQ-AGENT-191 AC2: retains terminal Goal tools after the first session Goal', () => {
    const base = fakePi({
      active: ['read'],
      tools: [
        { name: 'read', description: 'Read files' },
        { name: 'bash', description: 'Run shell commands' },
        { name: 'goal_complete', description: 'Complete Goal' },
        { name: 'goal_blocked', description: 'Block Goal' },
        { name: 'goal_wait', description: 'Wait for an external event' },
      ],
    });
    const handlers = new EventRegistry();
    const pi = {
      ...base,
      registerTool() {},
      on(event: string, handler: (event: unknown, ctx: CapabilitySessionContext) => void) {
        handlers.set(event, handler);
      },
    };
    capabilityExtension(pi);
    toolExposureFinalizer(pi, () => 'after-first-goal');
    const session = (status: string | null) => ({
      sessionManager: {
        getBranch: () => [{
          type: 'custom',
          customType: 'goal-state',
          data: { goal: status === null ? null : { id: 'goal-1', status } },
        }],
      },
    });

    handlers.get('before_agent_start')?.({}, session('completed'));
    expect(pi.getActiveTools()).toEqual(['read', 'bash', 'goal_complete', 'goal_blocked']);
  });

  it('REQ-AGENT-191 AC3: preserves Goal tools already active under the always-visible policy', () => {
    const base = fakePi({
      active: ['read', 'goal_complete', 'goal_blocked', 'goal_wait'],
      tools: [
        { name: 'read', description: 'Read files' },
        { name: 'bash', description: 'Run shell commands' },
        { name: 'goal_complete', description: 'Complete Goal' },
        { name: 'goal_blocked', description: 'Block Goal' },
        { name: 'goal_wait', description: 'Wait for an external event' },
      ],
    });
    const handlers = new EventRegistry();
    const pi = {
      ...base,
      registerTool() {},
      on(event: string, handler: (event: unknown, ctx: CapabilitySessionContext) => void) {
        handlers.set(event, handler);
      },
    };
    capabilityExtension(pi);
    toolExposureFinalizer(pi, () => 'always');

    handlers.get('before_agent_start')?.({}, {
      sessionManager: { getBranch: () => [] },
    });

    expect(pi.getActiveTools()).toEqual(['read', 'bash', 'goal_complete', 'goal_blocked']);
  });

  it('REQ-AGENT-191 AC6: never discovers or activates goal_wait', () => {
    const pi = fakePi({
      active: ['read'],
      tools: [
        { name: 'read', description: 'Read files' },
        { name: 'goal_wait', description: 'Wait for an external event' },
      ],
    });

    expect(searchCapabilities({ query: 'wait external event', tools: pi.getAllTools() })).toEqual([]);
    expect(activateRegisteredTools(pi, ['goal_wait'])).toEqual([]);
    expect(pi.getActiveTools()).toEqual(['read']);
  });

  it('REQ-AGENT-152/158: preserves only a restored Plan workflow policy plus required helpers', () => {
    const base = fakePi({
      tools: [
        { name: 'read', description: 'Read files' },
        { name: 'bash', description: 'Run shell commands' },
        { name: 'edit', description: 'Edit files' },
        { name: 'graphify_query', description: 'Query graph' },
        { name: 'plan_mode_question', description: 'Ask a Plan question' },
        { name: 'plan_mode_complete', description: 'Complete a Plan' },
      ],
    });
    const handlers = new EventRegistry();
    const pi = {
      ...base,
      registerTool() {},
      on(event: string, handler: (event: unknown, ctx: CapabilitySessionContext) => void) {
        handlers.set(event, handler);
      },
    };
    toolExposureFinalizer(pi, () => 'after-first-goal');
    const ctx = {
      sessionManager: {
        getBranch: () => [{
          type: 'custom',
          customType: 'plan-mode-state',
          data: {
            enabled: true,
            workflowToolPolicy: { allowedNames: ['read', 'graphify_query'], resolved: true },
          },
        }],
      },
    };

    handlers.get('before_agent_start')?.({}, ctx);

    expect(pi.getActiveTools()).toEqual([
      'read', 'graphify_query', 'plan_mode_question', 'plan_mode_complete',
    ]);
  });

  it('REQ-AGENT-191 AC3: keeps configured always-visible Goal tools during an active Plan', () => {
    const base = fakePi({
      tools: [
        { name: 'read', description: 'Read files' },
        { name: 'graphify_query', description: 'Query graph' },
        { name: 'goal_complete', description: 'Complete Goal' },
        { name: 'goal_blocked', description: 'Block Goal' },
        { name: 'goal_wait', description: 'Wait for an external event' },
        { name: 'plan_mode_question', description: 'Ask a Plan question' },
        { name: 'plan_mode_complete', description: 'Complete a Plan' },
      ],
    });
    const handlers = new EventRegistry();
    const pi = {
      ...base,
      registerTool() {},
      on(event: string, handler: (event: unknown, ctx: CapabilitySessionContext) => void) {
        handlers.set(event, handler);
      },
    };
    toolExposureFinalizer(pi, () => 'always');

    handlers.get('before_agent_start')?.({}, {
      sessionManager: {
        getBranch: () => [{
          type: 'custom',
          customType: 'plan-mode-state',
          data: {
            enabled: true,
            workflowToolPolicy: { allowedNames: ['read', 'graphify_query'], resolved: true },
          },
        }],
      },
    });

    expect(pi.getActiveTools()).toEqual([
      'read', 'graphify_query', 'plan_mode_question', 'plan_mode_complete',
      'goal_complete', 'goal_blocked',
    ]);
  });

  it('REQ-AGENT-191 AC4/AC5 / REQ-AGENT-152/158: rejects malformed Plan policy and preserves active workflow ownership', () => {
    const base = fakePi({
      tools: [
        { name: 'read', description: 'Read files' },
        { name: 'bash', description: 'Run shell commands' },
        { name: 'edit', description: 'Edit files' },
        { name: 'write', description: 'Write files' },
        { name: 'capability', description: 'Search tools' },
        { name: 'goal_complete', description: 'Complete Goal' },
        { name: 'goal_blocked', description: 'Block Goal' },
        { name: 'goal_wait', description: 'Wait for an external event' },
        { name: 'graphify_query', description: 'Query graph' },
        { name: 'plan_mode_question', description: 'Ask a Plan question' },
        { name: 'plan_mode_complete', description: 'Complete a Plan' },
      ],
    });
    const handlers = new EventRegistry();
    const pi = {
      ...base,
      registerTool() {},
      on(event: string, handler: (event: unknown, ctx: CapabilitySessionContext) => void) {
        handlers.set(event, handler);
      },
    };
    toolExposureFinalizer(pi, () => 'after-first-goal');

    handlers.get('before_agent_start')?.({}, {
      sessionManager: {
        getBranch: () => [{
          type: 'custom',
          customType: 'plan-mode-state',
          data: {
            enabled: true,
            workflowToolPolicy: { allowedNames: ['read', 42], resolved: true },
          },
        }],
      },
    });
    expect(pi.getActiveTools()).toEqual(['read', 'bash', 'edit', 'write', 'capability']);

    handlers.get('before_agent_start')?.({}, {
      sessionManager: {
        getBranch: () => [
          {
            type: 'custom',
            customType: 'goal-state',
            data: { goal: { id: 'goal-1', status: 'paused' } },
          },
          {
            type: 'custom',
            customType: 'plan-mode-state',
            data: {
              enabled: true,
              workflowToolPolicy: { allowedNames: ['read', 'graphify_query'], resolved: true },
            },
          },
        ],
      },
    });
    expect(pi.getActiveTools()).toEqual([
      'read', 'graphify_query', 'plan_mode_question', 'plan_mode_complete',
    ]);

    handlers.get('before_agent_start')?.({}, {
      sessionManager: {
        getBranch: () => [
          {
            type: 'custom',
            customType: 'goal-state',
            data: { goal: { id: 'goal-1', status: 'active' } },
          },
          {
            type: 'custom',
            customType: 'plan-mode-state',
            data: {
              enabled: true,
              workflowToolPolicy: { allowedNames: ['read', 'graphify_query'], resolved: true },
            },
          },
        ],
      },
    });
    expect(pi.getActiveTools()).toEqual([
      'read', 'bash', 'edit', 'write', 'capability', 'goal_complete', 'goal_blocked',
    ]);
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
    toolExposureFinalizer(pi, () => 'after-first-goal');
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

describe('REQ-AGENT-158: child protocol compatibility', () => {
  it('REQ-AGENT-158: preserves registered child protocol without granting ordinary tools', () => {
    const pi = fakePi({ active: [], tools: [
      { name: 'ask_parent', description: 'Ask the parent' },
      { name: 'notify_parent', description: 'Notify the parent' },
    ] });
    expect(initialActiveTools(pi)).toEqual(['ask_parent', 'notify_parent']);
  });

  it('does not manufacture child tools in the parent or when notifications are disabled', () => {
    expect(initialActiveTools(fakePi())).not.toContain('ask_parent');
    expect(initialActiveTools(fakePi({ tools: [
      { name: 'ask_parent', description: 'Ask the parent' },
    ] }))).toEqual(['ask_parent']);
  });
});
