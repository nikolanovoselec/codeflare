// Real behavioral tests for the browser-IDE host proxy helpers (REQ-IDE-001,
// REQ-IDE-003). These pure helpers were extracted into host/src/vscode-proxy.ts
// because server.ts boots a listening server on import and cannot be imported
// into a unit test -- the same reason stripVaultPrefix/auth-check were
// extracted. We import the compiled module and assert the exact behaviour the
// server.ts /api/vscode branch relies on.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isVscodePath, vscodeUpstreamPath, requestOpenvscodeStart } from '../dist/vscode-proxy.js';

describe('isVscodePath / REQ-IDE-001 (base-path-native IDE proxy surface)', () => {
  it('matches the bare /api/vscode surface and everything below it', () => {
    assert.equal(isVscodePath('/api/vscode'), true);
    assert.equal(isVscodePath('/api/vscode/abcd1234/'), true);
    assert.equal(isVscodePath('/api/vscode/abcd1234/stable/out/main.js'), true);
  });

  it('does NOT match other proxy surfaces or a false-prefix lookalike', () => {
    assert.equal(isVscodePath('/vault/x'), false);
    assert.equal(isVscodePath('/terminal'), false);
    assert.equal(isVscodePath('/api/vscodex/y'), false); // must not match /api/vscode as a bare prefix
    assert.equal(isVscodePath('/health'), false);
  });

  it('is false for a null/undefined pathname (unparsable url)', () => {
    assert.equal(isVscodePath(null), false);
    assert.equal(isVscodePath(undefined), false);
  });
});

describe('vscodeUpstreamPath / REQ-IDE-001 (forward UNCHANGED, no strip)', () => {
  it('returns the path verbatim -- OpenVSCode is base-path native', () => {
    assert.equal(vscodeUpstreamPath('/api/vscode/abcd1234/stable/out/main.js'), '/api/vscode/abcd1234/stable/out/main.js');
    assert.equal(vscodeUpstreamPath('/api/vscode/abcd1234/'), '/api/vscode/abcd1234/');
    assert.equal(vscodeUpstreamPath('/api/vscode'), '/api/vscode');
  });

  it('does NOT strip the prefix (the load-bearing contrast with the vault)', () => {
    // A vault-style strip would return '/abcd1234/x'; the IDE MUST keep the
    // full path so OpenVSCode's --server-base-path=/api/vscode/<sid> matches.
    assert.notEqual(vscodeUpstreamPath('/api/vscode/abcd1234/x'), '/abcd1234/x');
    assert.equal(vscodeUpstreamPath('/api/vscode/abcd1234/x'), '/api/vscode/abcd1234/x');
  });

  it('falls back to /api/vscode/ for a missing pathname', () => {
    assert.equal(vscodeUpstreamPath(null), '/api/vscode/');
    assert.equal(vscodeUpstreamPath(undefined), '/api/vscode/');
  });
});

describe('requestOpenvscodeStart / REQ-IDE-003 AC2 (lazy-start trigger, idempotent)', () => {
  let triggerPath;

  beforeEach(() => {
    triggerPath = path.join(os.tmpdir(), `openvscode-trigger-test-${process.pid}`);
    try { fs.rmSync(triggerPath, { force: true }); } catch { /* ignore */ }
  });

  afterEach(() => {
    try { fs.rmSync(triggerPath, { force: true }); } catch { /* ignore */ }
  });

  it('writes the trigger file on first call and returns true', () => {
    assert.equal(fs.existsSync(triggerPath), false);
    const created = requestOpenvscodeStart(triggerPath);
    assert.equal(created, true);
    assert.equal(fs.existsSync(triggerPath), true);
  });

  it('is idempotent -- a second call does not rewrite and returns false', () => {
    requestOpenvscodeStart(triggerPath);
    const second = requestOpenvscodeStart(triggerPath);
    assert.equal(second, false);
    assert.equal(fs.existsSync(triggerPath), true);
  });
});
