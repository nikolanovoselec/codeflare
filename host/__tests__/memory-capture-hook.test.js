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

describe('memory-capture.sh hook script', () => {
  it('exits early when stop_hook_active is true (prevents loops)', () => {
    assert.ok(
      hookScript.includes('stop_hook_active'),
      'hook should check stop_hook_active to prevent infinite loops'
    );
  });

  it('reads transcript_path and session_id from stdin JSON via jq', () => {
    assert.ok(hookScript.includes('transcript_path'));
    assert.ok(hookScript.includes('session_id'));
    assert.ok(hookScript.includes('jq'));
  });

  it('expands tilde in transcript path', () => {
    assert.ok(
      hookScript.includes('/#\\~/$USER_HOME'),
      'hook should expand ~ to $USER_HOME in transcript path'
    );
  });

  it('counts user messages from transcript', () => {
    assert.ok(hookScript.includes('.type'));
    assert.ok(hookScript.includes('grep -c'));
  });

  it('uses counter file in ~/.memory/counter/', () => {
    assert.ok(hookScript.includes('.memory/counter'));
  });

  it('reads last_count and last_line from counter file', () => {
    assert.ok(hookScript.includes('last_count'));
    assert.ok(hookScript.includes('last_line'));
  });

  it('exits when delta < 15 user messages', () => {
    assert.ok(hookScript.includes('15'));
    assert.ok(hookScript.includes('exit 0'));
  });

  it('checks for lock file before triggering', () => {
    assert.ok(hookScript.includes('.lock'));
  });

  it('outputs a reminder for the main agent (not spawning its own process)', () => {
    // Should NOT contain nohup or claude-unleashed
    assert.ok(
      !hookScript.includes('nohup'),
      'hook should not spawn processes with nohup'
    );
    assert.ok(
      !hookScript.includes('claude-unleashed'),
      'hook should not spawn claude-unleashed — main agent handles it'
    );
    // Should output instructions via cat/echo
    assert.ok(
      hookScript.includes('cat <<') || hookScript.includes('echo'),
      'hook should output a reminder message for the main agent'
    );
  });

  it('reminder includes transcript path, line offset, date, and counter paths', () => {
    // The output block should reference key variables
    assert.ok(hookScript.includes('TRANSCRIPT'));
    assert.ok(hookScript.includes('last_line'));
    assert.ok(hookScript.includes('TODAY'));
    assert.ok(hookScript.includes('COUNTER_FILE'));
    assert.ok(hookScript.includes('LOCK_FILE'));
  });

  it('reminder tells agent to create lock before spawning and remove when done', () => {
    assert.ok(
      hookScript.includes('LOCK_FILE') && hookScript.includes('rm'),
      'reminder should instruct agent to manage lock file lifecycle'
    );
  });
});
