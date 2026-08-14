#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STANDARD_LANES = {
  architecture: {
    template: 'documentation-architecture.md',
    title: 'Architecture',
    summary: 'System map, ownership, state authority, and recovery boundaries',
  },
  'api-reference': {
    template: 'documentation-api-reference.md',
    title: 'API Reference',
    summary: 'HTTP routes, authorization, contracts, and requirement links',
  },
  configuration: {
    template: 'documentation-configuration.md',
    title: 'Configuration',
    summary: 'Runtime settings, defaults, consumers, and security consequences',
  },
  deployment: {
    template: 'documentation-deployment.md',
    title: 'Deployment',
    summary: 'Deployment, verification, and rollback runbooks',
  },
  security: {
    template: 'documentation-security.md',
    title: 'Security',
    summary: 'Threats, controls, failure posture, and residual risks',
  },
  observability: {
    template: 'documentation-observability.md',
    title: 'Observability',
    summary: 'Signals, interpretation, escalation, and runbooks',
  },
  troubleshooting: {
    template: 'documentation-troubleshooting.md',
    title: 'Troubleshooting',
    summary: 'Symptoms, causes, fixes, and verification',
  },
};

function laneDefinition(id) {
  if (STANDARD_LANES[id]) return STANDARD_LANES[id];
  if (/^api-reference-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    const qualifier = id
      .slice('api-reference-'.length)
      .split('-')
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(' ');
    return {
      template: 'documentation-api-reference.md',
      title: `${qualifier} API Reference`,
      summary: `HTTP routes, authorization, and contracts for ${qualifier.toLowerCase()} surfaces`,
    };
  }
  return null;
}

function validateTemplate(content, name) {
  for (const match of content.matchAll(/\{([^}\n]+)\}/g)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(match[1])) {
      throw new Error(`Invalid placeholder in ${name}: {${match[1]}}`);
    }
  }
  const unmatched = content.replace(/\{[A-Z][A-Z0-9_]*\}/g, '');
  if (/[{}]/.test(unmatched)) throw new Error(`Unmatched placeholder brace in ${name}`);

  const exemplar = content.match(/\b(?:REQ-[A-Z]+-\d+|AD\d+)\b/);
  if (exemplar) throw new Error(`Hard-coded exemplar ID in ${name}: ${exemplar[0]}`);
}

function escapeMarkdownText(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('[', '&#91;')
    .replaceAll(']', '&#93;')
    .replaceAll('|', '&#124;');
}

function render(content, values) {
  return content.replace(/\{([A-Z][A-Z0-9_]*)\}/g, (token, key) => values[key] ?? token);
}

async function readTemplate(templatesDir, name) {
  const content = await readFile(path.join(templatesDir, name), 'utf8');
  validateTemplate(content, name);
  return content;
}

function validateProjectLane(lane) {
  if (!lane || typeof lane !== 'object') throw new Error('Project lanes must be objects');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(lane.slug ?? '')) {
    throw new Error(`Invalid project lane slug: ${lane.slug ?? ''}`);
  }
  if (typeof lane.title !== 'string'
    || lane.title.trim() === ''
    || lane.title.length > 120
    || !/^[\p{L}\p{N}][\p{L}\p{N} .&()'/_-]*$/u.test(lane.title)) {
    throw new Error(`Project lane ${lane.slug} requires a Markdown-safe title of at most 120 characters`);
  }
}

export async function renderDocumentationTemplates({
  mode,
  templatesDir,
  outputDir,
  projectName,
  lanes,
  projectLanes = [],
}) {
  if (!['greenfield', 'import'].includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
  if (!templatesDir || !outputDir || typeof projectName !== 'string' || projectName.trim() === '') {
    throw new Error('templatesDir, outputDir, and projectName are required');
  }
  if (projectName.length > 120 || /[\r\n]/.test(projectName)) {
    throw new Error('projectName must be a single line of at most 120 characters');
  }

  const selected = [...new Set(['architecture', ...(lanes ?? [])])];
  for (const lane of selected) {
    if (!laneDefinition(lane)) throw new Error(`Unsupported documentation lane: ${lane}`);
  }
  for (const lane of projectLanes) validateProjectLane(lane);
  if (new Set(projectLanes.map((lane) => lane.slug)).size !== projectLanes.length) {
    throw new Error('Project lane slugs must be unique');
  }

  const reserved = new Set(Object.keys(STANDARD_LANES));
  for (const lane of projectLanes) {
    if (reserved.has(lane.slug) || lane.slug.startsWith('api-reference-')) {
      throw new Error(`Project lane collides with a standard lane: ${lane.slug}`);
    }
  }

  try {
    await mkdir(outputDir);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`Documentation staging directory must not already exist: ${outputDir}`);
    }
    throw error;
  }

  try {
    await mkdir(path.join(outputDir, 'lanes'));
    await mkdir(path.join(outputDir, 'decisions'));

    const rows = [];
    for (const id of selected) {
      const definition = laneDefinition(id);
      const source = await readTemplate(templatesDir, definition.template);
      const rendered = render(source, { PROJECT_NAME: escapeMarkdownText(projectName) });
      await writeFile(path.join(outputDir, 'lanes', `${id}.md`), rendered);
      rows.push(`| [${definition.title}](lanes/${id}.md) | ${definition.summary} |`);
    }

    const projectTemplate = await readTemplate(templatesDir, 'documentation-project-lane.md');
    for (const lane of projectLanes) {
      const rendered = render(projectTemplate, {
        PROJECT_NAME: projectName,
        PROJECT_LANE_TITLE: lane.title,
      });
      await writeFile(path.join(outputDir, 'lanes', `${lane.slug}.md`), rendered);
      rows.push(`| [${lane.title}](lanes/${lane.slug}.md) | Project-specific ${lane.title.toLowerCase()} contracts and evidence |`);
    }

    const indexTemplate = await readTemplate(templatesDir, 'documentation-readme.md');
    const index = render(indexTemplate, {
      PROJECT_NAME: escapeMarkdownText(projectName),
      LANE_INDEX_ROWS: rows.join('\n'),
    });
    await writeFile(path.join(outputDir, 'README.md'), index);

    const decisionsTemplate = await readTemplate(templatesDir, 'documentation-decisions-readme.md');
    await writeFile(
      path.join(outputDir, 'decisions', 'README.md'),
      render(decisionsTemplate, { PROJECT_NAME: escapeMarkdownText(projectName) }),
    );

    return {
      lanes: [
        ...selected.map((lane) => `lanes/${lane}.md`),
        ...projectLanes.map((lane) => `lanes/${lane.slug}.md`),
      ],
    };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(argv) {
  const lanes = (argument(argv, '--lanes') ?? '').split(',').filter(Boolean);
  const projectLanes = JSON.parse(argument(argv, '--project-lanes') ?? '[]');
  const result = await renderDocumentationTemplates({
    mode: argument(argv, '--mode'),
    templatesDir: argument(argv, '--templates'),
    outputDir: argument(argv, '--output'),
    projectName: argument(argv, '--project-name'),
    lanes,
    projectLanes,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
