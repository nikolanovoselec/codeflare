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
// Failures are the finding, so they are not the place to save bytes. At 40 the
// reference list truncated on a clean tree -- 113 failures shown as 40 with a
// flag -- so the lane could not see what it was being asked to act on, and two
// separate comparisons of this resolver's own output silently compared slices
// rather than verdicts. `MAX_TOTAL` below is the real bound; this only stops a
// pathological list from being the whole block.
const MAX_UNRESOLVED = 400;
// What the scan will look at, as opposed to how many failures it will list.
// Sharing one number made a clean doc set trip the truncation marker.
const MAX_CANDIDATES = 600;
const MAX_LINE = 200;
// A cited file's own diff, and the ceiling on all of them together. Bounded
// twice because this is the one field that scales with the diff rather than
// with the tree, and blowing the evidence cap sheds the resolutions instead.
const MAX_CITED_PATCH = 6000;
const MAX_CITED_PATCH_TOTAL = 24000;
const MAX_CHANGELOG_ENTRIES = 12;
// The whole block is bounded HERE rather than by the caller, because only one
// caller had a bound. A lane runner capped and shed by field; the runtime that
// asks for this through the packet CLI had no cap at all, so the same resolver
// was safe in one runtime and unbounded in the other. The shed belongs to the
// program both runtimes share.
const MAX_TOTAL = 65536;
// Generated trees are derived output. A match inside one is never a call site a
// reviewer acts on, and one minified line can be larger than the whole packet.
//
// Filtered on the RESULTS, not passed to git as pathspec exclusions. An exclude
// pathspec naming a file the repo does not have makes git exit non-zero with
// "no such path in the working tree", the grep returns nothing, and every
// reference then reads as unresolved -- inventing stale-doc findings out of a
// missing lockfile. Filtering after the fact cannot fail that way.
const GENERATED = /(^|\/)(graphify-out\/|node_modules\/|vendor\/|third_party\/|.*\.generated\.|.*\.min\.|.*-lock\.(json|yaml)$|.*\.lock$)/;
const live = (line) => !GENERATED.test(line.split(':')[0] ?? line);

const clip = (line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}...` : line);

// Resolved items are a count; unresolved ones are the finding. Emitting both in
// full is how a 683-anchor spec tree became 156 KB carried on every turn.
// `truncated` is not cosmetic. Every resolver here caps its input, so a capped
// scan otherwise reaches the lane as a non-zero `checked` with an empty
// `unresolved` -- which the lane is told to read as a clean pass. That is a
// false clean in the one direction this module promises never to fail in, so a
// scan that did not see everything says so and the lane finishes it.
function summarise(rows, inputTruncated = false, passes) {
  const failed = rows.filter((row) => !row.resolved);
  const weak = rows.filter((row) => row.resolved && row.as === 'literal');
  const weakManifest = rows.filter((row) => row.resolved && row.as === 'manifest');
  // Both emitted lists are bounded, so both have to be able to raise the flag.
  // Marking only the failure list reintroduced the exact false clean this
  // function documents, in the field added to prevent one.
  const truncated = inputTruncated || failed.length > MAX_UNRESOLVED
    || weak.length > MAX_UNRESOLVED || weakManifest.length > MAX_UNRESOLVED;
  return {
    checked: rows.length,
    unresolved: failed.slice(0, MAX_UNRESOLVED),
    ...(truncated ? { truncated: true } : {}),
    // Labelling the weaker resolution was pointless while only FAILURES were
    // emitted: the label reached nothing, so a name kept alive by an unrelated
    // fixture string, an error message or a dead compatibility branch arrived
    // as an ordinary clean. Surfaced separately so the lane can weigh it --
    // these resolved, but on the weakest evidence this module accepts.
    ...(weak.length ? { resolvedOnlyByStringLiteral: weak.slice(0, MAX_UNRESOLVED) } : {}),
    // Same reason, weaker evidence: this name is a token in a dependency
    // manifest and nothing stronger. It is a resolution, not a clean.
    ...(weakManifest.length ? { resolvedOnlyByDependencyManifest: weakManifest.slice(0, MAX_UNRESOLVED) } : {}),
    // How many passes over the tree the answers cost. Constant against the
    // number of names asked about -- which is the contract, and is otherwise
    // only checkable with a stopwatch.
    ...(passes === undefined ? {} : { passes }),
  };
}

// Counted so the cost contract is checkable rather than timed: reference
// resolution must take the same number of passes over the tree whether a
// document cites twenty names or two hundred.
let gitCalls = 0;

// `git grep` exits 1 for "no match", which is an answer. Any other non-zero
// status is a failure, and a failure that reads as an empty result turns every
// symbol in the dropped chunk into a stale-doc finding -- so the two are
// distinguished here rather than collapsed.
function gitStatus(repo, args) {
  gitCalls += 1;
  try {
    return { out: execFileSync('git', args, { cwd: repo, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 }), failed: false };
  } catch (error) {
    return { out: String(error?.stdout ?? ''), failed: error?.status !== 1 };
  }
}

function git(repo, args) {
  return gitStatus(repo, args).out;
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
    // Delimited rows, not objects. The ledger is the largest fixed cost in the
    // block -- 117 entries carried by every lane on every round -- and a third of
    // it was the same three key names repeated 117 times.
    entries.push(status ? `${heading[1]}|${heading[2]}|${status}` : `${heading[1]}|${heading[2]}`);
  }
  return entries;
}

// Which tracked files an index links to, and which of its links point at
// nothing. Both index-owning lanes run the same walk, so it is written once.
function indexIntegrity(repo, indexPath, tracked) {
  // Resolve links relative to the INDEX file, not to the tree it indexes. The
  // spec index lives at sdd/README.md and links `spec/agents.md`; resolving that
  // under sdd/spec/ produced sdd/spec/spec/agents.md and reported every real
  // entry as dangling -- a wall of false findings in a block the lane is told to
  // trust.
  const cut = indexPath.lastIndexOf('/');
  const indexDir = cut === -1 ? '.' : indexPath.slice(0, cut);
  const index = read(repo, indexPath) ?? '';
  const linked = [...index.matchAll(/\]\(([^)#]+\.md)[^)]*\)/g)]
    .map(([, target]) => target)
    .filter((target) => !target.startsWith('http'));
  // Compared as resolved repo-relative paths, not basenames. A link to
  // `lanes/architecture.md` marked a sibling `architecture.md` indexed too, and
  // an unindexed file reported as indexed is a false clean.
  const linkedPaths = new Set(linked.map((target) => join(indexDir, target)));
  return {
    // Against the LINK TARGETS, not the raw text: a filename mentioned in prose,
    // or a different file whose name merely contains this one, both satisfied a
    // substring test and passed the row silently.
    unindexed: tracked.filter((file) => {
      const base = file.split('/').pop() ?? '';
      return base !== 'README.md' && !base.startsWith('.') && !linkedPaths.has(file);
    }),
    dangling: linked.filter((target) => !existsSync(join(repo, indexDir, target))),
  };
}

// A doc goes stale because of what a change SAID, not because it happened. The
// packet is scoped to the files a lane OWNS, so a doc lane reviewing a diff that
// touched no documentation/ file was handed files:[] and an empty patch, then
// spent three of its eleven turns re-running `git diff` one cited path at a
// time. The change itself is the evidence for the only question asked about it.
// A clipped patch is reported as clipped. The lane is told to read the row and
// gather only where a marker says the evidence is incomplete, so a silently
// truncated patch means judging a change from its first 6 KB while forbidden to
// fetch the rest -- a false clean in the one check this lane exists for.
function filePatch(repo, range, file) {
  if (!range) return null;
  const patch = git(repo, ['diff', '--no-renames', range, '--', file]);
  if (!patch) return null;
  if (patch.length <= MAX_CITED_PATCH) return { patch, truncated: false };
  return { patch: `${patch.slice(0, MAX_CITED_PATCH)}\n...truncated`, truncated: true };
}

// A formal `@impl:` anchor and a plain mention of the path are both ways a doc
// depends on a file, and the lane greps for both by hand. The anchor form
// contains the path, so one boundary-delimited search over the path covers
// both. Delimited, because a bare substring made `src/a.ts` match `src/a.ts.bak`
// and `vendor/src/a.ts` -- spurious work set rows, each spending patch budget a
// genuine citation needs.
function citedBy(repo, file) {
  // A trailing dot is only a continuation when an extension char follows it:
  // `src/a.ts.bak` must not match `src/a.ts`, but prose ending `src/a.ts.` must.
  const pattern = `(^|[^A-Za-z0-9_/.-])${ereEscape(file)}([^A-Za-z0-9_.-]|\\.[^A-Za-z0-9]|\\.$|$)`;
  return git(repo, ['grep', '-lE', '-a', '--', pattern, 'documentation'])
    .split('\n').filter(Boolean).filter(live).slice(0, 12);
}

const IMPL_RE = /<!--\s*@impl:\s*([^:\s]+)(?:::([^\s=]+))?(?:\s*=\s*(.+?))?\s*-->/g;
const TEST_RE = /<!--\s*@test:\s*([^\s(]+)\s*\(([^)]+)\)\s*-->/g;

// An anchor resolves when its file exists AND the thing it names is present in
// that file. Both halves matter: a path that exists with the symbol renamed
// underneath is the drift these anchors are for, and it is what a lane spends a
// turn per anchor discovering.
// `targets`, when given, restricts resolution to anchors pointing at those
// files. A spec file can carry hundreds of anchors; when the question is "which
// anchors does THIS diff invalidate", resolving the rest is work nobody asked
// for and budget the answer needs.
function resolveAnchors(repo, files, targets = null) {
  const rows = [];
  for (const file of files.slice(0, MAX_LIST)) {
    const body = read(repo, file);
    if (body === null) continue;
    for (const [, target, symbol, value] of body.matchAll(IMPL_RE)) {
      if (targets && !targets.has(target)) continue;
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
      if (targets && !targets.has(target)) continue;
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
// A doc naming a script or rule by basename -- `run-review-lane`, not
// `.../run-review-lane.sh` -- reached the symbol branch and failed there,
// because the path branch only fires on a candidate carrying a `/` or a `.`.
// Seventeen of forty unresolved rows on the measured range were files that
// exist.
//
// Every way a tracked file can honestly be named in prose: its full path, any
// tail of it starting at a path boundary (`common/coding-style.md` for a rule
// nested three directories down), its basename, its basename without the
// extension, and the directories along the way.
//
// EXISTENCE, not uniqueness. The row records whether the name still names
// something, never which file it named -- and staleness is the question being
// asked. Demanding a unique match reported `security.md` as a stale reference
// because the tree has three of them, which is the false finding this resolver
// exists to avoid, in the direction that wastes a reviewer's turn.
function trackedNames(tracked) {
  const names = new Set();
  // Both spellings are added as each form is produced. De-slashing by walking
  // the accumulated set instead made this quadratic in tree size -- a full copy
  // of tens of thousands of entries per directory segment of every file, in the
  // function whose entire purpose is to stop being slow.
  const add = (form) => {
    if (!form) return;
    names.add(form);
    if (form.endsWith('/')) names.add(form.slice(0, -1));
  };
  const suffixes = (path) => {
    add(path);
    for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
      add(path.slice(i + 1));
    }
  };
  for (const path of tracked) {
    suffixes(path);
    const base = path.slice(path.lastIndexOf('/') + 1);
    names.add(base.replace(/\.[^.]+$/, ''));
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      // A skill or plugin directory is named `ci-monitoring` in prose far more
      // often than `ci-monitoring/`, so both reach the set through `add`.
      suffixes(`${parts.slice(0, depth).join('/')}/`);
    }
  }
  return names;
}

// A command, an event, a tool and a wire-format field are all declared by being
// written as a string, not by a keyword: `registerCommand("ctx")`, `pi.on(
// "session_shutdown")`, `"customer.subscription.deleted"`. The keyword shapes
// cannot see any of them, so every such reference was reported as a stale doc.
// Bounded to strings shaped like a reference, so this indexes identifiers and
// not English sentences that happen to be quoted.
const LITERAL_SHAPE = /^[A-Za-z0-9_@][\w./@-]{1,120}$/;

function quotedLiterals(repo, paths) {
  const names = new Set();
  let degraded = false;
  for (let i = 0; i < paths.length; i += 400) {
    const { out, failed } = gitStatus(repo, ['grep', '-hoE', '-a', '--',
      '["\x27][A-Za-z0-9_@][A-Za-z0-9_@./-]{1,120}["\x27]', ...paths.slice(i, i + 400)]);
    if (failed) { degraded = true; continue; }
    for (const hit of out.split('\n')) {
      const value = hit.slice(1, -1);
      if (value && LITERAL_SHAPE.test(value)) names.add(value);
    }
  }
  return { names, degraded };
}

// A dependency is declared by the manifest, not by a declaration in this tree.
// Every `@scope/pkg` in the docs resolved nowhere without this.
//
// npm is parsed exactly because it is JSON and the field names are fixed. Every
// other ecosystem is read generically: a per-format parser for Cargo, pip,
// poetry, Go, Bundler, Composer, Gradle, Mix and SwiftPM is a package manager,
// and this only has to answer "is this name declared here". In all of them a
// dependency is either quoted or the first token on its line, which is what the
// generic pass takes -- so a Rust repo's `serde` and a Python repo's `httpx`
// resolve without this module learning nine file formats.
const DEP_MANIFEST = /(^|\/)(Cargo\.toml|pyproject\.toml|requirements[^/]*\.txt|Pipfile|go\.mod|Gemfile|composer\.json|build\.gradle(\.kts)?|mix\.exs|Package\.swift)$/;
//
// A documented name is also resolvable as a dependency. How that is read is
// stated at the loop below, not here: outside `package.json` the manifest is
// no longer parsed by its grammar at all.

function declaredDependencies(repo, listing) {
  // package.json is JSON, so its dependency fields are read exactly and stay an
  // exact answer. Nothing below it is.
  const exact = new Set();
  const tokens = new Set();
  const tracked = listing.filter(live);

  for (const path of tracked.filter((entry) => /(^|\/)package\.json$/.test(entry))) {
    let manifest;
    try {
      manifest = JSON.parse(read(repo, path) ?? '{}');
    } catch {
      continue;
    }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(manifest?.[field] ?? {})) exact.add(name);
    }
    if (typeof manifest?.name === 'string') exact.add(manifest.name);
  }

  // Every other manifest was parsed by its grammar, and the grammar was wrong
  // seven times running -- always in the same direction. `[tool.setuptools.
  // packages.find]` admitted `where`; `requires-python` and `independent`
  // matched the key test; `[dependencies.serde]` offered `version` as a crate;
  // a continuation line carrying `uvicorn[standard]` closed the array early.
  // Every one was a FALSE CLEAN, which the header of this module says it must
  // never produce, and every one was found only after shipping. Each fix was
  // correct and each exposed the next, because a heuristic over ten ecosystems'
  // file formats has no state in which it is finished.
  //
  // So the grammar is gone rather than corrected an eighth time. Every token in
  // a dependency manifest is offered as the WEAKEST resolution this module has,
  // alongside the string-literal class. That is exactly what a heuristic ever
  // honestly established -- the name appears in a file that declares
  // dependencies -- and saying so is what stops it being a false clean: the
  // lane is told the evidence, instead of being told it is a declared package.
  for (const path of tracked.filter((entry) => DEP_MANIFEST.test(entry))) {
    for (const token of (read(repo, path) ?? '').match(/[A-Za-z0-9_@][\w./@-]{1,120}/g) ?? []) {
      if (LITERAL_SHAPE.test(token)) tokens.add(token);
      // A dot or slash is legal inside a package name, so it has to stay in the
      // token -- but it is also what separates a table from the package it
      // names. `[dependencies.serde]` matches as ONE token, and without the
      // segments `serde` never enters the set at all.
      for (const segment of token.split(/[./]/)) {
        if (LITERAL_SHAPE.test(segment)) tokens.add(segment);
      }
    }
  }
  return { exact, tokens };
}

function resolveDocReferences(repo, files) {
  const rows = [];
  const seen = new Set();
  const passesBefore = gitCalls;
  // One listing, four consumers. It was shelled out three times, and the
  // referent set was built from the unfiltered form, so a generated artifact
  // resolved a documented name by its basename.
  const listing = git(repo, ['ls-files']).split('\n').filter(Boolean);
  const codePaths = listing.filter(live).filter((path) => CODE_PATH.test(path));
  const declarations = declarationIndex(repo, codePaths);
  const quoted = quotedLiterals(repo, codePaths);
  const declared = declarations.index;
  const literals = quoted.names;
  const names = trackedNames(listing.filter(live));
  const dependencies = declaredDependencies(repo, listing);
  // A dropped chunk is a partial scan, and the lane is told a non-truncated
  // list is a complete pass -- so it has to arrive marked.
  let capped = declarations.degraded || quoted.degraded;
  const done = () => ({ rows, capped, passes: gitCalls - passesBefore });
  for (const file of files.slice(0, MAX_LIST)) {
    const body = read(repo, file);
    if (body === null) continue;
    for (const [, span] of body.matchAll(/`([^`\n]{2,120})`/g)) {
      const candidate = span.trim();
      // Only things that claim to be a path or an identifier are checkable; a
      // backticked English phrase is not a broken reference. Beyond that, a
      // flag documents an interface, a bare extension is a file type, and
      // `@impl`/`@test`/`@manual` are this project's anchor vocabulary -- none
      // of them is a name that resolves to code, and asking them to made every
      // documented option, suffix and anchor keyword a stale-doc finding.
      if (!/^[\w./@-]+$/.test(candidate) || seen.has(candidate)) continue;
      if (candidate.startsWith('--') || /^\.[A-Za-z0-9]+$/.test(candidate)
        || /^@(impl|test|manual)$/.test(candidate)) continue;
      // A reference this check can answer has to be able to name something in
      // THIS repository. An absolute system path, a registry host, a template
      // placeholder and a SHOUTING configuration name are all documenting
      // something outside the tree, so asking whether the tree declares them
      // reports a stale document for prose that was never a reference. A single
      // leading slash is left alone: that is a command name, not a path.
      if (/^\/.*\//.test(candidate) || /^[a-z0-9-]+\.[a-z]{2,}\//.test(candidate)) continue;
      if (/^[A-Z][A-Z0-9_]*$/.test(candidate) || /(^|[^A-Za-z])(NNN|XXX)([^A-Za-z]|$)/.test(candidate)) continue;
      seen.add(candidate);
      // Its own ceiling, not the failure budget's. At 160 it stopped collecting
      // without recording anything, so `summarise` could never see a list long
      // enough to mark truncated -- a capped scan reached the lane as a
      // complete one, which is the false clean the summary contract promises
      // never to produce. Sharing MAX_UNRESOLVED then counted RESOLVED rows
      // against a failure budget, so a doc set resolving cleanly could stop the
      // scan and report truncated with nothing having failed.
      if (rows.length >= MAX_CANDIDATES) { capped = true; return done(); }
      if (candidate.includes('/') || candidate.includes('.')) {
        // Same repo-escape guard as read(): a `../` candidate must not probe
        // outside the tree just because this branch checks a path directly.
        const abs = resolve(repo, candidate);
        if (abs.startsWith(resolve(repo) + sep) && existsSync(abs)) {
          rows.push({ ref: candidate, resolved: true, as: 'path' });
          continue;
        }
      }
      // Named by a path tail, a basename or a directory rather than by a full
      // path. Checked before the symbol branch, because a file referenced this
      // way is a real referent and failing it there is what invented the
      // stale-doc findings.
      // A slash command is documentation of a name registered as a string --
      // `registerCommand("ctx")` -- so it resolves under that name, not under
      // the slash the user types.
      const bare = candidate.startsWith('/') ? candidate.slice(1) : candidate;
      if (names.has(candidate) || names.has(candidate.replace(/\/$/, ''))
        || (bare !== candidate && (names.has(bare) || declared.has(bare) || literals.has(bare)))) {
        rows.push({ ref: candidate, resolved: true, as: 'path' });
        continue;
      }
      if (dependencies.exact.has(candidate)) {
        rows.push({ ref: candidate, resolved: true, as: 'package' });
        continue;
      }
      // A reference must resolve to CODE. Grep finds the documentation file that
      // names it, so counting that as resolution makes every reference
      // self-confirming and the whole pass vacuous -- a deleted symbol still
      // written about would read as live.
      if (declared.has(candidate)) {
        rows.push({ ref: candidate, resolved: true, as: 'symbol' });
        continue;
      }
      // A name registered as a string is real but weaker evidence than a
      // declaration: it can also be an unrelated key that happens to match. It
      // is labelled so the lane can weigh it rather than being told the two are
      // the same kind of answer.
      if (literals.has(candidate)) {
        rows.push({ ref: candidate, resolved: true, as: 'literal' });
        continue;
      }
      // Weaker still, and last: the name appears somewhere in a file that
      // declares dependencies. Checked after every stronger form so a real
      // declaration is never demoted to this class by a coincidental token.
      if (dependencies.tokens.has(candidate)) {
        rows.push({ ref: candidate, resolved: true, as: 'manifest' });
        continue;
      }
      rows.push({ ref: candidate, resolved: false, as: 'symbol' });
    }
  }
  return done();
}

// Only a path that can hold code answers "does this resolve to code?". A token
// appearing in a YAML comment or a lockfile is not an implementation.
// Every language a bootstrapped repo might be written in. Narrow this and a
// repo in the missing language indexes no declarations at all, so every
// symbol its documentation names reads as stale -- the whole check inverts
// into noise on a tree that is perfectly consistent.
const CODE_PATH = /\.(ts|tsx|js|jsx|mjs|cjs|sh|bash|py|go|rs|java|kt|kts|scala|swift|cs|c|h|cc|cpp|hpp|rb|php|pl|pm|lua|ex|exs|dart|zig|vue|svelte|sql)$/;

// A symbol has to be DECLARED somewhere to count. Matching any occurrence made
// every short or common token resolve, which is a false clean in a check whose
// whole job is spotting the reference that no longer resolves.
const ereEscape = (value) => value.replace(/[.[\]{}()*+?^$|\\/-]/g, '\\$&');

// One pass over the tree, not one per candidate. The per-candidate form ran a
// full-tree `git grep` for every backticked token in the changed docs -- 149 of
// them on a routine three-file range, measured at 283s, which is 99.94% of this
// lane's whole runtime and past the 60s bound the packet CLI wraps this in. A
// miss costs MORE than a hit there, because `grep -l` cannot stop early when
// nothing matches, and prose references miss by design. Same three declaration
// shapes, same `live` and CODE_PATH filters, same verdicts -- the only change is
// that the tree is read once and the answers are looked up.
// `last` vs `first` is load-bearing, not style: `-o` prints the whole matched
// span, so the keyword shape yields `function foo` and the definition shape
// yields `foo(a, b) {`. Taking the last identifier from both would index the
// final PARAMETER as a declaration -- resolving references that do not exist,
// which is the false-clean direction this module promises never to fail in.
const DECL_SHAPES = [
  // Keyword form (`function foo`, `const foo`, `export foo`).
  { shape: '(function|const|let|var|class|export|def|defp|defmodule|func|fn|sub|type|typedef|interface|struct|enum|trait|impl|mod|module|namespace|package|record|protocol|extension|object|val|local|proc)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*', pick: 'last' },
  // Definition shape (`foo() {` for a shell function or a class method).
  { shape: '(^|[[:space:]])[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\\([^)]*\\)[[:space:]]*[{:]', pick: 'first' },
  // Binding shape (`foo:` / `foo =` for an object member or a re-export).
  { shape: '(^|[[:space:]])[A-Za-z_][A-Za-z0-9_]*[[:space:]]*[:=][^=>]', pick: 'first' },
  // Property shape (`packet.evidenceOmitted =`). A field assigned through its
  // object is declared by that assignment and nothing else; without this, a
  // field this very module writes read as a stale reference.
  { shape: '\\.[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[^=>]', pick: 'first' },
];

// `-h` drops the filename, so the generated-tree filter cannot run on the
// RESULTS the way the per-candidate form did. Names are read off `ls-files` and
// intersected instead: same exclusion, applied to the file list rather than to
// grep output, so a missing lockfile still cannot make every reference read as
// unresolved.
// The definition shape matches any `name(...) {`, which includes `if (x) {`,
// `for (...) {`, `catch (e) {` and the `function` keyword itself. Indexing
// those declares a reference resolvable by a control keyword, which is the
// false-clean direction.
// Extended past the JS keywords for the same reason CODE_PATH is: `match x {`
// is Rust, `unless cond {` is Ruby, `foreach (...) {` is PHP. Each one indexes a
// control keyword as a declared name, which resolves a reference that does not
// exist.
const NOT_A_DECLARATION = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do',
  'until', 'case', 'elif', 'with', 'try', 'async', 'await', 'new', 'typeof',
  'match', 'loop', 'unless', 'elsif', 'foreach', 'when', 'select', 'defer', 'go',
  'using', 'synchronized', 'lock', 'fixed', 'rescue', 'ensure', 'begin', 'end',
  'then', 'fi', 'esac',
]);

function declarationIndex(repo, paths) {
  const index = new Set();
  let degraded = false;
  if (!paths.length) return { index, degraded };
  for (const { shape, pick } of DECL_SHAPES) {
    // Chunked: a pathspec list of every code file in a large repo can exceed the
    // argument limit. A chunk that fails anyway contributes no declarations,
    // which reads as "nothing here is declared" and turns every symbol in it
    // into a stale-doc finding -- so a failure is reported as a partial scan
    // rather than absorbed as an empty one.
    for (let i = 0; i < paths.length; i += 400) {
      const { out, failed } = gitStatus(repo, ['grep', '-hoE', '-a', '--', shape, ...paths.slice(i, i + 400)]);
      if (failed) { degraded = true; continue; }
      for (const hit of out.split('\n')) {
        if (!hit) continue;
        const words = hit.trim().split(/[^A-Za-z0-9_]+/).filter(Boolean);
        const name = pick === 'last' ? words[words.length - 1] : words[0];
        if (name && !NOT_A_DECLARATION.has(name)) index.add(name);
      }
    }
  }
  return { index, degraded };
}

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
  // Anything derived from the DIFF is unknown without a range, not clean. With
  // no range `changedFiles` is empty, so every such check summarised to
  // `{checked: 0, unresolved: []}` -- which reads as a pass that was performed.
  // A full-PR review and an `all` scope both arrive without a range, so this was
  // the module's own forbidden direction: unresolved reported as resolved.
  const fromDiff = (value) => (range ? value : null);
  // The recorded dispositions a rule defers to. Handed to EVERY lane: one
  // runtime gets them for some lanes in a triage block the other runtime does
  // not have, and a lane that cannot see a disposition enforces a rule the
  // project already settled. Excluding a lane here recreated exactly that.
  const specRoot = existsSync(join(repo, 'sdd/spec')) ? 'sdd/spec' : 'sdd';
  out.config = read(repo, `${specRoot}/config.yml`);

  if (lane === 'spec-reviewer') {
    // The five manifest rows this lane was still computing itself. Each is a
    // tree walk or a graph traversal -- no model required, and every one of them
    // was costing a turn that re-sends the whole prompt.
    const specGlob = existsSync(join(repo, 'sdd/spec')) ? 'sdd/spec' : 'sdd';
    const specFiles = git(repo, ['ls-files', '--', `${specGlob}/*.md`]).split('\n').filter(Boolean);
    const indexPath = existsSync(join(repo, `${specGlob}/README.md`)) ? `${specGlob}/README.md` : 'sdd/README.md';
    out.indexIntegrity = indexIntegrity(repo, indexPath, specFiles);
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
    const today = dates.length > 1
      ? changelog.slice(dates[0].index, dates[1].index)
      : changelog.slice(0, 8000);
    // Bounded by ENTRY COUNT, not just by date. A busy day reached 35 entries and
    // 39 KB -- 72% of this lane's whole block and still growing, which would have
    // pushed it past the cap and shed the resolutions that remove the turns.
    // Drift detection asks whether THIS diff's REQs got an entry, so the recent
    // ones answer it and the rest are history the lane can read if it needs to.
    const entries = today.split(/\n(?=- \*\*)/);
    out.changelog = entries.length > MAX_CHANGELOG_ENTRIES + 1
      ? `${entries.slice(0, MAX_CHANGELOG_ENTRIES + 1).join('\n')}\n\n...${entries.length - 1 - MAX_CHANGELOG_ENTRIES} older entries in this section omitted; read the file if an older one matters.`
      : today || null;
    out.specIndex = (read(repo, 'sdd/README.md') ?? '')
      .split('\n').filter((line) => /^#{1,3}\s|^\s*[-*]\s*\[/.test(line)).join('\n') || null;
    out.pending = read(repo, 'sdd/spec/pending.md') ?? read(repo, 'sdd/pending.md');
    const changedSpecFiles = files.filter((f) => f.startsWith('sdd/'));
    out.anchors = fromDiff(summarise(
      resolveAnchors(repo, changedSpecFiles),
      changedSpecFiles.length > MAX_LIST,
    ));
    // Anchors ELSEWHERE in the spec tree that cite a file this diff changed --
    // the same gap the doc lane had, and the same fix. Anchors found INSIDE a
    // changed spec file are empty on any range carrying no REQ file, and the
    // lane is correctly told a zero count means unknown rather than clean, so it
    // resolved every one of them by hand: twelve anchors, twelve turns, on a
    // range whose only spec-owned file was the changelog. Resolution is bounded
    // to anchors pointing AT the changed files, not to every anchor in whatever
    // large REQ document happens to contain one.
    // Bounded like every sibling scan: one `git grep` per changed file, so an
    // uncapped fan-out spends hundreds of subprocesses inside the resolver's own
    // time bound on a large PR. The same bounded list is the resolution target,
    // so the grep and the filter can never disagree about what was covered.
    const allChangedSource = files.filter((f) => !f.startsWith('sdd/'));
    const changedSource = allChangedSource.slice(0, MAX_LIST);
    if (changedSource.length) {
      const citing = [...new Set(changedSource.flatMap((file) => git(repo, [
        // A trailing boundary, without which a changed `src/a.js` also selects
        // files anchoring `src/a.jsx`. The `targets` filter keeps resolution
        // correct either way, but an inflated candidate list can trip the
        // truncation flag and send the lane back to finish a scan that was
        // already complete.
        //
        // `-->` is spelled out rather than folded into the class: `-` has to
        // stay excluded or `src/a` would match `src/a-b.js`, which drops the
        // space-less `<!-- @impl: path--> ` form the anchor regex accepts. That
        // is a MISSED anchor, the direction this whole field exists to avoid.
        // This is deliberately not the boundary the prose citation scan uses --
        // that one also admits a sentence-final period, which no anchor has.
        'grep', '-lE', '-a', '--',
        `<!--\\s*@(impl|test):\\s*${ereEscape(file)}([^A-Za-z0-9_.-]|-->|$)`, 'sdd',
      ]).split('\n').filter(Boolean)))];
      out.anchorsCitingChangedResolved = fromDiff(summarise(
        resolveAnchors(repo, citing, new Set(changedSource)),
        allChangedSource.length > MAX_LIST || citing.length > MAX_LIST,
      ));
    }
  } else if (lane === 'doc-updater') {
    // The classifier spawns this lane when a documentation @impl cites a file in
    // the diff, so that citation IS its work set when no doc file was touched.
    // Handing it only the touched-doc anchors reported checked:0 and confirmed a
    // conclusion the spawn reason contradicts.
    // Generated trees are excluded here for the same reason they are everywhere
    // else in this module: regenerating an artifact cannot make a page stale, so
    // its diff is never the evidence -- and one of them ate a quarter of the
    // patch budget that the hand-written files needed.
    const source = files
      .filter((f) => !f.startsWith('sdd/') && !f.startsWith('documentation/'))
      .filter(live);
    let budget = MAX_CITED_PATCH_TOTAL;
    out.docsCitingChanged = source.slice(0, MAX_LIST)
      .map((file) => ({ file, citedBy: citedBy(repo, file) }))
      .filter((row) => row.citedBy.length > 0)
      .map((row) => {
        const got = budget > 0 ? filePatch(repo, range, row.file) : null;
        if (got === null) return { ...row, patchOmitted: true };
        budget -= got.patch.length;
        return got.truncated
          ? { ...row, patch: got.patch, patchTruncated: true }
          : { ...row, patch: got.patch };
      });
    // An empty citation list means "nothing changed cites a page" -- a claim
    // this cannot make without a diff to read.
    out.docsCitingChanged = fromDiff(out.docsCitingChanged);
    const nested = existsSync(join(repo, 'documentation/lanes'));
    const index = read(repo, 'documentation/README.md');
    out.docLayout = nested ? 'nested' : 'flat';
    out.docIndexPresent = index !== null;
    // The same join the spec lane is handed. Without it this lane was given the
    // index verbatim and walked the tree itself to pair the two -- raw material
    // where the other lane gets the answer.
    out.indexIntegrity = indexIntegrity(
      repo,
      'documentation/README.md',
      git(repo, ['ls-files', '--', 'documentation']).split('\n').filter((f) => f.endsWith('.md')),
    );
    // The index routes; its prose principles do not. Headings and links only.
    out.docIndex = (index ?? '')
      .split('\n').filter((line) => /^#{1,3}\s|^\s*[-*|]\s*.*\[/.test(line)).join('\n') || null;
    const docFiles = files.filter((f) => f.startsWith('documentation/') || /^[A-Z]+\.md$/.test(f));
    out.anchors = fromDiff(summarise(resolveAnchors(repo, docFiles), docFiles.length > MAX_LIST));
    const references = resolveDocReferences(repo, docFiles);
    out.references = fromDiff(summarise(
      references.rows, references.capped || docFiles.length > MAX_LIST, references.passes,
    ));
  } else if (lane === 'code-reviewer') {
    const source = files.filter((f) => !f.startsWith('sdd/') && !f.startsWith('documentation/'));
    out.callSites = fromDiff(callSites(repo, source, range));
    // An anchor anywhere in the spec or doc trees that cites a file this diff
    // touched is the orphan check the code lane runs on a rename.
    out.anchorsCitingChanged = source.slice(0, MAX_LIST).map((file) => ({
      file,
      citedBy: git(repo, ['grep', '-l', '--fixed-strings', '-a', '--', `@impl: ${file}`])
        .split('\n').filter(Boolean).filter(live).slice(0, 12),
    })).filter((row) => row.citedBy.length > 0);
    out.anchorsCitingChanged = fromDiff(out.anchorsCitingChanged);
  }
  return out;
}

// Over the cap, shed by FIELD and never by block: dropping everything sends the
// lane back to gathering all of it, which is the cost this exists to remove.
// Bulk first, resolutions last, and every drop leaves a named marker so an
// absent field is never mistaken for a clean answer.
function bound(out) {
  // Measured on the form that is EMITTED. Measuring the compact form let a
  // block pass the check and then go out over the cap, which is the one thing
  // the shed exists to prevent.
  const size = () => JSON.stringify(out, null, 1).length;
  if (size() <= MAX_TOTAL) return out;
  for (const field of ['changelog', 'docIndex', 'specIndex', 'pending', 'queue', 'config']) {
    if (out[field] === undefined || out[field] === null) continue;
    delete out[field];
    out.omitted = [...(out.omitted ?? []), field];
    if (size() <= MAX_TOTAL) return out;
  }
  if (Array.isArray(out.docsCitingChanged)) {
    out.docsCitingChanged = out.docsCitingChanged.map(({ patch, ...row }) => (
      patch === undefined ? row : { ...row, patchOmitted: true }
    ));
    if (size() <= MAX_TOTAL) return out;
  }
  if (Array.isArray(out.adrs)) {
    out.adrs = out.adrs.filter((entry) => !String(entry).endsWith('|Superseded'));
    out.omitted = [...(out.omitted ?? []), 'adrs:superseded'];
  }
  return out;
}

try {
  process.stdout.write(`${JSON.stringify(bound(main()), null, 1)}\n`);
} catch (error) {
  // An evidence failure must never look like a clean result: emit the error and
  // no fields, so every check falls back to the lane gathering it itself.
  process.stdout.write(`${JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
}
