import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Structural audit for REQ-TERM-009 wire-protocol slice (AC1, AC2, AC6 partial).
 *
 * SCOPE: These ACs assert the JSON wire shape between host PTY (host/src/session.ts)
 * and the web-ui terminal store (web-ui/src/stores/terminal.ts), plus the
 * absence of a circular import via registerProcessNameCallback. Triggering the
 * WebSocket onmessage handler behaviorally requires a live WS pair; the
 * cross-module wiring is established at module-load time. Until that test rig
 * exists, this audit grep-checks the patterns the ACs require. The other ACs
 * are covered by REAL behavioral tests:
 *
 *   - REQ-TERM-009 AC3, AC5 (PROCESS_ICON_MAP / AGENT_ICON_MAP exhaustiveness):
 *       web-ui/src/__tests__/lib/terminal-config.test.ts
 *   - REQ-TERM-009 AC4 (getTabDisplayName fallback when PROCESS_DISPLAY_NAME empty):
 *       web-ui/src/__tests__/lib/terminal-config.test.ts
 *   - REQ-TERM-009 AC7 (updateTerminalLabel writes processName to the targeted tab):
 *       web-ui/src/__tests__/stores/update-terminal-label.test.ts
 *
 * Follow-up: extract parseControlMessage(data) from terminal store WS handler
 * and buildProcessNameMessage(processName) from host session.ts as pure helpers
 * so AC1/AC2 can be unit-tested without a live WebSocket.
 */

const webUiRoot = resolve(__dirname, '../../..');
const terminalStoreSrc = readFileSync(resolve(webUiRoot, 'src/stores/terminal.ts'), 'utf8');
const sessionStoreSrc = readFileSync(resolve(webUiRoot, 'src/stores/session.ts'), 'utf8');

describe('REQ-TERM-009: process-name wire protocol', () => {
  describe('REQ-TERM-009 AC1: host emits {"type":"process-name","processName":...} on change', () => {
    it('host session.ts sends process-name JSON with type + processName fields', () => {
      const hostSessionSrc = readFileSync(
        resolve(webUiRoot, '../host/src/session.ts'),
        'utf8',
      );
      const hasProcessNameMsg = /JSON\.stringify\s*\(\s*\{\s*type:\s*['"]process-name['"][\s\S]{0,200}processName/.test(hostSessionSrc);
      expect(hasProcessNameMsg).toBe(true);
    });

    it('host session.ts only sends process-name when value changed (not every poll tick)', () => {
      const hostSessionSrc = readFileSync(
        resolve(webUiRoot, '../host/src/session.ts'),
        'utf8',
      );
      const sendsOnChange = /processName\s*!==\s*this\.lastProcessName/.test(hostSessionSrc);
      expect(sendsOnChange).toBe(true);
    });
  });

  describe('REQ-TERM-009 AC2: web-ui distinguishes control messages by {"type": prefix', () => {
    it('terminal store identifies control messages via startsWith("{\\"type\\":") guard', () => {
      const hasPrefixCheck = /messageData\.startsWith\s*\(\s*['"]{"type":['"]/.test(terminalStoreSrc);
      expect(hasPrefixCheck).toBe(true);
    });

    it('terminal store dispatches process-name to onProcessName callback with sessionId, terminalId, processName', () => {
      const dispatchesProcessName = /onProcessName\s*\?\.\s*\(\s*sessionId\s*,\s*terminalId\s*,\s*msg\.processName\s*\)/.test(terminalStoreSrc);
      expect(dispatchesProcessName).toBe(true);
    });
  });

  describe('REQ-TERM-009 AC6: callback wired via registerProcessNameCallback (no circular import)', () => {
    it('terminal store exports registerProcessNameCallback', () => {
      expect(/export function registerProcessNameCallback/.test(terminalStoreSrc)).toBe(true);
    });

    it('terminal store initialises onProcessName to null (not imported from session)', () => {
      const isNullInit = /let\s+onProcessName[\s\S]{1,150}\|\s*null\s*=\s*null/.test(terminalStoreSrc);
      expect(isNullInit).toBe(true);
    });

    it('session store wires registerProcessNameCallback to updateTerminalLabel', () => {
      expect(/registerProcessNameCallback\s*\(\s*\([^)]*\)\s*=>\s*\{[\s\S]{1,200}updateTerminalLabel/.test(sessionStoreSrc)).toBe(true);
    });
  });
});
