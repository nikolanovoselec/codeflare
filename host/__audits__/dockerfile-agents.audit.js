// Structural audit: verifies REQ-AGENT-001 (AC3, AC4) and REQ-AGENT-017 (AC1, AC2)
// by reading the Dockerfile at the repo root and asserting canonical patterns.
// These are build-time facts that can only be verified by inspecting the source —
// there is no runtime observable without building the image (forbidden locally, resource-constrained).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf8');

// ─── REQ-AGENT-001: Support Multiple AI Coding Agents ────────────────────────

describe('Dockerfile agent CLI pre-install (REQ-AGENT-001)', () => {
  it('REQ-AGENT-001 AC3: installs claude-code globally via npm', () => {
    assert.ok(
      /npm install -g[^\n]*@anthropic-ai\/claude-code/.test(dockerfile),
      'Dockerfile must `npm install -g @anthropic-ai/claude-code` to pre-install the Claude Code CLI'
    );
  });

  it('REQ-AGENT-001 AC3: installs codex globally via npm', () => {
    assert.ok(
      /npm install -g[^\n]*@openai\/codex/.test(dockerfile),
      'Dockerfile must `npm install -g @openai/codex` to pre-install the Codex CLI'
    );
  });

  it('REQ-AGENT-001 AC3: installs antigravity via curl (Go-native, not npm)', () => {
    assert.ok(
      /curl -fsSL https:\/\/antigravity\.google\/cli\/install\.sh \| bash/.test(dockerfile),
      'Dockerfile must `curl ... antigravity.google/cli/install.sh | bash` to install the Antigravity (agy) CLI'
    );
  });

  it('REQ-AGENT-001 AC4: antigravity (agy) is Go-native and excluded from the npm agent-install line and V8 warmup', () => {
    const installLine = dockerfile.match(/npm install -g[^\n]+/);
    assert.ok(installLine, 'Dockerfile must have an npm install -g agent line');
    assert.ok(
      !/agy|antigravity/.test(installLine[0]),
      'agy/antigravity must NOT appear in the npm install -g line (it is curl-installed, like opencode)'
    );
  });

  it('REQ-AGENT-001 AC3: installs copilot globally via npm', () => {
    assert.ok(
      /npm install -g[^\n]*@github\/copilot/.test(dockerfile),
      'Dockerfile must `npm install -g @github/copilot` to pre-install the Copilot CLI'
    );
  });

  it('REQ-AGENT-001 AC3: installs opencode-ai globally via npm', () => {
    assert.ok(
      /npm install -g[^\n]*opencode-ai/.test(dockerfile),
      'Dockerfile must `npm install -g opencode-ai` to pre-install the OpenCode CLI'
    );
  });

  it('REQ-AGENT-001 AC4: NODE_COMPILE_CACHE env var is set in the image', () => {
    assert.ok(
      /ENV NODE_COMPILE_CACHE=/.test(dockerfile),
      'Dockerfile must set ENV NODE_COMPILE_CACHE= to enable V8 bytecode caching for Node.js CLIs'
    );
  });

  it('REQ-AGENT-001 AC4: codex --version is run at build time to warm V8 compile cache', () => {
    assert.ok(
      /codex --version/.test(dockerfile),
      'Dockerfile must run `codex --version` at build time to trigger V8 compile cache warm-up'
    );
  });

  it('REQ-AGENT-001 AC4: copilot --version is run at build time to warm V8 compile cache', () => {
    assert.ok(
      /copilot --version/.test(dockerfile),
      'Dockerfile must run `copilot --version` at build time to trigger V8 compile cache warm-up'
    );
  });

  it('REQ-AGENT-001 AC4: Go (natively compiled) agents (opencode, antigravity) need no --version warmup', () => {
    // The spec says Go-based agents are natively compiled and need no V8 warmup.
    // Verify the comment is present to document the intentional omission.
    assert.ok(
      /Go[\s\S]{1,200}natively compiled/.test(dockerfile),
      'Dockerfile must document that Go-based agents (opencode, antigravity) are natively compiled and skip V8 warmup'
    );
  });

  it('REQ-AGENT-001 AC4: claude is identified as a native binary - no V8 warmup in same block as codex/copilot', () => {
    // claude-code is a native binary; the warmup RUN block must not include `claude --version`
    // alongside the Node CLIs. Check that `claude --version` appears separately (its own RUN).
    const compileBlockMatch = dockerfile.match(
      /V8 compile cache[\s\S]{1,2000}copilot --version/
    );
    assert.ok(compileBlockMatch !== null, 'Must have a V8 compile cache warmup block ending with copilot --version');
    const compileBlock = compileBlockMatch![0];
    assert.ok(
      !compileBlock.includes('claude --version') || compileBlock.indexOf('claude --version') > compileBlock.indexOf('copilot --version'),
      'claude --version must NOT appear in the Node CLI V8 warmup RUN block (it is a native binary)'
    );
  });
});

// ─── REQ-AGENT-017: Bubblewrap sandbox for Codex ────────────────────────────

describe('Dockerfile bubblewrap install (REQ-AGENT-017)', () => {
  it('REQ-AGENT-017 AC1: bubblewrap package is installed in the container image', () => {
    assert.ok(
      /bubblewrap/.test(dockerfile),
      'Dockerfile must install the `bubblewrap` package for Codex sandbox isolation'
    );
  });

  it('REQ-AGENT-017 AC1: bubblewrap install appears in an apt-get install block', () => {
    // Cross-line pattern: bubblewrap must appear within an apt-get install invocation
    assert.ok(
      /apt-get install[\s\S]{1,2000}bubblewrap/.test(dockerfile),
      'Dockerfile must install bubblewrap via apt-get install (not a separate mechanism)'
    );
  });

  it('REQ-AGENT-017 AC2: Dockerfile documents bubblewrap as sandbox for Codex', () => {
    assert.ok(
      /[Ss]andbox[\s\S]{0,60}[Cc]odex|[Cc]odex[\s\S]{0,60}[Ss]andbox/.test(dockerfile),
      'Dockerfile must include a comment associating bubblewrap with Codex sandbox execution'
    );
  });
});
