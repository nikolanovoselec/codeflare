// Structural audit for REQ-TERM-005 server.ts boot wiring (AC2..AC6).
//
// SCOPE: The pieces of REQ-TERM-005 that live in host/src/server.ts startup
// code (prewarm session creation, ptyProcess.onData first-output detection,
// 20s safety setTimeout, 2-minute orphan timeout, terminalServiceReady WS
// gate). server.ts boot wiring requires spawning a real PTY + container env
// to exercise behaviorally; until that test rig exists this audit grep-checks
// the source. The other ACs of REQ-TERM-005 are covered by REAL behavioral
// tests:
//
//   - REQ-TERM-005 AC1 (TAB_CONFIG parsing + tab 1 command extraction):
//       host/__tests__/prewarm-readiness.test.js
//       host/__tests__/server-prewarm.test.js
//   - REQ-TERM-005 AC2 (PREWARM_SESSION_ID = "prewarm-1", adoption mechanism):
//       host/__tests__/session-manager.test.js
//   - REQ-TERM-005 AC5 (adopted session clears orphan timeout, prewarm rename):
//       host/__tests__/session-manager.test.js
//
// Follow-up: extract a boot-helper module from server.ts that takes injected
// SessionManager + clock so the listener/timeout wiring can be unit tested
// without spawning a real PTY.
//
// Run with:
//   node --test host/__audits__/server-prewarm-lifecycle.audit.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const serverSrc = readFileSync(resolve(repoRoot, 'host/src/server.ts'), 'utf8');

// ============================================================================
// REQ-TERM-005: Tab 1 auto-starts the configured agent (server.ts boot half)
// ============================================================================

describe('REQ-TERM-005: server.ts boot wiring', () => {

  it('REQ-TERM-005 AC2: server registers the pre-warm session into sessionManager.sessions', () => {
    assert.ok(/PREWARM_SESSION_ID/.test(serverSrc),
      'server.ts must reference PREWARM_SESSION_ID constant');
    assert.ok(/sessions\.set\s*\(\s*PREWARM_SESSION_ID\s*,\s*prewarmSession\s*\)/.test(serverSrc),
      'server.ts must register the pre-warm session into sessionManager.sessions');
    assert.ok(/prewarmSession\.start\s*\(\s*\)/.test(serverSrc),
      'server.ts must call prewarmSession.start() to spawn the PTY');
  });

  it('REQ-TERM-005 AC4: prewarm readiness detected by first PTY output (onData listener)', () => {
    assert.ok(/prewarmSession\.ptyProcess\.onData/.test(serverSrc),
      'server.ts must attach ptyProcess.onData listener to detect first pre-warm output');
  });

  it('REQ-TERM-005 AC4: 20-second hard timeout safety net for prewarm readiness', () => {
    assert.ok(/PREWARM_TIMEOUT_MS\s*=\s*20000/.test(serverSrc),
      'server.ts must define PREWARM_TIMEOUT_MS = 20000 (20s hard cap)');
    assert.ok(/setTimeout[\s\S]{1,300}prewarmReady\s*=\s*true[\s\S]{1,500}PREWARM_TIMEOUT_MS/.test(serverSrc),
      'server.ts must set prewarmReady = true inside a setTimeout fired at PREWARM_TIMEOUT_MS');
  });

  it('REQ-TERM-005 AC5: server sets 2-minute orphan timeout on unadopted prewarm', () => {
    assert.ok(/PREWARM_ORPHAN_MS\s*=\s*120000/.test(serverSrc),
      'server.ts must define PREWARM_ORPHAN_MS = 120000 (2 min orphan timeout)');
    assert.ok(/prewarmSession\.orphanTimeout\s*=\s*setTimeout/.test(serverSrc),
      'server.ts must set orphanTimeout on pre-warm session');
  });

  it('REQ-TERM-005 AC6: terminalServiceReady gate prevents WS connections before prewarm is registered', () => {
    assert.ok(/terminalServiceReady/.test(serverSrc),
      'server.ts must use terminalServiceReady flag to gate WS upgrades');
    assert.ok(/prewarmSession\.start[\s\S]{1,100}terminalServiceReady\s*=\s*true|terminalServiceReady\s*=\s*true[\s\S]{1,50}prewarmStartTime/.test(serverSrc),
      'server.ts must set terminalServiceReady = true after pre-warm PTY is started');
  });
});
