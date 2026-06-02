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
      ? ["use existing graph", "AST-only update", "skip"]
      : ["build graph", "skip"],
  };
}

export function renderGraphifyCloneDirective(action: GraphifyCloneAction): string {
  if (action.mode === "existing-graph") {
    return [
      `Repository cloned at ${action.repo} and an existing graphify graph was found at ${action.repo}/graphify-out/graph.json.`,
      "Graph layout: repo graphs live under each checked-out repo's graphify-out/ directory; the Vault graph is /home/user/Vault/graphify-out/graph.json; the merged global graph is /home/user/.graphify/global-graph.json. There is no /home/user/workspace/graphify-out graph.",
      "Check freshness by comparing graph.json built_at_commit to git HEAD.",
      "Do not ask the user to rebuild just because a graph exists. If stale or freshness is unknown, refresh the AST portion with upstream Graphify via the local safety wrapper:",
      `\`bash /home/user/.pi/agent/scripts/safe-graphify-update.sh ${action.repo}\``,
      "Full semantic refresh is owned by the `/graphify` skill after it detects the corpus and asks the build-mode question; semantic extraction must use Pi Agent subagents from this running session, never a headless backend/API-key extractor.",
      `If fresh, print an information message only, then use \`graphify_query\`, \`graphify_path\`, and \`graphify_explain\` before broad text search. Codeflare Pi automatically retries those native tools against \`${action.repo}/graphify-out/graph.json\` if the first attempt looks at the workspace root; if that retry still fails, fall back to the CLI with \`--graph ${action.repo}/graphify-out/graph.json\`.`,
    ].join("\n");
  }
  return [
    `Repository cloned at ${action.repo}; no graphify graph exists yet at ${action.repo}/graphify-out/graph.json.`,
    "Graph layout: repo graphs live under each checked-out repo's graphify-out/ directory; the Vault graph is /home/user/Vault/graphify-out/graph.json; the merged global graph is /home/user/.graphify/global-graph.json. There is no /home/user/workspace/graphify-out graph.",
    `Before doing anything else with this repo, ask the user a single YES/NO question: "Build a graphify knowledge graph for ${action.repo}?"`,
    "If yes, invoke `/graphify` from the repo root. Do NOT ask about AST-only vs Full at clone time; the graphify skill asks that after it runs upstream Graphify detection and can show corpus counts.",
    "If no, proceed without a graph. Do not use headless backend/API-key extraction for this interactive workflow; semantic extraction must use Pi Agent subagents from this running session.",
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
