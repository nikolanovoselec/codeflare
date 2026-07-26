// Behavioural tests for the review-lane evidence resolver.
//
// The contract under test is narrow and load-bearing: every answer this emits
// is one a lane would otherwise spend a turn obtaining, and a turn re-sends the
// whole prompt. So the tests assert resolution OUTCOMES against real files in
// real git repos -- an anchor that points at a renamed symbol must come back
// unresolved, a reference that resolves must not be reported as a failure --
// rather than that some JSON was produced.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(
  __dirname,
  '../../preseed/agents/claude/skills/review-scope/scripts/lane-evidence.mjs',
);

function git(cwd, ...args) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8' }).stdout.trim();
}

function write(cwd, relative, body) {
  mkdirSync(dirname(join(cwd, relative)), { recursive: true });
  writeFileSync(join(cwd, relative), body);
}

function makeRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'lane-evidence-'));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@test');
  git(cwd, 'config', 'user.name', 'Test');
  write(cwd, 'README.md', '# fixture\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  return { cwd, base: git(cwd, 'rev-parse', 'HEAD') };
}

function commit(cwd, message) {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

function run(cwd, lane, range) {
  const r = spawnSync('node', [SCRIPT, '--repo', cwd, '--lane', lane, ...(range ? ['--range', range] : [])], {
    cwd,
    encoding: 'utf-8',
  });
  return JSON.parse(r.stdout);
}

describe('lane-evidence.mjs — anchor resolution', () => {
  // The whole point of a `::symbol` anchor is that the path existing is not
  // enough. A lane discovers that one turn at a time; this is the same answer,
  // handed over.
  it('reports an anchor whose symbol no longer exists as unresolved', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'src/thing.js', 'function stillHere() {}\n');
    write(cwd, 'sdd/spec/agents.md', [
      '1. Present. <!-- @impl: src/thing.js::stillHere -->',
      '2. Renamed away. <!-- @impl: src/thing.js::wasRenamed -->',
      '3. File gone. <!-- @impl: src/deleted.js::anything -->',
    ].join('\n'));
    const head = commit(cwd, 'feat: anchors');

    const out = run(cwd, 'spec-reviewer', `${base}..${head}`);

    assert.equal(out.anchors.checked, 3);
    const broken = out.anchors.unresolved.map((row) => row.symbol).sort();
    assert.deepEqual(broken, ['anything', 'wasRenamed'],
      'a present path with a renamed symbol is exactly the drift these anchors exist for');
  });

  // Resolved rows are a count, not a list: emitting them in full is what made
  // this block 156 KB on a tree with 683 anchors, carried on every single turn.
  it('summarises the passes and enumerates only the failures', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'src/thing.js', 'function a() {}\nfunction b() {}\n');
    write(cwd, 'sdd/spec/agents.md', [
      '1. <!-- @impl: src/thing.js::a -->',
      '2. <!-- @impl: src/thing.js::b -->',
    ].join('\n'));
    const head = commit(cwd, 'feat: all resolve');

    const out = run(cwd, 'spec-reviewer', `${base}..${head}`);

    assert.equal(out.anchors.checked, 2);
    assert.deepEqual(out.anchors.unresolved, [],
      'a clean pass is a count; the lane may report it without re-running it');
  });

  // The anchors that decide a source-only range live in spec files the range
  // never touched, so `anchors` is legitimately 0 and the lane -- correctly told
  // a zero is unknown rather than clean -- resolved all of them by hand. Twelve
  // anchors, twelve turns, on a range whose only spec file was the changelog.
  it('resolves the anchors that cite a changed file when no spec file changed', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'src/thing.js', 'function stillHere() {}\n');
    write(cwd, 'src/other.js', 'function elsewhere() {}\n');
    write(cwd, 'sdd/spec/agents.md', [
      '1. Cites the changed file. <!-- @impl: src/thing.js::stillHere -->',
      '2. Cites it and is stale. <!-- @impl: src/thing.js::renamedAway -->',
      '3. Cites an untouched file. <!-- @impl: src/other.js::elsewhere -->',
    ].join('\n'));
    // Range from AFTER the spec file landed, so the diff under review carries
    // source only -- the shape that produced the twelve turns.
    const anchored = commit(cwd, 'feat: anchored');
    write(cwd, 'src/thing.js', 'function stillHere() {}\n// touched\n');
    const head = commit(cwd, 'fix: source only, no spec file in range');

    const out = run(cwd, 'spec-reviewer', `${anchored}..${head}`);

    assert.equal(out.anchors.checked, 0,
      'no spec file is in this range, so the in-file pass has nothing to check');
    assert.equal(out.anchorsCitingChangedResolved.checked, 2,
      'both anchors citing the changed file are resolved; the one citing an untouched file is not work this diff owes');
    assert.deepEqual(out.anchorsCitingChangedResolved.unresolved.map((row) => row.symbol), ['renamedAway'],
      'a path that still exists with the symbol gone is the drift this pass exists for');
  });

  // The anchor regex accepts `<!-- @impl: path--> ` with no separating space,
  // so a citation scan that cannot match it drops a real anchor -- a MISSED
  // orphan, which is the direction this whole field exists to avoid.
  // The path must be the WHOLE anchor target for this to bite: with a `::symbol`
  // the path is followed by `:`, which the boundary class already admits, so
  // that fixture passes with or without the terminator branch. Both forms are
  // asserted so each branch of the boundary has an oracle.
  it('finds an anchor written without a space before its comment terminator', () => {
    const { cwd } = makeRepo();
    write(cwd, 'src/thing.js', 'function stillHere() {}\n');
    // Separate files on purpose. Candidate selection is per FILE, so a document
    // holding both forms is selected by the `::symbol` anchor alone and then
    // resolves the symbol-less one for free -- green with the fix reverted.
    write(cwd, 'sdd/spec/agents.md', '1. Spaceless, no symbol. <!-- @impl: src/thing.js-->\n');
    write(cwd, 'sdd/spec/other.md', '2. Spaceless, with symbol. <!-- @impl: src/thing.js::stillHere-->\n');
    const anchored = commit(cwd, 'feat: anchored without a space');
    write(cwd, 'src/thing.js', 'function stillHere() {}\n// touched\n');
    const head = commit(cwd, 'fix: source only');

    const out = run(cwd, 'spec-reviewer', `${anchored}..${head}`);

    assert.equal(out.anchorsCitingChangedResolved.checked, 2,
      'both anchor forms must be found; the symbol-less one is the terminator branch');
  });

  // A prefix match resolves to the same counts, because the target filter
  // discards it -- so the observable cost is the candidate list inflating past
  // the cap and reporting itself truncated, which sends the lane back to finish
  // a scan that had in fact covered everything.
  it('does not let sibling-prefix paths inflate the scan into a false truncation', () => {
    const { cwd } = makeRepo();
    write(cwd, 'src/a.js', 'function real() {}\n');
    write(cwd, 'src/a.jsx', 'function sibling() {}\n');
    for (let i = 0; i < 41; i += 1) {
      write(cwd, `sdd/spec/page${i}.md`, `${i}. <!-- @impl: src/a.jsx::sibling -->\n`);
    }
    const anchored = commit(cwd, 'feat: many pages anchoring the sibling');
    write(cwd, 'src/a.js', 'function real() {}\n// touched\n');
    const head = commit(cwd, 'fix: change only the shorter path');

    const out = run(cwd, 'spec-reviewer', `${anchored}..${head}`);

    assert.equal(out.anchorsCitingChangedResolved.checked, 0,
      'nothing anchors the changed file, so there is nothing to resolve');
    assert.equal(out.anchorsCitingChangedResolved.truncated, undefined,
      '41 sibling-prefix pages must not be collected as candidates and reported as a capped scan');
  });
});

describe('lane-evidence.mjs — documentation references', () => {
  it('separates a reference that resolves from one that does not', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'src/real.ts', 'export const realSymbol = 1;\n');
    write(cwd, 'documentation/architecture.md',
      'Handled by `src/real.ts`, using `realSymbol`, formerly `deletedSymbol`.\n');
    const head = commit(cwd, 'docs: page');

    const out = run(cwd, 'doc-updater', `${base}..${head}`);

    const unresolved = out.references.unresolved.map((row) => row.ref);
    assert.ok(out.references.checked >= 3, 'every checkable reference must be answered');
    assert.deepEqual(unresolved, ['deletedSymbol'],
      'a reference resolving nowhere is the stale doc; the other two exist and must not be reported');
  });

  // The lane is told an empty `unresolved` over a non-zero `checked` is a clean
  // pass it may report without re-running. That makes a false clean the one
  // failure worse than an extra turn, so a mere mention must not count.
  it('does not count a mention in prose or config as a resolved reference', () => {
    const { cwd, base } = makeRepo();
    write(cwd, '.github/workflows/ci.yml', '# note: ghostSymbol was removed here\n');
    write(cwd, 'src/real.ts', 'export function liveSymbol() {}\n');
    write(cwd, 'documentation/architecture.md', 'Uses `liveSymbol`, formerly `ghostSymbol`.\n');
    const head = commit(cwd, 'docs: page');

    const out = run(cwd, 'doc-updater', `${base}..${head}`);
    const unresolved = out.references.unresolved.map((row) => row.ref);

    assert.ok(unresolved.includes('ghostSymbol'),
      'a symbol that survives only as a YAML comment does not resolve to code');
    assert.ok(!unresolved.includes('liveSymbol'),
      'and a symbol that is genuinely declared must not be reported as stale');
  });

  it('answers the scaffolding gate and the layout without a probe', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'documentation/README.md', '# Index\n\n- [Architecture](architecture.md)\n');
    write(cwd, 'documentation/architecture.md', '# Arch\n');
    const head = commit(cwd, 'docs: index');

    const out = run(cwd, 'doc-updater', `${base}..${head}`);

    assert.equal(out.docIndexPresent, true);
    assert.equal(out.docLayout, 'flat', 'no documentation/lanes/ directory means the flat layout');
    assert.match(out.docIndex, /\[Architecture\]/, 'the routing links are what the index is for');
  });
});

describe('lane-evidence.mjs — the code lane branch', () => {
  // This branch shipped untested and immediately produced the defect it was
  // meant to prevent: it harvested `r`, `x`, `and`, `git` as symbols and greped
  // the repository for each, padding every prompt with unrelated matches.
  it('reports call sites for a changed top-level symbol and ignores noise', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'src/caller.ts', 'import { renamedHelper } from "./lib";\nrenamedHelper();\n');
    write(cwd, 'src/lib.ts', 'export function renamedHelper() {\n  const x = 1;\n  const and = 2;\n  return x + and;\n}\n');
    const head = commit(cwd, 'feat: helper');

    const out = run(cwd, 'code-reviewer', `${base}..${head}`);
    const symbols = out.callSites.map((row) => row.symbol);

    assert.ok(symbols.includes('renamedHelper'),
      'a changed top-level symbol is exactly the caller-impact signal the lane is handed');
    assert.deepEqual(symbols.filter((sym) => ['x', 'and'].includes(sym)), [],
      'locals and common words are not caller signal; greping the repo for them is what padded the prompt');
    const sites = out.callSites.find((row) => row.symbol === 'renamedHelper').sites.join('\n');
    assert.match(sites, /src\/caller\.ts/, 'the actual call site must be present, or the lane searches anyway');
  });

  it('lists the spec files whose anchors cite a changed source file', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'src/target.ts', 'export const a = 1;\n');
    write(cwd, 'sdd/spec/agents.md', '1. Thing. <!-- @impl: src/target.ts::a -->\n');
    commit(cwd, 'feat: anchored');
    write(cwd, 'src/target.ts', 'export const a = 2;\n');
    const head = commit(cwd, 'feat: change the anchored file');

    const out = run(cwd, 'code-reviewer', `${base}..${head}`);

    const cited = out.anchorsCitingChanged.find((row) => row.file === 'src/target.ts');
    assert.ok(cited, 'a changed file that an anchor cites must be surfaced, or the orphan scan is a manual grep again');
    assert.ok(cited.citedBy.includes('sdd/spec/agents.md'));
  });
});

describe('lane-evidence.mjs — caller impact must not fail open', () => {
  // Dropping a row reads to the lane as "no callers", and the lane is told the
  // block is authoritative and not to re-check it. So the widely-used symbols,
  // where caller impact matters most, were exactly the ones silently skipped.
  it('marks a symbol with too many sites instead of omitting it', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'src/lib.ts', 'export function widelyUsedThing() { return 1; }\n');
    for (let i = 0; i < 20; i += 1) {
      write(cwd, `src/c${i}.ts`, 'import { widelyUsedThing } from "./lib";\nwidelyUsedThing();\n');
    }
    const head = commit(cwd, 'feat: many callers');

    const out = run(cwd, 'code-reviewer', `${base}..${head}`);
    const row = out.callSites.find((entry) => entry.symbol === 'widelyUsedThing');

    assert.ok(row, 'an omitted row is indistinguishable from a symbol with no callers');
    assert.equal(row.tooCommon, true, 'the lane must be told to search this one itself');
  });

  // `run`, `sync`, `read` and `path` are real exports. Filtering them by name
  // loses caller impact for the API surface, which is the same fail-open shape.
  it('keeps a short exported name and still drops unexported noise', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'src/api.ts', 'export function run() {}\nexport const sync = 1;\nfunction and() {}\nconst x = 2;\n');
    const head = commit(cwd, 'feat: api');

    const symbols = run(cwd, 'code-reviewer', `${base}..${head}`).callSites.map((row) => row.symbol).sort();

    assert.deepEqual(symbols, ['run', 'sync'],
      'exported names survive whatever they are called; unexported locals are the noise');
  });
});

describe('lane-evidence.mjs — a reference match must be literal', () => {
  // `.` and `-` reach the search pattern, so an unescaped `foo.bar` matched
  // `fooXbar` -- a false clean in the check whose job is finding what no longer
  // resolves -- and an invalid pattern made the search fail, inventing one.
  it('does not let a regex metacharacter match an arbitrary character', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'src/a.ts', 'const fooXbar = 1;\nconst realXname = 2;\n');
    write(cwd, 'documentation/x.md', 'See `foo.bar` and `real-name`.\n');
    const head = commit(cwd, 'docs: dotted refs');

    const unresolved = run(cwd, 'doc-updater', `${base}..${head}`).references.unresolved.map((row) => row.ref).sort();

    assert.deepEqual(unresolved, ['foo.bar', 'real-name'],
      'neither is declared; matching them against fooXbar/realXname is a false clean');
  });

  // `[^=]` after the binding form admitted `=>`, so a callback parameter read
  // as a declaration -- a false clean in the check whose job is the opposite.
  it('does not treat an arrow-function parameter as a declaration', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'src/a.ts', 'items.map(ghostArrow => ghostArrow + 1);\nexport function realOne() {}\n');
    write(cwd, 'documentation/x.md', 'Uses `ghostArrow` and `realOne`.\n');
    const head = commit(cwd, 'docs: arrow param');

    const unresolved = run(cwd, 'doc-updater', `${base}..${head}`).references.unresolved.map((row) => row.ref);

    assert.ok(unresolved.includes('ghostArrow'), 'a parameter is bound, not declared');
    assert.ok(!unresolved.includes('realOne'), 'and a genuine export still resolves');
  });

  it('refuses a reference that would probe outside the repository', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'documentation/y.md', 'See `../../../../etc/passwd`.\n');
    const head = commit(cwd, 'docs: escape');

    const unresolved = run(cwd, 'doc-updater', `${base}..${head}`).references.unresolved.map((row) => row.ref);

    assert.ok(unresolved.includes('../../../../etc/passwd'),
      'a path outside the tree must never resolve; the guard belongs on both branches, not one');
  });
});

describe('lane-evidence.mjs — a declaration is not only a keyword', () => {
  // Keyword-prefixed declarations are one shape among several. A shell function,
  // a class method and an object member declare a symbol without any of them,
  // and this repository is full of the first -- so live references were being
  // reported as stale, which is the same false verdict in the other direction.
  it('resolves shell functions, methods and members, not just keyword forms', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'scripts/lane.sh', 'run_lane() {\n  echo hi\n}\n');
    write(cwd, 'src/a.ts', 'class Thing {\n  methodName() { return 1; }\n}\nconst obj = { memberName: 1 };\n');
    write(cwd, 'documentation/x.md', 'Calls `run_lane`, `methodName`, `memberName`, and the gone `neverDefined`.\n');
    const head = commit(cwd, 'docs: shapes');

    const unresolved = run(cwd, 'doc-updater', `${base}..${head}`).references.unresolved.map((row) => row.ref);

    assert.deepEqual(unresolved, ['neverDefined'],
      'only the symbol that genuinely does not exist may be reported; the other three are declared');
  });
});

describe('lane-evidence.mjs — a lane gets evidence for why it was spawned', () => {
  // The doc lane is pulled in when a documentation @impl cites a changed file,
  // and was then handed only the anchors inside touched doc files. On a range
  // with no doc file at all that read as "nothing to verify", so three rounds
  // returned clean without ever checking the anchors that caused the spawn.
  it('lists the documentation pages whose anchors cite a changed source file', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'src/engine.ts', 'export function drive() { return 1; }\n');
    write(cwd, 'documentation/architecture.md', 'The engine drives. <!-- @impl: src/engine.ts::drive -->\n');
    commit(cwd, 'feat: engine and its page');
    write(cwd, 'src/engine.ts', 'export function drive() { return 2; }\n');
    const head = commit(cwd, 'feat: change what the page describes');

    const out = run(cwd, 'doc-updater', `${base}..${head}`);
    const row = (out.docsCitingChanged ?? []).find((entry) => entry.file === 'src/engine.ts');

    assert.ok(row, 'the page making a claim about the changed file is this lane\'s work set');
    assert.ok(row.citedBy.includes('documentation/architecture.md'));
  });

  it('stays empty when no documentation page cites the change', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'documentation/a.md', '# unrelated\n');
    commit(cwd, 'docs: unrelated page');
    write(cwd, 'src/x.ts', 'export const untouchedByDocs = 1;\n');
    const head = commit(cwd, 'feat: nothing cites this');

    assert.deepEqual(run(cwd, 'doc-updater', `${base}..${head}`).docsCitingChanged, [],
      'a genuine no-op must stay one, or the lane is given work that does not exist');
  });

  // The packet is scoped to the files a lane OWNS. A doc lane spawned by a diff
  // that touched no documentation/ file therefore got files:[] and an empty
  // patch, and spent three of eleven turns re-running `git diff` per cited path
  // to see what the change actually said.
  it('carries the diff of each cited file, not just the citation', () => {
    const { cwd } = makeRepo();
    write(cwd, 'src/engine.ts', 'export function drive() { return 1; }\n');
    write(cwd, 'documentation/architecture.md', 'The engine drives. <!-- @impl: src/engine.ts::drive -->\n');
    // Range from AFTER the file exists: spanning its creation makes the change an
    // addition with no old side, and the old text is half of what proves drift.
    const base = commit(cwd, 'feat: engine and its page');
    write(cwd, 'src/engine.ts', 'export function drive() { return 2; }\n');
    const head = commit(cwd, 'feat: change what the page describes');

    const row = run(cwd, 'doc-updater', `${base}..${head}`)
      .docsCitingChanged.find((entry) => entry.file === 'src/engine.ts');

    assert.match(row.patch, /^\+export function drive\(\) \{ return 2; \}$/m,
      'the new text is what decides whether the page is stale');
    assert.match(row.patch, /^-export function drive\(\) \{ return 1; \}$/m,
      'the old text is what the page was written against');
  });

  // A prose mention is a dependency too, and the lane greps for it by hand when
  // only the anchor form is resolved.
  it('cites a page that names the changed path without an anchor', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'documentation/deployment.md', 'Run `scripts/ship.sh` to deploy.\n');
    commit(cwd, 'docs: deployment page');
    write(cwd, 'scripts/ship.sh', '#!/bin/sh\necho shipped\n');
    const head = commit(cwd, 'feat: the script that page describes');

    const row = run(cwd, 'doc-updater', `${base}..${head}`)
      .docsCitingChanged.find((entry) => entry.file === 'scripts/ship.sh');

    assert.ok(row, 'a page naming the path depends on it whether or not an anchor formalises it');
    assert.deepEqual(row.citedBy, ['documentation/deployment.md']);
  });

  // Bounded twice, because this is the one field that scales with the diff. Over
  // budget the row must say so: a silently absent patch would read as "no change
  // to see" on a lane told the block is authoritative.
  it('marks a row whose patch exceeded the budget rather than dropping it silently', () => {
    const { cwd, base } = makeRepo();
    const pages = [];
    for (let i = 0; i < 8; i += 1) {
      write(cwd, `documentation/page${i}.md`, `Describes src/big${i}.ts\n`);
      pages.push(i);
    }
    commit(cwd, 'docs: pages');
    for (const i of pages) {
      write(cwd, `src/big${i}.ts`, `export const body${i} = '${'x'.repeat(9000)}';\n`);
    }
    const head = commit(cwd, 'feat: eight large files');

    const rows = run(cwd, 'doc-updater', `${base}..${head}`).docsCitingChanged;

    assert.equal(rows.length, 8, 'every citation is still reported');
    assert.ok(rows.some((row) => row.patch), 'the budget spends before it runs out');
    const omitted = rows.filter((row) => row.patchOmitted);
    assert.ok(omitted.length > 0, 'the rows past the budget must be marked, not quietly patchless');
    for (const row of omitted) {
      assert.equal(row.patch, undefined, 'a marked row carries no partial patch to reason from');
    }
  });

  // The lane is told to read the row and gather only where a marker says the
  // evidence is incomplete. A clipped patch carrying no marker means judging a
  // change from its first 6 KB while forbidden to fetch the rest.
  it('marks a clipped patch as clipped', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'documentation/architecture.md', 'Describes src/huge.ts\n');
    commit(cwd, 'docs: page');
    write(cwd, 'src/huge.ts', `export const body = '${'y'.repeat(20000)}';\n`);
    const head = commit(cwd, 'feat: a change larger than one row may carry');

    const row = run(cwd, 'doc-updater', `${base}..${head}`)
      .docsCitingChanged.find((entry) => entry.file === 'src/huge.ts');

    assert.equal(row.patchTruncated, true,
      'incomplete evidence must announce itself or it reads as the whole change');
    assert.ok(row.patch.length < 20000, 'the clip still has to happen');
  });

  // A bare substring made every longer path containing this one a citation, and
  // each spurious row also spends patch budget a genuine citation needs.
  it('does not treat a longer path containing this one as a citation', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'documentation/architecture.md', 'Only mentions src/thing.ts.bak here.\n');
    commit(cwd, 'docs: page naming a different file');
    write(cwd, 'src/thing.ts', 'export const real = 1;\n');
    const head = commit(cwd, 'feat: the file nobody cited');

    assert.deepEqual(run(cwd, 'doc-updater', `${base}..${head}`).docsCitingChanged, [],
      'src/thing.ts.bak is not src/thing.ts');
  });

  // Excluding every trailing dot blocked `src/a.ts.bak`, and blocked a path
  // ending a sentence with it. A lost citation is a false clean in the one check
  // this lane exists for.
  it('cites a page whose sentence ends on the path', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'documentation/architecture.md', 'Prose ends with the path src/engine.ts.\n');
    commit(cwd, 'docs: page');
    write(cwd, 'src/engine.ts', 'export const drive = 1;\n');
    const head = commit(cwd, 'feat: the engine');

    assert.ok(run(cwd, 'doc-updater', `${base}..${head}`)
      .docsCitingChanged.some((row) => row.file === 'src/engine.ts'),
    'a full stop after the path is punctuation, not a longer filename');
  });

  it('still cites a page that names the path with surrounding punctuation', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'documentation/architecture.md', 'Run `scripts/ship.sh` (the deployer).\n');
    commit(cwd, 'docs: page');
    write(cwd, 'scripts/ship.sh', '#!/bin/sh\necho go\n');
    const head = commit(cwd, 'feat: the deployer');

    const row = run(cwd, 'doc-updater', `${base}..${head}`)
      .docsCitingChanged.find((entry) => entry.file === 'scripts/ship.sh');

    assert.ok(row, 'the boundary rule must not lose a real citation to a backtick or a paren');
  });
});

describe('lane-evidence.mjs — the doc index is joined, not just quoted', () => {
  // The spec lane is handed this join and dropped from 10 turns to 5. The doc
  // lane was handed the index verbatim instead and walked documentation/ itself
  // to pair the two -- raw material where the other lane gets the answer.
  it('reports a tracked doc the index does not link, and passes one it does', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'documentation/README.md', '# Docs\n\n- [Architecture](lanes/architecture.md)\n');
    write(cwd, 'documentation/lanes/architecture.md', '# Architecture\n');
    write(cwd, 'documentation/lanes/orphan.md', '# Nobody links me\n');
    const head = commit(cwd, 'docs: an indexed page and an orphan');

    const integrity = run(cwd, 'doc-updater', `${base}..${head}`).indexIntegrity;

    assert.deepEqual(integrity.unindexed, ['documentation/lanes/orphan.md']);
    assert.deepEqual(integrity.dangling, [], 'a link that resolves is not a finding');
  });

  it('reports an index link that points at nothing', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'documentation/README.md', '# Docs\n\n- [Gone](lanes/removed.md)\n');
    const head = commit(cwd, 'docs: index outlived its page');

    assert.deepEqual(run(cwd, 'doc-updater', `${base}..${head}`).indexIntegrity.dangling,
      ['lanes/removed.md']);
  });

  // Basenames made a link to one file mark its same-named sibling indexed too.
  // An unindexed file reported as indexed is a false clean, which is the one
  // direction this module promises never to fail in.
  it('does not let a link to one file cover a same-named file elsewhere', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'documentation/README.md', '# Docs\n\n- [Architecture](lanes/architecture.md)\n');
    write(cwd, 'documentation/lanes/architecture.md', '# Nested\n');
    write(cwd, 'documentation/architecture.md', '# Top level, nobody links me\n');
    const head = commit(cwd, 'docs: same name at two depths');

    assert.deepEqual(run(cwd, 'doc-updater', `${base}..${head}`).indexIntegrity.unindexed,
      ['documentation/architecture.md'],
      'the linked path is lanes/architecture.md, which says nothing about the sibling');
  });
});

describe('lane-evidence.mjs — the spec manifest rows', () => {
  // The spec lane was the only one whose turns never fell, because five of its
  // manifest rows are tree walks it kept performing itself. Each is deterministic.
  it('detects a dependency cycle rather than reporting a clean graph', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'sdd/spec/a.md', [
      '### REQ-A-001: One', '', '**Dependencies:** [REQ-A-002](#req-a-002)', '',
      '### REQ-A-002: Two', '', '**Dependencies:** [REQ-A-001](#req-a-001)', '',
    ].join('\n'));
    const head = commit(cwd, 'spec: a cycle');

    const graph = run(cwd, 'spec-reviewer', `${base}..${head}`).dependencyGraph;

    assert.equal(graph.reqs, 2);
    assert.ok(graph.cycles.length > 0, 'a cycle reported as clean is worse than not checking at all');
  });

  // A substring test on the raw index passed the row whenever the filename
  // merely appeared in prose, or another file's name contained it.
  it('counts a file as indexed only when a link targets it', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'sdd/README.md',
      '# Index\n\n- [Agents](spec/agents.md)\n\nProse mentions notlinked.md by name only.\n');
    write(cwd, 'sdd/spec/agents.md', '# Agents\n');
    write(cwd, 'sdd/spec/notlinked.md', '# Orphan\n');
    const head = commit(cwd, 'spec: one linked, one only mentioned');

    const integrity = run(cwd, 'spec-reviewer', `${base}..${head}`).indexIntegrity;

    assert.deepEqual(integrity.unindexed, ['sdd/spec/notlinked.md'],
      'a name appearing in prose is not an index entry');
  });

  it('resolves index links relative to the index, not the spec glob', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'sdd/README.md', '# Index\n\n- [Agents](spec/agents.md)\n- [Gone](spec/removed.md)\n');
    write(cwd, 'sdd/spec/agents.md', '# Agents\n');
    const head = commit(cwd, 'spec: index');

    const integrity = run(cwd, 'spec-reviewer', `${base}..${head}`).indexIntegrity;

    assert.deepEqual(integrity.dangling, ['spec/removed.md'],
      'resolving against the wrong base reports every real entry as dangling');
    assert.deepEqual(integrity.unindexed, [], 'an indexed file is not unindexed');
  });
});

describe('lane-evidence.mjs — the decision record', () => {
  it('carries each ADR id, title and status so the record check costs no read', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'documentation/decisions/README.md', [
      '### AD001: First decision',
      '',
      '**Status:** Accepted (2026-01-01).',
      '',
      '### AD002: Rejected idea',
      '',
      '**Status:** Superseded by AD001.',
    ].join('\n'));
    const head = commit(cwd, 'docs: adrs');

    const out = run(cwd, 'code-reviewer', `${base}..${head}`);

    assert.deepEqual(out.adrs, [
      'AD001|First decision|Accepted',
      'AD002|Rejected idea|Superseded',
    ], 'status decides whether a finding is already settled, so it must survive the reduction');
  });
});

describe('lane-evidence.mjs — fail-safe direction', () => {
  // This resolves evidence; it never decides a review. Anything it cannot
  // answer must read as "unknown", never as "clean" -- a false clean would let
  // a check be skipped, which is the one failure mode worse than an extra turn.
  it('emits an absent field rather than a clean result when a tree is missing', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'src/thing.ts', 'export const x = 1;\n');
    const head = commit(cwd, 'feat: no docs tree at all');

    const out = run(cwd, 'code-reviewer', `${base}..${head}`);

    assert.equal(out.adrs, null,
      'no decision ledger must read as unknown, so the lane still checks; an empty list would read as "no ADRs apply"');
  });

  it('never throws a range failure into the lane', () => {
    const { cwd } = makeRepo();
    const out = run(cwd, 'spec-reviewer', 'notasha..alsonotasha');
    assert.equal(typeof out, 'object', 'an unresolvable range degrades, it does not crash the lane');
  });
});

describe('build-review-packet.mjs — evidence rides the call that is actually made', () => {
  // A runtime with a lane runner has evidence inlined for it; a runtime without
  // one has to ask, and asking meant a second command beside the packet command.
  // One flag on the call that is already made carries both, so there is no
  // second instruction to follow.
  const PACKET = resolve(
    __dirname,
    '../../preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs',
  );

  function packet(cwd, lane, range, ...extra) {
    const r = spawnSync('node', [PACKET, ...extra, '--repo', cwd, '--scope', 'diff',
      '--range', range, '--lane', lane], { cwd, encoding: 'utf-8' });
    return JSON.parse(r.stdout);
  }

  function fixture() {
    const { cwd, base } = makeRepo();
    write(cwd, 'documentation/architecture.md', 'The engine drives. <!-- @impl: src/engine.ts::drive -->\n');
    write(cwd, 'src/engine.ts', 'export function drive() { return 1; }\n');
    commit(cwd, 'feat: engine and page');
    write(cwd, 'src/engine.ts', 'export function drive() { return 2; }\n');
    const head = commit(cwd, 'feat: change it');
    return { cwd, range: `${git(cwd, 'rev-parse', base)}..${git(cwd, 'rev-parse', head)}` };
  }

  it('attaches the resolved evidence when asked for it', () => {
    const { cwd, range } = fixture();
    const out = packet(cwd, 'doc-updater', range, '--with-evidence');
    assert.ok(out.evidence, 'the runtime without a runner gets its evidence from the call it makes');
    assert.equal(out.evidence.lane, 'doc-updater');
    assert.ok(out.evidence.docsCitingChanged.some((row) => row.file === 'src/engine.ts' && row.patch));
  });

  it('leaves the packet contract untouched when not asked', () => {
    const { cwd, range } = fixture();
    assert.equal(packet(cwd, 'doc-updater', range).evidence, undefined,
      'the runner inlines its own evidence; the packet must not grow a second copy for it');
  });

  // parseArgs consumed the token after every flag, so a valueless flag placed
  // before another swallowed it and the packet came back for the wrong lane.
  it('does not let the valueless flag swallow the flag after it', () => {
    const { cwd, range } = fixture();
    assert.equal(packet(cwd, 'doc-updater', range, '--with-evidence').lane, 'doc-updater');
  });
});

describe('lane-evidence.mjs — no range means unknown, never clean', () => {
  // A full-PR review and an `all` scope both arrive without a range. With no
  // range `changedFiles` is empty, so every diff-derived check summarised to
  // `{checked: 0, unresolved: []}` -- which reads as performed and passed. The
  // lane is told an empty `unresolved` is a clean pass, so that silently
  // converted "not checked" into "checked, nothing wrong".
  it('reports diff-derived checks as unknown when no range is given', () => {
    const { cwd } = makeRepo();
    write(cwd, 'src/thing.ts', 'export function drive() { return 1; }\n');
    write(cwd, 'documentation/architecture.md', 'Uses `drive`.\n');
    write(cwd, 'sdd/spec/agents.md', '1. <!-- @impl: src/thing.ts::drive -->\n');
    commit(cwd, 'feat: a tree with anchors, docs and code');

    const spec = run(cwd, 'spec-reviewer');
    const doc = run(cwd, 'doc-updater');
    const code = run(cwd, 'code-reviewer');

    assert.equal(spec.anchors, null, 'an unrun anchor check must not report zero failures');
    assert.equal(doc.anchors, null);
    assert.equal(doc.references, null);
    assert.equal(doc.docsCitingChanged, null,
      'an empty citation list would claim nothing changed cites a page');
    assert.equal(code.callSites, null);
    assert.equal(code.anchorsCitingChanged, null);
  });

  // The tree-derived answers do not depend on a diff and must survive, or
  // removing the false clean would cost every lane the checks it can still keep.
  it('still resolves the tree-derived answers without a range', () => {
    const { cwd } = makeRepo();
    write(cwd, 'documentation/README.md', '# Docs\n\n- [Arch](architecture.md)\n');
    write(cwd, 'documentation/architecture.md', '# Arch\n');
    write(cwd, 'documentation/decisions/README.md', '### AD001: A decision\n\n**Status:** Accepted\n');
    commit(cwd, 'docs: a tree with no diff under review');

    const doc = run(cwd, 'doc-updater');

    assert.deepEqual(doc.adrs, ['AD001|A decision|Accepted']);
    assert.deepEqual(doc.indexIntegrity, { unindexed: [], dangling: [] });
    assert.equal(doc.docIndexPresent, true);
  });
});

describe('lane-evidence.mjs — the recorded dispositions reach every lane', () => {
  // A rule that defers to a config disposition is only enforced by a lane that
  // can see it. One runtime is handed the config in a triage block for some
  // lanes; the other has no triage block at all, so gating this by lane
  // recreated the split it exists to remove.
  it('carries the config to every lane, not just the ones with a triage block', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'sdd/spec/config.yml', 'mode: interactive\nenforce_tdd: true\n');
    write(cwd, 'src/thing.ts', 'export const x = 1;\n');
    const head = commit(cwd, 'feat: config plus a source change');

    for (const lane of ['code-reviewer', 'spec-reviewer', 'doc-updater']) {
      const out = run(cwd, lane, `${base}..${head}`);
      assert.match(out.config, /enforce_tdd: true/,
        `${lane} must see the dispositions a rule defers to`);
    }
  });

  it('sheds the config with a marker rather than losing the whole block', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'sdd/spec/config.yml', `mode: interactive\n${'# filler disposition line\n'.repeat(40000)}`);
    // The ledger is what the shed exists to protect, so it has to be present and
    // non-empty for its survival to mean anything.
    write(cwd, 'documentation/decisions/README.md', '### AD001: Keep the ledger\n\n**Status:** Accepted\n');
    write(cwd, 'src/thing.ts', 'export const x = 1;\n');
    const head = commit(cwd, 'feat: an oversized config');

    const out = run(cwd, 'code-reviewer', `${base}..${head}`);

    assert.ok(out.omitted?.includes('config'), 'a config too large to carry must name itself');
    assert.ok(JSON.stringify(out, null, 1).length <= 65536,
      'an unsheddable field would push the block over the cap and blank every resolution');
    assert.deepEqual(out.adrs, ['AD001|Keep the ledger|Accepted'],
      'the resolutions survive the shed');
  });
});

describe('lane-evidence.mjs — the block bounds itself', () => {
  // The bound lives here, not in a caller. One runtime capped and shed by field;
  // the runtime that asks through the packet CLI had no cap at all, so the same
  // resolver was safe in one and unbounded in the other.
  it('sheds bulk with a named marker rather than dropping the block', () => {
    const { cwd, base } = makeRepo();
    // Link-shaped, because the index field keeps only headings and links: plain
    // filler never reaches it and the shed would never fire.
    const rows = Array.from({ length: 2000 }, (_, i) => `- [Page ${i}](lanes/page${i}.md)`);
    write(cwd, 'documentation/README.md', `# Docs\n\n${rows.join('\n')}\n`);
    write(cwd, 'src/real.ts', 'export const kept = 1;\n');
    write(cwd, 'documentation/architecture.md', 'Uses `kept`.\n');
    const head = commit(cwd, 'docs: an index past the cap');

    const out = run(cwd, 'doc-updater', `${base}..${head}`);

    assert.ok(out.omitted?.includes('docIndex'), 'a dropped field must name itself');
    assert.ok(JSON.stringify(out, null, 1).length <= 65536,
      'the cap has to be measured on the form that is actually emitted, not a denser one');
    assert.equal(typeof out.references?.checked, 'number',
      'resolutions are the part that removes turns and must survive the shed');
  });

  // A busy day reached 35 entries and 39 KB -- 72% of the spec lane's block, and
  // still growing. Drift detection asks whether THIS diff got an entry.
  it('caps the changelog by entry count, not just by date', () => {
    const { cwd, base } = makeRepo();
    const entries = Array.from({ length: 30 }, (_, i) => `- **Entry ${i}** something changed here.`);
    write(cwd, 'sdd/spec/changes.md', `# Spec Changes\n\n## 2026-07-26\n\n${entries.join('\n\n')}\n\n## 2026-07-25\n\n- **Older day** ignored.\n`);
    const head = commit(cwd, 'docs: a busy day');

    const { changelog } = run(cwd, 'spec-reviewer', `${base}..${head}`);

    assert.ok(changelog.includes('Entry 0'), 'the most recent entries are the ones drift is asked about');
    assert.ok(!changelog.includes('Entry 29'), 'the tail of a long day must not ride on every turn');
    assert.match(changelog, /older entries in this section omitted/,
      'a truncated field states its recovery rather than reading as the whole section');
    assert.ok(!changelog.includes('Older day'), 'the date scoping still holds');
  });
});

describe('lane-evidence.mjs — the index that replaced the per-candidate scan', () => {
  // The scan ran one full-tree grep per backticked token -- 149 of them on a
  // three-file range, measured at 283s, which is 99.94% of this lane's runtime
  // and four times the bound the packet CLI wraps it in, so one runtime lost
  // this block entirely. Reading the tree once is only a valid swap if the
  // verdicts survive, and the two that can move are the two asserted here: a
  // generated tree must still not declare anything, and a name must still be
  // matched exactly rather than by the shape of its parts.
  it('does not let a generated tree declare a symbol', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'src/lib/seed.generated.ts', 'export const ghostFromSeed = 1;\n');
    write(cwd, 'src/real.ts', 'export const livingSymbol = 1;\n');
    write(cwd, 'documentation/x.md', 'Uses `ghostFromSeed` and `livingSymbol`.\n');
    const head = commit(cwd, 'docs: generated');

    const rows = run(cwd, 'doc-updater', `${base}..${head}`).references;
    const unresolved = rows.unresolved.map((row) => row.ref);

    assert.ok(unresolved.includes('ghostFromSeed'),
      'a name that exists only in generated output is not a declaration; resolving it is a false clean');
    assert.ok(!unresolved.includes('livingSymbol'), 'and a real declaration still resolves');
  });

  it('does not resolve a name by the identifier next to it', () => {
    const { cwd, base } = makeRepo();
    // `handler(payload) {` declares handler, not payload; `const a = b` declares
    // a, not b. Reading one identifier per match is what keeps those apart, and
    // taking the wrong end of either span would resolve a reference to a name
    // nothing declares.
    write(cwd, 'src/a.ts', 'class T {\n  handlerName(payloadName) { return 1; }\n}\nconst leftName = rightName;\n');
    write(cwd, 'documentation/x.md', 'Uses `handlerName`, `payloadName`, `leftName`, `rightName`.\n');
    const head = commit(cwd, 'docs: spans');

    const unresolved = run(cwd, 'doc-updater', `${base}..${head}`).references.unresolved.map((row) => row.ref).sort();

    assert.deepEqual(unresolved, ['payloadName', 'rightName'],
      'a parameter and a right-hand side are referenced, not declared');
  });
});

describe('lane-evidence.mjs — a documented file named without its path', () => {
  // Seventeen of the unresolved rows on the measured range were scripts and
  // rules named by basename. They reached the symbol branch, which asks whether
  // a name is DECLARED, and failed there -- inventing a stale-doc finding for a
  // file that exists. The path branch never saw them because it only fires on a
  // candidate carrying a slash or a dot.
  it('resolves a tracked file referenced by its basename', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'scripts/run-the-lane.sh', 'echo hi\n');
    write(cwd, 'documentation/x.md', 'See `run-the-lane` and `never-a-file`.\n');
    const head = commit(cwd, 'docs: basenames');

    const rows = run(cwd, 'doc-updater', `${base}..${head}`).references;
    const resolved = rows.unresolved.map((row) => row.ref);

    assert.ok(!resolved.includes('run-the-lane'), 'the file exists, so the reference is not stale');
    assert.ok(resolved.includes('never-a-file'), 'and a basename matching nothing is still reported');
  });

  it('resolves a name that appears under more than one directory', () => {
    const { cwd, base } = makeRepo();
    // Existence, not uniqueness. The row records whether the name still names
    // something, never which file -- and staleness is the question. Demanding
    // one match reported `security.md` stale because the tree holds three.
    write(cwd, 'a/twinName.ts', 'export const one = 1;\n');
    write(cwd, 'b/twinName.ts', 'export const two = 2;\n');
    write(cwd, 'documentation/x.md', 'See `twinName` and `nothingNamedThis`.\n');
    const head = commit(cwd, 'docs: ambiguous');

    const unresolved = run(cwd, 'doc-updater', `${base}..${head}`).references.unresolved.map((row) => row.ref);

    assert.ok(!unresolved.includes('twinName'), 'the name still names tracked files, so the reference is not stale');
    assert.ok(unresolved.includes('nothingNamedThis'), 'and a name matching nothing is still reported');
  });

  it('resolves a file named by a path tail, a command by its registered name, and a declared package', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'rules/common/style.md', '# style\n');
    write(cwd, 'src/cmd.ts', 'registerCommand("reload", {});\n');
    write(cwd, 'package.json', '{"dependencies":{"@scope/dep":"1.0.0"}}\n');
    write(cwd, 'documentation/x.md',
      'See `common/style.md`, `/reload`, `@scope/dep`, `--verify-high`, and `goneEntirely`.\n');
    const head = commit(cwd, 'docs: shapes');

    const rows = run(cwd, 'doc-updater', `${base}..${head}`).references;
    const unresolved = rows.unresolved.map((row) => row.ref);

    assert.deepEqual(unresolved, ['goneEntirely'],
      'a nested path tail, a string-registered command and a declared dependency all name real things');
    assert.ok(!rows.unresolved.some((row) => row.ref === '--verify-high'),
      'a flag documents an interface and is never a candidate');
  });
});

describe('lane-evidence.mjs — the failure list is the finding', () => {
  it('reports every unresolved reference rather than a capped sample', () => {
    const { cwd, base } = makeRepo();
    // The cap was 40 while a clean tree produced 113 failures, so the lane saw a
    // slice with a flag and could not act on what it was handed -- and two
    // comparisons of this resolver's own output silently compared slices.
    const refs = Array.from({ length: 60 }, (_, i) => `goneSymbol${i}`);
    write(cwd, 'documentation/x.md', `Uses ${refs.map((r) => `\`${r}\``).join(', ')}.\n`);
    const head = commit(cwd, 'docs: many');

    const out = run(cwd, 'doc-updater', `${base}..${head}`).references;

    assert.equal(out.unresolved.length, refs.length, 'every failure must be listed, not a sample of them');
    assert.ok(!out.truncated, 'a list that fits is not truncated');
  });
});

describe('lane-evidence.mjs — cost is bounded by the tree, not the document', () => {
  it('answers two hundred names for the cost of reading the tree', () => {
    const { cwd, base } = makeRepo();
    // The contract AC1 states. Under the per-candidate design this was one
    // full-tree search per name -- 149 names measured at 283 seconds, and a
    // miss costs more than a hit because the search cannot stop early. Two
    // hundred names would have taken minutes; the bound here is generous
    // enough to be stable on a loaded machine and still two orders of
    // magnitude below that.
    for (let i = 0; i < 50; i += 1) write(cwd, `src/mod${i}.ts`, `export const sym${i} = ${i};\n`);
    const names = Array.from({ length: 200 }, (_, i) => (i < 50 ? `sym${i}` : `absent${i}`));
    write(cwd, 'documentation/x.md', `Uses ${names.map((n) => `\`${n}\``).join(', ')}.\n`);
    const head = commit(cwd, 'docs: many names');

    const out = run(cwd, 'doc-updater', `${base}..${head}`).references;

    // Same tree, a tenth of the names. The contract is that the second run
    // costs the same passes over the tree as the first -- asserted as a count,
    // not a duration: a stopwatch on a shared runner fails for load rather than
    // for regression, and the per-candidate design this replaced would have
    // scaled the COUNT, not merely the clock.
    write(cwd, 'documentation/x.md', `Uses ${names.slice(0, 20).map((n) => `\`${n}\``).join(', ')}.\n`);
    const fewer = run(cwd, 'doc-updater', `${base}..${commit(cwd, 'docs: fewer names')}`).references;

    assert.equal(out.checked, names.length, 'every name must be answered, not a capped sample');
    assert.equal(out.unresolved.length, 150, 'the fifty declared names resolve and the rest do not');
    assert.ok(out.passes > 0, 'the resolver must report how many passes over the tree it took');
    assert.equal(out.passes, fewer.passes,
      `resolution must cost the same passes for ${names.length} names as for 20`);
  });
});

describe('lane-evidence.mjs — the resolver ships to every bootstrapped repo', () => {
  it('resolves declarations and dependencies in a repo that is not JavaScript', () => {
    const { cwd, base } = makeRepo();
    // The resolver is seeded by `/sdd init` into whatever repo runs it, and an
    // unresolved reference is reported to the doc lane as a stale document. So
    // a declaration index that only understands one language does not degrade
    // gracefully -- it turns a consistent Rust or Python tree into a page of
    // false findings on every boundary event.
    write(cwd, 'src/lib.rs', 'pub struct Widget {}\npub fn render_widget() {}\nenum Mode { On }\n');
    write(cwd, 'app/service.py', 'class OrderService:\n    def compute_total(self):\n        return 0\n');
    write(cwd, 'cmd/main.go', 'type Config struct {}\nfunc StartServer() {\n}\n');
    write(cwd, 'lib/report.rb', 'class ReportBuilder\n  def generate_report\n  end\nend\n');
    write(cwd, 'Cargo.toml', '[dependencies]\nserde = { version = "1" }\n');
    write(cwd, 'pyproject.toml', '[project]\ndependencies = ["httpx>=0.27"]\n');
    write(cwd, 'Gemfile', "source 'https://rubygems.org'\ngem 'rails'\n");
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'feat: polyglot tree');

    write(cwd, 'documentation/architecture.md',
      'Types `Widget`, `Mode`, `Config`, `OrderService`, `ReportBuilder`.\n'
      + 'Functions `render_widget`, `compute_total`, `StartServer`, `generate_report`.\n'
      + 'Dependencies `serde`, `httpx`, `rails`. Removed: `vanishedHelper`.\n');
    const head = commit(cwd, 'docs: architecture');

    const out = run(cwd, 'doc-updater', `${base}..${head}`).references;
    const unresolved = out.unresolved.map((row) => row.ref);

    assert.deepEqual(unresolved, ['vanishedHelper'],
      'only the name with no declaration anywhere in the tree may be reported stale');
    assert.equal(out.checked, 13, 'every documented name must be answered');
  });

  it('does not let a control keyword in another language declare a name', () => {
    const { cwd, base } = makeRepo();
    // `match x {` is a Rust block opener, not a declaration of `match`. The
    // definition shape cannot tell them apart, so the exclusion list has to.
    write(cwd, 'src/lib.rs', 'pub fn run(x: u8) {\n    match x {\n        _ => (),\n    }\n}\n');
    write(cwd, 'lib/a.rb', 'def go\n  unless true\n  end\nend\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'feat: keywords');

    write(cwd, 'documentation/architecture.md', 'Calls `match` and `unless` and `run`.\n');
    const head = commit(cwd, 'docs: keywords');

    const unresolved = run(cwd, 'doc-updater', `${base}..${head}`).references.unresolved.map((r) => r.ref);
    assert.deepEqual(unresolved.sort(), ['match', 'unless'],
      'a block opener must not resolve; the real function beside it must');
  });
});

describe('lane-evidence.mjs — a bounded list says so', () => {
  it('marks a list that reaches the bound as truncated', () => {
    const { cwd, base } = makeRepo();
    // The list is bounded, and the lane is told a non-truncated list is a
    // complete pass. So the only thing that makes a bound safe is that reaching
    // it is visible: an unmarked 400 of 500 reads as "those are all of them",
    // which is the false clean the whole resolver exists to avoid.
    const names = Array.from({ length: 500 }, (_, i) => `absent${i}`);
    write(cwd, 'documentation/x.md', `Uses ${names.map((n) => `\`${n}\``).join(', ')}.\n`);
    const head = commit(cwd, 'docs: past the bound');

    const out = run(cwd, 'doc-updater', `${base}..${head}`).references;

    assert.equal(out.truncated, true, 'a list that reaches its bound must be marked');
    assert.ok(out.unresolved.length < names.length,
      'the bound must actually bound the list it marks');
  });
});

describe('lane-evidence.mjs — the weakest resolution is reported as such', () => {
  it('separates a name kept alive only by a quoted string from a declared one', () => {
    const { cwd, base } = makeRepo();
    // A quoted string is real evidence and the weakest this resolver accepts:
    // it is equally satisfied by a registration, an error message, a fixture
    // and a dead compatibility branch. Reporting it as an ordinary clean hands
    // the lane a verdict it cannot weigh, so it arrives in its own list.
    write(cwd, 'src/app.ts', 'export const declaredThing = 1;\nconst t = ["registeredThing"];\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'feat: two kinds of evidence');

    write(cwd, 'documentation/x.md', 'Uses `declaredThing` and `registeredThing` and `goneThing`.\n');
    const out = run(cwd, 'doc-updater', `${base}..${commit(cwd, 'docs: x')}`).references;

    assert.deepEqual(out.unresolved.map((r) => r.ref), ['goneThing']);
    assert.deepEqual((out.resolvedOnlyByStringLiteral ?? []).map((r) => r.ref), ['registeredThing'],
      'a name resolved only by a quoted string must be reported separately from a declaration');
  });
});
