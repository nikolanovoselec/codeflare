/**
 * Codeflare Pi first-party graphify tools (REQ-AGENT-023).
 *
 * Pi has no MCP client, so graphify is exposed as NATIVE Pi tools via
 * pi.registerTool (mirroring browser-run.ts). This is the first-party replacement
 * for the third-party @gaodes/pi-graphify wrapper: it shells the SAME `graphify`
 * CLI that Claude's MCP server runs (graphify.serve and the CLI both call
 * graphify.serve._query_graph_text), so Pi and Claude query through ONE engine
 * with identical ranking and output — no divergent third-party reimplementation.
 *
 * Graph resolution (the agent never passes a path): the active cloned repo's
 * graphify-out/graph.json wins; otherwise the merged global graph
 * (~/.graphify/global-graph.json — vault + every globally-added repo), so
 * vault/global/cross-repo questions resolve even with no cloned repo.
 *
 * Gating: the tool surface is ambient in every session mode (REQ-AGENT-023 AC2);
 * each tool fails soft (a clear "build a graph first" message) when no graph
 * exists yet, so a graphless session is harmless.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";

// Pi extension SDK surface, declared inline (mirrors browser-run.ts /
// codeflare-pi.ts) so this file needs no Pi SDK installed in Codeflare's repo.
type ToolContent = { type: "text"; text: string };
type AgentToolResult = { content: ToolContent[]; details?: unknown; isError?: boolean };
type ExtensionAPI = { registerTool(tool: unknown): void };

const GLOBAL_GRAPH = "/home/user/.graphify/global-graph.json";
const ACTIVE_REPO_SENTINEL = "/home/user/.cache/codeflare-hooks/graphify-active-cwd";
// graphify can emit very large subgraphs; cap tool output so one query cannot
// blow up the agent's context window. Truncation is flagged in the text.
const MAX_OUTPUT_CHARS = 120_000;

function readTrimmed(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

type ResolvedGraph = { graphPath: string; cwd: string; scope: string };

// Active cloned-repo graph wins; otherwise the merged global graph. Returns the
// graph path plus the cwd graphify should run from (the repo for a repo graph,
// /home/user for the global graph).
function resolveGraph(): ResolvedGraph | undefined {
  const repo = readTrimmed(ACTIVE_REPO_SENTINEL);
  if (repo && existsSync(join(repo, "graphify-out", "graph.json"))) {
    return { graphPath: join(repo, "graphify-out", "graph.json"), cwd: repo, scope: `repo ${basename(repo)}` };
  }
  if (existsSync(GLOBAL_GRAPH)) {
    return { graphPath: GLOBAL_GRAPH, cwd: "/home/user", scope: "merged global graph (vault + all repos)" };
  }
  return undefined;
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const chars = Array.from(text);
  if (chars.length <= MAX_OUTPUT_CHARS) return text;
  return `${chars.slice(0, MAX_OUTPUT_CHARS).join("")}\n\n[... truncated ${
    chars.length - MAX_OUTPUT_CHARS
  } chars; narrow the question or lower --budget ...]`;
}

function runGraphify(args: string[], cwd: string): { ok: true; text: string } | { ok: false; error: string } {
  try {
    const out = execFileSync("graphify", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    }).trim();
    return { ok: true, text: out };
  } catch (err) {
    const stderr = typeof (err as { stderr?: unknown })?.stderr === "string"
      ? (err as { stderr: string }).stderr
      : String((err as { stderr?: unknown })?.stderr ?? "");
    return { ok: false, error: stderr.trim() || (err instanceof Error ? err.message : String(err)) };
  }
}

function errorResult(message: string): AgentToolResult {
  return { content: [{ type: "text", text: message }], isError: true, details: {} };
}

// Resolve the graph, run the graphify subcommand against it, and shape the result.
function runResolved(args: string[], details: Record<string, unknown>): AgentToolResult {
  const resolved = resolveGraph();
  if (!resolved) {
    return errorResult(
      "No graphify graph found for the active repo or the global graph. Build one with the graphify skill (/graphify <path>) before querying.",
    );
  }
  const result = runGraphify([...args, "--graph", resolved.graphPath], resolved.cwd);
  if (!result.ok) {
    return { content: [{ type: "text", text: `graphify failed: ${result.error}` }], isError: true, details: { ...details, graph: resolved.graphPath } };
  }
  return {
    content: [{ type: "text", text: truncate(result.text) }],
    // graph + repoCwd let the graphify skill run `graphify save-result` against
    // the SAME graph the answer came from (the feedback loop, REQ-AGENT-023).
    details: { ...details, graph: resolved.graphPath, scope: resolved.scope, repoCwd: resolved.cwd },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphify_query",
    label: "Graphify: Query",
    description:
      "Query the codebase knowledge graph instead of grepping. BFS for broad context, DFS to trace a specific path. Prefer this for architecture / dependency / call-flow / 'where is X implemented' questions. Resolves the active repo's graph, else the merged global graph (vault + all repos).",
    parameters: Type.Object({
      question: Type.String({ description: "Natural-language question about the codebase or corpus." }),
      mode: Type.Optional(
        Type.Union([Type.Literal("bfs"), Type.Literal("dfs")], {
          description: "bfs = broad context (default); dfs = trace a specific dependency/call path.",
        }),
      ),
      budget: Type.Optional(Type.Number({ description: "Max answer tokens (default 2000)." })),
    }),
    promptGuidelines: [
      "Reach for graphify_query before broad text search on architecture/dependency/call-flow questions.",
      "After answering from the result, persist the Q&A with `graphify save-result` (see the graphify skill) so the next graph update folds it back in.",
    ],
    async execute(_id: string, params: { question: string; mode?: string; budget?: number }): Promise<AgentToolResult> {
      if (!params.question?.trim()) return errorResult("graphify_query needs a question.");
      const mode = params.mode === "dfs" ? "dfs" : "bfs";
      const budget = typeof params.budget === "number" && Number.isFinite(params.budget) ? Math.floor(params.budget) : 2000;
      return runResolved(["query", params.question, ...(mode === "dfs" ? ["--dfs"] : []), "--budget", String(budget)], {
        question: params.question,
        mode,
      });
    },
  });

  pi.registerTool({
    name: "graphify_path",
    label: "Graphify: Path",
    description: "Find the shortest path between two named concepts/nodes in the codebase knowledge graph, with the relation on each hop.",
    parameters: Type.Object({
      from: Type.String({ description: "Source concept/node label." }),
      to: Type.String({ description: "Target concept/node label." }),
    }),
    async execute(_id: string, params: { from: string; to: string }): Promise<AgentToolResult> {
      if (!params.from?.trim() || !params.to?.trim()) return errorResult("graphify_path needs both `from` and `to`.");
      return runResolved(["path", params.from, params.to], { from: params.from, to: params.to });
    },
  });

  pi.registerTool({
    name: "graphify_explain",
    label: "Graphify: Explain",
    description: "Plain-language explanation of a single node in the codebase knowledge graph and everything it connects to.",
    parameters: Type.Object({
      concept: Type.String({ description: "The concept/node to explain." }),
    }),
    async execute(_id: string, params: { concept: string }): Promise<AgentToolResult> {
      if (!params.concept?.trim()) return errorResult("graphify_explain needs a `concept`.");
      return runResolved(["explain", params.concept], { concept: params.concept });
    },
  });
}
