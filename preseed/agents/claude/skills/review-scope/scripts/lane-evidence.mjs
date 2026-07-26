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
import { join, resolve, sep } from 'node:path';

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
  const abs = resolve(repo, relative);
  // An anchor target is text from the branch under review. `..` in one must not
  // turn a resolution check into a filesystem probe outside the repository.
  if (!abs.startsWith(resolve(repo) + sep) || !existsSync(abs)) return null;
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
        // Same repo-escape guard as read(): a `../` candidate must not probe
        // outside the tree just because this branch checks a path directly.
        const abs = resolve(repo, candidate);
        if (abs.startsWith(resolve(repo) + sep) && existsSync(abs)) {
          rows.push({ ref: candidate, resolved: true, as: 'path' });
          continue;
        }
      }
      // A reference must resolve to CODE. Grep finds the documentation file that
      // names it, so counting that as resolution makes every reference
      // self-confirming and the whole pass vacuous -- a deleted symbol still
      // written about would read as live.
      rows.push({ ref: candidate, resolved: declaredIn(repo, candidate), as: 'symbol' });
    }
  }
  return rows;
}

// Only a path that can hold code answers "does this resolve to code?". A token
// appearing in a YAML comment or a lockfile is not an implementation.
const CODE_PATH = /\.(ts|tsx|js|jsx|mjs|cjs|sh|bash|py|go|rs|java|rb|php|sql)$/;

// A symbol has to be DECLARED somewhere to count. Matching any occurrence made
// every short or common token resolve, which is a false clean in a check whose
// whole job is spotting the reference that no longer resolves.
const ereEscape = (value) => value.replace(/[.[\]{}()*+?^$|\\/-]/g, '\\$&');

const declaredIn = (repo, symbol) => {
  const name = ereEscape(symbol);
  const hits = git(repo, ['grep', '-lE', '-a', '--',
    // Keyword form (`function foo`, `const foo`, `export foo`), definition
    // shape (`foo() {` for a shell function or a class method), and binding
    // shape (`foo:` / `foo =` for an object member or a re-export).
    `((function|const|let|var|class|export|def|func|type|interface)[[:space:]]+${name}\\b`
    + `|(^|[[:space:]])${name}[[:space:]]*\\([^)]*\\)[[:space:]]*[{:]`
    + `|(^|[[:space:]])${name}[[:space:]]*[:=][^=>])`])
    .split('\n').filter(Boolean).filter(live).filter((path) => CODE_PATH.test(path));
  return hits.length > 0;
};

// Identifiers too short or too generic to be a caller signal. Left unfiltered,
// the declaration scan harvested `r`, `x`, `and`, `git`, `read` and greped the
// whole repository for each -- thousands of tokens of unrelated matches pushed
// into every prompt by the module whose purpose is to shrink it.
const NOISE = new Set([
  'and', 'or', 'not', 'if', 'for', 'the', 'out', 'run', 'get', 'set', 'new',
  'git', 'read', 'write', 'head', 'body', 'key', 'name', 'path', 'file', 'data',
]);
const isSignal = (symbol) => symbol.length >= 4 && !NOISE.has(symbol.toLowerCase());

// Bounded call sites for symbols the diff declared at top level. The code lane
// is told to close caller impact "with one bounded search per symbol", which is
// a turn per symbol; this is the same searches, batched and filtered.
function callSites(repo, files, range) {
  if (!range) return null;
  const source = files.filter((file) => CODE_PATH.test(file));
  if (source.length === 0) return [];
  const patch = git(repo, ['diff', '-U0', range, '--', ...source.slice(0, MAX_LIST)]);
  const symbols = new Set();
  // An EXPORTED symbol is kept whatever it is called: `run`, `read` and `sync`
  // are real exports, and dropping them by name silently loses caller impact for
  // the API surface. The noise filter applies only to unexported declarations,
  // which is where `x`, `and` and `git` came from.
  for (const [, name] of patch.matchAll(/^[+-]export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
    symbols.add(name);
  }
  // Top-level declarations only: an indented binding is a local, and a local has
  // no callers outside its own scope.
  for (const [, name] of patch.matchAll(/^[+-](?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (isSignal(name)) symbols.add(name);
  }
  for (const [, name] of patch.matchAll(/^[+-]([a-z_][\w]*)\(\)\s*\{/gm)) {
    if (isSignal(name)) symbols.add(name);
  }
  const rows = [];
  for (const symbol of [...symbols].slice(0, MAX_LIST)) {
    const matched = git(repo, ['grep', '-n', '--fixed-strings', '-a', '--', symbol])
      .split('\n').filter(Boolean).filter(live)
      .filter((line) => CODE_PATH.test(line.split(':')[0] ?? ''));
    // Decide BEFORE clipping: a symbol over the cap emits no list at all, so
    // clipping its matches is work whose only outcome is being discarded --
    // inside a time budget whose expiry loses every other answer too.
    //
    // Dropping the row entirely would read to the lane as "no callers", and the
    // lane is told not to re-check what it was handed, so it is marked instead.
    if (matched.length > 12) {
      rows.push({ symbol, sites: [], tooCommon: true, hitCount: matched.length });
      continue;
    }
    const hits = matched.map(clip);
    rows.push({ symbol, sites: hits });
  }
  return rows;
}

// REQ dependency acyclicity: every `Dependencies:` edge, walked for a cycle.
// The lane reported "372 REQs, 585 edges, 0 cycles" by doing this itself, which
// is a whole turn to learn a fact that does not need a model.
function reqDependencyGraph(repo, specFiles) {
  const edges = new Map();
  for (const file of specFiles) {
    const body = read(repo, file);
    if (body === null) continue;
    let current = null;
    for (const line of body.split('\n')) {
      const heading = /^###\s+(REQ-[A-Z]+-\d+)/.exec(line);
      if (heading) { current = heading[1]; edges.set(current, edges.get(current) ?? []); continue; }
      if (!current || !line.startsWith('**Dependencies:**')) continue;
      for (const [, target] of line.matchAll(/(REQ-[A-Z]+-\d+)/g)) edges.get(current).push(target);
    }
  }
  // Iterative DFS: a spec tree can be deep enough that recursion is a risk, and
  // a crash here would read as "no cycles" to a lane told to trust this block.
  const cycles = [];
  const state = new Map();
  for (const start of edges.keys()) {
    if (state.get(start)) continue;
    const stack = [[start, 0]];
    const onPath = new Set([start]);
    state.set(start, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const kids = edges.get(frame[0]) ?? [];
      if (frame[1] >= kids.length) { onPath.delete(frame[0]); state.set(frame[0], 2); stack.pop(); continue; }
      const next = kids[frame[1]];
      frame[1] += 1;
      if (!edges.has(next)) continue;
      if (onPath.has(next)) { cycles.push(`${frame[0]} -> ${next}`); continue; }
      if (state.get(next) === 2) continue;
      state.set(next, 1);
      onPath.add(next);
      stack.push([next, 0]);
    }
  }
  const edgeCount = [...edges.values()].reduce((total, list) => total + list.length, 0);
  return { reqs: edges.size, edges: edgeCount, cycles: cycles.slice(0, MAX_LIST) };
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
    // The five manifest rows this lane was still computing itself. Each is a
    // tree walk or a graph traversal -- no model required, and every one of them
    // was costing a turn that re-sends the whole prompt.
    const specGlob = existsSync(join(repo, 'sdd/spec')) ? 'sdd/spec' : 'sdd';
    const specFiles = git(repo, ['ls-files', '--', `${specGlob}/*.md`]).split('\n').filter(Boolean);
    // Resolve links relative to the INDEX file, not to the spec glob. The index
    // lives at sdd/README.md and links `spec/agents.md`; resolving that under
    // sdd/spec/ produced sdd/spec/spec/agents.md and reported every real entry
    // as dangling -- a wall of false findings in a block the lane is told to
    // trust.
    const indexPath = existsSync(join(repo, `${specGlob}/README.md`)) ? `${specGlob}/README.md` : 'sdd/README.md';
    const indexDir = indexPath.slice(0, indexPath.lastIndexOf('/'));
    const index = read(repo, indexPath) ?? '';
    const linked = [...index.matchAll(/\]\(([^)#]+\.md)[^)]*\)/g)]
      .map(([, target]) => target)
      .filter((target) => !target.startsWith('http'));
    const linkedNames = new Set(linked.map((target) => target.split('/').pop()));
    out.indexIntegrity = {
      // Against the LINK TARGETS, not the raw text: a filename mentioned in
      // prose, or a different file whose name merely contains this one, both
      // satisfied a substring test and passed the row silently.
      unindexed: specFiles.filter((file) => {
        const base = file.split('/').pop() ?? '';
        return base !== 'README.md' && !base.startsWith('.') && !linkedNames.has(base);
      }),
      dangling: linked.filter((target) => !existsSync(join(repo, indexDir, target))),
    };
    out.dependencyGraph = reqDependencyGraph(repo, specFiles);
    // Layout-resolved locally: this module does not carry the triage document,
    // and referencing it would have thrown into the catch-all, handing the lane
    // an error object and quietly restoring every lookup this removes.
    out.queue = read(repo, specGlob === 'sdd/spec' ? 'sdd/spec/.review-queue.md' : 'sdd/.review-needed.md');
    // Drift detection asks whether THIS diff's REQs got an entry, so the recent
    // head of the file answers it; carrying the whole history would blow the
    // evidence cap and shed the resolutions that remove turns.
    const changelog = read(repo, `${specGlob}/changes.md`) ?? '';
    const dates = [...changelog.matchAll(/^## .+$/gm)];
    out.changelog = dates.length > 1
      ? changelog.slice(dates[0].index, dates[1].index)
      : changelog.slice(0, 8000) || null;
    out.specIndex = (read(repo, 'sdd/README.md') ?? '')
      .split('\n').filter((line) => /^#{1,3}\s|^\s*[-*]\s*\[/.test(line)).join('\n') || null;
    out.pending = read(repo, 'sdd/spec/pending.md') ?? read(repo, 'sdd/pending.md');
    out.anchors = summarise(resolveAnchors(repo, files.filter((f) => f.startsWith('sdd/'))));
  } else if (lane === 'doc-updater') {
    // The classifier spawns this lane when a documentation @impl cites a file in
    // the diff, so that citation IS its work set when no doc file was touched.
    // Handing it only the touched-doc anchors reported checked:0 and confirmed a
    // conclusion the spawn reason contradicts.
    const source = files.filter((f) => !f.startsWith('sdd/') && !f.startsWith('documentation/'));
    out.docsCitingChanged = source.slice(0, MAX_LIST).map((file) => ({
      file,
      citedBy: git(repo, ['grep', '-l', '--fixed-strings', '-a', '--', `@impl: ${file}`, 'documentation'])
        .split('\n').filter(Boolean).filter(live).slice(0, 12),
    })).filter((row) => row.citedBy.length > 0);
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
