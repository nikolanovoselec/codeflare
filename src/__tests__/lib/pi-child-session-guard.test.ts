import { describe, it, expect } from 'vitest';
import { isChildSessionHeader, isChildSessionFirstLine } from '../../../preseed/agents/pi/extensions/memory-vault-helpers';

/**
 * REQ-MEM-001 / REQ-VAULT-003 — Pi memory/vault automation must be inert inside
 * subagent child sessions.
 *
 * @gotgenes/pi-subagents children (review-monitor, CI monitors, memory-capture,
 * vault-extract, ...) always load the parent's extensions, so memory-vault.ts runs
 * inside them too. Its sendUserMessage("Agent(...)") fallback, injected into a
 * monitor child's transcript, became that task's last visible output (a
 * review-monitor "result" showing vault extraction instead of REVIEW_RESULT).
 * Children are identified by the parentSession pointer pi-subagents passes to
 * newSession(), persisted in the session-header first line of the session JSONL.
 * These tests fail if the child-detection predicates regress (e.g. accepting a
 * root header, or trusting a non-header JSONL line).
 */
// REQ-MEM-015: Pi Memory Capture Transcript Source and Child-Session Guard

describe('isChildSessionHeader', () => {
  it('detects a child session from a header carrying a parent-session pointer', () => {
    expect(isChildSessionHeader({ type: 'session', id: 'c1', parentSession: '/sessions/parent.jsonl' })).toBe(true);
  });

  it('treats a root-session header (no parentSession) as not-a-child', () => {
    expect(isChildSessionHeader({ type: 'session', id: 'r1', timestamp: 't', cwd: '/x' })).toBe(false);
  });

  it('treats an empty parentSession as not-a-child', () => {
    expect(isChildSessionHeader({ type: 'session', id: 'r1', parentSession: '' })).toBe(false);
  });

  it('treats a non-string parentSession as not-a-child', () => {
    expect(isChildSessionHeader({ type: 'session', id: 'r1', parentSession: 42 })).toBe(false);
  });

  it('treats missing/undefined/non-object headers as not-a-child (fail-open to root behavior)', () => {
    expect(isChildSessionHeader(undefined)).toBe(false);
    expect(isChildSessionHeader(null)).toBe(false);
    expect(isChildSessionHeader('session')).toBe(false);
  });
});

describe('isChildSessionFirstLine', () => {
  it('detects a child session from the persisted session-header line', () => {
    const line = JSON.stringify({ type: 'session', version: 3, id: 'c1', timestamp: 't', cwd: '/x', parentSession: 'parent-id' });
    expect(isChildSessionFirstLine(line)).toBe(true);
  });

  it('treats a root session-header line as not-a-child', () => {
    const line = JSON.stringify({ type: 'session', version: 3, id: 'r1', timestamp: 't', cwd: '/x' });
    expect(isChildSessionFirstLine(line)).toBe(false);
  });

  it('requires the header entry type — a message entry naming parentSession is not a header', () => {
    const line = JSON.stringify({ type: 'message', parentSession: 'spoof', message: { role: 'user', content: [] } });
    expect(isChildSessionFirstLine(line)).toBe(false);
  });

  it('treats unparseable or empty first lines as not-a-child (fail-open to root behavior)', () => {
    expect(isChildSessionFirstLine('not json {')).toBe(false);
    expect(isChildSessionFirstLine('')).toBe(false);
    expect(isChildSessionFirstLine(undefined)).toBe(false);
  });
});
