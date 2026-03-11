import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const HOST_DIR = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(HOST_DIR, 'src');

/**
 * Security-focused tests for the host terminal server.
 * These verify security hardening by inspecting source code text
 * and checking module structure after the M6 extraction.
 *
 * Source inspection reads .ts files from src/; dynamic imports use dist/.
 */

describe('Security hardening', () => {
  // L16: PREWARM_SESSION_ID constant
  it('defines PREWARM_SESSION_ID constant and uses it consistently', () => {
    // After extraction, session-manager.ts should define the constant
    const sessionManagerSrc = fs.readFileSync(path.join(SRC_DIR, 'session-manager.ts'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(SRC_DIR, 'server.ts'), 'utf8');

    // The constant must be defined somewhere
    const allSrc = sessionManagerSrc + serverSrc;
    assert.ok(
      allSrc.includes("PREWARM_SESSION_ID"),
      'PREWARM_SESSION_ID constant must be defined'
    );

    // No raw 'prewarm-1' string literals should remain (except in the constant definition itself)
    // Check server.ts for raw literals
    const serverLines = serverSrc.split('\n');
    const rawLiterals = serverLines.filter(line =>
      line.includes("'prewarm-1'") && !line.includes('PREWARM_SESSION_ID')
    );
    assert.equal(
      rawLiterals.length, 0,
      `server.ts should not have raw 'prewarm-1' literals, found: ${rawLiterals.join('\n')}`
    );

    // Check session-manager.ts for raw literals (excluding the definition line)
    const smLines = sessionManagerSrc.split('\n');
    const smRawLiterals = smLines.filter(line =>
      line.includes("'prewarm-1'") && !line.includes('PREWARM_SESSION_ID') && !line.includes('const PREWARM_SESSION_ID')
    );
    assert.equal(
      smRawLiterals.length, 0,
      `session-manager.ts should not have raw 'prewarm-1' literals (except definition), found: ${smRawLiterals.join('\n')}`
    );
  });

  // L17: CONTAINER_AUTH_TOKEN missing = 503
  it('returns 503 when CONTAINER_AUTH_TOKEN is not set', () => {
    const serverSrc = fs.readFileSync(path.join(SRC_DIR, 'server.ts'), 'utf8');

    // The auth check must return 503 (not skip auth) when token is unset
    assert.ok(
      serverSrc.includes('503'),
      'server.ts must return 503 when CONTAINER_AUTH_TOKEN is not set'
    );

    // Verify the pattern: check for the 503 status code in auth context
    // Should have a code path that responds with 503 for missing token
    const lines = serverSrc.split('\n');
    const has503InAuth = lines.some(line =>
      line.includes('503') && (line.includes('writeHead') || line.includes('status'))
    );
    assert.ok(has503InAuth, 'Must have a 503 response in auth handling');
  });

  // L18: Timing-safe comparison for auth token
  it('uses timing-safe comparison for auth token', () => {
    const serverSrc = fs.readFileSync(path.join(SRC_DIR, 'server.ts'), 'utf8');

    assert.ok(
      serverSrc.includes('timingSafeEqual'),
      'server.ts must use crypto.timingSafeEqual for token comparison'
    );

    // Verify crypto is imported
    assert.ok(
      serverSrc.includes("from 'crypto'") || serverSrc.includes("require('crypto')") || serverSrc.includes("from 'node:crypto'"),
      'server.ts must import crypto module'
    );
  });

  // M2: Shutdown handler kills all active sessions
  it('shutdown handler kills all active sessions before exit', () => {
    const serverSrc = fs.readFileSync(path.join(SRC_DIR, 'server.ts'), 'utf8');

    // SIGTERM handler must iterate sessions and kill them
    // Look for session killing in shutdown context
    assert.ok(
      serverSrc.includes('SIGTERM'),
      'Must handle SIGTERM signal'
    );
    assert.ok(
      serverSrc.includes('SIGINT'),
      'Must handle SIGINT signal'
    );

    // The shutdown handler should call a method that kills sessions
    assert.ok(
      serverSrc.includes('killAll') || serverSrc.includes('kill()') ||
      (serverSrc.includes('sessions') && serverSrc.includes('kill')),
      'Shutdown handler must kill active sessions'
    );
  });
});

describe('Module extraction (M6)', () => {
  it('metrics module exists and exports expected functions', async () => {
    const metrics = await import('../dist/metrics.js');
    assert.ok(typeof metrics.getSyncStatus === 'function', 'getSyncStatus must be exported');
    assert.ok(typeof metrics.getDiskMetrics === 'function', 'getDiskMetrics must be exported');
    assert.ok(typeof metrics.getSystemMetrics === 'function', 'getSystemMetrics must be exported');
  });

  // session.ts and session-manager.ts import node-pty (native module, only available inside
  // the Docker container), so we verify their structure via source text inspection instead.
  it('session.ts exists and exports Session class', () => {
    const src = fs.readFileSync(path.join(SRC_DIR, 'session.ts'), 'utf8');
    assert.ok(src.includes('export class Session'), 'session.ts must export Session class');
    assert.ok(src.includes('start('), 'Session must have start method');
    assert.ok(src.includes('attach('), 'Session must have attach method');
    assert.ok(src.includes('detach('), 'Session must have detach method');
    assert.ok(src.includes('kill('), 'Session must have kill method');
    assert.ok(src.includes('toJSON('), 'Session must have toJSON method');
  });

  it('session-manager.ts exists and exports SessionManager class', () => {
    const src = fs.readFileSync(path.join(SRC_DIR, 'session-manager.ts'), 'utf8');
    assert.ok(src.includes('export class SessionManager'), 'session-manager.ts must export SessionManager class');
    assert.ok(src.includes('PREWARM_SESSION_ID'), 'must export PREWARM_SESSION_ID');
    assert.ok(src.includes('getOrCreate('), 'SessionManager must have getOrCreate method');
    assert.ok(src.includes('killAll('), 'SessionManager must have killAll method');
    assert.ok(src.includes("import { Session }"), 'session-manager.ts must import Session');
  });
});
