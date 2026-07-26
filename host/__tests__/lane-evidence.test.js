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
      { id: 'AD001', title: 'First decision', status: 'Accepted' },
      { id: 'AD002', title: 'Rejected idea', status: 'Superseded' },
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
