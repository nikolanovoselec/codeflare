#!/usr/bin/env node
// Proves that a source delta changes nothing but comments and whitespace.
// Fail-closed by construction: ANY doubt exits non-zero and the caller reads
// that as "behavioural", i.e. all three review lanes.
//
//   printf '%s\0' <path>... | node inert-source-delta.mjs <baseSha> <headSha>
//
//   exit 0  every path's delta between the two SHAs is comment/whitespace only
//   exit 1  not proven: unsupported extension, an added/deleted/renamed file,
//           a binary blob, a construct the scanner cannot resolve, a git
//           failure, or no paths at all
//
// Method: both blobs are PROJECTED to a comment-free, whitespace-normalised
// form and compared, instead of classifying changed lines. Line classification
// cannot decide whether a line reading `// x` sits inside a template literal;
// projection can, because it carries lexical state. This matters concretely:
// the file that motivated this check has real template literals AND a block
// comment that both contain backticks.
//
// Projection rules that carry the proof:
//   - a line comment is dropped; its newline is emitted by the newline rule;
//   - a block comment becomes one space, or one NEWLINE when it spans lines
//     (JS treats a multi-line comment as a line terminator for automatic
//     semicolon insertion, so collapsing it to a space would change meaning);
//   - string and template bodies are copied byte-for-byte, so whitespace or a
//     `//` INSIDE a literal is never normalised away;
//   - `${...}` inside a template is code again;
//   - code whitespace collapses to one space, newline runs to one newline.
//
// Anything unresolvable throws Bail: a `/` that may open a regex literal, a
// JSX tag, an unterminated literal, a string line-continuation, a NUL byte.
// A shebang also bails (`#!` leaves `/` in operator position) - conservative
// and correct for the file class this serves.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// .tsx/.jsx are excluded outright: JSX text is content, and a scanner that
// stripped `//` from it would call two different JSX texts identical.
const ELIGIBLE = /\.(?:ts|js|mjs|cjs)$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const REGEX_LEADING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

class Bail extends Error {}

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export function project(src) {
  if (src.includes('\0')) throw new Bail('binary blob');
  const buf = [];
  const lastCodeIndex = () => {
    for (let k = buf.length - 1; k >= 0; k--) {
      if (buf[k] !== ' ' && buf[k] !== '\n') return k;
    }
    return -1;
  };
  const space = () => {
    const tail = buf[buf.length - 1];
    if (buf.length && tail !== ' ' && tail !== '\n') buf.push(' ');
  };
  const newline = () => {
    while (buf.length && buf[buf.length - 1] === ' ') buf.pop();
    if (buf.length && buf[buf.length - 1] !== '\n') buf.push('\n');
  };

  // Frame stack: a `${` inside a template pushes a code frame that ends at its
  // matching `}`. depth counts `{` so an object literal inside `${}` cannot
  // close the substitution early.
  const frames = [{ kind: 'code', depth: 0 }];
  let i = 0;

  while (i < src.length) {
    const frame = frames[frames.length - 1];
    const c = src[i];

    if (frame.kind === 'template') {
      if (c === '\\') { buf.push(c, src[i + 1] ?? ''); i += 2; continue; }
      if (c === '`') { buf.push(c); frames.pop(); i += 1; continue; }
      if (c === '$' && src[i + 1] === '{') {
        buf.push('$', '{');
        frames.push({ kind: 'code', depth: 0 });
        i += 2;
        continue;
      }
      buf.push(c); i += 1; continue;            // template text is content
    }

    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Bail('unterminated block comment');
      if (src.slice(i, end).includes('\n')) newline(); else space();
      i = end + 2;
      continue;
    }
    if (c === '/' && src[i + 1] === '>') throw new Bail('JSX self-closing tag');
    if (c === '<' && src[i + 1] === '/') throw new Bail('JSX closing tag');
    if (c === '/') {
      // Division or regex literal. Division only when the previous significant
      // character can END an expression AND the word before it is not a
      // keyword (`return /re/` reads as alphanumeric-then-slash but opens a
      // regex). Everything else bails rather than risk desyncing on a regex
      // containing a quote, a backtick, or `/*`.
      const k = lastCodeIndex();
      const prev = k < 0 ? '' : buf[k];
      let word = '';
      for (let w = k; w >= 0 && /[A-Za-z_$]/.test(buf[w]); w--) word = buf[w] + word;
      // ')' is deliberately NOT in this set: it terminates an expression in
      // `a = (b) / c` but also precedes a statement-position regex in
      // `if (x) /re/.test(y)`, and only a parser can tell those apart.
      if (!/[\]\w$'"`]/.test(prev) || REGEX_LEADING_KEYWORDS.has(word)) {
        throw new Bail('possible regex literal');
      }
      buf.push(c); i += 1; continue;
    }
    if (c === '"' || c === "'") {
      buf.push(c); i += 1;
      for (;;) {
        if (i >= src.length) throw new Bail('unterminated string');
        const s = src[i];
        if (s === '\n') throw new Bail('line continuation in string');
        buf.push(s);
        if (s === '\\') {
          if (i + 1 >= src.length) throw new Bail('unterminated escape');
          buf.push(src[i + 1]); i += 2; continue;
        }
        i += 1;
        if (s === c) break;
      }
      continue;
    }
    if (c === '`') { buf.push(c); frames.push({ kind: 'template' }); i += 1; continue; }
    if (c === '{') { frame.depth += 1; buf.push(c); i += 1; continue; }
    if (c === '}') {
      if (frame.depth === 0) {
        if (frames.length === 1) throw new Bail('unbalanced brace');
        buf.push(c); frames.pop(); i += 1; continue;
      }
      frame.depth -= 1; buf.push(c); i += 1; continue;
    }
    if (c === '\n') { newline(); i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { space(); i += 1; continue; }
    buf.push(c); i += 1;
  }

  if (frames.length !== 1) throw new Bail('unterminated template literal');
  while (buf.length && (buf[buf.length - 1] === ' ' || buf[buf.length - 1] === '\n')) buf.pop();
  return buf.join('');
}

export function inert(base, head, paths) {
  if (paths.length === 0) return false;
  for (const p of paths) if (!ELIGIBLE.test(p)) return false;

  // One git call for the whole set. This runs from the turn-end hook on every
  // turn while a PR is open, and a per-path call made the cost linear in a
  // range that is usually all-eligible.
  // --raw carries the old and new mode, which --name-status does not.
  // :(top,literal) - pathspecs are cwd-relative and glob-active by default;
  // diff output is repo-root-relative and may contain glob metacharacters, so
  // both magics are required.
  let raw;
  try {
    raw = git(['diff', '--no-renames', '--raw', base, head,
               '--', ...paths.map((p) => `:(top,literal)${p}`)]).trim();
  } catch { return false; }

  // Only a plain modification can be inert. An add or a delete changes the set
  // of modules even when the file body is nothing but comments, and a rename
  // arrives here as an add+delete pair under --no-renames. A mode change is a
  // real change the content projection cannot see: chmod +x, or a regular file
  // swapped for a symlink (100644 -> 120000).
  const modified = new Set();
  for (const line of raw.split('\n')) {
    const entry = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ M\t(.*)$/.exec(line);
    if (!entry || entry[1] !== entry[2]) return false;
    modified.add(entry[3]);
  }
  // Every requested path must be accounted for exactly once, or the diff said
  // something about this range that the loop above did not inspect.
  if (modified.size !== paths.length || paths.some((p) => !modified.has(p))) return false;

  for (const p of paths) {
    try {
      if (project(git(['show', `${base}:${p}`])) !== project(git(['show', `${head}:${p}`]))) {
        return false;
      }
    } catch { return false; }
  }
  return true;
}

// Proof is POSITIVE: a run that decides nothing must not be readable as a
// proof. Exiting 0 alone once meant "inert", so every path that reached the
// end without deciding -- most importantly an entry guard that never fired --
// silently dropped two review lanes. Callers now require this token.
export const PROOF_TOKEN = 'INERT';

function main() {
  const [base, head] = process.argv.slice(2);
  if (!FULL_SHA.test(base ?? '') || !FULL_SHA.test(head ?? '')) return 1;
  let paths;
  try { paths = readFileSync(0, 'utf8').split('\0').filter(Boolean); }
  catch { return 1; }
  try {
    if (!inert(base, head, paths)) return 1;
    process.stdout.write(`${PROOF_TOKEN}\n`);
    return 0;
  } catch { return 1; }
}

// realpathSync both sides: Node resolves symlinks for import.meta.url but not
// for process.argv[1], so a symlink anywhere in the install path made this
// comparison false, skipped main() entirely, and exited 0 having proven
// nothing.
const entry = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]); } catch { return process.argv[1]; } })() : '';
if (entry && realpathSync(fileURLToPath(import.meta.url)) === entry) {
  process.exit(main());
}
