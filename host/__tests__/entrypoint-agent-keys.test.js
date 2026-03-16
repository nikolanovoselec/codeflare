import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

// Helper: extract a bash function body from entrypoint.sh
function extractFunction(name) {
  const start = entrypoint.indexOf(`${name}() {`);
  if (start === -1) return null;
  let depth = 0;
  let i = entrypoint.indexOf('{', start);
  const begin = i;
  for (; i < entrypoint.length; i++) {
    if (entrypoint[i] === '{') depth++;
    else if (entrypoint[i] === '}') depth--;
    if (depth === 0) break;
  }
  return entrypoint.slice(begin, i + 1);
}

// ============================================================================
// Test: consult-llm MCP gated on CONSULT_LLM_ENABLED preference
// ============================================================================
describe('consult-llm MCP gate', () => {
  it('consult-llm block is gated on CONSULT_LLM_ENABLED=true', () => {
    // The condition should check CONSULT_LLM_ENABLED, not just key presence
    assert.ok(
      entrypoint.includes('CONSULT_LLM_ENABLED'),
      'entrypoint should reference CONSULT_LLM_ENABLED env var'
    );
    // Should require CONSULT_LLM_ENABLED=true AND at least one key
    assert.ok(
      entrypoint.includes('"${CONSULT_LLM_ENABLED:-false}" = "true"'),
      'consult-llm should be gated on CONSULT_LLM_ENABLED=true (default false)'
    );
  });

  it('ANTHROPIC_API_KEY is NOT passed to consult-llm MCP env', () => {
    // Find the consult-llm config section
    const consultStart = entrypoint.indexOf('CONSULT_LLM_ENABLED');
    const consultEnd = entrypoint.indexOf('consult-llm MCP server configured', consultStart);
    if (consultStart === -1 || consultEnd === -1) {
      assert.fail('Could not find consult-llm configuration section');
    }
    const consultSection = entrypoint.slice(consultStart, consultEnd);
    assert.ok(
      !consultSection.includes('ANTHROPIC_API_KEY'),
      'consult-llm MCP env should NOT include ANTHROPIC_API_KEY (it is for the agent itself, not for cross-LLM consultation)'
    );
  });
});

// ============================================================================
// Test: Codex pre-authentication via OPENAI_API_KEY
// ============================================================================
describe('Codex pre-auth', () => {
  it('pipes OPENAI_API_KEY to codex login --with-api-key', () => {
    assert.ok(
      entrypoint.includes('codex login --with-api-key'),
      'entrypoint should pipe OPENAI_API_KEY to codex login --with-api-key'
    );
  });
});

// ============================================================================
// Test: Rclone SSE-C encryption config
// ============================================================================
describe('rclone SSE-C config', () => {
  const rcloneConfigFn = extractFunction('create_rclone_config');

  it('appends sse_customer_key when R2_ENCRYPTION_KEY is set', () => {
    assert.ok(rcloneConfigFn, 'create_rclone_config function should exist');
    assert.ok(
      rcloneConfigFn.includes('sse_customer_key'),
      'rclone config should include sse_customer_key when R2_ENCRYPTION_KEY is set'
    );
  });

  it('appends sse_customer_key_md5 when R2_ENCRYPTION_KEY is set', () => {
    assert.ok(rcloneConfigFn, 'create_rclone_config function should exist');
    assert.ok(
      rcloneConfigFn.includes('sse_customer_key_md5'),
      'rclone config should include sse_customer_key_md5 when R2_ENCRYPTION_KEY is set'
    );
  });

  it('SSE-C config is conditional on R2_ENCRYPTION_KEY', () => {
    assert.ok(rcloneConfigFn, 'create_rclone_config function should exist');
    assert.ok(
      rcloneConfigFn.includes('R2_ENCRYPTION_KEY'),
      'SSE-C config should be gated on R2_ENCRYPTION_KEY env var'
    );
  });
});

// ============================================================================
// Test: Credential file exclusion from rclone sync
// ============================================================================
describe('credential file exclusion', () => {
  it('excludes .claude/.credentials.json when ANTHROPIC_API_KEY set', () => {
    assert.ok(
      entrypoint.includes('.claude/.credentials.json'),
      'should exclude .claude/.credentials.json from sync when ANTHROPIC_API_KEY is set'
    );
    // Verify it's conditional on ANTHROPIC_API_KEY
    const idx = entrypoint.indexOf('.claude/.credentials.json');
    const preceding = entrypoint.slice(Math.max(0, idx - 200), idx);
    assert.ok(
      preceding.includes('ANTHROPIC_API_KEY'),
      '.claude/.credentials.json exclusion should be conditional on ANTHROPIC_API_KEY'
    );
  });

  it('excludes .codex/auth.json when OPENAI_API_KEY set', () => {
    // Find the conditional exclusion (not the static sync inclusion)
    const filterIdx = entrypoint.indexOf('RCLONE_FILTERS_COMMON+=');
    assert.ok(filterIdx !== -1, 'should have conditional RCLONE_FILTERS_COMMON appends');
    const filterSection = entrypoint.slice(filterIdx);
    assert.ok(
      filterSection.includes('.codex/auth.json'),
      'should exclude .codex/auth.json from sync when OPENAI_API_KEY is set'
    );
  });

  it('excludes .gemini/oauth_creds.json when GEMINI_API_KEY set', () => {
    assert.ok(
      entrypoint.includes('.gemini/oauth_creds.json'),
      'should exclude .gemini/oauth_creds.json from sync when GEMINI_API_KEY is set'
    );
    const idx = entrypoint.indexOf('.gemini/oauth_creds.json');
    const preceding = entrypoint.slice(Math.max(0, idx - 200), idx);
    assert.ok(
      preceding.includes('GEMINI_API_KEY'),
      '.gemini/oauth_creds.json exclusion should be conditional on GEMINI_API_KEY'
    );
  });
});
