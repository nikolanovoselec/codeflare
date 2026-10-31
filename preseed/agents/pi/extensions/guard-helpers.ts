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
      // `&` is control syntax on its own, but is part of a descriptor
      // duplication when immediately preceded by `<` or `>` (for example
      // `2>&1`). Keep that form in one token so downstream policy can discard
      // the redirection instead of inventing a second command.
      const redirectionAmpersand = char === "&" && (source[index - 1] === ">" || source[index - 1] === "<");
      if (!redirectionAmpersand && (/\s/.test(char) || ";&|(){}".includes(char))) {
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

function topLevelShellSeparators(command: string): string[] {
  const source = withoutHeredocBodies(command);
  const separators: string[] = [];
  const skipSubstitution = (start: number): number => {
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
      else if (char === ")" && --depth === 0) return index;
    }
    return source.length;
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (char === "\\") { index += 1; continue; }
    if (char === "'" || char === '"') {
      const quote = char;
      for (index += 1; index < source.length && source[index] !== quote; index += 1) {
        if (quote === '"' && source[index] === "\\") index += 1;
      }
      continue;
    }
    if (char === "`") {
      for (index += 1; index < source.length && source[index] !== "`"; index += 1) {
        if (source[index] === "\\") index += 1;
      }
      continue;
    }
    if (char === "$" && source[index + 1] === "(") {
      index = skipSubstitution(index + 2);
      continue;
    }
    if (char === "&" || char === "|") {
      const separator = source[index + 1] === char ? `${char}${char}` : char;
      separators.push(separator);
      if (separator.length === 2) index += 1;
    } else if (char === ";" || char === "\n" || char === "\r" || "(){}".includes(char)) {
      separators.push(char);
    }
  }
  return separators;
}

export function isManagedSafeLocalCheckCommand(command: string): boolean {
  if (/[<>]/u.test(withoutHeredocBodies(command))) return false;
  const commands = executableShellCommands(command);
  if (commands.length === 1) return isSafeLocalCheckWords(commands[0] ?? []);
  const separators = topLevelShellSeparators(command);
  return commands.length === 2
    && separators.length === 1
    && separators[0] === "&&"
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
  if (executable.split("/").at(-1) === "biome") return true;
  if (executable === "node") return args[0] === "--check";
  if (executable !== "npx") return false;

  const callIndex = args.findIndex((argument) => argument === "-c" || argument === "--call");
  const assignedCall = args.find((argument) => argument.startsWith("--call="));
  const call = assignedCall?.slice("--call=".length) ?? (callIndex >= 0 ? args[callIndex + 1] : undefined);
  if (call && executableShellCommands(call).some(isDirectManagedCheck)) return true;

  let packageIndex = 0;
  while ((args[packageIndex] ?? "").startsWith("-")) {
    packageIndex += ["-p", "--package", "-c", "--call"].includes(args[packageIndex] ?? "") ? 2 : 1;
  }
  return /^(?:biome|@biomejs\/biome)(?:@|$)/u.test(args[packageIndex] ?? "");
}

const LOCAL_CHECK_RUNNER = /^(?:pytest|vitest|tsc|eslint|oxlint|prettier)(?:\.(?:[cm]?js|py))?$/u;

export function isLocalBuildCommand(command: string): boolean {
  // Non-shell ctx_* programs can launch subprocesses too. Preserve conservative
  // runner detection for process-launch source, without treating package-name
  // arrays used for metadata fetches as shell execution.
  if (/\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|system|Popen)\s*\(/u.test(command)
    && (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|typecheck|dev)\b/u.test(command)
      || /\b(pytest|vitest|go\s+test|swift\s+test|cargo\s+test|tsc|eslint|oxlint|prettier|wrangler\s+dev)\b/u.test(command))) return true;
  return executableShellCommands(command).some((words) => {
    if (isDirectManagedCheck(words)) return true;
    const executable = shellCommandExecutable(words);
    if (!executable) return false;
    const index = words.indexOf(executable);
    const args = words.slice(index + 1);
    const binary = executable.split("/").at(-1) ?? executable;
    if (["pytest", "vitest", "tsc", "eslint", "oxlint", "prettier"].includes(binary)) return true;
    if (["npm", "pnpm", "yarn", "bun"].includes(binary)) {
      const operation = args[0] === "run" ? args[1] : args[0];
      return /^(?:build|test|lint|typecheck|dev)\b/u.test(operation ?? "")
        || LOCAL_CHECK_RUNNER.test(operation ?? "")
        || (["exec", "dlx", "x"].includes(args[0] ?? "") && isLocalBuildCommand(args.slice(1).join(" ")));
    }
    if (["go", "swift", "cargo"].includes(binary)) return args[0] === "test";
    if (binary === "wrangler") return args[0] === "dev";
    if (binary === "npx") {
      // npx can place package-selection flags before the executable. Keep the
      // runner allowlist guarded even when those options precede it.
      const call = args.findIndex((arg) => arg === "-c" || arg === "--call");
      const assigned = args.find((arg) => arg.startsWith("--call="));
      return (call >= 0 && isLocalBuildCommand(args[call + 1] ?? ""))
        || Boolean(assigned && isLocalBuildCommand(assigned.slice("--call=".length)))
        || args.some((arg) => /^(?:pytest|vitest|tsc|eslint|oxlint|prettier|wrangler)(?:@[^/\s]+)?$/u.test(arg))
        || isLocalBuildCommand(args.join(" "));
    }
    // Shell/interpreter source is executable, unlike ordinary command arguments
    // (Git pathspecs, cd targets, package-name arrays, or echoed documentation).
    if (["sh", "bash", "dash", "zsh"].includes(binary)) {
      const script = args.findIndex((arg) => /^-[^-]*c/u.test(arg));
      return script >= 0 && isLocalBuildCommand(args[script + 1] ?? "");
    }
    if (["node", "python", "python3"].includes(binary)) {
      const script = args.findIndex((arg) => ["-e", "--eval", "-c"].includes(arg));
      if (script >= 0) return isLocalBuildCommand(args[script + 1] ?? "");
      // Known runner entrypoints remain execution when launched by an interpreter;
      // do not scan ordinary script arguments as if they were shell commands.
      if (binary !== "node" && args[0] === "-m") return args[1] === "pytest";
      let entrypointIndex = 0;
      const valueOptions = binary === "node"
        ? ["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "--env-file-if-exists"]
        : ["-W", "-X"];
      while ((args[entrypointIndex] ?? "").startsWith("-")) {
        const option = args[entrypointIndex++];
        if (valueOptions.includes(option ?? "")) entrypointIndex += 1;
      }
      return LOCAL_CHECK_RUNNER.test(args[entrypointIndex]?.split("/").at(-1) ?? "");
    }
    // Metadata/data arguments are inert; substitutions were already parsed as
    // their own commands. Do not grant the same exemption to unknown wrappers.
    if (binary === "git") {
      // Inline shell aliases execute source; ordinary Git pathspecs remain data.
      return args.some((arg) => /^(?:-c)?alias\.[^=]+=!/u.test(arg)
        && isLocalBuildCommand(arg.slice(arg.indexOf("=!") + 2)));
    }
    if (["cd", "printf", "echo", "cat", "const", "let", "var"].includes(binary)) return false;
    // Quoted shell source passed to exec()/execSync()/system() is emitted by
    // the boundary parser as one executable word, not separate argv tokens.
    return (/\s/u.test(executable) && isLocalBuildCommand(executable))
      || args.some((arg) => isLocalBuildCommand(arg))
      || (args.length > 1 && isLocalBuildCommand(args.join(" ")));
  });
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
