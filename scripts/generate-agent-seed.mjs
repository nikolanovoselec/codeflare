#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const claudeDir = path.join(rootDir, 'preseed/agents/claude');
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
  gemini: {
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
};

const TOOL_MAP = {
  codex: { Read: 'read', Write: 'write', Edit: 'edit', Bash: 'shell', Grep: 'grep', Glob: 'glob' },
  gemini: { Read: 'read_file', Write: 'write_file', Edit: 'replace', Bash: 'run_shell_command', Grep: 'search_file_content', Glob: 'glob' },
  copilot: { Read: 'read', Write: 'editFiles', Edit: 'editFiles', Bash: 'execute', Grep: 'search', Glob: 'search' },
  opencode: { Read: 'read', Write: 'write', Edit: 'edit', Bash: 'bash', Grep: 'search', Glob: 'glob' },
};

const CLAUDE_ONLY_CATEGORIES = new Set(['hook', 'command', 'plugin']);
const CLAUDE_ONLY_FILES = new Set(['rules/memory.md']);
const CLAUDE_ONLY_SKILLS = new Set(['consult-llm']);

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
 * Adapt an agent definition's frontmatter: remap tools, remove model field.
 * Body content gets path adaptation only.
 */
function adaptAgentFrontmatter(content, agentId) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return adaptPaths(content, agentId);

  const [, frontmatter, body] = match;
  const lines = frontmatter.split('\n');
  const newLines = [];

  for (const line of lines) {
    if (line.startsWith('model:')) continue;

    if (line.startsWith('tools:')) {
      const toolsMatch = line.match(/tools:\s*(\[.*\])/);
      if (toolsMatch) {
        const tools = JSON.parse(toolsMatch[1]);
        const remapped = remapTools(tools, agentId);
        // OpenCode expects tools as a record {name: true}, not an array
        if (agentId === 'opencode') {
          const record = Object.fromEntries(remapped.map((t) => [t, true]));
          newLines.push(`tools: ${JSON.stringify(record)}`);
        } else {
          newLines.push(`tools: ${JSON.stringify(remapped)}`);
        }
      } else {
        newLines.push(line);
      }
      continue;
    }

    newLines.push(line);
  }

  return `---\n${newLines.join('\n')}\n---\n${adaptPaths(body, agentId)}`;
}

/** Adapt skill content (path replacement only — skills have no tools/model in frontmatter). */
function adaptSkillContent(content, agentId) {
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

function toGeneratedModuleSource(documents) {
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

  for (const manifestKey of Object.keys(manifest)) {
    validateManifestPath(manifestKey);
    const entry = manifest[manifestKey];
    if (!Array.isArray(entry.modes) || entry.modes.length === 0) {
      throw new Error(`Manifest entry "${manifestKey}" has empty or missing modes`);
    }
    for (const mode of entry.modes) {
      if (mode !== 'default' && mode !== 'advanced') {
        throw new Error(`Invalid mode "${mode}" in manifest entry "${manifestKey}"`);
      }
    }
  }

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
        const key = `${config.skillsPrefix}/${relPath}`;

        documents.push({
          key,
          contentType: inferContentType(file.withinClaude),
          content: adaptSkillContent(file.content, agentId),
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
  const nonClaudeCount = documents.length - claudeCount;
  console.log(
    `[generate:agent-seed] Wrote ${documents.length} document(s) to ${relativeOutputPath}` +
      ` (${claudeCount} Claude + ${nonClaudeCount} non-Claude)`
  );
}

generate().catch((error) => {
  console.error('[generate:agent-seed] Failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
