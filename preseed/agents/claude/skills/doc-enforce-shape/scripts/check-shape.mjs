#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SECTION_REQUIRED_FIELDS = {
  architecture: ['Responsibility', 'Inputs', 'Outputs', 'Source'],
  troubleshooting: ['Symptom', 'Cause', 'Fix'],
};

const TABLE_PROFILES = {
  architecture: [{
    id: 'architecture-components',
    discriminator: ['Component'],
    required: ['Responsibility', 'Inputs', 'Outputs', 'Source'],
  }],
  troubleshooting: [
    {
      id: 'troubleshooting-recipes',
      discriminator: ['Recipe'],
      required: ['Symptom', 'Cause', 'Fix'],
    },
    {
      id: 'troubleshooting-recipes',
      discriminator: ['Symptom'],
      required: ['Cause', 'Fix'],
    },
  ],
  api: [{
    id: 'api-endpoints',
    discriminator: ['Method', 'Path'],
    required: ['Auth', 'Implements'],
  }],
  configuration: [{
    id: 'configuration-variables',
    discriminator: ['Variable'],
    required: ['Purpose', 'Default', 'Required', 'Consumed by', 'Implements'],
  }],
  security: [
    {
      id: 'security-threats',
      discriminator: ['Asset / boundary'],
      required: ['Threat or failure', 'Control and failure posture', 'Residual risk / owner'],
    },
    {
      id: 'security-residual-risks',
      discriminator: ['Exception / residual risk'],
      required: ['Current decision', 'Owner / review signal'],
    },
    {
      id: 'security-verification',
      discriminator: ['Control family'],
      required: ['Requirements / decisions', 'Implementation', 'Evidence'],
    },
  ],
  observability: [{
    id: 'observability-signals',
    discriminator: ['Signal'],
    required: ['Meaning / non-evidence', 'Observed at', 'Escalate when', 'Runbook'],
  }],
};

const RECOGNIZED_AREAS = {
  architecture: new Set(['Components', 'System Components']),
  troubleshooting: new Set(['Common Issues', 'Recipes', 'Troubleshooting Recipes']),
};

function laneKind(file) {
  const name = path.basename(file);
  if (name === 'architecture.md') return 'architecture';
  if (name === 'troubleshooting.md') return 'troubleshooting';
  if (name === 'configuration.md') return 'configuration';
  if (name === 'security.md') return 'security';
  if (name === 'deployment.md') return 'deployment';
  if (name === 'observability.md') return 'observability';
  if (/^api-reference.*\.md$/.test(name)) return 'api';
  return null;
}

function fenceMarker(line) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  return { character: match[1][0], length: match[1].length, rest: match[2] };
}

function inlineCodeEnd(line, start) {
  let length = 1;
  while (line[start + length] === '`') length += 1;

  let index = start + length;
  while (index < line.length) {
    const candidate = line.indexOf('`', index);
    if (candidate === -1) return -1;
    let candidateLength = 1;
    while (line[candidate + candidateLength] === '`') candidateLength += 1;
    if (candidateLength === length) return candidate + candidateLength;
    index = candidate + candidateLength;
  }
  return -1;
}

function isEscaped(line, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function commentStartOutsideCode(content) {
  let fence = null;
  let inlineCodeUntil = -1;
  let lineStart = 0;

  while (lineStart < content.length) {
    const newline = content.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? content.length : newline;
    const line = content.slice(lineStart, lineEnd).replace(/\r$/, '');
    const marker = fenceMarker(line);
    let scanStart = null;

    if (inlineCodeUntil > lineStart) {
      const resumeAt = inlineCodeUntil - lineStart;
      if (resumeAt < line.length) {
        scanStart = resumeAt;
        inlineCodeUntil = -1;
      }
    } else if (fence) {
      if (marker
        && marker.character === fence.character
        && marker.length >= fence.length
        && marker.rest.trim() === '') {
        fence = null;
      }
    } else if (marker && (marker.character === '~' || !marker.rest.includes('`'))) {
      fence = marker;
    } else {
      scanStart = 0;
    }

    if (scanStart !== null) {
      let index = scanStart;
      while (index < line.length) {
        if (line.startsWith('<!--', index)) return lineStart + index;
        if (line[index] === '`' && !isEscaped(content, lineStart + index)) {
          const end = inlineCodeEnd(content, lineStart + index);
          if (end !== -1) {
            if (end - lineStart <= line.length) {
              index = end - lineStart;
              continue;
            }
            inlineCodeUntil = end;
            break;
          }
        }
        index += 1;
      }
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return -1;
}

function stripHtmlComments(content) {
  let clean = content;

  while (true) {
    const start = commentStartOutsideCode(clean);
    if (start === -1) return clean;

    const end = clean.indexOf('-->', start + 4);
    if (end === -1) return clean.slice(0, start);
    clean = clean.slice(0, start) + clean.slice(end + 3);
  }
}

function plain(value) {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/[“”"]/g, '')
    .trim();
}

function markdownCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => plain(cell));
}

function isSeparator(line) {
  const cells = markdownCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replaceAll(' ', '')));
}

function scanTables(lines, kind, file, findings) {
  const profiles = TABLE_PROFILES[kind] ?? [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headers = markdownCells(lines[index]);
    if (headers.length === 0 || !isSeparator(lines[index + 1])) continue;
    const profile = profiles.find(({ discriminator }) =>
      discriminator.every((field) => headers.includes(field)));
    if (!profile) continue;

    const missing = profile.required.filter((field) => !headers.includes(field));
    const area = nearestArea(lines, index);
    if (missing.length > 0) {
      findings.push({
        rule: 'template-field-missing',
        file,
        line: index + 1,
        collection: profile.id,
        item: `${area || kind} table`,
        missing,
      });
    }

    let row = index + 2;
    while (row < lines.length && lines[row].trim().startsWith('|')) row += 1;
    index = row - 1;
  }
}

function nearestArea(lines, before) {
  for (let index = before; index >= 0; index -= 1) {
    const match = lines[index].match(/^##\s+(.+)$/);
    if (match) return plain(match[1]);
  }
  return '';
}

function scanSections(lines, kind, file, findings) {
  let area = '';
  let fence = null;
  const sections = [];
  const visibleLines = [];

  for (let index = 0; index < lines.length; index += 1) {
    const marker = fenceMarker(lines[index]);
    if (fence) {
      visibleLines.push('');
      if (marker
        && marker.character === fence.character
        && marker.length >= fence.length
        && marker.rest.trim() === '') {
        fence = null;
      }
      continue;
    }
    if (marker && (marker.character === '~' || !marker.rest.includes('`'))) {
      visibleLines.push('');
      fence = marker;
      continue;
    }

    visibleLines.push(lines[index]);
    const heading = lines[index].match(/^(#{2,3})\s+(.+)$/);
    if (!heading) continue;
    const level = heading[1].length;
    const title = plain(heading[2]);
    if (level === 2) {
      area = title;
    } else {
      sections.push({ area, title, line: index + 1, start: index + 1 });
    }
  }

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const nextHeading = visibleLines.findIndex((line, lineIndex) => lineIndex >= section.start && /^#{2,3}\s+/.test(line));
    const end = nextHeading === -1 ? visibleLines.length : nextHeading;
    const body = visibleLines.slice(section.start, end).join('\n');
    const labels = new Set(
      [...body.matchAll(/^\*\*([^*:\n]+):\*\*/gm)].map((match) => plain(match[1])),
    );

    if (kind === 'api') {
      const endpoint = section.title.match(/^(GET|POST|PUT|PATCH|DELETE)\s+[`]?([^\s`]+)/i);
      const hasDetailedShape = ['Request', 'Errors', 'Source'].some((field) => labels.has(field));
      const hasLegacyShape = ['Authentication', 'Auth'].some((field) => labels.has(field));
      if (!endpoint || (!hasDetailedShape && !hasLegacyShape)) continue;
      const required = hasDetailedShape
        ? ['Request', 'Response', 'Errors', 'Source', 'Implements']
        : ['Authentication', 'Response', 'Implements'];
      const missing = required.filter((field) => field === 'Authentication'
        ? !labels.has('Authentication') && !labels.has('Auth')
        : !labels.has(field));
      if (missing.length > 0) {
        findings.push({
          rule: 'template-field-missing', file, line: section.line,
          collection: kind, item: section.title, missing,
        });
      }
      continue;
    }

    const recognizedAreas = RECOGNIZED_AREAS[kind];
    const required = SECTION_REQUIRED_FIELDS[kind];
    if (!recognizedAreas || !required || !recognizedAreas.has(section.area)) continue;
    const hasShapeField = required.some((field) => labels.has(field));
    if (!hasShapeField) continue;

    const missing = required.filter((field) => !labels.has(field));
    if (missing.length > 0) {
      findings.push({
        rule: 'template-field-missing', file, line: section.line,
        collection: kind, item: section.title, missing,
      });
    }
  }
}

function scanDeploymentSections(lines, file, findings) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^##\s+(.+)$/);
    if (heading) starts.push({ title: plain(heading[1]), line: index + 1, start: index + 1 });
  }

  const semantics = [
    ['When', ['When']],
    ['Action', ['Action', 'Command']],
    ['Verify', ['Verify', 'Verifies']],
    ['Rollback', ['Rollback']],
  ];

  for (let index = 0; index < starts.length; index += 1) {
    const section = starts[index];
    const end = starts[index + 1]?.line - 1 ?? lines.length;
    const body = lines.slice(section.start, end).join('\n');
    const labels = new Set(
      [...body.matchAll(/^\*\*([^*:\n]+):\*\*/gm)].map((match) => plain(match[1])),
    );
    const matched = semantics.filter(([, aliases]) => aliases.some((alias) => labels.has(alias)));
    if (matched.length < 2) continue;
    const missing = semantics
      .filter(([, aliases]) => !aliases.some((alias) => labels.has(alias)))
      .map(([canonical]) => canonical);
    if (missing.length > 0) {
      findings.push({
        rule: 'template-field-missing',
        file,
        line: section.line,
        collection: 'deployment-runbooks',
        item: section.title,
        missing,
      });
    }
  }
}

export async function checkDocuments(files) {
  const findings = [];

  for (const file of files) {
    const kind = laneKind(file);
    if (!kind) continue;
    const content = stripHtmlComments(await readFile(file, 'utf8'));
    const lines = content.split(/\r?\n/);
    scanTables(lines, kind, file, findings);
    scanSections(lines, kind, file, findings);
    if (kind === 'deployment') scanDeploymentSections(lines, file, findings);
  }

  return { ok: findings.length === 0, findings };
}

async function main(argv) {
  if (argv.length === 0) {
    process.stderr.write('Usage: check-shape.mjs <lane.md> [...]\n');
    process.exitCode = 2;
    return;
  }
  const result = await checkDocuments(argv);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
