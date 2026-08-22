/**
 * Pure PreToolUse guard predicates shared by codeflare-pi.ts.
 *
 * Extracted into a helper with no node:child_process dependency so the guards can be
 * unit-tested directly in the Cloudflare Workers test pool. codeflare-pi.ts itself cannot
 * be imported under workerd (it pulls node:child_process for graphify), so the executable
 * guard logic lives here and codeflare-pi.ts composes it. The bypass file system access is
 * injected (BypassFs) so the consume-on-use path is testable without touching a real /tmp.
 */

export const LOCAL_BUILD_BYPASS = "/tmp/local-build-bypass";

type Heredoc = { value: string; stripTabs: boolean };

function heredocDeclarations(line: string): Heredoc[] {
  const declarations: Heredoc[] = [];
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "\\") { index += 1; continue; }
    if (char !== "<" || line[index + 1] !== "<" || line[index + 2] === "<") continue;

    let cursor = index + 2;
    const stripTabs = line[cursor] === "-";
    if (stripTabs) cursor += 1;
    while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;

    let value = "";
    let delimiterQuote = "";
    while (cursor < line.length) {
      const token = line[cursor] ?? "";
      if (delimiterQuote) {
        if (token === delimiterQuote) delimiterQuote = "";
        else if (token === "\\" && delimiterQuote === '"' && cursor + 1 < line.length) {
          cursor += 1;
          value += line[cursor] ?? "";
        } else value += token;
      } else if (token === "'" || token === '"') delimiterQuote = token;
      else if (token === "\\" && cursor + 1 < line.length) {
        cursor += 1;
        value += line[cursor] ?? "";
      } else if (/\s/.test(token) || ";&|<>".includes(token)) break;
      else value += token;
      cursor += 1;
    }
    if (value) declarations.push({ value, stripTabs });
    index = cursor - 1;
  }
  return declarations;
}

function withoutHeredocBodies(command: string): string {
  const executableLines: string[] = [];
  const pendingDelimiters: Heredoc[] = [];

  for (const line of command.split(/\r?\n/)) {
    const active = pendingDelimiters[0];
    if (active) {
      const candidate = active.stripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === active.value) pendingDelimiters.shift();
      continue;
    }

    executableLines.push(line);
    pendingDelimiters.push(...heredocDeclarations(line));
  }

  return executableLines.join('\n');
}

const COMMAND_PREFIXES = new Set(["command", "builtin", "exec", "sudo", "time", "env"]);
const CONTROL_WORDS = new Set(["if", "then", "elif", "else", "fi", "while", "until", "do", "!", "{"]);

/**
 * Returns argv for syntactically executable shell commands. Quoted arguments and
 * heredoc bodies stay inert, while command substitutions are scanned recursively.
 * This is intentionally a boundary parser, not a shell evaluator: authoritative
 * repository and PR state still decide whether a parsed candidate matters.
 */
export function executableShellCommands(command: string): string[][] {
  const commands: string[][] = [];

  const scan = (source: string): void => {
    let words: string[] = [];
    let word = "";
    let commandPosition = true;
    let prefix = false;

    const finishWord = () => {
      if (!word) return;
      const value = word;
      word = "";
      if (!commandPosition) {
        words.push(value);
        return;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(value) || CONTROL_WORDS.has(value)) return;
      words.push(value);
      if (COMMAND_PREFIXES.has(value)) {
        prefix = true;
        return;
      }
      if (prefix && value.startsWith("-")) return;
      commandPosition = false;
      prefix = false;
    };
    const finishCommand = () => {
      finishWord();
      if (words.length) commands.push(words);
      words = [];
      commandPosition = true;
      prefix = false;
    };
    const substitution = (start: number): number => {
      let depth = 1;
      let quote = "";
      let escaped = false;
      for (let index = start; index < source.length; index += 1) {
        const char = source[index] ?? "";
        if (escaped) { escaped = false; continue; }
        if (char === "\\" && quote !== "'") { escaped = true; continue; }
        if (quote) {
          if (char === quote) quote = "";
          continue;
        }
        if (char === "'" || char === '"') { quote = char; continue; }
        if (char === "(") depth += 1;
        else if (char === ")" && --depth === 0) {
          scan(source.slice(start, index));
          return index;
        }
      }
      return source.length;
    };

    for (let index = 0; index < source.length; index += 1) {
      const char = source[index] ?? "";
      if (char === "'") {
        for (index += 1; index < source.length && source[index] !== "'"; index += 1) word += source[index] ?? "";
        continue;
      }
      if (char === '"') {
        for (index += 1; index < source.length && source[index] !== '"'; index += 1) {
          if (source[index] === "\\" && index + 1 < source.length) word += source[++index] ?? "";
          else if (source[index] === "$" && source[index + 1] === "(") index = substitution(index + 2);
          else if (source[index] === "`") {
            const end = source.indexOf("`", index + 1);
            if (end === -1) { index = source.length; break; }
            scan(source.slice(index + 1, end));
            index = end;
          } else word += source[index] ?? "";
        }
        continue;
      }
      if (char === "\\" && index + 1 < source.length) { word += source[++index] ?? ""; continue; }
      if (char === "$" && source[index + 1] === "(") { index = substitution(index + 2); continue; }
      if (char === "`") {
        const end = source.indexOf("`", index + 1);
        if (end === -1) break;
        scan(source.slice(index + 1, end));
        index = end;
        continue;
      }
      if (/\s/.test(char) || ";&|(){}".includes(char)) {
        finishWord();
        if (";&|(){}\n\r".includes(char)) {
          finishCommand();
          if ((char === "&" || char === "|") && source[index + 1] === char) index += 1;
        }
        continue;
      }
      word += char;
    }
    finishCommand();
  };

  scan(withoutHeredocBodies(command));
  return commands;
}

export function shellCommandExecutable(words: string[]): string | undefined {
  let index = 0;
  while (index < words.length) {
    const value = words[index] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(value)) { index += 1; continue; }
    if (!COMMAND_PREFIXES.has(value)) return value;
    index += 1;
    while ((words[index] ?? "").startsWith("-")) index += 1;
  }
  return undefined;
}

export function shellCommandArguments(words: string[], executable: "git" | "gh"): string[] {
  const executableIndex = words.findIndex((word, index) => word === executable
    && shellCommandExecutable(words.slice(0, index + 1)) === executable);
  let index = executableIndex + 1;
  const takesValue = executable === "git"
    ? new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path", "--super-prefix"])
    : new Set(["-R", "--repo", "--hostname", "--config"]);
  while (executableIndex >= 0 && index > 0 && index < words.length) {
    const value = words[index] ?? "";
    if (value === "--") return words.slice(index + 1);
    if (!value.startsWith("-")) return words.slice(index);
    if (takesValue.has(value) && !value.includes("=")) index += 1;
    index += 1;
  }
  return [];
}

function operationAfterGlobalOptions(words: string[], executable: "git" | "gh"): string | undefined {
  return shellCommandArguments(words, executable)[0];
}

export function attributionBlockReason(command: string): string | undefined {
  const guarded = executableShellCommands(command).some((words) => {
    const gitOperation = operationAfterGlobalOptions(words, "git");
    const ghOperation = operationAfterGlobalOptions(words, "gh");
    return Boolean(gitOperation && ["commit", "merge", "tag", "notes"].includes(gitOperation))
      || Boolean(ghOperation && ["pr", "issue", "release"].includes(ghOperation));
  });
  if (!guarded) return undefined;
  // Match the canonical block-attributed-commits.sh detection set: genuine attribution
  // signatures only (co-author trailer, bot noreply email, generated-with footer, emoji,
  // ChatGPT). Deliberately NOT bare model/product names ("claude code", "claude opus"):
  // those false-positive on legitimate prose and on git/gh commands naming
  // preseed/agents/claude/ paths.
  if (/co-authored-by|noreply@anthropic|generated with[^\n]*claude|🤖|🧠|ChatGPT/i.test(command)) {
    return "Codeflare blocks AI attribution in commits, PRs, issues, releases, and tags. Remove Co-Authored-By, generated-by text, model-name attribution, and emoji attribution.";
  }
  return undefined;
}

const SAFE_LOCAL_CHECK_PATH = /^(?:~|\$HOME|\/home\/[^/]+)\/\.(?:claude\/skills|pi\/agent\/skills)\/safe-local-checks\/scripts\/safe-local-check\.mjs$/u;

function isSafeLocalCheckWords(words: string[]): boolean {
  if (shellCommandExecutable(words) !== "node") return false;
  const nodeIndex = words.findIndex((word) => word === "node");
  return nodeIndex >= 0 && SAFE_LOCAL_CHECK_PATH.test(words[nodeIndex + 1] ?? "");
}

export function isManagedSafeLocalCheckCommand(command: string): boolean {
  if (/[<>]/u.test(withoutHeredocBodies(command))) return false;
  const commands = executableShellCommands(command);
  if (commands.length === 1) return isSafeLocalCheckWords(commands[0] ?? []);
  return commands.length === 2
    && shellCommandExecutable(commands[0] ?? []) === "cd"
    && isSafeLocalCheckWords(commands[1] ?? []);
}

function invokesSafeLocalCheckWrapper(command: string): boolean {
  return executableShellCommands(command).some(isSafeLocalCheckWords);
}

function isDirectManagedCheck(words: string[]): boolean {
  const executable = shellCommandExecutable(words);
  if (!executable) return false;
  const executableIndex = words.findIndex((word, index) => word === executable
    && shellCommandExecutable(words.slice(0, index + 1)) === executable);
  const args = words.slice(executableIndex + 1);
  if (executable === "biome") return true;
  if (executable === "node") return args[0] === "--check";
  if (executable !== "npx") return false;

  let packageIndex = 0;
  while ((args[packageIndex] ?? "").startsWith("-")) {
    packageIndex += ["-p", "--package", "-c", "--call"].includes(args[packageIndex] ?? "") ? 2 : 1;
  }
  return /^biome(?:@|$)/u.test(args[packageIndex] ?? "");
}

export function isLocalBuildCommand(command: string): boolean {
  const executableCommand = withoutHeredocBodies(command);
  return /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|typecheck|dev)\b/.test(executableCommand)
    || /\b(pytest|vitest|go\s+test|swift\s+test|cargo\s+test|tsc|eslint|oxlint|prettier|wrangler\s+dev)\b/.test(executableCommand)
    || executableShellCommands(command).some(isDirectManagedCheck);
}

export interface BypassFs {
  existsSync(path: string): boolean;
  unlinkSync(path: string): void;
}

export function localBuildBlockReason(command: string, fs: BypassFs): string | undefined {
  if (isManagedSafeLocalCheckCommand(command)) return undefined;
  if (!isLocalBuildCommand(command) && !invokesSafeLocalCheckWrapper(command)) return undefined;
  // User-only escape hatch (consume-on-use), mirrors Claude's /tmp/local-build-bypass.
  if (fs.existsSync(LOCAL_BUILD_BYPASS)) {
    try {
      fs.unlinkSync(LOCAL_BUILD_BYPASS);
      return undefined;
    } catch { /* could not consume the sentinel; keep blocking so a stuck file cannot permanently disable the gate */ }
  }
  return "Direct local builds/tests/linters/dev servers are blocked. For bounded read-only lint or syntax checks, load the safe-local-checks skill and use its managed wrapper. Push and verify everything else with CI. User override: create /tmp/local-build-bypass.";
}

export default function () {
  // Helper module only; loaded by the Pi extension scanner as a no-op extension.
}
