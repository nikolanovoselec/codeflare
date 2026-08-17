#!/usr/bin/env node
import { readFileSync } from 'node:fs';
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
    areas: ['Components', 'System Components'],
    discriminator: ['Component'],
    required: ['Responsibility', 'Inputs', 'Outputs', 'Source'],
  }],
  troubleshooting: [
    {
      id: 'troubleshooting-recipes',
      areas: ['Failure Index'],
      discriminator: ['Recipe'],
      required: ['Symptom', 'Cause', 'Fix'],
    },
    {
      id: 'troubleshooting-recipes',
      areas: ['Failure Index'],
      contextDefault: true,
      discriminator: ['Symptom'],
      required: ['Cause', 'Fix'],
    },
  ],
  api: [{
    id: 'api-endpoints',
    discriminator: ['Method', 'Path'],
    required: ['Auth', 'Implements'],
  }],
  configuration: [
    {
      id: 'configuration-variables',
      areas: ['Runtime Variables', 'Worker Environment'],
      discriminator: ['Variable'],
      required: ['Purpose', 'Default', 'Required', 'Consumed by', 'Implements'],
      aliases: { Purpose: ['Description'] },
    },
    {
      id: 'configuration-bindings',
      areas: ['Platform Bindings'],
      discriminator: ['Binding'],
      required: ['Purpose', 'Required', 'Consumed by', 'Implements'],
    },
  ],
  security: [
    {
      id: 'security-threats',
      areas: ['Threat Model'],
      discriminator: ['Asset / boundary'],
      required: ['Threat or failure', 'Control and failure posture', 'Residual risk / owner'],
    },
    {
      id: 'security-residual-risks',
      areas: ['Accepted Exceptions and Residual Risks'],
      discriminator: ['Exception / residual risk'],
      required: ['Current decision', 'Owner / review signal'],
    },
    {
      id: 'security-verification',
      areas: ['Verification and Source Map'],
      discriminator: ['Control family'],
      required: ['Requirements / decisions', 'Implementation', 'Evidence'],
    },
  ],
  observability: [{
    id: 'observability-signals',
    areas: ['Signals'],
    discriminator: ['Signal'],
    required: ['Meaning / non-evidence', 'Observed at', 'Escalate when', 'Runbook'],
  }],
};

const RECOGNIZED_AREAS = {
  architecture: new Set(['Components', 'System Components']),
  troubleshooting: new Set(['Common Issues', 'Recipes', 'Troubleshooting Recipes']),
};

const ADR_INDEX_HEADERS = ['ID', 'Decision', 'Summary', 'Category', 'State'];
const ADR_STATES = new Set(['Active', 'Superseded', 'Partially superseded', 'Redirect anchor']);
const ADR_DECISION_MAX_CHARS = 90;
const ADR_SUMMARY_MIN_CHARS = 40;
const ADR_SUMMARY_MAX_CHARS = 180;
const ADR_SEMANTIC_STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'among', 'because', 'before', 'being',
  'between', 'could', 'decision', 'does', 'each', 'from', 'have', 'into', 'only',
  'other', 'should', 'that', 'their', 'these', 'this', 'those', 'through', 'to', 'under',
  'uses', 'using', 'very', 'what', 'when', 'where', 'which', 'while', 'with', 'would',
]);

function laneKind(file) {
  const name = path.basename(file);
  if (name === 'architecture.md') return 'architecture';
  if (name === 'troubleshooting.md') return 'troubleshooting';
  if (name === 'configuration.md') return 'configuration';
  if (name === 'security.md') return 'security';
  if (name === 'deployment.md') return 'deployment';
  if (name === 'observability.md') return 'observability';
  if (/^api-reference.*\.md$/.test(name)) return 'api';
  if (name === 'README.md' && path.basename(path.dirname(file)) === 'decisions') return 'decisions';
  if (path.basename(path.dirname(file)) === 'lanes' && name.endsWith('.md')) return 'project';
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

function maskFencedLines(lines) {
  let fence = null;
  return lines.map((line) => {
    const marker = fenceMarker(line);
    if (fence) {
      if (marker
        && marker.character === fence.character
        && marker.length >= fence.length
        && marker.rest.trim() === '') {
        fence = null;
      }
      return '';
    }
    if (marker && (marker.character === '~' || !marker.rest.includes('`'))) {
      fence = marker;
      return '';
    }
    return line;
  });
}

function plain(value) {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/[“”"]/g, '')
    .trim();
}

function adrRenderedText(value) {
  return plain(value).replace(/~~|\*\*|__/g, '').trim();
}

function normalizedAdrText(value) {
  return adrRenderedText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function adrSentenceCount(value) {
  return (adrRenderedText(value).match(/[.!?](?=\s|$)/g) ?? []).length;
}

function adrSemanticTokens(value) {
  return new Set((adrRenderedText(value).toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])
    .filter((token) => !ADR_SEMANTIC_STOP_WORDS.has(token)));
}

function hasTokenOverlap(left, right) {
  const expected = adrSemanticTokens(right);
  return [...adrSemanticTokens(left)].some((token) => expected.has(token));
}

function hasAdrBodySupport(summary, support) {
  const rendered = adrRenderedText(summary);
  const driver = rendered.match(/\b(?:because|so|to|prevent\w*|avoid\w*|without|rather|instead|while|preserv\w*|protect\w*|unless|after|remov\w*|eliminat\w*|separat\w*)\b/i);
  const explanation = driver ? rendered.slice(driver.index) : rendered;
  return hasTokenOverlap(explanation, support);
}

function adrField(bodyLines, field) {
  const start = bodyLines.findIndex((line) => line.startsWith(`**${field}:**`));
  if (start === -1) return '';
  const first = bodyLines[start].slice(`**${field}:**`.length).trim();
  const continuation = [];
  for (let index = start + 1; index < bodyLines.length; index += 1) {
    if (/^\*\*[A-Za-z][^*]*:\*\*/.test(bodyLines[index]) || /^#{1,3}\s+/.test(bodyLines[index])) break;
    continuation.push(bodyLines[index]);
  }
  return [first, ...continuation].join(' ').replace(/\s+/g, ' ').trim();
}

function markdownHrefs(value) {
  return [...value.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
}

function adrStateFromStatus(status) {
  if (/^\*\*Status:\*\*\s+(?:Reclassified|Merged)\b/i.test(status)) return 'Redirect anchor';
  if (/^\*\*Status:\*\*\s+Superseded\b/i.test(status)) return 'Superseded';
  if (/\bPartially superseded\b/i.test(status)) return 'Partially superseded';
  return 'Active';
}

function validateAdrIndexRow(row, file, findings) {
  const decision = adrRenderedText(row.decision);
  const summary = adrRenderedText(row.summary);
  const add = (rule, missing) => findings.push({
    rule, file, line: row.line, collection: 'decision-index', item: row.id, missing: [missing],
  });

  if (decision.length > ADR_DECISION_MAX_CHARS) add('adr-index-decision-label-too-long', `Decision <= ${ADR_DECISION_MAX_CHARS} rendered characters`);
  if (summary.length < ADR_SUMMARY_MIN_CHARS) add('adr-index-summary-too-short', `Summary >= ${ADR_SUMMARY_MIN_CHARS} rendered characters`);
  if (summary.length > ADR_SUMMARY_MAX_CHARS) add('adr-index-summary-too-long', `Summary <= ${ADR_SUMMARY_MAX_CHARS} rendered characters`);
  if (adrSentenceCount(summary) > 1) add('adr-index-summary-multiple-sentences', 'Summary <= 1 sentence');
  const normalizedDecision = normalizedAdrText(decision);
  const normalizedSummary = normalizedAdrText(summary);
  if (normalizedSummary === normalizedDecision || normalizedSummary.startsWith(`${normalizedDecision} `)) {
    add('adr-index-summary-repeats-title', 'self-contained Summary distinct from Decision');
  }
  if (/^(?:this|it|they|these|those|that)\b/i.test(summary)) add('adr-index-summary-pronoun-first', 'named component or boundary');
  if (!ADR_STATES.has(row.state)) add('adr-index-state-invalid', 'Active, Superseded, Partially superseded, or Redirect anchor');
}

function isHtmlLikeOpener(value, index) {
  const candidate = value.slice(index);
  return candidate.startsWith('<!--')
    || /^<\/?[A-Za-z][A-Za-z0-9-]*(?=$|[\s/><])/.test(candidate);
}

function htmlLikeSegmentEnd(value, start) {
  let depth = 0;
  let quote = null;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if ((character === '"' || character === "'") && depth > 0) {
      quote = character;
    } else if (character === '<' && isHtmlLikeOpener(value, index)) {
      depth += 1;
    } else if (character === '>' && depth > 0) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function removeHtmlLikeSegments(value) {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '<' && isHtmlLikeOpener(value, index)) {
      const end = htmlLikeSegmentEnd(value, index);
      if (end !== -1) {
        index = end;
        continue;
      }
    }
    result += value[index];
  }
  return result;
}

function githubHeadingAnchor(heading) {
  return removeHtmlLikeSegments(heading)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*~]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

const referenceTargetCache = new Map();

function readLocalReferenceTarget(file, relativePath) {
  const targetPath = path.resolve(path.dirname(file), relativePath);
  let target = referenceTargetCache.get(targetPath);
  if (target === undefined) {
    try {
      target = readFileSync(targetPath, 'utf8');
    } catch {
      target = null;
    }
    referenceTargetCache.set(targetPath, target);
  }
  return { target, targetPath };
}

function localReferenceResolves(file, href, identifier) {
  const hashIndex = href.indexOf('#');
  if (hashIndex <= 0 || hashIndex === href.length - 1) return false;
  const relativePath = href.slice(0, hashIndex).split('?')[0];
  let fragment;
  try {
    fragment = decodeURIComponent(href.slice(hashIndex + 1));
  } catch {
    return false;
  }
  const { target } = readLocalReferenceTarget(file, relativePath);
  if (target === null) return false;
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = target.split(/\r?\n/).find((line) =>
    new RegExp(`^#{1,6}\\s+${escaped}(?::|\\s|$)`, 'i').test(line));
  if (!heading) return false;
  return fragment === githubHeadingAnchor(heading.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, ''));
}

function domainReferenceResolves(file, href, label) {
  const relativePath = href.split(/[?#]/)[0];
  const { target, targetPath } = readLocalReferenceTarget(file, relativePath);
  if (target === null || !targetPath.includes(`${path.sep}sdd${path.sep}spec${path.sep}`)) return false;
  const title = target.match(/^#\s+(.+)$/m)?.[1] ?? '';
  const normalize = (value) => value
    .toLowerCase()
    .replace(/\brequirements?\b|\bmode\b|\bdomain\b|\bspecification\b/g, '')
    .replace(/\b([a-z]+)s\b/g, '$1')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return normalize(label) === normalize(title);
}

function rawMarkdownCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function markdownCells(line) {
  return rawMarkdownCells(line).map((cell) => plain(cell));
}

function isSeparator(line) {
  const cells = markdownCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replaceAll(' ', '')));
}

function profileFieldPresent(profile, field, headers) {
  return headers.includes(field)
    || (profile.aliases?.[field] ?? []).some((alias) => headers.includes(alias));
}

function profileForHeaders(profiles, headers, area) {
  const exact = profiles.find(({ discriminator }) =>
    discriminator.every((field) => headers.includes(field)));
  if (exact) return exact;

  const partial = profiles
    .map((profile) => {
      const fields = [...profile.discriminator, ...profile.required];
      const matched = fields.filter((field) => profileFieldPresent(profile, field, headers)).length;
      return { profile, matched };
    })
    .filter(({ matched }) => matched >= 2)
    .sort((left, right) => right.matched - left.matched)[0]?.profile;
  if (partial) return partial;

  const contextual = profiles.filter((profile) => profile.areas?.includes(area));
  if (contextual.length === 1) return contextual[0];
  return contextual.find((profile) => profile.contextDefault) ?? null;
}

function scanTables(lines, kind, file, findings) {
  const profiles = TABLE_PROFILES[kind] ?? [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headers = markdownCells(lines[index]);
    const separators = markdownCells(lines[index + 1]);
    if (headers.length === 0 || !isSeparator(lines[index + 1])) continue;
    const area = nearestArea(lines, index);
    const profile = profileForHeaders(profiles, headers, area);
    if (!profile) continue;
    if (headers.length !== separators.length) {
      findings.push({
        rule: 'table-column-count-mismatch',
        file,
        line: index + 1,
        collection: profile.id,
        item: `${area || kind} table`,
        missing: [],
      });
      continue;
    }

    const missing = [...profile.discriminator, ...profile.required]
      .filter((field) => !profileFieldPresent(profile, field, headers));
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
    while (row < lines.length && lines[row].trim().startsWith('|')) {
      if (profile.id === 'security-verification') {
        const referenceColumn = headers.indexOf('Requirements / decisions');
        const referenceCell = rawMarkdownCells(lines[row])[referenceColumn] ?? '';
        for (const link of referenceCell.matchAll(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
          for (const identifier of link[1].matchAll(/\b(?:AD\d+|(?:REQ|CON)-[A-Z]+-\d+)\b/g)) {
            if (!localReferenceResolves(file, link[2], identifier[0])) {
              findings.push({
                rule: 'security-source-map-reference-target-invalid',
                file,
                line: row + 1,
                collection: profile.id,
                item: identifier[0],
                missing: ['resolving local target'],
              });
            }
          }
          if (/\brequirements?\b/i.test(link[1])
              && !domainReferenceResolves(file, link[2], link[1])) {
            findings.push({
              rule: 'security-source-map-reference-target-invalid',
              file,
              line: row + 1,
              collection: profile.id,
              item: link[1],
              missing: ['matching requirement domain'],
            });
          }
        }
        const unlinkedText = referenceCell.replace(/\[[^\]]+\]\([^)]*\)/g, '');
        const bareAd = unlinkedText.match(/\bAD\d+\b/);
        if (bareAd) {
          findings.push({
            rule: 'security-source-map-ad-not-linked',
            file,
            line: row + 1,
            collection: profile.id,
            item: bareAd[0],
            missing: [bareAd[0]],
          });
        }
        for (const bareRequirement of unlinkedText.matchAll(/\b(?:REQ|CON)-[A-Z]+-\d+\b/g)) {
          findings.push({
            rule: 'security-source-map-requirement-not-linked',
            file,
            line: row + 1,
            collection: profile.id,
            item: bareRequirement[0],
            missing: [bareRequirement[0]],
          });
        }
        const vagueReference = unlinkedText.match(/\b[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)*\s+SDD\b/);
        if (vagueReference) {
          findings.push({
            rule: 'security-source-map-vague-reference',
            file,
            line: row + 1,
            collection: profile.id,
            item: vagueReference[0],
            missing: [vagueReference[0]],
          });
        }
      }
      row += 1;
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
      const endpoint = section.title.match(/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT)\s+[`]?([^\s`]+)/i);
      const aliases = {
        Authentication: ['Authentication', 'Auth'],
        Request: ['Request'],
        Response: ['Response', 'Response 200'],
        Errors: ['Errors', 'Error responses'],
        Source: ['Source', 'Implementation'],
        Implements: ['Implements'],
      };
      const present = (field) => aliases[field].some((alias) => labels.has(alias));
      const recognized = Object.keys(aliases).some((field) => present(field));
      if (!endpoint || (!recognized && body.trim() !== '')) continue;

      const detailed = ['Request', 'Errors', 'Source'].some((field) => present(field));
      const required = detailed
        ? ['Request', 'Response', 'Errors', 'Source', 'Implements']
        : ['Authentication', 'Response', 'Implements'];
      const missing = required.filter((field) => !present(field));
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
    if (!hasShapeField && body.trim() !== '') continue;

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
    const end = starts[index + 1] ? starts[index + 1].line - 1 : lines.length;
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

function scanDecisions(lines, file, findings) {
  const indexRows = new Map();
  const indexStart = lines.findIndex((line) => /^##\s+Decision Index\s*$/.test(line));
  const indexEnd = indexStart === -1
    ? -1
    : lines.findIndex((line, index) => index > indexStart && /^##\s+/.test(line));
  const boundedEnd = indexEnd === -1 ? lines.length : indexEnd;
  let canonicalHeaders = false;
  let headerLine = indexStart + 1;
  for (let index = indexStart + 1; index < boundedEnd; index += 1) {
    const cells = rawMarkdownCells(lines[index]).map((cell) => plain(cell));
    if (cells[0] !== 'ID' || cells[1] !== 'Decision') continue;
    headerLine = index + 1;
    canonicalHeaders = cells.length === ADR_INDEX_HEADERS.length
      && cells.every((cell, position) => cell === ADR_INDEX_HEADERS[position]);
    break;
  }
  if (indexStart !== -1 && !canonicalHeaders) {
    findings.push({
      rule: 'adr-index-columns-invalid', file, line: headerLine,
      collection: 'decision-index', item: 'Decision Index', missing: ADR_INDEX_HEADERS,
    });
  }

  for (let index = indexStart + 1; index < boundedEnd; index += 1) {
    const cells = rawMarkdownCells(lines[index]);
    const id = cells[0]?.match(/\bAD\d+\b/)?.[0];
    if (!id || cells.length < 3) continue;
    const idLink = cells[0].match(new RegExp(`\\[${id}\\]\\((#[^)]+)\\)`));
    const row = {
      id,
      cells,
      line: index + 1,
      href: idLink?.[1] ?? null,
      decision: canonicalHeaders ? cells[1] : '',
      summary: canonicalHeaders ? cells[2] : '',
      category: canonicalHeaders ? cells[3] : '',
      state: canonicalHeaders ? plain(cells[4]) : '',
    };
    indexRows.set(id, row);
    if (!idLink) {
      findings.push({
        rule: 'adr-index-id-not-linked', file, line: index + 1,
        collection: 'decision-index', item: id, missing: ['linked ID'],
      });
    }
    if (canonicalHeaders) validateAdrIndexRow(row, file, findings);
    if (cells.some((cell) => /^\(?redirect(?:ed)?\)?$/i.test(plain(cell)))) {
      findings.push({
        rule: 'adr-redirect-label-ambiguous', file, line: index + 1,
        collection: 'decision-index', item: id, missing: ['Redirect anchor'],
      });
    }
  }

  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^###\s+(AD\d+):/);
    if (heading) starts.push({ id: heading[1], start: index, line: index + 1 });
  }
  const sections = new Map(starts.map((section) => {
    const nextBoundary = lines.findIndex((line, index) =>
      index > section.start && /^#{1,3}\s+/.test(line));
    return [section.id, {
      ...section,
      anchor: githubHeadingAnchor(lines[section.start].replace(/^###\s+/, '')),
      end: nextBoundary === -1 ? lines.length : nextBoundary,
    }];
  }));

  for (const [id, row] of indexRows) {
    const section = sections.get(id);
    if (!section) {
      findings.push({
        rule: 'adr-index-section-missing', file, line: row.line,
        collection: 'decision-index', item: id, missing: ['ADR section'],
      });
    } else if (row.href && row.href !== `#${section.anchor}`) {
      findings.push({
        rule: 'adr-index-anchor-mismatch', file, line: row.line,
        collection: 'decision-index', item: id, missing: [`#${section.anchor}`],
      });
    }
  }
  for (const [id, section] of sections) {
    const row = indexRows.get(id);
    if (!row) {
      findings.push({
        rule: 'adr-section-index-missing', file, line: section.line,
        collection: 'decision-index', item: id, missing: ['index row'],
      });
      continue;
    }

    const bodyLines = lines.slice(section.start + 1, section.end);
    const status = bodyLines.find((line) => /^\*\*Status:\*\*/.test(line));
    if (!status) {
      findings.push({
        rule: 'adr-status-missing', file, line: section.line,
        collection: 'decision-index', item: id, missing: ['Status'],
      });
      continue;
    }

    const sectionState = adrStateFromStatus(status);
    if (row.state !== sectionState) {
      findings.push({
        rule: 'adr-index-state-mismatch', file, line: row.line,
        collection: 'decision-index', item: id, missing: [`State ${sectionState} from ADR Status`],
      });
    }

    if (row.summary && sectionState === 'Active') {
      const decision = adrField(bodyLines, 'Decision');
      const support = [decision, adrField(bodyLines, 'Context'), adrField(bodyLines, 'Consequences')]
        .filter(Boolean).join(' ');
      if (decision && !hasTokenOverlap(row.summary, decision)) {
        findings.push({
          rule: 'adr-index-summary-choice-unrelated', file, line: row.line,
          collection: 'decision-index', item: id, missing: ['summary grounded in Decision'],
        });
      }
      if (decision && !hasAdrBodySupport(row.summary, support)) {
        findings.push({
          rule: 'adr-index-summary-body-support-missing', file, line: row.line,
          collection: 'decision-index', item: id,
          missing: ['driver or operational consequence grounded in Decision, Context, or Consequences'],
        });
      }
    }

    if (row.summary && sectionState === 'Superseded') {
      const successors = markdownHrefs(status);
      if (successors.length > 0 && !markdownHrefs(row.summary).some((href) => successors.includes(href))) {
        findings.push({
          rule: 'adr-index-summary-successor-missing', file, line: row.line,
          collection: 'decision-index', item: id, missing: ['linked successor in Summary'],
        });
      }
    }

    if (row.summary && sectionState === 'Partially superseded') {
      const sectionHrefs = markdownHrefs(bodyLines.join(' '));
      const summaryHrefs = markdownHrefs(row.summary);
      if (!/(?:remain|retain)/i.test(adrRenderedText(row.summary))
        || !summaryHrefs.some((href) => sectionHrefs.includes(href))) {
        findings.push({
          rule: 'adr-index-summary-retained-scope-missing', file, line: row.line,
          collection: 'decision-index', item: id,
          missing: ['retained scope and linked replaced clause or successor in Summary'],
        });
      }
    }

    if (row.summary && sectionState === 'Redirect anchor') {
      const destinations = markdownHrefs(status);
      if (destinations.length === 0 || !markdownHrefs(row.summary).some((href) => destinations.includes(href))) {
        findings.push({
          rule: 'adr-index-summary-destination-missing', file, line: row.line,
          collection: 'decision-index', item: id, missing: ['linked redirect destination in Summary'],
        });
      }
    }

    if (/^\*\*Status:\*\*\s+Superseded\b/i.test(status)) {
      const [idCell, decisionCell] = row.cells;
      if (!/^~~[\s\S]+~~$/.test(idCell) || !/^~~[\s\S]+~~$/.test(decisionCell)) {
        findings.push({
          rule: 'adr-superseded-not-struck', file, line: row.line,
          collection: 'decision-index', item: id,
          missing: ['struck ID', 'struck decision'],
        });
      }
      const hasHistoricalBody = bodyLines.some((line) =>
        /^\*\*(?:Context|Decision|Consequences):\*\*\s+\S/.test(line));
      if (!hasHistoricalBody) {
        findings.push({
          rule: 'adr-superseded-history-missing', file, line: section.line,
          collection: 'decision-index', item: id, missing: ['historical body'],
        });
      }
    }

    if (/^\*\*Status:\*\*\s+Partially superseded\b/i.test(status)) {
      const [idCell, decisionCell] = row.cells;
      if (/^~~[\s\S]+~~$/.test(idCell) || /^~~[\s\S]+~~$/.test(decisionCell)) {
        findings.push({
          rule: 'adr-partial-is-struck', file, line: row.line,
          collection: 'decision-index', item: id, missing: ['unstruck ID', 'unstruck decision'],
        });
      }
      const successor = status.match(/\[[^\]]+\]\([^)]+\)/)?.[0];
      const detail = successor ? status.slice(status.indexOf(successor) + successor.length)
        .replace(/^\s*(?:\([^)]*\))?\s*[:.—-]?\s*/, '') : '';
      if (!successor || detail.length < 12) {
        findings.push({
          rule: 'adr-partial-successor-detail-missing', file, line: section.line,
          collection: 'decision-index', item: id,
          missing: [...(!successor ? ['linked successor'] : []), ...(detail.length < 12 ? ['replaced clause'] : [])],
        });
      }
    }

    if (/^\*\*Status:\*\*\s+(?:Reclassified|Merged)\b/i.test(status)) {
      if (!row.cells.some((cell) => plain(cell) === 'Redirect anchor')) {
        findings.push({
          rule: 'adr-redirect-label-ambiguous', file, line: row.line,
          collection: 'decision-index', item: id, missing: ['Redirect anchor'],
        });
      }
      if (!/\[[^\]]+\]\([^)]+\)/.test(status)) {
        findings.push({
          rule: 'adr-redirect-destination-not-linked', file, line: section.line,
          collection: 'decision-index', item: id, missing: ['linked destination'],
        });
      }
    }
  }
}

function scanProjectLane(lines, file, findings) {
  const firstSection = lines.findIndex((line) => /^##\s+/.test(line));
  const preamble = lines.slice(0, firstSection === -1 ? lines.length : firstSection).join('\n');
  const labels = new Set(
    [...preamble.matchAll(/^\*\*([^*:\n]+):\*\*/gm)].map((match) => plain(match[1])),
  );
  const headings = new Set(
    lines.flatMap((line) => {
      const match = line.match(/^##\s+(.+)$/);
      return match ? [plain(match[1])] : [];
    }),
  );
  const missing = [
    ...['Audience', 'Owns'].filter((field) => !labels.has(field)),
    ...['Contents', 'Requirement and Source Map', 'Related Documentation']
      .filter((heading) => !headings.has(heading)),
  ];
  if (missing.length > 0) {
    findings.push({
      rule: 'project-lane-envelope-missing',
      file,
      line: 1,
      collection: 'project-lane',
      item: path.basename(file),
      missing,
    });
  }
}

export async function checkDocuments(files) {
  const findings = [];

  for (const file of files) {
    const kind = laneKind(file);
    if (!kind) continue;
    const content = stripHtmlComments(await readFile(file, 'utf8'));
    const lines = content.split(/\r?\n/);
    scanTables(maskFencedLines(lines), kind, file, findings);
    scanSections(lines, kind, file, findings);
    if (kind === 'deployment') scanDeploymentSections(maskFencedLines(lines), file, findings);
    if (kind === 'decisions') scanDecisions(maskFencedLines(lines), file, findings);
    if (kind === 'project') scanProjectLane(maskFencedLines(lines), file, findings);
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
