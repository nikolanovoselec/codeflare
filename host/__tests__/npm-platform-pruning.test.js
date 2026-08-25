import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const script = resolve(import.meta.dirname, '../../scripts/ci/prune-npm-platform-artifacts.mjs');

function packageDirectory(root, scope, name, bytes = 16) {
  const directory = scope ? join(root, scope, name) : join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'payload'), Buffer.alloc(bytes, 1));
  return directory;
}

describe('REQ-OPS-040: Linux coding-agent package pruning', () => {
  it('removes alternate platform payloads and preserves canonical Linux x64 launchers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-platform-prune-'));
    try {
      const nodeModules = join(directory, 'node_modules');
      const keep = [
        packageDirectory(nodeModules, '@anthropic-ai', 'claude-code'),
        packageDirectory(nodeModules, '@anthropic-ai', 'claude-code-linux-x64'),
        packageDirectory(nodeModules, '@github', 'copilot'),
        packageDirectory(nodeModules, '@github', 'copilot-linux-x64'),
        packageDirectory(nodeModules, '@openai', 'codex'),
        packageDirectory(nodeModules, '@openai', 'codex-linux-x64'),
        packageDirectory(nodeModules, '', 'opencode-ai'),
        packageDirectory(nodeModules, '', 'opencode-linux-x64'),
        packageDirectory(nodeModules, '@oxlint', 'binding-linux-x64-gnu'),
      ];
      const remove = [
        packageDirectory(nodeModules, '@anthropic-ai', 'claude-code-linux-x64-musl', 32),
        packageDirectory(nodeModules, '@anthropic-ai', 'claude-code-darwin-arm64', 32),
        packageDirectory(nodeModules, '@github', 'copilot-linuxmusl-x64', 32),
        packageDirectory(nodeModules, '@github', 'copilot-win32-x64', 32),
        packageDirectory(nodeModules, '@openai', 'codex-darwin-x64', 32),
        packageDirectory(nodeModules, '', 'opencode-linux-x64-baseline', 32),
        packageDirectory(nodeModules, '', 'opencode-linux-x64-musl', 32),
        packageDirectory(nodeModules, '', 'opencode-windows-x64', 32),
        packageDirectory(nodeModules, '@oxlint', 'binding-linux-x64-musl', 32),
        packageDirectory(nodeModules, '@oxlint', 'binding-darwin-arm64', 32),
      ];

      const result = spawnSync(process.execPath, [script, nodeModules], { encoding: 'utf8' });

      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report.removed.sort(), remove.map((path) => path.slice(nodeModules.length + 1)).sort());
      assert.equal(report.bytesRemoved, 32 * remove.length);
      for (const path of keep) assert.equal(existsSync(path), true, `must preserve ${path}`);
      for (const path of remove) assert.equal(existsSync(path), false, `must remove ${path}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
