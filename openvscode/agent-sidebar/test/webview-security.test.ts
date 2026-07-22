import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  WebviewMessageAuthority,
  WebviewMessageError,
} from '../src/message-schema.ts';
import { createWebviewDocument } from '../src/webview-security.ts';

test('webview document uses nonce-only local CSP with no network or navigation authority', () => {
  const document = createWebviewDocument({
    backend: 'claude',
    cspSource: 'vscode-webview://unit-test',
    nonce: 'fixed-test-nonce',
    scriptUri: 'vscode-webview://unit-test/terminal.js',
    styleUri: 'vscode-webview://unit-test/terminal.css',
  });

  assert.equal(
    document.csp,
    "default-src 'none'; img-src vscode-webview://unit-test; font-src vscode-webview://unit-test; style-src vscode-webview://unit-test; script-src 'nonce-fixed-test-nonce'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  );
  assert.deepEqual(document.localResourceRoots, ['webview']);
  assert.equal(document.enableCommandUris, false);
  assert.equal(document.enableNavigation, false);
  assert.equal(document.html.includes('http://'), false);
  assert.equal(document.html.includes('https://'), false);
  assert.equal(document.html.includes('unsafe-eval'), false);
  assert.equal(document.html.includes('unsafe-inline'), false);
});

test('webview authority accepts only bounded backend-specific user commands', () => {
  const authority = new WebviewMessageAuthority({ maxPromptBytes: 32, maxTerminalInputBytes: 16 });

  assert.deepEqual(authority.parse('pi', { type: 'prompt', message: 'hello' }), {
    type: 'prompt',
    message: 'hello',
  });
  assert.deepEqual(authority.parse('pi', { type: 'abort' }), { type: 'abort' });
  assert.deepEqual(authority.parse('pi', { type: 'pi.cycleModel' }), { type: 'pi.cycleModel' });
  assert.deepEqual(authority.parse('pi', { type: 'pi.cycleThinking' }), { type: 'pi.cycleThinking' });
  assert.deepEqual(authority.parse('claude', { type: 'terminal.input', data: 'λ\r' }), {
    type: 'terminal.input',
    data: 'λ\r',
  });
  assert.deepEqual(
    authority.parse('claude', { type: 'terminal.resize', columns: 132, rows: 40 }),
    { type: 'terminal.resize', columns: 132, rows: 40 },
  );
});

test('REQ-IDE-007 AC2: webview messages cannot forge approval or choose process authority', () => {
  const authority = new WebviewMessageAuthority({ maxPromptBytes: 32, maxTerminalInputBytes: 16 });
  const forbidden = [
    { type: 'extension_ui_response', id: 'approval-1', confirmed: true },
    { type: 'approve', id: 'approval-1' },
    { type: 'terminal.input', data: 'ok', executable: '/bin/bash' },
    { type: 'prompt', message: 'ok', cwd: '/tmp' },
    { type: 'prompt', message: 'ok', env: { TOKEN: 'secret' } },
    { type: 'prompt', message: 'ok', settingsPath: '/tmp/settings.json' },
    { type: 'rpc', payload: { type: 'bash', command: 'id' } },
  ];

  for (const message of forbidden) {
    assert.throws(
      () => authority.parse('pi', message),
      (error: unknown) => error instanceof WebviewMessageError && error.code === 'FORBIDDEN_MESSAGE',
    );
  }
});

test('webview message bounds and resize dimensions fail closed', () => {
  const authority = new WebviewMessageAuthority({ maxPromptBytes: 4, maxTerminalInputBytes: 4 });

  assert.throws(
    () => authority.parse('pi', { type: 'prompt', message: '12345' }),
    (error: unknown) => error instanceof WebviewMessageError && error.code === 'MESSAGE_TOO_LARGE',
  );
  assert.throws(
    () => authority.parse('claude', { type: 'terminal.resize', columns: 0, rows: 24 }),
    (error: unknown) => error instanceof WebviewMessageError && error.code === 'INVALID_RESIZE',
  );
});
