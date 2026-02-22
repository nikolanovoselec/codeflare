import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Pure classification function extracted from the WS message handler in server.js.
 *
 * The logic mirrors the control-message parsing gate:
 *   1. If short enough and starts with '{', attempt JSON parse.
 *   2. Recognized control types (resize) are NOT user input.
 *   3. Data-type messages ARE user input (typed keystrokes sent as JSON).
 *   4. Parse failures or non-JSON → raw terminal bytes → user input.
 *
 * Note: Application-level ping/pong was removed — Cloudflare's runtime handles
 * protocol-level WebSocket keepalive automatically for DO/Container connections.
 */
const MAX_CONTROL_MSG_LENGTH = 200;

function classifyWsMessage(rawMessage) {
  const str = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString();

  if (str.length < MAX_CONTROL_MSG_LENGTH && str.startsWith('{')) {
    try {
      const msg = JSON.parse(str);

      if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        return { isUserInput: false, type: 'resize' };
      }

      if (msg.type === 'data' && typeof msg.data === 'string') {
        return { isUserInput: true, type: 'data' };
      }

      // Unknown JSON type — falls through to raw input
      return { isUserInput: true, type: 'unknown-json' };
    } catch {
      // Not valid JSON — treat as raw terminal input
      return { isUserInput: true, type: 'raw' };
    }
  }

  // Non-JSON or too long — raw terminal input
  return { isUserInput: true, type: 'raw' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WS input classification', () => {
  it('raw bytes (non-JSON) are classified as user input', () => {
    const result = classifyWsMessage('ls -la\r');
    assert.equal(result.isUserInput, true);
    assert.equal(result.type, 'raw');
  });

  it('{"type":"data","data":"..."} is classified as user input', () => {
    const result = classifyWsMessage(JSON.stringify({ type: 'data', data: 'hello' }));
    assert.equal(result.isUserInput, true);
    assert.equal(result.type, 'data');
  });

  it('{"type":"ping"} falls through to unknown-json (no longer a control message)', () => {
    const result = classifyWsMessage(JSON.stringify({ type: 'ping' }));
    assert.equal(result.isUserInput, true);
    assert.equal(result.type, 'unknown-json');
  });

  it('{"type":"resize",...} is NOT classified as user input', () => {
    const result = classifyWsMessage(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    assert.equal(result.isUserInput, false);
    assert.equal(result.type, 'resize');
  });

  it('malformed JSON falls through to raw handler (user input)', () => {
    const result = classifyWsMessage('{bad json');
    assert.equal(result.isUserInput, true);
    assert.equal(result.type, 'raw');
  });
});
