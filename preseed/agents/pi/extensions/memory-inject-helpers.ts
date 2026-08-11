import { capRenderedBytes } from "./memory-vault-helpers";

/**
 * Pure logic for first-prompt memory injection (REQ-MEM-013, Pi runtime).
 *
 * The scoring, the keyword rule and the rendered shape are held identical to the
 * Claude hook's: the two runtimes must surface the same prior context for the
 * same prompt, or "what the agent already knew" becomes runtime-dependent.
 */

export const MEMORY_INJECT_MIN_PROMPT_CHARS = 20;
export const MEMORY_INJECT_MAX_NODES = 10;
export const MEMORY_INJECT_MAX_RENDERED_BYTES = 4096;
/**
 * Shared with the Claude hook, and measured on both runtimes rather than
 * inherited: the same 40MB graph costs 148MB RSS / 469ms under Node's
 * JSON.parse and 136MB / 560ms under CPython's json, so one ceiling is honest
 * for both. Unlike the hook's bounded subprocess, this parse runs in-process
 * and blocks the turn while it happens - about 1.2s at the ceiling - which is
 * why it is spent once per session rather than per prompt.
 */
export const MEMORY_INJECT_MAX_GRAPH_BYTES = 104857600;

const KEYWORD_MIN_CHARS = 4;
const KEYWORD_LIMIT = 10;
const PROMPT_SCAN_CHARS = 200;
const DESCRIPTION_INLINE_LIMIT = 150;

export interface GraphNode {
  label?: string;
  source?: string;
  description?: string;
}

/**
 * Unique words of four characters or more from the head of the prompt.
 *
 * Sorted and capped the same way the shell pipeline is (`sort -u | head -10`),
 * so both runtimes send the graph the same signal: short words match too much,
 * and the tail of a long prompt is usually restatement rather than subject.
 */
export function extractKeywords(prompt: string): string[] {
  const words = prompt
    .slice(0, PROMPT_SCAN_CHARS)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word.length >= KEYWORD_MIN_CHARS);
  return [...new Set(words)].sort().slice(0, KEYWORD_LIMIT);
}

/**
 * The highest-scoring nodes, best first.
 *
 * A label hit outweighs a description hit outweighs a source hit, and each
 * keyword scores at most once per node - a keyword repeated across all three
 * fields is one signal, not three.
 */
export function selectNodes(nodes: readonly GraphNode[], keywords: readonly string[]): GraphNode[] {
  if (keywords.length === 0) return [];
  const scored: Array<{ score: number; node: GraphNode }> = [];
  for (const node of nodes) {
    const label = (node.label ?? "").toLowerCase();
    const description = (node.description ?? "").toLowerCase();
    const source = (node.source ?? "").toLowerCase();
    let score = 0;
    for (const keyword of keywords) {
      if (label.includes(keyword)) score += 10;
      else if (description.includes(keyword)) score += 3;
      else if (source.includes(keyword)) score += 1;
    }
    if (score > 0) scored.push({ score, node });
  }
  return scored
    .sort((left, right) => right.score - left.score)
    .slice(0, MEMORY_INJECT_MAX_NODES)
    .map((entry) => entry.node);
}

/** The injected text, or null when nothing matched. */
export function renderInjection(nodes: readonly GraphNode[]): string | null {
  if (nodes.length === 0) return null;
  const lines = nodes.map((node) => {
    const description = node.description ?? "";
    const source = node.source ?? "";
    let entry = `- ${node.label ?? "?"}`;
    if (source) entry += ` [${source}]`;
    if (description && description.length < DESCRIPTION_INLINE_LIMIT) entry += `: ${description}`;
    return entry;
  });
  const vaultHits = nodes.filter((node) => (node.source ?? "").toLowerCase().includes("vault/"));
  const tail = vaultHits.length > 0
    ? [`(${vaultHits.length} vault note(s) matched - consider reading them for detailed context)`]
    : [];
  return capRenderedBytes([
    "Prior context matching your query:",
    ...lines,
    ...tail,
    "",
    "Use graphify_query or graphify_explain to drill into any of these for more detail.",
  ].join("\n"), MEMORY_INJECT_MAX_RENDERED_BYTES);
}

export default function () {
  // Helper module only; loaded by Pi extension scanner as a no-op extension.
}
