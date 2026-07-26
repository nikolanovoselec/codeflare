#!/usr/bin/env node
// Deterministic answers to the questions a review lane would otherwise look up.
//
// WHY THIS EXISTS
//
// Phase 0 triage removed six startup calls per lane, and the packet removed the
// diff rebuild. Neither touched the lookups the lane documents mandate in their
// own checklists, and those are what the turn count is actually made of.
// Measured: a doc lane whose entire ownership was ONE table-cell edit still
// spent 13 turns, because the manifest told it to confirm the index exists,
// probe the doc layout, resolve every concrete reference to real code, verify
// every anchor, and check the record before escalating. None of that scales
// with the diff. All of it is grep and file reads.
//
// A lane pays its whole prompt again on every turn, so a lookup is never priced
// at what it returns -- it is priced at the entire conversation so far. Handing
// the same answers over costs their bytes once.
//
// FAIL-SAFE DIRECTION
//
// This resolves evidence, it never decides a review. Every failure yields an
// absent field, and an absent field means the lane gathers that item itself
// exactly as before. Nothing here can cause a check to be skipped: the lane
// documents still own which checks run, and a field this script could not
// resolve is reported as `null` rather than as a clean result.
//
// Usage:
//   lane-evidence.mjs --repo <root> --lane <name> [--range <base>..<head>]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_LIST = 40;
const MAX_LINE = 200;
// Generated trees are derived output. A match inside one is never a call site a
// reviewer acts on, and one minified line can be larger than the whole packet.
//
// Filtered on the RESULTS, not passed to git as pathspec exclusions. An exclude
// pathspec naming a file the repo does not have makes git exit non-zero with
// "no such path in the working tree", the grep returns nothing, and every
// reference then reads as unresolved -- inventing stale-doc findings out of a
// missing lockfile. Filtering after the fact cannot fail that way.
const GENERATED = /(^|\/)(graphify-out\/|.*\.generated\.|.*\.min\.|package-lock\.json)/;
const live = (line) => !GENERATED.test(line.split(':')[0] ?? line);

const clip = (line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}...` : line);

// Resolved items are a count; unresolved ones are the finding. Emitting both in
// full is how a 683-anchor spec tree became 156 KB carried on every turn.
function summarise(rows) {
  const failed = rows.filter((row) => !row.resolved);
  return { checked: rows.length, unresolved: failed.slice(0, MAX_LIST) };
}

function git(repo, args) {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return '';
  }
}

function read(repo, relative) {
  const abs = join(repo, relative);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key?.startsWith('--')) continue;
    values[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return values;
}

function changedFiles(repo, range) {
  if (!range) return [];
  const raw = git(repo, ['diff', '--name-only', '--no-renames', '-z', range]);
  return raw.split('\0').filter(Boolean);
}

// The ADR ledger, reduced to what "check the record before flagging" needs: an
// id, a title, and whether it is binding. The bodies are the expensive part and
// none of them are needed to decide whether a finding is already settled -- a
// lane that finds a relevant id can still read that one ADR.
function adrLedger(repo) {
  const body = read(repo, 'documentation/decisions/README.md');
  if (body === null) return null;
  const entries = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^###\s+(AD\d+):\s*(.+?)\s*$/.exec(lines[i]);
    if (!heading) continue;
    let status = null;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      const found = /^\*\*Status:\*\*\s*([A-Za-z]+)/.exec(lines[j]);
      if (found) { status = found[1]; break; }
      if (/^###\s/.test(lines[j])) break;
    }
    entries.push({ id: heading[1], title: heading[2], status });
  }
  return entries;
}

const IMPL_RE = /<!--\s*@impl:\s*([^:\s]+)(?:::([^\s=]+))?(?:\s*=\s*(.+?))?\s*-->/g;
const TEST_RE = /<!--\s*@test:\s*([^\s(]+)\s*\(([^)]+)\)\s*-->/g;

// An anchor resolves when its file exists AND the thing it names is present in
// that file. Both halves matter: a path that exists with the symbol renamed
// underneath is the drift these anchors are for, and it is what a lane spends a
// turn per anchor discovering.
function resolveAnchors(repo, files) {
  const rows = [];
  for (const file of files.slice(0, MAX_LIST)) {
    const body = read(repo, file);
    if (body === null) continue;
    for (const [, target, symbol, value] of body.matchAll(IMPL_RE)) {
      const targetBody = read(repo, target);
      const needle = value ?? symbol ?? null;
      rows.push({
        kind: 'impl',
        in: file,
        target,
        symbol: needle,
        resolved: targetBody !== null && (needle === null || targetBody.includes(needle)),
      });
    }
    for (const [, target, title] of body.matchAll(TEST_RE)) {
      const targetBody = read(repo, target);
      rows.push({
        kind: 'test',
        in: file,
        target,
        symbol: title,
        resolved: targetBody !== null && targetBody.includes(title),
      });
    }
  }
  return rows;
}

// Every backticked identifier or path in a touched doc, answered against the
// tree. This is Pass 8 and Pass 12 -- "does this reference resolve to real
// code?" -- which the doc lane otherwise runs one `git grep` at a time.
function resolveDocReferences(repo, files) {
  const rows = [];
  const seen = new Set();
  for (const file of files.slice(0, MAX_LIST)) {
    const body = read(repo, file);
    if (body === null) continue;
    for (const [, span] of body.matchAll(/`([^`\n]{2,120})`/g)) {
      const candidate = span.trim();
      // Only things that claim to be a path or an identifier are checkable; a
      // backticked English phrase is not a broken reference.
      if (!/^[\w./@-]+$/.test(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      if (rows.length >= MAX_LIST * 4) break;
      if (candidate.includes('/') || candidate.includes('.')) {
        if (existsSync(join(repo, candidate))) { rows.push({ ref: candidate, resolved: true, as: 'path' }); continue; }
      }
      // A reference must resolve to CODE. Grep finds the documentation file that
      // names it, so counting that as resolution makes every reference
      // self-confirming and the whole pass vacuous -- a deleted symbol still
      // written about would read as live.
      const hit = git(repo, ['grep', '-l', '--fixed-strings', '-a', '--', candidate])
        .split('\n').filter(Boolean).filter(live)
        .filter((path) => !path.startsWith('documentation/') && !/^[A-Z]+\.md$/.test(path));
      rows.push({ ref: candidate, resolved: hit.length > 0, as: hit.length > 0 ? 'symbol' : 'unresolved' });
    }
  }
  return rows;
}

// Bounded call sites for symbols the diff exported or changed. The code lane is
// told to close caller impact "with one bounded search per symbol", which is a
// turn per symbol; this is the same searches, batched.
function callSites(repo, files, range) {
  if (!range) return null;
  const patch = git(repo, ['diff', '-U0', range, '--', ...files.slice(0, MAX_LIST)]);
  const symbols = new Set();
  for (const [, name] of patch.matchAll(/^[+-].*?\b(?:function|const|class|export\s+function|export\s+const)\s+([A-Za-z_$][\w$]*)/gm)) {
    symbols.add(name);
  }
  for (const [, name] of patch.matchAll(/^[+-]\s*([a-z_][\w]*)\(\)\s*\{/gm)) {
    symbols.add(name);
  }
  const rows = [];
  for (const symbol of [...symbols].slice(0, MAX_LIST)) {
    const hits = git(repo, ['grep', '-n', '--fixed-strings', '-a', '--', symbol])
      .split('\n').filter(Boolean).filter(live).slice(0, 12).map(clip);
    rows.push({ symbol, sites: hits });
  }
  return rows;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo || process.cwd();
  const lane = args.lane || '';
  const range = args.range || null;
  const files = changedFiles(repo, range);

  // Every lane is told to check the record before escalating a judgment call.
  const out = { lane, adrs: adrLedger(repo) };

  if (lane === 'spec-reviewer') {
    out.specIndex = (read(repo, 'sdd/README.md') ?? '')
      .split('\n').filter((line) => /^#{1,3}\s|^\s*[-*]\s*\[/.test(line)).join('\n') || null;
    out.pending = read(repo, 'sdd/spec/pending.md') ?? read(repo, 'sdd/pending.md');
    out.anchors = summarise(resolveAnchors(repo, files.filter((f) => f.startsWith('sdd/'))));
  } else if (lane === 'doc-updater') {
    const nested = existsSync(join(repo, 'documentation/lanes'));
    const index = read(repo, 'documentation/README.md');
    out.docLayout = nested ? 'nested' : 'flat';
    out.docIndexPresent = index !== null;
    // The index routes; its prose principles do not. Headings and links only.
    out.docIndex = (index ?? '')
      .split('\n').filter((line) => /^#{1,3}\s|^\s*[-*|]\s*.*\[/.test(line)).join('\n') || null;
    const docFiles = files.filter((f) => f.startsWith('documentation/') || /^[A-Z]+\.md$/.test(f));
    out.anchors = summarise(resolveAnchors(repo, docFiles));
    out.references = summarise(resolveDocReferences(repo, docFiles));
  } else if (lane === 'code-reviewer') {
    const source = files.filter((f) => !f.startsWith('sdd/') && !f.startsWith('documentation/'));
    out.callSites = callSites(repo, source, range);
    // An anchor anywhere in the spec or doc trees that cites a file this diff
    // touched is the orphan check the code lane runs on a rename.
    out.anchorsCitingChanged = source.slice(0, MAX_LIST).map((file) => ({
      file,
      citedBy: git(repo, ['grep', '-l', '--fixed-strings', '-a', '--', `@impl: ${file}`])
        .split('\n').filter(Boolean).filter(live).slice(0, 12),
    })).filter((row) => row.citedBy.length > 0);
  }
  return out;
}

try {
  process.stdout.write(`${JSON.stringify(main(), null, 1)}\n`);
} catch (error) {
  // An evidence failure must never look like a clean result: emit the error and
  // no fields, so every check falls back to the lane gathering it itself.
  process.stdout.write(`${JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
}
