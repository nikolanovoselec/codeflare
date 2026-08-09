#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PLACEHOLDERS = new Set(['tbd', 'todo', 'unknown', 'none', 'n/a', 'later']);
const BOILERPLATE = new Set(['investigate', 'fix as needed', 'update later']);
const FIELDS = ['Context', 'Recommendation', 'Rationale'];

function parseArgs(argv) {
  const index = argv.indexOf('--repo');
  return { repo: index >= 0 ? argv[index + 1] : process.cwd() };
}

function scalar(raw, key) {
  const match = raw.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm'));
  return match?.[1]?.replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
}

function fieldValue(body, name) {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^\\*\\*${name}:\\*\\*`, 'i').test(line.trim()));
  if (start < 0) return '';
  const first = lines[start].replace(new RegExp(`^\\s*\\*\\*${name}:\\*\\*\\s*`, 'i'), '');
  const continuation = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\*\*[A-Za-z][^*]*:\*\*/.test(lines[index]) || /^###\s+TRIAGE-/i.test(lines[index])) break;
    continuation.push(lines[index]);
  }
  return [first, ...continuation].join(' ').replace(/\s+/g, ' ').trim();
}

function normalized(value) {
  return value.replace(/^[\s`_*'"-]+|[\s`_*'".:-]+$/g, '').replace(/\s+/g, ' ').toLowerCase();
}

function hasLocator(value) {
  return /https?:\/\/\S+/i.test(value)
    || /(?:^|\s)(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+(?::\d+|::[\w.$-]+)/.test(value)
    || /\b[0-9a-f]{7,40}\b/i.test(value)
    || /\b(?:PR|issue)\s*#?\d+\b/i.test(value)
    || /\b(?:test|release)\s+[`"']?[^\n,;]{3,}/i.test(value);
}

function substantive(field, value) {
  const plain = normalized(value);
  if (!plain || PLACEHOLDERS.has(plain) || BOILERPLATE.has(plain)) return false;
  if (field === 'Context') return hasLocator(value);
  if (field === 'Recommendation') {
    return plain.split(/\s+/).length >= 4
      && /\b(?:add|allow|block|change|enforce|preserve|reject|remove|require|return|route|store|update|validate|write|must|should)\b/i.test(value);
  }
  return plain.split(/\s+/).length >= 5
    && /\b(?:because|follows|given|indicates|since|so that|therefore|shows|demonstrates)\b/i.test(value);
}

function entries(body) {
  const matches = [...body.matchAll(/^###\s+(TRIAGE-[^\s]+).*$/gim)];
  if (matches.length === 0) {
    return /^\s*_Awaiting first finding\._\s*$/i.test(body) || !body.trim()
      ? []
      : [{ id: 'unheaded-entry', body }];
  }
  return matches.map((match, index) => ({
    id: match[1],
    body: body.slice(match.index, matches[index + 1]?.index ?? body.length),
  }));
}

export function main(argv = process.argv.slice(2)) {
  const { repo } = parseArgs(argv);
  if (!repo) throw new Error('--repo requires a value');
  const nested = existsSync(join(repo, 'sdd/spec'));
  const base = nested ? 'sdd/spec' : 'sdd';
  const configPath = `${base}/config.yml`;
  const triagePath = `${base}/.init-triage.md`;
  const config = existsSync(join(repo, configPath)) ? readFileSync(join(repo, configPath), 'utf8') : '';
  const transition = scalar(config, 'transition') === 'true';
  if (!existsSync(join(repo, triagePath))) {
    return { transition, triagePath, checked: 0, findings: [] };
  }
  const body = readFileSync(join(repo, triagePath), 'utf8');
  const openEntries = entries(body).filter((entry) => /^\*\*Status:\*\*\s+open\b/im.test(entry.body));
  const findings = [];
  for (const entry of openEntries) {
    for (const field of FIELDS) {
      const value = fieldValue(entry.body, field);
      if (!substantive(field, value)) {
        findings.push({
          id: 'import-triage-placeholder',
          severity: 'HIGH',
          entry: entry.id,
          field,
          reason: `${field} is missing, placeholder, or lacks the required concrete evidence`,
        });
      }
    }
  }
  return { transition, triagePath, checked: openEntries.length, findings };
}

try {
  const result = main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.findings.length > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`cannot validate import triage: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
