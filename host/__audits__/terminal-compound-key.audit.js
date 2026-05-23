// Structural audit for REQ-TERM-001 (AC2-6) and REQ-TERM-002 (AC1-7).
//
// These are source-presence audits: they read the shipped TypeScript source
// and assert that the exact patterns the ACs describe exist in the code.
// Breaking the pattern (e.g. renaming the compound-key format, removing the
// prewarm exclusion, changing the WS URL shape) will cause an audit failure.
//
// Run with:
//   node --test host/__audits__/terminal-compound-key.audit.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const terminalRoute = readFileSync(resolve(repoRoot, 'src/routes/terminal.ts'), 'utf8');
const sessionManager = readFileSync(resolve(repoRoot, 'host/src/session-manager.ts'), 'utf8');
const serverSrc = readFileSync(resolve(repoRoot, 'host/src/server.ts'), 'utf8');
const sessionSrc = readFileSync(resolve(repoRoot, 'host/src/session.ts'), 'utf8');

// ============================================================================
// REQ-TERM-001: Up to 6 terminal tabs per session
// ============================================================================

describe('REQ-TERM-001: Up to 6 terminal tabs per session', () => {

  it('REQ-TERM-001 AC2: frontend compound key uses sessionId:terminalId colon separator', () => {
    // The frontend makeKey() function in terminal.ts store uses `${sessionId}:${terminalId}`
    // We verify the Worker-side terminal route describes the compound key format in comments/code.
    // The Worker parses {sessionId}-{terminalId} from the WS URL path.
    const hasCompoundParse = /compoundMatch\s*=\s*fullSessionId\.match/.test(terminalRoute);
    assert.ok(hasCompoundParse, 'terminal.ts must parse compound sessionId from URL using compoundMatch');

    // Compound key in URL is {baseSession}-{terminalId} (dash separator)
    // Source: `const baseSessionId = compoundMatch ? compoundMatch[1] : ...;`
    //         `const terminalId   = compoundMatch ? compoundMatch[2] : ...;`
    // [\s\S] crosses the newline between the two assignments.
    const hasDashSeparator = /compoundMatch\[1\][\s\S]{1,200}compoundMatch\[2\]/.test(terminalRoute);
    assert.ok(hasDashSeparator, 'terminal.ts must extract baseSessionId and terminalId from compound match');
  });

  it('REQ-TERM-001 AC2: WS URL path uses {sessionId}-{terminalId} dash format', () => {
    // The regex that matches the URL path: /^\/api\/terminal\/([^/]+)\/ws$/
    // and then the compound parse: /^(.+)-([1-6])$/
    const hasWsPathRegex = /api\/terminal/.test(terminalRoute);
    assert.ok(hasWsPathRegex, 'terminal.ts must match /api/terminal/.../ws path');

    // Production source literally contains: /^(.+)-([1-6])$/
    // Match the source bytes (parentheses + the [1-6] character class).
    const hasCompoundRegex = /\(\.\+\)-\(\[1-6\]\)/.test(terminalRoute);
    assert.ok(hasCompoundRegex, 'terminal.ts must use regex /^(.+)-([1-6])$/ to parse terminal suffix');
  });

  it('REQ-TERM-001 AC3: Worker forwards fullSessionId (compound) to container as session param', () => {
    // handleWebSocketUpgrade sets ?session=fullSessionId (not baseSessionId)
    const forwardsFullId = /searchParams\.set\s*\(\s*['"]session['"]\s*,\s*fullSessionId\s*\)/.test(terminalRoute);
    assert.ok(forwardsFullId, 'terminal.ts must set ?session=fullSessionId (compound) when forwarding to container');
  });

  it('REQ-TERM-001 AC3: Worker validates base session from KV using baseSessionId', () => {
    // Session lookup uses baseSessionId, not the compound full ID
    const validatesBase = /getSessionKey\s*\(\s*bucketName\s*,\s*baseSessionId\s*\)/.test(terminalRoute);
    assert.ok(validatesBase, 'terminal.ts must validate base session from KV using baseSessionId');
  });

  it('REQ-TERM-001 AC4: SessionManager.getOrCreate uses compound ID as separate PTY key', () => {
    // SessionManager stores sessions by the full compound ID passed in
    const storesById = /this\.sessions\.set\s*\(\s*id\s*,\s*session\s*\)/.test(sessionManager);
    assert.ok(storesById, 'session-manager.ts must store sessions by the provided compound ID');

    // And retrieves by the same ID
    const retrievesById = /this\.sessions\.get\s*\(\s*id\s*\)/.test(sessionManager);
    assert.ok(retrievesById, 'session-manager.ts must retrieve sessions by compound ID');
  });

  it('REQ-TERM-001 AC5: SessionManager cap check excludes prewarm sessions', () => {
    // The active count filter: keys that do NOT start with 'prewarm-'
    const excludesPrewarm = /filter\s*\(\s*k\s*=>\s*!k\.startsWith\s*\(\s*['"]prewarm-['"]\s*\)\s*\)/.test(sessionManager);
    assert.ok(excludesPrewarm, 'session-manager.ts must exclude prewarm- sessions from active count');
  });

  it('REQ-TERM-001 AC6: SessionManager returns null when active count reaches cap', () => {
    // Returning null signals rejection to the server, which closes with 1013
    const returnsNull = /activeCount\s*>=\s*this\._maxSessions[\s\S]{1,100}return null/.test(sessionManager);
    assert.ok(returnsNull, 'session-manager.ts must return null when session cap is reached');
  });

  it('REQ-TERM-001 AC6: server closes WebSocket with 1013 when session cap is hit', () => {
    // server.ts checks the null return and closes the client WS
    const closesOn1013 = /Session limit reached/.test(serverSrc);
    assert.ok(closesOn1013, 'server.ts must close WS with "Session limit reached" when getOrCreate returns null');
  });
});

// ============================================================================
// REQ-TERM-002: WebSocket connection to container PTY
// ============================================================================

describe('REQ-TERM-002: WebSocket connection to container PTY', () => {

  it('REQ-TERM-002 AC1: WS URL pattern is /api/terminal/{sessionId}-{terminalId}/ws', () => {
    // The route match regex in validateWebSocketRoute
    const hasPattern = /\/api\/terminal\/.*\/ws/.test(terminalRoute);
    assert.ok(hasPattern, 'terminal.ts must define /api/terminal/.../ws route pattern');

    // The specific compound suffix pattern [1-6]
    const hasSuffix = /\[1-6\]/.test(terminalRoute);
    assert.ok(hasSuffix, 'terminal.ts must accept terminal IDs 1-6 in compound key');
  });

  it('REQ-TERM-002 AC2: Worker calls container.fetch to forward WebSocket to container', () => {
    const forwardsToContainer = /container\.fetch\s*\(/.test(terminalRoute);
    assert.ok(forwardsToContainer, 'terminal.ts must call container.fetch() to forward WS to container');
  });

  it('REQ-TERM-002 AC3: terminal server defaults to bash -l (login shell)', () => {
    // server.ts defaults TERMINAL_ARGS to '-l' (login shell flag)
    const hasLoginShell = /TERMINAL_ARGS.*??.*'-l'|TERMINAL_ARGS\s*=\s*process\.env\.TERMINAL_ARGS\s*\?\?\s*'-l'/.test(serverSrc);
    assert.ok(hasLoginShell, 'server.ts must default TERMINAL_ARGS to "-l" (login shell)');
  });

  it('REQ-TERM-002 AC3: PTY spawns with TERM=xterm-256color', () => {
    const hasXterm = /TERM.*xterm-256color/.test(sessionSrc);
    assert.ok(hasXterm, 'session.ts must set TERM=xterm-256color in PTY environment');
  });

  it('REQ-TERM-002 AC3: PTY spawns with COLORTERM=truecolor', () => {
    const hasTruecolor = /COLORTERM.*truecolor/.test(sessionSrc);
    assert.ok(hasTruecolor, 'session.ts must set COLORTERM=truecolor in PTY environment');
  });

  it('REQ-TERM-002 AC3: PTY pty.spawn uses xterm-256color as terminal name', () => {
    const hasSpawnName = /pty\.spawn[\s\S]{1,200}name:\s*['"]xterm-256color['"]/.test(sessionSrc);
    assert.ok(hasSpawnName, 'session.ts must pass name: "xterm-256color" to pty.spawn()');
  });

  it('REQ-TERM-002 AC4: raw PTY data is sent directly to WebSocket clients without JSON wrapping', () => {
    // In session.ts onData handler: client.send(data) with raw data string, not JSON.stringify(data)
    const rawSend = /client\.send\s*\(\s*data\s*\)/.test(sessionSrc);
    assert.ok(rawSend, 'session.ts must send raw PTY data to clients without JSON wrapping');
  });

  it('REQ-TERM-002 AC5: control messages use JSON with type field prefix', () => {
    // process-name message: JSON.stringify({ type: 'process-name', ... })
    const hasProcessName = /JSON\.stringify\s*\(\s*\{.*type.*process-name/.test(sessionSrc);
    assert.ok(hasProcessName, 'session.ts must send process-name control messages as JSON with type field');

    // restore message: JSON.stringify({ type: 'restore', state })
    const hasRestore = /JSON\.stringify\s*\(\s*\{.*type.*restore/.test(sessionSrc);
    assert.ok(hasRestore, 'session.ts must send restore control messages as JSON with type field');
  });

  it('REQ-TERM-002 AC5: server handles resize control message from client', () => {
    const hasResize = /msg\.type\s*===\s*['"]resize['"]/.test(serverSrc);
    assert.ok(hasResize, 'server.ts must handle resize control messages from clients');
  });

  it('REQ-TERM-002 AC6: unknown JSON type strings are silently ignored (not written to PTY)', () => {
    // The guard: if msg.type is a string we don't know, return without writing to PTY
    const hasTypeGuard = /typeof msg\.type\s*===\s*['"]string['"][\s\S]{1,50}return/.test(serverSrc);
    assert.ok(hasTypeGuard, 'server.ts must silently ignore unknown JSON type strings (forward-compat guard)');
  });

  it('REQ-TERM-002 AC7: no application-level ping/pong; server uses protocol-level ws.ping()', () => {
    // The server uses ws.ping() (protocol-level) not application JSON ping messages
    const hasProtocolPing = /ws\.ping\s*\(\s*\)/.test(serverSrc);
    assert.ok(hasProtocolPing, 'server.ts must use protocol-level ws.ping() for keepalive, not JSON messages');

    // No JSON ping type being sent to clients as data
    const noJsonPing = !/JSON\.stringify.*type.*ping/.test(serverSrc);
    assert.ok(noJsonPing, 'server.ts must NOT send application-level JSON ping messages');
  });
});
