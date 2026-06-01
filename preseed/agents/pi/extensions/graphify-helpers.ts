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
      "Check freshness by comparing graph.json built_at_commit to git HEAD.",
      "If stale or freshness is unknown, ask the user to choose one option before doing more work in this repo:",
      `1. AST-only update — recommended default for an existing graph; free, local, no LLM/API key; run \`bash /home/user/.pi/agent/scripts/safe-graphify-update.sh ${action.repo}\`.`,
      "2. Full semantic + AST refresh — refresh local AST, then use bounded Pi Agent subagent waves for docs/papers/images with the current main-session model unless the user explicitly picks another model, then merge and cluster.",
      `If fresh, print an information message only, then use \`graphify_query\`, \`graphify_path\`, and \`graphify_explain\` before broad text search. Codeflare Pi automatically retries those native tools against \`${action.repo}/graphify-out/graph.json\` if the first attempt looks at the workspace root; if that retry still fails, fall back to the CLI with \`--graph ${action.repo}/graphify-out/graph.json\`.`,
    ].join("\n");
  }
  return [
    `Repository cloned at ${action.repo}; no graphify graph exists yet at ${action.repo}/graphify-out/graph.json.`,
    "Graph layout: repo graphs live under each checked-out repo's graphify-out/ directory; the Vault graph is /home/user/Vault/graphify-out/graph.json; the merged global graph is /home/user/.graphify/global-graph.json. There is no /home/user/workspace/graphify-out graph.",
    "Before doing anything else with this repo, ask the user to choose one option:",
    `1. Create AST-only Graphify graph — recommended default for first build; free, local, no LLM/API key; run \`bash /home/user/.pi/agent/scripts/build-graphify-ast.sh ${action.repo}\` so graph.json, GRAPH_REPORT.md, and graph.html are generated.`,
    "2. Create full semantic + AST Graphify graph — start from the same local AST first-build path, then use bounded Pi Agent subagent waves for docs/papers/images with the current main-session model unless the user explicitly picks another model, then merge and cluster.",
    "Do not use headless `graphify extract --backend ...` for this interactive workflow.",
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
  const match = command.match(/(?:^|[;&|\n]\s*)(?:cd\s+[^;&|\n]+\s*&&\s*)?(?:git\s+clone|gh\s+repo\s+clone)\s+(.+?)(?:[;&|\n]|$)/);
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
}): GraphifyClonePromptDecision | undefined {
  if (options.failed) return undefined;
  const clonedPath = cloneTargetPath(options.command, options.cwd, options.output);
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
