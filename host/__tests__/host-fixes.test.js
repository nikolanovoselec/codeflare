import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const HOST_DIR = path.resolve(import.meta.dirname, '..');

/**
 * Tests for FIX-26 (DF3): safeTokenCompare SHA-256 hash comparison
 * and FIX-20 (DC1): isAlive dead code removal.
 */

describe('FIX-26: safeTokenCompare uses SHA-256 hash comparison', () => {
  // Extract safeTokenCompare from server.js source for functional testing
  // Since server.js has side effects (http.createServer), we test the function
  // by extracting its logic and verifying the source pattern.

  // Helper that mirrors the expected implementation
  function safeTokenCompare(a, b) {
    const h = (s) => crypto.createHash('sha256').update(s).digest();
    return crypto.timingSafeEqual(h(a), h(b));
  }

  it('matching tokens return true', () => {
    assert.equal(safeTokenCompare('my-secret-token', 'my-secret-token'), true);
  });

  it('different tokens return false', () => {
    assert.equal(safeTokenCompare('token-a', 'token-b'), false);
  });

  it('different length tokens return false (no timing leak)', () => {
    // This is the key fix: previously, different-length tokens would
    // short-circuit with an early return, leaking length information.
    // SHA-256 hashing ensures fixed-length comparison regardless of input.
    assert.equal(safeTokenCompare('short', 'a-much-longer-token-value'), false);
    assert.equal(safeTokenCompare('x', 'xy'), false);
  });

  it('server.js uses SHA-256 hash in safeTokenCompare (no length pre-check)', () => {
    const serverSrc = fs.readFileSync(path.join(HOST_DIR, 'server.js'), 'utf8');

    // Must use createHash('sha256') for constant-time length normalization
    assert.ok(
      serverSrc.includes("createHash('sha256')") || serverSrc.includes('createHash("sha256")'),
      'safeTokenCompare must use SHA-256 hashing'
    );

    // Must NOT have a length pre-check that leaks timing info
    // Extract the safeTokenCompare function body
    const fnStart = serverSrc.indexOf('function safeTokenCompare');
    assert.ok(fnStart !== -1, 'safeTokenCompare function must exist');

    // Find the closing brace of the function
    let braceCount = 0;
    let fnEnd = fnStart;
    let foundOpen = false;
    for (let i = fnStart; i < serverSrc.length; i++) {
      if (serverSrc[i] === '{') { braceCount++; foundOpen = true; }
      if (serverSrc[i] === '}') { braceCount--; }
      if (foundOpen && braceCount === 0) { fnEnd = i + 1; break; }
    }
    const fnBody = serverSrc.slice(fnStart, fnEnd);

    // Should NOT contain length comparison
    assert.ok(
      !fnBody.includes('.length'),
      'safeTokenCompare must not compare lengths (leaks timing info)'
    );
  });
});

describe('FIX-20: isAlive dead code removal', () => {
  it('Session class does not have isAlive method', () => {
    const sessionSrc = fs.readFileSync(path.join(HOST_DIR, 'session.js'), 'utf8');

    // isAlive() was dead code — never called anywhere. It should be removed.
    assert.ok(
      !sessionSrc.includes('isAlive('),
      'session.js must not contain isAlive method (dead code)'
    );
  });

  it('Session class still has isPtyAlive method (not dead code)', () => {
    const sessionSrc = fs.readFileSync(path.join(HOST_DIR, 'session.js'), 'utf8');

    // isPtyAlive() IS used in server.js — must remain
    assert.ok(
      sessionSrc.includes('isPtyAlive('),
      'session.js must still have isPtyAlive method'
    );
  });
});
