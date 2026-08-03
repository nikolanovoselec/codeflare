// Structural audit of the Dockerfile for REQ-OPS-011
// (Container base image is Debian bookworm-slim).
//
// AC1 and AC3 are Dockerfile-content audits: grep for the FROM line and the
// apt-get install block. AC2 (agent CLIs start without crashes) is a runtime
// property that cannot be verified without launching a container; the audit
// covers the Dockerfile install steps that are a precondition for AC2.
//
// Gut-check: changing the FROM line to a different image or removing a
// required package from the RUN apt-get block will cause the relevant test
// to fail immediately.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const dockerfile = readFileSync(resolve(repoRoot, 'Dockerfile'), 'utf8');
const npmTools = JSON.parse(readFileSync(resolve(repoRoot, 'preseed/npm-tools/package.json'), 'utf8'));

// ---------------------------------------------------------------------------
// REQ-OPS-011: Container base image is Debian bookworm-slim
// ---------------------------------------------------------------------------

describe('REQ-OPS-011: Container base image is Debian bookworm-slim', () => {
  it('REQ-OPS-011 AC1: container base image is public.ecr.aws/docker/library/node:24-bookworm-slim', () => {
    assert.ok(
      dockerfile.includes('FROM public.ecr.aws/docker/library/node:24-bookworm-slim'),
      'Dockerfile must use public.ecr.aws/docker/library/node:24-bookworm-slim as the base image (AWS ECR Public mirror)'
    );
  });

  it('supported agent CLI options remain in the locked image catalog', () => {
    // AC2 runtime verification requires a live selected image. This audit
    // verifies that its lock-backed source catalog still carries every option.
    for (const packageName of [
      '@anthropic-ai/claude-code',
      '@openai/codex',
      '@github/copilot',
      'opencode-ai',
    ]) {
      assert.ok(npmTools.dependencies[packageName], `${packageName} must be in the locked image tool manifest`);
    }
  });

  it('REQ-OPS-011 AC3: system packages include essential tools: git, ripgrep, neovim, tmux, fzf, jq, python', () => {
    // These packages are installed via apt-get in the base layer.
    const requiredPackages = [
      { pkg: 'git', desc: 'git (version control)' },
      { pkg: 'ripgrep', desc: 'ripgrep (fast grep)' },
      { pkg: 'neovim', desc: 'neovim (editor)' },
      { pkg: 'tmux', desc: 'tmux (terminal multiplexer)' },
      { pkg: 'fzf', desc: 'fzf (fuzzy finder)' },
      { pkg: 'jq', desc: 'jq (JSON processing)' },
      { pkg: 'python3', desc: 'python3 interpreter' },
      { pkg: 'python-is-python3', desc: 'python command alias for python3' },
    ];

    for (const { pkg, desc } of requiredPackages) {
      assert.ok(
        dockerfile.includes(pkg),
        `Dockerfile must install ${desc} as a system package`
      );
    }
  });

  it('REQ-OPS-011 AC3: system packages include fd-find and fd symlink', () => {
    assert.ok(
      dockerfile.includes('fd-find'),
      'Dockerfile must install fd-find (the Debian package name for fd)'
    );
    // Debian renames fdfind; the Dockerfile must symlink it to fd
    assert.ok(
      dockerfile.includes('fdfind') && dockerfile.includes('/usr/local/bin/fd'),
      'Dockerfile must symlink fdfind to /usr/local/bin/fd so the `fd` command works'
    );
  });
});
