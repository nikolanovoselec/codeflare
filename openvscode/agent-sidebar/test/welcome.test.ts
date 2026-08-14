import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  buildWelcomePresentation,
  normalizeIdeAgentKind,
  renderWelcomeHtml,
} from '../src/welcome.ts';

test('REQ-IDE-024 AC1+AC2: every inventory gets an honest shared-runtime welcome action', () => {
  const pi = buildWelcomePresentation('pi');
  assert.deepEqual(pi.action, {
    label: 'Open Codeflare Chat',
    command: 'workbench.action.chat.open',
    arguments: [{ query: '@codeflare ', isPartialQuery: true }],
  });
  assert.equal(pi.agentEnabled, true);
  assert.equal(pi.runtimeLabel, 'PI / NATIVE CHAT');

  const claude = buildWelcomePresentation('claude');
  assert.deepEqual(claude.action, {
    label: 'Open Codeflare Chat',
    command: 'claude-vscode.sidebar.open',
    arguments: [],
  });
  assert.equal(claude.agentEnabled, true);
  assert.equal(claude.runtimeLabel, 'CLAUDE / OFFICIAL PANEL');

  const unsupported = buildWelcomePresentation('none');
  assert.deepEqual(unsupported.action, {
    label: 'Explore workspace',
    command: 'workbench.view.explorer',
    arguments: [],
  });
  assert.equal(unsupported.agentEnabled, false);
  assert.equal(unsupported.runtimeLabel, 'EDITOR / STANDARD');
});

test('REQ-IDE-024 AC2: only exact Pi and Claude selections enable an IDE agent', () => {
  assert.equal(normalizeIdeAgentKind('pi'), 'pi');
  assert.equal(normalizeIdeAgentKind('claude'), 'claude');
  for (const value of [undefined, '', 'codex', 'pi --mode rpc', 'CLAUDE']) {
    assert.equal(normalizeIdeAgentKind(value), 'none');
  }
});

test('REQ-IDE-024 AC1+AC3: welcome HTML explains the editor plane without external content', () => {
  const html = renderWelcomeHtml(
    buildWelcomePresentation('pi'),
    'vscode-webview://codeflare',
    'fixed-nonce',
  );

  assert.match(html, /traditional coding/i);
  assert.match(html, /observability plane/i);
  assert.match(html, /same isolated, ephemeral container/i);
  assert.match(html, /agents, tools, skills, and MCPs/i);
  assert.match(html, /Open Codeflare Chat/);
  assert.match(html, /default-src 'none'; style-src vscode-webview:\/\/codeflare; script-src 'nonce-fixed-nonce'/);
  assert.doesNotMatch(html, /https?:\/\//i);
});
