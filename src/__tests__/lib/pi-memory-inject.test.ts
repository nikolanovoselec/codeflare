import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  extractKeywords,
  renderInjection,
  selectNodes,
  type GraphNode,
} from '../../../preseed/agents/pi/extensions/memory-inject-helpers';
import {
  buildInjection,
  MEMORY_INJECT_TYPE,
  registerMemoryInject,
  resolveGraphPath,
  type MemoryInjectDependencies,
  type MemoryInjectPi,
} from '../../../preseed/agents/pi/extensions/memory-inject';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const NODES: GraphNode[] = [
  { label: 'handleVaultRequest', source: 'src/routes/vault.ts', description: 'Main vault route handler' },
  { label: 'Container', source: 'src/container/index.ts', description: 'Durable Object for container management' },
  { label: 'Unrelated Widget', source: 'lib/widget.ts', description: 'A widget that does nothing relevant' },
];

const PROMPT = 'check the vault route handler and fix the container proxy issue';

function workspace(nodes: GraphNode[] = NODES): MemoryInjectDependencies & { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'pi-mem-inject-'));
  roots.push(root);
  const graphDir = join(root, '.graphify');
  mkdirSync(graphDir, { recursive: true });
  const globalGraph = join(graphDir, 'global-graph.json');
  writeFileSync(globalGraph, JSON.stringify({ nodes, edges: [] }));
  return { root, globalGraph, sentinelDir: join(root, 'counter'), maxGraphBytes: 104857600 };
}

function fakePi(): {
  pi: MemoryInjectPi;
  fire(prompt: string, ctx?: unknown): any;
} {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const pi: MemoryInjectPi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  return {
    pi,
    fire(prompt, ctx: any = { sessionManager: { getSessionId: () => 'sess-1' }, cwd: '/nowhere' }) {
      return handlers.get('before_agent_start')?.({ type: 'before_agent_start', prompt }, ctx);
    },
  };
}

describe('Pi first-prompt memory injection (REQ-MEM-013)', () => {
  it('AC1: keywords are unique words of four characters or more from the prompt head', () => {
    const keywords = extractKeywords('Fix the VAULT route, and the container proxy!! vault vault');

    expect(keywords).toContain('vault');
    expect(keywords).toContain('container');
    // Short words carry no signal and must not reach the graph.
    expect(keywords).not.toContain('fix');
    expect(keywords).not.toContain('the');
    // Deduplicated: three mentions of one word is one keyword.
    expect(keywords.filter((word) => word === 'vault')).toHaveLength(1);
  });

  it('AC1: a label hit outranks a description hit outranks a source hit', () => {
    const nodes: GraphNode[] = [
      { label: 'nothing', source: 'src/container/proxy.ts', description: 'unrelated' },
      { label: 'nothing either', source: 'src/other.ts', description: 'the container proxy path' },
      { label: 'containerProxy', source: 'src/x.ts', description: 'unrelated' },
    ];

    const selected = selectNodes(nodes, ['container']);

    expect(selected.map((node) => node.label)).toEqual(['containerProxy', 'nothing either', 'nothing']);
  });

  it('AC2: at most ten nodes are carried', () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      label: `vaultNode${index}`,
      source: 'src/routes/vault.ts',
      description: 'vault',
    }));

    expect(selectNodes(many, ['vault'])).toHaveLength(10);
  });

  it('AC1: nothing is rendered when no node matches', () => {
    expect(renderInjection(selectNodes(NODES, ['zzzznomatch']))).toBeNull();
  });

  it('AC4: a prompt below the character floor is skipped before the graph is read', () => {
    const deps = workspace();

    expect(buildInjection(deps, 'too short')).toBeNull();
  });

  it('AC5: reads the unified graph only, and only within the ceiling', () => {
    const deps = workspace();

    expect(resolveGraphPath(deps)).toBe(deps.globalGraph);
    expect(resolveGraphPath({ ...deps, maxGraphBytes: 1 })).toBeNull();
    // No unified graph means no injection: a repo graph is a subset the merger
    // already folded into it, and at session start it does not exist at all.
    expect(resolveGraphPath({ ...deps, globalGraph: join(deps.root, 'missing.json') })).toBeNull();
  });

  it('AC5: an injected ceiling is not outranked by the ambient environment', () => {
    const deps = workspace();
    const previous = process.env.MEMORY_INJECT_MAX_GRAPH_BYTES;
    process.env.MEMORY_INJECT_MAX_GRAPH_BYTES = '1';
    try {
      // The dependency struct is the contract; the variable configures the
      // default, not every caller.
      expect(resolveGraphPath(deps)).toBe(deps.globalGraph);
    } finally {
      if (previous === undefined) delete process.env.MEMORY_INJECT_MAX_GRAPH_BYTES;
      else process.env.MEMORY_INJECT_MAX_GRAPH_BYTES = previous;
    }
  });

  it('AC1: injects matched nodes into the turn as a message', () => {
    const deps = workspace();
    const { pi, fire } = fakePi();
    registerMemoryInject(pi, deps);

    const result = fire(PROMPT);

    expect(result?.message?.customType).toBe(MEMORY_INJECT_TYPE);
    expect(result?.message?.content).toContain('handleVaultRequest');
    expect(result?.message?.content).toContain('Container');
    expect(result?.message?.content).not.toContain('Unrelated Widget');
    expect(result?.message?.details).toEqual({ graph: deps.globalGraph });
  });

  it('AC3: fires at most once per session', () => {
    const deps = workspace();
    const { pi, fire } = fakePi();
    registerMemoryInject(pi, deps);

    expect(fire(PROMPT)?.message).toBeTruthy();
    expect(fire(PROMPT)).toBeUndefined();
    expect(existsSync(join(deps.sentinelDir, 'sess-1.inject-lock'))).toBe(true);
  });

  it('AC3: a prompt that matched nothing leaves the session sentinel unspent', () => {
    const deps = workspace();
    const { pi, fire } = fakePi();
    registerMemoryInject(pi, deps);

    expect(fire('zzzznomatch zzzzalso zzzzneither zzzznope')).toBeUndefined();
    expect(existsSync(join(deps.sentinelDir, 'sess-1.inject-lock'))).toBe(false);
    // The session's one shot survived the miss.
    expect(fire(PROMPT)?.message).toBeTruthy();
  });

  it('stays out of a child session', () => {
    const deps = workspace();
    const { pi, fire } = fakePi();
    registerMemoryInject(pi, deps);

    const child = {
      sessionManager: { getSessionId: () => 'sess-child', getHeader: () => ({ parentSession: 'parent-1' }) },
      cwd: '/nowhere',
    };

    expect(fire(PROMPT, child)).toBeUndefined();
  });

  it('ignores a synthetic prompt without spending the sentinel', () => {
    const deps = workspace();
    const { pi, fire } = fakePi();
    registerMemoryInject(pi, deps);

    expect(fire('<task-notification>a background task finished and reported back</task-notification>')).toBeUndefined();
    expect(existsSync(join(deps.sentinelDir, 'sess-1.inject-lock'))).toBe(false);
  });

  it('survives a malformed graph without throwing into the turn', () => {
    const deps = workspace();
    writeFileSync(deps.globalGraph, 'NOT JSON {{{{');
    const { pi, fire } = fakePi();
    registerMemoryInject(pi, deps);

    expect(() => fire(PROMPT)).not.toThrow();
    expect(fire(PROMPT)).toBeUndefined();
  });
});
