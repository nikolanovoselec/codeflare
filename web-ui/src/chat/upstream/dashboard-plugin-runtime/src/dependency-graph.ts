/**
 * Pure dependency-graph helpers for plugin activation.
 *
 * Shared between the server (route handler + loader) and the client (cascade
 * confirm dialog) so both sides compute the same impact for a toggle without
 * an extra round-trip.
 *
 * Robert's original add-plugin-activation-ui design called for this graph;
 * resuming after a temporary scope reduction.
 *
 * See change: add-plugin-activation-ui (Layer 2 — dependency graph).
 */

export interface GraphNode {
  id: string;
  dependsOn: string[];
  /** Whether the plugin is currently enabled in config (NOT runtime loaded). */
  enabled: boolean;
  /** Whether the plugin is present in the discovered set (vs ghost). */
  installed: boolean;
}

export type Graph = ReadonlyMap<string, GraphNode>;

/** Build a Graph from a discovered-plugin list + a config-enabled lookup. */
export function buildGraph(
  plugins: ReadonlyArray<{ id: string; dependsOn?: string[] }>,
  isEnabled: (id: string) => boolean,
): Graph {
  const m = new Map<string, GraphNode>();
  for (const p of plugins) {
    m.set(p.id, {
      id: p.id,
      dependsOn: [...(p.dependsOn ?? [])],
      enabled: isEnabled(p.id),
      installed: true,
    });
  }
  return m;
}

/**
 * Compute the set of plugin ids that depend on `id` (directly OR transitively).
 * Returns a Set excluding `id` itself.
 */
export function transitiveDependents(graph: Graph, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const node of graph.values()) {
      if (node.id === cur) continue;
      if (node.dependsOn.includes(cur) && !out.has(node.id)) {
        out.add(node.id);
        stack.push(node.id);
      }
    }
  }
  return out;
}

/**
 * Compute the set of plugin ids `id` depends on (directly OR transitively).
 * Returns a Set excluding `id` itself.
 */
export function transitiveDependencies(graph: Graph, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    const node = graph.get(cur);
    if (!node) continue;
    for (const dep of node.dependsOn) {
      if (dep !== id && !out.has(dep)) {
        out.add(dep);
        stack.push(dep);
      }
    }
  }
  return out;
}

export interface ToggleImpact {
  /** Deps that must also be enabled (target = true, currently-disabled deps). */
  cascadeEnable: string[];
  /** Dependents that must also be disabled (target = false, currently-enabled dependents). */
  cascadeDisable: string[];
  /** Deps not present in discovery — toggling to enabled is blocked. */
  blockers: string[];
}

/**
 * Decide what additional ids must flip when `id` is toggled to `target`.
 *
 * - `target = true`  → cascade enables every transitive dep currently disabled.
 *                       If any transitive dep is not installed → `blockers`.
 * - `target = false` → cascade disables every transitive dependent currently enabled.
 *                       No blockers in the disable direction.
 *
 * The return arrays exclude `id` itself and are sorted for stability.
 */
export function computeToggleImpact(
  graph: Graph,
  id: string,
  target: boolean,
): ToggleImpact {
  const cascadeEnable: string[] = [];
  const cascadeDisable: string[] = [];
  const blockers: string[] = [];

  const self = graph.get(id);
  if (!self) {
    return { cascadeEnable, cascadeDisable, blockers };
  }

  if (target) {
    for (const depId of transitiveDependencies(graph, id)) {
      const dep = graph.get(depId);
      if (!dep || !dep.installed) {
        blockers.push(depId);
      } else if (!dep.enabled) {
        cascadeEnable.push(depId);
      }
    }
  } else {
    for (const depId of transitiveDependents(graph, id)) {
      const node = graph.get(depId);
      if (node && node.enabled) cascadeDisable.push(depId);
    }
  }

  cascadeEnable.sort();
  cascadeDisable.sort();
  blockers.sort();
  return { cascadeEnable, cascadeDisable, blockers };
}

/**
 * Detect cycles in the dependency graph. Returns each cycle as a sequence of
 * ids ending with the start (so `["a", "b", "a"]` for an a→b→a cycle). Each
 * cycle is reported once per starting node in the cycle.
 *
 * Empty array when the graph is acyclic.
 */
export function detectCycles(graph: Graph): string[][] {
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      if (start >= 0) {
        cycles.push([...stack.slice(start), id]);
      }
      return;
    }
    visiting.add(id);
    stack.push(id);
    const node = graph.get(id);
    if (node) {
      for (const dep of node.dependsOn) {
        if (graph.has(dep)) dfs(dep);
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of graph.keys()) dfs(id);
  return cycles;
}

/**
 * Topologically sort plugin ids so every dep appears before its dependents.
 * Ties (within one topological tier) are broken by priority then by id.
 *
 * Plugins in cycles appear at the END of the result (in original input order).
 * Callers should consult `detectCycles` first to decide whether to load them.
 */
export function topologicalSort(
  plugins: ReadonlyArray<{ id: string; dependsOn?: string[]; priority?: number }>,
): string[] {
  const graph = buildGraph(plugins, () => true);
  const cycles = detectCycles(graph);
  const inCycle = new Set<string>();
  for (const c of cycles) for (const id of c) inCycle.add(id);

  const indeg = new Map<string, number>();
  for (const p of plugins) indeg.set(p.id, 0);
  for (const p of plugins) {
    for (const dep of p.dependsOn ?? []) {
      if (indeg.has(dep) && p.id !== dep) {
        indeg.set(p.id, (indeg.get(p.id) ?? 0) + 1);
      }
    }
  }

  // Filter cyclic nodes out of the kahn sort.
  const acyclic = plugins.filter((p) => !inCycle.has(p.id));
  const indegCopy = new Map<string, number>();
  for (const p of acyclic) {
    // Recompute indegree ignoring cyclic dep references.
    let d = 0;
    for (const dep of p.dependsOn ?? []) {
      if (!inCycle.has(dep) && acyclic.some((q) => q.id === dep) && p.id !== dep) d++;
    }
    indegCopy.set(p.id, d);
  }

  const out: string[] = [];
  const byId = new Map(acyclic.map((p) => [p.id, p] as const));

  function compareTier(a: string, b: string): number {
    const pa = byId.get(a);
    const pb = byId.get(b);
    const prioA = pa?.priority ?? 1000;
    const prioB = pb?.priority ?? 1000;
    if (prioA !== prioB) return prioA - prioB;
    return a.localeCompare(b);
  }

  while (out.length < acyclic.length) {
    const ready = Array.from(indegCopy.entries())
      .filter(([, d]) => d === 0)
      .map(([id]) => id)
      .sort(compareTier);
    if (ready.length === 0) break; // safety — shouldn't happen post cycle removal
    for (const id of ready) {
      out.push(id);
      indegCopy.delete(id);
      for (const p of acyclic) {
        if (p.dependsOn?.includes(id)) {
          const prev = indegCopy.get(p.id);
          if (prev !== undefined) indegCopy.set(p.id, prev - 1);
        }
      }
    }
  }

  // Append cyclic nodes at the end, in original input order.
  for (const p of plugins) {
    if (inCycle.has(p.id)) out.push(p.id);
  }
  return out;
}
