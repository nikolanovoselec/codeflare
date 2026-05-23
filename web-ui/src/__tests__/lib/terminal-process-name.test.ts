import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * REQ-TERM-009: Process name detection via control messages.
 *
 * ACs covered here: 1, 2, 4, 6, 7.
 * ACs 3 and 5 (PROCESS_ICON_MAP, AGENT_ICON_MAP exhaustiveness) are covered in
 * web-ui/src/__tests__/lib/terminal-config.test.ts.
 *
 * Strategy: structural source audits.
 * The terminal store's WebSocket message handler and the session store's
 * callback wiring cannot be exercised in jsdom without a live WS server.
 * We audit the TypeScript source to assert that the exact patterns each AC
 * requires exist in the shipped code. Deleting or renaming any of these
 * patterns will fail the corresponding test.
 */

const webUiRoot = resolve(__dirname, '../../..');
const terminalStoreSrc = readFileSync(resolve(webUiRoot, 'src/stores/terminal.ts'), 'utf8');
const sessionStoreSrc = readFileSync(resolve(webUiRoot, 'src/stores/session.ts'), 'utf8');
const sessionTabsSrc = readFileSync(resolve(webUiRoot, 'src/stores/session-tabs.ts'), 'utf8');
const terminalConfigSrc = readFileSync(resolve(webUiRoot, 'src/lib/terminal-config.ts'), 'utf8');

describe('REQ-TERM-009: Process name detection via control messages', () => {

  describe('AC1: server sends {"type":"process-name","processName":"..."} JSON control messages', () => {
    it('REQ-TERM-009 AC1: host session.ts sends process-name JSON with type and processName fields', () => {
      // This verifies the server-side shape. We read the host source from the repo root.
      const hostSessionSrc = readFileSync(
        resolve(webUiRoot, '../host/src/session.ts'),
        'utf8',
      );
      const hasProcessNameMsg = /JSON\.stringify\s*\(\s*\{\s*type:\s*['"]process-name['"].*processName/.test(hostSessionSrc);
      expect(hasProcessNameMsg).toBe(true);
    });

    it('REQ-TERM-009 AC1: process-name message is sent on processName change, not on every poll tick', () => {
      const hostSessionSrc = readFileSync(
        resolve(webUiRoot, '../host/src/session.ts'),
        'utf8',
      );
      // The poll only sends when processName !== lastProcessName
      const sendsOnChange = /processName\s*!==\s*this\.lastProcessName/.test(hostSessionSrc);
      expect(sendsOnChange).toBe(true);
    });
  });

  describe('AC2: frontend parses control messages by {"type": prefix', () => {
    it('REQ-TERM-009 AC2: terminal store identifies control messages by startsWith("{\"type\":", )', () => {
      // The exact prefix check used to distinguish server control from raw PTY output
      const hasPrefixCheck = /messageData\.startsWith\s*\(\s*['"]{"type":['"]/.test(terminalStoreSrc);
      expect(hasPrefixCheck).toBe(true);
    });

    it('REQ-TERM-009 AC2: terminal store parses process-name type and dispatches processName field', () => {
      const hasProcessNameCheck = /msg\.type\s*===\s*['"]process-name['"].*msg\.processName|msg\.processName[\s\S]{1,60}msg\.type\s*===\s*['"]process-name['"]/.test(terminalStoreSrc);
      expect(hasProcessNameCheck).toBe(true);
    });

    it('REQ-TERM-009 AC2: terminal store dispatches to onProcessName callback with sessionId and terminalId', () => {
      // onProcessName?.(sessionId, terminalId, msg.processName)
      const callsCallback = /onProcessName\s*\?\.\s*\(\s*sessionId\s*,\s*terminalId\s*,\s*msg\.processName\s*\)/.test(terminalStoreSrc);
      expect(callsCallback).toBe(true);
    });
  });

  describe('AC4: PROCESS_DISPLAY_NAME is empty (binary names match display names)', () => {
    it('REQ-TERM-009 AC4: PROCESS_DISPLAY_NAME is defined as an empty object literal', () => {
      // The comment in terminal-config.ts states "currently empty -- all agent binary names match display names"
      const hasEmptyMap = /PROCESS_DISPLAY_NAME.*Record.*=\s*\{\s*\}|PROCESS_DISPLAY_NAME:\s*Record[\s\S]{1,50}=\s*\{\s*\}/.test(terminalConfigSrc);
      expect(hasEmptyMap).toBe(true);
    });

    it('REQ-TERM-009 AC4: getTabDisplayName falls back to the process name itself when no override', () => {
      // PROCESS_DISPLAY_NAME[processName] || processName
      const hasFallback = /PROCESS_DISPLAY_NAME\[processName\]\s*\|\|\s*processName/.test(terminalConfigSrc);
      expect(hasFallback).toBe(true);
    });
  });

  describe('AC6: onProcessName callback wired via registerProcessNameCallback (no circular import)', () => {
    it('REQ-TERM-009 AC6: terminal store exports registerProcessNameCallback function', () => {
      const exportsRegister = /export function registerProcessNameCallback/.test(terminalStoreSrc);
      expect(exportsRegister).toBe(true);
    });

    it('REQ-TERM-009 AC6: onProcessName module-level variable starts as null (not imported from session)', () => {
      // The variable declaration: let onProcessName: ... | null = null;
      const isNullInit = /let onProcessName.*null\s*=\s*null|onProcessName.*\|\s*null\s*=\s*null/.test(terminalStoreSrc);
      expect(isNullInit).toBe(true);
    });

    it('REQ-TERM-009 AC6: session store calls registerProcessNameCallback to wire the callback', () => {
      // session.ts imports registerProcessNameCallback from terminal store and calls it
      const importsRegister = /registerProcessNameCallback/.test(sessionStoreSrc);
      expect(importsRegister).toBe(true);

      const callsRegister = /registerProcessNameCallback\s*\(/.test(sessionStoreSrc);
      expect(callsRegister).toBe(true);
    });

    it('REQ-TERM-009 AC6: session store wires registerProcessNameCallback to call updateTerminalLabel', () => {
      // registerProcessNameCallback((sessionId, terminalId, processName) => { updateTerminalLabel(...) })
      const wiresUpdateLabel = /registerProcessNameCallback[\s\S]{1,100}updateTerminalLabel/.test(sessionStoreSrc);
      expect(wiresUpdateLabel).toBe(true);
    });
  });

  describe('AC7: process name updates reflected in tab store (updateTerminalLabel)', () => {
    it('REQ-TERM-009 AC7: updateTerminalLabel function is exported from session-tabs store', () => {
      const exported = /export function updateTerminalLabel/.test(sessionTabsSrc);
      expect(exported).toBe(true);
    });

    it('REQ-TERM-009 AC7: updateTerminalLabel stores processName on the tab object', () => {
      // tab.processName = processName
      const setsProcessName = /tab\.processName\s*=\s*processName/.test(sessionTabsSrc);
      expect(setsProcessName).toBe(true);
    });

    it('REQ-TERM-009 AC7: updateTerminalLabel accepts sessionId, terminalId, and processName parameters', () => {
      // function signature: (sessionId: string, terminalId: string, processName: string)
      const hasSignature = /updateTerminalLabel\s*\(\s*sessionId.*terminalId.*processName/.test(sessionTabsSrc);
      expect(hasSignature).toBe(true);
    });
  });
});
