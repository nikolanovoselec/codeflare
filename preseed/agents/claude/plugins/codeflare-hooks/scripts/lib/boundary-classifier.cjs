// Shell-aware delivery-boundary classifier, shared by the two callers asking the
// same question: transcript_scan (which transcript command opened a boundary)
// and the PreToolUse triage gate (is the command about to run one).
//
// It lives here because the gate tried to answer this with a regex and needed
// four revisions across three review rounds, each closing the forms the last
// report named while leaving the class open: flags, then env assignments and
// wrappers and absolute paths, then shell keywords. Shell is not a regular
// language. This parser already handled every one of those for the Stop path,
// quoting and command substitution and heredocs included, so the gate now asks
// it instead of approximating it.
//
// boundaryOf returns '' when no git/gh ran at all, '-' when one ran but is not a
// delivery, and the event name otherwise. Pass { commit: true } to count
// `git commit` as an event; the Stop path deliberately does not.

const EMPTY = new Set();
const controls = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', '{']);
const prefixes = new Set(['command', 'builtin', 'exec', 'sudo', 'time', 'env', 'nohup', 'nice', 'xargs', 'stdbuf', 'timeout']);
// A wrapper's own options are not the wrapped command, and some of them eat the
// next word. Without this, `sudo -u me git push` reads as the command `me` and
// the push behind it is never seen. `timeout` is the odd one out: its argument
// is a bare duration rather than an option value, so it gets its own rule.
const prefixTakesValue = {
  sudo: new Set(['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U']),
  env: new Set(['-u', '-C', '-S']),
  nice: new Set(['-n']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e']),
};
const DURATION = /^[0-9]+(\.[0-9]+)?[smhd]?$/;
// Boundary classification mirrors Pi's classifyReviewBoundaryCommand
// (preseed/agents/pi/extensions/review-helpers.ts) and reuses its global-option
// sets from guard-helpers.ts verbatim. Any git/gh in command position is still
// recognised; the SUBCOMMAND is what says a delivery boundary happened, and
// Layer 2 (`gh pr view` below) remains the authority on whether that boundary is
// an eligible, open, unacknowledged PR head.
const takesValue = {
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix']),
  gh: new Set(['-R', '--repo', '--hostname', '--config']),
};
function boundaryEvent(executable, rest, options) {
  let index = 0;
  while (index < rest.length) {
    const value = rest[index] ?? '';
    if (value === '--') { index++; break; }
    if (!value.startsWith('-')) break;
    if (takesValue[executable].has(value) && !value.includes('=')) index++;
    index++;
  }
  const args = rest.slice(index);
  if (executable === 'git' && args[0] === 'push') return 'push';
  // The Stop path asks only about delivery boundaries. The PreToolUse gate also
  // has to stop a commit, because a commit minted mid-window is the head the
  // round was never run against.
  if (executable === 'git' && args[0] === 'commit' && options && options.commit) return 'commit';
  if (executable === 'gh' && args[0] === 'pr' && (args[1] === 'create' || args[1] === 'merge')) return args[1];
  return '';
}
function heredocDeclarations(line) {
  const declarations = [];
  let quote = '';
  for (let index = 0; index < line.length; index++) {
    const char = line[index] || '';
    if (quote) {
      if (char === '\\' && quote === '"') index++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '\\') { index++; continue; }
    if (char !== '<' || line[index + 1] !== '<' || line[index + 2] === '<') continue;
    let cursor = index + 2;
    const stripTabs = line[cursor] === '-';
    if (stripTabs) cursor++;
    while (line[cursor] === ' ' || line[cursor] === '\t') cursor++;
    let delimiter = '', delimiterQuote = '';
    while (cursor < line.length) {
      const token = line[cursor] || '';
      if (delimiterQuote) {
        if (token === delimiterQuote) delimiterQuote = '';
        else if (token === '\\' && delimiterQuote === '"' && cursor + 1 < line.length) delimiter += line[++cursor] || '';
        else delimiter += token;
      } else if (token === "'" || token === '"') delimiterQuote = token;
      else if (token === '\\' && cursor + 1 < line.length) delimiter += line[++cursor] || '';
      else if (/\s/.test(token) || ';&|<>'.includes(token)) break;
      else delimiter += token;
      cursor++;
    }
    if (delimiter) declarations.push({ delimiter, stripTabs });
    index = cursor - 1;
  }
  return declarations;
}
function stripHeredocs(text) {
  const out = [], pending = [];
  for (const line of text.split(/\r?\n/)) {
    if (pending.length) {
      const active = pending[0];
      const candidate = active.stripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === active.delimiter) pending.shift();
      continue;
    }
    out.push(line);
    pending.push(...heredocDeclarations(line));
  }
  return out.join('\n');
}
// Returns '' when the text runs no git/gh at all, '-' when it does but none is a
// delivery subcommand, and the event name otherwise. Candidacy stays broad on
// purpose: enforcement triggers on any git/gh activity, which is the contract
// the structural-boundary tests pin. Only the coverage window narrows.
function boundaryOf(text, options) {
  let candidate = false, found = '';
  function scan(source) {
    let word = '', command = true, prefix = false;
    // Set once git/gh is seen in command position; `rest` collects that simple
    // command's remaining words so the subcommand can be read at its end.
    let tool = '', rest = [];
    // Name of the wrapper currently in front of the command, and whether the
    // next word is that wrapper's option value rather than the command itself.
    let prefixName = '', pendingValue = false;
    const decide = () => {
      if (tool) { const event = boundaryEvent(tool, rest, options); if (event) found = event; }
      tool = ''; rest = [];
    };
    const finish = () => {
      if (!word) return;
      const value = word; word = '';
      if (tool) { rest.push(value); return; }
      if (!command || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(value) || controls.has(value)) return;
      // An absolute or relative path invokes the same tool: `/usr/bin/git push`
      // is a push. Compare on the basename, and keep the basename as `tool` so
      // the option tables below are still keyed by the name they know.
      const base = value.slice(value.lastIndexOf('/') + 1);
      if (base === 'git' || base === 'gh') { candidate = true; tool = base; command = false; return; }
      if (prefix) {
        if (pendingValue) { pendingValue = false; return; }
        if (value.startsWith('-')) {
          if ((prefixTakesValue[prefixName] || EMPTY).has(value) && !value.includes('=')) pendingValue = true;
          return;
        }
        if (prefixName === 'timeout' && DURATION.test(value)) return;
      }
      prefix = prefixes.has(base); prefixName = prefix ? base : ''; pendingValue = false; command = prefix;
    };
    const boundary = () => { finish(); decide(); command = true; prefix = false; prefixName = ''; pendingValue = false; };
    function substitution(start) {
      let depth = 1, quote = '', escaped = false;
      for (let i = start; i < source.length; i++) {
        const c = source[i];
        if (escaped) { escaped = false; continue; }
        if (c === '\\' && quote !== "'") { escaped = true; continue; }
        if (quote) { if (c === quote) quote = ''; continue; }
        if (c === "'" || c === '"') { quote = c; continue; }
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) { scan(source.slice(start, i)); return i; }
      }
      return source.length;
    }
    for (let i = 0; i < source.length && !found; i++) {
      const c = source[i];
      if (c === "'") { for (i++; i < source.length && source[i] !== "'"; i++) word += source[i]; continue; }
      if (c === '"') {
        for (i++; i < source.length && source[i] !== '"'; i++) {
          if (source[i] === '\\') word += source[++i] || '';
          else if (source[i] === '$' && source[i + 1] === '(') i = substitution(i + 2);
          else if (source[i] === '`') { const end = source.indexOf('`', i + 1); if (end < 0) break; scan(source.slice(i + 1, end)); i = end; }
          else word += source[i];
        }
        continue;
      }
      if (c === '\\') { word += source[++i] || ''; continue; }
      if (c === '$' && source[i + 1] === '(') { i = substitution(i + 2); continue; }
      if (c === '`') { const end = source.indexOf('`', i + 1); if (end < 0) break; scan(source.slice(i + 1, end)); i = end; continue; }
      if (/\s/.test(c) || ';&|(){}'.includes(c)) { finish(); if (';&|(){}\n\r'.includes(c)) boundary(); continue; }
      word += c;
    }
    finish();
    decide();
  }
  scan(stripHeredocs(text));
  return candidate ? (found || '-') : '';
}

module.exports = { boundaryOf };
