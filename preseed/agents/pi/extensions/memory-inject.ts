/**
 * First-prompt memory injection for Pi (REQ-MEM-013).
 *
 * On the first real prompt of a session the unified graphify graph is queried
 * with keywords from that prompt and the matching nodes are injected into the
 * turn, so the agent starts with the prior decisions, vault notes and code
 * references that bear on what was just asked - without having to know to go
 * looking. Pi previously only announced that the graph existed and left the
 * querying to the agent; the Claude runtime has done the querying since
 * REQ-MEM-013 shipped.
 *
 * `before_agent_start` is the surface: it fires after the prompt is submitted
 * and before the agent loop, and its result carries a message into that turn -
 * the same position Claude's UserPromptSubmit `additionalContext` occupies.
 *
 * Fail-safe: any error leaves the turn untouched. Injection is an advantage,
 * never a gate.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isChildSessionFirstLine, isChildSessionHeader, isSyntheticPrompt, sessionId } from "./memory-vault-helpers";
import {
  extractKeywords,
  renderInjection,
  selectNodes,
  MEMORY_INJECT_MAX_GRAPH_BYTES,
  MEMORY_INJECT_MIN_PROMPT_CHARS,
  type GraphNode,
} from "./memory-inject-helpers";

const USER_HOME = "/home/user";

export const MEMORY_INJECT_TYPE = "memory-context-inject";

export interface MemoryInjectPi {
  on(event: string, handler: (event: any, ctx: any) => any): void;
}

export interface MemoryInjectDependencies {
  globalGraph: string;
  sentinelDir: string;
  maxGraphBytes: number;
}

/**
 * The ceiling is resolved from the environment once, here, rather than read
 * inside the resolver: a caller that supplies a ceiling in the dependency
 * struct must not have it silently outranked by an ambient variable. A
 * non-numeric or non-positive override falls back to the default, so the guard
 * fails closed rather than disappearing.
 */
function configuredCeiling(): number {
  const override = Number(process.env.MEMORY_INJECT_MAX_GRAPH_BYTES);
  return Number.isInteger(override) && override > 0 ? override : MEMORY_INJECT_MAX_GRAPH_BYTES;
}

const defaultDependencies: MemoryInjectDependencies = {
  globalGraph: join(USER_HOME, ".graphify", "global-graph.json"),
  sentinelDir: "/tmp/.memory-counter",
  maxGraphBytes: configuredCeiling(),
};

// Same shape memory-vault.ts uses: the live header when the runtime has one,
// the persisted first line otherwise.
function isChildSession(ctx: any): boolean {
  try {
    const header = ctx?.sessionManager?.getHeader?.();
    if (header) return isChildSessionHeader(header);
  } catch { /* fall through to persisted header */ }
  try {
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    if (!sessionFile || !existsSync(sessionFile)) return false;
    return isChildSessionFirstLine(readFileSync(sessionFile, "utf8").split("\n", 1)[0]);
  } catch {
    return false;
  }
}

/**
 * The graph to query: the unified one, or the active repo's when the unified
 * one is absent or itself past the ceiling. Null when no candidate fits.
 *
 * An over-ceiling candidate is skipped rather than returned as a refusal: a
 * unified graph too large to parse must not disable injection while a smaller
 * repo graph sits there ready - that is the silent disable this exists to end.
 * The ceiling is a memory guard, since the graph is parsed whole, and it is a
 * lever rather than a constant so a graph that outgrows the default cannot
 * quietly turn the feature off.
 */
export function resolveGraphPath(
  dependencies: MemoryInjectDependencies,
  cwd: string,
): string | null {
  const candidates = [dependencies.globalGraph, join(cwd, "graphify-out", "graph.json")];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).size <= dependencies.maxGraphBytes) return candidate;
    } catch { /* try the next candidate */ }
  }
  return null;
}

export function buildInjection(
  dependencies: MemoryInjectDependencies,
  prompt: string,
  cwd: string,
): string | null {
  if (prompt.trim().length < MEMORY_INJECT_MIN_PROMPT_CHARS) return null;
  const keywords = extractKeywords(prompt);
  if (keywords.length === 0) return null;

  const graphPath = resolveGraphPath(dependencies, cwd);
  if (!graphPath) return null;

  let nodes: GraphNode[];
  try {
    const parsed = JSON.parse(readFileSync(graphPath, "utf8"));
    nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
  } catch {
    return null;
  }
  return renderInjection(selectNodes(nodes, keywords));
}

export function registerMemoryInject(pi: MemoryInjectPi, dependencies: MemoryInjectDependencies): void {
  pi.on("before_agent_start", (event, ctx) => {
    try {
      if (isChildSession(ctx)) return undefined;
      const session = sessionId(ctx);
      if (!session) return undefined;

      // Existence first: every prompt after the first pays only this stat.
      const sentinel = join(dependencies.sentinelDir, `${session}.inject-lock`);
      if (existsSync(sentinel)) return undefined;

      const prompt = String(event?.prompt ?? "");
      if (isSyntheticPrompt(prompt)) return undefined;

      const content = buildInjection(dependencies, prompt, String(ctx?.cwd ?? process.cwd()));
      if (!content) return undefined;

      // Claimed only after a query that matched, and atomically: a miss must not
      // spend the session's one shot, and two turns racing must not both inject.
      // recursive:false on the sentinel itself is what makes the claim exclusive;
      // the parent is created separately because it may not exist yet and
      // extension execution order is not guaranteed.
      try {
        mkdirSync(dependencies.sentinelDir, { recursive: true });
        mkdirSync(sentinel, { recursive: false });
      } catch {
        return undefined;
      }

      return { message: { customType: MEMORY_INJECT_TYPE, content, display: false, details: { graph: dependencies.globalGraph } } };
    } catch {
      return undefined;
    }
  });
}

export default function memoryInject(pi: ExtensionAPI): void {
  registerMemoryInject(pi as unknown as MemoryInjectPi, defaultDependencies);
}
