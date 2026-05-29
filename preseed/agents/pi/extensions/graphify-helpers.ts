export type GraphifyCloneAction = {
  repo: string;
  hasGraph: boolean;
  mode: "existing-graph" | "missing-graph";
  choices: string[];
};

export function graphifyCloneAction(repo: string, hasGraph: boolean): GraphifyCloneAction {
  return {
    repo,
    hasGraph,
    mode: hasGraph ? "existing-graph" : "missing-graph",
    choices: hasGraph
      ? ["check freshness", "AST-only update", "Full semantic + AST refresh", "skip"]
      : ["AST-only build", "Full semantic + AST build", "skip"],
  };
}

export function renderGraphifyCloneDirective(action: GraphifyCloneAction): string {
  if (action.mode === "existing-graph") {
    return [
      `Repository cloned at ${action.repo} and an existing graphify graph was found at ${action.repo}/graphify-out/graph.json.`,
      "Graph layout: repo graphs live under each checked-out repo's graphify-out/ directory; the Vault graph is /home/user/Vault/graphify-out/graph.json; the merged global graph is /home/user/.graphify/global-graph.json. There is no /home/user/workspace/graphify-out graph.",
      "Check whether source files changed since the graph was built by comparing graph.json built_at_commit to git HEAD.",
      `If stale, ask the user whether to run the free AST-only update (\`bash /home/user/.pi/agent/scripts/safe-graphify-update.sh ${action.repo}\`) or a full AST + semantic refresh using Pi Agent subagents.`,
      `If fresh, use \`graphify_query\`, \`graphify_path\`, and \`graphify_explain\` before broad text search. Codeflare Pi automatically retries those native tools against \`${action.repo}/graphify-out/graph.json\` if the first attempt looks at the workspace root; if that retry still fails, fall back to the CLI with \`--graph ${action.repo}/graphify-out/graph.json\`.`,
    ].join("\n");
  }
  return [
    `Repository cloned at ${action.repo}; no graphify graph exists yet at ${action.repo}/graphify-out/graph.json.`,
    "Graph layout: repo graphs live under each checked-out repo's graphify-out/ directory; the Vault graph is /home/user/Vault/graphify-out/graph.json; the merged global graph is /home/user/.graphify/global-graph.json. There is no /home/user/workspace/graphify-out graph.",
    "Ask the user to choose a graph build mode before long-running work:",
    `1. AST-only — free, local, no LLM/API key; builds structural code graph with \`bash /home/user/.pi/agent/scripts/safe-graphify-update.sh ${action.repo}\` so graph.html is generated unless the user explicitly asks to skip visualization.`,
    "2. Full semantic + AST — local AST plus bounded Pi Agent subagent waves for docs/papers/images, then merge and cluster.",
    "Do not use headless `graphify extract --backend deepseek` for this interactive workflow.",
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

export function effectiveCwdForCommand(command: string, cwd: string): string {
  const match = command.match(/(?:^|[;&|]\s*)cd\s+([^;&|]+)\s*&&/);
  if (!match) return cwd;
  const dir = match[1].trim().replace(/^(\"|')(.*)\1$/, "$2");
  return dir.startsWith("/") ? dir : `${cwd.replace(/\/$/, "")}/${dir}`;
}

function shellWords(input: string): string[] {
  return input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => token.replace(/^(\"|')(.*)\1$/, "$2")) ?? [];
}

const OPTIONS_WITH_VALUE = new Set(["-b", "--branch", "--depth", "--filter", "--origin", "-o", "--template", "--reference", "--reference-if-able", "--separate-git-dir", "--jobs", "-j", "--config", "-c"]);

export function cloneTargetPath(command: string, cwd: string): string | undefined {
  const effectiveCwd = effectiveCwdForCommand(command, cwd);
  const match = command.match(/(?:^|[;&|]\s*)(?:cd\s+[^;&|]+\s*&&\s*)?(?:git\s+clone|gh\s+repo\s+clone)\s+(.+?)(?:[;&|]|$)/);
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
  return dest.startsWith("/") ? dest : `${effectiveCwd.replace(/\/$/, "")}/${dest}`;
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
  findGitRoot: (path: string) => string | undefined;
  hasGraph: (repo: string) => boolean;
}): GraphifyClonePromptDecision | undefined {
  if (options.failed) return undefined;
  const clonedPath = cloneTargetPath(options.command, options.cwd);
  if (!clonedPath) return undefined;
  const repo = options.findGitRoot(clonedPath) ?? clonedPath;
  return {
    repo,
    marker: graphifyPromptMarker(repo, options.sessionId),
    action: graphifyCloneAction(repo, options.hasGraph(repo)),
  };
}

export default function () {
  // Pure helper module for codeflare-pi.ts; no extension registration needed.
}
