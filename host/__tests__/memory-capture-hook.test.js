import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookScript = readFileSync(
  resolve(__dirname, '../../preseed/agents/claude/hooks/memory-capture.sh'),
  'utf8'
);

// ============================================================================
// Test: memory-capture.sh hook script structure
// ============================================================================
describe('memory-capture.sh hook script', () => {
  it('reads transcript_path from stdin JSON via jq', () => {
    assert.ok(
      hookScript.includes('transcript_path'),
      'hook should reference transcript_path from stdin JSON'
    );
    assert.ok(
      hookScript.includes('jq'),
      'hook should use jq to parse stdin JSON'
    );
  });

  it('reads session_id from stdin JSON', () => {
    assert.ok(
      hookScript.includes('session_id'),
      'hook should reference session_id from stdin JSON'
    );
  });

  it('counts user messages from transcript', () => {
    assert.ok(
      hookScript.includes('.type'),
      'hook should check .type field in transcript'
    );
    assert.ok(
      hookScript.includes('user'),
      'hook should filter for user message type'
    );
    assert.ok(
      hookScript.includes('grep -c'),
      'hook should use grep -c to count matches'
    );
  });

  it('uses counter file in ~/.memory/counter/ directory', () => {
    assert.ok(
      hookScript.includes('.memory/counter'),
      'hook should use .memory/counter directory for state'
    );
  });

  it('reads last_count and last_line_offset from counter file', () => {
    assert.ok(
      hookScript.includes('last_count'),
      'hook should read last_count from counter file'
    );
    assert.ok(
      hookScript.includes('last_line_offset'),
      'hook should read last_line_offset from counter file'
    );
  });

  it('defaults to 0 count and 1 offset when counter file missing', () => {
    // Should handle missing counter file gracefully
    assert.ok(
      hookScript.includes('0') && hookScript.includes('1'),
      'hook should have default values for missing counter'
    );
    // Check for explicit defaults
    assert.ok(
      /last_count[^=]*=.*0/.test(hookScript) || hookScript.includes(':-0'),
      'hook should default last_count to 0'
    );
  });

  it('exits when delta < 15 user messages', () => {
    assert.ok(
      hookScript.includes('15'),
      'hook should check threshold of 15 messages'
    );
    assert.ok(
      hookScript.includes('exit 0'),
      'hook should exit cleanly when threshold not met'
    );
  });

  it('checks for lock file before spawning agent', () => {
    assert.ok(
      hookScript.includes('.lock'),
      'hook should check for lock file'
    );
    // Should exit if lock exists
    assert.ok(
      hookScript.includes('exit 0'),
      'hook should exit if lock exists'
    );
  });

  it('creates lock file before spawning background agent', () => {
    // Lock creation must appear before claude-unleashed CLI spawn
    const lockCreateIdx = hookScript.indexOf('touch') !== -1
      ? hookScript.indexOf('touch')
      : hookScript.search(/>\s*.*\.lock/);
    const claudeIdx = hookScript.indexOf('claude-unleashed');
    assert.ok(lockCreateIdx > -1, 'hook should create lock file');
    assert.ok(claudeIdx > -1, 'hook should invoke claude-unleashed CLI');
    assert.ok(
      lockCreateIdx < claudeIdx,
      'lock file creation must occur before claude-unleashed CLI spawn'
    );
  });

  it('spawns claude-unleashed CLI with sonnet model and --print flag', () => {
    assert.ok(
      hookScript.includes('claude-unleashed --model sonnet'),
      'hook should invoke claude-unleashed with sonnet model'
    );
    assert.ok(
      hookScript.includes('--print'),
      'hook should use --print flag for non-interactive mode'
    );
  });

  it('limits agent turns with --max-turns', () => {
    assert.ok(
      hookScript.includes('--max-turns'),
      'hook should limit agent turns'
    );
  });

  it('records current line count for offset tracking', () => {
    assert.ok(
      hookScript.includes('wc -l'),
      'hook should use wc -l to count transcript lines'
    );
  });

  it('runs claude-unleashed agent in background (nohup + &)', () => {
    assert.ok(
      /nohup\s+claude-unleashed\b/.test(hookScript),
      'hook should run claude-unleashed via nohup'
    );
    assert.ok(
      /claude-unleashed[^&]*&/.test(hookScript),
      'hook should background the claude-unleashed process'
    );
  });

  it('agent prompt includes mcp__memory__add_observations', () => {
    assert.ok(
      hookScript.includes('add_observations') || hookScript.includes('create_entities'),
      'agent prompt should reference MCP memory tools'
    );
  });

  it('agent prompt includes chat-YYYY-MM-DD entity naming', () => {
    assert.ok(
      hookScript.includes('chat-'),
      'agent prompt should reference chat- entity naming pattern'
    );
  });

  it('removes lock file after agent completes', () => {
    // Lock removal should be in the background block
    const lockRemovePattern = /rm\s+(-f\s+)?\$.*\.lock|rm\s+(-f\s+)?".*\.lock/;
    assert.ok(
      lockRemovePattern.test(hookScript),
      'hook should remove lock file after agent completes'
    );
  });

  it('updates counter file on success with new count and offset', () => {
    // Should write to counter file after successful agent run
    assert.ok(
      hookScript.includes('COUNTER_FILE'),
      'hook should reference COUNTER_FILE for updates'
    );
  });
});
