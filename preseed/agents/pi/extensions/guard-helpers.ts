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

export function attributionBlockReason(command: string): string | undefined {
  if (!/(^|[;&|]\s*)(git\s+(commit|merge|tag|notes)|gh\s+(pr|issue|release)\s+\w+)\b/.test(command)) return undefined;
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

export function isLocalBuildCommand(command: string): boolean {
  return /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|lint|typecheck|dev)\b/.test(command)
    || /\b(pytest|vitest|go\s+test|swift\s+test|cargo\s+test|tsc|eslint|oxlint|prettier|wrangler\s+dev)\b/.test(command);
}

export interface BypassFs {
  existsSync(path: string): boolean;
  unlinkSync(path: string): void;
}

export function localBuildBlockReason(command: string, fs: BypassFs): string | undefined {
  if (!isLocalBuildCommand(command)) return undefined;
  // User-only escape hatch (consume-on-use), mirrors Claude's /tmp/local-build-bypass.
  if (fs.existsSync(LOCAL_BUILD_BYPASS)) {
    try {
      fs.unlinkSync(LOCAL_BUILD_BYPASS);
      return undefined;
    } catch { /* could not consume the sentinel; keep blocking so a stuck file cannot permanently disable the gate */ }
  }
  return "Local builds/tests/linters/dev servers are blocked in the 1-CPU container. Push and verify with CI instead. User override: create /tmp/local-build-bypass.";
}

export default function () {
  // Helper module only; loaded by the Pi extension scanner as a no-op extension.
}
