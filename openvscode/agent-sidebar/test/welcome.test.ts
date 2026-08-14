import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  buildWelcomePresentation,
  normalizeIdeAgentKind,
  renderWelcomeHtml,
} from '../src/welcome.ts';

test('REQ-IDE-024 AC4+AC7: every inventory gets an honest fixed welcome action', () => {
  const pi = buildWelcomePresentation('pi');
  assert.deepEqual(pi.action, {
    label: 'Open Codeflare Chat',
    command: 'workbench.action.chat.open',
    arguments: [{ query: '@codeflare ', isPartialQuery: true }],
  });
  assert.equal(pi.agentEnabled, true);
  assert.equal(pi.agentKind, 'pi');
  assert.equal(pi.runtimeLabel, 'PI / NATIVE');
  assert.equal(pi.continuityTitle, 'Pi, native to VS Code');

  const claude = buildWelcomePresentation('claude');
  assert.deepEqual(claude.action, {
    label: 'Open Claude Code',
    command: 'claude-vscode.sidebar.open',
    arguments: [],
  });
  assert.equal(claude.agentEnabled, true);
  assert.equal(claude.agentKind, 'claude');
  assert.equal(claude.runtimeLabel, 'CLAUDE / OFFICIAL');
  assert.equal(claude.continuityTitle, 'Official Claude Code panel');

  const unsupported = buildWelcomePresentation('none');
  assert.deepEqual(unsupported.action, {
    label: 'Explore Workspace',
    command: 'workbench.view.explorer',
    arguments: [],
  });
  assert.equal(unsupported.agentEnabled, false);
  assert.equal(unsupported.agentKind, 'none');
  assert.equal(unsupported.runtimeLabel, 'EDITOR / STANDARD');
  assert.equal(unsupported.continuityTitle, 'Full editor, no injected agent');
});

test('REQ-IDE-024 AC4: only exact Pi and Claude selections enable an IDE agent', () => {
  assert.equal(normalizeIdeAgentKind('pi'), 'pi');
  assert.equal(normalizeIdeAgentKind('claude'), 'claude');
  for (const value of [undefined, '', 'codex', 'pi --mode rpc', 'CLAUDE']) {
    assert.equal(normalizeIdeAgentKind(value), 'none');
  }
});

test('REQ-IDE-024 AC2+AC5+AC7: welcome HTML renders universal editor foundations and the selected native plane without external content', () => {
  for (const kind of ['pi', 'claude', 'none'] as const) {
    const presentation = buildWelcomePresentation(kind);
    const html = renderWelcomeHtml(
      presentation,
      'vscode-webview://codeflare',
      'fixed-nonce',
    );

    assert.match(html, new RegExp(`data-agent-kind="${kind}"`));
    assert.equal(html.match(/data-foundation=/g)?.length, 2);
    assert.match(html, new RegExp(`data-agent-experience="${kind}"`));
    assert.ok(html.includes(`<h2>${presentation.continuityTitle}</h2>`));
    assert.ok(html.includes(`<p class="active-body">${presentation.continuityBody}</p>`));
    assert.equal(html.match(/<button /g)?.length, 1);
    assert.match(html, /<h1>Full VS Code\.<br><span>Native agent workflows\.<\/span><\/h1>/);
    assert.match(html, /same isolated container/i);
    assert.match(html, /observability plane/i);
    assert.match(html, /same ephemeral filesystem/i);
    assert.match(html, /default-src 'none'; style-src 'nonce-fixed-nonce'; script-src 'nonce-fixed-nonce'/);
    assert.match(html, /<style nonce="fixed-nonce">/);
    assert.doesNotMatch(html, /https?:\/\//i);
  }
});
