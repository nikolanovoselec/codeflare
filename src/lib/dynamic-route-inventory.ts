import type { PiReasoningLevel } from './reasoning-profiles';

export type InventoryErrorCode =
  | 'inventory_malformed_graph'
  | 'inventory_duplicate_node'
  | 'inventory_missing_start'
  | 'inventory_cycle'
  | 'inventory_unresolved_edge'
  | 'inventory_budget_exceeded';

export class DynamicRouteInventoryError extends Error {
  constructor(public readonly code: InventoryErrorCode) {
    super({
      inventory_malformed_graph: 'Dynamic route graph is malformed',
      inventory_duplicate_node: 'Dynamic route graph contains duplicate nodes',
      inventory_missing_start: 'Dynamic route graph has no unique start node',
      inventory_cycle: 'Dynamic route graph contains a cycle',
      inventory_unresolved_edge: 'Dynamic route graph contains an unresolved edge',
      inventory_budget_exceeded: 'Dynamic route graph exceeds inventory limits',
    }[code]);
    this.name = 'DynamicRouteInventoryError';
  }
}

interface DynamicRouteEdge {
  elementId: string;
}

interface DynamicRouteElement {
  id: string;
  type: string;
  properties?: Record<string, unknown>;
  outputs: Record<string, DynamicRouteEdge>;
}

export interface DynamicRouteVersionInput {
  versionId: string;
  elements: unknown;
}

export interface DynamicRouteModelSummary {
  nodeId: string;
  provider: string;
  model: string;
}

export interface DynamicRoutePathSummary {
  modelNodeId: string;
  branches: string[];
}

export interface DynamicRouteInventory {
  schemaVersion: 1;
  versionId: string;
  models: DynamicRouteModelSummary[];
  paths: DynamicRoutePathSummary[];
  reachableNodeCount: number;
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_SUMMARY_VALUE_LENGTH = 256;
const MAX_INVENTORY_NODES = 256;
const MAX_INVENTORY_EDGES = 512;
const MAX_INVENTORY_OUTPUT_PATHS = 1024;
const CONTINUATION_OUTPUTS = new Set(['next', 'success', 'end']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTerminalSentinel(target: string): boolean {
  return target.toLowerCase() === 'end';
}

function safeSummaryValue(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SUMMARY_VALUE_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseElements(raw: unknown): DynamicRouteElement[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new DynamicRouteInventoryError('inventory_malformed_graph');
  if (raw.length > MAX_INVENTORY_NODES) throw new DynamicRouteInventoryError('inventory_budget_exceeded');
  let edgeCount = 0;
  return raw.map((candidate) => {
    if (!isPlainObject(candidate)
      || typeof candidate.id !== 'string'
      || !SAFE_IDENTIFIER.test(candidate.id)
      || typeof candidate.type !== 'string'
      || !SAFE_IDENTIFIER.test(candidate.type)
      || !isPlainObject(candidate.outputs)) {
      throw new DynamicRouteInventoryError('inventory_malformed_graph');
    }
    if (candidate.properties !== undefined && !isPlainObject(candidate.properties)) {
      throw new DynamicRouteInventoryError('inventory_malformed_graph');
    }
    const outputs: Record<string, DynamicRouteEdge> = {};
    const entries = Object.entries(candidate.outputs);
    edgeCount += entries.length;
    if (edgeCount > MAX_INVENTORY_EDGES) throw new DynamicRouteInventoryError('inventory_budget_exceeded');
    for (const [branch, edge] of entries) {
      if (!SAFE_BRANCH.test(branch)
        || !isPlainObject(edge)
        || typeof edge.elementId !== 'string'
        || !SAFE_IDENTIFIER.test(edge.elementId)) {
        throw new DynamicRouteInventoryError('inventory_malformed_graph');
      }
      outputs[branch] = { elementId: edge.elementId };
    }
    const normalizedType = candidate.type.toLowerCase();
    if ((normalizedType === 'end' || candidate.id.toLowerCase() === 'end') && (normalizedType !== 'end' || Object.keys(outputs).length > 0)) {
      throw new DynamicRouteInventoryError('inventory_malformed_graph');
    }
    if (normalizedType === 'model') {
      if (!safeSummaryValue(candidate.properties?.provider) || !safeSummaryValue(candidate.properties?.model)) {
        throw new DynamicRouteInventoryError('inventory_malformed_graph');
      }
    }
    return {
      id: candidate.id,
      type: candidate.type,
      ...(candidate.properties && { properties: candidate.properties }),
      outputs,
    };
  });
}

function nextBranches(branches: readonly string[], output: string): string[] {
  if (CONTINUATION_OUTPUTS.has(output.toLowerCase())) return [...branches];
  return [...branches, output];
}

/**
 * Traverse one active Dynamic Route version. Every reachable element is expanded
 * once; alternate incoming paths are retained as path summaries without
 * re-expanding converged subgraphs. Terminal end/END targets need no element.
 */
export function inventoryDynamicRoute(input: DynamicRouteVersionInput): DynamicRouteInventory {
  if (!SAFE_IDENTIFIER.test(input.versionId)) throw new DynamicRouteInventoryError('inventory_malformed_graph');
  const elements = parseElements(input.elements);
  const byId = new Map<string, DynamicRouteElement>();
  for (const element of elements) {
    if (byId.has(element.id)) throw new DynamicRouteInventoryError('inventory_duplicate_node');
    byId.set(element.id, element);
  }
  const starts = elements.filter((element) => element.type.toLowerCase() === 'start');
  if (starts.length !== 1) throw new DynamicRouteInventoryError('inventory_missing_start');

  const state = new Map<string, 'visiting' | 'visited'>();
  const suffixes = new Map<string, DynamicRoutePathSummary[]>();
  const models: DynamicRouteModelSummary[] = [];
  let reachableNodeCount = 0;

  const visit = (nodeId: string): DynamicRoutePathSummary[] => {
    if (isTerminalSentinel(nodeId)) return [];
    const node = byId.get(nodeId);
    if (!node) throw new DynamicRouteInventoryError('inventory_unresolved_edge');
    if (state.get(nodeId) === 'visiting') throw new DynamicRouteInventoryError('inventory_cycle');
    if (state.get(nodeId) === 'visited') return suffixes.get(nodeId)!.map((path) => ({ ...path, branches: [...path.branches] }));

    state.set(nodeId, 'visiting');
    reachableNodeCount += 1;
    const paths: DynamicRoutePathSummary[] = [];
    const appendPath = (path: DynamicRoutePathSummary): void => {
      if (paths.length >= MAX_INVENTORY_OUTPUT_PATHS) throw new DynamicRouteInventoryError('inventory_budget_exceeded');
      paths.push(path);
    };
    if (node.type.toLowerCase() === 'model') {
      models.push({
        nodeId: node.id,
        provider: node.properties?.provider as string,
        model: node.properties?.model as string,
      });
      appendPath({ modelNodeId: node.id, branches: [] });
    }
    if (node.type.toLowerCase() !== 'end') {
      for (const [output, edge] of Object.entries(node.outputs)) {
        const prefix = nextBranches([], output);
        for (const path of visit(edge.elementId)) {
          appendPath({ modelNodeId: path.modelNodeId, branches: [...prefix, ...path.branches] });
        }
      }
    }
    suffixes.set(nodeId, paths);
    state.set(nodeId, 'visited');
    return paths.map((path) => ({ ...path, branches: [...path.branches] }));
  };

  const paths = visit(starts[0].id);
  return { schemaVersion: 1, versionId: input.versionId, models, paths, reachableNodeCount };
}

export interface CommonLevelMapping {
  removePaths: string[];
  writes: Array<{ path: string; value: string | number | boolean | null }>;
}

export interface LegMappingEvidence {
  nodeId: string;
  evidence?: {
    current?: boolean;
    toolReplay?: boolean;
    ingress?: string;
  };
  levels: Partial<Record<PiReasoningLevel, CommonLevelMapping>>;
}

export type CommonMappingWarning =
  | 'missing_leg_evidence'
  | 'stale_leg_evidence'
  | 'missing_tool_replay_evidence'
  | 'incompatible_ingress'
  | 'heterogeneous_level_mapping';

export interface CommonMappingResult {
  levels: Partial<Record<PiReasoningLevel, CommonLevelMapping>>;
  warnings: CommonMappingWarning[];
  classification: 'Verified' | 'Heterogeneous' | 'Inconclusive';
}

const REASONING_LEVELS: readonly PiReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * A route level is common only when every reachable leg has current Pi
 * tool/replay evidence through the same ingress and the normalized mapping
 * serializes to exactly the same bytes. Evidence is advisory and never selects
 * or activates a route profile.
 */
export function deriveCommonMapping(legs: readonly LegMappingEvidence[]): CommonMappingResult {
  if (legs.length === 0) return { levels: {}, warnings: ['missing_leg_evidence'], classification: 'Inconclusive' };

  if (legs.some((leg) => leg.evidence?.current === false)) {
    return { levels: {}, warnings: ['stale_leg_evidence'], classification: 'Inconclusive' };
  }
  if (legs.some((leg) => leg.evidence?.current !== true)) {
    return { levels: {}, warnings: ['missing_leg_evidence'], classification: 'Inconclusive' };
  }
  if (legs.some((leg) => leg.evidence?.toolReplay !== true)) {
    return { levels: {}, warnings: ['missing_tool_replay_evidence'], classification: 'Inconclusive' };
  }
  const declaredIngresses = new Set(legs.map((leg) => leg.evidence?.ingress).filter((value): value is string => Boolean(value)));
  if (declaredIngresses.size !== 1 || !declaredIngresses.has('ai-gateway-chat-completions')) {
    return { levels: {}, warnings: ['incompatible_ingress'], classification: 'Inconclusive' };
  }

  const levels: Partial<Record<PiReasoningLevel, CommonLevelMapping>> = {};
  let missing = false;
  let heterogeneous = false;
  for (const level of REASONING_LEVELS) {
    const mappings = legs.map((leg) => leg.levels[level]);
    if (mappings.every((mapping) => mapping === undefined)) continue;
    if (mappings.some((mapping) => mapping === undefined)) {
      missing = true;
      continue;
    }
    const serialized = mappings.map((mapping) => JSON.stringify(mapping));
    if (serialized.some((value) => value !== serialized[0])) {
      heterogeneous = true;
      continue;
    }
    levels[level] = mappings[0] as CommonLevelMapping;
  }

  const warnings: CommonMappingWarning[] = [];
  if (missing) warnings.push('missing_leg_evidence');
  if (heterogeneous) warnings.push('heterogeneous_level_mapping');
  return {
    levels,
    warnings,
    classification: heterogeneous ? 'Heterogeneous' : Object.keys(levels).length > 0 && warnings.length === 0 ? 'Verified' : 'Inconclusive',
  };
}
