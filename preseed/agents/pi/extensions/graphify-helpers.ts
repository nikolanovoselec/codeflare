export type GraphifyCloneAction = {
  repo: string;
  hasGraph: boolean;
  mode: "existing-graph" | "missing-graph";
  freshness?: "fresh" | "stale" | "unknown";
  choices: string[];
};

export function graphifyCloneAction(repo: string, hasGraph: boolean, freshness?: "fresh" | "stale" | "unknown"): GraphifyCloneAction {
  return {
    repo,
    hasGraph,
    mode: hasGraph ? "existing-graph" : "missing-graph",
    freshness: hasGraph ? (freshness ?? "unknown") : undefined,
    choices: hasGraph
      ? ["use existing graph as-is", "Full repo AST-only update", "Full repo semantic refresh"]
      : ["Full repo AST-only build", "Full repo semantic build", "skip"],
  };
}

export function renderGraphifyCloneDirective(action: GraphifyCloneAction): string {
  if (action.mode === "existing-graph") {
    const lead = action.freshness === "stale"
      ? `Repository cloned at ${action.repo}; the existing graphify graph at ${action.repo}/graphify-out/graph.json is STALE (built at a commit other than git HEAD) and should be refreshed.`
      : `Repository cloned at ${action.repo} and an existing graphify graph was found at ${action.repo}/graphify-out/graph.json.`;
    return [
      lead,
      "Graph layout: repo graphs live under each checked-out repo's graphify-out/ directory; the Vault graph is /home/user/Vault/graphify-out/graph.json; the merged global graph is /home/user/.graphify/global-graph.json. There is no /home/user/workspace/graphify-out graph.",
      "Check freshness by comparing graph.json built_at_commit to git HEAD.",
      "Do not update the graph automatically. If the graph is stale or freshness is unknown, ask the user which graph action to take before running any graph update:",
      "1. Use the existing graph as-is — no files are modified.",
      `2. Full repo AST-only update — run \`bash /home/user/.pi/agent/scripts/safe-graphify-update.sh ${action.repo}\` only after the user explicitly chooses this option.`,
      "3. Full repo semantic refresh — invoke the `/graphify` skill from the repo root and tell it the user chose Full semantic intent at clone time; after detection, the skill must show the actual uncached file/subagent counts and get confirmation before dispatching semantic subagents. Semantic extraction must use Pi Agent subagents from this running session, never a headless backend/API-key extractor.",
      `If fresh, print an information message only, then use \`graphify_query\`, \`graphify_path\`, and \`graphify_explain\` before broad text search. Codeflare Pi automatically retries those native tools against \`${action.repo}/graphify-out/graph.json\` if the first attempt looks at the workspace root; if that retry still fails, fall back to the CLI with \`--graph ${action.repo}/graphify-out/graph.json\`.`,
      "Never run the AST update wrapper or a semantic refresh until the user has chosen the corresponding update option.",
    ].join("\n");
  }
  return [
    `Repository cloned at ${action.repo}; no graphify graph exists yet at ${action.repo}/graphify-out/graph.json.`,
    "Graph layout: repo graphs live under each checked-out repo's graphify-out/ directory; the Vault graph is /home/user/Vault/graphify-out/graph.json; the merged global graph is /home/user/.graphify/global-graph.json. There is no /home/user/workspace/graphify-out graph.",
    "Before doing anything else with this repo, ask the user which graph action to take. Offer exactly these choices: Full repo AST-only build, Full repo semantic build, or no graph action.",
    "If the user chooses Full repo AST-only build, invoke `/graphify` from the repo root and tell the skill the user already selected AST-only so it does not ask the same mode question again after detection.",
    "If the user chooses Full repo semantic build, invoke `/graphify` from the repo root and tell the skill the user chose Full semantic intent at clone time; after detection, the skill must show the actual uncached file/subagent counts and get confirmation before dispatching semantic subagents.",
    "If the user chooses no graph action, proceed without a graph and do not modify `graphify-out`. Do not use headless backend/API-key extraction for this interactive workflow; semantic extraction must use Pi Agent subagents from this running session.",
  ].join("\n");
}

export function graphifyCloneDirective(repo: string, hasGraph: boolean): string {
  return renderGraphifyCloneDirective(graphifyCloneAction(repo, hasGraph));
}

export function isFailedToolExecution(event: any): boolean {
  return event?.isError === true || event?.error === true || String(event?.status ?? "").toLowerCase() === "error";
}

export function graphifyPromptMarker(repo: string, sessionId = "default"): string {
  const safe = `${sessionId}:${repo}`.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return `/tmp/codeflare-graphify-prompted-${safe}`;
}

// Zero-or-more leading `VAR=value ` assignments (quoted or bare), plus an optional `env `
// wrapper, before the verb — mirrors review-helpers BOUNDARY_ANCHOR so `BROWSER="" gh repo
// clone`, `GIT_TERMINAL_PROMPT=0 git clone`, and `env BROWSER="" gh repo clone` all match.
// Shared by isGitClone (codeflare-pi.ts) and cloneTargetPath so the prefix is consumed
// BEFORE destination parsing.
export const ENV_PREFIX = String.raw`(?:env[ \t]+)?(?:[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|\S*)[ \t]+)*`;

export function effectiveCwdForCommand(command: string, cwd: string): string {
  const match = command.match(/(?:^|[;&|\n]\s*)cd\s+([^;&|\n]+)\s*&&/);
  if (!match) return cwd;
  const dir = match[1].trim().replace(/^(\"|')(.*)\1$/, "$2");
  return dir.startsWith("/") ? dir : `${cwd.replace(/\/$/, "")}/${dir}`;
}

function shellWords(input: string): string[] {
  return input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^(\"|')(.*)\1$/, "$2")) ?? [];
}

function resolveMaybeRelative(path: string, cwd: string): string | undefined {
  const trimmed = path.trim();
  if (!trimmed || /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\})/.test(trimmed)) return undefined;
  return trimmed.startsWith("/") ? trimmed : `${cwd.replace(/\/$/, "")}/${trimmed}`;
}

function cloneTargetPathFromOutput(output: string | undefined, cwd: string): string | undefined {
  if (!output) return undefined;
  const match = output.match(/Cloning into ['"]([^'"]+)['"]\.\.\./);
  return match?.[1] ? resolveMaybeRelative(match[1], cwd) : undefined;
}

const OPTIONS_WITH_VALUE = new Set(["-b", "--branch", "--depth", "--filter", "--origin", "-o", "--template", "--reference", "--reference-if-able", "--separate-git-dir", "--jobs", "-j", "--config", "-c"]);

export function cloneTargetPath(command: string, cwd: string, output?: string): string | undefined {
  const outputTarget = cloneTargetPathFromOutput(output, cwd);
  if (outputTarget) return outputTarget;
  const effectiveCwd = effectiveCwdForCommand(command, cwd);
  const match = command.match(new RegExp(String.raw`(?:^|[;&|\n]\s*)(?:cd\s+[^;&|\n]+\s*&&\s*)?` + ENV_PREFIX + String.raw`(?:git\s+clone|gh\s+repo\s+clone)\s+(.+?)(?:[;&|\n]|$)`));
  if (!match) return undefined;
  const tokens = shellWords(match[1]);
  const positional: string[] = [];
  let passthrough = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!passthrough && token === "--") {
      passthrough = true;
      continue;
    }
    if (!passthrough && token.startsWith("--") && token.includes("=")) continue;
    if (!passthrough && OPTIONS_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (!passthrough && token.startsWith("-")) continue;
    positional.push(token);
  }
  if (positional.length === 0) return undefined;
  const explicitDest = positional[1];
  const source = positional[0];
  const dest = explicitDest ?? source.split("/").pop()?.replace(/\.git$/, "");
  if (!dest) return undefined;
  return resolveMaybeRelative(dest, effectiveCwd);
}

export type GraphifyClonePromptDecision = {
  repo: string;
  marker: string;
  action: GraphifyCloneAction;
};

export function graphifyClonePromptDecision(options: {
  command: string;
  cwd: string;
  sessionId: string;
  failed: boolean;
  output?: string;
  findGitRoot: (path: string) => string | undefined;
  hasGraph: (repo: string) => boolean;
  exists: (path: string) => boolean;
  freshness?: (repo: string) => "fresh" | "stale" | "unknown";
}): GraphifyClonePromptDecision | undefined {
  if (options.failed) return undefined;
  const clonedPath = cloneTargetPath(options.command, options.cwd, options.output);
  if (!clonedPath) return undefined;
  if (!options.exists(clonedPath)) return undefined;          // target must exist on disk
  const repo = options.findGitRoot(clonedPath);
  if (!repo) return undefined;                                // must be a real git work-tree (no `?? clonedPath` fallback)
  const freshness = options.hasGraph(repo) ? (options.freshness?.(repo) ?? "unknown") : undefined;
  return {
    repo,
    marker: graphifyPromptMarker(repo, options.sessionId),
    action: graphifyCloneAction(repo, options.hasGraph(repo), freshness),
  };
}

export type ResolvedGraph = { graphPath: string; cwd: string; scope: string };

// Pure precedence (REQ-AGENT-023) behind graphify-native's graph resolution: the cwd repo graph
// wins, then the active-repo sentinel's graph, then the merged global graph. cwd is FIRST because
// graphify-native is ambient in every session mode and in review lanes — both run IN the repo,
// where the advanced-only active-repo sentinel (written by codeflare-pi.ts) is absent or points at
// a stale/other repo; trusting the sentinel first would query the wrong repo's (or the global) graph.
export function pickGraphSource(candidates: {
  cwdGraph?: ResolvedGraph;
  sentinelGraph?: ResolvedGraph;
  globalGraph?: ResolvedGraph;
}): ResolvedGraph | undefined {
  return candidates.cwdGraph || candidates.sentinelGraph || candidates.globalGraph;
}

export default function () {
  // Pure helper module for codeflare-pi.ts; no extension registration needed.
}
