// Structural audit for REQ-TERM-002 AC2..AC7 and REQ-TERM-001 AC6 server-side close.
//
// SCOPE: These ACs assert behavior of the container-side host process
// (host/src/server.ts and host/src/session.ts) — bash login shell defaults,
// xterm-256color PTY name/env, raw vs JSON wire framing, resize control
// handling, unknown-type forward-compat guard, protocol-level ws.ping, and
// the server's 1013 close when SessionManager returns null. Verifying these
// behaviorally requires spawning a real PTY + WebSocket pair inside the
// container, which the Worker test runner cannot do. The other ACs of
// REQ-TERM-001/002 are covered by REAL behavioral tests:
//
//   - REQ-TERM-001 AC2/3 + REQ-TERM-002 AC1:
//       src/__tests__/routes/terminal-route-validate.test.ts
//       (calls validateWebSocketRoute() with crafted Request objects)
//   - REQ-TERM-001 AC4/5/6 (SessionManager half):
//       host/__tests__/session-manager.test.js
//       (exercises getOrCreate, cap, prewarm exclusion with a FakeSession)
//
// Follow-up: see GitHub issue for converting the remaining audits below into
// real behavioral tests by extracting pure helpers from server.ts/session.ts.
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

const serverSrc = readFileSync(resolve(repoRoot, 'host/src/server.ts'), 'utf8');
const sessionSrc = readFileSync(resolve(repoRoot, 'host/src/session.ts'), 'utf8');

// ============================================================================
// REQ-TERM-001 AC6 (server-side close half)
// ============================================================================

describe('REQ-TERM-001 AC6: server closes WebSocket with 1013 when cap is hit', () => {
  it('server.ts closes WS with "Session limit reached" reason when getOrCreate returns null', () => {
    const closesOnCap = /Session limit reached/.test(serverSrc);
    assert.ok(closesOnCap, 'server.ts must close WS with "Session limit reached" when getOrCreate returns null');
  });
});

// ============================================================================
// REQ-TERM-002: WebSocket connection to container PTY (host-side ACs)
// ============================================================================

describe('REQ-TERM-002: WebSocket connection to container PTY (host)', () => {

  it('REQ-TERM-002 AC3: terminal server defaults TERMINAL_ARGS to "-l" (login shell)', () => {
    const hasLoginShell = /TERMINAL_ARGS\s*=\s*[^;]*['"]-l['"]/.test(serverSrc);
    assert.ok(hasLoginShell, 'server.ts must default TERMINAL_ARGS to "-l" (login shell)');
  });

  it('REQ-TERM-002 AC3: PTY env includes TERM=xterm-256color', () => {
    assert.ok(/TERM[\s\S]{1,40}xterm-256color/.test(sessionSrc),
      'session.ts must set TERM=xterm-256color in PTY environment');
  });

  it('REQ-TERM-002 AC3: PTY env includes COLORTERM=truecolor', () => {
    assert.ok(/COLORTERM[\s\S]{1,40}truecolor/.test(sessionSrc),
      'session.ts must set COLORTERM=truecolor in PTY environment');
  });

  it('REQ-TERM-002 AC3: pty.spawn passes name: "xterm-256color"', () => {
    assert.ok(/pty\.spawn[\s\S]{1,300}name:\s*['"]xterm-256color['"]/.test(sessionSrc),
      'session.ts must pass name: "xterm-256color" to pty.spawn()');
  });

  it('REQ-TERM-002 AC4: raw PTY data is sent to WebSocket clients without JSON wrapping', () => {
    assert.ok(/client\.send\s*\(\s*data\s*\)/.test(sessionSrc),
      'session.ts must send raw PTY data to clients without JSON wrapping');
  });

  it('REQ-TERM-002 AC5: process-name control message is sent as JSON with type field', () => {
    assert.ok(/JSON\.stringify\s*\(\s*\{[\s\S]{1,100}type[\s\S]{1,100}process-name/.test(sessionSrc),
      'session.ts must send process-name control messages as JSON with type field');
  });

  it('REQ-TERM-002 AC5: restore control message is sent as JSON with type field', () => {
    assert.ok(/JSON\.stringify\s*\(\s*\{[\s\S]{1,100}type[\s\S]{1,100}restore/.test(sessionSrc),
      'session.ts must send restore control messages as JSON with type field');
  });

  it('REQ-TERM-002 AC5: server handles resize control message from client', () => {
    assert.ok(/msg\.type\s*===\s*['"]resize['"]/.test(serverSrc),
      'server.ts must handle resize control messages from clients');
  });

  it('REQ-TERM-002 AC6: unknown JSON type strings are silently ignored (forward-compat guard)', () => {
    assert.ok(/typeof\s+msg\.type\s*===\s*['"]string['"][\s\S]{1,100}return/.test(serverSrc),
      'server.ts must silently ignore unknown JSON type strings (forward-compat guard)');
  });

  it('REQ-TERM-002 AC7: server uses protocol-level ws.ping() for keepalive', () => {
    assert.ok(/ws\.ping\s*\(\s*\)/.test(serverSrc),
      'server.ts must use protocol-level ws.ping() for keepalive');
    assert.ok(!/JSON\.stringify[\s\S]{1,80}type[\s\S]{1,80}['"]ping['"]/.test(serverSrc),
      'server.ts must NOT send application-level JSON ping messages');
  });
});
