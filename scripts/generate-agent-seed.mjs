#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const claudeDir = path.join(rootDir, 'preseed/agents/claude');
const piDir = path.join(rootDir, 'preseed/agents/pi');
const outputFile = path.join(rootDir, 'src/lib/agent-seed.generated.ts');

// ---------------------------------------------------------------------------
// Agent configurations
// ---------------------------------------------------------------------------

const AGENT_CONFIGS = {
  codex: {
    instructionsKey: '.codex/AGENTS.md',
    skillsPrefix: '.codex/skills',
    agentsPrefix: null,
    agentExtension: null,
    homePath: '~/.codex',
  },
  // Antigravity (`agy`) reads global config from ~/.gemini: GEMINI.md (auto-loaded
  // across all workspaces), skills/, and agents/ all remain the current convention
  // (the .gemini -> .agents migration is workspace-scoped only; codeflare seeds the
  // home directory). See REQ-AGENT-007.
  antigravity: {
    instructionsKey: '.gemini/GEMINI.md',
    skillsPrefix: '.gemini/skills',
    agentsPrefix: '.gemini/agents',
    agentExtension: '.md',
    homePath: '~/.gemini',
  },
  copilot: {
    instructionsKey: '.copilot/copilot-instructions.md',
    skillsPrefix: null,
    agentsPrefix: '.copilot/agents',
    agentExtension: '.agent.md',
    homePath: '~/.copilot',
  },
  opencode: {
    instructionsKey: '.config/opencode/AGENTS.md',
    skillsPrefix: '.config/opencode/skills',
    agentsPrefix: '.config/opencode/agents',
    agentExtension: '.md',
    homePath: '~/.config/opencode',
  },
  pi: {
    instructionsKey: '.pi/agent/AGENTS.md',
    skillsPrefix: '.pi/agent/skills',
    agentsPrefix: '.pi/agent/agents',
    agentExtension: '.md',
    homePath: '~/.pi/agent',
  },
};

const TOOL_MAP = {
  codex: { Read: 'read', Write: 'write', Edit: 'edit', Bash: 'shell', Grep: 'grep', Glob: 'glob' },
  antigravity: { Read: 'read_file', Write: 'write_file', Edit: 'replace', Bash: 'run_shell_command', Grep: 'search_file_content', Glob: 'glob' },
  copilot: { Read: 'read', Write: 'editFiles', Edit: 'editFiles', Bash: 'execute', Grep: 'search', Glob: 'search' },
  opencode: { Read: 'read', Write: 'write', Edit: 'edit', Bash: 'bash', Grep: 'search', Glob: 'glob' },
  pi: {
    Read: 'read', Write: 'write', Edit: 'edit', Bash: 'bash', Grep: 'grep', Glob: 'find',
    'mcp__graphify__query_graph': 'graphify_query',
    'mcp__graphify__get_node': 'graphify_explain',
    'mcp__graphify__get_neighbors': 'graphify_explain',
    'mcp__graphify__get_community': 'graphify_query',
    'mcp__graphify__god_nodes': 'graphify_query',
    'mcp__graphify__shortest_path': 'graphify_path',
    'mcp__graphify__graph_stats': 'graphify_query',
    'mcp__context-mode__ctx_execute': 'ctx_execute',
    'mcp__context-mode__ctx_batch_execute': 'ctx_batch_execute',
    'mcp__context-mode__ctx_execute_file': 'ctx_execute_file',
    'mcp__context-mode__ctx_search': 'ctx_search',
    'mcp__context-mode__ctx_fetch_and_index': 'ctx_fetch_and_index',
  },
};

const CLAUDE_ONLY_CATEGORIES = new Set(['hook', 'command', 'plugin']);
const CLAUDE_ONLY_FILES = new Set(['rules/memory.md']);
// impeccable is Claude-only in the transform fan-out: it ships ~57 files incl. an
// offline detector, so embedding it into codex/gemini/opencode would bloat the seed for
// agents that won't use it. Pi gets a DEDICATED native copy (preseed/agents/pi/skills/
// impeccable, paths re-pointed at ~/.pi/agent) emitted verbatim — no prose mangling of its
// .mjs scripts. So impeccable reaches exactly Claude (this tree) + Pi (native), nothing else.
const CLAUDE_ONLY_SKILLS = new Set(['consult-llm', 'impeccable']);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classifyFile(withinClaude) {
  if (withinClaude.startsWith('hooks/')) return 'hook';
  if (withinClaude.startsWith('commands/')) return 'command';
  if (withinClaude.startsWith('plugins/')) return 'plugin';
  if (withinClaude.startsWith('rules/')) return 'rule';
  if (withinClaude.startsWith('skills/')) return 'skill';
  if (withinClaude.startsWith('agents/')) return 'agent';
  throw new Error(`Cannot classify file: ${withinClaude}`);
}

function isClaudeOnlyFile(withinClaude) {
  return CLAUDE_ONLY_FILES.has(withinClaude);
}

function isClaudeOnlySkill(withinClaude) {
  const match = withinClaude.match(/^skills\/([^/]+)\//);
  return match ? CLAUDE_ONLY_SKILLS.has(match[1]) : false;
}

// ---------------------------------------------------------------------------
// Content type inference
// ---------------------------------------------------------------------------

function inferContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.md':
      return 'text/markdown; charset=utf-8';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.yml':
    case '.yaml':
      return 'text/yaml; charset=utf-8';
    case '.csv':
      return 'text/csv; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.sh':
      return 'application/x-shellscript; charset=utf-8';
    case '.py':
      return 'text/x-python; charset=utf-8';
    case '.ts':
      return 'text/typescript; charset=utf-8';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'text/javascript; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

// ---------------------------------------------------------------------------
// Adaptation functions
// ---------------------------------------------------------------------------

/** Replace ~/.claude/ references with the target agent's config path. */
function adaptPaths(content, agentId) {
  const config = AGENT_CONFIGS[agentId];
  return content.replaceAll('~/.claude/', `${config.homePath}/`);
}

/** Remap a Claude tools array to the target agent's tool names. Deduplicates. */
function remapTools(toolsArray, agentId) {
  const map = TOOL_MAP[agentId];
  const mapped = toolsArray.map((t) => map[t] || t);
  return [...new Set(mapped)];
}

/**
 * Adapt an agent definition's frontmatter: remap tools and remove Claude-specific
 * model pins so transformed agents default to the active runtime model.
 * Body content gets path adaptation only.
 */
function adaptAgentFrontmatter(content, agentId) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return adaptPaths(content, agentId);

  const [, frontmatter, body] = match;
  const lines = frontmatter.split('\n');
  const newLines = [];
  let sawTools = false;

  for (const line of lines) {
    if (line.startsWith('model:')) continue;

    if (line.startsWith('tools:')) {
      sawTools = true;
      const toolsMatch = line.match(/tools:\s*(\[.*\])/);
      if (toolsMatch) {
        const tools = JSON.parse(toolsMatch[1]);
        const remapped = remapTools(tools, agentId);
        // OpenCode expects tools as a record {name: true}, not an array.
        if (agentId === 'opencode') {
          const record = Object.fromEntries(remapped.map((t) => [t, true]));
          newLines.push(`tools: ${JSON.stringify(record)}`);
        } else if (agentId === 'pi') {
          const allowed = [
            'read', 'grep', 'find', 'ls', 'bash', 'edit', 'write',
            'graphify_query', 'graphify_path', 'graphify_explain',
            // Browser Run native tools (REQ-BROWSER-003), registered by the
            // browser-run.ts extension in advanced mode when a Cloudflare token
            // is present. Harmless when absent (the extension registers nothing,
            // so Pi drops the names).
            'browser_markdown', 'browser_content', 'browser_scrape',
            // context-mode helpers: declared in the shared agent frontmatter and remapped
            // to Pi-native names above. Harmless when context-mode is off (the tools do not
            // exist, so Pi drops them), usable when /ctx enables it. No Pi-specific agent edits.
            'ctx_execute', 'ctx_batch_execute', 'ctx_execute_file', 'ctx_search', 'ctx_fetch_and_index',
          ];
          const piTools = [...new Set(remapped.filter((t) => allowed.includes(t)))];
          const dropped = remapped.filter((t) => !allowed.includes(t));
          if (dropped.length > 0) {
            console.warn(`[generate:agent-seed] Pi agent: dropped tools not in allowlist: ${dropped.join(', ')}`);
          }
          newLines.push(`tools: ${piTools.length > 0 ? piTools.join(', ') : 'none'}`);
        } else {
          const cleaned = remapped.filter((t) => !t.startsWith('mcp__'));
          newLines.push(`tools: ${JSON.stringify(cleaned)}`);
        }
      } else {
        newLines.push(line);
      }
      continue;
    }

    newLines.push(line);
  }

  if (agentId === 'pi') {
    if (!sawTools) newLines.push('tools: read, grep, find, ls, bash, edit, write');
    newLines.push('prompt_mode: replace');
    newLines.push('extensions: true');
    newLines.push('skills: true');
    newLines.push('inherit_context: true');
    newLines.push('run_in_background: false');
  }

  return `---\n${newLines.join('\n')}\n---\n${adaptPaths(body, agentId)}`;
}

const PI_SDD_SKILLS = new Set([
  'spec-driven-development',
  'sdd-init',
  'sdd-clean',
  'spec-enforce',
  'spec-enforce-ac',
  'spec-enforce-truth',
  'doc-enforce',
  'doc-enforce-lanes',
  'doc-enforce-shape',
  'doc-enforce-truth',
]);

const PI_SDD_COMPATIBILITY_NOTE = `\n## Pi runtime compatibility\n\nThis transformed Pi skill uses Pi-native tool names and workflows:\n\n- Use Bash/Read/Grep/Find/Edit/Write directly; do not assume context-mode \`ctx_*\` tools exist.\n- Use \`graphify_query\`, \`graphify_path\`, and \`graphify_explain\` directly. If a native graphify tool resolves the workspace root instead of the active repo, use the CLI fallback with \`--graph <repo>/graphify-out/graph.json\`.\n- Use Pi's \`Agent\` tool for subagents. For Plan Mode, invoke the \`Plan\` agent or produce an explicit plan and wait for user approval before source edits.\n`;

function adaptPiSkillContent(content, withinClaude) {
  let next = adaptPaths(content, 'pi');
  const replacements = [
    ['mcp__graphify__god_nodes(top_n=50)', 'graphify_query("top 50 most-connected nodes / god nodes")'],
    ['mcp__graphify__god_nodes(top_n=20)', 'graphify_query("top 20 most-connected nodes / god nodes")'],
    ['mcp__graphify__get_neighbors(<concept-or-symbol>)', 'graphify_explain(<concept-or-symbol>)'],
    ['mcp__graphify__get_node(<symbol>)', 'graphify_explain(<symbol>)'],
    ['mcp__graphify__shortest_path', 'graphify_path'],
    ['mcp__graphify__query_graph', 'graphify_query'],
    ['mcp__graphify__get_neighbors', 'graphify_explain'],
    ['mcp__graphify__get_node', 'graphify_explain'],
    ['mcp__graphify__god_nodes', 'graphify_query'],
    ['mcp__graphify__*', 'Pi graphify tools'],
    ['mcp__context-mode__ctx_batch_execute', 'ctx_batch_execute'],
    ['mcp__context-mode__ctx_execute_file', 'ctx_execute_file'],
    ['mcp__context-mode__ctx_execute', 'ctx_execute'],
    ['mcp__context-mode__ctx_search', 'ctx_search'],
    ['mcp__context-mode__ctx_fetch_and_index', 'ctx_fetch_and_index'],
    ['Claude Code: `EnterPlanMode`', 'Pi: use the `Plan` agent'],
    ['`EnterPlanMode`', 'the Pi `Plan` agent'],
    ['Task tool', 'Agent tool'],
    ['Claude Code', 'Pi'],
  ];
  for (const [from, to] of replacements) next = next.replaceAll(from, to);

  const skillName = withinClaude.match(/^skills\/([^/]+)\//)?.[1];
  if (PI_SDD_SKILLS.has(skillName)) {
    const parts = next.split('\n---\n');
    if (parts.length >= 3) {
      return `${parts[0]}\n---\n${parts.slice(1).join('\n---\n')}${PI_SDD_COMPATIBILITY_NOTE}`;
    }
    return `${next}${PI_SDD_COMPATIBILITY_NOTE}`;
  }
  return next;
}

/** Adapt skill content for the target runtime. */
function adaptSkillContent(content, agentId, withinClaude) {
  if (agentId === 'pi') return adaptPiSkillContent(content, withinClaude);
  return adaptPaths(content, agentId);
}

/**
 * Concatenate applicable rule files into a single instructions markdown file.
 * Rules are sorted alphabetically for deterministic output.
 */
function renderInstructionsFile(ruleFiles, agentId) {
  const sections = ruleFiles
    .sort((a, b) => a.withinClaude.localeCompare(b.withinClaude))
    .map((f) => adaptPaths(f.content.trim(), agentId));
  return sections.join('\n\n---\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateManifestPath(p) {
  if (p.includes('..')) throw new Error(`Path traversal in manifest: ${p}`);
  if (p.startsWith('/')) throw new Error(`Leading slash in manifest path: ${p}`);
  if (p.startsWith('.')) throw new Error(`Leading dot in manifest path: ${p}`);
  if (p.includes('\\')) throw new Error(`Backslash in manifest path: ${p}`);
}

function validateModes(manifest, label) {
  for (const manifestKey of Object.keys(manifest)) {
    validateManifestPath(manifestKey);
    const entry = manifest[manifestKey];
    if (!Array.isArray(entry.modes) || entry.modes.length === 0) {
      throw new Error(`${label} manifest entry "${manifestKey}" has empty or missing modes`);
    }
    for (const mode of entry.modes) {
      if (mode !== 'default' && mode !== 'advanced') {
        throw new Error(`Invalid mode "${mode}" in ${label} manifest entry "${manifestKey}"`);
      }
    }
  }
}

function piNativeKey(withinPi) {
  if (withinPi.startsWith('extensions/')) return `.pi/agent/${withinPi}`;
  if (withinPi.startsWith('skills/')) return `.pi/agent/${withinPi}`;
  if (withinPi.startsWith('scripts/')) return `.pi/agent/${withinPi}`;
  if (withinPi.startsWith('prompts/')) return `.pi/agent/${withinPi}`;
  if (withinPi.startsWith('agents/')) return `.pi/agent/${withinPi}`;
  if (withinPi === 'package.json') return '.pi/agent/npm/package.json';
  if (withinPi === 'package-lock.json') return '.pi/agent/npm/package-lock.json';
  if (withinPi === 'settings.json') return '.pi/agent/settings.json';
  throw new Error(`Cannot map Pi native preseed file: ${withinPi}`);
}

/** Ensure no duplicate (key, mode) pairs across all documents. */
function validateDocuments(documents) {
  const seen = new Map();
  for (const doc of documents) {
    for (const mode of doc.modes) {
      const existing = seen.get(doc.key);
      if (existing && existing.has(mode)) {
        throw new Error(`Duplicate (key, mode) pair: key="${doc.key}", mode="${mode}"`);
      }
      if (!existing) {
        seen.set(doc.key, new Set([mode]));
      } else {
        existing.add(mode);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function computePreseedHash(documents) {
  const sorted = [...documents].sort((a, b) => a.key.localeCompare(b.key));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

function toGeneratedModuleSource(documents) {
  const hash = computePreseedHash(documents);
  const serializedDocuments = JSON.stringify(documents, null, 2);
  return `/* eslint-disable */
// Auto-generated by scripts/generate-agent-seed.mjs
// Do not edit manually.

type SeedDocument = {
  key: string;
  contentType: string;
  content: string;
  modes: ('default' | 'advanced')[];
};

export const PRESEED_CONTENT_HASH = '${hash}';

export const AGENTS_SEEDED_CONFIGS: SeedDocument[] = ${serializedDocuments};
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function generate() {
  // Load and validate manifest
  const manifestPath = path.join(claudeDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  validateModes(manifest, 'Claude');

  // Read all manifest-listed files (manifest-driven, not filesystem-driven,
  // so non-manifest files like plugins/cache/** are safely ignored)
  const sourceFiles = [];
  for (const [withinClaude, entry] of Object.entries(manifest)) {
    const absolutePath = path.join(claudeDir, withinClaude);
    let content;
    try {
      content = await fs.readFile(absolutePath, 'utf8');
    } catch {
      throw new Error(`Manifest references "${withinClaude}" but file does not exist`);
    }
    const category = classifyFile(withinClaude);
    sourceFiles.push({ withinClaude, content, modes: entry.modes, category });
  }

  const documents = [];

  // --- Claude documents (emit as-is) ---
  for (const file of sourceFiles) {
    documents.push({
      key: `.claude/${file.withinClaude}`,
      contentType: inferContentType(file.withinClaude),
      content: file.content,
      modes: file.modes,
    });
  }

  // --- Pi native runtime assets (extensions, MCP config, npm package metadata) ---
  const piManifestPath = path.join(piDir, 'manifest.json');
  let piNativeCount = 0;
  const piNativeSkillKeys = new Set();
  try {
    const piManifest = JSON.parse(await fs.readFile(piManifestPath, 'utf8'));
    validateModes(piManifest, 'Pi');
    for (const withinPi of Object.keys(piManifest)) {
      if (withinPi.startsWith('skills/')) piNativeSkillKeys.add(withinPi.slice('skills/'.length));
    }
    for (const [withinPi, entry] of Object.entries(piManifest)) {
      const absolutePath = path.join(piDir, withinPi);
      let content;
      try {
        content = await fs.readFile(absolutePath, 'utf8');
      } catch {
        throw new Error(`Pi manifest references "${withinPi}" but file does not exist`);
      }
      documents.push({
        key: piNativeKey(withinPi),
        contentType: inferContentType(withinPi),
        content,
        modes: entry.modes,
      });
      piNativeCount++;
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }

  // --- Non-Claude agent documents ---
  for (const [agentId, config] of Object.entries(AGENT_CONFIGS)) {
    // Instructions files (one per mode, same key, different content)
    for (const mode of ['default', 'advanced']) {
      const rules = sourceFiles.filter(
        (f) =>
          f.category === 'rule' &&
          f.modes.includes(mode) &&
          !isClaudeOnlyFile(f.withinClaude)
      );
      if (rules.length > 0) {
        documents.push({
          key: config.instructionsKey,
          contentType: 'text/markdown; charset=utf-8',
          content: renderInstructionsFile(rules, agentId),
          modes: [mode],
        });
      }
    }

    // Skills (if the agent supports them)
    if (config.skillsPrefix) {
      for (const file of sourceFiles) {
        if (file.category !== 'skill') continue;
        if (isClaudeOnlySkill(file.withinClaude)) continue;

        const relPath = file.withinClaude.slice('skills/'.length);
        if (agentId === 'pi' && piNativeSkillKeys.has(relPath)) continue;
        const key = `${config.skillsPrefix}/${relPath}`;

        documents.push({
          key,
          contentType: inferContentType(file.withinClaude),
          content: adaptSkillContent(file.content, agentId, file.withinClaude),
          modes: file.modes,
        });
      }
    }

    // Agent definitions (if the agent supports them)
    if (config.agentsPrefix) {
      for (const file of sourceFiles) {
        if (file.category !== 'agent') continue;

        const fileName = file.withinClaude.slice('agents/'.length);
        const baseName = fileName.replace(/\.md$/, '');
        const key = `${config.agentsPrefix}/${baseName}${config.agentExtension}`;

        documents.push({
          key,
          contentType: 'text/markdown; charset=utf-8',
          content: adaptAgentFrontmatter(file.content, agentId),
          modes: file.modes,
        });
      }
    }
  }

  // Validate output
  validateDocuments(documents);

  // Write TypeScript module
  const source = toGeneratedModuleSource(documents);
  await fs.writeFile(outputFile, source, 'utf8');

  // Summary
  const relativeOutputPath = path.relative(rootDir, outputFile);
  const claudeCount = sourceFiles.length;
  const nonClaudeCount = documents.length - claudeCount - piNativeCount;
  console.log(
    `[generate:agent-seed] Wrote ${documents.length} document(s) to ${relativeOutputPath}` +
      ` (${claudeCount} Claude + ${piNativeCount} Pi native + ${nonClaudeCount} transformed)`
  );
}

generate().catch((error) => {
  console.error('[generate:agent-seed] Failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
