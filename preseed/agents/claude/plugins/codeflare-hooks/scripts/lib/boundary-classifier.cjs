// Shell-aware classifier for marker-aware review exposures. Quoting,
// wrappers, substitution, and heredoc bodies must not turn mentioned commands
// into executable review ingress.
//
// boundaryOf returns '' when no git/gh ran, '-' when git/gh ran without a
// planned exposure, and the final relevant exposure name otherwise. The
// optional commit mode remains available to unrelated mutation guards.

const fs = require('node:fs');
const path = require('node:path');

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
// Shells are wrappers too, but of a different kind: the ones above take a
// COMMAND, a shell takes a STRING it then runs as code. That difference is why
// they could not just be added to `prefixes` -- and why, until they were handled
// at all, `bash -c "git push"` walked straight through. The parser saw `bash`,
// which is neither a tool nor a known wrapper, set command=false, and dropped
// every remaining word including the one holding the push.
const shells = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'eval']);
// Boundary classification mirrors Pi's classifyReviewBoundaryCommand and
// reuses its global-option sets. Command parsing selects an exposure; later
// GitHub lookup decides whether the active checkout is eligible.
const takesValue = {
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix']),
  gh: new Set(['-R', '--repo', '--hostname', '--config']),
};
function boundaryMatch(executable, rest, options) {
  let index = 0;
  let repository;
  while (index < rest.length) {
    const value = rest[index] ?? '';
    if (value === '--') { index++; break; }
    if (!value.startsWith('-')) break;
    if (executable === 'gh') {
      if ((value === '-R' || value === '--repo') && !value.includes('=')) repository = rest[index + 1];
      else if (value.startsWith('--repo=')) repository = value.slice('--repo='.length);
    }
    if (takesValue[executable].has(value) && !value.includes('=')) index++;
    index++;
  }
  const args = rest.slice(index);
  let kind = '';
  if (executable === 'git' && args[0] === 'clone') kind = 'clone';
  else if (executable === 'gh' && args[0] === 'repo' && args[1] === 'clone') kind = 'clone';
  else if (executable === 'git' && args[0] === 'switch'
    && !args.includes('--detach') && !args.includes('-d')) kind = 'switch';
  else if (executable === 'git' && args[0] === 'checkout'
    && !args.includes('--') && !args.includes('--detach')) kind = 'checkout';
  else if (executable === 'gh' && args[0] === 'pr' && args[1] === 'checkout') kind = 'pr-checkout';
  else if (executable === 'git' && args[0] === 'pull') kind = 'pull';
  else if (executable === 'git' && args[0] === 'push') kind = 'push';
  else if (executable === 'gh' && args[0] === 'pr' && (args[1] === 'create' || args[1] === 'reopen')) kind = 'pr-create';
  else if (executable === 'git' && args[0] === 'commit' && options && options.commit) kind = 'commit';
  else if (executable === 'git' && args[0] === 'merge' && options && options.commit) kind = 'merge';
  else if (executable === 'gh' && args[0] === 'pr' && args[1] === 'merge' && options && options.commit) kind = 'merge';
  return kind ? { kind, executable, args, repository } : undefined;
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
// Returns the final relevant exposure. Ordinary git/gh activity remains inert.
function boundaryOf(text, options) {
  let candidate = false, found = '', details;
  function scan(source) {
    let word = '', command = true, prefix = false;
    // Set once git/gh is seen in command position; `rest` collects that simple
    // command's remaining words so the subcommand can be read at its end.
    let tool = '', rest = [];
    // Name of the wrapper currently in front of the command, and whether the
    // next word is that wrapper's option value rather than the command itself.
    let prefixName = '', pendingValue = false;
    // Shell wrapper state: the shell's own name, whether its options have said
    // the next word is code, and the words of that code once collected.
    let shellName = '', shellWantsCode = false, codeWords = null;
    const decide = () => {
      // Descend into a shell's code before judging this simple command. Joining
      // the words handles both `eval "git push"` (one quoted word) and
      // `eval git push` (two bare ones) with the same pass.
      if (codeWords) {
        const code = codeWords.join(' ');
        codeWords = null; shellName = ''; shellWantsCode = false;
        scan(code);
      }
      if (tool) {
        const match = boundaryMatch(tool, rest, options);
        if (match) { found = match.kind; details = match; }
      }
      tool = ''; rest = [];
    };
    const finish = () => {
      if (!word) return;
      const value = word; word = '';
      if (tool) { rest.push(value); return; }
      // Shell handling sits ahead of the command guard below, because seeing the
      // shell is exactly what sets command=false; the words after it are the
      // shell's arguments, not dropped noise.
      if (codeWords) { codeWords.push(value); return; }
      if (shellName) {
        if (value.startsWith('-')) {
          // -c, and combined forms like -lc. `eval` has no such flag: everything
          // after it is already code.
          if (value.slice(1).includes('c')) shellWantsCode = true;
          return;
        }
        // A herestring feeds the shell code exactly as `-c` does. `<` is not a
        // word-break character here, so `<<<` arrives glued to whatever follows
        // it when there is no space: `bash <<<"git push"` is one word. Any fd
        // prefix is matched deliberately: fd 0 (`bash 0<<<"git push"`) is
        // equivalent to `-c`, and other descriptors are over-matched on
        // purpose — fail-closed beats guessing which fd the shell will read.
        const herestring = value.match(/^\d*<<<([\s\S]*)$/);
        if (herestring) {
          const inline = herestring[1];
          if (inline) codeWords = [inline];
          else shellWantsCode = true;
          return;
        }
        if (shellWantsCode) { codeWords = [value]; return; }
        // A bare word under a shell with no -c is a script FILE. Its contents
        // are not in this command, so there is nothing further to read.
        shellName = '';
        return;
      }
      if (!command || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(value) || controls.has(value)) return;
      // An absolute or relative path invokes the same tool: `/usr/bin/git push`
      // is a push. Compare on the basename, and keep the basename as `tool` so
      // the option tables below are still keyed by the name they know.
      const base = value.slice(value.lastIndexOf('/') + 1);
      if (base === 'git' || base === 'gh') { candidate = true; tool = base; command = false; return; }
      if (shells.has(base)) { shellName = base; shellWantsCode = base === 'eval'; command = false; return; }
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
    const boundary = () => {
      finish(); decide();
      command = true; prefix = false; prefixName = ''; pendingValue = false;
      // A shell that never reached its code (`bash ; git push`) must not leave
      // its state standing, or the next simple command is read as its argument.
      shellName = ''; shellWantsCode = false; codeWords = null;
    };
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
    for (let i = 0; i < source.length; i++) {
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
  return options?.details ? details : candidate ? (found || '-') : '';
}

function boundaryDetails(text) {
  return boundaryOf(text, { details: true });
}

function isReviewMergeCommand(text) {
  return boundaryOf(text, { commit: true, details: true })?.kind === 'merge';
}

function reopenTarget(args) {
  for (let index = 2; index < args.length; index++) {
    const value = args[index] ?? '';
    if (value === '-c' || value === '--comment') { index++; continue; }
    if (value.startsWith('--comment=') || value.startsWith('-')) continue;
    return value;
  }
  return undefined;
}

function exposureTargetsCheckedOutBranch(text, identity) {
  const match = boundaryDetails(text);
  if (!match || !['push', 'pr-create'].includes(match.kind)) return true;
  if (match.executable === 'gh') {
    if (match.repository && match.repository.toLowerCase() !== identity.repository.toLowerCase()) return false;
    if (match.args[1] === 'reopen') {
      const target = reopenTarget(match.args);
      if (!target) return true;
      const url = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/i.exec(target);
      if (url) return url[1].toLowerCase() === identity.repository.toLowerCase() && Number(url[2]) === identity.pr;
      if (/^[0-9]+$/.test(target)) return Number(target) === identity.pr;
      return target === identity.branch || target.endsWith(`:${identity.branch}`);
    }
    const headIndex = match.args.findIndex((arg) => arg === '--head' || arg === '-H');
    const inline = match.args.find((arg) => arg.startsWith('--head='))?.slice('--head='.length);
    const head = inline ?? (headIndex >= 0 ? match.args[headIndex + 1] : undefined);
    return !head || head === identity.branch || head.endsWith(`:${identity.branch}`);
  }
  const takesPushValue = new Set(['--repo', '--receive-pack', '--exec', '--push-option', '-o']);
  const positional = [];
  for (let index = 1; index < match.args.length; index++) {
    const value = match.args[index] ?? '';
    if (value === '--') { positional.push(...match.args.slice(index + 1)); break; }
    if (takesPushValue.has(value)) { index++; continue; }
    if (value.startsWith('-')) continue;
    positional.push(value);
  }
  const refspecs = positional.slice(1);
  return refspecs.length === 0 || refspecs.every((refspec) => {
    const [source, destination] = refspec.replace(/^\+/, '').split(':', 2);
    const sourceMatches = source === identity.branch || source === `refs/heads/${identity.branch}` || source === 'HEAD';
    const destinationMatches = !destination || destination === identity.branch
      || destination === `refs/heads/${identity.branch}`;
    return sourceMatches && destinationMatches;
  });
}

function cloneTargetPath(text, cwd) {
  const match = boundaryDetails(text);
  if (!match || match.kind !== 'clone') return undefined;
  let source, destination;
  if (match.executable === 'gh') {
    source = match.args[2];
    destination = match.args[3];
  } else {
    const cloneTakesValue = new Set([
      '-b', '--branch', '-o', '--origin', '-u', '--upload-pack', '-c', '--config', '--depth',
      '--shallow-since', '--shallow-exclude', '--separate-git-dir', '--reference', '--reference-if-able',
      '--dissociate', '--jobs', '-j', '--filter', '--server-option',
    ]);
    const positional = [];
    for (let index = 1; index < match.args.length; index++) {
      const value = match.args[index] ?? '';
      if (value === '--') { positional.push(...match.args.slice(index + 1)); break; }
      if (cloneTakesValue.has(value)) { index++; continue; }
      if (value.startsWith('-')) continue;
      positional.push(value);
    }
    [source, destination] = positional;
  }
  const inferred = source?.replace(/[\\/]$/, '').split(/[\\/]/).at(-1)?.replace(/\.git$/, '');
  const target = destination || inferred;
  return target ? path.resolve(cwd, target) : undefined;
}

function currentRoundVisible(transcript, offset, pr, head) {
  let data;
  try {
    data = fs.readFileSync(transcript).subarray(offset).toString('utf8');
  } catch {
    return false;
  }
  const prToken = new RegExp(`(?:^|\\s)--boundary-pr(?:=|\\s+)${pr}(?=\\s|$)`);
  const headToken = new RegExp(`(?:^|\\s)CODEFLARE_REVIEW_HEAD=${head}(?=\\s|$)`);
  const runner = /(?:^|[;&|]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]+\s+)*bash\s+[^\s;&|]*run-review-lane\.sh(?=\s|$)/;
  for (const line of data.split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== 'tool_use' && part?.type !== 'toolCall') continue;
      const command = part?.input?.command ?? part?.arguments?.command;
      if (typeof command === 'string' && runner.test(command) && prToken.test(command) && headToken.test(command)) return true;
    }
  }
  return false;
}

module.exports = {
  boundaryOf,
  boundaryDetails,
  cloneTargetPath,
  currentRoundVisible,
  exposureTargetsCheckedOutBranch,
  isReviewMergeCommand,
};
