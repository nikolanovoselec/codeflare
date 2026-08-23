#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseGeneratedSeed } from './materialize-agent-seed.mjs';
import { measurePiPromptBudget } from './pi-prompt-contract.mjs';

const modes = new Set(['default', 'advanced']);

async function importPiRuntime(piPackageRoot) {
  const moduleUrl = (relativePath) => pathToFileURL(path.join(piPackageRoot, relativePath)).href;
  const [{ DefaultResourceLoader }, { buildSystemPrompt }, { formatSkillsForPrompt }, tools] = await Promise.all([
    import(moduleUrl('dist/core/resource-loader.js')),
    import(moduleUrl('dist/core/system-prompt.js')),
    import(moduleUrl('dist/core/skills.js')),
    import(moduleUrl('dist/core/tools/index.js')),
  ]);
  return { DefaultResourceLoader, buildSystemPrompt, formatSkillsForPrompt, createCodingTools: tools.createCodingTools };
}

async function materializeProjection(documents, mode, agentDir, runtimeAgentDir) {
  for (const document of documents) {
    if (!document.modes.includes(mode) || !document.key.startsWith('.pi/agent/')) continue;
    const relativePath = document.key.slice('.pi/agent/'.length);
    const destination = path.join(agentDir, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, document.content);
  }

  await cp(path.join(runtimeAgentDir, 'settings.json'), path.join(agentDir, 'settings.json'));
  await mkdir(path.join(agentDir, 'npm'), { recursive: true });
  await symlink(
    path.join(runtimeAgentDir, 'npm', 'node_modules'),
    path.join(agentDir, 'npm', 'node_modules'),
    'dir',
  );
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function catalogEntryChars(skill) {
  if (skill.disableModelInvocation) return 0;
  return [
    '  <skill>',
    `    <name>${xmlEscape(skill.name)}</name>`,
    `    <description>${xmlEscape(skill.description)}</description>`,
    `    <location>${xmlEscape(skill.filePath)}</location>`,
    '  </skill>',
  ].join('\n').length + 1;
}

function sourceLabel(skill) {
  if (typeof skill.source === 'string') return skill.source;
  if (skill.source && typeof skill.source === 'object') {
    return String(skill.source.label ?? skill.source.type ?? skill.source.source ?? 'resource');
  }
  return 'resource';
}

function stablePath(value, agentDir, root) {
  return String(value).replaceAll(agentDir, '~/.pi/agent').replaceAll(root, '<fixture>');
}

function toolSchema(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

export function serializePiToolSchemas({ builtInTools, extensionTools }) {
  const byName = new Map();
  for (const tool of [...builtInTools, ...extensionTools]) {
    if (!tool || typeof tool.name !== 'string' || byName.has(tool.name)) continue;
    byName.set(tool.name, tool);
  }
  return JSON.stringify(
    [...byName.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(toolSchema),
  );
}

function extensionToolDefinitions(loader) {
  return loader.getExtensions().extensions.flatMap((extension) => (
    [...extension.tools.values()].map((registeredTool) => registeredTool.definition)
  ));
}

async function loadPrompt({ runtime, agentDir, cwd }) {
  const loader = new runtime.DefaultResourceLoader({
    cwd,
    agentDir,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  const extensionErrors = loader.getExtensions().errors;
  if (extensionErrors.length > 0) {
    throw new Error(`Pi extension loading failed: ${extensionErrors.map(({ path: extensionPath, error }) => `${extensionPath}: ${error}`).join('; ')}`);
  }
  const skills = loader.getSkills().skills;
  const agentsFiles = loader.getAgentsFiles().agentsFiles;
  const appendSystemPrompt = loader.getAppendSystemPrompt().join('\n\n');
  const prompt = runtime.buildSystemPrompt({
    customPrompt: loader.getSystemPrompt(),
    selectedTools: ['read', 'bash', 'edit', 'write'],
    appendSystemPrompt,
    cwd,
    contextFiles: agentsFiles,
    skills,
  });
  return {
    prompt,
    skills,
    agentsFiles,
    extensionTools: extensionToolDefinitions(loader),
    diagnostics: loader.getSkills().diagnostics,
  };
}

export async function verifyPiProjection({ documents, mode, runtimeAgentDir, piPackageRoot }) {
  if (!modes.has(mode)) throw new Error(`unsupported Pi prompt mode: ${mode}`);
  const root = await mkdtemp(path.join(tmpdir(), 'pi-agent-'));
  const agentDir = root;
  const isolatedCwd = path.join(root, 'isolated');
  const projectCwd = path.join(root, 'project');
  const projectPolicy = '# Project fixture\n\nPROJECT_CONTEXT_SENTINEL\n';
  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(isolatedCwd, { recursive: true });
    await mkdir(projectCwd, { recursive: true });
    await writeFile(path.join(projectCwd, 'AGENTS.md'), projectPolicy);
    await materializeProjection(documents, mode, agentDir, runtimeAgentDir);
    const runtime = await importPiRuntime(piPackageRoot);
    const controlled = await loadPrompt({ runtime, agentDir, cwd: isolatedCwd });
    const withProject = await loadPrompt({ runtime, agentDir, cwd: projectCwd });
    if (!withProject.prompt.includes(projectPolicy)) {
      throw new Error('Pi resource loader did not preserve additive project AGENTS.md bytes');
    }

    const builtInTools = runtime.createCodingTools(isolatedCwd);
    const serializedToolSchemas = serializePiToolSchemas({
      builtInTools,
      extensionTools: controlled.extensionTools,
    });
    const budget = measurePiPromptBudget({
      controlledPrompt: controlled.prompt,
      additiveProjectContext: withProject.prompt.slice(controlled.prompt.length),
      serializedToolSchemas,
    });
    const catalog = runtime.formatSkillsForPrompt(controlled.skills);
    const skills = controlled.skills
      .map((skill) => ({
        name: skill.name,
        source: stablePath(sourceLabel(skill), agentDir, root),
        filePath: stablePath(skill.filePath, agentDir, root),
        visible: !skill.disableModelInvocation,
        descriptionChars: skill.description.length,
        promptContributionChars: catalogEntryChars(skill),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));

    return {
      mode,
      ...budget,
      catalogChars: catalog.length,
      discoveredSkills: skills.length,
      visibleSkills: skills.filter((skill) => skill.visible).length,
      diagnostics: controlled.diagnostics.map((diagnostic) =>
        stablePath(diagnostic.message ?? diagnostic, agentDir, root)),
      skills,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export async function main() {
  const generatedPath = argument('--generated');
  const runtimeAgentDir = argument('--runtime-agent-dir');
  const piPackageRoot = argument('--pi-package-root');
  const reportPath = argument('--report');
  if (!generatedPath || !runtimeAgentDir || !piPackageRoot || !reportPath) {
    throw new Error('usage: verify-pi-prompt.mjs --generated <agent-seed.generated.ts> --runtime-agent-dir <prepared-agent-dir> --pi-package-root <pi-package> --report <json>');
  }
  const documents = parseGeneratedSeed(await readFile(generatedPath, 'utf8'));
  const reports = [];
  for (const mode of modes) {
    reports.push(await verifyPiProjection({ documents, mode, runtimeAgentDir, piPackageRoot }));
  }
  const failed = reports.filter((report) => !report.withinPromptBudget);
  await writeFile(reportPath, `${JSON.stringify({ reports }, null, 2)}\n`);
  for (const report of reports) {
    console.log(`${report.mode}: prompt=${report.promptChars} project=${report.projectContextChars} schemas=${report.toolSchemaChars} visible=${report.visibleSkills}/${report.discoveredSkills}`);
  }
  if (failed.length > 0) throw new Error(`Pi prompt budget exceeded for: ${failed.map(({ mode }) => mode).join(', ')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
