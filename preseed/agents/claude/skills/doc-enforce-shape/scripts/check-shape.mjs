#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_FIELDS = {
  architecture: ['Responsibility', 'Inputs', 'Outputs', 'Source'],
  troubleshooting: ['Symptom', 'Cause', 'Fix'],
  api: ['Method', 'Path', 'Auth', 'Implements'],
};

const GROUP_KEYS = {
  architecture: ['Component'],
  troubleshooting: ['Recipe', 'Symptom'],
  api: ['Method', 'Path'],
};

const RECOGNIZED_AREAS = {
  architecture: new Set(['Components', 'System Components']),
  troubleshooting: new Set(['Common Issues', 'Recipes', 'Troubleshooting Recipes']),
};

const INVENTORY = {
  architecture: [
    ['Worker', /^Worker(?:\s|$)/i],
    ['Container DO', /^Container DO(?:\s|$)/i],
    ['LlmInterceptor', /^LlmInterceptor(?:\s|$)/i],
    ['EgressController', /^EgressController(?:\s|$)/i],
    ['CloudflareBrowserInterceptor', /^CloudflareBrowserInterceptor(?:\s|$)/i],
    ['GitHub Integration', /^GitHub Integration(?:\s|$)/i],
    ['Terminal Server', /^Terminal Server(?:\s|$)/i],
    ['Landing', /^Landing(?:\s|$)/i],
  ],
  troubleshooting: [
    ['/api/* Returns HTML', /\/api\/\*.*Returns HTML/i],
    ['/setup Shows Access Denied', /\/setup.*Shows.*Access Denied/i],
    ['Auth Error After Access Login', /^Auth Error After (?:Successful )?Access Login/i],
    ['HTTP 500 After Login', /^HTTP 500 After Login/i],
    ['Access Application Not Found', /(?:Access Application Not Found|Unable to find your Access application)/i],
    ['Container Stuck Waiting for Services', /^Container Stuck (?:at )?["“]?Waiting for Services/i],
    ['Secrets Lost After Worker Deletion', /^Secrets Lost After Worker Deletion/i],
    ['Chrome in CI', /^Chrome in CI/i],
  ],
  api: [
    ['GET /api/preferences', 'GET', '/api/preferences'],
    ['PATCH /api/preferences', 'PATCH', '/api/preferences'],
    ['GET /api/llm-keys', 'GET', '/api/llm-keys'],
    ['PUT /api/llm-keys', 'PUT', '/api/llm-keys'],
    ['DELETE /api/llm-keys', 'DELETE', '/api/llm-keys'],
  ],
};

function laneKind(file) {
  const name = path.basename(file);
  if (name === 'architecture.md') return 'architecture';
  if (name === 'troubleshooting.md') return 'troubleshooting';
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

function scanTables(lines, kind, file, findings, seen) {
  const required = REQUIRED_FIELDS[kind];
  const keys = GROUP_KEYS[kind];

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headers = markdownCells(lines[index]);
    if (headers.length === 0 || !isSeparator(lines[index + 1])) continue;
    if (!keys.some((key) => headers.includes(key))) continue;

    const missing = required.filter((field) => !headers.includes(field));
    if (kind === 'architecture' && !headers.includes('Component')) missing.unshift('Component');
    const area = nearestArea(lines, index);
    if (missing.length > 0) {
      findings.push({
        rule: 'template-field-missing',
        file,
        line: index + 1,
        collection: kind,
        item: `${area || kind} table`,
        missing: [...new Set(missing)],
      });
    }

    let row = index + 2;
    for (; row < lines.length && lines[row].trim().startsWith('|'); row += 1) {
      const cells = markdownCells(lines[row]);
      if (cells.length === 0) continue;
      const record = Object.fromEntries(headers.map((header, cell) => [header, cells[cell] ?? '']));
      if (kind === 'architecture' && record.Component) seen.architecture.push(record.Component);
      if (kind === 'troubleshooting' && record.Recipe) seen.troubleshooting.push(record.Recipe);
      if (kind === 'api' && record.Method && record.Path) {
        seen.api.push(`${record.Method.toUpperCase()} ${record.Path}`);
      }
    }
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

function scanSections(lines, kind, file, findings, seen) {
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
      const hasShapeField = ['Authentication', 'Auth', 'Response', 'Implements'].some((field) => labels.has(field));
      if (!endpoint || !hasShapeField) continue;
      const required = ['Authentication', 'Response', 'Implements'];
      const missing = required.filter((field) => field === 'Authentication'
        ? !labels.has('Authentication') && !labels.has('Auth')
        : !labels.has(field));
      seen.api.push(`${endpoint[1].toUpperCase()} ${endpoint[2]}`);
      if (missing.length > 0) {
        findings.push({
          rule: 'template-field-missing', file, line: section.line,
          collection: kind, item: section.title, missing,
        });
      }
      continue;
    }

    const inRecognizedArea = RECOGNIZED_AREAS[kind].has(section.area);
    if (!inRecognizedArea) continue;
    const exact = INVENTORY[kind].some(([, matcher]) => matcher.test(section.title));
    const hasShapeField = REQUIRED_FIELDS[kind].some((field) => labels.has(field));
    if (!exact && !hasShapeField) continue;

    seen[kind].push(section.title);
    const missing = REQUIRED_FIELDS[kind].filter((field) => !labels.has(field));
    if (missing.length > 0) {
      findings.push({
        rule: 'template-field-missing', file, line: section.line,
        collection: kind, item: section.title, missing,
      });
    }
  }
}

function inventoryFindings(files, seen) {
  const findings = [];
  for (const [kind, items] of Object.entries(INVENTORY)) {
    const file = files.find((candidate) => laneKind(candidate) === kind) ?? kind;
    for (const item of items) {
      const [name] = item;
      const found = kind === 'api'
        ? seen.api.some((value) => value.toUpperCase() === name.toUpperCase())
        : seen[kind].some((value) => item[1].test(value));
      if (!found) {
        findings.push({
          rule: 'inventory-item-missing', file, line: null,
          collection: kind, item: name, missing: [],
        });
      }
    }
  }
  return findings;
}

export async function checkDocuments(files, { inventory = false } = {}) {
  const findings = [];
  const seen = { architecture: [], troubleshooting: [], api: [] };

  for (const file of files) {
    const kind = laneKind(file);
    if (!kind) continue;
    const content = stripHtmlComments(await readFile(file, 'utf8'));
    const lines = content.split(/\r?\n/);
    scanTables(lines, kind, file, findings, seen);
    scanSections(lines, kind, file, findings, seen);
  }

  if (inventory) findings.push(...inventoryFindings(files, seen));
  return { ok: findings.length === 0, findings };
}

async function main(argv) {
  const inventory = argv.includes('--inventory');
  const files = argv.filter((arg) => arg !== '--inventory');
  if (files.length === 0) {
    process.stderr.write('Usage: check-shape.mjs [--inventory] <lane.md> [...]\n');
    process.exitCode = 2;
    return;
  }
  const result = await checkDocuments(files, { inventory });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
