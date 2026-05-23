// Structural audit for REQ-TERM-005 (AC1-6): Tab 1 auto-starts the configured agent.
//
// These audits grep the TypeScript source of server.ts, session-manager.ts,
// and prewarm-config.ts for the exact patterns each AC requires. A line
// deletion or rename that breaks an AC will cause an audit failure here
// before it reaches production.
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
const sessionManagerSrc = readFileSync(resolve(repoRoot, 'host/src/session-manager.ts'), 'utf8');
const prewarmConfigSrc = readFileSync(resolve(repoRoot, 'host/src/prewarm-config.ts'), 'utf8');

// ============================================================================
// REQ-TERM-005: Tab 1 auto-starts the configured agent
// ============================================================================

describe('REQ-TERM-005: Tab 1 auto-starts the configured agent', () => {

  it('REQ-TERM-005 AC1: TAB_CONFIG env var is parsed by the terminal server at startup', () => {
    // server.ts must parse process.env.TAB_CONFIG as JSON
    const parseTabConfig = /JSON\.parse\s*\(\s*process\.env\.TAB_CONFIG/.test(serverSrc);
    assert.ok(parseTabConfig, 'server.ts must parse process.env.TAB_CONFIG as JSON');
  });

  it('REQ-TERM-005 AC1: prewarm-config reads tab 1 command from parsed TAB_CONFIG', () => {
    // prewarm-config.ts finds the tab with id === '1' and extracts its command
    const findsTab1 = /t\.id\s*===\s*['"]1['"]|id\s*===\s*'1'/.test(prewarmConfigSrc);
    assert.ok(findsTab1, 'prewarm-config.ts must look for tab with id "1"');

    const extractsCommand = /tab1\.command/.test(prewarmConfigSrc);
    assert.ok(extractsCommand, 'prewarm-config.ts must extract command from tab 1 entry');
  });

  it('REQ-TERM-005 AC2: server creates pre-warm session with PREWARM_SESSION_ID before first client connects', () => {
    // Server instantiates a Session with PREWARM_SESSION_ID and calls start()
    const hasPrewarmId = /PREWARM_SESSION_ID/.test(serverSrc);
    assert.ok(hasPrewarmId, 'server.ts must reference PREWARM_SESSION_ID constant');

    const setsPrewarmSession = /sessions\.set\s*\(\s*PREWARM_SESSION_ID\s*,\s*prewarmSession\s*\)/.test(serverSrc);
    assert.ok(setsPrewarmSession, 'server.ts must register the pre-warm session into sessionManager.sessions');

    const callsStart = /prewarmSession\.start\s*\(\s*\)/.test(serverSrc);
    assert.ok(callsStart, 'server.ts must call prewarmSession.start() to spawn the PTY');
  });

  it('REQ-TERM-005 AC2: PREWARM_SESSION_ID is "prewarm-1" in session-manager', () => {
    // The constant value must be exactly 'prewarm-1' so the exclusion filter works
    const hasConstantValue = /PREWARM_SESSION_ID\s*=\s*['"]prewarm-1['"]/.test(sessionManagerSrc);
    assert.ok(hasConstantValue, 'session-manager.ts must define PREWARM_SESSION_ID = "prewarm-1"');
  });

  it('REQ-TERM-005 AC3: server uses login shell (-l flag) so .bashrc runs for agent auto-start', () => {
    // TERMINAL_ARGS defaults to '-l' so .bashrc is sourced automatically
    const hasLoginFlag = /TERMINAL_ARGS.*??.*'-l'|TERMINAL_ARGS\s*=\s*process\.env\.TERMINAL_ARGS\s*\?\?\s*'-l'/.test(serverSrc);
    assert.ok(hasLoginFlag, 'server.ts must default TERMINAL_ARGS to "-l" so .bashrc is sourced');
  });

  it('REQ-TERM-005 AC4: prewarm readiness detected by first PTY output (onData listener)', () => {
    // server.ts registers ptyProcess.onData to detect first output
    const hasOnData = /prewarmSession\.ptyProcess\.onData/.test(serverSrc);
    assert.ok(hasOnData, 'server.ts must attach ptyProcess.onData listener to detect first pre-warm output');
  });

  it('REQ-TERM-005 AC4: 20-second hard timeout safety net for prewarm readiness', () => {
    // PREWARM_TIMEOUT_MS = 20000 and a setTimeout that sets prewarmReady = true
    const hasTimeout = /PREWARM_TIMEOUT_MS\s*=\s*20000/.test(serverSrc);
    assert.ok(hasTimeout, 'server.ts must define PREWARM_TIMEOUT_MS = 20000 (20s hard cap)');

    // setTimeout body sets prewarmReady=true, logs (~100-200 chars of context),
    // then closes with `}, PREWARM_TIMEOUT_MS)`. Widen the trailing window so the
    // audit reflects the real shape of the timeout body, not a 50-char snippet.
    const hasTimeoutFallback = /setTimeout[\s\S]{1,300}prewarmReady\s*=\s*true[\s\S]{1,500}PREWARM_TIMEOUT_MS/.test(serverSrc);
    assert.ok(hasTimeoutFallback, 'server.ts must set prewarmReady = true inside a setTimeout fired at PREWARM_TIMEOUT_MS');
  });

  it('REQ-TERM-005 AC5: pre-warmed session is adopted (renamed) when first client connects for tab 1', () => {
    // session-manager.ts getOrCreate() looks for prewarm session when terminalId === '1'
    const adoptionCheck = /terminalId\s*===\s*['"]1['"][\s\S]{1,200}PREWARM_SESSION_ID/.test(sessionManagerSrc);
    assert.ok(adoptionCheck, 'session-manager.ts must check for pre-warmed session when terminalId is "1"');

    // The adoption: delete prewarm key, update session.id, re-insert under new key
    const deletesPrewarm = /this\.sessions\.delete\s*\(\s*PREWARM_SESSION_ID\s*\)/.test(sessionManagerSrc);
    assert.ok(deletesPrewarm, 'session-manager.ts must delete PREWARM_SESSION_ID entry during adoption');

    const updatesId = /prewarmed\.id\s*=\s*id/.test(sessionManagerSrc);
    assert.ok(updatesId, 'session-manager.ts must update the pre-warmed session id to the actual terminal id');
  });

  it('REQ-TERM-005 AC5: orphan timeout kills unadopted pre-warm session after 2 minutes', () => {
    // PREWARM_ORPHAN_MS = 120000 and orphanTimeout is set on the session
    const hasOrphanMs = /PREWARM_ORPHAN_MS\s*=\s*120000/.test(serverSrc);
    assert.ok(hasOrphanMs, 'server.ts must define PREWARM_ORPHAN_MS = 120000 (2 min orphan timeout)');

    const setsOrphanTimeout = /prewarmSession\.orphanTimeout\s*=\s*setTimeout/.test(serverSrc);
    assert.ok(setsOrphanTimeout, 'server.ts must set orphanTimeout on pre-warm session');
  });

  it('REQ-TERM-005 AC5: adopted session clears orphan timeout', () => {
    // When adopted, clearTimeout(prewarmed.orphanTimeout) is called
    const clearsOrphan = /clearTimeout\s*\(\s*prewarmed\.orphanTimeout\s*\)/.test(sessionManagerSrc);
    assert.ok(clearsOrphan, 'session-manager.ts must clearTimeout(prewarmed.orphanTimeout) when adopting pre-warm');
  });

  it('REQ-TERM-005 AC6: terminalServiceReady gate prevents WS connections before pre-warm is registered', () => {
    // WS upgrade rejected with 1013 until terminalServiceReady is true
    const hasReadyFlag = /terminalServiceReady/.test(serverSrc);
    assert.ok(hasReadyFlag, 'server.ts must use terminalServiceReady flag to gate WS upgrades');

    // The flag is set to true after prewarm session is registered
    const setAfterPrewarm = /prewarmSession\.start[\s\S]{1,100}terminalServiceReady\s*=\s*true|terminalServiceReady\s*=\s*true[\s\S]{1,50}prewarmStartTime/.test(serverSrc);
    assert.ok(setAfterPrewarm, 'server.ts must set terminalServiceReady = true after pre-warm PTY is started');
  });
});
